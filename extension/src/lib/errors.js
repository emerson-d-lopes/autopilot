// COPY. The canonical file is host/errors.js in this repo.
//
// Edit host/errors.js and copy it over this one. A service worker cannot import
// from outside the extension package, so the catalogue has to exist in both
// places. Everything below the header is identical to the canonical file.
//
// Check they still match:
//   node tools/check-errors-copy.js

// The call contract: one result shape and one error catalogue for every tool.
//
// This file is the single source for failure codes, the default result shape
// and the retry policy. The host imports it directly. The extension gets a
// byte-for-byte copy at extension/src/lib/errors.js, because a service worker
// cannot reach outside its own package. Keep this file free of Node imports so
// the copy stays valid in both places.
//
// Success: {ok: true, effects, evidence, warnings, id, ...existing fields}
// Failure: {ok: false, error: {code, message, cause, hint, effects, retryable}, id}

/**
 * What a call did to the page.
 *
 * `none`   nothing observable changed, so repeating the call is safe.
 * `applied` the change landed and was verified.
 * `unknown` the tool could not tell, so a caller must re-read before retrying.
 */
export const EFFECTS = ['none', 'applied', 'unknown'];

/**
 * Every failure class a tool can report.
 *
 * `message` is the default sentence. `hint` says what to do next and may carry
 * {placeholders} filled from the extra fields passed to toError.
 */
export const CODES = {
  tab_gone: {
    message: 'The tab is gone.',
    hint: 'Call tabs_context to list the tabs this session owns, then retry on a live tab.',
    retryable: false,
    effects: 'none',
  },
  tab_replaced: {
    message: 'The tab could not be recovered and was replaced.',
    hint: 'Use tab {newTabId} from now on and read the page again. Form input and scroll position are gone.',
    retryable: false,
    effects: 'unknown',
  },
  tab_foreign: {
    message: 'That tab does not belong to this session.',
    hint: 'Call tabs_context to list the tabs this session owns, or tabs_create to open one.',
    retryable: false,
    effects: 'none',
  },
  attach_refused: {
    message: 'Chrome refused to attach the debugger to this tab.',
    hint: 'Another extension may hold a frame in the tab. Retry once, then drive the page from a profile without that extension.',
    retryable: true,
    effects: 'none',
  },
  attach_recovered: {
    message: 'The debugger attachment was stale and was rebuilt.',
    hint: 'Nothing to do. The call was retried on the fresh attachment.',
    retryable: false,
    effects: 'none',
  },
  renderer_throttled: {
    message: 'The renderer was throttled and did not process the command in time.',
    hint: 'The tab is in the background. Retry, the host wakes the tab first.',
    retryable: true,
    effects: 'none',
  },
  dialog_open: {
    message: 'A JavaScript dialog is open and blocks every other command on this tab.',
    hint: 'Handle the dialog first, then repeat the call.',
    retryable: false,
    effects: 'none',
  },
  ref_stale: {
    message: 'That element ref no longer resolves.',
    hint: 'Read the page again with read_page and use the new ref.',
    retryable: false,
    effects: 'none',
  },
  ref_covered: {
    message: 'Another element covers the target at the point the click would land.',
    hint: 'Dismiss or scroll past the covering element, then click again. No click was sent.',
    retryable: false,
    effects: 'none',
  },
  element_disabled: {
    message: 'The target element is disabled, so acting on it does nothing.',
    hint: 'Enable it first, or act on whatever controls it.',
    retryable: false,
    effects: 'none',
  },
  element_readonly: {
    message: 'The target element is read-only, so its value cannot be set.',
    hint: 'Whatever makes it read-only has to change first. Act on the control that unlocks it.',
    retryable: false,
    effects: 'none',
  },
  not_a_form_control: {
    message: 'The target is not a form control, so its value cannot be set directly.',
    hint: 'Use computer type on this element instead, or target the control itself.',
    retryable: false,
    effects: 'none',
  },
  no_effect: {
    message: 'The action ran and nothing observable changed.',
    hint: 'Read the page again to see the real state before deciding the action failed.',
    retryable: true,
    effects: 'none',
  },
  nav_failed: {
    message: 'The navigation did not reach the site.',
    hint: 'The tab is showing an error page. Check the URL, then navigate again.',
    // The intended page never loaded, so nothing on the target site changed and
    // repeating the navigation is safe.
    retryable: true,
    effects: 'none',
  },
  origin_changed: {
    message: 'The tab moved to a different origin between the permission check and the call.',
    hint: 'Read the page again and confirm you are on the origin you meant to act on.',
    retryable: false,
    effects: 'unknown',
  },
  origin_blocked: {
    message: 'This origin is not one the session is allowed to act on.',
    hint: 'Chrome blocks extensions on chrome://, edge:// and the Web Store. Navigate to a normal page, or grant the origin.',
    retryable: false,
    effects: 'none',
  },
  confirmation_required: {
    message: 'This action is irreversible and needs confirmation first.',
    hint: 'Repeat the same call with confirm set to {token} within two minutes.',
    retryable: false,
    effects: 'none',
  },
  host_lost: {
    message: 'The link to the browser bridge dropped.',
    hint: 'The host reconnects on its own. Retry the call.',
    retryable: true,
    effects: 'unknown',
  },
  timeout: {
    message: 'The browser did not answer in time.',
    hint: 'The renderer did not respond. Retry, then reload the tab with navigate if it happens again.',
    retryable: true,
    effects: 'unknown',
  },
  output_truncated: {
    message: 'The result was larger than the transfer budget and was cut short.',
    hint: 'Narrow the request with a filter, a lower limit or a smaller selection.',
    retryable: false,
    effects: 'none',
  },
  browser_unknown: {
    message: 'No connected browser matches that name or id.',
    hint: 'Call list_connected_browsers and use one of the ids, labels or profiles it prints.',
    retryable: false,
    effects: 'none',
  },
  profile_ambiguous: {
    message: 'Several connected browsers match, so the session cannot pick one.',
    hint: 'Narrow the selector, or pass browserId from list_connected_browsers.',
    retryable: false,
    effects: 'none',
  },
  // Added by the indicator track (F4): the user pressed the Stop button on the
  // acting-indicator overlay or the popup. The session stays stopped until
  // Resume is pressed, so every call in between fails fast with this code
  // rather than running and being aborted partway through.
  stopped: {
    message: 'The user stopped this session.',
    hint: 'Wait for the user to press Resume on the tab indicator or the popup, then retry.',
    retryable: false,
    effects: 'unknown',
  },
  // Added by the debugger and lifecycle track: a browser_batch that fails its
  // pre-flight check, before any item has run.
  batch_invalid: {
    message: 'The batch was rejected before any item ran.',
    hint: 'Fix the item named in the message and send the batch again. Nothing ran.',
    retryable: false,
    effects: 'none',
  },
  // Added by the host track. Not in the Phase 1 list, needed because tools
  // reject bad arguments before they reach the page and because an unmatched
  // failure still has to carry a code. `bad_request` also covers what the
  // content track first called `invalid_argument`.
  bad_request: {
    message: 'The call was rejected before it reached the page.',
    hint: 'Fix the arguments named in the message and call again.',
    retryable: false,
    effects: 'none',
  },
  // `internal` also covers what the content track first called
  // `unknown_failure`: a throw the tool could not classify, with an effect it
  // cannot vouch for.
  internal: {
    message: 'The call failed for a reason the contract does not classify yet.',
    hint: 'Read the message. If it repeats, read the page again before acting on it.',
    retryable: false,
    effects: 'unknown',
  },
};

export const CODE_NAMES = Object.keys(CODES);

/** The name the extension track used for the same table. */
export const ERROR_CODES = CODES;

/** Tools that only read. They never change the page, so a retry costs nothing. */
export const READ_TOOLS = new Set([
  'read_page',
  'get_page_text',
  'find',
  'page_state',
  'read_console_messages',
  'read_network_requests',
  'tabs_context',
  'wait_for_page',
  'shortcuts_list',
  'list_connected_browsers',
]);

/** A screenshot is a read even though it arrives through the input tool. */
export function isReadCall(tool, args = {}) {
  if (READ_TOOLS.has(tool)) return true;
  if (tool === 'computer' && (args.action === 'screenshot' || args.action === 'zoom')) return true;
  return false;
}

/** Effects a tool reports when it says nothing: a read changed nothing, an input cannot tell. */
export function defaultEffects(tool, args = {}) {
  return isReadCall(tool, args) ? 'none' : 'unknown';
}

function fill(template, extra = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    extra[key] === undefined || extra[key] === null ? whole : String(extra[key])
  );
}

let callSeq = 0;

/** A correlation id for one MCP call. Appears in the result, every error and the journal. */
export function newCallId() {
  callSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return 'call_' + callSeq + '_' + rand;
}

/**
 * Builds one contract error.
 *
 * `extra` overrides any catalogue default and supplies the values a hint
 * template names, so a caller can pass {newTabId} or {token} and get a hint
 * that already carries it.
 */
export function toError(code, extra = {}) {
  const known = CODES[code] ? code : 'internal';
  const base = CODES[known];
  const { message, cause, hint, effects, retryable, id, ...rest } = extra;
  const error = {
    code: known,
    message: message || base.message,
    cause: cause === undefined ? null : cause,
    hint: fill(hint || base.hint, extra),
    effects: effects || base.effects,
    retryable: retryable === undefined ? base.retryable : Boolean(retryable),
  };
  if (id) error.id = id;
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) error[key] = value;
  }
  if (known !== code) error.unknownCode = code;
  return error;
}

/**
 * Message patterns the extension already produces, mapped to codes.
 *
 * The contract has to hold on a browser still running an older extension, so
 * the host reads the prose it gets today rather than waiting for structured
 * errors. First match wins, so the specific patterns come before the broad
 * ones.
 */
export const MATCHERS = [
  [/is no longer on the page|ref [\w-]+ is stale|refs? .{0,20}did not resolve/i, 'ref_stale'],
  [/is covered by .* at the point a click would land|occluded by/i, 'ref_covered'],
  [/is read-only\b/i, 'element_readonly'],
  [/is not a form control|has no value to set/i, 'not_a_form_control'],
  [/is disabled, so (a click on it does nothing|its value cannot be set)|\bis disabled\b/i, 'element_disabled'],
  [/is not in this session's tab group|is not in this session/i, 'tab_foreign'],
  [/No tab with id|may have been closed|No target with given id|Target closed|tab .{0,12}was closed/i, 'tab_gone'],
  [/was replaced|replacement tab/i, 'tab_replaced'],
  [/Navigation to .* failed|showing an error page, not the site/i, 'nav_failed'],
  [/Chrome blocks extensions on chrome:\/\/|restricted (page|URL)|not allowed to act on|permission denied for/i, 'origin_blocked'],
  [/origin changed|navigated to another origin|origin is no longer/i, 'origin_changed'],
  [/Cannot access a chrome-extension|Detached while handling|Inspected target navigated or closed|Not attached to|Debugger is not attached|Another extension \(/i, 'attach_refused'],
  [/already attached|Cannot attach to this target|debugger is attached by another/i, 'attach_refused'],
  [/javascript dialog|alert\(\) is open|beforeunload|dialog is open/i, 'dialog_open'],
  [/renderer did not respond|renderer was throttled|throttled/i, 'renderer_throttled'],
  [/no observable change|nothing changed within/i, 'no_effect'],
  [/needs confirmation|confirmation token|confirm(ation)? required/i, 'confirmation_required'],
  [/browsers are connected, so this session needs to pick one|several browsers match/i, 'profile_ambiguous'],
  [/No connected browser matches|chrome-mcp bridge is not running|no browser$/i, 'browser_unknown'],
  [/Connection to the browser bridge closed|Failed to reach the browser|extension is not attached to the bridge|Chrome extension is not connected/i, 'host_lost'],
  [/did not respond within|timed out|timeout/i, 'timeout'],
  [/exceeds maximum allowed tokens|exceeds the .*limit|output was truncated/i, 'output_truncated'],
  [/\brequires\b|\bmust be\b|needs either|unknown (computer action|tool|key)|No such file|Not a file|is not readable|non-empty/i, 'bad_request'],
];

/** The code that fits a prose error message, or null when nothing matches. */
export function classifyMessage(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const [pattern, code] of MATCHERS) {
    if (pattern.test(s)) return code;
  }
  return null;
}

/** The name the extension track used for classifyMessage. */
export const codeForMessage = classifyMessage;

// ---------------------------------------------------------------------------
// Raising a coded failure from a handler
// ---------------------------------------------------------------------------

/**
 * A failure carrying its catalogue entry.
 *
 * It extends Error so existing throw and catch paths keep working and the
 * message alone still reads correctly in a client that ignores the fields.
 * `details` carries the ids a caller needs to act on the failure, such as the
 * replacement tab after a tab_replaced. `evidence` carries what the tool
 * observed before it gave up.
 */
export class ToolError extends Error {
  constructor(code, message, options = {}) {
    const spec = CODES[code] || CODES.internal;
    super(message || spec.message);
    this.name = 'ToolError';
    this.code = CODES[code] ? code : 'internal';
    if (!CODES[code]) this.unknownCode = code;
    this.cause = options.cause ?? null;
    this.hint = options.hint ?? spec.hint ?? null;
    this.effects = options.effects ?? spec.effects ?? 'unknown';
    this.retryable = options.retryable ?? spec.retryable ?? false;
    this.details = options.details ?? null;
    if (options.evidence) this.evidence = options.evidence;
    if (options.warnings) this.warnings = options.warnings;
  }

  /** The wire shape the result contract specifies. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      cause: this.cause,
      hint: this.hint,
      effects: this.effects,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(this.evidence ? { evidence: this.evidence } : {}),
      ...(this.warnings ? { warnings: this.warnings } : {}),
    };
  }

  /** The failure body, for a caller that reports `{ok: false, error}`. */
  get error() {
    return this.toJSON();
  }
}

/**
 * The name the profile track used. It is the same class, so an
 * `instanceof ToolError` check catches both.
 */
export const ToolFailure = ToolError;

/** Builds a ToolError without the `new`. */
export function toolError(code, message, options) {
  return new ToolError(code, message, options);
}

/** True when the value carries a code from this catalogue. */
export function isToolError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof ToolError) return true;
  return Boolean(err.code && Object.prototype.hasOwnProperty.call(CODES, err.code));
}

/**
 * Attaches a code to an error that does not carry one.
 *
 * A ToolError passes through unchanged. Anything else is classified from its
 * message, falling back to the code the caller named.
 */
export function withCode(err, fallbackCode, options = {}) {
  if (err instanceof ToolError) return err;
  const message = String((err && err.message) || err);
  const code = classifyMessage(message) || fallbackCode || 'internal';
  const wrapped = new ToolError(code, message, options);
  wrapped.stack = (err && err.stack) || wrapped.stack;
  return wrapped;
}

/**
 * Turns anything a handler threw into one contract error.
 *
 * A failure that already carries a catalogue code passes through with its
 * message, cause, hint, effects, retryable, details, evidence and warnings
 * intact. Only an unclassified throw is matched against the message patterns.
 */
export function fromThrown(thrown, context = {}) {
  const source = thrown instanceof ToolError ? thrown.toJSON() : thrown;
  const raw = source && typeof source === 'object' ? source : { message: String(thrown) };
  if (raw.error && raw.error.code && CODES[raw.error.code]) {
    return { ...raw.error, id: context.id || raw.error.id };
  }
  if (raw.code && CODES[raw.code]) {
    const { kind, stack, name, ...fields } = raw;
    return toError(raw.code, { ...fields, message: raw.message || CODES[raw.code].message, id: context.id });
  }
  const message = raw.message ? String(raw.message) : String(thrown);
  const byKind = { disconnected: 'host_lost', not_connected: 'host_lost', transport: 'host_lost', timeout: 'timeout' };
  const code = (raw.kind && byKind[raw.kind]) || classifyMessage(message) || 'internal';
  return toError(code, {
    message,
    cause: raw.cause === undefined ? (raw.kind ? 'kind: ' + raw.kind : null) : raw.cause,
    id: context.id,
    ...(context.tool ? { tool: context.tool } : {}),
  });
}

/**
 * Normalizes whatever a tool handler returned into the contract shape.
 *
 * Existing fields survive untouched. Only ok, effects, evidence, warnings and
 * id are added, and any of them the handler already set is kept, so the
 * extension can supply a real `effects` as soon as it knows one.
 */
export function wrapResult(raw, context = {}) {
  const { tool, args = {}, id, warnings: extraWarnings = [] } = context;

  if (raw && typeof raw === 'object' && raw.ok === false) {
    const error = raw.error && raw.error.code ? raw.error : fromThrown(raw.error || raw, { id, tool });
    return { ...raw, ok: false, error: { ...error, id: id || error.id }, id: id || raw.id };
  }

  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : { value: raw };
  const warnings = [];
  if (Array.isArray(body.warnings)) warnings.push(...body.warnings);
  for (const w of extraWarnings) if (w) warnings.push(w);

  const effects = EFFECTS.includes(body.effects) ? body.effects : defaultEffects(tool, args);
  const evidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : {};

  return { ...body, ok: true, effects, evidence, warnings, id: id || body.id || newCallId() };
}

// ---------------------------------------------------------------------------
// Rendering the contract into a reply
// ---------------------------------------------------------------------------

/**
 * The line that carries the contract fields into the transcript.
 *
 * Tools with a rendered summary get this appended to it. Tools whose reply is
 * the JSON body already carry the same fields inside that body, so they do not.
 */
export function contractLine(result) {
  const parts = ['ok=' + (result.ok !== false), 'effects=' + result.effects, 'id=' + result.id];
  if (result.evidence && Object.keys(result.evidence).length) {
    parts.push('evidence=' + JSON.stringify(result.evidence));
  }
  let line = '[' + parts.join(' ') + ']';
  if (Array.isArray(result.warnings) && result.warnings.length) {
    line += '\nwarnings:\n' + result.warnings.map((w) => '  - ' + w).join('\n');
  }
  return line;
}

/** A failure, with the code, the cause, the hint and the side-effect flag on it. */
export function formatError(error) {
  const lines = [error.message];
  if (error.cause) lines.push('cause: ' + error.cause);
  if (error.hint) lines.push('hint: ' + error.hint);
  if (Array.isArray(error.retries) && error.retries.length) lines.push(error.retries.join('\n'));
  lines.push(
    '[ok=false code=' + error.code + ' effects=' + error.effects + ' retryable=' + error.retryable +
      (error.id ? ' id=' + error.id : '') + ']'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// C4. Retry policy by side effect
// ---------------------------------------------------------------------------

/** Codes a read may retry through. A read cannot change anything, so this is safe. */
export const READ_RETRY_CODES = ['renderer_throttled', 'timeout', 'host_lost'];

/** Attempts, counting the first one. Reads get three, inputs get two. */
export const MAX_ATTEMPTS = { read: 3, input: 2 };

/** Milliseconds to wait before attempt 2 and attempt 3. */
export const BACKOFF_MS = [250, 750];

/**
 * A call that carries a confirmation token, or is flagged irreversible, is
 * never repeated by the host. Repeating it would be a second real write.
 */
export function isProtected(args = {}) {
  return Boolean(args.confirm || args.confirmation || args.irreversible);
}

/**
 * Decides whether to try a failed call again.
 *
 * Reads retry up to three attempts on the three transient codes. Inputs retry
 * once and only when the error proved nothing happened. An error whose effects
 * are `unknown` or `applied` is never retried, because the host cannot tell a
 * lost reply from a landed write.
 *
 * @returns {{retry: boolean, delayMs: number, reason: string}}
 */
export function retryDecision({ tool, args = {}, error, attempt = 1 }) {
  const no = (reason) => ({ retry: false, delayMs: 0, reason });
  if (!error || !error.code) return no('no error');
  if (isProtected(args)) return no('call carries confirm or is flagged irreversible');

  const read = isReadCall(tool, args);
  const limit = read ? MAX_ATTEMPTS.read : MAX_ATTEMPTS.input;
  if (attempt >= limit) return no('attempt limit ' + limit + ' reached');
  if (error.effects === 'unknown' || error.effects === 'applied') {
    return no('effects ' + error.effects + ', the page may already have changed');
  }

  if (read) {
    if (!READ_RETRY_CODES.includes(error.code)) return no('code ' + error.code + ' is not transient');
    return { retry: true, delayMs: BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1], reason: 'read, ' + error.code };
  }

  if (error.effects !== 'none') return no('input with effects ' + error.effects);
  if (!error.retryable) return no('code ' + error.code + ' is not retryable');
  return { retry: true, delayMs: BACKOFF_MS[0], reason: 'input, effects none' };
}

/** The retry table as rows, for npm run doctor and for tests. */
export function retryTable() {
  return [
    {
      kind: 'read',
      tools: [...READ_TOOLS].join(', ') + ', computer screenshot',
      attempts: MAX_ATTEMPTS.read,
      on: READ_RETRY_CODES.join(', '),
      backoffMs: BACKOFF_MS.join(', '),
    },
    {
      kind: 'input',
      tools: 'every other tool',
      attempts: MAX_ATTEMPTS.input,
      on: 'any retryable code, only when the error reports effects none',
      backoffMs: String(BACKOFF_MS[0]),
    },
    {
      kind: 'never',
      tools: 'any call carrying confirm, or flagged irreversible',
      attempts: 1,
      on: 'effects unknown or applied is never retried',
      backoffMs: '0',
    },
  ];
}
