// Unit tests for the SYSTEM-LEVEL default model / thinking level for scheduled runs
// (#604). #592 gave each task its own model/effort, but an unset task still meant
// "inherit Claude Code's own default" — the exact behavior that can silently drop to
// a cheaper model on usage limits. These settings are the fallback for any task that
// hasn't pinned its own, including tasks an agent creates later via schedule_task.
//
// Two things are load-bearing and both are asserted here: the fallback is read LIVE
// off ctx.settings (so a Settings change applies to existing tasks with no restart),
// and it is re-validated exactly like a task value (a settings value is no more
// trusted at the argv boundary than a task one).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-default-home-'));

const { init, registerRoutes } = require('../../mods/scheduled-tasks/tools.js');

const spawns = []; // { agentType, opts } per getSpawnArgs call

// Same validators the server exposes on the mod ctx (server.js validateModel /
// validateEffort). Duplicated rather than imported because requiring server.js
// would boot the daemon.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const validateModel = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v.trim()) ? v.trim() : null);
const validateEffort = (v) => (typeof v === 'string' && EFFORT_LEVELS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

// Mutated in place between tests, exactly as POST /api/settings does at runtime.
const settings = {
  scheduledTasksEnabled: true,
  scheduledTasksOpenInBackground: true,
  scheduledDefaultModel: '',
  scheduledDefaultEffort: '',
};
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
  sessionEnv: () => ({}),
  mcpConfigArgs: () => [],
  wireShellOutput: () => {},
  emitSessionOpen: () => {},
  watchClaudeSessionDir: () => {},
  unwatchClaudeSessionDir: () => {},
  deliverPromptWhenReady: () => {},
  validateWorktree: (n) => n,
  resolveConfigDir: () => null,
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

function listPayload() {
  const handler = routes.get('GET /api/scheduled-tasks');
  let body = null;
  handler({ query: {} }, { json: (b) => { body = b; }, status() { return this; } });
  return body;
}
const getTask = (id) => listPayload().tasks.find((t) => t.id === id);

async function run(id) {
  spawns.length = 0;
  // The overlap guard skips a fire while the previous run's session is still in
  // `shells`; these tests re-fire the same task, so retire the old tab first.
  shells.clear();
  const res = await tools.run_scheduled_task_now.handler({ id }, {});
  assert.notStrictEqual(res.isError, true);
  return spawns[spawns.length - 1];
}

function setDefaults(model, effort) {
  settings.scheduledDefaultModel = model;
  settings.scheduledDefaultEffort = effort;
}

test('an unpinned task inherits the system default instead of Claude Code\'s', async () => {
  setDefaults('sonnet', 'medium');
  const id = await schedule({});
  const spawn = await run(id);
  assert.strictEqual(spawn.opts.model, 'sonnet');
  assert.strictEqual(spawn.opts.effort, 'medium');
  // The task itself stays unpinned — the setting is a fallback, not a rewrite, so
  // clearing the setting later returns the task to inheriting Claude Code's default.
  assert.strictEqual(getTask(id).model, null);
  assert.strictEqual(getTask(id).effort, null);
});

test('the run row records the RESOLVED values, not null', async () => {
  setDefaults('haiku', 'low');
  const id = await schedule({});
  await run(id);
  const last = getTask(id).runs[0];
  assert.strictEqual(last.model, 'haiku', 'history must show what the run actually used');
  assert.strictEqual(last.effort, 'low');
});

test('a task that pins its own model/effort overrides the system default', async () => {
  setDefaults('sonnet', 'medium');
  const id = await schedule({ model: 'opus', effort: 'max' });
  const spawn = await run(id);
  assert.strictEqual(spawn.opts.model, 'opus');
  assert.strictEqual(spawn.opts.effort, 'max');
});

test('either field falls back independently', async () => {
  setDefaults('sonnet', 'medium');
  const modelOnly = await schedule({ model: 'fable' });
  let spawn = await run(modelOnly);
  assert.strictEqual(spawn.opts.model, 'fable');
  assert.strictEqual(spawn.opts.effort, 'medium', 'unpinned effort still takes the default');

  const effortOnly = await schedule({ effort: 'high' });
  spawn = await run(effortOnly);
  assert.strictEqual(spawn.opts.model, 'sonnet');
  assert.strictEqual(spawn.opts.effort, 'high');
});

test('the setting is read live — a change applies to the NEXT fire, no restart', async () => {
  setDefaults('', '');
  const id = await schedule({});
  let spawn = await run(id);
  assert.strictEqual(spawn.opts.model, null, 'empty setting = pre-#604 behavior');
  assert.strictEqual(spawn.opts.effort, null);

  // Exactly what POST /api/settings does: mutate the shared settings object.
  setDefaults('haiku', 'xhigh');
  spawn = await run(id);
  assert.strictEqual(spawn.opts.model, 'haiku');
  assert.strictEqual(spawn.opts.effort, 'xhigh');

  setDefaults('', '');
  spawn = await run(id);
  assert.strictEqual(spawn.opts.model, null, 'clearing it returns to inheriting');
});

test('a junk settings value can never reach argv', async () => {
  setDefaults('rm -rf /', 'turbo');
  const id = await schedule({});
  const spawn = await run(id);
  assert.strictEqual(spawn.opts.model, null);
  assert.strictEqual(spawn.opts.effort, null);
});

test('a non-claude task is unaffected by the defaults', async () => {
  setDefaults('sonnet', 'medium');
  const id = await schedule({ agent_type: 'pi' });
  const spawn = await run(id);
  assert.strictEqual(spawn.agentType, 'pi');
  // getSpawnArgs still receives them, but modelArgs() no-ops for an agent whose
  // AGENT_CONFIGS entry declares no modelFlag/effortFlag — asserted in
  // codex-lifecycle.test.js ("non-claude agents never get model/effort flags").
  assert.ok(spawn.opts);
});

test('GET /api/scheduled-tasks exposes the resolved defaults for the form labels', async () => {
  setDefaults('sonnet', 'medium');
  assert.deepStrictEqual(listPayload().defaults, { model: 'sonnet', effort: 'medium' });

  setDefaults('nope nope', '');
  assert.deepStrictEqual(listPayload().defaults, { model: null, effort: null },
    'an unusable value reports as "no default", matching what a run would do');
});

// --- the SETTINGS_SCHEMA entries themselves -------------------------------------
// Evaluated straight out of server.js source (same trick as codex-lifecycle.test.js)
// so the daemon isn't booted just to check two coercions.
function loadSettingsHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const from = src.indexOf('const SETTINGS_SCHEMA = [');
  const to = src.indexOf('let settings = buildDefaults();', from);
  assert.ok(from >= 0 && to > from, 'settings schema source markers moved');
  // The block closes over a pile of unrelated constants (WAND_DEFAULT_TEMPLATE,
  // SCROLLBACK_DEFAULT_KB, …). Only the two #604 entries are exercised, so unknown
  // globals resolve to undefined instead of being enumerated here — otherwise this
  // test breaks every time an unrelated setting is added.
  const real = {
    EFFORT_LEVELS,
    validateModel,
    broadcast: () => {},
    provisionAllProfileSkills: () => {},
    genContextId: () => 'id',
    log: () => {},
    fs, path, os,
  };
  const context = vm.createContext(new Proxy(real, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : globalThis[k]), // builtins still resolve; unknown consts are undefined
  }));
  vm.runInContext(`${src.slice(from, to)}
result = { SETTINGS_SCHEMA, buildDefaults, applySettingsFromBody }`, context);
  return real.result;
}

test('the settings schema accepts aliases and full ids, and rejects junk', () => {
  const { buildDefaults, applySettingsFromBody } = loadSettingsHelpers();

  const s = buildDefaults();
  assert.strictEqual(s.scheduledDefaultModel, '', 'default = inherit');
  assert.strictEqual(s.scheduledDefaultEffort, '');

  let warnings = applySettingsFromBody({ scheduledDefaultModel: 'sonnet', scheduledDefaultEffort: 'medium' }, s);
  assert.strictEqual(warnings.length, 0, 'both accepted with no warnings');
  assert.strictEqual(s.scheduledDefaultModel, 'sonnet');
  assert.strictEqual(s.scheduledDefaultEffort, 'medium');

  applySettingsFromBody({ scheduledDefaultModel: '  claude-fable-5  ' }, s);
  assert.strictEqual(s.scheduledDefaultModel, 'claude-fable-5', 'a full id is allowed, trimmed');

  warnings = applySettingsFromBody({ scheduledDefaultModel: 'rm -rf /', scheduledDefaultEffort: 'turbo' }, s);
  assert.strictEqual(warnings.length, 2, 'both rejections are reported to the caller');
  assert.strictEqual(s.scheduledDefaultModel, 'claude-fable-5', 'a rejected value leaves the old one intact');
  assert.strictEqual(s.scheduledDefaultEffort, 'medium');

  applySettingsFromBody({ scheduledDefaultModel: '', scheduledDefaultEffort: '' }, s);
  assert.strictEqual(s.scheduledDefaultModel, '', 'empty string clears back to inherit');
  assert.strictEqual(s.scheduledDefaultEffort, '');
});
