// Service worker. Owns the native messaging port and routes tool calls.

import { execute, TOOL_NAMES } from './lib/tools.js';
import { parseScript, QuickParseError } from './lib/quick.js';
import { normalizeCall } from './lib/aliases.js';
import * as shortcuts from './lib/shortcuts.js';
import * as tabsLib from './lib/tabs.js';
import * as recorder from './lib/recorder.js';
import * as cdp from './lib/cdp.js';
import { PermissionDenied } from './lib/permissions.js';
import * as sessions from './lib/sessions.js';
import { ToolError, isToolError } from './lib/errors.js';

const { detachAll } = cdp;

const HOST_NAME = 'com.chromemcp.host';
const BROWSER_ID_KEY = 'browserId';
const BROWSER_LABEL_KEY = 'browserLabel';
const KEEPALIVE_ALARM = 'chrome-mcp-keepalive';
const OFFSCREEN_PATH = 'offscreen.html';

// A tab that cannot be attached is replaced rather than lost. The tab
// bookkeeping is wired in here so cdp.js does not have to import the module
// that imports it.
cdp.setSessionReplacer(tabsLib.replaceSessionTab);

// A single native message is capped at 1MB. Screenshots exceed that, so large
// payloads are split and reassembled on the host side.
const CHUNK_SIZE = 384 * 1024;

let port = null;
let connecting = false;
let reconnectDelay = 500;

// Bumped every time the port drops. A tool that finishes after a reconnect
// belongs to a session that no longer exists, and delivering its result into
// the new one would answer a request nobody made.
let generation = 0;

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
  const stored = await chrome.storage.local.get([BROWSER_ID_KEY, BROWSER_LABEL_KEY]);
  let id = stored[BROWSER_ID_KEY];
  if (!id) {
    id = 'b' + Math.random().toString(36).slice(2, 10);
    await chrome.storage.local.set({ [BROWSER_ID_KEY]: id });
  }
  const label = String(stored[BROWSER_LABEL_KEY] || '').trim();

  const ua = navigator.userAgent;
  let name = 'Chrome';
  if (/Edg\//.test(ua)) name = 'Edge';
  else if (/OPR\//.test(ua)) name = 'Opera';
  else if (/Vivaldi/.test(ua)) name = 'Vivaldi';
  else if (/Brave/.test(ua)) name = 'Brave';
  else if (/HeadlessChrome/.test(ua)) name = 'Chrome (headless)';

  const version = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || 'unknown';
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
  return { id, name, version, label, platform, account: await profileAccount() };
}

/**
 * The Chrome-signed-in account for this profile.
 *
 * getProfileUserInfo answers without a prompt and without a sign-in flow, which
 * is what makes it usable in the hello frame. accountStatus ANY reports the
 * account even when the user has not turned sync on. Both fields come back
 * empty on a profile with nobody signed in, which is a fact worth sending
 * rather than an error.
 */
async function profileAccount() {
  const empty = { email: '', id: '' };
  if (!chrome.identity || typeof chrome.identity.getProfileUserInfo !== 'function') return empty;
  try {
    const info = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      try {
        const maybe = chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, done);
        if (maybe && typeof maybe.then === 'function') maybe.then(done, () => done(null));
      } catch {
        done(null);
      }
    });
    return { email: (info && info.email) || '', id: (info && info.id) || '' };
  } catch {
    return empty;
  }
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
    generation++;
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
  // A catalogue error carries everything the result contract asks for, so it is
  // passed through rather than flattened to a string.
  if (isToolError(err)) {
    return { kind: 'tool_error', ...err.toJSON() };
  }
  return { message: String((err && err.message) || err), kind: 'error' };
}

/**
 * Folds what happened underneath a call into its result: a dialog that was
 * answered, an attach that only worked after a recovery. Both happen below the
 * tool, so neither can return through it.
 */
function applyNotes(result, notes) {
  if (!notes.length) return result;
  const out = result && typeof result === 'object' && !Array.isArray(result) ? { ...result } : { value: result };
  const warnings = [...(Array.isArray(out.warnings) ? out.warnings : [])];
  const dialogs = [];
  for (const entry of notes) {
    if (entry.kind === 'dialog') {
      dialogs.push(entry.dialog);
      warnings.push(
        'a ' + entry.dialog.type + ' dialog was ' + entry.dialog.handled + ': ' + JSON.stringify(entry.dialog.message || '')
      );
    } else if (entry.message) {
      warnings.push(entry.message);
    }
  }
  if (dialogs.length) {
    out.dialog = dialogs[0];
    if (dialogs.length > 1) out.dialogs = dialogs;
  }
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** The same notes, for a call that ended in an error. */
function notesForError(notes) {
  const carrier = applyNotes({}, notes);
  const extra = {};
  if (carrier.warnings) extra.warnings = carrier.warnings;
  if (carrier.dialog) extra.dialog = carrier.dialog;
  return extra;
}

/**
 * Answers a request, unless the port it arrived on has since dropped.
 *
 * A tool that finishes after a reconnect belongs to a session that no longer
 * exists. Delivering its result would answer a request the current host never
 * made, so the result is dropped and the drop is recorded, since a silently
 * missing reply is the thing this guards against.
 */
function respond(message, bornAt, tool) {
  if (bornAt !== generation) {
    try {
      post({
        type: 'journal_note',
        event: 'stale_response_dropped',
        tool,
        id: message.id,
        callId: message.callId,
        detail: 'the native port reconnected while this call was running, so its result was dropped',
      });
    } catch {
      /* the replacement port is not up yet either */
    }
    console.log('[chrome-mcp] dropped a stale tool_response for', tool);
    return false;
  }
  post(message);
  return true;
}

async function runTool(name, input, ctx) {
  const started = Date.now();
  const result = await execute(name, input, ctx);
  return { ...(result && typeof result === 'object' ? result : { value: result }), durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Batch pre-validation
// ---------------------------------------------------------------------------

/** Arguments a tool cannot run without. Checked before the batch starts. */
const REQUIRED_ARGS = {
  navigate: ['tabId', 'url'],
  read_page: ['tabId'],
  get_page_text: ['tabId'],
  find: ['tabId', 'query'],
  form_input: ['tabId', 'ref', 'value'],
  computer: ['tabId', 'action'],
  file_upload: ['tabId', 'paths'],
  gif_creator: ['tabId', 'action'],
  javascript: ['tabId', 'code'],
  read_console_messages: ['tabId'],
  read_network_requests: ['tabId'],
  page_state: ['tabId'],
  wait_for_page: ['tabId'],
  resize_window: ['tabId', 'width', 'height'],
  tabs_close: ['tabId'],
  shortcuts_execute: ['shortcutId'],
};

const COMPUTER_ACTIONS = new Set([
  'screenshot', 'zoom', 'wait', 'scroll_to', 'hover',
  'left_click', 'right_click', 'double_click', 'triple_click',
  'left_click_drag', 'type', 'key', 'scroll',
]);

function describeItem(index, action) {
  const where = action && action.lineNo !== undefined ? 'line ' + action.lineNo : 'item ' + (index + 1);
  return where + ' (' + ((action && action.name) || 'no tool named') + ')';
}

/**
 * Checks every item before the first one runs.
 *
 * Validating as the batch went meant a typo in item five cost the side effects
 * of items one to four, with no way to undo them. Everything knowable up front
 * (the tool name, the arguments it cannot run without, and whether the tab
 * belongs to this session) is checked here instead. Quick already parses a whole
 * script before running it, so this brings browser_batch to the same standard.
 */
export async function validateBatch(actions, ctx) {
  if (!Array.isArray(actions) || !actions.length) {
    return new ToolError('batch_invalid', 'browser_batch needs a non-empty actions array. Nothing ran.', {
      effects: 'none',
    });
  }

  const checkedTabs = new Set();
  let createsTab = false;

  for (let i = 0; i < actions.length; i++) {
    const raw = actions[i] || {};
    const fail = (reason, hint) =>
      new ToolError('batch_invalid', 'Batch not run: ' + describeItem(i, raw) + ' ' + reason, {
        effects: 'none',
        hint: hint || 'Fix that item and send the batch again. Nothing ran.',
        details: { index: i, lineNo: raw.lineNo, name: raw.name },
      });

    const { name, input } = normalizeCall(raw.name, raw.input);
    if (!name || !TOOL_NAMES.includes(name)) {
      return fail('names no known tool.', 'Known tools: ' + TOOL_NAMES.join(', ') + '.');
    }
    if (input !== undefined && (typeof input !== 'object' || Array.isArray(input))) {
      return fail('has arguments that are not an object.');
    }
    if (name === 'tabs_create') createsTab = true;

    for (const key of REQUIRED_ARGS[name] || []) {
      if (input[key] === undefined || input[key] === null) {
        // A tabId can arrive from a tab created earlier in the same batch.
        if (key === 'tabId' && createsTab) continue;
        return fail('is missing ' + key + '.');
      }
    }
    if (name === 'computer' && !COMPUTER_ACTIONS.has(input.action)) {
      return fail(
        'asks for the unknown computer action ' + JSON.stringify(String(input.action)) + '.',
        'Actions: ' + [...COMPUTER_ACTIONS].join(', ') + '.'
      );
    }
    if (name === 'file_upload' && (!Array.isArray(input.paths) || !input.paths.length)) {
      return fail('needs a non-empty paths array.');
    }

    const tabId = input.tabId;
    if (tabId === undefined || tabId === null || tabId === '$last') continue;
    if (typeof tabId !== 'number') return fail('has a tabId that is not a number.');
    if (checkedTabs.has(tabId)) continue;
    try {
      await tabsLib.assertTabInSession(ctx.clientId, tabId);
      checkedTabs.add(tabId);
    } catch (err) {
      return fail('targets tab ' + tabId + ' which this session cannot drive. ' + String((err && err.message) || err));
    }
  }
  return null;
}

/**
 * Runs a sequence in one round trip. Stops at the first error so a batch cannot
 * keep acting on a page after a step failed to land.
 */
export async function runBatch(actions, ctx) {
  const invalid = await validateBatch(actions, ctx);
  if (invalid) throw invalid;

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

    // Which sites this profile is signed into, so a caller with several
    // profiles open can pick the one that already has the session it needs.
    // Names and presence only, never a cookie value.
    case 'sessions': {
      try {
        const result = message.url
          ? await sessions.sessionsFor(message.url)
          : { sessions: await sessions.listSessions(message.domains) };
        post({ type: 'sessions_response', id: message.id, result });
      } catch (err) {
        post({ type: 'sessions_response', id: message.id, error: serializeError(err) });
      }
      return;
    }

    case 'tool_request': {
      const { id, clientId, toolUseId } = message;
      // The host stamps callId on the envelope. It travels back on every
      // response, including a failure, so one line in the journal, one result
      // and one error all name the same call. An older host that sends no
      // callId falls back to the transport id.
      const callId = message.callId ?? id;
      const bornAt = generation;
      const { name: tool, input: args } = normalizeCall(message.tool, message.args);
      const ctx = { clientId: clientId || 'default', toolUseId, callId };
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
      cdp.beginCall();
      try {
        let result;
        if (tool === 'browser_batch') result = await runBatch(args.actions || [], ctx);
        else if (tool === 'quick') result = await runQuick(args, ctx);
        else if (tool === 'shortcuts_execute') result = await runShortcut(args, ctx);
        else result = await runTool(tool, args, ctx);
        result = applyNotes(result, cdp.endCall());
        const tab = await tabMeta(args && args.tabId !== undefined ? args.tabId : result && result.tabId);
        const failedStep = result && result.results && result.results.some((s) => !s.ok);
        await mark(failedStep ? 'error' : 'done');
        remember(tool, args, !failedStep, failedStep ? (result.results.find((s) => !s.ok) || {}).error : null, tab);
        respond({ type: 'tool_response', id, callId, result: { ...result, id: callId }, tab }, bornAt, tool);
      } catch (err) {
        const error = { ...serializeError(err), ...notesForError(cdp.endCall()) };
        const tab = await tabMeta(args && args.tabId);
        await mark('error');
        remember(tool, args, false, err, tab);
        respond({ type: 'tool_response', id, callId, error, tab }, bornAt, tool);
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
// The port ping is subject to the same background throttling it is meant to
// beat. An offscreen document is not: it is exempt from the 30s idle kill, and
// a message from it every 20s resets the worker's idle timer even while the
// browser is throttled or frozen.
let offscreenPending = null;

async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  if (offscreenPending) return offscreenPending;
  offscreenPending = (async () => {
    try {
      if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return true;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: 'Keeps the service worker alive so a queued tool call is answered without waiting for a restart.',
      });
      return true;
    } catch (err) {
      // Two creates can race after a restart, and the loser is told a document
      // already exists, which is the state we wanted.
      return /already/i.test(String((err && err.message) || err));
    } finally {
      offscreenPending = null;
    }
  })();
  return offscreenPending;
}

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!port) connect();
  ensureOffscreen();
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
  // Receiving it is the whole point: the message resets the idle timer.
  if (message.type === 'SW_KEEPALIVE') {
    if (!port) connect();
    return false;
  }
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
ensureOffscreen();
