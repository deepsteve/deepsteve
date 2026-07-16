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
