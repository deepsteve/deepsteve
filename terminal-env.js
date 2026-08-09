/**
 * The two environment variables a terminal session needs and a service-managed
 * daemon does not have (#624).
 *
 * Neither service definition declares a locale — the launchd plist and the systemd
 * unit in service.sh set NODE_ENV, PORT, DEEPSTEVE_BIND, PATH and DEEPSTEVE_LOG_DIR
 * and nothing else — so `process.env` under a real install carries no LC_ALL,
 * LC_CTYPE or LANG at all. That was invisible while node-pty was the default,
 * because node-pty passes the agent's bytes straight through. Under tmux it is
 * fatal to rendering: tmux sets its client's UTF-8 flag from `-u` or from the first
 * of LC_ALL/LC_CTYPE/LANG containing "UTF-8", and without it tty_check_codeset()
 * takes its documented fallback — *replace each non-ASCII glyph by the right number
 * of underscores*. The Claude Code banner, the spinner, `…` and `⏵⏵` all became `_`.
 *
 * COLORTERM is the same class of gap from the other end: it is how a TUI learns it
 * may emit 24-bit SGR at all.
 *
 * Deployment note: restart.sh (`cp *.js`) and release.sh (`for rootjs in *.js`) ship
 * every root-level module automatically. That is why this lives here and not in
 * engines/, whose release.sh embed list is hand-maintained — and it has two
 * consumers anyway (engines/tmux.js for the attach client and the pane, server.js's
 * childBaseEnv for every session of either engine).
 *
 * Pure: no I/O, no requires. `platform` and `env` are injected the same way
 * bin-path.js and paths.js take them, so one CI runner can assert both platforms.
 */

/** tmux's own test, verbatim: LC_ALL, then LC_CTYPE, then LANG — first one *set* wins. */
const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

/**
 * Does this environment already declare a UTF-8 locale?
 *
 * Matches tmux's check (`strcasestr` for "UTF-8" or "UTF8" against the first of
 * LC_ALL/LC_CTYPE/LANG that is set and non-empty), so we agree with tmux about
 * whether anything needs filling in. Note it is the FIRST set variable that
 * decides — `LC_ALL=C` with `LANG=en_US.UTF-8` is a non-UTF-8 environment, to tmux
 * and to libc alike.
 */
function hasUtf8Locale(env) {
  for (const name of LOCALE_VARS) {
    const val = env[name];
    if (val === undefined || val === '') continue;
    return /utf-?8/i.test(val);
  }
  return false;
}

/**
 * The UTF-8 locale to declare when the environment declares none.
 *
 * Deliberately not `en_US.UTF-8`: it is frequently not generated on minimal Linux
 * images (including our own test/Dockerfile*), and naming an ungenerated locale
 * makes setlocale() fail — which leaks warnings from perl/coreutils into the very
 * terminal we are trying to fix.
 *
 *   darwin — bare `UTF-8`, BSD libc's codeset-only locale. Valid on every macOS;
 *            it is what Terminal.app itself exports.
 *   else   — `C.UTF-8`, present on modern glibc, Debian bookworm and Ubuntu, and
 *            on musl. The C locale with a UTF-8 codeset is exactly what we want:
 *            no collation or message surprises, just the character set.
 *
 * LC_CTYPE rather than LANG so we assert the character set only, and so a user's
 * LANG (if they later set one) still governs everything else.
 */
function utf8LocaleValue(platform) {
  return platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
}

/**
 * The terminal-facing env vars to layer onto a child's environment.
 *
 * Returns a fresh object with at most two keys, and **never overrides what the
 * environment already says** — a user who configured a locale (or a COLORTERM)
 * keeps it. An empty object is the correct, common answer on a developer's machine.
 *
 * @param {{platform?: string, env?: object}} [opts]
 * @returns {{LC_CTYPE?: string, COLORTERM?: string}}
 */
function terminalEnv({ platform = process.platform, env = process.env } = {}) {
  const out = {};
  if (!hasUtf8Locale(env)) out.LC_CTYPE = utf8LocaleValue(platform);
  // xterm.js is unconditionally truecolor, so this is an assertion about our own
  // consumer rather than a guess about an unknown terminal.
  if (!env.COLORTERM) out.COLORTERM = 'truecolor';
  return out;
}

/**
 * The keys terminalEnv() can produce. Callers that must force these past a
 * "same as ours, so skip it" filter need the list without calling the function.
 */
const TERMINAL_ENV_KEYS = ['LC_CTYPE', 'COLORTERM'];

module.exports = { terminalEnv, hasUtf8Locale, TERMINAL_ENV_KEYS, LOCALE_VARS };
