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

let allMods = [];          // [{ id, name, description, entry, toolbar }]
let enabledMods = new Set(); // mod IDs that are enabled
let activeViewId = null;   // mod ID currently showing in the iframe (or null)
let iframe = null;
let modContainer = null;
let backBtn = null;
let hooks = null;
let sessionCallbacks = [];
let modViewVisible = false;
let toolbarButtons = new Map(); // modId → button element
let settingsCallbacks = [];     // [{modId, cb}] — notified on settings change

/**
 * Initialize the mod system — creates DOM elements.
 */
function init(appHooks) {
  hooks = appHooks;

  // Create mod container (sibling of #terminals)
  modContainer = document.createElement('div');
  modContainer.id = 'mod-container';
  const terminals = document.getElementById('terminals');
  terminals.parentNode.insertBefore(modContainer, terminals.nextSibling);

  // Create back button (in #tabs, after layout-toggle)
  backBtn = document.createElement('button');
  backBtn.className = 'mod-back-btn';
  backBtn.style.display = 'none';
  backBtn.addEventListener('click', () => showModView());
  const layoutToggle = document.getElementById('layout-toggle');
  layoutToggle.parentNode.insertBefore(backBtn, layoutToggle.nextSibling);

  // Load enabled mods from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) enabledMods = new Set(saved);
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

  // Create toolbar buttons for enabled mods
  for (const mod of allMods) {
    if (enabledMods.has(mod.id)) {
      _createToolbarButton(mod);
    }
  }

  // Auto-show the last active view if its mod is still enabled
  const savedViewId = localStorage.getItem(ACTIVE_VIEW_KEY);
  if (savedViewId && enabledMods.has(savedViewId)) {
    const mod = allMods.find(m => m.id === savedViewId);
    if (mod) _showMod(mod);
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
        _createToolbarButton(mod);
      } else {
        enabledMods.delete(modId);
        _removeToolbarButton(modId);
        // If this mod's view is active, deactivate it
        if (activeViewId === modId) {
          _hideMod();
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
    if (activeViewId === mod.id) {
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
        const mod = allMods.find(m => m.id === activeViewId);
        return mod ? _loadModSettings(mod) : {};
      },
      onSettingsChanged(cb) {
        const modId = activeViewId;
        const entry = { modId, cb };
        settingsCallbacks.push(entry);
        // Fire immediately with current values
        const mod = allMods.find(m => m.id === modId);
        if (mod) try { cb(_loadModSettings(mod)); } catch {}
        return () => {
          settingsCallbacks = settingsCallbacks.filter(e => e !== entry);
        };
      }
    };
  } catch (e) {
    console.error('Failed to inject bridge API:', e);
  }
}

export const ModManager = {
  init,
  loadAvailableMods,
  showModView,
  showTerminalForSession,
  notifySessionsChanged,
  isModViewVisible,
  isModActive,
};
