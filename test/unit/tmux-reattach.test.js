// #626 — the startup tmux reattach path.
//
// This block decides, on every boot, whether a surviving agent comes back or is
// lost, and until now it had NO test coverage of any kind: the standalone suites
// that exercise it run only via `npm run test:standalone`, never in CI, and the
// ownership rule was pinned in engine-default.test.js against a hand-written
// *mirror* of the logic rather than the logic itself. That is how it shipped for a
// release throwing `Cannot access 'wss' before initialization` once per session per
// boot, with the failure swallowed by the per-session catch.
//
// Driving the real reattachSurvivingTmuxSessions() with fakes, so it runs on the
// bare-ubuntu CI unit job (no tmux, no zsh, `--ignore-scripts` so no node-pty
// binding).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { reattachAction, reattachSurvivingTmuxSessions } = require('../../tmux-reattach');

/** A savedState record shaped like serializeShellEntry()'s output. */
function meta(over = {}) {
  return {
    cwd: '/tmp/proj',
    claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agentType: 'claude',
    engineType: 'tmux',
    name: 'a session',
    ...over,
  };
}

/**
 * A harness that records every interaction. Individual deps can be overridden to
 * throw, which is the whole point — the interesting cases are the failures.
 */
function harness({ sessions = [], saved = {}, overrides = {} } = {}) {
  const calls = { wired: [], watched: [], unwatched: [], recorded: [], destroyed: [], detached: [], onExit: [] };
  const logs = [];
  const shells = new Map();
  const savedState = { ...saved };

  const tmuxEngine = {
    listSessions: () => sessions,
    reattach: (id) => { calls.reattached = calls.reattached || []; calls.reattached.push(id); return true; },
    destroy: (id) => calls.destroyed.push(id),
    detach: (id) => calls.detached.push(id),
    onExit: (id, cb) => calls.onExit.push({ id, cb }),
  };

  const deps = {
    tmuxEngine,
    savedState,
    shells,
    log: (m) => logs.push(m),
    getAgentConfig: (t) => ({ supportsSessionWatch: t === 'claude' }),
    wireShellOutput: (id) => calls.wired.push(id),
    watchClaudeSessionDir: (id) => calls.watched.push(id),
    unwatchClaudeSessionDir: (id) => calls.unwatched.push(id),
    handleShellGone: (id) => { calls.gone = calls.gone || []; calls.gone.push(id); },
    recordRecentSession: (id) => calls.recorded.push(id),
    ...overrides,
  };

  return { deps, calls, logs, shells, savedState, tmuxEngine, run: () => reattachSurvivingTmuxSessions(deps) };
}

const logged = (logs, re) => logs.some(l => re.test(l));

describe('#620 ownership rule (the real function, not a mirror)', () => {
  test('a session we have no record of is left strictly alone', () => {
    // tmux's socket is per-UID, not per-HOME, so listSessions() also returns other
    // daemons' sessions. Destroying those is how one forgetful test daemon used to
    // wipe every live agent on the box.
    assert.strictEqual(reattachAction(undefined), 'leave-alone');
  });

  test('our own tombstoned session is reclaimed', () => {
    assert.strictEqual(reattachAction({ closed: true, closeReason: 'user-closed' }), 'reclaim');
  });

  test('our own open session is reattached', () => {
    assert.strictEqual(reattachAction(meta()), 'reattach');
  });

  test('the rule is applied, not just defined', () => {
    const h = harness({
      sessions: ['ours', 'foreign', 'tombstoned'],
      saved: { ours: meta(), tombstoned: meta({ closed: true, closeReason: 'user-closed' }) },
    });
    const s = h.run();

    assert.deepStrictEqual(s.reattached, ['ours']);
    assert.deepStrictEqual(s.leftAlone, ['foreign']);
    assert.deepStrictEqual(s.reclaimed, ['tombstoned']);
    assert.deepStrictEqual(h.calls.destroyed, ['tombstoned'], 'only the tombstone is destroyed');
    assert.ok(!h.shells.has('foreign'), 'a foreign session is never adopted');
    assert.ok(!h.shells.has('tombstoned'), 'a reclaimed tombstone is not resurrected as live');
  });
});

describe('#626 a reattached session is fully wired, and says so', () => {
  test('the happy path wires output, the session watcher and the exit handler', () => {
    const h = harness({ sessions: ['abc123'], saved: { abc123: meta() } });
    h.run();

    const entry = h.shells.get('abc123');
    assert.ok(entry, 'the session is live');
    assert.strictEqual(entry.engine, h.tmuxEngine);
    assert.strictEqual(entry.engineType, 'tmux');
    assert.strictEqual(entry.restored, true);
    assert.deepStrictEqual([...entry.clients], [], 'nobody is attached yet — this is the unattended case');

    assert.deepStrictEqual(h.calls.wired, ['abc123']);
    assert.deepStrictEqual(h.calls.watched, ['abc123']);
    assert.strictEqual(h.calls.onExit.length, 1, 'its exit is noticed');
    assert.ok(!('abc123' in h.savedState), 'saved -> live promotion');
  });

  test('a non-claude agent gets no transcript watcher', () => {
    const h = harness({ sessions: ['t1'], saved: { t1: meta({ agentType: 'terminal' }) } });
    h.run();
    assert.deepStrictEqual(h.calls.wired, ['t1']);
    assert.deepStrictEqual(h.calls.watched, []);
  });

  test('the exit handler funnels to handleShellGone', () => {
    const h = harness({ sessions: ['x1'], saved: { x1: meta() } });
    h.run();
    h.calls.onExit[0].cb();
    assert.deepStrictEqual(h.calls.gone, ['x1']);
    assert.deepStrictEqual(h.calls.unwatched, ['x1'], 'and stops watching the transcript dir');
  });

  test('the success is LOGGED — the one signal that durability works', () => {
    // There was no `tmux: reattached session …` line in any log, ever, because the
    // TDZ threw on the statement before it. Losing this line is what turned a
    // working reattach into an unfalsifiable one, so it is now asserted.
    const h = harness({ sessions: ['abc123'], saved: { abc123: meta({ name: 'my tab' }) } });
    h.run();
    assert.ok(logged(h.logs, /tmux: reattached session abc123 \(my tab\)/), h.logs.join('\n'));
  });

  test('the saved record is carried back WHOLESALE, including fields this code has never heard of', () => {
    // The reattach is the third writer of a shell entry (with the WS restore and
    // spawn paths) and used to hand-list its fields, so everything added to
    // serializeShellEntry() since was dropped here and then wiped from state.json
    // by the next save. `aFieldFromTheFuture` stands in for the next one.
    const rich = meta({
      forkParent: '11111111-2222-3333-4444-555555555555',
      planMode: true, model: 'haiku', effort: 'low',
      allowedTools: ['mcp__deepsteve__scheduled_task_finished'],
      scheduled: true, windowId: 'win-abc', worktree: 'wt-x', configDir: '/tmp/profile',
      aFieldFromTheFuture: 'must survive',
    });
    const h = harness({ sessions: ['rich01'], saved: { rich01: rich } });
    h.run();

    const entry = h.shells.get('rich01');
    for (const k of Object.keys(rich)) {
      if (k === 'engineType') continue; // deliberately re-asserted as 'tmux'
      assert.deepStrictEqual(entry[k], rich[k], `${k} survived the reattach`);
    }
  });
});

describe('#626 failures are honest and never lose a running agent', () => {
  test('a throwing recordRecentSession does NOT lose the session, and is not called a reattach failure', () => {
    // This is the exact #626 bug: recordRecentSession -> broadcastRecentSessions ->
    // `wss.clients`, evaluated before `const wss` existed. It threw for every
    // session on every boot into the per-session catch, which reported it as
    // "error reattaching session <id>, skipping it" — a message that is wrong twice
    // over (the session was neither skipped nor failed).
    const h = harness({
      sessions: ['abc123'],
      saved: { abc123: meta() },
      overrides: { recordRecentSession: () => { throw new ReferenceError("Cannot access 'wss' before initialization"); } },
    });
    const s = h.run();

    assert.deepStrictEqual(s.reattached, ['abc123'], 'reported as reattached, because it was');
    assert.deepStrictEqual(s.failed, [], 'and NOT as a failure');
    assert.ok(h.shells.has('abc123'), 'the session is still live');
    assert.deepStrictEqual(h.calls.wired, ['abc123'], 'still readable');
    assert.ok(!('abc123' in h.savedState), 'still promoted');
    assert.ok(logged(h.logs, /tmux: reattached session abc123/), 'the success line still prints');
    assert.ok(logged(h.logs, /recording it as recent failed/), 'and the real problem is named');
  });

  test('a throwing wireShellOutput rolls all the way back instead of leaving a deaf session', () => {
    const h = harness({
      sessions: ['bad001'],
      saved: { bad001: meta() },
      overrides: { wireShellOutput: () => { throw new Error('TerminalScreen exploded'); } },
    });
    const s = h.run();

    assert.deepStrictEqual(s.failed, ['bad001']);
    assert.deepStrictEqual(s.reattached, []);
    assert.ok(!h.shells.has('bad001'), 'no half-wired entry is left behind');
    assert.deepStrictEqual(h.savedState.bad001, meta(), 'the saved record is restored, still not closed');
    assert.deepStrictEqual(h.calls.detached, ['bad001'], 'our pipe is released');
    assert.deepStrictEqual(h.calls.destroyed, [], 'but the agent is NEVER destroyed');
    assert.ok(logged(h.logs, /FAILED to reattach session bad001/), h.logs.join('\n'));
  });

  test('one bad session cannot take the daemon, or its siblings, down', () => {
    let n = 0;
    const h = harness({
      sessions: ['s1', 's2', 's3'],
      saved: { s1: meta(), s2: meta(), s3: meta() },
      overrides: { wireShellOutput: (id) => { if (++n === 2) throw new Error('boom'); } },
    });
    const s = h.run();
    assert.deepStrictEqual(s.reattached, ['s1', 's3']);
    assert.deepStrictEqual(s.failed, ['s2']);
  });

  test('a session that vanished between listSessions() and reattach() keeps its saved record', () => {
    const h = harness({
      sessions: ['gone01'],
      saved: { gone01: meta() },
      overrides: { tmuxEngine: { listSessions: () => ['gone01'], reattach: () => false, destroy() {}, detach() {}, onExit() {} } },
    });
    const s = h.run();
    assert.deepStrictEqual(s.failed, ['gone01']);
    assert.ok(!h.shells.has('gone01'));
    assert.ok(h.savedState.gone01, 'left for a later WS connect to restore the normal way');
  });

  test('no tmux at all is a no-op, not a crash', () => {
    const s = reattachSurvivingTmuxSessions({ tmuxEngine: null });
    assert.deepStrictEqual(s.found, []);
  });
});

describe('#626 the call site invariant', () => {
  test('server.js reattaches only AFTER the WebSocket servers exist', () => {
    // The bug was pure statement order: the reattach ran at module scope above
    // `const wss`, and reattaching broadcasts. `typeof` does not save you — reading
    // a `const` in its temporal dead zone throws — so the only durable fix is
    // ordering, and the only durable guard is asserting that order.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const wssDecl = src.indexOf('const wss = new WebSocketServer');
    const call = src.indexOf('reattachSurvivingTmuxSessions({');
    assert.ok(wssDecl !== -1, 'found the wss declaration');
    assert.ok(call !== -1, 'found the reattach call site');
    assert.ok(call > wssDecl,
      'reattachSurvivingTmuxSessions() must be called after `const wss` — it broadcasts, ' +
      'and reading wss before its declaration is a temporal dead zone ReferenceError (#626)');
  });
});
