// The orphan predicate (#680): "live and unreachable from every UI surface".
//
// The whole point of this file is the LAST assertion in each block — that the predicate
// is empty for every arrangement that is merely unusual, and non-empty only for the one
// that is a bug. `attached: 0` on its own is an ordinary transient (a spawn before the
// browser opens its tab, a daemon restart while every session WS reconnects, a blip);
// a detector that fired on it would be noise, and noise is how a real orphan hides.
//
// Pure fs-free require of orphan-sweep.js — no daemon, no shell, no tmux — so it runs
// in the bare `unit` CI job.
//
// Run: node --test test/unit/orphan-sweep.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { findOrphanSessions, DEFAULT_GRACE_MS } = require('../../orphan-sweep');

// ------------------------------------------------------------------ fixtures

// A buildWindowsView().windows entry.
function win(windowId, sessions, { live = true } = {}) {
  return { windowId, live, lastActive: 0, sessions };
}

// A session row as buildWindowsView() emits it since #680 (note `attached`).
function sess(id, { status = 'active', attached = 0, name = null, cwd = '/repo' } = {}) {
  return { id, name, cwd, agentType: 'claude', status, createdAt: 0, lastActivity: 0, attached };
}

const T0 = 1_000_000;
const ids = list => list.map(o => o.id);

// Two sweeps graceMs apart — the minimum that can produce a finding, because a single
// observation never can.
function sweepTwice(windows, { gapMs = DEFAULT_GRACE_MS, secondWindows = null } = {}) {
  const first = findOrphanSessions({ windows, seenSince: new Map(), now: T0 });
  const second = findOrphanSessions({
    windows: secondWindows || windows,
    seenSince: first.seenSince,
    now: T0 + gapMs,
  });
  return { first, second };
}

// ------------------------------------------------------------------ the bug

test('THE BUG: live window, live session, nobody attached', async () => {
  // #680 exactly: the server groups the session under a window it is talking to right
  // now, and that window is not showing it. The tab bar draws from localStorage so it
  // is not there; the restore modal offers only LOST windows so it is not there either;
  // it has a windowId so it is not in `ungrouped`. Three surfaces, zero coverage.
  const { first, second } = sweepTwice([
    win('win-a', [sess('open-one', { attached: 1 }), sess('invisible', { name: '#678 Test daemons…' })]),
  ]);

  assert.deepStrictEqual(first.orphans, [], 'one observation is never enough');
  assert.deepStrictEqual(ids(second.orphans), ['invisible']);
  assert.strictEqual(second.orphans[0].windowId, 'win-a');
  assert.strictEqual(second.orphans[0].name, '#678 Test daemons…', 'the log line can name it');
  assert.strictEqual(second.orphans[0].forMs, DEFAULT_GRACE_MS);
});

// ------------------------------------------- everything that is NOT the bug

test('a dead window is the restore modal\'s job, not ours', async () => {
  const { second } = sweepTwice([win('win-gone', [sess('lost')], { live: false })]);
  assert.deepStrictEqual(second.orphans, [], 'offerable — the window picker covers it');
});

test('an attached session is on screen', async () => {
  const { second } = sweepTwice([win('win-a', [sess('shown', { attached: 1 })])]);
  assert.deepStrictEqual(second.orphans, []);
});

test('a saved row is un-restored history, not a running agent', async () => {
  // status 'saved' means no shell at all, so `attached: 0` is definitional. These are
  // exactly the sessions a window declined to restore.
  const { second } = sweepTwice([win('win-a', [sess('declined', { status: 'saved' })])]);
  assert.deepStrictEqual(second.orphans, []);
});

test('inside the grace window nothing is reported', async () => {
  const { second } = sweepTwice([win('win-a', [sess('just-spawned')])], { gapMs: DEFAULT_GRACE_MS - 1 });
  assert.deepStrictEqual(second.orphans, [], 'a spawn that has not painted its tab yet is not a bug');
});

test('a session that attaches mid-grace resets its clock', async () => {
  // The reconnect case: a daemon restart leaves every session at attached 0 for a few
  // seconds. Without the reset, the NEXT unrelated blip would inherit the old timestamp
  // and trip instantly.
  const first = findOrphanSessions({
    windows: [win('win-a', [sess('blip')])], seenSince: new Map(), now: T0,
  });
  const recovered = findOrphanSessions({
    windows: [win('win-a', [sess('blip', { attached: 1 })])], seenSince: first.seenSince, now: T0 + 1000,
  });
  assert.strictEqual(recovered.seenSince.has('blip'), false, 'clock dropped on attach');

  const reoffends = findOrphanSessions({
    windows: [win('win-a', [sess('blip')])], seenSince: recovered.seenSince, now: T0 + 2000,
  });
  assert.deepStrictEqual(reoffends.orphans, [], 'the new offence starts its own grace period');
  assert.strictEqual(reoffends.seenSince.get('blip'), T0 + 2000);
});

test('the clock survives across sweeps rather than restarting each time', async () => {
  let seenSince = new Map();
  const windows = [win('win-a', [sess('stuck')])];
  for (let i = 0; i < 3; i++) {
    ({ seenSince } = findOrphanSessions({ windows, seenSince, now: T0 + i * 10000 }));
  }
  const out = findOrphanSessions({ windows, seenSince, now: T0 + 30000 });
  assert.deepStrictEqual(ids(out.orphans), ['stuck'], 'three 10s sweeps add up to the 30s grace');
});

// ------------------------------------------------------------------ shape

test('nothing to sweep is not an error', async () => {
  for (const windows of [[], undefined, [win('win-a', [])]]) {
    const out = findOrphanSessions({ windows, seenSince: new Map(), now: T0 });
    assert.deepStrictEqual(out.orphans, []);
    assert.ok(out.seenSince instanceof Map);
  }
  // A caller with no prior state must not have to construct one.
  assert.deepStrictEqual(findOrphanSessions({ windows: [], seenSince: null, now: T0 }).orphans, []);
});

test('offenders come back worst-first', async () => {
  const seenSince = new Map([['old', T0 - 120000], ['newer', T0 - 40000]]);
  const out = findOrphanSessions({
    windows: [win('win-a', [sess('newer'), sess('old')])], seenSince, now: T0,
  });
  assert.deepStrictEqual(ids(out.orphans), ['old', 'newer'], 'longest-running offence first');
});

test('the input seenSince is not mutated', async () => {
  const seenSince = new Map();
  findOrphanSessions({ windows: [win('win-a', [sess('x')])], seenSince, now: T0 });
  assert.strictEqual(seenSince.size, 0, 'the fold returns the next map instead of writing this one');
});
