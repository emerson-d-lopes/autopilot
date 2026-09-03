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
