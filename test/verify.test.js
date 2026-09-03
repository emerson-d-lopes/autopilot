// Input verification: C3, and the R9, R13 and R15 pieces it merges.
//
// A click, type or scroll that reports success and changed nothing is the
// failure an agent is least able to catch, because it reads the success and
// acts on it. These cover the watch the content script arms, the scroll
// fallback, and the drag event order.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';
import { loadPage } from './page-harness.js';

installChromeStub();

const cdp = await import('../extension/src/lib/cdp.js');

// ---------------------------------------------------------------------------
// The watch (C3)
// ---------------------------------------------------------------------------

test('a DOM mutation inside the window is reported as a change', async () => {
  const { call, window } = loadPage('<!doctype html><body><div id="out"></div><button id="b">Go</button></body>');

  await call({ type: 'VERIFY_ARM' });
  window.document.getElementById('out').textContent = 'the listener fired';
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.ok, true);
  assert.ok(report.mutations >= 1, 'the mutation was counted: ' + report.mutations);
  assert.equal(report.changed, true);
});

test('an inert element produces a window with nothing in it', async () => {
  const { call } = loadPage('<!doctype html><body><span>nothing happens here</span></body>');

  await call({ type: 'VERIFY_ARM' });
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.mutations, 0);
  assert.equal(report.focusChanged, false);
  assert.equal(report.valueChanged, false);
  assert.equal(report.scrolled, false);
  assert.equal(report.changed, false, 'so the caller can say no observable change');
});

test('a focus change is a change even when the DOM did not move', async () => {
  const { call, window } = loadPage('<!doctype html><body><input id="a"><input id="b"></body>');

  window.document.getElementById('a').focus();
  await call({ type: 'VERIFY_ARM' });
  window.document.getElementById('b').focus();
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.focusChanged, true);
  assert.equal(report.changed, true);
});

test('a value change in the focused control is reported without echoing a password', async () => {
  const { call, window } = loadPage('<!doctype html><body><input id="p" type="password"></body>');
  const field = window.document.getElementById('p');
  field.focus();

  await call({ type: 'VERIFY_ARM' });
  field.value = 'hunter2';
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.valueChanged, true);
  assert.equal(report.valueTracked, true);
  assert.equal(report.valueSensitive, true);
  assert.equal(JSON.stringify(report).includes('hunter2'), false, 'the value never leaves the page');
});

test('a type with nothing focused reports that there was no value to watch', async () => {
  const { call } = loadPage('<!doctype html><body><p>read only prose</p></body>');

  await call({ type: 'VERIFY_ARM' });
  const report = await call({ type: 'VERIFY_REPORT', window: 20 });

  assert.equal(report.valueTracked, false, 'so a type here is not judged by a value that never existed');
});

test('reporting without arming says so rather than inventing a result', async () => {
  const { call } = loadPage('<!doctype html><body></body>');
  const report = await call({ type: 'VERIFY_REPORT', window: 10 });
  assert.equal(report.ok, false);
  assert.match(report.error, /no verification window is armed/);
});

// ---------------------------------------------------------------------------
// Scroll offsets and the fallback (R9)
// ---------------------------------------------------------------------------

test('SCROLL_OFFSETS reports the page offsets and the nearest scrollable container', async () => {
  const { call, window } = loadPage(`<!doctype html><body style="overflow:hidden">
    <div id="pane" style="overflow-y:auto;height:200px"><div style="height:2000px">tall</div></div>
  </body>`);

  const pane = window.document.getElementById('pane');
  Object.defineProperty(pane, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
  window.document.elementFromPoint = () => pane.firstElementChild;

  const offsets = await call({ type: 'SCROLL_OFFSETS', x: 100, y: 100 });
  assert.equal(offsets.ok, true);
  assert.equal(offsets.page.y, 0);
  assert.equal(offsets.container.tag, 'div', 'the inner pane is found, not the body');
  assert.equal(offsets.container.isRoot, false);
});

test('SCROLL_BY moves the inner container when the body cannot scroll', async () => {
  const { call, window } = loadPage(`<!doctype html><body style="overflow:hidden">
    <div id="pane" style="overflow-y:auto;height:200px"><div id="tall" style="height:2000px">tall</div></div>
  </body>`);

  const pane = window.document.getElementById('pane');
  Object.defineProperty(pane, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
  let scrolledBy = null;
  pane.scrollBy = (dx, dy) => {
    scrolledBy = [dx, dy];
    pane.scrollTop += dy;
  };
  window.document.elementFromPoint = () => window.document.getElementById('tall');

  const result = await call({ type: 'SCROLL_BY', x: 100, y: 100, direction: 'down', amount: 3 });

  assert.equal(result.ok, true);
  assert.deepEqual(scrolledBy, [0, 300], 'three wheel ticks became a 300px scroll');
  assert.equal(result.isRoot, false);
  assert.equal(result.delta.containerY, 300, 'and the movement is measured, not assumed');
});

test('SCROLL_BY reports zero movement rather than claiming a scroll', async () => {
  const { call, window } = loadPage('<!doctype html><body><p>short page</p></body>');
  window.document.elementFromPoint = () => window.document.querySelector('p');
  window.scrollBy = () => {};

  const result = await call({ type: 'SCROLL_BY', x: 10, y: 10, direction: 'down', amount: 3 });
  assert.equal(result.delta.pageY, 0);
  assert.equal(result.delta.containerY, 0);
});

// ---------------------------------------------------------------------------
// Drag dwell (R15)
// ---------------------------------------------------------------------------

/** Records the CDP commands a drag emits, with the gaps between them. */
function recordingDebugger() {
  const events = [];
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      done();
    },
    detach(_t, done) {
      done();
    },
    sendCommand(_t, method, params, done) {
      if (method === 'Input.dispatchMouseEvent') {
        events.push({ type: params.type, x: params.x, y: params.y, buttons: params.buttons, at: Date.now() });
      } else if (method === 'Runtime.evaluate') {
        // The agent sleeps on the page clock. Resolve at once and record the
        // requested duration, which is the dwell under test.
        const ms = Number(/setTimeout\(r,\s*(\d+)\)/.exec(params.expression || '')?.[1] || 0);
        events.push({ type: 'sleep', ms, at: Date.now() });
      }
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };
  return events;
}

test('a drag presses, dwells, moves in steps, dwells, then releases', async () => {
  const events = recordingDebugger();
  await cdp.attach(41);

  await cdp.mouseDragDwell(41, [10, 10], [110, 60]);

  const mouse = events.filter((e) => e.type !== 'sleep');
  const kinds = mouse.map((e) => e.type);
  assert.equal(kinds[0], 'mouseMoved', 'the pointer travels to the source first');
  assert.equal(kinds[1], 'mousePressed');
  assert.equal(kinds[kinds.length - 1], 'mouseReleased');
  assert.equal(kinds.filter((k) => k === 'mouseMoved').length, 11, 'one approach plus ten interpolated steps');

  const pressIndex = events.findIndex((e) => e.type === 'mousePressed');
  const releaseIndex = events.findIndex((e) => e.type === 'mouseReleased');
  assert.equal(events[pressIndex + 1].type, 'sleep', 'the press dwells before the first move');
  assert.equal(events[pressIndex + 1].ms, 50);
  assert.equal(events[releaseIndex - 1].type, 'sleep', 'and the last move dwells before the release');
  assert.equal(events[releaseIndex - 1].ms, 50);

  const release = mouse[mouse.length - 1];
  assert.equal(release.x, 110);
  assert.equal(release.y, 60);
  await cdp.detachAll();
});

test('the drag that reproduces the fixture never leaves press and release in one frame', async () => {
  // The fixture's HTML5 boxes and its range thumb both stayed put, and the
  // page's own log showed a pointerdown and a click with no drop between them.
  // Every consecutive pair of mouse events is separated by a wait.
  const events = recordingDebugger();
  await cdp.attach(42);
  await cdp.mouseDragDwell(42, [0, 0], [200, 0]);

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].type === 'sleep' || events[i + 1].type === 'sleep') continue;
    assert.fail('two mouse events with no wait between them: ' + events[i].type + ' then ' + events[i + 1].type);
  }
  await cdp.detachAll();
});

// ---------------------------------------------------------------------------
// Throttle detection (R13)
// ---------------------------------------------------------------------------

test('a dispatch with no acknowledgement flags the tab as throttled', async () => {
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      done();
    },
    detach(_t, done) {
      done();
    },
    // Never calls back, which is what a throttled renderer looks like.
    sendCommand() {},
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };
  await cdp.attach(43);
  cdp.clearThrottleFlag(43);

  assert.equal(cdp.rendererLooksThrottled(43), false);
  await cdp.sendInput(43, { type: 'mouseMoved', x: 1, y: 1 }, 20);
  assert.equal(cdp.rendererLooksThrottled(43), true, 'so the caller can wake the tab and send it again');

  cdp.clearThrottleFlag(43);
  assert.equal(cdp.rendererLooksThrottled(43), false);
});

// ---------------------------------------------------------------------------
// W1: the editor path, against a LinkedIn-shaped composer
// ---------------------------------------------------------------------------
//
// A contenteditable inside a form whose Send button enables on input. Replacing
// textContent and firing a synthetic input leaves a rich editor's own model
// stale, so form_input clicks it, selects all, and inserts the text through
// CDP. This wires the chrome stub's tabs.sendMessage to the page and its
// debugger to the effects those commands really have.

const COMPOSER = `<!doctype html><body>
  <form id="composer">
    <div id="editor" contenteditable="true" aria-label="Write a message"></div>
    <button id="send" type="submit" disabled>Send</button>
  </form>
  <script></script>
</body>`;

/** Routes the extension's page and CDP calls at one jsdom window. */
function wireComposer(page, { tabId = 1 } = {}) {
  const { window, call } = page;
  const editor = window.document.getElementById('editor');
  const send = window.document.getElementById('send');
  // The composer's own behaviour: the Send button follows the editor's content.
  editor.addEventListener('input', () => {
    send.disabled = editor.textContent.trim().length === 0;
  });

  const commands = [];
  let selectedAll = false;

  window.document.elementFromPoint = () => editor;

  globalThis.chrome.tabs.sendMessage = (_id, message) =>
    new Promise((resolve) => {
      call(message).then(resolve);
    });

  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      done();
    },
    detach(_t, done) {
      done();
    },
    sendCommand(_t, method, params, done) {
      commands.push({ method, params });
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        editor.focus();
        editor.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      }
      if (method === 'Input.dispatchKeyEvent' && params.key === 'a' && params.modifiers === 2) {
        selectedAll = true;
      }
      if (method === 'Input.insertText') {
        const target = window.document.activeElement;
        if (selectedAll) target.textContent = '';
        selectedAll = false;
        target.textContent += params.text;
        target.dispatchEvent(new window.window.InputEvent('beforeinput', { bubbles: true }));
        target.dispatchEvent(new window.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      }
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };

  return { editor, send, commands, tabId };
}

test('form_input on a composer clicks, selects all, inserts, and verifies', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(COMPOSER);
  const wired = wireComposer(page);
  // assertTabInSession needs the session to own the stub's tab group.
  await globalThis.chrome.storage.local.set({ tabGroups: { default: 7 } });

  const nodes = (await page.call({ type: 'READ_PAGE', filter: 'interactive' })).text;
  const ref = /\[(ref_\d+)\]/.exec(nodes.split('\n').find((l) => l.includes('Write a message')))[1];

  const result = await tools.execute(
    'form_input',
    { tabId: 1, ref, value: 'Thanks for the intro, sending the deck now.' },
    { clientId: 'default' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'editor', 'the contenteditable took the editor path');
  assert.equal(result.effects, 'applied');
  assert.equal(wired.editor.textContent, 'Thanks for the intro, sending the deck now.');
  assert.equal(wired.send.disabled, false, 'the Send button reacted to a real input event');

  const methods = wired.commands.map((c) => c.method);
  assert.ok(methods.includes('Input.dispatchMouseEvent'), 'focused by a real click');
  assert.ok(methods.includes('Input.insertText'), 'and written with insertText');
  assert.ok(result.evidence.mutations >= 1, 'the write is evidenced by the page changing');
});

test('form_input on a composer replaces what is already there', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(COMPOSER);
  const wired = wireComposer(page);
  wired.editor.textContent = 'a half written draft';
  await globalThis.chrome.storage.local.set({ tabGroups: { default: 7 } });

  const tree = (await page.call({ type: 'READ_PAGE', filter: 'interactive' })).text;
  const ref = /\[(ref_\d+)\]/.exec(tree.split('\n').find((l) => l.includes('Write a message')))[1];

  const result = await tools.execute(
    'form_input',
    { tabId: 1, ref, value: 'the final version' },
    { clientId: 'default' }
  );

  assert.equal(result.replaced, true);
  assert.equal(wired.editor.textContent, 'the final version', 'the draft is gone, not appended to');
  const keys = wired.commands.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.ok(keys.some((c) => c.params.key === 'a' && c.params.modifiers === 2), 'ctrl+a was sent first');
});

test('a composer write that does not land is an error naming the editor', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(COMPOSER);
  const wired = wireComposer(page);
  await globalThis.chrome.storage.local.set({ tabGroups: { default: 7 } });

  // An editor that refuses the insertion, which is what a rich editor does when
  // its own model never saw a selection.
  const original = globalThis.chrome.debugger.sendCommand;
  globalThis.chrome.debugger.sendCommand = (t, method, params, done) => {
    if (method === 'Input.insertText') {
      chrome.runtime.lastError = null;
      return done({});
    }
    return original(t, method, params, done);
  };

  const tree = (await page.call({ type: 'READ_PAGE', filter: 'interactive' })).text;
  const ref = /\[(ref_\d+)\]/.exec(tree.split('\n').find((l) => l.includes('Write a message')))[1];

  await assert.rejects(
    () => tools.execute('form_input', { tabId: 1, ref, value: 'never arrives' }, { clientId: 'default' }),
    (err) => {
      assert.equal(err.code, 'no_effect');
      assert.match(err.message, /Write a message/);
      assert.equal(err.effects, 'unknown');
      return true;
    }
  );
  assert.equal(wired.editor.textContent, '');
});

// ---------------------------------------------------------------------------
// S7: the two quick script gaps, and the key path they use
// ---------------------------------------------------------------------------

const { parseScript } = await import('../extension/src/lib/quick.js');

test('K takes a single punctuation character instead of erroring', async () => {
  const events = recordingDebugger();
  await cdp.attach(51);

  // "K /" parses like any other key line.
  const actions = parseScript('K /', 7);
  assert.equal(actions[0].name, 'computer');
  assert.deepEqual(actions[0].input, { action: 'key', text: '/', tabId: 7 });

  // And the dispatch accepts it rather than refusing it with a key list.
  await cdp.pressKeySequenceLoose(51, '/');
  assert.equal(
    events.filter((e) => e.type !== 'sleep').length,
    0,
    'no mouse event was emitted, so the character went through the keyboard'
  );
  await cdp.detachAll();
});

test('a named key and a modifier chord still take the key table', async () => {
  const sent = [];
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      done();
    },
    detach(_t, done) {
      done();
    },
    sendCommand(_t, method, params, done) {
      if (method === 'Input.dispatchKeyEvent') sent.push({ type: params.type, key: params.key, mods: params.modifiers });
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };
  await cdp.attach(52);

  await cdp.pressKeySequenceLoose(52, 'Enter');
  assert.ok(sent.some((e) => e.key === 'Enter'), 'Enter still resolves through the key table');

  sent.length = 0;
  await cdp.pressKeySequenceLoose(52, 'ctrl+a');
  assert.ok(sent.some((e) => e.key === 'a' && e.mods === 2), 'ctrl+a keeps its modifier');

  sent.length = 0;
  await cdp.pressKeySequenceLoose(52, '/');
  assert.deepEqual(
    sent.map((e) => e.type),
    ['keyDown', 'char', 'keyUp'],
    'a printable character gets the three events a real press produces'
  );
  assert.equal(sent[0].key, '/');
  await cdp.detachAll();
});

test('TR types replacing, T appends', () => {
  const [replacing] = parseScript('TR the final text', 4);
  assert.deepEqual(replacing.input, { action: 'type', text: 'the final text', replace: true, tabId: 4 });

  const [appending] = parseScript('T more text', 4);
  assert.equal(appending.input.replace, undefined);
});

test('R takes an optional character budget after the optional filter', () => {
  assert.deepEqual(parseScript('R', 3)[0].input, { filter: 'interactive', tabId: 3 });
  assert.deepEqual(parseScript('R all', 3)[0].input, { filter: 'all', tabId: 3 });
  assert.deepEqual(parseScript('R 30000', 3)[0].input, { filter: 'interactive', max_chars: 30000, tabId: 3 });
  assert.deepEqual(parseScript('R all 30000', 3)[0].input, { filter: 'all', max_chars: 30000, tabId: 3 });
});

test('a budget that is not a number is refused before anything runs', () => {
  assert.throws(() => parseScript('R interactive', 3), /character budget/);
});

// ---------------------------------------------------------------------------
// R5: per-key typing carries the codes a field reads on keydown
// ---------------------------------------------------------------------------

test('typeKeysReal sends a virtual key code and a code for every character', async () => {
  const sent = [];
  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      done();
    },
    detach(_t, done) {
      done();
    },
    sendCommand(_t, method, params, done) {
      if (method === 'Input.dispatchKeyEvent') sent.push(params);
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };
  await cdp.attach(53);

  await cdp.typeKeysReal(53, 'ja', 0);

  const downs = sent.filter((e) => e.type === 'keyDown');
  assert.equal(downs.length, 2);
  assert.equal(downs[0].key, 'j');
  assert.equal(downs[0].code, 'KeyJ', 'the physical code an autocomplete reads');
  assert.equal(downs[0].windowsVirtualKeyCode, 74, 'and a real keyCode rather than zero');
  assert.equal(downs[0].text, 'j');
  assert.equal(
    sent.filter((e) => e.type === 'char').length,
    2,
    'each character also gets the char event that inserts it'
  );
  await cdp.detachAll();
});
