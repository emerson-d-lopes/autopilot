// Screenshot capture, downscaling, and coordinate mapping.
//
// Claude's vision pipeline downscales anything wider than 1568px server-side and
// bills roughly one token per 28x28 pixel block, so capturing above that budget
// pays twice and uses once. Downscaling here also shrinks the base64 payload
// crossing native messaging, which has a 1MB per-message cap Chrome enforces.

import { captureScreenshot, send } from './cdp.js';

export const PX_PER_TOKEN = 28;
export const MAX_TARGET_PX = 1568;

// Capping the long edge alone is not enough: a tall viewport stays under 1568px
// wide and still costs ~2800 tokens per capture. This bounds the area too, so a
// screenshot costs about the same whatever shape the window is.
export const DEFAULT_MAX_TOKENS = 1600;

/** @type {Map<number, {cssToImage: number, imageWidth: number, imageHeight: number, cssWidth: number, cssHeight: number, capturedAt: number}>} */
const scalingContext = new Map();

export function estimateTokens(width, height) {
  return Math.ceil((width * height) / (PX_PER_TOKEN * PX_PER_TOKEN));
}

/**
 * Target dimensions for a capture.
 * Caps the long edge at MAX_TARGET_PX and, when maxTokens is given, caps total
 * area at maxTokens * PX_PER_TOKEN^2.
 */
export function targetDimensions(width, height, { maxTokens } = {}) {
  let scale = 1;
  const longEdge = Math.max(width, height);
  if (longEdge > MAX_TARGET_PX) scale = MAX_TARGET_PX / longEdge;

  if (maxTokens) {
    const budgetArea = maxTokens * PX_PER_TOKEN * PX_PER_TOKEN;
    const scaledArea = width * scale * (height * scale);
    if (scaledArea > budgetArea) scale *= Math.sqrt(budgetArea / scaledArea);
  }

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

async function decode(base64) {
  const response = await fetch('data:image/png;base64,' + base64);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

async function encode(bitmap, width, height, format, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob(
    format === 'jpeg' ? { type: 'image/jpeg', quality: quality ?? 0.85 } : { type: 'image/png' }
  );
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { data: btoa(binary), mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
}

/**
 * Captures the viewport and returns a downscaled image plus the scaling context
 * needed to map model-supplied coordinates back to CSS pixels.
 */
export async function capture(tabId, options = {}) {
  const { maxTokens = DEFAULT_MAX_TOKENS, format = 'png', quality, region } = options;

  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  const cssWidth = viewport.clientWidth;
  const cssHeight = viewport.clientHeight;

  let clip;
  if (region) {
    const [x0, y0, x1, y1] = region;
    clip = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      scale: 1,
    };
    if (clip.width < 1 || clip.height < 1) {
      throw new Error('zoom region must have non-zero width and height');
    }
  }

  const raw = await captureScreenshot(tabId, { format: 'png', clip });
  const bitmap = await decode(raw);

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const target = targetDimensions(sourceWidth, sourceHeight, { maxTokens });

  const encoded = await encode(bitmap, target.width, target.height, format, quality);
  bitmap.close();

  if (region) {
    // A zoom is a crop of the viewport. Record the mapping so coordinates read
    // off the zoomed image still resolve against the full page.
    scalingContext.set(tabId, {
      cssToImage: target.width / clip.width,
      offsetX: clip.x,
      offsetY: clip.y,
      imageWidth: target.width,
      imageHeight: target.height,
      cssWidth,
      cssHeight,
      cropped: true,
      capturedAt: Date.now(),
    });
  } else {
    scalingContext.set(tabId, {
      cssToImage: target.width / cssWidth,
      offsetX: 0,
      offsetY: 0,
      imageWidth: target.width,
      imageHeight: target.height,
      cssWidth,
      cssHeight,
      cropped: false,
      capturedAt: Date.now(),
    });
  }

  return {
    ...encoded,
    width: target.width,
    height: target.height,
    sourceWidth,
    sourceHeight,
    cssWidth,
    cssHeight,
    estimatedTokens: estimateTokens(target.width, target.height),
  };
}

/**
 * Maps a coordinate the model produced against the last screenshot back into
 * CSS pixels. Without a recorded capture the coordinate is assumed to already
 * be in CSS pixels, which is correct for ref-derived geometry.
 */
export function imageToCss(tabId, x, y) {
  const ctx = scalingContext.get(tabId);
  if (!ctx) return { x: Math.round(x), y: Math.round(y), mapped: false };
  return {
    x: Math.round(x / ctx.cssToImage + (ctx.offsetX || 0)),
    y: Math.round(y / ctx.cssToImage + (ctx.offsetY || 0)),
    mapped: true,
  };
}

export function getScalingContext(tabId) {
  return scalingContext.get(tabId) || null;
}

export function clearScalingContext(tabId) {
  scalingContext.delete(tabId);
}
