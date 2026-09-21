// Unit tests for scheduled-task state metadata (#712).
//
// Before this, a task had nowhere to record why its state changed, so agents rewrote
// the title — "OFF <date> (<reason>) — <title>" — which buried the name, could not be
// queried, and kept only the latest reason. Now the reason is a field (statusNote), the
// who/when is stamped automatically (disabledAt/disabledBy), a replacement is a pointer
// (supersededBy, which turns the task off), and every change lands in a bounded,
// append-only changeLog. Existing prefixed titles are migrated once, at load.
//
// What is load-bearing, and asserted here: the migration's truth table (including what
// it must NOT touch), that disabledBy can only be stamped and never supplied, that a
// panel save which changes nothing logs nothing, that a rejected update changes nothing,
// and that the list filters answer the questions the issue says titles couldn't.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The mod reads ~/.deepsteve/scheduled-tasks.json at require time — point HOME at a
// scratch dir BEFORE loading it so tests never touch the real file. The file is
// pre-seeded with legacy titles, so the load-time migration runs for real.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-metadata-home-'));
const TASKS_FILE = path.join(process.env.HOME, '.deepsteve', 'scheduled-tasks.json');
fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });

// Rows shaped like pre-#712 ones: no statusNote, disabledAt, changeLog — and, like the
// oldest rows, no isolateWorktree or maxRuntimeMinutes either.
const legacy = (id, title, enabled = false) => ({
  id, title, enabled, prompt: 'p', project: '', agentType: 'claude', cron: '0 9 * * 1',
  once: false, firedAt: null, createdAt: 1, createdBy: null, lastRun: null, nextRun: null, runs: [],
});
fs.writeFileSync(TASKS_FILE, JSON.stringify([
  legacy('leg-off', 'OFF 2026-09-21 (the target moved) — Road to 1,000 — daily counter'),
  legacy('leg-offnr', 'OFF 2026-09-18 — weekly revenue per install'),
  legacy('leg-ret', 'RETIRED 2026-09-18 (product dead) — Weekly readout (#199 experiment)'),
  legacy('leg-nest', 'OFF 2026-09-18 (vendor (Acme) dropped us) — Price watch'),
  legacy('leg-pause', 'PAUSED — nightly import'),
  legacy('leg-sfx', 'Flip watch — DISABLED: killed on 2026-08-28 (same day); nothing to watch'),
  legacy('leg-done', 'Launch watch — DONE: arrived 2026-08-28 22:00'),
  legacy('leg-on', 'OFF 2026-09-18 — still firing', true),
  legacy('leg-offsite', 'Off-site backup'),
  legacy('leg-office', 'OFFICE hours — weekly'),
  legacy('leg-plain', 'Nightly digest'),
], null, 2));

const {
  init, registerRoutes, parseLegacyTitle, migrateLegacyTitle, MAX_CHANGELOG,
} = require('../../mods/scheduled-tasks/tools.js');

const readTasksFile = () => JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const stored = (id) => readTasksFile().find((t) => t.id === id);

const logs = [];
const settings = { scheduledTasksEnabled: true };
const shells = new Map();
const ctx = {
  settings,
  log: (m) => logs.push(m),
  broadcast: () => {},
  shells,
  getContexts: () => [],
  validateModel: (v) => v || null,
  validateEffort: (v) => v || null,
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
    json(b) { body = b; return this; },
    status(c) { code = c; return this; },
  });
  return { code, body };
}

const text = (res) => res.content[0].text;

// A live session with a name, so the actor snapshot has something to copy.
shells.set('sess7120', { clients: new Set(), name: 'Fix #712' });
const asSession = (shellId) => ({ requestInfo: { url: { searchParams: new URLSearchParams({ shellId }) } } });
const SESSION = asSession('sess7120');

async function schedule(fields = {}, extra = SESSION) {
  const res = await tools.schedule_task.handler(
    { title: 'watcher', prompt: 'p', cron: '0 9 * * 1', project: '', ...fields }, extra);
  const m = /Scheduled #(\w+)/.exec(text(res));
  assert.ok(m, text(res));
  return m[1];
}
const update = (fields, extra = SESSION) => tools.update_scheduled_task.handler(fields, extra);
const list = (fields = {}) => tools.list_scheduled_tasks.handler({ scope: 'all', ...fields }, {}).then(text);
const listedIds = (out) => [...out.matchAll(/^#(\S+) "/gm)].map((m) => m[1]);
const lastEntry = (id) => { const log = stored(id).changeLog; return log[log.length - 1]; };
const localMidnight = (y, m, d) => new Date(y, m - 1, d).getTime();

// Exactly the body the panel's TaskForm PUTs on Save — every field, every time.
function panelBody(t) {
  return {
    title: t.title, prompt: t.prompt, cron: t.cron, once: !!t.once, project: t.project,
    agentType: t.agentType, configProfile: t.configProfile || null, model: t.model || '', effort: t.effort || '',
    planMode: !!t.planMode, keepOpen: !!t.keepOpen, keepOpenOnFailure: !!t.keepOpenOnFailure,
    isolateWorktree: t.isolateWorktree !== false, maxRuntimeMinutes: t.maxRuntimeMinutes != null ? t.maxRuntimeMinutes : 60,
    statusNote: t.statusNote || '',
  };
}

// --- legacy-title migration --------------------------------------------------

test('load-time migration moves each title-prefix shape into fields, and persists it', () => {
  const cases = {
    'leg-off': ['Road to 1,000 — daily counter', 'Turned off: the target moved', localMidnight(2026, 9, 21)],
    'leg-offnr': ['weekly revenue per install', 'Turned off', localMidnight(2026, 9, 18)],
    'leg-ret': ['Weekly readout (#199 experiment)', 'Retired: product dead', localMidnight(2026, 9, 18)],
    'leg-nest': ['Price watch', 'Turned off: vendor (Acme) dropped us', localMidnight(2026, 9, 18)],
    'leg-pause': ['nightly import', 'Paused', undefined],
    'leg-sfx': ['Flip watch', 'Disabled: killed on 2026-08-28 (same day); nothing to watch', undefined],
    'leg-done': ['Launch watch', 'Done: arrived 2026-08-28 22:00', undefined],
  };
  for (const [id, [title, note, disabledAt]] of Object.entries(cases)) {
    const t = stored(id); // read back from disk: the migration saved itself
    assert.strictEqual(t.title, title, id);
    assert.strictEqual(t.statusNote, note, id);
    assert.strictEqual(t.disabledAt, disabledAt, `${id}: a title date becomes disabledAt; no date stays unknown`);
    assert.strictEqual(t.disabledBy, undefined, `${id}: nothing recorded who turned it off`);
    assert.strictEqual(t.enabled, false, id);
    // The original title is never lost — it is in the change log.
    const entry = t.changeLog[0];
    assert.deepStrictEqual(entry.by, { type: 'system', reason: 'legacy-title-migration' });
    assert.deepStrictEqual(entry.changes.find((c) => c.field === 'title').to, title);
    assert.match(entry.changes.find((c) => c.field === 'title').from, /OFF|RETIRED|PAUSED|DISABLED|DONE/);
  }
  assert.ok(logs.some((l) => l.includes('migrated legacy title of leg-off')), 'init() logs the migrations it found at load');
});

test('migration leaves alone what is not the convention, and anything still enabled', () => {
  assert.strictEqual(stored('leg-on').title, 'OFF 2026-09-18 — still firing', 'an enabled task is never rewritten');
  assert.strictEqual(stored('leg-offsite').title, 'Off-site backup');
  assert.strictEqual(stored('leg-office').title, 'OFFICE hours — weekly');
  assert.strictEqual(stored('leg-plain').title, 'Nightly digest');
  for (const id of ['leg-on', 'leg-offsite', 'leg-office', 'leg-plain']) {
    assert.strictEqual(stored(id).statusNote, undefined, id);
    assert.strictEqual(stored(id).changeLog, undefined, id);
  }
});

test('migrateLegacyTitle is idempotent and never throws on odd rows', () => {
  const t = legacy('x', 'RETIRED 2026-01-02 (gone) — Report');
  assert.strictEqual(migrateLegacyTitle(t), true);
  const once = JSON.stringify(t);
  assert.strictEqual(migrateLegacyTitle(t), false, 'a second pass finds a status note and stops');
  assert.strictEqual(JSON.stringify(t), once);
  for (const odd of [null, {}, { enabled: false }, { enabled: false, title: 42 }, { ...legacy('d', 'OFF — x'), deleted: true }]) {
    assert.strictEqual(migrateLegacyTitle(odd), false);
  }
});

test('parseLegacyTitle rejects near-misses', () => {
  assert.strictEqual(parseLegacyTitle('OFF 2026-09-18 (unbalanced — Report'), null, 'unbalanced parens');
  assert.strictEqual(parseLegacyTitle('OFF-site backup'), null, 'a prefix needs whitespace around its dash');
  assert.strictEqual(parseLegacyTitle('Off 2026-09-18 — lowercase'), null, 'keywords are uppercase only');
  assert.strictEqual(parseLegacyTitle('OFF 2026-09-18'), null, 'no title after the prefix');
  assert.deepStrictEqual(parseLegacyTitle('DISABLED (why) — Name'), { word: 'DISABLED', date: null, reason: 'why', title: 'Name' });
});

// --- disable / re-enable stamping ---------------------------------------------

test('turning a task off via MCP stamps when and which session, with its name', async () => {
  const id = await schedule({ title: 'daily digest' });
  const before = Date.now();
  const res = await update({ id, enabled: false, status_note: 'turned off: the product it watches was cancelled' });
  assert.match(text(res), /Turned off — turned off: the product it watches was cancelled/);
  const t = stored(id);
  assert.strictEqual(t.title, 'daily digest', 'the title stays the task\'s name');
  assert.strictEqual(t.enabled, false);
  assert.strictEqual(t.nextRun, null);
  assert.ok(t.disabledAt >= before && t.disabledAt <= Date.now());
  assert.deepStrictEqual(t.disabledBy, { type: 'session', id: 'sess7120', name: 'Fix #712' });
  assert.deepStrictEqual(lastEntry(id).changes, [
    { field: 'enabled', from: true, to: false },
    { field: 'statusNote', from: null, to: 'turned off: the product it watches was cancelled' },
  ]);
  assert.deepStrictEqual(lastEntry(id).by, t.disabledBy);
});

test('re-enabling clears the stamps and the note; the change log keeps them', async () => {
  const id = await schedule({ title: 'resumable' });
  await update({ id, enabled: false, status_note: 'on hold' });
  const r = call('POST /api/scheduled-tasks/:id/enabled', { params: { id }, body: { enabled: true } });
  assert.strictEqual(r.code, 200);
  const t = stored(id);
  assert.strictEqual(t.enabled, true);
  assert.strictEqual(t.disabledAt, null);
  assert.strictEqual(t.disabledBy, null);
  assert.strictEqual(t.statusNote, null, 'a note about being off is stale once it is back on');
  assert.ok(t.nextRun, 'rescheduled');
  assert.deepStrictEqual(lastEntry(id).by, { type: 'user' });
  assert.deepStrictEqual(lastEntry(id).changes, [
    { field: 'enabled', from: false, to: true },
    { field: 'statusNote', from: 'on hold', to: null },
  ]);
  // …unless the same call sets a new one.
  await update({ id, enabled: false });
  await update({ id, enabled: true, status_note: 'back, watching the relaunch' });
  assert.strictEqual(stored(id).statusNote, 'back, watching the relaunch');
});

test('the panel\'s Pause is attributed to the user, and may carry a note', () => {
  const t = call('POST /api/scheduled-tasks', { body: { title: 'panel task', prompt: 'p', cron: '0 9 * * 1' } }).body.task;
  const r = call('POST /api/scheduled-tasks/:id/enabled', { params: { id: t.id }, body: { enabled: false, statusNote: 'paused from the panel' } });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(stored(t.id).disabledBy, { type: 'user' });
  assert.strictEqual(stored(t.id).statusNote, 'paused from the panel');
});

test('a task created off is stamped like one turned off later', async () => {
  const id = await schedule({ title: 'born off', enabled: false, status_note: 'waiting for the data' });
  const t = stored(id);
  assert.ok(t.disabledAt);
  assert.deepStrictEqual(t.disabledBy, { type: 'session', id: 'sess7120', name: 'Fix #712' });
  assert.strictEqual(t.statusNote, 'waiting for the data');
});

test('disabledBy, disabledAt and changeLog cannot be supplied through the REST body', () => {
  const t = call('POST /api/scheduled-tasks', { body: { title: 'forge target', prompt: 'p', cron: '0 9 * * 1', disabledBy: { type: 'user' } } }).body.task;
  assert.strictEqual(stored(t.id).disabledBy, null);
  call('PUT /api/scheduled-tasks/:id', { params: { id: t.id }, body: {
    disabledBy: { type: 'session', id: 'evil' }, disabledAt: 1, changeLog: [], supersededBy: undefined,
  } });
  const s = stored(t.id);
  assert.strictEqual(s.disabledBy, null);
  assert.strictEqual(s.disabledAt, null);
  assert.deepStrictEqual(s.changeLog, [], 'nothing real changed, so nothing was logged');
});

// --- the change log -----------------------------------------------------------

test('a panel save that changes nothing logs nothing — even on a legacy row missing fields', () => {
  // leg-plain predates isolateWorktree/maxRuntimeMinutes entirely; the form sends
  // true/60 for them, which is what those absences already meant.
  const before = stored('leg-plain');
  const r = call('PUT /api/scheduled-tasks/:id', { params: { id: 'leg-plain' }, body: panelBody(before) });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(stored('leg-plain').changeLog, undefined, 'no entry at all');
  const id = call('POST /api/scheduled-tasks', { body: { title: 'fresh', prompt: 'p', cron: '0 9 * * 1' } }).body.task.id;
  call('PUT /api/scheduled-tasks/:id', { params: { id }, body: panelBody(stored(id)) });
  assert.deepStrictEqual(stored(id).changeLog, []);
});

test('a prompt change is logged without its text; other fields log from → to', () => {
  const id = call('POST /api/scheduled-tasks', { body: { title: 'a', prompt: 'old prompt', cron: '0 9 * * 1' } }).body.task.id;
  call('PUT /api/scheduled-tasks/:id', { params: { id }, body: { ...panelBody(stored(id)), prompt: 'a much longer new prompt', cron: '0 10 * * 1' } });
  assert.deepStrictEqual(lastEntry(id).changes, [
    { field: 'cron', from: '0 9 * * 1', to: '0 10 * * 1' },
    { field: 'prompt' },
  ]);
});

test(`the change log keeps only the newest ${MAX_CHANGELOG} entries`, async () => {
  const id = await schedule({ title: 't0' });
  for (let i = 1; i <= MAX_CHANGELOG + 10; i++) await update({ id, title: `t${i}` });
  const log = stored(id).changeLog;
  assert.strictEqual(log.length, MAX_CHANGELOG);
  assert.deepStrictEqual(log[log.length - 1].changes, [{ field: 'title', from: `t${MAX_CHANGELOG + 9}`, to: `t${MAX_CHANGELOG + 10}` }]);
  assert.deepStrictEqual(log[0].changes, [{ field: 'title', from: 't10', to: 't11' }], 'the oldest dropped first');
});

// --- superseding --------------------------------------------------------------

test('superseded_by must name a live task other than itself; a rejected call changes nothing', async () => {
  const id = await schedule({ title: 'original' });
  const bad = await update({ id, title: 'renamed', superseded_by: 'nosuchid' });
  assert.match(text(bad), /Could not update: no scheduled task #nosuchid/);
  assert.strictEqual(stored(id).title, 'original', 'the title change in the same call did not land');
  assert.strictEqual(stored(id).enabled, true);
  assert.match(text(await update({ id, superseded_by: id })), /cannot supersede itself/);
});

test('setting superseded_by turns the task off; combining it with enabled:true is refused', async () => {
  const oldId = await schedule({ title: 'old report' });
  const newId = await schedule({ title: 'new report' });
  assert.match(text(await update({ id: oldId, superseded_by: newId, enabled: true })), /cannot be combined with enabled: true/);
  assert.strictEqual(stored(oldId).enabled, true);
  const res = await update({ id: oldId, superseded_by: `#${newId}` }); // "#id" as printed is accepted
  assert.match(text(res), new RegExp(`Turned off, superseded by #${newId}`));
  const t = stored(oldId);
  assert.strictEqual(t.supersededBy, newId);
  assert.strictEqual(t.enabled, false);
  assert.deepStrictEqual(t.disabledBy, { type: 'session', id: 'sess7120', name: 'Fix #712' });
  // Turning it back on drops the stale pointer.
  await update({ id: oldId, enabled: true });
  assert.strictEqual(stored(oldId).supersededBy, null);
});

test('schedule_task supersedes: replaces an old task in one call, and a bad id creates nothing', async () => {
  const oldId = await schedule({ title: 'v1 digest' });
  const newId = await schedule({ title: 'v2 digest', supersedes: oldId });
  const old = stored(oldId);
  assert.strictEqual(old.supersededBy, newId);
  assert.strictEqual(old.enabled, false);
  assert.ok(old.disabledAt);
  assert.strictEqual(stored(newId).enabled, true);

  const count = readTasksFile().length;
  const res = await tools.schedule_task.handler({ title: 'orphan', prompt: 'p', cron: '0 9 * * 1', project: '', supersedes: 'nosuchid' }, SESSION);
  assert.match(text(res), /no scheduled task #nosuchid exists to supersede\. Nothing was created\./);
  assert.strictEqual(readTasksFile().length, count);
});

// --- metadata -----------------------------------------------------------------

test('metadata merges on update, and a null or empty value removes a key', async () => {
  const id = await schedule({ title: 'meta', metadata: { issue: '#712' } });
  await update({ id, metadata: { owner: 'ops' } });
  assert.deepStrictEqual(stored(id).metadata, { issue: '#712', owner: 'ops' });
  await update({ id, metadata: { issue: null } });
  assert.deepStrictEqual(stored(id).metadata, { owner: 'ops' });
  assert.deepStrictEqual(lastEntry(id).changes, [{ field: 'metadata.issue', from: '#712', to: null }]);
  await update({ id, metadata: { owner: '' } });
  assert.strictEqual(stored(id).metadata, null);
});

test('limits are errors, not truncations', async () => {
  const id = await schedule({ title: 'limits' });
  assert.match(text(await update({ id, status_note: 'x'.repeat(501) })), /status note is 501 characters; the limit is 500/);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']));
  assert.match(text(await update({ id, metadata: many })), /at most 32 metadata keys/);
  const r = call('PUT /api/scheduled-tasks/:id', { params: { id }, body: { metadata: { n: 5 } } });
  assert.strictEqual(r.code, 400);
  assert.match(r.body.error, /must be a string/);
  assert.strictEqual(stored(id).metadata, null, 'none of the rejected writes landed');
  assert.match(text(await tools.schedule_task.handler({ title: 't', prompt: 'p', cron: '0 9 * * 1', status_note: 'y'.repeat(600) }, SESSION)), /Could not schedule task: status note/);
});

// --- listing ------------------------------------------------------------------

test('list_scheduled_tasks shows state lines only where there is state', async () => {
  const keptId = await schedule({ title: 'kept name', metadata: { issue: '#712' } });
  const replId = await schedule({ title: 'replacement' });
  await update({ id: keptId, superseded_by: replId, status_note: 'folded into the replacement' });
  const out = await list();
  const block = out.split('\n\n').find((b) => b.startsWith(`#${keptId} `));
  assert.match(block, /^#\w+ "kept name" \(disabled\)/);
  assert.match(block, /\n  disabled: .+ by session sess7120 \("Fix #712"\)/);
  assert.match(block, /\n  status: folded into the replacement/);
  assert.match(block, new RegExp(`\\n  superseded by: #${replId} "replacement"`));
  assert.match(block, /\n  metadata: issue=#712/);
  const plain = out.split('\n\n').find((b) => b.startsWith(`#${replId} `));
  assert.doesNotMatch(plain, /disabled:|status:|superseded by:|metadata:/, 'an unannotated task lists as before');
  // A migrated task's date carries no time, so it prints as a date.
  const migrated = out.split('\n\n').find((b) => b.startsWith('#leg-ret '));
  assert.match(migrated, new RegExp(`\\n  disabled: ${new Date(localMidnight(2026, 9, 18)).toLocaleDateString().replace(/[/.]/g, '\\$&')}\\n`));
});

test('list filters: enabled, superseded_by, disabled_since, metadata', async () => {
  const a = await schedule({ title: 'filter a', metadata: { team: 'growth', tier: '1' } });
  const b = await schedule({ title: 'filter b', metadata: { team: 'growth' } });
  const c = await schedule({ title: 'filter c', supersedes: a });
  await update({ id: b, enabled: false });

  const off = listedIds(await list({ enabled: false }));
  assert.ok(off.includes(a) && off.includes(b) && off.includes('leg-off'));
  assert.ok(!off.includes(c));
  assert.ok(listedIds(await list({ enabled: true })).includes(c));

  assert.deepStrictEqual(listedIds(await list({ superseded_by: c })), [a]);

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const since = listedIds(await list({ disabled_since: today }));
  assert.ok(since.includes(a) && since.includes(b), 'turned off today');
  assert.ok(!since.includes('leg-pause'), 'no recorded date never matches');
  assert.ok(!since.includes(c), 'enabled tasks never match');
  assert.ok(listedIds(await list({ disabled_since: '2026-09-19' })).includes('leg-off'), 'migrated 09-21 is after 09-19');
  assert.ok(!listedIds(await list({ disabled_since: '2026-09-19' })).includes('leg-ret'), 'migrated 09-18 is before 09-19');
  assert.match(await list({ disabled_since: 'last tuesday' }), /Could not list: "last tuesday" is not a date/);

  assert.deepStrictEqual(listedIds(await list({ metadata: { team: 'growth', tier: '1' } })), [a]);
  assert.deepStrictEqual(listedIds(await list({ metadata: { team: 'growth' } })).sort(), [a, b].sort());
  assert.match(await list({ enabled: false, metadata: { team: 'growth' } }), /^All scheduled tasks \(turned off; metadata team=growth\):/);
});

test('include_changes prints the change log newest first', async () => {
  const id = await schedule({ title: 'logged' });
  await update({ id, title: 'logged v2' });
  await update({ id, enabled: false, status_note: 'done with it' });
  const block = (await list({ include_changes: true })).split('\n\n').find((b) => b.startsWith(`#${id} `));
  const lines = block.split('\n');
  const at = lines.indexOf('  changes (newest first):');
  assert.ok(at > 0, block);
  assert.match(lines[at + 1], /session sess7120 \("Fix #712"\) · enabled: true → false; statusNote: \(none\) → "done with it"$/);
  assert.match(lines[at + 2], /title: "logged" → "logged v2"$/);
  const bare = (await list({ include_changes: true })).split('\n\n').find((b) => b.startsWith('#leg-plain '));
  assert.match(bare, /\n  changes: none recorded/);
});
