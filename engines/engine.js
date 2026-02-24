/**
 * Base engine class and factory for shell backends.
 *
 * An engine abstracts the raw PTY/tmux lifecycle: spawn, write, resize,
 * output streaming, kill. All Claude-specific business logic (BEL detection,
 * scrollback, waitingForInput, etc.) stays in server.js.
 *
 * Engine.spawn() returns a shell handle with a uniform API:
 *   .write(data)           - send data to the shell
 *   .resize(cols, rows)    - resize the terminal
 *   .kill(signal?)         - kill the process
 *   .pid                   - process ID (or virtual ID for tmux)
 *   .onData(callback)      - register output listener
 *   .onExit(callback)      - register exit listener
 *   .on(event, callback)   - EventEmitter-style listener
 *   .removeListener(event, callback) - remove listener
 */

class Engine {
  constructor(name, settings, log) {
    this.name = name;
    this.settings = settings;
    this.log = log;
  }

  /**
   * Spawn a new shell.
   * @param {string} id - Session ID
   * @param {string[]} args - Claude CLI arguments
   * @param {string} cwd - Working directory
   * @param {{cols: number, rows: number}} size - Terminal dimensions
   * @returns {object} Shell handle with uniform API
   */
  spawn(id, args, cwd, size) {
    throw new Error('Engine.spawn() must be implemented by subclass');
  }

  /**
   * List active session IDs managed by this engine.
   * @returns {string[]}
   */
  listSessions() {
    throw new Error('Engine.listSessions() must be implemented by subclass');
  }

  /**
   * Check if a session exists (survived a restart, etc.).
   * @param {string} id - Session ID
   * @returns {boolean}
   */
  hasSession(id) {
    throw new Error('Engine.hasSession() must be implemented by subclass');
  }

  /**
   * Clean up engine resources.
   */
  dispose() {}
}

/**
 * Create the appropriate engine based on settings.
 * Falls back to pty if tmux is requested but not available.
 */
function createEngine(settings, log) {
  const engineType = settings.engine || 'pty';

  if (engineType === 'tmux') {
    try {
      const { TmuxEngine } = require('./tmux-engine');
      const engine = new TmuxEngine(settings, log);
      log(`Engine: tmux`);
      return engine;
    } catch (e) {
      log(`tmux engine failed to initialize: ${e.message} — falling back to pty`);
    }
  }

  const { PtyEngine } = require('./pty-engine');
  log(`Engine: pty`);
  return new PtyEngine(settings, log);
}

module.exports = { Engine, createEngine };
