// list_tasks defaults to the open tasks of the caller's project (#729).
//
// What this pins:
//   * with no arguments, an agent sees pending + in-progress tasks whose derived project is its
//     own, and the caller's project is derived the same way a task's is — so a worktree session
//     lands on its parent project, as the panel's "This project" toggle would;
//   * done tasks, other projects' tasks and tasks with no project (written in the Tasks app) appear
//     only when asked for, and what the scope hid is counted so an empty list cannot mislead;
//   * a caller in no registered project, or not a session at all, gets the unscoped list and is
//     told so.
//
// Run: node --test test/unit/tasks-list-scope.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-list-scope-'));
const STATE = path.join(HOME, 'state');
process.env.DEEPSTEVE_HOME = STATE;
fs.mkdirSync(STATE, { recursive: true });

const tasksTools = require('../../mods/tasks/tools.js');

const ONE = fs.mkdtempSync(path.join(HOME, 'one-'));
const TWO = fs.mkdtempSync(path.join(HOME, 'two-'));
const LOOSE = fs.mkdtempSync(path.join(HOME, 'loose-'));

const shells = new Map([
  ['S-one', { cwd: ONE, name: 'One' }],
  ['S-wt', { cwd: path.join(ONE, '.claude', 'worktrees', 'x'), name: 'One worktree' }],
  ['S-two', { cwd: TWO, name: 'Two' }],
  ['S-loose', { cwd: LOOSE, name: 'Loose' }],
]);
const ctx = {
  shells,
  getSavedSession: () => null,
  getContexts: () => [
    { id: 'p1', name: 'Project One', dirs: [ONE] },
    { id: 'p2', name: 'Project Two', dirs: [TWO + '/'] },
  ],
  broadcast: () => {},
  log: () => {},
};

const routes = {};
const route = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
const tools = tasksTools.init(ctx);
tasksTools.registerRoutes({ get: route('GET'), post: route('POST'), delete: route('DELETE') }, ctx);

function call(key, { params = {}, body = {} } = {}) {
  let out = null;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { out = v; return this; } };
  routes[key]({ params, query: {}, body }, res);
  return out;
}

const caller = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });

async function addTask(title, shellId, extra = {}) {
  const r = await tools.add_task.handler({ title, ...extra }, caller(shellId));
  return Number(/Task #(\d+) created/.exec(r.content[0].text)[1]);
}

async function list(args, shellId) {
  const r = await tools.list_tasks.handler(args, shellId ? caller(shellId) : undefined);
  return r.content[0].text;
}

const ids = (text) => [...text.matchAll(/#(\d+):/g)].map((m) => Number(m[1])).sort((a, b) => a - b);

// One store for the whole file: the mod keeps its list in module state.
const T = {};
test('setup', async () => {
  T.open = await addTask('one open', 'S-one');
  T.doing = await addTask('one doing', 'S-wt');
  await tools.update_task.handler({ id: T.doing, status: 'in-progress' });
  T.done = await addTask('one done', 'S-one');
  await tools.complete_task.handler({ id: T.done });
  T.tagged = await addTask('one tagged', 'S-one', { session_tag: 'triage' });
  T.two = await addTask('two open', 'S-two');
  T.human = call('POST /api/tasks', { body: { title: 'written in the app' } }).task.id;
});

test('the default is the open tasks of the caller\'s project, with a header that says so', async () => {
  const text = await list({}, 'S-one');
  assert.deepStrictEqual(ids(text), [T.open, T.doing, T.tagged]);
  assert.match(text, /^Open tasks in Project One \(3\):/);
  // Scoped to one project, so no per-row project line.
  assert.doesNotMatch(text, /project: /);
});

test('what the scope hid is counted, so the agent knows to widen it', async () => {
  const text = await list({}, 'S-one');
  // The other project's task and the app-written task with no project.
  assert.match(text, /2 more open tasks are in another project or in none — scope: "all" lists them\./);
});

test('a worktree session is scoped to its parent project', async () => {
  assert.deepStrictEqual(ids(await list({}, 'S-wt')), [T.open, T.doing, T.tagged]);
});

test('a project dir with a trailing slash still holds its sessions and tasks', async () => {
  const text = await list({}, 'S-two');
  assert.deepStrictEqual(ids(text), [T.two]);
  assert.match(text, /^Open tasks in Project Two \(1\):/);
});

test('done tasks appear only when asked for', async () => {
  assert.deepStrictEqual(ids(await list({ status: 'done' }, 'S-one')), [T.done]);
  assert.deepStrictEqual(ids(await list({ status: 'all' }, 'S-one')), [T.open, T.doing, T.done, T.tagged]);
  assert.deepStrictEqual(ids(await list({ status: 'pending' }, 'S-one')), [T.open, T.tagged]);
  assert.deepStrictEqual(ids(await list({ status: 'in-progress' }, 'S-one')), [T.doing]);
  assert.match(await list({ status: 'done' }, 'S-one'), /^Done tasks in Project One \(1\):/);
  assert.match(await list({ status: 'all' }, 'S-one'), /^Tasks in Project One \(4\):/);
});

test('scope "all" lists every project\'s tasks, each with its project, and hides nothing', async () => {
  const text = await list({ scope: 'all' }, 'S-one');
  assert.deepStrictEqual(ids(text), [T.open, T.doing, T.tagged, T.two, T.human]);
  assert.match(text, /^Open tasks in every project \(5\):/);
  assert.match(text, /#\d+: two open[^\n]*\n(\s+[^\n]*\n)*\s+project: Project Two/);
  assert.match(text, /#\d+: written in the app[^\n]*\n\s+project: none/);
  assert.doesNotMatch(text, /more .*tasks? (is|are) in another project/);
  assert.doesNotMatch(text, /not in a registered project|not a Deep Steve session/);
});

test('a session outside every project gets the unscoped list, and is told why', async () => {
  const text = await list({}, 'S-loose');
  assert.deepStrictEqual(ids(text), [T.open, T.doing, T.tagged, T.two, T.human]);
  assert.match(text, /^This session is not in a registered project, so this lists every project's tasks\.\nOpen tasks in every project \(5\):/);
});

test('a caller that is not a session at all gets the unscoped list, and is told why', async () => {
  const text = await list({});
  assert.deepStrictEqual(ids(text), [T.open, T.doing, T.tagged, T.two, T.human]);
  assert.match(text, /^The caller is not a Deep Steve session, so this lists every project's tasks\./);
  assert.match(await list({}, 'S-nobody'), /^The caller is not a Deep Steve session/);
});

test('session_tag narrows within the scope', async () => {
  const text = await list({ session_tag: 'triage' }, 'S-one');
  assert.deepStrictEqual(ids(text), [T.tagged]);
  assert.match(text, /^Open tasks tagged "triage" in Project One \(1\):/);
  assert.match(await list({ session_tag: 'triage' }, 'S-two'), /\(0\):\n\nNo tasks found\.\n\n1 more open task is in another project or in none — scope: "all" lists it\./);
});

test('the rail badge counts the same open tasks list_tasks defaults to', () => {
  assert.strictEqual(call('GET /api/tasks/count').count, 5);
});
