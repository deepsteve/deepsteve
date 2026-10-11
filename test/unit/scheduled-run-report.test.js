// Unit tests for a scheduled run's `report` — its deliverable, kept in the task's run history.
//
// A run used to post its report to the Inbox with share_result, where it stayed open after the
// run's tab had closed: one row per fire, nothing to approve, and a badge that counted reports
// days old. The report now rides on scheduled_task_finished and lives on the run record.
//
// Two shapes matter: the full text is reachable from the run's own route, and the task list —
// refetched on every scheduled-tasks broadcast — carries only `hasReport`, never the text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-report-home-'));

const { init, registerRoutes } = require('../../mods/scheduled-tasks/tools.js');

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
  closeSession: () => {},
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

function call(key, params = {}) {
  const handler = routes.get(key);
  assert.ok(handler, `${key} should be registered`);
  let out = { status: 200, body: null };
  handler({ params, query: {}, body: {} }, {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  });
  return out;
}

const asRun = (shellId) => ({ requestInfo: { url: new URL(`http://localhost/mcp?shellId=${shellId}`) } });

async function finishedRun(args) {
  const res = await tools.schedule_task.handler(
    { title: 'report test', prompt: 'write the weekly report', cron: '0 9 * * 1', project: '' }, {});
  const id = /#(\w+)/.exec(res.content[0].text)[1];
  const started = call('POST /api/scheduled-tasks/:id/run', { id }).body;
  assert.strictEqual(started.started, true);
  await tools.scheduled_task_finished.handler(args, asRun(started.sessionId));
  const task = call('GET /api/scheduled-tasks').body.tasks.find((t) => t.id === id);
  return { id, run: task.runs[0] };
}

test('a report is kept on the run, and the task list says only that there is one', async () => {
  const { id, run } = await finishedRun({ summary: 'Weekly report sent.', report: '## Sales\n\nUp 4%.' });
  assert.strictEqual(run.summary, 'Weekly report sent.');
  assert.strictEqual(run.hasReport, true);
  assert.ok(!('report' in run), 'the list is refetched on every broadcast, so the text stays out of it');

  const got = call('GET /api/scheduled-tasks/:id/runs/:startedAt/report', { id, startedAt: String(run.startedAt) });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.report, '## Sales\n\nUp 4%.');
});

test('a run with no report has no hasReport, and its report route is a 404', async () => {
  const { id, run } = await finishedRun({ summary: 'Nothing to report.' });
  assert.ok(!('hasReport' in run));
  const got = call('GET /api/scheduled-tasks/:id/runs/:startedAt/report', { id, startedAt: String(run.startedAt) });
  assert.strictEqual(got.status, 404);
});

test('a blank report is no report, and a long one is cut rather than refused', async () => {
  const blank = await finishedRun({ summary: 's', report: '   \n ' });
  assert.ok(!('hasReport' in blank.run));

  const long = await finishedRun({ summary: 's', report: 'x'.repeat(40000) });
  const got = call('GET /api/scheduled-tasks/:id/runs/:startedAt/report', { id: long.id, startedAt: String(long.run.startedAt) });
  assert.ok(got.body.report.length < 40000, 'capped');
  assert.ok(got.body.report.length >= 8000, 'but a real report fits');
});

test('scheduled_task_finished documents `report`, and the run prompt points at it', () => {
  assert.ok(tools.scheduled_task_finished.schema.report, 'the field exists');
  const prefix = fs.readFileSync(path.join(__dirname, '../../mods/scheduled-tasks/prefix.md'), 'utf8');
  assert.match(prefix, /as `report` to `scheduled_task_finished`/);
  assert.doesNotMatch(prefix, /share_result/, 'a run is no longer told to post its deliverable to the Inbox');
});
