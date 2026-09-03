// Tool implementations. Every tool the MCP server exposes resolves here.

import * as cdp from './cdp.js';
import * as shot from './screenshot.js';
import * as perms from './permissions.js';
import * as tabsLib from './tabs.js';
import * as recorder from './recorder.js';
import { scoreCandidates } from './find.js';
import * as gif from './gif.js';
import * as shortcuts from './shortcuts.js';

const CONTENT_SCRIPT = 'src/content/agent.js';

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
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
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
/** Grabs a gif frame when a recording is open. Never allowed to fail an action. */
async function recordFrame(tabId) {
  if (gif.isRecording(tabId)) await gif.captureFrame(tabId).catch(() => {});
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
// computer
// ---------------------------------------------------------------------------

/** Resolves the click point for an action, from a ref or from screenshot coordinates. */
async function resolvePoint(tabId, { ref, coordinate }, { requireHit = false } = {}) {
  if (ref) {
    let resolved = await pageCall(tabId, { type: 'RESOLVE_REF', ref });
    if (resolved.error) throw new Error(resolved.error);
    let geo = resolved.geometry;

    // Scroll before a click even when the element is nominally in the viewport.
    // An element clipped by a scrollable ancestor still reports an on-screen
    // box, and hit testing at that point finds whatever is painted over the
    // clipped area rather than the element itself.
    if (!geo.inViewport || requireHit) {
      const scrolled = await pageCall(tabId, { type: 'SCROLL_TO', ref });
      if (scrolled.error) throw new Error(scrolled.error);
      await cdp.sleep(80, tabId);
      // Re-resolve rather than trusting the pre-scroll box, so occlusion is
      // judged where the element actually ended up.
      resolved = await pageCall(tabId, { type: 'RESOLVE_REF', ref });
      if (resolved.error) throw new Error(resolved.error);
      geo = resolved.geometry;
    }

    if (geo.width === 0 && geo.height === 0) {
      throw new Error(
        'Element ' + ref + ' has zero size and cannot be clicked. It may be hidden behind a collapsed parent.'
      );
    }

    if (requireHit && resolved.disabled) {
      throw new Error(
        'Element ' + ref + ' is disabled, so a click on it does nothing. ' +
          'Enable it first, or act on whatever controls it.'
      );
    }

    if (requireHit && resolved.occludedBy) {
      throw new Error(
        'Element ' + ref + ' is covered by ' + resolved.occludedBy + ' at the point a click would land, ' +
          'so the click would go to that instead. Dismiss or scroll past it first. No click was sent.'
      );
    }

    // Ref geometry is already in CSS pixels, so it bypasses screenshot scaling.
    return { x: geo.centerX, y: geo.centerY, source: 'ref' };
  }

  if (!coordinate) throw new Error('this action needs either coordinate [x, y] or ref');
  const [rawX, rawY] = coordinate;
  const mapped = shot.imageToCss(tabId, rawX, rawY);

  // A coordinate outside the viewport cannot receive input, and dispatching it
  // anyway looks like a click that silently did nothing.
  const state = await pageCall(tabId, { type: 'PAGE_STATE' }).catch(() => null);
  if (state && state.viewport) {
    const { width, height } = state.viewport;
    if (mapped.x < 0 || mapped.y < 0 || mapped.x > width || mapped.y > height) {
      throw new Error(
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
  if (!action) throw new Error('computer requires an action');
  if (tabId === undefined || tabId === null) throw new Error('computer requires a tabId');

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
      await pageCall(tabId, { type: 'HIDE_FOR_TOOL_USE' }).catch(() => {});
      try {
        const image = await shot.capture(tabId, { maxTokens: input.maxTokens });
        return {
          image,
          saveToDisk: Boolean(input.save_to_disk),
          pageState: await pageCall(tabId, { type: 'PAGE_STATE' }),
        };
      } finally {
        pageCall(tabId, { type: 'SHOW_AFTER_TOOL_USE' }).catch(() => {});
      }
    }

    case 'zoom': {
      if (!input.region || input.region.length !== 4) {
        throw new Error('zoom requires region [x0, y0, x1, y1]');
      }
      await pageCall(tabId, { type: 'HIDE_FOR_TOOL_USE' }).catch(() => {});
      try {
        const image = await shot.capture(tabId, { region: input.region });
        return { image, saveToDisk: Boolean(input.save_to_disk) };
      } finally {
        pageCall(tabId, { type: 'SHOW_AFTER_TOOL_USE' }).catch(() => {});
      }
    }

    case 'wait': {
      const seconds = Math.min(10, Math.max(0, input.duration ?? 1));
      await cdp.sleep(seconds * 1000, tabId);
      return { ok: true, waited: seconds };
    }

    case 'scroll_to': {
      if (!input.ref) throw new Error('scroll_to requires ref');
      await perms.verifyOriginUnchanged(tabId, url);
      const result = await pageCall(tabId, { type: 'SCROLL_TO', ref: input.ref });
      if (result.error) throw new Error(result.error);
      return result;
    }

    case 'hover': {
      await perms.verifyOriginUnchanged(tabId, url);
      const point = await resolvePoint(tabId, input);
      await cdp.mouseHover(tabId, point.x, point.y, modifiers, cursorHooks(tabId).onMove);
      return { ok: true, at: point };
    }

    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      await perms.verifyOriginUnchanged(tabId, url);
      const point = await resolvePoint(tabId, input, { requireHit: true });
      const spec = CLICK_ACTIONS[action];
      await cdp.mouseClick(tabId, point.x, point.y, { ...spec, modifiers, ...cursorHooks(tabId) });
      await recordFrame(tabId);
      return { ok: true, at: point };
    }

    case 'left_click_drag': {
      await perms.verifyOriginUnchanged(tabId, url);
      if (!input.start_coordinate || !input.coordinate) {
        throw new Error('left_click_drag requires start_coordinate and coordinate');
      }
      const from = shot.imageToCss(tabId, input.start_coordinate[0], input.start_coordinate[1]);
      const to = shot.imageToCss(tabId, input.coordinate[0], input.coordinate[1]);
      await cdp.mouseDrag(tabId, [from.x, from.y], [to.x, to.y], modifiers, cursorHooks(tabId));
      return { ok: true, from, to };
    }

    case 'type': {
      if (input.text === undefined || input.text === null) throw new Error('type requires text');
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
      if (input.perKey) await cdp.typeKeys(tabId, input.text);
      else await cdp.insertText(tabId, input.text);
      await recordFrame(tabId);
      return { ok: true, typed: String(input.text).length };
    }

    case 'key': {
      if (!input.text) throw new Error('key requires text, e.g. "Enter" or "ctrl+a"');
      await perms.verifyOriginUnchanged(tabId, url);
      await cdp.pressKeySequence(tabId, input.text, input.repeat || 1);
      await recordFrame(tabId);
      return { ok: true, keys: input.text, repeat: input.repeat || 1 };
    }

    case 'scroll': {
      await perms.verifyOriginUnchanged(tabId, url);
      const point = input.coordinate
        ? shot.imageToCss(tabId, input.coordinate[0], input.coordinate[1])
        : { x: 400, y: 400 };
      await cdp.mouseScroll(
        tabId,
        point.x,
        point.y,
        input.scroll_direction || 'down',
        input.scroll_amount || 3,
        modifiers
      );
      await cdp.sleep(120, tabId);
      await recordFrame(tabId);
      return { ok: true, direction: input.scroll_direction || 'down' };
    }

    default:
      throw new Error('unknown computer action: ' + action);
  }
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
      await perms.checkPermission({ tool: 'navigate', url: await activeUrl(tabId), toolUseId: ctx.toolUseId });
      await ensureAttached(tabId);
      await cdp.evaluate(tabId, 'history.' + (input.url === 'back' ? 'back' : 'forward') + '()');
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
    await recordFrame(tabId);
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url, title: tab.title, status: tab.status };
  },

  read_page: async (ctx, input) => {
    await gate(ctx.clientId, 'read_page', input.tabId, ctx.toolUseId);
    const result = await pageCall(input.tabId, {
      type: 'READ_PAGE',
      filter: input.filter || 'all',
      depth: input.depth ?? 15,
      maxChars: input.max_chars ?? 50000,
      refId: input.ref_id || null,
    });
    if (result.error) throw new Error(result.error);
    const tab = await chrome.tabs.get(input.tabId);
    return { url: tab.url, title: tab.title, ...result };
  },

  get_page_text: async (ctx, input) => {
    await gate(ctx.clientId, 'get_page_text', input.tabId, ctx.toolUseId);
    const result = await pageCall(input.tabId, {
      type: 'GET_PAGE_TEXT',
      maxChars: input.max_chars ?? 50000,
    });
    if (result.error) throw new Error(result.error);
    const tab = await chrome.tabs.get(input.tabId);
    return { url: tab.url, title: tab.title, ...result };
  },

  find: async (ctx, input) => {
    await gate(ctx.clientId, 'find', input.tabId, ctx.toolUseId);
    if (!input.query) throw new Error('find requires a query');
    const tree = await pageCall(input.tabId, {
      type: 'FIND_TREE',
      filter: input.include_all ? 'all' : 'interactive',
      depth: 30,
      maxChars: 200000,
    });
    if (tree.error) throw new Error(tree.error);
    const matches = scoreCandidates(tree.text, input.query, 20);
    return {
      query: input.query,
      matches,
      searched: tree.nodes,
      truncated: tree.truncated || false,
    };
  },

  form_input: async (ctx, input) => {
    const url = await gate(ctx.clientId, 'form_input', input.tabId, ctx.toolUseId);
    await perms.verifyOriginUnchanged(input.tabId, url);
    const result = await pageCall(input.tabId, {
      type: 'FORM_INPUT',
      ref: input.ref,
      value: input.value,
    });
    if (result.error) {
      const err = new Error(result.error);
      if (result.available) err.message += '. Available options: ' + result.available.join(', ');
      throw err;
    }
    return result;
  },

  computer: computerTool,

  file_upload: async (ctx, input) => {
    const { tabId, ref, coordinate, paths } = input;
    if (!ref && !coordinate) throw new Error('file_upload requires a ref or a coordinate');
    if (!Array.isArray(paths) || !paths.length) throw new Error('file_upload requires a non-empty paths array');

    const url = await gate(ctx.clientId, 'file_upload', tabId, ctx.toolUseId);
    await perms.verifyOriginUnchanged(tabId, url);
    await ensureAttached(tabId);
    await tabsLib.ensureVisible(tabId);

    // Drop zones are commonly plain divs with no name and no role, so they never
    // reach the tree and have no ref. A coordinate off a screenshot addresses them.
    if (!ref) {
      const point = shot.imageToCss(tabId, coordinate[0], coordinate[1]);
      await cdp.dropFiles(tabId, point.x, point.y, paths);
      return { ok: true, mode: 'drop', at: point, files: paths.length };
    }

    const token = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const marked = await pageCall(tabId, { type: 'MARK_ELEMENT', ref, token });
    if (marked.error) throw new Error(marked.error);

    try {
      if (marked.isFileInput) {
        if (paths.length > 1 && !marked.multiple) {
          throw new Error('this input accepts one file, ' + paths.length + ' were given');
        }
        await cdp.setFileInputFiles(tabId, marked.selector, paths);
        return { ok: true, mode: 'input', files: paths.length };
      }

      // No file input behind this ref, so treat it as a drop target. Upload
      // areas built on dragover/drop have no input to set.
      const geo = marked.geometry;
      if (!geo.width && !geo.height) {
        throw new Error('element ' + ref + ' is a ' + marked.tag + ' with no size, and is not a file input');
      }
      await cdp.dropFiles(tabId, geo.centerX, geo.centerY, paths);
      return { ok: true, mode: 'drop', files: paths.length };
    } finally {
      await pageCall(tabId, { type: 'UNMARK_ELEMENT', token }).catch(() => {});
    }
  },

  gif_creator: async (ctx, input) => {
    const { tabId, action } = input;
    await gate(ctx.clientId, 'gif_creator', tabId, ctx.toolUseId);
    await ensureAttached(tabId);

    if (action === 'start') {
      const started = gif.start(tabId);
      await gif.captureFrame(tabId);
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
    return recorder.readConsole(input.tabId, {
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
    await chrome.windows.update(tab.windowId, props);
    await cdp.sleep(150, input.tabId);
    shot.clearScalingContext(input.tabId);
    return pageCall(input.tabId, { type: 'PAGE_STATE' });
  },
};

export const TOOL_NAMES = Object.keys(handlers);

/** Dispatches one tool call. */
export async function execute(name, input, ctx) {
  const handler = handlers[name];
  if (!handler) throw new Error('unknown tool: ' + name);
  return handler(ctx, input || {});
}
