// The MCP schemas live host-side so tools/list works before Chrome attaches,
// and the implementations live extension-side. These assert the two halves
// describe the same tool set, which is otherwise only discovered at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installChromeStub } from './chrome-stub.js';

installChromeStub();

const { TOOLS, TOOL_NAMES } = await import('../host/schemas.js');
const { handlers } = await import('../extension/src/lib/tools.js');
const { READ_ONLY_TOOLS } = await import('../extension/src/lib/permissions.js');

// browser_batch is executed by the service worker's router rather than by a
// handler, since it dispatches the other handlers.
const ROUTER_TOOLS = new Set(['browser_batch', 'quick', 'shortcuts_execute']);

// Answered by the MCP server itself, because they are about which browser to use
// or about resolving a local path, not about acting on a page.
const SERVER_TOOLS = new Set(['list_connected_browsers', 'select_browser', 'switch_browser', 'upload_image']);

test('every advertised tool has an implementation', () => {
  const missing = TOOL_NAMES.filter((n) => !ROUTER_TOOLS.has(n) && !SERVER_TOOLS.has(n) && !handlers[n]);
  assert.deepEqual(missing, [], 'schemas declare tools with no handler');
});

test('every implemented tool is advertised', () => {
  const undeclared = Object.keys(handlers).filter((n) => !TOOL_NAMES.includes(n));
  assert.deepEqual(undeclared, [], 'handlers exist for tools not in the schema list');
});

test('tool names are unique', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
});

test('every tool has a description and an object schema', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length > 30, tool.name + ' needs a real description');
    assert.equal(tool.inputSchema.type, 'object', tool.name);
  }
});

test('required parameters are declared in properties', () => {
  for (const tool of TOOLS) {
    for (const key of tool.inputSchema.required || []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, key),
        tool.name + ' requires ' + key + ' but does not declare it'
      );
    }
  }
});

test('every page-acting tool takes a tabId', () => {
  // declare_plan names origins for the whole session, so it has no tab either.
  const sessionScoped = ['tabs_context', 'tabs_create', 'browser_batch', 'shortcuts_list', 'declare_plan', ...SERVER_TOOLS];
  for (const tool of TOOLS) {
    if (sessionScoped.includes(tool.name)) continue;
    assert.ok(
      (tool.inputSchema.required || []).includes('tabId'),
      tool.name + ' should require tabId'
    );
  }
});

test('read-only classification covers every advertised tool', () => {
  const mutating = ['computer', 'navigate', 'form_input', 'javascript', 'tabs_create', 'tabs_close', 'resize_window'];
  for (const name of mutating) {
    assert.equal(READ_ONLY_TOOLS.has(name), false, name + ' must not be classified read-only');
  }
  for (const name of ['read_page', 'get_page_text', 'find']) {
    assert.equal(READ_ONLY_TOOLS.has(name), true, name + ' should be read-only');
  }
});

test('the schema list matches what the extension reports to the host', () => {
  // The service worker sends TOOL_NAMES in its hello message; a mismatch there
  // means the host would advertise tools the browser cannot run.
  const extensionNames = Object.keys(handlers).concat([...ROUTER_TOOLS], [...SERVER_TOOLS]).sort();
  assert.deepEqual(extensionNames, [...TOOL_NAMES].sort());
});
