/**
 * Shared "is the server up?" probe (#553).
 *
 * WHY THIS EXISTS — the expensive thing is a FAILED WebSocket handshake, not a failed
 * HTTP request. Firefox implements RFC 6455 §7.2.3 in WebSocketChannel.cpp:
 *
 *   - Every failed handshake ramps a FailDelay entry (mNextDelay *= 1.5, capped at
 *     kWSReconnectMaxDelay = 60s).
 *   - A later connect to a delayed host doesn't hit the network at all: DelayOrBegin()
 *     parks it in CONNECTING_DELAYED behind a timer. No traffic, NO error event — it
 *     just sits in readyState CONNECTING. That silence is the "~4s hang" in #553.
 *   - Entries are keyed on {address, path, port, originSuffix}, and `path` comes from
 *     GetFilePath() which EXCLUDES the query string. Every DeepSteve socket is
 *     ws://host/?params → path "/" → *every socket in the browser shares ONE entry*,
 *     across tabs, windows, and nested Baby Browser instances. One tab poisons all.
 *   - An entry only expires 60s + mNextDelay after the LAST failure, so a client that
 *     keeps retrying keeps it alive forever, pinned at the cap. This is why no retry
 *     schedule can dig us out: BACKOFF CANNOT FIX THIS. The only winning move is to
 *     never create the entry.
 *
 * So: probe over HTTP (fetch runs through nsHttpChannel — a different subsystem with no
 * shared failure accounting, hence no WS penalty) and only open a WebSocket once the
 * server actually answers. Cost while connected: zero probes. You pay per outage.
 *
 * Why /healthz and not /api/version: /healthz is unauthenticated (server.js), so probing
 * it is free. A 401 from /api/version calls recordFailure() in security.js, which feeds a
 * single GLOBAL rate-limit bucket (no IP keying) — cookieless tabs polling it could trip a
 * process-wide 429 lockout. /healthz also shares the WS server's event loop, so if that
 * loop is blocked the probe stalls too and we correctly WAIT instead of hammering.
 *
 * Caveat callers must handle: /healthz says nothing about our auth cookie. "Server up"
 * does not imply "our upgrade will be accepted" — call maybeHealAuth() after a gate pass.
 */

// Growth starts small so a normal ~2-3s daemon restart is still noticed promptly (probes
// land at roughly 0, 0.25, 0.6, 1.2, 2.0, 3.3s), while the cap keeps a tab left open
// against a long-dead server from polling forever.
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;
const GROWTH = 1.5;
const JITTER_FRAC = 0.25;

// NO success cache here, deliberately. Caching a recent "yes" for even ~250ms reintroduces
// the exact bug this module exists to prevent: when the daemon restarts, every socket in
// the window drops at once, and a cached "yes" would wave them all straight past the gate
// into failed handshakes — pinning the browser-global FailDelay at its 60s cap. A probe is
// one localhost fetch (~1-2ms); the truth is worth more than the round trip. Concurrent
// callers (restoreSessions' parallel connects) already collapse onto one fetch via
// inFlight, which is the only sharing that actually matters.
let inFlight = null;

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * ±JITTER_FRAC around ms. Decorrelates separate JS realms — multiple windows and nested
 * Baby Browser instances can't share the module-level dedupe below, since each nesting
 * level is its own module instance.
 */
export function jitter(ms, frac = JITTER_FRAC) {
  const spread = ms * frac;
  return Math.max(0, ms - spread + Math.random() * 2 * spread);
}

/** One deduped /healthz probe. Resolves true iff the server answered OK. Never throws. */
export function serverUp() {
  if (inFlight) return inFlight;
  // Assign to a local first: `finally` nulls the field before callers read it back.
  const p = (async () => {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      return res.ok;
    } catch {
      return false; // server down / unreachable
    } finally {
      inFlight = null;
    }
  })();
  inFlight = p;
  return p;
}

/**
 * Poll until the server answers. Resolves true when it does, or false if shouldStop()
 * goes true first (a closed socket / unloading page). Probes immediately, so the common
 * "server is fine" case costs one localhost fetch (~1-2ms) and no delay.
 */
export async function waitForServer(shouldStop = () => false) {
  let delay = BASE_DELAY_MS;
  for (;;) {
    if (shouldStop()) return false;
    if (await serverUp()) return true;
    if (shouldStop()) return false;
    await sleep(jitter(delay));
    delay = Math.min(MAX_DELAY_MS, delay * GROWTH);
  }
}

// Test seam only — lets unit tests assert the schedule without hard-coding magic numbers.
export const _config = { BASE_DELAY_MS, MAX_DELAY_MS, GROWTH, JITTER_FRAC };
export function _reset() { inFlight = null; }
