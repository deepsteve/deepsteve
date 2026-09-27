// Unit tests for decision tabs (#716): a display tab with a row of buttons whose click is
// delivered back to the session that opened it. Drives mods/display-tab/tools.js through a
// fake ctx and a fake express app — no daemon — covering the config normalizer, the tools'
// `decision` param, the injected bar, every branch of POST /api/display-tab/:id/decide, and
// await_decision: a held call answered by the click, the claim window for a choice nobody was
// waiting for, the transcript check behind a held call, and the typed fallback.
//
// HOME is repointed before the require: the decision store persists under stateDir().
//
// Run: node --test test/unit/display-tab-decision.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-decision-tab-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

const displayTab = require('../../mods/display-tab/tools.js');
const decision = require('../../mods/display-tab/decision.js');
const { createPendingOpens } = require('../../pending-opens.js');

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function fakeApp() {
  const routes = {};
  const add = (method) => (p, ...handlers) => { routes[`${method} ${p}`] = handlers[handlers.length - 1]; };
  return { routes, get: add('GET'), post: add('POST') };
}

function fakeClient() {
  const sent = [];
  return { readyState: 1, sent, send: (m) => sent.push(JSON.parse(m)) };
}

// One world per test: the mod keeps module-level state (ctx, store), so init() re-points it.
function world() {
  const displayTabs = new Map();
  const shells = new Map();
  const deliveries = [];
  const client = fakeClient();
  const hooks = new Map();
  const ctx = {
    shells,
    reloadClients: new Set([client]),
    pendingOpens: createPendingOpens(),
    log: () => {},
    displayTabs,
    setDisplayTab: (id, html) => displayTabs.set(id, html),
    // Mirrors server.js: the delete hook fires for every deletion.
    deleteDisplayTab: (id) => {
      displayTabs.delete(id);
      for (const h of hooks.values()) h.onDelete?.(id);
    },
    sessionPaths: (e) => ({ cwd: e.cwd }),
    deliverPromptWhenReady: (id, prompt, opts) => deliveries.push({ id, prompt, opts }),
    registerDisplayTabHooks: (name, h) => hooks.set(name, h),
    transcriptPath: () => transcript.file,
  };
  const transcript = { file: null };
  const tools = displayTab.init(ctx);
  const app = fakeApp();
  displayTab.registerRoutes(app, ctx);
  shells.set('owner-1', { cwd: '/tmp/proj', windowId: null });
  return { ctx, tools, app, displayTabs, shells, deliveries, client, hooks, transcript };
}

// The claim window and the transcript check run on timers; every test that reaches a delivery
// drives them by hand.
const CLAIM_GRACE_MS = 10_000;
const CONFIRM_MS = 30_000;
function mockTime(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-27T12:00:00Z') });
}

const PAGE = '<!DOCTYPE html><html><head></head><body><h1>Pick</h1></body></html>';
const parse = (r) => JSON.parse(r.content[0].text);

async function createDecision(w, decisionCfg, extra = {}) {
  const r = await w.tools.create_display_tab.handler({ session_id: 'owner-1', html: PAGE, name: 'Pick one', decision: decisionCfg, ...extra });
  assert.ok(!r.isError, r.content[0].text);
  return parse(r).id;
}

function decide(w, id, body) {
  const res = fakeRes();
  w.app.routes['POST /api/display-tab/:id/decide']({ params: { id }, body }, res);
  return res;
}

// ── normalizeDecision ────────────────────────────────────────────────────────

test('normalizeDecision fills defaults', () => {
  const { config, error } = decision.normalizeDecision({ buttons: [{ label: ' Ship it ' }, { label: 'No', sends: 'Do not ship', style: 'danger', confirm: true }] });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(config, {
    buttons: [
      { label: 'Ship it', sends: 'Ship it', style: 'default', confirm: false },
      { label: 'No', sends: 'Do not ship', style: 'danger', confirm: true },
    ],
    closeOnDecision: true,
    allowNote: false,
    prompt: '',
  });
});

test('normalizeDecision: decision.confirm is the default a button can override', () => {
  const { config } = decision.normalizeDecision({ confirm: true, close_on_decision: false, allow_note: true, buttons: [{ label: 'A' }, { label: 'B', confirm: false }] });
  assert.deepStrictEqual(config.buttons.map(b => b.confirm), [true, false]);
  assert.strictEqual(config.closeOnDecision, false);
  assert.strictEqual(config.allowNote, true);
});

test('normalizeDecision rejects bad configs', () => {
  assert.match(decision.normalizeDecision(null).error, /object/);
  assert.match(decision.normalizeDecision({ buttons: [] }).error, /at least one/);
  assert.match(decision.normalizeDecision({ buttons: [{ label: '' }] }).error, /non-empty label/);
  assert.match(decision.normalizeDecision({ buttons: [{ label: 'x', style: 'loud' }] }).error, /style/);
  const many = Array.from({ length: decision.MAX_BUTTONS + 1 }, (_, i) => ({ label: `b${i}` }));
  assert.match(decision.normalizeDecision({ buttons: many }).error, /the most is/);
});

test('decidePrompt names the tab, the choice, the note, and what happened to the tab', () => {
  const closed = decision.decidePrompt({ tabId: 'ab12', name: 'Pick', button: { label: 'Yes', sends: 'Yes' }, note: 'go', closed: true });
  assert.match(closed, /^\[Decision tab "Pick" \(ab12\)\] The user chose: Yes/);
  assert.match(closed, /Their note: go/);
  assert.match(closed, /closed itself/);
  assert.doesNotMatch(closed, /\n\nYes\n/, 'sends equal to the label is not repeated');
  const open = decision.decidePrompt({ tabId: 'ab12', name: 'Pick', button: { label: 'Yes', sends: 'Merge #12' }, note: '', closed: false });
  assert.match(open, /Merge #12/);
  assert.match(open, /update_display_tab/);
});

// ── tools ────────────────────────────────────────────────────────────────────

test('create_display_tab with decision records the owner and announces the list before the open', async () => {
  const w = world();
  const r = await w.tools.create_display_tab.handler({ session_id: 'owner-1', html: PAGE, name: 'Pick one', decision: { buttons: [{ label: 'Yes' }] } });
  const out = parse(r);
  assert.strictEqual(out.decision, true);
  assert.match(out.message, new RegExp(`await_decision with tab_id "${out.id}"`));
  const types = w.client.sent.map(m => m.type);
  assert.deepStrictEqual(types, ['decision-tabs', 'open-display-tab'], 'the list must precede the open');
  assert.deepStrictEqual(w.client.sent[0].tabs.map(t => [t.id, t.ownerSessionId]), [[out.id, 'owner-1']]);
});

test('create_display_tab refuses a decision with no live owner, and a bad config', async () => {
  const w = world();
  const gone = await w.tools.create_display_tab.handler({ session_id: 'nobody', html: PAGE, decision: { buttons: [{ label: 'Yes' }] } });
  assert.strictEqual(gone.isError, true);
  assert.match(gone.content[0].text, /live owner/);
  const bad = await w.tools.create_display_tab.handler({ session_id: 'owner-1', html: PAGE, decision: { buttons: [] } });
  assert.strictEqual(bad.isError, true);
  assert.strictEqual(w.displayTabs.size, 0, 'nothing is created on refusal');
});

test('a plain display tab is untouched: no bar, no list message', async () => {
  const w = world();
  const id = parse(await w.tools.create_display_tab.handler({ session_id: 'owner-1', html: PAGE })).id;
  assert.deepStrictEqual(w.client.sent.map(m => m.type), ['open-display-tab']);
  assert.strictEqual(w.hooks.get('decision').inject(PAGE, id), PAGE);
});

test('the bar is injected at serve time, before the last </body>', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const html = w.hooks.get('decision').inject(PAGE, id);
  assert.match(html, /<script src="\/mods\/display-tab\/decision-bar\.js" defer><\/script><\/body>/);
  // A page with no </body> still gets it.
  assert.match(w.hooks.get('decision').inject('<p>bare</p>', id), /decision-bar\.js/);
});

// ── POST decide ──────────────────────────────────────────────────────────────

test('with no await_decision holding, decide types the choice after the claim window and closes the tab', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { allow_note: true, buttons: [{ label: 'No' }, { label: 'Yes', sends: 'Merge it' }] });
  w.client.sent.length = 0;
  const res = decide(w, id, { index: 1, note: '  looks good ' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { sent: true, label: 'Yes', closed: true });
  assert.strictEqual(w.deliveries.length, 0, 'held for an await_decision call to claim first');
  t.mock.timers.tick(CLAIM_GRACE_MS);
  assert.strictEqual(w.deliveries.length, 1);
  const d = w.deliveries[0];
  assert.strictEqual(d.id, 'owner-1');
  assert.match(d.prompt, /The user chose: Yes/);
  assert.match(d.prompt, /Merge it/);
  assert.match(d.prompt, /Their note: looks good/);
  assert.strictEqual(d.opts.source, 'decision-tab');
  assert.strictEqual(d.opts.midTurn, true);
  assert.strictEqual(d.opts.skipIf('owner-1'), false);
  assert.strictEqual(d.opts.skipIf('gone'), true);
  assert.ok(!w.displayTabs.has(id), 'closed on decision');
  const types = w.client.sent.map(m => m.type);
  assert.ok(types.includes('close-display-tab'));
  assert.deepStrictEqual(w.client.sent.filter(m => m.type === 'decision-tabs').pop().tabs, []);
});

test('close_on_decision:false keeps the tab, marks it decided, and refuses a second answer', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { close_on_decision: false, buttons: [{ label: 'A' }, { label: 'B' }] });
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 200);
  t.mock.timers.tick(CLAIM_GRACE_MS);
  assert.ok(w.displayTabs.has(id));
  const again = decide(w, id, { index: 1 });
  assert.strictEqual(again.statusCode, 409);
  assert.strictEqual(again.body.error, 'already-decided');
  assert.strictEqual(again.body.choice.label, 'A');
  assert.strictEqual(w.deliveries.length, 1);

  const view = fakeRes();
  w.app.routes['GET /api/display-tab/:id/decision']({ params: { id } }, view);
  assert.strictEqual(view.body.status, 'decided');
  const list = fakeRes();
  w.app.routes['GET /api/decision-tabs']({}, list);
  assert.deepStrictEqual(list.body.tabs, [], 'a decided tab is no longer waiting');
});

test('update_display_tab with a decision re-arms the tab for a follow-up', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { close_on_decision: false, buttons: [{ label: 'A' }] });
  decide(w, id, { index: 0 });
  t.mock.timers.tick(CLAIM_GRACE_MS);
  const r = await w.tools.update_display_tab.handler({ tab_id: id, html: PAGE, decision: { buttons: [{ label: 'Again?' }] } });
  assert.strictEqual(parse(r).decision, true);
  assert.match(parse(r).message, /await_decision/);
  const res = decide(w, id, { index: 0 });
  assert.strictEqual(res.statusCode, 200);
  t.mock.timers.tick(CLAIM_GRACE_MS);
  assert.match(w.deliveries[1].prompt, /The user chose: Again\?/);
  assert.match(w.deliveries[1].prompt, /"Pick one"/, 're-arming keeps the tab name');
});

test('update_display_tab can turn a plain tab into a decision tab only with a live session_id', async () => {
  const w = world();
  const id = parse(await w.tools.create_display_tab.handler({ session_id: 'owner-1', html: PAGE })).id;
  const noOwner = await w.tools.update_display_tab.handler({ tab_id: id, html: PAGE, decision: { buttons: [{ label: 'Go' }] } });
  assert.strictEqual(noOwner.isError, true);
  const ok = await w.tools.update_display_tab.handler({ tab_id: id, html: PAGE, session_id: 'owner-1', decision: { buttons: [{ label: 'Go' }] } });
  assert.ok(!ok.isError);
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 200);
});

test('decide refuses when the owner is gone — deliverPromptWhenReady would drop it silently', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  w.shells.delete('owner-1');
  const res = decide(w, id, { index: 0 });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.error, 'session-gone');
  assert.strictEqual(w.deliveries.length, 0);
  assert.ok(w.displayTabs.has(id), 'the tab stays so the user can read why');
  const view = fakeRes();
  w.app.routes['GET /api/display-tab/:id/decision']({ params: { id } }, view);
  assert.strictEqual(view.body.ownerAlive, false);
  assert.strictEqual(view.body.status, 'open', 'still unanswered, so a later look shows the same');
});

test('decide refuses while the owner shows a dialog, and succeeds once it clears', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  let lines = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ];
  w.shells.get('owner-1').terminalScreen = { linesSync: () => lines };
  const blocked = decide(w, id, { index: 0 });
  assert.strictEqual(blocked.statusCode, 409);
  assert.strictEqual(blocked.body.error, 'session-blocked');
  lines = ['> ', ''];
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 200);
});

test('decide validates the button index and ignores a note the tab did not ask for', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  assert.strictEqual(decide(w, id, { index: 3 }).statusCode, 400);
  assert.strictEqual(decide(w, id, { index: '0' }).statusCode, 400);
  assert.strictEqual(decide(w, 'nope', { index: 0 }).statusCode, 404);
  assert.strictEqual(decide(w, id, { index: 0, note: 'sneaky' }).statusCode, 200);
  t.mock.timers.tick(CLAIM_GRACE_MS);
  assert.doesNotMatch(w.deliveries[0].prompt, /sneaky/);
});

test('a user ✕ (server delete hook) drops the decision and updates the list', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  w.client.sent.length = 0;
  w.ctx.deleteDisplayTab(id);
  assert.deepStrictEqual(w.client.sent.map(m => m.type), ['decision-tabs']);
  assert.deepStrictEqual(w.client.sent[0].tabs, []);
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 404);
});

test('onConnect hands a new browser window the waiting list', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const msg = w.hooks.get('decision').onConnect();
  assert.strictEqual(msg.type, 'decision-tabs');
  assert.deepStrictEqual(msg.tabs.map(t => t.id), [id]);
});

// ── await_decision ───────────────────────────────────────────────────────────

function callerExtra(shellId, signal) {
  return { requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) }, signal };
}
const out = (r) => r.content[0].text;

// What Claude Code writes when a held call's result reaches the conversation.
function recordAnswer(w, id, label) {
  fs.appendFileSync(w.transcript.file, JSON.stringify({
    type: 'user',
    timestamp: new Date(Date.now()).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: `[Decision tab "Pick one" (${id})] The user chose: ${label}` }] }] },
  }) + '\n');
}

let transcriptN = 0;
function withTranscript(w) {
  w.transcript.file = path.join(SCRATCH, `transcript-${++transcriptN}.jsonl`);
  fs.writeFileSync(w.transcript.file, '');
  return w;
}

test('await_decision returns the click as its result, types nothing, and finds it in the transcript', async (t) => {
  mockTime(t);
  const w = withTranscript(world());
  const id = await createDecision(w, { buttons: [{ label: 'Yes', sends: 'Merge it' }] });
  const held = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 200);
  const text = out(await held);
  assert.match(text, new RegExp(`^\\[Decision tab "Pick one" \\(${id}\\)\\] The user chose: Yes`));
  assert.match(text, /Merge it/);
  recordAnswer(w, id, 'Yes');
  t.mock.timers.tick(CONFIRM_MS + CLAIM_GRACE_MS);
  assert.strictEqual(w.deliveries.length, 0, 'confirmed, so never typed');
  assert.ok(!w.displayTabs.has(id), 'still closes on decision');
});

test('an answer a held call took but the transcript never shows is typed after the confirm window', async (t) => {
  mockTime(t);
  const w = withTranscript(world());
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const held = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  decide(w, id, { index: 0 });
  await held;
  t.mock.timers.tick(CONFIRM_MS - 1000);
  assert.strictEqual(w.deliveries.length, 0);
  t.mock.timers.tick(2000);
  assert.strictEqual(w.deliveries.length, 1, 'Claude Code abandoned the call without a word; the typed path takes over');
  assert.match(w.deliveries[0].prompt, /The user chose: Yes/);
  assert.strictEqual(w.deliveries[0].opts.skipIf('owner-1'), false);
});

test('a choice made before await_decision is called is claimed by it and never typed', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  decide(w, id, { index: 0 });
  t.mock.timers.tick(CLAIM_GRACE_MS - 1);
  const r = await w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  assert.ok(!r.isError);
  assert.match(out(r), /The user chose: Yes/);
  t.mock.timers.tick(CLAIM_GRACE_MS * 3);
  assert.strictEqual(w.deliveries.length, 0);
});

test('a claim still wins while the typed choice waits for an empty composer, and a late call says where it went', async (t) => {
  mockTime(t);
  const w = world();
  const a = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  decide(w, a, { index: 0 });
  t.mock.timers.tick(CLAIM_GRACE_MS);
  assert.strictEqual(w.deliveries.length, 1, 'queued for typing');
  assert.match(out(await w.tools.await_decision.handler({ tab_id: a }, callerExtra('owner-1'))), /The user chose: Yes/);
  assert.strictEqual(w.deliveries[0].opts.skipIf('owner-1'), true, 'claimed, so the queued typing is dropped');

  const b = await createDecision(w, { buttons: [{ label: 'No' }] });
  decide(w, b, { index: 0 });
  t.mock.timers.tick(CLAIM_GRACE_MS);
  w.deliveries[1].opts.onDeliver('owner-1');   // the typing started
  const late = await w.tools.await_decision.handler({ tab_id: b }, callerExtra('owner-1'));
  assert.ok(!late.isError);
  assert.match(out(late), /typed into this session/);
});

test('a second await_decision for the same tab replaces the first', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const first = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  const second = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  assert.match(out(await first), /replaced this one/);
  decide(w, id, { index: 0 });
  assert.match(out(await second), /The user chose: Yes/);
});

test('Esc ends the wait, and a later click is typed', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const ac = new AbortController();
  const held = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1', ac.signal));
  ac.abort();
  assert.match(out(await held), /Stopped waiting/);
  decide(w, id, { index: 0 });
  t.mock.timers.tick(CLAIM_GRACE_MS);
  assert.strictEqual(w.deliveries.length, 1);
});

test('closing the tab releases the held call', async (t) => {
  mockTime(t);
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const held = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  w.ctx.deleteDisplayTab(id);
  assert.match(out(await held), /closed without a choice/);
});

test('only the owning session can wait on a decision tab', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const r = await w.tools.await_decision.handler({ tab_id: id }, callerExtra('someone-else'));
  assert.strictEqual(r.isError, true);
  assert.match(out(r), /belongs to session owner-1/);
  const none = await w.tools.await_decision.handler({ tab_id: 'nope' }, callerExtra('owner-1'));
  assert.strictEqual(none.isError, true);
});

test('a session that is not Claude is told to end its turn, and its click is typed without the claim window', async (t) => {
  mockTime(t);
  const w = world();
  w.shells.get('owner-1').agentType = 'codex';
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  assert.match(out(await w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'))), /not supported for codex/);
  decide(w, id, { index: 0 });
  t.mock.timers.tick(1);
  assert.strictEqual(w.deliveries.length, 1);
});

test('a held call is answered even while the session shows a dialog — nothing is typed into it', async (t) => {
  mockTime(t);
  const w = world();
  w.shells.get('owner-1').terminalScreen = { linesSync: () => [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'] };
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  const held = w.tools.await_decision.handler({ tab_id: id }, callerExtra('owner-1'));
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 200);
  assert.match(out(await held), /The user chose: Yes/);
});

test('answerInTranscript wants this tab\'s marker, at or after the time given', () => {
  const f = path.join(SCRATCH, 'answer-in-transcript.jsonl');
  const since = Date.parse('2026-09-27T12:00:01Z');
  fs.writeFileSync(f,
    'cut mid-record (ab12)] The user chose: X"}\n'
    + JSON.stringify({ type: 'user', timestamp: '2026-09-27T12:00:00.000Z', message: { content: '[Decision tab "P" (ab12)] The user chose: Old' } }) + '\n');
  assert.strictEqual(decision.answerInTranscript(f, 'ab12', since), false, 'an earlier answer in the same tab does not count');
  fs.appendFileSync(f, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-27T12:00:05.000Z', content: '<task-notification>\n<result>\n[Decision tab "P" (ab12)] The user chose: New\n</result>\n</task-notification>' }) + '\n');
  assert.strictEqual(decision.answerInTranscript(f, 'ab12', since), true, 'a background result counts');
  assert.strictEqual(decision.answerInTranscript(f, 'cd34', since), false, 'another tab does not');
  assert.strictEqual(decision.answerInTranscript(path.join(SCRATCH, 'missing.jsonl'), 'ab12', since), false);
  assert.strictEqual(decision.answerInTranscript(null, 'ab12', since), false);
});

test('the store persists across a reload and prunes records whose tab is gone', () => {
  const file = path.join(SCRATCH, 'store-test.json');
  const live = new Set(['a']);
  const s1 = decision.createDecisionStore({ file: () => file, isLive: (id) => live.has(id) });
  s1.set('a', { status: 'open', createdAt: 1 });
  s1.set('b', { status: 'open', createdAt: 2 });
  const s2 = decision.createDecisionStore({ file: () => file, isLive: (id) => live.has(id) });
  assert.deepStrictEqual(s2.list().map(r => r.id), ['a']);
  const s3 = decision.createDecisionStore({ file: () => file, isLive: () => true });
  assert.deepStrictEqual(s3.list().map(r => r.id), ['a'], 'the prune was saved');
});
