// The chat routes and workshop_say (#670).
//
// The assertions that earn their keep are the REFUSALS, and specifically that each one
// delivers NOTHING. Two of the three prevent a real misfire rather than a confusing
// message:
//
//   * a dead session — deliverPromptWhenReady is a silent no-op on a missing shell, so
//     without the gate the human watches a message sit queued forever;
//   * a session showing a dialog — a permission prompt classifies as 'waiting'
//     (screen-classifier.js), so drainPromptQueue would take the screen for idle and type
//     a paragraph of prose into a modal half a second later.
//
// Its own file rather than a sixth section of the 865-line workshop-tools.test.js, with
// its own fakes: this exercises a different half of the mod.
//
// Run: node --test test/unit/workshop-chat-routes.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-chat-routes-'));
process.env.HOME = HOME;
process.env.DEEPSTEVE_HOME = path.join(HOME, '.deepsteve');

const tools = require('../../mods/workshop/tools.js');
const chatStore = require('../../mods/workshop/chat-store.js');

const PROJECTS = path.join(HOME, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });

const transcriptFor = (id) => path.join(PROJECTS, `${id}.jsonl`);

function writeTranscript(id, records) {
  fs.writeFileSync(transcriptFor(id), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const userLine = (uuid, text) => ({
  type: 'user', uuid, timestamp: '2026-08-31T10:00:00.000Z', message: { role: 'user', content: text },
});
const agentLine = (uuid, text) => ({
  type: 'assistant', uuid, timestamp: '2026-08-31T10:00:05.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const IDLE = ['> ', '? for shortcuts'];
const DIALOG = ['Do you want to make this edit?', '', ' 1. Yes', ' 2. No', '', 'Esc to cancel'];

// The mod's scrape cache is module-level and keyed on (sessionId, entry.outputSeq), so a
// per-test counter that restarted at 1 would let one harness read the PREVIOUS harness's
// cached screen. Monotonic across the whole file, which is also how outputSeq behaves in
// the daemon: it only ever climbs.
let outputSeq = 0;

/**
 * One harness per test: the mod stashes ctx in a module-level `let`, so each build
 * re-inits it and the routes close over the newest one.
 */
function harness({ dialog = false } = {}) {
  const deliveries = [];
  const logs = [];
  const shells = new Map();
  const saved = {};
  let screen = dialog ? DIALOG : IDLE;
  outputSeq++;

  const terminalScreen = { linesSync: () => screen };
  const claude = {
    cwd: '/repo', agentType: 'claude', claudeSessionId: 'sess-a',
    scrollback: [], terminalScreen, outputSeq,
  };
  const codex = {
    cwd: '/repo', agentType: 'codex', scrollback: [], terminalScreen, outputSeq,
  };
  shells.set('S-claude', claude);
  shells.set('S-codex', codex);
  saved['S-closed'] = { cwd: '/repo', agentType: 'claude', claudeSessionId: 'sess-a' };

  const ctx = {
    shells,
    log: (m) => logs.push(m),
    getSavedSession: (id) => saved[id] || null,
    sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd }),
    sessionInputState: () => 'idle',
    getDefaultEngine: () => ({ linesSync: () => screen }),
    deliverPromptWhenReady: (id, prompt, opts) => deliveries.push({ id, prompt, opts }),
    // The real ctx helper answers only "where WOULD the transcript be" — it does not ask
    // whether this agent keeps one. The mod's own transcriptFor() adds that question via
    // getAgentConfig, so both have to be faked or the split is not being tested at all.
    getAgentConfig: (type) => ({ supportsSessionWatch: type === 'claude' || type === undefined }),
    transcriptPath: (e) => (e && e.claudeSessionId ? transcriptFor(e.claudeSessionId) : null),
  };

  const routes = {};
  const app = {
    get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; },
  };
  const registered = tools.init(ctx);
  tools.registerRoutes(app, ctx);

  function call(key, { params = {}, query = {}, body = {} } = {}) {
    let out = null;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(v) { out = { status: this.statusCode, body: v }; return this; },
    };
    routes[key]({ params, query, body }, res);
    return out;
  }

  return {
    ctx, deliveries, logs, shells, tools: registered, call, claude, codex,
    get: (sessionId, query) => call('GET /api/workshop/chat/:sessionId', { params: { sessionId }, query }),
    post: (sessionId, body) => call('POST /api/workshop/chat/:sessionId', { params: { sessionId }, body }),
    // New output is what invalidates the mod's scrape cache, so a screen change carries one.
    setScreen: (lines) => { screen = lines; claude.outputSeq = ++outputSeq; codex.outputSeq = outputSeq; },
  };
}

function freshStore() {
  try { fs.rmSync(path.join(HOME, '.deepsteve', 'workshop-chat.json'), { force: true }); } catch {}
  chatStore._reset();
}

const say = (h, sessionId, text) => h.tools.workshop_say.handler({ text }, {
  requestInfo: { url: { searchParams: new Map([['shellId', sessionId]]) } },
});

// ── GET ──────────────────────────────────────────────────────────────────────

test('a live Claude session reads its own transcript, both sides, in order', () => {
  freshStore();
  writeTranscript('sess-a', [userLine('u1', 'why this shape?'), agentLine('a1', 'Because X.')]);
  const h = harness();
  const { status, body } = h.get('S-claude');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.source, 'transcript');
  assert.strictEqual(body.threadKey, 'sess-a');
  assert.strictEqual(body.alive, true);
  assert.deepStrictEqual(body.messages.map((m) => [m.role, m.text]), [
    ['human', 'why this shape?'], ['agent', 'Because X.'],
  ]);
  assert.strictEqual(body.head, 'a1');
});

test('a session that has never been prompted is EMPTY, not an error (#542)', () => {
  // A --session-id session writes no .jsonl until its first message. A 404 or a 500 here
  // would make every freshly opened tab look broken.
  freshStore();
  try { fs.rmSync(transcriptFor('sess-a'), { force: true }); } catch {}
  const h = harness();
  const { status, body } = h.get('S-claude');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.messages, []);
  assert.strictEqual(body.empty, 'never-prompted');
});

test('a CLOSED session still has a readable history', () => {
  // The saved record carries cwd/worktree/configDir/claudeSessionId, which is everything
  // the path needs. The session is gone; the conversation is not.
  freshStore();
  writeTranscript('sess-a', [agentLine('a1', 'my last word')]);
  const h = harness();
  const { status, body } = h.get('S-closed');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.alive, false);
  assert.deepStrictEqual(body.messages.map((m) => m.text), ['my last word']);
});

test('an unknown session is a 404', () => {
  const h = harness();
  assert.strictEqual(h.get('nobody').status, 404);
});

test('a fork changes threadKey, which is what tells the client to drop its cursor', () => {
  // adoptClaudeSession rewrites claudeSessionId on a fork, a /clear and a plan-mode exit,
  // and emits no event. Re-deriving per request is the entire handling — and this is the
  // test a cached path would fail.
  freshStore();
  writeTranscript('sess-a', [agentLine('a1', 'before the fork')]);
  const h = harness();
  assert.strictEqual(h.get('S-claude').body.threadKey, 'sess-a');

  writeTranscript('sess-b', [agentLine('b1', 'after the fork')]);
  h.claude.claudeSessionId = 'sess-b';

  const after = h.get('S-claude').body;
  assert.strictEqual(after.threadKey, 'sess-b');
  assert.deepStrictEqual(after.messages.map((m) => m.text), ['after the fork']);
});

test('?since returns only what is new, and an unknown cursor returns everything', () => {
  freshStore();
  writeTranscript('sess-a', [userLine('u1', 'one'), agentLine('a1', 'two')]);
  const h = harness();
  assert.deepStrictEqual(h.get('S-claude', { since: 'u1' }).body.messages.map((m) => m.text), ['two']);
  assert.deepStrictEqual(h.get('S-claude', { since: 'a1' }).body.messages, []);
  // An unknown cursor is the normal case twice over: first load, and the poll right after
  // a fork. It must mean "send it all", never "send nothing".
  assert.strictEqual(h.get('S-claude', { since: 'never-seen' }).body.messages.length, 2);
});

test('a non-transcript agent reads the store instead, with the same message shape', () => {
  freshStore();
  const h = harness();
  const before = h.get('S-codex').body;
  assert.strictEqual(before.source, 'store');
  assert.strictEqual(before.empty, 'no-replies');

  return say(h, 'S-codex', 'Because the empty case is the default.').then(() => {
    const after = h.get('S-codex').body;
    assert.strictEqual(after.source, 'store');
    assert.deepStrictEqual(after.messages.map((m) => m.role), ['agent']);
    // Same keys as the transcript path — the pane must not be able to tell them apart.
    for (const k of ['id', 'role', 'text', 'at']) {
      assert.ok(k in after.messages[0], `store messages must carry ${k}`);
    }
  });
});

test('the route names a SESSION and cannot be steered at a file', () => {
  // The entry lookup is what makes an arbitrary-file read structurally impossible. No
  // path, cwd, configDir or claudeSessionId is ever accepted from the request.
  freshStore();
  writeTranscript('sess-a', [agentLine('a1', 'mine')]);
  const h = harness();
  const hostile = h.get('S-claude', {
    path: '/etc/passwd', file: '/etc/passwd', cwd: '/etc', claudeSessionId: 'sess-b',
  });
  assert.deepStrictEqual(hostile.body.messages.map((m) => m.text), ['mine']);
  assert.strictEqual(hostile.body.threadKey, 'sess-a');
});

// ── POST: the refusals ───────────────────────────────────────────────────────

test('empty text is refused and delivers nothing', () => {
  const h = harness();
  for (const text of ['', '   ', '\n\t ']) {
    assert.strictEqual(h.post('S-claude', { text }).status, 400);
  }
  assert.strictEqual(h.post('S-claude', {}).status, 400);
  assert.strictEqual(h.deliveries.length, 0);
});

test('a closed session is refused and delivers nothing', () => {
  const h = harness();
  const { status, body } = h.post('S-closed', { text: 'are you there?' });
  assert.strictEqual(status, 409);
  assert.strictEqual(body.error, 'session-gone');
  assert.ok(body.hint, 'the pane shows this to the human');
  assert.strictEqual(h.deliveries.length, 0);
});

test('a session showing a DIALOG is refused and delivers nothing', () => {
  // The load-bearing one. Without it, drainPromptQueue reads the permission prompt as an
  // idle screen and types the message into the modal 500ms later — answering a question
  // the human never read.
  const h = harness({ dialog: true });
  const { status, body } = h.post('S-claude', { text: 'why did you do it this way?' });
  assert.strictEqual(status, 409);
  assert.strictEqual(body.error, 'session-blocked');
  assert.strictEqual(h.deliveries.length, 0);
});

test('the dialog refusal lifts once the dialog is gone', () => {
  const h = harness({ dialog: true });
  assert.strictEqual(h.post('S-claude', { text: 'x' }).status, 409);
  h.setScreen(IDLE);
  assert.strictEqual(h.post('S-claude', { text: 'x' }).status, 200);
  assert.strictEqual(h.deliveries.length, 1);
});

test('the GET reports the dialog too, so the composer disables before anyone types', () => {
  freshStore();
  writeTranscript('sess-a', [agentLine('a1', 'hi')]);
  const h = harness({ dialog: true });
  assert.strictEqual(h.get('S-claude').body.blocked, true);
  h.setScreen(IDLE);
  assert.strictEqual(h.get('S-claude').body.blocked, false);
});

// ── POST: delivery ───────────────────────────────────────────────────────────

test('a message queues through the FIFO, tagged and guarded', () => {
  freshStore();
  const h = harness();
  const { status } = h.post('S-claude', { text: 'does it handle the empty case?' });
  assert.strictEqual(status, 200);
  assert.strictEqual(h.deliveries.length, 1);

  const [d] = h.deliveries;
  assert.strictEqual(d.id, 'S-claude');
  assert.strictEqual(d.prompt, 'does it handle the empty case?');
  assert.strictEqual(d.opts.source, 'workshop-chat');
  assert.strictEqual(typeof d.opts.skipIf, 'function');
  // skipIf is evaluated at SUBMIT time, not queue time — the session can die in between.
  h.shells.delete('S-claude');
  assert.strictEqual(d.opts.skipIf('S-claude'), true);
});

test('a Claude message carries no reply instruction and is not stored', () => {
  // Claude writes the message into its own transcript, so a copy in the store would show
  // every question twice.
  freshStore();
  const h = harness();
  h.post('S-claude', { text: 'plain question' });
  assert.strictEqual(h.deliveries[0].prompt, 'plain question');
  assert.ok(!/workshop_say/.test(h.deliveries[0].prompt));
  assert.deepStrictEqual(chatStore.thread('S-claude'), []);
});

test('a non-transcript agent is TOLD how to reply, and the question is stored', () => {
  // The instruction is chosen here, at delivery time, by agent type — which is what lets
  // the workflow stages stay agent-agnostic while the agents that need the tool hear
  // about it. And the human's own message has nowhere else to be recorded on this path.
  freshStore();
  const h = harness();
  h.post('S-codex', { text: 'and the empty case?' });
  const { prompt } = h.deliveries[0];
  assert.ok(prompt.startsWith('and the empty case?'), 'the question comes first');
  assert.match(prompt, /workshop_say/, 'a Codex agent has no other way to reach the pane');
  assert.deepStrictEqual(chatStore.thread('S-codex').map((m) => [m.role, m.text]),
    [['human', 'and the empty case?']]);
});

test('the POST logs a length, never the content', () => {
  freshStore();
  const h = harness();
  h.post('S-claude', { text: 'a secret the log must not keep' });
  const line = h.logs.find((l) => l.includes('chat'));
  assert.ok(line, 'the send should be logged');
  assert.ok(!line.includes('secret'), `the log leaked the message: ${line}`);
});

// ── workshop_say ─────────────────────────────────────────────────────────────

test('workshop_say has no session parameter, by construction', () => {
  // This is the property that keeps tools.js's security note true. There must be no
  // spelling of this tool that writes into another agent's conversation.
  const h = harness();
  assert.deepStrictEqual(Object.keys(h.tools.workshop_say.schema), ['text']);
  assert.ok('workshop_say' in h.tools);
});

test('workshop_say writes the CALLER thread and nothing else', async () => {
  freshStore();
  const h = harness();
  await say(h, 'S-codex', 'Because the default already covers it.');
  assert.deepStrictEqual(chatStore.thread('S-codex').map((m) => [m.role, m.text]),
    [['agent', 'Because the default already covers it.']]);
  assert.deepStrictEqual(chatStore.thread('S-claude'), []);
});

test('workshop_say never writes to a PTY', async () => {
  freshStore();
  const h = harness();
  await say(h, 'S-codex', 'a reply');
  assert.strictEqual(h.deliveries.length, 0, 'a reply tool that types into a session would '
    + 'be exactly the thing the meta-controls gate guards');
});

test('an unidentifiable caller is refused rather than filed under null', async () => {
  freshStore();
  const h = harness();
  const r = await h.tools.workshop_say.handler({ text: 'orphan' }, {});
  assert.match(r.content[0].text, /could not be identified/i);
  assert.deepStrictEqual(chatStore.thread(null), []);
  assert.deepStrictEqual(chatStore.thread('null'), []);
});

test('workshop_say says so when there was nothing to say', async () => {
  freshStore();
  const h = harness();
  const r = await say(h, 'S-codex', '   ');
  assert.match(r.content[0].text, /nothing to say/i);
  assert.deepStrictEqual(chatStore.thread('S-codex'), []);
});

test('an agent narrating itself in a loop is cut off', async () => {
  // The same failure MAX_OPEN prices for workshop_ask: an agent that treats the pane as a
  // progress log makes it useless as a conversation.
  freshStore();
  const h = harness();
  let refusedAt = -1;
  for (let i = 0; i < 40; i++) {
    const r = await say(h, 'S-codex', 'tick ' + i);
    if (/stop calling this/i.test(r.content[0].text)) { refusedAt = i; break; }
  }
  assert.ok(refusedAt > 0, 'the rate limit never fired');
  assert.ok(chatStore.thread('S-codex').length <= refusedAt + 1,
    'a refused call must store nothing');
});

process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });
