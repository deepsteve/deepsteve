// Unit tests for the background open of scheduled runs (#600). A scheduled fire is
// unattended, so the `open-session` message it delivers carries background:true and
// the browser leaves the new tab unfocused. The panel's own "Run now" button is the
// one exception (the user just asked to see the run), and the global
// `scheduledTasksOpenInBackground` setting can turn the whole thing off — read live,
// so toggling it in Settings needs no restart.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-bg-home-'));

const { init, registerRoutes } = require('../../mods/scheduled-tasks/tools.js');

const opens = []; // every open-session message runTask delivered

// Minimal daemon stand-in: enough for runTask to reach its deliverToWindow call
// without spawning anything real. Settings is mutated in place, exactly like the
// live daemon.
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
  deliverToWindow: (msg) => opens.push(msg),
};

const tools = init(ctx); // .unref()'d timers, so this doesn't hang the test process

// Capture the REST handlers the same way express would.
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
    { title: 'bg test', prompt: 'do the thing', cron: '0 9 * * 1', project: '' }, {});
  const id = /#(\w+)/.exec(res.content[0].text)[1];
  return id;
}

// Drive POST /api/scheduled-tasks/:id/run with a stub req/res.
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

const lastOpen = () => opens[opens.length - 1];

test('an agent-triggered run_scheduled_task_now opens in the background', async () => {
  settings.scheduledTasksOpenInBackground = true;
  const id = await makeTask();
  opens.length = 0;
  const res = await tools.run_scheduled_task_now.handler({ id }, {});
  assert.notStrictEqual(res.isError, true);
  assert.strictEqual(opens.length, 1, 'exactly one open-session delivered');
  assert.strictEqual(lastOpen().type, 'open-session');
  assert.strictEqual(lastOpen().background, true, 'unattended run must not steal focus');
});

test('the setting is read live: turning it off restores the focusing open', async () => {
  const id = await makeTask();
  settings.scheduledTasksOpenInBackground = false; // mutated in place, no re-init
  opens.length = 0;
  await tools.run_scheduled_task_now.handler({ id }, {});
  assert.strictEqual(lastOpen().background, false, 'setting off => old focus-stealing behavior');
  settings.scheduledTasksOpenInBackground = true;
});

test('the panel Run-now button always opens in the foreground', async () => {
  const id = await makeTask();
  settings.scheduledTasksOpenInBackground = true;
  opens.length = 0;
  const body = runViaPanel(id);
  assert.strictEqual(body.started, true, 'panel run should start a session');
  assert.strictEqual(opens.length, 1);
  assert.strictEqual(lastOpen().background, false,
    'the user explicitly clicked Run now, so the tab should be focused');
});
