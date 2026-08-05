// Unit tests for the server-side worktree merge (#617).
//
// Claude Code 2.1.222 refuses `git -C <shared checkout>` from a worktree-isolated
// session, which is exactly what skills/merge.md ran, so the merge moved into the
// daemon. These tests drive the decision logic with a scripted git runner (no repo
// needed) and then prove the whole thing against a real one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { mergeWorktree, findWorktreeFor, validateBranch } = require('../../mods/deepsteve-core/merge-worktree.js');

// A git runner driven by a table of `argv.join(' ')` prefixes → results. Anything
// unmatched fails loudly rather than silently returning success.
function scriptedGit(table, calls = []) {
  return (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    for (const [prefix, res] of table) {
      if (args.join(' ').startsWith(prefix)) {
        return { ok: true, stdout: '', stderr: '', ...res };
      }
    }
    return { ok: false, stdout: '', stderr: `unscripted: git ${args.join(' ')}` };
  };
}

const WT = '/repo/.claude/worktrees/feature';
const ROOT = '/repo';

test('merges into the main checkout branch when no target is given', () => {
  const calls = [];
  const git = scriptedGit([
    ['branch --show-current', { stdout: 'main\n' }],       // repoRoot lookup
    ['status --porcelain', { stdout: '' }],
    ['merge', { stdout: 'Fast-forward\n' }],
  ], calls);
  // The worktree's own branch resolves first; disambiguate by cwd.
  const g = (args, cwd) => (args[0] === 'branch' && cwd === WT)
    ? (calls.push({ args: args.join(' '), cwd }), { ok: true, stdout: 'feature\n', stderr: '' })
    : git(args, cwd);

  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT, target: undefined });
  assert.equal(r.status, 'merged');
  assert.equal(r.branch, 'feature');
  assert.equal(r.target, 'main');
  assert.equal(r.mergeDir, ROOT);
  // The merge must run in the target checkout, never in the worktree.
  const merge = calls.find(c => c.args.startsWith('merge feature'));
  assert.equal(merge.cwd, ROOT);
});

test('refuses when the target checkout is dirty, without merging', () => {
  const calls = [];
  const g = (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    if (args[0] === 'branch') return { ok: true, stdout: cwd === WT ? 'feature\n' : 'main\n', stderr: '' };
    if (args[0] === 'status') return { ok: true, stdout: ' M server.js\n?? scratch.txt\n', stderr: '' };
    return { ok: false, stdout: '', stderr: 'should not run' };
  };
  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT });
  assert.equal(r.status, 'target-dirty');
  assert.deepEqual(r.changes, [' M server.js', '?? scratch.txt']);
  assert.ok(!calls.some(c => c.args.startsWith('merge')), 'must not attempt the merge');
});

test('aborts the merge on conflict so the target is left untouched', () => {
  const calls = [];
  const g = (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    if (args[0] === 'branch') return { ok: true, stdout: cwd === WT ? 'feature\n' : 'main\n', stderr: '' };
    if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'merge' && args[1] === '--abort') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'merge') return { ok: false, stdout: 'CONFLICT (content): server.js\n', stderr: '' };
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123\n', stderr: '' };  // MERGE_HEAD exists
    return { ok: false, stdout: '', stderr: 'x' };
  };
  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT });
  assert.equal(r.status, 'conflict');
  assert.ok(calls.some(c => c.args === 'merge --abort'), 'must abort the conflicted merge');
});

test('a pre-flight failure is NOT aborted or reported as a conflict', () => {
  // No MERGE_HEAD => no merge ever started, so `git merge --abort` would itself
  // error and rebasing could not help. It must surface as `failed`.
  const calls = [];
  const g = (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    if (args[0] === 'branch') return { ok: true, stdout: cwd === WT ? 'feature\n' : 'main\n', stderr: '' };
    if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'merge') return { ok: false, stdout: '', stderr: 'error: Your local changes would be overwritten\n' };
    if (args[0] === 'rev-parse') return { ok: false, stdout: '', stderr: 'not a valid ref' };
    return { ok: false, stdout: '', stderr: 'x' };
  };
  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT });
  assert.equal(r.status, 'failed');
  assert.ok(!calls.some(c => c.args === 'merge --abort'), 'must not abort a merge that never started');
});

test('finds the worktree holding a target that is not the main checkout branch', () => {
  const porcelain = [
    'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /repo/.claude/worktrees/release', 'HEAD bbb', 'branch refs/heads/release-1.2', '',
  ].join('\n');
  assert.equal(findWorktreeFor(porcelain, 'release-1.2'), '/repo/.claude/worktrees/release');
  assert.equal(findWorktreeFor(porcelain, 'main'), '/repo');
  assert.equal(findWorktreeFor(porcelain, 'nope'), null);

  const calls = [];
  const g = (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    if (args[0] === 'branch' && args[1] === '--show-current') {
      return { ok: true, stdout: cwd === WT ? 'feature\n' : 'main\n', stderr: '' };
    }
    if (args[0] === 'worktree') return { ok: true, stdout: porcelain, stderr: '' };
    if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'merge') return { ok: true, stdout: 'Merge made\n', stderr: '' };
    return { ok: false, stdout: '', stderr: 'x' };
  };
  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT, target: 'release-1.2' });
  assert.equal(r.status, 'merged');
  assert.equal(r.mergeDir, '/repo/.claude/worktrees/release');
  assert.equal(calls.find(c => c.args.startsWith('merge feature')).cwd, '/repo/.claude/worktrees/release');
});

test('distinguishes a missing branch from one that is merely not checked out', () => {
  const mk = (exists) => (args, cwd) => {
    if (args[0] === 'branch' && args[1] === '--show-current') {
      return { ok: true, stdout: cwd === WT ? 'feature\n' : 'main\n', stderr: '' };
    }
    if (args[0] === 'worktree') return { ok: true, stdout: 'worktree /repo\nbranch refs/heads/main\n', stderr: '' };
    if (args[0] === 'rev-parse') return { ok: exists, stdout: '', stderr: 'bad rev' };
    return { ok: false, stdout: '', stderr: 'x' };
  };
  assert.equal(mergeWorktree({ git: mk(false), worktreeCwd: WT, repoRoot: ROOT, target: 'ghost' }).status, 'no-such-branch');
  assert.equal(mergeWorktree({ git: mk(true), worktreeCwd: WT, repoRoot: ROOT, target: 'parked' }).status, 'target-not-checked-out');
});

test('stops when the branch is already the target, and on a detached worktree', () => {
  const same = (args, cwd) => ({ ok: true, stdout: 'main\n', stderr: '' });
  assert.equal(mergeWorktree({ git: same, worktreeCwd: WT, repoRoot: ROOT }).status, 'same-branch');

  const detached = (args, cwd) => ({ ok: true, stdout: cwd === WT ? '\n' : 'main\n', stderr: '' });
  assert.equal(mergeWorktree({ git: detached, worktreeCwd: WT, repoRoot: ROOT }).status, 'detached');
});

test('a detached main checkout with no explicit target asks instead of guessing', () => {
  const g = (args, cwd) => ({ ok: true, stdout: cwd === WT ? 'feature\n' : '\n', stderr: '' });
  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT });
  assert.equal(r.status, 'no-target');
});

test('branch names that could smuggle git arguments are rejected', () => {
  assert.equal(validateBranch('main'), 'main');
  assert.equal(validateBranch('feature/foo-1.2'), 'feature/foo-1.2');
  assert.equal(validateBranch('  main  '), 'main');
  for (const bad of ['--upload-pack=/bin/sh', '-C', '--exec=x', '', '  ', 'a'.repeat(300), null, 42, 'a b']) {
    assert.equal(validateBranch(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  // …and are refused before reaching git at all.
  const g = (args, cwd) => ({ ok: true, stdout: cwd === WT ? 'feature\n' : 'main\n', stderr: '' });
  const r = mergeWorktree({ git: g, worktreeCwd: WT, repoRoot: ROOT, target: '--upload-pack=/bin/sh' });
  assert.equal(r.status, 'error');
});

// --- End-to-end against a real repository ---------------------------------
// The scripted tests pin the decision tree; this pins that the argv we build is
// actually what git accepts, including the worktree layout deepsteve creates.
test('merges a real worktree branch into the real main checkout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-merge-'));
  const repo = path.join(tmp, 'repo');
  const git = (args, cwd) => {
    try {
      return { ok: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '', stderr: '' };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  };
  fs.mkdirSync(repo, { recursive: true });
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 't@example.com'],
    ['config', 'user.name', 'T'],
  ]) assert.ok(git(args, repo).ok, `setup failed: git ${args.join(' ')}`);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  // Real repos using Claude worktrees ignore .claude/ (deepsteve's own .gitignore
  // has `.claude/*`); without it the worktree dir sits inside the main checkout and
  // shows as untracked, so the dirty-target guard would refuse every merge.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  assert.ok(git(['add', '-A'], repo).ok);
  assert.ok(git(['commit', '-qm', 'init'], repo).ok);

  const wt = path.join(repo, '.claude', 'worktrees', 'feature');
  assert.ok(git(['worktree', 'add', '-q', '-b', 'feature', wt], repo).ok, 'worktree add failed');
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
  assert.ok(git(['add', '-A'], wt).ok);
  assert.ok(git(['commit', '-qm', 'feature work'], wt).ok);

  const r = mergeWorktree({ git, worktreeCwd: wt, repoRoot: repo, target: undefined });
  assert.equal(r.status, 'merged', `expected merge, got ${JSON.stringify(r)}`);
  assert.equal(r.target, 'main');
  assert.equal(r.branch, 'feature');
  // The commit really landed in the main checkout.
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')), 'merged file missing from main checkout');

  // And a dirty target is refused rather than clobbered.
  fs.writeFileSync(path.join(wt, 'c.txt'), 'three\n');
  git(['add', '-A'], wt); git(['commit', '-qm', 'more'], wt);
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n');
  const r2 = mergeWorktree({ git, worktreeCwd: wt, repoRoot: repo, target: undefined });
  assert.equal(r2.status, 'target-dirty');
  assert.ok(!fs.existsSync(path.join(repo, 'c.txt')), 'must not have merged into a dirty target');

  fs.rmSync(tmp, { recursive: true, force: true });
});
