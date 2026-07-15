/**
 * WebSocket test client for DeepSteve integration tests.
 * Wraps the `ws` package with convenience methods for creating sessions,
 * sending terminal input, and waiting for output patterns.
 *
 * Protocol notes (from server.js):
 * - Server sends the first message as JSON: { type: 'session', id, ... } or { type: 'gone' }
 * - Terminal output is sent as raw strings (not JSON-wrapped)
 * - JSON messages from server include: session, gone, state, shell-exit, settings, etc.
 * - Client sends raw text for terminal input (server calls engine.write(id, str))
 * - Client sends JSON for control messages: { type: 'resize' }, { type: 'rename' }, etc.
 */
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');

const BASE_URL = process.env.DEEPSTEVE_URL || 'http://localhost:3000';

// Auth (#536): the server under test auto-generates ~/.deepsteve/auth-token (0600). We read that
// REAL token — deliberately no override — and present it as a bearer, exactly as a non-browser
// client (an agent, or restart.sh) does. Server and tests share $HOME (local run) or the .deepsteve
// volume (docker-compose), so this is the same file the server just wrote.
function readAuthToken() {
  try {
    return fs.readFileSync(nodePath.join(os.homedir(), '.deepsteve', 'auth-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const AUTH_TOKEN = readAuthToken();
const authHeaders = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};

function httpGet(path) {
  return fetch(`${BASE_URL}${path}`, { headers: { ...authHeaders } }).then(r => r.json());
}

function httpPost(path, body) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

function httpDelete(path) {
  return fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers: { ...authHeaders } }).then(r => r.json());
}

class WsClient {
  constructor() {
    this.ws = null;
    this.messages = [];      // parsed JSON messages
    this.rawOutput = '';      // accumulated raw terminal output
    this.sessionId = null;
    this._messageWaiters = [];
  }

  /**
   * Connect to the server and optionally create a new session.
   * @param {Object} opts - Query parameters (agentType, cwd, new, id, name, etc.)
   * @returns {Promise<Object>} The session message from the server
   */
  connect(opts = {}) {
    return new Promise((resolve, reject) => {
      const wsUrl = BASE_URL.replace(/^http/, 'ws');
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined && v !== null) params.set(k, v);
      }
      const url = `${wsUrl}/?${params}`;

      // Bearer auth (#536), the non-browser WS path — no Origin/cookie needed.
      this.ws = new WebSocket(url, { headers: { ...authHeaders } });

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out'));
      }, 10000);

      this.ws.on('open', () => {
        // Connection opened, wait for session message
      });

      this.ws.on('message', (data) => {
        const str = data.toString();
        // Try to parse as JSON (server sends JSON for control messages)
        let parsed = null;
        try {
          parsed = JSON.parse(str);
        } catch {
          // Not JSON — raw terminal output
          this.rawOutput += str;
          // Notify output waiters
          this._messageWaiters = this._messageWaiters.filter(w => {
            if (w.type === '_output' && w.check(this.rawOutput)) {
              w.resolve(this.rawOutput);
              return false;
            }
            return true;
          });
          return;
        }

        this.messages.push(parsed);

        if (parsed.type === 'session' && !this.sessionId) {
          this.sessionId = parsed.id;
          clearTimeout(timeout);
          resolve(parsed);
        }
        if (parsed.type === 'gone') {
          clearTimeout(timeout);
          resolve(parsed);
        }

        // Notify message waiters
        this._messageWaiters = this._messageWaiters.filter(w => {
          if (w.type !== '_output' && w.check(parsed)) {
            w.resolve(parsed);
            return false;
          }
          return true;
        });
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('close', () => {
        for (const w of this._messageWaiters) {
          w.resolve(null);
        }
        this._messageWaiters = [];
      });
    });
  }

  /**
   * Send raw text to the terminal.
   * The server passes non-JSON messages directly to engine.write().
   */
  sendInput(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(text);
  }

  /**
   * Send a JSON control message to the server (resize, rename, etc.)
   */
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Wait for a JSON message with a specific type.
   * @param {string} type - Message type to wait for
   * @param {number} timeoutMs - Timeout in ms (default 10s)
   */
  waitForMessage(type, timeoutMs = 10000) {
    // Check already-received messages
    const existing = this.messages.find(m => m.type === type);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._messageWaiters = this._messageWaiters.filter(w => w !== waiter);
        reject(new Error(`Timed out waiting for message type "${type}" after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter = {
        type,
        check: (msg) => msg.type === type,
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      };
      this._messageWaiters.push(waiter);
    });
  }

  /**
   * Wait for raw terminal output matching a regex pattern.
   * @param {RegExp} pattern - Regex to match against accumulated output
   * @param {number} timeoutMs - Timeout in ms (default 10s)
   */
  waitForOutput(pattern, timeoutMs = 10000) {
    // Check already-accumulated output
    if (pattern.test(this.rawOutput)) {
      return Promise.resolve(this.rawOutput);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._messageWaiters = this._messageWaiters.filter(w => w !== waiter);
        reject(new Error(`Timed out waiting for output matching ${pattern} after ${timeoutMs}ms. Got: ${this.rawOutput.slice(-500)}`));
      }, timeoutMs);

      const waiter = {
        type: '_output',
        check: (output) => pattern.test(output),
        resolve: (output) => { clearTimeout(timer); resolve(output); },
      };
      this._messageWaiters.push(waiter);
    });
  }

  /**
   * Close the WebSocket connection.
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.sessionId = null;
    this.messages = [];
    this.rawOutput = '';
  }
}

/**
 * Clean up the sessions a single test created, between tests.
 *
 * Deletes ONLY the sessions this test owns — the ids of the passed `clients`
 * plus any `extraIds` (e.g. tabs open_terminal spawned without a WsClient
 * attached). It deliberately does NOT call the global POST /api/shells/killall:
 * this runs in afterEach after every test, and the suite shares one server, so
 * a global kill would wipe sessions owned by other test files running against
 * the same server. That cross-contamination is what produced the intermittent
 * `open_terminal: Session "<id>" not found` flake (the victim's caller session
 * got killed mid-test). Scoping cleanup to owned ids removes the blast radius.
 *
 * Strategy: send 'exit\r' so shells terminate naturally first (a clean PTY exit
 * avoids killShell's Ctrl+C → 8s SIGTERM → 2s SIGKILL escalation timers, which
 * can otherwise SIGTERM a process that reused the old PID). Then DELETE any
 * stragglers with force=1 (bypasses the connected-clients guard) AND forget=1:
 * since #561 every close path — including a natural exit — leaves a `closed`
 * tombstone in savedState, and only an explicit ?forget=1 permanently removes
 * it. Forgetting here keeps test tombstones from accumulating in the shared
 * daemon's state.json. Ids the server never saw return 404 and are ignored.
 *
 * @param {WsClient[]} clients - clients whose sessions to delete
 * @param {string[]} [extraIds] - extra session ids to delete (untracked tabs)
 */
async function cleanupSessions(clients, extraIds = []) {
  // Capture owned ids BEFORE close() nulls out sessionId. A Set dedupes the
  // case where a client is attached to an id that's also in extraIds.
  const ids = new Set();
  for (const c of clients) if (c.sessionId) ids.add(c.sessionId);
  for (const id of extraIds) if (id) ids.add(id);

  // Send exit to each connected client's shell
  for (const c of clients) {
    try { c.sendInput('exit\r'); } catch {}
  }
  // Small delay for shells to process the exit
  await new Promise(r => setTimeout(r, 500));

  // Close WS connections
  for (const c of clients) c.close();

  // Delete only this test's own sessions (force=1 bypasses the connected-clients
  // guard for any shell that didn't exit on its own; forget=1 removes the #561
  // tombstone so tests don't pollute the daemon's state.json).
  await Promise.all(
    [...ids].map(id => httpDelete(`/api/shells/${id}?force=1&forget=1`).catch(() => {}))
  );
  await new Promise(r => setTimeout(r, 500));
}

module.exports = { WsClient, httpGet, httpPost, httpDelete, cleanupSessions, BASE_URL, AUTH_TOKEN };
