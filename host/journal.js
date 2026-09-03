// Action journal.
//
// The host sees every tool request and its response, so it is the one place
// that can record what a session did: which tool, on which tab and page, with
// what arguments, how long it took, and whether it worked. Two files per
// browser per day: a JSONL file for programs and a Markdown timeline for
// people. Screenshots and other bulky payloads are described, not copied.

import { mkdirSync, appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const JOURNAL_DIR = process.env.CHROME_MCP_LOG_DIR || join(tmpdir(), 'chrome-mcp-logs');

const MAX_STRING = 160;

/** Days of journal kept. Files older than this are deleted at host start. */
export const DEFAULT_RETENTION_DAYS = 14;

/** True when the host was told to keep the shape of each call and none of the strings. */
export function redactionOn() {
  return process.env.CHROME_MCP_JOURNAL_REDACT === '1';
}

export function retentionDays() {
  const raw = Number(process.env.CHROME_MCP_JOURNAL_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/**
 * Argument values dropped even with redaction off, because they carry what the
 * user typed. The extension marks a result `sensitive: true` when it knows the
 * field was a password. With no marker the value is dropped anyway, so a build
 * that predates the marker never leaks one.
 */
const VALUE_DENYLIST = { computer: ['text'], form_input: ['value'] };

/** Which argument keys this call must not record. */
export function deniedKeys(tool, { sensitive } = {}) {
  const keys = VALUE_DENYLIST[tool];
  if (!keys) return [];
  return sensitive === false ? [] : keys;
}

function clip(text, max = MAX_STRING) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/**
 * Arguments with bulk removed: no base64, no long scripts, no file bodies.
 *
 * `deny` names keys whose value is replaced rather than clipped, which is how
 * a typed password stays out of the file.
 */
export function summarizeArgs(tool, args = {}, { deny = [] } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (key === 'tabId') continue;
    if (deny.includes(key)) {
      out[key] = '[value redacted]';
      continue;
    }
    if (typeof value === 'string') out[key] = clip(value);
    else if (Array.isArray(value)) {
      if (tool === 'browser_batch' && key === 'actions') {
        out.actions = value.map((a) => (a && a.name ? a.name : '?'));
      } else if (value.every((v) => typeof v === 'number')) out[key] = value;
      else out[key] = value.length + ' item(s)';
    } else if (typeof value === 'object') out[key] = clip(JSON.stringify(value), 200);
    else out[key] = value;
  }
  return out;
}

/** A one-line account of what came back, sized for a log rather than a reply. */
export function summarizeResult(tool, response = {}) {
  if (response.error) {
    const err = response.error;
    const out = { ok: false, error: clip(err.message || String(err), 300) };
    if (err.code) out.code = err.code;
    if (err.effects) out.effects = err.effects;
    return out;
  }
  const r = response.result;
  if (!r || typeof r !== 'object') return { ok: true };
  const out = { ok: true };
  if (r.effects) out.effects = r.effects;
  if (r.evidence && typeof r.evidence === 'object' && Object.keys(r.evidence).length) {
    out.evidence = clip(JSON.stringify(r.evidence), 300);
  }
  if (Array.isArray(r.warnings) && r.warnings.length) out.warnings = r.warnings.map((w) => clip(w, 120));
  if (r.image) out.image = r.image.width + 'x' + r.image.height + (r.saveToDisk ? ' saved' : '');
  if (r.nodes !== undefined) out.nodes = r.nodes;
  if (r.totalChars !== undefined) out.chars = r.totalChars;
  if (r.matches) out.matches = r.matches.length;
  if (r.url && tool !== 'read_page') out.url = clip(r.url, 200);
  if (r.tabId !== undefined && (tool === 'tabs_create' || tool === 'tabs_context')) out.tabId = r.tabId;
  if (r.tabs) out.tabs = r.tabs.length;
  if (r.results) {
    out.steps = r.results.length;
    if (r.completed === false) out.stoppedAt = r.stoppedAt;
    const failed = r.results.find((s) => !s.ok);
    if (failed) out.error = clip((failed.error && failed.error.message) || 'failed', 300);
  }
  if (r.navigated !== undefined) out.navigated = r.navigated;
  if (r.value !== undefined && tool === 'javascript') out.value = clip(JSON.stringify(r.value), 120);
  if (r.result !== undefined && tool === 'javascript') out.value = clip(JSON.stringify(r.result), 120);
  return out;
}

/**
 * Builds the journal entry for one completed call.
 *
 * With redaction on the entry keeps the tool, the correlation id, the outcome
 * and the effects, and drops the arguments entirely. With it off the two
 * denylisted values are still replaced.
 */
export function makeEntry({ request, response, startedAt, finishedAt }) {
  const tool = request.tool;
  const args = request.args || {};
  const tab = (response && response.tab) || (args.tabId !== undefined ? { id: args.tabId } : undefined);
  const result = (response && response.result) || {};
  const callId = request.callId || result.callId || result.id || null;

  const entry = {
    at: new Date(startedAt).toISOString(),
    ms: Math.max(0, finishedAt - startedAt),
    client: request.clientId || 'default',
    tool,
    tab,
  };
  if (callId) entry.callId = callId;

  if (redactionOn()) entry.redacted = true;
  else entry.args = summarizeArgs(tool, args, { deny: deniedKeys(tool, { sensitive: result.sensitive }) });

  return { ...entry, ...summarizeResult(tool, response || {}) };
}

const OUTCOME_SKIP = ['at', 'ms', 'client', 'tool', 'tab', 'args', 'ok', 'callId', 'redacted'];

/** One Markdown line per call, readable without tooling. */
export function formatMarkdown(entry) {
  const time = entry.at.slice(11, 19);
  const where = entry.tab ? ' tab ' + entry.tab.id + (entry.tab.url ? ' ' + clip(entry.tab.url, 100) : '') : '';
  const args = entry.args
    ? Object.entries(entry.args)
        .map(([k, v]) => k + '=' + (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)))
        .join(' ')
    : entry.redacted
      ? 'args redacted'
      : '';
  const outcome = entry.ok
    ? Object.entries(entry)
        .filter(([k]) => !OUTCOME_SKIP.includes(k))
        .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ')
    : 'FAILED ' + entry.error + (entry.code ? ' (' + entry.code + ')' : '');
  const id = entry.callId ? ' id=' + entry.callId : '';
  return '- ' + time + ' **' + entry.tool + '**' + where + (args ? ' `' + args + '`' : '') + ' (' + entry.ms + 'ms)' + (outcome ? ' ' + outcome : '') + id;
}

function dayStamp(date) {
  return date.toISOString().slice(0, 10);
}

/** Paths of the two files a browser's calls go to today. */
export function journalPaths(browserId, date = new Date()) {
  const dir = join(JOURNAL_DIR, (browserId || 'default').replace(/[^\w.-]/g, '_'));
  return { dir, jsonl: join(dir, dayStamp(date) + '.jsonl'), md: join(dir, dayStamp(date) + '.md') };
}

/**
 * Deletes journal files older than the retention window.
 *
 * Called once at host start. The day is read from the file name, which is how
 * the files are already laid out, and a file whose name is not a date is left
 * alone rather than guessed at.
 *
 * @returns {{removed: string[], days: number}}
 */
export function pruneJournal({ days = retentionDays(), dir = JOURNAL_DIR, now = Date.now() } = {}) {
  const removed = [];
  if (!Number.isFinite(days) || days <= 0) return { removed, days };
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  let browsers = [];
  try {
    browsers = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { removed, days };
  }

  for (const browser of browsers) {
    const browserDir = join(dir, browser.name);
    let files = [];
    try {
      files = readdirSync(browserDir);
    } catch {
      continue;
    }
    for (const file of files) {
      const match = /^(\d{4}-\d{2}-\d{2})\.(jsonl|md)$/.exec(file);
      if (!match) continue;
      const stamp = Date.parse(match[1] + 'T23:59:59.999Z');
      if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
      const full = join(browserDir, file);
      try {
        rmSync(full, { force: true });
        removed.push(full);
      } catch {
        /* a file held open by another host is not worth failing start over */
      }
    }
  }
  return { removed, days };
}

/** Bytes the journal currently occupies, for doctor and for the popup. */
export function journalSize(dir = JOURNAL_DIR) {
  let total = 0;
  let files = 0;
  const walk = (path) => {
    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += statSync(full).size;
          files += 1;
        } catch {
          /* removed between listing and stat */
        }
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

const started = new Set();

/** Appends one call to both files. Never throws: a journal must not break a call. */
export function record(browserId, entry) {
  try {
    const paths = journalPaths(browserId, new Date(entry.at));
    mkdirSync(paths.dir, { recursive: true });
    appendFileSync(paths.jsonl, JSON.stringify(entry) + '\n');
    if (!started.has(paths.md)) {
      started.add(paths.md);
      appendFileSync(paths.md, '\n## Host started ' + new Date().toISOString() + ' (browser ' + browserId + ')\n\n');
    }
    appendFileSync(paths.md, formatMarkdown(entry) + '\n');
    return paths;
  } catch {
    return null;
  }
}
