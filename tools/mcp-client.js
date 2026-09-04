#!/usr/bin/env node
// A stdio MCP client for driving host/mcp-server.js by hand.
//
// The MCP tools a Claude Code session already holds are bound to the server
// process that session started, which may be running older code. This spawns a
// fresh server from the working tree, so a verification pass drives the code it
// just built.
//
// Library use:
//
//   import { createClient } from './tools/mcp-client.js';
//   const client = await createClient({ browser: 'dev' });
//   const shot = await client.call('computer', { action: 'screenshot', tabId });
//   await client.close();
//
// CLI use:
//
//   node tools/mcp-client.js computer '{"action":"screenshot","tabId":123}'
//   node tools/mcp-client.js tabs_context '{}' --browser dev
//   node tools/mcp-client.js --list

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'host', 'mcp-server.js');

/**
 * Spawns an MCP server and completes the initialize handshake.
 *
 * @param {object} [options]
 * @param {string} [options.browser] value for CHROME_MCP_BROWSER, the startup default
 * @param {string} [options.clientId] value for CHROME_MCP_CLIENT_ID, so a restart resumes a session
 * @param {object} [options.env] extra environment for the server process
 * @param {string[]} [options.args] extra argv for the server process
 * @param {number} [options.timeout] per-request timeout in ms, default 180000
 * @param {boolean} [options.stderr] pipe the server's stderr to this process
 */
export async function createClient(options = {}) {
  const timeout = options.timeout ?? 180000;
  const env = { ...process.env, ...(options.env || {}) };
  let browser = options.browser;
  if (browser === 'dev') {
    // "dev" is not a registry selector, deliberately: the development browser
    // is reachable by id so a site selector never lands on it. Resolve it here
    // from the marker npm run browser writes.
    const { devBrowserId } = await import('../host/registry.js');
    const id = devBrowserId();
    if (!id) throw new Error('no development browser recorded in .browsers/dev-browser-id (run: npm run browser)');
    browser = id;
  }
  if (browser) env.CHROME_MCP_BROWSER = browser;
  if (options.clientId) env.CHROME_MCP_CLIENT_ID = options.clientId;

  const child = spawn(process.execPath, [SERVER, ...(options.args || [])], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString('utf8'));
    if (options.stderr) process.stderr.write(chunk);
  });

  let buffer = '';
  const waiters = new Map();
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    for (const [id, waiter] of waiters) {
      waiters.delete(id);
      waiter.reject(new Error('the MCP server exited (code ' + code + ', signal ' + signal + ')'));
    }
  });

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
        waiter.resolve(message);
      }
    }
  });

  let seq = 0;
  function request(method, params, perCall = {}) {
    const id = ++seq;
    const limit = perCall.timeout ?? timeout;
    return new Promise((resolvePromise, reject) => {
      if (exited) return reject(new Error('the MCP server has exited'));
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error('MCP request timed out after ' + limit + ' ms: ' + method));
      }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      waiters.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-client', version: '1' },
  });
  notify('notifications/initialized', {});

  /**
   * Calls one tool and flattens the reply.
   *
   * Returns `{ok, isError, text, images, content, raw}`. `text` is every text
   * block joined with a blank line, which is what a reader sees. `images` holds
   * the base64 blocks with their sizes, so a screenshot can be checked without
   * printing a megabyte of base64.
   */
  async function call(tool, args = {}, perCall = {}) {
    const started = Date.now();
    const message = await request('tools/call', { name: tool, arguments: args }, perCall);
    const wall = Date.now() - started;
    if (message.error) {
      return { ok: false, isError: true, text: JSON.stringify(message.error), images: [], content: [], raw: message, wall };
    }
    const content = (message.result && message.result.content) || [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    const images = content
      .filter((b) => b.type === 'image')
      .map((b) => ({ mimeType: b.mimeType, bytes: b.data ? Math.round((b.data.length * 3) / 4) : 0 }));
    const isError = Boolean(message.result && message.result.isError);
    return { ok: !isError, isError, text, images, content, raw: message, wall };
  }

  async function listTools() {
    const message = await request('tools/list', {});
    return (message.result && message.result.tools) || [];
  }

  async function close() {
    if (exited) return exited;
    const done = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => child.kill(), 2000);
    const result = await done;
    clearTimeout(timer);
    return result;
  }

  return {
    init,
    call,
    request,
    notify,
    listTools,
    close,
    child,
    pid: child.pid,
    stderr: () => stderrChunks.join(''),
    kill: (signal) => child.kill(signal),
  };
}

// --- CLI ---------------------------------------------------------------------

function usage() {
  console.error('usage: node tools/mcp-client.js <tool> \'<json args>\' [--browser <id>] [--raw] [--timeout <ms>]');
  console.error('       node tools/mcp-client.js --list');
}

async function main(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--raw') flags.raw = true;
    else if (arg === '--list') flags.list = true;
    else if (arg === '--stderr') flags.stderr = true;
    else if (arg === '--browser') flags.browser = argv[++i];
    else if (arg === '--client-id') flags.clientId = argv[++i];
    else if (arg === '--timeout') flags.timeout = Number(argv[++i]);
    else positional.push(arg);
  }

  if (!flags.list && positional.length === 0) {
    usage();
    process.exit(2);
  }

  let args = {};
  if (positional[1]) {
    try {
      args = JSON.parse(positional[1]);
    } catch (err) {
      console.error('the second argument must be JSON: ' + err.message);
      process.exit(2);
    }
  }

  const client = await createClient({
    browser: flags.browser,
    clientId: flags.clientId,
    timeout: flags.timeout,
    stderr: flags.stderr,
  });

  try {
    if (flags.list) {
      const tools = await client.listTools();
      for (const tool of tools) console.log(tool.name);
      return;
    }
    const result = await client.call(positional[0], args);
    if (flags.raw) {
      console.log(JSON.stringify(result.raw, null, 2));
    } else {
      console.log(result.text);
      for (const image of result.images) console.log('[image ' + image.mimeType + ', ' + image.bytes + ' bytes]');
      console.log('[wall ' + result.wall + ' ms' + (result.isError ? ', isError' : '') + ']');
    }
    if (result.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
