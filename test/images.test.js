// The image store behind screenshots and upload_image, and the upload path
// checks that run before a path reaches the browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'autopilot-images-'));
process.env.AUTOPILOT_SCREENSHOT_DIR = join(dir, 'shots');
const images = await import('../host/images.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const png = { data: Buffer.from('png').toString('base64'), mediaType: 'image/png' };
const jpeg = { data: Buffer.from('jpg').toString('base64'), mediaType: 'image/jpeg' };

test('SHOT_DIR honours AUTOPILOT_SCREENSHOT_DIR', () => {
  assert.equal(images.SHOT_DIR, join(dir, 'shots'));
});

test('rememberImage hands out sequential ids and keeps the last twenty', () => {
  const first = images.rememberImage(png);
  assert.match(first, /^img_\d+$/);
  for (let i = 0; i < 25; i++) images.rememberImage(png);
  const ids = images.capturedImageIds();
  assert.equal(ids.length, 20);
  assert.equal(ids.includes(first), false, 'the oldest was dropped');
});

test('normalizeUploadFilename falls back, refuses separators, and caps at 255 keeping the extension', () => {
  assert.equal(images.normalizeUploadFilename('', 'fallback.png'), 'fallback.png');
  assert.equal(images.normalizeUploadFilename('  shot.png ', 'x'), 'shot.png');
  assert.throws(() => images.normalizeUploadFilename('a/b.png', 'x'), /must not contain a path separator/);
  assert.throws(() => images.normalizeUploadFilename('a\\b.png', 'x'), /must not contain a path separator/);
  const long = 'a'.repeat(300) + '.jpeg';
  const capped = images.normalizeUploadFilename(long, 'x');
  assert.equal(capped.length, 255);
  assert.ok(capped.endsWith('.jpeg'));
  const noExt = 'b'.repeat(300) + '.' + 'c'.repeat(20);
  assert.equal(images.normalizeUploadFilename(noExt, 'x').length, 255, 'a long tail after a dot is not an extension');
});

test('materializeImage writes a remembered image under the name the page should see', () => {
  const id = images.rememberImage(jpeg);
  const file = images.materializeImage(id, 'receipt');
  assert.equal(file, join(images.SHOT_DIR, 'receipt.jpg'));
  assert.equal(readFileSync(file, 'utf8'), 'jpg');

  const named = images.materializeImage(id, 'receipt.png');
  assert.equal(named, join(images.SHOT_DIR, 'receipt.png'), 'an explicit image extension is kept');

  const unnamed = images.materializeImage(images.rememberImage(png));
  assert.match(unnamed, /img_\d+\.png$/);
  assert.equal(images.materializeImage('img_nope'), null);
});

test('saveImage stamps a file per capture and remembers the last path', () => {
  assert.equal(images.lastSavedImage(), null);
  const file = images.saveImage(png);
  assert.match(file, /shot-\d{4}-\d{2}-\d{2}T[\d-]+Z\.png$/);
  assert.equal(readFileSync(file, 'utf8'), 'png');
  assert.equal(images.lastSavedImage(), file);
  assert.ok(images.saveImage(jpeg).endsWith('.jpg'));
});

test('prepareUploadPaths resolves readable files and refuses everything else', () => {
  const ok = join(dir, 'up.txt');
  writeFileSync(ok, 'hello');
  assert.deepEqual(images.prepareUploadPaths([ok]), [resolve(ok)]);

  assert.throws(() => images.prepareUploadPaths([join(dir, 'missing.txt')]), /No such file/);
  const sub = join(dir, 'folder');
  mkdirSync(sub);
  assert.throws(() => images.prepareUploadPaths([sub]), /Not a file/);
});

test('prepareUploadPaths caps the total at 25MB', () => {
  const big = join(dir, 'big.bin');
  writeFileSync(big, Buffer.alloc(13 * 1024 * 1024));
  assert.equal(images.prepareUploadPaths([big]).length, 1);
  assert.throws(() => images.prepareUploadPaths([big, big]), /exceeds the 25MB limit/);
});
