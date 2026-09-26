/**
 * "Who is being a hog" — the contention answer, as a pure module.
 *
 * A worktree agent that cannot merge is blocked ON SOMETHING, and on this machine the
 * something is nearly always another agent (or a person) holding the shared checkout
 * dirty. The daemon already knows who that is: it has every live session's cwd. So it
 * answers, rather than leaving a blocked agent to guess in prose — which is the whole
 * difference between "I think #684 might be editing main?" and a row that names the tab
 * and puts a key under it.
 *
 * No ctx, no fs, no git, no shells map. The caller supplies the target root and a plain
 * session list, so node:test can drive every rule here with no daemon and no repo — the
 * ./backlog.js and ./inbox.js split, and the same reason.
 */

/**
 * Why a merge did not merge, in the user's terms.
 *
 * Keyed on the statuses mergeWorktree and mergeSession actually return; see
 * mods/deepsteve-core/merge-worktree.js. `holders` says whether naming who is holding
 * the checkout is meaningful for that status — it is only ever meaningful for the two
 * that are ABOUT the target checkout, and a "conflict" row that helpfully listed three
 * innocent sessions would be worse than one that said nothing.
 */
const MERGE_BLOCK = {
  'target-dirty': {
    label: 'Target checkout is dirty',
    hint: 'The shared checkout has uncommitted changes, so the merge was refused and nothing was touched.',
    holders: true,
  },
  'target-not-checked-out': {
    label: 'Target branch is not checked out',
    hint: 'The shared checkout is on a different branch than the merge target.',
    holders: true,
  },
  conflict: {
    label: 'Merge conflict',
    hint: 'The merge was aborted and the target checkout was left exactly as it was. Somebody has to resolve it.',
    holders: false,
  },
  failed: {
    label: 'Merge failed',
    hint: 'git refused the merge. The target checkout was left untouched.',
    holders: false,
  },
  'commit-failed': {
    label: 'Could not commit the worktree',
    hint: 'The worktree had uncommitted work and committing it failed, so nothing was merged.',
    holders: false,
  },
  'push-failed': {
    label: 'Push failed',
    hint: 'The work was committed but could not be pushed.',
    holders: false,
  },
  'no-such-branch': {
    label: 'Target branch not found',
    hint: 'The branch this session was told to merge into does not exist.',
    holders: false,
  },
  detached: {
    label: 'Detached HEAD',
    hint: 'The worktree is not on a branch, so there is nothing to merge.',
    holders: false,
  },
  'same-branch': {
    label: 'Already on the target branch',
    hint: 'There is nothing to merge — the worktree and the target are the same branch.',
    holders: false,
  },
  'no-target': {
    label: 'No target branch',
    hint: 'The target checkout has no branch to merge into.',
    holders: false,
  },
  error: {
    label: 'Merge errored',
    hint: 'git could not be read. Nothing was merged.',
    holders: false,
  },
};

/** The statuses that mean the merge DID happen. Everything else left the target alone. */
const MERGE_OK = new Set(['merged', 'pushed']);

/** Did this merge attempt leave the session stuck? */
function isMergeBlocked(status) {
  return !!status && !MERGE_OK.has(status);
}

/**
 * How to describe a merge attempt that did not merge. Unknown statuses degrade to a
 * truthful generic rather than to `undefined` — mergeWorktree is free to grow a status
 * and a panel that renders "undefined" for it is worse than one that says the status name.
 */
function describeMerge(status) {
  return MERGE_BLOCK[status] || {
    label: `Merge did not run — ${status}`,
    hint: 'The target checkout was left untouched.',
    holders: false,
  };
}

/**
 * Who is sitting IN the shared checkout right now.
 *
 * The rule is one line and deliberately narrow: a session whose working directory IS
 * the target root. A worktree session's cwd is its own worktree, so it can never match;
 * only an agent working directly in the shared repo can. That is exactly the population
 * that can dirty it, which is what makes this answer worth printing rather than a guess.
 *
 * It can legitimately return nothing — the user's own editor dirties the checkout too,
 * and no session accounts for that. An empty list means "nobody here did it", which the
 * caller must render as such rather than as "unknown".
 *
 * @param {string} targetRoot   the shared checkout the merge was refused against
 * @param {Array}  sessions     [{ id, name, cwd, worktree }] — LIVE sessions only
 * @param {string=} exceptId    the blocked session itself, never its own hog
 */
function holdersOf(targetRoot, sessions, exceptId) {
  const root = normalizeRoot(targetRoot);
  if (!root) return [];
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !s.id || s.id === exceptId) continue;
    // A worktree session is never a holder: its cwd is the worktree, not the checkout.
    // Checked explicitly rather than relying on the cwd comparison, so a session whose
    // worktree could not be created (and so fell back to the repo root) is still
    // correctly counted — it really is sitting in the shared checkout.
    if (normalizeRoot(s.cwd) !== root) continue;
    out.push({ sessionId: s.id, sessionName: s.name || null });
  }
  return out;
}

/** Trailing slashes make two spellings of one directory compare unequal. */
function normalizeRoot(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * One sentence naming the hogs, or one saying there are none.
 *
 * Shared by the panel row and by the inbox_blocked tool result on purpose: an agent
 * being told who holds the checkout and a human reading the same row should be reading
 * the same sentence, or the two surfaces drift and only one of them is ever corrected.
 */
function holderSentence(holders, targetName) {
  const where = targetName ? ` in ${targetName}` : '';
  if (!holders || !holders.length) {
    return `No agent session is working${where} — the uncommitted changes are somebody's own, `
      + 'or were left behind by a session that has since closed.';
  }
  const names = holders.map((h) => `"${h.sessionName || h.sessionId}"`);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return names.length === 1
    ? `${list} is working${where} and is what is holding it.`
    : `${list} are working${where}.`;
}

module.exports = {
  MERGE_BLOCK,
  MERGE_OK,
  isMergeBlocked,
  describeMerge,
  holdersOf,
  holderSentence,
  normalizeRoot,
};
