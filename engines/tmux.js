const { execFileSync } = require('child_process');
const Engine = require('./engine');
const { probeTmux } = require('../tmux-path');
const { terminalEnv, TERMINAL_ENV_KEYS } = require('../terminal-env');

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
 * Shell-quote a string for the command line **tmux itself** runs via $SHELL.
 *
 * This is NOT about how we invoke tmux — that goes through execFileSync with an
 * argv array (#619), so there is no shell of ours to quote for. It is about the
 * single `shell-command` argument `tmux new-session` takes, which tmux hands to a
 * shell; the two remaining callers below both build that string.
 */
function shellQuote(s) {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

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
 */
class TmuxEngine extends Engine {
  /**
   * @param {{binary?: string, env?: object, exec?: Function, spawnPty?: Function}} [opts]
   *   binary — the `tmuxBinary` setting: a bare name to search for, or an explicit
   *   path. exec/env/spawnPty are injection points for tests; spawnPty stands in for
   *   pty.spawn so the attach/detach lifecycle can be tested on a box with no tmux
   *   (which is exactly what the CI unit job is).
   *
   *   `env` is the daemon's environment. It reaches the $PATH probe *and*, since
   *   #624, every runtime read of it — the spawn-time diff against what the pane
   *   would inherit anyway, and the env the attach client is given. That is what
   *   makes the locale bug testable: a test that inherits the runner's env has a
   *   locale and passes against the bug.
   */
  constructor({ binary = 'tmux', env, exec, spawnPty } = {}) {
    super();
    this._sessions = new Map(); // id → { attachPty, exitCallbacks }
    this._binary = binary || 'tmux';
    this._env = env || process.env;
    this._spawnPty = spawnPty || defaultSpawnPty;
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

  /** Run a tmux command directly — argv array, no shell. */
  _exec(args, opts = {}) {
    return this._execFn(this._tmuxPath || 'tmux', args, { timeout: 5000, stdio: 'pipe', ...opts });
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

  _tmuxSessionName(id) {
    return SESSION_PREFIX + id;
  }

  spawn(id, cmd, args, cwd, { cols = 120, rows = 40, env, stripEnv = [], shellCommand } = {}) {
    const sessionName = this._tmuxSessionName(id);

    // tmux new-session already runs its command in $SHELL, so a caller that has
    // itself wrapped the command in a login shell must hand us the INNER command or
    // we nest one shell inside another.
    //
    // `shellCommand` is spawnSession stating that directly (#621), three-way:
    //   undefined → no opinion; build it from cmd+args
    //   null      → a bare login shell, which is tmux's own default
    //   string    → run exactly this
    //
    // It replaced a `cmd === 'zsh'` shape match. That worked only while spawnSession
    // hardcoded the literal string 'zsh'; since #621 cmd is whatever
    // resolveLoginShell() picked — '/bin/zsh' on a Mac, '/bin/bash' on Debian — so a
    // name-based test would have silently stopped matching and re-nested a shell
    // inside every single session. It would still mostly *work*, which is exactly
    // what made it dangerous.
    let fullCmd;
    if (shellCommand !== undefined) {
      fullCmd = shellCommand;
    } else {
      fullCmd = [cmd, ...args.map(a => shellQuote(a))].join(' ');
    }

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
      if (fullCmd) tmuxArgs.push(fullCmd);
    } else {
      // Older tmux: wrap with env command. Note a session with no command of its own
      // (a plain terminal) gets nothing here, since there is no argv to prefix —
      // pre-existing, and it costs only the pane's locale on tmux < 3.2. The attach
      // client's own `-u` still renders it correctly.
      if (fullCmd && Object.keys(extraEnv).length > 0) {
        const envPrefix = Object.entries(extraEnv)
          .map(([k, v]) => `${k}=${shellQuote(v)}`)
          .join(' ');
        tmuxArgs.push(`env ${envPrefix} ${fullCmd}`);
      } else if (fullCmd) {
        tmuxArgs.push(fullCmd);
      }
    }

    // Create the tmux session
    try {
      this._exec(tmuxArgs, { timeout: 10000 });
    } catch (e) {
      throw new Error(`Failed to create tmux session ${sessionName}: ${e.message}`);
    }

    // Disable status bar — it steals a row from the pane, causing dimension
    // mismatch between what xterm.js reports and what programs inside see.
    try {
      this._exec(['set-option', '-t', sessionName, 'status', 'off']);
    } catch {}

    // Attach to the tmux session via a PTY for I/O
    this._attach(id, cols, rows);
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
   *               server-global and we share the user's default socket.
   *
   * And the env: the daemon's, plus a UTF-8 locale so the agent's own toolkit picks
   * its Unicode glyph set (Ink and friends gate on LC_CTYPE), minus the vars node-pty
   * only strips when it owns the env object.
   */
  attachSpawnArgs(sessionName, cols, rows) {
    const argv = ['-u'];
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

  _attach(id, cols, rows) {
    const sessionName = this._tmuxSessionName(id);
    const { file, argv, opts } = this.attachSpawnArgs(sessionName, cols, rows);
    const attachPty = this._spawnPty(file, argv, opts);

    const entry = { attachPty, exitCallbacks: [], dataCallbacks: [] };
    this._sessions.set(id, entry);

    attachPty.onData((data) => {
      for (const cb of entry.dataCallbacks) {
        try { cb(data); } catch {}
      }
    });

    attachPty.onExit(({ exitCode, signal }) => {
      // A deliberate detach() is not an exit (#620). Without this the daemon's
      // universal 'exit' funnel would tombstone a session whose agent is still
      // running happily in tmux — which is the whole point of detaching.
      if (entry.detaching) return;
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
   * Every tmux session on the box, not just ours — what the "Attach tmux session"
   * menu lists. Rows: { name, windows, width, height, created }.
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
   * Does a tmux session with this name exist? Takes a RAW, user-supplied name —
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
