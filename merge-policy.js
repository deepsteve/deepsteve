/**
 * Where a repo's work starts from and lands on (#725).
 *
 * GitHub is the truth and the main checkout is a workspace: worktree branches start
 * from `origin/<default branch>` and land on `origin/<target>`, so no session's
 * uncommitted changes can block a merge. That is the default for every repo with an
 * `origin`. A repo opts back into the old shape — branch from the main checkout's HEAD,
 * merge into the main checkout — with
 *
 *     git config deepsteve.merge local
 *
 * The switch is per REPO, not per project, on purpose: one project can group a repo
 * where a push is harmless with one where a push deploys (the built-in Deep Steve
 * project holds deepsteve.com, which goes live on a push to `prime`).
 *
 * Both readers take an injected synchronous git runner, `(argv, cwd) => { ok, stdout }`,
 * so this is testable without a repo and usable from server.js and from mods alike.
 */
const path = require('path');
const { runBinary } = require('./bin-path');

function defaultGit(args, cwd) {
  try {
    const stdout = runBinary('git', args, {
      cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message || '' };
  }
}

/** 'local' when the repo opted out with `git config deepsteve.merge local`, else 'origin'. */
function mergeMode(git, repoRoot) {
  const res = git(['config', '--get', 'deepsteve.merge'], repoRoot);
  return res.ok && res.stdout.trim().toLowerCase() === 'local' ? 'local' : 'origin';
}

/**
 * The ref a new worktree branch should start from, or null for "the checkout's HEAD".
 *
 * Mirrors Claude Code's own `--worktree`, whose branches all record
 * `Created from origin/<default branch>` in their reflog: `origin/HEAD` when the clone
 * has it, else origin's copy of whatever the main checkout has checked out. No fetch —
 * Claude does not fetch either, and every landing fetches and pushes, which keeps the
 * remote-tracking ref current on a single machine.
 */
function worktreeBaseRef(git, repoRoot) {
  if (mergeMode(git, repoRoot) === 'local') return null;
  const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot);
  const candidates = [];
  if (head.ok && head.stdout.trim()) candidates.push(head.stdout.trim());
  const current = git(['branch', '--show-current'], repoRoot);
  if (current.ok && current.stdout.trim()) candidates.push(`refs/remotes/origin/${current.stdout.trim()}`);
  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot).ok) return ref;
  }
  return null;
}

/**
 * argv for `git worktree add`, for agents without a native --worktree flag.
 *
 * The branch keeps the name plain `git worktree add <path>` would give it — the
 * directory's basename — because worktree-status.js reads that spelling to recognise a
 * resumed issue. An existing branch is checked out as it is; only a NEW branch gets the
 * origin base, since re-basing someone's parked work would be destroying it.
 */
function worktreeAddArgs(repoRoot, wtPath, { git = defaultGit } = {}) {
  const base = worktreeBaseRef(git, repoRoot);
  if (!base) return ['worktree', 'add', wtPath];
  const branch = path.basename(wtPath);
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot).ok) {
    return ['worktree', 'add', wtPath, branch];
  }
  return ['worktree', 'add', '-b', branch, wtPath, base];
}

module.exports = { mergeMode, worktreeBaseRef, worktreeAddArgs };
