#!/usr/bin/env node
// Proves extension/src/lib/errors.js is still a copy of host/errors.js.
//
// The two files differ only in their header comment, so the comparison drops
// every comment line and compares what is left.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function bodyOf(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .trim();
}

export const CANONICAL = join(ROOT, 'host', 'errors.js');
export const COPY = join(ROOT, 'extension', 'src', 'lib', 'errors.js');

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/').replace(/^\//, '')) {
  const same = bodyOf(CANONICAL) === bodyOf(COPY);
  console.log(
    same ? 'ok   errors.js copy matches host/errors.js' : 'FAIL errors.js copy has drifted from host/errors.js'
  );
  if (!same) process.exitCode = 1;
}
