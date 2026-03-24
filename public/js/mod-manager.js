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

import { nsKey } from './storage-namespace.js';

const STORAGE_KEY = nsKey('deepsteve-enabled-mods'); // Set of enabled mod IDs
const KNOWN_MODS_KEY = nsKey('deepsteve-known-mods'); // All mod IDs known at last save
const ACTIVE_VIEW_KEY = nsKey('deepsteve-active-mod-view'); // Which mod view is currently showing
const PANEL_VISIBLE_KEY = nsKey('deepsteve-panel-visible'); // Whether the panel is shown
const ACTIVE_PANEL_KEY = nsKey('deepsteve-active-panel'); // Which panel tab is active

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
let sceneUpdateCallbacks = [];       // [{modId, cb}] — callbacks for scene-update-request
let sceneQueryCallbacks = [];        // [{modId, cb}] — callbacks for scene-query-request
let sceneSnapshotCallbacks = [];     // [{modId, cb}] — callbacks for scene-snapshot-request
let babyBrowserCallbacks = [];       // [{modId, cb}] — callbacks for baby-browser-request
let activeSessionCallbacks = [];     // [{modId, cb}] — callbacks for active session changes
let layoutCallbacks = [];            // [{modId, cb}] — callbacks for layout state changes
let getActiveSessionIdFn = null;     // set from appHooks
let deepsteveVersion = null;   // set from /api/mods response
let panelWidth = 360;
const MIN_PANEL_WIDTH = 200;
const PANEL_STORAGE_KEY = nsKey('deepsteve-panel-width');

// ─── Dependency helpers ──────────────────────────────────────────────

/**
 * Return transitive dependency list for a mod in load order (deepest first).
 * Throws on circular dependency.
 */
function _getRequiredMods(modId, visited = new Set()) {
  if (visited.has(modId)) {
    throw new Error(`Circular dependency: ${[...visited, modId].join(' → ')}`);
  }
  const mod = allMods.find(m => m.id === modId);
  if (!mod || !mod.requires || mod.requires.length === 0) return [];
  visited.add(modId);
  const result = [];
  for (const depId of mod.requires) {
    // Recurse into dep's own deps first (deepest first)
    for (const transitive of _getRequiredMods(depId, new Set(visited))) {
      if (!result.includes(transitive)) result.push(transitive);
    }
    if (!result.includes(depId)) result.push(depId);
  }
  return result;
}

/**
 * Return array of currently-enabled mod IDs that depend (directly or transitively) on the given mod.
 */
function _getDependents(modId) {
  const dependents = [];
  for (const mod of allMods) {
    if (!enabledMods.has(mod.id)) continue;
    if (mod.id === modId) continue;
    try {
      const deps = _getRequiredMods(mod.id);
      if (deps.includes(modId)) dependents.push(mod.id);
    } catch {
      // Circular dep — skip
    }
  }
  return dependents;
}

/**
 * Check whether all requirements for a mod are satisfiable.
 * Returns { satisfied, missing[], disabled[], error? }
 */
function _checkRequirements(modId) {
  let deps;
  try {
    deps = _getRequiredMods(modId);
  } catch (e) {
    return { satisfied: false, missing: [], disabled: [], error: e.message };
  }
  const missing = [];  // not installed at all
  const disabled = []; // installed but not enabled
  for (const depId of deps) {
    const installed = allMods.find(m => m.id === depId);
    if (!installed) {
      missing.push(depId);
    } else if (!enabledMods.has(depId)) {
      disabled.push(depId);
    }
  }
  return { satisfied: missing.length === 0, missing, disabled };
}

/**
 * Show a brief dependency notice on a mod card that auto-fades after 4s.
 * type: 'info' | 'error'
 */
function _showDepNotice(card, message, type) {
  // Remove any existing notice on this card
  const existing = card.querySelector('.mod-dep-notice');
  if (existing) existing.remove();

  const notice = document.createElement('div');
  notice.className = `mod-dep-notice mod-dep-notice-${type}`;
  notice.textContent = message;
  card.appendChild(notice);
  setTimeout(() => notice.remove(), 4000);
}

/**
 * Refresh all checkbox toggle states in the marketplace modal to match enabledMods.
 * Requires card.dataset.modId on each card.
 */
function _refreshCardToggles(overlay) {
  for (const card of overlay.querySelectorAll('.mod-card[data-mod-id]')) {
    const id = card.dataset.modId;
    const cb = card.querySelector('.mod-card-toggle input[type="checkbox"]');
    if (cb) cb.checked = enabledMods.has(id);
  }
}

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

  // Cross-tab sync for regular (non-skill) mods via storage events
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || e.storageArea !== localStorage) return;
    let newSet;
    try {
      const parsed = JSON.parse(e.newValue);
      newSet = new Set(Array.isArray(parsed) ? parsed : []);
    } catch { return; }

    // Find newly enabled mods
    for (const id of newSet) {
      if (!enabledMods.has(id)) {
        enabledMods.add(id);
        const mod = allMods.find(m => m.id === id);
        if (!mod) continue;
        if (mod.display === 'panel') {
          _loadPanelMod(mod);
        } else if (mod.display !== 'tab' && mod.entry) {
          _createToolbarButton(mod);
        }
      }
    }

    // Find newly disabled mods
    for (const id of [...enabledMods]) {
      if (!newSet.has(id)) {
        enabledMods.delete(id);
        const mod = allMods.find(m => m.id === id);
        if (!mod) continue;
        if (mod.display === 'panel') {
          _unloadPanelMod(id);
        } else if (mod.display === 'tab') {
          if (hooks?.closeModTabs) hooks.closeModTabs(id);
        } else {
          _removeToolbarButton(id);
          if (activeViewId === id) _hideMod();
        }
      }
    }

    // Refresh marketplace modal toggles if open
    const overlay = document.querySelector('.modal-overlay:has(.marketplace-modal)');
    if (overlay) _refreshCardToggles(overlay);
  });
}

/**
 * Persist enabled mod IDs to localStorage.
 */
function _saveEnabledMods() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabledMods]));
  if (allMods.length > 0) {
    localStorage.setItem(KNOWN_MODS_KEY, JSON.stringify(allMods.map(m => m.id)));
  }
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
    const stored = JSON.parse(localStorage.getItem(nsKey(`deepsteve-mod-settings-${mod.id}`)));
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
  localStorage.setItem(nsKey(`deepsteve-mod-settings-${modId}`), JSON.stringify(current));
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

  // Create toolbar buttons for enabled non-panel, non-tab mods
  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.entry && mod.display !== 'panel' && mod.display !== 'tab' && mod.compatible !== false) {
      _createToolbarButton(mod);
    }
  }

  // Auto-enable enabledByDefault mods
  if (!hasExplicitModPrefs) {
    // First visit — enable all enabledByDefault mods
    for (const mod of allMods) {
      if (mod.enabledByDefault && mod.compatible !== false) {
        try {
          for (const depId of _getRequiredMods(mod.id)) {
            const depMod = allMods.find(m => m.id === depId);
            if (depMod && depMod.compatible !== false) enabledMods.add(depId);
          }
        } catch {} // skip on circular dep
        enabledMods.add(mod.id);
      }
    }
    _saveEnabledMods();
  } else {
    // Existing user — auto-enable any NEW enabledByDefault mods not in the known set
    let knownMods = new Set();
    try {
      const raw = localStorage.getItem(KNOWN_MODS_KEY);
      if (raw) knownMods = new Set(JSON.parse(raw));
    } catch {}
    let changed = false;
    for (const mod of allMods) {
      if (mod.enabledByDefault && mod.compatible !== false && !knownMods.has(mod.id)) {
        try {
          for (const depId of _getRequiredMods(mod.id)) {
            const depMod = allMods.find(m => m.id === depId);
            if (depMod && depMod.compatible !== false) enabledMods.add(depId);
          }
        } catch {}
        enabledMods.add(mod.id);
        changed = true;
      }
    }
    if (changed) _saveEnabledMods();
    // Always update known mods to track the current set
    if (allMods.length > 0) {
      localStorage.setItem(KNOWN_MODS_KEY, JSON.stringify(allMods.map(m => m.id)));
    }
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
  let automations = [];
  try {
    const [modsRes, catalogRes, automationsRes] = await Promise.all([
      fetch('/api/mods').then(r => r.json()).catch(() => null),
      fetch('/api/mods/catalog').then(r => r.json()).catch(() => ({ mods: [] })),
      fetch('/api/automations').then(r => r.json()).catch(() => ({ automations: [] }))
    ]);
    if (modsRes) {
      allMods = modsRes.mods || [];
      deepsteveVersion = modsRes.deepsteveVersion || null;
    }
    catalogMods = catalogRes.mods || [];
    automations = automationsRes.automations || [];
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
  const filterNames = ['All', 'Enabled', 'Skills', 'Panel', 'Fullscreen', 'Games'];
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

  // Automations section
  const automationsSection = document.createElement('div');
  automationsSection.className = 'automations-section';
  _renderAutomationsSection(automations, automationsSection);

  modal.appendChild(header);
  modal.appendChild(filters);
  modal.appendChild(automationsSection);
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
        const tags = (mod.tags || []).join(' ').toLowerCase();
        if (!name.includes(q) && !desc.includes(q) && !tags.includes(q)) return false;
      }
      // Category filter
      if (activeFilter === 'enabled') return mod.type === 'skill' ? mod.enabled : enabledMods.has(mod.id);
      if (activeFilter === 'skills') return mod.type === 'skill';
      if (activeFilter === 'panel') return mod.type !== 'skill' && mod.display === 'panel';
      if (activeFilter === 'fullscreen') return mod.type !== 'skill' && mod.display !== 'panel';
      if (activeFilter === 'games') return mod.tags && mod.tags.includes('games');
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
      _renderAutomationsSection(automations, automationsSection, searchQuery);
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
function _createSkillCard(mod, marketplaceOverlay) {
  const card = document.createElement('div');
  card.className = 'mod-card';
  card.dataset.modId = mod.id;

  // Extract skill ID from "skill:github-issue"
  const skillId = mod.id.replace('skill:', '');

  // Header
  const header = document.createElement('div');
  header.className = 'mod-card-header';

  const info = document.createElement('div');
  info.className = 'mod-card-info';
  info.innerHTML = `<span class="mod-card-name">${mod.slashCommand || mod.name}</span>` +
    `<span class="mod-badge skill">Skill</span>` +
    `<span class="mod-badge built-in">Built-in</span>`;

  const actions = document.createElement('div');
  actions.className = 'mod-card-actions';

  const toggle = document.createElement('label');
  toggle.className = 'mod-card-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!mod.enabled;
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  toggle.appendChild(checkbox);
  toggle.appendChild(slider);

  checkbox.addEventListener('change', async () => {
    const endpoint = checkbox.checked ? '/api/skills/enable' : '/api/skills/disable';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed');
      }
      mod.enabled = checkbox.checked;
    } catch (e) {
      checkbox.checked = !checkbox.checked; // revert
      _showDepNotice(card, e.message, 'error');
    }
  });

  const viewBtn = document.createElement('button');
  viewBtn.className = 'skill-view-btn';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/content`);
      if (!res.ok) throw new Error('Failed to load skill content');
      const { content } = await res.json();
      _showSkillContentModal(mod.slashCommand || mod.name, content);
    } catch (e) {
      _showDepNotice(card, e.message, 'error');
    }
  });

  actions.appendChild(viewBtn);
  actions.appendChild(toggle);
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

  // Argument hint
  if (mod.argumentHint) {
    const hint = document.createElement('div');
    hint.className = 'mod-card-description';
    hint.style.color = 'var(--ds-text-secondary)';
    hint.style.fontSize = '11px';
    hint.textContent = `Usage: ${mod.slashCommand} ${mod.argumentHint}`;
    card.appendChild(hint);
  }

  return card;
}

function _showSkillContentModal(name, content) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal skill-content-modal">
      <div class="modal-header"><span>${name}</span></div>
      <div class="skill-content-body"><pre></pre></div>
      <div class="modal-footer"><button class="btn" data-close>Close</button></div>
    </div>`;
  overlay.querySelector('pre').textContent = content;
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// --- Automations ---

function _renderAutomationsSection(automations, section, searchQuery = '') {
  section.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'automations-label';
  label.textContent = 'Automations';
  section.appendChild(label);

  const q = searchQuery.toLowerCase();
  const filtered = q
    ? automations.filter(a => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
    : automations;

  // Hide section entirely if search yields no matches and there's a query
  if (q && filtered.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  if (filtered.length === 0) {
    // Empty state
    const empty = document.createElement('div');
    empty.className = 'automations-empty';
    const btn = document.createElement('button');
    btn.className = 'automations-empty-btn';
    btn.textContent = '+';
    btn.addEventListener('click', () => _showAutomationEditModal(null, automations, section));
    const txt = document.createElement('div');
    txt.className = 'automations-empty-label';
    txt.textContent = 'Create an automation →';
    empty.appendChild(btn);
    empty.appendChild(txt);
    section.appendChild(empty);
    return;
  }

  const row = document.createElement('div');
  row.className = 'automations-row';

  for (const auto of filtered) {
    const chip = document.createElement('div');
    chip.className = 'automation-chip';
    chip.innerHTML = `<span class="automation-chip-icon">${auto.icon || '⚡'}</span><span>${auto.name}</span>`;
    chip.addEventListener('click', (e) => _showAutomationContextMenu(e, auto, automations, section));
    row.appendChild(chip);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'automation-add-btn';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => _showAutomationEditModal(null, automations, section));
  row.appendChild(addBtn);

  section.appendChild(row);
}

function _showAutomationContextMenu(e, auto, automations, section) {
  // Remove any existing context menu
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const editItem = document.createElement('div');
  editItem.className = 'context-menu-item';
  editItem.textContent = 'Edit';
  editItem.onclick = () => {
    menu.remove();
    _showAutomationEditModal(auto, automations, section);
  };
  menu.appendChild(editItem);

  const deleteItem = document.createElement('div');
  deleteItem.className = 'context-menu-item';
  deleteItem.textContent = 'Delete';
  deleteItem.style.color = 'var(--ds-accent-red)';
  deleteItem.onclick = async () => {
    menu.remove();
    if (!confirm(`Delete automation "${auto.name}"?`)) return;
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(auto.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      const idx = automations.findIndex(a => a.id === auto.id);
      if (idx >= 0) automations.splice(idx, 1);
      _renderAutomationsSection(automations, section);
    } catch (err) {
      alert('Failed to delete automation: ' + err.message);
    }
  };
  menu.appendChild(deleteItem);

  // Position near click
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);

  // Close on outside click
  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
}

function _showAutomationEditModal(existing, automations, section) {
  const isEdit = !!existing;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.width = '480px';

  const headerEl = document.createElement('div');
  headerEl.className = 'modal-header';
  headerEl.innerHTML = `<span>${isEdit ? 'Edit Automation' : 'New Automation'}</span>`;
  modal.appendChild(headerEl);

  const form = document.createElement('div');
  form.className = 'automation-modal-form';

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. Email digest';
  nameInput.value = existing ? existing.name : '';
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const iconLabel = document.createElement('label');
  iconLabel.textContent = 'Icon';
  const iconInput = document.createElement('input');
  iconInput.type = 'text';
  iconInput.placeholder = '⚡';
  iconInput.value = existing ? (existing.icon || '⚡') : '⚡';
  iconInput.style.width = '60px';
  iconLabel.appendChild(iconInput);
  form.appendChild(iconLabel);

  const bodyLabel = document.createElement('label');
  bodyLabel.textContent = 'Instructions';
  const bodyInput = document.createElement('textarea');
  bodyInput.placeholder = 'Instructions for Claude...';
  bodyLabel.appendChild(bodyInput);
  form.appendChild(bodyLabel);

  modal.appendChild(form);

  // If editing, load the full body
  if (isEdit) {
    fetch(`/api/automations/${encodeURIComponent(existing.id)}`)
      .then(r => r.json())
      .then(data => { bodyInput.value = data.body || ''; })
      .catch(() => {});
  }

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.style.justifyContent = 'flex-end';
  footer.style.padding = '12px 20px 20px';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const id = existing ? existing.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id) { nameInput.focus(); return; }
    const icon = iconInput.value.trim() || '⚡';
    const body = bodyInput.value;

    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, icon, body })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Save failed');
      }
      // Update local list
      const idx = automations.findIndex(a => a.id === id);
      const entry = { id, name, icon, description: name };
      if (idx >= 0) automations[idx] = entry;
      else automations.push(entry);
      _renderAutomationsSection(automations, section);
      overlay.remove();
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  nameInput.focus();
}

function _createModCard(mod, marketplaceOverlay) {
  // Skills get a simplified card
  if (mod.type === 'skill') return _createSkillCard(mod, marketplaceOverlay);

  const card = document.createElement('div');
  card.className = 'mod-card' + (mod.compatible === false ? ' mod-card-incompatible' : '');
  card.dataset.modId = mod.id;

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
  info.innerHTML = `<span class="mod-card-name">${mod.name || mod.id}</span><span class="mod-badge ${badgeClass}">${badgeText}</span>` +
    (mod.experimental ? `<span class="mod-badge experimental">Experimental</span>` : '') +
    `<span class="mod-card-version">v${mod.version || '?'}</span>`;

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
    const reqCheck = _checkRequirements(mod.id);
    checkbox.disabled = mod.compatible === false || reqCheck.missing.length > 0;
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    toggle.appendChild(checkbox);
    toggle.appendChild(slider);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        // ── Enable: check dependencies first ──
        const req = _checkRequirements(mod.id);
        if (req.error) {
          checkbox.checked = false;
          _showDepNotice(card, req.error, 'error');
          return;
        }
        if (req.missing.length > 0) {
          checkbox.checked = false;
          _showDepNotice(card, `Missing: ${req.missing.join(', ')}`, 'error');
          return;
        }
        // Auto-enable disabled dependencies
        const alsoEnabled = [];
        for (const depId of req.disabled) {
          const depMod = allMods.find(m => m.id === depId);
          if (!depMod) continue;
          enabledMods.add(depId);
          if (depMod.display === 'panel') {
            _loadPanelMod(depMod);
          } else if (depMod.display !== 'tab' && depMod.entry) {
            _createToolbarButton(depMod);
          }
          alsoEnabled.push(depMod.name || depId);
        }
        // Enable the mod itself
        enabledMods.add(mod.id);
        if (mod.display === 'panel') {
          _loadPanelMod(mod);
          _switchToPanel(mod.id);
        } else if (mod.display !== 'tab' && mod.entry) {
          _createToolbarButton(mod);
        }
        if (alsoEnabled.length > 0) {
          _showDepNotice(card, `Also enabled: ${alsoEnabled.join(', ')}`, 'info');
          _refreshCardToggles(marketplaceOverlay);
        }
      } else {
        // ── Disable: cascade-disable dependents first ──
        const dependents = _getDependents(mod.id);
        const alsoDisabled = [];
        for (const depId of dependents) {
          const depMod = allMods.find(m => m.id === depId);
          enabledMods.delete(depId);
          if (depMod?.display === 'panel') {
            _unloadPanelMod(depId);
          } else if (depMod?.display === 'tab') {
            if (hooks?.closeModTabs) hooks.closeModTabs(depId);
          } else {
            _removeToolbarButton(depId);
            if (activeViewId === depId) _hideMod();
          }
          alsoDisabled.push(depMod?.name || depId);
        }
        // Disable the mod itself
        enabledMods.delete(mod.id);
        if (mod.display === 'panel') {
          _unloadPanelMod(mod.id);
        } else if (mod.display === 'tab') {
          if (hooks?.closeModTabs) hooks.closeModTabs(mod.id);
        } else {
          _removeToolbarButton(mod.id);
          if (activeViewId === mod.id) {
            _hideMod();
          }
        }
        if (alsoDisabled.length > 0) {
          _showDepNotice(card, `Also disabled: ${alsoDisabled.join(', ')}`, 'info');
          _refreshCardToggles(marketplaceOverlay);
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

  // Dependency tags
  if (mod.requires && mod.requires.length > 0) {
    const depsRow = document.createElement('div');
    depsRow.className = 'mod-card-deps';
    depsRow.textContent = 'Requires: ';
    for (const depId of mod.requires) {
      const depMod = allMods.find(m => m.id === depId);
      const tag = document.createElement('span');
      if (!depMod) {
        tag.className = 'dep-tag dep-tag-red';
        tag.textContent = depId;
        tag.title = 'Not installed';
      } else if (!enabledMods.has(depId)) {
        tag.className = 'dep-tag dep-tag-orange';
        tag.textContent = depMod.name || depId;
        tag.title = 'Installed but disabled — will be auto-enabled';
      } else {
        tag.className = 'dep-tag dep-tag-green';
        tag.textContent = depMod.name || depId;
        tag.title = 'Enabled';
      }
      depsRow.appendChild(tag);
    }
    card.appendChild(depsRow);
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
        // Cascade-disable dependents, then disable mod itself
        if (enabledMods.has(mod.id)) {
          for (const depId of _getDependents(mod.id)) {
            const depMod = allMods.find(m => m.id === depId);
            enabledMods.delete(depId);
            if (depMod?.display === 'panel') {
              _unloadPanelMod(depId);
            } else {
              _removeToolbarButton(depId);
              if (activeViewId === depId) _hideMod();
            }
          }
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
  if (mod.permissions?.length) {
    iframeEl.setAttribute('allow', mod.permissions.join('; '));
  }
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
  sceneUpdateCallbacks = sceneUpdateCallbacks.filter(e => e.modId !== modId);
  sceneQueryCallbacks = sceneQueryCallbacks.filter(e => e.modId !== modId);
  sceneSnapshotCallbacks = sceneSnapshotCallbacks.filter(e => e.modId !== modId);
  babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e.modId !== modId);
  settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);
  layoutCallbacks = layoutCallbacks.filter(e => e.modId !== modId);

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
    if (mod.permissions?.length) {
      iframe.setAttribute('allow', mod.permissions.join('; '));
    }
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
function notifyLayoutChanged(state) {
  for (const entry of layoutCallbacks) {
    try { entry.cb(state); } catch (e) { console.error('Layout callback error:', e); }
  }
}

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
 * Notify mods of a baby-browser request (called from app.js on WS broadcast).
 */
function notifyBabyBrowserRequest(req) {
  for (const entry of babyBrowserCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Baby browser callback error:', e); }
  }
}

/**
 * Notify panel mods of a scene-update request (called from app.js on WS broadcast).
 */
function notifySceneUpdateRequest(req) {
  for (const entry of sceneUpdateCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Scene update callback error:', e); }
  }
}

/**
 * Notify panel mods of a scene-query request (called from app.js on WS broadcast).
 */
function notifySceneQueryRequest(req) {
  for (const entry of sceneQueryCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Scene query callback error:', e); }
  }
}

/**
 * Notify panel mods of a scene-snapshot request (called from app.js on WS broadcast).
 */
function notifySceneSnapshotRequest(req) {
  for (const entry of sceneSnapshotCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Scene snapshot callback error:', e); }
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
      createSession(cwd, opts) {
        return hooks.createSession(cwd, opts);
      },
      killSession(id, opts) {
        hooks.killSession(id, opts);
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
      // Layout management
      getLayoutState() {
        return hooks.getLayoutState?.() || { layoutId: 'single', panes: [], focusedPane: 0, presets: [] };
      },
      setLayout(layoutId) {
        hooks.setLayout?.(layoutId);
      },
      assignPane(paneIndex, sessionId) {
        hooks.assignPane?.(paneIndex, sessionId);
      },
      focusPane(index) {
        hooks.focusPane?.(index);
      },
      onLayoutChanged(cb) {
        const entry = { modId, cb };
        layoutCallbacks.push(entry);
        // Fire immediately with current state
        try { cb(hooks.getLayoutState?.() || { layoutId: 'single', panes: [], focusedPane: 0, presets: [] }); } catch {}
        return () => {
          layoutCallbacks = layoutCallbacks.filter(e => e !== entry);
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
      onSceneUpdateRequest(cb) {
        const entry = { modId, cb };
        sceneUpdateCallbacks.push(entry);
        return () => {
          sceneUpdateCallbacks = sceneUpdateCallbacks.filter(e => e !== entry);
        };
      },
      onSceneQueryRequest(cb) {
        const entry = { modId, cb };
        sceneQueryCallbacks.push(entry);
        return () => {
          sceneQueryCallbacks = sceneQueryCallbacks.filter(e => e !== entry);
        };
      },
      onSceneSnapshotRequest(cb) {
        const entry = { modId, cb };
        sceneSnapshotCallbacks.push(entry);
        return () => {
          sceneSnapshotCallbacks = sceneSnapshotCallbacks.filter(e => e !== entry);
        };
      },
      onBabyBrowserRequest(cb) {
        const entry = { modId, cb };
        babyBrowserCallbacks.push(entry);
        return () => {
          babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e !== entry);
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
/**
 * Handle skills-changed broadcast from server (another tab toggled a skill).
 * Updates allMods enabled state and refreshes any open marketplace modal.
 */
function handleSkillsChanged(enabledSkills) {
  const enabledSet = new Set(enabledSkills || []);
  for (const mod of allMods) {
    if (mod.type === 'skill') {
      const skillId = mod.id.replace('skill:', '');
      mod.enabled = enabledSet.has(skillId);
    }
  }
  // Refresh skill toggles in open marketplace modal if present
  const overlay = document.querySelector('.modal-overlay:has(.marketplace-modal)');
  if (overlay) {
    for (const card of overlay.querySelectorAll('.mod-card[data-mod-id^="skill:"]')) {
      const cb = card.querySelector('.mod-card-toggle input[type="checkbox"]');
      const mod = allMods.find(m => m.id === card.dataset.modId);
      if (cb && mod) cb.checked = !!mod.enabled;
    }
  }
}

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
    babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e.modId !== modId);
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
    sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
    activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);
    layoutCallbacks = layoutCallbacks.filter(e => e.modId !== modId);

    panelEntry.iframe.src = panelEntry.iframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
}

/**
 * Focus a panel mod by switching to it (and showing the panel if collapsed).
 */
function focusPanel(modId) {
  _switchToPanel(modId);
}

/**
 * Get context menu items from enabled mods' manifests.
 * Returns [{ label, modId, action }] for mods that declare a contextMenu array.
 */
function getContextMenuItems() {
  const items = [];
  for (const mod of allMods) {
    if (!enabledMods.has(mod.id)) continue;
    if (!mod.contextMenu) continue;
    for (const entry of mod.contextMenu) {
      items.push({ label: entry.label, modId: mod.id, action: entry.action });
    }
  }
  return items;
}

/**
 * Get new-tab menu items from enabled tab-display mods.
 * Returns [{ modId, label, entry }].
 */
function getNewTabItems() {
  const items = [];
  for (const mod of allMods) {
    if (!enabledMods.has(mod.id)) continue;
    if (mod.display !== 'tab') continue;
    if (mod.compatible === false) continue;
    items.push({ modId: mod.id, label: mod.tabOption?.label || mod.name, entry: mod.entry });
  }
  return items;
}

export const ModManager = {
  init,
  loadAvailableMods,
  showModView,
  showTerminalForSession,
  notifySessionsChanged,
  notifyActiveSessionChanged,
  notifyLayoutChanged,
  notifyTasksChanged,
  notifyAgentChatChanged,
  notifyBrowserEvalRequest,
  notifyBrowserConsoleRequest,
  notifyScreenshotCaptureRequest,
  notifySceneUpdateRequest,
  notifySceneQueryRequest,
  notifySceneSnapshotRequest,
  notifyBabyBrowserRequest,
  injectBridgeAPI: _injectBridgeAPI,
  isModViewVisible,
  isModActive,
  handleModChanged,
  handleSkillsChanged,
  focusPanel,
  getContextMenuItems,
  getNewTabItems,
};
