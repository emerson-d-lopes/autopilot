// Chrome DevTools Protocol wrapper.
//
// All input is dispatched through CDP so events arrive with isTrusted true.
// Synthetic DOM events are rejected by file inputs, native drag and drop, and
// most bot detection, so there is no synthetic fallback path.

import { ToolError, RENDERER_FROZEN_HINT } from './errors.js';

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
  numpadenter: { vk: 13, code: 'NumpadEnter', key: 'Enter', text: '\r' },
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

/**
 * `ctrl`/`cmd` plus one of these is a browser page-zoom chord, not a page
 * shortcut. Dispatching it silently rescales the whole tab, which drifts every
 * coordinate computed from an earlier screenshot the same way a `zoom` crop
 * does, so it is refused rather than sent (P10).
 */
const ZOOM_CHORD_KEYS = new Set(['+', '-', '=', '0']);

/** True when a key combo is a ctrl/cmd page-zoom chord (P10). */
function isZoomChord(combo) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const keyName = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const hasZoomMod = mods.some((m) => m === 'ctrl' || m === 'control' || m === 'cmd' || m === 'meta' || m === 'command');
  return hasZoomMod && ZOOM_CHORD_KEYS.has(keyName);
}

function assertNotZoomChord(combo) {
  if (isZoomChord(combo)) {
    throw new CdpError(
      'ctrl/cmd+' + String(combo).split('+').pop() + ' is a browser zoom chord and is refused. Use the zoom action instead.'
    );
  }
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

/**
 * A stable name for why an attach was refused, so "the same cause" is
 * decidable.
 *
 * Chrome's refusal for a foreign extension frame is the same sentence whichever
 * tab it names, which is the point: a replacement refused for that reason is
 * refused by the same extension that killed the tab it replaced.
 */
export function causeKey(message) {
  const text = String(message || '');
  const id = /chrome-extension:\/\/([a-z]{20,})/i.exec(text);
  if (id) return 'foreign-frame:' + id[1].toLowerCase();
  if (FOREIGN_FRAME.test(text)) return 'foreign-frame';
  if (/already attached/i.test(text)) return 'already-attached';
  return 'attach:' + text.slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The tab each replacement stands in for, and why its predecessor was replaced.
 * @type {Map<number, {rootTabId: number, cause: string}>}
 */
const replacementOf = new Map();

/** Original tab and cause already spent on a replacement, so it is spent once. */
const replacementsMade = new Set();

const MAX_REPLACEMENT_RECORDS = 100;

/** Forgets the replacement ladder for a tab. Exported for tests. */
export function forgetReplacements(tabId) {
  if (tabId === undefined) {
    replacementOf.clear();
    replacementsMade.clear();
    return;
  }
  replacementOf.delete(tabId);
}

/** The other extensions holding a frame in this tab, by host, for a hint. */
async function interferingExtensions(tabId) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return [];
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
    const own = 'chrome-extension://' + chrome.runtime.id;
    const foreign = frames.filter((f) => /^chrome-extension:\/\//.test(f.url || '') && !String(f.url).startsWith(own));
    return [...new Set(foreign.map((f) => String(f.url).split('/')[2]))];
  } catch {
    return [];
  }
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

  // The ladder stops here when the tab is itself a replacement refused for the
  // reason its predecessor was refused for. Left uncapped, an extension that
  // injects into every page produced a replacement per call, six tabs across
  // three runs, and never a working one.
  const cause = causeKey(firstError.message);
  const origin = replacementOf.get(tabId);
  const rootTabId = origin ? origin.rootTabId : tabId;
  const spent = replacementsMade.has(rootTabId + ' ' + cause);

  if (spent) {
    const blame = await interferingExtensions(tabId);
    const named = blame.length ? ' Another extension (' + blame.join(', ') + ') has a frame in this tab.' : '';
    throw new ToolError(
      'attach_refused',
      'Tab ' +
        tabId +
        ' was refused for the same reason as the tab it replaced, so it was not replaced again.' +
        named +
        (await describeFrames(tabId)),
      {
        cause: firstError.message,
        hint: blame.length
          ? 'Disable ' + blame.join(' or ') + ' for this profile, or drive the page from a profile without it.'
          : 'Disable the extension holding a frame in this tab, or drive the page from a profile without it.',
        effects: 'none',
        retryable: false,
        details: { tabId, replacedTabId: rootTabId === tabId ? undefined : rootTabId, cause },
      }
    );
  }

  const replacement = sessionReplacer ? await sessionReplacer(tabId).catch(() => null) : null;
  if (replacement) {
    replacementsMade.add(rootTabId + ' ' + cause);
    replacementOf.set(replacement.newTabId, { rootTabId, cause });
    while (replacementsMade.size > MAX_REPLACEMENT_RECORDS) {
      replacementsMade.delete(replacementsMade.values().next().value);
    }
    while (replacementOf.size > MAX_REPLACEMENT_RECORDS) {
      replacementOf.delete(replacementOf.keys().next().value);
    }
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
  replacementOf.delete(tabId);
  throttledTabs.delete(tabId);
  beforeunloadPolicy.delete(tabId);
  lastDialog.delete(tabId);
  pointerAt.delete(tabId);
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
    hint: RENDERER_FROZEN_HINT,
    effects: 'unknown',
    retryable: false,
  });
}

/**
 * The command each tab is waiting on, and since when.
 *
 * CDP runs a session's commands in order, so a second call on a tab whose
 * renderer is in an 8 second busy loop used to wait the loop out and then
 * succeed: no timeout, no reload hint, and a caller with no way to tell a slow
 * page from a frozen one. A queued command is now given its own timeout from
 * the moment it was queued.
 *
 * Only commands that carry a timeout are tracked. Input dispatch is sent with
 * timeout 0 on purpose, because the acknowledgement is expected not to come on
 * a hidden tab, and waiting on that would stall every later command.
 *
 * @type {Map<number, {method: string, startedAt: number, done: Promise<void>}>}
 */
const inFlight = new Map();

/** How long a tab's current CDP command has gone unanswered, or 0 for none. */
export function busyFor(tabId) {
  const ahead = inFlight.get(tabId);
  return ahead ? Date.now() - ahead.startedAt : 0;
}

export function queuedTimeoutError(tabId, method, ms, ahead) {
  const blame = ahead ? ' behind ' + ahead.method + ', unanswered for ' + (Date.now() - ahead.startedAt) + 'ms' : '';
  return new ToolError(
    'timeout',
    'CDP ' + method + ' waited ' + ms + 'ms on tab ' + tabId + blame + '. The renderer is not answering.',
    {
      cause: 'the renderer has not answered an earlier command',
      hint: RENDERER_FROZEN_HINT,
      // The queued command was never dispatched, so nothing it would have done
      // happened. The command it waited behind is still running.
      effects: 'none',
      retryable: true,
      details: ahead ? { tabId, method, waitedMs: ms, blockedBy: ahead.method } : { tabId, method, waitedMs: ms },
    }
  );
}

/** Resolves true when `promise` settles first, false when the timer wins. */
function settlesWithin(promise, ms) {
  let timer = null;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true, () => true), timed]).then((won) => {
    if (timer) clearTimeout(timer);
    return won;
  });
}

/**
 * Waits for the tab's current command to answer, no longer than this command's
 * own timeout counted from the moment it was queued.
 */
async function waitForTurn(tabId, method, timeout) {
  if (!(timeout > 0)) return;
  const deadline = Date.now() + timeout;
  let ahead = inFlight.get(tabId);
  while (ahead) {
    const left = deadline - Date.now();
    if (left <= 0 || !(await settlesWithin(ahead.done, left))) {
      throw queuedTimeoutError(tabId, method, timeout, ahead);
    }
    ahead = inFlight.get(tabId);
  }
}

/**
 * Waits for the tab's CDP queue to clear on behalf of something that is not a
 * CDP command. A message to the content script reaches the same renderer and
 * waits out the same busy loop, with no timeout of its own to stop it.
 */
export function awaitTurn(tabId, label, timeout = DEFAULT_COMMAND_TIMEOUT) {
  return waitForTurn(tabId, label, timeout);
}

/** rawSend, queued behind whatever the tab is already waiting on. */
async function queuedSend(tabId, method, params, timeout = timeoutFor(method)) {
  await waitForTurn(tabId, method, timeout);
  const promise = rawSend(tabId, method, params, timeout);
  if (!(timeout > 0)) return promise;
  const entry = { method, startedAt: Date.now(), done: promise.then(() => {}, () => {}) };
  inFlight.set(tabId, entry);
  try {
    return await promise;
  } finally {
    if (inFlight.get(tabId) === entry) inFlight.delete(tabId);
  }
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
    return await queuedSend(tabId, method, params, timeout);
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

// ---------------------------------------------------------------------------
// Pointer position (D4)
// ---------------------------------------------------------------------------
//
// Neither bridge produced a mouse path in the campaign: both jumped straight
// from one click target to the next with no motion between them
// (D-bot-detection.md, "What is visible to a site on both bridges"). A path
// needs a starting point, so the last position dispatched to each tab is kept.

/** @type {Map<number, {x: number, y: number}>} */
const pointerAt = new Map();

/** The last position a mouseMoved event was dispatched to on this tab, or null. */
export function lastPointer(tabId) {
  const point = pointerAt.get(tabId);
  return point ? { ...point } : null;
}

export function setLastPointer(tabId, x, y) {
  pointerAt.set(tabId, { x, y });
}

export function forgetPointer(tabId) {
  pointerAt.delete(tabId);
}

export async function sendInput(tabId, params, ackTimeout = 400) {
  // Recorded here rather than at each call site, so a drag, a hover and a click
  // all leave the pointer where the page last saw it.
  if (params && params.type === 'mouseMoved') setLastPointer(tabId, params.x, params.y);
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

const PATH_MIN_STEPS = 3;
const PATH_MAX_STEPS = 6;
/** Below this, a path would be a handful of events inside one pixel or two. */
const PATH_MIN_DISTANCE = 8;
/** How far the path bows off the straight line, as a fraction of its length. */
const PATH_BOW = 0.12;
const PATH_BOW_MAX_PX = 40;

/**
 * Points along a slightly curved path from one point to another (D4).
 *
 * A quadratic bezier whose control point is offset perpendicular to the line,
 * so the path bows to one side or the other instead of running straight.
 * Progress along the line is linear in the step index, which keeps every point
 * closer to the target than the one before it however the curve bends.
 *
 * The last point is the target exactly, so the press that follows lands where
 * the caller asked and nowhere near it.
 *
 * Pure and seedable, so the shape can be asserted without a browser.
 */
export function pointerPath(from, to, { steps, rand = Math.random } = {}) {
  const span = PATH_MAX_STEPS - PATH_MIN_STEPS + 1;
  const count = Number.isFinite(steps) ? Math.max(1, Math.round(steps)) : PATH_MIN_STEPS + Math.floor(rand() * span);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bow = Math.min(distance * PATH_BOW, PATH_BOW_MAX_PX) * (rand() * 2 - 1);
  const cx = from.x + dx / 2 - (dy / distance) * bow;
  const cy = from.y + dy / 2 + (dx / distance) * bow;

  const points = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const u = 1 - t;
    points.push({
      x: Math.round(u * u * from.x + 2 * u * t * cx + t * t * to.x),
      y: Math.round(u * u * from.y + 2 * u * t * cy + t * t * to.y),
    });
  }
  return points;
}

/**
 * Moves the pointer to a target over a path, spending a fixed budget of time.
 *
 * The budget is the gap the caller was already going to wait. Each step takes
 * one slice of it and pays for its own dispatch out of that slice, so a path
 * costs the same wall time a single jump plus the gap used to cost. A tab with
 * no known pointer position gets the single move it always got.
 *
 * Only the last point waits for an acknowledgement. A hidden tab produces no
 * frames, so every intermediate move would otherwise pay `sendInput`'s full
 * ack timeout and a six-point path would cost seconds. The events are queued
 * in order either way, and the point the press lands on is the one worth
 * knowing the renderer took.
 */
async function movePointerTo(tabId, x, y, { modifiers = 0, buttons = 0, onMove, gapMs = 0 } = {}) {
  const from = lastPointer(tabId);
  const far = from && Math.hypot(x - from.x, y - from.y) >= PATH_MIN_DISTANCE;
  const path = far ? pointerPath(from, { x, y }) : [{ x, y }];

  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    const before = Date.now();
    const params = { type: 'mouseMoved', x: point.x, y: point.y, modifiers, buttons };
    // A move with a button held reports the same pressure a press on that
    // button does (P10). A hover-in move has no button down and carries none.
    if (buttons) params.force = 0.5;
    if (onMove) onMove(point.x, point.y);
    if (i === path.length - 1) {
      await sendInput(tabId, params);
    } else {
      sendNoWait(tabId, 'Input.dispatchMouseEvent', params);
      setLastPointer(tabId, point.x, point.y);
    }
    // The slices telescope to exactly gapMs however the points divide it.
    const slice = Math.round((gapMs * (i + 1)) / path.length) - Math.round((gapMs * i) / path.length);
    const wait = slice - (Date.now() - before);
    if (wait > 1) await sleep(wait, tabId);
  }
}

/**
 * Moves the pointer, waits, then presses. The gap lets hover-triggered UI
 * (menus, tooltips, lazily mounted overlays) render before the press lands,
 * which is the difference between clicking a menu item and clicking the page
 * behind it.
 *
 * The move is a path rather than a jump (D4), dispatched inside that same gap.
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
  await movePointerTo(tabId, x, y, { modifiers, onMove, gapMs: Math.max(0, hoverDelay) });

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
      // A plausible pressure value for handlers that read PointerEvent.force
      // and otherwise see 0, the value a mouse rather than a touch reports.
      force: 0.5,
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

const HOVER_SETTLE_MS = 120;

export async function mouseHover(tabId, x, y, modifiers = 0, onMove) {
  // The path rides inside the settle time, which hover-triggered UI needs to
  // appear before the caller reads the page.
  await movePointerTo(tabId, x, y, { modifiers, onMove, gapMs: HOVER_SETTLE_MS });
}

/**
 * A drag. Kept as the name callers reach for, implemented by mouseDragDwell.
 *
 * The original payload pressed and moved in the same frame, so the browser
 * never started a drag (R15). There is one implementation now.
 */
export async function mouseDrag(tabId, from, to, modifiers = 0, hooks = {}) {
  return mouseDragDwell(tabId, from, to, modifiers, hooks);
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
 *
 * Kept as the name callers reach for, implemented by typeKeysReal, whose
 * events carry the virtual key code an autocomplete listener needs (R5).
 */
export async function typeKeys(tabId, text, cadence) {
  return typeKeysReal(tabId, text, cadence);
}

/**
 * Presses one key combination, e.g. "ctrl+a" or "Enter".
 * Modifier-bearing combinations suppress the text payload, which is what stops
 * ctrl+a from inserting the letter a.
 */
export async function pressKey(tabId, combo) {
  assertNotZoomChord(combo);
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

/**
 * Whether one key name is Enter under any of the spellings the parser takes.
 *
 * Read off the same table the dispatch uses, so a name that presses Enter and a
 * name that counts as a submit cannot drift apart.
 */
export function isEnterKeyName(name) {
  const key = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  if (key === '\n' || key === '\r') return true;
  const spec = KEYS[key];
  return Boolean(spec && spec.vk === 13);
}

/**
 * Whether a `key` argument presses Enter anywhere in it (W2).
 *
 * The submit detection tested the literal word "enter" against the argument, so
 * "Return" pressed Enter, the page reacted, and the call reported no submit
 * evidence and a 250ms window. Every spelling the key parser accepts is checked
 * here instead, modifier chords and multi-key sequences included.
 */
export function pressesEnter(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  if (!raw) return false;
  // A bare newline is whitespace, so it never survives the split below.
  if (/[\n\r]/.test(raw)) return true;
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .some((combo) => {
      const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
      return isEnterKeyName(parts[parts.length - 1]);
    });
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

/** Ceiling on the two animation frames a capture waits for. */
const RAF_TIMEOUT_MS = 1000;

/** How many screencasts a capture will open before it accepts what it has. */
const SETTLE_ATTEMPTS = 8;

/** Per-attempt ceiling, so one screencast lost to a re-attach is cheap. */
const ATTEMPT_TIMEOUT_MS = 1200;

/** Pause between two reads of the surface, so a paint in progress can finish. */
const SETTLE_PAUSE_MS = 60;

/**
 * A screencast frame taken once the hidden tab's surface has stopped changing.
 *
 * Chrome draws a hidden tab's compositor surface lazily and pushes no frames
 * while nothing asks for one. Starting a screencast is the request, and the
 * frame it opens with is the surface as it was before that request forced the
 * redraw. Opening a second screencast then returns the redrawn surface.
 *
 * Measured on Chrome 152.0.7977.75 with a second extension injecting an iframe
 * into every page, which makes the attach recovery mutate the DOM on every
 * call: a single screencast returned a blank image for /composer.html and
 * /sensitive.html, byte for byte identical to each other, while /unload.html on
 * the same run was correct. Holding one screencast open across a repaint does
 * not help, because no further frame is ever pushed.
 *
 * So screencasts are opened until two in a row carry the same image, which is
 * the surface saying it has settled. An unchanged page costs two, a page that
 * was mid-repaint costs three, and a page that never stops animating stops at
 * SETTLE_ATTEMPTS with the last frame it produced.
 */
async function settledScreencastFrame(tabId, { format, quality, maxWidth, maxHeight, timeout = 4000 }) {
  // The wake restores requestAnimationFrame on a hidden tab, so two frames of
  // it are the renderer saying it has drawn what is there now.
  await evaluate(tabId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', {
    timeout: RAF_TIMEOUT_MS,
  }).catch(() => {});

  const deadline = Date.now() + timeout;
  let previous = null;
  let lastError = null;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    // A screencast is stopped without waiting for the answer, so a stop from an
    // earlier read can land after the next start. Stopping and waiting first
    // means every start below begins from a known state.
    await send(tabId, 'Page.stopScreencast', {}, { retry: false }).catch(() => {});

    const left = deadline - Date.now();
    if (left <= 0) break;
    let frame;
    try {
      frame = await screencastFrame(tabId, {
        format,
        quality,
        maxWidth,
        maxHeight,
        timeout: Math.min(left, ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      // A screencast started on an attachment the recovery ladder then replaced
      // is simply gone, and no frame will ever arrive on it. Measured with
      // test/fixtures/interferer loaded, which makes every call re-attach: the
      // first screenshot after /spa then /index.html spent the whole timeout
      // waiting for a frame from a dead screencast, every run. Short attempts
      // make that cost one attempt rather than the whole budget.
      lastError = err;
      continue;
    }
    if (previous !== null && frame === previous) return frame;
    previous = frame;
    // A redraw that has started but not finished reads as a half-painted
    // surface, and two reads taken back to back land in the same half. The
    // pause gives the paint somewhere to finish before the next read.
    await sleep(SETTLE_PAUSE_MS, tabId);
  }
  if (previous !== null) return previous;
  // A barren window is transient: measured with the interferer loaded, the call
  // after a failure captured the same tab in about 250 ms every time. Raising it
  // as timeout rather than a bare CdpError puts it under the read retry policy,
  // which is what turns it back into a screenshot.
  throw new ToolError('timeout', 'The hidden tab produced no frame within ' + timeout + 'ms.', {
    cause: 'the compositor had nothing drawn for this tab and did not redraw while the capture waited',
    hint: 'Take the screenshot again. If it repeats, reload the tab with navigate.',
    effects: 'none',
  });
}

/**
 * Whether this build lets the extension debugger read a capture straight from
 * the renderer. Null until the first attempt answers.
 * @type {boolean|null}
 */
let rendererCaptureWorks = null;

/** Test seam, so a suite can drive both capture paths. */
export function resetRendererCaptureProbe() {
  rendererCaptureWorks = null;
}

/**
 * A hidden tab, captured without ever showing it.
 *
 * `clip` arrives in page coordinates, the way Page.captureScreenshot wants it,
 * and `scroll` says where the viewport sits in that space so a crop taken from
 * a screencast frame can be expressed against the frame.
 *
 * Three routes, in order. The renderer capture holds the current document, so
 * it is the only one that cannot return a stale surface, and its clip carries
 * the scale natively. If the build refuses it, a clip that covers the whole
 * viewport is not a crop at all: the screencast is asked for the target size
 * through maxWidth and maxHeight, which is the hidden-tab equivalent of
 * clip.scale and skips the canvas. Anything narrower is cropped in a canvas.
 */
async function captureHidden(tabId, { format, quality, clip, scroll, screencastTimeout } = {}) {
  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  const width = Math.max(1, Math.round(viewport.clientWidth));
  const height = Math.max(1, Math.round(viewport.clientHeight));

  // A tab Chrome has put to sleep produces no screencast frame at all. Measured
  // on Chrome 152.0.7977.75 over the DevTools port: zero frames in four seconds
  // on a background tab, one frame immediately after the same wake this file
  // already uses for input. Page.captureScreenshot is not a way out, it hung
  // for the full 15 s timeout on the same tab.
  //
  // The wake is forced because a tab falls asleep again on every navigation and
  // the recorded state does not: with the cached wake, the first screenshot
  // after a navigate spent the whole 4 s screencast timeout before the retry
  // below rescued it. Two CDP commands cost about 4 ms.
  await wake(tabId, { force: true }).catch(() => {});

  // The renderer holds the current document, so a capture taken from it is
  // never the stale compositor surface a hidden tab keeps. Measured on Chrome
  // 152.0.7977.75 at 256 to 292 ms against a screencast frame's 40 ms, which is
  // worth paying for a picture of the page that is actually there. The
  // screencast path below stays as the fallback, since fromSurface is refused
  // on some builds and there is no way to ask in advance.
  if (rendererCaptureWorks !== false) {
    try {
      const params = { format, fromSurface: false, captureBeyondViewport: false };
      if (quality !== undefined && format === 'jpeg') params.quality = quality;
      if (clip) params.clip = clip;
      const result = await send(tabId, 'Page.captureScreenshot', params, { retry: false, timeout: 10000 });
      if (result && result.data) {
        rendererCaptureWorks = true;
        return result.data;
      }
    } catch (err) {
      // One refusal is taken as this build refusing it, so the cost is paid
      // once rather than on every capture.
      rendererCaptureWorks = false;
    }
  }

  const settled = async (maxWidth, maxHeight) => {
    try {
      return await settledScreencastFrame(tabId, { format, quality, maxWidth, maxHeight, timeout: screencastTimeout });
    } catch (err) {
      // The wake can have worn off since it was last recorded, so it is worth
      // one forced repeat before the capture is given up on.
      await wake(tabId, { force: true }).catch(() => {});
      return settledScreencastFrame(tabId, { format, quality, maxWidth, maxHeight, timeout: screencastTimeout });
    }
  };

  const offsetX = scroll ? scroll.x || 0 : 0;
  const offsetY = scroll ? scroll.y || 0 : 0;
  const crop = clip
    ? { x: clip.x - offsetX, y: clip.y - offsetY, width: clip.width, height: clip.height, scale: clip.scale || 1 }
    : null;
  const wholeViewport =
    !crop ||
    (Math.round(crop.x) <= 0 &&
      Math.round(crop.y) <= 0 &&
      Math.round(crop.width) >= width &&
      Math.round(crop.height) >= height);

  if (wholeViewport) {
    const scale = crop ? crop.scale : 1;
    const maxWidth = Math.max(1, Math.round(width * scale));
    const maxHeight = Math.max(1, Math.round(height * scale));
    return settled(maxWidth, maxHeight);
  }

  const frame = await settled(width, height);

  // The frame was requested at CSS size, so the crop, which is in CSS pixels,
  // maps onto it one to one apart from whatever Chrome rounded.
  const response = await fetch('data:image/' + format + ';base64,' + frame);
  const bitmap = await createImageBitmap(await response.blob());
  const scaleX = bitmap.width / width;
  const scaleY = bitmap.height / height;
  const w = Math.max(1, Math.round(crop.width * crop.scale));
  const h = Math.max(1, Math.round(crop.height * crop.scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    bitmap,
    Math.round(crop.x * scaleX),
    Math.round(crop.y * scaleY),
    Math.round(crop.width * scaleX),
    Math.round(crop.height * scaleY),
    0,
    0,
    w,
    h
  );
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/' + format, quality: quality !== undefined ? quality / 100 : undefined });
  return bytesToBase64(blob);
}

/**
 * Captures the page. A tab on screen is read from its surface, which includes
 * everything the browser composites. A hidden or minimized tab is read from the
 * renderer, or from a screencast frame where the build refuses that, since its
 * surface never draws on its own.
 *
 * `clip` is in page coordinates. `scroll` is the viewport origin in that space,
 * needed only by the hidden path, which works against the frame.
 */
export async function captureScreenshot(tabId, { format = 'png', quality, clip, scroll, screencastTimeout } = {}) {
  if (!(await onScreen(tabId))) return captureHidden(tabId, { format, quality, clip, scroll, screencastTimeout });
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
 * The ref map lives in the content script's isolated world and CDP addresses
 * nodes from its own DOM tree, so the two sides need a way to agree on which
 * element is meant. The previous approach wrote a marker attribute onto the
 * element and read it back with `DOM.querySelector`, which left a
 * page-observable attribute sitting in the DOM for as long as the round trip
 * took (D2). This resolves the node instead through `DOM.querySelectorAll` on
 * the stable structural selector `input[type="file"]`, disambiguating by
 * geometry when a page has more than one, so nothing is ever written to the
 * page's own DOM.
 */
export async function setFileInputFiles(tabId, geometry, files) {
  const { root } = await send(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeIds } = await send(tabId, 'DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!nodeIds || !nodeIds.length) throw new CdpError('could not locate a file input in the DOM tree');
  if (nodeIds.length === 1) {
    await send(tabId, 'DOM.setFileInputFiles', { files, nodeId: nodeIds[0] });
    return;
  }

  // Several file inputs on the page: pick the one whose box model center sits
  // closest to the element the ref resolved to.
  let best = null;
  let bestDist = Infinity;
  for (const nodeId of nodeIds) {
    let box;
    try {
      box = await send(tabId, 'DOM.getBoxModel', { nodeId });
    } catch {
      continue;
    }
    const quad = box && box.model && box.model.content;
    if (!quad || quad.length < 8) continue;
    const cx = (quad[0] + quad[4]) / 2;
    const cy = (quad[1] + quad[5]) / 2;
    const dist = Math.hypot(cx - geometry.centerX, cy - geometry.centerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = nodeId;
    }
  }
  if (best === null || bestDist > 8) {
    throw new CdpError('several file inputs are on the page and none matched the resolved element closely enough');
  }
  await send(tabId, 'DOM.setFileInputFiles', { files, nodeId: best });
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
  // A keyDown carrying text inserts the character on its own, and so does the
  // char event. Sending both typed everything twice: measured on the jQuery UI
  // autocomplete, typing "ja" per key left the field holding "jjaa" and the
  // widget never opened its menu. The keyDown here carries the key identity an
  // autocomplete listens for and no text, and the char event does the insert.
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
  await send(tabId, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'char',
    text: spec.text,
    unmodifiedText: spec.text,
  });
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ---------------------------------------------------------------------------
// Typing cadence (D3)
// ---------------------------------------------------------------------------
//
// Measured on the local probe, per-key typing settled into a 62 to 64 ms band
// and stayed there (D-bot-detection.md section 6). The magnitude is human, the
// variance is not: a keystroke-dynamics classifier reads a near-constant
// interval as machine-generated whatever its value. These draw each interval
// from a distribution around the same mean instead.

/** Mean interval between keystrokes, in milliseconds. */
export const TYPE_CADENCE_MS = 60;
/** Each interval lands within this fraction either side of the mean. */
export const TYPE_CADENCE_JITTER = 0.4;
const TYPE_CADENCE_MAX = 1000;
/** How often a space is followed by the longer pause a person takes between words. */
const WORD_PAUSE_CHANCE = 0.15;
const WORD_PAUSE_MIN = 1.5;
const WORD_PAUSE_MAX = 3;

/**
 * The interval to wait after each character of `text`.
 *
 * The value is the interval the page sees between keystrokes, not a delay added
 * on top of dispatch, so `typeKeysReal` subtracts the time the three key events
 * took. A mean of 60 ms therefore reproduces the measured cadence rather than
 * doubling it, which is what keeps 500 characters inside the old duration.
 *
 * Pure and seedable, so the distribution can be asserted without a browser.
 */
export function typingDelays(text, cadence = TYPE_CADENCE_MS, rand = Math.random) {
  const mean = Number.isFinite(Number(cadence)) ? Math.min(TYPE_CADENCE_MAX, Math.max(0, Number(cadence))) : TYPE_CADENCE_MS;
  const chars = Array.isArray(text) ? text : [...String(text)];
  return chars.map((ch, index) => {
    if (mean === 0) return 0;
    let delay = mean * (1 + (rand() * 2 - 1) * TYPE_CADENCE_JITTER);
    // The pause between words, taken after the space rather than before the
    // next letter, which is where a typist's hands actually stop.
    if (ch === ' ' && index < chars.length - 1 && rand() < WORD_PAUSE_CHANCE) {
      delay += mean * (WORD_PAUSE_MIN + rand() * (WORD_PAUSE_MAX - WORD_PAUSE_MIN));
    }
    return Math.round(delay);
  });
}

/**
 * Types character by character with complete key events (R5), at a cadence
 * drawn per keystroke rather than a fixed interval (D3).
 *
 * Replaces the payload `typeKeys` sent. Kept as a separate export so the old
 * function stays available while both are in the tree.
 */
export async function typeKeysReal(tabId, text, cadence = TYPE_CADENCE_MS) {
  const chars = [...String(text)];
  const delays = typingDelays(chars, cadence);
  for (let i = 0; i < chars.length; i++) {
    const startedAt = Date.now();
    if (chars[i] === '\n') {
      await pressKey(tabId, 'enter');
    } else {
      await pressPrintable(tabId, chars[i]);
    }
    // Three dispatches per character already cost tens of milliseconds, and the
    // drawn value is the whole interval, so only the remainder is waited out.
    const remaining = delays[i] - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining, tabId);
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
  assertNotZoomChord(raw);
  // A newline is Enter rather than a character to insert, which is what a
  // caller writing "\n" means.
  if (raw === '\n' || raw === '\r') return pressKey(tabId, 'enter');
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
    force: 0.5,
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
      // The button is held for the whole drag, so this move reports the same
      // pressure a mousePressed on the same button does.
      force: 0.5,
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
export async function screencastFrameAfter(tabId, sinceMs, { timeout = 300, format = 'jpeg', quality = 50 } = {}) {
  // Same reason as captureHidden: a sleeping tab emits no frame, so the paint
  // wait would report painted false on every hidden tab.
  await wake(tabId, { force: true }).catch(() => {});
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
