// #681 — the running elapsed timer on the pending-session-create banner.
//
// Tier 1 pins formatElapsed's boundaries. It lives in its own module precisely so it
// can be driven directly: app.js needs a document and cannot be imported here.
//
// Tier 2 is a source guard over app.js for the two things that make the timer honest
// and safe, neither of which a pure formatter test can see: the start stamp must be
// taken when the create is ATTEMPTED (not when the banner arms 1500ms later), and the
// 1s interval must be cleared in the one place the banner is torn down. A leaked
// interval behind a dismissed banner is the obvious failure mode here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('formatElapsed: seconds below a minute, no padding', async () => {
  const { formatElapsed } = await import('../../public/js/elapsed.js');
  assert.strictEqual(formatElapsed(0), '0s');
  assert.strictEqual(formatElapsed(999), '0s');   // floors, never rounds up to 1s
  assert.strictEqual(formatElapsed(1000), '1s');
  assert.strictEqual(formatElapsed(12400), '12s');
  assert.strictEqual(formatElapsed(59999), '59s');
});

test('formatElapsed: the minute boundary pads the seconds', async () => {
  const { formatElapsed } = await import('../../public/js/elapsed.js');
  assert.strictEqual(formatElapsed(60000), '1m 00s');
  assert.strictEqual(formatElapsed(64000), '1m 04s');
  assert.strictEqual(formatElapsed(124000), '2m 04s');
  assert.strictEqual(formatElapsed(119999), '1m 59s');
});

test('formatElapsed: no hour tier — a long wait keeps counting minutes', async () => {
  const { formatElapsed } = await import('../../public/js/elapsed.js');
  assert.strictEqual(formatElapsed(3600000), '60m 00s');
  assert.strictEqual(formatElapsed(4513000), '75m 13s');
});

test('formatElapsed: a clock that went backwards clamps to 0s, never negative', async () => {
  const { formatElapsed } = await import('../../public/js/elapsed.js');
  assert.strictEqual(formatElapsed(-1), '0s');
  assert.strictEqual(formatElapsed(-90000), '0s');
});

test('the pending create stamps startedAt at attempt time, not when the banner arms', () => {
  const src = read('public/js/app.js');
  const fn = src.slice(src.indexOf('function trackPendingCreate('));
  const stamp = fn.indexOf('startedAt: Date.now()');
  const arm = fn.indexOf('setTimeout(');
  assert.ok(stamp !== -1, 'trackPendingCreate must record startedAt');
  assert.ok(arm !== -1, 'trackPendingCreate still arms the banner on a delay');
  assert.ok(stamp < arm,
    'startedAt must be stamped before the 1500ms arm delay — a timer that opens at 0s ' +
    'after 1.5s of waiting is the same dishonesty in a smaller form (#681)');
});

test('the empty-set branch of updatePendingBanner stops the ticker', () => {
  const src = read('public/js/app.js');
  const fn = src.slice(src.indexOf('function updatePendingBanner('));
  const branch = fn.slice(fn.indexOf('pendingCreates.size === 0'), fn.indexOf('if (!pendingBannerEl)'));
  assert.match(branch, /clearInterval\(pendingBannerTicker\)/,
    'the one banner teardown site must clear the 1s interval — settle(), cancel() and ' +
    'the error path all reach it, and nothing else does');
  assert.match(branch, /pendingBannerTicker = null/,
    'and null the handle, so the guard that stops a second interval stacking still works');
});
