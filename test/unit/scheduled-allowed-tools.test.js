// #612: a scheduled fire pre-permits the two MCP tools its own prompt contract
// REQUIRES it to call (scheduled_task_started / scheduled_task_finished).
//
// Without this, whether an unattended run can honor the contract deepsteve imposed on
// it depends on whatever settings.json allowlist happens to exist in the target
// project — and the default path is the worst case, since per-run worktree isolation
// (#565) puts the run in a fresh claude-native worktree with no inherited permissions.
// A run that blocks on "Do you want to proceed?" never self-reports, so its status
// stays `running` forever and the overlap guard skips every subsequent fire of that
// task until maxRuntimeMinutes closes it an hour later.
//
// Three things are load-bearing and all are asserted here:
//   1. the flag is emitted as ONE comma-joined value — claude's --allowedTools is
//      variadic ("<tools...>"), so N argv items could let the parser swallow the
//      --worktree / --mcp-config that follow it;
//   2. it is re-applied on RESUME (Claude's --resume carries no session flags, same
//      reason --permission-mode and --model are re-applied) and survives the
//      serializeShellEntry round-trip that a daemon restart goes through;
//   3. every name is re-validated at the argv boundary, so a hand-edited state.json
//      can't inject arguments.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-allowed-home-'));

const { init, CONTRACT_TOOLS } = require('../../mods/scheduled-tasks/tools.js');

const CONTRACT_VALUE = 'mcp__deepsteve__scheduled_task_started,mcp__deepsteve__scheduled_task_finished';

// ---------------------------------------------------------------------------
// Part 1: the real argv builders, evaluated out of server.js source (requiring
// server.js would bind ports and start background timers). Same trick as
// test/unit/codex-lifecycle.test.js.
// ---------------------------------------------------------------------------

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

function loadArgumentHelpers(home) {
  const code = sourceBetween('const AGENT_CONFIGS', 'function validateWorktree')
    + sourceBetween('function serializeShellEntry', 'function tombstoneSession');
  const context = {
    fs, path,
    os: { homedir: () => home },
    // DS_DIR is a module-scope const in server.js (#621), outside every extracted
    // range, so the vm context has to supply it. Same value stateDir() computes
    // from this fake home, keeping the isolation these helpers rely on.
    DS_DIR: path.join(home, '.deepsteve'),
    PORT: 3456,
    AUTH_TOKEN: 'unit-token',
    CLAUDE_SCREEN_MARKERS: {},
    settings: {},
    spawnSession: () => {},
    log: () => {},
  };
  vm.runInNewContext(`${code}
result = { AGENT_CONFIGS, getSpawnArgs, getResumeArgs, allowedToolsArgs, validateToolName, serializeShellEntry }`, context);
  return context.result;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-allowed-tools-'));
const helpers = loadArgumentHelpers(home);

const baseOpts = { sessionId: 'claude-session', planMode: false, worktree: null, shellId: 'abcddcba' };

test('the contract tools reach claude argv as one comma-joined --allowedTools value', () => {
  const args = Array.from(helpers.getSpawnArgs('claude', { ...baseOpts, allowedTools: CONTRACT_TOOLS }));
  const i = args.indexOf('--allowedTools');
  assert.ok(i >= 0, `no --allowedTools in ${JSON.stringify(args)}`);
  // One value, not two argv items — a variadic parser must not be able to eat what follows.
  assert.strictEqual(args[i + 1], CONTRACT_VALUE);
  assert.strictEqual(args.filter((a) => a === '--allowedTools').length, 1);
});

test('--allowedTools sits before --worktree and --mcp-config, so nothing can be swallowed', () => {
  const args = Array.from(helpers.getSpawnArgs('claude', {
    ...baseOpts, worktree: 'scheduled-abcddcba', model: 'sonnet', effort: 'low', allowedTools: CONTRACT_TOOLS,
  }));
  assert.deepStrictEqual(args, [
    '--session-id', 'claude-session',
    '--model', 'sonnet',
    '--effort', 'low',
    '--allowedTools', CONTRACT_VALUE,
    '--worktree', 'scheduled-abcddcba',
    '--mcp-config', path.join(home, '.deepsteve', 'mcp-configs', 'abcddcba.json'),
  ]);
});

test('--allowedTools is re-applied on resume (claude --resume carries no session flags)', () => {
  const args = Array.from(helpers.getResumeArgs('claude', { ...baseOpts, allowedTools: CONTRACT_TOOLS }));
  const i = args.indexOf('--allowedTools');
  assert.ok(i >= 0, `no --allowedTools in ${JSON.stringify(args)}`);
  assert.strictEqual(args[i + 1], CONTRACT_VALUE);
});

test('the grant survives the serializeShellEntry round-trip a restart goes through', () => {
  // This is the whole reason it is persisted rather than recomputed: a restart replaces
  // the mod's spawn with the core restore path, which only sees what state.json holds.
  const saved = helpers.serializeShellEntry({ cwd: '/tmp', claudeSessionId: 'x', allowedTools: CONTRACT_TOOLS });
  assert.deepStrictEqual(saved.allowedTools, CONTRACT_TOOLS);
  const args = Array.from(helpers.getResumeArgs('claude', { ...baseOpts, allowedTools: saved.allowedTools }));
  assert.strictEqual(args[args.indexOf('--allowedTools') + 1], CONTRACT_VALUE);

  // An entry that never asked for a grant persists null, not [].
  assert.strictEqual(helpers.serializeShellEntry({ cwd: '/tmp', claudeSessionId: 'x' }).allowedTools, null);
  assert.strictEqual(helpers.serializeShellEntry({ cwd: '/tmp', claudeSessionId: 'x', allowedTools: [] }).allowedTools, null);
});

test('agents without an allowedToolsFlag emit nothing', () => {
  for (const agent of ['codex', 'pi', 'hermes', 'opencode', 'terminal']) {
    assert.strictEqual(helpers.AGENT_CONFIGS[agent].allowedToolsFlag, undefined, agent);
    const args = Array.from(helpers.getSpawnArgs(agent, { ...baseOpts, allowedTools: CONTRACT_TOOLS }));
    assert.ok(!args.includes('--allowedTools'), `${agent}: ${JSON.stringify(args)}`);
  }
});

test('omitting allowedTools leaves argv exactly as it was pre-#612', () => {
  const withOut = Array.from(helpers.getSpawnArgs('claude', baseOpts));
  assert.ok(!withOut.includes('--allowedTools'));
  for (const bad of [null, undefined, [], 'Bash', {}, 0]) {
    assert.deepStrictEqual(Array.from(helpers.getSpawnArgs('claude', { ...baseOpts, allowedTools: bad })), withOut,
      `allowedTools=${JSON.stringify(bad)} changed argv`);
  }
});

test('tool names are re-validated at the argv boundary', () => {
  const claude = helpers.AGENT_CONFIGS.claude;

  // Accepted: MCP ids and plain built-ins.
  assert.strictEqual(helpers.validateToolName('mcp__deepsteve__scheduled_task_started'), 'mcp__deepsteve__scheduled_task_started');
  assert.strictEqual(helpers.validateToolName('  Edit  '), 'Edit');
  assert.strictEqual(helpers.validateToolName('Notebook-Edit'), 'Notebook-Edit');

  // Rejected: anything that could turn into a second argument, a shell construct, or
  // the `Bash(git *)` specifier form (deliberately unsupported — nothing here needs it).
  for (const bad of ['', ' ', '--dangerously-skip-permissions', '-p', 'Bash(rm -rf /)', 'Bash(git *)',
    'a b', 'a,b', "a'b", 'a;b', 'a$(b)', '_leading', '.hidden', 'x'.repeat(65), null, 42, undefined, {}]) {
    assert.strictEqual(helpers.validateToolName(bad), null, `accepted ${JSON.stringify(bad)}`);
  }

  // Array.from: the builders run in a vm realm, so their arrays aren't host Arrays.
  const built = (tools) => Array.from(helpers.allowedToolsArgs(claude, tools));

  // A junk entry is dropped, not fatal — the good ones still land.
  assert.deepStrictEqual(built(['Edit', '--evil', 'Bash(rm -rf /)', 'Read']), ['--allowedTools', 'Edit,Read']);
  // An all-junk list emits no flag at all, rather than a bare flag or an empty value.
  assert.deepStrictEqual(built(['--evil', '', 7]), []);
  // Duplicates collapse.
  assert.deepStrictEqual(built(['Edit', 'Edit', 'Edit']), ['--allowedTools', 'Edit']);
  // And the list is capped, so a hand-edited state.json can't blow up the command line.
  assert.strictEqual(built(Array.from({ length: 50 }, (_, i) => `Tool${i}`))[1].split(',').length, 8);
});

// ---------------------------------------------------------------------------
// Part 2: runTask actually asks for the grant. Stubbed-ctx harness, same shape as
// test/unit/scheduled-default-model-effort.test.js.
// ---------------------------------------------------------------------------

const spawns = [];          // { agentType, opts } per getSpawnArgs call
let mcpWired = true;        // toggles what ctx.mcpConfigArgs reports
const engine = { onExit: () => {} };
const shells = new Map();
const ctx = {
  settings: { scheduledTasksEnabled: true, scheduledTasksOpenInBackground: true },
  log: () => {},
  broadcast: () => {},
  shells,
  getContexts: () => [],
  getDefaultEngine: () => engine,
  getAgentConfig: () => ({ supportsWorktree: false, supportsSessionWatch: false }),
  getSpawnArgs: (agentType, opts) => { spawns.push({ agentType, opts }); return []; },
  spawnSession: () => {},
  sessionEnv: () => ({}),
  mcpConfigArgs: () => (mcpWired ? ['--mcp-config', '/tmp/x.json'] : []),
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
};

const tools = init(ctx);

// project:'' keeps runs in the homedir fallback — no git repo, no worktree.
async function schedule(fields) {
  const res = await tools.schedule_task.handler(
    { title: 't', prompt: 'p', cron: '0 9 * * 1', project: '', ...fields }, {});
  assert.notStrictEqual(res.isError, true, res.content[0].text);
  return /#(\w+)/.exec(res.content[0].text)[1];
}

async function run(id) {
  spawns.length = 0;
  // The overlap guard skips a fire while the previous run's session is still in
  // `shells`; these tests re-fire the same task, so retire the old tab first.
  shells.clear();
  const res = await tools.run_scheduled_task_now.handler({ id }, {});
  assert.notStrictEqual(res.isError, true);
  return spawns[spawns.length - 1];
}

test('a fire whose agent has deepsteve MCP pre-permits the contract tools', async () => {
  mcpWired = true;
  const spawn = await run(await schedule({}));
  assert.deepStrictEqual(spawn.opts.allowedTools, CONTRACT_TOOLS);
  // The grant lands on the shell entry too — that is what serializeShellEntry persists,
  // and what the core restore path reads back after a daemon restart.
  const entry = shells.get(spawn.opts.shellId);
  assert.deepStrictEqual(entry.allowedTools, CONTRACT_TOOLS);
});

test('an agent with no deepsteve MCP gets no grant (it gets no contract either)', async () => {
  mcpWired = false;
  const spawn = await run(await schedule({}));
  assert.strictEqual(spawn.opts.allowedTools, null);
  assert.strictEqual(shells.get(spawn.opts.shellId).allowedTools, null);
});

test('the granted list is exactly the tools the prompt contract demands', () => {
  const { scheduledRunPrompt } = require('../../mods/scheduled-tasks/tools.js');
  const prompt = scheduledRunPrompt({ title: 't', id: 'abc', prompt: 'p' }, null);
  // Drift guard: if the contract ever names a third tool, this list must grow with it,
  // or that tool becomes the new thing an unattended run wedges on.
  assert.deepStrictEqual(CONTRACT_TOOLS, [
    'mcp__deepsteve__scheduled_task_started',
    'mcp__deepsteve__scheduled_task_finished',
  ]);
  for (const tool of CONTRACT_TOOLS) {
    const bare = tool.replace('mcp__deepsteve__', '');
    assert.ok(prompt.includes(bare), `contract prompt never mentions ${bare}`);
  }
});
