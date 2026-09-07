// Unit test for mods/workshop/contention.js — the "who is being a hog" answer.
//
// Why this is worth a test of its own: the whole value of the feature is that the daemon
// answers instead of the agent guessing, so a WRONG answer is worse than none. Naming
// three innocent sessions as the thing blocking a merge sends a human to three tabs to
// find nothing, and after that they stop reading the row.
//
// The module takes no ctx, no fs and no git — the caller supplies the session list — so
// every rule here runs with no daemon and no repo, which is what the bare `unit` CI job
// has.
//
// Run: node --test test/unit/workshop-contention.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const contention = require('../../mods/workshop/contention.js');

const ROOT = '/Users/x/github/deepsteve';

const session = (id, cwd, over = {}) => ({ id, name: id, cwd, worktree: null, ...over });

// ── which merge statuses mean "stuck" ────────────────────────────────────────

test('only merged and pushed are not blocked', () => {
  assert.strictEqual(contention.isMergeBlocked('merged'), false);
  assert.strictEqual(contention.isMergeBlocked('pushed'), false);
  for (const s of ['target-dirty', 'conflict', 'failed', 'commit-failed', 'detached',
    'same-branch', 'no-such-branch', 'target-not-checked-out', 'error']) {
    assert.strictEqual(contention.isMergeBlocked(s), true, `${s} left the target untouched`);
  }
});

test('an absent status is not a block', () => {
  // A session that has never been merged from must not grow a stuck row out of nothing.
  assert.strictEqual(contention.isMergeBlocked(undefined), false);
  assert.strictEqual(contention.isMergeBlocked(null), false);
  assert.strictEqual(contention.isMergeBlocked(''), false);
});

test('an unknown status degrades to a truthful line rather than undefined', () => {
  // mergeWorktree is free to grow a status. A panel rendering "undefined" for one is
  // worse than a panel naming it.
  const d = contention.describeMerge('some-new-status');
  assert.ok(d.label.includes('some-new-status'));
  assert.strictEqual(d.holders, false, 'we cannot claim to know who holds an unknown case');
});

test('holders are named only for the statuses that are ABOUT the target checkout', () => {
  // The discriminator that keeps the answer trustworthy. A conflict is not somebody
  // hogging anything, and listing the sessions working in the checkout next to one would
  // be a confident accusation about the wrong thing.
  assert.strictEqual(contention.describeMerge('target-dirty').holders, true);
  assert.strictEqual(contention.describeMerge('target-not-checked-out').holders, true);
  for (const s of ['conflict', 'failed', 'commit-failed', 'detached', 'same-branch']) {
    assert.strictEqual(contention.describeMerge(s).holders, false, `${s} names nobody`);
  }
});

// ── who is holding the checkout ──────────────────────────────────────────────

test('a session sitting IN the shared checkout is a holder', () => {
  const holders = contention.holdersOf(ROOT, [session('a', ROOT)]);
  assert.deepStrictEqual(holders, [{ sessionId: 'a', sessionName: 'a' }]);
});

test('a worktree session is never a holder, however its cwd is spelled', () => {
  // The rule that makes the answer correct: a worktree agent works in its own directory
  // and cannot dirty the shared checkout, so the population that CAN is exactly the
  // sessions whose cwd is the checkout itself.
  const holders = contention.holdersOf(ROOT, [
    session('wt', `${ROOT}/.claude/worktrees/github-issue-691`, { worktree: 'github-issue-691' }),
    session('other', '/Users/x/github/somethingelse'),
  ]);
  assert.deepStrictEqual(holders, []);
});

test('the asking session is never its own hog', () => {
  // A non-worktree session merging from the checkout it is standing in would otherwise
  // be told that it is what is blocking itself.
  const holders = contention.holdersOf(ROOT, [session('me', ROOT), session('you', ROOT)], 'me');
  assert.deepStrictEqual(holders.map((h) => h.sessionId), ['you']);
});

test('a trailing slash is the same directory', () => {
  assert.deepStrictEqual(
    contention.holdersOf(`${ROOT}/`, [session('a', ROOT)]).map((h) => h.sessionId),
    ['a'],
    'two spellings of one path must not read as two different repos',
  );
});

test('an empty target names nobody rather than everybody', () => {
  // The failure that matters: a falsy root matching every session's falsy cwd would
  // accuse the entire machine.
  assert.deepStrictEqual(contention.holdersOf('', [session('a', ''), session('b', ROOT)]), []);
  assert.deepStrictEqual(contention.holdersOf(null, [session('a', ROOT)]), []);
});

test('junk in the session list is skipped, not thrown on', () => {
  const holders = contention.holdersOf(ROOT, [null, {}, { id: '', cwd: ROOT }, session('a', ROOT)]);
  assert.deepStrictEqual(holders.map((h) => h.sessionId), ['a']);
});

// ── the sentence both surfaces read ──────────────────────────────────────────

test('no holders says so plainly instead of implying we do not know', () => {
  // A real and common state: the user's own editor dirtied the checkout, and no session
  // accounts for it. "Nobody here did it" is the answer; silence would read as a bug.
  const s = contention.holderSentence([], 'deepsteve');
  assert.ok(/No agent session is working in deepsteve/.test(s), s);
});

test('one holder reads as a singular sentence, several as a list', () => {
  const one = contention.holderSentence([{ sessionId: 'a', sessionName: 'rail tab' }], 'deepsteve');
  assert.ok(one.includes('"rail tab" is working in deepsteve'), one);

  const many = contention.holderSentence([
    { sessionId: 'a', sessionName: 'rail tab' },
    { sessionId: 'b', sessionName: 'remote step 1' },
    { sessionId: 'c', sessionName: 'cron fix' },
  ], 'deepsteve');
  assert.ok(many.includes('"rail tab", "remote step 1" and "cron fix" are working'), many);
});

test('a nameless session falls back to its id rather than to an empty quote', () => {
  const s = contention.holderSentence([{ sessionId: 'sess7', sessionName: null }], '');
  assert.ok(s.includes('"sess7"'), s);
});
