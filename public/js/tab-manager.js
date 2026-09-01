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

  // Autopilot (#643) — a per-session server-side value: with it on, the session
  // merges itself once it reports the work done, instead of leaving a finished
  // worktree tab for a human to close out. `null` means "not applicable to this
  // tab" (no worktree, or not a PTY session at all), and the item is omitted
  // rather than disabled — there is nothing the user could do to make it apply.
  const autopilot = callbacks.getAutopilot ? callbacks.getAutopilot() : null;
  if (autopilot !== null && autopilot !== undefined) {
    const autoEl = document.createElement('div');
    autoEl.className = 'context-menu-item';
    // Same tick convention as the agent submenu: the unchecked state keeps the
    // label's indent so the two states don't jitter.
    autoEl.innerHTML = `${autopilot ? '&#10003; ' : '&nbsp;&nbsp; '}Autopilot`;
    autoEl.onclick = () => {
      hideContextMenu();
      callbacks.onToggleAutopilot?.(sessionId, !autopilot);
    };
    menu.appendChild(autoEl);
  }

  // Merge (#688) — merging a finished worktree is mechanical, and the person doing it
  // is not asking the AGENT for anything; they are asking deepsteve. Before this the
  // only route was to type `/deepsteve:merge` at the session, which put a model (and
  // about ten replays of its context) in the middle of a job the daemon can do alone.
  // Omitted rather than disabled off a worktree, the Autopilot rule: there is nothing
  // the user could do to this tab to make it apply.
  const worktree = callbacks.getWorktree ? callbacks.getWorktree() : null;
  if (worktree) {
    const mergeEl = document.createElement('div');
    mergeEl.className = 'context-menu-item';
    // The ellipsis is a promise the Autopilot item above deliberately does not make:
    // this one asks before it does anything.
    mergeEl.innerHTML = '&nbsp;&nbsp; Merge…';
    mergeEl.onclick = () => {
      hideContextMenu();
      callbacks.onMerge?.(sessionId);
    };
    menu.appendChild(mergeEl);
  }

  if ((autopilot !== null && autopilot !== undefined) || worktree) {
    const sepAuto = document.createElement('div');
    sepAuto.className = 'context-menu-separator';
    menu.appendChild(sepAuto);
  }

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

  // History (#672) — the keyboard/right-click route to the same pane the tab's
  // ⧗ opens. Disabled, not omitted, on a tab that has no transcript: unlike
  // Autopilot (which is absent when it cannot apply), "this agent keeps no
  // history" is worth saying once rather than leaving the reader to wonder.
  const historyEl = document.createElement('div');
  historyEl.className = 'context-menu-item';
  const hasHistory = document.getElementById('tab-' + sessionId)?.classList.contains('has-history');
  if (!hasHistory) historyEl.classList.add('disabled');
  historyEl.textContent = 'History…';
  historyEl.onclick = () => {
    if (!hasHistory) return;
    hideContextMenu();
    callbacks.onHistory?.(sessionId);
  };
  menu.appendChild(historyEl);

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

// ── Tab nav arrows ───────────────────────────────────────────────────────────────────────────
// ▲/▼ (‹/› horizontal) move to the previous / next tab. They are DERIVED from the active tab's
// index in the strip, never from scroll geometry: #75 shipped them as scroll controls
// (scrollBy ±150px, disabled when scrollTop hit the ends), and in the vertical sidebar a ~33px
// tab means the whole list's overflow is often under one 150px step — so a single ▼ press
// reached the true scroll bottom and disabled itself while tabs below the active one were
// plainly on screen (#610). Index math has no such failure mode, and it removes every layout
// read from this module: there is nothing left to go stale after a reflow.
let arrowStart = null;
let arrowEnd = null;
let arrowsContainer = null;
let getOrderedTabIds = () => [];
let getActiveTabId = () => null;
let switchToTab = () => {};

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

// Where we are in the strip. The ids are the context-filter-aware ordered list (app.js's
// getVisibleTabIds), so navigation stays inside the active context — same source the Cmd-hold
// switcher uses. Single helper because updateTabArrows() and the click handlers MUST agree:
// an enabled ▼ that computes a different neighbour than the one it was enabled for is the bug
// this replaced, in a new costume.
function arrowNavState() {
  const ids = getOrderedTabIds() || [];
  return { ids, i: ids.indexOf(getActiveTabId()) };
}

// `disabled` is set on the element AND as a class. The class is the styling hook every theme
// already keys off (:hover:not(.disabled) in styles.css, win-95.css, ascii-art.css); the
// property is what makes "unclickable" true rather than cosmetic — .disabled is only
// opacity:0.3 with no pointer-events, so before this the button stayed in the tab order and
// merely no-op'd on click.
function setArrowDisabled(el, disabled) {
  el.disabled = disabled;
  el.classList.toggle('disabled', disabled);
}

function updateTabArrows() {
  if (!arrowStart || !arrowEnd || !arrowsContainer) return;

  const { ids, i } = arrowNavState();

  // Shown whenever there is somewhere to navigate. Deliberately not the old overflow gate:
  // these are no longer scroll controls, so hiding them when the list happens to fit would
  // hide a control that still works — and measuring overflow is the one thing that made the
  // state stale in the first place.
  arrowsContainer.classList.toggle('visible', ids.length > 1);

  // i < 0 means the active tab isn't in the navigable set (e.g. the context filter hides it).
  // Back has nowhere to go; Next lands on the first visible tab rather than stranding you.
  setArrowDisabled(arrowStart, i <= 0);
  setArrowDisabled(arrowEnd, i < 0 ? ids.length === 0 : i >= ids.length - 1);
}

/** Recompute the arrows' enabled state. For callers outside this module (app.js). */
export function refreshTabArrows() {
  updateTabArrows();
}

export function initTabArrows(callbacks = {}) {
  arrowStart = document.getElementById('tabs-arrow-start');
  arrowEnd = document.getElementById('tabs-arrow-end');
  arrowsContainer = document.getElementById('tabs-arrows');
  if (!arrowStart || !arrowEnd || !arrowsContainer) return;

  if (callbacks.getOrderedTabIds) getOrderedTabIds = callbacks.getOrderedTabIds;
  if (callbacks.getActiveTabId) getActiveTabId = callbacks.getActiveTabId;
  if (callbacks.switchToTab) switchToTab = callbacks.switchToTab;

  // No wrapping, unlike the Cmd-hold switcher: a button that reports "disabled, you're at the
  // end" must not then step past it.
  arrowStart.addEventListener('click', () => {
    const { ids, i } = arrowNavState();
    if (i > 0) switchToTab(ids[i - 1]);
  });

  arrowEnd.addEventListener('click', () => {
    const { ids, i } = arrowNavState();
    const target = i < 0 ? ids[0] : ids[i + 1];
    if (target) switchToTab(target);
  });

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

/**
 * Apply everything a tab derives from its name: the visible label, the rail icon, and the hover
 * tooltip. Single owner on purpose — #640 was a construction path (the placeholder upgrade)
 * that set two of the three, so every restored tab lost its tooltip until it was renamed.
 *
 * The tooltip is load-bearing, not decoration: `.tab-label` ellipsizes when the strip is
 * crowded, and the collapsed icon rail hides it outright.
 */
function applyTabName(tabEl, name) {
  const label = tabEl.querySelector('.tab-label');
  if (label) label.textContent = name;
  // Collapsed, this glyph is the whole tab — a rename that left it stale would be invisible
  // in the sidebar but wrong in the rail.
  paintTabIcon(tabEl, name);
  tabEl.title = name;
}

/**
 * The static skeleton of a tab. Every name-derived slot starts empty and is filled in by
 * applyTabName(), so a tab's markup has exactly one definition regardless of which path built
 * it. The speaker icon deliberately has no `title` of its own: it is aria-hidden, and a child
 * title shadows the tab's — which cost you the name in the icon rail, where the speaker stays
 * visible but the label does not. The history glyph (#672) carries an `aria-label` and no
 * `title` for exactly that reason; CSS keeps it out of the rail entirely.
 */
const TAB_INNER_HTML = `
      <span class="badge"></span>
      <span class="tab-icon" aria-hidden="true"></span>
      <span class="speaker-icon" aria-hidden="true">${SPEAKER_SVG}</span>
      <span class="tab-label"></span>
      <span class="tab-history" aria-label="History">&#10711;</span>
      <span class="close">&#10005;</span>
    `;

export const TabManager = {
  /**
   * Create a tab element for a session
   */
  createTab(sessionId, name, callbacks) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = 'tab-' + sessionId;
    tab.innerHTML = TAB_INNER_HTML;
    applyTabName(tab, name);

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

    // History (#672). The span is in every tab's skeleton but CSS keeps it hidden
    // until updateHistoryAffordance() marks the tab as having a transcript, so a
    // display tab or a Codex session never shows one.
    tab.querySelector('.tab-history').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onHistory?.(sessionId);
    });

    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, sessionId, callbacks);
    });

    // Drag to reorder — starts on move past threshold, click if no drag
    const onPointerDown = (e) => {
      // Ignore the tab's own buttons and right-click. A button left out of this
      // list still fires its click handler, but the press ALSO arms a tab drag —
      // so the tab follows the pointer while the pane opens underneath it.
      if (e.target.closest('.close, .tab-history')) return;
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
    tab.innerHTML = TAB_INNER_HTML;
    applyTabName(tab, name);
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
      applyTabName(existing, name);
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
    if (tab) applyTabName(tab, name);
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
      // Also what makes the nav arrows scroll: they only change which tab is active, and this
      // brings that tab on screen for free.
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // The active tab IS the arrows' state (#610). This is the only place it changes, and the
    // one place that never refreshed them — which is why the enabled state went stale until
    // some unrelated event happened to recompute it.
    updateTabArrows();
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
   * Mark a tab as having a readable transcript (#672), which is what makes its
   * history glyph appear. Derived from the agentType the server sends on the
   * session socket, so a Codex tab, a plain shell and every iframe-backed tab
   * simply never get the class and never show the button.
   */
  updateHistoryAffordance(sessionId, available) {
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) tab.classList.toggle('has-history', !!available);
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
   * Mark a tab whose connection is being REFUSED rather than merely dropped (#677) —
   * the server is up and has told us over HTTP that it will reject our cookie, so the
   * gate never emitted a handshake. Same badge slot as updateReconnecting, different
   * colour, because the two need different responses from the user: one resolves itself
   * by waiting, the other never will. The page-level banner (#676) says auth is broken;
   * this says which tabs went quiet because of it.
   */
  updateAuthBlocked(sessionId, on) {
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) tab.classList.toggle('auth-blocked', !!on);
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
