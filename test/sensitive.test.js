// Sensitive field redaction (F1) and the irreversible-action classifier (W3).
//
// chrome-mcp drives the user's real signed-in profile with no cloud boundary in
// between, so a password reaching the tree, a form_input confirmation or the
// journal is a value on disk that never had to be there. The classifier is the
// other side of the same concern: the model gets to know a control sends, pays
// or deletes before it presses it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './page-harness.js';
import { parseTree } from '../extension/src/lib/find.js';

// ---------------------------------------------------------------------------
// F1: what counts as sensitive
// ---------------------------------------------------------------------------

const SENSITIVE_PAGE = `<!doctype html><body>
  <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
  <input id="csrf" type="hidden" value="tok_abcdef">
  <label for="otp">One time code</label><input id="otp" autocomplete="one-time-code" value="123456">
  <label for="card">Card number</label><input id="card" autocomplete="cc-number" value="4111111111111111">
  <label for="csc">CVC</label><input id="csc" autocomplete="cc-csc" value="737">
  <label for="expm">Expiry month</label>
  <select id="expm" autocomplete="cc-exp-month"><option value="01">01</option><option value="02">02</option></select>
  <label for="email">Email</label><input id="email" type="email" value="buyer@example.com">
  <label for="note">Note</label><textarea id="note" autocomplete="cc-number">4111 1111</textarea>
</body>`;

test('the sensitivity test covers types and autocomplete tokens', () => {
  const { window, agent } = loadPage(SENSITIVE_PAGE);
  const byId = (id) => window.document.getElementById(id);

  assert.equal(agent.isSensitiveField(byId('pw')), true, 'type=password');
  assert.equal(agent.isSensitiveField(byId('csrf')), true, 'type=hidden');
  assert.equal(agent.isSensitiveField(byId('otp')), true, 'one-time-code');
  assert.equal(agent.isSensitiveField(byId('card')), true, 'cc-number');
  assert.equal(agent.isSensitiveField(byId('csc')), true, 'cc-csc');
  assert.equal(agent.isSensitiveField(byId('expm')), true, 'cc-exp-month');
  assert.equal(agent.isSensitiveField(byId('email')), false, 'an ordinary email field is not sensitive');
  assert.deepEqual(
    [...agent.SENSITIVE_AUTOCOMPLETE].sort(),
    ['cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-number', 'current-password', 'new-password', 'one-time-code'],
    'the list is the one the plan names'
  );
});

test('the tree redacts sensitive values and keeps ordinary ones', async () => {
  const { call } = loadPage(SENSITIVE_PAGE);
  const result = await call({ type: 'READ_PAGE', filter: 'all', depth: 20 });

  assert.equal(/hunter2/.test(result.text), false, 'no password in the tree');
  assert.equal(/123456/.test(result.text), false, 'no one-time code');
  assert.equal(/4111/.test(result.text), false, 'no card number, in the input or the textarea');
  assert.equal(/737/.test(result.text), false, 'no card security code');
  assert.match(result.text, /\[value redacted\]/);
  assert.match(result.text, /buyer@example\.com/, 'an ordinary value is still reported');
});

test('a sensitive select lists no options', async () => {
  const { call } = loadPage(SENSITIVE_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  const expiry = nodes.find((n) => n.name === 'Expiry month');

  assert.ok(expiry, 'the control is still in the tree');
  assert.equal(/options=/.test(expiry.attrs || ''), false, 'its options are not enumerated');
});

test('an ordinary select still lists its options', async () => {
  const { call } = loadPage(
    '<!doctype html><body><label for="c">Country</label>' +
      '<select id="c"><option>Brazil</option><option>Portugal</option></select></body>'
  );
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  assert.match(nodes.find((n) => n.name === 'Country').attrs, /options=Brazil\|Portugal/);
});

test('FORM_INPUT returns [redacted] and a sensitive flag instead of the value', async () => {
  const { call } = loadPage(SENSITIVE_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const password = nodes.find((n) => n.name === 'Password');

  const result = await call({ type: 'FORM_INPUT', ref: password.ref, value: 'correct horse battery' });

  assert.equal(result.ok, true);
  assert.equal(result.value, '[redacted]');
  assert.equal(result.sensitive, true);
  assert.equal(JSON.stringify(result).includes('correct horse'), false, 'the value is not echoed anywhere');
});

test('FORM_INPUT on an ordinary field still confirms the value it set', async () => {
  const { call } = loadPage(SENSITIVE_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const email = nodes.find((n) => n.name === 'Email');

  const result = await call({ type: 'FORM_INPUT', ref: email.ref, value: 'other@example.com' });
  assert.equal(result.value, 'other@example.com');
  assert.equal(result.sensitive, undefined);
});

test('RESOLVE_REF marks a sensitive field so the caller can redact the result', async () => {
  const { call } = loadPage(SENSITIVE_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const password = nodes.find((n) => n.name === 'Password');
  const email = nodes.find((n) => n.name === 'Email');

  assert.equal((await call({ type: 'RESOLVE_REF', ref: password.ref })).sensitive, true);
  assert.equal((await call({ type: 'RESOLVE_REF', ref: email.ref })).sensitive, false);
});

test('REF_TEXT redacts the text of a sensitive control and still reports its length', async () => {
  const { call } = loadPage(SENSITIVE_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const card = nodes.find((n) => n.name === 'Card number');

  const result = await call({ type: 'REF_TEXT', ref: card.ref });
  assert.equal(result.text, '[redacted]');
  assert.equal(result.length, 16);
});

// ---------------------------------------------------------------------------
// W3: the irreversible classifier
// ---------------------------------------------------------------------------

const ACTION_PAGE = `<!doctype html><body>
  <button id="send">Send</button>
  <button id="publish">Publish post</button>
  <button id="delete">Delete account</button>
  <button id="pay">Pay now</button>
  <button id="buy">Buy it now</button>
  <button id="confirm">Confirm order</button>
  <button id="transfer">Transfer funds</button>
  <a id="unsub" href="/x">Unsubscribe</a>
  <button id="save">Save draft</button>
  <button id="cancel">Cancel</button>
  <button id="poster">Posted by Ana</button>
  <button id="sender">Sender details</button>
  <a id="remove" href="/y">Remove from list</a>
  <form action="/messages/post"><button id="formaction">Go</button></form>
</body>`;

test('the word list marks the controls that cannot be undone', async () => {
  const { call } = loadPage(ACTION_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  const mark = (name) => nodes.find((n) => n.name === name).irreversible;

  for (const name of [
    'Send', 'Publish post', 'Delete account', 'Pay now', 'Buy it now',
    'Confirm order', 'Transfer funds', 'Unsubscribe', 'Remove from list',
  ]) {
    assert.equal(mark(name), true, name + ' should be marked');
  }
});

test('ordinary controls and near misses are left alone', async () => {
  const { call } = loadPage(ACTION_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  const mark = (name) => nodes.find((n) => n.name === name).irreversible;

  assert.equal(mark('Save draft'), false);
  assert.equal(mark('Cancel'), false);
  assert.equal(mark('Posted by Ana'), false, 'whole words only, so "Posted" is not "post"');
  assert.equal(mark('Sender details'), false, 'and "Sender" is not "send"');
});

test("a form's action marks its submit control", async () => {
  const { call } = loadPage(ACTION_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  assert.equal(nodes.find((n) => n.name === 'Go').irreversible, true);
});

test('the mark sits between the name and the ref, where find reads it', async () => {
  const { call } = loadPage(ACTION_PAGE);
  const result = await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 });

  assert.match(result.text, /button "Send" \[irreversible\] \[ref_\d+\]/);
  const nodes = parseTree(result.text);
  const send = nodes.find((n) => n.name === 'Send');
  assert.equal(send.role, 'button', 'the mark does not break the role');
  assert.match(send.ref, /^ref_\d+$/, 'nor the ref');
});

test('RESOLVE_REF reports the classification, so the click result can carry it', async () => {
  const { call } = loadPage(ACTION_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const send = nodes.find((n) => n.name === 'Send');
  const cancel = nodes.find((n) => n.name === 'Cancel');

  assert.equal((await call({ type: 'RESOLVE_REF', ref: send.ref })).irreversible, true);
  assert.equal((await call({ type: 'RESOLVE_REF', ref: cancel.ref })).irreversible, false);
});

test('a page in the payment category marks every control', async () => {
  const { call } = loadPage(ACTION_PAGE);
  const nodes = parseTree(
    (await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20, paymentCategory: true })).text
  );
  assert.equal(nodes.every((n) => n.irreversible), true, 'nothing on a payment page is assumed reversible');

  // And the flag does not leak into the next read.
  const after = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  assert.equal(after.find((n) => n.name === 'Cancel').irreversible, false);
});

test('static content is never marked, whatever it says', async () => {
  const { call } = loadPage('<!doctype html><body><h1>Delete your account</h1><p>Send us a note.</p></body>');
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  assert.equal(nodes.some((n) => n.irreversible), false);
});
