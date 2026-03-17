const pty = require('node-pty');
const { execFileSync } = require('child_process');
const Engine = require('./engine');

const SESSION_PREFIX = 'ds-';

/** Shell-quote a string for use in a single zsh -c layer. */
function shellQuote(s) {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Run a tmux command via zsh -l -c (for Homebrew PATH). */
function tmuxExec(args, opts = {}) {
  const cmd = ['tmux', ...args.map(shellQuote)].join(' ');
  return execFileSync('zsh', ['-l', '-c', cmd], { timeout: 5000, stdio: 'pipe', ...opts });
}

/**
 * tmux engine — each session runs inside a tmux session named ds-{id}.
 * A node-pty is used to `tmux attach-session` for I/O streaming, so all
 * PTY output (escape sequences, BEL detection) works unchanged.
 *
 * tmux sessions survive daemon restarts; on startup, listSessions() returns
 * surviving sessions that can be reattached.
 */
class TmuxEngine extends Engine {
  constructor() {
    super();
    this._sessions = new Map(); // id → { attachPty, exitCallbacks }
    this._tmuxVersion = null;
    this._checkTmux();
  }

  _checkTmux() {
    try {
      const out = tmuxExec(['-V'], { encoding: 'utf8' }).trim();
      const match = out.match(/(\d+\.\d+)/);
      this._tmuxVersion = match ? match[1] : out;
    } catch {
      this._tmuxVersion = null;
    }
  }

  get available() {
    return this._tmuxVersion !== null;
  }

  get version() {
    return this._tmuxVersion;
  }

  /** Check if tmux supports -e flag (>= 3.2) */
  get _supportsEnvFlag() {
    if (!this._tmuxVersion) return false;
    const parts = this._tmuxVersion.split('.').map(Number);
    return parts[0] > 3 || (parts[0] === 3 && parts[1] >= 2);
  }

  _tmuxSessionName(id) {
    return SESSION_PREFIX + id;
  }

  spawn(id, cmd, args, cwd, { cols = 120, rows = 40, env } = {}) {
    const sessionName = this._tmuxSessionName(id);

    // spawnSession wraps commands in zsh -l -c <cmd>. tmux new-session
    // already runs its command in $SHELL, so unwrap to avoid nested quoting.
    let fullCmd;
    if (cmd === 'zsh' && args.length === 3 && args[0] === '-l' && args[1] === '-c') {
      fullCmd = args[2]; // already shell-escaped by spawnSession
    } else if (cmd === 'zsh' && args.length === 1 && args[0] === '-l') {
      fullCmd = null; // plain login shell — tmux default
    } else {
      fullCmd = [cmd, ...args.map(a => shellQuote(a))].join(' ');
    }

    const tmuxArgs = ['new-session', '-d', '-s', sessionName, '-x', String(cols), '-y', String(rows)];
    if (cwd) tmuxArgs.push('-c', cwd);

    // Pass environment variables
    const extraEnv = {};
    if (env) {
      for (const [key, val] of Object.entries(env)) {
        if (val !== undefined && val !== process.env[key]) {
          extraEnv[key] = val;
        }
      }
    }

    if (this._supportsEnvFlag) {
      // tmux >= 3.2: use -e KEY=VAL
      for (const [key, val] of Object.entries(extraEnv)) {
        tmuxArgs.push('-e', `${key}=${val}`);
      }
      if (fullCmd) tmuxArgs.push(fullCmd);
    } else {
      // Older tmux: wrap with env command
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
      tmuxExec(tmuxArgs, { timeout: 10000 });
    } catch (e) {
      throw new Error(`Failed to create tmux session ${sessionName}: ${e.message}`);
    }

    // Attach to the tmux session via a PTY for I/O
    this._attach(id, cols, rows);
  }

  _attach(id, cols, rows) {
    const sessionName = this._tmuxSessionName(id);
    const attachPty = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 40,
    });

    const entry = { attachPty, exitCallbacks: [] };
    this._sessions.set(id, entry);

    attachPty.onData((data) => {
      this.emit('data', id, data);
    });

    attachPty.onExit(({ exitCode, signal }) => {
      // Check if the tmux session is still alive
      const alive = this._tmuxSessionAlive(id);
      if (alive) {
        // Attach PTY died but tmux session lives — could reattach later
        // For now, treat as exit since the engine consumer expects it
      }
      for (const cb of entry.exitCallbacks) {
        try { cb({ exitCode, signal }); } catch {}
      }
      this.emit('exit', id, exitCode, signal);
    });
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
      tmuxExec(['has-session', '-t', sessionName]);
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
        tmuxExec(['send-keys', '-t', sessionName, '-H', ...hex]);
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
    const sessionName = this._tmuxSessionName(id);
    try {
      tmuxExec(['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)]);
    } catch {}
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
      tmuxExec(['kill-session', '-t', sessionName]);
    } catch {}
  }

  _getPanePid(id) {
    const sessionName = this._tmuxSessionName(id);
    try {
      const out = tmuxExec(['display-message', '-t', sessionName, '-p', '#{pane_pid}'], {
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
      tmuxExec(['kill-session', '-t', sessionName]);
    } catch {}
  }

  onExit(id, callback) {
    const entry = this._sessions.get(id);
    if (entry) entry.exitCallbacks.push(callback);
  }

  removeDataListener(id, handler) {
    const entry = this._sessions.get(id);
    if (entry) entry.attachPty.removeListener('data', handler);
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
      const out = tmuxExec(['list-sessions', '-F', '#{session_name}'], {
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

  /** Check if a specific session can be reattached. */
  canReattach(id) {
    return this._tmuxSessionAlive(id);
  }
}

module.exports = TmuxEngine;
