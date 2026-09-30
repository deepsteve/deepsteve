// Tasks app: the shell around a view.
//
// The shell owns everything that is the same whatever the tasks look like: the list (from the
// Tasks mod's store), which task is selected, the selected task's terminal, and getting to a
// session. The view — the iframe on the left — owns only how the tasks are drawn, and reaches the
// shell through window.taskApp (views/README.md is its contract). That split is what lets an
// agent rewrite the view freely: a broken view cannot lose a task or strand a session.

const $ = (id) => document.getElementById(id);

const STORE = {
  view: 'tasks-app:view',
  selected: 'tasks-app:selected',
  width: 'tasks-app:right-width',
};
const DEFAULT_VIEW = 'board';
const VIEW_POLL_MS = 2000;
// A session closing does not re-broadcast the task list (see mods/tasks/tools.js), so the shell
// re-reads it on this tick, as the panel does.
const TASKS_POLL_MS = 60 * 1000;
const PENDING_VISIT_MS = 30 * 1000;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_RANK = { 'in-progress': 0, pending: 1, done: 2 };

let tasks = [];
let selectedId = Number(localStorage.getItem(STORE.selected)) || null;
let viewOrder = null;         // task ids in the order the view draws them; null until it says
let views = [];
// The view the user chose, which may not exist yet (an agent is still writing it), and the one
// actually loaded, which falls back to the board until it does.
let wantedView = localStorage.getItem(STORE.view) || DEFAULT_VIEW;
let currentView = null;
let loadedMtime = null;
let projects = [];
let localIds = new Set();     // sessions this window has a tab for — getSessions() is window-scoped
let pendingVisit = null;      // { id, label, until }: a session we asked for, not in this window yet
let onExcursion = false;
let previewSeconds = 1;
let screenTimer = null;
let composerMode = null;
let resetArmed = false;
const chosenSession = new Map();  // taskId -> the session the user picked in the chip row
const startChoice = new Map();    // taskId -> the project directory the user picked for + Session
const screenState = new Map();    // sessionId -> 'busy' | 'idle' | 'unknown', from the last read
let api = null;                   // the taskApp the loaded view holds

const ds = () => window.deepsteve || null;
const windowId = () => ds()?.getWindowId?.() || null;
const byId = (id) => tasks.find((t) => t.id === id) || null;
const offscreen = () => window.innerWidth === 0 || document.visibilityState !== 'visible';

// ── server ───────────────────────────────────────────────────────────────────

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

async function refreshTasks() {
  try { setTasks((await request('GET', '/api/tasks')).tasks || []); } catch {}
}

// ── task list and selection ──────────────────────────────────────────────────

/** Open work first, by priority then newest; done work last, newest first. */
function defaultOrder() {
  return [...tasks].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1)
    || (a.status === 'done' ? 0 : (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1))
    || b.created - a.created,
  ).map((t) => t.id);
}

function order() {
  if (!viewOrder) return defaultOrder();
  const known = new Set(tasks.map((t) => t.id));
  return viewOrder.filter((id) => known.has(id));
}

function setTasks(list) {
  tasks = Array.isArray(list) ? list : [];
  if (!byId(selectedId)) {
    const first = order()[0];
    selectedId = first === undefined ? null : first;
  }
  api?.emitTasks();
  render();
}

function select(id) {
  if (id === selectedId || !byId(id)) return;
  selectedId = id;
  localStorage.setItem(STORE.selected, String(id));
  api?.emitSelect();
  render();
}

function move(delta) {
  const ids = order();
  if (!ids.length) return;
  const at = ids.indexOf(selectedId);
  const next = at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + delta));
  select(ids[next]);
}

// ── sessions ─────────────────────────────────────────────────────────────────

/** The session the terminal pane shows: the one picked, else live, else reopenable, else any. */
function currentSession(task) {
  if (!task || !task.sessions.length) return null;
  const picked = task.sessions.find((s) => s.id === chosenSession.get(task.id));
  return picked
    || task.sessions.find((s) => s.state === 'live')
    || task.sessions.find((s) => s.state === 'closed' || s.state === 'saved')
    || task.sessions[0];
}

function visit(sessionId, task, replace = false) {
  const bridge = ds();
  if (bridge?.visitSession) bridge.visitSession(sessionId, { label: task.title, reason: 'task', replace });
  else bridge?.focusSession?.(sessionId);
}

/** Visit a session as soon as this window has a tab for it — a restore or a spawn takes a moment. */
function expectVisit(sessionId, task) {
  if (localIds.has(sessionId)) { visit(sessionId, task); return; }
  pendingVisit = { id: sessionId, task, until: Date.now() + PENDING_VISIT_MS };
}

/**
 * Go to a task's terminal. A live tab in this window is an excursion; anything else goes through
 * #719's open route, which focuses a live session where it is or restores a closed one here.
 * Returns whether it went anywhere, so a ⌘↓ walk can step past tasks with nothing to show.
 */
async function openTask(id, { replace = false, quiet = false } = {}) {
  const task = byId(id);
  const s = currentSession(task);
  if (!s || s.state === 'gone') return false;
  if (s.state === 'live' && localIds.has(s.id)) {
    visit(s.id, task, replace);
    return true;
  }
  if (quiet) return false;   // a queue walk only lands on tabs this window can show
  try {
    await request('POST', `/api/tasks/${task.id}/sessions/${encodeURIComponent(s.id)}/open`, { windowId: windowId() });
    // A restore, or a live session whose own window is gone, arrives here as a new tab; a live one
    // whose window is still connected is brought forward over there instead.
    expectVisit(s.id, task);
    setTimeout(() => {
      if (pendingVisit?.id !== s.id) return;
      pendingVisit = null;
      toast('That session is open in another window, so it was brought forward there.', 'info');
    }, 4000);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

async function startSession(task) {
  const cwd = $('start-dir').value;
  if (!cwd) { toast('Choose the project this task belongs to first.'); return; }
  $('start-btn').disabled = true;
  try {
    const r = await request('POST', `/api/tasks/${task.id}/start`, { cwd, windowId: windowId() });
    chosenSession.set(task.id, r.id);
    await refreshTasks();
    expectVisit(r.id, task);
  } catch (e) {
    toast(e.message);
  } finally {
    $('start-btn').disabled = !$('start-dir').value;
  }
}

// ── the taskApp a view holds ─────────────────────────────────────────────────

/**
 * One per loaded view, bound to that view's name. A view that is still unloading when the next
 * one loads keeps its own object, so a late saveState cannot land on the wrong view, and dispose()
 * drops its subscriptions.
 */
function makeApi(viewName) {
  const taskSubs = new Set();
  const selectSubs = new Set();
  const call = (cb, v) => { try { cb(v); } catch (e) { console.error('[tasks-app view]', e); } };
  const subscribe = (set, cb, now) => { set.add(cb); call(cb, now); return () => set.delete(cb); };
  return {
    version: 1,
    getTasks: () => tasks,
    onTasks: (cb) => subscribe(taskSubs, cb, tasks),
    getSelected: () => selectedId,
    select: (id) => select(Number(id)),
    onSelect: (cb) => subscribe(selectSubs, cb, selectedId),
    open: (id) => openTask(Number(id)),
    setStatus: (id, status) => setStatus(Number(id), status),
    addTask: async (task) => {
      const r = await request('POST', '/api/tasks', task || {});
      await refreshTasks();
      return r.task;
    },
    setOrder: (ids) => { viewOrder = Array.isArray(ids) ? ids.map(Number) : null; },
    loadState: async () => (await request('GET', `/api/tasks-app/views/${viewName}/state`)).state,
    saveState: (state) => request('PUT', `/api/tasks-app/views/${viewName}/state`, { state }),
    getProjects: () => projects.map(({ id, name, dirs }) => ({ id, name, dirs: [...(dirs || [])] })),
    emitTasks: () => taskSubs.forEach((cb) => call(cb, tasks)),
    emitSelect: () => selectSubs.forEach((cb) => call(cb, selectedId)),
    dispose: () => { taskSubs.clear(); selectSubs.clear(); },
  };
}

async function setStatus(id, status) {
  const task = byId(id);
  if (!task || task.status === status) return;
  const before = task.status;
  task.status = status;           // optimistic: the view redraws now, the broadcast confirms
  api?.emitTasks();
  render();
  try {
    await request('POST', `/api/tasks/${id}/status`, { status });
  } catch (e) {
    task.status = before;
    api?.emitTasks();
    render();
    toast(e.message);
  }
}

// ── the view ─────────────────────────────────────────────────────────────────

function chooseView(name) {
  wantedView = name;
  localStorage.setItem(STORE.view, name);
  loadView();
}

function viewToLoad() {
  if (views.some((v) => v.name === wantedView)) return wantedView;
  return views.some((v) => v.name === DEFAULT_VIEW) ? DEFAULT_VIEW : views[0]?.name || null;
}

function loadView() {
  const name = viewToLoad();
  if (!name) return;
  currentView = name;
  loadedMtime = views.find((v) => v.name === name)?.mtime ?? null;
  viewOrder = null;
  resetArmed = false;
  api?.dispose();
  api = makeApi(name);
  window.taskApp = api;
  $('view-frame').src = `/api/tasks-app/views/${name}?t=${loadedMtime || 0}`;
  renderViewBar();
}

async function pollViews() {
  if (offscreen()) return;
  try {
    views = (await request('GET', '/api/tasks-app/views')).views || [];
  } catch { return; }
  const cur = views.find((v) => v.name === currentView);
  // Hot reload: an agent editing the file sees each save land. A view the user chose that has
  // only now been written loads here too.
  if (viewToLoad() !== currentView || !cur || cur.mtime !== loadedMtime) loadView();
  else renderViewBar();
}

/** Keys typed inside the view reach the shell too. A view that uses one calls preventDefault. */
function wireViewFrame() {
  const win = $('view-frame').contentWindow;
  if (!win) return;
  // The host's ⌘H guard (#704) covers the app's window, not a frame nested inside it.
  win.addEventListener('keydown', (e) => {
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'h') e.preventDefault();
  }, true);
  win.addEventListener('keydown', onKey);
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderViewBar() {
  const tabs = $('view-tabs');
  tabs.replaceChildren(...views.map((v) => {
    const b = document.createElement('button');
    b.textContent = v.name;
    b.className = v.name === currentView ? 'active' : '';
    b.title = v.custom ? (v.builtin ? 'Custom copy of a built-in view' : 'Custom view') : 'Built-in view';
    if (v.custom) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '•';
      b.append(dot);
    }
    b.onclick = () => { if (v.name !== currentView) chooseView(v.name); };
    return b;
  }));
  const cur = views.find((v) => v.name === currentView);
  const reset = $('reset-view-btn');
  reset.classList.toggle('hidden', !cur?.custom);
  reset.textContent = resetArmed ? (cur?.builtin ? 'Delete your copy?' : 'Delete this view?') : (cur?.builtin ? 'Reset' : 'Delete');
}

function sessionWords(s) {
  if (s.state === 'live') return screenState.get(s.id) === 'busy' ? 'working' : 'live';
  if (s.state === 'closed') return s.closedAt ? `closed ${timeAgo(s.closedAt)}` : 'closed';
  if (s.state === 'saved') return 'not running';
  return 'gone';
}

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * The project picker for + Session. It never guesses: a task whose project is unknown (written
 * before #719 attached a caller, or added in the app) shows "Choose a project…" and the button
 * stays off until the user names one. Defaulting to the first project is how a yarnstory task
 * got a session in deepsteve-experimental.
 */
function renderStartDirs(task) {
  const sel = $('start-dir');
  if (document.activeElement === sel) return;   // rebuilding it would close it under the cursor
  const options = projects.filter((p) => !p.archived).flatMap((p) => (p.dirs || []).map((dir) => ({
    dir, label: (p.dirs.length > 1 ? `${p.name} · ${dir.split('/').pop()}` : p.name),
  })));
  // The user's pick outlives a re-render, which happens on every tab and task change.
  const want = [startChoice.get(task.id), task.project?.dir].find((d) => d && options.some((o) => o.dir === d)) || '';
  const items = options.map(({ dir, label }) => {
    const o = document.createElement('option');
    o.value = dir;
    o.textContent = label;
    o.title = dir;
    return o;
  });
  if (!want) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose a project…';
    items.unshift(none);
  }
  sel.replaceChildren(...items);
  sel.value = want;
  $('start-btn').disabled = !want;
}

function render() {
  const task = byId(selectedId);
  $('detail').classList.toggle('hidden', !task);
  $('sessions').classList.toggle('hidden', !task);
  if (!task) {
    stopScreen();
    $('term-bar').classList.add('hidden');
    $('screen').classList.add('hidden');
    $('empty').classList.remove('hidden');
    $('empty').innerHTML = tasks.length
      ? 'Select a task.'
      : 'No tasks yet.<br><span>Agents add them with <code>add_task</code>, or press <kbd>n</kbd>.</span>';
    return;
  }

  const d = $('detail');
  d.querySelector('.id').textContent = `#${task.id}`;
  d.querySelector('h1').textContent = task.title;
  d.querySelector('.desc').textContent = task.description || '';
  d.querySelector('.desc').classList.toggle('hidden', !task.description);
  for (const b of $('status-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.status === task.status);
  const proj = d.querySelector('.project');
  proj.textContent = task.project?.name || '';
  proj.title = task.project?.dir || '';
  proj.classList.toggle('hidden', !task.project);
  $('priority').textContent = task.priority && task.priority !== 'medium' ? `${task.priority} priority` : '';

  const shown = currentSession(task);
  $('chips').replaceChildren(...task.sessions.map((s) => {
    const c = document.createElement('span');
    c.className = `chip ${s.state}${screenState.get(s.id) === 'busy' ? ' busy' : ''}${shown && s.id === shown.id ? ' on' : ''}`;
    c.innerHTML = '<span class="led"></span>';
    c.append(`${s.label} · ${sessionWords(s)}`);
    c.title = s.id;
    c.onclick = () => { chosenSession.set(task.id, s.id); render(); };
    c.ondblclick = () => { chosenSession.set(task.id, s.id); openTask(task.id); };
    return c;
  }));
  renderStartDirs(task);

  const bar = $('term-bar');
  const empty = $('empty');
  const screen = $('screen');
  if (!shown) {
    stopScreen();
    bar.classList.add('hidden');
    screen.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = task.project
      ? 'No session for this task yet.<br><span>Press <b>+ Session</b> to start one.</span>'
      : 'No session for this task yet, and no project.<br><span>Choose the project it belongs to, then press <b>+ Session</b>.</span>';
    return;
  }
  bar.classList.remove('hidden');
  bar.querySelector('.name').textContent = shown.label;
  $('term-state').textContent = sessionWords(shown);
  const openBtn = $('open-btn');
  if (shown.state === 'live') {
    openBtn.textContent = localIds.has(shown.id) ? 'Open terminal ⏎' : 'Bring forward ⏎';
    openBtn.classList.remove('hidden');
    empty.classList.add('hidden');
    screen.classList.remove('hidden');
    startScreen(task, shown);
  } else {
    stopScreen();
    screen.classList.add('hidden');
    empty.classList.remove('hidden');
    openBtn.textContent = 'Reopen ⏎';
    openBtn.classList.toggle('hidden', shown.state === 'gone');
    empty.textContent = shown.state === 'gone'
      ? 'This session was removed by the closed-session retention sweep and can\'t be reopened.'
      : 'This session isn\'t running. Reopen brings it back with its conversation.';
  }
}

// ── terminal preview ─────────────────────────────────────────────────────────

let screenFor = null;   // `${taskId}:${sessionId}` the timer is reading

function startScreen(task, s) {
  const key = `${task.id}:${s.id}`;
  if (screenFor === key && screenTimer) return;
  stopScreen();
  screenFor = key;
  $('screen').textContent = '';
  const tick = async () => {
    if (screenFor !== key) return;
    if (!offscreen() && !onExcursion) await readScreen(task.id, s.id, key);
    if (screenFor === key) screenTimer = setTimeout(tick, Math.max(0.25, previewSeconds) * 1000);
  };
  tick();
}

function stopScreen() {
  clearTimeout(screenTimer);
  screenTimer = null;
  screenFor = null;
}

async function readScreen(taskId, sessionId, key) {
  const el = $('screen');
  const lineHeight = 1.25;
  let size = parseFloat(el.style.fontSize) || 11;
  const rows = Math.max(4, Math.floor((el.clientHeight - 16) / (size * lineHeight)));
  let data;
  try {
    data = await request('GET', `/api/tasks/${taskId}/sessions/${encodeURIComponent(sessionId)}/screen?lines=${rows}`);
  } catch {
    // 409 not-live: it closed since the list was read. The next task refresh redraws the pane.
    if (screenFor === key) { stopScreen(); refreshTasks(); }
    return;
  }
  if (screenFor !== key) return;
  const lines = data.lines || [];
  // Size the text so the widest line fits. Rounded up to 20 columns so it does not jitter as
  // lines of different lengths scroll through.
  const cols = Math.ceil(Math.max(80, ...lines.map((l) => l.length)) / 20) * 20;
  size = Math.max(7, Math.min(13, (el.clientWidth - 20) / (cols * 0.6)));
  el.style.fontSize = `${size.toFixed(2)}px`;
  el.textContent = lines.slice(-rows).join('\n');
  const was = screenState.get(sessionId);
  screenState.set(sessionId, data.state || 'unknown');
  if (was !== data.state) render();
}

// ── composer: new task, edit view, new view ─────────────────────────────────

const COMPOSER = {
  task: { label: 'New task', placeholder: 'What needs doing?', go: 'Add' },
  edit: { label: null, placeholder: 'e.g. group the cards by project, or make it a 3D city', go: 'Start agent' },
  'new-view': { label: 'Ask an agent to build a new view', placeholder: 'What should it show, and how?', go: 'Start agent' },
};

function openComposer(mode) {
  composerMode = mode;
  const c = COMPOSER[mode];
  $('composer').classList.remove('hidden');
  $('composer-label').textContent = c.label || `Ask an agent to change the “${currentView}” view. Leave it blank and the agent asks you.`;
  $('composer-text').placeholder = c.placeholder;
  $('composer-text').value = '';
  $('composer-go').textContent = c.go;
  $('composer-name').classList.toggle('hidden', mode !== 'new-view');
  $('composer-name').value = '';
  (mode === 'new-view' ? $('composer-name') : $('composer-text')).focus();
}

function closeComposer() {
  composerMode = null;
  $('composer').classList.add('hidden');
}

async function submitComposer() {
  const text = $('composer-text').value.trim();
  const go = $('composer-go');
  go.disabled = true;
  try {
    if (composerMode === 'task') {
      if (!text) return;
      const r = await request('POST', '/api/tasks', { title: text });
      await refreshTasks();
      select(r.task.id);
    } else {
      const name = composerMode === 'new-view' ? $('composer-name').value.trim() : currentView;
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) { toast('A view name is lowercase letters, digits and dashes.'); return; }
      const r = await request('POST', `/api/tasks-app/views/${name}/edit`, { request: text, windowId: windowId() });
      if (composerMode === 'new-view') chooseView(name);
      expectVisit(r.id, { title: `view: ${name}` });
      pollViews();
    }
    closeComposer();
  } catch (err) {
    toast(err.message);
  } finally {
    go.disabled = false;
  }
}

async function resetView() {
  const cur = views.find((v) => v.name === currentView);
  if (!cur?.custom) return;
  if (!resetArmed) { resetArmed = true; renderViewBar(); setTimeout(() => { resetArmed = false; renderViewBar(); }, 4000); return; }
  resetArmed = false;
  try {
    await request('DELETE', `/api/tasks-app/views/${cur.name}`);
    await pollViews();
  } catch (e) {
    toast(e.message);
  }
}

// ── keys, divider, toast ─────────────────────────────────────────────────────

function isTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function onKey(e) {
  if (e.defaultPrevented) return;
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    ds()?.toggleQuiet?.();
    return;
  }
  if (e.key === 'Escape' && composerMode) { closeComposer(); return; }
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter' && e.target?.tagName === 'BUTTON') return;   // the button's own click
  const act = {
    j: () => move(1), ArrowDown: () => move(1),
    k: () => move(-1), ArrowUp: () => move(-1),
    Enter: () => openTask(selectedId), o: () => openTask(selectedId),
    n: () => openComposer('task'),
  }[e.key];
  if (!act) return;
  e.preventDefault();
  act();
}

function wireDivider() {
  const saved = Number(localStorage.getItem(STORE.width));
  if (saved) $('right').style.width = `${saved}px`;
  const div = $('divider');
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.classList.add('dragging');
    $('view-frame').style.pointerEvents = 'none';
    const moveTo = (ev) => {
      const w = Math.max(320, Math.min(window.innerWidth - 260, window.innerWidth - ev.clientX));
      $('right').style.width = `${w}px`;
    };
    const up = () => {
      div.classList.remove('dragging');
      $('view-frame').style.pointerEvents = '';
      document.removeEventListener('pointermove', moveTo);
      document.removeEventListener('pointerup', up);
      localStorage.setItem(STORE.width, String(parseInt($('right').style.width, 10)));
    };
    document.addEventListener('pointermove', moveTo);
    document.addEventListener('pointerup', up);
  });
}

let toastTimer = null;
function toast(msg, kind = 'error') {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind === 'info' ? 'info' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

// ── startup ──────────────────────────────────────────────────────────────────

function wireBridge(bridge) {
  bridge.onTasksChanged?.((list) => setTasks(list));
  bridge.onContextsChanged?.((list) => { projects = list || []; render(); });
  bridge.onSessionsChanged?.((list) => {
    const before = localIds;
    localIds = new Set((list || []).map((s) => s.id));
    if (pendingVisit && Date.now() > pendingVisit.until) pendingVisit = null;
    if (pendingVisit && localIds.has(pendingVisit.id)) {
      const { id, task } = pendingVisit;
      pendingVisit = null;
      visit(id, task);
    }
    // A tab closing here is the one session change this window hears about first.
    if ([...before].some((id) => !localIds.has(id))) setTimeout(refreshTasks, 800);
    render();
  });
  bridge.onExcursionChanged?.((st) => {
    const was = onExcursion;
    onExcursion = !!(st && st.depth > 0);
    if (was && !onExcursion) refreshTasks();
  });
  // ⌘↑/⌘↓ while out in a terminal: walk the view's order, landing only on tasks with a tab here.
  bridge.onExcursionCycle?.(async ({ delta }) => {
    const ids = order();
    let i = ids.indexOf(selectedId);
    for (let steps = 0; steps < ids.length; steps++) {
      i += delta;
      if (i < 0 || i >= ids.length) return;
      if (await openTask(ids[i], { replace: true, quiet: true })) { select(ids[i]); return; }
    }
  });
  const s = bridge.getSettings?.() || {};
  if (Number(s.previewSeconds) > 0) previewSeconds = Number(s.previewSeconds);
  bridge.onSettingsChanged?.((next) => { if (Number(next?.previewSeconds) > 0) previewSeconds = Number(next.previewSeconds); });
}

function start() {
  wireDivider();
  document.addEventListener('keydown', onKey);
  $('view-frame').addEventListener('load', wireViewFrame);
  $('status-seg').addEventListener('click', (e) => {
    const status = e.target.closest('button')?.dataset.status;
    if (status && selectedId) setStatus(selectedId, status);
  });
  $('open-btn').onclick = () => openTask(selectedId);
  $('screen').onclick = () => openTask(selectedId);
  $('start-btn').onclick = () => { const t = byId(selectedId); if (t) startSession(t); };
  $('start-dir').onchange = () => {
    if (selectedId) startChoice.set(selectedId, $('start-dir').value);
    $('start-btn').disabled = !$('start-dir').value;
  };
  $('add-task-btn').onclick = () => openComposer('task');
  $('edit-view-btn').onclick = () => openComposer('edit');
  $('new-view-btn').onclick = () => openComposer('new-view');
  $('reset-view-btn').onclick = resetView;
  $('composer-go').onclick = submitComposer;
  for (const input of [$('composer-name'), $('composer-text')]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitComposer(); } });
  }
  $('composer-cancel').onclick = closeComposer;

  pollViews();
  setInterval(pollViews, VIEW_POLL_MS);
  setInterval(() => { if (!offscreen()) refreshTasks(); }, TASKS_POLL_MS);
  // Coming back to the window: the one-second preview was paused, and tasks may have moved.
  document.addEventListener('visibilitychange', () => { if (!offscreen()) refreshTasks(); });

  // The host sets window.deepsteve on the iframe's load event, after this module has run.
  if (ds()) { wireBridge(ds()); return; }
  refreshTasks();
  const wait = setInterval(() => {
    if (!ds()) return;
    clearInterval(wait);
    wireBridge(ds());
  }, 100);
}

start();
