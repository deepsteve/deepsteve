/**
 * Server-side worktree merge (#617).
 *
 * Claude Code 2.1.222 turns on a worktree-isolation guard that statically parses
 * every Bash command in a worktree-isolated session and refuses any that cannot be
 * proven to stay inside the worktree — specifically `git -C <shared checkout>`,
 * `cd <shared checkout> && git …`, and any command naming git more than once. That
 * is precisely the shape `/deepsteve:merge` was built on, so the skill could no
 * longer merge a worktree branch into the main checkout at all.
 *
 * The guard applies to the agent's Bash tool, not to the deepsteve daemon, so the
 * merge runs here instead. Nothing about the merge semantics changed — this is the
 * same sequence skills/merge.md used to run, moved across the process boundary.
 *
 * The git runner is injected so the decision logic is unit-testable without a repo.
 */

// Branch names reach git as argv, never through a shell, so injection isn't the
// risk — argument smuggling is (`--upload-pack=…`). Anchoring on an alphanumeric
// rejects every leading-dash form, matching validateWorktree/validateModel.
function validateBranch(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(v)) return null;
  return v;
}

// `git worktree list --porcelain` emits stanzas of `worktree <path>` / `HEAD <sha>`
// / `branch refs/heads/<name>`. Find the checkout holding `target`.
function findWorktreeFor(porcelain, target) {
  let current = null;
  for (const line of String(porcelain).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${target}`) {
      return current;
    }
  }
  return null;
}

/**
 * Resolve the target branch and merge directory, then merge.
 *
 * @param {(args: string[], cwd: string) => {ok: boolean, stdout: string, stderr: string}} git
 * @returns {{status: string, ...}} status is one of:
 *   merged | conflict | failed | target-dirty | target-not-checked-out |
 *   no-such-branch | same-branch | no-target | detached | error
 */
function mergeWorktree({ git, worktreeCwd, repoRoot, target }) {
  const head = git(['branch', '--show-current'], worktreeCwd);
  if (!head.ok) {
    return { status: 'error', message: `Could not read the current branch in ${worktreeCwd}: ${head.stderr.trim()}` };
  }
  const branch = head.stdout.trim();
  if (!branch) {
    return { status: 'detached', message: `${worktreeCwd} is on a detached HEAD — there is no branch to merge.` };
  }

  const detected = git(['branch', '--show-current'], repoRoot);
  const detectedTarget = detected.ok ? detected.stdout.trim() : '';

  const requested = target == null ? '' : String(target).trim();
  const resolvedTarget = requested || detectedTarget;
  if (!resolvedTarget) {
    return {
      status: 'no-target',
      message: `No target branch given and the main checkout (${repoRoot}) is on a detached HEAD, so one can't be inferred. Pass \`target\` explicitly.`,
    };
  }
  const safeTarget = validateBranch(resolvedTarget);
  if (!safeTarget) {
    return { status: 'error', message: `"${resolvedTarget}" is not a valid branch name.` };
  }
  const safeBranch = validateBranch(branch);
  if (!safeBranch) {
    return { status: 'error', message: `"${branch}" is not a valid branch name.` };
  }
  if (safeTarget === safeBranch) {
    return { status: 'same-branch', branch: safeBranch, target: safeTarget, message: `Already on "${safeBranch}" — there is nothing to merge.` };
  }

  // Merges always run from the checkout that has the target checked out.
  let mergeDir;
  if (safeTarget === detectedTarget) {
    mergeDir = repoRoot;
  } else {
    const list = git(['worktree', 'list', '--porcelain'], repoRoot);
    mergeDir = list.ok ? findWorktreeFor(list.stdout, safeTarget) : null;
    if (!mergeDir) {
      const exists = git(['rev-parse', '--verify', safeTarget], repoRoot);
      if (!exists.ok) {
        return { status: 'no-such-branch', target: safeTarget, message: `Branch "${safeTarget}" was not found.` };
      }
      return {
        status: 'target-not-checked-out',
        target: safeTarget,
        repoRoot,
        message: `Branch "${safeTarget}" exists but isn't checked out in any worktree. Check it out in ${repoRoot} first, then retry.`,
      };
    }
  }

  // The target checkout must be clean: git aborts the merge pre-flight on dirty
  // paths, and that WIP is separate work we must never commit, stash or rebase.
  const status = git(['status', '--porcelain'], mergeDir);
  if (!status.ok) {
    return { status: 'error', message: `Could not read git status in ${mergeDir}: ${status.stderr.trim()}` };
  }
  // Split before trimming: porcelain status codes are column-significant (" M" is
  // modified-unstaged, "M " staged), so trimming the blob corrupts the first entry.
  const dirtyLines = status.stdout.split('\n').filter((l) => l.trim() !== '');
  if (dirtyLines.length) {
    return {
      status: 'target-dirty',
      branch: safeBranch,
      target: safeTarget,
      mergeDir,
      changes: dirtyLines.slice(0, 20),
      message: `The target checkout ${mergeDir} has uncommitted changes. Commit or stash them in that checkout, then retry.`,
    };
  }

  const merge = git(['merge', safeBranch, '--no-edit'], mergeDir);
  const output = `${merge.stdout}${merge.stderr}`.trim();
  if (merge.ok) {
    return { status: 'merged', branch: safeBranch, target: safeTarget, mergeDir, output };
  }

  // Only a merge that actually started leaves MERGE_HEAD; a pre-flight refusal
  // (dirty target) does not, and must not be --abort'ed or rebased.
  const started = git(['rev-parse', '--verify', 'MERGE_HEAD'], mergeDir).ok;
  if (started) {
    git(['merge', '--abort'], mergeDir);
    return {
      status: 'conflict',
      branch: safeBranch,
      target: safeTarget,
      mergeDir,
      output,
      message: `Merging "${safeBranch}" into "${safeTarget}" conflicted; the merge was aborted so ${safeTarget} is unchanged.`,
    };
  }
  return { status: 'failed', branch: safeBranch, target: safeTarget, mergeDir, output };
}

module.exports = { mergeWorktree, findWorktreeFor, validateBranch };
