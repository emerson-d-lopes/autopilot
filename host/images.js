// Screenshots this server wrote or remembered, and the upload path checks.
//
// The extension cannot touch the filesystem, so every image that reaches disk
// goes through here: screenshots saved on request, screenshots remembered by
// id so upload_image can attach one later, and the paths a caller hands to
// file_upload, checked before they reach the browser.

import { statSync, accessSync, constants, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { envVar } from './env.js';

export const SHOT_DIR = envVar('SCREENSHOT_DIR') || joinPath(tmpdir(), 'autopilot-screenshots');

let lastImagePath = null;

// Screenshots taken in this session, by id, so upload_image can attach one the
// way Claude in Chrome does with imageId. Bounded so a long session does not
// hold every capture in memory.
const capturedImages = new Map();
let imageSeq = 0;

export function rememberImage(image) {
  const id = 'img_' + ++imageSeq;
  capturedImages.set(id, image);
  while (capturedImages.size > 20) capturedImages.delete(capturedImages.keys().next().value);
  return id;
}

/** Ids of the screenshots still remembered, oldest first. */
export function capturedImageIds() {
  return [...capturedImages.keys()];
}

/**
 * Normalizes a filename the page will see (P11). The official extension
 * refuses a name carrying a directory and caps it at 255 chars, the ext4/NTFS
 * filename ceiling; Autopilot takes real filesystem paths for file_upload, so
 * the only place a caller hands over a free-form name is upload_image's
 * `filename` argument, which is what this guards.
 */
export function normalizeUploadFilename(name, fallback) {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  if (/[\\/]/.test(raw)) {
    throw new Error('filename ' + JSON.stringify(raw) + ' must not contain a path separator');
  }
  if (raw.length <= 255) return raw;
  const dot = raw.lastIndexOf('.');
  // Only treat it as an extension when it is short, so a name with no real
  // extension is not truncated at some unrelated dot near the end.
  const ext = dot > 0 && raw.length - dot <= 10 ? raw.slice(dot) : '';
  return raw.slice(0, 255 - ext.length) + ext;
}

/** Writes a remembered screenshot to disk under the name the page should see. */
export function materializeImage(id, filename) {
  const image = capturedImages.get(id);
  if (!image) return null;
  mkdirSync(SHOT_DIR, { recursive: true });
  const ext = image.mediaType === 'image/jpeg' ? '.jpg' : '.png';
  const base = normalizeUploadFilename(filename, id + ext).replace(/[:*?"<>|]/g, '_');
  const file = joinPath(SHOT_DIR, /\.(png|jpe?g)$/i.test(base) ? base : base + ext);
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  return file;
}

/** Path of the most recent screenshot this server wrote, for upload_image "last". */
export function lastSavedImage() {
  return lastImagePath;
}

/** Writes a captured image to disk and returns its path. */
export function saveImage(image) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = joinPath(SHOT_DIR, 'shot-' + stamp + (image.mediaType === 'image/jpeg' ? '.jpg' : '.png'));
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  lastImagePath = file;
  return file;
}

/** Resolves and checks upload paths before they reach the browser. */
export function prepareUploadPaths(paths) {
  const MAX_TOTAL = 25 * 1024 * 1024;
  let total = 0;
  const resolved = [];

  for (const raw of paths) {
    const full = resolvePath(String(raw));
    let stat;
    try {
      stat = statSync(full);
    } catch {
      throw new Error('No such file: ' + full);
    }
    if (!stat.isFile()) throw new Error('Not a file: ' + full);
    try {
      accessSync(full, constants.R_OK);
    } catch {
      throw new Error('File is not readable: ' + full);
    }
    total += stat.size;
    if (total > MAX_TOTAL) {
      throw new Error('Upload exceeds the ' + MAX_TOTAL / (1024 * 1024) + 'MB limit.');
    }
    resolved.push(full);
  }
  return resolved;
}
