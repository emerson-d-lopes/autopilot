import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersions, isChromeVersion, findProblems } from '../tools/check-versions.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the checked-in versions agree', () => {
  const versions = readVersions(ROOT);
  assert.equal(versions.package, versions.manifest);
  assert.deepEqual(findProblems({ versions }), []);
});

test('isChromeVersion accepts one to four integer parts', () => {
  for (const ok of ['1', '0.2.1', '1.2.3.4', '65535.0']) assert.ok(isChromeVersion(ok), ok);
  for (const bad of ['', '1.2.3.4.5', '1.a', '65536', '1.2-beta', 'v1.0', undefined, 1]) {
    assert.equal(isChromeVersion(bad), false, String(bad));
  }
});

test('a version mismatch is reported', () => {
  const problems = findProblems({ versions: { package: '0.2.1', manifest: '0.2.0' } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package\.json is 0\.2\.1 but extension\/manifest\.json is 0\.2\.0/);
});

test('an invalid manifest version is reported', () => {
  const problems = findProblems({ versions: { package: '1.0-rc', manifest: '1.0-rc' } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a valid Chrome version/);
});

test('a change under extension/ without a bump is reported', () => {
  const problems = findProblems({
    versions: { package: '0.2.1', manifest: '0.2.1' },
    changedFiles: ['README.md', 'extension/src/lib/tabs.js'],
    baseManifestVersion: '0.2.1',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /files under extension\/ changed but extension\/manifest\.json is still 0\.2\.1/);
});

test('a change under extension/ with a bump passes', () => {
  const problems = findProblems({
    versions: { package: '0.2.2', manifest: '0.2.2' },
    changedFiles: ['extension\\src\\lib\\tabs.js'],
    baseManifestVersion: '0.2.1',
  });
  assert.deepEqual(problems, []);
});

test('a change outside extension/ needs no bump', () => {
  const problems = findProblems({
    versions: { package: '0.2.1', manifest: '0.2.1' },
    changedFiles: ['host/mcp-server.js', 'test/tabs.test.js'],
    baseManifestVersion: '0.2.1',
  });
  assert.deepEqual(problems, []);
});

test('the CLI exits 0 on the checked-in tree', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'check-versions.js')], { encoding: 'utf8' });
  assert.match(out, /^ok\s+versions agree at \d/);
});
