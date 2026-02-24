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
    const shellCmd = `claude ${args.join(' ')}`;
    const shell = pty.spawn('zsh', ['-l', '-c', shellCmd], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env
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
