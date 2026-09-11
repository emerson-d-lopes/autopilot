// The shortcut store behind shortcuts_list and shortcuts_execute. The live
// test/shortcuts.test.js drives the whole path through a browser. These cover
// the normalization and lookup rules without one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, resetStorage } from './chrome-stub.js';

installChromeStub();
const shortcuts = await import('../extension/src/lib/shortcuts.js');

test.beforeEach(() => resetStorage());

test('list is empty when nothing was saved', async () => {
  assert.deepEqual(await shortcuts.list(), []);
});

test('list ignores a stored value that is not an array', async () => {
  await chrome.storage.local.set({ shortcuts: { id: 'x', script: 'P' } });
  assert.deepEqual(await shortcuts.list(), []);
});

test('list fills in id, name and description, in stored order', async () => {
  await shortcuts.save([
    { script: 'P' },
    { id: 'login', script: 'F ref_1 me\nC ref_2' },
    { name: 'Search', description: 'Runs a search', script: 'N https://example.com' },
  ]);
  const all = await shortcuts.list();
  assert.deepEqual(all, [
    { id: 'sc1', name: 'shortcut 1', description: '', script: 'P' },
    { id: 'login', name: 'login', description: '', script: 'F ref_1 me\nC ref_2' },
    { id: 'sc3', name: 'Search', description: 'Runs a search', script: 'N https://example.com' },
  ]);
});

test('list drops entries with an empty script', async () => {
  await shortcuts.save([{ id: 'a', script: '   ' }, { id: 'b', script: 'P' }, { id: 'c' }]);
  assert.deepEqual(
    (await shortcuts.list()).map((s) => s.id),
    ['b']
  );
});

test('find matches the id first, then the name, case-insensitively', async () => {
  await shortcuts.save([
    { id: 'alpha', name: 'Beta', script: 'P' },
    { id: 'beta', name: 'Gamma', script: 'R' },
  ]);
  assert.equal((await shortcuts.find('BETA')).id, 'beta', 'an id match wins over a name match');
  assert.equal((await shortcuts.find('gamma')).id, 'beta');
  assert.equal((await shortcuts.find(' alpha ')).id, 'alpha', 'surrounding whitespace is ignored');
});

test('find returns null for an empty query or an unknown shortcut', async () => {
  await shortcuts.save([{ id: 'a', script: 'P' }]);
  assert.equal(await shortcuts.find(''), null);
  assert.equal(await shortcuts.find(undefined), null);
  assert.equal(await shortcuts.find('missing'), null);
});

test('save replaces the whole list', async () => {
  await shortcuts.save([{ id: 'a', script: 'P' }]);
  await shortcuts.save([{ id: 'b', script: 'R' }]);
  assert.deepEqual(
    (await shortcuts.list()).map((s) => s.id),
    ['b']
  );
});
