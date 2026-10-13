/**
 * The tab slot — a reserved place at the head of a project's tab strip for the one tab that
 * holds a role there. `orchestrator` is the only role so far: the agent that oversees the
 * project. An additive project view switches it on with `"slot": "orchestrator"`
 * (project-views.js answers slotFor()), so it is a push button in the views bar like any other.
 *
 * Empty, the slot is a dashed outline before the first tab — above it in vertical layout, left
 * of it in horizontal — and its right-click menu opens the holder. The server starts it
 * (POST /api/project-views/slot), one per project whichever window asks, and its tab arrives
 * like any tab an agent opens. Filled, the dashed outline goes away and the holder's own tab
 * takes its place: pinned first in #tabs-list and marked .slot-tab. It stays an ordinary tab
 * there, with the ordinary tab menu. The slot only gives it its place.
 *
 * The holder's tab stays inside #tabs-list rather than moving into a container of its own,
 * because every walk of the strip (navigation, the context filter, the session stores' order,
 * timelapse) reads `#tabs-list .tab`, and a tab outside it would drop out of all of them.
 *
 * Like view-footer.js this never imports project-views.js or context-views.js; app.js
 * injects what it needs. render() is called from the end of every filter pass and never asks
 * for one, so the re-entrancy rule project-views.js documents holds here too.
 */

const LABELS = { orchestrator: 'Orchestrator' };
const label = (role) => LABELS[role] || role;

let cb = {};
let slotEl = null;
let marked = null;     // the tab last given .slot-tab, so a change of holder can take it back
let opening = false;   // an open in flight, so a double right-click can't start a second

function ensureSlot() {
  if (slotEl && slotEl.isConnected) return slotEl;
  const wrapper = document.getElementById('tabs-list-wrapper');
  const list = document.getElementById('tabs-list');
  if (!wrapper || !list) return null;
  slotEl = document.createElement('div');
  slotEl.id = 'tab-slot';
  slotEl.className = 'tab-slot hidden';
  const icon = document.createElement('span');
  icon.className = 'tab-slot-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '◆';
  const text = document.createElement('span');
  text.className = 'tab-slot-label';
  slotEl.append(icon, text);
  slotEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const role = slotEl.dataset.role;
    if (role) showSlotMenu(e.clientX, e.clientY, role);
  });
  wrapper.insertBefore(slotEl, list);
  return slotEl;
}

/**
 * Redraw the slot and pin its holder. DOM only. Shown while the active project's slot is on
 * and nothing in this window holds it.
 */
export function render() {
  const el = ensureSlot();
  const ctx = cb.getActiveContext?.() || null;
  const role = ctx ? cb.slotFor?.(ctx) || null : null;
  const holder = role ? cb.holderFor?.(ctx, role) || null : null;

  if (marked && marked !== holder) cb.getTabEl?.(marked)?.classList.remove('slot-tab');
  marked = holder;
  if (holder) {
    cb.pinFirst?.(holder);
    cb.getTabEl?.(holder)?.classList.add('slot-tab');
  }

  if (!el) return;
  el.classList.toggle('hidden', !role || !!holder);
  el.dataset.role = role || '';
  if (role) {
    el.title = `${label(role)} — right-click to open one for this project`;
    el.children[1].textContent = label(role);
  }
}

/**
 * Ask the server for the holder. A new one opens as an open-session, like any tab an agent
 * starts. One that already runs is focused here, or named as open in another window.
 */
export async function openHolder(role) {
  const ctx = cb.getActiveContext?.() || null;
  if (!ctx || opening) return;
  opening = true;
  let data;
  try {
    const res = await fetch('/api/project-views/slot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextId: ctx.id, slot: role, windowId: cb.getWindowId?.() || null }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    cb.showToast?.(`Could not open the ${label(role).toLowerCase()}: ${e.message}`);
    return;
  } finally {
    opening = false;
  }
  if (!data.existing) return;
  if (cb.hasTab?.(data.id)) cb.focusTab?.(data.id);
  else if (data.windowId && data.windowId !== cb.getWindowId?.()) cb.showToast?.(`This project's ${label(role).toLowerCase()} is open in another window`);
}

// ------------------------------------------------------------------ the menu
// The generic .context-menu classes, dismissed on mousedown like the view button's menu.

let menuEl = null;
function hideSlotMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  document.removeEventListener('mousedown', onMenuDocMouseDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); hideSlotMenu(); }
}
function onMenuDocMouseDown(e) {
  if (menuEl && !menuEl.contains(e.target)) hideSlotMenu();
}

function showSlotMenu(x, y, role) {
  hideSlotMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu tab-slot-menu';
  const item = document.createElement('div');
  item.className = 'context-menu-item';
  item.textContent = `Open ${label(role).toLowerCase()}`;
  item.onclick = () => { hideSlotMenu(); openHolder(role); };
  menu.appendChild(item);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  menuEl = menu;
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - r.height - 8) + 'px';
  document.addEventListener('mousedown', onMenuDocMouseDown, true);
  document.addEventListener('keydown', onMenuKey, true);
}

// ------------------------------------------------------------------ lifecycle

export function init(callbacks) {
  cb = callbacks || {};
  render();
}
