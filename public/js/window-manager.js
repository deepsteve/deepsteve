/**
 * Window manager for multi-browser-tab support.
 * Uses sessionStorage for tab-specific window ID and BroadcastChannel for cross-tab communication.
 */

import { SessionStore } from './session-store.js';
import { nsKey, nsChannel } from './storage-namespace.js';

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
   * List windows that appear to be orphaned (no active browser tab)
   * Returns a promise that resolves after listening for heartbeats
   */
  async listOrphanedWindows() {
    const allWindows = SessionStore.getAllWindows();
    const windowIds = Object.keys(allWindows);

    if (windowIds.length === 0) return [];

    // Current window is not orphaned
    const myWindowId = this.getWindowId();

    // Collect active windows via broadcast
    const activeWindows = new Set();

    return new Promise((resolve) => {
      const tempChannel = new BroadcastChannel(CHANNEL_NAME);

      tempChannel.onmessage = (event) => {
        if (event.data.type === 'present' || event.data.type === 'heartbeat') {
          activeWindows.add(event.data.windowId);
        }
      };

      // Ask all windows to identify themselves
      tempChannel.postMessage({ type: 'roll-call' });

      // Wait for responses
      setTimeout(() => {
        tempChannel.close();

        // Filter out active windows and current window
        const orphaned = windowIds.filter(id =>
          id !== myWindowId && !activeWindows.has(id)
        );

        // Return window data with session info
        const orphanedWindows = orphaned.map(id => ({
          windowId: id,
          sessions: allWindows[id].sessions,
          lastActive: allWindows[id].lastActive
        }));

        // Sort by last active (most recent first)
        orphanedWindows.sort((a, b) => b.lastActive - a.lastActive);

        resolve(orphanedWindows);
      }, ORPHAN_DETECTION_TIMEOUT);
    });
  },

  /**
   * Claim an orphaned window's identity (take over its sessions)
   */
  claimWindow(orphanedWindowId) {
    const myWindowId = this.getWindowId();

    // Get a COPY of sessions before moving (moveSession modifies the array)
    const sessions = [...SessionStore.getWindowSessions(orphanedWindowId)];
    for (const session of sessions) {
      SessionStore.moveSession(orphanedWindowId, myWindowId, session.id);
    }

    return sessions;
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
