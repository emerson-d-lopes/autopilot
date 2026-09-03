// Error catalogue for the result contract.
//
// `host/errors.js` is canonical. This file mirrors it so the extension can raise
// the same codes without importing across the extension and host boundary.
// Change `host/errors.js` first, then copy the table here.
//
// Every failure returned to the host has the shape
// `{code, message, cause, hint, effects, retryable}`, with `details` carrying
// the ids a caller needs to act on the error (a replacement tab, for example).

/**
 * Defaults per code. `effects` says what the failed call did to the page:
 * `none` nothing happened, `applied` the action landed, `unknown` the tool
 * cannot tell. `retryable` says whether the host may repeat the same call
 * without asking.
 */
export const ERROR_CODES = {
  tab_gone: {
    effects: 'none',
    retryable: false,
    hint: 'Call tabs_context to list the tabs this session owns.',
  },
  tab_replaced: {
    effects: 'none',
    retryable: true,
    hint: 'Retry on the new tab id. Page state such as form input and scroll position is gone.',
  },
  attach_refused: {
    effects: 'none',
    retryable: false,
    hint: 'Close DevTools on that tab, or drive the page from a profile without the interfering extension.',
  },
  attach_recovered: {
    effects: 'none',
    retryable: false,
    hint: 'The attach succeeded after removing an interfering extension iframe.',
  },
  renderer_throttled: {
    effects: 'unknown',
    retryable: true,
    hint: 'The renderer stopped answering. Retry the call.',
  },
  dialog_open: {
    effects: 'none',
    retryable: false,
    hint: 'The page opened a modal dialog. Read the dialog text in the result and act on it.',
  },
  ref_stale: {
    effects: 'none',
    retryable: false,
    hint: 'Re-read the page to get current refs.',
  },
  ref_covered: {
    effects: 'none',
    retryable: false,
    hint: 'Dismiss or scroll past whatever covers the element, then try again.',
  },
  element_disabled: {
    effects: 'none',
    retryable: false,
    hint: 'Enable the control first, or act on whatever controls it.',
  },
  no_effect: {
    effects: 'none',
    retryable: false,
    hint: 'Nothing on the page changed. Read the page and pick a different target.',
  },
  nav_failed: {
    effects: 'none',
    retryable: true,
    hint: 'The tab is showing an error page. Check the URL and the network.',
  },
  origin_changed: {
    effects: 'none',
    retryable: false,
    hint: 'The page navigated under the call. Re-read the page before acting again.',
  },
  origin_blocked: {
    effects: 'none',
    retryable: false,
    hint: 'This origin is not permitted for this tool. Grant it first.',
  },
  confirmation_required: {
    effects: 'none',
    retryable: false,
    hint: 'Repeat the call with the confirmation token once the user has approved it.',
  },
  host_lost: {
    effects: 'unknown',
    retryable: true,
    hint: 'The native host connection dropped. Retry once it reconnects.',
  },
  timeout: {
    effects: 'unknown',
    retryable: false,
    hint: 'the renderer did not respond, reload the tab with navigate',
  },
  output_truncated: {
    effects: 'none',
    retryable: false,
    hint: 'Narrow the request so the result fits.',
  },
  browser_unknown: {
    effects: 'none',
    retryable: false,
    hint: 'Call list_connected_browsers and select one.',
  },
  profile_ambiguous: {
    effects: 'none',
    retryable: false,
    hint: 'Name the browser by id, since more than one profile matches.',
  },
  // Added by the debugger and lifecycle track: a browser_batch that fails its
  // pre-flight check, before any item has run.
  batch_invalid: {
    effects: 'none',
    retryable: false,
    hint: 'Fix the named item and send the batch again. Nothing ran.',
  },
};

/** A failure carrying a catalogue code, ready for the result contract. */
export class ToolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    const spec = ERROR_CODES[code] || {};
    this.name = 'ToolError';
    this.code = code;
    this.cause = options.cause ?? null;
    this.hint = options.hint ?? spec.hint ?? null;
    this.effects = options.effects ?? spec.effects ?? 'unknown';
    this.retryable = options.retryable ?? spec.retryable ?? false;
    this.details = options.details ?? null;
    if (options.warnings) this.warnings = options.warnings;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      cause: this.cause,
      hint: this.hint,
      effects: this.effects,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(this.warnings ? { warnings: this.warnings } : {}),
    };
  }
}

export function isToolError(err) {
  return Boolean(err && err.code && Object.prototype.hasOwnProperty.call(ERROR_CODES, err.code));
}
