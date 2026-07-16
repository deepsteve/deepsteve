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
// Dependency-free and fully injectable so unit tests can drive tick() with a
// fake clock.

function createSleepWatch({
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
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
    lastWakeAt() { return lastWakeAt; },
    // Ms until it is safe to treat client silence as real absence again.
    // 0 when no wake has been detected (or the holdoff has fully elapsed).
    holdoffRemaining(holdoffMs) {
      if (!lastWakeAt) return 0;
      return Math.max(0, lastWakeAt + holdoffMs - now());
    },
  };
}

module.exports = { createSleepWatch };
