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

// S1. JPEG at 75 is what the model actually reads: a PNG of a text-heavy page is
// several times the bytes for no visible difference, and every byte crosses a
// 384KB-chunked native messaging pipe and lands in the transcript.
export const DEFAULT_FORMAT = 'jpeg';
export const DEFAULT_QUALITY = 0.75;

/** Hard ceiling on the base64 payload, in characters. About 1MB of bytes. */
export const MAX_BASE64_CHARS = 1398100;
export const QUALITY_STEP = 0.05;
export const MIN_QUALITY = 0.1;

/** Bounds on the documented `scale` argument (S3). */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 1;

/** @type {Map<number, object>} */
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

export function clampScale(scale) {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Normalizes a quality argument. The schema documents 0 to 1, which is what the
 * canvas encoder wants, and a caller writing 75 instead of 0.75 gets what it
 * meant rather than a silent clamp to the floor.
 */
export function normalizeQuality(quality, fallback = DEFAULT_QUALITY) {
  if (typeof quality !== 'number' || !Number.isFinite(quality)) return fallback;
  const value = quality > 1 ? quality / 100 : quality;
  return Math.min(1, Math.max(MIN_QUALITY, value));
}

export function normalizeFormat(format) {
  return format === 'png' ? 'png' : 'jpeg';
}

// ---------------------------------------------------------------------------
// S2. Plan the capture before taking it
// ---------------------------------------------------------------------------

/**
 * Everything about a capture that can be decided before pixels exist: the box
 * to capture in CSS pixels, the size to end up at, and whether Chrome can render
 * straight to that size through a clip.
 *
 * `unitX` and `unitY` are the capture pixels this surface returns per CSS pixel,
 * measured from a capture this tab actually produced. They fall back to `dpr`,
 * which is what the layout metrics imply and what an unmeasured tab has. The
 * two disagree: a capture taken through the extension debugger on a hidden tab
 * comes back in CSS pixels while the metrics report a ratio of 2.25, so a plan
 * sized from the metrics asked for a frame the surface could not produce and
 * every scaled capture fell back to the canvas.
 */
export function planCapture({
  cssWidth,
  cssHeight,
  dpr = 1,
  unitX,
  unitY,
  region,
  scrollX = 0,
  scrollY = 0,
  maxTokens = DEFAULT_MAX_TOKENS,
  scale = 1,
} = {}) {
  const width = Math.max(1, Math.round(cssWidth));
  const height = Math.max(1, Math.round(cssHeight));

  let box;
  if (region) {
    const [x0, y0, x1, y1] = region;
    box = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };
    if (box.width < 1 || box.height < 1) {
      throw new Error('zoom region must have non-zero width and height');
    }
  } else {
    box = { x: 0, y: 0, width, height };
  }

  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const ux = Number.isFinite(unitX) && unitX > 0 ? unitX : ratio;
  const uy = Number.isFinite(unitY) && unitY > 0 ? unitY : ratio;
  const sourceWidth = Math.max(1, Math.round(box.width * ux));
  const sourceHeight = Math.max(1, Math.round(box.height * uy));

  // The frame a capture with no `scale` would have produced. Reported with every
  // scaled capture so the caller knows what the full-resolution frame is.
  const frame = targetDimensions(sourceWidth, sourceHeight, { maxTokens });

  const userScale = clampScale(scale);
  const target = {
    width: Math.max(1, Math.round(frame.width * userScale)),
    height: Math.max(1, Math.round(frame.height * userScale)),
  };

  // Page.captureScreenshot clips in page coordinates, so a region read off a
  // screenshot, which is viewport relative, needs the scroll offset added.
  //
  // The surface renders the clip at `box * clip.scale * unit`, so the scale that
  // lands on the target is the target over the source, not over the CSS box.
  // With a unit of 1 the two are the same number, which is why the CSS-box form
  // held up until a surface with a unit of 2.25 was measured.
  const clip = {
    x: box.x + scrollX,
    y: box.y + scrollY,
    width: box.width,
    height: box.height,
    scale: target.width / sourceWidth,
  };

  return {
    box,
    clip,
    target,
    frame: { width: frame.width, height: frame.height },
    sourceWidth,
    sourceHeight,
    userScale,
    dpr: ratio,
    unitX: ux,
    unitY: uy,
    // Asking Chrome to render straight to a smaller size skips a full-size
    // capture and an OffscreenCanvas round trip. Above 1 it would upscale a CSS
    // pixel render, which is worse than downscaling the device pixel one.
    useClipPath: clip.scale < 1,
    region: Boolean(region),
  };
}

// ---------------------------------------------------------------------------
// Image header decoding, so a capture can be trusted without decoding it fully
// ---------------------------------------------------------------------------

/** Decodes a base64 prefix into bytes. The header is all this needs. */
function headBytes(base64, maxBytes = 65536) {
  const wanted = Math.ceil(maxBytes / 3) * 4;
  const chars = Math.min(base64.length, wanted);
  const slice = base64.slice(0, chars - (chars % 4));
  const binary = atob(slice);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Width and height read from a PNG or JPEG header.
 *
 * Returns null when the bytes are neither, or when a JPEG's frame header sits
 * past the decoded prefix. A null answer means the capture is not verified, and
 * the caller falls back to the path that produces a known size.
 */
export function decodeImageSize(base64) {
  if (typeof base64 !== 'string' || base64.length < 8) return null;
  let bytes;
  try {
    bytes = headBytes(base64);
  } catch {
    return null;
  }

  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      // Padding and standalone markers carry no length field.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      const isFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isFrame) {
        return {
          format: 'jpeg',
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
        };
      }
      if (length < 2) return null;
      i += 2 + length;
    }
  }

  return null;
}

function within(a, b, tolerance = 1) {
  return Math.abs(a - b) <= tolerance;
}

// ---------------------------------------------------------------------------
// Encoding and the byte budget
// ---------------------------------------------------------------------------

async function decodeBitmap(base64, mediaType = 'image/png') {
  const response = await fetch('data:' + mediaType + ';base64,' + base64);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function encode(bitmap, width, height, format, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob(
    format === 'jpeg' ? { type: 'image/jpeg', quality } : { type: 'image/png' }
  );
  const buffer = await blob.arrayBuffer();
  return toBase64(new Uint8Array(buffer));
}

/**
 * S1. Steps quality down until the payload fits the budget.
 *
 * `reencode(quality)` returns a fresh base64 payload at that quality. The loop
 * stops at MIN_QUALITY, and a payload still over budget there is returned with a
 * warning rather than failing, because a large image the caller can see beats no
 * image at all.
 */
export async function fitToBudget({
  data,
  quality = DEFAULT_QUALITY,
  format = 'jpeg',
  budget = MAX_BASE64_CHARS,
  reencode,
  warnings = [],
}) {
  if (data.length <= budget) return { data, quality, steps: 0, warnings };

  if (format !== 'jpeg' || typeof reencode !== 'function') {
    warnings.push(
      'the image is ' + data.length + ' base64 characters, over the ' + budget +
        ' budget, and a ' + format + ' payload cannot be reduced by quality. Ask for format "jpeg" or a smaller scale.'
    );
    return { data, quality, steps: 0, warnings };
  }

  let current = data;
  let q = quality;
  let steps = 0;
  while (current.length > budget && q > MIN_QUALITY + 1e-9) {
    q = Math.max(MIN_QUALITY, Math.round((q - QUALITY_STEP) * 100) / 100);
    current = await reencode(q);
    steps++;
  }
  if (current.length > budget) {
    warnings.push(
      'the image is still ' + current.length + ' base64 characters at the quality floor of ' + MIN_QUALITY +
        '. Take a smaller region with zoom, or pass a lower scale.'
    );
  }
  return { data: current, quality: q, steps, warnings };
}

// ---------------------------------------------------------------------------
// The capture itself
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The unit a capture on this tab actually returns
// ---------------------------------------------------------------------------
//
// Page.captureScreenshot does not answer in one fixed unit. Through the
// extension debugger on a hidden tab it returns CSS pixels; from a surface it
// returns device pixels. The metrics ratio describes the second and was used to
// plan both, so on a 2.25 display every scaled capture asked for a frame the
// surface could not produce, failed the size check, warned, and re-rendered
// through the canvas.
//
// So the unit is measured rather than assumed. The canvas path already decodes
// a bitmap whose size is the answer, and the clip path decodes the header of
// what came back, so both teach this without an extra capture. A tab with
// nothing measured takes the canvas path once, which is the path it took
// anyway, and every capture after that can use the clip.

/** @type {Map<number, {full?: object, region?: object}>} */
const captureUnits = new Map();

/** How far the CSS viewport can move before a measurement is stale. */
const UNIT_VIEWPORT_TOLERANCE = 2;

/**
 * Records what one capture returned per CSS pixel.
 *
 * A full-viewport measurement is tied to the viewport it was taken at, since a
 * resized window renders a different surface. A region measurement is scale
 * free by construction, so it carries over between regions.
 */
export function recordCaptureUnit(tabId, { region = false, x, y, cssWidth, cssHeight } = {}) {
  if (tabId === undefined || tabId === null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  const held = captureUnits.get(tabId) || {};
  const entry = { x, y, cssWidth, cssHeight, at: Date.now() };
  held[region ? 'region' : 'full'] = entry;
  captureUnits.set(tabId, held);
  return entry;
}

/** The measurement that applies to this capture, or null when there is none. */
export function getCaptureUnit(tabId, { region = false, cssWidth, cssHeight } = {}) {
  const held = captureUnits.get(tabId);
  const entry = held && held[region ? 'region' : 'full'];
  if (!entry) return null;
  if (region) return entry;
  if (
    Math.abs((entry.cssWidth || 0) - cssWidth) > UNIT_VIEWPORT_TOLERANCE ||
    Math.abs((entry.cssHeight || 0) - cssHeight) > UNIT_VIEWPORT_TOLERANCE
  ) {
    return null;
  }
  return entry;
}

export function clearCaptureUnit(tabId) {
  captureUnits.delete(tabId);
}

/** Device pixel ratio implied by the layout metrics, which report both units. */
export function devicePixelRatioFrom(metrics) {
  const css = metrics && metrics.cssLayoutViewport;
  const device = metrics && metrics.layoutViewport;
  if (!css || !device || !css.clientWidth || !device.clientWidth) return 1;
  const ratio = device.clientWidth / css.clientWidth;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Captures the viewport and returns an image plus the scaling context needed to
 * map model-supplied coordinates back to CSS pixels.
 */
export async function capture(tabId, options = {}) {
  const {
    maxTokens = DEFAULT_MAX_TOKENS,
    region,
    budget = MAX_BASE64_CHARS,
  } = options;
  const format = normalizeFormat(options.format ?? DEFAULT_FORMAT);
  const quality = normalizeQuality(options.quality);
  const scale = clampScale(options.scale ?? 1);

  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  const cssWidth = viewport.clientWidth;
  const cssHeight = viewport.clientHeight;
  const scrollSource = metrics.cssVisualViewport || viewport;
  const scrollX = Math.round(scrollSource.pageX || 0);
  const scrollY = Math.round(scrollSource.pageY || 0);

  const measured = getCaptureUnit(tabId, { region: Boolean(region), cssWidth, cssHeight });
  const plan = planCapture({
    cssWidth,
    cssHeight,
    dpr: devicePixelRatioFrom(metrics),
    unitX: measured ? measured.x : undefined,
    unitY: measured ? measured.y : undefined,
    region,
    scrollX,
    scrollY,
    maxTokens,
    scale,
  });

  const warnings = [];
  const scroll = { x: scrollX, y: scrollY };
  let data = null;
  let path = 'canvas';
  let width = plan.target.width;
  let height = plan.target.height;
  let sourceWidth = plan.sourceWidth;
  let sourceHeight = plan.sourceHeight;
  /** @type {null | ((q: number) => Promise<string>)} */
  let reencode = null;

  // A tab whose capture unit has never been measured takes the canvas path
  // once, which is where the measurement comes from. Guessing the unit from the
  // metrics and clipping on it is what produced a wasted capture and a warning
  // on every scaled call.
  if (plan.useClipPath && measured) {
    // Chrome renders straight to the target size, so there is no full-size
    // capture to decode and no canvas round trip.
    const raw = await captureScreenshot(tabId, {
      format,
      quality: format === 'jpeg' ? Math.round(quality * 100) : undefined,
      clip: plan.clip,
      scroll,
    });
    const decoded = decodeImageSize(raw);
    // Two pixels of slack: a hidden tab is sized through the screencast's
    // maxWidth and maxHeight, which rounds the aspect ratio its own way. A size
    // that ignored the scale altogether is off by far more than that, which is
    // what this check is for. The decoded size, not the asked size, is what the
    // coordinate context records.
    if (decoded && within(decoded.width, plan.target.width, 2) && within(decoded.height, plan.target.height, 2)) {
      data = raw;
      path = 'clip';
      width = decoded.width;
      height = decoded.height;
      sourceWidth = decoded.width;
      sourceHeight = decoded.height;
      reencode = async (q) => {
        const bitmap = await decodeBitmap(raw, 'image/' + format);
        const out = await encode(bitmap, width, height, 'jpeg', q);
        bitmap.close();
        return out;
      };
    } else {
      // What came back says what this surface really returns per CSS pixel, so
      // the measurement is corrected here and the next capture plans on it.
      if (decoded && plan.clip.scale > 0) {
        recordCaptureUnit(tabId, {
          region: plan.region,
          x: decoded.width / (plan.box.width * plan.clip.scale),
          y: decoded.height / (plan.box.height * plan.clip.scale),
          cssWidth,
          cssHeight,
        });
      }
      warnings.push(
        'the clipped capture came back ' +
          (decoded ? decoded.width + 'x' + decoded.height : 'undecodable') +
          ' instead of ' + plan.target.width + 'x' + plan.target.height + ', so it was re-rendered through the canvas'
      );
    }
  }

  if (data === null) {
    // A lossless source keeps the downscale clean, and the target is recomputed
    // from what Chrome actually returned rather than from the estimate.
    const raw = await captureScreenshot(tabId, {
      format: 'png',
      clip: plan.region ? { ...plan.clip, scale: 1 } : undefined,
      scroll,
    });
    const bitmap = await decodeBitmap(raw, 'image/png');
    sourceWidth = bitmap.width;
    sourceHeight = bitmap.height;
    // The bitmap came back at scale 1, so its size over the CSS box is the unit
    // this surface answers in. Every later capture on this tab plans from it.
    recordCaptureUnit(tabId, {
      region: plan.region,
      x: sourceWidth / plan.box.width,
      y: sourceHeight / plan.box.height,
      cssWidth,
      cssHeight,
    });
    const frame = targetDimensions(sourceWidth, sourceHeight, { maxTokens });
    plan.frame = { width: frame.width, height: frame.height };
    width = Math.max(1, Math.round(frame.width * plan.userScale));
    height = Math.max(1, Math.round(frame.height * plan.userScale));
    data = await encode(bitmap, width, height, format, quality);
    reencode = async (q) => encode(bitmap, width, height, 'jpeg', q);
    const fitted = await fitToBudget({ data, quality, format, budget, reencode, warnings });
    bitmap.close();
    data = fitted.data;
    return finish(tabId, { plan, data, format, width, height, sourceWidth, sourceHeight, cssWidth, cssHeight, path, warnings, quality: fitted.quality });
  }

  const fitted = await fitToBudget({ data, quality, format, budget, reencode, warnings });
  return finish(tabId, {
    plan,
    data: fitted.data,
    format,
    width,
    height,
    sourceWidth,
    sourceHeight,
    cssWidth,
    cssHeight,
    path,
    warnings,
    quality: fitted.quality,
  });
}

/** "0.5" rather than "0.50", for the result line. */
export function formatScale(scale) {
  return String(Math.round(scale * 100) / 100);
}

/** Records the coordinate context and shapes the result. */
function finish(tabId, info) {
  const { plan, data, format, cssWidth, cssHeight } = info;
  // The header of the payload that is actually returned, so the reported size
  // and the token estimate describe the image the model sees.
  const decoded = decodeImageSize(data);
  const width = decoded ? decoded.width : info.width;
  const height = decoded ? decoded.height : info.height;

  const context = plan.region
    ? {
        // A zoom is a crop of the viewport. The mapping carries the crop offset
        // so coordinates read off the zoomed image still resolve against the page.
        cssToImage: width / plan.box.width,
        offsetX: plan.box.x,
        offsetY: plan.box.y,
        imageWidth: width,
        imageHeight: height,
        cssWidth,
        cssHeight,
        cropped: true,
        capturedAt: Date.now(),
      }
    : {
        cssToImage: width / cssWidth,
        offsetX: 0,
        offsetY: 0,
        imageWidth: width,
        imageHeight: height,
        cssWidth,
        cssHeight,
        cropped: false,
        capturedAt: Date.now(),
      };
  recordCapture(tabId, context);

  const scaled = plan.userScale < 1;
  return {
    data,
    mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    width,
    height,
    sourceWidth: info.sourceWidth,
    sourceHeight: info.sourceHeight,
    cssWidth,
    cssHeight,
    format,
    quality: format === 'jpeg' ? info.quality : undefined,
    path: info.path,
    scale: plan.userScale,
    frameWidth: plan.frame.width,
    frameHeight: plan.frame.height,
    // S3. A scaled image is smaller than the frame the model would otherwise
    // have read, so the frame it is reading is stated with the image.
    note: scaled
      ? formatScale(plan.userScale) + '-scale view; coordinate frame: ' + width + 'x' + height +
        '. Coordinates are pixels in this image and are mapped back to the page for you. ' +
        'Full-resolution frame: ' + plan.frame.width + 'x' + plan.frame.height + '.'
      : undefined,
    estimatedTokens: estimateTokens(width, height),
    warnings: info.warnings,
  };
}

// ---------------------------------------------------------------------------
// R4. The coordinate frame is frozen for the length of a batch
// ---------------------------------------------------------------------------
//
// A batch shaped [screenshot, left_click(x, y)] carries coordinates the model
// wrote against the screenshot it had before the batch ran. Committing the new
// frame as soon as the capture returns remaps those coordinates against an image
// the model has never seen. The new frame is held aside until the batch ends.

let batchDepth = 0;
/** @type {Map<number, object>} */
const pendingContext = new Map();

export function beginBatch() {
  batchDepth += 1;
  return batchDepth;
}

export function endBatch() {
  if (batchDepth > 0) batchDepth -= 1;
  if (batchDepth === 0) commitPending();
  return batchDepth;
}

export function isBatching() {
  return batchDepth > 0;
}

export function commitPending() {
  for (const [tabId, context] of pendingContext) scalingContext.set(tabId, context);
  pendingContext.clear();
}

export function pendingContextFor(tabId) {
  return pendingContext.get(tabId) || null;
}

/**
 * Stores the frame a capture produced. Inside a batch it is held until the batch
 * ends, unless the tab has no frame at all, in which case holding it would leave
 * every later coordinate in the batch unmapped.
 */
export function recordCapture(tabId, context) {
  if (batchDepth > 0 && scalingContext.has(tabId)) pendingContext.set(tabId, context);
  else scalingContext.set(tabId, context);
}

/**
 * Maps a coordinate the model produced against the last screenshot back into
 * CSS pixels. Without a recorded capture the coordinate is assumed to already
 * be in CSS pixels, which is correct for ref-derived geometry.
 */
export function imageToCss(tabId, x, y) {
  const ctx = scalingContext.get(tabId);
  if (!ctx) return { x: Math.round(x), y: Math.round(y), mapped: false };

  // A coordinate past the edge of the image cannot have been read off it. When
  // it fits the CSS viewport it came from the full-resolution frame, so it is
  // taken as it is instead of being scaled into somewhere off screen.
  if (
    !ctx.cropped &&
    ctx.cssToImage < 1 &&
    (x > ctx.imageWidth || y > ctx.imageHeight) &&
    x <= ctx.cssWidth &&
    y <= ctx.cssHeight
  ) {
    return { x: Math.round(x), y: Math.round(y), mapped: true, frame: 'css' };
  }

  return {
    x: Math.round(x / ctx.cssToImage + (ctx.offsetX || 0)),
    y: Math.round(y / ctx.cssToImage + (ctx.offsetY || 0)),
    mapped: true,
    frame: 'image',
  };
}

export function getScalingContext(tabId) {
  return scalingContext.get(tabId) || null;
}

export function clearScalingContext(tabId) {
  scalingContext.delete(tabId);
  pendingContext.delete(tabId);
  // The measured unit is deliberately kept. It describes the surface, not the
  // document, so it survives a navigation, and a resize invalidates it through
  // the viewport it was measured at.
}

// ---------------------------------------------------------------------------
// Repaint clock (R3)
// ---------------------------------------------------------------------------
//
// A screenshot taken in the same round trip as a click showed the pre-click
// frame: on TodoMVC a script that typed a todo, pressed Enter and ended with a
// capture returned an empty field and no list, while a separate read a moment
// later showed the todo present. An output that contradicts what happened is
// worse than one that fails, because the caller acts on it.
//
// The capture cannot tell whether it is inside a batch, and it does not need
// to. Every mutating action stamps its tab here, and a capture that finds a
// recent stamp waits for a paint that postdates it. A capture on a tab nothing
// has touched waits for nothing.

/** @type {Map<number, number>} */
const lastInput = new Map();

/** How long after an input a capture still waits for the paint that follows it. */
export const PAINT_WAIT_WINDOW_MS = 2000;

/** Ceiling on the wait, so a page that never paints costs a fixed amount. */
export const PAINT_CEILING_MS = 300;

export function noteInput(tabId, at = Date.now()) {
  if (tabId === undefined || tabId === null) return;
  lastInput.set(tabId, at);
}

export function lastInputAt(tabId) {
  return lastInput.get(tabId) || 0;
}

export function clearInputMark(tabId) {
  lastInput.delete(tabId);
}

/** True when a capture on this tab should wait for a paint before reading pixels. */
export function needsPaintWait(tabId, now = Date.now()) {
  const at = lastInput.get(tabId);
  return Boolean(at) && now - at < PAINT_WAIT_WINDOW_MS;
}
