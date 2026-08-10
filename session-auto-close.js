// Deferred, cancellable session auto-close (#627).
//
// `skills/merge.md` step 9 asks the agent to call `close_session` after a successful
// merge. Agents skip it — 30/30 worktrees in #609, and again on Opus 5 after the
// prompt had been strengthened as far as prose can go (#627 tabulates all four of
// #609's angles as present in the file at the time it failed). The step fails for
// structural reasons no wording changes: the natural end of the task is the success
// summary, the close is work AFTER the thing that feels like the end, it sits behind
// the longest and most variable part of the skill, and the failure is silent and
// costless in the moment — the merge really is complete, only a tab lingers, and the
// agent is by construction not around to notice.
//
// So the daemon arms the close itself. Forgetting degrades the outcome from "open
// forever" to "closes shortly" instead of from "done" to "not done".
//
// Three properties live here, none of which belong in a tool handler:
//
//  1. DEFERRED, not immediate. `closeSession()` on a busy Claude writes Ctrl+C at
//     once (server.js killShell), so an inline close would cut off the tail the skill
//     still asks for — `gh issue close` and the summary. The delay is what makes that
//     tail survivable.
//  2. CANCELLABLE by input. A user who keeps working in the tab keeps the tab.
//  3. It can never fire on the wrong session. The armed entry OBJECT is captured and
//     re-checked at fire time, so a close, a natural exit, a tmux reattach, or a
//     `--resume` restore under the same id all invalidate the timer by construction.
//     The cancel hooks in server.js are hygiene on top of that — the identity check is
//     the actual guarantee, so a cancel site someone forgets to add later fails SAFE
//     (the timer drops) rather than closing a session that has moved on.
//
// Deliberately in-memory only: a daemon restart inside the window loses the pending
// close. Persisting it would mean re-arming on boot for a session the user may have
// resumed working in during the restart — strictly worse than leaving it open, and
// leaving it open is exactly today's behavior.
//
// Dependency-free and fully injectable so unit tests can drive the whole
// arm/cancel/defer matrix with a fake clock (same shape as pending-opens.js and
// sleep-watch.js). It must stay require-able from the bare CI `unit` job, which runs
// with --ignore-scripts and therefore has no node-pty binding — so nothing here may
// reach into server.js or an engine.

const DEFAULT_BUSY_RETRY_MS = 30000;
const DEFAULT_MAX_DEFERRALS = 10;

function createSessionAutoClose({
  closeSession,                     // (id, reason) => boolean
  getEntry,                         // (id) => entry | undefined
  sessionState = () => 'unknown',   // (entry) => 'busy' | 'idle' | 'unknown'
  shouldDefer = () => 0,            // (dueAt) => ms to wait instead of acting
  isShuttingDown = () => false,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  busyRetryMs = DEFAULT_BUSY_RETRY_MS,
  maxDeferrals = DEFAULT_MAX_DEFERRALS,
  log = () => {},
} = {}) {
  // id -> { entry, timer, closeAt, dueAt, deferrals, reason }
  const pending = new Map();

  function clear(id) {
    const rec = pending.get(id);
    if (!rec) return null;
    clearTimeoutFn(rec.timer);
    pending.delete(id);
    return rec;
  }

  function schedule(id, rec, delayMs) {
    rec.dueAt = now() + delayMs;
    // The catch is the daemon's safety net, not politeness: this runs from a bare
    // timer callback, so anything that throws in here — an injected probe, a close
    // path, a session shape nobody anticipated — would surface as an uncaught
    // exception and take the whole process down, killing every other session with it.
    // Drop the record and log loudly instead; the worst case is a tab that lingers.
    rec.timer = setTimeoutFn(() => {
      try { fire(id, rec); }
      catch (e) { pending.delete(id); log(`[auto-close] deferred close of ${id} failed: ${e.message}`); }
    }, delayMs);
    // A pending auto-close must never be the reason the process stays alive.
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
  }

  function fire(id, rec) {
    if (pending.get(id) !== rec) return;            // superseded by a re-arm
    if (getEntry(id) !== rec.entry) {               // closed / exited / reattached / restored
      pending.delete(id);
      log(`[auto-close] ${id} is gone or was replaced — dropping its deferred close`);
      return;
    }
    // A restart DETACHES tmux sessions rather than killing them (#620). Closing one
    // inside the shutdown window would destroy precisely what the restart preserves.
    if (isShuttingDown()) {
      pending.delete(id);
      log(`[auto-close] ${id} not closed — daemon is shutting down`);
      return;
    }

    const sleepMs = shouldDefer(rec.dueAt);
    // Mid-turn is the one state where closing is destructive: killShell sends Ctrl+C
    // to a busy Claude, which would interrupt whatever it went on to do after the
    // merge. 'unknown' (agent types with no screen markers) counts as go — otherwise
    // those sessions would never close at all.
    const busy = sessionState(rec.entry) === 'busy';

    if (sleepMs > 0 || busy) {
      if (rec.deferrals >= maxDeferrals) {
        // Bounded, and it gives up rather than forcing the close: this is a safety net
        // for a forgetful agent and must never itself be the thing that destroys work.
        // Failing open lands on today's behavior, which is not a regression — whereas
        // Ctrl+C-ing a session that is somehow still busy 20 minutes after its merge
        // is a guess about work nobody predicted.
        pending.delete(id);
        log(`[auto-close] ${id} still not idle after ${maxDeferrals} deferrals — giving up, session stays open`);
        return;
      }
      rec.deferrals++;
      const waitMs = sleepMs > 0 ? Math.max(sleepMs, 1000) : busyRetryMs;
      const why = sleepMs > 0 ? 'daemon recently woke' : 'session is mid-turn';
      log(`[auto-close] ${id} deferred ${Math.ceil(waitMs / 1000)}s (${why}, ${rec.deferrals}/${maxDeferrals})`);
      schedule(id, rec, waitMs);
      return;
    }

    pending.delete(id);
    log(`[auto-close] closing ${id} (${rec.reason})`);
    closeSession(id, rec.reason);
  }

  return {
    /**
     * Arm (or re-arm) a deferred close. Re-arming replaces the pending record, so a
     * session can never hold two timers. Returns { closeAt } or null when nothing was
     * armed (unknown session, or a non-positive delay = feature off).
     */
    arm(id, { delayMs, reason = 'auto-close' } = {}) {
      const entry = getEntry(id);
      if (!entry) return null;
      clear(id);
      if (!(delayMs > 0)) return null;
      const rec = { entry, reason, deferrals: 0, closeAt: now() + delayMs, dueAt: 0, timer: null };
      pending.set(id, rec);
      schedule(id, rec, delayMs);
      log(`[auto-close] armed for ${id} in ${Math.round(delayMs / 1000)}s (${reason})`);
      return { closeAt: rec.closeAt };
    },
    cancel(id, why = 'cancelled') {
      const rec = clear(id);
      if (rec) log(`[auto-close] cancelled for ${id} (${why})`);
      return !!rec;
    },
    closeAt(id) {
      const rec = pending.get(id);
      return rec ? rec.closeAt : null;
    },
    get size() { return pending.size; },
    clearAll() { for (const id of [...pending.keys()]) clear(id); },
  };
}

module.exports = { createSessionAutoClose, DEFAULT_BUSY_RETRY_MS, DEFAULT_MAX_DEFERRALS };
