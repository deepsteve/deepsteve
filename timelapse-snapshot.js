/**
 * Timelapse snapshot shaping (#667) — pure, so test/unit can exercise it without a daemon.
 *
 * Two halves, both deliberately free of I/O and of any `require` back into server.js:
 *
 *   enrichTabs()   the write path. The browser knows the tab STRIP (order, titles, which
 *                  one is active, which are display/mod/project tabs); the daemon knows
 *                  the SESSIONS (agent type, worktree, cwd, busy/idle). Neither half can
 *                  answer "how many tabs did I open, and what were they doing" alone, so
 *                  the frame is joined here, server-side, on the way to disk. Doing it on
 *                  the client was never an option for `agentType`: the browser is sent it
 *                  on the session message and drops it (app.js reads engineType/worktree/
 *                  autopilot and nothing else).
 *
 *   summarizeRun() the read path. Turns a run's sidecars into the two numbers the issue
 *                  exists to produce — distinct tabs opened, and frames where the window
 *                  was actually being used — plus the gaps, which are signal rather than
 *                  loss: a missing frame is the browser having been closed or asleep.
 *
 * The per-tab row deliberately mirrors the `list_sessions` MCP row
 * (mods/deepsteve-core/tools.js), which is already the richest session shape in the tree.
 * Same field names means a script that reads one can read the other.
 */

'use strict';

/** Tab kinds the browser reports. Anything else is treated as a terminal session. */
const NON_TERMINAL_TYPES = new Set(['display-tab', 'mod-tab', 'project-mod']);

/**
 * Join the browser's tab list with the daemon's session facts.
 *
 * @param {Array}    clientTabs  rows from the browser, in tab-strip order
 * @param {Object}   deps
 * @param {Map}      deps.shells             live sessions (id → entry)
 * @param {Object}   [deps.savedState]       tombstoned/saved sessions (id → entry)
 * @param {Function} [deps.sessionInputState] entry → 'busy' | 'idle' | 'unknown'
 * @param {Function} [deps.sessionPaths]     entry → { cwd, repoRoot }
 * @returns {Array} enriched rows, input order preserved
 */
function enrichTabs(clientTabs, deps = {}) {
  const shells = deps.shells || new Map();
  const savedState = deps.savedState || {};
  const inputState = deps.sessionInputState;
  const paths = deps.sessionPaths;

  return (Array.isArray(clientTabs) ? clientTabs : []).map((raw, i) => {
    const tab = raw && typeof raw === 'object' ? raw : {};
    const type = tab.type || 'terminal';
    const row = {
      id: typeof tab.id === 'string' ? tab.id : null,
      // `index` is the browser's, not the array's — a tab hidden by the context filter
      // still holds its place in the strip, and the two must not silently diverge.
      index: Number.isInteger(tab.index) ? tab.index : i,
      title: typeof tab.title === 'string' ? tab.title : null,
      type,
      active: !!tab.active,
      contextHidden: !!tab.contextHidden,
      waitingForInput: !!tab.waitingForInput,
      hasUnseenActivity: !!tab.hasUnseenActivity,
    };
    if (tab.modId) row.modId = tab.modId;
    if (tab.projectModId) row.projectModId = tab.projectModId;

    // Display tabs, mod tabs and project-mod tabs have no PTY behind them. They still
    // count as tabs the user opened, which is half the question the run answers, so they
    // pass through whole rather than being filtered out.
    if (NON_TERMINAL_TYPES.has(type)) {
      row.cwd = tab.cwd || null;
      return row;
    }

    const entry = shells.get(row.id);
    if (!entry) {
      // Closed between the browser painting the strip and the frame landing, or a tab
      // this daemon never owned. Say so instead of inventing fields.
      const saved = savedState[row.id];
      row.live = false;
      row.cwd = (saved && saved.cwd) || tab.cwd || null;
      row.agentType = (saved && saved.agentType) || null;
      row.worktree = (saved && saved.worktree) || null;
      row.state = 'unknown';
      return row;
    }

    const { cwd, repoRoot } = paths ? paths(entry) : { cwd: entry.cwd, repoRoot: entry.cwd };
    row.live = true;
    row.cwd = cwd || null;
    row.repoRoot = repoRoot || null;
    row.agentType = entry.agentType || 'claude';
    row.worktree = entry.worktree || null;
    row.engineType = entry.engineType || null;
    row.windowId = entry.windowId || null;
    // The tri-state, not the collapsed boolean the browser holds: 'idle' (at a prompt)
    // and 'unknown' (a TUI, a banner, never classified) are different answers to "was I
    // working", and the browser cannot tell them apart.
    row.state = inputState ? inputState(entry) : 'unknown';
    row.createdAt = entry.createdAt || null;
    row.lastActivity = entry.lastActivity || null;
    row.lastInputTime = entry.lastInputTime || null;
    return row;
  });
}

/**
 * Fold a run's frames into the answers the run was recorded to give.
 *
 * @param {Array}  frames      sidecar objects, any order
 * @param {number} [intervalMs] the run's nominal interval; a hole wider than 1.5× it is
 *   reported as a gap. Falls back to the run's own median spacing, then to 5 minutes.
 */
function summarizeRun(frames, intervalMs) {
  const rows = (Array.isArray(frames) ? frames : [])
    .filter(f => f && typeof f === 'object' && Number.isFinite(f.capturedAt))
    .slice()
    .sort((a, b) => a.capturedAt - b.capturedAt);

  const empty = {
    frames: 0, startedAt: null, endedAt: null, spanMs: 0,
    distinctTabs: 0, distinctTabsByType: {}, distinctAgentTypes: {},
    focusedFrames: 0, visibleFrames: 0, activeFrames: 0, busyFrames: 0,
    maxTabsOpen: 0, gaps: [], recordedMs: 0,
  };
  if (rows.length === 0) return empty;

  const step = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : medianStep(rows);
  const gapThreshold = step * 1.5;

  // A tab id recurs in every frame it was open for, so the per-frame counters and the
  // distinct-tab counters cannot share a loop. firstSeen keeps the first row for each id,
  // which is also what makes "how many distinct tabs, and of what kind" answerable.
  const firstSeen = new Map();
  let focusedFrames = 0, visibleFrames = 0, activeFrames = 0, busyFrames = 0, maxTabsOpen = 0;

  for (const f of rows) {
    const w = f.window || {};
    if (w.hasFocus) focusedFrames++;
    if (w.visibilityState === 'visible') visibleFrames++;
    // "Actually being used": focused AND a keystroke or click within the interval. This
    // is the distinction the issue asks for — a window left open all night is open, not
    // used.
    if (w.hasFocus && Number.isFinite(w.msSinceInput) && w.msSinceInput <= step) activeFrames++;

    const tabs = Array.isArray(f.tabs) ? f.tabs : [];
    if (tabs.length > maxTabsOpen) maxTabsOpen = tabs.length;
    let anyBusy = false;
    for (const t of tabs) {
      if (!t) continue;
      if (t.id && !firstSeen.has(t.id)) firstSeen.set(t.id, t);
      if (t.state === 'busy') anyBusy = true;
    }
    if (anyBusy) busyFrames++;
  }

  const byType = {};
  const byAgent = {};
  for (const t of firstSeen.values()) {
    const type = t.type || 'terminal';
    byType[type] = (byType[type] || 0) + 1;
    if (t.agentType) byAgent[t.agentType] = (byAgent[t.agentType] || 0) + 1;
  }

  const gaps = [];
  let recordedMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].capturedAt - rows[i - 1].capturedAt;
    if (delta > gapThreshold) {
      gaps.push({ from: rows[i - 1].capturedAt, to: rows[i].capturedAt, ms: delta });
    } else {
      // Only unbroken stretches count towards time-in-app; a gap is the browser having
      // been closed or asleep, and backfilling it would answer the question with a guess.
      recordedMs += delta;
    }
  }

  return {
    frames: rows.length,
    startedAt: rows[0].capturedAt,
    endedAt: rows[rows.length - 1].capturedAt,
    spanMs: rows[rows.length - 1].capturedAt - rows[0].capturedAt,
    intervalMs: step,
    distinctTabs: firstSeen.size,
    distinctTabsByType: byType,
    distinctAgentTypes: byAgent,
    focusedFrames,
    visibleFrames,
    activeFrames,
    busyFrames,
    maxTabsOpen,
    gaps,
    recordedMs,
  };
}

/** Median spacing between consecutive frames — the run's own idea of its interval. */
function medianStep(rows) {
  const FIVE_MINUTES = 5 * 60 * 1000;
  if (rows.length < 2) return FIVE_MINUTES;
  const deltas = [];
  for (let i = 1; i < rows.length; i++) deltas.push(rows[i].capturedAt - rows[i - 1].capturedAt);
  deltas.sort((a, b) => a - b);
  const mid = deltas[Math.floor(deltas.length / 2)];
  return mid > 0 ? mid : FIVE_MINUTES;
}

module.exports = { enrichTabs, summarizeRun };
