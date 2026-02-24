/**
 * Main application entry point
 */

import { SessionStore } from './session-store.js';
import { WindowManager } from './window-manager.js';
import { TabManager, getDefaultTabName } from './tab-manager.js';
import { createTerminal, setupTerminalIO, fitTerminal, measureTerminalSize, updateTerminalTheme } from './terminal.js';
import { createWebSocket } from './ws-client.js';
import { showDirectoryPicker } from './dir-picker.js';
import { showWindowRestoreModal } from './window-restore-modal.js';
import { LayoutManager } from './layout-manager.js';
import { initLiveReload } from './live-reload.js';
import { ModManager } from './mod-manager.js';

// Configuration
let maxIssueTitleLength = 25;

function truncateTitle(title) {
  if (title.length <= maxIssueTitleLength) return title;
  return title.slice(0, maxIssueTitleLength) + '…';
}

// Active sessions in memory
const sessions = new Map();
let activeId = null;

// Dedup set for browser-eval/console requests (each tab processes once)
const processedBrowserRequests = new Set();

/**
 * Per-tab session persistence via sessionStorage.
 * This is the authoritative source for "what sessions does THIS tab have."
 * Survives page refresh, doesn't depend on localStorage window-ID mapping.
 */
const TabSessions = {
  KEY: 'deepsteve-tab-sessions',
  get() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY)) || []; } catch { return []; }
  },
  save(sessionList) {
    sessionStorage.setItem(this.KEY, JSON.stringify(sessionList));
  },
  add(session) {
    const list = this.get();
    if (!list.find(s => s.id === session.id)) list.push(session);
    this.save(list);
  },
  remove(sessionId) {
    this.save(this.get().filter(s => s.id !== sessionId));
  },
  updateId(oldId, newId) {
    const list = this.get();
    const s = list.find(s => s.id === oldId);
    if (s) { s.id = newId; this.save(list); }
  }
};

// Prevent accidental browser navigation (back/forward)
window.addEventListener('popstate', (e) => {
  // Push state back to prevent navigation
  history.pushState(null, '', location.href);
});
// Initialize history state
history.pushState(null, '', location.href);

// Warn before leaving page with active sessions
window.addEventListener('beforeunload', (e) => {
  if (sessions.size > 0) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// Notification infrastructure
let notifPermission = 'Notification' in window ? Notification.permission : 'denied';
const notifCooldown = new Map();
const activeNotifications = new Map();
const COOLDOWN_MS = 10000;

// Request notification permission on first click
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => notifPermission = p);
  }
}, { once: true });

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

function showNotification(id, name) {
  if (notifPermission !== 'granted') return;
  if (activeId === id && document.hasFocus()) return;
  const last = notifCooldown.get(id) || 0;
  if (Date.now() - last < COOLDOWN_MS) return;

  notifCooldown.set(id, Date.now());
  const notif = new Notification('Claude needs attention', {
    body: `"${name}" is waiting for input`,
    tag: id
  });
  notif.onclose = () => activeNotifications.delete(id);
  activeNotifications.set(id, notif);
}

function clearNotification(id) {
  const notif = activeNotifications.get(id);
  if (notif) {
    notif.close();
    activeNotifications.delete(id);
  }
}

function clearAllNotifications() {
  for (const [id, notif] of activeNotifications) {
    notif.close();
  }
  activeNotifications.clear();
}

/**
 * Apply a theme by injecting/updating a <style> tag with the given CSS.
 * Pass empty string to revert to default (built-in CSS variables).
 */
function applyTheme(css) {
  let style = document.getElementById('ds-theme');
  if (!css) {
    if (style) style.remove();
  } else {
    if (!style) {
      style = document.createElement('style');
      style.id = 'ds-theme';
      document.head.appendChild(style);
    }
    style.textContent = css;
  }
  // Update all existing terminal backgrounds to match the new --ds-bg-primary
  for (const [, session] of sessions) {
    updateTerminalTheme(session.term);
  }
}

// Clear notifications for the active session when the window regains focus
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeId) {
    clearNotification(activeId);
  }
});
window.addEventListener('focus', () => {
  if (activeId) clearNotification(activeId);
});

function updateEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.style.display = sessions.size === 0 ? '' : 'none';
}

function updateTitle() {
  const count = [...sessions.values()].filter(s => s.waitingForInput).length;
  document.title = count > 0 ? `(${count}) deepsteve` : 'deepsteve';
}

function updateEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.classList.toggle('hidden', sessions.size > 0);
}

/**
 * Build a session list for the mod bridge API
 */
function getSessionList() {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    name: s.name || getDefaultTabName(s.cwd),
    cwd: s.cwd,
    waitingForInput: s.waitingForInput || false,
  }));
}

// Sessions dropdown
const sessionsBtn = document.getElementById('sessions-btn');
const sessionsMenu = document.getElementById('sessions-menu');

sessionsBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const isOpen = sessionsMenu.classList.toggle('open');
  if (isOpen) {
    await refreshSessionsDropdown();
  }
});

document.addEventListener('click', () => {
  sessionsMenu?.classList.remove('open');
});

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function refreshSessionsDropdown() {
  try {
    const res = await fetch('/api/shells');
    const data = await res.json();
    const allShells = data.shells || [];

    if (allShells.length === 0) {
      sessionsMenu.innerHTML = '<div class="dropdown-empty">No sessions</div>';
      return;
    }

    // Get IDs of sessions connected in THIS tab
    const connectedIds = new Set(sessions.keys());

    sessionsMenu.innerHTML = allShells.map(shell => {
      const isConnected = connectedIds.has(shell.id);
      const name = sessions.get(shell.id)?.name || shell.name || getDefaultTabName(shell.cwd);
      const staleness = !isConnected && shell.lastActivity ? formatRelativeTime(shell.lastActivity) : '';
      const statusText = isConnected ? 'connected' : (staleness || (shell.status === 'saved' ? 'saved' : 'not connected'));
      const statusClass = isConnected ? 'active' : '';
      const canClose = !isConnected;

      return `
        <div class="dropdown-item ${isConnected ? 'connected' : 'clickable'}" data-id="${shell.id}" data-cwd="${shell.cwd}" data-name="${escapeHtml(name)}">
          <div class="session-info">
            <span class="session-name">${name}</span>
            <span class="session-status ${statusClass}">${statusText}</span>
          </div>
          ${canClose ? `<span class="session-close" data-id="${shell.id}">✕</span>` : ''}
        </div>
      `;
    }).join('');

    // Add click handlers to attach to non-connected sessions
    sessionsMenu.querySelectorAll('.dropdown-item.clickable').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-close')) return;
        const id = item.dataset.id;
        const cwd = item.dataset.cwd;
        const name = item.dataset.name || null;
        sessionsMenu.classList.remove('open');
        createSession(cwd, id, false, { name });
      });
    });

    // Add close handlers
    sessionsMenu.querySelectorAll('.session-close').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        await fetch(`/api/shells/${id}`, { method: 'DELETE' });
        await refreshSessionsDropdown();
      });
    });
  } catch (err) {
    sessionsMenu.innerHTML = '<div class="dropdown-empty">Error loading sessions</div>';
  }
}

// Settings modal
const settingsBtn = document.getElementById('settings-btn');

settingsBtn?.addEventListener('click', async () => {
  const [settingsData, themesData, versionData] = await Promise.all([
    fetch('/api/settings').then(r => r.json()),
    fetch('/api/themes').then(r => r.json()),
    fetch('/api/version').then(r => r.json()).catch(() => ({ current: '?', latest: null, updateAvailable: false }))
  ]);
  const currentProfile = settingsData.shellProfile || '~/.zshrc';
  const currentMaxTitle = settingsData.maxIssueTitleLength || 25;
  const themes = themesData.themes || [];
  const activeTheme = themesData.active || '';

  const themeOptions = ['<option value="">Default</option>']
    .concat(themes.map(t => `<option value="${escapeHtml(t)}" ${t === activeTheme ? 'selected' : ''}>${escapeHtml(t)}</option>`))
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Settings</h2>
      <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 12px;">
        Shell profile to source before running Claude:
      </p>
      <div class="settings-option">
        <input type="radio" name="profile" id="profile-zshrc" value="~/.zshrc" ${currentProfile === '~/.zshrc' ? 'checked' : ''}>
        <label for="profile-zshrc">~/.zshrc (zsh)</label>
      </div>
      <div class="settings-option">
        <input type="radio" name="profile" id="profile-bashrc" value="~/.bashrc" ${currentProfile === '~/.bashrc' ? 'checked' : ''}>
        <label for="profile-bashrc">~/.bashrc (bash)</label>
      </div>
      <div class="settings-option">
        <input type="radio" name="profile" id="profile-custom" value="custom" ${currentProfile !== '~/.zshrc' && currentProfile !== '~/.bashrc' ? 'checked' : ''}>
        <label for="profile-custom">Custom</label>
      </div>
      <div class="settings-custom">
        <input type="text" id="custom-profile" placeholder="~/.config/myprofile" value="${currentProfile !== '~/.zshrc' && currentProfile !== '~/.bashrc' ? currentProfile : ''}">
      </div>
      <div class="settings-section">
        <h3>Theme</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Place .css files in ~/.deepsteve/themes/ to add themes.
        </p>
        <select class="theme-select" id="theme-select">${themeOptions}</select>
      </div>
      <div class="settings-section">
        <h3>Issue Title Length</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Max characters to display for GitHub issue titles in tabs.
        </p>
        <input type="number" id="max-issue-title-length" min="10" max="200" value="${currentMaxTitle}" style="width: 80px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
      </div>
      <div class="settings-section">
        <h3>Version</h3>
        <div class="version-info">
          <span>Version ${escapeHtml(versionData.current)}</span>
          <div class="version-status ${
            versionData.latest === null ? 'version-failed' :
            versionData.updateAvailable ? 'version-update' : 'version-ok'
          }">${
            versionData.latest === null ? "Couldn\u2019t check for updates" :
            versionData.updateAvailable ? `Version ${escapeHtml(versionData.latest)} available \u2014 see deepsteve.com for upgrade instructions` :
            "You\u2019re up to date"
          }</div>
        </div>
      </div>
      <div class="modal-buttons" style="margin-top: 16px;">
        <button class="btn-secondary" id="settings-cancel">Cancel</button>
        <button class="btn-primary" id="settings-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const customInput = overlay.querySelector('#custom-profile');
  overlay.querySelectorAll('input[name="profile"]').forEach(radio => {
    radio.addEventListener('change', () => {
      customInput.disabled = radio.value !== 'custom';
    });
  });
  customInput.disabled = overlay.querySelector('#profile-custom:checked') === null;

  // Live preview: apply theme immediately on select change
  const themeSelect = overlay.querySelector('#theme-select');
  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value || null;
    await fetch('/api/themes/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    // The server will broadcast the theme CSS via WebSocket — applyTheme runs from the WS handler
  });

  overlay.querySelector('#settings-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#settings-save').onclick = async () => {
    const selected = overlay.querySelector('input[name="profile"]:checked').value;
    const shellProfile = selected === 'custom' ? customInput.value : selected;
    const newMaxTitle = Number(overlay.querySelector('#max-issue-title-length').value) || 25;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shellProfile, maxIssueTitleLength: newMaxTitle })
    });
    maxIssueTitleLength = Math.max(10, Math.min(200, newMaxTitle));
    overlay.remove();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});

function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const count = [...sessions.values()].filter(s => s.waitingForInput).length;
  if (count > 0) navigator.setAppBadge(count);
  else navigator.clearAppBadge();
}

/**
 * Get the current window ID
 */
function getWindowId() {
  return WindowManager.getWindowId();
}

/**
 * Create a new terminal session
 */
function createSession(cwd, existingId = null, isNew = false, opts = {}) {
  const { cols, rows } = measureTerminalSize();
  const ws = createWebSocket({ id: existingId, cwd, isNew, worktree: opts.worktree, name: opts.name, cols, rows });

  // Buffer terminal data that arrives before the terminal is created
  let pendingData = [];
  let hasScrollback = false;

  ws.onmessage = (e) => {
    // Try to parse as JSON control message
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      // Not JSON - pass to terminal (or buffer if not yet created)
      const session = [...sessions.values()].find(s => s.ws === ws);
      if (session) {
        session.term.write(e.data);
      } else {
        pendingData.push(e.data);
      }
      return;
    }

    // Valid JSON - handle control messages (never write to terminal)
    try {
      if (msg.type === 'session') {
        // Update reconnect URL to use the assigned session ID
        ws.setSessionId(msg.id);
        hasScrollback = msg.scrollback || false;
        // If server assigned a different ID than requested, update TabSessions
        if (existingId && msg.id !== existingId) {
          TabSessions.updateId(existingId, msg.id);
        }
        // Check if this WebSocket already has a session (reconnect case)
        const existingSession = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (!existingSession) {
          // Use client-provided name, or fall back to server-persisted name
          const sessionName = opts.name || msg.name;
          initTerminal(msg.id, ws, cwd, sessionName, { hasScrollback, pendingData });
          if (opts.initialPrompt) {
            ws.sendJSON({ type: 'initialPrompt', text: opts.initialPrompt });
          }
        }
      } else if (msg.type === 'gone') {
        SessionStore.removeSession(getWindowId(), msg.id);
        TabSessions.remove(msg.id);
      } else if (msg.type === 'theme') {
        applyTheme(msg.css || '');
      } else if (msg.type === 'mod-changed') {
        ModManager.handleModChanged(msg.modId);
      } else if (msg.type === 'state') {
        const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (entry) {
          const [sid, s] = entry;
          s.waitingForInput = msg.waiting;
          TabManager.updateBadge(sid, msg.waiting && activeId !== sid);
          updateTitle();
          updateAppBadge();
          if (msg.waiting) {
            showNotification(sid, s.name || getDefaultTabName(s.cwd));
          }
          ModManager.notifySessionsChanged(getSessionList());
        }
      } else if (msg.type === 'tasks') {
        ModManager.notifyTasksChanged(msg.tasks);
      } else if (msg.type === 'browser-eval-request') {
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBrowserEvalRequest(msg);
        }
      } else if (msg.type === 'browser-console-request') {
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBrowserConsoleRequest(msg);
        }
      }
    } catch (err) {
      console.error('Error handling control message:', err);
    }
  };

  ws.onerror = () => {
    // Don't wipe session storage on WS error — the server might just be restarting.
    // Sessions will be cleaned up if the server responds with 'gone' on reconnect.
    console.log('[ws] error for session', existingId, '— keeping in storage for reconnect');
  };

  ws.onreconnecting = () => {
    // Find session by websocket and add reconnecting state
    const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
    if (entry) {
      const [, session] = entry;
      session.container.classList.add('reconnecting');
    }
  };

  ws.onreconnected = () => {
    // Remove reconnecting state and refresh terminal
    const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
    if (entry) {
      const [, session] = entry;
      session.container.classList.remove('reconnecting');
      // Refit and request redraw from server
      requestAnimationFrame(() => {
        session.fit.fit();
        const { cols, rows } = session.term;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        ws.send(JSON.stringify({ type: 'redraw' }));
      });
    }
  };
}

/**
 * Initialize a terminal after WebSocket connection is established
 */
function initTerminal(id, ws, cwd, initialName, { hasScrollback = false, pendingData = [] } = {}) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const { term, fit } = createTerminal(container);
  setupTerminalIO(term, ws, {
    onUserInput: () => clearNotification(id)
  });

  // Get saved name or generate default
  const windowId = getWindowId();
  const savedSessions = SessionStore.getWindowSessions(windowId);
  const savedSession = savedSessions.find(s => s.id === id);
  const name = savedSession?.name || initialName || getDefaultTabName(cwd);

  // Store session in memory
  sessions.set(id, { term, fit, ws, container, cwd, name, waitingForInput: false });

  // Flush any buffered data that arrived before the terminal was created
  for (const data of pendingData) {
    term.write(data);
  }
  pendingData.length = 0;

  // Add tab UI with callbacks
  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: (sessionId) => killSession(sessionId),
    onRename: (sessionId) => renameSession(sessionId)
  };

  TabManager.addTab(id, name, tabCallbacks);
  updateEmptyState();
  switchTo(id);

  // Save to both storages — TabSessions is per-tab truth, SessionStore is for cross-tab
  TabSessions.add({ id, cwd, name });
  SessionStore.addSession(windowId, { id, cwd, name });

  // Fit terminal after layout is complete (double-rAF ensures layout has happened)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitTerminal(term, fit, ws);
      if (hasScrollback) {
        // Scroll to bottom after scrollback replay so user sees latest output
        term.scrollToBottom();
        // Hide the host terminal cursor — Claude Code renders its own cursor
        // via Ink. The original DECTCEM hide sequence from session start may
        // have been trimmed from the scrollback circular buffer.
        term.write('\x1b[?25l');
      } else {
        // No scrollback — request a Ctrl+L redraw from the PTY
        ws.send(JSON.stringify({ type: 'redraw' }));
      }
    });
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    if (activeId === id) {
      fitTerminal(term, fit, ws);
    }
  });

  updateEmptyState();

  // Notify mods of session list change
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Switch to a specific session tab
 */
function switchTo(id) {
  // If mod view is active, delegate to ModManager to show terminal with back button
  if (ModManager.isModViewVisible()) {
    ModManager.showTerminalForSession(id);
    return;
  }

  // Deactivate current
  if (activeId) {
    const current = sessions.get(activeId);
    if (current) {
      current.container.classList.remove('active');
    }
    TabManager.setActive(null);
  }

  // Activate new
  activeId = id;
  const session = sessions.get(id);
  if (session) {
    session.container.classList.add('active');
    TabManager.setActive(id);
    // Clear badge and notification when switching to this tab
    TabManager.updateBadge(id, false);
    clearNotification(id);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitTerminal(session.term, session.fit, session.ws);
        session.term.scrollToBottom();
        session.term.focus();
      });
    });
  }
}

/**
 * Kill a session and clean up
 */
function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  session.ws.close();
  session.term.dispose();
  session.container.remove();

  TabManager.removeTab(id);
  sessions.delete(id);

  SessionStore.removeSession(getWindowId(), id);
  TabSessions.remove(id);

  // Switch to next available session
  if (activeId === id) {
    const next = sessions.keys().next().value;
    if (next) {
      switchTo(next);
    } else {
      activeId = null;
    }
  }

  updateEmptyState();

  // Notify mods of session list change
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Rename a session
 */
function renameSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  TabManager.promptRename(id, session.name, (newName) => {
    const name = newName || getDefaultTabName(session.cwd);
    session.name = name;
    TabManager.updateLabel(id, name);
    SessionStore.updateSession(getWindowId(), id, { name });
    // Update per-tab storage
    const tabList = TabSessions.get();
    const tabEntry = tabList.find(s => s.id === id);
    if (tabEntry) { tabEntry.name = name; TabSessions.save(tabList); }
    // Tell server so it persists across tab close/restore
    session.ws.sendJSON({ type: 'rename', name });
    ModManager.notifySessionsChanged(getSessionList());
  });
}

/**
 * Quick new session in same repo as active session
 */
function quickNewSession() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd() || '~';
  createSession(cwd, null, true);
}

/**
 * Show long-press menu for new tab options
 */
function showNewTabMenu(e) {
  // Remove any existing menu
  document.querySelector('.new-tab-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'new-tab-menu context-menu';
  menu.innerHTML = `
    <div class="context-menu-item" data-action="issue">Pick issue...</div>
    <div class="context-menu-item" data-action="worktree">New worktree...</div>
    <div class="context-menu-item" data-action="repo">Change repo...</div>
  `;

  const btn = e.target.closest('#new-btn');
  const rect = btn.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';

  document.body.appendChild(menu);

  // Handle selection via mouseup (drag-release) or click
  const selectItem = async (ev) => {
    const item = ev.target.closest('.context-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    menu.remove();
    cleanup();
    if (action === 'issue') {
      await showIssuePicker();
    } else if (action === 'worktree') {
      await promptWorktreeSession();
    } else if (action === 'repo') {
      await promptRepoSession();
    }
  };

  menu.addEventListener('mouseup', selectItem);
  menu.addEventListener('click', selectItem);

  // Close on click outside
  const cleanup = () => {
    document.removeEventListener('mousedown', closeHandler);
  };
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== e.target) {
      menu.remove();
      cleanup();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
}

/**
 * Prompt for worktree name and create session
 */
async function promptWorktreeSession() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd();
  if (!cwd) return promptRepoSession();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>New worktree</h2>
      <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 12px;">
        Creates a git worktree and opens Claude in it.
      </p>
      <input type="text" id="worktree-name" placeholder="e.g. feature-auth, bugfix-123" style="width: 100%; box-sizing: border-box;">
      <div class="modal-buttons" style="margin-top: 16px;">
        <button class="btn-secondary" id="wt-cancel">Cancel</button>
        <button class="btn-primary" id="wt-create">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#worktree-name');
  input.focus();

  return new Promise((resolve) => {
    const submit = () => {
      const name = input.value.trim();
      overlay.remove();
      if (name) {
        createSession(cwd, null, true, { worktree: name });
      }
      resolve();
    };

    overlay.querySelector('#wt-cancel').onclick = () => { overlay.remove(); resolve(); };
    overlay.querySelector('#wt-create').onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
  });
}

/**
 * Prompt for directory and create session
 */
async function promptRepoSession() {
  const cwd = await showDirectoryPicker();
  if (cwd === null) return;
  createSession(cwd, null, true);
}

/**
 * Escape HTML special characters for safe rendering
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Show GitHub issue picker and create worktree session
 */
async function showIssuePicker() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd();
  if (!cwd) return promptRepoSession();

  // Check git root
  let gitRoot;
  try {
    const res = await fetch('/api/git-root?cwd=' + encodeURIComponent(cwd));
    if (!res.ok) throw new Error('Not a git repository');
    gitRoot = (await res.json()).root;
  } catch {
    alert('Current directory is not a git repository.');
    return;
  }

  // Fetch issues
  let issues;
  try {
    const res = await fetch('/api/issues?cwd=' + encodeURIComponent(gitRoot));
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to fetch issues');
    issues = (await res.json()).issues;
  } catch (e) {
    alert('Failed to fetch issues: ' + e.message);
    return;
  }

  // Build modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width: 520px;">
      <h2>Pick a GitHub Issue</h2>
      ${issues.length === 0 ? '<div class="issue-empty">No open issues found</div>' : `
        <div class="issue-list">${issues.map(issue => `
          <div class="issue-item" data-number="${issue.number}">
            <span class="issue-number">#${issue.number}</span>
            <div>
              <div class="issue-title">${escapeHtml(issue.title)}</div>
              ${issue.labels && issue.labels.length > 0 ? `
                <div class="issue-labels">${issue.labels.map(l => `<span class="issue-label">${escapeHtml(l.name)}</span>`).join('')}</div>
              ` : ''}
            </div>
          </div>
        `).join('')}</div>
      `}
      <div class="modal-buttons">
        <button class="btn-secondary" id="issue-cancel">Cancel</button>
        ${issues.length > 0 ? '<button class="btn-primary" id="issue-start" disabled>Start</button>' : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let selectedIssue = null;

  // Issue selection
  overlay.querySelectorAll('.issue-item').forEach(item => {
    item.addEventListener('click', () => {
      overlay.querySelectorAll('.issue-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedIssue = issues.find(i => i.number === parseInt(item.dataset.number));
      const startBtn = overlay.querySelector('#issue-start');
      if (startBtn) startBtn.disabled = false;
    });
    item.addEventListener('dblclick', () => {
      selectedIssue = issues.find(i => i.number === parseInt(item.dataset.number));
      startIssue();
    });
  });

  function startIssue() {
    if (!selectedIssue) return;
    overlay.remove();

    const body = selectedIssue.body ? selectedIssue.body.slice(0, 2000) : '(no description)';
    const labels = selectedIssue.labels?.map(l => l.name).join(', ') || 'none';
    const prompt = `I need you to work on GitHub issue #${selectedIssue.number}: "${selectedIssue.title}"
Labels: ${labels}
URL: ${selectedIssue.url}

Issue description:
${body}

Please read the issue carefully, understand the codebase context, and implement the changes needed.`;

    createSession(gitRoot, null, true, {
      worktree: 'github-issue-' + selectedIssue.number,
      initialPrompt: prompt,
      name: truncateTitle(`#${selectedIssue.number} ${selectedIssue.title}`)
    });
  }

  overlay.querySelector('#issue-cancel').onclick = () => overlay.remove();
  const startBtn = overlay.querySelector('#issue-start');
  if (startBtn) startBtn.onclick = startIssue;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

/**
 * Main initialization
 */
async function init() {
  // Initialize layout manager
  LayoutManager.init();

  // Initialize mod system
  ModManager.init({
    getSessions: getSessionList,
    focusSession: switchTo,
    createSession: (cwd) => createSession(cwd, null, true),
    killSession: killSession,
  });

  // Auto-reload browser when server restarts (restart.sh, node --watch, etc.)
  initLiveReload({
    onMessage: (msg) => {
      if (msg.type === 'theme') applyTheme(msg.css || '');
    }
  });

  // Load settings before creating any terminals (prevents color flash, applies title length)
  try {
    const settingsData = await fetch('/api/settings').then(r => r.json());
    if (settingsData.themeCSS) {
      applyTheme(settingsData.themeCSS);
    }
    if (settingsData.maxIssueTitleLength) {
      maxIssueTitleLength = settingsData.maxIssueTitleLength;
    }
  } catch {}

  // Load available mods (creates Mods button, auto-activates persisted mod)
  await ModManager.loadAvailableMods();

  // Set up new button handler with long-press for menu
  const newBtn = document.getElementById('new-btn');
  let holdTimer = null;
  let holdMenuOpen = false;

  newBtn.addEventListener('mousedown', (e) => {
    holdMenuOpen = false;
    holdTimer = setTimeout(() => {
      holdMenuOpen = true;
      showNewTabMenu(e);
    }, 500);
  });

  newBtn.addEventListener('mouseup', () => {
    clearTimeout(holdTimer);
    if (!holdMenuOpen) quickNewSession();
  });

  newBtn.addEventListener('mouseleave', () => {
    if (!holdMenuOpen) clearTimeout(holdTimer);
  });

  // Wire up wand button
  const wandBtn = document.getElementById('wand-btn');
  if (wandBtn) wandBtn.onclick = showIssuePicker;

  // Check if this is an existing tab BEFORE starting heartbeat (which creates window ID)
  const isExistingTab = WindowManager.hasExistingWindowId();
  console.log('[init] isExistingTab:', isExistingTab);
  console.log('[init] sessionStorage windowId:', sessionStorage.getItem('deepsteve-window-id'));
  console.log('[init] localStorage:', localStorage.getItem('deepsteve'));

  // Check for legacy storage format and migrate
  const legacySessions = SessionStore.migrateFromLegacy();

  // Now get/create window ID and start heartbeat
  const windowId = WindowManager.getWindowId();
  WindowManager.startHeartbeat();

  // TabSessions (sessionStorage) is the authoritative per-tab source.
  // It survives page refresh and doesn't depend on localStorage window-ID mapping.
  const tabSessions = TabSessions.get();
  console.log('[init] TabSessions:', tabSessions);

  if (isExistingTab && tabSessions.length > 0) {
    // Existing tab with sessions saved in sessionStorage — restore them
    console.log('[init] Restoring from TabSessions');
    for (const { id, cwd } of tabSessions) {
      console.log('[init] Restoring session:', id, cwd);
      createSession(cwd, id);
    }
  } else if (isExistingTab) {
    // Existing tab but TabSessions is empty — try localStorage as fallback
    const savedSessions = SessionStore.getWindowSessions(windowId);
    console.log('[init] windowId:', windowId, 'savedSessions (fallback):', savedSessions);
    if (savedSessions.length > 0) {
      for (const { id, cwd } of savedSessions) {
        console.log('[init] Restoring session (fallback):', id, cwd);
        createSession(cwd, id);
      }
    } else {
      console.log('[init] No saved sessions, prompting for new');
      await promptRepoSession();
    }
  } else {
    // New tab - check for orphaned windows or legacy sessions
    if (legacySessions && legacySessions.length > 0) {
      // Migrate legacy sessions to this window
      for (const session of legacySessions) {
        SessionStore.addSession(windowId, session);
        TabSessions.add(session);
      }
      for (const { id, cwd } of legacySessions) {
        createSession(cwd, id);
      }
    } else {
      // Check for orphaned windows
      const orphanedWindows = await WindowManager.listOrphanedWindows();

      if (orphanedWindows.length > 0) {
        const result = await showWindowRestoreModal(orphanedWindows);

        if (result.action === 'restore') {
          // Claim the selected window's sessions
          const sessions = WindowManager.claimWindow(result.window.windowId);
          for (const sess of sessions) {
            TabSessions.add(sess);
          }
          for (const { id, cwd } of sessions) {
            createSession(cwd, id);
          }
        } else {
          // Start fresh
          await promptRepoSession();
        }
      } else {
        // No orphaned windows - start fresh
        await promptRepoSession();
      }
    }
  }

  // Update window activity periodically
  setInterval(() => {
    SessionStore.touchWindow(windowId);
  }, 60000);
}

// Start the app
init();
