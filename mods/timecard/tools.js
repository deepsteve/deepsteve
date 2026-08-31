// Timecard (#666) — the sampler, the presence map and the two REST routes.
//
// Every N minutes the daemon asks "was a human working in Deep Steve since the last
// sample?" and appends one row to ~/.deepsteve/timecard.jsonl. The interesting logic —
// what a sample concludes, how rows aggregate into Day / Week / Month — lives in the
// dependency-free root module timecard-store.js so it can be unit-tested with no
// daemon. This file is the wiring.
//
// Why presence is browser-reported: the daemon can see live sessions and lastInputTime,
// but nothing in the codebase reports window focus, and without focus "browser open and
// I am in it" and "a tab left open overnight" are the same state. public/js/timecard-
// presence.js beacons it; POST /api/timecard/presence is where it lands.

const path = require('path');
const { stateDir } = require('../../paths');
const {
  createTimecardStore,
  resolveAnchor,
  decideSample,
  buildViews,
  seedViews,
  normalizeInterval,
  PRESENCE_TTL_MS,
} = require('../../timecard-store');

const TIMECARD_FILE = path.join(stateDir(), 'timecard.jsonl');

// The tick runs at the FINEST configurable interval and asks decideSample whether
// enough time has passed. That way changing 15 → 1 in Settings takes effect on the next
// minute with no timer to restart and no AUTO_UPDATE_TIMER_FIELDS entry.
const TICK_MS = 60 * 1000;

// A window that has not beaconed in ten minutes is not coming back mid-sample; dropping
// it keeps the map bounded across a long uptime.
const WINDOW_FORGET_MS = 10 * 60 * 1000;

let ctx = null;
let store = null;
let lastSampleAt = 0;
let started = false;

// windowId → { lastSeenAt, lastFocusedAt, lastInteractionAt, focused }. In memory only:
// presence is about right now, and a restart legitimately forgets it.
const windows = new Map();

function log_(msg) {
  if (ctx && ctx.log) ctx.log(`[timecard] ${msg}`);
}

function settingsObj() {
  return (ctx && ctx.settings) || {};
}

/** Read live off the mutated-in-place settings object, so toggling needs no restart. */
function featureEnabled() {
  return settingsObj().timecardEnabled !== false;
}

function intervalMinutes() {
  return normalizeInterval(settingsObj().timecardSampleMinutes);
}

/**
 * A scheduled run is the daemon working, not the user. Same shape as server.js's
 * isScheduledRun — duplicated rather than plumbed through the MCP context because it is
 * three lines and the context is already fifty keys wide.
 */
function isScheduledRun(entry) {
  if (!entry) return false;
  if (entry.scheduled) return true;
  if (/^scheduled-/.test(entry.worktree || '')) return true;
  return /^⏰/.test(entry.name || '');
}

/** The live sessions a human could plausibly be watching. */
function liveSessions() {
  const out = [];
  if (!ctx || !ctx.shells) return out;
  for (const [, e] of ctx.shells) {
    if (isScheduledRun(e)) continue;
    out.push({ lastActivity: e.lastActivity || 0 });
  }
  return out;
}

/** Presence reports still worth believing, pruning the ones that aged out. */
function activeWindows(now) {
  const out = [];
  for (const [id, w] of windows) {
    if (now - w.lastSeenAt > WINDOW_FORGET_MS) { windows.delete(id); continue; }
    out.push(w);
  }
  return out;
}

function tick() {
  const now = Date.now();
  // While off, keep the anchor moving. Otherwise re-enabling would present the whole
  // disabled stretch as one enormous gap, which decideSample would read as a sleep.
  if (!featureEnabled()) { lastSampleAt = now; return; }

  const d = decideSample({
    now,
    lastSampleAt,
    intervalMin: intervalMinutes(),
    windows: activeWindows(now),
    sessions: liveSessions(),
    presenceTtlMs: PRESENCE_TTL_MS,
  });
  if (!d.fire) return;

  store.append({ t: now, a: d.active ? 1 : 0, m: d.minutes, s: d.sessionCount });
  lastSampleAt = now;
}

function start() {
  if (started) return;
  started = true;
  store = createTimecardStore({ file: TIMECARD_FILE });
  // The last stored row IS the anchor, which is the whole of "samples survive a restart"
  // — there is no second state file to keep in sync. A fresh store, or a row stamped in
  // the future, starts the clock now rather than back-filling or stalling.
  lastSampleAt = resolveAnchor(store.lastSampleAt());
  // .unref() so the sampler never keeps the process alive on its own (the daemon stays
  // up via its HTTP server), and so requiring this file in a unit test cannot hang it.
  // The whole body is caught: a throw from a bare timer callback takes the daemon down
  // and every agent session with it.
  setInterval(() => {
    try { tick(); } catch (e) { log_(`tick error: ${e.message}`); }
  }, TICK_MS).unref();
  log_(`sampler started (${store.size} sample(s), every ${intervalMinutes()}m)`);
}

function init(context) {
  ctx = context;
  start();
  // No MCP tools: the timecard is something the user looks at, not something an agent
  // drives. GET /api/timecard is the whole read surface.
  return {};
}

function registerRoutes(app, context) {
  if (!ctx) ctx = context;

  app.post('/api/timecard/presence', (req, res) => {
    const body = req.body || {};
    const id = String(body.windowId || '').slice(0, 64);
    if (!id) return res.status(400).json({ error: 'windowId required' });

    const now = Date.now();
    const prev = windows.get(id) || {};
    const reported = Number(body.lastInteractionAt);
    windows.set(id, {
      lastSeenAt: now,
      focused: !!body.focused,
      lastFocusedAt: body.focused ? now : (prev.lastFocusedAt || 0),
      // Clamped to now and never allowed to move backwards: a browser clock running
      // ahead of the daemon's would otherwise manufacture interaction in the future and
      // make every later sample read as active, permanently.
      lastInteractionAt: Math.max(
        prev.lastInteractionAt || 0,
        Number.isFinite(reported) ? Math.min(reported, now) : 0,
      ),
    });
    res.status(204).end();
  });

  app.get('/api/timecard', (req, res) => {
    const now = Date.now();
    const samples = store ? store.all() : [];
    // The seed is shown only while there is genuinely nothing to show, and the card
    // labels it as example data for exactly that long.
    const seeded = samples.length === 0;
    res.json({
      enabled: featureEnabled(),
      intervalMinutes: intervalMinutes(),
      seeded,
      views: seeded ? seedViews(now) : buildViews(samples, now),
    });
  });
}

module.exports = { init, registerRoutes };
