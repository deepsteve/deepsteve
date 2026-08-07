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

module.exports = { expandTilde, stateDir, statePath, logDir, DEFAULT_STATE_DIRNAME };
