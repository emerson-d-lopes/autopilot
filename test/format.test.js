// The formatter that turns a tool result into MCP content blocks. Until this
// was its own module the only tests of these shapes went through the live
// suite, which cannot reach the clipped and truncated branches on demand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shotDir = mkdtempSync(join(tmpdir(), 'autopilot-format-'));
process.env.AUTOPILOT_SCREENSHOT_DIR = shotDir;
const { formatResult, textBlock, imageBlock, INLINE_IN_SEQUENCE } = await import('../host/format.js');
const { capturedImageIds } = await import('../host/images.js');

test.after(() => rmSync(shotDir, { recursive: true, force: true }));

const text = (blocks) =>
  blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

test('a null result is a bare ok', () => {
  assert.deepEqual(formatResult('navigate', null), [textBlock('ok')]);
  assert.deepEqual(formatResult('navigate', undefined), [textBlock('ok')]);
});

test('an unknown shape is pretty-printed JSON', () => {
  const out = formatResult('page_state', { url: 'https://a.test', viewport: { width: 1, height: 2 } });
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0].text), { url: 'https://a.test', viewport: { width: 1, height: 2 } });
});

test('read_page carries the header and says when the tree was truncated', () => {
  const out = text(
    formatResult('read_page', { url: 'https://a.test', title: 'A', nodes: 3, text: 'button "Go" [ref_1]' })
  );
  assert.match(out, /^url: https:\/\/a\.test {2}\| {2}title: A {2}\| {2}nodes: 3\n\nbutton "Go" \[ref_1\]$/);

  const clipped = text(
    formatResult('read_page', { nodes: 500, shownNodes: 120, totalChars: 40000, truncated: true, text: 'x' })
  );
  assert.match(clipped, /\[truncated: showing 120 of 500 nodes, 40000 chars total\. Narrow with ref_id/);

  assert.match(text(formatResult('read_page', { nodes: 0 })), /\(no matching elements\)/);
});

test('get_page_text reports truncation', () => {
  const out = text(formatResult('get_page_text', { url: 'u', text: 'body', truncated: true, totalChars: 99 }));
  assert.equal(out, 'url: u\n\nbody\n\n[truncated: 99 chars total]');
  assert.equal(text(formatResult('get_page_text', { url: 'u' })), 'url: u\n\n(no text)');
});

test('find lists matches with their attributes and says where model matches came from', () => {
  const out = text(
    formatResult('find', {
      query: 'submit',
      searched: 40,
      escalatedBecause: 'no local match',
      matches: [
        { role: 'button', name: 'Submit', ref: 'ref_2', offscreen: true, attrs: 'disabled=true', count: 3 },
        { role: 'link', ref: 'ref_9', source: 'model', reason: 'label matched' },
      ],
    })
  );
  assert.equal(
    out,
    '2 match(es), from a model call (no local match):\n' +
      'button "Submit" [ref_2] (offscreen) disabled=true (and 2 more like it)\n' +
      'link [ref_9] (model: label matched)'
  );
});

test('find with no match says how many were searched and what to try', () => {
  const out = text(formatResult('find', { query: 'x', searched: 12, matches: [] }));
  assert.match(out, /No elements matched "x" among 12 searched\. Try read_page with filter "interactive"/);
});

test('console entries carry level, source location, and the clip note', () => {
  const out = text(
    formatResult('read_console_messages', {
      entries: [{ level: 'error', text: 'boom', url: 'https://a.test/js/app.js', line: 7 }, { text: 'plain' }],
      returned: 2,
      total: 9,
      clipped: 1,
      clippedTo: 300,
      longestClipped: 1200,
    })
  );
  assert.equal(
    out,
    '[error] boom (app.js:7)\n[log] plain\n\n[showing 2 of 9 entries, 1 message clipped to 300 characters, the longest was 1200]'
  );
});

test('an empty console read says whether capture was on', () => {
  assert.equal(text(formatResult('read_console_messages', { entries: [], capturing: true })), 'No console messages.');
  assert.match(text(formatResult('read_console_messages', { entries: [] })), /capture is not active/);
});

test('network rows show status, method, url and size, with a plural clip note', () => {
  const out = text(
    formatResult('read_network_requests', {
      requests: [
        { status: 200, method: 'GET', url: 'https://a.test/x', encodedDataLength: 4096 },
        { failed: true, errorText: 'net::ERR_FAILED', method: 'POST', url: 'https://a.test/y' },
        { url: 'https://a.test/z' },
      ],
      returned: 3,
      total: 3,
      clipped: 2,
      clippedTo: 300,
    })
  );
  assert.equal(
    out,
    '200 GET https://a.test/x 4kb\nFAILED net::ERR_FAILED POST https://a.test/y\npending https://a.test/z\n\n[3 requests, 2 URLs clipped to 300 characters]'
  );
  assert.equal(text(formatResult('read_network_requests', { requests: [] })), 'No network requests captured.');
});

test('a batch summary inlines only the steps whose content the caller needs', () => {
  const out = formatResult('browser_batch', {
    completed: true,
    results: [
      { index: 0, name: 'navigate', ok: true, result: { url: 'u' }, input: { url: 'u' } },
      { index: 1, name: 'page_state', ok: true, result: { url: 'u', effects: 'none' } },
      {
        index: 2,
        name: 'computer',
        ok: true,
        input: { action: 'screenshot' },
        result: { image: { data: 'AAAA', mediaType: 'image/jpeg', width: 10, height: 5, estimatedTokens: 3 } },
      },
    ],
  });
  const summary = out[0].text;
  assert.match(summary, /^\[0\] navigate ok\n/);
  assert.equal(/"url": "u"/.test(summary.split('[1] page_state')[0]), false, 'navigate output is not inlined');
  assert.match(summary, /\[1\] page_state ok\n {2}\[ok=true effects=none\]\n\{\n {2}"url": "u"/);
  assert.match(summary, /\[2\] computer ok\n[\s\S]*screenshot 10x5 \(~3 tokens\) id: img_\d+/);
  assert.equal(out.filter((b) => b.type === 'image').length, 1, 'the image block rides after the summary');
  assert.ok(INLINE_IN_SEQUENCE.has('page_state') && !INLINE_IN_SEQUENCE.has('navigate'));
});

test('a stopped batch names the failing action and says the rest did not run', () => {
  const out = text(
    formatResult('browser_batch', {
      completed: false,
      stoppedAt: 1,
      results: [
        { index: 0, name: 'page_state', ok: true, result: {} },
        {
          index: 1,
          name: 'javascript',
          ok: false,
          error: { message: 'boom', code: 'internal', effects: 'unknown', retryable: false },
        },
      ],
    })
  );
  assert.match(out, /\[1\] javascript FAILED: boom\n {2}\[ok=false code=internal effects=unknown retryable=false\]/);
  assert.match(out, /\nStopped at action 1\. Later actions did not run\.$/);
});

test('a quick script labels steps by line and command', () => {
  const out = text(
    formatResult('quick', {
      completed: false,
      results: [
        { index: 0, lineNo: 1, command: 'P', name: 'page_state', ok: true, result: {} },
        { index: 1, lineNo: 3, command: 'J', name: 'javascript', ok: false, error: { message: 'boom' } },
      ],
    })
  );
  assert.match(out, /^line 1 P ok\n/);
  assert.match(out, /line 3 J FAILED: boom\n\nStopped at line 3\./);
});

test('shortcuts_execute names the shortcut ahead of the script summary', () => {
  const out = formatResult('shortcuts_execute', { shortcut: { name: 'login' }, completed: true, results: [] });
  assert.equal(out[0].text, 'Ran shortcut login');
  assert.equal(out.length, 2);
});

test('a screenshot becomes an image block plus the line naming its id, and is saved on request', () => {
  const image = {
    data: Buffer.from('png-bytes').toString('base64'),
    mediaType: 'image/png',
    width: 8,
    height: 4,
    estimatedTokens: 2,
  };
  const before = capturedImageIds().length;
  const out = formatResult('computer', {
    image,
    saveToDisk: true,
    pageState: { url: 'https://a.test', scrollY: 120 },
  });
  assert.deepEqual(out[0], imageBlock(image));
  const id = capturedImageIds().at(-1);
  assert.equal(capturedImageIds().length, before + 1);
  assert.match(
    out[1].text,
    new RegExp('^screenshot 8x4 \\(~2 tokens\\) id: ' + id + '\\nurl: https://a\\.test\\nscroll: 120\\nsaved: ')
  );
  const saved = out[1].text.match(/saved: (.+)$/)[1];
  assert.ok(saved.startsWith(shotDir), 'saved under the configured directory');
  assert.ok(saved.endsWith('.png'));
  assert.equal(readFileSync(saved, 'utf8'), 'png-bytes');
});

test('a screenshot note rides under the caption', () => {
  const out = formatResult('computer', {
    image: {
      data: 'AA==',
      mediaType: 'image/jpeg',
      width: 1,
      height: 1,
      estimatedTokens: 1,
      note: 'capped to the token budget',
    },
  });
  assert.match(out[1].text, /\ncapped to the token budget$/);
});

test('a gif is written to disk under the requested name and reported with its span', () => {
  const recording = {
    width: 1,
    height: 1,
    palette: [0, 0, 0, 255, 255, 255],
    frames: [
      { indices: [0], delayMs: 100 },
      { indices: [1], delayMs: 100 },
    ],
    recordedMs: 1500,
  };
  const out = text(formatResult('gif_creator', recording, { filename: 'my run' }));
  assert.match(out, /^Recorded 2 frames over 1\.5s at 1x1\.\nsaved: /);
  const file = out.match(/saved: (.+)$/)[1];
  assert.equal(file, join(shotDir, 'my run.gif'));
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file).subarray(0, 6).toString('latin1'), 'GIF89a');

  const unnamed = text(formatResult('gif_creator', recording));
  assert.match(unnamed, /saved: .*recording-\d{4}-\d{2}-\d{2}T.*\.gif$/);
});

test('a gif result without frames is shown as it came', () => {
  const out = text(formatResult('gif_creator', { ok: true, frames: null }));
  assert.deepEqual(JSON.parse(out), { ok: true, frames: null });
});
