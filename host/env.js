// Environment variables, with the pre-rename names still readable.
//
// The project was called chrome-mcp and used CHROME_MCP_* variables. It is now
// Autopilot and the names are AUTOPILOT_*. The old names are read as a fallback
// for one release, and every old name that was actually used is reported so the
// native host can write one deprecation line into its log.

const seen = new Set();

/**
 * Value of AUTOPILOT_<suffix>, falling back to CHROME_MCP_<suffix>.
 *
 * @param {string} suffix name without the prefix, for example 'SOCKET'
 * @returns {string|undefined}
 */
export function envVar(suffix) {
  const current = 'AUTOPILOT_' + suffix;
  if (process.env[current] !== undefined) return process.env[current];
  const legacy = 'CHROME_MCP_' + suffix;
  const value = process.env[legacy];
  if (value !== undefined) seen.add(legacy);
  return value;
}

/**
 * Old variable names that are set in this process and are the ones being used,
 * meaning no AUTOPILOT_ counterpart overrides them. Scanning the environment
 * rather than reporting what was read keeps the answer the same wherever it is
 * called from.
 */
export function deprecatedEnvNames() {
  const names = new Set(seen);
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('CHROME_MCP_')) continue;
    if (process.env['AUTOPILOT_' + key.slice('CHROME_MCP_'.length)] !== undefined) continue;
    names.add(key);
  }
  return [...names].sort();
}

/** Forgets what was read. Tests that change the environment between cases use it. */
export function resetDeprecatedEnvNames() {
  seen.clear();
}
