// Tool implementations. Every tool the MCP server exposes resolves here.

import * as cdp from './cdp.js';
import * as shot from './screenshot.js';
import * as perms from './permissions.js';
import * as tabsLib from './tabs.js';
import * as recorder from './recorder.js';
import { scoreCandidates, shouldWiden, NARROW_SCOPE_RATIO } from './find.js';
import * as gif from './gif.js';
import * as shortcuts from './shortcuts.js';
import { ToolError, withCode } from './errors.js';

const CONTENT_SCRIPT = 'src/content/agent.js';
const CONTENT_SCRIPTS = [CONTENT_SCRIPT, 'src/content/indicator.js'];

/**
 * Default character budget for the interactive filter (S4).
 *
 * CNN's interactive tree is about 300 nodes and 34000 characters, which the
 * client rejects outright, and the recovery it suggests, paging through a saved
 * file, is expensive for a routine read. The budget returns the top of the tree
 * plus a line saying how many nodes are not shown, and max_chars raises it.
 */
export const INTERACTIVE_MAX_CHARS = 20000;

/** Default and navigation-extended verification windows (C3). */
const VERIFY_WINDOW_MS = 250;
const VERIFY_NAV_WINDOW_MS = 1000;

/** Sends a message to the page agent, injecting it first if the page predates the extension. */
async function pageCall(tabId, message, { retry = true } = {}) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (response === undefined) throw new Error('no response from page agent');
    return response;
  } catch (err) {
    const text = String((err && err.message) || err);
    const missing =
      /Receiving end does not exist/i.test(text) ||
      /Could not establish connection/i.test(text) ||
      /no response from page agent/i.test(text);
    if (!missing || !retry) {
      throw new Error(describePageError(text, tabId));
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    return pageCall(tabId, message, { retry: false });
  }
}

function describePageError(text, tabId) {
  if (/Cannot access|Extension manifest must request permission|chrome:\/\//i.test(text)) {
    return (
      'Cannot read tab ' + tabId + '. Chrome blocks extensions on chrome://, edge://, the Web Store, ' +
      'and other restricted pages. Navigate to a normal page first.'
    );
  }
  if (/Receiving end does not exist/i.test(text)) {
    return 'Page agent is not present in tab ' + tabId + '. The page may still be loading, or it may be a restricted URL.';
  }
  return text;
}

async function activeUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return tab.url;
}

/** Runs the permission gate for a page-acting tool. */
async function gate(clientId, tool, tabId, toolUseId) {
  await tabsLib.assertTabInSession(clientId, tabId);
  const url = await activeUrl(tabId);
  await perms.checkPermission({ tool, url, toolUseId });
  return url;
}

async function ensureAttached(tabId) {
  await recorder.startCapture(tabId);
}

/**
 * Hooks that drive the on-page pointer alongside the real input events.
 *
 * Presentation only. The events the page receives come from CDP and are
 * identical whether or not this is drawn, so a page cannot tell the difference
 * from the pointer. Every call is fire and forget: drawing must never be able
 * to fail an action.
 */
/**
 * Grabs a gif frame when a recording is open. Never allowed to fail an action.
 * `meta` carries the action name and any point/path (P1), so the frame gets
 * the right per-action delay, action label, and click or drag marker.
 */
async function recordFrame(tabId, meta) {
  if (gif.isRecording(tabId)) await gif.captureFrame(tabId, meta).catch(() => {});
}

function cursorHooks(tabId) {
  const send = (payload) => {
    pageCall(tabId, { type: 'CURSOR', ...payload }).catch(() => {});
  };
  return {
    onMove: (x, y) => send({ x, y }),
    onPress: (x, y) => send({ x, y, press: true, pulse: true }),
    onRelease: () => send({ press: false }),
  };
}

// ---------------------------------------------------------------------------
// Input verification (C3, R7, R13)
// ---------------------------------------------------------------------------
//
// Every mutating action arms a watch in the page, dispatches, then reads back
// what changed. The result carries that as `evidence`, and an action that
// changed nothing says so instead of reporting a bare success.

/**
 * The tabs a click opened (R7).
 *
 * `tabs.adopted(tabId)` returns the ids of tabs created with this one as their
 * opener since it was last called, and clears them, so a click reports only
 * the tabs it opened.
 */
function adoptedTabs(openerTabId) {
  try {
    if (typeof tabsLib.adopted !== 'function') return [];
    const ids = tabsLib.adopted(openerTabId);
    if (Array.isArray(ids)) return ids.filter((id) => typeof id === 'number');
    return typeof ids === 'number' ? [ids] : [];
  } catch {
    /* the hook is not wired up on this build */
  }
  return [];
}

async function armVerify(tabId, point) {
  const armed = await pageCall(tabId, { type: 'VERIFY_ARM', point: point || null }).catch(() => null);
  let url = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url;
  } catch {
    /* the tab is reported gone by the action itself */
  }
  return { armed: Boolean(armed && armed.ok), url, at: Date.now() };
}

/**
 * Reads the watch back.
 *
 * The window is 250 ms, extended to 1000 ms once the tab is seen navigating,
 * because the page that answers then is the next one and it has to load first.
 */
async function readVerify(tabId, armed, { window = VERIFY_WINDOW_MS } = {}) {
  const report = armed.armed
    ? await pageCall(tabId, { type: 'VERIFY_REPORT', window }).catch((err) => ({
        ok: false,
        error: String((err && err.message) || err),
      }))
    : null;

  let windowMs = window;
  let navigation = null;
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && (tab.status === 'loading' || (armed.url && tab.url && tab.url !== armed.url))) {
    navigation = { started: true, from: armed.url || null, to: tab.url || null, status: tab.status };
    const extra = Math.max(0, VERIFY_NAV_WINDOW_MS - window);
    if (extra) {
      await cdp.sleep(extra, tabId);
      windowMs += extra;
      tab = await chrome.tabs.get(tabId).catch(() => tab);
      if (tab) {
        navigation.to = tab.url;
        navigation.status = tab.status;
      }
    }
  }

  const newTabIds = adoptedTabs(tabId);
  const newTabId = newTabIds.length ? newTabIds[0] : null;
  const watched = Boolean(report && report.ok);
  const evidence = {
    windowMs,
    watched,
    mutations: watched ? report.mutations : undefined,
    focusChanged: watched ? report.focusChanged : undefined,
    focusedAfter: watched ? report.focusedAfter : undefined,
    valueChanged: watched ? report.valueChanged : undefined,
    scrolled: watched ? report.scrolled : undefined,
    scrollDelta: watched ? report.scroll.delta : undefined,
    navigation: navigation || undefined,
    newTabId: newTabId || undefined,
    newTabIds: newTabIds.length > 1 ? newTabIds : undefined,
  };

  const changed = Boolean((watched && report.changed) || navigation || newTabId);
  const effects = changed ? 'applied' : watched ? 'none' : 'unknown';
  const warnings = [];
  if (effects === 'none') warnings.push('no observable change within ' + windowMs + 'ms');
  if (effects === 'unknown') {
    warnings.push('the page could not be watched, so whether this action changed anything is unknown');
  }
  return { effects, evidence, warnings, report, newTabId };
}

/**
 * Arms, dispatches, verifies, and retries once through a woken tab when the
 * renderer looked throttled and nothing moved (R13).
 *
 * The retry is conditional on the verification finding no change, so a click
 * that landed is never sent twice.
 */
async function dispatchVerified(tabId, dispatch, { point, window } = {}) {
  cdp.clearThrottleFlag(tabId);
  shot.noteInput(tabId);
  let armed = await armVerify(tabId, point);
  await dispatch();
  let outcome = await readVerify(tabId, armed, { window });

  if (outcome.effects === 'applied' || !cdp.rendererLooksThrottled(tabId)) return outcome;

  await cdp.wake(tabId, { force: true }).catch(() => {});
  cdp.clearThrottleFlag(tabId);
  shot.noteInput(tabId);
  armed = await armVerify(tabId, point);
  await dispatch();
  outcome = await readVerify(tabId, armed, { window });
  outcome.evidence.throttledRetry = true;
  outcome.warnings.unshift(
    'the renderer did not acknowledge the first dispatch, so the tab was woken and it was sent once more'
  );
  return outcome;
}

/** Whether the tab is the one on screen in a window that is showing. */
async function onScreenTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.state !== 'minimized' && win.focused !== false;
  } catch {
    return false;
  }
}

/**
 * Waits for a paint that postdates the last input on this tab (R3).
 *
 * A visible tab waits two animation frames, which is the first frame already
 * scheduled plus the one that commits the change. A hidden tab runs neither, so
 * it waits for a screencast frame stamped after the input. Both are bounded at
 * 300 ms, so a page that never paints costs a fixed amount rather than the
 * capture's whole timeout.
 */
async function waitForPaint(tabId) {
  if (!shot.needsPaintWait(tabId)) return undefined;
  const since = shot.lastInputAt(tabId);
  if (await onScreenTab(tabId)) {
    const result = await pageCall(tabId, { type: 'AWAIT_PAINT', ceiling: shot.PAINT_CEILING_MS }).catch(() => null);
    return { path: 'animationFrame', painted: Boolean(result && result.painted), waitedMs: result && result.waitedMs };
  }
  const frame = await cdp
    .screencastFrameAfter(tabId, since, { timeout: shot.PAINT_CEILING_MS })
    .catch(() => null);
  return { path: 'screencastFrame', painted: Boolean(frame && frame.painted) };
}

/** True when the page's host sits in the permission policy's payment category (W3). */
async function isPaymentCategory(url) {
  try {
    const policy = await perms.loadPolicy();
    const host = perms.hostnameOf(url);
    if (!host) return false;
    return (policy.blockedHosts || []).some((pattern) => perms.hostMatches(host, pattern));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// computer
// ---------------------------------------------------------------------------

/** Resolves the click point for an action, from a ref or from screenshot coordinates. */
async function resolvePoint(tabId, { ref, coordinate }, { requireHit = false, paymentCategory } = {}) {
  if (ref) {
    let resolved = await pageCall(tabId, { type: 'RESOLVE_REF', ref, paymentCategory });
    if (resolved.error) throw new ToolError(resolved.code || 'ref_stale', resolved.error);
    let geo = resolved.geometry;

    // Scroll before a click even when the element is nominally in the viewport.
    // An element clipped by a scrollable ancestor still reports an on-screen
    // box, and hit testing at that point finds whatever is painted over the
    // clipped area rather than the element itself.
    if (!geo.inViewport || requireHit) {
      const scrolled = await pageCall(tabId, { type: 'SCROLL_TO', ref });
      if (scrolled.error) throw new ToolError(scrolled.code || 'ref_stale', scrolled.error);
      await cdp.sleep(80, tabId);
      // Re-resolve rather than trusting the pre-scroll box, so occlusion is
      // judged where the element actually ended up.
      resolved = await pageCall(tabId, { type: 'RESOLVE_REF', ref, paymentCategory });
      if (resolved.error) throw new ToolError(resolved.code || 'ref_stale', resolved.error);
      geo = resolved.geometry;
    }

    if (geo.width === 0 && geo.height === 0) {
      throw new ToolError(
        'ref_stale',
        'Element ' + ref + ' has zero size and cannot be clicked. It may be hidden behind a collapsed parent.',
        { hint: 'Read the page again, or expand whatever contains it first.' }
      );
    }

    if (requireHit && resolved.disabled) {
      throw new ToolError(
        'element_disabled',
        'Element ' + ref + ' is disabled, so a click on it does nothing. ' +
          'Enable it first, or act on whatever controls it.'
      );
    }

    if (requireHit && resolved.occludedBy) {
      throw new ToolError(
        'ref_covered',
        'Element ' + ref + ' is covered by ' + resolved.occludedBy + ' at the point a click would land, ' +
          'so the click would go to that instead. Dismiss or scroll past it first. No click was sent.'
      );
    }

    // Ref geometry is already in CSS pixels, so it bypasses screenshot scaling.
    return { x: geo.centerX, y: geo.centerY, source: 'ref', element: resolved };
  }

  if (!coordinate) throw new ToolError('bad_request', 'this action needs either coordinate [x, y] or ref');
  const [rawX, rawY] = coordinate;
  const mapped = shot.imageToCss(tabId, rawX, rawY);

  // A coordinate outside the viewport cannot receive input, and dispatching it
  // anyway looks like a click that silently did nothing.
  const state = await pageCall(tabId, { type: 'PAGE_STATE' }).catch(() => null);
  if (state && state.viewport) {
    const { width, height } = state.viewport;
    if (mapped.x < 0 || mapped.y < 0 || mapped.x > width || mapped.y > height) {
      throw new ToolError(
        'bad_request',
        'Coordinate ' + mapped.x + ',' + mapped.y + ' is outside the ' + width + 'x' + height +
          ' viewport. Take a screenshot and read the coordinate from it, or target an element by ref.'
      );
    }
  }
  return { x: mapped.x, y: mapped.y, source: mapped.mapped ? 'screenshot' : 'raw' };
}

const CLICK_ACTIONS = {
  left_click: { button: 'left', clickCount: 1 },
  right_click: { button: 'right', clickCount: 1 },
  double_click: { button: 'left', clickCount: 2 },
  triple_click: { button: 'left', clickCount: 3 },
};

async function computerTool(ctx, input) {
  const { action, tabId } = input;
  if (!action) throw new ToolError('bad_request', 'computer requires an action');
  if (tabId === undefined || tabId === null) throw new ToolError('bad_request', 'computer requires a tabId');

  const readOnlyActions = new Set(['screenshot', 'zoom', 'wait']);
  const toolName = readOnlyActions.has(action) ? 'read_page' : 'computer';
  const url = await gate(ctx.clientId, toolName, tabId, ctx.toolUseId);
  await ensureAttached(tabId);

  // Input dispatch and surface capture both need a rendered tab. When the last
  // action found the renderer throttled, this brings the window back to the
  // front instead of dispatching into a tab that cannot answer.
  if (action !== 'wait') {
    await tabsLib.ensureVisible(tabId, { throttled: cdp.rendererLooksThrottled(tabId) });
    cdp.clearThrottleFlag(tabId);
  }

  const modifiers = cdp.modifiersToMask(input.modifiers);

  switch (action) {
    case 'screenshot': {
      const paint = await waitForPaint(tabId);
      await pageCall(tabId, { type: 'HIDE_FOR_TOOL_USE' }).catch(() => {});
      try {
        const image = await shot.capture(tabId, {
          maxTokens: input.maxTokens,
          format: input.format,
          quality: input.quality,
          scale: input.scale,
        });
        const warnings = [...(image.warnings || [])];
        if (paint && !paint.painted) {
          warnings.push('no paint was observed within ' + shot.PAINT_CEILING_MS + 'ms of the last input, so this image may predate it');
        }
        return {
          image,
          saveToDisk: Boolean(input.save_to_disk),
          pageState: await pageCall(tabId, { type: 'PAGE_STATE' }),
          effects: 'none',
          evidence: { paint, capture: { path: image.path, format: image.format, quality: image.quality, scale: image.scale } },
          warnings,
        };
      } finally {
        pageCall(tabId, { type: 'SHOW_AFTER_TOOL_USE' }).catch(() => {});
      }
    }

    case 'zoom': {
      if (!input.region || input.region.length !== 4) {
        throw new ToolError('bad_request', 'zoom requires region [x0, y0, x1, y1]');
      }
      const paint = await waitForPaint(tabId);
      await pageCall(tabId, { type: 'HIDE_FOR_TOOL_USE' }).catch(() => {});
      try {
        const image = await shot.capture(tabId, {
          region: input.region,
          format: input.format,
          quality: input.quality,
          scale: input.scale,
        });
        return {
          image,
          saveToDisk: Boolean(input.save_to_disk),
          effects: 'none',
          evidence: { paint, capture: { path: image.path, format: image.format, quality: image.quality, scale: image.scale } },
          warnings: [...(image.warnings || [])],
        };
      } finally {
        pageCall(tabId, { type: 'SHOW_AFTER_TOOL_USE' }).catch(() => {});
      }
    }

    case 'wait': {
      const seconds = Math.min(10, Math.max(0, input.duration ?? 1));
      await cdp.sleep(seconds * 1000, tabId);
      return { ok: true, waited: seconds, effects: 'none', evidence: { waitedMs: seconds * 1000 }, warnings: [] };
    }

    case 'scroll_to': {
      if (!input.ref) throw new ToolError('bad_request', 'scroll_to requires ref');
      await perms.verifyOriginUnchanged(tabId, url);
      const before = await pageCall(tabId, { type: 'SCROLL_OFFSETS' }).catch(() => null);
      const result = await pageCall(tabId, { type: 'SCROLL_TO', ref: input.ref });
      if (result.error) throw new ToolError(result.code || 'ref_stale', result.error);
      const after = await pageCall(tabId, { type: 'SCROLL_OFFSETS' }).catch(() => null);
      const moved = Boolean(before && after && (before.page.x !== after.page.x || before.page.y !== after.page.y));
      return {
        ...result,
        effects: moved ? 'applied' : 'none',
        evidence: { scroll: { before: before && before.page, after: after && after.page } },
        warnings: moved ? [] : ['the element was already in view, so nothing scrolled'],
      };
    }

    case 'hover': {
      await perms.verifyOriginUnchanged(tabId, url);
      const point = await resolvePoint(tabId, input);
      const outcome = await dispatchVerified(
        tabId,
        () => cdp.mouseHover(tabId, point.x, point.y, modifiers, cursorHooks(tabId).onMove),
        { point }
      );
      return { ok: true, at: point, effects: outcome.effects, evidence: outcome.evidence, warnings: outcome.warnings };
    }

    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      await perms.verifyOriginUnchanged(tabId, url);
      const paymentCategory = await isPaymentCategory(url);
      const point = await resolvePoint(tabId, input, { requireHit: true, paymentCategory });
      const spec = CLICK_ACTIONS[action];
      const outcome = await dispatchVerified(
        tabId,
        () => cdp.mouseClick(tabId, point.x, point.y, { ...spec, modifiers, ...cursorHooks(tabId) }),
        { point }
      );
      await recordFrame(tabId, { action, point: { x: point.x, y: point.y } });
      const irreversible = Boolean(point.element && point.element.irreversible);
      const result = {
        ok: true,
        at: { x: point.x, y: point.y, source: point.source },
        effects: outcome.effects,
        evidence: outcome.evidence,
        warnings: outcome.warnings,
      };
      if (irreversible) {
        result.irreversible = true;
        result.warnings = result.warnings.concat(
          'this control is classified as irreversible, so clicking it again would repeat the action'
        );
      }
      // The official shape, so the model can act on the new tab without a
      // tabs_context round trip.
      if (outcome.newTabId) {
        result.note =
          'the link opened in a new tab (tab ID ' + outcome.newTabId + '); pass that tab ID to interact with it';
        result.newTabId = outcome.newTabId;
      }
      return result;
    }

    case 'left_click_drag': {
      await perms.verifyOriginUnchanged(tabId, url);
      if (!input.start_coordinate || !input.coordinate) {
        throw new ToolError('bad_request', 'left_click_drag requires start_coordinate and coordinate');
      }
      const from = shot.imageToCss(tabId, input.start_coordinate[0], input.start_coordinate[1]);
      const to = shot.imageToCss(tabId, input.coordinate[0], input.coordinate[1]);
      const outcome = await dispatchVerified(
        tabId,
        // Dwell either side of the movement, without which an HTML5 drag source
        // never starts and a range thumb never moves.
        () => cdp.mouseDragDwell(tabId, [from.x, from.y], [to.x, to.y], modifiers, cursorHooks(tabId)),
        { point: to }
      );
      await recordFrame(tabId, { action, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
      return {
        ok: true,
        from,
        to,
        effects: outcome.effects,
        evidence: outcome.evidence,
        warnings: outcome.warnings,
      };
    }

    case 'type': {
      if (input.text === undefined || input.text === null) {
        throw new ToolError('bad_request', 'type requires text');
      }
      await perms.verifyOriginUnchanged(tabId, url);
      if (input.ref) {
        const point = await resolvePoint(tabId, { ref: input.ref });
        await cdp.mouseClick(tabId, point.x, point.y, {
          button: 'left',
          clickCount: 1,
          modifiers: 0,
          ...cursorHooks(tabId),
        });
        await cdp.sleep(40, tabId);
      }
      // Replacing means selecting what is there first, which is what a person
      // does and what a pre-filled field needs.
      if (input.replace) {
        await cdp.pressKey(tabId, 'ctrl+a');
        await cdp.sleep(20, tabId);
      }
      const text = String(input.text);
      const outcome = await dispatchVerified(tabId, async () => {
        if (input.perKey) await cdp.typeKeysReal(tabId, text, input.cadence);
        else await cdp.insertText(tabId, text);
      });
      await recordFrame(tabId, { action: 'type' });

      const report = outcome.report;
      const field = (report && report.focusedAfter) || null;
      // A type that reached a text control and left its value untouched is the
      // failure perKey used to report as {ok: true, typed: N}.
      if (text.length && report && report.ok && report.valueTracked && !report.valueChanged) {
        throw new ToolError(
          'no_effect',
          'Typed ' + text.length + ' characters and the value of ' +
            (field ? JSON.stringify(field) : 'the focused field') + ' did not change.',
          {
            cause: input.perKey
              ? 'the field did not accept per-key input'
              : 'the field may be read-only, controlled by a framework, or not the element that has focus',
            hint: 'Click the field by ref first, or set it with form_input.',
            effects: 'none',
            evidence: outcome.evidence,
          }
        );
      }

      return {
        ok: true,
        typed: text.length,
        field: field || undefined,
        sensitive: report && report.ok ? Boolean(report.valueSensitive) : undefined,
        replaced: Boolean(input.replace) || undefined,
        effects: outcome.effects,
        evidence: outcome.evidence,
        warnings: outcome.warnings,
      };
    }

    case 'key': {
      if (!input.text) throw new ToolError('bad_request', 'key requires text, e.g. "Enter" or "ctrl+a"');
      await perms.verifyOriginUnchanged(tabId, url);
      const outcome = await dispatchVerified(tabId, () =>
        // The loose sequence accepts a single punctuation character, so "/" and
        // "?" reach a page the same way a named key does.
        cdp.pressKeySequenceLoose(tabId, input.text, input.repeat || 1)
      );
      await recordFrame(tabId, { action: 'key' });
      return {
        ok: true,
        keys: input.text,
        repeat: input.repeat || 1,
        effects: outcome.effects,
        evidence: outcome.evidence,
        warnings: outcome.warnings,
      };
    }

    case 'scroll': {
      await perms.verifyOriginUnchanged(tabId, url);
      const point = input.coordinate
        ? shot.imageToCss(tabId, input.coordinate[0], input.coordinate[1])
        : { x: 400, y: 400 };
      const direction = input.scroll_direction || 'down';
      const amount = input.scroll_amount || 3;

      const before = await pageCall(tabId, { type: 'SCROLL_OFFSETS', x: point.x, y: point.y }).catch(() => null);
      shot.noteInput(tabId);
      await cdp.mouseScroll(tabId, point.x, point.y, direction, amount, modifiers);
      await cdp.sleep(120, tabId);
      const after = await pageCall(tabId, { type: 'SCROLL_OFFSETS', x: point.x, y: point.y }).catch(() => null);

      const delta = offsetDelta(before, after);
      const warnings = [];
      let method = 'wheel';
      let fallback = null;
      // A CDP wheel event does nothing on a virtualized list, an overflow
      // hidden body, or a container that only handles its own wheel events, and
      // reports success either way.
      if (Math.abs(delta.pageX) < 5 && Math.abs(delta.pageY) < 5 &&
          Math.abs(delta.containerX) < 5 && Math.abs(delta.containerY) < 5) {
        fallback = await pageCall(tabId, {
          type: 'SCROLL_BY',
          x: point.x,
          y: point.y,
          direction,
          amount,
        }).catch(() => null);
        if (fallback && fallback.ok) {
          method = 'scrollBy';
          warnings.push('the wheel event moved nothing, so the nearest scrollable ancestor was scrolled directly');
        }
      }
      await recordFrame(tabId, { action: 'scroll', point });

      const finalAfter = fallback && fallback.after ? { page: fallback.after.page, container: fallback.after.container } : after;
      const total = offsetDelta(before, finalAfter);
      const moved = Math.abs(total.pageX) >= 1 || Math.abs(total.pageY) >= 1 ||
        Math.abs(total.containerX) >= 1 || Math.abs(total.containerY) >= 1;
      // Measured rather than assumed: the page offsets and the nearest
      // scrollable container both stayed where they were.
      if (!moved) warnings.push('no observable change within 120ms');

      return {
        ok: true,
        direction,
        method,
        effects: moved ? 'applied' : 'none',
        evidence: {
          scroll: { before: before || undefined, after: finalAfter || undefined, delta: total },
          method,
          target: fallback ? fallback.target : undefined,
        },
        warnings,
      };
    }

    default:
      throw new ToolError('bad_request', 'unknown computer action: ' + action);
  }
}

/** Page and container scroll movement between two SCROLL_OFFSETS reads. */
function offsetDelta(before, after) {
  const zero = { pageX: 0, pageY: 0, containerX: 0, containerY: 0 };
  if (!before || !after) return zero;
  return {
    pageX: (after.page ? after.page.x : 0) - (before.page ? before.page.x : 0),
    pageY: (after.page ? after.page.y : 0) - (before.page ? before.page.y : 0),
    containerX: after.container && before.container ? after.container.x - before.container.x : 0,
    containerY: after.container && before.container ? after.container.y - before.container.y : 0,
  };
}

// ---------------------------------------------------------------------------
// Rich editors (W1)
// ---------------------------------------------------------------------------

/**
 * Sets the content of a contenteditable the way a person would.
 *
 * A real click to focus it, ctrl+a when there is something to replace, then
 * CDP Input.insertText, which fires beforeinput and input with the inputType a
 * rich editor expects. Replacing textContent and dispatching a synthetic input
 * event leaves the editor's own model stale, which is why a LinkedIn or Notion
 * composer accepts the text visually and sends nothing.
 */
async function editorInput(input, target) {
  const tabId = input.tabId;
  await ensureAttached(tabId);
  await tabsLib.ensureVisible(tabId, { throttled: cdp.rendererLooksThrottled(tabId) });

  const before = await pageCall(tabId, { type: 'REF_TEXT', ref: input.ref });
  if (before.error) throw new ToolError(before.code || 'ref_stale', before.error);

  const point = await resolvePoint(tabId, { ref: input.ref }, { requireHit: true });
  await cdp.mouseClick(tabId, point.x, point.y, {
    button: 'left',
    clickCount: 1,
    modifiers: 0,
    ...cursorHooks(tabId),
  });
  await cdp.sleep(60, tabId);

  const replacing = before.length > 0;
  if (replacing) {
    await cdp.pressKey(tabId, 'ctrl+a');
    await cdp.sleep(30, tabId);
  }

  const value = String(input.value);
  const outcome = await dispatchVerified(tabId, () => cdp.insertText(tabId, value), { point });

  const after = await pageCall(tabId, { type: 'REF_TEXT', ref: input.ref }).catch(() => null);
  const landed = Boolean(
    after &&
      after.ok &&
      (after.sensitive ? after.length === value.length : String(after.text || '').includes(value))
  );
  if (!landed) {
    throw new ToolError(
      'no_effect',
      'The editor ' + JSON.stringify(target.name || input.ref) + ' does not contain the text after the write.',
      {
        cause: 'the editor may have rejected the insertion, or the click focused something else',
        hint: 'Click the editor with computer, then type into it, and read the page to confirm.',
        effects: 'unknown',
        evidence: outcome.evidence,
      }
    );
  }

  return {
    ok: true,
    mode: 'editor',
    ref: input.ref,
    replaced: replacing,
    value: after.sensitive ? '[redacted]' : value,
    sensitive: after.sensitive || undefined,
    effects: 'applied',
    evidence: { ...outcome.evidence, setBy: 'Input.insertText', textLength: after.length },
    warnings: outcome.warnings.filter((w) => !/no observable change/.test(w)),
  };
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

export const handlers = {
  tabs_context: async (ctx, input) => tabsLib.tabsContext(ctx.clientId, { createIfEmpty: input.createIfEmpty }),

  tabs_create: async (ctx, input) => {
    const created = await tabsLib.createTab(ctx.clientId, { url: input.url || 'about:blank' });
    if (input.url && input.url !== 'about:blank') {
      await tabsLib.waitForLoad(created.id);
    }
    await ensureAttached(created.id);
    const tab = await chrome.tabs.get(created.id);
    return { tabId: created.id, url: tab.url, title: tab.title, tabGroupId: created.tabGroupId };
  },

  tabs_close: async (ctx, input) => tabsLib.closeTab(ctx.clientId, input.tabId),

  navigate: async (ctx, input) => {
    const tabId = input.tabId;
    await tabsLib.assertTabInSession(ctx.clientId, tabId);

    if (input.url === 'back' || input.url === 'forward') {
      // history.back()/forward() through Runtime.evaluate returns before the
      // navigation has even started, so the tool reported success while the
      // old page was still on screen. Page.navigateToHistoryEntry is a CDP
      // command the debugger waits on the way it waits on Page.navigate, and
      // pairing it with the same load wait navigate-to-URL already uses closes
      // that race.
      await perms.checkPermission({ tool: 'navigate', url: await activeUrl(tabId), toolUseId: ctx.toolUseId });
      await ensureAttached(tabId);

      const history = await cdp.send(tabId, 'Page.getNavigationHistory');
      const targetIndex = history.currentIndex + (input.url === 'back' ? -1 : 1);
      const entry = history.entries[targetIndex];
      if (!entry) {
        throw new ToolError(
          'nav_failed',
          'Cannot find a ' + (input.url === 'back' ? 'previous' : 'next') + ' page in history for tab ' + tabId + '.',
          { effects: 'none', retryable: false }
        );
      }
      await cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
      await tabsLib.waitForLoad(tabId, 15000);
    } else {
      let url = String(input.url);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
      await perms.checkPermission({ tool: 'navigate', url, toolUseId: ctx.toolUseId });
      await ensureAttached(tabId);

      // A page with unsaved input can hold the navigation with a beforeunload
      // dialog. Leaving is the caller's decision, so without force the dialog
      // is dismissed, the tab stays, and the call says what the page asked.
      cdp.setBeforeunloadPolicy(tabId, input.force ? 'accept' : 'dismiss');

      // Page.navigate reports why a load failed. chrome.tabs.update does not,
      // so a dead host or a refused connection looked like a successful
      // navigation onto Chrome's error page.
      let errorText = null;
      try {
        const result = await cdp.send(tabId, 'Page.navigate', { url });
        errorText = result && result.errorText;
      } catch {
        await chrome.tabs.update(tabId, { url });
      }
      await tabsLib.waitForLoad(tabId);
      recorder.noteNavigation(tabId, url);

      const dialog = cdp.takeBeforeunloadDialog(tabId);
      if (dialog && !input.force) throw cdp.dialogOpenError(tabId, url, dialog);

      if (errorText) {
        throw new Error(
          'Navigation to ' + url + ' failed: ' + errorText +
            '. The tab is showing an error page, not the site.'
        );
      }
    }

    shot.clearScalingContext(tabId);
    await recordFrame(tabId, { action: 'navigate' });
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url, title: tab.title, status: tab.status };
  },

  read_page: async (ctx, input) => {
    const url = await gate(ctx.clientId, 'read_page', input.tabId, ctx.toolUseId);
    const filter = input.filter || 'all';
    // The interactive filter carries its own default, because it is the one
    // reached for on a page too big to read whole.
    const maxChars = input.max_chars ?? (filter === 'interactive' ? INTERACTIVE_MAX_CHARS : 50000);
    const result = await pageCall(input.tabId, {
      type: 'READ_PAGE',
      filter,
      depth: input.depth ?? 15,
      maxChars,
      refId: input.ref_id || null,
      paymentCategory: await isPaymentCategory(url),
    });
    if (result.error) throw new ToolError(result.code || 'ref_stale', result.error);
    const tab = await chrome.tabs.get(input.tabId);
    return {
      url: tab.url,
      title: tab.title,
      ...result,
      maxChars,
      effects: 'none',
      evidence: {
        filter,
        nodes: result.nodes,
        shownNodes: result.shownNodes,
        maxChars,
        truncated: Boolean(result.truncated),
      },
      warnings: result.truncated
        ? [
            'output truncated at ' + maxChars + ' characters, ' + (result.hiddenNodes || 0) +
              ' of ' + result.nodes + ' nodes not shown',
          ]
        : [],
    };
  },

  get_page_text: async (ctx, input) => {
    await gate(ctx.clientId, 'get_page_text', input.tabId, ctx.toolUseId);
    const result = await pageCall(input.tabId, {
      type: 'GET_PAGE_TEXT',
      maxChars: input.max_chars ?? 50000,
    });
    if (result.error) throw new ToolError(result.code || 'ref_stale', result.error);
    const tab = await chrome.tabs.get(input.tabId);
    const warnings = [];
    if (result.fallback) {
      warnings.push('the first container held no text, so the text came from ' + result.container);
    }
    if (!result.text) {
      warnings.push(
        'no text was collected: ' + result.textNodes + ' text nodes accepted, ' +
          result.rejectedHidden + ' rejected as hidden, ' + result.rejectedEmpty + ' as empty'
      );
    }
    return {
      url: tab.url,
      title: tab.title,
      ...result,
      effects: 'none',
      evidence: {
        container: result.container,
        textNodes: result.textNodes,
        rejectedHidden: result.rejectedHidden,
        rejectedEmpty: result.rejectedEmpty,
        fallback: Boolean(result.fallback),
      },
      warnings,
    };
  },

  find: async (ctx, input) => {
    const url = await gate(ctx.clientId, 'find', input.tabId, ctx.toolUseId);
    if (!input.query) throw new ToolError('bad_request', 'find requires a query');
    const paymentCategory = await isPaymentCategory(url);
    const readTree = async (filter) => {
      const tree = await pageCall(input.tabId, {
        type: 'FIND_TREE',
        filter,
        depth: 30,
        maxChars: 200000,
        paymentCategory,
      });
      if (tree.error) throw new ToolError(tree.code || 'ref_stale', tree.error);
      return tree;
    };

    let scope = input.include_all ? 'all' : 'interactive';
    let tree = await readTree(scope);
    let matches = scoreCandidates(tree.text, input.query, 20);
    const warnings = [];
    let widenedBecause = null;

    // A page whose content is a table has almost no interactive nodes, which is
    // how a nine-thousand-cell page reported two candidates searched. The
    // second pass costs one more page call and only runs when the first found
    // nothing worth returning.
    if (scope === 'interactive') {
      widenedBecause = shouldWiden({ query: input.query, matches, searched: tree.nodes });
      if (widenedBecause) {
        const interactiveNodes = tree.nodes;
        tree = await readTree('all');
        scope = 'all';
        matches = scoreCandidates(tree.text, input.query, 20);
        warnings.push('widened the search to every node because ' + widenedBecause);
        if (tree.nodes && interactiveNodes / tree.nodes < NARROW_SCOPE_RATIO) {
          warnings.push(
            'the interactive filter covered ' + interactiveNodes + ' of ' + tree.nodes +
              ' nodes on this page, under ' + Math.round(NARROW_SCOPE_RATIO * 100) + ' percent'
          );
        }
      }
    }

    if (tree.truncated) {
      warnings.push('the tree was truncated at ' + tree.shownNodes + ' of ' + tree.nodes + ' nodes, so the match may be outside it');
    }

    return {
      query: input.query,
      matches,
      searched: tree.nodes,
      scope,
      widened: Boolean(widenedBecause) || undefined,
      truncated: tree.truncated || false,
      effects: 'none',
      evidence: { scope, searched: tree.nodes, widenedBecause: widenedBecause || undefined },
      warnings,
    };
  },

  form_input: async (ctx, input) => {
    const url = await gate(ctx.clientId, 'form_input', input.tabId, ctx.toolUseId);
    await perms.verifyOriginUnchanged(input.tabId, url);

    // A rich editor needs the events a real edit produces. Replacing textContent
    // and firing a synthetic input leaves React, ProseMirror and Quill with a
    // model that no longer matches the DOM, so a contenteditable takes the same
    // path a person's typing does.
    const target = await pageCall(input.tabId, { type: 'RESOLVE_REF', ref: input.ref }).catch(() => null);
    if (target && target.ok && target.contentEditable) return editorInput(input, target);

    const armed = await armVerify(input.tabId, null);
    const result = await pageCall(input.tabId, {
      type: 'FORM_INPUT',
      ref: input.ref,
      value: input.value,
    });
    if (result.error) {
      let message = result.error;
      if (result.available) message += '. Available options: ' + result.available.join(', ');
      throw new ToolError(result.code || 'ref_stale', message);
    }
    shot.noteInput(input.tabId);
    const outcome = await readVerify(input.tabId, armed);
    // The page read the value back, so the effect is not in doubt. The watch is
    // still worth reporting: it says whether the page reacted to the change.
    return {
      ...result,
      effects: 'applied',
      evidence: { ...outcome.evidence, setBy: 'value setter' },
      warnings: outcome.warnings.filter((w) => !/no observable change/.test(w)),
    };
  },

  computer: computerTool,

  file_upload: async (ctx, input) => {
    const { tabId, ref, coordinate, paths } = input;
    if (!ref && !coordinate) throw new ToolError('bad_request', 'file_upload requires a ref or a coordinate');
    if (!Array.isArray(paths) || !paths.length) {
      throw new ToolError('bad_request', 'file_upload requires a non-empty paths array');
    }

    const url = await gate(ctx.clientId, 'file_upload', tabId, ctx.toolUseId);
    await perms.verifyOriginUnchanged(tabId, url);
    await ensureAttached(tabId);
    await tabsLib.ensureVisible(tabId);

    // Drop zones are commonly plain divs with no name and no role, so they never
    // reach the tree and have no ref. A coordinate off a screenshot addresses them.
    if (!ref) {
      const point = shot.imageToCss(tabId, coordinate[0], coordinate[1]);
      const outcome = await dispatchVerified(tabId, () => cdp.dropFiles(tabId, point.x, point.y, paths), { point });
      return {
        ok: true,
        mode: 'drop',
        at: point,
        files: paths.length,
        effects: outcome.effects,
        evidence: outcome.evidence,
        warnings: outcome.warnings,
      };
    }

    // D2: no marker attribute is written onto the page. The element is
    // resolved and scrolled into view the same way a click resolves its
    // target, and CDP finds the actual `<input type=file>` node afterward
    // through a stable structural selector (see cdp.setFileInputFiles).
    let resolved = await pageCall(tabId, { type: 'RESOLVE_REF', ref });
    if (resolved.error) throw new ToolError(resolved.code || 'ref_stale', resolved.error);
    await pageCall(tabId, { type: 'SCROLL_TO', ref }).catch(() => {});
    resolved = await pageCall(tabId, { type: 'RESOLVE_REF', ref });
    if (resolved.error) throw new ToolError(resolved.code || 'ref_stale', resolved.error);

    if (resolved.isFileInput) {
      if (paths.length > 1 && !resolved.multiple) {
        throw new ToolError('bad_request', 'this input accepts one file, ' + paths.length + ' were given');
      }
      const outcome = await dispatchVerified(tabId, () => cdp.setFileInputFiles(tabId, resolved.geometry, paths));
      return {
        ok: true,
        mode: 'input',
        files: paths.length,
        effects: outcome.effects,
        evidence: outcome.evidence,
        warnings: outcome.warnings,
      };
    }

    // No file input behind this ref, so treat it as a drop target. Upload
    // areas built on dragover/drop have no input to set.
    const geo = resolved.geometry;
    if (!geo.width && !geo.height) {
      throw new ToolError(
        'ref_stale',
        'element ' + ref + ' is a ' + resolved.tag + ' with no size, and is not a file input'
      );
    }
    const outcome = await dispatchVerified(
      tabId,
      () => cdp.dropFiles(tabId, geo.centerX, geo.centerY, paths),
      { point: { x: geo.centerX, y: geo.centerY } }
    );
    return {
      ok: true,
      mode: 'drop',
      files: paths.length,
      effects: outcome.effects,
      evidence: outcome.evidence,
      warnings: outcome.warnings,
    };
  },

  gif_creator: async (ctx, input) => {
    const { tabId, action } = input;
    await gate(ctx.clientId, 'gif_creator', tabId, ctx.toolUseId);
    await ensureAttached(tabId);

    if (action === 'start') {
      const started = gif.start(tabId, input.options);
      await gif.captureFrame(tabId, { action: 'screenshot' });
      return started;
    }
    if (action === 'frame') {
      await gif.captureFrame(tabId);
      return { ok: true };
    }
    if (action === 'stop') {
      await gif.captureFrame(tabId);
      const result = gif.stop(tabId);
      if (result.error) throw new Error(result.error);
      return result;
    }
    if (action === 'cancel') {
      gif.discard(tabId);
      return { ok: true, recording: false };
    }
    throw new Error('gif_creator action must be start, frame, stop or cancel');
  },

  javascript: async (ctx, input) => {
    const url = await gate(ctx.clientId, 'javascript', input.tabId, ctx.toolUseId);
    await perms.verifyOriginUnchanged(input.tabId, url);
    await ensureAttached(input.tabId);
    const result = await cdp.evaluate(input.tabId, input.code);
    return {
      result: result.value !== undefined ? result.value : result.description ?? null,
      type: result.type,
    };
  },

  read_console_messages: async (ctx, input) => {
    await gate(ctx.clientId, 'read_console_messages', input.tabId, ctx.toolUseId);
    await ensureAttached(input.tabId);
    // Arms Runtime on this tab if it is not already on, and disarms it again
    // when the read clears the buffer (D1).
    return recorder.readConsoleMessages(input.tabId, {
      onlyErrors: input.only_errors,
      pattern: input.pattern,
      limit: input.limit ?? 100,
      clear: input.clear,
    });
  },

  read_network_requests: async (ctx, input) => {
    await gate(ctx.clientId, 'read_network_requests', input.tabId, ctx.toolUseId);
    await ensureAttached(input.tabId);
    return recorder.readNetwork(input.tabId, {
      urlPattern: input.url_pattern,
      onlyFailed: input.only_failed,
      limit: input.limit ?? 100,
      clear: input.clear,
    });
  },

  shortcuts_list: async () => {
    const all = await shortcuts.list();
    return {
      shortcuts: all.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        lines: s.script.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length,
      })),
    };
  },

  page_state: async (ctx, input) => {
    await gate(ctx.clientId, 'page_state', input.tabId, ctx.toolUseId);
    const tab = await chrome.tabs.get(input.tabId);
    try {
      const state = await pageCall(input.tabId, { type: 'PAGE_STATE' });
      return { ...state, title: tab.title, status: tab.status };
    } catch (err) {
      // about:blank, a new tab, and Chrome's own pages carry no content script.
      // Reporting where the tab is beats failing, since orientation is the whole
      // point of this tool.
      return {
        url: tab.url,
        title: tab.title,
        status: tab.status,
        pageAgent: false,
        note: String((err && err.message) || err),
      };
    }
  },

  wait_for_page: async (ctx, input) => {
    await gate(ctx.clientId, 'read_page', input.tabId, ctx.toolUseId);
    const timeout = input.timeout ?? 15000;
    const started = Date.now();
    const navigated = await tabsLib.waitForNavigationStart(input.tabId);
    const load = await tabsLib.waitForLoad(input.tabId, timeout);
    // A page that fetches and then renders looks finished to the load event
    // and to a short DOM quiet check. Waiting for in-flight requests to drain,
    // bounded so a long poll cannot hold the turn, catches the render that
    // follows the fetch.
    let networkIdle = true;
    if (cdp.isAttached(input.tabId)) {
      const deadline = started + Math.min(timeout, 4000);
      let quietSince = null;
      while (Date.now() < deadline) {
        if (recorder.pendingRequests(input.tabId) === 0) {
          if (quietSince === null) quietSince = Date.now();
          if (Date.now() - quietSince >= 250) break;
        } else {
          quietSince = null;
        }
        await cdp.sleep(50, input.tabId);
      }
      networkIdle = recorder.pendingRequests(input.tabId) === 0;
    }
    const settled = await pageCall(input.tabId, {
      type: 'WAIT_SETTLE',
      timeout: Math.max(500, Math.min(5000, timeout - (Date.now() - started))),
    });
    return { ...settled, navigated, networkIdle, timedOut: load.timedOut };
  },

  resize_window: async (ctx, input) => {
    const tab = await tabsLib.assertTabInSession(ctx.clientId, input.tabId);
    // A maximized or fullscreen window ignores a size, so it is set to normal
    // first. A minimized one is left minimized: restoring it would bring it
    // in front of the user.
    const win = await chrome.windows.get(tab.windowId);
    const props = { width: Math.max(200, input.width), height: Math.max(200, input.height) };
    if (win.state === 'maximized' || win.state === 'fullscreen') props.state = 'normal';
    const before = await pageCall(input.tabId, { type: 'PAGE_STATE' }).catch(() => null);
    await chrome.windows.update(tab.windowId, props);
    await cdp.sleep(150, input.tabId);
    shot.clearScalingContext(input.tabId);
    const state = await pageCall(input.tabId, { type: 'PAGE_STATE' });

    // Two agents read the returned viewport as proof the resize did nothing.
    // The layout viewport is not the outer size once device pixel ratio and
    // browser chrome are taken out, so the result says which number the request
    // was measured against.
    const requested = { width: props.width, height: props.height };
    const outer = { width: state.outerWidth, height: state.outerHeight };
    const viewport = state.viewport;
    const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 2;
    let matched = 'neither';
    if (near(outer.width, requested.width) && near(outer.height, requested.height)) matched = 'outer';
    else if (near(viewport.width, requested.width) && near(viewport.height, requested.height)) matched = 'viewport';

    const warnings = [];
    if (matched === 'neither') {
      warnings.push(
        'the window ended at ' + outer.width + 'x' + outer.height + ' outer and ' +
          viewport.width + 'x' + viewport.height + ' viewport, neither of which is the requested size'
      );
    }
    const changed = Boolean(
      before && (before.outerWidth !== outer.width || before.outerHeight !== outer.height ||
        before.viewport.width !== viewport.width || before.viewport.height !== viewport.height)
    );

    return {
      ...state,
      requested,
      outerWidth: outer.width,
      outerHeight: outer.height,
      viewport,
      matched,
      // Named so a reader is not left guessing which number moved.
      measuredAgainst:
        matched === 'outer'
          ? 'outerWidth and outerHeight, the window including browser chrome'
          : matched === 'viewport'
            ? 'the CSS layout viewport'
            : 'neither: the window manager or device pixel ratio changed the result',
      effects: changed ? 'applied' : 'none',
      evidence: {
        before: before ? { outerWidth: before.outerWidth, outerHeight: before.outerHeight, viewport: before.viewport } : undefined,
        after: { outerWidth: outer.width, outerHeight: outer.height, viewport },
        devicePixelRatio: state.devicePixelRatio,
      },
      warnings: changed ? warnings : warnings.concat('no observable change within 150ms'),
    };
  },
};

export const TOOL_NAMES = Object.keys(handlers);

/**
 * Dispatches one tool call.
 *
 * Anything that leaves here carrying a plain message is given a code on the way
 * out, so a caller never has to read prose to find out what class of failure it
 * met. A permission denial keeps its own type, which the worker serializes
 * separately.
 */
export async function execute(name, input, ctx) {
  const handler = handlers[name];
  if (!handler) throw new ToolError('bad_request', 'unknown tool: ' + name);
  try {
    return await handler(ctx, input || {});
  } catch (err) {
    if (err instanceof perms.PermissionDenied) throw err;
    throw withCode(err, 'internal', { effects: 'unknown' });
  }
}
