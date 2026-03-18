const EventEmitter = require('events');

/**
 * Base class for terminal engine backends.
 * Each engine manages terminal sessions by ID, emitting 'data' and 'exit' events.
 *
 * Events:
 *   'data' (id, data)          — terminal output from session
 *   'exit' (id, exitCode, signal) — session process exited
 */
class Engine extends EventEmitter {
  /**
   * Start a new terminal session.
   * @param {string} id - Session ID
   * @param {string} cmd - Command to run (e.g. 'zsh')
   * @param {string[]} args - Command arguments
   * @param {string} cwd - Working directory
   * @param {{ cols: number, rows: number, env: object }} opts
   */
  spawn(id, cmd, args, cwd, opts) {
    throw new Error('spawn() not implemented');
  }

  /** Write data to a session's stdin. */
  write(id, data) {
    throw new Error('write() not implemented');
  }

  /** Resize a session's terminal. */
  resize(id, cols, rows) {
    throw new Error('resize() not implemented');
  }

  /** Send a signal to a session's process. */
  kill(id, signal) {
    throw new Error('kill() not implemented');
  }

  /** Get the PID of a session's process. Returns null if not found. */
  getPid(id) {
    throw new Error('getPid() not implemented');
  }

  /** Clean up a session (remove from internal tracking). */
  destroy(id) {
    throw new Error('destroy() not implemented');
  }

  /** Register an exit handler for a session. */
  onExit(id, callback) {
    throw new Error('onExit() not implemented');
  }

  /** Register a data handler for a specific session. */
  onData(id, callback) {
    throw new Error('onData() not implemented');
  }

  /** Remove a specific data listener for a session. */
  removeDataListener(id, handler) {
    throw new Error('removeDataListener() not implemented');
  }

  /** Check if a session exists in this engine. */
  has(id) {
    return false;
  }

  /** List all managed session IDs. */
  listSessions() {
    return [];
  }
}

module.exports = Engine;
