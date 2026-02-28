/**
 * Mod system for deepsteve — loads alternative visual views in iframes
 * while still connecting to real PTY sessions via a bridge API.
 *
 * Two UI concepts:
 *  1. "Mods" dropdown (right side, near Sessions) — lists available mods with enable/disable toggles
 *  2. Panel tabs (right edge) — vertical tabs for switching between enabled panel mods
 *
 * Panel mods all stay loaded (iframes alive) so MCP tools keep working.
 * Only one panel is visible at a time; clicking a different tab switches to it.
 */

const STORAGE_KEY = 'deepsteve-enabled-mods'; // Set of enabled mod IDs
const ACTIVE_VIEW_KEY = 'deepsteve-active-mod-view'; // Which mod view is currently showing
const PANEL_VISIBLE_KEY = 'deepsteve-panel-visible'; // Whether the panel is shown
const ACTIVE_PANEL_KEY = 'deepsteve-active-panel'; // Which panel tab is active

let allMods = [];          // [{ id, name, description, entry, toolbar }]
let enabledMods = new Set(); // mod IDs that are enabled
let hasExplicitModPrefs = false; // true if user has saved mod prefs before
let activeViewId = null;   // mod ID currently showing in the fullscreen iframe (or null)
let iframe = null;
let modContainer = null;
let backBtn = null;
let hooks = null;
let sessionCallbacks = [];
let modViewVisible = false;
let toolbarButtons = new Map(); // modId → button element
let settingsCallbacks = [];     // [{modId, cb}] — notified on settings change

// Panel mode state — multi-panel
let panelContainer = null;
let panelResizer = null;
let panelMods = new Map();       // modId → { iframe, mod }
let visiblePanelId = null;       // which panel is currently VISIBLE (or null)
let panelTabsContainer = null;   // #panel-tabs DOM element
let panelTabs = new Map();       // modId → tab button element
let taskCallbacks = [];          // [{modId, cb}] — callbacks for task broadcasts
let agentChatCallbacks = [];     // [{modId, cb}] — callbacks for agent-chat broadcasts
let browserEvalCallbacks = [];   // [{modId, cb}] — callbacks for browser-eval-request
let browserConsoleCallbacks = []; // [{modId, cb}] — callbacks for browser-console-request
let screenshotCaptureCallbacks = []; // [{modId, cb}] — callbacks for screenshot-capture-request
let activeSessionCallbacks = [];     // [{modId, cb}] — callbacks for active session changes
let getActiveSessionIdFn = null;     // set from appHooks
let deepsteveVersion = null;   // set from /api/mods response
let panelWidth = 360;
const MIN_PANEL_WIDTH = 200;
const PANEL_STORAGE_KEY = 'deepsteve-panel-width';

/**
 * Initialize the mod system — creates DOM elements.
 */
function init(appHooks) {
  hooks = appHooks;
  getActiveSessionIdFn = appHooks.getActiveSessionId || null;

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

  // Create panel tabs strip (inside content-row, after panel container)
  panelTabsContainer = document.createElement('div');
  panelTabsContainer.id = 'panel-tabs';
  contentRow.appendChild(panelTabsContainer);

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
 * Fetch available mods from server, show the Mods button, and create toolbar buttons.
 */
async function loadAvailableMods() {
  try {
    const res = await fetch('/api/mods');
    const data = await res.json();
    allMods = data.mods || [];
    deepsteveVersion = data.deepsteveVersion || null;
  } catch { return; }

  if (allMods.length === 0) return;

  // Show the Mods button
  const modsBtn = document.getElementById('mods-btn');
  modsBtn.style.display = '';

  // Wire up button to open marketplace modal
  modsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _showMarketplaceModal();
  });

  // Remove incompatible mods from enabledMods (in case they were enabled before)
  for (const mod of allMods) {
    if (mod.compatible === false) enabledMods.delete(mod.id);
  }

  // Create toolbar buttons for enabled non-panel mods
  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.entry && mod.display !== 'panel' && mod.compatible !== false) {
      _createToolbarButton(mod);
    }
  }

  // Auto-enable default mods on first visit only (no saved prefs yet)
  if (!hasExplicitModPrefs) {
    for (const mod of allMods) {
      if (mod.enabledByDefault && mod.compatible !== false) {
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

  // Load ALL enabled panel mods (not just the first one)
  const panelWasVisible = localStorage.getItem(PANEL_VISIBLE_KEY) !== 'false';
  const savedActivePanelId = localStorage.getItem(ACTIVE_PANEL_KEY);
  let firstPanelId = null;

  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.display === 'panel' && mod.compatible !== false) {
      _loadPanelMod(mod);
      if (!firstPanelId) firstPanelId = mod.id;
    }
  }

  // Restore which panel was active, or default to first
  if (panelWasVisible && panelMods.size > 0) {
    const restoreId = (savedActivePanelId && panelMods.has(savedActivePanelId))
      ? savedActivePanelId
      : firstPanelId;
    if (restoreId) {
      _switchToPanel(restoreId);
      // If fullscreen mod is active, panel DOM won't be shown yet —
      // _hideMod() will restore it when exiting fullscreen.
      // But if no fullscreen mod, verify the DOM is actually visible.
      if (!modViewVisible) {
        requestAnimationFrame(() => {
          if (visiblePanelId && panelContainer.style.display === 'none') {
            _showPanel();
          }
        });
      }
    }
  }
}

/**
 * Show the marketplace modal with mod cards, search, and filters.
 */
async function _showMarketplaceModal() {
  // Fetch installed mods and catalog in parallel
  let catalogMods = [];
  try {
    const [modsRes, catalogRes] = await Promise.all([
      fetch('/api/mods').then(r => r.json()).catch(() => null),
      fetch('/api/mods/catalog').then(r => r.json()).catch(() => ({ mods: [] }))
    ]);
    if (modsRes) {
      allMods = modsRes.mods || [];
      deepsteveVersion = modsRes.deepsteveVersion || null;
    }
    catalogMods = catalogRes.mods || [];
  } catch {}

  // Merge: installed mods first, then catalog-only mods
  const installedIds = new Set(allMods.map(m => m.id));
  const catalogOnly = catalogMods.filter(m => !installedIds.has(m.id));

  // Build unified list — installed mods get their catalog info merged
  const unifiedMods = allMods.map(mod => {
    const catEntry = catalogMods.find(c => c.id === mod.id);
    return {
      ...mod,
      catalogVersion: catEntry?.version || null,
      downloadUrl: catEntry?.downloadUrl || null,
      updateAvailable: catEntry?.updateAvailable || false,
    };
  });
  for (const cat of catalogOnly) {
    unifiedMods.push({
      ...cat,
      source: 'official',
      catalogVersion: cat.version,
    });
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal marketplace-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'marketplace-header';
  header.innerHTML = `<h2>Mods</h2><div class="marketplace-search"><input type="text" placeholder="Search mods..."></div>`;

  // Filters
  const filters = document.createElement('div');
  filters.className = 'marketplace-filters';
  const filterNames = ['All', 'Enabled', 'Panel', 'Fullscreen'];
  for (const name of filterNames) {
    const pill = document.createElement('button');
    pill.className = 'filter-pill' + (name === 'All' ? ' active' : '');
    pill.textContent = name;
    pill.dataset.filter = name.toLowerCase();
    filters.appendChild(pill);
  }

  // List
  const list = document.createElement('div');
  list.className = 'marketplace-list';

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-buttons';
  footer.innerHTML = '<button class="btn-secondary" data-close>Close</button>';

  modal.appendChild(header);
  modal.appendChild(filters);
  modal.appendChild(list);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // State
  let activeFilter = 'all';
  let searchQuery = '';
  let searchTimeout = null;

  function renderCards() {
    const q = searchQuery.toLowerCase();
    const filtered = unifiedMods.filter(mod => {
      // Search filter
      if (q) {
        const name = (mod.name || mod.id || '').toLowerCase();
        const desc = (mod.description || '').toLowerCase();
        if (!name.includes(q) && !desc.includes(q)) return false;
      }
      // Category filter
      if (activeFilter === 'enabled') return enabledMods.has(mod.id);
      if (activeFilter === 'panel') return mod.display === 'panel';
      if (activeFilter === 'fullscreen') return mod.display !== 'panel';
      return true;
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="marketplace-empty">No mods match your search</div>';
      return;
    }

    list.innerHTML = '';
    for (const mod of filtered) {
      list.appendChild(_createModCard(mod, overlay));
    }
  }

  // Search input
  const searchInput = header.querySelector('input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery = searchInput.value;
      renderCards();
    }, 150);
  });

  // Filter pills
  filters.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      filters.querySelector('.filter-pill.active')?.classList.remove('active');
      pill.classList.add('active');
      activeFilter = pill.dataset.filter;
      renderCards();
    });
  });

  // Close
  const close = () => overlay.remove();
  footer.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Render initial cards
  renderCards();
  searchInput.focus();
}

/**
 * Create a mod card element for the marketplace.
 */
function _createModCard(mod, marketplaceOverlay) {
  const card = document.createElement('div');
  card.className = 'mod-card' + (mod.compatible === false ? ' mod-card-incompatible' : '');

  const isInstalled = allMods.some(m => m.id === mod.id);
  const isEnabled = enabledMods.has(mod.id);
  const isBuiltIn = mod.source === 'built-in';
  const hasSettings = mod.settings && mod.settings.length > 0;
  const badgeClass = isBuiltIn ? 'built-in' : 'official';
  const badgeText = isBuiltIn ? 'Built-in' : 'Official';

  // Header row
  const header = document.createElement('div');
  header.className = 'mod-card-header';

  const info = document.createElement('div');
  info.className = 'mod-card-info';
  info.innerHTML = `<span class="mod-card-name">${mod.name || mod.id}</span><span class="mod-badge ${badgeClass}">${badgeText}</span><span class="mod-card-version">v${mod.version || '?'}</span>`;

  const actions = document.createElement('div');
  actions.className = 'mod-card-actions';

  if (hasSettings && isInstalled) {
    const gearBtn = document.createElement('button');
    gearBtn.className = 'mod-settings-btn';
    gearBtn.innerHTML = '&#9881;';
    gearBtn.title = 'Settings';
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _showSettingsModal(mod);
    });
    actions.appendChild(gearBtn);
  }

  if (isInstalled) {
    const toggle = document.createElement('label');
    toggle.className = 'mod-card-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isEnabled;
    checkbox.disabled = mod.compatible === false;
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    toggle.appendChild(checkbox);
    toggle.appendChild(slider);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        enabledMods.add(mod.id);
        if (mod.display === 'panel') {
          _loadPanelMod(mod);
          _switchToPanel(mod.id);
        } else {
          _createToolbarButton(mod);
        }
      } else {
        enabledMods.delete(mod.id);
        if (mod.display === 'panel') {
          _unloadPanelMod(mod.id);
        } else {
          _removeToolbarButton(mod.id);
          if (activeViewId === mod.id) {
            _hideMod();
          }
        }
      }
      _saveEnabledMods();
    });

    actions.appendChild(toggle);
  }

  header.appendChild(info);
  header.appendChild(actions);
  card.appendChild(header);

  // Description
  if (mod.description) {
    const desc = document.createElement('div');
    desc.className = 'mod-card-description';
    desc.textContent = mod.description;
    card.appendChild(desc);
  }

  // Incompatible warning
  if (mod.compatible === false) {
    const warn = document.createElement('div');
    warn.className = 'mod-card-description';
    warn.style.color = 'var(--ds-accent-red)';
    warn.textContent = `Requires deepsteve v${mod.minDeepsteveVersion}+`;
    card.appendChild(warn);
  }

  // Footer for non-built-in mods (install/uninstall/update)
  if (!isBuiltIn) {
    const footer = document.createElement('div');
    footer.className = 'mod-card-footer';

    if (isInstalled) {
      // Update button (if available)
      if (mod.updateAvailable && mod.downloadUrl) {
        const updateBtn = document.createElement('button');
        updateBtn.className = 'btn-update';
        updateBtn.textContent = `Update to v${mod.catalogVersion}`;
        updateBtn.addEventListener('click', async () => {
          updateBtn.disabled = true;
          updateBtn.textContent = 'Updating...';
          try {
            const res = await fetch('/api/mods/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: mod.id, downloadUrl: mod.downloadUrl })
            });
            if (!res.ok) throw new Error((await res.json()).error);
            // Re-open marketplace to refresh
            marketplaceOverlay.remove();
            _showMarketplaceModal();
          } catch (e) {
            updateBtn.textContent = 'Update failed';
            setTimeout(() => { updateBtn.textContent = `Update to v${mod.catalogVersion}`; updateBtn.disabled = false; }, 2000);
          }
        });
        footer.appendChild(updateBtn);
      }

      // Uninstall button
      const uninstallBtn = document.createElement('button');
      uninstallBtn.className = 'btn-uninstall';
      uninstallBtn.textContent = 'Uninstall';
      uninstallBtn.addEventListener('click', async () => {
        // Disable mod first if enabled
        if (enabledMods.has(mod.id)) {
          enabledMods.delete(mod.id);
          if (mod.display === 'panel') {
            _unloadPanelMod(mod.id);
          } else {
            _removeToolbarButton(mod.id);
            if (activeViewId === mod.id) _hideMod();
          }
          _saveEnabledMods();
        }
        uninstallBtn.disabled = true;
        uninstallBtn.textContent = 'Removing...';
        try {
          const res = await fetch('/api/mods/uninstall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mod.id })
          });
          if (!res.ok) throw new Error((await res.json()).error);
          marketplaceOverlay.remove();
          _showMarketplaceModal();
        } catch (e) {
          uninstallBtn.textContent = 'Failed';
          setTimeout(() => { uninstallBtn.textContent = 'Uninstall'; uninstallBtn.disabled = false; }, 2000);
        }
      });
      footer.appendChild(uninstallBtn);
    } else if (mod.downloadUrl) {
      // Install button
      const installBtn = document.createElement('button');
      installBtn.className = 'btn-install';
      installBtn.textContent = 'Install';
      if (mod.compatible === false) installBtn.disabled = true;
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.classList.add('loading');
        installBtn.textContent = 'Installing...';
        try {
          const res = await fetch('/api/mods/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mod.id, downloadUrl: mod.downloadUrl })
          });
          if (!res.ok) throw new Error((await res.json()).error);
          marketplaceOverlay.remove();
          _showMarketplaceModal();
        } catch (e) {
          installBtn.classList.remove('loading');
          installBtn.textContent = 'Install failed';
          setTimeout(() => { installBtn.textContent = 'Install'; installBtn.disabled = false; }, 2000);
        }
      });
      footer.appendChild(installBtn);
    }

    if (footer.children.length > 0) {
      card.appendChild(footer);
    }
  }

  return card;
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
    } else if (s.type === 'number') {
      html += `
        <div class="mod-setting-item">
          <div style="flex:1">
            <div class="mod-setting-label">${s.label}</div>
            ${s.description ? `<div class="mod-setting-desc">${s.description}</div>` : ''}
            <input type="number" class="mod-setting-number" data-key="${s.key}" value="${settings[s.key] ?? s.default ?? 0}"
              style="margin-top:4px;width:100px;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;">
          </div>
        </div>
      `;
    }
  }
  html += `<div class="modal-buttons"><button class="btn-secondary" data-close>Close</button></div>`;
  modal.innerHTML = html;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Live-save on change
  modal.querySelectorAll('.mod-setting-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      _saveModSetting(mod.id, toggle.dataset.key, toggle.checked);
    });
  });
  modal.querySelectorAll('.mod-setting-number').forEach(input => {
    input.addEventListener('change', () => {
      const val = parseInt(input.value, 10);
      if (!isNaN(val)) _saveModSetting(mod.id, input.dataset.key, val);
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
    // Block ALL panel iframes from stealing mouse events during drag
    for (const [, entry] of panelMods) {
      entry.iframe.style.pointerEvents = 'none';
    }
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // Panel is on the right: width = viewport right edge - mouse X - panel tabs width
    const tabsWidth = panelTabsContainer.offsetWidth || 0;
    const newWidth = window.innerWidth - e.clientX - tabsWidth;
    panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(newWidth, window.innerWidth * 0.6));
    panelContainer.style.width = panelWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      for (const [, entry] of panelMods) {
        entry.iframe.style.pointerEvents = '';
      }
      localStorage.setItem(PANEL_STORAGE_KEY, panelWidth);
      window.dispatchEvent(new Event('resize'));
    }
  });
}

// ─── Panel tab management ────────────────────────────────────────────

/**
 * Create a panel tab button for a mod.
 */
function _createPanelTab(mod) {
  if (panelTabs.has(mod.id)) return;

  const btn = document.createElement('button');
  btn.className = 'panel-tab';
  btn.textContent = mod.toolbar?.label || mod.name;
  btn.title = mod.description || mod.name;
  btn.dataset.modId = mod.id;

  // Badge element for unread notifications
  const badge = document.createElement('span');
  badge.className = 'panel-tab-badge';
  btn.appendChild(badge);

  btn.addEventListener('click', () => {
    _togglePanelTab(mod.id);
  });

  panelTabsContainer.appendChild(btn);
  panelTabs.set(mod.id, btn);

  // Show the tabs strip if we have panel tabs
  if (panelTabs.size > 0) {
    panelTabsContainer.style.display = 'flex';
  }
}

/**
 * Remove a panel tab button.
 */
function _removePanelTab(modId) {
  const btn = panelTabs.get(modId);
  if (btn) {
    btn.remove();
    panelTabs.delete(modId);
  }

  // Hide tabs strip if no more panel tabs
  if (panelTabs.size === 0) {
    panelTabsContainer.style.display = 'none';
  }
}

/**
 * Toggle a panel tab: if it's already visible, collapse; otherwise switch to it.
 */
function _togglePanelTab(modId) {
  if (visiblePanelId === modId) {
    // Same tab clicked while visible → collapse
    _hidePanel();
  } else {
    // Different tab or panel collapsed → switch to it
    _switchToPanel(modId);
  }
}

/**
 * Switch the visible panel to a specific mod.
 */
function _switchToPanel(modId) {
  if (!panelMods.has(modId)) return;

  // Hide all panel iframes
  for (const [id, entry] of panelMods) {
    entry.iframe.style.display = id === modId ? '' : 'none';
  }

  visiblePanelId = modId;

  // Update tab active states
  for (const [id, btn] of panelTabs) {
    btn.classList.toggle('active', id === modId);
  }

  _showPanel();

  localStorage.setItem(ACTIVE_PANEL_KEY, modId);
}

// ─── Panel lifecycle ─────────────────────────────────────────────────

/**
 * Load a panel mod's iframe.
 * Called when mod is enabled. The iframe stays alive until the mod is disabled.
 */
function _loadPanelMod(mod) {
  // Already loaded
  if (panelMods.has(mod.id)) return;

  // Create panel iframe
  const entry = mod.entry || 'index.html';
  const iframeEl = document.createElement('iframe');
  iframeEl.src = `/mods/${mod.id}/${entry}`;
  iframeEl.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframeEl.style.display = 'none'; // Hidden until switched to
  panelContainer.appendChild(iframeEl);
  iframeEl.addEventListener('load', () => {
    _injectBridgeAPI(iframeEl, mod.id);
  });

  panelMods.set(mod.id, { iframe: iframeEl, mod });

  // Create panel tab
  _createPanelTab(mod);
}

/**
 * Show the panel UI (container + resizer visible).
 */
function _showPanel() {
  if (!visiblePanelId) return;

  // Don't show panel/resizer if a fullscreen mod is active
  if (!modViewVisible) {
    panelContainer.style.display = 'block';
    panelContainer.style.width = panelWidth + 'px';
    panelResizer.style.display = 'block';
    document.getElementById('terminals').style.display = 'block';
  }

  localStorage.setItem(PANEL_VISIBLE_KEY, 'true');

  // Trigger resize so terminal refits to smaller width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Hide the panel UI but keep all iframes alive.
 */
function _hidePanel() {
  visiblePanelId = null;

  // Clear tab active states
  for (const [, btn] of panelTabs) {
    btn.classList.remove('active');
  }

  // Hide panel container + resizer
  panelContainer.style.display = 'none';
  panelResizer.style.display = 'none';

  localStorage.setItem(PANEL_VISIBLE_KEY, 'false');
  localStorage.removeItem(ACTIVE_PANEL_KEY);

  // Trigger resize so terminal refits to full width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Fully unload a panel mod (destroy iframe, clear callbacks, remove tab).
 * Called when the mod is disabled.
 */
function _unloadPanelMod(modId) {
  const entry = panelMods.get(modId);
  if (!entry) return;

  // Remove iframe
  entry.iframe.remove();
  panelMods.delete(modId);

  // Remove tab
  _removePanelTab(modId);

  // Filter out callbacks for this mod
  taskCallbacks = taskCallbacks.filter(e => e.modId !== modId);
  agentChatCallbacks = agentChatCallbacks.filter(e => e.modId !== modId);
  browserEvalCallbacks = browserEvalCallbacks.filter(e => e.modId !== modId);
  browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e.modId !== modId);
  screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e.modId !== modId);
  settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);

  // If it was the visible panel, switch to another or collapse
  if (visiblePanelId === modId) {
    const remaining = [...panelMods.keys()];
    if (remaining.length > 0) {
      _switchToPanel(remaining[0]);
    } else {
      visiblePanelId = null;
      panelContainer.style.display = 'none';
      panelResizer.style.display = 'none';
      localStorage.removeItem(PANEL_VISIBLE_KEY);
      localStorage.removeItem(ACTIVE_PANEL_KEY);
      window.dispatchEvent(new Event('resize'));
    }
  }
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

  // Insert at top of #tabs, right after the layout toggle button
  const tabs = document.getElementById('tabs');
  const layoutToggle = document.getElementById('layout-toggle');
  tabs.insertBefore(btn, layoutToggle.nextSibling);

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
  // Tools-only mods have no entry point — nothing to show
  if (!mod.entry) return;

  const display = mod.display || 'fullscreen';

  // Panel mods are handled by panel tabs, not fullscreen view
  if (display === 'panel') {
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
      _injectBridgeAPI(iframe, mod.id);
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
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== hiddenModId);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== hiddenModId);
  if (hiddenModId) {
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== hiddenModId);
  }

  _destroyIframe();

  // Clear toolbar button states
  for (const [, btn] of toolbarButtons) {
    btn.classList.remove('active');
  }

  // Show content row, hide mod container and back button
  document.getElementById('content-row').style.display = '';
  modContainer.style.display = 'none';
  backBtn.style.display = 'none';
  modViewVisible = false;

  // Restore panel if it was logically visible while fullscreen mod was active
  if (visiblePanelId) {
    _showPanel();
  }
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
  document.getElementById('content-row').style.display = 'none';
  modContainer.style.display = 'flex';
  backBtn.style.display = 'none';
  modViewVisible = true;
}

/**
 * Switch from mod view to terminal view for a specific session.
 */
function showTerminalForSession(id) {
  modContainer.style.display = 'none';
  document.getElementById('content-row').style.display = '';
  modViewVisible = false;

  // Restore panel if it was logically visible
  if (visiblePanelId) {
    _showPanel();
  }

  // Show back button with mod name
  if (activeViewId) {
    const mod = allMods.find(m => m.id === activeViewId);
    backBtn.textContent = `\u2190 ${mod?.name || 'Back'}`;
    backBtn.style.display = '';
  }

  hooks.focusSession(id);
}

/**
 * Notify mods that the active session has changed.
 */
function notifyActiveSessionChanged(id) {
  for (const entry of activeSessionCallbacks) {
    try { entry.cb(id); } catch (e) { console.error('Active session callback error:', e); }
  }
}

/**
 * Notify mods that sessions have changed.
 */
function notifySessionsChanged(sessionList) {
  for (const entry of sessionCallbacks) {
    try { entry.cb(sessionList); } catch (e) { console.error('Mod callback error:', e); }
  }
}

/**
 * Notify panel mods that tasks have changed (called from app.js on WS broadcast).
 */
function notifyTasksChanged(tasks) {
  for (const entry of taskCallbacks) {
    try { entry.cb(tasks); } catch (e) { console.error('Task callback error:', e); }
  }
}

/**
 * Notify panel mods that agent chat has changed (called from app.js on WS broadcast).
 */
function notifyAgentChatChanged(channels) {
  for (const entry of agentChatCallbacks) {
    try { entry.cb(channels); } catch (e) { console.error('Agent chat callback error:', e); }
  }
}

/**
 * Notify panel mods of a browser-eval request (called from app.js on WS broadcast).
 */
function notifyBrowserEvalRequest(req) {
  for (const entry of browserEvalCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Browser eval callback error:', e); }
  }
}

/**
 * Notify panel mods of a browser-console request (called from app.js on WS broadcast).
 */
function notifyBrowserConsoleRequest(req) {
  for (const entry of browserConsoleCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Browser console callback error:', e); }
  }
}

/**
 * Notify panel mods of a screenshot-capture request (called from app.js on WS broadcast).
 */
function notifyScreenshotCaptureRequest(req) {
  for (const entry of screenshotCaptureCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Screenshot capture callback error:', e); }
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
 * Inject the deepsteve bridge API into a mod iframe.
 * @param {HTMLIFrameElement} iframeEl - The iframe element
 * @param {string} modId - The mod ID that owns this iframe
 */
function _injectBridgeAPI(iframeEl, modId) {
  try {
    iframeEl.contentWindow.deepsteve = {
      getDeepsteveVersion() {
        return deepsteveVersion;
      },
      getSessions() {
        return hooks.getSessions();
      },
      focusSession(id) {
        showTerminalForSession(id);
      },
      onSessionsChanged(cb) {
        const entry = { modId, cb };
        sessionCallbacks.push(entry);
        try { cb(hooks.getSessions()); } catch {}
        return () => {
          sessionCallbacks = sessionCallbacks.filter(e => e !== entry);
        };
      },
      getActiveSessionId() {
        return getActiveSessionIdFn ? getActiveSessionIdFn() : null;
      },
      onActiveSessionChanged(cb) {
        const entry = { modId, cb };
        activeSessionCallbacks.push(entry);
        // Fire immediately with current value
        if (getActiveSessionIdFn) {
          try { cb(getActiveSessionIdFn()); } catch {}
        }
        return () => {
          activeSessionCallbacks = activeSessionCallbacks.filter(e => e !== entry);
        };
      },
      createSession(cwd) {
        hooks.createSession(cwd);
      },
      killSession(id) {
        hooks.killSession(id);
      },
      getSettings() {
        const mod = allMods.find(m => m.id === modId);
        return mod ? _loadModSettings(mod) : {};
      },
      onSettingsChanged(cb) {
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
        const entry = { modId, cb };
        taskCallbacks.push(entry);
        // Fire immediately with current tasks from server
        fetch('/api/tasks').then(r => r.json()).then(data => {
          try { cb(data.tasks || []); } catch {}
        }).catch(() => {});
        return () => {
          taskCallbacks = taskCallbacks.filter(e => e !== entry);
        };
      },
      onAgentChatChanged(cb) {
        const entry = { modId, cb };
        agentChatCallbacks.push(entry);
        // Fire immediately with current data from server
        fetch('/api/agent-chat').then(r => r.json()).then(d => {
          try { cb(d.channels || {}); } catch {}
        }).catch(() => {});
        return () => {
          agentChatCallbacks = agentChatCallbacks.filter(e => e !== entry);
        };
      },
      onBrowserEvalRequest(cb) {
        const entry = { modId, cb };
        browserEvalCallbacks.push(entry);
        return () => {
          browserEvalCallbacks = browserEvalCallbacks.filter(e => e !== entry);
        };
      },
      onBrowserConsoleRequest(cb) {
        const entry = { modId, cb };
        browserConsoleCallbacks.push(entry);
        return () => {
          browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e !== entry);
        };
      },
      onScreenshotCaptureRequest(cb) {
        const entry = { modId, cb };
        screenshotCaptureCallbacks.push(entry);
        return () => {
          screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e !== entry);
        };
      },
      setPanelBadge(text) {
        const tab = panelTabs.get(modId);
        if (!tab) return;
        const badge = tab.querySelector('.panel-tab-badge');
        if (!badge) return;
        if (text) {
          badge.textContent = text;
          badge.classList.add('visible');
        } else {
          badge.textContent = '';
          badge.classList.remove('visible');
        }
      },
      updateSetting(key, value) {
        _saveModSetting(modId, key, value);
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
  const panelEntry = panelMods.get(modId);
  if (panelEntry) {
    // Clear stale callbacks for this mod before reload triggers re-injection
    taskCallbacks = taskCallbacks.filter(e => e.modId !== modId);
    agentChatCallbacks = agentChatCallbacks.filter(e => e.modId !== modId);
    browserEvalCallbacks = browserEvalCallbacks.filter(e => e.modId !== modId);
    browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e.modId !== modId);
    screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e.modId !== modId);
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
    sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
    activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);

    panelEntry.iframe.src = panelEntry.iframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
}

export const ModManager = {
  init,
  loadAvailableMods,
  showModView,
  showTerminalForSession,
  notifySessionsChanged,
  notifyActiveSessionChanged,
  notifyTasksChanged,
  notifyAgentChatChanged,
  notifyBrowserEvalRequest,
  notifyBrowserConsoleRequest,
  notifyScreenshotCaptureRequest,
  isModViewVisible,
  isModActive,
  handleModChanged,
};
