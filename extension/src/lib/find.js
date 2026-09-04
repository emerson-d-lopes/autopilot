// Natural-language element lookup.
//
// Claude in Chrome answers find() with a nested Sonnet call over the tree. That
// costs a second inference on every lookup. Scoring locally returns in under a
// millisecond, and for the queries find actually receives ("the login button",
// "search bar", "price of the second result") lexical scoring against role plus
// accessible name resolves the same element.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'on', 'in', 'at', 'with', 'that', 'this',
  'and', 'or', 'my', 'me', 'i', 'is', 'are', 'be', 'it', 'its', 'please', 'find',
  'click', 'get', 'element', 'containing', 'contains', 'named', 'called', 'labeled',
]);

/** Words in a query that imply a role rather than a name. */
const ROLE_HINTS = [
  { words: ['button', 'btn', 'submit'], roles: ['button'] },
  { words: ['link', 'anchor', 'href'], roles: ['link'] },
  { words: ['searchbar', 'search'], roles: ['searchbox', 'textbox'] },
  { words: ['field', 'input', 'textbox', 'textarea', 'box'], roles: ['textbox', 'searchbox', 'spinbutton'] },
  { words: ['checkbox', 'check'], roles: ['checkbox'] },
  { words: ['radio'], roles: ['radio'] },
  { words: ['dropdown', 'select', 'combobox', 'picker'], roles: ['combobox', 'listbox'] },
  { words: ['option', 'item'], roles: ['option', 'listitem', 'menuitem'] },
  { words: ['heading', 'header', 'title'], roles: ['heading'] },
  { words: ['image', 'img', 'picture', 'photo'], roles: ['img'] },
  { words: ['tab'], roles: ['tab'] },
  { words: ['menu', 'menuitem'], roles: ['menuitem'] },
  { words: ['toggle', 'switch'], roles: ['switch', 'checkbox'] },
  { words: ['slider'], roles: ['slider'] },
  { words: ['row'], roles: ['row'] },
  { words: ['cell'], roles: ['cell', 'gridcell'] },
  { words: ['form'], roles: ['form'] },
  { words: ['dialog', 'modal', 'popup'], roles: ['dialog'] },
];

// The optional [irreversible] mark sits between the name and the ref, which is
// where the tree writes it.
const LINE_RE =
  /^(\s*)([a-zA-Z][\w-]*)\s*(?:"((?:[^"\\]|\\.)*)")?\s*(\[irreversible\])?\s*\[(ref_\d+)\]\s*(\(offscreen\))?\s*(.*)$/;

/**
 * Best score below which `find` widens from the interactive filter to the whole
 * tree (P5). A page whose target is a table cell, a paragraph or a modal's
 * close text has no interactive node to match, and the interactive filter
 * reported two candidates on a page with more than nine thousand cells.
 */
export const WIDEN_BELOW_SCORE = 3;

/** Below this share of the page's nodes, a search says how little it covered. */
export const NARROW_SCOPE_RATIO = 0.1;

/**
 * Character budget for the tree `find` ranks over.
 *
 * Ranking and reporting have different budgets. A page of 3000 rows renders an
 * interactive tree past 200000 chars, which cut the tree at 4439 of 6000 nodes
 * and put the one node the query named outside the search. Scoring runs over
 * the whole tree instead, and the 20 candidates are what gets truncated. The
 * text never leaves the worker, so the cost is the parse, measured at a few
 * milliseconds for 9000 nodes by find.test.js.
 */
export const FIND_TREE_CHAR_BUDGET = 1000000;

/** Score added when the query quoted the element's label verbatim. */
export const EXACT_LABEL_BONUS = 10;

/** Score added when the whole multi-word name appears in the query as a run. */
export const EXACT_NAME_BONUS = 6;

/** Drops href and src values, whose long URLs produce spurious substring hits. */
export function stripUrlAttributes(attrs) {
  return String(attrs || '')
    .replace(/\b(?:href|src)=(?:"(?:[^"\\]|\\.)*"|\S*)/g, ' ')
    .trim();
}

export function parseTree(text) {
  const nodes = [];
  if (!text) return nodes;
  for (const line of text.split('\n')) {
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [, indent, role, rawName, irreversible, ref, offscreen, attrs] = match;
    let name = '';
    if (rawName !== undefined) {
      try {
        name = JSON.parse('"' + rawName + '"');
      } catch {
        name = rawName;
      }
    }
    const attrString = attrs ? attrs.trim() : '';
    nodes.push({
      ref,
      role,
      name,
      attrs: attrString,
      // URLs are excluded from matching. A query for "the search bar" otherwise
      // scores a Donate link whose href contains "wmf_medium=sidebar".
      matchableAttrs: stripUrlAttributes(attrString),
      offscreen: Boolean(offscreen),
      irreversible: Boolean(irreversible),
      depth: Math.floor(indent.length / 2),
      line: line.trim(),
    });
  }
  return nodes;
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

function contentTokens(tokens) {
  const filtered = tokens.filter((t) => !STOPWORDS.has(t));
  return filtered.length ? filtered : tokens;
}

/**
 * Role words that settle what a query is asking for, rather than only nudging
 * the ranking.
 *
 * On GitHub's new-issue page "issue title field" returned twenty markdown
 * toolbar buttons and "submit new issue button" returned no Create button at
 * all, while `textbox "Add a title"` and `button "Create ( )"` were both in the
 * tree. A word from this list is a filter: candidates carrying the role it
 * names are the ones ranked, and the rest are left out entirely as long as at
 * least one candidate has it. `title` and `search` stay out of the list, since
 * they are as often part of a label as a request for a role.
 */
const STRONG_ROLE_WORDS = new Set([
  'field', 'input', 'box', 'textbox', 'textarea', 'button', 'link',
  'checkbox', 'menu', 'dropdown', 'select', 'tab',
]);

/**
 * Words a query uses for the control that completes a form, and the words such
 * a control is labelled with. "submit new issue button" names GitHub's Create
 * button, which shares no word with the query at all. Deliberately narrow:
 * `add` and `continue` label half the toolbar on a page like that.
 */
const SUBMIT_INTENT_WORDS = new Set([
  'submit', 'send', 'post', 'save', 'create', 'publish', 'apply',
  'confirm', 'update', 'comment', 'done', 'ok', 'finish',
]);

/** Score for a control labelled as the one that completes what the query names. */
export const SUBMIT_INTENT_BONUS = 3.5;

/** Roles whose accessible name scopes the controls under it. */
const FORM_ROLES = new Set(['form', 'search']);

function roleHintsFor(tokens) {
  const roles = new Set();
  const strongRoles = new Set();
  const consumed = new Set();
  const strongWords = [];
  for (const hint of ROLE_HINTS) {
    for (const word of hint.words) {
      if (!tokens.includes(word)) continue;
      hint.roles.forEach((r) => roles.add(r));
      consumed.add(word);
      if (STRONG_ROLE_WORDS.has(word)) {
        hint.roles.forEach((r) => strongRoles.add(r));
        strongWords.push(word);
      }
    }
  }
  // A strong word decides the role, so the weak hints go back to the scorer as
  // ordinary terms. "issue title field" asks for a textbox, and `title` is then
  // part of the label rather than a request for a heading.
  if (strongRoles.size) {
    const kept = new Set();
    for (const word of consumed) if (STRONG_ROLE_WORDS.has(word)) kept.add(word);
    return { roles: strongRoles, strongRoles, consumed: kept, strongWords };
  }
  return { roles, strongRoles, consumed, strongWords };
}

/** The `type=` value the tree reported for a node, lowercased. */
function typeOf(node) {
  const match = /\btype=(\S+)/.exec(node.matchableAttrs || '');
  return match ? match[1].toLowerCase() : '';
}

/** Whether the query named this node's input type, which stands in for its role. */
function typeNamed(node, terms) {
  const type = typeOf(node);
  return Boolean(type) && terms.includes(type);
}

/**
 * The accessible name of the nearest enclosing form, by tree indentation.
 *
 * On a page whose controls share no word with the query, the form they sit in
 * often carries it: GitHub's Create button and its title textbox are both
 * inside the new-issue form, which is how "new" and "issue" reach them.
 */
function attachFormNames(nodes) {
  const stack = [];
  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
    node.formName = stack.length ? stack[stack.length - 1].name : '';
    if (FORM_ROLES.has(node.role) && node.name) stack.push({ depth: node.depth, name: node.name });
  }
  return nodes;
}

/**
 * Labels the query quoted. `the button labelled exactly "btn 2999"` names one
 * button out of 3000 that differ by a digit, and the quotes say which part of
 * the query is the label. Straight and curly double quotes only: an apostrophe
 * in ordinary prose would otherwise open a quoted run that never closes where
 * the writer meant it to.
 */
export function quotedLabels(query) {
  const out = [];
  const re = /"([^"]*)"|“([^”]*)”/g;
  let m;
  while ((m = re.exec(String(query || '')))) {
    const value = (m[1] !== undefined ? m[1] : m[2] || '').trim().toLowerCase();
    if (value) out.push(value);
  }
  return out;
}

/** Whether `needle` appears in `haystack` as a contiguous run, in order. */
function containsRun(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * How exactly the query names this element.
 *
 * Word-level scoring cannot separate "btn 2999" from "btn 0" by much, because
 * both share the word the role hint consumed, and on a table of "50.20" style
 * cells it cannot separate 50.20 from 20.50 at all. An exact hit is a different
 * kind of evidence, so it is scored separately and dominates.
 */
function exactnessBonus(name, nameWords, { queryTokens, exactLabels }) {
  const trimmed = name.trim();
  if (!trimmed) return 0;
  if (exactLabels.includes(trimmed)) return EXACT_LABEL_BONUS;
  // A one-word name is left to the ordinary word match. Boosting it as well put
  // the "Password" textbox above the "Forgot your password?" link, because a
  // single shared word is not evidence that the query named that element.
  if (nameWords.length < 2) return 0;
  if (nameWords.every((w) => STOPWORDS.has(w))) return 0;
  if (!containsRun(queryTokens, nameWords)) return 0;
  return EXACT_NAME_BONUS;
}

/**
 * Scores one node against the query terms.
 * Name matches dominate, role agreement breaks ties, and an offscreen element
 * loses to an equivalent visible one.
 */
function scoreNode(node, { phrase, terms, roles, consumed, queryTokens, exactLabels, submitIntent }) {
  const name = (node.name || '').toLowerCase();
  const attrWords = new Set(tokenize(node.matchableAttrs || ''));
  const nameWords = tokenize(name);
  // A placeholder is a label a person reads, so it scores above the rest of the
  // attribute text. The form name scores under both: it is shared by every
  // control inside it, so it separates the form from the page around it rather
  // than one control from another.
  const placeholderMatch = /\bplaceholder=(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(node.matchableAttrs || '');
  const placeholderWords = tokenize(placeholderMatch ? placeholderMatch[1] || placeholderMatch[2] : '');
  const formWords = tokenize(node.formName || '');
  let score = 0;

  // A query that names the control's type ("file input", "email field",
  // "password box") is about that type, and a file input is rendered as a
  // button, so the type has to be able to satisfy the role hint on its own.
  const typeHit = typeNamed(node, terms);
  if (typeHit) score += 3;

  if (name && name === phrase) score += 10;
  else if (name && name.includes(phrase) && phrase.length > 2) score += 5;

  const exact = exactnessBonus(name, nameWords, { queryTokens, exactLabels });
  score += exact;

  // The query asked for the control that completes the form and this one is
  // labelled as such. On GitHub's new-issue page that is the whole of what
  // separates Create from twenty markdown toolbar buttons in the same form.
  // A submit control is labelled with the action ("Create", "Post comment"),
  // so the word leading a short name is worth more than the same word buried
  // in a description of something else ("Add a comment").
  if (submitIntent && nameWords.length) {
    if (SUBMIT_INTENT_WORDS.has(nameWords[0]) && nameWords.length <= 3) score += SUBMIT_INTENT_BONUS;
    else if (nameWords.some((w) => SUBMIT_INTENT_WORDS.has(w))) score += SUBMIT_INTENT_BONUS / 2;
  }

  let matchedTerms = 0;
  let roleWordInName = false;
  for (const term of terms) {
    if (consumed.has(term) && terms.length > 1) {
      // A role word that is also the element's name ("Search" for "search
      // box") still identifies it, just less strongly than a distinct name.
      if (nameWords.includes(term)) {
        score += 1.5;
        roleWordInName = true;
      }
      continue;
    }
    let best = 0;
    for (const word of nameWords) {
      if (word === term) best = Math.max(best, 2.5);
      else if (word.startsWith(term) && term.length >= 3) best = Math.max(best, 1.6);
      else if (word.includes(term) && term.length >= 4) best = Math.max(best, 1.0);
    }
    if (best < 1.2) {
      for (const word of placeholderWords) {
        if (word === term) best = Math.max(best, 1.2);
        else if (word.startsWith(term) && term.length >= 3) best = Math.max(best, 0.9);
      }
    }
    if (best < 0.8 && formWords.includes(term)) best = 0.8;
    // Whole words only. Substring matching against attributes was the source of
    // matches that shared no meaning with the query.
    if (best === 0 && attrWords.has(term)) best = 0.7;
    if (best > 0) matchedTerms++;
    score += best;
  }

  const meaningful = terms.filter((t) => !consumed.has(t));
  if (meaningful.length && matchedTerms === 0 && roles.size === 0 && !exact) return 0;
  if (meaningful.length && matchedTerms === 0 && roles.size > 0) {
    // Role-only query such as "the submit button" with no distinguishing name.
    score += 0.2;
  }

  if (roles.size) {
    if (roles.has(node.role) || typeHit) score += 3;
    else if (!roleWordInName) score -= 1.2;
  }

  if (node.offscreen) score -= 0.8;
  if (!node.name) score -= 0.6;
  if (meaningful.length && matchedTerms === meaningful.length) score += 1.5;

  return score;
}

/**
 * Ranks tree nodes against a natural-language query.
 * @param {string} treeText output of the accessibility tree renderer
 * @param {string} query
 * @param {number} limit
 */
export function scoreCandidates(treeText, query, limit = 20) {
  const nodes = attachFormNames(parseTree(treeText));
  const rawTokens = tokenize(query);
  const terms = contentTokens(rawTokens);
  const { roles, strongRoles, consumed } = roleHintsFor(rawTokens);
  const phrase = String(query || '').toLowerCase().trim();
  const exactLabels = quotedLabels(query);
  const submitIntent = rawTokens.some((t) => SUBMIT_INTENT_WORDS.has(t));

  // The role filter. A query that names a role is about that role, so when the
  // page has one, everything else is off the list rather than one point behind
  // it. When nothing on the page carries it, the filter is dropped and the
  // ranking is the ordinary one, with roleGapNote saying so.
  const candidates = strongRoles.size
    ? nodes.filter((n) => strongRoles.has(n.role) || typeNamed(n, terms))
    : nodes;
  const ranked = candidates.length ? candidates : nodes;

  const scored = [];
  for (const node of ranked) {
    const score = scoreNode(node, {
      phrase, terms, roles, consumed, queryTokens: rawTokens, exactLabels, submitIntent,
    });
    if (score > 0.5) scored.push({ ...node, score: Math.round(score * 100) / 100 });
  }

  scored.sort((a, b) => b.score - a.score || a.depth - b.depth);

  // A page with the same label link on every row would otherwise fill the
  // whole result with copies of one element. The first is kept and the
  // rest counted, so other candidates stay visible.
  // Only links to the same place collapse. Ten "Add to cart" buttons with
  // nothing to tell them apart are ten targets, and the caller may want the
  // third one.
  const seen = new Map();
  const unique = [];
  for (const n of scored) {
    const href = /\bhref=(\S+)/.exec(n.attrs || '');
    const key = href ? n.role + '\u0000' + n.name + '\u0000' + href[1] : null;
    const first = key ? seen.get(key) : null;
    if (first) {
      first.count++;
      continue;
    }
    n.count = 1;
    if (key) seen.set(key, n);
    unique.push(n);
  }

  return unique.slice(0, limit).map((n) => ({
    count: n.count,
    ref: n.ref,
    role: n.role,
    name: n.name,
    attrs: n.attrs || undefined,
    offscreen: n.offscreen || undefined,
    // Carried through so a caller sees before it clicks that the control sends,
    // posts, deletes or pays.
    irreversible: n.irreversible || undefined,
    score: n.score,
  }));
}

/** "textbox" to "textboxes", "button" to "buttons". */
function plural(role, n) {
  if (n === 1) return role;
  return /(?:s|x|ch|sh)$/.test(role) ? role + 'es' : role + 's';
}

/**
 * One line saying the query named a role that nothing on the page carried.
 *
 * Without it a query for "issue title field" answered with twenty buttons
 * reads as twenty title fields, and the model acts on the first one. Returns
 * null when the query named no role, when a match carries it, or when there
 * was nothing to show, since the result already says so on its own.
 */
export function roleGapNote(query, matches) {
  if (!matches || !matches.length) return null;
  const tokens = tokenize(query);
  const { strongRoles, strongWords } = roleHintsFor(tokens);
  if (!strongRoles.size) return null;
  if (matches.some((m) => strongRoles.has(m.role))) return null;

  // The role the query asked for, named by the first strong word in it.
  const asked = tokens.find((t) => strongWords.includes(t)) || strongWords[0];
  const hint = ROLE_HINTS.find((h) => h.words.includes(asked));
  const wanted = hint ? hint.roles[0] : asked;

  const counts = new Map();
  for (const m of matches) counts.set(m.role, (counts.get(m.role) || 0) + 1);
  const shown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([role, n]) => n + ' ' + plural(role, n));
  return 'no ' + wanted + ' matched, ' + shown.join(' and ') + ' shown instead';
}

/**
 * Whether a search over the interactive filter should be repeated over the
 * whole tree (P5).
 *
 * Three shapes make the interactive filter the wrong scope. A query naming a
 * structural role (a table cell, a row, a heading, a paragraph) has no
 * interactive node to hit. A page whose content is a table has almost no
 * interactive nodes at all, which is how a nine-thousand-cell page reported two
 * candidates. And a modal built out of styled text rather than buttons has its
 * dismiss control outside the filter.
 */
const STRUCTURAL_QUERY_WORDS = [
  'cell', 'row', 'column', 'table', 'heading', 'title', 'text', 'paragraph',
  'label', 'caption', 'value', 'price', 'containing', 'contains', 'says',
];

export function shouldWiden({ query, matches, searched }) {
  const tokens = tokenize(query);
  if (tokens.some((t) => STRUCTURAL_QUERY_WORDS.includes(t))) return 'query names a non-interactive role';
  if (!matches.length) return 'no interactive node matched';
  if (matches[0].score < WIDEN_BELOW_SCORE) return 'best interactive match scored low';
  if (searched < 10) return 'the interactive filter left almost nothing to search';
  return null;
}

// ---------------------------------------------------------------------------
// P6. Model escalation through MCP sampling
//
// Local scoring stays the default: it answers in under a millisecond and
// resolves the queries find actually receives. When the best local score is
// low, or the caller asks for it outright, the host asks the MCP client's
// model to pick refs out of the tree, the same call the official extension
// makes on every single find, at the cost of a median 13735ms it pays whether
// or not the query needed it (R6 measurement in the campaign). Escalating
// only below a threshold gets the same semantic capability close to zero
// average cost.
// ---------------------------------------------------------------------------

/** Best local score below which `find` escalates to a model call. */
export const MODEL_ESCALATION_BELOW_SCORE = 3;

/** Whether find should escalate past local scoring to a model call. */
export function shouldEscalateToModel({ matches, semantic }) {
  if (semantic) return 'the caller asked for a semantic search';
  if (!matches || !matches.length) return 'no local match scored above the reporting floor';
  if (matches[0].score < MODEL_ESCALATION_BELOW_SCORE) return 'the best local match scored low';
  return null;
}

/**
 * Caps the tree text sent to the model. Amazon's find failed outright with
 * "234540 tokens > 200000 maximum" because the whole tree went in
 * uncapped (C-real-sites.md bug 4); this is the guard against that, applied
 * however big the page is. Offscreen nodes are dropped first, since a
 * semantic query is almost always about what is visible, and only truncated
 * outright if the onscreen tree alone still will not fit.
 */
export const MODEL_TREE_CHAR_CAP = 60000;

export function capTreeForModel(treeText, maxChars = MODEL_TREE_CHAR_CAP) {
  const full = String(treeText || '');
  if (full.length <= maxChars) return { text: full, capped: false, droppedOffscreen: 0 };

  const lines = full.split('\n');
  const onscreen = lines.filter((line) => !/\(offscreen\)/.test(line));
  let text = onscreen.join('\n');
  const droppedOffscreen = lines.length - onscreen.length;

  if (text.length > maxChars) {
    const note = '\n[tree truncated to ' + maxChars + ' chars for the model call]';
    text = text.slice(0, Math.max(0, maxChars - note.length)) + note;
  }
  return { text, capped: true, droppedOffscreen };
}

/** Every `[ref_N]` the tree text actually carries, for validating a model's answer against it. */
export function extractRefs(treeText) {
  const found = String(treeText || '').match(/\[ref_\d+\]/g) || [];
  return new Set(found.map((s) => s.slice(1, -1)));
}

const MODEL_LINE_RE = /^ref_\d+\s*\|/;

/**
 * Parses the model's `ref_X | role | name | type | reason` lines. Lines that
 * do not start with a ref are prose (the FOUND:/SHOWING:/--- header lines,
 * or the model explaining itself) and are skipped rather than treated as a
 * parse failure, since the model is not required to say nothing else.
 */
export function parseModelFindResponse(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!MODEL_LINE_RE.test(trimmed)) continue;
    const parts = trimmed.split('|').map((p) => p.trim());
    const [ref, role, name, type, ...rest] = parts;
    out.push({ ref, role: role || undefined, name: name || undefined, type: type || undefined, reason: rest.join('|').trim() || undefined });
  }
  return out;
}

/**
 * Drops any ref the model invented. The official extension does the same
 * check (`w=new Set(...)` against `[ref_\d+]` in the tree it sent,
 * `X-official-internals.md` part 1 section 5) because a model call answers
 * from what it read, and what it read can still not match what is really in
 * the tree once 20 candidates are asked for.
 */
export function validateModelMatches(modelMatches, treeText) {
  const validRefs = extractRefs(treeText);
  const valid = [];
  const hallucinated = [];
  for (const m of modelMatches) {
    if (validRefs.has(m.ref)) valid.push(m);
    else hallucinated.push(m.ref);
  }
  return { valid, hallucinated };
}
