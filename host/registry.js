// Registry of connected browsers.
//
// Each browser running the extension gets its own native host, its own pipe,
// and one file here describing it. A single fixed pipe name meant the second
// browser lost the bind and was invisible, so Chrome and Edge could not both be
// driven. Discovery goes through this directory instead.

import { writeFileSync, readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from './ipc.js';
import { ToolFailure } from './errors.js';
import { envVar } from './env.js';
import { statePath, ensureDir, legacyTempPath } from './paths.js';
import { registrableDomain } from '../extension/src/lib/sessions.js';

/** Where the development launcher records the id of the browser it started. */
export const DEV_BROWSER_MARKER = join(dirname(fileURLToPath(import.meta.url)), '..', '.browsers', 'dev-browser-id');

export function devBrowserId() {
  try {
    return readFileSync(DEV_BROWSER_MARKER, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export const REGISTRY_DIR = envVar('REGISTRY_DIR') || statePath('browsers');

/**
 * Where entries were written before 0.2.3. A host that Chrome started before
 * the upgrade still writes there, so it is read until the browser restarts.
 * Nothing is written to it, and it is ignored when the registry is overridden.
 */
export const LEGACY_REGISTRY_DIR = envVar('REGISTRY_DIR') ? null : legacyTempPath('browsers');

function entryPath(browserId) {
  return join(REGISTRY_DIR, browserId.replace(/[^\w.-]/g, '_') + '.json');
}

export function writeEntry(entry) {
  ensureDir(REGISTRY_DIR);
  writeFileSync(entryPath(entry.id), JSON.stringify({ ...entry, updatedAt: Date.now() }, null, 2));
}

export function removeEntry(browserId) {
  for (const dir of [REGISTRY_DIR, LEGACY_REGISTRY_DIR]) {
    if (!dir) continue;
    try {
      unlinkSync(join(dir, browserId.replace(/[^\w.-]/g, '_') + '.json'));
    } catch {
      /* already gone */
    }
  }
}

function readAll() {
  const entries = [];
  const seen = new Set();
  for (const dir of [REGISTRY_DIR, LEGACY_REGISTRY_DIR]) {
    if (!dir || !existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        // The same browser can appear in both places across an upgrade. The
        // current directory wins, since it is read first.
        if (entry && entry.id && !seen.has(entry.id)) {
          seen.add(entry.id);
          entries.push(entry);
        }
      } catch {
        /* a half-written entry is skipped rather than fatal */
      }
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
  const checked = await Promise.all(entries.map(async (entry) => ({ entry, alive: await probe(entry.socket, 400) })));

  const live = [];
  for (const { entry, alive } of checked) {
    if (alive) live.push(entry);
    else removeEntry(entry.id);
  }
  live.sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));
  return live;
}

// ---------------------------------------------------------------------------
// Choosing among several connected browsers
// ---------------------------------------------------------------------------

const lower = (value) =>
  String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();

/** Registry entries carry a host name, so a shared registry directory stays readable. */
export function isLocal(entry) {
  return !entry.host || entry.host === hostname();
}

/** The Chrome for Testing browser started by npm run browser, which is not a user profile. */
export function isDev(entry, devId = devBrowserId()) {
  return Boolean(devId && entry.id === devId);
}

/** Every string that names this browser, for a selector that did not say which field it meant. */
function identityStrings(entry) {
  const profile = entry.profile || {};
  const account = entry.account || {};
  return [
    entry.id,
    entry.name,
    entry.label,
    profile.directory,
    profile.name,
    profile.gaiaName,
    profile.userName,
    account.email,
  ]
    .filter(Boolean)
    .map(lower);
}

/**
 * Does one browser satisfy one selector.
 *
 * Every key present has to match, so {profile: "Work", account: "a@b.com"}
 * needs both. `site` is the only key that consults live session state, which
 * the caller has to have filled in on the entry first.
 */
export function matchesSelector(entry, selector, { devId = devBrowserId() } = {}) {
  const profile = entry.profile || {};
  const account = entry.account || {};
  let matched = false;

  const wantedId = lower(selector.browserId || selector.id);
  if (wantedId) {
    if (lower(entry.id) !== wantedId && lower(entry.name) !== wantedId) return false;
    matched = true;
  }
  if (selector.label) {
    if (lower(entry.label) !== lower(selector.label)) return false;
    matched = true;
  }
  if (selector.profile) {
    const wanted = lower(selector.profile);
    if (lower(profile.directory) !== wanted && lower(profile.name) !== wanted) return false;
    matched = true;
  }
  if (selector.account) {
    const wanted = lower(selector.account);
    if (lower(account.email) !== wanted && lower(profile.userName) !== wanted) return false;
    matched = true;
  }
  if (selector.site) {
    // The development browser signs into nothing a user cares about, and it is
    // never the answer to "which profile has my LinkedIn session". It stays
    // reachable by id.
    if (isDev(entry, devId)) return false;
    const domain = registrableDomain(selector.site) || lower(selector.site);
    const sessions = (entry.sessions || []).map(lower);
    if (!sessions.includes(domain)) return false;
    matched = true;
  }
  if (selector.any) {
    if (!identityStrings(entry).includes(lower(selector.any))) return false;
    matched = true;
  }
  return matched;
}

/**
 * Turns an AUTOPILOT_BROWSER value or a --browser argument into a selector.
 *
 * "site=linkedin.com" and "site:linkedin.com" name the field. A bare value is
 * tried against every identity field, and falls back to a site match when it
 * looks like a domain and nothing else matched.
 */
export function parseSelectorString(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(browserId|id|label|profile|account|site)\s*[=:]\s*(.+)$/i);
  if (match) {
    const key = match[1].toLowerCase() === 'browserid' ? 'browserId' : match[1].toLowerCase();
    return { [key]: match[2].trim() };
  }
  return { any: raw };
}

/**
 * The one browser a selector names.
 *
 * Two candidates is an error rather than a guess: acting in the wrong signed-in
 * profile is not something the caller can undo by reading the result.
 *
 * @throws {ToolFailure} browser_unknown or profile_ambiguous
 */
export function selectBrowser(browsers, selector, { devId = devBrowserId() } = {}) {
  const wanted = typeof selector === 'string' ? parseSelectorString(selector) : selector;
  if (!wanted || !Object.keys(wanted).length) {
    throw new ToolFailure(
      'browser_unknown',
      'No browser selector was given. Pass browserId, label, profile, account or site.'
    );
  }

  let matches = browsers.filter((b) => matchesSelector(b, wanted, { devId }));

  // A bare value that named no identity field can still be a domain, which is
  // the shape a caller reaches for first ("the one signed into linkedin.com").
  if (!matches.length && wanted.any && wanted.any.includes('.')) {
    matches = browsers.filter((b) => matchesSelector(b, { site: wanted.any }, { devId }));
  }

  if (matches.length === 1) return matches[0];

  const shown = describeSelector(wanted);
  if (!matches.length) {
    throw new ToolFailure(
      'browser_unknown',
      'No connected browser matches ' +
        shown +
        '. Connected: ' +
        (browsers.map((b) => b.id + ' (' + describeBrowser(b) + ')').join(', ') || 'none') +
        '.'
    );
  }
  throw new ToolFailure(
    'profile_ambiguous',
    matches.length +
      ' connected browsers match ' +
      shown +
      ': ' +
      matches.map((b) => b.id + ' (' + describeBrowser(b) + ')').join(', ') +
      '. Pass browserId to say which.',
    { effects: 'none' }
  );
}

function describeSelector(selector) {
  return Object.entries(selector)
    .map(([key, value]) => (key === 'any' ? JSON.stringify(String(value)) : key + '=' + JSON.stringify(String(value))))
    .join(' ');
}

/** Short name for one browser, for error text and listings. */
export function describeBrowser(entry) {
  const profile = entry.profile || {};
  const account = entry.account || {};
  const parts = [entry.label || null, entry.name + ' ' + entry.version];
  if (profile.directory) parts.push('profile ' + profile.directory + (profile.name ? ' "' + profile.name + '"' : ''));
  if (account.email || profile.userName) parts.push(account.email || profile.userName);
  return parts.filter(Boolean).join(', ');
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
 * AUTOPILOT_BROWSER_ID, then the development browser started by
 * npm run browser, then the earliest connected. Sorting by connection time
 * alone made the suite land on the user's own Chrome, which runs whatever
 * extension build was last reloaded there rather than the code on disk.
 */
export async function anyBridge() {
  const override = envVar('SOCKET');
  if (override) {
    return (await probe(override, 600)) ? { id: 'override', name: 'Browser', socket: override } : null;
  }
  const browsers = await listBrowsers();
  for (const wanted of [envVar('BROWSER_ID'), devBrowserId()]) {
    const match = wanted && browsers.find((b) => b.id === wanted);
    if (match) return match;
  }
  return browsers[0] || null;
}
