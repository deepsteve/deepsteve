/**
 * Session storage abstraction for multi-window support.
 *
 * Storage structure:
 * {
 *   windows: {
 *     "win-abc123": {
 *       sessions: [{id, cwd, name}, ...],
 *       lastActive: timestamp
 *     },
 *     ...
 *   },
 *   lastCwd: "/path/to/dir",
 *   alwaysUse: false
 * }
 */

const STORAGE_KEY = 'deepsteve';

function getStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function setStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const SessionStore = {
  /**
   * Get sessions for a specific window
   */
  getWindowSessions(windowId) {
    const storage = getStorage();
    return storage.windows?.[windowId]?.sessions || [];
  },

  /**
   * Add a session to a window
   */
  addSession(windowId, session) {
    const storage = getStorage();
    if (!storage.windows) storage.windows = {};
    if (!storage.windows[windowId]) {
      storage.windows[windowId] = { sessions: [], lastActive: Date.now() };
    }
    const sessions = storage.windows[windowId].sessions;
    if (!sessions.find(s => s.id === session.id)) {
      sessions.push(session);
    }
    storage.windows[windowId].lastActive = Date.now();
    setStorage(storage);
  },

  /**
   * Remove a session from a window
   */
  removeSession(windowId, sessionId) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      storage.windows[windowId].sessions = storage.windows[windowId].sessions.filter(
        s => s.id !== sessionId
      );
      // Clean up empty windows
      if (storage.windows[windowId].sessions.length === 0) {
        delete storage.windows[windowId];
      }
      setStorage(storage);
    }
  },

  /**
   * Update session data (e.g., name)
   */
  updateSession(windowId, sessionId, updates) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      const session = storage.windows[windowId].sessions.find(s => s.id === sessionId);
      if (session) {
        Object.assign(session, updates);
        setStorage(storage);
      }
    }
  },

  /**
   * Move a session from one window to another
   */
  moveSession(fromWindowId, toWindowId, sessionId) {
    const storage = getStorage();
    const fromWindow = storage.windows?.[fromWindowId];
    if (!fromWindow) return;

    const sessionIndex = fromWindow.sessions.findIndex(s => s.id === sessionId);
    if (sessionIndex === -1) return;

    const [session] = fromWindow.sessions.splice(sessionIndex, 1);

    if (!storage.windows[toWindowId]) {
      storage.windows[toWindowId] = { sessions: [], lastActive: Date.now() };
    }
    storage.windows[toWindowId].sessions.push(session);
    storage.windows[toWindowId].lastActive = Date.now();

    // Clean up empty source window
    if (fromWindow.sessions.length === 0) {
      delete storage.windows[fromWindowId];
    }

    setStorage(storage);
  },

  /**
   * Get all windows
   */
  getAllWindows() {
    const storage = getStorage();
    return storage.windows || {};
  },

  /**
   * Remove a window entirely
   */
  removeWindow(windowId) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      delete storage.windows[windowId];
      setStorage(storage);
    }
  },

  /**
   * Update window's lastActive timestamp
   */
  touchWindow(windowId) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      storage.windows[windowId].lastActive = Date.now();
      setStorage(storage);
    }
  },

  /**
   * Get/set last used cwd
   */
  getLastCwd() {
    return getStorage().lastCwd;
  },

  setLastCwd(cwd) {
    const storage = getStorage();
    storage.lastCwd = cwd;
    setStorage(storage);
  },

  /**
   * Get/set alwaysUse preference
   */
  getAlwaysUse() {
    return getStorage().alwaysUse || false;
  },

  setAlwaysUse(value) {
    const storage = getStorage();
    storage.alwaysUse = value;
    setStorage(storage);
  },

  /**
   * Migrate from old flat storage format to new window-based format
   */
  migrateFromLegacy() {
    const storage = getStorage();
    // Check if already migrated (has windows property)
    if (storage.windows !== undefined) return null;

    // Check for legacy sessions array
    if (storage.sessions && storage.sessions.length > 0) {
      // Return legacy sessions for migration
      const legacySessions = storage.sessions;
      // Clear old sessions array
      delete storage.sessions;
      storage.windows = {};
      setStorage(storage);
      return legacySessions;
    }

    // No legacy data, initialize empty windows
    if (!storage.windows) {
      storage.windows = {};
      setStorage(storage);
    }
    return null;
  }
};
