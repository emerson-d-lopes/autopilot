// The action journal: what the host records about each call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.AUTOPILOT_LOG_DIR = mkdtempSync(join(tmpdir(), 'autopilot-journal-'));
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
  const batch = journal.summarizeArgs('browser_batch', {
    actions: [
      { name: 'navigate', input: {} },
      { name: 'find', input: {} },
    ],
  });
  assert.deepEqual(batch.actions, ['navigate', 'find']);
});

test('results are described, screenshots by size and errors by message', () => {
  assert.deepEqual(
    journal.summarizeResult('computer', { result: { image: { width: 100, height: 50, data: 'AAAA' } } }),
    {
      ok: true,
      image: '100x50',
    }
  );
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
    response: {
      result: { url: 'https://example.com/', title: 'Example' },
      tab: { id: 7, url: 'https://example.com/', title: 'Example' },
    },
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
  rmSync(process.env.AUTOPILOT_LOG_DIR, { recursive: true, force: true });
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

test('AUTOPILOT_JOURNAL_REDACT drops the arguments and keeps the outcome', () => {
  process.env.AUTOPILOT_JOURNAL_REDACT = '1';
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
    delete process.env.AUTOPILOT_JOURNAL_REDACT;
  }
  assert.equal(journal.redactionOn(), false);
});

// --- F3, rotation ------------------------------------------------------------

test('AUTOPILOT_JOURNAL_DAYS defaults to 14 and reads the environment', () => {
  assert.equal(journal.retentionDays(), 14);
  process.env.AUTOPILOT_JOURNAL_DAYS = '3';
  try {
    assert.equal(journal.retentionDays(), 3);
  } finally {
    delete process.env.AUTOPILOT_JOURNAL_DAYS;
  }
});

test('files older than the retention window are pruned and newer ones are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-prune-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-prune-off-'));
  mkdirSync(join(dir, 'b'), { recursive: true });
  writeFileSync(join(dir, 'b', '2000-01-01.jsonl'), '{}\n');
  assert.deepEqual(journal.pruneJournal({ days: 0, dir }).removed, []);
  assert.ok(existsSync(join(dir, 'b', '2000-01-01.jsonl')));
  rmSync(dir, { recursive: true, force: true });
});

test('pruning a directory that does not exist is not an error', () => {
  assert.deepEqual(
    journal.pruneJournal({ days: 14, dir: join(tmpdir(), 'autopilot-absent-' + process.pid) }).removed,
    []
  );
});

test('journalSize reports the files on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-size-'));
  mkdirSync(join(dir, 'b'), { recursive: true });
  writeFileSync(join(dir, 'b', '2026-01-01.jsonl'), 'x'.repeat(500));
  const size = journal.journalSize(dir);
  assert.equal(size.files, 1);
  assert.equal(size.bytes, 500);
  rmSync(dir, { recursive: true, force: true });
});

// --- notes the extension sends outside a call -------------------------------

test('a journal_note from the extension becomes a journal line', () => {
  const entry = journal.noteEntry(
    {
      type: 'journal_note',
      event: 'stale_response_dropped',
      tool: 'computer',
      id: 'mcp_7',
      callId: 'call_31_ab12cd',
      detail: 'the native port reconnected while this call was running, so its result was dropped',
    },
    Date.UTC(2026, 8, 3, 10, 0, 0)
  );

  assert.equal(entry.tool, 'computer');
  assert.equal(entry.note, 'stale_response_dropped');
  assert.equal(entry.callId, 'call_31_ab12cd');
  assert.equal(entry.messageId, 'mcp_7');
  assert.equal(entry.ok, true);
  assert.match(entry.detail, /result was dropped/);
  assert.match(journal.formatMarkdown(entry), /\*\*computer\*\*/);
  assert.match(journal.formatMarkdown(entry), /id=call_31_ab12cd/);
});

test('a note with nothing in it still records something readable', () => {
  const entry = journal.noteEntry({});
  assert.equal(entry.tool, 'unknown');
  assert.equal(entry.note, 'note');
  assert.equal(entry.callId, undefined);
  assert.equal(typeof entry.at, 'string');
});

// ---------------------------------------------------------------------------
// W5: the write column
// ---------------------------------------------------------------------------

const writeCall = (write) => ({
  request: { tool: 'computer', callId: 'call_9_abc', args: { tabId: 3, action: 'left_click', ref: 'ref_4' } },
  response: { result: { ok: true, effects: 'applied', write }, tab: { id: 3, url: 'https://example.com/x' } },
  startedAt: Date.parse('2026-09-04T10:00:00Z'),
  finishedAt: Date.parse('2026-09-04T10:00:03Z'),
});

const SENT = {
  control: 'Send',
  origin: 'https://example.com',
  before: 'write_1_ab12',
  after: ['composer emptied', '2xx from the site'],
  confirmedBy: 'token',
  value: 'the deck is attached',
};

test('an irreversible action carries its own write row', () => {
  const entry = journal.makeEntry(writeCall(SENT));
  assert.equal(entry.callId, 'call_9_abc');
  assert.equal(entry.write.control, 'Send');
  assert.equal(entry.write.origin, 'https://example.com');
  assert.equal(entry.write.before, 'write_1_ab12', 'the screenshot taken before the click');
  assert.deepEqual(entry.write.after, ['composer emptied', '2xx from the site']);
  assert.equal(entry.write.confirmedBy, 'token');
  assert.equal(entry.write.value, 'the deck is attached');
});

test('a call that wrote nothing has no write row', () => {
  const entry = journal.makeEntry({
    request: { tool: 'read_page', args: { tabId: 3 } },
    response: { result: { ok: true, nodes: 12 } },
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });
  assert.equal(entry.write, undefined);
});

test('a sensitive field keeps its value out of the journal whatever the switch says', () => {
  const entry = journal.makeEntry(writeCall({ ...SENT, sensitive: true }));
  assert.equal(entry.write.value, '[value redacted]');
  assert.equal(JSON.stringify(entry).includes('the deck is attached'), false);
});

test('redaction mode keeps the write and drops the value', () => {
  process.env.AUTOPILOT_JOURNAL_REDACT = '1';
  try {
    const entry = journal.makeEntry(writeCall(SENT));
    assert.equal(entry.redacted, true);
    assert.equal(entry.args, undefined);
    assert.equal(entry.write.control, 'Send', 'that a write happened is not the part being redacted');
    assert.deepEqual(entry.write.after, ['composer emptied', '2xx from the site']);
    assert.equal(entry.write.value, '[value redacted]');
    assert.equal(JSON.stringify(entry).includes('the deck is attached'), false);
  } finally {
    delete process.env.AUTOPILOT_JOURNAL_REDACT;
  }
});

test('the write column renders as its own field on the Markdown line', () => {
  const entry = journal.makeEntry(writeCall(SENT));
  const line = journal.formatMarkdown(entry);
  assert.match(line, /WRITE "Send" on https:\/\/example\.com/);
  assert.match(line, /before=write_1_ab12/);
  assert.match(line, /after=composer emptied\+2xx from the site/);
  assert.match(line, /confirmed=token/);
});

test('a write with no evidence after it says so rather than leaving the column empty', () => {
  const entry = journal.makeEntry(
    writeCall({ control: 'Delete', origin: 'https://example.com', before: null, after: [] })
  );
  assert.match(journal.formatMarkdown(entry), /before=none after=none/);
});

// --- F3, a javascript return value ------------------------------------------

test('the redaction switch covers a javascript return value', () => {
  journal.forgetRedactedValues();
  process.env.AUTOPILOT_JOURNAL_REDACT = '1';
  try {
    const entry = journal.makeEntry({
      request: { tool: 'javascript', args: { tabId: 4, code: 'document.title' }, callId: 'call_6_hlg9q3' },
      response: { result: { result: 'redaction check message', type: 'string' } },
      startedAt: 0,
      finishedAt: 4,
    });
    assert.equal(entry.value, '[value redacted]');
    assert.equal(JSON.stringify(entry).includes('redaction check message'), false);
    assert.equal(journal.formatMarkdown(entry).includes('redaction check message'), false);
  } finally {
    delete process.env.AUTOPILOT_JOURNAL_REDACT;
    journal.forgetRedactedValues();
  }
});

test('a javascript value that repeats what a write redacted is redacted too', () => {
  journal.forgetRedactedValues();
  try {
    // The write row hides the value because the field was sensitive.
    const write = journal.makeEntry(writeCall({ ...SENT, value: 'hunter2 passphrase', sensitive: true }));
    assert.equal(write.write.value, '[value redacted]');

    const echoed = journal.makeEntry({
      request: { tool: 'javascript', args: { tabId: 3, code: 'document.querySelector("input").value' } },
      response: { result: { result: 'hunter2 passphrase' } },
      startedAt: 0,
      finishedAt: 4,
    });
    assert.equal(echoed.value, '[value redacted]', 'the text the write row hid is two lines above it');
    assert.equal(JSON.stringify(echoed).includes('hunter2 passphrase'), false);
  } finally {
    journal.forgetRedactedValues();
  }
});

test('an unrelated javascript value is still recorded', () => {
  journal.forgetRedactedValues();
  journal.makeEntry(writeCall({ ...SENT, value: 'hunter2 passphrase', sensitive: true }));
  const entry = journal.makeEntry({
    request: { tool: 'javascript', args: { tabId: 3, code: 'document.title' } },
    response: { result: { result: 'Fixture page' } },
    startedAt: 0,
    finishedAt: 4,
  });
  assert.equal(entry.value, '"Fixture page"');
  journal.forgetRedactedValues();
});

test('a very short value is not remembered, since it would match everything', () => {
  journal.forgetRedactedValues();
  assert.equal(journal.noteRedactedValue('ok'), false);
  assert.equal(journal.noteRedactedValue('hunter2'), true);
  assert.equal(journal.holdsRedactedValue('"hunter2"'), true);
  assert.equal(journal.holdsRedactedValue('"ok"'), false);
  journal.forgetRedactedValues();
});
