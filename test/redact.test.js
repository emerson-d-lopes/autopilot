// F2 redaction and the S5 and S6 output caps, all on the host read path.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactValue,
  capValue,
  prepareScriptValue,
  applyCaps,
  credentialShape,
  looksLikeJwt,
  looksLikeHexToken,
  looksLikeBase64Blob,
  looksLikeCookieString,
  STRING_CAP,
  ARRAY_CAP,
  SERIALIZED_CAP,
  URL_CAP,
  MESSAGE_CAP,
} from '../host/redact.js';

// --- F2, keyed on the shape of the value, never on the page ------------------

test('keys that name a credential are blanked whatever the value looks like', () => {
  const { value, warnings } = redactValue({
    username: 'ana',
    password: 'hunter2',
    apiKey: 'abc',
    api_key: 'def',
    accessKey: 'ghi',
    private_key: 'jkl',
    oauthToken: 'mno',
    bearer: 'pqr',
    credentials: 'stu',
    secretSauce: 'vwx',
  });
  assert.equal(value.username, 'ana');
  for (const key of ['password', 'apiKey', 'api_key', 'accessKey', 'private_key', 'oauthToken', 'bearer', 'credentials', 'secretSauce']) {
    assert.equal(value[key], '[redacted]', key + ' was not redacted');
  }
  assert.ok(warnings.some((w) => w.includes('"password"')));
});

test('a key named cookie or cookies is blanked', () => {
  const { value, warnings } = redactValue({ cookie: 'a=1', cookies: ['a'], Cookie: 'b=2', cookieBanner: 'dismissed' });
  assert.equal(value.cookie, '[redacted]');
  assert.equal(value.cookies, '[redacted]');
  assert.equal(value.Cookie, '[redacted]');
  assert.equal(value.cookieBanner, 'dismissed', 'a key that merely mentions cookies is not a cookie');
  assert.ok(warnings.length >= 3);
});

test('a JWT-shaped string is redacted wherever it sits', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.ok(looksLikeJwt(jwt));
  const { value, warnings } = redactValue({ headers: { authorization: jwt } });
  assert.equal(value.headers.authorization, '[redacted]');
  assert.ok(warnings.some((w) => w.includes('a JWT')));
});

test('a long hex token and a long base64 blob are redacted', () => {
  const hex = 'a3f9c2b18e4d5760a3f9c2b18e4d5760';
  assert.ok(looksLikeHexToken(hex));
  const blob = 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA' + 'aB9'.repeat(60);
  assert.ok(looksLikeBase64Blob(blob), 'test blob is not base64 shaped');
  const { value, warnings } = redactValue({ hex, blob });
  assert.equal(value.hex, '[redacted]');
  assert.equal(value.blob, '[redacted]');
  assert.ok(warnings.some((w) => w.includes('hex')));
  assert.ok(warnings.some((w) => w.includes('base64')));
});

test('a cookie string is redacted', () => {
  const cookie = 'li_at=AQEDAS; JSESSIONID=ajax:12345; lang=v=2&lang=en-us';
  assert.ok(looksLikeCookieString(cookie));
  const { value, warnings } = redactValue({ readBack: cookie });
  assert.equal(value.readBack, '[redacted]');
  assert.ok(warnings.some((w) => w.includes('cookie string')));
});

test('a plain URL with a query string passes through untouched', () => {
  const urls = [
    'https://www.theguardian.com/uk?utm_source=nl&utm_medium=email&page=3',
    'https://example.com/search?q=how+long+is+a+piece+of+string&sort=relevance',
    'http://localhost:8080/api/echo?a=1&b=2',
  ];
  for (const url of urls) {
    assert.equal(credentialShape(url), null, url + ' was classified as ' + credentialShape(url));
    const { value, warnings } = redactValue({ href: url });
    assert.equal(value.href, url);
    assert.deepEqual(warnings, []);
  }
});

test('ordinary page text is not a credential', () => {
  for (const text of ['Sign in to continue', 'www.example.com', 'a-b-c', '2026-09-03T12:00:00.000Z']) {
    assert.equal(credentialShape(text), null, text);
  }
});

test('a 200000-character string of one letter is truncated, never blocked', () => {
  const big = 'x'.repeat(200000);
  assert.equal(credentialShape(big), null, 'a repeated letter is not a credential shape');
  const prepared = prepareScriptValue(big);
  assert.notEqual(prepared.value, '[redacted]');
  assert.ok(String(prepared.value).startsWith('xxxx'), 'the real value is still there');
  assert.ok(String(prepared.value).length < 200000);
  assert.ok(prepared.warnings.some((w) => w.includes('200000')), 'the warning names the full size');
});

test('a 200000-character string of one hex letter is also truncated, not redacted', () => {
  const prepared = prepareScriptValue('a'.repeat(200000));
  assert.notEqual(prepared.value, '[redacted]');
  assert.ok(prepared.warnings.some((w) => w.includes('200000')));
});

test('redaction walks arrays and nested objects', () => {
  const { value } = redactValue({ users: [{ name: 'a', password: 'p' }, { name: 'b', token: 'ok to keep' }] });
  assert.equal(value.users[0].password, '[redacted]');
  assert.equal(value.users[0].name, 'a');
  assert.equal(value.users[1].token, 'ok to keep', 'token alone is too common a word to blank');
});

// --- S6, the javascript caps -------------------------------------------------

test('a string over 10 KB is capped and the warning names the real length', () => {
  const { value, warnings } = capValue({ text: 'y'.repeat(30000) });
  assert.ok(value.text.length < 30000);
  assert.ok(value.text.startsWith('y'.repeat(100)));
  assert.ok(value.text.includes('30000'));
  assert.ok(warnings[0].includes(String(STRING_CAP)));
});

test('an array over 1000 items is capped', () => {
  const { value, warnings } = capValue(Array.from({ length: 2500 }, (unused, i) => i));
  assert.equal(value.length, ARRAY_CAP + 1);
  assert.match(String(value[ARRAY_CAP]), /1500 more items/);
  assert.ok(warnings[0].includes('2500'));
});

test('a serialized value over 50 KB is cut with an output_truncated warning', () => {
  const rows = Array.from({ length: 900 }, (unused, i) => ({ i, label: 'row ' + i + ' ' + 'z'.repeat(80) }));
  const prepared = prepareScriptValue(rows);
  assert.equal(prepared.truncated, true);
  assert.ok(prepared.serialized.length <= SERIALIZED_CAP + 20);
  assert.ok(prepared.fullLength > SERIALIZED_CAP);
  const note = prepared.warnings.find((w) => w.startsWith('output_truncated'));
  assert.ok(note, 'no output_truncated warning');
  assert.ok(note.includes(String(prepared.fullLength)), 'the warning states the full size');
});

test('a small value comes back whole', () => {
  const prepared = prepareScriptValue({ ok: true, count: 3 });
  assert.deepEqual(prepared.value, { ok: true, count: 3 });
  assert.equal(prepared.truncated, false);
  assert.deepEqual(prepared.warnings, []);
});

test('applyCaps redacts and caps a javascript result in place', () => {
  const { result, warnings } = applyCaps('javascript', { result: { cookie: 'a=1; b=2', page: 'https://x.test/?q=1' }, type: 'object' });
  assert.equal(result.result.cookie, '[redacted]');
  assert.equal(result.result.page, 'https://x.test/?q=1');
  assert.equal(result.type, 'object', 'existing fields survive');
  assert.ok(warnings.length >= 1);
});

// --- S5, the capture readers -------------------------------------------------

test('network URLs are clipped to 300 characters and total is reported', () => {
  const long = 'https://cdn.example.com/' + 'p'.repeat(600);
  const { result, warnings } = applyCaps('read_network_requests', {
    requests: [{ url: long, status: 200 }, { url: 'https://a.test/x', status: 404 }],
    total: 500,
    returned: 2,
  });
  assert.equal(result.requests[0].url.length, URL_CAP);
  assert.equal(result.requests[0].urlLength, long.length);
  assert.equal(result.requests[1].url, 'https://a.test/x', 'a short URL is untouched');
  assert.equal(result.total, 500);
  assert.equal(result.returned, 2);
  assert.ok(warnings.some((w) => w.includes('clipped')));
  assert.ok(warnings.some((w) => w.includes('showing 2 of 500')));
});

test('console messages are clipped to 500 characters and total is reported', () => {
  const long = 'e'.repeat(4000);
  const { result, warnings } = applyCaps('read_console_messages', {
    entries: [{ level: 'error', text: long }, { level: 'log', text: 'short' }],
    total: 42,
    returned: 2,
  });
  assert.equal(result.entries[0].text.length, MESSAGE_CAP);
  assert.equal(result.entries[0].textLength, 4000);
  assert.equal(result.entries[1].text, 'short');
  assert.equal(result.total, 42);
  assert.ok(warnings.some((w) => w.includes('showing 2 of 42')));
});

test('total and returned are filled in when the extension omitted them', () => {
  const { result } = applyCaps('read_network_requests', { requests: [{ url: 'https://a/' }] });
  assert.equal(result.returned, 1);
  assert.equal(result.total, 1);
});

test('a tool with no caps is handed back unchanged', () => {
  const input = { url: 'https://a/', nodes: 3 };
  const { result, warnings } = applyCaps('read_page', input);
  assert.equal(result, input);
  assert.deepEqual(warnings, []);
});
