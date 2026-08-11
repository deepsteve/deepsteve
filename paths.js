/**
 * The one place that knows where deepsteve puts things (#621).
 *
 * Two rules, and they are why this file exists rather than 30 inline path.joins:
 *
 *   1. The STATE dir is ~/.deepsteve on every platform, deliberately NOT XDG.
 *      ~/.deepsteve *is* the install dir — server.js, node_modules, a bundled
 *      node/bin and mods/ all live there, and mods resolve core modules as
 *      `require('../../<mod>')`. So an XDG state dir would not remove the
 *      dotdir, it would add a second location, and every "paste your
 *      settings.json" support thread would get harder. The neighborhood
 *      (~/.claude, ~/.codex, ~/.agents) uses dotdirs too. See #621.
 *
 *   2. The LOG dir *is* platform-split, because it has to be: launchd and
 *      systemd own those fds and name an absolute path in a service definition
 *      that is written once at install time. That table lives here; logging.js
 *      consumes it, and service.sh's ds_log_dir is its shell twin (a unit test
 *      asserts the two agree — that is what finally enforces logging.js's
 *      "must mirror release.sh's LOG_DIR choices" comment).
 *
 * DEEPSTEVE_HOME is a DAEMON-SIDE override for tests and second instances — it
 * is NOT a supported way to relocate an install. restart.sh, uninstall.sh and
 * release.sh still hardcode $HOME/.deepsteve, and the OpenCode global config
 * written at install time embeds the literal string
 * `{file:~/.deepsteve/auth-token}` (release.sh). Point it somewhere else and
 * the daemon follows; nothing around it does.
 *
 * Injectable platform/env/homedir, same shape as logging.js's defaultLogPaths
 * and power-assertion.js — so the CI unit job (bare ubuntu) can assert the
 * darwin answers, which is the whole point given the bug class here is "works
 * on the maintainer's Mac".
 *
 * Deployment note: restart.sh (`cp *.js`) and release.sh (`for rootjs in *.js`)
 * handle every root-level module, so this file ships automatically. That is why
 * it lives here and not in a subdirectory, whose embed list is hand-maintained.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_STATE_DIRNAME = '.deepsteve';

/**
 * `~` / `~/x` → absolute.
 *
 * Moved here from git-root.js, where it landed by accident in #553; git-root.js
 * re-exports it so tmux-path.js and test/unit/git-root.test.js keep working.
 *
 * Quirk preserved deliberately: a `~user` prefix is NOT resolved to that user's
 * home — `~bob` becomes `<our home>/bob`, because the test is `startsWith('~')`
 * and the slice is unconditional. That is what every caller has always done, and
 * this move is meant to be a provable no-op. Fixing it is a behavior change and
 * belongs in its own commit.
 *
 * Falsy in, falsy out. There were two inline implementations before this — one in
 * git-root.js that did `String(p)` (so `undefined` came back as the *string*
 * "undefined") and one in server.js that returned falsy unchanged. server.js's is
 * the correct one and the only one whose callers can actually pass falsy
 * (`expandTilde(p.configDir)` on a profile with no configDir), so it wins; no
 * git-root/tmux-path caller passes anything but a non-empty string.
 */
function expandTilde(p, homedir = os.homedir()) {
  if (!p) return p;
  const s = String(p);
  return s.startsWith('~') ? path.join(homedir, s.slice(1)) : s;
}

/**
 * Is this usable as a session's SPAWN cwd? Returns null when yes, or
 * `{ code, cwd, message }` describing the problem (#632).
 *
 * A directory that stopped existing used to be invisible, because the two engines
 * disagree about what it means and neither says anything:
 *
 *   - tmux `new-session -c /gone` SUCCEEDS. The pane child does chdir(cwd) →
 *     chdir(home) → chdir("/"), so the agent comes up in $HOME while state.json,
 *     shells.get(id).cwd, DEEPSTEVE_CWD and the tab name all keep claiming the
 *     path that is gone. Every `git status` it runs then hits the home directory.
 *   - node-pty's child fails its own chdir and _exit(1)s — but only AFTER
 *     posix_spawn/forkpty has returned, so pty.spawn() throws nothing and the tab
 *     merely vanishes.
 *
 * Falsy in, null out, and that is load-bearing rather than defensive:
 * serializeShellEntry writes `cwd` unconditionally, so a saved record can carry
 * undefined, which spawns in the daemon's cwd today. Refusing falsy would make
 * those records unrestorable. Only a *specified* path that is missing is refused.
 *
 * statSync (not lstatSync) on purpose: a symlink to a live directory is a fine
 * place to work, and a symlink whose target is gone should be refused.
 */
function spawnCwdProblem(cwd) {
  if (!cwd) return null;
  let st;
  try {
    st = fs.statSync(cwd);
  } catch (e) {
    return e.code === 'ENOENT'
      ? { code: 'cwd-missing', cwd, message: `Working directory no longer exists: ${cwd}` }
      : { code: 'cwd-unusable', cwd, message: `Working directory is not usable (${e.code}): ${cwd}` };
  }
  if (!st.isDirectory()) {
    return { code: 'cwd-not-a-directory', cwd, message: `Working directory is not a directory: ${cwd}` };
  }
  return null;
}

/**
 * Throwing form of spawnCwdProblem, for the one enforcement point (spawnSession).
 * `code` and `cwd` ride on the Error so a caller can forward them to the client
 * without re-parsing the message.
 */
function assertSpawnCwd(cwd) {
  const problem = spawnCwdProblem(cwd);
  if (!problem) return;
  const err = new Error(problem.message);
  err.code = problem.code;
  err.cwd = problem.cwd;
  throw err;
}

/**
 * The deepsteve state + install directory. Same on darwin and linux, by design
 * (rule 1 above).
 */
function stateDir({ env = process.env, homedir = os.homedir() } = {}) {
  const override = env.DEEPSTEVE_HOME;
  if (override) return path.resolve(expandTilde(override, homedir));
  return path.join(homedir, DEFAULT_STATE_DIRNAME);
}

/** path.join(stateDir(), ...segments) — the shape almost every caller wants. */
function statePath(...segments) {
  return path.join(stateDir(), ...segments);
}

/**
 * deepsteve's OWN tmux server socket (#625).
 *
 * Before this, the tmux engine passed no socket flag and inherited tmux's default —
 * `$TMUX_TMPDIR`-or-`/tmp` + `tmux-<uid>/default`, which is per-UID and NOT per-HOME.
 * So the HOME isolation every test daemon already does correctly bought nothing, and
 * isolation instead rode on a convention (set TMUX_TMPDIR *and* mkdir it) with a
 * silent fallback to the developer's real socket. A test's `kill-server` took that
 * fallback and destroyed every live agent on the machine, three times in one morning.
 *
 * Deriving the socket from stateDir() makes socket isolation a consequence of HOME
 * isolation, automatically and for every caller. `tmux -S <path>` has no fallback of
 * its own (man tmux: "If -S is specified, the default socket directory is not used"):
 * point it somewhere unusable and tmux starts a NEW EMPTY server there — it can never
 * silently resolve to someone else's sessions, which the env var can.
 *
 * Side benefit: this is far shorter than the old `$TMPDIR/tmux-<uid>/default`, and it
 * is EXACT — tmux appends nothing — so the ~104-byte sun_path budget is finally a
 * number a caller can check instead of a silent "tmux is installed and unusable".
 *
 * Twinned by ds_tmux_socket in service.sh (test/unit/service-definition.test.js
 * compares them), and by test/helpers/tmux-sandbox.js, which derives a test daemon's
 * socket from the same expression so both sides are provably on one server.
 */
function tmuxSocketPath(opts = {}) {
  return path.join(stateDir(opts), 'tmux.sock');
}

/**
 * Where tmux puts its OWN default socket — i.e. where every deepsteve session created
 * before #625 still lives. `$TMUX_TMPDIR`-or-`/tmp` + `tmux-<uid>/default`, which is
 * what `man tmux` documents for `-L`.
 *
 * This exists so the one-time migration can name that socket with `-S` instead of
 * letting tmux resolve it, and the difference is not academic. **A tmux client inside a
 * pane ignores TMUX_TMPDIR entirely** and uses the socket named in `$TMUX` — so a
 * process that inherited `TMUX` (every agent-run test, since a deepsteve tab IS a tmux
 * pane) silently talks to whatever server it happens to be sitting in. That is what
 * made the old test-isolation convention a no-op rather than merely fragile: the rule
 * was "set TMUX_TMPDIR and mkdir it", and inside a pane neither clause did anything at
 * all. A killing path must not inherit its target from ambient state, so it computes
 * the path and passes `-S`.
 *
 * Not used for anything deepsteve creates — only for finding what predates the move.
 */
function defaultTmuxSocketPath({ env = process.env, uid } = {}) {
  const id = uid !== undefined ? uid : (typeof process.getuid === 'function' ? process.getuid() : 0);
  const base = env.TMUX_TMPDIR || '/tmp';
  return path.join(base, `tmux-${id}`, 'default');
}

/**
 * Where the service definition points our stdout/stderr.
 *
 * Mirrored by ds_log_dir in service.sh, which is what actually writes the
 * plist/unit — the unit test that compares them is the enforcement.
 * DEEPSTEVE_LOG_DIR wins over both, and since #621 the service definition
 * passes it explicitly, so the platform table below is a fallback for installs
 * whose definition predates that.
 */
function logDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (env.DEEPSTEVE_LOG_DIR) return env.DEEPSTEVE_LOG_DIR;
  return platform === 'darwin'
    ? path.join(homedir, 'Library', 'Logs')
    : path.join(homedir, '.local', 'share', 'deepsteve', 'logs');
}

module.exports = {
  expandTilde, spawnCwdProblem, assertSpawnCwd,
  stateDir, statePath, tmuxSocketPath, defaultTmuxSocketPath, logDir,
  DEFAULT_STATE_DIRNAME,
};
