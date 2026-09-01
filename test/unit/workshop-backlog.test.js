// Unit test for mods/workshop/backlog.js — the Workshop backlog's rules (#671).
//
// Why this file exists: every claim the Backlog makes is a claim about someone else's
// work. "#664 already has a tab" sends you somewhere else; "nothing is on this" is the
// signal you act on when you sit down to start. A wrong match is worse than no match at
// all, and none of the ways it goes wrong are visible in a screenshot — a session
// matched from a neighbouring repo looks exactly like a correct one.
//
// The module takes sessions as a plain array and `gh` as an injected fetcher, so
// everything here runs with no daemon, no subprocess and no `gh` on PATH. That last one
// is not optional: the bare `unit` CI job installs with --ignore-scripts on a runner
// that has no GitHub CLI, so a test that shells out would be red there and green here.
//
// Run: node --test test/unit/workshop-backlog.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const backlog = require('../../mods/workshop/backlog.js');
const { issueWorktreeName } = require('../../issue-prompt.js');

// Captured verbatim from `gh issue list --json number,title,labels,url,updatedAt` on
// this repo — the point of a real fixture is the label OBJECTS, which are easy to
// mis-remember as plain strings.
const GH_ISSUES = JSON.stringify([
  {
    labels: [],
    number: 671,
    title: "Workshop: show a project's open issues for a chosen label, matched to open tabs",
    updatedAt: '2026-08-31T14:27:00Z',
    url: 'https://github.com/deepsteve/deepsteve/issues/671',
  },
  {
    labels: [{ id: 'LA_kwD', name: 'enhancement', description: 'New feature or request', color: 'a2eeef' }],
    number: 670,
    title: 'A chat pane in Workshop, so reviewing a result is a conversation',
    updatedAt: '2026-08-31T14:26:45Z',
    url: 'https://github.com/deepsteve/deepsteve/issues/670',
  },
]);

const PROJECT = '/Users/x/repo';
const session = (over = {}) => ({
  id: 'a1', name: null, worktree: null, project: PROJECT, ...over,
});

// ── the gh argv ──────────────────────────────────────────────────────────────
//
// Built here rather than in the route so it can be asserted with no subprocess. Both
// halves are silent when wrong: a stray `--label=` matches nothing and looks exactly
// like an empty backlog, and a missing `--limit` truncates at gh's default of 30 and
// looks exactly like "that is all there is".

test('a label rides as ONE token, so a leading dash is not read as a flag', () => {
  const argv = backlog.issueListArgs('-weird');
  assert.deepStrictEqual(argv.slice(0, 3), ['issue', 'list', '--label=-weird']);
  assert.strictEqual(argv.filter((a) => a.startsWith('--label')).length, 1);
});

test('no label omits --label entirely — the unfiltered backlog (#679)', () => {
  for (const empty of ['', undefined, null]) {
    const argv = backlog.issueListArgs(empty);
    assert.ok(!argv.some((a) => a.startsWith('--label')),
      `${JSON.stringify(empty)} produced a --label argument`);
    // Not merely absent as a flag: no empty argument left behind either, which gh would
    // read as a positional and reject.
    assert.ok(!argv.includes(''), 'left a stray empty argument in the argv');
    assert.deepStrictEqual(argv.slice(0, 2), ['issue', 'list']);
  }
});

test('both forms keep --state open, --json and an explicit --limit', () => {
  for (const argv of [backlog.issueListArgs('bug'), backlog.issueListArgs('')]) {
    assert.strictEqual(argv[argv.indexOf('--state') + 1], 'open');
    assert.strictEqual(argv[argv.indexOf('--json') + 1], 'number,title,labels,url,updatedAt');
    assert.strictEqual(argv[argv.indexOf('--limit') + 1], String(backlog.MAX_ISSUES));
  }
});

// ── parsing ──────────────────────────────────────────────────────────────────

test('a real gh payload becomes rows, with labels flattened to names', () => {
  const rows = backlog.parseIssues(GH_ISSUES);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].number, 671);
  assert.deepStrictEqual(rows[0].labels, []);
  assert.deepStrictEqual(rows[1].labels, ['enhancement']);
  assert.strictEqual(rows[1].url, 'https://github.com/deepsteve/deepsteve/issues/670');
  // ISO in, ms out — the panel does arithmetic on this every second.
  assert.strictEqual(rows[1].updatedAt, Date.parse('2026-08-31T14:26:45Z'));
});

test('an empty list is a valid answer, not a failure', () => {
  // gh exits 0 with `[]` both when a label has no open issues AND when the label does
  // not exist. The two are byte-identical, so nothing downstream may treat [] as an error.
  assert.deepStrictEqual(backlog.parseIssues('[]'), []);
});

test('junk gh output degrades to an empty list rather than throwing', () => {
  // A 15s timeout truncates stdout mid-JSON. Throwing here would surface as a 500 on a
  // route the panel polls in the background, i.e. a red bar over a working inbox.
  for (const junk of ['', null, undefined, 'not json', '[{"number":1,', '{"issues":[]}', '"a string"']) {
    assert.deepStrictEqual(backlog.parseIssues(junk), [], `threw or mis-parsed on ${JSON.stringify(junk)}`);
  }
});

test('rows without a usable number are dropped', () => {
  const rows = backlog.parseIssues(JSON.stringify([
    { number: 5, title: 'ok' }, { number: 0 }, { number: 'x' }, null, 'nope', { title: 'no number' },
  ]));
  assert.deepStrictEqual(rows.map((r) => r.number), [5]);
});

test('parseLabels keeps name and colour and drops the rest', () => {
  const labels = backlog.parseLabels(JSON.stringify([
    { id: 'LA_1', name: 'bug', description: "Something isn't working", color: 'd73a4a' },
    { name: '  ' },
    { name: 'mods', color: '#b3b4b4' },
  ]));
  assert.deepStrictEqual(labels, [{ name: 'bug', color: 'd73a4a' }, { name: 'mods', color: 'b3b4b4' }]);
});

// ── the match rule ───────────────────────────────────────────────────────────

test('the worktree tier is bound to the name startIssueSession actually mints', () => {
  // The producer is issue-prompt.js; this module has to recognise its output. Binding
  // the two here is what stops the convention drifting on one side only — the same
  // coupling skills/merge.md relies on when it recovers a number from a branch.
  assert.strictEqual(backlog.worktreeIssueNumber(issueWorktreeName(671)), 671);
  assert.strictEqual(backlog.worktreeIssueNumber('worktree-github-issue-671'), null);
  assert.strictEqual(backlog.worktreeIssueNumber('github-issue-671-b6'), null);
  assert.strictEqual(backlog.worktreeIssueNumber(null), null);
  // #689's "Start fresh": a second worktree for an issue that already had one. It is
  // still that issue's work, so it stays in this immutable-worktree tier rather than
  // dropping to the mutable-tab-name one. The `-b6` case above is the boundary — a
  // NON-numeric suffix is somebody's own branch, not a name this daemon minted.
  assert.strictEqual(backlog.worktreeIssueNumber('github-issue-671-2'), 671);
  assert.strictEqual(backlog.worktreeIssueNumber('github-issue-671-13'), 671);
});

test('a renamed tab still matches, because the worktree is what carries the number', () => {
  // The case this whole tier exists for. A tab's name is MUTABLE — the ws
  // `{type:'rename'}` handler in server.js assigns `entry.name` outright, and an agent
  // can rename its own tab to whatever describes the work. `entry.worktree` is minted
  // once by startIssueSession and never written again, which is the only reason the
  // number survives a rename.
  const [row] = backlog.matchSessions(
    [{ number: 666 }],
    [session({ id: 'z9', name: 'timecard-presence-tracking', worktree: 'github-issue-666' })],
    PROJECT,
  );
  assert.deepStrictEqual(row.matched, [{ sessionId: 'z9', sessionName: 'timecard-presence-tracking', matchedBy: 'worktree' }]);
  assert.strictEqual(row.sessionId, 'z9');
});

test('a tab name is the weaker tier, used when there is no worktree', () => {
  // usableWorktree() drops the worktree for a repo with no commits (#656), so the
  // session spawns with worktree: null and the name is the only signal left.
  const [row] = backlog.matchSessions(
    [{ number: 671 }],
    [session({ id: 'b2', name: '#671 Workshop: show a project…', worktree: null })],
    PROJECT,
  );
  assert.deepStrictEqual(row.matched.map((m) => m.matchedBy), ['title']);
});

test('the worktree tier wins over the title tier', () => {
  const [row] = backlog.matchSessions(
    [{ number: 671 }],
    [
      session({ id: 'byname', name: '#671 something', worktree: null }),
      session({ id: 'exact', name: 'renamed', worktree: 'github-issue-671' }),
    ],
    PROJECT,
  );
  assert.strictEqual(row.sessionId, 'exact', 'the exact match must be the one the row points at');
  assert.deepStrictEqual(row.matched.map((m) => m.matchedBy), ['worktree', 'title']);
});

test('a session matching both ways is reported once, as the exact match it is', () => {
  const [row] = backlog.matchSessions(
    [{ number: 671 }],
    [session({ id: 'both', name: '#671 Workshop', worktree: 'github-issue-671' })],
    PROJECT,
  );
  assert.strictEqual(row.matched.length, 1);
  assert.strictEqual(row.matched[0].matchedBy, 'worktree');
});

test('#671 does not match #6710, and #67 does not match #671', () => {
  // Every repo numbers from 1, so short numbers are common and prefix collisions are
  // the default failure of a naive substring search.
  const rows = backlog.matchSessions(
    [{ number: 67 }, { number: 671 }, { number: 6710 }],
    [session({ id: 's', name: '#6710 the long one' })],
    PROJECT,
  );
  assert.deepStrictEqual(rows.map((r) => r.matched.length), [0, 0, 1]);
});

test('a #N in the middle of a word is not a claim', () => {
  const [row] = backlog.matchSessions(
    [{ number: 12 }],
    [session({ id: 's', name: 'abc#12 def' })],
    PROJECT,
  );
  assert.strictEqual(row.matched.length, 0, 'only a #N at a word boundary counts');
});

test('a session in ANOTHER project never matches', () => {
  // The gate is part of the rule, not a nicety: every checkout numbers its issues from
  // 1, so on a machine with two repos open a `github-issue-12` tab in one would
  // otherwise mark issue #12 in the other as in-progress.
  const [row] = backlog.matchSessions(
    [{ number: 12 }],
    [session({ id: 'elsewhere', worktree: 'github-issue-12', project: '/some/other/repo' })],
    PROJECT,
  );
  assert.deepStrictEqual(row.matched, []);
  assert.strictEqual(row.sessionId, null);
});

test('two tabs on one issue are both kept', () => {
  // Dropping the second would make "Show tab" silently pick one of two without saying
  // there was a choice.
  const [row] = backlog.matchSessions(
    [{ number: 9 }],
    [
      session({ id: 'first', worktree: 'github-issue-9' }),
      session({ id: 'second', worktree: 'github-issue-9' }),
    ],
    PROJECT,
  );
  assert.deepStrictEqual(row.matched.map((m) => m.sessionId), ['first', 'second']);
});

test('an unmatched issue carries a null sessionId, which is what makes it skippable', () => {
  // The panel's visit() returns false without a sessionId, and that is the whole reason
  // the ⌘↑/⌘↓ excursion walk steps over issues nobody has started.
  const [row] = backlog.matchSessions([{ number: 1 }], [], PROJECT);
  assert.strictEqual(row.sessionId, null);
  assert.strictEqual(row.sessionName, null);
  assert.deepStrictEqual(row.matched, []);
});

test('row ids are namespaced so they cannot collide with an inbox id', () => {
  const [row] = backlog.matchSessions([{ number: 671 }], [], PROJECT);
  assert.strictEqual(row.id, 'issue:671');
  assert.strictEqual(row.kind, 'issue');
  // `blocked:<sessionId>` and stored `w<n>` tickets are the two id shapes already in
  // the inbox; one cursor walks all three, so a collision would select two rows at once.
  assert.ok(!row.id.startsWith('blocked:') && !/^w\d/.test(row.id));
});

test('junk sessions are ignored rather than crashing the listing', () => {
  const [row] = backlog.matchSessions([{ number: 1 }], [null, undefined, {}, { name: '#1 no id' }], PROJECT);
  assert.deepStrictEqual(row.matched, []);
});

// ── the cache ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

test('a hit inside the TTL does not re-run the fetcher', async () => {
  const cache = backlog.createCache({ ttlMs: 1000 });
  let runs = 0;
  const fetcher = async () => { runs++; return { issues: [1] }; };

  await cache.get('k', fetcher, { now: NOW });
  const second = await cache.get('k', fetcher, { now: NOW + 999 });
  assert.strictEqual(runs, 1);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.ageMs, 999);
});

test('past the TTL it fetches again', async () => {
  const cache = backlog.createCache({ ttlMs: 1000 });
  let runs = 0;
  const fetcher = async () => { runs++; return { issues: [] }; };

  await cache.get('k', fetcher, { now: NOW });
  await cache.get('k', fetcher, { now: NOW + 1001 });
  assert.strictEqual(runs, 2);
});

test('a failure is cached, but on a much shorter clock', async () => {
  // Both halves matter. Not caching it means a repo with no GitHub remote spawns `gh`
  // on every poll of every window, forever. Caching it for the full two minutes means
  // `gh auth login` appears not to have worked.
  const cache = backlog.createCache({ ttlMs: 100_000, errorTtlMs: 1000 });
  let runs = 0;
  const fetcher = async () => { runs++; return { error: 'gh-failed', issues: [] }; };

  await cache.get('k', fetcher, { now: NOW });
  await cache.get('k', fetcher, { now: NOW + 999 });
  assert.strictEqual(runs, 1, 'still inside the error window');
  await cache.get('k', fetcher, { now: NOW + 1001 });
  assert.strictEqual(runs, 2, 'the error window is shorter than the success window');
});

test('two concurrent requests share one gh spawn', async () => {
  // Two browser windows poll independently and a fullscreen mod refetches on every
  // mount, so "the same key, twice, at once" is the ordinary case rather than a race.
  const cache = backlog.createCache({ ttlMs: 1000 });
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetcher = async () => { runs++; await gate; return { issues: ['x'] }; };

  const a = cache.get('k', fetcher, { now: NOW });
  const b = cache.get('k', fetcher, { now: NOW });
  release();
  const [ra, rb] = await Promise.all([a, b]);

  assert.strictEqual(runs, 1, 'the second caller must await the first promise, not spawn its own');
  assert.deepStrictEqual(ra.issues, ['x']);
  assert.deepStrictEqual(rb.issues, ['x']);
});

test('a caller may ask for fresher data than the TTL, but never staler', async () => {
  // This is how the panel's own backlogPollSeconds is honoured without letting it
  // out-run the cache: maxAgeMs can shorten the window, and the route clamps it.
  const cache = backlog.createCache({ ttlMs: 100_000 });
  let runs = 0;
  const fetcher = async () => { runs++; return { issues: [] }; };

  await cache.get('k', fetcher, { now: NOW });
  await cache.get('k', fetcher, { now: NOW + 5000, maxAgeMs: 1000 });
  assert.strictEqual(runs, 2, 'a shorter maxAgeMs must force a refetch');
});

test('different projects and labels are different entries', async () => {
  const cache = backlog.createCache({ ttlMs: 100_000 });
  let runs = 0;
  const fetcher = async () => { runs++; return { issues: [] }; };

  await cache.get('/a\0bug', fetcher, { now: NOW });
  await cache.get('/a\0enhancement', fetcher, { now: NOW });
  await cache.get('/b\0bug', fetcher, { now: NOW });
  assert.strictEqual(runs, 3);
  assert.strictEqual(cache.size(), 3);
});

test('the cache clears wholesale at its cap rather than growing without bound', async () => {
  const cache = backlog.createCache({ ttlMs: 100_000, max: 3 });
  const fetcher = async () => ({ issues: [] });
  for (const k of ['a', 'b', 'c']) await cache.get(k, fetcher, { now: NOW });
  assert.strictEqual(cache.size(), 3);
  await cache.get('d', fetcher, { now: NOW });
  assert.strictEqual(cache.size(), 1, 'the projectCache rule: clear, do not maintain an LRU');
});
