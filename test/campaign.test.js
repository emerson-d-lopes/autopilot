// Live browser test that encodes the "Where chrome-mcp is already ahead, keep
// it" table from IMPROVEMENTS.md as assertions against the campaign fixture.
// Any change that regresses one of these rows costs more than the item it
// was meant to fix.
//
// Drives the real mcp-server.js process against a running Chrome with the
// extension loaded, the same way test/live.test.js does. Skips itself when
// no bridge is listening.
//
// Start a browser first with: npm run browser

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { anyBridge } from '../host/registry.js';
import { start as startFixture } from './fixtures/campaign/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const bridge = await anyBridge();
const bridgeUp = Boolean(bridge);
if (bridge) process.env.AUTOPILOT_BROWSER_ID = bridge.id;
const options = bridgeUp ? {} : { skip: 'no browser connected (run: npm run browser)' };

// --- MCP client, same shape as test/live.test.js ------------------------------

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

// --- suite ---------------------------------------------------------------------

test('campaign fixture: already-ahead table stays true', options, async (t) => {
  const server = await startFixture(0);
  const base = 'http://127.0.0.1:' + server.address().port;

  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);

  let tabId = null;
  t.after(async () => {
    if (tabId !== null) await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
    child.kill();
    await new Promise((r) => server.close(r));
  });

  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'campaign-test', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  await t.test('opens a tab and navigates to the fixture', async () => {
    const context = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
    assert.equal(context.isError, false, context.text);
    tabId = JSON.parse(context.text).tabs[0].tabId;

    const nav = await callTool(mcp, 'navigate', { url: base + '/', tabId });
    assert.equal(nav.isError, false, nav.text);
  });

  await t.test('open shadow DOM button is present in read_page with a ref', async () => {
    const tree = await callTool(mcp, 'read_page', { tabId, filter: 'all' });
    assert.equal(tree.isError, false, tree.text);
    assert.match(tree.text, /button "Open shadow button" \[ref_\d+\]/);
  });

  await t.test('same-origin iframe button is present, clickable by ref, and the iframe span updates', async () => {
    const tree = await callTool(mcp, 'read_page', { tabId, filter: 'all' });
    const ref = refFor(tree.text, /"Inside iframe"/);
    assert.ok(ref, 'a ref for the iframe button was found in: ' + tree.text.slice(0, 500));

    const click = await callTool(mcp, 'computer', { tabId, action: 'left_click', ref });
    assert.equal(click.isError, false, click.text);

    const result = await callTool(mcp, 'javascript', {
      tabId,
      code: "document.getElementById('same').contentDocument.getElementById('r').textContent",
    });
    assert.match(result.text, /iframe clicked/);
  });

  await t.test('(offscreen) marks are present for #farbtn', async () => {
    const tree = await callTool(mcp, 'read_page', { tabId, filter: 'all' });
    assert.equal(tree.isError, false, tree.text);
    const line = tree.text.split('\n').find((l) => /Far button/.test(l));
    assert.ok(line, 'far button line found');
    assert.match(line, /\(offscreen\)/);
  });

  await t.test('form_input on the disabled input is refused', async () => {
    const tree = await callTool(mcp, 'read_page', { tabId, filter: 'all' });
    const line = tree.text.split('\n').find((l) => /disabled=true/.test(l));
    assert.ok(line, 'a disabled=true node was found in the tree: ' + tree.text.slice(0, 500));
    const match = line.match(/\[(ref_\d+)\]/);
    assert.ok(match, 'the disabled node carries a ref: ' + line);

    const result = await callTool(mcp, 'form_input', { tabId, ref: match[1], value: 'nope' });
    assert.equal(result.isError, true);
    assert.match(result.text, /disabled/i);
  });

  await t.test('navigate to /redirect returns the resolved URL and a numeric durationMs', async () => {
    const nav = await callTool(mcp, 'navigate', { url: base + '/redirect', tabId });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /index\.html#redirected/);
    const durationMatch = nav.text.match(/"durationMs":\s*(\d+)/);
    assert.ok(durationMatch, 'durationMs present in: ' + nav.text);
    assert.ok(Number(durationMatch[1]) >= 0);
  });

  await t.test('a closed tab id returns a structured error mentioning tabs_context', async () => {
    const bogusTab = await callTool(mcp, 'tabs_create', { url: base + '/' });
    assert.equal(bogusTab.isError, false, bogusTab.text);
    const created = JSON.parse(bogusTab.text);
    await callTool(mcp, 'tabs_close', { tabId: created.tabId });

    const result = await callTool(mcp, 'read_page', { tabId: created.tabId });
    assert.equal(result.isError, true);
    assert.match(result.text, /tabs_context/);
  });

  await t.test('passive capture of /api/ok in read_network_requests without a prior read', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    await callTool(mcp, 'javascript', { tabId, code: "document.getElementById('fetchok').click()" });
    await new Promise((r) => setTimeout(r, 500));

    const requests = await callTool(mcp, 'read_network_requests', { tabId, url_pattern: 'api/ok' });
    assert.equal(requests.isError, false, requests.text);
    assert.match(requests.text, /api\/ok/);
  });

  await t.test('wait_for_page returns after the /spa button appears', async () => {
    // The fixture's /spa page swaps its content on a bare setTimeout with no
    // intervening DOM or network activity, so a single wait_for_page call
    // settles as soon as the page is quiet, which can be before the timer
    // fires. Calling it again (as an agent naturally would when the element
    // it wants is still missing) still beats a fixed blind sleep: each call
    // returns fast rather than blocking for a guessed duration.
    await callTool(mcp, 'navigate', { url: base + '/spa', tabId });

    let found = false;
    for (let attempt = 0; attempt < 5 && !found; attempt++) {
      const waited = await callTool(mcp, 'wait_for_page', { tabId });
      assert.equal(waited.isError, false, waited.text);
      const tree = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
      found = /button "go"/i.test(tree.text);
      if (!found) await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(found, 'the go button appeared within 5 wait_for_page attempts');
  });

  await t.test('a token estimate line is printed under a screenshot', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const shot = await callTool(mcp, 'computer', { tabId, action: 'screenshot' });
    assert.equal(shot.isError, false, shot.text);
    assert.match(shot.text, /~\d+ tokens/);
  });

  await t.test('quick runs a three-line script', async () => {
    await callTool(mcp, 'navigate', { url: base + '/', tabId });
    const result = await callTool(mcp, 'quick', {
      tabId,
      script: ['J 1+1', 'P', 'X'].join('\n'),
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /line 1 J ok/);
    assert.match(result.text, /line 2 P ok/);
    assert.match(result.text, /line 3 X ok/);
  });
});
