// mods/workshop/chat-store.js (#670) — the thread for an agent with no transcript.
//
// This store is the ONLY record of a conversation with Codex or an experimental agent:
// nothing else on disk says the human asked anything or that the agent answered. So the
// caps matter in a way an inbox's do not — an eviction here destroys the only copy — and
// each one is pinned separately.
//
// HOME is repointed BEFORE the require, the workshop-inbox.test.js shape, because
// statePath() resolves against it.
//
// Run: node --test test/unit/workshop-chat-store.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-chat-store-'));
process.env.HOME = HOME;
process.env.DEEPSTEVE_HOME = path.join(HOME, '.deepsteve');

const store = require('../../mods/workshop/chat-store.js');
const { appendTo, clampText, threadTip, MAX_TEXT, MAX_PER_THREAD, MAX_THREADS } = store;

const FILE = path.join(HOME, '.deepsteve', 'workshop-chat.json');

function fresh() {
  try { fs.rmSync(FILE, { force: true }); } catch {}
  store._reset();
}

// ── pure layer ───────────────────────────────────────────────────────────────

test('a message records its role, its text and its time', () => {
  const threads = {};
  const m = appendTo(threads, 'S1', { role: 'agent', text: 'Because X.' }, { seq: 7, now: 1000 });
  assert.deepStrictEqual(m, { id: 'c7', role: 'agent', text: 'Because X.', at: 1000 });
  assert.deepStrictEqual(threads.S1, [m]);
});

test('an unknown role is an agent, never a silent third kind', () => {
  const threads = {};
  assert.strictEqual(appendTo(threads, 'S1', { role: 'wat', text: 'x' }, { seq: 1 }).role, 'agent');
  assert.strictEqual(appendTo(threads, 'S1', { role: 'human', text: 'x' }, { seq: 2 }).role, 'human');
});

test('both sides of the conversation live here', () => {
  // On this path the store IS the conversation. Storing only the agent's replies would
  // render as a monologue of answers to invisible questions.
  const threads = {};
  appendTo(threads, 'S1', { role: 'human', text: 'why?' }, { seq: 1, now: 1 });
  appendTo(threads, 'S1', { role: 'agent', text: 'because' }, { seq: 2, now: 2 });
  assert.deepStrictEqual(threads.S1.map((m) => m.role), ['human', 'agent']);
});

test('nothing to say stores nothing', () => {
  const threads = {};
  for (const text of ['', '   ', null, undefined]) {
    assert.strictEqual(appendTo(threads, 'S1', { role: 'agent', text }, { seq: 1 }), null);
  }
  assert.deepStrictEqual(threads, {});
});

test('a message with no session id is refused rather than filed under null', () => {
  const threads = {};
  assert.strictEqual(appendTo(threads, null, { role: 'agent', text: 'x' }, { seq: 1 }), null);
  assert.strictEqual(appendTo(threads, '', { role: 'agent', text: 'x' }, { seq: 1 }), null);
  assert.deepStrictEqual(threads, {});
});

test('text is clamped, not rejected', () => {
  const threads = {};
  const m = appendTo(threads, 'S1', { role: 'agent', text: 'x'.repeat(MAX_TEXT + 500) }, { seq: 1 });
  assert.strictEqual(m.text.length, MAX_TEXT);
  assert.strictEqual(clampText('abc', 2), 'ab');
  assert.strictEqual(clampText(null), '');
});

test('a thread keeps its NEWEST messages when it overflows', () => {
  const threads = {};
  for (let i = 0; i < MAX_PER_THREAD + 5; i++) {
    appendTo(threads, 'S1', { role: 'agent', text: 'm' + i }, { seq: i, now: i });
  }
  assert.strictEqual(threads.S1.length, MAX_PER_THREAD);
  assert.strictEqual(threads.S1[0].text, 'm5');
  assert.strictEqual(threads.S1[threads.S1.length - 1].text, 'm' + (MAX_PER_THREAD + 4));
});

test('threads are evicted oldest-conversation-first, and never the live one', () => {
  const threads = {};
  // MAX_THREADS + 1 sessions, each one message, ascending in time.
  for (let i = 0; i <= MAX_THREADS; i++) {
    appendTo(threads, 'S' + i, { role: 'agent', text: 'x' }, { seq: i, now: 1000 + i });
  }
  const keys = Object.keys(threads);
  assert.strictEqual(keys.length, MAX_THREADS);
  assert.ok(!keys.includes('S0'), 'the oldest thread should have gone');
  assert.ok(keys.includes('S' + MAX_THREADS), 'the thread just written to must survive');
});

test('threadTip ranks a thread by its newest message', () => {
  assert.strictEqual(threadTip([{ at: 5 }, { at: 90 }, { at: 12 }]), 90);
  assert.strictEqual(threadTip([]), 0);
  assert.strictEqual(threadTip(undefined), 0);
});

// ── the store ────────────────────────────────────────────────────────────────

test('append persists, and load reads it back', () => {
  fresh();
  store.append('S1', { role: 'human', text: 'why this shape?' });
  store.append('S1', { role: 'agent', text: 'Because X.' });
  assert.deepStrictEqual(store.thread('S1').map((m) => m.text), ['why this shape?', 'Because X.']);

  store._reset();
  assert.deepStrictEqual(store.thread('S1').map((m) => m.text), ['why this shape?', 'Because X.'],
    'a thread must survive a daemon restart — it is the only copy');
});

test('ids keep climbing across a reload', () => {
  fresh();
  store.append('S1', { role: 'agent', text: 'a' });
  store._reset();
  const second = store.append('S1', { role: 'agent', text: 'b' });
  assert.strictEqual(second.id, 'c2', 'a reissued id would collide as a React key');
});

test('an unknown session is an empty thread, never null', () => {
  fresh();
  assert.deepStrictEqual(store.thread('nope'), []);
  assert.deepStrictEqual(store.thread(null), []);
});

test('a corrupt file is an empty store, never a throw', () => {
  // This module is required at daemon boot; a throw here drops the whole mod, and
  // mcp-server.js would log one line and carry on without Workshop.
  fresh();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, '{ this is not json');
  store._reset();
  assert.deepStrictEqual(store.thread('S1'), []);
  assert.doesNotThrow(() => store.append('S1', { role: 'agent', text: 'recovered' }));
  assert.strictEqual(store.thread('S1').length, 1);
});

test('a file with the right shape but junk inside it does not crash', () => {
  fresh();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, threads: { S1: 'not an array', S2: [null, { id: 'c1' }] } }));
  store._reset();
  assert.deepStrictEqual(store.thread('S1'), []);
  assert.strictEqual(store.thread('S2').length, 1);
});

test('the write is atomic — no .tmp is left behind', () => {
  fresh();
  store.append('S1', { role: 'agent', text: 'x' });
  assert.ok(fs.existsSync(FILE));
  assert.ok(!fs.existsSync(FILE + '.tmp'), 'a torn file would lose the only copy of a conversation');
});

test('the store lives beside workshop.json, not inside it', () => {
  // workshop.json is read WHOLE on every 2s inbox poll, in every open browser. A
  // conversation in there would be paid for by every poll of every window.
  fresh();
  store.append('S1', { role: 'agent', text: 'x' });
  assert.ok(fs.existsSync(FILE), `expected ${FILE}`);
  const inboxFile = path.join(HOME, '.deepsteve', 'workshop.json');
  if (fs.existsSync(inboxFile)) {
    assert.ok(!fs.readFileSync(inboxFile, 'utf8').includes('threads'));
  }
});

test('a thread outlives the session that made it', () => {
  // Keyed on session id and evicted only by age, so closing a tab does not take the
  // record of what was said in it.
  fresh();
  store.append('S-closed', { role: 'agent', text: 'my last word' });
  store._reset();
  assert.strictEqual(store.thread('S-closed')[0].text, 'my last word');
});

process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });
