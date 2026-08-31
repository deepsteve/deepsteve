// Unit test for mods/workshop/backlog-view.js — the Backlog's view rules (#671).
//
// Two behaviours, both of the "wrong in a way you notice a week later" kind that
// inbox-view.js's suite exists for:
//
//   compareIssues — the list is refetched under a live cursor. GitHub hands out the same
//   `updatedAt` to issues touched in the same minute often enough that a non-total order
//   swaps rows on a refresh, and the cursor appears to move on its own.
//
//   formatUpdated — must NOT be inbox-view's formatAge, which returns '0s' for anything
//   non-finite. A missing updatedAt would then read "just updated", which is a lie in the
//   one direction that matters: it makes stale work look live.
//
// Browser ES module, driven with `await import()` from CommonJS — the
// workshop-inbox-view.test.js pattern. No DOM stubs, so it survives the bare `unit` job.
//
// Run: node --test test/unit/workshop-backlog-view.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let view;
async function load() {
  if (!view) view = await import('../../mods/workshop/backlog-view.js');
  return view;
}

const NOW = 1_700_000_000_000;
const issue = (over = {}) => ({
  id: `issue:${over.number || 1}`, kind: 'issue', number: 1,
  title: 'A thing', url: 'https://example.invalid/1', labels: [],
  updatedAt: NOW, matched: [], sessionId: null, sessionName: null, ...over,
});

// ── order ────────────────────────────────────────────────────────────────────

test('freshest first', async () => {
  const { sortIssues } = await load();
  const out = sortIssues([
    issue({ number: 1, updatedAt: NOW - 5000 }),
    issue({ number: 2, updatedAt: NOW }),
  ]);
  assert.deepStrictEqual(out.map((i) => i.number), [2, 1]);
});

test('the order is TOTAL — two issues touched at the same moment still order', async () => {
  const { compareIssues } = await load();
  const a = issue({ number: 10, updatedAt: NOW });
  const b = issue({ number: 20, updatedAt: NOW });
  assert.ok(compareIssues(a, b) > 0, 'the higher number sorts first');
  assert.ok(compareIssues(b, a) < 0, 'and the comparison is antisymmetric');
  assert.strictEqual(compareIssues(a, a), 0);
});

test('a missing updatedAt sinks to the bottom instead of floating to the top', async () => {
  const { sortIssues } = await load();
  const out = sortIssues([issue({ number: 1, updatedAt: 0 }), issue({ number: 2, updatedAt: NOW })]);
  assert.deepStrictEqual(out.map((i) => i.number), [2, 1]);
});

test('sortIssues survives junk without throwing', async () => {
  const { sortIssues } = await load();
  assert.deepStrictEqual(sortIssues(null), []);
  assert.deepStrictEqual(sortIssues(undefined), []);
  assert.strictEqual(sortIssues([null, issue(), undefined]).length, 1);
});

test('sortIssues does not mutate its input', async () => {
  const { sortIssues } = await load();
  const input = [issue({ number: 1, updatedAt: NOW - 1 }), issue({ number: 2, updatedAt: NOW })];
  sortIssues(input);
  assert.deepStrictEqual(input.map((i) => i.number), [1, 2], 'the caller keeps its array');
});

// ── collapse ─────────────────────────────────────────────────────────────────

test('a collapsed backlog contributes no ids to the cursor', async () => {
  const { visibleBacklog } = await load();
  const issues = [issue({ number: 1 }), issue({ number: 2 })];

  const open = visibleBacklog(issues, { collapsed: false });
  assert.deepStrictEqual(open.order, ['issue:2', 'issue:1']);

  const shut = visibleBacklog(issues, { collapsed: true });
  assert.deepStrictEqual(shut.order, [], 'arrows must not walk into rows nobody can see');
  assert.strictEqual(shut.list.length, 2, 'the list itself is still available for the count');
});

test('order matches list exactly when open — that is what makes arrows track the DOM', async () => {
  const { visibleBacklog } = await load();
  const { list, order } = visibleBacklog([
    issue({ number: 3, updatedAt: NOW - 2 }),
    issue({ number: 9, updatedAt: NOW }),
  ], {});
  assert.deepStrictEqual(order, list.map((i) => i.id));
});

// ── the clock ────────────────────────────────────────────────────────────────

test('formatUpdated is coarse, and never claims freshness it cannot prove', async () => {
  const { formatUpdated } = await load();
  assert.strictEqual(formatUpdated(NOW, NOW), 'just now');
  assert.strictEqual(formatUpdated(NOW - 89_000, NOW), 'just now');
  assert.strictEqual(formatUpdated(NOW - 4 * 60_000, NOW), '4m');
  assert.strictEqual(formatUpdated(NOW - 3 * 3600_000, NOW), '3h');
  assert.strictEqual(formatUpdated(NOW - 2 * 86_400_000, NOW), '2d');
  assert.strictEqual(formatUpdated(NOW - 30 * 86_400_000, NOW), '4w');
});

test('an unparseable timestamp renders as nothing, not as "0s"', async () => {
  // The formatAge trap: it returns '0s' for NaN, which on a backlog row would read as
  // "touched a moment ago" — exactly backwards.
  const { formatUpdated } = await load();
  for (const bad of [0, NaN, null, undefined, 'nonsense', -1]) {
    assert.strictEqual(formatUpdated(bad, NOW), '', `${JSON.stringify(bad)} must render blank`);
  }
});

test('a clock skew into the future reads as "just now", never as a negative age', async () => {
  const { formatUpdated } = await load();
  assert.strictEqual(formatUpdated(NOW + 60_000, NOW), 'just now');
});

// ── the match note ───────────────────────────────────────────────────────────

test('no match means NO note — the useful default is shown by absence', async () => {
  // A row that spells out "no tab yet" for every unstarted issue turns the state this
  // whole view exists to surface into noise on every row.
  const { matchNote } = await load();
  assert.strictEqual(matchNote(issue()), null);
  assert.strictEqual(matchNote(null), null);
});

test('the note names the session, and says whether the match was exact', async () => {
  const { matchNote } = await load();
  const exact = matchNote(issue({
    matched: [{ sessionId: 'a1', sessionName: 'timecard-presence', matchedBy: 'worktree' }],
  }));
  assert.deepStrictEqual(exact, { text: 'timecard-presence', exact: true });

  const weak = matchNote(issue({
    matched: [{ sessionId: 'b2', sessionName: '#671 Workshop', matchedBy: 'title' }],
  }));
  assert.strictEqual(weak.exact, false, 'a name match must not claim to be exact');
});

test('extra matches are counted, not hidden', async () => {
  const { matchNote } = await load();
  const note = matchNote(issue({
    matched: [
      { sessionId: 'a', sessionName: 'one', matchedBy: 'worktree' },
      { sessionId: 'b', sessionName: 'two', matchedBy: 'worktree' },
    ],
  }));
  assert.strictEqual(note.text, 'one +1', 'the row must not imply there is only one tab');
});

test('a nameless session falls back to its id rather than rendering blank', async () => {
  const { matchNote } = await load();
  const note = matchNote(issue({ matched: [{ sessionId: 'c3', sessionName: null, matchedBy: 'worktree' }] }));
  assert.strictEqual(note.text, 'c3');
});
