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

test('focus falling back to the body is not counted as a change', async () => {
  // Clicking an inert cell blurs whatever was focused. Counting that as a focus
  // change made an inert click report effects applied on the /big fixture.
  const { call, window } = loadPage('<!doctype html><body><button id="b">Go</button><td id="c">row 12</td></body>');
  window.document.getElementById('b').focus();

  await call({ type: 'VERIFY_ARM' });
  window.document.getElementById('b').blur();
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.focusChanged, false);
  assert.equal(report.focusBlurred, true, 'the blur is still reported');
  assert.equal(report.valueChanged, false);
  assert.equal(report.changed, false, 'so an inert click reports effects none');
});

test('focus moving from a control onto a button is not a value change', async () => {
  // A button carries a value property, so comparing the value of whatever holds
  // focus at the end of the window reported a change on every such click.
  const { call, window } = loadPage(
    '<!doctype html><body><input id="a" value="kept"><button id="b">Go</button></body>'
  );
  window.document.getElementById('a').focus();

  await call({ type: 'VERIFY_ARM' });
  window.document.getElementById('b').focus();
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.focusChanged, true, 'the click did land on the button');
  assert.equal(report.valueChanged, false, 'nothing was typed');
});

test('a value change is read from the element that was focused when the watch was armed', async () => {
  const { call, window } = loadPage('<!doctype html><body><input id="a"><button id="b">Go</button></body>');
  const field = window.document.getElementById('a');
  field.focus();

  await call({ type: 'VERIFY_ARM' });
  field.value = 'typed';
  window.document.getElementById('b').focus();
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.valueChanged, true);
  assert.equal(report.valueTracked, true);
});

test('a checkbox gaining focus does not read as a value change', async () => {
  const { call, window } = loadPage(
    '<!doctype html><body><input id="t" value="text"><input id="c" type="checkbox" value="on"></body>'
  );
  window.document.getElementById('t').focus();

  await call({ type: 'VERIFY_ARM' });
  window.document.getElementById('c').focus();
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.valueChanged, false);
});

test('a watch armed on a named ref tracks that element rather than whatever has focus', async () => {
  // form_input sets a value through the page's own setter, which never moves
  // focus, so the focused element at arm time is the body and there would be no
  // value to compare.
  const { call, window } = loadPage('<!doctype html><body><input id="a"></body>');
  const read = await call({ type: 'READ_PAGE', filter: 'all', depth: 15, maxChars: 50000 });
  const ref = (JSON.stringify(read).match(/ref_\d+/) || [])[0];
  assert.ok(ref, 'the input has a ref');

  await call({ type: 'VERIFY_ARM', ref });
  window.document.getElementById('a').value = 'set by the page';
  const report = await call({ type: 'VERIFY_REPORT', window: 40 });

  assert.equal(report.valueTracked, true);
  assert.equal(report.valueChanged, true);
  assert.equal(report.focusChanged, false, 'nothing was focused, and that is not the evidence here');
});

test('the watch says whether anything that can hold text has focus', async () => {
  const { call, window } = loadPage('<!doctype html><body><input id="a"><button id="b">Go</button></body>');

  window.document.getElementById('b').focus();
  await call({ type: 'VERIFY_ARM' });
  let report = await call({ type: 'VERIFY_REPORT', window: 20 });
  assert.equal(report.focusedEditable, false, 'a button cannot take typed text');

  window.document.getElementById('a').focus();
  await call({ type: 'VERIFY_ARM' });
  report = await call({ type: 'VERIFY_REPORT', window: 20 });
  assert.equal(report.focusedEditable, true);
});

test('focus sitting on a frame is reported as unknown rather than as not editable', async () => {
  // Focus inside a subframe reads as the frame element in the parent document.
  // Reporting false there made a type into an iframe field fail with no_effect,
  // and because that error says effects none the host retried it, so the text
  // was typed twice: jqueryui.com's autocomplete ended up holding "jaja".
  const { call, window } = loadPage('<!doctype html><body><input id="a"><iframe id="f"></iframe></body>');

  window.document.getElementById('f').focus();
  await call({ type: 'VERIFY_ARM' });
  const report = await call({ type: 'VERIFY_REPORT', window: 20 });

  assert.equal(report.focusedEditable, null, 'this document cannot see into the frame');
  assert.notEqual(report.focusedEditable, false, 'false is what made the type report no_effect');
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
  assert.ok(
    keys.some((c) => c.params.key === 'a' && c.params.modifiers === 2),
    'ctrl+a was sent first'
  );
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
      if (method === 'Input.dispatchKeyEvent')
        sent.push({ type: params.type, key: params.key, mods: params.modifiers });
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };
  await cdp.attach(52);

  await cdp.pressKeySequenceLoose(52, 'Enter');
  assert.ok(
    sent.some((e) => e.key === 'Enter'),
    'Enter still resolves through the key table'
  );

  sent.length = 0;
  await cdp.pressKeySequenceLoose(52, 'ctrl+a');
  assert.ok(
    sent.some((e) => e.key === 'a' && e.mods === 2),
    'ctrl+a keeps its modifier'
  );

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
  assert.equal(downs[0].text, undefined, 'the keyDown carries no text, or the character lands twice');
  const chars = sent.filter((e) => e.type === 'char');
  assert.equal(chars.length, 2, 'each character gets the char event that inserts it');
  assert.equal(chars[0].text, 'j');
  assert.equal(
    sent.filter((e) => e.text === 'j').length,
    1,
    'the character is carried by exactly one event, which is what stops "ja" arriving as "jjaa"'
  );
  await cdp.detachAll();
});

// ---------------------------------------------------------------------------
// W2, W4, W7: submitting, confirming and undoing
// ---------------------------------------------------------------------------
//
// The composer from W1 with a thread beside it, so a click on Send can be
// judged the way a real one is: the composer empties, the message turns up in
// the thread, and a status region says it was sent.

const THREAD = `<!doctype html><body>
  <ul id="thread"></ul>
  <div id="toast" role="status"></div>
  <form id="composer">
    <div id="editor" contenteditable="true" aria-label="Write a message"></div>
    <button id="send" type="submit">Send</button>
  </form>
</body>`;

/**
 * Routes the extension's page and CDP calls at one jsdom window, with a Send
 * button that behaves the way a messaging site's does.
 *
 * `behaviour` decides what the click does: 'send' publishes the message,
 * 'nothing' is the button that swallows the click, which is the case the three
 * second window exists to catch.
 */
function wireSubmit(page, { behaviour = 'send' } = {}) {
  const { window, call } = page;
  const editor = window.document.getElementById('editor');
  const send = window.document.getElementById('send');
  const thread = window.document.getElementById('thread');
  const toast = window.document.getElementById('toast');

  if (send && editor)
    send.addEventListener('click', (event) => {
      event.preventDefault();
      if (behaviour === 'nothing') return;
      const text = editor.textContent;
      const row = window.document.createElement('li');
      row.textContent = text;
      thread.appendChild(row);
      editor.textContent = '';
      toast.textContent = 'Message sent';
    });

  // Whatever is being clicked is what the hit test finds, which is what a page
  // with nothing covering the button reports.
  let target = send || window.document.body;
  window.document.elementFromPoint = () => target;

  globalThis.chrome.tabs.sendMessage = (_id, message) => new Promise((resolve) => call(message).then(resolve));

  globalThis.chrome.debugger = {
    attach(_t, _v, done) {
      done();
    },
    detach(_t, done) {
      done();
    },
    sendCommand(_t, method, params, done) {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      }
      if (
        method === 'Input.dispatchKeyEvent' &&
        params.type === 'keyDown' &&
        (params.key === 'Enter' || params.windowsVirtualKeyCode === 13) &&
        send
      ) {
        send.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      }
      chrome.runtime.lastError = null;
      done({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  };

  return {
    editor,
    send,
    thread,
    toast,
    aim: (el) => {
      target = el;
    },
  };
}

/** The ref of the first tree line whose text contains `needle`. */
async function refOf(page, needle) {
  const tree = (await page.call({ type: 'READ_PAGE', filter: 'interactive' })).text;
  const line = tree.split('\n').find((l) => l.includes(needle));
  if (!line) throw new Error('no tree line for ' + needle + ' in:\n' + tree);
  return /\[(ref_\d+)\]/.exec(line)[1];
}

async function ownTabGroup() {
  await globalThis.chrome.storage.local.set({ tabGroups: { default: 7 } });
}

test('a click on Send reports which submit signals fired', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'the deck is attached';
  await ownTabGroup();
  perms.invalidatePolicyCache();
  perms.forgetActedOrigin('default');

  const ref = await refOf(page, 'Send');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });

  assert.equal(result.ok, true);
  assert.equal(result.effects, 'applied');
  const submit = result.evidence.submit;
  assert.ok(submit, 'the submit evidence is under evidence.submit');
  assert.ok(submit.fired.includes('composer emptied'), 'fired: ' + submit.fired.join(', '));
  assert.ok(submit.fired.includes('a new node carries the text'), 'fired: ' + submit.fired.join(', '));
  assert.ok(submit.fired.includes('status region'), 'fired: ' + submit.fired.join(', '));
  assert.equal(submit.status.role, 'status');
  assert.equal(wired.thread.textContent, 'the deck is attached');
});

test('a Send that does nothing reports unknown and says to re-read', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page, { behaviour: 'nothing' });
  wired.editor.textContent = 'never leaves the box';
  await ownTabGroup();
  perms.invalidatePolicyCache();

  const ref = await refOf(page, 'Send');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });

  assert.equal(result.effects, 'unknown');
  assert.deepEqual(result.evidence.submit.fired, []);
  assert.equal(result.hint, 're-read the page before retrying');
  assert.ok(
    result.warnings.some((w) => /no submit evidence within 3000ms/.test(w)),
    'warnings: ' + result.warnings.join(' | ')
  );
  assert.equal(wired.thread.textContent, '');
});

test('a click that opened a modal reports applied, not unknown', async () => {
  // From the 0.1.35 rehearsal: the Delete menu item opened GitHub's confirm
  // modal, the watch counted 40 mutations and focus on its Cancel button, and
  // the result said effects: unknown because no submit signal had fired. The
  // watch saw the page move, so applied is the truthful value and the missing
  // submit evidence belongs in a warning.
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage(`<!doctype html><body>
    <div id="comment">a comment</div>
    <button id="del">Delete</button>
    <div id="modals"></div>
  </body>`);
  const wired = wireSubmit(page, { behaviour: 'nothing' });
  const { window } = page;
  const del = window.document.getElementById('del');
  wired.aim(del);
  del.addEventListener('click', () => {
    const modal = window.document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = '<p>Are you sure you want to delete this?</p>';
    const cancel = window.document.createElement('button');
    cancel.textContent = 'Cancel';
    modal.appendChild(cancel);
    window.document.getElementById('modals').appendChild(modal);
    cancel.focus();
  });
  await ownTabGroup();
  perms.invalidatePolicyCache();

  const ref = await refOf(page, 'Delete');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });

  assert.deepEqual(result.evidence.submit.fired, [], 'no submit signal fired');
  assert.ok(result.evidence.mutations >= 1, 'the watch counted the modal going in: ' + result.evidence.mutations);
  assert.equal(result.evidence.focusChanged, true, 'focus moved to the modal');
  assert.equal(result.effects, 'applied');
  assert.equal(result.hint, undefined, 'nothing tells the caller to retry a click that did something');
  assert.ok(
    result.warnings.some((w) => /no submit evidence fired/.test(w)),
    'warnings: ' + result.warnings.join(' | ')
  );
});

test('a sent message reports that nothing undoes it', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'on my way';
  await ownTabGroup();

  const ref = await refOf(page, 'Send');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  assert.equal(result.undo, 'none');
});

test('a saved edit names the control that reverses it', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(`<!doctype html><body>
    <form id="f"><input id="headline" value="Engineer"><button id="save" type="submit">Save</button></form>
    <button id="undo">Undo</button>
  </body>`);
  const wired = wireSubmit(page, { behaviour: 'nothing' });
  wired.aim(page.window.document.getElementById('save'));
  await ownTabGroup();

  const ref = await refOf(page, 'Save');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  assert.equal(result.undo, 'Undo', 'the reversible class looks for a control on the page after the write');
});

test('confirm mode refuses the first press and performs the tokened repeat', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'ship it';
  await ownTabGroup();
  perms.invalidatePolicyCache();
  await perms.savePolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: false });

  const ref = await refOf(page, 'Send');
  let token = null;
  await assert.rejects(
    () => tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' }),
    (err) => {
      assert.equal(err.code, 'confirmation_required');
      assert.equal(err.effects, 'none');
      assert.equal(err.details.control, 'Send');
      assert.equal(err.details.origin, 'https://example.com');
      assert.ok('screenshotId' in err.details, 'the details name the screenshot taken before the refusal');
      assert.match(err.hint, /confirm set to/);
      token = err.details.token;
      return true;
    }
  );
  assert.equal(wired.thread.textContent, '', 'nothing was clicked');

  const done = await tools.execute(
    'computer',
    { action: 'left_click', tabId: 1, ref, confirm: token },
    { clientId: 'default' }
  );
  assert.equal(done.effects, 'applied');
  assert.equal(done.write.control, 'Send');
  assert.equal(done.write.confirmedBy, 'token');
  assert.equal(done.write.value, 'ship it');
  assert.equal(wired.thread.textContent, 'ship it');

  await assert.rejects(
    () => tools.execute('computer', { action: 'left_click', tabId: 1, ref, confirm: token }, { clientId: 'default' }),
    (err) => {
      assert.equal(err.code, 'confirmation_required');
      assert.match(err.message, /not accepted/);
      return true;
    }
  );

  await perms.savePolicy({ mode: perms.MODES.ALLOW });
  perms.invalidatePolicyCache();
});

test('the write allow-list clicks an irreversible control with no token', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'routine';
  await ownTabGroup();
  perms.invalidatePolicyCache();
  await perms.savePolicy({ mode: perms.MODES.CONFIRM, writeAllowlist: ['example.com'] });

  const ref = await refOf(page, 'Send');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  assert.equal(result.effects, 'applied');
  assert.equal(result.write.confirmedBy, undefined, 'no confirmation was needed');
  assert.equal(wired.thread.textContent, 'routine');

  await perms.savePolicy({ mode: perms.MODES.ALLOW, writeAllowlist: [] });
  perms.invalidatePolicyCache();
});

test('an Enter in a composer is treated as a submit', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'sent with the keyboard';
  wired.editor.focus();
  await ownTabGroup();

  const result = await tools.execute('computer', { action: 'key', tabId: 1, text: 'Enter' }, { clientId: 'default' });

  assert.ok(result.evidence.submit, 'an Enter inside a composer gets the submit window');
  assert.equal(result.effects, 'applied');
  assert.ok(result.evidence.submit.fired.includes('composer emptied'));
  assert.equal(wired.thread.textContent, 'sent with the keyboard');
});

test('a submit leaves the paint window open for the capture that follows it', async () => {
  // The submit watch runs for up to SUBMIT_WINDOW_MS, so a capture right after
  // it used to land outside the 2000 ms paint window and carry no paint
  // evidence. Bug 2 from the third live pass.
  const tools = await import('../extension/src/lib/tools.js');
  const shot = await import('../extension/src/lib/screenshot.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'sent with the keyboard';
  wired.editor.focus();
  await ownTabGroup();
  shot.clearInputMark(1);

  const at = Date.now();
  await tools.execute('computer', { action: 'key', tabId: 1, text: 'Enter' }, { clientId: 'default' });

  assert.ok(
    shot.paintWaitWindow(1) >= tools.SUBMIT_WINDOW_MS,
    'the window is ' + shot.paintWaitWindow(1) + ', the submit watch is ' + tools.SUBMIT_WINDOW_MS
  );
  assert.equal(shot.needsPaintWait(1, at + tools.SUBMIT_WINDOW_MS), true);
  shot.clearInputMark(1);
});

test('the submit watch never carries a sensitive value', async () => {
  const page = loadPage(`<!doctype html><body>
    <form id="f"><input id="p" type="password"><button type="submit">Submit</button></form>
  </body>`);
  page.window.document.getElementById('p').focus();
  page.window.document.getElementById('p').value = 'hunter2';

  const armed = await page.call({ type: 'SUBMIT_ARM', ref: null });
  assert.equal(armed.sensitive, true);
  assert.equal(armed.text, null);
  assert.equal(JSON.stringify(armed).includes('hunter2'), false);
});

test('the classifier marks a submit button, a named Send, and neither for a plain link', () => {
  const page = loadPage(`<!doctype html><body>
    <form><button id="s" type="submit">OK</button></form>
    <button id="named">Post comment</button>
    <a id="plain" href="/about">About</a>
  </body>`);
  const { window, agent } = page;
  const el = (id) => window.document.getElementById(id);

  assert.equal(
    agent.isSubmitShaped(el('s'), 'button', 'OK'),
    true,
    'type=submit is submit-shaped whatever it is called'
  );
  assert.equal(agent.isSubmitShaped(el('named'), 'button', 'Post comment'), true);
  assert.equal(agent.isSubmitShaped(el('plain'), 'link', 'About'), false);
  assert.equal(agent.undoClass(el('named'), 'button', 'Post comment'), 'reversible');
  assert.equal(agent.undoClass(el('named'), 'button', 'Send message'), 'sent');
});

test('the GitHub controls that missed the window are submit-shaped', () => {
  // From the 0.1.35 write rehearsal: Create, Comment, Close issue and the
  // modal's Delete each ran the 250 ms window, and the navigation or the 2xx
  // that proved the write landed arrived after it closed.
  const page = loadPage(`<!doctype html><body>
    <div><button id="c">Create</button><button id="m">Comment</button>
    <button id="x">Close issue</button><button id="d">Delete</button>
    <button id="p">Preview</button><a id="a" href="/blog">Read the changelog</a></div>
  </body>`);
  const { window, agent } = page;
  const el = (id) => window.document.getElementById(id);

  assert.equal(agent.isSubmitShaped(el('c'), 'button', 'Create'), true);
  assert.equal(agent.isSubmitShaped(el('m'), 'button', 'Comment'), true);
  assert.equal(agent.isSubmitShaped(el('x'), 'button', 'Close issue'), true);
  assert.equal(agent.isSubmitShaped(el('d'), 'menuitem', 'Delete'), true, 'the menu item, not only the modal button');
  assert.equal(
    agent.isSubmitShaped(el('p'), 'button', 'Preview'),
    false,
    'a control that writes nothing keeps the short window'
  );
  assert.equal(agent.isSubmitShaped(el('a'), 'link', 'Read the changelog'), false);
  for (const word of ['confirm', 'remove', 'apply', 'update', 'OK', 'Done', 'Yes']) {
    assert.equal(agent.isSubmitShaped(el('c'), 'button', word), true, word + ' is submit-shaped');
  }
});

test('being submit-shaped does not make a control irreversible', () => {
  // The two lists are separate on purpose: Create and Comment get the longer
  // window without being reported as writes that cannot be taken back.
  const page = loadPage('<!doctype html><body><button id="b">Create</button></body>');
  const { window, agent } = page;
  const el = window.document.getElementById('b');

  assert.equal(agent.isSubmitShaped(el, 'button', 'Create'), true);
  assert.equal(agent.isIrreversibleControl(el, 'button', 'Create'), false);
  assert.equal(agent.isIrreversibleControl(el, 'button', 'Comment'), false);
  assert.equal(agent.isIrreversibleControl(el, 'button', 'Delete comment'), true, 'delete is still irreversible');
});

test('a Close issue click names Reopen issue as the way back', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(`<!doctype html><body>
    <div id="state">Open</div>
    <button id="close">Close issue</button>
  </body>`);
  const wired = wireSubmit(page, { behaviour: 'nothing' });
  const closeBtn = page.window.document.getElementById('close');
  wired.aim(closeBtn);
  // The site swaps the control for its opposite, which is where the undo
  // lookup finds the name to report.
  closeBtn.addEventListener('click', () => {
    page.window.document.getElementById('state').textContent = 'Closed';
    closeBtn.textContent = 'Reopen issue';
  });
  await ownTabGroup();

  const ref = await refOf(page, 'Close issue');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });

  assert.equal(result.undo, 'Reopen issue');
  assert.equal(result.evidence.submit.windowMs >= 0, true, 'the click ran the submit watch');
  assert.equal(result.irreversible, undefined, 'closing an issue is not on the irreversible list');
});

// ---------------------------------------------------------------------------
// Open bug 2: newTabId for a click that opens a tab
// ---------------------------------------------------------------------------
//
// Chrome creates the tab after the 250 ms window has closed, so the click
// reported no newTabId for a tab that existed a second later. The watch now
// says at arm time whether the element opens a tab, and only that click waits.

test('the watch reports that a target=_blank link opens a tab', async () => {
  const page = loadPage(`<!doctype html><body>
    <a id="blank" href="https://example.com/" target="_blank">blank link</a>
    <a id="same" href="/here">same tab link</a>
    <button id="opener" onclick="window.open('https://example.com/')">popup</button>
    <button id="plain">plain</button>
  </body>`);
  const { window, call } = page;

  const arm = async (id) => {
    window.document.elementFromPoint = () => window.document.getElementById(id);
    const armed = await call({ type: 'VERIFY_ARM', point: { x: 10, y: 10 } });
    await call({ type: 'VERIFY_REPORT', window: 0 });
    return armed.opensTab;
  };

  assert.equal(await arm('blank'), true, 'target=_blank');
  assert.equal(await arm('opener'), true, 'an inline window.open handler');
  assert.equal(await arm('same'), false, 'a link that stays in the tab');
  assert.equal(await arm('plain'), false, 'an ordinary button');
});

test('the watch reads target=_blank off an ancestor of the clicked node', async () => {
  const page = loadPage(
    '<!doctype html><body><a id="blank" href="/x" target="_blank"><span id="inner">go</span></a></body>'
  );
  page.window.document.elementFromPoint = () => page.window.document.getElementById('inner');
  const armed = await page.call({ type: 'VERIFY_ARM', point: { x: 10, y: 10 } });
  assert.equal(armed.opensTab, true);
});

const BLANK_LINK = `<!doctype html><body>
  <a id="blank" href="https://example.com/" target="_blank">blank link</a>
  <button id="plain">plain</button>
</body>`;

test('a click on a target=_blank link waits for the tab and reports newTabId', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const tabsLib = await import('../extension/src/lib/tabs.js');
  const page = loadPage(BLANK_LINK);
  const wired = wireSubmit(page);
  wired.aim(page.window.document.getElementById('blank'));
  await ownTabGroup();

  // Chrome opens the tab well after the ordinary window has closed.
  const opened = setTimeout(() => tabsLib.noteOpenedTab({ id: 99, openerTabId: 1 }), 600);

  const ref = await refOf(page, 'blank link');
  const started = Date.now();
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  clearTimeout(opened);

  assert.equal(result.ok, true);
  assert.equal(result.newTabId, 99, 'the click result names the tab it opened');
  assert.match(result.note, /new tab \(tab ID 99\)/);
  assert.equal(result.evidence.newTabId, 99);
  assert.equal(result.evidence.opensTab, true);
  assert.equal(result.evidence.waitedForTab, true);
  assert.ok(Date.now() - started >= 550, 'it waited for the tab rather than reporting none');
  assert.ok(Date.now() - started < 1600, 'and stopped at the cap');
  assert.deepEqual(tabsLib.peekAdopted(1), [], 'the read consumed the bookkeeping');
});

test('an ordinary click does not wait for a tab that is never coming', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(BLANK_LINK);
  const wired = wireSubmit(page);
  wired.aim(page.window.document.getElementById('plain'));
  await ownTabGroup();

  const ref = await refOf(page, 'plain');
  const started = Date.now();
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  const elapsed = Date.now() - started;

  assert.equal(result.newTabId, undefined);
  assert.equal(result.evidence.opensTab, undefined);
  assert.equal(result.evidence.waitedForTab, undefined, 'no grace is added to an ordinary click');
  assert.ok(elapsed < 900, 'an ordinary click still costs the ordinary window: ' + elapsed + 'ms');
});

test('a click that opens a tab stops waiting as soon as the tab arrives', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const tabsLib = await import('../extension/src/lib/tabs.js');
  const page = loadPage(BLANK_LINK);
  const wired = wireSubmit(page);
  wired.aim(page.window.document.getElementById('blank'));
  await ownTabGroup();

  tabsLib.noteOpenedTab({ id: 101, openerTabId: 1 });
  const ref = await refOf(page, 'blank link');
  const started = Date.now();
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });

  assert.equal(result.newTabId, 101);
  assert.equal(result.evidence.waitedForTab, undefined, 'a tab already recorded costs no extra wait');
  assert.ok(Date.now() - started < 900);
});

test('a tab Chrome credited to the wrong opener is still reported', async () => {
  // Chrome fills openerTabId from the window's active tab, and background mode
  // never activates the tab being driven. Measured on Chrome for Testing 152: a
  // click on a target="_blank" link in tab 369885084 produced a tab whose
  // openerTabId was the browser's initial about:blank tab, so the opener route
  // found nothing and the click reported no newTabId for a tab that existed.
  const tools = await import('../extension/src/lib/tools.js');
  const tabsLib = await import('../extension/src/lib/tabs.js');
  tabsLib.resetRecentOpens();
  const page = loadPage(BLANK_LINK);
  const wired = wireSubmit(page);
  wired.aim(page.window.document.getElementById('blank'));
  await ownTabGroup();

  // openerTabId 7 is some other tab entirely, which is what Chrome reports.
  const opened = setTimeout(() => tabsLib.noteOpenedTab({ id: 202, openerTabId: 7 }), 400);

  const ref = await refOf(page, 'blank link');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  clearTimeout(opened);

  assert.equal(result.newTabId, 202, 'the tab is named through the ledger rather than the opener');
  assert.equal(result.evidence.waitedForTab, true);
  assert.deepEqual(tabsLib.peekAdopted(1), [], 'nothing was credited to the acting tab by mistake');
  tabsLib.resetRecentOpens();
});

test('a tab opened outside the acting tab group is not claimed', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const tabsLib = await import('../extension/src/lib/tabs.js');
  tabsLib.resetRecentOpens();
  const page = loadPage(BLANK_LINK);
  const wired = wireSubmit(page);
  wired.aim(page.window.document.getElementById('blank'));
  await ownTabGroup();

  const get = globalThis.chrome.tabs.get;
  globalThis.chrome.tabs.get = async (id) => ({ ...(await get(id)), id, groupId: id === 303 ? 42 : 7 });

  const opened = setTimeout(() => tabsLib.noteOpenedTab({ id: 303, openerTabId: 7 }), 300);
  const ref = await refOf(page, 'blank link');
  const result = await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  clearTimeout(opened);
  globalThis.chrome.tabs.get = get;

  assert.equal(result.newTabId, undefined, 'a tab in another group belongs to someone else');
  tabsLib.resetRecentOpens();
});

// ---------------------------------------------------------------------------
// Open bug 6: resize_window did not resize
// ---------------------------------------------------------------------------
//
// The evidence a resize produces is the same question the watch answers for a
// click: did the action land. A resize to 1000x700 left a maximized window at
// 1200x900 and reported matched "neither", so the failure was visible and the
// resize never happened. Chrome ignores a size that arrives in the same
// windows.update as the state change.

/**
 * A window whose size Chrome only accepts once the state is already normal,
 * which is the behaviour that made the resize a no-op.
 */
function wireWindow(page, { state = 'normal', width = 1200, height = 900, refuses = false, dpr = 1 } = {}) {
  const { window, call } = page;
  const updates = [];
  let bounds = { width, height, state };

  const paint = () => {
    window.outerWidth = bounds.width;
    window.outerHeight = bounds.height;
    window.innerWidth = bounds.width - 12;
    window.innerHeight = bounds.height - 149;
  };
  paint();
  window.devicePixelRatio = dpr;

  globalThis.chrome.windows = {
    async get() {
      return { id: 1, ...bounds };
    },
    async update(_id, props) {
      updates.push({ ...props });
      if (props.state) {
        bounds = { ...bounds, state: props.state };
        return;
      }
      // A maximized window ignores a size, and so does a window manager that
      // has decided otherwise.
      if (bounds.state !== 'normal' || refuses) return;
      if (typeof props.width === 'number') bounds = { ...bounds, width: props.width, height: props.height };
      paint();
    },
    async create() {
      return { tabs: [{ id: 1, windowId: 1 }] };
    },
  };

  globalThis.chrome.tabs.sendMessage = (_id, message) => new Promise((resolve) => call(message).then(resolve));
  return { updates, bounds: () => bounds };
}

const PLAIN_PAGE = '<!doctype html><body><p>a page to measure</p></body>';

test('a maximized window is set to normal first, then resized', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(PLAIN_PAGE);
  const wired = wireWindow(page, { state: 'maximized' });
  await ownTabGroup();

  const result = await tools.execute('resize_window', { tabId: 1, width: 1000, height: 700 }, { clientId: 'default' });

  assert.deepEqual(wired.updates[0], { state: 'normal' }, 'the state change goes on its own');
  assert.deepEqual(wired.updates[1], { width: 1000, height: 700 }, 'the size follows it');
  assert.deepEqual(wired.bounds(), { width: 1000, height: 700, state: 'normal' });
  assert.equal(result.matched, 'outer');
  assert.equal(result.outerWidth, 1000);
  assert.equal(result.effects, 'applied');
  assert.deepEqual(result.evidence.windowBounds.before, { width: 1200, height: 900, state: 'maximized' });
  assert.deepEqual(result.evidence.windowBounds.after, { width: 1000, height: 700, state: 'normal' });
  assert.equal(result.warnings.length, 0);
});

test('a window already normal is resized without touching its state', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(PLAIN_PAGE);
  const wired = wireWindow(page, { state: 'normal' });
  await ownTabGroup();

  const result = await tools.execute('resize_window', { tabId: 1, width: 900, height: 650 }, { clientId: 'default' });

  assert.deepEqual(wired.updates, [{ width: 900, height: 650 }], 'one update, and no state change');
  assert.equal(result.matched, 'outer');
  assert.equal(result.viewport.width, 888, 'the viewport is reported as well as the outer size');
});

test('a window manager that refuses the size is reported as a refusal, after a retry', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(PLAIN_PAGE);
  const wired = wireWindow(page, { state: 'normal', refuses: true });
  await ownTabGroup();

  const result = await tools.execute('resize_window', { tabId: 1, width: 1000, height: 700 }, { clientId: 'default' });

  assert.equal(wired.updates.length, 2, 'the size was sent again once the read-back showed it had not taken');
  assert.equal(result.matched, 'neither');
  assert.equal(result.effects, 'none');
  assert.ok(
    result.warnings.some((w) => /1200x900 outer/.test(w)),
    'warnings: ' + result.warnings.join(' | ')
  );
  assert.deepEqual(result.evidence.windowBounds.after, { width: 1200, height: 900, state: 'normal' });
});

test('a request in device pixels is named as such rather than left unexplained', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(PLAIN_PAGE);
  wireWindow(page, { state: 'normal', refuses: true, dpr: 2.25 });
  await ownTabGroup();

  const result = await tools.execute('resize_window', { tabId: 1, width: 2700, height: 2025 }, { clientId: 'default' });

  assert.equal(result.matched, 'neither');
  assert.equal(result.evidence.devicePixelRatio, 2.25);
  assert.ok(
    result.warnings.some((w) => /device pixel ratio of 2.25/.test(w)),
    'warnings: ' + result.warnings.join(' | ')
  );
});

test('a resize never activates a tab or focuses a window', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(PLAIN_PAGE);
  const wired = wireWindow(page, { state: 'maximized' });
  const tabUpdates = [];
  const originalUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.update = async (id, props) => {
    tabUpdates.push(props);
  };
  await ownTabGroup();

  await tools.execute('resize_window', { tabId: 1, width: 1000, height: 700 }, { clientId: 'default' });

  globalThis.chrome.tabs.update = originalUpdate;
  assert.deepEqual(tabUpdates, [], 'no tab was activated');
  assert.equal(
    wired.updates.some((u) => u.focused !== undefined || u.drawAttention !== undefined),
    false,
    'no window was focused'
  );
});

// ---------------------------------------------------------------------------
// The find result says when the query named a role the page does not have
// ---------------------------------------------------------------------------

test('find warns that no candidate carries the role the query named', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const page = loadPage(`<!doctype html><body>
    <button>Edit title</button><button>Copy title</button><button>Add a title</button>
  </body>`);
  wireSubmit(page, { behaviour: 'nothing' });
  await ownTabGroup();

  const result = await tools.execute('find', { tabId: 1, query: 'issue title field' }, { clientId: 'default' });

  assert.equal(result.effects, 'none');
  assert.ok(result.matches.length, 'the ranking still answers with what it has');
  assert.ok(
    result.warnings.some((w) => /^no textbox matched, \d+ buttons? shown instead$/.test(w)),
    'warnings: ' + result.warnings.join(' | ')
  );
  assert.match(result.evidence.roleGap, /no textbox matched/);
});

// ---------------------------------------------------------------------------
// Open bug 3 from the 0.1.34 pass: the before-write capture
// ---------------------------------------------------------------------------
//
// The image a confirmation_required tells the caller to show the user carried
// the orange border and the red Stop capsule, which the ordinary screenshot
// path and the gif frames both hide.

test('the capture a confirmation points at is taken with the acting indicator hidden', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage(THREAD);
  const wired = wireSubmit(page);
  wired.editor.textContent = 'ship it';
  await ownTabGroup();
  perms.invalidatePolicyCache();
  await perms.savePolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: false });

  const ref = await refOf(page, 'Send');

  const seen = [];
  const inner = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = (id, message) => {
    seen.push(message && message.type);
    return inner(id, message);
  };
  try {
    await assert.rejects(
      () => tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' }),
      (err) => {
        assert.equal(err.code, 'confirmation_required');
        return true;
      }
    );
  } finally {
    globalThis.chrome.tabs.sendMessage = inner;
  }

  const hide = seen.indexOf('HIDE_FOR_TOOL_USE');
  const show = seen.indexOf('SHOW_AFTER_TOOL_USE');
  assert.ok(hide >= 0, 'the capture hid the indicator first: ' + seen.join(', '));
  assert.ok(show > hide, 'and put it back after: ' + seen.join(', '));
  assert.equal(wired.thread.textContent, '', 'nothing was clicked');

  await perms.savePolicy({ mode: perms.MODES.ALLOW });
  perms.invalidatePolicyCache();
});

test('a click that needs no confirmation sends no hide of its own', async () => {
  const tools = await import('../extension/src/lib/tools.js');
  const perms = await import('../extension/src/lib/permissions.js');
  const page = loadPage('<!doctype html><body><button id="b">Open</button><div id="thread"></div></body>');
  const wired = wireSubmit(page, { behaviour: 'nothing' });
  wired.aim(page.window.document.getElementById('b'));
  await ownTabGroup();
  perms.invalidatePolicyCache();
  perms.forgetActedOrigin('default');

  const ref = await refOf(page, 'Open');

  const seen = [];
  const inner = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = (id, message) => {
    seen.push(message && message.type);
    return inner(id, message);
  };
  try {
    await tools.execute('computer', { action: 'left_click', tabId: 1, ref }, { clientId: 'default' });
  } finally {
    globalThis.chrome.tabs.sendMessage = inner;
  }

  assert.ok(
    !seen.includes('HIDE_FOR_TOOL_USE'),
    'the hide belongs to a capture, and no capture was taken: ' + seen.join(', ')
  );
});
