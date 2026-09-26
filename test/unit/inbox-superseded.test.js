// A Inbox question something has replaced leaves the inbox without anyone archiving it (#710).
//
// Two rules, both derived from facts the daemon holds and never from the asking agent, which
// may have been killed by the time the question stops mattering:
//   1. a person sent the asking session something after the question was asked;
//   2. a later run of the same scheduled task succeeded.
// inbox-items.test.js pins the decision itself. This file drives the mod: the submit-key
// observer server.js calls, the Inbox sends that stamp, every reader, and the REAL
// scheduled-tasks run history, read through taskSnapshot().
//
// scheduled-tasks reads its file once, at require time, so the tasks this file needs are
// written into the scratch HOME before anything is required. The inbox is module state shared
// by every test here, so headlines and session ids are unique per test.
//
// Run: node --test test/unit/inbox-superseded.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-inbox-superseded-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

const PROJECT_DIR = path.join(SCRATCH, 'reports');
fs.mkdirSync(PROJECT_DIR, { recursive: true });

// ── scheduled tasks, on disk before the require ──────────────────────────────

const MIN = 60 * 1000;
const T0 = Date.now() - 60 * MIN; // when every asking run below started

const row = (sessionId, startedAt, status, endedAt = null) => ({
  sessionId, startedAt, status, endedAt, agentStartedAt: null, success: null, summary: null,
});
const taskRecord = (id, runs, over = {}) => ({
  id, title: id, prompt: 'report', cron: '0 0 1 1 *', once: false, firedAt: null, enabled: true,
  // keepOpen, so scheduled_task_finished never tries to close a session this file faked.
  keepOpen: true, createdAt: T0 - MIN, lastRun: null, nextRun: null, runs, ...over,
});

fs.mkdirSync(path.join(SCRATCH, '.deepsteve'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, '.deepsteve', 'scheduled-tasks.json'), JSON.stringify([
  // Newest first, as runTask writes them. run-live-0 started BEFORE the asking run and
  // succeeded later, which must not count. -2 and -3 are still going and report mid-test.
  taskRecord('task-live', [
    row('run-live-3', T0 + 2 * MIN, 'running'),
    row('run-live-2', T0 + MIN, 'running'),
    row('run-live-1', T0, 'running'),
    row('run-live-0', T0 - MIN, 'succeeded', Date.now() + MIN),
  ]),
  taskRecord('task-unlucky', [
    row('run-unlucky-5', T0 + 4 * MIN, 'queued'),
    row('run-unlucky-4', T0 + 3 * MIN, 'running'),
    row('run-unlucky-3', T0 + 2 * MIN, 'timed-out', T0 + 3 * MIN),
    row('run-unlucky-2', T0 + MIN, 'failed', T0 + 2 * MIN),
    row('run-unlucky-1', T0, 'running'),
  ]),
  taskRecord('task-disabled', [
    row('run-disabled-2', T0 + MIN, 'succeeded', T0 + 2 * MIN),
    row('run-disabled-1', T0, 'running'),
  ], { enabled: false }),
  taskRecord('task-once', [
    row('run-once-2', T0 + MIN, 'succeeded', T0 + 2 * MIN),
    row('run-once-1', T0, 'running'),
  ], { once: true }),
], null, 2));

const inboxMod = require('../../mods/inbox/tools.js');
const inbox = require('../../mods/inbox/inbox.js');
const scheduled = require('../../mods/scheduled-tasks/tools.js');

// ── fakes ────────────────────────────────────────────────────────────────────

const COMPOSER = ['⏺ Which export format?', '─'.repeat(60), '> ', '─'.repeat(60), '? for shortcuts'];
const DIALOG = ['Do you want to make this edit?', '', ' 1. Yes', ' 2. No', '', 'Esc to cancel'];

// The mod caches screen scrapes by (session, outputSeq); monotonic across the file, as in the daemon.
let outputSeq = 0;
let nextSession = 0;
const newSid = () => `sup${++nextSession}`;
const extraFor = (id) => ({ requestInfo: { url: { searchParams: new URLSearchParams({ shellId: id }) } } });
const said = (result) => result.content[0].text;
// Every timestamp is Date.now(), and a reply has to land strictly after the question.
const later = () => new Promise((r) => setTimeout(r, 5));

function world() {
  const shells = new Map();
  const saved = new Map();
  const deliveries = [];
  const observers = new Map();
  let saves = 0;
  const ctx = {
    shells,
    log: () => {},
    sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd, worktree: e.worktree }),
    sessionInputState: () => 'idle',
    getDefaultEngine: () => null,
    getAgentConfig: () => ({ supportsSessionWatch: false }),
    transcriptPath: () => null,
    deliverPromptWhenReady: (id, prompt, opts) => { deliveries.push({ id, prompt, opts }); },
    saveState: () => { saves++; },
    setMergeBlock: () => true,
    getSavedSession: (id) => saved.get(id) || null,
    registerSubmitKeyObserver: (name, fn) => { observers.set(name, fn); },
    pathInside: (p, dir) => !!p && !!dir && (p === dir || p.startsWith(`${dir}/`)),
    screenshots: new Map(),
    getScreenshotPath: (id) => path.join(SCRATCH, `${id}.png`),
  };
  const routes = new Map();
  const app = {
    get: (p, ...h) => routes.set('GET ' + p, h[h.length - 1]),
    post: (p, ...h) => routes.set('POST ' + p, h[h.length - 1]),
  };
  const tools = inboxMod.init(ctx);
  inboxMod.registerRoutes(app, ctx);

  async function call(method, route, { params = {}, query = {}, body = {} } = {}) {
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `no handler for ${method} ${route}`);
    let status = 200;
    let payload;
    let done;
    const finished = new Promise((r) => { done = r; });
    const res = {
      status(c) { status = c; return res; },
      json(v) { payload = v; done(); return res; },
      end() { done(); return res; },
    };
    await handler({ params, query, body }, res);
    await finished;
    return { status, body: payload };
  }

  function session(over = {}, id = newSid()) {
    const entry = {
      name: 'daily-report', cwd: PROJECT_DIR, worktree: null, agentType: 'codex', windowId: 'win',
      waitingForInput: false, lastActivity: Date.now(), outputSeq: ++outputSeq, screen: COMPOSER,
      ...over,
    };
    entry.terminalScreen = { linesSync: () => entry.screen };
    shells.set(id, entry);
    return { id, entry };
  }

  return {
    ctx, shells, saved, deliveries, observers, tools, call, session,
    saves: () => saves,
    ask: async (sid, args) => JSON.parse(said(await tools.inbox_ask.handler(args, extraFor(sid)))),
    // What server.js does when a person's WebSocket input carries an Enter.
    pressEnter: (sid) => observers.get('inbox')(sid, shells.get(sid)),
    listed: async (id, all = false) => {
      const { body } = await call('GET', '/api/inbox/items', { query: all ? { all: '1' } : {} });
      return body.items.find((i) => i.id === id);
    },
  };
}

// ── rule 1: a person replied ─────────────────────────────────────────────────

test('Inbox registers one submit-key observer, by name, however often it is initialised', () => {
  const w = world();
  inboxMod.init(w.ctx);
  assert.deepStrictEqual([...w.observers.keys()], ['inbox']);
});

test('a line submitted at the prompt supersedes every question that session asked before it', async () => {
  const w = world();
  const { id: sid, entry } = w.session();
  const first = await w.ask(sid, { question: 'Export as CSV?', options: [{ label: 'Yes' }, { label: 'No' }], durable_days: 3 });
  const second = await w.ask(sid, { question: 'Include archived rows?' });
  const bystander = w.session();
  const theirs = await w.ask(bystander.id, { question: 'A question from another session' });
  await later();

  w.pressEnter(sid);

  assert.ok(entry.lastHumanInputAt > inbox.byId(second.id).createdAt, 'stamped on the session entry');
  assert.ok(w.saves() > 0, 'and persisted, so a restart or the session closing keeps it');
  for (const { id } of [first, second]) {
    const item = inbox.byId(id);
    assert.strictEqual(item.status, 'dismissed');
    assert.strictEqual(item.dismissedReason, 'superseded');
    assert.deepStrictEqual(item.supersededBy, { rule: 'tab-reply', at: entry.lastHumanInputAt });
  }
  assert.strictEqual(inbox.byId(theirs.id).status, 'open', 'a reply in one tab closes nothing another session asked');

  assert.strictEqual(await w.listed(first.id), undefined, 'it leaves the inbox');
  const archived = await w.listed(first.id, true);
  assert.match(archived.closedNote, /replied in the asking session/, 'the archive says why');
});

test('Enter on a dialog in the asking tab answers the dialog, not the question', async () => {
  const w = world();
  const { id: sid, entry } = w.session();
  const q = await w.ask(sid, { question: 'Is a dialog Enter a reply?' });
  await later();
  entry.screen = DIALOG;
  entry.outputSeq = ++outputSeq;

  w.pressEnter(sid);
  assert.strictEqual(entry.lastHumanInputAt, undefined, 'not even stamped');
  assert.strictEqual(inbox.byId(q.id).status, 'open');
  assert.strictEqual(w.saves(), 0);
});

test('a line typed before the question existed does not supersede it', async () => {
  const w = world();
  const { id: sid, entry } = w.session();
  w.pressEnter(sid);
  assert.strictEqual(entry.lastHumanInputAt, undefined, 'nothing was open, so there was nothing to record');

  entry.lastHumanInputAt = Date.now(); // however it got there, this stamp predates the question
  await later();
  const q = await w.ask(sid, { question: 'Asked after the typing?' });
  assert.ok(await w.listed(q.id));
  assert.strictEqual(inbox.byId(q.id).status, 'open');
});

test('answering one question from the inbox leaves the session\'s other questions open', async () => {
  const w = world();
  const { id: sid } = w.session();
  const a = await w.ask(sid, { question: 'Answer me from the inbox', options: [{ label: 'Yes' }] });
  const b = await w.ask(sid, { question: 'Leave me open' });
  await later();

  const r = await w.call('POST', '/api/inbox/items/:id/answer', { params: { id: a.id }, body: { optionIndex: 0 } });
  assert.strictEqual(r.body.deliveredVia, 'prompt');
  // The answer is typed in through the FIFO. Delivering it is the answer path, not a person
  // replying in the tab, and it knows which question it closed.
  w.deliveries.at(-1).opts.onDeliver(sid);
  assert.strictEqual(inbox.byId(b.id).status, 'open');
  assert.ok(await w.listed(b.id));
});

test('an Inbox chat message supersedes, stamped when it was sent, once it is delivered', async () => {
  const w = world();
  const { id: sid, entry } = w.session();
  const q = await w.ask(sid, { question: 'Does a chat message supersede?' });
  await later();

  const r = await w.call('POST', '/api/inbox/chat/:sessionId', { params: { sessionId: sid }, body: { text: 'use JSON instead' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(inbox.byId(q.id).status, 'open', 'queued is not delivered');
  const sentBy = Date.now();
  await later();

  w.deliveries.at(-1).opts.onDeliver(sid);
  assert.strictEqual(inbox.byId(q.id).dismissedReason, 'superseded');
  assert.ok(entry.lastHumanInputAt <= sentBy, 'the stamp is when the person sent it, not when the queue drained');
});

test('an idle-row prompt supersedes the same way, and one never delivered supersedes nothing', async () => {
  const w = world();
  const { id: sid } = w.session();
  const q = await w.ask(sid, { question: 'Does an idle-row prompt supersede?' });
  await later();

  const r = await w.call('POST', '/api/inbox/items/:id/answer', { params: { id: 'idle:' + sid }, body: { text: 'just ship it' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(inbox.byId(q.id).status, 'open', 'not delivered yet, so it has replaced nothing');
  w.deliveries.at(-1).opts.onDeliver(sid);
  assert.strictEqual(inbox.byId(q.id).dismissedReason, 'superseded');
});

test('a reply survives its session being killed: the stamp on the closed record supersedes', async () => {
  const w = world();
  const { id: sid } = w.session();
  const q = await w.ask(sid, { question: 'Killed after the reply?', options: [{ label: 'Yes', then: 'do it' }], durable_days: 5 });
  // As if the observer's own settle never ran: only the persisted stamp is left to go on.
  const repliedAt = inbox.byId(q.id).createdAt + 1;
  w.shells.delete(sid);
  w.saved.set(sid, { cwd: PROJECT_DIR, agentType: 'codex', closed: true, lastHumanInputAt: repliedAt });

  assert.match(said(await w.tools.inbox_check.handler({ id: q.id })), /was superseded/);
  assert.deepStrictEqual(inbox.byId(q.id).supersededBy, { rule: 'tab-reply', at: repliedAt });
});

test('after a restart the stamp is read off the saved record on the first read, before any session is back', async () => {
  const w = world();
  const { id: sid } = w.session();
  const q = await w.ask(sid, { question: 'Restarted between the reply and the next read?' });
  const repliedAt = inbox.byId(q.id).createdAt + 1;
  // Boot: no live shells at all yet, and the session's (not closed) record carries the stamp.
  w.shells.clear();
  w.saved.set(sid, { cwd: PROJECT_DIR, agentType: 'codex', lastHumanInputAt: repliedAt });

  assert.strictEqual(await w.listed(q.id), undefined);
  assert.strictEqual(inbox.byId(q.id).dismissedReason, 'superseded');
});

test('an asker killed right after asking, with no reply, keeps its durable question', async () => {
  const w = world();
  const { id: sid } = w.session();
  const q = await w.ask(sid, { question: 'Killed with no reply?', durable_days: 2 });
  w.shells.delete(sid);
  w.saved.set(sid, { cwd: PROJECT_DIR, agentType: 'codex', closed: true, lastHumanInputAt: null });
  w.session(); // another live session, so the listing's boot guard lets the dead-session sweep run

  assert.ok(await w.listed(q.id));
  assert.strictEqual(inbox.byId(q.id).status, 'open');
});

test('a wait_seconds hold resolves the moment the person replies in the tab', async () => {
  const w = world();
  const { id: sid } = w.session();
  const started = Date.now();
  const pending = w.tools.inbox_ask.handler(
    { question: 'Hold, then reply in the tab?', options: [{ label: 'Yes' }], wait_seconds: 30 },
    extraFor(sid),
  );
  await later();
  w.pressEnter(sid);

  const out = JSON.parse(said(await pending));
  assert.ok(Date.now() - started < 5000, 'released, not timed out');
  assert.deepStrictEqual(Object.keys(out).sort(), ['id', 'message', 'url'], 'the same shape as ever');
  assert.match(out.message, /is no longer open: A person replied in the asking session/);
  assert.match(out.message, /Do not wait on it/);
  assert.strictEqual(inbox.pendingWaitCount(), 0);
});

test('inbox_check says superseded and why, and inbox_answers does not list it', async () => {
  const w = world();
  const { id: sid } = w.session();
  const q = await w.ask(sid, { question: 'What does inbox_check say?' });
  await later();
  w.pressEnter(sid);

  const check = said(await w.tools.inbox_check.handler({ id: q.id }));
  assert.match(check, /^Question \S+ was superseded: A person replied in the asking session at /);
  assert.match(check, /Do not wait on it\.$/);
  const rows = JSON.parse(said(await w.tools.inbox_answers.handler({}, extraFor(sid))));
  assert.ok(!rows.some((r) => r.id === q.id));
});

test('the panel\'s answer to a superseded question is a 409 that says why, and delivers nothing', async () => {
  const w = world();
  const { id: sid, entry } = w.session();
  const q = await w.ask(sid, { question: 'Answered after the tab reply?', options: [{ label: 'Yes' }] });
  // Stamped but not settled: the refusal itself has to see it.
  entry.lastHumanInputAt = inbox.byId(q.id).createdAt + 1;

  const r = await w.call('POST', '/api/inbox/items/:id/answer', { params: { id: q.id }, body: { optionIndex: 0 } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'superseded');
  assert.match(r.body.hint, /It can no longer be answered\.$/, 'the panel shows data.hint');
  assert.strictEqual(r.body.item.status, 'dismissed', 'and the refusal recorded it');
  assert.strictEqual(w.deliveries.length, 0);
});

test('a reply in the tab never supersedes a shared result', async () => {
  const w = world();
  const { id: sid, entry } = w.session();
  await w.tools.share_result.handler({ summary: 'A result outlives a reply in the tab' }, extraFor(sid));
  await later();
  w.pressEnter(sid);
  assert.strictEqual(inbox.byId(entry.resultItemId).status, 'open', 'a result gates a merge; only a human decision closes it');
});

// ── rule 2: a later run of the same scheduled task succeeded ─────────────────

test('a later run that succeeds supersedes; one that fails does not, and neither does an earlier one', async () => {
  // The real mod, with the feature off so its scheduler never fires anything. Its self-report
  // tools are ungated, which is exactly how a run reports in production.
  const sched = scheduled.init({ settings: { scheduledTasksEnabled: false }, log: () => {}, broadcast: () => {}, shells: new Map() });
  const finish = (sid, success) => sched.scheduled_task_finished.handler({ success }, extraFor(sid));

  const w = world();
  w.session({ scheduled: true, scheduledTaskId: 'task-live' }, 'run-live-1');
  const q = await w.ask('run-live-1', { question: 'Keep sending the weekly export?', durable_days: 7 });
  const item = inbox.byId(q.id);
  assert.strictEqual(item.scheduledTaskId, 'task-live');
  assert.strictEqual(item.scheduledRunStartedAt, T0, 'the asking run\'s start, captured while its row is there');
  assert.ok(await w.listed(q.id), 'run-live-0 succeeded, but it started before the asking run');

  await finish('run-live-2', false);
  assert.ok(await w.listed(q.id), 'a later run that failed takes nothing down with it');

  await finish('run-live-3', true);
  assert.strictEqual(await w.listed(q.id), undefined, 'a later run that succeeded had its chance to ask again');
  const endedAt = scheduled.taskSnapshot('task-live').runs.find((r) => r.sessionId === 'run-live-3').endedAt;
  assert.deepStrictEqual(inbox.byId(q.id).supersededBy, { rule: 'later-run', at: endedAt });
  assert.match((await w.listed(q.id, true)).closedNote, /later run of the same scheduled task/);
});

test('a later run still queued, running, timed out or failed supersedes nothing; nor does a disabled or one-time task', async () => {
  const w = world();
  for (const [taskId, asker] of [['task-unlucky', 'run-unlucky-1'], ['task-disabled', 'run-disabled-1'], ['task-once', 'run-once-1']]) {
    w.session({ scheduled: true, scheduledTaskId: taskId }, asker);
    const q = await w.ask(asker, { question: `Still wanted? (${taskId})`, durable_days: 3 });
    assert.ok(await w.listed(q.id), taskId);
    assert.match(said(await w.tools.inbox_check.handler({ id: q.id })), /still open/, taskId);
  }
});

test('taskSnapshot is a copy: nothing written through it reaches the run history', () => {
  const snap = scheduled.taskSnapshot('task-unlucky');
  assert.deepStrictEqual(Object.keys(snap).sort(), ['deleted', 'enabled', 'id', 'once', 'runs']);
  snap.runs[0].status = 'succeeded';
  assert.strictEqual(scheduled.taskSnapshot('task-unlucky').runs[0].status, 'queued');
  assert.strictEqual(scheduled.taskSnapshot('no-such-task'), null);
  assert.strictEqual(scheduled.taskSnapshot(null), null);
});
