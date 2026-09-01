// Guard for worktree-status.js (#689).
//
// The bug: starting an issue that already had a worktree was a silent re-entry.
// ensureWorktree() returns an existing `.claude/worktrees/github-issue-<N>` without a
// word, so the agent landed on a branch carrying somebody else's commits believing it
// was the first one there — and under Autopilot it would merge and close the issue on
// the strength of them.
//
// These tests build REAL git repos, the same argument worktree-support.test.js opens
// with: this module's whole job is to read git's on-disk layout — the `.git` link file,
// the per-worktree admin directory, `for-each-ref`'s output — so a stubbed fs would
// assert only what we already believed about a format we do not own. The injected-git
// tests at the bottom cover what a real repo cannot produce on demand: git missing, and
// the exact argv we spend.
//
// Run: node --test test/unit/worktree-status.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
  worktreePath, worktreeExists, readWorktreeFacts, worktreeStatuses, worktreeStatus,
  freshWorktreeName, validateBranch,
} = require('../../worktree-status.js');

// realpath'd for the same reason git-root.test.js does it: macOS /tmp is a symlink and
// the paths under test are compared verbatim.
function scratch(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const git = (dir, ...argv) => execFileSync('git', argv, { cwd: dir, stdio: 'ignore' });

function initRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

// `git worktree add <path>` names the branch after the directory — this is the shape
// ensureWorktree() creates, for agents without a native --worktree flag.
function addWorktree(repo, name, { branch } = {}) {
  const p = worktreePath(repo, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (branch) git(repo, 'worktree', 'add', '-b', branch, p);
  else git(repo, 'worktree', 'add', p);
  return p;
}

function commitIn(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', `add ${file}`);
}

// ------------------------------------------------------------------- existence

test('a missing worktree is absent, not an empty status', () => {
  // "No worktree" and "a worktree we could not read" must not look alike: the first
  // means start clean, the second means say nothing rather than guess.
  const repo = initRepo(scratch('ds-ws-none-'));
  assert.strictEqual(worktreeExists(repo, 'github-issue-1'), false);
  assert.strictEqual(readWorktreeFacts(repo, 'github-issue-1'), null);
  assert.strictEqual(worktreeStatus({ repoRoot: repo, name: 'github-issue-1' }), null);
  assert.strictEqual(worktreeStatuses({ repoRoot: repo, names: ['github-issue-1'] }).size, 0);
});

test('a file where the worktree should be is not a worktree', () => {
  const repo = initRepo(scratch('ds-ws-file-'));
  const p = worktreePath(repo, 'github-issue-2');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'not a directory');
  assert.strictEqual(worktreeExists(repo, 'github-issue-2'), false);
});

// ------------------------------------------------------- branch, base, commits

test('the branch is read from disk, for both naming conventions', () => {
  // The directory is always `github-issue-<N>`, but the branch is not: Claude's native
  // --worktree makes `worktree-github-issue-<N>` while `git worktree add` names the
  // branch after the directory. Guessing is wrong for half of all sessions.
  const repo = initRepo(scratch('ds-ws-branch-'));
  addWorktree(repo, 'github-issue-10');
  addWorktree(repo, 'github-issue-11', { branch: 'worktree-github-issue-11' });

  assert.strictEqual(readWorktreeFacts(repo, 'github-issue-10').branch, 'github-issue-10');
  assert.strictEqual(readWorktreeFacts(repo, 'github-issue-11').branch, 'worktree-github-issue-11');
});

test('base is the branch the main checkout has out', () => {
  const repo = initRepo(scratch('ds-ws-base-'));
  addWorktree(repo, 'github-issue-12');
  assert.strictEqual(readWorktreeFacts(repo, 'github-issue-12').base, 'main');
});

test('commits ahead of the base are counted, and a merged branch reads zero', () => {
  // Zero is the case that will dominate in practice: a merged issue leaves its worktree
  // behind, so "a worktree exists" very often means "this is already done". It has to be
  // a real 0 and not a missing field, because the two get different prompt text.
  const repo = initRepo(scratch('ds-ws-count-'));
  const wt = addWorktree(repo, 'github-issue-13');
  commitIn(wt, 'a.txt', 'a');
  commitIn(wt, 'b.txt', 'b');

  const ahead = worktreeStatuses({ repoRoot: repo, names: ['github-issue-13'] }).get('github-issue-13');
  assert.strictEqual(ahead.commits, 2);
  assert.ok(ahead.head, 'the branch tip is what tells a resumed session which commits are not its own');

  git(repo, 'merge', 'github-issue-13', '--no-edit', '-q');
  const merged = worktreeStatuses({ repoRoot: repo, names: ['github-issue-13'] }).get('github-issue-13');
  assert.strictEqual(merged.commits, 0, 'a merged branch is 0 ahead, not "unknown"');
});

test('one for-each-ref covers every candidate, and unknown names cost nothing', () => {
  const repo = initRepo(scratch('ds-ws-batch-'));
  const a = addWorktree(repo, 'github-issue-20');
  addWorktree(repo, 'github-issue-21', { branch: 'worktree-github-issue-21' });
  commitIn(a, 'a.txt', 'a');

  const spent = [];
  const spy = (argv, cwd) => {
    spent.push(argv);
    return require('../../worktree-status.js').defaultGit(argv, cwd);
  };
  const out = worktreeStatuses({
    repoRoot: repo,
    names: ['github-issue-20', 'github-issue-21', 'github-issue-999'],
    git: spy,
  });

  assert.deepStrictEqual([...out.keys()].sort(), ['github-issue-20', 'github-issue-21']);
  assert.strictEqual(out.get('github-issue-20').commits, 1);
  assert.strictEqual(out.get('github-issue-21').commits, 0);
  assert.strictEqual(spent.length, 1, `expected exactly one subprocess, spent ${spent.length}`);
  assert.strictEqual(spent[0][0], 'for-each-ref');
});

test('a repo with no issue worktrees spends no subprocess at all', () => {
  // The constraint /api/issues was specified under: the issue list must not get slower
  // for the overwhelmingly common case of no parked work.
  const repo = initRepo(scratch('ds-ws-free-'));
  let calls = 0;
  worktreeStatuses({
    repoRoot: repo,
    names: ['github-issue-1', 'github-issue-2'],
    git: () => { calls++; return { ok: false, stdout: '', stderr: '' }; },
  });
  assert.strictEqual(calls, 0);
});

test('a detached worktree HEAD reports no branch and no count, never a wrong one', () => {
  const repo = initRepo(scratch('ds-ws-detached-'));
  const wt = addWorktree(repo, 'github-issue-30');
  commitIn(wt, 'a.txt', 'a');
  git(wt, 'checkout', '-q', '--detach', 'HEAD');

  const facts = worktreeStatuses({ repoRoot: repo, names: ['github-issue-30'] }).get('github-issue-30');
  assert.ok(facts, 'the worktree still exists and still counts as prior work');
  assert.strictEqual(facts.branch, undefined);
  assert.strictEqual(facts.commits, undefined, 'no ref means no count — absent, not zero');
  assert.ok(facts.lastTouched, 'the timestamp survives, since it needs no ref');
});

// ------------------------------------------------------------------ lastTouched

test('lastTouched follows real work, not just the directory mtime', () => {
  // A directory's mtime only moves when a TOP-LEVEL entry is added or removed, so an
  // agent editing files for an hour never touches it. Measured on the deepsteve repo,
  // the dir mtime lagged real activity by eight minutes.
  const repo = initRepo(scratch('ds-ws-touch-'));
  const wt = addWorktree(repo, 'github-issue-40');
  const dirMtime = fs.statSync(wt).mtimeMs;
  // Backdate the directory itself; the commit below is what should still be reported.
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(wt, old, old);
  commitIn(wt, 'a.txt', 'a');

  const facts = worktreeStatuses({ repoRoot: repo, names: ['github-issue-40'] }).get('github-issue-40');
  assert.ok(facts.lastTouched > old.getTime(),
    'a backdated directory must not hide a commit made since');
  assert.ok(Number.isFinite(dirMtime));
});

// ------------------------------------------------------------------------ dirty

test('uncommitted files are counted, and only on the single-worktree path', () => {
  // `dirty` is the discriminator that matters when deciding whether to resume: a branch
  // can be 0 commits ahead and still hold a day of unstaged work. It costs a
  // `git status` per worktree, which is why the batch above does not carry it.
  const repo = initRepo(scratch('ds-ws-dirty-'));
  const wt = addWorktree(repo, 'github-issue-50');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip');
  fs.writeFileSync(path.join(wt, 'other.txt'), 'wip');

  assert.strictEqual(worktreeStatus({ repoRoot: repo, name: 'github-issue-50' }).dirty, 2);
  assert.strictEqual(
    worktreeStatuses({ repoRoot: repo, names: ['github-issue-50'] }).get('github-issue-50').dirty,
    undefined,
    'the list path must not spend a git status per row');
});

// ------------------------------------------------------------------ fresh names

test('a fresh name is a sibling, and the occupied one is left alone', () => {
  // "Start fresh" must never be the thing that loses parked work, so it mints a new
  // name rather than clearing the old worktree.
  const repo = initRepo(scratch('ds-ws-fresh-'));
  addWorktree(repo, 'github-issue-60');
  const fresh = freshWorktreeName(repo, 'github-issue-60');
  assert.strictEqual(fresh, 'github-issue-60-2');
  assert.ok(fs.existsSync(worktreePath(repo, 'github-issue-60')), 'the original survives untouched');
});

test('a fresh name skips an occupied sibling directory', () => {
  const repo = initRepo(scratch('ds-ws-fresh2-'));
  addWorktree(repo, 'github-issue-61');
  addWorktree(repo, 'github-issue-61-2');
  assert.strictEqual(freshWorktreeName(repo, 'github-issue-61'), 'github-issue-61-3');
});

test('a fresh name skips a leftover BRANCH with no worktree', () => {
  // A removed worktree leaves its branch behind, and handing that name to --worktree
  // fails on the branch, not the path — which for a Claude session means the tab dies a
  // second after it appears (#656). Both spellings are checked: the bare name, as
  // `git worktree add` would use it, and `worktree-<name>`, as Claude's flag would.
  const repo = initRepo(scratch('ds-ws-fresh3-'));
  addWorktree(repo, 'github-issue-62');
  git(repo, 'branch', 'github-issue-62-2');
  git(repo, 'branch', 'worktree-github-issue-62-3');
  assert.strictEqual(freshWorktreeName(repo, 'github-issue-62'), 'github-issue-62-4');
});

// --------------------------------------------------------------- injected stubs

test('git being unavailable costs fields, never the answer', () => {
  // The issue list has to work on a box where git is missing or wedged. Everything the
  // filesystem knows still lands; only the counted fields go absent.
  const repo = initRepo(scratch('ds-ws-nogit-'));
  addWorktree(repo, 'github-issue-70');
  const dead = () => { throw new Error('git not found'); };
  const swallow = (argv, cwd) => { try { return dead(argv, cwd); } catch (e) { return { ok: false, stdout: '', stderr: e.message }; } };

  const facts = worktreeStatuses({ repoRoot: repo, names: ['github-issue-70'], git: swallow }).get('github-issue-70');
  assert.ok(facts, 'the worktree is still reported as existing');
  assert.strictEqual(facts.branch, 'github-issue-70', 'the branch comes off disk, not from git');
  assert.strictEqual(facts.commits, undefined);
  assert.strictEqual(facts.head, undefined);
});

test('an old git without %(ahead-behind:) still yields the date and the tip', () => {
  // The atom arrived in git 2.41 and an older git rejects the whole format string. One
  // retry without it keeps two of the three fields rather than losing all three.
  const repo = initRepo(scratch('ds-ws-oldgit-'));
  addWorktree(repo, 'github-issue-71');
  const seen = [];
  const oldGit = (argv, cwd) => {
    seen.push(argv);
    if (argv.some(a => a.includes('ahead-behind'))) return { ok: false, stdout: '', stderr: 'fatal: unknown field name' };
    return require('../../worktree-status.js').defaultGit(argv, cwd);
  };
  const facts = worktreeStatuses({ repoRoot: repo, names: ['github-issue-71'], git: oldGit }).get('github-issue-71');
  assert.strictEqual(seen.length, 2, 'one attempt with the atom, one without');
  assert.strictEqual(facts.commits, undefined, 'the count is absent, not zero');
  assert.ok(facts.head, 'the tip still lands');
});

test('branch names reach git as argv and are validated first', () => {
  // No shell is involved, so injection is not the risk — argument smuggling is. The
  // anchor rejects every leading-dash form.
  assert.strictEqual(validateBranch('worktree-github-issue-689'), 'worktree-github-issue-689');
  assert.strictEqual(validateBranch('feature/x.y-1'), 'feature/x.y-1');
  for (const bad of ['--upload-pack=evil', '-x', '', null, 'a b', 'a;b']) {
    assert.strictEqual(validateBranch(bad), null, `${JSON.stringify(bad)} must not reach git as a ref`);
  }
});

test('a branch git would refuse is never sent to it', () => {
  // headBranch() runs its read through validateBranch, so a hand-edited HEAD cannot
  // smuggle a name into the for-each-ref argv.
  const repo = initRepo(scratch('ds-ws-badref-'));
  const wt = addWorktree(repo, 'github-issue-80');
  const link = fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
  fs.writeFileSync(path.join(link, 'HEAD'), 'ref: refs/heads/--upload-pack=evil\n');

  const spent = [];
  worktreeStatuses({
    repoRoot: repo,
    names: ['github-issue-80'],
    git: (argv, cwd) => { spent.push(argv); return { ok: false, stdout: '', stderr: '' }; },
  });
  assert.strictEqual(spent.length, 0, 'a rejected branch means no ref to ask about, so no subprocess');
});

// ------------------------------------------------------------- the shared path

test('worktreePath is the convention server.js delegates to', () => {
  // The module is worthless if its idea of where a worktree lives can drift from the
  // code that creates one, so getWorktreePath() must not re-implement the join.
  assert.strictEqual(worktreePath('/repo', 'github-issue-1'), path.join('/repo', '.claude', 'worktrees', 'github-issue-1'));
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const fn = server.slice(server.indexOf('function getWorktreePath('));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /return worktreePath\(cwd, name\)/,
    'getWorktreePath must delegate to worktree-status.js (#689)');
});

test('a fresh name skips a sibling a live session already holds', () => {
  // The window this closes: a Claude session creates its worktree directory ITSELF,
  // after spawn, so between "Start fresh" and the agent getting there the name exists
  // nowhere on disk. Two fresh starts in that window would otherwise be handed the same
  // name and put two agents in one checkout — the exact state the feature warns about.
  const repo = initRepo(scratch('ds-ws-reserved-'));
  addWorktree(repo, 'github-issue-63');
  assert.strictEqual(freshWorktreeName(repo, 'github-issue-63'), 'github-issue-63-2');
  assert.strictEqual(
    freshWorktreeName(repo, 'github-issue-63', { reserved: ['github-issue-63-2'] }),
    'github-issue-63-3',
    'a name a live session already holds is not free, even though nothing is on disk yet');
  // The Claude spelling of the same reservation counts too.
  assert.strictEqual(
    freshWorktreeName(repo, 'github-issue-63', { reserved: ['worktree-github-issue-63-2'] }),
    'github-issue-63-3');
});

test('the daemon supplies the reservations, from its live sessions', () => {
  // The module cannot know them, so a caller that forgets is the whole bug. Both call
  // sites — the button label and the mint at spawn — have to pass them.
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const sites = server.split('freshWorktreeName(').length - 1;
  assert.strictEqual(sites, 2, `expected the 2 known freshWorktreeName call sites, found ${sites}`);
  assert.strictEqual(server.split('reserved: reservedWorktreeNames()').length - 1, 2,
    'every freshWorktreeName call site must pass the live sessions reservations (#689)');
});
