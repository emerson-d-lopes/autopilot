// Exercises the page agent against a real DOM.
//
// The accessibility tree is the primary interface the model sees, so these
// cover role mapping, name derivation, ref stability, filtering, and budgeting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseTree } from '../extension/src/lib/find.js';
// The shared harness, for the cases needing a stubbed checkVisibility or a real
// window outer size. The loader below stays as it was for everything else.
import { loadPage as loadPageWith } from './page-harness.js';

const AGENT_SOURCE = readFileSync(new URL('../extension/src/content/agent.js', import.meta.url), 'utf8');

/** Loads the content script into a fresh jsdom window and returns a message caller. */
function loadPage(html, { width = 1024, height = 768 } = {}) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    url: 'https://example.test/page',
    // The agent reads bare globals (document, getComputedStyle, Node), so it has
    // to be evaluated inside the window realm rather than called from outside it.
    runScripts: 'outside-only',
  });
  const { window } = dom;

  window.innerWidth = width;
  window.innerHeight = height;

  // jsdom lays nothing out, so every rect is zero. Report a plausible box for
  // rendered elements and honour display:none, which is what the agent checks.
  window.Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    const offscreen = this.hasAttribute('data-offscreen');
    const top = offscreen ? 5000 : 100;
    return {
      left: 50, top, right: 250, bottom: top + 30, width: 200, height: 30, x: 50, y: top,
    };
  };

  // jsdom implements no layout, so scrollIntoView is absent.
  window.Element.prototype.scrollIntoView = function () {};

  let listener = null;
  window.chrome = {
    runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
  };

  window.eval(AGENT_SOURCE);

  if (!listener) throw new Error('content script did not register a message listener');

  const call = (message) =>
    new Promise((resolve, reject) => {
      const async = listener(message, {}, (response) => {
        if (response && response.error && message.expectError !== true) {
          return resolve(response);
        }
        resolve(response);
      });
      if (async !== true && async !== false && async !== undefined) reject(new Error('bad listener return'));
    });

  return { window, call, dom };
}

const LOGIN_PAGE = `<!doctype html><html><body>
  <nav>
    <a href="/">Home</a>
    <a href="/docs">Documentation</a>
  </nav>
  <main>
    <h1>Sign in</h1>
    <form>
      <label for="email">Email address</label>
      <input id="email" type="email" placeholder="you@example.com">
      <label>Password <input type="password"></label>
      <input type="checkbox" id="remember"><label for="remember">Remember me</label>
      <select id="country">
        <option value="br">Brazil</option>
        <option value="us">United States</option>
      </select>
      <button type="submit">Sign in</button>
    </form>
    <div class="hidden" style="display:none"><button>Hidden action</button></div>
    <img src="/logo.png" alt="Acme logo">
    <img src="/spacer.gif" alt="">
    <div>plain wrapper</div>
  </main>
</body></html>`;

test('roles are derived from tags and attributes', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const result = await call({ type: 'READ_PAGE', filter: 'all', depth: 20, maxChars: 50000 });
  const nodes = parseTree(result.text);
  const byName = (n) => nodes.find((x) => x.name === n);

  assert.equal(byName('Home').role, 'link');
  assert.equal(byName('Sign in').role, 'heading');
  assert.equal(byName('Email address').role, 'textbox');
  assert.equal(byName('Remember me').role, 'checkbox');
  assert.equal(byName('Acme logo').role, 'img');

  const select = nodes.find((n) => n.role === 'combobox');
  assert.ok(select, 'select maps to combobox');
  assert.match(select.attrs, /options="Brazil\|United States"/);
  assert.equal(nodes.some((n) => n.role === 'option'), false, 'options are summarised, not listed');
  assert.equal(nodes.some((n) => n.role === 'form'), true);
  assert.equal(nodes.some((n) => n.role === 'navigation'), true);
});

test('accessible names come from labels, placeholders, and alt text', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);

  assert.ok(nodes.find((n) => n.name === 'Email address' && n.role === 'textbox'), 'label[for] resolved');
  assert.ok(nodes.find((n) => n.name === 'Acme logo'), 'img alt resolved');
  assert.ok(nodes.find((n) => n.name === 'Password' && n.role === 'textbox'), 'wrapping label resolved');
});

test('an image with empty alt is treated as decorative and dropped', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  assert.equal(nodes.filter((n) => n.role === 'img').length, 1);
});

test('a display:none subtree is pruned entirely', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  assert.equal(nodes.some((n) => n.name === 'Hidden action'), false);
});

test('the interactive filter drops static content', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);

  assert.equal(nodes.some((n) => n.role === 'heading'), false);
  assert.equal(nodes.some((n) => n.role === 'navigation'), false);
  assert.equal(nodes.some((n) => n.role === 'link'), true);
  assert.equal(nodes.some((n) => n.role === 'button'), true);
  assert.equal(nodes.every((n) => n.ref.startsWith('ref_')), true);
});

test('refs are stable across repeated reads', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const first = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const second = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);

  assert.deepEqual(
    first.map((n) => [n.name, n.ref]),
    second.map((n) => [n.name, n.ref])
  );
});

test('refs survive an unrelated DOM mutation', async () => {
  const { call, window } = loadPage(LOGIN_PAGE);
  const before = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const signIn = before.find((n) => n.name === 'Sign in' && n.role === 'button');

  const extra = window.document.createElement('button');
  extra.textContent = 'Newly added';
  window.document.querySelector('main').appendChild(extra);

  const after = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  assert.equal(after.find((n) => n.name === 'Sign in' && n.role === 'button').ref, signIn.ref);
  assert.ok(after.find((n) => n.name === 'Newly added'), 'new element appears');
});

test('RESOLVE_REF returns geometry for a live element', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const button = nodes.find((n) => n.role === 'button');

  const resolved = await call({ type: 'RESOLVE_REF', ref: button.ref });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.tag, 'BUTTON');
  assert.equal(resolved.geometry.centerX, 150);
  assert.equal(resolved.geometry.inViewport, true);
});

// ---------------------------------------------------------------------------
// The click point on an element whose text wraps
// ---------------------------------------------------------------------------

/** A DOMRect-shaped literal, which is all the geometry code reads. */
function rectAt(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

/**
 * The fixture's hover menu, measured in the 0.1.28 pass: a 51px wide menu where
 * "Hidden link" wraps onto two lines, so the box is 51x37 and its centre falls
 * past the end of the short second line.
 */
function wrappedLinkPage() {
  const page = loadPage('<!doctype html><body><nav id="menu"><a id="wrap" href="/x">Hidden link</a></nav></body>');
  const doc = page.window.document;
  // jsdom lays nothing out, so the document element reports a zero viewport and
  // every point would read as outside it.
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 1024, configurable: true });
  Object.defineProperty(doc.documentElement, 'clientHeight', { value: 768, configurable: true });
  const link = doc.getElementById('wrap');
  const lines = [rectAt(39, 294, 51, 18), rectAt(39, 312, 25, 19)];
  link.getBoundingClientRect = () => rectAt(39, 294, 51, 37);
  link.getClientRects = () => lines;
  // The browser reports the link on either line box and the menu everywhere
  // else inside the box, which is what makes the box centre land on the parent.
  doc.elementFromPoint = (x, y) => {
    for (const line of lines) {
      if (x >= line.left && x <= line.right && y >= line.top && y <= line.bottom) return link;
    }
    return doc.getElementById('menu');
  };
  return { ...page, doc, link, lines };
}

test('a click on a wrapped inline element aims at a line box, not past the end of one', async () => {
  const { call, doc, lines } = wrappedLinkPage();
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const link = nodes.find((n) => n.role === 'link');

  const resolved = await call({ type: 'RESOLVE_REF', ref: link.ref });
  const { centerX, centerY } = resolved.geometry;

  assert.equal(resolved.geometry.pointSource, 'clientRect');
  assert.equal(doc.elementFromPoint(centerX, centerY).id, 'wrap', 'the point the click uses is on the element');
  const first = lines[0];
  assert.ok(centerY >= first.top && centerY <= first.bottom, 'it is the first line box, got y ' + centerY);
  // The box centre, which is what the tool used to aim at, is not on it.
  assert.equal(doc.elementFromPoint(39 + 51 / 2, 294 + 37 / 2).id, 'menu');
});

test('a line box off the top of the viewport is skipped for one that is on screen', async () => {
  const { call, doc, link } = wrappedLinkPage();
  const lines = [rectAt(39, -40, 51, 18), rectAt(39, 20, 25, 19)];
  link.getClientRects = () => lines;
  link.getBoundingClientRect = () => rectAt(39, -40, 51, 79);
  doc.elementFromPoint = (x, y) => {
    for (const line of lines) {
      if (x >= line.left && x <= line.right && y >= line.top && y <= line.bottom) return link;
    }
    return doc.getElementById('menu');
  };

  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const resolved = await call({ type: 'RESOLVE_REF', ref: nodes.find((n) => n.role === 'link').ref });
  assert.ok(resolved.geometry.centerY > 0, 'the point is inside the viewport, got ' + resolved.geometry.centerY);
  assert.equal(doc.elementFromPoint(resolved.geometry.centerX, resolved.geometry.centerY).id, 'wrap');
});

test('an element covered on every line box is still reported as covered', async () => {
  const { call, doc } = wrappedLinkPage();
  const banner = doc.createElement('div');
  banner.id = 'banner';
  banner.textContent = 'Cookie banner';
  doc.body.appendChild(banner);
  doc.elementFromPoint = () => banner;

  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const resolved = await call({ type: 'RESOLVE_REF', ref: nodes.find((n) => n.role === 'link').ref });
  assert.match(String(resolved.occludedBy), /Cookie banner|generic|div/i);
});

test('a line box with something over it is passed over for one that is clear', async () => {
  const { call, doc, link, lines } = wrappedLinkPage();
  const banner = doc.createElement('div');
  banner.id = 'banner';
  doc.body.appendChild(banner);
  // The banner covers the first line box only.
  doc.elementFromPoint = (x, y) => (y >= lines[0].top && y <= lines[0].bottom ? banner : link);

  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const resolved = await call({ type: 'RESOLVE_REF', ref: nodes.find((n) => n.role === 'link').ref });
  assert.equal(resolved.occludedBy, null, 'the second line box is clear, so the click has somewhere to land');
  assert.ok(resolved.geometry.centerY > lines[0].bottom, 'and that is where it aims, got ' + resolved.geometry.centerY);
});

test('an element with one rect keeps the centre of its box', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const button = nodes.find((n) => n.role === 'button');
  const resolved = await call({ type: 'RESOLVE_REF', ref: button.ref });
  assert.equal(resolved.geometry.centerX, 150);
  assert.equal(resolved.geometry.pointSource, undefined);
});

test('a ref for a removed element reports a recoverable error', async () => {
  const { call, window } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const button = nodes.find((n) => n.role === 'button');

  window.document.querySelector('button[type=submit]').remove();

  const resolved = await call({ type: 'RESOLVE_REF', ref: button.ref });
  assert.match(resolved.error, /no longer on the page/);
});

test('an unknown ref reports a recoverable error', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const resolved = await call({ type: 'RESOLVE_REF', ref: 'ref_9999' });
  assert.match(resolved.error, /no longer on the page/);
});

test('offscreen elements are marked rather than dropped', async () => {
  const { call } = loadPage(`<!doctype html><body>
    <button>Visible</button>
    <button data-offscreen>Below the fold</button>
  </body>`);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  assert.equal(nodes.find((n) => n.name === 'Visible').offscreen, false);
  assert.equal(nodes.find((n) => n.name === 'Below the fold').offscreen, true);
});

test('truncation reports the real size and keeps whole lines', async () => {
  const many = Array.from({ length: 400 }, (_, i) => '<button>Action number ' + i + '</button>').join('');
  const { call } = loadPage('<!doctype html><body>' + many + '</body>');
  const result = await call({ type: 'READ_PAGE', filter: 'interactive', maxChars: 1000 });

  assert.equal(result.truncated, true);
  assert.ok(result.totalChars > 1000);
  assert.ok(result.text.length <= 1000);
  assert.equal(result.nodes, 400);
  assert.ok(result.shownNodes < 400);
  assert.equal(result.text.endsWith('\n'), false, 'truncated at a line boundary');
  assert.equal(parseTree(result.text).length, result.shownNodes);
});

test('ref_id reads only the requested subtree', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const all = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  const form = all.find((n) => n.role === 'form');

  const subtree = await call({ type: 'READ_PAGE', ref_id: form.ref, refId: form.ref, filter: 'all', depth: 20 });
  const nodes = parseTree(subtree.text);

  assert.equal(nodes.some((n) => n.role === 'navigation'), false);
  assert.equal(nodes.some((n) => n.name === 'Email address'), true);
});

test('depth bounds nesting in the emitted tree', async () => {
  const { call } = loadPage(`<!doctype html><body><main>
    <ul><li>Level one
      <ul><li>Level two
        <ul><li>Level three</li></ul>
      </li></ul>
    </li></ul>
  </main></body>`);
  const shallow = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 2 })).text);
  const deep = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);

  assert.equal(shallow.some((n) => n.name && n.name.startsWith('Level three')), false);
  assert.equal(deep.some((n) => n.name && n.name.startsWith('Level three')), true);
});

test('anonymous wrappers do not consume the depth budget', async () => {
  // Real apps nest far deeper than 15 divs. Counting raw DOM depth here would
  // hide the button that the whole read exists to find.
  let html = '<button>Deeply nested action</button>';
  for (let i = 0; i < 40; i++) html = '<div>' + html + '</div>';
  const { call } = loadPage('<!doctype html><body>' + html + '</body>');

  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 15 })).text);
  assert.equal(nodes.some((n) => n.name === 'Deeply nested action'), true);
});

test('a label associated with a control is not emitted twice', async () => {
  const { call } = loadPage(
    '<!doctype html><body><label for="x">Full name</label><input id="x"></body>'
  );
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  const named = nodes.filter((n) => n.name === 'Full name');
  assert.equal(named.length, 1);
  assert.equal(named[0].role, 'textbox');
});

test('open shadow roots are traversed', async () => {
  const { call, window } = loadPage('<!doctype html><body><div id="host"></div></body>');
  const host = window.document.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button>Inside shadow</button>';

  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  assert.equal(nodes.some((n) => n.name === 'Inside shadow'), true);
});

test('aria-label overrides text content', async () => {
  const { call } = loadPage('<!doctype html><body><button aria-label="Close dialog">X</button></body>');
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  assert.equal(nodes[0].name, 'Close dialog');
});

test('aria-labelledby resolves referenced text', async () => {
  const { call } = loadPage(
    '<!doctype html><body><span id="lbl">Delete account</span><button aria-labelledby="lbl">Go</button></body>'
  );
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  assert.equal(nodes.find((n) => n.role === 'button').name, 'Delete account');
});

test('explicit role attributes win over the tag', async () => {
  const { call } = loadPage('<!doctype html><body><div role="button" tabindex="0">Fake button</div></body>');
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  assert.equal(nodes[0].role, 'button');
  assert.equal(nodes[0].name, 'Fake button');
});

test('aria-hidden nodes are excluded', async () => {
  const { call } = loadPage(
    '<!doctype html><body><button aria-hidden="true">Ghost</button><button>Real</button></body>'
  );
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  assert.equal(nodes.some((n) => n.name === 'Ghost'), false);
  assert.equal(nodes.some((n) => n.name === 'Real'), true);
});

test('state attributes are reported', async () => {
  const { call } = loadPage(
    '<!doctype html><body><button aria-expanded="false" disabled>Menu</button>' +
      '<input type="checkbox" checked id="c"><label for="c">Agree</label></body>'
  );
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const menu = nodes.find((n) => n.name === 'Menu');
  assert.match(menu.attrs, /expanded=false/);
  assert.match(menu.attrs, /disabled=true/);
  assert.match(nodes.find((n) => n.role === 'checkbox').attrs, /checked=true/);
});

test('FORM_INPUT sets a text field and fires framework events', async () => {
  const { call, window } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const email = nodes.find((n) => n.name === 'Email address');

  const events = [];
  const input = window.document.getElementById('email');
  input.addEventListener('input', () => events.push('input'));
  input.addEventListener('change', () => events.push('change'));

  const result = await call({ type: 'FORM_INPUT', ref: email.ref, value: 'user@test.dev' });
  assert.equal(result.ok, true);
  assert.equal(input.value, 'user@test.dev');
  assert.deepEqual(events, ['input', 'change']);
});

test('FORM_INPUT selects an option by visible label', async () => {
  const { call, window } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  const select = nodes.find((n) => n.role === 'combobox');

  const result = await call({ type: 'FORM_INPUT', ref: select.ref, value: 'United States' });
  assert.equal(result.ok, true);
  assert.equal(window.document.getElementById('country').value, 'us');
});

test('FORM_INPUT lists the options when none match', async () => {
  const { call } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  const select = nodes.find((n) => n.role === 'combobox');

  const result = await call({ type: 'FORM_INPUT', ref: select.ref, value: 'Atlantis' });
  assert.match(result.error, /no option matching/);
  assert.deepEqual(Array.from(result.available), ['Brazil', 'United States']);
});

test('FORM_INPUT toggles a checkbox', async () => {
  const { call, window } = loadPage(LOGIN_PAGE);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 })).text);
  const box = nodes.find((n) => n.role === 'checkbox');

  await call({ type: 'FORM_INPUT', ref: box.ref, value: true });
  assert.equal(window.document.getElementById('remember').checked, true);
  await call({ type: 'FORM_INPUT', ref: box.ref, value: false });
  assert.equal(window.document.getElementById('remember').checked, false);
});

test('FORM_INPUT refuses a non-control element', async () => {
  const { call } = loadPage('<!doctype html><body><button>Not a field</button></body>');
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const result = await call({ type: 'FORM_INPUT', ref: nodes[0].ref, value: 'x' });
  assert.match(result.error, /not a form control/);
});

test('GET_PAGE_TEXT prefers main content over navigation', async () => {
  const { call } = loadPage(`<!doctype html><body>
    <nav><a href="/">Skip this navigation</a></nav>
    <main><p>First paragraph of the article.</p><p>Second paragraph.</p></main>
  </body>`);
  const result = await call({ type: 'GET_PAGE_TEXT', maxChars: 5000 });
  assert.match(result.text, /First paragraph of the article/);
  assert.match(result.text, /Second paragraph/);
  assert.equal(/Skip this navigation/.test(result.text), false);
});

test('GET_PAGE_TEXT reports the true size when truncated', async () => {
  const long = '<p>' + 'word '.repeat(5000) + '</p>';
  const { call } = loadPage('<!doctype html><body><main>' + long + '</main></body>');
  const result = await call({ type: 'GET_PAGE_TEXT', maxChars: 200 });
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 200);
  assert.ok(result.totalChars > 200);
});

test('PAGE_STATE reports url, title, and viewport', async () => {
  const { call } = loadPage('<!doctype html><html><head><title>My page</title></head><body></body></html>');
  const state = await call({ type: 'PAGE_STATE' });
  assert.equal(state.title, 'My page');
  assert.equal(state.url, 'https://example.test/page');
  assert.equal(state.viewport.width, 1024);
});

test('the tree survives a deeply nested document without blowing up', async () => {
  let html = '<button>Bottom</button>';
  for (let i = 0; i < 200; i++) html = '<div>' + html + '</div>';
  const { call } = loadPage('<!doctype html><body>' + html + '</body>');
  const result = await call({ type: 'READ_PAGE', filter: 'interactive', depth: 300 });
  assert.equal(result.error, undefined);
  assert.ok(parseTree(result.text).some((n) => n.name === 'Bottom'));
});

test('table structure maps to table roles', async () => {
  const { call } = loadPage(`<!doctype html><body><table>
    <thead><tr><th>Name</th><th>Price</th></tr></thead>
    <tbody><tr><td>Widget</td><td>$10</td></tr></tbody>
  </table></body>`);
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'all', depth: 20 })).text);
  assert.equal(nodes.some((n) => n.role === 'table'), true);
  assert.equal(nodes.some((n) => n.role === 'columnheader' && n.name === 'Name'), true);
  assert.equal(nodes.some((n) => n.role === 'cell' && n.name === 'Widget'), true);
});

test('an interactive div takes its name from its text', () => {
  // A div carrying tabindex is addressable, so an unnamed tree entry for it
  // would be useless even though ARIA gives a generic no name from content.
  const { call } = loadPage('<!doctype html><body><div tabindex="0">Custom control</div></body>');
  return call({ type: 'READ_PAGE', filter: 'interactive' }).then((r) => {
    const nodes = parseTree(r.text);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].name, 'Custom control');
  });
});

test('a plain container still contributes no name', () => {
  const { call } = loadPage('<!doctype html><body><div><span>just text</span></div></body>');
  return call({ type: 'READ_PAGE', filter: 'all', depth: 20 }).then((r) => {
    assert.equal(parseTree(r.text).some((n) => n.name === 'just text'), false);
  });
});

test('a visually hidden input with a styled label stays reachable', () => {
  // The custom-radio pattern: the native input is hidden with opacity 0 and the
  // label is the thing a person sees and clicks. Dropping the input as invisible
  // and the label as a duplicate made the whole control disappear.
  const { call, window } = loadPage(
    '<!doctype html><body>' +
      '<input type="radio" id="night" name="theme" style="opacity:0;position:absolute">' +
      '<label for="night">Dark</label>' +
      '</body>'
  );
  window.getComputedStyle = ((original) => (el, pe) => {
    const style = original.call(window, el, pe);
    if (el.id === 'night') return { ...style, opacity: '0', display: 'block', visibility: 'visible' };
    return style;
  })(window.getComputedStyle);

  return call({ type: 'READ_PAGE', filter: 'interactive', depth: 20 }).then((r) => {
    const nodes = parseTree(r.text);
    const radio = nodes.find((n) => n.role === 'radio');
    assert.ok(radio, 'the hidden radio is still in the tree');
    assert.equal(radio.name, 'Dark', 'it takes its name from the visible label');
    assert.equal(nodes.filter((n) => n.name === 'Dark').length, 1, 'the label does not duplicate it');
  });
});

test('the hidden attribute prunes the subtree, not just the element', async () => {
  const { call } = loadPage(`<!doctype html><html><body>
    <div hidden><a href="/reload">Reload</a><span>Please reload</span></div>
    <a href="/ok">Visible</a>
  </body></html>`);
  const result = await call({ type: 'READ_PAGE', filter: 'all' });
  assert.ok(!/Reload/.test(result.text), 'links under a hidden ancestor are not listed');
  assert.ok(/link "Visible"/.test(result.text));
});

test('bare text in a container with no role is emitted as text', async () => {
  const { call } = loadPage(`<!doctype html><html><body>
    <div id="column-a"><header>A</header></div>
    <div>Hello world</div>
    <p>In a paragraph</p>
    <button>Save</button>
  </body></html>`);
  const result = await call({ type: 'READ_PAGE', filter: 'all' });
  assert.ok(/text "Hello world"/.test(result.text), 'div text is present: ' + result.text);
  assert.ok(/text "A"/.test(result.text), 'header text is present');
  assert.ok(!/text "In a paragraph"/.test(result.text), 'text already carried by a named node is not repeated');
  assert.ok(!/text "Save"/.test(result.text), 'button text is not repeated');
  const interactive = await call({ type: 'READ_PAGE', filter: 'interactive' });
  assert.ok(!/text "/.test(interactive.text), 'the interactive filter carries no text nodes');
});

test('GET_PAGE_TEXT skips page chrome but keeps an article\'s own header and hidden panels stay out', async () => {
  const { call } = loadPage(`<!doctype html><html><body>
    <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <main>
      <article>
        <header><h1>Post title</h1><time>2026-09-03</time><a href="/t/focus">focus</a><a href="/t/grayscale">grayscale</a></header>
        <p>Body text here.</p>
        <div style="display:none"><p>Collapsed panel text</p></div>
        <div hidden><p>Hidden attribute text</p></div>
        <select><option>One</option><option>Two</option></select>
      </article>
      <aside>Related links</aside>
    </main>
    <footer>Site footer</footer>
  </body></html>`);
  const result = await call({ type: 'GET_PAGE_TEXT' });
  assert.ok(/Post title/.test(result.text), 'article header kept: ' + result.text);
  assert.ok(/focus grayscale/.test(result.text), 'adjacent inline tags are separated: ' + result.text);
  assert.ok(/Body text here/.test(result.text));
  assert.ok(!/Home/.test(result.text) && !/About/.test(result.text), 'page navigation skipped');
  assert.ok(!/Related links/.test(result.text), 'aside skipped');
  assert.ok(!/Site footer/.test(result.text), 'page footer skipped');
  assert.ok(!/Collapsed panel text/.test(result.text), 'display:none ancestor skipped');
  assert.ok(!/Hidden attribute text/.test(result.text), 'hidden ancestor skipped');
  assert.ok(!/OneTwo/.test(result.text), 'options are not run together');
});

// ---------------------------------------------------------------------------
// R2: get_page_text returns something, and says why when it does not
// ---------------------------------------------------------------------------

test('GET_PAGE_TEXT falls back when the first article is an empty slot', async () => {
  // The shape LinkedIn's feed has: the first <article> in the DOM is a
  // placeholder, and the prose is in a <main> further down.
  const { call } = loadPage(`<!doctype html><body>
    <article></article>
    <main><p>The feed post everyone can see.</p></main>
  </body>`);
  const result = await call({ type: 'GET_PAGE_TEXT', maxChars: 5000 });

  assert.match(result.text, /The feed post everyone can see/);
  assert.equal(result.fallback, true, 'the result says it did not use the first container');
  assert.match(result.container, /body/);
  assert.ok(result.textNodes >= 1, 'the accepted node count is reported');
});

test('GET_PAGE_TEXT relaxes the visibility filter when it rejected everything', async () => {
  const { call } = loadPageWith(
    `<!doctype html><body>
      <main data-content-visibility="auto"><p>Notion block prose.</p></main>
    </body>`,
    { contentVisibilitySkips: true }
  );
  const result = await call({ type: 'GET_PAGE_TEXT', maxChars: 5000 });

  assert.match(result.text, /Notion block prose/);
  assert.match(result.container, /visibility filter relaxed/);
});

test('GET_PAGE_TEXT reports the counts that explain an empty result', async () => {
  const { call } = loadPage('<!doctype html><body><main><p hidden>Never shown.</p></main></body>');
  const result = await call({ type: 'GET_PAGE_TEXT', maxChars: 5000 });

  assert.equal(result.text, '');
  assert.equal(result.textNodes, 0);
  assert.ok(result.rejectedHidden >= 1, 'the hidden rejection is counted: ' + JSON.stringify(result));
  assert.equal(typeof result.rejectedEmpty, 'number');
});

test('GET_PAGE_TEXT keeps the container it used when the first one works', async () => {
  const { call } = loadPage('<!doctype html><body><main><p>Plain prose.</p></main></body>');
  const result = await call({ type: 'GET_PAGE_TEXT' });

  assert.equal(result.container, 'main');
  assert.equal(result.fallback, false);
});

// ---------------------------------------------------------------------------
// S4: the truncation line
// ---------------------------------------------------------------------------

test('a truncated tree ends with the count it did not show, inside the budget', async () => {
  const many = Array.from({ length: 400 }, (_, i) => '<button>Action number ' + i + '</button>').join('');
  const { call } = loadPage('<!doctype html><body>' + many + '</body>');
  const result = await call({ type: 'READ_PAGE', filter: 'interactive', maxChars: 4000 });

  const lastLine = result.text.split('\n').pop();
  assert.match(lastLine, /^note: truncated\./);
  assert.match(lastLine, new RegExp(result.hiddenNodes + ' more nodes not shown'));
  assert.ok(result.text.length <= 4000, 'the note fits inside the budget: ' + result.text.length);
  assert.equal(result.shownNodes + result.hiddenNodes, result.nodes);
});

test('PAGE_STATE reports the window outer size alongside the viewport', async () => {
  const { call } = loadPageWith('<!doctype html><body></body>', { width: 800, height: 600 });
  const state = await call({ type: 'PAGE_STATE' });

  assert.equal(state.viewport.width, 800);
  assert.equal(state.outerWidth, 816);
  assert.equal(state.outerHeight, 688);
});

// ---------------------------------------------------------------------------
// P7: the caret lands at the end after FORM_INPUT
// ---------------------------------------------------------------------------

test('FORM_INPUT places the caret at the end of a text field', async () => {
  const { call, window } = loadPage('<!doctype html><body><input type="text" id="name" value="old"></body>');
  const input = window.document.getElementById('name');
  // Simulate the caret sitting wherever the previous value left it, so the
  // test can tell setSelectionRange actually ran rather than the caret just
  // happening to already be at the end.
  input.focus();
  input.setSelectionRange(0, 0);

  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const result = await call({ type: 'FORM_INPUT', ref: nodes[0].ref, value: 'a much longer replacement' });

  assert.equal(result.ok, true);
  assert.equal(input.selectionStart, input.value.length);
  assert.equal(input.selectionEnd, input.value.length);
});

test('FORM_INPUT places the caret at the end of a textarea', async () => {
  const { call, window } = loadPage('<!doctype html><body><textarea id="notes"></textarea></body>');
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  await call({ type: 'FORM_INPUT', ref: nodes[0].ref, value: 'line one\nline two' });

  const textarea = window.document.getElementById('notes');
  assert.equal(textarea.selectionStart, textarea.value.length);
});

test('FORM_INPUT does not move the caret for a type with no text selection model', async () => {
  const { call, window } = loadPage('<!doctype html><body><input type="number" id="qty" value="1"></body>');
  const nodes = parseTree((await call({ type: 'READ_PAGE', filter: 'interactive' })).text);
  const result = await call({ type: 'FORM_INPUT', ref: nodes[0].ref, value: 5 });
  assert.equal(result.ok, true);
  assert.equal(window.document.getElementById('qty').value, '5');
});
