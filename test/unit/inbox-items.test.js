// Unit test for mods/inbox/inbox.js — the Inbox item store (#660).
//
// Why this file exists: the store holds live obligations. An agent that called
// inbox_ask has ended its turn and is waiting on an answer that will arrive as a
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
// Run: node --test test/unit/inbox-items.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-inbox-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

const inbox = require('../../mods/inbox/inbox.js');

test('the scratch HOME really took — this suite must not touch a real inbox', () => {
  // If stateDir() ever stopped honouring HOME, every save() below would land in the
  // developer's ~/.deepsteve/inbox.json. Fail loudly rather than quietly writing.
  assert.ok(
    inbox.inboxFile().startsWith(SCRATCH),
    `inbox file resolved to ${inbox.inboxFile()}, outside the scratch HOME ${SCRATCH}`,
  );
});

const NOW = 1_000_000_000;
// makeItem is id-agnostic: add() is the only minter (a random UUID since #705), so a pure test
// hands it a readable one.
const mk = (fields, n = 1, now = NOW) => inbox.makeItem(fields, { id: `w${n}`, now });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── makeItem: defaults, coercion, clamping ───────────────────────────────────

test('makeItem fills defaults and keeps the id it is given', () => {
  const a = inbox.makeItem({ kind: 'question', headline: 'Which retry policy?' }, { id: 'given-id', now: NOW });
  assert.strictEqual(a.id, 'given-id');
  assert.ok(!('seq' in a), 'ids are not counted any more (#705)');
  assert.strictEqual(a.scheduledTaskId, null);
  assert.strictEqual(mk({ scheduledTaskId: 'task-a' }).scheduledTaskId, 'task-a');
  assert.strictEqual(a.status, 'open');
  assert.strictEqual(a.urgency, 'normal');
  assert.strictEqual(a.createdAt, NOW);
  assert.strictEqual(a.answeredAt, null);
  assert.strictEqual(a.answer, null);
  assert.strictEqual(a.missingSince, null);
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
    + 'this direction at the inbox_ask door, not by silently discarding.',
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

// ── durable questions and follow-ups (#705) ──────────────────────────────────

test('an option keeps its `then`, clamped, and a blank one is dropped', () => {
  const [yes, no] = inbox.normalizeOptions([
    { label: 'Yes', then: '  File the issue.  ' },
    { label: 'No', then: '   ' },
  ]);
  assert.deepStrictEqual(yes, { label: 'Yes', then: 'File the issue.' });
  assert.deepStrictEqual(no, { label: 'No' });
  const [long] = inbox.normalizeOptions([{ label: 'x', then: 't'.repeat(inbox.MAX_THEN + 10) }]);
  assert.strictEqual(long.then.length, inbox.MAX_THEN);
});

test('a result cannot be handed a `then` — its options are minted', () => {
  const r = mk({ kind: 'result', options: [{ label: 'Approve', then: 'merge it' }] }, 1);
  assert.ok(r.options.every((o) => !('then' in o)));
});

test('durable days become durableUntil, clamped, and only on questions', () => {
  assert.strictEqual(mk({ durableDays: 3 }, 1).durableUntil, NOW + 3 * inbox.DAY_MS);
  assert.strictEqual(mk({ durableDays: 999 }, 1).durableUntil, NOW + inbox.MAX_DURABLE_DAYS * inbox.DAY_MS);
  for (const raw of [0, -2, 'soon', null, undefined]) {
    assert.strictEqual(mk({ durableDays: raw }, 1).durableUntil, null, `durableDays ${JSON.stringify(raw)}`);
  }
  assert.strictEqual(mk({ kind: 'briefing', durableDays: 3 }, 1).durableUntil, null);
  assert.strictEqual(mk({ kind: 'result', durableDays: 3 }, 1).durableUntil, null);
  assert.strictEqual(mk({ tag: '  daily-report ' }, 1).tag, 'daily-report');
});

test('a durable question outlives its session and leaves by its own clock', () => {
  const item = mk({ sessionId: 'gone', durableDays: 1 }, 1, NOW);
  const dead = () => false;
  assert.strictEqual(inbox.sweepDeadSessions([item], dead, NOW, 5000), 0, 'never even stamped');
  assert.strictEqual(inbox.sweepDeadSessions([item], dead, NOW + 60 * 60 * 1000, 5000), 0);
  assert.strictEqual(item.status, 'open');
  assert.strictEqual(item.missingSince, null);

  assert.strictEqual(inbox.sweepDeadSessions([item], dead, NOW + inbox.DAY_MS, 5000), 1);
  assert.strictEqual(item.status, 'dismissed');
  assert.strictEqual(item.dismissedReason, 'expired');
});

test('a durable question expires even while its session is alive', () => {
  const item = mk({ sessionId: 'here', durableDays: 1 }, 1, NOW);
  assert.strictEqual(inbox.sweepDeadSessions([item], () => true, NOW + inbox.DAY_MS + 1, 5000), 1);
  assert.strictEqual(item.dismissedReason, 'expired');
});

test('an expired question refuses an answer before any sweep has run', () => {
  // The sweep runs on the panel's poll, and Inbox is off by default — a link can be
  // clicked on a machine where nothing has swept for days.
  const item = mk({ durableDays: 1, options: [{ label: 'Yes' }] }, 1, NOW);
  assert.ok(!inbox.isExpired(item, NOW + inbox.DAY_MS - 1));
  assert.ok(inbox.isExpired(item, NOW + inbox.DAY_MS));
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 0 }, NOW + inbox.DAY_MS), 'expired');
  assert.strictEqual(item.status, 'open', 'a refused answer changes nothing');
  assert.strictEqual(inbox.applyAnswer(item, { optionIndex: 0 }, NOW + 5), 'ok');
});

test('closed durable questions have their own retention bucket', () => {
  // The answer to a durable question is read LATER, by the next run of a recurring job. A
  // storm of newer briefings must not evict it first.
  const list = [];
  for (let i = 1; i <= 10; i++) {
    const durable = mk({ headline: 'd' + i, durableDays: 7 }, i, NOW + i);
    inbox.applyAnswer(durable, { text: 'no' }, NOW + 100 + i);
    list.push(durable);
  }
  for (let i = 11; i <= 40; i++) {
    const brief = mk({ kind: 'briefing', headline: 'b' + i }, i, NOW + i);
    inbox.applyDismiss(brief, 'archived', NOW + 1000 + i);
    list.push(brief);
  }
  const kept = inbox.retain(list, 5, 5, 4);
  assert.strictEqual(kept.filter((i) => i.durableUntil).length, 4);
  assert.deepStrictEqual(kept.filter((i) => i.durableUntil).map((i) => i.headline), ['d7', 'd8', 'd9', 'd10']);
  assert.strictEqual(kept.filter((i) => i.kind === 'briefing').length, 5);
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

test('an id is accepted as an agent might repeat it back', () => {
  const uuid = '3f9c2a10-5b7e-4d21-9a8b-0c1d2e3f4a5b';
  for (const raw of [uuid, uuid.toUpperCase(), ` ${uuid} `]) {
    assert.strictEqual(inbox.normalizeId(raw), uuid, `id ${JSON.stringify(raw)}`);
  }
  // An item stored before #705 keeps its w<n> id, and the old ticket spellings still find it.
  for (const raw of [12, '12', '#12', 'w12', 'W12', ' #12 ']) {
    assert.strictEqual(inbox.normalizeId(raw), 'w12', `legacy ticket ${JSON.stringify(raw)}`);
  }
  for (const bad of ['', '  ', 'abc', '../x', 'w', '#', null, undefined, '0', '-3', '1.5', `${uuid}x`]) {
    assert.strictEqual(inbox.normalizeId(bad), null, `id ${JSON.stringify(bad)}`);
  }
});

test('a link names an item by its exact id only', () => {
  const uuid = '3f9c2a10-5b7e-4d21-9a8b-0c1d2e3f4a5b';
  assert.ok(inbox.isItemId(uuid));
  assert.ok(inbox.isItemId('w12'));
  for (const loose of [uuid.toUpperCase(), 'W12', 'w012', '12', '#12', 'blocked:abc']) {
    assert.ok(!inbox.isItemId(loose), `${loose} would give one item two addresses`);
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

test('save/load round-trips, and every minted id is a fresh UUID (#705)', () => {
  inbox.load();
  const a = inbox.add({ headline: 'first', sessionId: 's1' }, NOW);
  const b = inbox.add({ headline: 'second', sessionId: 's1' }, NOW + 1);
  assert.match(a.id, UUID_RE);
  assert.match(b.id, UUID_RE);
  assert.notStrictEqual(a.id, b.id);
  inbox.save();

  inbox.load();
  assert.deepStrictEqual(inbox.all().map((i) => i.id), [a.id, b.id]);
  const c = inbox.add({ headline: 'third' }, NOW + 2);
  assert.ok(![a.id, b.id].includes(c.id));
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
  // Nothing to rewind: ids are random, so a wiped or corrupt store can never hand a new
  // question the address of one already sitting in someone's email (#705).
  assert.match(inbox.add({ headline: 'after' }).id, UUID_RE);
});

test('a file written before #705 loads, and its items keep their w<n> ids', () => {
  fs.writeFileSync(inbox.inboxFile(), JSON.stringify({
    version: 1,
    nextSeq: 71,
    items: [{ id: 'w70', seq: 70, kind: 'question', status: 'open', headline: 'old', createdAt: NOW }],
  }));
  inbox.load();
  assert.strictEqual(inbox.byId('w70').headline, 'old');
  assert.match(inbox.add({ headline: 'new' }).id, UUID_RE, 'new items are UUIDs regardless');
  inbox.save();
  assert.ok(!('nextSeq' in JSON.parse(fs.readFileSync(inbox.inboxFile(), 'utf8'))), 'the counter is gone from the file');
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

// ── results (#669) ───────────────────────────────────────────────────────────
//
// A result is a question with a FIXED two-option set. That is the whole reason
// share_result needed almost no new machinery — applyAnswer, the waits registry and
// the panel's 1-9 bindings all work on it unchanged — and it is also why the two
// options being un-forgeable matters: issue_complete unlocks a merge on
// `optionIndex === APPROVE_INDEX` and on nothing else.

test('a result mints its own two options and DISCARDS any the caller supplied', () => {
  const r = mk({
    kind: 'result',
    headline: 'Rewrote the wheel handler',
    options: [{ label: 'Ship it' }, { label: 'Approve' }, { label: 'Whatever' }],
  }, 1);

  assert.strictEqual(r.kind, 'result');
  assert.deepStrictEqual(r.options.map((o) => o.label), ['Approve', 'Request changes']);
  assert.strictEqual(
    r.options[inbox.APPROVE_INDEX].label, 'Approve',
    'the gate reads an INDEX, so an agent that could reorder or extend this list could '
    + 'hand itself an approval',
  );
});

test('the minted options are a copy, so one item cannot mutate every other result', () => {
  const a = mk({ kind: 'result', headline: 'a' }, 1);
  const b = mk({ kind: 'result', headline: 'b' }, 2);
  a.options[0].label = 'TAMPERED';
  assert.strictEqual(b.options[0].label, 'Approve');
  assert.strictEqual(inbox.RESULT_OPTIONS[0].label, 'Approve', 'the module constant is untouched');
});

test('a result is normal urgency, not blocking', () => {
  assert.strictEqual(
    mk({ kind: 'result', headline: 'done' }, 1).urgency, 'normal',
    'the agent IS stopped, but every finished issue pulsing red at the top of the inbox '
    + 'is how a human learns to stop looking at the top of the inbox',
  );
});

test('a result carries before/after/caveats and an empty image list', () => {
  const r = mk({
    kind: 'result', headline: 'h',
    before: 'the wheel walked history', after: 'the wheel is inert', caveats: 'untested on xterm 5',
  }, 1);
  assert.strictEqual(r.before, 'the wheel walked history');
  assert.strictEqual(r.after, 'the wheel is inert');
  assert.strictEqual(r.caveats, 'untested on xterm 5');
  assert.deepStrictEqual(r.images, [], 'filled in by tools.js once the item has an id');
});

test('the evidence fields are clamped like every other agent-supplied string', () => {
  const long = 'x'.repeat(inbox.MAX_SECTION + 500);
  const r = mk({ kind: 'result', headline: 'h', before: long, after: long, caveats: long }, 1);
  for (const f of ['before', 'after', 'caveats']) {
    assert.strictEqual(r[f].length, inbox.MAX_SECTION, `${f} must be clamped`);
  }
});

test('the evidence fields are empty on every other kind, so nothing has to branch', () => {
  for (const kind of ['question', 'briefing']) {
    const it = mk({ kind, headline: 'h', before: 'b', after: 'a', caveats: 'c' }, 1);
    assert.deepStrictEqual(
      [it.before, it.after, it.caveats, it.images], ['', '', '', []],
      `a ${kind} must not sprout result fields from a stray argument`,
    );
  }
});

test('an unknown kind falls back to question rather than inventing a fourth', () => {
  assert.strictEqual(mk({ kind: 'nonsense', headline: 'h' }, 1).kind, 'question');
});

test('approving and rejecting a result are ordinary applyAnswer transitions', () => {
  const approved = mk({ kind: 'result', headline: 'h' }, 1);
  assert.strictEqual(inbox.applyAnswer(approved, { optionIndex: 0 }, NOW), 'ok');
  assert.strictEqual(approved.answer.optionIndex, inbox.APPROVE_INDEX);
  assert.strictEqual(approved.answer.optionLabel, 'Approve');

  const changes = mk({ kind: 'result', headline: 'h' }, 2);
  assert.strictEqual(inbox.applyAnswer(changes, { optionIndex: 1, text: 'the empty case' }, NOW), 'ok');
  assert.strictEqual(changes.answer.optionIndex, 1);
  assert.strictEqual(changes.answer.text, 'the empty case');

  const third = mk({ kind: 'result', headline: 'h' }, 3);
  assert.strictEqual(
    inbox.applyAnswer(third, { optionIndex: 2 }, NOW), 'bad-option',
    'there is no third option to pick',
  );
});

test('a result is EXEMPT from the dead-session sweep', () => {
  // The exact case the sweep exists for, and the exact case it is wrong for: the
  // session is gone because the agent finished. That is when you READ the writeup.
  const result = mk({ kind: 'result', sessionId: 'gone', headline: 'h' }, 1, NOW);
  const question = mk({ kind: 'question', sessionId: 'gone', headline: 'h' }, 2, NOW);
  const dead = () => false;

  inbox.sweepDeadSessions([result, question], dead, NOW, 5000);
  assert.strictEqual(result.missingSince, null,
    'not even stamped — a stamp is what would let it age into the dismissal branch later');

  inbox.sweepDeadSessions([result, question], dead, NOW + 1_000_000, 5000);
  assert.strictEqual(result.status, 'open', 'a result outlives the tab that produced it');
  assert.strictEqual(question.status, 'dismissed', 'the sweep still works on everything else');
});

test('results are retained in their own bucket, so a briefing storm cannot evict one', () => {
  const list = [];
  const result = mk({ kind: 'result', headline: 'the writeup' }, 1, NOW);
  inbox.applyAnswer(result, { optionIndex: 0 }, NOW + 1);
  list.push(result);
  for (let i = 0; i < 300; i++) {
    const b = mk({ kind: 'briefing', headline: 'b' + i }, i + 2, NOW + 10 + i);
    inbox.applyDismiss(b, 'archived', NOW + 2000 + i);
    list.push(b);
  }

  const kept = inbox.retain(list, 200, 200);
  assert.strictEqual(kept.filter((i) => i.kind === 'briefing').length, 200, 'briefings still capped');
  assert.ok(
    kept.some((i) => i.headline === 'the writeup'),
    'the 201st briefing must not delete the writeup for the change that broke production',
  );
});

test('results are capped too — a second bucket, not an exemption', () => {
  const list = Array.from({ length: 30 }, (_, i) => {
    const r = mk({ kind: 'result', headline: 'r' + i }, i + 1, NOW + i);
    inbox.applyAnswer(r, { optionIndex: 0 }, NOW + 1000 + i);
    return r;
  });
  const kept = inbox.retain(list, 200, 5);
  assert.strictEqual(kept.length, 5, 'the file stays bounded in both buckets');
  assert.deepStrictEqual(
    kept.map((i) => i.headline), ['r25', 'r26', 'r27', 'r28', 'r29'],
    'newest kept, and the output is still in createdAt order',
  );
});

test('an OPEN result survives retention regardless of either cap', () => {
  const open = mk({ kind: 'result', headline: 'awaiting review' }, 1, NOW);
  const closed = Array.from({ length: 10 }, (_, i) => {
    const r = mk({ kind: 'result', headline: 'r' + i }, i + 2, NOW + i + 1);
    inbox.applyAnswer(r, { optionIndex: 0 }, NOW + 1000 + i);
    return r;
  });
  const kept = inbox.retain([open, ...closed], 0, 0);
  assert.deepStrictEqual(kept.map((i) => i.headline), ['awaiting review']);
});

// ── superseded questions (#710) ──────────────────────────────────────────────
//
// The decision alone, fed facts directly. inbox-superseded.test.js drives the same rules
// through the mod: the submit-key observer, the Inbox sends, every reader, and a real
// scheduled-task run history.

const facts = ({ replied = null, task = null } = {}) => ({ humanInputAt: () => replied, task: () => task });
const run = (sessionId, startedAt, status, endedAt = null) => ({ sessionId, startedAt, status, endedAt });
const recurring = (runs, over = {}) => ({ enabled: true, once: false, deleted: false, runs, ...over });
// A question from scheduled run `run1`, which started 100ms before it asked.
const scheduledQuestion = (n = 1) =>
  mk({ sessionId: 'run1', scheduledTaskId: 't', scheduledRunStartedAt: NOW - 100 }, n, NOW);

test('makeItem records the asking run only for a scheduled question, and starts unsuperseded', () => {
  const plain = mk({ scheduledRunStartedAt: NOW - 5 });
  assert.strictEqual(plain.scheduledRunStartedAt, null, 'no task, so no run');
  assert.strictEqual(plain.supersededBy, null);
  assert.strictEqual(mk({ scheduledTaskId: 't', scheduledRunStartedAt: NOW - 5 }).scheduledRunStartedAt, NOW - 5);
  assert.strictEqual(mk({ scheduledTaskId: 't', scheduledRunStartedAt: 'soon' }).scheduledRunStartedAt, null);
});

test('a person replying in the asking session supersedes the question, but only after it was asked', () => {
  const q = mk({ sessionId: 's1' }, 1, NOW);
  assert.strictEqual(inbox.supersession(q, facts()), null);
  assert.strictEqual(inbox.supersession(q, facts({ replied: NOW - 1 })), null, 'typed before the question existed');
  assert.strictEqual(inbox.supersession(q, facts({ replied: NOW })), null, 'strictly after');
  assert.deepStrictEqual(inbox.supersession(q, facts({ replied: NOW + 1 })), { rule: 'tab-reply', at: NOW + 1 });
  assert.strictEqual(inbox.supersession(q, null), null, 'no facts, no verdict');
});

test('only an open question is ever superseded — never a result or a briefing', () => {
  const replied = facts({ replied: NOW + 10 });
  assert.strictEqual(inbox.supersession(mk({ kind: 'result', sessionId: 's1' }), replied), null, 'a result gates a merge');
  assert.strictEqual(inbox.supersession(mk({ kind: 'briefing', sessionId: 's1' }), replied), null);
  const answered = mk({ sessionId: 's1' });
  inbox.applyAnswer(answered, { text: 'yes' }, NOW + 1);
  assert.strictEqual(inbox.supersession(answered, replied), null);
});

test('a durable question is superseded like any other — it is the case this exists for', () => {
  const q = mk({ sessionId: 'gone', durableDays: 7 }, 1, NOW);
  assert.deepStrictEqual(inbox.supersession(q, facts({ replied: NOW + 5 })), { rule: 'tab-reply', at: NOW + 5 });
});

test('an item stored before #705 takes the reply rule, and the run rule cannot apply to it', () => {
  const legacy = inbox.makeItem({ headline: 'old', sessionId: 's-old' }, { id: 'w3', now: NOW });
  const task = recurring([run('other', NOW + 1, 'succeeded', NOW + 2)]);
  assert.strictEqual(inbox.supersession(legacy, facts({ task })), null, 'no scheduledTaskId, no run to compare');
  assert.deepStrictEqual(inbox.supersession(legacy, facts({ replied: NOW + 3, task })), { rule: 'tab-reply', at: NOW + 3 });
});

test('only a later run that SUCCEEDED supersedes a scheduled question', () => {
  const q = scheduledQuestion();
  const asking = run('run1', NOW - 100, 'running');
  for (const status of ['failed', 'timed-out', 'ended', 'completed']) {
    const task = recurring([run('run2', NOW + 10, status, NOW + 20), asking]);
    assert.strictEqual(inbox.supersession(q, facts({ task })), null, `a later run that ended ${status}`);
  }
  for (const status of ['queued', 'running']) {
    const task = recurring([run('run2', NOW + 10, status), asking]);
    assert.strictEqual(inbox.supersession(q, facts({ task })), null, `a later run still ${status}`);
  }
  const task = recurring([run('run2', NOW + 10, 'succeeded', NOW + 20), asking]);
  assert.deepStrictEqual(inbox.supersession(q, facts({ task })), { rule: 'later-run', at: NOW + 20 });
});

test('an overlapping run counts only if it started after the asking run', () => {
  const q = scheduledQuestion();
  // A "run now" that began before the asking run, and finished after the question was asked.
  const before = run('run0', NOW - 150, 'succeeded', NOW + 30);
  assert.strictEqual(inbox.supersession(q, facts({ task: recurring([before]) })), null);
  // One that began after the asking run, but before the question was asked.
  const after = run('run2', NOW - 50, 'succeeded', NOW + 30);
  assert.deepStrictEqual(inbox.supersession(q, facts({ task: recurring([after, before]) })), { rule: 'later-run', at: NOW + 30 });
});

test('the asking run itself, or a run with no end time, never supersedes', () => {
  const q = scheduledQuestion();
  assert.strictEqual(inbox.supersession(q, facts({ task: recurring([run('run1', NOW + 1, 'succeeded', NOW + 5)]) })), null);
  assert.strictEqual(inbox.supersession(q, facts({ task: recurring([run('run2', NOW + 1, 'succeeded', null)]) })), null);
});

test('a one-time, disabled or deleted task supersedes nothing', () => {
  const q = scheduledQuestion();
  const runs = [run('run2', NOW + 1, 'succeeded', NOW + 5)];
  assert.ok(inbox.supersession(q, facts({ task: recurring(runs) })), 'the control: a recurring task does');
  assert.strictEqual(inbox.supersession(q, facts({ task: recurring(runs, { once: true }) })), null, 'one-time');
  assert.strictEqual(inbox.supersession(q, facts({ task: recurring(runs, { enabled: false }) })), null, 'disabled');
  assert.strictEqual(inbox.supersession(q, facts({ task: recurring(runs, { deleted: true }) })), null, 'deleted');
  assert.strictEqual(inbox.supersession(q, facts({ task: null })), null, 'no such task');
});

test('with no recorded start, the bound is the asking run\'s row, and then when it asked', () => {
  const unstamped = (n) => mk({ sessionId: 'run1', scheduledTaskId: 't' }, n, NOW);
  const withRow = recurring([run('run2', NOW - 90, 'succeeded', NOW + 50), run('run1', NOW - 100, 'running')]);
  assert.ok(inbox.supersession(unstamped(1), facts({ task: withRow })), 'bound is the row: NOW - 100');

  const rowAgedOut = recurring([run('run2', NOW - 90, 'succeeded', NOW + 50)]);
  assert.strictEqual(inbox.supersession(unstamped(2), facts({ task: rowAgedOut })), null, 'bound is createdAt: NOW');
  const laterStill = recurring([run('run2', NOW + 1, 'succeeded', NOW + 50)]);
  assert.ok(inbox.supersession(unstamped(3), facts({ task: laterStill })));
});

test('when several things replaced a question, the earliest is the one recorded', () => {
  const q = scheduledQuestion();
  const task = recurring([run('run3', NOW + 5, 'succeeded', NOW + 90), run('run2', NOW + 1, 'succeeded', NOW + 40)]);
  assert.deepStrictEqual(inbox.supersession(q, facts({ task })), { rule: 'later-run', at: NOW + 40 });
  assert.deepStrictEqual(inbox.supersession(q, facts({ task, replied: NOW + 20 })), { rule: 'tab-reply', at: NOW + 20 });
});

test('a superseded question refuses an answer before any sweep has run', () => {
  const q = mk({ sessionId: 's1', options: [{ label: 'Yes', then: 'go' }] }, 1, NOW);
  assert.strictEqual(inbox.applyAnswer(q, { optionIndex: 0 }, NOW + 2, facts({ replied: NOW + 1 })), 'superseded');
  assert.strictEqual(q.status, 'open', 'a refused answer changes nothing');
  assert.strictEqual(inbox.applyAnswer(q, { optionIndex: 0 }, NOW + 2), 'ok', 'without facts, only a recorded verdict refuses');
});

test('sweepSuperseded records the verdict and the rule, once, and it is final', () => {
  const a = mk({ sessionId: 's1' }, 1, NOW);
  const b = mk({ sessionId: 's1' }, 2, NOW + 1);
  const other = mk({ sessionId: 's2' }, 3, NOW);
  const f = { humanInputAt: (sid) => (sid === 's1' ? NOW + 10 : null), task: () => null };

  const dismissed = inbox.sweepSuperseded([a, b, other], f, NOW + 20);
  assert.deepStrictEqual(dismissed.map((i) => i.id), ['w1', 'w2'], 'every question that session asked before the reply');
  for (const item of [a, b]) {
    assert.strictEqual(item.status, 'dismissed');
    assert.strictEqual(item.dismissedReason, 'superseded');
    assert.deepStrictEqual(item.supersededBy, { rule: 'tab-reply', at: NOW + 10 });
    assert.strictEqual(item.answeredAt, NOW + 20);
  }
  assert.strictEqual(other.status, 'open');
  assert.deepStrictEqual(inbox.sweepSuperseded([a, b, other], f, NOW + 30), [], 'nothing left to record');
  assert.strictEqual(inbox.applyAnswer(a, { text: 'late' }, NOW + 40), 'superseded', 'not "not-open": the page says why');
});

test('supersededNote says what replaced the question, and when', () => {
  assert.strictEqual(inbox.supersededNote(null), '');
  assert.match(
    inbox.supersededNote({ rule: 'tab-reply', at: Date.parse('2026-09-15T14:02:00Z') }),
    /^A person replied in the asking session at 2026-09-15T14:02:00\.000Z/,
  );
  assert.match(
    inbox.supersededNote({ rule: 'later-run', at: Date.parse('2026-09-15T09:15:00Z') }),
    /^A later run of the same scheduled task finished successfully at 2026-09-15T09:15:00\.000Z/,
  );
});
