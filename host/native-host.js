#!/usr/bin/env node
// Native messaging host. Chrome spawns this when the extension calls
// connectNative. It bridges the extension to any number of local MCP servers.
//
// stdout carries native messaging frames only. Every diagnostic goes to stderr,
// which Chrome writes to the browser's stderr, or to the log file below.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeMessaging } from './protocol.js';
import { socketPathFor, listen } from './ipc.js';
import { writeEntry, removeEntry } from './registry.js';
import { record as journal, makeEntry, pruneJournal, JOURNAL_DIR } from './journal.js';
import { ResponseQueue } from './response-queue.js';

const LOG_PATH = path.join(os.tmpdir(), 'chrome-mcp-host.log');
const PING_INTERVAL = 20000;
const REQUEST_TIMEOUT = 120000;

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ') + '\n';
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* logging must never take the host down */
  }
}

const chrome = new NativeMessaging(process.stdin, process.stdout);

/** @type {Set<import('./ipc.js').JsonSocket>} */
const clients = new Set();
/** @type {Map<string, {client: object, timer: NodeJS.Timeout}>} */
const pending = new Map();

let extensionReady = false;
let extensionTools = [];
let requestSeq = 0;
let browser = { id: 'default', name: 'Chrome', version: 'unknown' };
let extensionVersion = 'unknown';

/**
 * R11. Responses whose requesting socket closed before they arrived, replayed
 * on the next connection presenting the same session id.
 */
const parked = new ResponseQueue();

/**
 * The envelope generation. Every message sent to the extension carries it, and
 * the extension refuses to answer a request whose generation is behind its own,
 * which is what stops a slow tool from delivering into a session that has
 * already been replaced. The extension owns the number and reports it in
 * `hello`. A build that does not report one gets a locally incremented value.
 */
let generation = 0;

function noteDropped(dropped) {
  for (const entry of dropped) {
    log('parked response dropped:', entry.reason, 'session', entry.sessionId, 'tool', entry.tool || '?');
    journal(browser.id, makeEntry({
      request: { tool: entry.tool || 'unknown', args: {}, clientId: entry.sessionId },
      response: { error: { message: 'parked response dropped: ' + entry.reason, code: 'host_lost' } },
      startedAt: entry.parkedAt,
      finishedAt: Date.now(),
    }));
  }
}

// ---------------------------------------------------------------------------
// Extension side
// ---------------------------------------------------------------------------

chrome.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'hello':
      extensionReady = true;
      extensionTools = message.tools || [];
      extensionVersion = message.version || 'unknown';
      browser = message.browser || { id: 'default', name: 'Chrome', version: 'unknown' };
      // The extension bumps its own counter on every port disconnect. Taking
      // its number keeps both sides on one sequence. A build that does not send
      // one gets a locally incremented value so the field is always present.
      generation = Number.isFinite(message.generation) ? message.generation : generation + 1;
      log('extension connected:', browser.name, browser.version, 'id', browser.id, 'tools', extensionTools.length, 'generation', generation, 'journal', JOURNAL_DIR);
      // The pipe name depends on which browser this is, so listening only starts
      // once the extension has said who it is.
      startListening();
      pruneJournalOnce();
      broadcast({ type: 'browser_status', connected: true, tools: extensionTools, browser, extensionVersion, generation });
      return;

    case 'pong':
      return;

    case 'tool_response':
    case 'status':
    case 'released': {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (entry.request && message.type === 'tool_response') {
        journal(browser.id, makeEntry({ request: entry.request, response: message, startedAt: entry.startedAt, finishedAt: Date.now() }));
      }
      deliver(entry, message);
      return;
    }

    default:
      log('unhandled extension message', message.type);
  }
});

chrome.on('error', (err) => log('native messaging error:', err.message));
chrome.on('end', () => {
  log('extension disconnected');
  broadcast({ type: 'browser_status', connected: false });
  cleanup();
  process.exit(0);
});

// Traffic on the port resets the MV3 idle timer, so this ping is what keeps the
// service worker alive for the life of the connection.
setInterval(() => {
  try {
    chrome.send({ type: 'ping', id: 'keepalive' });
  } catch (err) {
    log('keepalive failed:', err.message);
  }
}, PING_INTERVAL);

// ---------------------------------------------------------------------------
// MCP server side
// ---------------------------------------------------------------------------

function broadcast(message) {
  for (const client of clients) {
    try {
      client.send(message);
    } catch {
      /* dropped below on close */
    }
  }
}

/**
 * Sends one response back to the socket that asked for it.
 *
 * A closed socket does not mean the work is gone. The response is parked under
 * the session id and replayed on the next connection presenting it, which is
 * what turns an MCP server restart mid-call into a late result instead of a
 * lost one.
 */
function deliver(entry, message) {
  const payload = { ...message, id: entry.outgoingId, generation };
  if (entry.socket && entry.socket.alive && entry.socket.send(payload)) return true;

  const { parked: stored, dropped } = parked.park(entry.clientId, payload, {
    tool: entry.request ? entry.request.tool : null,
  });
  noteDropped(dropped);
  if (stored) {
    log('parked', payload.type, 'for session', entry.clientId, 'queue', parked.size);
  } else {
    log('dropped', payload.type, 'with no session id to park it under');
  }
  return false;
}

/** Hands a reconnecting session anything that arrived while it was away. */
function replayFor(client, sessionId) {
  const { messages, dropped } = parked.takeFor(sessionId);
  noteDropped(dropped);
  for (const message of messages) {
    log('replaying parked', message.type, 'to session', sessionId);
    client.send({ ...message, replayed: true, generation });
  }
  return messages.length;
}

function onConnection(client) {
  clients.add(client);
  log('mcp client connected, total', clients.size);
  client.send({ type: 'browser_status', connected: extensionReady, tools: extensionTools, browser, extensionVersion, generation });

  // The session id only arrives with the first message, so a replay cannot
  // happen before then.
  let replayed = false;

  client.on('message', (message) => {
    if (!message || typeof message !== 'object') return;

    if (message.clientId && !replayed) {
      replayed = true;
      replayFor(client, message.clientId);
    }

    if (message.type === 'ping') {
      client.send({ type: 'pong', id: message.id });
      return;
    }

    if (!extensionReady) {
      client.send({
        type: 'tool_response',
        id: message.id,
        error: { message: 'Chrome extension is not connected.', kind: 'not_connected' },
      });
      return;
    }

    const id = 'req_' + ++requestSeq;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      const stale = pending.get(id);
      pending.delete(id);
      if (stale && stale.request) {
        journal(browser.id, makeEntry({
          request: stale.request,
          response: { error: { message: 'no response within ' + REQUEST_TIMEOUT / 1000 + 's' } },
          startedAt,
          finishedAt: Date.now(),
        }));
      }
      deliver(
        stale || { socket: client, outgoingId: message.id, clientId: message.clientId || null, request: null },
        {
          type: message.type === 'tool_request' ? 'tool_response' : message.type,
          error: { message: 'Browser did not respond within ' + REQUEST_TIMEOUT / 1000 + 's.', kind: 'timeout' },
        }
      );
    }, REQUEST_TIMEOUT);

    pending.set(id, {
      socket: client,
      outgoingId: message.id,
      clientId: message.clientId || null,
      timer,
      startedAt,
      request:
        message.type === 'tool_request'
          ? { tool: message.tool, args: message.args, clientId: message.clientId, callId: message.callId }
          : null,
    });

    try {
      // The generation rides on every envelope so the extension can refuse to
      // answer a request issued before its port was replaced.
      chrome.send({ ...message, id, generation });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      client.send({
        type: 'tool_response',
        id: message.id,
        error: { message: 'Failed to reach the browser: ' + err.message, kind: 'transport' },
      });
    }
  });

  client.on('close', () => {
    clients.delete(client);
    log('mcp client disconnected, remaining', clients.size);
  });
  client.on('error', (err) => log('mcp client error:', err.message));
}

let pruned = false;

/** F3. Deletes journal files past the retention window, once per host process. */
function pruneJournalOnce() {
  if (pruned) return;
  pruned = true;
  try {
    const { removed, days } = pruneJournal();
    log('journal retention', days, 'days,', removed.length, 'file(s) removed');
  } catch (err) {
    log('journal prune failed:', err.message);
  }
}

// A parked response that nobody comes back for has to leave the queue on its
// own, otherwise it expires only when the next call happens to arrive.
const sweep = setInterval(() => noteDropped(parked.prune()), 30000);
if (typeof sweep.unref === 'function') sweep.unref();

let listening = false;

function startListening() {
  if (listening) return;
  listening = true;

  const socket = socketPathFor(browser.id);
  listen(socket, onConnection)
    .then(() => {
      log('listening on', socket);
      // Recorded so any MCP server can discover this browser without knowing
      // the naming scheme.
      writeEntry({
        id: browser.id,
        name: browser.name,
        version: browser.version,
        socket,
        pid: process.pid,
        connectedAt: Date.now(),
      });
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        // Another host already serves this browser. Two ports fighting over one
        // browser helps nobody, so this one steps aside.
        log('socket already in use for', browser.id, '; exiting');
        process.exit(0);
      }
      log('failed to listen:', err.message);
      process.exit(1);
    });
}

function cleanup() {
  if (browser && browser.id) removeEntry(browser.id);
}

process.on('exit', cleanup);
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

// With an explicit socket the path does not depend on which browser this is, so
// listening can start at once. That keeps "host up, extension not attached" a
// state a client can see and report, which is what the tests exercise.
if (process.env.CHROME_MCP_SOCKET) {
  startListening();
  pruneJournalOnce();
}

process.on('uncaughtException', (err) => {
  log('uncaught:', err.stack || err.message);
});
