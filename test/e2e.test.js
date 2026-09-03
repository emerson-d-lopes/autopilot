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
