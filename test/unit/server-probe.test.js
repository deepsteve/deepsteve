// Headless unit test for public/js/server-probe.js (#665).
//
// Two things are pinned here, and neither was covered before — `_config` and `_reset`
// existed as a "test seam" that nothing in the tree actually read:
//
//   1. The cross-file coupling. MAX_DELAY_MS is the worst-case gap between two /healthz
//      probes, so it bounds how long a loaded browser can take to notice the daemon came
//      back. server.js's AUTO_OPEN_GRACE_MS is the window in which the daemon waits for
//      exactly that before popping a tab of its own. When the two were both 5s the guard
//      lost its own race by ~300ms on every cold start. Raising one without the other
//      silently reintroduces the phantom tab, and nothing else in the tree would notice.
//   2. The wake kick. waitForServer()'s backoff used to be a bare, uncancellable sleep, so
//      a slept or backgrounded tab sat out the full cap before its next probe even though
//      wake-watch had already told everyone else the world had changed.
//
// No browser: the only global the module chain touches is fetch, and wake-watch touches
// document/window solely inside its init(), which we never call.
//
// Run: node --test test/unit/server-probe.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', '..', 'server.js');

// Timestamp of every /healthz probe, in order. The schedule IS the assertion, so this
// array is what the timing tests read.
let probeTimes = [];
let fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
globalThis.fetch = (...a) => { probeTimes.push(Date.now()); return fetchImpl(...a); };

const tick = (n = 25) => new Promise(r => setTimeout(r, n));

// Fresh module instance per test — `inFlight` and the waiter set are module-level state.
// Note the query string does NOT propagate to the module's own `./wake-watch.js` import,
// so every copy loaded here shares one wake-watch instance (which the wake test relies on).
function load() {
  return import('../../public/js/server-probe.js?t=' + Math.random());
}

// --------------------------------------------------------- the cross-file coupling

test('server.js auto-open grace out-waits the probe cap', async () => {
  const { _config } = await load();
  const src = fs.readFileSync(SERVER_JS, 'utf8');

  const m = src.match(/AUTO_OPEN_GRACE_MS\s*=[^\n]*\|\|\s*([0-9_]+)/);
  assert.ok(m, 'could not find AUTO_OPEN_GRACE_MS default in server.js');
  const graceMs = Number(m[1].replace(/_/g, ''));

  // Worst case: the port opens an instant after a probe came back negative, so the browser
  // waits one full jittered cap before it looks again, then upgrades.
  const worstProbeGap = _config.MAX_DELAY_MS * (1 + _config.JITTER_FRAC);
  assert.ok(
    graceMs > worstProbeGap,
    `server.js AUTO_OPEN_GRACE_MS (${graceMs}ms) must exceed the probe loop's worst-case ` +
    `gap (${worstProbeGap}ms = MAX_DELAY_MS ${_config.MAX_DELAY_MS} + ${_config.JITTER_FRAC * 100}% jitter), ` +
    'or a cold-started daemon opens a phantom tab over a browser that was about to ' +
    'reconnect on its own. Raise the grace in server.js or lower the cap here — not both up.',
  );
});

test('the probe cap stays small enough to keep that grace cheap', async () => {
  const { _config } = await load();
  // The grace is dead time on the slowest path we have (kernel boot to a usable UI), and it
  // can only ever be a little larger than this number. A localhost /healthz fetch is ~1-2ms
  // and concurrent callers collapse onto one via inFlight, so paying it more often while the
  // server is genuinely down is not a cost worth trading a second of cold start for.
  assert.ok(
    _config.MAX_DELAY_MS <= 2000,
    `MAX_DELAY_MS is ${_config.MAX_DELAY_MS}ms; above ~2s the auto-open grace it forces ` +
    'starts costing more cold-start latency than the saved probes are worth (#665).',
  );
});

// --------------------------------------------------------------------- the wake kick

test('kickProbes() cuts a sleeping backoff short and restarts the schedule', async () => {
  const mod = await load();
  probeTimes = [];
  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };

  let stop = false;
  const done = mod.waitForServer(() => stop);

  // ~700ms in the loop has probed at roughly 0 / 250 / 625 and is asleep for ~562ms more.
  await tick(700);
  const before = probeTimes.length;
  assert.ok(before >= 2, `expected the loop to have probed a few times, got ${before}`);

  const kickedAt = Date.now();
  mod.kickProbes();
  await tick(60);
  assert.ok(
    probeTimes.length > before,
    'kickProbes() must wake a sleeping waitForServer() instead of letting it sit out the delay',
  );
  assert.ok(
    probeTimes[before] - kickedAt < 60,
    `the kicked probe landed ${probeTimes[before] - kickedAt}ms after the kick, not immediately`,
  );

  // And the ramp restarts: the world changed under us, so a delay measured against the old
  // one is worthless. Without the reset the next gap would be the ramped ~844ms.
  await tick(400);
  const gap = probeTimes[before + 1] - probeTimes[before];
  assert.ok(
    gap < 450,
    `after a kick the next probe should follow at ~BASE_DELAY_MS (${mod._config.BASE_DELAY_MS}ms), ` +
    `not the ramped delay — measured ${gap}ms`,
  );

  stop = true;
  mod.kickProbes();
  assert.strictEqual(await done, false, 'shouldStop() must still win once the sleep is cut short');
});

test('a wake-watch wake kicks the probe loop', async () => {
  const mod = await load();
  // No query string: this is the instance server-probe.js itself subscribed to. Importing
  // '../../public/js/wake-watch.js?t=…' would hand back a third, unwired copy.
  const wake = await import('../../public/js/wake-watch.js');

  probeTimes = [];
  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };

  let stop = false;
  const done = mod.waitForServer(() => stop);
  await tick(700);
  const before = probeTimes.length;

  const wokeAt = Date.now();
  wake._fireWake('test'); // first fire in this process, so the 3s debounce lets it through
  await tick(60);

  assert.ok(
    probeTimes.length > before && probeTimes[before] - wokeAt < 60,
    'a wake must reach waitForServer(), not just ws-client.js\'s socket-level retry',
  );

  stop = true;
  mod.kickProbes();
  await done;
});

// ------------------------------------------------------------------------- the gate

test('waitForServer resolves as soon as /healthz answers', async () => {
  const mod = await load();
  probeTimes = [];
  fetchImpl = async () => ({ ok: true, status: 200 });

  const t0 = Date.now();
  assert.strictEqual(await mod.waitForServer(), true);
  assert.strictEqual(probeTimes.length, 1, 'a healthy server must cost exactly one probe');
  assert.ok(Date.now() - t0 < 50, 'and no delay at all');
});

test('a non-ok response keeps the gate closed', async () => {
  const mod = await load();
  probeTimes = [];
  fetchImpl = async () => ({ ok: false, status: 503 });

  let stop = false;
  const done = mod.waitForServer(() => stop);
  await tick(400);
  assert.ok(probeTimes.length >= 2, 'a 503 is not "up" — the loop must keep polling');

  stop = true;
  mod.kickProbes();
  assert.strictEqual(await done, false);
});
