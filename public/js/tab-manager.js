/**
 * Tab UI management for terminal tabs
 */

// Speaker icon shown on a tab while it is emitting audio (inline SVG, inherits currentColor).
const SPEAKER_SVG = '<svg viewBox="0 0 16 16"><path d="M8 2 4 5H1v6h3l4 3V2z" fill="currentColor"/><path d="M11 5a4 4 0 0 1 0 6" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round"/></svg>';

// Drag reorder state
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

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'context-menu-separator';
  menu.appendChild(sep1);

  // Fork tab
  const forkEl = document.createElement('div');
  forkEl.className = 'context-menu-item';
  const sessionType = callbacks.getSessionType?.() || 'terminal';
  if (sessionType !== 'terminal') {
    forkEl.classList.add('disabled');
  }
  forkEl.textContent = 'Fork tab';
  forkEl.onclick = () => {
    if (sessionType !== 'terminal') return;
    hideContextMenu();
    callbacks.onFork?.(sessionId);
  };
  menu.appendChild(forkEl);

  // Close tab
  const closeEl = document.createElement('div');
  closeEl.className = 'context-menu-item';
  closeEl.textContent = 'Close tab';
  closeEl.onclick = () => {
    hideContextMenu();
    callbacks.onClose?.(sessionId);
  };
  menu.appendChild(closeEl);

  // Mod-provided context menu items
  const modItems = callbacks.getModMenuItems ? callbacks.getModMenuItems() : [];
  if (modItems.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'context-menu-separator';
    menu.appendChild(sep);
    for (const item of modItems) {
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.textContent = item.label;
      el.onclick = () => {
        hideContextMenu();
        item.onClick(sessionId);
      };
      menu.appendChild(el);
    }
  }

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
  const list = document.getElementById('tabs-list');
  const rect = tabEl.getBoundingClientRect();

  // Create floating clone that follows the cursor
  const ghost = tabEl.cloneNode(true);
  ghost.className = 'tab tab-drag-ghost';
  ghost.style.position = 'fixed';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.zIndex = '9999';
  ghost.style.pointerEvents = 'none';
  ghost.style.transition = 'none';
  document.body.appendChild(ghost);

  // Offset from cursor to tab origin
  dragState = {
    tabEl, sessionId, callbacks, ghost,
    offsetX: rect.left,
    offsetY: rect.top,
  };

  tabEl.classList.add('dragging');
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

  // Move ghost to follow cursor
  const { ghost } = dragState;
  const vertical = isVertical();
  if (vertical) {
    ghost.style.top = (clientY - ghost.offsetHeight / 2) + 'px';
  } else {
    ghost.style.left = (clientX - ghost.offsetWidth / 2) + 'px';
  }

  // Reorder real tabs based on cursor position
  const list = document.getElementById('tabs-list');
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
  const { tabEl, callbacks, ghost } = dragState;

  ghost.remove();
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

/**
 * The tab's standing identity, shown in the vertical sidebar and the only thing left of a tab
 * once the sidebar collapses to an icon rail. Firefox puts a favicon here; we have no such
 * thing, so derive one from the name: a leading emoji if the name has one (⏰ scheduled runs,
 * 💀/🔓 red-team tabs already lead with one), otherwise a monogram of the first letter or digit.
 *
 * Skipping to the first alphanumeric is what makes issue tabs distinguishable — `#549 Cmd+?`
 * and `#551 Window→session` both start with `#`, so a naive first-character monogram would
 * render every issue tab identically.
 */
export function tabIcon(name) {
  const s = (name || '').trim();
  if (!s) return { glyph: '•', isEmoji: false };

  // First *grapheme*, not first code point. 👨‍👩‍👧 is three pictographs joined by ZWJ and 🇺🇸 is two
  // regional indicators; taking codepoint[0] renders a different emoji than the tab shows.
  const [first] = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)];
  const g = first?.segment ?? '';
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)) return { glyph: g, isEmoji: true };

  // Issue tabs are the bulk of a real sidebar and they defeat a first-letter monogram: `#549`,
  // `#551`, `#536` and `#540` all reduce to `5`, so the rail would show one identical chip per
  // issue. The number is the identity, and its tail is what varies — `49`, `51`, `36`, `40`.
  const issue = s.match(/^#(\d+)/);
  if (issue) return { glyph: issue[1].slice(-2), isEmoji: false };

  const alnum = s.match(/\p{Letter}|\p{Number}/u);
  return { glyph: alnum ? alnum[0].toUpperCase() : '•', isEmoji: false };
}

/** Apply a tab's derived icon to its `.tab-icon` span (glyph + the emoji/monogram styling hook). */
function paintTabIcon(tabEl, name) {
  const el = tabEl.querySelector('.tab-icon');
  if (!el) return;
  const { glyph, isEmoji } = tabIcon(name);
  el.textContent = glyph;
  el.classList.toggle('is-emoji', isEmoji);
}

/** Inline markup for a fresh tab's icon, matching what paintTabIcon() would produce. */
function tabIconHTML(name) {
  const { glyph, isEmoji } = tabIcon(name);
  return `<span class="tab-icon${isEmoji ? ' is-emoji' : ''}" aria-hidden="true">${glyph}</span>`;
}

export const TabManager = {
  /**
   * Create a tab element for a session
   */
  createTab(sessionId, name, callbacks) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = 'tab-' + sessionId;
    tab.title = name;
    tab.innerHTML = `
      <span class="badge"></span>
      ${tabIconHTML(name)}
      <span class="speaker-icon" aria-hidden="true" title="Emitting audio">${SPEAKER_SVG}</span>
      <span class="tab-label">${name}</span>
      <span class="close">&#10005;</span>
    `;

    this._wireTabEvents(tab, sessionId, callbacks);
    return tab;
  },

  /**
   * Wire up event handlers (close, context menu, drag-to-reorder) on a tab element.
   * Used by both createTab() and addTab() (placeholder upgrade path).
   */
  _wireTabEvents(tab, sessionId, callbacks) {
    tab.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onClose?.(sessionId);
    });

    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, sessionId, callbacks);
    });

    // Drag to reorder — starts on move past threshold, click if no drag
    const onPointerDown = (e) => {
      // Ignore close button, right-click
      if (e.target.closest('.close')) return;
      if (e.button && e.button !== 0) return;

      const startX = e.touches ? e.touches[0].clientX : e.clientX;
      const startY = e.touches ? e.touches[0].clientY : e.clientY;
      let dragging = false;

      const onMove = (me) => {
        const cx = me.touches ? me.touches[0].clientX : me.clientX;
        const cy = me.touches ? me.touches[0].clientY : me.clientY;
        if (!dragging) {
          if (Math.abs(cx - startX) > MOVE_THRESHOLD || Math.abs(cy - startY) > MOVE_THRESHOLD) {
            dragging = true;
            startDrag(tab, sessionId, callbacks);
          }
        }
        // Once dragging, onDragMove handles the rest via its own listener
      };

      const onUp = () => {
        cleanup();
        if (!dragging) {
          // No drag happened — treat as click to switch
          callbacks.onSwitch?.(sessionId);
        }
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
    };

    tab.addEventListener('mousedown', onPointerDown);
    tab.addEventListener('touchstart', onPointerDown, { passive: true });
  },

  /**
   * Add a placeholder tab stub for instant visual feedback during restore.
   * Upgraded to a full tab when addTab() is called with the same sessionId.
   */
  addPlaceholderTab(sessionId, name) {
    const tab = document.createElement('div');
    tab.className = 'tab placeholder';
    tab.id = 'tab-' + sessionId;
    tab.innerHTML = `
      <span class="badge"></span>
      ${tabIconHTML(name)}
      <span class="speaker-icon" aria-hidden="true" title="Emitting audio">${SPEAKER_SVG}</span>
      <span class="tab-label">${name}</span>
      <span class="close">&#10005;</span>
    `;
    document.getElementById('tabs-list').appendChild(tab);
    updateTabArrows();
    return tab;
  },

  /**
   * Add a tab to the tab bar. If a placeholder already exists for this
   * sessionId, upgrade it in-place instead of appending a new element.
   */
  addTab(sessionId, name, callbacks) {
    const existing = document.getElementById('tab-' + sessionId);
    if (existing && existing.classList.contains('placeholder')) {
      existing.classList.remove('placeholder');
      existing.querySelector('.tab-label').textContent = name;
      paintTabIcon(existing, name);
      this._wireTabEvents(existing, sessionId, callbacks);
      existing.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateTabArrows();
      return existing;
    }
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
      // Collapsed, this glyph is the whole tab — a rename that left it stale would be invisible
      // in the sidebar but wrong in the rail.
      paintTabIcon(tab, name);
      tab.title = name;
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
   * Show/hide the speaker icon on a tab (driven by display-tab audio detection).
   */
  updateSpeakerIcon(sessionId, active) {
    const el = document.querySelector('#tab-' + sessionId + ' .speaker-icon');
    if (el) el.classList.toggle('active', !!active);
  },

  /**
   * Mark a tab's connection as down/recovering (#556): its badge slot becomes
   * a pulsing dot. Lives on the tab element so it shows for background tabs
   * (the terminal container is display:none) and placeholder tabs (no session
   * exists yet) — the two cases the container overlay structurally can't cover.
   */
  updateReconnecting(sessionId, on) {
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) tab.classList.toggle('reconnecting', !!on);
  },

  /**
   * Get the adjacent tab's session ID (left neighbor preferred, then right).
   * Returns null if no adjacent tab exists.
   */
  getAdjacentTabId(sessionId) {
    const tab = document.getElementById('tab-' + sessionId);
    if (!tab) return null;
    const left = tab.previousElementSibling;
    if (left && left.classList.contains('tab')) return left.id.replace('tab-', '');
    const right = tab.nextElementSibling;
    if (right && right.classList.contains('tab')) return right.id.replace('tab-', '');
    return null;
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
