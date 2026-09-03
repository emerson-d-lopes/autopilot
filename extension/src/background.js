// Service worker. Owns the native messaging port and routes tool calls.

import { execute, TOOL_NAMES } from './lib/tools.js';
import { parseScript, QuickParseError } from './lib/quick.js';
import { normalizeCall } from './lib/aliases.js';
import * as shortcuts from './lib/shortcuts.js';
import * as tabsLib from './lib/tabs.js';
import * as recorder from './lib/recorder.js';
import { detachAll } from './lib/cdp.js';
import { PermissionDenied } from './lib/permissions.js';

const HOST_NAME = 'com.chromemcp.host';
const BROWSER_ID_KEY = 'browserId';
const KEEPALIVE_ALARM = 'chrome-mcp-keepalive';

// A single native message is capped at 1MB. Screenshots exceed that, so large
// payloads are split and reassembled on the host side.
const CHUNK_SIZE = 384 * 1024;

let port = null;
let connecting = false;
let reconnectDelay = 500;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function postRaw(message) {
  if (!port) throw new Error('native port is not connected');
  port.postMessage(message);
}

let chunkSeq = 0;

/** Sends a message, splitting oversized payloads into ordered chunks. */
function post(message) {
  const json = JSON.stringify(message);
  if (json.length <= CHUNK_SIZE) {
    postRaw(message);
    return;
  }
  const id = 'chunk_' + ++chunkSeq;
  const total = Math.ceil(json.length / CHUNK_SIZE);
  for (let i = 0; i < total; i++) {
    postRaw({
      type: 'chunk',
      id,
      index: i,
      total,
      data: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    });
  }
}

/**
 * Stable identity for this browser install.
 *
 * The host cannot tell which browser launched it, and the pipe name and the
 * registry entry both need to be unique per browser, so the extension supplies
 * the identity and persists the id so it survives a worker restart.
 */
async function browserIdentity() {
  const stored = await chrome.storage.local.get(BROWSER_ID_KEY);
  let id = stored[BROWSER_ID_KEY];
  if (!id) {
    id = 'b' + Math.random().toString(36).slice(2, 10);
    await chrome.storage.local.set({ [BROWSER_ID_KEY]: id });
  }

  const ua = navigator.userAgent;
  let name = 'Chrome';
  if (/Edg\//.test(ua)) name = 'Edge';
  else if (/OPR\//.test(ua)) name = 'Opera';
  else if (/Vivaldi/.test(ua)) name = 'Vivaldi';
  else if (/Brave/.test(ua)) name = 'Brave';
  else if (/HeadlessChrome/.test(ua)) name = 'Chrome (headless)';

  const version = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || 'unknown';
  return { id, name, version };
}

function connect() {
  if (port || connecting) return;
  connecting = true;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  connecting = false;
  reconnectDelay = 500;

  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    port = null;
    console.log('[chrome-mcp] native port disconnected', err ? err.message : '');
    scheduleReconnect();
  });

  browserIdentity().then(
    (browser) => {
      try {
        post({
          type: 'hello',
          tools: TOOL_NAMES,
          version: chrome.runtime.getManifest().version,
          browser,
        });
      } catch {
        /* the port went away while we were reading storage */
      }
    },
    () => {
      try {
        post({ type: 'hello', tools: TOOL_NAMES, version: chrome.runtime.getManifest().version });
      } catch {
        /* nothing more to do */
      }
    }
  );
}

function scheduleReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  setTimeout(() => {
    if (!port) connect();
  }, delay);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function serializeError(err) {
  if (err instanceof PermissionDenied) {
    return { message: err.message, kind: 'permission_denied', details: err.details };
  }
  return { message: String((err && err.message) || err), kind: 'error' };
}

async function runTool(name, input, ctx) {
  const started = Date.now();
  const result = await execute(name, input, ctx);
  return { ...(result && typeof result === 'object' ? result : { value: result }), durationMs: Date.now() - started };
}

/**
 * Runs a sequence in one round trip. Stops at the first error so a batch cannot
 * keep acting on a page after a step failed to land.
 */
async function runBatch(actions, ctx) {
  const results = [];
  let lastCreatedTab = null;
  for (let i = 0; i < actions.length; i++) {
    const { lineNo, command } = actions[i];
    const { name, input } = normalizeCall(actions[i].name, actions[i].input);
    // A tab created earlier in the same batch has no id at authoring time, so
    //  stands for it. That is what lets quick's NT be followed by actions.
    if (input && input.tabId === '$last') {
      if (lastCreatedTab === null) {
        results.push({ index: i, name, lineNo, command, ok: false, error: { message: 'no tab was created earlier in this batch for $last to refer to' } });
        return { results, stoppedAt: i, completed: false };
      }
      input.tabId = lastCreatedTab;
    }
    try {
      const result = await runTool(name, input, ctx);
      if (name === 'tabs_create' && result && result.tabId !== undefined) lastCreatedTab = result.tabId;
      results.push({ index: i, name, lineNo, command, ok: true, result });
    } catch (err) {
      results.push({ index: i, name, lineNo, command, ok: false, error: serializeError(err) });
      return { results, stoppedAt: i, completed: false };
    }
  }
  return { results, completed: true };
}

/**
 * Quick mode. The whole script is parsed before anything runs, so a typo on the
 * last line cannot leave the page half way through a sequence.
 */
async function runQuick(args, ctx) {
  let actions;
  try {
    actions = parseScript(args.script, args.tabId);
  } catch (err) {
    if (err instanceof QuickParseError) {
      const wrapped = new Error('Script not run. ' + err.message);
      wrapped.parseError = true;
      throw wrapped;
    }
    throw err;
  }
  return { ...(await runBatch(actions, ctx)), quick: true, parsed: actions.length };
}

/** Runs a saved shortcut, which is a stored quick script. */
async function runShortcut(args, ctx) {
  const shortcut = await shortcuts.find(args.shortcutId);
  if (!shortcut) {
    const all = await shortcuts.list();
    throw new Error(
      'No shortcut named ' + JSON.stringify(args.shortcutId) + '. ' +
        (all.length ? 'Available: ' + all.map((s) => s.id + ' (' + s.name + ')').join(', ') : 'None are saved yet.')
    );
  }
  const result = await runQuick({ script: shortcut.script, tabId: args.tabId }, ctx);
  return { ...result, shortcut: { id: shortcut.id, name: shortcut.name } };
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'ping':
      post({ type: 'pong', id: message.id, at: Date.now() });
      return;

    case 'get_status': {
      const context = message.clientId ? await tabsLib.tabsContext(message.clientId) : null;
      post({
        type: 'status',
        id: message.id,
        version: chrome.runtime.getManifest().version,
        tools: TOOL_NAMES,
        context,
      });
      return;
    }

    case 'tool_request': {
      const { id, clientId, toolUseId } = message;
      const { name: tool, input: args } = normalizeCall(message.tool, message.args);
      const ctx = { clientId: clientId || 'default', toolUseId };
      // The page a call acted on, for the host's action journal. Read after
      // the call so a navigation is reported by where it landed.
      const tabMeta = async (tabId) => {
        if (tabId === undefined || tabId === null || typeof tabId !== 'number') return undefined;
        try {
          const tab = await chrome.tabs.get(tabId);
          return { id: tabId, url: tab.url, title: tab.title };
        } catch {
          return { id: tabId };
        }
      };
      // The group's title shows the state of the call. Never awaited on the
      // way in, so a slow tab group update cannot delay the action.
      // A listing call changes nothing and would only see its own hourglass,
      // so it leaves the mark as the last real call set it.
      const marks = tool !== 'tabs_context';
      const mark = (status) => (marks ? tabsLib.setGroupStatus(ctx.clientId, status).catch(() => {}) : Promise.resolve());
      mark('working');
      inFlight++;
      try {
        let result;
        if (tool === 'browser_batch') result = await runBatch(args.actions || [], ctx);
        else if (tool === 'quick') result = await runQuick(args, ctx);
        else if (tool === 'shortcuts_execute') result = await runShortcut(args, ctx);
        else result = await runTool(tool, args, ctx);
        const tab = await tabMeta(args && args.tabId !== undefined ? args.tabId : result && result.tabId);
        const failedStep = result && result.results && result.results.some((s) => !s.ok);
        await mark(failedStep ? 'error' : 'done');
        remember(tool, args, !failedStep, failedStep ? (result.results.find((s) => !s.ok) || {}).error : null, tab);
        post({ type: 'tool_response', id, result, tab });
      } catch (err) {
        const tab = await tabMeta(args && args.tabId);
        await mark('error');
        remember(tool, args, false, err, tab);
        post({ type: 'tool_response', id, error: serializeError(err), tab });
      } finally {
        inFlight--;
      }
      return;
    }

    case 'release_session': {
      try {
        const result = await tabsLib.releaseSession(message.clientId || 'default', {
          closeEmptyOnly: message.closeEmptyOnly !== false,
        });
        post({ type: 'released', id: message.id, result });
      } catch (err) {
        post({ type: 'released', id: message.id, error: serializeError(err) });
      }
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

// An MV3 worker is torn down after 30s idle. Traffic on a connected port resets
// that timer, so the host's periodic ping keeps the worker alive while a client
// is attached. The alarm is the backstop for the window where the worker died
// before the host reconnected: alarms restart the worker, which reconnects.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && !port) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// The last few calls, for the popup. The host keeps the full journal on disk;
// this is only what fits in a glance.
let recent = [];
let inFlight = 0;
Promise.resolve()
  .then(() => chrome.storage.session.get('recent'))
  .then((stored) => {
    if (Array.isArray(stored.recent) && !recent.length) recent = stored.recent;
  })
  .catch(() => {});

function remember(tool, args, ok, error, tab) {
  const detail =
    tool === 'navigate' && args && args.url ? String(args.url).slice(0, 60)
    : tool === 'computer' && args ? String(args.action || '')
    : tool === 'browser_batch' && args && Array.isArray(args.actions) ? args.actions.length + ' steps'
    : tab && tab.title ? String(tab.title).slice(0, 40)
    : '';
  recent.push({ at: Date.now(), tool, detail, ok, error: error ? String(error.message || error).slice(0, 200) : undefined });
  while (recent.length > 20) recent.shift();
  Promise.resolve().then(() => chrome.storage.session.set({ recent })).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'popup_state') {
    tabsLib.listSessions().then(
      (sessions) =>
        sendResponse({
          version: chrome.runtime.getManifest().version,
          connected: Boolean(port),
          working: inFlight > 0,
          sessions,
          recent,
        }),
      () => sendResponse({ version: chrome.runtime.getManifest().version, connected: Boolean(port), working: inFlight > 0, sessions: [], recent })
    );
    return true;
  }
  if (message.type === 'reveal_session') {
    tabsLib.revealSession(message.clientId).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'close_empty_tabs') {
    tabsLib.listSessions().then(async (sessions) => {
      let closed = 0;
      for (const s of sessions) {
        const r = await tabsLib.releaseSession(s.clientId, { closeEmptyOnly: true }).catch(() => ({ closed: 0 }));
        closed += r.closed || 0;
      }
      sendResponse({ closed });
    });
    return true;
  }
  return false;
});

// A worker that died mid-call leaves its group marked as working. Every known
// group goes back to idle when the worker starts, so a mark always describes
// a call this worker made.
tabsLib.resetGroupStatuses().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  recorder.clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) recorder.noteNavigation(tabId, info.url);
});

self.addEventListener('activate', () => {
  connect();
});

// Detach cleanly if the worker is being replaced, so tabs do not keep a stale
// debugger banner from a worker that no longer exists.
self.addEventListener('beforeunload', () => {
  detachAll();
});

recorder.installListener();
connect();
