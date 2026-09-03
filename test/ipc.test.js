import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { listen, connect, probe } from '../host/ipc.js';

function testPath(name) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\chrome-mcp-test-' + name + '-' + process.pid;
  return path.join(os.tmpdir(), 'chrome-mcp-test-' + name + '-' + process.pid + '.sock');
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
