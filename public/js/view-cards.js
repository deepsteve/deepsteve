/**
 * Superviews — a view's cards.
 *
 * A selectable project view with `cards: true` (Analytics, say) gets a superview while it is the
 * selected view: a tab-shaped button at the head of the strip — above the first tab in vertical
 * layout, left of it in horizontal — that opens a grid of cards over the terminal area, one per
 * agent tab in the view, each showing what that tab was first asked. Clicking a card opens its
 * tab, exactly as clicking the tab itself would.
 *
 * The superview is #view-cards-tab, in #tabs-list-wrapper after #views-toggle and before the
 * orchestrator's #tab-slot. It is NOT in #tabs-list: every walk of the strip (navigation, the
 * context filter, the session stores' order, timelapse) reads `#tabs-list .tab`, and the
 * superview is not a session. It carries .tab for the look in both layouts, which also means
 * TabManager.setActive() clears its .active along with every real tab's.
 *
 * The grid is #view-cards, over #terminals. While it is up no real tab reads as active and the
 * terminal under it has lost focus, so keys can't reach a session you can't see. It goes down
 * when any tab is switched to (app.js calls dismiss() from switchTo), and when the view or the
 * project it was opened for is no longer the one selected.
 *
 * The prompts come from GET /api/project-views/cards (mods/project-mods/view-cards.js). A found
 * prompt never changes, so it is kept; a tab with none yet is asked about again every few
 * seconds while the grid is up.
 *
 * Like tab-slot.js this never imports project-views.js or context-views.js; app.js injects what
 * it needs. render() is called from the end of every filter pass and never asks for one.
 */

const POLL_MS = 5000;
const GRID_GLYPH = '▦';

let cb = {};
let tabEl = null;
let paneEl = null;
let up = false;          // is the grid showing — this window only, so a reload starts with it down
let upFor = null;        // `${contextId}|${slug}` the grid was opened for
let pollTimer = null;
let fetching = false;
let paneSig = null;
const prompts = new Map();   // tab id → { prompt, supported }, once the server has answered

export const isUp = () => up;

const ctxNow = () => cb.getActiveContext?.() || null;
const keyOf = (ctx, view) => (ctx && view ? `${ctx.id}|${view.slug}` : null);

function ensureTab() {
  if (tabEl && tabEl.isConnected) return tabEl;
  const wrapper = document.getElementById('tabs-list-wrapper');
  const list = document.getElementById('tabs-list');
  if (!wrapper || !list) return null;
  tabEl = document.createElement('div');
  tabEl.id = 'view-cards-tab';
  tabEl.className = 'tab view-cards-tab hidden';
  tabEl.setAttribute('role', 'tab');
  // .tab-icon shows only in the collapsed rail, where the label and glyph do not (styles.css).
  // Both are the grid mark, never the view's emoji: #views-toggle beside it already shows that,
  // and two "📈 Analytics" in a row read as one control drawn twice.
  const icon = document.createElement('span');
  icon.className = 'tab-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = GRID_GLYPH;
  const glyph = document.createElement('span');
  glyph.className = 'view-cards-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = GRID_GLYPH;
  const label = document.createElement('span');
  label.className = 'tab-label';
  const count = document.createElement('span');
  count.className = 'view-cards-count';
  tabEl.append(icon, glyph, label, count);
  tabEl.addEventListener('click', () => show());
  // Ahead of the slot when tab-slot.js has drawn it, else of the first tab — either way the
  // order is toggle, superview, slot, tabs, whichever module drew first.
  const slot = document.getElementById('tab-slot');
  wrapper.insertBefore(tabEl, slot && slot.parentNode === wrapper ? slot : list);
  return tabEl;
}

function ensurePane() {
  if (paneEl && paneEl.isConnected) return paneEl;
  const host = document.getElementById('terminals');
  if (!host) return null;
  paneEl = document.createElement('div');
  paneEl.id = 'view-cards';
  paneEl.className = 'hidden';
  paneEl.setAttribute('role', 'region');
  host.appendChild(paneEl);
  paneSig = null;
  return paneEl;
}

/** The selected view of the active project when it has a superview, else null. */
function currentView(ctx = ctxNow()) {
  return ctx ? cb.cardsFor?.(ctx) || null : null;
}

function setUp(on) {
  if (up === on) return;
  up = on;
  if (on) {
    // No real tab is the one you are looking at, and none may take your keys.
    cb.setStripActive?.(false);
    document.activeElement?.blur?.();
    if (!pollTimer) pollTimer = setInterval(fetchPrompts, POLL_MS);
  } else {
    upFor = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    cb.setStripActive?.(true);
  }
  cb.onUpChanged?.();
}

/** Put the grid up for the selected view. A no-op when that view has no superview. */
export function show() {
  const ctx = ctxNow();
  const view = currentView(ctx);
  if (!view) return;
  upFor = keyOf(ctx, view);
  setUp(true);
  render();
  fetchPrompts();
}

/** Put the grid down — a tab is being switched to. Leaves the strip's active tab to the caller. */
export function dismiss() {
  if (!up) return;
  setUp(false);
  render();
}

/**
 * Redraw the superview and, while it is up, the grid. DOM only: called from the end of every
 * filter pass, so it never asks for one.
 */
export function render() {
  const el = ensureTab();
  const ctx = ctxNow();
  const view = currentView(ctx);
  // The grid belongs to the view and project it was opened for.
  if (up && keyOf(ctx, view) !== upFor) setUp(false);
  const tabs = view ? cb.cardTabs?.(view) || [] : [];

  if (el) {
    el.classList.toggle('hidden', !view);
    el.classList.toggle('active', up && !!view);
    el.setAttribute('aria-selected', up && view ? 'true' : 'false');
    if (view) {
      const [, , label, count] = el.children;
      el.title = `Show every ${view.name} tab with its first prompt`;
      label.textContent = view.name;
      count.textContent = String(tabs.length);
    }
  }
  renderPane(ctx, view, tabs);
  // A tab that joined while the grid is up is asked about at once rather than at the next poll.
  if (up && tabs.some(t => !prompts.has(t.id))) fetchPrompts();
}

function promptText(p) {
  if (!p) return { text: 'Loading…', empty: true };
  if (p.prompt) return { text: p.prompt, empty: false };
  return { text: p.supported ? 'No prompt yet' : 'This agent keeps no transcript to read a prompt from', empty: true };
}

function card(t) {
  const el = document.createElement('button');
  el.className = 'view-card' + (t.current ? ' current' : '');
  el.dataset.id = t.id;
  el.title = `Open ${t.name}`;
  const name = document.createElement('span');
  name.className = 'view-card-name';
  name.textContent = t.name;
  const { text, empty } = promptText(prompts.get(t.id));
  const prompt = document.createElement('span');
  prompt.className = 'view-card-prompt' + (empty ? ' empty' : '');
  prompt.textContent = text;
  el.append(name, prompt);
  el.addEventListener('click', () => cb.openTab?.(t.id));
  return el;
}

function renderPane(ctx, view, tabs) {
  const pane = ensurePane();
  if (!pane) return;
  const showing = up && !!view;
  pane.classList.toggle('hidden', !showing);
  if (!showing) { paneSig = null; return; }
  const sig = JSON.stringify([ctx?.name, view.slug, view.name, view.icon, view.launcher,
    tabs.map(t => [t.id, t.name, !!t.current, prompts.get(t.id) || null])]);
  if (sig === paneSig) return;
  paneSig = sig;

  pane.replaceChildren();
  const head = document.createElement('div');
  head.className = 'view-cards-head';
  const title = document.createElement('span');
  title.className = 'view-cards-title';
  title.textContent = view.icon ? `${view.icon} ${view.name}` : view.name;
  const sub = document.createElement('span');
  sub.className = 'view-cards-sub';
  sub.textContent = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}${ctx?.name ? ` in ${ctx.name}` : ''}`;
  head.append(title, sub);
  pane.appendChild(head);

  if (!tabs.length) {
    const empty = document.createElement('div');
    empty.className = 'view-cards-empty';
    empty.textContent = view.launcher
      ? `No ${view.name} tabs are open. Start one with “New ${view.name} tab” beside the +.`
      : `No ${view.name} tabs are open. File one in from a tab's right-click Views ▸ menu.`;
    pane.appendChild(empty);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'view-cards-grid';
  for (const t of tabs) grid.appendChild(card(t));
  pane.appendChild(grid);
}

/**
 * Ask the server for the prompts still missing: tabs never asked about, and tabs whose agent
 * keeps a transcript but has not been prompted yet. One request for all of them.
 */
async function fetchPrompts() {
  if (!up || fetching) return;
  const view = currentView();
  if (!view) return;
  const need = (cb.cardTabs?.(view) || []).map(t => t.id).filter((id) => {
    const p = prompts.get(id);
    return !p || (!p.prompt && p.supported);
  });
  if (!need.length) return;
  fetching = true;
  try {
    const res = await fetch('/api/project-views/cards?ids=' + need.map(encodeURIComponent).join(','));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    for (const id of need) {
      const p = data.prompts && data.prompts[id];
      prompts.set(id, { prompt: (p && p.prompt) || null, supported: !p || p.supported !== false });
    }
  } catch {
    // Read as "no prompt yet", so the card stops saying Loading… and the poll tries again.
    for (const id of need) if (!prompts.has(id)) prompts.set(id, { prompt: null, supported: true });
  } finally {
    fetching = false;
  }
  render();
}

export function init(callbacks) {
  cb = callbacks || {};
  render();
}
