/**
 * Project Mods — client (#618).
 *
 * A Project Mod is a page an agent registered to ONE project (see
 * mods/project-mods/tools.js for the registry). This module owns the three places it
 * can register itself, all of which are host chrome that no mod iframe could reach:
 *
 *   1. rail   — an entry beneath its project in the projects rail (context-views.js
 *               calls railModsFor() while rendering)
 *   2. button — a square button in #tabs, which is the TOP of the strip in vertical
 *               tab layout and the LEFT of it in horizontal (same insertion point
 *               mod-manager.js uses for a DeepSteve Mod's toolbar button)
 *   3. tab    — a pinned tab that auto-opens in the background whenever its project
 *               is the active one, and keeps running while you work elsewhere
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

let mods = [];            // every project mod, all projects — the server sends the lot
let featureEnabled = true; // projectModsEnabled; false hides every surface
let cb = {};              // callbacks injected by app.js
const buttons = new Map(); // modId → button element currently in #tabs
const lastSeen = new Map(); // modId → updatedAt, so a page rewrite can reload open tabs

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

/** The mods registered to one specific project (context), in registration order. */
export function railModsFor(ctx) {
  if (!featureEnabled || !ctx || !Array.isArray(ctx.dirs)) return [];
  return mods.filter(m => m.enabled && m.surfaces.includes('rail')
    && ctx.dirs.some(d => pathInside(m.project, d)));
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
      renderButtons();
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
 */
function syncOpenTabs() {
  const seen = new Set();
  for (const mod of mods) {
    seen.add(mod.id);
    const prev = lastSeen.get(mod.id);
    if (prev !== undefined && prev !== mod.updatedAt) cb.reloadModTab?.(mod);
    lastSeen.set(mod.id, mod.updatedAt);
    if (!mod.enabled) cb.closeModTabs?.(mod.id);
    else cb.renameModTab?.(mod);
  }
  for (const id of [...lastSeen.keys()]) {
    if (!seen.has(id)) { lastSeen.delete(id); cb.closeModTabs?.(id); }
  }
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
  for (const btn of buttons.values()) btn.remove();
  buttons.clear();
  if (!tabs || !anchor) return;

  for (const mod of visibleMods()) {
    if (!mod.surfaces.includes('button')) continue;
    const btn = document.createElement('button');
    btn.className = 'project-mod-btn nav-btn is-glyph';
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
 */
function autoOpenPinned() {
  for (const mod of visibleMods()) {
    if (mod.surfaces.includes('tab')) cb.ensureModTab?.(mod, { background: true });
  }
}

/** Focus this mod's tab if it's open, else open one (focused — the user just asked). */
export function openMod(id) {
  const mod = getMod(id);
  if (mod) cb.ensureModTab?.(mod, { background: false });
}

// ------------------------------------------------------------------ rail rows

/**
 * Build one rail row. Shaped exactly like a context row (.context-row + icon/label
 * children) so the collapsed icon rail's existing rules apply unchanged — it hides
 * .context-row-label and shows .context-row-icon, and these degrade to squares for
 * free. `.project-mod-row` only adds the indent and a muted weight.
 */
export function makeRailRow(mod) {
  const row = document.createElement('div');
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

  row.onclick = () => openMod(mod.id);
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showModMenu(e.clientX, e.clientY, mod);
  });
  return row;
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
