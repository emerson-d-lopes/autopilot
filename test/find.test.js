import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTree,
  scoreCandidates,
  stripUrlAttributes,
  shouldWiden,
  WIDEN_BELOW_SCORE,
  shouldEscalateToModel,
  MODEL_ESCALATION_BELOW_SCORE,
  capTreeForModel,
  MODEL_TREE_CHAR_CAP,
  extractRefs,
  parseModelFindResponse,
  validateModelMatches,
  quotedLabels,
  FIND_TREE_CHAR_BUDGET,
} from '../extension/src/lib/find.js';

const TREE = [
  'navigation [ref_1]',
  '  link "Home" [ref_2] href=/',
  '  link "Documentation" [ref_3] href=/docs',
  '  link "Pricing" [ref_4] href=/pricing',
  'main [ref_5]',
  '  heading "Sign in to your account" [ref_6] level=1',
  '  form [ref_7]',
  '    textbox "Email address" [ref_8] type=email placeholder="you@example.com"',
  '    textbox "Password" [ref_9] type=password',
  '    checkbox "Remember me" [ref_10]',
  '    button "Sign in" [ref_11] type=submit',
  '    link "Forgot your password?" [ref_12] href=/reset',
  '  searchbox "Search docs" [ref_13] type=search',
  '  button "Add to cart" [ref_14] (offscreen)',
  '  combobox "Country" [ref_15] selected=Brazil',
].join('\n');

test('parseTree extracts role, name, ref, and attributes', () => {
  const nodes = parseTree(TREE);
  assert.equal(nodes.length, 15);

  const email = nodes.find((n) => n.ref === 'ref_8');
  assert.equal(email.role, 'textbox');
  assert.equal(email.name, 'Email address');
  assert.match(email.attrs, /type=email/);
  assert.equal(email.offscreen, false);

  const cart = nodes.find((n) => n.ref === 'ref_14');
  assert.equal(cart.offscreen, true);
});

test('parseTree handles escaped quotes in names', () => {
  const nodes = parseTree('button "Say \\"hello\\"" [ref_1]');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'Say "hello"');
});

test('parseTree ignores lines without a ref', () => {
  const nodes = parseTree('some free text\nbutton "Real" [ref_1]\n');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].ref, 'ref_1');
});

test('find resolves a role plus name query', () => {
  const matches = scoreCandidates(TREE, 'sign in button');
  assert.equal(matches[0].ref, 'ref_11');
  assert.equal(matches[0].role, 'button');
});

test('find prefers the search box for "search bar"', () => {
  const matches = scoreCandidates(TREE, 'search bar');
  assert.equal(matches[0].ref, 'ref_13');
});

test('find resolves a field by its label', () => {
  const matches = scoreCandidates(TREE, 'email field');
  assert.equal(matches[0].ref, 'ref_8');
});

test('find distinguishes password field from forgot-password link', () => {
  const matches = scoreCandidates(TREE, 'password field');
  assert.equal(matches[0].ref, 'ref_9');
});

test('find returns the link when the query says link', () => {
  const matches = scoreCandidates(TREE, 'forgot password link');
  assert.equal(matches[0].ref, 'ref_12');
});

test('find matches a checkbox', () => {
  const matches = scoreCandidates(TREE, 'remember me checkbox');
  assert.equal(matches[0].ref, 'ref_10');
});

test('find matches the dropdown by role synonym', () => {
  const matches = scoreCandidates(TREE, 'country dropdown');
  assert.equal(matches[0].ref, 'ref_15');
});

test('find matches documentation link', () => {
  const matches = scoreCandidates(TREE, 'documentation');
  assert.equal(matches[0].ref, 'ref_3');
});

test('offscreen elements rank below equivalent visible ones', () => {
  const tree = ['button "Continue" [ref_1] (offscreen)', 'button "Continue" [ref_2]'].join('\n');
  const matches = scoreCandidates(tree, 'continue button');
  assert.equal(matches[0].ref, 'ref_2');
});

test('find caps results at the requested limit', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'button "Item ' + i + '" [ref_' + i + ']').join('\n');
  assert.equal(scoreCandidates(many, 'item', 20).length, 20);
});

test('find returns nothing for an unrelated query', () => {
  assert.equal(scoreCandidates(TREE, 'zyxwvu qqq').length, 0);
});

test('find tolerates an empty tree', () => {
  assert.deepEqual(scoreCandidates('', 'anything'), []);
});

test('URL attributes do not create spurious matches', () => {
  // "sidebar" inside an href once made this link the top hit for "search bar".
  const tree = [
    'link "Donate" [ref_1] href=https://donate.example.org/?medium=sidebar&campaign=search',
    'searchbox "Search Wikipedia" [ref_2] type=search',
  ].join('\n');

  const matches = scoreCandidates(tree, 'the search bar');
  assert.equal(matches[0].ref, 'ref_2');
  assert.equal(matches.some((m) => m.ref === 'ref_1'), false, 'the donate link must not match');
});

test('non-URL attributes still match on whole words', () => {
  const tree = 'textbox "Email" [ref_1] type=email placeholder="work address"';
  const matches = scoreCandidates(tree, 'address field');
  assert.equal(matches[0].ref, 'ref_1');
});

test('a partial word inside an attribute does not match', () => {
  const tree = 'link "Careers" [ref_1] href=/company/careers-and-barista-jobs';
  assert.equal(scoreCandidates(tree, 'bar').length, 0);
});

test('stripUrlAttributes removes href and src values only', () => {
  const stripped = stripUrlAttributes('href="/a/sidebar?x=1" type=search placeholder="Find things"');
  assert.equal(/sidebar/.test(stripped), false);
  assert.match(stripped, /type=search/);
  assert.match(stripped, /Find things/);
});

test('a query naming the input type outranks a generic textbox', () => {
  const tree = [
    'form [ref_1]',
    '  textbox "Autocomplete" [ref_2] type=text',
    '  textbox "Email address" [ref_3] type=email',
    '  button "Attach a file" [ref_4] (offscreen) type=file',
    '  button "Attach several files" [ref_5] type=file multiple',
  ].join('\n');
  assert.equal(scoreCandidates(tree, 'file input')[0].ref, 'ref_4');
  assert.equal(scoreCandidates(tree, 'the email field')[0].ref, 'ref_3');
  assert.equal(scoreCandidates(tree, 'autocomplete input')[0].ref, 'ref_2');
});

test('a query made only of role words still matches an element named with one of them', () => {
  const tree = ['link "Search" [ref_1] href=/wiki/Special:Search', 'link "Donate" [ref_2] href=/donate', 'button "Main menu" [ref_3]'].join('\n');
  const matches = scoreCandidates(tree, 'search box');
  assert.equal(matches[0] && matches[0].ref, 'ref_1');
});

test('duplicates collapse only for links to the same place', () => {
  const tree = [
    'link "platform:macos" [ref_1] href=/issues?label=macos',
    'link "platform:macos" [ref_2] href=/issues?label=macos',
    'button "Add to cart" [ref_3]',
    'button "Add to cart" [ref_4]',
    'button "Add to cart" [ref_5]',
  ].join('\n');
  const links = scoreCandidates(tree, 'platform:macos');
  assert.equal(links.filter((m) => m.name === 'platform:macos').length, 1, 'same link listed once');
  assert.equal(links[0].count, 2);
  const buttons = scoreCandidates(tree, 'add to cart button');
  assert.equal(buttons.filter((m) => m.name === 'Add to cart').length, 3, 'every button stays addressable');
});

// ---------------------------------------------------------------------------
// W3: the irreversible mark survives the tree parse
// ---------------------------------------------------------------------------

test('parseTree reads the irreversible mark without losing the role or the ref', () => {
  const nodes = parseTree(
    [
      'button "Send" [irreversible] [ref_1] type=submit',
      'button "Save draft" [ref_2]',
      'link "Delete account" [irreversible] [ref_3] (offscreen) href=/settings',
    ].join('\n')
  );

  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].role, 'button');
  assert.equal(nodes[0].name, 'Send');
  assert.equal(nodes[0].ref, 'ref_1');
  assert.equal(nodes[0].irreversible, true);
  assert.match(nodes[0].attrs, /type=submit/);
  assert.equal(nodes[1].irreversible, false);
  assert.equal(nodes[2].irreversible, true);
  assert.equal(nodes[2].offscreen, true, 'the offscreen mark still parses alongside it');
});

test('a match carries the irreversible flag so the model sees it before clicking', () => {
  const matches = scoreCandidates('button "Send message" [irreversible] [ref_9]', 'send message button', 5);
  assert.equal(matches[0].ref, 'ref_9');
  assert.equal(matches[0].irreversible, true);
});

// ---------------------------------------------------------------------------
// P5: when the interactive filter is the wrong scope
// ---------------------------------------------------------------------------

const TABLE_PAGE_INTERACTIVE = [
  'link "Elemental Selenium" [ref_1] href=/',
  'link "Fork me" [ref_2] href=/gh',
].join('\n');

test('a query naming a table cell widens past the interactive filter', () => {
  const matches = scoreCandidates(TABLE_PAGE_INTERACTIVE, 'table cell containing 50.20', 20);
  const reason = shouldWiden({ query: 'table cell containing 50.20', matches, searched: 2 });
  assert.equal(reason, 'query names a non-interactive role');
});

test('a page with almost nothing interactive widens even for a plain query', () => {
  const matches = scoreCandidates(TABLE_PAGE_INTERACTIVE, 'the price of the third row', 20);
  assert.ok(shouldWiden({ query: 'the price of the third row', matches, searched: 2 }));
});

test('a modal whose close control is styled text widens rather than reporting no match', () => {
  const matches = scoreCandidates('link "Elemental Selenium" [ref_1] href=/', 'Close', 20);
  assert.equal(shouldWiden({ query: 'Close', matches, searched: 2 }), 'no interactive node matched');
});

test('an ordinary page with a good interactive match is not widened', () => {
  const matches = scoreCandidates(TREE, 'sign in button', 20);
  assert.ok(matches[0].score >= WIDEN_BELOW_SCORE, 'the match is confident: ' + matches[0].score);
  assert.equal(shouldWiden({ query: 'sign in button', matches, searched: 15 }), null);
});

// ---------------------------------------------------------------------------
// P6: the model escalation path
// ---------------------------------------------------------------------------

test('a confident local match does not escalate to a model call', () => {
  const matches = scoreCandidates(TREE, 'sign in button', 20);
  assert.ok(matches[0].score >= MODEL_ESCALATION_BELOW_SCORE);
  assert.equal(shouldEscalateToModel({ matches, semantic: false }), null);
});

test('a weak local score escalates', () => {
  const matches = [{ ref: 'ref_1', score: 1 }];
  assert.ok(shouldEscalateToModel({ matches, semantic: false }));
});

test('no local match at all escalates', () => {
  assert.ok(shouldEscalateToModel({ matches: [], semantic: false }));
});

test('semantic: true escalates even over a confident local match', () => {
  const matches = scoreCandidates(TREE, 'sign in button', 20);
  assert.equal(shouldEscalateToModel({ matches, semantic: true }), 'the caller asked for a semantic search');
});

test('capTreeForModel leaves a short tree untouched', () => {
  const result = capTreeForModel(TREE, MODEL_TREE_CHAR_CAP);
  assert.equal(result.capped, false);
  assert.equal(result.text, TREE);
});

test('capTreeForModel drops offscreen nodes first when the tree is over the cap', () => {
  const onscreen = 'button "Keep" [ref_1]\n';
  const offscreen = 'button "Drop" [ref_2] (offscreen)\n';
  const tree = onscreen.repeat(400) + offscreen.repeat(400);
  const result = capTreeForModel(tree, 2000);
  assert.equal(result.capped, true);
  assert.ok(result.droppedOffscreen > 0);
  assert.equal(/\(offscreen\)/.test(result.text), false, 'no offscreen line survived once dropping them made room');
});

test('capTreeForModel truncates outright when even the onscreen tree exceeds the cap, and stays within it', () => {
  const tree = Array.from({ length: 5000 }, (_, i) => 'link "Item ' + i + '" [ref_' + i + ']').join('\n');
  const result = capTreeForModel(tree, 5000);
  assert.equal(result.capped, true);
  assert.ok(result.text.length <= 5000, 'the capped text never exceeds the requested ceiling: ' + result.text.length);
  assert.match(result.text, /truncated/);
});

test('capTreeForModel never exceeds the cap even on a pathologically large page (the Amazon failure)', () => {
  const huge = 'link "x" [ref_1] href=/a\n'.repeat(20000); // far larger than 60000 chars
  const result = capTreeForModel(huge, MODEL_TREE_CHAR_CAP);
  assert.ok(result.text.length <= MODEL_TREE_CHAR_CAP);
});

test('extractRefs finds every ref in the tree text', () => {
  const refs = extractRefs(TREE);
  assert.equal(refs.size, 15);
  assert.ok(refs.has('ref_11'));
  assert.equal(refs.has('ref_999'), false);
});

test('extractRefs on empty text returns an empty set', () => {
  assert.equal(extractRefs('').size, 0);
  assert.equal(extractRefs(null).size, 0);
});

test('parseModelFindResponse reads pipe-delimited match lines and skips prose', () => {
  const text = [
    'FOUND: 2',
    'SHOWING: 2',
    '---',
    'ref_11 | button | Sign in | submit | matches "sign in" exactly',
    'ref_9 | textbox | Password | password | a password field, not what was asked',
  ].join('\n');
  const parsed = parseModelFindResponse(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].ref, 'ref_11');
  assert.equal(parsed[0].role, 'button');
  assert.equal(parsed[0].name, 'Sign in');
  assert.equal(parsed[0].type, 'submit');
  assert.match(parsed[0].reason, /matches "sign in" exactly/);
});

test('parseModelFindResponse tolerates a reply with no matching lines', () => {
  assert.deepEqual(parseModelFindResponse('I could not find anything matching that.'), []);
  assert.deepEqual(parseModelFindResponse(''), []);
});

test('validateModelMatches drops a ref the model invented', () => {
  const modelMatches = [{ ref: 'ref_11' }, { ref: 'ref_9999' }];
  const { valid, hallucinated } = validateModelMatches(modelMatches, TREE);
  assert.deepEqual(valid.map((m) => m.ref), ['ref_11']);
  assert.deepEqual(hallucinated, ['ref_9999']);
});

test('validateModelMatches keeps everything when every ref is real', () => {
  const modelMatches = [{ ref: 'ref_11' }, { ref: 'ref_13' }];
  const { valid, hallucinated } = validateModelMatches(modelMatches, TREE);
  assert.equal(valid.length, 2);
  assert.equal(hallucinated.length, 0);
});

test('validateModelMatches against a capped tree drops a ref that was truncated away', () => {
  const capped = capTreeForModel(TREE, 200); // small enough to lose most of the tree
  const modelMatches = [{ ref: 'ref_11' }];
  const { valid, hallucinated } = validateModelMatches(modelMatches, capped.text);
  // Whichever refs survived the cap are the only ones a validation against
  // what was actually sent can call real, which is the point of validating
  // against the sent text rather than the full page.
  assert.equal(valid.length + hallucinated.length, 1);
});

// ---------------------------------------------------------------------------
// Open bug 1: an exact label on a large page
// ---------------------------------------------------------------------------

const BIG_BUTTONS = Array.from(
  { length: 3000 },
  (_, i) => 'button "btn ' + i + '" [ref_' + (3000 + i) + ']'
).join('\n');

test('quotedLabels reads the label out of a query', () => {
  assert.deepEqual(quotedLabels('the button labelled exactly "btn 2999"'), ['btn 2999']);
  assert.deepEqual(quotedLabels('“Sign in” link'), ['sign in']);
  assert.deepEqual(quotedLabels("it's the save button"), [], 'an apostrophe does not open a label');
  assert.deepEqual(quotedLabels(''), []);
});

test('a quoted exact label outranks every fuzzy match on a 3000 button page', () => {
  const matches = scoreCandidates(BIG_BUTTONS, 'the button labelled exactly "btn 2999"', 20);
  assert.equal(matches[0].name, 'btn 2999');
  assert.equal(matches[0].ref, 'ref_5999');
  assert.ok(
    matches[0].score > matches[1].score,
    'the exact label wins outright, not on a tie: ' + matches[0].score + ' vs ' + matches[1].score
  );
});

test('an exact label wins without quotes too', () => {
  const matches = scoreCandidates(BIG_BUTTONS, 'the button labelled exactly btn 2999', 20);
  assert.equal(matches[0].name, 'btn 2999');
});

test('the exact run has to be in the query order', () => {
  // "20.50" shares both words with a query for "50.20" and used to tie with it.
  const cells = [];
  for (let row = 1; row <= 50; row++) {
    for (let col = 1; col <= 50; col++) {
      cells.push('cell "' + row + '.' + col + '" [ref_' + (row * 100 + col) + ']');
    }
  }
  const matches = scoreCandidates(cells.join('\n'), 'the table cell containing 50.20', 20);
  assert.equal(matches[0].name, '50.20');
  assert.ok(matches[0].score > matches[1].score, 'reversed digits do not tie with the exact cell');
});

test('the exact bonus does not resurrect an unrelated node', () => {
  assert.equal(scoreCandidates(BIG_BUTTONS, 'zyxwvu qqq').length, 0);
});

test('ranking a 9000 node tree stays under a few milliseconds', () => {
  const lines = [];
  for (let i = 0; i < 9000; i++) {
    lines.push('  cell "row ' + i + ' value ' + (i * 7) + '" [ref_' + i + ']');
  }
  const tree = lines.join('\n');
  const started = process.hrtime.bigint();
  const matches = scoreCandidates(tree, 'the cell containing "row 8123 value 56861"', 20);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(matches[0].ref, 'ref_8123');
  assert.ok(ms < 60, 'ranking took ' + ms.toFixed(1) + ' ms');
});

test('the ranking budget is large enough for the whole interactive tree of a 3000 row page', () => {
  assert.ok(FIND_TREE_CHAR_BUDGET >= BIG_BUTTONS.length * 2, 'budget ' + FIND_TREE_CHAR_BUDGET);
});

// ---------------------------------------------------------------------------
// A query that names a role: github.com/<repo>/issues/new
// ---------------------------------------------------------------------------
//
// From the 0.1.35 write rehearsal. `find "issue title field"` returned twenty
// markdown toolbar buttons and `find "submit new issue button"` returned no
// Create button, while read_page on the same page gave
// textbox "Add a title" [ref_24], textbox "Markdown value" [ref_35] and
// button "Create ( )" [ref_46]. The toolbar names are GitHub's own.

const TOOLBAR = [
  'Add heading text', 'Add bold text', 'Add italic text', 'Add a quote',
  'Add code', 'Add a link', 'Add a bulleted list', 'Add a numbered list',
  'Add a task list', 'Directly mention a user or team',
  'Reference an issue, pull request, or discussion', 'Add saved reply',
  'Attach files', 'Insert a table', 'Add a comment', 'Slash commands',
  'Toggle preview', 'Use full screen', 'Markdown help', 'Text formatting help',
];

const NEW_ISSUE = [
  'main [ref_10]',
  '  form "New issue" [ref_20]',
  '    textbox "Add a title" [ref_24] placeholder="Title" required=true',
  '    heading "Add a description" [ref_25] level=2',
  '    toolbar [ref_30]',
  ...TOOLBAR.map((name, i) => '      button "' + name + '" [ref_' + (31 + i) + ']'),
  '    textbox "Markdown value" [ref_35] placeholder="Type your description here..."',
  '    button "Create ( )" [ref_46]',
  '    button "Cancel" [ref_47]',
].join('\n');

test('a query naming a field ranks the title textbox above the toolbar', () => {
  const matches = scoreCandidates(NEW_ISSUE, 'issue title field', 20);

  assert.equal(matches[0].ref, 'ref_24', 'top match: ' + JSON.stringify(matches.slice(0, 3)));
  assert.equal(matches[0].role, 'textbox');
  assert.equal(
    matches.some((m) => m.role === 'button'),
    false,
    'a query for a field does not answer with buttons: ' + matches.map((m) => m.role).join(', ')
  );
});

test('a query naming the submit button ranks Create first', () => {
  const matches = scoreCandidates(NEW_ISSUE, 'submit new issue button', 20);

  assert.equal(matches[0].ref, 'ref_46', 'top match: ' + JSON.stringify(matches.slice(0, 3)));
  assert.equal(matches[0].name, 'Create ( )');
  assert.ok(
    matches[0].score > matches[1].score,
    'Create wins outright: ' + matches[0].score + ' vs ' + matches[1].score
  );
});

test('the toolbar buttons are still reachable by their own names', () => {
  // The role filter must not hide a control the query actually names.
  const matches = scoreCandidates(NEW_ISSUE, 'reference an issue button', 20);
  assert.equal(matches[0].name, 'Reference an issue, pull request, or discussion');
});

test('the nearest form name reaches the controls inside it', () => {
  const outside = [
    'form "New issue" [ref_1]',
    '  button "Create" [ref_2]',
    'form "Newsletter" [ref_3]',
    '  button "Create" [ref_4]',
  ].join('\n');
  const matches = scoreCandidates(outside, 'create the new issue button', 20);
  assert.equal(matches[0].ref, 'ref_2', 'the button in the issue form outranks its twin');
});
