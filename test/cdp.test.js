// Debugger transport behaviour.
//
// A browser with other extensions installed can leave the debugger session
// bound to a target Chrome then refuses, and every command fails with a message
// about a chrome-extension URL belonging to a different extension even though
// the tab is on an ordinary site. These cover the recovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.equal(
    calls.filter((c) => c === 'attach').length,
    2,
    'attach went to Chrome again rather than bumping a refcount'
  );
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
    (err) =>
      /Frames: top https:\/\/example\.com/.test(err.message) &&
      /other\* chrome-extension:\/\/qrstuvwxyzabcdef/.test(err.message)
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
  assert.equal(
    calls.filter((c) => c === 'Emulation.setFocusEmulationEnabled').length,
    3,
    'a new attachment is woken again'
  );
  await cdp.detachAll();
});

test('a hidden tab is captured from the renderer, which cannot hold a stale surface', async () => {
  cdp.resetRendererCaptureProbe();
  const calls = scriptDebugger();
  chrome.debugger.onEvent = { addListener: () => {}, removeListener: () => {} };
  let params = null;
  const plainSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (target, method, sent, done) => {
    if (method === 'Page.getLayoutMetrics') {
      chrome.runtime.lastError = null;
      done({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } });
      return;
    }
    if (method === 'Page.captureScreenshot') {
      params = sent;
      calls.push(method);
      chrome.runtime.lastError = null;
      done({ data: 'RENDERER' });
      return;
    }
    plainSend(target, method, sent, done);
  };
  chrome.tabs.get = async () => ({ id: 14, active: false, windowId: 1 });
  await cdp.attach(14);
  const data = await cdp.captureScreenshot(14, { format: 'png' });
  assert.equal(data, 'RENDERER');
  assert.equal(params.fromSurface, false, 'read from the renderer, not the compositor surface');
  assert.ok(!calls.includes('Page.startScreencast'), 'no screencast is needed when the renderer answers');
  await cdp.detachAll();
});

test('a hidden tab falls back to a screencast frame when the renderer capture is refused', async () => {
  cdp.resetRendererCaptureProbe();
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
    if (method === 'Page.captureScreenshot') {
      chrome.runtime.lastError = { message: 'fromSurface is not supported' };
      done();
      chrome.runtime.lastError = null;
      return;
    }
    if (method === 'Page.startScreencast') {
      calls.push(method);
      assert.equal(params.maxWidth, 800);
      assert.equal(params.maxHeight, 600);
      chrome.runtime.lastError = null;
      done({});
      setTimeout(
        () =>
          listeners.slice().forEach((fn) => fn({ tabId: 12 }, 'Page.screencastFrame', { data: 'FRAME', sessionId: 1 })),
        5
      );
      return;
    }
    plainSend(target, method, params, done);
  };
  chrome.tabs.get = async () => ({ id: 12, active: false, windowId: 1 });
  await cdp.attach(12);
  const data = await cdp.captureScreenshot(12, { format: 'png' });
  assert.equal(data, 'FRAME');
  assert.equal(
    calls.filter((c) => c === 'Page.startScreencast').length,
    2,
    'screencasts are opened until two carry the same image, which an unchanged page reaches on the second'
  );
  assert.ok(calls.includes('Page.stopScreencast'), 'the screencast is stopped after the frame');
  assert.equal(listeners.length, 0, 'the frame listener is removed');
  const wakeIndex = calls.indexOf('Page.setWebLifecycleState');
  assert.ok(wakeIndex !== -1, 'the tab is woken, since a sleeping tab emits no frame at all');
  assert.ok(wakeIndex < calls.indexOf('Page.startScreencast'), 'the wake comes before the screencast');
  await cdp.detachAll();
});

test('a screencast that produces no frame is retried once after a forced wake', async () => {
  cdp.resetRendererCaptureProbe();
  const calls = scriptDebugger();
  const listeners = [];
  chrome.debugger.onEvent = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
  };
  let starts = 0;
  const plainSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (target, method, params, done) => {
    if (method === 'Page.getLayoutMetrics') {
      chrome.runtime.lastError = null;
      done({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } });
      return;
    }
    if (method === 'Page.captureScreenshot') {
      chrome.runtime.lastError = { message: 'fromSurface is not supported' };
      done();
      chrome.runtime.lastError = null;
      return;
    }
    if (method === 'Page.startScreencast') {
      starts++;
      calls.push(method);
      chrome.runtime.lastError = null;
      done({});
      // The first screencast stays silent, which is what a sleeping tab does.
      // Everything after the forced wake answers, and two matching frames end
      // the settle loop.
      if (starts > 1) {
        setTimeout(
          () =>
            listeners
              .slice()
              .forEach((fn) => fn({ tabId: 13 }, 'Page.screencastFrame', { data: 'SECOND', sessionId: 1 })),
          5
        );
      }
      return;
    }
    plainSend(target, method, params, done);
  };
  chrome.tabs.get = async () => ({ id: 13, active: false, windowId: 1 });
  await cdp.attach(13);
  const data = await cdp.captureScreenshot(13, { format: 'png', screencastTimeout: 400 });
  assert.equal(data, 'SECOND');
  assert.ok(starts >= 3, 'silent screencasts cost one attempt each, then two matching ones answer: ' + starts);
  assert.equal(listeners.length, 0, 'both frame listeners are removed');
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

// ---------------------------------------------------------------------------
// D3: the interval between keystrokes is drawn, not held constant
// ---------------------------------------------------------------------------

/** A deterministic stand-in for Math.random that cycles a fixed list. */
function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('every drawn interval lands within 40 percent of the mean', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const delays = cdp.typingDelays(text, 60);

  assert.equal(delays.length, text.length);
  for (const delay of delays) {
    assert.ok(delay >= 36, 'no interval is under the lower bound, got ' + delay);
    assert.ok(delay <= 84, 'no interval is over the upper bound, got ' + delay);
  }
});

test('the drawn intervals vary rather than repeating one value', () => {
  const delays = cdp.typingDelays('x'.repeat(200), 60);
  const distinct = new Set(delays);
  assert.ok(distinct.size > 20, 'a constant cadence is the tell being removed, saw ' + distinct.size + ' values');
});

test('the mean of the drawn intervals sits on the requested cadence', () => {
  // No spaces, so this is the base distribution without the word pause.
  const delays = cdp.typingDelays('x'.repeat(5000), 60);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  assert.ok(Math.abs(mean - 60) < 3, 'mean was ' + mean.toFixed(1));
});

test('a space is sometimes followed by a longer pause', () => {
  // A draw of 0.5 leaves the jitter at the mean. On a space the next draw
  // decides whether a pause is taken and the one after sets its length, so the
  // four-value cycle lines up one pause per space.
  const always = cdp.typingDelays('a b c', 60, sequence([0.5, 0.5, 0, 0]));
  const never = cdp.typingDelays('a b c', 60, () => 0.5);

  assert.deepEqual(never, [60, 60, 60, 60, 60], 'without the pause a space is an ordinary keystroke');
  assert.equal(always[1], 150, 'with it the gap after the space is much longer');
  assert.equal(always[0], 60, 'and a letter is unaffected');
});

test('the last character never carries a word pause', () => {
  // Every draw is 0: the jitter goes to its lower bound, and the pause test
  // passes wherever one is offered.
  const trailing = cdp.typingDelays('ab ', 60, () => 0);
  const inner = cdp.typingDelays('ab c', 60, () => 0);

  assert.equal(inner[2], trailing[2] + 90, 'a space mid-text takes the pause');
  assert.equal(trailing[2], 36, 'a trailing space does not, since the pause would only be dead time');
});

test('500 characters stay inside 1.5 times the measured 0.1.7 duration', () => {
  // The campaign measured perKey at 30911 ms for 500 characters, an interval of
  // 61.8 ms. The drawn intervals are the whole interval, not a delay added to
  // dispatch, so the budget is the sum of the draws.
  const text = 'the quick brown fox jumps over the lazy dog '.repeat(12).slice(0, 500);
  assert.equal(text.length, 500);
  let worst = 0;
  for (let run = 0; run < 200; run++) {
    worst = Math.max(
      worst,
      cdp.typingDelays(text, 60).reduce((a, b) => a + b, 0)
    );
  }
  assert.ok(worst < 30911 * 1.5, 'worst of 200 runs was ' + worst + ' ms');
});

test('a cadence of zero types with no delay at all', () => {
  assert.deepEqual(cdp.typingDelays('abc', 0), [0, 0, 0]);
});

test('a cadence that is not a number falls back to the default', () => {
  const delays = cdp.typingDelays('xxxx', 'fast');
  for (const delay of delays) assert.ok(delay >= 36 && delay <= 84, 'got ' + delay);
});

test('a cadence is clamped so one call cannot stall a session', () => {
  const delays = cdp.typingDelays('xx', 100000);
  for (const delay of delays) assert.ok(delay <= 1400, 'got ' + delay);
});

// ---------------------------------------------------------------------------
// D4: a click is preceded by a path, not a jump
// ---------------------------------------------------------------------------

/**
 * A debugger stub that records every mouse event dispatched, and every wait
 * asked for. `sleep` runs its timer in the page, so the milliseconds requested
 * are readable from the expression it evaluates.
 */
function recordMouse() {
  const events = [];
  events.waits = [];
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_t, method, params, done) {
      if (method === 'Input.dispatchMouseEvent') events.push({ ...params });
      if (method === 'Runtime.evaluate') {
        const ms = /setTimeout\(r, (\d+)\)/.exec(params.expression || '');
        if (ms) events.waits.push(Number(ms[1]));
      }
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };
  return events;
}

const distanceTo = (point, target) => Math.hypot(target.x - point.x, target.y - point.y);

test('a path has between 3 and 6 points and ends on the target', () => {
  for (let run = 0; run < 200; run++) {
    const points = cdp.pointerPath({ x: 10, y: 20 }, { x: 500, y: 340 });
    assert.ok(points.length >= 3 && points.length <= 6, 'got ' + points.length + ' points');
    assert.deepEqual(points[points.length - 1], { x: 500, y: 340 }, 'the press lands where the caller asked');
  }
});

test('every point on a path is closer to the target than the one before it', () => {
  const pairs = [
    [
      { x: 0, y: 0 },
      { x: 900, y: 500 },
    ],
    [
      { x: 900, y: 500 },
      { x: 0, y: 0 },
    ],
    [
      { x: 400, y: 300 },
      { x: 410, y: 700 },
    ],
    [
      { x: 12, y: 640 },
      { x: 1200, y: 12 },
    ],
  ];
  for (const [from, to] of pairs) {
    for (let run = 0; run < 100; run++) {
      const points = cdp.pointerPath(from, to);
      let previous = distanceTo(from, to);
      for (const point of points) {
        const now = distanceTo(point, to);
        assert.ok(now < previous, 'path from ' + JSON.stringify(from) + ' backtracked: ' + now + ' >= ' + previous);
        previous = now;
      }
    }
  }
});

test('a path bows off the straight line rather than running down it', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };
  let bowed = 0;
  for (let run = 0; run < 100; run++) {
    const points = cdp.pointerPath(from, to);
    if (points.slice(0, -1).some((p) => Math.abs(p.y) > 0)) bowed++;
  }
  assert.ok(bowed > 80, 'only ' + bowed + ' of 100 paths left the straight line');
});

test('the last pointer position is kept per tab', async () => {
  recordMouse();
  await cdp.attach(70);
  await cdp.attach(71);

  assert.equal(cdp.lastPointer(70), null, 'a tab that has never been pointed at has no position');

  await cdp.mouseHover(70, 120, 240);
  await cdp.mouseHover(71, 600, 80);

  assert.deepEqual(cdp.lastPointer(70), { x: 120, y: 240 });
  assert.deepEqual(cdp.lastPointer(71), { x: 600, y: 80 }, 'one tab does not move another tab pointer');

  cdp.forgetPointer(71);
  assert.equal(cdp.lastPointer(71), null);
  assert.deepEqual(cdp.lastPointer(70), { x: 120, y: 240 });
  await cdp.detachAll();
});

test('a click after a known position moves along a path before pressing', async () => {
  const events = recordMouse();
  await cdp.attach(72);

  await cdp.mouseHover(72, 40, 40);
  events.length = 0;
  await cdp.mouseClick(72, 500, 300, { hoverDelay: 0 });

  const moves = events.filter((e) => e.type === 'mouseMoved');
  const press = events.findIndex((e) => e.type === 'mousePressed');
  assert.ok(moves.length >= 3 && moves.length <= 6, 'got ' + moves.length + ' moves before the press');
  assert.ok(press > 0 && events.slice(0, press).every((e) => e.type === 'mouseMoved'), 'every move precedes the press');
  assert.deepEqual(
    { x: moves[moves.length - 1].x, y: moves[moves.length - 1].y },
    { x: 500, y: 300 },
    'the last move is on the target'
  );
  assert.deepEqual(cdp.lastPointer(72), { x: 500, y: 300 });
  await cdp.detachAll();
});

test('the first click on a tab is a single move, as before', async () => {
  const events = recordMouse();
  await cdp.attach(73);

  await cdp.mouseClick(73, 300, 200, { hoverDelay: 0 });

  assert.equal(events.filter((e) => e.type === 'mouseMoved').length, 1, 'there is no position to travel from');
  await cdp.detachAll();
});

test('a click next to the pointer does not manufacture a path', async () => {
  const events = recordMouse();
  await cdp.attach(74);

  await cdp.mouseHover(74, 300, 200);
  events.length = 0;
  await cdp.mouseClick(74, 303, 202, { hoverDelay: 0 });

  assert.equal(events.filter((e) => e.type === 'mouseMoved').length, 1, 'three pixels is not a journey');
  await cdp.detachAll();
});

test('the path rides inside the hover gap instead of adding to it', async () => {
  const events = recordMouse();
  await cdp.attach(75);

  await cdp.mouseHover(75, 20, 20);
  events.waits.length = 0;
  await cdp.mouseClick(75, 700, 400, { hoverDelay: 100 });

  const asked = events.waits.reduce((a, b) => a + b, 0);
  assert.ok(events.waits.length > 1, 'the wait is split across the path, not taken in one block');
  // Each slice pays for its own dispatch out of the gap, so the sleeps add up
  // to the gap minus whatever the dispatches took. On a quiet machine that is
  // 100, on a loaded CI runner a few milliseconds less. Never more.
  assert.ok(asked <= 100, 'the slices never add to the gap, asked ' + asked);
  assert.ok(asked >= 80, 'and they cover most of it, asked ' + asked);
  await cdp.detachAll();
});

test('a click with no hover gap waits for nothing', async () => {
  const events = recordMouse();
  await cdp.attach(76);

  await cdp.mouseHover(76, 20, 20);
  events.waits.length = 0;
  await cdp.mouseClick(76, 700, 400, { hoverDelay: 0 });

  assert.deepEqual(events.waits, [], 'a caller who asked for no gap does not get one back');
  await cdp.detachAll();
});

test('only the last move on a path waits for an acknowledgement', async () => {
  // A hidden tab acknowledges nothing, so every awaited move costs the full
  // ack timeout. A six-point path that waited on each would cost seconds.
  const events = [];
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_t, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_t, method, params, done) {
      if (method === 'Input.dispatchMouseEvent') events.push({ ...params });
      // A move is never acknowledged, which is the hidden-tab case. The press
      // and everything else answers, so only the moves are being measured.
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') return;
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };

  await cdp.attach(77);
  cdp.setLastPointer(77, 20, 20);
  const startedAt = Date.now();
  await cdp.mouseClick(77, 700, 400, { hoverDelay: 0 });
  const elapsed = Date.now() - startedAt;

  const moves = events.filter((e) => e.type === 'mouseMoved');
  assert.ok(moves.length >= 3, 'the path was still dispatched, got ' + moves.length + ' moves');
  assert.ok(elapsed < 900, 'one ack timeout was paid, not one per point, took ' + elapsed + ' ms');
  assert.equal(cdp.rendererLooksThrottled(77), true, 'and the missing ack on the target was still noticed');
  cdp.clearThrottleFlag(77);
  await cdp.detachAll();
});

// ---------------------------------------------------------------------------
// P10: force on pressed mouse events, and the page-zoom chord refusal
// ---------------------------------------------------------------------------

/** Like scriptDebugger, but also records the params of every sendCommand call. */
function scriptDebuggerWithParams() {
  const calls = [];
  globalThis.chrome.debugger = {
    attach(_target, _version, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_target, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_target, method, params, done) {
      calls.push({ method, params });
      chrome.runtime.lastError = null;
      done({ ok: true });
      chrome.runtime.lastError = null;
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };
  return calls;
}

test('a left click sends force on mousePressed but not on mouseReleased', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(40);
  await cdp.mouseClick(40, 10, 20, { hoverDelay: 0 });

  const pressed = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  const released = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased');
  assert.equal(pressed.params.force, 0.5);
  assert.equal(released.params.force, undefined, 'a release carries no pressure');
  await cdp.detachAll();
});

test('a drag sends force on the press and on every move while the button is held', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(41);
  await cdp.mouseDragDwell(41, [0, 0], [30, 0], 0, {}, { steps: 2, stepDelay: 0, pressDwell: 0, releaseDwell: 0 });

  const pressed = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  const moves = calls.filter(
    (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved' && c.params.buttons === 1
  );
  assert.equal(pressed.params.force, 0.5);
  assert.ok(moves.length > 0, 'the drag produced at least one held-button move');
  assert.ok(
    moves.every((m) => m.params.force === 0.5),
    'every held-button move carries force'
  );
  await cdp.detachAll();
});

test('the initial hover-in move of a click carries no force (the button is not down yet)', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(42);
  await cdp.mouseClick(42, 5, 5, { hoverDelay: 0 });
  const hoverMove = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved');
  assert.equal(hoverMove.params.force, undefined);
  await cdp.detachAll();
});

test('pressKey refuses ctrl+0, a page-zoom-reset chord', async () => {
  scriptDebuggerWithParams();
  await cdp.attach(43);
  await assert.rejects(() => cdp.pressKey(43, 'ctrl+0'), /zoom/i);
  await cdp.detachAll();
});

test('pressKeyLoose refuses ctrl+= and ctrl+-, which do not route through the named-key table', async () => {
  scriptDebuggerWithParams();
  await cdp.attach(44);
  await assert.rejects(() => cdp.pressKeyLoose(44, 'ctrl+='), /zoom/i);
  await assert.rejects(() => cdp.pressKeyLoose(44, 'ctrl+-'), /zoom/i);
  await cdp.detachAll();
});

test('cmd+0 is refused the same way ctrl+0 is (mac chord)', async () => {
  scriptDebuggerWithParams();
  await cdp.attach(45);
  await assert.rejects(() => cdp.pressKeyLoose(45, 'cmd+0'), /zoom/i);
  await cdp.detachAll();
});

test('a plain 0, and ctrl held with an unrelated key, are not refused', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(46);
  await cdp.pressKey(46, '0');
  await cdp.pressKey(46, 'ctrl+a');
  assert.ok(
    calls.some((c) => c.method === 'Input.dispatchKeyEvent'),
    'ordinary keys still dispatch'
  );
  await cdp.detachAll();
});

// ---------------------------------------------------------------------------
// Every spelling of Enter is Enter (W2)
// ---------------------------------------------------------------------------

test('Return, NumpadEnter and a newline all count as pressing Enter', () => {
  const newline = String.fromCharCode(10);
  const carriageReturn = String.fromCharCode(13);
  for (const name of ['Enter', 'enter', 'Return', 'return', 'NumpadEnter', newline, carriageReturn]) {
    assert.equal(cdp.pressesEnter(name), true, JSON.stringify(name) + ' presses Enter');
  }
  assert.equal(cdp.pressesEnter('ctrl+Return'), true, 'a chord ending in Enter submits too');
  assert.equal(cdp.pressesEnter('Tab Tab Return'), true, 'a sequence is checked key by key');
});

test('a key that is not Enter is not treated as a submit', () => {
  for (const name of ['Tab', 'Escape', 'a', 'ctrl+a', 'entertain', '', undefined, null]) {
    assert.equal(cdp.pressesEnter(name), false, JSON.stringify(name) + ' is not Enter');
  }
});

test('Return dispatches the same key event Enter does', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(47);
  await cdp.pressKeyLoose(47, 'Return');
  const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.ok(keys.length >= 2, 'a key down and a key up');
  assert.equal(keys[0].params.key, 'Enter');
  assert.equal(keys[0].params.windowsVirtualKeyCode, 13);
  await cdp.detachAll();
});

test('NumpadEnter presses Enter from the numeric keypad rather than failing', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(48);
  await cdp.pressKeyLoose(48, 'NumpadEnter');
  const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.equal(keys[0].params.key, 'Enter');
  assert.equal(keys[0].params.code, 'NumpadEnter');
  await cdp.detachAll();
});

test('a bare newline is Enter rather than a character to insert', async () => {
  const calls = scriptDebuggerWithParams();
  await cdp.attach(49);
  await cdp.pressKeyLoose(49, String.fromCharCode(10));
  const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.equal(keys[0].params.key, 'Enter');
  await cdp.detachAll();
});

// ---------------------------------------------------------------------------
// Open bug 3: the replacement ladder has a cap
// ---------------------------------------------------------------------------
//
// With another extension injecting into every page, every tab is refused, the
// replacement is refused in turn, and three runs produced six tabs and no
// working call. A replacement refused for the reason its predecessor was
// refused for stops the ladder.

/** A frame tree carrying another extension's frame, which is what refuses the attach. */
function scriptInterferingFrames(host = 'otherextensionidaaaa') {
  chrome.webNavigation = {
    async getAllFrames() {
      return [
        { frameId: 0, parentFrameId: -1, url: 'https://x.test/home' },
        { frameId: 1, parentFrameId: 0, url: 'chrome-extension://' + host + '/inject.html' },
      ];
    },
  };
}

test('causeKey calls two foreign-frame refusals the same cause and a different one different', () => {
  assert.equal(cdp.causeKey(STALE), cdp.causeKey(STALE));
  assert.equal(cdp.causeKey(STALE), 'foreign-frame');
  assert.notEqual(
    cdp.causeKey('Cannot access a chrome-extension://abcdefghijklmnopqrst/ URL of different extension'),
    cdp.causeKey(STALE)
  );
  assert.equal(cdp.causeKey('Another debugger is already attached'), 'already-attached');
});

test('a replacement refused for the same cause returns attach_refused instead of another tab', async () => {
  cdp.forgetReplacements();
  scriptRefusingAttach({ refusals: 99 });
  scriptInterferingFrames();
  await chrome.storage.local.set({ attachRecovery: false });
  const asked = [];
  cdp.setSessionReplacer(async (tabId) => {
    asked.push(tabId);
    return { oldTabId: tabId, newTabId: 4300, url: 'https://x.test/home' };
  });

  await assert.rejects(
    () => cdp.attach(30),
    (err) => {
      assert.equal(err.code, 'tab_replaced');
      assert.equal(err.details.newTabId, 4300);
      return true;
    }
  );

  await assert.rejects(
    () => cdp.attach(4300),
    (err) => {
      assert.equal(err.code, 'attach_refused', 'the ladder stops rather than opening a third tab');
      assert.equal(err.retryable, false);
      assert.equal(err.effects, 'none');
      assert.match(err.message, /same reason as the tab it replaced/);
      assert.match(err.message, /otherextensionidaaaa/, 'the interfering extension frame is named');
      assert.match(err.hint, /Disable otherextensionidaaaa/);
      assert.equal(err.details.replacedTabId, 30);
      return true;
    }
  );

  assert.deepEqual(asked, [30], 'exactly one replacement was opened for this tab');
  cdp.setSessionReplacer(null);
  await chrome.storage.local.clear();
  delete chrome.webNavigation;
});

test('the same original tab is replaced once per cause, not once per call', async () => {
  cdp.forgetReplacements();
  scriptRefusingAttach({ refusals: 99 });
  scriptInterferingFrames();
  await chrome.storage.local.set({ attachRecovery: false });
  const asked = [];
  cdp.setSessionReplacer(async (tabId) => {
    asked.push(tabId);
    return { oldTabId: tabId, newTabId: 4400, url: 'https://x.test/home' };
  });

  await assert.rejects(
    () => cdp.attach(50),
    (err) => err.code === 'tab_replaced'
  );
  await assert.rejects(
    () => cdp.attach(50),
    (err) => {
      assert.equal(err.code, 'attach_refused');
      return true;
    }
  );
  assert.deepEqual(asked, [50]);

  cdp.setSessionReplacer(null);
  await chrome.storage.local.clear();
  delete chrome.webNavigation;
});

test('a replacement refused for a different cause is still replaced once', async () => {
  cdp.forgetReplacements();
  scriptRefusingAttach({ refusals: 99 });
  scriptInterferingFrames();
  await chrome.storage.local.set({ attachRecovery: false });
  const asked = [];
  cdp.setSessionReplacer(async (tabId) => {
    asked.push(tabId);
    return { oldTabId: tabId, newTabId: 4500 + asked.length, url: 'https://x.test/home' };
  });

  await assert.rejects(
    () => cdp.attach(60),
    (err) => err.code === 'tab_replaced'
  );

  // A second extension, so the refusal on the replacement is not the one that
  // killed the tab it replaced.
  scriptRefusingAttach({
    refusals: 99,
    message: 'Cannot access a chrome-extension://abcdefghijklmnopqrst/ URL of different extension',
  });
  await assert.rejects(
    () => cdp.attach(4501),
    (err) => err.code === 'tab_replaced'
  );

  assert.deepEqual(asked, [60, 4501], 'a new cause earns one more replacement');
  cdp.setSessionReplacer(null);
  await chrome.storage.local.clear();
  delete chrome.webNavigation;
});

// ---------------------------------------------------------------------------
// Open bug 4: a call queued behind a frozen renderer
// ---------------------------------------------------------------------------
//
// An 8 s busy loop in javascript delayed the next call on the same tab by the
// whole 8 s, and it then succeeded. Nothing was lost, and the caller got no
// timeout and no reload hint while it waited.

/** A debugger whose commands answer after `delay` ms, so one can be left hanging. */
function scriptSlowDebugger({ delay = 50 } = {}) {
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
      const at = Date.now();
      calls.push({ method, at });
      setTimeout(() => {
        chrome.runtime.lastError = null;
        done({ ok: true, method });
        chrome.runtime.lastError = null;
      }, delay);
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };
  return calls;
}

test('a command queued behind an unanswered one fails with timeout and the reload hint', async () => {
  const calls = scriptSlowDebugger({ delay: 600 });
  await cdp.attach(70);

  const first = cdp.send(70, 'Runtime.evaluate', { expression: 'busy()' }, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 20));

  const started = Date.now();
  await assert.rejects(
    () => cdp.send(70, 'DOM.getDocument', {}, { timeout: 200, wakeOnTimeout: false }),
    (err) => {
      assert.equal(err.code, 'timeout');
      assert.equal(err.effects, 'none', 'the queued command never ran, so it changed nothing');
      assert.match(err.hint, /reload the tab with navigate/);
      assert.match(err.message, /behind Runtime\.evaluate/);
      assert.equal(err.details.blockedBy, 'Runtime.evaluate');
      return true;
    }
  );
  const waited = Date.now() - started;
  assert.ok(waited < 500, 'it gave up on its own timeout, not the first command: ' + waited + 'ms');

  // The first call is left alone and finishes.
  const result = await first;
  assert.equal(result.method, 'Runtime.evaluate');
  assert.equal(
    calls.filter((c) => c.method === 'DOM.getDocument').length,
    0,
    'the queued command was never dispatched'
  );
  await cdp.detachAll();
});

test('a queued command that gets its turn in time still runs', async () => {
  scriptSlowDebugger({ delay: 60 });
  await cdp.attach(71);

  const first = cdp.send(71, 'Runtime.evaluate', { expression: '1' }, { timeout: 5000 });
  const second = cdp.send(71, 'DOM.getDocument', {}, { timeout: 5000 });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.method, 'Runtime.evaluate');
  assert.equal(b.method, 'DOM.getDocument', 'an ordinary pair of calls is unaffected');
  await cdp.detachAll();
});

test('busyFor reports how long the tab has been waiting, and clears when it answers', async () => {
  scriptSlowDebugger({ delay: 200 });
  await cdp.attach(72);

  assert.equal(cdp.busyFor(72), 0);
  const call = cdp.send(72, 'Runtime.evaluate', {}, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cdp.busyFor(72) >= 40, 'busyFor: ' + cdp.busyFor(72));
  await call;
  assert.equal(cdp.busyFor(72), 0);
  await cdp.detachAll();
});

test('input dispatch is not tracked, so a missing acknowledgement blocks nothing', async () => {
  const calls = scriptSlowDebugger({ delay: 5000 });
  await cdp.attach(73);

  // Sent with timeout 0, the way sendInput sends it, and never answered.
  cdp.send(73, 'Input.dispatchMouseEvent', { type: 'mouseMoved' }, { timeout: 0 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cdp.busyFor(73), 0, 'an unacknowledged input does not make the tab look busy');

  const started = Date.now();
  await assert.rejects(
    () => cdp.send(73, 'DOM.getDocument', {}, { timeout: 150, wakeOnTimeout: false }),
    (err) => err.code === 'timeout'
  );
  assert.ok(Date.now() - started < 400, 'it went out and timed out on its own, rather than queueing');
  assert.ok(
    calls.some((c) => c.method === 'DOM.getDocument'),
    'the command was dispatched'
  );
  await cdp.detachAll();
});

test('awaitTurn gives a page call the same deadline, since sendMessage has none', async () => {
  scriptSlowDebugger({ delay: 800 });
  await cdp.attach(74);

  const first = cdp.send(74, 'Runtime.evaluate', { expression: 'busy()' }, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 20));

  await assert.rejects(
    () => cdp.awaitTurn(74, 'READ_PAGE', 150),
    (err) => {
      assert.equal(err.code, 'timeout');
      assert.match(err.message, /CDP READ_PAGE waited 150ms/);
      assert.match(err.hint, /reload the tab with navigate/);
      return true;
    }
  );

  await first;
  await cdp.awaitTurn(74, 'READ_PAGE', 150);
  await cdp.detachAll();
});

// ---------------------------------------------------------------------------
// A capture must not pay a frozen renderer twice
// ---------------------------------------------------------------------------

test('a queue timeout while hiding the indicator is what the capture reports', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const timeout = Object.assign(new Error('CDP screenshot waited 20000ms'), { code: 'timeout' });
  const asked = [];
  await assert.rejects(
    () =>
      tools.hideForCapture(80, 'screenshot', {
        busyFor: () => 4000,
        awaitTurn: (tabId, label) => {
          asked.push([tabId, label]);
          return Promise.reject(timeout);
        },
      }),
    (err) => err === timeout
  );
  assert.deepEqual(asked, [[80, 'screenshot']], 'the wait is labelled for the caller, not for the message');
});

test('a page that cannot take the hide is still captured', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const before = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = () => Promise.reject(new Error('Receiving end does not exist'));
  globalThis.chrome.scripting = { executeScript: () => Promise.reject(new Error('no host permission')) };
  try {
    await tools.hideForCapture(81, 'screenshot', { busyFor: () => 0, awaitTurn: () => Promise.resolve() });
  } finally {
    globalThis.chrome.tabs.sendMessage = before;
  }
});

test('every capture path hides through hideForCapture', () => {
  const source = readFileSync(new URL('../extension/src/lib/tools.js', import.meta.url), 'utf8');
  const hides = source.split('\n').filter((line) => line.includes('HIDE_FOR_TOOL_USE'));
  assert.equal(hides.length, 1, 'the hide is sent from one place: ' + hides.join(' | '));
  assert.equal(
    (source.match(/hideForCapture\(tabId, '/g) || []).length,
    3,
    'screenshot, zoom and the before-write capture all use it'
  );
});
