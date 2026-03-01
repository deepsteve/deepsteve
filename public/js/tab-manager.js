/**
 * Tab UI management for terminal tabs
 */

// Long-press drag reorder state
const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD = 5;
let dragState = null;
let suppressNextClick = false;

let contextMenu = null;

function buildWindowLabel(win) {
  const names = win.sessions.map(s => s.name).filter(Boolean);
  if (names.length === 0) return win.windowId;
  if (names.length <= 3) return names.join(', ');
  return names.slice(0, 3).join(', ') + ` +${names.length - 3}`;
}

function showContextMenu(x, y, sessionId, callbacks) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'tab-context-menu';

  // Rename item
  const renameEl = document.createElement('div');
  renameEl.className = 'context-menu-item';
  renameEl.textContent = 'Rename';
  renameEl.onclick = () => {
    hideContextMenu();
    callbacks.onRename?.(sessionId);
  };
  menu.appendChild(renameEl);

  // Send to Window item with submenu
  const liveWindows = callbacks.getLiveWindows ? callbacks.getLiveWindows() : [];
  const sendEl = document.createElement('div');
  sendEl.className = 'context-menu-item';

  if (liveWindows.length === 0) {
    sendEl.classList.add('disabled');
    sendEl.textContent = 'Send to Window';
  } else {
    sendEl.classList.add('context-menu-has-submenu');
    sendEl.innerHTML = 'Send to Window <span class="context-menu-arrow"></span>';

    // Build submenu on mouseenter
    let submenu = null;
    sendEl.addEventListener('mouseenter', () => {
      if (submenu) return;
      submenu = document.createElement('div');
      submenu.className = 'context-menu context-submenu';

      for (const win of liveWindows) {
        const winEl = document.createElement('div');
        winEl.className = 'context-menu-item';
        winEl.textContent = buildWindowLabel(win);
        winEl.onclick = () => {
          hideContextMenu();
          callbacks.onSendToWindow?.(sessionId, win.windowId);
        };
        submenu.appendChild(winEl);
      }

      sendEl.appendChild(submenu);

      // Flip left if off-screen right
      const subRect = submenu.getBoundingClientRect();
      if (subRect.right > window.innerWidth) {
        submenu.style.left = 'auto';
        submenu.style.right = '100%';
        submenu.style.marginLeft = '0';
        submenu.style.marginRight = '2px';
      }
    });

    sendEl.addEventListener('mouseleave', () => {
      if (submenu) {
        submenu.remove();
        submenu = null;
      }
    });
  }
  menu.appendChild(sendEl);

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

function startDrag(tabEl, sessionId, callbacks) {
  dragState = { tabEl, sessionId, callbacks };
  tabEl.classList.add('dragging');
  const list = document.getElementById('tabs-list');
  list.classList.add('tab-drag-active');
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchend', endDrag);
  document.addEventListener('visibilitychange', endDrag);
}

function onDragMove(e) {
  if (!dragState) return;
  e.preventDefault();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  handleDragMove(clientX, clientY);
}

function handleDragMove(clientX, clientY) {
  if (!dragState) return;
  const list = document.getElementById('tabs-list');
  const vertical = isVertical();
  const tabs = [...list.children];

  for (const tab of tabs) {
    if (tab === dragState.tabEl) continue;
    const rect = tab.getBoundingClientRect();
    const mid = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    const pos = vertical ? clientY : clientX;

    if (pos < mid) {
      list.insertBefore(dragState.tabEl, tab);
      return;
    }
  }
  // Past all tabs — move to end
  list.appendChild(dragState.tabEl);
}

function endDrag() {
  if (!dragState) return;
  const { tabEl, callbacks } = dragState;

  tabEl.classList.remove('dragging');
  const list = document.getElementById('tabs-list');
  list.classList.remove('tab-drag-active');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';

  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('touchmove', onDragMove);
  document.removeEventListener('mouseup', endDrag);
  document.removeEventListener('touchend', endDrag);
  document.removeEventListener('visibilitychange', endDrag);

  if (tabEl.parentNode) {
    const orderedIds = [...list.children].map(t => t.id.replace('tab-', ''));
    callbacks.onReorder?.(orderedIds);
  }

  suppressNextClick = true;
  setTimeout(() => { suppressNextClick = false; }, 0);
  dragState = null;
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
      if (suppressNextClick) return;
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

    // Long-press to drag reorder
    const onPointerDown = (e) => {
      // Ignore close button, right-click
      if (e.target.closest('.close')) return;
      if (e.button && e.button !== 0) return;

      const startX = e.touches ? e.touches[0].clientX : e.clientX;
      const startY = e.touches ? e.touches[0].clientY : e.clientY;
      let moved = false;

      const onMove = (me) => {
        const cx = me.touches ? me.touches[0].clientX : me.clientX;
        const cy = me.touches ? me.touches[0].clientY : me.clientY;
        if (Math.abs(cx - startX) > MOVE_THRESHOLD || Math.abs(cy - startY) > MOVE_THRESHOLD) {
          moved = true;
          cancel();
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        startDrag(tab, sessionId, callbacks);
      }, LONG_PRESS_MS);

      const cancel = () => {
        clearTimeout(timer);
        cleanup();
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', cancel);
        document.removeEventListener('touchend', cancel);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('mouseup', cancel);
      document.addEventListener('touchend', cancel);
    };

    tab.addEventListener('mousedown', onPointerDown);
    tab.addEventListener('touchstart', onPointerDown, { passive: true });

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
