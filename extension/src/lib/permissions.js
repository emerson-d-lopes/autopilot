// Permission policy enforced inside the extension.
//
// Two layers guard a tool call. The MCP client (Claude Code) prompts the user
// per tool call on its own side. This layer is the part the client cannot
// bypass: an origin blocklist, hard-blocked action categories, and a re-check
// that the tab is still on the origin the call was authorized against.

import { ToolError } from './errors.js';

const STORAGE_KEY = 'permissionPolicy';

export const MODES = {
  ALLOW: 'allow', // blocklist only, default
  ASK: 'ask', // origin must hold a grant
  CONFIRM: 'confirm', // allow mode, plus a token before an irreversible click
  PLAN: 'plan', // only the origins declared by declare_plan
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
  // Hosts whose irreversible controls may be clicked without a confirmation
  // token, for a user who has decided that messaging on one site is routine.
  writeAllowlist: [],
  // Ask in the browser as well as through the client: a Chrome notification
  // with Allow and Deny. Off by default, since it needs someone at the machine.
  confirmNotifications: false,
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

// ---------------------------------------------------------------------------
// F5. Plan mode
// ---------------------------------------------------------------------------
//
// One approval for a declared list of origins instead of a prompt per origin.
// The declaration is per session (per MCP client), lives in memory, and is
// checked against the blocklist when it is made, so a blocked host cannot enter
// a plan and pass later.

/** @type {Map<string, {origins: string[], declaredAt: number}>} */
const plans = new Map();

export function planFor(clientId = 'default') {
  return plans.get(clientId) || null;
}

export function clearPlan(clientId = 'default') {
  plans.delete(clientId);
}

/** Normalizes what a caller declared: bare hosts, URLs and origins all land as origins. */
export function planOriginOf(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/**
 * Declares the origins a session will act on.
 *
 * Returns the grant set. A blocked host is reported rather than silently
 * dropped, because a plan that quietly lost an origin looks like a working plan
 * until the first call on it fails.
 */
export async function declarePlan(clientId = 'default', origins = []) {
  const policy = await loadPolicy();
  const list = Array.isArray(origins) ? origins : [origins];
  const granted = [];
  const blocked = [];
  const rejected = [];

  for (const entry of list) {
    const origin = planOriginOf(entry);
    if (!origin) {
      rejected.push(String(entry));
      continue;
    }
    const hostname = hostnameOf(origin);
    const isBlocked = (policy.blockedHosts || []).some((p) => hostMatches(hostname, p));
    const allowed = (policy.allowedHosts || []).some((p) => hostMatches(hostname, p));
    if (isBlocked && !allowed) blocked.push(origin);
    else if (!granted.includes(origin)) granted.push(origin);
  }

  plans.set(clientId, { origins: granted, declaredAt: Date.now() });
  return { origins: granted, blocked, rejected, mode: policy.mode };
}

export function planCovers(clientId, origin) {
  const plan = plans.get(clientId || 'default');
  if (!plan || !origin) return false;
  return plan.origins.includes(origin);
}

// ---------------------------------------------------------------------------
// F6. Domain transitions
// ---------------------------------------------------------------------------
//
// verifyOriginUnchanged catches the involuntary case, where the page moved
// under the call. This catches the voluntary one: a navigate, or a redirect
// chain, that lands the session on an origin it has not acted on before.

/** @type {Map<string, string>} */
const lastActed = new Map();

export function lastActedOrigin(clientId = 'default') {
  return lastActed.get(clientId) || null;
}

export function noteActedOrigin(clientId = 'default', url) {
  const origin = originOf(url);
  if (origin) lastActed.set(clientId, origin);
  return origin;
}

export function forgetActedOrigin(clientId = 'default') {
  lastActed.delete(clientId);
}

/**
 * Compares the origin a call acts on with the one the session last acted on.
 *
 * In allow and confirm mode a move is a warning on the result. In ask mode it
 * needs its own grant, through the same grant path a first visit uses. Reads
 * and localhost are exempt, matching the rest of this file.
 */
export async function checkDomainTransition({ clientId = 'default', url, tool, note = true }) {
  const policy = await loadPolicy();
  const origin = originOf(url);
  if (!origin) return { changed: false };

  const previous = lastActed.get(clientId) || null;
  const changed = Boolean(previous && previous !== origin);
  const remember = () => {
    if (note) lastActed.set(clientId, origin);
  };

  if (!changed) {
    remember();
    return { changed: false, origin, previous };
  }

  const hostname = hostnameOf(url);
  const exempt =
    policy.mode === MODES.SKIP ||
    READ_ONLY_TOOLS.has(tool) ||
    (hostname && isLocalhost(hostname)) ||
    planCovers(clientId, origin);

  if (!exempt && policy.mode === MODES.ASK && !policy.grants[origin]) {
    throw new ToolError(
      'origin_blocked',
      'This session last acted on ' + previous + ' and this call acts on ' + origin +
        '. A move to another origin needs its own grant.',
      {
        hint: 'Grant ' + origin + ' in the extension options, or switch the mode to allow.',
        effects: 'none',
        details: { from: previous, to: origin, tool },
      }
    );
  }

  remember();
  return {
    changed: true,
    origin,
    previous,
    warning:
      'this call acts on ' + origin + ', and the session last acted on ' + previous +
      '. Confirm the new origin is the one you meant before acting further.',
  };
}

// ---------------------------------------------------------------------------
// W4. Confirmation tokens
// ---------------------------------------------------------------------------
//
// A token is single use and bound to the tab, the origin and the control, so a
// token minted for a Send button cannot be spent on a Delete button, on another
// tab, or twice. Tokens live in the worker's memory: a worker restart drops
// them, which is the safe direction, since the effect is one more confirmation.

export const CONFIRM_TTL_MS = 120000;

/** @type {Map<string, {tabId: number, origin: string, control: string, screenshotId: string|null, createdAt: number}>} */
const confirmations = new Map();
let confirmSeq = 0;

function pruneConfirmations(now = Date.now()) {
  for (const [token, record] of confirmations) {
    if (now - record.createdAt > CONFIRM_TTL_MS) confirmations.delete(token);
  }
}

export function createConfirmation({ tabId, origin, control, screenshotId = null }) {
  pruneConfirmations();
  confirmSeq += 1;
  const token = 'cx_' + confirmSeq + '_' + Math.random().toString(36).slice(2, 10);
  confirmations.set(token, {
    tabId,
    origin,
    control: String(control || ''),
    screenshotId,
    createdAt: Date.now(),
  });
  return token;
}

/**
 * Spends a token, or says why it cannot be spent.
 *
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
export function consumeConfirmation(token, { tabId, origin, control }) {
  pruneConfirmations();
  const record = confirmations.get(String(token || ''));
  if (!record) return { ok: false, reason: 'that token is unknown or has expired' };
  if (record.tabId !== tabId) return { ok: false, reason: 'that token was issued for tab ' + record.tabId };
  if (record.origin !== origin) return { ok: false, reason: 'that token was issued for ' + record.origin };
  if (record.control !== String(control || '')) {
    return { ok: false, reason: 'that token was issued for ' + JSON.stringify(record.control) };
  }
  confirmations.delete(token);
  return { ok: true, record };
}

export function pendingConfirmations() {
  pruneConfirmations();
  return confirmations.size;
}

/** True when this origin is on the per-origin write allow-list. */
export function writeAllowed(policy, url) {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  return (policy.writeAllowlist || []).some((p) => hostMatches(hostname, p));
}

/**
 * Whether an irreversible control on this page needs a token first.
 *
 * Only confirm mode asks. The allow-list is per origin, so a user who has
 * decided that messaging on one site is routine is not asked there and is still
 * asked everywhere else.
 */
export async function needsConfirmation({ url, irreversible }) {
  const policy = await loadPolicy();
  if (policy.mode !== MODES.CONFIRM) return false;
  if (!irreversible) return false;
  return !writeAllowed(policy, url);
}

// ---------------------------------------------------------------------------
// W4. In-browser approval
// ---------------------------------------------------------------------------
//
// A Chrome notification with Allow and Deny. It does not activate a tab and
// does not focus a window, so background mode survives it.

const pendingNotifications = new Map();

function notificationsAvailable() {
  return Boolean(globalThis.chrome && chrome.notifications && chrome.notifications.create);
}

if (notificationsAvailable() && chrome.notifications.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((id, index) => {
    const pending = pendingNotifications.get(id);
    if (!pending) return;
    pending.settle(index === 0 ? 'allow' : 'deny');
  });
  if (chrome.notifications.onClosed) {
    chrome.notifications.onClosed.addListener((id) => {
      const pending = pendingNotifications.get(id);
      if (pending) pending.settle('dismissed');
    });
  }
}

/**
 * How long an unanswered notification is waited for.
 *
 * Half the token's life, and half the host's 120s call timeout. With the two
 * deadlines equal, the host gave up first and reported a renderer that never
 * answered, and the notification was still open afterwards with nothing left to
 * answer it. This expires first, so the call comes back saying what actually
 * happened and the notification is closed on the way out.
 */
export const ASK_IN_BROWSER_TIMEOUT_MS = 60000;

/**
 * Asks in the browser and waits for the answer.
 *
 * Returns `unavailable` when the switch is off or the API is missing, so the
 * caller falls back to the client-side token flow rather than failing, and
 * `timeout` when nobody answered inside the deadline.
 */
export async function askInBrowser({ control, origin, timeoutMs = ASK_IN_BROWSER_TIMEOUT_MS } = {}) {
  const policy = await loadPolicy();
  if (!policy.confirmNotifications || !notificationsAvailable()) return 'unavailable';

  const id = 'chrome-mcp-confirm-' + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve) => {
    let done = false;
    const settle = (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingNotifications.delete(id);
      try {
        chrome.notifications.clear(id);
      } catch {
        /* already gone */
      }
      resolve(answer);
    };
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    pendingNotifications.set(id, { settle });

    try {
      chrome.notifications.create(
        id,
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
          title: 'Confirm an irreversible action',
          message: 'Press ' + JSON.stringify(String(control || 'this control')) + ' on ' + origin + '?',
          buttons: [{ title: 'Allow' }, { title: 'Deny' }],
          requireInteraction: true,
        },
        () => {
          if (chrome.runtime.lastError) settle('unavailable');
        }
      );
    } catch {
      settle('unavailable');
    }
  });
}

/**
 * Decides whether a tool may run against a URL.
 * Read-only tools bypass grant checks but not the blocklist, since reading a
 * banking page still exfiltrates it into the transcript.
 */
/**
 * Decides whether a tool may run against a URL.
 *
 * `noteTransition: false` runs the transition check without recording the
 * origin. navigate needs that: it checks the URL it is about to move to, and
 * recording it there meant the move was already the session's last acted origin
 * by the time the tab landed, so the warning belonged to the next call rather
 * than to the navigate that caused it.
 */
export async function checkPermission({ tool, url, toolUseId, clientId = 'default', noteTransition = true }) {
  const policy = await loadPolicy();
  const hostname = hostnameOf(url);
  const transitionCheck = () => checkDomainTransition({ clientId, url, tool, note: noteTransition });

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

  // Plan mode is checked before the read-only bypass. The point of declaring a
  // list is that the user sees the whole scope of the task, and a read of an
  // undeclared site is part of that scope.
  if (policy.mode === MODES.PLAN) {
    const planned = originOf(url);
    if (!isLocalhost(hostname) && !planCovers(clientId, planned)) {
      const plan = planFor(clientId);
      throw new ToolError(
        'origin_blocked',
        (plan
          ? 'This session declared ' + (plan.origins.join(', ') || 'no origins') + ' and ' + planned + ' is not among them.'
          : 'The extension is in plan mode and this session has not declared the origins it will act on.'),
        {
          hint: 'Call declare_plan with every origin the task needs, including ' + planned + '.',
          effects: 'none',
          details: { origin: planned, declared: plan ? plan.origins : [] },
        }
      );
    }
    const transitionPlanned = await transitionCheck();
    return { allowed: true, reason: 'plan mode', transition: transitionPlanned };
  }

  if (READ_ONLY_TOOLS.has(tool)) {
    return {
      allowed: true,
      reason: 'read-only',
      transition: await transitionCheck(),
    };
  }
  if (isLocalhost(hostname)) {
    return { allowed: true, reason: 'localhost', transition: await transitionCheck() };
  }
  // Confirm mode is allow mode until an irreversible control is pressed, which
  // is decided at the click itself, where the control's name is known.
  if (policy.mode === MODES.ALLOW || policy.mode === MODES.CONFIRM) {
    return {
      allowed: true,
      reason: policy.mode === MODES.CONFIRM ? 'confirm mode' : 'allow mode',
      transition: await transitionCheck(),
    };
  }

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
  return { allowed: true, reason: 'granted', transition: await transitionCheck() };
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
