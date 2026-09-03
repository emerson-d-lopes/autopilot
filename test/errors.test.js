// The call contract: the error catalogue, the result shape and the retry table.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODES,
  CODE_NAMES,
  EFFECTS,
  toError,
  fromThrown,
  wrapResult,
  classifyMessage,
  retryDecision,
  retryTable,
  isReadCall,
  defaultEffects,
  newCallId,
  contractLine,
  formatError,
  MAX_ATTEMPTS,
  ERROR_CODES,
  ToolError,
  ToolFailure,
  toolError,
  isToolError,
  withCode,
  codeForMessage,
} from '../host/errors.js';
import { TOOLS } from '../host/schemas.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The nineteen codes Phase 1 names, plus the three this track added.
const PLAN_CODES = [
  'tab_gone', 'tab_replaced', 'attach_refused', 'attach_recovered', 'renderer_throttled', 'dialog_open',
  'ref_stale', 'ref_covered', 'element_disabled', 'no_effect', 'nav_failed', 'origin_changed', 'origin_blocked',
  'confirmation_required', 'host_lost', 'timeout', 'output_truncated', 'browser_unknown', 'profile_ambiguous',
];

test('the catalogue carries every code the plan names', () => {
  for (const code of PLAN_CODES) {
    assert.ok(CODES[code], 'missing code ' + code);
  }
  assert.ok(CODE_NAMES.includes('tab_foreign'), 'a tab outside the session needs its own code');
  assert.ok(CODE_NAMES.includes('bad_request'));
  assert.ok(CODE_NAMES.includes('internal'));
});

test('every entry has a message, a hint, a side-effect flag and a retryable flag', () => {
  for (const [name, entry] of Object.entries(CODES)) {
    assert.ok(entry.message && entry.message.length > 10, name + ' has no message');
    assert.ok(entry.hint && entry.hint.length > 10, name + ' has no hint');
    assert.ok(EFFECTS.includes(entry.effects), name + ' has effects ' + entry.effects);
    assert.equal(typeof entry.retryable, 'boolean', name + ' has no retryable flag');
  }
});

test('toError fills the hint template from the extra fields', () => {
  const error = toError('tab_replaced', { newTabId: 91, oldTabId: 7 });
  assert.equal(error.code, 'tab_replaced');
  assert.match(error.hint, /tab 91/);
  assert.equal(error.oldTabId, 7);
  assert.equal(error.effects, 'unknown');
  assert.equal(error.retryable, false);
  assert.equal(error.cause, null);
});

test('an unlisted code lands on internal and says which code was asked for', () => {
  const error = toError('not_a_code', { message: 'odd' });
  assert.equal(error.code, 'internal');
  assert.equal(error.unknownCode, 'not_a_code');
  assert.equal(error.message, 'odd');
});

test('the matcher table maps the messages the extension produces today', () => {
  const cases = [
    ['ref ref_9 is no longer on the page. Re-read the page.', 'ref_stale'],
    ['Element ref_3 is covered by div.overlay at the point a click would land, so the click would go to that instead.', 'ref_covered'],
    ['Element ref_4 is disabled, so a click on it does nothing. Enable it first.', 'element_disabled'],
    ['No tab with id 12. It may have been closed. Call tabs_context to list current tabs.', 'tab_gone'],
    ["Tab 12 is not in this session's tab group. Call tabs_context to list the tabs this session owns.", 'tab_foreign'],
    ['Navigation to https://a.example failed: net::ERR_NAME_NOT_RESOLVED. The tab is showing an error page, not the site.', 'nav_failed'],
    ['Cannot access a chrome-extension:// URL of different extension', 'attach_refused'],
    ['Cannot read tab 3. Chrome blocks extensions on chrome://, edge://, the Web Store, and other restricted pages.', 'origin_blocked'],
    ['Browser did not respond within 120s.', 'timeout'],
    ['Connection to the browser bridge closed.', 'host_lost'],
    ['computer requires an action', 'bad_request'],
  ];
  for (const [message, code] of cases) {
    assert.equal(classifyMessage(message), code, message);
  }
  assert.equal(classifyMessage('something nobody has seen before'), null);
});

test('a thrown error keeps its message and gains a code', () => {
  const error = fromThrown(new Error('ref ref_2 is no longer on the page. Re-read the page.'), { tool: 'computer' });
  assert.equal(error.code, 'ref_stale');
  assert.match(error.message, /ref_2/);
  assert.equal(error.effects, 'none');
  assert.ok(error.hint);
});

test('a bridge rejection object maps through its kind', () => {
  const error = fromThrown({ message: 'Connection to the browser bridge closed.', kind: 'disconnected' }, { id: 'call_1' });
  assert.equal(error.code, 'host_lost');
  assert.equal(error.id, 'call_1');
  assert.match(error.cause, /disconnected/);
});

test('an unmatched failure still carries the contract fields', () => {
  const error = fromThrown(new Error('who knows'), {});
  assert.equal(error.code, 'internal');
  assert.equal(error.effects, 'unknown');
  assert.equal(error.retryable, false);
  assert.ok(error.hint);
});

test('a read result defaults to effects none, an input result to unknown', () => {
  assert.equal(defaultEffects('read_page'), 'none');
  assert.equal(defaultEffects('computer', { action: 'left_click' }), 'unknown');
  assert.equal(defaultEffects('computer', { action: 'screenshot' }), 'none');
  assert.ok(isReadCall('find'));
  assert.ok(!isReadCall('form_input'));
});

test('wrapResult adds the contract without removing existing fields', () => {
  const wrapped = wrapResult({ url: 'https://a/', title: 'A', nodes: 12, durationMs: 4 }, { tool: 'read_page', id: 'call_9' });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.effects, 'none');
  assert.deepEqual(wrapped.evidence, {});
  assert.deepEqual(wrapped.warnings, []);
  assert.equal(wrapped.id, 'call_9');
  assert.equal(wrapped.url, 'https://a/');
  assert.equal(wrapped.nodes, 12);
  assert.equal(wrapped.durationMs, 4);
});

test('wrapResult keeps effects and evidence the extension already supplied', () => {
  const wrapped = wrapResult(
    { effects: 'applied', evidence: { mutations: 3, focus: 'input#email' }, warnings: ['slow'] },
    { tool: 'computer', args: { action: 'left_click' }, id: 'call_2', warnings: ['from the host'] }
  );
  assert.equal(wrapped.effects, 'applied');
  assert.equal(wrapped.evidence.mutations, 3);
  assert.deepEqual(wrapped.warnings, ['slow', 'from the host']);
});

test('wrapResult gives an input tool unknown effects until the extension says otherwise', () => {
  const wrapped = wrapResult({ durationMs: 8 }, { tool: 'computer', args: { action: 'type' }, id: 'call_3' });
  assert.equal(wrapped.effects, 'unknown');
});

test('wrapResult normalizes a handler that returned nothing', () => {
  const wrapped = wrapResult(undefined, { tool: 'tabs_close', id: 'call_4' });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.effects, 'unknown');
  assert.ok(wrapped.id);
});

test('wrapResult passes a failure through with the error shape intact', () => {
  const wrapped = wrapResult({ ok: false, error: { message: 'ref ref_1 is no longer on the page' } }, { tool: 'computer', id: 'call_5' });
  assert.equal(wrapped.ok, false);
  assert.equal(wrapped.error.code, 'ref_stale');
  assert.equal(wrapped.error.id, 'call_5');
});

test('correlation ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newCallId()));
  assert.equal(ids.size, 200);
  assert.match(newCallId(), /^call_\d+_[a-z0-9]+$/);
});

// --- C4, the retry table -----------------------------------------------------

const throttled = { code: 'renderer_throttled', effects: 'none', retryable: true };
const timeout = { code: 'timeout', effects: 'unknown', retryable: true };
const stale = { code: 'ref_stale', effects: 'none', retryable: false };

test('a read retries up to three attempts on the transient codes', () => {
  assert.equal(retryDecision({ tool: 'read_page', error: throttled, attempt: 1 }).retry, true);
  assert.equal(retryDecision({ tool: 'read_page', error: throttled, attempt: 2 }).retry, true);
  assert.equal(retryDecision({ tool: 'read_page', error: throttled, attempt: 3 }).retry, false);
  assert.equal(MAX_ATTEMPTS.read, 3);
});

test('a read retries on timeout and host_lost even though their effects are unknown', () => {
  // A read cannot have changed anything, so unknown effects do not bar a repeat.
  for (const code of ['timeout', 'host_lost']) {
    const decision = retryDecision({ tool: 'get_page_text', error: { code, effects: 'none', retryable: true }, attempt: 1 });
    assert.equal(decision.retry, true, code);
  }
});

test('a screenshot counts as a read', () => {
  const decision = retryDecision({ tool: 'computer', args: { action: 'screenshot' }, error: throttled, attempt: 1 });
  assert.equal(decision.retry, true);
});

test('a read does not retry a code that is not transient', () => {
  assert.equal(retryDecision({ tool: 'find', error: stale, attempt: 1 }).retry, false);
});

test('an input retries once and only when the error proved nothing happened', () => {
  const once = retryDecision({ tool: 'computer', args: { action: 'left_click' }, error: throttled, attempt: 1 });
  assert.equal(once.retry, true);
  const twice = retryDecision({ tool: 'computer', args: { action: 'left_click' }, error: throttled, attempt: 2 });
  assert.equal(twice.retry, false);
});

test('an input never retries when the effects are unknown or applied', () => {
  for (const effects of ['unknown', 'applied']) {
    const decision = retryDecision({
      tool: 'form_input',
      args: { ref: 'ref_1', value: 'x' },
      error: { ...timeout, effects },
      attempt: 1,
    });
    assert.equal(decision.retry, false, effects);
    assert.match(decision.reason, new RegExp(effects));
  }
});

test('a call carrying confirm is never retried', () => {
  const decision = retryDecision({ tool: 'computer', args: { action: 'left_click', confirm: 'tok_1' }, error: throttled, attempt: 1 });
  assert.equal(decision.retry, false);
  assert.match(decision.reason, /confirm|irreversible/);
});

test('a call flagged irreversible is never retried, read or not', () => {
  const decision = retryDecision({ tool: 'read_page', args: { irreversible: true }, error: throttled, attempt: 1 });
  assert.equal(decision.retry, false);
});

test('the retry table has a row for reads, one for inputs and one for what is never retried', () => {
  const rows = retryTable();
  assert.deepEqual(rows.map((r) => r.kind), ['read', 'input', 'never']);
  assert.ok(rows[0].tools.includes('read_page'));
  assert.ok(rows[0].tools.includes('computer screenshot'));
  assert.ok(rows[0].on.includes('renderer_throttled'));
});

// --- rendering ---------------------------------------------------------------

test('the contract line names ok, effects and the id, and lists warnings', () => {
  const line = contractLine({ ok: true, effects: 'applied', id: 'call_7', evidence: { mutations: 2 }, warnings: ['a', 'b'] });
  assert.match(line, /ok=true/);
  assert.match(line, /effects=applied/);
  assert.match(line, /id=call_7/);
  assert.match(line, /evidence=\{"mutations":2\}/);
  assert.match(line, /- a\n {2}- b/);
});

test('a formatted error carries the code, the hint and the side-effect flag', () => {
  const text = formatError(toError('ref_stale', { id: 'call_8', cause: 'the page reflowed' }));
  assert.match(text, /code=ref_stale/);
  assert.match(text, /effects=none/);
  assert.match(text, /retryable=false/);
  assert.match(text, /id=call_8/);
  assert.match(text, /hint: /);
  assert.match(text, /cause: the page reflowed/);
});

// --- schemas -----------------------------------------------------------------

test('every tool description says what the result looks like', () => {
  for (const tool of TOOLS) {
    assert.match(tool.description, /Result: ok true/, tool.name + ' does not describe its result');
    assert.match(tool.description, /error \{code, message, cause, hint, effects, retryable\}/, tool.name);
  }
  const js = TOOLS.find((t) => t.name === 'javascript');
  assert.match(js.description, /50 KB/);
  assert.match(js.description, /redacted by shape/);
  const net = TOOLS.find((t) => t.name === 'read_network_requests');
  assert.match(net.description, /300 characters/);
  assert.match(net.description, /total alongside returned/);
});

// --- the merged catalogue ----------------------------------------------------

test('the codes the three tracks added are in the catalogue, with no duplicates', () => {
  for (const code of ['batch_invalid', 'element_readonly', 'not_a_form_control', 'tab_foreign', 'bad_request', 'internal']) {
    assert.ok(CODE_NAMES.includes(code), code + ' is missing');
  }
  // invalid_argument folded into bad_request, unknown_failure into internal.
  assert.ok(!CODE_NAMES.includes('invalid_argument'));
  assert.ok(!CODE_NAMES.includes('unknown_failure'));
  assert.equal(new Set(CODE_NAMES).size, CODE_NAMES.length, 'a code is listed twice');
  assert.equal(ERROR_CODES, CODES, 'ERROR_CODES is the same table under the extension track name');
});

test('ToolError carries the contract fields and ToolFailure is the same class', () => {
  const err = new ToolError('tab_replaced', 'The tab was replaced.', {
    cause: 'four attach attempts were refused',
    details: { oldTabId: 4, newTabId: 9 },
    warnings: ['form input is gone'],
  });
  assert.ok(err instanceof Error);
  assert.ok(isToolError(err));
  assert.equal(ToolFailure, ToolError);
  assert.ok(new ToolFailure('browser_unknown', 'none connected') instanceof ToolError);

  const body = err.toJSON();
  assert.deepEqual(body, {
    code: 'tab_replaced',
    message: 'The tab was replaced.',
    cause: 'four attach attempts were refused',
    hint: CODES.tab_replaced.hint,
    effects: 'unknown',
    retryable: false,
    details: { oldTabId: 4, newTabId: 9 },
    warnings: ['form input is gone'],
  });
  // The profile track reads err.error, so the getter returns the same body.
  assert.deepEqual(err.error, body);
  assert.equal(toolError('ref_stale', 'gone').code, 'ref_stale');
});

test('withCode leaves a coded failure alone and classifies a bare one', () => {
  const coded = new ToolError('ref_covered', 'ref_2 is covered.');
  assert.equal(withCode(coded, 'internal'), coded);

  const bare = withCode(new Error('Element ref_3 is read-only, so its value cannot be set.'), 'internal');
  assert.equal(bare.code, 'element_readonly');
  assert.equal(codeForMessage('button ref_9 is disabled'), 'element_disabled');

  const unmatched = withCode(new Error('nothing in the table matches this'), 'internal', { effects: 'unknown' });
  assert.equal(unmatched.code, 'internal');
  assert.equal(unmatched.effects, 'unknown');
});

test('a coded failure passes through fromThrown without being re-classified', () => {
  // The extension raises a ToolError, background.js serializes it, and the
  // host must not read the message back through the matcher table.
  const thrown = new ToolError('no_effect', 'The click landed on a tab that may have been closed.', {
    cause: 'the watch saw nothing move',
    hint: 'Read the page again before deciding the click failed.',
    details: { windowMs: 250 },
    warnings: ['no observable change within 250ms'],
  });
  // tab_gone is what the message alone would match, which is the wrong answer.
  assert.equal(classifyMessage(thrown.message), 'tab_gone');

  const direct = fromThrown(thrown, { id: 'call_1', tool: 'computer' });
  assert.equal(direct.code, 'no_effect');
  assert.equal(direct.message, thrown.message);
  assert.equal(direct.cause, 'the watch saw nothing move');
  assert.equal(direct.hint, 'Read the page again before deciding the click failed.');
  assert.deepEqual(direct.details, { windowMs: 250 });
  assert.deepEqual(direct.warnings, ['no observable change within 250ms']);
  assert.equal(direct.id, 'call_1');

  // The same failure after a round trip through the native port.
  const wire = { kind: 'tool_error', ...thrown.toJSON() };
  const overWire = fromThrown(wire, { id: 'call_2', tool: 'computer' });
  assert.equal(overWire.code, 'no_effect');
  assert.equal(overWire.message, thrown.message);
  assert.equal(overWire.effects, 'none');
  assert.deepEqual(overWire.details, { windowMs: 250 });
  assert.equal(overWire.kind, undefined, 'the transport kind does not leak into the contract error');
});

test('effects and evidence a handler supplied survive wrapResult', () => {
  const result = wrapResult(
    {
      effects: 'applied',
      evidence: { mutations: 3, navigation: { started: true } },
      warnings: ['the composer was empty'],
      value: 'ok',
    },
    { tool: 'computer', args: { tabId: 1, action: 'left_click' }, id: 'call_3' }
  );
  assert.equal(result.effects, 'applied', 'an input tool that verified its work is not downgraded to unknown');
  assert.deepEqual(result.evidence, { mutations: 3, navigation: { started: true } });
  assert.deepEqual(result.warnings, ['the composer was empty']);
  assert.equal(result.value, 'ok');
  assert.equal(result.id, 'call_3');

  // The default only fills in for a handler that said nothing.
  assert.equal(wrapResult({}, { tool: 'computer', args: { action: 'left_click' } }).effects, 'unknown');
  assert.equal(wrapResult({ effects: 'none' }, { tool: 'form_input', args: {} }).effects, 'none');
});

// --- the copy the extension imports -----------------------------------------

test('extension/src/lib/errors.js is still a copy of host/errors.js', () => {
  const body = (path) =>
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
      .trim();
  assert.equal(
    body(join(ROOT, 'extension', 'src', 'lib', 'errors.js')),
    body(join(ROOT, 'host', 'errors.js')),
    'the copy has drifted; re-copy host/errors.js over it'
  );
});
