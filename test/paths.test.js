import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateRoot, statePath, ensureDir, legacyTempPath } from '../host/paths.js';

test('the state root is per user on every platform', () => {
  const home = homedir();
  assert.equal(
    stateRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    join('C:\\Users\\me\\AppData\\Local', 'Autopilot')
  );
  assert.equal(stateRoot({}, 'win32'), join(home, 'AppData', 'Local', 'Autopilot'));
  assert.equal(stateRoot({}, 'darwin'), join(home, 'Library', 'Application Support', 'Autopilot'));
  assert.equal(stateRoot({ XDG_STATE_HOME: '/var/state' }, 'linux'), join('/var/state', 'autopilot'));
  assert.equal(stateRoot({}, 'linux'), join(home, '.local', 'state', 'autopilot'));
});

test('statePath names a directory under the root without creating it', () => {
  assert.equal(statePath('logs', {}, 'linux'), join(homedir(), '.local', 'state', 'autopilot', 'logs'));
  assert.ok(statePath('browsers').startsWith(stateRoot()));
});

test('ensureDir creates the directory and its parents, owner-only where the platform honours modes', () => {
  const base = mkdtempSync(join(tmpdir(), 'autopilot-paths-'));
  try {
    const dir = ensureDir(join(base, 'a', 'b'));
    assert.equal(dir, join(base, 'a', 'b'));
    const stat = statSync(dir);
    assert.ok(stat.isDirectory());
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(ensureDir(dir), dir, 'a second call is a no-op');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('legacyTempPath is where the state lived before 0.2.3', () => {
  assert.equal(legacyTempPath('browsers'), join(tmpdir(), 'autopilot-browsers'));
  assert.equal(legacyTempPath('logs'), join(tmpdir(), 'autopilot-logs'));
});
