// Unit tests for the composed session merge (#688).
//
// test/unit/merge-worktree.test.js covers the merge decision tree underneath this, and
// must stay green and unmodified — that it does is the evidence this composed ON the
// primitive rather than overloading it. What this file covers is the four things #688
// added around it: where the commit subject comes from, when a commit happens at all,
// the non-worktree commit-and-push path, and when the GitHub issue gets closed.
//
// Both runners are injected, so there is no repo, no `gh` on PATH and no daemon here —
// the same discipline merge-worktree.js follows, and the reason the bare CI unit job
// (--ignore-scripts, no zsh, no gh) can run this.
const { test } = require('node:test');
const assert = require('node:assert');
const { mergeSession, deriveCommitSubject, issueNumberFromBranch } = require('../../mods/deepsteve-core/session-merge.js');

const WT = '/repo/.claude/worktrees/github-issue-688';
const ROOT = '/repo';

/**
 * A git runner scripted by argv prefix, recording every call. Matches the
 * merge-worktree.test.js shape so the two read alike.
 *
 * `table` entries are [prefix, result] and are matched in order, so a more specific
 * prefix must come first. Anything unscripted comes back ok, so a test only has to
 * describe the calls it cares about.
 */
function scriptedGit(table, calls = []) {
  return (args, cwd) => {
    const line = args.join(' ');
    calls.push({ args: line, cwd });
    for (const [prefix, res] of table) {
      if (line.startsWith(prefix)) return { ok: true, stdout: '', stderr: '', ...res };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
}

// `gh` scripted the same way. Default is a failure, so a test that forgets to script it
// exercises the fallback rather than silently inventing a title.
function scriptedGh(table, calls = []) {
  return async (argv, cwd) => {
    const line = argv.join(' ');
    calls.push({ argv: line, cwd });
    for (const [prefix, res] of table) {
      if (line.startsWith(prefix)) return res;
    }
    return { error: 'gh-unavailable' };
  };
}

/**
 * A fake git for a repo with two checkouts.
 *
 * `branch --show-current` and `status --porcelain` are the two commands whose answer
 * depends on WHICH checkout they run in — a prefix table cannot express that, and
 * conflating them is exactly how a "clean merge" fixture accidentally becomes a
 * `target-dirty` one — so they are answered per-cwd here and everything else falls
 * through to the scripted table.
 *
 * `sessionCwd` is the directory the session is in: WT for a worktree session, ROOT for
 * a main-checkout one. Its branch is `branch`; ROOT's is `mainBranch`.
 */
function gitFor({
  sessionCwd = WT,
  branch = 'worktree-github-issue-688',
  mainBranch = 'main',
  dirty = false,          // the session's own checkout
  rootDirty = false,      // the main checkout, i.e. the merge target
  table = [],
  calls = [],
} = {}) {
  const inner = scriptedGit(table, calls);
  return (args, cwd) => {
    const line = args.join(' ');
    if (line === 'branch --show-current') {
      calls.push({ args: line, cwd });
      return { ok: true, stdout: (cwd === sessionCwd ? branch : mainBranch) + '\n', stderr: '' };
    }
    if (line === 'status --porcelain') {
      calls.push({ args: line, cwd });
      const isDirty = cwd === sessionCwd ? dirty : rootDirty;
      return { ok: true, stdout: isDirty ? ' M a.txt\n' : '', stderr: '' };
    }
    return inner(args, cwd);
  };
}

// The merge itself succeeding, for the cases that are not about the merge.
const MERGE_OK = [['merge ', { stdout: 'Fast-forward\n' }]];

// ------------------------------------------------------------------ subject

test('an issue branch takes its subject from the live issue title', async () => {
  const subject = await deriveCommitSubject({
    gh: scriptedGh([['issue view 688', { stdout: 'Take the model out of the merge path\n' }]]),
    cwd: WT, branch: 'worktree-github-issue-688', target: 'main', issueNumber: 688,
  });
  assert.strictEqual(subject, 'Take the model out of the merge path (#688)');
});

test('a gh failure falls back to the merge form rather than an empty subject', async () => {
  const subject = await deriveCommitSubject({
    gh: scriptedGh([]),   // every call errors
    cwd: WT, branch: 'worktree-github-issue-688', target: 'main', issueNumber: 688,
  });
  assert.strictEqual(subject, 'Merge worktree-github-issue-688 into main');
});

test('a non-issue branch never consults gh at all', async () => {
  const ghCalls = [];
  const subject = await deriveCommitSubject({
    gh: scriptedGh([], ghCalls), cwd: WT, branch: 'spike/colors', target: 'main', issueNumber: null,
  });
  assert.strictEqual(subject, 'Merge spike/colors into main');
  assert.strictEqual(ghCalls.length, 0, 'no issue number means no network call');
});

test('with no target resolved the subject names only the branch', async () => {
  const subject = await deriveCommitSubject({
    gh: scriptedGh([]), cwd: WT, branch: 'spike/colors', target: '', issueNumber: null,
  });
  assert.strictEqual(subject, 'Merge spike/colors');
});

test('a title spanning lines is clipped to its first line', async () => {
  // `-q .title` cannot emit two lines, but a gh that printed a warning first would.
  const subject = await deriveCommitSubject({
    gh: scriptedGh([['issue view 1', { stdout: 'Real title\ntrailing noise\n' }]]),
    cwd: WT, branch: 'github-issue-1', target: 'main', issueNumber: 1,
  });
  assert.strictEqual(subject, 'Real title (#1)');
});

test('issueNumberFromBranch reads the number out of the branch, or null', () => {
  assert.strictEqual(issueNumberFromBranch('worktree-github-issue-688'), 688);
  assert.strictEqual(issueNumberFromBranch('github-issue-7'), 7);
  assert.strictEqual(issueNumberFromBranch('spike/colors'), null);
  assert.strictEqual(issueNumberFromBranch(''), null);
  assert.strictEqual(issueNumberFromBranch(null), null);
});

// ------------------------------------------------------------------- commit

test('a dirty worktree is committed, with the derived subject, before the merge', async () => {
  const calls = [];
  const git = gitFor({ dirty: true, table: MERGE_OK, calls });
  const gh = scriptedGh([['issue view 688', { stdout: 'Take the model out of the merge path\n' }]]);

  const r = await mergeSession({ git, gh, cwd: WT, repoRoot: ROOT, isWorktree: true });

  assert.strictEqual(r.status, 'merged', JSON.stringify(r));
  assert.strictEqual(r.committed, true);
  assert.strictEqual(r.subject, 'Take the model out of the merge path (#688)');
  const seq = calls.map(c => c.args);
  assert.ok(seq.includes('add -A'), seq.join(' | '));
  assert.ok(seq.includes('commit -m Take the model out of the merge path (#688)'), seq.join(' | '));
  // The commit must land BEFORE the merge, or the merge carries half the work.
  assert.ok(seq.indexOf('add -A') < seq.findIndex(s => s.startsWith('merge ')),
    'staged before merging');
});

test('an already-clean worktree is not committed, and costs no gh round trip', async () => {
  const calls = [];
  const ghCalls = [];
  const git = gitFor({ dirty: false, table: MERGE_OK, calls });

  const r = await mergeSession({ git, gh: scriptedGh([], ghCalls), cwd: WT, repoRoot: ROOT, isWorktree: true });

  assert.strictEqual(r.status, 'merged');
  assert.strictEqual(r.committed, false);
  const seq = calls.map(c => c.args);
  assert.ok(!seq.includes('add -A'), 'nothing to stage');
  assert.ok(!seq.some(s => s.startsWith('commit ')), 'and therefore nothing to commit');
  // An agent that committed its own work is the common Autopilot case, and a subject no
  // commit will carry is not worth a call to github.com. Null, not a derived string:
  // reporting one would claim a commit that was never written.
  assert.strictEqual(r.subject, null);
  assert.ok(!ghCalls.some(c => c.argv.startsWith('issue view')),
    'no commit means no subject to derive');
});

test('an explicit subject wins over the derived one, and skips the gh lookup', async () => {
  const ghCalls = [];
  const calls = [];
  const git = gitFor({ dirty: true, table: MERGE_OK, calls });
  const gh = scriptedGh([['issue view', { stdout: 'Derived title\n' }]], ghCalls);

  const r = await mergeSession({
    git, gh, cwd: WT, repoRoot: ROOT, isWorktree: true, subject: 'A better sentence',
  });

  assert.strictEqual(r.subject, 'A better sentence');
  assert.ok(calls.some(c => c.args === 'commit -m A better sentence'));
  assert.ok(!ghCalls.some(c => c.argv.startsWith('issue view')),
    'a supplied subject must not cost a network round trip');
});

test('a body is passed as a second -m', async () => {
  const calls = [];
  const git = gitFor({ dirty: true, table: MERGE_OK, calls });
  await mergeSession({
    git, gh: scriptedGh([]), cwd: WT, repoRoot: ROOT, isWorktree: true,
    subject: 'Subject', body: 'Why it is shaped this way.',
  });
  assert.ok(calls.some(c => c.args === 'commit -m Subject -m Why it is shaped this way.'),
    calls.map(c => c.args).join(' | '));
});

test('nothing to merge into means nothing is committed either', async () => {
  // skills/merge.md checked "target equals branch" at step 2 and auto-committed at step
  // 5, and that order matters: a commit written for a merge that then turns out not to
  // exist is a commit nobody asked for, on a branch nobody was merging.
  const calls = [];
  const ghCalls = [];
  const git = gitFor({ branch: 'main', dirty: true, calls });

  const r = await mergeSession({ git, gh: scriptedGh([], ghCalls), cwd: WT, repoRoot: ROOT, isWorktree: true });

  assert.strictEqual(r.status, 'same-branch');
  assert.strictEqual(r.committed, false);
  const seq = calls.map(c => c.args);
  assert.ok(!seq.includes('add -A'), 'nothing staged');
  assert.ok(!seq.some(s => s.startsWith('commit ')), 'and nothing committed');
  assert.strictEqual(ghCalls.length, 0, 'and no issue title fetched for a subject never used');
});

test('a failed commit stops before the merge', async () => {
  const calls = [];
  const git = gitFor({
    calls, dirty: true,
    table: [['commit ', { ok: false, stderr: 'nothing to commit, working tree clean\n' }]],
  });

  const r = await mergeSession({ git, gh: scriptedGh([]), cwd: WT, repoRoot: ROOT, isWorktree: true });

  assert.strictEqual(r.status, 'commit-failed');
  assert.strictEqual(r.committed, false);
  assert.match(r.output, /nothing to commit/);
  assert.ok(!calls.some(c => c.args.startsWith('merge ')), 'the merge must not have been attempted');
});

// -------------------------------------------------------- non-worktree path

test('a non-worktree session commits and pushes, and never merges', async () => {
  const calls = [];
  const git = gitFor({ sessionCwd: ROOT, branch: 'main', dirty: true, calls });

  const r = await mergeSession({ git, gh: scriptedGh([]), cwd: ROOT, repoRoot: ROOT, isWorktree: false });

  assert.strictEqual(r.status, 'pushed');
  assert.strictEqual(r.committed, true);
  const seq = calls.map(c => c.args);
  assert.ok(seq.includes('push'));
  assert.ok(!seq.some(s => s.startsWith('merge ')), 'nothing to merge into from the main checkout');
  assert.ok(!seq.includes('worktree list --porcelain'), 'and no target resolution either');
});

test('a non-worktree subject names no target unless one was asked for', async () => {
  const calls = [];
  const git = gitFor({ sessionCwd: ROOT, branch: 'main', dirty: true, calls });
  const r = await mergeSession({ git, gh: scriptedGh([]), cwd: ROOT, repoRoot: ROOT, isWorktree: false });
  // Not "Merge main into main", which is what resolving the detected target would give.
  assert.strictEqual(r.subject, 'Merge main');
});

test('a failed push is reported, and the commit still stands', async () => {
  const git = gitFor({
    sessionCwd: ROOT, branch: 'main', dirty: true,
    table: [['push', { ok: false, stderr: 'no upstream branch\n' }]],
  });
  const r = await mergeSession({ git, gh: scriptedGh([]), cwd: ROOT, repoRoot: ROOT, isWorktree: false });
  assert.strictEqual(r.status, 'push-failed');
  assert.strictEqual(r.committed, true);
  assert.match(r.output, /no upstream/);
});

test('a non-worktree session never closes an issue, even on an issue branch', async () => {
  const ghCalls = [];
  const git = gitFor({ sessionCwd: ROOT, branch: 'github-issue-688' });
  const r = await mergeSession({
    git, gh: scriptedGh([['issue view', { stdout: 'T\n' }]], ghCalls),
    cwd: ROOT, repoRoot: ROOT, isWorktree: false,
  });
  assert.strictEqual(r.status, 'pushed');
  assert.deepStrictEqual(r.issue, { number: 688, closed: false });
  assert.ok(!ghCalls.some(c => c.argv.startsWith('issue close')),
    'nothing has landed on a target, so the issue is not done');
});

// -------------------------------------------------------------- issue close

test('a merged issue branch closes its issue, with the target named in the comment', async () => {
  const ghCalls = [];
  const git = gitFor({ table: MERGE_OK });
  const gh = scriptedGh([
    ['issue view', { stdout: 'T\n' }],
    ['issue close', { stdout: '' }],
  ], ghCalls);

  const r = await mergeSession({ git, gh, cwd: WT, repoRoot: ROOT, isWorktree: true });

  assert.strictEqual(r.status, 'merged');
  assert.deepStrictEqual(r.issue, { number: 688, closed: true });
  const close = ghCalls.find(c => c.argv.startsWith('issue close'));
  assert.strictEqual(close.argv, 'issue close 688 --comment Merged into main.');
});

test('a gh that cannot close the issue does not downgrade a successful merge', async () => {
  const git = gitFor({ table: MERGE_OK });
  const gh = scriptedGh([['issue view', { stdout: 'T\n' }]]);   // close falls through to the error

  const r = await mergeSession({ git, gh, cwd: WT, repoRoot: ROOT, isWorktree: true });

  assert.strictEqual(r.status, 'merged', 'the merge really did happen');
  assert.strictEqual(r.issue.closed, false);
  assert.strictEqual(r.issue.number, 688);
  assert.ok(r.issue.error, 'and the reason is reported');
});

test('a non-issue branch has no issue to close', async () => {
  const ghCalls = [];
  const git = gitFor({ branch: 'spike/colors', table: MERGE_OK });
  const r = await mergeSession({
    git, gh: scriptedGh([], ghCalls), cwd: WT, repoRoot: ROOT, isWorktree: true,
  });
  assert.strictEqual(r.status, 'merged');
  assert.strictEqual(r.issue, null);
  assert.strictEqual(ghCalls.length, 0);
});

test('a refused merge closes nothing — the work is not in the target', async () => {
  const ghCalls = [];
  const git = gitFor({
    table: [
      ['merge ', { ok: false, stderr: 'CONFLICT (content): Merge conflict in a.txt\n' }],
      ['rev-parse --verify MERGE_HEAD', { stdout: 'abc\n' }],
    ],
  });
  const r = await mergeSession({
    git, gh: scriptedGh([['issue view', { stdout: 'T\n' }]], ghCalls),
    cwd: WT, repoRoot: ROOT, isWorktree: true,
  });
  assert.strictEqual(r.status, 'conflict');
  assert.deepStrictEqual(r.issue, { number: 688, closed: false });
  assert.ok(!ghCalls.some(c => c.argv.startsWith('issue close')));
});

// ------------------------------------------------------- status passthrough

test('every mergeWorktree status passes through with its own shape intact', async () => {
  // The skill and the UI both branch on these, so the composition must not rename,
  // reshape or swallow any of them.
  const run = (git) => mergeSession({ git, gh: scriptedGh([]), cwd: WT, repoRoot: ROOT, isWorktree: true });

  // same-branch: the worktree is already on the branch the main checkout has.
  {
    const r = await run(gitFor({ branch: 'main' }));
    assert.strictEqual(r.status, 'same-branch');
    assert.match(r.message, /nothing to merge/);
  }

  // target-dirty: the MAIN checkout has uncommitted changes; the worktree does not.
  {
    const r = await run(gitFor({ rootDirty: true }));
    assert.strictEqual(r.status, 'target-dirty');
    assert.strictEqual(r.mergeDir, ROOT);
    assert.deepStrictEqual(r.changes, [' M a.txt']);
    assert.strictEqual(r.committed, false, 'the worktree was clean, so nothing was committed');
  }

  // no-such-branch vs target-not-checked-out, both reached through an explicit target
  // that no worktree holds.
  {
    const noBranch = gitFor({ table: [['rev-parse --verify release', { ok: false }]] });
    const r = await mergeSession({
      git: noBranch, gh: scriptedGh([]), cwd: WT, repoRoot: ROOT, isWorktree: true, target: 'release',
    });
    assert.strictEqual(r.status, 'no-such-branch');
    assert.strictEqual(r.target, 'release');

    const exists = gitFor({ table: [['rev-parse --verify release', { stdout: 'abc\n' }]] });
    const r2 = await mergeSession({
      git: exists, gh: scriptedGh([]), cwd: WT, repoRoot: ROOT, isWorktree: true, target: 'release',
    });
    assert.strictEqual(r2.status, 'target-not-checked-out');
    assert.strictEqual(r2.repoRoot, ROOT);
  }

  // failed: the merge ran and lost, but left no MERGE_HEAD, so it must NOT be aborted.
  {
    const calls = [];
    const git = gitFor({ calls, table: [
      ['merge ', { ok: false, stderr: 'fatal: refusing to merge unrelated histories\n' }],
      ['rev-parse --verify MERGE_HEAD', { ok: false }],
    ] });
    const r = await run(git);
    assert.strictEqual(r.status, 'failed');
    assert.ok(!calls.some(c => c.args === 'merge --abort'), 'nothing to abort');
  }

  // detached: no branch in the worktree at all.
  {
    const r = await run(() => ({ ok: true, stdout: '\n', stderr: '' }));
    assert.strictEqual(r.status, 'detached');
  }

  // error: git itself could not answer.
  {
    const r = await run(() => ({ ok: false, stdout: '', stderr: 'not a git repository' }));
    assert.strictEqual(r.status, 'error');
    assert.match(r.message, /Could not read the current branch/);
  }
});

test('an explicit target is honoured and named in the fallback subject', async () => {
  const calls = [];
  const git = (args, cwd) => {
    const line = args.join(' ');
    calls.push({ args: line, cwd });
    if (line === 'branch --show-current') {
      return { ok: true, stdout: (cwd === WT ? 'spike/colors' : 'main') + '\n', stderr: '' };
    }
    if (line === 'status --porcelain') return { ok: true, stdout: cwd === WT ? ' M a.txt\n' : '', stderr: '' };
    if (line === 'worktree list --porcelain') {
      return { ok: true, stdout: `worktree /repo/.claude/worktrees/rel\nbranch refs/heads/release\n`, stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };

  const r = await mergeSession({
    git, gh: scriptedGh([]), cwd: WT, repoRoot: ROOT, isWorktree: true, target: 'release',
  });

  assert.strictEqual(r.status, 'merged');
  assert.strictEqual(r.target, 'release');
  assert.strictEqual(r.mergeDir, '/repo/.claude/worktrees/rel');
  assert.strictEqual(r.subject, 'Merge spike/colors into release',
    'the subject names the branch actually merged into, not the main checkout\'s');
});
