#!/usr/bin/env node
// MCP server. Claude Code spawns this; it connects to the native host over a
// local pipe and forwards tool calls to the browser.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { connect } from './ipc.js';
import {
  listBrowsers,
  pickDefault,
  selectBrowser,
  parseSelectorString,
  describeBrowser,
  isLocal,
  isDev,
  devBrowserId,
} from './registry.js';
import { SESSION_DOMAINS, registrableDomain } from '../extension/src/lib/sessions.js';
import { TOOLS, TOOL_NAMES, missingRequired } from './schemas.js';
import { textBlock, formatResult } from './format.js';
import { materializeImage, lastSavedImage, prepareUploadPaths, capturedImageIds } from './images.js';
import {
  shouldEscalateToModel,
  capTreeForModel,
  parseModelFindResponse,
  validateModelMatches,
  MODEL_TREE_CHAR_CAP,
} from '../extension/src/lib/find.js';
import { normalizeCall } from '../extension/src/lib/aliases.js';
import {
  toError,
  fromThrown,
  wrapResult,
  retryDecision,
  newCallId,
  contractLine,
  formatError,
  ToolFailure,
} from './errors.js';
import { applyCaps } from './redact.js';
import { envVar } from './env.js';

const CLIENT_ID = envVar('CLIENT_ID') || randomUUID();

let link = null;
let browserConnected = false;
let connecting = null;
let requestSeq = 0;
const pending = new Map();

/** The browser this session drives. Chosen on first use, changeable at any time. */
let selectedBrowser = envVar('BROWSER_ID') || null;
let activeBrowser = null;

/**
 * A default asked for at startup, by AUTOPILOT_BROWSER or --browser.
 *
 * It cannot be resolved here because no browser may be connected yet, so it is
 * held until the first call that needs a browser and resolved against the live
 * list then.
 */
function startupSelector() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) return parseSelectorString(argv[i + 1]);
    if (argv[i].startsWith('--browser=')) return parseSelectorString(argv[i].slice('--browser='.length));
  }
  const wanted = envVar('BROWSER');
  if (wanted) return parseSelectorString(wanted);
  return null;
}

let pendingSelector = startupSelector();

// ---------------------------------------------------------------------------
// Which sites each connected profile is signed into
// ---------------------------------------------------------------------------

const SESSION_TTL = 15000;
const sessionsCache = new Map();

/**
 * Asks one browser about its sessions.
 *
 * A short-lived connection rather than the session's own link, because this has
 * to work for every connected browser, including ones this session is not
 * driving. Never returns cookie values, only names and presence.
 */
function askSessions(entry, payload, timeout = 3000) {
  const id = 'sessions_' + ++requestSeq;
  return new Promise((resolve) => {
    let done = false;
    let close = () => {};
    const finish = (value) => {
      if (done) return;
      done = true;
      close();
      resolve(value);
    };
    connect(entry.socket).then(
      (socket) => {
        const timer = setTimeout(() => finish(null), timeout);
        close = () => {
          clearTimeout(timer);
          try {
            socket.end();
          } catch {
            /* already closed */
          }
        };
        socket.on('message', (message) => {
          if (message.id !== id) return;
          // An extension too old to know the request, or one whose worker is
          // not attached, answers with an error rather than a result.
          finish(message.error || message.type !== 'sessions_response' ? null : message.result || null);
        });
        socket.on('close', () => finish(null));
        socket.on('error', () => finish(null));
        try {
          socket.send({ ...payload, type: 'sessions', id, clientId: CLIENT_ID });
        } catch {
          finish(null);
        }
      },
      () => finish(null)
    );
  });
}

/** The table domains one browser holds a session for, cached briefly. */
async function fetchSessions(entry) {
  const cached = sessionsCache.get(entry.id);
  if (cached && Date.now() - cached.at < SESSION_TTL) return cached.sessions;

  const result = await askSessions(entry, {});
  const sessions = result && Array.isArray(result.sessions) ? result.sessions : null;
  if (sessions) sessionsCache.set(entry.id, { at: Date.now(), sessions });
  return sessions;
}

/** The heuristic answer for a site the table does not cover. */
function fetchSessionFor(entry, url) {
  return askSessions(entry, { url });
}

/**
 * The connected browsers with their `sessions` filled in, asked in parallel.
 *
 * A site outside the known table gets one extra question per browser, whose
 * answer is a heuristic on cookie shape. It is folded into the same list so
 * selection works the same way for a site the table has never heard of.
 */
async function withSessions(browsers, alsoAsk) {
  const domain = alsoAsk && registrableDomain(alsoAsk);
  const heuristic = domain && !SESSION_DOMAINS.includes(domain) ? domain : null;

  return Promise.all(
    browsers.map(async (entry) => {
      const reported = await fetchSessions(entry);
      // A copy, because the cached array must not grow a heuristic answer.
      const sessions = [...(reported || [])];
      if (heuristic) {
        const answer = await fetchSessionFor(entry, heuristic);
        if (answer && answer.likely) sessions.push(answer.domain || heuristic);
      }
      // An extension that never answered is a different fact from a profile
      // signed into nothing, and the listing has to say which one it saw.
      return { ...entry, sessions, sessionsReported: reported !== null };
    })
  );
}

/** True when a selector needs live session state to be decided. */
function needsSessions(selector) {
  if (!selector) return false;
  return Boolean(selector.site) || Boolean(selector.any && String(selector.any).includes('.'));
}

/** The one browser a selector names, asking for session state only when the selector needs it. */
async function resolveSelector(selector) {
  const wanted = typeof selector === 'string' ? parseSelectorString(selector) : selector;
  let browsers = await listBrowsers();
  if (!browsers.length) throw new ToolFailure('browser_unknown', 'No browsers are connected.');
  if (needsSessions(wanted)) browsers = await withSessions(browsers, wanted.site || wanted.any);
  return selectBrowser(browsers, wanted);
}

/**
 * Finds the browser to talk to.
 *
 * With one connected browser there is nothing to choose. With several, the
 * session has to say which, because silently picking one would mean acting in a
 * window the caller was not thinking about.
 */
async function resolveBrowser() {
  // An explicit socket override means a single fixed bridge, used by tests.
  const socketOverride = envVar('SOCKET');
  if (socketOverride) {
    return { id: 'override', name: 'Browser', socket: socketOverride };
  }

  if (!selectedBrowser && pendingSelector) {
    const chosen = await resolveSelector(pendingSelector);
    selectedBrowser = chosen.id;
    pendingSelector = null;
    return chosen;
  }

  const browsers = await listBrowsers();
  if (!browsers.length) return null;

  const chosen = pickDefault(browsers, selectedBrowser);
  if (chosen) return chosen;

  const names = browsers.map((b) => '  ' + b.id + '  ' + describeBrowser(b)).join('\n');
  throw new Error(
    browsers.length +
      ' browsers are connected, so this session needs to pick one:\n' +
      names +
      '\n\nCall select_browser with one of those ids, or with {profile}, {account} or {site}.'
  );
}

// ---------------------------------------------------------------------------
// Link to the native host
// ---------------------------------------------------------------------------

async function ensureLink() {
  if (link) return link;
  if (connecting) return connecting;

  const target = await resolveBrowser();
  if (!target) throw new Error('no browser');
  activeBrowser = target;

  connecting = connect(target.socket)
    .then((socket) => {
      link = socket;
      connecting = null;

      socket.on('message', (message) => {
        if (link !== socket) return;
        if (message.type === 'browser_status') {
          browserConnected = Boolean(message.connected);
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(message.error);
        else entry.resolve(message.result !== undefined ? message.result : message);
      });

      socket.on('close', () => {
        // A replaced socket must not clear the state of the one that replaced
        // it, which is what happened when switching browsers dropped the old
        // link and the late close event then wiped the new connection.
        if (link !== socket) return;
        link = null;
        browserConnected = false;
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject({ message: 'Connection to the browser bridge closed.', kind: 'disconnected' });
          pending.delete(id);
        }
      });

      socket.on('error', () => {
        /* surfaced through close */
      });

      return socket;
    })
    .catch((err) => {
      connecting = null;
      throw err;
    });

  return connecting;
}

const NOT_RUNNING =
  'The Autopilot bridge is not running.\n\n' +
  'Checklist:\n' +
  '  1. Chrome is running.\n' +
  '  2. The extension is installed and enabled at chrome://extensions.\n' +
  '  3. The native messaging host is registered (npm run install-host).\n' +
  '  4. Chrome was restarted after registering the host.\n\n' +
  'Run `npm run doctor` in the autopilot directory to check all four.';

/**
 * One call against a browser this session is not driving.
 *
 * The `browser` argument on a page tool routes a single call without changing
 * the session default, so a session can read one profile and keep writing in
 * another. It opens its own connection and closes it, which keeps the session's
 * own link and its browser_status state untouched.
 */
function callOnBrowser(target, type, payload, timeout = 120000, callId = null) {
  const id = 'mcp_route_' + ++requestSeq;
  return new Promise((resolve, reject) => {
    connect(target.socket).then((socket) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.end();
        } catch {
          /* already closed */
        }
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(describeBrowser(target) + ' did not respond within ' + timeout / 1000 + 's.')),
        timeout
      );
      socket.on('message', (message) => {
        if (message.type === 'browser_status' || message.id !== id) return;
        if (message.error) finish(reject, message.error);
        else finish(resolve, message.result !== undefined ? message.result : message);
      });
      socket.on('close', () => finish(reject, new Error('Connection to ' + target.id + ' closed.')));
      socket.on('error', (err) => finish(reject, err));
      try {
        socket.send({ ...payload, type, id, clientId: CLIENT_ID, callId });
      } catch (err) {
        finish(reject, err);
      }
    }, reject);
  });
}

async function callBridge(type, payload, timeout = 120000, callId = null) {
  try {
    await ensureLink();
  } catch (err) {
    // A selection problem is actionable and must not be reported as a missing
    // bridge, which would send the caller to the wrong fix.
    if (err instanceof ToolFailure) throw err;
    if (err && /needs to pick one/.test(err.message || '')) throw err;
    throw new Error(NOT_RUNNING, { cause: err });
  }
  // The status message arrives just after the socket opens, so a call made
  // immediately after connecting (a fresh session, or a reconnect after
  // switching browsers) has to wait for it rather than assume it is late.
  if (!browserConnected) {
    const deadline = Date.now() + 3000;
    while (!browserConnected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!browserConnected) {
      throw new Error(
        'The extension is not attached to the bridge. Check it is enabled at chrome://extensions, then reload it.'
      );
    }
  }

  const id = 'mcp_' + ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser did not respond within ' + timeout / 1000 + 's.'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    // callId is the correlation id. It travels with the request so the
    // extension, the journal and the result all name the same call.
    link.send({ ...payload, type, id, clientId: CLIENT_ID, callId });
  });
}

// ---------------------------------------------------------------------------
// C4. Retry by side effect
// ---------------------------------------------------------------------------

/**
 * Calls the bridge, and repeats the call only where the contract says a repeat
 * cannot cause a second write. The decision is in host/errors.js so npm run
 * doctor prints the same table this obeys.
 */
async function callWithRetry(tool, args, callId, route = null) {
  let attempt = 0;
  const notes = [];

  for (;;) {
    attempt += 1;
    try {
      // A `browser` argument routes this one call through its own connection.
      // Retries and the contract marshalling are the same either way.
      const result = route
        ? await callOnBrowser(await resolveSelector(route), 'tool_request', { tool, args }, 120000, callId)
        : await callBridge('tool_request', { tool, args }, 120000, callId);
      return { result, attempt, notes };
    } catch (thrown) {
      const error = fromThrown(thrown, { tool, id: callId });
      const decision = retryDecision({ tool, args, error, attempt });
      if (!decision.retry) {
        error.attempts = attempt;
        if (notes.length) error.retries = notes;
        throw error;
      }
      notes.push('attempt ' + attempt + ' failed with ' + error.code + ', retrying (' + decision.reason + ')');
      await new Promise((r) => setTimeout(r, decision.delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// P6. find's model escalation through MCP sampling
//
// Local scoring runs first and stays in the result unless the model call
// actually produces something. The tree is read separately from find's own
// local pass (find.js scores against a tree the extension already read) so
// this can ask for the exact scope find used, uncapped, and cap it here
// where the 60000-char ceiling is enforced regardless of how big the page is.
// ---------------------------------------------------------------------------

/**
 * The MCP sampling escalation for one `find` call. Never throws: any failure
 * along the way (no sampling capability, the tree read failing, the model
 * call erroring, an empty or all-hallucinated answer) resolves to
 * `{escalated: false, warning}` and the caller keeps the local result, per P6.
 */
async function runFindEscalation({ query, tabId, scope, route, findResult, semantic }) {
  const because = shouldEscalateToModel({ matches: findResult.matches, semantic });
  if (!because) return { escalated: false };

  const clientCaps = server.getClientCapabilities ? server.getClientCapabilities() : null;
  if (!clientCaps || !clientCaps.sampling) {
    return {
      escalated: false,
      warning: 'would have escalated to a model call (' + because + '), but this client does not support MCP sampling',
    };
  }

  let treeText = '';
  try {
    const treeCall = await callWithRetry(
      'read_page',
      { tabId, filter: scope === 'all' ? 'all' : 'interactive', max_chars: 200000 },
      newCallId(),
      route
    );
    treeText = (treeCall.result && treeCall.result.text) || '';
  } catch (err) {
    return { escalated: false, warning: 'could not read the tree for the model call: ' + (err && err.message) };
  }

  const capped = capTreeForModel(treeText, MODEL_TREE_CHAR_CAP);

  const prompt =
    'You are helping find elements on a web page. The user wants to find: "' +
    query +
    '"\n\n' +
    'Here is the accessibility tree of the page:\n' +
    capped.text +
    '\n\n' +
    "Find ALL elements that match the user's query. Return up to 20 most relevant matches, ordered by relevance.\n\n" +
    'Return your findings in this exact format (one line per matching element):\n\n' +
    'FOUND: <total_number_of_matching_elements>\nSHOWING: <number_shown_up_to_20>\n---\n' +
    'ref_X | role | name | type | reason why this matches';

  let response;
  try {
    response = await server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens: 800,
    });
  } catch (err) {
    return {
      escalated: false,
      warning: 'the model call failed (' + (err && err.message) + '); returning the local result',
    };
  }

  const text = response && response.content && response.content.type === 'text' ? response.content.text : '';
  const parsed = parseModelFindResponse(text);
  const { valid, hallucinated } = validateModelMatches(parsed, capped.text);

  if (!valid.length) {
    return { escalated: false, warning: 'the model call returned no valid refs; returning the local result' };
  }

  const matches = valid.map((m) => ({
    ref: m.ref,
    role: m.role || '',
    name: m.name || '',
    attrs: m.type ? 'type=' + m.type : undefined,
    reason: m.reason,
    source: 'model',
  }));

  const warnings = [];
  if (hallucinated.length) {
    warnings.push('the model named ' + hallucinated.length + ' ref(s) not present in the tree; they were dropped');
  }
  if (capped.capped) {
    warnings.push(
      'the tree sent to the model was capped at ' +
        MODEL_TREE_CHAR_CAP +
        ' chars' +
        (capped.droppedOffscreen ? ' (' + capped.droppedOffscreen + ' offscreen line(s) dropped first)' : '')
    );
  }

  return { escalated: true, because, matches, warnings };
}

/** Drops the current connection so the next call reconnects to the chosen browser. */
function dropLink() {
  if (link) {
    try {
      link.end();
    } catch {
      /* already closed */
    }
  }
  link = null;
  connecting = null;
  browserConnected = false;
  activeBrowser = null;
}

/** How this session stands towards one browser, for the listing. */
function selectionMark(entry) {
  if (activeBrowser && activeBrowser.id === entry.id) return '  (in use)';
  if (selectedBrowser === entry.id) return '  (selected)';
  return '';
}

/** The full listing for one browser: who it is, whose account, and what it is signed into. */
function browserReport(entry, devId) {
  const profile = entry.profile || {};
  const account = entry.account || {};
  const email = account.email || profile.userName || '';

  const head = entry.id + (entry.label ? '  ' + entry.label : '') + selectionMark(entry);
  const lines = [head];
  lines.push(
    '  browser: ' + entry.name + ' ' + entry.version + '  local: ' + isLocal(entry) + '  dev: ' + isDev(entry, devId)
  );
  lines.push(
    '  profile: ' +
      (profile.directory || 'unknown') +
      (profile.name ? ' "' + profile.name + '"' : '') +
      '  account: ' +
      (email || 'not signed in')
  );
  if (profile.reason) lines.push('  profile detail missing: ' + profile.reason);
  lines.push(
    '  sessions: ' +
      (!entry.sessionsReported
        ? 'not reported (reload the extension so it picks up the cookies permission)'
        : entry.sessions.length
          ? entry.sessions.join(', ')
          : 'none detected')
  );
  return lines.join('\n');
}

/**
 * tabs_context across every connected browser, one section each.
 *
 * A session with two profiles open has two sets of tab ids, and a tab id alone
 * does not say which browser it belongs to. The header on each section is what
 * a caller passes as `browser` on the next call.
 */
async function groupedTabsContext(browsers, args) {
  const sections = await Promise.all(
    browsers.map(async (entry) => {
      let body;
      try {
        const result = await callOnBrowser(entry, 'tool_request', { tool: 'tabs_context', args }, 20000);
        body = JSON.stringify(result, null, 2);
      } catch (err) {
        body = 'unavailable: ' + ((err && err.message) || String(err));
      }
      return 'browser ' + entry.id + '  ' + describeBrowser(entry) + selectionMark(entry) + '\n' + body;
    })
  );
  return [
    textBlock(
      sections.join('\n\n') +
        '\n\nTab ids are per browser. Pass browser: "<id>" on a call to act in one of them without switching.'
    ),
  ];
}

/** Tools answered by the server itself, because they are about which browser to use. */
async function handleBrowserTool(name, args) {
  const devId = devBrowserId();

  if (name === 'list_connected_browsers') {
    const browsers = await listBrowsers();
    if (!browsers.length) {
      return [
        textBlock(
          'No browsers are connected. Start one with the extension loaded, then run npm run doctor if it does not appear.'
        ),
      ];
    }
    const enriched = await withSessions(browsers);
    return [
      textBlock(
        enriched.length +
          ' connected:\n' +
          enriched.map((b) => browserReport(b, devId)).join('\n\n') +
          '\n\nselect_browser takes any of browserId, label, profile, account or site.'
      ),
    ];
  }

  // select_browser and switch_browser are the same operation.
  const selector = {};
  for (const key of ['browserId', 'id', 'label', 'profile', 'account', 'site']) {
    if (args[key] !== undefined && String(args[key]).trim())
      selector[key === 'id' ? 'browserId' : key] = String(args[key]).trim();
  }
  if (!Object.keys(selector).length) {
    return [
      textBlock('Pass one of browserId, label, profile, account or site. Call list_connected_browsers to see them.'),
    ];
  }

  const match = await resolveSelector(selector);
  selectedBrowser = match.id;
  dropLink();
  return [textBlock('Now using ' + describeBrowser(match) + ' (' + match.id + ').')];
}

// ---------------------------------------------------------------------------
// C1. The contract, written into the reply
// ---------------------------------------------------------------------------

/**
 * Tools whose reply is a rendered summary rather than the JSON body.
 *
 * Everything else falls through to JSON.stringify of the whole result, which
 * already carries ok, effects, evidence, warnings and id, so a second copy in
 * prose would only cost tokens.
 */
const PROSE_RESULTS = new Set([
  'read_page',
  'get_page_text',
  'find',
  'read_console_messages',
  'read_network_requests',
  'gif_creator',
  'browser_batch',
  'quick',
  'shortcuts_execute',
]);

/** True when the contract fields need a line of their own. */
function needsContractLine(toolName, result) {
  return PROSE_RESULTS.has(toolName) || Boolean(result && result.image);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server({ name: 'autopilot', version: '0.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const normalized = normalizeCall(request.params.name, request.params.arguments || {});
  let name = normalized.name;
  let args = normalized.input;
  if (name === 'browser_batch' && Array.isArray(args.actions)) {
    args = { ...args, actions: args.actions.map((a) => (a && a.name ? normalizeCall(a.name, a.input) : a)) };
  }

  const callId = newCallId();

  if (!TOOL_NAMES.includes(name)) {
    return {
      content: [textBlock(formatError(toError('bad_request', { message: 'Unknown tool: ' + name, id: callId })))],
      isError: true,
    };
  }

  // An argument the tool cannot run without is refused here, before a browser
  // is chosen or a connection opened. The schema already declared the list.
  const missing = missingRequired(name, args);
  if (missing.length) {
    return {
      content: [
        textBlock(
          formatError(
            toError('bad_request', {
              message:
                name +
                ' needs ' +
                missing.join(' and ') +
                '. The call was refused here, so nothing was sent to the browser.',
              hint: 'Add ' + missing.join(' and ') + ' and call again.',
              details: { tool: name, missing },
              id: callId,
            })
          )
        ),
      ],
      isError: true,
    };
  }

  // A `browser` argument routes this one call and leaves the session default
  // alone, so reading another profile does not cost a switch and a switch back.
  let route = null;
  const isBrowserTool = name === 'list_connected_browsers' || name === 'select_browser' || name === 'switch_browser';
  if (!isBrowserTool && args && args.browser !== undefined && args.browser !== null && String(args.browser).trim()) {
    route = String(args.browser).trim();
    args = { ...args };
    delete args.browser;
  }

  try {
    if (isBrowserTool) {
      const content = await handleBrowserTool(name, args);
      const wrapped = wrapResult({ effects: 'none' }, { tool: name, args, id: callId });
      return { content: [...content, textBlock(contractLine(wrapped))] };
    }
    if (name === 'tabs_context' && !route && !args.createIfEmpty) {
      // With several browsers connected the listing says which browser each
      // group of tabs is in, and works without the session having chosen one.
      // createIfEmpty is excluded because it would open a tab in every browser.
      const connected = await listBrowsers();
      if (connected.length > 1) return { content: await groupedTabsContext(connected, args) };
    }
    if (name === 'file_upload' && Array.isArray(args.paths)) {
      args = { ...args, paths: prepareUploadPaths(args.paths) };
    }
    if (name === 'upload_image') {
      // An image upload is a file upload with a friendlier way to name the file.
      let path = args.path;
      if (args.imageId) {
        path = materializeImage(String(args.imageId), args.filename);
        if (!path) {
          return {
            content: [
              textBlock(
                'No screenshot with id ' +
                  args.imageId +
                  ' in this session. Ids are printed under each screenshot. Known: ' +
                  (capturedImageIds().join(', ') || 'none') +
                  '.'
              ),
            ],
            isError: true,
          };
        }
      } else if (path === 'last' || !path) {
        const lastId = capturedImageIds().pop();
        path = lastSavedImage() || (lastId ? materializeImage(lastId, args.filename) : null);
      }
      if (!path) {
        return {
          content: [textBlock('No screenshot has been taken yet. Take one, then pass its imageId, or give a path.')],
          isError: true,
        };
      }
      args = { ...args, paths: prepareUploadPaths([path]) };
      delete args.path;
      delete args.imageId;
      delete args.filename;
      name = 'file_upload';
    }
    const call = await callWithRetry(name, args, callId, route);

    // P6: local ranking already ran inside the extension call above. Only
    // when it came back weak, or the caller asked for semantic: true, does
    // this reach for a model call, and only when the client actually offers
    // MCP sampling.
    if (name === 'find' && call.result && Array.isArray(call.result.matches)) {
      const escalation = await runFindEscalation({
        query: args.query,
        tabId: args.tabId,
        scope: call.result.scope,
        route,
        findResult: call.result,
        semantic: Boolean(args.semantic),
      });
      if (escalation.escalated) {
        call.result = {
          ...call.result,
          matches: escalation.matches,
          localMatches: call.result.matches,
          escalatedBecause: escalation.because,
        };
        call.notes.push(...escalation.warnings);
      } else if (escalation.warning) {
        call.notes.push(escalation.warning);
      }
    }

    // S5, S6 and F2 run here, on the read path, so capture in the extension
    // stays passive and every tool gets the same treatment whatever build the
    // browser is on.
    const capped = applyCaps(name, call.result);
    const warnings = [...capped.warnings];
    if (call.notes.length) warnings.push(...call.notes);

    const wrapped = wrapResult(capped.result, { tool: name, args, id: callId, warnings });
    const content = formatResult(name, wrapped, args);
    if (needsContractLine(name, wrapped)) content.push(textBlock(contractLine(wrapped)));
    return { content };
  } catch (err) {
    // A failure that already carries a catalogue code keeps its own fields
    // rather than being re-classified from its message. That covers a browser
    // selection failure and anything the extension raised as a ToolError.
    const error = err instanceof ToolFailure ? { ...err.toJSON(), id: callId } : null;
    const body = error || (err && err.code && err.hint ? err : fromThrown(err, { tool: name, id: callId }));
    if (!body.id) body.id = callId;
    return { content: [textBlock(formatError(body))], isError: true };
  }
});

process.on('SIGINT', async () => {
  try {
    if (link) link.send({ type: 'release_session', clientId: CLIENT_ID, closeEmptyOnly: true, id: 'bye' });
  } catch {
    /* shutting down */
  }
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
