// The idle self-shutdown for a throwaway daemon (#678), driven on a fake clock.
//
// The watchdog ends the process, so every test here is really asking the same question:
// what stops it from firing? Attachment, session activity, a system sleep, a shutdown
// already in progress, and a zero timeout are the five answers, and each has its own
// test because each is a different way to lose someone's work.
const { test } = require('node:test');
const assert = require('node:assert');

const { createIdleWatchdog, DEFAULT_IDLE_MS, DEFAULT_TICK_MS } = require('../../idle-watchdog');

// A controllable clock plus a controllable interval, so a test advances time explicitly
// and ticks explicitly — no real timers, no sleeps, no flakes.
function harness(over = {}) {
  let t = 1_000_000;
  const fired = [];
  let intervalFn = null;
  let intervalMs = 0;
  const state = {
    clients: 0,
    activity: 0,
    holdoff: 0,
    shuttingDown: false,
  };
  const watchdog = createIdleWatchdog({
    idleMs: 60_000,
    tickMs: 10_000,
    now: () => t,
    setIntervalFn: (fn, ms) => { intervalFn = fn; intervalMs = ms; return { unref() {} }; },
    clearIntervalFn: () => { intervalFn = null; },
    clientCount: () => state.clients,
    lastActivityAt: () => state.activity,
    holdoffRemaining: () => state.holdoff,
    isShuttingDown: () => state.shuttingDown,
    onIdle: (ms) => fired.push(ms),
    ...over,
  });
  return {
    watchdog, fired, state,
    now: () => t,
    // Advance the clock the way a running process does: one tick per interval. Jumping
    // straight to t+ms would look like a freeze to the watchdog — correctly, which is
    // what freeze() below is for.
    advance(ms) {
      const step = intervalMs || ms;
      let left = ms;
      while (left > 0 && intervalFn) {
        const chunk = Math.min(step, left);
        t += chunk;
        left -= chunk;
        intervalFn();
      }
      if (!intervalFn) t += left;
    },
    // The daemon was suspended: the clock moved but no tick ran, so the next tick is
    // wildly overdue.
    freeze(ms) { t += ms; if (intervalFn) intervalFn(); },
    get armed() { return intervalFn !== null; },
  };
}

test('fires after the idle window with no clients and no activity', () => {
  const h = harness();
  h.watchdog.start();
  h.advance(30_000);
  assert.deepEqual(h.fired, [], 'not yet — half the window');
  h.advance(31_000);
  assert.equal(h.fired.length, 1);
  assert.ok(h.fired[0] >= 60_000, `onIdle is handed the measured idle time, got ${h.fired[0]}`);
});

test('an attached browser client keeps it alive indefinitely', () => {
  const h = harness();
  h.state.clients = 1;
  h.watchdog.start();
  for (let i = 0; i < 20; i++) h.advance(30_000);
  assert.deepEqual(h.fired, []);
});

test('a client that leaves starts the clock from when it left, not from boot', () => {
  const h = harness();
  h.state.clients = 1;
  h.watchdog.start();
  h.advance(300_000);          // five minutes attached
  h.state.clients = 0;
  h.advance(30_000);
  assert.deepEqual(h.fired, [], 'only 30s since the client left');
  h.advance(31_000);
  assert.equal(h.fired.length, 1);
});

test('an unattended agent producing output is not idle', () => {
  // The bug this prevents is the worst one available here: a scheduled run working away
  // with no browser attached is exactly the session nobody is watching, and killing it
  // loses work silently.
  const h = harness();
  h.watchdog.start();
  for (let i = 0; i < 10; i++) {
    h.advance(30_000);
    h.state.activity = h.now();   // PTY chunk arrived
  }
  assert.deepEqual(h.fired, []);
  // Output stops; now the window applies.
  h.advance(30_000);
  assert.deepEqual(h.fired, []);
  h.advance(31_000);
  assert.equal(h.fired.length, 1);
});

test('a stale activity stamp does not push the deadline out forever', () => {
  const h = harness();
  h.watchdog.start();
  h.state.activity = h.now();     // one chunk at boot, then silence
  h.advance(61_000);
  assert.equal(h.fired.length, 1);
});

test('a system sleep is not idleness — the overdue tick rebases', () => {
  // The daemon is frozen across an overnight suspend, so ONE tick arrives with eight
  // hours on the clock. Firing on it would tear the daemon down at the moment the user
  // opened the lid.
  const h = harness();
  h.watchdog.start();
  h.advance(10_000);
  h.freeze(8 * 60 * 60 * 1000);
  assert.deepEqual(h.fired, [], 'the gap was a freeze, not disuse');
  // And the window restarts from the wake rather than from before the sleep.
  h.advance(30_000);
  assert.deepEqual(h.fired, []);
  h.advance(31_000);
  assert.equal(h.fired.length, 1);
});

test('sleepWatch holdoff also suppresses a tick', () => {
  // The other half: a tick that lands after the freeze rather than across it is not
  // overdue, so the detector above cannot see the sleep. sleepWatch can.
  const h = harness();
  h.watchdog.start();
  h.state.holdoff = 120_000;
  h.advance(10_000);
  h.advance(10_000);
  h.advance(10_000);
  h.advance(10_000);
  h.advance(10_000);
  h.advance(10_000);
  h.advance(10_000);
  assert.deepEqual(h.fired, [], 'holdoff outstanding');
  h.state.holdoff = 0;
  h.advance(10_000);
  assert.deepEqual(h.fired, [], 'window restarts from the last held-off tick');
});

test('fires exactly once, and stops its own timer', () => {
  // The teardown raises SIGTERM against our own process; a second firing would re-enter
  // the graceful shutdown.
  const h = harness();
  h.watchdog.start();
  h.advance(61_000);
  assert.equal(h.fired.length, 1);
  assert.equal(h.armed, false, 'the interval is cleared on fire');
  assert.equal(h.watchdog.fired, true);
  h.watchdog.tick();
  h.watchdog.tick();
  assert.equal(h.fired.length, 1);
});

test('a shutdown already in progress suppresses it', () => {
  const h = harness();
  h.watchdog.start();
  h.state.shuttingDown = true;
  h.advance(61_000);
  assert.deepEqual(h.fired, []);
});

test('idleMs of 0 never arms', () => {
  const logs = [];
  const h = harness({ idleMs: 0, log: (m) => logs.push(m) });
  assert.equal(h.watchdog.start(), false);
  assert.equal(h.watchdog.running, false);
  h.advance(10 * 60 * 1000);
  assert.deepEqual(h.fired, []);
  assert.ok(logs.some(m => /disabled/.test(m)));
});

test('a negative idleMs is treated as disabled, not as instant', () => {
  const h = harness({ idleMs: -1 });
  assert.equal(h.watchdog.start(), false);
  assert.deepEqual(h.fired, []);
});

test('start is idempotent and stop disarms', () => {
  const h = harness();
  assert.equal(h.watchdog.start(), true);
  assert.equal(h.watchdog.start(), false, 'second start must not create a second interval');
  assert.equal(h.watchdog.running, true);
  h.watchdog.stop();
  assert.equal(h.watchdog.running, false);
});

test('an onIdle that throws does not take the daemon down with it', () => {
  const logs = [];
  const h = harness({ onIdle: () => { throw new Error('boom'); }, log: (m) => logs.push(m) });
  h.watchdog.start();
  h.advance(61_000);
  assert.ok(logs.some(m => /boom/.test(m)));
});

test('the tick interval never exceeds the idle window', () => {
  // A 30s timeout with the default 60s tick would otherwise take a full minute to notice.
  let captured = null;
  const h = harness({
    idleMs: 30_000,
    tickMs: 60_000,
    setIntervalFn: (fn, ms) => { captured = ms; return { unref() {} }; },
  });
  h.watchdog.start();
  assert.equal(captured, 30_000);
});

test('defaults are the documented 30 min window on a 60s tick', () => {
  assert.equal(DEFAULT_IDLE_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_TICK_MS, 60 * 1000);
});
