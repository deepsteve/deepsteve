/**
 * Resolve an executable — and the user's login shell — without a login shell (#619, #621).
 *
 * #619 established this for tmux, because `zsh -l -c 'which tmux'` made the tmux
 * engine silently conditional on zsh being installed: on macOS invisible (zsh is the
 * default shell), on Linux backwards (a box can have tmux and no zsh). #621
 * generalizes it, because the same `zsh -l -c` appeared seven more times in server.js
 * purely to find git, gh, or an agent binary. Those are PATH lookups wearing a shell
 * costume, and each one cost a full profile source (~/.zprofile, ~/.zshrc, nvm,
 * rbenv, conda…) per call — the same tax #553 measured and removed from git-root.js.
 *
 * Why a fallback dir list rather than just `$PATH`: the macOS LaunchAgent plist
 * (see service.sh) sets
 *
 *     PATH=<install>/node/bin:$HOME/.local/bin:<node dir>:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
 *
 * which does NOT contain `/opt/homebrew/bin`. That omission is the entire reason the
 * login shell was here: on Apple Silicon, Homebrew's tmux/gh is invisible to a plain
 * `$PATH` scan under launchd. So we scan `$PATH` first and then the handful of
 * prefixes package managers actually use. The Linux systemd unit has `/usr/bin`, so
 * an apt/dnf binary is found by the PATH scan alone.
 *
 * Deployment note: restart.sh (`cp *.js`) and release.sh (`for rootjs in *.js`)
 * handle every root-level module, so this file ships automatically. That is why it
 * lives here and not in a subdirectory, whose embed list is hand-maintained.
 *
 * Requires nothing but fs/path/os/child_process — deliberately NOT node-pty, so the
 * unit tests run on the bare CI runner, which installs deps with --ignore-scripts
 * (no node-pty binding) and has no zsh at all — which is what makes that job a
 * genuine "binary present, zsh absent" environment.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandTilde } = require('./paths');

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

/** An existing, executable regular file (a directory named `git` must not match). */
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
 * Absolute path to `name`, or null.
 *
 * A `name` containing a path separator (or a leading `~`) is treated as an explicit
 * location and used verbatim when executable — no searching, no silent fallback to
 * some other binary, since a user who names a path means that one.
 */
function resolveBinary(name, { env = process.env, extraDirs = FALLBACK_DIRS } = {}) {
  const n = String(name || '');
  if (!n) return null;
  if (n.includes(path.sep) || n.startsWith('~')) {
    const abs = path.resolve(expandTilde(n));
    return isExecutableFile(abs) ? abs : null;
  }
  for (const dir of candidateDirs(env, extraDirs)) {
    const p = path.join(dir, n);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Resolve `name` and run it, argv-style. No shell layer at any point.
 *
 * Throws naming the dirs we searched when the binary is missing, so "gh not found"
 * is diagnosable instead of surfacing as a bare ENOENT from deep inside a callback.
 * `exec` is injectable purely so tests can assert what was spawned — specifically
 * that it is the binary and never a shell.
 */
function runBinary(name, argv, { env = process.env, extraDirs = FALLBACK_DIRS, exec = execFileSync, ...opts } = {}) {
  const abs = resolveBinary(name, { env, extraDirs });
  if (!abs) {
    const err = new Error(`${name} not found — searched ${candidateDirs(env, extraDirs).join(', ')}`);
    err.code = 'ENOENT';
    throw err;
  }
  return exec(abs, argv, opts);
}

// --- login shell ----------------------------------------------------------
//
// The two places a login shell is load-bearing rather than a PATH workaround: an
// agent/terminal session IS the user's interactive shell (aliases, prompt, nvm/rbenv
// shims), and a custom command in ~/.deepsteve/commands is a script the user wrote
// expecting their own environment. Everything else that said `zsh -l -c` was finding
// a binary, and now uses resolveBinary().

// The caller builds `-c "<bin> '<arg>' …"` using POSIX '\'' escaping. zsh, bash, dash
// and ksh all parse that identically. FISH DOES NOT — a fish $SHELL would silently
// mangle every agent's argv — so an unrecognised shell is skipped rather than trusted.
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'ash']);
// A passwd shell of nologin/false is how an account is *denied* a shell. Honoring it
// would make every tab exit instantly with no output — the least diagnosable failure
// in this file — so it is never a candidate.
const NEVER_SHELLS = new Set(['nologin', 'false', 'true']);

/**
 * The shell to run sessions and custom commands under: { path, loginFlag }.
 *
 * Order: $SHELL, the passwd entry, then zsh, bash, sh.
 *
 * $SHELL first is not a guess about either service manager: a macOS LaunchAgent
 * daemon's environment really does carry SHELL=/bin/zsh (verified with `ps eww` on a
 * live install), and systemd sets it for user units.
 *
 * zsh sits AHEAD of bash in the fallbacks so macOS is a provable no-op: a Mac user
 * whose $SHELL is fish is rejected by the allowlist and lands on zsh, which is
 * exactly what they get today. Only a deliberate `chsh -s /bin/bash` changes
 * anything, and for them the change is the correct one.
 *
 * `sh` is the floor and gets NO `-l`: not every POSIX sh accepts it, and a failed
 * `sh -l -c` would kill the session outright rather than degrade it.
 *
 * Never returns null — /bin/sh is the last resort, because the alternative is a
 * daemon that cannot open a tab at all.
 */
function resolveLoginShell({ env = process.env, userInfo = os.userInfo, extraDirs = FALLBACK_DIRS } = {}) {
  const candidates = [];
  if (env.SHELL) candidates.push(env.SHELL);
  try {
    // uv_os_get_passwd throws ENOENT for a UID with no passwd entry — the normal case
    // in `docker run --user 1234`. Must not propagate out of session spawning.
    const s = userInfo().shell;
    if (s) candidates.push(s);
  } catch { /* no passwd entry; fall through to the named fallbacks */ }
  candidates.push('zsh', 'bash', 'sh');

  for (const c of candidates) {
    const base = path.basename(String(c));
    if (NEVER_SHELLS.has(base) || !POSIX_SHELLS.has(base)) continue;
    const abs = resolveBinary(c, { env, extraDirs });
    if (!abs) continue;
    return { path: abs, loginFlag: base === 'sh' ? null : '-l' };
  }
  return { path: '/bin/sh', loginFlag: null };
}

/**
 * The command that opens a URL in the user's browser, or null on a headless box.
 *
 * Returning null rather than throwing lets the caller log one honest line — a
 * headless Linux server has no browser and that is not an error condition.
 */
function resolveUrlOpener({ platform = process.platform, env = process.env, extraDirs = FALLBACK_DIRS } = {}) {
  const names = platform === 'darwin'
    ? ['open']
    : ['xdg-open', 'gio', 'gnome-open', 'x-www-browser', 'sensible-browser'];
  for (const n of names) {
    const p = resolveBinary(n, { env, extraDirs });
    if (p) return p;
  }
  return null;
}

module.exports = {
  resolveBinary, runBinary, resolveLoginShell, resolveUrlOpener,
  isExecutableFile, candidateDirs, FALLBACK_DIRS,
};
