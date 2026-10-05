/**
 * Land a worktree branch on origin, not in the main checkout (#725).
 *
 * The main checkout is two things at once: the place local `main` is checked out, so
 * the only place a `git merge` into it can run, and the workspace of every session
 * opened without a worktree. A workspace is rarely clean and a merge target has to be,
 * so mergeWorktree's dirty-target guard refused about one merge in eight, and a worker
 * whose work was finished sat blocked until someone happened to commit.
 *
 * Git hit this long ago: it refuses a push into a branch checked out in someone's
 * working tree (`receive.denyCurrentBranch`), which is why shared repos are bare. Every
 * repo here already has one — `origin` — and Claude Code already starts every worktree
 * from it (`Created from origin/main` in each branch's reflog). Only the landing went
 * somewhere else. So it doesn't any more:
 *
 *   1. fetch `origin/<target>`
 *   2. compute the merge in memory — a fast-forward when origin is an ancestor of the
 *      branch, else `git merge-tree --write-tree` + `git commit-tree` with origin as
 *      the first parent, so `main`'s first-parent history reads exactly as the local
 *      merge's did. No working tree is touched, so there is nothing to be dirty, and a
 *      conflict is detected without a merge ever starting — there is nothing to abort.
 *   3. push `<sha>:refs/heads/<target>`. A non-fast-forward rejection means another
 *      landing won the race: fetch and recompute.
 *   4. catch the checkout holding `<target>` up — only when it is clean, aborting on
 *      conflict, never stashing. Dirty is fine: its sessions pick the work up on their
 *      next pull, as any clone would.
 *
 * Today's local merge stays the floor. A repo that opted out (`git config
 * deepsteve.merge local`, see merge-policy.js), has no origin, or doesn't have the
 * target on origin goes straight to mergeWorktree; so does a fetch that fails, or a
 * push refused for any reason but the race (branch protection, auth). The result says
 * which (`originFallback`), so a repo that always falls back is visible in the log.
 *
 * Statuses are mergeWorktree's, unchanged in meaning — callers and the merge-block
 * state need no new vocabulary. Every result from here carries `via: 'origin' | 'local'`.
 */
const { execFile } = require('child_process');
const { mergeWorktree, resolveMergeBranches, checkoutHolding } = require('./merge-worktree');
const { mergeMode } = require('../../merge-policy');

const MAX_PUSH_ATTEMPTS = 3;
const OID_RE = /^[0-9a-f]{40,64}$/;

/**
 * git for the two network steps, fetch and push. Async where runGit is sync: those go to
 * github.com, and blocking the shared Express/ws event loop on a network round trip is
 * what #553 took out of this daemon. Never rejects — a failed push is an answer.
 * GIT_TERMINAL_PROMPT=0 so a missing credential fails at once instead of waiting on a
 * terminal the daemon does not have.
 */
function runGitNet(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, stdout: stdout || '', stderr: stderr || err.message || '' });
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0] || '';
}

// git's own default subject, so a landing reads in `git log` like the merge it replaces.
function mergeSubject(branch, target) {
  return target === 'main' || target === 'master'
    ? `Merge branch '${branch}'`
    : `Merge branch '${branch}' into ${target}`;
}

function revParse(git, ref, cwd) {
  const res = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return res.ok ? res.stdout.trim() : null;
}

function isAncestor(git, a, b, cwd) {
  return git(['merge-base', '--is-ancestor', a, b], cwd).ok;
}

// `git push --porcelain` marks a refused ref with a leading `!`; the race is the one
// refusal worth retrying.
function isPushRace(out) {
  return /\[rejected\]\s+\((non-fast-forward|fetch first)\)/.test(out);
}

function pushRefusal(push) {
  const out = `${push.stdout}\n${push.stderr}`;
  const refused = out.split('\n').find((l) => l.startsWith('!'));
  return refused ? refused.split('\t').pop().trim() : firstLine(push.stderr);
}

/**
 * Bring the checkout that has `target` checked out up to origin, if that is safe.
 * Returns { status: synced | dirty | conflict | failed | not-checked-out | error, ... }.
 */
function catchUp({ git, repoRoot, target, detectedTarget }) {
  const dir = checkoutHolding({ git, repoRoot, target, detectedTarget });
  if (!dir) return { status: 'not-checked-out' };
  const status = git(['status', '--porcelain'], dir);
  if (!status.ok) {
    return { status: 'error', mergeDir: dir, message: `Could not read git status in ${dir}: ${firstLine(status.stderr)}` };
  }
  if (status.stdout.split('\n').some((l) => l.trim() !== '')) {
    return {
      status: 'dirty', mergeDir: dir,
      message: `${dir} has uncommitted changes, so it was left as it is; it picks this up on its next pull.`,
    };
  }
  const merge = git(['merge', '--no-edit', `origin/${target}`], dir);
  const output = `${merge.stdout}${merge.stderr}`.trim();
  if (merge.ok) return { status: 'synced', mergeDir: dir, output };
  if (git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir).ok) {
    git(['merge', '--abort'], dir);
    return {
      status: 'conflict', mergeDir: dir, output,
      message: `${dir} has commits of its own that conflict with origin/${target}; it was left as it is, to be reconciled on its next pull.`,
    };
  }
  return { status: 'failed', mergeDir: dir, output };
}

/**
 * Land the worktree branch on origin, falling back to mergeWorktree.
 *
 * @param {Function} git     sync runner, as mergeWorktree takes
 * @param {Function} gitNet  async runner for fetch/push; omitted → local merge only
 */
async function landWorktree({ git, gitNet, worktreeCwd, repoRoot, target }) {
  const args = { git, worktreeCwd, repoRoot, target };
  if (!gitNet) return mergeWorktree(args);
  const local = (reason) => ({ ...mergeWorktree(args), via: 'local', originFallback: reason });

  if (mergeMode(git, repoRoot) === 'local') return local('opted-out');

  const resolved = resolveMergeBranches(args);
  if (!resolved.ok) return resolved.result;
  const { branch, target: tgt, detectedTarget } = resolved;

  if (!git(['remote', 'get-url', 'origin'], repoRoot).ok) return local('no-origin-remote');

  let lastOutput = '';
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const fetch = await gitNet(['fetch', '--quiet', 'origin', tgt], repoRoot);
    if (!fetch.ok) {
      return local(/couldn't find remote ref/i.test(fetch.stderr)
        ? 'target-not-on-origin'
        : `fetch-failed: ${firstLine(fetch.stderr)}`);
    }
    const originSha = revParse(git, `refs/remotes/origin/${tgt}`, repoRoot);
    if (!originSha) return local('target-not-on-origin');
    const branchSha = revParse(git, `refs/heads/${branch}`, repoRoot);
    if (!branchSha) {
      return { status: 'error', via: 'origin', branch, target: tgt, message: `Could not resolve branch "${branch}".` };
    }

    let sha;
    let kind;
    if (isAncestor(git, branchSha, originSha, repoRoot)) {
      kind = 'up-to-date';
      sha = null;
    } else if (isAncestor(git, originSha, branchSha, repoRoot)) {
      kind = 'fast-forward';
      sha = branchSha;
    } else {
      // Exit 0 is clean; exit 1 is conflicts, with the tree still on line one and the
      // conflicted paths after it up to the first blank line. Anything without a tree
      // on line one is a git that cannot do this (pre-2.38) — fall back, don't guess.
      const mt = git(['merge-tree', '--write-tree', '--name-only', originSha, branchSha], repoRoot);
      const lines = String(mt.stdout).split('\n');
      const tree = (lines[0] || '').trim();
      if (!OID_RE.test(tree)) return local(`merge-tree-unavailable: ${firstLine(mt.stderr)}`);
      if (!mt.ok) {
        const conflicts = [];
        for (const l of lines.slice(1)) {
          if (!l.trim()) break;
          conflicts.push(l.trim());
        }
        return {
          status: 'conflict', via: 'origin', branch, target: tgt, conflicts,
          rebaseOnto: `origin/${tgt}`,
          output: lines.slice(1).join('\n').trim(),
          message: `Merging "${branch}" into origin/${tgt} conflicts in ${conflicts.length} file(s). `
            + `Nothing was pushed, so ${tgt} is unchanged. Rebase the branch onto origin/${tgt}, resolve, and merge again.`,
        };
      }
      const commit = git(['commit-tree', tree, '-p', originSha, '-p', branchSha, '-m', mergeSubject(branch, tgt)], repoRoot);
      if (!commit.ok) {
        return {
          status: 'error', via: 'origin', branch, target: tgt,
          message: `Could not write the merge commit: ${firstLine(commit.stderr)}`,
        };
      }
      kind = 'merge';
      sha = commit.stdout.trim();
    }

    if (sha) {
      const push = await gitNet(['push', '--porcelain', 'origin', `${sha}:refs/heads/${tgt}`], repoRoot);
      lastOutput = `${push.stdout}${push.stderr}`.trim();
      if (!push.ok) {
        if (isPushRace(lastOutput)) continue;   // another landing won; fetch and recompute
        return local(`push-refused: ${pushRefusal(push)}`);
      }
    }

    const localSync = catchUp({ git, repoRoot, target: tgt, detectedTarget });
    const where = localSync.status === 'synced' ? ` and ${localSync.mergeDir} is caught up`
      : localSync.message ? `. ${localSync.message}` : '';
    return {
      status: 'merged', via: 'origin', kind, branch, target: tgt,
      pushed: sha, output: kind === 'up-to-date' ? 'Already up to date.' : lastOutput,
      localSync,
      message: (kind === 'up-to-date'
        ? `origin/${tgt} already contains "${branch}"`
        : `Landed "${branch}" on origin/${tgt} (${kind})`) + where,
    };
  }
  return {
    status: 'failed', via: 'origin', branch, target: tgt, output: lastOutput,
    message: `origin/${tgt} moved under every one of ${MAX_PUSH_ATTEMPTS} attempts to land "${branch}". Nothing was lost; merge again.`,
  };
}

/** A log-line suffix: where a landing went, and why it fell back if it did. */
function describeLanding(result) {
  if (!result || !result.via) return '';
  if (result.via === 'origin') {
    return ` via origin${result.localSync ? ` (local ${result.localSync.status})` : ''}`;
  }
  return ` via local${result.originFallback ? ` (${result.originFallback})` : ''}`;
}

module.exports = { landWorktree, runGitNet, describeLanding, mergeSubject, isPushRace };
