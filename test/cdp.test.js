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

// ---------------------------------------------------------------------------
// Refused attach: recovery, the replacement ladder, dialogs and freezes
// ---------------------------------------------------------------------------

/**
 * A debugger whose attach refuses the first `refusals` calls with the message
 * Chrome raises when another extension holds a frame in the tab.
 */
function scriptRefusingAttach({ refusals = 2, message = STALE } = {}) {
  const calls = [];
  let left = refusals;

  globalThis.chrome.debugger = {
    attach(_target, _version, done) {
      calls.push('attach');
      chrome.runtime.lastError = left-- > 0 ? { message } : null;
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
      chrome.runtime.lastError = null;
      done({ ok: true, method });
      chrome.runtime.lastError = null;
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };
  return calls;
}

/** Frame tree and injection stubs for the recovery walk. */
function scriptPageWalk({ iframeCount = 1, removed = ['chrome-extension://otherextensionidaaaa/inject.html'] } = {}) {
  const injections = [];
  chrome.webNavigation = {
    async getAllFrames() {
      return [{ frameId: 0, parentFrameId: -1, url: 'https://x.test/home' }];
    },
  };
  chrome.scripting = {
    async executeScript(details) {
      injections.push(details);
      // The removal pass is the one carrying the extension id as an argument.
      if (details.args) return [{ frameId: 0, result: removed }];
      return [{ frameId: 0, result: { count: iframeCount, url: 'https://x.test/home' } }];
    },
  };
  return injections;
}

test('a refused attach is recovered by removing another extension iframe', async () => {
  const calls = scriptRefusingAttach({ refusals: 2 });
  const injections = scriptPageWalk();
  await chrome.storage.local.clear();

  cdp.beginCall();
  const result = await cdp.attach(20);
  const notes = cdp.endCall();

  assert.equal(result.recovered, true, 'the attach is reported as recovered');
  assert.equal(result.attempts, 2, 'it took two passes');
  assert.deepEqual(result.removed, [
    'chrome-extension://otherextensionidaaaa/inject.html',
    'chrome-extension://otherextensionidaaaa/inject.html',
  ]);
  assert.equal(cdp.isAttached(20), true);
  assert.equal(calls.filter((c) => c === 'attach').length, 3, 'refused twice, accepted on the third');
  assert.equal(injections.length, 4, 'each pass counts the iframes then removes the foreign ones');
  assert.equal(injections[0].target.allFrames, true, 'the count walks every frame');
  assert.deepEqual(injections[1].target.frameIds, [0], 'the removal only runs in the frames holding an extra iframe');

  const warning = notes.find((n) => n.code === 'attach_recovered');
  assert.ok(warning, 'attach_recovered is raised as a warning on the call');
  assert.match(warning.message, /removed 2 extension iframes/);
  await cdp.detachAll();
  delete chrome.webNavigation;
});

test('a frame holding no more iframes than Chrome knows about is left alone', async () => {
  scriptRefusingAttach({ refusals: 1 });
  const injections = scriptPageWalk({ iframeCount: 0 });
  await chrome.storage.local.clear();

  cdp.beginCall();
  await cdp.attach(21);
  cdp.endCall();

  assert.equal(injections.length, 1, 'the count ran, the removal did not');
  await cdp.detachAll();
  delete chrome.webNavigation;
});

test('the recovery is skipped when the storage kill switch is off', async () => {
  const calls = scriptRefusingAttach({ refusals: 1 });
  const injections = scriptPageWalk();
  await chrome.storage.local.set({ attachRecovery: false });

  cdp.beginCall();
  const result = await cdp.attach(22);
  cdp.endCall();

  assert.equal(injections.length, 0, 'no page walk was attempted');
  assert.equal(calls.filter((c) => c === 'detach').length, 1, 'the ladder went straight to the detach rung');
  assert.equal(result.recovered, true, 'the detach and re-attach still recovered the tab');
  await chrome.storage.local.clear();
  await cdp.detachAll();
  delete chrome.webNavigation;
});

test('a tab that stays refused is replaced and the call returns tab_replaced', async () => {
  scriptRefusingAttach({ refusals: 99 });
  scriptPageWalk();
  await chrome.storage.local.clear();
  const asked = [];
  cdp.setSessionReplacer(async (tabId) => {
    asked.push(tabId);
    return { oldTabId: tabId, newTabId: 4242, url: 'https://x.test/home' };
  });

  await assert.rejects(
    () => cdp.attach(23),
    (err) => {
      assert.equal(err.code, 'tab_replaced');
      assert.equal(err.effects, 'none');
      assert.equal(err.retryable, true);
      assert.deepEqual(err.details, { oldTabId: 23, newTabId: 4242, url: 'https://x.test/home' });
      assert.match(err.hint, /Page state such as form input/);
      assert.deepEqual(err.warnings, ['page state such as form input and scroll position is gone']);
      return true;
    }
  );
  assert.deepEqual(asked, [23], 'the replacement was asked for once');
  cdp.setSessionReplacer(null);
  delete chrome.webNavigation;
});

test('a tab outside any session is refused with attach_refused and the frame list', async () => {
  scriptRefusingAttach({ refusals: 99 });
  scriptPageWalk();
  await chrome.storage.local.clear();
  cdp.setSessionReplacer(async () => null);

  await assert.rejects(
    () => cdp.attach(24),
    (err) => {
      assert.equal(err.code, 'attach_refused');
      assert.equal(err.retryable, false);
      assert.match(err.message, /Frames: top https:\/\/x\.test\/home/);
      return true;
    }
  );
  cdp.setSessionReplacer(null);
  delete chrome.webNavigation;
});

test('a debugger already attached by DevTools is an error, not a silent success', async () => {
  scriptRefusingAttach({ refusals: 99, message: 'Another debugger is already attached to the tab with id: 25.' });

  await assert.rejects(
    () => cdp.attach(25),
    (err) => {
      assert.equal(err.code, 'attach_refused');
      assert.equal(
        err.message,
        'chrome.debugger.attach refused on tab 25: another debugger is attached. Close DevTools on that tab.'
      );
      return true;
    }
  );
  assert.equal(cdp.isAttached(25), false, 'nothing was recorded as attached');
});

test('dialogs are answered by type and reported on the call in flight', async () => {
  const handled = [];
  let fire = null;
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(target, method, params, done) {
      if (method === 'Page.handleJavaScriptDialog') handled.push({ tabId: target.tabId, accept: params.accept });
      chrome.runtime.lastError = null;
      done({});
      chrome.runtime.lastError = null;
    },
    onEvent: {
      addListener(fn) {
        fire = fn;
      },
      removeListener() {},
    },
    onDetach: { addListener() {} },
  };
  cdp.installDialogListener();
  assert.ok(fire, 'the dialog listener is installed');

  cdp.beginCall();
  fire({ tabId: 30 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'saved' });
  fire({ tabId: 30 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'delete everything?' });
  fire({ tabId: 30 }, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'your name?' });
  const notes = cdp.endCall();

  assert.deepEqual(
    handled,
    [
      { tabId: 30, accept: true },
      { tabId: 30, accept: false },
      { tabId: 30, accept: false },
    ],
    'alert is accepted, confirm and prompt are dismissed'
  );
  assert.deepEqual(
    notes.map((n) => [n.dialog.type, n.dialog.handled, n.dialog.message]),
    [
      ['alert', 'accepted', 'saved'],
      ['confirm', 'dismissed', 'delete everything?'],
      ['prompt', 'dismissed', 'your name?'],
    ]
  );

  // beforeunload follows the per-tab policy, and defaults to staying put.
  cdp.beginCall();
  fire({ tabId: 31 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: 'Leave site?' });
  const stay = cdp.takeBeforeunloadDialog(31);
  assert.equal(stay.handled, 'dismissed');
  assert.equal(cdp.takeBeforeunloadDialog(31), null, 'reading it clears it');
  cdp.setBeforeunloadPolicy(31, 'accept');
  fire({ tabId: 31 }, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: 'Leave site?' });
  assert.equal(cdp.takeBeforeunloadDialog(31).handled, 'accepted', 'force lets the navigation through');
  cdp.endCall();

  const err = cdp.dialogOpenError(31, 'https://b.test/', stay);
  assert.equal(err.code, 'dialog_open');
  assert.match(err.message, /Leave site\?/);
  assert.match(err.hint, /force: true/);
});

test('a dialog with no call in flight lands on the next call', async () => {
  let fire = null;
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_t, _m, _p, done) {
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener: (fn) => (fire = fn), removeListener() {} },
    onDetach: { addListener() {} },
  };
  cdp.installDialogListener();
  cdp.endCall();

  fire({ tabId: 32 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'a page timer fired' });
  cdp.beginCall();
  const notes = cdp.endCall();
  assert.equal(notes.length, 1, 'the orphan note was carried into the next call');
  assert.equal(notes[0].dialog.message, 'a page timer fired');
});

test('a command that does not answer wakes the tab and is sent once more', async () => {
  const calls = [];
  let stall = 1;
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_t, method, _p, done) {
      calls.push(method);
      if (method === 'DOM.getDocument' && stall-- > 0) return; // the renderer never answers
      chrome.runtime.lastError = null;
      done({ ok: true, method });
      chrome.runtime.lastError = null;
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };

  await cdp.attach(33);
  const result = await cdp.send(33, 'DOM.getDocument', {}, { timeout: 40 });
  assert.deepEqual(result, { ok: true, method: 'DOM.getDocument' });
  assert.ok(calls.includes('Emulation.setFocusEmulationEnabled'), 'the tab was woken before the retry');
  assert.equal(calls.filter((c) => c === 'DOM.getDocument').length, 2, 'sent once, then once more');
  await cdp.detachAll();
});

test('a renderer that stays frozen returns timeout with the reload hint', async () => {
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_t, method, _p, done) {
      if (method === 'DOM.getDocument') return;
      chrome.runtime.lastError = null;
      done({});
      chrome.runtime.lastError = null;
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };

  await cdp.attach(34);
  await assert.rejects(
    () => cdp.send(34, 'DOM.getDocument', {}, { timeout: 30 }),
    (err) => {
      assert.equal(err.code, 'timeout');
      assert.equal(err.hint, 'the renderer did not respond, reload the tab with navigate');
      assert.equal(err.effects, 'unknown');
      assert.match(err.message, /did not answer within 30ms on tab 34/);
      return true;
    }
  );
  await cdp.detachAll();
});

test('an input event is woken but never dispatched twice', async () => {
  const calls = [];
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_t, method, _p, done) {
      calls.push(method);
      if (method === 'Input.dispatchKeyEvent') return;
      chrome.runtime.lastError = null;
      done({});
      chrome.runtime.lastError = null;
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };

  await cdp.attach(35);
  await assert.rejects(() => cdp.send(35, 'Input.dispatchKeyEvent', {}, { timeout: 30 }), /did not answer/);
  assert.equal(calls.filter((c) => c === 'Input.dispatchKeyEvent').length, 1, 'a keystroke is never sent again');
  assert.ok(calls.includes('Emulation.setFocusEmulationEnabled'), 'the tab is still woken');
  await cdp.detachAll();
});
