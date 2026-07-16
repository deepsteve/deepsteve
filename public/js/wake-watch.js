/**
 * Wake detection for the browser side of #563.
 *
 * System sleep freezes this page's timers and sockets; on wake the WebSockets
 * may be dead-but-OPEN (no onclose fired yet) or sitting in a reconnect loop.
 * This module notices "we just woke up" and tells subscribers so they can
 * probe/retry immediately instead of waiting for the browser to figure it out.
 *
 * Signals (all three typically fire together on a real wake; a debounce
 * collapses them into one event):
 *  - visibilitychange → document became visible
 *  - window 'online'
 *  - timer discontinuity: a setInterval tick that arrives far later than its
 *    interval means the page was suspended. (In background tabs Chrome throttles
 *    timers to ~1/min, so this can also fire on plain tab-backgrounding — that's
 *    fine, subscribers' probes are cheap and correct in that case too.)
 *
 * Self-contained ES module (like cmd-tab-switch.js). Touches document/window
 * only inside init(), so importing it in plain Node for unit tests is safe.
 * No storage/BroadcastChannel — nested baby-browser pages each get their own
 * independent instance, which is correct since each page owns its own sockets.
 */

const subscribers = new Set();

let lastTickAt = 0;
let lastWakeFiredAt = 0;
let nowFn = Date.now;
let debounceMs = 3000;

function fireWake(reason) {
  const t = nowFn();
  if (t - lastWakeFiredAt < debounceMs) return; // collapse burst of signals
  lastWakeFiredAt = t;
  for (const cb of subscribers) {
    try { cb(reason); } catch (e) { console.error('[wake-watch] subscriber error:', e); }
  }
}

/**
 * Subscribe to wake events. Returns an unsubscribe function.
 */
export function onWake(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function init({
  doc = document,
  win = window,
  now = Date.now,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  tickMs = 5000,
  gapFactor = 2.5,
} = {}) {
  nowFn = now;
  lastTickAt = now();

  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden) fireWake('visible');
  });
  win.addEventListener('online', () => fireWake('online'));

  setIntervalFn(() => {
    const t = now();
    const gap = t - lastTickAt;
    lastTickAt = t;
    if (gap > gapFactor * tickMs) fireWake('timer-gap');
  }, tickMs);
}

// Test hook: fire a wake event directly (bypasses debounce bookkeeping only via
// the injected clock — the debounce still applies).
export function _fireWake(reason = 'test') {
  fireWake(reason);
}
