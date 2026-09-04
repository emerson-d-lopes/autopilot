#!/usr/bin/env node
// Prints the action journal: what each connected browser was asked to do.
//
//   npm run log                 today's timeline for every browser
//   npm run log -- --tail 20    the last 20 calls
//   npm run log -- --json       raw JSONL entries instead of the timeline
//   npm run log -- --date 2026-09-03

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOURNAL_DIR, LEGACY_JOURNAL_DIR, formatWrite } from '../host/journal.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const tail = flag('--tail') ? Number(flag('--tail')) : null;
const date = flag('--date') || new Date().toISOString().slice(0, 10);
const json = args.includes('--json');

// The journal moved from chrome-mcp-logs to autopilot-logs with the rename, so
// the old directory is still read and anything found there is still printed.
const dirs = [...new Set([JOURNAL_DIR, LEGACY_JOURNAL_DIR])].filter((dir) => existsSync(dir));

if (!dirs.length) {
  console.log('No journal yet at ' + JOURNAL_DIR + '. It is written as tools run.');
  process.exit(0);
}

/** The write rows in a day's JSONL, for the writes column (W5). */
function writesFor(dir, browser) {
  const file = join(dir, browser, date + '.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.write);
}

let printed = 0;
for (const dir of dirs) {
  for (const browser of readdirSync(dir)) {
    const file = join(dir, browser, date + (json ? '.jsonl' : '.md'));
    if (!existsSync(file)) continue;
    let lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (tail) lines = lines.slice(-tail);
    console.log('# ' + browser + '  (' + file + ')');
    console.log(lines.join('\n'));

    // Writes are the entries worth finding without reading the whole timeline, so
    // they get a column of their own under it.
    if (!json) {
      const writes = writesFor(dir, browser);
      if (writes.length) {
        console.log();
        console.log('## Writes');
        for (const entry of writes) {
          console.log(
            '- ' + entry.at.slice(11, 19) + '  ' + entry.tool.padEnd(9) + '  ' + formatWrite(entry.write) +
              (entry.callId ? '  id=' + entry.callId : '')
          );
        }
      }
    }
    console.log();
    printed++;
  }
}
if (!printed) console.log('No entries for ' + date + ' under ' + dirs.join(' or ') + '.');
