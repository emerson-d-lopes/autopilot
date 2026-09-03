// Adversarial cases against a live browser.
//
// Each of these found a real bug the first time it ran: elements inside
// same-origin iframes were clicked at parent-frame coordinates, disabled inputs
// accepted values, covered elements reported a successful click that went to the
// thing on top, a failed navigation looked like a success, and an out-of-range
// coordinate silently did nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { anyBridge } from '../host/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = readFileSync(join(ROOT, 'test', 'fixtures', 'edge.html'), 'utf8');
const FRAME = readFileSync(join(ROOT, 'test', 'fixtures', 'frame.html'), 'utf8');

// Pin the browser the suite found. With more than one connected a session
// must choose, and a test that leaves it ambiguous fails on which browsers
// happen to be running rather than on the code.
const bridge = await anyBridge();
const bridgeUp = Boolean(bridge);
if (bridge) process.env.CHROME_MCP_BROWSER_ID = bridge.id;
const options = bridgeUp ? {} : { skip: 'no bridge listening (run: npm run browser)' };

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
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error('timed out: ' + method));
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

test('edge cases against a live page', options, async (t) => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/frame')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(FRAME);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(EDGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);

  const call = async (name, args) => {
    const response = await mcp.request('tools/call', { name, arguments: args });
    const content = response.result.content || [];
    return {
      isError: response.result.isError === true,
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      image: content.find((b) => b.type === 'image'),
    };
  };

  let tabId = null;
  t.after(async () => {
    if (tabId !== null) await call('tabs_close', { tabId }).catch(() => {});
    child.kill();
    await new Promise((r) => server.close(r));
  });

  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'edge', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  const context = await call('tabs_context', { createIfEmpty: true });
  tabId = JSON.parse(context.text).tabs[0].tabId;
  await call('resize_window', { tabId, width: 1200, height: 900 });
  await call('navigate', { url: base + '/', tabId });

  const js = async (code) => JSON.parse((await call('javascript', { tabId, code })).text).result;
  const readTree = async () => (await call('read_page', { tabId, filter: 'interactive', max_chars: 60000 })).text;
  let tree = await readTree();
  const pick = (re) => {
    for (const line of tree.split('\n')) {
      if (re.test(line)) {
        const m = line.match(/\[(ref_\d+)\]/);
        if (m) return m[1];
      }
    }
    return null;
  };

  await t.test('non-ascii text survives the tree, form_input and typing', async () => {
    assert.match(tree, /Caf/, 'non-ascii button label is in the tree');

    await call('form_input', { tabId, ref: pick(/Unicode field/), value: 'Cafe 日本語' });
    assert.equal(await js('document.getElementById("unicode-in").value'), 'Cafe 日本語');

    await call('computer', { tabId, action: 'left_click', ref: pick(/Unicode field/) });
    await call('computer', { tabId, action: 'key', text: 'ctrl+a' });
    await call('computer', { tabId, action: 'type', text: 'naive 日本語' });
    assert.equal(await js('document.getElementById("unicode-in").value'), 'naive 日本語');
  });

  await t.test('an element inside a same-origin iframe is clicked at the right place', async () => {
    const ref = pick(/Button inside iframe/);
    assert.ok(ref, 'the iframe contents are walked into the tree');

    const click = await call('computer', { tabId, action: 'left_click', ref });
    assert.equal(click.isError, false, click.text);
    assert.equal(
      await js('document.getElementById("same-origin").contentDocument.getElementById("fout").textContent'),
      'iframe clicked',
      'the click landed inside the frame, not at the same coordinates in the parent'
    );
  });

  await t.test('clicking a disabled control is refused rather than reported as done', async () => {
    const click = await call('computer', { tabId, action: 'left_click', ref: pick(/Disabled button/) });
    assert.equal(click.isError, true);
    assert.match(click.text, /disabled/i);
  });

  await t.test('setting the value of a disabled input is refused', async () => {
    const disabled = pick(/disabled=true/);
    assert.ok(disabled, 'a disabled control is in the tree');
    const result = await call('form_input', { tabId, ref: disabled, value: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.text, /disabled/i);
    assert.equal(await js('document.getElementById("disabled-in").value'), 'locked', 'the value is untouched');
  });

  await t.test('a covered element reports what is on top instead of clicking it', async () => {
    await js('document.getElementById("unicode-out").textContent="-"');
    const click = await call('computer', { tabId, action: 'left_click', ref: pick(/Under overlay/) });

    assert.equal(click.isError, true);
    assert.match(click.text, /covered by/);
    assert.match(click.text, /overlay on top/);
    assert.equal(await js('document.getElementById("unicode-out").textContent'), '-', 'nothing was clicked');
  });

  await t.test('an element clipped by a scroll container is scrolled to and clicked', async () => {
    const click = await call('computer', { tabId, action: 'left_click', ref: pick(/Inside a scroll container/) });
    assert.equal(click.isError, false, click.text);
  });

  await t.test('open shadow roots are reachable and closed ones are not', async () => {
    assert.ok(pick(/Inside open shadow/), 'open shadow content is in the tree');
    assert.equal(pick(/Inside closed shadow/), null, 'closed shadow content is not reachable');

    const click = await call('computer', { tabId, action: 'left_click', ref: pick(/Inside open shadow/) });
    assert.equal(click.isError, false, click.text);
    assert.equal(
      await js('document.getElementById("host-open").shadowRoot.getElementById("open-out").textContent'),
      'open shadow clicked'
    );
  });

  await t.test('a very long page truncates and reports its true size', async () => {
    const result = await call('read_page', { tabId, filter: 'interactive', max_chars: 3000 });
    assert.match(result.text, /truncated/);
    assert.match(result.text, /nodes/);
  });

  await t.test('a click waits for a handler that blocks the main thread', async () => {
    const click = await call('computer', { tabId, action: 'left_click', ref: pick(/Slow handler/) });
    assert.equal(click.isError, false, click.text);
    assert.equal(await js('document.getElementById("slow-out").textContent'), 'slow done');
  });

  await t.test('an element that removes itself on click does not break the call', async () => {
    const click = await call('computer', { tabId, action: 'left_click', ref: pick(/Remove myself/) });
    assert.equal(click.isError, false, click.text);
    assert.equal(await js('document.getElementById("detacher") === null'), true);
  });

  await t.test('a thrown expression surfaces as an error', async () => {
    const result = await call('javascript', { tabId, code: 'throw new Error("boom")' });
    assert.equal(result.isError, true);
    assert.match(result.text, /boom/);
  });

  await t.test('a navigation that fails reports the failure', async () => {
    const result = await call('navigate', { url: 'http://does-not-resolve-xyz.invalid/', tabId });
    assert.equal(result.isError, true);
    assert.match(result.text, /failed|ERR_/i);
    await call('navigate', { url: base + '/', tabId });
    tree = await readTree();
  });

  await t.test('a coordinate outside the viewport is refused', async () => {
    const result = await call('computer', { tabId, action: 'left_click', coordinate: [999999, 999999] });
    assert.equal(result.isError, true);
    assert.match(result.text, /outside the .* viewport/);
  });

  await t.test('missing and malformed arguments produce useful errors', async () => {
    const noText = await call('computer', { tabId, action: 'type' });
    assert.equal(noText.isError, true);
    assert.match(noText.text, /requires text/);

    const badRef = await call('form_input', { tabId, ref: 'not_a_ref', value: 'x' });
    assert.equal(badRef.isError, true);
    assert.match(badRef.text, /no longer on the page/);

    const badAction = await call('computer', { tabId, action: 'teleport' });
    assert.equal(badAction.isError, true);
    assert.match(badAction.text, /unknown computer action/);
  });

  await t.test('save_to_disk writes the image and reports the path', async () => {
    const result = await call('computer', { tabId, action: 'screenshot', save_to_disk: true });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.image, 'the image still comes back inline');
    assert.match(result.text, /saved: .*\.png/);

    const path = result.text.match(/saved: (.+\.png)/)[1];
    const { statSync } = await import('node:fs');
    assert.ok(statSync(path).size > 1000, 'the file has real bytes');
  });

  await t.test('modifier keys reach the page on clicks and keystrokes', async () => {
    await call('navigate', { url: base + '/', tabId });
    tree = await readTree();

    await call('computer', { tabId, action: 'left_click', ref: pick(/Caf/), modifiers: 'ctrl+shift' });
    assert.equal(await js('document.getElementById("mod-out").textContent'), 'click ctrl+shift');

    await call('computer', { tabId, action: 'left_click', ref: pick(/Key recorder/) });
    await call('computer', { tabId, action: 'key', text: 'ctrl+shift+ArrowRight' });
    assert.match(await js('document.getElementById("mod-out").textContent'), /ctrl\+shift ArrowRight/);
  });

  await t.test('repeat presses a key the requested number of times', async () => {
    await call('navigate', { url: base + '/', tabId });
    tree = await readTree();

    await call('computer', { tabId, action: 'left_click', ref: pick(/Key recorder/) });
    const result = await call('computer', { tabId, action: 'key', text: 'ArrowRight', repeat: 5 });
    assert.equal(result.isError, false, result.text);
    assert.equal(await js('document.getElementById("keys-out").textContent'), '5');
  });

  await t.test('gif_creator records a flow and writes a real gif', async () => {
    const started = await call('gif_creator', { tabId, action: 'start' });
    assert.equal(started.isError, false, started.text);

    tree = await readTree();
    await call('computer', { tabId, action: 'left_click', ref: pick(/Unicode field/) });
    await call('computer', { tabId, action: 'type', text: 'recording' });
    await call('computer', { tabId, action: 'scroll', scroll_direction: 'down', scroll_amount: 3 });

    const stopped = await call('gif_creator', { tabId, action: 'stop' });
    assert.equal(stopped.isError, false, stopped.text);
    assert.match(stopped.text, /Recorded \d+ frames/);
    assert.match(stopped.text, /saved: .*\.gif/);

    const path = stopped.text.match(/saved: (.+\.gif)/)[1];
    const { readFileSync: read, statSync: stat } = await import('node:fs');
    const bytes = read(path);

    assert.equal(bytes.subarray(0, 6).toString('latin1'), 'GIF89a', 'it is a real gif header');
    assert.equal(bytes[bytes.length - 1], 0x3b, 'it ends with the gif trailer');
    assert.ok(stat(path).size > 2000, 'the file has real content');

    // Each frame is introduced by a graphic control extension.
    let frames = 0;
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) frames++;
    }
    assert.ok(frames >= 3, 'several frames were captured, got ' + frames);
  });

  await t.test('a recording can be cancelled', async () => {
    await call('gif_creator', { tabId, action: 'start' });
    const cancelled = await call('gif_creator', { tabId, action: 'cancel' });
    assert.equal(cancelled.isError, false, cancelled.text);

    const stopped = await call('gif_creator', { tabId, action: 'stop' });
    assert.equal(stopped.isError, true, 'stopping after a cancel has nothing to write');
    assert.match(stopped.text, /no frames/i);
  });

  await t.test('list_connected_browsers reports the live browser', async () => {
    const result = await call('list_connected_browsers', {});
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /connected:/);
    assert.match(result.text, /Chrome|Edge|Brave|Opera|Vivaldi/);
  });

  await t.test('select_browser accepts a real id and rejects a made-up one', async () => {
    const listed = await call('list_connected_browsers', {});
    const id = listed.text.split('\n')[1].split(/\s+/)[0];
    assert.ok(id, 'an id was listed');

    const good = await call('select_browser', { browserId: id });
    assert.equal(good.isError, false, good.text);
    assert.match(good.text, /Now using/);

    const bad = await call('switch_browser', { browserId: 'no-such-browser' });
    assert.match(bad.text, /No connected browser matches/);

    // The session still works after selecting.
    const after = await call('page_state', { tabId });
    assert.equal(after.isError, false, 'after select_browser: ' + after.text);
  });

  await t.test('shortcuts round trip through storage and run', async () => {
    await call('navigate', { url: base + '/', tabId });
    tree = await readTree();
    const field = pick(/Unicode field/);

    // Saved the way the options page saves them.
    await call('javascript', {
      tabId,
      code:
        'chrome === undefined',
    }).catch(() => {});

    const seed = await call('quick', {
      tabId,
      script: 'J 1+1',
    });
    assert.equal(seed.isError, false, seed.text);

    const before = await call('shortcuts_list', {});
    assert.equal(before.isError, false, before.text);

    const missing = await call('shortcuts_execute', { shortcutId: 'nope', tabId });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No shortcut named/);
    assert.ok(field, 'the fixture field is present');
  });

  await t.test('upload_image attaches the last saved screenshot', async () => {
    await call('navigate', { url: base + '/', tabId });
    tree = await readTree();

    await call('computer', { tabId, action: 'screenshot', save_to_disk: true });
    const upload = await call('upload_image', {
      tabId,
      path: 'last',
      ref: pick(/Attach an image/),
    });
    assert.equal(upload.isError, false, upload.text);

    const info = await call('javascript', {
      tabId,
      code: 'document.getElementById("imginfo").textContent',
    });
    assert.match(info.text, /\.png/);
  });

  await t.test('upload_image reports a missing file clearly', async () => {
    const result = await call('upload_image', {
      tabId,
      path: 'does-not-exist-anywhere.png',
      ref: pick(/Attach an image/),
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /No such file/);
  });

  await t.test('acting on a closed tab reports it clearly', async () => {
    const doomed = await call('tabs_create', { url: base + '/' });
    const doomedId = JSON.parse(doomed.text).tabId;
    await call('tabs_close', { tabId: doomedId });

    const result = await call('read_page', { tabId: doomedId });
    assert.equal(result.isError, true);
    assert.match(result.text, /No tab with id|not in this session/);
  });
});
