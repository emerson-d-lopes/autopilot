import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub, resetStorage } from './chrome-stub.js';

installChromeStub();

const perms = await import('../extension/src/lib/permissions.js');

async function withPolicy(patch, fn) {
  resetStorage();
  perms.invalidatePolicyCache();
  await perms.savePolicy(patch);
  try {
    await fn();
  } finally {
    resetStorage();
    perms.invalidatePolicyCache();
  }
}

test('hostMatches handles exact and wildcard patterns', () => {
  assert.equal(perms.hostMatches('example.com', 'example.com'), true);
  assert.equal(perms.hostMatches('example.com', '*.example.com'), true);
  assert.equal(perms.hostMatches('app.example.com', '*.example.com'), true);
  assert.equal(perms.hostMatches('a.b.example.com', '*.example.com'), true);
  assert.equal(perms.hostMatches('notexample.com', '*.example.com'), false);
  assert.equal(perms.hostMatches('example.com.evil.net', '*.example.com'), false);
  assert.equal(perms.hostMatches('EXAMPLE.COM', 'example.com'), true);
});

test('a blocked host is refused even for read-only tools', async () => {
  await withPolicy({}, async () => {
    await assert.rejects(
      () => perms.checkPermission({ tool: 'read_page', url: 'https://www.chase.com/accounts' }),
      /Blocked origin/
    );
  });
});

test('a subdomain of a blocked host is refused', async () => {
  await withPolicy({}, async () => {
    await assert.rejects(
      () => perms.checkPermission({ tool: 'computer', url: 'https://secure.paypal.com/x' }),
      /Blocked origin/
    );
  });
});

test('an explicit allow overrides the blocklist', async () => {
  await withPolicy({ allowedHosts: ['sandbox.paypal.com'] }, async () => {
    const result = await perms.checkPermission({ tool: 'computer', url: 'https://sandbox.paypal.com/x' });
    assert.equal(result.allowed, true);
  });
});

test('allow mode permits an ordinary site', async () => {
  await withPolicy({ mode: perms.MODES.ALLOW }, async () => {
    const result = await perms.checkPermission({ tool: 'computer', url: 'https://example.com/' });
    assert.equal(result.allowed, true);
  });
});

test('ask mode refuses an origin with no grant', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    await assert.rejects(
      () => perms.checkPermission({ tool: 'computer', url: 'https://example.com/' }),
      /No permission grant/
    );
  });
});

test('ask mode still allows read-only tools', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    const result = await perms.checkPermission({ tool: 'read_page', url: 'https://example.com/' });
    assert.equal(result.allowed, true);
  });
});

test('ask mode allows localhost without a grant', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    const result = await perms.checkPermission({ tool: 'computer', url: 'http://localhost:3000/app' });
    assert.equal(result.reason, 'localhost');
  });
});

test('an always grant persists across calls', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    await perms.grant('https://example.com', 'always');
    assert.equal((await perms.checkPermission({ tool: 'computer', url: 'https://example.com/a' })).allowed, true);
    assert.equal((await perms.checkPermission({ tool: 'computer', url: 'https://example.com/b' })).allowed, true);
  });
});

test('a once grant is consumed after a single use', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    await perms.grant('https://example.com', 'once');
    assert.equal((await perms.checkPermission({ tool: 'computer', url: 'https://example.com/a' })).allowed, true);
    await assert.rejects(
      () => perms.checkPermission({ tool: 'computer', url: 'https://example.com/b' }),
      /No permission grant/
    );
  });
});

test('revoke removes a standing grant', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    await perms.grant('https://example.com', 'always');
    await perms.revoke('https://example.com');
    await assert.rejects(() => perms.checkPermission({ tool: 'computer', url: 'https://example.com/' }));
  });
});

test('skip mode bypasses grants but not the blocklist', async () => {
  await withPolicy({ mode: perms.MODES.SKIP }, async () => {
    assert.equal((await perms.checkPermission({ tool: 'computer', url: 'https://example.com/' })).allowed, true);
    await assert.rejects(
      () => perms.checkPermission({ tool: 'computer', url: 'https://www.chase.com/' }),
      /Blocked origin/
    );
  });
});

test('a URL with no origin is allowed', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    const result = await perms.checkPermission({ tool: 'computer', url: 'about:blank' });
    assert.equal(result.allowed, true);
  });
});

test('verifyOriginUnchanged refuses when the tab moved to another host', async () => {
  const original = globalThis.chrome.tabs.get;
  globalThis.chrome.tabs.get = async () => ({ id: 1, url: 'https://evil.example/' });
  try {
    await assert.rejects(
      () => perms.verifyOriginUnchanged(1, 'https://good.example/page'),
      /navigated from good.example to evil.example/
    );
  } finally {
    globalThis.chrome.tabs.get = original;
  }
});

test('verifyOriginUnchanged accepts a same-host path change', async () => {
  const original = globalThis.chrome.tabs.get;
  globalThis.chrome.tabs.get = async () => ({ id: 1, url: 'https://good.example/other' });
  try {
    await perms.verifyOriginUnchanged(1, 'https://good.example/page');
  } finally {
    globalThis.chrome.tabs.get = original;
  }
});

test('read-only tool list covers every non-mutating tool', () => {
  for (const name of ['read_page', 'get_page_text', 'find', 'read_console_messages', 'read_network_requests']) {
    assert.equal(perms.READ_ONLY_TOOLS.has(name), true, name + ' should be read-only');
  }
  for (const name of ['computer', 'navigate', 'form_input', 'javascript']) {
    assert.equal(perms.READ_ONLY_TOOLS.has(name), false, name + ' must not be read-only');
  }
});
