// Unit tests for public/js/wake-watch.js (#563), run headlessly in plain Node:
// the module touches document/window only inside init() and takes them (plus
// the clock and interval fn) as injectable params, so no DOM stubs are needed
// beyond simple addEventListener recorders.
//
// Note: module state (subscribers, debounce) is shared across tests in this
// file, so the fake clock only moves forward and each test advances it past
// the 3s debounce window before expecting a new wake event.
//
// Run: node --test test/unit/wake-watch.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let t = 1_000_000;
const now = () => t;
const advance = (ms) => { t += ms; };

const docListeners = {};
const winListeners = {};
let intervalFn = null;
let intervalMs = 0;

const fakeDoc = {
  hidden: false,
  addEventListener: (ev, fn) => { docListeners[ev] = fn; },
};
const fakeWin = {
  addEventListener: (ev, fn) => { winListeners[ev] = fn; },
};

let wakeWatch;
let events = [];

test('setup: import and init with injected doc/win/clock/interval', async () => {
  wakeWatch = await import('../../public/js/wake-watch.js');
  wakeWatch.init({
    doc: fakeDoc,
    win: fakeWin,
    now,
    setIntervalFn: (fn, ms) => { intervalFn = fn; intervalMs = ms; return 1; },
    tickMs: 5000,
    gapFactor: 2.5,
  });
  wakeWatch.onWake((reason) => events.push(reason));
  assert.strictEqual(typeof docListeners.visibilitychange, 'function');
  assert.strictEqual(typeof winListeners.online, 'function');
  assert.strictEqual(intervalMs, 5000);
});

test('normal tick cadence fires nothing', () => {
  events = [];
  for (let i = 0; i < 10; i++) { advance(5000); intervalFn(); }
  assert.deepStrictEqual(events, []);
});

test('timer gap beyond gapFactor × tickMs fires a wake', () => {
  events = [];
  advance(44_000); // DarkWake-scale freeze (> 2.5 × 5000)
  intervalFn();
  assert.deepStrictEqual(events, ['timer-gap']);
});

test('debounce collapses signals that arrive together', () => {
  events = [];
  advance(10_000); // clear the debounce window from the previous test
  advance(60_000);
  intervalFn();               // wake via gap
  winListeners.online();      // and the online event lands right after
  fakeDoc.hidden = false;
  docListeners.visibilitychange(); // and the tab becomes visible
  assert.deepStrictEqual(events, ['timer-gap']); // one event, not three
});

test('visibilitychange to visible fires (past debounce)', () => {
  events = [];
  advance(10_000);
  fakeDoc.hidden = false;
  docListeners.visibilitychange();
  assert.deepStrictEqual(events, ['visible']);
});

test('visibilitychange to hidden does not fire', () => {
  events = [];
  advance(10_000);
  fakeDoc.hidden = true;
  docListeners.visibilitychange();
  assert.deepStrictEqual(events, []);
});

test('online event fires (past debounce)', () => {
  events = [];
  advance(10_000);
  winListeners.online();
  assert.deepStrictEqual(events, ['online']);
});

test('unsubscribe stops delivery; other subscribers unaffected', () => {
  const mine = [];
  const un = wakeWatch.onWake((r) => mine.push(r));
  events = [];
  advance(10_000);
  wakeWatch._fireWake('first');
  un();
  advance(10_000);
  wakeWatch._fireWake('second');
  assert.deepStrictEqual(mine, ['first']);
  assert.deepStrictEqual(events, ['first', 'second']);
});

test('a throwing subscriber does not block the others', () => {
  const bad = wakeWatch.onWake(() => { throw new Error('boom'); });
  events = [];
  advance(10_000);
  assert.doesNotThrow(() => wakeWatch._fireWake('resilient'));
  assert.deepStrictEqual(events, ['resilient']);
  bad();
});
