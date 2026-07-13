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
let indicatorEl = null; // #context-indicator — muted active-context name shown next to the toggle when the rail is closed (#531)
let ruleTitleEl = null; // #context-rule-title — dashed ruled variant of the same label shown at the top of the terminal in the retro-monitor theme (#535)

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
// Persist a drag-to-reorder (#532). Send the full id order; the server rebuilds
// its array and broadcasts the new list back (setContexts) to every window.
function persistOrder(order) {
  fetch('/api/contexts/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  }).catch(() => {});
}
// Delete a context locally (optimistic) + on the server. Shared by the editor
// modal's Delete button and the row right-click menu (#532).
function deleteContext(ctx) {
  contexts = contexts.filter(c => c.id !== ctx.id);
  if (activeContextId === ctx.id) { activeContextId = null; saveActive(); notifyActive(); }
  deleteContextOnServer(ctx.id);
  applyFilter();
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

// Owned-tab count for the rail badge (#529). "All" (ctx null) → every tab. A real
// context → only tabs whose real cwd is inside its dirs; no-cwd global tabs
// (mod/display) are excluded so they don't inflate every context. This means the
// per-context counts intentionally won't sum to the "All" total.
function contextTabCount(ctx) {
  const ids = cb.getOrderedTabIds ? cb.getOrderedTabIds() : [];
  if (!ctx) return ids.length;
  return ids.reduce((n, id) => {
    const cwd = cb.getTabCwd?.(id);
    return n + (cwd && tabInContext(cwd, ctx) ? 1 : 0);
  }, 0);
}

// --------------------------------------------------------------------- filter

// True when a real context is active but none of the open tabs belong to it —
// the "empty context" case. app.js queries this so the shared #empty-state
// welcome screen (nice ASCII branding + "+ New") covers the stale terminal
// instead of a separate bland placeholder (#534). "All" / disabled → never empty.
export function activeContextIsEmpty() {
  return enabled && !!getActiveContext() && !activeContextHasTabs();
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

  // A context with no matching tabs has no terminal to show — ask app.js to
  // recompute the shared #empty-state screen (it covers the stale terminal via
  // activeContextIsEmpty). Any other state hides it. See #534.
  cb.updateEmptyState?.();

  renderRail();
  updateIndicator();
}

// Muted active-context name shown right of the ◧ toggle, but only while the rail
// is closed and a real context is filtering (in "All" nothing is hidden, so the
// label stays blank). This is the sole "which context?" cue when the menu is
// collapsed (#531). Driven from applyFilter() + setSidebar(), the two choke
// points every context / open-close transition already passes through.
function updateIndicator() {
  const ctx = getActiveContext();               // null in "All"
  const show = enabled && !sidebarOpen && !!ctx; // rail closed + real context
  const name = show ? ctx.name : '';
  const tip  = show ? `Context: ${ctx.name} — click to open (⌘P)` : '';
  // Drive both presentations: the tab-strip label (#context-indicator) and the
  // ruled terminal title (#context-rule-title). CSS picks which one is visible —
  // the retro-monitor theme hides the former and reveals the latter (#535).
  for (const el of [indicatorEl, ruleTitleEl]) {
    if (!el) continue;
    el.textContent = name;
    el.classList.toggle('hidden', !show);
    el.title = tip;
  }
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
  hint.textContent = '⌘↑/↓ switch · ⌘P hide · right-click to edit · drag to reorder';
  rail.appendChild(hint);
}

function makeRow(id, name, active, ctx) {
  const row = document.createElement('div');
  row.className = 'context-row' + (active ? ' active' : '');

  const label = document.createElement('span');
  label.className = 'context-row-label';
  label.textContent = name;
  row.appendChild(label);

  const n = contextTabCount(ctx);
  if (n > 0) {
    const count = document.createElement('span');
    count.className = 'context-row-count';
    count.textContent = n;
    count.title = n + (n === 1 ? ' tab' : ' tabs');
    row.appendChild(count);
  }

  if (ctx) {
    // Real contexts: Edit/Delete via right-click menu (keeps the row to just
    // name + badge so everything aligns), and drag-to-reorder. Click selects.
    // A data attribute both marks the row draggable and identifies it in the
    // reorder/drag logic. The "All" row (ctx null) gets none of this, so it
    // stays pinned at the top and non-draggable.
    row.dataset.contextId = ctx.id;
    row.title = 'Right-click to edit · drag to reorder';
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showRowMenu(e.clientX, e.clientY, ctx);
    });
    wireRowDrag(row, ctx);
  } else {
    row.onclick = () => selectContext(id);
  }
  return row;
}

// -------------------------------------------------------- row right-click menu

let rowMenu = null;
function hideRowMenu() {
  if (rowMenu) { rowMenu.remove(); rowMenu = null; }
  document.removeEventListener('click', onRowMenuDocClick, true);
  document.removeEventListener('keydown', onRowMenuKey, true);
}
function onRowMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); hideRowMenu(); }
}
// Close on any click outside the menu. Kept as a stable reference (not a
// self-removing one-shot) so it survives an inside-menu click that isn't on an
// item — the listener stays until the menu is actually hidden, so a later
// outside click still dismisses it.
function onRowMenuDocClick(e) {
  if (rowMenu && !rowMenu.contains(e.target)) hideRowMenu();
}
function showRowMenu(x, y, ctx) {
  hideRowMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu context-row-menu';

  const edit = document.createElement('div');
  edit.className = 'context-menu-item';
  edit.textContent = 'Edit';
  edit.onclick = () => { hideRowMenu(); openContextEditor(ctx); };
  menu.appendChild(edit);

  const del = document.createElement('div');
  del.className = 'context-menu-item';
  del.textContent = 'Delete';
  del.style.color = 'var(--ds-accent-red)';
  del.onclick = () => {
    hideRowMenu();
    if (confirm(`Delete context "${ctx.name}"?`)) deleteContext(ctx);
  };
  menu.appendChild(del);

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Nudge back on-screen if it would overflow (mirror tab-manager positioning).
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  rowMenu = menu;
  // Dismiss on any outside click (deferred so this menu's own opening
  // right-click doesn't immediately close it) and on Escape.
  setTimeout(() => {
    if (rowMenu === menu) document.addEventListener('click', onRowMenuDocClick, true);
  }, 0);
  document.addEventListener('keydown', onRowMenuKey, true);
}

// ------------------------------------------------------- row drag-to-reorder

// Vertical drag adapted from tab-manager.js: start only after the pointer moves
// past a small threshold (so a plain click still selects); reorder the real DOM
// rows live; persist the new order on release. Only rows carrying
// data-contextId participate, so the "All" row can never be displaced.
const ROW_MOVE_THRESHOLD = 5;
let rowDrag = null; // { row } while a drag is in progress

function wireRowDrag(row, ctx) {
  const onPointerDown = (e) => {
    if (e.button && e.button !== 0) return; // left button / touch only
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    const startY = e.touches ? e.touches[0].clientY : e.clientY;
    let dragging = false;

    const onMove = (me) => {
      const cx = me.touches ? me.touches[0].clientX : me.clientX;
      const cy = me.touches ? me.touches[0].clientY : me.clientY;
      if (!dragging && (Math.abs(cx - startX) > ROW_MOVE_THRESHOLD || Math.abs(cy - startY) > ROW_MOVE_THRESHOLD)) {
        dragging = true;
        startRowDrag(row);
      }
    };
    const onUp = () => {
      cleanup();
      if (!dragging) selectContext(ctx.id); // no drag → treat as a click
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
  };

  row.addEventListener('mousedown', onPointerDown);
  row.addEventListener('touchstart', onPointerDown, { passive: true });
}

function startRowDrag(row) {
  rowDrag = { row };
  row.classList.add('dragging');
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onRowDragMove);
  document.addEventListener('touchmove', onRowDragMove, { passive: false });
  document.addEventListener('mouseup', endRowDrag);
  document.addEventListener('touchend', endRowDrag);
  document.addEventListener('visibilitychange', endRowDrag);
}

function onRowDragMove(e) {
  if (!rowDrag) return;
  e.preventDefault();
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const list = rowDrag.row.parentNode;
  if (!list) return;
  const rows = [...list.querySelectorAll('.context-row')].filter(r => r.dataset.contextId);
  for (const other of rows) {
    if (other === rowDrag.row) continue;
    const rect = other.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      list.insertBefore(rowDrag.row, other);
      return;
    }
  }
  list.appendChild(rowDrag.row); // past all rows → move to end
}

function endRowDrag() {
  if (!rowDrag) return;
  const { row } = rowDrag;
  rowDrag = null;
  row.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onRowDragMove);
  document.removeEventListener('touchmove', onRowDragMove);
  document.removeEventListener('mouseup', endRowDrag);
  document.removeEventListener('touchend', endRowDrag);
  document.removeEventListener('visibilitychange', endRowDrag);

  const list = row.parentNode;
  if (!list) return;
  const order = [...list.querySelectorAll('.context-row')].map(r => r.dataset.contextId).filter(Boolean);
  // Optimistic local reorder so the rail is stable immediately; the server
  // broadcast (setContexts) reconciles this and every other window.
  const byId = new Map(contexts.map(c => [c.id, c]));
  contexts = order.map(id => byId.get(id)).filter(Boolean);
  persistOrder(order);
  renderRail(); // rebuild rows with fresh handlers / cleared drag state
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
  updateIndicator();
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
      deleteContext(draft);
      overlay.remove();
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
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleSidebar);
    // Muted active-context label injected right after the toggle (like the rail
    // itself, it's created here rather than hard-coded in index.html). Clicking
    // it opens the rail — it's only ever visible while the rail is closed.
    indicatorEl = document.createElement('span');
    indicatorEl.id = 'context-indicator';
    indicatorEl.className = 'hidden';
    indicatorEl.addEventListener('click', () => {
      setSidebar(true);
      document.activeElement?.blur();
    });
    toggleBtn.insertAdjacentElement('afterend', indicatorEl);
  }

  // Mount the rail as the left-most child of #app-container so it spans the full
  // height to the LEFT of everything (tab strip + terminal), not tucked under the
  // tabs. #app-main wraps the tabs + content column; the rail sits before it.
  rail = document.createElement('div');
  rail.id = 'context-rail';
  const appContainer = document.getElementById('app-container');
  const appMain = document.getElementById('app-main');
  if (appContainer && appMain) appContainer.insertBefore(rail, appMain);
  else if (appContainer) appContainer.insertBefore(rail, appContainer.firstChild);

  // Closed-context label variant for the retro-monitor CRT theme (#535). It is
  // display:none in every theme by default; the retro-monitor theme reveals it and
  // insets it into the monitor's top frame line (like a fieldset legend), hiding the
  // tab-strip #context-indicator instead. Mounted as a child of #app-container (not
  // #app-main, whose overflow:clip would crop a label straddling its top bezel edge)
  // so it can sit on the frame line. Kept in sync by updateIndicator(); clicking it
  // opens the rail like the indicator.
  if (appContainer) {
    ruleTitleEl = document.createElement('div');
    ruleTitleEl.id = 'context-rule-title';
    ruleTitleEl.className = 'hidden';
    ruleTitleEl.addEventListener('click', () => {
      setSidebar(true);
      document.activeElement?.blur();
    });
    appContainer.insertBefore(ruleTitleEl, appContainer.firstChild);
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
    // Un-hide any filtered tabs so disabling the feature reveals everything.
    document.querySelectorAll('.tab.context-hidden').forEach(t => t.classList.remove('context-hidden'));
    cb.updateEmptyState?.(); // recompute (activeContextIsEmpty now returns false)
  } else {
    applyFilter();
  }
}
