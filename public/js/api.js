/**
 * Shared JSON-response helper (#676).
 *
 * authGate answers every rejection with a *text/plain* body — "Unauthorized"
 * (401), "Too Many Requests" (429), "Forbidden: Origin not allowed" (403).
 * Nothing on the server returns JSON on that path, so `r.json()` on the response
 * throws a SyntaxError, and callers that render `e.message` show "JSON.parse:
 * unexpected character at line 1 column 1" where the reason should be.
 * fetchJSON() reads the body as text and decides what it is, so a non-JSON error
 * surfaces as its status and not as a parse failure.
 *
 * The other half of #676 — a tab that never notices every request is now a 401 —
 * is NOT here: client-log.js already wraps every realm's fetch (#675), so that
 * wrapper reports the status to auth-heal.js and this module has no business
 * wrapping fetch a second time.
 */

export class HttpError extends Error {
  constructor(status, message, bodyText = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

/**
 * Human text for a status the *user* can act on. 401/429 are fixed by a reload
 * (GET / re-issues the cookie, and valid creds bypass the failure limiter, so
 * the reload works even mid-lockout); 403 is a Host/Origin misconfiguration and
 * is deliberately NOT described as reload-fixable — the same carve-out
 * auth-heal.js makes for the WebSocket path.
 */
export function authMessage(status) {
  if (status === 401) return 'Session expired — reload the page to sign in again.';
  if (status === 429) return 'Too many rejected requests — reload the page to sign in again.';
  if (status === 403) return 'Blocked by the server (403) — this tab is not allowed to call the API.';
  return `HTTP ${status}`;
}

// True for the statuses that mean "our credentials are the problem".
export function isAuthStatus(status) {
  return status === 401 || status === 403 || status === 429;
}

// Message for a failed response, preferring the server's own {error} when it
// sent JSON. Read as text first: calling .json() on "Unauthorized" is the bug.
async function errorMessage(res) {
  let text = '';
  try { text = await res.text(); } catch { /* body already consumed or torn down */ }
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.error === 'string' && parsed.error) {
        return { message: parsed.error, text };
      }
    } catch { /* not JSON — fall through to the status-derived message */ }
  }
  return { message: authMessage(res.status), text };
}

/**
 * fetch + parse, or throw an HttpError whose message a user can read.
 * Rejects with HttpError on a non-ok status AND on an ok response whose body
 * isn't JSON; a network failure still rejects with the underlying TypeError.
 */
export async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const { message, text } = await errorMessage(res);
    throw new HttpError(res.status, message, text);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const type = res.headers?.get?.('content-type') || 'unknown';
    throw new HttpError(res.status, `Server sent ${type} where JSON was expected (HTTP ${res.status})`, text);
  }
}
