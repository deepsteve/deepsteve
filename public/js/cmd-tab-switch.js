/**
 * Command+N hold-to-activate tab switching.
 *
 * Hold Command for ~1 second to enter "tab switching mode," then press
 * 1-9 to jump to a tab, or , / . to go previous/next (wrapping).
 *
 * Uses capture-phase document listeners so keys are intercepted before
 * xterm.js sees them — no changes to terminal.js needed.
 */

let enabled = false;
let holdTimer = null;
let tabSwitchModeActive = false;

let getOrderedTabIds;
let getActiveTabId;
let switchToTab;

const HOLD_MS = 1000;

const TAB_KEYS = new Set([
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Comma', 'Period'
]);

function resetState() {
  clearTimeout(holdTimer);
  holdTimer = null;
  tabSwitchModeActive = false;
}

function onKeyDown(e) {
  if (!enabled) return;

  // Meta key pressed — start hold timer
  if (e.key === 'Meta' && !e.repeat) {
    resetState();
    holdTimer = setTimeout(() => {
      tabSwitchModeActive = true;
    }, HOLD_MS);
    return;
  }

  // Non-modifier key while Meta is held
  if (e.metaKey) {
    if (!tabSwitchModeActive) {
      // Still within hold period — normal Cmd shortcut, cancel timer
      resetState();
      return;
    }

    // Tab switch mode is active — check for tab-switch keys
    if (TAB_KEYS.has(e.code)) {
      e.preventDefault();
      e.stopPropagation();

      const tabIds = getOrderedTabIds();
      if (tabIds.length === 0) return;

      if (e.code.startsWith('Digit')) {
        // 1-9 → jump to tab N (1-indexed)
        const index = parseInt(e.code.slice(5), 10) - 1;
        if (index < tabIds.length) {
          switchToTab(tabIds[index]);
        }
      } else if (e.code === 'Comma') {
        // Previous tab (wrapping)
        const activeId = getActiveTabId();
        const idx = tabIds.indexOf(activeId);
        const prev = idx <= 0 ? tabIds.length - 1 : idx - 1;
        switchToTab(tabIds[prev]);
      } else if (e.code === 'Period') {
        // Next tab (wrapping)
        const activeId = getActiveTabId();
        const idx = tabIds.indexOf(activeId);
        const next = idx >= tabIds.length - 1 ? 0 : idx + 1;
        switchToTab(tabIds[next]);
      }
    }
  }
}

function onKeyUp(e) {
  if (!enabled) return;
  if (e.key === 'Meta') resetState();
}

function onBlur() {
  resetState();
}

export function init({ getOrderedTabIds: g, getActiveTabId: a, switchToTab: s }) {
  getOrderedTabIds = g;
  getActiveTabId = a;
  switchToTab = s;

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
}

export function setEnabled(val) {
  enabled = !!val;
  if (!enabled) resetState();
}
