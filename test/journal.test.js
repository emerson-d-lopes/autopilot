// The action journal: what the host records about each call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
