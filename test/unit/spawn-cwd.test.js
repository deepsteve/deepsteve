// #632 — a session's spawn cwd must exist, and the refusal must NAME the path.
//
// Pure fs/path/os, no daemon, no shell, no engines/node-pty — so this runs in the
// bare `unit` CI job (which installs with --ignore-scripts and has no native
// binding, and no tmux either).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnCwdProblem, assertSpawnCwd } = require('../../paths');

const REPO = path.join(__dirname, '..', '..');

// A path that is guaranteed not to exist, without creating and removing anything.
function missingPath() {
  return path.join(os.tmpdir(), `ds-632-gone-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

describe('spawnCwdProblem', () => {
  test('a real directory is fine', () => {
    assert.strictEqual(spawnCwdProblem(os.tmpdir()), null);
    assert.strictEqual(spawnCwdProblem(__dirname), null);
    assert.strictEqual(spawnCwdProblem(REPO), null);
  });

  test('a missing directory is refused AND the message names the path', () => {
    // This assertion is the issue itself: the old behaviour was to relocate to
    // $HOME saying nothing at all, so "names the path" is the whole deliverable.
    const gone = missingPath();
    const problem = spawnCwdProblem(gone);
    assert.ok(problem, 'a missing directory must be refused');
    assert.strictEqual(problem.code, 'cwd-missing');
    assert.strictEqual(problem.cwd, gone);
    assert.ok(problem.message.includes(gone),
      `the refusal must name the missing path, got: ${problem.message}`);
  });

  test('a directory that was deleted after being used is refused', () => {
    // The reported shape: a worktree/repo that existed when the session was saved.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-632-'));
    assert.strictEqual(spawnCwdProblem(dir), null, 'exists → usable');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(spawnCwdProblem(dir).code, 'cwd-missing', 'removed → refused');
  });

  test('a regular file is refused as not-a-directory', () => {
    const problem = spawnCwdProblem(__filename);
    assert.strictEqual(problem.code, 'cwd-not-a-directory');
    assert.ok(problem.message.includes(__filename));
  });

  test('a path whose PARENT is a file (ENOTDIR) is refused, not crashed', () => {
    const problem = spawnCwdProblem(path.join(__filename, 'nope'));
    assert.ok(problem, 'ENOTDIR must be refused');
    assert.strictEqual(problem.cwd, path.join(__filename, 'nope'));
    // ENOTDIR is not ENOENT, so it takes the generic arm — still refused, still named.
    assert.ok(problem.message.includes('nope'));
  });

  test('falsy cwd is allowed through — records with no cwd must stay restorable', () => {
    // Load-bearing, not defensive. serializeShellEntry writes `cwd` unconditionally,
    // so a saved record can carry undefined; that inherits the daemon's cwd today and
    // must keep doing so. Only a *specified* missing path is refused.
    for (const falsy of ['', null, undefined, 0, false]) {
      assert.strictEqual(spawnCwdProblem(falsy), null, `${JSON.stringify(falsy)} must pass through`);
    }
  });
});

describe('assertSpawnCwd', () => {
  test('returns quietly for a usable directory', () => {
    assert.doesNotThrow(() => assertSpawnCwd(os.tmpdir()));
    assert.doesNotThrow(() => assertSpawnCwd(null));
  });

  test('throws an Error carrying code + cwd, so callers can forward them', () => {
    const gone = missingPath();
    assert.throws(() => assertSpawnCwd(gone), (err) => {
      assert.ok(err instanceof Error);
      assert.strictEqual(err.code, 'cwd-missing');
      assert.strictEqual(err.cwd, gone);
      assert.ok(err.message.includes(gone));
      return true;
    });
  });
});

describe('the enforcement-point invariant', () => {
  test('spawnSession validates the cwd ABOVE its tmux→node-pty try/catch', () => {
    // Pure statement order, and it silently rots if nobody pins it: move the check
    // inside the try and a missing directory becomes "tmux failed, degrade to
    // node-pty" — whose child _exit(1)s after pty.spawn() has already returned. That
    // is the silent-vanish half of #632, re-implemented with extra steps, and every
    // other test in the tree would still pass.
    const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    const fn = src.indexOf('function spawnSession(');
    assert.ok(fn !== -1, 'found spawnSession');
    const check = src.indexOf('assertSpawnCwd(cwd)', fn);
    const spawn = src.indexOf('eng.spawn(id, LOGIN_SHELL.path', fn);
    assert.ok(check !== -1, 'spawnSession must call assertSpawnCwd(cwd) (#632)');
    assert.ok(spawn !== -1, 'found the engine spawn call');
    assert.ok(check < spawn,
      'assertSpawnCwd(cwd) must run above spawnSession\'s try/catch — inside it, a missing '
      + 'directory would degrade to node-pty and vanish silently instead of being refused (#632)');
  });
});
