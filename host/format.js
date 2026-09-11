// Turns a tool result into MCP content blocks.
//
// Every tool answers with a text block, and a few (read_page, find, the
// console and network reads, batches and scripts) get a shape of their own so
// the caller reads what it needs without a JSON dump. Screenshots become an
// image block plus the line naming the image id and size that a later
// upload_image or message needs.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { encodeGif } from './gif.js';
import { stepContractLine } from './errors.js';
import { SHOT_DIR, rememberImage, saveImage } from './images.js';

export function textBlock(text) {
  return { type: 'text', text };
}

export function imageBlock(image) {
  return { type: 'image', data: image.data, mimeType: image.mediaType };
}

function formatTreeResult(result) {
  const header = [
    result.url ? 'url: ' + result.url : null,
    result.title ? 'title: ' + result.title : null,
    result.nodes !== undefined ? 'nodes: ' + result.nodes : null,
  ]
    .filter(Boolean)
    .join('  |  ');

  let body = result.text || '(no matching elements)';
  if (result.truncated) {
    body +=
      '\n\n[truncated: showing ' +
      (result.shownNodes ?? '?') +
      ' of ' +
      result.nodes +
      ' nodes, ' +
      result.totalChars +
      ' chars total. Narrow with ref_id to read one subtree, or lower depth.]';
  }
  return [textBlock(header + '\n\n' + body)];
}

/**
 * The line under a clipped read saying how much was left out.
 *
 * read_page has always said "158 more nodes not shown, 310 in total". These two
 * said "3 URL(s) clipped to 300 characters" with no row count at all, so a
 * reader could not tell whether entries had been dropped as well as clipped.
 *
 * @param {string} unit  what the rows are, for the count
 * @param {string} part  what was clipped inside a row
 */
function clipNote(result, unit, part) {
  const parts = [];
  const returned = result.returned ?? 0;
  const total = result.total ?? returned;
  parts.push(returned < total ? 'showing ' + returned + ' of ' + total + ' ' + unit : returned + ' ' + unit);
  if (result.clipped) {
    parts.push(
      result.clipped +
        ' ' +
        part +
        (result.clipped === 1 ? '' : 's') +
        ' clipped to ' +
        result.clippedTo +
        ' characters' +
        (result.longestClipped ? ', the longest was ' + result.longestClipped : '')
    );
  }
  return '\n\n[' + parts.join(', ') + ']';
}

function formatConsole(result) {
  if (!result.entries.length) {
    return [textBlock('No console messages' + (result.capturing ? '.' : ' (capture is not active for this tab).'))];
  }
  const lines = result.entries.map((e) => {
    const where = e.url ? ' (' + e.url.split('/').pop() + (e.line ? ':' + e.line : '') + ')' : '';
    return '[' + (e.level || 'log') + '] ' + e.text + where;
  });
  return [textBlock(lines.join('\n') + clipNote(result, 'entries', 'message'))];
}

function formatNetwork(result) {
  if (!result.requests.length) return [textBlock('No network requests captured.')];
  const lines = result.requests.map((r) => {
    const status = r.failed ? 'FAILED ' + (r.errorText || '') : r.status || 'pending';
    const size = r.encodedDataLength ? ' ' + Math.round(r.encodedDataLength / 1024) + 'kb' : '';
    return [status, r.method || '', r.url].filter(Boolean).join(' ') + size;
  });
  return [textBlock(lines.join('\n') + clipNote(result, 'requests', 'URL'))];
}

function formatFind(result) {
  if (!result.matches.length) {
    return [
      textBlock(
        'No elements matched ' +
          JSON.stringify(result.query) +
          ' among ' +
          result.searched +
          ' searched. ' +
          'Try read_page with filter "interactive", or a shorter query.'
      ),
    ];
  }
  const lines = result.matches.map((m) => {
    const parts = [m.role];
    if (m.name) parts.push(JSON.stringify(m.name));
    parts.push('[' + m.ref + ']');
    if (m.offscreen) parts.push('(offscreen)');
    if (m.attrs) parts.push(m.attrs);
    if (m.count > 1) parts.push('(and ' + (m.count - 1) + ' more like it)');
    if (m.source === 'model') parts.push('(model' + (m.reason ? ': ' + m.reason : '') + ')');
    return parts.join(' ');
  });
  const header =
    result.matches.length +
    ' match(es)' +
    (result.escalatedBecause ? ', from a model call (' + result.escalatedBecause + ')' : '') +
    ':';
  return [textBlock(header + '\n' + lines.join('\n'))];
}

/**
 * Steps that return content the caller actually needs (a tree, page text, a
 * screenshot) have it inlined. Everything else collapses to one status line, so
 * a long script does not spend tokens confirming that clicks clicked.
 */
export const INLINE_IN_SEQUENCE = new Set([
  'read_page',
  'get_page_text',
  'find',
  'page_state',
  'javascript',
  'tabs_context',
  'tabs_create',
  'wait_for_page',
  'read_console_messages',
  'read_network_requests',
  'gif_creator',
]);

function formatSequence(result, { quick = false } = {}) {
  const blocks = [];
  const summary = [];

  for (const step of result.results) {
    const label =
      quick && step.lineNo ? 'line ' + step.lineNo + ' ' + step.command : '[' + step.index + '] ' + step.name;
    if (!step.ok) {
      summary.push(label + ' FAILED: ' + step.error.message);
      if (step.error.code) {
        summary.push(
          '  [ok=false code=' +
            step.error.code +
            ' effects=' +
            step.error.effects +
            ' retryable=' +
            step.error.retryable +
            ']'
        );
      }
      continue;
    }
    summary.push(label + ' ok');
    // The step's own contract, so evidence produced inside a script is visible
    // rather than folded into one line for the whole run.
    const contract = stepContractLine(step);
    if (contract) summary.push(contract);
    const inner = formatResult(step.name, step.result, step.input || {});
    // A step that produced an image also produced the line naming its id, size
    // and saved path, which is what a later upload_image or a message needs.
    const carriesImage = inner.some((block) => block.type === 'image');
    for (const block of inner) {
      if (block.type === 'image') blocks.push(block);
      else if (INLINE_IN_SEQUENCE.has(step.name) || carriesImage) summary.push(block.text);
    }
  }

  if (!result.completed) {
    const stopped = result.results[result.results.length - 1];
    summary.push(
      '\nStopped at ' +
        (quick && stopped?.lineNo ? 'line ' + stopped.lineNo : 'action ' + result.stoppedAt) +
        '. Later actions did not run.'
    );
  }
  return [textBlock(summary.join('\n')), ...blocks];
}

function formatGif(result, filename) {
  if (!result || !result.frames) {
    return [textBlock(JSON.stringify(result, null, 2))];
  }
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const wanted = filename ? String(filename).replace(/[\\/:*?"<>|]/g, '_') : '';
    const name = wanted
      ? /\.gif$/i.test(wanted)
        ? wanted
        : wanted + '.gif'
      : 'recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.gif';
    const file = joinPath(SHOT_DIR, name);
    writeFileSync(file, encodeGif(result));
    // recordedMs is the span the recording covered. It is deliberately not
    // called durationMs, which every result carries as the calling tool's own
    // latency and which used to overwrite this number.
    const span = Number.isFinite(result.recordedMs) ? ' over ' + (result.recordedMs / 1000).toFixed(1) + 's' : '';
    return [
      textBlock(
        'Recorded ' +
          result.frames.length +
          ' frames' +
          span +
          ' at ' +
          result.width +
          'x' +
          result.height +
          '.\nsaved: ' +
          file
      ),
    ];
  } catch (err) {
    return [textBlock('Could not write the gif: ' + err.message)];
  }
}

export function formatResult(toolName, result, args = {}) {
  if (result === null || result === undefined) return [textBlock('ok')];

  switch (toolName) {
    case 'read_page':
      return formatTreeResult(result);
    case 'get_page_text':
      return [
        textBlock(
          'url: ' +
            result.url +
            '\n\n' +
            (result.text || '(no text)') +
            (result.truncated ? '\n\n[truncated: ' + result.totalChars + ' chars total]' : '')
        ),
      ];
    case 'find':
      return formatFind(result);
    case 'read_console_messages':
      return formatConsole(result);
    case 'read_network_requests':
      return formatNetwork(result);
    case 'gif_creator':
      return formatGif(result, args.filename);
    case 'browser_batch':
      return formatSequence(result);
    case 'quick':
      return formatSequence(result, { quick: true });
    case 'shortcuts_execute':
      return [
        textBlock('Ran shortcut ' + (result.shortcut ? result.shortcut.name : '')),
        ...formatSequence(result, { quick: true }),
      ];
    default:
      break;
  }

  const blocks = [];
  if (result.image) {
    blocks.push(imageBlock(result.image));
    const imageId = rememberImage(result.image);
    let saved = '';
    if (result.saveToDisk) {
      // The extension cannot touch the filesystem, so the server writes the file.
      try {
        saved = '\nsaved: ' + saveImage(result.image);
      } catch (err) {
        saved = '\ncould not save the image: ' + err.message;
      }
    }
    blocks.push(
      textBlock(
        'screenshot ' +
          result.image.width +
          'x' +
          result.image.height +
          ' (~' +
          result.image.estimatedTokens +
          ' tokens) id: ' +
          imageId +
          (result.image.note ? '\n' + result.image.note : '') +
          (result.pageState ? '\nurl: ' + result.pageState.url + '\nscroll: ' + result.pageState.scrollY : '') +
          saved
      )
    );
    return blocks;
  }

  return [textBlock(JSON.stringify(result, null, 2))];
}
