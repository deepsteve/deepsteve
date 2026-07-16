// Unit tests for the scheduled-tasks feature gate: when the server-authoritative
// `scheduledTasksEnabled` setting is off, the write/action MCP tools fail-closed
// with a clear "turned off" error (isError) instead of silently accepting work
// the scheduler will never fire. Read/list and the in-flight self-report tools
// stay open. See mods/scheduled-tasks/tools.js (featureEnabled / featureOffResult).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at
// a scratch dir BEFORE loading it so tests never touch the real file.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-gate-home-'));

const { init } = require('../../mods/scheduled-tasks/tools.js');

// Minimal context: the gate only reads ctx.settings; createTask (enabled path)
// additionally needs broadcast/log/shells. settings is mutated in place — the
// gate must read it live, exactly like the real daemon (setting is toggled in
// Settings with no restart).
const settings = { scheduledTasksEnabled: false };
const ctx = {
  settings,
  log: () => {},
  broadcast: () => {},
  shells: new Map(),
  getContexts: () => [],
};
const tools = init(ctx); // .unref()'d timers, so this doesn't hang the test process

const GATED = ['schedule_task', 'update_scheduled_task', 'run_scheduled_task_now'];
const argsFor = {
  schedule_task: { title: 't', prompt: 'p', cron: '0 9 * * 1' },
  update_scheduled_task: { id: 'nope', title: 'x' },
  run_scheduled_task_now: { id: 'nope' },
};

test('write/action tools fail-closed with a clear error when the feature is off', async () => {
  settings.scheduledTasksEnabled = false;
  for (const name of GATED) {
    const res = await tools[name].handler(argsFor[name], {});
    assert.strictEqual(res.isError, true, `${name} should be marked isError when off`);
    assert.match(res.content[0].text, /turned off/i, `${name} should say the feature is turned off`);
    assert.match(res.content[0].text, /scheduledTasksEnabled/, `${name} should name the setting to enable`);
  }
});

test('list_scheduled_tasks stays available (read-only) when the feature is off', async () => {
  settings.scheduledTasksEnabled = false;
  const res = await tools.list_scheduled_tasks.handler({}, {});
  assert.notStrictEqual(res.isError, true, 'listing must not be blocked when off');
  assert.ok(res.content[0].text, 'listing returns text');
});

test('in-flight self-report tools stay available when the feature is off', async () => {
  settings.scheduledTasksEnabled = false;
  // Not a scheduled run (no matching shellId) → friendly no-op, NOT the gate error.
  for (const name of ['scheduled_task_started', 'scheduled_task_finished']) {
    const res = await tools[name].handler({}, {});
    assert.notStrictEqual(res.isError, true, `${name} must not be blocked by the feature gate`);
    assert.doesNotMatch(res.content[0].text, /turned off/i, `${name} should not report the feature off`);
  }
});

test('the gate reads the setting live: enabling it lets scheduling through', async () => {
  settings.scheduledTasksEnabled = true; // flip live, same object
  const res = await tools.schedule_task.handler({ title: 't', prompt: 'p', cron: '0 9 * * 1' }, {});
  assert.notStrictEqual(res.isError, true, 'schedule_task should succeed once enabled');
  assert.match(res.content[0].text, /Scheduled #/, 'a task should actually be scheduled');
});
