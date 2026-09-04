// F4/D2: the acting-indicator overlay (indicator.js), sharing the cursor's
// closed shadow root (agent.js). Covers the three visual states, the trusted
// click requirement on Stop and Resume, the hide-before-capture behaviour and
// the per-session random overlay id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const AGENT_SOURCE = readFileSync(new URL('../extension/src/content/agent.js', import.meta.url), 'utf8');
const INDICATOR_SOURCE = readFileSync(new URL('../extension/src/content/indicator.js', import.meta.url), 'utf8');

/** Loads both content scripts into a fresh jsdom window, as the real page gets them. */
function loadPage() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://example.test/page',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.innerWidth = 1024;
  window.innerHeight = 768;
  window.Element.prototype.scrollIntoView = function () {};
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  };

  const listeners = [];
  const sent = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (message, cb) => {
        sent.push(message);
        if (cb) cb({ ok: true });
      },
      lastError: null,
    },
  };

  window.eval(AGENT_SOURCE);
  window.eval(INDICATOR_SOURCE);
  assert.equal(listeners.length, 2, 'both content scripts register a message listener');

  // Mirrors chrome.runtime.onMessage: every listener sees every message.
  const dispatch = (message) => {
    for (const fn of listeners) fn(message, {}, () => {});
  };

  const agentApi = window.__autopilotAgent;
  const shadow = agentApi.overlayShadow();

  return { window, dom, dispatch, sent, agentApi, shadow };
}

function ind(shadow, selector) {
  return shadow.querySelector(selector);
}

// ---------------------------------------------------------------------------
// D2: the per-session random host id
// ---------------------------------------------------------------------------

test('the overlay host carries a random id, not the old fixed one', () => {
  const { window, agentApi } = loadPage();
  assert.notEqual(agentApi.cursorHostId, '__autopilot_cursor__');
  assert.match(agentApi.cursorHostId, /^__ap_[a-z0-9]+__$/);
  assert.ok(window.document.getElementById(agentApi.cursorHostId), 'the host is reachable by its own id');
});

test('two content-script installs get two different host ids', () => {
  const a = loadPage();
  const b = loadPage();
  assert.notEqual(a.agentApi.cursorHostId, b.agentApi.cursorHostId);
});

// ---------------------------------------------------------------------------
// F4: the three states
// ---------------------------------------------------------------------------

test('pulsing draws the border on and shows the Stop button', () => {
  const { dispatch, shadow } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'pulsing' });

  assert.equal(ind(shadow, '.ind-border').classList.contains('on'), true);
  assert.equal(ind(shadow, '.ind-stop-wrap').hidden, false);
  assert.equal(ind(shadow, '.ind-pill').hidden, true);
});

// The `hidden` property is only half the answer. The pill's own rule sets
// `display:flex`, an author declaration that beats the user agent's
// `[hidden]{display:none}`, so a pill marked hidden still painted: a driven tab
// carried an empty dark capsule at the bottom of the viewport, visible in a
// screenshot taken through the DevTools port. Every element the indicator
// toggles through `hidden` has to say so in its own stylesheet.
test('the stylesheet makes hidden actually hide the toggled elements', () => {
  const { dispatch, shadow } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'pulsing' });
  const css = [...shadow.querySelectorAll('style')].map((s) => s.textContent).join('');
  for (const selector of ['.ind-pill[hidden]', '.ind-pill-btn[hidden]', '.ind-stop-wrap[hidden]']) {
    assert.ok(css.includes(selector), selector + ' needs a display:none rule of its own');
  }
  assert.match(css, /\[hidden\][^{]*\{display:none;?\}/);
});

test('static shows the driving pill with no button, and no border or Stop', () => {
  const { dispatch, shadow } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'static' });

  assert.equal(ind(shadow, '.ind-border').classList.contains('on'), false);
  assert.equal(ind(shadow, '.ind-stop-wrap').hidden, true);
  assert.equal(ind(shadow, '.ind-pill').hidden, false);
  assert.match(ind(shadow, '.ind-pill-text').textContent, /driving this tab/);
  assert.equal(ind(shadow, '.ind-pill-btn').hidden, true);
});

test('stopped shows the pill with a Resume button and a different message', () => {
  const { dispatch, shadow } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'stopped' });

  assert.equal(ind(shadow, '.ind-pill').hidden, false);
  assert.match(ind(shadow, '.ind-pill-text').textContent, /stopped/);
  assert.equal(ind(shadow, '.ind-pill-btn').hidden, false);
  assert.equal(ind(shadow, '.ind-pill-btn').textContent, 'Resume');
});

test('none hides the border, the pill and the Stop button', () => {
  const { dispatch, shadow } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'pulsing' });
  dispatch({ type: 'INDICATOR_STATE', state: 'none' });

  assert.equal(ind(shadow, '.ind-border').classList.contains('on'), false);
  assert.equal(ind(shadow, '.ind-stop-wrap').hidden, true);
  assert.equal(ind(shadow, '.ind-pill').hidden, true);
});

// ---------------------------------------------------------------------------
// F4: the trusted-click requirement
// ---------------------------------------------------------------------------

test('a script-dispatched (untrusted) click on Stop sends nothing', () => {
  const { window, dispatch, shadow, sent } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'pulsing' });

  const stopBtn = ind(shadow, '.ind-stop');
  // jsdom cannot produce a trusted click (isTrusted is unforgeable), so this
  // is exactly the shape a page script's synthetic click would take, and it
  // is the case the isTrusted check exists to block.
  stopBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(sent, [], 'no stop message was sent for an untrusted click');
});

test('a script-dispatched (untrusted) click on Resume sends nothing', () => {
  const { window, dispatch, shadow, sent } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'stopped' });

  const resumeBtn = ind(shadow, '.ind-pill-btn');
  resumeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(sent, [], 'no resume message was sent for an untrusted click');
});

// ---------------------------------------------------------------------------
// The hide-before-capture path (shared with the cursor overlay)
// ---------------------------------------------------------------------------

test('HIDE_FOR_TOOL_USE hides the indicator along with the cursor, SHOW_AFTER_TOOL_USE restores it', () => {
  const { window, dispatch, agentApi } = loadPage();
  dispatch({ type: 'INDICATOR_STATE', state: 'pulsing' });

  const host = window.document.getElementById(agentApi.cursorHostId);
  assert.notEqual(host.style.display, 'none');

  dispatch({ type: 'HIDE_FOR_TOOL_USE' });
  assert.equal(host.style.display, 'none', 'the whole overlay host is hidden, indicator included');

  dispatch({ type: 'SHOW_AFTER_TOOL_USE' });
  assert.equal(host.style.display, 'block');
});
