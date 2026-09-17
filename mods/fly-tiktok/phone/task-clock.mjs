// Time on task: how long the fly has been on and able to do its job, added up across runs, for
// telling how much of TikTok's feed it has shaped. phone-usb.mjs ticks it once a second and keeps
// the total in .run/time-on-task.json next to it; the app shows it, and fly.mjs status says why it
// isn't counting when it isn't.

const MAX_TICK_MS = 5000; // a longer gap between ticks is the Mac asleep, not the fly working

// Why the clock isn't counting, or null when it is. In the order worth fixing first.
export function whyNotCounting({ armed, device, wda, locked, pages, visiblePages }) {
  if (!armed) return 'switched off';
  if (!device) return 'no phone on the cable';
  if (!wda) return 'WebDriverAgent not running';
  if (locked !== false) return locked ? 'phone locked' : 'phone lock unknown';
  if (!pages) return 'page not open';
  // A browser throttles a hidden page's timers, and the fly's brain runs on them.
  if (!visiblePages) return 'page hidden';
  return null;
}

export function createTaskClock({ seconds = 0, now = Date.now } = {}) {
  let totalMs = seconds * 1000;
  let last = null;
  let reason = 'not started';
  return {
    // The state as it is now; the time since the last tick counts if the fly was working through it.
    tick(state) {
      const t = now();
      if (reason === null && last !== null) totalMs += Math.max(0, Math.min(MAX_TICK_MS, t - last));
      reason = whyNotCounting(state);
      last = t;
      return this.snapshot();
    },
    reset() {
      totalMs = 0;
      return this.snapshot();
    },
    snapshot() {
      return { seconds: totalMs / 1000, counting: reason === null, reason };
    },
  };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
