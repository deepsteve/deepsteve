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
import { tabIcon, TabManager } from './tab-manager.js';
import { MOD_ROW_SELECTOR, groupMods, isModEnabled } from './mod-groups.js';

/**
 * The sandbox every mod iframe gets, in one place so the panel path and the
 * fullscreen path cannot drift apart.
 *
 * `allow-same-origin` is load-bearing and not an oversight: the `window.deepsteve`
 * bridge is injected across the boundary and needs it. Mod iframes are same-origin
 * and trusted by design — see docs/mods.md; this attribute is not what isolates
 * them, and nothing should be written as though it were.
 *
 * `allow-pointer-lock` is what lets a 3D mod have a mouse-look camera. Without it
 * `requestPointerLock()` throws SecurityError, `document.pointerLockElement` stays
 * null, and every mousemove handler gated on it silently receives nothing — the
 * camera simply never turns, with no visible error. That is how village,
 * space-station and monkey-code all shipped.
 */
const MOD_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock';

const STORAGE_KEY = nsKey('deepsteve-enabled-mods'); // Set of enabled mod IDs
const KNOWN_MODS_KEY = nsKey('deepsteve-known-mods'); // All mod IDs known at last save
const ACTIVE_VIEW_KEY = nsKey('deepsteve-active-mod-view'); // Which mod view is currently showing
const PANEL_VISIBLE_KEY = nsKey('deepsteve-panel-visible'); // Whether the panel is shown
const ACTIVE_PANEL_KEY = nsKey('deepsteve-active-panel'); // Which panel tab is active
// Which apps you sit in with the chrome gone (#662). localStorage, not sessionStorage: it is a
// display preference, so it should hold across windows and reloads — the same call
// project-mods.js makes for its compact rail, and the same one ACTIVE_VIEW_KEY above makes for
// which app is open. It never reaches the server, so there is no SETTINGS_SCHEMA entry.
const QUIET_KEY = nsKey('deepsteve-app-quiet'); // JSON array of app ids you sit in quietly

let allMods = [];          // [{ id, name, description, entry, toolbar }]
let enabledMods = new Set(); // mod IDs that are enabled
let hasExplicitModPrefs = false; // true if user has saved mod prefs before
// The page currently occupying the ONE fullscreen view slot, or null. Generalized from a
// bare mod id in #628: the slot also hosts pages that are not DeepSteve Mods (a project
// mod's view). `id` is what every per-view sweep keys off, so a non-mod view namespaces it
// ('project-mod:<modId>') — the same string its bridge is injected under, which is exactly
// what makes those sweeps correct for it while every `=== someModId` comparison in this file
// correctly never matches.
let activeView = null;     // { id, name, src, sandbox, allow, persist, dismissOnLeave }
let iframe = null;
let modContainer = null;
let backBtn = null;
let quietBtn = null;       // quiet mode's toggle (#662) — lives IN the slot, see _paintQuietBtn
let hooks = null;
let sessionCallbacks = [];
let modViewVisible = false;
let toolbarButtons = new Map(); // modId → button element
let appRows = new Map();        // modId → the Apps rail row, for the .active sweep (#661)
let settingsCallbacks = [];     // [{modId, cb}] — notified on settings change

// Panel mode state — multi-panel
let panelContainer = null;
let panelResizer = null;
let panelMods = new Map();       // modId → { iframe, mod }
let visiblePanelId = null;       // which panel is currently VISIBLE (or null)
let panelTabsContainer = null;   // #panel-tabs DOM element
let panelTabs = new Map();       // modId → tab button element
let taskCallbacks = [];          // [{modId, cb}] — callbacks for task broadcasts
let scheduledTaskCallbacks = []; // [{modId, cb}] — callbacks for scheduled-task broadcasts
let agentChatCallbacks = [];     // [{modId, cb}] — callbacks for agent-chat broadcasts
let browserEvalCallbacks = [];   // [{modId, cb}] — callbacks for browser-eval-request
let browserConsoleCallbacks = []; // [{modId, cb}] — callbacks for browser-console-request
let screenshotCaptureCallbacks = []; // [{modId, cb}] — callbacks for screenshot-capture-request
let screenshotEventCallbacks = [];   // [{modId, cb}] — callbacks for screenshot-added/deleted broadcasts
let sceneUpdateCallbacks = [];       // [{modId, cb}] — callbacks for scene-update-request
let sceneQueryCallbacks = [];        // [{modId, cb}] — callbacks for scene-query-request
let sceneSnapshotCallbacks = [];     // [{modId, cb}] — callbacks for scene-snapshot-request
let babyBrowserCallbacks = [];       // [{modId, cb}] — callbacks for baby-browser-request
let wsReconnectedCallbacks = [];     // [{modId, cb}] — fired when any session WS reconnects
let activeSessionCallbacks = [];     // [{modId, cb}] — callbacks for active session changes
let userActivityCallbacks = [];      // [{modId, cb}] — fired when the user types into a terminal
let contextCallbacks = [];           // [{modId, cb}] — fired when the shared contexts (#526) change
let activeContextCallbacks = [];     // [{modId, cb}] — fired when the active context changes
// ─── Excursions (#661) ───────────────────────────────────────────────
// An APP — a mod with "app": true — can lend you out to a session, let you wander, and take
// you back with one key. The stack lives HERE, next to the one view slot it describes, because
// every consumer of it is already in this file: showView, showTerminalForSession, showModView,
// the back button and the bridge. A separate module would have three importers and still could
// not be asserted in isolation, since every interesting question is "did the slot background or
// foreground correctly".
//
// sessionStorage, not the localStorage ACTIVE_VIEW_KEY above: WHICH app is up is a browser-wide
// preference, WHERE you wandered is this window's business. It also has to die with the window,
// or a second window inherits an excursion nobody started.
const EXCURSION_KEY = nsKey('deepsteve-excursion');
// A trail you could grow without bound is a trail nobody walks back; 20 presses of ⌘← is
// already well past the point where the button is the answer.
const MAX_EXCURSION_DEPTH = 20;
let excursion = null;                // { appId, chrome, stack: [{ sessionId, label, reason, at }] }
// One view slot means one cycle handler; an array would need sweeping and a stale entry would
// permanently disable the fall-back to cycling projects, which is worse than leaking it.
let excursionCycleHandler = null;    // { viewId, cb }
let excursionChangedCallbacks = [];  // [{modId, cb}]
// visitSession() calls hooks.focusSession() itself, and that is a user-jump path which pushes.
// Without this the ⌘↑/⌘↓ replace would immediately push on top of itself and the stack would
// grow one frame per queue step — the exact thing the replace rule exists to prevent.
let suppressExcursionPush = false;
let getActiveSessionIdFn = null;     // set from appHooks
let getActiveContextIdFn = null;     // set from appHooks — reads the active context (#526)
let setActiveContextFn = null;       // set from appHooks — drives the active context (#526)
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
 * Show a brief dependency notice on a mod row that auto-fades after 4s.
 *
 * It attaches to the ROW, never to the row's detail body: the detail is collapsed by
 * default, and a notice rendered inside it would silently mute every "Also enabled: …" and
 * "Missing: …" message the dependency engine produces.
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
 * Refresh every toggle in the open Mods modal to match the real enabled state.
 * Requires row.dataset.modId on each row.
 *
 * It reads that state through isModEnabled() rather than `enabledMods.has(id)` because the
 * two kinds keep it in two different places, and asking the Set about a skill is a bug: a
 * skill's id is `skill:merge` and enabledMods only ever holds mod ids, so every dependency
 * cascade and every cross-tab `storage` event used to silently uncheck all nine skill
 * toggles in an open modal. Grouping makes that worse, not better — the skills now sit
 * together, so they would all blink off at once.
 */
function _refreshCardToggles(overlay) {
  for (const row of overlay.querySelectorAll(MOD_ROW_SELECTOR)) {
    const id = row.dataset.modId;
    const cb = row.querySelector('.mod-card-toggle input[type="checkbox"]');
    // A catalog-only row has no toggle and no entry in allMods; both are fine.
    if (cb) cb.checked = isModEnabled(allMods.find(m => m.id === id) || { id }, enabledMods);
  }
}

/**
 * Initialize the mod system — creates DOM elements.
 */
function init(appHooks) {
  hooks = appHooks;
  getActiveSessionIdFn = appHooks.getActiveSessionId || null;
  getActiveContextIdFn = appHooks.getActiveContextId || null;
  setActiveContextFn = appHooks.setActiveContext || null;

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

  // Restored before the view is, so the first paint of the back button already knows whether
  // it is a one-hop label or an excursion trail. Reading it here rather than at module scope
  // keeps the module import free of storage access.
  excursion = _loadExcursion();

  // Create back button (in #tabs, after layout-toggle)
  backBtn = document.createElement('button');
  backBtn.className = 'mod-back-btn';
  backBtn.style.display = 'none';
  // One button, two meanings: on an excursion it pops a single frame (and only an emptied
  // stack goes home), otherwise it is the one-hop return it has always been.
  backBtn.addEventListener('click', () => {
    if (isExcursionActive()) popExcursion();
    else showModView();
  });
  const layoutToggle = document.getElementById('layout-toggle');
  layoutToggle.parentNode.insertBefore(backBtn, layoutToggle.nextSibling);

  // Create the quiet-mode toggle (#662). Written here, next to the back button it is the
  // sibling of in spirit — but mounted in #mod-container, because quiet mode's whole job is to
  // take #tabs away and a button in there would go with it. _paintQuietBtn() owns everything
  // about how it looks; it starts hidden because no view is up yet.
  quietBtn = document.createElement('button');
  quietBtn.className = 'app-quiet-btn';
  quietBtn.style.display = 'none';
  quietBtn.addEventListener('click', () => setQuietMode(!isQuietMode()));
  modContainer.appendChild(quietBtn);

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
          if (activeView?.id === id) _hideMod();
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
  // The Apps rail section is a projection of this set (#661), and unlike the toolbar buttons —
  // which the toggle paths add and remove by hand — its rows only exist as of the rail's last
  // render. Without this, enabling an app while the rail is open shows nothing until something
  // else happens to re-render it.
  hooks?.onAppsChanged?.();
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
  // Reload lands here. _showMod() above raises the slot fullscreen, which is wrong if you were
  // out on an excursion when the page went away — so reconcile. syncExcursion() is idempotent
  // and re-runs from notifySessionsChanged(), which matters because whether the mod list or
  // the session restore finishes first is a race nobody may depend on. It also drops a stack
  // whose app failed to restore at all (disabled since, or claimed by another window).
  syncExcursion();

  // The rail is built synchronously in initContextViews(), which runs long before this fetch
  // resolves — so on a fresh load its Apps section is drawn against an empty mod list and
  // stays empty until something unrelated happens to re-render it. Tell the host the apps are
  // known now. (The toolbar buttons above have no such problem: they are inserted here.)
  hooks?.onAppsChanged?.();

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
  // Whether the MCP tool index has been scanned yet (#644). Kept, not discarded, because an
  // expanded row lists a mod's tools: without it an empty array during the boot window would
  // read as "this mod has no tools" instead of "nothing has been scanned yet".
  let mcpReady = true;
  try {
    const [modsRes, catalogRes, automationsRes] = await Promise.all([
      fetch('/api/mods').then(r => r.json()).catch(() => null),
      fetch('/api/mods/catalog').then(r => r.json()).catch(() => ({ mods: [] })),
      fetch('/api/automations').then(r => r.json()).catch(() => ({ automations: [] }))
    ]);
    if (modsRes) {
      allMods = modsRes.mods || [];
      deepsteveVersion = modsRes.deepsteveVersion || null;
      mcpReady = modsRes.mcpReady !== false;
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
      // A catalog row is a remote catalog.json entry, not a manifest we can read: it has no
      // entry/display/app/tags, so running the server's ladder over it would file every
      // downloadable mod under Background. Not-installed is the honest answer, and it is a
      // real section — the Install button has to live somewhere.
      kind: 'available',
    });
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal marketplace-modal';

  // Header. Built element-by-element rather than as one innerHTML string: the string form
  // makes the modal unrenderable under a fake DOM, because header.querySelector('input')
  // comes back null and the very next line throws.
  const header = document.createElement('div');
  header.className = 'marketplace-header';
  const title = document.createElement('h2');
  title.textContent = 'Mods & Skills';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'marketplace-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search mods, skills and automations...';
  searchWrap.appendChild(searchInput);
  header.append(title, searchWrap);

  // Navigation. The old row of pills was an EXCLUSIVE filter that mixed three axes — what a
  // thing is (Skills), how a mod draws (Panel/Fullscreen) and whether it is on (Enabled) —
  // so telling the kinds apart meant hiding everything else. Kind is now the grouping, which
  // leaves the chips free to be jump-to navigation and leaves state its own control.
  const nav = document.createElement('div');
  nav.className = 'marketplace-nav';
  const jump = document.createElement('div');
  jump.className = 'marketplace-jump';
  const enabledOnlyLabel = document.createElement('label');
  enabledOnlyLabel.className = 'marketplace-enabled-only';
  const enabledOnlyBox = document.createElement('input');
  enabledOnlyBox.type = 'checkbox';
  const enabledOnlyText = document.createElement('span');
  enabledOnlyText.textContent = 'Enabled only';
  enabledOnlyLabel.append(enabledOnlyBox, enabledOnlyText);
  nav.append(jump, enabledOnlyLabel);

  // List — the one scroll container. Sticky group headings resolve their `top: 0` against
  // this element, and the jump chips measure group.offsetTop against it, which is why it
  // carries `position: relative` in the CSS.
  const list = document.createElement('div');
  list.className = 'marketplace-list';

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-buttons';
  footer.innerHTML = '<button class="btn-secondary" data-close>Close</button>';

  // Automations section. Created once and re-attached on every render, because
  // `list.innerHTML = ''` detaches it — safe, since _renderAutomationsSection rebuilds all
  // its children and re-attaches all its listeners on every call.
  const automationsSection = document.createElement('div');
  automationsSection.className = 'automations-section';

  modal.append(header, nav, list, footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // State
  let enabledOnly = false;
  let searchQuery = '';
  let searchTimeout = null;
  // Which rows are open. Held across re-renders or typing one more character would collapse
  // whatever you had just expanded.
  const expandedIds = new Set();

  /** One group: sticky heading with a count, then its rows. */
  function appendGroup(kind, label, count, body) {
    const group = document.createElement('div');
    group.className = 'mod-group';
    group.dataset.kind = kind;
    const head = document.createElement('div');
    head.className = 'mod-group-head';
    const headLabel = document.createElement('span');
    headLabel.className = 'mod-group-title';
    headLabel.textContent = label;
    head.appendChild(headLabel);
    // A zero count is the automations empty state — the section is present because it
    // carries the only "create one" affordance, and "Automations 0" would just be wrong.
    _setCount(head, 'mod-group-count', count);
    group.append(head, body);
    list.appendChild(group);
    return group;
  }

  /** Repaint the Automations heading count and its jump chip after an in-place re-render. */
  function _syncAutomationCount(n) {
    const group = list.querySelector('.mod-group[data-kind="automation"]');
    if (!group) return;
    if (automationsSection.style.display === 'none') { group.hidden = true; return; }
    group.hidden = false;
    _setCount(group.querySelector('.mod-group-head'), 'mod-group-count', n);
    _setCount(jump.querySelector('.jump-chip[data-jump="automation"]'), 'jump-chip-count', n);
  }

  /** Add, update or drop a count span — zero means no span at all, everywhere. */
  function _setCount(host, cls, n) {
    if (!host) return;
    let el = host.querySelector(`.${cls}`);
    if (n > 0) {
      if (!el) { el = document.createElement('span'); el.className = cls; host.appendChild(el); }
      el.textContent = String(n);
    } else if (el) {
      el.remove();
    }
  }

  /** A jump chip. Navigation, not a filter — it scrolls, it never re-renders. */
  function appendJumpChip(label, count, group) {
    const chip = document.createElement('button');
    chip.className = 'jump-chip';
    chip.dataset.jump = group.dataset.kind;
    const chipLabel = document.createElement('span');
    chipLabel.textContent = label;
    chip.appendChild(chipLabel);
    // Same rule as the heading, through the same helper.
    _setCount(chip, 'jump-chip-count', count);
    // scrollTop against the list, not scrollIntoView, which would also scroll the page
    // behind the modal. With a sticky heading, offsetTop lands it right under the nav.
    chip.addEventListener('click', () => { list.scrollTop = group.offsetTop; });
    jump.appendChild(chip);
  }

  function render() {
    list.innerHTML = '';
    jump.innerHTML = '';

    // Automations first. They are not mods — no manifest, no enabled state, their own
    // endpoint — so they sit alongside rather than being bucketed by groupMods(), and
    // `Enabled only` leaves them alone: an automation is not on or off, it is runnable.
    // The renderer reports how many chips survived the search and hides itself outright on
    // a miss, which is what lets the section drop its heading like any other group.
    const autoCount = _renderAutomationsSection(automations, automationsSection, searchQuery);
    if (automationsSection.style.display !== 'none') {
      const group = appendGroup('automation', 'Automations', autoCount, automationsSection);
      appendJumpChip('Automations', autoCount, group);
    }
    // Saving or deleting an automation re-renders the section in place, from a call site
    // that knows nothing about this modal. Without this the chips change and the heading
    // and jump chip keep the old number.
    automationsSection.__afterRender = (n) => _syncAutomationCount(n);

    const groups = groupMods(unifiedMods, { query: searchQuery, enabledOnly, enabledIds: enabledMods });
    for (const g of groups) {
      const body = document.createElement('div');
      body.className = 'mod-group-body';
      for (const mod of g.items) body.appendChild(_createModRow(mod, overlay, { expandedIds, mcpReady }));
      const group = appendGroup(g.kind, g.label, g.items.length, body);
      appendJumpChip(g.label, g.items.length, group);
    }

    // Scoped to mods and skills on purpose — the automations section speaks for itself, so
    // this stays true whether or not an automation matched.
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'marketplace-empty';
      // Three different reasons for an empty list, and only the last is a real problem —
      // saying "untick Enabled only" when the box is not ticked would send you looking for
      // a control that is already off.
      if (searchQuery) empty.textContent = `No mods or skills match “${searchQuery}”`;
      else if (enabledOnly) empty.textContent = 'Nothing enabled — untick “Enabled only” to see everything';
      else empty.textContent = 'No mods or skills found';
      list.appendChild(empty);
    }
  }

  // Search input
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery = searchInput.value;
      render();
    }, 150);
  });

  enabledOnlyBox.addEventListener('change', () => {
    enabledOnly = enabledOnlyBox.checked;
    render();
  });

  // Close
  const close = () => overlay.remove();
  footer.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onEscMods = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onEscMods);
  new MutationObserver((_, obs) => { if (!overlay.parentNode) { document.removeEventListener('keydown', onEscMods); obs.disconnect(); } }).observe(document.body, { childList: true });

  render();
  searchInput.focus();
}

/**
 * Did the row's one-line description get cut off?
 *
 * The detail repeats the description only when it did — otherwise the expanded row would
 * show the same sentence twice, which is exactly the redundancy the dense row exists to
 * remove. A row that is not in the document yet (the re-expand-after-render path) measures
 * zero, and zero means "assume clipped": including the text is the harmless answer.
 */
function _descWasClipped(row) {
  const desc = row.querySelector('.mod-row-desc');
  if (!desc || !desc.clientWidth) return true;
  return desc.scrollWidth > desc.clientWidth + 1;
}

/** Skill id out of the `skill:github-issue` the wire uses. */
function _skillId(mod) {
  return mod.id.replace('skill:', '');
}

/**
 * A skill's toggle. Unlike a mod's, this one is a server round-trip — enabling installs the
 * .md into ~/.claude/commands and generates the Codex adaptation — so it reverts the
 * checkbox if the POST fails rather than assuming success.
 */
function _skillToggle(mod, row) {
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
        body: JSON.stringify({ id: _skillId(mod) })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed');
      }
      mod.enabled = checkbox.checked;
      // `mod` is unifiedMods' spread copy, but _refreshCardToggles reads the live allMods
      // entry. The server broadcast will sync it a moment later; until then a dependency
      // cascade on some other row would repaint this checkbox from the stale value.
      const live = allMods.find(m => m.id === mod.id);
      if (live) live.enabled = checkbox.checked;
    } catch (e) {
      checkbox.checked = !checkbox.checked; // revert
      _showDepNotice(row, e.message, 'error');
    }
  });

  return toggle;
}

/** The expanded body of a skill row: full description, what it is, how to call it. */
function _buildSkillDetail(mod, row) {
  const detail = document.createElement('div');
  detail.className = 'mod-row-detail';

  if (mod.description && _descWasClipped(row)) {
    const desc = document.createElement('div');
    desc.className = 'mod-card-description';
    desc.textContent = mod.description;
    detail.appendChild(desc);
  }

  const meta = document.createElement('div');
  meta.className = 'mod-row-meta';
  const badge = document.createElement('span');
  badge.className = 'mod-badge skill';
  badge.textContent = 'Skill';
  const builtIn = document.createElement('span');
  builtIn.className = 'mod-badge built-in';
  builtIn.textContent = 'Built-in';
  meta.append(badge, builtIn);
  detail.appendChild(meta);

  if (mod.argumentHint) {
    const hint = document.createElement('div');
    hint.className = 'mod-row-usage';
    hint.textContent = `Usage: ${mod.slashCommand} ${mod.argumentHint}`;
    detail.appendChild(hint);
  }

  const viewBtn = document.createElement('button');
  viewBtn.className = 'skill-view-btn';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(_skillId(mod))}/content`);
      if (!res.ok) throw new Error('Failed to load skill content');
      const { content } = await res.json();
      _showSkillContentModal(mod.slashCommand || mod.name, content);
    } catch (e) {
      _showDepNotice(row, e.message, 'error');
    }
  });
  detail.appendChild(viewBtn);

  return detail;
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

async function _showAutomationsModal() {
  let automations = [];
  try {
    const res = await fetch('/api/automations').then(r => r.json());
    automations = res.automations || [];
  } catch {}

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.width = '520px';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.innerHTML = '<span>Automations</span>';
  modal.appendChild(header);

  const section = document.createElement('div');
  section.className = 'automations-section';
  section.style.padding = '16px 20px';
  _renderAutomationsSection(automations, section);
  modal.appendChild(section);

  const footer = document.createElement('div');
  footer.className = 'modal-buttons';
  footer.innerHTML = '<button class="btn-secondary" data-close>Close</button>';
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    window.__deepsteve?.refreshAutomationsCache?.();
  };
  footer.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

/**
 * Render the automations chips into `section`.
 *
 * Returns how many chips it drew, which is what lets the Mods modal treat automations as a
 * peer section: an emptied section drops its heading like every other group instead of
 * leaving an orphan heading over nothing. The three other callers — the standalone
 * automations modal and the two in-place re-renders after a save or a delete — ignore the
 * return value and are otherwise untouched.
 *
 * A caller that re-renders in place after a save or a delete (the context menu, the edit
 * modal) has no idea what the user had typed, so the query is remembered ON the section and
 * reused when one is not passed — otherwise saving an edit under an active search silently
 * widens the section back to everything. `section.__afterRender` lets the Mods modal re-sync
 * the heading and jump-chip counts those same re-renders would otherwise leave stale. The
 * standalone modal sets neither and behaves exactly as before.
 */
function _renderAutomationsSection(automations, section, searchQuery = section.__query || '') {
  section.__query = searchQuery;
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
    section.__afterRender?.(0);
    return 0;
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
    // 0 chips, but the section is still VISIBLE: this is the only affordance for creating
    // a first automation, so the modal keeps the heading and simply omits the count.
    section.__afterRender?.(0);
    return 0;
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
  section.__afterRender?.(filtered.length);
  return filtered.length;
}

function _showAutomationContextMenu(e, auto, automations, section) {
  // Remove any existing context menu
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const runItem = document.createElement('div');
  runItem.className = 'context-menu-item';
  runItem.textContent = '\u25B6 Run';
  runItem.onclick = async () => {
    menu.remove();
    try {
      const resp = await fetch('/api/start-automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automationId: auto.id }),
      });
      // A refusal (#632: the automation's repo is gone) is a 400 with a reason, and
      // this used to be discarded — the Run item just did nothing, silently.
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        alert('Failed to start automation: ' + (body.error || `HTTP ${resp.status}`));
      }
    } catch (err) {
      alert('Failed to start automation: ' + err.message);
    }
  };
  menu.appendChild(runItem);

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
      window.__deepsteve?.refreshAutomationsCache?.();
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
  modal.className = 'modal automation-modal';

  const headerEl = document.createElement('div');
  headerEl.className = 'automation-modal-header';
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
  const iconRow = document.createElement('div');
  iconRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  const iconInput = document.createElement('input');
  iconInput.type = 'text';
  iconInput.placeholder = '⚡';
  iconInput.value = existing ? (existing.icon || '⚡') : '⚡';
  iconInput.style.width = '60px';
  const emojiPickerBtn = document.createElement('button');
  emojiPickerBtn.type = 'button';
  emojiPickerBtn.className = 'emoji-picker-btn';
  emojiPickerBtn.textContent = '😀';
  emojiPickerBtn.title = 'Pick an emoji';
  emojiPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Remove any existing picker
    document.querySelector('.emoji-picker-popup')?.remove();
    const EMOJI_GRID = ['⚡','🚀','⭐','🔥','💡','🎯','📧','📋','🔔','💬','🤖','🧹','📊','🔍','✅','❌','🎨','🛠️','📁','💾','🌐','📝','🔒','🔓','⏰','📅','🎉','💪','👁️','🧪','📦','🔄','💻','🗂️','📌','🏷️','🔗','⚙️','🎵','📸','🌟','💎','🧠','🦾','🏗️','📈','🔮','🎲'];
    const popup = document.createElement('div');
    popup.className = 'emoji-picker-popup';
    for (const emoji of EMOJI_GRID) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => { iconInput.value = emoji; popup.remove(); });
      popup.appendChild(btn);
    }
    // Position relative to the picker button
    const rect = emojiPickerBtn.getBoundingClientRect();
    popup.style.top = (rect.bottom + 4) + 'px';
    popup.style.left = rect.left + 'px';
    document.body.appendChild(popup);
    const closeOnClick = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', closeOnClick); } };
    setTimeout(() => document.addEventListener('click', closeOnClick), 0);
  });
  iconRow.appendChild(iconInput);
  iconRow.appendChild(emojiPickerBtn);
  iconLabel.appendChild(iconRow);
  form.appendChild(iconLabel);

  const descLabel = document.createElement('label');
  descLabel.textContent = 'Description';
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.placeholder = 'Brief description of what this automation does';
  descInput.value = existing ? (existing.description || '') : '';
  descLabel.appendChild(descInput);
  form.appendChild(descLabel);

  const repoLabel = document.createElement('label');
  repoLabel.textContent = 'Default Repo';
  const repoInput = document.createElement('input');
  repoInput.type = 'text';
  repoInput.placeholder = '/path/to/repo (optional)';
  repoInput.value = existing ? (existing.repo || '') : '';
  repoLabel.appendChild(repoInput);
  form.appendChild(repoLabel);

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
      .then(data => { bodyInput.value = data.body || ''; if (data.description) descInput.value = data.description; if (data.repo) repoInput.value = data.repo; })
      .catch(() => {});
  }

  const footer = document.createElement('div');
  footer.className = 'automation-modal-footer';

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
    const description = descInput.value.trim();
    const repo = repoInput.value.trim();
    const body = bodyInput.value;

    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, icon, description, repo, body })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Save failed');
      }
      // Update local list
      const idx = automations.findIndex(a => a.id === id);
      const entry = { id, name, icon, description: description || name };
      if (idx >= 0) automations[idx] = entry;
      else automations.push(entry);
      _renderAutomationsSection(automations, section);
      window.__deepsteve?.refreshAutomationsCache?.();
      overlay.remove();
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  });

  footer.appendChild(cancelBtn);
  if (isEdit) {
    const runBtn = document.createElement('button');
    runBtn.className = 'btn-secondary';
    runBtn.textContent = '\u25B6 Run';
    runBtn.addEventListener('click', async () => {
      overlay.remove();
      try {
        const resp = await fetch('/api/start-automation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ automationId: existing.id }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          alert('Failed to start automation: ' + (body.error || `HTTP ${resp.status}`));
        }
      } catch (err) {
        alert('Failed to start automation: ' + err.message);
      }
    });
    footer.appendChild(runBtn);
  }
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  nameInput.focus();
}

/** A `.mod-badge` pill. Text, never markup — see the note on mod.name below. */
function _badge(cls, text) {
  const el = document.createElement('span');
  el.className = `mod-badge ${cls}`;
  el.textContent = text;
  return el;
}

/**
 * A mod's toggle, with the dependency engine behind it: enabling pulls in whatever the mod
 * requires, disabling cascades to whatever requires the mod. Lifted unchanged from the card
 * era — the only edit is that it hangs its notices on the row instead of the card.
 */
function _modToggle(mod, row, marketplaceOverlay) {
  const toggle = document.createElement('label');
  toggle.className = 'mod-card-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = enabledMods.has(mod.id);
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
        _showDepNotice(row, req.error, 'error');
        return;
      }
      if (req.missing.length > 0) {
        checkbox.checked = false;
        _showDepNotice(row, `Missing: ${req.missing.join(', ')}`, 'error');
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
        _showDepNotice(row, `Also enabled: ${alsoEnabled.join(', ')}`, 'info');
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
          if (activeView?.id === depId) _hideMod();
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
        if (activeView?.id === mod.id) {
          _hideMod();
        }
      }
      if (alsoDisabled.length > 0) {
        _showDepNotice(row, `Also disabled: ${alsoDisabled.join(', ')}`, 'info');
        _refreshCardToggles(marketplaceOverlay);
      }
    }
    _saveEnabledMods();
  });

  return toggle;
}

/**
 * One row in the Mods modal (#673) — the shared shell for a mod and for a skill.
 *
 * The row is ~32px: name, the badges that change a decision, a one-line description, and the
 * controls. Everything else — the full description, the version, dependencies, the MCP tools
 * it registers, a skill's usage line, a catalog mod's Install button — lives in a detail body
 * that is built on first expand and never before. That is the whole browsability argument:
 * the old card put all of it on every one of 32 entries, so four fitted on screen.
 *
 * `data-mod-id` lives on the ROW, not the line, so the detail can sit below the line while
 * the row stays the single addressable unit for _refreshCardToggles, the cross-tab `storage`
 * listener and handleSkillsChanged — all three reach a row through MOD_ROW_SELECTOR.
 */
function _createModRow(mod, marketplaceOverlay, { expandedIds, mcpReady = true } = {}) {
  const isSkill = mod.type === 'skill';
  const isInstalled = !isSkill && allMods.some(m => m.id === mod.id);
  const hasSettings = !isSkill && mod.settings && mod.settings.length > 0;

  const row = document.createElement('div');
  row.className = 'mod-row' + (mod.compatible === false ? ' mod-row-incompatible' : '');
  row.dataset.modId = mod.id;

  const line = document.createElement('div');
  line.className = 'mod-row-line';
  line.tabIndex = 0;
  line.setAttribute('role', 'button');
  line.setAttribute('aria-expanded', 'false');

  // Without a caret nothing says a row opens — and a catalog row has no toggle and no gear,
  // so it would otherwise be completely inert with its Install button unreachable.
  const caret = document.createElement('span');
  caret.className = 'mod-row-caret';
  caret.textContent = '›';

  const name = document.createElement('span');
  name.className = 'mod-row-name';
  // textContent, not innerHTML. `mod.name` comes from a mod.json inside a tarball fetched by
  // POST /api/mods/install — a manifest we do not write, rendered in a same-origin page.
  name.textContent = isSkill ? (mod.slashCommand || mod.name) : (mod.name || mod.id);

  // Only badges you can act on while scanning. `Built-in`/`Official`/`Skill` and the version
  // moved into the detail: the group heading already says what kind of thing this is, and a
  // version number on all 32 rows is noise.
  const badges = document.createElement('span');
  badges.className = 'mod-row-badges';
  if (mod.experimental) badges.appendChild(_badge('experimental', 'Experimental'));
  if (mod.updateAvailable) badges.appendChild(_badge('official', 'Update'));
  if (mod.kind === 'available') badges.appendChild(_badge('built-in', 'Not installed'));
  if (mod.compatible === false) {
    // The reason is also spelled out in the detail; on a 32px row the signal has to be here,
    // and it is a word rather than a colour because some themes collapse the hues.
    const warn = _badge('incompatible', 'Incompatible');
    warn.title = `Requires deepsteve v${mod.minDeepsteveVersion}+`;
    badges.appendChild(warn);
  }

  const desc = document.createElement('span');
  desc.className = 'mod-row-desc';
  desc.textContent = mod.description || '';

  const actions = document.createElement('div');
  actions.className = 'mod-row-actions';

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

  // A catalog-only mod has nothing to turn on yet, so it gets no toggle — which also keeps
  // _checkRequirements from ever being asked about a mod that is not in allMods.
  if (isSkill) actions.appendChild(_skillToggle(mod, row));
  else if (isInstalled) actions.appendChild(_modToggle(mod, row, marketplaceOverlay));

  const toggleDetail = () => {
    const open = !row.classList.contains('expanded');
    if (open && !row._detail) {
      row._detail = isSkill
        ? _buildSkillDetail(mod, row)
        : _buildModDetail(mod, row, marketplaceOverlay, mcpReady);
      row.appendChild(row._detail);
    }
    row.classList.toggle('expanded', open);
    line.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (expandedIds) open ? expandedIds.add(mod.id) : expandedIds.delete(mod.id);
  };

  line.addEventListener('click', (e) => {
    // The gear, the toggle and the View button keep their own jobs. The gear already stops
    // propagation; this is what covers the <label>-wrapped checkbox, which fires `click` on
    // the label itself.
    if (e.target?.closest?.('.mod-row-actions')) return;
    toggleDetail();
  });
  line.addEventListener('keydown', (e) => {
    // Only when the LINE itself has focus. The gear and the checkbox are inside it, so
    // without this their keydown bubbles here and preventDefault() cancels the very
    // activation the key was pressed for: Enter on the gear would expand the row instead of
    // opening the settings modal, and Space on the toggle would expand instead of toggling.
    if (e.target !== line) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDetail(); }
  });

  line.append(caret, name, badges, desc, actions);
  row.appendChild(line);

  // Re-open a row the last render had open. Without this, typing one more character into
  // the search box collapses whatever you had just expanded.
  if (expandedIds?.has(mod.id)) toggleDetail();

  return row;
}

/** The expanded body of a mod row. */
function _buildModDetail(mod, row, marketplaceOverlay, mcpReady) {
  const detail = document.createElement('div');
  detail.className = 'mod-row-detail';
  const isInstalled = allMods.some(m => m.id === mod.id);
  const isBuiltIn = mod.source === 'built-in';

  // Description — only when the row's one line could not hold it.
  if (mod.description && _descWasClipped(row)) {
    const desc = document.createElement('div');
    desc.className = 'mod-card-description';
    desc.textContent = mod.description;
    detail.appendChild(desc);
  }

  // What it is and which version — off the line, where it does not cost 32 rows of noise.
  const meta = document.createElement('div');
  meta.className = 'mod-row-meta';
  meta.appendChild(_badge(isBuiltIn ? 'built-in' : 'official', isBuiltIn ? 'Built-in' : 'Official'));
  const version = document.createElement('span');
  version.className = 'mod-card-version';
  version.textContent = `v${mod.version || '?'}`;
  meta.appendChild(version);
  detail.appendChild(meta);

  // The MCP tools this mod registers. GET /api/mods has derived them since #644 and nothing
  // rendered them until now. `mcpReady` is the difference between "registers no tools" and
  // "nothing has been scanned yet" — without it the row would lie for the first seconds
  // after a restart.
  const tools = document.createElement('div');
  tools.className = 'mod-tools';
  if (mod.tools?.length) {
    const lead = document.createElement('span');
    lead.className = 'mod-tools-note';
    lead.textContent = 'Tools:';
    tools.appendChild(lead);
    for (const tool of mod.tools) {
      const tag = document.createElement('span');
      tag.className = 'mod-tool-tag';
      tag.textContent = tool.name;
      if (tool.description) tag.title = tool.description;
      tools.appendChild(tag);
    }
    detail.appendChild(tools);
  } else if (isInstalled && !mcpReady) {
    // Nothing to list AND nothing scanned: say which one it is rather than implying the mod
    // registers nothing. A mod that genuinely has no tools.js simply shows no line at all,
    // and neither does one that is not installed — there is nothing here to have scanned.
    const note = document.createElement('span');
    note.className = 'mod-tools-note';
    note.textContent = 'Tools not scanned yet';
    tools.appendChild(note);
    detail.appendChild(tools);
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
    detail.appendChild(depsRow);
  }

  // Incompatible warning
  if (mod.compatible === false) {
    const warn = document.createElement('div');
    warn.className = 'mod-card-description';
    warn.style.color = 'var(--ds-accent-red)';
    warn.textContent = `Requires deepsteve v${mod.minDeepsteveVersion}+`;
    detail.appendChild(warn);
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
              if (activeView?.id === depId) _hideMod();
            }
          }
          enabledMods.delete(mod.id);
          if (mod.display === 'panel') {
            _unloadPanelMod(mod.id);
          } else {
            _removeToolbarButton(mod.id);
            if (activeView?.id === mod.id) _hideMod();
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
      detail.appendChild(footer);
    }
  }

  return detail;
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

  _focusIframe(panelMods.get(modId)?.iframe);

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
  iframeEl.setAttribute('sandbox', MOD_SANDBOX);
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
    // #terminals deliberately gets NO inline display here. It is a plain div —
    // already `block` — so this only ever re-stated the default, but an inline
    // declaration outranks any stylesheet rule, and it silently beat
    // `#terminals.overview-mode { display: grid }`. With a panel open, overview
    // mode then laid its tiles out as full-width stacked blocks instead of a
    // grid (#590).
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
  // Clear the inline display _showPanel used to set, so a tab that opened a panel
  // before this build isn't stuck with it (see the note there).
  document.getElementById('terminals').style.display = '';

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
  scheduledTaskCallbacks = scheduledTaskCallbacks.filter(e => e.modId !== modId);
  agentChatCallbacks = agentChatCallbacks.filter(e => e.modId !== modId);
  browserEvalCallbacks = browserEvalCallbacks.filter(e => e.modId !== modId);
  browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e.modId !== modId);
  screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e.modId !== modId);
  sceneUpdateCallbacks = sceneUpdateCallbacks.filter(e => e.modId !== modId);
  sceneQueryCallbacks = sceneQueryCallbacks.filter(e => e.modId !== modId);
  sceneSnapshotCallbacks = sceneSnapshotCallbacks.filter(e => e.modId !== modId);
  babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e.modId !== modId);
  wsReconnectedCallbacks = wsReconnectedCallbacks.filter(e => e.modId !== modId);
  settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);
  userActivityCallbacks = userActivityCallbacks.filter(e => e.modId !== modId);
  contextCallbacks = contextCallbacks.filter(e => e.modId !== modId);
  activeContextCallbacks = activeContextCallbacks.filter(e => e.modId !== modId);

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

// ─── Apps (#661) ───────────────────────────────────────────────────────────────────────────
//
// An App is a mod with `"app": true` — a place you work FROM rather than a tool you visit.
// The flag is purely additive: validate-mods.js has no field allowlist and GET /api/mods
// spreads the whole manifest, so it reaches the client with no server change, and a mod
// without it behaves exactly as it does today.

/** The enabled apps, in manifest order. `type` excludes the skill pseudo-mods /api/mods appends. */
function getApps() {
  return allMods.filter(m => m.app === true && m.type !== 'skill'
    && m.entry && m.compatible !== false && enabledMods.has(m.id));
}

/** Open (or toggle) an app by id — the command palette's entry point. */
function openApp(id) {
  const mod = getApps().find(m => m.id === id);
  if (mod) _toggleModView(mod)();
}

/**
 * Draw the Apps section into the projects rail, above `Projects`. Mirrors project-mods.js's
 * appendRailRows() — including the "no rows, no empty wrapper" early return, which is also
 * what keeps this invisible to every existing rail test.
 *
 * The classes are context-views' own on purpose: .context-rail-header collapses for free in
 * the 48px icon rail, and .context-row brings the hover / active / collapsed-square rules with
 * it. Only the LIST gets a name of its own (.app-list, not .context-list) so a rail with apps
 * in it cannot shift what `railChildren(rail, 'context-list')[0]` means.
 */
function appendAppRows(rail) {
  const apps = getApps();
  if (!rail || !apps.length) return;

  const header = document.createElement('div');
  header.className = 'context-rail-header';
  header.textContent = 'Apps';
  rail.appendChild(header);

  const list = document.createElement('div');
  list.className = 'app-list';
  for (const mod of apps) {
    const label = mod.toolbar?.label || mod.name;
    const row = document.createElement('div');
    // .has-icon is what reveals .context-row-icon, which is the only thing left of a row once
    // the rail is collapsed to squares.
    row.className = 'context-row app-row has-icon' + (activeView?.id === mod.id ? ' active' : '');
    row.dataset.appId = mod.id;
    row.title = mod.description || label;

    const { glyph, isEmoji } = tabIcon(label);
    const iconEl = document.createElement('span');
    iconEl.className = 'context-row-icon' + (isEmoji ? ' is-emoji' : '');
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = glyph;
    row.appendChild(iconEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'context-row-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    row.onclick = _toggleModView(mod);
    appRows.set(mod.id, row);
    list.appendChild(row);
  }
  rail.appendChild(list);
}

/**
 * Which app owns the slot. A sweep over the rows we kept, not a re-render — the same
 * "derive it on every flip, never bookkeep it" shape as showView()'s toolbar sweep and
 * project-mods.js's paintRailRows(), and deliberately not a call back into context-views:
 * asking it to re-render the whole filter from inside a view change is a re-entrancy waiting
 * to happen (applyFilter can snap-switch a tab, which would background the view just opened).
 */
function _paintAppRows() {
  for (const [modId, row] of appRows) row.classList.toggle('active', activeView?.id === modId);
}

// ─── Quiet mode (#662) ──────────────────────────────────────────────────────────────
//
// Sitting in an app all day should not feel like sitting inside a frame of other software, so
// quiet mode takes the host's chrome away and leaves the app alone on screen.
//
// It has to live here rather than in the app: an iframe cannot hide the tab strip that contains
// it. And it is built once, against the slot, so EVERY app gets it — not just the one that
// asked. Two things actually come down, not four: #tabs (which is the strip, the toolbar and
// the ← button all at once) and the projects rail. The panels are already gone by then, because
// they live in #content-row and showModView() sets that to display:none.
//
// The toggle must survive that — it is the only way back out — which is why it hangs off
// #mod-container and not off #tabs beside the ← button it otherwise belongs next to.

/** Is this view id one of the enabled apps? */
const _isApp = (id) => !!id && getApps().some(m => m.id === id);

function _loadQuiet() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUIET_KEY));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}
let quietApps = _loadQuiet();

/**
 * Is the chrome down RIGHT NOW? Derived on every read, never mirrored into a variable — the
 * same shape as _setModViewVisible() and _paintBackBtn(). The `modViewVisible` term is what
 * makes excursions free: while you are out the slot is down and so is quiet mode, so the strip
 * and the rail — and with them the Apps row that is your way home — are on screen; coming home
 * re-derives it as true, with nothing persisted, suspended or restored in between.
 */
function isQuietMode() {
  return !!(modViewVisible && activeView && quietApps.has(activeView.id) && _isApp(activeView.id));
}

/** Is there an app on screen for quiet mode to apply to? Drives the ⌘\ entry's isEnabled. */
function isQuietAvailable() {
  return !!(modViewVisible && activeView && _isApp(activeView.id));
}

/**
 * Re-assert the chrome from the state. Idempotent, and called from every flip of either input
 * — the slot going up or down, and the preference changing.
 */
function _applyQuietChrome() {
  const on = isQuietMode();
  // The class is on #app-container, matching layout-manager.js's .vertical-layout / .icon-rail.
  // It reaches #tabs because #tabs is the one piece of chrome whose display is not written
  // inline by JS; the rail's is, so the rail goes through its owner below instead.
  document.getElementById('app-container')?.classList.toggle('quiet-mode', on);
  // mod-manager never imports context-views — the same one-way rule project-mods.js follows —
  // so the rail half goes out through app.js.
  hooks?.onQuietChanged?.(on);
  _paintQuietBtn();
}

/**
 * The one writer. Persists first, then re-derives — so a caller can never leave localStorage
 * and the screen disagreeing.
 */
function setQuietMode(on) {
  if (!activeView) return;
  if (on) quietApps.add(activeView.id);
  else quietApps.delete(activeView.id);
  try { localStorage.setItem(QUIET_KEY, JSON.stringify([...quietApps])); } catch { /* private mode */ }
  _applyQuietChrome();
}

/**
 * The toggle, in a gutter down the left of the slot. It renders in the TOP document for the
 * same reason the back button does (#633): a mod iframe receives no theme variables, so
 * anything built inside one is stuck on hardcoded fallback colours.
 *
 * One button, two states — glyph, title, .active and the gutter are all set here, in one place,
 * so they cannot drift from each other. It is deliberately NOT hidden while quiet mode is on: with the
 * strip gone it is the only way back, and ⌘\ does not reach a host listener while the app's
 * iframe has focus.
 */
function _paintQuietBtn() {
  if (!quietBtn) return;
  const shown = isQuietAvailable();
  quietBtn.style.display = shown ? '' : 'none';
  // The gutter is the button's, so it comes and goes with it — a 30px inset on a slot with no
  // toggle in it would be a margin nobody asked for. It is a class rather than an inline style
  // so the width lives in the stylesheet next to the button it is sized for.
  modContainer?.classList.toggle('has-quiet-btn', shown);
  if (!shown) { quietBtn.classList.remove('active'); return; }
  const on = isQuietMode();
  quietBtn.classList.toggle('active', on);
  quietBtn.textContent = on ? '⤡' : '⤢';
  quietBtn.title = on ? 'Leave quiet mode (⌘\\)' : 'Quiet mode — hide everything but the app (⌘\\)';
  quietBtn.setAttribute('aria-label', quietBtn.title);
  quietBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/**
 * Create a toolbar button for an enabled mod (left side, near wand).
 *
 * An App never gets one (#662). It is a place, not a tool, and the Apps rail section plus the
 * command-palette entry are how you reach a place — a third launcher in the strip is chrome
 * that says nothing new. `"app": true` IMPLIES this rather than a second manifest field, so
 * one flag keeps meaning one thing and every future app inherits the decision.
 */
function _createToolbarButton(mod) {
  if (toolbarButtons.has(mod.id)) return;
  if (mod.app === true) return;

  const label = mod.toolbar?.label || mod.name;
  const btn = document.createElement('button');
  // .nav-btn gives these the same [icon][label] shape as the rest of #tabs' chrome, which is the
  // whole reason the collapsed rail needs no rule of its own for them: it drops .btn-label and the
  // icon is what's left. Before #552 these had no rail treatment at all and crammed a full mod name
  // into 36px. Hiding them instead would be #550's unreachable-⚙ in a different hat.
  btn.className = 'mod-toolbar-btn nav-btn';
  btn.title = mod.description || label;
  btn.setAttribute('aria-label', label);
  btn.dataset.modId = mod.id;

  // A mod's icon is derived, not authored — tabIcon() is the same derivation the tab rail uses
  // (leading emoji if there is one, else a monogram), so `⏰ Scheduled Tasks` shows its clock and
  // `Tasks` shows a T. It returns a character rather than the inline SVG the rest of the chrome
  // carries, hence .is-text.
  const { glyph, isEmoji } = tabIcon(label);
  const iconEl = document.createElement('span');
  iconEl.className = `btn-icon is-text${isEmoji ? ' is-emoji' : ''}`;
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = glyph;
  const labelEl = document.createElement('span');
  labelEl.className = 'btn-label';
  labelEl.textContent = label;
  btn.append(iconEl, labelEl);

  btn.addEventListener('click', _toggleModView(mod));

  // Insert at top of #tabs, right after the layout toggle button
  const tabs = document.getElementById('tabs');
  const layoutToggle = document.getElementById('layout-toggle');
  tabs.insertBefore(btn, layoutToggle.nextSibling);

  // If this mod is currently the active view, mark it
  if (activeView?.id === mod.id) {
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
 * Put any page in the fullscreen view slot (#628). There is exactly ONE slot: showing a
 * second view replaces the first, destroying its iframe and dropping its bridge callbacks.
 *
 *   id             unique; namespaced for non-mod views so it can't collide with a mod id
 *   name           back-button label ("← <name>")
 *   src            iframe src
 *   sandbox        sandbox attribute (default MOD_SANDBOX)
 *   allow          optional allow attribute
 *   persist        false = don't remember this view across a page reload
 *   dismissOnLeave true = leaving for a tab tears the view down instead of backgrounding it
 *                  behind a ← button (a project-mod view: its launcher is already on screen,
 *                  so a back button would be a second strip item for one mod)
 */
function showView(view) {
  if (!view?.id || !view.src) return;

  // A different occupant: tear its iframe down AND drop the callbacks it registered, which
  // are keyed by the id its bridge was injected under. Sweeping them was missing before
  // #628, so switching straight from one view to another leaked them against a dead iframe.
  if (activeView && activeView.id !== view.id) {
    // A different page took the slot — another app's rail row, a project mod — so the app that
    // lent you out is gone and its trail with it (#661).
    _abandonExcursion(activeView.id);
    _forgetViewCallbacks(activeView.id);
    _destroyIframe();
  }

  activeView = view;
  // Removing rather than leaving it is the point: a non-persisting view must not let the
  // PREVIOUS occupant's id survive to be restored on the next reload.
  if (view.persist === false) localStorage.removeItem(ACTIVE_VIEW_KEY);
  else localStorage.setItem(ACTIVE_VIEW_KEY, view.id);

  // Update toolbar button states (a non-mod view matches none of them, which is correct —
  // it took the slot from whichever mod had it).
  for (const [id, btn] of toolbarButtons) {
    btn.classList.toggle('active', id === view.id);
  }
  _paintAppRows();

  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.src = view.src;
    iframe.setAttribute('sandbox', view.sandbox || MOD_SANDBOX);
    if (view.allow) iframe.setAttribute('allow', view.allow);
    modContainer.appendChild(iframe);
    iframe.addEventListener('load', () => {
      _injectBridgeAPI(iframe, view.id, view.bridgeTabId || null);
    });
  }

  showModView();
  hooks?.onViewChanged?.();
}

/** Dismiss the view slot, but only if `id` is what's in it — a stale call is a no-op. */
function hideView(id) {
  if (activeView && activeView.id === id) _hideMod();
}

/** The view slot's occupant id, or null. */
function getActiveViewId() {
  return activeView?.id ?? null;
}

/**
 * Whether the slot is on screen — and, inseparably, whether any tab may read as selected (#639).
 *
 * A tab is styled selected because its terminal is what you are looking at. While the slot is up
 * none of them is, so the strip must show nothing selected; when the slot comes down the active
 * session's tab is again what's on screen. Before this, entering the slot left the outgoing tab
 * marked and the selected styling simply lied about which view was live.
 *
 * Every write to `modViewVisible` goes through here, which is what makes the two unable to drift —
 * the same "derive it on every flip, never bookkeep it" shape as showView()'s toolbar sweep and
 * project-mods.js's paintRailRows(). It is the ONLY selection state the slot touches: `activeId`
 * and `.terminal-container.active` stay exactly as they were, which is what keeps "back to where
 * you were" free.
 */
function _setModViewVisible(on) {
  modViewVisible = on;
  TabManager.setActive(on ? null : (getActiveSessionIdFn?.() ?? null));
}

/**
 * The launcher toggle, shared by the toolbar button and the Apps rail row so the two can't
 * drift. Three-way on purpose, matching project-mods.js's openMod(): a click on a
 * BACKGROUNDED view raises it rather than dismissing it. Before #661 this was two-way, so
 * pressing the toolbar button while out on an excursion destroyed the iframe and threw away
 * the state you were about to come back to.
 */
function _toggleModView(mod) {
  return () => {
    if (activeView?.id !== mod.id) _showMod(mod);
    else if (modViewVisible) _hideMod();
    // Raising the app IS coming home, so the trail is spent — otherwise ⌘← would still be
    // armed while you are already looking at the thing it returns to.
    else if (isExcursionActive()) endExcursion();
    else showModView();
  };
}

/**
 * Show a DeepSteve Mod's iframe view — the original caller of the slot. The two early
 * returns are mod-manifest concepts and deliberately stay here rather than in showView().
 */
function _showMod(mod) {
  // Tools-only mods have no entry point — nothing to show
  if (!mod.entry) return;

  const display = mod.display || 'fullscreen';

  // Panel mods are handled by panel tabs, not fullscreen view
  if (display === 'panel') {
    return;
  }

  showView({
    id: mod.id,
    name: mod.name,
    src: `/mods/${mod.id}/${mod.entry || 'index.html'}`,
    allow: mod.permissions?.length ? mod.permissions.join('; ') : null,
  });
}

/** Drop every bridge callback registered by the page that occupied the slot under `id`. */
function _forgetViewCallbacks(id) {
  if (!id) return;
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== id);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== id);
  userActivityCallbacks = userActivityCallbacks.filter(e => e.modId !== id);
  settingsCallbacks = settingsCallbacks.filter(e => e.modId !== id);
  excursionChangedCallbacks = excursionChangedCallbacks.filter(e => e.modId !== id);
  // Not merely a leak: a cycle handler left pointing at a destroyed iframe realm would keep
  // requestExcursionCycle() reporting "handled", so ⌘↑/⌘↓ would stop falling back to cycling
  // projects and would simply do nothing, forever.
  if (excursionCycleHandler?.viewId === id) excursionCycleHandler = null;
}

/**
 * Hide the active view, return to terminals.
 */
function _hideMod() {
  const hiddenModId = activeView?.id ?? null;
  // The slot's only destroyer, so this one line is every "the app went away" path at once:
  // the toolbar button toggling it off, the mod being disabled in another browser tab, a
  // dependency uninstall, and hideView(). There is nothing left to go back to.
  _abandonExcursion(hiddenModId);
  activeView = null;
  localStorage.removeItem(ACTIVE_VIEW_KEY);
  _forgetViewCallbacks(hiddenModId);

  _destroyIframe();

  // Clear toolbar button states
  for (const [, btn] of toolbarButtons) {
    btn.classList.remove('active');
  }
  _paintAppRows();

  // Show content row, hide mod container and back button
  document.getElementById('content-row').style.display = '';
  modContainer.style.display = 'none';
  backBtn.style.display = 'none';
  _setModViewVisible(false);
  // The app is gone, so the chrome comes back. The PREFERENCE is untouched: quiet mode is
  // remembered per app, and opening this one again should land you where you left off.
  _applyQuietChrome();

  // Restore panel if it was logically visible while fullscreen mod was active
  if (visiblePanelId) {
    _showPanel();
  }

  hooks?.onViewChanged?.();
}

/**
 * Focus a mod iframe so keyboard events (paste, shortcuts) land inside it
 * without requiring a click first.
 */
function _focusIframe(iframeEl) {
  if (!iframeEl) return;
  const focus = () => { try { iframeEl.contentWindow?.focus(); } catch {} };
  focus();
  iframeEl.addEventListener('load', focus, { once: true });
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
  if (!activeView) return;
  document.getElementById('content-row').style.display = 'none';
  modContainer.style.display = 'flex';
  backBtn.style.display = 'none';
  backBtn.classList.remove('excursion');
  _setModViewVisible(true);
  // AFTER _setModViewVisible: isQuietMode() reads modViewVisible, so asserting the chrome
  // before the flip would compute it against the state we just left. This is also the reload
  // path — the restore inside loadAvailableMods() ends here — so quiet mode comes back with
  // the page for free.
  _applyQuietChrome();
  _focusIframe(iframe);
  // An app that spent the excursion in a display:none iframe has laid nothing out — its
  // selected row cannot have been scrolled into view. Tell it it is on screen again.
  if (excursionChangedCallbacks.length) _notifyExcursion();
}

// ─── Excursions (#661) ─────────────────────────────────────────────────────────────────────
//
// The stack is what turns the ONE-HOP back button into a trail you can walk:
//
//   visitSession() from the app              push        → depth 1
//   ⌘↑/⌘↓ queue walk (opts.replace)          replace top → still depth 1
//   the user clicking another tab while out  push        → depth 2
//   ⌘← / the back button                     pop
//
// The replace rule is load-bearing. Without it, walking a 20-item inbox builds a 20-deep
// stack and "back" costs 20 presses.

function _loadExcursion() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(EXCURSION_KEY));
    // A shape check, not a schema: a half-written or hand-edited value must read as "no
    // excursion" rather than wedge every keystroke that consults the stack.
    if (!raw?.appId || !Array.isArray(raw.stack)) return null;
    const stack = raw.stack.filter(f => f && f.sessionId);
    if (!stack.length) return null;
    return { appId: raw.appId, chrome: raw.chrome || {}, stack };
  } catch { return null; }
}

function _saveExcursion() {
  try {
    if (excursion?.stack?.length) sessionStorage.setItem(EXCURSION_KEY, JSON.stringify(excursion));
    else sessionStorage.removeItem(EXCURSION_KEY);
  } catch {}
}

/**
 * The one writer. Persists, repaints, tells the app and tells the host — the same
 * "derive it on every flip, never bookkeep it" shape as _setModViewVisible().
 */
function _excursionChanged() {
  _saveExcursion();
  _paintBackBtn();
  hooks?.onExcursionChanged?.(getExcursion());
  _notifyExcursion();
}

function _notifyExcursion() {
  const state = getExcursion();
  for (const entry of excursionChangedCallbacks) {
    try { entry.cb(state); } catch (e) { console.error('Excursion callback error:', e); }
  }
}

/** True while the host is lent out. context-views reads this for its ⌘↑/⌘↓ takeover. */
function isExcursionActive() {
  return !!(excursion && excursion.stack.length);
}

function getExcursion() {
  if (!isExcursionActive()) return { appId: null, depth: 0, stack: [], chrome: {} };
  return {
    appId: excursion.appId,
    depth: excursion.stack.length,
    stack: excursion.stack.map(f => ({ ...f })),
    chrome: { ...excursion.chrome },
  };
}

/** End it and come home. A no-op when there is no excursion. */
function endExcursion({ goHome = true } = {}) {
  if (!excursion) return;
  excursion = null;
  _excursionChanged();
  if (goHome && activeView) showModView();
}

/**
 * Drop the stack WITHOUT going home — for the paths where the app itself went away (its view
 * was destroyed, or a different page took the slot), so there is nothing left to return to.
 * `viewId` guards it: another view's teardown must not end this view's excursion.
 */
function _abandonExcursion(viewId = null) {
  if (!excursion) return;
  if (viewId && excursion.appId !== viewId) return;
  excursion = null;
  _excursionChanged();
}

/**
 * An app lends you out. Everything after the bookkeeping is the EXISTING one-hop path, which
 * is the point: coming home is just showModView() again, and the stack only decides which
 * session a pop lands on.
 */
function visitSession(id, opts = {}) {
  if (!id || !activeView) return;
  const frame = { sessionId: id, label: opts.label || null, reason: opts.reason || null, at: Date.now() };

  if (!excursion || excursion.appId !== activeView.id) {
    // Defaults per the issue: the app sent you, so you are not browsing projects, and the
    // strip is filtered to where you landed. `tabs: 'project'` costs nothing to honour —
    // hooks.focusSession is app.js's focusTab, which already reveals the session's project.
    excursion = {
      appId: activeView.id,
      chrome: { rail: 'hide', tabs: 'project', ...(opts.chrome || {}) },
      stack: [frame],
    };
  } else if (opts.replace) {
    excursion.stack[excursion.stack.length - 1] = frame;
  } else {
    excursion.stack.push(frame);
    if (excursion.stack.length > MAX_EXCURSION_DEPTH) excursion.stack.shift();
  }

  _excursionChanged();
  // showTerminalForSession → hooks.focusSession is a user-jump path, and user jumps push.
  // Without this guard every replace would immediately push on top of itself.
  suppressExcursionPush = true;
  try { showTerminalForSession(id); } finally { suppressExcursionPush = false; }
}

/**
 * A frame for everything the app did NOT initiate — a tab click, a tab arrow, the palette.
 * Called only from app.js's user-jump wrappers. The mechanical activations (the context
 * filter's snap-back, the close-tab fallback, session restore) stay on bare switchTo() and
 * push nothing, because none of them is you asking to go somewhere.
 */
function noteExcursionDrill(id) {
  if (suppressExcursionPush || !id || !isExcursionActive()) return;
  if (excursion.stack[excursion.stack.length - 1].sessionId === id) return;  // already there
  excursion.stack.push({ sessionId: id, label: null, reason: 'drill', at: Date.now() });
  if (excursion.stack.length > MAX_EXCURSION_DEPTH) excursion.stack.shift();
  _excursionChanged();
}

/**
 * Back: one frame. Validated on the way out rather than pruned eagerly — one loop covers a
 * killed session, a closed tab, a tab sent to another window and a restore that rejected a
 * duplicate, without any of those paths having to know the stack exists.
 */
function popExcursion() {
  if (!isExcursionActive()) return false;
  const live = hooks?.hasSession;
  while (excursion.stack.length) {
    excursion.stack.pop();
    const next = excursion.stack[excursion.stack.length - 1];
    if (!next) break;
    if (live && !live(next.sessionId)) continue;   // that one is gone; keep unwinding
    _excursionChanged();
    suppressExcursionPush = true;
    try { hooks?.focusSession?.(next.sessionId); } finally { suppressExcursionPush = false; }
    return true;
  }
  endExcursion();
  return true;
}

/**
 * ⌘↑/⌘↓ while out. The APP owns the queue — it is the only thing that knows what resolved
 * since you left — so the host asks rather than walking a snapshot it took on the way in.
 * Returns false when nobody is listening, which is what lets context-views fall back to
 * cycling projects instead of leaving the key dead.
 */
function requestExcursionCycle(delta) {
  if (!isExcursionActive() || !excursionCycleHandler) return false;
  if (excursionCycleHandler.viewId !== excursion.appId) return false;
  try {
    excursionCycleHandler.cb({ delta });
  } catch (e) {
    console.error('Excursion cycle handler error:', e);
    return false;
  }
  return true;
}

/**
 * The back button, doubling as the excursion bar. It renders in the TOP document, which is the
 * whole reason it lives here and not in the app's page: a mod iframe receives no theme
 * variables, so anything built inside one is stuck on hardcoded fallback colours (#633).
 */
function _paintBackBtn() {
  if (!backBtn || !activeView) return;
  // An App is never chrome in the strip — the other half of #662's rule. That issue dropped an
  // app's launcher button on the grounds that the Apps rail row is how you reach a place; this
  // button is the same launcher pointing the other way, so it goes for the same reason, and
  // `"app": true` keeps meaning one thing rather than gaining an exception. The row stays
  // `.active` the whole time you are away and its three-way toggle raises a backgrounded view
  // or ends an excursion, ⌘← is the keyboard route while the ⌘P rail is closed, and the trail
  // this used to carry is the strip's own selected tab. Non-app mods keep theirs: they have no
  // rail row to be the way back.
  //
  // This is the ONE place that decides whether there is a ← right now — _backgroundView()
  // unhides first and then calls here, so the suppression cannot be routed around.
  if (_isApp(activeView.id)) { backBtn.style.display = 'none'; return; }
  if (!isExcursionActive()) {
    backBtn.classList.remove('excursion');
    backBtn.textContent = `← ${activeView.name || 'Back'}`;
    backBtn.title = `Back to ${activeView.name || 'the view'}`;
    return;
  }
  const top = excursion.stack[excursion.stack.length - 1];
  const crumb = hooks?.getBreadcrumb?.(top.sessionId) || {};
  const trail = [crumb.project, crumb.tab || top.label].filter(Boolean).join(' / ');
  const depth = excursion.stack.length;
  backBtn.classList.add('excursion');
  backBtn.textContent = trail ? `← ${activeView.name} · ${trail}` : `← ${activeView.name}`;
  backBtn.title = depth > 1 ? `⌘← back (${depth} deep)` : `⌘← back to ${activeView.name}`;
}

/**
 * Reconcile the slot with the stack. Idempotent, and called from everything that could have
 * changed either — because on reload the view restore (inside the async loadAvailableMods)
 * and the session restore race, and neither may be assumed to win.
 */
function syncExcursion() {
  if (!isExcursionActive()) return;
  // Re-assert the chrome even when nothing changed. On a reload the stack comes back without
  // ever passing through _excursionChanged(), so the host has never been told to hide the rail
  // — and the one state where that matters is exactly the one nobody would think to test.
  hooks?.onExcursionChanged?.(getExcursion());
  // ACTIVE_VIEW_KEY is localStorage and therefore shared by every window at this recursion
  // depth, so another window opening Tower can leave us holding a stack for a view we do not
  // have. This check is also what keeps an excursion from leaking into a second window.
  if (!activeView || activeView.id !== excursion.appId) { _abandonExcursion(); return; }
  if (!modViewVisible) { _paintBackBtn(); return; }
  const top = excursion.stack[excursion.stack.length - 1];
  if (hooks?.hasSession && !hooks.hasSession(top.sessionId)) return;  // its tab isn't up yet
  _backgroundView();
  suppressExcursionPush = true;
  try { hooks?.focusSession?.(top.sessionId); } finally { suppressExcursionPush = false; }
}

/**
 * Leave the view for a terminal session. A DeepSteve Mod view is only BACKGROUNDED \u2014 it
 * stays loaded and a \u2190 button returns to it.
 */
function showTerminalForSession(id) {
  // A view that opted out of backgrounding leaves nothing behind in the tab strip (#628):
  // its launcher is on screen by definition, so a \u2190 button would be a second strip item for
  // one mod \u2014 exactly the duplicate the view mode exists to remove.
  if (activeView?.dismissOnLeave) {
    _hideMod();
    hooks.focusSession(id);
    return;
  }

  _backgroundView();
  hooks.focusSession(id);
}

/**
 * Put the slot down and paint the back button, WITHOUT selecting a session.
 *
 * Split out of showTerminalForSession() for the reload path (#661), which has to land
 * backgrounded before any session exists: calling hooks.focusSession() there would set
 * activeId/ActiveTab for a tab that has not been created yet, and restoreSessions()' own
 * focusTab() would overwrite it a moment later anyway.
 */
function _backgroundView() {
  modContainer.style.display = 'none';
  document.getElementById('content-row').style.display = '';
  // Re-selects the OUTGOING tab for the moment it takes the caller to select the incoming one.
  // Deliberate: the rule is "the slot is down, so a tab is on screen again", and letting this
  // path skip it is exactly how the two would drift apart.
  _setModViewVisible(false);
  // Quiet mode is about what you see WHILE IN the app; excursion chrome is about what you see
  // while out. Same slot, different states — so going out lifts quiet mode and coming home
  // (showModView) puts it back, with nothing saved or restored in between because
  // isQuietMode() is derived from modViewVisible. This is also what puts the way home back on
  // screen: an App has no ← in the strip, so that way home is its rail row — and the rail is
  // one of the two things quiet mode takes down.
  _applyQuietChrome();

  // Restore panel if it was logically visible
  if (visiblePanelId) {
    _showPanel();
  }

  if (activeView) {
    backBtn.style.display = '';
    _paintBackBtn();          // — which hides it again for an App
  }
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
  // The retry half of the reload reconciler (#661): on a fresh page the restored excursion
  // names a session whose tab does not exist yet, so syncExcursion() no-ops until it does.
  syncExcursion();
}

/**
 * Notify mods that the user typed into a terminal (called from app.js onUserInput).
 * Used by the action-required mod to block auto-cycle while the user is interacting.
 */
function notifyUserActivity(sessionId) {
  for (const entry of userActivityCallbacks) {
    try { entry.cb(sessionId); } catch (e) { console.error('User activity callback error:', e); }
  }
}

function notifyTasksChanged(tasks) {
  for (const entry of taskCallbacks) {
    try { entry.cb(tasks); } catch (e) { console.error('Task callback error:', e); }
  }
}

/**
 * Notify panel mods that scheduled tasks changed (called from app.js on the
 * `scheduled-tasks` WS broadcast, which carries no payload). Re-fetch once and
 * fan the fresh state out to every subscriber.
 */
function notifyScheduledTasksChanged() {
  if (scheduledTaskCallbacks.length === 0) return;
  fetch('/api/scheduled-tasks').then(r => r.json()).then(data => {
    for (const entry of scheduledTaskCallbacks) {
      try { entry.cb(data); } catch (e) { console.error('Scheduled-task callback error:', e); }
    }
  }).catch(() => {});
}

/**
 * Notify panel mods that the shared contexts changed (#526) — called from app.js
 * on the `contexts` WS broadcast, which carries the full list. Fan it out directly.
 */
function notifyContextsChanged(contexts) {
  for (const entry of contextCallbacks) {
    try { entry.cb(contexts || []); } catch (e) { console.error('Contexts callback error:', e); }
  }
}

/**
 * Notify panel mods that the active context changed (#526) — the other half of the
 * bidirectional sync. Called from app.js when the Context View rail switches context.
 */
function notifyActiveContextChanged(id) {
  for (const entry of activeContextCallbacks) {
    try { entry.cb(id || null); } catch (e) { console.error('Active-context callback error:', e); }
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
 * Notify panel mods of a screenshot collection change (screenshot-added / screenshot-deleted).
 */
function notifyScreenshotEvent(msg) {
  for (const entry of screenshotEventCallbacks) {
    try { entry.cb(msg); } catch (e) { console.error('Screenshot event callback error:', e); }
  }
}

/**
 * Notify mods of a baby-browser request (called from app.js on WS broadcast).
 */
function notifyBabyBrowserRequest(req) {
  for (const entry of babyBrowserCallbacks) {
    if (req.targetTabId && entry.tabInstanceId !== req.targetTabId) continue;
    try { entry.cb(req); } catch (e) { console.error('Baby browser callback error:', e); }
  }
}

function notifyWSReconnected() {
  for (const entry of wsReconnectedCallbacks) {
    try { entry.cb(); } catch (e) { console.error('WS reconnected callback error:', e); }
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
  return activeView !== null;
}

/**
 * Inject the deepsteve bridge API into a mod iframe.
 * @param {HTMLIFrameElement} iframeEl - The iframe element
 * @param {string} modId - The mod ID that owns this iframe
 */
function _injectBridgeAPI(iframeEl, modId, tabInstanceId) {
  try {
    iframeEl.contentWindow.deepsteve = {
      getDeepsteveVersion() {
        return deepsteveVersion;
      },
      getTabInstanceId() {
        return tabInstanceId || null;
      },
      getSessions() {
        return hooks.getSessions();
      },
      focusSession(id) {
        showTerminalForSession(id);
      },
      // ── Excursions (#661). Strictly opt-in: focusSession() above keeps its one-hop
      // semantics untouched, so no existing mod changes.
      visitSession(id, opts) {
        // Only the page currently in the slot may lend the user out — a panel mod calling this
        // would start a trail back to a view that is not on screen.
        if (activeView?.id !== modId) return;
        visitSession(id, opts || {});
      },
      getExcursion() {
        return getExcursion();
      },
      endExcursion() {
        if (activeView?.id === modId) endExcursion();
      },
      // ── Quiet mode (#662). The host owns the state and always renders the toggle; this pair
      // exists because a host-registered ⌘\ listens on the TOP document and keystrokes inside
      // a mod iframe never cross that boundary — which is exactly when you want the key. So an
      // app binds it in its OWN keydown handler and calls through here.
      toggleQuiet() {
        if (activeView?.id !== modId) return;
        setQuietMode(!isQuietMode());
      },
      isQuiet() {
        return activeView?.id === modId ? isQuietMode() : false;
      },
      onExcursionChanged(cb) {
        const entry = { modId, cb };
        excursionChangedCallbacks.push(entry);
        try { cb(getExcursion()); } catch {}
        return () => {
          excursionChangedCallbacks = excursionChangedCallbacks.filter(e => e !== entry);
        };
      },
      // Host → app: "move your cursor". The app owns the queue because it is the only thing
      // that knows what resolved while you were away; a snapshot taken on the way in would
      // send ⌘↓ to a row that no longer exists.
      onExcursionCycle(cb) {
        excursionCycleHandler = { viewId: modId, cb };
        return () => {
          if (excursionCycleHandler?.cb === cb) excursionCycleHandler = null;
        };
      },
      onSessionsChanged(cb) {
        const entry = { modId, cb };
        sessionCallbacks.push(entry);
        try { cb(hooks.getSessions()); } catch {}
        return () => {
          sessionCallbacks = sessionCallbacks.filter(e => e !== entry);
        };
      },
      getWindowId() {
        return hooks.getWindowId();
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
      onUserActivity(cb) {
        const entry = { modId, cb };
        userActivityCallbacks.push(entry);
        return () => {
          userActivityCallbacks = userActivityCallbacks.filter(e => e !== entry);
        };
      },
      showAutoCycleToast(opts) {
        return hooks.showAutoCycleToast ? hooks.showAutoCycleToast(opts) : null;
      },
      hideAutoCycleToast() {
        if (hooks.hideAutoCycleToast) hooks.hideAutoCycleToast();
      },
      // Open the cross-project scheduled-run history page (#633). It renders in
      // the top document rather than in this iframe because mod iframes receive
      // no theme variables, so a grid built in here would be stuck on hardcoded
      // fallback colors.
      openScheduledHistory() {
        if (hooks.openScheduledHistory) hooks.openScheduledHistory();
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
      onScheduledTasksChanged(cb) {
        const entry = { modId, cb };
        scheduledTaskCallbacks.push(entry);
        // Fire immediately with the full current state from the server
        fetch('/api/scheduled-tasks').then(r => r.json()).then(data => {
          try { cb(data); } catch {}
        }).catch(() => {});
        return () => {
          scheduledTaskCallbacks = scheduledTaskCallbacks.filter(e => e !== entry);
        };
      },
      // --- Shared contexts / groups (#526) ---
      // The named groups the panel scopes by ARE the Context View's contexts.
      onContextsChanged(cb) {
        const entry = { modId, cb };
        contextCallbacks.push(entry);
        // Fire immediately with the current list from the server.
        fetch('/api/contexts').then(r => r.json()).then(d => {
          try { cb(d.contexts || []); } catch {}
        }).catch(() => {});
        return () => {
          contextCallbacks = contextCallbacks.filter(e => e !== entry);
        };
      },
      onActiveContextChanged(cb) {
        const entry = { modId, cb };
        activeContextCallbacks.push(entry);
        // Fire immediately with the current active context id.
        if (getActiveContextIdFn) { try { cb(getActiveContextIdFn()); } catch {} }
        return () => {
          activeContextCallbacks = activeContextCallbacks.filter(e => e !== entry);
        };
      },
      setActiveContext(id) {
        if (setActiveContextFn) setActiveContextFn(id || null);
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
      onScreenshotEvent(cb) {
        const entry = { modId, cb };
        screenshotEventCallbacks.push(entry);
        return () => {
          screenshotEventCallbacks = screenshotEventCallbacks.filter(e => e !== entry);
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
        const entry = { modId, tabInstanceId, cb };
        babyBrowserCallbacks.push(entry);
        return () => {
          babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e !== entry);
        };
      },
      onWSReconnected(cb) {
        const entry = { modId, cb };
        wsReconnectedCallbacks.push(entry);
        return () => {
          wsReconnectedCallbacks = wsReconnectedCallbacks.filter(e => e !== entry);
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
  // Refresh toggles in the open Mods modal if present. It used to walk only
  // `[data-mod-id^="skill:"]` rows; _refreshCardToggles now reads both state sources
  // correctly, so there is no reason for a second, skills-only walk of the same rows.
  const overlay = document.querySelector('.modal-overlay:has(.marketplace-modal)');
  if (overlay) _refreshCardToggles(overlay);
}

function handleModChanged(modId) {
  if (activeView?.id === modId && iframe) {
    iframe.src = iframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
  const panelEntry = panelMods.get(modId);
  if (panelEntry) {
    // Clear stale callbacks for this mod before reload triggers re-injection
    taskCallbacks = taskCallbacks.filter(e => e.modId !== modId);
    scheduledTaskCallbacks = scheduledTaskCallbacks.filter(e => e.modId !== modId);
    agentChatCallbacks = agentChatCallbacks.filter(e => e.modId !== modId);
    browserEvalCallbacks = browserEvalCallbacks.filter(e => e.modId !== modId);
    browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e.modId !== modId);
    screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e.modId !== modId);
    babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e.modId !== modId);
    wsReconnectedCallbacks = wsReconnectedCallbacks.filter(e => e.modId !== modId);
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
    sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
    activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);
    contextCallbacks = contextCallbacks.filter(e => e.modId !== modId);
    activeContextCallbacks = activeContextCallbacks.filter(e => e.modId !== modId);

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
  notifyUserActivity,
  notifyActiveSessionChanged,
  notifyTasksChanged,
  notifyScheduledTasksChanged,
  notifyContextsChanged,
  notifyActiveContextChanged,
  notifyAgentChatChanged,
  notifyBrowserEvalRequest,
  notifyBrowserConsoleRequest,
  notifyScreenshotCaptureRequest,
  notifyScreenshotEvent,
  notifySceneUpdateRequest,
  notifySceneQueryRequest,
  notifySceneSnapshotRequest,
  notifyBabyBrowserRequest,
  notifyWSReconnected,
  injectBridgeAPI: _injectBridgeAPI,
  showView,
  hideView,
  getActiveViewId,
  isModViewVisible,
  isModActive,
  handleModChanged,
  handleSkillsChanged,
  focusPanel,
  getContextMenuItems,
  getNewTabItems,
  showAutomationsModal: _showAutomationsModal,
  // Apps + excursions (#661)
  getApps,
  openApp,
  isExcursionActive,
  getExcursion,
  endExcursion,
  popExcursion,
  noteExcursionDrill,
  requestExcursionCycle,
  syncExcursion,
  // Quiet mode (#662)
  isQuietMode,
  isQuietAvailable,
  setQuietMode,
};

// context-views.js draws the Apps section into the rail with this, the same shape it already
// uses for appendRailRows() from project-mods.js. One-way: nothing here imports context-views.
export { appendAppRows, isExcursionActive };
