#!/usr/bin/env node
// Runs the unit suite the way CI does.
//
// The suites that need a browser (live, edge, campaign, resilience, shortcuts)
// discover one through the registry directory and skip themselves when it is
// empty. Pointing the registry at a fresh temporary directory makes that skip
// deterministic on a developer machine that has a browser connected, so
// `npm run test:unit` answers the same question here as on the runner.
//
// With --coverage, V8 coverage is collected over host/, extension/src/ and the
// testable tools, thresholds are enforced, an lcov file is written for
// reviewers, and the summary table is saved so CI can post it.
//
// Usage: node tools/run-tests.js [--coverage] [-- <extra node --test args>]

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE_DIR = join(ROOT, 'coverage');

// Minimums the suite must keep. Raise them as coverage grows, never lower them
// to make a red build green.
export const THRESHOLDS = { lines: 75, branches: 75, functions: 70 };

// Files that only make sense as a process on a real machine (launchers,
// installers, benchmarks) are left out of the coverage denominator.
const EXCLUDE = [
  'tools/bench.js',
  'tools/bench-screenshot.js',
  'tools/browser.js',
  'tools/doctor.js',
  'tools/gen-key.js',
  'tools/icons.js',
  'tools/install.js',
  'tools/log.js',
  'tools/mcp-client.js',
  'tools/run-tests.js',
];

const argv = process.argv.slice(2);
// Coverage include/exclude and thresholds arrived in Node 22 (and 20.17+ for
// some of them, with gaps), so on older majors the flag degrades to a plain run
// rather than failing on an unknown option.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const coverageSupported = nodeMajor >= 22;
const withCoverage = argv.includes('--coverage') && coverageSupported;
if (argv.includes('--coverage') && !coverageSupported) {
  console.log(
    'note: coverage thresholds need Node 22 or newer, running the suite without coverage on ' + process.version
  );
}
const dash = argv.indexOf('--');
const extra = dash === -1 ? [] : argv.slice(dash + 1);

const registry = mkdtempSync(join(tmpdir(), 'autopilot-unit-registry-'));

const args = ['--test', '--test-concurrency=1'];
if (withCoverage) {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  args.push(
    '--experimental-test-coverage',
    '--test-coverage-include=host/**/*.js',
    '--test-coverage-include=extension/src/**/*.js',
    '--test-coverage-include=tools/**/*.js',
    ...EXCLUDE.map((f) => '--test-coverage-exclude=' + f),
    '--test-coverage-lines=' + THRESHOLDS.lines,
    '--test-coverage-branches=' + THRESHOLDS.branches,
    '--test-coverage-functions=' + THRESHOLDS.functions,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=' + join(COVERAGE_DIR, 'lcov.info')
  );
}
// Listed explicitly rather than as a glob: Node 20 does not expand test globs itself.
const testFiles = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join('test', f));
args.push(...extra, ...testFiles);

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  env: { ...process.env, AUTOPILOT_REGISTRY_DIR: registry, FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
  stdio: ['inherit', 'pipe', 'inherit'],
});

// The spec reporter prints the coverage table after the results. It is copied
// out of the stream, with the reporter's leading "ℹ " markers stripped, so CI
// can attach it to the job summary.
let tail = '';
const summary = [];
let inTable = false;
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  tail += chunk.toString('utf8');
  let nl;
  while ((nl = tail.indexOf('\n')) !== -1) {
    const line = tail.slice(0, nl).replace(/\r$/, '');
    tail = tail.slice(nl + 1);
    if (line.includes('start of coverage report')) inTable = true;
    else if (line.includes('end of coverage report')) inTable = false;
    else if (inTable) summary.push(line.replace(/^\s*ℹ ?/, ''));
  }
});

child.on('close', (code) => {
  if (withCoverage) writeFileSync(join(COVERAGE_DIR, 'summary.txt'), summary.join('\n') + '\n');
  rmSync(registry, { recursive: true, force: true });
  process.exit(code ?? 1);
});
