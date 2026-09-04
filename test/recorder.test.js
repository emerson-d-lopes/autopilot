// Console capture is opt-in per tab (D1).
//
// `Runtime.enable` is the signal a production detector reads to decide the
// browser is being driven through the DevTools protocol, and only the console
// needs it. These cover which domains a tab gets when it joins a session, when
// Runtime goes on and off, the warning the first read owes the caller, and the
// setting that restores the old always-on behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, resetStorage } from './chrome-stub.js';

installChromeStub();

const recorder = await import('../extension/src/lib/recorder.js');
const cdp = await import('../extension/src/lib/cdp.js');

/** Replaces the debugger stub with one that records every method sent. */
function recordDebugger() {
  const sent = [];
  globalThis.chrome.debugger = {
    attach(_target, _version, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_target, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_target, method, _params, done) {
      sent.push(method);
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };
  return sent;
}

/** A fresh tab id per test, since the buffers and attachments are module state. */
let nextTab = 900;
async function freshTab() {
  const tabId = nextTab++;
  recorder.clearTab(tabId);
  return tabId;
}

test.afterEach(async () => {
  await cdp.detachAll();
  resetStorage();
});

test('a tab joins the session without Runtime.enable', async () => {
  const sent = recordDebugger();
  const tabId = await freshTab();

  await recorder.startCapture(tabId);

  assert.ok(sent.includes('Log.enable'), 'Log carries browser-level entries and stays on');
  assert.ok(sent.includes('Network.enable'), 'network capture stays on');
  assert.ok(sent.includes('Page.enable'));
  assert.ok(sent.includes('DOM.enable'));
  assert.equal(
    sent.includes('Runtime.enable'),
    false,
    'the domain a CDP detector reads is not enabled until the console is asked for'
  );
  assert.equal(recorder.isConsoleCapturing(tabId), false);
});

test('the first console read enables Runtime and says capture started late', async () => {
  const sent = recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  sent.length = 0;

  const first = await recorder.readConsoleMessages(tabId, {});

  assert.deepEqual(sent, ['Runtime.enable'], 'exactly one domain is enabled, on the read that needs it');
  assert.equal(recorder.isConsoleCapturing(tabId), true);
  assert.equal(first.consoleCapturing, true);
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /console capture started with this call/);
  assert.match(first.warnings[0], /options/, 'and points at the setting that restores the old behaviour');

  sent.length = 0;
  const second = await recorder.readConsoleMessages(tabId, {});
  assert.deepEqual(sent, [], 'a second read enables nothing');
  assert.deepEqual(second.warnings, [], 'and does not repeat the notice');
});

test('a read that clears the buffer turns Runtime off again', async () => {
  const sent = recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  await recorder.readConsoleMessages(tabId, {});
  sent.length = 0;

  const result = await recorder.readConsoleMessages(tabId, { clear: true });

  assert.deepEqual(sent, ['Runtime.disable']);
  assert.equal(recorder.isConsoleCapturing(tabId), false);
  assert.equal(result.consoleCapturing, false);
  assert.ok(
    result.warnings.some((w) => /turned off again/.test(w)),
    'the result says the tab is no longer capturing'
  );

  sent.length = 0;
  await recorder.readConsoleMessages(tabId, {});
  assert.deepEqual(sent, ['Runtime.enable'], 'and the next read turns it back on');
});

test('only_errors warns that exceptions thrown before capture were not seen', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);

  const first = await recorder.readConsoleMessages(tabId, { onlyErrors: true });
  assert.ok(
    first.warnings.some((w) => /uncaught exceptions need console capture/.test(w)),
    'an uncaught exception needs Runtime, which was off'
  );

  const second = await recorder.readConsoleMessages(tabId, { onlyErrors: true });
  assert.ok(
    second.warnings.some((w) => /uncaught exceptions need console capture/.test(w)),
    'and it stays true for this tab, since the gap does not close'
  );
});

test('a plain read after capture is on carries no warnings', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  await recorder.readConsoleMessages(tabId, {});

  const result = await recorder.readConsoleMessages(tabId, { limit: 10 });
  assert.deepEqual(result.warnings, []);
});

test('the always setting enables Runtime when the tab joins, and keeps it on', async () => {
  await chrome.storage.local.set({ consoleCapture: 'always' });
  const sent = recordDebugger();
  const tabId = await freshTab();

  await recorder.startCapture(tabId);
  assert.ok(sent.includes('Runtime.enable'), 'the old behaviour is one setting away');
  assert.equal(recorder.isConsoleCapturing(tabId), true);

  sent.length = 0;
  const first = await recorder.readConsoleMessages(tabId, { clear: true });
  assert.deepEqual(sent, [], 'nothing is enabled or disabled around the read');
  assert.deepEqual(first.warnings, [], 'and nothing was missed, so there is nothing to warn about');
  assert.equal(recorder.isConsoleCapturing(tabId), true, 'a clear does not disarm what the setting asked for');
});

test('the capture mode defaults to lazy when nothing is stored', async () => {
  assert.equal(await recorder.consoleCaptureMode(), 'lazy');
  await chrome.storage.local.set({ consoleCapture: 'always' });
  assert.equal(await recorder.consoleCaptureMode(), 'always');
  await chrome.storage.local.set({ consoleCapture: 'nonsense' });
  assert.equal(await recorder.consoleCaptureMode(), 'lazy', 'an unknown value is not treated as always');
});

// ---------------------------------------------------------------------------
// Runtime.enable replays the page's console history
// ---------------------------------------------------------------------------

/** One console line, the way Chrome delivers it: milliseconds since the epoch. */
function logLine(tabId, text, at) {
  recorder.onDebuggerEvent({ tabId }, 'Runtime.consoleAPICalled', {
    type: 'log',
    timestamp: at,
    args: [{ type: 'string', value: text }],
  });
}

test('a clearing read stays cleared when Chrome replays the history', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  await recorder.readConsoleMessages(tabId, {});

  const pageLoad = Date.now() - 5000;
  logLine(tabId, 'from page load', pageLoad);
  const before = await recorder.readConsoleMessages(tabId, { clear: true });
  assert.equal(before.total, 1, 'the clearing read returns what was there');

  // The next read re-enables Runtime, and Chrome hands over the same history.
  const read = recorder.readConsoleMessages(tabId, {});
  logLine(tabId, 'from page load', pageLoad);
  const after = await read;
  assert.equal(after.total, 0, 'the replayed copy is dropped, so the clear held');

  logLine(tabId, 'after the clear', Date.now() + 1);
  const third = await recorder.readConsoleMessages(tabId, {});
  assert.equal(third.total, 1, 'live output after the clear is still captured');
  assert.equal(third.entries[0].text, 'after the clear');
});

test('the read that re-arms capture after a clear says the replay is filtered', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  await recorder.readConsoleMessages(tabId, { clear: true });

  const result = await recorder.readConsoleMessages(tabId, {});
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /filtered out/);
  assert.doesNotMatch(result.warnings[0], /were not recorded/);
});

test('a first read that got replayed history says so instead of claiming it was lost', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);

  // The read arms Runtime, and the history arrives while it is in flight.
  const pending = recorder.readConsoleMessages(tabId, {});
  logLine(tabId, 'pre-arm-unique-42', Date.now() - 2000);
  const result = await pending;

  assert.equal(result.total, 1, 'the replayed line is returned');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /replayed the console history/);
  assert.doesNotMatch(result.warnings[0], /were not recorded/, 'the old claim contradicted the same result');
});

test('an entry with no epoch timestamp is never dropped by the clear filter', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  await recorder.readConsoleMessages(tabId, { clear: true });
  await recorder.readConsoleMessages(tabId, {});

  // The navigation marker stamps seconds, which cannot be judged against a
  // wall clock reading in milliseconds.
  recorder.noteNavigation(tabId, 'https://example.com/');
  const result = await recorder.readConsoleMessages(tabId, {});
  assert.equal(result.total, 1);
});

test('a console message still lands in the buffer once capture is on', async () => {
  recordDebugger();
  const tabId = await freshTab();
  await recorder.startCapture(tabId);
  await recorder.readConsoleMessages(tabId, {});

  recorder.noteNavigation(tabId, 'https://example.com/');
  const result = await recorder.readConsoleMessages(tabId, {});
  assert.equal(result.total, 1);
  assert.match(result.entries[0].text, /navigated to https:\/\/example\.com\//);
});
