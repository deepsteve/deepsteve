/**
 * Window manager for multi-browser-tab support.
 * Uses sessionStorage for tab-specific window ID and BroadcastChannel for cross-tab communication.
 */

import { SessionStore } from './session-store.js';
import { nsKey, nsChannel, recursionDepth } from './storage-namespace.js';

const WINDOW_ID_KEY = nsKey('deepsteve-window-id');
const CHANNEL_NAME = nsChannel('deepsteve-windows');
const HEARTBEAT_INTERVAL = 5000;
const ORPHAN_DETECTION_TIMEOUT = 1500;
const LIVE_WINDOW_STALE_MS = 15000;
const SEND_SESSION_ACK_TIMEOUT = 2000;

let channel = null;
let heartbeatTimer = null;
let currentWindowId = null;
// Pending send-session acks: transferId → { resolve, reject, timer }
const pendingTransfers = new Map();
// Live window tracking — continuously updated from BroadcastChannel messages
// Key: windowId, Value: { windowId, sessions: [{id, name}], lastSeen }
const liveWindows = new Map();

// Callbacks set by app.js
let sessionsProvider = null;
let receiveSessionCallback = null;
let focusSessionCallback = null;

function generateWindowId() {
  return 'win-' + Math.random().toString(36).substring(2, 10);
}

// Tabs the server has no record of: it only knows PTY-backed sessions, so these
// live in localStorage alone and can never be validated against it.
function isClientOnly(session) {
  return session.type === 'mod-tab' || session.type === 'display-tab';
}

/**
 * Ask every live window in this browser to identify itself. Resolves to the set of
 * windowIds that answered within ORPHAN_DETECTION_TIMEOUT.
 */
function rollCall() {
  return new Promise((resolve) => {
    const respondents = new Set();
    const tempChannel = new BroadcastChannel(CHANNEL_NAME);

    tempChannel.onmessage = (event) => {
      if (event.data.type === 'present' || event.data.type === 'heartbeat') {
        respondents.add(event.data.windowId);
      }
    };
    tempChannel.postMessage({ type: 'roll-call' });

    setTimeout(() => {
      tempChannel.close();
      resolve(respondents);
    }, ORPHAN_DETECTION_TIMEOUT);
  });
}

/**
 * The server-side window→session map (#551). Sessions outlive the origin their
 * window map was stored on, so localStorage alone can't answer "what did this
 * window own" after an origin change, a cleared jar, or a new browser profile.
 *
 * Returns null — meaning "no server opinion, trust localStorage" — rather than
 * throwing, so an older server, a failed request, or a nested Baby Browser all
 * fall back to the pre-#551 behavior instead of losing the restore modal.
 */
async function fetchServerWindows() {
  // Nested instances are ephemeral and share the parent's origin; their windows
  // stay client-only so they can't offer to restore the top-level window's tabs.
  if (recursionDepth > 0) return null;
  try {
    const res = await fetch('/api/windows');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.windows)) return null;
    return { windows: data.windows, knownSessionIds: new Set(data.knownSessionIds || []) };
  } catch {
    return null;
  }
}

/**
 * Reconcile the server's window→session map with localStorage's.
 *
 * The server is the truth about which sessions still exist; localStorage is the
 * only record of tab order and of client-only tabs. Neither is sufficient alone,
 * so each supplies what the other can't know.
 *
 * Pure and exported for unit testing — see test/unit/window-merge.test.js.
 *
 * @param {object}  local    SessionStore.getAllWindows() — { [windowId]: { sessions, lastActive } }
 * @param {?object} server   { windows, knownSessionIds } from /api/windows, or null if unavailable
 * @param {string}  myWindowId
 * @param {Set}     liveIds  windowIds known to be alive (roll-call ∪ server)
 */
export function mergeWindows({ local, server, myWindowId, liveIds }) {
  const serverById = new Map((server?.windows || []).map(w => [w.windowId, w]));
  const candidates = new Set([...Object.keys(local), ...serverById.keys()]);

  // Who the server currently thinks owns each session. A session grouped under a
  // DIFFERENT window has been claimed since we last wrote localStorage (restored in
  // another browser, say) and is no longer ours to offer. Sessions absent from this
  // map exist but are ungrouped (windowId null) — see the knownSessionIds note below.
  const ownerOf = new Map();
  for (const w of server?.windows || []) {
    for (const s of w.sessions) ownerOf.set(s.id, w.windowId);
  }

  const merged = [];

  for (const windowId of candidates) {
    if (windowId === myWindowId || liveIds.has(windowId)) continue;

    const localWindow = local[windowId];
    const serverWindow = serverById.get(windowId);

    // Start from localStorage: it alone knows tab order and client-only tabs. Drop a
    // session only if the server positively contradicts us — either it no longer
    // exists, or it now belongs to someone else. Existence is tested against
    // knownSessionIds rather than the grouping, so a session that exists but has no
    // windowId (pre-#551 entry, unresolved start-issue window) is still kept.
    const sessions = (localWindow?.sessions || []).filter(s => {
      if (!server || isClientOnly(s)) return true;
      if (!server.knownSessionIds.has(s.id)) return false;
      const owner = ownerOf.get(s.id);
      return owner === undefined || owner === windowId;
    });

    // Then add anything the server groups here that localStorage never saw —
    // including every session when localStorage is gone entirely.
    const seen = new Set(sessions.map(s => s.id));
    for (const s of serverWindow?.sessions || []) {
      if (!seen.has(s.id)) sessions.push({ id: s.id, cwd: s.cwd, name: s.name });
    }

    if (sessions.length === 0) continue; // every session gone — prune the tombstone

    merged.push({
      windowId,
      sessions,
      lastActive: Math.max(localWindow?.lastActive || 0, serverWindow?.lastActive || 0),
    });
  }

  merged.sort((a, b) => b.lastActive - a.lastActive);
  return merged;
}

function pruneStaleWindows() {
  const now = Date.now();
  for (const [id, entry] of liveWindows) {
    if (now - entry.lastSeen > LIVE_WINDOW_STALE_MS) {
      liveWindows.delete(id);
    }
  }
}

export const WindowManager = {
  /**
   * Get or create this tab's window ID
   */
  getWindowId() {
    if (currentWindowId) return currentWindowId;

    // Check sessionStorage first (survives refresh)
    let windowId = sessionStorage.getItem(WINDOW_ID_KEY);
    if (!windowId) {
      windowId = generateWindowId();
      sessionStorage.setItem(WINDOW_ID_KEY, windowId);
    }
    currentWindowId = windowId;
    return windowId;
  },

  /**
   * Check if this tab already has a window ID (existing tab)
   */
  hasExistingWindowId() {
    return sessionStorage.getItem(WINDOW_ID_KEY) !== null;
  },

  /**
   * List windows that appear to be orphaned (no active browser tab).
   *
   * Deliberately does NOT bail when localStorage has no windows: that is exactly
   * the state after an origin change, and bailing early is what left 72 live
   * sessions unrestorable in #551. The server is asked regardless.
   */
  async listOrphanedWindows() {
    const myWindowId = this.getWindowId();
    const local = SessionStore.getAllWindows();
    const server = await fetchServerWindows();

    // Nothing to restore from either side (a genuinely fresh install) — skip the
    // roll-call rather than stalling startup for ORPHAN_DETECTION_TIMEOUT. This is
    // the fast path the old localStorage-only check gave us; it just has to consult
    // the server before concluding there are no candidates.
    if (Object.keys(local).length === 0 && (server?.windows || []).length === 0) return [];

    // Liveness needs both signals. The roll-call reaches windows in THIS browser,
    // which the server can't tell apart (it only ever sees a windowId string). The
    // server reaches windows in other browsers or profiles, which BroadcastChannel
    // can't. After an origin change this is load-bearing: old-origin tabs still open
    // hold live reload sockets, so their windows must not be offered for stealing.
    const liveIds = new Set(await rollCall());
    for (const w of server?.windows || []) {
      if (w.live) liveIds.add(w.windowId);
    }

    return mergeWindows({ local, server, myWindowId, liveIds });
  },

  /**
   * Claim an orphaned window's sessions.
   *
   * Takes the merged window (not just its id) because a server-derived window has
   * no localStorage entry to move sessions out of — reading them back from
   * SessionStore would restore nothing.
   */
  claimWindow(win) {
    const myWindowId = this.getWindowId();

    for (const session of win.sessions) {
      SessionStore.addSession(myWindowId, session);
    }
    // Guard against self-claim: removeWindow would delete what we just wrote.
    if (win.windowId !== myWindowId) {
      SessionStore.removeWindow(win.windowId);
    }

    // No server call needed — restoreSessions reconnects each session WS with our
    // windowId, and the server reassigns entry.windowId on connect.
    return win.sessions;
  },

  /**
   * Start broadcasting presence to other tabs
   */
  startHeartbeat() {
    if (!channel) {
      channel = new BroadcastChannel(CHANNEL_NAME);

      channel.onmessage = (event) => {
        const { data } = event;
        const myId = this.getWindowId();

        if (data.type === 'roll-call') {
          // Respond to roll call with session metadata
          channel.postMessage({
            type: 'present',
            windowId: myId,
            sessions: sessionsProvider ? sessionsProvider() : []
          });
        } else if ((data.type === 'present' || data.type === 'heartbeat') && data.windowId !== myId) {
          // Track other live windows
          liveWindows.set(data.windowId, {
            windowId: data.windowId,
            sessions: data.sessions || [],
            lastSeen: Date.now()
          });
        } else if (data.type === 'closing' && data.windowId !== myId) {
          liveWindows.delete(data.windowId);
        } else if (data.type === 'send-session' && data.targetWindowId === myId) {
          // Another window is sending us a session
          if (receiveSessionCallback) {
            receiveSessionCallback(data.session);
          }
          // Ack back to sender so they know we received it
          channel.postMessage({
            type: 'send-session-ack',
            transferId: data.transferId,
            targetWindowId: data.fromWindowId
          });
        } else if (data.type === 'focus-session' && data.targetWindowId === myId) {
          window.focus();
          if (focusSessionCallback) {
            focusSessionCallback(data.sessionId);
          }
        } else if (data.type === 'send-session-ack' && data.targetWindowId === myId) {
          const pending = pendingTransfers.get(data.transferId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingTransfers.delete(data.transferId);
            pending.resolve();
          }
        }
      };
    }

    const sendHeartbeat = () => {
      channel.postMessage({
        type: 'heartbeat',
        windowId: this.getWindowId(),
        sessions: sessionsProvider ? sessionsProvider() : []
      });
      pruneStaleWindows();
    };

    // Send initial heartbeat
    sendHeartbeat();

    // Schedule periodic heartbeats
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    // Handle page unload
    window.addEventListener('beforeunload', () => {
      channel.postMessage({ type: 'closing', windowId: this.getWindowId() });
    });

    // Send a roll-call to populate liveWindows immediately
    channel.postMessage({ type: 'roll-call' });
  },

  /**
   * Stop heartbeat (for testing or cleanup)
   */
  stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (channel) {
      channel.close();
      channel = null;
    }
  },

  /**
   * Reset window ID (clear cache and sessionStorage so next getWindowId() generates a fresh one)
   */
  resetWindowId() {
    currentWindowId = null;
    sessionStorage.removeItem(WINDOW_ID_KEY);
  },

  /**
   * Release current window (mark as inactive without deleting sessions)
   */
  releaseWindow() {
    if (channel) {
      channel.postMessage({ type: 'closing', windowId: this.getWindowId() });
    }
    this.stopHeartbeat();
    currentWindowId = null;
    sessionStorage.removeItem(WINDOW_ID_KEY);
  },

  /**
   * Register a callback that returns current sessions as [{id, name}]
   */
  setSessionsProvider(fn) {
    sessionsProvider = fn;
  },

  /**
   * Get list of other live windows (excludes self, excludes stale).
   * Returns synchronously from cache.
   */
  getLiveWindows() {
    pruneStaleWindows();
    return [...liveWindows.values()];
  },

  /**
   * Send a session to another window via BroadcastChannel.
   * Returns a Promise that resolves when the target acks, or rejects on timeout.
   */
  sendSessionToWindow(targetWindowId, session) {
    if (!channel) return Promise.reject(new Error('No BroadcastChannel'));

    const transferId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTransfers.delete(transferId);
        reject(new Error('No ack from target window'));
      }, SEND_SESSION_ACK_TIMEOUT);

      pendingTransfers.set(transferId, { resolve, reject, timer });

      channel.postMessage({
        type: 'send-session',
        transferId,
        targetWindowId,
        session,
        fromWindowId: this.getWindowId()
      });
    });
  },

  /**
   * Register handler for incoming sessions from other windows
   */
  onSessionReceived(callback) {
    receiveSessionCallback = callback;
  },

  /**
   * Register handler for focus-session requests from other windows
   */
  onFocusSession(callback) {
    focusSessionCallback = callback;
  },

  /**
   * Ask another window to focus itself and switch to a specific session
   */
  focusSessionInWindow(targetWindowId, sessionId) {
    if (!channel) return;
    channel.postMessage({
      type: 'focus-session',
      targetWindowId,
      sessionId,
      fromWindowId: this.getWindowId()
    });
  }
};
