#!/usr/bin/env node
// Prints the action journal: what each connected browser was asked to do.
//
//   npm run log                 today's timeline for every browser
//   npm run log -- --tail 20    the last 20 calls
//   npm run log -- --json       raw JSONL entries instead of the timeline
//   npm run log -- --date 2026-09-03

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOURNAL_DIR } from '../host/journal.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const tail = flag('--tail') ? Number(flag('--tail')) : null;
const date = flag('--date') || new Date().toISOString().slice(0, 10);
const json = args.includes('--json');

if (!existsSync(JOURNAL_DIR)) {
  console.log('No journal yet at ' + JOURNAL_DIR + '. It is written as tools run.');
  process.exit(0);
}

let printed = 0;
for (const browser of readdirSync(JOURNAL_DIR)) {
  const file = join(JOURNAL_DIR, browser, date + (json ? '.jsonl' : '.md'));
  if (!existsSync(file)) continue;
  let lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  if (tail) lines = lines.slice(-tail);
  console.log('# ' + browser + '  (' + file + ')');
  console.log(lines.join('\n'));
  console.log();
  printed++;
}
if (!printed) console.log('No entries for ' + date + ' under ' + JOURNAL_DIR + '.');
