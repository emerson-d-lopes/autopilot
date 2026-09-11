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

  assert.equal(
    perms.consumeConfirmation(token, { tabId: 6, origin: 'https://example.com', control: 'Send' }).ok,
    false
  );
  assert.equal(perms.consumeConfirmation(token, { tabId: 5, origin: 'https://other.com', control: 'Send' }).ok, false);
  assert.equal(
    perms.consumeConfirmation(token, { tabId: 5, origin: 'https://example.com', control: 'Delete' }).ok,
    false
  );

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
    assert.equal(
      perms.lastActedOrigin('t1'),
      'https://b.example',
      'the new origin becomes what the next call is compared against'
    );
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

test('a pre-move check can judge an origin without recording it', async () => {
  await withPolicy({ mode: perms.MODES.ALLOW }, async () => {
    perms.forgetActedOrigin('t5');
    await perms.checkPermission({ tool: 'computer', url: 'http://127.0.0.1:8765/fixture', clientId: 't5' });

    // What navigate does before the move: the target is checked, and the
    // session is still on the origin it was on.
    const ahead = await perms.checkPermission({
      tool: 'navigate',
      url: 'https://example.com/',
      clientId: 't5',
      noteTransition: false,
    });
    assert.equal(ahead.allowed, true);
    assert.equal(perms.lastActedOrigin('t5'), 'http://127.0.0.1:8765');

    // What navigate does after it lands: the warning belongs to this call.
    const landed = await perms.checkDomainTransition({ clientId: 't5', url: 'https://example.com/', tool: 'navigate' });
    assert.equal(landed.changed, true);
    assert.match(landed.warning, /example\.com/);
    assert.match(landed.warning, /127\.0\.0\.1:8765/);
    assert.equal(perms.lastActedOrigin('t5'), 'https://example.com', 'and now it is recorded');
    perms.forgetActedOrigin('t5');
  });
});

test('a pre-move check still refuses an ungranted origin in ask mode', async () => {
  await withPolicy({ mode: perms.MODES.ASK }, async () => {
    perms.forgetActedOrigin('t6');
    await perms.grant('https://a.example', 'always');
    await perms.checkPermission({ tool: 'computer', url: 'https://a.example/', clientId: 't6' });
    await assert.rejects(
      () =>
        perms.checkPermission({
          tool: 'navigate',
          url: 'https://c.example/',
          clientId: 't6',
          noteTransition: false,
        }),
      /grant/
    );
    perms.forgetActedOrigin('t6');
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

// ---------------------------------------------------------------------------
// An unanswered notification has its own deadline (W4)
// ---------------------------------------------------------------------------

/** A notifications API that shows the prompt and never gets an answer. */
function silentNotifications() {
  const created = [];
  const cleared = [];
  // The notification carries the extension's icon, which the base stub has no
  // getURL for.
  globalThis.chrome.runtime.getURL = (path) => 'chrome-extension://test/' + path;
  globalThis.chrome.notifications = {
    create(id, options, done) {
      created.push({ id, options });
      chrome.runtime.lastError = null;
      if (done) done(id);
    },
    clear(id) {
      cleared.push(id);
    },
    onButtonClicked: { addListener() {} },
    onClosed: { addListener() {} },
  };
  return { created, cleared };
}

test('the notification deadline is half the token life and half the host timeout', () => {
  assert.equal(perms.ASK_IN_BROWSER_TIMEOUT_MS, 60000);
  assert.ok(
    perms.ASK_IN_BROWSER_TIMEOUT_MS < perms.CONFIRM_TTL_MS,
    'it has to expire before the token it would have approved'
  );
});

test('an unanswered notification times out and is closed on the way out', async () => {
  const notifications = silentNotifications();
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    const answer = await perms.askInBrowser({ control: 'Send', origin: 'https://example.com', timeoutMs: 25 });
    assert.equal(answer, 'timeout');
    assert.equal(notifications.created.length, 1);
    assert.deepEqual(notifications.cleared, [notifications.created[0].id], 'nothing is left open behind the refusal');
  });
  delete globalThis.chrome.notifications;
});

test('an unanswered confirmation comes back naming the browser, not the renderer', async () => {
  silentNotifications();
  const { confirmGate } = await import('../extension/src/lib/tools.js');
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    await assert.rejects(
      () =>
        confirmGate({
          tabId: 1,
          url: 'https://example.com/thread',
          control: 'Send',
          irreversible: true,
          screenshotId: 'write_1_ab3d',
          askTimeoutMs: 25,
        }),
      (err) => {
        assert.equal(err.code, 'confirmation_required');
        assert.equal(err.effects, 'none');
        assert.equal(err.retryable, false, 'a retry would wait for another unanswered notification');
        assert.match(err.message, /nobody answered/);
        assert.match(err.message, /notification was closed/);
        assert.doesNotMatch(err.message, /renderer/);
        assert.equal(err.details.unansweredInBrowser, true);
        assert.equal(err.details.screenshotId, 'write_1_ab3d');
        return true;
      }
    );
  });
  delete globalThis.chrome.notifications;
});

// ---------------------------------------------------------------------------
// A stray click on the toast is not an answer
// ---------------------------------------------------------------------------
//
// From the 0.1.34 pass, check 8: onButtonClicked fired with index 0 while
// nobody was answering the prompt, at 2.6 s, 4.4 s, 8.4 s and 23.6 s in
// different runs, and once as fourteen activations between 13.6 s and 18.1 s.
// The toast sits at the bottom right over whatever is on screen, so a click
// meant for the window underneath lands on Allow.

/** A notifications API whose buttons can be pressed from the test. */
function clickableNotifications() {
  const created = [];
  const cleared = [];
  const buttonListeners = [];
  const bodyListeners = [];
  globalThis.chrome.runtime.getURL = (path) => 'chrome-extension://test/' + path;
  globalThis.chrome.notifications = {
    create(id, options, done) {
      created.push({ id, options });
      chrome.runtime.lastError = null;
      if (done) done(id);
    },
    clear(id) {
      cleared.push(id);
    },
    onButtonClicked: { addListener: (fn) => buttonListeners.push(fn) },
    onClicked: { addListener: (fn) => bodyListeners.push(fn) },
    onClosed: { addListener() {} },
  };
  return {
    created,
    cleared,
    press: (index) => buttonListeners.forEach((fn) => fn(created[created.length - 1].id, index)),
    body: () => bodyListeners.forEach((fn) => fn(created[created.length - 1].id)),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the settle window and the burst gap are the values the fix names', () => {
  assert.equal(perms.ASK_SETTLE_MS, 1500);
  assert.equal(perms.ASK_CLICK_GAP_MS, 500);
});

test('an Allow inside the settle window is ignored and the ask keeps waiting', async () => {
  const notifications = clickableNotifications();
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    const pending = perms.askInBrowser({
      control: 'Send',
      origin: 'https://example.com',
      timeoutMs: 200,
      settleMs: 80,
      clickGapMs: 20,
    });
    await wait(5);
    notifications.press(0);
    notifications.press(0);
    assert.equal(await pending, 'timeout', 'the clicks landed before the toast could have been read');
  });
  delete globalThis.chrome.notifications;
});

test('an Allow right behind another click is a burst, not an answer', async () => {
  const notifications = clickableNotifications();
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    const pending = perms.askInBrowser({
      control: 'Send',
      origin: 'https://example.com',
      timeoutMs: 250,
      settleMs: 60,
      clickGapMs: 200,
    });
    // The shape check 8 recorded: fourteen activations in a row, the first of
    // them inside the settle window. Each later one lands inside the gap the
    // one before it opened, so none is read as an answer.
    await wait(10);
    for (let i = 0; i < 14; i += 1) notifications.press(0);
    await wait(30);
    notifications.press(0);
    assert.equal(await pending, 'timeout', 'a run of clicks is one stray click, not fourteen answers');
  });
  delete globalThis.chrome.notifications;
});

test('a click on the toast body makes the Allow behind it read as a burst', async () => {
  const notifications = clickableNotifications();
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    const pending = perms.askInBrowser({
      control: 'Send',
      origin: 'https://example.com',
      timeoutMs: 200,
      settleMs: 30,
      clickGapMs: 120,
    });
    await wait(45);
    notifications.body();
    notifications.press(0);
    assert.equal(await pending, 'timeout');
  });
  delete globalThis.chrome.notifications;
});

test('a deliberate Allow, spaced and after the settle window, is taken', async () => {
  const notifications = clickableNotifications();
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    const pending = perms.askInBrowser({
      control: 'Send',
      origin: 'https://example.com',
      timeoutMs: 400,
      settleMs: 30,
      clickGapMs: 20,
    });
    await wait(60);
    notifications.press(0);
    assert.equal(await pending, 'allow');
    assert.deepEqual(notifications.cleared, [notifications.created[0].id], 'and the toast is closed behind it');
  });
  delete globalThis.chrome.notifications;
});

test('Deny is taken after the settle window without waiting out the gap', async () => {
  const notifications = clickableNotifications();
  await withPolicy({ mode: perms.MODES.CONFIRM, confirmNotifications: true }, async () => {
    const pending = perms.askInBrowser({
      control: 'Send',
      origin: 'https://example.com',
      timeoutMs: 400,
      settleMs: 30,
      clickGapMs: 5000,
    });
    await wait(45);
    notifications.press(1);
    assert.equal(await pending, 'deny', 'refusing is the safe direction, so it is never held back');
  });
  delete globalThis.chrome.notifications;
});

test('Allow counts once per prompt, so the rest of a burst cannot re-approve', () => {
  const pending = { shownAt: 0, lastClickAt: null, allowed: false, ignored: 0, settleMs: 1500, clickGapMs: 500 };
  assert.equal(perms.judgeNotificationClick(pending, 0, 2000), 'allow');
  assert.equal(perms.judgeNotificationClick(pending, 0, 4000), null, 'a second Allow on the same prompt is dead');
  assert.equal(perms.judgeNotificationClick(pending, 0, 9000), null);
  assert.equal(pending.ignored, 2);
});

test('asking in the browser is off in the shipped policy', async () => {
  resetStorage();
  perms.invalidatePolicyCache();
  const policy = await perms.loadPolicy();
  assert.equal(policy.confirmNotifications, false, 'a toast over the screen is not on unless it is turned on');
  perms.invalidatePolicyCache();
});
