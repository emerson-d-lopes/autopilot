// Error catalogue for the extension side of the bridge.
//
// `host/errors.js` is canonical. This file is the extension's copy of the same
// catalogue so a handler can attach a code without a round trip to the host.
// When the two disagree, the host wins: change it there first, then mirror it
// here.
//
// Every failure carries the same shape:
//
//   { code, message, cause, hint, effects, retryable }
//
//   code      one of CODES, the failure class a caller can branch on
//   message   what happened, in one sentence
//   cause     why it happened, when the extension knows
//   hint      what to do next, in one sentence
//   effects   'none' | 'applied' | 'unknown', what the page saw before the failure
//   retryable whether repeating the identical call can succeed

export const CODES = {
  tab_gone: 'tab_gone',
  tab_replaced: 'tab_replaced',
  attach_refused: 'attach_refused',
  attach_recovered: 'attach_recovered',
  renderer_throttled: 'renderer_throttled',
  dialog_open: 'dialog_open',
  ref_stale: 'ref_stale',
  ref_covered: 'ref_covered',
  element_disabled: 'element_disabled',
  no_effect: 'no_effect',
  nav_failed: 'nav_failed',
  origin_changed: 'origin_changed',
  origin_blocked: 'origin_blocked',
  confirmation_required: 'confirmation_required',
  host_lost: 'host_lost',
  timeout: 'timeout',
  output_truncated: 'output_truncated',
  browser_unknown: 'browser_unknown',
  profile_ambiguous: 'profile_ambiguous',

  // Added by the plan/content-verify track. Say so in the handoff so the host
  // catalogue picks them up.
  invalid_argument: 'invalid_argument',
  element_readonly: 'element_readonly',
  not_a_form_control: 'not_a_form_control',
  unknown_failure: 'unknown_failure',
};

/** Default recovery hint per code, used when a call site does not supply one. */
const HINTS = {
  tab_gone: 'Call tabs_context to list the tabs this session still owns.',
  tab_replaced: 'Read the page again: refs and form state from before the replacement are gone.',
  attach_refused: 'Another extension has a frame in this tab. Drive the page from a profile without it.',
  attach_recovered: 'The attach succeeded on retry. Nothing to do.',
  renderer_throttled: 'The tab was woken and the dispatch retried. Re-read the page to confirm the state.',
  dialog_open: 'A JavaScript dialog is open. It was handled, read the dialog text in the result.',
  ref_stale: 'Read the page again to get current refs.',
  ref_covered: 'Dismiss or scroll past whatever covers the element, then click again.',
  element_disabled: 'Enable it first, or act on whatever controls it.',
  no_effect: 'Re-read the page before retrying: the action reached the browser and the page did not move.',
  nav_failed: 'The tab is showing an error page. Check the URL and try again.',
  origin_changed: 'The tab left the origin the call was authorized against. Re-read the page.',
  origin_blocked: 'This host is on the extension blocklist. Change it in the options page if that is wrong.',
  confirmation_required: 'Repeat the call with the confirmation token to perform it.',
  host_lost: 'The native host went away mid-call. Retry once the bridge reconnects.',
  timeout: 'The renderer did not respond. Reload the tab with navigate.',
  output_truncated: 'Narrow the read with ref_id, filter or depth rather than raising the budget blindly.',
  browser_unknown: 'Call list_connected_browsers and pass an id.',
  profile_ambiguous: 'Several profiles match. Pass browserId to pick one.',
  invalid_argument: 'Check the argument against the tool schema.',
  element_readonly: 'The control is read-only, so its value cannot be set.',
  not_a_form_control: 'Use computer type on this element instead, or target the control itself.',
  unknown_failure: 'Read the message. Re-read the page before retrying, since the effect is not known.',
};

/**
 * A failure carrying its catalogue entry.
 *
 * It extends Error so existing `throw` and `catch` paths keep working and the
 * message alone still reads correctly in a client that ignores the fields.
 */
export class ToolError extends Error {
  constructor(code, message, { cause, hint, effects = 'none', retryable = false, evidence } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = CODES[code] || code;
    this.cause = cause;
    this.hint = hint || HINTS[code] || '';
    this.effects = effects;
    this.retryable = retryable;
    if (evidence) this.evidence = evidence;
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
      ...(this.evidence ? { evidence: this.evidence } : {}),
    };
  }
}

export function toolError(code, message, options) {
  return new ToolError(code, message, options);
}

/**
 * Classifies a message that arrived as a plain string, so an error raised
 * before this catalogue existed still reaches a caller with a code.
 */
export function codeForMessage(text) {
  const s = String(text || '');
  if (/is no longer on the page/i.test(s)) return CODES.ref_stale;
  if (/is covered by/i.test(s)) return CODES.ref_covered;
  if (/is disabled/i.test(s)) return CODES.element_disabled;
  if (/is read-only/i.test(s)) return CODES.element_readonly;
  if (/No tab with id|may have been closed/i.test(s)) return CODES.tab_gone;
  if (/not in this session's tab group/i.test(s)) return CODES.tab_gone;
  if (/chrome-extension/i.test(s)) return CODES.attach_refused;
  if (/Navigation to .* failed/i.test(s)) return CODES.nav_failed;
  if (/timed out|did not respond/i.test(s)) return CODES.timeout;
  return null;
}

/** Attaches a code to an error that does not carry one, in place. */
export function withCode(err, fallbackCode, options = {}) {
  if (err instanceof ToolError) return err;
  const code = codeForMessage(err && err.message) || fallbackCode;
  const wrapped = new ToolError(code, String((err && err.message) || err), options);
  wrapped.stack = (err && err.stack) || wrapped.stack;
  return wrapped;
}
