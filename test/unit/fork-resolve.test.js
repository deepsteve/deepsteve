// Unit tests for the fork tip-resolver decision logic (#455).
//
// resolveForkTip walks from a fork parent's tracked session id forward to the LIVE
// transcript tip so a fork never resumes an earlier checkpoint. The pure decision logic
// (chaining, structural-reference match, mtime ordering, #497 ownership) lives in
// fork-resolve.js precisely so it can be tested deterministically here — a live daemon
// can't isolate it (Node's fs.watch heals resolvable rotations and races the resolver).
//
// Run: node --test test/unit/fork-resolve.test.js  (or npm run test:unit)

const { test } = require('node:test');
const assert = require('node:assert');
const { headStructurallyReferences, resolveForkTip } = require('../../fork-resolve');

// Build the JSONL lines Claude Code actually writes. A rotation/fork embeds its parent
// session id in a NON-message line (mode / summary / file-history-snapshot); a plain chat
// turn is a user/assistant message. Both are exercised below.
const summaryLine = (sessionId, parentSessionId) =>
  JSON.stringify({ type: 'summary', sessionId, parentSessionId }) + '\n';
const modeLine = (sessionId) => JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n';
const assistantMentioning = (id) =>
  JSON.stringify({ type: 'assistant', message: { content: `the previous session was ${id}` } }) + '\n';

// Assemble a resolveForkTip call from a plain {id: {mtimeMs, head}} spec. Ownership defaults
// to "nobody owns anything"; pass a Set of owned ids to exercise the #497 guard.
function resolve(startId, spec, ownedIds = new Set()) {
  const ids = Object.keys(spec);
  const mtimeOf = new Map(ids.map((id) => [id, spec[id].mtimeMs]));
  const readHead = (id) => spec[id].head;
  return resolveForkTip({
    startId,
    ids,
    mtimeOf,
    readHead,
    ownedElsewhere: (id) => ownedIds.has(id),
  });
}

test('headStructurallyReferences: matches a structural (non-message) reference', () => {
  const head = modeLine('B') + summaryLine('B', 'A');
  assert.strictEqual(headStructurallyReferences(head, 'A'), true);
});

test('headStructurallyReferences: rejects an id that only appears in message content', () => {
  // deepsteve's own conversations quote session UUIDs in chat text — must NOT count.
  const head = modeLine('B') + assistantMentioning('A');
  assert.strictEqual(headStructurallyReferences(head, 'A'), false);
});

test('headStructurallyReferences: false when the id is absent, and tolerates truncated lines', () => {
  assert.strictEqual(headStructurallyReferences(modeLine('B'), 'A'), false);
  // A truncated/partial final line (no newline, invalid JSON) must be skipped, not throw.
  const head = summaryLine('B', 'A') + '{"type":"file-history-sna'; // cut off mid-write
  assert.strictEqual(headStructurallyReferences(head, 'A'), true);
});

test('resolveForkTip: returns the start id unchanged when nothing chains forward', () => {
  const spec = { A: { mtimeMs: 100, head: modeLine('A') } };
  assert.strictEqual(resolve('A', spec), 'A');
});

test('resolveForkTip: single-hop A→B (the fs.watch detector missed the rotation)', () => {
  const spec = {
    A: { mtimeMs: 100, head: modeLine('A') },
    B: { mtimeMs: 200, head: summaryLine('B', 'A') },
  };
  assert.strictEqual(resolve('A', spec), 'B');
});

test('resolveForkTip: multi-hop A→B→C (the resolver\'s distinctive value)', () => {
  // C references B, NOT A — a single-hop detector stuck at A can never reach it.
  const spec = {
    A: { mtimeMs: 100, head: modeLine('A') },
    B: { mtimeMs: 200, head: summaryLine('B', 'A') },
    C: { mtimeMs: 300, head: summaryLine('C', 'B') },
  };
  assert.strictEqual(resolve('A', spec), 'C');
});

test('resolveForkTip: does NOT walk onto a sibling tab / fork child (#497 ownership)', () => {
  // D structurally references A (e.g. a fork child embeds its parent) but is owned by
  // another tab — resolving onto it would point both tabs at one session (the #497 steal).
  const spec = {
    A: { mtimeMs: 100, head: modeLine('A') },
    D: { mtimeMs: 200, head: summaryLine('D', 'A') },
  };
  assert.strictEqual(resolve('A', spec, new Set(['D'])), 'A');
});

test('resolveForkTip: ignores an older transcript that merely references the id (content, not lineage)', () => {
  // Older-than-parent AND message-content mention — both gates reject it.
  const spec = {
    A: { mtimeMs: 100, head: modeLine('A') },
    Old: { mtimeMs: 50, head: assistantMentioning('A') },
  };
  assert.strictEqual(resolve('A', spec), 'A');
});

test('resolveForkTip: picks the newest among multiple structural descendants', () => {
  const spec = {
    A: { mtimeMs: 100, head: modeLine('A') },
    B: { mtimeMs: 200, head: summaryLine('B', 'A') },
    B2: { mtimeMs: 250, head: summaryLine('B2', 'A') }, // newer sibling rotation off A
  };
  assert.strictEqual(resolve('A', spec), 'B2');
});

test('resolveForkTip: stops (returns start) when the start transcript is absent', () => {
  // No mtime entry for the start id → can't establish a baseline → return it unchanged.
  const spec = { B: { mtimeMs: 200, head: summaryLine('B', 'A') } };
  assert.strictEqual(resolve('A', spec), 'A');
});

test('resolveForkTip: bounded — a reference cycle cannot spin forever', () => {
  // Pathological: X refs Y and Y refs X, both newer than the start. maxHops caps the walk;
  // it must terminate and return one of them, not loop.
  const spec = {
    A: { mtimeMs: 100, head: modeLine('A') },
    X: { mtimeMs: 200, head: summaryLine('X', 'A') + summaryLine('X', 'Y') },
    Y: { mtimeMs: 300, head: summaryLine('Y', 'X') },
  };
  const out = resolve('A', spec);
  assert.ok(out === 'X' || out === 'Y', `terminated at a real id, got ${out}`);
});
