// Content script, injected at document_start alongside agent.js.
//
// Draws the three-state acting indicator (F4): a pulsing border around the
// viewport while a call is running on this tab, a small static pill on a
// tab that is part of the session but not the one currently being acted on,
// and a floating Stop button. It shares the closed shadow root the cursor
// overlay (agent.js) draws into, addressed through the module-level
// `globalThis.__chromeMcpAgent.overlayShadow` accessor (D2), so the same
// `HIDE_FOR_TOOL_USE` / `SHOW_AFTER_TOOL_USE` pair that keeps the cursor out
// of a screenshot keeps this out too. See IMPROVEMENTS.md F4 and D2, and
// evidence/X-official-internals.md part 1 section 13.

(() => {
  if (globalThis.__chromeMcpIndicatorInstalled) return;
  globalThis.__chromeMcpIndicatorInstalled = true;

  const CSS =
    // The border sits just inside the viewport edge so it reads as a frame
    // around the page rather than clipping content under it.
    '.ind{position:fixed;inset:0;pointer-events:none;}' +
    '.ind-border{position:fixed;inset:0;pointer-events:none;' +
    'box-shadow:inset 0 0 0 3px rgba(217,119,87,0);' +
    'transition:box-shadow .2s ease;}' +
    '.ind-border.on{box-shadow:inset 0 0 0 3px rgba(217,119,87,.85);}' +
    '@media (prefers-reduced-motion: no-preference){' +
    '.ind-border.on{animation:ind-pulse 2.2s ease-in-out infinite;}' +
    '}' +
    '@keyframes ind-pulse{' +
    '0%,100%{box-shadow:inset 0 0 0 3px rgba(217,119,87,.55);}' +
    '50%{box-shadow:inset 0 0 0 5px rgba(217,119,87,.95);}' +
    '}' +
    '.ind-pill{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);' +
    'display:flex;align-items:center;gap:8px;' +
    'background:#1f2126;color:#f2ede7;font:500 12px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'padding:6px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35);' +
    'pointer-events:none;}' +
    '.ind-pill-btn{pointer-events:auto;cursor:pointer;border:none;border-radius:999px;' +
    'background:#d97757;color:#1f2126;font:600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'padding:5px 10px;}' +
    '.ind-stop-wrap{position:fixed;right:16px;bottom:16px;pointer-events:none;}' +
    '.ind-stop{pointer-events:auto;cursor:pointer;border:none;border-radius:999px;' +
    'background:#c0392b;color:#fff;font:600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
    'padding:8px 16px;box-shadow:0 2px 10px rgba(0,0,0,.35);}';

  let root = null;
  let styleInstalled = false;
  let borderEl = null;
  let pillEl = null;
  let pillTextEl = null;
  let pillBtnEl = null;
  let stopWrapEl = null;
  let currentState = 'none';

  function agentApi() {
    return globalThis.__chromeMcpAgent || null;
  }

  /** Builds the indicator's own elements into the shared overlay shadow root, once. */
  function ensureBuilt() {
    const api = agentApi();
    if (!api || typeof api.overlayShadow !== 'function') return null;
    const shadow = api.overlayShadow();
    if (!shadow) return null;
    if (root && root.isConnected) return shadow;

    if (!styleInstalled) {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      styleInstalled = true;
    }

    root = document.createElement('div');
    root.className = 'ind';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<div class="ind-border"></div>' +
      '<div class="ind-pill" hidden><span class="ind-pill-text"></span>' +
      '<button type="button" class="ind-pill-btn" hidden>Resume</button></div>' +
      '<div class="ind-stop-wrap" hidden><button type="button" class="ind-stop">Stop</button></div>';
    shadow.appendChild(root);

    borderEl = root.querySelector('.ind-border');
    pillEl = root.querySelector('.ind-pill');
    pillTextEl = root.querySelector('.ind-pill-text');
    pillBtnEl = root.querySelector('.ind-pill-btn');
    stopWrapEl = root.querySelector('.ind-stop-wrap');

    // Only a real, trusted click stops or resumes a session. A page script
    // has no way to reach an element inside a closed shadow root, but the
    // isTrusted check is the check that actually matters: it is what stops a
    // synthetic click dispatched by anything that did get a reference from
    // acting on the user's behalf.
    stopWrapEl.querySelector('.ind-stop').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      chrome.runtime.sendMessage({ type: 'stop' }, () => void chrome.runtime.lastError);
    });
    pillBtnEl.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      chrome.runtime.sendMessage({ type: 'resume' }, () => void chrome.runtime.lastError);
    });

    render();
    return shadow;
  }

  /** Applies `currentState` to the built elements. A no-op until they exist. */
  function render() {
    if (!borderEl) return;
    const pulsing = currentState === 'pulsing';
    const stopped = currentState === 'stopped';
    const staticPill = currentState === 'static' || stopped;

    borderEl.classList.toggle('on', pulsing);
    stopWrapEl.hidden = !pulsing;
    pillEl.hidden = !staticPill;
    if (staticPill) {
      pillTextEl.textContent = stopped
        ? 'Lantern stopped acting on this tab.'
        : 'Lantern is driving this tab.';
      pillBtnEl.hidden = !stopped;
    }
  }

  function setState(state) {
    currentState = state || 'none';
    if (currentState === 'none' && !root) return;
    ensureBuilt();
    render();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'INDICATOR_STATE') return false;
    setState(msg.state);
    sendResponse({ ok: true });
    return false;
  });

  // Reachable from tests, and from any other module in this isolated world
  // that needs to read or drive the indicator without going through
  // messaging.
  globalThis.__chromeMcpIndicator = { setState, getState: () => currentState };
})();
