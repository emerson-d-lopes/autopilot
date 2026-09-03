#!/usr/bin/env node
// MCP server. Claude Code spawns this; it connects to the native host over a
// local pipe and forwards tool calls to the browser.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { statSync, accessSync, constants, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { socketPathFor, connect } from './ipc.js';
import { listBrowsers, pickDefault } from './registry.js';
import { TOOLS, TOOL_NAMES } from './schemas.js';
import { encodeGif } from './gif.js';
import { normalizeCall } from '../extension/src/lib/aliases.js';

const CLIENT_ID = process.env.CHROME_MCP_CLIENT_ID || randomUUID();

let link = null;
let browserConnected = false;
let connecting = null;
let requestSeq = 0;
const pending = new Map();

/** The browser this session drives. Chosen on first use, changeable at any time. */
let selectedBrowser = process.env.CHROME_MCP_BROWSER_ID || null;
let activeBrowser = null;

/**
 * Finds the browser to talk to.
 *
 * With one connected browser there is nothing to choose. With several, the
 * session has to say which, because silently picking one would mean acting in a
 * window the caller was not thinking about.
 */
async function resolveBrowser() {
  // An explicit socket override means a single fixed bridge, used by tests.
  if (process.env.CHROME_MCP_SOCKET) {
    return { id: 'override', name: 'Browser', socket: process.env.CHROME_MCP_SOCKET };
  }

  const browsers = await listBrowsers();
  if (!browsers.length) return null;

  const chosen = pickDefault(browsers, selectedBrowser);
  if (chosen) return chosen;

  const names = browsers.map((b) => '  ' + b.id + '  ' + b.name + ' ' + b.version).join('\n');
  throw new Error(
    browsers.length + ' browsers are connected, so this session needs to pick one:\n' + names +
      '\n\nCall select_browser with one of those ids.'
  );
}

// ---------------------------------------------------------------------------
// Link to the native host
// ---------------------------------------------------------------------------

async function ensureLink() {
  if (link) return link;
  if (connecting) return connecting;

  const target = await resolveBrowser();
  if (!target) throw new Error('no browser');
  activeBrowser = target;

  connecting = connect(target.socket)
    .then((socket) => {
      link = socket;
      connecting = null;

      socket.on('message', (message) => {
        if (link !== socket) return;
        if (message.type === 'browser_status') {
          browserConnected = Boolean(message.connected);
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(message.error);
        else entry.resolve(message.result !== undefined ? message.result : message);
      });

      socket.on('close', () => {
        // A replaced socket must not clear the state of the one that replaced
        // it, which is what happened when switching browsers dropped the old
        // link and the late close event then wiped the new connection.
        if (link !== socket) return;
        link = null;
        browserConnected = false;
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject({ message: 'Connection to the browser bridge closed.', kind: 'disconnected' });
          pending.delete(id);
        }
      });

      socket.on('error', () => {
        /* surfaced through close */
      });

      return socket;
    })
    .catch((err) => {
      connecting = null;
      throw err;
    });

  return connecting;
}

const NOT_RUNNING =
  'The chrome-mcp bridge is not running.\n\n' +
  'Checklist:\n' +
  '  1. Chrome is running.\n' +
  '  2. The extension is installed and enabled at chrome://extensions.\n' +
  '  3. The native messaging host is registered (npm run install-host).\n' +
  '  4. Chrome was restarted after registering the host.\n\n' +
  'Run `npm run doctor` in the chrome-mcp directory to check all four.';

async function callBridge(type, payload, timeout = 120000) {
  try {
    await ensureLink();
  } catch (err) {
    // A selection problem is actionable and must not be reported as a missing
    // bridge, which would send the caller to the wrong fix.
    if (err && /needs to pick one/.test(err.message || '')) throw err;
    throw new Error(NOT_RUNNING);
  }
  // The status message arrives just after the socket opens, so a call made
  // immediately after connecting (a fresh session, or a reconnect after
  // switching browsers) has to wait for it rather than assume it is late.
  if (!browserConnected) {
    const deadline = Date.now() + 3000;
    while (!browserConnected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!browserConnected) {
      throw new Error(
        'The extension is not attached to the bridge. Check it is enabled at chrome://extensions, then reload it.'
      );
    }
  }

  const id = 'mcp_' + ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser did not respond within ' + timeout / 1000 + 's.'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    link.send({ ...payload, type, id, clientId: CLIENT_ID });
  });
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function textBlock(text) {
  return { type: 'text', text };
}

function imageBlock(image) {
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
      '\n\n[truncated: showing ' + (result.shownNodes ?? '?') + ' of ' + result.nodes + ' nodes, ' +
      result.totalChars + ' chars total. Narrow with ref_id to read one subtree, or lower depth.]';
  }
  return [textBlock(header + '\n\n' + body)];
}

function formatConsole(result) {
  if (!result.entries.length) {
    return [textBlock('No console messages' + (result.capturing ? '.' : ' (capture is not active for this tab).'))];
  }
  const lines = result.entries.map((e) => {
    const where = e.url ? ' (' + e.url.split('/').pop() + (e.line ? ':' + e.line : '') + ')' : '';
    return '[' + (e.level || 'log') + '] ' + e.text + where;
  });
  const note =
    result.returned < result.total ? '\n\n[showing ' + result.returned + ' of ' + result.total + ' entries]' : '';
  return [textBlock(lines.join('\n') + note)];
}

function formatNetwork(result) {
  if (!result.requests.length) return [textBlock('No network requests captured.')];
  const lines = result.requests.map((r) => {
    const status = r.failed ? 'FAILED ' + (r.errorText || '') : r.status || 'pending';
    const size = r.encodedDataLength ? ' ' + Math.round(r.encodedDataLength / 1024) + 'kb' : '';
    return [status, r.method || '', r.url].filter(Boolean).join(' ') + size;
  });
  const note =
    result.returned < result.total ? '\n\n[showing ' + result.returned + ' of ' + result.total + ' requests]' : '';
  return [textBlock(lines.join('\n') + note)];
}

function formatFind(result) {
  if (!result.matches.length) {
    return [
      textBlock(
        'No elements matched ' + JSON.stringify(result.query) + ' among ' + result.searched + ' searched. ' +
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
    return parts.join(' ');
  });
  return [textBlock(result.matches.length + ' match(es):\n' + lines.join('\n'))];
}

/**
 * Steps that return content the caller actually needs (a tree, page text, a
 * screenshot) have it inlined. Everything else collapses to one status line, so
 * a long script does not spend tokens confirming that clicks clicked.
 */
const INLINE_IN_SEQUENCE = new Set([
  'read_page', 'get_page_text', 'find', 'page_state', 'javascript', 'tabs_context', 'tabs_create', 'wait_for_page',
  'read_console_messages', 'read_network_requests', 'gif_creator',
]);

function formatSequence(result, { quick = false } = {}) {
  const blocks = [];
  const summary = [];

  for (const step of result.results) {
    const label = quick && step.lineNo ? 'line ' + step.lineNo + ' ' + step.command : '[' + step.index + '] ' + step.name;
    if (!step.ok) {
      summary.push(label + ' FAILED: ' + step.error.message);
      continue;
    }
    summary.push(label + ' ok');
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
      '\nStopped at ' + (quick && stopped?.lineNo ? 'line ' + stopped.lineNo : 'action ' + result.stoppedAt) +
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
    const name = wanted ? (/\.gif$/i.test(wanted) ? wanted : wanted + '.gif') : 'recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.gif';
    const file = joinPath(SHOT_DIR, name);
    writeFileSync(file, encodeGif(result));
    const seconds = (result.durationMs / 1000).toFixed(1);
    return [
      textBlock(
        'Recorded ' + result.frames.length + ' frames over ' + seconds + 's at ' +
          result.width + 'x' + result.height + '.\nsaved: ' + file
      ),
    ];
  } catch (err) {
    return [textBlock('Could not write the gif: ' + err.message)];
  }
}

const SHOT_DIR = process.env.CHROME_MCP_SCREENSHOT_DIR || joinPath(tmpdir(), 'chrome-mcp-screenshots');

/** Drops the current connection so the next call reconnects to the chosen browser. */
function dropLink() {
  if (link) {
    try {
      link.end();
    } catch {
      /* already closed */
    }
  }
  link = null;
  connecting = null;
  browserConnected = false;
  activeBrowser = null;
}

/** Tools answered by the server itself, because they are about which browser to use. */
async function handleBrowserTool(name, args) {
  const browsers = await listBrowsers();

  if (name === 'list_connected_browsers') {
    if (!browsers.length) {
      return [
        textBlock(
          'No browsers are connected. Start one with the extension loaded, then run npm run doctor if it does not appear.'
        ),
      ];
    }
    const lines = browsers.map((b) => {
      const mark = activeBrowser && activeBrowser.id === b.id ? ' (in use)' : selectedBrowser === b.id ? ' (selected)' : '';
      return b.id + '  ' + b.name + ' ' + b.version + mark;
    });
    return [textBlock(browsers.length + ' connected:\n' + lines.join('\n'))];
  }

  // select_browser and switch_browser are the same operation.
  const wanted = String(args.browserId || args.id || '').trim();
  if (!wanted) {
    return [textBlock('Pass browserId. Call list_connected_browsers to see the ids.')];
  }
  const match = browsers.find((b) => b.id === wanted || b.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    return [
      textBlock(
        'No connected browser matches ' + JSON.stringify(wanted) + '. Connected: ' +
          (browsers.map((b) => b.id + ' (' + b.name + ')').join(', ') || 'none')
      ),
    ];
  }

  selectedBrowser = match.id;
  dropLink();
  return [textBlock('Now using ' + match.name + ' ' + match.version + ' (' + match.id + ').')];
}

let lastImagePath = null;

// Screenshots taken in this session, by id, so upload_image can attach one the
// way Claude in Chrome does with imageId. Bounded so a long session does not
// hold every capture in memory.
const capturedImages = new Map();
let imageSeq = 0;

function rememberImage(image) {
  const id = 'img_' + ++imageSeq;
  capturedImages.set(id, image);
  while (capturedImages.size > 20) capturedImages.delete(capturedImages.keys().next().value);
  return id;
}

/** Writes a remembered screenshot to disk under the name the page should see. */
function materializeImage(id, filename) {
  const image = capturedImages.get(id);
  if (!image) return null;
  mkdirSync(SHOT_DIR, { recursive: true });
  const ext = image.mediaType === 'image/jpeg' ? '.jpg' : '.png';
  const base = (filename || id + ext).replace(/[\\/:*?"<>|]/g, '_');
  const file = joinPath(SHOT_DIR, /\.(png|jpe?g)$/i.test(base) ? base : base + ext);
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  return file;
}

/** Path of the most recent screenshot this server wrote, for upload_image "last". */
function lastSavedImage() {
  return lastImagePath;
}

/** Writes a captured image to disk and returns its path. */
function saveImage(image) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = joinPath(SHOT_DIR, 'shot-' + stamp + (image.mediaType === 'image/jpeg' ? '.jpg' : '.png'));
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  lastImagePath = file;
  return file;
}

/** Resolves and checks upload paths before they reach the browser. */
function prepareUploadPaths(paths) {
  const MAX_TOTAL = 25 * 1024 * 1024;
  let total = 0;
  const resolved = [];

  for (const raw of paths) {
    const full = resolvePath(String(raw));
    let stat;
    try {
      stat = statSync(full);
    } catch {
      throw new Error('No such file: ' + full);
    }
    if (!stat.isFile()) throw new Error('Not a file: ' + full);
    try {
      accessSync(full, constants.R_OK);
    } catch {
      throw new Error('File is not readable: ' + full);
    }
    total += stat.size;
    if (total > MAX_TOTAL) {
      throw new Error('Upload exceeds the ' + MAX_TOTAL / (1024 * 1024) + 'MB limit.');
    }
    resolved.push(full);
  }
  return resolved;
}

function formatResult(toolName, result, args = {}) {
  if (result === null || result === undefined) return [textBlock('ok')];

  switch (toolName) {
    case 'read_page':
      return formatTreeResult(result);
    case 'get_page_text':
      return [
        textBlock(
          'url: ' + result.url + '\n\n' + (result.text || '(no text)') +
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
        'screenshot ' + result.image.width + 'x' + result.image.height +
          ' (~' + result.image.estimatedTokens + ' tokens) id: ' + imageId +
          (result.pageState ? '\nurl: ' + result.pageState.url + '\nscroll: ' + result.pageState.scrollY : '') +
          saved
      )
    );
    return blocks;
  }

  return [textBlock(JSON.stringify(result, null, 2))];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'chrome-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const normalized = normalizeCall(request.params.name, request.params.arguments || {});
  let name = normalized.name;
  let args = normalized.input;
  if (name === 'browser_batch' && Array.isArray(args.actions)) {
    args = { ...args, actions: args.actions.map((a) => (a && a.name ? normalizeCall(a.name, a.input) : a)) };
  }

  if (!TOOL_NAMES.includes(name)) {
    return { content: [textBlock('Unknown tool: ' + name)], isError: true };
  }

  try {
    if (name === 'list_connected_browsers' || name === 'select_browser' || name === 'switch_browser') {
      return { content: await handleBrowserTool(name, args) };
    }
    if (name === 'file_upload' && Array.isArray(args.paths)) {
      args = { ...args, paths: prepareUploadPaths(args.paths) };
    }
    if (name === 'upload_image') {
      // An image upload is a file upload with a friendlier way to name the file.
      let path = args.path;
      if (args.imageId) {
        path = materializeImage(String(args.imageId), args.filename);
        if (!path) {
          return {
            content: [textBlock('No screenshot with id ' + args.imageId + ' in this session. Ids are printed under each screenshot. Known: ' + ([...capturedImages.keys()].join(', ') || 'none') + '.')],
            isError: true,
          };
        }
      } else if (path === 'last' || !path) {
        const lastId = [...capturedImages.keys()].pop();
        path = lastSavedImage() || (lastId ? materializeImage(lastId, args.filename) : null);
      }
      if (!path) {
        return {
          content: [textBlock('No screenshot has been taken yet. Take one, then pass its imageId, or give a path.')],
          isError: true,
        };
      }
      args = { ...args, paths: prepareUploadPaths([path]) };
      delete args.path;
      delete args.imageId;
      delete args.filename;
      name = 'file_upload';
    }
    const result = await callBridge('tool_request', { tool: name, args });
    return { content: formatResult(name, result, args) };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { content: [textBlock(message)], isError: true };
  }
});

process.on('SIGINT', async () => {
  try {
    if (link) link.send({ type: 'release_session', clientId: CLIENT_ID, closeEmptyOnly: true, id: 'bye' });
  } catch {
    /* shutting down */
  }
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
