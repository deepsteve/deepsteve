/**
 * Auth self-heal for tabs whose auth cookie is missing or stale (#540, #675).
 *
 * The auth cookie is issued only on a full HTML page load (setAuthCookie in
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
 *
 * Since #674 this is a PRE-FLIGHT gate, not just a diagnosis after the fact.
 * ws-open.js awaits the verdict below and refuses to emit a handshake the server
 * has already said it will reject — because the failed handshake itself is the
 * expensive part: it arms a FailDelay entry shared by every socket in the
 * browser. Healing after the damage is done was always the weaker half.
 *
 * WHO CALLS THIS (#675): originally only the two reconnect loops, which made the
 * heal reachable only after a socket had dropped. A realm whose sockets were
 * fine — or which holds none, as every mod iframe does — polled 401s forever
 * instead: one stale cookie produced 1,643 daemon-log rejections over 25+
 * minutes, through a restart and a page reload, because nothing it did counted
 * as a socket failure. The fetch wrapper in client-log.js now calls it too, so
 * any 401/429 heals, whatever raised it. The guards below are what keep that
 * safe: a genuinely unauthorized page reloads once a minute, not in a loop.
 */

import { nsKey } from './storage-namespace.js';

// sessionStorage (per-tab, survives the reload, nsKey-prefixed so a DeepSteve
// nested in its own Baby Browser doesn't disarm the outer instance's heal):
// timestamp of the last heal-reload.
const GUARD_KEY = nsKey('deepsteve-auth-healed');
const HEAL_COOLDOWN_MS = 60_000;
const PROBE_COOLDOWN_MS = 2_000;

// fetch() has no default timeout, and since #674 callers AWAIT this probe before opening a
// socket — so a request that never settles would pin `inFlight` and park every reconnect
// loop in the window on one dead promise. Exactly the hazard server-probe.js's
// PROBE_TIMEOUT_MS exists for, and it bites harder here: the heal is only ever awaited in
// the state where /healthz just answered, so a stall is by construction NOT the benign
// "the server is still booting" reading. Well under ws-open.js's WS_BACKOFF_MAX_MS.
const PROBE_TIMEOUT_MS = 3_000;

let inFlight = null;
let lastProbe = 0;
// The last thing we actually learned about our cookie. Returned during the probe cooldown
// so a caller inside that window gets the last real reading rather than a shrug — see the
// verdict contract on maybeHealAuth().
let lastVerdict = 'unknown';

// Called from every successful WS open — re-arms the one-shot heal so a second
// restart shortly after a heal-reload can heal again immediately. An accepted upgrade is
// also the strongest possible evidence our cookie is good, so it settles the verdict too.
export function noteAuthOk() {
  lastVerdict = 'ok';
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
// up but rejecting our auth. Shared by every reconnect loop in the window; the
// module-level inFlight/lastProbe dedupe concurrent callers, so a 13-session
// restore burst costs one request, not thirteen. Do NOT "fix" a slow heal by
// giving each caller its own fetch: server-probe.js's header explains that
// /api/version 401s feed a single GLOBAL rate-limit bucket in security.js, and
// the shared inFlight is the only thing holding that call rate down.
//
// Resolves to a verdict, which since #674 is the point rather than a courtesy:
//
//   'ok'        the server accepted our cookie — go ahead and open the socket
//   'unauthed'  it answered 401/429 — the upgrade WILL be rejected, so the caller
//               must not emit it. This is true even when the reload below is
//               suppressed by HEAL_COOLDOWN_MS: knowing the handshake is doomed
//               and sending it anyway is precisely the thing that arms Firefox's
//               browser-global FailDelay entry and silences every other socket.
//   'down'      no answer at all (or the probe timed out) — say nothing; the
//               caller's /healthz gate owns that case
//   'unknown'   nothing has been learned yet
//   'reloading' a heal reload is already in flight; the page is leaving
export function maybeHealAuth() {
  if (window.__deepsteveReloadPending) return Promise.resolve('reloading');
  if (inFlight) return inFlight;
  if (Date.now() - lastProbe < PROBE_COOLDOWN_MS) return Promise.resolve(lastVerdict);
  lastProbe = Date.now();
  inFlight = (async () => {
    try {
      // Guarded so an engine without AbortSignal.timeout fails OPEN (no timeout) rather
      // than throwing here, which the catch below would read as 'down' on every probe.
      const signal = AbortSignal.timeout ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined;
      const res = await fetch('/api/version', { cache: 'no-store', signal });
      if (res.status !== 401 && res.status !== 429) {
        lastVerdict = 'ok';
        return lastVerdict;
      }
      lastVerdict = 'unauthed';
      let last = 0;
      try { last = Number(sessionStorage.getItem(GUARD_KEY)) || 0; } catch {}
      if (Date.now() - last < HEAL_COOLDOWN_MS) return lastVerdict;
      try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch {}
      console.warn('[auth-heal] server rejected our auth — reloading once to re-acquire the cookie');
      window.__deepsteveReloadPending = true;
      forcePageReload();
      return lastVerdict;
    } catch {
      lastVerdict = 'down'; // server down, unreachable, or the probe timed out
      return lastVerdict;
    } finally { inFlight = null; }
  })();
  return inFlight;
}

// Test seam only — inFlight/lastProbe/lastVerdict are module state that leaks across cases.
export function _reset() { inFlight = null; lastProbe = 0; lastVerdict = 'unknown'; }
