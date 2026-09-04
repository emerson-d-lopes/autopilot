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

// ---------------------------------------------------------------------------
// W4: confirm mode, tokens and the write allow-list
// ---------------------------------------------------------------------------

test('confirm mode allows a call the way allow mode does', async () => {
  await withPolicy({ mode: perms.MODES.CONFIRM }, async () => {
    perms.forgetActedOrigin('default');
    const result = await perms.checkPermission({ tool: 'computer', url: 'https://example.com/' });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'confirm mode');
  });
});

test('an irreversible control needs confirmation only in confirm mode', async () => {
  await withPolicy({ mode: perms.MODES.ALLOW }, async () => {
    assert.equal(await perms.needsConfirmation({ url: 'https://example.com/', irreversible: true }), false);
  });
  await withPolicy({ mode: perms.MODES.CONFIRM }, async () => {
    assert.equal(await perms.needsConfirmation({ url: 'https://example.com/', irreversible: true }), true);
    assert.equal(await perms.needsConfirmation({ url: 'https://example.com/', irreversible: false }), false);
  });
});

test('the write allow-list exempts an origin from confirmation', async () => {
  await withPolicy({ mode: perms.MODES.CONFIRM, writeAllowlist: ['*.linkedin.com'] }, async () => {
    assert.equal(
      await perms.needsConfirmation({ url: 'https://www.linkedin.com/messaging', irreversible: true }),
      false
    );
    assert.equal(await perms.needsConfirmation({ url: 'https://github.com/x', irreversible: true }), true);
  });
});

test('a token is spent once and only for the tab, origin and control it names', async () => {
  const token = perms.createConfirmation({ tabId: 5, origin: 'https://example.com', control: 'Send' });

  assert.equal(perms.consumeConfirmation(token, { tabId: 6, origin: 'https://example.com', control: 'Send' }).ok, false);
  assert.equal(perms.consumeConfirmation(token, { tabId: 5, origin: 'https://other.com', control: 'Send' }).ok, false);
  assert.equal(perms.consumeConfirmation(token, { tabId: 5, origin: 'https://example.com', control: 'Delete' }).ok, false);

  const spent = perms.consumeConfirmation(token, { tabId: 5, origin: 'https://example.com', control: 'Send' });
  assert.equal(spent.ok, true);

  const again = perms.consumeConfirmation(token, { tabId: 5, origin: 'https://example.com', control: 'Send' });
  assert.equal(again.ok, false, 'a token is single use');
  assert.match(again.reason, /unknown or has expired/);
});

test('a token carries the screenshot taken before the refusal', () => {
  const token = perms.createConfirmation({
    tabId: 2,
    origin: 'https://example.com',
    control: 'Post',
    screenshotId: 'write_1_abcd',
  });
  const spent = perms.consumeConfirmation(token, { tabId: 2, origin: 'https://example.com', control: 'Post' });
  assert.equal(spent.record.screenshotId, 'write_1_abcd');
});

// ---------------------------------------------------------------------------
// F5: plan mode
// ---------------------------------------------------------------------------

test('declare_plan keeps the origins it can grant and names the blocked ones', async () => {
  await withPolicy({ mode: perms.MODES.PLAN }, async () => {
    perms.clearPlan('c1');
    const declared = await perms.declarePlan('c1', ['github.com', 'https://www.linkedin.com/feed', 'chase.com', '@@@']);
    assert.deepEqual(declared.origins, ['https://github.com', 'https://www.linkedin.com']);
    assert.deepEqual(declared.blocked, ['https://chase.com']);
    assert.deepEqual(declared.rejected, ['@@@']);
    perms.clearPlan('c1');
  });
});

test('plan mode allows a declared origin and refuses everything else', async () => {
  await withPolicy({ mode: perms.MODES.PLAN }, async () => {
    perms.clearPlan('c2');
    perms.forgetActedOrigin('c2');
    await perms.declarePlan('c2', ['github.com']);

    const allowed = await perms.checkPermission({ tool: 'computer', url: 'https://github.com/x', clientId: 'c2' });
    assert.equal(allowed.allowed, true);

    await assert.rejects(
      () => perms.checkPermission({ tool: 'read_page', url: 'https://example.com/', clientId: 'c2' }),
      (err) => {
        assert.equal(err.code, 'origin_blocked');
        assert.match(err.hint, /declare_plan/);
        return true;
      }
    );
    perms.clearPlan('c2');
    perms.forgetActedOrigin('c2');
  });
});

test('plan mode with nothing declared says so rather than naming an empty list', async () => {
  await withPolicy({ mode: perms.MODES.PLAN }, async () => {
    perms.clearPlan('c3');
    await assert.rejects(
      () => perms.checkPermission({ tool: 'computer', url: 'https://example.com/', clientId: 'c3' }),
      /has not declared the origins/
    );
  });
});

// ---------------------------------------------------------------------------
// F6: domain transitions
// ---------------------------------------------------------------------------

test('acting on a new origin is a warning in allow mode', async () => {
  await withPolicy({ mode: perms.MODES.ALLOW }, async () => {
    perms.forgetActedOrigin('t1');
    const first = await perms.checkPermission({ tool: 'computer', url: 'https://a.example/', clientId: 't1' });
    assert.equal(first.transition.changed, false, 'the first origin is not a transition');

    const second = await perms.checkPermission({ tool: 'computer', url: 'https://b.example/', clientId: 't1' });
    assert.equal(second.transition.changed, true);
    assert.match(second.transition.warning, /b\.example/);
    assert.match(second.transition.warning, /a\.example/);
    assert.equal(perms.lastActedOrigin('t1'), 'https://b.example', 'the new origin becomes what the next call is compared against');
    perms.forgetActedOrigin('t1');
  });
});

test('a path change on the same origin is not a transition', async () => {
  await withPolicy({ mode: perms.MODES.ALLOW }, async () => {
    perms.forgetActedOrigin('t2');
    await perms.checkPermission({ tool: 'computer', url: 'https://a.example/one', clientId: 't2' });
    const again = await perms.checkPermission({ tool: 'computer', url: 'https://a.example/two', clientId: 't2' });
    assert.equal(again.transition.changed, false);
    perms.forgetActedOrigin('t2');
  });
});

test('a move to a new origin needs its own grant in ask mode', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    perms.forgetActedOrigin('t3');
    await perms.grant('https://a.example', 'always');
    await perms.checkPermission({ tool: 'computer', url: 'https://a.example/', clientId: 't3' });

    await perms.grant('https://b.example', 'always');
    await assert.rejects(
      () => perms.checkDomainTransition({ clientId: 't3', url: 'https://c.example/', tool: 'computer' }),
      (err) => {
        assert.equal(err.code, 'origin_blocked');
        assert.match(err.message, /needs its own grant/);
        return true;
      }
    );

    // The granted origin goes through, which is the path a navigate takes when
    // a redirect lands on a site the session already holds a grant for.
    const ok = await perms.checkDomainTransition({ clientId: 't3', url: 'https://b.example/', tool: 'computer' });
    assert.equal(ok.changed, true);
    perms.forgetActedOrigin('t3');
  });
});

test('a read is never blocked by a transition', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    perms.forgetActedOrigin('t4');
    await perms.grant('https://a.example', 'always');
    await perms.checkPermission({ tool: 'computer', url: 'https://a.example/', clientId: 't4' });
    const read = await perms.checkDomainTransition({ clientId: 't4', url: 'https://d.example/', tool: 'read_page' });
    assert.equal(read.changed, true);
    perms.forgetActedOrigin('t4');
  });
});

test('askInBrowser reports unavailable when the switch is off', async () => {
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: false }, async () => {
    assert.equal(await perms.askInBrowser({ control: 'Send', origin: 'https://example.com' }), 'unavailable');
  });
});
