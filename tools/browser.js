#!/usr/bin/env node
// Launches an isolated browser with the extension loaded, for development and
// for the live test suite.
//
// Chrome 137+ ignores --load-extension, so a stock Chrome install cannot load an
// unpacked extension from the command line. Chrome for Testing still honours it,
// and runs against its own profile, so this never touches the user's browser.
// Install it with: npx @puppeteer/browsers install chrome@stable --path .browsers

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const INTERFERER = join(ROOT, 'test', 'fixtures', 'interferer');
const PROFILE = join(ROOT, '.browsers', 'profile');
const CACHE = join(ROOT, '.browsers', 'chrome');

function findChromeForTesting() {
  if (!existsSync(CACHE)) return null;
  for (const entry of readdirSync(CACHE)) {
    for (const candidate of [
      join(CACHE, entry, 'chrome-win64', 'chrome.exe'),
      join(CACHE, entry, 'chrome-linux64', 'chrome'),
      join(CACHE, entry, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(CACHE, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Several browsers can be connected at once: each gets its own host, pipe and
// registry entry. A session with more than one connected picks with
// select_browser, so launching another is fine, just worth saying out loud.
const { anyBridge, listBrowsers, DEV_BROWSER_MARKER } = await import('../host/registry.js');
import { writeFileSync } from 'node:fs';
const existing = await anyBridge();
if (existing) {
  console.log('note: ' + existing.name + ' (' + existing.id + ') is already connected.');
  console.log('      A session will need select_browser to choose between them.');
}

const binary = findChromeForTesting();
if (!binary) {
  console.error('Chrome for Testing is not installed. Run:');
  console.error('  npx @puppeteer/browsers install chrome@stable --path "' + join(ROOT, '.browsers') + '"');
  process.exit(1);
}

mkdirSync(PROFILE, { recursive: true });

// Chrome keeps a compiled module graph for extension service workers and reuses
// it across browser restarts, so edits to background.js or anything it imports
// do not take effect even on a cold start. Dropping the cache is the only
// reliable way to guarantee a launch runs the code currently on disk.
for (const dir of ['Service Worker', 'Code Cache', 'Extension Scripts']) {
  try {
    rmSync(join(PROFILE, 'Default', dir), { recursive: true, force: true });
  } catch {
    /* first run, or the browser still holds it */
  }
}

// --interferer loads test/fixtures/interferer alongside the extension. It mounts
// a chrome-extension:// iframe into every page, which is what makes
// chrome.debugger.attach refuse, so the recovery ladder can be exercised without
// x.com or a password manager.
const withInterferer = process.argv.includes('--interferer');
if (withInterferer && !existsSync(INTERFERER)) {
  console.error('--interferer needs ' + INTERFERER + ', which is missing.');
  process.exit(1);
}
const loaded = withInterferer ? EXTENSION + ',' + INTERFERER : EXTENSION;

const args = [
  '--user-data-dir=' + PROFILE,
  '--load-extension=' + loaded,
  '--disable-extensions-except=' + loaded,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  // Without this, Chrome marks a fully covered window as occluded, the tab
  // reports visibilityState hidden, and the renderer stops processing input
  // altogether. Tests then fail purely because another window is in front.
  '--disable-features=CalculateNativeWinOcclusion',
  'about:blank',
];
// The DevTools port is always on for this profile. It is a throwaway automation
// browser, and the test suite needs it to seed extension storage, which only the
// extension itself can write.
args.unshift('--remote-debugging-port=' + (process.env.AUTOPILOT_DEVTOOLS_PORT || '9333'));
// Chrome's own log, for the times the browser exits with nothing driving it.
args.unshift('--enable-logging', '--v=0', '--log-file=' + join(ROOT, '.browsers', 'chrome.log'));

console.log('launching ' + binary);
console.log('extension  ' + EXTENSION);
if (withInterferer) console.log('interferer ' + INTERFERER);
console.log('profile    ' + PROFILE);

const before = new Set((await listBrowsers()).map((b) => b.id));
const child = spawn(binary, args, { detached: process.argv.includes('--detach'), stdio: 'ignore' });

// Records which registry entry belongs to this browser, so the test suite can
// prefer it over any other Chrome that happens to be connected.
async function recordDevBrowser() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const fresh = (await listBrowsers()).find((b) => !before.has(b.id));
    if (fresh) {
      writeFileSync(DEV_BROWSER_MARKER, fresh.id);
      console.log('connected as ' + fresh.id + ' (recorded in ' + DEV_BROWSER_MARKER + ')');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('note: the extension did not connect within 20s. Run npm run doctor.');
}

if (process.argv.includes('--detach')) {
  child.unref();
  console.log('running detached, pid ' + child.pid);
  await recordDevBrowser();
} else {
  recordDevBrowser();
  console.log('running in the foreground, ctrl-c to stop');
  child.on('exit', (code) => process.exit(code ?? 0));
}
