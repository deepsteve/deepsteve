/**
 * Resolve a directory to its git repo root — without shelling out (#553).
 *
 * This used to be `execSync("zsh -l -c 'git rev-parse --show-toplevel'")`, called
 * once per path. Three problems, all of which this module exists to avoid:
 *
 *   1. It is SYNCHRONOUS, and the WebSocket server shares the Express event loop
 *      (`new WebSocketServer({ server, ... })`). While a sync handler runs, the
 *      `upgrade` event cannot fire, so pending WS upgrades receive *zero bytes* —
 *      they stall rather than fail, which is the ~4s hang reported in #553.
 *   2. `/api/git-roots` ran it in a LOOP, once per session cwd, so the block grew
 *      linearly with the user's tab count. Measured: 20 cwds ≈ 1.04s of blocked
 *      event loop; WS upgrade p50 went 0.6ms → 239ms.
 *   3. `zsh -l` is a LOGIN shell — it sources ~/.zprofile/~/.zshrc (nvm, rbenv,
 *      conda...) on every single call, which is where most of that time went.
 *
 * The walk below is pure `fs` and needs no subprocess: 20 lookups take ~0.36ms,
 * roughly 2900x faster, and it can't block the loop in any meaningful way. It is
 * verified equivalent to `git rev-parse --show-toplevel` by test/unit/git-root.test.js.
 *
 * Deployment note: restart.sh and release.sh deploy/embed every root-level *.js
 * (not a hand-maintained list), so this file ships automatically.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// `~` / `~/x` → absolute. Mirrors the tilde handling the callers used to do inline.
function expandTilde(p) {
  const s = String(p);
  return s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : s;
}

/**
 * The git repo root containing `startDir`, or null if it isn't inside a repo.
 *
 * Walks up looking for a `.git` entry. `existsSync` deliberately covers `.git` as
 * both a directory (ordinary checkout) and a FILE — the latter is how git marks a
 * worktree or submodule, which is exactly the `.claude/worktrees/<name>` layout
 * DeepSteve itself creates, so this must not be an `isDirectory()` check.
 *
 * realpath first, because `git rev-parse --show-toplevel` reports the resolved
 * path; without this a session cwd reached via a symlink would produce a root that
 * doesn't match the one git (and therefore the rest of the app) reports.
 */
function findGitRoot(startDir) {
  if (!startDir) return null;
  let dir;
  try {
    dir = fs.realpathSync(path.resolve(expandTilde(startDir)));
  } catch {
    return null; // nonexistent/unreadable path — caller treats as "not a repo"
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
}

module.exports = { findGitRoot, expandTilde };
