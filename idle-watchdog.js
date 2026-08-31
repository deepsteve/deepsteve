// Idle self-shutdown for a disposable daemon (#678).
//
// A forgotten test instance holds a port, a tmux socket and live PTYs for as long as
// the machine is up, and nothing in the tree has ever reaped one — `pruneClosedSessions()`
// only sweeps tombstones, and the detach reaper deliberately keeps a tmux-backed session
// alive forever when its last client leaves (server.js says in place that if that growth
// ever bites, the fix is an idle sweep; this is that sweep, scoped to daemons that are
// throwaway by construction).
//
// It is armed ONLY on a disposable daemon — see disposable.js, which is what makes
// "the daemon may shut itself down" a safe sentence to write at all.
//
// Three properties, and each one is a way this could have been wrong:
//
//  1. ACTIVITY, not attachment. A browser being closed is not idleness: an unattended
//     agent chewing through a scheduled run has no client and must not be killed. So the
//     baseline maxes session activity (PTY output and real user input, which server.js
//     already stamps as lastActivity/lastInputTime) with client presence. Silence in both
//     is the only thing that counts.
//  2. SLEEP-AWARE. macOS freezes the daemon across system sleep, so an eight-hour
//     overnight gap arrives as one tick with eight hours on the clock — which is not
//     eight hours of idleness, it is eight hours of nobody being asked. A wake resets the
//     baseline, the same reasoning the detach reaper already applies via sleepWatch.
//  3. ONCE. The teardown raises SIGTERM against its own process; a second firing during
//     the graceful shutdown window would re-enter it.
//
// Dependency-free and fully injectable so unit tests can drive the whole matrix on a fake
// clock (same shape as sleep-watch.js, pending-opens.js and session-auto-close.js), and so
// it stays require-able from the bare CI unit job.

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_TICK_MS = 60 * 1000;
// How late a tick may be before we read the lateness as a freeze rather than jitter.
// Same 10s grace sleep-watch's deferMsFor() uses for the same question.
const LATE_GRACE_MS = 10000;

function createIdleWatchdog({
  idleMs = DEFAULT_IDLE_MS,
  tickMs = DEFAULT_TICK_MS,
  clientCount = () => 0,          // () => live browser (reload) clients
  lastActivityAt = () => 0,       // () => newest session activity stamp, 0 for none
  holdoffRemaining = () => 0,     // () => ms of post-wake holdoff still owed
  isShuttingDown = () => false,
  onIdle = () => {},
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = () => {},
} = {}) {
  let timer = null;
  let baseline = 0;    // the most recent moment this daemon was demonstrably in use
  let lastTickAt = 0;  // for the overdue check below
  let fired = false;
  const intervalMs = Math.max(1, Math.min(tickMs, idleMs > 0 ? idleMs : tickMs));

  // Idle since whichever happened last: the daemon booted, someone was attached, or a
  // session produced output. An absent or stale activity stamp reads as 0 and simply
  // loses the max, leaving `baseline` in charge — so a daemon with no sessions at all
  // still has a well-defined idle clock.
  function idleSince() {
    return Math.max(baseline, lastActivityAt() || 0);
  }

  function tick() {
    if (fired || isShuttingDown()) return;
    const t = now();
    const prevTick = lastTickAt;
    lastTickAt = t;

    // System sleep freezes the daemon, so an overnight suspend arrives as ONE tick with
    // eight hours on the clock. That is not eight hours of idleness — it is eight hours
    // of nobody being asked, and firing on it would tear the daemon down at the exact
    // moment the user opened the lid. Two independent detectors, because either alone
    // has a hole: our own tick being wildly overdue (works even before sleepWatch's 5s
    // tick has run), and sleepWatch's post-wake holdoff (works when our tick happened to
    // land after the freeze rather than across it).
    const overdue = prevTick > 0 && (t - prevTick) > intervalMs + LATE_GRACE_MS;
    if (overdue || holdoffRemaining() > 0) {
      baseline = t;
      return;
    }

    if (clientCount() > 0) {
      baseline = t;
      return;
    }

    const idleFor = t - idleSince();
    if (idleFor < idleMs) return;

    fired = true;
    stop();
    log(`[idle-watchdog] no clients and no session activity for ${Math.round(idleFor / 1000)}s — shutting down`);
    try { onIdle(idleFor); } catch (e) { log(`[idle-watchdog] onIdle error: ${e.message}`); }
  }

  function start() {
    if (timer) return false;
    if (!(idleMs > 0)) {
      log('[idle-watchdog] disabled (idle timeout is 0)');
      return false;
    }
    baseline = now();
    lastTickAt = 0;
    timer = setIntervalFn(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`[idle-watchdog] armed — will shut down after ${Math.round(idleMs / 1000)}s idle`);
    return true;
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,                             // exposed for tests; the interval is the only caller otherwise
    get running() { return timer !== null; },
    get fired() { return fired; },
    idleSince,
  };
}

module.exports = { createIdleWatchdog, DEFAULT_IDLE_MS, DEFAULT_TICK_MS };
