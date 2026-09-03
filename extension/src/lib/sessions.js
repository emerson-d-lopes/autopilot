// Which sites this profile is signed into.
//
// The point is choosing a profile, not reading credentials. A caller that has
// three Chrome profiles open needs to know which one has the LinkedIn session
// before it starts driving one of them. So this reports cookie names and
// presence only. No cookie value ever leaves this module, and none is logged.
//
// The table below is the set of sites where one well-known cookie name is a
// reliable sign of a logged-in session. For anything else, the heuristic looks
// for the shape a session cookie has (secure, httpOnly, an expiry past the end
// of the browsing session) and says so, because a guess presented as a fact is
// worse than no answer.

/** domain -> the cookie names that mean "signed in". */
export const SESSION_COOKIES = {
  'linkedin.com': [{ name: 'li_at' }],
  'github.com': [{ name: 'logged_in', value: 'yes' }, { name: 'user_session' }],
  'google.com': [{ name: 'SID' }],
  'x.com': [{ name: 'auth_token' }],
  'notion.so': [{ name: 'token_v2' }],
  'reddit.com': [{ name: 'reddit_session' }],
  'amazon.com': [{ name: 'x-main' }],
  'facebook.com': [{ name: 'c_user' }],
  'instagram.com': [{ name: 'sessionid' }],
};

export const SESSION_DOMAINS = Object.keys(SESSION_COOKIES);

/** Registrable domain of a URL or bare host, best effort without a public suffix list. */
export function registrableDomain(input) {
  let host = String(input || '').trim();
  if (!host) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname;
    else if (host.includes('/')) host = new URL('https://' + host).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase();
  if (!host || /^\d+(\.\d+){3}$/.test(host) || !host.includes('.')) return host || null;

  const parts = host.split('.');
  // co.uk, com.br and friends need three labels to be registrable.
  const twoLevel = /^(co|com|net|org|gov|edu|ac|or|ne|go)$/;
  if (parts.length > 2 && parts[parts.length - 1].length === 2 && twoLevel.test(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** True when a cookie has the shape a login cookie has. */
export function looksLikeLoginCookie(cookie) {
  if (!cookie || !cookie.secure || !cookie.httpOnly) return false;
  if (cookie.session) return false;
  return typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 > Date.now();
}

async function cookiesFor(domain) {
  if (!globalThis.chrome || !chrome.cookies || typeof chrome.cookies.getAll !== 'function') return [];
  try {
    const found = await chrome.cookies.getAll({ domain });
    return Array.isArray(found) ? found : [];
  } catch {
    // The cookies permission can be absent on an older install of the extension.
    return [];
  }
}

/** True when the profile holds the session cookie the table names for `domain`. */
export async function hasSession(domain) {
  const wanted = SESSION_COOKIES[domain];
  if (!wanted) return false;
  const cookies = await cookiesFor(domain);
  return wanted.some((want) =>
    cookies.some((cookie) => cookie.name === want.name && (want.value === undefined || cookie.value === want.value))
  );
}

/**
 * The table domains this profile is signed into.
 *
 * @param {string[]} [domains] subset to check, defaults to the whole table
 * @returns {Promise<string[]>}
 */
export async function listSessions(domains) {
  const wanted = (domains && domains.length ? domains : SESSION_DOMAINS).filter((d) => SESSION_COOKIES[d]);
  const found = [];
  for (const domain of wanted) {
    if (await hasSession(domain)) found.push(domain);
  }
  return found;
}

/**
 * Session state for one URL or host.
 *
 * A domain in the table gets a definite answer. Anything else gets the
 * heuristic, marked as one.
 *
 * @returns {Promise<{domain: string|null, likely: boolean, heuristic: boolean, cookies?: string[]}>}
 */
export async function sessionsFor(url) {
  const domain = registrableDomain(url);
  if (!domain) return { domain: null, likely: false, heuristic: true };

  if (SESSION_COOKIES[domain]) {
    return { domain, likely: await hasSession(domain), heuristic: false };
  }

  const cookies = await cookiesFor(domain);
  const candidates = cookies.filter(looksLikeLoginCookie);
  return {
    domain,
    likely: candidates.length > 0,
    heuristic: true,
    // Names only. Values are never read out of this module.
    cookies: candidates.map((c) => c.name).slice(0, 10),
  };
}
