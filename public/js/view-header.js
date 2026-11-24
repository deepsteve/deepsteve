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
 * The toggle at the row's top-left steps through the modes, and its label names the one shown:
 *   Custom Label  words the user chose for the tab, one line. Only for a tab that has one.
 *   Summary       Claude Code's title, one line. The default.
 *   First line    the first prompt, one line, cut off with an ellipsis.
 *   First prompt  the whole first prompt, three lines (scrolled if it is longer).
 * A session with no title yet shows its first line in place of the summary, and the toggle skips
 * Summary until there is one. The button is as wide as its widest label in every mode, so it
 * never moves and a second click lands where the first did. Its hover text names the control
 * ("Header mode"); the label already says which mode is on. Which of Summary, First line and
 * First prompt is a browser-wide preference. The task board titles each tab's card with the
 * default chain (Custom Label, else Summary, else First line) whatever the preference says.
 *
 * Right-clicking the row opens a menu that sets or clears the tab's Custom Label. It is kept on
 * the session by the server (PUT /api/project-views/custom-label/:id), and a tab that has one
 * shows it every time you arrive at the tab, whatever the preference says; clicking the toggle
 * moves off it for that visit only. Every window is told of a change (the 'custom-label' ping,
 * routed here by app.js as onCustomLabel()).
 *
 * Claude Code writes the title within a few seconds of the first prompt. The poll above should
 * bring it, but a row was seen sitting on the first line until its tab was switched away and
 * back, so TITLE_DUE_MS after the row first shows a tab's prompt it asks once more on a timer of
 * its own, and logs to the daemon if the poll had brought nothing new by then.
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
import { clientLog } from './client-log.js';
import { enableMenuKeyboard } from './context-menu.js';

const FRESH_MS = 5 * 60 * 1000;   // a found prompt and title: re-read now and then, since /clear starts a new one
const POLL_MS = 5000;             // a session with no prompt or no title yet, while it is on screen
const RETRY_MS = 30 * 1000;       // no answer at all (not a session, or not one yet)
// A tab on screen whose answer is this stale has missed three polls: worth a line in the daemon
// log, at most once a minute per tab. Nothing reproduced the row sitting on an old answer until
// its button was clicked, so this records the next time it does.
const OVERDUE_MS = 3 * POLL_MS;
const OVERDUE_LOG_MS = 60 * 1000;
// The title lands within about 3s of the first prompt in nearly every transcript on the
// development machine, so 10s after the row first shows a tab's prompt the title is due.
const TITLE_DUE_MS = 10 * 1000;
const MODE_KEY = nsKey('deepsteve-view-header-mode');

// The toggle's order. 'custom' is never stored as the preference: it belongs to one tab.
const MODES = ['custom', 'summary', 'line', 'full'];
const STORED_MODES = ['summary', 'line', 'full'];
const LABELS = { custom: 'Custom Label', summary: 'Summary', line: 'First line', full: 'First prompt' };
const TOGGLE_HINT = 'Header mode';
const MENU_ID = 'view-header-menu';

const facts = new Map();     // tab id → { at, data: { prompt, title, customLabel } | null }
const fetching = new Set();  // tab ids with a request in flight
let cb = {};
let lastSig = null;
let pollTimer = null;
let pollArmedAt = 0;
let shownId = null;          // the tab the row is about, and since when
let shownSince = 0;
let showCustom = true;       // a tab with a Custom Label shows it until the toggle moves off it; reset on arrival
let titleDue = null;         // { id, at, timer }: the one-off ask after the shown tab's first prompt
let menu = null;             // the open right-click menu: { el, keys }
const overdueLogged = new Map();   // tab id → when it was last logged

export function init(callbacks) {
  cb = callbacks || {};
  const el = document.getElementById('view-header');
  // The row is built once and only its children are repainted, so these stay put.
  el?.addEventListener('contextmenu', onContextMenu);
  // A right-click leaves the keyboard in the terminal, as a click on the toggle does.
  el?.addEventListener('mousedown', (e) => { if (e.button === 2) e.preventDefault(); });
  render();
}

/** The mode the user picked last: 'summary' (the default), 'line' or 'full'. */
export function chosenMode() {
  let m = null;
  try { m = localStorage.getItem(MODE_KEY); } catch { /* private mode */ }
  return STORED_MODES.includes(m) ? m : 'summary';
}

function setMode(m) {
  try { m === 'summary' ? localStorage.removeItem(MODE_KEY) : localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
}

/** Can a tab with this title and Custom Label show mode `m`? */
const available = (m, title, customLabel) => (m === 'custom' ? !!customLabel : m === 'summary' ? !!title : true);
/** Summary needs a title; until there is one the first line stands in. */
const shownMode = (mode, title) => (mode === 'summary' && !title ? 'line' : mode);
/** What the row shows: a tab's Custom Label, unless the toggle moved off it this visit; else the preference. */
const displayMode = (title, customLabel) => (customLabel && showCustom ? 'custom' : shownMode(chosenMode(), title));
/** The next mode in the toggle's order that this tab can show. */
function nextMode(mode, title, customLabel) {
  let i = MODES.indexOf(mode);
  for (let n = 0; n < MODES.length; n++) {
    i = (i + 1) % MODES.length;
    if (available(MODES[i], title, customLabel)) return MODES[i];
  }
  return mode;
}

// Found both: re-read now and then. Missing either: ask again while it is on screen.
const maxAge = (hit) => (!hit.data ? RETRY_MS : hit.data.prompt && hit.data.title ? FRESH_MS : POLL_MS);

/**
 * Show, fill or hide the row for the active tab. Cheap: a signature skips a no-op pass.
 * `reason` only labels the overdue line: 'poll', 'click', or app.js's 'app'.
 */
export function render(reason = 'app') {
  const el = document.getElementById('view-header');
  if (!el) return;
  const armedFor = pollTimer ? Date.now() - pollArmedAt : null;
  clearTimeout(pollTimer);
  pollTimer = null;
  const active = cb.isViewSlotUp?.() ? null : cb.getActiveTabId?.() || null;
  const id = active && !cb.isTabHidden?.(active) ? active : null;
  const header = id ? cb.headerFor?.(id) : null;
  if (!header) {
    shownId = null;
    closeMenu();
    clearTitleDue();
    paint(el, null);
    return;
  }
  if (id !== shownId) {
    shownId = id;
    shownSince = Date.now();
    showCustom = true;
    closeMenu();
    if (titleDue && titleDue.id !== id) clearTitleDue();
  }
  const hit = facts.get(id);
  if (!hit || Date.now() - hit.at >= maxAge(hit)) {
    if (hit) noteOverdue(id, hit, reason, armedFor);
    load(id);
  }
  // Asked, and nothing came back — a tab that is not a session, or an agent whose transcript we
  // cannot read. No row, and none while it is asked again either, or the terminal would jump.
  if (hit && !hit.data) {
    paint(el, null);
    return;
  }
  const prompt = hit ? hit.data.prompt || null : undefined;
  const title = hit ? hit.data.title || null : null;
  const customLabel = hit ? hit.data.customLabel || null : null;
  if (hit && !(prompt && title)) {
    pollTimer = setTimeout(() => render('poll'), POLL_MS);
    pollArmedAt = Date.now();
  }
  paint(el, { id, prompt, title, customLabel, mode: displayMode(title, customLabel) });
}

/**
 * The shown tab's first prompt has just reached the row, without a title: ask again in
 * TITLE_DUE_MS whatever the poll does. render() clears and re-arms the poll on every pass, so a
 * pass that ever failed to re-arm it would leave the row on the first line until something else
 * rendered it, which in practice is switching tabs. This timer belongs to no pass.
 */
function armTitleDue(id) {
  clearTitleDue();
  const at = facts.get(id)?.at || 0;
  titleDue = { id, at, timer: setTimeout(() => titleCameDue(id, at), TITLE_DUE_MS) };
}

function clearTitleDue() {
  if (titleDue) clearTimeout(titleDue.timer);
  titleDue = null;
}

function titleCameDue(id, at) {
  titleDue = null;
  if (id !== shownId) return;   // arriving back at the tab asks anyway
  const hit = facts.get(id);
  if (hit && hit.data && !hit.data.title) {
    // Still the answer that brought the prompt: the poll, due every POLL_MS, brought nothing.
    if (hit.at === at) {
      clientLog('view-header', `tab ${id}: no answer in the ${Math.round(TITLE_DUE_MS / 1000)}s since its first prompt, `
        + `asked every ${Math.round(POLL_MS / 1000)}s; poll ${pollTimer ? `armed ${Math.round((Date.now() - pollArmedAt) / 1000)}s ago` : 'not armed'}; `
        + `${fetching.has(id) ? 'a request in flight' : 'nothing in flight'}; asking now`);
    }
    load(id);
  }
  render('title-due');
}

/**
 * A tab that has been on screen since its last answer, still waiting for its prompt or title,
 * and asked again far later than POLL_MS: the poll did not do its job. Say so in the daemon log.
 */
function noteOverdue(id, hit, reason, armedFor) {
  const age = Date.now() - hit.at;
  if (!hit.data || maxAge(hit) !== POLL_MS || age < OVERDUE_MS || shownSince > hit.at) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (overdueLogged.has(id) && Date.now() - overdueLogged.get(id) < OVERDUE_LOG_MS) return;
  overdueLogged.set(id, Date.now());
  const s = (ms) => `${Math.round(ms / 1000)}s`;
  clientLog('view-header', `tab ${id}: answer ${s(age)} old, asked every ${s(POLL_MS)}; this pass from ${reason}; `
    + `poll ${armedFor == null ? 'not armed' : `armed ${s(armedFor)} ago`}; ${fetching.has(id) ? 'a request in flight' : 'nothing in flight'}; `
    + `has ${hit.data.prompt ? 'prompt' : 'no prompt'}, ${hit.data.title ? 'title' : 'no title'}`);
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
      const before = facts.get(id);
      const data = answer && answer.supported
        ? { prompt: answer.prompt || null, title: answer.title || null, customLabel: answer.customLabel || null }
        : null;
      facts.set(id, { at: Date.now(), data });
      const firstPrompt = data && data.prompt && !(before && before.data && before.data.prompt);
      if (firstPrompt && !data.title && id === shownId) armTitleDue(id);
      render();
    });
}

/** A tab's Custom Label was set or cleared, in this window or another ('custom-label' ping). */
export function onCustomLabel(id, customLabel) {
  const hit = facts.get(id);
  if (hit && hit.data) hit.data = { ...hit.data, customLabel: customLabel || null };
  if (id === shownId) showCustom = true;
  render();
}

// ── The right-click menu ─────────────────────────────────────────────────────────────────────
// The same .context-menu rows and keyboard as the tab's menu (context-menu.js), with a separate
// id: tab-manager.js removes its own menu on every right-click, and this one must survive the
// right-click that opened it.

function onContextMenu(e) {
  if (!shownId) return;
  e.preventDefault();
  const hit = facts.get(shownId);
  openMenu(e.clientX, e.clientY, shownId, hit && hit.data ? hit.data.customLabel || null : null);
}

function openMenu(x, y, id, customLabel) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'context-menu';
  el.id = MENU_ID;
  el.setAttribute('role', 'menu');
  const item = (text, pick) => {
    const row = document.createElement('div');
    row.className = 'context-menu-item';
    row.setAttribute('role', 'menuitem');
    row.textContent = text;
    row.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      closeMenu();
      pick();
    });
    el.appendChild(row);
  };
  item('Custom Label…', () => askCustomLabel(id, customLabel));
  if (customLabel) item('Clear Custom Label', () => saveCustomLabel(id, null));
  // Measured at the corner first, so the width is the menu's own, then kept on screen.
  el.style.left = '0px';
  el.style.top = '0px';
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  menu = { el, keys: enableMenuKeyboard(el, { onClose: closeMenu }) };
  document.addEventListener('mousedown', onOutside, true);
}

function onOutside(e) {
  if (menu && !menu.el.contains(e.target)) closeMenu();
}

function closeMenu() {
  if (!menu) return;
  document.removeEventListener('mousedown', onOutside, true);
  menu.keys.dispose();
  menu.el.remove();
  menu = null;
}

function askCustomLabel(id, current) {
  const typed = globalThis.prompt('Custom Label:', current || '');
  if (typed === null) return;   // cancelled
  saveCustomLabel(id, typed.trim() || null);
}

async function saveCustomLabel(id, customLabel) {
  let saved = customLabel;
  try {
    const res = await fetch('/api/project-views/custom-label/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customLabel }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    if (body && 'customLabel' in body) saved = body.customLabel;
  } catch (e) {
    globalThis.alert?.(`The Custom Label was not saved: ${e.message}`);
    return;
  }
  onCustomLabel(id, saved);
}

function toggleButton(mode, title, customLabel) {
  const next = nextMode(mode, title, customLabel);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vh-toggle';
  btn.title = TOGGLE_HINT;
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
    // Back onto the Custom Label is for this visit; any other mode is also the new preference.
    showCustom = next === 'custom';
    if (next !== 'custom') setMode(next);
    render('click');
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
  el.appendChild(toggleButton(state.mode, state.title, state.customLabel));
  const text = document.createElement('div');
  text.className = 'vh-prompt';
  if (state.mode === 'custom') {
    text.classList.add('vh-summary');
    text.textContent = state.customLabel;
  } else if (state.mode === 'summary') {
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
