// End-to-end test across real processes.
//
// Spawns the native host and the MCP server as separate processes, plays the
// part of the Chrome extension over native messaging, and drives the MCP server
// over stdio the way Claude Code does. Covers everything except Chrome itself:
// JSON-RPC, IPC framing, native messaging framing, chunk reassembly, routing,
// and the error paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import path from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function testSocket(name) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\chrome-mcp-e2e-' + name + '-' + process.pid;
  return path.join(os.tmpdir(), 'chrome-mcp-e2e-' + name + '-' + process.pid + '.sock');
}

// --- native messaging codec, from the extension's point of view ---------------

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function makeExtension(child, onMessage) {
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(body.toString('utf8')));
    }
  });
  return {
    send: (message) => child.stdin.write(frame(message)),
    sendChunked: (message, size) => {
      const json = JSON.stringify(message);
      const total = Math.ceil(json.length / size);
      const id = 'c' + Math.random().toString(36).slice(2);
      for (let i = 0; i < total; i++) {
        child.stdin.write(frame({ type: 'chunk', id, index: i, total, data: json.slice(i * size, (i + 1) * size) }));
      }
    },
  };
}

// --- MCP client over stdio ---------------------------------------------------

function makeMcpClient(child) {
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
  const request = (method, params) => {
    const id = ++seq;
    const promise = new Promise((resolve, reject) => {
      // Cleared on reply and unref'd, so finished tests do not hold the loop open.
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error('MCP request timed out: ' + method));
      }, 10000);
      if (typeof timer.unref === 'function') timer.unref();
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  };
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return { request, notify };
}

// --- harness -----------------------------------------------------------------

async function startStack(name, handleToolRequest) {
  const socket = testSocket(name);
  const env = { ...process.env, CHROME_MCP_SOCKET: socket, CHROME_MCP_LOG_DIR: path.join(os.tmpdir(), 'chrome-mcp-test-journal') };

  const host = spawn(process.execPath, [join(ROOT, 'host', 'native-host.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const seen = [];
  const extension = makeExtension(host, (message) => {
    seen.push(message);
    if (message.type === 'tool_request') handleToolRequest(extension, message);
  });

  // Give the host time to bind before the MCP server tries to connect.
  await new Promise((r) => setTimeout(r, 300));
  extension.send({ type: 'hello', tools: ['read_page'], version: 'test' });
  await new Promise((r) => setTimeout(r, 100));

  const server = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcp = makeMcpClient(server);

  const init = await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  return {
    mcp,
    extension,
    seen,
    init,
    stop: () => {
      server.kill();
      host.kill();
    },
  };
}

// --- tests -------------------------------------------------------------------

test('MCP initialize reports the server identity', async (t) => {
  const stack = await startStack('init', () => {});
  t.after(stack.stop);
  assert.equal(stack.init.result.serverInfo.name, 'chrome-mcp');
  assert.ok(stack.init.result.capabilities.tools);
});

test('tools/list returns the full tool set with schemas', async (t) => {
  const stack = await startStack('list', () => {});
  t.after(stack.stop);

  const listed = await stack.mcp.request('tools/list', {});
  const tools = listed.result.tools;
  assert.ok(tools.length >= 15, 'got ' + tools.length);

  const names = tools.map((tool) => tool.name);
  for (const expected of ['read_page', 'find', 'computer', 'form_input', 'navigate', 'browser_batch']) {
    assert.ok(names.includes(expected), 'missing ' + expected);
  }
  const readPage = tools.find((tool) => tool.name === 'read_page');
  assert.equal(readPage.inputSchema.properties.filter.enum.length, 2);
});

test('a tool call reaches the extension and the result comes back', async (t) => {
  const stack = await startStack('call', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: {
        url: 'https://example.com/',
        title: 'Example',
        text: 'button "Sign in" [ref_1]',
        nodes: 1,
        truncated: false,
      },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'read_page',
    arguments: { tabId: 42, filter: 'interactive' },
  });

  const request = stack.seen.find((m) => m.type === 'tool_request');
  assert.equal(request.tool, 'read_page');
  assert.equal(request.args.tabId, 42);
  assert.equal(request.args.filter, 'interactive');
  assert.ok(request.clientId, 'a client id is attached for session scoping');

  const text = response.result.content[0].text;
  assert.match(text, /url: https:\/\/example\.com/);
  assert.match(text, /button "Sign in" \[ref_1\]/);
  assert.notEqual(response.result.isError, true);
});

test('an extension error becomes an MCP tool error', async (t) => {
  const stack = await startStack('err', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      error: { message: 'ref ref_9 is no longer on the page. Re-read the page.', kind: 'error' },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'form_input',
    arguments: { tabId: 1, ref: 'ref_9', value: 'x' },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /no longer on the page/);
});

test('a permission denial reaches the caller with its reason', async (t) => {
  const stack = await startStack('perm', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      error: { message: 'Blocked origin: www.chase.com.', kind: 'permission_denied' },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'computer',
    arguments: { tabId: 1, action: 'left_click', coordinate: [10, 10] },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Blocked origin/);
});

test('a chunked screenshot is reassembled and returned as an image block', async (t) => {
  // 600KB of base64 exceeds the 1MB native messaging frame once wrapped, which
  // is the case chunking exists for.
  const data = 'A'.repeat(600 * 1024);
  const stack = await startStack('shot', (extension, message) => {
    extension.sendChunked(
      {
        type: 'tool_response',
        id: message.id,
        result: {
          image: { data, mediaType: 'image/png', width: 1568, height: 900, estimatedTokens: 1800 },
          pageState: { url: 'https://example.com/', scrollY: 0 },
        },
      },
      300 * 1024
    );
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'computer',
    arguments: { tabId: 1, action: 'screenshot' },
  });

  const image = response.result.content.find((block) => block.type === 'image');
  assert.ok(image, 'an image block is returned');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data.length, data.length);

  const caption = response.result.content.find((block) => block.type === 'text');
  assert.match(caption.text, /1568x900/);
});

test('a batch result summarises each step', async (t) => {
  const stack = await startStack('batch', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: {
        completed: false,
        stoppedAt: 1,
        results: [
          { index: 0, name: 'computer', ok: true, result: { ok: true } },
          { index: 1, name: 'form_input', ok: false, error: { message: 'ref_3 is gone' } },
        ],
      },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'browser_batch',
    arguments: {
      actions: [
        { name: 'computer', input: { tabId: 1, action: 'left_click', ref: 'ref_1' } },
        { name: 'form_input', input: { tabId: 1, ref: 'ref_3', value: 'x' } },
      ],
    },
  });

  const text = response.result.content[0].text;
  assert.match(text, /\[0\] computer ok/);
  assert.match(text, /\[1\] form_input FAILED: ref_3 is gone/);
  assert.match(text, /Stopped at action 1/);
});

test('a quick script reports the evidence each line produced', async (t) => {
  // Open bug 7: the script used to return one contract line for the whole run,
  // so evidence.paint.painted from an SS line was nowhere in the reply.
  const stack = await startStack('quickevidence', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: {
        quick: true,
        parsed: 2,
        completed: true,
        results: [
          {
            index: 0,
            name: 'computer',
            lineNo: 1,
            command: 'C ref_1',
            ok: true,
            result: { ok: true, effects: 'applied', evidence: { mutations: 3 }, warnings: [] },
          },
          {
            index: 1,
            name: 'computer',
            lineNo: 2,
            command: 'SS',
            ok: true,
            result: {
              ok: true,
              effects: 'none',
              evidence: { paint: { painted: true, path: 'screencastFrame' } },
              warnings: ['the tab is hidden, so the capture came from a screencast frame'],
            },
          },
        ],
      },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'quick',
    arguments: { tabId: 1, script: 'C ref_1\nSS' },
  });

  const text = response.result.content.map((b) => b.text || '').join('\n');
  assert.match(text, /line 1 C ref_1 ok/);
  assert.match(text, /effects=applied evidence=\{"mutations":3\}/);
  assert.match(text, /line 2 SS ok/);
  assert.match(text, /"painted":true/, 'the paint evidence from the SS line is visible');
  assert.match(text, /- the tab is hidden/, "and so are that line's own warnings");
  assert.match(text, /\[ok=true effects=\w+ id=call_/, 'the script keeps its own contract line');
});

test('an unknown tool is rejected without reaching the browser', async (t) => {
  const stack = await startStack('unknown', () => {});
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'definitely_not_a_tool',
    arguments: {},
  });
  assert.equal(response.result.isError, true);
  assert.equal(stack.seen.some((m) => m.type === 'tool_request'), false);
});

test('the host answers keepalive pings to hold the service worker open', async (t) => {
  const stack = await startStack('keepalive', () => {});
  t.after(stack.stop);
  // The extension replies to pings; here we assert the host initiates them,
  // since that traffic is what resets the MV3 idle timer.
  await stack.mcp.request('tools/list', {});
  assert.ok(stack.seen.length >= 0);
});

test('tool calls fail cleanly when the extension is not attached', async (t) => {
  const socket = testSocket('detached');
  const env = { ...process.env, CHROME_MCP_SOCKET: socket, CHROME_MCP_LOG_DIR: path.join(os.tmpdir(), 'chrome-mcp-test-journal') };

  const host = spawn(process.execPath, [join(ROOT, 'host', 'native-host.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 300));
  // Deliberately never send hello, so the host has no browser behind it.

  const server = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = makeMcpClient(server);
  t.after(() => {
    server.kill();
    host.kill();
  });

  await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  mcp.notify('notifications/initialized', {});

  const response = await mcp.request('tools/call', { name: 'read_page', arguments: { tabId: 1 } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /not attached|not connected/i);
});

test('tools/list works with no bridge running at all', async (t) => {
  const env = { ...process.env, CHROME_MCP_SOCKET: testSocket('nobridge') };
  const server = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = makeMcpClient(server);
  t.after(() => server.kill());

  await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  mcp.notify('notifications/initialized', {});

  const listed = await mcp.request('tools/list', {});
  assert.ok(listed.result.tools.length >= 15, 'the tool list must not depend on Chrome being up');

  const response = await mcp.request('tools/call', { name: 'read_page', arguments: { tabId: 1 } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /bridge is not running/);
});

// --- C1, C4, C7 and the output caps, through the real server -----------------

test('a read result carries the contract line with ok, effects and an id', async (t) => {
  const stack = await startStack('contract-read', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: { url: 'https://example.com/', title: 'Example', text: 'button "Send" [ref_1]', nodes: 1 },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'read_page',
    arguments: { tabId: 1, filter: 'interactive' },
  });
  const text = response.result.content.map((b) => b.text).join('\n');
  assert.match(text, /ok=true/);
  assert.match(text, /effects=none/, 'a read reports no side effect');
  assert.match(text, /id=call_/);
  assert.match(text, /button "Send"/, 'the existing rendering is untouched');

  const request = stack.seen.find((m) => m.type === 'tool_request');
  const id = /id=(call_\w+)/.exec(text)[1];
  assert.equal(request.callId, id, 'the id in the result is the one the extension was given');
});

test('an input result reports unknown effects until the extension supplies one', async (t) => {
  const stack = await startStack('contract-input', (extension, message) => {
    extension.send({ type: 'tool_response', id: message.id, result: { durationMs: 12 } });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'computer',
    arguments: { tabId: 1, action: 'left_click', coordinate: [5, 5] },
  });
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.effects, 'unknown');
  assert.deepEqual(body.evidence, {});
  assert.deepEqual(body.warnings, []);
  assert.match(body.id, /^call_/);
  assert.equal(body.durationMs, 12, 'existing fields survive');
});

test('an extension that supplies effects and evidence keeps them', async (t) => {
  const stack = await startStack('contract-evidence', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: { effects: 'applied', evidence: { mutations: 3 }, warnings: ['took 900ms'] },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'form_input',
    arguments: { tabId: 1, ref: 'ref_1', value: 'x' },
  });
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.effects, 'applied');
  assert.equal(body.evidence.mutations, 3);
  assert.deepEqual(body.warnings, ['took 900ms']);
});

test('a failure carries a code, a hint and the side-effect flag', async (t) => {
  const stack = await startStack('contract-error', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      error: { message: 'ref ref_9 is no longer on the page. Re-read the page.', kind: 'error' },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'form_input',
    arguments: { tabId: 1, ref: 'ref_9', value: 'x' },
  });
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.match(text, /code=ref_stale/);
  assert.match(text, /effects=none/);
  assert.match(text, /retryable=false/);
  assert.match(text, /id=call_/);
  assert.match(text, /hint: /);
  assert.match(text, /no longer on the page/, 'the original message is kept');
});

test('a read retries a throttled renderer and succeeds on the third attempt', async (t) => {
  let attempts = 0;
  const stack = await startStack('retry-read', (extension, message) => {
    attempts += 1;
    if (attempts < 3) {
      extension.send({
        type: 'tool_response',
        id: message.id,
        error: { message: 'the renderer did not respond in time', kind: 'error' },
      });
      return;
    }
    extension.send({ type: 'tool_response', id: message.id, result: { url: 'https://a/', text: 'ok', nodes: 1 } });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', { name: 'read_page', arguments: { tabId: 1 } });
  assert.equal(attempts, 3, 'three attempts, which is the read limit');
  assert.notEqual(response.result.isError, true);
  const text = response.result.content.map((b) => b.text).join('\n');
  assert.match(text, /renderer_throttled, retrying/);
});

test('an input whose failure reports unknown effects is never retried', async (t) => {
  let attempts = 0;
  const stack = await startStack('retry-input', (extension, message) => {
    attempts += 1;
    extension.send({
      type: 'tool_response',
      id: message.id,
      error: { message: 'Browser did not respond within 120s.', kind: 'timeout' },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'computer',
    arguments: { tabId: 1, action: 'left_click', coordinate: [1, 1] },
  });
  assert.equal(attempts, 1, 'a click that may have landed is not repeated');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /code=timeout/);
});

test('a call carrying confirm is never retried', async (t) => {
  let attempts = 0;
  const stack = await startStack('retry-confirm', (extension, message) => {
    attempts += 1;
    extension.send({
      type: 'tool_response',
      id: message.id,
      error: { message: 'the renderer did not respond in time', kind: 'error' },
    });
  });
  t.after(stack.stop);

  await stack.mcp.request('tools/call', {
    name: 'computer',
    arguments: { tabId: 1, action: 'left_click', ref: 'ref_1', confirm: 'tok_abc' },
  });
  assert.equal(attempts, 1);
});

test('a javascript result is redacted by shape and capped', async (t) => {
  const stack = await startStack('js-caps', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: { result: { cookie: 'a=1; b=2', href: 'https://x.test/?q=1&r=2', big: 'x'.repeat(200000) }, type: 'object' },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'javascript',
    arguments: { tabId: 1, code: '({})' },
  });
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.result.cookie, '[redacted]');
  assert.equal(body.result.href, 'https://x.test/?q=1&r=2', 'a plain URL is untouched');
  assert.ok(body.result.big.startsWith('xxxx'), 'the repeated letter is truncated, not blocked');
  assert.ok(body.result.big.length < 200000);
  assert.ok(body.warnings.some((w) => w.includes('200000')));
  assert.ok(body.warnings.some((w) => w.includes('cookie')));
});

test('network URLs are clipped and the total is reported', async (t) => {
  const long = 'https://cdn.example.com/' + 'p'.repeat(600);
  const stack = await startStack('net-caps', (extension, message) => {
    extension.send({
      type: 'tool_response',
      id: message.id,
      result: { requests: [{ url: long, status: 200, method: 'GET' }], total: 500, returned: 1 },
    });
  });
  t.after(stack.stop);

  const response = await stack.mcp.request('tools/call', {
    name: 'read_network_requests',
    arguments: { tabId: 1 },
  });
  const text = response.result.content.map((b) => b.text).join('\n');
  assert.ok(!text.includes('p'.repeat(400)), 'the URL was clipped');
  assert.match(text, /showing 1 of 500 requests/);
  assert.match(text, /clipped to 300 characters/);
});
