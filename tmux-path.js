/**
 * Resolve the tmux binary without a login shell (#619).
 *
 * This replaces `zsh -l -c 'which tmux'`, which made the tmux engine silently
 * conditional on zsh being installed. On macOS that was invisible (zsh is the
 * default shell); on Linux it is backwards — a box can have tmux and no zsh, and
 * there the probe threw, `TmuxEngine.available` was false, `settings.engine` got
 * rewritten back to `node-pty` at startup, and the option vanished from Settings.
 * It failed as "tmux not available", which is the wrong shape for a dependency we
 * intend to require.
 *
 * Why a fallback dir list rather than just `$PATH`: the macOS LaunchAgent plist
 * (see release.sh) sets
 *
 *     PATH=<install>/node/bin:$HOME/.local/bin:<node dir>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
 *
 * which does NOT contain `/opt/homebrew/bin`. That omission is the entire reason
 * the login shell was here: on Apple Silicon, Homebrew's tmux is invisible to a
 * plain `$PATH` scan under launchd. So we scan `$PATH` first and then the handful
 * of prefixes package managers actually use. The Linux systemd unit has `/usr/bin`,
 * so an apt/dnf tmux is found by the PATH scan alone.
 *
 * Anything more exotic (nix profile, asdf, a custom --prefix) is what the
 * `tmuxBinary` setting is for.
 *
 * Deployment note: restart.sh (`cp *.js`) and release.sh (`for rootjs in *.js`)
 * handle every root-level module, so this file ships automatically. That is why it
 * lives here and not in engines/, whose release.sh embed list is hand-maintained.
 *
 * Requires nothing but `fs`/`path`/`child_process` — deliberately NOT node-pty, so
 * test/unit/tmux-path.test.js can run on the bare CI unit runner, which installs
 * deps with --ignore-scripts and therefore has no node-pty binding (and no zsh —
 * which is what makes that job a genuine "tmux present, zsh absent" environment).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandTilde } = require('./git-root');

// Searched after $PATH, in order. Covers Homebrew (both prefixes), MacPorts, the
// system dirs, and the usual Linux user/linuxbrew/nix locations.
const FALLBACK_DIRS = [
  '/opt/homebrew/bin',              // Homebrew, Apple Silicon — absent from the plist PATH
  '/usr/local/bin',                 // Homebrew, Intel Mac
  '/opt/local/bin',                 // MacPorts
  '/usr/bin',
  '/bin',
  '~/.local/bin',
  '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
  '~/.nix-profile/bin',             // Nix
];

/** An existing, executable regular file (a directory named `tmux` must not match). */
function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** $PATH entries followed by the fallback dirs — tilde-expanded, de-duplicated. */
function candidateDirs(env, extraDirs) {
  const fromPath = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = [];
  const seen = new Set();
  for (const d of [...fromPath, ...extraDirs]) {
    const abs = expandTilde(d);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    dirs.push(abs);
  }
  return dirs;
}

/**
 * Absolute path to the tmux binary, or null.
 *
 * `binary` containing a path separator (or a leading `~`) is treated as an explicit
 * location and used verbatim when executable — no searching, no silent fallback to
 * some other tmux, since a user who names a path means that one.
 */
function resolveTmuxPath({ env = process.env, binary = 'tmux', extraDirs = FALLBACK_DIRS } = {}) {
  const name = String(binary || 'tmux');
  if (name.includes(path.sep) || name.startsWith('~')) {
    const abs = path.resolve(expandTilde(name));
    return isExecutableFile(abs) ? abs : null;
  }
  for (const dir of candidateDirs(env, extraDirs)) {
    const p = path.join(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return null;
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
