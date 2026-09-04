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

// ---------------------------------------------------------------------------
// R7. Tabs a click opened
// ---------------------------------------------------------------------------

test('a tab opened by a session tab joins that session group, unselected', async () => {
  const { log } = scriptSession();

  const adopted = await tabs.adoptOpenedTab({ id: 77, openerTabId: 11, groupId: -1, windowId: 3 });

  assert.deepEqual(adopted, { openerTabId: 11, tabId: 77, tabGroupId: 43 });
  assert.deepEqual(log.grouped, { tabIds: [77], groupId: 43 });
  assert.equal(log.activated, undefined, 'the new tab is never activated');
  assert.deepEqual(tabs.adopted(11), [77]);
  assert.deepEqual(tabs.adopted(11), [], 'reading clears, so the next click reports only its own tabs');
});

test('the opener is recorded before anything is awaited', async () => {
  // The click that opened the tab reads this 250 ms later. Filling it only
  // after the session lookup and the group call had the read beat the write.
  scriptSession();
  tabs.noteOpenedTab({ id: 91, openerTabId: 11, groupId: -1, windowId: 3 });
  assert.deepEqual(tabs.adopted(11), [91], 'available without awaiting the grouping');
});

test('a tab opened by a tab no session owns is left alone', async () => {
  scriptSession({ groupId: 43, tab: { id: 11, url: 'https://x.test/', groupId: 99, windowId: 3, index: 0 } });
  tabs.noteOpenedTab({ id: 78, openerTabId: 11, groupId: -1 });
  assert.equal(await tabs.adoptOpenedTab({ id: 78, openerTabId: 11, groupId: -1 }), null);
  assert.deepEqual(tabs.adopted(11), [], 'the note is dropped once the opener turns out not to be a session tab');
});

test('a tab with no opener is not adopted', async () => {
  scriptSession();
  assert.equal(await tabs.adoptOpenedTab({ id: 79, groupId: -1 }), null);
  assert.equal(await tabs.adoptOpenedTab(null), null);
});

test('two tabs from one click are both reported, and a closed one is forgotten', async () => {
  scriptSession();
  await tabs.adoptOpenedTab({ id: 81, openerTabId: 11, groupId: -1 });
  await tabs.adoptOpenedTab({ id: 82, openerTabId: 11, groupId: -1 });
  await tabs.adoptOpenedTab({ id: 82, openerTabId: 11, groupId: -1 });
  assert.deepEqual(tabs.adopted(11), [81, 82], 'the same tab is not counted twice');

  await tabs.adoptOpenedTab({ id: 83, openerTabId: 11, groupId: -1 });
  tabs.forgetAdopted(83);
  assert.deepEqual(tabs.adopted(11), []);
});
