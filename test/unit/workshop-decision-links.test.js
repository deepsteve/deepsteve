// Unit test for Workshop's side of decision links (#705).
//
// links.js owns /v1/<type>/<id> and is tested on its own in links.test.js. This file drives the
// Workshop provider THROUGH a real link registry, with a fake ctx, so the whole path a click
// takes is exercised with no daemon: workshop_ask mints a link, a GET renders it, a POST answers
// it — and, when the session that asked has gone, either starts the option's `then` or records
// the answer for workshop_answers. Discuss's three branches are here too.
//
// HOME is repointed before the require, as in workshop-inbox.test.js, because inbox.js persists
// under stateDir(). The inbox is module state shared by every test in this file, so headlines
// and session ids are unique per test.
//
// Run: node --test test/unit/workshop-decision-links.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-decision-links-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

// A real directory: project resolution stats it, and a follow-up spawns into it.
const PROJECT_DIR = path.join(SCRATCH, 'reports');
fs.mkdirSync(PROJECT_DIR, { recursive: true });

const workshop = require('../../mods/workshop/tools.js');
const inbox = require('../../mods/workshop/inbox.js');
const { createLinks } = require('../../links.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, location: null, contentType: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.redirect = (code, loc) => { res.statusCode = code; res.location = loc; return res; };
  return res;
}

function world({ spawnResult } = {}) {
  const shells = new Map();
  const saved = new Map();
  const spawns = [];
  const deliveries = [];
  const windowOpens = [];
  const registry = createLinks({ baseUrl: 'http://deepsteve.localhost:3000' });
  const ctx = {
    shells,
    log: () => {},
    sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd, worktree: e.worktree }),
    sessionInputState: () => 'idle',
    getDefaultEngine: () => null,
    deliverPromptWhenReady: (id, prompt, opts) => { deliveries.push({ id, prompt, opts }); },
    saveState: () => {},
    setMergeBlock: () => true,
    pathInside: (p, dir) => !!p && !!dir && (p === dir || p.startsWith(`${dir}/`)),
    screenshots: new Map(),
    getScreenshotPath: (id) => path.join(SCRATCH, `${id}.png`),
    links: registry,
    linkUrl: registry.urlFor,
    getSavedSession: (id) => saved.get(id) || null,
    reloadClients: new Set(),
    deliverToWindow: (msg, target, opts) => { windowOpens.push({ msg, target, opts }); return 'window'; },
    spawnAgentSession: (args) => {
      spawns.push(args);
      return spawnResult || { id: `new${spawns.length}`, name: args.name, tabDelivery: 'window' };
    },
  };
  const tools = workshop.init(ctx);
  return { shells, saved, spawns, deliveries, windowOpens, registry, ctx, tools };
}

let nextSession = 0;
const newSid = () => `dl${++nextSession}`;
const entry = (over = {}) => ({
  name: 'daily-report', cwd: PROJECT_DIR, worktree: null, agentType: 'claude', windowId: 'win-a', ...over,
});
const extraFor = (id) => ({ requestInfo: { url: { searchParams: new URLSearchParams({ shellId: id }) } } });
const said = (result) => result.content[0].text;
const ask = async (w, sid, args) => JSON.parse(said(await w.tools.workshop_ask.handler(args, extraFor(sid))));
const answers = async (w, sid, args = {}) => said(await w.tools.workshop_answers.handler(args, extraFor(sid)));
const get = (w, type, id) => { const res = fakeRes(); w.registry.handleGet({ params: { type, id }, body: {} }, res); return res; };
const post = (w, type, id, body) => { const res = fakeRes(); w.registry.handlePost({ params: { type, id }, body }, res); return res; };
const pageData = (html) => JSON.parse(/<script type="application\/json" id="decision-data">([\s\S]*?)<\/script>/.exec(html)[1]);

async function liveQuestion({ ask: args, world: opts, entry: over } = {}) {
  const w = world(opts);
  const sid = newSid();
  w.shells.set(sid, entry(over));
  const out = await ask(w, sid, args);
  return { w, sid, id: out.id, out };
}

// ── minting and rendering ────────────────────────────────────────────────────

test('Workshop registers itself as the provider of its ids', () => {
  const w = world();
  assert.deepStrictEqual(w.registry._providers.map((p) => p.name), ['workshop']);
});

test('workshop_ask hands back a server-minted UUID and a versioned link on the canonical origin', async () => {
  const { w, sid, id, out } = await liveQuestion({ ask: {
    question: 'OK to open an issue proposing a new analytics event?',
    options: [{ label: 'Yes', then: 'File the issue drafted in context, then start_issue it.' }, { label: 'No' }],
    recommendation: 'Yes',
    durable_days: 3,
  } });
  assert.match(id, UUID_RE, 'an id is a random UUID, never a short ticket an agent could guess');
  assert.deepStrictEqual(Object.keys(out).sort(), ['id', 'message', 'url']);
  assert.strictEqual(out.url, `http://deepsteve.localhost:3000/v1/decision/${id}`);
  assert.match(out.message, /end your turn now rather than polling/);
  assert.match(out.message, /workshop_answers/, 'a durable ask says where a late answer goes');

  const item = inbox.byId(id);
  assert.ok(item.durableUntil > Date.now() + 2 * inbox.DAY_MS);
  assert.strictEqual(item.options[0].then, 'File the issue drafted in context, then start_issue it.');

  const second = await ask(w, sid, { question: 'A second question from the same session' });
  assert.notStrictEqual(second.id, id);
  assert.match(second.id, UUID_RE);
});

test('an agent cannot name or group its question: a tag argument is ignored, the task comes from the session', async () => {
  const { id } = await liveQuestion({
    entry: { scheduled: true, scheduledTaskId: 'task-report' },
    ask: { question: 'Tag me?', tag: 'daily-report' },
  });
  const item = inbox.byId(id);
  assert.strictEqual(item.tag, '', 'workshop_ask has no tag any more; a stray argument is dropped');
  assert.strictEqual(item.scheduledTaskId, 'task-report', 'derived from the calling session');
});

test('opening the link renders the question and changes nothing', async () => {
  const { w, id } = await liveQuestion({ ask: {
    question: 'Ship </script><script>alert(1)</script>?',
    context: '**why** it matters',
    options: [{ label: 'Yes', then: 'ship it' }],
  } });
  const before = JSON.stringify(inbox.byId(id));
  const res = get(w, 'decision', id);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.contentType, 'html');
  assert.ok(!res.body.includes('<script>alert(1)'), 'agent text never becomes markup');
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);

  const data = pageData(res.body);
  assert.strictEqual(data.headline, 'Ship </script><script>alert(1)</script>?');
  assert.strictEqual(data.options[0].then, 'ship it');
  assert.strictEqual(data.postUrl, `/v1/decision/${id}`);
  assert.strictEqual(data.sessionAlive, true);
  for (const hidden of ['sessionId', 'project', 'scheduledTaskId', 'seq']) {
    assert.ok(!(hidden in data), `the page is not handed ${hidden}`);
  }
  assert.strictEqual(JSON.stringify(inbox.byId(id)), before, 'a GET must never write');
});

test('an expired question renders, is not swept by the GET, and refuses an answer', async () => {
  const { w, id } = await liveQuestion({ ask: { question: 'Expire me?', options: [{ label: 'Yes', then: 'go' }], durable_days: 1 } });
  inbox.byId(id).durableUntil = Date.now() - 1;
  assert.strictEqual(get(w, 'decision', id).statusCode, 200);
  assert.strictEqual(inbox.byId(id).status, 'open', 'expiry is computed on a GET, never written');

  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 0 });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.error, 'expired');
  assert.strictEqual(w.spawns.length, 0);
  assert.strictEqual(w.deliveries.length, 0);
});

test('a superseded question renders why, is not swept by the GET, and never runs its then (#710)', async () => {
  const { w, sid, id } = await liveQuestion({ ask: {
    question: 'Supersede me from the tab?', options: [{ label: 'Yes', then: 'do the thing' }], durable_days: 2,
  } });
  assert.strictEqual(pageData(get(w, 'decision', id).body).supersededBy, null, 'an open question says nothing replaced it');

  // The person replied in the tab and the session then closed. Nothing settled it, so the
  // stamp on the closed record is all there is to go on, and the link must be right anyway.
  const repliedAt = inbox.byId(id).createdAt + 1000;
  w.shells.delete(sid);
  w.saved.set(sid, { cwd: inbox.byId(id).project, agentType: 'claude', closed: true, lastHumanInputAt: repliedAt });

  const before = JSON.stringify(inbox.byId(id));
  const page = get(w, 'decision', id);
  assert.strictEqual(page.statusCode, 200);
  assert.deepStrictEqual(pageData(page.body).supersededBy, { rule: 'tab-reply', at: repliedAt });
  assert.strictEqual(JSON.stringify(inbox.byId(id)), before, 'computed on a GET, never written');

  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 0 });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.error, 'superseded');
  assert.match(r.body.hint, /replied in the asking session/);
  assert.deepStrictEqual(r.body.item.supersededBy, { rule: 'tab-reply', at: repliedAt }, 'the page redraws from this');
  assert.strictEqual(w.spawns.length, 0, 'the option\'s then never runs');
  assert.strictEqual(w.deliveries.length, 0);
  assert.strictEqual(inbox.byId(id).dismissedReason, 'superseded', 'a POST records it');

  const again = post(w, 'decision', id, { action: 'answer', optionIndex: 0 });
  assert.strictEqual(again.statusCode, 409);
  assert.strictEqual(again.body.error, 'superseded', 'a second click is told why, not "already answered"');
});

test('the stored item decides the link type', async () => {
  const w = world();
  const sid = newSid();
  w.shells.set(sid, entry());

  await w.tools.workshop_brief.handler({ headline: 'Nightly links run finished' }, extraFor(sid));
  const brief = inbox.all().findLast((i) => i.headline === 'Nightly links run finished');
  const wrong = get(w, 'decision', brief.id);
  assert.strictEqual(wrong.statusCode, 302);
  assert.strictEqual(wrong.location, `/v1/markdown/${brief.id}`);
  assert.strictEqual(get(w, 'markdown', brief.id).statusCode, 501, 'markdown is reserved, and says so');

  const result = inbox.add({ kind: 'result', headline: 'A result is not linkable' });
  assert.strictEqual(get(w, 'decision', result.id).statusCode, 404, 'Approve unlocks a merge; only the panel may offer it');
  assert.strictEqual(post(w, 'decision', result.id, { action: 'answer', optionIndex: 0 }).statusCode, 404);
});

test('a missing decision explains itself, and an item stored before #705 keeps its link', async () => {
  const w = world();
  const sid = newSid();
  w.shells.set(sid, entry());

  const never = get(w, 'decision', crypto.randomUUID());
  assert.strictEqual(never.statusCode, 404);
  assert.match(never.body, /cleared out since the link was sent/);

  const { id } = await ask(w, sid, { question: 'Evicted before anyone clicked' });
  const all = inbox.all();
  all.splice(all.findIndex((i) => i.id === id), 1);
  assert.strictEqual(get(w, 'decision', id).statusCode, 404, 'a random id cannot tell cleared from never issued');

  all.push(inbox.makeItem({ headline: 'Asked before #705' }, { id: 'w7', now: Date.now() }));
  assert.strictEqual(get(w, 'decision', 'w7').statusCode, 200, 'a legacy w<n> id still resolves');
  assert.strictEqual(get(w, 'decision', 'W7').statusCode, 404, 'only the canonical spelling is an address');
});

// ── answering ────────────────────────────────────────────────────────────────

test('an answer from the link to a live asker is typed in through the FIFO', async () => {
  const { w, sid, id } = await liveQuestion({ ask: { question: 'Live asker via link?', options: [{ label: 'Yes' }, { label: 'No', then: 'unused' }] } });
  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 1, text: 'not now' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.deliveredVia, 'prompt');
  assert.strictEqual(w.deliveries.length, 1);
  assert.strictEqual(w.deliveries[0].id, sid);
  assert.match(w.deliveries[0].prompt, /No\n\nnot now$/);
  assert.strictEqual(w.spawns.length, 0, 'a live asker is never replaced by a follow-up');
});

test('an asker that has gone gets the option\'s `then` run in a new session that closes itself', async () => {
  const { w, sid, id } = await liveQuestion({ ask: {
    question: 'OK to open an issue proposing a new export event?',
    context: 'Drafted issue:\n\n## Track exports',
    options: [
      { label: 'Yes', detail: 'file it', then: 'File the issue drafted in context, then start_issue it.' },
      { label: 'No' },
    ],
    recommendation: 'Yes',
    durable_days: 2,
  } });
  const project = inbox.byId(id).project;
  assert.ok(project, 'the question carries its project');
  w.shells.delete(sid);
  w.saved.set(sid, { cwd: project, agentType: 'codex', configDir: null, closed: true });

  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 0, text: 'go ahead' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.deliveredVia, 'then');
  assert.match(r.body.note, /follow-up started/);
  assert.strictEqual(w.spawns.length, 1);

  const [spawn] = w.spawns;
  assert.strictEqual(spawn.cwd, project, 'the project root, not the asker\'s worktree');
  assert.strictEqual(spawn.agentType, 'codex', 'the asker\'s agent carries over');
  assert.strictEqual(spawn.name, 'Decision follow-up', 'the server names the tab, never the agent');
  assert.match(spawn.prompt, /OK to open an issue proposing a new export event\?/);
  assert.match(spawn.prompt, /## Track exports/);
  assert.match(spawn.prompt, /The human chose: Yes — file it/);
  assert.match(spawn.prompt, /Their note: go ahead/);

  // The follow-up is a one-shot: it does the work, reports, and closes itself — in that order.
  const at = (s) => spawn.prompt.indexOf(s);
  assert.ok(at('File the issue drafted in context, then start_issue it.') > 0);
  assert.ok(at('mcp__deepsteve__workshop_brief') > at('File the issue drafted in context'), 'report after the work');
  assert.ok(at('mcp__deepsteve__close_session') > at('mcp__deepsteve__workshop_brief'), 'close after the report');
  assert.match(spawn.prompt, /leave the session open instead\.$/, 'and stays open when it needs the human');

  assert.strictEqual(inbox.byId(id).followUpSessionId, 'new1');
  assert.strictEqual(inbox.byId(id).deliveredVia, 'then');
  assert.strictEqual(w.deliveries.length, 0, 'nothing is typed into any existing session');

  const again = post(w, 'decision', id, { action: 'answer', optionIndex: 1 });
  assert.strictEqual(again.statusCode, 409, 'an item is answered once');
  assert.strictEqual(again.body.error, 'not-open');
  assert.strictEqual(again.body.item.answer.optionLabel, 'Yes');
  assert.strictEqual(w.spawns.length, 1, 'and a second click starts nothing');
});

test('an option without `then` is recorded for workshop_answers when the asker has gone', async () => {
  const { w, sid, id } = await liveQuestion({ ask: {
    question: 'No-then late answer?', options: [{ label: 'Yes', then: 'do it' }, { label: 'No' }], durable_days: 1,
  } });
  w.shells.delete(sid);
  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 1 });
  assert.strictEqual(r.body.deliveredVia, 'undelivered');
  assert.match(r.body.note, /workshop_answers/);
  assert.strictEqual(w.spawns.length, 0);
});

test('a follow-up that cannot start still records the answer, and says why', async () => {
  const { w, sid, id } = await liveQuestion({
    world: { spawnResult: { error: { message: 'Working directory no longer exists: /gone' } } },
    ask: { question: 'Spawn refuses?', options: [{ label: 'Yes', then: 'go' }], durable_days: 1 },
  });
  w.shells.delete(sid);
  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 0 });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.deliveredVia, 'undelivered');
  assert.match(r.body.note, /could not start: Working directory no longer exists/);
  assert.strictEqual(inbox.byId(id).status, 'answered');
  assert.strictEqual(inbox.byId(id).followUpSessionId, null);
});

test('the panel names the gone-durable path before the click', async () => {
  const { w, sid, id } = await liveQuestion({ ask: { question: 'Hint me?', options: [{ label: 'Yes' }], durable_days: 1 } });
  w.shells.delete(sid);
  const r = post(w, 'decision', id, { action: 'answer', optionIndex: 42 });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.item.pendingPath, 'gone-durable');
});

test('an unknown action is refused', async () => {
  const { w, id } = await liveQuestion({ ask: { question: 'Bad action?' } });
  assert.strictEqual(post(w, 'decision', id, { action: 'delete' }).statusCode, 400);
});

// ── Discuss ──────────────────────────────────────────────────────────────────

test('Discuss on a live asker focuses its tab — in its own window when that window is connected', async () => {
  const { w, sid, id } = await liveQuestion({ ask: { question: 'Discuss live?' } });
  const first = post(w, 'decision', id, { action: 'discuss' });
  assert.strictEqual(first.body.opened, 'focused');
  let open = w.windowOpens.at(-1);
  assert.strictEqual(open.msg.type, 'open-session');
  assert.strictEqual(open.msg.id, sid);
  assert.strictEqual(open.msg.repair, true, 'a no-op for a window that already has the tab');
  assert.strictEqual(open.msg.focus, true);
  assert.ok(!open.msg.restore);
  assert.strictEqual(open.target, null, 'a window that is not connected would receive nothing');

  w.ctx.reloadClients.add({ readyState: 1, windowId: 'win-a' });
  post(w, 'decision', id, { action: 'discuss' });
  open = w.windowOpens.at(-1);
  assert.strictEqual(open.target, 'win-a');
  assert.strictEqual(open.msg.windowId, 'win-a');

  assert.strictEqual(inbox.byId(id).status, 'open', 'Discuss changes nothing about the item');
  assert.strictEqual(w.spawns.length, 0);
});

test('Discuss on a closed but restorable asker asks a window to restore it', async () => {
  const { w, sid, id } = await liveQuestion({ ask: { question: 'Discuss restorable?' } });
  w.shells.delete(sid);
  w.saved.set(sid, { cwd: PROJECT_DIR, name: 'daily-report', closed: true });
  const r = post(w, 'decision', id, { action: 'discuss' });
  assert.strictEqual(r.body.opened, 'restored');
  const open = w.windowOpens.at(-1);
  assert.strictEqual(open.msg.restore, true, 'the one server push the browser may restore a tombstone from');
  assert.strictEqual(open.msg.id, sid);
  assert.strictEqual(open.msg.cwd, PROJECT_DIR);
  assert.strictEqual(open.opts.openBrowser, true);
  assert.strictEqual(w.spawns.length, 0);
});

test('Discuss with nothing to restore starts a fresh session that stays open for the conversation', async () => {
  const { w, sid, id } = await liveQuestion({ ask: {
    question: 'Discuss fresh?', context: 'Some context', options: [{ label: 'Yes' }, { label: 'No' }], recommendation: 'No',
  } });
  w.shells.delete(sid);
  w.saved.set(sid, { cwd: path.join(SCRATCH, 'deleted-dir'), closed: true });   // a record whose cwd is gone
  const r = post(w, 'decision', id, { action: 'discuss' });
  assert.strictEqual(r.body.opened, 'fresh');
  assert.strictEqual(w.windowOpens.length, 0);
  assert.strictEqual(w.spawns.length, 1);
  const [spawn] = w.spawns;
  assert.strictEqual(spawn.cwd, inbox.byId(id).project);
  assert.strictEqual(spawn.name, 'Discuss decision');
  assert.match(spawn.prompt, /Discuss fresh\?/);
  assert.match(spawn.prompt, /Some context/);
  assert.match(spawn.prompt, /Recommendation: No/);
  assert.match(spawn.prompt, /Do not act on any option until they tell you to\.$/);
  assert.ok(!spawn.prompt.includes('close_session'), 'a conversation is not told to close itself');
  assert.strictEqual(inbox.byId(id).status, 'open');
});

// ── workshop_answers ─────────────────────────────────────────────────────────

test('workshop_answers is scoped by the calling task or session, never by a name the agent picks', async () => {
  const w = world();
  const taskRun1 = newSid();
  const taskRun2 = newSid();
  const otherTaskRun = newSid();
  const plain = newSid();
  w.shells.set(taskRun1, entry({ scheduled: true, scheduledTaskId: 'task-a' }));
  w.shells.set(otherTaskRun, entry({ scheduled: true, scheduledTaskId: 'task-b' }));
  w.shells.set(plain, entry());

  const a = await ask(w, taskRun1, { question: 'First for task A', options: [{ label: 'Yes' }, { label: 'No' }] });
  const b = await ask(w, taskRun1, { question: 'Second for task A' });
  const other = await ask(w, otherTaskRun, { question: 'For task B', options: [{ label: 'Yes' }] });
  const mine = await ask(w, plain, { question: 'From a plain session' });
  await ask(w, taskRun1, { question: 'Unanswered for task A' });
  inbox.applyAnswer(inbox.byId(a.id), { optionIndex: 1, text: 'not this week' }, Date.parse('2026-09-10T08:00:00Z'));
  inbox.applyAnswer(inbox.byId(b.id), { text: 'use the staging data' }, Date.parse('2026-09-12T08:00:00Z'));
  inbox.applyAnswer(inbox.byId(other.id), { optionIndex: 0 }, Date.parse('2026-09-12T09:00:00Z'));
  inbox.applyAnswer(inbox.byId(mine.id), { text: 'fine' }, Date.parse('2026-09-12T10:00:00Z'));

  // The NEXT run of task A: a different session, same task.
  w.shells.delete(taskRun1);
  w.shells.set(taskRun2, entry({ scheduled: true, scheduledTaskId: 'task-a' }));

  const rows = JSON.parse(await answers(w, taskRun2));
  assert.deepStrictEqual(rows.map((r) => r.id), [b.id, a.id], 'answered only, this task only, newest first');
  assert.deepStrictEqual(rows[1].answer, { optionLabel: 'No', text: 'not this week' });
  assert.strictEqual(rows[1].answeredAt, '2026-09-10T08:00:00.000Z');
  assert.strictEqual(rows[0].question, 'Second for task A');
  assert.ok(!('tag' in rows[0]));

  const recent = JSON.parse(await answers(w, taskRun2, { since: '2026-09-11' }));
  assert.deepStrictEqual(recent.map((r) => r.id), [b.id]);

  assert.deepStrictEqual(JSON.parse(await answers(w, otherTaskRun)).map((r) => r.id), [other.id]);
  assert.deepStrictEqual(JSON.parse(await answers(w, plain)).map((r) => r.id), [mine.id],
    'an unscheduled session reads its own answers');
  assert.deepStrictEqual(JSON.parse(await answers(w, newSid())), [], 'and a stranger reads nothing');

  assert.match(await answers(w, taskRun2, { since: 'last tuesday' }), /is not a date/);
});
