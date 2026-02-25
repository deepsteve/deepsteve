/**
 * node-pty engine — the default backend.
 *
 * Wraps node-pty to implement the Engine interface. The shell handle returned
 * by spawn() is the raw node-pty object itself, since its API already matches
 * the required interface (.write, .resize, .onData, .onExit, .on,
 * .removeListener, .kill, .pid).
 */

const pty = require('node-pty');
const { Engine } = require('./engine');

class PtyEngine extends Engine {
  constructor(settings, log) {
    super('pty', settings, log);
    this._sessions = new Map(); // id → pty object
  }

  spawn(id, args, cwd, { cols = 120, rows = 40 } = {}) {
    // Quote args the same way main's spawnClaude() does
    const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

    // Clone env and delete CLAUDECODE to avoid nested Claude detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const shell = pty.spawn('zsh', ['-l', '-c', `claude ${quoted}`], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    });

    this._sessions.set(id, shell);

    // Clean up tracking when the shell exits
    shell.onExit(() => {
      this._sessions.delete(id);
    });

    return shell;
  }

  listSessions() {
    return [...this._sessions.keys()];
  }

  hasSession(id) {
    return this._sessions.has(id);
  }

  dispose() {
    this._sessions.clear();
  }
}

module.exports = { PtyEngine };
