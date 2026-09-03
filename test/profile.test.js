// Profile detection: the process-tree walk, the command-line parse, and the
// Local State read. Every case runs against a fake tree and a fake Local State,
// so the suite says the same thing on a machine with no Chrome installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  tokenize,
  parseBrowserArgs,
  browserFromExecutable,
  defaultUserDataDir,
  readLocalState,
  walkToBrowser,
  detectProfile,
  describeProfile,
  processTree,
} from '../host/profile.js';

// A Windows chain the way it really is: the browser starts the wrapper batch
// file through cmd.exe, which starts node, which is the host.
function windowsTree({ profileArg = '--profile-directory="Profile 2"', userDataArg = '' } = {}) {
  return new Map([
    [900, { pid: 900, ppid: 1, name: 'explorer.exe', commandLine: 'explorer.exe' }],
    [
      1000,
      {
        pid: 1000,
        ppid: 900,
        name: 'chrome.exe',
        commandLine:
          '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' + profileArg + ' ' + userDataArg + ' --flag-switches-begin',
      },
    ],
    [1100, { pid: 1100, ppid: 1000, name: 'cmd.exe', commandLine: 'C:\\WINDOWS\\system32\\cmd.exe /c ""C:\\mcp\\host.cmd""' }],
    [1200, { pid: 1200, ppid: 1100, name: 'node.exe', commandLine: '"C:\\node\\node.exe" "C:\\mcp\\host\\native-host.js"' }],
  ]);
}

test('tokenize keeps a quoted path with spaces in one token', () => {
  const tokens = tokenize('"C:\\Program Files\\Google\\Chrome\\chrome.exe" --profile-directory="Profile 2" --x');
  assert.equal(tokens[0], 'C:\\Program Files\\Google\\Chrome\\chrome.exe');
  assert.equal(tokens[1], '--profile-directory=Profile 2');
  assert.equal(tokens[2], '--x');
});

test('parseBrowserArgs reads both flags in either form', () => {
  const equals = parseBrowserArgs('chrome.exe --profile-directory=Profile 1 --user-data-dir=D:\\data');
  assert.equal(equals.profileDirectory, 'Profile 1');
  assert.equal(equals.userDataDir, 'D:\\data');

  const spaced = parseBrowserArgs('chrome.exe --profile-directory "Profile 3" --user-data-dir "D:\\other data"');
  assert.equal(spaced.profileDirectory, 'Profile 3');
  assert.equal(spaced.userDataDir, 'D:\\other data');
});

test('parseBrowserArgs reports nulls when the flags are absent', () => {
  const parsed = parseBrowserArgs('"C:\\chrome.exe" --no-first-run');
  assert.equal(parsed.profileDirectory, null);
  assert.equal(parsed.userDataDir, null);
  assert.equal(parsed.executable, 'C:\\chrome.exe');
});

test('browserFromExecutable names each browser and rejects helper processes', () => {
  assert.equal(browserFromExecutable('C:\\x\\chrome.exe'), 'Chrome');
  assert.equal(browserFromExecutable('C:\\x\\msedge.exe'), 'Edge');
  assert.equal(browserFromExecutable('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'), 'Brave');
  assert.equal(browserFromExecutable('/usr/bin/vivaldi'), 'Vivaldi');
  assert.equal(browserFromExecutable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper'), null);
  assert.equal(browserFromExecutable('node.exe'), null);
  assert.equal(browserFromExecutable(''), null);
});

test('defaultUserDataDir matches the table tools/install.js registers against', () => {
  assert.equal(
    defaultUserDataDir('Chrome', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } }),
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data'
  );
  assert.equal(
    defaultUserDataDir('Edge', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } }),
    'C:\\L\\Microsoft\\Edge\\User Data'
  );
  assert.equal(
    defaultUserDataDir('Chrome', { platform: 'darwin', env: {}, home: '/Users/me' }),
    '/Users/me/Library/Application Support/Google/Chrome'
  );
  assert.equal(
    defaultUserDataDir('Chrome', { platform: 'linux', env: {}, home: '/home/me' }),
    '/home/me/.config/google-chrome'
  );
  assert.equal(
    defaultUserDataDir('Brave', { platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/me' }),
    '/cfg/BraveSoftware/Brave-Browser'
  );
  assert.equal(defaultUserDataDir('Firefox', { platform: 'linux', env: {} }), null);
});

test('walkToBrowser follows node through the cmd wrapper to chrome', () => {
  const found = walkToBrowser(1200, windowsTree());
  assert.equal(found.pid, 1000);
  assert.equal(found.browser, 'Chrome');
});

test('walkToBrowser returns null when no browser is above the process', () => {
  const orphan = new Map([
    [10, { pid: 10, ppid: 1, name: 'node.exe', commandLine: 'node host.js' }],
    [1, { pid: 1, ppid: 0, name: 'init', commandLine: 'init' }],
  ]);
  assert.equal(walkToBrowser(10, orphan), null);
  assert.equal(walkToBrowser(999, orphan), null);
});

test('walkToBrowser survives a cycle in a stale process table', () => {
  const cycle = new Map([
    [1, { pid: 1, ppid: 2, name: 'a', commandLine: 'a' }],
    [2, { pid: 2, ppid: 1, name: 'b', commandLine: 'b' }],
  ]);
  assert.equal(walkToBrowser(1, cycle), null);
});

// A real Local State file, written to disk, so the JSON path and the shape of
// info_cache are both exercised rather than mocked away.
function withLocalState(body, run) {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-profile-'));
  try {
    writeFileSync(join(dir, 'Local State'), JSON.stringify(body));
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LOCAL_STATE = {
  profile: {
    info_cache: {
      Default: { name: 'Personal', user_name: 'me@gmail.com', gaia_name: 'Me Myself' },
      'Profile 2': { name: 'Work', user_name: 'work@example.com', gaia_name: 'Work Account' },
      'Profile 3': { name: 'Guest' },
    },
  },
};

test('readLocalState returns the name, account and gaia name for one directory', () => {
  withLocalState(LOCAL_STATE, (dir) => {
    const state = readLocalState(dir, 'Profile 2', { platform: process.platform });
    assert.equal(state.name, 'Work');
    assert.equal(state.userName, 'work@example.com');
    assert.equal(state.gaiaName, 'Work Account');
    assert.equal(state.reason, null);
  });
});

test('readLocalState reports nulls for a profile that was never signed in', () => {
  withLocalState(LOCAL_STATE, (dir) => {
    const state = readLocalState(dir, 'Profile 3', { platform: process.platform });
    assert.equal(state.name, 'Guest');
    assert.equal(state.userName, null);
    assert.equal(state.gaiaName, null);
  });
});

test('readLocalState gives a reason rather than throwing on a missing file', () => {
  const state = readLocalState(join(tmpdir(), 'chrome-mcp-does-not-exist-' + Date.now()), 'Default', {
    platform: process.platform,
  });
  assert.equal(state.name, null);
  assert.match(state.reason, /could not read/);
});

test('readLocalState gives a reason for an unknown profile directory', () => {
  withLocalState(LOCAL_STATE, (dir) => {
    const state = readLocalState(dir, 'Profile 9', { platform: process.platform });
    assert.match(state.reason, /no profile\.info_cache entry for "Profile 9"/);
  });
});

test('readLocalState gives a reason for malformed json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-profile-'));
  try {
    writeFileSync(join(dir, 'Local State'), '{not json');
    const state = readLocalState(dir, 'Default', { platform: process.platform });
    assert.equal(state.name, null);
    assert.match(state.reason, /could not read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectProfile joins the tree walk, the flags and Local State', async () => {
  await withLocalState(LOCAL_STATE, async (dir) => {
    const profile = await detectProfile({
      pid: 1200,
      platform: process.platform,
      tree: windowsTree({ userDataArg: '--user-data-dir="' + dir + '"' }),
      env: {},
    });
    assert.equal(profile.browser, 'Chrome');
    assert.equal(profile.browserPid, 1000);
    assert.equal(profile.directory, 'Profile 2');
    assert.equal(profile.userDataDir, dir);
    assert.equal(profile.name, 'Work');
    assert.equal(profile.userName, 'work@example.com');
    assert.equal(profile.gaiaName, 'Work Account');
    assert.equal(profile.reason, null);
  });
});

test('detectProfile defaults the directory to Default', async () => {
  await withLocalState(LOCAL_STATE, async (dir) => {
    const profile = await detectProfile({
      pid: 1200,
      platform: process.platform,
      tree: windowsTree({ profileArg: '', userDataArg: '--user-data-dir="' + dir + '"' }),
      env: {},
    });
    assert.equal(profile.directory, 'Default');
    assert.equal(profile.name, 'Personal');
  });
});

test('detectProfile falls back to the platform default user data dir', async () => {
  const profile = await detectProfile({
    pid: 1200,
    platform: 'win32',
    tree: windowsTree(),
    env: { LOCALAPPDATA: 'C:\\L' },
    readFile: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(profile.userDataDir, 'C:\\L\\Google\\Chrome\\User Data');
  assert.equal(profile.directory, 'Profile 2');
  assert.match(profile.reason, /could not read/);
});

test('detectProfile never throws when no browser is above the host', async () => {
  const profile = await detectProfile({
    pid: 5,
    platform: process.platform,
    tree: new Map([[5, { pid: 5, ppid: 0, name: 'node', commandLine: 'node x.js' }]]),
    env: {},
  });
  assert.equal(profile.browser, null);
  assert.equal(profile.directory, 'Default');
  assert.match(profile.reason, /no parent chrome\.exe/);
});

test('processTree survives a command that fails or prints nothing', async () => {
  const empty = await processTree({ platform: 'win32', run: async () => '' });
  assert.equal(empty.size, 0);
  const bad = await processTree({ platform: 'linux', run: async () => 'not a ps table' });
  assert.equal(bad.size, 0);
});

test('processTree parses a windows CIM listing and a posix ps listing', async () => {
  const win = await processTree({
    platform: 'win32',
    run: async () =>
      JSON.stringify([
        { ProcessId: 1000, ParentProcessId: 900, Name: 'chrome.exe', CommandLine: 'chrome.exe --profile-directory=Default' },
        { ProcessId: 1200, ParentProcessId: 1000, Name: 'node.exe', CommandLine: 'node host.js' },
      ]),
  });
  assert.equal(win.size, 2);
  assert.equal(win.get(1200).ppid, 1000);

  const posix = await processTree({
    platform: 'darwin',
    run: async () =>
      '  900     1 /sbin/launchd\n 1000   900 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Profile 2\n 1200  1000 node host.js\n',
  });
  assert.equal(posix.size, 3);
  assert.equal(posix.get(1000).name, 'Google Chrome');
  const found = walkToBrowser(1200, posix);
  assert.equal(found.browser, 'Chrome');
  assert.equal(parseBrowserArgs(found.commandLine).profileDirectory, 'Profile 2');
});

test('describeProfile reads as one line', () => {
  assert.equal(
    describeProfile({ directory: 'Profile 2', name: 'Work', userName: 'work@example.com' }),
    'Profile 2 (Work) work@example.com'
  );
  assert.equal(describeProfile({ directory: 'Default', name: null, userName: null }), 'Default');
  assert.equal(describeProfile(null), 'profile unknown');
});
