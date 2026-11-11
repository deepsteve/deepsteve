/**
 * View headers — the row on top of the terminal.
 *
 * A conversation starts with a prompt and wanders, and by the hundredth turn nothing on screen
 * says what the tab was for. #view-header says it: the tab's first prompt, in a row above the
 * terminal, whenever the tab you are looking at is in a view whose file names a `header` (the
 * "Project views" section of mods/project-mods/tools.js). Like the footer under the monitor it
 * follows the TAB, not the selection — project-views.js's headerFor() answers for any tab — and
 * it is hidden while the fullscreen view slot or a superview is up, and while the active tab is
 * one the strip hides.
 *
 * `prompt` is the only field. It is the same first prompt the cards superview and the task board
 * show, from GET /api/project-views/cards, which also answers Claude Code's own title for the
 * conversation. So it is Claude-only: an agent with no transcript we can read answers
 * `supported: false` and gets no row. A session asked nothing yet gets a row saying so, asked
 * again every POLL_MS while you look at it, so the prompt you are about to type appears there
 * without the row moving, and so does the title Claude Code writes during the first reply.
 *
 * The toggle at the row's top-left steps through three modes, and its label names the one shown:
 *   Summary       Claude Code's title, one line. The default.
 *   First line    the first prompt, one line, cut off with an ellipsis.
 *   First prompt  the whole first prompt, three lines (scrolled if it is longer).
 * A session with no title yet shows its first line in place of the summary, and the toggle skips
 * Summary until there is one. The button is as wide as its widest label in every mode, so it
 * never moves and a second click lands where the first did. Which mode is a browser-wide
 * preference, like the task board's Ungrouped column.
 *
 * Layout: the row is absolutely placed at the top of #terminals and every terminal container
 * starts below it. This module only toggles .view-header-open and .view-header-collapsed on
 * #terminals; styles.css derives --ds-view-header-h from them. The heights are fixed whatever
 * has arrived, and render() runs inside switchTo() before the incoming terminal is fitted, so a
 * late answer never resizes the terminal a second time.
 *
 * Like view-footer.js it never imports app.js or project-views.js; app.js injects what it needs.
 */

import { nsKey } from './storage-namespace.js';

const FRESH_MS = 5 * 60 * 1000;   // a found prompt and title: re-read now and then, since /clear starts a new one
const POLL_MS = 5000;             // a session with no prompt or no title yet, while it is on screen
const RETRY_MS = 30 * 1000;       // no answer at all (not a session, or not one yet)
const MODE_KEY = nsKey('deepsteve-view-header-mode');

const MODES = ['summary', 'line', 'full'];
const LABELS = { summary: 'Summary', line: 'First line', full: 'First prompt' };
const HINTS = { summary: 'Show Claude’s summary', line: 'Show the first line of the first prompt', full: 'Show the whole first prompt' };

const facts = new Map();     // tab id → { at, data: { prompt, title } | null }
const fetching = new Set();  // tab ids with a request in flight
let cb = {};
let lastSig = null;
let pollTimer = null;

export function init(callbacks) {
  cb = callbacks || {};
  render();
}

/** The mode the user picked last: 'summary' (the default), 'line' or 'full'. */
export function chosenMode() {
  let m = null;
  try { m = localStorage.getItem(MODE_KEY); } catch { /* private mode */ }
  return MODES.includes(m) ? m : 'summary';
}

function setMode(m) {
  try { m === 'summary' ? localStorage.removeItem(MODE_KEY) : localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
}

/** Summary needs a title; until there is one the first line stands in. */
const shownMode = (mode, title) => (mode === 'summary' && !title ? 'line' : mode);
const nextMode = (mode, title) => shownMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length], title);

// Found both: re-read now and then. Missing either: ask again while it is on screen.
const maxAge = (hit) => (!hit.data ? RETRY_MS : hit.data.prompt && hit.data.title ? FRESH_MS : POLL_MS);

/** Show, fill or hide the row for the active tab. Cheap: a signature skips a no-op pass. */
export function render() {
  const el = document.getElementById('view-header');
  if (!el) return;
  clearTimeout(pollTimer);
  pollTimer = null;
  const active = cb.isViewSlotUp?.() ? null : cb.getActiveTabId?.() || null;
  const id = active && !cb.isTabHidden?.(active) ? active : null;
  const header = id ? cb.headerFor?.(id) : null;
  if (!header) {
    paint(el, null);
    return;
  }
  const hit = facts.get(id);
  if (!hit || Date.now() - hit.at >= maxAge(hit)) load(id);
  // Asked, and nothing came back — a tab that is not a session, or an agent whose transcript we
  // cannot read. No row, and none while it is asked again either, or the terminal would jump.
  if (hit && !hit.data) {
    paint(el, null);
    return;
  }
  const prompt = hit ? hit.data.prompt || null : undefined;
  const title = hit ? hit.data.title || null : null;
  if (hit && !(prompt && title)) pollTimer = setTimeout(render, POLL_MS);
  paint(el, { id, prompt, title, mode: shownMode(chosenMode(), title) });
}

function load(id) {
  if (fetching.has(id)) return;
  fetching.add(id);
  fetch('/api/project-views/cards?ids=' + encodeURIComponent(id))
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((body) => {
      fetching.delete(id);
      const answer = body && body.prompts && body.prompts[id];
      facts.set(id, { at: Date.now(), data: answer && answer.supported ? { prompt: answer.prompt || null, title: answer.title || null } : null });
      render();
    });
}

function toggleButton(mode, title) {
  const next = nextMode(mode, title);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vh-toggle';
  btn.title = HINTS[next];
  btn.setAttribute('aria-expanded', mode === 'full' ? 'true' : 'false');
  const caret = document.createElement('span');
  caret.className = 'vh-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = mode === 'full' ? '▾' : '▸';
  // Every label is drawn, in one grid cell, and only the current one is visible (styles.css):
  // the button is as wide as the widest in every mode, so it never shrinks out from under the
  // pointer between two clicks.
  const labels = document.createElement('span');
  labels.className = 'vh-labels';
  for (const m of MODES) {
    const label = document.createElement('span');
    label.className = m === mode ? 'vh-label vh-current' : 'vh-label';
    label.textContent = LABELS[m];
    labels.appendChild(label);
  }
  btn.append(caret, labels);
  // Keep the keyboard in the terminal: a focused button would take the next Enter.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    setMode(next);
    render();
  });
  return btn;
}

function paint(el, state) {
  const sig = JSON.stringify(state);
  if (sig === lastSig) return;
  lastSig = sig;
  el.classList.toggle('hidden', !state);
  const host = document.getElementById('terminals');
  host?.classList.toggle('view-header-open', !!state);
  host?.classList.toggle('view-header-collapsed', !!state && state.mode !== 'full');
  el.replaceChildren();
  if (!state) return;
  el.appendChild(toggleButton(state.mode, state.title));
  const text = document.createElement('div');
  text.className = 'vh-prompt';
  if (state.mode === 'summary') {
    text.classList.add('vh-summary');
    text.textContent = state.title;
  } else if (state.prompt === undefined) {
    // Not here yet: the row already holds its place.
    text.classList.add('vh-muted');
    text.textContent = '…';
  } else if (state.prompt === null) {
    text.classList.add('vh-muted');
    text.textContent = 'No prompt yet';
  } else {
    text.textContent = state.prompt;
  }
  el.appendChild(text);
}
