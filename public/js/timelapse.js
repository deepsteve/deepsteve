/**
 * Timelapse mode (#667) — a recording circle, and a PNG + JSON pair every 5 minutes.
 *
 * The point is to answer two questions a running deepsteve cannot answer about itself:
 * how many tabs get opened over a day, and how much of the day is actually spent in the
 * app. So each frame carries both a picture and a structured snapshot of the tab strip,
 * and the JSON is what the counting is done from — never OCR of the images.
 *
 * Four things here are not obvious and are the reasons the module is shaped this way.
 *
 * **The deadline is wall-clock, never a tick count.** Browsers clamp setInterval in a
 * hidden tab (Chrome to roughly once a minute after five minutes hidden), so a plain
 * 5-minute interval drifts or stalls exactly when deepsteve is in a background tab —
 * which is most of a working day. The timer therefore fires often and cheaply and does
 * nothing but compare Date.now() against a stored deadline. When it does fire late it
 * re-anchors the next deadline to *now*, so waking from an hour asleep takes one frame
 * rather than bursting twelve to "catch up".
 *
 * **A missing frame is data.** Capture needs a live browser, so a closed laptop leaves a
 * hole. That hole is the answer to "how much time did I spend", so nothing here backfills
 * it; the sidecar records the real capturedAt next to the expectedAt it was aiming for,
 * and summarizeRun() reads the difference as a gap.
 *
 * **Recording state lives in sessionStorage, and that is the whole reload story.** It
 * survives a refresh and a `./restart.sh --refresh`, and it dies with the browser tab —
 * which is exactly the lifetime a per-window run wants. A run id therefore continues into
 * the same folder across a reload, and a genuinely new window starts a genuinely new run.
 *
 * **The indicator is host chrome, not a mod.** A mod iframe receives no theme variables
 * (the same reason openScheduledHistory and the quiet-mode toggle are host-rendered), and
 * the off switch has to reach the server, which a mod's localStorage toggle never does.
 */

import { nsKey } from './storage-namespace.js';
import { captureElementToPng } from './dom-capture.js';

// Cheap and frequent: the tick does a clock comparison, not a capture. Short enough that
// an unthrottled tab lands within 15s of its deadline, long enough to be free.
const TICK_MS = 15000;

// Half scale. A day is ~288 frames; at native CSS-pixel size that is hundreds of MB per
// window, and terminal text stays legible enough to see which tab was doing what.
const FRAME_SCALE = 0.5;

const STATE_KEY = nsKey('deepsteve-timelapse');

let cb = {};                 // host callbacks, supplied by app.js
let enabled = true;          // server setting `timelapseEnabled`
let intervalMs = 5 * 60 * 1000;
let run = null;              // { runId, startedAt, nextDueAt } while recording
let dotEl = null;
let timer = null;
let capturing = false;       // one capture in flight; a slow render must not overlap
let lastInputAt = null;      // window-level, see armInputStamp()

// ─────────────────────────────────────────────────────────────── persisted run state

function loadRun() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.runId !== 'string' || !s.runId) return null;
    return {
      runId: s.runId,
      startedAt: Number(s.startedAt) || Date.now(),
      // A deadline restored from before the reload may already be in the past; that is
      // correct — the next tick captures immediately, which is what a reload that
      // straddled a deadline should do.
      nextDueAt: Number(s.nextDueAt) || Date.now() + intervalMs,
    };
  } catch { return null; }
}

function saveRun() {
  try {
    if (run) sessionStorage.setItem(STATE_KEY, JSON.stringify(run));
    else sessionStorage.removeItem(STATE_KEY);
  } catch { /* private mode — recording still works, it just won't survive a reload */ }
}

/**
 * `<YYYYMMDD-HHMMSS>-<windowId>`.
 *
 * The window id is IN the directory name because each window records its own stream: two
 * windows have two tab strips, and merging them would make "how many tabs did I open"
 * unanswerable. The name is also the sort key, so a day's runs list chronologically.
 */
function newRunId(now) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const win = (cb.getWindowId && cb.getWindowId()) || 'win';
  // Belt and braces against the server's runId charset check — a window id is generated,
  // but the run id is a path segment and should not depend on that staying true.
  return `${stamp}-${String(win).replace(/[^A-Za-z0-9._-]/g, '')}`;
}

// ────────────────────────────────────────────────────────────────────── the indicator

function buildDot() {
  const el = document.createElement('button');
  el.id = 'timelapse-dot';
  el.className = 'timelapse-dot';
  el.type = 'button';
  el.addEventListener('click', () => toggle());
  return el;
}

function paintDot() {
  if (!dotEl) return;
  const on = !!run;
  dotEl.classList.toggle('recording', on);
  dotEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  dotEl.title = on
    ? 'Recording timelapse — click to stop'
    : `Record a timelapse (a screenshot + tab snapshot every ${Math.round(intervalMs / 60000)} min)`;
  dotEl.setAttribute('aria-label', dotEl.title);
}

// ───────────────────────────────────────────────────────────────── the snapshot itself

/**
 * The browser's half of a frame. The daemon fills in agent type, worktree, cwd and the
 * busy/idle tri-state on arrival — see timelapse-snapshot.js for why the join is there
 * and not here.
 */
function buildClientSnapshot(now, expectedAt) {
  const tabs = [];
  // The DOM is the source of tab-strip order (the same derivation app.js's getAllTabIds
  // uses), so the recorded index is the position actually on screen.
  const els = document.querySelectorAll('#tabs-list .tab');
  els.forEach((el, index) => {
    const id = el.id.replace('tab-', '');
    const s = (cb.getTabInfo && cb.getTabInfo(id)) || {};
    tabs.push({
      id,
      index,
      title: s.name || null,
      type: s.type || 'terminal',
      active: id === (cb.getActiveTabId && cb.getActiveTabId()),
      contextHidden: el.classList.contains('context-hidden'),
      waitingForInput: !!s.waitingForInput,
      hasUnseenActivity: !!s.hasUnseenActivity,
      ...(s.modId ? { modId: s.modId } : {}),
      ...(s.projectModId ? { projectModId: s.projectModId } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
    });
  });

  return {
    capturedAt: now,
    expectedAt,
    window: {
      windowId: (cb.getWindowId && cb.getWindowId()) || null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      // The two halves of "was I here": the tab was rendering, and the OS gave it focus.
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      // ...and the third: was anything actually typed or clicked. Without this a window
      // left open overnight reads identically to a window being worked in.
      lastInputAt,
      msSinceInput: lastInputAt === null ? null : now - lastInputAt,
      layout: (cb.getLayoutInfo && cb.getLayoutInfo()) || null,
      activeTabId: (cb.getActiveTabId && cb.getActiveTabId()) || null,
      tabCount: tabs.length,
    },
    tabs,
  };
}

async function captureFrame(expectedAt) {
  if (capturing) return;
  const target = document.getElementById('app-container');
  if (!target) return;
  capturing = true;
  try {
    const now = Date.now();
    // divertToIframe:false — the target holds the fullscreen-app slot and every tab
    // iframe, and diverting into one would return that app instead of the chrome this
    // frame exists to record. See dom-capture.js.
    const dataUrl = await captureElementToPng(target, { divertToIframe: false, scale: FRAME_SCALE });
    const snapshot = buildClientSnapshot(now, expectedAt);
    const res = await fetch('/api/timelapse/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: run.runId, startedAt: run.startedAt, intervalMs, dataUrl, ...snapshot }),
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
  } catch (e) {
    // A dropped frame is a gap, and a gap is already meaningful. Log it and keep the run
    // going rather than tearing down a day's recording over one failed render.
    console.error('[timelapse] frame failed:', e.message);
  } finally {
    capturing = false;
  }
}

// ──────────────────────────────────────────────────────────────────────── the deadline

function tick() {
  if (!run || !enabled) return;
  const now = Date.now();
  if (now < run.nextDueAt) return;
  const expectedAt = run.nextDueAt;
  // Re-anchor to NOW, not to expectedAt + intervalMs. Anchoring to the missed deadline
  // makes a tab that was hidden for an hour fire twelve captures back to back, each of
  // the same screen, which is worse than useless — it is twelve identical frames that
  // hide the gap the run is supposed to show.
  run.nextDueAt = now + intervalMs;
  saveRun();
  captureFrame(expectedAt);
}

function startTimer() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

// ───────────────────────────────────────────────────────────────────────── public API

export function isRecording() { return !!run; }

export function start() {
  if (run || !enabled) return;
  const now = Date.now();
  run = { runId: newRunId(now), startedAt: now, nextDueAt: now };
  saveRun();
  startTimer();
  paintDot();
  // Frame 0 immediately, so a run always has a "here is what it looked like when I
  // started" and clicking the dot has visible consequences inside a second.
  tick();
}

export function stop() {
  run = null;
  saveRun();
  stopTimer();
  paintDot();
}

export function toggle() { run ? stop() : start(); }

/**
 * Show or hide the dot, and tell whoever owns the rail — the strip hides itself when it
 * has nothing visible in it, and a hidden dot does not count.
 */
function setDotVisible(on) {
  if (dotEl) dotEl.style.display = on ? '' : 'none';
  if (cb.onIndicatorVisibility) cb.onIndicatorVisibility(on);
}

/** Server setting changed (broadcast, so a second window follows the first). */
export function setEnabled(on) {
  enabled = !!on;
  if (!enabled && run) stop();
  setDotVisible(enabled);
  paintDot();
}

export function setIntervalMinutes(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return;
  intervalMs = Math.round(n) * 60 * 1000;
  // Re-aim an in-flight run at the new cadence instead of letting it serve out the old
  // deadline — otherwise shortening the interval appears to do nothing for five minutes.
  if (run) {
    run.nextDueAt = Math.min(run.nextDueAt, Date.now() + intervalMs);
    saveRun();
  }
  paintDot();
}

/**
 * Window-level last-input stamp.
 *
 * The daemon tracks lastInputTime per SESSION; nothing tracks it per WINDOW, and per
 * window is what "how much time do I spend in deepsteve" needs. Capture phase so a
 * handler that stops propagation (the terminal does) cannot hide the keystroke, and
 * passive so this never costs the input path anything.
 */
function armInputStamp() {
  const stamp = () => { lastInputAt = Date.now(); };
  for (const ev of ['keydown', 'pointerdown', 'wheel']) {
    document.addEventListener(ev, stamp, { capture: true, passive: true });
  }
}

/**
 * @param {Function} callbacks.mountIndicator  hand the dot to whoever owns the rail
 * @param {Function} callbacks.onIndicatorVisibility  the dot was shown or hidden
 * @param {Function} callbacks.getWindowId
 * @param {Function} callbacks.getActiveTabId
 * @param {Function} callbacks.getTabInfo      id → the client's session record
 * @param {Function} callbacks.getLayoutInfo   layout / overview / panel / context state
 */
export function init(callbacks = {}) {
  cb = callbacks;
  armInputStamp();

  dotEl = buildDot();
  if (cb.mountIndicator) cb.mountIndicator(dotEl);
  setDotVisible(enabled);

  // Resume a run that a page reload interrupted, into the SAME folder.
  run = loadRun();
  if (run && enabled) startTimer();
  else if (run) run = null;
  paintDot();

  // A throttled tab can be a minute late on its own timer, but coming back to the
  // foreground is a real event — take the overdue frame then rather than waiting out the
  // clamp. Both are just tick(), which is idempotent before the deadline.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('focus', tick);
}
