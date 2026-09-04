import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

installChromeStub();

const {
  targetDimensions,
  estimateTokens,
  PX_PER_TOKEN,
  MAX_TARGET_PX,
  DEFAULT_MAX_TOKENS,
  noteInput,
  lastInputAt,
  needsPaintWait,
  clearInputMark,
  PAINT_WAIT_WINDOW_MS,
  PAINT_CEILING_MS,
  DEFAULT_FORMAT,
  DEFAULT_QUALITY,
  MAX_BASE64_CHARS,
  MIN_QUALITY,
  QUALITY_STEP,
  normalizeFormat,
  normalizeQuality,
  clampScale,
  planCapture,
  decodeImageSize,
  fitToBudget,
  devicePixelRatioFrom,
  recordCapture,
  imageToCss,
  getScalingContext,
  clearScalingContext,
  beginBatch,
  endBatch,
  isBatching,
  pendingContextFor,
} = await import('../extension/src/lib/screenshot.js');

test('a tall viewport is bounded by the default token budget, not just the long edge', () => {
  // 1568x1411 sits under the long-edge cap and still costs about 2800 tokens.
  const t = targetDimensions(1568, 1411, { maxTokens: DEFAULT_MAX_TOKENS });
  const tokens = estimateTokens(t.width, t.height);
  assert.ok(tokens <= DEFAULT_MAX_TOKENS + 5, 'got ' + tokens);
  assert.ok(Math.abs(t.width / t.height - 1568 / 1411) < 0.02, 'aspect preserved');
});

test('the default token budget leaves a normal viewport legible', () => {
  const t = targetDimensions(1512, 850, { maxTokens: DEFAULT_MAX_TOKENS });
  assert.ok(t.width >= 1200, 'still readable at ' + t.width + 'px wide');
});

test('an image already within budget is left alone', () => {
  const t = targetDimensions(1280, 800);
  assert.equal(t.width, 1280);
  assert.equal(t.height, 800);
  assert.equal(t.scale, 1);
});

test('a retina capture is downscaled to the long-edge cap', () => {
  const t = targetDimensions(2560, 1600);
  assert.equal(t.width, MAX_TARGET_PX);
  assert.equal(t.height, 980);
  assert.ok(Math.abs(t.scale - 1568 / 2560) < 1e-9);
});

test('aspect ratio survives downscaling', () => {
  const t = targetDimensions(3000, 1000);
  assert.ok(Math.abs(t.width / t.height - 3) < 0.02);
});

test('a tall image is capped on its long edge', () => {
  const t = targetDimensions(800, 4000);
  assert.equal(t.height, MAX_TARGET_PX);
  assert.equal(t.width, 314);
});

test('a token budget shrinks the image further', () => {
  const t = targetDimensions(1568, 900, { maxTokens: 500 });
  assert.ok(estimateTokens(t.width, t.height) <= 505, 'got ' + estimateTokens(t.width, t.height));
  assert.ok(t.width < 1568);
});

test('token estimate matches the 28px block size', () => {
  assert.equal(PX_PER_TOKEN, 28);
  assert.equal(estimateTokens(28, 28), 1);
  assert.equal(estimateTokens(280, 280), 100);
});

test('a full-width capture lands near the documented token cost', () => {
  const tokens = estimateTokens(1568, 900);
  assert.ok(tokens > 1700 && tokens < 1900, 'got ' + tokens);
});

test('degenerate sizes never produce a zero dimension', () => {
  const t = targetDimensions(1, 10000);
  assert.ok(t.width >= 1);
  assert.ok(t.height >= 1);
});

// ---------------------------------------------------------------------------
// R3: the repaint clock
// ---------------------------------------------------------------------------
//
// A screenshot in the same round trip as a click showed the pre-click frame on
// TodoMVC, twice. The capture cannot tell whether it is inside a batch, so it
// keys off when the tab was last acted on instead.

test('a tab nothing has touched needs no repaint wait', () => {
  clearInputMark(99);
  assert.equal(needsPaintWait(99), false);
  assert.equal(lastInputAt(99), 0);
});

test('an input just dispatched makes the next capture wait for a paint', () => {
  const now = 1_000_000;
  noteInput(98, now);
  assert.equal(lastInputAt(98), now);
  assert.equal(needsPaintWait(98, now + 10), true);
  assert.equal(needsPaintWait(98, now + 120), true, 'still inside the window a batch runs in');
});

test('an input from a previous turn does not make a fresh screenshot wait', () => {
  const now = 2_000_000;
  noteInput(97, now);
  assert.equal(needsPaintWait(97, now + PAINT_WAIT_WINDOW_MS + 1), false);
});

test('the mark is per tab, so one tab acting does not slow a capture on another', () => {
  clearInputMark(96);
  noteInput(95, 3_000_000);
  assert.equal(needsPaintWait(96, 3_000_010), false);
  assert.equal(needsPaintWait(95, 3_000_010), true);
});

test('the paint wait is bounded, so a page that never paints costs a fixed amount', () => {
  assert.equal(PAINT_CEILING_MS, 300);
  assert.ok(PAINT_CEILING_MS < PAINT_WAIT_WINDOW_MS);
});

// ---------------------------------------------------------------------------
// S1: JPEG by default, with a byte budget
// ---------------------------------------------------------------------------

test('jpeg at quality 0.75 is the default', () => {
  assert.equal(DEFAULT_FORMAT, 'jpeg');
  assert.equal(DEFAULT_QUALITY, 0.75);
  assert.equal(normalizeFormat(undefined), 'jpeg');
  assert.equal(normalizeFormat('png'), 'png');
  assert.equal(normalizeFormat('webp'), 'jpeg', 'anything else falls back rather than reaching CDP');
});

test('quality is normalized, and a caller writing 75 gets 0.75', () => {
  assert.equal(normalizeQuality(undefined), 0.75);
  assert.equal(normalizeQuality(0.4), 0.4);
  assert.equal(normalizeQuality(75), 0.75);
  assert.equal(normalizeQuality(0.01), MIN_QUALITY, 'clamped to the floor');
  assert.equal(normalizeQuality('high'), 0.75);
});

test('scale is clamped to the documented range', () => {
  assert.equal(clampScale(0.5), 0.5);
  assert.equal(clampScale(0), 0.1);
  assert.equal(clampScale(4), 1);
  assert.equal(clampScale(undefined), 1);
});

test('a payload inside the budget is returned untouched', async () => {
  const data = 'x'.repeat(100);
  let calls = 0;
  const fitted = await fitToBudget({
    data,
    quality: 0.75,
    budget: 1000,
    reencode: async () => {
      calls++;
      return '';
    },
  });
  assert.equal(fitted.data, data);
  assert.equal(fitted.quality, 0.75);
  assert.equal(fitted.steps, 0);
  assert.equal(calls, 0, 'no re-encode was attempted');
  assert.deepEqual(fitted.warnings, []);
});

test('quality steps down by 0.05 until the payload fits', async () => {
  // A payload whose size falls with quality, fitting at 0.60.
  const sizeAt = (q) => Math.round(q * 1000);
  const budget = 620;
  const asked = [];
  const fitted = await fitToBudget({
    data: 'x'.repeat(sizeAt(0.75)),
    quality: 0.75,
    budget,
    reencode: async (q) => {
      asked.push(q);
      return 'x'.repeat(sizeAt(q));
    },
  });
  assert.deepEqual(asked, [0.7, 0.65, 0.6], 'stepped down ' + QUALITY_STEP + ' at a time');
  assert.equal(fitted.quality, 0.6);
  assert.equal(fitted.steps, 3);
  assert.ok(fitted.data.length <= budget);
  assert.deepEqual(fitted.warnings, [], 'fitting inside the budget warns about nothing');
});

test('the loop stops at the quality floor and warns', async () => {
  const warnings = [];
  const fitted = await fitToBudget({
    data: 'x'.repeat(5000),
    quality: 0.75,
    budget: 100,
    warnings,
    reencode: async () => 'x'.repeat(5000),
  });
  assert.equal(fitted.quality, MIN_QUALITY);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /quality floor/);
  assert.ok(fitted.data.length > 100, 'a too-large image is still returned, since the caller can see it');
});

test('a png over budget warns instead of pretending quality applies', async () => {
  const warnings = [];
  let calls = 0;
  const fitted = await fitToBudget({
    data: 'x'.repeat(5000),
    format: 'png',
    budget: 100,
    warnings,
    reencode: async () => {
      calls++;
      return '';
    },
  });
  assert.equal(calls, 0);
  assert.equal(fitted.steps, 0);
  assert.match(warnings[0], /png payload cannot be reduced by quality/);
});

test('the default byte budget matches the one the official extension uses', () => {
  assert.equal(MAX_BASE64_CHARS, 1398100);
});

// ---------------------------------------------------------------------------
// S2: the clip fast path, and the header decode that verifies it
// ---------------------------------------------------------------------------

/** A PNG whose IHDR says width x height. Only the header is read. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

/** A JPEG with a JFIF segment before the frame header, the way Chrome writes one. */
function jpegHeader(width, height) {
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffd8, 0);
  app0.writeUInt16BE(0xffe0, 2);
  app0.writeUInt16BE(16, 4);
  app0.write('JFIF', 6, 'ascii');
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([app0, sof, Buffer.alloc(64)]).toString('base64');
}

test('a png header decodes to its dimensions', () => {
  assert.deepEqual(decodeImageSize(pngHeader(1568, 882)), { format: 'png', width: 1568, height: 882 });
});

test('a jpeg header decodes past the JFIF segment to the frame header', () => {
  assert.deepEqual(decodeImageSize(jpegHeader(747, 420)), { format: 'jpeg', width: 747, height: 420 });
});

test('bytes that are neither decode to null, so the capture falls back', () => {
  assert.equal(decodeImageSize(Buffer.from('not an image at all').toString('base64')), null);
  assert.equal(decodeImageSize(''), null);
  assert.equal(decodeImageSize(undefined), null);
});

test('a viewport larger than the budget is clipped down inside CDP', () => {
  const plan = planCapture({ cssWidth: 1600, cssHeight: 900, dpr: 1 });
  assert.equal(plan.useClipPath, true, 'Chrome can render straight to the target size');
  assert.equal(plan.clip.width, 1600);
  assert.equal(plan.clip.height, 900);
  assert.ok(Math.abs(plan.clip.scale - plan.target.width / 1600) < 1e-9);
  assert.ok(plan.clip.scale < 1);
  assert.ok(estimateTokens(plan.target.width, plan.target.height) <= DEFAULT_MAX_TOKENS + 5);
});

test('a target larger than the CSS viewport keeps the canvas path', () => {
  // 1000x700 at dpr 2 is a 2000x1400 surface. What fits the token budget is
  // still 1338 wide, more than the 1000 CSS pixels a clip would render from, so
  // the clip would enlarge rather than downscale.
  const plan = planCapture({ cssWidth: 1000, cssHeight: 700, dpr: 2 });
  assert.equal(plan.sourceWidth, 2000);
  assert.ok(plan.target.width > 1000, 'got ' + plan.target.width);
  assert.ok(plan.clip.scale > 1);
  assert.equal(plan.useClipPath, false);
});

test('a retina viewport whose budget lands below CSS size takes the clip path', () => {
  // 1512x850 at dpr 2 fits the budget at 1494 wide, under the CSS viewport, so
  // Chrome can render it directly instead of returning a 3024x1700 surface.
  const plan = planCapture({ cssWidth: 1512, cssHeight: 850, dpr: 2 });
  assert.equal(plan.sourceWidth, 3024);
  assert.ok(plan.target.width < 1512, 'got ' + plan.target.width);
  assert.equal(plan.useClipPath, true);
});

test('a small viewport needs neither path, and is captured as it is', () => {
  const plan = planCapture({ cssWidth: 800, cssHeight: 600, dpr: 1 });
  assert.equal(plan.target.width, 800);
  assert.equal(plan.target.height, 600);
  assert.equal(plan.clip.scale, 1);
  assert.equal(plan.useClipPath, false);
});

test('a zoom region is offset by the scroll position, since CDP clips in page coordinates', () => {
  const plan = planCapture({
    cssWidth: 1200,
    cssHeight: 800,
    dpr: 1,
    region: [100, 50, 500, 350],
    scrollX: 0,
    scrollY: 640,
  });
  assert.equal(plan.region, true);
  assert.deepEqual(
    { x: plan.clip.x, y: plan.clip.y, width: plan.clip.width, height: plan.clip.height },
    { x: 100, y: 690, width: 400, height: 300 }
  );
  assert.deepEqual(plan.box, { x: 100, y: 50, width: 400, height: 300 });
});

test('a zoom region of zero size is refused', () => {
  assert.throws(() => planCapture({ cssWidth: 800, cssHeight: 600, region: [10, 10, 10, 300] }), /non-zero/);
});

test('the device pixel ratio comes from the two units the layout metrics report', () => {
  assert.equal(
    devicePixelRatioFrom({ cssLayoutViewport: { clientWidth: 1512 }, layoutViewport: { clientWidth: 3024 } }),
    2
  );
  assert.equal(devicePixelRatioFrom({ cssLayoutViewport: { clientWidth: 800 } }), 1, 'a missing pair means 1');
  assert.equal(devicePixelRatioFrom(null), 1);
});

// ---------------------------------------------------------------------------
// S3: scale, and the coordinate frame it reports
// ---------------------------------------------------------------------------

test('scale halves both edges of the frame the budget produced', () => {
  const full = planCapture({ cssWidth: 1600, cssHeight: 900, dpr: 1 });
  const half = planCapture({ cssWidth: 1600, cssHeight: 900, dpr: 1, scale: 0.5 });
  assert.equal(half.frame.width, full.frame.width, 'the full-resolution frame is unchanged');
  assert.equal(half.target.width, Math.round(full.frame.width * 0.5));
  assert.equal(half.target.height, Math.round(full.frame.height * 0.5));
  assert.ok(Math.abs(half.clip.scale - full.clip.scale / 2) < 1 / 1600, 'within a pixel of half');
  const ratio =
    estimateTokens(half.target.width, half.target.height) / estimateTokens(full.target.width, full.target.height);
  assert.ok(Math.abs(ratio - 0.25) < 0.02, 'a half-scale image costs about a quarter of the tokens, got ' + ratio);
});

test('a click read off a half-scale image lands where it was aimed', () => {
  // A synthetic 1600x900 viewport captured at 0.5.
  const plan = planCapture({ cssWidth: 1600, cssHeight: 900, dpr: 1, scale: 0.5 });
  clearScalingContext(41);
  recordCapture(41, {
    cssToImage: plan.target.width / 1600,
    offsetX: 0,
    offsetY: 0,
    imageWidth: plan.target.width,
    imageHeight: plan.target.height,
    cssWidth: 1600,
    cssHeight: 900,
    cropped: false,
    capturedAt: Date.now(),
  });

  const middle = imageToCss(41, plan.target.width / 2, plan.target.height / 2);
  assert.ok(Math.abs(middle.x - 800) <= 2, 'x landed at ' + middle.x);
  assert.ok(Math.abs(middle.y - 450) <= 2, 'y landed at ' + middle.y);

  const corner = imageToCss(41, plan.target.width, plan.target.height);
  assert.ok(Math.abs(corner.x - 1600) <= 2, 'the far corner maps to the far corner, got ' + corner.x);
  assert.ok(Math.abs(corner.y - 900) <= 2, 'got ' + corner.y);

  // A quarter of the way across the image is a quarter of the way across the page.
  const quarter = imageToCss(41, plan.target.width / 4, plan.target.height / 4);
  assert.ok(Math.abs(quarter.x - 400) <= 2, 'got ' + quarter.x);
  assert.equal(quarter.mapped, true);
  clearScalingContext(41);
});

test('a coordinate past the edge of a scaled image is read in the full-resolution frame', () => {
  clearScalingContext(42);
  recordCapture(42, {
    cssToImage: 747 / 1600,
    offsetX: 0,
    offsetY: 0,
    imageWidth: 747,
    imageHeight: 420,
    cssWidth: 1600,
    cssHeight: 900,
    cropped: false,
    capturedAt: Date.now(),
  });
  // 1200,700 cannot have been read off a 747x420 image, and it fits the page.
  const point = imageToCss(42, 1200, 700);
  assert.deepEqual({ x: point.x, y: point.y, frame: point.frame }, { x: 1200, y: 700, frame: 'css' });
  // Anything inside the image is read as image pixels, which is the contract.
  assert.equal(imageToCss(42, 373, 210).frame, 'image');
  clearScalingContext(42);
});

test('a zoom keeps its crop offset, so coordinates resolve against the page', () => {
  clearScalingContext(43);
  recordCapture(43, {
    cssToImage: 2,
    offsetX: 100,
    offsetY: 50,
    imageWidth: 800,
    imageHeight: 600,
    cssWidth: 1200,
    cssHeight: 800,
    cropped: true,
    capturedAt: Date.now(),
  });
  assert.deepEqual(imageToCss(43, 200, 100), { x: 200, y: 100, mapped: true, frame: 'image' });
  clearScalingContext(43);
});

// ---------------------------------------------------------------------------
// R4: the coordinate frame is frozen for the length of a batch
// ---------------------------------------------------------------------------

function contextOf(imageWidth, cssWidth) {
  return {
    cssToImage: imageWidth / cssWidth,
    offsetX: 0,
    offsetY: 0,
    imageWidth,
    imageHeight: 500,
    cssWidth,
    cssHeight: 500,
    cropped: false,
    capturedAt: Date.now(),
  };
}

test('a capture inside a batch does not remap coordinates written before it', () => {
  clearScalingContext(51);
  recordCapture(51, contextOf(800, 1600)); // the frame the caller could see
  assert.equal(imageToCss(51, 400, 0).x, 800);

  beginBatch();
  assert.equal(isBatching(), true);
  recordCapture(51, contextOf(1600, 1600)); // a screenshot mid-batch
  assert.equal(imageToCss(51, 400, 0).x, 800, 'still the pre-batch frame');
  assert.equal(pendingContextFor(51).imageWidth, 1600, 'the new frame is held aside');
  assert.equal(getScalingContext(51).imageWidth, 800);

  endBatch();
  assert.equal(isBatching(), false);
  assert.equal(getScalingContext(51).imageWidth, 1600, 'committed when the batch ended');
  assert.equal(imageToCss(51, 400, 0).x, 400);
  assert.equal(pendingContextFor(51), null);
  clearScalingContext(51);
});

test('the first capture on a tab commits even inside a batch', () => {
  clearScalingContext(52);
  beginBatch();
  recordCapture(52, contextOf(800, 1600));
  assert.equal(getScalingContext(52).imageWidth, 800, 'holding it would leave later coordinates unmapped');
  assert.equal(pendingContextFor(52), null);
  endBatch();
  clearScalingContext(52);
});

test('nested batches commit once, at the outermost end', () => {
  clearScalingContext(53);
  recordCapture(53, contextOf(800, 1600));
  beginBatch();
  beginBatch();
  recordCapture(53, contextOf(1200, 1600));
  endBatch();
  assert.equal(getScalingContext(53).imageWidth, 800, 'the inner end is not the batch the caller submitted');
  endBatch();
  assert.equal(getScalingContext(53).imageWidth, 1200);
  clearScalingContext(53);
});

test('clearing a tab drops its pending frame too', () => {
  clearScalingContext(54);
  recordCapture(54, contextOf(800, 1600));
  beginBatch();
  recordCapture(54, contextOf(1200, 1600));
  clearScalingContext(54);
  endBatch();
  assert.equal(getScalingContext(54), null);
});

// ---------------------------------------------------------------------------
// Format, quality and clip, as they reach CDP
// ---------------------------------------------------------------------------

const cdp = await import('../extension/src/lib/cdp.js');

/** A debugger that records what each command was called with. */
function scriptDebugger(handlers = {}) {
  const seen = [];
  globalThis.chrome.debugger = {
    attach(_target, _version, done) {
      chrome.runtime.lastError = null;
      done();
    },
    detach(_target, done) {
      chrome.runtime.lastError = null;
      done();
    },
    sendCommand(_target, method, params, done) {
      seen.push({ method, params });
      chrome.runtime.lastError = null;
      const handler = handlers[method];
      done(handler ? handler(params) : {});
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {} },
  };
  return seen;
}

test('a visible tab is captured as jpeg at the asked quality, clipped in page coordinates', async () => {
  const seen = scriptDebugger({
    'Page.captureScreenshot': () => ({ data: 'JPEGDATA' }),
  });
  chrome.tabs.get = async () => ({ id: 61, active: true, windowId: 1, url: 'https://example.com/' });
  chrome.windows.get = async () => ({ id: 1, state: 'normal', focused: true });

  await cdp.attach(61);
  const data = await cdp.captureScreenshot(61, {
    format: 'jpeg',
    quality: 75,
    clip: { x: 0, y: 640, width: 1600, height: 900, scale: 0.93 },
  });
  assert.equal(data, 'JPEGDATA');

  const call = seen.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(call.params.format, 'jpeg');
  assert.equal(call.params.quality, 75);
  assert.equal(call.params.captureBeyondViewport, false);
  assert.equal(call.params.fromSurface, true);
  assert.deepEqual(call.params.clip, { x: 0, y: 640, width: 1600, height: 900, scale: 0.93 });
  await cdp.detachAll();
});

test('a png capture carries no quality, which CDP would reject', async () => {
  const seen = scriptDebugger({ 'Page.captureScreenshot': () => ({ data: 'PNGDATA' }) });
  chrome.tabs.get = async () => ({ id: 62, active: true, windowId: 1, url: 'https://example.com/' });
  chrome.windows.get = async () => ({ id: 1, state: 'normal', focused: true });

  await cdp.attach(62);
  await cdp.captureScreenshot(62, { format: 'png', quality: 75 });
  const call = seen.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(call.params.format, 'png');
  assert.equal(call.params.quality, undefined);
  assert.equal(call.params.clip, undefined);
  await cdp.detachAll();
});

test('a hidden tab asks the screencast for the target size instead of cropping in a canvas', async () => {
  const listeners = [];
  const seen = scriptDebugger({
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }),
  });
  globalThis.chrome.debugger.onEvent = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
  };
  const plain = globalThis.chrome.debugger.sendCommand;
  globalThis.chrome.debugger.sendCommand = (target, method, params, done) => {
    plain(target, method, params, done);
    if (method === 'Page.startScreencast') {
      setTimeout(
        () => listeners.slice().forEach((fn) => fn({ tabId: 63 }, 'Page.screencastFrame', { data: 'FRAME', sessionId: 1 })),
        1
      );
    }
  };
  chrome.tabs.get = async () => ({ id: 63, active: false, windowId: 1, url: 'https://example.com/' });

  await cdp.attach(63);
  const data = await cdp.captureScreenshot(63, {
    format: 'jpeg',
    quality: 70,
    clip: { x: 0, y: 0, width: 800, height: 600, scale: 0.5 },
    scroll: { x: 0, y: 0 },
  });
  assert.equal(data, 'FRAME', 'the frame is returned as it is, with no canvas round trip');

  const start = seen.find((c) => c.method === 'Page.startScreencast');
  assert.equal(start.params.maxWidth, 400, 'the screencast is the hidden-tab equivalent of clip.scale');
  assert.equal(start.params.maxHeight, 300);
  assert.equal(start.params.quality, 70);
  assert.equal(start.params.format, 'jpeg');
  assert.ok(seen.some((c) => c.method === 'Page.stopScreencast'));
  assert.ok(!seen.some((c) => c.method === 'Page.captureScreenshot'), 'no surface capture was attempted');
  await cdp.detachAll();
});
