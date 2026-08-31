// Headless unit test for the pure helpers in public/js/session-restore-modal.js
// (#560, reshaped by #658).
//
// No browser, no Docker. The exported helpers (windowRows, defaultWindowSelection,
// selectedSessionCount, primaryLabel, buildSelection, buildArchiveSelection,
// describeCloseReason, applyClaim, allRowKeys) are pure and driven directly;
// showSessionRestoreModal itself needs a real DOM and is exercised by the
// integration/manual flows, not here — repo convention is pure-helper extraction
// over DOM stubbing (see window-merge.test.js).
//
// The import chain pulls in tab-manager.js, which registers document listeners
// at module scope — hence the minimal document stub. window.parent = window
// keeps storage-namespace.js at depth 0 (same trap documented in
// context-views.test.js).
//
// Run: node --test test/unit/session-restore-modal.test.js

const { test } = require('node:test');
const assert = require('node:assert');

globalThis.window = globalThis;
globalThis.window.parent = globalThis.window;
globalThis.document = {
  addEventListener: () => {},
  getElementById: () => null,
};

const load = () => import('../../public/js/session-restore-modal.js');

// --------------------------------------------------------------- fixtures

const sess = (id, extra = {}) => ({ id, cwd: '/repo', name: null, ...extra });
const win = (windowId, sessions, extra = {}) => ({ windowId, live: false, lastActive: 1000, sessions, ...extra });
const recent = (key, extra = {}) => ({ key, cwd: '/repo', name: null, updatedAt: 1000, ...extra });

// The /api/recoverable-sessions shape after client-side merging.
function data({ windows = [], ungrouped = [], closed = [], recents = [] } = {}) {
  return { windows, ungrouped, closed, recents };
}

// --------------------------------------------------------------- windowRows
// The whole point of #658: the modal's row is a WINDOW, not an agent session. A
// window holding 7 sessions is one row, and the 1000-row per-session list is gone.

test('windowRows makes one row per window, whatever the session count', async () => {
  const { windowRows } = await load();
  const rows = windowRows(data({
    windows: [
      win('w1', [sess('a'), sess('b'), sess('c')], { lastActive: 3000 }),
      win('w2', [sess('d')], { lastActive: 2000 }),
    ],
  }));
  assert.strictEqual(rows.length, 2, 'two windows, two rows — not four sessions');
  assert.deepStrictEqual(rows.map(r => r.count), [3, 1]);
  assert.deepStrictEqual(rows.map(r => r.key), ['win:w1', 'win:w2']);
});

test('windowRows orders newest-active first', async () => {
  const { windowRows } = await load();
  const rows = windowRows(data({
    windows: [
      win('old', [sess('a')], { lastActive: 1000 }),
      win('new', [sess('b')], { lastActive: 9000 }),
      win('mid', [sess('c')], { lastActive: 5000 }),
    ],
  }));
  assert.deepStrictEqual(rows.map(r => r.windowId), ['new', 'mid', 'old']);
});

test('windowRows falls back to session timestamps when the window has no lastActive', async () => {
  const { windowRows } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [sess('a', { lastActivity: 40 }), sess('b', { lastActivity: 700 })], { lastActive: 0 })],
  }));
  assert.strictEqual(rows[0].lastActive, 700);
});

test('windowRows appends ungrouped sessions as ONE row, always last', async () => {
  // They are live agents with no windowId, so hiding them would strand running
  // work — but N of them are not N windows, so they collapse into a single row.
  const { windowRows, UNGROUPED_KEY } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [sess('a')], { lastActive: 10 })],
    ungrouped: [sess('x'), sess('y'), sess('z')],
  }));
  assert.strictEqual(rows.length, 2);
  const loose = rows[rows.length - 1];
  assert.strictEqual(loose.key, UNGROUPED_KEY);
  assert.strictEqual(loose.ungrouped, true);
  assert.strictEqual(loose.count, 3);
});

test('windowRows omits the ungrouped row when there are none', async () => {
  const { windowRows } = await load();
  const rows = windowRows(data({ windows: [win('w1', [sess('a')])] }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ungrouped, false);
});

test('windowRows on empty data is empty — the archive-fallback trigger', async () => {
  const { windowRows } = await load();
  assert.deepStrictEqual(windowRows(data()), []);
});

test('windowRows lists distinct projects, in first-seen order', async () => {
  const { windowRows } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [
      sess('a', { cwd: '/src/yarnstory' }),
      sess('b', { cwd: '/src/wrds-flutter' }),
      sess('c', { cwd: '/src/yarnstory' }),
    ])],
  }));
  assert.deepStrictEqual(rows[0].projects, ['yarnstory', 'wrds-flutter']);
});

// --------------------------------------- cwdMissing (#632) at window granularity

test('windowRows counts sessions whose directory is gone', async () => {
  const { windowRows } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [sess('a'), sess('b', { cwdMissing: true }), sess('c', { cwdMissing: true })])],
  }));
  assert.strictEqual(rows[0].count, 3);
  assert.strictEqual(rows[0].missing, 2);
  assert.strictEqual(rows[0].restorable, 1);
});

test('defaultWindowSelection picks the newest window and nothing else', async () => {
  // The picker is a radio group: one window, the one you just lost. Pre-checking
  // every row reopened a month of browsing history into a single tab.
  const { windowRows, defaultWindowSelection } = await load();
  const rows = windowRows(data({
    windows: [
      win('older', [sess('a')], { lastActive: 1000 }),
      win('newest', [sess('b')], { lastActive: 9000 }),
    ],
    ungrouped: [sess('c')],
  }));
  assert.deepStrictEqual([...defaultWindowSelection(rows)], ['win:newest']);
});

test('defaultWindowSelection falls through to the newest window that can still reopen', async () => {
  // Selecting it would promise a reopen the server is going to refuse (#632), so
  // a wholly-missing newest window hands the default to the next one down.
  const { windowRows, defaultWindowSelection } = await load();
  const rows = windowRows(data({
    windows: [
      win('dead', [sess('c', { cwdMissing: true })], { lastActive: 9000 }),
      win('alive', [sess('a'), sess('b', { cwdMissing: true })], { lastActive: 1000 }),
    ],
  }));
  assert.deepStrictEqual([...defaultWindowSelection(rows)], ['win:alive'],
    'a partially-missing window still counts; a wholly-missing one does not');
});

test('defaultWindowSelection can land on the ungrouped row when it is all there is', async () => {
  const { windowRows, defaultWindowSelection } = await load();
  const rows = windowRows(data({ ungrouped: [sess('a')] }));
  assert.deepStrictEqual([...defaultWindowSelection(rows)], ['ungrouped']);
});

test('defaultWindowSelection on no rows is empty', async () => {
  const { defaultWindowSelection } = await load();
  assert.strictEqual(defaultWindowSelection([]).size, 0);
});

// --------------------------------------------------------------- row copy

test('windowRowTitle counts sessions and names the ungrouped row for what it is', async () => {
  const { windowRows, windowRowTitle } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [sess('a'), sess('b')]), win('w2', [sess('c')])],
    ungrouped: [sess('x')],
  }));
  assert.strictEqual(windowRowTitle(rows[0]), '2 sessions');
  assert.strictEqual(windowRowTitle(rows[1]), '1 session');
  assert.strictEqual(windowRowTitle(rows[2]), '1 session not in a window');
});

test('windowRowProjects summarises past three projects instead of listing them all', async () => {
  const { windowRowProjects, PROJECTS_SHOWN } = await load();
  assert.strictEqual(windowRowProjects({ projects: ['a', 'b'] }), 'a · b');
  assert.strictEqual(windowRowProjects({ projects: ['a', 'b', 'c'] }), 'a · b · c');
  assert.strictEqual(windowRowProjects({ projects: ['a', 'b', 'c', 'd', 'e'] }), 'a · b · c · +2 more');
  assert.strictEqual(PROJECTS_SHOWN, 3);
});

test('windowRowMeta says how many sessions a window will come back short', async () => {
  // A window that reopens two sessions light must not do so silently.
  const { windowRowMeta } = await load();
  const now = 1_000_000_000;
  const meta = windowRowMeta({ lastActive: now - 120_000, missing: 2, restorable: 5 }, now);
  assert.match(meta, /last active 2 minutes ago/);
  assert.match(meta, /2 can't reopen/);
});

test('windowRowMeta says a wholly-dead window cannot reopen at all', async () => {
  const { windowRowMeta } = await load();
  const now = 1_000_000_000;
  assert.match(windowRowMeta({ lastActive: now, missing: 1, restorable: 0 }, now), /can't reopen/);
});

test('windowRowMeta on a healthy window mentions only its age', async () => {
  const { windowRowMeta } = await load();
  const now = 1_000_000_000;
  assert.strictEqual(windowRowMeta({ lastActive: now - 3600_000, missing: 0, restorable: 4 }, now),
    'last active 1 hour ago');
});

// --------------------------------------------------------------- counts and labels

test('selectedSessionCount adds up the sessions behind the checked windows', async () => {
  const { windowRows, selectedSessionCount } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [sess('a'), sess('b'), sess('c')]), win('w2', [sess('d')])],
  }));
  assert.strictEqual(selectedSessionCount(rows, new Set(['win:w1'])), 3);
  assert.strictEqual(selectedSessionCount(rows, new Set(['win:w1', 'win:w2'])), 4);
  assert.strictEqual(selectedSessionCount(rows, new Set()), 0);
});

test('selectedSessionCount promises only what can actually reopen', async () => {
  const { windowRows, selectedSessionCount } = await load();
  const rows = windowRows(data({
    windows: [win('w1', [sess('a'), sess('b', { cwdMissing: true })])],
  }));
  assert.strictEqual(selectedSessionCount(rows, new Set(['win:w1'])), 1);
});

test('primaryLabel counts sessions, with no denominator', async () => {
  // The old label read `Restore Selected (1 of 1082)` — the denominator was the
  // whole retention window, so the primary button announced you were recovering
  // 0.1% of your work. There is nothing to be a fraction of any more.
  const { primaryLabel } = await load();
  assert.strictEqual(primaryLabel(7), 'Reopen 7 sessions');
  assert.strictEqual(primaryLabel(1), 'Reopen 1 session');
  assert.strictEqual(primaryLabel(0), 'Reopen');
});

// --------------------------------------------------------------- buildSelection

test('buildSelection keeps window groups, single-session ones included', async () => {
  // app.js feeds these to WindowManager.claimSessions, which needs windowId to
  // clear the donor window's localStorage rows. Flattening a 1-session window
  // into `sessions` would leave the donor pointing at a tab that moved here.
  const { buildSelection } = await load();
  const d = data({
    windows: [win('w1', [sess('a'), sess('b')]), win('w2', [sess('c')])],
    ungrouped: [sess('x')],
  });
  const out = buildSelection(d, new Set(['win:w1', 'win:w2']));
  assert.deepStrictEqual(out.windows.map(w => w.windowId), ['w1', 'w2']);
  assert.deepStrictEqual(out.windows[1].sessions.map(s => s.id), ['c']);
  assert.deepStrictEqual(out.sessions, [], 'ungrouped was not checked');
});

test('buildSelection takes the ungrouped bucket only when its row is checked', async () => {
  const { buildSelection, UNGROUPED_KEY } = await load();
  const d = data({ windows: [win('w1', [sess('a')])], ungrouped: [sess('x'), sess('y')] });

  assert.deepStrictEqual(buildSelection(d, new Set([UNGROUPED_KEY])).sessions.map(s => s.id), ['x', 'y']);
  assert.deepStrictEqual(buildSelection(d, new Set([UNGROUPED_KEY])).windows, []);
});

test('buildSelection drops sessions whose directory is gone', async () => {
  // Sending them buys the user a pile of refusal banners from one click (#632).
  const { buildSelection } = await load();
  const d = data({
    windows: [win('w1', [sess('a'), sess('b', { cwdMissing: true })])],
    ungrouped: [sess('x', { cwdMissing: true }), sess('y')],
  });
  const out = buildSelection(d, new Set(['win:w1', 'ungrouped']));
  assert.deepStrictEqual(out.windows[0].sessions.map(s => s.id), ['a']);
  assert.deepStrictEqual(out.sessions.map(s => s.id), ['y']);
});

test('buildSelection prunes a window left with nothing to send', async () => {
  const { buildSelection } = await load();
  const d = data({ windows: [win('dead', [sess('a', { cwdMissing: true })])] });
  assert.deepStrictEqual(buildSelection(d, new Set(['win:dead'])).windows, []);
});

test('buildSelection never returns recents — those live in archive mode only', async () => {
  const { buildSelection } = await load();
  const d = data({ windows: [win('w1', [sess('a')])], recents: [recent('r1')] });
  assert.deepStrictEqual(buildSelection(d, new Set(['win:w1'])).recents, []);
});

// --------------------------------------------------------------- archive mode

test('buildArchiveSelection picks individual sessions and recents', async () => {
  const { buildArchiveSelection } = await load();
  const d = data({
    ungrouped: [sess('u1')],
    closed: [sess('c1'), sess('c2')],
    recents: [recent('r1'), recent('r2')],
  });
  const out = buildArchiveSelection(d, new Set(['u1', 'c2', 'recent:r1']));
  assert.deepStrictEqual(out.sessions.map(s => s.id), ['u1', 'c2']);
  assert.deepStrictEqual(out.recents.map(r => r.key), ['r1']);
  assert.deepStrictEqual(out.windows, []);
});

// --------------------------------------------------------------- archive paging
// The archive is the only unbounded list left, so it keeps the cap the old preview
// slice provided — but not the collapsing UI, and not a group checkbox above it.

test('takeArchivePage caps the drawn rows and reports the remainder', async () => {
  const { takeArchivePage, ARCHIVE_PAGE } = await load();
  const rows = Array.from({ length: 1100 }, (_, i) => ({ key: `c${i}` }));

  const first = takeArchivePage(rows, ARCHIVE_PAGE);
  assert.strictEqual(first.shown.length, ARCHIVE_PAGE);
  assert.strictEqual(first.hidden, 1100 - ARCHIVE_PAGE);
  // Newest-first ordering comes from the server; the slice must not reorder.
  assert.deepStrictEqual(first.shown.map(r => r.key), rows.slice(0, ARCHIVE_PAGE).map(r => r.key));
});

test('takeArchivePage grows a page at a time and settles exactly at the end', async () => {
  const { takeArchivePage } = await load();
  const rows = Array.from({ length: 120 }, (_, i) => ({ key: `c${i}` }));
  assert.strictEqual(takeArchivePage(rows, 100).hidden, 20);
  const done = takeArchivePage(rows, 150); // asked for more than exists
  assert.strictEqual(done.shown.length, 120, 'never over-slices');
  assert.strictEqual(done.hidden, 0);
});

test('takeArchivePage does not page a list that already fits', async () => {
  const { takeArchivePage, ARCHIVE_PAGE } = await load();
  const rows = Array.from({ length: 3 }, (_, i) => ({ key: `c${i}` }));
  const out = takeArchivePage(rows, ARCHIVE_PAGE);
  assert.strictEqual(out.shown.length, 3);
  assert.strictEqual(out.hidden, 0);
});

test('takeArchivePage tolerates a missing list', async () => {
  const { takeArchivePage, ARCHIVE_PAGE } = await load();
  assert.deepStrictEqual(takeArchivePage(undefined, ARCHIVE_PAGE), { shown: [], hidden: 0 });
});

test('an undrawn archive row is never a selected one', async () => {
  // The old collapsed section kept its checkbox addressing the FULL closed list, so
  // one click could select 1073 rows you could not see. Nothing is pre-checked here
  // and there is no group checkbox, so paging cannot select anything.
  const { takeArchivePage, ARCHIVE_PAGE, buildArchiveSelection } = await load();
  const closed = Array.from({ length: 300 }, (_, i) => sess(`c${i}`));
  const page = takeArchivePage(closed, ARCHIVE_PAGE);
  assert.ok(page.hidden > 0, 'this fixture is meant to be paged');

  const drawn = new Set(page.shown.map(r => r.id));
  const selection = buildArchiveSelection(data({ closed }), drawn);
  assert.strictEqual(selection.sessions.length, ARCHIVE_PAGE,
    'only rows that were actually drawn can end up selected');
});

// --------------------------------------------------------------- describeCloseReason
// `(tmux-pane-exited)`, `(exited)`, `(closed)` are wire values, and the section that
// held them was headed "closed on purpose" — which is simply false for an exit.

test('describeCloseReason separates what you did from what happened on its own', async () => {
  const { describeCloseReason } = await load();
  assert.strictEqual(describeCloseReason('user-closed'), 'you closed it');
  assert.strictEqual(describeCloseReason('closed'), 'you closed it');
  assert.strictEqual(describeCloseReason('exited'), 'the agent exited');
  assert.strictEqual(describeCloseReason('tmux-pane-exited'), 'its terminal pane exited');
  assert.strictEqual(describeCloseReason('merged'), 'merged, then closed itself');
  assert.strictEqual(describeCloseReason('terminal-run-finished'), 'a one-off command finished');
});

test('describeCloseReason matches the restore-gave-up family by prefix', async () => {
  // The reason carries the attempt number, so an exact match would miss every one.
  const { describeCloseReason } = await load();
  assert.strictEqual(describeCloseReason('restore-gave-up-after-attempt-0'), 'a restore failed');
  assert.strictEqual(describeCloseReason('restore-gave-up-after-attempt-2'), 'a restore failed');
});

test('describeCloseReason never leaks a raw enum, including one it has never seen', async () => {
  const { describeCloseReason } = await load();
  for (const raw of ['some-future-reason', '', null, undefined, 'killed', 'socket-migration', 'disconnected']) {
    const out = describeCloseReason(raw);
    assert.ok(out && !out.includes('-'), `"${raw}" produced "${out}"`);
    if (raw) assert.notStrictEqual(out, raw);
  }
});

// --------------------------------------------------------------- sessionRowTitle
// The issue's own example: rows titled the same as their project (yarnstory /
// yarnstory), because the fallback chain ended at the cwd basename that the meta
// line already shows.

test('sessionRowTitle prefers a real name, then a transcript label, then the worktree', async () => {
  const { sessionRowTitle } = await load();
  assert.deepStrictEqual(sessionRowTitle({ name: 'Mine', label: 'derived', worktree: 'wt' }),
    { text: 'Mine', known: true });
  assert.deepStrictEqual(sessionRowTitle({ name: null, label: 'derived', worktree: 'wt' }),
    { text: 'derived', known: true });
  assert.deepStrictEqual(sessionRowTitle({ name: null, label: null, worktree: 'issue-658' }),
    { text: 'issue-658', known: true });
});

test('sessionRowTitle never echoes the project name as the title', async () => {
  const { sessionRowTitle } = await load();
  const out = sessionRowTitle({ name: null, label: null, worktree: null, cwd: '/src/yarnstory' });
  assert.strictEqual(out.known, false);
  assert.notStrictEqual(out.text, 'yarnstory', 'the project is already on the meta line');
  assert.strictEqual(out.text, 'Untitled session');
});

// --------------------------------------------------------------- allRowKeys

test('allRowKeys covers group keys AND the sessions underneath them', async () => {
  // Both halves matter: window mode checks group keys while a claim names session
  // ids, so a key set built from ids alone would unselect every window the moment
  // a sibling window restored anything.
  const { allRowKeys } = await load();
  const keys = allRowKeys(data({
    windows: [win('w1', [sess('a')]), win('w2', [sess('b')])],
    ungrouped: [sess('c')],
    closed: [sess('d')],
    recents: [recent('r1')],
  }));
  assert.deepStrictEqual(keys.sort(),
    ['a', 'b', 'c', 'd', 'recent:r1', 'ungrouped', 'win:w1', 'win:w2']);
});

test('allRowKeys omits the ungrouped key when the bucket is empty', async () => {
  const { allRowKeys } = await load();
  assert.deepStrictEqual(allRowKeys(data({ windows: [win('w1', [sess('a')])] })).sort(), ['a', 'win:w1']);
});

// --------------------------------------------------------------- applyClaim

test('applyClaim removes claimed rows and prunes emptied window groups', async () => {
  const { applyClaim } = await load();
  const before = data({
    windows: [win('w1', [sess('a'), sess('b')]), win('w2', [sess('c')])],
    ungrouped: [sess('d')],
    closed: [sess('e')],
    recents: [recent('r1')],
  });
  const checked = new Set(['a', 'b', 'c', 'd']);
  const out = applyClaim(before, checked, { sessionIds: ['b', 'c', 'e'], recentKeys: ['r1'] });

  assert.deepStrictEqual(out.data.windows.map(w => w.windowId), ['w1']); // w2 emptied → pruned
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a']);
  assert.deepStrictEqual(out.data.ungrouped.map(s => s.id), ['d']);
  assert.deepStrictEqual(out.data.closed, []);
  assert.deepStrictEqual(out.data.recents, []);
});

test('applyClaim keeps a surviving window CHECKED when a sibling window is claimed', async () => {
  // The window-mode regression guard: checked keys are 'win:*', claims name
  // session ids. Pruning against session ids alone would clear the whole picker.
  const { applyClaim } = await load();
  const before = data({
    windows: [win('w1', [sess('a'), sess('b')]), win('w2', [sess('c')])],
  });
  const out = applyClaim(before, new Set(['win:w1', 'win:w2']), { sessionIds: ['c'] });
  assert.deepStrictEqual([...out.checkedKeys], ['win:w1'], 'w1 stays checked; w2 is gone');
  assert.deepStrictEqual(out.data.windows.map(w => w.windowId), ['w1']);
});

test('applyClaim unchecks the ungrouped row once its last session is claimed', async () => {
  const { applyClaim, UNGROUPED_KEY } = await load();
  const before = data({ windows: [win('w1', [sess('a')])], ungrouped: [sess('x')] });
  const out = applyClaim(before, new Set(['win:w1', UNGROUPED_KEY]), { sessionIds: ['x'] });
  assert.deepStrictEqual([...out.checkedKeys], ['win:w1']);
});

test('applyClaim preserves the survivors\' check state exactly', async () => {
  const { applyClaim } = await load();
  const before = data({
    windows: [win('w1', [sess('a'), sess('b'), sess('c')])],
  });
  // b claimed elsewhere; a was checked, c deliberately unchecked.
  const out = applyClaim(before, new Set(['a', 'b']), { sessionIds: ['b'] });
  assert.deepStrictEqual([...out.checkedKeys], ['a']); // b gone, c still unchecked
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a', 'c']);
});

test('applyClaim with unknown ids is a no-op', async () => {
  const { applyClaim } = await load();
  const before = data({ windows: [win('w1', [sess('a')])], recents: [recent('r1')] });
  const checked = new Set(['a']);
  const out = applyClaim(before, checked, { sessionIds: ['zzz'], recentKeys: ['nope'] });
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a']);
  assert.deepStrictEqual(out.data.recents.map(r => r.key), ['r1']);
  assert.deepStrictEqual([...out.checkedKeys], ['a']);
});

test('applyClaim claiming everything leaves nothing offerable', async () => {
  const { applyClaim, allRowKeys } = await load();
  const before = data({
    windows: [win('w1', [sess('a')])],
    closed: [sess('b')],
    recents: [recent('r1')],
  });
  const out = applyClaim(before, new Set(['win:w1']), { sessionIds: ['a', 'b'], recentKeys: ['r1'] });
  assert.strictEqual(allRowKeys(out.data).length, 0);
  assert.strictEqual(out.checkedKeys.size, 0);
});

test('applyClaim tolerates a claim message with missing fields', async () => {
  const { applyClaim } = await load();
  const before = data({ windows: [win('w1', [sess('a')])] });
  const out = applyClaim(before, new Set(['a']), {}); // no sessionIds/recentKeys
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a']);
});

// --------------------------------------------------------------- formatTimeAgo

test('formatTimeAgo is singular at one and takes an injectable clock', async () => {
  const { formatTimeAgo } = await load();
  const now = 1_000_000_000;
  assert.strictEqual(formatTimeAgo(now - 5_000, now), 'just now');
  assert.strictEqual(formatTimeAgo(now - 60_000, now), '1 minute ago');
  assert.strictEqual(formatTimeAgo(now - 120_000, now), '2 minutes ago');
  assert.strictEqual(formatTimeAgo(now - 3600_000, now), '1 hour ago');
  assert.strictEqual(formatTimeAgo(now - 86400_000, now), '1 day ago');
  assert.strictEqual(formatTimeAgo(now - 3 * 86400_000, now), '3 days ago');
});

test('formatTimeAgo accepts a Date as well as a timestamp', async () => {
  const { formatTimeAgo } = await load();
  const now = 1_000_000_000;
  assert.strictEqual(formatTimeAgo(new Date(now - 120_000), now), '2 minutes ago');
});
