// Frame capture for gif_creator.
//
// Frames are quantized here rather than in the host so what crosses native
// messaging is one byte per pixel instead of four. A recording of a UI is
// mostly flat colour and text, so a fixed palette holds up well and avoids
// carrying a quantizer.

import { captureScreenshot } from './cdp.js';

// 6x6x6 colour cube plus 40 greys, which lands on 256 entries exactly.
const CUBE = [0, 51, 102, 153, 204, 255];
export const PALETTE = (() => {
  const p = [];
  for (const r of CUBE) for (const g of CUBE) for (const b of CUBE) p.push(r, g, b);
  for (let i = 0; i < 40; i++) {
    const v = Math.round((i * 255) / 39);
    p.push(v, v, v);
  }
  return p;
})();

const CUBE_INDEX = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < CUBE.length; i++) {
    const d = Math.abs(CUBE[i] - v);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  CUBE_INDEX[v] = best;
}

const MAX_FRAMES = 60;
const MAX_WIDTH = 480;

/** @type {Map<number, {frames: {indices: number[], delayMs: number}[], width: number, height: number, startedAt: number, lastAt: number}>} */
const recordings = new Map();

export function isRecording(tabId) {
  return recordings.has(tabId);
}

export function start(tabId) {
  recordings.set(tabId, { frames: [], width: 0, height: 0, startedAt: Date.now(), lastAt: Date.now() });
  return { ok: true, recording: true };
}

function quantize(imageData) {
  const { data, width, height } = imageData;
  const indices = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Near-grey pixels land in the grey ramp, which keeps text and chrome from
    // banding across the colour cube.
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min <= 12) {
      const v = (r + g + b) / 3;
      indices[p] = 216 + Math.min(39, Math.round((v / 255) * 39));
    } else {
      indices[p] = CUBE_INDEX[r] * 36 + CUBE_INDEX[g] * 6 + CUBE_INDEX[b];
    }
  }
  return indices;
}

/**
 * Grabs one frame. Called after actions while a recording is open, so the gif
 * shows the steps rather than depending on a timer the service worker cannot
 * be trusted to run.
 */
export async function captureFrame(tabId) {
  const rec = recordings.get(tabId);
  if (!rec || rec.frames.length >= MAX_FRAMES) return;

  try {
    const raw = await captureScreenshot(tabId, { format: 'png' });
    const response = await fetch('data:image/png;base64,' + raw);
    const bitmap = await createImageBitmap(await response.blob());

    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    // Every frame of a gif shares one size, so later frames are fitted to the first.
    const targetW = rec.width || width;
    const targetH = rec.height || height;

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();

    const now = Date.now();
    if (rec.frames.length) {
      rec.frames[rec.frames.length - 1].delayMs = Math.min(3000, Math.max(60, now - rec.lastAt));
    }
    rec.lastAt = now;
    rec.width = targetW;
    rec.height = targetH;
    rec.frames.push({ indices: Array.from(quantize(ctx.getImageData(0, 0, targetW, targetH))), delayMs: 400 });
  } catch {
    /* a frame that cannot be grabbed should never fail the action that triggered it */
  }
}

export function stop(tabId) {
  const rec = recordings.get(tabId);
  recordings.delete(tabId);
  if (!rec || !rec.frames.length) {
    return { error: 'no frames were recorded. Start a recording, act on the page, then stop.' };
  }
  return {
    ok: true,
    width: rec.width,
    height: rec.height,
    palette: PALETTE,
    frames: rec.frames,
    durationMs: Date.now() - rec.startedAt,
  };
}

export function discard(tabId) {
  recordings.delete(tabId);
}
