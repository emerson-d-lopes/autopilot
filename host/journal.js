// Action journal.
//
// The host sees every tool request and its response, so it is the one place
// that can record what a session did: which tool, on which tab and page, with
// what arguments, how long it took, and whether it worked. Two files per
// browser per day: a JSONL file for programs and a Markdown timeline for
// people. Screenshots and other bulky payloads are described, not copied.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const JOURNAL_DIR = process.env.CHROME_MCP_LOG_DIR || join(tmpdir(), 'chrome-mcp-logs');

const MAX_STRING = 160;

function clip(text, max = MAX_STRING) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/** Arguments with bulk removed: no base64, no long scripts, no file bodies. */
export function summarizeArgs(tool, args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (key === 'tabId') continue;
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
  if (response.error) return { ok: false, error: clip(response.error.message || String(response.error), 300) };
  const r = response.result;
  if (!r || typeof r !== 'object') return { ok: true };
  const out = { ok: true };
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

/** Builds the journal entry for one completed call. */
export function makeEntry({ request, response, startedAt, finishedAt }) {
  const tool = request.tool;
  const args = request.args || {};
  const tab = (response && response.tab) || (args.tabId !== undefined ? { id: args.tabId } : undefined);
  return {
    at: new Date(startedAt).toISOString(),
    ms: Math.max(0, finishedAt - startedAt),
    client: request.clientId || 'default',
    tool,
    tab,
    args: summarizeArgs(tool, args),
    ...summarizeResult(tool, response || {}),
  };
}

/** One Markdown line per call, readable without tooling. */
export function formatMarkdown(entry) {
  const time = entry.at.slice(11, 19);
  const where = entry.tab ? ' tab ' + entry.tab.id + (entry.tab.url ? ' ' + clip(entry.tab.url, 100) : '') : '';
  const args = Object.entries(entry.args)
    .map(([k, v]) => k + '=' + (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)))
    .join(' ');
  const outcome = entry.ok
    ? Object.entries(entry)
        .filter(([k]) => !['at', 'ms', 'client', 'tool', 'tab', 'args', 'ok'].includes(k))
        .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ')
    : 'FAILED ' + entry.error;
  return '- ' + time + ' **' + entry.tool + '**' + where + (args ? ' `' + args + '`' : '') + ' (' + entry.ms + 'ms)' + (outcome ? ' ' + outcome : '');
}

function dayStamp(date) {
  return date.toISOString().slice(0, 10);
}

/** Paths of the two files a browser's calls go to today. */
export function journalPaths(browserId, date = new Date()) {
  const dir = join(JOURNAL_DIR, (browserId || 'default').replace(/[^\w.-]/g, '_'));
  return { dir, jsonl: join(dir, dayStamp(date) + '.jsonl'), md: join(dir, dayStamp(date) + '.md') };
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
