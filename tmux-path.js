/**
 * Resolve the tmux binary without a login shell (#619).
 *
 * This replaced `zsh -l -c 'which tmux'`, which made the tmux engine silently
 * conditional on zsh being installed. On macOS that was invisible (zsh is the
 * default shell); on Linux it is backwards — a box can have tmux and no zsh, and
 * there the probe threw, `TmuxEngine.available` was false, `settings.engine` got
 * rewritten back to `node-pty` at startup, and the option vanished from Settings.
 * It failed as "tmux not available", which is the wrong shape for a dependency we
 * intend to require.
 *
 * The generic machinery — the $PATH-then-fallback-dirs scan and the reasons that
 * list exists — moved to bin-path.js in #621, because seven more `zsh -l -c` sites
 * turned out to be the same PATH lookup for git/gh/agent binaries. This file is now
 * just tmux's view of it, with its public surface deliberately unchanged so
 * test/unit/tmux-path.test.js passes verbatim — that test IS the check that the
 * extraction preserved #619's contract.
 *
 * Anything more exotic (nix profile, asdf, a custom --prefix) is what the
 * `tmuxBinary` setting is for.
 *
 * Deployment note: restart.sh (`cp *.js`) and release.sh (`for rootjs in *.js`)
 * handle every root-level module, so this file ships automatically. That is why it
 * lives here and not in engines/, whose release.sh embed list is hand-maintained.
 *
 * Requires nothing but bin-path.js and child_process — deliberately NOT node-pty, so
 * test/unit/tmux-path.test.js can run on the bare CI unit runner, which installs deps
 * with --ignore-scripts and therefore has no node-pty binding (and no zsh — which is
 * what makes that job a genuine "tmux present, zsh absent" environment).
 */
const { execFileSync } = require('child_process');
const { resolveBinary, isExecutableFile, candidateDirs, FALLBACK_DIRS } = require('./bin-path');

/**
 * Absolute path to the tmux binary, or null.
 *
 * `binary` containing a path separator (or a leading `~`) is treated as an explicit
 * location and used verbatim when executable — no searching, no silent fallback to
 * some other tmux, since a user who names a path means that one.
 *
 * Keeps its object-shaped `{binary}` signature (rather than bin-path's positional
 * `name`) so #619's callers and tests are untouched.
 */
function resolveTmuxPath({ env = process.env, binary = 'tmux', extraDirs = FALLBACK_DIRS } = {}) {
  return resolveBinary(String(binary || 'tmux'), { env, extraDirs });
}

/**
 * Resolve tmux and read its version in one subprocess.
 *
 * Returns `{ path, version, searched, error }`. `path`/`version` are null when tmux
 * is unusable; `searched` is the dir list, so the caller can say *where* it looked
 * instead of a bare "tmux not available". Never throws — TmuxEngine probes from its
 * constructor, which runs unconditionally at daemon startup.
 *
 * `version` is the `major.minor` match (`tmux 3.5a` → `3.5`), falling back to the raw
 * output line if it doesn't parse; `TmuxEngine._supportsEnvFlag` consumes it.
 *
 * `exec` is injectable purely so tests can assert what was spawned (specifically:
 * that it is tmux and never a shell).
 */
function probeTmux({ env = process.env, binary = 'tmux', extraDirs = FALLBACK_DIRS, exec = execFileSync } = {}) {
  const searched = candidateDirs(env, extraDirs);
  const tmuxPath = resolveTmuxPath({ env, binary, extraDirs });
  if (!tmuxPath) return { path: null, version: null, searched, error: null };
  try {
    const out = String(exec(tmuxPath, ['-V'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' })).trim();
    // Empty output is "unusable", not "version ''" — callers derive availability from
    // `version !== null`, and an empty string would read as available.
    if (!out) return { path: null, version: null, searched, error: 'tmux -V produced no output' };
    const match = out.match(/(\d+\.\d+)/);
    return { path: tmuxPath, version: match ? match[1] : out, searched, error: null };
  } catch (e) {
    return { path: null, version: null, searched, error: e.message || String(e) };
  }
}

module.exports = { probeTmux, resolveTmuxPath, isExecutableFile, FALLBACK_DIRS };
