// The session-cookie table and the heuristic behind sessions_for.
//
// The cookie jar is a stub, so the suite asserts on the matching rules rather
// than on whatever the machine running it happens to be signed into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

installChromeStub();

/** A jar keyed by the domain chrome.cookies.getAll is called with. */
let jar = {};
let lastQuery = null;
globalThis.chrome.cookies = {
  async getAll(query) {
    lastQuery = query;
    return jar[query.domain] || [];
  },
};

const {
  SESSION_COOKIES,
  SESSION_DOMAINS,
  registrableDomain,
  looksLikeLoginCookie,
  hasSession,
  listSessions,
  sessionsFor,
} = await import('../extension/src/lib/sessions.js');

const future = Math.floor(Date.now() / 1000) + 86400;
const cookie = (name, extra = {}) => ({
  name,
  value: 'secret-value',
  secure: true,
  httpOnly: true,
  session: false,
  expirationDate: future,
  ...extra,
});

test('the table covers every site the plan names', () => {
  for (const domain of [
    'linkedin.com', 'github.com', 'google.com', 'x.com', 'notion.so',
    'reddit.com', 'amazon.com', 'facebook.com', 'instagram.com',
  ]) {
    assert.ok(SESSION_DOMAINS.includes(domain), domain + ' is missing from the table');
  }
  assert.deepEqual(SESSION_COOKIES['linkedin.com'], [{ name: 'li_at' }]);
  assert.deepEqual(SESSION_COOKIES['github.com'], [{ name: 'logged_in', value: 'yes' }, { name: 'user_session' }]);
});

test('a table domain matches on its cookie name', async () => {
  jar = { 'linkedin.com': [cookie('li_at'), cookie('bcookie')] };
  assert.equal(await hasSession('linkedin.com'), true);

  jar = { 'linkedin.com': [cookie('bcookie')] };
  assert.equal(await hasSession('linkedin.com'), false);
});

test('github needs logged_in=yes or user_session', async () => {
  jar = { 'github.com': [cookie('logged_in', { value: 'yes' })] };
  assert.equal(await hasSession('github.com'), true);

  jar = { 'github.com': [cookie('logged_in', { value: 'no' })] };
  assert.equal(await hasSession('github.com'), false);

  jar = { 'github.com': [cookie('logged_in', { value: 'no' }), cookie('user_session')] };
  assert.equal(await hasSession('github.com'), true);
});

test('listSessions reports every table domain with a session', async () => {
  jar = {
    'linkedin.com': [cookie('li_at')],
    'github.com': [cookie('user_session')],
    'x.com': [cookie('guest_id')],
    'amazon.com': [cookie('x-main')],
  };
  const found = await listSessions();
  assert.deepEqual(found, ['linkedin.com', 'github.com', 'amazon.com']);
});

test('listSessions can be narrowed, and ignores domains outside the table', async () => {
  jar = { 'linkedin.com': [cookie('li_at')], 'github.com': [cookie('user_session')] };
  assert.deepEqual(await listSessions(['github.com']), ['github.com']);
  assert.deepEqual(await listSessions(['example.com']), []);
});

test('listSessions is empty when nothing is signed in', async () => {
  jar = {};
  assert.deepEqual(await listSessions(), []);
});

test('a missing cookies permission reports nothing rather than throwing', async () => {
  const saved = globalThis.chrome.cookies;
  globalThis.chrome.cookies = {
    async getAll() {
      throw new Error('"cookies" permission is required');
    },
  };
  assert.deepEqual(await listSessions(), []);
  const heuristic = await sessionsFor('https://example.com');
  assert.equal(heuristic.likely, false);
  globalThis.chrome.cookies = saved;
});

test('sessionsFor gives a definite answer for a table domain', async () => {
  jar = { 'linkedin.com': [cookie('li_at')] };
  const result = await sessionsFor('https://www.linkedin.com/feed/');
  assert.deepEqual(result, { domain: 'linkedin.com', likely: true, heuristic: false });
});

test('sessionsFor marks an off-table domain as a heuristic', async () => {
  jar = { 'example.com': [cookie('sid'), cookie('theme', { httpOnly: false })] };
  const result = await sessionsFor('https://app.example.com/dashboard');
  assert.equal(result.domain, 'example.com');
  assert.equal(result.likely, true);
  assert.equal(result.heuristic, true);
  assert.deepEqual(result.cookies, ['sid']);
});

test('the heuristic ignores cookies that are not shaped like a login', async () => {
  jar = {
    'example.com': [
      cookie('a', { secure: false }),
      cookie('b', { httpOnly: false }),
      cookie('c', { session: true }),
      cookie('d', { expirationDate: undefined }),
      cookie('e', { expirationDate: Math.floor(Date.now() / 1000) - 10 }),
    ],
  };
  const result = await sessionsFor('example.com');
  assert.equal(result.likely, false);
  assert.deepEqual(result.cookies, []);
});

test('no cookie value ever leaves the module', async () => {
  jar = { 'example.com': [cookie('sid')] };
  const result = await sessionsFor('example.com');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);

  jar = { 'linkedin.com': [cookie('li_at')] };
  const table = await sessionsFor('linkedin.com');
  assert.equal(JSON.stringify(table).includes('secret-value'), false);
  assert.equal('cookies' in table, false);
});

test('the jar is queried by registrable domain, not by the full host', async () => {
  jar = { 'example.com': [] };
  await sessionsFor('https://deep.sub.example.com/x');
  assert.equal(lastQuery.domain, 'example.com');
});

test('registrableDomain strips subdomains and handles two-level suffixes', () => {
  assert.equal(registrableDomain('https://www.linkedin.com/in/x'), 'linkedin.com');
  assert.equal(registrableDomain('sub.deep.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('loja.exemplo.com.br'), 'exemplo.com.br');
  assert.equal(registrableDomain('LinkedIn.com'), 'linkedin.com');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain(null), null);
});

test('looksLikeLoginCookie wants secure, httpOnly and a real expiry', () => {
  assert.equal(looksLikeLoginCookie(cookie('a')), true);
  assert.equal(looksLikeLoginCookie(cookie('a', { secure: false })), false);
  assert.equal(looksLikeLoginCookie(cookie('a', { httpOnly: false })), false);
  assert.equal(looksLikeLoginCookie(cookie('a', { session: true })), false);
  assert.equal(looksLikeLoginCookie(null), false);
});
