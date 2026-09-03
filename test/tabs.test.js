// Tab helpers that only matter around navigation timing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

const stub = installChromeStub();
const tabs = await import('../extension/src/lib/tabs.js');

function scriptTabs({ status = 'complete', url = 'https://a.test/' } = {}) {
  const listeners = [];
  stub.tabs.get = async () => ({ id: 1, status, url });
  stub.tabs.onUpdated = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
  };
  return { fire: (id, info) => listeners.slice().forEach((fn) => fn(id, info)), listeners };
}

test('waitForNavigationStart resolves true as soon as the tab starts loading', async () => {
  const t = scriptTabs();
  const pending = tabs.waitForNavigationStart(1, 2000);
  await new Promise((r) => setTimeout(r, 10));
  t.fire(1, { status: 'loading' });
  assert.equal(await pending, true);
  assert.equal(t.listeners.length, 0, 'the listener is removed');
});

test('waitForNavigationStart ignores other tabs and gives up after the grace period', async () => {
  const t = scriptTabs();
  const started = Date.now();
  const pending = tabs.waitForNavigationStart(1, 80);
  await new Promise((r) => setTimeout(r, 10));
  t.fire(2, { status: 'loading' });
  assert.equal(await pending, false);
  assert.ok(Date.now() - started >= 70, 'waited for the grace period');
});

test('waitForNavigationStart resolves true when the tab is already loading', async () => {
  scriptTabs({ status: 'loading' });
  assert.equal(await tabs.waitForNavigationStart(1, 1000), true);
});

test('setGroupStatus marks the group title and colour, and only when the state changes', async () => {
  const updates = [];
  stub.tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    async get() {
      return { id: 42 };
    },
    async update(id, props) {
      updates.push([id, props]);
    },
  };
  stub.storage = {
    local: {
      async get() {
        return { tabGroups: { c9: 42 } };
      },
      async set() {},
    },
  };
  assert.equal(await tabs.setGroupStatus('c9', 'working'), true);
  assert.equal(await tabs.setGroupStatus('c9', 'working'), true);
  assert.equal(updates.length, 1, 'a repeated state is not re-applied');
  assert.deepEqual(updates[0], [42, { title: '\u23F3 chrome-mcp', color: 'blue' }]);
  await tabs.setGroupStatus('c9', 'done');
  assert.deepEqual(updates[1][1], { title: '\u2705 chrome-mcp', color: 'green' });
  await tabs.setGroupStatus('c9', 'error');
  assert.deepEqual(updates[2][1], { title: '\u274C chrome-mcp', color: 'red' });
  assert.equal(await tabs.setGroupStatus('nobody', 'done'), false, 'no group, nothing to mark');
});

// ---------------------------------------------------------------------------
// Replacing a tab that can no longer be driven
// ---------------------------------------------------------------------------

/** A session holding one tab in group 42, ready to be replaced. */
function scriptSession({ groupId = 43, tab = null } = {}) {
  const dead = tab || { id: 11, url: 'https://x.test/home', groupId, windowId: 3, index: 2, status: 'complete' };
  const created = { id: 12, url: dead.url, windowId: dead.windowId, status: 'complete' };
  const log = { created: null, grouped: null, removed: [] };

  stub.storage = {
    local: {
      async get() {
        return { tabGroups: { sessionA: groupId } };
      },
      async set() {},
    },
  };
  stub.tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    async get() {
      return { id: groupId };
    },
    async update() {},
  };
  stub.tabs = {
    ...stub.tabs,
    async get(id) {
      if (id === dead.id) return dead;
      if (id === created.id) return created;
      throw new Error('No tab with id ' + id);
    },
    async create(props) {
      log.created = props;
      return created;
    },
    async group(props) {
      log.grouped = props;
      return props.groupId;
    },
    async remove(id) {
      log.removed.push(id);
    },
    onUpdated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {} },
  };
  return { dead, created, log };
}

test('a dead session tab is replaced in the same group, unselected, and the old one closed', async () => {
  const { log } = scriptSession();

  const result = await tabs.replaceSessionTab(11);

  assert.deepEqual(result, {
    clientId: 'sessionA',
    tabGroupId: 43,
    oldTabId: 11,
    newTabId: 12,
    url: 'https://x.test/home',
  });
  assert.deepEqual(log.created, { windowId: 3, url: 'https://x.test/home', active: false, index: 2 });
  assert.deepEqual(log.grouped, { tabIds: [12], groupId: 43 }, 'the replacement joins the session group');
  assert.deepEqual(log.removed, [11], 'the tab that could not be driven is closed');
});

test('a tab no session owns is not replaced', async () => {
  scriptSession({ groupId: 43, tab: { id: 11, url: 'https://x.test/', groupId: 99, windowId: 3, index: 0 } });
  assert.equal(await tabs.replaceSessionTab(11), null, 'a tab outside the session group is left alone');
});

test('a tab that has already gone is not replaced', async () => {
  scriptSession();
  assert.equal(await tabs.replaceSessionTab(404), null);
});

test('sessionForTab names the session holding a tab', async () => {
  scriptSession();
  const found = await tabs.sessionForTab(11);
  assert.equal(found.clientId, 'sessionA');
  assert.equal(found.groupId, 43);
  assert.equal(await tabs.sessionForTab(404), null);
});
