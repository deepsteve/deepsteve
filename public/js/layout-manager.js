/**
 * Layout management for horizontal/vertical tab layouts
 */

const STORAGE_KEY = 'deepsteve-layout';
const MIN_SIDEBAR_WIDTH = 60;
const DEFAULT_SIDEBAR_WIDTH = 200;

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
    container.classList.add('vertical-layout');
    tabs.style.width = sidebarWidth + 'px';
    toggleBtn.textContent = '⬜'; // Icon for vertical mode (click to go horizontal)
    toggleBtn.title = 'Switch to horizontal tabs';
  } else {
    container.classList.remove('vertical-layout');
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

    let newWidth = e.clientX;

    // Enforce minimum width
    if (newWidth < MIN_SIDEBAR_WIDTH) {
      newWidth = MIN_SIDEBAR_WIDTH;
    }

    // Max width is 50% of viewport
    const maxWidth = window.innerWidth * 0.5;
    if (newWidth > maxWidth) {
      newWidth = maxWidth;
    }

    sidebarWidth = newWidth;
    tabs.style.width = sidebarWidth + 'px';
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
  sidebarWidth = saved.sidebarWidth;

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
