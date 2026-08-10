// Unit tests for sleep-watch.js (#563): wall-clock discontinuity detection and
// the post-wake holdoff that keeps the detach reaper from firing right after a
// sleep. Driven entirely with an injected clock — no real timers.
//
// Run: node --test test/unit/sleep-watch.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { createSleepWatch } = require('../../sleep-watch.js');

function makeWatch(opts = {}) {
  let t = 1_000_000;
  const clock = {
    now: () => t,
    advance(ms) { t += ms; },
  };
  const wakes = [];
  const watch = createSleepWatch({
    now: clock.now,
    tickMs: 5000,
    gapMs: 15000,
    onWake: (gap) => wakes.push(gap),
    log: () => {},
    ...opts,
  });
  return { watch, clock, wakes };
}

test('no wake on normal tick cadence', () => {
  const { watch, clock, wakes } = makeWatch();
  watch.tick();
  for (let i = 0; i < 20; i++) {
    clock.advance(5000);
    watch.tick();
  }
  assert.strictEqual(wakes.length, 0);
  assert.strictEqual(watch.lastWakeAt(), 0);
});

test('no wake on jitter below the gap threshold', () => {
  const { watch, clock, wakes } = makeWatch();
  watch.tick();
  clock.advance(5000 + 15000); // exactly tickMs + gapMs — not strictly greater
  watch.tick();
  clock.advance(19_999);
  watch.tick();
  assert.strictEqual(wakes.length, 0);
});

test('wake detected on a DarkWake-scale gap, lastWakeAt set to wake time', () => {
  const { watch, clock, wakes } = makeWatch();
  watch.tick();
  clock.advance(44_000); // 44s DarkWake-style freeze
  watch.tick();
  assert.strictEqual(wakes.length, 1);
  assert.strictEqual(wakes[0], 44_000);
  assert.strictEqual(watch.lastWakeAt(), clock.now());
});

test('holdoffRemaining is 0 before any wake', () => {
  const { watch } = makeWatch();
  watch.tick();
  assert.strictEqual(watch.holdoffRemaining(120_000), 0);
});

test('holdoffRemaining counts down after a wake and reaches 0', () => {
  const { watch, clock } = makeWatch();
  watch.tick();
  clock.advance(300_000); // 5 min sleep
  watch.tick();
  assert.strictEqual(watch.holdoffRemaining(120_000), 120_000);
  clock.advance(30_000);
  assert.strictEqual(watch.holdoffRemaining(120_000), 90_000);
  clock.advance(90_000);
  assert.strictEqual(watch.holdoffRemaining(120_000), 0);
  clock.advance(10_000);
  assert.strictEqual(watch.holdoffRemaining(120_000), 0);
});

test('consecutive gaps re-arm the holdoff (DarkWake → sleep → real wake)', () => {
  const { watch, clock, wakes } = makeWatch();
  watch.tick();

  // DarkWake begins after a freeze; ticks run normally inside the 44s window.
  clock.advance(240_000);
  watch.tick();
  assert.strictEqual(wakes.length, 1);
  const darkWakeAt = watch.lastWakeAt();
  for (let i = 0; i < 8; i++) { clock.advance(5000); watch.tick(); } // 40s of DarkWake

  // Re-sleep, then the real wake.
  clock.advance(480_000);
  watch.tick();
  assert.strictEqual(wakes.length, 2);
  assert.ok(watch.lastWakeAt() > darkWakeAt);
  assert.strictEqual(watch.holdoffRemaining(120_000), 120_000);
});

test('onWake errors are swallowed and do not break ticking', () => {
  let t = 0;
  const watch = createSleepWatch({
    now: () => t,
    tickMs: 5000,
    gapMs: 15000,
    onWake: () => { throw new Error('boom'); },
    log: () => {},
  });
  t = 1000;
  watch.tick();
  t += 60_000;
  assert.doesNotThrow(() => watch.tick());
  assert.strictEqual(watch.lastWakeAt(), t);
});

test('start()/stop() drive tick via the injected interval', () => {
  let t = 0;
  let intervalFn = null;
  const watch = createSleepWatch({
    now: () => t,
    setIntervalFn: (fn) => { intervalFn = fn; return { unref() {} }; },
    clearIntervalFn: () => { intervalFn = null; },
    tickMs: 5000,
    gapMs: 15000,
    log: () => {},
  });
  watch.start();
  assert.ok(intervalFn);
  t = 100_000;
  intervalFn();
  t += 60_000;
  intervalFn();
  assert.strictEqual(watch.lastWakeAt(), t);
  watch.stop();
  assert.strictEqual(intervalFn, null);
});

// --- platform (#621) ------------------------------------------------------
//
// #621 proposed gating this to darwin ("a rented Linux box does not sleep"). It is
// deliberately NOT gated — see the reasoning in sleep-watch.js's header. These tests
// exist so that decision cannot be quietly reversed: gating start() would turn all
// three red, which is the argument a future change has to answer.

test('the watch runs on Linux too — it is deliberately NOT gated to darwin (#621)', () => {
  let intervalFn = null;
  const watch = createSleepWatch({
    now: () => 0,
    setIntervalFn: (fn) => { intervalFn = fn; return { unref() {} }; },
    clearIntervalFn: () => { intervalFn = null; },
    platform: 'linux',
    log: () => {},
  });
  watch.start();
  assert.ok(intervalFn, 'start() must schedule the tick regardless of platform');
});

test('a Linux suspend still produces a holdoff', () => {
  // The concrete cost of gating: without a recorded wake, armDetachReap() treats a
  // browser that was frozen by the same suspend as a peer that left, and reaps a live
  // agent session. Linux laptops suspend, hypervisors pause guests for live migration,
  // and containers get cgroup-frozen — all of which look exactly like this.
  let t = 0;
  let intervalFn = null;
  const watch = createSleepWatch({
    now: () => t,
    setIntervalFn: (fn) => { intervalFn = fn; return { unref() {} }; },
    clearIntervalFn: () => {},
    platform: 'linux',
    tickMs: 5000,
    gapMs: 15000,
    log: () => {},
  });
  watch.start();
  t = 100_000;
  intervalFn();
  t += 300_000;          // a five-minute suspend
  intervalFn();
  assert.strictEqual(watch.lastWakeAt(), t, 'the wake must be recorded on Linux');
  assert.ok(watch.holdoffRemaining(120_000) > 0, 'and it must produce a real holdoff');
});

test('platform is reported, never enforced', () => {
  const mac = createSleepWatch({ platform: 'darwin', log: () => {} });
  const lin = createSleepWatch({ platform: 'linux', log: () => {} });
  assert.strictEqual(mac.isPlatformRelevant(), true);
  assert.strictEqual(lin.isPlatformRelevant(), false);
  // ...and the flag changes nothing about behavior.
  for (const w of [mac, lin]) {
    assert.strictEqual(w.lastWakeAt(), 0);
    assert.strictEqual(w.holdoffRemaining(120_000), 0);
  }
});

// --- deferMsFor: the deferral decision armDetachReap used to inline (#627) --------
// Extracted when the post-merge auto-close became its second caller. These are the
// only direct coverage of the rule — armDetachReap itself lives in server.js, which
// this job cannot require.

function watchAt(t0) {
  let t = t0;
  const w = createSleepWatch({ now: () => t, tickMs: 5000, gapMs: 15000, log: () => {} });
  return { w, set: (v) => { t = v; } };
}

test('deferMsFor: no wake detected means act now', () => {
  const { w } = watchAt(1_000_000);
  assert.strictEqual(w.deferMsFor(1_000_000, { holdoffMs: 120_000 }), 0);
});

test('deferMsFor: a recent wake defers by whatever is left of the holdoff', () => {
  const { w, set } = watchAt(0);
  set(100_000); w.tick();
  set(400_000); w.tick();          // a 300s gap — wake recorded at t=400_000
  set(430_000);                    // 30s after the wake
  assert.strictEqual(w.deferMsFor(430_000, { holdoffMs: 120_000 }), 90_000);
});

test('deferMsFor: a timer that fired long past its due time defers the full holdoff', () => {
  // Overdue timers run in due-time order, so a consumer's timer can fire BEFORE the
  // tick that would have detected the wake. Lateness is the independent signal, and
  // it is why this can't just be holdoffRemaining().
  const { w, set } = watchAt(1_000_000);
  set(1_000_000 + 60_000);         // 60s past due, and no wake recorded yet
  assert.strictEqual(w.deferMsFor(1_000_000, { holdoffMs: 120_000 }), 120_000);
});

test('deferMsFor: keyed on the due time, so a re-arming caller never defers forever', () => {
  // The reason it takes dueAt rather than armedAt: the #627 auto-close re-arms in a
  // loop while a session is mid-turn, and keeps its ONE original arm time. Measuring
  // lateness from that would report permanent lateness and the close could never fire.
  const { w, set } = watchAt(1_000_000);
  const armedAt = 1_000_000;
  set(armedAt + 600_000);          // ten minutes of busy re-arms later
  assert.strictEqual(w.deferMsFor(armedAt + 600_000, { holdoffMs: 120_000 }), 0,
    'on time for THIS round, however long ago the first arm was');
  assert.strictEqual(w.deferMsFor(armedAt, { holdoffMs: 120_000 }), 120_000,
    'and measuring from the original arm is exactly the forever-defer bug');
});
