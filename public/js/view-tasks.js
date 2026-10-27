/**
 * Task boards — a view's tasks.
 *
 * A selectable project view with `tasks: true` gets a board while it is the selected view: a
 * tab-shaped button at the head of the strip, like view-cards.js's superview, that opens the
 * project's tasks over the terminal area. A task is an ad hoc grouping of the view's agent tabs.
 * On the left is Ungrouped — the tabs in no task — which collapses to a narrow strip; then one
 * card per task; then "+ New task". A project's board starts empty.
 *
 * A tab is in at most one of a project's tasks, so a drag moves it: onto a card files it there,
 * onto Ungrouped takes it out, onto "+ New task" makes a task holding it. ⌘/Ctrl-click and
 * ⇧-click select several, and dragging any selected tab drags them all. A plain click opens the
 * tab, exactly as clicking it in the strip would — which takes the board down.
 *
 * The tasks are the daemon's (mods/project-mods/view-tasks.js), per project, so every window
 * sees one board: /api/project-views/tasks/:contextId, and a `view-tasks` ping when any window
 * writes. A write is drawn at once and then replaced by the daemon's answer; a failed one says
 * so and refetches. A task keeps a tab's id after it closes, so a reopened tab is back on its
 * card, but the board draws only this window's tabs; a task's tabs open in another window are
 * counted on its card, not drawn.
 *
 * The rows show each tab's first prompt, from the same GET /api/project-views/cards the cards
 * superview reads.
 *
 * Like view-cards.js this never imports project-views.js or context-views.js; app.js injects
 * what it needs. render() is called from the end of every filter pass and never asks for one.
 * A rebuild while a drag or a title edit is under way would pull the element out from under
 * it, so the pane waits for either to finish.
 */

import { nsKey } from './storage-namespace.js';

const POLL_MS = 5000;
const BOARD_GLYPH = '▥';
const DRAG_TYPE = 'application/x-deepsteve-sessions';
const TITLE_MAX = 120;
// Ungrouped collapsed or not. localStorage: it is "how it looks", like the views bar's expanded
// state, not a place.
const UNGROUPED_KEY = nsKey('deepsteve-view-tasks-ungrouped');

let cb = {};
let tabEl = null;
let paneEl = null;
let up = false;          // is the board showing — this window only, so a reload starts with it down
let upFor = null;        // `${contextId}|${slug}` the board was opened for
let pollTimer = null;
let paneSig = null;
let fetchingPrompts = false;
const prompts = new Map();   // tab id → { prompt, supported }, once the server has answered
const boards = new Map();    // context id → [{ id, title, created, sessions: [{ id, live }] }]
const loading = new Set();   // context ids with a GET in flight
const stale = new Set();     // …and pinged during it, so asked again when it lands
let selected = new Set();    // tab ids picked with ⌘/⇧-click, in the order picked
let anchor = null;           // { list, id }: where a ⇧-click range starts
let dragIds = null;          // the tabs being dragged, while one of our drags is on
let editing = false;         // a title input is open
let pendingEdit = null;      // a task id whose title opens for editing once its card is drawn
let deferred = false;        // a redraw skipped while dragging or editing
let titleEls = new Map();    // task id → its title button, as last drawn

export const isUp = () => up;

const ctxNow = () => cb.getActiveContext?.() || null;
const keyOf = (ctx, view) => (ctx && view ? `${ctx.id}|${view.slug}` : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function isCollapsed() {
  try { return localStorage.getItem(UNGROUPED_KEY) === '1'; } catch { return false; }
}

function setCollapsed(on) {
  try { on ? localStorage.setItem(UNGROUPED_KEY, '1') : localStorage.removeItem(UNGROUPED_KEY); } catch { /* private mode */ }
}

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
    if (!pollTimer) pollTimer = setInterval(fetchPrompts, POLL_MS);
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

/** Another window (or this one) changed a project's tasks. Refetch if we hold that board. */
export function onPing(contextId) {
  if (boards.has(contextId) || loading.has(contextId)) loadTasks(contextId);
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
  // The superview's count is the number of tasks, so it is fetched as soon as the view shows.
  if (view && !boards.has(ctx.id) && !loading.has(ctx.id)) loadTasks(ctx.id);
  const tasks = view ? boards.get(ctx.id) || [] : [];

  if (el) {
    el.classList.toggle('hidden', !view);
    el.classList.toggle('active', up && !!view);
    el.setAttribute('aria-selected', up && view ? 'true' : 'false');
    if (view) {
      const [, , label, count] = el.children;
      el.title = 'Show this project’s tasks and the tabs in each';
      label.textContent = view.name;
      count.textContent = String(tasks.length);
    }
  }
  renderPane(ctx, view);
}

/** Every move is the same rule as the daemon's: out of every task, then into `to` (if any). */
export function applyMove(tasks, ids, to) {
  return tasks.map((t) => {
    const kept = t.sessions.filter(s => !ids.includes(s.id));
    return t.id === to ? { ...t, sessions: [...kept, ...ids.map(id => ({ id, live: true }))] } : { ...t, sessions: kept };
  });
}

/**
 * What the board draws: this window's tabs in the view, split into Ungrouped and one list per
 * task (in the task's order), plus how many of a task's live tabs are in another window.
 */
export function layout(tasks, tabs, hasTab = () => false) {
  const here = new Map(tabs.map(t => [t.id, t]));
  const grouped = new Set(tasks.flatMap(t => t.sessions.map(s => s.id)));
  return {
    ungrouped: tabs.filter(t => !grouped.has(t.id)),
    cards: tasks.map(task => ({
      task,
      tabs: task.sessions.map(s => here.get(s.id)).filter(Boolean),
      elsewhere: task.sessions.filter(s => s.live && !here.has(s.id) && !hasTab(s.id)).length,
    })),
  };
}

function renderPane(ctx, view) {
  const pane = ensurePane();
  if (!pane) return;
  const showing = up && !!view;
  pane.classList.toggle('hidden', !showing);
  if (!showing) { paneSig = null; return; }
  if (dragIds || editing) { deferred = true; return; }
  deferred = false;

  const tabs = cb.memberTabs?.(view) || [];
  const tasks = boards.get(ctx.id) || [];
  const collapsed = isCollapsed();
  const lay = layout(tasks, tabs, cb.hasTab);
  const drawn = [...lay.ungrouped, ...lay.cards.flatMap(c => c.tabs)];
  const sig = JSON.stringify([ctx.name, view.slug, view.name, view.icon, collapsed, [...selected],
    tasks.map(t => [t.id, t.title, t.sessions]), tabs.map(t => [t.id, t.name, !!t.current]),
    drawn.map(t => prompts.get(t.id) || null)]);
  if (sig !== paneSig) {
    paneSig = sig;
    draw(pane, ctx, view, tabs, tasks, lay, collapsed);
  }
  // A tab that joined while the board is up is asked about at once rather than at the next poll.
  if (drawn.some(t => !prompts.has(t.id))) fetchPrompts();
}

function draw(pane, ctx, view, tabs, tasks, lay, collapsed) {
  pane.replaceChildren();
  titleEls = new Map();
  const head = document.createElement('div');
  head.className = 'view-tasks-head';
  const title = document.createElement('span');
  title.className = 'view-tasks-title';
  title.textContent = view.icon ? `${view.icon} ${view.name}` : view.name;
  const sub = document.createElement('span');
  sub.className = 'view-tasks-sub';
  sub.textContent = `${plural(tasks.length, 'task', 'tasks')} · ${plural(tabs.length, 'tab', 'tabs')}${ctx.name ? ` in ${ctx.name}` : ''}`;
  head.append(title, sub);

  const board = document.createElement('div');
  board.className = 'view-tasks-board';
  board.append(ungroupedColumn(lay.ungrouped, tabs.length, collapsed));
  const cards = document.createElement('div');
  cards.className = 'view-tasks-cards';
  for (const c of lay.cards) cards.appendChild(taskCard(c));
  cards.appendChild(newTaskCard(tasks.length === 0));
  board.appendChild(cards);
  pane.append(head, board);

  if (pendingEdit && titleEls.has(pendingEdit)) {
    const id = pendingEdit;
    pendingEdit = null;
    renameTask(titleEls.get(id), id);
  }
}

function ungroupedColumn(list, total, collapsed) {
  const col = document.createElement('div');
  col.className = 'view-tasks-ungrouped' + (collapsed ? ' collapsed' : '');
  const toggle = document.createElement('button');
  toggle.className = 'view-tasks-col-head';
  toggle.title = collapsed ? 'Show the tabs in no task' : 'Hide the tabs in no task';
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const caret = document.createElement('span');
  caret.className = 'view-tasks-caret';
  caret.textContent = collapsed ? '▸' : '▾';
  const name = document.createElement('span');
  name.className = 'view-tasks-col-name';
  name.textContent = 'Ungrouped';
  const count = document.createElement('span');
  count.className = 'view-tasks-col-count';
  count.textContent = String(list.length);
  toggle.append(caret, name, count);
  toggle.addEventListener('click', () => { setCollapsed(!collapsed); render(); });
  col.appendChild(toggle);
  if (!collapsed) {
    if (list.length) {
      col.appendChild(sessionList(list, 'ungrouped'));
    } else {
      const empty = document.createElement('div');
      empty.className = 'view-tasks-empty';
      empty.textContent = total ? 'Every tab here is in a task.' : 'No agent tabs are open in this view.';
      col.appendChild(empty);
    }
  }
  dropTarget(col, (ids) => moveTabs(ids, null));
  return col;
}

function taskCard({ task, tabs, elsewhere }) {
  const card = document.createElement('div');
  card.className = 'view-task';
  card.dataset.task = task.id;
  const head = document.createElement('div');
  head.className = 'view-task-head';
  const title = document.createElement('button');
  title.className = 'view-task-title';
  title.textContent = task.title;
  title.title = 'Rename this task';
  title.addEventListener('click', () => renameTask(title, task.id));
  titleEls.set(task.id, title);
  const count = document.createElement('span');
  count.className = 'view-task-count';
  count.textContent = String(tabs.length + elsewhere);
  const del = document.createElement('button');
  del.className = 'view-task-delete';
  del.textContent = '×';
  del.title = 'Delete this task — its tabs go back to Ungrouped';
  del.setAttribute('aria-label', `Delete ${task.title}`);
  del.addEventListener('click', () => deleteTask(task.id));
  head.append(title, count, del);
  card.appendChild(head);
  if (tabs.length) card.appendChild(sessionList(tabs, task.id));
  if (elsewhere) {
    const more = document.createElement('div');
    more.className = 'view-task-more';
    more.textContent = `+${plural(elsewhere, 'tab', 'tabs')} in another window`;
    card.appendChild(more);
  }
  if (!tabs.length && !elsewhere) {
    const empty = document.createElement('div');
    empty.className = 'view-tasks-empty';
    empty.textContent = 'Drag tabs here.';
    card.appendChild(empty);
  }
  dropTarget(card, (ids) => moveTabs(ids, task.id));
  return card;
}

function newTaskCard(first) {
  const card = document.createElement('div');
  card.className = 'view-task view-task-new';
  const btn = document.createElement('button');
  btn.className = 'view-task-new-btn';
  btn.textContent = '+ New task';
  card.title = 'Make a task, then drag tabs onto it';
  card.appendChild(btn);
  // The whole card is the button: there is nothing else on it to click. The button stays for
  // the keyboard, and its click bubbles here. Once the name field has replaced it, a click in
  // the field must not start a second one, and a press on the rest of the card must not blur
  // the field — a blur ends the edit, so the card would close what it just opened.
  let field = null;
  card.addEventListener('click', () => {
    if (btn.parentNode !== card) return;
    field = editTitle(btn, '', (title) => { if (title) createTask({ title }); });
  });
  card.addEventListener('mousedown', (e) => {
    if (field && field.isConnected && e.target !== field) e.preventDefault();
  });
  if (first) {
    const hint = document.createElement('div');
    hint.className = 'view-tasks-empty';
    hint.textContent = 'Make a task, then drag tabs onto it — or drop tabs here to make one.';
    card.appendChild(hint);
  }
  dropTarget(card, (ids) => createTask({ sessions: ids, edit: true }));
  return card;
}

function sessionList(list, key) {
  const el = document.createElement('div');
  el.className = 'view-tasks-list';
  const order = list.map(t => t.id);
  for (const t of list) el.appendChild(sessionRow(t, key, order));
  return el;
}

function promptText(p) {
  if (!p) return { text: 'Loading…', empty: true };
  if (p.prompt) return { text: p.prompt, empty: false };
  return { text: p.supported ? 'No prompt yet' : 'This agent keeps no transcript to read a prompt from', empty: true };
}

function sessionRow(t, key, order) {
  const el = document.createElement('div');
  el.className = 'view-tasks-session' + (selected.has(t.id) ? ' selected' : '') + (t.current ? ' current' : '');
  el.dataset.id = t.id;
  el.draggable = true;
  el.title = `Open ${t.name} · ⌘-click or ⇧-click to select several`;
  const name = document.createElement('span');
  name.className = 'view-tasks-session-name';
  name.textContent = t.name;
  const { text, empty } = promptText(prompts.get(t.id));
  const prompt = document.createElement('span');
  prompt.className = 'view-tasks-session-prompt' + (empty ? ' empty' : '');
  prompt.textContent = text;
  el.append(name, prompt);
  el.addEventListener('click', (e) => onRowClick(e, t.id, key, order));
  el.addEventListener('dragstart', (e) => onDragStart(e, t.id));
  el.addEventListener('dragend', () => endDrag());
  return el;
}

function onRowClick(e, id, key, order) {
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
  } else {
    cb.openTab?.(id);
    return;
  }
  render();
}

function onDragStart(e, id) {
  dragIds = selected.has(id) ? [...selected] : [id];
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag that carries no data.
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragIds));
  }
  e.currentTarget?.classList?.add('dragging');
}

function endDrag() {
  if (!dragIds) return;
  dragIds = null;
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
    dragIds = null;
    onDrop(ids);
  });
}

/** Swap `label` for a one-line input. `done(text)` gets the trimmed text, or null on Escape. */
function editTitle(label, initial, done) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'view-task-title-input';
  input.value = initial;
  input.maxLength = TITLE_MAX;
  input.placeholder = 'Task name';
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

async function createTask({ title, sessions, edit } = {}) {
  const ctx = ctxNow();
  if (!ctx) return;
  selected = new Set();
  anchor = null;
  const data = await send(ctx.id, 'POST', '', { title: title || '', sessions: sessions || [] });
  // Tabs dropped on "+ New task" make a task called "New task"; its name opens for editing.
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

function deleteTask(id) {
  const ctx = ctxNow();
  if (!ctx) return;
  optimistic(ctx.id, (boards.get(ctx.id) || []).filter(t => t.id !== id));
  send(ctx.id, 'DELETE', `/${encodeURIComponent(id)}`);
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

/**
 * Ask the server for the prompts still missing: rows never asked about, and rows whose agent
 * keeps a transcript but has not been prompted yet. One request for all of them.
 */
async function fetchPrompts() {
  if (!up || fetchingPrompts) return;
  const ctx = ctxNow();
  const view = currentView(ctx);
  if (!view) return;
  const need = (cb.memberTabs?.(view) || []).map(t => t.id).filter((id) => {
    const p = prompts.get(id);
    return !p || (!p.prompt && p.supported);
  });
  if (!need.length) return;
  fetchingPrompts = true;
  try {
    const res = await fetch('/api/project-views/cards?ids=' + need.map(encodeURIComponent).join(','));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    for (const id of need) {
      const p = data.prompts && data.prompts[id];
      prompts.set(id, { prompt: (p && p.prompt) || null, supported: !p || p.supported !== false });
    }
  } catch {
    // Read as "no prompt yet", so the row stops saying Loading… and the poll tries again.
    for (const id of need) if (!prompts.has(id)) prompts.set(id, { prompt: null, supported: true });
  } finally {
    fetchingPrompts = false;
  }
  render();
}

export function init(callbacks) {
  cb = callbacks || {};
  render();
}
