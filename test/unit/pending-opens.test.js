// Unit tests for the self-cleaning pendingOpens queue (#596).
//
// The bug this guards: an unattended scheduled run fires, completes and auto-closes
// while nobody has a browser open. Its `open-session` used to sit in the queue
// forever and get replayed to the next window, which reconnected with the dead id
// and made the server resurrect a #561 tombstone as a zombie `--resume` tab.
const { test } = require('node:test');
const assert = require('node:assert');
const { createPendingOpens } = require('../../pending-opens.js');

const openSession = (id, windowId = null) => ({ type: 'open-session', id, windowId });
const alive = () => true;
const dead = () => false;

test('push accepts both a JSON string and an object', () => {
  const q = createPendingOpens();
  q.push(JSON.stringify(openSession('aaa')));   // how mods/display-tab pushes
  q.push(openSession('bbb'));
  assert.strictEqual(q.length, 2);
  const ids = q.toArray().map((m) => JSON.parse(m).id);
  assert.deepStrictEqual(ids, ['aaa', 'bbb']);
});

test('drop removes every message for one session and leaves siblings alone', () => {
  const q = createPendingOpens();
  q.push(openSession('aaa'));
  q.push({ type: 'prompt-submitted', id: 'aaa', windowId: null });
  q.push(openSession('bbb'));
  assert.strictEqual(q.drop('aaa'), 2, 'both of the closed session\'s messages go');
  assert.strictEqual(q.length, 1);
  assert.strictEqual(JSON.parse(q.toArray()[0]).id, 'bbb');
  assert.strictEqual(q.drop('nope'), 0);
});

test('a finished session is filtered at flush even without an explicit drop', () => {
  const q = createPendingOpens();
  q.push(openSession('aaa'));
  const { send, droppedStale } = q.takeFor('w1', dead);
  assert.deepStrictEqual(send, [], 'a dead session must never be offered to a browser');
  assert.strictEqual(droppedStale, 1);
  assert.strictEqual(q.length, 0, 'and it must not linger for the next window either');
});

test('flush routing still holds: other windows keep their messages', () => {
  const q = createPendingOpens();
  q.push(openSession('unaddressed'));      // windowId null → anyone
  q.push(openSession('mine', 'w1'));
  q.push(openSession('theirs', 'w2'));
  const { send } = q.takeFor('w1', alive);
  assert.deepStrictEqual(send.map((m) => JSON.parse(m).id), ['unaddressed', 'mine']);
  assert.strictEqual(q.length, 1, 'w2\'s message is kept for w2');
  assert.strictEqual(JSON.parse(q.toArray()[0]).id, 'theirs');
});

test('TTL expires a message even when it is live and addressed to an absent window', () => {
  let clock = 1000;
  const q = createPendingOpens({ ttlMs: 5000, now: () => clock });
  q.push(openSession('old', 'w-never-returns'));
  clock += 5001;
  const { send, droppedExpired } = q.takeFor('w1', alive);
  assert.deepStrictEqual(send, []);
  assert.strictEqual(droppedExpired, 1);
  assert.strictEqual(q.length, 0, 'expiry is checked before the window filter');
});

test('the queue is capped, evicting oldest first', () => {
  const q = createPendingOpens({ max: 3 });
  for (let i = 0; i < 6; i++) q.push(openSession(`s${i}`));
  assert.strictEqual(q.length, 3);
  assert.deepStrictEqual(q.toArray().map((m) => JSON.parse(m).id), ['s3', 's4', 's5']);
});

test('unknown message types are never dropped for liveness', () => {
  const q = createPendingOpens();
  q.push({ type: 'some-future-mod-message', id: 'zzz' });
  // isLive answers false for everything; the predicate in server.js returns true
  // for types it doesn't recognize, so this only proves takeFor honors it.
  const { send } = q.takeFor('w1', (p) => p.type === 'some-future-mod-message');
  assert.strictEqual(send.length, 1);
});

test('clear empties the queue', () => {
  const q = createPendingOpens();
  q.push(openSession('aaa'));
  q.clear();
  assert.strictEqual(q.length, 0);
});
