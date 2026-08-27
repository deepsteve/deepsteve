/**
 * Project Mods — client (#618).
 *
 * A Project Mod is a page an agent registered to ONE project (see
 * mods/project-mods/tools.js for the registry). This module owns the three places it
 * can register itself, all of which are host chrome that no mod iframe could reach:
 *
 *   1. rail   — an entry beneath its project in the projects rail (context-views.js
 *               calls railModsFor() while rendering). The only surface that can be
 *               drawn for a project you are NOT in: a project with `alwaysShowMods`
 *               keeps its rows on screen whatever is selected (#647).
 *   2. button — a square button in #tabs, which is the TOP of the strip in vertical
 *               tab layout and the LEFT of it in horizontal (same insertion point
 *               mod-manager.js uses for a DeepSteve Mod's toolbar button)
 *   3. tab    — a pinned tab that auto-opens in the background whenever its project
 *               is the active one, and keeps running while you work elsewhere
 *
 * Those are LAUNCHER placements. What a launcher does is the second axis, `openMode`
 * (#628): 'tab' opens a real, closeable tab; 'view' takes over the content area and
 * consumes no tab at all, so a mod that asked for a button launcher is represented by that
 * button and nothing else. The view lives in mod-manager.js's single fullscreen slot rather
 * than a container of our own — two takeover mechanisms would race switchTo()'s delegation.
 *
 * Scoping is the same folder-prefix rule the whole Projects feature is built on
 * (tabInContext / pathInside): a mod shows when you are LOOKING at its project —
 * the active project in the rail, or, in the "All" view, the project of the active
 * tab. So the chrome always reflects "which project am I in".
 *
 * This module never imports context-views.js: everything it needs about the active
 * view arrives through the callbacks app.js injects, which keeps the two modules
 * a one-way dependency (context-views → project-mods).
 */

import { tabIcon } from './tab-manager.js';
import { nsKey } from './storage-namespace.js';

let mods = [];            // every project mod, all projects — the server sends the lot
let featureEnabled = true; // projectModsEnabled; false hides every surface
let cb = {};              // callbacks injected by app.js
const buttons = new Map(); // modId → button element currently in #tabs
const railRows = new Map(); // modId → the rail row context-views last drew for it (#628)
const lastSeen = new Map(); // modId → updatedAt, so a page rewrite can reload open tabs

// ----------------------------------------------------------- compact rail (#646)

/**
 * Compact view: lay the rail rows out left-to-right in a wrapping grid instead of one
 * per line, so a project with half a dozen mods costs two rail lines rather than six.
 *
 * localStorage, not sessionStorage. The rail's other prefs (width, archived-open) are
 * per-window VIEW state and live in sessionStorage deliberately; this is a display
 * preference, so it should hold across windows and reloads — the same call
 * mod-manager.js makes for its enabled-mods set. nsKey keeps it isolated per Baby
 * Browser recursion level like every other client key.
 *
 * It is not a setting: it never reaches the server, so there is no SETTINGS_SCHEMA
 * entry. The server-authoritative switch in this feature is projectModsEnabled, which
 * gates whether an agent may write a mod at all; how tall the rows are is nobody's
 * business but this browser's.
 */
const COMPACT_KEY = nsKey('deepsteve-project-mods-compact');
let compactRail = readCompact();

function readCompact() {
  try { return localStorage.getItem(COMPACT_KEY) === '1'; } catch { return false; }
}

export const isCompactRail = () => compactRail;

export function setCompactRail(val) {
  compactRail = !!val;
  try { localStorage.setItem(COMPACT_KEY, compactRail ? '1' : '0'); } catch { /* private mode */ }
  // The rail is context-views' render pass, so ask it to redraw — appendRailRows reads
  // the new value back out. Same one-way dependency refresh() relies on.
  cb.renderRail?.();
}

// ------------------------------------------------------------------- scoping

/**
 * True when path `p` is `dir` itself or nested inside it (trailing slashes ignored).
 * The client-side twin of server.js's pathInside and the rule tabInContext() applies
 * to tab cwds — worktrees under <repo>/.claude/worktrees/... match for free.
 */
export function pathInside(p, dir) {
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

/**
 * Every enabled mod registered to one specific project (context), in registration order —
 * regardless of which launcher surfaces it asked for.
 *
 * `surfaces` says where a mod's launchers go among the three surfaces THIS module owns; the
 * project row's right-click menu (#647) is a fourth launcher that is always present, so it
 * lists the lot. Surface-scoped callers filter this further.
 */
export function modsForProject(ctx) {
  if (!featureEnabled || !ctx || !Array.isArray(ctx.dirs)) return [];
  return mods.filter(m => m.enabled && ctx.dirs.some(d => pathInside(m.project, d)));
}

/** The mods registered to one specific project (context), in registration order. */
export function railModsFor(ctx) {
  return modsForProject(ctx).filter(m => m.surfaces.includes('rail'));
}

/**
 * Is this mod's project the one we're looking at?
 *
 * Two directions on purpose. With a project selected in the rail, the project is the
 * container and the mod's repo root is the thing inside it. In the "All" view there is
 * no container, so the active tab's cwd answers instead — and there the mod's project
 * is the container.
 */
function modInActiveProject(mod) {
  const ctx = cb.getActiveContext?.();
  if (ctx) return (ctx.dirs || []).some(d => pathInside(mod.project, d));
  const cwd = cb.getActiveTabCwd?.();
  return !!cwd && pathInside(cwd, mod.project);
}

/** Enabled mods belonging to the project currently in view. */
export function visibleMods() {
  if (!featureEnabled) return [];
  return mods.filter(m => m.enabled && modInActiveProject(m));
}

export const getMod = (id) => mods.find(m => m.id === id) || null;
export const getMods = () => mods;

/**
 * A project mod's tab id in a window — DERIVED from the mod id, never minted.
 *
 * A pinned mod is opened from three directions: restoreSessions() replaying the
 * persisted tab, autoOpenPinned() when the project comes into view, and a click on the
 * rail row or the strip button. With random ids each of those was a separate tab, and
 * they accumulated across reloads. Deriving the id makes a duplicate impossible by
 * construction instead of by bookkeeping. The `pm-` prefix keeps it out of the shell-id
 * namespace (both are 8-char randomUUID slices).
 */
export const tabIdFor = (modId) => 'pm-' + modId;

/**
 * A project mod's id in mod-manager's single fullscreen view slot (#628) — derived for the
 * same reason tabIdFor is, and namespaced so it can never collide with a DeepSteve mod id.
 *
 * It is also the modId the window.deepsteve bridge is injected under, in BOTH modes. That
 * is not a coincidence: it is what makes mod-manager's per-view callback sweeps, its
 * toolbar .active sweep and handleModChanged()'s cache-bust all correct for a project mod
 * without a single branch in that file.
 */
export const VIEW_PREFIX = 'project-mod:';
export const viewIdFor = (modId) => VIEW_PREFIX + modId;

/**
 * True when this mod opens as a view rather than a tab. The wire always carries an
 * openMode (serialize() sends the EFFECTIVE one), so the fallback only covers a client
 * talking to an older server — and it matches the server's default, which is 'view'.
 */
const opensAsView = (mod) => (mod?.openMode ?? 'view') === 'view';

/**
 * A project mod's tab label. The icon is prefixed into the NAME rather than carried
 * separately because that is the only channel a tab has: tabIcon() derives the chip
 * from the label, taking a leading emoji when there is one and a monogram otherwise.
 * Without this a mod whose rail row and strip button both show 📊 collapses to a "B"
 * in the vertical rail, where the chip IS the whole tab. Idempotent for a stub with no
 * icon, which is what the restore path passes, so a persisted name never doubles up.
 */
export const tabNameFor = (mod) => (mod.icon ? `${mod.icon} ${mod.name}` : mod.name);

/** The display glyph for a mod: its chosen icon, else the same derivation tabs use. */
export function modIcon(mod) {
  if (mod.icon) return { glyph: mod.icon, isEmoji: true };
  return tabIcon(mod.name);
}

// ----------------------------------------------------------------- server I/O

export function refresh() {
  return fetch('/api/project-mods')
    .then(r => r.json())
    .then(d => {
      mods = Array.isArray(d.mods) ? d.mods : [];
      featureEnabled = d.enabled !== false;
      render();
      // The rail is drawn by context-views, so ask it to redraw — it reads the new
      // list back out of railModsFor(). Called AFTER render() and never from inside
      // it: cb.renderRail runs applyFilter, whose onContextViewApplied hook calls
      // render() again, and a render() that called the rail would not terminate.
      // (applyFilter also early-returns when Projects are disabled, which is the
      // other reason render() can't be left to that path.)
      cb.renderRail?.();
    })
    .catch(() => {});
}

function patchMod(id, body) {
  return fetch('/api/project-mods/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
  // No local reconcile: the server broadcasts 'project-mods' and refresh() re-renders.
}

function deleteModOnServer(id) {
  return fetch('/api/project-mods/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
}

// -------------------------------------------------------------------- render

/**
 * Re-derive the surfaces this module owns directly. Cheap and idempotent, so it can be
 * called on any change (mod list, active project, active tab) without bookkeeping.
 * The rail rows are NOT here — context-views owns that render pass and pulls them via
 * railModsFor(); see the note in refresh().
 */
// Re-entrancy guard. render() is driven by host hooks it can itself trigger — opening a
// pinned tab calls notifyTabsChanged(), which runs applyFilter(), whose
// onContextViewApplied hook calls render() again. Without this, the very first pinned
// mod recursed ~1600 deep and no surface ever finished rendering. A nested call sets
// `dirty` instead of running, and the outer call re-runs once so nothing is lost.
let rendering = false;
let dirty = false;

export function render() {
  if (rendering) { dirty = true; return; }
  rendering = true;
  try {
    do {
      dirty = false;
      syncOpenTabs();
      syncModView();   // before renderButtons/makeRailRow, so the .active they paint is settled
      renderButtons();
      paintRailRows();
      autoOpenPinned();
    } while (dirty);
  } finally {
    rendering = false;
    dirty = false;
  }
}

/**
 * Reconcile tabs that are already open against the current registry: a deleted or
 * disabled mod's tab closes, a renamed one's tab is renamed, and a mod whose page was
 * rewritten gets its iframe reloaded (the broadcast is payload-less, so updatedAt is
 * what tells us the bytes changed).
 *
 * Un-pinning is the fourth reason (#645), and the only one that is selective: the tab
 * autoOpenPinned() opened goes away, but a tab you opened yourself by clicking a
 * tab-mode mod stays. Without the distinction one of the two is always wrong —
 * closing everything makes a click on a `surfaces:['rail'], openMode:'tab'` mod
 * impossible (the next render would shut the tab it just opened), and closing nothing
 * is the bug: the pin's tab outlived the pin, and came back on every reload.
 */
function syncOpenTabs() {
  const seen = new Set();
  for (const mod of mods) {
    seen.add(mod.id);
    const prev = lastSeen.get(mod.id);
    if (prev !== undefined && prev !== mod.updatedAt) cb.reloadModTab?.(mod);
    lastSeen.set(mod.id, mod.updatedAt);
    if (!mod.enabled) cb.closeModTabs?.(mod.id);
    else {
      // A view never owns a tab. Flipping a mod tab→view — or restoring a persisted entry
      // written before the flip — leaves one behind, and closing it here is the guarantee
      // that it goes away. Cheap and idempotent: the callback is a no-op for a mod with no
      // open tab, which is every view-mode mod after the first pass.
      //
      // `else if`, not a second `if`: the view branch already closed everything this mod
      // owns, and the selective close after it would only ever be a weaker no-op.
      if (opensAsView(mod)) cb.closeModTabs?.(mod.id);
      else if (!mod.surfaces.includes('tab')) cb.closePinnedModTab?.(mod.id);
      cb.renameModTab?.(mod);
    }
  }
  for (const id of [...lastSeen.keys()]) {
    if (!seen.has(id)) { lastSeen.delete(id); railRows.delete(id); cb.closeModTabs?.(id); }
  }
}

/**
 * Reconcile the ONE view slot against the registry (#628).
 *
 * A view has no tab, no session and no strip presence, so this pass is the only thing that
 * can keep it honest — and one rule covers every case: the slot may only hold a mod that is
 * still registered, still enabled, still in view mode, and still belongs to the project you
 * are looking at. Deleted, disabled, projectModsEnabled turned off, openMode flipped back to
 * 'tab', and "you switched project" all collapse into that.
 *
 * Dismissing on a project switch is deliberate — it is the same visibility rule the launcher
 * itself follows, so a view can never outlive the chrome that opens it.
 *
 * Idempotent by construction, which is what lets the render() guard absorb the re-entrancy:
 * hiding fires onViewChanged → render(), and by then the slot is empty and this returns at
 * the first check.
 */
function syncModView() {
  const viewId = cb.getViewInfo?.()?.id;
  // Empty, or a DeepSteve Mod owns it — either way, not ours to reconcile.
  if (!viewId || !viewId.startsWith(VIEW_PREFIX)) return;
  const modId = viewId.slice(VIEW_PREFIX.length);
  const mod = getMod(modId);
  if (mod && opensAsView(mod) && visibleMods().some(m => m.id === modId)) return;
  cb.hideModView?.(modId);
}

/**
 * Surface 2 — one square button per mod, inserted before #tabs-list-wrapper so the
 * cluster sits with the rest of the chrome: the top of the strip in vertical tabs, the
 * left of it in horizontal. `.nav-btn` supplies the [icon][label] shape, the collapsed
 * icon-rail treatment and the vertical-layout sizing; `.is-glyph` drops the label in
 * the horizontal strip, which is what makes it a square.
 *
 * Rebuilt wholesale rather than diffed — there are a handful of these at most, and a
 * full rebuild is the only way the DOM order can't drift from the registry order.
 */
function renderButtons() {
  const tabs = document.getElementById('tabs');
  const anchor = document.getElementById('tabs-list-wrapper');
  const openViewId = cb.getViewInfo?.()?.id || null;
  for (const btn of buttons.values()) btn.remove();
  buttons.clear();
  if (!tabs || !anchor) return;

  for (const mod of visibleMods()) {
    if (!mod.surfaces.includes('button')) continue;
    const btn = document.createElement('button');
    btn.className = 'project-mod-btn nav-btn is-glyph';
    // Rebuilt wholesale, so the .active state can't drift from the slot (#628).
    if (openViewId === viewIdFor(mod.id)) btn.classList.add('active');
    btn.dataset.projectModId = mod.id;
    btn.title = `${mod.name} — project mod`;
    btn.setAttribute('aria-label', mod.name);

    const { glyph, isEmoji } = modIcon(mod);
    const iconEl = document.createElement('span');
    iconEl.className = `btn-icon is-text${isEmoji ? ' is-emoji' : ''}`;
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = glyph;
    const labelEl = document.createElement('span');
    labelEl.className = 'btn-label';
    labelEl.textContent = mod.name;
    btn.append(iconEl, labelEl);

    btn.addEventListener('click', () => openMod(mod.id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showModMenu(e.clientX, e.clientY, mod);
    });
    tabs.insertBefore(btn, anchor);
    buttons.set(mod.id, btn);
  }
}

/**
 * Surface 3 — a mod with the 'tab' surface opens as soon as its project is in view,
 * in the BACKGROUND (#600's rule: unattended work must not steal focus). Its iframe
 * stays mounted when you switch away, which is what "always on in the background"
 * means here — no server-side worker is involved.
 *
 * `pinned` travels with `background` because this is the only place either is set: it
 * stamps the tab's ORIGIN, which is what syncOpenTabs() reads back when the pin is
 * removed. A tab opened from openMod() carries neither and is therefore the user's.
 */
function autoOpenPinned() {
  for (const mod of visibleMods()) {
    // A view is never pinned (the pin overrides view mode for as long as it is set, so a
    // pinned mod reads as openMode:'tab' — see cleanPlacement in the server tools), but the
    // client can hold a stale list mid-flight, and auto-taking over the screen would be the
    // worst possible way to find out. Re-check rather than trust.
    if (!opensAsView(mod) && mod.surfaces.includes('tab')) cb.ensureModTab?.(mod, { background: true, pinned: true });
  }
}

/**
 * The single choke point for "the user asked to open this mod" — the rail row, the strip
 * button and the menu's Open item all land here.
 *
 * A tab-mode mod focuses its tab or opens one. A view-mode mod toggles the fullscreen slot:
 * clicking the launcher again dismisses it, the same way a DeepSteve Mod's toolbar button
 * behaves. While the view is merely BACKGROUNDED, a click brings it back rather than
 * dismissing it — otherwise the launcher would appear to do nothing.
 */
export function openMod(id, { fromContextId = null } = {}) {
  const mod = getMod(id);
  if (!mod) return;
  // Opening a mod that belongs to a project you are NOT looking at (#647): select that
  // project first, or the open appears to do nothing. A mod's tab carries cwd = its repo
  // root, so applyFilter() hides it while another project is selected, and syncModView()
  // tears a view down on the very next pass for the same reason. Only the always-show rail
  // rows and the project menu pass this — the surfaces scoped to the active project can't
  // be pressed from anywhere else, and would only re-select what is already selected.
  if (fromContextId && cb.getActiveContext?.()?.id !== fromContextId) cb.selectProject?.(fromContextId);
  if (!opensAsView(mod)) { cb.ensureModTab?.(mod, { background: false }); return; }
  const { id: openId, front } = cb.getViewInfo?.() || {};
  if (openId === viewIdFor(mod.id) && front) cb.hideModView?.(mod.id);
  else cb.showModView?.(mod);
}

// ------------------------------------------------------------------ rail rows

/**
 * Draw a project's rail mods into `list` — the one place that decides between the two
 * layouts, so context-views never has to know a compact mode exists (#646).
 *
 * Off, the rows go straight into the .context-list column and the DOM is identical to
 * what it was before compact view existed: no wrapper, no extra class, nothing for the
 * default path to regress against. On, they go into a single .project-mod-flow, which is
 * what the wrapping icon-square CSS keys off — a wrapper rather than a class on the list
 * because the list also holds the project rows, which must keep stacking.
 *
 * Both modes build the SAME row, labels included; compact hides them in CSS. So the
 * toggle is a pure display preference with no second DOM shape to keep correct, and the
 * name a square drops is still on the row's title attribute.
 */
export function appendRailRows(list, railMods, ownerContextId = null) {
  if (!list || !railMods?.length) return;  // no mods → no empty wrapper
  const target = compactRail ? document.createElement('div') : list;
  if (target !== list) target.className = 'project-mod-flow';
  for (const mod of railMods) target.appendChild(makeRailRow(mod, ownerContextId));
  if (target !== list) list.appendChild(target);
}

/**
 * Build one rail row. Shaped exactly like a context row (.context-row + icon/label
 * children) so the collapsed icon rail's existing rules apply unchanged — it hides
 * .context-row-label and shows .context-row-icon, and these degrade to squares for
 * free. `.project-mod-row` only adds the indent and a muted weight.
 *
 * `ownerContextId` is the project the row was drawn under. Since #647 that need not be
 * the active one — an always-show project draws its rows wherever you are — so the row
 * has to carry the project it belongs to in order to select it on press.
 */
export function makeRailRow(mod, ownerContextId = null) {
  const row = document.createElement('div');
  railRows.set(mod.id, row);
  // `has-icon` follows the same rule project rows follow (#569): the expanded rail shows
  // a chip only for a CHOSEN icon, never a derived monogram — otherwise every row grows
  // an identical-looking square. The collapsed icon rail shows one either way.
  row.className = 'context-row project-mod-row' + (mod.icon ? ' has-icon' : '');
  row.dataset.projectModId = mod.id;
  row.title = `${mod.name} — project mod · right-click for options`;

  const { glyph, isEmoji } = modIcon(mod);
  const iconEl = document.createElement('span');
  iconEl.className = 'context-row-icon' + (isEmoji ? ' is-emoji' : '');
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = glyph;
  row.appendChild(iconEl);

  const label = document.createElement('span');
  label.className = 'context-row-label';
  label.textContent = mod.name;
  row.appendChild(label);

  row.onclick = () => openMod(mod.id, { fromContextId: ownerContextId });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showModMenu(e.clientX, e.clientY, mod);
  });
  paintRailRows();
  return row;
}

/**
 * Mark whichever rail row owns the view slot, reusing the .context-row.active styling
 * project rows already have (including the collapsed icon-rail treatment).
 *
 * A sweep over remembered nodes rather than a rebuild, because render() may NOT call
 * cb.renderRail() — see the note in refresh(). A row detached by a later renderRail() is
 * simply replaced in the map by the new one; toggling a class on a stale node is a no-op.
 */
function paintRailRows() {
  const openViewId = cb.getViewInfo?.()?.id || null;
  for (const [modId, row] of railRows) {
    row.classList.toggle('active', openViewId === viewIdFor(modId));
  }
}

// -------------------------------------------------------- row right-click menu
// Reuses the generic .context-menu classes (the right-click-menu namespace, which is
// unrelated to Context Views despite the name) and mirrors context-views' dismissal:
// mousedown, not click, because a re-render can detach the pressed element mid-gesture
// and the click that follows never reaches document (#546).

let modMenu = null;
function hideModMenu() {
  if (modMenu) { modMenu.remove(); modMenu = null; }
  document.removeEventListener('mousedown', onMenuDocMouseDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); hideModMenu(); }
}
function onMenuDocMouseDown(e) {
  if (modMenu && !modMenu.contains(e.target)) hideModMenu();
}
function addMenuItem(menu, label, onPick, color) {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  item.textContent = label;
  if (color) item.style.color = color;
  item.onclick = () => { hideModMenu(); onPick(); };
  menu.appendChild(item);
  return item;
}
function addMenuSeparator(menu) {
  const sep = document.createElement('div');
  sep.className = 'context-menu-separator';
  menu.appendChild(sep);
}

const SURFACE_LABELS = {
  rail: 'Show in the projects rail',
  button: 'Show as a tab-strip button',
  tab: 'Pin as a background tab',
};

function showModMenu(x, y, mod) {
  hideModMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu project-mod-menu';

  addMenuItem(menu, 'Open', () => openMod(mod.id));
  addMenuItem(menu, 'Rename…', () => {
    const name = prompt('Project mod name', mod.name);
    if (name && name.trim() && name.trim() !== mod.name) patchMod(mod.id, { name: name.trim() });
  });
  addMenuItem(menu, mod.icon ? 'Change icon…' : 'Set icon…', () => {
    const icon = prompt('Icon (an emoji — leave blank to derive one from the name)', mod.icon || '');
    if (icon !== null) patchMod(mod.id, { icon: icon.trim() });
  });

  addMenuSeparator(menu);
  // Surfaces are a checklist rather than a submodal: three toggles is the whole
  // vocabulary, and the row you right-clicked is one of them.
  for (const key of ['rail', 'button', 'tab']) {
    const on = mod.surfaces.includes(key);
    addMenuItem(menu, `${on ? '✓ ' : '   '}${SURFACE_LABELS[key]}`, () => {
      const next = on ? mod.surfaces.filter(s => s !== key) : [...mod.surfaces, key];
      // The server floors an empty list back to ["rail"] — say so rather than letting
      // the last toggle look like it silently didn't take.
      if (!next.length) {
        alert('A project mod needs at least one surface, or there would be no way to open it.');
        return;
      }
      patchMod(mod.id, { surfaces: next });
    });
  }

  addMenuSeparator(menu);
  // The second axis (#628): the three above say WHERE the launchers go, this says what one
  // DOES. Each direction is a single-field PUT. Ticking this drops the "tab" surface, while
  // the pin only OVERRIDES this one for as long as it is set (#645) — so the tick stays,
  // marked paused, and un-pinning brings the view back. `storedOpenMode` is the standing
  // choice, `openMode` the effective one; they differ exactly while a pin is overriding.
  const viewChosen = (mod.storedOpenMode ?? mod.openMode) === 'view';
  const viewPaused = viewChosen && !opensAsView(mod);
  addMenuItem(
    menu,
    `${viewChosen ? '✓ ' : '   '}Open as a full view (no tab)${viewPaused ? ' — paused while pinned' : ''}`,
    // Picking it while paused means "I want the view back now": openMode:'view' is the
    // explicit write that drops the pin, so one click undoes both halves.
    () => patchMod(mod.id, { openMode: viewChosen && !viewPaused ? 'tab' : 'view' }),
  );

  addMenuSeparator(menu);
  // The one item here that is NOT about the mod you right-clicked (#646) — hence the
  // parenthetical, and hence a separator of its own. It is also the only item that
  // doesn't PUT: it's a per-browser display preference, not registry state.
  addMenuItem(menu, `${compactRail ? '✓ ' : '   '}Compact view (all project mods)`, () => {
    setCompactRail(!compactRail);
  });

  addMenuSeparator(menu);
  addMenuItem(menu, mod.enabled ? 'Disable' : 'Enable', () => patchMod(mod.id, { enabled: !mod.enabled }));
  addMenuItem(menu, 'Delete', () => {
    if (confirm(`Delete project mod "${mod.name}"? Its page is removed from disk — this can't be undone.`)) {
      deleteModOnServer(mod.id);
    }
  }, 'var(--ds-accent-red, #f85149)');

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  modMenu = menu;

  // Keep the menu on screen (it opens near the rail's right edge / the strip).
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - r.height - 8) + 'px';

  document.addEventListener('mousedown', onMenuDocMouseDown, true);
  document.addEventListener('keydown', onMenuKey, true);
}

// ------------------------------------------------------------------ lifecycle

export function init(callbacks) {
  cb = callbacks || {};
  refresh();
}
