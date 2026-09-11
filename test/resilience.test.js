// Recovery tests.
//
// Anthropic's own extension documents an unfixed failure here: the service
// worker goes idle during a long session, the connection breaks, and the user
// has to reconnect by hand. These are slow by nature, because the only way to
// prove a session survives going idle is to let it go idle.
//
// Run with: npm run test:resilience

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { anyBridge } from '../host/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pin the browser the suite found. With more than one connected a session
// must choose, and a test that leaves it ambiguous fails on which browsers
// happen to be running rather than on the code.
const bridge = await anyBridge();
const bridgeUp = Boolean(bridge);
if (bridge) process.env.AUTOPILOT_BROWSER_ID = bridge.id;
const options = bridgeUp ? {} : { skip: 'no bridge listening (run: npm run browser)' };

// The MV3 idle timeout is 30 seconds, so a shorter wait proves nothing.
const IDLE_WAIT_MS = 45000;

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
    request(method, params, timeoutMs = 60000) {
      const id = ++seq;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error('timed out: ' + method));
        }, timeoutMs);
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

async function startClient() {
  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);
  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'resilience', version: '1' },
  });
  mcp.notify('notifications/initialized', {});
  return { child, mcp };
}

async function callTool(mcp, name, args, timeoutMs) {
  const response = await mcp.request('tools/call', { name, arguments: args }, timeoutMs);
  const content = response.result.content || [];
  return {
    isError: response.result.isError === true,
    text: content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
  };
}

function nativeHostPids() {
  if (process.platform !== 'win32') {
    try {
      return execFileSync('pgrep', ['-f', 'native-host.js'], { encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*native-host*' } | ForEach-Object { $_.ProcessId }",
    ],
    { encoding: 'utf8' }
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function killPid(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  } else {
    process.kill(Number(pid), 'SIGKILL');
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a session survives the service worker going idle', options, async (t) => {
  const { child, mcp } = await startClient();
  let tabId = null;
  t.after(async () => {
    if (tabId !== null) await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
    child.kill();
  });

  const context = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
  tabId = JSON.parse(context.text).tabs[0].tabId;
  await callTool(mcp, 'navigate', { url: 'https://example.com/', tabId });

  const before = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
  assert.equal(before.isError, false, before.text);

  // Long enough for Chrome to tear the worker down if nothing holds it open.
  await wait(IDLE_WAIT_MS);

  const started = Date.now();
  const after = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
  const elapsed = Date.now() - started;

  assert.equal(after.isError, false, 'the session still works after idling: ' + after.text);
  assert.ok(elapsed < 15000, 'recovery took ' + elapsed + 'ms');

  // The tab group and its refs are session state, so they have to survive too.
  const context2 = await callTool(mcp, 'tabs_context', {});
  assert.ok(
    JSON.parse(context2.text).tabs.some((tab) => tab.tabId === tabId),
    'the session still owns its tab after the worker restarted'
  );
});

test('the session recovers when the native host is killed', options, async (t) => {
  const { child, mcp } = await startClient();
  let tabId = null;
  t.after(async () => {
    if (tabId !== null) await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
    child.kill();
  });

  const context = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
  tabId = JSON.parse(context.text).tabs[0].tabId;
  await callTool(mcp, 'navigate', { url: 'https://example.com/', tabId });
  assert.equal((await callTool(mcp, 'page_state', { tabId })).isError, false);

  const pids = nativeHostPids();
  assert.ok(pids.length >= 1, 'a native host process is running');
  for (const pid of pids) killPid(pid);

  // The extension reconnects on its own backoff, which spawns a fresh host.
  let reconnected = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(1000);
    if (await anyBridge()) {
      reconnected = true;
      break;
    }
  }
  assert.ok(reconnected, 'the bridge came back without anyone touching the browser');

  // The same client reconnects to the new host on its next call, so the session
  // and the tabs it owns survive the host dying underneath it.
  const recovered = await callTool(mcp, 'page_state', { tabId });
  assert.equal(recovered.isError, false, 'tools work again: ' + recovered.text);
  assert.match(recovered.text, /"url"/);

  const context2 = await callTool(mcp, 'tabs_context', {});
  assert.ok(
    JSON.parse(context2.text).tabs.some((tab) => tab.tabId === tabId),
    'the session still owns its tab'
  );
});

test('a separate process can resume a session by id', options, async (t) => {
  // Sessions are keyed by client id, which is what keeps two Claude Code
  // sessions from driving each other's tabs. Pinning the id lets a restarted
  // client pick its own session back up.
  const clientId = 'resume-test-' + Date.now();
  const first = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AUTOPILOT_CLIENT_ID: clientId },
  });
  const firstMcp = mcpClient(first);
  await firstMcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'resume-a', version: '1' },
  });
  firstMcp.notify('notifications/initialized', {});

  const context = await callTool(firstMcp, 'tabs_context', { createIfEmpty: true });
  const tabId = JSON.parse(context.text).tabs[0].tabId;
  await callTool(firstMcp, 'navigate', { url: 'https://example.com/', tabId });
  first.kill();

  const second = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AUTOPILOT_CLIENT_ID: clientId },
  });
  const secondMcp = mcpClient(second);
  t.after(async () => {
    await callTool(secondMcp, 'tabs_close', { tabId }).catch(() => {});
    second.kill();
  });
  await secondMcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'resume-b', version: '1' },
  });
  secondMcp.notify('notifications/initialized', {});

  const resumed = await callTool(secondMcp, 'page_state', { tabId });
  assert.equal(resumed.isError, false, 'the restarted client owns the same tab: ' + resumed.text);
  assert.match(resumed.text, /example\.com/);
});

test('a stale request fails with a clear message rather than hanging', options, async (t) => {
  // Killing the host mid-flight must surface as an error, not a silent stall.
  const { child, mcp } = await startClient();
  t.after(() => child.kill());

  const context = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
  const tabId = JSON.parse(context.text).tabs[0].tabId;
  t.after(async () => {
    await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
  });

  const slow = callTool(mcp, 'computer', { tabId, action: 'wait', duration: 8 }, 40000);
  await wait(500);
  for (const pid of nativeHostPids()) killPid(pid);

  const result = await slow;
  assert.equal(result.isError, true, 'the in-flight call reported a failure');
  assert.match(result.text, /closed|not running|not connected|did not respond/i);

  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(1000);
    if (await anyBridge()) break;
  }
  assert.ok(await anyBridge(), 'the bridge is listening again');
});
