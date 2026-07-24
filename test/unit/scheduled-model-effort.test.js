// Unit tests for per-task model / effort / config-profile selection on scheduled
// runs (#592). Before this, runTask spawned a bare `claude`: the model was whatever
// Claude Code happened to pick (including silent fallbacks off Opus on usage
// limits), effort was never set and never recorded, and custom config profiles
// (#537) were unreachable from automations — runTask was the only spawn path in
// the codebase that never passed configDir.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-model-home-'));

const { init, registerRoutes } = require('../../mods/scheduled-tasks/tools.js');

const spawns = []; // { agentType, opts } per getSpawnArgs call
const envs = [];   // sessionEnv option bags

// Same validators the server exposes on the mod ctx (server.js validateModel /
// validateEffort). Duplicated rather than imported because requiring server.js
// would boot the daemon.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const validateModel = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v.trim()) ? v.trim() : null);
const validateEffort = (v) => (typeof v === 'string' && EFFORT_LEVELS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

const PROFILES = { p1: '/tmp/ds-profile-one' };

const settings = { scheduledTasksEnabled: true, scheduledTasksOpenInBackground: true };
const engine = { onExit: () => {} };
const shells = new Map();
const ctx = {
  settings,
  log: () => {},
  broadcast: () => {},
  shells,
  getContexts: () => [],
  getDefaultEngine: () => engine,
  getAgentConfig: () => ({ supportsWorktree: false, supportsSessionWatch: false }),
  getSpawnArgs: (agentType, opts) => { spawns.push({ agentType, opts }); return []; },
  spawnSession: () => {},
  sessionEnv: (id, opts) => { envs.push(opts); return {}; },
  mcpConfigArgs: () => [],
  wireShellOutput: () => {},
  emitSessionOpen: () => {},
  watchClaudeSessionDir: () => {},
  unwatchClaudeSessionDir: () => {},
  deliverPromptWhenReady: () => {},
  validateWorktree: (n) => n,
  resolveConfigDir: (pid) => PROFILES[pid] || null,
  validateModel,
  validateEffort,
  handleShellGone: () => {},
  saveState: () => {},
  isShuttingDown: () => false,
  deliverToWindow: () => {},
};

const tools = init(ctx);

const routes = new Map();
registerRoutes({
  get: (p, h) => routes.set(`GET ${p}`, h),
  post: (p, h) => routes.set(`POST ${p}`, h),
  put: (p, h) => routes.set(`PUT ${p}`, h),
  delete: (p, h) => routes.set(`DELETE ${p}`, h),
}, ctx);

// project:'' keeps runs in the homedir fallback — no git repo, no worktree.
async function schedule(fields) {
  const res = await tools.schedule_task.handler(
    { title: 't', prompt: 'p', cron: '0 9 * * 1', project: '', ...fields }, {});
  assert.notStrictEqual(res.isError, true, res.content[0].text);
  return /#(\w+)/.exec(res.content[0].text)[1];
}

function listTasks() {
  const handler = routes.get('GET /api/scheduled-tasks');
  let body = null;
  handler({ query: {} }, { json: (b) => { body = b; }, status() { return this; } });
  return body.tasks;
}
const getTask = (id) => listTasks().find((t) => t.id === id);

async function run(id) {
  spawns.length = 0; envs.length = 0;
  const res = await tools.run_scheduled_task_now.handler({ id }, {});
  assert.notStrictEqual(res.isError, true);
  return { spawn: spawns[spawns.length - 1], env: envs[envs.length - 1] };
}

test('model + effort reach getSpawnArgs and are recorded on the run row', async () => {
  const id = await schedule({ model: 'haiku', effort: 'low' });
  const { spawn } = await run(id);
  assert.strictEqual(spawn.opts.model, 'haiku');
  assert.strictEqual(spawn.opts.effort, 'low');
  const task = getTask(id);
  assert.strictEqual(task.runs[0].model, 'haiku', 'effective model recorded per run');
  assert.strictEqual(task.runs[0].effort, 'low', 'effective effort recorded per run');
});

test('a full model id is accepted; an unusable one falls back to the default', async () => {
  const pinned = await schedule({ model: 'claude-fable-5' });
  assert.strictEqual((await run(pinned)).spawn.opts.model, 'claude-fable-5');

  // Junk must never reach argv — it degrades to "inherit Claude Code's default".
  const junk = await schedule({ model: 'rm -rf /' });
  assert.strictEqual(getTask(junk).model, null);
  assert.strictEqual((await run(junk)).spawn.opts.model, null);
});

test('unset model/effort keep the pre-#592 behavior (no flags)', async () => {
  const id = await schedule({});
  const { spawn } = await run(id);
  assert.strictEqual(spawn.opts.model, null);
  assert.strictEqual(spawn.opts.effort, null);
});

test('a config profile is stored by id and resolved to a dir at spawn time', async () => {
  const id = await schedule({ config_profile: 'p1' });
  const task = getTask(id);
  assert.strictEqual(task.agentType, 'claude');
  assert.strictEqual(task.configProfile, 'p1', 'the id is stored, not the resolved dir');

  const { env } = await run(id);
  assert.strictEqual(env.configDir, PROFILES.p1, 'runTask must pass configDir to sessionEnv');
  const entry = [...shells.values()].pop();
  assert.strictEqual(entry.configDir, PROFILES.p1, 'and persist it on the shell entry (restore/#542)');
  assert.strictEqual(getTask(id).runs[0].configDir, PROFILES.p1);
});

test("a deleted profile resolves to null rather than breaking the run", async () => {
  const id = await schedule({ config_profile: 'gone' });
  const { env } = await run(id);
  assert.strictEqual(env.configDir, null, 'falls back to the default config dir');
});

test("the dropdown's 'config:<id>' agent form is split into agentType + profile", async () => {
  const id = await schedule({ agent_type: 'config:p1' });
  const task = getTask(id);
  assert.strictEqual(task.agentType, 'claude', 'a profile is claude, not a new agent type');
  assert.strictEqual(task.configProfile, 'p1');
});

test('switching to a non-claude agent drops the profile', async () => {
  const id = await schedule({ config_profile: 'p1' });
  await tools.update_scheduled_task.handler({ id, agent_type: 'pi' }, {});
  const task = getTask(id);
  assert.strictEqual(task.agentType, 'pi');
  assert.strictEqual(task.configProfile, null);
  // ...and a non-claude run gets no configDir at all.
  const { env } = await run(id);
  assert.strictEqual(env.configDir, null);
});

test('update_scheduled_task edits model/effort, and "" clears back to default', async () => {
  const id = await schedule({ model: 'opus', effort: 'max' });
  await tools.update_scheduled_task.handler({ id, model: 'sonnet', effort: 'high' }, {});
  assert.strictEqual(getTask(id).model, 'sonnet');
  assert.strictEqual(getTask(id).effort, 'high');

  await tools.update_scheduled_task.handler({ id, model: '', effort: '' }, {});
  assert.strictEqual(getTask(id).model, null, 'empty string = back to inheriting the default');
  assert.strictEqual(getTask(id).effort, null);
});

test('the REST create path accepts the same three fields', async () => {
  const handler = routes.get('POST /api/scheduled-tasks');
  let body = null;
  handler({ body: { title: 'rest', prompt: 'p', cron: '0 9 * * 1', project: '', model: 'fable', effort: 'xhigh', configProfile: 'p1' } },
    { json: (b) => { body = b; }, status() { return this; } });
  assert.ok(body && body.task, 'task created');
  assert.strictEqual(body.task.model, 'fable');
  assert.strictEqual(body.task.effort, 'xhigh');
  assert.strictEqual(body.task.configProfile, 'p1');
});
