// Chrome DevTools Protocol wrapper.
//
// All input is dispatched through CDP so events arrive with isTrusted true.
// Synthetic DOM events are rejected by file inputs, native drag and drop, and
// most bot detection, so there is no synthetic fallback path.

import { ToolError } from './errors.js';

const PROTOCOL_VERSION = '1.3';

/** @type {Map<number, {attached: boolean, refs: number}>} */
const attachments = new Map();

/** Modifier bitmask used by Input.dispatchKeyEvent and dispatchMouseEvent. */
const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, shift: 8 };

export function modifiersToMask(modifiers) {
  if (!modifiers) return 0;
  let mask = 0;
  for (const part of String(modifiers).toLowerCase().split('+')) {
    const bit = MOD[part.trim()];
    if (bit) mask |= bit;
  }
  return mask;
}

// windowsVirtualKeyCode, code, and key for the named keys we accept.
const KEYS = {
  enter: { vk: 13, code: 'Enter', key: 'Enter', text: '\r' },
  return: { vk: 13, code: 'Enter', key: 'Enter', text: '\r' },
  tab: { vk: 9, code: 'Tab', key: 'Tab', text: '\t' },
  escape: { vk: 27, code: 'Escape', key: 'Escape' },
  esc: { vk: 27, code: 'Escape', key: 'Escape' },
  backspace: { vk: 8, code: 'Backspace', key: 'Backspace' },
  delete: { vk: 46, code: 'Delete', key: 'Delete' },
  space: { vk: 32, code: 'Space', key: ' ', text: ' ' },
  up: { vk: 38, code: 'ArrowUp', key: 'ArrowUp' },
  arrowup: { vk: 38, code: 'ArrowUp', key: 'ArrowUp' },
  down: { vk: 40, code: 'ArrowDown', key: 'ArrowDown' },
  arrowdown: { vk: 40, code: 'ArrowDown', key: 'ArrowDown' },
  left: { vk: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  arrowleft: { vk: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  right: { vk: 39, code: 'ArrowRight', key: 'ArrowRight' },
  arrowright: { vk: 39, code: 'ArrowRight', key: 'ArrowRight' },
  home: { vk: 36, code: 'Home', key: 'Home' },
  end: { vk: 35, code: 'End', key: 'End' },
  pageup: { vk: 33, code: 'PageUp', key: 'PageUp' },
  pagedown: { vk: 34, code: 'PageDown', key: 'PageDown' },
  insert: { vk: 45, code: 'Insert', key: 'Insert' },
};
for (let i = 1; i <= 12; i++) {
  KEYS['f' + i] = { vk: 111 + i, code: 'F' + i, key: 'F' + i };
}
for (let c = 97; c <= 122; c++) {
  const ch = String.fromCharCode(c);
  KEYS[ch] = { vk: c - 32, code: 'Key' + ch.toUpperCase(), key: ch, text: ch };
}
for (let d = 0; d <= 9; d++) {
  KEYS[String(d)] = { vk: 48 + d, code: 'Digit' + d, key: String(d), text: String(d) };
}

export class CdpError extends Error {}

/** A command that did not answer within its timeout, before the wake and retry. */
class CdpTimeout extends CdpError {}

function lastError() {
  const err = chrome.runtime.lastError;
  return err ? new CdpError(err.message) : null;
}

// ---------------------------------------------------------------------------
// Notes raised outside the tool result
// ---------------------------------------------------------------------------

/**
 * Things that happened underneath a tool call and belong in its result: a
 * dialog that was handled, an attach that only succeeded after a recovery.
 *
 * The call that triggers them is several layers above this module and does not
 * return through here, so they are collected per call instead. A note raised
 * with no call in flight (a dialog opened by a page timer, say) is carried into
 * the next call's warnings rather than dropped.
 */
let callNotes = null;
const orphanNotes = [];
const MAX_ORPHAN_NOTES = 10;

export function beginCall() {
  callNotes = orphanNotes.splice(0, orphanNotes.length);
}

/** Ends the current call and returns everything noted during it. */
export function endCall() {
  const notes = callNotes || [];
  callNotes = null;
  return notes;
}

function note(entry) {
  if (callNotes) {
    callNotes.push(entry);
    return;
  }
  orphanNotes.push(entry);
  while (orphanNotes.length > MAX_ORPHAN_NOTES) orphanNotes.shift();
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

const ATTACH_RECOVERY_KEY = 'attachRecovery';
const RECOVERY_RETRIES = 4;
const RECOVERY_SETTLE_MS = 75;
const REATTACH_WAIT_MS = 250;

/** Chrome's refusal when another extension holds a frame in the tab. */
const FOREIGN_FRAME = /Cannot access a chrome-extension/i;

function isForeignFrameError(err) {
  return FOREIGN_FRAME.test((err && err.message) || '');
}

function rawAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      const err = lastError();
      if (err) return reject(err);
      resolve();
    });
  });
}

function rawDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      lastError();
      attachments.delete(tabId);
      awake.delete(tabId);
      resolve();
    });
  });
}

/**
 * Replaces a tab whose debugger cannot be attached. Registered by the service
 * worker so this module does not have to import the tab bookkeeping it would
 * then be imported by in turn.
 * @type {null | ((tabId: number) => Promise<null | {oldTabId: number, newTabId: number, url: string}>)}
 */
let sessionReplacer = null;

export function setSessionReplacer(fn) {
  sessionReplacer = fn;
}

async function recoveryEnabled() {
  try {
    const stored = await chrome.storage.local.get(ATTACH_RECOVERY_KEY);
    return stored[ATTACH_RECOVERY_KEY] !== false;
  } catch {
    return true;
  }
}

/**
 * Counts the iframes a frame holds, piercing open and closed shadow roots.
 *
 * Runs in the page. A frame holding more iframes than the frame tree says it
 * has children is holding one Chrome does not consider navigable, which is what
 * an extension's injected iframe looks like from here.
 */
function countIframesInFrame() {
  const shadowOf = (el) => {
    try {
      if (chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      /* not an element that can hold one */
    }
    return el.shadowRoot || null;
  };
  let count = 0;
  const walk = (root, depth) => {
    if (depth > 20) return;
    let iframes = [];
    let all = [];
    try {
      iframes = root.querySelectorAll('iframe');
      all = root.querySelectorAll('*');
    } catch {
      return;
    }
    count += iframes.length;
    for (const el of all) {
      const shadow = shadowOf(el);
      if (shadow) walk(shadow, depth + 1);
    }
  };
  walk(document, 0);
  return { count, url: location.href };
}

/** Removes iframes belonging to another extension. Runs in the page. */
function removeForeignIframes(ownId) {
  const PREFIX = 'chrome-extension://';
  const mine = PREFIX + ownId;
  const removed = [];
  const shadowOf = (el) => {
    try {
      if (chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      /* not an element that can hold one */
    }
    return el.shadowRoot || null;
  };
  const walk = (root, depth) => {
    if (depth > 20) return;
    let iframes = [];
    let all = [];
    try {
      iframes = root.querySelectorAll('iframe');
      all = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const frame of iframes) {
      const src = frame.src || frame.getAttribute('src') || '';
      if (src.indexOf(PREFIX) === 0 && src.indexOf(mine) !== 0) {
        removed.push(src);
        frame.remove();
      }
    }
    for (const el of all) {
      const shadow = shadowOf(el);
      if (shadow) walk(shadow, depth + 1);
    }
  };
  walk(document, 0);
  return removed;
}

/**
 * One pass of the recovery: find the frames holding an iframe Chrome does not
 * know about, and remove the ones pointing at another extension.
 */
async function stripExtensionInterference(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return [];
  const knownChildren = new Map();
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    for (const frame of frames) {
      if (frame.parentFrameId === undefined || frame.parentFrameId === -1) continue;
      knownChildren.set(frame.parentFrameId, (knownChildren.get(frame.parentFrameId) || 0) + 1);
    }
  } catch {
    /* without the frame tree every frame is a candidate */
  }

  let counted = [];
  try {
    counted = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: countIframesInFrame,
    });
  } catch {
    return [];
  }

  const suspects = (counted || [])
    .filter((entry) => entry && entry.result && entry.result.count > (knownChildren.get(entry.frameId) || 0))
    .map((entry) => entry.frameId);
  if (!suspects.length) return [];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: suspects },
      func: removeForeignIframes,
      args: [chrome.runtime.id],
    });
    return (results || []).flatMap((entry) => (entry && entry.result) || []);
  } catch {
    return [];
  }
}

/**
 * Attaches the debugger, recovering from the two refusals that otherwise take a
 * tab out of service.
 *
 * A tab carrying an iframe from another extension is refused outright, and the
 * campaign lost a tab to it on every x.com run. Removing that iframe and
 * retrying gets the tab back. When it does not, the session tab is replaced by
 * a fresh one on the same URL so the caller is never left holding a tab it
 * cannot drive.
 */
export async function attach(tabId, { recover = true } = {}) {
  installDetachListener();

  const state = attachments.get(tabId);
  if (state && state.attached) {
    state.refs++;
    return { attached: true, recovered: false };
  }

  try {
    await rawAttach(tabId);
    attachments.set(tabId, { attached: true, refs: 1 });
    return { attached: true, recovered: false };
  } catch (err) {
    // Chrome allows one debugger client per target, so this is DevTools or
    // another extension holding the tab. Recording it as ours made the next
    // command fail with a message that named nothing.
    if (/already attached/i.test(err.message)) {
      throw new ToolError(
        'attach_refused',
        'chrome.debugger.attach refused on tab ' + tabId + ': another debugger is attached. Close DevTools on that tab.',
        { cause: err.message, effects: 'none', retryable: false }
      );
    }
    if (!recover || !isForeignFrameError(err)) {
      if (isForeignFrameError(err)) throw new CdpError(err.message + (await describeFrames(tabId)));
      throw err;
    }
    return attachAfterRefusal(tabId, err);
  }
}

/** The recovery ladder for a refused attach. Each rung is tried once, in order. */
async function attachAfterRefusal(tabId, firstError) {
  const removed = [];
  let attempts = 0;

  if (await recoveryEnabled()) {
    for (let attempt = 1; attempt <= RECOVERY_RETRIES; attempt++) {
      attempts = attempt;
      removed.push(...(await stripExtensionInterference(tabId)));
      await workerSleep(RECOVERY_SETTLE_MS);
      try {
        await rawAttach(tabId);
        attachments.set(tabId, { attached: true, refs: 1 });
        const detail =
          (removed.length ? 'removed ' + removed.length + ' extension iframe' + (removed.length === 1 ? '' : 's') + ' and ' : '') +
          're-attached after ' + attempt + ' attempt' + (attempt === 1 ? '' : 's');
        note({
          kind: 'warning',
          code: 'attach_recovered',
          message: 'attach_recovered: tab ' + tabId + ' refused the debugger, ' + detail + '.',
        });
        return { attached: true, recovered: true, attempts: attempt, removed };
      } catch (err) {
        if (!isForeignFrameError(err)) throw err;
      }
    }
  }

  // A session bound to a target the tab no longer shows is refused the same
  // way, and dropping it costs one round trip to find out.
  await rawDetach(tabId);
  await workerSleep(REATTACH_WAIT_MS);
  try {
    await rawAttach(tabId);
    attachments.set(tabId, { attached: true, refs: 1 });
    note({
      kind: 'warning',
      code: 'attach_recovered',
      message: 'attach_recovered: tab ' + tabId + ' attached after a detach and a ' + REATTACH_WAIT_MS + 'ms wait.',
    });
    return { attached: true, recovered: true, attempts: attempts + 1, removed };
  } catch (err) {
    if (!isForeignFrameError(err)) throw err;
  }

  const replacement = sessionReplacer ? await sessionReplacer(tabId).catch(() => null) : null;
  if (replacement) {
    throw new ToolError(
      'tab_replaced',
      'Tab ' + tabId + ' could not be driven and was replaced by tab ' + replacement.newTabId + ' on the same URL.',
      {
        cause: firstError.message,
        hint: 'Retry on tab ' + replacement.newTabId + '. Page state such as form input and scroll position is gone.',
        effects: 'none',
        retryable: true,
        details: { oldTabId: tabId, newTabId: replacement.newTabId, url: replacement.url },
        warnings: ['page state such as form input and scroll position is gone'],
      }
    );
  }

  throw new ToolError('attach_refused', firstError.message + (await describeFrames(tabId)), {
    cause: firstError.message,
    effects: 'none',
    retryable: false,
  });
}

/** Drops every record of a tab. Used when a tab is replaced or closed. */
export function forgetTab(tabId) {
  attachments.delete(tabId);
  awake.delete(tabId);
  throttledTabs.delete(tabId);
  beforeunloadPolicy.delete(tabId);
  lastDialog.delete(tabId);
}

export function detach(tabId, { force = false } = {}) {
  return new Promise((resolve) => {
    const state = attachments.get(tabId);
    if (!state || !state.attached) return resolve();
    if (!force) {
      state.refs--;
      if (state.refs > 0) return resolve();
    }
    chrome.debugger.detach({ tabId }, () => {
      lastError();
      attachments.delete(tabId);
      awake.delete(tabId);
      resolve();
    });
  });
}

export async function detachAll() {
  await Promise.all([...attachments.keys()].map((tabId) => detach(tabId, { force: true })));
}

export function isAttached(tabId) {
  const state = attachments.get(tabId);
  return Boolean(state && state.attached);
}

/**
 * How long a command may take before the renderer is assumed frozen.
 *
 * A frozen renderer answers nothing at all, and chrome.debugger.sendCommand has
 * no timeout of its own, so without this a single hung page holds the call for
 * the host's full two minutes. Navigation and evaluation are given more room
 * because a slow site and a slow script are both ordinary.
 */
const DEFAULT_COMMAND_TIMEOUT = 20000;
const METHOD_TIMEOUT = {
  'Page.navigate': 60000,
  'Page.captureScreenshot': 30000,
  'Page.startScreencast': 10000,
};

function timeoutFor(method) {
  return METHOD_TIMEOUT[method] || DEFAULT_COMMAND_TIMEOUT;
}

/**
 * A repeated input event would land twice if the first one was only slow rather
 * than lost, so input is woken and reported rather than re-dispatched.
 */
function safeToRepeat(method) {
  return !/^Input\./.test(method);
}

function frozenError(tabId, method, ms) {
  return new ToolError('timeout', 'CDP ' + method + ' did not answer within ' + ms + 'ms on tab ' + tabId + '.', {
    cause: 'the renderer produced no reply',
    hint: 'the renderer did not respond, reload the tab with navigate',
    effects: 'unknown',
    retryable: false,
  });
}

function rawSend(tabId, method, params, timeout = timeoutFor(method)) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new CdpTimeout(method + ': no reply within ' + timeout + 'ms'));
          }, timeout)
        : null;
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = lastError();
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) return reject(new CdpError(method + ': ' + err.message));
      resolve(result);
    });
  });
}

/**
 * Errors that mean the attachment is bound to a target that no longer serves
 * this tab, rather than the command being wrong.
 *
 * Attaching while a tab sits on about:blank and then navigating can leave the
 * session pointed at the original target. On a browser with other extensions
 * installed, where the initial blank page may be an extension's new tab page,
 * Chrome then refuses every command with a message about a chrome-extension URL
 * belonging to a different extension, even though the tab is on an ordinary
 * site. Re-attaching binds to what the tab actually shows now.
 */
const STALE_ATTACHMENT =
  /Cannot access a chrome-extension|Detached while handling|No target with given id|Inspected target navigated or closed|Not attached to|Target closed|Debugger is not attached/i;

/**
 * Chrome checks every frame in the tab against this extension's permissions
 * before running a command, and a frame belonging to another extension fails
 * that check for the whole tab. The frame list is what says which one.
 */
async function describeFrames(tabId) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return '';
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) return '';
    const own = chrome.runtime.id;
    const foreign = frames.filter((f) => /^chrome-extension:\/\//.test(f.url) && !f.url.startsWith('chrome-extension://' + own));
    const list = frames.map((f) => (f.parentFrameId === -1 ? 'top' : 'frame ' + f.frameId) + ' ' + f.url).join('; ');
    const blame = foreign.length
      ? ' Another extension (' + [...new Set(foreign.map((f) => new URL(f.url).host))].join(', ') + ') has a frame in this tab, and Chrome refuses debugger commands on the whole tab while it is there. Disable that extension for this profile, or drive the page from a profile without it.'
      : '';
    let targets = '';
    try {
      const all = await chrome.debugger.getTargets();
      const mine = all.filter((t) => t.tabId === tabId || (t.type !== 'page' && /^chrome-extension:/.test(t.url || '')));
      targets = ' Debugger targets: ' + mine.map((t) => t.type + (t.tabId === tabId ? '' : '*') + ' ' + t.url).join('; ') + '.';
    } catch {
      /* getTargets is best effort */
    }
    return ' Frames: ' + list + '.' + targets + blame;
  } catch {
    return '';
  }
}

let detachListenerOn = null;

/**
 * Chrome drops a session on its own when a navigation makes the tab one this
 * extension may not debug, and the next command then fails as "not attached".
 * Tracking that keeps the attachment map honest so the next call re-attaches.
 */
function installDetachListener() {
  if (!chrome.debugger || !chrome.debugger.onDetach || detachListenerOn === chrome.debugger) return;
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId !== undefined) attachments.delete(source.tabId);
  });
  detachListenerOn = chrome.debugger;
}

// ---------------------------------------------------------------------------
// JavaScript dialogs
// ---------------------------------------------------------------------------

/** @type {Map<number, 'accept'|'dismiss'>} beforeunload policy per tab, dismiss by default. */
const beforeunloadPolicy = new Map();
/** @type {Map<number, {type: string, message: string, handled: string, at: number}>} */
const lastDialog = new Map();

export function setBeforeunloadPolicy(tabId, policy) {
  beforeunloadPolicy.set(tabId, policy === 'accept' ? 'accept' : 'dismiss');
}

/** Reads and clears the last beforeunload dialog seen on a tab. */
export function takeBeforeunloadDialog(tabId) {
  const dialog = lastDialog.get(tabId);
  if (!dialog || dialog.type !== 'beforeunload') return null;
  lastDialog.delete(tabId);
  return dialog;
}

/** The error a navigation cancelled by a beforeunload dialog returns. */
export function dialogOpenError(tabId, url, dialog) {
  return new ToolError(
    'dialog_open',
    'Navigation to ' + url + ' was cancelled by the page: ' +
      JSON.stringify(dialog.message || '') + ' was shown as a beforeunload dialog and dismissed, so the tab stayed put.',
    {
      hint: 'Call navigate again with force: true to leave the page and lose unsaved input.',
      effects: 'none',
      retryable: false,
      details: { tabId, url, dialog: { type: dialog.type, message: dialog.message, handled: dialog.handled } },
    }
  );
}

let dialogListenerOn = null;

/**
 * Answers modal dialogs instead of letting them hold the renderer.
 *
 * Page.enable is already on for every session tab, so a dialog suspends the
 * renderer and every later call on the tab blocks until a human dismisses it.
 * An alert has nothing to decide, so it is accepted. A confirm or a prompt is
 * dismissed, which is the answer that changes nothing. beforeunload follows a
 * per-tab policy that defaults to staying on the page, which navigate raises
 * with force: true. The text is reported either way, since it is often the only
 * thing the page said about what it was asking.
 */
export function installDialogListener() {
  if (!chrome.debugger || !chrome.debugger.onEvent || dialogListenerOn === chrome.debugger) return;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Page.javascriptDialogOpening' || !source || source.tabId === undefined) return;
    const tabId = source.tabId;
    const type = (params && params.type) || 'alert';
    const message = (params && params.message) || '';
    const accept = type === 'alert' ? true : type === 'beforeunload' ? beforeunloadPolicy.get(tabId) === 'accept' : false;
    const record = { type, message, handled: accept ? 'accepted' : 'dismissed', at: Date.now() };
    lastDialog.set(tabId, record);
    note({ kind: 'dialog', dialog: { type, message, handled: record.handled } });
    try {
      chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept, promptText: '' }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* the tab went away with the dialog on it */
    }
  });
  dialogListenerOn = chrome.debugger;
}

// Installed once, when the worker loads. A dialog can open without a call in
// flight, and a listener added per attach would land on whichever debugger
// object was current at the time.
installDialogListener();

export async function send(tabId, method, params = {}, options = {}) {
  const { retry = true, timeout = timeoutFor(method), wakeOnTimeout = true } = options;
  installDetachListener();
  try {
    return await rawSend(tabId, method, params, timeout);
  } catch (err) {
    // A renderer that stopped answering is woken the way a hidden tab is, and
    // the command is sent once more before the call is given up on.
    if (err instanceof CdpTimeout) {
      if (!wakeOnTimeout) throw frozenError(tabId, method, timeout);
      await wake(tabId, { force: true }).catch(() => {});
      if (!safeToRepeat(method)) throw frozenError(tabId, method, timeout);
      try {
        return await rawSend(tabId, method, params, timeout);
      } catch (again) {
        if (again instanceof CdpTimeout) throw frozenError(tabId, method, timeout);
        throw again;
      }
    }
    if (!retry || !STALE_ATTACHMENT.test((err && err.message) || '')) throw err;

    await detach(tabId, { force: true });
    await attach(tabId);
    for (const domain of ['Runtime', 'Log', 'Network', 'Page', 'DOM']) {
      await rawSend(tabId, domain + '.enable', {}).catch(() => {});
    }
    try {
      return await rawSend(tabId, method, params);
    } catch (again) {
      if (/chrome-extension/i.test((again && again.message) || '')) {
        throw new CdpError(again.message + await describeFrames(tabId));
      }
      throw again;
    }
  }
}

/**
 * Queues a command without waiting for its reply.
 *
 * Input.dispatchMouseEvent with type mouseMoved blocks for a fixed five seconds
 * waiting for a renderer acknowledgement that frequently never arrives, while
 * mousePressed and mouseReleased answer in under a millisecond. The move is
 * still delivered, so the ack is the only thing missing. CDP processes commands
 * on a session in order, so a queued move is handled before the press that
 * follows it, and dropping the wait removes five seconds from every click.
 */
export function sendNoWait(tabId, method, params = {}) {
  try {
    chrome.debugger.sendCommand({ tabId }, method, params, () => {
      // Reading lastError here keeps Chrome from logging an unchecked error.
      void chrome.runtime.lastError;
    });
  } catch {
    /* the next awaited command surfaces a genuinely broken session */
  }
}

/**
 * Dispatches an input event, giving up on the acknowledgement rather than the
 * event.
 *
 * Chrome answers Input.dispatchMouseEvent only once the renderer has processed
 * the event. A hidden or occluded window stops producing frames, so a move or a
 * wheel event waits the full five second internal timeout even though the page
 * receives it. Waiting briefly and moving on keeps latency bounded: the event is
 * still delivered in order, and the outstanding reply is flushed by the next
 * input event without blocking anything else.
 */
const throttledTabs = new Set();

/** True when this tab's last input acknowledgement did not arrive in time. */
export function rendererLooksThrottled(tabId) {
  return throttledTabs.has(tabId);
}

export function clearThrottleFlag(tabId) {
  throttledTabs.delete(tabId);
}

export async function sendInput(tabId, params, ackTimeout = 400) {
  let settled = false;
  // No command timeout here: the missing acknowledgement is the expected case
  // on a hidden tab, and it is already handled by the race below.
  const command = send(tabId, 'Input.dispatchMouseEvent', params, { timeout: 0 }).then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      throw err;
    }
  );
  command.catch(() => {});

  await Promise.race([command, workerSleep(ackTimeout)]);
  // A genuine protocol error surfaces immediately, an absent ack does not.
  if (settled) {
    throttledTabs.delete(tabId);
    await command;
    return;
  }
  // A missing acknowledgement means the renderer is not producing frames, which
  // is recorded so the next action can bring the window forward rather than
  // continuing to dispatch into a throttled tab.
  throttledTabs.add(tabId);
}

const workerSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits, using the page's clock rather than the service worker's.
 *
 * A pending setTimeout does not keep an MV3 service worker alive. Chrome
 * suspends the worker while it awaits one and resumes it later, so a 100ms
 * hover delay measured about five seconds in practice, and every click paid it.
 * Running the timer in the page keeps the worker busy on a pending extension
 * API callback, which does hold it open, and gives an accurate delay.
 *
 * Falls back to the worker clock when there is no usable tab, which only
 * affects waits that are not tied to a page.
 */
export async function sleep(ms, tabId) {
  if (!ms || ms <= 0) return;
  if (tabId === undefined || tabId === null || !isAttached(tabId)) return workerSleep(ms);
  try {
    await send(tabId, 'Runtime.evaluate', {
      expression: 'new Promise(r => setTimeout(r, ' + Math.round(ms) + '))',
      awaitPromise: true,
      returnByValue: true,
    });
  } catch {
    await workerSleep(ms);
  }
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

/**
 * Moves the pointer, waits, then presses. The gap lets hover-triggered UI
 * (menus, tooltips, lazily mounted overlays) render before the press lands,
 * which is the difference between clicking a menu item and clicking the page
 * behind it.
 */
export async function mouseClick(tabId, x, y, options = {}) {
  const {
    button = 'left',
    clickCount = 1,
    modifiers = 0,
    hoverDelay = 100,
    onMove,
    onPress,
    onRelease,
  } = options;

  // The pointer travels to the target first, then presses, so an observer sees
  // the same order of events the page does.
  if (onMove) onMove(x, y);
  await sendInput(tabId, { type: 'mouseMoved', x, y, modifiers, buttons: 0 });
  if (hoverDelay > 0) await sleep(hoverDelay, tabId);

  for (let i = 1; i <= clickCount; i++) {
    if (onPress) onPress(x, y);
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: BUTTON_MASK[button] || 1,
      clickCount: i,
      modifiers,
    });
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: i,
      modifiers,
    });
    if (onRelease) onRelease(x, y);
    if (i < clickCount) await sleep(30, tabId);
  }
}

export async function mouseHover(tabId, x, y, modifiers = 0, onMove) {
  if (onMove) onMove(x, y);
  await sendInput(tabId, { type: 'mouseMoved', x, y, modifiers, buttons: 0 });
  // Give hover-triggered UI a moment to appear before the caller reads the page.
  await sleep(120, tabId);
}

export async function mouseDrag(tabId, from, to, modifiers = 0, hooks = {}) {
  const { onMove, onPress, onRelease } = hooks;
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (onMove) onMove(x1, y1);
  await sendInput(tabId, { type: 'mouseMoved', x: x1, y: y1, buttons: 0, modifiers });
  await sleep(50, tabId);
  if (onPress) onPress(x1, y1);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: x1,
    y: y1,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  // Intermediate moves, because drag targets commonly require movement deltas
  // rather than a single jump to the destination.
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const stepX = Math.round(x1 + ((x2 - x1) * i) / steps);
    const stepY = Math.round(y1 + ((y2 - y1) * i) / steps);
    if (onMove) onMove(stepX, stepY);
    await sendInput(tabId, {
      type: 'mouseMoved',
      x: stepX,
      y: stepY,
      button: 'left',
      buttons: 1,
      modifiers,
    });
    await sleep(16, tabId);
  }
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: x2,
    y: y2,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
  if (onRelease) onRelease(x2, y2);
}

export async function mouseScroll(tabId, x, y, direction, amount = 3, modifiers = 0) {
  const distance = amount * 100;
  const deltas = {
    down: [0, distance],
    up: [0, -distance],
    right: [distance, 0],
    left: [-distance, 0],
  };
  const [deltaX, deltaY] = deltas[direction] || deltas.down;
  await sendInput(tabId, { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers });
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** Types literal text. Input.insertText is atomic and does not fire per-key events. */
export async function insertText(tabId, text) {
  await send(tabId, 'Input.insertText', { text });
}

/**
 * Types character by character with real key events. Slower than insertText but
 * required by inputs that listen for keydown, such as autocomplete fields that
 * only query on keystroke.
 */
export async function typeKeys(tabId, text, delay = 12) {
  for (const ch of String(text)) {
    if (ch === '\n') {
      await pressKey(tabId, 'enter');
      continue;
    }
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      unmodifiedText: ch,
      key: ch,
    });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    if (delay) await sleep(delay, tabId);
  }
}

/**
 * Presses one key combination, e.g. "ctrl+a" or "Enter".
 * Modifier-bearing combinations suppress the text payload, which is what stops
 * ctrl+a from inserting the letter a.
 */
export async function pressKey(tabId, combo) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const keyName = parts.pop();
  const modifiers = modifiersToMask(parts.join('+'));
  const spec = KEYS[keyName];

  if (!spec) {
    throw new CdpError(
      'unknown key ' + JSON.stringify(keyName) + '. Supported: ' + Object.keys(KEYS).slice(0, 40).join(', ') + ', ...'
    );
  }

  const base = {
    modifiers,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    code: spec.code,
    key: spec.key,
  };

  // Text is only sent when no non-shift modifier is held.
  const textual = spec.text && (modifiers & ~MOD.shift) === 0;
  await send(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: textual ? 'keyDown' : 'rawKeyDown',
    ...(textual ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  if (textual && spec.text && spec.text.length === 1 && spec.vk !== 13 && spec.vk !== 9) {
    await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'char', text: spec.text });
  }
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

export async function pressKeySequence(tabId, sequence, repeat = 1) {
  const combos = String(sequence).split(/\s+/).filter(Boolean);
  for (let r = 0; r < repeat; r++) {
    for (const combo of combos) {
      await pressKey(tabId, combo);
      await sleep(10, tabId);
    }
  }
}

// ---------------------------------------------------------------------------
// Capture and navigation
// ---------------------------------------------------------------------------

/**
 * Whether the tab is the one on screen in a window that is showing. A tab in
 * the background has no compositor surface to read, so its capture must come
 * from the renderer instead.
 */
async function onScreen(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.state !== 'minimized' && win.focused !== false;
  } catch {
    return false;
  }
}

/**
 * One frame of a screencast, which is how a hidden tab is captured.
 *
 * Page.captureScreenshot on a tab that is not on screen waits for a compositor
 * frame the hidden surface never produces: measured on Chrome 152 it took three
 * to four seconds and sometimes never answered. The renderer-side capture
 * (fromSurface false) answers in a quarter of a second but the extension
 * debugger API refuses it. Starting a screencast makes Chrome produce a frame
 * of the current state at once, measured at 34ms, and stopping it right after
 * costs nothing more.
 */
function screencastFrame(tabId, { format, quality, maxWidth, maxHeight, timeout = 4000 }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      sendNoWait(tabId, 'Page.stopScreencast');
      if (err) reject(err);
      else resolve(data);
    };
    const listener = (source, method, params) => {
      if (!source || source.tabId !== tabId || method !== 'Page.screencastFrame') return;
      sendNoWait(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId });
      finish(null, params.data);
    };
    const timer = setTimeout(() => finish(new CdpError('the hidden tab produced no frame within ' + timeout + 'ms')), timeout);
    chrome.debugger.onEvent.addListener(listener);
    const params = { format, maxWidth, maxHeight, everyNthFrame: 1 };
    if (quality !== undefined && format === 'jpeg') params.quality = quality;
    send(tabId, 'Page.startScreencast', params).catch((err) => finish(err));
  });
}

async function bytesToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function captureHidden(tabId, { format, quality, clip }) {
  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  const width = Math.max(1, Math.round(viewport.clientWidth));
  const height = Math.max(1, Math.round(viewport.clientHeight));
  const frame = await screencastFrame(tabId, { format, quality, maxWidth: width, maxHeight: height });
  if (!clip) return frame;

  // A zoom is a crop of the frame. The frame was requested at CSS size, so the
  // clip, which is in CSS pixels, maps onto it one to one.
  const response = await fetch('data:image/' + format + ';base64,' + frame);
  const bitmap = await createImageBitmap(await response.blob());
  const scaleX = bitmap.width / width;
  const scaleY = bitmap.height / height;
  const w = Math.max(1, Math.round(clip.width * scaleX));
  const h = Math.max(1, Math.round(clip.height * scaleY));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, -Math.round(clip.x * scaleX), -Math.round(clip.y * scaleY));
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/' + format, quality: quality !== undefined ? quality / 100 : undefined });
  return bytesToBase64(blob);
}

/**
 * Captures the page. A tab on screen is read from its surface, which includes
 * everything the browser composites. A hidden or minimized tab is captured
 * through a screencast frame, since its surface never draws.
 */
export async function captureScreenshot(tabId, { format = 'png', quality, clip } = {}) {
  if (!(await onScreen(tabId))) return captureHidden(tabId, { format, quality, clip });
  const params = { format, captureBeyondViewport: false, fromSurface: true };
  if (quality !== undefined && format === 'jpeg') params.quality = quality;
  if (clip) params.clip = clip;
  const result = await send(tabId, 'Page.captureScreenshot', params);
  return result.data;
}

export async function getLayoutMetrics(tabId) {
  return send(tabId, 'Page.getLayoutMetrics');
}

export async function evaluate(tabId, expression, { awaitPromise = true, returnByValue = true, timeout = 60000 } = {}) {
  const result = await send(
    tabId,
    'Runtime.evaluate',
    {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
      replMode: true,
    },
    { timeout }
  );
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails;
    const message =
      (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'evaluation failed';
    throw new CdpError(String(message));
  }
  return result.result;
}

/**
 * Makes a hidden tab behave as if it were on screen, without showing it.
 *
 * The agent works in the background: the user keeps their own tab in front
 * and never has the browser brought forward. Chrome throttles a hidden tab's
 * renderer, holds input acknowledgements, stops animation frames and reports
 * the page hidden. Focus emulation and an active lifecycle state undo all of
 * that from the page's point of view. Measured on Chrome 152: with both set, a
 * hidden tab answers a mouse event in 1ms, runs requestAnimationFrame, keeps
 * timers accurate and reports itself visible and focused. Only screenshots
 * stay slower than on a visible tab.
 */
const awake = new Set();

export async function wake(tabId, { force = false } = {}) {
  if (!force && awake.has(tabId)) return;
  // wakeOnTimeout is off on both: waking is what the timeout path calls, and it
  // must not call itself.
  try {
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }, { retry: false, timeout: 5000, wakeOnTimeout: false });
  } catch {
    /* an older Chrome without the method still gets the lifecycle state */
  }
  try {
    await send(tabId, 'Page.setWebLifecycleState', { state: 'active' }, { retry: false, timeout: 5000, wakeOnTimeout: false });
  } catch {
    /* not supported on this target */
  }
  awake.add(tabId);
}

export function forgetWake(tabId) {
  awake.delete(tabId);
}

export async function enableDomains(tabId, domains) {
  for (const domain of domains) {
    try {
      await send(tabId, domain + '.enable', {}, { retry: false });
    } catch {
      /* already enabled or unsupported on this target */
    }
  }
}

/**
 * Sets the files on an `<input type=file>`.
 *
 * The element is located by a marker attribute rather than a ref, because the
 * ref map lives in the content script's isolated world and CDP addresses nodes
 * from its own DOM tree.
 */
export async function setFileInputFiles(tabId, selector, files) {
  const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new CdpError('could not locate the file input in the DOM tree');
  await send(tabId, 'DOM.setFileInputFiles', { files, nodeId });
}

/**
 * Drops files onto a target that has no file input, which is how most
 * drag-and-drop upload areas are built.
 */
export async function dropFiles(tabId, x, y, files) {
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await send(tabId, 'Input.dispatchDragEvent', { type, x, y, data });
  }
}

// ===========================================================================
// Added by branch plan/content-verify. Self-contained, so the merge is a
// straight append. Nothing above this line is modified.
// ===========================================================================

/**
 * The key identity of a printable character (R5, S7).
 *
 * `typeKeys` sent a keyDown carrying only `text` and `key`, with no virtual key
 * code and no `code`. Chrome delivers that as a key press with keyCode 0, and a
 * field whose framework reads `event.keyCode` or `event.code` on keydown never
 * sees a character, which is why `perKey` typing landed nothing in the jqueryui
 * autocomplete while the same field took `Input.insertText` immediately. The
 * fix is to send the same three events `pressKey` already sends for a named
 * key: keyDown, char, keyUp, with the codes filled in.
 */
export function printableKeySpec(ch) {
  const upper = ch.toUpperCase();
  const codePoint = upper.charCodeAt(0);
  let code = '';
  if (/[A-Z]/.test(upper)) code = 'Key' + upper;
  else if (/[0-9]/.test(ch)) code = 'Digit' + ch;
  else {
    const PUNCT = {
      ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
      '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period',
      '/': 'Slash', '`': 'Backquote',
    };
    code = PUNCT[ch] || '';
  }
  // Windows virtual key codes for the characters that carry one. Anything else
  // rides on the text payload alone, which is what an IME-produced character
  // does too.
  const VK = {
    ' ': 32, '-': 189, '=': 187, '[': 219, ']': 221, '\\': 220, ';': 186,
    "'": 222, ',': 188, '.': 190, '/': 191, '`': 192,
  };
  const vk = /[A-Z0-9]/.test(upper) ? codePoint : VK[ch] || 0;
  return { vk, code, key: ch, text: ch };
}

/** Dispatches one printable character as a real key press. */
export async function pressPrintable(tabId, ch, modifiers = 0) {
  const spec = printableKeySpec(ch);
  const base = {
    modifiers,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    code: spec.code || undefined,
    key: spec.key,
  };
  await send(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'keyDown',
    text: spec.text,
    unmodifiedText: spec.text,
  });
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'char', text: spec.text });
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

/**
 * Types character by character with complete key events (R5).
 *
 * Replaces the payload `typeKeys` sent. Kept as a separate export so the old
 * function stays available while both are in the tree.
 */
export async function typeKeysReal(tabId, text, delay = 12) {
  for (const ch of String(text)) {
    if (ch === '\n') {
      await pressKey(tabId, 'enter');
    } else {
      await pressPrintable(tabId, ch);
    }
    if (delay) await sleep(delay, tabId);
  }
}

/**
 * Presses a key combination, falling through to the printable-character path
 * when the name is a single character the key table does not carry (S7).
 *
 * `K /` used to error with a list of supported keys, so a GitHub search
 * shortcut needed a different command than every other key press.
 */
export async function pressKeyLoose(tabId, combo) {
  const raw = String(combo);
  // Checked before splitting, so "+" itself is a key rather than an empty
  // combination.
  if ([...raw].length === 1 && !/[a-z0-9]/i.test(raw)) return pressPrintable(tabId, raw);

  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const keyName = parts[parts.length - 1];
  const printable = keyName && [...keyName].length === 1 && !/[a-z0-9]/i.test(keyName);
  if (!printable) return pressKey(tabId, combo);
  await pressPrintable(tabId, keyName, modifiersToMask(parts.slice(0, -1).join('+')));
}

export async function pressKeySequenceLoose(tabId, sequence, repeat = 1) {
  const combos = String(sequence).split(/\s+/).filter(Boolean);
  for (let r = 0; r < repeat; r++) {
    for (const combo of combos) {
      await pressKeyLoose(tabId, combo);
      await sleep(10, tabId);
    }
  }
}

/**
 * A drag with dwell time either side of the movement (R15).
 *
 * The local fixture's HTML5 drag boxes and its range slider both stayed put
 * under `mouseDrag`, and the page's event log showed a pointerdown and a click
 * with no drop between them: the press and the first move landed in the same
 * frame, so the browser never started a drag. A pause after the press and
 * another before the release gives the drag source time to begin and the drop
 * target time to accept.
 */
export async function mouseDragDwell(tabId, from, to, modifiers = 0, hooks = {}, options = {}) {
  const { onMove, onPress, onRelease } = hooks;
  const { steps = 10, stepDelay = 16, pressDwell = 50, releaseDwell = 50 } = options;
  const [x1, y1] = from;
  const [x2, y2] = to;

  if (onMove) onMove(x1, y1);
  await sendInput(tabId, { type: 'mouseMoved', x: x1, y: y1, buttons: 0, modifiers });
  await sleep(50, tabId);

  if (onPress) onPress(x1, y1);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: x1,
    y: y1,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  await sleep(pressDwell, tabId);

  for (let i = 1; i <= steps; i++) {
    const stepX = Math.round(x1 + ((x2 - x1) * i) / steps);
    const stepY = Math.round(y1 + ((y2 - y1) * i) / steps);
    if (onMove) onMove(stepX, stepY);
    await sendInput(tabId, {
      type: 'mouseMoved',
      x: stepX,
      y: stepY,
      button: 'left',
      buttons: 1,
      modifiers,
    });
    await sleep(stepDelay, tabId);
  }

  await sleep(releaseDwell, tabId);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: x2,
    y: y2,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
  if (onRelease) onRelease(x2, y2);
}

/**
 * The first screencast frame whose timestamp postdates a given moment (R3).
 *
 * A hidden tab runs no animation frames, so the repaint wait a visible tab uses
 * cannot work there. Chrome stamps every screencast frame with the wall clock
 * time it was produced, which is a paint clock the extension can compare
 * against the moment of the last input.
 */
export function screencastFrameAfter(tabId, sinceMs, { timeout = 300, format = 'jpeg', quality = 50 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      sendNoWait(tabId, 'Page.stopScreencast');
      resolve(result);
    };
    const listener = (source, method, params) => {
      if (!source || source.tabId !== tabId || method !== 'Page.screencastFrame') return;
      sendNoWait(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId });
      const stamp = params.metadata && params.metadata.timestamp ? params.metadata.timestamp * 1000 : Date.now();
      if (stamp >= sinceMs) finish({ painted: true, at: stamp });
      // A frame older than the input is the pre-input state. Waiting for the
      // next one is the whole point, so this one is acknowledged and dropped.
    };
    const timer = setTimeout(() => finish({ painted: false, timedOut: true }), timeout);
    chrome.debugger.onEvent.addListener(listener);
    send(tabId, 'Page.startScreencast', { format, quality, everyNthFrame: 1 }).catch(() =>
      finish({ painted: false, error: true })
    );
  });
}
