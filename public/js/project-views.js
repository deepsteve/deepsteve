/**
 * Project views — client (#726).
 *
 * A project view is a named view of the selected project's tabs — "Marketing", "Analytics" —
 * picked from a row of buttons over the tab strip. "All" is built in and is the default. The
 * definitions are files in the project's repo (`.deepsteve/views/<slug>.json`, see the
 * "Project views" section of mods/project-mods/tools.js), so they are committed and travel
 * with the checkout. This module owns everything else: which view a window is looking at,
 * which tabs are in it, and the chrome.
 *
 * A tab is in a view when the view's rules match it, or when it has been FILED there. Filing
 * is the manual mode: a tab opened while a view is selected is filed into it, the tab's
 * right-click "Views ▸" checklist files it in or out, and a tab an agent opens is filed into
 * whatever views its opener is in (or the one the spawn tool names). A filing lives with the
 * tab, in the client session stores, as a map `{ slug: true | false }` — `false` takes a tab
 * out of a view whose rules would otherwise match it, which is what makes "remove" mean
 * something for a rule-matched tab.
 *
 * Views only exist while a project is selected in the rail. The rail's "All" (or Projects
 * turned off) means no toggle, no bar and no filter; Decision Tab mode suspends them the way
 * it suspends the project filter.
 *
 * Two pieces of chrome, both host-owned:
 *   - #views-toggle: the collapsed form (the default). The first child of #tabs-list-wrapper,
 *     so it sits immediately before the first tab — above it in vertical layout, left of it
 *     in horizontal — however many project-mod buttons get inserted before the wrapper.
 *   - #views-bar: the expanded form. A full-width row of view buttons across the top of the
 *     monitor (#app-main's first child), above the tab strip in either layout.
 *
 * Like project-mods.js this never imports context-views.js; app.js injects what it needs. And
 * the same re-entrancy rule holds: render() never applies the filter. applyFilter() ends in
 * onContextViewApplied → render(), so only the entry points that CHANGE what is filtered —
 * refresh(), selectView(), setMembership() — may ask for a filter pass.
 */

import { nsKey } from './storage-namespace.js';

export const ALL = 'all';

let views = [];       // every view of every registered repo — the server sends the lot
let loaded = false;   // until the first fetch lands, a stored selection is kept but not applied
let version = 0;      // bumped whenever `views` changes; keys the merge cache
let cb = {};          // callbacks injected by app.js

// --------------------------------------------------------------------- storage

// Which view a window is looking at, per project. sessionStorage, like the selected project:
// it is "where you are", so a second window keeps its own (docs/frontend.md).
const SELECT_KEY = nsKey('deepsteve-project-view');
// Expanded or collapsed. localStorage, like the rail's width: it is "how it looks", a
// browser-wide preference. Collapsed is the default.
const EXPANDED_KEY = nsKey('deepsteve-project-views-bar');

let selection = loadSelection();
let expanded = loadExpanded();

function loadSelection() {
  try { return JSON.parse(sessionStorage.getItem(SELECT_KEY)) || {}; } catch { return {}; }
}
function saveSelection() {
  try { sessionStorage.setItem(SELECT_KEY, JSON.stringify(selection)); } catch { /* private mode */ }
}
function loadExpanded() {
  try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch { return false; }
}

export const isExpanded = () => expanded;

export function toggleExpanded(val = !expanded) {
  expanded = !!val;
  try { localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0'); } catch { /* private mode */ }
  render();
}

// --------------------------------------------------------------------- scoping

function inside(p, dir) {
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

const suspended = () => !!cb.isSuspended?.();
const activeContext = () => cb.getActiveContext?.() || null;

let mergeCache = { key: null, list: [] };

/**
 * The views of one project (context): every view whose repo is one of the project's folders
 * (or holds one — a project registered as a subfolder still gets its repo's views), with
 * same-slug views from different repos merged into one. Name and icon come from the first by
 * the server's sort (order, then name); the rules are unioned, each keeping the repo root its
 * `paths` are relative to.
 */
export function viewsForContext(ctx) {
  if (!ctx || !Array.isArray(ctx.dirs)) return [];
  const key = `${version}|${ctx.id}|${ctx.dirs.join('\n')}`;
  if (mergeCache.key === key) return mergeCache.list;
  const bySlug = new Map();
  for (const v of views) {
    if (!ctx.dirs.some(d => inside(v.project, d) || inside(d, v.project))) continue;
    const rules = (Array.isArray(v.match) ? v.match : []).map(r => ({ ...r, root: v.project }));
    const cur = bySlug.get(v.slug);
    if (cur) {
      cur.ids.push(v.id);
      cur.rules.push(...rules);
    } else {
      bySlug.set(v.slug, { slug: v.slug, name: v.name, icon: v.icon || '', ids: [v.id], rules });
    }
  }
  mergeCache = { key, list: [...bySlug.values()] };
  return mergeCache.list;
}

/** The slug a window is looking at in `ctx`: its stored choice if that view still exists, else All. */
export function selectedSlug(ctx) {
  if (!ctx) return ALL;
  const s = selection[ctx.id];
  if (!s || s === ALL || !loaded) return ALL;
  return viewsForContext(ctx).some(v => v.slug === s) ? s : ALL;
}

function setSelection(ctx, slug) {
  if (!ctx) return;
  if (slug === ALL) delete selection[ctx.id];
  else selection[ctx.id] = slug;
  saveSelection();
}

// ------------------------------------------------------------------ membership

/**
 * A tab's cwd relative to a repo root, with a worktree's `.claude/worktrees/<name>/` prefix
 * stripped so a worktree counts as its repo. null when the cwd is not in that repo at all.
 */
export function repoRelative(cwd, root) {
  if (!cwd || !root) return null;
  const base = String(root).replace(/\/+$/, '');
  if (!inside(cwd, base)) return null;
  const rel = cwd === base ? '' : cwd.slice(base.length + 1);
  const wt = rel.match(/^\.claude\/worktrees\/[^/]+(?:\/(.*))?$/);
  return wt ? (wt[1] || '') : rel;
}

/** One rule: EVERY field it states must match (any entry within a field). */
export function ruleMatches(rule, info) {
  if (rule.names) {
    const name = String(info.name || '').toLowerCase();
    if (!rule.names.some(n => name.includes(n))) return false;
  }
  if (rule.paths) {
    const rel = repoRelative(info.cwd, rule.root);
    if (rel === null) return false;
    if (!rule.paths.some(p => p === '' || rel === p || rel.startsWith(p + '/'))) return false;
  }
  if (rule.kinds) {
    if (!info.kind || !rule.kinds.includes(info.kind)) return false;
  }
  return true;
}

const rulesMatch = (view, info) => view.rules.some(r => ruleMatches(r, info));

/** Is this tab in this view? A filing wins either way; otherwise ANY rule decides. */
export function memberOf(info, view) {
  const filed = info?.views?.[view.slug];
  if (filed === true) return true;
  if (filed === false) return false;
  return rulesMatch(view, info || {});
}

/**
 * context-views' per-tab filter predicate (applyFilter ANDs it with the project match).
 * Visible when there is nothing to filter by — no project, the All view, a view list not yet
 * loaded — and for a tab that has no info yet (a restore placeholder), which is filtered once
 * it connects rather than flashing out and back.
 */
export function tabInView(id, ctx) {
  if (!ctx || suspended()) return true;
  const slug = selectedSlug(ctx);
  if (slug === ALL) return true;
  const info = cb.getTabInfo?.(id);
  if (!info) return true;
  const view = viewsForContext(ctx).find(v => v.slug === slug);
  return view ? memberOf(info, view) : true;
}

/** The selected view's slug for last-tab memory, or '' for All (keeps the old per-project key). */
export function viewKey(ctx) {
  const slug = selectedSlug(ctx);
  return slug === ALL ? '' : slug;
}

/**
 * Make sure `id` is visible in `ctx`'s view before the filter runs — the view half of
 * revealTabContext(), which focusTab() uses so a tab you were just sent to is on screen.
 * Moves to the first view that holds the tab, else All. Returns the label of the view it
 * moved to (for the toast), or null when nothing changed. Never applies the filter itself.
 */
export function revealTabView(id, ctx) {
  if (!ctx || suspended()) return null;
  const slug = selectedSlug(ctx);
  if (slug === ALL) return null;
  const info = cb.getTabInfo?.(id);
  if (!info) return null;
  const list = viewsForContext(ctx);
  const current = list.find(v => v.slug === slug);
  if (current && memberOf(info, current)) return null;
  const next = list.find(v => memberOf(info, v));
  setSelection(ctx, next ? next.slug : ALL);
  render();
  return next ? next.name : 'All';
}

/**
 * The filing for a tab the user opens in this window: the selected view, if one is. Every
 * browser-initiated open (the + button, ⌘T, the issue picker, the empty state) passes this.
 */
export function activeJoins() {
  const ctx = activeContext();
  if (!ctx || suspended()) return undefined;
  const slug = selectedSlug(ctx);
  return slug === ALL ? undefined : { [slug]: true };
}

/**
 * The filing for a tab an AGENT opens. `view` is the spawn tool's argument, already cleaned
 * by the server: a slug files it there, "all" files it nowhere. Without one, the tab is filed
 * into every view its opener is in right now — by filing or by rule — so the charts an
 * analytics agent spawns land in Analytics beside it. Exclusions are not inherited.
 */
export function spawnJoins({ view, openerId } = {}) {
  if (view === ALL) return undefined;
  if (view) return { [view]: true };
  const info = openerId ? cb.getTabInfo?.(openerId) : null;
  if (!info) return undefined;
  const out = {};
  for (const [slug, filed] of Object.entries(info.views || {})) if (filed === true) out[slug] = true;
  for (const ctx of cb.contextsForCwd?.(info.cwd) || []) {
    for (const v of viewsForContext(ctx)) if (memberOf(info, v)) out[v.slug] = true;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The tab menu's "Views ▸" checklist: every view of the selected project, ticked when the tab
 * is in it. null (item omitted) when no project is selected — there is no view to file into.
 */
export function menuFor(id) {
  const ctx = activeContext();
  if (!ctx || suspended()) return null;
  const info = cb.getTabInfo?.(id);
  if (!info) return null;
  return viewsForContext(ctx).map(v => ({ slug: v.slug, name: v.name, icon: v.icon, on: memberOf(info, v) }));
}

/**
 * File a tab into (on) or out of (off) a view, writing the smallest map that says so: a tab
 * the rules already include needs no `true`, and only a rule-matched tab needs a `false`.
 */
export function setMembership(id, slug, on) {
  const info = cb.getTabInfo?.(id);
  if (!info || !slug || slug === ALL) return;
  const ctx = activeContext();
  const view = ctx ? viewsForContext(ctx).find(v => v.slug === slug) : null;
  const ruled = view ? rulesMatch(view, info) : false;
  const next = { ...(info.views || {}) };
  delete next[slug];
  if (on && !ruled) next[slug] = true;
  if (!on && ruled) next[slug] = false;
  cb.setTabViews?.(id, Object.keys(next).length ? next : undefined);
}

/** Look at a view (or "all"). One filter pass, which ends in render(). */
export function selectView(slug) {
  const ctx = activeContext();
  if (!ctx) return;
  setSelection(ctx, slug && slug !== ALL && viewsForContext(ctx).some(v => v.slug === slug) ? slug : ALL);
  cb.applyFilter?.();
  render();
}

// ------------------------------------------------------------------ server I/O

function setViews(list) {
  views = Array.isArray(list) ? list : [];
  loaded = true;
  version++;
}

export function refresh() {
  return fetch('/api/project-views')
    .then(r => r.json())
    .then(d => {
      setViews(d.views);
      // A selection whose view is gone (deleted, or the branch that had it checked out) is
      // dropped here, so the next view of that name starts from All rather than resurrecting it.
      const ctx = activeContext();
      if (ctx && selection[ctx.id] && !viewsForContext(ctx).some(v => v.slug === selection[ctx.id])) {
        setSelection(ctx, ALL);
      }
      cb.applyFilter?.();
      render();
    })
    .catch(() => {});
}

async function postJSON(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * "+ New view" — the manual mode. A view made here has no rules: it holds exactly the tabs
 * filed into it. The server picks which of the project's repos gets the file (the one the
 * relevant tab is in, else the first). `fileTabId` files that tab into the new view at once —
 * the tab menu's "New view…".
 */
export async function createView({ fileTabId = null } = {}) {
  const ctx = activeContext();
  if (!ctx) return null;
  const name = prompt('Name the new view (e.g. Marketing). It is saved in the project\'s repo.');
  if (!name || !name.trim()) return null;
  const cwd = (fileTabId ? cb.getTabInfo?.(fileTabId)?.cwd : cb.getActiveTabCwd?.()) || undefined;
  let data;
  try {
    data = await postJSON('/api/project-views', 'POST', { contextId: ctx.id, name: name.trim(), cwd });
  } catch (e) {
    alert(`Could not create the view: ${e.message}`);
    return null;
  }
  const v = data.view;
  // Merge it in now rather than waiting for the ping, so the filing below can see it.
  setViews([...views.filter(x => x.id !== v.id), v]);
  if (fileTabId) setMembership(fileTabId, v.slug, true);
  render();
  cb.showToast?.(`View "${v.name}" saved to ${data.path} — commit it to share it`);
  return v;
}

function renameView(view) {
  const name = prompt('Rename view', view.name);
  if (!name || !name.trim() || name.trim() === view.name) return;
  for (const id of view.ids) postJSON('/api/project-views/' + encodeURIComponent(id), 'PUT', { name: name.trim() }).catch(e => alert(e.message));
  // No local reconcile: the server pings 'project-mods' and refresh() redraws.
}

function deleteView(view) {
  if (!confirm(`Delete the view "${view.name}"? Its file is removed from the repo. Tabs in it are not closed.`)) return;
  for (const id of view.ids) postJSON('/api/project-views/' + encodeURIComponent(id), 'DELETE').catch(e => alert(e.message));
}

// ---------------------------------------------------------------------- render

let toggleEl = null;
let lastSig = null;

// The toggle's icon when the view has no emoji of its own: folder tabs over a pane. Inline SVG in
// currentColor, like every other .nav-btn icon (index.html), so themes recolour it the same way —
// and ascii-art.css swaps it for a character the same way.
const VIEWS_SVG = '<svg viewBox="0 0 16 16"><path d="M2 6V3.5h4.5V6M8 6V4.5h4V6" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linejoin="round"/><rect x="1.5" y="6" width="13" height="7.5" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>';

function ensureToggle() {
  if (toggleEl && toggleEl.isConnected) return toggleEl;
  const wrapper = document.getElementById('tabs-list-wrapper');
  if (!wrapper) return null;
  toggleEl = document.createElement('button');
  toggleEl.id = 'views-toggle';
  toggleEl.className = 'views-toggle nav-btn hidden';
  toggleEl.tabIndex = -1;
  const icon = document.createElement('span');
  icon.className = 'btn-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'btn-label';
  const caret = document.createElement('span');
  caret.className = 'views-caret';
  caret.setAttribute('aria-hidden', 'true');
  toggleEl.append(icon, label, caret);
  toggleEl.addEventListener('click', () => toggleExpanded());
  wrapper.insertBefore(toggleEl, wrapper.firstChild);
  lastSig = null;
  return toggleEl;
}

function viewButton(view, active) {
  const btn = document.createElement('button');
  btn.className = 'view-tab' + (active ? ' active' : '');
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', active ? 'true' : 'false');
  btn.tabIndex = -1;
  btn.dataset.view = view ? view.slug : ALL;
  btn.title = view ? view.name : 'All tabs in this project';
  if (view?.icon) {
    const icon = document.createElement('span');
    icon.className = 'view-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = view.icon;
    btn.appendChild(icon);
  }
  const label = document.createElement('span');
  label.className = 'view-tab-label';
  label.textContent = view ? view.name : 'All';
  btn.appendChild(label);
  btn.addEventListener('click', () => selectView(view ? view.slug : ALL));
  if (view) {
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showViewMenu(e.clientX, e.clientY, view);
    });
  }
  return btn;
}

/**
 * Redraw the toggle and the bar. DOM only, and cheap to call on every applyFilter pass:
 * a signature of everything drawn short-circuits a pass that would change nothing.
 */
export function render() {
  const toggle = ensureToggle();
  const bar = document.getElementById('views-bar');
  const appMain = document.getElementById('app-main');
  const ctx = activeContext();
  // Shown whenever a project is selected, views or not: in the manual mode the toggle is how
  // you get to "+ New view" for the project's first one.
  const show = !!ctx && !suspended();
  const list = show ? viewsForContext(ctx) : [];
  const slug = show ? selectedSlug(ctx) : ALL;
  const open = show && expanded;
  const sig = JSON.stringify([show, ctx?.id, slug, open, list.map(v => [v.slug, v.name, v.icon])]);
  if (sig === lastSig) return;
  lastSig = sig;

  const current = list.find(v => v.slug === slug) || null;
  if (toggle) {
    toggle.classList.toggle('hidden', !show);
    toggle.classList.toggle('active', open);
    toggle.classList.toggle('filtering', slug !== ALL);
    toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    const name = current ? current.name : 'All';
    toggle.title = `View: ${name} — ${open ? 'hide' : 'show'} the views`;
    toggle.setAttribute('aria-label', `View: ${name}`);
    const [icon, label, caret] = toggle.children;
    if (current?.icon) {
      icon.className = 'btn-icon is-text is-emoji';
      icon.textContent = current.icon;
    } else {
      icon.className = 'btn-icon';
      icon.innerHTML = VIEWS_SVG;
    }
    label.textContent = name;
    caret.textContent = open ? '▴' : '▾';  // ▴ / ▾
  }

  appMain?.classList.toggle('views-bar-open', open);
  if (!bar) return;
  bar.classList.toggle('hidden', !open);
  bar.replaceChildren();
  if (!open) return;
  bar.appendChild(viewButton(null, slug === ALL));
  for (const v of list) bar.appendChild(viewButton(v, v.slug === slug));
  const add = document.createElement('button');
  add.className = 'view-tab view-tab-add';
  add.tabIndex = -1;
  add.title = 'New view — tabs are filed into it from their right-click menu';
  add.textContent = '+ New view';
  add.addEventListener('click', () => createView());
  bar.appendChild(add);
}

// ---------------------------------------------------------- view button menu
// The generic .context-menu classes, dismissed on mousedown like project-mods' menu (#546).

let viewMenu = null;
function hideViewMenu() {
  if (viewMenu) { viewMenu.remove(); viewMenu = null; }
  document.removeEventListener('mousedown', onViewMenuDocMouseDown, true);
  document.removeEventListener('keydown', onViewMenuKey, true);
}
function onViewMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); hideViewMenu(); }
}
function onViewMenuDocMouseDown(e) {
  if (viewMenu && !viewMenu.contains(e.target)) hideViewMenu();
}

function showViewMenu(x, y, view) {
  hideViewMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu project-view-menu';
  const add = (label, onPick, color) => {
    const item = document.createElement('div');
    item.className = 'context-menu-item';
    item.textContent = label;
    if (color) item.style.color = color;
    item.onclick = () => { hideViewMenu(); onPick(); };
    menu.appendChild(item);
  };
  add('Rename…', () => renameView(view));
  add('Delete…', () => deleteView(view), 'var(--ds-accent-red, #f85149)');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  viewMenu = menu;
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - r.height - 8) + 'px';
  document.addEventListener('mousedown', onViewMenuDocMouseDown, true);
  document.addEventListener('keydown', onViewMenuKey, true);
}

// ------------------------------------------------------------------- lifecycle

export function init(callbacks) {
  cb = callbacks || {};
  render();
  refresh();
}
