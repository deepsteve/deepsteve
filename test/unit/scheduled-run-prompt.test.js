// #708: the scheduled-run prompt is assembled from shipped fragments, plus an optional
// per-repo .deepsteve/scheduled/CONTEXT.md.
//
// What is pinned here:
//   1. fragment choice — MCP-wired vs not, isolated vs not — so a non-MCP agent is never
//      told to call an MCP tool and an isolated run always hears its work area is disposable;
//   2. `{{placeholders}}` — every name a fragment uses is one the renderer supplies, and the
//      task prompt / project context are never themselves templated;
//   3. CONTEXT.md — appended in the right place when present, skipped with a log line when
//      oversized, silently absent when missing, and recorded on the run row as {path, sha};
//   4. the contract prose left tools.js, so there is one copy of it.
//
// Pure module + temp dirs: no daemon, no shell, no git binary. Runs in the bare unit job.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-prompt-home-'));

const {
  init, scheduledRunPrompt, worktreeContract, readProjectContext, FRAGMENTS, PROMPT_VARS,
  CONTRACT_TOOLS, CONTEXT_MAX_BYTES,
} = require('../../mods/scheduled-tasks/tools.js');
const { projectScheduledContextPath } = require('../../paths');

const MOD_DIR = path.join(__dirname, '..', '..', 'mods', 'scheduled-tasks');
const TOOL_NAMES = CONTRACT_TOOLS.map((t) => t.replace(/^mcp__deepsteve__/, ''));

const task = { id: 'ab12cd34', title: 'Nightly report', prompt: 'Generate the report.' };
const iso = { path: '/repo/.claude/worktrees/scheduled-ef56', branch: 'worktree-scheduled-ef56', repoRoot: '/repo' };
const context = { path: '/repo/.deepsteve/scheduled/CONTEXT.md', relPath: '.deepsteve/scheduled/CONTEXT.md', sha: 'f'.repeat(40), text: 'Reports go in docs/reports/.' };

const HEADER = '⏰ This is an automated scheduled task run: "Nightly report" (task ab12cd34).';
const MERGE_LINE = /Merge\/push anything worth keeping BEFORE calling `scheduled_task_finished`/;
const CONTEXT_HEADING = 'Project context for scheduled runs, from .deepsteve/scheduled/CONTEXT.md in this repo:';

// ---------------------------------------------------------------------------
// 1. Fragment choice: the 2x2 of MCP-wired x isolated.
// ---------------------------------------------------------------------------

test('MCP, not isolated: the contract and the unattended rules, and no worktree text', () => {
  const out = scheduledRunPrompt(task, { mcpWired: true });
  assert.strictEqual(out.split('\n')[0], HEADER, 'the ⏰ header stays verbatim — noRunResult and Inbox refer to it');
  for (const name of TOOL_NAMES) assert.ok(out.includes(`\`${name}\``), `MCP prompt never names ${name}`);
  assert.match(out, /nobody will answer a question/i, 'the no-questions rule (#708)');
  assert.match(out, /durable_days/, 'a human-needed run asks durably, so the question outlives the tab');
  assert.ok(!/worktree/i.test(out), 'no worktree text without isolation');
  assert.ok(out.endsWith(`\n\nYour task:\n${task.prompt}`), 'the task prompt comes last, under its heading');
});

test('MCP, isolated: the worktree contract and the merge-before-finish line follow the prefix', () => {
  const out = scheduledRunPrompt(task, { mcpWired: true, iso });
  assert.strictEqual(out.split('\n')[0], HEADER);
  for (const v of [iso.path, iso.branch, iso.repoRoot]) assert.ok(out.includes(v), `missing ${v}`);
  assert.match(out, /DISPOSABLE/);
  assert.match(out, MERGE_LINE);
  // Order: prefix -> worktree -> merge line -> task.
  const at = (s) => out.indexOf(s);
  assert.ok(at('scheduled_task_started') < at('DISPOSABLE'), 'prefix before the worktree contract');
  assert.ok(at('DISPOSABLE') < out.search(MERGE_LINE), 'worktree contract before the merge line');
  assert.ok(out.search(MERGE_LINE) < at('Your task:'), 'merge line before the task');
});

test('not MCP, isolated: the worktree contract only — never an MCP tool', () => {
  const out = scheduledRunPrompt(task, { mcpWired: false, iso });
  assert.ok(out.startsWith(worktreeContract(iso)), 'the worktree contract leads');
  assert.ok(out.includes(iso.path));
  for (const name of TOOL_NAMES) assert.ok(!out.includes(name), `a non-MCP agent was told about ${name}`);
  assert.ok(!out.includes('⏰'), 'no scheduled-run header: it would promise a contract this agent cannot keep');
  assert.ok(!MERGE_LINE.test(out));
  assert.ok(out.endsWith(`\n\nYour task:\n${task.prompt}`));
});

test('not MCP, not isolated, no context: exactly the raw prompt, as before #708', () => {
  assert.strictEqual(scheduledRunPrompt(task, { mcpWired: false }), task.prompt);
  // No default for mcpWired: a caller that forgets it gets the safe answer.
  assert.strictEqual(scheduledRunPrompt(task, {}), task.prompt);
  assert.strictEqual(scheduledRunPrompt(task), task.prompt);
});

test('no fragment names an MCP tool unless it is only ever given to MCP agents', () => {
  // worktree.md reaches non-MCP agents; the merge line that names a tool is split out into
  // worktree-mcp.md for exactly this reason.
  for (const name of TOOL_NAMES) {
    assert.ok(!FRAGMENTS.worktree.includes(name), `worktree.md names ${name}, and non-MCP agents get it`);
  }
});

// ---------------------------------------------------------------------------
// 2. Placeholders.
// ---------------------------------------------------------------------------

test('every {{name}} in a fragment is one the renderer supplies', () => {
  for (const [key, text] of Object.entries(FRAGMENTS)) {
    for (const [, name] of text.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(PROMPT_VARS.includes(name),
        `${key} uses {{${name}}}, which renders as '' — known names: ${PROMPT_VARS.join(', ')}`);
    }
  }
  for (const opts of [{ mcpWired: true }, { mcpWired: true, iso }, { mcpWired: false, iso }]) {
    assert.ok(!scheduledRunPrompt(task, opts).includes('{{'), `unrendered placeholder with ${JSON.stringify(opts)}`);
  }
});

test('the task prompt, the title and the context are text, never templates', () => {
  const tricky = { id: 'x1', title: 'Report {{taskId}}', prompt: 'Keep {{title}} literally.' };
  const ctx = { ...context, text: 'Leave {{branch}} alone.' };
  const out = scheduledRunPrompt(tricky, { mcpWired: true, iso, context: ctx });
  assert.ok(out.includes('"Report {{taskId}}" (task x1)'), 'a substituted value is not expanded a second time');
  assert.ok(out.endsWith('Your task:\nKeep {{title}} literally.'));
  assert.ok(out.includes('Leave {{branch}} alone.'));
});

test('fragment comments are stripped and never reach the agent', () => {
  for (const [key, text] of Object.entries(FRAGMENTS)) {
    assert.ok(!text.includes('<!--') && !text.includes('-->'), `${key} still carries a comment`);
    assert.strictEqual(text, text.trim(), `${key} is not trimmed`);
  }
  // And the files on disk do document themselves — the stripping exists for that.
  assert.match(fs.readFileSync(path.join(MOD_DIR, 'prefix.md'), 'utf8'), /^<!--/);
});

// ---------------------------------------------------------------------------
// 3. CONTEXT.md.
// ---------------------------------------------------------------------------

test('the project context sits after the prefix and worktree, before "Your task:"', () => {
  const out = scheduledRunPrompt(task, { mcpWired: true, iso, context });
  const heading = out.indexOf(CONTEXT_HEADING);
  assert.ok(heading > 0, 'the heading names the source file');
  assert.ok(out.search(MERGE_LINE) < heading, 'after every Deep Steve fragment');
  assert.ok(heading < out.indexOf('Your task:'), 'before the task');
  assert.ok(out.includes(`${CONTEXT_HEADING}\n${context.text}\n\nYour task:\n${task.prompt}`));
});

test('the project context reaches non-MCP agents too', () => {
  assert.strictEqual(scheduledRunPrompt(task, { mcpWired: false, context }),
    `${CONTEXT_HEADING}\n${context.text}\n\nYour task:\n${task.prompt}`);
  const isolated = scheduledRunPrompt(task, { mcpWired: false, iso, context });
  assert.ok(isolated.indexOf('DISPOSABLE') < isolated.indexOf(CONTEXT_HEADING));
});

function repoWithContext(content) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-ctx-'));
  if (content !== undefined) {
    const file = projectScheduledContextPath(repo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return repo;
}

test('readProjectContext: present -> path, repo-relative path, git blob id, trimmed text', () => {
  const repo = repoWithContext('hello\n');
  const logs = [];
  const got = readProjectContext(repo, { log: (m) => logs.push(m) });
  assert.deepStrictEqual(got, {
    path: projectScheduledContextPath(repo),
    relPath: path.join('.deepsteve', 'scheduled', 'CONTEXT.md'),
    // `printf 'hello\n' | git hash-object --stdin` — the id git itself gives these bytes, so
    // `git log --find-object=<sha>` finds the commit a run's context came from.
    sha: 'ce013625030ba8dba906f756967f9e9ca394464a',
    text: 'hello',
  });
  assert.deepStrictEqual(logs, []);
});

test('readProjectContext: missing is silent; an empty file is nothing to insert', () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.strictEqual(readProjectContext(repoWithContext(), { log }), null);
  assert.strictEqual(readProjectContext(repoWithContext('  \n\n'), { log }), null);
  assert.strictEqual(readProjectContext('', { log }), null);
  assert.deepStrictEqual(logs, [], 'the normal case must not log on every fire');
});

test('readProjectContext: oversized is skipped (not truncated) with a log line naming it', () => {
  const repo = repoWithContext('x'.repeat(CONTEXT_MAX_BYTES + 1));
  const logs = [];
  assert.strictEqual(readProjectContext(repo, { log: (m) => logs.push(m) }), null);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /skipped/);
  assert.ok(logs[0].includes(projectScheduledContextPath(repo)), 'the log names the file');
  assert.ok(logs[0].includes(String(CONTEXT_MAX_BYTES)), 'and the cap');
  // Exactly at the cap is fine.
  const atCap = repoWithContext('y'.repeat(CONTEXT_MAX_BYTES));
  assert.strictEqual(readProjectContext(atCap, { log: () => {} }).text.length, CONTEXT_MAX_BYTES);
});

test('readProjectContext: a symlink or a directory is refused, with a log line', () => {
  const repo = repoWithContext();
  const file = projectScheduledContextPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-elsewhere-')), 'secret');
  fs.writeFileSync(elsewhere, 'not for the prompt');
  fs.symlinkSync(elsewhere, file);
  const logs = [];
  assert.strictEqual(readProjectContext(repo, { log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /not a regular file/);

  const dirRepo = repoWithContext();
  fs.mkdirSync(projectScheduledContextPath(dirRepo), { recursive: true });
  assert.strictEqual(readProjectContext(dirRepo, { log: (m) => logs.push(m) }), null);
  assert.strictEqual(logs.length, 2);
});

// ---------------------------------------------------------------------------
// runTask end to end, on a stubbed ctx (same shape as scheduled-allowed-tools.test.js).
// ---------------------------------------------------------------------------

const deliveries = [];
const logLines = [];
let mcpWired = true;
const shells = new Map();
const tools = init({
  settings: { scheduledTasksEnabled: true, scheduledTasksOpenInBackground: true },
  log: (m) => logLines.push(m),
  broadcast: () => {},
  shells,
  getContexts: () => [],
  getDefaultEngine: () => ({ onExit: () => {} }),
  getAgentConfig: () => ({ supportsWorktree: false, supportsSessionWatch: false }),
  getSpawnArgs: () => [],
  spawnSession: () => {},
  sessionEnv: () => ({}),
  mcpConfigArgs: () => (mcpWired ? ['--mcp-config', '/tmp/x.json'] : []),
  wireShellOutput: () => {},
  emitSessionOpen: () => {},
  watchClaudeSessionDir: () => {},
  unwatchClaudeSessionDir: () => {},
  deliverPromptWhenReady: (id, prompt) => deliveries.push({ id, prompt }),
  validateWorktree: (n) => n,
  resolveConfigDir: () => null,
  validateModel: () => null,
  validateEffort: () => null,
  handleShellGone: () => {},
  saveState: () => {},
  isShuttingDown: () => false,
  deliverToWindow: () => {},
});

async function fire(project) {
  const res = await tools.schedule_task.handler(
    { title: 'ctx', prompt: 'Do the thing.', cron: '0 9 * * 1', project }, {});
  const taskId = /#(\w+)/.exec(res.content[0].text)[1];
  shells.clear(); // the overlap guard would otherwise skip a re-fire
  deliveries.length = 0;
  const ran = await tools.run_scheduled_task_now.handler({ id: taskId }, {});
  assert.match(ran.content[0].text, /Running #/, ran.content[0].text);
  return { prompt: deliveries[0].prompt, taskId };
}

// The run row as the history page receives it — through runView, so this also pins that
// `context` survives the trim to what the grid renders.
async function runRow(taskId) {
  const routes = new Map();
  const { registerRoutes } = require('../../mods/scheduled-tasks/tools.js');
  registerRoutes({ get: (p, h) => routes.set(p, h), post() {}, put() {}, delete() {} }, null);
  let body;
  routes.get('/api/scheduled-tasks/history')({}, { json: (b) => { body = b; } });
  for (const g of body.groups) for (const r of g.repos) for (const t of r.tasks) if (t.id === taskId) return t.runs[0];
  throw new Error(`task ${taskId} not in the history payload`);
}

test('runTask: a repo with CONTEXT.md gets it in the prompt and {path, sha} on the run row', async () => {
  mcpWired = true;
  const repo = repoWithContext('hello\n');
  const { prompt, taskId } = await fire(repo);
  assert.ok(prompt.includes(`${CONTEXT_HEADING}\nhello\n\nYour task:\nDo the thing.`));
  const row = await runRow(taskId);
  assert.deepStrictEqual(row.context, {
    // No .git in the temp dir, so findGitRoot is null and the task's own project is the root.
    path: projectScheduledContextPath(repo),
    sha: 'ce013625030ba8dba906f756967f9e9ca394464a',
  });
  assert.ok(logLines.some((l) => l.includes('context=ce01362')), 'the fire log line names the context');
});

test('runTask: a non-MCP agent gets the context too', async () => {
  mcpWired = false;
  const repo = repoWithContext('hello\n');
  const { prompt } = await fire(repo);
  assert.strictEqual(prompt, `${CONTEXT_HEADING}\nhello\n\nYour task:\nDo the thing.`);
  mcpWired = true;
});

test('runTask: no CONTEXT.md -> no section, context: null, no error', async () => {
  const repo = repoWithContext();
  const { prompt, taskId } = await fire(repo);
  assert.ok(!prompt.includes('Project context'));
  assert.strictEqual((await runRow(taskId)).context, null);
});

test('runTask: an oversized CONTEXT.md is skipped with a log line and records context: null', async () => {
  const repo = repoWithContext('z'.repeat(CONTEXT_MAX_BYTES + 10));
  logLines.length = 0;
  const { prompt, taskId } = await fire(repo);
  assert.ok(!prompt.includes('Project context'));
  assert.strictEqual((await runRow(taskId)).context, null);
  assert.ok(logLines.some((l) => /\[scheduled\] CONTEXT\.md skipped/.test(l)), logLines.join('\n'));
});

test('runTask: a project-less task never reads ~/.deepsteve/scheduled/CONTEXT.md', async () => {
  // A project-less run spawns in $HOME, where the same relative path is inside Deep Steve's
  // own state dir. Plant one there and prove it is ignored.
  const planted = projectScheduledContextPath(os.homedir());
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, 'must not appear');
  const { prompt, taskId } = await fire('');
  assert.ok(!prompt.includes('must not appear'));
  assert.strictEqual((await runRow(taskId)).context, null);
});

// ---------------------------------------------------------------------------
// 4. One copy of the prose.
// ---------------------------------------------------------------------------

test('the contract prose lives in the fragment files, not in tools.js', () => {
  const src = fs.readFileSync(path.join(MOD_DIR, 'tools.js'), 'utf8');
  for (const phrase of ['This is an automated scheduled task run', 'DISPOSABLE git worktree', 'nobody will answer a question']) {
    assert.ok(!src.includes(phrase), `tools.js still hardcodes "${phrase}" — it belongs in a fragment file`);
  }
  for (const f of ['prefix.md', 'worktree.md', 'worktree-mcp.md']) {
    assert.ok(fs.existsSync(path.join(MOD_DIR, f)), `${f} is missing`);
  }
});
