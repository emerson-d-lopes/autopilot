// Claude in Chrome compatibility: names and argument spellings from Claude
// Code's own browser integration map onto this server's tools.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCall } from '../extension/src/lib/aliases.js';
import { parseScript } from '../extension/src/lib/quick.js';

test('tool names with the _mcp suffix and javascript_tool are mapped', () => {
  assert.equal(normalizeCall('tabs_context_mcp', {}).name, 'tabs_context');
  assert.equal(normalizeCall('tabs_create_mcp', {}).name, 'tabs_create');
  assert.equal(normalizeCall('tabs_close_mcp', { tabId: 1 }).name, 'tabs_close');
  const js = normalizeCall('javascript_tool', { action: 'javascript_exec', text: '1+1', tabId: 1 });
  assert.deepEqual(js, { name: 'javascript', input: { code: '1+1', tabId: 1 } });
});

test('camelCase filters are accepted and a substring urlPattern is escaped', () => {
  assert.deepEqual(normalizeCall('read_console_messages', { onlyErrors: true, tabId: 1 }).input, {
    only_errors: true,
    tabId: 1,
  });
  const net = normalizeCall('read_network_requests', { urlPattern: 'api.example.com/v1?x=1', tabId: 1 }).input;
  assert.equal(net.url_pattern, 'api\\.example\\.com/v1\\?x=1');
  assert.ok(new RegExp(net.url_pattern).test('https://api.example.com/v1?x=1'));
  assert.equal(net.urlPattern, undefined);
});

test('our own spelling wins when both are given', () => {
  const out = normalizeCall('read_console_messages', { onlyErrors: true, only_errors: false }).input;
  assert.equal(out.only_errors, false);
  assert.equal(out.onlyErrors, undefined);
});

test('gif, browser and shortcut arguments are mapped', () => {
  assert.deepEqual(normalizeCall('gif_creator', { action: 'start_recording', tabId: 1 }).input, {
    action: 'start',
    tabId: 1,
  });
  assert.deepEqual(
    normalizeCall('gif_creator', { action: 'export', download: true, filename: 'x.gif', tabId: 1 }).input,
    {
      action: 'stop',
      filename: 'x.gif',
      tabId: 1,
    }
  );
  assert.equal(normalizeCall('gif_creator', { action: 'clear' }).input.action, 'cancel');
  assert.equal(normalizeCall('select_browser', { deviceId: 'abc' }).input.browserId, 'abc');
  assert.equal(normalizeCall('shortcuts_execute', { command: 'debug', tabId: 1 }).input.shortcutId, 'debug');
});

test('unknown tools and native calls pass through unchanged', () => {
  assert.deepEqual(normalizeCall('nope', { a: 1 }), { name: 'nope', input: { a: 1 } });
  assert.deepEqual(normalizeCall('computer', { action: 'screenshot', tabId: 2 }), {
    name: 'computer',
    input: { action: 'screenshot', tabId: 2 },
  });
});

test('quick NT, ST and LT retarget the lines that follow', () => {
  const actions = parseScript('C ref_1\nNT https://example.com\nC ref_2\nST 7\nR\nLT', 3);
  assert.deepEqual(
    actions.map((a) => [a.name, a.input.tabId]),
    [
      ['computer', 3],
      ['tabs_create', undefined],
      ['computer', '$last'],
      ['page_state', 7],
      ['read_page', 7],
      ['tabs_context', undefined],
    ]
  );
  assert.equal(actions[1].input.url, 'https://example.com');
  assert.throws(() => parseScript('ST abc', 1), /ST needs a tab id/);
});
