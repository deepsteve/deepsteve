const pty = require('node-pty');
const Engine = require('./engine');

/**
 * node-pty engine — spawns PTY processes directly.
 * This is the default engine, extracted from the original inline code in server.js.
 */
class NodePtyEngine extends Engine {
  constructor() {
    super();
    this._ptys = new Map(); // id → { pty, exitCallbacks }
  }

  spawn(id, cmd, args, cwd, { cols = 120, rows = 40, env } = {}) {
    const p = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env || process.env,
    });

    const entry = { pty: p, exitCallbacks: [] };
    this._ptys.set(id, entry);

    p.onData((data) => {
      this.emit('data', id, data);
    });

    p.onExit(({ exitCode, signal }) => {
      for (const cb of entry.exitCallbacks) {
        try { cb({ exitCode, signal }); } catch {}
      }
      this.emit('exit', id, exitCode, signal);
    });
  }

  write(id, data) {
    const entry = this._ptys.get(id);
    if (entry) entry.pty.write(data);
  }

  resize(id, cols, rows) {
    const entry = this._ptys.get(id);
    if (entry) entry.pty.resize(cols, rows);
  }

  kill(id, signal) {
    const entry = this._ptys.get(id);
    if (!entry) return;
    const pid = entry.pty.pid;
    // Try process group kill first, fall back to pty.kill
    try {
      process.kill(-pid, signal);
    } catch {
      try { entry.pty.kill(signal); } catch {}
    }
  }

  getPid(id) {
    const entry = this._ptys.get(id);
    return entry ? entry.pty.pid : null;
  }

  destroy(id) {
    this._ptys.delete(id);
  }

  onExit(id, callback) {
    const entry = this._ptys.get(id);
    if (entry) entry.exitCallbacks.push(callback);
  }

  removeDataListener(id, handler) {
    const entry = this._ptys.get(id);
    if (entry) entry.pty.removeListener('data', handler);
  }

  has(id) {
    return this._ptys.has(id);
  }

  listSessions() {
    return [...this._ptys.keys()];
  }
}

module.exports = NodePtyEngine;
