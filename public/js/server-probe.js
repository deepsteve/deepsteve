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

import { onWake } from './wake-watch.js';

// Growth starts small so a normal ~2-3s daemon restart is still noticed promptly (probes
// land at roughly 0, 0.25, 0.6, 1.2, 2.0, 3.3s — the first five delays all sit under the
// cap, so that case is governed by BASE_DELAY_MS and GROWTH alone), while the cap keeps a
// tab left open against a long-dead server from polling forever.
//
// MAX_DELAY_MS is load-bearing in a second, non-obvious place (#665). It is the worst-case
// gap between two probes, so it bounds how long a *loaded* browser can take to notice the
// daemon is back — and server.js's AUTO_OPEN_GRACE_MS has to out-wait exactly that, or the
// daemon pops a tab over a browser that was about to reconnect on its own. At 5s the two
// were equal and the guard lost its own race by ~300ms. Keep them in step; a unit test
// (test/unit/server-probe.test.js) pins the relationship. The lower cap costs nothing that
// matters: one localhost fetch every 1.5s per JS realm while the server is actually down,
// and concurrent callers still collapse onto one via inFlight.
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 1_500;
const GROWTH = 1.5;
const JITTER_FRAC = 0.25;

// A probe that never settles is strictly worse than a probe that fails. `inFlight` below is
// shared by every reconnect loop in the window, so ONE hung fetch parks all of them on the
// same dead promise for as long as it hangs — and kickProbes() cannot dig them out, because
// it resolves the sleep and the next call hands back that very promise. fetch() has no
// default timeout, so this abort is the only thing bounding it.
//
// Deliberately generous, because a stalled probe is sometimes the correct reading: /healthz
// shares the WS server's event loop, and a boot that blocks it for seconds (state restore,
// the scheduled-task worktree sweep) should make us WAIT rather than hammer. Aborting does
// not hammer — it just lets the backoff schedule run again instead of waiting forever.
const PROBE_TIMEOUT_MS = 5_000;

// NO success cache here, deliberately. Caching a recent "yes" for even ~250ms reintroduces
// the exact bug this module exists to prevent: when the daemon restarts, every socket in
// the window drops at once, and a cached "yes" would wave them all straight past the gate
// into failed handshakes — pinning the browser-global FailDelay at its 60s cap. A probe is
// one localhost fetch (~1-2ms); the truth is worth more than the round trip. Concurrent
// callers (restoreSessions' parallel connects) already collapse onto one fetch via
// inFlight, which is the only sharing that actually matters.
let inFlight = null;

// Test seam only — lets the wedge test exercise the abort without a 5s wall clock.
let probeTimeoutMs = PROBE_TIMEOUT_MS;
export function _setProbeTimeout(ms) { probeTimeoutMs = ms; }

// Attribution for the next slow reload (#665 shipped the daemon half of this). The
// [startup] marks can say "the browser took 59s to come back"; only the page can say
// whether that was probes that never ran, a probe that ran and hung, or a navigation that
// stalled after the gate had already opened. Monotonic for the life of the page, so
// callers diff a before/after snapshot rather than coordinating a reset.
let probeCount = 0;
let slowestProbeMs = 0;

/** Counters for a caller that wants to describe how a wait actually went. */
export function probeStats() { return { probes: probeCount, slowestProbeMs }; }

// Resolvers for every waitForServer() currently sleeping between probes (#665). A wake
// means the world changed under us — the machine resumed, the network came back, the tab
// came forward — so cut the sleep short AND drop back to BASE_DELAY_MS rather than
// resuming a ramp that was measured against the old world. Same contract as ws-client.js's
// kickWait, which resets wsFailures for the same reason.
//
// Note wake-watch's 3s debounce is shared by ALL its subscribers, so a kick landing within
// 3s of ws-client's own wake is swallowed. That is fine at a 1.5s cap — the loop is never
// more than one ordinary delay from a fresh probe anyway.
const waiters = new Set();

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Cut every sleeping probe loop short and reset its backoff. */
export function kickProbes() {
  for (const kick of [...waiters]) kick();
}

// Safe at module scope: wake-watch touches document/window only inside its init(), so
// importing it here keeps server-probe.js importable in plain Node for unit tests.
// Deliberately NOT guarded on window.__deepsteveReloadPending the way ws-client.js is — a
// pending reload is precisely the case that wants the fastest possible probe, since
// live-reload.js's pollAndReload() is the loop waiting on it.
onWake(kickProbes);

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
  const startedAt = Date.now();
  const p = (async () => {
    try {
      // The guard makes a hypothetical engine without AbortSignal.timeout fail OPEN (no
      // timeout) rather than throw here — a throw is caught below and would read as "server
      // down" on every probe, wedging the gate shut instead of merely slowly.
      const signal = AbortSignal.timeout ? AbortSignal.timeout(probeTimeoutMs) : undefined;
      const res = await fetch('/healthz', { cache: 'no-store', signal });
      return res.ok;
    } catch {
      return false; // server down, unreachable, or the probe timed out
    } finally {
      probeCount++;
      slowestProbeMs = Math.max(slowestProbeMs, Date.now() - startedAt);
      inFlight = null;
    }
  })();
  inFlight = p;
  return p;
}

/**
 * Interruptible sleep for the backoff between probes. Resolves true if kickProbes() cut it
 * short, false if the timer simply ran out — which is what tells the caller whether to keep
 * ramping or start the schedule over. Mirrors ws-client.js's wait()/kickWait pair.
 */
function sleepOrKick(ms) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (kicked) => {
      clearTimeout(timer);
      waiters.delete(kick);
      resolve(kicked);
    };
    const kick = () => finish(true);
    timer = setTimeout(() => finish(false), ms);
    waiters.add(kick);
  });
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
    const kicked = await sleepOrKick(jitter(delay));
    delay = kicked ? BASE_DELAY_MS : Math.min(MAX_DELAY_MS, delay * GROWTH);
  }
}

// Test seam only — lets unit tests assert the schedule without hard-coding magic numbers.
export const _config = { BASE_DELAY_MS, MAX_DELAY_MS, GROWTH, JITTER_FRAC, PROBE_TIMEOUT_MS };
export function _reset() { inFlight = null; probeTimeoutMs = PROBE_TIMEOUT_MS; kickProbes(); }
