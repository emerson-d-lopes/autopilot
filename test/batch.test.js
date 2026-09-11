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
stub.storage.session = {
  async get() {
    return {};
  },
  async set() {},
};
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
    return { id: 7, title: 'Autopilot' };
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
    () =>
      background.runBatch([item('tabs_context', {}), item('tabs_context', {}), item('scroll_page', { tabId: 1 })], ctx),
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

// ---------------------------------------------------------------------------
// The same check on a direct call
// ---------------------------------------------------------------------------

test('a direct call missing a required argument is refused before it runs', async () => {
  const { execute } = await import('../extension/src/lib/tools.js');
  await assert.rejects(
    () => execute('navigate', { tabId: 1 }, ctx),
    (err) => {
      assert.equal(err.code, 'bad_request');
      assert.equal(err.effects, 'none');
      assert.match(err.message, /navigate needs url/);
      assert.deepEqual(err.details.missing, ['url']);
      return true;
    },
    'navigate without a url used to drive the tab to https://undefined'
  );
  await assert.rejects(() => execute('form_input', { tabId: 1, ref: 'ref_1' }, ctx), /form_input needs value/);
  await assert.rejects(() => execute('computer', { action: 'left_click', ref: 'ref_1' }, ctx), /computer needs tabId/);
});

test('a direct call carrying every required argument is not refused by the check', async () => {
  const { execute } = await import('../extension/src/lib/tools.js');
  const { missingRequired } = await import('../extension/src/lib/required.js');
  assert.deepEqual(missingRequired('navigate', { tabId: 1, url: 'https://a.test/' }), []);
  // tabs_context declares nothing required and still runs.
  const result = await execute('tabs_context', {}, ctx);
  assert.ok(result);
});

test('a screenshot asked for an unknown stored image says where ids come from', async () => {
  const { execute } = await import('../extension/src/lib/tools.js');
  await assert.rejects(
    () => execute('computer', { tabId: 1, action: 'screenshot', imageId: 'write_nope' }, ctx),
    (err) => {
      assert.equal(err.code, 'bad_request');
      assert.match(err.message, /No stored image with id "write_nope"/);
      assert.match(err.message, /confirmation_required/);
      return true;
    }
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
  await assert.rejects(
    () => background.runBatch([], ctx),
    (err) => {
      assert.equal(err.code, 'batch_invalid');
      assert.match(err.message, /non-empty actions array/);
      return true;
    }
  );
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
    await background.validateBatch(
      [item('tabs_create', { url: 'https://a.test/' }), item('read_page', { tabId: '$last' })],
      ctx
    ),
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
    await background.validateBatch(
      [item('javascript_tool', { tabId: 1, action: 'javascript_exec', text: '1+1' })],
      ctx
    ),
    null
  );
  const bad = await background.validateBatch([item('javascript_tool', { tabId: 1, action: 'javascript_exec' })], ctx);
  assert.match(bad.message, /is missing code/);
});

// ---------------------------------------------------------------------------
// Open bug 5: refs are pre-validated too
// ---------------------------------------------------------------------------
//
// A batch with a stale ref at item 5 ran items 1 to 4 and stopped at item 5,
// because a ref was only resolved when its action executed. Every ref the batch
// names is resolved before item one runs.

/** Answers RESOLVE_REF for a fixed set of live refs and logs what was asked. */
function scriptRefs(live) {
  const asked = [];
  stub.tabs.sendMessage = async (tabId, message) => {
    if (message.type !== 'RESOLVE_REF') return {};
    asked.push({ tabId, ref: message.ref });
    if (live.includes(message.ref)) return { ok: true, geometry: { width: 10, height: 10, inViewport: true } };
    return { error: 'ref ' + message.ref + ' is no longer on the page. Re-read the page.', code: 'ref_stale' };
  };
  return asked;
}

test('a stale ref anywhere in the batch stops it before the first item runs', async () => {
  queries = 0;
  scriptRefs(['ref_1', 'ref_2']);

  await assert.rejects(
    () =>
      background.runBatch(
        [
          item('tabs_context', {}),
          item('computer', { tabId: 1, action: 'left_click', ref: 'ref_1' }),
          item('computer', { tabId: 1, action: 'left_click', ref: 'ref_2' }),
          item('computer', { tabId: 1, action: 'left_click', ref: 'ref_99999' }),
        ],
        ctx
      ),
    (err) => {
      assert.equal(err.code, 'batch_invalid');
      assert.equal(err.effects, 'none');
      assert.match(err.message, /item 4 \(computer\) names ref_99999, which is no longer on the page in tab 1/);
      assert.match(err.hint, /Read the page again/);
      assert.equal(err.details.index, 3);
      assert.equal(err.details.ref, 'ref_99999');
      assert.equal(err.details.tabId, 1);
      return true;
    }
  );
  assert.equal(queries, 0, 'the three items before it never ran');
});

test('every distinct ref is resolved once, and a batch of live refs runs', async () => {
  queries = 0;
  const asked = scriptRefs(['ref_1', 'ref_2']);

  assert.equal(
    await background.validateBatch(
      [
        item('computer', { tabId: 1, action: 'left_click', ref: 'ref_1' }),
        item('form_input', { tabId: 1, ref: 'ref_2', value: 'x' }),
        item('computer', { tabId: 1, action: 'left_click', ref: 'ref_1' }),
      ],
      ctx
    ),
    null
  );
  assert.deepEqual(
    asked.map((a) => a.ref),
    ['ref_1', 'ref_2'],
    'the repeated ref was resolved once'
  );
});

test('a ref an earlier item in the batch is about to create is not pre-validated', async () => {
  const asked = scriptRefs([]);

  assert.equal(
    await background.validateBatch(
      [item('read_page', { tabId: 1 }), item('computer', { tabId: 1, action: 'left_click', ref: 'ref_7' })],
      ctx
    ),
    null,
    'a read_page on the same tab exempts the items after it'
  );
  assert.deepEqual(asked, [], 'nothing was resolved against a tree that is about to be rebuilt');

  assert.equal(
    await background.validateBatch(
      [
        item('find', { tabId: 1, query: 'the save button' }),
        item('computer', { tabId: 1, action: 'left_click', ref: 'ref_7' }),
      ],
      ctx
    ),
    null,
    'find refreshes the tree the same way'
  );
});

test('a read_page on another tab does not exempt a stale ref on this one', async () => {
  scriptRefs([]);
  const err = await background.validateBatch(
    [item('read_page', { tabId: 2 }), item('computer', { tabId: 1, action: 'left_click', ref: 'ref_7' })],
    { clientId: 'default' }
  );
  // Tab 2 is outside the session, so that check fires first. Reordered, the ref
  // check is the one that fires.
  assert.match(err.message, /targets tab 2/);

  const refErr = await background.validateBatch(
    [item('computer', { tabId: 1, action: 'left_click', ref: 'ref_7' })],
    ctx
  );
  assert.equal(refErr.code, 'batch_invalid');
  assert.match(refErr.message, /names ref_7/);
});

test('a page that cannot answer does not turn into a batch refusal', async () => {
  stub.tabs.sendMessage = async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  stub.scripting = { async executeScript() {} };
  assert.equal(
    await background.validateBatch([item('computer', { tabId: 1, action: 'left_click', ref: 'ref_1' })], ctx),
    null
  );
  stub.tabs.sendMessage = async () => ({});
});
