/**
 * Tab UI management for terminal tabs
 */

import { SessionStore } from './session-store.js';
import { WindowManager } from './window-manager.js';

// Tab context menu configuration
const contextMenuItems = [
  { label: 'Rename', action: (id, callbacks) => callbacks.onRename?.(id) }
];

let contextMenu = null;

function showContextMenu(x, y, sessionId, callbacks) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'tab-context-menu';

  contextMenuItems.forEach(item => {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.textContent = item.label;
    el.onclick = () => {
      hideContextMenu();
      item.action(sessionId, callbacks);
    };
    menu.appendChild(el);
  });

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  }

  contextMenu = menu;
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
  document.getElementById('tab-context-menu')?.remove();
}

// Hide context menu on click outside
document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tab')) hideContextMenu();
});

// Tab scroll arrow state
let arrowStart = null;
let arrowEnd = null;
let arrowsContainer = null;
let tabsList = null;

function isVertical() {
  return document.getElementById('app-container')?.classList.contains('vertical-layout');
}

function updateTabArrows() {
  if (!tabsList || !arrowStart || !arrowEnd || !arrowsContainer) return;

  const vertical = isVertical();
  const scrollPos = vertical ? tabsList.scrollTop : tabsList.scrollLeft;
  const scrollSize = vertical ? tabsList.scrollHeight : tabsList.scrollWidth;
  const clientSize = vertical ? tabsList.clientHeight : tabsList.clientWidth;

  const hasOverflow = scrollSize > clientSize + 1; // 1px tolerance
  const atStart = scrollPos <= 1;
  const atEnd = scrollPos + clientSize >= scrollSize - 1;

  arrowsContainer.classList.toggle('visible', hasOverflow);
  arrowStart.classList.toggle('disabled', atStart);
  arrowEnd.classList.toggle('disabled', atEnd);
}

export function initTabArrows() {
  arrowStart = document.getElementById('tabs-arrow-start');
  arrowEnd = document.getElementById('tabs-arrow-end');
  arrowsContainer = document.getElementById('tabs-arrows');
  tabsList = document.getElementById('tabs-list');
  if (!arrowStart || !arrowEnd || !arrowsContainer || !tabsList) return;

  arrowStart.addEventListener('click', () => {
    if (arrowStart.classList.contains('disabled')) return;
    const amount = isVertical() ? { top: -150 } : { left: -150 };
    tabsList.scrollBy({ ...amount, behavior: 'smooth' });
  });

  arrowEnd.addEventListener('click', () => {
    if (arrowEnd.classList.contains('disabled')) return;
    const amount = isVertical() ? { top: 150 } : { left: 150 };
    tabsList.scrollBy({ ...amount, behavior: 'smooth' });
  });

  tabsList.addEventListener('scroll', updateTabArrows);
  window.addEventListener('resize', updateTabArrows);

  updateTabArrows();
}

export function getDefaultTabName(cwd) {
  if (!cwd) return 'shell';
  return cwd.split('/').filter(Boolean).pop() || 'root';
}

export const TabManager = {
  /**
   * Create a tab element for a session
   */
  createTab(sessionId, name, callbacks) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = 'tab-' + sessionId;
    tab.innerHTML = `
      <span class="badge"></span>
      <span class="tab-label">${name}</span>
      <span class="close">&#10005;</span>
    `;

    tab.querySelector('.tab-label').addEventListener('click', () => {
      callbacks.onSwitch?.(sessionId);
    });

    tab.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onClose?.(sessionId);
    });

    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, sessionId, callbacks);
    });

    return tab;
  },

  /**
   * Add a tab to the tab bar
   */
  addTab(sessionId, name, callbacks) {
    const tab = this.createTab(sessionId, name, callbacks);
    document.getElementById('tabs-list').appendChild(tab);
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateTabArrows();
    return tab;
  },

  /**
   * Remove a tab from the tab bar
   */
  removeTab(sessionId) {
    document.getElementById('tab-' + sessionId)?.remove();
    updateTabArrows();
  },

  /**
   * Update tab label
   */
  updateLabel(sessionId, name) {
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) {
      tab.querySelector('.tab-label').textContent = name;
    }
  },

  /**
   * Set active tab
   */
  setActive(sessionId) {
    // Remove active from all tabs
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    // Add active to specified tab
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) {
      tab.classList.add('active');
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  },

  /**
   * Get tab element
   */
  getTab(sessionId) {
    return document.getElementById('tab-' + sessionId);
  },

  /**
   * Update badge visibility on a tab
   */
  updateBadge(sessionId, visible) {
    const badge = document.querySelector('#tab-' + sessionId + ' .badge');
    if (badge) badge.classList.toggle('visible', visible);
  },

  /**
   * Prompt user to rename a tab
   */
  promptRename(sessionId, currentName, callback) {
    const newName = prompt('Rename tab:', currentName || '');
    if (newName !== null) {
      callback(newName.trim());
    }
  }
};
