/**
 * Split Layout Engine
 *
 * Converts #terminals from single-active-terminal mode to CSS grid
 * with multiple visible panes. Each pane holds one terminal session.
 */

import { nsKey } from './storage-namespace.js';

const STORAGE_KEY = nsKey('deepsteve-split-layout');

const PRESETS = {
  'single':  { name: 'Single',     panes: 1, grid: null },
  '2-col':   { name: '2 Columns',  panes: 2, grid: 'split-2-col' },
  '2-row':   { name: '2 Rows',     panes: 2, grid: 'split-2-row' },
  '3-col':   { name: '3 Columns',  panes: 3, grid: 'split-3-col' },
  '2x2':     { name: '2×2 Grid',   panes: 4, grid: 'split-2x2' },
  '1-2':     { name: '1+2',        panes: 3, grid: 'split-1-2' },
  '2-1':     { name: '2+1',        panes: 3, grid: 'split-2-1' },
};

// State
let layoutId = 'single';
let panes = [];       // Array of { sessionId: string|null }
let focusedPane = 0;
let paneElements = []; // DOM elements for .split-pane wrappers
let callbacks = {};    // { onActiveChanged, getSessions, getContainer, focusTerminal, onLayoutChanged }

/**
 * Load saved state from localStorage
 */
function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      if (data.layoutId && PRESETS[data.layoutId]) {
        layoutId = data.layoutId;
        panes = data.panes || [];
        focusedPane = data.focusedPane || 0;
      }
    }
  } catch {}
}

/**
 * Save state to localStorage
 */
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ layoutId, panes, focusedPane }));
}

/**
 * Get the #terminals container
 */
function getTerminalsEl() {
  return document.getElementById('terminals');
}

/**
 * Remove all pane wrapper elements and restore default CSS on #terminals
 */
function teardownGrid() {
  const terminalsEl = getTerminalsEl();

  // Move all terminal containers back to #terminals from pane wrappers
  for (const paneEl of paneElements) {
    while (paneEl.firstChild) {
      const child = paneEl.firstChild;
      // Skip empty-state placeholders
      if (child.classList?.contains('split-pane-empty')) {
        paneEl.removeChild(child);
      } else {
        terminalsEl.appendChild(child);
      }
    }
    paneEl.remove();
  }
  paneElements = [];

  // Remove grid classes
  terminalsEl.classList.remove('split-layout');
  for (const preset of Object.values(PRESETS)) {
    if (preset.grid) terminalsEl.classList.remove(preset.grid);
  }

  // Hide all terminal containers except the active one (handled by switchTo)
  for (const container of terminalsEl.querySelectorAll('.terminal-container')) {
    container.classList.remove('active');
  }
}

/**
 * Create pane wrapper elements and set up CSS grid
 */
function setupGrid(preset) {
  const terminalsEl = getTerminalsEl();

  // Hide all terminal containers first
  for (const container of terminalsEl.querySelectorAll('.terminal-container')) {
    container.classList.remove('active');
  }

  // Add grid classes
  terminalsEl.classList.add('split-layout');
  terminalsEl.classList.add(preset.grid);

  // Create pane wrappers
  paneElements = [];
  for (let i = 0; i < preset.panes; i++) {
    const paneEl = document.createElement('div');
    paneEl.className = 'split-pane';
    paneEl.dataset.paneIndex = i;

    // Spanning for asymmetric layouts
    if (layoutId === '1-2' && i === 0) {
      paneEl.style.gridRow = 'span 2';
    } else if (layoutId === '2-1' && i === 2) {
      paneEl.style.gridRow = 'span 2';
    }

    // Focus on click
    paneEl.addEventListener('mousedown', () => {
      _focusPane(i);
    });

    // Empty placeholder
    const placeholder = document.createElement('div');
    placeholder.className = 'split-pane-empty';
    placeholder.textContent = 'Empty pane';
    paneEl.appendChild(placeholder);

    terminalsEl.appendChild(paneEl);
    paneElements.push(paneEl);
  }
}

/**
 * Place a terminal container into a pane, removing the empty placeholder
 */
function placeInPane(container, paneIndex) {
  const paneEl = paneElements[paneIndex];
  if (!paneEl) return;

  // Remove existing placeholder or current occupant
  const existing = paneEl.querySelector('.terminal-container');
  if (existing) {
    // Move it back to #terminals (hidden)
    getTerminalsEl().appendChild(existing);
    existing.classList.remove('active');
  }

  // Remove empty placeholder if present
  const placeholder = paneEl.querySelector('.split-pane-empty');
  if (placeholder) placeholder.remove();

  // Place container in pane
  paneEl.appendChild(container);
  container.classList.add('active');
}

/**
 * Restore empty placeholder to a pane
 */
function emptyPane(paneIndex) {
  const paneEl = paneElements[paneIndex];
  if (!paneEl) return;

  // Move any terminal container back
  const existing = paneEl.querySelector('.terminal-container');
  if (existing) {
    getTerminalsEl().appendChild(existing);
    existing.classList.remove('active');
  }

  // Remove old placeholder if any
  const oldPlaceholder = paneEl.querySelector('.split-pane-empty');
  if (oldPlaceholder) oldPlaceholder.remove();

  // Add fresh placeholder
  const placeholder = document.createElement('div');
  placeholder.className = 'split-pane-empty';
  placeholder.textContent = 'Empty pane';
  paneEl.appendChild(placeholder);
}

/**
 * Focus a specific pane (visual highlight + terminal focus)
 */
function _focusPane(index) {
  if (index < 0 || index >= paneElements.length) return;

  // Update visual focus
  for (const el of paneElements) {
    el.classList.remove('focused');
  }
  paneElements[index].classList.add('focused');
  focusedPane = index;

  // Focus the terminal in this pane
  const sessionId = panes[index]?.sessionId;
  if (sessionId && callbacks.focusTerminal) {
    callbacks.focusTerminal(sessionId);
  }

  // Notify parent of active session change
  if (sessionId && callbacks.onActiveChanged) {
    callbacks.onActiveChanged(sessionId);
  }

  saveState();
  notifyLayoutChanged();
}

/**
 * Notify listeners of layout state change
 */
function notifyLayoutChanged() {
  if (callbacks.onLayoutChanged) {
    callbacks.onLayoutChanged(getState());
  }
}

/**
 * Initialize the split layout engine
 */
function init(cbs) {
  callbacks = cbs;
  loadState();

  // Don't apply non-single layout on init — wait for reconcile() after sessions load
  if (layoutId === 'single') return;
}

/**
 * Reconcile saved state with currently available sessions.
 * Called after session restore completes.
 */
function reconcile(availableSessionIds) {
  const available = new Set(availableSessionIds);

  // Null out panes with sessions that no longer exist
  for (let i = 0; i < panes.length; i++) {
    if (panes[i]?.sessionId && !available.has(panes[i].sessionId)) {
      panes[i] = { sessionId: null };
    }
  }

  // If saved layout is non-single, apply it now
  if (layoutId !== 'single' && PRESETS[layoutId]) {
    _applyLayoutInternal(layoutId, false);
  }

  saveState();
}

/**
 * Apply a layout preset
 */
function applyLayout(newLayoutId) {
  _applyLayoutInternal(newLayoutId, true);
}

function _applyLayoutInternal(newLayoutId, autoFill) {
  const preset = PRESETS[newLayoutId];
  if (!preset) return;

  // Tear down current grid
  if (layoutId !== 'single') {
    teardownGrid();
  }

  layoutId = newLayoutId;

  if (newLayoutId === 'single') {
    // Revert to single mode
    panes = [{ sessionId: null }];
    focusedPane = 0;
    paneElements = [];
    saveState();
    notifyLayoutChanged();

    // Let the parent handle showing the active terminal
    if (callbacks.onRevertToSingle) {
      callbacks.onRevertToSingle();
    }
    return;
  }

  // Ensure panes array matches preset size
  while (panes.length < preset.panes) {
    panes.push({ sessionId: null });
  }
  panes.length = preset.panes;

  // Clamp focused pane
  if (focusedPane >= preset.panes) focusedPane = 0;

  // Set up CSS grid
  setupGrid(preset);

  // Auto-fill panes with sessions if requested
  if (autoFill) {
    autoFillPanes();
  }

  // Place sessions into their panes
  for (let i = 0; i < panes.length; i++) {
    const sid = panes[i]?.sessionId;
    if (sid) {
      const container = callbacks.getContainer?.(sid);
      if (container) {
        placeInPane(container, i);
      } else {
        // Session doesn't exist anymore
        panes[i] = { sessionId: null };
      }
    }
  }

  // Apply focus
  paneElements[focusedPane]?.classList.add('focused');

  // Focus the terminal in the focused pane
  const focusedSessionId = panes[focusedPane]?.sessionId;
  if (focusedSessionId && callbacks.focusTerminal) {
    callbacks.focusTerminal(focusedSessionId);
  }
  if (focusedSessionId && callbacks.onActiveChanged) {
    callbacks.onActiveChanged(focusedSessionId);
  }

  saveState();
  notifyLayoutChanged();
}

/**
 * Auto-fill panes with available sessions in tab order
 */
function autoFillPanes() {
  const sessions = callbacks.getSessions?.() || [];
  if (sessions.length === 0) return;

  // Already-assigned session IDs
  const assigned = new Set(panes.filter(p => p?.sessionId).map(p => p.sessionId));

  // Find unassigned sessions
  const unassigned = sessions.filter(s => !assigned.has(s.id));

  // Fill empty panes
  for (let i = 0; i < panes.length; i++) {
    if (!panes[i]?.sessionId && unassigned.length > 0) {
      panes[i] = { sessionId: unassigned.shift().id };
    }
  }
}

/**
 * Assign a session to a specific pane
 */
function assignSessionToPane(sessionId, paneIndex) {
  if (paneIndex < 0 || paneIndex >= panes.length) return;
  if (!isActive()) return;

  // If session is already in another pane, clear that pane
  for (let i = 0; i < panes.length; i++) {
    if (panes[i]?.sessionId === sessionId && i !== paneIndex) {
      panes[i] = { sessionId: null };
      emptyPane(i);
    }
  }

  // If target pane has a session, move it back
  const oldSessionId = panes[paneIndex]?.sessionId;
  if (oldSessionId) {
    // The placeInPane call below will move the old container back to #terminals
  }

  panes[paneIndex] = { sessionId };

  const container = callbacks.getContainer?.(sessionId);
  if (container) {
    placeInPane(container, paneIndex);
  }

  saveState();
  notifyLayoutChanged();
}

/**
 * Remove a session from its pane (e.g., when session is killed)
 */
function removeSession(sessionId) {
  for (let i = 0; i < panes.length; i++) {
    if (panes[i]?.sessionId === sessionId) {
      panes[i] = { sessionId: null };
      if (paneElements[i]) {
        emptyPane(i);
      }
    }
  }
  saveState();
  notifyLayoutChanged();
}

/**
 * Find which pane (if any) a session is in
 */
function findPane(sessionId) {
  for (let i = 0; i < panes.length; i++) {
    if (panes[i]?.sessionId === sessionId) return i;
  }
  return -1;
}

/**
 * Handle a new session being created while split is active.
 * Assigns it to the first empty pane if available.
 */
function onSessionCreated(sessionId) {
  if (!isActive()) return;

  for (let i = 0; i < panes.length; i++) {
    if (!panes[i]?.sessionId) {
      assignSessionToPane(sessionId, i);
      return;
    }
  }
  // No empty pane — session stays hidden
}

/**
 * Get current state (for bridge API and persistence)
 */
function getState() {
  return {
    layoutId,
    panes: panes.map(p => ({ sessionId: p?.sessionId || null })),
    focusedPane,
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, panes: p.panes })),
  };
}

/**
 * Whether a non-single split layout is active
 */
function isActive() {
  return layoutId !== 'single' && paneElements.length > 0;
}

export const SplitLayout = {
  init,
  reconcile,
  applyLayout,
  assignSessionToPane,
  removeSession,
  focusPane: _focusPane,
  findPane,
  onSessionCreated,
  getState,
  isActive,
  getPresets: () => PRESETS,
};
