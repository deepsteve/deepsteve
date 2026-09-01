/**
 * What is already in an issue's worktree? (#689)
 *
 * Starting an issue that already has a worktree is a RESUME, not a fresh start, and
 * until this module nothing said so. `ensureWorktree()` returns an existing
 * `.claude/worktrees/github-issue-<N>` silently, so an agent walked into a checkout
 * with a branch, uncommitted edits and N commits of prior work believing it was the
 * first one there — and with Autopilot on it would merge and close the issue on the
 * strength of somebody else's commits.
 *
 * Everything here is DISCOVERY. Nothing in this module (or anything that calls it)
 * deletes, resets or force-checks-out a worktree or a branch. "Start fresh" means
 * `freshWorktreeName()` — a numbered sibling beside the old one, which is left alone.
 *
 * Three things that look like details and are not:
 *
 * 1. **The branch has to be READ, never guessed.** The directory is always
 *    `github-issue-<N>`, but the branch depends on who made it: Claude's native
 *    `--worktree github-issue-689` creates `worktree-github-issue-689`, while
 *    `ensureWorktree`'s `git worktree add <path>` names the branch after the
 *    directory, `github-issue-689`. A guess is wrong for half of all sessions.
 *
 * 2. **The branch is readable without a subprocess.** `<worktree>/.git` is a FILE
 *    holding `gitdir: <repo>/.git/worktrees/<admin>`, and that admin dir's `HEAD`
 *    holds `ref: refs/heads/<branch>`. Two small reads, and authoritative — the
 *    `.git` file IS the link, so the admin directory's name is never inferred from
 *    the worktree's. `git-root.js` makes the general argument for preferring fs to a
 *    subprocess here; this module additionally needs a pure-fs answer because the
 *    existence latch runs on the WebSocket create path.
 *
 * 3. **Directory mtime is not "last touched".** A directory's mtime only moves when a
 *    top-level entry is added or removed, so an agent that edits `server.js` for an
 *    hour never touches it. Measured on this repo, the dir mtime lagged real activity
 *    by eight minutes. `lastTouched` is therefore the max of the directory mtime, the
 *    worktree's index mtime (every `git add`/`status` refresh moves it) and the branch
 *    tip's commit date.
 *
 * Counts come from ONE subprocess for every candidate at once — `git for-each-ref`
 * with the refs named explicitly. Refs that do not exist are silently omitted and the
 * exit status stays 0, which is what makes a batch safe to build from names we only
 * believe are branches. `%(ahead-behind:…)` needs git 2.41+; older git fails the whole
 * command, so there is one retry without that atom and `commits` is simply absent.
 * That is the rule everywhere here: a field we could not compute is missing, never
 * zero, because "0 commits ahead" is a real and different answer from "we don't know".
 */
const fs = require('fs');
const path = require('path');
const { runBinary } = require('./bin-path');

// Bounded like worktree-support.js rather than like mods/deepsteve-core's runGit
// (120s): this runs on request paths — the issue picker and a session spawn — where a
// wedged git on a network filesystem must delay one response, not hang it.
const GIT_TIMEOUT_MS = 10000;

// Never throws: a non-zero exit is a value here, since "this repo predates
// %(ahead-behind:)" and "git is not installed" are both expected answers that only
// cost us a field. Same shape as mods/deepsteve-core/tools.js's runGit so a caller
// can pass either one in.
function defaultGit(argv, cwd) {
  try {
    const stdout = runBinary('git', argv, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message || '' };
  }
}

// Branch names read off disk reach for-each-ref as argv. No shell is involved, so
// injection is not the risk — argument smuggling is (`--upload-pack=…`). Anchoring on
// an alphanumeric rejects every leading-dash form. Deliberately a copy of
// mods/deepsteve-core/merge-worktree.js's validateBranch rather than an import: a
// root-level module reaching into mods/ would invert the dependency direction.
function validateBranch(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(v)) return null;
  return v;
}

/**
 * The path a worktree named `name` occupies under `repoRoot`.
 *
 * server.js's getWorktreePath() delegates here so the convention has one definition —
 * this module is useless if its idea of where a worktree lives can drift from the
 * code that creates one.
 */
function worktreePath(repoRoot, name) {
  return path.join(repoRoot, '.claude', 'worktrees', name);
}

function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * The git directory backing `dir`, or null.
 *
 * Handles both shapes because either can be the repo root a caller hands us: an
 * ordinary checkout has a `.git` DIRECTORY, a worktree (or submodule) has a `.git`
 * FILE holding `gitdir: <path>`. The recorded path is absolute for every worktree git
 * creates, but it is resolved against `dir` anyway, since git permits a relative one.
 */
function gitDirOf(dir) {
  const dotGit = path.join(dir, '.git');
  const st = statOf(dotGit);
  if (!st) return null;
  if (st.isDirectory()) return dotGit;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    return path.resolve(dir, m[1].trim());
  } catch {
    return null;
  }
}

/**
 * The branch a `HEAD` file names, or null when it is detached (a raw SHA) or absent.
 *
 * Null for a detached HEAD is the honest answer, not a degradation: there is no ref
 * for for-each-ref to report on, so the commit count genuinely cannot be computed.
 */
function headBranch(headFile) {
  try {
    const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs.readFileSync(headFile, 'utf8'));
    return m ? validateBranch(m[1]) : null;
  } catch {
    return null;
  }
}

/** True when `repoRoot` already has a worktree directory called `name`. Pure fs. */
function worktreeExists(repoRoot, name) {
  if (!repoRoot || !name) return false;
  const st = statOf(worktreePath(repoRoot, name));
  return !!st && st.isDirectory();
}

/**
 * Everything about an existing worktree that costs no subprocess, or null when there
 * is no such directory: `{ name, path, branch?, base?, lastTouched }`.
 *
 * `base` is the branch the main checkout has out — what "ahead" is measured against,
 * and the same default target `merge_worktree` picks. A detached repo HEAD yields its
 * SHA instead, which for-each-ref accepts as a commit-ish just as happily.
 */
function readWorktreeFacts(repoRoot, name) {
  if (!repoRoot || !name) return null;
  const wtPath = worktreePath(repoRoot, name);
  const st = statOf(wtPath);
  if (!st || !st.isDirectory()) return null;

  const facts = { name, path: wtPath, lastTouched: st.mtimeMs };

  const admin = gitDirOf(wtPath);
  if (admin) {
    // Every `git add`, `git commit` and `git status` refresh rewrites the index, so
    // this moves with real work in a way the directory's own mtime does not.
    const idx = statOf(path.join(admin, 'index'));
    if (idx) facts.lastTouched = Math.max(facts.lastTouched, idx.mtimeMs);
    const branch = headBranch(path.join(admin, 'HEAD'));
    if (branch) facts.branch = branch;
  }

  const repoGitDir = gitDirOf(repoRoot);
  if (repoGitDir) {
    const base = headBranch(path.join(repoGitDir, 'HEAD'));
    if (base) facts.base = base;
    else {
      try {
        const sha = fs.readFileSync(path.join(repoGitDir, 'HEAD'), 'utf8').trim();
        if (/^[0-9a-f]{7,40}$/.test(sha)) facts.base = sha;
      } catch { /* no readable HEAD; `base` stays absent and so does `commits` */ }
    }
  }

  return facts;
}

// One for-each-ref over every candidate branch. Returns a Map keyed by branch name.
// The two-step is the git-version fallback: `%(ahead-behind:)` arrived in 2.41 and an
// older git rejects the whole format string, so the retry drops that atom and keeps
// the date and the tip SHA rather than losing all three.
function refFacts(repoRoot, branches, base, git) {
  const refs = branches.map(b => `refs/heads/${b}`);
  const run = (withCounts) => git([
    'for-each-ref',
    `--format=%(refname:short) ${withCounts ? `%(ahead-behind:${base}) ` : ''}%(committerdate:unix) %(objectname:short)`,
    ...refs,
  ], repoRoot);

  let withCounts = true;
  let res = run(true);
  if (!res.ok) {
    withCounts = false;
    res = run(false);
  }
  const out = new Map();
  if (!res.ok) return out;

  for (const line of String(res.stdout).split('\n')) {
    const parts = line.trim().split(/\s+/);
    // A branch name can never contain whitespace, so positional parsing is safe.
    if (parts.length < (withCounts ? 5 : 3)) continue;
    const [name] = parts;
    const row = withCounts
      ? { commits: Number(parts[1]), behind: Number(parts[2]), lastCommit: Number(parts[3]) * 1000, head: parts[4] }
      : { lastCommit: Number(parts[1]) * 1000, head: parts[2] };
    if (!Number.isFinite(row.lastCommit)) delete row.lastCommit;
    if (row.commits != null && !Number.isFinite(row.commits)) { delete row.commits; delete row.behind; }
    out.set(name, row);
  }
  return out;
}

/**
 * Status for several worktrees at once — the issue picker's path.
 *
 * Costs one `statSync` per name plus, only when at least one of them exists, a single
 * `for-each-ref`. A repo with no issue worktrees therefore adds no subprocess at all
 * to `GET /api/issues`, which is the constraint the feature was specified under.
 *
 * Returns a Map of name -> `{ name, path, branch?, base?, commits?, behind?, head?,
 * lastTouched }`. Names with no worktree are simply absent from the Map.
 */
function worktreeStatuses({ repoRoot, names, git = defaultGit }) {
  const out = new Map();
  const wanted = [];
  for (const name of names || []) {
    const facts = readWorktreeFacts(repoRoot, name);
    if (!facts) continue;
    out.set(name, facts);
    if (facts.branch && facts.base) wanted.push(facts);
  }
  if (!wanted.length) return out;

  // Every entry read `base` from the same repo root, so they all agree.
  const rows = refFacts(repoRoot, wanted.map(f => f.branch), wanted[0].base, git);
  for (const facts of wanted) {
    const row = rows.get(facts.branch);
    if (!row) continue;
    if (row.commits != null) { facts.commits = row.commits; facts.behind = row.behind; }
    if (row.head) facts.head = row.head;
    if (row.lastCommit) facts.lastTouched = Math.max(facts.lastTouched, row.lastCommit);
  }
  return out;
}

/**
 * Status for ONE worktree, plus the uncommitted-file count — the confirm dialog's and
 * the session spawn's path.
 *
 * `dirty` is what separates a parked worktree from an abandoned one, and it is the
 * single most useful number when deciding whether to resume: a branch can be 0 commits
 * ahead and still hold a day of unstaged work. It costs a `git status --porcelain`,
 * which is why it exists here and not in the batch above.
 */
function worktreeStatus({ repoRoot, name, git = defaultGit }) {
  const status = worktreeStatuses({ repoRoot, names: [name], git }).get(name);
  if (!status) return null;
  const res = git(['status', '--porcelain'], status.path);
  if (res.ok) status.dirty = String(res.stdout).split('\n').filter(l => l.trim()).length;
  return status;
}

// How many numbered siblings to consider before giving up. A repo that has genuinely
// accumulated 50 worktrees for one issue has a problem this function should not paper
// over by inventing a 51st.
const MAX_FRESH = 50;

/**
 * A worktree name beside `base` that nothing is using yet: `<base>-2`, `-3`, …
 *
 * This is what "Start fresh" means. It never touches the existing worktree — the whole
 * point is that prior work survives an accidental fresh start, because a branch this
 * feature deleted would be a branch no one could get back.
 *
 * A free DIRECTORY is not enough, for two reasons.
 *
 * A worktree that was removed leaves its branch behind, and handing that name to
 * `--worktree` (or to `git worktree add`) fails on the branch, not the path — which for
 * a Claude session means the tab dies a second after it appears (#656). So both
 * candidate branch spellings are checked: the name itself, as `git worktree add` would
 * use it, and `worktree-<name>`, as Claude's native flag would.
 *
 * And a name can be spoken for without existing anywhere yet. A Claude session creates
 * its own worktree directory *after* spawn, so between "start fresh" and the agent
 * getting there, neither the directory nor the branch is on disk — two fresh starts in
 * that window would otherwise be handed the same name and land two agents in one
 * checkout. `reserved` is how the caller passes in the names its live sessions already
 * hold; it is the caller's business, not this module's, because only the daemon knows
 * what it has spawned.
 */
function freshWorktreeName(repoRoot, base, { git = defaultGit, reserved = [] } = {}) {
  const taken = new Set(reserved);
  const res = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoRoot);
  if (res.ok) {
    for (const line of String(res.stdout).split('\n')) {
      const b = line.trim();
      if (b) taken.add(b);
    }
  }
  for (let k = 2; k <= MAX_FRESH; k++) {
    const candidate = `${base}-${k}`;
    if (worktreeExists(repoRoot, candidate)) continue;
    if (taken.has(candidate) || taken.has(`worktree-${candidate}`)) continue;
    return candidate;
  }
  return null;
}

module.exports = {
  worktreePath, worktreeExists, readWorktreeFacts, worktreeStatuses, worktreeStatus,
  freshWorktreeName, validateBranch, gitDirOf, defaultGit,
};
