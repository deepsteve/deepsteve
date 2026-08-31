// Unit tests for the timecard's presence beacon (#666).
//
// The beacon is what separates "browser open and I'm in it" from "a tab left open
// overnight", so its gating is load-bearing in both directions: a beacon that fires
// when it should not invents hours, and one that stops firing silently loses them.
//
// shouldBeacon is pure precisely so this needs no browser. The module itself is
// imported the same way scheduled-history-client.test.js imports its module, with the
// handful of globals it touches at import time stubbed first.
//
// Run: node --test test/unit/timecard-presence.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'public', 'js', 'timecard-presence.js');

globalThis.document = {
  hidden: false,
  hasFocus: () => true,
  addEventListener: () => {},
};
globalThis.window = { addEventListener: () => {} };

let mod;
async function load() {
  if (!mod) mod = await import('../../public/js/timecard-presence.js');
  return mod;
}

test('nothing is sent while sampling is off', async () => {
  const { shouldBeacon } = await load();
  assert.strictEqual(
    shouldBeacon({ enabled: false, focused: true, hidden: false, failures: 0 }), false,
    'off means no traffic at all, not a quieter beacon',
  );
  // Including the blur report, which is otherwise exempt from every other check.
  assert.strictEqual(
    shouldBeacon({ enabled: false, focused: true, hidden: false, failures: 0, reason: 'blur' }), false,
  );
});

test('a focused, visible window beacons', async () => {
  const { shouldBeacon } = await load();
  assert.strictEqual(shouldBeacon({ enabled: true, focused: true, hidden: false, failures: 0 }), true);
});

test('an unfocused or hidden window goes quiet — that is the overnight-tab case', async () => {
  const { shouldBeacon } = await load();
  assert.strictEqual(shouldBeacon({ enabled: true, focused: false, hidden: false, failures: 0 }), false);
  assert.strictEqual(shouldBeacon({ enabled: true, focused: true, hidden: true, failures: 0 }), false);
});

test('the blur report goes out anyway — it carries the last interaction', async () => {
  const { shouldBeacon } = await load();
  assert.strictEqual(
    shouldBeacon({ enabled: true, focused: false, hidden: true, failures: 0, reason: 'blur' }), true,
    'it is the sample boundary that decides whether the minutes just past counted',
  );
});

test('three failures in a row stop the beacon instead of logging forever', async () => {
  const { shouldBeacon } = await load();
  assert.strictEqual(shouldBeacon({ enabled: true, focused: true, hidden: false, failures: 2 }), true);
  assert.strictEqual(
    shouldBeacon({ enabled: true, focused: true, hidden: false, failures: 3 }), false,
    'client-log.js beacons every >=400 into the daemon log; a dead route must not fill it',
  );
  // Not even the blur exemption survives a dead route.
  assert.strictEqual(
    shouldBeacon({ enabled: true, focused: true, hidden: false, failures: 3, reason: 'blur' }), false,
  );
});

test('setEnabled(true) clears the failure count, so the beacon can come back', async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const setEnabled = src.match(/export function setEnabled[\s\S]*?\n\}/)[0];
  assert.match(setEnabled, /failures = 0/, 'otherwise a dead route stays dead until reload');
  assert.match(setEnabled, /disarm\(\)/, 'and turning it off must stop the timer');
});

test('the first beacon waits out the window in which mod routes 404', async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const delay = src.match(/const FIRST_BEACON_DELAY_MS = (\d+)/);
  assert.ok(delay, 'a first-beacon delay must exist');
  assert.ok(
    Number(delay[1]) >= 10000,
    'mod routes register after core\'s, so an immediate POST is a guaranteed 404 in the log',
  );
});

test('interaction is captured at the document, so terminal keystrokes count', async () => {
  const src = fs.readFileSync(SRC, 'utf8');
  for (const evt of ['keydown', 'pointerdown', 'wheel']) {
    assert.ok(src.includes(`'${evt}'`), `${evt} must bump the interaction clock`);
  }
  assert.match(src, /addEventListener\('keydown', bump, true\)/,
    'capture phase — xterm lives in this document and would otherwise swallow it');
  assert.match(src, /passive: true/, 'the wheel listener must never delay a scroll');
});
