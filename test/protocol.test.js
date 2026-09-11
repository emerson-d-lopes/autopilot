import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { NativeMessaging } from '../host/protocol.js';

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const nm = new NativeMessaging(input, output);
  const received = [];
  const errors = [];
  nm.on('message', (m) => received.push(m));
  nm.on('error', (e) => errors.push(e));
  return { input, output, nm, received, errors };
}

const tick = () => new Promise((r) => setImmediate(r));

test('decodes a single framed message', async () => {
  const h = harness();
  h.input.write(frame({ type: 'hello', n: 1 }));
  await tick();
  assert.deepEqual(h.received, [{ type: 'hello', n: 1 }]);
});

test('decodes several messages in one buffer', async () => {
  const h = harness();
  h.input.write(Buffer.concat([frame({ a: 1 }), frame({ a: 2 }), frame({ a: 3 })]));
  await tick();
  assert.deepEqual(
    h.received.map((m) => m.a),
    [1, 2, 3]
  );
});

test('decodes a message split across writes', async () => {
  const h = harness();
  const buf = frame({ type: 'split', payload: 'x'.repeat(500) });
  h.input.write(buf.subarray(0, 3));
  await tick();
  assert.equal(h.received.length, 0);
  h.input.write(buf.subarray(3, 100));
  await tick();
  assert.equal(h.received.length, 0);
  h.input.write(buf.subarray(100));
  await tick();
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0].payload.length, 500);
});

test('reassembles chunked messages', async () => {
  const h = harness();
  const original = { type: 'tool_response', id: 'r1', result: { image: { data: 'A'.repeat(3000) } } };
  const json = JSON.stringify(original);
  const size = 1000;
  const total = Math.ceil(json.length / size);
  for (let i = 0; i < total; i++) {
    h.input.write(frame({ type: 'chunk', id: 'c1', index: i, total, data: json.slice(i * size, (i + 1) * size) }));
  }
  await tick();
  assert.equal(h.received.length, 1);
  assert.deepEqual(h.received[0], original);
});

test('reassembles chunks that arrive out of order', async () => {
  const h = harness();
  const original = { type: 'x', body: 'y'.repeat(2500) };
  const json = JSON.stringify(original);
  const size = 1000;
  const total = Math.ceil(json.length / size);
  const parts = [];
  for (let i = 0; i < total; i++) {
    parts.push({ type: 'chunk', id: 'c2', index: i, total, data: json.slice(i * size, (i + 1) * size) });
  }
  for (const part of parts.reverse()) h.input.write(frame(part));
  await tick();
  assert.equal(h.received.length, 1);
  assert.deepEqual(h.received[0], original);
});

test('interleaved chunk streams stay separate', async () => {
  const h = harness();
  const a = JSON.stringify({ who: 'a', pad: 'a'.repeat(1200) });
  const b = JSON.stringify({ who: 'b', pad: 'b'.repeat(1200) });
  const split = (s) => [s.slice(0, 800), s.slice(800)];
  const [a1, a2] = split(a);
  const [b1, b2] = split(b);
  h.input.write(frame({ type: 'chunk', id: 'A', index: 0, total: 2, data: a1 }));
  h.input.write(frame({ type: 'chunk', id: 'B', index: 0, total: 2, data: b1 }));
  h.input.write(frame({ type: 'chunk', id: 'B', index: 1, total: 2, data: b2 }));
  h.input.write(frame({ type: 'chunk', id: 'A', index: 1, total: 2, data: a2 }));
  await tick();
  assert.equal(h.received.length, 2);
  assert.equal(h.received[0].who, 'b');
  assert.equal(h.received[1].who, 'a');
});

test('malformed JSON raises an error without killing the stream', async () => {
  const h = harness();
  const bad = Buffer.from('{not json', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bad.length, 0);
  h.input.write(Buffer.concat([header, bad]));
  h.input.write(frame({ ok: true }));
  await tick();
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.received, [{ ok: true }]);
});

test('send emits a correctly framed message', async () => {
  const h = harness();
  h.nm.send({ hello: 'world' });
  const written = h.output.read();
  const length = written.readUInt32LE(0);
  assert.equal(length, written.length - 4);
  assert.deepEqual(JSON.parse(written.subarray(4).toString('utf8')), { hello: 'world' });
});

test('send refuses a payload over the 1MB native messaging cap', () => {
  const h = harness();
  assert.throws(() => h.nm.send({ big: 'x'.repeat(1024 * 1024 + 10) }), /too large/);
});

test('an absurd declared length is rejected', async () => {
  const h = harness();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(0xfffffff0, 0);
  h.input.write(header);
  await tick();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /out of range/);
});

// --- C7 and R11, the envelope the contract adds ------------------------------

test('a request envelope keeps its correlation id and generation through framing', async () => {
  const h = harness();
  const envelope = {
    type: 'tool_request',
    id: 'req_1',
    tool: 'form_input',
    args: { tabId: 3, ref: 'ref_1', value: 'x' },
    clientId: 'sess-1',
    callId: 'call_9_ab12cd',
    generation: 4,
  };
  h.input.write(frame(envelope));
  await tick();
  assert.deepEqual(h.received, [envelope]);
});

test('a contract result survives chunk reassembly whole', async () => {
  const h = harness();
  const original = {
    type: 'tool_response',
    id: 'req_2',
    callId: 'call_10_zz99yy',
    generation: 4,
    result: {
      ok: true,
      effects: 'applied',
      evidence: { mutations: 12, focus: 'button#send', navigated: false },
      warnings: ['output_truncated: the serialized value is 204800 characters, cut to 51200.'],
      image: { data: 'B'.repeat(5000) },
    },
  };
  const json = JSON.stringify(original);
  const size = 900;
  const total = Math.ceil(json.length / size);
  for (let i = 0; i < total; i++) {
    h.input.write(frame({ type: 'chunk', id: 'c9', index: i, total, data: json.slice(i * size, (i + 1) * size) }));
  }
  await tick();
  assert.equal(h.received.length, 1);
  assert.deepEqual(h.received[0], original);
  assert.equal(h.received[0].result.effects, 'applied');
  assert.equal(h.received[0].result.evidence.mutations, 12);
});

test('an error envelope carries the whole contract error object', async () => {
  const h = harness();
  const envelope = {
    type: 'tool_response',
    id: 'req_3',
    callId: 'call_11',
    error: {
      code: 'ref_stale',
      message: 'ref ref_9 is no longer on the page.',
      cause: 'the page reflowed',
      hint: 'Read the page again with read_page and use the new ref.',
      effects: 'none',
      retryable: false,
    },
  };
  h.input.write(frame(envelope));
  await tick();
  assert.deepEqual(h.received[0].error, envelope.error);
});

test('a replayed response is marked as such and keeps its original id', async () => {
  const h = harness();
  const envelope = {
    type: 'tool_response',
    id: 'mcp_1',
    replayed: true,
    generation: 5,
    result: { ok: true, effects: 'none' },
  };
  h.input.write(frame(envelope));
  await tick();
  assert.equal(h.received[0].replayed, true);
  assert.equal(h.received[0].id, 'mcp_1');
  assert.equal(h.received[0].generation, 5);
});
