// Timelapse snapshot shaping (#667) — the server-side join and the run summary.
//
// These are the two computations a day-long run's usefulness rests on, and both fail
// quietly: a join that drops agentType still writes a well-formed sidecar, and a summary
// that counts a tab once per frame still returns a plausible number. So the numbers are
// asserted against fixtures rather than eyeballed on a real run.
//
// Run: node --test test/unit/timelapse-snapshot.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { enrichTabs, summarizeRun } = require('../../timelapse-snapshot');

// ------------------------------------------------------------------ fake daemon state

const sessionInputState = (e) => e.screen || 'unknown';
const sessionPaths = (e) => ({ cwd: e.cwd, repoRoot: e.repoRoot || e.cwd });

function fakeShells() {
  return new Map([
    ['s1', {
      cwd: '/repo/deepsteve', repoRoot: '/repo/deepsteve', agentType: 'claude',
      engineType: 'tmux', worktree: null, windowId: 'win-a', screen: 'busy',
      createdAt: 100, lastActivity: 200, lastInputTime: 150,
    }],
    ['s2', {
      cwd: '/repo/deepsteve/.claude/worktrees/issue-667', repoRoot: '/repo/deepsteve',
      agentType: 'codex', engineType: 'tmux', worktree: 'issue-667', windowId: 'win-a',
      screen: 'idle', createdAt: 300, lastActivity: 400, lastInputTime: null,
    }],
  ]);
}

const deps = () => ({
  shells: fakeShells(),
  savedState: { s3: { cwd: '/repo/old', agentType: 'claude', worktree: 'gone', closed: true } },
  sessionInputState,
  sessionPaths,
});

// ----------------------------------------------------------------------- enrichTabs

test('enrichTabs joins the browser tab strip with daemon session facts', () => {
  const rows = enrichTabs([
    { id: 's1', index: 0, title: 'deepsteve', type: 'terminal', active: true, waitingForInput: false },
    { id: 's2', index: 1, title: 'issue-667', type: 'terminal', waitingForInput: true },
  ], deps());

  assert.strictEqual(rows[0].agentType, 'claude');
  assert.strictEqual(rows[0].state, 'busy');
  assert.strictEqual(rows[0].engineType, 'tmux');
  assert.strictEqual(rows[0].lastInputTime, 150);
  assert.strictEqual(rows[0].live, true);
  assert.strictEqual(rows[0].active, true);

  // The worktree flag and the repo root are the two facts the browser cannot supply, and
  // sessionPaths is what separates the worktree cwd from the repo it belongs to.
  assert.strictEqual(rows[1].worktree, 'issue-667');
  assert.strictEqual(rows[1].repoRoot, '/repo/deepsteve');
  assert.strictEqual(rows[1].agentType, 'codex');
  assert.strictEqual(rows[1].state, 'idle');
  assert.strictEqual(rows[1].waitingForInput, true);
});

test('enrichTabs preserves the browser index, not the array position', () => {
  // A tab hidden by the context filter still holds its place in the strip. If the join
  // renumbered rows the recorded layout would stop matching the screen.
  const rows = enrichTabs([
    { id: 's1', index: 3, type: 'terminal' },
    { id: 's2', index: 7, type: 'terminal' },
  ], deps());
  assert.deepStrictEqual(rows.map(r => r.index), [3, 7]);
});

test('enrichTabs passes non-terminal tabs through without inventing session fields', () => {
  const rows = enrichTabs([
    { id: 'd1', index: 0, title: 'Charts', type: 'display-tab', cwd: '/repo/x' },
    { id: 'm1', index: 1, title: 'Tower', type: 'mod-tab', modId: 'tower' },
    { id: 'p1', index: 2, title: 'Dash', type: 'project-mod', projectModId: 'dash' },
  ], deps());

  assert.deepStrictEqual(rows.map(r => r.type), ['display-tab', 'mod-tab', 'project-mod']);
  assert.strictEqual(rows[0].cwd, '/repo/x');
  assert.strictEqual(rows[1].modId, 'tower');
  assert.strictEqual(rows[2].projectModId, 'dash');
  // They have no PTY, so they must not claim one.
  for (const r of rows) {
    assert.strictEqual(r.agentType, undefined);
    assert.strictEqual(r.state, undefined);
  }
});

test('enrichTabs marks a tab the daemon no longer has as not live', () => {
  // Closed between the browser painting the strip and the frame landing. Say so rather
  // than inventing fields — the tab still counts as one that was opened.
  const rows = enrichTabs([
    { id: 's3', index: 0, title: 'old', type: 'terminal' },
    { id: 'ghost', index: 1, title: '?', type: 'terminal' },
  ], deps());

  assert.strictEqual(rows[0].live, false);
  assert.strictEqual(rows[0].agentType, 'claude');   // recovered from savedState
  assert.strictEqual(rows[0].worktree, 'gone');
  assert.strictEqual(rows[0].state, 'unknown');

  assert.strictEqual(rows[1].live, false);
  assert.strictEqual(rows[1].agentType, null);
  assert.strictEqual(rows[1].state, 'unknown');
});

test('enrichTabs survives junk input', () => {
  assert.deepStrictEqual(enrichTabs(null, deps()), []);
  assert.deepStrictEqual(enrichTabs(undefined, deps()), []);
  const rows = enrichTabs([null, 'nope', {}], deps());
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].id, null);
  assert.strictEqual(rows[2].type, 'terminal');
});

test('enrichTabs works with no optional deps at all', () => {
  const rows = enrichTabs([{ id: 's1', type: 'terminal' }], { shells: fakeShells() });
  assert.strictEqual(rows[0].state, 'unknown');       // no classifier supplied
  assert.strictEqual(rows[0].cwd, '/repo/deepsteve'); // no sessionPaths → entry.cwd
});

// ---------------------------------------------------------------------- summarizeRun

const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

/** A frame at `min` minutes past T0. */
function frame(min, { focus = true, sinceInput = 1000, tabs = [] } = {}) {
  return {
    capturedAt: T0 + min * MIN,
    window: { hasFocus: focus, visibilityState: 'visible', msSinceInput: sinceInput },
    tabs,
  };
}

const TERM = (id) => ({ id, type: 'terminal', agentType: 'claude', state: 'idle' });

test('summarizeRun counts DISTINCT tabs, not tab-appearances', () => {
  // The question the whole feature exists to answer. A tab open for all 6 frames must
  // count once; the run below opens a second tab partway through and a display tab later.
  const frames = [
    frame(0,  { tabs: [TERM('a')] }),
    frame(5,  { tabs: [TERM('a')] }),
    frame(10, { tabs: [TERM('a'), TERM('b')] }),
    frame(15, { tabs: [TERM('a'), TERM('b')] }),
    frame(20, { tabs: [TERM('b'), { id: 'd1', type: 'display-tab' }] }),
    frame(25, { tabs: [TERM('b'), { id: 'd1', type: 'display-tab' }] }),
  ];
  const s = summarizeRun(frames, 5 * MIN);

  assert.strictEqual(s.frames, 6);
  assert.strictEqual(s.distinctTabs, 3);
  assert.deepStrictEqual(s.distinctTabsByType, { terminal: 2, 'display-tab': 1 });
  assert.deepStrictEqual(s.distinctAgentTypes, { claude: 2 });
  assert.strictEqual(s.maxTabsOpen, 2);
});

test('summarizeRun separates open from focused from actually being used', () => {
  // The other question. Three frames: worked in, focused but idle for 40 minutes, and
  // in a background tab entirely.
  const frames = [
    frame(0,  { focus: true,  sinceInput: 30 * 1000 }),
    frame(5,  { focus: true,  sinceInput: 40 * MIN }),
    { capturedAt: T0 + 10 * MIN, window: { hasFocus: false, visibilityState: 'hidden', msSinceInput: 45 * MIN }, tabs: [] },
  ];
  const s = summarizeRun(frames, 5 * MIN);

  assert.strictEqual(s.frames, 3);
  assert.strictEqual(s.visibleFrames, 2);
  assert.strictEqual(s.focusedFrames, 2);
  assert.strictEqual(s.activeFrames, 1); // focus alone is not use
});

test('summarizeRun reports gaps and excludes them from recorded time', () => {
  // The browser was closed between minute 10 and minute 70. That hole is the answer to
  // "how much time did I actually spend", so it must not be counted as time in the app.
  const frames = [frame(0), frame(5), frame(10), frame(70), frame(75)];
  const s = summarizeRun(frames, 5 * MIN);

  assert.strictEqual(s.gaps.length, 1);
  assert.strictEqual(s.gaps[0].ms, 60 * MIN);
  assert.strictEqual(s.gaps[0].from, T0 + 10 * MIN);
  assert.strictEqual(s.spanMs, 75 * MIN);
  // Three unbroken 5-minute steps (0→5, 5→10, 70→75). The hour-long hole is excluded, so
  // 75 minutes of wall clock is 15 minutes of recorded presence.
  assert.strictEqual(s.recordedMs, 15 * MIN);
});

test('summarizeRun sorts by capture time and tolerates junk rows', () => {
  const s = summarizeRun([frame(10), null, frame(0), { capturedAt: 'nope' }, frame(5)], 5 * MIN);
  assert.strictEqual(s.frames, 3);
  assert.strictEqual(s.startedAt, T0);
  assert.strictEqual(s.endedAt, T0 + 10 * MIN);
});

test('summarizeRun infers the interval when none is given', () => {
  // A run summarized without its manifest still has to know what "a gap" means, so it
  // falls back to its own median spacing rather than assuming five minutes.
  const frames = [frame(0), frame(1), frame(2), frame(30)];
  const s = summarizeRun(frames);
  assert.strictEqual(s.intervalMs, 1 * MIN);
  assert.strictEqual(s.gaps.length, 1);
});

test('summarizeRun handles an empty run', () => {
  const s = summarizeRun([]);
  assert.strictEqual(s.frames, 0);
  assert.strictEqual(s.distinctTabs, 0);
  assert.deepStrictEqual(s.gaps, []);
  assert.strictEqual(s.startedAt, null);
});

test('summarizeRun counts a frame busy when ANY tab is working', () => {
  const frames = [
    frame(0, { tabs: [{ id: 'a', type: 'terminal', state: 'idle' }] }),
    frame(5, { tabs: [{ id: 'a', type: 'terminal', state: 'idle' }, { id: 'b', type: 'terminal', state: 'busy' }] }),
  ];
  assert.strictEqual(summarizeRun(frames, 5 * MIN).busyFrames, 1);
});
