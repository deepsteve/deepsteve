// Unit tests for the cross-project run-history aggregation (#633).
//
// buildRunHistory is the whole status page as data, so these are truth tables on
// the cases the page exists to surface: a task that has never run, a task whose
// repo folder is gone, a task whose schedule was deleted mid-run, and a repo that
// belongs to two projects at once. All pure — no daemon, no filesystem.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-history-home-'));

const { buildRunHistory, disambiguate, registerRoutes } = require('../../mods/scheduled-tasks/tools.js');

const task = (over = {}) => ({
  id: 'x', title: 'T', cron: '0 9 * * 1', project: '', enabled: true, runs: [], ...over,
});
const build = (over = {}) => buildRunHistory({ exists: () => true, now: 1000, ...over });

// Every repo row the payload contains, flattened — order preserved.
const repos = (out) => out.groups.flatMap(g => g.repos.map(r => ({ group: g.name, ...r })));
const findTask = (out, id) => repos(out).flatMap(r => r.tasks).find(t => t.id === id);

test('a repo nests under the project whose dirs contain it', () => {
  const out = build({
    tasks: [task({ id: 'a', project: '/repos/acme-web' })],
    contexts: [{ id: 'g1', name: 'Acme', dirs: ['/repos'] }],
  });
  assert.deepStrictEqual(out.groups.map(g => g.name), ['Acme']);
  assert.deepStrictEqual(out.groups[0].repos.map(r => r.name), ['acme-web']);
  assert.deepStrictEqual(out.groups[0].repos[0].tasks.map(t => t.id), ['a']);
});

test('a repo inside two projects is listed under both, with distinct keys', () => {
  const out = build({
    tasks: [task({ id: 'a', project: '/repos/acme-web' })],
    contexts: [
      { id: 'g1', name: 'Acme', dirs: ['/repos'] },
      { id: 'g2', name: 'Web', dirs: ['/repos/acme-web'] },
    ],
  });
  assert.deepStrictEqual(out.groups.map(g => g.name), ['Acme', 'Web']);
  const keys = repos(out).map(r => r.key);
  assert.strictEqual(new Set(keys).size, 2, 'the two rows must not share a DOM key');
  // Duplication is intended, so anything counting tasks has to dedupe by id.
  const ids = repos(out).flatMap(r => r.tasks.map(t => t.id));
  assert.deepStrictEqual(ids, ['a', 'a']);
});

test('repos in no project, and tasks with no repo, land in Ungrouped', () => {
  const out = build({
    tasks: [
      task({ id: 'a', project: '/repos/acme-web' }),
      task({ id: 'b', project: '/elsewhere/solo' }),
      task({ id: 'c', project: '' }),
    ],
    contexts: [{ id: 'g1', name: 'Acme', dirs: ['/repos'] }],
  });
  assert.deepStrictEqual(out.groups.map(g => g.name), ['Acme', 'Ungrouped']);
  const ungrouped = out.groups[1];
  // '' is a fallback bucket, not a repo — it sorts last.
  assert.deepStrictEqual(ungrouped.repos.map(r => r.name), ['solo', 'No project']);
  assert.strictEqual(ungrouped.repos[1].root, null);
});

test('archived projects are included, but sink below the live ones', () => {
  const out = build({
    tasks: [task({ id: 'a', project: '/repos/one' }), task({ id: 'b', project: '/old/two' })],
    contexts: [
      { id: 'g1', name: 'Old', dirs: ['/old'], archived: true },
      { id: 'g2', name: 'Live', dirs: ['/repos'] },
    ],
  });
  // A dormant project's tasks keep firing, so hiding them would hide live
  // schedules — the exact failure this page exists to catch.
  assert.deepStrictEqual(out.groups.map(g => g.name), ['Live', 'Old']);
  assert.strictEqual(out.groups[1].archived, true);
});

test('project order follows the stored (rail) order, not the alphabet', () => {
  const out = build({
    tasks: [task({ id: 'a', project: '/z/one' }), task({ id: 'b', project: '/a/two' })],
    contexts: [{ id: 'g1', name: 'Zulu', dirs: ['/z'] }, { id: 'g2', name: 'Alpha', dirs: ['/a'] }],
  });
  assert.deepStrictEqual(out.groups.map(g => g.name), ['Zulu', 'Alpha']);
});

test('a task whose repo folder is gone is flagged, never dropped', () => {
  const out = build({
    tasks: [task({ id: 'a', project: '/gone/repo' })],
    contexts: [],
    exists: (root) => !root.startsWith('/gone'),
  });
  const repo = repos(out)[0];
  assert.strictEqual(repo.missing, true);
  assert.deepStrictEqual(repo.tasks.map(t => t.id), ['a'], 'the task itself still renders');
});

test('the no-repo bucket is never reported as a missing folder', () => {
  const out = build({ tasks: [task({ id: 'a', project: '' })], exists: () => false });
  assert.strictEqual(repos(out)[0].missing, false);
});

test('a task that has never run still gets a row', () => {
  const out = build({ tasks: [task({ id: 'a', runs: [] })] });
  const t = findTask(out, 'a');
  assert.ok(t, 'a silently-broken schedule must be visible');
  assert.deepStrictEqual(t.runs, []);
});

test('a tombstoned task is included and flagged', () => {
  // A tombstone (#614) only survives while one of its runs is in flight, so it is
  // exactly the row worth seeing — and GET /api/scheduled-tasks hides it.
  const out = build({
    tasks: [task({ id: 'ghost', deleted: true, enabled: false, runs: [{ startedAt: 5, status: 'running', sessionId: 'ab' }] })],
  });
  const t = findTask(out, 'ghost');
  assert.strictEqual(t.deleted, true);
  assert.strictEqual(t.runs.length, 1);
});

test('runs are passed through whole — never sliced to MAX_RUNS', () => {
  // trimRuns() keeps a run whose session is still live PAST the cap by appending
  // it at the end, so slicing to 20 would drop exactly the in-flight run.
  const runs = [];
  for (let i = 0; i < 20; i++) runs.push({ startedAt: 1000 - i, status: 'succeeded', sessionId: `s${i}` });
  runs.push({ startedAt: 1, status: 'running', sessionId: 'kept' });
  const t = findTask(build({ tasks: [task({ id: 'a', runs })] }), 'a');
  assert.strictEqual(t.runs.length, 21);
  assert.strictEqual(t.runs[t.runs.length - 1].sessionId, 'kept');
});

test('run rows keep every recorded field, and tolerate legacy rows missing them', () => {
  const t = findTask(build({
    tasks: [task({
      id: 'a',
      runs: [
        { startedAt: 9, agentStartedAt: 10, endedAt: 20, status: 'succeeded', success: true, summary: 'ok', sessionId: 'aa', worktree: 'scheduled-aa', worktreeRemoved: true, model: 'haiku', effort: 'low' },
        { startedAt: 1, status: 'completed', sessionId: 'bb' }, // pre-#565/#592 shape
      ],
    })],
  }), 'a');
  assert.strictEqual(t.runs[0].summary, 'ok');
  assert.strictEqual(t.runs[0].model, 'haiku');
  assert.strictEqual(t.runs[1].worktree, null);
  assert.strictEqual(t.runs[1].worktreeRemoved, false);
});

test('prompt never reaches the payload', () => {
  const out = build({ tasks: [task({ id: 'a', prompt: 'SECRET-PROMPT-TEXT' })] });
  assert.ok(!JSON.stringify(out).includes('SECRET-PROMPT-TEXT'));
  assert.strictEqual(findTask(out, 'a').prompt, undefined);
});

test('tasks that still fire sort above paused and retired ones, keeping their order', () => {
  const out = build({
    tasks: [
      task({ id: 'paused', enabled: false }),
      task({ id: 'retired', once: true, firedAt: 5 }),
      task({ id: 'live1' }),
      task({ id: 'live2' }),
    ],
  });
  assert.deepStrictEqual(repos(out)[0].tasks.map(t => t.id), ['live1', 'live2', 'paused', 'retired']);
});

test('duplicate basenames are disambiguated by parent dir, tombstones included', () => {
  const out = build({
    tasks: [
      task({ id: 'a', project: '/one/app' }),
      task({ id: 'b', project: '/two/app', deleted: true }),
    ],
  });
  // knownProjects() never sees a tombstone's root, which is why the grid runs its
  // own disambiguation pass over exactly the roots it renders.
  assert.deepStrictEqual(repos(out).map(r => r.name).sort(), ['one/app', 'two/app']);
});

test('disambiguate leaves a unique basename alone and ignores blanks', () => {
  assert.deepStrictEqual([...disambiguate(['/a/solo', '', null])], [['/a/solo', 'solo']]);
});

test('the enabled flag is carried through so the page can say why nothing fires', () => {
  assert.strictEqual(build({ tasks: [task()], enabled: false }).enabled, false);
});

test('GET /api/scheduled-tasks/history answers even with the scheduler off', () => {
  // Read-only, so it shares list_scheduled_tasks' carve-out from the fail-closed
  // gate: when the scheduler is off you especially want the history plus the
  // reason nothing is running.
  const routes = new Map();
  registerRoutes({
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: () => {}, put: () => {}, delete: () => {},
  }, { settings: { scheduledTasksEnabled: false }, log: () => {}, broadcast: () => {}, shells: new Map(), getContexts: () => [] });

  const handler = routes.get('GET /api/scheduled-tasks/history');
  assert.ok(handler, 'the history route should be registered');
  let body = null;
  handler({}, { json: (b) => { body = b; }, status() { return this; } });
  assert.strictEqual(body.enabled, false);
  assert.ok(Array.isArray(body.groups));
});

test('the history route is registered before the routes that could shadow it', () => {
  // Express resolves in registration order; a future GET /api/scheduled-tasks/:id
  // added above this one would swallow /history.
  const order = [];
  registerRoutes({
    get: (p) => order.push(`GET ${p}`),
    post: (p) => order.push(`POST ${p}`),
    put: (p) => order.push(`PUT ${p}`),
    delete: (p) => order.push(`DELETE ${p}`),
  }, { settings: {}, log: () => {}, broadcast: () => {}, shells: new Map(), getContexts: () => [] });

  const history = order.indexOf('GET /api/scheduled-tasks/history');
  const firstParam = order.findIndex(r => r.includes('/api/scheduled-tasks/:id'));
  assert.ok(history >= 0 && firstParam >= 0);
  assert.ok(history < firstParam, 'history must be registered before any /:id route');
});
