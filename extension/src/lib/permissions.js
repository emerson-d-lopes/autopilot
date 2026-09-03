// Permission policy enforced inside the extension.
//
// Two layers guard a tool call. The MCP client (Claude Code) prompts the user
// per tool call on its own side. This layer is the part the client cannot
// bypass: an origin blocklist, hard-blocked action categories, and a re-check
// that the tab is still on the origin the call was authorized against.

const STORAGE_KEY = 'permissionPolicy';

export const MODES = {
  ALLOW: 'allow', // blocklist only, default
  ASK: 'ask', // origin must hold a grant
  SKIP: 'skip_all_permission_checks',
};

/** Tools that never mutate page or browser state. */
export const READ_ONLY_TOOLS = new Set([
  'read_page',
  'get_page_text',
  'find',
  'read_console_messages',
  'read_network_requests',
  'tabs_context',
  'page_state',
]);

/** Actions blocked regardless of mode or grants. */
export const HARD_BLOCKED_REASONS = {
  credentials: 'entering passwords, card numbers, or government IDs',
  purchase: 'completing a purchase or transferring funds',
};

const DEFAULT_BLOCKED_HOSTS = [
  // Financial. A misfired click here is not recoverable.
  '*.chase.com',
  '*.bankofamerica.com',
  '*.wellsfargo.com',
  '*.citi.com',
  '*.paypal.com',
  '*.coinbase.com',
  '*.binance.com',
  '*.robinhood.com',
  '*.fidelity.com',
  '*.schwab.com',
  '*.vanguard.com',
  '*.itau.com.br',
  '*.bb.com.br',
  '*.nubank.com.br',
  '*.santander.com.br',
  '*.bradesco.com.br',
  '*.caixa.gov.br',
];

const DEFAULT_POLICY = {
  mode: MODES.ALLOW,
  blockedHosts: DEFAULT_BLOCKED_HOSTS,
  allowedHosts: [],
  grants: {}, // origin -> { duration: 'always'|'once', toolUseId?, createdAt }
};

let cache = null;

export async function loadPolicy() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  cache = { ...DEFAULT_POLICY, ...(stored[STORAGE_KEY] || {}) };
  return cache;
}

export async function savePolicy(patch) {
  const current = await loadPolicy();
  cache = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
  return cache;
}

export function invalidatePolicyCache() {
  cache = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/** Matches a hostname against a pattern that may start with "*.". */
export function hostMatches(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.startsWith('*.')) {
    const base = pat.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pat;
}

export function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isLocalhost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  );
}

export class PermissionDenied extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PermissionDenied';
    this.details = details;
  }
}

/**
 * Decides whether a tool may run against a URL.
 * Read-only tools bypass grant checks but not the blocklist, since reading a
 * banking page still exfiltrates it into the transcript.
 */
export async function checkPermission({ tool, url, toolUseId }) {
  const policy = await loadPolicy();
  const hostname = hostnameOf(url);

  if (!hostname) {
    // about:blank and new tabs carry no origin and nothing worth protecting.
    return { allowed: true, reason: 'no origin' };
  }

  const isBlocked = policy.blockedHosts.some((p) => hostMatches(hostname, p));
  const isExplicitlyAllowed = policy.allowedHosts.some((p) => hostMatches(hostname, p));

  if (isBlocked && !isExplicitlyAllowed) {
    throw new PermissionDenied(
      'Blocked origin: ' + hostname +
        '. This host is on the extension blocklist (financial and payment sites are blocked by default). ' +
        'Remove it in the extension options if you intend to allow it.',
      { hostname, tool }
    );
  }

  if (policy.mode === MODES.SKIP) return { allowed: true, reason: 'skip_all' };
  if (READ_ONLY_TOOLS.has(tool)) return { allowed: true, reason: 'read-only' };
  if (isLocalhost(hostname)) return { allowed: true, reason: 'localhost' };
  if (policy.mode === MODES.ALLOW) return { allowed: true, reason: 'allow mode' };

  // ask mode
  const origin = originOf(url);
  const grant = policy.grants[origin];
  if (!grant) {
    throw new PermissionDenied(
      'No permission grant for ' + origin +
        '. The extension is in "ask" mode. Grant access in the extension options, or switch the mode to "allow".',
      { origin, tool }
    );
  }
  if (grant.duration === 'once') {
    if (grant.toolUseId && toolUseId && grant.toolUseId !== toolUseId) {
      throw new PermissionDenied('Single-use grant for ' + origin + ' was issued for a different call.', { origin });
    }
    const next = { ...policy.grants };
    delete next[origin];
    await savePolicy({ grants: next });
  }
  return { allowed: true, reason: 'granted' };
}

export async function grant(origin, duration = 'always', toolUseId = null) {
  const policy = await loadPolicy();
  return savePolicy({
    grants: { ...policy.grants, [origin]: { duration, toolUseId, createdAt: Date.now() } },
  });
}

export async function revoke(origin) {
  const policy = await loadPolicy();
  const next = { ...policy.grants };
  delete next[origin];
  return savePolicy({ grants: next });
}

/**
 * Re-checks that a tab still sits on the origin a mutating call was authorized
 * against. Closes the window where a page navigates between the model deciding
 * to click and the click landing, which would otherwise deliver the input to a
 * different site than the one that was approved.
 */
export async function verifyOriginUnchanged(tabId, expectedUrl) {
  if (!expectedUrl) return;
  const tab = await chrome.tabs.get(tabId);
  const before = hostnameOf(expectedUrl);
  const after = hostnameOf(tab.url);
  if (before && after && before !== after) {
    throw new PermissionDenied(
      'Tab navigated from ' + before + ' to ' + after + ' before the action ran. ' +
        'The action was not performed. Re-read the page and retry if this navigation was expected.',
      { before, after }
    );
  }
}
