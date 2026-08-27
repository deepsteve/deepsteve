/**
 * Can this directory host a git worktree? (#656 follow-up)
 *
 * Opening a GitHub issue spawns the agent with `--worktree <name>` so the work is
 * isolated from the main checkout. Against a repo with no commits yet, that flag is
 * not a degraded experience — it is instant death. Claude Code resolves a base
 * branch before it creates anything:
 *
 *     Error creating worktree: Failed to resolve base branch "HEAD": git rev-parse failed
 *
 * ...and exits about a second after spawn, before painting a single frame. The
 * daemon sees a healthy spawn followed by `[shell-gone] reason=exited up=1s`,
 * tombstones the session and tells the browser to close the tab, so the user clicks
 * "open issue", watches a tab appear and vanish, and nothing anywhere says why.
 * Twice in a row is indistinguishable from a crash.
 *
 * A directory that is not a git repository at all dies the same way with a different
 * message ("Can only use --worktree in a git repository"), so both are checked here
 * and both resolve to the same answer: don't pass the flag.
 *
 * The fix is to drop the flag, not to refuse the session. A worktree exists to
 * isolate changes from the rest of a checkout, and a repo with no commits has
 * nothing to isolate from — running directly in the checkout is exactly right.
 * `git worktree add` (the path for agents without native --worktree) agrees in the
 * letter and not the spirit: on an unborn HEAD it silently infers `--orphan` and
 * hands back a branch with no shared history, which merge_worktree could never merge
 * back. Dropping the flag covers both.
 *
 * Checking for an existing worktree first would be wrong, and that is measured, not
 * assumed: Claude resolves the base branch BEFORE it looks at whether
 * .claude/worktrees/<name> is already there, so a pre-existing worktree dies too.
 * The only question that matters is whether HEAD resolves.
 *
 * Why a subprocess here when git-root.js exists precisely to avoid one: this runs
 * ONCE per session spawn, not once per cwd inside a request loop, and the
 * neighbouring ensureWorktree() already shells out to `git worktree add` on the very
 * same path. Reimplementing HEAD resolution on top of fs — packed-refs, symbolic ref
 * chains, detached HEAD — would be a guess about the one thing whose answer has to
 * agree with what the agent itself computes.
 */
const { runBinary } = require('./bin-path');

// Generous relative to a local `git rev-parse` (single-digit ms) but bounded, so a
// wedged git on a network filesystem delays one spawn instead of hanging it.
const GIT_TIMEOUT_MS = 10000;

// stdio is piped, not inherited: git's "fatal: not a git repository" on the
// not-a-repo probe is an EXPECTED answer here, and letting it reach the daemon's
// stderr would put a scary line in the log for the ordinary case.
function gitSucceeds(argv, cwd, run) {
  try {
    run('git', argv, { cwd, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Null when `cwd` can host a worktree, else `{ code, cwd, message }` — the same
 * shape spawnCwdProblem() returns, so callers format both the same way.
 */
function worktreeProblem(cwd, { run = runBinary } = {}) {
  if (!cwd) return null;

  // Ordered so the message names the actual reason: a non-repo fails the HEAD probe
  // too, and reporting it as "no commits yet" would send someone looking for a
  // missing commit in a directory that was never a repository.
  if (!gitSucceeds(['rev-parse', '--git-dir'], cwd, run)) {
    // `git` itself being unresolvable lands here as well. That is deliberate: if we
    // cannot run git we cannot know the answer, and the two ways to be wrong are not
    // symmetric. Dropping a worktree that would have worked costs isolation and is
    // recoverable; keeping one that cannot work kills the session on arrival.
    return {
      code: 'worktree-not-a-repo',
      cwd,
      message: `${cwd} is not a git repository, so it cannot host a worktree`,
    };
  }

  if (!gitSucceeds(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, run)) {
    return {
      code: 'worktree-no-commits',
      cwd,
      message: `${cwd} has no commits yet, so there is no base branch to create a worktree from`,
    };
  }

  return null;
}

/**
 * The worktree name a spawn should actually use: `requested`, or null when this
 * checkout cannot host one. Every new-session spawn path routes its worktree
 * through here, so what gets recorded on the session entry is what the agent was
 * really given — the same reason spawnSession's return value, not the requested
 * engine, is what sets engineType.
 *
 * Deliberately NOT applied on the restore path. A restored session's worktree is
 * part of its identity (claudeProjectDir() derives the transcript directory from
 * it), so silently dropping it on resume would point the session at a different
 * conversation — a worse failure than the one this module prevents.
 */
function usableWorktree(cwd, requested, { run = runBinary, log = () => {} } = {}) {
  if (!requested) return null;
  const problem = worktreeProblem(cwd, { run });
  if (!problem) return requested;
  log(`[worktree] dropping "${requested}" — ${problem.message}; running in the checkout instead`);
  return null;
}

module.exports = { worktreeProblem, usableWorktree };
