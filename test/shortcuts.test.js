// Saved shortcuts, end to end.
//
// A shortcut lives in extension storage, which only the extension can write, so
// the test seeds it through the service worker over the DevTools port that the
// development browser exposes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { anyBridge } from '../host/registry.js';
import { listTargets, CdpSession } from '../tools/cdp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = readFileSync(join(ROOT, 'test', 'fixtures', 'page.html'), 'utf8');
const PORT = Number(process.env.CHROME_MCP_DEVTOOLS_PORT || 9333);

async function serviceWorker() {
  try {
    const targets = await listTargets(PORT);
    return targets.find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js')) || null;
  } catch {
    return null;
  }
}

// Pin the browser the suite found. With more than one connected a session
// must choose, and a test that leaves it ambiguous fails on which browsers
// happen to be running rather than on the code.
const bridge = await anyBridge();
const bridgeUp = Boolean(bridge);
if (bridge) process.env.CHROME_MCP_BROWSER_ID = bridge.id;
const worker = bridgeUp ? await serviceWorker() : null;
const options = worker
  ? {}
  : { skip: 'needs the development browser with its DevTools port (run: npm run browser)' };

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

test('saved shortcuts', options, async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const sw = await CdpSession.open(worker.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');

  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);

  const call = async (name, args) => {
    const response = await mcp.request('tools/call', { name, arguments: args });
    const content = response.result.content || [];
    return {
      isError: response.result.isError === true,
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    };
  };

  let tabId = null;
  t.after(async () => {
    // Leave storage as it was found.
    await sw.evaluate('chrome.storage.local.remove("shortcuts")').catch(() => {});
    if (tabId !== null) await call('tabs_close', { tabId }).catch(() => {});
    child.kill();
    sw.close();
    await new Promise((r) => server.close(r));
  });

  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'shortcuts', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  const context = await call('tabs_context', { createIfEmpty: true });
  tabId = JSON.parse(context.text).tabs[0].tabId;
  await call('navigate', { url: base + '/', tabId });

  const fresh = await call('read_page', { tabId, filter: 'interactive' });
  const refFor = (pattern) => {
    for (const line of fresh.text.split('\n')) {
      if (pattern.test(line)) {
        const m = line.match(/\[(ref_\d+)\]/);
        if (m) return m[1];
      }
    }
    return null;
  };
  const emailRef = refFor(/Email address/);
  const submitRef = refFor(/button "Place order"/);
  assert.ok(emailRef && submitRef, 'the fixture refs resolved');

  const script = ['F ' + emailRef + ' shortcut@example.com', 'C ' + submitRef, 'W'].join('\n');
  const seeded = [
    { id: 'order', name: 'Place a test order', description: 'fills and submits', script },
    { id: 'peek', name: 'Read the page', description: '', script: 'P' },
  ];

  await sw.evaluate(
    'chrome.storage.local.set({ shortcuts: ' + JSON.stringify(seeded) + ' }).then(() => "ok")'
  );

  await t.test('shortcuts_list reports what is saved', async () => {
    const result = await call('shortcuts_list', {});
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /"id": "order"/);
    assert.match(result.text, /Place a test order/);
    assert.match(result.text, /"lines": 3/);
  });

  await t.test('shortcuts_execute runs the saved script', async () => {
    const result = await call('shortcuts_execute', { shortcutId: 'order', tabId });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /line 1 F ok/);
    assert.match(result.text, /line 2 C ok/);

    const check = await call('javascript', {
      tabId,
      code: 'document.getElementById("result").textContent',
    });
    assert.match(check.text, /shortcut@example\.com/, 'the shortcut actually drove the page');
  });

  await t.test('a shortcut can be run by name as well as id', async () => {
    const result = await call('shortcuts_execute', { shortcutId: 'Read the page', tabId });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /line 1 P ok/);
  });

  await t.test('an unknown shortcut lists what is available', async () => {
    const result = await call('shortcuts_execute', { shortcutId: 'nope', tabId });
    assert.equal(result.isError, true);
    assert.match(result.text, /No shortcut named/);
    assert.match(result.text, /order/);
  });
});
