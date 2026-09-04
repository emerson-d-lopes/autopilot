#!/usr/bin/env node
// Measures what a page sees of the pointer and the keyboard (D3, D4).
//
// The campaign measured two things on the local probe and wrote them into
// evidence/D-bot-detection.md section 6: per-key typing settled into a very
// regular 62 to 64 ms band, and no mouse path was produced at all, only a
// straight jump from one click target to the next. This script re-measures both
// from inside the page, so the jittered cadence and the interpolated path can
// be checked rather than assumed.
//
// It installs its own keydown and mousemove listeners on the campaign fixture,
// drives a click, a per-key type and a second click across the page, then reads
// the recorded timings and coordinates back and prints them.
//
// Usage:
//   node tools/probe-detect.js                 drive the local campaign fixture
//   node tools/probe-detect.js --cadence 120   type at a different mean
//   node tools/probe-detect.js --url <page>    use a page that is already served
//
// The MCP client comes from tools/mcp-client.js when that file exists, and
// otherwise from the fallback in this file, which speaks the same JSON-RPC to
// the same host/mcp-server.js. Both expose one function: call(tool, args).

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { anyBridge } from '../host/registry.js';
import { start as startFixture } from '../test/fixtures/campaign/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPED_TEXT = 'the quick brown fox jumps over';

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * Normalizes whatever call() hands back into text.
 *
 * The fallback returns the joined text blocks. A different implementation may
 * return the MCP content array or a wrapper, so all three are accepted rather
 * than making the probe depend on a shape it does not own.
 */
export function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  const content = value.content || (value.result && value.result.content);
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  return JSON.stringify(value);
}

/** The first JSON object or array in a tool's reply. */
export function asJson(value) {
  const text = asText(value);
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  for (let end = text.length; end > start; end--) {
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      /* the reply carries prose after the body, so the tail is trimmed back */
    }
  }
  return null;
}

/** Spawns host/mcp-server.js and speaks JSON-RPC to it over stdio. */
function fallbackClient() {
  const child = spawn(process.execPath, [join(ROOT, 'host', 'mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

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
  const request = (method, params) => {
    const id = ++seq;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error('timed out: ' + method + ' ' + JSON.stringify(params).slice(0, 120)));
      }, 120000);
      if (typeof timer.unref === 'function') timer.unref();
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  };

  return {
    source: 'fallback client in tools/probe-detect.js',
    async open() {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'probe-detect', version: '1' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    },
    async call(tool, args) {
      const response = await request('tools/call', { name: tool, arguments: args });
      const result = response.result || {};
      const text = ((result.content || []).filter((b) => b.type === 'text').map((b) => b.text)).join('\n');
      if (result.isError) throw new Error(tool + ' failed: ' + text.split('\n')[0]);
      return text;
    },
    close() {
      child.kill();
    },
  };
}

/** tools/mcp-client.js when it is there, the fallback when it is not. */
async function loadClient() {
  try {
    const mod = await import('./mcp-client.js');
    const target = typeof mod.call === 'function' ? mod : mod.default;
    if (target && typeof target.call === 'function') {
      return {
        source: 'tools/mcp-client.js',
        open: target.open ? () => target.open() : async () => {},
        call: (tool, args) => target.call(tool, args),
        close: target.close ? () => target.close() : () => {},
      };
    }
    console.log('tools/mcp-client.js does not export call(tool, args), using the fallback client');
  } catch (err) {
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(err && err.message))) throw err;
  }
  return fallbackClient();
}

// ---------------------------------------------------------------------------
// The page side
// ---------------------------------------------------------------------------

// Records the moment of every keydown and the position of every mousemove the
// page receives, in capture phase so nothing downstream can swallow them.
const INSTALL = `
  (() => {
    if (window.__probeDetect) window.__probeDetect.off();
    const keys = [];
    const moves = [];
    const onKey = (e) => keys.push({ key: e.key, at: performance.now(), trusted: e.isTrusted });
    const onMove = (e) => moves.push({
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      at: Math.round(performance.now()),
      trusted: e.isTrusted,
    });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousemove', onMove, true);
    window.__probeDetect = {
      keys,
      moves,
      mark: 0,
      off: () => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousemove', onMove, true);
      },
    };
    return 'installed';
  })()
`;

const READ = `
  JSON.stringify({
    keys: window.__probeDetect.keys.map((k) => k.at),
    trustedKeys: window.__probeDetect.keys.every((k) => k.trusted),
    moves: window.__probeDetect.moves.slice(window.__probeDetect.mark),
  })
`;

const MARK = 'window.__probeDetect.mark = window.__probeDetect.moves.length';

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function stats(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    sd,
    cv: mean ? sd / mean : 0,
  };
}

const round = (n) => Math.round(n * 10) / 10;

function printCadence(times, cadence) {
  console.log('');
  console.log('D3  typing cadence');
  console.log('    text: ' + JSON.stringify(TYPED_TEXT) + ' (' + TYPED_TEXT.length + ' characters)');
  console.log('    requested mean: ' + (cadence === undefined ? '60 (default)' : cadence) + ' ms');

  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(round(times[i] - times[i - 1]));
  if (!intervals.length) {
    console.log('    no keydown events were recorded, so nothing was measured');
    return;
  }

  console.log('    intervals: ' + intervals.join(', '));
  const s = stats(intervals);
  console.log(
    '    n=' + s.n + '  min=' + round(s.min) + '  max=' + round(s.max) +
      '  mean=' + round(s.mean) + '  sd=' + round(s.sd) + '  cv=' + round(s.cv * 100) + '%'
  );
  console.log('    the campaign measured 0.1.7 at a 62 to 64 ms band, a cv of about 1 percent');
}

function printPath(moves, target) {
  console.log('');
  console.log('D4  mouse path into a click');
  if (!moves.length) {
    console.log('    no mousemove events were recorded, so nothing was measured');
    return;
  }
  console.log('    target: ' + target);
  console.log('    points: ' + moves.length);
  const first = moves[0];
  for (const move of moves) {
    const distance = Math.round(Math.hypot(move.x - moves[moves.length - 1].x, move.y - moves[moves.length - 1].y));
    console.log(
      '      (' + move.x + ', ' + move.y + ')  +' + (move.at - first.at) + ' ms  ' +
        distance + ' px from the last point'
    );
  }
  console.log('    the campaign measured 0.1.7 at 2 samples, a straight jump with no path');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function argValue(name) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The ref of the first line of a read_page tree matching a pattern. */
export function refFor(text, pattern) {
  for (const line of text.split('\n')) {
    if (!pattern.test(line)) continue;
    const match = line.match(/\[(ref_\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

async function main() {
  const bridge = await anyBridge();
  if (!bridge) {
    console.log('probe-detect');
    console.log('');
    console.log('no browser bridge is connected (run: npm run browser, or open Chrome with the extension loaded)');
    console.log('this probe reads what a real page saw, so it has nothing to measure without one');
    return;
  }
  process.env.CHROME_MCP_BROWSER_ID = bridge.id;

  const cadenceArg = argValue('cadence');
  const cadence = cadenceArg === undefined ? undefined : Number(cadenceArg);
  let fixture = null;
  let url = argValue('url');
  if (!url) {
    fixture = await startFixture(0);
    url = 'http://127.0.0.1:' + fixture.address().port + '/index.html';
  }

  const client = await loadClient();
  console.log('probe-detect');
  console.log('client: ' + client.source);
  console.log('page:   ' + url);
  await client.open();

  try {
    const context = asJson(await client.call('tabs_context', { createIfEmpty: true }));
    const tabId = context.tabs[0].tabId;
    await client.call('navigate', { url, tabId });
    await client.call('javascript', { tabId, code: INSTALL });

    const tree = asText(await client.call('read_page', { tabId, filter: 'interactive' }));
    const nameRef = refFor(tree, /"Name"/i);
    const submitRef = refFor(tree, /button "Submit"/i);
    if (!nameRef || !submitRef) throw new Error('could not find the Name field and the Submit button on the page');

    // The first click has no previous pointer position to travel from, so it is
    // the one that establishes it. Typing follows, then a second click far
    // enough away for a path to be worth drawing.
    await client.call('computer', { tabId, action: 'left_click', ref: nameRef });
    await client.call('computer', {
      tabId,
      action: 'type',
      text: TYPED_TEXT,
      perKey: true,
      ...(cadence === undefined ? {} : { cadence }),
    });

    // Only the moves belonging to the second click are of interest, so the ones
    // recorded so far are marked off first.
    await client.call('javascript', { tabId, code: MARK });
    await client.call('computer', { tabId, action: 'left_click', ref: submitRef });

    const recorded = asJson(await client.call('javascript', { tabId, code: READ }));
    if (!recorded) throw new Error('the page returned no recording');

    printCadence(recorded.keys || [], cadence);
    printPath(recorded.moves || [], submitRef);
    console.log('');
    console.log('every keydown isTrusted: ' + recorded.trustedKeys);
  } finally {
    client.close();
    if (fixture) fixture.close();
  }
}

// Importable for a unit check without driving anything: main only runs when
// this file is the entry point.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  main().catch((err) => {
    console.error(String((err && err.stack) || err));
    process.exit(1);
  });
}
