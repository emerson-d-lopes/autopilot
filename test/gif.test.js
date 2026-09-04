// GIF overlay drawing, the per-action delay table, and elapsed time (P1, P2).
//
// The recording pipeline itself (captureFrame) talks to CDP and a real
// OffscreenCanvas, neither available under node --test, so these exercise the
// pure pieces directly: the delay table, and the overlay functions against a
// small stub standing in for a 2D canvas context.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

// gif.js imports cdp.js, which touches the chrome global at module init
// (installDialogListener runs on import), so the stub has to be in place
// before the dynamic import below.
installChromeStub();

const {
  ACTION_DELAYS,
  DEFAULT_ACTION_DELAY,
  LAST_FRAME_BONUS_MS,
  delayForAction,
  isClickAction,
  isDragAction,
  scaleFactor,
  drawClickRing,
  drawDragPath,
  drawActionLabel,
  drawProgressBar,
  drawWatermark,
  applyOverlays,
  resolveOverlayOptions,
  durationFromFrames,
  stop,
  discard,
  __setRecordingForTest,
  PALETTE,
} = await import('../extension/src/lib/gif.js');

/** Records every method call and property set made against it, so a test can assert on shape rather than pixels. */
function makeCtxStub() {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return (...args) => {
          calls.push([prop, ...args]);
        };
      },
      set(_target, prop, value) {
        calls.push(['set:' + String(prop), value]);
        return true;
      },
    }
  );
  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// P1. Per-action delay table
// ---------------------------------------------------------------------------

test('the delay table matches the official per-action figures', () => {
  assert.equal(delayForAction('wait'), 300);
  assert.equal(delayForAction('screenshot'), 300);
  assert.equal(delayForAction('navigate'), 800);
  assert.equal(delayForAction('scroll'), 800);
  assert.equal(delayForAction('scroll_to'), 800);
  assert.equal(delayForAction('type'), 800);
  assert.equal(delayForAction('key'), 800);
  assert.equal(delayForAction('zoom'), 800);
  assert.equal(delayForAction('left_click'), 1500);
  assert.equal(delayForAction('right_click'), 1500);
  assert.equal(delayForAction('double_click'), 1500);
  assert.equal(delayForAction('triple_click'), 1500);
  assert.equal(delayForAction('left_click_drag'), 1500);
});

test('an unrecognised action falls back to the default delay', () => {
  assert.equal(delayForAction('some_future_action'), DEFAULT_ACTION_DELAY);
  assert.equal(DEFAULT_ACTION_DELAY, 800);
});

test('every entry in the table is accounted for', () => {
  assert.deepEqual(Object.keys(ACTION_DELAYS).sort(), [
    'double_click', 'key', 'left_click', 'left_click_drag', 'navigate',
    'right_click', 'scroll', 'scroll_to', 'screenshot', 'triple_click',
    'type', 'wait', 'zoom',
  ].sort());
});

test('click and drag actions are classified for the retroactive marker frame', () => {
  assert.equal(isClickAction('left_click'), true);
  assert.equal(isClickAction('right_click'), true);
  assert.equal(isClickAction('double_click'), true);
  assert.equal(isClickAction('triple_click'), true);
  assert.equal(isClickAction('left_click_drag'), false);
  assert.equal(isDragAction('left_click_drag'), true);
  assert.equal(isDragAction('left_click'), false);
  assert.equal(isClickAction('type'), false);
});

// ---------------------------------------------------------------------------
// P1. Scale factor: canvas.width / viewportWidth
// ---------------------------------------------------------------------------

test('scaleFactor maps a click at CSS coordinates onto a downscaled canvas', () => {
  assert.equal(scaleFactor(480, 1600), 0.3);
  assert.equal(scaleFactor(1600, 1600), 1);
});

test('scaleFactor is 1 when the viewport width is unknown', () => {
  assert.equal(scaleFactor(480, 0), 1);
  assert.equal(scaleFactor(480, undefined), 1);
});

// ---------------------------------------------------------------------------
// P1. Overlay drawing
// ---------------------------------------------------------------------------

test('a click ring is drawn at the scaled coordinate', () => {
  const { ctx, calls } = makeCtxStub();
  const ring = drawClickRing(ctx, 100, 200, 0.5);
  assert.equal(ring.x, 50);
  assert.equal(ring.y, 100);
  assert.ok(calls.some((c) => c[0] === 'arc' && c[1] === 50 && c[2] === 100), 'the ring is centred on the scaled point');
  assert.ok(calls.some((c) => c[0] === 'stroke'), 'the ring is stroked');
});

test('a drag path connects the scaled start and end points', () => {
  const { ctx, calls } = makeCtxStub();
  const path = drawDragPath(ctx, { x: 10, y: 10 }, { x: 110, y: 10 }, 1);
  assert.equal(path.x1, 10);
  assert.equal(path.x2, 110);
  assert.ok(calls.some((c) => c[0] === 'moveTo' && c[1] === 10 && c[2] === 10));
  assert.ok(calls.some((c) => c[0] === 'lineTo' && c[1] === 110 && c[2] === 10));
  // Start and end each get their own marker, distinct from the line itself.
  const arcs = calls.filter((c) => c[0] === 'arc');
  assert.equal(arcs.length, 2, 'a start dot and an end ring');
});

test('the action label carries the action name and stays inside the canvas', () => {
  const { ctx, calls } = makeCtxStub();
  const label = drawActionLabel(ctx, { action: 'left_click', x: 10, y: 10, canvasWidth: 480 });
  assert.equal(label.text, 'left_click');
  assert.ok(calls.some((c) => c[0] === 'fillText' && c[1] === 'left_click'));
});

test('the action label flips off the right edge rather than running past it', () => {
  const label = drawActionLabel(makeCtxStub().ctx, { action: 'double_click', x: 470, y: 10, canvasWidth: 480 });
  assert.ok(label.left + label.width <= 480 - 4 + 1, 'the pill was pulled back inside the canvas');
});

test('drawActionLabel does nothing for an empty action', () => {
  assert.equal(drawActionLabel(makeCtxStub().ctx, { action: '', canvasWidth: 480 }), null);
});

test('the progress bar fills to the recording\'s share of the frame cap', () => {
  const { ctx, calls } = makeCtxStub();
  const bar = drawProgressBar(ctx, 9, 10, 480, 270);
  assert.equal(bar.ratio, 1);
  const fills = calls.filter((c) => c[0] === 'fillRect');
  assert.equal(fills.length, 2, 'a track and a fill');
  assert.equal(fills[1][3], 480, 'a full bar spans the whole width');
});

test('the progress bar is partial mid-recording', () => {
  const bar = drawProgressBar(makeCtxStub().ctx, 4, 10, 480, 270);
  assert.equal(bar.ratio, 0.5);
});

test('the watermark is drawn bottom right', () => {
  const { ctx, calls } = makeCtxStub();
  drawWatermark(ctx, 480, 270);
  const text = calls.find((c) => c[0] === 'fillText');
  assert.ok(text);
  assert.equal(text[1], 'chrome-mcp');
  assert.ok(text[2] < 480, 'x sits inside the canvas');
  assert.ok(text[3] < 270, 'y sits inside the canvas');
});

// ---------------------------------------------------------------------------
// P1. applyOverlays: options gate each layer independently
// ---------------------------------------------------------------------------

test('applyOverlays draws a click ring for a click action with a point', () => {
  const { ctx, calls } = makeCtxStub();
  const drawn = applyOverlays(ctx, {
    action: 'left_click',
    point: { x: 40, y: 40 },
    canvasWidth: 480,
    canvasHeight: 270,
    viewportWidth: 480,
  });
  assert.ok(drawn.clickRing);
  assert.equal(drawn.dragPath, undefined);
  assert.ok(calls.some((c) => c[0] === 'arc'));
});

test('applyOverlays draws a drag path instead of a click ring for a drag', () => {
  const drawn = applyOverlays(makeCtxStub().ctx, {
    action: 'left_click_drag',
    from: { x: 10, y: 10 },
    to: { x: 100, y: 10 },
    canvasWidth: 480,
    canvasHeight: 270,
    viewportWidth: 480,
  });
  assert.ok(drawn.dragPath);
  assert.equal(drawn.clickRing, undefined);
});

test('applyOverlays draws nothing for a non-pointer action beyond the label, bar and watermark', () => {
  const drawn = applyOverlays(makeCtxStub().ctx, {
    action: 'type',
    canvasWidth: 480,
    canvasHeight: 270,
    viewportWidth: 480,
  });
  assert.equal(drawn.clickRing, undefined);
  assert.equal(drawn.dragPath, undefined);
  assert.ok(drawn.label);
  assert.ok(drawn.progress);
  assert.ok(drawn.watermark);
});

test('each overlay can be switched off independently through options', () => {
  const drawn = applyOverlays(makeCtxStub().ctx, {
    action: 'left_click',
    point: { x: 1, y: 1 },
    canvasWidth: 480,
    canvasHeight: 270,
    viewportWidth: 480,
    options: {
      showClickIndicators: false,
      showActionLabels: false,
      showProgressBar: false,
      showWatermark: false,
    },
  });
  assert.deepEqual(drawn, {});
});

test('resolveOverlayOptions defaults every flag to true', () => {
  const opts = resolveOverlayOptions();
  assert.equal(opts.showClickIndicators, true);
  assert.equal(opts.showDragPaths, true);
  assert.equal(opts.showActionLabels, true);
  assert.equal(opts.showProgressBar, true);
  assert.equal(opts.showWatermark, true);
});

test('resolveOverlayOptions only overrides the flags given', () => {
  const opts = resolveOverlayOptions({ showWatermark: false });
  assert.equal(opts.showWatermark, false);
  assert.equal(opts.showClickIndicators, true);
});

// ---------------------------------------------------------------------------
// P2. Elapsed time and the last-frame bonus
// ---------------------------------------------------------------------------

test('durationFromFrames reads the span between the first and last frame timestamp', () => {
  const frames = [{ timestamp: 1000 }, { timestamp: 1400 }, { timestamp: 16200 }];
  assert.equal(durationFromFrames(frames, 0, 0), 15200);
});

test('durationFromFrames is not the constant the bug reported: two different recordings give two different durations', () => {
  const short = durationFromFrames([{ timestamp: 5000 }, { timestamp: 5300 }], 0, 0);
  const long = durationFromFrames([{ timestamp: 5000 }, { timestamp: 20300 }], 0, 0);
  assert.equal(short, 300);
  assert.equal(long, 15300);
  assert.notEqual(short, long);
});

test('durationFromFrames falls back to the recording bounds when a frame carries no timestamp', () => {
  assert.equal(durationFromFrames([{}, {}], 1000, 4000), 3000);
});

test('durationFromFrames never goes negative', () => {
  assert.equal(durationFromFrames([{ timestamp: 500 }, { timestamp: 100 }], 0, 0), 0);
});

test('durationFromFrames is 0 for an empty or missing frame list', () => {
  assert.equal(durationFromFrames([], 0, 0), 0);
  assert.equal(durationFromFrames(null, 0, 0), 0);
});

test('stop() reports the real elapsed time from frame timestamps, and applies the last-frame bonus to delayMs only', () => {
  __setRecordingForTest(901, {
    frames: [
      { indices: [0], delayMs: 1500, timestamp: 2000 },
      { indices: [0], delayMs: 800, timestamp: 4500 },
      { indices: [0], delayMs: 1500, timestamp: 17300 },
    ],
    width: 4,
    height: 4,
    startedAt: 2000,
    lastAt: 17300,
    options: resolveOverlayOptions(),
  });

  const result = stop(901);
  assert.equal(result.ok, true);
  assert.equal(result.recordedMs, 15300, 'a 15.3s recording reports 15.3s, not a constant');
  // The field a recording reports its span in has to be one runTool does not
  // already own. `durationMs` is stamped with the stop call's own latency, so
  // a recording that used it reported about 0.8s whatever it had spanned.
  assert.equal(result.durationMs, undefined, 'stop() must not answer in the field runTool overwrites');
  assert.equal(result.frames[result.frames.length - 1].delayMs, 1500 + LAST_FRAME_BONUS_MS);
  // The earlier frames' delayMs are untouched by the bonus.
  assert.equal(result.frames[0].delayMs, 1500);
});

test('stop() forgets the recording once read, the same as before', () => {
  __setRecordingForTest(902, {
    frames: [{ indices: [0], delayMs: 400, timestamp: 1 }],
    width: 1,
    height: 1,
    startedAt: 1,
    lastAt: 1,
    options: resolveOverlayOptions(),
  });
  stop(902);
  const second = stop(902);
  assert.ok(second.error, 'the recording was consumed by the first stop()');
});

test('discard() drops a recording without producing a result', () => {
  __setRecordingForTest(903, {
    frames: [{ indices: [0], delayMs: 400, timestamp: 1 }],
    width: 1,
    height: 1,
    startedAt: 1,
    lastAt: 1,
    options: resolveOverlayOptions(),
  });
  discard(903);
  assert.ok(stop(903).error);
});

test('LAST_FRAME_BONUS_MS is the documented 2000ms', () => {
  assert.equal(LAST_FRAME_BONUS_MS, 2000);
});

test('the palette still has 256 entries with overlays added', () => {
  assert.equal(PALETTE.length, 256 * 3);
});
