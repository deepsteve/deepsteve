/**
 * Layout management for horizontal/vertical tab layouts
 */

import { nsKey } from './storage-namespace.js';

const STORAGE_KEY = nsKey('deepsteve-layout');
const DEFAULT_SIDEBAR_WIDTH = 200;

/**
 * The collapsed rail's width, and with it the sidebar's only floor. CSS owns the number
 * (`--ds-rail-width` on `#app-container.vertical-layout`) so themes can retune it and, more to the
 * point, so there is exactly one of it. The old `MIN_SIDEBAR_WIDTH = 140` here had to agree with a
 * `min-width: 140px` in styles.css by hand, and between them the sidebar could never collapse —
 * the JS floor clamped both the drag and the restored value, and the CSS floor caught whatever got
 * through (#552).
 */
function railWidth() {
  const container = document.getElementById('app-container');
  const declared = parseFloat(getComputedStyle(container).getPropertyValue('--ds-rail-width'));
  return Number.isFinite(declared) && declared > 0 ? declared : 48;
}

let currentLayout = 'horizontal';
let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let isDragging = false;

/**
 * Get saved layout preference
 */
function getSavedLayout() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      return {
        layout: data.layout || 'horizontal',
        sidebarWidth: data.sidebarWidth || DEFAULT_SIDEBAR_WIDTH
      };
    }
  } catch (e) {
    // Ignore parse errors
  }
  return { layout: 'horizontal', sidebarWidth: DEFAULT_SIDEBAR_WIDTH };
}

/**
 * Save layout preference
 */
function saveLayout() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    layout: currentLayout,
    sidebarWidth: sidebarWidth
  }));
}

/**
 * Apply the current layout to the DOM
 */
function applyLayout() {
  const container = document.getElementById('app-container');
  const tabs = document.getElementById('tabs');
  const toggleBtn = document.getElementById('layout-toggle');

  if (currentLayout === 'vertical') {
    // vertical-layout first: --ds-rail-width is declared on that class, so railWidth() reads ''
    // until it is on.
    container.classList.add('vertical-layout');
    tabs.style.width = sidebarWidth + 'px';
    container.classList.toggle('icon-rail', sidebarWidth <= railWidth());
    toggleBtn.textContent = '⬜'; // Icon for vertical mode (click to go horizontal)
    toggleBtn.title = 'Switch to horizontal tabs';
  } else {
    container.classList.remove('vertical-layout');
    container.classList.remove('icon-rail');
    tabs.style.width = '';
    toggleBtn.textContent = '▤'; // Icon for horizontal mode (click to go vertical)
    toggleBtn.title = 'Switch to vertical tabs';
  }
}

/**
 * Toggle between horizontal and vertical layouts
 */
function toggleLayout() {
  currentLayout = currentLayout === 'horizontal' ? 'vertical' : 'horizontal';
  applyLayout();
  saveLayout();

  // Return focus to active terminal so keystrokes don't re-trigger the button
  document.activeElement?.blur();

  // Trigger resize event so terminals refit
  window.dispatchEvent(new Event('resize'));
}

/**
 * Setup drag handling for the resizer
 */
function setupResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const tabs = document.getElementById('tabs');

  resizer.addEventListener('mousedown', (e) => {
    if (currentLayout !== 'vertical') return;

    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    // Width is measured from the tab strip's own left edge, not the viewport, so
    // the full-height context rail sitting to its left doesn't offset the drag.
    let newWidth = e.clientX - tabs.getBoundingClientRect().left;

    // Drag past the point where a label could survive and the sidebar snaps shut to the icon rail,
    // the way Firefox's vertical tabs do. The snap point is derived from the rail rather than being
    // a second tunable — there is one width in play, and CSS declares it.
    const rail = railWidth();
    if (newWidth < rail * 2) {
      newWidth = rail;
    }

    // Max width is 50% of viewport
    const maxWidth = window.innerWidth * 0.5;
    if (newWidth > maxWidth) {
      newWidth = maxWidth;
    }

    sidebarWidth = newWidth;
    tabs.style.width = sidebarWidth + 'px';
    document.getElementById('app-container').classList.toggle('icon-rail', sidebarWidth <= rail);
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveLayout();

      // Trigger resize so terminals refit
      window.dispatchEvent(new Event('resize'));
    }
  });
}

/**
 * Initialize layout manager
 */
export function initLayoutManager() {
  // Load saved preferences
  const saved = getSavedLayout();
  currentLayout = saved.layout;
  // No floor applied to the restored value on purpose. The old `Math.max(saved, 140)` is what made
  // a collapsed sidebar impossible to persist — it silently re-inflated to 140px on every load, so
  // even hand-editing localStorage couldn't stick (#552). Guard the value's *shape*, not its size;
  // CSS min-width holds the real floor.
  sidebarWidth = Number.isFinite(saved.sidebarWidth) && saved.sidebarWidth > 0
    ? saved.sidebarWidth
    : DEFAULT_SIDEBAR_WIDTH;

  // Setup toggle button
  const toggleBtn = document.getElementById('layout-toggle');
  toggleBtn.addEventListener('click', toggleLayout);

  // Setup resizer drag handling
  setupResizer();

  // Apply initial layout
  applyLayout();
}

export const LayoutManager = {
  init: initLayoutManager,
  toggle: toggleLayout,
  getLayout: () => currentLayout
};
