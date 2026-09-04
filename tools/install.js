#!/usr/bin/env node
// Registers the native messaging host with every Chromium browser found.
//
// Chrome spawns the host from the browser process, not from a shell, so it
// inherits the system PATH. fnm puts node on a per-shell shim path, which means
// a bare "node" in the wrapper resolves in a terminal and fails under Chrome.
// The absolute interpreter path is baked in at install time instead.

import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromDer } from './gen-key.js';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_NAME = 'com.autopilot.host';
/** The id used before the project was renamed. Registrations under it are removed. */
const LEGACY_HOST_NAME = 'com.chromemcp.host';
const UNINSTALL = process.argv.includes('--uninstall');

/**
 * The extension id is fixed by the public key committed in the manifest, so a
 * fresh clone has it without generating anything. A private key under .keys
 * only exists for whoever re-keys the extension with `npm run keygen`.
 */
function extensionId() {
  const manifestPath = join(ROOT, 'extension', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.key) return extensionIdFromDer(Buffer.from(manifest.key, 'base64'));
  const idPath = join(ROOT, '.keys', 'extension-id.txt');
  if (existsSync(idPath)) return readFileSync(idPath, 'utf8').trim();
  console.error('The manifest carries no key and no id was generated. Run `npm run keygen`.');
  process.exit(1);
}

/** Browser profile roots that read native messaging host manifests. */
function browserTargets() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      { name: 'Chrome', dir: join(local, 'Google', 'Chrome', 'User Data'), regRoot: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' },
      { name: 'Edge', dir: join(local, 'Microsoft', 'Edge', 'User Data'), regRoot: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' },
      { name: 'Brave', dir: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), regRoot: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\' },
      { name: 'Vivaldi', dir: join(local, 'Vivaldi', 'User Data'), regRoot: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\' },
    ];
  }
  if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      { name: 'Chrome', dir: join(support, 'Google', 'Chrome'), manifestDir: join(support, 'Google', 'Chrome', 'NativeMessagingHosts') },
      { name: 'Edge', dir: join(support, 'Microsoft Edge'), manifestDir: join(support, 'Microsoft Edge', 'NativeMessagingHosts') },
      { name: 'Brave', dir: join(support, 'BraveSoftware', 'Brave-Browser'), manifestDir: join(support, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
    ];
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    { name: 'Chrome', dir: join(config, 'google-chrome'), manifestDir: join(config, 'google-chrome', 'NativeMessagingHosts') },
    { name: 'Chromium', dir: join(config, 'chromium'), manifestDir: join(config, 'chromium', 'NativeMessagingHosts') },
    { name: 'Edge', dir: join(config, 'microsoft-edge'), manifestDir: join(config, 'microsoft-edge', 'NativeMessagingHosts') },
    { name: 'Brave', dir: join(config, 'BraveSoftware', 'Brave-Browser'), manifestDir: join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
  ];
}

/**
 * Resolves the durable path to this node binary.
 *
 * Version managers hand out a per-shell shim: fnm's process.execPath points
 * into AppData\Local\fnm_multishells\<pid>_<timestamp>\, a directory that is
 * removed when the shell exits. Baking that into the wrapper produces a host
 * that works until the terminal closes. realpath resolves it to the versioned
 * installation directory, which survives.
 */
function resolveNodeBinary() {
  let real;
  try {
    real = realpathSync(process.execPath);
  } catch {
    real = process.execPath;
  }

  const ephemeral = /fnm_multishells|[\\/]\.nvm[\\/]alias|nodenv[\\/]shims|volta[\\/]bin/i;
  if (ephemeral.test(real)) {
    console.warn(
      'Warning: node resolved to a path that may not outlive this shell:\n  ' + real +
        '\nThe native host may stop working when this terminal closes. ' +
        'Install a system-wide node, or re-run npm run install-host from a shell using one.'
    );
  }
  return real;
}

function writeWrapper() {
  const nodePath = resolveNodeBinary();
  const hostScript = join(ROOT, 'host', 'native-host.js');

  if (process.platform === 'win32') {
    const batPath = join(ROOT, 'host', 'native-host.bat');
    // @echo off is required: anything echoed to stdout corrupts the native
    // messaging frame stream and Chrome drops the connection.
    const bat = '@echo off\r\n"' + nodePath + '" "' + hostScript + '" %*\r\n';
    writeFileSync(batPath, bat);
    return batPath;
  }

  const shPath = join(ROOT, 'host', 'native-host.sh');
  const sh = '#!/bin/sh\nexec "' + nodePath + '" "' + hostScript + '" "$@"\n';
  writeFileSync(shPath, sh);
  chmodSync(shPath, 0o755);
  return shPath;
}

function hostManifest(wrapperPath, extId) {
  return {
    name: HOST_NAME,
    description: 'Autopilot bridge',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: ['chrome-extension://' + extId + '/'],
  };
}

function regAdd(key, value) {
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
}

function regDelete(key) {
  try {
    execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the registrations made under the pre-rename host id.
 *
 * A browser that still carries com.chromemcp.host would keep spawning the old
 * wrapper for an extension that no longer asks for it, so the entry is cleared
 * whether installing or uninstalling.
 *
 * @returns {string[]} what was removed, for the install output
 */
function removeLegacyRegistrations() {
  const removed = [];
  for (const target of browserTargets()) {
    if (process.platform === 'win32') {
      if (regDelete(target.regRoot + LEGACY_HOST_NAME)) removed.push(target.name + ' registry entry');
    } else if (target.manifestDir) {
      const file = join(target.manifestDir, LEGACY_HOST_NAME + '.json');
      if (existsSync(file)) {
        try {
          rmSync(file);
          removed.push(file);
        } catch {
          /* left in place, and the new id is registered regardless */
        }
      }
    }
  }
  const stale = join(ROOT, 'host', LEGACY_HOST_NAME + '.json');
  if (existsSync(stale)) {
    try {
      rmSync(stale);
      removed.push(stale);
    } catch {
      /* left in place */
    }
  }
  return removed;
}

function main() {
  const extId = extensionId();
  const manifestPath = join(ROOT, 'host', HOST_NAME + '.json');

  const legacy = removeLegacyRegistrations();

  if (UNINSTALL) {
    let removed = legacy.length;
    for (const entry of legacy) console.log('removed the old com.chromemcp.host registration: ' + entry);
    for (const target of browserTargets()) {
      if (process.platform === 'win32') {
        if (regDelete(target.regRoot + HOST_NAME)) {
          console.log('removed ' + target.name + ' registry entry');
          removed++;
        }
      } else if (target.manifestDir) {
        const file = join(target.manifestDir, HOST_NAME + '.json');
        if (existsSync(file)) {
          writeFileSync(file, '');
          console.log('cleared ' + file);
          removed++;
        }
      }
    }
    console.log(removed ? 'Uninstalled. Restart the browser.' : 'Nothing to uninstall.');
    return;
  }

  const wrapper = writeWrapper();
  const manifest = hostManifest(wrapper, extId);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log('extension id:  ' + extId);
  console.log('node:          ' + resolveNodeBinary());
  console.log('wrapper:       ' + wrapper);
  console.log('host manifest: ' + manifestPath);
  console.log('');

  if (legacy.length) {
    console.log('The project was renamed from chrome-mcp to Autopilot, so the old');
    console.log('com.chromemcp.host registration was removed:');
    for (const entry of legacy) console.log('  ' + entry);
    console.log('');
  }

  let installed = 0;
  for (const target of browserTargets()) {
    if (!existsSync(target.dir)) continue;
    try {
      if (process.platform === 'win32') {
        regAdd(target.regRoot + HOST_NAME, manifestPath);
      } else {
        mkdirSync(target.manifestDir, { recursive: true });
        writeFileSync(join(target.manifestDir, HOST_NAME + '.json'), JSON.stringify(manifest, null, 2) + '\n');
      }
      console.log('registered with ' + target.name);
      installed++;
    } catch (err) {
      console.error('failed for ' + target.name + ': ' + err.message);
    }
  }

  if (!installed) {
    console.error('No Chromium browser profile was found. Is Chrome installed for this user?');
    process.exit(1);
  }

  console.log('');
  console.log('Next:');
  console.log('  1. Load ' + join(ROOT, 'extension') + ' at chrome://extensions with Developer mode on.');
  console.log('  2. Restart Chrome so it reads the host registration.');
  console.log('  3. Add the MCP server:');
  console.log('     claude mcp add autopilot -- node "' + join(ROOT, 'host', 'mcp-server.js') + '"');
}

main();
