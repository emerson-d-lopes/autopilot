// Structured error codes.
//
// This file is a stub carrying only the two codes the profile track needs. The
// host-contract branch owns the full catalogue (tab_gone, ref_stale, timeout
// and the rest) and its version of this file replaces this one on merge. Keep
// the shape below identical to that branch's so the merge is a union of the
// code tables, not a rewrite of the callers.

/** @typedef {{code: string, message: string, cause: string, hint: string, effects: 'none'|'applied'|'unknown', retryable: boolean}} ToolError */

export const CODES = {
  browser_unknown: {
    cause: 'No connected browser matched the selector.',
    hint: 'Call list_connected_browsers and use one of the ids, labels or profiles it prints.',
    effects: 'none',
    retryable: false,
  },
  profile_ambiguous: {
    cause: 'More than one connected browser matched the selector.',
    hint: 'Narrow the selector, or pass browserId from list_connected_browsers.',
    effects: 'none',
    retryable: false,
  },
};

/**
 * Builds a failure body. `message` says what happened for this call, the rest
 * comes from the catalogue unless the caller overrides it.
 *
 * @param {string} code
 * @param {string} message
 * @param {Partial<ToolError>} [overrides]
 * @returns {ToolError}
 */
export function toolError(code, message, overrides = {}) {
  const entry = CODES[code] || {
    cause: 'unknown',
    hint: '',
    effects: 'unknown',
    retryable: false,
  };
  return { code, message, ...entry, ...overrides };
}

/** An Error carrying a structured body, so a throw survives the way to the caller. */
export class ToolFailure extends Error {
  constructor(code, message, overrides = {}) {
    super(message);
    this.name = 'ToolFailure';
    this.error = toolError(code, message, overrides);
  }
}
