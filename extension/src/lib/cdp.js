// Chrome DevTools Protocol wrapper.
//
// All input is dispatched through CDP so events arrive with isTrusted true.
// Synthetic DOM events are rejected by file inputs, native drag and drop, and
// most bot detection, so there is no synthetic fallback path.

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

function lastError() {
  const err = chrome.runtime.lastError;
  return err ? new CdpError(err.message) : null;
}

export function attach(tabId) {
  installDetachListener();
  return new Promise((resolve, reject) => {
    const state = attachments.get(tabId);
    if (state && state.attached) {
      state.refs++;
      return resolve();
    }
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      const err = lastError();
      if (err) {
        // Another client (an open DevTools window) already owns this tab.
        if (/already attached/i.test(err.message)) {
          attachments.set(tabId, { attached: true, refs: 1, foreign: true });
          return resolve();
        }
        if (/chrome-extension/i.test(err.message)) {
          return describeFrames(tabId).then((detail) => reject(new CdpError(err.message + detail)));
        }
        return reject(err);
      }
      attachments.set(tabId, { attached: true, refs: 1 });
      resolve();
    });
  });
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

function rawSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = lastError();
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

export async function send(tabId, method, params = {}, { retry = true } = {}) {
  installDetachListener();
  try {
    return await rawSend(tabId, method, params);
  } catch (err) {
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
  const command = send(tabId, 'Input.dispatchMouseEvent', params).then(
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

export async function evaluate(tabId, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
    replMode: true,
  });
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
  try {
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }, { retry: false });
  } catch {
    /* an older Chrome without the method still gets the lifecycle state */
  }
  try {
    await send(tabId, 'Page.setWebLifecycleState', { state: 'active' }, { retry: false });
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
