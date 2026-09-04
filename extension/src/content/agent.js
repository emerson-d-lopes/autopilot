// Content script, injected at document_start on every page.
//
// Runs in the isolated world, so the ref map cannot be observed or clobbered by
// page scripts. Pre-injection means reading a page costs one message hop rather
// than a chrome.scripting.executeScript round trip.

(() => {
  if (globalThis.__chromeMcpAgentInstalled) return;
  globalThis.__chromeMcpAgentInstalled = true;

  // ---------------------------------------------------------------------------
  // Ref registry
  // ---------------------------------------------------------------------------

  /** @type {Map<string, WeakRef<Element>>} */
  const refToElement = new Map();
  /** @type {WeakMap<Element, string>} */
  const elementToRef = new WeakMap();
  /**
   * Offset of the frame an element lives in, relative to the top document.
   *
   * getBoundingClientRect inside an iframe is relative to that iframe's own
   * viewport, but CDP dispatches input in top-level coordinates. Without this,
   * a click on an element inside a frame silently lands somewhere else in the
   * parent page and still reports success.
   */
  const frameChains = new WeakMap();
  let refCounter = 0;

  function refFor(el) {
    const existing = elementToRef.get(el);
    if (existing) {
      // Confirm the WeakRef still resolves. A detached element keeps its id so
      // repeated reads of a stable page keep stable refs.
      const held = refToElement.get(existing);
      if (held && held.deref() === el) return existing;
    }
    const id = 'ref_' + ++refCounter;
    elementToRef.set(el, id);
    refToElement.set(id, new WeakRef(el));
    return id;
  }

  function resolveRef(ref) {
    const held = refToElement.get(ref);
    if (!held) return null;
    const el = held.deref();
    if (!el) {
      refToElement.delete(ref);
      return null;
    }
    if (!el.isConnected) return null;
    return el;
  }

  // ---------------------------------------------------------------------------
  // Role mapping
  // ---------------------------------------------------------------------------

  const INPUT_ROLES = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    email: 'textbox',
    tel: 'textbox',
    text: 'textbox',
    url: 'textbox',
    password: 'textbox',
    date: 'textbox',
    'datetime-local': 'textbox',
    month: 'textbox',
    week: 'textbox',
    time: 'textbox',
    file: 'button',
    color: 'textbox',
    hidden: null,
  };

  const TAG_ROLES = {
    A: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
    BUTTON: () => 'button',
    SUMMARY: () => 'button',
    DETAILS: () => 'group',
    SELECT: (el) => (el.multiple || el.size > 1 ? 'listbox' : 'combobox'),
    OPTION: () => 'option',
    TEXTAREA: () => 'textbox',
    INPUT: (el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return Object.prototype.hasOwnProperty.call(INPUT_ROLES, type)
        ? INPUT_ROLES[type]
        : 'textbox';
    },
    IMG: (el) => (el.getAttribute('alt') === '' ? null : 'img'),
    H1: () => 'heading',
    H2: () => 'heading',
    H3: () => 'heading',
    H4: () => 'heading',
    H5: () => 'heading',
    H6: () => 'heading',
    UL: () => 'list',
    OL: () => 'list',
    LI: () => 'listitem',
    DL: () => 'list',
    NAV: () => 'navigation',
    MAIN: () => 'main',
    HEADER: () => 'banner',
    FOOTER: () => 'contentinfo',
    ASIDE: () => 'complementary',
    FORM: () => 'form',
    SEARCH: () => 'search',
    DIALOG: () => 'dialog',
    TABLE: () => 'table',
    THEAD: () => 'rowgroup',
    TBODY: () => 'rowgroup',
    TFOOT: () => 'rowgroup',
    TR: () => 'row',
    TD: () => 'cell',
    TH: (el) => (el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'),
    IFRAME: () => 'iframe',
    FRAME: () => 'iframe',
    VIDEO: () => 'video',
    AUDIO: () => 'audio',
    CANVAS: () => 'canvas',
    SVG: () => 'graphic',
    P: () => 'paragraph',
    HR: () => 'separator',
    PROGRESS: () => 'progressbar',
    METER: () => 'meter',
    FIELDSET: () => 'group',
    LEGEND: () => 'legend',
    LABEL: () => 'generic',
    CODE: () => 'code',
    PRE: () => 'pre',
    BLOCKQUOTE: () => 'blockquote',
    TIME: () => 'time',
  };

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'META',
    'LINK',
    'HEAD',
    'TITLE',
    'BASE',
    'PARAM',
    'SOURCE',
    'TRACK',
  ]);

  const INTERACTIVE_ROLES = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'gridcell',
  ]);

  // Roles whose accessible name comes from descendant text.
  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'option',
    'listitem',
    'cell',
    'columnheader',
    'rowheader',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'switch',
    'checkbox',
    'radio',
    'legend',
    'paragraph',
    'code',
    'time',
    'blockquote',
  ]);

  /**
   * Whether the element is an editing host.
   *
   * `isContentEditable` is the browser's own answer and covers a descendant of
   * an editing host. The attribute check is what catches the host itself in
   * environments that do not implement editing.
   */
  function isEditableHost(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const v = el.getAttribute && el.getAttribute('contenteditable');
    return v === '' || v === 'true';
  }

  // ---------------------------------------------------------------------------
  // Sensitive fields (F1)
  // ---------------------------------------------------------------------------
  //
  // A value from one of these never leaves the page: not in the tree, not in a
  // form_input confirmation, not in the journal. The test is the field itself
  // rather than the page, because a password box on an ordinary page is still a
  // password box.

  const SENSITIVE_AUTOCOMPLETE = [
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp-month',
    'cc-exp-year',
    'cc-exp',
  ];

  const REDACTED_VALUE = '[value redacted]';

  function isSensitiveField(el) {
    if (!el || !el.getAttribute) return false;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password' || type === 'hidden') return true;
    }
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (!auto) return false;
    return SENSITIVE_AUTOCOMPLETE.some((token) => auto.includes(token));
  }

  // ---------------------------------------------------------------------------
  // Irreversible controls (W3)
  // ---------------------------------------------------------------------------
  //
  // One list, used by the tree, by find (which reads the tree's text) and by the
  // click result. A control marked here cannot be undone by clicking something
  // else, so the model gets to know before it presses rather than after.

  const IRREVERSIBLE_WORDS = [
    'send',
    'post',
    'publish',
    'delete',
    'remove',
    'pay',
    'purchase',
    'buy',
    'confirm order',
    'transfer',
    'unsubscribe',
  ];

  // Whole words only, so "Posted by" and "Sender" do not match, and the two-word
  // entry tolerates any run of whitespace between its halves.
  const IRREVERSIBLE_RE = new RegExp(
    '(^|[^a-z])(' + IRREVERSIBLE_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|') + ')([^a-z]|$)',
    'i'
  );

  const IRREVERSIBLE_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
  ]);

  // Set by the caller when the page is in the permission policy's payment
  // category, where every control is treated as irreversible.
  let paymentCategoryPage = false;

  function isIrreversibleControl(el, role, name) {
    if (!IRREVERSIBLE_ROLES.has(role)) return false;
    if (paymentCategoryPage) return true;
    if (name && IRREVERSIBLE_RE.test(name)) return true;
    const formAction = el.getAttribute && el.getAttribute('formaction');
    if (formAction && IRREVERSIBLE_RE.test(formAction)) return true;
    const form = el.form || (el.closest && el.closest('form'));
    const action = form && form.getAttribute && form.getAttribute('action');
    if (action && IRREVERSIBLE_RE.test(action)) return true;
    return false;
  }

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    const fn = TAG_ROLES[tag];
    if (fn) return fn(el);
    if (isEditableHost(el)) return 'textbox';
    if (el.hasAttribute && el.hasAttribute('tabindex')) return 'generic';
    return 'generic';
  }

  // ---------------------------------------------------------------------------
  // Accessible name
  // ---------------------------------------------------------------------------

  function textOf(el, depth = 0) {
    if (!el || depth > 4) return '';
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (SKIP_TAGS.has(node.tagName)) continue;
        if (node.getAttribute('aria-hidden') === 'true') continue;
        const alt = node.getAttribute('alt');
        if (node.tagName === 'IMG' && alt) {
          out += ' ' + alt + ' ';
          continue;
        }
        out += ' ' + textOf(node, depth + 1) + ' ';
      }
      if (out.length > 400) break;
    }
    return out;
  }

  function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function associatedLabel(el) {
    if (el.id) {
      const root = el.getRootNode();
      const escaped =
        typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"');
      const label = root.querySelector && root.querySelector('label[for="' + escaped + '"]');
      if (label) return label;
    }
    return (el.closest && el.closest('label')) || null;
  }

  function labelForControl(el) {
    const label = associatedLabel(el);
    return label ? normalize(textOf(label)) : '';
  }

  function isRendered(el) {
    const style = getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity !== '' && parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  /**
   * The element a control is really clicked through.
   *
   * Design systems routinely hide the native input (opacity 0, a 1px clip, an
   * absolute box behind the styled control) and let its label be what a person
   * sees and clicks. The input still carries the state, so the tree keeps one
   * node for the input and borrows the label's box for geometry, hit testing and
   * scrolling. Without this the input is dropped as invisible, the label is
   * dropped as a duplicate name, and the control vanishes from the page.
   */
  function hitBoxFor(el) {
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return el;
    if (isRendered(el)) return el;
    const label = associatedLabel(el);
    if (label && isRendered(label)) return label;
    return el;
  }

  function accessibleName(el, role, interactive) {
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const target = root.getElementById
            ? root.getElementById(id)
            : document.getElementById(id);
          return target ? normalize(textOf(target)) : '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel && normalize(ariaLabel)) return normalize(ariaLabel);

    const tag = el.tagName;

    if (tag === 'IMG' || tag === 'AREA') {
      const alt = el.getAttribute('alt');
      if (alt) return normalize(alt);
    }

    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'reset' || type === 'button') {
        const v = el.getAttribute('value');
        if (v) return normalize(v);
        if (type === 'submit') return 'Submit';
        if (type === 'reset') return 'Reset';
      }
      if (type === 'image') {
        const alt = el.getAttribute('alt');
        if (alt) return normalize(alt);
      }
      const fromLabel = labelForControl(el);
      if (fromLabel) return fromLabel;
      const ph = el.getAttribute('placeholder');
      if (ph) return normalize(ph);
    }

    if (tag === 'TEXTAREA' || tag === 'SELECT') {
      const fromLabel = labelForControl(el);
      if (fromLabel) return fromLabel;
      const ph = el.getAttribute('placeholder');
      if (ph) return normalize(ph);
    }

    if (tag === 'IFRAME' || tag === 'FRAME') {
      const title = el.getAttribute('title');
      if (title) return normalize(title);
      const src = el.getAttribute('src');
      if (src) return normalize(src).slice(0, 80);
    }

    // Only roles that take their name from content do so. Letting a generic
    // container name itself from its subtree makes every wrapper repeat the
    // text of everything inside it, which is most of what bloats a naive tree.
    //
    // An interactive generic is the exception. A div carrying tabindex or a
    // click handler is something the model has to be able to refer to, and an
    // unnamed entry in the tree is not usable, so it takes its name from text.
    if (NAME_FROM_CONTENT.has(role) || (interactive && role === 'generic')) {
      const text = normalize(textOf(el));
      if (text) return text.slice(0, 200);
    }

    const title = el.getAttribute && el.getAttribute('title');
    if (title) return normalize(title);

    return '';
  }

  // ---------------------------------------------------------------------------
  // Visibility and geometry
  // ---------------------------------------------------------------------------

  function inViewport(rect) {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  /**
   * Splits three states the tree treats differently.
   *
   * hidden:     removed from the accessibility tree, subtree included
   * rendered:   has a box, so it can be clicked once scrolled to
   * onScreen:   that box currently intersects the viewport
   *
   * Conflating "hidden" with "outside the viewport" is how a tree ends up
   * omitting every element below the fold.
   */
  function visibilityOf(el) {
    if (!el.getBoundingClientRect) return { hidden: true, rendered: false, onScreen: false };
    // The hidden attribute takes the whole subtree out of the page. Without
    // prune the children were still walked, and links inside a hidden alert
    // showed up in the tree looking clickable.
    if (el.hasAttribute && el.hasAttribute('hidden')) {
      return { hidden: true, rendered: false, onScreen: false, prune: true };
    }

    // A control whose native input is hidden behind a styled label is judged by
    // the label, since that is the thing actually on screen.
    const box = hitBoxFor(el);
    const style = getComputedStyle(box);
    if (!style) return { hidden: true, rendered: false, onScreen: false };
    if (style.display === 'none') {
      return { hidden: true, rendered: false, onScreen: false, prune: box === el };
    }
    if (style.visibility === 'hidden') return { hidden: true, rendered: false, onScreen: false };
    if (style.opacity !== '' && parseFloat(style.opacity) === 0) {
      return { hidden: true, rendered: false, onScreen: false };
    }

    const rect = box.getBoundingClientRect();
    const rendered = rect.width > 0 || rect.height > 0;
    const off = offsetFor(el);
    const shifted = {
      left: rect.left + off.x,
      top: rect.top + off.y,
      right: rect.right + off.x,
      bottom: rect.bottom + off.y,
    };
    return { hidden: false, rendered, onScreen: rendered && inViewport(shifted) };
  }

  /** aria-hidden removes the element and everything under it from the tree. */
  function isAriaHidden(el) {
    return el.getAttribute && el.getAttribute('aria-hidden') === 'true';
  }

  /**
   * A label whose text already appears as some control's accessible name is
   * duplicate output, so it is skipped while its children are still walked.
   */
  function isRedundantLabel(el) {
    if (el.tagName !== 'LABEL') return false;
    const forId = el.getAttribute('for');
    if (forId) {
      const root = el.getRootNode();
      const target = root.getElementById ? root.getElementById(forId) : document.getElementById(forId);
      if (target) return true;
    }
    return Boolean(el.querySelector && el.querySelector('input, select, textarea'));
  }

  /** Not every element exposes scrollIntoView, and a failed scroll must not fail the action. */
  function scrollIntoView(el) {
    try {
      const box = hitBoxFor(el);
      if (typeof box.scrollIntoView === 'function') {
        box.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }
    } catch {
      /* the click can still land once coordinates are resolved */
    }
  }

  /** Current offset of an element's frame, measured now rather than when the tree was read. */
  function offsetFor(el) {
    const chain = frameChains.get(el);
    if (!chain || !chain.length) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    for (const frame of chain) {
      if (!frame.isConnected) return { x: 0, y: 0 };
      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      x += rect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
      y += rect.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
    }
    return { x, y };
  }

  function geometryOf(el) {
    const rect = hitBoxFor(el).getBoundingClientRect();
    const off = offsetFor(el);
    const left = rect.left + off.x;
    const top = rect.top + off.y;
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(left + rect.width / 2),
      centerY: Math.round(top + rect.height / 2),
      inViewport: inViewport({
        left,
        top,
        right: left + rect.width,
        bottom: top + rect.height,
        width: rect.width,
        height: rect.height,
      }),
      frame: off.x || off.y ? { offsetX: Math.round(off.x), offsetY: Math.round(off.y) } : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Attributes worth reporting
  // ---------------------------------------------------------------------------

  function interestingAttributes(el, role) {
    const out = [];
    const push = (k, v) => {
      if (v === null || v === undefined || v === '') return;
      let s = String(v);
      if (s.length > 120) s = s.slice(0, 117) + '...';
      out.push(k + '=' + (/[\s"]/.test(s) ? JSON.stringify(s) : s));
    };

    // A sensitive control reports that it holds a value and never what the
    // value is, and a sensitive select does not list what it could be set to.
    const sensitive = isSensitiveField(el);

    if (el.tagName === 'A') push('href', el.getAttribute('href'));
    if (el.tagName === 'INPUT') {
      push('type', (el.getAttribute('type') || 'text').toLowerCase());
      if (el.value) push('value', sensitive ? REDACTED_VALUE : el.value);
      if (el.checked) push('checked', 'true');
    }
    if (el.tagName === 'TEXTAREA' && el.value) {
      push('value', sensitive ? REDACTED_VALUE : el.value.slice(0, 120));
    }
    if (el.tagName === 'SELECT') {
      const sel = el.selectedOptions && el.selectedOptions[0];
      if (sensitive) {
        if (sel) push('selected', REDACTED_VALUE);
      } else {
        if (sel) push('selected', sel.textContent && sel.textContent.trim());
        // Summarised here so the options do not each become a tree node. A select
        // with 200 countries would otherwise cost 200 lines.
        const labels = Array.from(el.options || [])
          .slice(0, 8)
          .map((o) => (o.textContent || '').trim())
          .filter(Boolean);
        if (labels.length) {
          push('options', labels.join('|') + (el.options.length > 8 ? '|...+' + (el.options.length - 8) : ''));
        }
      }
    }
    if (el.tagName === 'IFRAME') push('src', el.getAttribute('src'));

    const placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder && !out.some((a) => a.startsWith('value='))) push('placeholder', placeholder);

    if (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')) {
      push('disabled', 'true');
    }
    const expanded = el.getAttribute && el.getAttribute('aria-expanded');
    if (expanded) push('expanded', expanded);
    const checkedAttr = el.getAttribute && el.getAttribute('aria-checked');
    if (checkedAttr) push('checked', checkedAttr);
    const selectedAttr = el.getAttribute && el.getAttribute('aria-selected');
    if (selectedAttr) push('selected', selectedAttr);
    const current = el.getAttribute && el.getAttribute('aria-current');
    if (current) push('current', current);
    if (role === 'heading') {
      const level =
        (el.getAttribute && el.getAttribute('aria-level')) ||
        (/^H([1-6])$/.test(el.tagName) ? el.tagName[1] : null);
      push('level', level);
    }
    if (el.hasAttribute && el.hasAttribute('required')) push('required', 'true');

    return out;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (isEditableHost(el)) return true;
    if (el.hasAttribute && el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute && el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== undefined && parseInt(tabindex, 10) >= 0) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Tree walk
  // ---------------------------------------------------------------------------

  /** Returns [element, extraOffset] pairs so a frame's contents carry their shift. */
  function childrenOf(el) {
    const kids = [];
    // Options are summarised on the select itself.
    if (el.tagName === 'SELECT') return kids;
    if (el.shadowRoot) {
      for (const c of el.shadowRoot.children) kids.push([c, null]);
    }
    for (const c of el.children) kids.push([c, null]);

    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      // Same-origin frames can be walked inline. Cross-origin frames throw and
      // are reported as a leaf, to be read separately by frame-targeted calls.
      try {
        const doc = el.contentDocument;
        if (doc && doc.documentElement) kids.push([doc.documentElement, el]);
      } catch {
        /* cross-origin, leaf */
      }
    }
    return kids;
  }

  /**
   * Builds the indented tree.
   *
   * Returns { lines, totalChars, truncated } where lines is an array of strings
   * already prefixed with indentation.
   */
  // Bounds raw recursion independently of the semantic depth budget, so a page
  // that nests 300 wrappers around a button cannot exhaust the stack.
  const MAX_DOM_DEPTH = 400;
  const MAX_NODES = 20000;

  function buildTree(root, options) {
    const { filter, depth: maxDepth, includeInvisible } = options;
    const lines = [];
    let nodeCount = 0;

    /**
     * @param depth  nesting level in the emitted tree, which is what maxDepth
     *               bounds. Wrapper elements that emit nothing do not consume
     *               it, so a button under 20 anonymous divs is still reachable
     *               at the default depth.
     * @param domDepth raw recursion guard.
     */
    function visit(el, depth, domDepth, frames) {
      if (depth > maxDepth || domDepth > MAX_DOM_DEPTH) return;
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      const tag = el.tagName ? el.tagName.toUpperCase() : '';
      if (SKIP_TAGS.has(tag)) return;
      if (nodeCount > MAX_NODES) return;

      // Recorded before anything reads geometry, since visibility is judged
      // against the top-level viewport.
      if (frames.length) frameChains.set(el, frames);

      // aria-hidden and display:none both remove the whole subtree.
      if (el.id === CURSOR_HOST_ID) return;
      if (!includeInvisible && isAriaHidden(el)) return;
      const visibility = visibilityOf(el);
      if (!includeInvisible && visibility.prune) return;

      const role = roleOf(el);
      const interactive = role ? isInteractive(el, role) : false;

      let emit = role !== null;
      if (filter === 'interactive' && !interactive) emit = false;
      if (!includeInvisible && visibility.hidden) emit = false;
      if (emit && isRedundantLabel(el)) emit = false;

      let name = '';
      if (emit) {
        name = accessibleName(el, role, interactive);
        // Structural nodes carrying neither a name nor an action are noise.
        if (role === 'generic' && !name && !interactive) emit = false;
      }

      let childDepth = depth;
      if (emit) {
        nodeCount++;
        const ref = refFor(el);
        const attrs = interestingAttributes(el, role);
        const parts = [role];
        if (name) parts.push(JSON.stringify(name));
        // Sits between the name and the ref, so a reader sees what the control
        // does before it sees how to press it.
        if (isIrreversibleControl(el, role, name)) parts.push('[irreversible]');
        parts.push('[' + ref + ']');
        if (visibility.rendered && !visibility.onScreen) parts.push('(offscreen)');
        if (attrs.length) parts.push(attrs.join(' '));
        lines.push('  '.repeat(Math.min(depth, 30)) + parts.join(' '));
        childDepth = depth + 1;
      }

      // Text that sits directly in a container with no role of its own, such
      // as <div>Hello</div> or a frame body holding a single word, is not
      // carried by any emitted node. It is emitted as text so the page's
      // content is readable from the tree, the way a screen reader would read
      // it. Skipped when the element's accessible name already carries it, and
      // in the interactive filter, which is about controls.
      const emitText = filter !== 'interactive' && !visibility.hidden && !(emit && name);
      if (emitText) {
        for (const child of el.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE) continue;
          const text = child.nodeValue.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          nodeCount++;
          lines.push('  '.repeat(Math.min(childDepth, 30)) + 'text ' + JSON.stringify(text.length > 300 ? text.slice(0, 297) + '...' : text));
        }
      }

      for (const [child, frame] of childrenOf(el)) {
        visit(child, childDepth, domDepth + 1, frame ? frames.concat(frame) : frames);
      }
    }

    visit(root, 0, 0, []);
    return lines;
  }

  function coveringForeignFrame() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!vw || !vh) return null;
    let best = null;
    for (const frame of document.querySelectorAll('iframe')) {
      let foreign = false;
      try {
        foreign = !frame.contentDocument;
      } catch {
        foreign = true;
      }
      if (!foreign) continue;
      const style = getComputedStyle(frame);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = frame.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const percent = Math.round(((w * h) / (vw * vh)) * 100);
      if (percent >= 40 && (!best || percent > best.percent)) {
        best = { percent, src: (frame.getAttribute('src') || frame.title || frame.id || 'unnamed').slice(0, 80) };
      }
    }
    return best;
  }

  function renderTree(options) {
    const {
      filter = 'all',
      depth = 15,
      maxChars = 50000,
      refId = null,
      includeInvisible = false,
      paymentCategory = false,
    } = options || {};

    paymentCategoryPage = Boolean(paymentCategory);

    let root = document.documentElement;
    if (refId) {
      const el = resolveRef(refId);
      if (!el) {
        return { error: 'ref ' + refId + ' is no longer on the page. Re-read the page.' };
      }
      root = el;
    }
    if (!root) return { error: 'document has no root element yet' };

    const lines = buildTree(root, { filter, depth, includeInvisible });
    // A consent dialog or a login wall is usually a cross-origin frame laid
    // over the page. Its contents cannot be read here, so the tree would show
    // the page underneath as if it were clickable. Saying so points the caller
    // at a screenshot and a coordinate click.
    const overlay = coveringForeignFrame();
    if (overlay) {
      lines.unshift(
        'note: a cross-origin frame (' + overlay.src + ') covers ' + overlay.percent + '% of the viewport. ' +
          'Its contents are not in this tree. Take a screenshot and act on it by coordinate.'
      );
    }
    const full = lines.join('\n');
    if (full.length <= maxChars) {
      return { text: full, totalChars: full.length, truncated: false, nodes: lines.length };
    }

    // Truncate at a line boundary and report the real size so the caller knows
    // to narrow with ref_id or depth instead of assuming the page is small.
    //
    // The count that is not shown goes in the text as well as in the fields,
    // because a model reading the tree inline never sees the fields. Room for
    // that line is reserved out of the budget, so the whole result still fits
    // in maxChars.
    const NOTE_ROOM = 200;
    const budget = Math.max(0, maxChars - NOTE_ROOM);
    let acc = 0;
    const kept = [];
    for (const line of lines) {
      if (acc + line.length + 1 > budget) break;
      kept.push(line);
      acc += line.length + 1;
    }
    const hidden = lines.length - kept.length;
    const note =
      'note: truncated. ' + hidden + ' more node' + (hidden === 1 ? '' : 's') + ' not shown, ' +
      lines.length + ' in total (' + full.length + ' chars). ' +
      'Narrow with ref_id, filter or depth, or raise max_chars.';
    const withNote = kept.concat(note);
    return {
      text: withNote.join('\n'),
      totalChars: full.length,
      truncated: true,
      nodes: lines.length,
      shownNodes: kept.length,
      hiddenNodes: hidden,
    };
  }

  // ---------------------------------------------------------------------------
  // Page text
  // ---------------------------------------------------------------------------

  /**
   * Names the container a walk was run against, for the diagnostic report.
   */
  function describeContainer(el) {
    if (!el) return 'none';
    if (el === document.body) return 'body';
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute && el.getAttribute('role');
    if (role) return tag + '[role=' + role + ']';
    return tag;
  }

  /**
   * Reads the page's prose.
   *
   * The container chain (article, then main, then role=main, then body) picks
   * the wrong element often enough to matter: a feed page's first `article` is
   * frequently an empty or hidden slot, and a virtualized editor puts its text
   * under a `content-visibility` ancestor that the visibility filter rejects
   * wholesale. Either one returns zero characters with nothing to say why.
   *
   * So the walk is run up to three times: the chosen container with the
   * visibility filter on, then `document.body` with it on, then `document.body`
   * with it relaxed to the checks that cannot be wrong (the hidden attribute,
   * aria-hidden, display none, visibility hidden). The counts from every pass
   * are reported, so an empty result says which filter emptied it.
   */
  function pageText(maxChars = 50000) {
    const chosen =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;
    if (!chosen) {
      return {
        text: '',
        totalChars: 0,
        truncated: false,
        container: 'none',
        textNodes: 0,
        rejectedHidden: 0,
        rejectedEmpty: 0,
      };
    }

    const attempts = [{ container: chosen, strict: true }];
    if (chosen !== document.body && document.body) attempts.push({ container: document.body, strict: true });
    attempts.push({ container: chosen, strict: false });
    if (chosen !== document.body && document.body) attempts.push({ container: document.body, strict: false });

    let last = null;
    for (const attempt of attempts) {
      const result = collectText(attempt.container, maxChars, attempt.strict);
      last = {
        ...result,
        container: describeContainer(attempt.container) + (attempt.strict ? '' : ' (visibility filter relaxed)'),
        fallback: attempt !== attempts[0],
      };
      if (result.text.length) return last;
    }
    return last;
  }

  function collectText(article, maxChars, strict) {
    let rejectedHidden = 0;
    let rejectedEmpty = 0;
    let rejectedChrome = 0;
    let textNodes = 0;

    // Navigation, headers, footers and side panels inside the chosen container
    // are page chrome rather than content. They are kept only when the
    // container itself is one of them, which happens on pages that are nothing
    // but a menu.
    // A header or footer counts as chrome only at page level. Inside an
    // article or section it is the piece's own title block.
    const CHROME = 'nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="menu"],[role="menubar"]';
    const isChrome = (el) =>
      el.matches(CHROME) ||
      ((el.tagName === 'HEADER' || el.tagName === 'FOOTER') && !el.parentElement.closest('article,section,main,[role="main"]'));
    const containerIsChrome = article !== document.body && isChrome(article);

    // Hidden ancestors are what getComputedStyle on the parent misses: a text
    // node inside a collapsed panel has a parent whose own display is block.
    const hiddenCache = new Map();
    function hiddenByAncestor(el) {
      if (hiddenCache.has(el)) return hiddenCache.get(el);
      let result = false;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') result = true;
      // checkVisibility reports false for a subtree Chrome is skipping under
      // content-visibility, which is how a virtualized editor's own prose gets
      // rejected. The relaxed pass drops it and keeps the checks that cannot be
      // wrong about whether text is on the page.
      else if (strict && typeof el.checkVisibility === 'function') {
        result = !el.checkVisibility({ visibilityProperty: true });
      } else {
        const style = getComputedStyle(el);
        result = !style || style.display === 'none' || style.visibility === 'hidden';
      }
      if (!result && el.parentElement && el !== article) result = hiddenByAncestor(el.parentElement);
      hiddenCache.set(el, result);
      return result;
    }

    const acceptNode = (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName) || parent.tagName === 'OPTION') return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) {
        rejectedEmpty++;
        return NodeFilter.FILTER_REJECT;
      }
      if (hiddenByAncestor(parent)) {
        rejectedHidden++;
        return NodeFilter.FILTER_REJECT;
      }
      if (!containerIsChrome) {
        let region = parent.closest(CHROME + ',header,footer');
        while (region && region !== article && article.contains(region) && !isChrome(region)) {
          region = region.parentElement && region.parentElement.closest(CHROME + ',header,footer');
        }
        if (region && region !== article && article.contains(region)) {
          rejectedChrome++;
          return NodeFilter.FILTER_REJECT;
        }
      }
      textNodes++;
      return NodeFilter.FILTER_ACCEPT;
    };

    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, { acceptNode });

    // Same-origin frames hold content of their own. A page built from a
    // frameset has no text at all outside them.
    const roots = [article];
    const collectFrames = (scope, depth) => {
      if (depth > 5) return;
      for (const frameEl of scope.querySelectorAll('iframe,frame')) {
        try {
          const doc = frameEl.contentDocument;
          if (doc && doc.body) {
            roots.push(doc.body);
            collectFrames(doc.body, depth + 1);
          }
        } catch {
          /* cross-origin */
        }
      }
    };
    collectFrames(article, 0);

    const chunks = [];
    let total = 0;
    let node;
    const BLOCK = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'TR', 'BLOCKQUOTE', 'PRE', 'BR', 'TD', 'TH',
    ]);
    let lastBlock = null;
    let lastParent = null;
    let collected = 0;
    const walkers = roots.map((r) => (r === article ? walker : document.createTreeWalker(r, NodeFilter.SHOW_TEXT, { acceptNode })));
    let walkerIndex = 0;
    const nextText = () => {
      while (walkerIndex < walkers.length) {
        const n = walkers[walkerIndex].nextNode();
        if (n) return n;
        walkerIndex++;
        if (chunks.length) chunks.push('\n');
      }
      return null;
    };
    while ((node = nextText())) {
      const parent = node.parentElement;
      const block = parent.closest(
        'p,div,section,article,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre,td,th,label,select,button,summary,dt,dd,figcaption'
      );
      // A select reads as its chosen option rather than every option run together.
      if (parent.tagName === 'SELECT') continue;
      if (block !== lastBlock && chunks.length) chunks.push('\n');
      else if (chunks.length && parent !== lastParent) {
        // "focus" and "distraction" in adjacent <a> tags are two words, not
        // one. A boundary between elements gets a space unless one is there.
        const prev = chunks[chunks.length - 1];
        const t0 = node.nodeValue;
        if (prev && !/\s$/.test(prev) && !/^\s/.test(t0) && !/^[.,;:!?)\]]/.test(t0) && !/[(\[]$/.test(prev)) chunks.push(' ');
      }
      lastBlock = block;
      lastParent = parent;
      const t = node.nodeValue.replace(/\s+/g, ' ');
      total += t.length;
      // Past twice the budget the text is only counted, so the reported total
      // is the size of the whole page rather than of what was collected.
      const room = maxChars * 2 - collected;
      if (room > 0) {
        chunks.push(t.length > room ? t.slice(0, room) : t);
        collected += Math.min(t.length, room);
      }
    }
    const full = chunks
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const counts = { textNodes, rejectedHidden, rejectedEmpty, rejectedChrome };
    if (full.length <= maxChars && total <= maxChars * 2) {
      return { text: full, totalChars: full.length, truncated: false, ...counts };
    }
    return {
      text: full.slice(0, maxChars),
      totalChars: Math.max(full.length, total),
      truncated: true,
      ...counts,
    };
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return Boolean(el.closest && el.closest('fieldset[disabled]'));
  }

  /**
   * Names whatever sits on top of an element's centre point.
   *
   * A click is dispatched at a coordinate, so if a banner or modal covers the
   * target the browser delivers the click to the banner. Reporting success in
   * that case is worse than failing: the caller believes it pressed one thing
   * and pressed another.
   */
  function describeOccluder(el) {
    try {
      const box = hitBoxFor(el);
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return null;
      const doc = el.ownerDocument || document;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > (doc.documentElement.clientWidth || 0) || y > (doc.documentElement.clientHeight || 0)) {
        return null;
      }
      // Hit test inside the element's own root. document.elementFromPoint
      // retargets a shadow descendant to its host, which would report every
      // element inside a shadow root as covered by its own host.
      const root = el.getRootNode();
      const hit = (root.elementFromPoint ? root : doc).elementFromPoint(x, y);
      if (!hit || hit === el || hit === box) return null;

      // A descendant or an ancestor at the same point is the same target as far
      // as the click is concerned, and so is the label standing in for a hidden
      // control.
      if (el.contains(hit) || hit.contains(el)) return null;
      if (box !== el && (box.contains(hit) || hit.contains(box))) return null;

      // So is a shadow host whose tree the element lives in.
      for (let host = el.getRootNode().host; host; host = host.getRootNode && host.getRootNode().host) {
        if (hit === host || hit.contains(host)) return null;
      }
      if (hit.shadowRoot && hit.shadowRoot.contains(el)) return null;
      const role = roleOf(hit);
      const name = accessibleName(hit, role, true);
      return (name ? role + ' "' + name + '"' : role + ' <' + hit.tagName.toLowerCase() + '>');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Input verification (C3)
  // ---------------------------------------------------------------------------
  //
  // An input that reports success and changed nothing is the worst result a
  // browser tool can return, because the caller acts on it. Every mutating
  // action arms this before dispatching and reads it after, so the result can
  // say what the page did rather than what the extension sent.

  /**
   * The nearest ancestor that can actually scroll, which is not always the one
   * the wheel event reaches. An `overflow:hidden` body with an inner scroll
   * container is the common shape, and a CDP wheel event on it moves nothing.
   */
  function scrollableAncestor(el) {
    for (let node = el; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const style = getComputedStyle(node);
      if (!style) continue;
      const scrollsY =
        /^(auto|scroll|overlay)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const scrollsX =
        /^(auto|scroll|overlay)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (scrollsY || scrollsX) return node;
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  function elementAt(x, y) {
    try {
      return document.elementFromPoint(x, y) || document.body || document.documentElement;
    } catch {
      return document.body || document.documentElement;
    }
  }

  function scrollOffsets(x, y) {
    const page = {
      x: Math.round(window.pageXOffset || 0),
      y: Math.round(window.pageYOffset || 0),
    };
    let container = null;
    if (typeof x === 'number' && typeof y === 'number') {
      const target = scrollableAncestor(elementAt(x, y));
      if (target) {
        container = {
          tag: target.tagName ? target.tagName.toLowerCase() : 'unknown',
          x: Math.round(target.scrollLeft || 0),
          y: Math.round(target.scrollTop || 0),
          isRoot: target === (document.scrollingElement || document.documentElement),
        };
      }
    }
    return { page, container };
  }

  /**
   * Reads the focused control without echoing anything sensitive. A password
   * field reports the length of its value, which is enough to see that a type
   * landed and never enough to reconstruct it.
   */
  /**
   * The value of one element, redacted when the field is sensitive.
   *
   * Returns null for anything that does not hold text, so a button is not
   * treated as a control with an empty value.
   */
  function fieldValue(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    let value = null;
    if (isEditableHost(el)) value = String(el.textContent || '');
    else if (isTextControl(el)) value = el.value;
    if (value === null) return null;
    return isSensitiveField(el) ? 'len:' + value.length : value;
  }

  /** A control whose value moves when a person types into it. */
  function isTextControl(el) {
    if (!el || !('value' in el) || typeof el.value !== 'string') return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    // A button, submit, checkbox or radio carries a value attribute that has
    // nothing to do with what the user typed. Counting it made every click that
    // moved focus onto one report a value change.
    return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(
      String(el.type || 'text').toLowerCase()
    );
  }

  function focusSnapshot() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { present: false, value: null, sensitive: false };
    }
    const sensitive = isSensitiveField(el);
    const value = fieldValue(el);
    return {
      present: true,
      ref: elementToRef.get(el) || null,
      tag: el.tagName,
      name: accessibleName(el, roleOf(el), true),
      sensitive,
      // fieldValue already replaced a sensitive value with its length, so the
      // comparison value never leaves this function unredacted.
      value,
    };
  }

  let watch = null;

  /**
   * The pointer overlay is drawn on every click, which would otherwise make
   * every click report a DOM mutation and no action could ever be reported as
   * having changed nothing. Its records are dropped.
   */
  function isOwnRecord(record) {
    if (!cursorRoot) return false;
    if (record.target === cursorRoot) return true;
    if (cursorRoot.contains && cursorRoot.contains(record.target)) return true;
    for (const node of record.addedNodes || []) if (node === cursorRoot) return true;
    for (const node of record.removedNodes || []) if (node === cursorRoot) return true;
    return false;
  }

  function countRecords(records) {
    let n = 0;
    for (const record of records) if (!isOwnRecord(record)) n++;
    return n;
  }

  function armWatch(point, ref) {
    if (watch && watch.observer) watch.observer.disconnect();
    // The element whose value is worth watching. A tool that names the element
    // it is about to write to gives it here, because a value set through the
    // page's own setter never moves focus, and the focused element at arm time
    // is then the body.
    const named = ref ? resolveRef(ref) : null;
    const state = {
      mutations: 0,
      observer: null,
      // The element itself, so two identical unnamed inputs are still two
      // different focus targets. It is never serialized.
      focusEl: document.activeElement,
      focus: focusSnapshot(),
      valueEl: named || document.activeElement,
      valueBefore: fieldValue(named || document.activeElement),
      scroll: scrollOffsets(point && point.x, point && point.y),
      point: point || null,
      url: location.href,
      armedAt: Date.now(),
    };
    state.observer = new MutationObserver((records) => {
      state.mutations += countRecords(records);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    watch = state;
    return {
      ok: true,
      armed: true,
      focus: { present: state.focus.present, ref: state.focus.ref, name: state.focus.name },
      scroll: state.scroll,
    };
  }

  function readWatch() {
    if (!watch) return { ok: false, error: 'no verification window is armed' };
    const state = watch;
    state.mutations += countRecords(state.observer.takeRecords());
    state.observer.disconnect();
    watch = null;

    const after = {
      focus: focusSnapshot(),
      scroll: scrollOffsets(state.point && state.point.x, state.point && state.point.y),
      url: location.href,
    };

    // Focus landing on a real element proves an input reached something.
    // Focus falling back to <body> is what a click on an inert element does, so
    // it is reported through focusedAfter and does not count as an effect.
    const focusMoved = state.focusEl !== document.activeElement;
    const focusChanged = focusMoved && after.focus.present;

    // The value of the element the watch was armed on, read again now.
    // Comparing against whatever holds focus at the end reported a value change
    // on every click that moved focus between two controls.
    const valueChanged = state.valueBefore !== fieldValue(state.valueEl);

    const scrollDelta = {
      pageX: after.scroll.page.x - state.scroll.page.x,
      pageY: after.scroll.page.y - state.scroll.page.y,
      containerX:
        after.scroll.container && state.scroll.container
          ? after.scroll.container.x - state.scroll.container.x
          : 0,
      containerY:
        after.scroll.container && state.scroll.container
          ? after.scroll.container.y - state.scroll.container.y
          : 0,
    };
    const scrolled =
      Math.abs(scrollDelta.pageX) >= 1 ||
      Math.abs(scrollDelta.pageY) >= 1 ||
      Math.abs(scrollDelta.containerX) >= 1 ||
      Math.abs(scrollDelta.containerY) >= 1;

    const urlChanged = state.url !== after.url;

    return {
      ok: true,
      mutations: state.mutations,
      focusChanged,
      focusBlurred: focusMoved && !after.focus.present,
      focusedBefore: state.focus.present ? state.focus.name || state.focus.tag : null,
      focusedAfter: after.focus.present ? after.focus.name || after.focus.tag : null,
      valueChanged,
      // Whether there was a value to watch at all. A type dispatched with no
      // text control focused cannot be judged by whether a value moved.
      valueTracked: state.valueBefore !== null,
      valueSensitive: Boolean(state.focus.sensitive || after.focus.sensitive),
      scroll: { before: state.scroll, after: after.scroll, delta: scrollDelta },
      scrolled,
      urlChanged,
      url: after.url,
      windowMs: Date.now() - state.armedAt,
      changed: state.mutations > 0 || focusChanged || valueChanged || scrolled || urlChanged,
    };
  }

  /** Scrolls the nearest scrollable ancestor of a point, for when a wheel event did nothing. */
  function scrollByFallback({ x, y, direction = 'down', amount = 3 }) {
    const distance = Math.max(1, Number(amount) || 3) * 100;
    const deltas = {
      down: [0, distance],
      up: [0, -distance],
      right: [distance, 0],
      left: [-distance, 0],
    };
    const [dx, dy] = deltas[direction] || deltas.down;
    const target = scrollableAncestor(elementAt(x, y));
    const before = scrollOffsets(x, y);
    const root = document.scrollingElement || document.documentElement;
    if (target === root) window.scrollBy(dx, dy);
    else if (typeof target.scrollBy === 'function') target.scrollBy(dx, dy);
    else {
      target.scrollLeft += dx;
      target.scrollTop += dy;
    }
    const after = scrollOffsets(x, y);
    return {
      ok: true,
      target: target && target.tagName ? target.tagName.toLowerCase() : 'unknown',
      isRoot: target === root,
      before,
      after,
      delta: {
        pageX: after.page.x - before.page.x,
        pageY: after.page.y - before.page.y,
        containerX: after.container && before.container ? after.container.x - before.container.x : 0,
        containerY: after.container && before.container ? after.container.y - before.container.y : 0,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Form input
  // ---------------------------------------------------------------------------

  function setFormValue(ref, value) {
    const el = resolveRef(ref);
    if (!el) return { error: 'ref ' + ref + ' is no longer on the page. Re-read the page.' };

    const tag = el.tagName;
    const type = tag === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null;

    // A person cannot type into these, so neither should the agent. Writing the
    // value anyway produces state the page never agreed to and will not submit.
    if (isDisabled(el)) {
      return { error: 'element ' + ref + ' is disabled, so its value cannot be set', code: 'element_disabled' };
    }
    if (el.readOnly && tag !== 'SELECT') {
      return { error: 'element ' + ref + ' is read-only, so its value cannot be set', code: 'element_readonly' };
    }

    scrollIntoView(el);

    if (type === 'checkbox' || type === 'radio') {
      const want = value === true || value === 'true' || value === 1 || value === '1';
      if (el.checked !== want) el.click();
      return { ok: true, checked: el.checked };
    }

    if (tag === 'SELECT') {
      const wanted = String(value);
      let matched = null;
      for (const opt of el.options) {
        if (opt.value === wanted || (opt.textContent || '').trim() === wanted) {
          matched = opt;
          break;
        }
      }
      if (!matched) {
        for (const opt of el.options) {
          if ((opt.textContent || '').trim().toLowerCase() === wanted.toLowerCase()) {
            matched = opt;
            break;
          }
        }
      }
      if (!matched) {
        const available = Array.from(el.options)
          .slice(0, 30)
          .map((o) => (o.textContent || '').trim())
          .filter(Boolean);
        return { error: 'no option matching ' + JSON.stringify(wanted), available };
      }
      el.value = matched.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (isSensitiveField(el)) return { ok: true, selected: '[redacted]', sensitive: true };
      return { ok: true, selected: (matched.textContent || '').trim() };
    }

    if (isEditableHost(el)) {
      el.focus();
      el.textContent = String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return { ok: true };
    }

    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // Native setter bypasses React's value tracker, which otherwise swallows
      // the change because it believes the value never moved.
      const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      el.focus();
      if (setter && setter.set) setter.set.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // The value of a password, one-time code or card field is never echoed
      // back, so it cannot reach a transcript or the host's journal.
      if (isSensitiveField(el)) return { ok: true, value: '[redacted]', sensitive: true };
      return { ok: true, value: el.value };
    }

    return { error: 'element ' + ref + ' (' + tag + ') is not a form control', code: 'not_a_form_control' };
  }

  // ---------------------------------------------------------------------------
  // Visible cursor
  // ---------------------------------------------------------------------------
  //
  // A marker showing where the agent is pointing, so a person watching the tab
  // can follow what it is doing. It is presentation only: input is dispatched
  // through CDP and is identical whether or not this is drawn.
  //
  // It lives in a closed shadow root so page CSS cannot restyle it, carries
  // pointer-events none so it can never absorb a click meant for the page, and
  // is hidden before any screenshot so the model never sees its own cursor and
  // mistakes it for page content.

  const CURSOR_HOST_ID = '__chrome_mcp_cursor__';
  let cursorRoot = null;
  let cursorEl = null;
  let cursorEnabled = true;
  let cursorAt = null;

  // Classic arrow, drawn so the point of the arrow sits exactly on 0,0 of the
  // element. That makes the hotspot the coordinate the event is dispatched at,
  // the same relationship a real pointer has.
  const ARROW =
    '<svg class="a" width="20" height="28" viewBox="0 0 20 28" fill="none">' +
    '<path d="M1 1 L1 20.5 L6.1 15.6 L9.3 22.9 L12.6 21.5 L9.4 14.3 L16.5 14.1 Z" ' +
    'fill="#ffffff" stroke="#1f2126" stroke-width="1.4" stroke-linejoin="round"/>' +
    '</svg>';

  function cursorLayer() {
    if (cursorRoot && cursorRoot.isConnected) return cursorEl;
    if (!document.documentElement) return null;

    const host = document.createElement('div');
    host.id = CURSOR_HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' +
      // translate3d keeps the movement on the compositor, so it stays smooth
      // even while the page's main thread is busy handling the events.
      '.c{position:fixed;left:0;top:0;pointer-events:none;opacity:0;' +
      'transform:translate3d(0,0,0);' +
      'transition:transform .13s cubic-bezier(.22,.61,.36,1), opacity .12s linear;' +
      'will-change:transform;}' +
      '.c.on{opacity:1}' +
      // A warm halo sits behind the arrow so the pointer is findable on a busy
      // page without hiding what is under it. It breathes slowly while idle and
      // flares on a press.
      '.g{position:absolute;left:0;top:0;width:48px;height:48px;margin:-24px 0 0 -24px;' +
      'border-radius:50%;pointer-events:none;' +
      'background:radial-gradient(circle,rgba(217,119,87,0) 18%,rgba(217,119,87,.30) 42%,rgba(217,119,87,.16) 58%,rgba(217,119,87,0) 74%);' +
      'animation:breathe 2.4s ease-in-out infinite;}' +
      '@keyframes breathe{0%,100%{transform:scale(.86);opacity:.75}50%{transform:scale(1.06);opacity:1}}' +
      '.c.press .g{animation:none;transform:scale(1.25);opacity:1}' +
      '.a{display:block;position:relative;' +
      'filter:drop-shadow(0 0 4px rgba(217,119,87,1)) drop-shadow(0 1px 2px rgba(0,0,0,.45));' +
      'transform-origin:1px 1px;transition:transform .09s ease-out}' +
      '.c.press .a{transform:scale(.82)}' +
      // The ripple is centred on the arrow tip.
      '.p{position:absolute;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;' +
      'border-radius:50%;border:2px solid rgba(217,119,87,.95);opacity:0;pointer-events:none}' +
      '.p.go{animation:r .45s ease-out}' +
      '@keyframes r{from{transform:scale(.35);opacity:.95}to{transform:scale(1.9);opacity:0}}' +
      '</style>' +
      '<div class="c"><div class="g"></div><div class="p"></div>' + ARROW + '</div>';

    document.documentElement.appendChild(host);
    cursorRoot = host;
    cursorEl = shadow.querySelector('.c');
    return cursorEl;
  }

  function moveCursor(x, y, { instant = false } = {}) {
    if (!cursorEnabled) return;
    const el = cursorLayer();
    if (!el) return;

    // A first appearance should not glide in from the origin.
    const jumped = instant || !cursorAt;
    el.style.transition = jumped ? 'opacity .12s linear' : '';
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    if (jumped) {
      // Restore the eased transition once the jump has been applied.
      void el.offsetWidth;
      el.style.transition = '';
    }
    el.classList.add('on');
    cursorAt = { x, y };
  }

  function pressCursor(down) {
    if (!cursorEnabled) return;
    const el = cursorLayer();
    if (!el) return;
    el.classList.toggle('press', Boolean(down));
  }

  function pulseCursor() {
    if (!cursorEnabled) return;
    const el = cursorLayer();
    if (!el) return;
    const ping = el.querySelector('.p');
    ping.classList.remove('go');
    // Reading offsetWidth restarts the animation rather than skipping it.
    void ping.offsetWidth;
    ping.classList.add('go');
  }

  function setCursorVisible(visible) {
    if (!cursorRoot) return;
    // Explicit rather than empty: the host declares all:initial, so clearing the
    // property would leave display resolving to initial instead of a known value.
    cursorRoot.style.display = visible ? 'block' : 'none';
  }

  // ---------------------------------------------------------------------------
  // Message plumbing
  // ---------------------------------------------------------------------------

  const handlers = {
    PING: () => ({ ok: true, url: location.href, readyState: document.readyState }),

    READ_PAGE: (msg) => renderTree(msg),

    GET_PAGE_TEXT: (msg) => pageText(msg.maxChars || 50000),

    RESOLVE_REF: (msg) => {
      const el = resolveRef(msg.ref);
      if (!el) {
        return { error: 'ref ' + msg.ref + ' is no longer on the page. Re-read the page.', code: 'ref_stale' };
      }
      if (msg.paymentCategory !== undefined) paymentCategoryPage = Boolean(msg.paymentCategory);
      const role = roleOf(el);
      const name = accessibleName(el, role, true);
      return {
        ok: true,
        geometry: geometryOf(el),
        tag: el.tagName,
        role,
        name,
        disabled: isDisabled(el),
        occludedBy: describeOccluder(el),
        contentEditable: isEditableHost(el),
        sensitive: isSensitiveField(el),
        irreversible: isIrreversibleControl(el, role, name),
      };
    },

    SCROLL_TO: (msg) => {
      const el = resolveRef(msg.ref);
      if (!el) {
        return { error: 'ref ' + msg.ref + ' is no longer on the page. Re-read the page.', code: 'ref_stale' };
      }
      scrollIntoView(el);
      return { ok: true, geometry: geometryOf(el) };
    },

    FORM_INPUT: (msg) => setFormValue(msg.ref, msg.value),

    // --- verification (C3) ----------------------------------------------------

    VERIFY_ARM: (msg) => armWatch(msg.point, msg.ref),

    VERIFY_REPORT: async (msg) => {
      const wait = Math.max(0, Math.min(5000, msg.window ?? 250));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      return readWatch();
    },

    /** Offsets before and after a scroll, so a wheel event that moved nothing is visible. */
    SCROLL_OFFSETS: (msg) => ({ ok: true, ...scrollOffsets(msg.x, msg.y) }),

    SCROLL_BY: (msg) => scrollByFallback(msg),

    /**
     * The focused control's value, for verifying that a type landed. A sensitive
     * field reports its length instead of its value.
     */
    FOCUSED_FIELD: () => ({ ok: true, ...focusSnapshot() }),

    /** Text of an element addressed by ref, for verifying an editor write. */
    REF_TEXT: (msg) => {
      const el = resolveRef(msg.ref);
      if (!el) {
        return { error: 'ref ' + msg.ref + ' is no longer on the page. Re-read the page.', code: 'ref_stale' };
      }
      const sensitive = isSensitiveField(el);
      const raw = isEditableHost(el)
        ? String(el.textContent || '')
        : 'value' in el && typeof el.value === 'string'
          ? el.value
          : String(el.textContent || '');
      return {
        ok: true,
        sensitive,
        length: raw.length,
        text: sensitive ? '[redacted]' : raw.slice(0, 2000),
      };
    },

    CURSOR: (msg) => {
      if (msg.enabled === false) {
        cursorEnabled = false;
        setCursorVisible(false);
        return { ok: true, enabled: false };
      }
      cursorEnabled = true;
      if (msg.x !== undefined) moveCursor(msg.x, msg.y, { instant: msg.instant });
      if (msg.press !== undefined) pressCursor(msg.press);
      if (msg.pulse) pulseCursor();
      return { ok: true, enabled: true, at: cursorAt };
    },

    // Mirrors the hide/show the extension does around its own overlay, so the
    // cursor never lands in a screenshot the model reads.
    HIDE_FOR_TOOL_USE: () => {
      setCursorVisible(false);
      return { ok: true };
    },

    SHOW_AFTER_TOOL_USE: () => {
      setCursorVisible(true);
      return { ok: true };
    },

    /**
     * Tags an element so CDP can find it by selector. The ref map lives in this
     * isolated world, and CDP addresses nodes from its own tree, so a marker
     * attribute is the bridge between the two.
     */
    MARK_ELEMENT: (msg) => {
      const el = resolveRef(msg.ref);
      if (!el) return { error: 'ref ' + msg.ref + ' is no longer on the page. Re-read the page.' };
      el.setAttribute('data-chrome-mcp-mark', msg.token);
      scrollIntoView(el);
      const isFileInput = el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file';
      return {
        ok: true,
        selector: '[data-chrome-mcp-mark="' + msg.token + '"]',
        isFileInput,
        multiple: isFileInput ? el.multiple : false,
        tag: el.tagName,
        geometry: geometryOf(el),
      };
    },

    UNMARK_ELEMENT: (msg) => {
      const el = document.querySelector('[data-chrome-mcp-mark="' + msg.token + '"]');
      if (el) el.removeAttribute('data-chrome-mcp-mark');
      return { ok: true };
    },

    FIND_TREE: (msg) =>
      renderTree({
        filter: msg.filter || 'interactive',
        depth: msg.depth || 25,
        maxChars: msg.maxChars || 40000,
        paymentCategory: msg.paymentCategory,
      }),

    PAGE_STATE: () => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // The window's outer size is what a resize request is measured against.
      // Reporting only the layout viewport made a working resize read as a
      // no-op, since device pixel ratio and browser chrome sit between them.
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }),

    /**
     * Waits for a paint that postdates the last input, so a screenshot taken in
     * the same batch as a click cannot render the pre-click frame.
     *
     * Two animation frames: the first is the one already scheduled when the
     * call arrives, the second is the one that follows the commit. A hidden tab
     * runs neither, so it resolves on the ceiling and the caller falls back to a
     * screencast frame.
     */
    AWAIT_PAINT: (msg) =>
      new Promise((resolve) => {
        const ceiling = Math.max(0, Math.min(2000, msg.ceiling ?? 300));
        const started = Date.now();
        let settled = false;
        const done = (painted) => {
          if (settled) return;
          settled = true;
          resolve({ ok: true, painted, waitedMs: Date.now() - started });
        };
        setTimeout(() => done(false), ceiling);
        if (typeof requestAnimationFrame !== 'function') return done(false);
        requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
      }),

    WAIT_SETTLE: async (msg) => {
      const timeout = msg.timeout || 5000;
      const start = Date.now();

      if (document.readyState !== 'complete') {
        await new Promise((resolve) => {
          const done = () => resolve();
          if (document.readyState === 'complete') return done();
          window.addEventListener('load', done, { once: true });
          setTimeout(done, timeout);
        });
      }

      // Settle once the DOM has been quiet for two consecutive checks.
      //
      // requestAnimationFrame stops firing entirely while a tab is hidden or its
      // window is occluded, so an rAF-driven loop here never resolves and the
      // caller waits for its own timeout instead. setTimeout keeps running, so
      // the quiet check and the deadline both run on timers.
      await new Promise((resolve) => {
        let mutated = false;
        const observer = new MutationObserver(() => {
          mutated = true;
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        let quiet = 0;
        const deadline = setTimeout(finish, Math.max(0, timeout - (Date.now() - start)));
        const interval = setInterval(() => {
          if (mutated) {
            mutated = false;
            quiet = 0;
            return;
          }
          if (++quiet >= 2) finish();
        }, 60);

        function finish() {
          clearTimeout(deadline);
          clearInterval(interval);
          observer.disconnect();
          resolve();
        }
      });

      return { ok: true, readyState: document.readyState, waitedMs: Date.now() - start };
    },
  };

  // The classifiers, reachable from the isolated world so tests and any future
  // module read the same list rather than keeping a second copy. Nothing here
  // is visible to the page: content scripts run in their own world.
  globalThis.__chromeMcpAgent = {
    IRREVERSIBLE_WORDS,
    SENSITIVE_AUTOCOMPLETE,
    isSensitiveField,
    isIrreversibleControl,
    scrollableAncestor,
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg && msg.type];
    if (!handler) return false;
    try {
      const result = handler(msg);
      if (result && typeof result.then === 'function') {
        result.then(sendResponse, (err) => sendResponse({ error: String(err && err.message || err) }));
        return true;
      }
      sendResponse(result);
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
    return false;
  });
})();
