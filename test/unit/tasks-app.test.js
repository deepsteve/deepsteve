// The Tasks app: the task-store routes it adds to mods/tasks/tools.js, and its own view routes in
// mods/tasks-app/tools.js.
//
// What this pins:
//   * a task's project is derived from where its sessions ran, and never stored;
//   * the screen preview and the start route are scoped: the preview reads only a session the task
//     references, and a session starts only in a registered project's directory;
//   * a custom view shadows a built-in of the same name, deleting it brings the built-in back, and
//     editing a built-in copies it first, so the shipped file is never the one an agent edits.
//
// Run: node --test test/unit/tasks-app.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-app-'));
const STATE = path.join(HOME, 'state');
process.env.DEEPSTEVE_HOME = STATE;
fs.mkdirSync(STATE, { recursive: true });
const TASKS_FILE = path.join(STATE, 'tasks.json');
const USER_VIEWS = path.join(STATE, 'tasks-app', 'views');
const BUILTIN_VIEWS = path.join(__dirname, '..', '..', 'mods', 'tasks-app', 'views');

const tasksTools = require('../../mods/tasks/tools.js');
const appTools = require('../../mods/tasks-app/tools.js');

const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));
const OTHER = fs.mkdtempSync(path.join(HOME, 'elsewhere-'));

function harness({ spawnResult } = {}) {
  const shells = new Map();
  const saved = {};
  const spawns = [];
  shells.set('S-live', {
    cwd: path.join(PROJECT, '.claude', 'worktrees', 'x'), name: 'Fix login', windowId: 'W1',
    terminalScreen: { linesSync: (n) => ['one', 'two', 'three'].slice(-n) },
  });
  shells.set('S-other', { cwd: OTHER, name: 'Elsewhere', terminalScreen: { linesSync: () => ['secret'] } });
  saved['S-closed'] = { cwd: PROJECT, name: 'Old', closed: true, closedAt: 1 };

  const ctx = {
    shells,
    getSavedSession: (id) => saved[id] || null,
    getContexts: () => [
      { id: 'p1', name: 'Project One', dirs: [PROJECT], archived: false },
      { id: 'p2', name: 'Archived', dirs: [path.join(HOME, 'gone')], archived: true },
    ],
    sessionInputState: () => 'idle',
    settings: { defaultAgent: 'codex' },
    broadcast: () => {},
    log: () => {},
    reloadClients: new Set([{ readyState: 1, windowId: 'W1' }]),
    deliverToWindow: () => 'window',
    spawnAgentSession: (opts) => {
      spawns.push(opts);
      return spawnResult || { id: `N${spawns.length}`, name: opts.name, cwd: opts.cwd, tabDelivery: 'window' };
    },
  };

  const routes = {};
  const route = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  const app = { get: route('GET'), post: route('POST'), put: route('PUT'), delete: route('DELETE') };
  const tools = tasksTools.init(ctx);
  tasksTools.registerRoutes(app, ctx);
  appTools.registerRoutes(app, ctx);

  function call(key, { params = {}, body = {}, query = {} } = {}) {
    let out = null;
    const res = {
      statusCode: 200,
      headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      type() { return this; },
      json(v) { out = { status: this.statusCode, body: v }; return this; },
      send(v) { out = { status: this.statusCode, body: v }; return this; },
      sendFile(f) { out = { status: this.statusCode, file: f }; return this; },
    };
    routes[key]({ params, query, body }, res);
    return out;
  }

  const caller = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });
  async function addTask(title, shellId) {
    const r = await tools.add_task.handler({ title }, shellId ? caller(shellId) : undefined);
    return Number(/Task #(\d+) created/.exec(r.content[0].text)[1]);
  }
  const wireTask = (id) => call('GET /api/tasks').body.tasks.find((t) => t.id === id);
  const storedTask = (id) => JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).find((t) => t.id === id);

  return { call, addTask, wireTask, storedTask, spawns, saved };
}

// ── the task store ───────────────────────────────────────────────────────────

test('a task\'s project comes from where its session ran, even inside a worktree, and is not stored', async () => {
  const h = harness();
  const id = await h.addTask('in a project', 'S-live');
  assert.deepStrictEqual(h.wireTask(id).project, { id: 'p1', name: 'Project One', dir: PROJECT });
  assert.strictEqual('project' in h.storedTask(id), false);

  assert.strictEqual(h.wireTask(await h.addTask('outside every project', 'S-other')).project, null);
  assert.strictEqual(h.wireTask(await h.addTask('no session')).project, null);
});

test('count is the tasks that are not done', async () => {
  const h = harness();
  const before = h.call('GET /api/tasks/count').body.count;
  const id = await h.addTask('count me');
  assert.strictEqual(h.call('GET /api/tasks/count').body.count, before + 1);
  h.call('POST /api/tasks/:id/status', { params: { id: String(id) }, body: { status: 'done' } });
  assert.strictEqual(h.call('GET /api/tasks/count').body.count, before);
});

test('a task written in the app needs a title and attaches no session', () => {
  const h = harness();
  assert.strictEqual(h.call('POST /api/tasks', { body: { title: '   ' } }).status, 400);
  const r = h.call('POST /api/tasks', { body: { title: '  Water the plants ', priority: 'nonsense' } });
  assert.strictEqual(r.status, 200);
  const stored = h.storedTask(r.body.task.id);
  assert.strictEqual(stored.title, 'Water the plants');
  assert.strictEqual(stored.priority, 'medium');
  assert.strictEqual(stored.status, 'pending');
  assert.deepStrictEqual(stored.sessions, []);
});

test('the screen preview reads only a live session the task references', async () => {
  const h = harness();
  const id = await h.addTask('preview', 'S-live');
  const params = (sessionId) => ({ params: { id: String(id), sessionId }, query: { lines: '2' } });

  const ok = h.call('GET /api/tasks/:id/sessions/:sessionId/screen', params('S-live'));
  assert.deepStrictEqual(ok.body, { lines: ['two', 'three'], state: 'idle' });

  // S-other is live, but not this task's: the route is not a way to read any session's screen.
  assert.strictEqual(h.call('GET /api/tasks/:id/sessions/:sessionId/screen', params('S-other')).status, 404);

  h.call('POST /api/tasks/:id/sessions', { params: { id: String(id) }, body: { sessionId: 'S-closed' } });
  assert.strictEqual(h.call('GET /api/tasks/:id/sessions/:sessionId/screen', params('S-closed')).status, 409);
});

test('start spawns the default agent in a project directory and attaches the new session', async () => {
  const h = harness();
  const id = await h.addTask('start me');
  const r = h.call('POST /api/tasks/:id/start', { params: { id: String(id) }, body: { cwd: PROJECT, windowId: 'W1' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(h.spawns.length, 1);
  assert.strictEqual(h.spawns[0].cwd, PROJECT);
  assert.strictEqual(h.spawns[0].agentType, 'codex');
  assert.strictEqual(h.spawns[0].windowId, 'W1');
  assert.strictEqual(h.spawns[0].prompt, undefined);
  assert.deepStrictEqual(h.storedTask(id).sessions, [{ id: r.body.id, name: 'start me' }]);
});

test('start refuses a directory no project registers, and a window that is not connected gets no tab', async () => {
  const h = harness();
  const id = await h.addTask('refuse');
  const bad = h.call('POST /api/tasks/:id/start', { params: { id: String(id) }, body: { cwd: OTHER } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(h.spawns.length, 0);

  h.call('POST /api/tasks/:id/start', { params: { id: String(id) }, body: { cwd: PROJECT, windowId: 'W-gone' } });
  assert.strictEqual(h.spawns[0].windowId, null);
});

test('a spawn that fails attaches nothing', async () => {
  const h = harness({ spawnResult: { error: { code: 'cwd-missing', message: 'no such dir' } } });
  const id = await h.addTask('fails');
  const r = h.call('POST /api/tasks/:id/start', { params: { id: String(id) }, body: { cwd: PROJECT } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'cwd-missing');
  assert.deepStrictEqual(h.storedTask(id).sessions, []);
});

// ── views ────────────────────────────────────────────────────────────────────

test('view names are file stems and nothing else', () => {
  for (const ok of ['board', 'galaxy-3d', 'x']) assert.strictEqual(appTools.viewName(ok), ok);
  for (const bad of ['', '../x', 'Board', 'a/b', '-lead', 'x'.repeat(42), 'a.html', null]) {
    assert.strictEqual(appTools.viewName(bad), null, String(bad));
  }
});

test('the built-in views are listed, and a custom file with a built-in\'s name shadows it', () => {
  const h = harness();
  const list = () => h.call('GET /api/tasks-app/views').body.views;
  const board = () => list().find((v) => v.name === 'board');
  assert.deepStrictEqual(list().map((v) => v.name).filter((n) => n === 'board' || n === 'orbit'), ['board', 'orbit']);
  assert.strictEqual(board().custom, false);
  assert.strictEqual(h.call('GET /api/tasks-app/views/:name', { params: { name: 'board' } }).file, path.join(BUILTIN_VIEWS, 'board.html'));

  fs.mkdirSync(USER_VIEWS, { recursive: true });
  fs.writeFileSync(path.join(USER_VIEWS, 'board.html'), '<p>mine</p>');
  assert.deepStrictEqual({ builtin: board().builtin, custom: board().custom }, { builtin: true, custom: true });
  assert.strictEqual(h.call('GET /api/tasks-app/views/:name', { params: { name: 'board' } }).file, path.join(USER_VIEWS, 'board.html'));

  // Delete removes only the custom copy; the built-in is served again.
  assert.strictEqual(h.call('DELETE /api/tasks-app/views/:name', { params: { name: 'board' } }).status, 200);
  assert.strictEqual(fs.existsSync(path.join(BUILTIN_VIEWS, 'board.html')), true);
  assert.strictEqual(board().custom, false);
  assert.strictEqual(h.call('DELETE /api/tasks-app/views/:name', { params: { name: 'board' } }).status, 404);

  assert.strictEqual(h.call('GET /api/tasks-app/views/:name', { params: { name: '..%2Fx' } }).status, 404);
});

test('a view\'s state round-trips, per view', () => {
  const h = harness();
  const get = (name) => h.call('GET /api/tasks-app/views/:name/state', { params: { name } }).body.state;
  assert.strictEqual(get('board'), null);
  h.call('PUT /api/tasks-app/views/:name/state', { params: { name: 'board' }, body: { state: { order: [3, 1] } } });
  assert.deepStrictEqual(get('board'), { order: [3, 1] });
  assert.strictEqual(get('orbit'), null);
  assert.strictEqual(h.call('PUT /api/tasks-app/views/:name/state', { params: { name: 'board' }, body: {} }).status, 400);
});

test('editing a built-in copies it first and starts an agent in the custom-views directory', () => {
  const h = harness();
  fs.rmSync(path.join(USER_VIEWS, 'orbit.html'), { force: true });
  const r = h.call('POST /api/tasks-app/views/:name/edit', { params: { name: 'orbit' }, body: { request: 'make it a city', windowId: 'W1' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.started, 'copied');
  const copy = path.join(USER_VIEWS, 'orbit.html');
  assert.strictEqual(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(BUILTIN_VIEWS, 'orbit.html'), 'utf8'));

  const spawn = h.spawns[0];
  assert.strictEqual(spawn.cwd, USER_VIEWS);
  assert.strictEqual(spawn.agentType, 'codex');
  assert.match(spawn.prompt, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(spawn.prompt, /views[/\\]README\.md/);
  assert.match(spawn.prompt, /make it a city/);

  // A second edit works on the copy it already has.
  assert.strictEqual(h.call('POST /api/tasks-app/views/:name/edit', { params: { name: 'orbit' }, body: {} }).body.started, 'custom');
  assert.match(h.spawns[1].prompt, /Ask the user what they want/);
});

test('a new view is left for the agent to write', () => {
  const h = harness();
  const r = h.call('POST /api/tasks-app/views/:name/edit', { params: { name: 'timeline' }, body: { request: 'a timeline' } });
  assert.strictEqual(r.body.started, 'new');
  assert.strictEqual(fs.existsSync(path.join(USER_VIEWS, 'timeline.html')), false);
  assert.match(h.spawns[0].prompt, /does not exist yet/);
  assert.strictEqual(h.call('POST /api/tasks-app/views/:name/edit', { params: { name: 'Bad Name' }, body: {} }).status, 400);
});
