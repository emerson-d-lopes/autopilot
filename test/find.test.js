import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTree, scoreCandidates, stripUrlAttributes } from '../extension/src/lib/find.js';

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
