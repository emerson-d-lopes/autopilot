import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listen, connect, probe } from '../host/ipc.js';
import { ResponseQueue, MAX_ENTRIES, TTL_MS } from '../host/response-queue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function testPath(name) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\autopilot-test-' + name + '-' + process.pid;
  return path.join(os.tmpdir(), 'autopilot-test-' + name + '-' + process.pid + '.sock');
}

test('round trips a message between host and client', async () => {
  const p = testPath('roundtrip');
  const seen = [];
  const server = await listen(p, (client) => {
    client.on('message', (m) => {
      seen.push(m);
      client.send({ type: 'echo', of: m.id });
    });
  });

  const client = await connect(p);
  const reply = new Promise((resolve) => client.on('message', resolve));
  client.send({ type: 'ping', id: 'a1' });
  assert.deepEqual(await reply, { type: 'echo', of: 'a1' });
  assert.deepEqual(seen, [{ type: 'ping', id: 'a1' }]);

  client.end();
  await new Promise((r) => server.close(r));
});

test('carries a payload larger than one socket chunk', async () => {
  const p = testPath('large');
  const server = await listen(p, (client) => {
    client.on('message', (m) => client.send({ len: m.data.length }));
  });
  const client = await connect(p);
  const reply = new Promise((resolve) => client.on('message', resolve));
  client.send({ data: 'x'.repeat(2 * 1024 * 1024) });
  assert.deepEqual(await reply, { len: 2 * 1024 * 1024 });
  client.end();
  await new Promise((r) => server.close(r));
});

test('serves several clients at once', async () => {
  const p = testPath('multi');
  const server = await listen(p, (client) => {
    client.on('message', (m) => client.send({ pong: m.from }));
  });

  const a = await connect(p);
  const b = await connect(p);
  const ra = new Promise((r) => a.on('message', r));
  const rb = new Promise((r) => b.on('message', r));
  a.send({ from: 'a' });
  b.send({ from: 'b' });
  assert.deepEqual(await ra, { pong: 'a' });
  assert.deepEqual(await rb, { pong: 'b' });

  a.end();
  b.end();
  await new Promise((r) => server.close(r));
});

test('messages containing newlines survive framing', async () => {
  const p = testPath('newline');
  const server = await listen(p, (client) => {
    client.on('message', (m) => client.send(m));
  });
  const client = await connect(p);
  const reply = new Promise((r) => client.on('message', r));
  const payload = { text: 'line one\nline two\r\nline three', nested: { s: 'a\nb' } };
  client.send(payload);
  assert.deepEqual(await reply, payload);
  client.end();
  await new Promise((r) => server.close(r));
});

test('probe reports false for a path nothing is listening on', async () => {
  assert.equal(await probe(testPath('absent')), false);
});

test('probe reports true for a live listener', async () => {
  const p = testPath('alive');
  const server = await listen(p, () => {});
  assert.equal(await probe(p), true);
  await new Promise((r) => server.close(r));
});

test('connecting to a missing path rejects', async () => {
  await assert.rejects(() => connect(testPath('missing'), 500));
});

test('a socket reports itself dead once the peer has gone', async () => {
  const p = testPath('alive-flag');
  let held = null;
  const server = await listen(p, (client) => {
    held = client;
  });
  const client = await connect(p);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(held.alive, true);
  assert.equal(held.send({ type: 'ping' }), true);

  client.end();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(held.alive, false);
  assert.equal(held.send({ type: 'ping' }), false, 'a write to a closed peer must report failure, not throw');

  await new Promise((r) => server.close(r));
});

// --- R11, the parked response queue ------------------------------------------

test('a response parked for a session comes back on the next connection', () => {
  const q = new ResponseQueue();
  q.park('session-a', { type: 'tool_response', id: 'mcp_1', result: { ok: true } }, { tool: 'read_page' });
  assert.equal(q.size, 1);

  assert.deepEqual(q.takeFor('session-b').messages, [], 'another session must not receive it');
  assert.equal(q.size, 1);

  const taken = q.takeFor('session-a');
  assert.equal(taken.messages.length, 1);
  assert.equal(taken.messages[0].id, 'mcp_1');
  assert.equal(q.size, 0, 'a replayed response leaves the queue');
});

test('the queue holds eight entries and evicts the oldest', () => {
  const q = new ResponseQueue();
  assert.equal(MAX_ENTRIES, 8);
  for (let i = 0; i < 10; i++) q.park('s', { id: 'm' + i });
  assert.equal(q.size, 8);
  const ids = q.takeFor('s').messages.map((m) => m.id);
  assert.deepEqual(ids, ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
});

test('an eviction is reported so the host can journal it', () => {
  const q = new ResponseQueue({ max: 2 });
  q.park('s', { id: 'a' }, { tool: 'find' });
  q.park('s', { id: 'b' });
  const third = q.park('s', { id: 'c' });
  assert.equal(third.dropped.length, 1);
  assert.equal(third.dropped[0].message.id, 'a');
  assert.equal(third.dropped[0].tool, 'find');
  assert.match(third.dropped[0].reason, /queue full/);
});

test('an entry past its TTL is dropped rather than replayed', () => {
  assert.equal(TTL_MS, 120000);
  let clock = 1000;
  const q = new ResponseQueue({ ttlMs: 120000, now: () => clock });
  q.park('s', { id: 'old' }, { tool: 'navigate' });

  clock += 119000;
  assert.equal(q.takeFor('other').dropped.length, 0, 'still inside the window');
  assert.equal(q.size, 1);

  clock += 2000;
  const taken = q.takeFor('s');
  assert.deepEqual(taken.messages, []);
  assert.equal(taken.dropped.length, 1);
  assert.match(taken.dropped[0].reason, /expired/);
  assert.equal(q.size, 0);
});

test('a response with no session id is not parked', () => {
  const q = new ResponseQueue();
  assert.equal(q.park(null, { id: 'x' }).parked, false);
  assert.equal(q.size, 0);
});

// --- R11 through the real native host ----------------------------------------

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Starts a real native host with a fake extension on its stdio, so the parking
 * and replay are exercised through the code the browser actually drives.
 */
async function startHost(name, extraEnv = {}) {
  const socket = testPath(name);
  const child = spawn(process.execPath, [join(ROOT, 'host', 'native-host.js')], {
    env: {
      ...process.env,
      AUTOPILOT_SOCKET: socket,
      AUTOPILOT_LOG_DIR: path.join(os.tmpdir(), 'autopilot-ipc-test-journal'),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const seen = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      seen.push(message);
      for (const [predicate, resolve] of waiters.splice(0)) {
        if (predicate(message)) resolve(message);
        else waiters.push([predicate, resolve]);
      }
    }
  });

  const extension = {
    send: (message) => child.stdin.write(frame(message)),
    waitFor: (predicate) =>
      new Promise((resolve, reject) => {
        const hit = seen.find(predicate);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error('the host sent no matching message')), 5000);
        waiters.push([predicate, (m) => {
          clearTimeout(timer);
          resolve(m);
        }]);
      }),
  };

  await new Promise((r) => setTimeout(r, 400));
  extension.send({ type: 'hello', tools: ['read_page'], version: 'ipc-test', generation: 7 });
  await new Promise((r) => setTimeout(r, 200));
  return { socket, child, extension, seen, stop: () => child.kill() };
}

test('a response whose socket closed is replayed to the same session id', async (t) => {
  const host = await startHost('replay');
  t.after(host.stop);

  const first = await connect(host.socket);
  first.send({ type: 'tool_request', id: 'mcp_1', tool: 'read_page', args: { tabId: 1 }, clientId: 'sess-1', callId: 'call_1' });
  const forwarded = await host.extension.waitFor((m) => m.type === 'tool_request');

  // The MCP server dies before the browser answers.
  first.end();
  await new Promise((r) => setTimeout(r, 200));
  host.extension.send({ type: 'tool_response', id: forwarded.id, result: { url: 'https://a/', nodes: 3 } });
  await new Promise((r) => setTimeout(r, 200));

  const second = await connect(host.socket);
  const replayed = new Promise((resolve) => {
    second.on('message', (m) => {
      if (m.type === 'tool_response') resolve(m);
    });
  });
  second.send({ type: 'ping', id: 'p1', clientId: 'sess-1' });

  const message = await replayed;
  assert.equal(message.id, 'mcp_1', 'the reply keeps the id the caller asked with');
  assert.equal(message.result.nodes, 3);
  assert.equal(message.replayed, true);
  second.end();
});

test('a different session does not receive another session\'s parked response', async (t) => {
  const host = await startHost('replay-other');
  t.after(host.stop);

  const first = await connect(host.socket);
  first.send({ type: 'tool_request', id: 'mcp_1', tool: 'read_page', args: { tabId: 1 }, clientId: 'sess-a' });
  const forwarded = await host.extension.waitFor((m) => m.type === 'tool_request');
  first.end();
  await new Promise((r) => setTimeout(r, 200));
  host.extension.send({ type: 'tool_response', id: forwarded.id, result: { nodes: 1 } });
  await new Promise((r) => setTimeout(r, 200));

  const other = await connect(host.socket);
  const responses = [];
  other.on('message', (m) => responses.push(m));
  other.send({ type: 'ping', id: 'p1', clientId: 'sess-b' });
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(responses.filter((m) => m.type === 'tool_response').length, 0);
  other.end();
});

test('the envelope carries the generation the extension reported', async (t) => {
  const host = await startHost('generation');
  t.after(host.stop);

  const client = await connect(host.socket);
  const status = await new Promise((resolve) => {
    client.on('message', (m) => {
      if (m.type === 'browser_status') resolve(m);
    });
  });
  assert.equal(status.generation, 7, 'the status frame names the generation');

  client.send({ type: 'tool_request', id: 'mcp_1', tool: 'read_page', args: { tabId: 1 }, clientId: 'sess-g' });
  const forwarded = await host.extension.waitFor((m) => m.type === 'tool_request');
  assert.equal(forwarded.generation, 7, 'every request to the extension carries it');
  assert.equal(forwarded.callId, undefined, 'no correlation id was sent, so none is invented');
  client.end();
});

test('the correlation id travels to the extension unchanged', async (t) => {
  const host = await startHost('callid');
  t.after(host.stop);

  const client = await connect(host.socket);
  client.send({ type: 'tool_request', id: 'mcp_1', tool: 'find', args: { tabId: 1, query: 'x' }, clientId: 's', callId: 'call_42_abcdef' });
  const forwarded = await host.extension.waitFor((m) => m.type === 'tool_request');
  assert.equal(forwarded.callId, 'call_42_abcdef');
  assert.notEqual(forwarded.id, 'mcp_1', 'the host renumbers its own request ids');
  client.end();
});

// ---------------------------------------------------------------------------
// Open bug 9: the host reports its own journal settings
// ---------------------------------------------------------------------------
//
// The journal is written by the host, which Chrome spawns, so
// AUTOPILOT_JOURNAL_REDACT has to be in the browser's environment. A tool
// reading it in its own process printed the wrong answer whenever the two
// differed, so the state travels with browser_status.

test('browser_status carries the journal settings of the process that writes it', async (t) => {
  assert.notEqual(process.env.AUTOPILOT_JOURNAL_REDACT, '1', 'this shell is not redacting');
  const host = await startHost('journalstate', {
    AUTOPILOT_JOURNAL_REDACT: '1',
    AUTOPILOT_JOURNAL_DAYS: '3',
  });
  t.after(host.stop);

  const client = await connect(host.socket);
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no browser_status arrived')), 5000);
    client.on('message', (message) => {
      if (message.type !== 'browser_status') return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  client.end();

  assert.ok(status.journal, 'the status carries a journal block');
  assert.equal(status.journal.redact, true, "the host's redaction state, not this shell's");
  assert.equal(status.journal.retentionDays, 3);
  assert.ok(status.journal.dir, 'and the directory it writes to');
});
