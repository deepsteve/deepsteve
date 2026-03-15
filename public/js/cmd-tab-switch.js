/**
 * Command hold mode — tab switching and management.
 *
 * Hold Command for ~1 second to enter "hold mode," then press:
 *   1-9    jump to tab N
 *   , / .  previous / next tab (wrapping)
 *
 * Uses capture-phase document listeners so keys are intercepted before
 * xterm.js sees them — no changes to terminal.js needed.
 */

let enabled = false;
let holdTimer = null;
let tabSwitchModeActive = false;
let metaHeldOnBlur = false;

let getOrderedTabIds;
let getActiveTabId;
let switchToTab;

let HOLD_MS = 1000;

const TAB_KEYS = new Set([
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Comma', 'Period'
]);

function setTabSwitchMode(active) {
  tabSwitchModeActive = active;
  document.getElementById('tabs')?.classList.toggle('tab-switch-mode', active);
}

function resetState() {
  if (holdTimer || tabSwitchModeActive) {
    console.log('[cmd-tab-switch] resetState()', { hadTimer: !!holdTimer, wasActive: tabSwitchModeActive });
  }
  clearTimeout(holdTimer);
  holdTimer = null;
  setTabSwitchMode(false);
}

function onKeyDown(e) {
  if (!enabled) {
    if (e.metaKey && TAB_KEYS.has(e.code)) {
      console.log('[cmd-tab-switch] keydown blocked: enabled=false', { key: e.key, code: e.code });
    }
    return;
  }

  // Meta key pressed — start hold timer (or activate immediately if returning from blur)
  if (e.key === 'Meta' && !e.repeat) {
    if (metaHeldOnBlur) {
      // Cmd was held when we left the window — activate immediately
      metaHeldOnBlur = false;
      setTabSwitchMode(true);
      console.log('[cmd-tab-switch] Meta still held after refocus — tab switch mode ACTIVE');
      return;
    }
    console.log('[cmd-tab-switch] Meta pressed, starting hold timer (' + HOLD_MS + 'ms)');
    resetState();
    holdTimer = setTimeout(() => {
      setTabSwitchMode(true);
      console.log('[cmd-tab-switch] Hold timer fired — tab switch mode ACTIVE');
    }, HOLD_MS);
    return;
  }

  // Non-Meta key clears the blur flag
  metaHeldOnBlur = false;

  // Non-modifier key while Meta is held
  if (e.metaKey) {
    console.log('[cmd-tab-switch] key while Meta held:', { code: e.code, tabSwitchModeActive, inTabKeys: TAB_KEYS.has(e.code) });
    if (!tabSwitchModeActive) {
      // Still within hold period — normal Cmd shortcut, cancel timer
      console.log('[cmd-tab-switch] Not in tab switch mode yet — cancelling timer, passing through');
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
  if (e.key === 'Meta') {
    metaHeldOnBlur = false;
    resetState();
  }
}

function onBlur() {
  // Remember if tab-switch mode was active (Meta held) so we can
  // re-activate immediately when the window regains focus.
  metaHeldOnBlur = tabSwitchModeActive || holdTimer !== null;
  clearTimeout(holdTimer);
  holdTimer = null;
  setTabSwitchMode(false);
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
  console.log('[cmd-tab-switch] setEnabled(' + enabled + ')');
  if (!enabled) resetState();
}

export function setHoldMs(ms) {
  HOLD_MS = Math.max(0, ms | 0);
  console.log('[cmd-tab-switch] setHoldMs(' + HOLD_MS + ')');
}
