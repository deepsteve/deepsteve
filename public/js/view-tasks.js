/**
 * Task boards — a view's tasks.
 *
 * A selectable project view with `tasks: true` gets a board while it is the selected view: a
 * tab-shaped button at the head of the strip, like view-cards.js's superview, that opens the
 * project's tasks over the terminal area. Every agent tab in the view is on the board without
 * being put there. A tab in no group is a card of its own, titled with its one-liner: the words
 * the header row shows by default (view-header.js), which are its Custom Label, else Claude
 * Code's Summary, else the first line of its first prompt.
 *
 * A group is the other kind of card: a name of its own over several tabs. Dragging a card onto
 * another tab's card makes one, holding both, with its name open for editing and the target's
 * one-liner filled in. A tab is in at most one of a project's groups, so a drag moves it: onto a
 * group files it there, onto a lone tab's card makes a group of the two, and onto the "take it
 * out" card, shown at the end of the board only while a grouped tab is being dragged, gives it a
 * card of its own again. A group that a move empties is dropped (the daemon's rule, mirrored by
 * applyMove). A lone tab's whole card is what you drag; in a group, each tab's row is.
 * ⌘/Ctrl-click and ⇧-click select several, and dragging any selected tab drags them all. Each
 * tab's Open button opens it, exactly as clicking it in the strip would — which takes the board
 * down. The tab's own name is left off the board: the one-liner says what it is for.
 *
 * A card's title renames it on click. A group's name belongs to the group. A lone tab's title is
 * its Custom Label (PUT /api/project-views/custom-label/:id), so the board and the header row
 * always say the same thing; clearing the field clears the label, and the Summary comes back.
 *
 * The cards follow the strip's order, a group in the place of its first tab there. A group with
 * none of its tabs drawn here comes last, oldest first.
 *
 * The groups are the daemon's (mods/project-mods/view-tasks.js), per project, so every window
 * sees one board: /api/project-views/tasks/:contextId, and a `view-tasks` ping when any window
 * writes. A write is drawn at once and then replaced by the daemon's answer; a failed one says
 * so and refetches. A group keeps a tab's id after it closes, so a reopened tab is back in it,
 * but the board draws only this window's tabs; a group's tabs open in another window are counted
 * on its card, not drawn.
 *
 * The one-liners are one-liners.js's: this board keeps its own cache of them, asked about once
 * when the board comes up and every POLL_MS while it stays up (Claude Code writes the title during
 * the first reply). A Custom Label set in any window arrives as the 'custom-label' ping, which
 * app.js routes to onCustomLabel().
 *
 * Like view-cards.js this never imports project-views.js or context-views.js; app.js injects
 * what it needs. render() is called from the end of every filter pass and never asks for one.
 * A rebuild while a drag or a title edit is under way would pull the element out from under
 * it, so the pane waits for either to finish.
 */

import { createOneLiners, oneLiner } from './one-liners.js';

const POLL_MS = 5000;
const BOARD_GLYPH = '▥';
const DRAG_TYPE = 'application/x-deepsteve-sessions';
const TITLE_MAX = 120;   // a group's name: the store's MAX_TITLE
const LABEL_MAX = 200;   // a Custom Label: tools.js's MAX_CUSTOM_LABEL_LEN

let cb = {};
let tabEl = null;
let paneEl = null;
let up = false;          // is the board showing — this window only, so a reload starts with it down
let upFor = null;        // `${contextId}|${slug}` the board was opened for
let pollTimer = null;
let paneSig = null;
const facts = createOneLiners({ onChange: () => render() });   // every tab's one-liner, as the server last answered
const boards = new Map();    // context id → [{ id, title, created, sessions: [{ id, live }] }]
const loading = new Set();   // context ids with a GET in flight
const stale = new Set();     // …and pinged during it, so asked again when it lands
let selected = new Set();    // tab ids picked with ⌘/⇧-click, in the order picked
let anchor = null;           // { list, id }: where a ⇧-click range starts
let dragIds = null;          // the tabs being dragged, while one of our drags is on
let editing = false;         // a title input is open
let pendingEdit = null;      // a group id whose name opens for editing once its card is drawn
let titleEls = new Map();    // group id → its title button, as last drawn

export const isUp = () => up;

const ctxNow = () => cb.getActiveContext?.() || null;
const keyOf = (ctx, view) => (ctx && view ? `${ctx.id}|${view.slug}` : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ensureTab() {
  if (tabEl && tabEl.isConnected) return tabEl;
  const wrapper = document.getElementById('tabs-list-wrapper');
  const list = document.getElementById('tabs-list');
  if (!wrapper || !list) return null;
  tabEl = document.createElement('div');
  tabEl.id = 'view-tasks-tab';
  tabEl.className = 'tab view-tasks-tab hidden';
  tabEl.setAttribute('role', 'tab');
  // .tab-icon shows only in the collapsed rail, where the label and glyph do not (styles.css).
  const icon = document.createElement('span');
  icon.className = 'tab-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = BOARD_GLYPH;
  const glyph = document.createElement('span');
  glyph.className = 'view-tasks-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = BOARD_GLYPH;
  const label = document.createElement('span');
  label.className = 'tab-label';
  const count = document.createElement('span');
  count.className = 'view-tasks-count';
  tabEl.append(icon, glyph, label, count);
  tabEl.addEventListener('click', () => show());
  // The same place as the cards superview: ahead of the slot when tab-slot.js has drawn it,
  // else of the first tab. A view has one superview or the other, never both.
  const slot = document.getElementById('tab-slot');
  wrapper.insertBefore(tabEl, slot && slot.parentNode === wrapper ? slot : list);
  return tabEl;
}

function ensurePane() {
  if (paneEl && paneEl.isConnected) return paneEl;
  const host = document.getElementById('terminals');
  if (!host) return null;
  paneEl = document.createElement('div');
  paneEl.id = 'view-tasks';
  paneEl.className = 'hidden';
  paneEl.setAttribute('role', 'region');
  host.appendChild(paneEl);
  paneSig = null;
  return paneEl;
}

/** The selected view of the active project when it has a board, else null. */
function currentView(ctx = ctxNow()) {
  return ctx ? cb.tasksFor?.(ctx) || null : null;
}

function setUp(on) {
  if (up === on) return;
  up = on;
  if (on) {
    // No real tab is the one you are looking at, and none may take your keys.
    cb.setStripActive?.(false);
    document.activeElement?.blur?.();
    if (!pollTimer) pollTimer = setInterval(fetchFacts, POLL_MS);
  } else {
    upFor = null;
    selected = new Set();
    anchor = null;
    dragIds = null;
    editing = false;
    pendingEdit = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    cb.setStripActive?.(true);
  }
  cb.onUpChanged?.();
}

/** Put the board up for the selected view. A no-op when that view has no board. */
export function show() {
  const ctx = ctxNow();
  const view = currentView(ctx);
  if (!view) return;
  upFor = keyOf(ctx, view);
  setUp(true);
  loadTasks(ctx.id);
  render();
}

/** Put the board down — a tab is being switched to. Leaves the strip's active tab to the caller. */
export function dismiss() {
  if (!up) return;
  setUp(false);
  render();
}

/** Another window (or this one) changed a project's groups. Refetch if we hold that board. */
export function onPing(contextId) {
  if (boards.has(contextId) || loading.has(contextId)) loadTasks(contextId);
}

/** A tab's Custom Label was set or cleared, in this window or another ('custom-label' ping). */
export function onCustomLabel(id, customLabel) {
  facts.onCustomLabel(id, customLabel);
}

/**
 * Redraw the superview and, while it is up, the board. DOM only: called from the end of every
 * filter pass, so it never asks for one.
 */
export function render() {
  const el = ensureTab();
  const ctx = ctxNow();
  const view = currentView(ctx);
  // The board belongs to the view and project it was opened for.
  if (up && keyOf(ctx, view) !== upFor) setUp(false);
  // The superview counts the board's cards, which needs the groups, so they are fetched as soon
  // as the view shows.
  if (view && !boards.has(ctx.id) && !loading.has(ctx.id)) loadTasks(ctx.id);

  if (el) {
    el.classList.toggle('hidden', !view);
    el.classList.toggle('active', up && !!view);
    el.setAttribute('aria-selected', up && view ? 'true' : 'false');
    if (view) {
      const [, , label, count] = el.children;
      el.title = 'Show every tab in this view, each with its one-liner';
      label.textContent = view.name;
      count.textContent = String(layout(boards.get(ctx.id) || [], cb.memberTabs?.(view) || [], cb.hasTab).length);
    }
  }
  renderPane(ctx, view);
}

/**
 * Every move is the same rule as the daemon's: out of every group, then into `to` (if any). A
 * group the move empties goes; one that was empty already stays.
 */
export function applyMove(tasks, ids, to) {
  const out = [];
  for (const t of tasks) {
    const kept = t.sessions.filter(s => !ids.includes(s.id));
    if (t.id === to) out.push({ ...t, sessions: [...kept, ...ids.map(id => ({ id, live: true }))] });
    else if (kept.length || !t.sessions.length) out.push({ ...t, sessions: kept });
  }
  return out;
}

/**
 * What the board draws, in order. A tab in no group is `{ tab }`. A group is `{ task, tabs,
 * elsewhere }`: its tabs here in the group's own order, and how many of its live tabs are in
 * another window. The cards follow `tabs` (the strip's order), a group in its first tab's place;
 * a group with none of its tabs here comes last, in the groups' order.
 */
export function layout(tasks, tabs, hasTab = () => false) {
  const here = new Map(tabs.map(t => [t.id, t]));
  const groupOf = new Map();
  for (const task of tasks) for (const s of task.sessions) groupOf.set(s.id, task);
  const group = (task) => ({
    task,
    tabs: task.sessions.map(s => here.get(s.id)).filter(Boolean),
    elsewhere: task.sessions.filter(s => s.live && !here.has(s.id) && !hasTab(s.id)).length,
  });
  const cards = [];
  const placed = new Set();
  for (const tab of tabs) {
    const task = groupOf.get(tab.id);
    if (!task) cards.push({ tab });
    else if (!placed.has(task.id)) { placed.add(task.id); cards.push(group(task)); }
  }
  for (const task of tasks) if (!placed.has(task.id)) cards.push(group(task));
  return cards;
}

function renderPane(ctx, view) {
  const pane = ensurePane();
  if (!pane) return;
  const showing = up && !!view;
  pane.classList.toggle('hidden', !showing);
  if (!showing) { paneSig = null; return; }
  if (dragIds || editing) return;

  const tabs = cb.memberTabs?.(view) || [];
  const tasks = boards.get(ctx.id) || [];
  const cards = layout(tasks, tabs, cb.hasTab);
  const sig = JSON.stringify([ctx.name, view.slug, view.name, view.icon, [...selected],
    tasks.map(t => [t.id, t.title, t.sessions]), tabs.map(t => [t.id, t.name, !!t.current]),
    tabs.map(t => oneLiner(facts.get(t.id)).text)]);
  if (sig !== paneSig) {
    paneSig = sig;
    draw(pane, ctx, view, tabs, cards);
  }
  // A tab that joined while the board is up is asked about at once rather than at the next poll.
  if (tabs.some(t => !facts.has(t.id))) fetchFacts();
}

function draw(pane, ctx, view, tabs, cards) {
  pane.replaceChildren();
  titleEls = new Map();
  const head = document.createElement('div');
  head.className = 'view-tasks-head';
  const title = document.createElement('span');
  title.className = 'view-tasks-title';
  title.textContent = view.icon ? `${view.icon} ${view.name}` : view.name;
  const sub = document.createElement('span');
  sub.className = 'view-tasks-sub';
  sub.textContent = `${plural(cards.length, 'task', 'tasks')} · ${plural(tabs.length, 'tab', 'tabs')}${ctx.name ? ` in ${ctx.name}` : ''}`;
  head.append(title, sub);

  const board = document.createElement('div');
  board.className = 'view-tasks-board';
  const grid = document.createElement('div');
  grid.className = 'view-tasks-cards';
  // The lone tabs are one list for ⇧-click, in the order they are drawn.
  const loneOrder = cards.filter(c => c.tab).map(c => c.tab.id);
  for (const c of cards) grid.appendChild(c.task ? groupCard(c) : tabCard(c.tab, loneOrder));
  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'view-tasks-empty';
    empty.textContent = 'No agent tabs are open in this view.';
    grid.appendChild(empty);
  }
  grid.appendChild(outCard());
  board.appendChild(grid);
  pane.append(head, board);

  if (pendingEdit && titleEls.has(pendingEdit)) {
    const id = pendingEdit;
    pendingEdit = null;
    renameTask(titleEls.get(id), id);
  }
}

/** A card title's words, in a span: line-clamping a <button> itself is unreliable in Firefox. */
function titleText(text) {
  const span = document.createElement('span');
  span.className = 'view-task-title-text';
  span.textContent = text;
  return span;
}

/** A tab in no group: a card of its own, titled with its one-liner. The card is what you drag. */
function tabCard(tab, order) {
  const card = document.createElement('div');
  card.className = 'view-task view-task-solo';
  const head = document.createElement('div');
  head.className = 'view-task-head';
  const { text, empty } = oneLiner(facts.get(tab.id));
  const title = document.createElement('button');
  title.className = 'view-task-title' + (empty ? ' empty' : '');
  title.appendChild(titleText(text));
  title.title = 'Rename — sets this tab’s Custom Label, which the header row shows too';
  title.addEventListener('click', (e) => { e?.stopPropagation?.(); relabel(title, tab.id); });
  head.appendChild(title);
  const foot = document.createElement('div');
  foot.className = 'view-task-foot';
  foot.appendChild(openButton(tab));
  card.append(head, foot);
  asTabHandle(card, tab, 'lone', order);
  dropTarget(card, (ids) => groupWith(tab.id, ids));
  return card;
}

/** A group: its name, and a row per tab, each with its one-liner. */
function groupCard({ task, tabs, elsewhere }) {
  const card = document.createElement('div');
  card.className = 'view-task';
  card.dataset.task = task.id;
  const head = document.createElement('div');
  head.className = 'view-task-head';
  const title = document.createElement('button');
  title.className = 'view-task-title';
  title.appendChild(titleText(task.title));
  title.title = 'Rename this task';
  title.addEventListener('click', () => renameTask(title, task.id));
  titleEls.set(task.id, title);
  const count = document.createElement('span');
  count.className = 'view-task-count';
  count.textContent = String(tabs.length + elsewhere);
  const del = document.createElement('button');
  del.className = 'view-task-delete';
  del.textContent = '×';
  del.title = 'Ungroup — each of its tabs gets a card of its own again';
  del.setAttribute('aria-label', `Ungroup ${task.title}`);
  del.addEventListener('click', () => deleteTask(task.id));
  head.append(title, count, del);
  card.appendChild(head);
  if (tabs.length) {
    const list = document.createElement('div');
    list.className = 'view-tasks-list';
    const order = tabs.map(t => t.id);
    for (const t of tabs) list.appendChild(sessionRow(t, task.id, order));
    card.appendChild(list);
  }
  if (elsewhere) {
    const more = document.createElement('div');
    more.className = 'view-task-more';
    more.textContent = `+${plural(elsewhere, 'tab', 'tabs')} in another window`;
    card.appendChild(more);
  }
  if (!tabs.length && !elsewhere) {
    const empty = document.createElement('div');
    empty.className = 'view-tasks-empty';
    empty.textContent = 'None of its tabs are open.';
    card.appendChild(empty);
  }
  dropTarget(card, (ids) => moveTabs(ids, task.id));
  return card;
}

/**
 * Where a grouped tab is dropped to take it back out. Hidden until a drag that holds a grouped
 * tab starts (onDragStart), and it is the last card, so showing it moves nothing above it.
 */
function outCard() {
  const card = document.createElement('div');
  card.className = 'view-task view-task-out';
  card.textContent = 'Drop here to take it out of its group';
  dropTarget(card, (ids) => moveTabs(ids, null));
  return card;
}

/** A tab in a group: its one-liner and its Open button. The row is what you drag. */
function sessionRow(t, key, order) {
  const el = document.createElement('div');
  el.className = 'view-tasks-session';
  const { text, empty } = oneLiner(facts.get(t.id));
  const label = document.createElement('span');
  label.className = 'view-tasks-session-label' + (empty ? ' empty' : '');
  label.textContent = text;
  el.append(label, openButton(t));
  asTabHandle(el, t, key, order);
  return el;
}

/** Into the tab, as clicking it in the strip would. Its name is said only here, on hover. */
function openButton(t) {
  const btn = document.createElement('button');
  btn.className = 'view-task-open';
  btn.textContent = 'Open';
  btn.title = `Open ${t.name}`;
  btn.addEventListener('click', (e) => {
    e?.stopPropagation?.();   // not also a click on the card or row it sits in
    cb.openTab?.(t.id);
  });
  return btn;
}

/** Make `el` stand for tab `t` on the board: dragged, and ⌘/⇧-clicked into the selection. */
function asTabHandle(el, t, key, order) {
  if (selected.has(t.id)) el.classList.add('selected');
  if (t.current) el.classList.add('current');
  el.dataset.id = t.id;
  el.draggable = true;
  el.addEventListener('click', (e) => onHandleClick(e, t.id, key, order));
  el.addEventListener('dragstart', (e) => onDragStart(e, t.id));
  el.addEventListener('dragend', () => endDrag());
}

/** ⌘/Ctrl toggles a tab into the selection, ⇧ extends it within one list; a plain click lets go. */
function onHandleClick(e, id, key, order) {
  if (e.metaKey || e.ctrlKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    anchor = { list: key, id };
  } else if (e.shiftKey) {
    const from = anchor && anchor.list === key ? order.indexOf(anchor.id) : -1;
    const to = order.indexOf(id);
    if (from === -1) {
      selected.add(id);
      anchor = { list: key, id };
    } else {
      for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(x);
    }
  } else if (selected.size) {
    selected = new Set();
    anchor = null;
  } else {
    return;
  }
  render();
}

const groupOfTab = (id) => (boards.get(ctxNow()?.id) || []).find(t => t.sessions.some(s => s.id === id)) || null;

function onDragStart(e, id) {
  dragIds = selected.has(id) ? [...selected] : [id];
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag that carries no data.
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragIds));
  }
  e.currentTarget?.classList?.add('dragging');
  // The way back out, for a drag with a grouped tab in it. A turn later: a layout change inside
  // dragstart can cancel the drag it is starting.
  if (dragIds.some(groupOfTab)) {
    setTimeout(() => { if (dragIds) paneEl?.classList.add('dragging-grouped'); }, 0);
  }
}

/** Our drag is over, dropped or not. */
function stopDragging() {
  dragIds = null;
  paneEl?.classList.remove('dragging-grouped');
}

function endDrag() {
  if (!dragIds) return;
  stopDragging();
  paneSig = null;   // a rebuild clears the .dragging mark
  render();
}

function dropTarget(el, onDrop) {
  el.addEventListener('dragover', (e) => {
    if (!dragIds) return;   // a file, or a tab from the strip: not ours
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !el.contains?.(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    e.stopPropagation?.();
    el.classList.remove('drop-over');
    const ids = dragIds;
    // The drop may redraw the board, and a removed source never hears its dragend.
    stopDragging();
    onDrop(ids);
  });
}

/** Swap `label` for a one-line input. `done(text)` gets the trimmed text, or null on Escape. */
function editTitle(label, initial, done, { max = TITLE_MAX, placeholder = 'Task name' } = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'view-task-title-input';
  input.value = initial;
  input.maxLength = max;
  input.placeholder = placeholder;
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    editing = false;
    paneSig = null;
    done(save ? input.value.trim() : null);
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  // A lone tab's title sits in a card you drag, and a press-and-move in the field must select
  // text rather than start a drag. finish() redraws, which makes the card draggable again.
  for (let n = label.parentNode; n && n !== paneEl; n = n.parentNode) if (n.draggable) n.draggable = false;
  label.replaceWith(input);
  editing = true;
  input.focus?.();
  input.select?.();
  return input;
}

// --- writes ---------------------------------------------------------------------------------

async function send(ctxId, method, suffix, body) {
  try {
    const res = await fetch(`/api/project-views/tasks/${encodeURIComponent(ctxId)}${suffix}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (Array.isArray(data.tasks)) boards.set(ctxId, data.tasks);
    render();
    return data;
  } catch (e) {
    cb.showToast?.(`Couldn’t save the tasks — ${e.message}`);
    loadTasks(ctxId);   // put the board back to what the daemon holds
    return null;
  }
}

/** Draw the change now; the daemon's answer replaces it. */
function optimistic(ctxId, next) {
  boards.set(ctxId, next);
  render();
}

function moveTabs(ids, to) {
  const ctx = ctxNow();
  if (!ctx || !ids.length) return;
  const tasks = boards.get(ctx.id) || [];
  const where = (id) => tasks.find(t => t.sessions.some(s => s.id === id))?.id ?? null;
  selected = new Set();
  anchor = null;
  // Dropped where they already are: nothing to write.
  if (ids.every(id => where(id) === to)) { render(); return; }
  optimistic(ctx.id, applyMove(tasks, ids, to));
  send(ctx.id, 'POST', '/move', { sessions: ids, to });
}

/**
 * Tabs dropped on a lone tab's card: a group of that tab and them, named for now with the
 * target's one-liner, and its name opened for editing.
 */
function groupWith(targetId, ids) {
  const others = ids.filter(id => id !== targetId);
  if (!others.length) {   // dropped on itself
    selected = new Set();
    anchor = null;
    render();
    return;
  }
  const { text, empty } = oneLiner(facts.get(targetId));
  createTask({ title: empty ? '' : text, sessions: [targetId, ...others], edit: true });
}

async function createTask({ title, sessions, edit } = {}) {
  const ctx = ctxNow();
  if (!ctx) return;
  selected = new Set();
  anchor = null;
  const data = await send(ctx.id, 'POST', '', { title: title || '', sessions: sessions || [] });
  if (data && data.task && edit && up) {
    pendingEdit = data.task.id;
    paneSig = null;
    render();
  }
}

function renameTask(label, id) {
  const ctx = ctxNow();
  if (!ctx || !label) return;
  const task = (boards.get(ctx.id) || []).find(t => t.id === id);
  if (!task) return;
  editTitle(label, task.title, (title) => {
    if (!title || title === task.title) return;
    optimistic(ctx.id, boards.get(ctx.id).map(t => (t.id === id ? { ...t, title } : t)));
    send(ctx.id, 'PUT', `/${encodeURIComponent(id)}`, { title });
  });
}

/** Ungroup: the group goes, and its tabs are lone cards again. Nothing happens to the tabs. */
function deleteTask(id) {
  const ctx = ctxNow();
  if (!ctx) return;
  optimistic(ctx.id, (boards.get(ctx.id) || []).filter(t => t.id !== id));
  send(ctx.id, 'DELETE', `/${encodeURIComponent(id)}`);
}

/**
 * Rename a lone tab's card, which is its Custom Label. The field starts with what the card shows,
 * so leaving it as it was writes nothing, and emptying it clears the label.
 */
function relabel(label, id) {
  const f = facts.get(id);
  const current = (f && f.customLabel) || '';
  const shown = oneLiner(f);
  const initial = current || (shown.empty ? '' : shown.text);
  editTitle(label, initial, (text) => {
    if (text === null || text === initial) return;
    if (!text && !current) return;
    saveLabel(id, text || null);
  }, { max: LABEL_MAX, placeholder: 'Custom Label — empty for the Summary' });
}

async function saveLabel(id, customLabel) {
  const before = facts.get(id);
  facts.set(id, { ...(before || { at: 0, prompt: null, title: null, supported: true }), customLabel });
  render();
  try {
    const res = await fetch('/api/project-views/custom-label/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customLabel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // The daemon pings every window, this one included; its cleaned text is the one to show.
    if ('customLabel' in data) onCustomLabel(id, data.customLabel);
  } catch (e) {
    if (before) facts.set(id, before); else facts.delete(id);
    cb.showToast?.(`Couldn’t save the Custom Label — ${e.message}`);
    render();
  }
}

// --- reads ----------------------------------------------------------------------------------

async function loadTasks(ctxId) {
  if (loading.has(ctxId)) { stale.add(ctxId); return; }
  loading.add(ctxId);
  try {
    const res = await fetch(`/api/project-views/tasks/${encodeURIComponent(ctxId)}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.tasks)) boards.set(ctxId, data.tasks);
    else if (!boards.has(ctxId)) boards.set(ctxId, []);   // asked again on the next ping, not every render
  } catch {
    if (!boards.has(ctxId)) boards.set(ctxId, []);
  } finally {
    loading.delete(ctxId);
  }
  if (stale.delete(ctxId)) return loadTasks(ctxId);
  render();
}

/** Ask about the board's tabs: the ones one-liners.js finds worth asking, in one request. */
function fetchFacts() {
  if (!up) return null;
  const view = currentView();
  return view ? facts.want((cb.memberTabs?.(view) || []).map(t => t.id)) : null;
}

export function init(callbacks) {
  cb = callbacks || {};
  render();
}
