// Console and network capture.
//
// Buffers CDP events per tab from the moment the tab joins the session, so a
// read returns everything since page load rather than only what happened after
// the model thought to look. Requires the debugger to stay attached, which is
// why session tabs hold an attachment for their lifetime rather than only for
// the duration of a single action.

import { send, enableDomains, attach, isAttached, wake } from './cdp.js';

const CONSOLE_LIMIT = 1000;
const NETWORK_LIMIT = 500;

/** @type {Map<number, {console: Array, network: Map<string, object>, order: Array<string>, listening: boolean}>} */
const buffers = new Map();

function bufferFor(tabId) {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = { console: [], network: new Map(), order: [], listening: false };
    buffers.set(tabId, buf);
  }
  return buf;
}

function pushConsole(tabId, entry) {
  const buf = bufferFor(tabId);
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
    const props = (arg.preview.properties || [])
      .map((p) => p.name + ': ' + p.value)
      .join(', ');
    return (arg.className || 'Object') + ' {' + props + '}';
  }
  return arg.description || arg.className || arg.type || '';
}

function onDebuggerEvent(source, method, params) {
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
      if (buf) buf.listening = false;
    }
  });
  listenerInstalled = true;
}

/** Attaches and enables the capture domains for a tab. Idempotent. */
export async function startCapture(tabId) {
  installListener();
  const buf = bufferFor(tabId);
  if (buf.listening && isAttached(tabId)) return;
  if (!isAttached(tabId)) await attach(tabId);
  await enableDomains(tabId, ['Runtime', 'Log', 'Network', 'Page', 'DOM']);
  try {
    await send(tabId, 'Network.setCacheDisabled', { cacheDisabled: false });
  } catch {
    /* optional */
  }
  await wake(tabId);
  buf.listening = true;
}

export function readConsole(tabId, { onlyErrors = false, pattern = null, limit = 100, clear = false } = {}) {
  const buf = bufferFor(tabId);
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
  if (clear) buf.console = [];
  return { entries: sliced, total, returned: sliced.length, capturing: buf.listening };
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
