// The action journal: what the host records about each call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CHROME_MCP_LOG_DIR = mkdtempSync(join(tmpdir(), 'chrome-mcp-journal-'));
const journal = await import('../host/journal.js');

test('arguments are summarised without bulk', () => {
  const args = journal.summarizeArgs('computer', {
    tabId: 5,
    action: 'type',
    text: 'x'.repeat(500),
    coordinate: [10, 20],
    paths: ['a.png', 'b.png'],
  });
  assert.equal(args.tabId, undefined, 'the tab is recorded separately');
  assert.ok(args.text.length < 200 && args.text.endsWith('...'));
  assert.deepEqual(args.coordinate, [10, 20]);
  assert.equal(args.paths, '2 item(s)');
  const batch = journal.summarizeArgs('browser_batch', { actions: [{ name: 'navigate', input: {} }, { name: 'find', input: {} }] });
  assert.deepEqual(batch.actions, ['navigate', 'find']);
});

test('results are described, screenshots by size and errors by message', () => {
  assert.deepEqual(journal.summarizeResult('computer', { result: { image: { width: 100, height: 50, data: 'AAAA' } } }), {
    ok: true,
    image: '100x50',
  });
  assert.deepEqual(journal.summarizeResult('read_page', { result: { nodes: 42, totalChars: 900, url: 'https://a' } }), {
    ok: true,
    nodes: 42,
    chars: 900,
  });
  assert.deepEqual(journal.summarizeResult('navigate', { error: { message: 'boom' } }), { ok: false, error: 'boom' });
  const batch = journal.summarizeResult('browser_batch', {
    result: { results: [{ ok: true }, { ok: false, error: { message: 'ref gone' } }], completed: false, stoppedAt: 1 },
  });
  assert.equal(batch.steps, 2);
  assert.equal(batch.stoppedAt, 1);
  assert.equal(batch.error, 'ref gone');
});

test('an entry carries time, tab, page and outcome, and lands in both files', () => {
  const entry = journal.makeEntry({
    request: { tool: 'navigate', args: { tabId: 7, url: 'https://example.com' }, clientId: 'c1' },
    response: { result: { url: 'https://example.com/', title: 'Example' }, tab: { id: 7, url: 'https://example.com/', title: 'Example' } },
    startedAt: 1000,
    finishedAt: 1250,
  });
  assert.equal(entry.tool, 'navigate');
  assert.equal(entry.ms, 250);
  assert.equal(entry.client, 'c1');
  assert.equal(entry.tab.url, 'https://example.com/');
  assert.equal(entry.ok, true);

  const paths = journal.record('btest', entry);
  assert.ok(paths && existsSync(paths.jsonl) && existsSync(paths.md));
  const line = JSON.parse(readFileSync(paths.jsonl, 'utf8').trim().split('\n').pop());
  assert.equal(line.tool, 'navigate');
  const md = readFileSync(paths.md, 'utf8');
  assert.ok(/\*\*navigate\*\* tab 7 https:\/\/example\.com\//.test(md), md);
  assert.ok(/\(250ms\)/.test(md));
  rmSync(process.env.CHROME_MCP_LOG_DIR, { recursive: true, force: true });
});

test('a failed call reads as FAILED in the timeline', () => {
  const entry = journal.makeEntry({
    request: { tool: 'computer', args: { tabId: 1, action: 'left_click', ref: 'ref_9' } },
    response: { error: { message: 'ref ref_9 is no longer on the page' } },
    startedAt: 0,
    finishedAt: 12,
  });
  const md = journal.formatMarkdown(entry);
  assert.ok(md.includes('FAILED ref ref_9 is no longer on the page'), md);
  assert.ok(md.includes('action="left_click"'));
});

// --- C7, the correlation id and the contract fields --------------------------

test('an entry carries the correlation id, the effects and an evidence summary', () => {
  const entry = journal.makeEntry({
    request: { tool: 'computer', args: { tabId: 3, action: 'left_click', ref: 'ref_2' }, callId: 'call_11_ab12cd' },
    response: {
      result: { effects: 'applied', evidence: { mutations: 4, focus: 'button#send' }, warnings: ['took 900ms'] },
    },
    startedAt: 0,
    finishedAt: 900,
  });
  assert.equal(entry.callId, 'call_11_ab12cd');
  assert.equal(entry.effects, 'applied');
  assert.match(entry.evidence, /mutations":4/);
  assert.deepEqual(entry.warnings, ['took 900ms']);
  assert.match(journal.formatMarkdown(entry), /id=call_11_ab12cd/);
});

test('a failure records the error code next to the message', () => {
  const entry = journal.makeEntry({
    request: { tool: 'navigate', args: { tabId: 1, url: 'https://a/' }, callId: 'call_12' },
    response: { error: { message: 'the tab is gone', code: 'tab_gone', effects: 'none' } },
    startedAt: 0,
    finishedAt: 5,
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.code, 'tab_gone');
  assert.equal(entry.effects, 'none');
  assert.match(journal.formatMarkdown(entry), /FAILED the tab is gone \(tab_gone\)/);
});

// --- F3, the argument denylist ----------------------------------------------

test('typed text and form values are dropped when the result is marked sensitive', () => {
  const typed = journal.makeEntry({
    request: { tool: 'computer', args: { tabId: 1, action: 'type', text: 'hunter2' } },
    response: { result: { sensitive: true } },
    startedAt: 0,
    finishedAt: 1,
  });
  assert.equal(typed.args.text, '[value redacted]');
  assert.equal(typed.args.action, 'type', 'the action itself is not a secret');

  const filled = journal.makeEntry({
    request: { tool: 'form_input', args: { tabId: 1, ref: 'ref_5', value: 'hunter2' } },
    response: { result: { sensitive: true } },
    startedAt: 0,
    finishedAt: 1,
  });
  assert.equal(filled.args.value, '[value redacted]');
  assert.equal(filled.args.ref, 'ref_5');
});

test('with no sensitive marker the two denylisted values are dropped anyway', () => {
  const entry = journal.makeEntry({
    request: { tool: 'computer', args: { tabId: 1, action: 'type', text: 'my password' } },
    response: { result: {} },
    startedAt: 0,
    finishedAt: 1,
  });
  assert.equal(entry.args.text, '[value redacted]');
  assert.ok(!JSON.stringify(entry).includes('my password'));
});

test('a result that says sensitive false keeps the typed text', () => {
  const entry = journal.makeEntry({
    request: { tool: 'computer', args: { tabId: 1, action: 'type', text: 'hello world' } },
    response: { result: { sensitive: false } },
    startedAt: 0,
    finishedAt: 1,
  });
  assert.equal(entry.args.text, 'hello world');
});

test('other tools keep their arguments', () => {
  const entry = journal.makeEntry({
    request: { tool: 'navigate', args: { tabId: 1, url: 'https://example.com/page' } },
    response: { result: {} },
    startedAt: 0,
    finishedAt: 1,
  });
  assert.equal(entry.args.url, 'https://example.com/page');
});

// --- F3, the redaction switch -----------------------------------------------

test('CHROME_MCP_JOURNAL_REDACT drops the arguments and keeps the outcome', () => {
  process.env.CHROME_MCP_JOURNAL_REDACT = '1';
  try {
    assert.equal(journal.redactionOn(), true);
    const entry = journal.makeEntry({
      request: { tool: 'form_input', args: { tabId: 2, ref: 'ref_1', value: 'secret text' }, callId: 'call_20' },
      response: { result: { effects: 'applied' } },
      startedAt: 0,
      finishedAt: 40,
    });
    assert.equal(entry.args, undefined);
    assert.equal(entry.redacted, true);
    assert.equal(entry.tool, 'form_input');
    assert.equal(entry.callId, 'call_20');
    assert.equal(entry.ok, true);
    assert.equal(entry.effects, 'applied');
    assert.ok(!JSON.stringify(entry).includes('secret text'));
    assert.match(journal.formatMarkdown(entry), /args redacted/);
  } finally {
    delete process.env.CHROME_MCP_JOURNAL_REDACT;
  }
  assert.equal(journal.redactionOn(), false);
});

// --- F3, rotation ------------------------------------------------------------

test('CHROME_MCP_JOURNAL_DAYS defaults to 14 and reads the environment', () => {
  assert.equal(journal.retentionDays(), 14);
  process.env.CHROME_MCP_JOURNAL_DAYS = '3';
  try {
    assert.equal(journal.retentionDays(), 3);
  } finally {
    delete process.env.CHROME_MCP_JOURNAL_DAYS;
  }
});

test('files older than the retention window are pruned and newer ones are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-prune-'));
  const browserDir = join(dir, 'btest');
  mkdirSync(browserDir, { recursive: true });

  const day = (offset) => {
    const d = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  };
  const names = [day(0), day(3), day(20), day(60)];
  for (const name of names) {
    writeFileSync(join(browserDir, name + '.jsonl'), '{}\n');
    writeFileSync(join(browserDir, name + '.md'), '# x\n');
  }
  // A file that is not a dated journal file is left alone.
  writeFileSync(join(browserDir, 'notes.txt'), 'keep me');

  const { removed, days } = journal.pruneJournal({ days: 14, dir });
  assert.equal(days, 14);
  assert.equal(removed.length, 4, 'both files for each of the two old days');

  const left = readdirSync(browserDir).sort();
  assert.deepEqual(left, [day(0) + '.jsonl', day(0) + '.md', day(3) + '.jsonl', day(3) + '.md', 'notes.txt'].sort());
  rmSync(dir, { recursive: true, force: true });
});

test('a retention of zero prunes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-prune-off-'));
  mkdirSync(join(dir, 'b'), { recursive: true });
  writeFileSync(join(dir, 'b', '2000-01-01.jsonl'), '{}\n');
  assert.deepEqual(journal.pruneJournal({ days: 0, dir }).removed, []);
  assert.ok(existsSync(join(dir, 'b', '2000-01-01.jsonl')));
  rmSync(dir, { recursive: true, force: true });
});

test('pruning a directory that does not exist is not an error', () => {
  assert.deepEqual(journal.pruneJournal({ days: 14, dir: join(tmpdir(), 'chrome-mcp-absent-' + process.pid) }).removed, []);
});

test('journalSize reports the files on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-size-'));
  mkdirSync(join(dir, 'b'), { recursive: true });
  writeFileSync(join(dir, 'b', '2026-01-01.jsonl'), 'x'.repeat(500));
  const size = journal.journalSize(dir);
  assert.equal(size.files, 1);
  assert.equal(size.bytes, 500);
  rmSync(dir, { recursive: true, force: true });
});
