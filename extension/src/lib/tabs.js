// Tab group management.
//
// Agent tabs are collected into a Chrome tab group tied to the client session,
// so the agent cannot act on tabs the user is working in and the user can see
// at a glance which tabs it owns.

import * as cdp from './cdp.js';

const GROUP_TITLE = 'chrome-mcp';
const STORAGE_KEY = 'tabGroups';
const SESSION_TABLE_KEY = 'sessionTable';

/** @type {Map<string, number>} clientId -> tabGroupId */
const sessionGroups = new Map();

// ---------------------------------------------------------------------------
// The session table, so a worker restart does not cost the session
// ---------------------------------------------------------------------------
//
// chrome.runtime.reload() throws the service worker away with everything it
// held in memory. The group id survived in storage.local, but which tabs the
// session owned did not, so tabs_context after a reload returned an empty list
// and the tab ids the caller was holding reported that they had been closed.
//
// The table is written on every change and read back at worker start. Tabs that
// still exist are put back in the session's group, and the ones that are gone
// are held for the first tabs_context to report.

/** @type {Map<string, {tabIds: number[], groupId: number|null, browserId: string|null, at: number}>} */
const sessionTable = new Map();

/** @type {Map<string, number[]>} clientId -> tab ids that were gone at restore */
const goneTabs = new Map();

let cachedBrowserId = null;

async function currentBrowserId() {
  if (cachedBrowserId) return cachedBrowserId;
  try {
    const stored = await chrome.storage.local.get('browserId');
    cachedBrowserId = stored.browserId || null;
  } catch {
    cachedBrowserId = null;
  }
  return cachedBrowserId;
}

/**
 * Writes the table to both storage areas.
 *
 * storage.session is the right home for state that belongs to this browser run.
 * storage.local is written as well because a reload of the extension clears the
 * session area, which is the case this exists for.
 */
async function persistSessionTable() {
  const payload = Object.fromEntries(sessionTable);
  const areas = [chrome.storage.session, chrome.storage.local];
  for (const area of areas) {
    if (!area || typeof area.set !== 'function') continue;
    try {
      await area.set({ [SESSION_TABLE_KEY]: payload });
    } catch {
      /* a storage area that refuses a write must not fail the call that made it */
    }
  }
}

async function readSessionTable() {
  for (const area of [chrome.storage.session, chrome.storage.local]) {
    if (!area || typeof area.get !== 'function') continue;
    try {
      const stored = await area.get(SESSION_TABLE_KEY);
      const table = stored && stored[SESSION_TABLE_KEY];
      if (table && typeof table === 'object' && Object.keys(table).length) return table;
    } catch {
      /* try the other area */
    }
  }
  return {};
}

/**
 * Records which tabs a session owns right now.
 *
 * Called after anything that changes group membership, so what is on disk is
 * never behind what Chrome has.
 */
export async function recordSession(clientId) {
  if (!clientId) return;
  const groupId = sessionGroups.has(clientId) ? sessionGroups.get(clientId) : null;
  let tabIds = [];
  if (groupId !== null && groupId !== undefined) {
    const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
    tabIds = tabs.map((t) => t.id).filter((id) => typeof id === 'number');
  }
  sessionTable.set(clientId, {
    tabIds,
    groupId: groupId === undefined ? null : groupId,
    browserId: await currentBrowserId(),
    at: Date.now(),
  });
  await persistSessionTable();
}

/** Drops a closed tab from the table, so a restart does not report it twice. */
export async function forgetRemovedTab(tabId) {
  let changed = false;
  for (const [clientId, entry] of sessionTable) {
    if (!entry.tabIds.includes(tabId)) continue;
    sessionTable.set(clientId, { ...entry, tabIds: entry.tabIds.filter((id) => id !== tabId) });
    changed = true;
  }
  if (changed) await persistSessionTable();
}

/**
 * Puts the session table back after a worker restart.
 *
 * Nothing here activates a tab or focuses a window: a tab that fell out of its
 * group is grouped again, which leaves it exactly where it was.
 */
export async function restoreSessions() {
  const stored = await readSessionTable();
  await loadGroups();
  let restoredTabs = 0;
  let missing = 0;

  for (const [clientId, entry] of Object.entries(stored)) {
    if (!entry || typeof entry !== 'object') continue;
    const alive = [];
    const gone = [];
    for (const tabId of Array.isArray(entry.tabIds) ? entry.tabIds : []) {
      try {
        await chrome.tabs.get(tabId);
        alive.push(tabId);
      } catch {
        gone.push(tabId);
      }
    }

    let groupId = entry.groupId === undefined ? null : entry.groupId;
    if (!(await groupExists(groupId))) groupId = null;

    if (alive.length) {
      try {
        if (groupId === null) {
          groupId = await chrome.tabs.group({ tabIds: alive });
          await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' }).catch(() => {});
        } else {
          const inGroup = new Set((await chrome.tabs.query({ groupId }).catch(() => [])).map((t) => t.id));
          const strays = alive.filter((id) => !inGroup.has(id));
          if (strays.length) await chrome.tabs.group({ tabIds: strays, groupId });
        }
        sessionGroups.set(clientId, groupId);
        restoredTabs += alive.length;
      } catch {
        /* the tabs went away between the get and the group */
      }
    } else if (groupId !== null) {
      sessionGroups.set(clientId, groupId);
    }

    if (gone.length) {
      goneTabs.set(clientId, gone);
      missing += gone.length;
    }
    sessionTable.set(clientId, {
      tabIds: alive,
      groupId,
      browserId: entry.browserId === undefined ? null : entry.browserId,
      at: Date.now(),
    });
  }

  await persistGroups();
  await persistSessionTable();
  return { sessions: Object.keys(stored).length, tabs: restoredTabs, missing };
}

let restorePromise = null;

/** Restores once per worker, and lets anything that needs the table wait for it. */
export function ensureRestored() {
  if (!restorePromise) {
    restorePromise = restoreSessions().catch(() => ({ sessions: 0, tabs: 0, missing: 0 }));
  }
  return restorePromise;
}

/** The tabs this session lost across the restart, reported once. */
export function takeMissingTabs(clientId) {
  const gone = goneTabs.get(clientId) || [];
  goneTabs.delete(clientId);
  return gone;
}

/** Drops every restore record. Tests only. */
export function resetSessionTable() {
  sessionTable.clear();
  goneTabs.clear();
  sessionGroups.clear();
  restorePromise = null;
  cachedBrowserId = null;
}

async function loadGroups() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const map = stored[STORAGE_KEY] || {};
  for (const [clientId, groupId] of Object.entries(map)) {
    if (!sessionGroups.has(clientId)) sessionGroups.set(clientId, groupId);
  }
  return sessionGroups;
}

async function persistGroups() {
  await chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(sessionGroups) });
}

async function groupExists(groupId) {
  if (groupId === undefined || groupId === null || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return false;
  }
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch {
    return false;
  }
}

export async function getSessionGroupId(clientId) {
  await loadGroups();
  const groupId = sessionGroups.get(clientId);
  if (await groupExists(groupId)) return groupId;
  sessionGroups.delete(clientId);
  await persistGroups();
  return null;
}

/**
 * Shows what the session is doing on its tab group, the way Claude in Chrome
 * marks its group: an hourglass while a call runs, a check when the last call
 * finished, a cross when it failed. The title is the only surface a user sees
 * without opening anything, so it carries the state.
 */
const STATUS = {
  working: { mark: '\u23F3', color: 'blue' },
  done: { mark: '\u2705', color: 'green' },
  error: { mark: '\u274C', color: 'red' },
  idle: { mark: '', color: 'purple' },
};
const lastStatus = new Map();

export async function setGroupStatus(clientId, status) {
  const spec = STATUS[status] || STATUS.idle;
  const groupId = await getSessionGroupId(clientId);
  if (groupId === null) return false;
  const key = groupId + ':' + status;
  if (lastStatus.get(clientId) === key) return true;
  lastStatus.set(clientId, key);
  try {
    await chrome.tabGroups.update(groupId, {
      title: (spec.mark ? spec.mark + ' ' : '') + GROUP_TITLE,
      color: spec.color,
    });
    return true;
  } catch {
    lastStatus.delete(clientId);
    return false;
  }
}

/** The sessions this browser holds, for the popup. */
export async function listSessions() {
  await loadGroups();
  const out = [];
  for (const [clientId, groupId] of sessionGroups) {
    if (!(await groupExists(groupId))) continue;
    const tabs = await chrome.tabs.query({ groupId });
    let group = null;
    try {
      group = await chrome.tabGroups.get(groupId);
    } catch {
      /* gone */
    }
    const first = tabs.find((t) => t.title) || tabs[0];
    out.push({
      clientId,
      tabGroupId: groupId,
      tabs: tabs.length,
      mark: group && /^\S+\s/.test(group.title) ? group.title.split(' ')[0] : '',
      title: first ? first.title || first.url : '',
    });
  }
  return out;
}

/**
 * Brings a session's tabs into view. The one place a tab is activated, and it
 * runs only from the popup, which is the user asking.
 */
export async function revealSession(clientId) {
  const tabs = await listGroupTabs(clientId);
  if (!tabs.length) return false;
  const tab = tabs.find((t) => t.active) || tabs[0];
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' }).catch(() => {});
  return true;
}

/** Clears the marks of every stored session group. Used at worker start. */
export async function resetGroupStatuses() {
  await loadGroups();
  for (const clientId of [...sessionGroups.keys()]) {
    lastStatus.delete(clientId);
    await setGroupStatus(clientId, 'idle');
  }
}

export async function listGroupTabs(clientId) {
  const groupId = await getSessionGroupId(clientId);
  if (groupId === null) return [];
  const tabs = await chrome.tabs.query({ groupId });
  return tabs;
}

// ---------------------------------------------------------------------------
// Stop/Resume and the acting-indicator broadcast (F4)
// ---------------------------------------------------------------------------
//
// Which tab a session's running call is acting on, and whether the user has
// stopped the session, live here alongside the rest of the per-session state
// this module already tracks. Driving the indicator content script
// (indicator.js) from here, rather than from background.js, keeps the change
// to background.js itself down to wiring: two message cases and the calls
// around a tool_request's try block.

/** @type {Map<string, number>} clientId -> the tabId a call is acting on right now */
const activeTab = new Map();
/** @type {Set<string>} clientIds the user has stopped, until resume() */
const stoppedSessions = new Set();
/** @type {Map<string, number>} clientId -> the tab to show the stopped pill on */
const stoppedTab = new Map();

function sendIndicatorState(tabId, state) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, { type: 'INDICATOR_STATE', state }).catch(() => {
    // No content script on this tab (a chrome:// page, a not-yet-loaded tab,
    // or one this browser closed). Nothing to show there either way.
  });
}

/** Sends every tab in the session's group the indicator state it should show right now. */
async function broadcastIndicator(clientId) {
  const tabs = await listGroupTabs(clientId).catch(() => []);
  const acting = activeTab.get(clientId);
  const stopped = stoppedSessions.has(clientId);
  const pillTab = stopped ? stoppedTab.get(clientId) : null;
  for (const tab of tabs) {
    if (typeof acting === 'number' && tab.id === acting) sendIndicatorState(tab.id, 'pulsing');
    else if (stopped && tab.id === pillTab) sendIndicatorState(tab.id, 'stopped');
    else if (typeof acting === 'number') sendIndicatorState(tab.id, 'static');
    else sendIndicatorState(tab.id, 'none');
  }
}

/** Marks a tab as the one a call is acting on, and shows it on every session tab. */
export function beginActive(clientId, tabId) {
  if (typeof tabId !== 'number') return Promise.resolve();
  activeTab.set(clientId, tabId);
  return broadcastIndicator(clientId).catch(() => {});
}

/** Clears the active tab once the call finishes. A stopped pill, if any, stays until resume(). */
export function endActive(clientId) {
  activeTab.delete(clientId);
  return broadcastIndicator(clientId).catch(() => {});
}

/** True while a call is running for this session, for the popup's Stop button. */
export function isSessionActive(clientId) {
  return activeTab.has(clientId);
}

/** True while this session is stopped: every call fails fast until resume(). */
export function isStopped(clientId) {
  return stoppedSessions.has(clientId);
}

/**
 * Stops a session. The running batch or quick script notices on its next
 * step and aborts (background.js checks isStopped between actions).
 *
 * The indicator switches from the pulsing border to the stopped pill right
 * away rather than waiting for the loop to unwind, since the user's Stop
 * click should read back immediately.
 */
export function stopSession(clientId) {
  stoppedSessions.add(clientId);
  const tab = activeTab.get(clientId);
  if (typeof tab === 'number') stoppedTab.set(clientId, tab);
  activeTab.delete(clientId);
  return broadcastIndicator(clientId);
}

/** Clears the stopped state, so the next call runs normally. */
export function resumeSession(clientId) {
  stoppedSessions.delete(clientId);
  stoppedTab.delete(clientId);
  return broadcastIndicator(clientId);
}

/**
 * Returns the tab context for a session, creating a group and a blank tab when
 * createIfEmpty is set and none exists.
 */
export async function tabsContext(clientId, { createIfEmpty = false } = {}) {
  await ensureRestored();
  let tabs = await listGroupTabs(clientId);

  if (!tabs.length && createIfEmpty) {
    const created = await createTab(clientId, { url: 'about:blank', newWindow: true });
    tabs = await listGroupTabs(clientId);
    if (!tabs.length) tabs = [await chrome.tabs.get(created.id)];
  }

  const groupId = await getSessionGroupId(clientId);
  let groupTitle;
  if (groupId !== null) {
    try {
      groupTitle = (await chrome.tabGroups.get(groupId)).title;
    } catch {
      /* the group went away between the two calls */
    }
  }
  // The tabs the session had before the worker restarted that are no longer
  // open. Reported once, on the first listing after the restart, so a caller
  // holding one of those ids learns why it stopped working.
  const missingTabs = takeMissingTabs(clientId);
  await recordSession(clientId);
  return {
    tabGroupId: groupId,
    groupTitle,
    tabs: tabs.map((t) => ({
      tabId: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      status: t.status,
      windowId: t.windowId,
    })),
    missingTabs: missingTabs.length ? missingTabs : undefined,
    warnings: missingTabs.length
      ? ['tab ' + missingTabs.join(', ') + ' did not survive the extension restart and is no longer open']
      : [],
  };
}

async function lastFocusedNormalWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win && win.type === 'normal' && win.state !== 'minimized') return win;
  } catch {
    /* no focused window */
  }
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  return all.find((w) => w.state !== 'minimized') || all[0] || null;
}

export async function createTab(clientId, { url = 'about:blank', newWindow = false } = {}) {
  await loadGroups();
  let groupId = await getSessionGroupId(clientId);
  let tab;

  // Agent tabs open in the background. The user keeps what they were looking
  // at, and the tab is woken through CDP (see cdp.wake) so its renderer does
  // not throttle input or captures while hidden.
  if (groupId === null && newWindow) {
    // The session's first tab opens in the window the user is looking at, so
    // the agent's work appears next to theirs rather than in a second window
    // that lands wherever the window manager puts it. A fresh window is only
    // opened when there is no normal window to join.
    const current = await lastFocusedNormalWindow();
    if (current) {
      tab = await chrome.tabs.create({ windowId: current.id, url, active: false });
    } else {
      const win = await chrome.windows.create({ url, focused: false });
      tab = win.tabs && win.tabs[0];
    }
  } else {
    const createProps = { url, active: false };
    if (groupId !== null) {
      const existing = await chrome.tabs.query({ groupId });
      if (existing.length) createProps.windowId = existing[0].windowId;
    }
    tab = await chrome.tabs.create(createProps);
  }

  if (!tab) throw new Error('failed to create tab');

  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple', collapsed: false });
    sessionGroups.set(clientId, groupId);
    await persistGroups();
  } else {
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  }

  await recordSession(clientId);
  return { id: tab.id, url: tab.url, windowId: tab.windowId, tabGroupId: groupId };
}

/**
 * Puts a blank tab in a window that is about to lose its last one.
 *
 * Chrome closes a window when its final tab goes, and quits entirely when that
 * was the only window. Since the agent works in a window of its own, closing
 * its last tab would take the window, and on a browser with nothing else open
 * it would take the browser and the bridge with it. Closing one tab should do
 * exactly that and nothing more.
 */
async function keepWindowAlive(clientId, tab) {
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length > 1) return false;
  // Closing the last tab of a window closes the window, which is what the user
  // expects of any other tab. Only the browser's last window is protected, since
  // losing it would quit the browser and the bridge with it.
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length > 1) return false;

  const replacement = await chrome.tabs.create({
    windowId: tab.windowId,
    url: 'about:blank',
    active: true,
  });
  const groupId = await getSessionGroupId(clientId);
  if (groupId !== null) {
    await chrome.tabs.group({ tabIds: [replacement.id], groupId });
  }
  return true;
}

export async function closeTab(clientId, tabId) {
  const tab = await assertTabInSession(clientId, tabId);
  const replaced = await keepWindowAlive(clientId, tab);
  await chrome.tabs.remove(tabId);
  await recordSession(clientId);
  return { ok: true, keptWindowOpen: replaced };
}

/**
 * Guards every page-acting tool. Without this a caller could pass any tab id
 * and drive tabs the user never handed over, including tabs holding sessions
 * for sites the agent was never pointed at.
 */
export async function assertTabInSession(clientId, tabId) {
  const groupId = await getSessionGroupId(clientId);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(
      'No tab with id ' + tabId + '. It may have been closed. Call tabs_context to list current tabs.'
    );
  }
  if (groupId === null || tab.groupId !== groupId) {
    throw new Error(
      'Tab ' + tabId + ' is not in this session\'s tab group. ' +
        'Call tabs_context to list the tabs this session owns, or tabs_create to open one.'
    );
  }
  return tab;
}

export async function adoptTab(clientId, tabId) {
  await loadGroups();
  let groupId = await getSessionGroupId(clientId);
  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' });
    sessionGroups.set(clientId, groupId);
    await persistGroups();
  } else {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
  }
  await recordSession(clientId);
  return { tabId, tabGroupId: groupId };
}

// ---------------------------------------------------------------------------
// R7. Tabs a click opened
// ---------------------------------------------------------------------------

/** @type {Map<number, number[]>} openerTabId -> tabs adopted since the last read */
const adoptedByOpener = new Map();

/**
 * Takes a tab that a session tab opened into the same session.
 *
 * A click on target="_blank" opens a tab the caller never asked for and cannot
 * name. Left alone it sits outside the group, so assertTabInSession refuses it
 * and the page the click produced is unreachable. It joins the opener's group
 * instead, unselected, and its id is held for the click result to report.
 *
 * Nothing here activates the tab or focuses its window.
 *
 * @returns {Promise<{openerTabId: number, tabId: number, tabGroupId: number}|null>}
 */
/**
 * Records which tab opened this one, before anything is awaited.
 *
 * The click that opened the tab reads the bookkeeping 250 ms later. Filling it
 * only after the session lookup and the group call had the read beat the write
 * every time: measured on the fixture, a click on a target="_blank" link
 * returned no newTabId even though the tab existed and Chrome had already put
 * it in the session's group.
 *
 * An opener that turns out not to be a session tab is dropped again by
 * adoptOpenedTab, so this cannot grow without bound.
 */
export function noteOpenedTab(tab) {
  const openerTabId = tab && tab.openerTabId;
  if (typeof openerTabId !== 'number' || typeof (tab && tab.id) !== 'number') return;
  const seen = adoptedByOpener.get(openerTabId) || [];
  if (!seen.includes(tab.id)) seen.push(tab.id);
  adoptedByOpener.set(openerTabId, seen);
  noteRecentOpen(tab.id, openerTabId);
}

// ---------------------------------------------------------------------------
// Tabs a page opened, when Chrome names the wrong opener
// ---------------------------------------------------------------------------
//
// Chrome fills openerTabId from the window's active tab rather than from the
// tab whose renderer opened the new one. Nothing here ever activates a tab, so
// the acting tab is never the active one and the opener never points at it.
// Measured on the fixture with Chrome for Testing 152: a click on a
// target="_blank" link in tab 369885084 produced a tab whose openerTabId was
// 369885023, the browser's initial about:blank tab, and the same click through
// window.open named whichever tab happened to be active.
//
// A click the watch flagged as opening a tab falls back to this ledger, which
// records every page-opened tab with the moment it appeared. Only tabs Chrome
// gave an opener at all are in it, so a tab the extension created with
// chrome.tabs.create is never a candidate.

/** @type {Array<{tabId: number, openerTabId: number, at: number}>} */
const recentOpens = [];

/** How long a page-opened tab stays a candidate. Twice the click's own wait. */
const RECENT_OPEN_MS = 3000;

function noteRecentOpen(tabId, openerTabId, at = Date.now()) {
  recentOpens.push({ tabId, openerTabId, at });
  while (recentOpens.length && at - recentOpens[0].at > RECENT_OPEN_MS) recentOpens.shift();
}

/**
 * Page-opened tabs that appeared at or after `since`, oldest first.
 *
 * Reading does not consume, so a caller that finds one still reports it through
 * `adopted`, and a caller that finds none is not left holding a stale id.
 */
export function openedSince(since, now = Date.now()) {
  return recentOpens
    .filter((r) => r.at >= since && now - r.at <= RECENT_OPEN_MS)
    .map((r) => r.tabId);
}

/** Drops every recorded open. Tests only. */
export function resetRecentOpens() {
  recentOpens.length = 0;
}

export async function adoptOpenedTab(tab) {
  const openerTabId = tab && tab.openerTabId;
  if (typeof openerTabId !== 'number' || typeof (tab && tab.id) !== 'number') return null;

  const found = await sessionForTab(openerTabId);
  if (!found) {
    adoptedByOpener.delete(openerTabId);
    return null;
  }

  if (tab.groupId !== found.groupId) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: found.groupId });
    } catch {
      // The tab went away before it could be grouped, which is the same as
      // never having been opened.
      return null;
    }
  }

  const seen = adoptedByOpener.get(openerTabId) || [];
  if (!seen.includes(tab.id)) seen.push(tab.id);
  adoptedByOpener.set(openerTabId, seen);
  await recordSession(found.clientId);
  return { openerTabId, tabId: tab.id, tabGroupId: found.groupId };
}

/**
 * The ids adopted for one opener since this was last called, and clears them.
 *
 * Reading is destructive so the next click reports only the tabs it opened,
 * rather than every tab the session has ever spawned from that page.
 */
export function adopted(openerTabId) {
  const ids = adoptedByOpener.get(openerTabId) || [];
  adoptedByOpener.delete(openerTabId);
  return ids;
}

/**
 * The same ids without clearing them, so a click can poll for the tab it opened
 * and still leave the read that reports it to `adopted`.
 */
export function peekAdopted(openerTabId) {
  return (adoptedByOpener.get(openerTabId) || []).slice();
}

/** Drops a closed tab from the adoption bookkeeping. */
export function forgetAdopted(tabId) {
  for (let i = recentOpens.length - 1; i >= 0; i--) {
    if (recentOpens[i].tabId === tabId) recentOpens.splice(i, 1);
  }
  adoptedByOpener.delete(tabId);
  for (const [opener, ids] of adoptedByOpener) {
    const left = ids.filter((id) => id !== tabId);
    if (left.length) adoptedByOpener.set(opener, left);
    else adoptedByOpener.delete(opener);
  }
}

/** The session whose group holds a tab, or null when no session owns it. */
export async function sessionForTab(tabId) {
  await loadGroups();
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
  if (tab.groupId === undefined || tab.groupId === null) return null;
  for (const [clientId, groupId] of sessionGroups) {
    if (groupId === tab.groupId) return { clientId, groupId, tab };
  }
  return null;
}

/**
 * Replaces a session tab that can no longer be driven.
 *
 * A tab whose debugger attach is refused for good is dead to the agent while
 * still holding the page the caller wanted. A fresh tab on the same URL joins
 * the same group in the same window, unselected, and the dead one goes, so the
 * session keeps its tab count and the caller gets an id it can act on. What is
 * lost is page state: form input, scroll position and anything the page held in
 * memory. Returns null when the tab belongs to no session, since replacing a
 * tab the user owns is not this code's business.
 */
export async function replaceSessionTab(tabId) {
  const found = await sessionForTab(tabId);
  if (!found) return null;
  const { clientId, groupId, tab } = found;
  const url = tab.url && tab.url !== 'chrome://newtab/' ? tab.url : 'about:blank';

  const created = await chrome.tabs.create({
    windowId: tab.windowId,
    url,
    active: false,
    index: tab.index,
  });
  await chrome.tabs.group({ tabIds: [created.id], groupId });
  cdp.forgetTab(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  if (url !== 'about:blank') await waitForLoad(created.id, 15000);
  await recordSession(clientId);

  return { clientId, tabGroupId: groupId, oldTabId: tabId, newTabId: created.id, url };
}

export async function releaseSession(clientId, { closeEmptyOnly = true } = {}) {
  const tabs = await listGroupTabs(clientId);
  let toClose = closeEmptyOnly
    ? tabs.filter((t) => !t.url || t.url === 'about:blank' || t.url === 'chrome://newtab/')
    : tabs;
  if (toClose.length) {
    // Closing every tab of the browser's last window would quit the browser
    // and take the bridge with it. One of the tabs about to close is kept,
    // rather than opening a fresh blank tab in front of the user.
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const inWindow = (await chrome.tabs.query({ windowId: toClose[0].windowId })).length;
    if (windows.length <= 1 && inWindow <= toClose.length) toClose = toClose.slice(1);
    if (toClose.length) await chrome.tabs.remove(toClose.map((t) => t.id));
  }
  if (toClose.length === tabs.length) {
    sessionGroups.delete(clientId);
    await persistGroups();
  }
  await recordSession(clientId);
  return { closed: toClose.length, remaining: tabs.length - toClose.length };
}

/**
 * Prepares a tab for input or capture without showing it.
 *
 * Nothing here activates a tab or focuses a window: the user decides what is
 * on screen. A renderer that looked throttled on the last action is woken
 * again through CDP, which is the background equivalent of raising it.
 */
export async function ensureVisible(tabId, { throttled = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (throttled) await cdp.wake(tabId, { force: true }).catch(() => {});
  return tab;
}

/**
 * Gives a navigation the last action may have triggered a moment to begin.
 *
 * A click on a submit button returns before the browser has started the
 * request, so a wait that only checks whether the tab is loading sees a
 * finished page and returns at once, and the read that follows sees the form
 * rather than the response. Resolves as soon as the tab starts loading or its
 * URL changes, or after the grace period when nothing happens.
 */
export function waitForNavigationStart(tabId, grace = 600) {
  return new Promise((resolve) => {
    let settled = false;
    let initialUrl = null;
    const finish = (started) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(started);
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading' || (info.url && initialUrl !== null && info.url !== initialUrl)) finish(true);
    };
    const timer = setTimeout(() => finish(false), grace);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (tab) => {
        initialUrl = tab.url;
        if (tab.status === 'loading') finish(true);
      },
      () => finish(false)
    );
  });
}

/** Waits for a tab to finish loading, with a ceiling so a hung page cannot block a turn. */
export function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(result);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish({ ok: true, timedOut: false });
    };
    const timer = setTimeout(() => finish({ ok: true, timedOut: true }), timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish({ ok: true, timedOut: false });
      },
      () => finish({ ok: false, timedOut: false })
    );
  });
}
