// Guard for worktree-support.js (#656 follow-up).
//
// The bug: opening a GitHub issue against a repo with no commits yet spawned the
// agent with `--worktree <name>`, Claude Code failed to resolve a base branch and
// exited about a second later, and the daemon closed the tab. From the browser it
// looked like the session was killed on arrival, with nothing on screen or in the
// UI to say why. Twice in a row reads as a crash.
//
// These tests build REAL git repos rather than stubbing, because the whole point of
// the module is to agree with what git (and therefore the agent) actually does about
// an unborn HEAD — a hand-rolled fixture would only assert what we already believed.
// The stub-injection tests at the bottom cover the two cases a real repo cannot
// produce on demand: git missing entirely, and the exact argv we spend.
//
// Run: node --test test/unit/worktree-support.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { worktreeProblem, usableWorktree } = require('../../worktree-support.js');

// realpath'd for the same reason git-root.test.js does it: macOS /tmp is a symlink,
// and the messages under test embed the cwd verbatim.
function scratch(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(dir, { commit } = {}) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: dir, stdio: 'ignore' });
  }
  return dir;
}

// ------------------------------------------------------------- worktreeProblem

test('a repo with a commit can host a worktree', () => {
  const repo = initRepo(scratch('ds-wt-ok-'), { commit: true });
  assert.strictEqual(worktreeProblem(repo), null);
});

test('a repo with no commits is refused, and the message says why', () => {
  const repo = initRepo(scratch('ds-wt-unborn-'));
  const problem = worktreeProblem(repo);
  assert.ok(problem, 'an unborn HEAD must be reported');
  assert.strictEqual(problem.code, 'worktree-no-commits');
  assert.strictEqual(problem.cwd, repo);
  assert.match(problem.message, /no commits yet/);
});

test('a plain directory is reported as not-a-repo, not as missing commits', () => {
  // Ordering matters: a non-repo fails the HEAD probe too, so a naive check would
  // send someone hunting for a missing commit in a directory that was never a repo.
  const plain = scratch('ds-wt-plain-');
  const problem = worktreeProblem(plain);
  assert.ok(problem);
  assert.strictEqual(problem.code, 'worktree-not-a-repo');
  assert.match(problem.message, /not a git repository/);
});

test('an existing worktree does not rescue an unborn repo', () => {
  // Measured, not assumed: Claude Code resolves the base branch BEFORE it looks at
  // whether .claude/worktrees/<name> already exists, so short-circuiting on the
  // directory's presence would hand back a name that still kills the session.
  const repo = initRepo(scratch('ds-wt-existing-'));
  const wt = path.join(repo, '.claude', 'worktrees', 'github-issue-1');
  fs.mkdirSync(wt, { recursive: true });
  assert.strictEqual(worktreeProblem(repo)?.code, 'worktree-no-commits');
  assert.strictEqual(usableWorktree(repo, 'github-issue-1'), null);
});

test('a falsy cwd is not refused', () => {
  // Mirrors spawnCwdProblem: a saved record can carry an undefined cwd, and refusing
  // it here would break paths that legitimately spawn in the daemon's own directory.
  assert.strictEqual(worktreeProblem(''), null);
  assert.strictEqual(worktreeProblem(undefined), null);
});

// -------------------------------------------------------------- usableWorktree

test('a usable checkout passes the requested name straight through', () => {
  const repo = initRepo(scratch('ds-wt-pass-'), { commit: true });
  assert.strictEqual(usableWorktree(repo, 'github-issue-42'), 'github-issue-42');
});

test('an unusable checkout drops the name and logs the reason once', () => {
  const repo = initRepo(scratch('ds-wt-drop-'));
  const lines = [];
  assert.strictEqual(usableWorktree(repo, 'github-issue-1', { log: (m) => lines.push(m) }), null);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /github-issue-1/);
  assert.match(lines[0], /no commits yet/);
  assert.match(lines[0], /running in the checkout instead/);
});

test('no requested worktree means no git subprocess at all', () => {
  // The common case is a session with no worktree; it must not pay for a git spawn.
  let calls = 0;
  const run = () => { calls++; };
  assert.strictEqual(usableWorktree('/anywhere', null, { run }), null);
  assert.strictEqual(usableWorktree('/anywhere', '', { run }), null);
  assert.strictEqual(calls, 0);
});

// ------------------------------------------------------------ injected-run cases

test('git that cannot be run at all drops the worktree rather than keeping it', () => {
  // The two ways to be wrong are not symmetric. Dropping a worktree that would have
  // worked costs isolation and is recoverable; keeping one that cannot work kills the
  // session on arrival. So an unresolvable git resolves to "drop".
  const run = () => { const e = new Error('git not found'); e.code = 'ENOENT'; throw e; };
  assert.strictEqual(usableWorktree('/anywhere', 'wt', { run }), null);
  assert.strictEqual(worktreeProblem('/anywhere', { run }).code, 'worktree-not-a-repo');
});

test('the probes are argv-only git calls with piped stdio', () => {
  // No shell layer, and stderr captured: "fatal: not a git repository" is an EXPECTED
  // answer on the first probe, and letting it reach the daemon's stderr would put a
  // scary line in the log for the ordinary case.
  const seen = [];
  const run = (bin, argv, opts) => { seen.push({ bin, argv, opts }); };
  worktreeProblem('/some/repo', { run });
  assert.ok(seen.length >= 1);
  for (const call of seen) {
    assert.strictEqual(call.bin, 'git');
    assert.ok(Array.isArray(call.argv), 'argv form, never a command string');
    assert.strictEqual(call.opts.cwd, '/some/repo');
    assert.deepStrictEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(call.opts.timeout > 0, 'a wedged git must not hang the spawn');
  }
  assert.deepStrictEqual(seen[0].argv, ['rev-parse', '--git-dir']);
  assert.deepStrictEqual(seen[1].argv, ['rev-parse', '--verify', '--quiet', 'HEAD']);
});
