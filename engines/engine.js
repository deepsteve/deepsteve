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

  /**
   * Deliver a large block of text to a session as a PASTE rather than as keystrokes.
   *
   * Separate from write() because it is allowed to take a different route to the
   * child, and the base implementation is exactly write() so no engine has to
   * implement it. An engine that overrides this must document two things: whether
   * the route bypasses the ordered write() stream (tmux's does), and how the child
   * is told where the paste ends.
   *
   * Callers use it for multi-kilobyte prompts (#656); everything keystroke-shaped
   * stays on write().
   */
  pasteText(id, text) {
    return this.write(id, text);
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

  /**
   * True if this engine can release a session without ending it — i.e. the
   * process lives somewhere the daemon isn't its parent (#620). Callers ask this
   * rather than sniffing the class, the same way they ask `available`.
   */
  get canDetach() {
    return false;
  }

  /**
   * Release a session without killing it, and without reporting an exit.
   * Only meaningful when `canDetach` is true; the base is a no-op returning
   * false so a caller can fall through to kill().
   */
  detach(id) {
    return false;
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
