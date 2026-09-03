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
