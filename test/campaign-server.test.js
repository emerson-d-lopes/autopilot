// Unit tests for the campaign fixture server's routes. No browser needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './fixtures/campaign/server.js';

async function withServer(fn) {
  const server = await start(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('serves the static index page', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Bridge test page/);
  });
});

test('/api/ok returns json with ok:true', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/ok');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(typeof json.t, 'number');
  });
});

test('/api/missing returns 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/missing');
    assert.equal(res.status, 404);
  });
});

test('/api/echo POST echoes the body back', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 'x' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.echo, { a: 1, b: 'x' });
    assert.equal(json.path, '/api/echo');
  });
});

test(
  '/slow responds after roughly 4 seconds',
  async () => {
    await withServer(async (base) => {
      const started = Date.now();
      const res = await fetch(base + '/slow');
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.ok(elapsed >= 3900, 'took ' + elapsed + 'ms, expected at least ~4000ms');
      const body = await res.text();
      assert.match(body, /slow page/);
    });
  },
  { timeout: 10000 }
);

test('/big returns a 3000-row table with a button and a link per row', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/big');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id='b0'/);
    assert.match(body, /id='b2999'/);
    assert.match(body, /href='#0'/);
    assert.match(body, /href='#2999'/);
    assert.equal((body.match(/<tr>/g) || []).length, 3000);
  });
});

test('/redirect sends a 302 to /index.html#redirected', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/redirect', { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/index.html#redirected');
  });
});

test('/spa serves loading text and the button appears client-side later', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/spa');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /loading/);
    assert.match(body, /id=go/);
    assert.match(body, /id=done/);
    assert.match(body, /setTimeout/);
  });
});

test('/dialog serves an alert button and an ok button', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/dialog');
    const body = await res.text();
    assert.match(body, /onclick='alert\(1\)'/);
    assert.match(body, /id='ok'/);
  });
});

test('/sensitive.html has a password field, a cc-number field and a normal field', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/sensitive.html');
    const body = await res.text();
    assert.match(body, /type="password"/);
    assert.match(body, /autocomplete="cc-number"/);
    assert.match(body, /id="notes"/);
  });
});

test('/unload.html arms beforeunload after input', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/unload.html');
    const body = await res.text();
    assert.match(body, /beforeunload/);
    assert.match(body, /addEventListener\('input'/);
  });
});

test('/scroll.html has an overflow:hidden body and an inner scroll container', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/scroll.html');
    const body = await res.text();
    assert.match(body, /overflow:hidden/);
    assert.match(body, /overflow:auto/);
    assert.match(body, /height:3000px/);
  });
});

test('/composer.html has a contenteditable box, a Send button and a thread list', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/composer.html');
    const body = await res.text();
    assert.match(body, /contenteditable="true"/);
    assert.match(body, /id="send"[^>]*disabled/);
    assert.match(body, /id="thread"/);
  });
});

test('/composer.html carries a status region, a draft control and a call to /api/echo', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/composer.html');
    const body = await res.text();
    assert.match(body, /id="toast" role="status"/, 'the toast is what the submit watch reads as a status region');
    assert.match(body, /id="draft"[^>]*>Save draft/, 'a reversible write, for the undo hint');
    assert.match(body, /Discard draft/, 'the control that reverses it');
    assert.match(body, /fetch\('\/api\/echo'/, 'a same-origin 2xx after a send');
  });
});

test('/composer.html carries a close/reopen pair and a press that opens a modal', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/composer.html');
    const body = await res.text();
    assert.match(body, /id="issuetoggle"[^>]*>Close issue/, 'the reversible close, for the undo hint');
    assert.match(body, /'Reopen issue'/, 'the control it swaps to');
    assert.match(body, /id="deldraft"[^>]*>Delete draft/, 'the press that opens a step rather than completing one');
    assert.match(body, /role', 'dialog'/, 'what it opens');
  });
});

test('/newissue.html has a title field, a markdown toolbar and a Create button', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/newissue.html');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<form id="newissue" aria-label="New issue"/, 'the form name every control inherits');
    assert.match(body, /<label for="title">Add a title<\/label>/);
    assert.match(body, /<input type="text" id="title"/);
    assert.match(body, /id="create" type="submit">Create</);
    const buttons = body.match(/<button type="button">/g) || [];
    assert.ok(buttons.length >= 20, 'the toolbar is 20 buttons, got ' + buttons.length);
  });
});

test('unknown routes return 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/nope-not-a-route');
    assert.equal(res.status, 404);
  });
});
