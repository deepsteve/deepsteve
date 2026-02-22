/**
 * Main application entry point
 */

import { SessionStore } from './session-store.js';
import { WindowManager } from './window-manager.js';
import { TabManager, getDefaultTabName } from './tab-manager.js';
import { createTerminal, setupTerminalIO, fitTerminal } from './terminal.js';
import { createWebSocket } from './ws-client.js';
import { showDirectoryPicker } from './dir-picker.js';
import { showWindowRestoreModal } from './window-restore-modal.js';
import { LayoutManager } from './layout-manager.js';

// Active sessions in memory
const sessions = new Map();
let activeId = null;

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
  new Notification('Claude needs attention', {
    body: `"${name}" is waiting for input`,
    tag: id
  });
}

function updateTitle() {
  const count = [...sessions.values()].filter(s => s.waitingForInput).length;
  document.title = count > 0 ? `(${count}) deepsteve` : 'deepsteve';
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
      const name = sessions.get(shell.id)?.name || getDefaultTabName(shell.cwd);
      const statusText = shell.status === 'saved' ? 'saved' : (isConnected ? 'connected' : 'active');
      const statusClass = isConnected ? 'active' : '';
      const canClose = !isConnected;

      return `
        <div class="dropdown-item ${isConnected ? 'connected' : ''}" data-id="${shell.id}">
          <div class="session-info">
            <span class="session-name">${name}</span>
            <span class="session-status ${statusClass}">${statusText}</span>
          </div>
          ${canClose ? `<span class="session-close" data-id="${shell.id}">✕</span>` : ''}
        </div>
      `;
    }).join('');

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
  const settings = await fetch('/api/settings').then(r => r.json());
  const currentProfile = settings.shellProfile || '~/.zshrc';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Settings</h2>
      <p style="font-size: 13px; color: #8b949e; margin-bottom: 12px;">
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

  overlay.querySelector('#settings-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#settings-save').onclick = async () => {
    const selected = overlay.querySelector('input[name="profile"]:checked').value;
    const shellProfile = selected === 'custom' ? customInput.value : selected;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shellProfile })
    });
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
  const ws = createWebSocket({ id: existingId, cwd, isNew, worktree: opts.worktree });

  ws.onmessage = (e) => {
    // Try to parse as JSON control message
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      // Not JSON - pass to terminal
      const session = [...sessions.values()].find(s => s.ws === ws);
      if (session) session.term.write(e.data);
      return;
    }

    // Valid JSON - handle control messages (never write to terminal)
    try {
      if (msg.type === 'session') {
        // Check if this WebSocket already has a session (reconnect case)
        const existingSession = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (!existingSession) {
          initTerminal(msg.id, ws, cwd);
        }
      } else if (msg.type === 'gone') {
        SessionStore.removeSession(getWindowId(), msg.id);
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
        }
      }
    } catch (err) {
      console.error('Error handling control message:', err);
    }
  };

  ws.onerror = () => {
    if (existingId) {
      SessionStore.removeSession(getWindowId(), existingId);
    }
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
function initTerminal(id, ws, cwd) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const { term, fit } = createTerminal(container);
  setupTerminalIO(term, ws);

  // Get saved name or generate default
  const windowId = getWindowId();
  const savedSessions = SessionStore.getWindowSessions(windowId);
  const savedSession = savedSessions.find(s => s.id === id);
  const name = savedSession?.name || getDefaultTabName(cwd);

  // Store session in memory
  sessions.set(id, { term, fit, ws, container, cwd, name, waitingForInput: false });

  // Add tab UI with callbacks
  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: (sessionId) => killSession(sessionId),
    onRename: (sessionId) => renameSession(sessionId)
  };

  TabManager.addTab(id, name, tabCallbacks);
  switchTo(id);

  // Save to storage
  SessionStore.addSession(windowId, { id, cwd, name });

  // Fit terminal after render, then request redraw
  requestAnimationFrame(() => {
    fitTerminal(term, fit, ws);
    // Request terminal redraw from server (for reconnecting to existing shells)
    ws.send(JSON.stringify({ type: 'redraw' }));
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    if (activeId === id) {
      fitTerminal(term, fit, ws);
    }
  });
}

/**
 * Switch to a specific session tab
 */
function switchTo(id) {
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
    // Clear badge when switching to this tab
    TabManager.updateBadge(id, false);

    requestAnimationFrame(() => {
      session.fit.fit();
      session.term.scrollToBottom();
      session.term.focus();
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

  // Switch to next available session
  if (activeId === id) {
    const next = sessions.keys().next().value;
    if (next) {
      switchTo(next);
    } else {
      activeId = null;
    }
  }
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
    if (action === 'worktree') {
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
      <p style="font-size: 13px; color: #8b949e; margin-bottom: 12px;">
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
 * Main initialization
 */
async function init() {
  // Initialize layout manager
  LayoutManager.init();

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

  if (isExistingTab) {
    // Existing tab - restore its sessions
    const savedSessions = SessionStore.getWindowSessions(windowId);
    console.log('[init] windowId:', windowId, 'savedSessions:', savedSessions);
    if (savedSessions.length > 0) {
      for (const { id, cwd } of savedSessions) {
        console.log('[init] Restoring session:', id, cwd);
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
