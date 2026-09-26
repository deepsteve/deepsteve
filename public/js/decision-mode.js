// Decision Tab mode (#716): an inbox view over the decision tabs agents have opened.
//
// A decision tab is a display tab with a row of buttons whose click goes back to the agent
// (mods/display-tab/decision.js). The server owns which tabs are still waiting on an answer
// and pushes the list as a `decision-tabs` message on the control socket; this module only
// intersects that list with the tabs this window actually has.
//
// The #decision-mode-btn shows only while this window has a decision tab open (or while the
// mode is on, so it can be left from the empty inbox). Entering the mode:
//   - hides every other tab with .decision-hidden, which app.js's getVisibleTabIds() honours,
//     so the strip's own prev/next arrows and the ⌘-hold switcher step through decisions only;
//   - sets the context filter aside (isFilterSuspended), because an inbox that hides the
//     decisions of the project you are not looking at is not an inbox;
//   - shows its own ‹ n/m › pager next to the button, and the #decision-inbox-empty screen
//     once the last decision is answered.
//
// Leaving is explicit (the button, the inbox's Exit), or implicit when focus moves to a tab
// that is NOT a decision while the mode is on — a new terminal the user asked for must never
// land hidden behind the filter.

let cb = {};
let pendingIds = [];      // server order: decision tabs still waiting on an answer
let active = false;
let lastActiveId = null;   // the active tab as of the last sync, to tell a jump from a close

let btn = null;
let countEl = null;
let pagerEl = null;
let prevBtn = null;
let nextBtn = null;
let posEl = null;
let emptyEl = null;

export function isDecisionModeActive() {
  return active;
}

/** Decision tabs present in this window, in strip order. */
export function localDecisionIds() {
  const pending = new Set(pendingIds);
  return (cb.getAllTabIds ? cb.getAllTabIds() : []).filter(id => pending.has(id));
}

/** The server's list arrived (on connect, and on every change). */
export function setDecisionTabs(tabs) {
  pendingIds = Array.isArray(tabs) ? tabs.map(t => t && t.id).filter(Boolean) : [];
  sync();
}

export function enter() {
  if (active) return;
  if (localDecisionIds().length === 0) return;
  cb.beforeEnter?.();
  active = true;
  sync();
  cb.onModeChanged?.();
}

export function exit() {
  if (!active) return;
  active = false;
  sync();
  cb.onModeChanged?.();
}

export function toggle() {
  if (active) exit(); else enter();
}

function step(dir) {
  const ids = localDecisionIds();
  const i = ids.indexOf(cb.getActiveTabId?.());
  const target = i < 0 ? ids[0] : ids[i + dir];
  if (target) cb.switchToTab?.(target);
}

/**
 * Idempotent reconciler — called from app.js's notifyTabsChanged() and, deferred to a
 * microtask, after every switchTo(), so the switch it may itself make never nests inside one.
 */
export function sync() {
  const allIds = cb.getAllTabIds ? cb.getAllTabIds() : [];
  const ids = localDecisionIds();
  const set = new Set(ids);
  const activeId = cb.getActiveTabId?.();
  const prevActive = lastActiveId;
  lastActiveId = activeId;

  if (active && activeId && !set.has(activeId)) {
    // Focus MOVED to a non-decision tab while the previous one still exists: someone opened
    // or jumped to something else on purpose. Leave the mode rather than hide what they chose.
    // Any other way to be here — the answered tab closed and killSession fell back to a
    // neighbour, or the tab stopped being a decision in place — is ours to resolve.
    if (prevActive && prevActive !== activeId && allIds.includes(prevActive)) {
      active = false;
      paint(allIds, ids, set);
      cb.onModeChanged?.();
      return;
    }
  }

  paint(allIds, ids, set);

  // Land on a decision; with none left, the empty inbox (painted above) covers the view.
  if (active && ids.length && !set.has(activeId)) cb.activateTab?.(ids[0]);
}

function paint(allIds, ids, set) {
  for (const id of allIds) {
    const el = document.getElementById('tab-' + id);
    if (!el) continue;
    el.classList.toggle('decision-tab', set.has(id));
    el.classList.toggle('decision-hidden', active && !set.has(id));
  }
  document.getElementById('app-container')?.classList.toggle('decision-mode', active);

  if (btn) {
    btn.style.display = (ids.length > 0 || active) ? '' : 'none';
    btn.classList.toggle('active', active);
    btn.title = active ? 'Leave Decision Tab mode' : `Decision Tab mode — ${ids.length} waiting`;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (countEl) {
    countEl.textContent = ids.length ? String(ids.length) : '';
    countEl.classList.toggle('hidden', ids.length === 0);
  }

  const i = ids.indexOf(cb.getActiveTabId?.());
  if (pagerEl) pagerEl.style.display = active && ids.length > 0 ? '' : 'none';
  if (posEl) posEl.textContent = ids.length ? `${i < 0 ? '–' : i + 1}/${ids.length}` : '';
  if (prevBtn) prevBtn.disabled = i <= 0;
  if (nextBtn) nextBtn.disabled = i < 0 ? ids.length === 0 : i >= ids.length - 1;

  if (emptyEl) emptyEl.classList.toggle('hidden', !(active && ids.length === 0));
}

export function init(callbacks) {
  cb = callbacks || {};
  btn = document.getElementById('decision-mode-btn');
  countEl = document.getElementById('decision-mode-count');
  pagerEl = document.getElementById('decision-pager');
  prevBtn = document.getElementById('decision-prev');
  nextBtn = document.getElementById('decision-next');
  posEl = document.getElementById('decision-pos');
  emptyEl = document.getElementById('decision-inbox-empty');

  btn?.addEventListener('click', () => { toggle(); btn.blur(); });
  prevBtn?.addEventListener('click', () => step(-1));
  nextBtn?.addEventListener('click', () => step(1));
  document.getElementById('decision-inbox-exit')?.addEventListener('click', exit);
  sync();
}
