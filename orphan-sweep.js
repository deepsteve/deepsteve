/**
 * The orphan predicate (#680): a live session that no UI surface can reach.
 *
 * DeepSteve has exactly three ways a session gets back in front of a user, and each
 * covers a different arrangement:
 *
 *   - its window is open and showing it            → the tab bar, from localStorage
 *   - its window is gone                           → the restore modal's window picker
 *   - it belongs to no window at all               → the `ungrouped` bucket
 *
 * The fourth arrangement is the bug. A session grouped under a window that is
 * connected RIGHT NOW, which that window is not showing, falls through all three: the
 * tab bar never reads the server, the picker only offers windows that are LOST, and
 * the session is not ungrouped. #680's session ran invisibly, mid-turn, with three
 * subagents, and was found by tailing the daemon log.
 *
 * So the predicate is: live window, live session, zero attached clients.
 *
 * WHY THE GRACE PERIOD IS NOT OPTIONAL. `attached: 0` is a perfectly ordinary
 * transient — the moment after a spawn before the browser opens the tab, the seconds
 * after a daemon restart while every session WS reconnects, a network blip. Flagging
 * on a single observation would fire on all of them. An id therefore has to look
 * orphaned CONTINUOUSLY for graceMs across successive sweeps before it counts, and the
 * clock is reset the instant a client attaches. That is what `seenSince` carries, and
 * it is why this is a fold over sweeps rather than a test on one snapshot.
 *
 * Pure: no server state, no clock, no I/O. See test/unit/orphan-sweep.test.js.
 */

const DEFAULT_GRACE_MS = 30000;

/**
 * @param {Array}  windows   buildWindowsView().windows — [{ windowId, live, sessions:
 *                           [{ id, name, status, attached, ... }] }]
 * @param {Map}    seenSince id → timestamp of the first sweep at which it looked
 *                           orphaned. Owned by the caller across sweeps; this function
 *                           returns the next one rather than mutating it.
 * @param {number} now
 * @param {number} graceMs   how long the state must persist before it is a bug
 * @returns {{ orphans: Array, seenSince: Map }}
 *          orphans: [{ id, windowId, name, cwd, forMs }], oldest offence first
 */
function findOrphanSessions({ windows, seenSince, now, graceMs = DEFAULT_GRACE_MS }) {
  const prev = seenSince instanceof Map ? seenSince : new Map();
  const next = new Map();
  const orphans = [];

  for (const w of windows || []) {
    // A window the server is not currently talking to is the restore modal's job.
    if (!w.live) continue;
    for (const s of w.sessions || []) {
      // 'saved' rows have no shell and no clients by construction — they are the
      // window's un-restored history, not a running agent nobody can see.
      if (s.status !== 'active') continue;
      if (s.attached > 0) continue;
      const since = prev.get(s.id) ?? now;
      next.set(s.id, since);
      const forMs = now - since;
      if (forMs >= graceMs) {
        orphans.push({ id: s.id, windowId: w.windowId, name: s.name || null, cwd: s.cwd || null, forMs });
      }
    }
  }

  // Anything absent from `next` either attached, closed, or moved to a dead window —
  // its clock is dropped, so a session that recovers and later re-offends starts over.
  orphans.sort((a, b) => b.forMs - a.forMs);
  return { orphans, seenSince: next };
}

module.exports = { findOrphanSessions, DEFAULT_GRACE_MS };
