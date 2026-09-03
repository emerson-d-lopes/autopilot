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

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    const fn = TAG_ROLES[tag];
    if (fn) return fn(el);
    if (el.hasAttribute && el.hasAttribute('contenteditable')) {
      const v = el.getAttribute('contenteditable');
      if (v === '' || v === 'true') return 'textbox';
    }
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

    if (el.tagName === 'A') push('href', el.getAttribute('href'));
    if (el.tagName === 'INPUT') {
      push('type', (el.getAttribute('type') || 'text').toLowerCase());
      if (el.value && el.type !== 'password') push('value', el.value);
      if (el.checked) push('checked', 'true');
    }
    if (el.tagName === 'TEXTAREA' && el.value) push('value', el.value.slice(0, 120));
    if (el.tagName === 'SELECT') {
      const sel = el.selectedOptions && el.selectedOptions[0];
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
    if (el.hasAttribute && el.hasAttribute('contenteditable')) {
      const v = el.getAttribute('contenteditable');
      if (v === '' || v === 'true') return true;
    }
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
    } = options || {};

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
    let acc = 0;
    const kept = [];
    for (const line of lines) {
      if (acc + line.length + 1 > maxChars) break;
      kept.push(line);
      acc += line.length + 1;
    }
    return {
      text: kept.join('\n'),
      totalChars: full.length,
      truncated: true,
      nodes: lines.length,
      shownNodes: kept.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Page text
  // ---------------------------------------------------------------------------

  function pageText(maxChars = 50000) {
    const article =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;
    if (!article) return { text: '', totalChars: 0, truncated: false };

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
      else if (typeof el.checkVisibility === 'function') result = !el.checkVisibility({ visibilityProperty: true });
      else {
        const style = getComputedStyle(el);
        result = !style || style.display === 'none' || style.visibility === 'hidden';
      }
      if (!result && el.parentElement && el !== article) result = hiddenByAncestor(el.parentElement);
      hiddenCache.set(el, result);
      return result;
    }

    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName) || parent.tagName === 'OPTION') return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (hiddenByAncestor(parent)) return NodeFilter.FILTER_REJECT;
        if (!containerIsChrome) {
          let region = parent.closest(CHROME + ',header,footer');
          while (region && region !== article && article.contains(region) && !isChrome(region)) {
            region = region.parentElement && region.parentElement.closest(CHROME + ',header,footer');
          }
          if (region && region !== article && article.contains(region)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

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
    const walkers = roots.map((r) => (r === article ? walker : document.createTreeWalker(r, NodeFilter.SHOW_TEXT, { acceptNode: walker.filter.acceptNode })));
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
    if (full.length <= maxChars && total <= maxChars * 2) {
      return { text: full, totalChars: full.length, truncated: false };
    }
    return { text: full.slice(0, maxChars), totalChars: Math.max(full.length, total), truncated: true };
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
      return { error: 'element ' + ref + ' is disabled, so its value cannot be set' };
    }
    if (el.readOnly && tag !== 'SELECT') {
      return { error: 'element ' + ref + ' is read-only, so its value cannot be set' };
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
      return { ok: true, selected: (matched.textContent || '').trim() };
    }

    if (el.isContentEditable) {
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
      return { ok: true, value: el.value };
    }

    return { error: 'element ' + ref + ' (' + tag + ') is not a form control' };
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
      if (!el) return { error: 'ref ' + msg.ref + ' is no longer on the page. Re-read the page.' };
      return {
        ok: true,
        geometry: geometryOf(el),
        tag: el.tagName,
        role: roleOf(el),
        name: accessibleName(el, roleOf(el), true),
        disabled: isDisabled(el),
        occludedBy: describeOccluder(el),
      };
    },

    SCROLL_TO: (msg) => {
      const el = resolveRef(msg.ref);
      if (!el) return { error: 'ref ' + msg.ref + ' is no longer on the page. Re-read the page.' };
      scrollIntoView(el);
      return { ok: true, geometry: geometryOf(el) };
    },

    FORM_INPUT: (msg) => setFormValue(msg.ref, msg.value),

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
      }),

    PAGE_STATE: () => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
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
