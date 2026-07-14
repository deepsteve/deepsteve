/**
 * Auth self-heal for cookieless tabs (#540).
 *
 * The ds_auth cookie is issued only on a full HTML page load (setAuthCookie in
 * security.js), but a daemon restart makes open tabs silently reconnect their
 * WebSocket without reloading — so a tab that lacks the cookie has every WS
 * upgrade rejected by verifyWsClient forever and looks broken.
 *
 * The browser WebSocket API never exposes the HTTP status of a failed upgrade
 * (always close code 1006, identical for "server down" and "auth rejected"),
 * so the reconnect loops call maybeHealAuth() to disambiguate over HTTP: a
 * same-origin fetch auto-sends the HttpOnly cookie and gets a readable status
 * from authGate. 401/429 while the server answers means our auth is broken and
 * a reload will fix it — GET / always re-issues the cookie, and valid creds
 * bypass the failure rate limiter, so the heal works even mid-lockout. A 403
 * (valid cookie + disallowed Origin/Host misconfig) is NOT healable by reload.
 */

import { nsKey } from './storage-namespace.js';

// sessionStorage (per-tab, survives the reload, nsKey-prefixed so a DeepSteve
// nested in its own Baby Browser doesn't disarm the outer instance's heal):
// timestamp of the last heal-reload.
const GUARD_KEY = nsKey('deepsteve-auth-healed');
const HEAL_COOLDOWN_MS = 60_000;
const PROBE_COOLDOWN_MS = 2_000;

let inFlight = null;
let lastProbe = 0;

// Called from every successful WS open — re-arms the one-shot heal so a second
// restart shortly after a heal-reload can heal again immediately.
export function noteAuthOk() {
  try { sessionStorage.removeItem(GUARD_KEY); } catch {}
}

// Force a page reload via <meta http-equiv="refresh"> instead of
// location.reload(). Firefox blocks location.reload() when ANY beforeunload
// handler is registered (app.js registers one), regardless of what the handler
// does. Meta refresh bypasses beforeunload entirely.
// onWatchdogFallback (optional) runs if the meta-refresh silently fails to
// navigate, after the reload flag is cleared and before location.replace.
export function forcePageReload(onWatchdogFallback) {
  const meta = document.createElement('meta');
  meta.httpEquiv = 'refresh';
  meta.content = '0;url=' + location.pathname + '?_=' + Date.now();
  document.head.appendChild(meta);
  // Watchdog: if meta-refresh silently fails to navigate, clear the
  // reload flag so per-tab WS reconnects resume instead of wedging.
  setTimeout(() => {
    console.warn('[auth-heal] meta-refresh did not navigate, falling back');
    window.__deepsteveReloadPending = false;
    if (onWatchdogFallback) onWatchdogFallback();
    location.replace(location.pathname + '?_=' + Date.now());
  }, 3000);
}

// Probe an authenticated endpoint (cookie auto-sent on same-origin fetch,
// /api/version is cheap and side-effect free) and reload once if the server is
// up but rejecting our auth. No-op on 2xx (auth fine — the WS failure is
// something else) and on network error (server down — the caller's reconnect
// loop keeps waiting). Shared by every reconnect loop in the window; the
// module-level inFlight/lastProbe dedupe concurrent callers.
export function maybeHealAuth() {
  if (window.__deepsteveReloadPending) return;
  if (inFlight) return;
  if (Date.now() - lastProbe < PROBE_COOLDOWN_MS) return;
  lastProbe = Date.now();
  inFlight = (async () => {
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (res.status !== 401 && res.status !== 429) return;
      let last = 0;
      try { last = Number(sessionStorage.getItem(GUARD_KEY)) || 0; } catch {}
      if (Date.now() - last < HEAL_COOLDOWN_MS) return;
      try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch {}
      console.warn('[auth-heal] WS auth rejected — reloading once to re-acquire the ds_auth cookie');
      window.__deepsteveReloadPending = true;
      forcePageReload();
    } catch { /* server down — reconnect loop keeps waiting */ }
    finally { inFlight = null; }
  })();
}
