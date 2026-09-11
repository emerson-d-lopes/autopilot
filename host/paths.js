// Where the host keeps its state: the registry of connected browsers, the
// action journal, saved screenshots, and the host's own log.
//
// These lived under os.tmpdir(). On Windows and macOS that is a per-user
// directory, on Linux it is /tmp, shared by every user on the machine, where
// another account could pre-create the directory and read or replace the
// registry entries that tell the MCP server which socket to connect to. The
// state now lives under the user's own application data directory, created
// with owner-only permissions, and the old temp locations are still read for
// one release so a host started before the upgrade is still found.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * The per-user root for this app's state.
 *
 * Windows: %LOCALAPPDATA%\Autopilot. macOS: ~/Library/Application Support/Autopilot.
 * Elsewhere: $XDG_STATE_HOME/autopilot, defaulting to ~/.local/state/autopilot.
 */
export function stateRoot(env = process.env, platform = process.platform) {
  const home = homedir();
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Autopilot');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Autopilot');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'autopilot');
}

/** Path of one state directory under the root. Nothing is created. */
export function statePath(name, env = process.env, platform = process.platform) {
  return join(stateRoot(env, platform), name);
}

/** Creates a directory readable by its owner only, parents included. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Where the same state lived before 0.2.3, for readers that still look there. */
export function legacyTempPath(name) {
  return join(tmpdir(), 'autopilot-' + name);
}
