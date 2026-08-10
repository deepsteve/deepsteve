// Unit tests for the daemon-armed deferred session close (#627).
//
// The bug this exists for: /deepsteve:merge's last step is "call close_session", and
// agents drop it — 30/30 worktrees in #609, again on Opus 5 after the prompt had been
// hardened as far as prose goes. merge_worktree now arms the close itself, so the
// outcome no longer depends on the agent remembering.
//
// What is actually load-bearing here is the entry-IDENTITY check at fire time: the
// cancel hooks in server.js are hygiene, and a site someone forgets to add later must
// fail SAFE (drop the timer) rather than close a session that has moved on. Half the
// cases below pin that.
//
// Pure module + injected clock/timers — no server boot, no shell, no node-pty — so it
// runs in the bare `unit` CI job.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSessionAutoClose } = require('../../session-auto-close.js');

// Deterministic clock + timer queue. advance() runs due timers in due-time order,
// which is what lets a re-arming timer (the busy/sleep loops) be driven at all.
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { timers.set(++seq, { at: t + ms, fn }); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= target && (!next || x.at < next.at)) next = { id, ...x };
        if (!next) break;
        timers.delete(next.id);
        t = next.at;
        next.fn();
      }
      t = target;
    },
    get pending() { return timers.size; },
  };
}

// `shells` stands in for the server's Map; the VALUES are the identity the auto-closer
// captures, so the tests below swap/delete them to simulate a real session's fate.
function harness(opts = {}) {
  const clock = fakeClock();
  const shells = new Map([['abc', { id: 'abc' }]]);
  const closed = [];
  const logs = [];
  const ac = createSessionAutoClose({
    closeSession: (id, reason) => { closed.push([id, reason]); shells.delete(id); return true; },
    getEntry: (id) => shells.get(id),
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    log: (m) => logs.push(m),
    ...opts,
  });
  return { ac, clock, shells, closed, logs };
}

test('arms and closes exactly once, with the reason it was armed with', () => {
  const { ac, clock, closed } = harness();
  const armed = ac.arm('abc', { delayMs: 120000, reason: 'merged' });
  assert.strictEqual(armed.closeAt, 120000);
  assert.strictEqual(ac.closeAt('abc'), 120000);

  clock.advance(119000);
  assert.deepStrictEqual(closed, [], 'must not fire early');

  clock.advance(2000);
  assert.deepStrictEqual(closed, [['abc', 'merged']]);
  assert.strictEqual(ac.size, 0, 'record released after firing');
  assert.strictEqual(ac.closeAt('abc'), null);

  clock.advance(600000);
  assert.strictEqual(closed.length, 1, 'exactly once — no rescheduled ghost');
});

test('cancel before the deadline means the session is never closed', () => {
  const { ac, clock, closed } = harness();
  ac.arm('abc', { delayMs: 120000, reason: 'merged' });
  assert.strictEqual(ac.cancel('abc', 'user input'), true);
  assert.strictEqual(ac.closeAt('abc'), null);
  assert.strictEqual(clock.pending, 0, 'the timer itself is released, not just ignored');

  clock.advance(600000);
  assert.deepStrictEqual(closed, []);
  assert.strictEqual(ac.cancel('abc'), false, 'cancelling nothing reports nothing');
});

test('re-arming replaces the deadline instead of stacking a second timer', () => {
  const { ac, clock, closed } = harness();
  ac.arm('abc', { delayMs: 120000, reason: 'merged' });
  clock.advance(60000);
  const second = ac.arm('abc', { delayMs: 120000, reason: 'merged' }); // e.g. a retried merge
  assert.strictEqual(second.closeAt, 180000);
  assert.strictEqual(ac.size, 1);

  clock.advance(61000); // past the ORIGINAL deadline
  assert.deepStrictEqual(closed, [], 'the superseded timer must not fire');

  clock.advance(60000);
  assert.deepStrictEqual(closed, [['abc', 'merged']], 'the new deadline does');
});

test('a session replaced under the same id is never closed (identity guard)', () => {
  // A tmux reattach or a --resume restore builds a NEW entry object for the same id.
  // This is the guarantee that makes the server.js cancel hooks hygiene rather than
  // the safety property.
  const { ac, clock, shells, closed, logs } = harness();
  ac.arm('abc', { delayMs: 120000, reason: 'merged' });
  shells.set('abc', { id: 'abc', restored: true });

  clock.advance(120001);
  assert.deepStrictEqual(closed, [], 'the restored session belongs to whoever restored it');
  assert.ok(logs.some((m) => m.includes('gone or was replaced')));
  assert.strictEqual(ac.size, 0);
});

test('a session that vanished before the deadline is dropped, not closed', () => {
  const { ac, clock, shells, closed } = harness();
  ac.arm('abc', { delayMs: 120000, reason: 'merged' });
  shells.delete('abc'); // exited on its own; server.js also cancels, but not always first
  clock.advance(120001);
  assert.deepStrictEqual(closed, []);
  assert.strictEqual(ac.size, 0);
});

test('a mid-turn session is not interrupted — it closes once it goes idle', () => {
  let state = 'busy';
  const { ac, clock, closed } = harness({ sessionState: () => state, busyRetryMs: 30000 });
  ac.arm('abc', { delayMs: 120000, reason: 'merged' });

  clock.advance(120001);
  assert.deepStrictEqual(closed, [], 'closing a busy Claude writes Ctrl+C — never mid-turn');

  clock.advance(30000);
  assert.deepStrictEqual(closed, [], 'still busy, still deferring');

  state = 'idle';
  clock.advance(30000);
  assert.deepStrictEqual(closed, [['abc', 'merged']]);
});

test("'unknown' counts as go — an agent with no screen markers must still close", () => {
  const { ac, clock, closed } = harness({ sessionState: () => 'unknown' });
  ac.arm('abc', { delayMs: 1000, reason: 'merged' });
  clock.advance(1001);
  assert.deepStrictEqual(closed, [['abc', 'merged']]);
});

test('a permanently busy session gives up rather than forcing the close', () => {
  // Bounded so a drifted screen classifier cannot pin a tab open forever, and it fails
  // OPEN so the safety net can never be the thing that destroys work.
  const { ac, clock, closed, logs } = harness({
    sessionState: () => 'busy', busyRetryMs: 30000, maxDeferrals: 3,
  });
  ac.arm('abc', { delayMs: 1000, reason: 'merged' });
  clock.advance(1001 + 30000 * 5);
  assert.deepStrictEqual(closed, [], 'gives up — does NOT interrupt');
  assert.strictEqual(ac.size, 0, 'and releases the record');
  assert.strictEqual(logs.filter((m) => m.includes('mid-turn')).length, 3, 'exactly maxDeferrals retries');
  assert.ok(logs.some((m) => m.includes('giving up')));
});

test('a wake defers without spending the busy budget, then closes', () => {
  // A timer armed before a system sleep fires the instant the daemon thaws; "2 minutes
  // have passed" has to mean 2 minutes the daemon was awake for (#563).
  let defer = 120000;
  const { ac, clock, closed, logs } = harness({ shouldDefer: () => defer, maxDeferrals: 3 });
  ac.arm('abc', { delayMs: 1000, reason: 'merged' });

  clock.advance(1001);
  assert.deepStrictEqual(closed, [], 'deferred by the wake holdoff');
  clock.advance(120000);
  assert.deepStrictEqual(closed, [], 'still within the holdoff');

  defer = 0;
  clock.advance(120000);
  assert.deepStrictEqual(closed, [['abc', 'merged']]);
  assert.ok(logs.some((m) => m.includes('recently woke')));
});

test('no close fires while the daemon is shutting down', () => {
  // Shutdown DETACHES tmux sessions so they survive the restart (#620); closing one
  // inside that window would destroy exactly what the detach preserves.
  const { ac, clock, closed } = harness({ isShuttingDown: () => true });
  ac.arm('abc', { delayMs: 1000, reason: 'merged' });
  clock.advance(600000);
  assert.deepStrictEqual(closed, []);
  assert.strictEqual(ac.size, 0);
});

test('a non-positive delay disarms instead of scheduling (0 = feature off)', () => {
  const { ac, clock, closed } = harness();
  assert.strictEqual(ac.arm('abc', { delayMs: 0, reason: 'merged' }), null);
  assert.strictEqual(clock.pending, 0);

  ac.arm('abc', { delayMs: 1000, reason: 'merged' });
  assert.strictEqual(ac.arm('abc', { delayMs: 0, reason: 'merged' }), null,
    're-arming with the feature off must also clear the pending one');
  assert.strictEqual(ac.size, 0);
  clock.advance(600000);
  assert.deepStrictEqual(closed, []);
});

test('arming an unknown session is a no-op', () => {
  const { ac, clock } = harness();
  assert.strictEqual(ac.arm('nope', { delayMs: 1000 }), null);
  assert.strictEqual(clock.pending, 0);
});

test('clearAll releases every pending close', () => {
  const { ac, clock, shells, closed } = harness();
  shells.set('def', { id: 'def' });
  ac.arm('abc', { delayMs: 1000, reason: 'merged' });
  ac.arm('def', { delayMs: 1000, reason: 'merged' });
  assert.strictEqual(ac.size, 2);

  ac.clearAll();
  assert.strictEqual(ac.size, 0);
  assert.strictEqual(clock.pending, 0);
  clock.advance(600000);
  assert.deepStrictEqual(closed, []);
});

test('a throwing closeSession is logged, not propagated, and leaves no stuck record', () => {
  const { ac, clock, logs } = harness({ closeSession: () => { throw new Error('boom'); } });
  ac.arm('abc', { delayMs: 1000, reason: 'merged' });
  assert.doesNotThrow(() => clock.advance(1001));
  assert.strictEqual(ac.size, 0);
  assert.ok(logs.some((m) => m.includes('boom')));
});
