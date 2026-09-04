// Frame capture for gif_creator.
//
// Frames are quantized here rather than in the host so what crosses native
// messaging is one byte per pixel instead of four. A recording of a UI is
// mostly flat colour and text, so a fixed palette holds up well and avoids
// carrying a quantizer.

import { captureScreenshot, getLayoutMetrics } from './cdp.js';

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

// ---------------------------------------------------------------------------
// P1. Overlays
//
// Drawn into the frame before quantization so they ride along in the palette
// like anything else on the page, scaled by canvas.width / viewportWidth so a
// click at CSS coordinates lands on the same pixel the recording shows it at,
// whatever MAX_WIDTH downscaled the capture to.
// ---------------------------------------------------------------------------

/** Per-action frame delay, copied from the official extension's Nc() table. */
export const ACTION_DELAYS = {
  wait: 300,
  screenshot: 300,
  navigate: 800,
  scroll: 800,
  scroll_to: 800,
  type: 800,
  key: 800,
  zoom: 800,
  left_click: 1500,
  right_click: 1500,
  double_click: 1500,
  triple_click: 1500,
  left_click_drag: 1500,
};
export const DEFAULT_ACTION_DELAY = 800;
/** Extra delay folded into the final frame so the result is readable when it stops looping. */
export const LAST_FRAME_BONUS_MS = 2000;
/** Delay given to the retroactive click/drag marker frame (P1). */
const MARKER_FRAME_DELAY_MS = 500;

export function delayForAction(action) {
  if (!action) return 400;
  return ACTION_DELAYS[action] ?? DEFAULT_ACTION_DELAY;
}

const CLICK_ACTIONS = new Set(['left_click', 'right_click', 'double_click', 'triple_click']);
const DRAG_ACTIONS = new Set(['left_click_drag']);

export function isClickAction(action) {
  return CLICK_ACTIONS.has(action);
}

export function isDragAction(action) {
  return DRAG_ACTIONS.has(action);
}

/** canvas.width / viewportWidth (P1). 1 when the viewport width is unknown. */
export function scaleFactor(canvasWidth, viewportWidth) {
  if (!viewportWidth) return 1;
  return canvasWidth / viewportWidth;
}

const DEFAULT_OVERLAY_OPTIONS = {
  showClickIndicators: true,
  showDragPaths: true,
  showActionLabels: true,
  showProgressBar: true,
  showWatermark: true,
  // Unused by this encoder (there is no variable-quality palette step), kept
  // so a caller passing the schema's `quality` field is not rejected.
  quality: 10,
};

export function resolveOverlayOptions(options) {
  return { ...DEFAULT_OVERLAY_OPTIONS, ...(options || {}) };
}

/** A ring at the mapped click coordinate. */
export function drawClickRing(ctx, x, y, scale = 1) {
  const cx = x * scale;
  const cy = y * scale;
  const r = Math.max(6, 14 * scale);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.strokeStyle = '#dc2626';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(220,38,38,0.35)';
  ctx.fill();
  ctx.restore();
  return { x: cx, y: cy, r };
}

/** A line from the drag's start to its end, with a start dot and an end ring. */
export function drawDragPath(ctx, from, to, scale = 1) {
  const x1 = from.x * scale;
  const y1 = from.y * scale;
  const x2 = to.x * scale;
  const y2 = to.y * scale;
  ctx.save();
  ctx.strokeStyle = '#cf6b3c';
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x1, y1, Math.max(3, 5 * scale), 0, Math.PI * 2);
  ctx.fillStyle = '#cf6b3c';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x2, y2, Math.max(4, 7 * scale), 0, Math.PI * 2);
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = Math.max(2, 2 * scale);
  ctx.stroke();
  ctx.restore();
  return { x1, y1, x2, y2 };
}

/** A rounded-looking black pill naming the action, flipped off the right edge. */
export function drawActionLabel(ctx, { action, x = 10, y = 10, canvasWidth }) {
  if (!action) return null;
  const text = String(action);
  const paddingX = 8;
  const height = 18;
  // No real text metrics without a live canvas, so width is estimated from
  // character count. Good enough for a label pill that only has to avoid
  // running off the edge, not lay out to the pixel.
  const width = Math.round(text.length * 6.5 + paddingX * 2);
  let left = x;
  if (canvasWidth && left + width > canvasWidth - 4) left = Math.max(4, canvasWidth - width - 4);
  const top = Math.max(4, y);

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + paddingX, top + height / 2);
  ctx.restore();
  return { left, top, width, height, text };
}

/** A 4px bar along the bottom edge, filled to the recording's progress toward the frame cap. */
export function drawProgressBar(ctx, frameIndex, totalFrames, canvasWidth, canvasHeight) {
  const barHeight = 4;
  const top = canvasHeight - barHeight;
  const ratio = totalFrames > 0 ? Math.max(0, Math.min(1, (frameIndex + 1) / totalFrames)) : 0;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, top, canvasWidth, barHeight);
  ctx.fillStyle = '#c96442';
  ctx.fillRect(0, top, Math.round(canvasWidth * ratio), barHeight);
  ctx.restore();
  return { ratio, top, barHeight };
}

/** A small translucent text mark, bottom right, so a shared gif is traceable to its source. */
export function drawWatermark(ctx, canvasWidth, canvasHeight, text = 'chrome-mcp') {
  ctx.save();
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, canvasWidth - 6, canvasHeight - 8);
  ctx.restore();
  return { text };
}

/**
 * Draws whichever overlays are enabled onto one frame's context.
 *
 * `click` and `drag` gate the pointer marker separately from the label,
 * progress bar and watermark, so the retroactive marker frame (P1) can carry
 * only the pointer mark and the "after" frame can carry the rest without
 * double-drawing either.
 */
export function applyOverlays(ctx, params) {
  const {
    action,
    point,
    from,
    to,
    canvasWidth,
    canvasHeight,
    viewportWidth,
    frameIndex = 0,
    totalFrames = MAX_FRAMES,
    options,
    click = true,
    drag = true,
    label = true,
    progress = true,
    watermark = true,
  } = params;

  const opts = resolveOverlayOptions(options);
  const scale = scaleFactor(canvasWidth, viewportWidth);
  const drawn = {};

  if (drag && opts.showDragPaths && isDragAction(action) && from && to) {
    drawn.dragPath = drawDragPath(ctx, from, to, scale);
  } else if (click && opts.showClickIndicators && isClickAction(action) && point) {
    drawn.clickRing = drawClickRing(ctx, point.x, point.y, scale);
  }
  if (label && opts.showActionLabels && action) {
    drawn.label = drawActionLabel(ctx, { action, canvasWidth });
  }
  if (progress && opts.showProgressBar) {
    drawn.progress = drawProgressBar(ctx, frameIndex, totalFrames, canvasWidth, canvasHeight);
  }
  if (watermark && opts.showWatermark) {
    drawn.watermark = drawWatermark(ctx, canvasWidth, canvasHeight);
  }
  return drawn;
}

// ---------------------------------------------------------------------------
// Recording state
// ---------------------------------------------------------------------------

/** @type {Map<number, {frames: {indices: number[], delayMs: number, timestamp: number, marker?: boolean}[], width: number, height: number, startedAt: number, lastAt: number, options: object}>} */
const recordings = new Map();

export function isRecording(tabId) {
  return recordings.has(tabId);
}

export function start(tabId, options) {
  recordings.set(tabId, {
    frames: [],
    width: 0,
    height: 0,
    startedAt: Date.now(),
    lastAt: Date.now(),
    options: resolveOverlayOptions(options),
  });
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

/** Rebuilds an RGBA ImageData from a previously quantized frame, for the retroactive marker frame. */
function paintIndexed(ctx, indices, width, height) {
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  for (let i = 0, p = 0; p < indices.length; p++, i += 4) {
    const idx = indices[p] * 3;
    data[i] = PALETTE[idx];
    data[i + 1] = PALETTE[idx + 1];
    data[i + 2] = PALETTE[idx + 2];
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Grabs one frame. Called after actions while a recording is open, so the gif
 * shows the steps rather than depending on a timer the service worker cannot
 * be trusted to run.
 *
 * @param {number} tabId
 * @param {{action?: string, point?: {x:number,y:number}, from?: {x:number,y:number}, to?: {x:number,y:number}}} [meta]
 *   The action that triggered this frame, for the delay table, the action
 *   label, and the click/drag marker (P1).
 */
/**
 * Hides the extension's own overlay, takes the capture, and puts it back.
 *
 * Every frame carried the acting indicator: the pulsing border, the Stop button
 * in the bottom right and the pill at the bottom centre, with the watermark
 * lost under the Stop button. That is browser chrome rather than the page, and
 * the tool's own description tells the caller to review a recording before
 * sharing it, so the frames have to show the page.
 *
 * The same HIDE_FOR_TOOL_USE the screenshot path sends, and the restore runs
 * whatever the capture did, so a failed frame never leaves a tab with its
 * indicator hidden.
 */
export async function withOverlayHidden(tabId, capture) {
  const tell = (type) => {
    try {
      const sent = chrome.tabs.sendMessage(tabId, { type });
      if (sent && typeof sent.catch === 'function') return sent.catch(() => {});
      return Promise.resolve(sent);
    } catch {
      return Promise.resolve();
    }
  };
  await tell('HIDE_FOR_TOOL_USE');
  try {
    return await capture();
  } finally {
    tell('SHOW_AFTER_TOOL_USE');
  }
}

export async function captureFrame(tabId, meta = {}) {
  const rec = recordings.get(tabId);
  if (!rec || rec.frames.length >= MAX_FRAMES) return;
  const { action, point, from, to } = meta;

  try {
    const raw = await withOverlayHidden(tabId, () => captureScreenshot(tabId, { format: 'png' }));
    const response = await fetch('data:image/png;base64,' + raw);
    const bitmap = await createImageBitmap(await response.blob());

    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    // Every frame of a gif shares one size, so later frames are fitted to the first.
    const targetW = rec.width || width;
    const targetH = rec.height || height;

    // The overlay scale needs the CSS viewport width, which is a different
    // number from the capture's own pixel width once device pixel ratio comes
    // in. A fresh read rather than trusting a cached one, because the tab can
    // have resized since the last frame.
    let viewportWidth = 0;
    try {
      const metrics = await getLayoutMetrics(tabId);
      const vp = metrics.cssLayoutViewport || metrics.layoutViewport;
      if (vp) viewportWidth = vp.clientWidth;
    } catch {
      /* overlays fall back to an unscaled 1:1 mark rather than failing the frame */
    }

    // Retroactive click/drag frame (P1): re-emit the frame already captured,
    // now carrying the pointer marker, before the frame that shows the effect
    // of the action. Only possible once there is a previous frame to re-emit.
    if (rec.frames.length && (isClickAction(action) || isDragAction(action)) && (point || (from && to))) {
      const prevFrame = rec.frames[rec.frames.length - 1];
      const markCanvas = new OffscreenCanvas(targetW, targetH);
      const markCtx = markCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
      paintIndexed(markCtx, prevFrame.indices, targetW, targetH);
      applyOverlays(markCtx, {
        action,
        point,
        from,
        to,
        canvasWidth: targetW,
        canvasHeight: targetH,
        viewportWidth,
        options: rec.options,
        label: false,
        progress: false,
        watermark: false,
      });
      rec.frames.push({
        indices: Array.from(quantize(markCtx.getImageData(0, 0, targetW, targetH))),
        delayMs: MARKER_FRAME_DELAY_MS,
        // A hair after the frame it duplicates, so ordering and the P2 elapsed
        // time both stay sane without this marker eating real recording time.
        timestamp: prevFrame.timestamp + 1,
        marker: true,
      });
    }

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();

    applyOverlays(ctx, {
      action,
      canvasWidth: targetW,
      canvasHeight: targetH,
      viewportWidth,
      frameIndex: rec.frames.length,
      totalFrames: MAX_FRAMES,
      options: rec.options,
      // The pointer mark already landed on the retroactive frame above; this
      // frame gets the label, progress bar and watermark only.
      click: false,
      drag: false,
    });

    const now = Date.now();
    rec.lastAt = now;
    rec.width = targetW;
    rec.height = targetH;
    // The timestamp rides along on the frame so stop() can report how long the
    // recording actually spanned rather than how long the stop() call took to
    // run after start(), which is a different and much smaller number.
    rec.frames.push({
      indices: Array.from(quantize(ctx.getImageData(0, 0, targetW, targetH))),
      delayMs: delayForAction(action),
      timestamp: now,
    });
  } catch {
    /* a frame that cannot be grabbed should never fail the action that triggered it */
  }
}

/**
 * P2: the real span of the recording is what the first and last frame
 * timestamps say, not Date.now() at the moment stop() happens to run, which
 * reported a constant "0.0s" because start() takes its own first frame and
 * stop() takes its last, so the interesting time already lives on the frames.
 * Exported standalone so it is testable without a live capture pipeline.
 */
export function durationFromFrames(frames, fallbackFirst, fallbackLast) {
  if (!frames || !frames.length) return 0;
  const first = frames[0].timestamp ?? fallbackFirst;
  const last = frames[frames.length - 1].timestamp ?? fallbackLast;
  return Math.max(0, last - first);
}

export function stop(tabId) {
  const rec = recordings.get(tabId);
  recordings.delete(tabId);
  if (!rec || !rec.frames.length) {
    return { error: 'no frames were recorded. Start a recording, act on the page, then stop.' };
  }
  // Not `durationMs`: runTool stamps that field with how long the stop call
  // itself took, so a recording reported its own stop latency, about 0.8s,
  // whatever it had actually spanned.
  const recordedMs = durationFromFrames(rec.frames, rec.startedAt, rec.lastAt);

  // The last frame gets extra time on screen so a viewer can read the final
  // state before the gif loops back to the start.
  const lastFrame = rec.frames[rec.frames.length - 1];
  lastFrame.delayMs = (lastFrame.delayMs || 400) + LAST_FRAME_BONUS_MS;

  return {
    ok: true,
    width: rec.width,
    height: rec.height,
    palette: PALETTE,
    frames: rec.frames,
    recordedMs,
  };
}

export function discard(tabId) {
  recordings.delete(tabId);
}

/**
 * Test-only seam: captureFrame is the sole writer of `recordings` and it
 * needs a real CDP session and OffscreenCanvas, neither available under
 * node --test, so this lets a test build a recording with known frame
 * timestamps and drive stop()/discard() against it directly.
 */
export function __setRecordingForTest(tabId, rec) {
  recordings.set(tabId, rec);
}
