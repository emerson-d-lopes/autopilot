#!/usr/bin/env node
// Performance bench. Implements the nine measurements from
// docs/claude-in-chrome-comparison/evidence/R-repeat-performance.md, three runs
// each, against the campaign fixture server started locally on a free port.
//
// Drives the bridge the same way the live tests do: spawns host/mcp-server.js
// and talks JSON-RPC over stdio. Prints a table of run 1, run 2, run 3 and the
// median wall time in milliseconds, plus the median of the tool-reported
// durationMs where the tool reports one. Appends one JSON line per run to
// .bench/<date>.jsonl with the extension version.
//
// Usage: node tools/bench.js  (or: npm run bench)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { connect } from '../host/ipc.js';
import { anyBridge, listBrowsers } from '../host/registry.js';
import { start as startFixture } from '../test/fixtures/campaign/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = 3;

// --- MCP client, same shape as test/live.test.js -------------------------------

function mcpClient(child) {
  let buffer = '';
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });

  let seq = 0;
  return {
    request(method, params) {
      const id = ++seq;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error('timed out: ' + method + ' ' + JSON.stringify(params).slice(0, 120)));
        }, 60000);
        if (typeof timer.unref === 'function') timer.unref();
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return promise;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

// Failures seen since the last reset. A measurement that errors still takes
// wall time, so without this the summary reported the cost of ten screenshots
// that never produced an image.
let failures = [];

function resetFailures() {
  failures = [];
}

async function callTool(mcp, name, args) {
  const response = await mcp.request('tools/call', { name, arguments: args });
  const content = (response.result && response.result.content) || [];
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const isError = (response.result && response.result.isError) === true;
  if (isError) failures.push(name + ': ' + text.split('\n')[0].slice(0, 120));
  return { isError, text, durationMs: extractDurationMs(text) };
}

function extractDurationMs(text) {
  const total = [];
  const re = /"durationMs":\s*(\d+)/g;
  let m;
  while ((m = re.exec(text))) total.push(Number(m[1]));
  const altRe = /durationMs[:=]\s*(\d+)/g;
  while ((m = altRe.exec(text))) total.push(Number(m[1]));
  return total;
}

function refFor(text, pattern) {
  for (const line of text.split('\n')) {
    if (pattern.test(line)) {
      const match = line.match(/\[(ref_\d+)\]/);
      if (match) return match[1];
    }
  }
  return null;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

// --- extension version, the way tools/doctor.js reads it ------------------------

// The bench runs against the bridge anyBridge() picked, so the version has to
// come from that same bridge. Reading browsers[0] printed the user's own Chrome
// version while the measurements ran against the development browser.
async function extensionVersion(bridge) {
  try {
    const target = bridge || (await listBrowsers())[0];
    if (!target) return null;
    const link = await connect(target.socket);
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      link.on('message', (message) => {
        if (message.type === 'browser_status') {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    link.end();
    return (status && status.extensionVersion) || null;
  } catch {
    return null;
  }
}

// --- the nine measurements -------------------------------------------------------
// Each returns { durationMs: number[] } of every tool-reported duration seen
// during the measurement. Wall time is measured by the caller around the call.

async function measure10Calls(mcp, tabId) {
  const durations = [];
  for (let i = 0; i < 10; i++) {
    const result = await callTool(mcp, 'javascript', { tabId, code: '1+1' });
    durations.push(...result.durationMs);
  }
  return { durationMs: durations };
}

async function measureBatch10Calls(mcp, tabId) {
  const actions = Array.from({ length: 10 }, () => ({ name: 'javascript', input: { tabId, code: '1+1' } }));
  const result = await callTool(mcp, 'browser_batch', { actions });
  return { durationMs: result.durationMs };
}

async function measureQuick10Calls(mcp, tabId) {
  const script = Array.from({ length: 10 }, () => 'J 1+1').join('\n');
  const result = await callTool(mcp, 'quick', { tabId, script });
  return { durationMs: result.durationMs };
}

async function measure10Screenshots(mcp, tabId, base) {
  // about:blank cannot be captured at all, so the tab has to be on a real page
  // or this measures ten permission errors.
  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  const durations = [];
  for (let i = 0; i < 10; i++) {
    const result = await callTool(mcp, 'computer', { tabId, action: 'screenshot' });
    durations.push(...result.durationMs);
  }
  return { durationMs: durations };
}

async function measureReadPage(mcp, tabId, base) {
  const durations = [];
  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  durations.push(...(await callTool(mcp, 'read_page', { tabId, filter: 'all' })).durationMs);
  durations.push(...(await callTool(mcp, 'read_page', { tabId, filter: 'interactive' })).durationMs);
  await callTool(mcp, 'navigate', { url: base + '/big', tabId });
  durations.push(...(await callTool(mcp, 'read_page', { tabId, filter: 'all' })).durationMs);
  durations.push(...(await callTool(mcp, 'read_page', { tabId, filter: 'interactive' })).durationMs);
  return { durationMs: durations };
}

async function measureGetPageText(mcp, tabId, base) {
  const durations = [];
  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  durations.push(...(await callTool(mcp, 'get_page_text', { tabId })).durationMs);
  await callTool(mcp, 'navigate', { url: base + '/big', tabId });
  durations.push(...(await callTool(mcp, 'get_page_text', { tabId })).durationMs);
  return { durationMs: durations };
}

async function measureFind(mcp, tabId, base) {
  const durations = [];
  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  durations.push(...(await callTool(mcp, 'find', { tabId, query: 'submit button' })).durationMs);
  await callTool(mcp, 'navigate', { url: base + '/big', tabId });
  durations.push(...(await callTool(mcp, 'find', { tabId, query: 'btn 1500' })).durationMs);
  return { durationMs: durations };
}

async function measureNavigate(mcp, tabId, base) {
  const durations = [];
  for (const url of [base + '/', base + '/slow', base + '/redirect', 'https://example.com']) {
    durations.push(...(await callTool(mcp, 'navigate', { url, tabId })).durationMs);
  }
  return { durationMs: durations };
}

async function measureRealisticFlow(mcp, tabId, base) {
  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  const tree = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
  const nameRef = refFor(tree.text, /"Name"/i);
  const emailRef = refFor(tree.text, /"Email"/i);
  const countryRef = refFor(tree.text, /combobox/i);
  const submitRef = refFor(tree.text, /button "Submit"/i);

  const actions = [
    { name: 'form_input', input: { tabId, ref: nameRef, value: 'Ana' } },
    { name: 'form_input', input: { tabId, ref: emailRef, value: 'ana@example.com' } },
    { name: 'form_input', input: { tabId, ref: countryRef, value: 'Portugal' } },
    { name: 'computer', input: { tabId, action: 'left_click', ref: submitRef } },
    { name: 'javascript', input: { tabId, code: "document.getElementById('out').textContent" } },
    { name: 'computer', input: { tabId, action: 'screenshot' } },
  ];
  const result = await callTool(mcp, 'browser_batch', { actions });
  return { durationMs: result.durationMs };
}

async function measureTyping(mcp, tabId, base) {
  const durations = [];
  const text500 = '0123456789'.repeat(50);

  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  let tree = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
  let notesRef = refFor(tree.text, /"Notes"/i);
  await callTool(mcp, 'computer', { tabId, action: 'left_click', ref: notesRef });
  durations.push(...(await callTool(mcp, 'computer', { tabId, action: 'type', text: text500 })).durationMs);

  await callTool(mcp, 'navigate', { url: base + '/', tabId });
  tree = await callTool(mcp, 'read_page', { tabId, filter: 'interactive' });
  notesRef = refFor(tree.text, /"Notes"/i);
  await callTool(mcp, 'computer', { tabId, action: 'left_click', ref: notesRef });
  durations.push(
    ...(await callTool(mcp, 'computer', { tabId, action: 'type', text: text500, perKey: true })).durationMs
  );

  return { durationMs: durations };
}

async function measureLargeReturn(mcp, tabId) {
  const result = await callTool(mcp, 'javascript', { tabId, code: "'x'.repeat(200000)" });
  return { durationMs: result.durationMs };
}

const MEASUREMENTS = [
  { key: '1a', label: '10 separate javascript 1+1 calls', run: measure10Calls },
  { key: '1b', label: '10 1+1 calls in one browser_batch', run: measureBatch10Calls },
  { key: '1c', label: '10 1+1 lines in a quick script', run: measureQuick10Calls },
  { key: '2', label: '10 separate screenshots', run: measure10Screenshots },
  { key: '3', label: 'read_page all+interactive, index.html and /big', run: measureReadPage },
  { key: '4', label: 'get_page_text, index.html and /big', run: measureGetPageText },
  { key: '5', label: 'find: submit button, btn 1500', run: measureFind },
  { key: '6', label: 'navigate: index, /slow, /redirect, example.com', run: measureNavigate },
  { key: '7', label: 'realistic form flow as one batch', run: measureRealisticFlow },
  { key: '8', label: 'type 500 chars, plain then perKey', run: measureTyping },
  { key: '9', label: "javascript 'x'.repeat(200000)", run: measureLargeReturn },
];

// --- main ------------------------------------------------------------------------

async function main() {
  const bridge = await anyBridge();
  if (!bridge) {
    console.log('Autopilot bench');
    console.log('');
    console.log('no browser bridge is connected (run: npm run browser, or open Chrome with the extension loaded)');
    console.log('the bench drives a real browser through mcp-server.js, so it has nothing to measure without one');
    return;
  }
  process.env.AUTOPILOT_BROWSER_ID = bridge.id;

  const fixture = await startFixture(0);
  const base = 'http://127.0.0.1:' + fixture.address().port;
  console.log('fixture server: ' + base);

  const version = await extensionVersion(bridge);
  console.log('extension version: ' + (version || 'unknown (no bridge connected, or run: npm run doctor)'));
  console.log('');

  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);

  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bench', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  const context = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
  const tabId = JSON.parse(context.text).tabs[0].tabId;

  // { key -> { wall: [ms,ms,ms], tool: [ms,ms,ms] } }
  const results = {};
  for (const m of MEASUREMENTS) results[m.key] = { wall: [], tool: [], failures: 0 };

  mkdirSync(join(ROOT, '.bench'), { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const jsonlPath = join(ROOT, '.bench', dateStr + '.jsonl');

  for (let run = 1; run <= RUNS; run++) {
    console.log('--- run ' + run + ' ---');
    const runRecord = { run, timestamp: new Date().toISOString(), extensionVersion: version, measurements: {} };

    for (const m of MEASUREMENTS) {
      resetFailures();
      const started = Date.now();
      let outcome;
      try {
        outcome = await m.run(mcp, tabId, base);
      } catch (err) {
        console.log('  ' + m.key + ' ' + m.label + ': ERROR ' + err.message);
        outcome = { durationMs: [] };
      }
      const wallMs = Date.now() - started;
      const toolSum = outcome.durationMs.length ? sum(outcome.durationMs) : null;

      results[m.key].wall.push(wallMs);
      if (toolSum !== null) results[m.key].tool.push(toolSum);

      const failed = failures.slice();
      runRecord.measurements[m.key] = { label: m.label, wallMs, toolDurationsMs: outcome.durationMs, failures: failed };
      results[m.key].failures = (results[m.key].failures || 0) + failed.length;
      console.log(
        '  ' +
          m.key +
          ' ' +
          m.label +
          ': ' +
          wallMs +
          ' ms' +
          (toolSum !== null ? ' (tool total ' + toolSum + ' ms)' : '') +
          (failed.length ? '  [' + failed.length + ' failed: ' + failed[0] + ']' : '')
      );
    }

    appendFileSync(jsonlPath, JSON.stringify(runRecord) + '\n');
  }

  await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
  child.kill();
  await new Promise((r) => fixture.close(r));

  console.log('');
  console.log('=== summary (median wall ms, median tool-reported durationMs where present) ===');
  console.log('');
  const col = (v, w) => String(v).padEnd(w);
  console.log(
    col('measurement', 46) +
      col('run 1', 10) +
      col('run 2', 10) +
      col('run 3', 10) +
      col('median wall', 14) +
      'median tool'
  );
  for (const m of MEASUREMENTS) {
    const r = results[m.key];
    const medWall = median(r.wall);
    const medTool = r.tool.length ? median(r.tool) : null;
    console.log(
      col(m.key + '. ' + m.label, 46) +
        col(r.wall[0] + 'ms', 10) +
        col(r.wall[1] + 'ms', 10) +
        col(r.wall[2] + 'ms', 10) +
        col(medWall + 'ms', 14) +
        (medTool !== null ? medTool + 'ms' : 'n/a')
    );
  }
  console.log('');
  console.log('appended ' + RUNS + ' run(s) to ' + jsonlPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
