/**
 * Context Views — group tabs into folder-based "contexts" and filter the tab
 * strip to one context at a time (#522).
 *
 * A context = { id, name, dirs: [absolute repo paths] }. A tab belongs to a
 * context when its cwd is inside one of those folders (prefix match), so
 * subdirectories AND worktree sessions (<repo>/.claude/worktrees/...) are
 * included automatically. Selecting a context hides non-matching tabs; "All"
 * shows everything. Display tabs carry the cwd of the session that spawned them
 * (#530), so they scope to that context like any session tab. Tabs with no cwd
 * (mod tabs) are treated as global and stay visible in every context.
 *
 * UI: a left context panel (#context-rail) toggled by the #context-toggle button
 * (next to the layout switcher) or by Cmd+P — preventDefault'd so the browser's
 * Print dialog never opens. Cmd+Up / Cmd+Down cycle through [All, ...contexts].
 * Chord: Cmd+P then A (Cmd held the whole time) jumps to the "All" view — the A
 * is gated behind Cmd+P so a bare Cmd+A stays native (terminal/input select-all).
 *
 * Self-contained module following the cmd-tab-switch.js / command-palette.js
 * pattern: init(callbacks), setEnabled(val), plus applyFilter()/
 * requestNewTabInContext() for app.js to call.
 */

import { nsKey } from './storage-namespace.js';

// Context definitions are server-owned (#526): they are the same entity as the
// Scheduled Tasks "project groups", loaded from /api/contexts and kept fresh by
// the 'contexts' WS broadcast (app.js → setContexts). Only the per-window VIEW
// state (which context is active, whether the rail is open) stays client-side.
const ACTIVE_KEY = nsKey('deepsteve-context-active');   // sessionStorage: active id (per window)
const SIDEBAR_KEY = nsKey('deepsteve-context-sidebar'); // sessionStorage: open state (per window)

let enabled = true;
let contexts = [];          // [{ id, name, dirs: [] }]
let activeContextId = null; // null = view all
let sidebarOpen = false;
let cmdChordArmed = false;  // true between a Cmd+P press and the Cmd release — see onKeyDown

let cb = {};       // callbacks injected by app.js
let rail = null;   // #context-rail element
let toggleBtn = null;
let emptyOverlay = null; // #context-empty-state — covers the terminal area when the active context has no tabs

// ---------------------------------------------------------------- persistence

// Definitions come from the server. Fetch once on init; live updates arrive via
// setContexts() (called by app.js on the 'contexts' broadcast).
function fetchContexts() {
  fetch('/api/contexts')
    .then(r => r.json())
    .then(d => setContexts(d.contexts || []))
    .catch(() => {});
}
// Persist a single upsert / delete to the server. The server broadcasts the new
// full list back to every window (setContexts), so we don't reconcile by hand.
function saveContext(c) {
  fetch('/api/contexts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  }).catch(() => {});
}
function deleteContextOnServer(id) {
  fetch('/api/contexts/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
}
function loadActive() {
  return sessionStorage.getItem(ACTIVE_KEY) || null;
}
function saveActive() {
  if (activeContextId) sessionStorage.setItem(ACTIVE_KEY, activeContextId);
  else sessionStorage.removeItem(ACTIVE_KEY);
}
function loadSidebar() {
  return sessionStorage.getItem(SIDEBAR_KEY) === '1';
}
function saveSidebar() {
  sessionStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
}

function genId() {
  try { return crypto.randomUUID().slice(0, 8); }
  catch { return Math.random().toString(36).slice(2, 10); }
}

// ------------------------------------------------------------------- matching

function tabInContext(cwd, ctx) {
  if (!ctx) return true;
  if (!cwd) return true; // no cwd (mod/display tab) → global, visible everywhere
  return ctx.dirs.some(d => {
    const base = d.replace(/\/+$/, '');
    return cwd === base || cwd.startsWith(base + '/');
  });
}

function getActiveContext() {
  return contexts.find(c => c.id === activeContextId) || null;
}

function activeContextHasTabs() {
  const ctx = getActiveContext();
  if (!ctx) return true;
  const ids = cb.getOrderedTabIds ? cb.getOrderedTabIds() : [];
  return ids.some(id => tabInContext(cb.getTabCwd?.(id), ctx));
}

// --------------------------------------------------------------------- filter

// Show/hide the empty-context placeholder over the terminal area. It's an
// opaque overlay (z-index above terminal containers) rather than a real tab, so
// the previously-active terminal stays alive underneath and reappears the moment
// the overlay is hidden — no activeId/container juggling needed in app.js.
function setEmptyOverlay(show) {
  if (!emptyOverlay) return;
  const wasHidden = emptyOverlay.classList.contains('hidden');
  emptyOverlay.classList.toggle('hidden', !show);
  // Move focus onto the button when it first appears so keystrokes don't leak to
  // the covered terminal's (still-focused) hidden textarea.
  if (show && wasHidden) emptyOverlay.querySelector('button')?.focus();
}

export function applyFilter() {
  if (!enabled) return;
  const ctx = getActiveContext();
  const ids = cb.getOrderedTabIds ? cb.getOrderedTabIds() : [];
  let firstVisible = null;

  for (const id of ids) {
    const tabEl = document.getElementById('tab-' + id);
    if (!tabEl) continue;
    const visible = tabInContext(cb.getTabCwd?.(id), ctx);
    tabEl.classList.toggle('context-hidden', !visible);
    if (visible && !firstVisible) firstVisible = id;
  }

  // If a context is active and the current active tab is now hidden, move to
  // the first visible tab that belongs to the context.
  if (ctx) {
    const activeTab = cb.getActiveTabId?.();
    const activeHidden = !activeTab ||
      document.getElementById('tab-' + activeTab)?.classList.contains('context-hidden');
    if (activeHidden && firstVisible) cb.switchToTab?.(firstVisible);
  }

  // A context with no matching tabs has no terminal to show — cover the stale
  // one with the empty-state placeholder. Any other state hides it.
  setEmptyOverlay(!!ctx && firstVisible === null);

  renderRail();
}

// ----------------------------------------------------------------- rail (DOM)

function renderRail() {
  if (!rail || !sidebarOpen) return;
  rail.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'context-rail-header';
  header.textContent = 'Contexts';
  rail.appendChild(header);

  const list = document.createElement('div');
  list.className = 'context-list';
  list.appendChild(makeRow(null, 'All', activeContextId === null, null));
  for (const ctx of contexts) {
    list.appendChild(makeRow(ctx.id, ctx.name, ctx.id === activeContextId, ctx));
  }
  rail.appendChild(list);

  // Empty-context helper — clickable to open a tab in the context's repo.
  if (getActiveContext() && !activeContextHasTabs()) {
    const note = document.createElement('div');
    note.className = 'context-empty-note';
    note.textContent = 'No tabs in this context — click to open one.';
    note.onclick = () => newTabInActiveContext();
    rail.appendChild(note);
  }

  const add = document.createElement('div');
  add.className = 'context-add';
  add.textContent = '+ New context';
  add.onclick = () => openContextEditor(null);
  rail.appendChild(add);

  const hint = document.createElement('div');
  hint.className = 'context-hint';
  hint.textContent = '⌘↑/↓ switch · ⌘P hide · ⌘P→A all';
  rail.appendChild(hint);
}

function makeRow(id, name, active, ctx) {
  const row = document.createElement('div');
  row.className = 'context-row' + (active ? ' active' : '');
  row.onclick = () => selectContext(id);

  const label = document.createElement('span');
  label.className = 'context-row-label';
  label.textContent = name;
  row.appendChild(label);

  if (ctx) {
    const edit = document.createElement('span');
    edit.className = 'context-row-edit';
    edit.textContent = '✎';
    edit.title = 'Edit context';
    edit.onclick = (e) => { e.stopPropagation(); openContextEditor(ctx); };
    row.appendChild(edit);
  }
  return row;
}

function selectContext(id) {
  activeContextId = id;
  saveActive();
  notifyActive();
  applyFilter();
}

// Tell app.js (→ the scheduled-tasks panel) which context is active. Half of the
// bidirectional sync; the other half is setActiveContext(), called when the panel
// picks a group.
function notifyActive() {
  cb.onActiveContextChanged?.(activeContextId);
}

// -------------------------------------------------------------------- sidebar

function setSidebar(open) {
  sidebarOpen = open;
  saveSidebar();
  if (rail) rail.style.display = open ? 'flex' : 'none';
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', open);
    toggleBtn.title = open ? 'Hide contexts (⌘P)' : 'Show contexts (⌘P)';
  }
  if (open) renderRail();
  window.dispatchEvent(new Event('resize'));
}

function toggleSidebar() {
  setSidebar(!sidebarOpen);
  document.activeElement?.blur();
}

// ---------------------------------------------------------------------- toast

let toastEl = null;
let toastTimer = null;
function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'context-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('visible'), 1300);
}

// ------------------------------------------------------------------- keyboard

function cycleContext(dir) {
  const order = [null, ...contexts.map(c => c.id)];
  if (order.length <= 1) return;
  const idx = order.indexOf(activeContextId);
  const next = dir > 0
    ? (idx >= order.length - 1 ? 0 : idx + 1)
    : (idx <= 0 ? order.length - 1 : idx - 1);
  activeContextId = order[next];
  saveActive();
  notifyActive();
  applyFilter();
  showToast(activeContextId ? (getActiveContext()?.name || 'Context') : 'All tabs');
}

// True for real form fields where Cmd+P / Cmd+Arrow should stay native. The
// terminal's own xterm-helper-textarea is deliberately excluded so shortcuts
// still work while a terminal is focused.
function isFormField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return true;
  if (tag === 'TEXTAREA') return !el.classList.contains('xterm-helper-textarea');
  return !!el.isContentEditable;
}

function onKeyDown(e) {
  if (!enabled || !e.metaKey) return;
  if (isFormField(e.target)) return;

  // Cmd+P — toggle the context panel. We swallow the event (preventDefault) so
  // the browser's Print dialog never opens. Unlike the old Cmd+C binding, this
  // needs no copy special-casing since Cmd+P doesn't collide with terminal copy.
  // Also arms the Cmd+P→A chord until Cmd is released (see onKeyUp).
  if (e.code === 'KeyP' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    cmdChordArmed = true;
    toggleSidebar();
    return;
  }

  // Cmd+P then A (Cmd held) — jump to the "All" view. Only fires while the chord
  // is armed by a preceding Cmd+P, so a bare Cmd+A stays native (select-all).
  if (e.code === 'KeyA' && cmdChordArmed && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!sidebarOpen) setSidebar(true);
    selectContext(null);
    showToast('All tabs');
    return;
  }

  // Cmd+Up / Cmd+Down — cycle through [All, ...contexts].
  if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (contexts.length === 0) return; // nothing to cycle; leave native behavior
    e.preventDefault();
    e.stopPropagation();
    cycleContext(e.code === 'ArrowDown' ? 1 : -1);
  }
}

// Releasing Cmd closes the Cmd+P→A chord window.
function onKeyUp(e) {
  if (e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight') cmdChordArmed = false;
}

// ------------------------------------------------------ new tab in a context

/**
 * Called by app.js's new-tab flow. Returns true if it opened (or will open) a
 * tab in the active context — i.e. a context is selected and the current tab
 * isn't already inside it. Returns false to let the default new-tab flow run
 * (which inherits the active tab's cwd, keeping you in-context already).
 */
export function requestNewTabInContext() {
  if (!enabled) return false;
  const ctx = getActiveContext();
  if (!ctx || ctx.dirs.length === 0) return false;
  const activeCwd = cb.getTabCwd?.(cb.getActiveTabId?.());
  if (activeCwd && tabInContext(activeCwd, ctx)) return false;
  newTabInActiveContext(ctx);
  return true;
}

async function newTabInActiveContext(ctx) {
  ctx = ctx || getActiveContext();
  if (!ctx || ctx.dirs.length === 0) return;
  let dir = ctx.dirs[0];
  if (ctx.dirs.length > 1) {
    dir = await chooseDir(ctx.dirs);
    if (!dir) return;
  }
  cb.createSessionInDir?.(dir);
}

function chooseDir(dirs) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal context-dir-chooser';
    const h = document.createElement('h2');
    h.textContent = 'Open new tab in…';
    modal.appendChild(h);
    for (const d of dirs) {
      const b = document.createElement('button');
      b.className = 'btn-secondary context-choose-dir';
      b.textContent = d;
      b.title = d;
      b.onclick = () => { overlay.remove(); resolve(d); };
      modal.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { overlay.remove(); resolve(null); };
    modal.appendChild(cancel);
    overlay.appendChild(modal);
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
    document.body.appendChild(overlay);
  });
}

// ------------------------------------------------------------- context editor

function openContextEditor(ctx) {
  const isNew = !ctx;
  const draft = {
    id: ctx?.id || genId(),
    name: ctx?.name || '',
    dirs: ctx ? [...ctx.dirs] : [],
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal context-editor';
  overlay.appendChild(modal);

  const h = document.createElement('h2');
  h.textContent = isNew ? 'New context' : 'Edit context';
  modal.appendChild(h);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Context name';
  nameInput.value = draft.name;
  nameInput.className = 'context-name-input';
  modal.appendChild(nameInput);

  const dirsWrap = document.createElement('div');
  dirsWrap.className = 'context-dirs';
  modal.appendChild(dirsWrap);

  const addWrap = document.createElement('div');
  addWrap.className = 'context-add-dir';
  modal.appendChild(addWrap);

  function renderDirs() {
    dirsWrap.innerHTML = '';
    if (draft.dirs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'context-dirs-empty';
      empty.textContent = 'No folders yet — add a repo below.';
      dirsWrap.appendChild(empty);
    }
    for (const d of draft.dirs) {
      const row = document.createElement('div');
      row.className = 'context-dir-row';
      const path = document.createElement('span');
      path.className = 'context-dir-path';
      path.textContent = d;
      path.title = d;
      row.appendChild(path);
      const rm = document.createElement('button');
      rm.className = 'context-dir-remove';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.onclick = () => { draft.dirs = draft.dirs.filter(x => x !== d); renderDirs(); };
      row.appendChild(rm);
      dirsWrap.appendChild(row);
    }
    renderAddControls();
  }

  function renderAddControls() {
    addWrap.innerHTML = '';
    const recents = (cb.getRecentDirs?.() || [])
      .map(r => r && r.path).filter(Boolean)
      .filter(p => !draft.dirs.includes(p));
    if (recents.length) {
      const sel = document.createElement('select');
      sel.className = 'context-recent-select';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Add recent folder…';
      sel.appendChild(def);
      for (const p of recents) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        if (sel.value && !draft.dirs.includes(sel.value)) {
          draft.dirs.push(sel.value);
          renderDirs();
        }
      };
      addWrap.appendChild(sel);
    }
    const browse = document.createElement('button');
    browse.className = 'btn-secondary';
    browse.textContent = 'Browse…';
    browse.onclick = async () => {
      const dir = await cb.showDirPicker?.();
      if (dir && typeof dir === 'string' && !draft.dirs.includes(dir)) {
        draft.dirs.push(dir);
        renderDirs();
      }
    };
    addWrap.appendChild(browse);
  }

  renderDirs();

  const btns = document.createElement('div');
  btns.className = 'modal-buttons';

  if (!isNew) {
    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      contexts = contexts.filter(c => c.id !== draft.id);
      if (activeContextId === draft.id) { activeContextId = null; saveActive(); notifyActive(); }
      deleteContextOnServer(draft.id);
      overlay.remove();
      applyFilter();
    };
    btns.appendChild(del);
  }

  const cancel = document.createElement('button');
  cancel.className = 'btn-secondary';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => overlay.remove();
  btns.appendChild(cancel);

  const save = document.createElement('button');
  save.className = 'btn-primary';
  save.textContent = 'Save';
  save.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    // Optimistic local upsert so the rail updates immediately; the server
    // broadcast (setContexts) reconciles this and every other window.
    const existing = contexts.find(c => c.id === draft.id);
    if (existing) {
      existing.name = name;
      existing.dirs = draft.dirs;
    } else {
      contexts.push({ id: draft.id, name, dirs: draft.dirs });
    }
    saveContext({ id: draft.id, name, dirs: draft.dirs });
    activeContextId = draft.id; // focus the context we just saved
    saveActive();
    notifyActive();
    overlay.remove();
    applyFilter();
  };
  btns.appendChild(save);
  modal.appendChild(btns);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') save.click();
    else if (e.key === 'Escape') overlay.remove();
  };
  document.body.appendChild(overlay);
  nameInput.focus();
}

// ------------------------------------------------------------------ lifecycle

export function init(callbacks) {
  cb = callbacks || {};
  contexts = [];                    // seeded from the server by fetchContexts() below
  activeContextId = loadActive();   // restored per-window; validated once contexts arrive
  sidebarOpen = loadSidebar();

  toggleBtn = document.getElementById('context-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);

  // Mount the rail as the left-most child of #app-container so it spans the full
  // height to the LEFT of everything (tab strip + terminal), not tucked under the
  // tabs. #app-main wraps the tabs + content column; the rail sits before it.
  rail = document.createElement('div');
  rail.id = 'context-rail';
  const appContainer = document.getElementById('app-container');
  const appMain = document.getElementById('app-main');
  if (appContainer && appMain) appContainer.insertBefore(rail, appMain);
  else if (appContainer) appContainer.insertBefore(rail, appContainer.firstChild);

  // Empty-context placeholder — an opaque overlay over the terminal area, shown
  // when the active context has no matching tabs (see setEmptyOverlay).
  const terminals = document.getElementById('terminals');
  if (terminals) {
    emptyOverlay = document.createElement('div');
    emptyOverlay.id = 'context-empty-state';
    emptyOverlay.className = 'hidden';
    const msg = document.createElement('div');
    msg.className = 'context-empty-msg';
    msg.textContent = 'No tabs in this context.';
    const btn = document.createElement('button');
    btn.className = 'context-empty-new';
    btn.textContent = '+ New tab in this context';
    btn.onclick = () => newTabInActiveContext();
    emptyOverlay.append(msg, btn);
    terminals.appendChild(emptyOverlay);
  }

  setSidebar(sidebarOpen);
  applyFilter();

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  fetchContexts(); // seed definitions from the server (single source of truth)
}

// Called by app.js when the server pushes the full context list (initial load +
// every 'contexts' broadcast). Re-validates the active id and re-filters.
export function setContexts(list) {
  contexts = Array.isArray(list) ? list : [];
  if (activeContextId && !contexts.find(c => c.id === activeContextId)) {
    activeContextId = null;
    saveActive();
    notifyActive();
  }
  applyFilter();
}

// Bidirectional-in: the scheduled-tasks panel picked a group → make it active
// here too. Guards against a no-op / feedback loop and ignores unknown ids.
export function setActiveContext(id) {
  const next = id || null;
  if (next === activeContextId) return;
  if (next && !contexts.find(c => c.id === next)) return;
  activeContextId = next;
  saveActive();
  notifyActive();
  applyFilter();
}

export function getActiveContextId() {
  return activeContextId;
}

export function setEnabled(val) {
  enabled = !!val;
  if (toggleBtn) toggleBtn.style.display = enabled ? '' : 'none';
  if (!enabled) {
    setSidebar(false);
    setEmptyOverlay(false);
    // Un-hide any filtered tabs so disabling the feature reveals everything.
    document.querySelectorAll('.tab.context-hidden').forEach(t => t.classList.remove('context-hidden'));
  } else {
    applyFilter();
  }
}
