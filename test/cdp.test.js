// Debugger transport behaviour.
//
// A browser with other extensions installed can leave the debugger session
// bound to a target Chrome then refuses, and every command fails with a message
// about a chrome-extension URL belonging to a different extension even though
// the tab is on an ordinary site. These cover the recovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

installChromeStub();

const cdp = await import('../extension/src/lib/cdp.js');

/** Replaces the debugger stub with a scripted one and returns a call log. */
function scriptDebugger({ failures = {}, attachError = null } = {}) {
  const calls = [];
  const seen = {};

  globalThis.chrome.debugger = {
    attach(_target, _version, done) {
      calls.push('attach');
      chrome.runtime.lastError = attachError ? { message: attachError } : null;
      done();
      chrome.runtime.lastError = null;
    },
    detach(_target, done) {
      calls.push('detach');
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_target, method, _params, done) {
      calls.push(method);
      seen[method] = (seen[method] || 0) + 1;

      const failure = failures[method];
      const shouldFail = failure && seen[method] <= failure.times;
      chrome.runtime.lastError = shouldFail ? { message: failure.message } : null;
      done(shouldFail ? undefined : { ok: true, method });
      chrome.runtime.lastError = null;
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };

  return calls;
}

const STALE = 'Cannot access a chrome-extension:// URL of different extension';

test('a stale attachment is re-established and the command retried', async () => {
  const calls = scriptDebugger({
    failures: { 'Page.getLayoutMetrics': { times: 1, message: STALE } },
  });

  await cdp.attach(1);
  const result = await cdp.send(1, 'Page.getLayoutMetrics');

  assert.deepEqual(result, { ok: true, method: 'Page.getLayoutMetrics' }, 'the retry returned the real result');
  assert.equal(calls.filter((c) => c === 'detach').length, 1, 'the stale session was dropped');
  assert.equal(calls.filter((c) => c === 'attach').length, 2, 'and re-established');
  assert.equal(
    calls.filter((c) => c === 'Page.getLayoutMetrics').length,
    2,
    'the command ran once before the recovery and once after'
  );
  assert.ok(calls.includes('Runtime.enable'), 'capture domains are re-enabled after re-attaching');
  await cdp.detachAll();
});

test('an ordinary protocol error is not retried', async () => {
  const calls = scriptDebugger({
    failures: { 'Input.dispatchMouseEvent': { times: 5, message: 'Invalid parameters' } },
  });

  await cdp.attach(2);
  await assert.rejects(() => cdp.send(2, 'Input.dispatchMouseEvent', {}), /Invalid parameters/);

  assert.equal(calls.filter((c) => c === 'detach').length, 0, 'a real error does not tear down the session');
  assert.equal(calls.filter((c) => c === 'Input.dispatchMouseEvent').length, 1, 'and is not retried');
  await cdp.detachAll();
});

test('a command that keeps failing surfaces the error rather than looping', async () => {
  scriptDebugger({ failures: { 'Page.captureScreenshot': { times: 10, message: STALE } } });

  await cdp.attach(3);
  await assert.rejects(() => cdp.send(3, 'Page.captureScreenshot'), /chrome-extension/);
  await cdp.detachAll();
});

test('every recognised stale message triggers recovery', async () => {
  const messages = [
    'Cannot access a chrome-extension:// URL of different extension',
    'Detached while handling command',
    'No target with given id found',
    'Inspected target navigated or closed',
    'Not attached to an active page',
  ];

  for (const [index, message] of messages.entries()) {
    const tabId = 100 + index;
    const calls = scriptDebugger({ failures: { 'DOM.getDocument': { times: 1, message } } });
    await cdp.attach(tabId);
    await cdp.send(tabId, 'DOM.getDocument');
    assert.equal(calls.filter((c) => c === 'detach').length, 1, 'recovered from: ' + message);
    await cdp.detachAll();
  }
});

test('enableDomains does not recurse through the retry path', async () => {
  const calls = scriptDebugger({ failures: { 'Network.enable': { times: 3, message: STALE } } });

  await cdp.attach(4);
  await cdp.enableDomains(4, ['Network']);

  assert.equal(calls.filter((c) => c === 'detach').length, 0, 'enabling a domain never re-attaches');
  assert.equal(calls.filter((c) => c === 'Network.enable').length, 1);
  await cdp.detachAll();
});

test('"Debugger is not attached" is treated as a stale attachment', async () => {
  const calls = scriptDebugger({
    failures: { 'Input.dispatchMouseEvent': { times: 1, message: 'Debugger is not attached to the tab with id: 5.' } },
  });
  await cdp.attach(5);
  await cdp.send(5, 'Input.dispatchMouseEvent', {});
  assert.equal(calls.filter((c) => c === 'attach').length, 2, 're-attached');
  await cdp.detachAll();
});

test('a detach reported by Chrome clears the attachment so the next call re-attaches', async () => {
  const calls = scriptDebugger();
  let onDetach = null;
  chrome.debugger.onDetach = {
    addListener(fn) {
      onDetach = fn;
    },
  };
  await cdp.attach(6);
  await cdp.send(6, 'Page.getLayoutMetrics');
  assert.ok(onDetach, 'a detach listener is installed');
  assert.ok(cdp.isAttached(6));
  onDetach({ tabId: 6 }, 'target_closed');
  assert.equal(cdp.isAttached(6), false, 'the map no longer claims the tab is attached');
  await cdp.attach(6);
  assert.equal(calls.filter((c) => c === 'attach').length, 2, 'attach went to Chrome again rather than bumping a refcount');
  await cdp.detachAll();
});

test('a persistent foreign-extension error names the frames in the tab', async () => {
  scriptDebugger({ failures: { 'Page.captureScreenshot': { times: 10, message: STALE } } });
  chrome.webNavigation = {
    async getAllFrames() {
      return [
        { frameId: 0, parentFrameId: -1, url: 'https://example.com/' },
        { frameId: 7, parentFrameId: 0, url: 'chrome-extension://abcdefghijklmnop/menu.html' },
      ];
    },
  };
  await cdp.attach(7);
  await assert.rejects(
    () => cdp.send(7, 'Page.captureScreenshot'),
    (err) => /abcdefghijklmnop/.test(err.message) && /top https:\/\/example\.com/.test(err.message)
  );
  delete chrome.webNavigation;
  await cdp.detachAll();
});

test('a refused attach names the frames and debugger targets in the tab', async () => {
  scriptDebugger({ attachError: STALE });
  chrome.debugger.getTargets = async () => [
    { type: 'page', tabId: 8, url: 'https://example.com/' },
    { type: 'other', url: 'chrome-extension://qrstuvwxyzabcdef/offscreen.html' },
  ];
  chrome.webNavigation = {
    async getAllFrames() {
      return [{ frameId: 0, parentFrameId: -1, url: 'https://example.com/' }];
    },
  };
  await assert.rejects(
    () => cdp.attach(8),
    (err) => /Frames: top https:\/\/example\.com/.test(err.message) && /other\* chrome-extension:\/\/qrstuvwxyzabcdef/.test(err.message)
  );
  assert.equal(cdp.isAttached(8), false);
  delete chrome.webNavigation;
});

test('wake sets focus emulation and an active lifecycle state once per attachment', async () => {
  const calls = scriptDebugger();
  await cdp.attach(9);
  await cdp.wake(9);
  await cdp.wake(9);
  assert.equal(calls.filter((c) => c === 'Emulation.setFocusEmulationEnabled').length, 1);
  assert.equal(calls.filter((c) => c === 'Page.setWebLifecycleState').length, 1);
  await cdp.wake(9, { force: true });
  assert.equal(calls.filter((c) => c === 'Emulation.setFocusEmulationEnabled').length, 2, 'force repeats it');
  await cdp.detachAll();
  await cdp.attach(9);
  await cdp.wake(9);
  assert.equal(calls.filter((c) => c === 'Emulation.setFocusEmulationEnabled').length, 3, 'a new attachment is woken again');
  await cdp.detachAll();
});

test('a hidden tab is captured through one screencast frame', async () => {
  const calls = scriptDebugger();
  const listeners = [];
  chrome.debugger.onEvent = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
  };
  const plainSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (target, method, params, done) => {
    if (method === 'Page.getLayoutMetrics') {
      calls.push(method);
      chrome.runtime.lastError = null;
      done({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } });
      return;
    }
    if (method === 'Page.startScreencast') {
      calls.push(method);
      assert.equal(params.maxWidth, 800);
      assert.equal(params.maxHeight, 600);
      chrome.runtime.lastError = null;
      done({});
      setTimeout(() => listeners.slice().forEach((fn) => fn({ tabId: 12 }, 'Page.screencastFrame', { data: 'FRAME', sessionId: 1 })), 5);
      return;
    }
    plainSend(target, method, params, done);
  };
  chrome.tabs.get = async () => ({ id: 12, active: false, windowId: 1 });
  await cdp.attach(12);
  const data = await cdp.captureScreenshot(12, { format: 'png' });
  assert.equal(data, 'FRAME');
  assert.ok(calls.includes('Page.startScreencast'));
  assert.ok(calls.includes('Page.stopScreencast'), 'the screencast is stopped after the frame');
  assert.ok(!calls.includes('Page.captureScreenshot'), 'no surface capture was attempted');
  assert.equal(listeners.length, 0, 'the frame listener is removed');
  await cdp.detachAll();
});
