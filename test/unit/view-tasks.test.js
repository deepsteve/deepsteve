// Unit tests for task boards — a selectable project view's `tasks`. Four parts:
//
//   - the view file: `tasks` is kept on a view you look at, dropped on an additive one, drops
//     `cards` beside it, round-trips through the file and goes out on the wire;
//   - the store (mods/project-mods/view-tasks.js): tasks per project, a tab in at most one of
//     them, purged sessions forgotten on a write, never on a read;
//   - the routes, /api/project-views/tasks/:contextId: project scoping, live marks, the ping;
//   - the client (public/js/view-tasks.js): the superview, the board it opens, Ungrouped and
//     its collapse, selection, drags, new tasks, renames, and refetching on a ping.
//
// No browser, no daemon: the client runs against stubbed DOM globals and a fake fetch, and the
// module is re-imported with a unique ?query per test so its state starts fresh.
//
// Run: node --test test/unit/view-tasks.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-view-tasks-home-'));
process.env.HOME = HOME;
delete process.env.DEEPSTEVE_HOME;

const views = require('../../mods/project-mods/tools.js');
const { normalizeView, serializeView, viewManifestOf, registerRoutes, setTaskStore } = views;
const { createTaskStore, cleanTitle, cleanSessionIds, DEFAULT_TITLE, MAX_TITLE } = require('../../mods/project-mods/view-tasks.js');

const REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-view-tasks-repo-')));
const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-view-tasks-state-')), 'view-tasks.json');

// ------------------------------------------------------------------- view file

test('tasks is kept on a view you look at, dropped on an additive one, and drops cards beside it', () => {
  const v = normalizeView({ name: 'Tasks', match: [{ kinds: ['agent'] }], tasks: true }, REPO, 'tasks');
  assert.strictEqual(v.tasks, true);
  assert.deepStrictEqual(viewManifestOf(v), { name: 'Tasks', match: [{ kinds: ['agent'] }], tasks: true }, 'written back as read');
  assert.strictEqual(serializeView(v).tasks, true, 'on the wire');

  const both = normalizeView({ name: 'Both', cards: true, tasks: true }, REPO, 'both');
  assert.strictEqual(both.tasks, true);
  assert.strictEqual(both.cards, false, 'a view is a grid or a board, never both');

  const add = normalizeView({ name: 'Side', additive: true, tasks: true }, REPO, 'side');
  assert.strictEqual(add.tasks, false, 'an additive view is never selected, so it has no board to open');

  const plain = normalizeView({ name: 'Plain', tasks: 'yes' }, REPO, 'plain');
  assert.strictEqual(plain.tasks, false, 'only a literal true');
  assert.ok(!('tasks' in viewManifestOf(plain)), 'a false flag is left out of the file');
  assert.strictEqual(serializeView(plain).tasks, false);
});

// ----------------------------------------------------------------------- store

function makeStore(opts = {}) {
  let n = 0;
  return createTaskStore({ file: scratch(), newId: () => `task-${++n}`, now: () => 1000, ...opts });
}

test('titles and session ids are cleaned', () => {
  assert.strictEqual(cleanTitle('  Ship   the\nrelease '), 'Ship the release');
  assert.strictEqual(cleanTitle(42), '');
  assert.strictEqual(cleanTitle('x'.repeat(500)).length, MAX_TITLE);
  assert.deepStrictEqual(cleanSessionIds(['a1', 'a1', '../x', 7, 'b-2', '']), ['a1', 'b-2'], 'well-formed, each once');
  assert.deepStrictEqual(cleanSessionIds('a1'), []);
});

test('a new task goes at the end, named "New task" when nothing was typed', () => {
  const store = makeStore();
  const first = store.create('ctx1', { title: 'Release' });
  assert.deepStrictEqual(first.task, { id: 'task-1', title: 'Release', sessions: [], created: 1000 });
  const second = store.create('ctx1', {});
  assert.strictEqual(second.task.title, DEFAULT_TITLE);
  assert.deepStrictEqual(store.list('ctx1').map(t => t.id), ['task-1', 'task-2'], 'oldest first');
  assert.deepStrictEqual(store.list('ctx2'), [], 'per project');
});

test('a tab is in at most one task: moving it anywhere takes it out of every other', () => {
  const store = makeStore();
  store.create('ctx1', { title: 'A', sessions: ['s1', 's2'] });
  store.create('ctx1', { title: 'B', sessions: ['s2', 's3'] });
  let tasks = store.list('ctx1');
  assert.deepStrictEqual(tasks.map(t => t.sessions), [['s1'], ['s2', 's3']], 'a new task takes s2 from A');

  tasks = store.move('ctx1', ['s1', 's3'], 'task-2').tasks;
  assert.deepStrictEqual(tasks.map(t => t.sessions), [[], ['s2', 's1', 's3']], 'appended in the order given');

  tasks = store.move('ctx1', ['s2'], null).tasks;
  assert.deepStrictEqual(tasks.map(t => t.sessions), [[], ['s1', 's3']], 'null is "in no task"');

  // Another project's tasks are untouched by this one's moves.
  store.create('ctx2', { title: 'Elsewhere', sessions: ['s1'] });
  store.move('ctx1', ['s1'], null);
  assert.deepStrictEqual(store.list('ctx2')[0].sessions, ['s1']);
});

test('rename, delete, and the errors a stale board can send', () => {
  const store = makeStore();
  store.create('ctx1', { title: 'A', sessions: ['s1'] });
  assert.strictEqual(store.rename('ctx1', 'task-1', '  Launch  ').tasks[0].title, 'Launch');
  assert.deepStrictEqual(store.rename('ctx1', 'task-1', '   '), { error: 'title must not be empty', status: 400 });
  assert.strictEqual(store.rename('ctx1', 'nope', 'x').status, 404);
  assert.strictEqual(store.move('ctx1', ['s1'], 'nope').status, 404);
  assert.strictEqual(store.move('ctx1', [], null).status, 400);
  assert.strictEqual(store.remove('ctx1', 'nope').status, 404);
  assert.deepStrictEqual(store.remove('ctx1', 'task-1').tasks, [], 'its tabs are simply in no task again');
});

test('the tasks persist, and a purged session is forgotten on a write but never on a read', () => {
  const file = scratch();
  const known = new Set(['s1', 's2']);
  let n = 0;
  const opts = { file, newId: () => `t${++n}`, sessionKnown: (id) => known.has(id) };
  const store = createTaskStore(opts);
  store.create('ctx1', { title: 'A', sessions: ['s1', 's2', 'ghost'] });
  assert.deepStrictEqual(store.list('ctx1')[0].sessions, ['s1', 's2'], 'an id the daemon never had is not kept');

  known.delete('s2');   // the retention sweep purged its tombstone
  const reread = createTaskStore(opts);
  assert.deepStrictEqual(reread.list('ctx1')[0].sessions, ['s1', 's2'], 'a read never shrinks a board');
  reread.create('ctx1', { title: 'B' });
  assert.deepStrictEqual(reread.list('ctx1')[0].sessions, ['s1'], 'the next write forgets it');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk.projects), ['ctx1']);
  reread.remove('ctx1', 't1');
  reread.remove('ctx1', 't2');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, {}, 'an empty project is dropped');
});

test('a corrupt file reads as no tasks rather than an error', () => {
  const file = scratch();
  fs.writeFileSync(file, '{not json');
  const store = createTaskStore({ file });
  assert.deepStrictEqual(store.list('ctx1'), []);
  assert.strictEqual(store.create('ctx1', { title: 'A' }).task.title, 'A', 'and the next write replaces it');
});

// ---------------------------------------------------------------------- routes

function makeApp() {
  const routes = new Map();
  const record = (method) => (p, h) => routes.set(`${method} ${p}`, h);
  return {
    get: record('GET'), put: record('PUT'), delete: record('DELETE'), post: record('POST'),
    call(key, { params = {}, body } = {}) {
      const handler = routes.get(key);
      assert.ok(handler, `no route for ${key}`);
      const res = { statusCode: 200, body: null };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (v) => { res.body = v; return res; };
      res.send = (v) => { res.body = v; return res; };
      handler({ params, body, query: {} }, res);
      return res;
    },
  };
}

test('the routes: project scoping, live marks, and a ping on every write', () => {
  const broadcasts = [];
  const shells = new Map([['s1', { cwd: REPO }], ['s2', { cwd: REPO }]]);
  const saved = { s3: { cwd: REPO, closed: true } };
  const ctx = {
    shells,
    settings: {},
    reloadClients: new Set(),
    log: () => {},
    broadcast: (m) => broadcasts.push(m),
    getContexts: () => [{ id: 'ctx1', name: 'Alpha', dirs: [REPO] }],
    getSavedSession: (id) => saved[id] || null,
  };
  views.init(ctx);
  let n = 0;
  setTaskStore(createTaskStore({
    file: scratch(),
    newId: () => `t${++n}`,
    sessionKnown: (id) => shells.has(id) || !!saved[id],
  }));
  const app = makeApp();
  registerRoutes(app, ctx);
  const base = '/api/project-views/tasks/:contextId';

  assert.strictEqual(app.call(`GET ${base}`, { params: { contextId: 'nope' } }).statusCode, 404, 'only a registered project');
  assert.deepStrictEqual(app.call(`GET ${base}`, { params: { contextId: 'ctx1' } }).body, { tasks: [] }, 'empty to start');
  assert.strictEqual(broadcasts.length, 0, 'a read pings nobody');

  const made = app.call(`POST ${base}`, { params: { contextId: 'ctx1' }, body: { title: 'Release', sessions: ['s1', 's3'] } });
  assert.strictEqual(made.statusCode, 201);
  assert.deepStrictEqual(made.body.task.sessions, [{ id: 's1', live: true }, { id: 's3', live: false }],
    'a closed tab stays on its task, marked, so a reopen puts it back');
  assert.deepStrictEqual(broadcasts.pop(), { type: 'view-tasks', contextId: 'ctx1' });

  const moved = app.call(`POST ${base}/move`, { params: { contextId: 'ctx1' }, body: { sessions: ['s2'], to: 't1' } });
  assert.deepStrictEqual(moved.body.tasks[0].sessions.map(s => s.id), ['s1', 's3', 's2']);
  const out = app.call(`POST ${base}/move`, { params: { contextId: 'ctx1' }, body: { sessions: ['s1'], to: null } });
  assert.deepStrictEqual(out.body.tasks[0].sessions.map(s => s.id), ['s3', 's2']);

  const renamed = app.call(`PUT ${base}/:taskId`, { params: { contextId: 'ctx1', taskId: 't1' }, body: { title: 'Ship it' } });
  assert.strictEqual(renamed.body.tasks[0].title, 'Ship it');
  assert.strictEqual(app.call(`PUT ${base}/:taskId`, { params: { contextId: 'ctx1', taskId: 'zz' }, body: { title: 'x' } }).statusCode, 404);

  broadcasts.length = 0;
  const gone = app.call(`DELETE ${base}/:taskId`, { params: { contextId: 'ctx1', taskId: 't1' } });
  assert.deepStrictEqual(gone.body, { tasks: [] });
  assert.deepStrictEqual(broadcasts, [{ type: 'view-tasks', contextId: 'ctx1' }]);
  assert.strictEqual(app.call(`DELETE ${base}/:taskId`, { params: { contextId: 'ctx1', taskId: 't1' } }).statusCode, 404);
});

// ------------------------------------------------------------------ the client

function fakeElement(tag = 'div') {
  const classes = new Set();
  let children = [];
  let text = '';
  const el = {
    tag, id: '', title: '', style: {}, dataset: {}, attrs: {}, listeners: {}, value: '',
    get children() { return children; },
    get parentNode() { return el.parent || null; },
    get isConnected() { return !!el.parent; },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    },
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
    append: (...kids) => { for (const k of kids) el.appendChild(k); },
    appendChild: (child) => { child.parent = el; children.push(child); return child; },
    insertBefore: (child, ref) => {
      const i = ref ? children.indexOf(ref) : -1;
      children.splice(i === -1 ? children.length : i, 0, child);
      child.parent = el;
      return child;
    },
    replaceChildren: (...kids) => { for (const k of children) k.parent = null; children = []; for (const k of kids) el.appendChild(k); },
    replaceWith: (other) => {
      const p = el.parent;
      const i = p.children.indexOf(el);
      p.children.splice(i, 1, other);
      other.parent = p;
      el.parent = null;
    },
    contains: (other) => { for (let n = other; n; n = n.parent) if (n === el) return true; return false; },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    blur: () => { el.blurred = true; },
    focus: () => { el.focused = true; },
    select: () => {},
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
  });
  Object.defineProperty(el, 'textContent', {
    get: () => text + children.map(c => c.textContent).join(''),
    set: (v) => { text = String(v); children = []; },
  });
  return el;
}

const byId = new Map();
const root = fakeElement('body');
root.parent = {};
globalThis.window = globalThis;   // nsKey walks window.parent; top level means no prefix
globalThis.parent = globalThis;
globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => fakeElement(tag),
  activeElement: null,
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const timers = new Set();
globalThis.setInterval = (fn) => { const t = { fn }; timers.add(t); return t; };
globalThis.clearInterval = (t) => { timers.delete(t); };

const CTX = { id: 'ctx1', name: 'Off Leash', dirs: ['/repo/offleash'] };
const TASKS_VIEW = { slug: 'tasks', name: 'Tasks', icon: '' };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
let importCount = 0;

/**
 * Fresh module + DOM + fake daemon. The daemon applies writes with the real store rules, so the
 * board's optimistic drawing can be checked against what the server then answers.
 */
async function setup({ view = TASKS_VIEW, tabs = [], tasks = [], elsewhere = [] } = {}) {
  byId.clear();
  timers.clear();
  store.clear();
  root.children.length = 0;
  const wrapper = fakeElement();
  root.appendChild(wrapper);
  const toggle = fakeElement('button');
  toggle.id = 'views-toggle';
  const list = fakeElement();
  list.id = 'tabs-list';
  wrapper.append(toggle, list);
  const terminals = fakeElement();
  root.appendChild(terminals);
  byId.set('tabs-list-wrapper', wrapper);
  byId.set('tabs-list', list);
  byId.set('terminals', terminals);
  const xterm = fakeElement('textarea');
  document.activeElement = xterm;

  const state = {
    ctx: CTX, view, tabs, tasks: JSON.parse(JSON.stringify(tasks)), requests: [], opened: [], strip: [],
    toasts: [], fail: false, nextId: 1, elsewhere: new Set(elsewhere),
  };
  const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    state.requests.push({ method, url, body });
    if (url.startsWith('/api/project-views/cards')) {
      const ids = decodeURIComponent(url.split('ids=')[1]).split(',');
      return answer(200, { prompts: Object.fromEntries(ids.map(id => [id, { prompt: `prompt of ${id}`, supported: true }])) });
    }
    if (state.fail && method !== 'GET') return answer(500, { error: 'disk full' });
    const strip = (ids) => state.tasks.forEach(t => { t.sessions = t.sessions.filter(s => !ids.includes(s.id)); });
    const mark = (id) => ({ id, live: true });
    const rest = url.replace(`/api/project-views/tasks/${CTX.id}`, '');
    if (method === 'POST' && rest === '/move') {
      strip(body.sessions);
      const to = state.tasks.find(t => t.id === body.to);
      if (to) to.sessions.push(...body.sessions.map(mark));
    } else if (method === 'POST' && rest === '') {
      const task = { id: `new${state.nextId++}`, title: body.title || 'New task', created: 1, sessions: [] };
      strip(body.sessions);
      task.sessions = body.sessions.map(mark);
      state.tasks.push(task);
      return answer(201, { task, tasks: state.tasks });
    } else if (method === 'PUT') {
      state.tasks.find(t => t.id === rest.slice(1)).title = body.title;
    } else if (method === 'DELETE') {
      state.tasks = state.tasks.filter(t => t.id !== rest.slice(1));
    }
    return answer(200, { tasks: JSON.parse(JSON.stringify(state.tasks)) });
  };
  const mod = await import(`../../public/js/view-tasks.js?t=${++importCount}`);
  mod.init({
    getActiveContext: () => state.ctx,
    tasksFor: (ctx) => (ctx ? state.view : null),
    memberTabs: () => state.tabs,
    hasTab: (id) => state.tabs.some(t => t.id === id),
    openTab: (id) => state.opened.push(id),
    setStripActive: (on) => state.strip.push(on),
    onUpChanged: () => {},
    showToast: (t) => state.toasts.push(t),
  });
  await flush();
  const superview = () => wrapper.children.find(c => c.id === 'view-tasks-tab');
  const pane = () => terminals.children.find(c => c.id === 'view-tasks');
  const board = () => pane().children.find(c => c.className === 'view-tasks-board');
  const ungrouped = () => board().children[0];
  const cards = () => board().children[1].children.filter(c => c.classList.contains('view-task') && !c.classList.contains('view-task-new'));
  const newCard = () => board().children[1].children.find(c => c.classList.contains('view-task-new'));
  const rowsIn = (el) => {
    const l = el.children.find(c => c.className === 'view-tasks-list');
    return l ? l.children : [];
  };
  const names = (el) => rowsIn(el).map(r => r.children[0].textContent);
  const open = async () => { superview().listeners.click(); await flush(); };
  return { mod, state, wrapper, superview, pane, board, ungrouped, cards, newCard, rowsIn, names, open, xterm };
}

const dt = () => ({ data: {}, setData(k, v) { this.data[k] = v; }, effectAllowed: '', dropEffect: '' });
const ev = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: dt(), ...extra });

/** Drag `row` (whose dragstart decides what moves) and drop it on `target`. */
async function drag(row, target) {
  const e = ev({ currentTarget: row });
  row.listeners.dragstart(e);
  target.listeners.dragover(ev());
  target.listeners.drop(ev());
  row.listeners.dragend?.(ev());
  await flush();
}

const TABS = [
  { id: 's1', name: 'Release notes', current: true },
  { id: 's2', name: 'Fix login' },
  { id: 's3', name: 'Docs pass' },
];

test('the superview shows only while a view with a board is selected, counting its tasks', async () => {
  const { mod, state, wrapper, superview } = await setup({ tabs: TABS, tasks: [{ id: 'a', title: 'A', sessions: [] }] });
  const el = superview();
  assert.deepStrictEqual(wrapper.children.map(c => c.id), ['views-toggle', 'view-tasks-tab', 'tabs-list'], 'toggle, superview, tabs');
  assert.ok(!el.classList.contains('hidden'));
  assert.ok(el.classList.contains('tab'), 'looks like a tab');
  const [icon, , label, count] = el.children;
  assert.strictEqual(icon.textContent, '▥');
  assert.strictEqual(label.textContent, 'Tasks');
  assert.strictEqual(count.textContent, '1', 'fetched as soon as the view shows, before the board opens');
  assert.strictEqual(state.requests.filter(r => r.url === '/api/project-views/tasks/ctx1').length, 1, 'once');

  // Every filter pass renders, so a project's first fetch is still in flight for several.
  state.ctx = { ...CTX, id: 'ctx9' };
  mod.render(); mod.render(); mod.render();
  await flush();
  assert.strictEqual(state.requests.filter(r => r.url === '/api/project-views/tasks/ctx9').length, 1, 'renders during a fetch do not repeat it');
  state.ctx = CTX;

  state.view = null;
  mod.render();
  assert.ok(el.classList.contains('hidden'));
});

test('opening the board: Ungrouped on the left, a card per task, "+ New task" last; no tab active', async () => {
  const { mod, state, open, pane, ungrouped, cards, newCard, names, xterm } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'Launch', sessions: [{ id: 's2', live: true }] }, { id: 'b', title: 'Empty', sessions: [] }],
  });
  await open();
  assert.ok(mod.isUp());
  assert.deepStrictEqual(state.strip, [false], 'no real tab reads as active under the board');
  assert.ok(xterm.blurred, 'keys can no longer reach the terminal underneath');
  assert.ok(!pane().classList.contains('hidden'));

  assert.deepStrictEqual(names(ungrouped()), ['Release notes', 'Docs pass'], 'the tabs in no task');
  assert.strictEqual(cards().length, 2);
  assert.strictEqual(cards()[0].children[0].children[0].textContent, 'Launch');
  assert.deepStrictEqual(names(cards()[0]), ['Fix login']);
  assert.match(cards()[1].textContent, /Drag tabs here/);
  assert.match(newCard().textContent, /\+ New task/);

  const row = ungrouped().children[1].children[0];
  assert.ok(row.classList.contains('current'), 'the tab you came from is marked');
  assert.strictEqual(row.children[1].textContent, 'prompt of s1', 'each row shows its first prompt');
});

test('an empty board says how to start', async () => {
  const { open, cards, newCard, ungrouped, names } = await setup({ tabs: TABS });
  await open();
  assert.strictEqual(cards().length, 0);
  assert.match(newCard().textContent, /Make a task, then drag tabs onto it/);
  assert.deepStrictEqual(names(ungrouped()), ['Release notes', 'Fix login', 'Docs pass']);
});

test('Ungrouped collapses to a strip and stays collapsed, still taking drops', async () => {
  const { open, ungrouped, rowsIn, mod } = await setup({ tabs: TABS });
  await open();
  ungrouped().children[0].listeners.click();
  assert.ok(ungrouped().classList.contains('collapsed'));
  assert.strictEqual(rowsIn(ungrouped()).length, 0);
  assert.strictEqual(ungrouped().children[0].children[2].textContent, '3', 'the count still shows');
  assert.strictEqual(localStorage.getItem('deepsteve-view-tasks-ungrouped'), '1', 'a browser-wide preference');
  assert.ok(ungrouped().listeners.drop, 'a drop target either way');

  mod.dismiss();
  mod.show();
  assert.ok(ungrouped().classList.contains('collapsed'), 'remembered');
  ungrouped().children[0].listeners.click();
  assert.strictEqual(rowsIn(ungrouped()).length, 3);
  assert.strictEqual(localStorage.getItem('deepsteve-view-tasks-ungrouped'), null);
});

test('a click opens the tab; ⌘-click and ⇧-click select instead', async () => {
  const { state, open, ungrouped, rowsIn } = await setup({ tabs: TABS });
  await open();
  rowsIn(ungrouped())[1].listeners.click(ev());
  assert.deepStrictEqual(state.opened, ['s2']);

  rowsIn(ungrouped())[0].listeners.click(ev({ metaKey: true }));
  rowsIn(ungrouped())[2].listeners.click(ev({ shiftKey: true }));
  assert.deepStrictEqual(rowsIn(ungrouped()).map(r => r.classList.contains('selected')), [true, true, true], '⇧ selects the range from the ⌘ anchor');
  rowsIn(ungrouped())[1].listeners.click(ev({ ctrlKey: true }));
  assert.deepStrictEqual(rowsIn(ungrouped()).map(r => r.classList.contains('selected')), [true, false, true], 'Ctrl toggles too');
  assert.deepStrictEqual(state.opened, ['s2'], 'selecting opens nothing');
});

test('dragging a tab onto a card files it there, and dragging a selection moves all of it', async () => {
  const { state, open, ungrouped, cards, rowsIn, names } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'Launch', sessions: [] }, { id: 'b', title: 'Later', sessions: [] }],
  });
  await open();
  await drag(rowsIn(ungrouped())[1], cards()[0]);
  assert.deepStrictEqual(names(cards()[0]), ['Fix login']);
  assert.deepStrictEqual(names(ungrouped()), ['Release notes', 'Docs pass']);
  const move = state.requests.find(r => r.url.endsWith('/move'));
  assert.deepStrictEqual(move, { method: 'POST', url: '/api/project-views/tasks/ctx1/move', body: { sessions: ['s2'], to: 'a' } });

  rowsIn(ungrouped())[0].listeners.click(ev({ metaKey: true }));
  rowsIn(ungrouped())[1].listeners.click(ev({ metaKey: true }));
  await drag(rowsIn(ungrouped())[1], cards()[1]);
  assert.deepStrictEqual(names(cards()[1]), ['Release notes', 'Docs pass'], 'the whole selection');
  assert.strictEqual(rowsIn(ungrouped()).length, 0);
  assert.ok(rowsIn(cards()[1]).every(r => !r.classList.contains('selected')), 'a drop clears the selection');

  // From one card to another, then back out to Ungrouped.
  await drag(rowsIn(cards()[1])[0], cards()[0]);
  assert.deepStrictEqual(names(cards()[0]), ['Fix login', 'Release notes']);
  await drag(rowsIn(cards()[0])[0], ungrouped());
  assert.deepStrictEqual(names(ungrouped()), ['Fix login']);
  assert.deepStrictEqual(state.requests.filter(r => r.url.endsWith('/move')).at(-1).body, { sessions: ['s2'], to: null });

  const before = state.requests.length;
  await drag(rowsIn(cards()[0])[0], cards()[0]);
  assert.strictEqual(state.requests.length, before, 'dropped where it already is: nothing written');
});

test('a drag that is not ours (a file, a strip tab) is ignored', async () => {
  const { open, cards } = await setup({ tabs: TABS, tasks: [{ id: 'a', title: 'A', sessions: [] }] });
  await open();
  let prevented = false;
  cards()[0].listeners.dragover(ev({ preventDefault() { prevented = true; } }));
  assert.strictEqual(prevented, false, 'not a drop target for it, so file-drop still sees it');
  assert.ok(!cards()[0].classList.contains('drop-over'));
});

test('"+ New task" takes a name; tabs dropped on it make a task whose name opens for editing', async () => {
  const { state, open, cards, newCard, ungrouped, rowsIn, names } = await setup({ tabs: TABS });
  await open();
  assert.ok(!newCard().children[0].listeners.click, 'the card, not just its label, takes the click');
  const press = (target) => { let kept = false; newCard().listeners.mousedown(ev({ target, preventDefault() { kept = true; } })); return kept; };
  assert.strictEqual(press(newCard()), false, 'before the field opens, a press is an ordinary press');
  newCard().listeners.click();
  const input = newCard().children[0];
  assert.strictEqual(input.tag, 'input', 'the button became a name field');
  assert.ok(input.focused);
  newCard().listeners.click();   // a click in the field bubbles to the card
  assert.strictEqual(newCard().children[0], input, 'and does not start a second one');
  assert.strictEqual(press(newCard()), true, 'a press on the rest of the card keeps the field focused');
  assert.strictEqual(press(input), false, 'a press in the field is the field’s own');
  input.value = '  Release  ';
  input.listeners.keydown(ev({ key: 'Enter' }));
  await flush();
  assert.deepStrictEqual(state.requests.find(r => r.method === 'POST').body, { title: 'Release', sessions: [] });
  assert.strictEqual(cards().length, 1);
  assert.strictEqual(cards()[0].children[0].children[0].textContent, 'Release');

  newCard().listeners.click();
  newCard().children[0].listeners.keydown(ev({ key: 'Escape' }));
  await flush();
  assert.strictEqual(state.requests.filter(r => r.method === 'POST').length, 1, 'Escape makes nothing');

  await drag(rowsIn(ungrouped())[0], newCard());
  assert.strictEqual(cards().length, 2);
  assert.deepStrictEqual(names(cards()[1]), ['Release notes']);
  const title = cards()[1].children[0].children[0];
  assert.strictEqual(title.tag, 'input', 'its name is open for editing');
  assert.strictEqual(title.value, 'New task');
  title.value = 'Notes';
  title.listeners.blur();
  await flush();
  assert.deepStrictEqual(state.requests.at(-1), { method: 'PUT', url: '/api/project-views/tasks/ctx1/new2', body: { title: 'Notes' } });
  assert.strictEqual(cards()[1].children[0].children[0].textContent, 'Notes');
});

test('renaming and deleting a task', async () => {
  const { state, open, cards, ungrouped, names } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'Launch', sessions: [{ id: 's1', live: true }] }],
  });
  await open();
  cards()[0].children[0].children[0].listeners.click();
  const input = cards()[0].children[0].children[0];
  assert.strictEqual(input.value, 'Launch');
  input.value = 'Launch day';
  input.listeners.keydown(ev({ key: 'Enter' }));
  input.listeners.blur();   // the input leaving the page blurs it; that must not write twice
  await flush();
  assert.strictEqual(state.requests.filter(r => r.method === 'PUT').length, 1);
  assert.strictEqual(cards()[0].children[0].children[0].textContent, 'Launch day');

  cards()[0].children[0].children[2].listeners.click();
  await flush();
  assert.strictEqual(cards().length, 0);
  assert.deepStrictEqual(names(ungrouped()), ['Release notes', 'Fix login', 'Docs pass'], 'its tabs are back in Ungrouped');
  assert.deepStrictEqual(state.requests.at(-1), { method: 'DELETE', url: '/api/project-views/tasks/ctx1/a', body: null });
});

test('a failed write says so and puts the board back to what the daemon holds', async () => {
  const { state, open, cards, ungrouped, rowsIn, names } = await setup({ tabs: TABS, tasks: [{ id: 'a', title: 'A', sessions: [] }] });
  await open();
  state.fail = true;
  await drag(rowsIn(ungrouped())[0], cards()[0]);
  assert.deepStrictEqual(state.toasts, ['Couldn’t save the tasks — disk full']);
  assert.deepStrictEqual(names(cards()[0]), [], 'refetched');
  assert.strictEqual(rowsIn(ungrouped()).length, 3);
});

test('a task counts its tabs open in another window, and ignores closed ones', async () => {
  const { open, cards } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'A', sessions: [{ id: 's1', live: true }, { id: 'far', live: true }, { id: 'shut', live: false }] }],
  });
  await open();
  const card = cards()[0];
  assert.strictEqual(card.children[0].children[1].textContent, '2', 'the tab here and the one elsewhere');
  assert.match(card.textContent, /\+1 tab in another window/);
});

test('a ping refetches a board this window holds, and only that one', async () => {
  const { mod, state, open, cards } = await setup({ tabs: TABS });
  await open();
  state.tasks.push({ id: 'z', title: 'From another window', sessions: [] });
  const gets = () => state.requests.filter(r => r.method === 'GET' && r.url.startsWith('/api/project-views/tasks/')).length;
  const before = gets();
  mod.onPing('ctx-other');
  await flush();
  assert.strictEqual(gets(), before, 'not a board we hold');
  mod.onPing('ctx1');
  await flush();
  assert.strictEqual(gets(), before + 1);
  assert.strictEqual(cards()[0].children[0].children[0].textContent, 'From another window');
});

test('the board goes down when a tab is switched to, or the view or project changes', async () => {
  const { mod, state, open, pane } = await setup({ tabs: TABS });
  await open();
  mod.dismiss();
  assert.ok(!mod.isUp());
  assert.ok(pane().classList.contains('hidden'));
  assert.deepStrictEqual(state.strip, [false, true], 'the strip gets its active tab back');

  await open();
  state.view = { ...TASKS_VIEW, slug: 'other' };
  mod.render();
  assert.ok(!mod.isUp(), 'another view');

  state.view = TASKS_VIEW;
  await open();
  state.ctx = { ...CTX, id: 'ctx2' };
  mod.render();
  assert.ok(!mod.isUp(), 'another project');
});

test('view-tasks.js never imports the views modules; app.js wires it beside the cards', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/view-tasks.js'), 'utf8');
  assert.doesNotMatch(src, /from '\.\/(project-views|context-views)\.js'/);
  const app = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  assert.strictEqual(app.match(/ViewCards\.render\(\)/g).length, app.match(/ViewTasks\.render\(\)/g).length, 'drawn wherever the cards are');
  assert.match(app, /ViewCards\.dismiss\(\);\s*ViewTasks\.dismiss\(\);/, 'switchTo takes either superview down');
  assert.strictEqual(app.match(/msg\.type === 'view-tasks'/g).length, 2, 'both channels handle the ping');
  assert.match(app, /ViewCards\.isUp\(\) \|\| ViewTasks\.isUp\(\)/, 'the footer hides under either');
});
