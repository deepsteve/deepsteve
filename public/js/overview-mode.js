/**
 * Overview Mode — show all terminals at once in a grid layout.
 *
 * Toggle with a configurable shortcut (default Cmd+O). Single-click a tile
 * to focus it; double-click (or use the × button) to exit overview and open
 * that terminal.
 * Supports two layouts: "tall" (vertical stacking) and "tiled" (2-row grid).
 */

import { nsKey } from './storage-namespace.js';
import { register } from './shortcuts.js';

const LAYOUT_KEY = nsKey('deepsteve-overview-layout');

let enabled = true;
let shortcut = 'Meta+o';
let isActive = false;
let currentLayout = 'tall';
let defaultLayout = 'tall';

let callbacks = {};
let observer = null;

const matchesShortcut = register({
  id: 'overview-mode',
  group: 'Views',
  description: 'Toggle overview mode (all terminals at once)',
  getShortcut: () => shortcut,
  isEnabled: () => enabled,
});

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
    btn.textContent = currentLayout === 'tall' ? '\u2590\u258C' : '\u229E';
    btn.title = currentLayout === 'tall' ? 'Switch to tiled layout' : 'Switch to tall layout';
  }
}

function enter() {
  const ids = callbacks.getOrderedTabIds?.() || [];
  if (ids.length === 0) return;

  isActive = true;
  currentLayout = localStorage.getItem(LAYOUT_KEY) || defaultLayout;

  const terminals = document.getElementById('terminals');
  terminals.classList.add('overview-mode');

  // Reorder terminal containers to match tab order — DOM insertion order
  // may differ from tab order after async restore or drag-reorder.
  for (const id of ids) {
    const container = document.getElementById(`term-${id}`);
    if (container) terminals.appendChild(container);
  }

  for (const id of ids) {
    const session = callbacks.getSession?.(id);
    if (!session?.container) continue;

    session.container.classList.remove('active');
    session.container.classList.add('overview-visible');

    // Add label overlay if not already present
    if (!session.container.querySelector('.overview-label')) {
      const label = document.createElement('div');
      label.className = 'overview-label';
      label.textContent = callbacks.getTabName?.(id) || id;
      session.container.appendChild(label);
    }

    // Add waiting indicator
    updateWaitingIndicator(session);
  }

  applyLayout();

  // Mark the active tab as focused
  const activeId = callbacks.getActiveTabId?.();
  if (activeId) updateFocusClass(activeId);

  // Show layout switcher and exit button
  const btn = document.getElementById('overview-layout-btn');
  if (btn) btn.style.display = '';
  const exitBtn = document.getElementById('overview-exit-btn');
  if (exitBtn) exitBtn.style.display = '';

  requestAnimationFrame(() => {
    callbacks.fitAllTerminals?.();
  });

  // Start observing for dynamic session changes
  startObserver();
}

function exit(targetId) {
  if (!isActive) return;
  isActive = false;

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

  // Switch to the target tab, or restore the previously active tab
  const switchId = targetId || callbacks.getActiveTabId?.();
  if (switchId) {
    callbacks.switchToTab?.(switchId);
  }

  // Refit terminals to normal dimensions after overview CSS is removed
  requestAnimationFrame(() => {
    callbacks.fitAllTerminals?.();
  });
}

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
    if (!isActive) return;
    // Re-sync: ensure new containers get overview-visible + labels
    const ids = callbacks.getOrderedTabIds?.() || [];
    for (const id of ids) {
      const session = callbacks.getSession?.(id);
      if (!session?.container) continue;
      if (!session.container.classList.contains('overview-visible')) {
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
    }
    applyLayout();
    requestAnimationFrame(() => {
      callbacks.fitAllTerminals?.();
    });
  });
  observer.observe(terminals, { childList: true });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function onKeyDown(e) {
  if (!enabled) return;

  if (isActive) {
    if (matchesShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      exit(null);
      return;
    }
    return;
  }

  if (matchesShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
    enter();
  }
}

function onClickFocus(e) {
  if (!isActive) return;

  const container = e.target.closest('.terminal-container');
  if (!container) return;

  e.preventDefault();
  e.stopPropagation();

  const id = container.id.replace('term-', '');
  callbacks.switchToTab?.(id);
  updateFocusClass(id);
}

function onDblClick(e) {
  if (!isActive) return;

  const container = e.target.closest('.terminal-container');
  if (!container) return;

  e.preventDefault();
  e.stopPropagation();

  const id = container.id.replace('term-', '');
  exit(id);
}

function onTabDblClick(e) {
  if (!isActive) return;

  const tab = e.target.closest('.tab');
  if (!tab) return;

  e.preventDefault();
  e.stopPropagation();

  const id = tab.id.replace('tab-', '');
  exit(id);
}

export function init(cbs) {
  callbacks = cbs;
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
  if (!enabled && isActive) exit(null);
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
  if (!isActive) return;
  currentLayout = currentLayout === 'tall' ? 'tiled' : 'tall';
  localStorage.setItem(LAYOUT_KEY, currentLayout);
  applyLayout();
  requestAnimationFrame(() => {
    callbacks.fitAllTerminals?.();
  });
}

export function toggle() {
  if (isActive) {
    exit(null);
  } else {
    enter();
  }
}

export function updateFocus(activeId) {
  if (isActive) updateFocusClass(activeId);
}

export function onTabsReordered(orderedIds) {
  if (!isActive) return;
  const terminals = document.getElementById('terminals');
  if (!terminals) return;
  for (const id of orderedIds) {
    const container = document.getElementById(`term-${id}`);
    if (container) terminals.appendChild(container);
  }
  applyLayout();
  requestAnimationFrame(() => {
    callbacks.fitAllTerminals?.();
  });
}

export function isOverviewActive() {
  return isActive;
}
