// Unit tests for the Run-now response contract (#611). The panel's button used to
// discard the response entirely, and the overlap-guard skip answers HTTP 200 with
// started:false — so a click that started nothing looked identical to one that did.
// The route now names the reason (and the run that's blocking it) so the card can
// say so inline.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-runnow-home-'));

const { init, registerRoutes } = require('../../mods/scheduled-tasks/tools.js');

const opens = []; // every open-session message runTask delivered

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
  // No-op auto-close: the tab deliberately stays in `shells`, which is what lets the
  // last test assert that a *terminal* run stops blocking even while its tab lives.
  closeSession: () => {},
  saveState: () => {},
  isShuttingDown: () => false,
  deliverToWindow: (msg) => opens.push(msg),
};

const tools = init(ctx); // .unref()'d timers, so this doesn't hang the test process

const routes = new Map();
registerRoutes({
  get: (p, h) => routes.set(`GET ${p}`, h),
  post: (p, h) => routes.set(`POST ${p}`, h),
  put: (p, h) => routes.set(`PUT ${p}`, h),
  delete: (p, h) => routes.set(`DELETE ${p}`, h),
}, ctx);

// project:'' keeps the run in the homedir fallback — no git repo, no worktree.
async function makeTask() {
  const res = await tools.schedule_task.handler(
    { title: 'run-now test', prompt: 'do the thing', cron: '0 9 * * 1', project: '' }, {});
  return /#(\w+)/.exec(res.content[0].text)[1];
}

function runViaPanel(id) {
  const handler = routes.get('POST /api/scheduled-tasks/:id/run');
  assert.ok(handler, 'panel Run-now route should be registered');
  let body = null;
  handler({ params: { id }, body: {} }, {
    json: (b) => { body = b; },
    status() { return this; },
  });
  return body;
}

// The self-report tools identify their run by the ?shellId= in the caller's MCP URL.
const asRun = (shellId) => ({ requestInfo: { url: new URL(`http://localhost/mcp?shellId=${shellId}`) } });

test('a run that starts reports its session id', async () => {
  const id = await makeTask();
  opens.length = 0;
  const body = runViaPanel(id);
  assert.strictEqual(body.started, true);
  assert.match(body.sessionId, /^[0-9a-f]{8}$/, 'the new run\'s 8-char shell id');
  assert.strictEqual(opens.length, 1, 'one tab opened');
});

test('a run blocked by the overlap guard names the run that is blocking it', async () => {
  const id = await makeTask();
  ctx.shells.clear();
  opens.length = 0;

  const first = runViaPanel(id);
  assert.strictEqual(first.started, true);
  // runTask registered the live shell itself; the run row is still 'queued'.
  assert.ok(ctx.shells.has(first.sessionId), 'first run has a live shell');

  const second = runViaPanel(id);
  assert.strictEqual(second.started, false, 'must not stack a second run');
  assert.strictEqual(second.reason, 'active-run');
  assert.strictEqual(second.activeSessionId, first.sessionId,
    'the panel needs the blocking run id to say which run is in the way');
  assert.strictEqual(opens.length, 1, 'no second tab opened');
});

test('a terminal previous run no longer blocks (the #525 rule survives the extraction)', async () => {
  const id = await makeTask();
  ctx.shells.clear();
  opens.length = 0;

  const first = runViaPanel(id);
  assert.strictEqual(first.started, true);
  assert.strictEqual(runViaPanel(id).started, false, 'blocked while the run is queued');

  // Self-report completion the way scheduled_task_finished does. The tab stays alive
  // (shell still in ctx.shells) — terminal status alone must unblock the next fire.
  await tools.scheduled_task_finished.handler(
    { success: true, summary: 'done' }, asRun(first.sessionId));
  assert.ok(ctx.shells.has(first.sessionId), 'idle tab still alive');

  const third = runViaPanel(id);
  assert.strictEqual(third.started, true, 'a finished run must not block the next one');
  assert.notStrictEqual(third.sessionId, first.sessionId);
});
