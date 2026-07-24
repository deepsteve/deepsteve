/**
 * Main application entry point
 */

import { initClientLog } from './client-log.js';
// Before anything initializes: wrap fetch + install global error handlers so
// failures are beaconed to the server log. (Imports are hoisted, so this runs
// after module-scope code but before every init call and fetch below —
// 2026-07-15: hours of silent fetch failures were invisible in every log.)
initClientLog();

import { SessionStore } from './session-store.js';
import { SessionStores, getTabSessions } from './session-stores.js';
import { WindowManager } from './window-manager.js';
import { TabManager, getDefaultTabName, initTabArrows } from './tab-manager.js';
import { createTerminal, setupTerminalIO, fitTerminal, resizeTerminal, observeTerminalResize, measureTerminalSize, updateTerminalTheme, installTerminalWheelGuard } from './terminal.js';
import { createWebSocket } from './ws-client.js';
import { createConnectionTracker } from './connection-status.js';
import { showDirectoryPicker } from './dir-picker.js';
import { showSessionRestoreModal } from './session-restore-modal.js';
import { LayoutManager } from './layout-manager.js';
import { initLiveReload } from './live-reload.js';
import { ModManager } from './mod-manager.js';
import { initFileDrop } from './file-drop.js';
import { init as initCmdHoldMode, setEnabled as setCmdHoldModeEnabled, setHoldMs as setCmdHoldModeHoldMs } from './cmd-tab-switch.js';
import { init as initCommandPalette, setEnabled as setCommandPaletteEnabled, setShortcut as setCommandPaletteShortcut } from './command-palette.js';
import { init as initShortcutsHelp, setEnabled as setShortcutsHelpEnabled, setShortcut as setShortcutsHelpShortcut, open as openShortcutsHelp } from './shortcuts-help.js';
import { init as initProgressBar, start as progressStart, done as progressDone } from './progress-bar.js';
import { init as initHashCommands, beforeSend as hashCommandsBeforeSend, setWaitingForInput as setHashCommandsWaiting, setEnabled as setHashCommandsEnabled } from './hash-commands.js';
import { init as initOverviewMode, setEnabled as setOverviewModeEnabled, setShortcut as setOverviewModeShortcut, setDefaultLayout as setOverviewDefaultLayout, toggle as toggleOverviewMode, isOverviewActive, updateFocus as updateOverviewFocus, onTabsReordered as onOverviewTabsReordered, syncToContext as syncOverviewToContext } from './overview-mode.js';
import { init as initTerminalSearch, attachSearchAddon, closeIfOpen as closeTerminalSearch } from './terminal-search.js';
import { init as initContextViews, setEnabled as setContextViewsEnabled, applyFilter as refreshContextFilter, requestNewTabInContext, resolveContextRepo, chooseContextDir, setContexts as applyServerContexts, setActiveContext as setActiveContextFromPanel, getActiveContextId, getActiveContextInfo, orderRecentDirsByContext, activeContextIsEmpty, noteActiveTab, revealTabContext, showToast } from './context-views.js';
import { nsKey } from './storage-namespace.js';
import { formatShortcut } from './shortcuts.js';
import { init as initWakeWatch } from './wake-watch.js';
import { openNewWindow, isFreshRequest } from './new-window.js';

// Configuration
let maxIssueTitleLength = 25;

function truncateTitle(title) {
  if (title.length <= maxIssueTitleLength) return title;
  return title.slice(0, maxIssueTitleLength) + '…';
}

// Active sessions in memory
const sessions = new Map();
let activeId = null;

// Cached automations for the new-tab dropdown (refreshed on load + modal close)
let cachedAutomations = [];
function refreshAutomationsCache() {
  fetch('/api/automations').then(r => r.json()).then(data => {
    cachedAutomations = data.automations || [];
    refreshAutomationsDropdown();
  }).catch(() => {});
}

let _automationsDropdownInited = false;
function refreshAutomationsDropdown() {
  const dropdown = document.getElementById('automations-dropdown');
  const menu = document.getElementById('automations-menu');
  if (!dropdown || !menu) return;

  if (!_automationsDropdownInited) {
    _automationsDropdownInited = true;
    document.addEventListener('click', () => {
      document.getElementById('automations-menu')?.classList.remove('open');
    });
  }

  if (cachedAutomations.length === 0) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.style.display = 'flex';

  // Clone-replace button to clear old event listeners
  const oldBtn = document.getElementById('automations-btn');
  const btn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(btn);

  // Build menu items
  let html = '';
  for (const auto of cachedAutomations) {
    const icon = auto.icon || '\u26A1';
    html += `<div class="dropdown-item clickable" data-automation-id="${auto.id}">${icon} ${auto.name}</div>`;
  }
  html += '<div style="height:1px;background:var(--ds-border);margin:4px 0;"></div>';
  html += '<div class="dropdown-item clickable" data-action="manage">Manage Automations\u2026</div>';
  menu.innerHTML = html;

  // Handle item clicks
  menu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', async () => {
      menu.classList.remove('open');
      const automationId = item.dataset.automationId;
      if (automationId) {
        try {
          await fetch('/api/start-automation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ automationId, windowId: getWindowId() }),
          });
        } catch (err) {
          console.error('Failed to start automation:', err);
        }
      } else if (item.dataset.action === 'manage') {
        document.getElementById('mods-btn')?.click();
      }
    });
  });

  // Toggle dropdown
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
}

// Dedup set for browser-eval/console requests (each tab processes once)
const processedBrowserRequests = new Set();

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
  const hasActiveSessions = [...sessions.values()].some(s => s.type !== 'mod-tab' && s.type !== 'display-tab' && !s.waitingForInput);
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
  if (settings.commandPaletteEnabled !== undefined) {
    setCommandPaletteEnabled(settings.commandPaletteEnabled);
  }
  if (settings.commandPaletteShortcut !== undefined) {
    setCommandPaletteShortcut(settings.commandPaletteShortcut);
  }
  if (settings.shortcutsHelpEnabled !== undefined) {
    setShortcutsHelpEnabled(settings.shortcutsHelpEnabled);
  }
  if (settings.shortcutsHelpShortcut !== undefined) {
    setShortcutsHelpShortcut(settings.shortcutsHelpShortcut);
  }
  if (settings.hashCommandsEnabled !== undefined) {
    setHashCommandsEnabled(settings.hashCommandsEnabled);
  }
  if (settings.overviewModeEnabled !== undefined) {
    setOverviewModeEnabled(settings.overviewModeEnabled);
  }
  if (settings.overviewModeShortcut !== undefined) {
    setOverviewModeShortcut(settings.overviewModeShortcut);
  }
  if (settings.overviewDefaultLayout !== undefined) {
    setOverviewDefaultLayout(settings.overviewDefaultLayout);
  }
  if (settings.contextViewsEnabled !== undefined) {
    setContextViewsEnabled(settings.contextViewsEnabled);
  }
  if (settings.symlinkWorktreeSettings !== undefined) {
    const el = document.querySelector('#symlink-worktree-settings');
    if (el) el.checked = settings.symlinkWorktreeSettings;
  }
  if (settings.recentSessionsLimit !== undefined) {
    const el = document.querySelector('#recent-sessions-limit');
    if (el) el.value = settings.recentSessionsLimit;
  }
  // Enabled agents + custom config profiles (#537) aren't in the broadcast payload
  // (broadcast:false), so re-fetch /api/agents to pick up changes made in another window
  // and keep the pickers + badge mapping current. (`which` probes are fast.)
  fetch('/api/agents').then(r => r.json()).then(data => {
    window.__deepsteveAgents = data.agents || [];
    const stillExists = window.__deepsteveAgents.some(a => a.id === window.__deepsteveDefaultAgent);
    if (!stillExists) window.__deepsteveDefaultAgent = data.defaultAgent || 'claude';
    if (typeof refreshEnginesDropdown === 'function') refreshEnginesDropdown();
  }).catch(() => {});
}

// When the browser tab regains visibility, clear its notification state.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeId) {
    clearNotification(activeId);
  }
});
window.addEventListener('focus', () => {
  if (activeId) clearNotification(activeId);
});

function updateTitle() {
  const count = [...sessions.values()].filter(s => s.hasUnseenActivity).length;
  document.title = count > 0 ? `(${count}) deepsteve` : 'deepsteve';
}

// The #empty-state welcome screen covers the terminal area both when there are no
// tabs at all AND when the active context has no matching tabs (#534) — the latter
// reuses the same nice screen instead of a separate bland overlay. The .context-empty
// class (CSS) lifts it above the still-alive stale terminal and drops the cross-repo
// config shortcuts (they aren't context-scoped).
function updateEmptyState() {
  const el = document.getElementById('empty-state');
  if (!el) return;
  const noSessions = sessions.size === 0;
  const contextEmpty = !noSessions && activeContextIsEmpty();
  const show = noSessions || contextEmpty;
  const wasHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  el.classList.toggle('context-empty', contextEmpty);
  // Covering a live terminal? Move focus onto the button so keystrokes don't leak
  // into the covered terminal's still-focused hidden textarea.
  if (show && wasHidden && !noSessions) document.getElementById('empty-state-btn')?.focus();
}

// Ordered tab ids from the strip. getAllTabIds() is context-filter unaware (use
// where the full set matters: applying the context filter). getVisibleTabIds()
// drops tabs the active context hides — so tab navigation stays in-context —
// and equals getAllTabIds() whenever no context filter is active (the "All"
// view / disabled feature un-hide every tab).
const getAllTabIds = () =>
  [...document.querySelectorAll('#tabs-list .tab')].map(t => t.id.replace('tab-', ''));
const getVisibleTabIds = () =>
  [...document.querySelectorAll('#tabs-list .tab:not(.context-hidden)')].map(t => t.id.replace('tab-', ''));

// --- Recent sessions (issue #533): a server-side ring buffer of the last N
// session configs, restorable from any browser/window/tab. See renderEmptyStateRecent
// (empty-state buttons) and restoreRecentSession (the restore action).
let recentSessions = [];

function relativeTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderEmptyStateRecent() {
  const container = document.getElementById('empty-state-recent');
  if (!container) return;
  container.innerHTML = '';
  for (const r of recentSessions) {
    const btn = document.createElement('button');
    btn.className = 'recent-session-btn';
    const label = r.name || getDefaultTabName(r.cwd) || r.cwd || 'session';
    btn.textContent = label;
    const parts = [r.cwd, r.agentType, relativeTime(r.updatedAt)].filter(Boolean);
    btn.title = `Restore ${label}\n${parts.join(' · ')}`;
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      restoreRecentSession(r.key);
    };
    container.appendChild(btn);
  }
}

async function loadRecentSessions() {
  try {
    const resp = await fetch('/api/recent-sessions');
    const data = await resp.json();
    recentSessions = data.sessions || [];
    renderEmptyStateRecent();
  } catch {}
}

// Restore a recent session: the server pre-seeds savedState under a fresh id, then
// we connect to it — the normal reconnect path resumes the conversation (with the
// server's 5s resume-fail → fork fallback). The restored tab then behaves like any
// live tab (claudeSessionId tracked into the per-tab session list, persisted to both stores).
async function restoreRecentSession(key) {
  let r;
  try {
    const resp = await fetch(`/api/recent-sessions/${encodeURIComponent(key)}/restore`, { method: 'POST' });
    if (!resp.ok) return;
    r = await resp.json();
  } catch { return; }
  if (!r || !r.id) return;
  TabManager.addPlaceholderTab(r.id, r.name || getDefaultTabName(r.cwd));
  updateEmptyState();
  createSession(r.cwd, r.id, false, { name: r.name, agentType: r.agentType, allowDuplicate: true });
}

// Load recent sessions on startup. init()'s landing decision (landWithNoTabs) awaits
// this rather than racing it — whether the empty state has anything on it is the whole
// question there.
const recentSessionsReady = loadRecentSessions();

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

/**
 * Notify listeners that the tab set changed. Fans out to the mod system and
 * re-applies the context-views filter (so newly added/removed tabs are
 * shown/hidden according to the active context).
 */
function notifyTabsChanged() {
  ModManager.notifySessionsChanged(getSessionList());
  refreshContextFilter();
  // refreshContextFilter() normally drives this via onContextViewApplied, but it
  // early-returns when context views are disabled — and a persisted grid still
  // has to come back once the restored tabs exist (#590). syncToContext() no-ops
  // when the grid already matches the active context, so the double call while
  // context views are on costs nothing.
  syncOverviewToContext();
}

// Expose session internals for mods that need direct terminal access (e.g. reparenting)
window.__deepsteve = {
  refreshAutomationsCache,
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

    // Classify each session into three states
    const thisTab = s => connectedIds.has(s.id);
    const otherWindow = s => !connectedIds.has(s.id) && (s.connectedClients || 0) > 0;
    // Sort: this-tab first, then other-window, then disconnected
    const stateOrder = s => thisTab(s) ? 0 : otherWindow(s) ? 1 : 2;
    const statusOrder = { active: 0, saved: 1, closed: 2 };
    allShells.sort((a, b) => {
      const orderDiff = stateOrder(a) - stateOrder(b);
      if (orderDiff !== 0) return orderDiff;
      return (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
    });

    const showAgentBadge = window.__deepsteveAgents?.length > 1;

    sessionsMenu.innerHTML = allShells.map(shell => {
      const isThisTab = thisTab(shell);
      const isOtherWindow = otherWindow(shell);
      const isClosed = shell.status === 'closed';
      const name = sessions.get(shell.id)?.name || shell.name || getDefaultTabName(shell.cwd);
      const staleness = !isThisTab && !isOtherWindow && shell.lastActivity ? formatRelativeTime(shell.lastActivity) : '';
      const statusText = isThisTab ? 'connected' : isOtherWindow ? 'other window' : (isClosed ? (staleness ? `closed ${staleness}` : 'closed') : (staleness || (shell.status === 'saved' ? 'saved' : 'not connected')));
      const statusClass = isThisTab ? 'active' : isOtherWindow ? 'other-window' : (isClosed ? 'closed' : '');
      const canClose = !isThisTab && !isOtherWindow;
      // Custom config profile (#537): a profile session is agentType 'claude' + a configDir;
      // label the tab with the profile's display name (mapped from the dir) so it's distinct
      // from a plain Claude session. Fall back to the dir's basename if the profile is gone.
      let agentLabel;
      if (shell.configDir) {
        const profile = (window.__deepsteveAgents || []).find(a => a.custom && a.configDir === shell.configDir);
        agentLabel = profile ? profile.name : (shell.configDir.split('/').filter(Boolean).pop() || 'Claude');
      } else {
        agentLabel = shell.agentType === 'opencode' ? 'OpenCode' : (shell.agentType ? shell.agentType.charAt(0).toUpperCase() + shell.agentType.slice(1) : '');
      }

      return `
        <div class="dropdown-item ${isThisTab ? 'connected' : 'clickable'} ${isClosed ? 'closed' : ''}" data-id="${shell.id}" data-cwd="${shell.cwd}" data-name="${escapeHtml(name)}"${isOtherWindow ? ' data-other-window="true"' : ''}>
          <div class="session-info">
            <span class="session-name">${name}${showAgentBadge && agentLabel ? ` <span class="session-agent-badge">${agentLabel}</span>` : ''}</span>
            <span class="session-status ${statusClass}">${statusText}</span>
          </div>
          ${canClose ? `<span class="session-close" data-id="${shell.id}"${isClosed ? ' data-closed="1"' : ''}>✕</span>` : ''}
        </div>
      `;
    }).join('');

    // Add "Clear disconnected" button at the top — only count truly disconnected
    // sessions. Closed tombstones are excluded: the endpoint never hard-deletes
    // (#561), so they wouldn't be affected by the button.
    const disconnectedCount = allShells.filter(s => !connectedIds.has(s.id) && (s.connectedClients || 0) === 0 && s.status !== 'closed').length;
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
        sessionsMenu.classList.remove('open');

        if (item.dataset.otherWindow) {
          // Find which window owns this session and ask it to focus
          const ownerWindow = WindowManager.getLiveWindows().find(w =>
            w.sessions.some(s => s.id === id)
          );
          if (ownerWindow) {
            WindowManager.focusSessionInWindow(ownerWindow.windowId, id);
          }
        } else {
          const cwd = item.dataset.cwd;
          const name = item.dataset.name || null;
          createSession(cwd, id, false, { name });
        }
      });
    });

    // Add close handlers
    sessionsMenu.querySelectorAll('.session-close').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!(await confirmCloseSession(id))) return;
        // ✕ on an already-closed row is the deliberate permanent delete — the
        // server only ever hard-forgets a session on an explicit ?forget=1 (#561).
        const forget = btn.dataset.closed === '1';
        await fetch(`/api/shells/${id}${forget ? '?forget=1' : ''}`, { method: 'DELETE' });
        await refreshSessionsDropdown();
      });
    });
  } catch (err) {
    sessionsMenu.innerHTML = '<div class="dropdown-empty">Error loading sessions</div>';
  }
}

// Settings modal
const settingsBtn = document.getElementById('settings-btn');

// --- Auto-update UI helpers ---
function setUpdateAvailableBadge(on) {
  if (!settingsBtn) return;
  settingsBtn.classList.toggle('update-available', !!on);
  settingsBtn.title = on ? 'Settings — update available' : 'Settings';
}

// Do an initial version fetch so the badge reflects the cached server state
// even before any WebSocket broadcast arrives.
fetch('/api/version').then(r => r.json()).then(data => {
  setUpdateAvailableBadge(!!data.updateAvailable);
}).catch(() => {});

let autoApplyToastEl = null;
let autoApplyCountdownTimer = null;
function hideAutoApplyToast() {
  if (autoApplyCountdownTimer) { clearInterval(autoApplyCountdownTimer); autoApplyCountdownTimer = null; }
  if (autoApplyToastEl) { autoApplyToastEl.remove(); autoApplyToastEl = null; }
}
function showAutoApplyToast(tag, deadline) {
  hideAutoApplyToast();
  autoApplyToastEl = document.createElement('div');
  autoApplyToastEl.className = 'auto-apply-toast';
  autoApplyToastEl.innerHTML = `
    <div class="auto-apply-toast-body">
      <strong>Updating to ${tag || 'latest'}</strong>
      <span class="auto-apply-toast-countdown">in <span id="auto-apply-remaining">…</span>s</span>
    </div>
    <div class="auto-apply-toast-actions">
      <button type="button" class="btn-secondary" id="auto-apply-cancel" style="font-size: 11px; padding: 4px 10px;">Cancel</button>
      <button type="button" class="btn-primary" id="auto-apply-now" style="font-size: 11px; padding: 4px 10px;">Update now</button>
    </div>
  `;
  document.body.appendChild(autoApplyToastEl);
  const remainingEl = autoApplyToastEl.querySelector('#auto-apply-remaining');
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remainingEl) remainingEl.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(autoApplyCountdownTimer);
      autoApplyCountdownTimer = null;
    }
  };
  tick();
  autoApplyCountdownTimer = setInterval(tick, 500);
  autoApplyToastEl.querySelector('#auto-apply-cancel').onclick = async () => {
    try {
      await fetch('/api/update/pending', { method: 'DELETE' });
    } catch {}
    hideAutoApplyToast();
  };
  autoApplyToastEl.querySelector('#auto-apply-now').onclick = async () => {
    try {
      await fetch('/api/update/curl-reinstall', { method: 'POST' });
    } catch {}
    // Server will broadcast version-applying → showReloadOverlay
  };
}

// Auto-cycle "switching soon" toast (#500). Driven by the action-required mod via the
// bridge: it owns the policy; this is a self-counting countdown UI that lives in the main
// window so it floats over the terminal you're looking at (not just the side panel).
let autoCycleToastEl = null;
let autoCycleCountdownTimer = null;
function hideAutoCycleToast() {
  if (autoCycleCountdownTimer) { clearInterval(autoCycleCountdownTimer); autoCycleCountdownTimer = null; }
  if (autoCycleToastEl) { autoCycleToastEl.remove(); autoCycleToastEl = null; }
}
function showAutoCycleToast({ name, seconds = 5, onExpire, onCancel } = {}) {
  hideAutoCycleToast();
  const deadline = Date.now() + seconds * 1000;
  let fired = false;
  const finish = (cb) => {
    if (fired) return;
    fired = true;
    hideAutoCycleToast();
    try { cb && cb(); } catch (e) { console.error('Auto-cycle toast callback error:', e); }
  };
  autoCycleToastEl = document.createElement('div');
  autoCycleToastEl.className = 'auto-apply-toast auto-cycle-toast';
  const safeName = (name || 'next tab').replace(/[<>&]/g, '');
  autoCycleToastEl.innerHTML = `
    <div class="auto-apply-toast-body">
      <strong>Switching to "${safeName}"</strong>
      <span class="auto-apply-toast-countdown">in <span class="auto-cycle-remaining">…</span>s</span>
    </div>
    <div class="auto-apply-toast-actions">
      <button type="button" class="btn-secondary auto-cycle-stay" style="font-size: 11px; padding: 4px 10px;">Stay</button>
      <button type="button" class="btn-primary auto-cycle-go" style="font-size: 11px; padding: 4px 10px;">Go now</button>
    </div>
  `;
  document.body.appendChild(autoCycleToastEl);
  const remainingEl = autoCycleToastEl.querySelector('.auto-cycle-remaining');
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remainingEl) remainingEl.textContent = remaining;
    if (remaining <= 0) finish(onExpire);
  };
  tick();
  autoCycleCountdownTimer = setInterval(tick, 250);
  autoCycleToastEl.querySelector('.auto-cycle-stay').onclick = () => finish(onCancel);
  autoCycleToastEl.querySelector('.auto-cycle-go').onclick = () => finish(onExpire);
}

settingsBtn?.addEventListener('click', async () => {
  const [settingsData, themesData, versionData, defaultsData, enginesData] = await Promise.all([
    fetch('/api/settings').then(r => r.json()),
    fetch('/api/themes').then(r => r.json()),
    fetch('/api/version').then(r => r.json()).catch(() => ({ current: '?', latest: null, updateAvailable: false })),
    fetch('/api/settings/defaults').then(r => r.json()).catch(() => ({})),
    fetch('/api/engines').then(r => r.json()).catch(() => ({ engines: [], current: 'node-pty' }))
  ]);
  const currentProfile = settingsData.shellProfile || '~/.zshrc';
  const currentMaxTitle = settingsData.maxIssueTitleLength || 25;
  const currentWandPlanMode = settingsData.wandPlanMode !== undefined ? settingsData.wandPlanMode : true;
  const currentWandTemplate = settingsData.wandPromptTemplate || defaultsData.wandPromptTemplate || '';
  const currentSymlinkWorktreeSettings = !!settingsData.symlinkWorktreeSettings;
  const currentCmdTabSwitch = !!settingsData.cmdTabSwitch;
  const currentCmdTabSwitchHoldMs = settingsData.cmdTabSwitchHoldMs !== undefined ? settingsData.cmdTabSwitchHoldMs : 1000;
  const currentCommandPaletteEnabled = settingsData.commandPaletteEnabled !== undefined ? settingsData.commandPaletteEnabled : true;
  const currentCommandPaletteShortcut = settingsData.commandPaletteShortcut || 'Meta+k';
  const currentShortcutsHelpEnabled = settingsData.shortcutsHelpEnabled !== undefined ? settingsData.shortcutsHelpEnabled : true;
  // A list, not a string (#549) — the default binds ⌘⇧? and ⌘/ so a browser Help
  // menu claiming ⌘⇧/ can't leave the overlay unreachable.
  const currentShortcutsHelpShortcut = [].concat(settingsData.shortcutsHelpShortcut || ['Meta+Shift+?', 'Meta+/']);
  const currentHashCommandsEnabled = settingsData.hashCommandsEnabled !== undefined ? settingsData.hashCommandsEnabled : true;
  const currentContextViewsEnabled = settingsData.contextViewsEnabled !== undefined ? settingsData.contextViewsEnabled : true;
  const currentOverviewDefaultLayout = settingsData.overviewDefaultLayout || 'tall';
  const currentMetaControlsEnabled = !!settingsData.metaControlsEnabled;
  const currentInheritRc = settingsData.inheritRemoteControl !== false;
  const currentInheritRcFork = settingsData.inheritRemoteControlOnFork !== false;
  const currentAutoUpdateCheckEnabled = settingsData.autoUpdateCheckEnabled !== undefined ? settingsData.autoUpdateCheckEnabled : true;
  const currentAutoUpdateCheckIntervalHours = settingsData.autoUpdateCheckIntervalHours || 6;
  const currentAutoUpdateApply = settingsData.autoUpdateApply !== undefined ? settingsData.autoUpdateApply : true;
  const currentSessionLogEnabled = !!settingsData.sessionLogEnabled;
  const currentScheduledTasksEnabled = settingsData.scheduledTasksEnabled !== false;
  const currentScheduledTasksOpenInBackground = settingsData.scheduledTasksOpenInBackground !== false;
  const currentPreventSleep = settingsData.preventSleepWhileActive !== false;
  const currentDefaultAgent = settingsData.defaultAgent || 'claude';
  const currentOpencodeBinary = settingsData.opencodeBinary || 'opencode';
  const currentPiBinary = settingsData.piBinary || 'pi';
  const currentScrollbackKB = settingsData.scrollbackKB || 100;
  const currentRecentSessionsLimit = settingsData.recentSessionsLimit ?? 8;
  // Custom Claude config profiles (#537): editable [name, configDir] rows.
  const currentCustomConfigs = Array.isArray(settingsData.customAgentConfigs) ? settingsData.customAgentConfigs : [];
  const inputStyle = 'padding:4px 8px; border-radius:4px; border:1px solid var(--ds-border); background:var(--ds-bg-secondary); color:var(--ds-text-primary); font-size:12px;';
  const customConfigRowHtml = (name = '', dir = '', id = '') => `
    <div class="custom-config-row" data-id="${escapeHtml(id)}" style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
      <input type="text" class="cc-name" value="${escapeHtml(name)}" placeholder="Display name" style="${inputStyle} width:130px;">
      <input type="text" class="cc-dir" value="${escapeHtml(dir)}" placeholder="~/.claude-alt" style="${inputStyle} flex:1; min-width:120px;">
      <button type="button" class="cc-browse" style="padding:4px 8px; font-size:12px; border-radius:4px; border:1px solid var(--ds-border); background:var(--ds-bg-secondary); color:var(--ds-text-primary); cursor:pointer;">Browse…</button>
      <button type="button" class="cc-remove" title="Remove" style="padding:4px 8px; font-size:12px; border-radius:4px; border:1px solid var(--ds-border); background:var(--ds-bg-secondary); color:var(--ds-text-secondary); cursor:pointer;">✕</button>
    </div>`;
  const customConfigsHtml = currentCustomConfigs.map(c => customConfigRowHtml(c.name, c.configDir, c.id)).join('');
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
        <div class="settings-tabs">
          <button class="settings-tab active" data-tab="general">General</button>
          <button class="settings-tab" data-tab="terminal">Terminal</button>
          <button class="settings-tab" data-tab="github">GitHub</button>
          <button class="settings-tab" data-tab="tips">Tips</button>
        </div>
      </div>
      <div class="settings-body">
      <div class="settings-tab-content active" data-tab="general">
      <div class="settings-section" id="updates-section">
        <h3>Updates</h3>
        <div id="updates-body"></div>
        <div style="margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap;">
          <button type="button" class="btn-secondary" id="updates-check-now" style="font-size: 11px; padding: 4px 10px;">Check now</button>
          <button type="button" class="btn-primary" id="updates-action-btn" style="font-size: 11px; padding: 4px 10px; display: none;"></button>
        </div>
        <label style="font-size: 12px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-top: 12px;">
          <input type="checkbox" id="auto-update-check-enabled" ${currentAutoUpdateCheckEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Check for updates in the background
        </label>
        <label style="font-size: 12px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px; margin-top: 6px;">
          Every
          <input type="number" id="auto-update-check-interval-hours" value="${currentAutoUpdateCheckIntervalHours}" min="1" max="168" step="1" style="width: 60px; padding: 3px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
          hours
        </label>
        <label id="auto-update-apply-row" style="font-size: 12px; color: var(--ds-text-primary); cursor: pointer; display: none; align-items: center; gap: 8px; margin-top: 6px;">
          <input type="checkbox" id="auto-update-apply" ${currentAutoUpdateApply ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Apply curl-pipe updates automatically (60s grace window)
        </label>
      </div>
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
        <h3>Tab Switching</h3>
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
        <h3>Command Palette</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="command-palette-enabled" ${currentCommandPaletteEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Enabled
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          Shortcut:
          <button type="button" id="command-palette-shortcut-btn" style="padding: 4px 10px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; cursor: pointer; min-width: 60px;">${escapeHtml(formatShortcut(currentCommandPaletteShortcut))}</button>
          <input type="hidden" id="command-palette-shortcut" value="${escapeHtml(currentCommandPaletteShortcut)}">
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Click the button and press a key combo to set the shortcut.
        </p>
      </div>
      <div class="settings-section">
        <h3>Keyboard Shortcuts Help</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="shortcuts-help-enabled" ${currentShortcutsHelpEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Enabled
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          Shortcut:
          <button type="button" id="shortcuts-help-shortcut-btn" style="padding: 4px 10px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; cursor: pointer; min-width: 60px;">${escapeHtml(currentShortcutsHelpShortcut.map(formatShortcut).join(' or '))}</button>
          <input type="hidden" id="shortcuts-help-shortcut" value="${escapeHtml(JSON.stringify(currentShortcutsHelpShortcut))}">
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Opens an overlay listing every deepsteve keyboard shortcut. Defaults to two
          combos because some browsers claim ⌘⇧? for their own Help menu; rebinding
          replaces both with your single combo.
        </p>
      </div>
      <div class="settings-section">
        <h3>Overview Mode</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px;">
          Default layout:
          <select id="overview-default-layout" style="padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px;">
            <option value="tall" ${currentOverviewDefaultLayout === 'tall' ? 'selected' : ''}>Tall</option>
            <option value="tiled" ${currentOverviewDefaultLayout === 'tiled' ? 'selected' : ''}>Tiled</option>
          </select>
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Layout used when entering overview mode (\u2318O). Tall stacks vertically; Tiled uses a 2-row grid.
        </p>
      </div>
      <div class="settings-section">
        <h3>Hash Commands</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="hash-commands-enabled" ${currentHashCommandsEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Enabled <span style="font-size: 11px; color: var(--ds-text-secondary);">(# prefix for instant actions)</span>
        </label>
      </div>
      <div class="settings-section">
        <h3>Context Views</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="context-views-enabled" ${currentContextViewsEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Enabled <span style="font-size: 11px; color: var(--ds-text-secondary);">(group tabs into folder-based contexts)</span>
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Adds the ◧ context panel toggle next to the layout switcher. ⌘P toggles the panel, ⌘↑/⌘↓ switch contexts.
        </p>
      </div>
      <div class="settings-section">
        <h3>Meta Controls</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="meta-controls-enabled" ${currentMetaControlsEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Enabled
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Lets agents type into terminals via the <code>meta_type</code> tool — self-driving loops are possible. Off by default.
        </p>
      </div>
      <div class="settings-section">
        <h3>Remote Control Inheritance</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="inherit-rc-newtab" ${currentInheritRc ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          New tabs
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-top: 6px;">
          <input type="checkbox" id="inherit-rc-fork" ${currentInheritRcFork ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Forks
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          When a tab already has Claude Code's <code>/rc</code> (remote control) active, automatically run <code>/rc</code> in new tabs / forks opened from it. On by default.
        </p>
      </div>
      <div class="settings-section">
        <h3>Log Session Lifecycle</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="session-log-enabled" ${currentSessionLogEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Enabled
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Record an append-only log of session opens and closes to ~/.deepsteve/session-lifecycle.jsonl. Agents can read it (read_session_log) or fetch /api/session-lifecycle to recap what happened. Off by default.
        </p>
      </div>
      <div class="settings-section">
        <h3>Scheduled Tasks</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="scheduled-tasks-enabled" ${currentScheduledTasksEnabled ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Run scheduled tasks
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Master switch for the locally-queued cron. When on, tasks in the Scheduled panel run on this machine at their cron time (local time), with full MCP access. Overdue tasks catch up once at startup. On by default.
        </p>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-top: 10px;">
          <input type="checkbox" id="scheduled-tasks-open-in-background" ${currentScheduledTasksOpenInBackground ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Open runs in the background
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          A scheduled run opens its tab without switching to it, so an unattended run never interrupts what you're doing. The tab shows an unread dot until you visit it. The Scheduled panel's own "Run now" button always switches. On by default.
        </p>
      </div>
      <div class="settings-section">
        <h3>Prevent Sleep</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="prevent-sleep-while-active" ${currentPreventSleep ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Prevent idle sleep while sessions are open
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Keeps this Mac from idle-sleeping while any session is open, so agents and connections aren't interrupted (macOS only; closing the lid still sleeps). On by default.
        </p>
      </div>
      <div class="settings-section">
        <h3>Enabled Agents</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Choose which installed agents are enabled. If multiple are enabled, you can switch between them using the Engine dropdown.
        </p>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-claude" ${agents.find(a => a.id === 'claude')?.enabled !== false ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Claude Code
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-codex" ${agents.find(a => a.id === 'codex')?.enabled ? 'checked' : ''} ${agents.find(a => a.id === 'codex')?.available ? '' : 'disabled'} style="accent-color: var(--ds-accent-green);">
          Codex${agents.find(a => a.id === 'codex')?.available ? '' : ' (not installed)'}
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
          <input type="checkbox" id="agent-pi" ${agents.find(a => a.id === 'pi')?.enabled ? 'checked' : ''} ${agents.find(a => a.id === 'pi')?.available ? '' : 'disabled'} style="accent-color: var(--ds-accent-green);">
          Pi (experimental)${agents.find(a => a.id === 'pi')?.available ? '' : ' (not installed)'}
        </label>
        <div id="pi-binary-row" style="display: ${agents.find(a => a.id === 'pi')?.enabled ? 'block' : 'none'}; margin-top: 8px;">
          <label style="font-size: 12px; color: var(--ds-text-secondary);">Binary path</label>
          <input type="text" id="pi-binary" value="${escapeHtml(currentPiBinary)}" placeholder="pi" style="width: 200px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
        </div>
        <div style="margin-top: 16px; border-top: 1px solid var(--ds-border); padding-top: 12px;">
          <label style="font-size: 13px; color: var(--ds-text-primary); font-weight: 600;">Custom Claude configs</label>
          <p style="font-size: 11px; color: var(--ds-text-secondary); margin: 4px 0 8px;">
            Each profile opens a normal Claude Code session pinned to its own config directory (<code>CLAUDE_CONFIG_DIR</code>) — its own settings.json, credentials, and history. Use this to run an alternate provider, a second account, or a locked-down profile side by side. Profiles appear at the end of the agent list. <code>~</code> is expanded.
          </p>
          <div id="custom-configs-list">${customConfigsHtml}</div>
          <button type="button" id="add-custom-config" style="margin-top: 4px; padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary); cursor: pointer;">+ Add config</button>
        </div>
      </div>
      </div>
      <div class="settings-tab-content" data-tab="terminal">
      <div class="settings-section">
        <h3>Default Terminal Engine</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Default engine for new sessions. Existing sessions keep their engine. With tmux, sessions survive daemon restarts.
        </p>
        <select id="engine-select" style="padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
          ${(enginesData.engines || []).map(e => {
            const experimental = e.id === 'tmux' ? ' (experimental)' : '';
            const label = e.available ? `${e.name}${e.version ? ' v' + e.version : ''}${experimental}` : `${e.name} (not installed)`;
            return `<option value="${e.id}" ${e.id === enginesData.current ? 'selected' : ''} ${!e.available ? 'disabled' : ''}>${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="settings-section">
        <h3>Scrollback Buffer</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Size of the per-session scrollback buffer used for replay on reconnect/restore.
        </p>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px;">
          <input type="number" id="scrollback-kb" value="${currentScrollbackKB}" min="1" max="10000" step="1" style="width: 80px; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px;">
          KB
        </label>
      </div>
      <div class="settings-section">
        <h3>Recent Sessions</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          How many recently-opened session configs to keep for restore (from the directory picker or empty state, in any browser/window). Set to 0 to disable.
        </p>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px;">
          <input type="number" id="recent-sessions-limit" value="${currentRecentSessionsLimit}" min="0" max="50" step="1" style="width: 80px; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px;">
          sessions
        </label>
      </div>
      </div>
      <div class="settings-tab-content" data-tab="github">
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
        <h3>Worktrees</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="symlink-worktree-settings" ${currentSymlinkWorktreeSettings ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Symlink settings.local.json into worktrees
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Shares tool permissions from the parent repo so worktrees don't re-prompt.
        </p>
      </div>
      </div>
      <div class="settings-tab-content" data-tab="tips">
      <div class="settings-section">
        <h3>Tab Switching Hold Delay</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary);">
          Lower the <kbd>\u2318</kbd> hold duration (General \u2192 Tab Switching) to press it faster
          for browser tab navigation. Wait for the full duration to navigate between DeepSteve tabs.
        </p>
      </div>
      <div class="settings-section">
        <h3>Switch Tabs</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary);">
          <kbd>\u2318</kbd><kbd>&lt;</kbd> / <kbd>\u2318</kbd><kbd>&gt;</kbd> \u2014 switch to the previous or next tab.
        </p>
      </div>
      <div class="settings-section">
        <h3>Overview Mode</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary);">
          <kbd>\u2318</kbd><kbd>O</kbd> \u2014 see all of your tabs at once.
        </p>
      </div>
      <div class="settings-section">
        <h3>Custom Themes</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary);">
          Create your own <code>.css</code> theme file and place it in <code>~/.deepsteve/themes/</code>.
          It will appear in the Theme dropdown under General settings.
        </p>
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

  // Tab switching
  overlay.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      overlay.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      overlay.querySelector(`.settings-tab-content[data-tab="${tab.dataset.tab}"]`).classList.add('active');
      overlay.querySelector('.modal-buttons').style.display = tab.dataset.tab === 'tips' ? 'none' : 'flex';
    });
  });

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

  // Show/hide Pi binary path input based on checkbox
  const agentPiCheckbox = overlay.querySelector('#agent-pi');
  const piBinaryRow = overlay.querySelector('#pi-binary-row');
  agentPiCheckbox?.addEventListener('change', () => {
    piBinaryRow.style.display = agentPiCheckbox.checked ? 'block' : 'none';
  });

  // Custom Claude config profiles (#537): add / remove rows + Browse via dir-picker.
  const customConfigsList = overlay.querySelector('#custom-configs-list');
  overlay.querySelector('#add-custom-config')?.addEventListener('click', () => {
    customConfigsList.insertAdjacentHTML('beforeend', customConfigRowHtml());
    customConfigsList.querySelector('.custom-config-row:last-child .cc-name')?.focus();
  });
  customConfigsList?.addEventListener('click', async (ev) => {
    const removeBtn = ev.target.closest('.cc-remove');
    if (removeBtn) { removeBtn.closest('.custom-config-row')?.remove(); return; }
    const browseBtn = ev.target.closest('.cc-browse');
    if (browseBtn) {
      const dirInput = browseBtn.closest('.custom-config-row')?.querySelector('.cc-dir');
      const result = await showDirectoryPicker();
      if (typeof result === 'string' && result && dirInput) dirInput.value = result;
    }
  });

  // Wand template reset button
  overlay.querySelector('#wand-template-reset').onclick = async () => {
    if (!confirm('Reset magic wand prompt template to default?')) return;
    const templateInput = overlay.querySelector('#wand-prompt-template');
    templateInput.value = defaultsData.wandPromptTemplate || '';
  };

  // --- Updates section ---
  const updatesBody = overlay.querySelector('#updates-body');
  const updatesCheckBtn = overlay.querySelector('#updates-check-now');
  const updatesActionBtn = overlay.querySelector('#updates-action-btn');
  const autoUpdateApplyRow = overlay.querySelector('#auto-update-apply-row');
  let currentStatus = versionData.status || {
    current: versionData.current,
    latest: versionData.latest,
    updateAvailable: versionData.updateAvailable,
    installSource: { type: 'unknown' },
    gitTreeClean: null,
    checkError: null,
    checkedAt: null,
    releaseNotes: null,
    releaseUrl: null,
    releaseTag: null,
  };

  function renderUpdates() {
    const s = currentStatus || {};
    const src = s.installSource || { type: 'unknown' };
    const srcLabel =
      src.type === 'git' ? `git checkout${src.sourcePath ? ` (${escapeHtml(src.sourcePath)})` : ''}` :
      src.type === 'curl' ? 'curl install' :
      'unknown';
    const statusPill =
      s.checkError ? `<span class="version-status version-failed">Check failed: ${escapeHtml(s.checkError)}</span>` :
      s.latest === null ? `<span class="version-status version-failed">Couldn\u2019t check for updates</span>` :
      s.updateAvailable ? `<span class="version-status version-update">Update available</span>` :
      `<span class="version-status version-ok">Up to date</span>`;

    let notesBlock = '';
    if (s.updateAvailable && s.releaseNotes) {
      notesBlock = `
        <details style="margin-top: 8px;">
          <summary style="cursor: pointer; font-size: 12px; color: var(--ds-text-secondary);">Release notes for ${escapeHtml(s.releaseTag || s.latest || '')}</summary>
          <pre style="white-space: pre-wrap; font-size: 11px; color: var(--ds-text-primary); background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; padding: 8px; margin-top: 6px; max-height: 200px; overflow-y: auto;">${escapeHtml(s.releaseNotes)}</pre>
        </details>`;
    }

    const checkedLabel = s.checkedAt ? ` &middot; checked ${new Date(s.checkedAt).toLocaleString()}` : '';

    updatesBody.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <span style="font-size: 13px;">Version <strong>${escapeHtml(s.current || '?')}</strong></span>
        ${s.updateAvailable && s.latest ? `<span style="font-size: 12px; color: var(--ds-text-secondary);">\u2192 ${escapeHtml(s.latest)}</span>` : ''}
        ${statusPill}
      </div>
      <div style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">Installed via: ${srcLabel}${checkedLabel}</div>
      ${s.updateAvailable && s.releaseUrl ? `<div style="font-size: 11px; margin-top: 4px;"><a href="${escapeHtml(s.releaseUrl)}" target="_blank" style="color: var(--ds-accent-blue);">View on GitHub</a></div>` : ''}
      ${notesBlock}
    `;

    // Action button — only shown when an update is available
    updatesActionBtn.style.display = 'none';
    updatesActionBtn.disabled = false;
    updatesActionBtn.title = '';
    if (s.updateAvailable) {
      if (src.type === 'git') {
        updatesActionBtn.style.display = '';
        updatesActionBtn.textContent = 'Pull and restart';
        if (s.gitTreeClean === false) {
          updatesActionBtn.disabled = true;
          updatesActionBtn.title = 'Working tree has uncommitted changes';
        } else if (s.gitTreeClean === null) {
          updatesActionBtn.disabled = true;
          updatesActionBtn.title = 'Could not determine working tree state';
        }
      } else if (src.type === 'curl') {
        updatesActionBtn.style.display = '';
        updatesActionBtn.textContent = 'Update now';
      } else {
        updatesActionBtn.style.display = '';
        updatesActionBtn.textContent = 'Update unavailable';
        updatesActionBtn.disabled = true;
        updatesActionBtn.title = 'Run ./restart.sh or re-install to enable auto-updates';
      }
    }

    autoUpdateApplyRow.style.display = src.type === 'curl' ? 'flex' : 'none';
  }

  renderUpdates();

  updatesCheckBtn.onclick = async () => {
    updatesCheckBtn.disabled = true;
    updatesCheckBtn.textContent = 'Checking...';
    try {
      const resp = await fetch('/api/version/check', { method: 'POST' });
      const data = await resp.json();
      if (data.status) {
        currentStatus = data.status;
        renderUpdates();
      }
    } catch (e) {
      alert(`Check failed: ${e.message}`);
    } finally {
      updatesCheckBtn.disabled = false;
      updatesCheckBtn.textContent = 'Check now';
    }
  };

  updatesActionBtn.onclick = async () => {
    const src = (currentStatus || {}).installSource || { type: 'unknown' };
    const path = src.type === 'git' ? '/api/update/git-pull' : src.type === 'curl' ? '/api/update/curl-reinstall' : null;
    if (!path) return;
    const verb = src.type === 'git' ? 'pull and restart' : 're-download and reinstall';
    if (!confirm(`Are you sure you want to ${verb}? Your sessions will be preserved.`)) return;
    updatesActionBtn.disabled = true;
    const originalText = updatesActionBtn.textContent;
    updatesActionBtn.textContent = 'Starting...';
    try {
      const resp = await fetch(path, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        alert(`Update failed: ${data.error || resp.status}`);
        updatesActionBtn.disabled = false;
        updatesActionBtn.textContent = originalText;
        return;
      }
      updatesActionBtn.textContent = 'Restarting...';
    } catch (e) {
      alert(`Update failed: ${e.message}`);
      updatesActionBtn.disabled = false;
      updatesActionBtn.textContent = originalText;
    }
  };

  // Keep Updates section in sync with WebSocket broadcasts while the modal is open.
  // Cleanup is handled by the Save/Cancel/overlay click handlers below.
  const versionStatusHandler = (e) => {
    currentStatus = e.detail;
    renderUpdates();
  };
  window.addEventListener('deepsteve:version-status', versionStatusHandler);

  // Shortcut capture: click the button, press a combo. Produces the canonical
  // Meta+Ctrl+Alt+Shift+key string that shortcuts.js parseShortcut() consumes.
  // `serialize` exists because shortcutsHelpShortcut stores a list, not a string.
  const wireShortcutRecorder = (btnSel, inputSel, serialize = (combo) => combo) => {
    const shortcutBtn = overlay.querySelector(btnSel);
    const shortcutInput = overlay.querySelector(inputSel);
    if (!shortcutBtn || !shortcutInput) return;
    shortcutBtn.onclick = () => {
      shortcutBtn.textContent = 'Press key...';
      shortcutBtn.style.borderColor = 'var(--ds-accent-blue)';
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return; // wait for non-modifier
        const parts = [];
        if (e.metaKey) parts.push('Meta');
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        parts.push(e.key.toLowerCase());
        const combo = parts.join('+');
        shortcutInput.value = serialize(combo);
        shortcutBtn.textContent = formatShortcut(combo);
        shortcutBtn.style.borderColor = '';
        document.removeEventListener('keydown', handler, true);
      };
      document.addEventListener('keydown', handler, true);
    };
  };
  wireShortcutRecorder('#command-palette-shortcut-btn', '#command-palette-shortcut');
  // JSON, not a comma-join: a combo can legitimately *be* a comma (Meta+,).
  wireShortcutRecorder('#shortcuts-help-shortcut-btn', '#shortcuts-help-shortcut',
    (combo) => JSON.stringify([combo]));

  overlay.querySelector('#settings-cancel').onclick = () => {
    window.removeEventListener('deepsteve:version-status', versionStatusHandler);
    overlay.remove();
  };
  overlay.querySelector('#settings-save').onclick = async () => {
    const selected = overlay.querySelector('input[name="profile"]:checked').value;
    const shellProfile = selected === 'custom' ? customInput.value : selected;
    const newMaxTitle = Number(overlay.querySelector('#max-issue-title-length').value) || 25;
    const wandPlanMode = overlay.querySelector('#wand-plan-mode').checked;
    const wandPromptTemplate = overlay.querySelector('#wand-prompt-template').value;
    const symlinkWorktreeSettings = overlay.querySelector('#symlink-worktree-settings').checked;
    const cmdTabSwitch = overlay.querySelector('#cmd-tab-switch').checked;
    const cmdTabSwitchHoldMs = Math.max(0, Number(overlay.querySelector('#cmd-tab-switch-hold-ms').value) || 0);
    const commandPaletteEnabled = overlay.querySelector('#command-palette-enabled').checked;
    const commandPaletteShortcut = overlay.querySelector('#command-palette-shortcut').value;
    const shortcutsHelpEnabled = overlay.querySelector('#shortcuts-help-enabled').checked;
    // Stored as JSON (a list of alternates). Fall back to the raw value rather than
    // throwing out of the whole save if it's somehow not parseable — the server's
    // sanitize accepts a bare string too.
    let shortcutsHelpShortcut;
    try {
      shortcutsHelpShortcut = JSON.parse(overlay.querySelector('#shortcuts-help-shortcut').value);
    } catch {
      shortcutsHelpShortcut = overlay.querySelector('#shortcuts-help-shortcut').value;
    }
    const hashCommandsEnabled = overlay.querySelector('#hash-commands-enabled').checked;
    const contextViewsEnabled = overlay.querySelector('#context-views-enabled').checked;
    const metaControlsEnabled = overlay.querySelector('#meta-controls-enabled').checked;
    const overviewDefaultLayout = overlay.querySelector('#overview-default-layout').value;
    const enabledAgents = [];
    if (overlay.querySelector('#agent-claude').checked) enabledAgents.push('claude');
    if (overlay.querySelector('#agent-codex').checked) enabledAgents.push('codex');
    if (overlay.querySelector('#agent-opencode').checked) enabledAgents.push('opencode');
    if (overlay.querySelector('#agent-pi').checked) enabledAgents.push('pi');
    // Preserve enabled agents that have no checkbox here (e.g. hermes) — rebuilding
    // the list from only the rendered trio silently disabled them on every save (#519).
    // Appended after the rendered ones because the server derives defaultAgent from
    // the first entry.
    const renderedAgentIds = ['claude', 'codex', 'opencode', 'pi'];
    for (const a of settingsData.enabledAgents || []) {
      if (!renderedAgentIds.includes(a)) enabledAgents.push(a);
    }
    const opencodeBinary = overlay.querySelector('#opencode-binary').value || 'opencode';
    const piBinary = overlay.querySelector('#pi-binary').value || 'pi';
    // Custom Claude config profiles (#537): collect rows; drop incomplete ones. Keep the
    // existing id (data-id) so a profile's id is stable across saves (new rows have none;
    // the server assigns one).
    const customAgentConfigs = [...overlay.querySelectorAll('#custom-configs-list .custom-config-row')].map(row => ({
      id: row.dataset.id || undefined,
      name: row.querySelector('.cc-name').value.trim(),
      configDir: row.querySelector('.cc-dir').value.trim(),
    })).filter(c => c.name && c.configDir);
    const selectedEngine = overlay.querySelector('#engine-select')?.value || 'node-pty';
    const scrollbackKB = Math.max(1, Math.min(10000, Math.round(Number(overlay.querySelector('#scrollback-kb').value)) || 100));
    const recentSessionsLimit = Math.max(0, Math.min(50, Math.round(Number(overlay.querySelector('#recent-sessions-limit').value)) || 0));
    const autoUpdateCheckEnabled = overlay.querySelector('#auto-update-check-enabled').checked;
    const autoUpdateCheckIntervalHours = Math.max(1, Math.min(168, Number(overlay.querySelector('#auto-update-check-interval-hours').value) || 6));
    const autoUpdateApply = overlay.querySelector('#auto-update-apply').checked;
    const sessionLogEnabled = overlay.querySelector('#session-log-enabled').checked;
    const scheduledTasksEnabled = overlay.querySelector('#scheduled-tasks-enabled').checked;
    const scheduledTasksOpenInBackground = overlay.querySelector('#scheduled-tasks-open-in-background').checked;
    const preventSleepWhileActive = overlay.querySelector('#prevent-sleep-while-active').checked;
    const inheritRemoteControl = overlay.querySelector('#inherit-rc-newtab').checked;
    const inheritRemoteControlOnFork = overlay.querySelector('#inherit-rc-fork').checked;
    const settingsPayload = { shellProfile, maxIssueTitleLength: newMaxTitle, wandPlanMode, wandPromptTemplate, symlinkWorktreeSettings, cmdTabSwitch, cmdTabSwitchHoldMs, commandPaletteEnabled, commandPaletteShortcut, shortcutsHelpEnabled, shortcutsHelpShortcut, hashCommandsEnabled, contextViewsEnabled, metaControlsEnabled, inheritRemoteControl, inheritRemoteControlOnFork, overviewDefaultLayout, enabledAgents, opencodeBinary, piBinary, engine: selectedEngine, scrollbackKB, recentSessionsLimit, autoUpdateCheckEnabled, autoUpdateCheckIntervalHours, autoUpdateApply, sessionLogEnabled, scheduledTasksEnabled, scheduledTasksOpenInBackground, preventSleepWhileActive, customAgentConfigs };
    let resp = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsPayload)
    });
    let result = await resp.json();
    if (!resp.ok && result.error) {
      alert(result.error);
      return;
    }
    maxIssueTitleLength = Math.max(10, Math.min(200, newMaxTitle));
    setCmdHoldModeEnabled(cmdTabSwitch);
    setCmdHoldModeHoldMs(cmdTabSwitchHoldMs);
    setCommandPaletteEnabled(commandPaletteEnabled);
    setCommandPaletteShortcut(commandPaletteShortcut);
    setShortcutsHelpEnabled(shortcutsHelpEnabled);
    setShortcutsHelpShortcut(shortcutsHelpShortcut);
    setHashCommandsEnabled(hashCommandsEnabled);
    setContextViewsEnabled(contextViewsEnabled);
    // Refresh agents data — enabled set and/or custom config profiles (#537) may have
    // changed (custom-config edits aren't reflected in the enabledAgents diff), so just
    // re-fetch. Preserve the current picker selection if it still exists.
    try {
      const agentsResp = await fetch('/api/agents');
      const agentsData = await agentsResp.json();
      window.__deepsteveAgents = agentsData.agents || [];
      const stillExists = window.__deepsteveAgents.some(a => a.id === window.__deepsteveDefaultAgent);
      if (!stillExists) window.__deepsteveDefaultAgent = agentsData.defaultAgent || 'claude';
      refreshEnginesDropdown();
    } catch {}
    window.removeEventListener('deepsteve:version-status', versionStatusHandler);
    overlay.remove();
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      window.removeEventListener('deepsteve:version-status', versionStatusHandler);
      overlay.remove();
    }
  };
  const onEscSettings = (e) => { if (e.key === 'Escape') { e.preventDefault(); window.removeEventListener('deepsteve:version-status', versionStatusHandler); overlay.remove(); } };
  document.addEventListener('keydown', onEscSettings);
  new MutationObserver((_, obs) => { if (!overlay.parentNode) { document.removeEventListener('keydown', onEscSettings); obs.disconnect(); } }).observe(document.body, { childList: true });
});

function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const count = [...sessions.values()].filter(s => s.hasUnseenActivity).length;
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
 * Attach to an existing tmux session (raw terminal)
 */
function createTmuxAttachSession(tmuxSessionName) {
  const { cols, rows } = measureTerminalSize();
  const ws = createWebSocket({
    action: 'tmux-attach',
    session: tmuxSessionName,
    name: tmuxSessionName,
    cols,
    rows,
    windowId: getWindowId(),
  });

  // Same reconnect-state tracking as createSession (#556); no tab exists
  // until the session message lands, so the handle starts without a tabId.
  const connHandle = ConnectionStatus.track({ tabId: null });

  let pendingData = [];
  let assignedId = null;

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
      if (typeof msg !== 'object' || msg === null) throw null;
    } catch {
      const session = assignedId && sessions.get(assignedId);
      if (session) {
        session.term.write(e.data);
      } else {
        pendingData.push(e.data);
      }
      return;
    }

    if (msg.type === 'session') {
      assignedId = msg.id;
      ws.serverSupportsPing = !!msg.pingPong; // wake-probe capability (#563)
      ws.setSessionId(msg.id);
      connHandle.setSessionId(msg.id);
      initTerminal(msg.id, ws, null, msg.name || tmuxSessionName, { pendingData, cols, rows });
      pendingData = [];
      const sess = sessions.get(msg.id);
      if (sess) {
        sess.connHandle = connHandle; // so killSession/sendToWindow can untrack
        if (msg.engineType) sess.engineType = msg.engineType;
      }
    } else if (msg.type === 'error') {
      alert(msg.message || 'Failed to attach to tmux session');
      connHandle.untrack();
      ws.close();
    }
  };

  ws.onreconnecting = () => {
    connHandle.noteReconnecting();
    const session = assignedId ? sessions.get(assignedId) : null;
    if (session) session.container.classList.add('reconnecting');
  };

  ws.onreconnected = () => {
    connHandle.noteReconnected();
    const session = assignedId ? sessions.get(assignedId) : null;
    if (session) session.container.classList.remove('reconnecting');
  };
}

/**
 * Create a new terminal session
 */
function createSession(cwd, existingId = null, isNew = false, opts = {}) {
  const { cols, rows } = measureTerminalSize();
  // Custom Claude config profiles (#537): a profile is picked as agentType 'config:<pid>'.
  // Resolve it here (the single WS-creation choke point) into a real agentType:'claude'
  // plus a configProfile param the server maps to a CLAUDE_CONFIG_DIR.
  let agentType = opts.agentType;
  let configProfile;
  if (typeof agentType === 'string' && agentType.startsWith('config:')) {
    configProfile = agentType.slice('config:'.length);
    agentType = 'claude';
  }
  const ws = createWebSocket({ id: existingId, cwd, isNew, worktree: opts.worktree, name: opts.name, planMode: opts.planMode, agentType, configProfile, cols, rows, windowId: getWindowId(), fork: opts.fork, rcParent: opts.rcParent, noRestore: opts.noRestore });

  // Reconnect state lives on this handle, not the sessions map (#556): the map
  // entry only exists after the first {type:'session'} message, so a connect
  // that never succeeds would otherwise be invisible. Restores carry the
  // requested id so the dot lands on their placeholder tab; brand-new creates
  // stay off the reconnect banner pre-session — that outage belongs to the
  // pending-create banner below.
  const connHandle = ConnectionStatus.track({ tabId: existingId, bannerEligible: !isNew });

  // Promise that resolves when the session is fully initialized (terminal created)
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  // A brand-new session has no tab until the server answers — surface a
  // "server unreachable" banner if the first connect doesn't land quickly (#563).
  const pendingCreate = isNew ? trackPendingCreate(ws, resolveReady, connHandle) : null;

  // Buffer terminal data that arrives before the terminal is created
  let pendingData = [];
  let hasScrollback = false;
  let assignedId = null; // session ID assigned by server

  ws.onmessage = (e) => {
    // Try to parse as JSON control message
    let msg;
    try {
      msg = JSON.parse(e.data);
      if (typeof msg !== 'object' || msg === null) throw null;
    } catch {
      // Not a JSON control message - pass to terminal (or buffer if not yet created)
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

    // Valid JSON control message - handle (never write to terminal)
    try {
      if (msg.type === 'session') {
        assignedId = msg.id;
        if (pendingCreate) pendingCreate.settle();
        // Reject unexpected duplicates: another window already has this session.
        // Exempt isNew sessions (#554): their id is client-minted, so no other tab
        // can legitimately hold it — an existing client can only be this tab's own
        // not-yet-reaped dead socket from a prior create attempt, and closing here
        // would kill the retry loop and orphan the shell.
        if (!isNew && msg.existingClients > 0 && !opts.allowDuplicate) {
          console.log(`[createSession] Rejecting duplicate session ${msg.id} (${msg.existingClients} existing client(s))`);
          connHandle.untrack();
          ws.close();
          resolveReady(null);
          return;
        }
        // Update reconnect URL to use the assigned session ID
        ws.setSessionId(msg.id);
        connHandle.setSessionId(msg.id);
        ws.serverSupportsPing = !!msg.pingPong; // wake-probe capability (#563)
        hasScrollback = msg.scrollback || false;
        // If server assigned a different ID than requested, update the per-tab session id
        if (existingId && msg.id !== existingId) {
          SessionStores.updateId(existingId, msg.id);
        }
        // Check if this WebSocket already has a session (reconnect case)
        const existingSession = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (!existingSession) {
          // Use client-provided name, or fall back to server-persisted name
          const sessionName = opts.name || msg.name;
          initTerminal(msg.id, ws, cwd, sessionName, { hasScrollback, pendingData, restoreActive: opts.restoreActive, background: opts.background, cols, rows });
          resolveReady(msg.id);
          if (opts.loading) {
            const sess = sessions.get(msg.id);
            if (sess) showLoadingBanner(msg.id, sess.container);
          }
          if (opts.initialPrompt) {
            // Forward `loading` so the server marks this shell as a loading session
            // (blocks input + emits prompt-submitted to dismiss the banner) for the
            // client-initiated issue-start path, mirroring /api/start-issue (#495).
            ws.sendJSON({ type: 'initialPrompt', text: opts.initialPrompt, loading: opts.loading });
          }
          // Apply persisted waiting state from the server. This restores the
          // busy/idle flag after a reconnect so close-confirm and the hash
          // commands overlay see the correct state. Do NOT raise the badge or
          // notification here — a reconnect restoring existing state is not
          // new activity the user has missed.
          if (msg.waitingForInput) {
            const sess = sessions.get(msg.id);
            if (sess) {
              sess.waitingForInput = true;
              if (msg.id === activeId) setHashCommandsWaiting(true);
              notifyTabsChanged();
            }
          }
        }
        // Expose the reconnect handle to close paths outside this closure
        // (killSession, sendToWindow) — a teardown mid-outage must untrack it
        // or the connection-lost banner would be pinned forever.
        const connSess = sessions.get(msg.id);
        if (connSess) connSess.connHandle = connHandle;
        // Track engineType and claudeSessionId for session verification (after initTerminal
        // so SessionStores.add has already created the entry)
        if (msg.engineType) {
          const sess = sessions.get(msg.id);
          if (sess) sess.engineType = msg.engineType;
          // engineType tracked on session object (tooltip shows tab name, set by TabManager)
        }
        if (msg.claudeSessionId) {
          SessionStores.setClaudeSessionId(msg.id, msg.claudeSessionId);
        }
      } else if (msg.type === 'close-tab') {
        if (assignedId) killSession(assignedId);
      } else if (msg.type === 'gone') {
        connHandle.untrack();
        SessionStores.remove(getWindowId(), msg.id);
        TabManager.removeTab(msg.id);
        resolveReady(null);
      } else if (msg.type === 'theme') {
        applyTheme(msg.css || '');
      } else if (msg.type === 'settings') {
        applySettings(msg);
      } else if (msg.type === 'skills-changed') {
        ModManager.handleSkillsChanged(msg.enabledSkills);
      } else if (msg.type === 'mod-changed') {
        ModManager.handleModChanged(msg.modId);
      } else if (msg.type === 'state') {
        const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (entry) {
          const [sid, s] = entry;
          s.waitingForInput = msg.waiting;
          if (sid === activeId) setHashCommandsWaiting(msg.waiting);
          s.scrollControl.syncViewport();
          if (msg.waiting && activeId !== sid) {
            s.hasUnseenActivity = true;
          }
          TabManager.updateBadge(sid, s.hasUnseenActivity);
          updateTitle();
          updateAppBadge();
          if (msg.waiting) {
            showNotification(sid, s.name || getDefaultTabName(s.cwd));
          }
          notifyTabsChanged();
        }
      } else if (msg.type === 'tasks') {
        ModManager.notifyTasksChanged(msg.tasks);
      } else if (msg.type === 'scheduled-tasks') {
        ModManager.notifyScheduledTasksChanged();
      } else if (msg.type === 'contexts') {
        // Unified groups (#526): update the tab-strip rail and any panel subscribers.
        applyServerContexts(msg.contexts);
        ModManager.notifyContextsChanged(msg.contexts);
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
      } else if (msg.type === 'screenshot-added' || msg.type === 'screenshot-deleted') {
        ModManager.notifyScreenshotEvent(msg);
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
      } else if (msg.type === 'baby-browser-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBabyBrowserRequest(msg);
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
    connHandle.noteReconnecting();
    // Full-container overlay for an established session (active tab only —
    // the tab dot and banner via connHandle cover everything else).
    const session = assignedId ? sessions.get(assignedId) : null;
    if (session) session.container.classList.add('reconnecting');
  };

  ws.onreconnected = () => {
    connHandle.noteReconnected();
    const session = assignedId ? sessions.get(assignedId) : null;
    if (session) {
      session.container.classList.remove('reconnecting');
      // ResizeObserver handles fit; just request redraw from server
      ws.send(JSON.stringify({ type: 'redraw' }));
      // After a daemon restart the PTY is respawned at the cols/rows frozen into
      // the WS URL at creation time — stale if the window was resized since. A
      // bare resize to the live xterm dims forces a SIGWINCH redraw when they
      // differ, and is a no-op when they match (#566). redraw is a server no-op
      // for the node-pty path, so this is what actually repairs stale sizing.
      ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
      session.scrollControl.scrollToBottom();
    }
    ModManager.notifyWSReconnected();
  };

  return ready;
}

/**
 * Pending new-session banner (#563).
 *
 * A brand-new session is a WS connect: while the server is unreachable the
 * wrapper's retry loop silently queues the create, and the tab only appears
 * when a {type:'session'} message finally lands — possibly minutes later, with
 * zero feedback in between. This page-level banner makes that pending state
 * visible and cancellable. One banner is shared by all pending creates.
 */
const pendingCreates = new Set();
let pendingBannerEl = null;

function updatePendingBanner() {
  // The reconnect banner (#556) sits in the same spot and says less — while a
  // pending create is on screen, it yields. Every add/settle/cancel funnels
  // through here, so this is the single suppression choke point.
  ConnectionStatus.setSuppressed(pendingCreates.size > 0);
  if (pendingCreates.size === 0) {
    if (pendingBannerEl) { pendingBannerEl.remove(); pendingBannerEl = null; }
    return;
  }
  if (!pendingBannerEl) {
    pendingBannerEl = document.createElement('div');
    pendingBannerEl.className = 'pending-session-banner';
    const spinner = document.createElement('span');
    spinner.className = 'loading-banner-spinner';
    const label = document.createElement('span');
    label.className = 'pending-session-banner-label';
    const btn = document.createElement('button');
    btn.className = 'pending-session-banner-cancel';
    btn.textContent = 'Cancel';
    btn.addEventListener('click', () => {
      for (const p of [...pendingCreates]) p.cancel();
    });
    pendingBannerEl.append(spinner, label, btn);
    document.body.appendChild(pendingBannerEl);
  }
  pendingBannerEl.querySelector('.pending-session-banner-label').textContent =
    pendingCreates.size > 1
      ? `Server unreachable — ${pendingCreates.size} new sessions will open when it reconnects…`
      : 'Server unreachable — your new session will open when it reconnects…';
}

// Arms a delayed banner for a brand-new session's first connect. Returns a
// handle: settle() when the session arrives, cancel() aborts the attempt.
function trackPendingCreate(ws, resolveReady, connHandle) {
  const entry = {
    timer: null,
    settle() {
      clearTimeout(entry.timer);
      pendingCreates.delete(entry);
      updatePendingBanner();
    },
    cancel() {
      entry.settle();
      connHandle.untrack(); // ws.close() stops retries without ever firing onreconnected
      ws.close(); // wrapper close also stops the retry loop
      resolveReady(null);
    },
  };
  // Only surface the banner if the connect hasn't succeeded quickly — a healthy
  // server answers in milliseconds and needs no UI.
  entry.timer = setTimeout(() => {
    pendingCreates.add(entry);
    updatePendingBanner();
  }, 1500);
  return entry;
}

/**
 * Global connection-lost banner (#556). Rendered by ConnectionStatus once any
 * session's socket has been down past the grace period — including a socket
 * whose first connect never succeeded, which has no sessions entry, no
 * container, and (for restores) only a placeholder tab. Same recipe as the
 * pending-create banner above; no Cancel because retry is automatic.
 */
let reconnectBannerEl = null;

function renderReconnectBanner(count) {
  if (count === 0) {
    if (reconnectBannerEl) { reconnectBannerEl.remove(); reconnectBannerEl = null; }
    return;
  }
  if (!reconnectBannerEl) {
    reconnectBannerEl = document.createElement('div');
    reconnectBannerEl.className = 'reconnect-banner';
    const spinner = document.createElement('span');
    spinner.className = 'loading-banner-spinner';
    const label = document.createElement('span');
    label.className = 'reconnect-banner-label';
    reconnectBannerEl.append(spinner, label);
    document.body.appendChild(reconnectBannerEl);
  }
  reconnectBannerEl.querySelector('.reconnect-banner-label').textContent =
    count > 1
      ? `Connection lost — reconnecting ${count} sessions…`
      : 'Connection lost — reconnecting…';
}

// Per-connection reconnect state (#556): drives the tab-strip dot and the
// banner above. Handles are created in createSession/createTmuxAttachSession
// at ws-creation time — before any sessions-map entry exists, which is exactly
// when the old container-class overlay could not fire.
const ConnectionStatus = createConnectionTracker({
  setTabIndicator: (tabId, on) => TabManager.updateReconnecting(tabId, on),
  renderBanner: renderReconnectBanner,
});

/**
 * Show a loading banner at the top of a terminal container.
 * Auto-dismisses after 60s as a safety net.
 */
function showLoadingBanner(sessionId, container) {
  if (container.querySelector('.loading-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'loading-banner';
  banner.innerHTML = '<span class="loading-banner-spinner"></span> Reading GitHub issue and populating tab\u2026';
  // "Enable input" override: input is blocked server-side while the issue prompt is
  // auto-submitted (#512); this lets the user take control immediately if they want.
  const btn = document.createElement('button');
  btn.className = 'loading-banner-override';
  btn.textContent = 'Enable input';
  btn.addEventListener('click', () => {
    const sess = sessions.get(sessionId);
    if (sess?.ws) sess.ws.sendJSON({ type: 'unblock-input' });
    dismissLoadingBanner(sessionId);
  });
  banner.appendChild(btn);
  container.prepend(banner);
  banner._loadingTimeout = setTimeout(() => dismissLoadingBanner(sessionId), 60000);
}

function dismissLoadingBanner(sessionId) {
  const container = document.getElementById('term-' + sessionId);
  if (!container) return;
  const banner = container.querySelector('.loading-banner');
  if (!banner) return;
  if (banner._loadingTimeout) clearTimeout(banner._loadingTimeout);
  banner.classList.add('loading-banner-dismiss');
  setTimeout(() => banner.remove(), 300);
}

/**
 * Initialize a terminal after WebSocket connection is established
 */
function initTerminal(id, ws, cwd, initialName, { hasScrollback = false, pendingData = [], restoreActive = false, background = false, cols, rows } = {}) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  // Pass the measured grid size so the xterm opens at the right dims and
  // scrollback replays into the correct grid on refresh (#566).
  const { term, fit } = createTerminal(container, { cols, rows });
  const scrollControl = setupTerminalIO(term, ws, {
    onUserInput: () => {
      clearNotification(id);
      updateOverviewFocus(id);
      ModManager.notifyUserActivity(id);
    },
    container,
    beforeSend: (data) => hashCommandsBeforeSend(data, container)
  });

  // Get saved name or generate default
  const windowId = getWindowId();
  const savedSessions = SessionStore.getWindowSessions(windowId);
  const savedSession = savedSessions.find(s => s.id === id);
  const name = initialName || savedSession?.name || getDefaultTabName(cwd);

  // Store session in memory
  const searchAddon = attachSearchAddon(term);
  sessions.set(id, { term, fit, ws, container, cwd, name, waitingForInput: false, hasUnseenActivity: false, scrollControl, searchAddon });

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
      SessionStores.reorder(getWindowId(), orderedIds);
      notifyTabsChanged();
      onOverviewTabsReordered(orderedIds);
    },
    getLiveWindows: () => WindowManager.getLiveWindows(),
    onSendToWindow: (sessionId, targetWindowId) => sendToWindow(sessionId, targetWindowId),
    onFork: (sessionId) => {
      const session = sessions.get(sessionId);
      const sessionCwd = session?.cwd || '~';
      createSession(sessionCwd, null, true, { fork: sessionId, name: session?.name });
    },
    getSessionType: () => 'terminal',
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
  //
  // A background open (an unattended scheduled run, #600) is the exception: the
  // tab lands inactive so the user isn't yanked out of what they were doing —
  // focusTab() would also drag the context rail to the new tab's context. It
  // still takes focus when nothing is active yet, since an inactive lone tab
  // would leave a blank pane behind a hidden empty state. The unseen badge is
  // what makes it discoverable; switchTo() clears it when the user visits.
  if (!restoreActive && (!background || !activeId)) {
    focusTab(id); // switch to the new tab + jump to its context / All (#547/#559)
  } else if (background) {
    const sess = sessions.get(id);
    if (sess) sess.hasUnseenActivity = true;
    TabManager.updateBadge(id, true);
  }

  // Per-tab store (sessionStorage) is truth for this tab, SessionStore (localStorage)
  // is for cross-tab; the facade writes both in one call (#385).
  SessionStores.add(windowId, { id, cwd, name });
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
      // Heal the mismatched-size case (#566): if the PTY's size differs from
      // this freshly-created xterm (window resized/zoomed while away, PTY sized
      // by another window, or respawned at stale dims after a daemon restart),
      // a real resize triggers SIGWINCH → Ink redraws a clean current frame.
      // If sizes match, TIOCSWINSZ with no change emits no SIGWINCH — harmless.
      // A bare resize (not fitTerminal) also heals hidden/background tabs, whose
      // 0×0 containers FitAddon and the ResizeObserver can't measure.
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } else {
      scrollControl.scrollToBottom();
      ws.send(JSON.stringify({ type: 'redraw' }));
    }
  });

  updateEmptyState();

  // Notify mods of session list change
  notifyTabsChanged();
}

/**
 * Create a mod tab (client-only, no PTY or WebSocket).
 */
function createModTab(modId, opts = {}) {
  const mod = ModManager.getNewTabItems().find(m => m.modId === modId);
  if (!mod) {
    // Mod disabled or removed — clean up stale storage if restoring
    if (opts.id) {
      SessionStores.remove(getWindowId(), opts.id);
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
  let iframeSrc = `/mods/${modId}/${mod.entry}`;
  if (opts.url) iframeSrc += `?url=${encodeURIComponent(opts.url)}`;
  iframe.src = iframeSrc;
  iframe.style.cssText = 'width:100%;height:100%;border:none;';
  iframe.sandbox = 'allow-same-origin allow-scripts allow-forms allow-popups';
  container.appendChild(iframe);

  // Inject bridge API so tab mods can register MCP callbacks (e.g. Baby Browser tools)
  iframe.addEventListener('load', () => {
    ModManager.injectBridgeAPI(iframe, modId, id);
  });

  sessions.set(id, {
    term: null, fit: null, ws: null, container, cwd: null,
    name, waitingForInput: false, hasUnseenActivity: false, scrollControl: null,
    type: 'mod-tab', modId,
  });

  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      SessionStores.reorder(getWindowId(), orderedIds);
      notifyTabsChanged();
      onOverviewTabsReordered(orderedIds);
    },
    getLiveWindows: () => [],
    onSendToWindow: () => {},
    onFork: () => {},
    getSessionType: () => 'mod-tab',
    getModMenuItems: () => [],
  };

  TabManager.addTab(id, name, tabCallbacks);
  updateEmptyState();

  if (!opts.restoreActive) {
    switchTo(id);
  }

  // Persist
  const windowId = getWindowId();
  SessionStores.add(windowId, { id, name, type: 'mod-tab', modId });

  // Forward resize events to iframe
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    iframe.contentWindow?.postMessage({ type: 'resize', width, height }, '*');
  });
  ro.observe(container);
  sessions.get(id).resizeObserver = ro;

  notifyTabsChanged();
}

/**
 * Create a display tab (agent-generated HTML in a sandboxed iframe, no PTY).
 */
function createDisplayTab(id, name, opts = {}) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const iframe = document.createElement('iframe');
  iframe.src = `/api/display-tab/${id}`;
  iframe.style.cssText = 'width:100%;height:100%;border:none;';
  iframe.sandbox = 'allow-scripts allow-forms allow-same-origin';
  iframe.allow = 'autoplay';
  container.appendChild(iframe);

  const tabName = name || 'Display';
  // cwd = the spawning session's dir, so Context Views scopes this tab to the
  // context it was created from (#530). null → global (e.g. saved-layout tabs).
  const cwd = opts.cwd || null;
  sessions.set(id, {
    term: null, fit: null, ws: null, container, cwd,
    name: tabName, waitingForInput: false, hasUnseenActivity: false, scrollControl: null,
    type: 'display-tab', emittingAudio: false,
  });

  SessionStores.add(getWindowId(), { id, name: tabName, type: 'display-tab', cwd });

  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      SessionStores.reorder(getWindowId(), orderedIds);
      notifyTabsChanged();
      onOverviewTabsReordered(orderedIds);
    },
    getLiveWindows: () => WindowManager.getLiveWindows(),
    onSendToWindow: (sessionId, targetWindowId) => sendToWindow(sessionId, targetWindowId),
    onFork: () => {},
    getSessionType: () => 'display-tab',
    getModMenuItems: () => [],
  };

  TabManager.addTab(id, tabName, tabCallbacks);
  updateEmptyState();
  if (!opts.restoreActive) {
    focusTab(id); // (#547/#559)
  }

  // Forward resize events to iframe
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    iframe.contentWindow?.postMessage({ type: 'resize', width, height }, '*');
  });
  ro.observe(container);
  sessions.get(id).resizeObserver = ro;

  notifyTabsChanged();
}

// Display tabs post {type:'ds-audio-state', tabId, emitting} from the detector script
// injected by the server. Toggle a speaker icon on the matching tab. The icon reflects
// audio state regardless of which tab is active (unlike the unread .badge).
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'ds-audio-state') return;
  const s = sessions.get(d.tabId);
  if (!s || s.type !== 'display-tab') return;
  s.emittingAudio = !!d.emitting;
  TabManager.updateSpeakerIcon(d.tabId, s.emittingAudio);
});

/**
 * Switch to a specific session tab
 */
function switchTo(id) {
  // If mod view is active, delegate to ModManager to show terminal with back button
  if (ModManager.isModViewVisible()) {
    ModManager.showTerminalForSession(id);
    return;
  }

  closeTerminalSearch();

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
  noteActiveTab(id); // remember as the active context's last-viewed tab (#541)
  updateOverviewFocus(id);
  ModManager.notifyActiveSessionChanged(id);
  const session = sessions.get(id);
  if (session) {
    session.container.classList.add('active');
    TabManager.setActive(id);
    // Clear badge and notification when switching to this tab —
    // viewing the tab acknowledges any unseen activity.
    session.hasUnseenActivity = false;
    TabManager.updateBadge(id, false);
    clearNotification(id);
    updateTitle();
    updateAppBadge();

    if (session.type === 'mod-tab' || session.type === 'display-tab') return;

    setHashCommandsWaiting(!!session.waitingForInput);
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

// User-initiated jump to an EXISTING tab: activate it AND bring its context into
// view (#559). Distinct from switchTo(), which stays context-neutral so the
// close-tab fallback and applyFilter's snap-back can land on a hidden neighbor
// without changing your context. Every "go to this tab" affordance (Action
// Required + other mods, cross-window focus, restore, new tabs) routes here;
// switchTo() is only for mechanical/internal activations. Do NOT merge the two —
// revealing inside switchTo() would let closing a tab teleport you into the
// DOM-adjacent neighbor's context.
function focusTab(id) {
  switchTo(id);
  revealTabContext(id);
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

  // Pre-create placeholder tab stubs in correct order for instant visual feedback
  for (const entry of sessionList) {
    if (!(entry.type === 'mod-tab' && entry.modId)) {
      const name = entry.name || getDefaultTabName(entry.cwd);
      TabManager.addPlaceholderTab(entry.id, name);
    }
  }
  updateEmptyState();

  // Connect all sessions in parallel — placeholders are upgraded by initTerminal's addTab()
  const promises = sessionList.map(entry => {
    if (entry.type === 'display-tab') {
      return fetch(`/api/display-tab/${entry.id}`, { method: 'HEAD' })
        .then(resp => {
          if (resp.ok) {
            createDisplayTab(entry.id, entry.name, { restoreActive: true, cwd: entry.cwd });
            return entry.id;
          }
          return null; // server no longer has it
        })
        .catch(() => null);
    } else if (entry.type === 'mod-tab' && entry.modId) {
      createModTab(entry.modId, { id: entry.id, name: entry.name, restoreActive: true });
      return Promise.resolve(entry.id);
    } else {
      return createSession(entry.cwd, entry.id, false, { name: entry.name, restoreActive: true, allowDuplicate });
    }
  });

  const results = await Promise.all(promises);

  // Clean up rejected sessions
  results.forEach((resolvedId, i) => {
    if (resolvedId === null) {
      const entry = sessionList[i];
      console.log('[restore] Session', entry.id, 'rejected (duplicate), cleaning up storage');
      SessionStores.remove(getWindowId(), entry.id);
      TabManager.removeTab(entry.id);
    }
  });

  const target = savedActiveId && sessions.has(savedActiveId)
    ? savedActiveId
    : sessions.keys().next().value;
  if (target) {
    if (target === savedActiveId) {
      console.log('[restore] Selecting saved active tab', target);
    } else {
      console.log('[restore] Saved active tab', savedActiveId, 'not found, falling back to', target);
    }
    focusTab(target); // reveal the restored tab's context if it diverges from the saved one (#559)
  }

  // Re-apply the context filter once all tabs exist and the active tab is
  // chosen — if the saved active tab isn't in the active context, this moves
  // to the first in-context tab.
  refreshContextFilter();
}

/**
 * The recover-everything restore flow (#560), shared by the startup offer, the
 * command palette, the ▾ new-tab menu, and the empty-state button.
 * Returns 'restored' | 'fresh' (declined / nothing usable) | 'none' (nothing
 * to offer at all).
 */
let restoreOfferOpen = false;
async function offerSessionRestore({ secondaryLabel, onlyIfOrphans = false } = {}) {
  if (restoreOfferOpen) return 'fresh';
  restoreOfferOpen = true;
  try {
    const data = await WindowManager.listRecoverable();
    if (data.windows.length + data.ungrouped.length + data.closed.length + data.recents.length === 0) {
      return 'none';
    }
    // Startup auto-show gate: closed tombstones / recents alone don't warrant
    // interrupting a brand-new window (see the init call site).
    if (onlyIfOrphans && data.windows.length + data.ungrouped.length === 0) {
      return 'none';
    }
    const result = await showSessionRestoreModal(data, { secondaryLabel });
    if (result.action !== 'restore') return 'fresh';

    const myWindowId = getWindowId();
    // A selected session can already be open in this window (stale localStorage
    // while the server fetch failed, say). Restoring it again would create a
    // second tab-<id> DOM node, and the duplicate-attach cleanup would then
    // tear down the LIVE tab — so filter against the live map, and dedupe
    // across buckets.
    const seen = new Set(sessions.keys());
    const toRestore = [];
    const take = (sess) => {
      if (!sess || seen.has(sess.id)) return;
      seen.add(sess.id);
      toRestore.push(sess);
    };

    for (const win of result.selection.windows) {
      for (const sess of WindowManager.claimSessions(win, win.sessions)) take(sess);
    }
    for (const sess of result.selection.sessions) {
      SessionStore.addSession(myWindowId, { id: sess.id, cwd: sess.cwd, name: sess.name });
      take(sess);
    }
    // Recents lineages have no state.json record — the server mints a fresh id
    // and pre-seeds savedState; the normal reconnect path then resumes it.
    for (const r of result.selection.recents) {
      try {
        const resp = await fetch(`/api/recent-sessions/${encodeURIComponent(r.key)}/restore`, { method: 'POST' });
        if (!resp.ok) continue;
        const restored = await resp.json();
        SessionStore.addSession(myWindowId, { id: restored.id, cwd: restored.cwd, name: restored.name });
        take(restored);
      } catch {
        // ring buffer changed under us — skip this one, the rest still restore
      }
    }

    if (toRestore.length === 0) return 'fresh';
    for (const sess of toRestore) SessionStores.addTabOnly(sess);
    await restoreSessions(toRestore, { allowDuplicate: false });
    return 'restored';
  } finally {
    restoreOfferOpen = false;
  }
}

/**
 * Re-entry surfaces (palette, ▾ menu, empty state): the user explicitly asked
 * for the view, so declining must NOT dump them into the directory picker the
 * way the startup path does, and an empty result deserves feedback.
 */
async function reopenSessionRestore() {
  const outcome = await offerSessionRestore({ secondaryLabel: 'Cancel' });
  if (outcome === 'none') showToast('No sessions to restore');
}

/**
 * Show confirmation dialog if agent is busy. Returns true if close should proceed.
 * For locally-connected sessions, checks in-memory state. For server-only sessions
 * (dropdown), fetches state from the server.
 */
function confirmCloseSession(id) {
  const session = sessions.get(id);
  // Mod tabs are config UIs — always allow close
  if (session?.type === 'mod-tab') return Promise.resolve(true);
  // Display tabs hold non-recoverable agent-generated HTML
  if (session?.type === 'display-tab') return showCloseDisplayTabDialog();

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

function showCloseDisplayTabDialog() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>Close display tab?</h2>
        <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:16px;">This tab's contents will be lost and cannot be recovered.</p>
        <div class="modal-buttons">
          <button class="btn-secondary" id="close-display-cancel">Cancel</button>
          <button class="btn-danger" id="close-display-ok">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('#close-display-cancel').onclick = () => cleanup(false);
    overlay.querySelector('#close-display-ok').onclick = () => cleanup(true);
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
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    resolve(result);
  };
  overlay.querySelector('#restart-confirm-cancel').onclick = () => cleanup(false);
  overlay.querySelector('#restart-confirm-ok').onclick = () => cleanup(true);
  const onKey = (e) => {
    // Stop all key events from reaching the terminal while modal is open
    e.stopPropagation();
    e.preventDefault();
    if (e.key === 'Enter') cleanup(true);
    else if (e.key === 'Escape') cleanup(false);
  };
  document.addEventListener('keydown', onKey, true);

  return { promise, dismiss: cleanup };
}

// Meta Controls consent (#519): an agent called meta_type while the setting is
// off. The server holds the pending tool call while every window shows this
// dialog; the first decision wins (POST /api/meta-controls-consent) and the
// server broadcasts confirm-meta-controls-resolved so other windows' copies
// dismiss. Approving flips the persistent metaControlsEnabled setting — exactly
// what the Settings toggle does.
let metaConsentDialog = null;

function dismissMetaControlsConsentDialog() {
  if (metaConsentDialog) metaConsentDialog.dismiss();
}

function showMetaControlsConsentDialog(msg) {
  dismissMetaControlsConsentDialog(); // never stack two

  const requesterName = msg.requester?.name || msg.requester?.id || 'An agent';
  const targetName = msg.target?.name || msg.target?.id || 'a session';
  const isSelf = !!msg.requester?.id && msg.requester.id === msg.target?.id;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Enable Meta Controls?</h2>
      <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:8px;">
        Agent session <strong id="meta-consent-requester"></strong> wants to type into
        <span id="meta-consent-target-wrap">session <strong id="meta-consent-target"></strong></span>,
        which requires the <strong>Meta Controls</strong> setting (currently off).
      </p>
      <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:16px;">
        Meta Controls lets agents send keystrokes to any session — including their own,
        which enables self-driving loops. Enabling it keeps the setting on until you turn
        it off in Settings.
      </p>
      <div class="modal-buttons">
        <button class="btn-secondary" id="meta-consent-cancel">Cancel</button>
        <button class="btn-primary" id="meta-consent-ok">Enable</button>
      </div>
    </div>`;
  // Session names are user data — set via textContent, never interpolated HTML.
  overlay.querySelector('#meta-consent-requester').textContent = requesterName;
  if (isSelf) {
    overlay.querySelector('#meta-consent-target-wrap').textContent = 'its own terminal';
  } else {
    overlay.querySelector('#meta-consent-target').textContent = targetName;
  }
  document.body.appendChild(overlay);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    metaConsentDialog = null;
  };
  const decide = (decision) => {
    cleanup();
    fetch('/api/meta-controls-consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).catch(() => {});
  };
  overlay.querySelector('#meta-consent-cancel').onclick = () => decide('declined');
  overlay.querySelector('#meta-consent-ok').onclick = () => decide('confirmed');
  const onKey = (e) => {
    // Stop all key events from reaching the terminal while the modal is open.
    e.stopPropagation();
    e.preventDefault();
    // Deliberately no Enter→approve: enabling a security gate takes a click.
    if (e.key === 'Escape') decide('declined');
  };
  document.addEventListener('keydown', onKey, true);

  metaConsentDialog = { dismiss: cleanup };
}

function showReloadOverlay() {
  const overlay = document.createElement('div');
  // Scope to #terminals (not the viewport) so this centers on the same box as the
  // per-terminal "Reconnecting..." overlay, regardless of which side rails/panels are open (#572).
  overlay.className = 'reload-overlay';
  overlay.style.cursor = 'default';
  overlay.innerHTML = `
    <div style="text-align:center;">
      <div class="reload-spinner"></div>
      <div style="color:var(--ds-text-bright);font-size:16px;font-weight:600;margin-top:16px;">Restarting...</div>
    </div>`;
  (document.getElementById('terminals') || document.body).appendChild(overlay);
}

function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.type === 'mod-tab' || session.type === 'display-tab') {
    // Mod/display tabs: no PTY/WS to clean up
    if (session.type === 'display-tab') {
      fetch(`/api/display-tab/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    if (session.resizeObserver) session.resizeObserver.disconnect();
    session.container.remove();
  } else {
    // Tell server to close this client's connection to the shell.
    // If no other clients are connected, the server kills the shell immediately.
    // If other clients remain, the shell stays alive for them.
    try { session.ws.sendJSON({ type: 'close-session' }); } catch {}

    if (session.resizeObserver) session.resizeObserver.disconnect();
    // Untrack reconnect state before closing (#556): wrapper.close() stops the
    // retry loop without firing onreconnected, so a tab closed mid-outage
    // would otherwise pin the connection-lost banner forever.
    session.connHandle?.untrack();
    session.ws.close();
    session.term.dispose();
    session.container.remove();
  }

  // Compute adjacent tab BEFORE removing from DOM
  const nextId = (activeId === id) ? TabManager.getAdjacentTabId(id) : null;

  TabManager.removeTab(id);
  sessions.delete(id);

  SessionStores.remove(getWindowId(), id);

  // Switch to adjacent tab (left preferred, then right)
  if (activeId === id) {
    if (nextId && sessions.has(nextId)) {
      switchTo(nextId);
    } else {
      activeId = null;
      ActiveTab.clear();
      ModManager.notifyActiveSessionChanged(null);
    }
  }

  updateEmptyState();

  // Notify mods of session list change
  notifyTabsChanged();
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
      type: session.type || 'terminal',
      cwd: session.cwd,
      name: session.name
    });
  } catch (err) {
    // Target window didn't ack — keep the session
    console.warn(`Send to window failed: ${err.message}. Keeping session.`);
    return;
  }

  // Ack received — clean up locally (no server DELETE — shell stays alive for 30s grace period;
  // display-tab HTML stays on disk so the target window can fetch it)
  if (session.resizeObserver) session.resizeObserver.disconnect();
  session.connHandle?.untrack(); // see killSession (#556)
  if (session.ws) session.ws.close();
  if (session.term) session.term.dispose();
  session.container.remove();

  // Compute adjacent tab BEFORE removing from DOM
  const nextId = (activeId === id) ? TabManager.getAdjacentTabId(id) : null;

  TabManager.removeTab(id);
  sessions.delete(id);

  SessionStores.remove(getWindowId(), id);

  // Switch to adjacent tab (left preferred, then right)
  if (activeId === id) {
    if (nextId && sessions.has(nextId)) {
      switchTo(nextId);
    } else {
      activeId = null;
      ActiveTab.clear();
      ModManager.notifyActiveSessionChanged(null);
    }
  }

  updateEmptyState();
  notifyTabsChanged();
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
    SessionStores.rename(getWindowId(), id, name);
    // Tell server so it persists across tab close/restore (skip for mod tabs — no WS)
    if (session.ws) session.ws.sendJSON({ type: 'rename', name });
    notifyTabsChanged();
  });
}

/**
 * Quick new session in same repo as active session
 */
function quickNewSession() {
  // If a context is selected and the active tab isn't already inside it, open
  // the new tab in the context's repo instead (folder-based context, #522).
  if (requestNewTabInContext()) return;
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || '~';
  // Pass the active tab as the parent so the new tab can inherit its /rc state.
  createSession(cwd, null, true, { agentType: getDefaultAgentType(), rcParent: activeId });
}

function quickNewTerminal() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || '~';
  createSession(cwd, null, true, { agentType: 'terminal' });
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

  // Write the LABEL, never the button. #engines-btn is the only nav button with a dynamic label, and
  // `btn.textContent = …` would take .btn-icon down with it — the icon is markup-owned inline SVG
  // (the cloneNode above deliberately preserves it), so the button would lose its icon here on load
  // and again on every hover (#552). aria-label tracks the label so the accessible name matches
  // what's on screen even in the collapsed rail, where .btn-label is display:none and the name would
  // otherwise silently fall back to the title.
  const setEngineLabel = (text) => {
    btn.querySelector('.btn-label').textContent = text;
    btn.setAttribute('aria-label', text);
  };

  // Update button text (short name by default, full name on hover)
  const currentAgent = agents.find(a => a.id === window.__deepsteveDefaultAgent);
  setEngineLabel(currentAgent?.shortName || currentAgent?.name || 'Engine');
  btn.title = currentAgent?.name || 'Engine';

  btn.addEventListener('mouseenter', () => {
    const a = agents.find(a => a.id === window.__deepsteveDefaultAgent);
    setEngineLabel(a?.name || 'Engine');
  });
  btn.addEventListener('mouseleave', () => {
    const a = agents.find(a => a.id === window.__deepsteveDefaultAgent);
    setEngineLabel(a?.shortName || a?.name || 'Engine');
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
      setEngineLabel(newDefault?.name || 'Engine');
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

// Close fn for the currently-open new-tab menu, or null — single source of truth so a
// repeat press of the trigger toggles the menu closed instead of reopening it (#574).
let newTabMenuCloser = null;

/**
 * Show dropdown menu for new tab options (recent repos + actions)
 */
function showNewTabMenu(e) {
  // Toggle: a repeat press of the trigger (the ▾, or the rail long-press/right-click
  // on +) while the menu is open closes it instead of reopening (#574).
  if (newTabMenuCloser) { newTabMenuCloser(); return; }
  // Defensive: drop any stray menu that lost its tracker (shouldn't happen).
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

  // Build recent dirs section. With a context active (#573), the context's repos
  // are listed first (in stored order), then a separator, then the remaining
  // recents — ordering, not filtering. "All" / disabled → identical to before.
  const recentDirs = SessionStore.getRecentDirs();
  const INITIAL_SHOW = 10;
  const MORE_INCREMENT = 20;
  const ctxInfo = getActiveContextInfo();               // { name, dirs } | null
  const { contextGroup, rest } =
    orderRecentDirsByContext(ctxInfo ? ctxInfo.dirs : [], recentDirs);
  // Single easy-to-change spot for the top-group header text (empty → no header).
  const ctxHeaderLabel = ctxInfo ? ctxInfo.name : '';
  let recentShown = 0;

  // Disambiguate duplicate leaf names across BOTH groups by appending parent dir.
  const leafCounts = {};
  for (const d of [...contextGroup, ...rest]) {
    const leaf = d.path.split('/').pop();
    leafCounts[leaf] = (leafCounts[leaf] || 0) + 1;
  }
  const dirItemHtml = (d) => {
    const parts = d.path.split('/');
    const leaf = parts.pop();
    const label = leafCounts[leaf] > 1 && parts.length > 0
      ? `${leaf} (${parts.pop()})`
      : leaf;
    const p = d.path.replace(/"/g, '&quot;');
    return `<div class="context-menu-item" data-action="recent" data-path="${p}" title="${p}">${label}</div>`;
  };

  // Top group: the active context's repos (all of them, stored order).
  if (contextGroup.length > 0) {
    if (ctxHeaderLabel) html += `<div class="context-menu-header">${escapeHtml(ctxHeaderLabel)}</div>`;
    for (const d of contextGroup) html += dirItemHtml(d);
    html += '<div class="context-menu-separator"></div>';
  }

  // Bottom group: the rest of the recents (paginated, as before).
  if (rest.length > 0) {
    html += '<div class="context-menu-header">Recent</div>';
    const initialSlice = rest.slice(0, INITIAL_SHOW);
    recentShown = initialSlice.length;
    for (const d of initialSlice) html += dirItemHtml(d);
    if (rest.length > INITIAL_SHOW) {
      html += `<div class="context-menu-item context-menu-more" data-action="more">More...</div>`;
    }
    html += '<div class="context-menu-separator" id="recent-dirs-separator"></div>';
  }
  html += `
    <div class="context-menu-item" data-action="worktree">New worktree...</div>
    <div class="context-menu-item" data-action="repo">New tab in repo...</div>
    <div class="context-menu-item" data-action="terminal">New terminal</div>
    <div class="context-menu-item context-menu-has-submenu" id="tmux-attach-trigger">Attach tmux session <span class="context-menu-arrow"></span></div>
  `;

  // Add automations section
  html += '<div class="context-menu-separator"></div>';
  html += '<div class="context-menu-header">Automations</div>';
  for (const auto of cachedAutomations) {
    const icon = auto.icon || '\u26A1';
    const label = `${icon} ${auto.name}`;
    html += `<div class="context-menu-item" data-action="automation" data-automation-id="${auto.id.replace(/"/g, '&quot;')}">${label}</div>`;
  }
  html += '<div class="context-menu-item" data-action="manage-automations">Manage Automations\u2026</div>';

  // Add mod tab items
  const modTabItems = ModManager.getNewTabItems();
  if (modTabItems.length > 0) {
    html += '<div class="context-menu-separator"></div>';
    for (const item of modTabItems) {
      html += `<div class="context-menu-item" data-action="mod-tab" data-mod-id="${item.modId}">${item.label}</div>`;
    }
  }

  // New window + session recovery options
  html += '<div class="context-menu-separator"></div>';
  html += '<div class="context-menu-item" data-action="new-window">New window</div>';
  html += '<div class="context-menu-item" data-action="restore-sessions">Restore sessions…</div>';

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

  // Set up tmux attach submenu
  const tmuxTrigger = menu.querySelector('#tmux-attach-trigger');
  let tmuxSubmenu = null;
  if (tmuxTrigger) {
    let tmuxHideTimer = null;
    const hideTmuxSubmenu = () => { if (tmuxSubmenu) { tmuxSubmenu.remove(); tmuxSubmenu = null; } };
    const delayedHideTmux = () => { tmuxHideTimer = setTimeout(hideTmuxSubmenu, 100); };
    const cancelHideTmux = () => { clearTimeout(tmuxHideTimer); };

    const showTmuxSubmenu = async () => {
      cancelHideTmux();
      if (tmuxSubmenu) return;
      tmuxSubmenu = document.createElement('div');
      tmuxSubmenu.className = 'context-menu context-submenu';
      tmuxSubmenu.innerHTML = '<div class="context-menu-item" style="opacity:0.5;pointer-events:none">Loading...</div>';
      document.body.appendChild(tmuxSubmenu);
      const triggerRect = tmuxTrigger.getBoundingClientRect();
      tmuxSubmenu.style.left = (triggerRect.right + 2) + 'px';
      tmuxSubmenu.style.top = triggerRect.top + 'px';

      try {
        const data = await fetch('/api/tmux-sessions').then(r => r.json());
        if (!tmuxSubmenu) return; // closed while fetching
        const sessions = data.sessions || [];
        if (sessions.length === 0) {
          tmuxSubmenu.innerHTML = '<div class="context-menu-item" style="opacity:0.5;pointer-events:none">No tmux sessions</div>';
        } else {
          tmuxSubmenu.innerHTML = sessions.map(s => {
            const label = s.attached ? `${s.name} (attached)` : s.name;
            return `<div class="context-menu-item" data-tmux-session="${s.name.replace(/"/g, '&quot;')}">${label}</div>`;
          }).join('');
          tmuxSubmenu.addEventListener('click', (ev) => {
            const item = ev.target.closest('.context-menu-item');
            if (!item || !item.dataset.tmuxSession) return;
            ev.stopPropagation();
            const sessionName = item.dataset.tmuxSession;
            close();
            createTmuxAttachSession(sessionName);
          });
        }
        // Reposition in case size changed
        const subRect = tmuxSubmenu.getBoundingClientRect();
        if (subRect.right > window.innerWidth) {
          tmuxSubmenu.style.left = (triggerRect.left - subRect.width - 2) + 'px';
        }
        if (subRect.bottom > window.innerHeight) {
          tmuxSubmenu.style.top = (window.innerHeight - subRect.height - 8) + 'px';
        }
      } catch {
        if (tmuxSubmenu) tmuxSubmenu.innerHTML = '<div class="context-menu-item" style="opacity:0.5;pointer-events:none">tmux not available</div>';
      }
      if (tmuxSubmenu) {
        tmuxSubmenu.addEventListener('mouseenter', cancelHideTmux);
        tmuxSubmenu.addEventListener('mouseleave', delayedHideTmux);
      }
    };

    tmuxTrigger.addEventListener('mouseenter', showTmuxSubmenu);
    tmuxTrigger.addEventListener('mouseleave', delayedHideTmux);
    tmuxTrigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      tmuxSubmenu ? hideTmuxSubmenu() : showTmuxSubmenu();
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
    // "More" button: append next batch of the remaining recents (the `rest`
    // group — context repos above the separator are shown in full) (#573).
    if (action === 'more') {
      ev.stopPropagation();
      const moreBtn = item;
      const nextSlice = rest.slice(recentShown, recentShown + MORE_INCREMENT);
      recentShown += nextSlice.length;
      const separator = menu.querySelector('#recent-dirs-separator');
      for (const d of nextSlice) {
        const parts = d.path.split('/');
        const leaf = parts.pop();
        const label = leafCounts[leaf] > 1 && parts.length > 0
          ? `${leaf} (${parts.pop()})`
          : leaf;
        const el = document.createElement('div');
        el.className = 'context-menu-item';
        el.dataset.action = 'recent';
        el.dataset.path = d.path;
        el.title = d.path;
        el.textContent = label;
        menu.insertBefore(el, moreBtn);
      }
      if (recentShown >= rest.length) {
        moreBtn.remove();
      }
      // Re-check if menu extends off-screen after adding items
      const updatedRect = menu.getBoundingClientRect();
      if (updatedRect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - updatedRect.height - 8) + 'px';
      }
      return;
    }
    close();
    if (action === 'recent') {
      createSession(item.dataset.path, null, true, { agentType: getDefaultAgentType() });
    } else if (action === 'terminal') {
      quickNewTerminal();
    } else if (action === 'worktree') {
      await promptWorktreeSession();
    } else if (action === 'repo') {
      await promptRepoSession();
    } else if (action === 'automation') {
      fetch('/api/start-automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automationId: item.dataset.automationId, windowId: getWindowId() }),
      }).catch(err => console.error('Failed to start automation:', err));
    } else if (action === 'manage-automations') {
      ModManager.showAutomationsModal();
    } else if (action === 'mod-tab') {
      createModTab(item.dataset.modId);
    } else if (action === 'opencode') {
      const active = activeId && sessions.get(activeId);
      const cwdPath = active?.cwd || '~';
      createSession(cwdPath, null, true, { agentType: 'opencode' });
    } else if (action === 'new-window') {
      openNewWindow();
    } else if (action === 'restore-sessions') {
      reopenSessionRestore();
    }
  };

  menu.addEventListener('click', selectItem);

  // Close on outside click. The trigger button subtree (btn) counts as "inside" so its
  // mousedown never pre-closes the menu — that lets the click/contextmenu-time toggle at
  // the top of showNewTabMenu decide, which is what makes a repeat press close it (#574).
  const close = () => {
    menu.remove();
    if (submenu) submenu.remove();
    if (tmuxSubmenu) tmuxSubmenu.remove();
    document.removeEventListener('mousedown', closeHandler);
    newTabMenuCloser = null;
  };
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target) && !(submenu && submenu.contains(ev.target)) && !(tmuxSubmenu && tmuxSubmenu.contains(ev.target)) && !btn.contains(ev.target)) {
      close();
    }
  };
  newTabMenuCloser = close;
  setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
}

/**
 * Wire the "+" (#new-btn): plain click opens the default tab, and — in the collapsed icon rail,
 * where CSS hides the ▾ caret (#new-btn-dropdown) — long-press and right-click open the same
 * new-tab menu the ▾ opens elsewhere (#567). Gated to the rail: in horizontal / expanded-vertical
 * the visible ▾ is the affordance, so + keeps its plain click and the native context menu there.
 *
 * Click, contextmenu, and long-press share one owner so they can share the `longPressFired` flag —
 * cleaner than suppressing the post-long-press click across separate listeners by phase ordering.
 */
function wireNewTabGestures() {
  const newBtn = document.getElementById('new-btn');
  if (!newBtn) return;
  const inIconRail = () => document.getElementById('app-container')?.classList.contains('icon-rail');

  let longPressFired = false;

  // Plain click — open the default tab, unless a long-press just opened the menu.
  newBtn.addEventListener('click', () => {
    if (longPressFired) { longPressFired = false; return; }
    quickNewSession();
  });

  // Right-click — rail only; elsewhere let the native menu show and the ▾ do the job.
  newBtn.addEventListener('contextmenu', (e) => {
    if (!inIconRail()) return;
    e.preventDefault();
    showNewTabMenu(e); // anchors via #new-btn-group, flyout-right (showNewTabMenu's vertical branch)
  });

  // Long-press (mouse + touch) — rail only. Mirrors tab-manager's pointer skeleton with a hold timer.
  const LONG_PRESS_MS = 500;
  const MOVE_SLOP = 8;
  let pressTimer = null;
  const onDown = (e) => {
    if (!inIconRail()) return;
    if (e.type === 'mousedown' && e.button !== 0) return; // left only; right-click handled above
    const sx = e.touches ? e.touches[0].clientX : e.clientX;
    const sy = e.touches ? e.touches[0].clientY : e.clientY;
    longPressFired = false; // reset every press so a click-less touch long-press can't swallow a later click
    const onMove = (me) => {
      const cx = me.touches ? me.touches[0].clientX : me.clientX;
      const cy = me.touches ? me.touches[0].clientY : me.clientY;
      if (Math.abs(cx - sx) > MOVE_SLOP || Math.abs(cy - sy) > MOVE_SLOP) cancel();
    };
    const cancel = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', cancel);
      document.removeEventListener('touchend', cancel);
    };
    pressTimer = setTimeout(() => {
      longPressFired = true; // suppresses the click that follows the release
      showNewTabMenu(e);
      cancel();
      // Lifting a finger after a touch long-press synthesizes mousedown→mouseup→click on the
      // button AFTER the menu is already open. showNewTabMenu closes on an outside mousedown, so
      // swallow that one synthetic mousedown if it lands on the button — otherwise touch long-press
      // opens then instantly dismisses. Mouse press-hold ends with mouseup only (no mousedown), so
      // this one-shot capture listener simply falls through and removes itself there.
      const swallowSynthetic = (me) => {
        if (newBtn.contains(me.target)) me.stopPropagation();
        document.removeEventListener('mousedown', swallowSynthetic, true);
      };
      document.addEventListener('mousedown', swallowSynthetic, true);
    }, LONG_PRESS_MS);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', cancel);
    document.addEventListener('touchend', cancel);
  };
  newBtn.addEventListener('mousedown', onDown);
  newBtn.addEventListener('touchstart', onDown, { passive: true });
}

/**
 * Prompt for worktree name and create session
 */
async function promptWorktreeSession() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd;
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
  // Pure directory picker (#575): the per-session "Recent sessions" list was removed —
  // session resume lives on dedicated surfaces (empty-state recents, the ▾ menu's
  // "Restore sessions…" #560 modal, the command palette). With a context active, still
  // surface its repos first as directory quick-picks (#573).
  const ctxInfo = getActiveContextInfo();
  const result = await showDirectoryPicker({
    contextDirs: ctxInfo ? ctxInfo.dirs : [],
    contextLabel: ctxInfo ? ctxInfo.name : '',
  });
  if (result === null) return;
  createSession(result, null, true, { agentType: getDefaultAgentType() });
}

/**
 * Where a window with no tabs should land (#597).
 *
 * The empty state is the landing surface, not a backdrop: it already carries "+ New",
 * the recent-session chips (#533) and "Restore sessions…" (#560). Opening a modal
 * directory picker on top of it is what made the new-window flow unpleasant —
 * cancelling that modal put you exactly where you wanted to be. So prompt only when
 * the empty state is genuinely bare (a first run with no recents), where the picker is
 * onboarding rather than an obstacle. And never prompt right after the user dismissed
 * the restore modal — that is two modals in a row.
 */
async function landWithNoTabs({ declined = false } = {}) {
  await recentSessionsReady;
  if (declined || recentSessions.length > 0) {
    updateEmptyState();
    document.getElementById('empty-state-btn')?.focus();  // so Enter opens a tab
    return;
  }
  await promptRepoSession();
}

/**
 * Escape HTML special characters for safe rendering
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// cwd → git root. Successes only, page lifetime: a `null` must stay retryable
// (a dir can become a repo), and roots don't move in practice. Shared by the
// picker and its hover prefetch so a hover saves the open a round-trip.
const gitRootCache = new Map();

// Prefetch path: resolves or gives up silently. Never alerts.
async function resolveGitRootQuiet(cwd) {
  if (!cwd) return null;
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  try {
    const res = await fetch('/api/git-root?cwd=' + encodeURIComponent(cwd));
    if (!res.ok) return null;
    const root = (await res.json()).root;
    if (root) gitRootCache.set(cwd, root);
    return root || null;
  } catch { return null; }
}

// Interactive path: returns null after telling the user WHY. Only the endpoint's
// own 400 means "not a repo" — blaming git for a 401/500/network failure sent a
// whole debugging session the wrong way (2026-07-15), so every other failure
// reports what actually happened.
async function resolveGitRootLoud(cwd) {
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  try {
    const res = await fetch('/api/git-root?cwd=' + encodeURIComponent(cwd));
    if (res.status === 400) {
      // Name the directory: with the repo now coming from the active context
      // (#598), it may not be the one the user is sitting in.
      alert(`${cwd} is not a git repository.`);
      return null;
    }
    if (!res.ok) {
      const authHint = (res.status === 401 || res.status === 429) ? ' (auth) — try reloading the page' : '';
      alert(`Couldn't check the git repository: server responded ${res.status}${authHint}.`);
      return null;
    }
    const root = (await res.json()).root;
    if (root) gitRootCache.set(cwd, root);
    return root || null;
  } catch (e) {
    alert(`Couldn't check the git repository: ${e && e.message ? e.message : 'network error'} — is the server reachable?`);
    return null;
  }
}

// Guards the user-length prompts below: without it, repeated clicks stack N
// directory pickers and then N issue modals.
let issuePickerOpening = false;

/**
 * Show GitHub issue picker and create worktree session
 */
async function showIssuePicker() {
  if (issuePickerOpening) return;
  // #598 — decide SYNCHRONOUSLY, at event time. The repo comes from the ACTIVE
  // CONTEXT, never from the foreign last-selected tab that an empty context
  // leaves behind as activeId; and activeId / the active context can both change
  // while a prompt is up.
  const decision = resolveContextRepo();
  const contextDirs = decision.kind === 'dirs' ? decision.dirs : [];
  let seedDir = decision.kind === 'dirs'
    ? (decision.dirs.length === 1 ? decision.dirs[0] : null)
    : (decision.kind === 'inherit' ? decision.cwd : null);

  if (!seedDir) {
    issuePickerOpening = true;
    try {
      if (decision.kind === 'dirs') {
        seedDir = await chooseContextDir(decision.dirs, 'Pick issues from…');
      } else {
        // 'ask' (a context with no dirs), or the All view with a mod/display tab
        // (or nothing) open. Pick a dir and CONTINUE into the picker — this used
        // to `return promptRepoSession()`, which silently created a plain session
        // and never showed a single issue (#598).
        const info = getActiveContextInfo();
        seedDir = await showDirectoryPicker({
          contextDirs: info ? info.dirs : [],
          contextLabel: info ? info.name : '',
        });
      }
    } finally { issuePickerOpening = false; }
    if (!seedDir) return;                        // cancelled → create nothing
  }

  let gitRoot = await resolveGitRootLoud(seedDir);
  if (!gitRoot) return;

  // Candidate paths for the repo selector. With a context active it offers that
  // context's repos ONLY — the whole point of #598 is that an unrelated repo must
  // never be one click away from an in-context issue pick. gitRoot itself is
  // always seeded: on the inherit path it may be a `.claude/worktrees/<name>`
  // root (findGitRoot honors a `.git` FILE), which is not one of ctx.dirs, and
  // without an <option> for it the browser would silently select the first one —
  // showing a repo that disagrees with the issues being fetched.
  const allCwds = contextDirs.length
    ? [...new Set([gitRoot, ...contextDirs])]
    : [...new Set([
        gitRoot,
        ...[...sessions.values()].map(s => s.cwd).filter(Boolean),
        ...SessionStore.getRecentDirs().map(d => d.path),
      ])];

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
  let issueObserver = null;  // infinite-scroll IntersectionObserver; hoisted so teardown is centralized here
  new MutationObserver((_, obs) => { if (!overlay.parentNode) { document.removeEventListener('keydown', onEscIssuePicker); issueObserver?.disconnect(); obs.disconnect(); } }).observe(document.body, { childList: true });

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
    const sentinel = list.querySelector('.issue-sentinel');
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
      // Keep the sentinel as the last child so it stays at the bottom.
      if (sentinel) list.insertBefore(el, sentinel);
      else list.appendChild(el);
      bindIssueItem(el);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    const list = overlay.querySelector('.issue-list');
    const sentinel = list?.querySelector('.issue-sentinel');
    if (!sentinel) return;
    loadingMore = true;
    sentinel.classList.add('is-loading');   // reveal the "Loading more…" row while fetching
    currentPage++;
    try {
      const res = await fetch(`/api/issues?cwd=${encodeURIComponent(gitRoot)}&page=${currentPage}`);
      if (!res.ok) return;                   // finally clears the spinner; a later scroll can retry
      const data = await res.json();
      if (!overlay.parentNode) return;       // picker dismissed mid-fetch — do no DOM work
      issues = issues.concat(data.issues);
      hasMore = data.hasMore;
      renderIssues(data.issues);             // items insert BEFORE the sentinel, so no scroll jump
      if (hasMore) {
        // IntersectionObserver only fires on intersection *transitions*, so a sentinel that
        // stays inside root+margin after appending never re-triggers. Re-observing forces a
        // fresh initial callback for the sentinel's CURRENT position, continuing auto-fill
        // until it finally sits out of view — then this same observer catches genuine scroll
        // edges. (observe() on an already-observed target is a no-op, so unobserve first.)
        issueObserver?.unobserve(sentinel);
        issueObserver?.observe(sentinel);
      } else {
        sentinel.remove();
      }
    } finally {
      loadingMore = false;
      if (sentinel.isConnected) sentinel.classList.remove('is-loading');
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
      agentType: getDefaultAgentType(),
      // Show the loading banner + block input while the issue prompt auto-submits,
      // matching the server-initiated /api/start-issue path (#495, #512).
      loading: true
    });
  }

  // Fetch issues and settings in background, update modal when done
  async function fetchAndRender() {
    // Drop any observer from a prior render (e.g. a repo switch) before re-fetching.
    // Runs synchronously before the awaits below, so a stale observer can't fire in between.
    issueObserver?.disconnect();
    issueObserver = null;
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
        // Sentinel drives infinite scroll via IntersectionObserver: fires as
        // soon as it's in the list viewport, which covers both "user scrolled
        // near the bottom" and "initial page doesn't fill the container"
        // (otherwise a scroll listener never fires and we're stuck at page 1).
        const sentinel = document.createElement('div');
        sentinel.className = 'issue-sentinel';
        list.appendChild(sentinel);
        renderIssues(issues);
        if (!hasMore) {
          sentinel.remove();
        } else {
          issueObserver = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) loadMore();
          }, { root: list, rootMargin: '200px' });
          issueObserver.observe(sentinel);
          // Teardown is centralized in the overlay-removal MutationObserver above.
        }
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
  // Fresh window requested (▾ new-tab menu / ⌘K → New Window). This MUST run before
  // the isExistingTab capture below, not merely before getWindowId(): window.open()
  // copies the opener's sessionStorage, so an un-reset fresh window still reports
  // hasExistingWindowId() === true. That made it take the "existing tab" branch and
  // land on the directory picker, never the genuine new-window path (#597).
  //
  // Deliberately scoped to session *identity* — window id, tab list, active tab. The
  // inherited view preferences (deepsteve-context-* , deepsteve-overview-active) are
  // left alone so a window opened from a context lands in that context. Never reach
  // for sessionStorage.clear(): at recursionDepth > 0 (Baby Browser) the storage area
  // is shared with the top-level instance, so it would wipe the parent's real state.
  if (isFreshRequest()) {
    WindowManager.resetWindowId();
    SessionStores.clearTabSessions();
    ActiveTab.clear();
    history.replaceState(null, '', window.location.pathname);
  }

  // Nothing but the fresh-window reset above may precede this: getWindowId() mints and
  // persists the id on first call, so any earlier caller (initLiveReload below passes
  // windowId, and a stray fetch callback could too) makes this read true forever. When
  // that happened the "new tab" branch became unreachable and whole-window restore
  // silently died — the sessions were fine, the modal just never ran (#551).
  const isExistingTab = WindowManager.hasExistingWindowId();

  // Cache available agents and default agent setting for new-tab menu and settings
  fetch('/api/agents').then(r => r.json()).then(data => {
    window.__deepsteveAgents = data.agents || [];
    window.__deepsteveDefaultAgent = data.defaultAgent || 'claude';
    initEnginesDropdown();
  }).catch(() => {});
  fetch('/api/settings').then(r => r.json()).then(s => { window.__deepsteveDefaultAgent = s.defaultAgent || 'claude'; }).catch(() => {});
  refreshAutomationsCache();

  // Initialize layout manager
  LayoutManager.init();

  // Initialize tab scroll arrows
  initTabArrows();

  // Keep macOS pinch-zoom (ctrl-wheel) away from xterm so the browser can zoom
  // over the terminal (#583). Delegated on #terminals; ModManager's #content-row
  // wrap moves the same node, so the listener survives regardless of ordering.
  installTerminalWheelGuard(document.getElementById('terminals'));

  // Initialize mod system
  ModManager.init({
    getSessions: getSessionList,
    getActiveSessionId: () => activeId,
    // Action Required + other mods jump to a session through this bridge; focusTab
    // (not switchTo) so the context rail follows the jump (#559).
    focusSession: focusTab,
    createSession: (cwd, opts) => createSession(cwd, null, true, opts),
    killSession: async (id, opts) => {
      if (opts?.force || await confirmCloseSession(id)) killSession(id);
    },
    getWindowId: () => getWindowId(),
    closeModTabs: (modId) => {
      for (const [id, s] of sessions) {
        if (s.type === 'mod-tab' && s.modId === modId) killSession(id);
      }
    },
    showAutoCycleToast,
    hideAutoCycleToast,
    // Unified groups/contexts (#526): let a panel read + drive the active context.
    getActiveContextId: () => getActiveContextId(),
    setActiveContext: (id) => setActiveContextFromPanel(id),
  });

  // Initialize Context Views (folder-based tab grouping + left panel).
  // Must run after ModManager.init() — the rail mounts as #app-container's first child.
  initContextViews({
    getOrderedTabIds: getAllTabIds,
    getActiveTabId: () => activeId,
    getTabCwd: (id) => sessions.get(id)?.cwd || null,
    getTabName: (id) => {
      const s = sessions.get(id);
      return s?.name || getDefaultTabName(s?.cwd || '');
    },
    switchToTab: switchTo,
    updateEmptyState,
    createSessionInDir: (cwd) => createSession(cwd, null, true, { agentType: getDefaultAgentType() }),
    // Empty context (no dirs) new-tab: prompt the directory picker instead of
    // inheriting the last-active tab's (foreign) cwd (#581). promptRepoSession
    // already surfaces the active context's repos first via #573 ordering.
    promptNewTabDir: () => promptRepoSession(),
    showDirPicker: () => showDirectoryPicker(),
    getRecentDirs: () => SessionStore.getRecentDirs(),
    // Bidirectional group/context sync (#526): tell the scheduled-tasks panel
    // which context is active whenever the rail changes it.
    onActiveContextChanged: (id) => ModManager.notifyActiveContextChanged(id),
    // Overview mode is per-context view state (#590): reconcile the grid once the
    // filter has settled, so switching away hides the old context's tiles (and
    // restores their size) and switching back re-shows that context's grid.
    onContextViewApplied: () => syncOverviewToContext(),
  });

  // File drag-and-drop upload
  initFileDrop({
    getActiveSession: () => {
      if (!activeId) return null;
      const s = sessions.get(activeId);
      if (!s) return null;
      return { id: activeId, cwd: s.cwd, container: s.container, ws: s.ws };
    },
    getSessionByContainerId: (id) => {
      const s = sessions.get(id);
      if (!s) return null;
      return { id, cwd: s.cwd, container: s.container, ws: s.ws };
    }
  });

  // Wake detection (#563): after a system sleep, probe/kick every WebSocket
  // immediately instead of waiting for the browser to notice dead sockets.
  initWakeWatch();

  // Auto-reload browser when server restarts (restart.sh, node --watch, etc.)
  initLiveReload({
    windowId: getWindowId(),
    onMessage: async (msg) => {
      if (msg.type === 'theme') applyTheme(msg.css || '');
      if (msg.type === 'settings') applySettings(msg);
      if (msg.type === 'skills-changed') ModManager.handleSkillsChanged(msg.enabledSkills);
      if (msg.type === 'contexts') {
        applyServerContexts(msg.contexts);
        ModManager.notifyContextsChanged(msg.contexts);
      }
      if (msg.type === 'recent-sessions') {
        recentSessions = msg.sessions || [];
        renderEmptyStateRecent();
      }
      if (msg.type === 'open-session') {
        // Server created a session (e.g. via /api/start-issue) — open a tab for it.
        // noRestore (#596): the server just told us this session exists, so this is
        // never a restore request. If it died in the meantime (a queued unattended
        // run that finished before this window connected), we want a clean "gone",
        // not a resurrected tombstone.
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createSession(msg.cwd, msg.id, false, { name: msg.name, allowDuplicate: true, initialPrompt: msg.initialPrompt, loading: msg.loading, background: msg.background, noRestore: true });
        // A background open (unattended scheduled run, #600) stays silent — the
        // top-of-page progress bar is ambient interruption for work the user
        // didn't just start.
        if (msg.prefill && !msg.background) progressStart(msg.id);
      }
      if (msg.type === 'deliver-prompt') {
        // Async prompt delivery (e.g. GitHub issue fetch completed after tab opened)
        const session = sessions.get(msg.id);
        if (session?.ws) {
          session.ws.sendJSON({ type: 'initialPrompt', text: msg.initialPrompt });
        }
      }
      if (msg.type === 'prompt-submitted') {
        dismissLoadingBanner(msg.id);
        if (msg.prefill) progressDone(msg.id);
      }
      if (msg.type === 'open-display-tab') {
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createDisplayTab(msg.id, msg.name, { cwd: msg.cwd });
      }
      if (msg.type === 'open-browser-tab') {
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        window.open(msg.url, '_blank');
      }
      if (msg.type === 'open-mod-tab') {
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createModTab(msg.modId, { name: msg.name, url: msg.url });
      }
      if (msg.type === 'update-display-tab') {
        const session = sessions.get(msg.id);
        if (session?.type === 'display-tab') {
          const iframe = session.container.querySelector('iframe');
          if (iframe) iframe.src = `/api/display-tab/${msg.id}?t=${Date.now()}`;
          // Clear audio indicator during reload; the reloaded detector re-reports state.
          session.emittingAudio = false;
          TabManager.updateSpeakerIcon(msg.id, false);
        }
      }
      if (msg.type === 'close-display-tab') {
        if (sessions.has(msg.id)) killSession(msg.id);
      }
      if (msg.type === 'version-status') {
        setUpdateAvailableBadge(!!msg.status?.updateAvailable);
        window.dispatchEvent(new CustomEvent('deepsteve:version-status', { detail: msg.status }));
      }
      if (msg.type === 'version-auto-applying') {
        showAutoApplyToast(msg.tag, msg.deadline);
      }
      if (msg.type === 'version-auto-apply-cancelled') {
        hideAutoApplyToast();
      }
      if (msg.type === 'version-applying') {
        hideAutoApplyToast();
        showReloadOverlay();
      }
      if (msg.type === 'confirm-meta-controls') {
        showMetaControlsConsentDialog(msg);
      }
      if (msg.type === 'confirm-meta-controls-resolved') {
        // Decided elsewhere (another window, or the server-side timeout) — dismiss ours.
        dismissMetaControlsConsentDialog();
      }
    },
    onShowRestartConfirm: () => showRestartConfirmDialog(),
    onShowReloadOverlay: () => showReloadOverlay()
  });

  // Initialize Cmd hold mode (tab switching — capture-phase listeners, off by default)
  initCmdHoldMode({
    getOrderedTabIds: getVisibleTabIds,
    getActiveTabId: () => activeId,
    // focusTab, not switchTo: reveal is a no-op under visible-scoping today, but
    // keeps "every deliberate jump reveals its context" true if this ever moves
    // to getAllTabIds (#559).
    switchToTab: focusTab,
  });

  // Initialize the top-of-page progress bar (automation prefill feedback)
  initProgressBar();

  // Initialize Command Palette (Cmd+K by default, on by default)
  initCommandPalette({
    getOrderedTabIds: getVisibleTabIds,
    getActiveTabId: () => activeId,
    getTabName: (id) => {
      const s = sessions.get(id);
      return s?.name || getDefaultTabName(s?.cwd || '');
    },
    // focusTab, not switchTo: no-op reveal under visible-scoping today, but keeps
    // the "every deliberate jump reveals its context" invariant (#559).
    switchToTab: focusTab,
    quickNewSession,
    quickNewTerminal,
    createSession: (cwd, opts) => createSession(cwd, null, true, opts),
    getDefaultAgentType,
    closeActiveTab: () => { if (activeId) confirmCloseSession(activeId).then(ok => { if (ok) killSession(activeId); }); },
    openSettings: () => { document.getElementById('settings-btn')?.click(); },
    openMods: () => { document.getElementById('mods-btn')?.click(); },
    toggleOverviewMode: () => toggleOverviewMode(),
    showShortcutsHelp: () => openShortcutsHelp(),
    restoreSessions: () => reopenSessionRestore(),
    focusTerminal: () => {
      if (activeId) {
        const s = sessions.get(activeId);
        if (s?.term) s.term.focus();
      }
    },
  });

  // Initialize the keyboard shortcuts overlay (Cmd+? / Cmd+/ by default)
  initShortcutsHelp({
    focusTerminal: () => {
      if (activeId) {
        const s = sessions.get(activeId);
        if (s?.term) s.term.focus();
      }
    },
  });

  // Initialize Overview Mode (Cmd+O by default)
  initOverviewMode({
    getOrderedTabIds: getVisibleTabIds,
    getActiveTabId: () => activeId,
    getSession: (id) => sessions.get(id),
    getTabName: (id) => {
      const s = sessions.get(id);
      return s?.name || getDefaultTabName(s?.cwd || '');
    },
    // focusTab, not switchTo: no-op reveal under visible-scoping today, but keeps
    // the "every deliberate jump reveals its context" invariant (#559).
    switchToTab: focusTab,
    // Non-revealing counterpart to switchToTab: used when the grid comes down as
    // part of a context switch, where focusTab's revealTabContext would bounce
    // the view back to the context being left (#590).
    activateTab: switchTo,
    getActiveContextId,
    fitTerminals: (ids) => {
      for (const id of ids) {
        const s = sessions.get(id);
        if (s?.term && s.fit && s.ws) fitTerminal(s.term, s.fit, s.ws);
      }
    },
    // Give each terminal in the grid its pre-overview size back. Only the one
    // still-visible container can be measured; every other one is display:none by
    // now, and FitAddon silently no-ops on those — which is exactly how #421's
    // fix left them stranded at tile dimensions. Hand those the numbers instead
    // (#590).
    restoreTerminals: (dims) => {
      for (const [id, d] of dims) {
        const s = sessions.get(id);
        if (!s?.term || !s.ws) continue;
        if (s.container.clientWidth > 0 && s.container.clientHeight > 0) {
          if (s.fit) fitTerminal(s.term, s.fit, s.ws);
        } else {
          resizeTerminal(s.term, s.ws, d.cols, d.rows);
        }
      }
    },
    focusTerminal: () => {
      if (activeId) {
        const s = sessions.get(activeId);
        if (s?.term) s.term.focus();
      }
    },
  });

  // Initialize Terminal Search (Cmd+F)
  initTerminalSearch({
    getActiveSession: () => {
      if (!activeId) return null;
      const s = sessions.get(activeId);
      if (!s?.term) return null;
      return { term: s.term, container: s.container, searchAddon: s.searchAddon };
    },
    focusTerminal: () => {
      if (activeId) {
        const s = sessions.get(activeId);
        if (s?.term) s.term.focus();
      }
    },
  });

  // Initialize Hash Commands (# prefix for instant actions)
  initHashCommands({
    quickNewTerminal,
    closeActiveTab: () => { if (activeId) confirmCloseSession(activeId).then(ok => { if (ok) killSession(activeId); }); },
    openSettings: () => { document.getElementById('settings-btn')?.click(); },
    openMods: () => { document.getElementById('mods-btn')?.click(); },
    renameActiveTab: (name) => {
      if (!activeId) return;
      const session = sessions.get(activeId);
      if (!session) return;
      const finalName = name || getDefaultTabName(session.cwd);
      session.name = finalName;
      TabManager.updateLabel(activeId, finalName);
      if (session.ws) session.ws.sendJSON({ type: 'rename', name: finalName });
      SessionStores.rename(getWindowId(), activeId, finalName);
      notifyTabsChanged();
    },
    restart: () => { fetch('/api/request-restart', { method: 'POST' }); },
    focusTerminal: () => {
      if (activeId) {
        const s = sessions.get(activeId);
        if (s?.term) s.term.focus();
      }
    },
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
  // Fire-and-forget — don't block session restore on mod loading
  ModManager.loadAvailableMods();

  // Split button: + creates tab (plus rail-only long-press/right-click for the menu, #567),
  // ▾ opens the dropdown menu.
  wireNewTabGestures();
  document.getElementById('new-btn-dropdown').addEventListener('click', (e) => showNewTabMenu(e));
  document.getElementById('issue-btn').addEventListener('click', () => showIssuePicker());
  // Prefetch issues on hover so results are cached when the dialog opens
  let issuePrefetching = false;
  document.getElementById('issue-btn').addEventListener('mouseenter', async () => {
    if (issuePrefetching) return;
    // Same resolver the picker uses (#598), so we never warm a repo it won't open.
    // Only prefetch when the repo is unambiguous: a multi-repo or no-dirs context
    // needs a prompt, and hover must never open a modal.
    const d = resolveContextRepo();
    const seed = d.kind === 'inherit' ? d.cwd : (d.dirs && d.dirs.length === 1 ? d.dirs[0] : null);
    if (!seed) return;
    issuePrefetching = true;
    try {
      // Key on the ROOT, not the cwd: /api/issues caches on the cwd it's given,
      // and the modal always fetches with the git root — so prefetching the raw
      // cwd of a subdir warmed a key the modal never read.
      const root = await resolveGitRootQuiet(seed);
      if (root) await fetch('/api/issues?cwd=' + encodeURIComponent(root));
    } finally { issuePrefetching = false; }
  });
  document.getElementById('empty-state-btn')?.addEventListener('click', () => quickNewSession());
  document.getElementById('empty-state-restore')?.addEventListener('click', async (e) => {
    // listRecoverable's roll-call takes ~1.5s — show progress on the button
    // instead of appearing dead.
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await reopenSessionRestore();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // isExistingTab was captured at the very top of init() — by now the window ID
  // exists no matter what, so it cannot be re-derived here.
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
    if (session.type === 'display-tab') {
      // Pass the cwd sendToWindow transmits, or the adopted tab loses its
      // context scoping (#530) and dodges revealTabContext (#547).
      createDisplayTab(session.id, session.name, { cwd: session.cwd });
    } else {
      createSession(session.cwd, session.id, false, { name: session.name, allowDuplicate: true });
    }
  });

  // Handle focus-session requests from other windows
  WindowManager.onFocusSession((sessionId) => {
    focusTab(sessionId); // reveal the focused session's context too (#559)
  });

  WindowManager.startHeartbeat();

  // The per-tab session list (sessionStorage) is the authoritative per-tab source.
  // It survives page refresh and doesn't depend on localStorage window-ID mapping.
  const tabSessions = getTabSessions();
  console.log('[init] tab sessions:', tabSessions);

  if (isExistingTab && tabSessions.length > 0) {
    // Existing tab with sessions saved in sessionStorage — restore them
    console.log('[init] Restoring from tab sessions');
    restoreSessions(tabSessions);
  } else if (isExistingTab) {
    // Existing tab but the tab-session list is empty — try localStorage as fallback
    const savedSessions = SessionStore.getWindowSessions(windowId);
    console.log('[init] windowId:', windowId, 'savedSessions (fallback):', savedSessions);
    if (savedSessions.length > 0) {
      console.log('[init] Restoring from localStorage fallback');
      restoreSessions(savedSessions);
    } else {
      console.log('[init] No saved sessions, landing on the empty state');
      await landWithNoTabs();
    }
  } else {
    // New tab - check for orphaned windows or legacy sessions
    if (legacySessions && legacySessions.length > 0) {
      // Migrate legacy sessions to this window
      for (const session of legacySessions) {
        SessionStores.add(windowId, session);
      }
      restoreSessions(legacySessions);
    } else {
      // Startup restore offer (#560). Auto-shows only when there are orphaned
      // window groups or ungrouped sessions to reclaim — closed tombstones
      // exist almost always (#561 tombstones every deliberate close), so they
      // alone must not pop a modal on every new window. They stay one click
      // away behind the empty state, the ▾ menu, and the command palette.
      const outcome = await offerSessionRestore({ onlyIfOrphans: true });
      if (outcome !== 'restored') {
        // Declined, nothing to offer, or another window claimed everything —
        // land on the empty state either way. `declined` suppresses the directory
        // picker so dismissing the restore modal can't stack a second one (#597).
        await landWithNoTabs({ declined: outcome === 'fresh' });
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
