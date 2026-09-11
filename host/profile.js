// Which Chrome profile is behind this native host.
//
// Chrome loads one extension instance per profile and spawns one native host
// per instance, so every profile already arrives as a separate browser in the
// registry. What the host cannot see from its own process is which profile that
// is: native messaging carries no profile identity at all.
//
// The command line of the browser process does carry it. The host is a child of
// the browser (on Windows through a cmd.exe wrapper), so walking up the process
// tree to the first chrome.exe or msedge.exe finds a command line with
// --profile-directory and, when the user set one, --user-data-dir. The display
// name and signed-in account for that directory are in the Local State file
// under the user data dir.
//
// Nothing here throws. A missing piece comes back as a null field plus a reason,
// because a browser with an unreadable profile is still a browser worth driving.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const EXEC_TIMEOUT = 5000;
const MAX_HOPS = 12;

/** Process names that are a browser, mapped to the name the registry reports. */
const BROWSERS = [
  { match: /^(chrome|google chrome)(\.exe)?$/i, browser: 'Chrome' },
  { match: /^(msedge|microsoft edge)(\.exe)?$/i, browser: 'Edge' },
  { match: /^(brave|brave-browser|brave browser)(\.exe)?$/i, browser: 'Brave' },
  { match: /^(vivaldi)(\.exe)?$/i, browser: 'Vivaldi' },
  { match: /^(chromium|chromium-browser)(\.exe)?$/i, browser: 'Chromium' },
  { match: /^(opera)(\.exe)?$/i, browser: 'Opera' },
];

/** Helper and utility processes that share the browser's name but are not it. */
const NOT_THE_BROWSER = /helper|crashpad|renderer|gpu-process|utility|updater/i;

/**
 * Default user data dir per browser, from the same table tools/install.js uses
 * to find where to register the native messaging host.
 */
const USER_DATA_DIRS = {
  win32: {
    Chrome: ['Google', 'Chrome', 'User Data'],
    Edge: ['Microsoft', 'Edge', 'User Data'],
    Brave: ['BraveSoftware', 'Brave-Browser', 'User Data'],
    Vivaldi: ['Vivaldi', 'User Data'],
    Chromium: ['Chromium', 'User Data'],
    Opera: ['Programs', 'Opera', 'User Data'],
  },
  darwin: {
    Chrome: ['Google', 'Chrome'],
    Edge: ['Microsoft Edge'],
    Brave: ['BraveSoftware', 'Brave-Browser'],
    Vivaldi: ['Vivaldi'],
    Chromium: ['Chromium'],
    Opera: ['com.operasoftware.Opera'],
  },
  linux: {
    Chrome: ['google-chrome'],
    Edge: ['microsoft-edge'],
    Brave: ['BraveSoftware', 'Brave-Browser'],
    Vivaldi: ['vivaldi'],
    Chromium: ['chromium'],
    Opera: ['opera'],
  },
};

/** Splits a command line the way a shell would, keeping double-quoted runs whole. */
export function tokenize(commandLine) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (const char of String(commandLine || '')) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * The executable at the head of a command line.
 *
 * Windows quotes a path with spaces, POSIX ps does not, so "Google Chrome" on
 * macOS arrives as two tokens. Cutting at the first flag keeps such a path whole
 * where splitting on whitespace would report "/Applications/Google".
 */
export function executablePath(commandLine) {
  const raw = String(commandLine || '').trim();
  if (raw.startsWith('"')) {
    const close = raw.indexOf('"', 1);
    return close === -1 ? raw.slice(1) : raw.slice(1, close);
  }
  const flag = raw.search(/\s--?[a-zA-Z]/);
  return (flag === -1 ? raw : raw.slice(0, flag)).trim();
}

/**
 * A flag value can carry spaces, and POSIX ps prints argv with no quoting at
 * all, so "--profile-directory=Profile 1" arrives as two tokens. Continuation
 * tokens are pulled in while they still look like part of the same value.
 */
const CONTINUES = {
  // Chrome's own directory names are "Default", "Profile 1", "Guest Profile".
  '--profile-directory': (token) => /^[\w][\w .-]*$/.test(token),
  '--user-data-dir': (token) => !token.startsWith('-') && !token.includes('://'),
};

/** Reads --profile-directory and --user-data-dir out of a browser command line. */
export function parseBrowserArgs(commandLine) {
  const tokens = tokenize(commandLine);
  const out = { profileDirectory: null, userDataDir: null, executable: executablePath(commandLine) || null };

  const join = (start, first, flag) => {
    let value = first;
    for (let i = start; i < tokens.length; i++) {
      if (!CONTINUES[flag](tokens[i])) break;
      value += ' ' + tokens[i];
    }
    return value;
  };

  const read = (index, flag) => {
    const token = tokens[index];
    if (token === flag) {
      const next = tokens[index + 1];
      if (!next || next.startsWith('-')) return null;
      return join(index + 2, next, flag);
    }
    if (token.startsWith(flag + '=')) {
      const value = token.slice(flag.length + 1);
      return value ? join(index + 1, value, flag) : null;
    }
    return null;
  };

  for (let i = 0; i < tokens.length; i++) {
    out.profileDirectory = out.profileDirectory || read(i, '--profile-directory');
    out.userDataDir = out.userDataDir || read(i, '--user-data-dir');
  }
  return out;
}

/** The browser name for an executable path or process name, or null. */
export function browserFromExecutable(executable) {
  if (!executable) return null;
  const base = String(executable).split(/[\\/]/).pop().trim();
  if (NOT_THE_BROWSER.test(String(executable))) return null;
  for (const entry of BROWSERS) {
    if (entry.match.test(base)) return entry.browser;
  }
  return null;
}

/** Where a browser keeps its user data when the command line does not say. */
export function defaultUserDataDir(browser, { platform = process.platform, env = process.env, home } = {}) {
  const table = USER_DATA_DIRS[platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'];
  const parts = table && table[browser];
  if (!parts) return null;

  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const homeDir = home || env.HOME || env.USERPROFILE || os.homedir();

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    return join(local, ...parts);
  }
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', ...parts);
  }
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), ...parts);
}

/**
 * The display name and account for one profile directory, from Local State.
 *
 * `name` is what the user sees in the profile switcher, `user_name` is the
 * signed-in email and `gaia_name` the account's own display name. Any of the
 * three can be absent on a profile that was never signed in.
 */
export function readLocalState(
  userDataDir,
  profileDirectory,
  { readFile = readFileSync, platform = process.platform } = {}
) {
  if (!userDataDir) return { name: null, userName: null, gaiaName: null, reason: 'no user data dir' };
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const file = join(userDataDir, 'Local State');

  let parsed;
  try {
    parsed = JSON.parse(readFile(file, 'utf8'));
  } catch (err) {
    return { name: null, userName: null, gaiaName: null, reason: 'could not read ' + file + ': ' + err.message };
  }

  const cache = parsed && parsed.profile && parsed.profile.info_cache;
  const info = cache && cache[profileDirectory];
  if (!info) {
    return {
      name: null,
      userName: null,
      gaiaName: null,
      reason: 'no profile.info_cache entry for ' + JSON.stringify(profileDirectory) + ' in ' + file,
    };
  }
  return {
    name: info.name || null,
    userName: info.user_name || null,
    gaiaName: info.gaia_name || null,
    reason: null,
  };
}

function runCommand(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        resolve(err && !stdout ? '' : String(stdout || ''));
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * Every process on the machine as a map of pid to {pid, ppid, name, commandLine}.
 *
 * Windows goes through Get-CimInstance in one call rather than one call per hop,
 * because each PowerShell start costs more than reading the whole table. POSIX
 * uses ps, whose args column already carries the command line.
 */
export async function processTree({ platform = process.platform, run = runCommand } = {}) {
  const tree = new Map();

  if (platform === 'win32') {
    const script =
      '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress -Depth 2';
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let rows;
    try {
      rows = JSON.parse(out);
    } catch {
      return tree;
    }
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (!row || row.ProcessId === undefined) continue;
      tree.set(Number(row.ProcessId), {
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId),
        name: row.Name || '',
        commandLine: row.CommandLine || '',
      });
    }
    return tree;
  }

  const out = await run('ps', ['-Ao', 'pid=,ppid=,args=']);
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const commandLine = match[3].trim();
    tree.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: executablePath(commandLine).split('/').pop(),
      commandLine,
    });
  }
  return tree;
}

/**
 * Walks parents from `pid` until a browser process is found.
 *
 * On Windows the chain from the host is node.exe, cmd.exe (the wrapper script
 * the installer writes), then chrome.exe, so the walk has to follow more than
 * one hop. It stops at the root or after MAX_HOPS so a cycle in a stale process
 * table cannot spin.
 */
export function walkToBrowser(pid, tree) {
  let current = tree.get(Number(pid));
  const seen = new Set();

  for (let hop = 0; hop < MAX_HOPS && current; hop++) {
    if (seen.has(current.pid)) break;
    seen.add(current.pid);

    const browser = browserFromExecutable(current.name) || browserFromExecutable(executablePath(current.commandLine));
    if (browser && hop > 0) return { ...current, browser };
    if (!current.ppid || current.ppid === current.pid) break;
    current = tree.get(current.ppid);
  }
  return null;
}

/**
 * Full profile record for the browser that spawned this process.
 *
 * @returns {Promise<{browser: string|null, executable: string|null, browserPid: number|null,
 *   userDataDir: string|null, directory: string, name: string|null, userName: string|null,
 *   gaiaName: string|null, reason: string|null}>}
 */
export async function detectProfile({
  pid = process.pid,
  platform = process.platform,
  env = process.env,
  home,
  tree,
  run,
  readFile,
} = {}) {
  const empty = {
    browser: null,
    executable: null,
    browserPid: null,
    userDataDir: null,
    directory: 'Default',
    name: null,
    userName: null,
    gaiaName: null,
    reason: null,
  };

  let table;
  try {
    table = tree || (await processTree({ platform, ...(run ? { run } : {}) }));
  } catch (err) {
    return { ...empty, reason: 'could not read the process tree: ' + err.message };
  }

  const found = walkToBrowser(pid, table);
  if (!found) {
    return { ...empty, reason: 'no parent chrome.exe or msedge.exe above pid ' + pid };
  }

  const args = parseBrowserArgs(found.commandLine);
  const directory = args.profileDirectory || 'Default';
  const userDataDir = args.userDataDir || defaultUserDataDir(found.browser, { platform, env, home });

  const state = readLocalState(userDataDir, directory, { platform, ...(readFile ? { readFile } : {}) });

  return {
    browser: found.browser,
    executable: args.executable || found.name || null,
    browserPid: found.pid,
    userDataDir: userDataDir || null,
    directory,
    name: state.name,
    userName: state.userName,
    gaiaName: state.gaiaName,
    reason: state.reason,
  };
}

/** One line for a listing: "Default (Work) work@example.com". */
export function describeProfile(profile) {
  if (!profile) return 'profile unknown';
  const parts = [profile.directory || 'Default'];
  if (profile.name && profile.name !== profile.directory) parts.push('(' + profile.name + ')');
  if (profile.userName) parts.push(profile.userName);
  return parts.join(' ');
}
