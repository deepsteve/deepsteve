/**
 * Overview Mode — show all terminals at once in a grid layout.
 *
 * Toggle with a configurable shortcut (default Cmd+O). Click a tile to
 * focus it and exit overview. Escape exits without changing the active tab.
 * Follows the same init/setEnabled/setShortcut pattern as cmd-tab-switch.js.
 */

let enabled = true;
let shortcut = 'Meta+o';
let isActive = false;

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

function enter() {
  const ids = callbacks.getOrderedTabIds?.() || [];
  if (ids.length === 0) return;

  isActive = true;
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
  terminals.classList.remove('overview-mode');

  // Clean up all overview state from containers
  const containers = terminals.querySelectorAll('.terminal-container');
  for (const container of containers) {
    container.classList.remove('overview-visible');
    container.querySelector('.overview-label')?.remove();
    container.querySelector('.overview-waiting')?.remove();
  }

  // Switch to the target tab, or restore the previously active tab
  const switchId = targetId || callbacks.getActiveTabId?.();
  if (switchId) {
    callbacks.switchToTab?.(switchId);
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

export function toggle() {
  if (isActive) {
    exit(null);
  } else {
    enter();
  }
}

export function isOverviewActive() {
  return isActive;
}
