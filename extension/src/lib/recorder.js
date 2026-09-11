// Console and network capture.
//
// Buffers CDP events per tab from the moment the tab joins the session, so a
// network read returns everything since page load rather than only what
// happened after the model thought to look. Requires the debugger to stay
// attached, which is why session tabs hold an attachment for their lifetime
// rather than only for the duration of a single action.
//
// Console capture is the exception (D1). `Runtime.enable` is what a production
// detector reads to decide a page is being driven, and only the console needs
// it: `Runtime.evaluate`, every input path, `Page`, `DOM` and `Network` all work
// with `Runtime` off. So it is issued on the first `read_console_messages` for
// a tab and withdrawn again on a read that clears the buffer. The cost is the
// messages logged before that first read, which the first result says it lost.

import { send, enableDomains, attach, isAttached, wake } from './cdp.js';

const CONSOLE_LIMIT = 1000;
const NETWORK_LIMIT = 500;

/** Domains every session tab gets. `Runtime` is deliberately absent (D1). */
const BASE_DOMAINS = ['Log', 'Network', 'Page', 'DOM'];

/**
 * How console capture is armed, from chrome.storage.local (options page).
 *
 * `lazy` is the default and enables `Runtime` on the first console read.
 * `always` enables it when the tab joins the session, which is the behaviour
 * before D1, for a session that would rather not lose the early messages.
 */
const CONSOLE_CAPTURE_KEY = 'consoleCapture';

export async function consoleCaptureMode() {
  try {
    const stored = await chrome.storage.local.get(CONSOLE_CAPTURE_KEY);
    return stored && stored[CONSOLE_CAPTURE_KEY] === 'always' ? 'always' : 'lazy';
  } catch {
    return 'lazy';
  }
}

/**
 * @type {Map<number, {console: Array, network: Map<string, object>, order: Array<string>,
 *   listening: boolean, consoleOn: boolean, consoleNotice: boolean, consoleMissed: boolean}>}
 */
const buffers = new Map();

function bufferFor(tabId) {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = {
      console: [],
      network: new Map(),
      order: [],
      listening: false,
      // Whether Runtime is on for this tab, whether the next read still owes
      // the caller the notice that capture started late, and whether anything
      // was ever missed on this tab.
      consoleOn: false,
      consoleNotice: false,
      consoleMissed: false,
      // When the buffer was last emptied by a read, when Runtime was last
      // armed, and whether Chrome replayed history into it after that arming.
      consoleClearedAt: 0,
      consoleArmedAt: 0,
      consoleReplayed: false,
    };
    buffers.set(tabId, buf);
  }
  return buf;
}

/**
 * Whether an entry's timestamp can be compared with a wall clock reading.
 *
 * Runtime.consoleAPICalled and Log.entryAdded both stamp milliseconds since the
 * epoch. Anything else in the buffer (the navigation marker writes seconds) is
 * left alone rather than judged against the wrong scale.
 */
function epochMs(entry) {
  const at = entry && entry.timestamp;
  return typeof at === 'number' && Number.isFinite(at) && at > 1e12 ? at : null;
}

/**
 * Buffers one console entry, dropping what Chrome replayed from before a clear.
 *
 * `Runtime.enable` replays the console history the page has retained, so the
 * read after a clearing read got the same messages back and the clear looked
 * like it had done nothing. An entry stamped before the clear is that history
 * and is dropped here, where both the replay and live output arrive.
 */
function pushConsole(tabId, entry) {
  const buf = bufferFor(tabId);
  const at = epochMs(entry);
  if (at !== null) {
    if (buf.consoleClearedAt && at < buf.consoleClearedAt) return;
    // Output that predates the arming was replayed rather than captured live,
    // which is what the first read has to say instead of claiming it was lost.
    if (buf.consoleArmedAt && at < buf.consoleArmedAt) buf.consoleReplayed = true;
  }
  buf.console.push(entry);
  if (buf.console.length > CONSOLE_LIMIT) buf.console.splice(0, buf.console.length - CONSOLE_LIMIT);
}

function upsertRequest(tabId, requestId, patch) {
  const buf = bufferFor(tabId);
  const existing = buf.network.get(requestId);
  if (existing) {
    Object.assign(existing, patch);
    return;
  }
  buf.network.set(requestId, { requestId, ...patch });
  buf.order.push(requestId);
  while (buf.order.length > NETWORK_LIMIT) {
    const evicted = buf.order.shift();
    buf.network.delete(evicted);
  }
}

function formatRemoteObject(arg) {
  if (!arg) return '';
  if (arg.type === 'string') return arg.value;
  if ('value' in arg) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return String(arg.unserializableValue);
  if (arg.preview) {
    if (arg.preview.description) return arg.preview.description;
    const props = (arg.preview.properties || []).map((p) => p.name + ': ' + p.value).join(', ');
    return (arg.className || 'Object') + ' {' + props + '}';
  }
  return arg.description || arg.className || arg.type || '';
}

/**
 * The debugger event listener. Exported so a suite can replay what Chrome
 * sends, including the console history Runtime.enable hands over.
 */
export function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId === undefined) return;

  switch (method) {
    case 'Runtime.consoleAPICalled': {
      pushConsole(tabId, {
        level: params.type === 'warning' ? 'warn' : params.type,
        text: (params.args || []).map(formatRemoteObject).join(' '),
        timestamp: params.timestamp,
        url: params.stackTrace && params.stackTrace.callFrames[0] && params.stackTrace.callFrames[0].url,
        line:
          params.stackTrace && params.stackTrace.callFrames[0]
            ? params.stackTrace.callFrames[0].lineNumber + 1
            : undefined,
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const details = params.exceptionDetails || {};
      const description =
        (details.exception && (details.exception.description || details.exception.value)) || details.text;
      pushConsole(tabId, {
        level: 'error',
        text: String(description || 'uncaught exception'),
        timestamp: params.timestamp,
        url: details.url,
        line: details.lineNumber !== undefined ? details.lineNumber + 1 : undefined,
      });
      break;
    }
    case 'Log.entryAdded': {
      const entry = params.entry || {};
      pushConsole(tabId, {
        level: entry.level === 'warning' ? 'warn' : entry.level,
        text: entry.text,
        timestamp: entry.timestamp,
        url: entry.url,
        line: entry.lineNumber !== undefined ? entry.lineNumber + 1 : undefined,
        source: entry.source,
      });
      break;
    }
    case 'Network.requestWillBeSent': {
      upsertRequest(tabId, params.requestId, {
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type,
        startedAt: params.timestamp,
      });
      break;
    }
    case 'Network.responseReceived': {
      upsertRequest(tabId, params.requestId, {
        status: params.response.status,
        statusText: params.response.statusText,
        mimeType: params.response.mimeType,
        fromCache: params.response.fromDiskCache || params.response.fromPrefetchCache || false,
      });
      break;
    }
    case 'Network.loadingFinished': {
      upsertRequest(tabId, params.requestId, {
        encodedDataLength: params.encodedDataLength,
        finishedAt: params.timestamp,
      });
      break;
    }
    case 'Network.loadingFailed': {
      upsertRequest(tabId, params.requestId, {
        failed: true,
        errorText: params.errorText,
        canceled: params.canceled,
        finishedAt: params.timestamp,
      });
      break;
    }
    default:
      break;
  }
}

let listenerInstalled = false;

export function installListener() {
  if (listenerInstalled) return;
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      const buf = buffers.get(source.tabId);
      if (buf) {
        buf.listening = false;
        // The domain state died with the session, so the next startCapture has
        // to enable everything again rather than trusting these flags.
        buf.consoleOn = false;
      }
    }
  });
  listenerInstalled = true;
}

/** Attaches and enables the capture domains for a tab. Idempotent. */
export async function startCapture(tabId) {
  installListener();
  const buf = bufferFor(tabId);
  const mode = await consoleCaptureMode();
  if (buf.listening && isAttached(tabId)) {
    // The setting can change between calls, so an already-capturing tab still
    // gets Runtime turned on when the mode says always.
    if (mode === 'always') await enableConsole(tabId, { notice: false });
    return;
  }
  if (!isAttached(tabId)) await attach(tabId);
  await enableDomains(tabId, BASE_DOMAINS);
  try {
    await send(tabId, 'Network.setCacheDisabled', { cacheDisabled: false });
  } catch {
    /* optional */
  }
  await wake(tabId);
  buf.listening = true;
  if (mode === 'always') await enableConsole(tabId, { notice: false });
}

/**
 * Turns on the domain that carries console output and uncaught exceptions.
 *
 * `notice` records that this tab started capturing after it joined the session,
 * so the read that turned it on can say what it did not see.
 *
 * @returns {Promise<boolean>} true when this call is the one that enabled it.
 */
export async function enableConsole(tabId, { notice = true } = {}) {
  const buf = bufferFor(tabId);
  if (buf.consoleOn) return false;
  // Stamped before the command goes out, so a replayed entry that arrives while
  // it is in flight is still recognised as history rather than live output.
  buf.consoleArmedAt = Date.now();
  buf.consoleReplayed = false;
  await enableDomains(tabId, ['Runtime']);
  buf.consoleOn = true;
  if (notice) {
    buf.consoleNotice = true;
    buf.consoleMissed = true;
  }
  return true;
}

/**
 * Turns console capture back off, leaving the tab driven by Page, DOM and
 * Network only.
 *
 * Refused while the mode is `always`, which is the setting that asks for
 * capture to stay on for the life of the tab.
 *
 * @returns {Promise<boolean>} true when this call is the one that disabled it.
 */
export async function disableConsole(tabId) {
  const buf = buffers.get(tabId);
  if (!buf || !buf.consoleOn) return false;
  if ((await consoleCaptureMode()) === 'always') return false;
  try {
    await send(tabId, 'Runtime.disable', {}, { retry: false });
  } catch {
    /* the tab may already be gone, and the flag has to come down either way */
  }
  buf.consoleOn = false;
  buf.consoleMissed = true;
  return true;
}

/** Whether Runtime is currently on for this tab. */
export function isConsoleCapturing(tabId) {
  const buf = buffers.get(tabId);
  return Boolean(buf && buf.consoleOn);
}

const LATE_CAPTURE_WARNING =
  'console capture started with this call, so console output and uncaught exceptions from before it were not ' +
  'recorded. Set console capture to always in the extension options to capture from the moment a tab joins the ' +
  'session, at the cost of leaving Runtime enabled, which is what a CDP detector reads.';

/**
 * What to say when Runtime.enable replayed the page's console history.
 *
 * The old wording claimed output from before the call was not recorded while
 * the same result listed output from page load, which the caller could see was
 * untrue. Chrome keeps a bounded history and hands it over on enable, so what
 * is missing is whatever fell out of that history, not everything before now.
 */
const REPLAYED_HISTORY_WARNING =
  'console capture started with this call. Chrome replayed the console history it had kept for this tab, so ' +
  'entries from before this call are included; anything older than that history is not. Set console capture to ' +
  'always in the extension options to capture live from the moment a tab joins the session, at the cost of ' +
  'leaving Runtime enabled, which is what a CDP detector reads.';

/** What to say when an earlier read cleared the buffer and this one re-armed capture. */
const REARMED_AFTER_CLEAR_WARNING =
  'console capture was re-armed by this call after an earlier read cleared the buffer. The history Chrome replayed ' +
  'from before that clear is filtered out, so this result holds output from after it.';

const MISSED_ERRORS_WARNING =
  'uncaught exceptions need console capture, which was off on this tab until now, so an error thrown earlier is ' +
  'not in this result even when only_errors is set.';

export function readConsole(tabId, { onlyErrors = false, pattern = null, limit = 100, clear = false } = {}) {
  const buf = bufferFor(tabId);
  const warnings = [];
  // Consumed here, so the notice rides on the read that started capture and
  // not on every read after it. Which of the three it is depends on what
  // actually happened: a clear this read is filtering, history Chrome replayed,
  // or a tab that logged nothing before capture started.
  if (buf.consoleNotice) {
    if (buf.consoleClearedAt) warnings.push(REARMED_AFTER_CLEAR_WARNING);
    else if (buf.consoleReplayed) warnings.push(REPLAYED_HISTORY_WARNING);
    else warnings.push(LATE_CAPTURE_WARNING);
    buf.consoleNotice = false;
  }
  if (onlyErrors && buf.consoleMissed) warnings.push(MISSED_ERRORS_WARNING);
  let entries = buf.console;

  if (onlyErrors) entries = entries.filter((e) => e.level === 'error' || e.level === 'assert');
  if (pattern) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error('invalid pattern: ' + err.message);
    }
    entries = entries.filter((e) => re.test(e.text || ''));
  }

  const total = entries.length;
  const sliced = entries.slice(-Math.max(1, limit));
  if (clear) {
    buf.console = [];
    // The moment the buffer was emptied, so the history Chrome replays on the
    // next Runtime.enable does not refill it with the same messages.
    buf.consoleClearedAt = Date.now();
    buf.consoleReplayed = false;
  }
  return {
    entries: sliced,
    total,
    returned: sliced.length,
    capturing: buf.listening,
    consoleCapturing: buf.consoleOn,
    warnings,
  };
}

const RELEASED_WARNING =
  'console capture was turned off again because this read cleared the buffer. The next read turns it back on and ' +
  'starts from that moment.';

/**
 * A console read, with the capture domain arming and disarming around it (D1).
 *
 * This is the whole of the opt-in: a read turns `Runtime` on, and a read that
 * clears the buffer turns it back off, so a session that never asks for the
 * console never issues `Runtime.enable` on any tab.
 */
export async function readConsoleMessages(tabId, options = {}) {
  await enableConsole(tabId);
  const result = readConsole(tabId, options);
  if (options.clear && (await disableConsole(tabId))) {
    result.consoleCapturing = false;
    result.warnings = result.warnings.concat(RELEASED_WARNING);
  }
  return result;
}

export function readNetwork(tabId, { urlPattern = null, limit = 100, clear = false, onlyFailed = false } = {}) {
  const buf = bufferFor(tabId);
  let requests = buf.order.map((id) => buf.network.get(id)).filter(Boolean);

  if (urlPattern) {
    let re;
    try {
      re = new RegExp(urlPattern, 'i');
    } catch (err) {
      throw new Error('invalid urlPattern: ' + err.message);
    }
    requests = requests.filter((r) => re.test(r.url || ''));
  }
  if (onlyFailed) requests = requests.filter((r) => r.failed || (r.status && r.status >= 400));

  const total = requests.length;
  const sliced = requests.slice(-Math.max(1, limit));
  if (clear) {
    buf.network.clear();
    buf.order = [];
  }
  return { requests: sliced, total, returned: sliced.length, capturing: buf.listening };
}

/**
 * Requests that have started and not finished. Streams that never finish
 * (sockets, event sources, media) are left out, and so is anything older than
 * the window, since a long poll would otherwise hold every wait to its timeout.
 */
export function pendingRequests(tabId, windowMs = 15000) {
  const buf = buffers.get(tabId);
  if (!buf) return 0;
  const cutoff = Date.now() / 1000 - windowMs / 1000;
  let count = 0;
  for (const id of buf.order) {
    const r = buf.network.get(id);
    if (!r || r.finishedAt !== undefined || r.startedAt === undefined) continue;
    if (/^(WebSocket|EventSource|Media|Ping)$/i.test(r.resourceType || '')) continue;
    if (r.startedAt < cutoff) continue;
    count++;
  }
  return count;
}

export function clearTab(tabId) {
  buffers.delete(tabId);
}

/** Console entries survive navigation by design, so a reload does not erase the errors that caused it. */
export function noteNavigation(tabId, url) {
  pushConsole(tabId, { level: 'info', text: '--- navigated to ' + url + ' ---', timestamp: Date.now() / 1000 });
}
