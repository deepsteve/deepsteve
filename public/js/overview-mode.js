/**
 * Overview Mode — show all terminals at once in a grid layout.
 *
 * Toggle with a configurable shortcut (default Cmd+O). Single-click a tile
 * to focus it; double-click (or use the × button) to exit overview and open
 * that terminal.
 * Supports two layouts: "tall" (vertical stacking) and "tiled" (2-row grid).
 *
 * Overview is PER-CONTEXT view state, not a global mode (#590). The grid only
 * ever tiles the active context's tabs, so "overview is on" belongs to the
 * context you turned it on in: switching away hides that context's grid and
 * gives its terminals their size back, switching back re-shows it. That makes
 * two states, and keeping them apart is the whole design here:
 *
 *   activeContexts — which contexts WANT a grid. Persisted, only toggle()/exit()
 *                    and setEnabled(false) write it.
 *   shownContext   — which context currently HAS one rendered. Pure DOM state;
 *                    only showGrid()/hideGrid() write it.
 *
 * syncToContext() is the single reconciler between them, driven by
 * context-views' applyFilter(). Before #590 there was one global `isActive`
 * boolean and no context hook at all, so the old context's tiles stayed on
 * screen under the new context's tabs.
 */

import { nsKey } from './storage-namespace.js';
import { register } from './shortcuts.js';

const LAYOUT_KEY = nsKey('deepsteve-overview-layout');  // localStorage: tall|tiled, a global preference
const ACTIVE_KEY = nsKey('deepsteve-overview-active');  // sessionStorage: context keys with overview on (per window)

// sessionStorage-safe stand-in for the null "All" context. "All" is a context
// like any other here — it can have its own grid, and it is the only key in play
// when context views are disabled.
const ALL_KEY = '__all__';

let enabled = true;
let shortcut = 'Meta+o';
let currentLayout = 'tall';
let defaultLayout = 'tall';

let activeContexts = new Set();  // context keys whose overview is on
let shownContext = null;         // context key whose grid is rendered, or null for none
let savedDims = new Map();       // id → {cols, rows} captured as a terminal entered the grid

let callbacks = {};
let observer = null;

const matchesShortcut = register({
  id: 'overview-mode',
  group: 'Views',
  description: 'Toggle overview mode (all terminals at once)',
  getShortcut: () => shortcut,
  isEnabled: () => enabled,
});

// ------------------------------------------------------------------ persistence

function contextKey() {
  return callbacks.getActiveContextId?.() || ALL_KEY;
}

function loadActiveContexts() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter(k => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveActiveContexts() {
  try {
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify([...activeContexts]));
  } catch {
    // sessionStorage full/unavailable — the in-memory Set still drives this session
  }
}

// ----------------------------------------------------------------------- layout

function applyLayout() {
  const terminals = document.getElementById('terminals');
  terminals.classList.remove('overview-tall', 'overview-tiled');
  terminals.classList.add(`overview-${currentLayout}`);

  if (currentLayout === 'tiled') {
    const count = terminals.querySelectorAll('.terminal-container.overview-visible').length;
    terminals.style.setProperty('--overview-cols', Math.max(1, Math.ceil(count / 2)));
  } else {
    terminals.style.removeProperty('--overview-cols');
  }

  const btn = document.getElementById('overview-layout-btn');
  if (btn) {
    btn.textContent = currentLayout === 'tall' ? '▐▌' : '⊞';
    btn.title = currentLayout === 'tall' ? 'Switch to tiled layout' : 'Switch to tall layout';
  }
}

// -------------------------------------------------------------------- the grid

/**
 * Decorate one container as a tile and remember the terminal's pre-overview grid.
 * The dimensions have to be captured BEFORE the tile is fitted — that fit is what
 * destroys them — and only on the way in, so a container that is re-synced while
 * already tiled keeps its original (full-size) numbers rather than recording the
 * tile size as the thing to restore.
 */
function addTile(id, session) {
  if (!savedDims.has(id) && session.term) {
    savedDims.set(id, { cols: session.term.cols, rows: session.term.rows });
  }

  session.container.classList.remove('active');
  session.container.classList.add('overview-visible');

  if (!session.container.querySelector('.overview-label')) {
    const label = document.createElement('div');
    label.className = 'overview-label';
    label.textContent = callbacks.getTabName?.(id) || id;
    session.container.appendChild(label);
  }

  updateWaitingIndicator(session);
}

/**
 * Render the grid for the active context. Does NOT touch activeContexts — callers
 * own that. Safe to call when a grid is already shown for this context; it just
 * re-syncs (new tabs in, closed tabs out).
 */
function showGrid() {
  const ids = callbacks.getOrderedTabIds?.() || [];
  if (ids.length === 0) return;

  const key = contextKey();
  const first = shownContext !== key;
  shownContext = key;
  if (first) currentLayout = localStorage.getItem(LAYOUT_KEY) || defaultLayout;

  const terminals = document.getElementById('terminals');
  terminals.classList.add('overview-mode');

  // Reorder terminal containers to match tab order — DOM insertion order
  // may differ from tab order after async restore or drag-reorder.
  for (const id of ids) {
    const container = document.getElementById(`term-${id}`);
    if (container) terminals.appendChild(container);
  }

  const tiled = new Set();
  for (const id of ids) {
    const session = callbacks.getSession?.(id);
    if (!session?.container) continue;
    addTile(id, session);
    tiled.add(id);
  }

  // Drop dimensions for tabs that left the grid (closed, or filtered out) so a
  // later exit doesn't try to resize a terminal that no longer exists.
  for (const id of [...savedDims.keys()]) {
    if (!tiled.has(id)) savedDims.delete(id);
  }

  applyLayout();

  const activeId = callbacks.getActiveTabId?.();
  if (activeId) updateFocusClass(activeId);

  const btn = document.getElementById('overview-layout-btn');
  if (btn) btn.style.display = '';
  const exitBtn = document.getElementById('overview-exit-btn');
  if (exitBtn) exitBtn.style.display = '';

  // Only the tiles — fitting every session is what stranded out-of-context
  // terminals at tile dimensions before #590.
  const fitIds = [...tiled];
  requestAnimationFrame(() => {
    callbacks.fitTerminals?.(fitIds);
  });

  startObserver();
}

/**
 * Tear the grid down and give every terminal in it its size back. Does NOT touch
 * activeContexts, and deliberately does NOT reveal a context: hideGrid() runs
 * inside a context switch (from syncToContext), so re-activating the tab through
 * the revealing focusTab would yank the view straight back to the context the
 * user just left. exit() layers the reveal on top for the paths that want it.
 */
function hideGrid() {
  if (!shownContext) return;
  shownContext = null;

  stopObserver();

  const terminals = document.getElementById('terminals');
  terminals.classList.remove('overview-mode', 'overview-tall', 'overview-tiled');
  terminals.style.removeProperty('--overview-cols');

  // Clean up all overview state from containers
  const containers = terminals.querySelectorAll('.terminal-container');
  for (const container of containers) {
    container.classList.remove('overview-visible', 'overview-focused');
    container.querySelector('.overview-label')?.remove();
    container.querySelector('.overview-waiting')?.remove();
  }

  // Hide layout switcher and exit button
  const btn = document.getElementById('overview-layout-btn');
  if (btn) btn.style.display = 'none';
  const exitBtn = document.getElementById('overview-exit-btn');
  if (exitBtn) exitBtn.style.display = 'none';

  // showGrid() stripped `active` off every tile, so without this the terminal
  // area is left with no visible container at all.
  const activeId = callbacks.getActiveTabId?.();
  if (activeId) callbacks.activateTab?.(activeId);

  // Restore dimensions after the overview CSS is gone, so the one container that
  // is still visible measures against its real box.
  const dims = savedDims;
  savedDims = new Map();
  requestAnimationFrame(() => {
    callbacks.restoreTerminals?.(dims);
  });
}

/**
 * Reconcile the rendered grid with the active context. Called at the end of
 * context-views' applyFilter(), i.e. after every context switch AND after every
 * tab-set change — so it has to be idempotent and cheap when nothing moved.
 */
export function syncToContext() {
  if (!enabled) return;
  const key = contextKey();

  // Already rendered for this context — the MutationObserver owns tiles coming
  // and going, so re-running showGrid() here would only churn the DOM on every
  // tab change.
  if (shownContext === key) return;

  if (shownContext) hideGrid();
  if (activeContexts.has(key)) showGrid();
}

// ---------------------------------------------------------------- decorations

function updateFocusClass(activeId) {
  const terminals = document.getElementById('terminals');
  terminals.querySelectorAll('.terminal-container.overview-focused').forEach(el => {
    el.classList.remove('overview-focused');
  });
  if (activeId) {
    const container = document.getElementById(`term-${activeId}`);
    if (container) container.classList.add('overview-focused');
  }
}

function updateWaitingIndicator(session) {
  if (!session?.container) return;
  const existing = session.container.querySelector('.overview-waiting');
  if (session.waitingForInput) {
    if (!existing) {
      const dot = document.createElement('div');
      dot.className = 'overview-waiting';
      session.container.appendChild(dot);
    }
  } else {
    existing?.remove();
  }
}

function startObserver() {
  if (observer) return;
  const terminals = document.getElementById('terminals');
  observer = new MutationObserver(() => {
    if (!shownContext) return;
    // Re-sync: pull newly created containers into the grid, evict closed ones.
    const ids = callbacks.getOrderedTabIds?.() || [];
    const tiled = new Set();
    const fresh = [];
    for (const id of ids) {
      const session = callbacks.getSession?.(id);
      if (!session?.container) continue;
      tiled.add(id);
      if (!session.container.classList.contains('overview-visible')) {
        addTile(id, session);
        fresh.push(id);
      }
    }
    for (const id of [...savedDims.keys()]) {
      if (!tiled.has(id)) savedDims.delete(id);
    }
    applyLayout();
    if (fresh.length) {
      requestAnimationFrame(() => {
        callbacks.fitTerminals?.(fresh);
      });
    }
  });
  observer.observe(terminals, { childList: true });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// -------------------------------------------------------------------- actions

/**
 * Turn overview off for the active context and open a terminal. This is the
 * user-driven dismiss (× button, tile/tab double-click, the shortcut while the
 * grid is up), so unlike hideGrid() it clears the persisted flag and jumps
 * through the revealing switchToTab.
 */
function exit(targetId) {
  const key = contextKey();
  const wasShown = !!shownContext;
  if (activeContexts.delete(key)) saveActiveContexts();
  hideGrid();

  if (!wasShown) return;
  const switchId = targetId || callbacks.getActiveTabId?.();
  if (switchId) callbacks.switchToTab?.(switchId);
}

function onKeyDown(e) {
  if (!enabled) return;
  if (!matchesShortcut(e)) return;

  e.preventDefault();
  e.stopPropagation();
  toggle();
}

function onClickFocus(e) {
  if (!shownContext) return;

  const container = e.target.closest('.terminal-container');
  if (!container) return;

  e.preventDefault();
  e.stopPropagation();

  const id = container.id.replace('term-', '');
  callbacks.switchToTab?.(id);
  updateFocusClass(id);
}

function onDblClick(e) {
  if (!shownContext) return;

  const container = e.target.closest('.terminal-container');
  if (!container) return;

  e.preventDefault();
  e.stopPropagation();

  const id = container.id.replace('term-', '');
  exit(id);
}

function onTabDblClick(e) {
  if (!shownContext) return;

  const tab = e.target.closest('.tab');
  if (!tab) return;

  e.preventDefault();
  e.stopPropagation();

  const id = tab.id.replace('tab-', '');
  exit(id);
}

// ----------------------------------------------------------------------- API

export function init(cbs) {
  callbacks = cbs;
  activeContexts = loadActiveContexts();
  document.addEventListener('keydown', onKeyDown, true);
  document.getElementById('terminals')?.addEventListener('click', onClickFocus, true);
  document.getElementById('terminals')?.addEventListener('dblclick', onDblClick, true);
  document.getElementById('tabs-list')?.addEventListener('dblclick', onTabDblClick);
  document.getElementById('overview-layout-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleLayout();
  });
  document.getElementById('overview-exit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    exit(null);
  });
}

export function setEnabled(val) {
  enabled = !!val;
  if (enabled) return;
  // Turning the feature off clears every context's grid, not just the shown one —
  // otherwise re-enabling would silently resurrect grids the user can't see now.
  if (activeContexts.size) {
    activeContexts.clear();
    saveActiveContexts();
  }
  hideGrid();
}

export function setShortcut(val) {
  if (val && typeof val === 'string') {
    shortcut = val;
  }
}

export function setDefaultLayout(val) {
  if (val === 'tall' || val === 'tiled') {
    defaultLayout = val;
  }
}

export function getLayout() {
  return currentLayout;
}

export function cycleLayout() {
  if (!shownContext) return;
  currentLayout = currentLayout === 'tall' ? 'tiled' : 'tall';
  localStorage.setItem(LAYOUT_KEY, currentLayout);
  applyLayout();
  requestAnimationFrame(() => {
    callbacks.fitTerminals?.(callbacks.getOrderedTabIds?.() || []);
  });
}

export function toggle() {
  if (!enabled) return;
  if (shownContext) {
    exit(null);
    return;
  }
  const key = contextKey();
  activeContexts.add(key);
  saveActiveContexts();
  showGrid();
  // Nothing to tile (empty context) — don't leave the flag set on a grid that
  // never appeared, or the next context switch would "restore" a phantom.
  if (!shownContext && activeContexts.delete(key)) saveActiveContexts();
}

export function updateFocus(activeId) {
  if (shownContext) updateFocusClass(activeId);
}

export function onTabsReordered(orderedIds) {
  if (!shownContext) return;
  const terminals = document.getElementById('terminals');
  if (!terminals) return;
  for (const id of orderedIds) {
    const container = document.getElementById(`term-${id}`);
    if (container) terminals.appendChild(container);
  }
  applyLayout();
  // Same tiles, different cells — in tiled layout the cells aren't all the same
  // size, so a moved terminal can land in a differently-shaped one.
  const ids = callbacks.getOrderedTabIds?.() || [];
  requestAnimationFrame(() => {
    callbacks.fitTerminals?.(ids);
  });
}

export function isOverviewActive() {
  return shownContext !== null;
}
