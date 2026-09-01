/**
 * The mechanical half of finishing a worktree (#688).
 *
 * `/deepsteve:merge` was ten assistant turns — get_my_session_id, get_session_info,
 * `branch --show-current`, `status --porcelain`, `gh issue view`, `add -A`, `commit`,
 * merge_worktree, `gh issue close`, report+close — and a skill runs inside the CURRENT
 * conversation, so every one of those turns replayed a 100k+ token context at the point
 * in a session where it is largest. That is where 13% of a day's usage went. The file
 * was never the cost; the turns were.
 *
 * None of those facts needed a model. The daemon already knows the branch, the dirty
 * state, the target checkout, the issue number and the commit subject, and it can read
 * all of them without asking anyone. So this module does, and the model is left with the
 * one part that is genuinely a judgement call: resolving a merge conflict.
 *
 * ── What this is NOT ──
 *
 * It is not a replacement for `mergeWorktree`, which stays a general primitive with its
 * own callers and its own tests; this composes ON TOP of it and passes its statuses
 * through byte-for-byte, so `conflict` / `target-dirty` / `target-not-checked-out` /
 * `no-such-branch` / `detached` / `same-branch` mean exactly here what they have always
 * meant to the skill reading them.
 *
 * And it never closes a session, never arms an auto-close, and never touches a shell
 * entry. That is deliberate: there are four callers and they disagree about the ending —
 * an agent has to be TOLD to stop and reliably isn't (so the two MCP paths arm the #627
 * deferred close), while a human clicking Merge is already looking at the tab with Close
 * one key away (so the two REST paths arm nothing). Keeping the decision at the call site
 * is what stops that difference from being an accident.
 *
 * Both runners are injected — `git` synchronous the way `runGit` is, `gh` asynchronous
 * because it goes to the network and a 15s block of the event loop is the thing #553
 * removed from this daemon. That keeps the whole routine testable with no repo, no `gh`
 * on PATH and no daemon, which matters: the CI unit job has none of the three.
 */

const { mergeWorktree } = require('./merge-worktree');

// A branch this daemon opened for a GitHub issue. Matched on the BRANCH rather than on
// `entry.worktree` because the branch is what git reports and what skills/merge.md has
// always keyed on — a session whose worktree was renamed, or whose agent switched
// branches inside it, should follow the branch it is actually about to merge.
const ISSUE_BRANCH_RE = /github-issue-(\d+)/;

function issueNumberFromBranch(branch) {
  const m = ISSUE_BRANCH_RE.exec(String(branch || ''));
  return m ? Number(m[1]) : null;
}

/**
 * The commit subject, derived exactly as skills/merge.md step 3 derived it.
 *
 * The issue title is fetched live rather than taken from the session's spawn-time copy:
 * a title edited while the work was in progress is the one the commit should carry, and
 * the tab name is clipped to maxIssueTitleLength so it is not a source for this.
 *
 * No `Co-Authored-By` trailer, deliberately — a merge commit the daemon writes on its own
 * has no co-author.
 */
async function deriveCommitSubject({ gh, cwd, branch, target, issueNumber }) {
  if (issueNumber != null) {
    const res = await gh(['issue', 'view', String(issueNumber), '--json', 'title', '-q', '.title'], cwd);
    const title = res && !res.error ? String(res.stdout || '').trim() : '';
    // A one-line title only. `-q .title` cannot emit more, but a `gh` that printed a
    // warning first would otherwise put a stray line into the subject.
    const firstLine = title.split('\n')[0].trim();
    if (firstLine) return `${firstLine} (#${issueNumber})`;
  }
  return target ? `Merge ${branch} into ${target}` : `Merge ${branch}`;
}

/**
 * Commit whatever is uncommitted, then merge, then close the issue.
 *
 * @param {(args: string[], cwd: string) => {ok: boolean, stdout: string, stderr: string}} git
 * @param {(argv: string[], cwd: string) => Promise<{stdout?: string, error?: string}>} gh
 * @param {string}  cwd         the session's actual working directory (the worktree, for a worktree session)
 * @param {string}  repoRoot    the main checkout
 * @param {boolean} isWorktree  false takes the commit-and-push path and never merges
 * @param {string=} target      branch to merge into; defaults to whatever repoRoot has checked out
 * @param {string=} subject     overrides the derived commit subject
 * @param {string=} body        second `-m` on the commit
 *
 * @returns {Promise<object>} `status` is a mergeWorktree status, or one of the three this
 *   routine adds ahead of it: `commit-failed`, `pushed`, `push-failed`. Every result also
 *   carries `committed` (did we write a commit), `subject` (what it said, or would have)
 *   and `issue` (`null`, or `{ number, closed, error? }`).
 */
async function mergeSession({ git, gh, cwd, repoRoot, isWorktree, target, subject, body }) {
  const head = git(['branch', '--show-current'], cwd);
  if (!head.ok) {
    return { status: 'error', message: `Could not read the current branch in ${cwd}: ${head.stderr.trim()}` };
  }
  const branch = head.stdout.trim();
  if (!branch) {
    return { status: 'detached', message: `${cwd} is on a detached HEAD — there is no branch to merge.` };
  }

  const issueNumber = issueNumberFromBranch(branch);
  const requested = target == null ? '' : String(target).trim();

  // Resolved BEFORE the commit, because the fallback subject names it. Only on the
  // worktree path: in the main checkout the "target" would be the branch we are already
  // on, and `Merge main into main` is a worse subject than `Merge main`.
  let resolvedTarget = requested;
  if (!resolvedTarget && isWorktree) {
    const detected = git(['branch', '--show-current'], repoRoot);
    resolvedTarget = detected.ok ? detected.stdout.trim() : '';
  }

  // Checked BEFORE the commit, which is the order skills/merge.md used: its step 2 said
  // "if target equals branch there is nothing to merge — STOP", and its auto-commit was
  // step 5. Committing work and only then reporting that it has nowhere to go would
  // leave a commit nobody asked for on a branch nobody was merging. Every OTHER refusal
  // is still checked after the commit, deliberately — a conflict needs the work
  // committed before it can be rebased.
  //
  // Safe to compare before mergeWorktree's validateBranch runs: `branch` came from git
  // itself, so a `target` equal to it is equally valid.
  if (isWorktree && resolvedTarget && resolvedTarget === branch) {
    return {
      status: 'same-branch', branch, target: resolvedTarget, committed: false, subject: null,
      issue: issueNumber == null ? null : { number: issueNumber, closed: false },
      message: `Already on "${branch}" — there is nothing to merge.`,
    };
  }

  // Split before trimming — porcelain status codes are column-significant, the same
  // reason mergeWorktree's dirty-target guard does it this way.
  const status = git(['status', '--porcelain'], cwd);
  if (!status.ok) {
    return { status: 'error', branch, subject: null, message: `Could not read git status in ${cwd}: ${status.stderr.trim()}` };
  }
  const dirty = status.stdout.split('\n').filter((l) => l.trim() !== '').length > 0;

  // Derived only when there is actually something to commit. An agent that committed its
  // own work — the common case on the Autopilot path — should not pay a round trip to
  // github.com for a subject no commit will carry. `subject` is therefore null on a
  // clean merge, which is the honest answer: nothing was written.
  const explicitSubject = typeof subject === 'string' && subject.trim() ? subject.trim() : '';
  const commitSubject = !dirty ? null
    : (explicitSubject || await deriveCommitSubject({ gh, cwd, branch, target: resolvedTarget, issueNumber }));

  let committed = false;
  if (dirty) {
    const add = git(['add', '-A'], cwd);
    if (!add.ok) {
      return {
        status: 'commit-failed', branch, subject: commitSubject, committed: false, issue: null,
        output: `${add.stdout}${add.stderr}`.trim(),
        message: `Could not stage the changes in ${cwd}.`,
      };
    }
    const args = ['commit', '-m', commitSubject];
    if (typeof body === 'string' && body.trim()) args.push('-m', body.trim());
    const commit = git(args, cwd);
    if (!commit.ok) {
      return {
        status: 'commit-failed', branch, subject: commitSubject, committed: false, issue: null,
        output: `${commit.stdout}${commit.stderr}`.trim(),
        message: `Could not commit the changes in ${cwd}.`,
      };
    }
    committed = true;
  }

  // Not a worktree session: we are already on the branch in the main checkout, so there
  // is nothing to merge INTO. Push and stop — and in particular do not close the issue,
  // because nothing has landed on a target yet. skills/merge.md step 4, moved here.
  if (!isWorktree) {
    const push = git(['push'], cwd);
    return {
      status: push.ok ? 'pushed' : 'push-failed',
      branch, subject: commitSubject, committed,
      issue: issueNumber == null ? null : { number: issueNumber, closed: false },
      output: `${push.stdout}${push.stderr}`.trim(),
      ...(push.ok ? {} : { message: `Committed in ${cwd}, but the push failed.` }),
    };
  }

  const result = mergeWorktree({ git, worktreeCwd: cwd, repoRoot, target });

  // Only a merge that actually landed may close an issue. Every other status left the
  // target untouched, so the work the issue describes is not in it.
  let issue = issueNumber == null ? null : { number: issueNumber, closed: false };
  if (result.status === 'merged' && issueNumber != null) {
    const closed = await gh(
      ['issue', 'close', String(issueNumber), '--comment', `Merged into ${result.target}.`], cwd);
    issue = closed && !closed.error
      ? { number: issueNumber, closed: true }
      : { number: issueNumber, closed: false, error: (closed && closed.error) || 'gh-failed' };
  }

  return { ...result, committed, subject: commitSubject, issue };
}

module.exports = { mergeSession, deriveCommitSubject, issueNumberFromBranch };
