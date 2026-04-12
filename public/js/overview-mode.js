/**
 * Overview Mode — show all terminals at once in a grid layout.
 *
 * Toggle with a configurable shortcut (default Cmd+O). Click a tile to
 * focus it and exit overview. Escape exits without changing the active tab.
 * Supports two layouts: "tall" (vertical stacking) and "tiled" (2-row grid).
 */

let enabled = true;
let shortcut = 'Meta+o';
let isActive = false;
let currentLayout = 'tall';
let defaultLayout = 'tall';

let callbacks = {};
let observer = null;

function parseShortcut(str) {
  const parts = str.split('+');
  const key = parts.pop().toLowerCase();
  const mods = {
    meta: parts.some(p => p.toLowerCase() === 'meta'),
    ctrl: parts.some(p => p.toLowerCase() === 'ctrl'),
    shift: parts.some(p => p.toLowerCase() === 'shift'),
    alt: parts.some(p => p.toLowerCase() === 'alt'),
  };
  return { key, mods };
}

function matchesShortcut(e) {
  const sc = parseShortcut(shortcut);
  if (e.key.toLowerCase() !== sc.key) return false;
  if (sc.mods.meta !== e.metaKey) return false;
  if (sc.mods.ctrl !== e.ctrlKey) return false;
  if (sc.mods.shift !== e.shiftKey) return false;
  if (sc.mods.alt !== e.altKey) return false;
  return true;
}

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
    btn.title = currentLayout === 'tall' ? 'Switch to tiled layout' : 'Switch to tall layout';
  }
}

function enter() {
  const ids = callbacks.getOrderedTabIds?.() || [];
  if (ids.length === 0) return;

  isActive = true;
  currentLayout = defaultLayout;

  const terminals = document.getElementById('terminals');
  terminals.classList.add('overview-mode');

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

  // Show layout switcher
  const btn = document.getElementById('overview-layout-btn');
  if (btn) btn.style.display = '';

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

  // Hide layout switcher
  const btn = document.getElementById('overview-layout-btn');
  if (btn) btn.style.display = 'none';

  // Switch to the target tab, or restore the previously active tab
  const switchId = targetId || callbacks.getActiveTabId?.();
  if (switchId) {
    callbacks.switchToTab?.(switchId);
  }
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
    if (e.key === 'Escape' || matchesShortcut(e)) {
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

function onClick(e) {
  if (!isActive) return;

  const container = e.target.closest('.terminal-container');
  if (!container) return;

  e.preventDefault();
  e.stopPropagation();

  const id = container.id.replace('term-', '');
  exit(id);
}

export function init(cbs) {
  callbacks = cbs;
  document.addEventListener('keydown', onKeyDown, true);
  document.getElementById('terminals')?.addEventListener('click', onClick, true);
  document.getElementById('overview-layout-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleLayout();
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

export function isOverviewActive() {
  return isActive;
}
