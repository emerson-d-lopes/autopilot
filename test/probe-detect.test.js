import test from 'node:test';
import assert from 'node:assert/strict';

import { asText, asJson, evaluated, refFor, stats } from '../tools/probe-detect.js';

// The `javascript` tool answers with a result envelope, so the value the page
// returned sits in `result` as a string. Reading the envelope as the value gave
// an object with no `keys` and no `moves`, which the probe printed as "nothing
// was measured" rather than as an error.
test('evaluated unwraps the javascript result envelope', () => {
  const reply = {
    text: JSON.stringify({
      result: JSON.stringify({ keys: [1, 2, 3], moves: [{ x: 1, y: 2 }] }),
      type: 'string',
      durationMs: 4,
      id: 'call_1_abc',
      ok: true,
    }),
  };
  const value = evaluated(reply);
  assert.deepEqual(value.keys, [1, 2, 3]);
  assert.equal(value.moves.length, 1);
});

test('evaluated keeps a result that is not JSON', () => {
  const reply = { text: JSON.stringify({ result: 'installed', type: 'string', ok: true }) };
  assert.equal(evaluated(reply), 'installed');
});

test('evaluated keeps a result that is already a value', () => {
  const reply = { text: JSON.stringify({ result: 2, type: 'number', ok: true }) };
  assert.equal(evaluated(reply), 2);
});

test('evaluated leaves a body with no result field alone', () => {
  const reply = { text: JSON.stringify({ tabs: [{ tabId: 7 }] }) };
  assert.deepEqual(evaluated(reply).tabs, [{ tabId: 7 }]);
});

test('asText reads the mcp-client shape and the MCP content shape', () => {
  assert.equal(asText({ text: 'hello' }), 'hello');
  assert.equal(asText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(asText('plain'), 'plain');
  assert.equal(asText(null), '');
});

test('asJson finds the body when prose follows it', () => {
  assert.deepEqual(asJson({ text: '{"a":1}\n\n[ok=true id=call_1]' }), { a: 1 });
});

test('refFor picks the ref off a matching tree line', () => {
  const tree = 'textbox "Name" [ref_1]\nbutton "Submit" [ref_12]';
  assert.equal(refFor(tree, /button "Submit"/), 'ref_12');
  assert.equal(refFor(tree, /"Name"/), 'ref_1');
  assert.equal(refFor(tree, /nothing/), null);
});

test('stats reports the spread a cadence check reads', () => {
  const s = stats([60, 60, 60]);
  assert.equal(s.n, 3);
  assert.equal(s.mean, 60);
  assert.equal(s.sd, 0);
  assert.equal(s.cv, 0);
  assert.equal(stats([]), null);
});
