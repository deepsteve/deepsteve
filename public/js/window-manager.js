/**
 * Window manager for multi-browser-tab support.
 * Uses sessionStorage for tab-specific window ID and BroadcastChannel for cross-tab communication.
 */

import { SessionStore } from './session-store.js';

const WINDOW_ID_KEY = 'deepsteve-window-id';
const CHANNEL_NAME = 'deepsteve-windows';
const HEARTBEAT_INTERVAL = 5000;
const ORPHAN_DETECTION_TIMEOUT = 1500;

let channel = null;
let heartbeatTimer = null;
let currentWindowId = null;

function generateWindowId() {
  return 'win-' + Math.random().toString(36).substring(2, 10);
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
        if (event.data.type === 'roll-call') {
          // Respond to roll call
          channel.postMessage({ type: 'present', windowId: this.getWindowId() });
        }
      };
    }

    const sendHeartbeat = () => {
      channel.postMessage({ type: 'heartbeat', windowId: this.getWindowId() });
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
   * Release current window (mark as inactive without deleting sessions)
   */
  releaseWindow() {
    if (channel) {
      channel.postMessage({ type: 'closing', windowId: this.getWindowId() });
    }
    this.stopHeartbeat();
    currentWindowId = null;
    sessionStorage.removeItem(WINDOW_ID_KEY);
  }
};
