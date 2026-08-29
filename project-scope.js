// Project scoping — the one answer to "which project is this, and what else is in
// its group?" (#659).
//
// Three features now scope a listing to the caller's project: scheduled tasks
// (`list_scheduled_tasks`), project mods (`list_project_mods`) and sessions
// (`list_sessions`). Each grew its own private copy of the same ~40 lines, and
// mods/project-mods/tools.js said so out loud — "Mirrors resolveProject() in
// mods/scheduled-tasks/tools.js — the two features answer 'which project is this'
// the same way on purpose". A third copy is how a comment like that stops being
// true, so the logic lives here and the mods import it.
//
// Everything takes the initMCP `ctx` explicitly rather than closing over a
// module-level one: this module is required once per process and shared by every
// mod, so it cannot own a mutable `ctx` the way a single mod's tools.js can.
//
// Tilde handling is paths.js's `expandTilde` for every caller. project-mods used
// to expand only the `~` and `~/` forms and reject anything else as non-absolute;
// the difference is the shell's `~user` form, which neither implementation ever
// really supported.

const fs = require('fs');
const path = require('path');
const { findGitRoot } = require('./git-root');
const { expandTilde } = require('./paths');

/** The caller's shellId, off its own MCP request URL. Null for an unwired caller. */
function callerShellId(extra) {
  return extra?.requestInfo?.url?.searchParams?.get('shellId') || null;
}

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Canonicalize a path to the repo root it belongs to; a non-repo directory is kept
 * as-is; anything else is ''.
 *
 * findGitRoot realpaths, and that is the point rather than a side effect: a session
 * whose repoRoot is reached through a symlink (`/var/…` → `/private/var/…` on macOS)
 * must land on the same string as the same repo reached directly, or an equality
 * comparison between two derived projects means "the same spelling" instead of
 * "the same directory".
 */
function canonicalRoot(p) {
  if (!p) return '';
  return findGitRoot(p) || (isDirectory(p) ? p : '');
}

/**
 * The repo checkout a session belongs to, raw. Goes through ctx.sessionPaths, so a
 * worktree session resolves to its PARENT repo rather than to
 * `.claude/worktrees/<name>` — which is what makes "sessions in my project" include
 * the issue tabs working inside it.
 */
function sessionRepoRoot(ctx, shellId) {
  if (!shellId || !ctx || !ctx.shells || !ctx.shells.has(shellId)) return '';
  try {
    const { repoRoot } = ctx.sessionPaths(ctx.shells.get(shellId));
    return repoRoot || '';
  } catch {
    return '';
  }
}

/**
 * The project a call should act on: an explicit path wins, otherwise inherit the
 * calling session's repo root, otherwise ''.
 *
 * The options exist to preserve mods/scheduled-tasks' looser behaviour EXACTLY, not
 * because three shapes are desirable. Its `task.project` is persisted to
 * scheduled-tasks.json and `list_scheduled_tasks` scopes with `t.project === proj`,
 * so tightening any of these would make freshly-written project strings stop
 * matching ones already on disk and silently hide existing tasks from their own
 * project's listing. Retiring a flag is a deliberate migration, never a tidy-up.
 *
 * - requireAbsolute (default true): a relative explicit path is refused.
 * - allowMissing (default false): an explicit path that is neither a repo nor an
 *   existing directory is refused rather than passed through verbatim.
 * - canonicalizeSession (default true): the session-derived repoRoot goes through
 *   canonicalRoot, so it can be compared with another canonicalized project.
 */
function resolveProject(rawProject, shellId, ctx, opts = {}) {
  const {
    requireAbsolute = true,
    allowMissing = false,
    canonicalizeSession = true,
  } = opts;

  if (rawProject && String(rawProject).trim()) {
    const p = expandTilde(String(rawProject).trim());
    if (requireAbsolute && !path.isAbsolute(p)) return '';
    return canonicalRoot(p) || (allowMissing ? p : '');
  }

  const repoRoot = sessionRepoRoot(ctx, shellId);
  if (!repoRoot) return '';
  return canonicalizeSession ? (canonicalRoot(repoRoot) || repoRoot) : repoRoot;
}

/** True when path `p` is `dir` itself or nested inside it (trailing slashes ignored). */
function pathInside(p, dir, ctx) {
  if (ctx && ctx.pathInside) return ctx.pathInside(p, dir);
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

// The shared contexts (#526), from server core via the initMCP ctx. Empty on an
// older core that doesn't expose them (group scope then falls back to self-only).
function getContexts(ctx) {
  const list = (ctx && ctx.getContexts) ? ctx.getContexts() : [];
  return Array.isArray(list) ? list : [];
}

/**
 * Folders that define `project`'s group scope: the dirs of every context that
 * contains `project` (by folder prefix), plus `project` itself. A row is "in the
 * group" when its repo root is inside/equals one of these folders.
 */
function groupScopeDirs(project, ctx) {
  const dirs = new Set(project ? [project] : []);
  for (const c of getContexts(ctx)) {
    const cdirs = Array.isArray(c && c.dirs) ? c.dirs : [];
    if (cdirs.some(d => pathInside(project, d, ctx))) {
      for (const d of cdirs) dirs.add(d);
    }
  }
  return [...dirs];
}

/** True when `project` is in scope under `effScope` for the caller's project `proj`. */
function inScope(project, proj, effScope, ctx) {
  if (effScope === 'all') return true;
  if (effScope === 'group') return groupScopeDirs(proj, ctx).some(d => pathInside(project, d, ctx));
  return project === proj;
}

function displayName(project) {
  return project ? path.basename(project) : 'No project';
}

/**
 * Display names for a set of repo roots: the basename, widened to `parent/base`
 * only where two roots would otherwise collide — mirrors /api/git-roots.
 * Pure and scoped to the roots handed in, so a caller that renders a *different*
 * root set gets names disambiguated against what it shows.
 */
function disambiguate(roots) {
  const list = [...new Set([...roots].filter(Boolean))].sort();
  const baseCounts = {};
  for (const r of list) { const b = path.basename(r); baseCounts[b] = (baseCounts[b] || 0) + 1; }
  const names = new Map();
  for (const root of list) {
    const base = path.basename(root);
    names.set(root, baseCounts[base] > 1 ? path.join(path.basename(path.dirname(root)), base) : base);
  }
  return names;
}

module.exports = {
  callerShellId,
  isDirectory,
  canonicalRoot,
  sessionRepoRoot,
  resolveProject,
  pathInside,
  getContexts,
  groupScopeDirs,
  inScope,
  displayName,
  disambiguate,
};
