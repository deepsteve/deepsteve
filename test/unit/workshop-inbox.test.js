// Unit test for mods/workshop/inbox.js — the Workshop item store (#660).
//
// Why this file exists: the store holds live obligations. An agent that called
// workshop_ask has ended its turn and is waiting on an answer that will arrive as a
// new prompt; if the item is silently dropped by retention, dismissed by an eager
// expiry sweep, or double-answered by two browser windows, the agent waits forever
// and nothing anywhere says why. None of those failures are visible by looking at
// the screen, so each one is pinned here.
//
// The module deliberately never sees the initMCP ctx — session awareness arrives as
// an `isAlive` callback — which is exactly what lets this run with no fake context
// object, no daemon and no PTY, i.e. in the bare `unit` CI job.
//
// HOME is repointed at a scratch dir BEFORE the require, because paths.js resolves
// stateDir() from it. inbox.js resolves its filename lazily inside a function for
// this reason; a module-scope path.join would have baked in the developer's real
// ~/.deepsteve and this suite would write to it.
//
// Run: node --test test/unit/workshop-inbox.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workshop-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

const inbox = require('../../mods/workshop/inbox.js');

test('the scratch HOME really took — this suite must not touch a real inbox', () => {
  // If stateDir() ever stopped honouring HOME, every save() below would land in the
  // developer's ~/.deepsteve/workshop.json. Fail loudly rather than quietly writing.
  assert.ok(
    inbox.inboxFile().startsWith(SCRATCH),
    `inbox file resolved to ${inbox.inboxFile()}, outside the scratch HOME ${SCRATCH}`,
  );
});

const NOW = 1_000_000_000;
const mk = (fields, seq = 1, now = NOW) => inbox.makeItem(fields, { seq, now });

// ── makeItem: defaults, coercion, clamping ───────────────────────────────────

test('makeItem fills defaults and mints a w-prefixed id', () => {
  const a = mk({ kind: 'question', headline: 'Which retry policy?' }, 1);
  assert.strictEqual(a.id, 'w1');
  assert.strictEqual(a.seq, 1);
  assert.strictEqual(a.status, 'open');
  assert.strictEqual(a.urgency, 'normal');
  assert.strictEqual(a.createdAt, NOW);
  assert.strictEqual(a.answeredAt, null);
  assert.strictEqual(a.answer, null);
  assert.strictEqual(a.missingSince, null);
  assert.strictEqual(mk({}, 12).id, 'w12');
});

test('a briefing defaults to fyi and carries no options', () => {
  const b = mk({ kind: 'briefing', headline: 'Deployed v0.24', options: [{ label: 'x' }] }, 1);
  assert.strictEqual(b.kind, 'briefing');
  assert.strictEqual(b.urgency, 'fyi');
  assert.deepStrictEqual(b.options, []);
});

test('an unknown urgency coerces rather than propagating', () => {
  assert.strictEqual(mk({ urgency: 'URGENT!!' }, 1).urgency, 'normal');
  assert.strictEqual(mk({ urgency: 'blocking' }, 1).urgency, 'blocking');
});

test('oversized fields are clamped, so one agent cannot write a 10MB inbox', () => {
  const item = mk({
    headline: 'h'.repeat(inbox.MAX_HEADLINE + 500),
    context: 'c'.repeat(inbox.MAX_CONTEXT + 500),
    options: Array.from({ length: 30 }, (_, i) => ({ label: 'opt' + i })),
  }, 1);
  assert.strictEqual(item.headline.length, inbox.MAX_HEADLINE);
  assert.strictEqual(item.context.length, inbox.MAX_CONTEXT);
  assert.strictEqual(item.options.length, inbox.MAX_OPTIONS);
  assert.strictEqual(item.options[0].label, 'opt0');
});

test('option shorthand and blank labels are normalized away', () => {
  assert.deepStrictEqual(
    inbox.normalizeOptions(['Yes', { label: 'No', detail: 'stop here' }, { label: '   ' }]),
    [{ label: 'Yes' }, { label: 'No', detail: 'stop here' }],
  );
});

// ── the answer transition ────────────────────────────────────────────────────

test('answering an open question records text, index and the resolved label', () => {
  const item = mk({ options: [{ label: 'Uniform' }, { label: 'Minimal' }] }, 1);
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 1, text: ' go ' }, NOW + 5), 'ok');
  assert.strictEqual(item.status, 'answered');
  assert.strictEqual(item.answeredAt, NOW + 5);
  assert.deepStrictEqual(item.answer, { text: 'go', optionIndex: 1, optionLabel: 'Minimal' });
});

test('the second browser to answer loses, and changes nothing', () => {
  // First writer wins, mirroring /api/meta-controls-consent's { stale: true }. Two
  // windows polling the same inbox at 2s WILL race this.
  const item = mk({ options: [{ label: 'Yes' }, { label: 'No' }] }, 1);
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 0 }, NOW), 'ok');
  const snapshot = JSON.stringify(item);
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 1 }, NOW + 100), 'not-open');
  assert.strictEqual(JSON.stringify(item), snapshot, 'the losing answer must not mutate anything');
});

test('a bad option index is refused, never clamped', () => {
  const item = mk({ options: [{ label: 'Yes' }, { label: 'No' }] }, 1);
  for (const bad of [-1, 2, 99, 1.5, 'x']) {
    assert.strictEqual(inbox.applyAnswer(item, { optionIndex: bad }, NOW), 'bad-option', `index ${bad}`);
  }
  assert.strictEqual(item.status, 'open');
});

test('an option index against an item with no options is refused', () => {
  const item = mk({ options: [] }, 1);
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 0 }, NOW), 'bad-option');
});

test('neither text nor an index is empty, not an answer', () => {
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  assert.strictEqual(inbox.applyAnswer(item, {}, NOW), 'empty');
  assert.strictEqual(inbox.applyAnswer(item, { text: '   ' }, NOW), 'empty');
  assert.strictEqual(item.status, 'open');
});

test('index 0 is a real answer, not a falsy no-op', () => {
  const item = mk({ options: [{ label: 'Yes' }, { label: 'No' }] }, 1);
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 0 }, NOW), 'ok');
  assert.strictEqual(item.answer.optionLabel, 'Yes');
});

test('a briefing refuses an answer but accepts an archive', () => {
  const b = mk({ kind: 'briefing', headline: 'Deployed' }, 1);
  assert.strictEqual(inbox.applyAnswer(b, { text: 'ok' }, NOW), 'not-answerable');
  assert.strictEqual(b.status, 'open');
  assert.strictEqual(inbox.applyDismiss(b, null, NOW), 'ok');
  assert.strictEqual(b.status, 'dismissed');
  assert.strictEqual(b.dismissedReason, 'archived');
});

test('dismissing an already-answered item loses too', () => {
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  inbox.applyAnswer(item, { optionIndex: 0 }, NOW);
  assert.strictEqual(inbox.applyDismiss(item, 'archived', NOW + 1), 'not-open');
});

// ── retention ────────────────────────────────────────────────────────────────

test('retain keeps every open item plus the N most recent closed', () => {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const it = mk({ headline: 'q' + i }, i, NOW + i);
    if (i % 2 === 0) inbox.applyAnswer(it, { text: 'x' }, NOW + 1000 + i);
    list.push(it);
  }
  const kept = inbox.retain(list, 3);
  assert.strictEqual(kept.filter((i) => i.status === 'open').length, 10);
  assert.strictEqual(kept.filter((i) => i.status !== 'open').length, 3);
  // The three newest answered are 16, 18, 20.
  assert.deepStrictEqual(
    kept.filter((i) => i.status !== 'open').map((i) => i.headline).sort(),
    ['q16', 'q18', 'q20'],
  );
  // Output is in createdAt order, the file's canonical ordering.
  const times = kept.map((i) => i.createdAt);
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
});

test('retain never drops an open item, however many there are', () => {
  const list = Array.from({ length: 300 }, (_, i) => mk({ headline: 'q' + i }, i + 1, NOW + i));
  assert.strictEqual(
    inbox.retain(list, 200).length, 300,
    'an open item is a live obligation — an agent is waiting on it. MAX_OPEN caps '
    + 'this direction at the workshop_ask door, not by silently discarding.',
  );
});

// ── expiry ───────────────────────────────────────────────────────────────────

test('a missing session is stamped first and dismissed only after the grace', () => {
  const item = mk({ sessionId: 'abc' }, 1, NOW);
  const dead = () => false;

  assert.strictEqual(inbox.sweepDeadSessions([item], dead, NOW, 5000), 1);
  assert.strictEqual(item.status, 'open', 'the first pass only stamps');
  assert.strictEqual(item.missingSince, NOW);

  assert.strictEqual(inbox.sweepDeadSessions([item], dead, NOW + 4000, 5000), 0);
  assert.strictEqual(item.status, 'open', 'still inside the grace');

  assert.strictEqual(inbox.sweepDeadSessions([item], dead, NOW + 5000, 5000), 1);
  assert.strictEqual(item.status, 'dismissed');
  assert.strictEqual(item.dismissedReason, 'session-gone');
  assert.strictEqual(
    item.deliveredVia, 'undelivered',
    'an inbox that silently swallows an answer is worse than one that fails — record '
    + 'that this one went nowhere',
  );
});

test('a session that comes back inside the grace clears the stamp', () => {
  // This is the case the grace exists for: ctx.shells is EMPTY during the daemon's
  // own boot, before sessions are restored. An eager sweep dismisses everything.
  const item = mk({ sessionId: 'abc' }, 1, NOW);
  inbox.sweepDeadSessions([item], () => false, NOW, 5000);
  assert.strictEqual(item.missingSince, NOW);
  assert.strictEqual(inbox.sweepDeadSessions([item], () => true, NOW + 1000, 5000), 1);
  assert.strictEqual(item.missingSince, null);
  assert.strictEqual(item.status, 'open');
});

test('the sweep never touches closed items or items with no session', () => {
  const answered = mk({ sessionId: 'gone' }, 1, NOW);
  inbox.applyAnswer(answered, { text: 'done' }, NOW);
  const orphan = mk({ sessionId: null }, 2, NOW);
  assert.strictEqual(inbox.sweepDeadSessions([answered, orphan], () => false, NOW + 1e9, 5000), 0);
  assert.strictEqual(answered.status, 'answered');
  assert.strictEqual(orphan.status, 'open');
});

// ── ordering ─────────────────────────────────────────────────────────────────

test('sort is blocking, then normal, then fyi; oldest first inside a rank', () => {
  const list = [
    mk({ urgency: 'fyi', headline: 'f-old' }, 1, NOW + 1),
    mk({ urgency: 'normal', headline: 'n-new' }, 2, NOW + 9),
    mk({ urgency: 'blocking', headline: 'b-new' }, 3, NOW + 8),
    mk({ urgency: 'normal', headline: 'n-old' }, 4, NOW + 2),
    mk({ urgency: 'blocking', headline: 'b-old' }, 5, NOW + 3),
  ];
  assert.deepStrictEqual(
    inbox.sortForInbox(list).map((i) => i.headline),
    ['b-old', 'b-new', 'n-old', 'n-new', 'f-old'],
  );
});

test('the sort is a TOTAL order, so a poll cannot reshuffle the list', () => {
  // Derived blocked rows are rebuilt on every request, so incoming array order
  // carries no information and JS sort stability buys nothing. Without the id
  // tiebreak the list jitters under the cursor at every poll.
  const base = Array.from({ length: 8 }, (_, i) =>
    mk({ urgency: 'blocking', headline: 'q' + i }, i + 1, NOW));  // identical timestamps
  const expected = inbox.sortForInbox(base).map((i) => i.id);
  for (let round = 0; round < 20; round++) {
    const shuffled = base.slice().sort(() => Math.random() - 0.5);
    assert.deepStrictEqual(
      inbox.sortForInbox(shuffled).map((i) => i.id), expected,
      'compareItems needs the id tiebreak — urgency and createdAt alone are not a '
      + 'total order, and identical timestamps are the common case for derived rows',
    );
  }
});

test('sortForInbox does not mutate its input', () => {
  const list = [mk({ urgency: 'fyi' }, 1, NOW + 5), mk({ urgency: 'blocking' }, 2, NOW)];
  const before = list.map((i) => i.id);
  inbox.sortForInbox(list);
  assert.deepStrictEqual(list.map((i) => i.id), before);
});

// ── ids and tickets ──────────────────────────────────────────────────────────

test('a ticket is accepted in every spelling an agent might use', () => {
  for (const raw of [12, '12', '#12', 'w12', 'W12', ' #12 ']) {
    assert.strictEqual(inbox.normalizeTicket(raw), 'w12', `ticket ${JSON.stringify(raw)}`);
  }
  for (const bad of ['', '  ', 'abc', '../x', 'w', '#', null, undefined, '0', '-3', '1.5']) {
    assert.strictEqual(inbox.normalizeTicket(bad), null, `ticket ${JSON.stringify(bad)}`);
  }
});

test('derived ids round-trip and do not collide with stored ones', () => {
  assert.strictEqual(inbox.blockedId('a1b2c3d4'), 'blocked:a1b2c3d4');
  assert.strictEqual(inbox.parseBlockedId('blocked:a1b2c3d4'), 'a1b2c3d4');
  assert.strictEqual(inbox.parseBlockedId('w12'), null);
  assert.strictEqual(inbox.parseBlockedId('blocked:'), null);
  assert.strictEqual(inbox.parseBlockedId(null), null);
});

// ── persistence ──────────────────────────────────────────────────────────────

test('save/load round-trips and never reissues an id', () => {
  inbox.load();
  const a = inbox.add({ headline: 'first', sessionId: 's1' }, NOW);
  const b = inbox.add({ headline: 'second', sessionId: 's1' }, NOW + 1);
  assert.strictEqual(a.id, 'w1');
  assert.strictEqual(b.id, 'w2');
  inbox.save();

  inbox.load();
  assert.deepStrictEqual(inbox.all().map((i) => i.headline), ['first', 'second']);
  const c = inbox.add({ headline: 'third' }, NOW + 2);
  assert.strictEqual(c.id, 'w3', 'nextSeq must survive a reload, or a ticket points at two items');
});

test('save leaves no .tmp behind', () => {
  inbox.save();
  assert.ok(!fs.existsSync(inbox.inboxFile() + '.tmp'));
});

test('a corrupt file is an empty inbox, not a thrown mod', () => {
  // inbox.js is required at daemon boot. A throw here is caught per-mod by
  // mcp-server.js, which drops the ENTIRE mod — tools and routes — with one log line.
  fs.writeFileSync(inbox.inboxFile(), '{ this is not json');
  assert.doesNotThrow(() => inbox.load());
  assert.deepStrictEqual(inbox.all(), []);
  assert.strictEqual(inbox.add({ headline: 'after' }).id, 'w1');
});

test('nextSeq recovers from a file that lost it', () => {
  fs.writeFileSync(inbox.inboxFile(), JSON.stringify({
    version: 1,
    items: [{ id: 'w7', seq: 7, status: 'answered', createdAt: NOW }],
  }));
  inbox.load();
  assert.strictEqual(inbox.add({ headline: 'next' }).id, 'w8');
});

// ── the pending-wait registry ────────────────────────────────────────────────

test('a hold resolves with the answer when it lands in the window', async () => {
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  const held = inbox.holdForAnswer(item, 5000);
  assert.strictEqual(inbox.pendingWaitCount(), 1);
  inbox.applyAnswer(item, { optionIndex: 0 }, NOW);
  assert.strictEqual(inbox.releaseWait(item.id, item.answer), true);
  assert.deepStrictEqual(await held, item.answer);
  assert.strictEqual(inbox.pendingWaitCount(), 0);
});

test('a hold resolves null on timeout — it never rejects', async () => {
  // A rejection surfaces to the model as an MCP error and it retries, which is the
  // exact opposite of the "end your turn now rather than polling" instruction.
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  assert.strictEqual(await inbox.holdForAnswer(item, 20), null);
  assert.strictEqual(inbox.pendingWaitCount(), 0);
});

test('releasing after the timeout returns false and does not throw', async () => {
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  await inbox.holdForAnswer(item, 20);
  assert.strictEqual(
    inbox.releaseWait(item.id, { text: 'late' }), false,
    'finish() must be idempotent — this is the endpoint-vs-timeout race, and it '
    + 'happens in both orders',
  );
});

test('a second hold on the same item joins rather than stacking a timer', async () => {
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  const a = inbox.holdForAnswer(item, 5000);
  const b = inbox.holdForAnswer(item, 5000);
  assert.strictEqual(a, b, 'the same promise, not a second registration');
  assert.strictEqual(inbox.pendingWaitCount(), 1);
  inbox.releaseWait(item.id, { text: 'ok' });
  await a;
});

test('holding an already-answered item resolves at once and registers no timer', async () => {
  const item = mk({ options: [{ label: 'Yes' }] }, 1);
  inbox.applyAnswer(item, { optionIndex: 0 }, NOW);
  const answer = await inbox.holdForAnswer(item, 50_000);
  assert.deepStrictEqual(answer, item.answer);
  assert.strictEqual(
    inbox.pendingWaitCount(), 0,
    'resolve synchronously for the already-decided case BEFORE creating any state — '
    + 'otherwise a 50s timer outlives a call that already returned',
  );
});
