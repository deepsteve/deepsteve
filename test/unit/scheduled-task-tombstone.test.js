// Unit tests for scheduled-task tombstones (#614).
//
// The bug: deleteTask() spliced the task out of `tasks`, taking `task.runs` with it —
// and that array is the ONLY record of the run <-> session link. A task deleted while
// one of its runs was still in flight therefore orphaned a live agent: findRunByShell
// stopped resolving, so scheduled_task_started/finished answered "this session is not
// a scheduled task run", the run was never recorded, the unattended tab never
// auto-closed (auto-close lives inside scheduled_task_finished), and the timeout
// reaper + worktree sweep both lost track of it.
//
// The fix is the #561 session-tombstone shape applied to tasks: a delete always
// unschedules immediately, but keeps the row (`deleted: true`) while any run is
// ACTIVE. What is load-bearing, and asserted here: the tombstone is invisible to
// every scheduling/listing surface, the run-facing paths still find it, and it is
// purged on its own once no run is active.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-tombstone-home-'));

const {
  init, registerRoutes, enforceRunTimeouts, purgeTombstonedTasks, TOMBSTONE_TTL_MS,
} = require('../../mods/scheduled-tasks/tools.js');

const TASKS_FILE = path.join(process.env.HOME, '.deepsteve', 'scheduled-tasks.json');
const readTasksFile = () => JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));

const settings = { scheduledTasksEnabled: true, scheduledTasksOpenInBackground: true };
// Flipped on only by the worktree test — everything else runs in the homedir
// fallback, where no run ever gets a worktree.
let supportsWorktree = false;
const shells = new Map();
const closed = [];       // sessionIds passed to ctx.closeSession
const engine = { onExit: () => {} };
const ctx = {
  settings,
  log: () => {},
  broadcast: () => {},
  shells,
  getContexts: () => [],
  getDefaultEngine: () => engine,
  getAgentConfig: () => ({ supportsWorktree, supportsSessionWatch: false }),
  getSpawnArgs: () => [],
  // Every spawn helper is a stub, so `shells` only ever holds what a test puts there —
  // which is what makes "is this run's session still alive?" directly controllable.
  spawnSession: () => {},
  sessionEnv: () => ({}),
  mcpConfigArgs: () => ['--mcp-config', 'x'], // non-empty ⇒ the run gets the self-report contract
  wireShellOutput: () => {},
  emitSessionOpen: () => {},
  watchClaudeSessionDir: () => {},
  unwatchClaudeSessionDir: () => {},
  deliverPromptWhenReady: () => {},
  validateWorktree: (n) => n,
  resolveConfigDir: () => null,
  validateModel: () => null,
  validateEffort: () => null,
  handleShellGone: () => {},
  saveState: () => {},
  isShuttingDown: () => false,
  deliverToWindow: () => {},
  closeSession: (id) => { closed.push(id); shells.delete(id); },
};

const tools = init(ctx);

const routes = new Map();
registerRoutes({
  get: (p, h) => routes.set(`GET ${p}`, h),
  post: (p, h) => routes.set(`POST ${p}`, h),
  put: (p, h) => routes.set(`PUT ${p}`, h),
  delete: (p, h) => routes.set(`DELETE ${p}`, h),
}, ctx);

// --- harness ---------------------------------------------------------------

function call(route, req = {}) {
  let body = null; let code = 200;
  routes.get(route)({ query: {}, params: {}, body: {}, ...req }, {
    json: (b) => { body = b; return this; },
    status(c) { code = c; return this; },
  });
  return { code, body };
}

const text = (res) => res.content[0].text;

// project:'' keeps runs in the homedir fallback — no git repo, so no worktree.
async function schedule(fields = {}) {
  const res = await tools.schedule_task.handler(
    { title: 'watcher', prompt: 'p', cron: '0 9 * * 1', project: '', ...fields }, {});
  assert.notStrictEqual(res.isError, true, text(res));
  return /#(\w+)/.exec(text(res))[1];
}

// Fire a task and return the new run's shellId, registering it in `shells` so it
// counts as a live session. `clients` non-empty models a browser watching the tab.
async function fire(id, { clients = 0 } = {}) {
  const before = new Set(shells.keys());
  const res = await tools.run_scheduled_task_now.handler({ id }, {});
  assert.notStrictEqual(res.isError, true, text(res));
  const shellId = [...shells.keys()].find((k) => !before.has(k));
  assert.ok(shellId, `no session spawned: ${text(res)}`);
  shells.get(shellId).clients = new Set(Array.from({ length: clients }, (_, i) => i));
  return shellId;
}

// The MCP `extra` shape: the caller's shellId comes out of its own MCP URL.
const asSession = (shellId) => ({ requestInfo: { url: { searchParams: new URLSearchParams({ shellId }) } } });

const listedIds = () => call('GET /api/scheduled-tasks').body.tasks.map((t) => t.id);
const storedTask = (id) => readTasksFile().find((t) => t.id === id);

// purgeTombstonedTasks reports whether it removed ANYTHING, so leftovers from earlier
// tests would make its return value meaningless — drop them first (TTL-expired) so a
// purge assertion is about this test's task alone.
const drainTombstones = () => purgeTombstonedTasks(Date.now() + TOMBSTONE_TTL_MS + 1);

async function listText(scope) {
  return text(await tools.list_scheduled_tasks.handler(scope ? { scope } : {}, {}));
}

// --- the bug ---------------------------------------------------------------

test('deleting a task with a run in flight unschedules it but keeps the run record', async () => {
  const id = await schedule();
  const shellId = await fire(id);

  const del = call('DELETE /api/scheduled-tasks/:id', { params: { id } });
  assert.strictEqual(del.code, 200);
  assert.strictEqual(del.body.tombstoned, true, 'the API says the row was kept');
  assert.strictEqual(del.body.activeSession, shellId);

  // Invisible everywhere a schedule is shown or acted on.
  assert.ok(!listedIds().includes(id), 'gone from the panel payload');
  assert.ok(!(await listText()).includes(id), 'gone from list_scheduled_tasks (project scope)');
  assert.ok(!(await listText('all')).includes(id), 'gone from list_scheduled_tasks (scope: all)');
  assert.match(text(await tools.run_scheduled_task_now.handler({ id }, {})), /not found/);
  assert.match(text(await tools.update_scheduled_task.handler({ id, title: 'x' }, {})), /not found/);
  assert.strictEqual(call('POST /api/scheduled-tasks/:id/run', { params: { id } }).code, 404);
  assert.strictEqual(call('PUT /api/scheduled-tasks/:id', { params: { id }, body: {} }).code, 404);

  // …but the record the live agent depends on is intact and persisted.
  const stored = storedTask(id);
  assert.strictEqual(stored.deleted, true);
  assert.strictEqual(stored.enabled, false, 'a tombstone must never be re-armed');
  assert.strictEqual(stored.nextRun, null);
  assert.ok(stored.deletedAt > 0);
  assert.strictEqual(stored.runs[0].sessionId, shellId);
});

test('the orphaned run can still self-report, and is told its schedule is gone', async () => {
  const id = await schedule();
  const shellId = await fire(id);
  call('DELETE /api/scheduled-tasks/:id', { params: { id } });

  // This exact call is what answered "This session is not a scheduled task run" in #614.
  const started = text(await tools.scheduled_task_started.handler({}, asSession(shellId)));
  assert.match(started, /Marked scheduled run/);
  assert.match(started, /schedule was deleted while this run was in flight/);
  assert.strictEqual(storedTask(id).runs[0].status, 'running');

  const finished = text(await tools.scheduled_task_finished.handler(
    { success: true, summary: 'did the thing' }, asSession(shellId)));
  assert.match(finished, /as succeeded/);
  assert.match(finished, /schedule was deleted while this run was in flight/);
  const run = storedTask(id).runs[0];
  assert.strictEqual(run.status, 'succeeded');
  assert.strictEqual(run.summary, 'did the thing');
});

test('auto-close still fires for an orphaned run — the keepOpen flags survive the delete', async () => {
  const autoId = await schedule();
  const autoShell = await fire(autoId);
  call('DELETE /api/scheduled-tasks/:id', { params: { id: autoId } });
  closed.length = 0;
  await tools.scheduled_task_finished.handler({}, asSession(autoShell));
  assert.deepStrictEqual(closed, [autoShell], 'the unattended tab must still close itself');

  const keepId = await schedule({ keep_open: true });
  const keepShell = await fire(keepId);
  call('DELETE /api/scheduled-tasks/:id', { params: { id: keepId } });
  closed.length = 0;
  await tools.scheduled_task_finished.handler({}, asSession(keepShell));
  assert.deepStrictEqual(closed, [], 'keepOpen is still honored after the delete');
  shells.delete(keepShell);
});

test('an orphaned run is still reaped by its runtime limit', async () => {
  const id = await schedule({ max_runtime_minutes: 30 });
  const shellId = await fire(id);
  call('DELETE /api/scheduled-tasks/:id', { params: { id } });

  closed.length = 0;
  assert.strictEqual(enforceRunTimeouts(Date.now() + 31 * 60 * 1000), true);
  assert.deepStrictEqual(closed, [shellId]);
  assert.strictEqual(storedTask(id).runs[0].status, 'timed-out');
});

// --- purge -----------------------------------------------------------------

test('a delete with no run in flight removes the task outright — no tombstone', async () => {
  const id = await schedule();
  assert.strictEqual(call('DELETE /api/scheduled-tasks/:id', { params: { id } }).body.tombstoned, false);
  assert.strictEqual(storedTask(id), undefined, 'the row is gone from disk, not just hidden');
});

test('the tombstone is purged once no run is active, and never before', async () => {
  drainTombstones();
  const id = await schedule();
  const shellId = await fire(id);
  call('DELETE /api/scheduled-tasks/:id', { params: { id } });

  assert.strictEqual(purgeTombstonedTasks(Date.now()), false, 'a queued run keeps its record');
  assert.ok(storedTask(id));

  await tools.scheduled_task_finished.handler({}, asSession(shellId));
  assert.strictEqual(purgeTombstonedTasks(Date.now()), true);
  assert.strictEqual(storedTask(id), undefined);
});

test('an unreclaimed worktree keeps the tombstone alive for sweepLeakedWorktrees', async () => {
  drainTombstones();
  // A run only gets a worktree on a git-repo project with a worktree-capable agent.
  // Every spawn helper is stubbed, so no worktree is actually created on disk — the
  // run row just carries `worktree` with `worktreeRemoved` unset, which is exactly
  // the post-restart shape: the core restore handler replaced the run's own onExit
  // cleanup, leaving sweepLeakedWorktrees as the only thing that can reclaim it.
  const repo = path.join(process.env.HOME, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  supportsWorktree = true;
  const id = await schedule({ project: repo, isolate_worktree: true });
  const shellId = await fire(id);
  supportsWorktree = false;

  call('DELETE /api/scheduled-tasks/:id', { params: { id } });
  await tools.scheduled_task_finished.handler({}, asSession(shellId));
  const run = storedTask(id).runs[0];
  assert.ok(run.worktree && !run.worktreeRemoved, 'precondition: the run holds an unreclaimed worktree');

  // The tick purges BEFORE sweepLeakedWorktrees runs, so purging here would strip
  // the task.project + run.worktree the sweep needs and leak the directory forever.
  assert.strictEqual(purgeTombstonedTasks(Date.now()), false, 'the worktree pins the row');
  assert.ok(storedTask(id));

  // The TTL is still the backstop, so a worktree git refuses to remove (dirty or
  // unmerged) can't pin a tombstone indefinitely either.
  assert.strictEqual(purgeTombstonedTasks(Date.now() + TOMBSTONE_TTL_MS + 1), true);
  assert.strictEqual(storedTask(id), undefined);
});

test('the TTL purges a tombstone whose run is wedged ACTIVE forever', async () => {
  drainTombstones();
  const id = await schedule();
  const shellId = await fire(id);
  call('DELETE /api/scheduled-tasks/:id', { params: { id } });
  // A shell that died hard: nothing ever moves the status off ACTIVE, because
  // enforceRunTimeouts skips a run whose shell is already gone.
  shells.delete(shellId);
  assert.strictEqual(enforceRunTimeouts(Date.now() + 1e9), false);

  assert.strictEqual(purgeTombstonedTasks(Date.now()), false);
  assert.strictEqual(purgeTombstonedTasks(Date.now() + TOMBSTONE_TTL_MS + 1), true, 'TTL is the backstop');
  assert.strictEqual(storedTask(id), undefined);
});

// --- messages --------------------------------------------------------------

test('unschedule_task distinguishes stopped / already-stopped / never-existed', async () => {
  const idle = await schedule();
  assert.match(text(await tools.unschedule_task.handler({ id: idle })), /Deleted #\w+ "watcher" — it will not fire again/);

  const live = await schedule();
  const shellId = await fire(live);
  assert.match(text(await tools.unschedule_task.handler({ id: live })),
    new RegExp(`Unscheduled #${live}.*will not fire again.*run is still in flight \\(session ${shellId}\\)`, 's'));
  assert.match(text(await tools.unschedule_task.handler({ id: live })), /was already unscheduled; it will not fire again/);

  assert.match(text(await tools.unschedule_task.handler({ id: 'deadbeef' })),
    /No scheduled task #deadbeef exists — nothing is scheduled under that id/);

  await tools.scheduled_task_finished.handler({}, asSession(shellId));
  purgeTombstonedTasks(Date.now());
});

test('a session with no run record is told why, and how to check and stop the schedule', async () => {
  for (const res of [
    await tools.scheduled_task_started.handler({}, asSession('nosuch12')),
    await tools.scheduled_task_finished.handler({}, asSession('nosuch12')),
  ]) {
    const t = text(res);
    assert.notStrictEqual(res.isError, true, 'a no-op notice, not a failure');
    assert.match(t, /nosuch12/, 'names the session it could not resolve');
    assert.match(t, /resumed or forked under a new session id/, 'names the real cause');
    assert.match(t, /list_scheduled_tasks/);
    assert.match(t, /unschedule_task/, 'hands back the call that stops a runaway schedule');
  }
});

// --- the second route to the same defect -----------------------------------

test('a live run is never evicted from run history by the MAX_RUNS cap', async () => {
  const id = await schedule({ keep_open: true });
  // The real shape: a keepOpen run that has already reported (so it no longer blocks
  // the overlap guard) but whose tab the user left open.
  const survivor = await fire(id);
  await tools.scheduled_task_started.handler({}, asSession(survivor));
  await tools.scheduled_task_finished.handler({}, asSession(survivor));
  assert.ok(shells.has(survivor), 'keepOpen leaves the tab alive');

  // 25 later fires, each retired immediately, would push that first row off a blind
  // `runs.length = 20` truncation — orphaning the tab that is still open.
  for (let i = 0; i < 25; i++) {
    const s = await fire(id);
    await tools.scheduled_task_finished.handler({}, asSession(s));
    shells.delete(s);
  }
  const stored = storedTask(id);
  assert.ok(stored.runs.some((r) => r.sessionId === survivor), 'the live run kept its record');
  assert.ok(stored.runs.length <= 21, `history stays bounded (got ${stored.runs.length})`);

  // And it can still self-report, which is the whole reason the row matters.
  assert.match(text(await tools.scheduled_task_finished.handler({}, asSession(survivor))), /Marked scheduled run/);
  shells.delete(survivor);
  await tools.unschedule_task.handler({ id });
});
