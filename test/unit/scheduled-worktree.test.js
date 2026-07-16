// Unit tests for the scheduled-tasks per-run worktree isolation (#565):
// cleanupWorktree's conservative remove semantics, isGitRepo, and the
// worktree-aware scheduled-run prompt contract.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME
// at a scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-home-'));

const { cleanupWorktree, isGitRepo, scheduledRunPrompt, worktreeContract } =
  require('../../mods/scheduled-tasks/tools.js');

// Plain exec (no zsh) so these tests run on the bare CI runner; production
// injects the default zsh -l -c wrapper for the LaunchAgent PATH.
const exec = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-repo-'));
  exec('git init -q -b main', repo);
  exec('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', repo);
  return repo;
}

// Mirror runTask's per-run layout: worktree scheduled-<id> on branch
// worktree-scheduled-<id> (claude's native --worktree naming).
function addWorktree(repo, name) {
  const wt = path.join(repo, '.claude', 'worktrees', name);
  exec(`git worktree add -q -b "worktree-${name}" "${wt}"`, repo);
  return wt;
}

const branches = (repo) => exec('git branch --format="%(refname:short)"', repo).split('\n');

test('clean worktree: removed and branch deleted', () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, 'scheduled-ab12cd34');
  const res = cleanupWorktree(repo, 'scheduled-ab12cd34', exec);
  assert.deepStrictEqual(res, { removed: true, branchDeleted: true });
  assert.ok(!fs.existsSync(wt), 'worktree dir should be gone');
  assert.ok(!branches(repo).includes('worktree-scheduled-ab12cd34'), 'branch should be gone');
});

test('dirty worktree: kept (worktree AND branch), then removable once clean', () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, 'scheduled-dirty001');
  const stray = path.join(wt, 'uncommitted.txt');
  fs.writeFileSync(stray, 'work in progress');
  const res = cleanupWorktree(repo, 'scheduled-dirty001', exec);
  assert.deepStrictEqual(res, { removed: false, branchDeleted: false });
  assert.ok(fs.existsSync(wt), 'dirty worktree must survive');
  assert.ok(branches(repo).includes('worktree-scheduled-dirty001'), 'branch must survive with its worktree');
  // Idempotent retry after the dirt is gone.
  fs.unlinkSync(stray);
  const retry = cleanupWorktree(repo, 'scheduled-dirty001', exec);
  assert.deepStrictEqual(retry, { removed: true, branchDeleted: true });
  assert.ok(!fs.existsSync(wt));
});

test('unmerged commits: worktree removed, branch kept', () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, 'scheduled-unmrgd01');
  fs.writeFileSync(path.join(wt, 'result.txt'), 'kept work');
  exec('git add result.txt', wt);
  exec('git -c user.email=t@t -c user.name=t commit -q -m result', wt);
  const res = cleanupWorktree(repo, 'scheduled-unmrgd01', exec);
  assert.deepStrictEqual(res, { removed: true, branchDeleted: false });
  assert.ok(!fs.existsSync(wt), 'clean worktree is removed even with unmerged commits');
  assert.ok(branches(repo).includes('worktree-scheduled-unmrgd01'), 'unmerged branch must survive');
});

test('merged commits: worktree removed and branch deleted', () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, 'scheduled-merged01');
  fs.writeFileSync(path.join(wt, 'result.txt'), 'merged work');
  exec('git add result.txt', wt);
  exec('git -c user.email=t@t -c user.name=t commit -q -m result', wt);
  exec('git merge -q worktree-scheduled-merged01', repo);
  const res = cleanupWorktree(repo, 'scheduled-merged01', exec);
  assert.deepStrictEqual(res, { removed: true, branchDeleted: true });
  assert.ok(fs.existsSync(path.join(repo, 'result.txt')), 'merged work stays in main');
});

test('stale-locked clean worktree: unlocked and removed (claude locks its worktrees)', () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, 'scheduled-locked01');
  exec(`git worktree lock --reason "claude session scheduled-locked01 (pid 99999)" "${wt}"`, repo);
  const res = cleanupWorktree(repo, 'scheduled-locked01', exec);
  assert.deepStrictEqual(res, { removed: true, branchDeleted: true });
  assert.ok(!fs.existsSync(wt), 'stale lock must not keep a clean worktree alive');
});

test('locked AND dirty worktree: still kept', () => {
  const repo = makeRepo();
  const wt = addWorktree(repo, 'scheduled-lockdrt1');
  exec(`git worktree lock "${wt}"`, repo);
  fs.writeFileSync(path.join(wt, 'wip.txt'), 'uncommitted');
  const res = cleanupWorktree(repo, 'scheduled-lockdrt1', exec);
  assert.deepStrictEqual(res, { removed: false, branchDeleted: false });
  assert.ok(fs.existsSync(wt), 'dirty worktree survives even after unlock');
});

test('worktree dir never created: no throw, prunes and reports removed', () => {
  const repo = makeRepo();
  const res = cleanupWorktree(repo, 'scheduled-never123', exec);
  assert.deepStrictEqual(res, { removed: true, branchDeleted: true });
});

test('bad args: no throw, nothing reported removed', () => {
  assert.deepStrictEqual(cleanupWorktree(null, 'x', exec), { removed: false, branchDeleted: false });
  assert.deepStrictEqual(cleanupWorktree('/tmp', null, exec), { removed: false, branchDeleted: false });
});

test('isGitRepo distinguishes repos from plain dirs', (t) => {
  // isGitRepo uses the production zsh -l -c path — skip where zsh is absent (CI).
  try { execSync('command -v zsh', { encoding: 'utf8' }); }
  catch { return t.skip('zsh not available'); }
  const repo = makeRepo();
  assert.strictEqual(isGitRepo(repo), true);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-plain-'));
  assert.strictEqual(isGitRepo(plain), false);
});

test('scheduledRunPrompt: isolation contract present only with iso', () => {
  const task = { id: 'ab12cd34', title: 'Nightly report', prompt: 'Generate the report.' };
  const iso = { path: '/repo/.claude/worktrees/scheduled-ef56', branch: 'worktree-scheduled-ef56', repoRoot: '/repo' };

  const plain = scheduledRunPrompt(task);
  assert.ok(plain.includes('scheduled_task_started'));
  assert.ok(plain.includes('scheduled_task_finished'));
  assert.ok(plain.includes(task.prompt));
  assert.ok(!plain.includes('DISPOSABLE'), 'no worktree text without iso');
  assert.ok(!plain.includes('worktree'), 'no worktree text without iso');

  const isolated = scheduledRunPrompt(task, iso);
  assert.ok(isolated.includes(iso.path));
  assert.ok(isolated.includes(iso.branch));
  assert.ok(isolated.includes(iso.repoRoot));
  assert.ok(isolated.includes('DISPOSABLE'));
  assert.ok(/Merge\/push anything worth keeping BEFORE calling/.test(isolated), 'merge-back-before-finish instruction');
  assert.ok(isolated.includes('scheduled_task_started'));
  assert.ok(isolated.includes(task.prompt));

  assert.ok(worktreeContract(iso).includes('never edit files there directly'));
});
