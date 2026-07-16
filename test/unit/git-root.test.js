// Equivalence test for findGitRoot() in git-root.js (#553).
//
// findGitRoot replaced `execSync("zsh -l -c 'git rev-parse --show-toplevel'")`, which
// blocked the shared Express/WS event loop once per session cwd (20 cwds ≈ 1.04s, and
// WS upgrades stall for the duration — that IS the #553 hang). The pure-fs walk is only
// a safe swap if it agrees with git everywhere, so this test asserts that directly by
// running real `git rev-parse` and diffing, rather than hard-coding expectations.
//
// Run: node --test test/unit/git-root.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { findGitRoot } = require('../../git-root.js');

// What git itself says, or null when the dir isn't in a repo. This is the oracle.
function gitSays(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- fixtures

// A throwaway repo tree covering the shapes DeepSteve actually resolves. Built under
// realpath(tmpdir) because macOS /tmp is itself a symlink to /private/tmp — leaving it
// unresolved would make every comparison a symlink test by accident.
function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-gitroot-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });

  // A linked worktree: its .git is a FILE, not a directory. This is the
  // .claude/worktrees/<name> shape, and the case an isDirectory() check would miss.
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit',
    '-q', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  const wt = path.join(root, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wtbranch', wt], { cwd: repo, stdio: 'ignore' });

  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);

  const link = path.join(root, 'link-to-repo-sub');
  fs.symlinkSync(path.join(repo, 'a', 'b'), link);

  return { root, repo, wt, plain, link };
}

// --------------------------------------------------------------- tests

test('findGitRoot agrees with `git rev-parse --show-toplevel`', (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const cases = {
    'repo root': fx.repo,
    'nested subdir': path.join(fx.repo, 'a', 'b'),
    'linked worktree (.git is a file)': fx.wt,
    'subdir of a non-git dir': fx.plain,
    'symlink into the repo': fx.link,
  };

  for (const [label, dir] of Object.entries(cases)) {
    assert.strictEqual(findGitRoot(dir), gitSays(dir), `${label}: ${dir}`);
  }
});

test('linked worktree has a .git FILE — guards the existsSync-not-isDirectory choice', (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // If this ever becomes a directory, the fixture stopped covering the worktree case.
  assert.ok(fs.statSync(path.join(fx.wt, '.git')).isFile(), '.git should be a file in a worktree');
  assert.strictEqual(findGitRoot(fx.wt), fx.wt);
});

test('returns null outside a repo and for nonexistent paths', (t) => {
  const fx = makeFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  assert.strictEqual(findGitRoot(fx.plain), null);
  assert.strictEqual(findGitRoot(path.join(fx.root, 'does-not-exist')), null);
  assert.strictEqual(findGitRoot(''), null);
  assert.strictEqual(findGitRoot(null), null);
});

test('walk terminates at the filesystem root', () => {
  // The loop's exit condition is path.dirname(d) === d. If that ever regresses this
  // hangs forever rather than failing, so assert it explicitly.
  assert.strictEqual(findGitRoot('/'), gitSays('/'));
});

test('expands ~ the way the old inline callers did', () => {
  const { expandTilde } = require('../../git-root.js');
  assert.strictEqual(expandTilde('~'), os.homedir());
  assert.strictEqual(expandTilde('~/x'), path.join(os.homedir(), 'x'));
  assert.strictEqual(expandTilde('/abs'), '/abs');
});

test('is fast enough not to block the event loop (the whole point of #553)', () => {
  const fx = makeFixture();
  try {
    const dirs = [fx.repo, path.join(fx.repo, 'a', 'b'), fx.wt, fx.plain];
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 40; i++) findGitRoot(dirs[i % dirs.length]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // The execSync version took ~2000ms for 40 lookups. Anything near that is a
    // regression to shelling out; 100ms is a loose ceiling that won't flake on CI.
    assert.ok(ms < 100, `40 lookups took ${ms.toFixed(1)}ms — did this start shelling out again?`);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
