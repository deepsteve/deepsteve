// Unit tests for task boards — a selectable project view's `tasks`. Four parts:
//
//   - the view file: `tasks` is kept on a view you look at, dropped on an additive one, drops
//     `cards` beside it, round-trips through the file and goes out on the wire;
//   - the store (mods/project-mods/view-tasks.js): groups per project, a tab in at most one of
//     them, a group a move empties dropped, purged sessions forgotten on a write, never on a read;
//   - the routes, /api/project-views/tasks/:contextId: project scoping, live marks, the ping;
//   - the client (public/js/view-tasks.js): the superview, the board it opens with a card per
//     lone tab titled with its one-liner, groups made by dragging, selection, renames (a lone
//     tab's is its Custom Label), and refetching on a ping.
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
  assert.deepStrictEqual(tasks.map(t => t.sessions), [['s2', 's1', 's3']], 'appended in the order given, and A, emptied, is gone');

  tasks = store.move('ctx1', ['s2'], null).tasks;
  assert.deepStrictEqual(tasks.map(t => t.sessions), [['s1', 's3']], 'null is "in no task"');

  // Another project's tasks are untouched by this one's moves.
  store.create('ctx2', { title: 'Elsewhere', sessions: ['s1'] });
  store.move('ctx1', ['s1'], null);
  assert.deepStrictEqual(store.list('ctx2')[0].sessions, ['s1']);
});

test('a group a move empties is dropped; an empty one, or the target, never is', () => {
  const store = makeStore();
  store.create('ctx1', { title: 'Empty' });
  store.create('ctx1', { title: 'Pair', sessions: ['s1', 's2'] });
  store.create('ctx1', { title: 'Solo', sessions: ['s3'] });

  let tasks = store.move('ctx1', ['s1'], null).tasks;
  assert.deepStrictEqual(tasks.map(t => t.title), ['Empty', 'Pair', 'Solo'], 'one tab left is still a group');
  tasks = store.move('ctx1', ['s2'], null).tasks;
  assert.deepStrictEqual(tasks.map(t => t.title), ['Empty', 'Solo'], 'its last tab out, and the group goes');
  tasks = store.move('ctx1', ['s3'], 'task-3').tasks;
  assert.deepStrictEqual(tasks.map(t => [t.title, t.sessions]), [['Empty', []], ['Solo', ['s3']]], 'dropped where it already was');

  // A new group that takes a lone group's only tab ends that one.
  const made = store.create('ctx1', { title: 'Merged', sessions: ['s4', 's3'] });
  assert.deepStrictEqual(made.tasks.map(t => [t.title, t.sessions]), [['Empty', []], ['Merged', ['s4', 's3']]]);
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
 * Fresh module + DOM + fake daemon. The daemon applies writes with the store's rules (a tab in at
 * most one group, a group a move empties dropped), so the board's optimistic drawing can be
 * checked against what the server then answers. `facts` overrides what the cards route answers
 * for a tab; by default a tab has a prompt and no title yet.
 */
async function setup({ view = TASKS_VIEW, tabs = [], tasks = [], facts = {} } = {}) {
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
    ctx: CTX, view, tabs, tasks: JSON.parse(JSON.stringify(tasks)), facts: JSON.parse(JSON.stringify(facts)),
    requests: [], asked: [], opened: [], strip: [], toasts: [], fail: false, failLabel: false, nextId: 1,
  };
  const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    state.requests.push({ method, url, body });
    if (url.startsWith('/api/project-views/cards')) {
      const ids = decodeURIComponent(url.split('ids=')[1]).split(',');
      state.asked.push(ids);
      return answer(200, { prompts: Object.fromEntries(ids.map(id => [id, {
        prompt: `prompt of ${id}`, title: null, customLabel: null, supported: true, ...(state.facts[id] || {}),
      }])) });
    }
    if (url.startsWith('/api/project-views/custom-label/')) {
      if (state.failLabel) return answer(500, { error: 'disk full' });
      const id = decodeURIComponent(url.split('/').pop());
      const customLabel = body.customLabel ? body.customLabel.trim() : null;
      state.facts[id] = { ...(state.facts[id] || {}), customLabel };
      return answer(200, { customLabel });
    }
    if (state.fail && method !== 'GET') return answer(500, { error: 'disk full' });
    // Out of every group; a group this empties goes, unless it is where they are going.
    const strip = (ids, target) => {
      state.tasks = state.tasks.filter((t) => {
        const had = t.sessions.length;
        t.sessions = t.sessions.filter(s => !ids.includes(s.id));
        return !had || t.sessions.length || t === target;
      });
    };
    const mark = (id) => ({ id, live: true });
    const rest = url.replace(`/api/project-views/tasks/${CTX.id}`, '');
    if (method === 'POST' && rest === '/move') {
      const to = state.tasks.find(t => t.id === body.to);
      strip(body.sessions, to);
      if (to) to.sessions.push(...body.sessions.map(mark));
    } else if (method === 'POST' && rest === '') {
      const task = { id: `new${state.nextId++}`, title: body.title || 'New task', created: 1, sessions: [] };
      state.tasks.push(task);
      strip(body.sessions, task);
      task.sessions = body.sessions.map(mark);
      return answer(201, { task, tasks: JSON.parse(JSON.stringify(state.tasks)) });
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
  const grid = () => pane().children.find(c => c.className === 'view-tasks-board').children[0];
  const cards = () => grid().children.filter(c => c.classList.contains('view-task') && !c.classList.contains('view-task-out'));
  const out = () => grid().children.find(c => c.classList.contains('view-task-out'));
  const isLone = (card) => card.classList.contains('view-task-solo');
  const titleOf = (card) => card.children[0].children[0];
  const titles = () => cards().map(c => titleOf(c).textContent);
  const rowsIn = (card) => {
    const l = card.children.find(c => c.className === 'view-tasks-list');
    return l ? l.children : [];
  };
  // A lone tab's card stands for the tab; a group's rows do. Each says which by data-id.
  const ids = (card) => rowsIn(card).map(r => r.dataset.id);
  const labels = (card) => rowsIn(card).map(r => r.children[0].textContent);
  const openBtn = (el) => el.tag === 'div' && el.className === 'view-tasks-session'
    ? el.children[1]
    : el.children.find(c => c.className === 'view-task-foot').children[0];
  const card = (title) => cards().find(c => titleOf(c).textContent === title);
  const open = async () => { superview().listeners.click(); await flush(); };
  return { mod, state, wrapper, superview, pane, grid, cards, out, isLone, titleOf, titles, rowsIn, ids, labels, openBtn, card, open, xterm };
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

test('applyMove mirrors the store: out of every group, a group it empties dropped', async () => {
  const { mod } = await setup();
  const tasks = [
    { id: 'e', sessions: [] },
    { id: 'a', sessions: [{ id: 's1', live: true }] },
    { id: 'b', sessions: [{ id: 's2', live: true }, { id: 's3', live: true }] },
  ];
  assert.deepStrictEqual(mod.applyMove(tasks, ['s1'], 'b').map(t => [t.id, t.sessions.map(s => s.id)]),
    [['e', []], ['b', ['s2', 's3', 's1']]], 'a emptied and gone; e was empty already');
  assert.deepStrictEqual(mod.applyMove(tasks, ['s1'], 'a').map(t => t.id), ['e', 'a', 'b'], 'never the target');
  assert.deepStrictEqual(mod.applyMove(tasks, ['s2'], null).map(t => [t.id, t.sessions.map(s => s.id)]),
    [['e', []], ['a', ['s1']], ['b', ['s3']]]);
});

test('layout: a card per lone tab in strip order, a group in its first tab\'s place, tabless groups last', async () => {
  const { mod } = await setup();
  const tabs = [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }];
  const tasks = [
    { id: 'away', sessions: [{ id: 'far', live: true }] },
    { id: 'g', sessions: [{ id: 's4', live: true }, { id: 's2', live: true }] },
  ];
  const cards = mod.layout(tasks, tabs);
  assert.deepStrictEqual(cards.map(c => (c.task ? `group:${c.task.id}` : c.tab.id)), ['s1', 'group:g', 's3', 'group:away']);
  assert.deepStrictEqual(cards[1].tabs.map(t => t.id), ['s4', 's2'], 'a group\'s tabs in its own order');
  assert.strictEqual(cards[3].elsewhere, 1);
});

test('the superview shows only while a view with a board is selected, counting its cards', async () => {
  const { mod, state, wrapper, superview } = await setup({ tabs: TABS, tasks: [{ id: 'a', title: 'A', sessions: [{ id: 's2', live: true }, { id: 's3', live: true }] }] });
  const el = superview();
  assert.deepStrictEqual(wrapper.children.map(c => c.id), ['views-toggle', 'view-tasks-tab', 'tabs-list'], 'toggle, superview, tabs');
  assert.ok(!el.classList.contains('hidden'));
  assert.ok(el.classList.contains('tab'), 'looks like a tab');
  const [icon, , label, count] = el.children;
  assert.strictEqual(icon.textContent, '▥');
  assert.strictEqual(label.textContent, 'Tasks');
  assert.strictEqual(count.textContent, '2', 's1 on its own and the group, fetched before the board opens');
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

test('opening the board: every tab a card titled with its one-liner, nothing to sort by hand; no tab active', async () => {
  const { mod, state, open, pane, cards, out, isLone, titles, titleOf, rowsIn, ids, labels, openBtn, xterm } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'Launch', sessions: [{ id: 's2', live: true }] }, { id: 'b', title: 'Closed', sessions: [{ id: 'shut', live: false }] }],
    facts: {
      s1: { title: 'Release summary' },
      s2: { prompt: 'fix the\nlogin form' },
      s3: { title: 'Docs title', customLabel: 'Docs label' },
    },
  });
  await open();
  assert.ok(mod.isUp());
  assert.deepStrictEqual(state.strip, [false], 'no real tab reads as active under the board');
  assert.ok(xterm.blurred, 'keys can no longer reach the terminal underneath');
  assert.ok(!pane().classList.contains('hidden'));

  assert.deepStrictEqual(titles(), ['Release summary', 'Launch', 'Docs label', 'Closed'],
    'strip order, the group in s2\'s place, the group with nothing open last');
  assert.deepStrictEqual(cards().map(isLone), [true, false, true, false]);
  assert.strictEqual(cards()[0].dataset.id, 's1', 'a lone card stands for its tab');
  assert.strictEqual(cards()[0].draggable, true, 'and is what you drag');
  assert.deepStrictEqual(labels(cards()[1]), ['fix the login form'], 'a group\'s rows carry each tab\'s one-liner');
  assert.deepStrictEqual(ids(cards()[1]), ['s2']);
  assert.match(cards()[3].textContent, /None of its tabs are open/);
  assert.ok(cards()[0].classList.contains('current'), 'the tab you came from is marked');
  assert.ok(!titleOf(cards()[0]).classList.contains('empty'));
  assert.strictEqual(titleOf(cards()[0]).children[0].className, 'view-task-title-text', 'the words in a span, which is what wraps');

  // The tab's own name is nowhere on the board but the Open button's hover text.
  assert.strictEqual(cards()[0].textContent, 'Release summaryOpen');
  assert.doesNotMatch(cards()[1].textContent, /Fix login/);
  assert.strictEqual(openBtn(cards()[0]).textContent, 'Open');
  assert.strictEqual(openBtn(cards()[0]).title, 'Open Release notes');
  assert.strictEqual(openBtn(rowsIn(cards()[1])[0]).title, 'Open Fix login', 'a group\'s rows have one each');
  assert.ok(out(), 'the way out of a group is drawn…');
  assert.ok(!pane().classList.contains('dragging-grouped'), '…and shown only during a drag');
  assert.strictEqual(pane().children[0].children[1].textContent, '4 tasks · 3 tabs in Off Leash');
  assert.deepStrictEqual(state.asked, [['s1', 's2', 's3']], 'one request for every tab');
});

test('a board with no agent tabs says so', async () => {
  const { open, cards, grid } = await setup({ tabs: [] });
  await open();
  assert.strictEqual(cards().length, 0);
  assert.match(grid().textContent, /No agent tabs are open in this view/);
});

test('a tab still missing its title is asked again on the poll, and one with both only after a while', async () => {
  const { state, open, titles } = await setup({ tabs: [TABS[0], TABS[1]], facts: { s2: { title: 'Login' } } });
  await open();
  assert.deepStrictEqual(titles(), ['prompt of s1', 'Login'], 'no title yet: the first line stands in');
  const poll = [...timers][0].fn;

  state.facts.s1 = { title: 'Release summary' };
  await poll();
  assert.deepStrictEqual(state.asked.at(-1), ['s1'], 'only the tab missing something');
  assert.deepStrictEqual(titles(), ['Release summary', 'Login'], 'the Summary arrives without reopening');

  const asks = state.asked.length;
  await poll();
  assert.strictEqual(state.asked.length, asks, 'both found: nothing to ask');

  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;   // a /clear may have started another conversation
  try {
    await poll();
  } finally {
    Date.now = realNow;
  }
  assert.deepStrictEqual(state.asked.at(-1), ['s1', 's2'], 'asked again after five minutes');
});

test('Open opens the tab; ⌘-click and ⇧-click select, the lone cards being one list', async () => {
  const { state, open, cards, card, rowsIn, openBtn } = await setup({
    tabs: [...TABS, { id: 's4', name: 'Perf' }],
    tasks: [{ id: 'g', title: 'Group', sessions: [{ id: 's4', live: true }] }],
  });
  await open();
  let stopped = false;
  openBtn(cards()[1]).listeners.click(ev({ stopPropagation() { stopped = true; } }));
  assert.deepStrictEqual(state.opened, ['s2']);
  assert.ok(stopped, 'not also a click on the card');
  openBtn(rowsIn(card('Group'))[0]).listeners.click(ev());
  assert.deepStrictEqual(state.opened, ['s2', 's4'], 'a group\'s row opens its own tab');

  cards()[1].listeners.click(ev());
  assert.deepStrictEqual(state.opened, ['s2', 's4'], 'a plain click on the card opens nothing');

  const lone = (i) => cards().filter(c => c.classList.contains('view-task-solo'))[i];
  const picked = () => [0, 1, 2].map(i => lone(i).classList.contains('selected'));
  lone(0).listeners.click(ev({ metaKey: true }));
  lone(2).listeners.click(ev({ shiftKey: true }));
  assert.deepStrictEqual(picked(), [true, true, true], '⇧ selects the range from the ⌘ anchor');
  lone(1).listeners.click(ev({ ctrlKey: true }));
  assert.deepStrictEqual(picked(), [true, false, true], 'Ctrl toggles too');
  lone(1).listeners.click(ev());
  assert.deepStrictEqual(picked(), [false, false, false], 'a plain click lets go of the selection');
  assert.deepStrictEqual(state.opened, ['s2', 's4'], 'selecting opens nothing');
});

test('dragging a card onto another tab\'s card makes a group of the two, its name open and filled in', async () => {
  const { state, open, cards, card, titles, titleOf, ids } = await setup({ tabs: TABS, facts: { s1: { title: 'Release summary' } } });
  await open();
  await drag(cards()[2], cards()[0]);
  assert.deepStrictEqual(state.requests.find(r => r.method === 'POST').body, { title: 'Release summary', sessions: ['s1', 's3'] },
    'the target first, named with its one-liner');
  assert.strictEqual(cards().length, 2, 'the group, in s1\'s place, then s2');
  const name = titleOf(cards()[0]);
  assert.strictEqual(name.tag, 'input', 'its name is open for editing');
  assert.strictEqual(name.value, 'Release summary');
  name.value = 'Release';
  name.listeners.keydown(ev({ key: 'Enter' }));
  await flush();
  assert.deepStrictEqual(state.requests.at(-1), { method: 'PUT', url: '/api/project-views/tasks/ctx1/new1', body: { title: 'Release' } });
  assert.deepStrictEqual(titles(), ['Release', 'prompt of s2']);
  assert.deepStrictEqual(ids(card('Release')), ['s1', 's3']);

  const posts = state.requests.filter(r => r.method === 'POST').length;
  await drag(cards()[1], cards()[1]);
  assert.strictEqual(state.requests.filter(r => r.method === 'POST').length, posts, 'dropped on its own card: nothing written');
});

test('dragging onto a group files it there, a selection moves whole, and the last tab out ends the group', async () => {
  const { state, open, pane, cards, card, out, isLone, rowsIn, ids } = await setup({
    tabs: [...TABS, { id: 's4', name: 'Perf' }],
    tasks: [{ id: 'a', title: 'Launch', sessions: [{ id: 's2', live: true }] }],
  });
  await open();
  // s1, Launch [s2], s3, s4
  await drag(cards()[0], card('Launch'));
  assert.deepStrictEqual(ids(card('Launch')), ['s2', 's1']);
  assert.deepStrictEqual(state.requests.find(r => r.url.endsWith('/move')).body, { sessions: ['s1'], to: 'a' });
  assert.deepStrictEqual(cards().map(c => (isLone(c) ? c.dataset.id : 'Launch')), ['Launch', 's3', 's4'], 'now in s1\'s place');

  cards()[1].listeners.click(ev({ metaKey: true }));
  cards()[2].listeners.click(ev({ metaKey: true }));
  await drag(cards()[2], card('Launch'));
  assert.deepStrictEqual(ids(card('Launch')), ['s2', 's1', 's3', 's4'], 'the whole selection');
  assert.strictEqual(cards().length, 1);
  assert.ok(rowsIn(card('Launch')).every(r => !r.classList.contains('selected')), 'a drop clears the selection');

  // Taking tabs back out: the way out shows a turn after a grouped tab's drag starts.
  const row = rowsIn(card('Launch'))[0];
  row.listeners.dragstart(ev({ currentTarget: row }));
  await flush();
  assert.ok(pane().classList.contains('dragging-grouped'), 'the way out is offered');
  out().listeners.dragover(ev());
  out().listeners.drop(ev());
  assert.ok(!pane().classList.contains('dragging-grouped'), 'and gone again with the drop');
  await flush();
  assert.deepStrictEqual(state.requests.filter(r => r.url.endsWith('/move')).at(-1).body, { sessions: ['s2'], to: null });
  assert.strictEqual(cards().filter(isLone).length, 1, 's2 has its own card again');

  for (const r of rowsIn(card('Launch'))) r.listeners.click(ev({ metaKey: true }));
  await drag(rowsIn(card('Launch'))[0], out());
  assert.deepStrictEqual(cards().map(isLone), [true, true, true, true], 'the last tab out, and the group is gone');
  assert.deepStrictEqual(state.tasks, [], 'on the daemon too');
});

test('a lone tab\'s drag does not offer the way out', async () => {
  const { pane, open, cards } = await setup({ tabs: TABS });
  await open();
  const row = cards()[0];
  row.listeners.dragstart(ev({ currentTarget: row }));
  await flush();
  assert.ok(!pane().classList.contains('dragging-grouped'));
  row.listeners.dragend(ev());
});

test('a drag that is not ours (a file, a strip tab) is ignored', async () => {
  const { open, cards } = await setup({ tabs: TABS });
  await open();
  let prevented = false;
  cards()[0].listeners.dragover(ev({ preventDefault() { prevented = true; } }));
  assert.strictEqual(prevented, false, 'not a drop target for it, so file-drop still sees it');
  assert.ok(!cards()[0].classList.contains('drop-over'));
});

test('renaming a lone tab\'s card sets its Custom Label; emptying it brings the Summary back', async () => {
  const { mod, state, open, cards, titleOf, titles } = await setup({ tabs: [TABS[0], TABS[1]], facts: { s1: { title: 'Release summary' } } });
  await open();
  titleOf(cards()[0]).listeners.click();
  let input = titleOf(cards()[0]);
  assert.strictEqual(input.tag, 'input');
  assert.strictEqual(cards()[0].draggable, false, 'a press in the field selects text rather than dragging the card');
  assert.strictEqual(input.value, 'Release summary', 'starts from what the card shows');
  assert.strictEqual(input.maxLength, 200, 'a Custom Label\'s length, not a group name\'s');
  input.listeners.keydown(ev({ key: 'Enter' }));
  await flush();
  assert.ok(!state.requests.some(r => r.url.includes('custom-label')), 'left as it was: nothing written');

  titleOf(cards()[0]).listeners.click();
  input = titleOf(cards()[0]);
  input.value = '  Ship notes ';
  input.listeners.keydown(ev({ key: 'Enter' }));
  await flush();
  assert.deepStrictEqual(state.requests.at(-1), { method: 'PUT', url: '/api/project-views/custom-label/s1', body: { customLabel: 'Ship notes' } });
  assert.deepStrictEqual(titles(), ['Ship notes', 'prompt of s2']);

  titleOf(cards()[0]).listeners.click();
  input = titleOf(cards()[0]);
  assert.strictEqual(input.value, 'Ship notes');
  input.value = '';
  input.listeners.blur();
  await flush();
  assert.deepStrictEqual(state.requests.at(-1).body, { customLabel: null }, 'cleared');
  assert.deepStrictEqual(titles(), ['Release summary', 'prompt of s2']);

  // Emptying a card that never had a label writes nothing.
  const writes = state.requests.length;
  titleOf(cards()[1]).listeners.click();
  titleOf(cards()[1]).value = '';
  titleOf(cards()[1]).listeners.keydown(ev({ key: 'Enter' }));
  await flush();
  assert.strictEqual(state.requests.length, writes);

  // Set in another window, or from the header row's menu: the ping retitles the card.
  mod.onCustomLabel('s2', 'From the header');
  assert.deepStrictEqual(titles(), ['Release summary', 'From the header']);
  mod.onCustomLabel('nobody', 'x');   // a tab never asked about is left to its first ask

  state.failLabel = true;
  titleOf(cards()[0]).listeners.click();
  titleOf(cards()[0]).value = 'Nope';
  titleOf(cards()[0]).listeners.keydown(ev({ key: 'Enter' }));
  await flush();
  assert.deepStrictEqual(state.toasts, ['Couldn’t save the Custom Label — disk full']);
  assert.deepStrictEqual(titles(), ['Release summary', 'From the header'], 'put back');
});

test('renaming and ungrouping a group', async () => {
  const { state, open, cards, card, titleOf, isLone } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'Launch', sessions: [{ id: 's1', live: true }, { id: 's3', live: true }] }],
  });
  await open();
  titleOf(card('Launch')).listeners.click();
  const input = titleOf(cards()[0]);
  assert.strictEqual(input.value, 'Launch');
  input.value = 'Launch day';
  input.listeners.keydown(ev({ key: 'Enter' }));
  input.listeners.blur();   // the input leaving the page blurs it; that must not write twice
  await flush();
  assert.strictEqual(state.requests.filter(r => r.method === 'PUT').length, 1);
  assert.ok(card('Launch day'));

  card('Launch day').children[0].children[2].listeners.click();
  await flush();
  assert.deepStrictEqual(cards().map(isLone), [true, true, true], 'its tabs have their own cards again');
  assert.deepStrictEqual(state.requests.at(-1), { method: 'DELETE', url: '/api/project-views/tasks/ctx1/a', body: null });
});

test('a failed write says so and puts the board back to what the daemon holds', async () => {
  const { state, open, cards, card, ids } = await setup({ tabs: TABS, tasks: [{ id: 'a', title: 'A', sessions: [{ id: 's2', live: true }] }] });
  await open();
  state.fail = true;
  await drag(cards()[0], card('A'));
  assert.deepStrictEqual(state.toasts, ['Couldn’t save the tasks — disk full']);
  assert.deepStrictEqual(ids(card('A')), ['s2'], 'refetched');
  assert.strictEqual(cards().length, 3);
});

test('a group counts its tabs open in another window, and ignores closed ones', async () => {
  const { open, card } = await setup({
    tabs: TABS,
    tasks: [{ id: 'a', title: 'A', sessions: [{ id: 's1', live: true }, { id: 'far', live: true }, { id: 'shut', live: false }] }],
  });
  await open();
  assert.strictEqual(card('A').children[0].children[1].textContent, '2', 'the tab here and the one elsewhere');
  assert.match(card('A').textContent, /\+1 tab in another window/);
});

test('a ping refetches a board this window holds, and only that one', async () => {
  const { mod, state, open, titles } = await setup({ tabs: TABS });
  await open();
  state.tasks.push({ id: 'z', title: 'From another window', sessions: [{ id: 's2', live: true }] });
  const gets = () => state.requests.filter(r => r.method === 'GET' && r.url.startsWith('/api/project-views/tasks/')).length;
  const before = gets();
  mod.onPing('ctx-other');
  await flush();
  assert.strictEqual(gets(), before, 'not a board we hold');
  mod.onPing('ctx1');
  await flush();
  assert.strictEqual(gets(), before + 1);
  assert.deepStrictEqual(titles(), ['prompt of s1', 'From another window', 'prompt of s3']);
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
  assert.strictEqual(app.match(/ViewTasks\.onCustomLabel\(msg\.id, msg\.customLabel\)/g).length, 2, 'both channels retitle a lone card');
  assert.match(app, /ViewCards\.isUp\(\) \|\| ViewTasks\.isUp\(\)/, 'the footer hides under either');
});
