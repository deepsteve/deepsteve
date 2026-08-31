/**
 * Timecard presence beacon (#666) — the browser half of "am I actually here".
 *
 * The daemon can see live sessions and lastInputTime, but nothing else in the codebase
 * reports window focus, and without focus a tab left open overnight and a night of work
 * are the same state. This module reports both halves the sampler needs: whether a
 * window is focused right now, and when the user last touched Deep Steve.
 *
 * It lives in the TOP document rather than in the Timecard mod because a fullscreen mod
 * view's iframe is destroyed the moment it is hidden (_hideMod in mod-manager.js) — a
 * beacon in there would only report while you were looking at the timecard, which is
 * the one time it does not matter.
 *
 * Self-contained module in the cmd-tab-switch.js / command-palette.js shape: init(),
 * setEnabled(), and no import back into app.js.
 */

const BEACON_MS = 30000;
// Mod routes register after core's, so /api/timecard/* 404s briefly after boot, and
// client-log.js beacons every >=400 response into the daemon log. Wait that window out
// rather than putting a guaranteed error in the log on every page load.
const FIRST_BEACON_DELAY_MS = 15000;
const MAX_FAILURES = 3;

let enabled = false;
let installed = false;
let windowId = null;
let lastInteractionAt = 0;
let failures = 0;
let timer = null;

/**
 * Whether to send. Pure, so the gating is testable without a browser.
 *
 * A `blur` report is exempt from the focus check: it is the last thing the server hears
 * before the window goes quiet, and it carries the interaction timestamp that decides
 * whether the minutes just past count as work.
 */
export function shouldBeacon({ enabled, focused, hidden, failures, reason = 'tick', maxFailures = MAX_FAILURES }) {
  if (!enabled) return false;
  // Three failures in a row means the route is not there (feature off at the server, an
  // old daemon, a mod that failed to load). Stop rather than log an error every 30s
  // forever; setEnabled(true) re-arms.
  if (failures >= maxFailures) return false;
  if (reason === 'blur') return true;
  if (hidden) return false;
  return !!focused;
}

function send(reason) {
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  if (!shouldBeacon({ enabled, focused, hidden: document.hidden, failures, reason })) return;
  fetch('/api/timecard/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      windowId,
      focused: reason !== 'blur' && focused && !document.hidden,
      lastInteractionAt,
    }),
  })
    .then((r) => { failures = r.ok ? 0 : failures + 1; })
    .catch(() => { failures += 1; });
}

function bump() { lastInteractionAt = Date.now(); }

function arm() {
  if (timer) return;
  setTimeout(() => { if (enabled) send('tick'); }, FIRST_BEACON_DELAY_MS);
  timer = setInterval(() => send('tick'), BEACON_MS);
}

function disarm() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function init({ windowId: id } = {}) {
  windowId = id || null;
  if (installed) return;
  installed = true;

  // Capture phase on the document: terminal keystrokes go through xterm, which is in
  // this document, so this sees them without reaching into app.js's session plumbing.
  // wheel is passive — this must never delay a scroll.
  document.addEventListener('keydown', bump, true);
  document.addEventListener('pointerdown', bump, true);
  document.addEventListener('wheel', bump, { capture: true, passive: true });

  window.addEventListener('focus', () => send('focus'));
  window.addEventListener('blur', () => send('blur'));
  document.addEventListener('visibilitychange', () => send(document.hidden ? 'blur' : 'focus'));
}

/** Driven from applySettings(). Off means no traffic at all, not a quieter beacon. */
export function setEnabled(value) {
  const next = !!value;
  if (next === enabled) return;
  enabled = next;
  failures = 0;
  if (enabled) arm();
  else disarm();
}
