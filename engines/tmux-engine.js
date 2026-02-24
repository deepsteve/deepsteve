/**
 * tmux engine — alternative backend using tmux for native session persistence.
 *
 * Each deepsteve session becomes a tmux session named `ds-{id}`.
 * Output is streamed via a named pipe (FIFO) using `tmux pipe-pane`.
 * Input is sent via `tmux send-keys`.
 *
 * The shell handle (TmuxShellHandle) is an EventEmitter that exposes the
 * same interface as a node-pty object.
 */

const { execSync, spawn: cpSpawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Engine } = require('./engine');

const FIFO_DIR = path.join(os.homedir(), '.deepsteve', 'fifos');
const POLL_INTERVAL = 1000; // ms between tmux has-session checks

/**
 * Check if tmux is installed and return its version.
 * @returns {{available: boolean, version: string|null}}
 */
function checkTmux() {
  try {
    const version = execSync('tmux -V', { encoding: 'utf8', timeout: 5000 }).trim();
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

/**
 * Shell handle that mimics the node-pty interface over tmux.
 */
class TmuxShellHandle extends EventEmitter {
  constructor(sessionName, fifoPath, log) {
    super();
    this._sessionName = sessionName;
    this._fifoPath = fifoPath;
    this._log = log;
    this._dead = false;
    this._pid = null;
    this._fifoStream = null;
    this._pollTimer = null;
    this._onDataCallbacks = [];
    this._onExitCallbacks = [];
  }

  get pid() {
    if (this._pid !== null) return this._pid;
    // Try to get the PID of the inner process (Claude)
    try {
      const pane_pid = execSync(
        `tmux display-message -t ${this._sessionName} -p '#{pane_pid}'`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      this._pid = parseInt(pane_pid, 10) || 0;
    } catch {
      this._pid = 0;
    }
    return this._pid;
  }

  /**
   * Start reading output from the FIFO and polling for session death.
   */
  start() {
    this._startFifoReader();
    this._startPollTimer();
  }

  _startFifoReader() {
    // Open the FIFO for reading in non-blocking mode.
    // fs.createReadStream will block until the writer (tmux pipe-pane) opens
    // the other end, which happens right after we set up pipe-pane.
    this._fifoStream = fs.createReadStream(this._fifoPath, { encoding: 'utf8' });

    this._fifoStream.on('data', (data) => {
      this.emit('data', data);
      for (const cb of this._onDataCallbacks) cb(data);
    });

    this._fifoStream.on('error', (err) => {
      if (!this._dead) {
        this._log(`FIFO read error for ${this._sessionName}: ${err.message}`);
      }
    });

    this._fifoStream.on('end', () => {
      // FIFO writer closed — session probably died, poll will confirm
    });
  }

  _startPollTimer() {
    this._pollTimer = setInterval(() => {
      if (this._dead) return;
      try {
        execSync(`tmux has-session -t ${this._sessionName}`, { timeout: 3000 });
      } catch {
        // Session is gone
        this._handleExit();
      }
    }, POLL_INTERVAL);
  }

  _handleExit() {
    if (this._dead) return;
    this._dead = true;

    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._fifoStream) {
      this._fifoStream.destroy();
      this._fifoStream = null;
    }

    // Clean up FIFO
    try { fs.unlinkSync(this._fifoPath); } catch {}

    this.emit('exit', { exitCode: 0, signal: 0 });
    for (const cb of this._onExitCallbacks) cb({ exitCode: 0, signal: 0 });
  }

  /**
   * Send data to the tmux session.
   * Uses `send-keys -l` for literal text, with special handling for
   * control characters.
   */
  write(data) {
    if (this._dead) return;

    try {
      // Map control characters to tmux key names
      if (data === '\r') {
        execSync(`tmux send-keys -t ${this._sessionName} Enter`, { timeout: 3000 });
      } else if (data === '\x03') {
        execSync(`tmux send-keys -t ${this._sessionName} C-c`, { timeout: 3000 });
      } else if (data === '\x04') {
        execSync(`tmux send-keys -t ${this._sessionName} C-d`, { timeout: 3000 });
      } else if (data === '\x0c') {
        execSync(`tmux send-keys -t ${this._sessionName} C-l`, { timeout: 3000 });
      } else if (data === '\x1b[13;2u') {
        // CSI u Shift+Enter — send as literal escape sequence
        execSync(`tmux send-keys -t ${this._sessionName} -l '${escapeTmux(data)}'`, { timeout: 3000 });
      } else {
        // Literal text — escape single quotes for shell
        execSync(`tmux send-keys -t ${this._sessionName} -l '${escapeTmux(data)}'`, { timeout: 3000 });
      }
    } catch (e) {
      this._log(`tmux send-keys failed for ${this._sessionName}: ${e.message}`);
    }
  }

  /**
   * Resize the tmux window.
   */
  resize(cols, rows) {
    if (this._dead) return;
    try {
      execSync(`tmux resize-window -t ${this._sessionName} -x ${cols} -y ${rows}`, { timeout: 3000 });
    } catch (e) {
      // resize can fail if the session just died
    }
  }

  /**
   * Kill the tmux session.
   */
  kill(signal) {
    if (this._dead) return;

    // Try to kill the inner process first
    const pid = this.pid;
    if (pid > 0) {
      try {
        process.kill(pid, signal || 'SIGTERM');
      } catch {}
    }

    // Then kill the tmux session as fallback/cleanup
    try {
      execSync(`tmux kill-session -t ${this._sessionName}`, { timeout: 3000 });
    } catch {}

    this._handleExit();
  }

  /**
   * node-pty compatible callback registration.
   */
  onData(callback) {
    this._onDataCallbacks.push(callback);
    // Return a disposable for compatibility
    return { dispose: () => {
      const idx = this._onDataCallbacks.indexOf(callback);
      if (idx >= 0) this._onDataCallbacks.splice(idx, 1);
    }};
  }

  onExit(callback) {
    this._onExitCallbacks.push(callback);
    return { dispose: () => {
      const idx = this._onExitCallbacks.indexOf(callback);
      if (idx >= 0) this._onExitCallbacks.splice(idx, 1);
    }};
  }
}

/**
 * Escape a string for use inside single-quoted tmux send-keys -l argument.
 * Single quotes need to be ended, escaped, and reopened: 'text'"'"'more'
 */
function escapeTmux(str) {
  return str.replace(/'/g, "'\"'\"'");
}

class TmuxEngine extends Engine {
  constructor(settings, log) {
    super('tmux', settings, log);

    // Verify tmux is available
    const { available, version } = checkTmux();
    if (!available) {
      throw new Error('tmux is not installed');
    }
    this._version = version;
    log(`tmux version: ${version}`);

    this._sessions = new Map(); // id → TmuxShellHandle

    // Ensure FIFO directory exists
    try { fs.mkdirSync(FIFO_DIR, { recursive: true }); } catch {}
  }

  spawn(id, args, cwd, { cols = 120, rows = 40 } = {}) {
    const sessionName = `ds-${id}`;
    const fifoPath = path.join(FIFO_DIR, `${sessionName}.fifo`);

    // Clean up any stale FIFO
    try { fs.unlinkSync(fifoPath); } catch {}

    // Create the FIFO
    execSync(`mkfifo '${fifoPath}'`);

    // Build the command
    const shellCmd = `claude ${args.join(' ')}`;
    // Use login shell to get full environment
    const innerCmd = `zsh -l -c '${escapeTmux(shellCmd)}'`;

    // Create tmux session
    execSync(
      `tmux new-session -d -s ${sessionName} -x ${cols} -y ${rows} -c '${escapeTmux(cwd)}' '${escapeTmux(innerCmd)}'`,
      { timeout: 10000 }
    );

    // Set up pipe-pane to stream output to the FIFO
    execSync(
      `tmux pipe-pane -t ${sessionName} 'cat >> ${fifoPath}'`,
      { timeout: 3000 }
    );

    const handle = new TmuxShellHandle(sessionName, fifoPath, this.log);
    this._sessions.set(id, handle);

    // Start output reader and exit polling
    handle.start();

    // Clean up tracking on exit
    handle.onExit(() => {
      this._sessions.delete(id);
    });

    return handle;
  }

  listSessions() {
    return [...this._sessions.keys()];
  }

  hasSession(id) {
    // Check if tmux still has this session (survives daemon restarts)
    const sessionName = `ds-${id}`;
    try {
      execSync(`tmux has-session -t ${sessionName}`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reattach to an existing tmux session that survived a daemon restart.
   * Returns a shell handle, or null if the session doesn't exist.
   */
  reattach(id, { cols = 120, rows = 40 } = {}) {
    const sessionName = `ds-${id}`;

    // Verify the session exists
    try {
      execSync(`tmux has-session -t ${sessionName}`, { timeout: 3000 });
    } catch {
      return null;
    }

    const fifoPath = path.join(FIFO_DIR, `${sessionName}.fifo`);

    // Clean up any stale FIFO and create a fresh one
    try { fs.unlinkSync(fifoPath); } catch {}
    execSync(`mkfifo '${fifoPath}'`);

    // Re-establish pipe-pane
    execSync(
      `tmux pipe-pane -t ${sessionName} 'cat >> ${fifoPath}'`,
      { timeout: 3000 }
    );

    // Resize to match client
    try {
      execSync(`tmux resize-window -t ${sessionName} -x ${cols} -y ${rows}`, { timeout: 3000 });
    } catch {}

    const handle = new TmuxShellHandle(sessionName, fifoPath, this.log);
    this._sessions.set(id, handle);

    handle.start();
    handle.onExit(() => {
      this._sessions.delete(id);
    });

    return handle;
  }

  dispose() {
    // Stop all poll timers and FIFO readers
    for (const [, handle] of this._sessions) {
      handle._handleExit();
    }
    this._sessions.clear();

    // Clean up FIFOs directory
    try {
      const files = fs.readdirSync(FIFO_DIR);
      for (const f of files) {
        if (f.startsWith('ds-') && f.endsWith('.fifo')) {
          try { fs.unlinkSync(path.join(FIFO_DIR, f)); } catch {}
        }
      }
    } catch {}
  }
}

module.exports = { TmuxEngine, TmuxShellHandle, checkTmux };
