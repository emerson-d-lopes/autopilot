// Live browser test.
//
// Drives the real mcp-server.js process against a running Chrome with the
// extension loaded, over the real named pipe. Skips itself when no bridge is
// listening, so `npm test` stays useful without a browser.
//
// Start a browser first with: npm run browser

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { anyBridge } from '../host/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = readFileSync(join(ROOT, 'test', 'fixtures', 'page.html'), 'utf8');

// Pin the browser the suite found. With more than one connected a session
// must choose, and a test that leaves it ambiguous fails on which browsers
// happen to be running rather than on the code.
const bridge = await anyBridge();
const bridgeUp = Boolean(bridge);
if (bridge) process.env.CHROME_MCP_BROWSER_ID = bridge.id;
const options = bridgeUp ? {} : { skip: 'no browser connected (run: npm run browser)' };

// --- MCP client --------------------------------------------------------------

function mcpClient(child) {
  let buffer = '';
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });

  let seq = 0;
  return {
    request(method, params) {
      const id = ++seq;
      const promise = new Promise((resolve, reject) => {
        // The timer is unref'd and cleared on reply, so a finished suite does not
        // sit waiting for stale timeouts before the process can exit.
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error('timed out: ' + method + ' ' + JSON.stringify(params).slice(0, 120)));
        }, 45000);
        if (typeof timer.unref === 'function') timer.unref();
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return promise;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

/** Calls a tool and returns { text, content, isError }. */
async function callTool(mcp, name, args) {
  const response = await mcp.request('tools/call', { name, arguments: args });
  const content = response.result.content || [];
  return {
    isError: response.result.isError === true,
    content,
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    image: content.find((b) => b.type === 'image'),
  };
}

function refFor(text, pattern) {
  for (const line of text.split('\n')) {
    if (pattern.test(line)) {
      const match = line.match(/\[(ref_\d+)\]/);
      if (match) return match[1];
    }
  }
  return null;
}

// --- suite -------------------------------------------------------------------

// Upload fixtures are generated so the suite carries no binary files around.
const uploadDir = mkdtempSync(join(tmpdir(), 'chrome-mcp-uploads-'));
writeFileSync(join(uploadDir, 'note.txt'), 'hello from chrome-mcp');
writeFileSync(join(uploadDir, 'second.txt'), 'second file');

test('live browser automation', options, async (t) => {
  // Fixture server. localhost is allowed without a grant by policy.
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FIXTURE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);

  let tabId = null;
  t.after(async () => {
    if (tabId !== null) {
      await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
    }
    child.kill();
    await new Promise((r) => server.close(r));
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-test', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  await t.test('opens a tab in its own group', async () => {
    const result = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
    assert.equal(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.ok(parsed.tabGroupId !== null, 'a tab group was created');
    assert.ok(parsed.tabs.length >= 1);
    tabId = parsed.tabs[0].tabId;
  });

  await t.test('navigates to the fixture', async () => {
    const result = await callTool(mcp, 'navigate', { url: base + '/', tabId });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /127\.0\.0\.1/);
  });

  let tree = '';
  await t.test('reads the page as an accessibility tree', async () => {
    const result = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    assert.equal(result.isError, false, result.text);
    tree = result.text;

    assert.match(tree, /textbox "Email address" \[ref_\d+\]/);
    assert.match(tree, /button "Place order" \[ref_\d+\]/);
    assert.match(tree, /combobox .*options="Brazil\|United States\|Portugal"/);
    assert.match(tree, /checkbox "I accept the terms"/);
    assert.match(tree, /\(offscreen\)/, 'the below-the-fold button is marked offscreen');
    assert.equal(/heading/.test(tree), false, 'interactive filter drops the heading');
  });

  await t.test('find resolves elements by description', async () => {
    const email = await callTool(mcp, 'find', { query: 'email field', tabId });
    assert.equal(email.isError, false, email.text);
    assert.match(email.text, /textbox "Email address"/);

    const button = await callTool(mcp, 'find', { query: 'place order button', tabId });
    assert.match(button.text.split('\n')[1], /button "Place order"/);
  });

  await t.test('fills the form through form_input', async () => {
    const emailRef = refFor(tree, /Email address/);
    const countryRef = refFor(tree, /combobox/);
    const termsRef = refFor(tree, /I accept the terms/);
    assert.ok(emailRef && countryRef && termsRef, 'refs resolved from the tree');

    for (const [ref, value] of [
      [emailRef, 'buyer@example.com'],
      [countryRef, 'Portugal'],
      [termsRef, true],
    ]) {
      const result = await callTool(mcp, 'form_input', { tabId, ref, value });
      assert.equal(result.isError, false, result.text);
    }

    const check = await callTool(mcp, 'javascript', {
      tabId,
      code: '({ email: document.getElementById("email").value, country: document.getElementById("country").value, terms: document.getElementById("terms").checked })',
    });
    const state = JSON.parse(check.text).result;
    assert.equal(state.email, 'buyer@example.com');
    assert.equal(state.country, 'pt');
    assert.equal(state.terms, true);
  });

  await t.test('clicks by ref and the page handler runs', async () => {
    const submitRef = refFor(tree, /button "Place order"/);
    const click = await callTool(mcp, 'computer', { tabId, action: 'left_click', ref: submitRef });
    assert.equal(click.isError, false, click.text);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /ordered 1 to buyer@example\.com in Portugal terms=true/);
  });

  await t.test('typing with real key events reaches the field', async () => {
    const qtyRef = refFor(tree, /"Quantity"/);
    assert.ok(qtyRef, 'quantity field found');

    await callTool(mcp, 'computer', { tabId, action: 'triple_click', ref: qtyRef });
    await callTool(mcp, 'computer', { tabId, action: 'key', text: 'ctrl+a' });
    await callTool(mcp, 'computer', { tabId, action: 'type', text: '7' });

    const value = await callTool(mcp, 'javascript', { tabId, code: 'document.getElementById("qty").value' });
    assert.match(value.text, /"7"/);
  });

  await t.test('scroll_to brings an offscreen element into view and it clicks', async () => {
    const belowRef = refFor(tree, /below the fold/i);
    assert.ok(belowRef, 'below-the-fold button found in the tree');

    const click = await callTool(mcp, 'computer', { tabId, action: 'left_click', ref: belowRef });
    assert.equal(click.isError, false, click.text);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /clicked below the fold/);
  });

  await t.test('captures a screenshot within the token budget', async () => {
    const shot = await callTool(mcp, 'computer', { tabId, action: 'screenshot' });
    assert.equal(shot.isError, false, shot.text);
    assert.ok(shot.image, 'an image block came back');
    assert.equal(shot.image.mimeType, 'image/png');
    assert.ok(shot.image.data.length > 5000, 'image has real bytes');

    const dims = shot.text.match(/screenshot (\d+)x(\d+) \(~(\d+) tokens\)/);
    assert.ok(dims, 'caption reports dimensions: ' + shot.text);
    assert.ok(Number(dims[1]) <= 1568, 'long edge capped, got ' + dims[1]);
    assert.ok(Number(dims[3]) < 2200, 'token estimate reasonable, got ' + dims[3]);
  });

  await t.test('a coordinate read off a screenshot maps back to the right element', async () => {
    // The device pixel ratio here is not 1, so a raw screenshot coordinate is in
    // a different space from the CSS pixels CDP dispatches in. This is the round
    // trip that breaks silently when the scaling context is wrong.
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const shot = await callTool(mcp, 'computer', { tabId, action: 'screenshot' });
    const [, imageWidth] = shot.text.match(/screenshot (\d+)x\d+/);

    // The target has to be inside the captured viewport, which is what a
    // screenshot coordinate can address at all.
    const box = await callTool(mcp, 'javascript', {
      tabId,
      code: '(() => { const r = document.getElementById("submit").getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2, vw: innerWidth, vh: innerHeight }; })()',
    });
    const { cx, cy, vw, vh } = JSON.parse(box.text).result;
    assert.ok(cy > 0 && cy < vh, 'target is on screen at y=' + cy);

    const scale = Number(imageWidth) / vw;
    const click = await callTool(mcp, 'computer', {
      tabId,
      action: 'left_click',
      coordinate: [Math.round(cx * scale), Math.round(cy * scale)],
    });
    assert.equal(click.isError, false, click.text);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /"ordered .* in Brazil/, 'coordinate click landed on the submit button, got ' + result.text);
  });

  await t.test('zoom captures a region and keeps coordinates usable', async () => {
    const zoom = await callTool(mcp, 'computer', {
      tabId,
      action: 'zoom',
      region: [0, 0, 400, 300],
    });
    assert.equal(zoom.isError, false, zoom.text);
    assert.ok(zoom.image, 'zoom returns an image');
  });

  await t.test('scroll moves the page', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const before = JSON.parse((await callTool(mcp, 'page_state', { tabId })).text).scrollY;
    await callTool(mcp, 'computer', { tabId, action: 'scroll', scroll_direction: 'down', scroll_amount: 5 });
    const after = JSON.parse((await callTool(mcp, 'page_state', { tabId })).text).scrollY;
    assert.ok(after > before, 'scrolled from ' + before + ' to ' + after);
  });

  await t.test('hover does not click', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const hover = await callTool(mcp, 'computer', {
      tabId,
      action: 'hover',
      ref: refFor(fresh.text, /button "Place order"/),
    });
    assert.equal(hover.isError, false, hover.text);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /""/, 'hovering did not trigger the click handler');
  });

  await t.test('resize_window changes the viewport', async () => {
    const resized = await callTool(mcp, 'resize_window', { tabId, width: 900, height: 700 });
    assert.equal(resized.isError, false, resized.text);
    const state = JSON.parse(resized.text);
    assert.ok(state.viewport.width < 900, 'viewport is inside the new window, got ' + state.viewport.width);
  });

  await t.test('right click fires contextmenu without opening a native menu', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const click = await callTool(mcp, 'computer', {
      tabId,
      action: 'right_click',
      ref: refFor(fresh.text, /Right click target/),
    });
    assert.equal(click.isError, false, click.text);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /context menu at \d+,\d+/);

    // A native context menu would block every later call, so prove one still lands.
    const after = await callTool(mcp, 'page_state', { tabId });
    assert.equal(after.isError, false, 'the session is still responsive after a right click');
  });

  await t.test('double click fires dblclick', async () => {
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const click = await callTool(mcp, 'computer', {
      tabId,
      action: 'double_click',
      ref: refFor(fresh.text, /Double click target/),
    });
    assert.equal(click.isError, false, click.text);
    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /double clicked/);
  });

  await t.test('drag moves a pointer-driven control', async () => {
    await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("slider-track").scrollIntoView({block:"center"})',
    });
    const box = await callTool(mcp, 'javascript', {
      tabId,
      code: '(() => { const t = document.getElementById("slider-track").getBoundingClientRect(); const h = document.getElementById("slider-thumb").getBoundingClientRect(); return { fromX: Math.round(h.left + h.width/2), y: Math.round(h.top + h.height/2), toX: Math.round(t.left + 250) }; })()',
    });
    const { fromX, y, toX } = JSON.parse(box.text).result;

    const drag = await callTool(mcp, 'computer', {
      tabId,
      action: 'left_click_drag',
      start_coordinate: [fromX, y],
      coordinate: [toX, y],
    });
    assert.equal(drag.isError, false, drag.text);

    const value = await callTool(mcp, 'javascript', {
      tabId,
      code: 'Number(document.getElementById("slider-value").textContent)',
    });
    assert.ok(JSON.parse(value.text).result > 50, 'slider moved, got ' + value.text);
  });

  await t.test('drag completes an HTML5 drag and drop', async () => {
    await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("draggable").scrollIntoView({block:"center"})',
    });
    const box = await callTool(mcp, 'javascript', {
      tabId,
      code: '(() => { const a = document.getElementById("draggable").getBoundingClientRect(); const b = document.getElementById("dropzone").getBoundingClientRect(); return { ax: Math.round(a.left+a.width/2), ay: Math.round(a.top+a.height/2), bx: Math.round(b.left+b.width/2), by: Math.round(b.top+b.height/2) }; })()',
    });
    const { ax, ay, bx, by } = JSON.parse(box.text).result;

    await callTool(mcp, 'computer', {
      tabId,
      action: 'left_click_drag',
      start_coordinate: [ax, ay],
      coordinate: [bx, by],
    });
    const zone = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("dropzone").textContent',
    });
    assert.match(zone.text, /dropped: payload/);
  });

  await t.test('perKey typing produces real key events, plain typing does not', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const ref = refFor(fresh.text, /"Autocomplete"/);
    assert.ok(ref, 'autocomplete field found');

    await callTool(mcp, 'computer', { tabId, action: 'left_click', ref });
    await callTool(mcp, 'computer', { tabId, action: 'type', text: 'abc' });
    const plain = await callTool(mcp, 'javascript', {
      tabId,
      code: '({ value: document.getElementById("autocomplete").value, keys: Number(document.getElementById("keycount").textContent) })',
    });
    const afterPlain = JSON.parse(plain.text).result;
    assert.equal(afterPlain.value, 'abc', 'text landed');
    assert.equal(afterPlain.keys, 0, 'insertText fires no key events');

    await callTool(mcp, 'computer', { tabId, action: 'key', text: 'ctrl+a' });
    await callTool(mcp, 'computer', { tabId, action: 'type', text: 'xyz', perKey: true });
    const perKey = await callTool(mcp, 'javascript', {
      tabId,
      code: '({ value: document.getElementById("autocomplete").value, keys: Number(document.getElementById("keycount").textContent) })',
    });
    const afterPerKey = JSON.parse(perKey.text).result;
    assert.equal(afterPerKey.value, 'xyz');
    assert.ok(afterPerKey.keys >= 3, 'perKey fires a keydown per character, got ' + afterPerKey.keys);
  });

  await t.test('file_upload attaches to a file input', async () => {
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const upload = await callTool(mcp, 'file_upload', {
      tabId,
      ref: refFor(fresh.text, /Attach a file/),
      paths: [join(uploadDir, 'note.txt')],
    });
    assert.equal(upload.isError, false, upload.text);

    const info = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("fileinfo").textContent',
    });
    assert.match(info.text, /note\.txt \(\d+ bytes\)/);
  });

  await t.test('file_upload attaches several files to a multiple input', async () => {
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const upload = await callTool(mcp, 'file_upload', {
      tabId,
      ref: refFor(fresh.text, /Attach several files/),
      paths: [join(uploadDir, 'note.txt'), join(uploadDir, 'second.txt')],
    });
    assert.equal(upload.isError, false, upload.text);

    const info = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("filesinfo").textContent',
    });
    assert.match(info.text, /note\.txt, second\.txt/);
  });

  await t.test('file_upload rejects a missing file before touching the page', async () => {
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const upload = await callTool(mcp, 'file_upload', {
      tabId,
      ref: refFor(fresh.text, /Attach a file/),
      paths: [join(uploadDir, 'does-not-exist.txt')],
    });
    assert.equal(upload.isError, true);
    assert.match(upload.text, /No such file/);
  });

  await t.test('file_upload rejects several files on a single-file input', async () => {
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const upload = await callTool(mcp, 'file_upload', {
      tabId,
      ref: refFor(fresh.text, /Attach a file/),
      paths: [join(uploadDir, 'note.txt'), join(uploadDir, 'second.txt')],
    });
    assert.equal(upload.isError, true);
    assert.match(upload.text, /accepts one file/);
  });

  await t.test('file_upload drops files onto a plain drop zone by coordinate', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("dropzone").scrollIntoView({block:"center"})',
    });
    const box = await callTool(mcp, 'javascript', {
      tabId,
      code: '(() => { const r = document.getElementById("dropzone").getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()',
    });
    const { x, y } = JSON.parse(box.text).result;

    const drop = await callTool(mcp, 'file_upload', {
      tabId,
      coordinate: [x, y],
      paths: [join(uploadDir, 'note.txt')],
    });
    assert.equal(drop.isError, false, drop.text);

    const zone = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("dropzone").textContent',
    });
    assert.match(zone.text, /note\.txt|dropped/, 'drop reached the zone, got ' + zone.text);
  });

  await t.test('quick runs a whole sequence in one call', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const email = refFor(fresh.text, /Email address/);
    const country = refFor(fresh.text, /combobox/);
    const submit = refFor(fresh.text, /button "Place order"/);

    const result = await callTool(mcp, 'quick', {
      tabId,
      script: [
        '# fill the order form',
        'F ' + email + ' quick@example.com',
        'F ' + country + ' Portugal',
        'C ' + submit,
        'W',
        'J document.getElementById("result").textContent',
      ].join('\n'),
    });

    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /line 2 F ok/);
    assert.match(result.text, /line 4 C ok/);
    assert.match(result.text, /line 6 J ok/);
    assert.match(result.text, /ordered 1 to quick@example\.com in Portugal/, 'the J result is inlined');
  });

  await t.test('quick refuses to run a script with a bad command', async () => {
    const readResult = async () =>
      JSON.parse((await callTool(mcp, 'javascript', { tabId, code: 'document.getElementById("result").textContent' })).text).result;
    const before = await readResult();
    const result = await callTool(mcp, 'quick', {
      tabId,
      script: 'J document.getElementById("result").textContent = "SHOULD NOT HAPPEN"\nBOGUS thing',
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /Script not run/);
    assert.match(result.text, /line 2: unknown command "BOGUS"/);

    assert.equal(await readResult(), before, 'nothing ran, so the page is unchanged');
  });

  await t.test('quick stops at the first failing line', async () => {
    const result = await callTool(mcp, 'quick', {
      tabId,
      script: ['P', 'F ref_99999 x', 'J window.__quickShouldNotRun = true'].join('\n'),
    });
    assert.match(result.text, /line 1 P ok/);
    assert.match(result.text, /line 2 F FAILED/);
    assert.match(result.text, /Stopped at line 2/);

    const ran = await callTool(mcp, 'javascript', {
      tabId,
      code: 'window.__quickShouldNotRun === true',
    });
    assert.match(ran.text, /false/);
  });

  await t.test('pointer actions stay well under a second', async () => {
    // Every click once paid a fixed five seconds waiting for a mouse-move
    // acknowledgement from the renderer. This is the guard against that
    // returning quietly, since it never surfaced as a failure, only as latency.
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const submit = refFor(fresh.text, /button "Place order"/);

    for (const action of ['left_click', 'right_click', 'double_click', 'hover']) {
      const started = Date.now();
      const result = await callTool(mcp, 'computer', { tabId, action, ref: submit });
      const elapsed = Date.now() - started;
      assert.equal(result.isError, false, action + ': ' + result.text);
      assert.ok(elapsed < 1500, action + ' took ' + elapsed + 'ms, expected well under 1500ms');
    }
  });

  await t.test('the visible cursor never interferes with the page', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const submit = refFor(fresh.text, /button "Place order"/);
    await callTool(mcp, 'computer', { tabId, action: 'left_click', ref: submit });

    const probe = await callTool(mcp, 'javascript', {
      tabId,
      // D2: the host id is random per session now, not a fixed, greppable
      // string, so it is found structurally instead: a direct child of <html>
      // marked aria-hidden, which is what both the cursor and the indicator
      // overlay share.
      code: `(() => {
        const host = document.querySelector('html > div[aria-hidden="true"]');
        if (!host) return { present: false };
        const r = document.getElementById('submit').getBoundingClientRect();
        return {
          present: true,
          pointerEvents: getComputedStyle(host).pointerEvents,
          ariaHidden: host.getAttribute('aria-hidden'),
          shadowClosed: host.shadowRoot === null,
          hitTarget: document.elementFromPoint(r.left + r.width/2, r.top + r.height/2)?.id,
        };
      })()`,
    });
    const state = JSON.parse(probe.text).result;

    assert.equal(state.present, true, 'the cursor is drawn');
    assert.equal(state.pointerEvents, 'none', 'it cannot absorb a click');
    assert.equal(state.ariaHidden, 'true');
    assert.equal(state.shadowClosed, true, 'page scripts cannot reach into it');
    assert.equal(state.hitTarget, 'submit', 'hit testing still reaches the page');

    // It must not reach the model either, as a tree node or in a screenshot.
    const all = await callTool(mcp, 'read_page', { tabId, filter: 'all', max_chars: 80000 });
    assert.equal(/chrome_mcp_cursor|__cmcp_/.test(all.text), false, 'absent from the tree');

    // A capture hides the cursor and must put it back afterwards.
    await callTool(mcp, 'computer', { tabId, action: 'screenshot' });
    const after = await callTool(mcp, 'javascript', {
      tabId,
      code: '(() => { const h = document.querySelector(\'html > div[aria-hidden="true"]\'); return h ? h.style.display : "missing"; })()',
    });
    assert.notEqual(JSON.parse(after.text).result, 'none', 'the cursor is restored after a capture');
    assert.notEqual(JSON.parse(after.text).result, 'missing');
  });

  await t.test('reads console output captured since page load', async () => {
    await callTool(mcp, 'javascript', { tabId, code: 'document.getElementById("log-error").click()' });
    await new Promise((r) => setTimeout(r, 300));

    const all = await callTool(mcp, 'read_console_messages', { tabId, limit: 50 });
    assert.match(all.text, /\[fixture\] page ready/, 'includes a log from before we started reading');

    const errors = await callTool(mcp, 'read_console_messages', { tabId, only_errors: true });
    assert.match(errors.text, /deliberate error/);
    assert.equal(/page ready/.test(errors.text), false, 'only_errors filters logs out');

    const filtered = await callTool(mcp, 'read_console_messages', { tabId, pattern: 'order placed' });
    assert.match(filtered.text, /order placed for buyer@example\.com/);
  });

  await t.test('reads network requests including failures', async () => {
    await callTool(mcp, 'javascript', { tabId, code: 'document.getElementById("fetch").click()' });
    await new Promise((r) => setTimeout(r, 600));

    const requests = await callTool(mcp, 'read_network_requests', { tabId, url_pattern: 'api/missing' });
    assert.match(requests.text, /api\/missing/);
    assert.match(requests.text, /404/);
  });

  await t.test('browser_batch runs a sequence in one round trip', async () => {
    const fresh = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
    const emailRef = refFor(fresh.text, /Email address/);

    const batch = await callTool(mcp, 'browser_batch', {
      actions: [
        { name: 'form_input', input: { tabId, ref: emailRef, value: 'batch@example.com' } },
        { name: 'computer', input: { tabId, action: 'left_click', ref: refFor(fresh.text, /button "Place order"/) } },
        { name: 'page_state', input: { tabId } },
      ],
    });

    assert.equal(batch.isError, false, batch.text);
    assert.match(batch.text, /\[0\] form_input ok/);
    assert.match(batch.text, /\[1\] computer ok/);
    assert.match(batch.text, /\[2\] page_state ok/);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(result.text, /batch@example\.com/);
  });

  await t.test('a batch stops at the first failing action', async () => {
    const batch = await callTool(mcp, 'browser_batch', {
      actions: [
        { name: 'page_state', input: { tabId } },
        { name: 'form_input', input: { tabId, ref: 'ref_99999', value: 'x' } },
        { name: 'javascript', input: { tabId, code: 'window.__shouldNotRun = true' } },
      ],
    });

    assert.match(batch.text, /\[0\] page_state ok/);
    assert.match(batch.text, /\[1\] form_input FAILED/);
    assert.match(batch.text, /Stopped at action 1/);

    const ran = await callTool(mcp, 'javascript', { tabId, code: 'window.__shouldNotRun === true' });
    assert.match(ran.text, /false/, 'the action after the failure did not run');
  });

  await t.test('a stale ref fails with a recoverable message', async () => {
    await callTool(mcp, 'javascript', { tabId, code: 'document.getElementById("submit").remove()' });
    const stale = await callTool(mcp, 'computer', {
      tabId,
      action: 'left_click',
      ref: refFor(tree, /button "Place order"/),
    });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /no longer on the page/i);
  });

  await t.test('get_page_text returns prose without the chrome', async () => {
    const result = await callTool(mcp, 'get_page_text', { tabId });
    assert.match(result.text, /A fixture page for driving the bridge end to end/);
  });

  await t.test('the blocklist refuses a blocked host before navigating', async () => {
    const before = await callTool(mcp, 'page_state', { tabId });
    const blocked = await callTool(mcp, 'navigate', { url: 'https://www.chase.com/', tabId });

    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Blocked origin/);

    const after = await callTool(mcp, 'page_state', { tabId });
    assert.equal(JSON.parse(after.text).url, JSON.parse(before.text).url, 'the tab did not move');
  });

  await t.test('closing the last tab of a session keeps the window and the browser', async () => {
    // A fresh session gets a window of its own holding exactly one tab. Closing
    // that tab used to close the window, and when it was the browser's only
    // window Chrome quit and took the bridge with it.
    const solo = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CHROME_MCP_CLIENT_ID: 'solo-window-' + Date.now() },
    });
    const soloMcp = mcpClient(solo);
    await soloMcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'solo', version: '1' },
    });
    soloMcp.notify('notifications/initialized', {});

    const soloCall = async (name, args) => {
      const response = await soloMcp.request('tools/call', { name, arguments: args });
      const content = response.result.content || [];
      return {
        isError: response.result.isError === true,
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      };
    };

    try {
      const context = await soloCall('tabs_context', { createIfEmpty: true });
      const tabs = JSON.parse(context.text).tabs;
      assert.equal(tabs.length, 1, 'a fresh session owns exactly one tab');

      const closed = await soloCall('tabs_close', { tabId: tabs[0].tabId });
      assert.equal(closed.isError, false, closed.text);
      assert.match(closed.text, /"keptWindowOpen": true/, 'the window was kept open deliberately');

      // The session still has a usable tab, and the original session still works,
      // which it could not if the browser had gone.
      const after = JSON.parse((await soloCall('tabs_context', {})).text);
      assert.ok(after.tabs.length >= 1, 'the session still owns a tab');

      const original = await callTool(mcp, 'page_state', { tabId });
      assert.equal(original.isError, false, 'the browser and bridge survived: ' + original.text);

      for (const tab of after.tabs) await soloCall('tabs_close', { tabId: tab.tabId }).catch(() => {});
    } finally {
      solo.kill();
    }
  });

  await t.test('a tab outside the session group is refused', async () => {
    const result = await callTool(mcp, 'read_page', { tabId: 999999 });
    assert.equal(result.isError, true);
    assert.match(result.text, /No tab with id|not in this session/);
  });

  await t.test('wait_for_page settles after a navigation', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const settled = await callTool(mcp, 'wait_for_page', { tabId });
    assert.equal(settled.isError, false, settled.text);
    assert.match(settled.text, /"ok": true/);
  });
});
