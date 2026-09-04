#!/usr/bin/env node
// Screenshot bench for Phase 5 (S1, S2, S3).
//
// Captures the campaign fixture's index page and /big ten times each, in PNG and
// JPEG, at scale 1 and 0.5, and prints for every cell the image dimensions, the
// base64 payload size, the token estimate, and the per-capture milliseconds with
// their median. The 10-screenshot median is the Phase 5 acceptance number.
//
// It drives a real browser through host/mcp-server.js the way tools/bench.js
// does. A development browser is preferred, since that is the one running the
// extension from this checkout. With none connected it says so and stops, since
// measuring a browser on a different build would describe other code.
//
// Usage: node tools/bench-screenshot.js [--runs 10] [--any-browser]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { connect } from '../host/ipc.js';
import { listBrowsers, devBrowserId, isDev, describeBrowser } from '../host/registry.js';
import { start as startFixture } from '../test/fixtures/campaign/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const RUNS = Number(arg('runs', 10));
const ANY_BROWSER = process.argv.includes('--any-browser');

// --- MCP client, same shape as tools/bench.js -------------------------------

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
          reject(new Error('timed out: ' + method));
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

/** One tool call, keeping the image block so the payload can be measured. */
async function callTool(mcp, name, args) {
  const response = await mcp.request('tools/call', { name, arguments: args });
  const content = (response.result && response.result.content) || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const image = content.find((b) => b.type === 'image') || null;
  return {
    isError: (response.result && response.result.isError) === true,
    text,
    image,
    base64Chars: image ? image.data.length : 0,
    bytes: image ? Math.round((image.data.length * 3) / 4) : 0,
    mimeType: image ? image.mimeType : null,
  };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** "screenshot 1493x840 (~1602 tokens) id: img_3" */
function readScreenshotLine(text) {
  const size = text.match(/screenshot (\d+)x(\d+)/);
  const tokens = text.match(/~(\d+) tokens/);
  const frame = text.match(/coordinate frame: (\d+x\d+)/);
  // The contract line carries evidence, which names the path the capture took.
  const path = text.match(/"path":"(\w+)"/);
  return {
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    tokens: tokens ? Number(tokens[1]) : null,
    frame: frame ? frame[1] : null,
    path: path ? path[1] : null,
  };
}

function kb(bytes) {
  return (bytes / 1024).toFixed(0) + 'KB';
}

// --- extension version, the way tools/doctor.js reads it ---------------------

async function extensionVersion(socket) {
  try {
    const link = await connect(socket);
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

// --- the cells ---------------------------------------------------------------

const PAGES = [
  { key: 'index', path: '/' },
  { key: 'big', path: '/big' },
];

const VARIANTS = [
  { key: 'png s1', args: { format: 'png' } },
  { key: 'png s0.5', args: { format: 'png', scale: 0.5 } },
  { key: 'jpeg s1', args: { format: 'jpeg' } },
  { key: 'jpeg s0.5', args: { format: 'jpeg', scale: 0.5 } },
];

async function main() {
  const browsers = await listBrowsers();
  if (!browsers.length) {
    console.log('no browser bridge is connected. Start one with: npm run browser');
    return;
  }
  const devId = devBrowserId();
  const dev = browsers.find((b) => isDev(b, devId));
  const bridge = dev || (ANY_BROWSER ? browsers[0] : null);
  if (!bridge) {
    console.log('no development browser is connected, and this bench was not run.');
    console.log('connected: ' + browsers.map((b) => describeBrowser(b)).join('; '));
    console.log('a browser on another build measures other code. Start one with: npm run browser');
    console.log('or pass --any-browser to measure whatever is connected.');
    return;
  }
  process.env.CHROME_MCP_BROWSER_ID = bridge.id;

  const version = await extensionVersion(bridge.socket);
  const fixture = await startFixture(0);
  const base = 'http://127.0.0.1:' + fixture.address().port;

  console.log('chrome-mcp screenshot bench');
  console.log('browser: ' + describeBrowser(bridge) + (dev ? ' (development)' : ' (not the development browser)'));
  console.log('extension version: ' + (version || 'unknown'));
  console.log('fixture: ' + base);
  console.log('captures per cell: ' + RUNS);
  console.log('');

  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const mcp = mcpClient(child);
  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bench-screenshot', version: '1' },
  });
  mcp.notify('notifications/initialized', {});

  const context = await callTool(mcp, 'tabs_context', { createIfEmpty: true });
  const tabId = JSON.parse(context.text).tabs[0].tabId;

  const rows = [];
  for (const page of PAGES) {
    await callTool(mcp, 'navigate', { url: base + page.path, tabId });
    for (const variant of VARIANTS) {
      const times = [];
      const sizes = [];
      let shape = null;
      let mimeType = null;
      for (let i = 0; i < RUNS; i++) {
        const started = Date.now();
        const result = await callTool(mcp, 'computer', { tabId, action: 'screenshot', ...variant.args });
        times.push(Date.now() - started);
        if (result.isError) {
          console.log('  ' + page.key + ' ' + variant.key + ': ERROR ' + result.text.slice(0, 200));
          break;
        }
        sizes.push(result.base64Chars);
        shape = readScreenshotLine(result.text);
        mimeType = result.mimeType;
      }
      if (!sizes.length) continue;
      const row = {
        page: page.key,
        variant: variant.key,
        mimeType,
        width: shape.width,
        height: shape.height,
        tokens: shape.tokens,
        frame: shape.frame,
        path: shape.path,
        medianMs: median(times),
        totalMs: times.reduce((a, b) => a + b, 0),
        times,
        medianBase64Chars: median(sizes),
        medianBytes: Math.round((median(sizes) * 3) / 4),
      };
      rows.push(row);
      console.log(
        '  ' + page.key.padEnd(6) + variant.key.padEnd(11) +
          (row.width + 'x' + row.height).padEnd(12) +
          kb(row.medianBytes).padEnd(9) +
          ('~' + row.tokens + ' tok').padEnd(12) +
          ('median ' + row.medianMs + 'ms').padEnd(16) +
          (RUNS + ' captures in ' + row.totalMs + 'ms')
      );
    }
  }

  await callTool(mcp, 'tabs_close', { tabId }).catch(() => {});
  child.kill();
  await new Promise((r) => fixture.close(r));

  console.log('');
  console.log('=== summary ===');
  console.log('');
  const col = (v, w) => String(v).padEnd(w);
  console.log(
    col('page', 8) + col('variant', 11) + col('size', 12) + col('payload', 10) + col('tokens', 9) +
      col('median ms', 12) + col('total ms', 10) + col('path', 8) + 'coordinate frame'
  );
  for (const row of rows) {
    console.log(
      col(row.page, 8) + col(row.variant, 11) + col(row.width + 'x' + row.height, 12) +
        col(kb(row.medianBytes), 10) + col('~' + row.tokens, 9) + col(row.medianMs, 12) +
        col(row.totalMs, 10) + col(row.path || '?', 8) + (row.frame || '')
    );
  }

  const jpegFull = rows.find((r) => r.page === 'index' && r.variant === 'jpeg s1');
  const pngFull = rows.find((r) => r.page === 'index' && r.variant === 'png s1');
  if (jpegFull && pngFull) {
    console.log('');
    console.log(
      'index page, JPEG against PNG at the same size: ' + kb(jpegFull.medianBytes) + ' against ' +
        kb(pngFull.medianBytes) + ', ' + (pngFull.medianBytes / jpegFull.medianBytes).toFixed(1) + 'x smaller'
    );
  }
  if (jpegFull) {
    console.log(
      '10 screenshots, JPEG at scale 1: ' + jpegFull.totalMs + ' ms total, median ' + jpegFull.medianMs +
        ' ms per capture (Phase 5 target: under 6000 ms for ten)'
    );
  }

  mkdirSync(join(ROOT, '.bench'), { recursive: true });
  const path = join(ROOT, '.bench', new Date().toISOString().slice(0, 10) + '-screenshot.jsonl');
  appendFileSync(
    path,
    JSON.stringify({ timestamp: new Date().toISOString(), extensionVersion: version, browser: bridge.id, runs: RUNS, rows }) + '\n'
  );
  console.log('');
  console.log('appended to ' + path);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
