// Queue of tab-opening messages waiting for a browser to connect (#596).
//
// Unattended work (a scheduled-task fire, a display tab created by an agent) has
// no window to deliver its `open-session` / `open-display-tab` to, so the message
// is parked here and flushed to the next reload client that connects. The naive
// array this replaces had no liveness check, no TTL and no cap, which meant a
// scheduled run that fired, completed and auto-closed while nobody was watching
// still handed its (now tombstoned) session id to the next browser — and the WS
// restore path happily resurrected it as a zombie `claude --resume` tab, pointing
// at a worktree its own cleanup had already deleted. N unattended fires produced
// N zombie tabs the moment a browser appeared.
//
// So the queue now owns three rules:
//   1. an entry is evicted the instant the thing it points at is closed (drop),
//   2. anything that died without an explicit drop is filtered at flush (takeFor),
//   3. nothing lives past a TTL, and the queue can't grow without bound.
//
// Dependency-free and fully injectable so unit tests can drive it with a fake clock.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // a queued tab older than a day is not worth surfacing
const DEFAULT_MAX = 100;

function createPendingOpens({
  ttlMs = DEFAULT_TTL_MS,
  max = DEFAULT_MAX,
  now = Date.now,
  log = () => {},
} = {}) {
  // entries: { msg: <json string>, queuedAt: <ms> }
  const entries = [];

  function parse(entry) {
    try { return JSON.parse(entry.msg); } catch { return {}; }
  }

  return {
    // Accepts a JSON string (what mods/display-tab/tools.js pushes) or an object.
    // Named `push` so existing array-style callers keep working unchanged.
    push(msg) {
      entries.push({ msg: typeof msg === 'string' ? msg : JSON.stringify(msg), queuedAt: now() });
      if (entries.length > max) {
        const evicted = entries.splice(0, entries.length - max);
        log(`[pendingOpens] queue over ${max}, evicted ${evicted.length} oldest message(s)`);
      }
    },

    // Remove every queued message referring to `id`. Called from tombstoneSession()
    // and deleteDisplayTab(), i.e. the moment the target stops existing — this is
    // what stops a finished unattended run from ever being offered to a browser.
    // Returns the number removed so the caller can log it.
    drop(id) {
      if (!id) return 0;
      let removed = 0;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (parse(entries[i]).id === id) { entries.splice(i, 1); removed++; }
      }
      return removed;
    },

    // Flush for a connecting window. `isLive(parsed)` decides whether the target
    // still exists; unknown message types should return true so mod-defined
    // messages are only ever dropped by the TTL/cap.
    //
    // Order matters: expiry is checked BEFORE the window filter, so a message
    // addressed to a window that never comes back can't sit here forever.
    takeFor(windowId, isLive = () => true) {
      const t = now();
      const send = [];
      const keep = [];
      let droppedStale = 0;
      let droppedExpired = 0;
      for (const entry of entries) {
        if (t - entry.queuedAt > ttlMs) { droppedExpired++; continue; }
        const parsed = parse(entry);
        if (parsed.windowId && parsed.windowId !== windowId) { keep.push(entry); continue; }
        if (!isLive(parsed)) { droppedStale++; continue; }
        send.push(entry.msg);
      }
      entries.length = 0;
      entries.push(...keep);
      return { send, droppedStale, droppedExpired };
    },

    get length() { return entries.length; },
    toArray() { return entries.map((e) => e.msg); },
    clear() { entries.length = 0; },
  };
}

module.exports = { createPendingOpens, DEFAULT_TTL_MS, DEFAULT_MAX };
