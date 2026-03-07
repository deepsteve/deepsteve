/**
 * Main application entry point
 */

import { SessionStore } from './session-store.js';
import { WindowManager } from './window-manager.js';
import { TabManager, getDefaultTabName, initTabArrows } from './tab-manager.js';
import { createTerminal, setupTerminalIO, fitTerminal, observeTerminalResize, measureTerminalSize, updateTerminalTheme } from './terminal.js';
import { createWebSocket } from './ws-client.js';
import { showDirectoryPicker } from './dir-picker.js';
import { showWindowRestoreModal } from './window-restore-modal.js';
import { LayoutManager } from './layout-manager.js';
import { initLiveReload } from './live-reload.js';
import { ModManager } from './mod-manager.js';
import { initFileDrop } from './file-drop.js';
import { init as initCmdHoldMode, setEnabled as setCmdHoldModeEnabled, setHoldMs as setCmdHoldModeHoldMs } from './cmd-tab-switch.js';
import { nsKey } from './storage-namespace.js';

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
  KEY: nsKey('deepsteve-tab-sessions'),
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

/**
 * Persist the active tab ID in sessionStorage so it survives page refresh.
 */
const ActiveTab = {
  KEY: nsKey('deepsteve-active-tab'),
  get() { return sessionStorage.getItem(this.KEY); },
  set(id) { sessionStorage.setItem(this.KEY, id); },
  clear() { sessionStorage.removeItem(this.KEY); }
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
  if (window.__deepsteveReloadPending) return; // Skip prompt during server restart reload
  const hasActiveSessions = [...sessions.values()].some(s => s.type !== 'mod-tab' && !s.waitingForInput);
  if (hasActiveSessions) {
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

function applySettings(settings) {
  if (settings.maxIssueTitleLength !== undefined) {
    maxIssueTitleLength = settings.maxIssueTitleLength;
  }
  if (settings.cmdTabSwitch !== undefined) {
    setCmdHoldModeEnabled(settings.cmdTabSwitch);
  }
  if (settings.cmdTabSwitchHoldMs !== undefined) {
    setCmdHoldModeHoldMs(settings.cmdTabSwitchHoldMs);
  }
  if (settings.windowConfigs !== undefined) {
    windowConfigs = settings.windowConfigs;
    renderEmptyStateConfigs();
    window.dispatchEvent(new CustomEvent('deepsteve-window-configs', { detail: windowConfigs }));
  }
}

// When the browser tab regains visibility, re-sync scroll position.
// scrollToBottom() calls from onWriteParsed may have been no-ops while
// the tab was hidden (browsers skip layout for background tabs), so the
// viewport can fall behind even though the scroll state is AUTO.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeId) {
    clearNotification(activeId);
    const session = sessions.get(activeId);
    if (session?.scrollControl) {
      session.scrollControl.nudgeToBottom();
    }
  }
});
window.addEventListener('focus', () => {
  if (activeId) clearNotification(activeId);
});

function updateTitle() {
  const count = [...sessions.values()].filter(s => s.waitingForInput).length;
  document.title = count > 0 ? `(${count}) deepsteve` : 'deepsteve';
}

function updateEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.classList.toggle('hidden', sessions.size > 0);
}

let windowConfigs = [];

function renderEmptyStateConfigs() {
  const container = document.getElementById('empty-state-configs');
  if (!container) return;
  container.innerHTML = '';
  for (const config of windowConfigs) {
    const btn = document.createElement('button');
    btn.className = 'config-btn';
    btn.textContent = config.name;
    btn.title = `Open ${config.tabs.length} tab${config.tabs.length === 1 ? '' : 's'}`;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Opening...';
      try {
        await fetch(`/api/window-configs/${config.id}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowId: getWindowId() })
        });
      } catch (e) {
        console.error('Failed to apply window config:', e);
      }
    };
    container.appendChild(btn);
  }
}

async function loadWindowConfigs() {
  try {
    const resp = await fetch('/api/window-configs');
    const data = await resp.json();
    windowConfigs = data.configs || [];
    renderEmptyStateConfigs();
  } catch {}
}

// Load configs on startup
loadWindowConfigs();

/**
 * Build a session list for the mod bridge API
 */
function getSessionList() {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    name: s.name || getDefaultTabName(s.cwd),
    cwd: s.cwd,
    waitingForInput: s.waitingForInput || false,
    type: s.type || 'terminal',
  }));
}

// Expose session internals for mods that need direct terminal access (e.g. reparenting)
window.__deepsteve = {
  fitSession(id) {
    const s = sessions.get(id);
    if (s) fitTerminal(s.term, s.fit, s.ws);
  },
  getTerminalContainer(id) {
    const s = sessions.get(id);
    return s ? s.container : null;
  },
  writeSession(id, data) {
    const s = sessions.get(id);
    if (s) s.ws.send(data);
  },
  getTerminal(id) {
    const s = sessions.get(id);
    return s ? s.term : null;
  },
  // Subscribe to raw terminal output data for a session. Returns unsubscribe function.
  _dataListeners: new Map(),
  onSessionData(id, callback) {
    if (!this._dataListeners.has(id)) this._dataListeners.set(id, new Set());
    this._dataListeners.get(id).add(callback);
    return () => { this._dataListeners.get(id)?.delete(callback); };
  },
};

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

    // Sort: active/connected first, then saved, then closed last
    const statusOrder = { active: 0, saved: 1, closed: 2 };
    allShells.sort((a, b) => {
      const aConnected = connectedIds.has(a.id);
      const bConnected = connectedIds.has(b.id);
      if (aConnected !== bConnected) return aConnected ? -1 : 1;
      return (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
    });

    const showAgentBadge = window.__deepsteveAgents?.length > 1;

    sessionsMenu.innerHTML = allShells.map(shell => {
      const isConnected = connectedIds.has(shell.id);
      const isClosed = shell.status === 'closed';
      const name = sessions.get(shell.id)?.name || shell.name || getDefaultTabName(shell.cwd);
      const staleness = !isConnected && shell.lastActivity ? formatRelativeTime(shell.lastActivity) : '';
      const statusText = isConnected ? 'connected' : (isClosed ? (staleness ? `closed ${staleness}` : 'closed') : (staleness || (shell.status === 'saved' ? 'saved' : 'not connected')));
      const statusClass = isConnected ? 'active' : (isClosed ? 'closed' : '');
      const canClose = !isConnected;
      const agentLabel = shell.agentType === 'opencode' ? 'OpenCode' : (shell.agentType ? shell.agentType.charAt(0).toUpperCase() + shell.agentType.slice(1) : '');

      return `
        <div class="dropdown-item ${isConnected ? 'connected' : 'clickable'} ${isClosed ? 'closed' : ''}" data-id="${shell.id}" data-cwd="${shell.cwd}" data-name="${escapeHtml(name)}">
          <div class="session-info">
            <span class="session-name">${name}${showAgentBadge && agentLabel ? ` <span class="session-agent-badge">${agentLabel}</span>` : ''}</span>
            <span class="session-status ${statusClass}">${statusText}</span>
          </div>
          ${canClose ? `<span class="session-close" data-id="${shell.id}">✕</span>` : ''}
        </div>
      `;
    }).join('');

    // Add "Clear disconnected" button at the top
    const disconnectedCount = allShells.filter(s => !connectedIds.has(s.id)).length;
    const clearBtn = document.createElement('div');
    clearBtn.className = 'dropdown-clear-disconnected' + (disconnectedCount === 0 ? ' disabled' : '');
    clearBtn.textContent = disconnectedCount > 0 ? `Clear disconnected (${disconnectedCount})` : 'Clear disconnected';
    if (disconnectedCount > 0) {
      clearBtn.addEventListener('click', async () => {
        await fetch('/api/shells/clear-disconnected', { method: 'POST' });
        await refreshSessionsDropdown();
      });
    }
    sessionsMenu.prepend(clearBtn);

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
        if (!(await confirmCloseSession(id))) return;
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
  const [settingsData, themesData, versionData, defaultsData] = await Promise.all([
    fetch('/api/settings').then(r => r.json()),
    fetch('/api/themes').then(r => r.json()),
    fetch('/api/version').then(r => r.json()).catch(() => ({ current: '?', latest: null, updateAvailable: false })),
    fetch('/api/settings/defaults').then(r => r.json()).catch(() => ({}))
  ]);
  const currentProfile = settingsData.shellProfile || '~/.zshrc';
  const currentMaxTitle = settingsData.maxIssueTitleLength || 25;
  const currentWandPlanMode = settingsData.wandPlanMode !== undefined ? settingsData.wandPlanMode : true;
  const currentWandTemplate = settingsData.wandPromptTemplate || defaultsData.wandPromptTemplate || '';
  const currentCmdTabSwitch = !!settingsData.cmdTabSwitch;
  const currentCmdTabSwitchHoldMs = settingsData.cmdTabSwitchHoldMs !== undefined ? settingsData.cmdTabSwitchHoldMs : 1000;
  const currentDefaultAgent = settingsData.defaultAgent || 'claude';
  const currentOpencodeBinary = settingsData.opencodeBinary || 'opencode';
  const currentGeminiBinary = settingsData.geminiBinary || 'gemini';
  const agents = window.__deepsteveAgents || [];
  const themes = themesData.themes || [];
  const activeTheme = themesData.active || '';

  const themeOptions = ['<option value="">None</option>']
    .concat(themes.map(t => `<option value="${escapeHtml(t)}" ${t === activeTheme ? 'selected' : ''}>${escapeHtml(t)}</option>`))
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="settings-header">
        <h2>Settings</h2>
      </div>
      <div class="settings-body">
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
        <h3>Magic Wand</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
          <input type="checkbox" id="wand-plan-mode" ${currentWandPlanMode ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Start issues in plan mode
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="font-size: 13px; color: var(--ds-text-primary);">Prompt template</span>
          <button class="btn-secondary" id="wand-template-reset" style="padding: 2px 8px; font-size: 11px;">Reset</button>
        </div>
        <textarea id="wand-prompt-template" rows="6" style="width: 100%; box-sizing: border-box; padding: 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px; font-family: monospace; resize: vertical;">${escapeHtml(currentWandTemplate)}</textarea>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Variables: <code>{{number}}</code> <code>{{title}}</code> <code>{{labels}}</code> <code>{{url}}</code> <code>{{body}}</code>
        </p>
      </div>
      <div class="settings-section">
        <h3>Keyboard</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="cmd-tab-switch" ${currentCmdTabSwitch ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Hold \u2318 to switch tabs (\u23181-9, \u2318&lt; \u2318&gt;)
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          Hold delay:
          <input type="number" id="cmd-tab-switch-hold-ms" value="${currentCmdTabSwitchHoldMs}" min="0" max="5000" step="100" style="width: 80px; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px;">
          ms
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Hold Command for this long to activate, then press 1-9 to jump to a tab or &lt; / &gt; to cycle. Set to 0 for instant.
        </p>
      </div>
      <div class="settings-section">
        <h3>Enabled Agents</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Select which agents are available. If multiple are enabled, you can switch between them using the Engine dropdown.
        </p>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-claude" ${agents.find(a => a.id === 'claude')?.enabled !== false ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Claude Code
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-opencode" ${agents.find(a => a.id === 'opencode')?.enabled ? 'checked' : ''} ${agents.find(a => a.id === 'opencode')?.available ? '' : 'disabled'} style="accent-color: var(--ds-accent-green);">
          OpenCode (experimental)${agents.find(a => a.id === 'opencode')?.available ? '' : ' (not installed)'}
        </label>
        <div id="opencode-binary-row" style="display: ${agents.find(a => a.id === 'opencode')?.enabled ? 'block' : 'none'}; margin-top: 8px;">
          <label style="font-size: 12px; color: var(--ds-text-secondary);">Binary path</label>
          <input type="text" id="opencode-binary" value="${escapeHtml(currentOpencodeBinary)}" placeholder="opencode" style="width: 200px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
        </div>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-gemini" ${agents.find(a => a.id === 'gemini')?.enabled ? 'checked' : ''} ${agents.find(a => a.id === 'gemini')?.available ? '' : 'disabled'} style="accent-color: var(--ds-accent-green);">
          Gemini (experimental)${agents.find(a => a.id === 'gemini')?.available ? '' : ' (not installed)'}
        </label>
        <div id="gemini-binary-row" style="display: ${agents.find(a => a.id === 'gemini')?.enabled ? 'block' : 'none'}; margin-top: 8px;">
          <label style="font-size: 12px; color: var(--ds-text-secondary);">Binary path</label>
          <input type="text" id="gemini-binary" value="${escapeHtml(currentGeminiBinary)}" placeholder="gemini" style="width: 200px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
        </div>
      </div>
      <div class="settings-section">
        <h3>Window Configs</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Saved tab layouts. Click a config in the empty state to open all its tabs at once.
        </p>
        <div id="settings-window-configs"></div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="btn-secondary" id="settings-new-config" style="font-size: 12px; padding: 4px 12px;">+ New Config</button>
          <button class="btn-secondary" id="settings-save-current" style="font-size: 12px; padding: 4px 12px;">Save Current Tabs</button>
        </div>
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
      </div>
      <div class="modal-buttons">
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

  // Show/hide OpenCode binary path input based on checkbox
  const agentOpencodeCheckbox = overlay.querySelector('#agent-opencode');
  const opencodeBinaryRow = overlay.querySelector('#opencode-binary-row');
  agentOpencodeCheckbox?.addEventListener('change', () => {
    opencodeBinaryRow.style.display = agentOpencodeCheckbox.checked ? 'block' : 'none';
  });

  // Show/hide Gemini binary path input based on checkbox
  const agentGeminiCheckbox = overlay.querySelector('#agent-gemini');
  const geminiBinaryRow = overlay.querySelector('#gemini-binary-row');
  agentGeminiCheckbox?.addEventListener('change', () => {
    geminiBinaryRow.style.display = agentGeminiCheckbox.checked ? 'block' : 'none';
  });

  // Wand template reset button
  overlay.querySelector('#wand-template-reset').onclick = async () => {
    if (!confirm('Reset magic wand prompt template to default?')) return;
    const templateInput = overlay.querySelector('#wand-prompt-template');
    templateInput.value = defaultsData.wandPromptTemplate || '';
  };

  // Window Configs management
  let editingConfigs = JSON.parse(JSON.stringify(windowConfigs));
  const configsContainer = overlay.querySelector('#settings-window-configs');

  function renderConfigsList() {
    configsContainer.innerHTML = '';
    if (editingConfigs.length === 0) {
      configsContainer.innerHTML = '<p style="font-size: 12px; color: var(--ds-text-secondary); opacity: 0.6;">No configs saved yet.</p>';
      return;
    }
    for (let i = 0; i < editingConfigs.length; i++) {
      const config = editingConfigs[i];
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 6px; padding: 6px 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px;';
      row.innerHTML = `
        <span style="flex: 1; font-size: 13px; color: var(--ds-text-primary);">${escapeHtml(config.name)}</span>
        <span style="font-size: 11px; color: var(--ds-text-secondary);">${config.tabs.length} tab${config.tabs.length === 1 ? '' : 's'}</span>
        <button class="btn-secondary config-edit-btn" data-idx="${i}" style="padding: 2px 8px; font-size: 11px;">Edit</button>
        <button class="btn-secondary config-delete-btn" data-idx="${i}" style="padding: 2px 8px; font-size: 11px; color: var(--ds-accent-red, #f85149);">Delete</button>
      `;
      configsContainer.appendChild(row);
    }
    configsContainer.querySelectorAll('.config-delete-btn').forEach(btn => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.idx);
        editingConfigs.splice(idx, 1);
        renderConfigsList();
      };
    });
    configsContainer.querySelectorAll('.config-edit-btn').forEach(btn => {
      btn.onclick = () => showConfigEditor(Number(btn.dataset.idx));
    });
  }

  function showConfigEditor(idx) {
    const isNew = idx === -1;
    const config = isNew ? { id: '', name: '', tabs: [{ name: '', cwd: '', agentType: 'claude' }] } : JSON.parse(JSON.stringify(editingConfigs[idx]));
    const editorOverlay = document.createElement('div');
    editorOverlay.className = 'modal-overlay';
    editorOverlay.style.zIndex = '1001';

    function renderEditor() {
      const tabRows = config.tabs.map((t, ti) => `
        <div style="display: flex; gap: 6px; margin-bottom: 4px; align-items: center;">
          <input type="text" class="config-tab-name" data-ti="${ti}" value="${escapeHtml(t.name)}" placeholder="Tab name" style="width: 120px; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
          <input type="text" class="config-tab-cwd" data-ti="${ti}" value="${escapeHtml(t.cwd)}" placeholder="/path/to/project" style="flex: 1; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
          <select class="config-tab-agent" data-ti="${ti}" style="padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
            <option value="claude" ${t.agentType === 'claude' ? 'selected' : ''}>Claude</option>
            <option value="opencode" ${t.agentType === 'opencode' ? 'selected' : ''}>OpenCode</option>
            <option value="gemini" ${t.agentType === 'gemini' ? 'selected' : ''}>Gemini</option>
          </select>
          <button class="btn-secondary config-tab-remove" data-ti="${ti}" style="padding: 2px 6px; font-size: 11px;" ${config.tabs.length <= 1 ? 'disabled' : ''}>&times;</button>
        </div>
      `).join('');

      editorOverlay.innerHTML = `
        <div class="modal" style="max-width: 600px;">
          <h3 style="margin-bottom: 12px;">${isNew ? 'New' : 'Edit'} Window Config</h3>
          <div style="margin-bottom: 12px;">
            <label style="font-size: 12px; color: var(--ds-text-secondary);">Config Name</label>
            <input type="text" id="config-editor-name" value="${escapeHtml(config.name)}" placeholder="My Config" style="width: 100%; padding: 6px 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; margin-top: 4px;">
          </div>
          <div style="margin-bottom: 8px;">
            <label style="font-size: 12px; color: var(--ds-text-secondary);">Tabs</label>
          </div>
          <div id="config-editor-tabs">${tabRows}</div>
          <button class="btn-secondary" id="config-add-tab" style="font-size: 11px; padding: 3px 10px; margin-top: 4px;">+ Add Tab</button>
          <div class="modal-buttons" style="margin-top: 16px;">
            <button class="btn-secondary" id="config-editor-cancel">Cancel</button>
            <button class="btn-primary" id="config-editor-save">Save</button>
          </div>
        </div>
      `;

      editorOverlay.querySelector('#config-editor-cancel').onclick = () => editorOverlay.remove();
      editorOverlay.querySelector('#config-add-tab').onclick = () => {
        syncTabInputs();
        config.tabs.push({ name: '', cwd: '', agentType: 'claude' });
        renderEditor();
      };
      editorOverlay.querySelectorAll('.config-tab-remove').forEach(btn => {
        btn.onclick = () => {
          syncTabInputs();
          config.tabs.splice(Number(btn.dataset.ti), 1);
          renderEditor();
        };
      });
      editorOverlay.querySelector('#config-editor-save').onclick = () => {
        syncTabInputs();
        config.name = editorOverlay.querySelector('#config-editor-name').value.trim();
        if (!config.name) return alert('Config name is required');
        const validTabs = config.tabs.filter(t => t.cwd.trim());
        if (validTabs.length === 0) return alert('At least one tab with a path is required');
        config.tabs = validTabs;
        if (isNew) {
          editingConfigs.push(config);
        } else {
          editingConfigs[idx] = config;
        }
        editorOverlay.remove();
        renderConfigsList();
      };
      editorOverlay.onclick = (e) => { if (e.target === editorOverlay) editorOverlay.remove(); };
    }

    function syncTabInputs() {
      editorOverlay.querySelectorAll('.config-tab-name').forEach(input => {
        config.tabs[Number(input.dataset.ti)].name = input.value;
      });
      editorOverlay.querySelectorAll('.config-tab-cwd').forEach(input => {
        config.tabs[Number(input.dataset.ti)].cwd = input.value;
      });
      editorOverlay.querySelectorAll('.config-tab-agent').forEach(select => {
        config.tabs[Number(select.dataset.ti)].agentType = select.value;
      });
    }

    renderEditor();
    document.body.appendChild(editorOverlay);
  }

  renderConfigsList();

  overlay.querySelector('#settings-new-config').onclick = () => showConfigEditor(-1);
  overlay.querySelector('#settings-save-current').onclick = () => {
    const currentTabs = [...sessions.entries()].map(([, s]) => ({
      name: s.name || '',
      cwd: s.cwd || '',
      agentType: s.agentType || 'claude',
    })).filter(t => t.cwd);
    if (currentTabs.length === 0) return alert('No tabs open to save');
    const name = prompt('Config name:');
    if (!name) return;
    editingConfigs.push({ id: '', name, tabs: currentTabs });
    renderConfigsList();
  };

  overlay.querySelector('#settings-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#settings-save').onclick = async () => {
    const selected = overlay.querySelector('input[name="profile"]:checked').value;
    const shellProfile = selected === 'custom' ? customInput.value : selected;
    const newMaxTitle = Number(overlay.querySelector('#max-issue-title-length').value) || 25;
    const wandPlanMode = overlay.querySelector('#wand-plan-mode').checked;
    const wandPromptTemplate = overlay.querySelector('#wand-prompt-template').value;
    const cmdTabSwitch = overlay.querySelector('#cmd-tab-switch').checked;
    const cmdTabSwitchHoldMs = Math.max(0, Number(overlay.querySelector('#cmd-tab-switch-hold-ms').value) || 0);
    const enabledAgents = [];
    if (overlay.querySelector('#agent-claude').checked) enabledAgents.push('claude');
    if (overlay.querySelector('#agent-opencode').checked) enabledAgents.push('opencode');
    if (overlay.querySelector('#agent-gemini').checked) enabledAgents.push('gemini');
    const opencodeBinary = overlay.querySelector('#opencode-binary').value || 'opencode';
    const geminiBinary = overlay.querySelector('#gemini-binary').value || 'gemini';
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shellProfile, maxIssueTitleLength: newMaxTitle, wandPlanMode, wandPromptTemplate, cmdTabSwitch, cmdTabSwitchHoldMs, enabledAgents, opencodeBinary, geminiBinary, windowConfigs: editingConfigs })
    });
    maxIssueTitleLength = Math.max(10, Math.min(200, newMaxTitle));
    setCmdHoldModeEnabled(cmdTabSwitch);
    setCmdHoldModeHoldMs(cmdTabSwitchHoldMs);
    // Refresh agents data if agent settings changed
    const prevEnabled = (window.__deepsteveAgents || []).filter(a => a.enabled).map(a => a.id).sort().join(',');
    const newEnabled = enabledAgents.sort().join(',');
    if (prevEnabled !== newEnabled) {
      try {
        const agentsResp = await fetch('/api/agents');
        const agentsData = await agentsResp.json();
        window.__deepsteveAgents = agentsData.agents || [];
        window.__deepsteveDefaultAgent = agentsData.defaultAgent || 'claude';
        refreshEnginesDropdown();
      } catch {}
    }
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
  const ws = createWebSocket({ id: existingId, cwd, isNew, worktree: opts.worktree, name: opts.name, planMode: opts.planMode, agentType: opts.agentType, cols, rows, windowId: getWindowId() });

  // Promise that resolves when the session is fully initialized (terminal created)
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  // Buffer terminal data that arrives before the terminal is created
  let pendingData = [];
  let hasScrollback = false;
  let assignedId = null; // session ID assigned by server

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
        // Forward to data listeners (e.g. VR mirror terminal)
        if (assignedId) {
          const listeners = window.__deepsteve._dataListeners?.get(assignedId);
          if (listeners) for (const cb of listeners) try { cb(e.data); } catch {}
        }
      } else {
        pendingData.push(e.data);
      }
      return;
    }

    // Valid JSON - handle control messages (never write to terminal)
    try {
      if (msg.type === 'session') {
        assignedId = msg.id;
        // Reject unexpected duplicates: another window already has this session
        if (msg.existingClients > 0 && !opts.allowDuplicate) {
          console.log(`[createSession] Rejecting duplicate session ${msg.id} (${msg.existingClients} existing client(s))`);
          ws.close();
          resolveReady(null);
          return;
        }
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
          initTerminal(msg.id, ws, cwd, sessionName, { hasScrollback, pendingData, restoreActive: opts.restoreActive || opts.background });
          resolveReady(msg.id);
          if (opts.initialPrompt) {
            ws.sendJSON({ type: 'initialPrompt', text: opts.initialPrompt });
          }
        }
      } else if (msg.type === 'close-tab') {
        if (assignedId) killSession(assignedId);
      } else if (msg.type === 'gone') {
        SessionStore.removeSession(getWindowId(), msg.id);
        TabSessions.remove(msg.id);
      } else if (msg.type === 'theme') {
        applyTheme(msg.css || '');
      } else if (msg.type === 'settings') {
        applySettings(msg);
      } else if (msg.type === 'mod-changed') {
        ModManager.handleModChanged(msg.modId);
      } else if (msg.type === 'state') {
        const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (entry) {
          const [sid, s] = entry;
          s.waitingForInput = msg.waiting;
          s.scrollControl.syncViewport();
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
      } else if (msg.type === 'agent-chat') {
        ModManager.notifyAgentChatChanged(msg.channels);
      } else if (msg.type === 'browser-eval-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBrowserEvalRequest(msg);
        }
      } else if (msg.type === 'browser-console-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBrowserConsoleRequest(msg);
        }
      } else if (msg.type === 'screenshot-capture-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifyScreenshotCaptureRequest(msg);
        }
      } else if (msg.type === 'scene-update-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifySceneUpdateRequest(msg);
        }
      } else if (msg.type === 'scene-query-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifySceneQueryRequest(msg);
        }
      } else if (msg.type === 'scene-snapshot-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifySceneSnapshotRequest(msg);
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
      session.scrollControl.suppressScroll();
      // ResizeObserver handles fit; just request redraw from server
      ws.send(JSON.stringify({ type: 'redraw' }));
      session.scrollControl.scrollToBottom();
    }
  };

  return ready;
}

/**
 * Initialize a terminal after WebSocket connection is established
 */
function initTerminal(id, ws, cwd, initialName, { hasScrollback = false, pendingData = [], restoreActive = false } = {}) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const { term, fit } = createTerminal(container);
  const scrollControl = setupTerminalIO(term, ws, {
    onUserInput: () => clearNotification(id),
    container
  });

  // Get saved name or generate default
  const windowId = getWindowId();
  const savedSessions = SessionStore.getWindowSessions(windowId);
  const savedSession = savedSessions.find(s => s.id === id);
  const name = savedSession?.name || initialName || getDefaultTabName(cwd);

  // Store session in memory
  sessions.set(id, { term, fit, ws, container, cwd, name, waitingForInput: false, scrollControl });

  // Suppress scroll during init to prevent onWriteParsed races with
  // buffered data flush and scrollback replay
  scrollControl.suppressScroll();

  // Flush any buffered data that arrived before the terminal was created
  for (const data of pendingData) {
    term.write(data);
    // Also notify data listeners (e.g. VR mirror terminal)
    const listeners = window.__deepsteve._dataListeners?.get(id);
    if (listeners) for (const cb of listeners) try { cb(data); } catch {}
  }
  pendingData.length = 0;

  // Add tab UI with callbacks
  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      const tabList = TabSessions.get();
      const reordered = orderedIds.map(id => tabList.find(s => s.id === id)).filter(Boolean);
      TabSessions.save(reordered);
      SessionStore.reorderSessions(getWindowId(), orderedIds);
      ModManager.notifySessionsChanged(getSessionList());
    },
    getLiveWindows: () => WindowManager.getLiveWindows(),
    onSendToWindow: (sessionId, targetWindowId) => sendToWindow(sessionId, targetWindowId),
    getModMenuItems: () => {
      return ModManager.getContextMenuItems().map(item => ({
        label: item.label,
        onClick: () => {
          if (item.action === 'focus-panel') ModManager.focusPanel(item.modId);
        },
      }));
    },
  };

  TabManager.addTab(id, name, tabCallbacks);
  updateEmptyState();

  // During restore, skip switchTo() — restoreSessions() will select the
  // correct tab after all sessions are initialized. For new sessions,
  // always switch to the new tab immediately.
  if (!restoreActive) {
    switchTo(id);
  }

  // Save to both storages — TabSessions is per-tab truth, SessionStore is for cross-tab
  TabSessions.add({ id, cwd, name });
  SessionStore.addSession(windowId, { id, cwd, name });
  SessionStore.addRecentDir(cwd);

  // ResizeObserver handles window resize, layout toggle, mod panel.
  // Tab switching is handled by switchTo() calling fitTerminal() directly.
  sessions.get(id).resizeObserver = observeTerminalResize(container, term, fit, ws);

  // One-time init after first fit (which happens in switchTo's rAF above)
  requestAnimationFrame(() => {
    if (hasScrollback) {
      scrollControl.scrollToBottom();
      // Hide the host terminal cursor — Claude Code renders its own cursor
      // via Ink. The original DECTCEM hide sequence from session start may
      // have been trimmed from the scrollback circular buffer.
      term.write('\x1b[?25l');
    } else {
      scrollControl.scrollToBottom();
      ws.send(JSON.stringify({ type: 'redraw' }));
    }
  });

  updateEmptyState();

  // Notify mods of session list change
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Create a mod tab (client-only, no PTY or WebSocket).
 */
function createModTab(modId, opts = {}) {
  const mod = ModManager.getNewTabItems().find(m => m.modId === modId);
  if (!mod) {
    // Mod disabled or removed — clean up stale storage if restoring
    if (opts.id) {
      SessionStore.removeSession(getWindowId(), opts.id);
      TabSessions.remove(opts.id);
    }
    return;
  }

  const id = opts.id || crypto.randomUUID().slice(0, 8);
  const name = opts.name || mod.label;

  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const iframe = document.createElement('iframe');
  iframe.src = `/mods/${modId}/${mod.entry}`;
  iframe.style.cssText = 'width:100%;height:100%;border:none;';
  iframe.sandbox = 'allow-same-origin allow-scripts allow-forms allow-popups';
  container.appendChild(iframe);

  sessions.set(id, {
    term: null, fit: null, ws: null, container, cwd: null,
    name, waitingForInput: false, scrollControl: null,
    type: 'mod-tab', modId,
  });

  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      const tabList = TabSessions.get();
      const reordered = orderedIds.map(id => tabList.find(s => s.id === id)).filter(Boolean);
      TabSessions.save(reordered);
      SessionStore.reorderSessions(getWindowId(), orderedIds);
      ModManager.notifySessionsChanged(getSessionList());
    },
    getLiveWindows: () => [],
    onSendToWindow: () => {},
    getModMenuItems: () => [],
  };

  TabManager.addTab(id, name, tabCallbacks);
  updateEmptyState();

  if (!opts.restoreActive) {
    switchTo(id);
  }

  // Persist
  const windowId = getWindowId();
  TabSessions.add({ id, name, type: 'mod-tab', modId });
  SessionStore.addSession(windowId, { id, name, type: 'mod-tab', modId });

  // Forward resize events to iframe
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    iframe.contentWindow?.postMessage({ type: 'resize', width, height }, '*');
  });
  ro.observe(container);
  sessions.get(id).resizeObserver = ro;

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
  ActiveTab.set(id);
  ModManager.notifyActiveSessionChanged(id);
  const session = sessions.get(id);
  if (session) {
    session.container.classList.add('active');
    TabManager.setActive(id);
    // Clear badge and notification when switching to this tab
    TabManager.updateBadge(id, false);
    clearNotification(id);

    if (session.type === 'mod-tab') return;

    session.scrollControl.suppressScroll();
    requestAnimationFrame(() => {
      try {
        fitTerminal(session.term, session.fit, session.ws);
      } finally {
        session.term.focus();
        requestAnimationFrame(() => {
          session.scrollControl.scrollToBottom();
        });
      }
    });
  }
}

/**
 * Restore multiple sessions and select the previously active tab.
 * Reads ActiveTab before any sessions initialize, waits for all to finish,
 * then selects the right tab once — avoiding the race where the last session
 * to connect wins.
 */
async function restoreSessions(sessionList, opts = {}) {
  const savedActiveId = ActiveTab.get();
  const allowDuplicate = opts.allowDuplicate !== undefined ? opts.allowDuplicate : true;

  // Restore sessions in order — mod tabs are sync, terminal sessions are async.
  // Sequential creation preserves tab position.
  for (const entry of sessionList) {
    if (entry.type === 'mod-tab' && entry.modId) {
      createModTab(entry.modId, { id: entry.id, name: entry.name, restoreActive: true });
    } else {
      const resolvedId = await createSession(entry.cwd, entry.id, false, { restoreActive: true, allowDuplicate });
      if (resolvedId === null) {
        console.log('[restore] Session', entry.id, 'rejected (duplicate), cleaning up storage');
        SessionStore.removeSession(getWindowId(), entry.id);
        TabSessions.remove(entry.id);
      }
    }
  }

  const target = savedActiveId && sessions.has(savedActiveId)
    ? savedActiveId
    : sessions.keys().next().value;
  if (target) {
    if (target === savedActiveId) {
      console.log('[restore] Selecting saved active tab', target);
    } else {
      console.log('[restore] Saved active tab', savedActiveId, 'not found, falling back to', target);
    }
    switchTo(target);
  }
}

/**
 * Show confirmation dialog if agent is busy. Returns true if close should proceed.
 * For locally-connected sessions, checks in-memory state. For server-only sessions
 * (dropdown), fetches state from the server.
 */
function confirmCloseSession(id) {
  // Mod tabs have no PTY — always allow close
  const session = sessions.get(id);
  if (session?.type === 'mod-tab') return Promise.resolve(true);

  // Check local session first (tab is connected in this window)
  const isIdle = session ? session.waitingForInput : null;

  if (isIdle === null) {
    // No local session — fetch from server
    return fetch(`/api/shells/${id}/state`)
      .then(r => r.ok ? r.json() : { waitingForInput: true })
      .then(data => data.waitingForInput ? true : showCloseConfirmDialog())
      .catch(() => true); // on error, allow close
  }

  if (isIdle) return Promise.resolve(true);
  return showCloseConfirmDialog();
}

function showCloseConfirmDialog() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>Close running session?</h2>
        <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:16px;">This agent is still running. Closing will terminate it immediately.</p>
        <div class="modal-buttons">
          <button class="btn-secondary" id="close-confirm-cancel">Cancel</button>
          <button class="btn-danger" id="close-confirm-ok">Close anyway</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('#close-confirm-cancel').onclick = () => cleanup(false);
    overlay.querySelector('#close-confirm-ok').onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  });
}

function showRestartConfirmDialog() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Restart DeepSteve?</h2>
      <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:16px;">This will restart the server and reload the page. Running agents will be interrupted but sessions will be restored.</p>
      <div class="modal-buttons">
        <button class="btn-secondary" id="restart-confirm-cancel">Cancel</button>
        <button class="btn-primary" id="restart-confirm-ok">Restart</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let cleaned = false;
  const cleanup = (result) => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    resolve(result);
  };
  overlay.querySelector('#restart-confirm-cancel').onclick = () => cleanup(false);
  overlay.querySelector('#restart-confirm-ok').onclick = () => cleanup(true);
  overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
  };
  document.addEventListener('keydown', onKey);

  return { promise, dismiss: cleanup };
}

function showReloadOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cursor = 'default';
  overlay.innerHTML = `
    <div style="text-align:center;">
      <div class="reload-spinner"></div>
      <div style="color:var(--ds-text-bright);font-size:16px;font-weight:600;margin-top:16px;">Restarting...</div>
    </div>`;
  document.body.appendChild(overlay);
}

function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.type === 'mod-tab') {
    // Mod tabs: no PTY/WS to clean up
    if (session.resizeObserver) session.resizeObserver.disconnect();
    session.container.remove();
  } else {
    // Tell server to close this client's connection to the shell.
    // If no other clients are connected, the server kills the shell immediately.
    // If other clients remain, the shell stays alive for them.
    try { session.ws.sendJSON({ type: 'close-session' }); } catch {}

    if (session.resizeObserver) session.resizeObserver.disconnect();
    session.ws.close();
    session.term.dispose();
    session.container.remove();
  }

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
      ActiveTab.clear();
      ModManager.notifyActiveSessionChanged(null);
    }
  }

  updateEmptyState();

  // Notify mods of session list change
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Send a session to another browser window.
 * Like killSession() but does NOT send DELETE to server — the shell stays alive
 * and the target window adopts it via createSession().
 */
async function sendToWindow(id, targetWindowId) {
  const session = sessions.get(id);
  if (!session) return;

  // Send session data and wait for ack from target window
  try {
    await WindowManager.sendSessionToWindow(targetWindowId, {
      id,
      cwd: session.cwd,
      name: session.name
    });
  } catch (err) {
    // Target window didn't ack — keep the session
    console.warn(`Send to window failed: ${err.message}. Keeping session.`);
    return;
  }

  // Ack received — clean up locally (no server DELETE — shell stays alive for 30s grace period)
  if (session.resizeObserver) session.resizeObserver.disconnect();
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
      ActiveTab.clear();
      ModManager.notifyActiveSessionChanged(null);
    }
  }

  updateEmptyState();
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
    // Tell server so it persists across tab close/restore (skip for mod tabs — no WS)
    if (session.ws) session.ws.sendJSON({ type: 'rename', name });
    ModManager.notifySessionsChanged(getSessionList());
  });
}

/**
 * Quick new session in same repo as active session
 */
function quickNewSession() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd() || '~';
  createSession(cwd, null, true, { agentType: getDefaultAgentType() });
}

/** Get the default agent type from cached settings */
function getDefaultAgentType() {
  // Cached from /api/agents fetch at init
  return window.__deepsteveDefaultAgent || 'claude';
}

/**
 * Initialize the engines dropdown (shown when multiple agents are enabled).
 * Sets up the document-level click-to-close listener once, then builds the UI.
 */
function initEnginesDropdown() {
  document.addEventListener('click', () => {
    document.getElementById('engines-menu')?.classList.remove('open');
  });
  refreshEnginesDropdown();
}

/**
 * Rebuild the engines dropdown UI. Safe to call multiple times —
 * clone-replaces the button to clear stale event listeners.
 */
function refreshEnginesDropdown() {
  const agents = window.__deepsteveAgents || [];
  const enabledAgents = agents.filter(a => a.enabled);

  const dropdown = document.getElementById('engines-dropdown');
  const oldBtn = document.getElementById('engines-btn');
  const menu = document.getElementById('engines-menu');

  if (enabledAgents.length <= 1) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.style.display = 'flex';

  // Clone-replace button to clear old event listeners
  const btn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(btn);

  // Build menu items
  menu.innerHTML = enabledAgents.map(a => {
    const isDefault = a.id === window.__deepsteveDefaultAgent;
    return `<div class="dropdown-item ${isDefault ? 'active' : 'clickable'}" data-agent="${a.id}">${a.name}${isDefault ? ' ✓' : ''}</div>`;
  }).join('');

  // Update button text (short name by default, full name on hover)
  const currentAgent = agents.find(a => a.id === window.__deepsteveDefaultAgent);
  btn.textContent = currentAgent?.shortName || currentAgent?.name || 'Engine';
  btn.title = currentAgent?.name || 'Engine';

  btn.addEventListener('mouseenter', () => {
    const a = agents.find(a => a.id === window.__deepsteveDefaultAgent);
    btn.textContent = a?.name || 'Engine';
  });
  btn.addEventListener('mouseleave', () => {
    const a = agents.find(a => a.id === window.__deepsteveDefaultAgent);
    btn.textContent = a?.shortName || a?.name || 'Engine';
  });

  // Handle clicks on menu items
  menu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const agentId = item.dataset.agent;
      window.__deepsteveDefaultAgent = agentId;
      menu.querySelectorAll('.dropdown-item').forEach(i => {
        const a = agents.find(ag => ag.id === i.dataset.agent);
        const isSelected = i.dataset.agent === agentId;
        i.textContent = (a?.name || '') + (isSelected ? ' ✓' : '');
      });
      const newDefault = agents.find(a => a.id === agentId);
      btn.textContent = newDefault?.name || 'Engine';
      btn.title = newDefault?.name || 'Engine';
      menu.classList.remove('open');
    });
  });

  // Toggle dropdown
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
}

/**
 * Show dropdown menu for new tab options (recent repos + actions)
 */
function showNewTabMenu(e) {
  // Remove any existing menu
  document.querySelector('.new-tab-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'new-tab-menu context-menu';

  const agents = window.__deepsteveAgents || [];
  const enabledAgents = agents.filter(a => a.enabled);
  const currentAgent = getDefaultAgentType();

  // Build agent submenu item (only if multiple enabled)
  let html = '';
  if (enabledAgents.length > 1) {
    const currentAgentName = agents.find(a => a.id === currentAgent)?.name || 'Claude Code';
    html += `<div class="context-menu-item context-menu-has-submenu" id="agent-submenu-trigger">Agent: ${currentAgentName} <span class="context-menu-arrow"></span></div>`;
  }

  // Build recent dirs section
  const recentDirs = SessionStore.getRecentDirs();
  if (recentDirs.length > 0) {
    html += '<div class="context-menu-header">Recent</div>';
    // Disambiguate duplicate leaf names by appending parent dir
    const leafCounts = {};
    for (const d of recentDirs) {
      const leaf = d.path.split('/').pop();
      leafCounts[leaf] = (leafCounts[leaf] || 0) + 1;
    }
    for (const d of recentDirs) {
      const parts = d.path.split('/');
      const leaf = parts.pop();
      const label = leafCounts[leaf] > 1 && parts.length > 0
        ? `${leaf} (${parts.pop()})`
        : leaf;
      html += `<div class="context-menu-item" data-action="recent" data-path="${d.path.replace(/"/g, '&quot;')}" title="${d.path.replace(/"/g, '&quot;')}">${label}</div>`;
    }
    html += '<div class="context-menu-separator"></div>';
  }
  html += `
    <div class="context-menu-item" data-action="worktree">New worktree...</div>
    <div class="context-menu-item" data-action="repo">Change repo...</div>
  `;

  // Add mod tab items
  const modTabItems = ModManager.getNewTabItems();
  if (modTabItems.length > 0) {
    html += '<div class="context-menu-separator"></div>';
    for (const item of modTabItems) {
      html += `<div class="context-menu-item" data-action="mod-tab" data-mod-id="${item.modId}">${item.label}</div>`;
    }
  }

  menu.innerHTML = html;

  // Set up agent submenu
  const agentTrigger = menu.querySelector('#agent-submenu-trigger');
  let submenu = null;
  if (agentTrigger) {
    const showSubmenu = () => {
      if (submenu) return;
      submenu = document.createElement('div');
      submenu.className = 'context-menu context-submenu';
      submenu.innerHTML = enabledAgents.map(a => {
        const isSelected = a.id === getDefaultAgentType();
        return `<div class="context-menu-item" data-agent="${a.id}">${isSelected ? '&#10003; ' : '&nbsp;&nbsp; '}${a.name}</div>`;
      }).join('');
      // Append to body (not agentTrigger) to avoid overflow clipping from .new-tab-menu
      document.body.appendChild(submenu);

      // Position next to trigger
      const triggerRect = agentTrigger.getBoundingClientRect();
      submenu.style.left = (triggerRect.right + 2) + 'px';
      submenu.style.top = triggerRect.top + 'px';
      const subRect = submenu.getBoundingClientRect();
      if (subRect.right > window.innerWidth) {
        submenu.style.left = (triggerRect.left - subRect.width - 2) + 'px';
      }
      if (subRect.bottom > window.innerHeight) {
        submenu.style.top = (window.innerHeight - subRect.height - 8) + 'px';
      }

      submenu.addEventListener('mouseleave', delayedHideSubmenu);
      submenu.addEventListener('click', (ev) => {
        const item = ev.target.closest('.context-menu-item');
        if (!item) return;
        ev.stopPropagation();
        const agentId = item.dataset.agent;
        window.__deepsteveDefaultAgent = agentId;
        const newName = agents.find(a => a.id === agentId)?.name || 'Claude Code';
        agentTrigger.innerHTML = `Agent: ${newName} <span class="context-menu-arrow"></span>`;
        initEnginesDropdown();
        hideSubmenu();
      });
    };
    const hideSubmenu = () => {
      if (submenu) { submenu.remove(); submenu = null; }
    };
    const delayedHideSubmenu = () => {
      setTimeout(() => {
        if (submenu && !submenu.matches(':hover') && !agentTrigger.matches(':hover')) {
          hideSubmenu();
        }
      }, 100);
    };
    agentTrigger.addEventListener('mouseenter', showSubmenu);
    agentTrigger.addEventListener('mouseleave', delayedHideSubmenu);
    agentTrigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      submenu ? hideSubmenu() : showSubmenu();
    });
  }

  // Position below the dropdown arrow button
  const btn = e.target.closest('#new-btn-dropdown') || e.target.closest('#new-btn-group');
  const rect = btn.getBoundingClientRect();
  const isVertical = document.getElementById('app-container').classList.contains('vertical-layout');

  if (isVertical) {
    menu.style.left = (rect.right + 4) + 'px';
    menu.style.top = rect.top + 'px';
  } else {
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
  }

  document.body.appendChild(menu);

  // Adjust if off-screen
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - menuRect.width - 8) + 'px';
  }
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - menuRect.height - 8) + 'px';
  }

  // Handle selection
  const selectItem = async (ev) => {
    const item = ev.target.closest('.context-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    if (!action) return; // ignore clicks on items without actions (e.g. agent submenu trigger)
    menu.remove();
    if (submenu) submenu.remove();
    cleanup();
    if (action === 'recent') {
      createSession(item.dataset.path, null, true, { agentType: getDefaultAgentType() });
    } else if (action === 'worktree') {
      await promptWorktreeSession();
    } else if (action === 'repo') {
      await promptRepoSession();
    } else if (action === 'mod-tab') {
      createModTab(item.dataset.modId);
    } else if (action === 'opencode') {
      const active = activeId && sessions.get(activeId);
      const cwdPath = active?.cwd || SessionStore.getLastCwd() || '~';
      createSession(cwdPath, null, true, { agentType: 'opencode' });
    }
  };

  menu.addEventListener('click', selectItem);

  // Close on click outside
  const cleanup = () => {
    document.removeEventListener('mousedown', closeHandler);
  };
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target) && !(submenu && submenu.contains(ev.target)) && ev.target !== btn) {
      menu.remove();
      if (submenu) submenu.remove();
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
        createSession(cwd, null, true, { worktree: name, agentType: getDefaultAgentType() });
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
  createSession(cwd, null, true, { agentType: getDefaultAgentType() });
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

  // Collect candidate paths for repo selector
  const sessionCwds = [...sessions.values()].map(s => s.cwd).filter(Boolean);
  const recentCwds = SessionStore.getRecentDirs().map(d => d.path);
  const allCwds = [...new Set([cwd, ...sessionCwds, ...recentCwds])];

  // Show modal immediately with loading state
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width: 520px;">
      <h2>Pick a GitHub Issue</h2>
      <div class="issue-repo-selector" style="display:none;">
        <select class="issue-repo-select" id="issue-repo-select">
          <option value="${escapeHtml(gitRoot)}">${escapeHtml(gitRoot.split('/').pop())}</option>
        </select>
      </div>
      <div class="issue-list">
        <div class="issue-loading">
          <span class="issue-loading-text">Loading issues…</span>
        </div>
      </div>
      <div class="modal-buttons">
        <button class="btn-secondary" id="issue-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const closeIssuePicker = () => overlay.remove();
  overlay.querySelector('#issue-cancel').onclick = closeIssuePicker;
  overlay.onclick = (e) => { if (e.target === overlay) closeIssuePicker(); };
  const onEscIssuePicker = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeIssuePicker(); } };
  document.addEventListener('keydown', onEscIssuePicker);
  new MutationObserver((_, obs) => { if (!overlay.parentNode) { document.removeEventListener('keydown', onEscIssuePicker); obs.disconnect(); } }).observe(document.body, { childList: true });

  let issues, wandPlanMode, wandPromptTemplate, hasMore;
  let selectedIssue = null;
  let currentPage = 1;
  let loadingMore = false;

  function bindIssueItem(item) {
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
    const link = item.querySelector('.issue-link');
    if (link) link.addEventListener('click', e => e.stopPropagation());
  }

  function renderIssues(issuesToRender) {
    const list = overlay.querySelector('.issue-list');
    if (!list) return;
    for (const issue of issuesToRender) {
      const el = document.createElement('div');
      el.className = 'issue-item';
      el.dataset.number = issue.number;
      el.innerHTML = `
        <span class="issue-number">#${issue.number}</span>
        <div class="issue-info">
          <div class="issue-title">${escapeHtml(issue.title)}</div>
          ${issue.labels && issue.labels.length > 0 ? `
            <div class="issue-labels">${issue.labels.map(l => `<span class="issue-label">${escapeHtml(l.name)}</span>`).join('')}</div>
          ` : ''}
        </div>
        <a class="issue-link" href="${escapeHtml(issue.url)}" target="_blank" title="Open on GitHub">&#8599;</a>
      `;
      list.appendChild(el);
      bindIssueItem(el);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    currentPage++;
    try {
      const res = await fetch(`/api/issues?cwd=${encodeURIComponent(gitRoot)}&page=${currentPage}`);
      if (!res.ok) return;
      const data = await res.json();
      issues = issues.concat(data.issues);
      hasMore = data.hasMore;
      renderIssues(data.issues);
    } finally {
      loadingMore = false;
    }
  }

  function startIssue() {
    if (!selectedIssue) return;
    overlay.remove();

    const body = selectedIssue.body ? selectedIssue.body.slice(0, 2000) : '(no description)';
    const labels = selectedIssue.labels?.map(l => l.name).join(', ') || 'none';
    const vars = {
      number: selectedIssue.number,
      title: selectedIssue.title,
      labels,
      url: selectedIssue.url,
      body,
    };
    const prompt = wandPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');

    createSession(gitRoot, null, true, {
      worktree: 'github-issue-' + selectedIssue.number,
      initialPrompt: prompt,
      planMode: wandPlanMode,
      name: truncateTitle(`#${selectedIssue.number} ${selectedIssue.title}`),
      agentType: getDefaultAgentType()
    });
  }

  // Fetch issues and settings in background, update modal when done
  async function fetchAndRender() {
    try {
      const [issuesRes, settingsData] = await Promise.all([
        fetch('/api/issues?cwd=' + encodeURIComponent(gitRoot)),
        fetch('/api/settings').then(r => r.json())
      ]);
      if (!issuesRes.ok) throw new Error((await issuesRes.json()).error || 'Failed to fetch issues');
      const issuesData = await issuesRes.json();
      issues = issuesData.issues;
      hasMore = issuesData.hasMore;
      wandPlanMode = settingsData.wandPlanMode !== undefined ? settingsData.wandPlanMode : true;
      wandPromptTemplate = settingsData.wandPromptTemplate || '';
      if (settingsData.maxIssueTitleLength) maxIssueTitleLength = settingsData.maxIssueTitleLength;

      // Modal may have been dismissed while loading
      if (!overlay.parentNode) return;

      const list = overlay.querySelector('.issue-list');
      if (issues.length === 0) {
        list.outerHTML = '<div class="issue-empty">No open issues found</div>';
      } else {
        list.innerHTML = '';
        renderIssues(issues);
        list.addEventListener('scroll', () => {
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
            loadMore();
          }
        });
        const buttons = overlay.querySelector('.modal-buttons');
        const startBtn = document.createElement('button');
        startBtn.className = 'btn-primary';
        startBtn.id = 'issue-start';
        startBtn.disabled = true;
        startBtn.textContent = 'Start';
        startBtn.onclick = startIssue;
        buttons.appendChild(startBtn);
      }
    } catch (e) {
      if (!overlay.parentNode) return;
      const list = overlay.querySelector('.issue-list');
      if (list) {
        list.outerHTML = `
          <div class="issue-error">
            <div class="issue-error-message">${escapeHtml(e.message)}</div>
            <button class="issue-retry" id="issue-retry">Retry</button>
          </div>`;
        overlay.querySelector('#issue-retry').onclick = () => {
          const errorDiv = overlay.querySelector('.issue-error');
          if (errorDiv) {
            errorDiv.outerHTML = '<div class="issue-list"><div class="issue-loading"><span class="issue-loading-text">Loading issues…</span></div></div>';
          }
          fetchAndRender();
        };
      }
    }
  }

  fetchAndRender();

  // Wire repo selector change handler
  const repoSelect = overlay.querySelector('#issue-repo-select');
  repoSelect.addEventListener('change', () => {
    gitRoot = repoSelect.value;
    currentPage = 1;
    issues = null;
    selectedIssue = null;
    hasMore = false;
    // Replace issue list (or error/empty state) with fresh loading spinner
    const existing = overlay.querySelector('.issue-list') || overlay.querySelector('.issue-empty') || overlay.querySelector('.issue-error');
    if (existing) {
      const fresh = document.createElement('div');
      fresh.className = 'issue-list';
      fresh.innerHTML = '<div class="issue-loading"><span class="issue-loading-text">Loading issues…</span></div>';
      existing.replaceWith(fresh);
    }
    const startBtn = overlay.querySelector('#issue-start');
    if (startBtn) startBtn.remove();
    fetchAndRender();
  });

  // Populate repo dropdown asynchronously
  fetch('/api/git-roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: allCwds })
  }).then(r => r.json()).then(data => {
    if (!overlay.parentNode || !data.roots || data.roots.length <= 1) return;
    repoSelect.innerHTML = data.roots.map(r =>
      `<option value="${escapeHtml(r.root)}"${r.root === gitRoot ? ' selected' : ''}>${escapeHtml(r.name)}</option>`
    ).join('');
    overlay.querySelector('.issue-repo-selector').style.display = '';
  }).catch(() => {});
}

/**
 * Main initialization
 */
async function init() {
  // Cache available agents and default agent setting for new-tab menu and settings
  fetch('/api/agents').then(r => r.json()).then(data => { 
    window.__deepsteveAgents = data.agents || []; 
    window.__deepsteveDefaultAgent = data.defaultAgent || 'claude';
    initEnginesDropdown();
  }).catch(() => {});
  fetch('/api/settings').then(r => r.json()).then(s => { window.__deepsteveDefaultAgent = s.defaultAgent || 'claude'; }).catch(() => {});

  // Initialize layout manager
  LayoutManager.init();

  // Initialize tab scroll arrows
  initTabArrows();

  // Initialize mod system
  ModManager.init({
    getSessions: getSessionList,
    getActiveSessionId: () => activeId,
    focusSession: switchTo,
    createSession: (cwd, opts) => createSession(cwd, null, true, opts),
    killSession: async (id, opts) => {
      if (opts?.force || await confirmCloseSession(id)) killSession(id);
    },
    closeModTabs: (modId) => {
      for (const [id, s] of sessions) {
        if (s.type === 'mod-tab' && s.modId === modId) killSession(id);
      }
    },
  });

  // File drag-and-drop upload
  initFileDrop({
    getActiveSession: () => {
      if (!activeId) return null;
      const s = sessions.get(activeId);
      if (!s) return null;
      return { id: activeId, cwd: s.cwd, container: s.container, ws: s.ws };
    }
  });

  // Auto-reload browser when server restarts (restart.sh, node --watch, etc.)
  initLiveReload({
    windowId: getWindowId(),
    onMessage: async (msg) => {
      if (msg.type === 'theme') applyTheme(msg.css || '');
      if (msg.type === 'settings') applySettings(msg);
      if (msg.type === 'open-session') {
        // Server created a session (e.g. via /api/start-issue) — open a tab for it
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createSession(msg.cwd, msg.id, false, { name: msg.name, allowDuplicate: true });
      }
    },
    onShowRestartConfirm: () => showRestartConfirmDialog(),
    onShowReloadOverlay: () => showReloadOverlay()
  });

  // Initialize Cmd hold mode (tab switching, new/close tab — capture-phase listeners, off by default)
  initCmdHoldMode({
    getOrderedTabIds: () => [...document.querySelectorAll('#tabs-list .tab')].map(t => t.id.replace('tab-', '')),
    getActiveTabId: () => activeId,
    switchToTab: switchTo,
    createTab: () => quickNewSession(),
    closeTab: () => { if (activeId) confirmCloseSession(activeId).then(ok => { if (ok) killSession(activeId) }) }
  });

  // Load settings before creating any terminals (prevents color flash, applies title length)
  try {
    const settingsData = await fetch('/api/settings').then(r => r.json());
    if (settingsData.themeCSS) {
      applyTheme(settingsData.themeCSS);
    }
    applySettings(settingsData);
  } catch {}

  // Load available mods (creates Mods button, auto-activates persisted mod)
  await ModManager.loadAvailableMods();

  // Split button: + creates tab, ▾ opens dropdown menu
  document.getElementById('new-btn').addEventListener('click', () => quickNewSession());
  document.getElementById('new-btn-dropdown').addEventListener('click', (e) => showNewTabMenu(e));
  document.getElementById('issue-btn').addEventListener('click', () => showIssuePicker());
  document.getElementById('empty-state-btn')?.addEventListener('click', () => quickNewSession());

  // Check if this is an existing tab BEFORE starting heartbeat (which creates window ID)
  const isExistingTab = WindowManager.hasExistingWindowId();
  console.log('[init] isExistingTab:', isExistingTab);
  console.log('[init] sessionStorage windowId:', sessionStorage.getItem(nsKey('deepsteve-window-id')));
  console.log('[init] localStorage:', localStorage.getItem(nsKey('deepsteve')));

  // Check for legacy storage format and migrate
  const legacySessions = SessionStore.migrateFromLegacy();

  // Now get/create window ID and start heartbeat
  const windowId = WindowManager.getWindowId();

  // Register sessions provider so heartbeats include session metadata
  WindowManager.setSessionsProvider(() =>
    [...sessions.entries()].map(([id, s]) => ({ id, name: s.name || getDefaultTabName(s.cwd) }))
  );

  // Handle sessions sent from other windows
  WindowManager.onSessionReceived((session) => {
    createSession(session.cwd, session.id, false, { name: session.name, allowDuplicate: true });
  });

  WindowManager.startHeartbeat();

  // TabSessions (sessionStorage) is the authoritative per-tab source.
  // It survives page refresh and doesn't depend on localStorage window-ID mapping.
  const tabSessions = TabSessions.get();
  console.log('[init] TabSessions:', tabSessions);

  if (isExistingTab && tabSessions.length > 0) {
    // Existing tab with sessions saved in sessionStorage — restore them
    console.log('[init] Restoring from TabSessions');
    restoreSessions(tabSessions);
  } else if (isExistingTab) {
    // Existing tab but TabSessions is empty — try localStorage as fallback
    const savedSessions = SessionStore.getWindowSessions(windowId);
    console.log('[init] windowId:', windowId, 'savedSessions (fallback):', savedSessions);
    if (savedSessions.length > 0) {
      console.log('[init] Restoring from localStorage fallback');
      restoreSessions(savedSessions);
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
      restoreSessions(legacySessions);
    } else {
      // Check for orphaned windows
      const orphanedWindows = await WindowManager.listOrphanedWindows();

      if (orphanedWindows.length > 0) {
        const result = await showWindowRestoreModal(orphanedWindows);

        if (result.action === 'restore') {
          // Claim the selected window's sessions
          const claimed = WindowManager.claimWindow(result.window.windowId);
          for (const sess of claimed) {
            TabSessions.add(sess);
          }
          restoreSessions(claimed, { allowDuplicate: false });
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
