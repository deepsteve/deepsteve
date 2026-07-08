/**
 * Context Views — group tabs into folder-based "contexts" and filter the tab
 * strip to one context at a time (#522).
 *
 * A context = { id, name, dirs: [absolute repo paths] }. A tab belongs to a
 * context when its cwd is inside one of those folders (prefix match), so
 * subdirectories AND worktree sessions (<repo>/.claude/worktrees/...) are
 * included automatically. Selecting a context hides non-matching tabs; "All"
 * shows everything. Tabs with no cwd (mod/display tabs) are treated as global
 * and stay visible in every context.
 *
 * UI: a left sidecar rail (#context-rail) toggled by the #context-toggle button
 * (next to the layout switcher) or by Cmd+C — but Cmd+C only toggles when there
 * is no text selection, otherwise it falls through to native copy so terminal
 * copy keeps working. Cmd+Up / Cmd+Down cycle through [All, ...contexts].
 *
 * Self-contained module following the cmd-tab-switch.js / command-palette.js
 * pattern: init(callbacks), setEnabled(val), plus applyFilter()/
 * requestNewTabInContext() for app.js to call.
 */

import { nsKey } from './storage-namespace.js';

const CONTEXTS_KEY = nsKey('deepsteve-contexts');       // localStorage: definitions (durable)
const ACTIVE_KEY = nsKey('deepsteve-context-active');   // sessionStorage: active id (per window)
const SIDEBAR_KEY = nsKey('deepsteve-context-sidebar'); // sessionStorage: open state (per window)

let enabled = true;
let contexts = [];          // [{ id, name, dirs: [] }]
let activeContextId = null; // null = view all
let sidebarOpen = false;

let cb = {};       // callbacks injected by app.js
let rail = null;   // #context-rail element
let toggleBtn = null;

// ---------------------------------------------------------------- persistence

function loadContexts() {
  try {
    const v = JSON.parse(localStorage.getItem(CONTEXTS_KEY));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function saveContexts() {
  localStorage.setItem(CONTEXTS_KEY, JSON.stringify(contexts));
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
  hint.textContent = '⌘↑/↓ switch · ⌘C hide';
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
  applyFilter();
}

// -------------------------------------------------------------------- sidebar

function setSidebar(open) {
  sidebarOpen = open;
  saveSidebar();
  if (rail) rail.style.display = open ? 'flex' : 'none';
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', open);
    toggleBtn.title = open ? 'Hide contexts' : 'Show contexts';
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
  applyFilter();
  showToast(activeContextId ? (getActiveContext()?.name || 'Context') : 'All tabs');
}

// True for real form fields where Cmd+C / Cmd+Arrow should stay native. The
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

  // Cmd+C — toggle the sidecar, UNLESS text is selected. deepsteve uses the
  // WebGL renderer, so a terminal selection isn't a native DOM selection and
  // Cmd+C may not copy on its own. When something is selected we copy it
  // explicitly (so terminal copy keeps working) and swallow the event so it
  // never also toggles; with nothing selected, Cmd+C toggles the sidecar.
  if (e.code === 'KeyC' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    const sel = cb.getSelectionText ? cb.getSelectionText() : '';
    if (sel && sel.length) {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard?.writeText(sel).catch(() => {});
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    toggleSidebar();
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
      if (activeContextId === draft.id) { activeContextId = null; saveActive(); }
      saveContexts();
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
    const existing = contexts.find(c => c.id === draft.id);
    if (existing) {
      existing.name = name;
      existing.dirs = draft.dirs;
    } else {
      contexts.push({ id: draft.id, name, dirs: draft.dirs });
    }
    saveContexts();
    activeContextId = draft.id; // focus the context we just saved
    saveActive();
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
  contexts = loadContexts();
  activeContextId = loadActive();
  if (activeContextId && !contexts.find(c => c.id === activeContextId)) activeContextId = null;
  sidebarOpen = loadSidebar();

  toggleBtn = document.getElementById('context-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);

  // Mount the rail as the left-most child of #content-row (created by
  // ModManager.init before this runs). Falls back to before #terminals.
  rail = document.createElement('div');
  rail.id = 'context-rail';
  const contentRow = document.getElementById('content-row');
  const terminals = document.getElementById('terminals');
  if (contentRow) contentRow.insertBefore(rail, contentRow.firstChild);
  else if (terminals) terminals.parentNode.insertBefore(rail, terminals);

  setSidebar(sidebarOpen);
  applyFilter();

  document.addEventListener('keydown', onKeyDown, true);
}

export function setEnabled(val) {
  enabled = !!val;
  if (toggleBtn) toggleBtn.style.display = enabled ? '' : 'none';
  if (!enabled) {
    setSidebar(false);
    // Un-hide any filtered tabs so disabling the feature reveals everything.
    document.querySelectorAll('.tab.context-hidden').forEach(t => t.classList.remove('context-hidden'));
  } else {
    applyFilter();
  }
}
