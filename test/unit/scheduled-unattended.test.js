// Unit tests for the unattended-run fixes in #596.
//
// A scheduled fire with zero browsers connected is a supported, documented case,
// but three things went wrong in it: the queued tab outlived the run and came back
// as a zombie, a stuck run wedged its task forever, and the auto-updater restarted
// the daemon out from under work in progress. These cover the mod's half; the queue
// itself is covered by pending-opens.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-unattended-home-'));

const { init, enforceRunTimeouts } = require('../../mods/scheduled-tasks/tools.js');
const { createPendingOpens } = require('../../pending-opens.js');

const TASKS_FILE = path.join(process.env.HOME, '.deepsteve', 'scheduled-tasks.json');
const MINUTE = 60 * 1000;

const pendingOpens = createPendingOpens();
const closed = [];        // [id, reason] for every ctx.closeSession call
let restartBlocker = null;

const settings = { scheduledTasksEnabled: true, scheduledTasksOpenInBackground: true };
const engine = { onExit: () => {} };
const ctx = {
  settings,
  log: () => {},
  broadcast: () => {},
  shells: new Map(),
  getContexts: () => [],
  getDefaultEngine: () => engine,
  getAgentConfig: () => ({ supportsWorktree: false, supportsSessionWatch: false }),
  getSpawnArgs: () => [],
  spawnSession: () => {},
  sessionEnv: () => ({}),
  mcpConfigArgs: () => [],
  wireShellOutput: () => {},
  emitSessionOpen: () => {},
  watchClaudeSessionDir: () => {},
  unwatchClaudeSessionDir: () => {},
  deliverPromptWhenReady: () => {},
  validateWorktree: (n) => n,
  handleShellGone: () => {},
  saveState: () => {},
  isShuttingDown: () => false,
  // Model the real daemon with no browser connected: deliverToWindow parks the message.
  deliverToWindow: (msg) => pendingOpens.push(msg),
  // Model closeSession's #596 behavior: tombstoneSession retracts the queued tab.
  closeSession: (id, reason) => {
    closed.push([id, reason]);
    ctx.shells.delete(id);
    pendingOpens.drop(id);
    return true;
  },
  registerRestartBlocker: (fn) => { restartBlocker = fn; },
};

const tools = init(ctx); // .unref()'d timers, so this doesn't hang the test process

// project:'' keeps the run in the homedir fallback — no git repo, no worktree.
async function makeTask(fields = {}) {
  const res = await tools.schedule_task.handler(
    { title: 'unattended test', prompt: 'do the thing', cron: '0 9 * * 1', project: '', ...fields }, {});
  return /#(\w+)/.exec(res.content[0].text)[1];
}

// Fire the task and register its shell the way the daemon would: live PTY, no
// client attached (nobody is looking at it).
async function fire(taskId) {
  await tools.run_scheduled_task_now.handler({ id: taskId }, {});
  const queued = pendingOpens.toArray().map((m) => JSON.parse(m));
  const shellId = queued[queued.length - 1].id;
  ctx.shells.set(shellId, { clients: new Set() });
  return shellId;
}

// The MCP tools identify their caller by the ?shellId= in their MCP URL.
const asCaller = (shellId) => ({ requestInfo: { url: { searchParams: { get: () => shellId } } } });

// Run status is written through to disk on every mutation, so the file is the
// honest place to read it back from.
function storedRun(shellId) {
  const stored = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  for (const t of stored) {
    const r = (t.runs || []).find((x) => x.sessionId === shellId);
    if (r) return r;
  }
  throw new Error(`no stored run for ${shellId}`);
}
function storedTask(id) {
  return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).find((t) => t.id === id);
}

test('a run that finishes before any browser connects leaves nothing to flush', async () => {
  pendingOpens.clear();
  const id = await makeTask();
  const shellId = await fire(id);
  assert.strictEqual(pendingOpens.length, 1, 'the tab queues while nobody is connected');

  await tools.scheduled_task_finished.handler({ success: true, summary: 'done' }, asCaller(shellId));
  assert.deepStrictEqual(closed.pop(), [shellId, 'scheduled'], 'auto-close still fires unattended');

  // A browser finally connects.
  const { send } = pendingOpens.takeFor('w1', (p) => ctx.shells.has(p.id));
  assert.deepStrictEqual(send, [], 'a finished run must not open a zombie tab');
});

test('a run still in flight when a browser connects DOES surface', async () => {
  pendingOpens.clear();
  const id = await makeTask({ keep_open: true });
  const shellId = await fire(id);
  const { send } = pendingOpens.takeFor('w1', (p) => ctx.shells.has(p.id));
  assert.strictEqual(send.length, 1, 'the documented pendingOpens behavior must survive');
  const msg = JSON.parse(send[0]);
  assert.strictEqual(msg.id, shellId);
  assert.strictEqual(msg.background, true, 'and it still lands unfocused');
  ctx.shells.clear();
});

test('an unattended run in flight blocks the auto-updater', async () => {
  assert.ok(restartBlocker, 'the mod registers a restart blocker');
  pendingOpens.clear();
  const id = await makeTask();
  const shellId = await fire(id);

  const blocked = restartBlocker();
  assert.ok(blocked && /in flight/.test(blocked.reason), 'restarting now would kill the run');

  // A human watching the tab owns it — the updater is not the one interrupting.
  ctx.shells.get(shellId).clients.add({});
  assert.strictEqual(restartBlocker(), null);
  ctx.shells.get(shellId).clients.clear();

  // Self-reported terminal: nothing left to protect.
  await tools.scheduled_task_finished.handler({ success: true }, asCaller(shellId));
  assert.strictEqual(restartBlocker(), null);
  ctx.shells.clear();
});

test('the kill-switch also disarms the restart blocker', async () => {
  pendingOpens.clear();
  const id = await makeTask();
  await fire(id);
  assert.ok(restartBlocker(), 'blocking while the feature is on');
  settings.scheduledTasksEnabled = false;
  assert.strictEqual(restartBlocker(), null, 'a disabled feature must not hold up updates');
  settings.scheduledTasksEnabled = true;
  ctx.shells.clear();
});

test('a run past its time limit is closed and marked timed-out', async () => {
  pendingOpens.clear();
  closed.length = 0;
  const id = await makeTask({ max_runtime_minutes: 30 });
  assert.strictEqual(storedTask(id).maxRuntimeMinutes, 30, 'the limit round-trips MCP → disk');
  const shellId = await fire(id);
  await tools.scheduled_task_started.handler({}, asCaller(shellId));

  enforceRunTimeouts(Date.now() + 29 * MINUTE);
  assert.strictEqual(closed.length, 0, 'not yet over the limit');
  enforceRunTimeouts(Date.now() + 31 * MINUTE);

  assert.deepStrictEqual(closed.pop(), [shellId, 'scheduled-timeout']);
  const run = storedRun(shellId);
  assert.strictEqual(run.status, 'timed-out', 'not an ACTIVE status, so it stops blocking future fires');
  assert.strictEqual(run.success, false);
  assert.ok(/Timed out/.test(run.summary));
  ctx.shells.clear();
});

test('a watched run is never timed out, and 0 means no limit', async () => {
  pendingOpens.clear();
  closed.length = 0;

  const watched = await makeTask({ max_runtime_minutes: 1 });
  const watchedShell = await fire(watched);
  ctx.shells.get(watchedShell).clients.add({}); // a human has the tab open
  enforceRunTimeouts(Date.now() + 24 * 60 * MINUTE);
  assert.strictEqual(closed.length, 0, 'a tab someone is watching belongs to them');
  assert.strictEqual(storedRun(watchedShell).status, 'queued');
  ctx.shells.clear();

  const unlimited = await makeTask({ max_runtime_minutes: 0 });
  const unlimitedShell = await fire(unlimited);
  assert.strictEqual(storedTask(unlimited).maxRuntimeMinutes, 0);
  enforceRunTimeouts(Date.now() + 24 * 60 * MINUTE);
  assert.strictEqual(closed.length, 0, '0 disables the limit outright');
  assert.strictEqual(storedRun(unlimitedShell).status, 'queued');
  ctx.shells.clear();
});
