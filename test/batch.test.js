// browser_batch pre-validation.
//
// A batch used to be validated as it went, so a typo in item five cost the side
// effects of items one to four with no way to undo them. Everything knowable up
// front is checked before the first item runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

const stub = installChromeStub();

// The service worker registers unload handlers, which node does not have.
globalThis.self = { addEventListener() {} };
stub.storage.session = { async get() { return {}; }, async set() {} };
stub.runtime.onStartup = { addListener() {} };
stub.runtime.onInstalled = { addListener() {} };

// The session owns group 7, which holds tab 1. Tab 2 belongs to the user.
let queries = 0;
stub.storage.local.get = async () => ({ tabGroups: { default: 7 } });
stub.storage.local.set = async () => {};
stub.tabGroups = {
  TAB_GROUP_ID_NONE: -1,
  async get(id) {
    if (id !== 7) throw new Error('no group ' + id);
    return { id: 7, title: 'chrome-mcp' };
  },
  async update() {},
};
stub.tabs.get = async (id) => {
  if (id === 1) return { id: 1, url: 'https://a.test/', groupId: 7, windowId: 1, status: 'complete' };
  if (id === 2) return { id: 2, url: 'https://b.test/', groupId: 99, windowId: 1, status: 'complete' };
  throw new Error('No tab with id ' + id);
};
stub.tabs.query = async () => {
  queries++;
  return [{ id: 1, url: 'https://a.test/', groupId: 7, windowId: 1, status: 'complete', active: false }];
};

const background = await import('../extension/src/background.js');

const ctx = { clientId: 'default' };
const item = (name, input) => ({ name, input });

test('an unknown tool anywhere in the batch stops it before the first item runs', async () => {
  queries = 0;
  await assert.rejects(
    () => background.runBatch([item('tabs_context', {}), item('tabs_context', {}), item('scroll_page', { tabId: 1 })], ctx),
    (err) => {
      assert.equal(err.code, 'batch_invalid');
      assert.equal(err.effects, 'none');
      assert.match(err.message, /item 3 \(scroll_page\) names no known tool/);
      assert.equal(err.details.index, 2);
      return true;
    }
  );
  assert.equal(queries, 0, 'the two valid items never ran');
});

test('a missing required argument names the item', async () => {
  await assert.rejects(
    () => background.runBatch([item('navigate', { tabId: 1 })], ctx),
    (err) => {
      assert.equal(err.code, 'batch_invalid');
      assert.match(err.message, /item 1 \(navigate\) is missing url/);
      return true;
    }
  );
  await assert.rejects(
    () => background.runBatch([item('computer', { action: 'left_click', ref: 'ref_1' })], ctx),
    /item 1 \(computer\) is missing tabId/
  );
});

test('an unknown computer action is caught before anything is dispatched', async () => {
  await assert.rejects(
    () => background.runBatch([item('computer', { tabId: 1, action: 'left_clik', ref: 'ref_1' })], ctx),
    (err) => {
      assert.match(err.message, /unknown computer action "left_clik"/);
      assert.match(err.hint, /left_click/);
      return true;
    }
  );
});

test('a tab outside the session group fails the whole batch', async () => {
  queries = 0;
  await assert.rejects(
    () => background.runBatch([item('tabs_context', {}), item('read_page', { tabId: 2 })], ctx),
    (err) => {
      assert.equal(err.code, 'batch_invalid');
      assert.match(err.message, /item 2 \(read_page\) targets tab 2 which this session cannot drive/);
      assert.match(err.message, /not in this session's tab group/);
      return true;
    }
  );
  assert.equal(queries, 0, 'nothing ran');
});

test('an empty batch is refused', async () => {
  await assert.rejects(() => background.runBatch([], ctx), (err) => {
    assert.equal(err.code, 'batch_invalid');
    assert.match(err.message, /non-empty actions array/);
    return true;
  });
});

test('a valid batch passes validation and runs every item', async () => {
  queries = 0;
  assert.equal(await background.validateBatch([item('tabs_context', {}), item('read_page', { tabId: 1 })], ctx), null);
  const result = await background.runBatch([item('tabs_context', {}), item('tabs_context', {})], ctx);
  assert.equal(result.completed, true);
  assert.equal(result.results.length, 2);
  assert.ok(queries >= 2, 'both items ran');
});

test('a tabId created earlier in the same batch is accepted', async () => {
  assert.equal(
    await background.validateBatch([item('tabs_create', { url: 'https://a.test/' }), item('read_page', { tabId: '$last' })], ctx),
    null
  );
  assert.equal(
    await background.validateBatch([item('tabs_create', { url: 'https://a.test/' }), item('read_page', {})], ctx),
    null,
    'an item after a tabs_create may leave the tab to the runner'
  );
});

test('a call written for the other extension is normalized before it is judged', async () => {
  assert.equal(
    await background.validateBatch([item('javascript_tool', { tabId: 1, action: 'javascript_exec', text: '1+1' })], ctx),
    null
  );
  const bad = await background.validateBatch([item('javascript_tool', { tabId: 1, action: 'javascript_exec' })], ctx);
  assert.match(bad.message, /is missing code/);
});
