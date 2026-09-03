// Tab group management.
//
// Agent tabs are collected into a Chrome tab group tied to the client session,
// so the agent cannot act on tabs the user is working in and the user can see
// at a glance which tabs it owns.

import * as cdp from './cdp.js';

const GROUP_TITLE = 'chrome-mcp';
const STORAGE_KEY = 'tabGroups';

/** @type {Map<string, number>} clientId -> tabGroupId */
const sessionGroups = new Map();

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

/**
 * Returns the tab context for a session, creating a group and a blank tab when
 * createIfEmpty is set and none exists.
 */
export async function tabsContext(clientId, { createIfEmpty = false } = {}) {
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
  return { tabId, tabGroupId: groupId };
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
