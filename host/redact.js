// Output caps and credential-shaped redaction, applied on the host read path.
//
// Capture stays passive: the extension keeps recording everything, and the caps
// here bound only what a read returns. That preserves the passive-tracking
// advantage while keeping a single unfiltered read from blowing the transfer
// budget.
//
// The redaction keys on the shape of the value, never on the page URL. Keying
// on the URL is what makes the official extension blank plain `location.href`
// reads, and a filter that fires on ordinary work gets turned off.

// S5. Per-entry caps for the two capture readers.
export const URL_CAP = 300;
export const MESSAGE_CAP = 500;

// S6. Caps for a javascript result.
export const STRING_CAP = 10 * 1024;
export const ARRAY_CAP = 1000;
export const SERIALIZED_CAP = 50 * 1024;

const MAX_DEPTH = 20;

function clipTo(text, max) {
  const s = String(text);
  if (s.length <= max) return { text: s, clipped: false };
  return { text: s.slice(0, max - 3) + '...', clipped: true };
}

// ---------------------------------------------------------------------------
// F2. Credential-shaped values
// ---------------------------------------------------------------------------

/** Key names whose value is a credential whatever it looks like. */
export const SENSITIVE_KEY =
  /password|passwd|secret|api[_-]?key|credential|private[_-]?key|access[_-]?key|bearer|oauth/i;

/** Cookies get their own check so a key called exactly "cookie" is caught. */
export function isCookieKey(key) {
  return /^cookies?$/i.test(String(key));
}

/**
 * Distinct characters in a string, capped so the count is cheap on a long one.
 *
 * A repeated letter matches every token charset there is, so length alone
 * cannot separate a real token from 'x'.repeat(200000). Character variety can.
 */
function distinctChars(s, sampleLimit = 4096) {
  const seen = new Set();
  const end = Math.min(s.length, sampleLimit);
  for (let i = 0; i < end; i++) {
    seen.add(s[i]);
    if (seen.size > 32) break;
  }
  return seen.size;
}

/** Three base64url segments, the way a JWT is built. */
export function looksLikeJwt(s) {
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p) && p.length >= 10)) return false;
  if (s.length < 60) return false;
  return parts[0].startsWith('ey') || parts.every((p) => p.length >= 20);
}

/** 32 or more hex characters with the variety a real token has. */
export function looksLikeHexToken(s) {
  if (!/^[0-9a-fA-F]{32,}$/.test(s)) return false;
  return distinctChars(s) >= 8;
}

/** 200 or more base64 characters, no spaces, with the variety a real blob has. */
export function looksLikeBase64Blob(s) {
  if (s.length < 200) return false;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(s)) return false;
  if (/\s/.test(s.replace(/[\r\n]/g, ''))) return false;
  if (distinctChars(s) < 16) return false;
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/** Two or more `name=value; ` pairs, the way document.cookie serializes. */
export function looksLikeCookieString(s) {
  if (s.length > 8192) return false;
  if (!/;/.test(s)) return false;
  const pairs = s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length < 2) return false;
  return pairs.every((p) => /^[\w.%-]+=[^;]*$/.test(p));
}

/** The credential shape a string has, or null when it is ordinary text. */
export function credentialShape(value) {
  const s = String(value);
  if (s.length < 8) return null;
  // A URL is ordinary even with a query string, and it can never be one of the
  // shapes below, so the early exit only saves work.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  if (looksLikeCookieString(s)) return 'a cookie string';
  if (s.length < 20) return null;
  if (looksLikeJwt(s)) return 'a JWT';
  if (looksLikeHexToken(s)) return 'a long hex token';
  if (looksLikeBase64Blob(s)) return 'a long base64 blob';
  return null;
}

/**
 * Walks a value, blanking credential-shaped strings and the values of keys
 * whose name says they hold a credential.
 *
 * @returns {{value: any, warnings: string[]}}
 */
export function redactValue(input) {
  const warnings = [];
  const seen = new WeakSet();

  function walk(value, path, depth) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      const shape = credentialShape(value);
      if (shape) {
        warnings.push('redacted ' + shape + ' at ' + path);
        return '[redacted]';
      }
      return value;
    }

    if (typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[depth limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item, i) => walk(item, path + '[' + i + ']', depth + 1));

    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const here = path + '.' + key;
      if (isCookieKey(key)) {
        warnings.push('redacted the value of key "' + key + '" at ' + here);
        out[key] = '[redacted]';
        continue;
      }
      if (SENSITIVE_KEY.test(key)) {
        warnings.push('redacted the value of key "' + key + '" at ' + here);
        out[key] = '[redacted]';
        continue;
      }
      out[key] = walk(item, here, depth + 1);
    }
    return out;
  }

  return { value: walk(input, '$', 0), warnings };
}

// ---------------------------------------------------------------------------
// S6. Size caps for a javascript result
// ---------------------------------------------------------------------------

/**
 * Caps individual strings and arrays before serializing.
 *
 * A 200000-character string is truncated here and the warning names the real
 * size, which is what a caller needs. Discarding the value outright, the way
 * the official extension does, is a worse answer than a short one.
 */
export function capValue(input) {
  const warnings = [];
  const seen = new WeakSet();

  function walk(value, path, depth) {
    if (typeof value === 'string') {
      if (value.length <= STRING_CAP) return value;
      warnings.push('string at ' + path + ' truncated to ' + STRING_CAP + ' chars, full length ' + value.length);
      return value.slice(0, STRING_CAP) + '\n[truncated, full length ' + value.length + ' chars]';
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[depth limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const kept = value.slice(0, ARRAY_CAP).map((item, i) => walk(item, path + '[' + i + ']', depth + 1));
      if (value.length > ARRAY_CAP) {
        warnings.push('array at ' + path + ' truncated to ' + ARRAY_CAP + ' items, full length ' + value.length);
        kept.push('[truncated, ' + (value.length - ARRAY_CAP) + ' more items]');
      }
      return kept;
    }

    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, path + '.' + key, depth + 1);
    return out;
  }

  return { value: walk(input, '$', 0), warnings };
}

/**
 * Redacts, caps, then serializes a javascript result.
 *
 * @returns {{value: any, serialized: string, warnings: string[], truncated: boolean, fullLength: number}}
 */
export function prepareScriptValue(input) {
  const redacted = redactValue(input);
  const capped = capValue(redacted.value);
  const warnings = [...redacted.warnings, ...capped.warnings];

  let value = capped.value;
  let serialized = '';
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch (err) {
    serialized = '[unserializable: ' + err.message + ']';
    value = serialized;
  }

  const fullLength = serialized.length;
  let truncated = false;
  if (fullLength > SERIALIZED_CAP) {
    truncated = true;
    serialized = serialized.slice(0, SERIALIZED_CAP) + '\n[truncated]';
    value = serialized;
    warnings.push(
      'output_truncated: the serialized value is ' + fullLength + ' characters, cut to ' + SERIALIZED_CAP + '.'
    );
  }

  return { value, serialized, warnings, truncated, fullLength };
}

// ---------------------------------------------------------------------------
// S5. Caps for the two capture readers
// ---------------------------------------------------------------------------

/** Caps each URL and fills in total and returned when the extension omitted them. */
export function capNetworkResult(result) {
  if (!result || !Array.isArray(result.requests)) return { result, warnings: [] };
  const warnings = [];
  let clippedUrls = 0;
  let longestClipped = 0;

  const requests = result.requests.map((entry) => {
    if (!entry || typeof entry.url !== 'string') return entry;
    const { text, clipped } = clipTo(entry.url, URL_CAP);
    if (!clipped) return entry;
    clippedUrls += 1;
    longestClipped = Math.max(longestClipped, entry.url.length);
    return { ...entry, url: text, urlLength: entry.url.length };
  });

  const returned = result.returned ?? requests.length;
  const total = result.total ?? returned;
  // How much was clipped, not just that something was: a reader could not tell
  // a URL cut by three characters from one cut by five hundred.
  if (clippedUrls) {
    warnings.push(
      clippedUrls + ' URL(s) clipped to ' + URL_CAP + ' characters, the longest was ' + longestClipped + '.'
    );
  }
  if (total > returned) warnings.push('showing ' + returned + ' of ' + total + ' captured requests.');

  return {
    result: {
      ...result,
      requests,
      returned,
      total,
      clipped: clippedUrls,
      clippedTo: URL_CAP,
      longestClipped: clippedUrls ? longestClipped : undefined,
    },
    warnings,
  };
}

/** Caps each message and fills in total and returned when the extension omitted them. */
export function capConsoleResult(result) {
  if (!result || !Array.isArray(result.entries)) return { result, warnings: [] };
  const warnings = [];
  let clipped = 0;
  let longestClipped = 0;

  const entries = result.entries.map((entry) => {
    if (!entry || typeof entry.text !== 'string') return entry;
    const capped = clipTo(entry.text, MESSAGE_CAP);
    if (!capped.clipped) return entry;
    clipped += 1;
    longestClipped = Math.max(longestClipped, entry.text.length);
    return { ...entry, text: capped.text, textLength: entry.text.length };
  });

  const returned = result.returned ?? entries.length;
  const total = result.total ?? returned;
  if (clipped) {
    warnings.push(
      clipped + ' message(s) clipped to ' + MESSAGE_CAP + ' characters, the longest was ' + longestClipped + '.'
    );
  }
  if (total > returned) warnings.push('showing ' + returned + ' of ' + total + ' captured messages.');

  return {
    result: {
      ...result,
      entries,
      returned,
      total,
      clipped,
      clippedTo: MESSAGE_CAP,
      longestClipped: clipped ? longestClipped : undefined,
    },
    warnings,
  };
}

/**
 * Applies whichever caps a tool needs.
 *
 * @returns {{result: any, warnings: string[]}}
 */
export function applyCaps(tool, result) {
  if (!result || typeof result !== 'object') return { result, warnings: [] };

  if (tool === 'read_network_requests') return capNetworkResult(result);
  if (tool === 'read_console_messages') return capConsoleResult(result);

  if (tool === 'javascript') {
    // The extension returns the evaluated value under `result`, so that is what
    // gets redacted, capped and re-serialized.
    const prepared = prepareScriptValue(result.result);
    const next = { ...result, result: prepared.value };
    if (prepared.truncated) {
      next.truncated = true;
      next.totalChars = prepared.fullLength;
    }
    return { result: next, warnings: prepared.warnings };
  }

  return { result, warnings: [] };
}
