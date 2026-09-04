#!/usr/bin/env node
// Checks every link in the chain and reports the first one that is broken.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { connect } from '../host/ipc.js';
import { listBrowsers, isLocal, isDev, devBrowserId } from '../host/registry.js';
import { TOOL_NAMES } from '../host/schemas.js';
import { extensionIdFromDer } from './gen-key.js';
import { JOURNAL_DIR, retentionDays, redactionOn, journalSize } from '../host/journal.js';
import { retryTable, CODE_NAMES } from '../host/errors.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_NAME = 'com.chromemcp.host';

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '\n         ' + detail : ''));
}

console.log('chrome-mcp doctor\n');

// 1. Extension identity: fixed by the public key in the committed manifest.
const manifestPath = join(ROOT, 'extension', 'manifest.json');
let extId = null;
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.key) extId = extensionIdFromDer(Buffer.from(manifest.key, 'base64'));
}
check('manifest carries the pinned key', Boolean(extId), extId ? 'id ' + extId : 'run: npm run keygen');

// 2. Native messaging host manifest
const hostManifestPath = join(ROOT, 'host', HOST_NAME + '.json');
const hasHostManifest = existsSync(hostManifestPath);
check('native host manifest written', hasHostManifest, hasHostManifest ? hostManifestPath : 'run: npm run install-host');

let wrapperPath = null;
if (hasHostManifest) {
  const hostManifest = JSON.parse(readFileSync(hostManifestPath, 'utf8'));
  wrapperPath = hostManifest.path;
  const wrapperExists = existsSync(wrapperPath);
  check('host wrapper exists', wrapperExists, wrapperPath);

  const originOk = hostManifest.allowed_origins?.[0] === 'chrome-extension://' + extId + '/';
  check('manifest allows this extension id', originOk, originOk ? null : 'allowed_origins does not match .keys/extension-id.txt; re-run npm run install-host');

  if (wrapperExists && process.platform === 'win32') {
    const content = readFileSync(wrapperPath, 'utf8');
    const match = content.match(/"([^"]*node\.exe)"/i);
    const nodeOk = match ? existsSync(match[1]) : false;
    check(
      'wrapper points at a real node binary',
      nodeOk,
      match ? match[1] : 'no absolute node path found; re-run npm run install-host'
    );
  }
}

// 3. Browser registration
if (process.platform === 'win32') {
  const keys = [
    ['Chrome', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME],
    ['Edge', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME],
    ['Brave', 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\' + HOST_NAME],
  ];
  let any = false;
  for (const [name, key] of keys) {
    try {
      // reg writes to stderr before exiting non-zero for a missing key, and a
      // browser that is simply not installed is not worth printing noise for.
      const out = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const value = (out.match(/REG_SZ\s+(.+)/) || [])[1]?.trim();
      const ok = value && existsSync(value);
      check(name + ' registration', ok, value);
      any = any || ok;
    } catch {
      /* not registered for this browser */
    }
  }
  if (!any) check('any browser registered', false, 'run: npm run install-host');
} else {
  const home = os.homedir();
  const dirs =
    process.platform === 'darwin'
      ? [
          join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
          join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
        ]
      : [join(home, '.config/google-chrome/NativeMessagingHosts'), join(home, '.config/chromium/NativeMessagingHosts')];
  let any = false;
  for (const dir of dirs) {
    const file = join(dir, HOST_NAME + '.json');
    if (existsSync(file)) {
      check('registered at ' + file, true);
      any = true;
    }
  }
  if (!any) check('any browser registered', false, 'run: npm run install-host');
}

// 4. Live bridge
const browsers = await listBrowsers();
check(
  'a browser is connected',
  browsers.length > 0,
  browsers.length
    ? browsers.map((b) => b.name + ' ' + b.version + ' (' + b.id + ')').join(', ')
    : 'no browser is running with the extension loaded and enabled'
);

if (browsers.length > 1) {
  console.log('         several browsers are connected, so a session must call select_browser');
}

const devId = devBrowserId();

// What each running host says it does with the journal. The host is spawned by
// Chrome, so its environment is the browser's, not this shell's.
const hostJournals = [];

for (const browser of browsers) {
  try {
    const link = await connect(browser.socket);
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      link.on('message', (message) => {
        if (message.type === 'browser_status') {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    // Which sites this profile is signed into, from the same request
    // list_connected_browsers uses. Names and presence only, never a value.
    const sessions = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      link.on('message', (message) => {
        if (message.id !== 'doctor_sessions') return;
        clearTimeout(timer);
        resolve(message.error || message.type !== 'sessions_response' ? null : (message.result && message.result.sessions) || []);
      });
      try {
        link.send({ type: 'sessions', id: 'doctor_sessions' });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
    link.end();

    if (status && status.journal) hostJournals.push({ browser, journal: status.journal });

    check(
      browser.name + ' extension is attached',
      Boolean(status && status.connected),
      status && status.connected
        ? 'extension v' + (status.extensionVersion || '?') + ', ' + status.tools.length + ' handlers, ' + TOOL_NAMES.length + ' tools advertised'
        : 'reload the extension at chrome://extensions'
    );

    const profile = browser.profile || {};
    console.log(
      '         profile ' + (profile.directory || 'unknown') +
        (profile.name ? ' "' + profile.name + '"' : '') +
        '  account ' + ((browser.account && browser.account.email) || profile.userName || 'not signed in') +
        '  label ' + (browser.label || 'none') +
        '  local ' + isLocal(browser) + '  dev ' + isDev(browser, devId)
    );
    if (profile.reason) console.log('         profile detail missing: ' + profile.reason);
    console.log(
      '         sessions ' +
        (sessions === null
          ? 'not reported (reload the extension so it picks up the cookies permission)'
          : sessions.length ? sessions.join(', ') : 'none detected')
    );
  } catch (err) {
    check(browser.name + ' extension is attached', false, err.message);
  }
}

// 5. The retry table, so what the server will and will not repeat is readable
// without opening host/errors.js.
console.log('\nRetry policy (host/errors.js)');
for (const row of retryTable()) {
  console.log('  ' + row.kind.padEnd(6) + ' attempts ' + row.attempts + ', backoff ' + row.backoffMs + 'ms');
  console.log('         tools: ' + row.tools);
  console.log('         on: ' + row.on);
}
console.log('  ' + CODE_NAMES.length + ' error codes in the catalogue: ' + CODE_NAMES.join(', '));

// The journal is written by the native host, which Chrome spawns, so
// CHROME_MCP_JOURNAL_REDACT and CHROME_MCP_JOURNAL_DAYS have to be in the
// browser's environment. Reading them here printed this shell's answer as if it
// were the host's, which was wrong whenever the two differed. Both are printed,
// each labelled with the process it came from.
const size = journalSize();
console.log('\nJournal: ' + JOURNAL_DIR + '\n  ' + size.files + ' file(s), ' + Math.round(size.bytes / 1024) + ' KB');
for (const { browser, journal } of hostJournals) {
  console.log(
    '  host for ' + browser.name + ' (' + browser.id + '): retention ' + journal.retentionDays + ' days, ' +
      'redaction ' + (journal.redact ? 'on' : 'off') + ', dir ' + journal.dir
  );
}
if (!hostJournals.length) {
  console.log(
    '  no running host reported its journal settings' +
      (browsers.length ? '; reload the extension so the host restarts on this build' : '')
  );
}
console.log(
  '  this shell: retention ' + retentionDays() + ' days (CHROME_MCP_JOURNAL_DAYS), ' +
    'redaction ' + (redactionOn() ? 'on' : 'off') + ' (CHROME_MCP_JOURNAL_REDACT). ' +
    'The host writes the journal, so its line above is the one that counts.'
);

const failed = results.filter((r) => !r.ok);
console.log('');
if (!failed.length) {
  console.log('Action journal: ' + JOURNAL_DIR + '  (npm run log)');
  console.log('All checks passed. Add the server with:');
  console.log('  claude mcp add chrome-mcp -- node "' + join(ROOT, 'host', 'mcp-server.js') + '"');
} else {
  console.log(failed.length + ' check(s) failed. Fix the first one listed above.');
  process.exitCode = 1;
}
