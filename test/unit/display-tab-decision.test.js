// Unit tests for decision tabs (#716): a display tab with a row of buttons whose click is
// delivered back to the session that opened it. Drives mods/display-tab/tools.js through a
// fake ctx and a fake express app — no daemon — covering the config normalizer, the tools'
// `decision` param, the injected bar, and every branch of POST /api/display-tab/:id/decide.
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
  };
  const tools = displayTab.init(ctx);
  const app = fakeApp();
  displayTab.registerRoutes(app, ctx);
  shells.set('owner-1', { cwd: '/tmp/proj', windowId: null });
  return { ctx, tools, app, displayTabs, shells, deliveries, client, hooks };
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
  assert.match(out.message, /End your turn/);
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

test('decide delivers the choice through the FIFO and closes the tab by default', async () => {
  const w = world();
  const id = await createDecision(w, { allow_note: true, buttons: [{ label: 'No' }, { label: 'Yes', sends: 'Merge it' }] });
  w.client.sent.length = 0;
  const res = decide(w, id, { index: 1, note: '  looks good ' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { sent: true, label: 'Yes', closed: true });
  assert.strictEqual(w.deliveries.length, 1);
  const d = w.deliveries[0];
  assert.strictEqual(d.id, 'owner-1');
  assert.match(d.prompt, /The user chose: Yes/);
  assert.match(d.prompt, /Merge it/);
  assert.match(d.prompt, /Their note: looks good/);
  assert.strictEqual(d.opts.source, 'decision-tab');
  assert.strictEqual(d.opts.skipIf('owner-1'), false);
  assert.strictEqual(d.opts.skipIf('gone'), true);
  assert.ok(!w.displayTabs.has(id), 'closed on decision');
  const types = w.client.sent.map(m => m.type);
  assert.ok(types.includes('close-display-tab'));
  assert.deepStrictEqual(w.client.sent.filter(m => m.type === 'decision-tabs').pop().tabs, []);
});

test('close_on_decision:false keeps the tab, marks it decided, and refuses a second answer', async () => {
  const w = world();
  const id = await createDecision(w, { close_on_decision: false, buttons: [{ label: 'A' }, { label: 'B' }] });
  assert.strictEqual(decide(w, id, { index: 0 }).statusCode, 200);
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

test('update_display_tab with a decision re-arms the tab for a follow-up', async () => {
  const w = world();
  const id = await createDecision(w, { close_on_decision: false, buttons: [{ label: 'A' }] });
  decide(w, id, { index: 0 });
  const r = await w.tools.update_display_tab.handler({ tab_id: id, html: PAGE, decision: { buttons: [{ label: 'Again?' }] } });
  assert.strictEqual(parse(r).decision, true);
  const res = decide(w, id, { index: 0 });
  assert.strictEqual(res.statusCode, 200);
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

test('decide validates the button index and ignores a note the tab did not ask for', async () => {
  const w = world();
  const id = await createDecision(w, { buttons: [{ label: 'Yes' }] });
  assert.strictEqual(decide(w, id, { index: 3 }).statusCode, 400);
  assert.strictEqual(decide(w, id, { index: '0' }).statusCode, 400);
  assert.strictEqual(decide(w, 'nope', { index: 0 }).statusCode, 404);
  assert.strictEqual(decide(w, id, { index: 0, note: 'sneaky' }).statusCode, 200);
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
