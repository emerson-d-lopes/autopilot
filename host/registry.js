// Registry of connected browsers.
//
// Each browser running the extension gets its own native host, its own pipe,
// and one file here describing it. A single fixed pipe name meant the second
// browser lost the bind and was invisible, so Chrome and Edge could not both be
// driven. Discovery goes through this directory instead.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from './ipc.js';

/** Where the development launcher records the id of the browser it started. */
export const DEV_BROWSER_MARKER = join(dirname(fileURLToPath(import.meta.url)), '..', '.browsers', 'dev-browser-id');

export function devBrowserId() {
  try {
    return readFileSync(DEV_BROWSER_MARKER, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export const REGISTRY_DIR =
  process.env.CHROME_MCP_REGISTRY_DIR || join(tmpdir(), 'chrome-mcp-browsers');

function entryPath(browserId) {
  return join(REGISTRY_DIR, browserId.replace(/[^\w.-]/g, '_') + '.json');
}

export function writeEntry(entry) {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(entryPath(entry.id), JSON.stringify({ ...entry, updatedAt: Date.now() }, null, 2));
}

export function removeEntry(browserId) {
  try {
    unlinkSync(entryPath(browserId));
  } catch {
    /* already gone */
  }
}

function readAll() {
  if (!existsSync(REGISTRY_DIR)) return [];
  const entries = [];
  for (const file of readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(REGISTRY_DIR, file), 'utf8')));
    } catch {
      /* a half-written entry is skipped rather than fatal */
    }
  }
  return entries;
}

/**
 * Live browsers only. A crashed browser leaves its file behind, so each entry is
 * confirmed by probing its pipe, and dead ones are cleaned up on the way past.
 */
export async function listBrowsers() {
  const entries = readAll();
  const checked = await Promise.all(
    entries.map(async (entry) => ({ entry, alive: await probe(entry.socket, 400) }))
  );

  const live = [];
  for (const { entry, alive } of checked) {
    if (alive) live.push(entry);
    else removeEntry(entry.id);
  }
  live.sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));
  return live;
}

/** Chooses which browser a session should use when it has not picked one. */
export function pickDefault(browsers, preferredId) {
  if (preferredId) {
    const match = browsers.find((b) => b.id === preferredId);
    if (match) return match;
  }
  if (browsers.length === 1) return browsers[0];
  return null;
}

/**
 * Socket of a live browser, for callers that just need to know whether the
 * bridge is up. Honours the test override.
 *
 * With several browsers connected the order is: the one named by
 * CHROME_MCP_BROWSER_ID, then the development browser started by
 * npm run browser, then the earliest connected. Sorting by connection time
 * alone made the suite land on the user's own Chrome, which runs whatever
 * extension build was last reloaded there rather than the code on disk.
 */
export async function anyBridge() {
  if (process.env.CHROME_MCP_SOCKET) {
    return (await probe(process.env.CHROME_MCP_SOCKET, 600))
      ? { id: 'override', name: 'Browser', socket: process.env.CHROME_MCP_SOCKET }
      : null;
  }
  const browsers = await listBrowsers();
  for (const wanted of [process.env.CHROME_MCP_BROWSER_ID, devBrowserId()]) {
    const match = wanted && browsers.find((b) => b.id === wanted);
    if (match) return match;
  }
  return browsers[0] || null;
}
