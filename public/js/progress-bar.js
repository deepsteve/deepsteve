/**
 * Top-of-page progress bar (NProgress / GitHub-navigation style).
 *
 * A thin bar pinned to the very top edge of the viewport that gives ambient
 * feedback while a session is being prefilled by an automation. It "trickles"
 * toward (but never reaches) completion until the prefill finishes, then snaps
 * to 100% and fades out.
 *
 * Driven by server broadcast lifecycle: start() on the `open-session` (prefill)
 * message, done() on `prompt-submitted`. Multiple concurrent prefills are
 * ref-counted by session id, so the bar stays visible until the last one ends.
 *
 *   import { init, start, done } from './progress-bar.js';
 *   init();              // once, after DOM is ready
 *   start(sessionId);    // a prefill began
 *   done(sessionId);     // that prefill finished (or was lost)
 */

const TRICKLE_MS = 250;       // how often the bar nudges forward while active
const TRICKLE_CAP = 0.95;     // never auto-advance past this; done() finishes it
const START_AT = 0.08;        // initial visible fraction when the bar appears
const FADE_MS = 400;          // must match the opacity transition in styles.css
const SAFETY_MS = 60000;      // auto-complete if an END signal never arrives

const activeIds = new Set();
const safetyTimers = new Map();

let bar = null;
let trickleTimer = null;
let fadeTimer = null;
let progress = 0;

function ensureBar() {
  if (bar) return bar;
  bar = document.getElementById('ds-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ds-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'ds-progress-bar-fill';
    bar.appendChild(fill);
    document.body.appendChild(bar);
  }
  return bar;
}

function render() {
  const fill = bar && bar.firstChild;
  if (fill) fill.style.transform = `scaleX(${progress})`;
}

function show() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  ensureBar().classList.add('active');
}

function beginTrickle() {
  if (trickleTimer) return;
  trickleTimer = setInterval(() => {
    // Diminishing nudge: larger steps early, asymptotic near the cap.
    const remaining = TRICKLE_CAP - progress;
    if (remaining <= 0.001) return;
    progress += remaining * (0.1 + Math.random() * 0.15);
    render();
  }, TRICKLE_MS);
}

function stopTrickle() {
  if (trickleTimer) { clearInterval(trickleTimer); trickleTimer = null; }
}

function finish() {
  stopTrickle();
  progress = 1;
  render();
  // Let the fill animate to 100%, then fade the whole bar and reset.
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    if (bar) bar.classList.remove('active');
    progress = 0;
    render();
  }, FADE_MS);
}

export function init() {
  ensureBar();
}

export function start(sessionId) {
  if (sessionId == null) return;
  // Re-entrant: a new start cancels any in-flight fade-out.
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }

  if (!activeIds.has(sessionId)) {
    activeIds.add(sessionId);
    safetyTimers.set(sessionId, setTimeout(() => done(sessionId), SAFETY_MS));
  }

  if (progress < START_AT) { progress = START_AT; render(); }
  show();
  beginTrickle();
}

export function done(sessionId) {
  const timer = safetyTimers.get(sessionId);
  if (timer) { clearTimeout(timer); safetyTimers.delete(sessionId); }
  activeIds.delete(sessionId);

  // Only complete the bar once every prefill has ended.
  if (activeIds.size === 0) finish();
}
