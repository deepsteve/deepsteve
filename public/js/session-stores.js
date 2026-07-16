/**
 * Session-store write facade (#385).
 *
 * TabSessions (sessionStorage, per-tab) and SessionStore (localStorage,
 * cross-window) must agree on every session add/remove/rename/reorder. This is
 * the ONE place that writes both — callers make a single facade call instead of
 * hand-pairing the two writes (which drifted when a site missed one). TabSessions
 * lives here now (moved out of app.js), unexported, so it cannot be mutated
 * anywhere else. SessionStore keeps its own single-store API for window/pref
 * writes that have no TabSessions counterpart (addRecentDir, touchWindow,
 * setLastCwd, migrateFromLegacy, claimSessions) — those are not drift hazards.
 */

import { SessionStore } from './session-store.js';
import { nsKey } from './storage-namespace.js';

/**
 * Per-tab session persistence via sessionStorage.
 * Authoritative source for "what sessions does THIS tab have." Survives page
 * refresh, doesn't depend on the localStorage window-ID mapping. Module-local
 * and unexported: the only mutations are the facade methods below.
 */
const TabSessions = {
  KEY: nsKey('deepsteve-tab-sessions'),
  get() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY)) || []; } catch { return []; }
  },
  save(sessionList) {
    sessionStorage.setItem(this.KEY, JSON.stringify(sessionList));
  },
  add(session) {
    const list = this.get();
    if (!list.find(s => s.id === session.id)) list.push(session);
    this.save(list);
  },
  remove(sessionId) {
    this.save(this.get().filter(s => s.id !== sessionId));
  },
  updateId(oldId, newId) {
    const list = this.get();
    const s = list.find(s => s.id === oldId);
    if (s) { s.id = newId; this.save(list); }
  },
  clear() {
    sessionStorage.removeItem(this.KEY);
  }
};

/**
 * Read passthrough for TabSessions (per-tab session list). Reads are allowed to
 * stay direct; this just keeps TabSessions itself encapsulated in this module.
 * Arrow wrapper on purpose — a bare `TabSessions.get` reference would lose `this`
 * and throw on this.KEY.
 */
export const getTabSessions = () => TabSessions.get();

/**
 * The only writer of both session stores. Every dual write (add/remove/rename/
 * reorder) is one call here, so the two stores can't drift; the TabSessions-only
 * methods exist because TabSessions is encapsulated in this module.
 */
export const SessionStores = {
  // --- dual writes (both stores) ---
  add(windowId, session) {
    TabSessions.add(session);
    SessionStore.addSession(windowId, session);
  },
  remove(windowId, sessionId) {
    SessionStore.removeSession(windowId, sessionId);
    TabSessions.remove(sessionId);
  },
  rename(windowId, sessionId, name) {
    SessionStore.updateSession(windowId, sessionId, { name });
    const list = TabSessions.get();
    const entry = list.find(s => s.id === sessionId);
    if (entry) { entry.name = name; TabSessions.save(list); }
  },
  reorder(windowId, orderedIds) {
    const list = TabSessions.get();
    const reordered = orderedIds.map(id => list.find(s => s.id === id)).filter(Boolean);
    TabSessions.save(reordered);
    SessionStore.reorderSessions(windowId, orderedIds);
  },

  // --- TabSessions-only (no SessionStore counterpart today; matches prior behavior) ---
  updateId(oldId, newId) {
    // Server assigned a different id on (re)connect. SessionStore is intentionally
    // left untouched here (as before #385); any drift self-heals on the next
    // server reconciliation.
    TabSessions.updateId(oldId, newId);
  },
  setClaudeSessionId(sessionId, claudeSessionId) {
    const list = TabSessions.get();
    const entry = list.find(s => s.id === sessionId);
    if (!entry) return;
    if (entry.claudeSessionId && entry.claudeSessionId !== claudeSessionId) {
      console.warn(`[session] Session ${sessionId} claudeSessionId changed: ${entry.claudeSessionId} → ${claudeSessionId}`);
    }
    entry.claudeSessionId = claudeSessionId;
    TabSessions.save(list);
  },
  clearTabSessions() {
    // Fresh-window reset only. Deliberately does NOT clear SessionStore (that's
    // cross-window state owned by other windows).
    TabSessions.clear();
  },
  addTabOnly(session) {
    // Restore path only (offerSessionRestore): SessionStore was already written
    // per-bucket with shapes that differ from TabSessions, so this mirrors just
    // the TabSessions half. Not a general-purpose add — use add() for that.
    TabSessions.add(session);
  }
};
