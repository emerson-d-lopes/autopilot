// The manifest is what Chrome loads first, and a path or permission typo in it
// fails only at load time, in the browser, with a one-line error. These checks
// catch that without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Permissions Chrome accepts for a Manifest V3 extension. Anything outside the
// list is rejected at load time with "Permission 'x' is unknown".
const KNOWN_PERMISSIONS = new Set([
  'activeTab',
  'alarms',
  'background',
  'bookmarks',
  'browsingData',
  'clipboardRead',
  'clipboardWrite',
  'contentSettings',
  'contextMenus',
  'cookies',
  'debugger',
  'declarativeContent',
  'declarativeNetRequest',
  'declarativeNetRequestFeedback',
  'declarativeNetRequestWithHostAccess',
  'desktopCapture',
  'downloads',
  'favicon',
  'fontSettings',
  'gcm',
  'geolocation',
  'history',
  'identity',
  'identity.email',
  'idle',
  'management',
  'nativeMessaging',
  'notifications',
  'offscreen',
  'pageCapture',
  'power',
  'printing',
  'printingMetrics',
  'privacy',
  'proxy',
  'readingList',
  'scripting',
  'search',
  'sessions',
  'sidePanel',
  'storage',
  'system.cpu',
  'system.display',
  'system.memory',
  'system.storage',
  'tabCapture',
  'tabGroups',
  'tabs',
  'topSites',
  'tts',
  'ttsEngine',
  'unlimitedStorage',
  'userScripts',
  'webNavigation',
  'webRequest',
  'webRequestBlocking',
  'windows',
]);

test('manifest is version 3 and carries the same version as package.json', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
});

test('every file the manifest names exists', () => {
  const files = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
    manifest.options_ui.page,
  ];
  for (const file of files) {
    assert.ok(existsSync(join(EXT, file)), file + ' is named in the manifest but missing');
  }
});

test('the service worker is a module, since it uses import', () => {
  assert.equal(manifest.background.type, 'module');
  const source = readFileSync(join(EXT, manifest.background.service_worker), 'utf8');
  assert.match(source, /^import /m);
});

test('every permission is one Chrome knows', () => {
  for (const permission of manifest.permissions) {
    assert.ok(KNOWN_PERMISSIONS.has(permission), 'unknown permission ' + permission);
  }
});

test('the extension id is pinned by a committed public key', () => {
  assert.match(manifest.key, /^[A-Za-z0-9+/]+=*$/);
  const der = Buffer.from(manifest.key, 'base64');
  assert.ok(der.length > 200, 'a 2048-bit RSA public key in DER is about 294 bytes, got ' + der.length);
});

test('content scripts run at document_start in the top frame only', () => {
  for (const cs of manifest.content_scripts) {
    assert.equal(cs.run_at, 'document_start');
    assert.equal(cs.all_frames, false);
  }
});

test('the popup and options pages reference scripts that exist', () => {
  for (const page of [manifest.action.default_popup, manifest.options_ui.page]) {
    const html = readFileSync(join(EXT, page), 'utf8');
    const dir = dirname(join(EXT, page));
    for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      assert.ok(existsSync(join(dir, src)), page + ' references ' + src + ' which is missing');
    }
  }
});
