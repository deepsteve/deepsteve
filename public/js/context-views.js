/**
 * Context Views — group tabs into folder-based "contexts" and filter the tab
 * strip to one context at a time (#522).
 *
 * A context = { id, name, dirs: [absolute repo paths] }. A tab belongs to a
 * context when its cwd is inside one of those folders (prefix match), so
 * subdirectories AND worktree sessions (<repo>/.claude/worktrees/...) are
 * included automatically. Selecting a context hides non-matching tabs; "All"
 * shows everything. Display tabs carry the cwd of the session that spawned them
 * (#530), so they scope to that context like any session tab. Tabs with no cwd
 * (mod tabs) are treated as global and stay visible in every context.
 *
 * UI: a left context panel (#context-rail) toggled by the #context-toggle button
 * (next to the layout switcher) or by Cmd+P — preventDefault'd so the browser's
 * Print dialog never opens. Cmd+Up / Cmd+Down cycle through [All, ...contexts].
 * Chord: Cmd+P then A (Cmd held the whole time) jumps to the "All" view — the A
 * is gated behind Cmd+P so a bare Cmd+A stays native (terminal/input select-all).
 *
 * Creating a tab outside the active context auto-switches the view to the new
 * tab's own context — first matching context in rail order, else "All" — via
 * revealTabContext(), so a fresh tab is never hidden the moment it opens (#547).
 *
 * Self-contained module following the cmd-tab-switch.js / command-palette.js
 * pattern: init(callbacks), setEnabled(val), plus applyFilter()/
 * requestNewTabInContext() for app.js to call.
 */

import { nsKey } from './storage-namespace.js';
import { register, registerInfo } from './shortcuts.js';
import { tabIcon } from './tab-manager.js';

// Context definitions are server-owned (#526): they are the same entity as the
// Scheduled Tasks "project groups", loaded from /api/contexts and kept fresh by
// the 'contexts' WS broadcast (app.js → setContexts). Only the per-window VIEW
// state (which context is active, whether the rail is open) stays client-side.
const ACTIVE_KEY = nsKey('deepsteve-context-active');   // sessionStorage: active id (per window)
const SIDEBAR_KEY = nsKey('deepsteve-context-sidebar'); // sessionStorage: open state (per window)
const LAST_TAB_KEY = nsKey('deepsteve-context-last-tab'); // sessionStorage: { [contextId]: tabId } (per window, #541)
const WIDTH_KEY = nsKey('deepsteve-context-width');     // sessionStorage: rail width in px (per window, #569)

let enabled = true;
let contexts = [];          // [{ id, name, dirs: [] }]
let activeContextId = null; // null = view all
let lastTabByContext = {};  // { contextId: tabId } — last tab viewed while that context was active (#541)
let sidebarOpen = false;
let cmdChordArmed = false;  // true between a Cmd+P press and the Cmd release — see onKeyDown

let cb = {};       // callbacks injected by app.js
let rail = null;   // #context-rail element
let resizer = null; // #context-resizer — drag handle at the rail's right edge (#569)
let toggleBtn = null;
let indicatorEl = null; // #context-indicator — muted active-context name shown next to the toggle when the rail is closed (#531)
let ruleTitleEl = null; // #context-rule-title — dashed ruled variant of the same label shown at the top of the terminal in the retro-monitor theme (#535)

// ---------------------------------------------------------------- persistence

// Definitions come from the server. Fetch once on init; live updates arrive via
// setContexts() (called by app.js on the 'contexts' broadcast).
function fetchContexts() {
  fetch('/api/contexts')
    .then(r => r.json())
    .then(d => setContexts(d.contexts || []))
    .catch(() => {});
}
// Persist a single upsert / delete to the server. The server broadcasts the new
// full list back to every window (setContexts), so we don't reconcile by hand.
function saveContext(c) {
  fetch('/api/contexts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  }).catch(() => {});
}
function deleteContextOnServer(id) {
  fetch('/api/contexts/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
}
// Persist a drag-to-reorder (#532). Send the full id order; the server rebuilds
// its array and broadcasts the new list back (setContexts) to every window.
function persistOrder(order) {
  fetch('/api/contexts/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  }).catch(() => {});
}
// Delete a context locally (optimistic) + on the server. Shared by the editor
// modal's Delete button and the row right-click menu (#532).
function deleteContext(ctx) {
  contexts = contexts.filter(c => c.id !== ctx.id);
  if (activeContextId === ctx.id) { activeContextId = null; saveActive(); notifyActive(); }
  deleteContextOnServer(ctx.id);
  applyFilter();
}
function loadActive() {
  return sessionStorage.getItem(ACTIVE_KEY) || null;
}
function saveActive() {
  if (activeContextId) sessionStorage.setItem(ACTIVE_KEY, activeContextId);
  else sessionStorage.removeItem(ACTIVE_KEY);
}
function loadSidebar() {
  return sessionStorage.getItem(SIDEBAR_KEY) === '1';
}
function saveSidebar() {
  sessionStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
}
// Rail width (#569). Like the vertical-tabs sidebar (#552) the restored value is
// guarded for SHAPE not size — no Math.max floor — so a width dragged down to the
// rail floor (icon rail) survives a reload instead of silently re-inflating.
function loadWidth() {
  const n = parseFloat(sessionStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveWidth(px) {
  sessionStorage.setItem(WIDTH_KEY, String(Math.round(px)));
}
function loadLastTabs() {
  try { return JSON.parse(sessionStorage.getItem(LAST_TAB_KEY)) || {}; } catch { return {}; }
}
function saveLastTabs() {
  sessionStorage.setItem(LAST_TAB_KEY, JSON.stringify(lastTabByContext));
}

function genId() {
  try { return crypto.randomUUID().slice(0, 8); }
  catch { return Math.random().toString(36).slice(2, 10); }
}

// ------------------------------------------------------------------- matching

function tabInContext(cwd, ctx) {
  if (!ctx) return true;
  if (!cwd) return true; // no cwd (mod/display tab) → global, visible everywhere
  return ctx.dirs.some(d => {
    const base = d.replace(/\/+$/, '');
    return cwd === base || cwd.startsWith(base + '/');
  });
}

// Pure (no module state / globals): split `recentDirs` into the active context's
// repos followed by the remaining recents, for the new-tab flow (#573). The
// context group is ALL of `contextDirs` in stored order (even repos with no
// recent-dir entry), mapped to the same `{path}` shape recent-dir entries use.
// `rest` is `recentDirs` with any entry whose path EXACTLY matches a context dir
// removed (trailing-slash-insensitive) — a recent SUBDIR of a context repo is
// kept, since it's a distinct quick-pick; this is ordering, not filtering. With
// no context (`contextDirs` empty) `contextGroup` is [] and `rest` === the input
// order, so callers collapse to the pre-#573 behavior.
export function orderRecentDirsByContext(contextDirs, recentDirs) {
  const norm = (p) => (p || '').replace(/\/+$/, '');
  const ctxPaths = new Set((contextDirs || []).map(norm));
  const contextGroup = (contextDirs || []).map((path) => ({ path }));
  const rest = (recentDirs || []).filter((d) => !ctxPaths.has(norm(d.path)));
  return { contextGroup, rest };
}

function getActiveContext() {
  return contexts.find(c => c.id === activeContextId) || null;
}

function activeContextHasTabs() {
  const ctx = getActiveContext();
  if (!ctx) return true;
  const ids = cb.getOrderedTabIds ? cb.getOrderedTabIds() : [];
  return ids.some(id => tabInContext(cb.getTabCwd?.(id), ctx));
}

// Owned-tab count for the rail badge (#529). "All" (ctx null) → every tab. A real
// context → only tabs whose real cwd is inside its dirs; no-cwd global tabs
// (mod/display) are excluded so they don't inflate every context. This means the
// per-context counts intentionally won't sum to the "All" total.
function contextTabCount(ctx) {
  const ids = cb.getOrderedTabIds ? cb.getOrderedTabIds() : [];
  if (!ctx) return ids.length;
  return ids.reduce((n, id) => {
    const cwd = cb.getTabCwd?.(id);
    return n + (cwd && tabInContext(cwd, ctx) ? 1 : 0);
  }, 0);
}

// --------------------------------------------------------------------- filter

// True when a real context is active but none of the open tabs belong to it —
// the "empty context" case. app.js queries this so the shared #empty-state
// welcome screen (nice ASCII branding + "+ New") covers the stale terminal
// instead of a separate bland placeholder (#534). "All" / disabled → never empty.
export function activeContextIsEmpty() {
  return enabled && !!getActiveContext() && !activeContextHasTabs();
}

export function applyFilter() {
  if (!enabled) return;
  const ctx = getActiveContext();
  const ids = cb.getOrderedTabIds ? cb.getOrderedTabIds() : [];
  let firstVisible = null;

  for (const id of ids) {
    const tabEl = document.getElementById('tab-' + id);
    if (!tabEl) continue;
    const visible = tabInContext(cb.getTabCwd?.(id), ctx);
    tabEl.classList.toggle('context-hidden', !visible);
    if (visible && !firstVisible) firstVisible = id;
  }

  // If a context is active and the current active tab is now hidden, restore the
  // tab last viewed in this context (#541); fall back to the first visible tab
  // when there's no memory yet or the remembered tab is gone / no longer matches.
  if (ctx) {
    const activeTab = cb.getActiveTabId?.();
    const activeHidden = !activeTab ||
      document.getElementById('tab-' + activeTab)?.classList.contains('context-hidden');
    if (activeHidden) {
      const remembered = lastTabByContext[ctx.id];
      const rEl = remembered ? document.getElementById('tab-' + remembered) : null;
      const target = (rEl && !rEl.classList.contains('context-hidden')) ? remembered : firstVisible;
      if (target) cb.switchToTab?.(target);
    }
  }

  // A context with no matching tabs has no terminal to show — ask app.js to
  // recompute the shared #empty-state screen (it covers the stale terminal via
  // activeContextIsEmpty). Any other state hides it. See #534.
  cb.updateEmptyState?.();

  renderRail();
  updateIndicator();
}

// Muted active-context name shown right of the ◧ toggle, but only while the rail
// is closed and a real context is filtering (in "All" nothing is hidden, so the
// label stays blank). This is the sole "which context?" cue when the menu is
// collapsed (#531). Driven from applyFilter() + setSidebar(), the two choke
// points every context / open-close transition already passes through.
function updateIndicator() {
  const ctx = getActiveContext();               // null in "All"
  const show = enabled && !sidebarOpen && !!ctx; // rail closed + real context
  const name = show ? ctx.name : '';
  const tip  = show ? `Context: ${ctx.name} — click to open (⌘P)` : '';
  // Drive both presentations: the tab-strip label (#context-indicator) and the
  // ruled terminal title (#context-rule-title). CSS picks which one is visible —
  // the retro-monitor theme hides the former and reveals the latter (#535).
  for (const el of [indicatorEl, ruleTitleEl]) {
    if (!el) continue;
    el.textContent = name;
    el.classList.toggle('hidden', !show);
    el.title = tip;
  }
}

// ----------------------------------------------------------------- rail (DOM)

function renderRail() {
  if (!rail || !sidebarOpen) return;
  rail.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'context-rail-header';
  header.textContent = 'Contexts';
  rail.appendChild(header);

  const list = document.createElement('div');
  list.className = 'context-list';
  list.appendChild(makeRow(null, 'All', activeContextId === null, null));
  for (const ctx of contexts) {
    list.appendChild(makeRow(ctx.id, ctx.name, ctx.id === activeContextId, ctx));
  }
  rail.appendChild(list);

  // Empty-context helper — clickable to open a tab in the context's repo.
  if (getActiveContext() && !activeContextHasTabs()) {
    const note = document.createElement('div');
    note.className = 'context-empty-note';
    note.textContent = 'No tabs in this context — click to open one.';
    note.onclick = () => newTabInActiveContext();
    rail.appendChild(note);
  }

  const add = document.createElement('div');
  add.className = 'context-add';
  add.textContent = '+ New context';
  add.onclick = () => openContextEditor(null);
  rail.appendChild(add);

  const hint = document.createElement('div');
  hint.className = 'context-hint';
  hint.textContent = '⌘↑/↓ switch · ⌘P hide';
  rail.appendChild(hint);
}

function makeRow(id, name, active, ctx) {
  const row = document.createElement('div');
  // has-icon governs whether the icon chip shows in the EXPANDED rail (only for a
  // chosen icon — see #569; an uploaded image, #579, counts too); the collapsed icon
  // rail always shows a chip.
  row.className = 'context-row' + (active ? ' active' : '') + ((ctx?.icon || ctx?.iconImage) ? ' has-icon' : '');

  // Icon square (#569/#579). An uploaded image (ctx.iconImage) wins, then a chosen emoji
  // (ctx.icon), else a glyph derived the same way tabs do (tabIcon) so every square is
  // legible in the collapsed rail. The synthetic "All" row (ctx null) always gets ≡.
  const iconEl = document.createElement('span');
  iconEl.className = 'context-row-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  if (ctx?.iconImage) {
    // Render the image via <img> only (never inline the SVG markup), so a crafted SVG
    // can't script in our origin. On load failure, fall back to the derived glyph.
    iconEl.classList.add('is-image');
    const img = document.createElement('img');
    img.src = '/api/contexts/' + encodeURIComponent(ctx.id) + '/icon';
    img.alt = '';
    img.decoding = 'async';
    img.onerror = () => {
      iconEl.classList.remove('is-image');
      const fb = tabIcon(name);
      iconEl.textContent = fb.glyph;
      iconEl.classList.toggle('is-emoji', fb.isEmoji);
    };
    iconEl.appendChild(img);
  } else {
    const resolved = ctx?.icon
      ? { glyph: ctx.icon, isEmoji: isEmojiGlyph(ctx.icon) }
      : (ctx ? tabIcon(name) : { glyph: '≡', isEmoji: false });
    iconEl.textContent = resolved.glyph;
    iconEl.classList.toggle('is-emoji', resolved.isEmoji);
  }
  row.appendChild(iconEl);

  const label = document.createElement('span');
  label.className = 'context-row-label';
  label.textContent = name;
  row.appendChild(label);

  const n = contextTabCount(ctx);
  if (n > 0) {
    const count = document.createElement('span');
    count.className = 'context-row-count';
    count.textContent = n;
    count.title = n + (n === 1 ? ' tab' : ' tabs');
    row.appendChild(count);
  }

  if (ctx) {
    // Real contexts: Edit/Delete via right-click menu (keeps the row to just
    // name + badge so everything aligns), and drag-to-reorder. Click selects.
    // A data attribute both marks the row draggable and identifies it in the
    // reorder/drag logic. The "All" row (ctx null) gets no data attribute, so it
    // stays pinned at the top and non-draggable.
    row.dataset.contextId = ctx.id;
    row.title = 'Right-click to edit · drag to reorder';
    wireRowDrag(row, ctx);
  } else {
    row.onclick = () => selectContext(id);
    row.title = 'Right-click to add a context';
  }
  // Every row answers right-click with OUR menu, "All" included (#548). "All" is
  // a synthetic view — no id, no dirs — so its menu offers New context instead of
  // Edit/Delete. It still looks like a context row (same class, same list, right
  // above real ones) and the rail hint advertises right-click, so falling through
  // to the browser's native menu here read as a bug. showRowMenu picks the items.
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showRowMenu(e.clientX, e.clientY, ctx);
  });
  return row;
}

// -------------------------------------------------------- row right-click menu

let rowMenu = null;
function hideRowMenu() {
  if (rowMenu) { rowMenu.remove(); rowMenu = null; }
  document.removeEventListener('mousedown', onRowMenuDocMouseDown, true);
  document.removeEventListener('keydown', onRowMenuKey, true);
}
function onRowMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); hideRowMenu(); }
}
// Close on any press outside the menu. Kept as a stable reference (not a
// self-removing one-shot) so it survives an inside-menu press that isn't on an
// item — the listener stays until the menu is actually hidden, so a later
// outside press still dismisses it.
//
// Must be 'mousedown', NOT 'click' (#546): rows select on mouseup (wireRowDrag's
// onUp → selectContext → applyFilter → renderRail), and renderRail wipes the rail
// with innerHTML = ''. That detaches the pressed row mid-gesture, so the click the
// browser dispatches afterwards has a propagation path of just the orphaned
// row/list subtree — document isn't in it, and a click listener here never fires.
// mousedown lands before the re-render, while the row is still attached.
function onRowMenuDocMouseDown(e) {
  if (rowMenu && !rowMenu.contains(e.target)) hideRowMenu();
}
function addRowMenuItem(menu, label, onPick, color) {
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  item.textContent = label;
  if (color) item.style.color = color;
  item.onclick = () => { hideRowMenu(); onPick(); };
  menu.appendChild(item);
  return item;
}

// ctx null = the "All" row, which has nothing to edit or delete — it gets the one
// action that makes sense there, reusing the same call as the rail's "+ New
// context" button (#548).
function showRowMenu(x, y, ctx) {
  hideRowMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu context-row-menu';

  if (ctx) {
    addRowMenuItem(menu, 'Edit', () => openContextEditor(ctx));
    // Set icon: emoji or an uploaded PNG/SVG image (#569/#579). Right-click (not
    // double-click-the-square) so it works at any rail width and reuses this menu's
    // dismissal machinery. The picker offers both an emoji grid and a "Choose image…"
    // button; they're mutually exclusive, so one "Clear icon" removes whichever is set.
    const hasIcon = ctx.icon || ctx.iconImage;
    addRowMenuItem(menu, hasIcon ? 'Change icon…' : 'Set icon…', () => showIconPicker(x, y, ctx));
    if (hasIcon) addRowMenuItem(menu, 'Clear icon', () => clearContextIcon(ctx));
    addRowMenuItem(menu, 'Delete', () => {
      if (confirm(`Delete context "${ctx.name}"?`)) deleteContext(ctx);
    }, 'var(--ds-accent-red)');
  } else {
    addRowMenuItem(menu, 'New context', () => openContextEditor(null));
  }

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Nudge back on-screen if it would overflow (mirror tab-manager positioning).
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  rowMenu = menu;
  // Dismiss on any outside press (deferred so this menu's own opening
  // right-click doesn't immediately close it) and on Escape. The guard keeps a
  // stale queued timeout from re-registering for a menu that's already replaced.
  setTimeout(() => {
    if (rowMenu === menu) document.addEventListener('mousedown', onRowMenuDocMouseDown, true);
  }, 0);
  document.addEventListener('keydown', onRowMenuKey, true);
}

// -------------------------------------------------------------- context icons (#569)

// Icon = server-side per-context state (rides contexts.json like name/dirs). Set via
// the row right-click menu → showIconPicker. A chosen icon shows in the rail square
// AND next to the name in the expanded panel; cleared, the square falls back to a
// derived glyph (tabIcon). Match tabIcon's own emoji test so isEmoji styling agrees.
function isEmojiGlyph(g) {
  try { return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g || ''); }
  catch { return false; }
}
// First grapheme, not first code point — keep ZWJ sequences / flags intact (as tabIcon does).
function firstGrapheme(s) {
  try {
    const [first] = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)];
    return first?.segment ?? '';
  } catch { return [...(s || '')][0] || ''; }
}

// Optimistic local set + server persist. contexts holds the live object makeRow was
// given, so mutating ctx.icon updates the rail immediately; the server broadcast
// (setContexts) reconciles this and every other window. Send the FULL object — the
// POST handler requires name. Setting an emoji drops any uploaded image (they're
// mutually exclusive, #579); the server does the same, deleting the file.
function setContextIcon(ctx, raw) {
  if (!ctx) return;
  const value = firstGrapheme(String(raw || '').trim());
  ctx.icon = value;
  if (value) ctx.iconImage = '';
  saveContext({ id: ctx.id, name: ctx.name, dirs: ctx.dirs, icon: value });
  renderRail();
}

// Clear a context's icon entirely (emoji AND uploaded image) → the rail falls back to
// the derived glyph. Optimistic; the DELETE also removes any stored file server-side.
function clearContextIcon(ctx) {
  if (!ctx) return;
  ctx.icon = '';
  ctx.iconImage = '';
  fetch('/api/contexts/' + encodeURIComponent(ctx.id) + '/icon', { method: 'DELETE' }).catch(() => {});
  renderRail();
}

const MAX_ICON_BYTES = 2 * 1024 * 1024; // matches the server's express.raw limit

// Upload a chosen PNG/SVG as the context's icon (#579). Validates format/size locally
// (the server re-checks the bytes), PUTs the raw file, and on success updates optimistically
// — image wins over emoji. The server broadcast reconciles every other window.
function chooseContextImage(ctx, file) {
  if (!ctx || !file) return;
  const name = (file.name || '').toLowerCase();
  const ext = file.type === 'image/png' || name.endsWith('.png') ? 'png'
    : (file.type === 'image/svg+xml' || name.endsWith('.svg') ? 'svg' : '');
  if (!ext) { alert('Please choose a PNG or SVG image.'); return; }
  if (file.size > MAX_ICON_BYTES) { alert('Image is too large (max 2 MB).'); return; }
  fetch('/api/contexts/' + encodeURIComponent(ctx.id) + '/icon?ext=' + ext, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
    .then(r => {
      if (!r.ok) { alert('Could not set the image icon.'); return; }
      ctx.iconImage = ext;
      ctx.icon = '';
      renderRail();
    })
    .catch(() => { alert('Could not set the image icon.'); });
}

const ICON_PRESETS = ['🚀','🐛','⚙️','📦','🧪','🌐','🎨','🔧','📊','💡','🔥','⭐','🧠','📝','🗂️','🤖'];

// Small popover anchored where the right-click menu was, reusing the row-menu
// dismissal (mousedown-outside via onRowMenuDocMouseDown, Escape via onRowMenuKey,
// and the rowMenu handle so hideRowMenu tears it down). #546's mousedown-not-click
// dismissal already accounts for renderRail() wiping the DOM mid-gesture.
function showIconPicker(x, y, ctx) {
  hideRowMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu context-icon-picker';

  const grid = document.createElement('div');
  grid.className = 'context-icon-grid';
  for (const emoji of ICON_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'context-icon-choice' + (ctx.icon === emoji ? ' selected' : '');
    b.textContent = emoji;
    b.onclick = () => { hideRowMenu(); setContextIcon(ctx, emoji); };
    grid.appendChild(b);
  }
  menu.appendChild(grid);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'context-icon-input';
  input.placeholder = 'Type or paste an emoji';
  input.value = ctx.icon || '';
  input.maxLength = 8; // room for a multi-codepoint grapheme (ZWJ / flags)
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); hideRowMenu(); setContextIcon(ctx, input.value); }
  };
  menu.appendChild(input);

  // Choose image… (#579): a native file picker for a PNG/SVG, uploaded to the server and
  // rendered as the real icon (mutually exclusive with the emoji above). The hidden input
  // is scoped to the picker so it's torn down with it.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.png,.svg,image/png,image/svg+xml';
  fileInput.style.display = 'none';
  fileInput.onchange = () => {
    const file = fileInput.files && fileInput.files[0];
    hideRowMenu();
    if (file) chooseContextImage(ctx, file);
  };
  const chooseImg = document.createElement('button');
  chooseImg.type = 'button';
  chooseImg.className = 'context-icon-image-btn';
  chooseImg.textContent = 'Choose image (PNG/SVG)…';
  chooseImg.onclick = () => fileInput.click();
  menu.appendChild(chooseImg);
  menu.appendChild(fileInput);

  const actions = document.createElement('div');
  actions.className = 'context-icon-actions';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'context-icon-apply';
  apply.textContent = 'Set';
  apply.onclick = () => { hideRowMenu(); setContextIcon(ctx, input.value); };
  actions.appendChild(apply);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'context-icon-clear';
  clear.textContent = 'Clear';
  clear.onclick = () => { hideRowMenu(); clearContextIcon(ctx); };
  actions.appendChild(clear);
  menu.appendChild(actions);

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Nudge back on-screen (mirror showRowMenu).
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  rowMenu = menu;
  setTimeout(() => {
    if (rowMenu === menu) document.addEventListener('mousedown', onRowMenuDocMouseDown, true);
  }, 0);
  document.addEventListener('keydown', onRowMenuKey, true);
  input.focus();
  input.select();
}

// ------------------------------------------------------- row drag-to-reorder

// Vertical drag adapted from tab-manager.js: start only after the pointer moves
// past a small threshold (so a plain click still selects); reorder the real DOM
// rows live; persist the new order on release. Only rows carrying
// data-contextId participate, so the "All" row can never be displaced.
const ROW_MOVE_THRESHOLD = 5;
let rowDrag = null; // { row } while a drag is in progress

function wireRowDrag(row, ctx) {
  const onPointerDown = (e) => {
    if (e.button && e.button !== 0) return; // left button / touch only
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    const startY = e.touches ? e.touches[0].clientY : e.clientY;
    let dragging = false;

    const onMove = (me) => {
      const cx = me.touches ? me.touches[0].clientX : me.clientX;
      const cy = me.touches ? me.touches[0].clientY : me.clientY;
      if (!dragging && (Math.abs(cx - startX) > ROW_MOVE_THRESHOLD || Math.abs(cy - startY) > ROW_MOVE_THRESHOLD)) {
        dragging = true;
        startRowDrag(row);
      }
    };
    const onUp = () => {
      cleanup();
      if (!dragging) selectContext(ctx.id); // no drag → treat as a click
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
  };

  row.addEventListener('mousedown', onPointerDown);
  row.addEventListener('touchstart', onPointerDown, { passive: true });
}

function startRowDrag(row) {
  rowDrag = { row };
  row.classList.add('dragging');
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onRowDragMove);
  document.addEventListener('touchmove', onRowDragMove, { passive: false });
  document.addEventListener('mouseup', endRowDrag);
  document.addEventListener('touchend', endRowDrag);
  document.addEventListener('visibilitychange', endRowDrag);
}

function onRowDragMove(e) {
  if (!rowDrag) return;
  e.preventDefault();
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const list = rowDrag.row.parentNode;
  if (!list) return;
  const rows = [...list.querySelectorAll('.context-row')].filter(r => r.dataset.contextId);
  for (const other of rows) {
    if (other === rowDrag.row) continue;
    const rect = other.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      list.insertBefore(rowDrag.row, other);
      return;
    }
  }
  list.appendChild(rowDrag.row); // past all rows → move to end
}

function endRowDrag() {
  if (!rowDrag) return;
  const { row } = rowDrag;
  rowDrag = null;
  row.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onRowDragMove);
  document.removeEventListener('touchmove', onRowDragMove);
  document.removeEventListener('mouseup', endRowDrag);
  document.removeEventListener('touchend', endRowDrag);
  document.removeEventListener('visibilitychange', endRowDrag);

  const list = row.parentNode;
  if (!list) return;
  const order = [...list.querySelectorAll('.context-row')].map(r => r.dataset.contextId).filter(Boolean);
  // Optimistic local reorder so the rail is stable immediately; the server
  // broadcast (setContexts) reconciles this and every other window.
  const byId = new Map(contexts.map(c => [c.id, c]));
  contexts = order.map(id => byId.get(id)).filter(Boolean);
  persistOrder(order);
  renderRail(); // rebuild rows with fresh handlers / cleared drag state
}

function selectContext(id) {
  activeContextId = id;
  saveActive();
  notifyActive();
  applyFilter();
}

// Called by app.js's switchTo() on every tab activation: remember the tab as the
// active context's last-viewed tab so switching back restores it (#541). The
// "All" view needs no memory (nothing is hidden there). An out-of-context
// activation (e.g. the close-fallback picking a context-hidden neighbor before
// applyFilter corrects it) must not clobber the memory.
export function noteActiveTab(tabId) {
  if (!enabled || !tabId) return;
  const ctx = getActiveContext();
  if (!ctx) return;
  if (!tabInContext(cb.getTabCwd?.(tabId), ctx)) return;
  if (lastTabByContext[ctx.id] === tabId) return;
  lastTabByContext[ctx.id] = tabId;
  saveLastTabs();
}

// Auto-switch the view to a newly created tab's context (#547). Called by
// app.js right after a non-restore tab creation activates the new tab
// (switchTo already ran, so the tab is active and its cwd is in the sessions
// map). Only acts when a real (non-All) context is filtering and the new tab
// is NOT in it: jump to the first context (rail order) whose dirs contain the
// tab's cwd, else to "All" — so a tab is never hidden the instant it's
// created. No-ops for global tabs (no cwd → tabInContext true), the All view,
// restores/background tabs (not called), and before context definitions load
// (getActiveContext() → null).
export function revealTabContext(tabId) {
  if (!enabled) return;
  const ctx = getActiveContext();
  if (!ctx) return;
  const cwd = cb.getTabCwd?.(tabId);
  if (tabInContext(cwd, ctx)) return;
  const match = contexts.find(c => tabInContext(cwd, c));
  selectContext(match ? match.id : null);
  noteActiveTab(tabId);                        // record as destination's last tab (#541); self-no-ops for All
  showToast(match ? match.name : 'All tabs');  // explain the jump (mirrors cycleContext)
}

// Tell app.js (→ the scheduled-tasks panel) which context is active. Half of the
// bidirectional sync; the other half is setActiveContext(), called when the panel
// picks a group.
function notifyActive() {
  cb.onActiveContextChanged?.(activeContextId);
}

// -------------------------------------------------------------------- sidebar

function setSidebar(open) {
  sidebarOpen = open;
  saveSidebar();
  if (rail) rail.style.display = open ? 'flex' : 'none';
  if (resizer) resizer.style.display = open ? 'block' : 'none';
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', open);
    toggleBtn.title = open ? 'Hide contexts (⌘P)' : 'Show contexts (⌘P)';
  }
  if (open) {
    renderRail();
    applyRailWidth(loadWidth()); // restore the dragged width (null → CSS/theme default)
  }
  updateIndicator();
  window.dispatchEvent(new Event('resize'));
}

function toggleSidebar() {
  setSidebar(!sidebarOpen);
  document.activeElement?.blur();
}

// ------------------------------------------------------- resize / collapse (#569)
//
// The rail is freely resizable by dragging #context-resizer, and collapses to a
// compact icon rail at its floor — the same behaviour the vertical tab bar got in
// #552, so the two rails read as one system. Modelled on setupResizer() in
// layout-manager.js. Both rails share ONE floor number: --ds-rail-width on
// #app-container (CSS owns it; we read it back rather than keep a copy).

let railWidthPx = 0;      // last width we applied, saved on mouseup / auto-fit
let measureCanvas = null; // reused offscreen canvas for auto-fit text measurement

function contextRailFloor() {
  const el = document.getElementById('app-container');
  const v = el ? parseFloat(getComputedStyle(el).getPropertyValue('--ds-rail-width')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 48;
}

// Apply an explicit width (px) or, when null, clear the inline width so the CSS
// default (--ds-context-width, theme-overridable) governs again. Either way the
// collapsed class is derived from the resulting width so the icon rail turns on at
// the floor. Only meaningful while the rail is visible (getBoundingClientRect is 0
// when display:none), so callers apply it after opening the rail.
function applyRailWidth(px) {
  if (!rail) return;
  const floor = contextRailFloor();
  if (px == null) {
    rail.style.width = '';
    railWidthPx = rail.getBoundingClientRect().width;
  } else {
    railWidthPx = px;
    rail.style.width = px + 'px';
  }
  rail.classList.toggle('collapsed', railWidthPx <= floor);
}

function setupContextResizer() {
  if (!resizer || !rail) return;
  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    if (e.button && e.button !== 0) return;
    dragging = true;
    railWidthPx = rail.getBoundingClientRect().width; // so a click without a drag saves the current width
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const floor = contextRailFloor();
    // Measure from the rail's OWN left edge, not the viewport — body padding and
    // the retro-monitor gap sit to its left and would otherwise offset the drag.
    let w = e.clientX - rail.getBoundingClientRect().left;
    if (w < floor * 2) w = floor;               // snap shut to the icon rail (like #552)
    w = Math.min(w, window.innerWidth * 0.5);   // max 50% of the viewport
    railWidthPx = w;
    rail.style.width = w + 'px';
    rail.classList.toggle('collapsed', w <= floor);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveWidth(railWidthPx);
    window.dispatchEvent(new Event('resize')); // refit terminals once, on release (not per-move)
  });

  // Double-click the handle → auto-fit to content, à la a spreadsheet column (#569).
  resizer.addEventListener('dblclick', autoSizeRail);
}

// Size the rail to its widest content: the longest context name plus the fixed
// chrome ("+ New context", header) and a per-row allowance, clamped to the floor
// and half the viewport. Excludes the multi-line .context-hint, which wraps by
// design. There is no existing text-measurement helper, so measure with a canvas.
function autoSizeRail() {
  if (!rail) return;
  const floor = contextRailFloor();
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const g = measureCanvas.getContext('2d');
  // Build the font from individual props — getComputedStyle(...).font returns '' in
  // Firefox for the shorthand. Read it off a real label so it tracks the theme.
  const labelEl = rail.querySelector('.context-row-label');
  if (labelEl) {
    const cs = getComputedStyle(labelEl);
    g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  } else {
    g.font = '13px system-ui';
  }
  let textW = 0;
  for (const s of ['Contexts', '+ New context', 'All', ...contexts.map(c => c.name)]) {
    textW = Math.max(textW, g.measureText(s || '').width);
  }
  // Allowance: row padding (12+12) + active border (3) + icon chip + gap + a
  // worst-case count badge + slack. Tuned by eye; auto-fit needn't be exact.
  let w = textW + 95;
  w = Math.max(floor, Math.min(w, window.innerWidth * 0.5));
  railWidthPx = w;
  rail.style.width = w + 'px';
  rail.classList.remove('collapsed'); // auto-fit always lands above the floor
  saveWidth(w);
  window.dispatchEvent(new Event('resize'));
}

// ---------------------------------------------------------------------- toast

let toastEl = null;
let toastTimer = null;
// Exported: app.js reuses it for one-line feedback (e.g. "No sessions to
// restore", #560) — it's the only generic toast in the frontend.
export function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'context-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('visible'), 1300);
}

// ------------------------------------------------------------------- keyboard

function cycleContext(dir) {
  const order = [null, ...contexts.map(c => c.id)];
  if (order.length <= 1) return;
  const idx = order.indexOf(activeContextId);
  const next = dir > 0
    ? (idx >= order.length - 1 ? 0 : idx + 1)
    : (idx <= 0 ? order.length - 1 : idx - 1);
  activeContextId = order[next];
  saveActive();
  notifyActive();
  applyFilter();
  showToast(activeContextId ? (getActiveContext()?.name || 'Context') : 'All tabs');
}

// True for real form fields where Cmd+P / Cmd+Arrow should stay native. The
// terminal's own xterm-helper-textarea is deliberately excluded so shortcuts
// still work while a terminal is focused.
function isFormField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return true;
  if (tag === 'TEXTAREA') return !el.classList.contains('xterm-helper-textarea');
  return !!el.isContentEditable;
}

// Cmd+P is matcher-backed; the chord and the cycle keys are doc-only because the
// registry can't express "armed by a preceding key" or "two keys, one description".
// All three live here so they get edited alongside onKeyDown right below.
const matchesPanelToggle = register({
  id: 'context-panel',
  group: 'Views',
  description: 'Toggle the context panel',
  shortcut: 'Meta+p',
  match: 'code', // e.code === 'KeyP' — pinned to the physical key, layout-independent
  isEnabled: () => enabled,
});

registerInfo({
  id: 'context-all',
  group: 'Views',
  description: 'Jump to the All view (Cmd held the whole time)',
  keys: ['⌘P', '⌘A'],
  combine: 'then',
  isEnabled: () => enabled,
});

registerInfo({
  id: 'context-cycle',
  group: 'Views',
  description: 'Cycle through All + your contexts',
  keys: ['⌘↑', '⌘↓'],
  isEnabled: () => enabled,
});

function onKeyDown(e) {
  if (!enabled || !e.metaKey) return;
  if (isFormField(e.target)) return;

  // Cmd+P — toggle the context panel. We swallow the event (preventDefault) so
  // the browser's Print dialog never opens. Unlike the old Cmd+C binding, this
  // needs no copy special-casing since Cmd+P doesn't collide with terminal copy.
  // Also arms the Cmd+P→A chord until Cmd is released (see onKeyUp).
  if (matchesPanelToggle(e)) {
    e.preventDefault();
    e.stopPropagation();
    cmdChordArmed = true;
    toggleSidebar();
    return;
  }

  // Cmd+P then A (Cmd held) — jump to the "All" view. Only fires while the chord
  // is armed by a preceding Cmd+P, so a bare Cmd+A stays native (select-all).
  if (e.code === 'KeyA' && cmdChordArmed && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!sidebarOpen) setSidebar(true);
    selectContext(null);
    showToast('All tabs');
    return;
  }

  // Cmd+Up / Cmd+Down — cycle through [All, ...contexts].
  if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (contexts.length === 0) return; // nothing to cycle; leave native behavior
    e.preventDefault();
    e.stopPropagation();
    cycleContext(e.code === 'ArrowDown' ? 1 : -1);
  }
}

// Releasing Cmd closes the Cmd+P→A chord window.
function onKeyUp(e) {
  if (e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight') cmdChordArmed = false;
}

// ------------------------------------------------------ new tab in a context

/**
 * Called by app.js's new-tab flow. Returns true when it has taken ownership of
 * the new tab — either opening it in the active context or prompting for a dir —
 * so quickNewSession must NOT fall through. Returns false only when the default
 * inherit-the-active-tab's-cwd flow is safe: the "All" view, or an active tab
 * that's already inside the active context.
 *
 * The subtle case is a context with NO dirs configured (#581): when it's empty
 * of tabs, activeId still points at a context-hidden tab from ANOTHER context,
 * so inheriting active.cwd would open there and #547 would yank the view away.
 * We must own that case too — prompt a directory picker instead of leaking.
 */
export function requestNewTabInContext() {
  if (!enabled) return false;
  const ctx = getActiveContext();
  if (!ctx) return false;                                      // "All" view → inherit is fine
  const activeCwd = cb.getTabCwd?.(cb.getActiveTabId?.());
  if (activeCwd && tabInContext(activeCwd, ctx)) return false; // active tab already in-context → inherit stays in-context
  if (ctx.dirs.length > 0) {
    newTabInActiveContext(ctx);          // single → open in the repo; multiple → chooser (#522)
  } else {
    cb.promptNewTabDir?.();              // empty context, no inferable repo → directory picker (#581)
  }
  return true;                           // handled — never let quickNewSession inherit a foreign cwd
}

async function newTabInActiveContext(ctx) {
  ctx = ctx || getActiveContext();
  if (!ctx || ctx.dirs.length === 0) return;
  let dir = ctx.dirs[0];
  if (ctx.dirs.length > 1) {
    dir = await chooseDir(ctx.dirs);
    if (!dir) return;
  }
  cb.createSessionInDir?.(dir);
}

function chooseDir(dirs) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal context-dir-chooser';
    const h = document.createElement('h2');
    h.textContent = 'Open new tab in…';
    modal.appendChild(h);
    for (const d of dirs) {
      const b = document.createElement('button');
      b.className = 'btn-secondary context-choose-dir';
      b.textContent = d;
      b.title = d;
      b.onclick = () => { overlay.remove(); resolve(d); };
      modal.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { overlay.remove(); resolve(null); };
    modal.appendChild(cancel);
    overlay.appendChild(modal);
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
    document.body.appendChild(overlay);
  });
}

// ------------------------------------------------------------- context editor

function openContextEditor(ctx) {
  const isNew = !ctx;
  const draft = {
    id: ctx?.id || genId(),
    name: ctx?.name || '',
    dirs: ctx ? [...ctx.dirs] : [],
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal context-editor';
  overlay.appendChild(modal);

  const h = document.createElement('h2');
  h.textContent = isNew ? 'New context' : 'Edit context';
  modal.appendChild(h);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Context name';
  nameInput.value = draft.name;
  nameInput.className = 'context-name-input';
  modal.appendChild(nameInput);

  const dirsWrap = document.createElement('div');
  dirsWrap.className = 'context-dirs';
  modal.appendChild(dirsWrap);

  const addWrap = document.createElement('div');
  addWrap.className = 'context-add-dir';
  modal.appendChild(addWrap);

  function renderDirs() {
    dirsWrap.innerHTML = '';
    if (draft.dirs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'context-dirs-empty';
      empty.textContent = 'No folders yet — add a repo below.';
      dirsWrap.appendChild(empty);
    }
    for (const d of draft.dirs) {
      const row = document.createElement('div');
      row.className = 'context-dir-row';
      const path = document.createElement('span');
      path.className = 'context-dir-path';
      path.textContent = d;
      path.title = d;
      row.appendChild(path);
      const rm = document.createElement('button');
      rm.className = 'context-dir-remove';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.onclick = () => { draft.dirs = draft.dirs.filter(x => x !== d); renderDirs(); };
      row.appendChild(rm);
      dirsWrap.appendChild(row);
    }
    renderAddControls();
  }

  function renderAddControls() {
    addWrap.innerHTML = '';
    const recents = (cb.getRecentDirs?.() || [])
      .map(r => r && r.path).filter(Boolean)
      .filter(p => !draft.dirs.includes(p));
    if (recents.length) {
      const sel = document.createElement('select');
      sel.className = 'context-recent-select';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Add recent folder…';
      sel.appendChild(def);
      for (const p of recents) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        if (sel.value && !draft.dirs.includes(sel.value)) {
          draft.dirs.push(sel.value);
          renderDirs();
        }
      };
      addWrap.appendChild(sel);
    }
    const browse = document.createElement('button');
    browse.className = 'btn-secondary';
    browse.textContent = 'Browse…';
    browse.onclick = async () => {
      const dir = await cb.showDirPicker?.();
      if (dir && typeof dir === 'string' && !draft.dirs.includes(dir)) {
        draft.dirs.push(dir);
        renderDirs();
      }
    };
    addWrap.appendChild(browse);
  }

  renderDirs();

  const btns = document.createElement('div');
  btns.className = 'modal-buttons';

  if (!isNew) {
    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      deleteContext(draft);
      overlay.remove();
    };
    btns.appendChild(del);
  }

  const cancel = document.createElement('button');
  cancel.className = 'btn-secondary';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => overlay.remove();
  btns.appendChild(cancel);

  const save = document.createElement('button');
  save.className = 'btn-primary';
  save.textContent = 'Save';
  save.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    // Optimistic local upsert so the rail updates immediately; the server
    // broadcast (setContexts) reconciles this and every other window.
    const existing = contexts.find(c => c.id === draft.id);
    if (existing) {
      existing.name = name;
      existing.dirs = draft.dirs;
    } else {
      contexts.push({ id: draft.id, name, dirs: draft.dirs });
    }
    saveContext({ id: draft.id, name, dirs: draft.dirs });
    activeContextId = draft.id; // focus the context we just saved
    saveActive();
    notifyActive();
    overlay.remove();
    applyFilter();
  };
  btns.appendChild(save);
  modal.appendChild(btns);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') save.click();
    else if (e.key === 'Escape') overlay.remove();
  };
  document.body.appendChild(overlay);
  nameInput.focus();
}

// ------------------------------------------------------------------ lifecycle

export function init(callbacks) {
  cb = callbacks || {};
  contexts = [];                    // seeded from the server by fetchContexts() below
  activeContextId = loadActive();   // restored per-window; validated once contexts arrive
  sidebarOpen = loadSidebar();
  lastTabByContext = loadLastTabs(); // stale tab ids are validated at restore time (#541)

  toggleBtn = document.getElementById('context-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleSidebar);
    // Muted active-context label injected right after the toggle (like the rail
    // itself, it's created here rather than hard-coded in index.html). Clicking
    // it opens the rail — it's only ever visible while the rail is closed.
    indicatorEl = document.createElement('span');
    indicatorEl.id = 'context-indicator';
    indicatorEl.className = 'hidden';
    indicatorEl.addEventListener('click', () => {
      setSidebar(true);
      document.activeElement?.blur();
    });
    toggleBtn.insertAdjacentElement('afterend', indicatorEl);
  }

  // Mount the rail as the left-most child of #app-container so it spans the full
  // height to the LEFT of everything (tab strip + terminal), not tucked under the
  // tabs. #app-main wraps the tabs + content column; the rail sits before it.
  rail = document.createElement('div');
  rail.id = 'context-rail';
  const appContainer = document.getElementById('app-container');
  const appMain = document.getElementById('app-main');
  if (appContainer && appMain) appContainer.insertBefore(rail, appMain);
  else if (appContainer) appContainer.insertBefore(rail, appContainer.firstChild);

  // Drag handle at the rail's right edge (#569). A SIBLING of the rail, never a
  // child — renderRail() does rail.innerHTML='' on every render and would wipe an
  // in-rail handle. Sits [#context-rail | #context-resizer | #app-main], mirroring
  // the vertical-tabs [#tabs | #sidebar-resizer | #terminals] arrangement. Its
  // visibility follows the rail's open state (toggled in setSidebar), so it shows
  // in both layouts whenever the rail is open.
  resizer = document.createElement('div');
  resizer.id = 'context-resizer';
  resizer.title = 'Drag to resize · double-click to auto-fit';
  if (appContainer && appMain) appContainer.insertBefore(resizer, appMain);
  else if (appContainer && rail.nextSibling) appContainer.insertBefore(resizer, rail.nextSibling);
  else if (appContainer) appContainer.appendChild(resizer);
  setupContextResizer();

  // Closed-context label variant for the retro-monitor CRT theme (#535). It is
  // display:none in every theme by default; the retro-monitor theme reveals it and
  // insets it into the monitor's top frame line (like a fieldset legend), hiding the
  // tab-strip #context-indicator instead. Mounted as a child of #app-container (not
  // #app-main, whose overflow:clip would crop a label straddling its top bezel edge)
  // so it can sit on the frame line. Kept in sync by updateIndicator(); clicking it
  // opens the rail like the indicator.
  if (appContainer) {
    ruleTitleEl = document.createElement('div');
    ruleTitleEl.id = 'context-rule-title';
    ruleTitleEl.className = 'hidden';
    ruleTitleEl.addEventListener('click', () => {
      setSidebar(true);
      document.activeElement?.blur();
    });
    appContainer.insertBefore(ruleTitleEl, appContainer.firstChild);
  }

  setSidebar(sidebarOpen);
  applyFilter();

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  fetchContexts(); // seed definitions from the server (single source of truth)
}

// Called by app.js when the server pushes the full context list (initial load +
// every 'contexts' broadcast). Re-validates the active id and re-filters.
export function setContexts(list) {
  contexts = Array.isArray(list) ? list : [];
  if (activeContextId && !contexts.find(c => c.id === activeContextId)) {
    activeContextId = null;
    saveActive();
    notifyActive();
  }
  // Drop last-tab memory for contexts that no longer exist (#541).
  let pruned = false;
  for (const id of Object.keys(lastTabByContext)) {
    if (!contexts.find(c => c.id === id)) { delete lastTabByContext[id]; pruned = true; }
  }
  if (pruned) saveLastTabs();
  applyFilter();
}

// Bidirectional-in: the scheduled-tasks panel picked a group → make it active
// here too. Guards against a no-op / feedback loop and ignores unknown ids.
export function setActiveContext(id) {
  const next = id || null;
  if (next === activeContextId) return;
  if (next && !contexts.find(c => c.id === next)) return;
  activeContextId = next;
  saveActive();
  notifyActive();
  applyFilter();
}

export function getActiveContextId() {
  return activeContextId;
}

// Read-only snapshot of the active context for the new-tab flow (#573): its name
// (for the menu header) and a copy of its dirs (stored order, for ordering), or
// null when the view is "All" OR the feature is disabled — so callers behave
// exactly as before the change in both cases.
export function getActiveContextInfo() {
  if (!enabled) return null;
  const c = getActiveContext();
  return c ? { name: c.name, dirs: [...c.dirs] } : null;
}

export function setEnabled(val) {
  enabled = !!val;
  if (toggleBtn) toggleBtn.style.display = enabled ? '' : 'none';
  if (!enabled) {
    setSidebar(false);
    // Un-hide any filtered tabs so disabling the feature reveals everything.
    document.querySelectorAll('.tab.context-hidden').forEach(t => t.classList.remove('context-hidden'));
    cb.updateEmptyState?.(); // recompute (activeContextIsEmpty now returns false)
  } else {
    applyFilter();
  }
}
