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
  assert.deepEqual(updates[0], [42, { title: '\u23F3 Autopilot', color: 'blue' }]);
  await tabs.setGroupStatus('c9', 'done');
  assert.deepEqual(updates[1][1], { title: '\u2705 Autopilot', color: 'green' });
  await tabs.setGroupStatus('c9', 'error');
  assert.deepEqual(updates[2][1], { title: '\u274C Autopilot', color: 'red' });
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

// ---------------------------------------------------------------------------
// F4. Stop/Resume and the acting-indicator broadcast
// ---------------------------------------------------------------------------

/** A session with two tabs in the same group, for the indicator broadcast. */
function scriptIndicatorSession({ clientId = 'sessionStop', groupId = 50 } = {}) {
  const groupTabs = [
    { id: 201, groupId, windowId: 9 },
    { id: 202, groupId, windowId: 9 },
  ];
  const sent = [];
  stub.storage = {
    local: {
      async get() {
        return { tabGroups: { [clientId]: groupId } };
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
    async query({ groupId: gid }) {
      return gid === groupId ? groupTabs : [];
    },
    async sendMessage(tabId, message) {
      sent.push({ tabId, state: message.state });
      return {};
    },
  };
  return { clientId, groupTabs, sent };
}

test('beginActive shows pulsing on the acting tab and static on the rest of the session', async () => {
  const { clientId, sent } = scriptIndicatorSession();
  assert.equal(tabs.isSessionActive(clientId), false);

  await tabs.beginActive(clientId, 201);

  assert.equal(tabs.isSessionActive(clientId), true);
  const byTab = Object.fromEntries(sent.map((s) => [s.tabId, s.state]));
  assert.equal(byTab[201], 'pulsing');
  assert.equal(byTab[202], 'static');
});

test('endActive clears the active tab and hides the indicator everywhere', async () => {
  const { clientId, sent } = scriptIndicatorSession();
  await tabs.beginActive(clientId, 201);
  sent.length = 0;

  await tabs.endActive(clientId);

  assert.equal(tabs.isSessionActive(clientId), false);
  const byTab = Object.fromEntries(sent.map((s) => [s.tabId, s.state]));
  assert.equal(byTab[201], 'none');
  assert.equal(byTab[202], 'none');
});

test('stopSession marks the session stopped and leaves a stopped pill on the acted-on tab', async () => {
  const { clientId, sent } = scriptIndicatorSession({ clientId: 'sessionStop2', groupId: 51 });
  await tabs.beginActive(clientId, 201);
  sent.length = 0;

  assert.equal(tabs.isStopped(clientId), false);
  await tabs.stopSession(clientId);
  assert.equal(tabs.isStopped(clientId), true);

  const byTab = Object.fromEntries(sent.map((s) => [s.tabId, s.state]));
  assert.equal(byTab[201], 'stopped', 'the tab a call was acting on shows the stopped pill');
  assert.equal(byTab[202], 'none', 'a session tab that was never active shows nothing');
});

test('resumeSession clears the stopped state and hides the pill', async () => {
  const { clientId, sent } = scriptIndicatorSession({ clientId: 'sessionStop3', groupId: 52 });
  await tabs.beginActive(clientId, 201);
  await tabs.stopSession(clientId);
  sent.length = 0;

  await tabs.resumeSession(clientId);

  assert.equal(tabs.isStopped(clientId), false);
  const byTab = Object.fromEntries(sent.map((s) => [s.tabId, s.state]));
  assert.equal(byTab[201], 'none');
  assert.equal(byTab[202], 'none');
});

test('a session that was never started is not stopped and has no active tab', () => {
  assert.equal(tabs.isStopped('never-seen'), false);
  assert.equal(tabs.isSessionActive('never-seen'), false);
});

// ---------------------------------------------------------------------------
// Open bug 10: a session survives an extension reload
// ---------------------------------------------------------------------------
//
// chrome.runtime.reload() threw the worker away with its state, so
// tabs_context came back with no tabs and the ids the caller held reported
// that they had been closed. The session table is written on every change and
// read back at worker start.

/** Two storage areas and a browser holding the given tabs, one group. */
function scriptBrowser({ openTabs = [11, 12], groupId = 77 } = {}) {
  const local = new Map([['browserId', 'bw-test']]);
  const session = new Map();
  const grouped = new Map(openTabs.map((id) => [id, groupId]));
  const groupCalls = [];
  const activations = [];

  const area = (map) => ({
    async get(key) {
      if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
      return Object.fromEntries(map);
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async clear() {
      map.clear();
    },
  });

  stub.storage = { local: area(local), session: area(session), onChanged: { addListener() {} } };
  stub.tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    async get(id) {
      if (![...grouped.values()].includes(id)) throw new Error('no group ' + id);
      return { id, title: 'Autopilot' };
    },
    async update() {},
  };
  stub.tabs.get = async (id) => {
    if (!grouped.has(id)) throw new Error('No tab with id ' + id);
    return {
      id,
      url: 'https://a.test/' + id,
      title: 'tab ' + id,
      groupId: grouped.get(id),
      windowId: 1,
      status: 'complete',
    };
  };
  stub.tabs.query = async ({ groupId: q }) =>
    [...grouped.entries()]
      .filter(([, g]) => g === q)
      .map(([id, g]) => ({
        id,
        url: 'https://a.test/' + id,
        title: 'tab ' + id,
        groupId: g,
        windowId: 1,
        status: 'complete',
      }));
  stub.tabs.group = async ({ tabIds, groupId: g }) => {
    const target = g === undefined ? groupId : g;
    groupCalls.push({ tabIds: [...tabIds], groupId: g });
    for (const id of tabIds) grouped.set(id, target);
    return target;
  };
  stub.tabs.update = async (id, props) => {
    activations.push({ id, props });
  };

  return {
    local,
    session,
    groupCalls,
    activations,
    close: (id) => grouped.delete(id),
    ungroup: (id) => grouped.set(id, -1),
  };
}

test('the session table is written on every change and names the tabs, group and browser', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();

  await tabs.adoptTab('c1', 11);
  const table = browser.session.get('sessionTable');

  assert.ok(table, 'the table is in chrome.storage.session');
  assert.deepEqual(table.c1.tabIds, [11, 12]);
  assert.equal(table.c1.groupId, 77);
  assert.equal(table.c1.browserId, 'bw-test');
  assert.deepEqual(
    browser.local.get('sessionTable'),
    table,
    'and in local, which is what survives a reload of the extension'
  );
});

test('a worker restart puts the tabs that still exist back in the session', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  // The reload: the worker's memory and the session storage area both go.
  tabs.resetSessionTable();
  browser.session.clear();
  browser.ungroup(12);

  const restored = await tabs.restoreSessions();
  assert.equal(restored.tabs, 2, 'both tabs still exist');
  assert.equal(restored.missing, 0);
  assert.deepEqual(
    browser.groupCalls[browser.groupCalls.length - 1],
    { tabIds: [12], groupId: 77 },
    'the tab that fell out of the group was put back, and only that one'
  );
  assert.deepEqual(browser.activations, [], 'nothing was activated');

  const context = await tabs.tabsContext('c1');
  assert.equal(context.tabGroupId, 77);
  assert.deepEqual(
    context.tabs.map((t) => t.tabId),
    [11, 12],
    'the session kept its tabs'
  );
  assert.equal(context.missingTabs, undefined);
});

test('a worker restart with no extension reload restores from the session area', async () => {
  // Chrome stops an idle worker after 30 s and starts it again for the next
  // event. The extension was never reloaded, so storage.session still holds the
  // table and the local copy is not what answers. Bug 3 from the third pass.
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  tabs.resetSessionTable();
  browser.local.delete('sessionTable');
  browser.ungroup(12);

  const restored = await tabs.restoreSessions();
  assert.equal(restored.tabs, 2, 'the session area carried both tabs');
  assert.equal(restored.missing, 0);
  assert.deepEqual(
    browser.groupCalls[browser.groupCalls.length - 1],
    { tabIds: [12], groupId: 77 },
    'the tab that fell out of the group was put back'
  );
  assert.deepEqual(browser.activations, [], 'nothing was activated');

  const context = await tabs.tabsContext('c1');
  assert.deepEqual(
    context.tabs.map((t) => t.tabId),
    [11, 12]
  );
});

test('the call that wakes the worker waits for the restore before writing the table', async () => {
  // The waking call runs against empty maps, so recordSession used to persist a
  // table holding only its own session and drop every other one.
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  const withSecond = {
    ...browser.session.get('sessionTable'),
    c2: { tabIds: [], groupId: null, browserId: 'bw-test', at: Date.now() },
  };
  browser.session.set('sessionTable', withSecond);
  browser.local.set('sessionTable', withSecond);

  // The worker restarts and the first call is not tabs_context.
  tabs.resetSessionTable();
  await tabs.recordSession('c1');

  const written = browser.local.get('sessionTable');
  assert.ok(written.c2, 'the other session is still in the table: ' + Object.keys(written).join(', '));
  assert.deepEqual(written.c1.tabIds, [11, 12], 'and this session kept its tabs');
});

test('the restore runs once per worker, however many calls arrive together', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);
  tabs.resetSessionTable();

  let reads = 0;
  const inner = stub.storage.session.get;
  stub.storage.session.get = async (key) => {
    if (key === 'sessionTable') reads += 1;
    return inner(key);
  };

  await Promise.all([tabs.getSessionGroupId('c1'), tabs.tabsContext('c1'), tabs.recordSession('c1')]);
  stub.storage.session.get = inner;

  assert.equal(reads, 1, 'the table was read once, not once per call');
  assert.deepEqual(browser.activations, []);
});

test('a tab that did not survive the restart is reported once', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  tabs.resetSessionTable();
  browser.session.clear();
  browser.close(12);

  const restored = await tabs.restoreSessions();
  assert.equal(restored.missing, 1);

  const first = await tabs.tabsContext('c1');
  assert.deepEqual(first.missingTabs, [12]);
  assert.ok(
    first.warnings.some((w) => /tab 12 did not survive the extension restart/.test(w)),
    'warnings: ' + first.warnings.join(' | ')
  );
  assert.deepEqual(
    first.tabs.map((t) => t.tabId),
    [11]
  );

  const second = await tabs.tabsContext('c1');
  assert.equal(second.missingTabs, undefined, 'reported once, not on every listing');
  assert.deepEqual(second.warnings, []);
});

test('a closed tab leaves the table, so a later restart does not report it', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  browser.close(12);
  await tabs.forgetRemovedTab(12);
  assert.deepEqual(browser.local.get('sessionTable').c1.tabIds, [11]);

  tabs.resetSessionTable();
  browser.session.clear();
  const restored = await tabs.restoreSessions();
  assert.equal(restored.missing, 0, 'a tab the session watched close is not a loss to report');
});

test('a restart with nothing stored is a session with no tabs, not an error', async () => {
  tabs.resetSessionTable();
  scriptBrowser({ openTabs: [] });
  const restored = await tabs.restoreSessions();
  assert.deepEqual(restored, { sessions: 0, tabs: 0, missing: 0 });
  const context = await tabs.tabsContext('c1');
  assert.deepEqual(context.tabs, []);
});

// ---------------------------------------------------------------------------
// Check 13: a session across a service worker restart
// ---------------------------------------------------------------------------
//
// Stopping the worker from chrome://serviceworker-internals lost the session.
// The restarted worker rewrote the persisted record to {groupId: null,
// tabIds: []} about 18 s after the stop with no tool call, so the restore that
// mattered read an empty record and tabs_context listed nothing while both
// tabs were still open. Emptying a record is proved now, and the proof is
// every tab id in it answering that it is gone.

/** Makes the first read of the session table from each area fail, the way a restart can. */
function failFirstTableRead() {
  for (const area of [stub.storage.session, stub.storage.local]) {
    const inner = area.get.bind(area);
    let failed = false;
    area.get = async (key) => {
      if (key === 'sessionTable' && !failed) {
        failed = true;
        throw new Error('storage is not ready');
      }
      return inner(key);
    };
  }
}

test('a restart whose restore reads nothing keeps the record the browser still has tabs for', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);
  assert.deepEqual(browser.local.get('sessionTable').c1.tabIds, [11, 12], 'the record starts full');

  // The worker is stopped and started again: its maps are empty, the table is
  // still on disk, and the first thing that runs is a tab event, not a call.
  tabs.resetSessionTable();
  failFirstTableRead();
  await tabs.forgetRemovedTab(4242);

  const written = browser.local.get('sessionTable');
  assert.ok(written.c1, 'the record survived a restore that computed nothing');
  assert.deepEqual(written.c1.tabIds, [11, 12], 'with both tab ids');
  assert.equal(written.c1.groupId, 77, 'and its group');
  assert.deepEqual(browser.activations, [], 'nothing was activated');
});

test('a tabs_context after that restart lists the tabs under their old ids', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  // The group map goes too, so the session table is the only route back.
  tabs.resetSessionTable();
  browser.local.delete('tabGroups');
  failFirstTableRead();
  await tabs.forgetRemovedTab(4242);

  const context = await tabs.tabsContext('c1');
  assert.equal(context.tabGroupId, 77, 'the group came back');
  assert.deepEqual(
    context.tabs.map((t) => t.tabId),
    [11, 12],
    'and the ids the caller is holding'
  );
  assert.equal(context.missingTabs, undefined, 'nothing went away, so nothing is reported missing');
  assert.deepEqual(browser.activations, []);
});

test('a browser that will not answer about a tab keeps it rather than dropping it', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  tabs.resetSessionTable();
  browser.session.clear();
  const inner = stub.tabs.get;
  stub.tabs.get = async (id) => {
    if (id === 12) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    return inner(id);
  };

  const restored = await tabs.restoreSessions();
  stub.tabs.get = inner;
  assert.equal(restored.missing, 0, 'a refused lookup is not a tab that went away');
  assert.deepEqual(
    browser.local.get('sessionTable').c1.tabIds,
    [11, 12],
    'the id stays in the record so the next restore can ask again'
  );
});

test('a session whose tabs the user really closed still empties', async () => {
  tabs.resetSessionTable();
  const browser = scriptBrowser();
  await tabs.adoptTab('c1', 11);

  browser.close(11);
  browser.close(12);
  await tabs.recordSession('c1');

  assert.deepEqual(
    browser.local.get('sessionTable').c1.tabIds,
    [],
    'both tabs answered that they are gone, so the empty write stands'
  );
});
