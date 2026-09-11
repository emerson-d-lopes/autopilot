#!/usr/bin/env node
// Proves extension/manifest.json and package.json carry the same version, and
// with --base <ref>, that a change under extension/ bumped it.
//
// Chrome caches the compiled service worker module graph per extension
// version, so an edit that ships without a bump can run stale code on a
// machine that already had the previous version loaded. The bump is what lets
// `npm run doctor` prove a reload took.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readVersions(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
  return { package: pkg.version, manifest: manifest.version };
}

/** Chrome accepts one to four dot-separated integers, each 0..65535. */
export function isChromeVersion(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((p) => /^\d{1,5}$/.test(p) && Number(p) <= 65535);
}

/**
 * Returns the problems found, empty when everything is consistent.
 * @param {{ versions: {package: string, manifest: string}, changedFiles?: string[], baseManifestVersion?: string|null }} input
 */
export function findProblems({ versions, changedFiles = [], baseManifestVersion = null }) {
  const problems = [];
  if (!isChromeVersion(versions.manifest)) {
    problems.push('extension/manifest.json version "' + versions.manifest + '" is not a valid Chrome version');
  }
  if (versions.package !== versions.manifest) {
    problems.push(
      'package.json is ' +
        versions.package +
        ' but extension/manifest.json is ' +
        versions.manifest +
        '; keep them equal'
    );
  }
  const touchedExtension = changedFiles.some((f) => f.replace(/\\/g, '/').startsWith('extension/'));
  if (touchedExtension && baseManifestVersion !== null && baseManifestVersion === versions.manifest) {
    problems.push(
      'files under extension/ changed but extension/manifest.json is still ' +
        versions.manifest +
        '; bump it (and package.json) so a reload can be proven'
    );
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function main() {
  const versions = readVersions();
  const baseIndex = process.argv.indexOf('--base');
  let changedFiles = [];
  let baseManifestVersion = null;
  if (baseIndex !== -1) {
    const base = process.argv[baseIndex + 1];
    if (!base) {
      console.error('--base needs a git ref');
      process.exit(2);
    }
    const mergeBase = git(['merge-base', base, 'HEAD']);
    changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD']).split(/\r?\n/).filter(Boolean);
    try {
      baseManifestVersion = JSON.parse(git(['show', mergeBase + ':extension/manifest.json'])).version;
    } catch {
      baseManifestVersion = null;
    }
  }
  const problems = findProblems({ versions, changedFiles, baseManifestVersion });
  if (problems.length === 0) {
    console.log('ok   versions agree at ' + versions.manifest);
    return;
  }
  for (const p of problems) console.log('FAIL ' + p);
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === 'file:///' + resolve(process.argv[1]).replace(/\\/g, '/').replace(/^\//, '')
) {
  main();
}
