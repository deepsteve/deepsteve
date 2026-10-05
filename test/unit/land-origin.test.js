// Landing worktree branches on origin instead of in the main checkout (#725).
//
// Every case runs real git against a real layout — a bare "GitHub", a clone as the main
// checkout, and a worktree under its .claude/worktrees — because the claims here are
// about what git accepts (a pushed sha, merge-tree's exit codes, a rejected push) and a
// scripted runner would only restate the code's own assumptions back to it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { landWorktree, runGitNet, describeLanding, mergeSubject, isPushRace } = require('../../mods/deepsteve-core/land-origin.js');
const { mergeSession } = require('../../mods/deepsteve-core/session-merge.js');
const { mergeMode, worktreeBaseRef, worktreeAddArgs } = require('../../merge-policy.js');

function git(args, cwd) {
  try {
    return { ok: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '', stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}

function must(args, cwd) {
  const r = git(args, cwd);
  assert.ok(r.ok, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  must(['add', '-A'], dir);
  must(['commit', '-qm', msg], dir);
  return must(['rev-parse', 'HEAD'], dir);
}

function identity(dir) {
  must(['config', 'user.email', 't@example.com'], dir);
  must(['config', 'user.name', 'T'], dir);
}

/**
 * remote.git (bare, the "GitHub") ← repo (the main checkout, on main) with a worktree
 * at repo/.claude/worktrees/<name> on `worktree-<name>`, created from origin/main the way
 * Claude Code creates one.
 */
function fixture(t, { name = 'feature' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-land-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const remote = path.join(tmp, 'remote.git');
  const repo = path.join(tmp, 'repo');
  must(['init', '-q', '--bare', '-b', 'main', remote], tmp);
  must(['clone', '-q', remote, repo], tmp);
  identity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  commitFile(repo, 'a.txt', 'one\n', 'init');
  must(['push', '-q', '-u', 'origin', 'main'], repo);
  must(['remote', 'set-head', 'origin', 'main'], repo);
  const wt = path.join(repo, '.claude', 'worktrees', name);
  must(['worktree', 'add', '-q', '-b', `worktree-${name}`, wt, 'origin/main'], repo);
  return { tmp, remote, repo, wt, branch: `worktree-${name}` };
}

// Another machine (or another landing) pushing to the remote.
function pushFromElsewhere(f, file, content, msg) {
  const other = path.join(f.tmp, `other-${Math.random().toString(36).slice(2, 8)}`);
  must(['clone', '-q', f.remote, other], f.tmp);
  identity(other);
  const sha = commitFile(other, file, content, msg);
  must(['push', '-q', 'origin', 'main'], other);
  return sha;
}

const remoteMain = (f) => must(['rev-parse', 'refs/heads/main'], f.remote);
const isAncestor = (a, b, cwd) => git(['merge-base', '--is-ancestor', a, b], cwd).ok;
const land = (f, extra = {}) => landWorktree({ git, gitNet: runGitNet, worktreeCwd: f.wt, repoRoot: f.repo, target: undefined, ...extra });

test('lands a diverged branch on origin as a merge commit, origin first, and catches the clean checkout up', async (t) => {
  const f = fixture(t);
  const branchSha = commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  commitFile(f.repo, 'c.txt', 'three\n', 'main moved');
  must(['push', '-q', 'origin', 'main'], f.repo);
  const originBefore = remoteMain(f);

  const r = await land(f);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.via, 'origin');
  assert.equal(r.kind, 'merge');
  assert.equal(r.target, 'main');
  assert.equal(r.pushed, remoteMain(f), 'the pushed sha is what origin now has');

  // main's first-parent line reads exactly as a local `git merge` would have left it.
  const parents = must(['rev-list', '--parents', '-n1', 'refs/heads/main'], f.remote).split(' ');
  assert.deepEqual(parents.slice(1), [originBefore, branchSha]);
  assert.equal(must(['log', '-1', '--format=%s', 'refs/heads/main'], f.remote), "Merge branch 'worktree-feature'");

  assert.equal(r.localSync.status, 'synced');
  assert.equal(must(['rev-parse', 'main'], f.repo), remoteMain(f));
  assert.ok(fs.existsSync(path.join(f.repo, 'b.txt')), 'the work reached the main checkout');
  assert.match(describeLanding(r), /via origin \(local synced\)/);
});

test('uncommitted work in the main checkout no longer blocks the landing, and is left exactly as it was', async (t) => {
  const f = fixture(t);
  const branchSha = commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'edited, not committed\n');
  fs.writeFileSync(path.join(f.repo, 'wip.txt'), 'untracked\n');
  const headBefore = must(['rev-parse', 'HEAD'], f.repo);

  const r = await land(f);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.via, 'origin');
  assert.ok(isAncestor(branchSha, remoteMain(f), f.repo), 'the branch is on origin');

  assert.equal(r.localSync.status, 'dirty');
  assert.equal(must(['rev-parse', 'HEAD'], f.repo), headBefore, 'a dirty checkout is not moved');
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'edited, not committed\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'wip.txt'), 'utf8'), 'untracked\n');
  assert.ok(!fs.existsSync(path.join(f.repo, 'b.txt')));
});

test('fast-forwards origin when it has not moved since the branch started', async (t) => {
  const f = fixture(t);
  const branchSha = commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  const r = await land(f);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.kind, 'fast-forward');
  assert.equal(remoteMain(f), branchSha);
  assert.equal(r.localSync.status, 'synced');
  assert.equal(must(['rev-parse', 'main'], f.repo), branchSha);
});

test('a conflict pushes nothing, starts no merge anywhere, and says what to rebase onto', async (t) => {
  const f = fixture(t);
  commitFile(f.wt, 'a.txt', 'from the branch\n', 'branch edits a');
  commitFile(f.repo, 'a.txt', 'from main\n', 'main edits a');
  must(['push', '-q', 'origin', 'main'], f.repo);
  const originBefore = remoteMain(f);

  const r = await land(f);
  assert.equal(r.status, 'conflict', JSON.stringify(r));
  assert.equal(r.via, 'origin');
  assert.equal(r.rebaseOnto, 'origin/main');
  assert.deepEqual(r.conflicts, ['a.txt']);
  assert.equal(remoteMain(f), originBefore, 'origin is untouched');
  assert.ok(!git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], f.repo).ok, 'no merge was started in the checkout');
  assert.equal(must(['status', '--porcelain'], f.repo), '');
});

test('a lost push race refetches and lands on the new tip', async (t) => {
  const f = fixture(t);
  const branchSha = commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  let otherSha = null;
  let pushes = 0;
  const gitNet = async (args, cwd) => {
    // Between our fetch and our push, someone else lands.
    if (args[0] === 'push' && pushes++ === 0) otherSha = pushFromElsewhere(f, 'd.txt', 'four\n', 'landed first');
    return runGitNet(args, cwd);
  };
  const r = await landWorktree({ git, gitNet, worktreeCwd: f.wt, repoRoot: f.repo, target: undefined });
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(pushes, 2, 'the rejected push was retried once');
  assert.ok(isAncestor(otherSha, remoteMain(f), f.repo), 'the other landing survives');
  assert.ok(isAncestor(branchSha, remoteMain(f), f.repo), 'and ours is on top of it');
});

test('a push the remote refuses for any other reason falls back to the local merge', async (t) => {
  const f = fixture(t);
  const hook = path.join(f.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const branchSha = commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  const originBefore = remoteMain(f);

  const r = await land(f);
  assert.equal(r.via, 'local');
  assert.match(r.originFallback, /^push-refused: /);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(remoteMain(f), originBefore);
  assert.ok(isAncestor(branchSha, must(['rev-parse', 'main'], f.repo), f.repo), 'merged in the main checkout instead');
});

test('a repo opted out with `git config deepsteve.merge local` merges in the main checkout, as before', async (t) => {
  const f = fixture(t);
  must(['config', 'deepsteve.merge', 'local'], f.repo);
  assert.equal(mergeMode(git, f.repo), 'local');
  commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  const originBefore = remoteMain(f);

  const r = await land(f);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.via, 'local');
  assert.equal(r.originFallback, 'opted-out');
  assert.equal(remoteMain(f), originBefore, 'nothing was pushed');
  assert.ok(fs.existsSync(path.join(f.repo, 'b.txt')));

  // ...including today's refusal on a dirty checkout, which is the opt-out's whole cost.
  commitFile(f.wt, 'c.txt', 'three\n', 'more');
  fs.writeFileSync(path.join(f.repo, 'wip.txt'), 'uncommitted\n');
  assert.equal((await land(f)).status, 'target-dirty');
});

test('no origin remote, or a target origin does not have, falls back to the local merge', async (t) => {
  const f = fixture(t);
  commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  must(['branch', 'release', 'main'], f.repo);   // local only, checked out nowhere
  const notOnOrigin = await land(f, { target: 'release' });
  assert.equal(notOnOrigin.via, 'local');
  assert.equal(notOnOrigin.originFallback, 'target-not-on-origin');
  assert.equal(notOnOrigin.status, 'target-not-checked-out', 'mergeWorktree\'s own answer, passed through');

  must(['remote', 'remove', 'origin'], f.repo);
  const noRemote = await land(f);
  assert.equal(noRemote.via, 'local');
  assert.equal(noRemote.originFallback, 'no-origin-remote');
  assert.equal(noRemote.status, 'merged', JSON.stringify(noRemote));
});

test('a branch origin already contains is merged with nothing pushed', async (t) => {
  const f = fixture(t);
  const originBefore = remoteMain(f);
  const r = await land(f);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.kind, 'up-to-date');
  assert.equal(r.pushed, null);
  assert.equal(remoteMain(f), originBefore);
});

test('a checkout whose own unpushed commits conflict with origin is left alone after the landing', async (t) => {
  const f = fixture(t);
  commitFile(f.wt, 'a.txt', 'from the branch\n', 'branch edits a');
  const localHead = commitFile(f.repo, 'a.txt', 'unpushed local edit\n', 'local, not pushed');

  const r = await land(f);
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.kind, 'fast-forward', 'origin had not moved, so the branch fast-forwards it');
  assert.equal(r.localSync.status, 'conflict');
  assert.equal(must(['rev-parse', 'HEAD'], f.repo), localHead);
  assert.ok(!git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], f.repo).ok, 'the catch-up merge was aborted');
  assert.equal(must(['status', '--porcelain'], f.repo), '');
});

test('without a network runner landWorktree is mergeWorktree, call for call', async (t) => {
  const f = fixture(t);
  commitFile(f.wt, 'b.txt', 'two\n', 'feature work');
  const calls = [];
  const recording = (args, cwd) => { calls.push(args[0]); return git(args, cwd); };
  const r = await landWorktree({ git: recording, worktreeCwd: f.wt, repoRoot: f.repo, target: undefined });
  assert.equal(r.status, 'merged');
  assert.equal(r.via, undefined, 'the local-only path adds nothing to the result');
  assert.ok(!calls.includes('config') && !calls.includes('remote'), 'and asks git nothing extra');
});

test('mergeSession commits, lands on origin and closes the issue in one call', async (t) => {
  const f = fixture(t, { name: 'github-issue-7' });
  fs.writeFileSync(path.join(f.wt, 'b.txt'), 'uncommitted work\n');
  fs.writeFileSync(path.join(f.repo, 'wip.txt'), 'the main thread is mid-edit\n');
  const ghCalls = [];
  const gh = async (argv) => {
    ghCalls.push(argv.slice(0, 2).join(' '));
    return argv[1] === 'view' ? { stdout: 'Do the thing\n' } : { stdout: '' };
  };
  const r = await mergeSession({ git, gh, gitNet: runGitNet, cwd: f.wt, repoRoot: f.repo, isWorktree: true });
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.via, 'origin');
  assert.equal(r.committed, true);
  assert.equal(r.subject, 'Do the thing (#7)');
  assert.deepEqual(r.issue, { number: 7, closed: true });
  assert.ok(ghCalls.includes('issue close'));
  assert.equal(must(['log', '-1', '--format=%s', 'refs/heads/main'], f.remote), 'Do the thing (#7)');
});

test('Codex worktrees start from origin\'s default branch, not from unpushed local commits', (t) => {
  const f = fixture(t);
  const originSha = remoteMain(f);
  commitFile(f.repo, 'local.txt', 'unpushed\n', 'local only');
  assert.equal(worktreeBaseRef(git, f.repo), 'refs/remotes/origin/main');

  const wtPath = path.join(f.repo, '.claude', 'worktrees', 'github-issue-9');
  const args = worktreeAddArgs(f.repo, wtPath, { git });
  assert.deepEqual(args, ['worktree', 'add', '-b', 'github-issue-9', wtPath, 'refs/remotes/origin/main']);
  must(args, f.repo);
  assert.equal(must(['rev-parse', 'HEAD'], wtPath), originSha);
  assert.equal(must(['branch', '--show-current'], wtPath), 'github-issue-9', 'the branch keeps the directory\'s name');

  // An existing branch is checked out as it is — parked work is never re-based.
  must(['worktree', 'remove', '--force', wtPath], f.repo);
  assert.deepEqual(worktreeAddArgs(f.repo, wtPath, { git }), ['worktree', 'add', wtPath, 'github-issue-9']);

  // Opted out: today's argv, which branches from the checkout's HEAD.
  must(['config', 'deepsteve.merge', 'local'], f.repo);
  assert.equal(worktreeBaseRef(git, f.repo), null);
  assert.deepEqual(worktreeAddArgs(f.repo, path.join(f.repo, 'x'), { git }), ['worktree', 'add', path.join(f.repo, 'x')]);
});

test('without origin/HEAD the base is origin\'s copy of the checked-out branch, and with no origin it is HEAD', (t) => {
  const f = fixture(t);
  must(['remote', 'set-head', 'origin', '--delete'], f.repo);
  assert.equal(worktreeBaseRef(git, f.repo), 'refs/remotes/origin/main');
  must(['remote', 'remove', 'origin'], f.repo);
  assert.equal(worktreeBaseRef(git, f.repo), null);
});

test('helpers: git\'s own merge subject, and only the race is a retryable refusal', () => {
  assert.equal(mergeSubject('worktree-x', 'main'), "Merge branch 'worktree-x'");
  assert.equal(mergeSubject('worktree-x', 'master'), "Merge branch 'worktree-x'");
  assert.equal(mergeSubject('worktree-x', 'prime'), "Merge branch 'worktree-x' into prime");
  assert.ok(isPushRace('!\tabc:refs/heads/main\t[rejected] (non-fast-forward)'));
  assert.ok(isPushRace('!\tabc:refs/heads/main\t[rejected] (fetch first)'));
  assert.ok(!isPushRace('!\tabc:refs/heads/main\t[remote rejected] (pre-receive hook declined)'));
});
