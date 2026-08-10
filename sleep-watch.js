// Sleep/wake discontinuity detection (#563).
//
// macOS freezes the daemon (and all its timers) across system sleep, and runs it
// in short DarkWake maintenance windows while the user's browser stays suspended.
// Node has no power-event API, so we detect sleep the only portable way: a
// steady tick that notices when far more wall-clock time passed between ticks
// than the interval accounts for. Consumers use lastWakeAt()/holdoffRemaining()
// to avoid making "the peer is gone" decisions right after a wake, when the
// silence was the sleep's fault rather than the peer's.
//
// DELIBERATELY NOT GATED TO DARWIN (#621), despite the macOS framing above.
//
// #621 proposed gating this off on Linux, on the grounds that a rented server does
// not sleep. It isn't gated, for three reasons:
//
//   1. There is nothing to save. This spawns no process and calls no platform API —
//      it is two Date.now() calls on an unref'd 5s timer, in a daemon that already
//      runs a 1-second reclassifyWaiting sweep over every shell.
//   2. The benefit on Linux is real. Laptops suspend; GCE live-migration explicitly
//      pauses the guest and EC2 maintenance does the same; containers get
//      cgroup-frozen. Every one produces exactly the wall-clock discontinuity this
//      detects, and without it armDetachReap() reaps LIVE agent sessions whose
//      browsers were frozen at the same moment. That is a data-loss-shaped bug, and
//      it lands hardest on the rented box the issue is written for.
//   3. The symmetry with power-assertion.js is false. That one is gated because
//      `caffeinate` is a macOS binary and the gate prevents a per-tick ENOENT spawn.
//      This has no such dependency; it is portable by construction.
//
// `platform` is accepted for API symmetry with power-assertion.js and createLogRotator,
// and is reported by isPlatformRelevant() for diagnostics — but it must not gate start().
// test/unit/sleep-watch.test.js asserts the tick still runs under platform:'linux', so a
// future gate has to argue with a test rather than land quietly. If a kill switch is ever
// wanted, the right shape is an `enabled` flag defaulting to true everywhere.
//
// Dependency-free and fully injectable so unit tests can drive tick() with a
// fake clock.

function createSleepWatch({
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  platform = process.platform,
  tickMs = 5000,
  gapMs = 15000,
  onWake = null,
  log = console.log,
} = {}) {
  let lastTick = 0;
  let lastWakeAt = 0;
  let timer = null;

  function tick() {
    const t = now();
    if (lastTick > 0) {
      const gap = t - lastTick;
      if (gap > tickMs + gapMs) {
        lastWakeAt = t;
        log(`[sleep-watch] wake detected after ${Math.round(gap / 1000)}s`);
        if (onWake) {
          try { onWake(gap); } catch (e) { log(`[sleep-watch] onWake error: ${e.message}`); }
        }
      }
    }
    lastTick = t;
  }

  // Ms until it is safe to treat client silence as real absence again.
  // 0 when no wake has been detected (or the holdoff has fully elapsed).
  function holdoffRemaining(holdoffMs) {
    if (!lastWakeAt) return 0;
    return Math.max(0, lastWakeAt + holdoffMs - now());
  }

  // Ms a timer that has just fired should wait before acting, or 0 to act now.
  // Two independent reasons to hold off, and a consumer needs both:
  //   - a wake was detected recently (holdoffRemaining), or
  //   - THIS timer fired far later than it was due, which means the daemon was
  //     frozen before the tick that would have detected the wake could run.
  //     Overdue timers run in due-time order, so a consumer's timer can beat the
  //     detector's own overdue tick.
  //
  // Keyed on `dueAt`, NOT on when the timer was armed: a consumer that re-arms in a
  // loop (the #627 auto-close busy re-check) keeps one original arm time, and
  // measuring lateness from that would report permanent lateness and defer forever.
  // Extracted from armDetachReap (#563) when #627 became its second caller.
  function deferMsFor(dueAt, { holdoffMs, lateGraceMs = 10000 } = {}) {
    const remaining = holdoffRemaining(holdoffMs);
    return now() - dueAt > lateGraceMs ? Math.max(remaining, holdoffMs) : remaining;
  }

  return {
    start() {
      if (timer) return;
      lastTick = now();
      timer = setIntervalFn(tick, tickMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearIntervalFn(timer); timer = null; }
    },
    tick, // exposed for tests
    // Whether this platform is one where sleep is the COMMON cause of a gap. Purely
    // informational — everything above runs regardless (see the header). macOS system
    // sleep is routine; on Linux the same gap means suspend, a hypervisor pause, or a
    // frozen cgroup, which are rarer but not rare enough to stop watching for.
    isPlatformRelevant() { return platform === 'darwin'; },
    lastWakeAt() { return lastWakeAt; },
    holdoffRemaining,
    deferMsFor,
  };
}

module.exports = { createSleepWatch };
