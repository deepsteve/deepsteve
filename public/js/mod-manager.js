/**
 * Mod system for deepsteve — loads alternative visual views in iframes
 * while still connecting to real PTY sessions via a bridge API.
 *
 * Two UI concepts:
 *  1. "Mods" dropdown (right side, near Sessions) — lists available mods with enable/disable toggles
 *  2. Mod toolbar buttons (left side, near wand) — registered by enabled mods via mod.json "toolbar" field
 */

const STORAGE_KEY = 'deepsteve-enabled-mods'; // Set of enabled mod IDs
const ACTIVE_VIEW_KEY = 'deepsteve-active-mod-view'; // Which mod view is currently showing
const PANEL_VISIBLE_KEY = 'deepsteve-panel-visible'; // Whether the panel is shown

let allMods = [];          // [{ id, name, description, entry, toolbar }]
let enabledMods = new Set(); // mod IDs that are enabled
let hasExplicitModPrefs = false; // true if user has saved mod prefs before
let activeViewId = null;   // mod ID currently showing in the iframe (or null)
let iframe = null;
let modContainer = null;
let backBtn = null;
let hooks = null;
let sessionCallbacks = [];
let modViewVisible = false;
let toolbarButtons = new Map(); // modId → button element
let settingsCallbacks = [];     // [{modId, cb}] — notified on settings change

// Panel mode state
let panelContainer = null;
let panelResizer = null;
let panelIframe = null;
let activePanelId = null;  // mod ID of active panel (or null)
let taskCallbacks = [];    // callbacks for task broadcasts
let browserEvalCallbacks = [];     // callbacks for browser-eval-request
let browserConsoleCallbacks = [];  // callbacks for browser-console-request
let panelWidth = 360;
const MIN_PANEL_WIDTH = 200;
const PANEL_STORAGE_KEY = 'deepsteve-panel-width';

/**
 * Initialize the mod system — creates DOM elements.
 */
function init(appHooks) {
  hooks = appHooks;

  // Wrap #terminals in a row container for side-by-side panel layout
  const terminals = document.getElementById('terminals');
  const contentRow = document.createElement('div');
  contentRow.id = 'content-row';
  terminals.parentNode.insertBefore(contentRow, terminals);
  contentRow.appendChild(terminals);

  // Create mod container (fullscreen mod view, sibling of content-row)
  modContainer = document.createElement('div');
  modContainer.id = 'mod-container';
  contentRow.parentNode.insertBefore(modContainer, contentRow.nextSibling);

  // Create back button (in #tabs, after layout-toggle)
  backBtn = document.createElement('button');
  backBtn.className = 'mod-back-btn';
  backBtn.style.display = 'none';
  backBtn.addEventListener('click', () => showModView());
  const layoutToggle = document.getElementById('layout-toggle');
  layoutToggle.parentNode.insertBefore(backBtn, layoutToggle.nextSibling);

  // Create panel resizer and container (inside content-row, after #terminals)
  panelResizer = document.createElement('div');
  panelResizer.id = 'panel-resizer';
  contentRow.appendChild(panelResizer);

  panelContainer = document.createElement('div');
  panelContainer.id = 'panel-container';
  contentRow.appendChild(panelContainer);

  // Restore saved panel width
  try {
    const saved = parseInt(localStorage.getItem(PANEL_STORAGE_KEY));
    if (saved >= MIN_PANEL_WIDTH) panelWidth = saved;
  } catch {}

  _setupPanelResizer();

  // Load enabled mods from localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      hasExplicitModPrefs = true;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) enabledMods = new Set(saved);
    }
  } catch {}
}

/**
 * Persist enabled mod IDs to localStorage.
 */
function _saveEnabledMods() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabledMods]));
}

/**
 * Load mod settings, merging stored values with schema defaults.
 */
function _loadModSettings(mod) {
  const defaults = {};
  for (const s of (mod.settings || [])) {
    defaults[s.key] = s.default;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(`deepsteve-mod-settings-${mod.id}`));
    if (stored) return { ...defaults, ...stored };
  } catch {}
  return defaults;
}

/**
 * Save a single mod setting value.
 */
function _saveModSetting(modId, key, value) {
  const mod = allMods.find(m => m.id === modId);
  if (!mod) return;
  const current = _loadModSettings(mod);
  current[key] = value;
  localStorage.setItem(`deepsteve-mod-settings-${modId}`, JSON.stringify(current));
  _notifySettingsChanged(modId);
}

/**
 * Notify mod iframe that settings changed.
 */
function _notifySettingsChanged(modId) {
  const mod = allMods.find(m => m.id === modId);
  if (!mod) return;
  const settings = _loadModSettings(mod);
  for (const entry of settingsCallbacks) {
    if (entry.modId === modId) {
      try { entry.cb(settings); } catch (e) { console.error('Settings callback error:', e); }
    }
  }
}

/**
 * Fetch available mods from server, show the Mods dropdown, and create toolbar buttons.
 */
async function loadAvailableMods() {
  try {
    const res = await fetch('/api/mods');
    const data = await res.json();
    allMods = data.mods || [];
  } catch { return; }

  if (allMods.length === 0) return;

  // Show the Mods dropdown
  const modsDropdown = document.getElementById('mods-dropdown');
  modsDropdown.style.display = '';

  // Wire up dropdown toggle
  const modsBtn = document.getElementById('mods-btn');
  const modsMenu = document.getElementById('mods-menu');

  modsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    modsMenu.classList.toggle('open');
    if (modsMenu.classList.contains('open')) {
      _renderModsMenu();
    }
  });

  document.addEventListener('click', () => {
    modsMenu.classList.remove('open');
  });

  // Create toolbar buttons for enabled non-panel mods
  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.display !== 'panel') {
      _createToolbarButton(mod);
    }
  }

  // Auto-enable panel mods on first visit only (no saved prefs yet)
  if (!hasExplicitModPrefs) {
    for (const mod of allMods) {
      if (mod.display === 'panel') {
        enabledMods.add(mod.id);
      }
    }
    _saveEnabledMods();
  }

  // Auto-show the last active view if its mod is still enabled
  const savedViewId = localStorage.getItem(ACTIVE_VIEW_KEY);
  if (savedViewId && enabledMods.has(savedViewId)) {
    const mod = allMods.find(m => m.id === savedViewId);
    if (mod) _showMod(mod);
  }

  // Load enabled panel mods (iframe always created so MCP tools work).
  // Only show the panel UI if it was previously visible.
  const panelWasVisible = localStorage.getItem(PANEL_VISIBLE_KEY) !== 'false';
  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.display === 'panel') {
      _loadPanelMod(mod);
      if (panelWasVisible) {
        _showPanel();
      }
      break;
    }
  }
}

/**
 * Render the mods dropdown menu with enable/disable toggles.
 */
function _renderModsMenu() {
  const modsMenu = document.getElementById('mods-menu');
  if (allMods.length === 0) {
    modsMenu.innerHTML = '<div class="dropdown-empty">No mods available</div>';
    return;
  }

  modsMenu.innerHTML = allMods.map(mod => {
    const enabled = enabledMods.has(mod.id);
    const hasSettings = mod.settings && mod.settings.length > 0;
    return `
      <div class="dropdown-item mod-toggle-item" data-id="${mod.id}">
        <div class="session-info">
          <span class="session-name">${mod.name}</span>
          <span class="session-status">${mod.description || ''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          ${hasSettings ? `<button class="mod-settings-btn" data-id="${mod.id}" title="Settings">&#9881;</button>` : ''}
          <label class="mod-toggle-label" data-id="${mod.id}">
            <input type="checkbox" ${enabled ? 'checked' : ''} data-id="${mod.id}">
          </label>
        </div>
      </div>
    `;
  }).join('');

  // Wire up toggles
  modsMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const modId = cb.dataset.id;
      const mod = allMods.find(m => m.id === modId);
      if (!mod) return;

      if (cb.checked) {
        enabledMods.add(modId);
        if (mod.display === 'panel') {
          _showPanelMod(mod);
        } else {
          _createToolbarButton(mod);
        }
      } else {
        enabledMods.delete(modId);
        if (mod.display === 'panel') {
          _unloadPanelMod();
        } else {
          _removeToolbarButton(modId);
          if (activeViewId === modId) {
            _hideMod();
          }
        }
      }
      _saveEnabledMods();
    });
  });

  // Clicking the row toggles the checkbox
  modsMenu.querySelectorAll('.mod-toggle-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.closest('.mod-settings-btn')) return;
      const cb = item.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  // Wire up gear buttons
  modsMenu.querySelectorAll('.mod-settings-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mod = allMods.find(m => m.id === btn.dataset.id);
      if (mod) _showSettingsModal(mod);
    });
  });
}

/**
 * Show a settings modal for a mod.
 */
function _showSettingsModal(mod) {
  const settings = _loadModSettings(mod);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.width = '380px';

  let html = `<h2>${mod.name} Settings</h2>`;
  for (const s of mod.settings) {
    if (s.type === 'boolean') {
      html += `
        <div class="mod-setting-item">
          <input type="checkbox" class="mod-setting-toggle" data-key="${s.key}" ${settings[s.key] ? 'checked' : ''}>
          <div>
            <div class="mod-setting-label">${s.label}</div>
            ${s.description ? `<div class="mod-setting-desc">${s.description}</div>` : ''}
          </div>
        </div>
      `;
    }
  }
  html += `<div class="modal-buttons"><button class="btn-secondary" data-close>Close</button></div>`;
  modal.innerHTML = html;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close dropdown
  document.getElementById('mods-menu').classList.remove('open');

  // Live-save on change
  modal.querySelectorAll('.mod-setting-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      _saveModSetting(mod.id, toggle.dataset.key, toggle.checked);
    });
  });

  // Close modal
  const close = () => overlay.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

/**
 * Setup panel resizer drag handling.
 */
function _setupPanelResizer() {
  let isDragging = false;

  panelResizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Block iframe from stealing mouse events during drag
    if (panelIframe) panelIframe.style.pointerEvents = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // Panel is on the right: width = viewport right edge - mouse X
    const newWidth = window.innerWidth - e.clientX;
    panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(newWidth, window.innerWidth * 0.6));
    panelContainer.style.width = panelWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (panelIframe) panelIframe.style.pointerEvents = '';
      localStorage.setItem(PANEL_STORAGE_KEY, panelWidth);
      window.dispatchEvent(new Event('resize'));
    }
  });
}

/**
 * Load a panel mod's iframe (creates it hidden if panel not visible).
 * Called when mod is enabled. The iframe stays alive until the mod is disabled.
 */
function _loadPanelMod(mod) {
  // Already loaded
  if (activePanelId === mod.id && panelIframe) return;

  // Clean up existing panel if different mod
  if (activePanelId) {
    _unloadPanelMod();
  }

  activePanelId = mod.id;

  // Create panel iframe
  const entry = mod.entry || 'index.html';
  panelIframe = document.createElement('iframe');
  panelIframe.src = `/mods/${mod.id}/${entry}`;
  panelIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  panelContainer.appendChild(panelIframe);
  panelIframe.addEventListener('load', () => {
    _injectBridgeAPI(panelIframe);
  });
}

/**
 * Show the panel UI (make the already-loaded iframe visible).
 */
function _showPanel() {
  if (!activePanelId) return;

  // Update toolbar button states
  for (const [id, btn] of toolbarButtons) {
    btn.classList.toggle('active', id === activePanelId);
  }

  // Show panel + resizer
  panelContainer.style.display = 'block';
  panelContainer.style.width = panelWidth + 'px';
  panelResizer.style.display = 'block';

  // Ensure terminals stay visible (but not if a fullscreen mod is showing)
  if (!modViewVisible) {
    document.getElementById('terminals').style.display = 'block';
  }

  localStorage.setItem(PANEL_VISIBLE_KEY, 'true');

  // Trigger resize so terminal refits to smaller width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Hide the panel UI but keep the iframe alive.
 */
function _hidePanel() {
  // Clear toolbar button states for panel mod
  for (const [, btn] of toolbarButtons) {
    btn.classList.remove('active');
  }

  // Hide panel container + resizer
  panelContainer.style.display = 'none';
  panelResizer.style.display = 'none';

  localStorage.setItem(PANEL_VISIBLE_KEY, 'false');

  // Trigger resize so terminal refits to full width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Toggle panel visibility for a mod. If mod not loaded, loads it first.
 */
function _showPanelMod(mod) {
  if (activePanelId === mod.id) {
    // Toggle visibility
    const isVisible = panelContainer.style.display !== 'none';
    if (isVisible) {
      _hidePanel();
    } else {
      _showPanel();
    }
    return;
  }

  // Different mod or none loaded — load and show
  _loadPanelMod(mod);
  _showPanel();
}

/**
 * Fully unload a panel mod (destroy iframe, clear callbacks).
 * Called when the mod is disabled.
 */
function _unloadPanelMod() {
  const hiddenModId = activePanelId;
  activePanelId = null;
  taskCallbacks = [];
  browserEvalCallbacks = [];
  browserConsoleCallbacks = [];
  if (hiddenModId) {
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== hiddenModId);
  }

  if (panelIframe) {
    panelIframe.remove();
    panelIframe = null;
  }

  // Clear toolbar button states for panel mod
  for (const [, btn] of toolbarButtons) {
    btn.classList.remove('active');
  }

  // Hide panel container + resizer
  panelContainer.style.display = 'none';
  panelResizer.style.display = 'none';

  localStorage.removeItem(PANEL_VISIBLE_KEY);

  // Trigger resize so terminal refits to full width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Create a toolbar button for an enabled mod (left side, near wand).
 */
function _createToolbarButton(mod) {
  if (toolbarButtons.has(mod.id)) return;

  const label = mod.toolbar?.label || mod.name;
  const btn = document.createElement('button');
  btn.className = 'mod-toolbar-btn';
  btn.textContent = label;
  btn.title = mod.description || label;
  btn.dataset.modId = mod.id;

  btn.addEventListener('click', () => {
    if (mod.display === 'panel') {
      // Panel mods toggle via _showPanelMod (which handles its own toggle)
      _showPanelMod(mod);
    } else if (activeViewId === mod.id) {
      _hideMod();
    } else {
      _showMod(mod);
    }
  });

  // Insert after wand button
  const wandBtn = document.getElementById('wand-btn');
  wandBtn.parentNode.insertBefore(btn, wandBtn.nextSibling);

  // If this mod is currently the active view, mark it
  if (activeViewId === mod.id) {
    btn.classList.add('active');
  }

  toolbarButtons.set(mod.id, btn);
}

/**
 * Remove a toolbar button for a mod.
 */
function _removeToolbarButton(modId) {
  const btn = toolbarButtons.get(modId);
  if (btn) {
    btn.remove();
    toolbarButtons.delete(modId);
  }
}

/**
 * Show a mod's iframe view.
 */
function _showMod(mod) {
  const display = mod.display || 'fullscreen';

  // Panel mods use a side panel instead of replacing the terminal
  if (display === 'panel') {
    _showPanelMod(mod);
    return;
  }

  // If a different mod is showing, clean up its iframe
  if (activeViewId && activeViewId !== mod.id) {
    _destroyIframe();
  }

  activeViewId = mod.id;
  localStorage.setItem(ACTIVE_VIEW_KEY, mod.id);

  // Update toolbar button states
  for (const [id, btn] of toolbarButtons) {
    btn.classList.toggle('active', id === mod.id);
  }

  // Create iframe if needed
  if (!iframe) {
    const entry = mod.entry || 'index.html';
    iframe = document.createElement('iframe');
    iframe.src = `/mods/${mod.id}/${entry}`;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    modContainer.appendChild(iframe);
    iframe.addEventListener('load', () => {
      _injectBridgeAPI(iframe);
    });
  }

  showModView();
}

/**
 * Hide the active mod view, return to terminals.
 */
function _hideMod() {
  // Check if the mod being hidden is a panel mod
  const mod = allMods.find(m => m.id === activeViewId || m.id === activePanelId);
  if (mod && mod.display === 'panel') {
    _hidePanel();
    return;
  }

  const hiddenModId = activeViewId;
  activeViewId = null;
  localStorage.removeItem(ACTIVE_VIEW_KEY);
  sessionCallbacks = [];
  if (hiddenModId) {
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== hiddenModId);
  }

  _destroyIframe();

  // Clear toolbar button states
  for (const [, btn] of toolbarButtons) {
    btn.classList.remove('active');
  }

  // Show terminals, hide mod container and back button
  document.getElementById('terminals').style.display = '';
  modContainer.style.display = 'none';
  backBtn.style.display = 'none';
  modViewVisible = false;
}

/**
 * Destroy the current iframe.
 */
function _destroyIframe() {
  if (iframe) {
    iframe.remove();
    iframe = null;
  }
}

/**
 * Show the mod view (hide terminals, show mod container).
 */
function showModView() {
  if (!activeViewId) return;
  document.getElementById('terminals').style.display = 'none';
  modContainer.style.display = 'flex';
  backBtn.style.display = 'none';
  modViewVisible = true;
}

/**
 * Switch from mod view to terminal view for a specific session.
 */
function showTerminalForSession(id) {
  modContainer.style.display = 'none';
  document.getElementById('terminals').style.display = '';
  modViewVisible = false;

  // Show back button with mod name
  if (activeViewId) {
    const mod = allMods.find(m => m.id === activeViewId);
    backBtn.textContent = `\u2190 ${mod?.name || 'Back'}`;
    backBtn.style.display = '';
  }

  hooks.focusSession(id);
}

/**
 * Notify the active mod that sessions have changed.
 */
function notifySessionsChanged(sessionList) {
  for (const cb of sessionCallbacks) {
    try { cb(sessionList); } catch (e) { console.error('Mod callback error:', e); }
  }
}

/**
 * Notify panel mods that tasks have changed (called from app.js on WS broadcast).
 */
function notifyTasksChanged(tasks) {
  for (const cb of taskCallbacks) {
    try { cb(tasks); } catch (e) { console.error('Task callback error:', e); }
  }
}

/**
 * Notify panel mods of a browser-eval request (called from app.js on WS broadcast).
 */
function notifyBrowserEvalRequest(req) {
  for (const cb of browserEvalCallbacks) {
    try { cb(req); } catch (e) { console.error('Browser eval callback error:', e); }
  }
}

/**
 * Notify panel mods of a browser-console request (called from app.js on WS broadcast).
 */
function notifyBrowserConsoleRequest(req) {
  for (const cb of browserConsoleCallbacks) {
    try { cb(req); } catch (e) { console.error('Browser console callback error:', e); }
  }
}

/**
 * Check if the mod view is currently visible.
 */
function isModViewVisible() {
  return modViewVisible;
}

/**
 * Check if a mod is currently active.
 */
function isModActive() {
  return activeViewId !== null;
}

/**
 * Inject the deepsteve bridge API into the mod iframe.
 */
function _injectBridgeAPI(iframeEl) {
  try {
    iframeEl.contentWindow.deepsteve = {
      getSessions() {
        return hooks.getSessions();
      },
      focusSession(id) {
        showTerminalForSession(id);
      },
      onSessionsChanged(cb) {
        sessionCallbacks.push(cb);
        try { cb(hooks.getSessions()); } catch {}
        return () => {
          sessionCallbacks = sessionCallbacks.filter(fn => fn !== cb);
        };
      },
      createSession(cwd) {
        hooks.createSession(cwd);
      },
      killSession(id) {
        hooks.killSession(id);
      },
      getSettings() {
        const mod = allMods.find(m => m.id === (activeViewId || activePanelId));
        return mod ? _loadModSettings(mod) : {};
      },
      onSettingsChanged(cb) {
        const modId = activeViewId || activePanelId;
        const entry = { modId, cb };
        settingsCallbacks.push(entry);
        // Fire immediately with current values
        const mod = allMods.find(m => m.id === modId);
        if (mod) try { cb(_loadModSettings(mod)); } catch {}
        return () => {
          settingsCallbacks = settingsCallbacks.filter(e => e !== entry);
        };
      },
      onTasksChanged(cb) {
        taskCallbacks.push(cb);
        // Fire immediately with current tasks from server
        fetch('/api/tasks').then(r => r.json()).then(data => {
          try { cb(data.tasks || []); } catch {}
        }).catch(() => {});
        return () => {
          taskCallbacks = taskCallbacks.filter(fn => fn !== cb);
        };
      },
      onBrowserEvalRequest(cb) {
        browserEvalCallbacks.push(cb);
        return () => {
          browserEvalCallbacks = browserEvalCallbacks.filter(fn => fn !== cb);
        };
      },
      onBrowserConsoleRequest(cb) {
        browserConsoleCallbacks.push(cb);
        return () => {
          browserConsoleCallbacks = browserConsoleCallbacks.filter(fn => fn !== cb);
        };
      },
    };
  } catch (e) {
    console.error('Failed to inject bridge API:', e);
  }
}

/**
 * Handle a mod-changed message from the server (file watcher detected changes).
 * Reloads the iframe if the changed mod is currently active.
 */
function handleModChanged(modId) {
  if (activeViewId === modId && iframe) {
    iframe.src = iframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
  if (activePanelId === modId && panelIframe) {
    panelIframe.src = panelIframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
}

export const ModManager = {
  init,
  loadAvailableMods,
  showModView,
  showTerminalForSession,
  notifySessionsChanged,
  notifyTasksChanged,
  notifyBrowserEvalRequest,
  notifyBrowserConsoleRequest,
  isModViewVisible,
  isModActive,
  handleModChanged,
};
