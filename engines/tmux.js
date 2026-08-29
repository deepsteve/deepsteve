const { execFileSync } = require('child_process');
const Engine = require('./engine');
const { probeTmux } = require('../tmux-path');
const { terminalEnv, TERMINAL_ENV_KEYS } = require('../terminal-env');
const { tmuxSocketPath } = require('../paths');

// node-pty is required lazily, at the one place that needs it (attaching), so that
// merely requiring this module doesn't pull in a native binding. The CI unit job
// installs with `--ignore-scripts` — no node-gyp build — and a top-level require
// here made the engine untestable there, which is why the detach/exit contract
// (#620) had no unit coverage at all. Callers that inject `spawnPty` never load it.
function defaultSpawnPty(...args) {
  return require('node-pty').spawn(...args);
}

const SESSION_PREFIX = 'ds-';

/**
 * What node-pty deletes from a child's environment — but only when it owns the env
 * object (`opt.env === process.env` by identity, unixTerminal.js `_sanitizeEnv`).
 * The moment we pass an env of our own it stops running, and we inherit the duty.
 *
 * Not cosmetic: a daemon started by hand from inside a tmux pane has TMUX set, and
 * `tmux attach-session` refuses outright with "sessions should be nested with care,
 * unset $TMUX to force" — every tab would come up dead.
 */
const PTY_UNSAFE_ENV = ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'WINDOWID', 'TERMCAP', 'COLUMNS', 'LINES'];

/**
 * The `terminal-overrides` entry that gives the browser its scrollbar back, and the
 * index it is written to. See _applySessionOptions() for what it does and what it
 * costs, and _supportsIndexedArrayOption for why it is addressed by index.
 *
 * Index 1 because tmux ships exactly one default entry, at [0] (`linux*:AX@`), and
 * this socket is deepsteve's alone (#625) — so [1] is ours to own, and unsetting it
 * cannot take tmux's own default with it.
 */
const SCROLLBACK_OVERRIDE_OPTION = 'terminal-overrides[1]';
const SCROLLBACK_OVERRIDE_VALUE = '*:smcup@:rmcup@';

/**
 * How many times an attach PTY may die and be silently re-attached, in a row,
 * before we stop and report a real exit (#626).
 */
const MAX_SILENT_REATTACHES = 3;

/**
 * How long an attach must survive before its death counts as a NEW incident
 * rather than another strike against the retry budget.
 *
 * This is a duration, not a "did it produce output?" test, and the difference is
 * load-bearing: attaching to a live tmux session always makes tmux repaint the
 * pane, so *every* re-attach produces data within milliseconds. Resetting the
 * budget on data therefore reset it on every retry, turning the bound into an
 * infinite loop that spawned PTYs until the daemon hit `posix_spawnp failed` and
 * stopped serving — strictly worse than the false-death bug being fixed here.
 */
const REATTACH_RESET_MS = 60000;

/** The subset of `src` named by `keys` that is actually defined. */
function pick(src, keys) {
  const out = {};
  if (!src) return out;
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/**
 * tmux engine — each session runs inside a tmux session named ds-{id}.
 * A node-pty is used to `tmux attach-session` for I/O streaming, so all
 * PTY output (escape sequences, BEL detection) works unchanged.
 *
 * tmux sessions survive daemon restarts; on startup, listSessions() returns
 * surviving sessions that can be reattached.
 *
 * Every tmux invocation is `execFileSync(<resolved absolute path>, argv)` — no
 * shell layer (#619). Two consequences worth knowing: the engine works on a box
 * with tmux and no zsh (the point of the change), and tmux commands now inherit the
 * daemon's environment directly rather than whatever a login shell's profile files
 * produced. The absolute path is load-bearing: a bare `tmux` is ENOENT under a
 * LaunchAgent, whose PATH has no /opt/homebrew/bin.
 *
 * Every invocation also carries `-S <socket>` (#625) — see the `socket` option
 * below. The engine deliberately emits NO whole-server verb: there is no
 * `kill-server` anywhere in this file, and a unit test keeps it that way. Everything
 * destructive here names one session (`kill-session -t ds-<id>`), so a mis-aimed
 * call can cost at most one session instead of every session on a socket.
 */
class TmuxEngine extends Engine {
  /**
   * @param {{binary?: string, socket?: string|null, env?: object, exec?: Function,
   *          spawnPty?: Function, now?: Function}} [opts]
   *   binary — the `tmuxBinary` setting: a bare name to search for, or an explicit
   *   path. exec/env/spawnPty/now are injection points for tests; spawnPty stands in
   *   for pty.spawn so the attach/detach lifecycle can be tested on a box with no
   *   tmux (which is exactly what the CI unit job is), and `now` drives the #626
   *   re-attach budget (see REATTACH_RESET_MS).
   *
   *   `env` is the daemon's environment. It reaches the $PATH probe *and*, since
   *   #624, every runtime read of it — the spawn-time diff against what the pane
   *   would inherit anyway, and the env the attach client is given. That is what
   *   makes the locale bug testable: a test that inherits the runner's env has a
   *   locale and passes against the bug.
   *
   *   socket — WHICH tmux server this engine talks to (#625). Three-way, because
   *   "not specified" and "deliberately the default one" are genuinely different
   *   requests:
   *
   *     undefined → deepsteve's own socket, tmuxSocketPath(). The normal case.
   *     null      → tmux's OWN default per-UID socket, on purpose. Exactly two
   *                 features want this, and both are about sessions deepsteve did
   *                 not create: the "Attach tmux session" submenu and the tab it
   *                 opens. server.js reaches them through a separately named engine
   *                 instance (userTmux()) so that access is opt-in and greppable
   *                 rather than ambient.
   *     '<path>'  → that exact socket (the `tmuxSocket` setting).
   *
   *   The socket's PARENT DIRECTORY is the caller's to create: with -S, tmux only
   *   bind()s, it does not mkdir (it creates a directory only for its own default
   *   socket). This file stays fs-free so the bare CI unit job can construct engines.
   */
  constructor({ binary = 'tmux', socket, env, exec, spawnPty, now, browserScrollback } = {}) {
    super();
    this._sessions = new Map(); // id → { attachPty, exitCallbacks }
    this._binary = binary || 'tmux';
    this._env = env || process.env;
    // `socket || null` collapses '' to null rather than emitting `-S ''`, which tmux
    // reads as a relative path in cwd. undefined is the only value that means "ours".
    this._socket = socket === undefined ? tmuxSocketPath() : (socket || null);
    this._spawnPty = spawnPty || defaultSpawnPty;
    // Injectable clock, for the #626 re-attach budget (see REATTACH_RESET_MS).
    this._now = now || Date.now;
    // A GETTER, not a value: the setting is live-editable and this engine is
    // constructed once at boot, so reading it here would freeze whatever was true then.
    // Called on every attach — see _applySessionOptions().
    //
    // Absent means "don't touch it", which is NOT the same as false. False is a
    // decision that has to be written to the tmux server (the entry a previous boot
    // left behind has to come back off); absent is an engine that was never told about
    // the setting — userTmux(), the legacy-socket migration engine, most tests — and
    // has no business writing a server-scoped option on someone else's behalf.
    this._browserScrollback = browserScrollback || null;
    // `exec` reaches _exec too, not just the version probe (#621). Without this,
    // spawn() always really shelled out, so the argv it builds — the riskiest thing
    // in this file, and the thing #621's login-shell change rewrites — could not be
    // asserted on a runner with no tmux.
    this._execFn = exec || execFileSync;
    this._probeOpts = { binary: this._binary };
    if (env) this._probeOpts.env = env;
    if (exec) this._probeOpts.exec = exec;
    this._tmuxVersion = null;
    this._tmuxPath = null; // Full path to tmux binary (needed for PTY spawns under LaunchAgent)
    this._searchedDirs = [];
    this._probeError = null;
    this._checkTmux();
  }

  _checkTmux() {
    const r = probeTmux(this._probeOpts);
    this._tmuxVersion = r.version;
    this._tmuxPath = r.path;
    this._searchedDirs = r.searched;
    this._probeError = r.error;
  }

  /**
   * Which tmux server this engine talks to: an absolute socket path, or null for
   * tmux's own default per-UID socket. Read by server.js so /api/engines and the
   * fallback panel can NAME the socket rather than saying "tmux failed".
   */
  get socket() {
    return this._socket;
  }

  /**
   * Global flags that must precede EVERY tmux command — `-S` is a client flag, not a
   * subcommand argument, so it goes before the verb. Both invocation points funnel
   * through here: _exec() for the ten command sites, and _attach() for the PTY.
   */
  _socketArgs() {
    return this._socket ? ['-S', this._socket] : [];
  }

  /** Run a tmux command directly — argv array, no shell, always on our socket. */
  _exec(args, opts = {}) {
    return this._execFn(this._tmuxPath || 'tmux', [...this._socketArgs(), ...args],
      { timeout: 5000, stdio: 'pipe', ...opts });
  }

  get available() {
    return this._tmuxVersion !== null;
  }

  get version() {
    return this._tmuxVersion;
  }

  /** Full path to the tmux binary (resolved by tmux-path.js, no login shell). */
  get tmuxPath() {
    return this._tmuxPath || 'tmux';
  }

  /**
   * Why tmux wasn't found — so an unavailable engine can say where it looked
   * instead of just "tmux not available". Null when available.
   */
  get unavailableReason() {
    if (this.available) return null;
    if (this._probeError) return `"${this._binary}" is not usable: ${this._probeError}`;
    if (this._binary.includes('/')) return `no executable at "${this._binary}" (tmuxBinary setting)`;
    return `no "${this._binary}" binary found in any of: ${this._searchedDirs.join(', ')}`;
  }

  /** Is the resolved tmux at least this version? */
  _atLeast(major, minor) {
    if (!this._tmuxVersion) return false;
    const parts = this._tmuxVersion.split('.').map(Number);
    return parts[0] > major || (parts[0] === major && parts[1] >= minor);
  }

  /** Check if tmux supports -e flag (>= 3.2) */
  get _supportsEnvFlag() {
    return this._atLeast(3, 2);
  }

  /**
   * Can we declare terminal features with the top-level `-T` flag (>= 3.2)?
   *
   * Gated because an unknown flag makes tmux exit with a usage error, which would
   * kill the attach PTY — a broken tab, not a degraded one. Older tmux simply
   * keeps today's 256-colour behaviour.
   */
  get _supportsFeaturesFlag() {
    return this._atLeast(3, 2);
  }

  /**
   * Can the mouse be turned on with the single `mouse` session option (>= 2.1)?
   *
   * tmux 2.1 collapsed mode-mouse / mouse-select-pane / mouse-select-window /
   * mouse-resize-pane into one flag. An older tmux answers "unknown option", which the
   * try/catch at the call site swallows — so unlike `_supportsFeaturesFlag`, whose bad
   * flag would kill the attach PTY, this gate protects nothing at runtime. It is here
   * so a 2.0 box reads as a decision rather than as a command silently failing on every
   * attach.
   */
  get _supportsMouseOption() {
    return this._atLeast(2, 1);
  }

  /**
   * Can a single entry of an array option be set and unset by index (>= 3.0)?
   *
   * tmux 3.0 turned `terminal-overrides` into an array option, which is what makes
   * `terminal-overrides[1]` addressable. Index syntax is the whole reason the
   * scrollback override is safe to re-apply on every attach: `set -as` APPENDS, so
   * the same entry lands again on every reattach and the array grows without bound,
   * while `set -s terminal-overrides[1]` is idempotent and `set -su` of that index
   * removes exactly ours and leaves tmux's own default (`linux*:AX@`) at [0].
   *
   * Ungated it would be worse than useless on 2.x: the unset would be a no-op and
   * the set would clobber the whole option.
   */
  get _supportsIndexedArrayOption() {
    return this._atLeast(3, 0);
  }

  _tmuxSessionName(id) {
    return SESSION_PREFIX + id;
  }

  spawn(id, cmd, args, cwd, { cols = 120, rows = 40, env, stripEnv = [], shellCommand } = {}) {
    const sessionName = this._tmuxSessionName(id);

    // What the pane runs, as ARGV — never as a string (#630).
    //
    // tmux's `shell-command` is two different things depending on how many arguments
    // it gets. ONE argument is an sh(1) command line, which tmux runs through the
    // session's `default-shell` — a NON-login shell, and not even necessarily the
    // shell resolveLoginShell() picked. TWO OR MORE are exec'd directly with no shell
    // in between (tmux(1), "shell-command"; landed in tmux 2.0, March 2015).
    //
    // #621 handed over the one-string form to stop a login shell nesting inside
    // tmux's own, and that worked — but it also threw spawnSession's `-l` on the
    // floor. ~/.zprofile is where `brew shellenv` puts /opt/homebrew/bin on PATH and
    // the LaunchAgent plist does not carry it, so `gh` was "command not found" in
    // every tmux agent session while node-pty sessions — which really do exec
    // `/bin/zsh -l -c …` — were fine. Handing tmux [cmd, ...args] verbatim makes the
    // pane argv byte-for-byte the one node-pty is given (engines/node-pty.js), with
    // exactly one shell in it, and deletes the quoting layer rather than fixing it.
    //
    //   shellCommand === null → no command at all: tmux forks `default-shell` as a
    //                           LOGIN shell of its own (tmux(1), `default-command`).
    //                           What a plain terminal tab wants, and the one case
    //                           that was never broken.
    //   otherwise             → exec [cmd, ...args] directly.
    //
    // `-l`/`-c` after the shell path are pane arguments, not tmux flags: tmux bundles
    // OpenBSD's getopt (it needs optreset, which glibc lacks) and imports none from
    // libc, so parsing is non-permuting and stops at `cmd`. No `--` separator — it is
    // undocumented in tmux(1), so a tmux that did not special-case it would pass `--`
    // to execvp as argv[0] and every pane would die instantly.
    //
    // NOTE the cliff: a paneArgv of exactly ONE element is back in sh(1) territory.
    // spawnSession never produces one (an agent is shell + -l + -c + inner), but a
    // generic caller with no args does, and gets the pre-#630 behaviour for it.
    if (typeof shellCommand === 'string') {
      // Unrepresentable rather than merely discouraged. spawnSession's catch turns
      // this into a node-pty fallback with the orange badge, so it is visible.
      throw new TypeError(
        'TmuxEngine.spawn: shellCommand no longer takes a string (#630) — a single '
        + 'shell-command argument is run by a NON-login shell, which is the bug. Pass '
        + 'the argv as cmd+args, or null for a bare login shell.');
    }
    const paneArgv = shellCommand === null ? [] : [cmd, ...args];

    const tmuxArgs = ['new-session', '-d', '-s', sessionName, '-x', String(cols), '-y', String(rows)];
    if (cwd) tmuxArgs.push('-c', cwd);

    // Pass environment variables
    const extraEnv = {};
    if (env) {
      for (const [key, val] of Object.entries(env)) {
        if (val !== undefined && val !== this._env[key]) {
          extraEnv[key] = val;
        }
      }
    }

    // #517: daemon-internal vars (PORT, NODE_ENV, …) are absent from `env`, so the
    // diff loop above won't forward them — but the tmux server inherited them from
    // the daemon, so sessions would still see PORT=3000. Set each to empty to
    // override that inheritance.
    for (const key of stripEnv) {
      if (this._env[key] !== undefined) extraEnv[key] = '';
    }

    // #624: pin the pane's locale and colour depth, past the diff loop above.
    //
    // The diff drops anything equal to the daemon's env, on the reasoning that the
    // pane inherits it anyway. That reasoning does not hold for these two: a pane
    // inherits the tmux SERVER's global environment, and the server belongs to
    // whichever process started it — quite possibly the user's own interactive
    // tmux, since we share the per-UID default socket. "Same as ours" therefore
    // proves nothing about what the agent will see, so state it explicitly.
    //
    // Deliberately after the diff and the strip: `env`'s value wins when the caller
    // supplied one (childBaseEnv already layers terminalEnv in), the first -e pair
    // stays DEEPSTEVE_SESSION_ID, and a stripEnv key is never resurrected.
    const wantedTerminalEnv = { ...terminalEnv({ env: this._env }), ...pick(env, TERMINAL_ENV_KEYS) };
    for (const [key, val] of Object.entries(wantedTerminalEnv)) {
      if (extraEnv[key] === undefined) extraEnv[key] = val;
    }

    if (this._supportsEnvFlag) {
      // tmux >= 3.2: use -e KEY=VAL
      for (const [key, val] of Object.entries(extraEnv)) {
        tmuxArgs.push('-e', `${key}=${val}`);
      }
      // An empty paneArgv spreads to nothing, which IS "no trailing shell-command".
      tmuxArgs.push(...paneArgv);
    } else {
      // Older tmux: prefix with env(1). Still multiple arguments, so tmux execs env
      // directly and there is no quoting to get wrong — which is what took
      // shellQuote() with it (#630). Note a session with no command of its own (a
      // plain terminal) gets nothing here, since there is no argv to prefix —
      // pre-existing, and it costs only the pane's locale on tmux < 3.2. The attach
      // client's own `-u` still renders it correctly.
      if (paneArgv.length && Object.keys(extraEnv).length > 0) {
        tmuxArgs.push('env', ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`), ...paneArgv);
      } else {
        tmuxArgs.push(...paneArgv);
      }
    }

    // Create the tmux session
    try {
      this._exec(tmuxArgs, { timeout: 10000 });
    } catch (e) {
      throw new Error(`Failed to create tmux session ${sessionName}: ${e.message}`);
    }

    // Options (status bar, mouse, clipboard) are applied by _attach() — see
    // _applySessionOptions(). Attach to the tmux session via a PTY for I/O.
    this._attach(id, cols, rows);
  }

  /**
   * The tmux options a deepsteve pane needs, applied to ONE session we own.
   *
   * Called from _attach() rather than from spawn(), and that placement is the point:
   * the tmux SERVER outlives the daemon (#620), so a session created by an older
   * daemon is still running after an upgrade and spawn() will never run for it again.
   * _attach() is the one place every live session passes through — new (spawn),
   * surviving (reattach at startup, tmux-reattach.js) and repaired (the #626 silent
   * re-attach) — so applying them here is what makes a new option reach an old session
   * on the next restart, with no migration step to remember.
   *
   * Never the user's own tmux server. `socket === null` is the deliberate "tmux's
   * default per-UID socket" engine (userTmux(), #625); `set-clipboard` in particular is
   * a SERVER option, so applying it there would change every tmux session on the box.
   * That engine reaches only hasSession/listAllSessions/attachSpawnArgs today, so this
   * is a guard against a future caller rather than a live bug — which is why it is a
   * guard and not a comment.
   *
   * One option per invocation: tmux has no multi-option form, and chaining with `;`
   * would put a shell-ish parsing layer back into an argv that #630 spent an issue
   * deleting. Individually caught so one unknown option on an old tmux cannot cost the
   * others.
   */
  _applySessionOptions(sessionName) {
    if (!this._socket) return;

    // Disable status bar — it steals a row from the pane, causing dimension
    // mismatch between what xterm.js reports and what programs inside see.
    const options = [['-t', sessionName, 'status', 'off']];

    // #650: the wheel. Since #620 every PTY is a tmux pane, and tmux with `mouse off`
    // never turns mouse reporting on for its client — so xterm.js saw no mouse protocol
    // at all, fell into its "alternate buffer, no scrollback" branch, and translated
    // every wheel notch into ESC[A / ESC[B. Those are Up and Down arrows: scrolling an
    // agent tab walked Claude's prompt history instead of the terminal. With `mouse on`
    // tmux's own default root binding decides instead — `send-keys -M` into a pane that
    // owns the alternate screen or asked for the mouse (Claude, vim, less), `copy-mode
    // -e` into a plain shell pane — and xterm sends real SGR mouse reports.
    //
    // `-t <session>`, never `-g`: this is the narrowest scope the option has.
    if (this._supportsMouseOption) options.push(['-t', sessionName, 'mouse', 'on']);

    // #650, the other half. With the mouse on, a drag-select belongs to tmux or to the
    // pane's program rather than to the browser, so a copy comes back to us as OSC 52
    // instead of landing in the system clipboard by itself. public/js/osc-clipboard.js
    // catches it; this is what makes tmux emit it for its own copy-mode copies (the
    // default, `external`, only forwards one a program inside the pane sent).
    //
    // `-s` because set-clipboard is a SERVER option — it has no narrower scope to ask
    // for. That is only safe because #625 made this socket ours alone, which is also
    // what the `!this._socket` guard above is protecting. Ungated: the option predates
    // the tmux 2.0 multi-arg shell-command this engine already requires.
    options.push(['-s', 'set-clipboard', 'on']);

    // The scrollbar. tmux's attach client sends smcup (ESC[?1049h) on attach, so the
    // browser's xterm sits on its ALTERNATE buffer forever — and a terminal with no
    // scrollback has nothing to scroll and no scrollbar to draw. Since Claude Code
    // 2.1.24x the pane owns an alternate screen too, so tmux's own history stays at 0
    // lines: with both screens alternate there is no scrollback ANYWHERE in the stack.
    // Deleting smcup/rmcup from the client's terminal description keeps the client on
    // xterm's normal buffer, and lines that scroll off the pane land in xterm's own
    // scrollback — which is all xterm needs to show its native scrollbar again.
    //
    // The client's description, not the pane's: `alternate-screen off` (a WINDOW
    // option) fills tmux's history instead and changes nothing in the browser.
    //
    // Two costs, both measured. The copy is lossy — tmux coalesces redraws when output
    // outruns the client, so a fast burst loses a few percent of its lines. And the
    // wheel still belongs to the pane whenever the pane asked for the mouse (Claude
    // does), so the wheel scrolls Claude's own view while the scrollbar walks xterm's
    // history. What it does NOT cost is redraw junk: resizes and reattaches repaint
    // within the visible screen and push nothing into scrollback.
    //
    // Unset when off, never merely skipped: this is a SERVER option on a tmux server
    // that outlives the daemon (#620), so an entry written by a previous boot is still
    // there after the setting is turned off. See _supportsIndexedArrayOption for why
    // the index is what makes both halves idempotent.
    if (this._browserScrollback && this._supportsIndexedArrayOption) {
      options.push(this._browserScrollback()
        ? ['-s', SCROLLBACK_OVERRIDE_OPTION, SCROLLBACK_OVERRIDE_VALUE]
        : ['-su', SCROLLBACK_OVERRIDE_OPTION]);
    }

    for (const opt of options) {
      try {
        this._exec(['set-option', ...opt]);
      } catch {}
    }
  }

  /**
   * Everything needed to spawn an attach client, as `{ file, argv, opts }` (#624).
   *
   * Public and separate from _attach() because there are TWO attach call sites —
   * this engine, and server.js's `tmux-attach` WS path, which drives a raw node-pty
   * for a session it doesn't own. They were independent copies and drifted; there
   * is now one definition, so a fix can't land in only one of them.
   *
   * What the flags are for — both are top-level, `attach-session` accepts neither:
   *
   *   -u          tmux writes UTF-8 to this client regardless of its locale. Without
   *               it, tty_check_codeset() replaces every non-ASCII glyph with the
   *               right number of underscores, which is what turned the Claude Code
   *               banner into `_______`. `-u` rather than locale alone because it
   *               cannot be defeated by a hostile LC_ALL=C, and it has existed since
   *               tmux 1.x, so it needs no version gate.
   *   -T RGB,256  Assert 24-bit colour instead of letting tmux probe for it. Our
   *               consumer is xterm.js, which is unconditionally truecolor, so this
   *               is a fact about deepsteve rather than a guess about a terminal.
   *               Without it tmux quantizes every 24-bit SGR to the 256-colour
   *               palette. Per-CLIENT deliberately: `set -as terminal-features` is
   *               server-global, and while #625 means that server is now ours alone,
   *               a per-client assertion is still the narrower and more honest one.
   *
   * `-S <socket>` leads the argv when this engine has one (#625) — it is a top-level
   * flag like the two above, and putting it here rather than at the call sites is what
   * keeps the socket and the attach recipe from drifting apart the way the two attach
   * paths themselves once did.
   *
   * And the env: the daemon's, plus a UTF-8 locale so the agent's own toolkit picks
   * its Unicode glyph set (Ink and friends gate on LC_CTYPE), minus the vars node-pty
   * only strips when it owns the env object.
   */
  attachSpawnArgs(sessionName, cols, rows) {
    const argv = [...this._socketArgs(), '-u'];
    if (this._supportsFeaturesFlag) argv.push('-T', 'RGB,256');
    argv.push('attach-session', '-t', sessionName);

    const env = { ...this._env, ...terminalEnv({ env: this._env }) };
    for (const key of PTY_UNSAFE_ENV) delete env[key];

    return {
      file: this._tmuxPath || 'tmux',
      argv,
      opts: { name: 'xterm-256color', cols: cols || 120, rows: rows || 40, env },
    };
  }

  /**
   * Open (or re-open) the attach PTY for a session.
   *
   * @param {string} id
   * @param {number} cols
   * @param {number} rows
   * @param {object} [carry] - the previous entry, when this is a silent re-attach.
   *   Carrying `dataCallbacks`/`exitCallbacks` forward is LOAD-BEARING: onData()
   *   and onExit() push into whatever entry is current at registration time, so a
   *   re-attach that started with empty arrays would leave the session deaf and
   *   its eventual exit unnoticed.
   */
  _attach(id, cols, rows, carry) {
    const sessionName = this._tmuxSessionName(id);
    // Before the PTY, so the client comes up already in mouse mode rather than being
    // switched a beat after it has drawn.
    this._applySessionOptions(sessionName);
    const { file, argv, opts } = this.attachSpawnArgs(sessionName, cols, rows);
    const attachPty = this._spawnPty(file, argv, opts);

    const entry = {
      attachPty,
      exitCallbacks: carry ? carry.exitCallbacks : [],
      dataCallbacks: carry ? carry.dataCallbacks : [],
      // Remembered so a silent re-attach comes back at the same size instead of
      // snapping the pane to the 120x40 default.
      cols: cols || 120,
      rows: rows || 40,
      reattachAttempts: carry ? carry.reattachAttempts : 0,
      attachedAt: this._now(),
    };
    this._sessions.set(id, entry);

    attachPty.onData((data) => {
      for (const cb of entry.dataCallbacks) {
        try { cb(data); } catch {}
      }
    });

    attachPty.onExit(({ exitCode, signal }) => {
      // A deliberate detach() or destroy() is not an exit (#620). Without this the
      // daemon's universal 'exit' funnel would tombstone a session whose agent is
      // still running happily in tmux — which is the whole point of detaching.
      if (entry.detaching) return;

      // The attach PTY is our PIPE into the pane, not the agent itself (#626). If
      // tmux still has the session, the agent is alive and it was our pipe that
      // broke — reporting an exit here tombstones a live agent, and the next boot
      // then reads that `closed` record and destroys the still-running tmux
      // session as "the kill didn't take". So ask tmux, and re-attach instead.
      //
      // Bounded, because an attach that fails instantly (a tmux server refusing
      // connections, a socket we cannot reach) would otherwise spin forever. An
      // attach that lived a good while before dying is a fresh incident, not
      // another strike — see REATTACH_RESET_MS for why that is measured in time
      // rather than in "did it produce output?".
      const strikes = (this._now() - entry.attachedAt) >= REATTACH_RESET_MS ? 0 : entry.reattachAttempts;
      if (this._sessions.get(id) === entry
          && strikes < MAX_SILENT_REATTACHES
          && this._tmuxSessionAlive(id)) {
        const attempt = strikes + 1;
        this._sessions.delete(id);
        try {
          this._attach(id, entry.cols, entry.rows, { ...entry, reattachAttempts: attempt });
          this.emit('reattach', id, attempt);
          return;
        } catch (e) {
          // Couldn't rebuild the pipe. Fall through and report the exit — a
          // session we cannot read is worse than one we admit we lost.
          this.emit('reattach-failed', id, attempt, e);
        }
      }

      // Drop the entry so has() stops lying and write() stops writing into a
      // dead attach PTY. Guarded like node-pty's (engines/node-pty.js) because
      // an exit handler may have already re-attached a fresh PTY under this id.
      if (this._sessions.get(id) === entry) this._sessions.delete(id);
      for (const cb of entry.exitCallbacks) {
        try { cb({ exitCode, signal }); } catch {}
      }
      this.emit('exit', id, exitCode, signal);
    });
  }

  /**
   * Release a session without ending it: tear down our attach PTY and forget
   * the session, leaving the tmux session (and the agent inside it) running.
   *
   * This is what makes a daemon restart non-destructive (#620) — the agent keeps
   * working through the restart and startup's reattach picks it back up. The
   * `detaching` flag is load-bearing: killing the attach PTY fires its onExit,
   * and without the flag that reports an exit for a session that never exited.
   */
  detach(id) {
    const entry = this._sessions.get(id);
    if (!entry) return false;
    entry.detaching = true;
    this._sessions.delete(id);
    try { entry.attachPty.kill(); } catch {}
    return true;
  }

  get canDetach() {
    return true;
  }

  /** Reattach to an existing tmux session (e.g. after daemon restart). */
  reattach(id, cols, rows) {
    if (!this._tmuxSessionAlive(id)) return false;
    this._attach(id, cols, rows);
    return true;
  }

  _tmuxSessionAlive(id) {
    const sessionName = this._tmuxSessionName(id);
    try {
      this._exec(['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  write(id, data) {
    const entry = this._sessions.get(id);
    if (!entry) return;
    // Ground truth: the bytes this daemon puts on the pane, observed at the boundary
    // rather than inferred from the layer that asked for them. Ahead of the CSI-u
    // branch below so a raw-hex send is seen too. Set by server.js; a throwing
    // observer must never cost a keystroke.
    if (this.onWrite) { try { this.onWrite(id, data); } catch {} }

    // CSI u sequences (e.g., \x1b[13;2u for Shift+Enter) aren't passed through
    // by tmux's input parser. Send as raw hex bytes directly to the pane.
    if (data.length < 20 && /^\x1b\[\d+;\d+u$/.test(data)) {
      try {
        const sessionName = this._tmuxSessionName(id);
        const hex = [...Buffer.from(data)].map(b => b.toString(16).padStart(2, '0'));
        this._exec(['send-keys', '-t', sessionName, '-H', ...hex]);
        return;
      } catch {
        // Fall through to direct write on failure
      }
    }

    entry.attachPty.write(data);
  }

  /**
   * Paste a block of text straight into the pane, bypassing the attach client (#656).
   *
   * write() sends bytes down the attach PTY — the stdin of our `tmux attach-session`
   * client. That tty has a kernel input queue holding MAX_INPUT (1022 bytes on
   * macOS), and a multi-kilobyte prompt necessarily sits in it partly unread while
   * the client drains it. Anything that flushes that queue takes a whole queue-full
   * of our text with it, silently: two live deliveries lost 2026 and 2038 contiguous
   * characters off the HEAD of ~2.4KB prompts, and the agent recorded only the tail.
   *
   * load-buffer/paste-buffer removes that hop entirely. The text goes into the tmux
   * server over the command socket and the server writes it into the pane through its
   * own bufferevent, which handles a slow reader by waiting rather than by losing
   * bytes. It also lets tmux, which is the only party that knows, decide about
   * bracketing.
   *
   * Three flags, none of them optional:
   *   -r  do NOT replace linefeeds. paste-buffer's DEFAULT is to turn every LF into a
   *       CR (tmux(1): "any linefeed (LF) characters in the paste buffer are replaced
   *       with a separator, by default carriage return"). Our prompts are multi-line,
   *       so without -r each newline arrives as Enter and the prompt submits itself a
   *       line at a time.
   *   -p  insert bracketed-paste markers, but only "if the application has requested
   *       bracketed paste mode". tmux tracks the pane's real mode 2004 state and we
   *       cannot, so this fails safe: a pane without it gets exactly today's bytes
   *       rather than a literal `[200~` in its composer.
   *   -d  delete the buffer afterwards. Explicitly named buffers are NOT subject to
   *       `buffer-limit`, so one that outlives its paste is a leak; the catch below
   *       deletes it again for the case where paste-buffer itself failed.
   *
   * NOT ordered against write(). write() is one stream down the client PTY; this goes
   * around it. Callers must not interleave the two for a single logical input.
   *
   * Falls back to write() on any failure — a pane sitting in copy-mode ignores
   * paste-buffer, and an unreachable tmux server must not lose the prompt.
   */
  pasteText(id, text) {
    const entry = this._sessions.get(id);
    if (!entry) return;
    if (!text) return;
    const bufferName = `ds-${id}`;
    try {
      this._exec(['load-buffer', '-b', bufferName, '-'], { input: text });
      this._exec(['paste-buffer', '-b', bufferName, '-t', this._tmuxSessionName(id), '-p', '-r', '-d']);
      return;
    } catch {
      try { this._exec(['delete-buffer', '-b', bufferName]); } catch { /* already gone */ }
      entry.attachPty.write(text);
    }
  }

  resize(id, cols, rows) {
    const entry = this._sessions.get(id);
    if (!entry) return;
    // Only resize the attach PTY — tmux auto-adjusts the window/pane via
    // SIGWINCH. Calling resize-window explicitly races with this and can
    // leave dimensions out of sync.
    try {
      entry.attachPty.resize(cols, rows);
    } catch {}
  }

  kill(id, signal) {
    const sessionName = this._tmuxSessionName(id);
    // Try to get the pane PID and kill the process group
    try {
      const pid = this._getPanePid(id);
      if (pid) {
        try { process.kill(-pid, signal); } catch {}
        return;
      }
    } catch {}
    // Fallback: kill the tmux session
    try {
      this._exec(['kill-session', '-t', sessionName]);
    } catch {}
  }

  _getPanePid(id) {
    const sessionName = this._tmuxSessionName(id);
    try {
      const out = this._exec(['display-message', '-t', sessionName, '-p', '#{pane_pid}'], {
        encoding: 'utf8',
      }).trim();
      return parseInt(out, 10) || null;
    } catch {
      return null;
    }
  }

  getPid(id) {
    return this._getPanePid(id);
  }

  destroy(id) {
    const entry = this._sessions.get(id);
    if (entry) {
      // Same flag detach() uses, and required for the same reason it is there —
      // but here it suppresses the #626 silent re-attach rather than the exit
      // report. Killing the attach PTY fires its onExit *before* the kill-session
      // below has run, so has-session still answers "alive" and we would helpfully
      // re-attach to the session we are in the middle of destroying.
      entry.detaching = true;
      try { entry.attachPty.kill(); } catch {}
    }
    this._sessions.delete(id);
    // Kill the tmux session if still alive
    const sessionName = this._tmuxSessionName(id);
    try {
      this._exec(['kill-session', '-t', sessionName]);
    } catch {}
  }

  onExit(id, callback) {
    const entry = this._sessions.get(id);
    if (entry) entry.exitCallbacks.push(callback);
  }

  onData(id, callback) {
    const entry = this._sessions.get(id);
    if (entry) entry.dataCallbacks.push(callback);
  }

  removeDataListener(id, handler) {
    const entry = this._sessions.get(id);
    if (entry) entry.dataCallbacks = entry.dataCallbacks.filter(cb => cb !== handler);
  }

  has(id) {
    return this._sessions.has(id);
  }

  /**
   * List all tmux sessions with the ds- prefix.
   * Returns session IDs (without the prefix).
   */
  listSessions() {
    try {
      const out = this._exec(['list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      }).trim();
      if (!out) return [];
      return out.split('\n')
        .filter(name => name.startsWith(SESSION_PREFIX))
        .map(name => name.slice(SESSION_PREFIX.length));
    } catch {
      return [];
    }
  }

  /**
   * Every tmux session on THIS ENGINE'S socket — what the "Attach tmux session" menu
   * lists. Rows: { name, windows, width, height, created }.
   *
   * Since #625 that menu is about the USER's own tmux, so server.js calls this on the
   * `socket: null` engine (userTmux()), never on the daemon's own. Called on the
   * daemon's engine it would just list our `ds-*` sessions, which all already have
   * tabs — hence "attach to a session deepsteve did not create" is now literally what
   * the endpoint returns rather than something the caller has to filter for.
   *
   * Lives here rather than inline in server.js so there is exactly one place that
   * knows how to invoke tmux (#619); the endpoint used to run its own
   * `zsh -l -c 'tmux list-sessions …'`.
   *
   * Pre-existing quirk carried over verbatim: modern tmux (3.6 checked) no longer
   * has `#{session_width}`/`#{session_height}`, so those two come back empty and
   * parse to NaN — as they did before this moved, with the same format string. Kept
   * as-is because the response shape is public and the only consumer
   * (public/js/app.js's "Attach tmux session" submenu) renders just name + attached.
   */
  listAllSessions() {
    try {
      const fmt = '#{session_name}\t#{session_windows}\t#{session_width}\t#{session_height}\t#{session_created}';
      const out = this._exec(['list-sessions', '-F', fmt], { encoding: 'utf8' }).trim();
      if (!out) return [];
      return out.split('\n').map(line => {
        const [name, windows, width, height, created] = line.split('\t');
        return {
          name,
          windows: parseInt(windows) || 1,
          width: parseInt(width),
          height: parseInt(height),
          created: parseInt(created) || null,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Does a tmux session with this name exist on THIS ENGINE'S socket? The companion
   * to listAllSessions() and, like it, called on userTmux() since #625 — it gate-keeps
   * the tmux-attach path, whose names come straight out of that listing.
   *
   * Takes a RAW, user-supplied name —
   * safe because it becomes one argv element, never a shell word. (It used to be
   * interpolated into `zsh -l -c 'tmux has-session -t "…"'` with only `"` escaped,
   * so a name containing `'` or `$(…)` reached a login shell.)
   *
   * tmux's own lenient target matching (exact, then prefix, then fnmatch) is left
   * as-is — server.js's attach-session call matches the same way, and the names the
   * UI passes come straight out of listAllSessions().
   */
  hasSession(name) {
    try {
      this._exec(['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a specific session can be reattached. */
  canReattach(id) {
    return this._tmuxSessionAlive(id);
  }
}

module.exports = TmuxEngine;
