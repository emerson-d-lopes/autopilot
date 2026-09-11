// Browser selection. Every form select_browser accepts, plus the two cases the
// caller has to be told about rather than guessed at: nothing matched, and more
// than one thing matched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const REGISTRY_DIR = mkdtempSync(join(tmpdir(), 'autopilot-registry-'));
process.env.AUTOPILOT_REGISTRY_DIR = REGISTRY_DIR;

const {
  selectBrowser,
  matchesSelector,
  parseSelectorString,
  describeBrowser,
  isLocal,
  isDev,
  writeEntry,
  removeEntry,
  pickDefault,
} = await import('../host/registry.js');

const DEV_ID = 'bdev0001';

function browser(overrides = {}) {
  return {
    id: 'b0000001',
    name: 'Chrome',
    version: '141.0.0.0',
    label: '',
    host: hostname(),
    socket: '\\\\.\\pipe\\fake',
    account: { email: '', id: '' },
    profile: { directory: 'Default', name: null, userName: null, gaiaName: null, reason: null },
    sessions: [],
    ...overrides,
  };
}

const personal = browser({
  id: 'bpersonal',
  label: 'Personal',
  account: { email: 'me@gmail.com', id: 'g1' },
  profile: { directory: 'Default', name: 'Personal', userName: 'me@gmail.com', gaiaName: 'Me Myself' },
  sessions: ['linkedin.com', 'reddit.com'],
});

const work = browser({
  id: 'bwork0001',
  label: 'Work Chrome',
  name: 'Edge',
  account: { email: 'work@example.com', id: 'g2' },
  profile: { directory: 'Profile 2', name: 'Work', userName: 'work@example.com', gaiaName: 'Work Account' },
  sessions: ['github.com', 'notion.so'],
});

const spare = browser({
  id: 'bspare001',
  profile: { directory: 'Profile 3', name: 'Spare', userName: null, gaiaName: null },
  sessions: [],
});

const dev = browser({
  id: DEV_ID,
  name: 'Chrome (headless)',
  profile: { directory: 'Default', name: null, userName: null, gaiaName: null },
  sessions: ['linkedin.com'],
});

const ALL = [personal, work, spare, dev];
const opts = { devId: DEV_ID };

test('selects by browserId', () => {
  assert.equal(selectBrowser(ALL, { browserId: 'bwork0001' }, opts).id, 'bwork0001');
});

test('selects by label, case insensitively', () => {
  assert.equal(selectBrowser(ALL, { label: 'work chrome' }, opts).id, 'bwork0001');
});

test('selects by profile directory and by profile display name', () => {
  assert.equal(selectBrowser(ALL, { profile: 'Profile 2' }, opts).id, 'bwork0001');
  assert.equal(selectBrowser(ALL, { profile: 'Personal' }, opts).id, 'bpersonal');
});

test('selects by account email', () => {
  assert.equal(selectBrowser(ALL, { account: 'work@example.com' }, opts).id, 'bwork0001');
});

test('selects by site', () => {
  assert.equal(selectBrowser(ALL, { site: 'github.com' }, opts).id, 'bwork0001');
  assert.equal(selectBrowser(ALL, { site: 'https://www.reddit.com/r/x' }, opts).id, 'bpersonal');
});

test('a bare string is tried against every identity field', () => {
  assert.equal(selectBrowser(ALL, 'Work Chrome', opts).id, 'bwork0001');
  assert.equal(selectBrowser(ALL, 'bpersonal', opts).id, 'bpersonal');
  assert.equal(selectBrowser(ALL, 'me@gmail.com', opts).id, 'bpersonal');
  assert.equal(selectBrowser(ALL, 'Profile 3', opts).id, 'bspare001');
});

test('a bare domain falls back to a site match', () => {
  assert.equal(selectBrowser(ALL, 'notion.so', opts).id, 'bwork0001');
});

test('two keys have to match together', () => {
  assert.equal(selectBrowser(ALL, { profile: 'Work', account: 'work@example.com' }, opts).id, 'bwork0001');
  assert.throws(
    () => selectBrowser(ALL, { profile: 'Work', account: 'me@gmail.com' }, opts),
    (err) => {
      assert.equal(err.error.code, 'browser_unknown');
      return true;
    }
  );
});

test('a site with two candidates is profile_ambiguous and names both', () => {
  const second = browser({ id: 'bother001', label: 'Second', sessions: ['linkedin.com'] });
  assert.throws(
    () => selectBrowser([personal, second, work], { site: 'linkedin.com' }, opts),
    (err) => {
      assert.equal(err.error.code, 'profile_ambiguous');
      assert.match(err.message, /bpersonal/);
      assert.match(err.message, /bother001/);
      assert.equal(err.error.retryable, false);
      assert.equal(err.error.effects, 'none');
      return true;
    }
  );
});

test('a site nothing is signed into is browser_unknown, not a guess', () => {
  assert.throws(
    () => selectBrowser([spare, work], { site: 'linkedin.com' }, opts),
    (err) => {
      assert.equal(err.error.code, 'browser_unknown');
      assert.match(err.message, /site="linkedin.com"/);
      return true;
    }
  );
});

test('the development browser is never chosen by site, but is reachable by id', () => {
  // dev holds a linkedin session, personal does too. Excluding dev leaves one.
  assert.equal(selectBrowser([personal, dev], { site: 'linkedin.com' }, opts).id, 'bpersonal');
  assert.equal(selectBrowser([dev], { browserId: DEV_ID }, opts).id, DEV_ID);
  assert.throws(
    () => selectBrowser([dev], { site: 'linkedin.com' }, opts),
    (err) => {
      assert.equal(err.error.code, 'browser_unknown');
      return true;
    }
  );
});

test('an empty selector is browser_unknown rather than a default', () => {
  assert.throws(
    () => selectBrowser(ALL, {}, opts),
    (err) => {
      assert.equal(err.error.code, 'browser_unknown');
      return true;
    }
  );
});

test('two browsers sharing a label are ambiguous', () => {
  const twin = browser({ id: 'btwin0001', label: 'Personal' });
  assert.throws(
    () => selectBrowser([personal, twin], { label: 'Personal' }, opts),
    (err) => {
      assert.equal(err.error.code, 'profile_ambiguous');
      return true;
    }
  );
});

test('parseSelectorString reads the named forms and the bare form', () => {
  assert.deepEqual(parseSelectorString('site=linkedin.com'), { site: 'linkedin.com' });
  assert.deepEqual(parseSelectorString('site:linkedin.com'), { site: 'linkedin.com' });
  assert.deepEqual(parseSelectorString('profile = Work'), { profile: 'Work' });
  assert.deepEqual(parseSelectorString('account=me@example.com'), { account: 'me@example.com' });
  assert.deepEqual(parseSelectorString('browserId=b1'), { browserId: 'b1' });
  assert.deepEqual(parseSelectorString('Work Chrome'), { any: 'Work Chrome' });
  assert.equal(parseSelectorString('   '), null);
});

test('matchesSelector never matches an entry with no fields filled in', () => {
  assert.equal(matchesSelector(browser(), { profile: 'Work' }, opts), false);
  assert.equal(matchesSelector(browser(), { label: '' }, opts), false);
});

test('isLocal is true for this machine and false for a registry entry from another', () => {
  assert.equal(isLocal(personal), true);
  assert.equal(isLocal({ ...personal, host: 'some-other-box' }), false);
  // An entry written before the host field existed is treated as local.
  assert.equal(isLocal({ id: 'x' }), true);
});

test('isDev matches only the marker id', () => {
  assert.equal(isDev(dev, DEV_ID), true);
  assert.equal(isDev(personal, DEV_ID), false);
  assert.equal(isDev(dev, null), false);
});

test('describeBrowser names label, browser, profile and account', () => {
  const text = describeBrowser(work);
  assert.match(text, /Work Chrome/);
  assert.match(text, /Edge 141/);
  assert.match(text, /profile Profile 2 "Work"/);
  assert.match(text, /work@example.com/);
});

test('pickDefault still takes the single browser and the preferred id', () => {
  assert.equal(pickDefault([personal], null).id, 'bpersonal');
  assert.equal(pickDefault(ALL, 'bwork0001').id, 'bwork0001');
  assert.equal(pickDefault(ALL, null), null);
});

test('writeEntry records the profile, account and host on disk', () => {
  const entry = {
    id: 'bdisk0001',
    name: 'Chrome',
    version: '141',
    label: 'Disk',
    host: 'testbox',
    socket: 'pipe',
    account: { email: 'a@b.com', id: 'g9' },
    profile: { directory: 'Profile 7', name: 'Seven', userName: 'a@b.com', gaiaName: 'A B', reason: null },
  };
  writeEntry(entry);
  const written = JSON.parse(readFileSync(join(REGISTRY_DIR, 'bdisk0001.json'), 'utf8'));
  assert.equal(written.profile.directory, 'Profile 7');
  assert.equal(written.account.email, 'a@b.com');
  assert.equal(written.label, 'Disk');
  assert.equal(written.host, 'testbox');
  assert.ok(written.updatedAt > 0);
  removeEntry('bdisk0001');
});

test.after(() => rmSync(REGISTRY_DIR, { recursive: true, force: true }));
