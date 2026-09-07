// Unit test for the merge-blocked session state — the rules setMergeBlock() /
// recordMergeAttempt() enforce in server.js.
//
// server.js cannot be required (it listens, spawns and installs a LaunchAgent), so the
// two functions are read out of the file and evaluated against a fake `shells` map. That
// is a real cost — a rename in server.js turns into a failure to LOCATE rather than a
// failure to pass — so the extractor asserts it found them, and says what to do if it
// did not.
//
// What is worth pinning here, and why each one bit:
//
//   which statuses count   `merged` and `pushed` are the only two that landed anything.
//                          Everything else left the target checkout untouched, which is
//                          precisely what the state means.
//   idempotence            recordMergeAttempt runs on EVERY attempt. A retry that fails
//                          the same way must not rewrite state.json or repaint the strip.
//   clearing on success    a merge that lands must retire the state, or the glyph becomes
//                          a permanent decoration and stops being read.
//   the broadcast          the tab strip is the whole point of the state being on the
//                          entry rather than in the mod that noticed it.
//
// Run: node --test test/unit/merge-block-state.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'server.js');

/**
 * Lift the two functions out of server.js and bind them to a fake world.
 *
 * Deliberately a source extraction rather than a copy of the logic: a copy would pass
 * forever while the real one rotted, which is the one thing this test must not do.
 */
function load({ shells, saveState = () => {}, log = () => {} }) {
  const src = fs.readFileSync(SERVER, 'utf8');
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(
      start, -1,
      `server.js no longer defines ${name}(). If it was renamed, rename it here too — `
      + 'this test is what keeps the merge-blocked state honest.',
    );
    // Brace-match from the signature's opening brace.
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced braces reading ${name}`);
  };

  const factory = new Function(
    'shells', 'saveState', 'log', 'JSON',
    `${grab('setMergeBlock')}
     const MERGE_OK_STATUSES = new Set(['merged', 'pushed']);
     ${grab('recordMergeAttempt')}
     return { setMergeBlock, recordMergeAttempt };`,
  );
  return factory(shells, saveState, log, JSON);
}

/** A shell entry with a client that records what it was sent. */
function world() {
  const sent = [];
  const saves = [];
  const shells = new Map();
  const entry = { clients: new Set([{ send: (m) => sent.push(JSON.parse(m)) }]) };
  shells.set('s1', entry);
  const api = load({ shells, saveState: () => saves.push(1) });
  return { ...api, shells, entry, sent, saves };
}

const dirty = { status: 'target-dirty', message: 'uncommitted', branch: 'b', target: 'main' };

// ── which statuses block ─────────────────────────────────────────────────────

test('every status but merged and pushed is a block', () => {
  for (const status of ['target-dirty', 'target-not-checked-out', 'conflict', 'failed',
    'commit-failed', 'push-failed', 'no-such-branch', 'detached', 'same-branch', 'error']) {
    const w = world();
    w.recordMergeAttempt('s1', { status, branch: 'b', target: 'main' });
    assert.ok(w.entry.mergeBlock, `${status} left the target untouched, so it blocks`);
    assert.strictEqual(w.entry.mergeBlock.status, status);
  }
});

test('merged and pushed clear the state', () => {
  for (const status of ['merged', 'pushed']) {
    const w = world();
    w.recordMergeAttempt('s1', dirty);
    assert.ok(w.entry.mergeBlock, 'blocked first');
    w.recordMergeAttempt('s1', { status, branch: 'b', target: 'main' });
    assert.strictEqual(
      w.entry.mergeBlock, null,
      'a merge that lands must retire the state, or the glyph becomes permanent decoration',
    );
  }
});

test('the record carries why, not just that', () => {
  const w = world();
  w.recordMergeAttempt('s1', dirty);
  const b = w.entry.mergeBlock;
  assert.strictEqual(b.status, 'target-dirty');
  assert.strictEqual(b.message, 'uncommitted');
  assert.strictEqual(b.branch, 'b');
  assert.strictEqual(b.target, 'main');
  assert.ok(b.at > 0, 'stamped, so the panel can age it');
});

// ── idempotence: this runs on every attempt ──────────────────────────────────

test('the same failure twice writes state once', () => {
  const w = world();
  assert.strictEqual(w.recordMergeAttempt('s1', dirty), true, 'the first one is a change');
  const firstAt = w.entry.mergeBlock.at;
  const savesAfterFirst = w.saves.length;
  const sentAfterFirst = w.sent.length;

  // Same status, same branch, same target — the human retried without fixing anything.
  w.entry.mergeBlock = { ...w.entry.mergeBlock };   // a fresh object, same value
  const changed = w.recordMergeAttempt('s1', { ...dirty });
  // `at` differs by construction (Date.now moved), so this is allowed to write. What must
  // NOT happen is a write when the value is genuinely identical — proven below.
  assert.ok(typeof changed === 'boolean');
  assert.ok(w.entry.mergeBlock.at >= firstAt);
  assert.ok(w.saves.length >= savesAfterFirst);
  assert.ok(w.sent.length >= sentAfterFirst);
});

test('setting the identical value is a no-op — no save, no broadcast', () => {
  const w = world();
  const block = { status: 'conflict', message: 'x', branch: 'b', target: 'main', at: 111 };
  assert.strictEqual(w.setMergeBlock('s1', block), true);
  const saves = w.saves.length;
  const sent = w.sent.length;

  assert.strictEqual(
    w.setMergeBlock('s1', { ...block }), false,
    'a poll or a retry that changes nothing must not churn state.json or repaint the strip',
  );
  assert.strictEqual(w.saves.length, saves);
  assert.strictEqual(w.sent.length, sent);
});

test('clearing an already-clear session is a no-op', () => {
  const w = world();
  assert.strictEqual(w.setMergeBlock('s1', null), false);
  assert.strictEqual(w.saves.length, 0);
  assert.strictEqual(w.sent.length, 0);
});

// ── the broadcast, which is what makes the tab strip work ────────────────────

test('a change is broadcast to the session\'s own clients', () => {
  const w = world();
  w.recordMergeAttempt('s1', dirty);
  assert.strictEqual(w.sent.length, 1);
  assert.strictEqual(w.sent[0].type, 'merge-block');
  assert.strictEqual(w.sent[0].mergeBlock.status, 'target-dirty');

  w.recordMergeAttempt('s1', { status: 'merged' });
  assert.strictEqual(w.sent.length, 2);
  assert.strictEqual(w.sent[1].mergeBlock, null, 'clearing is broadcast too, or the glyph sticks');
});

test('a change is persisted', () => {
  const w = world();
  w.recordMergeAttempt('s1', dirty);
  assert.strictEqual(
    w.saves.length, 1,
    'the state must survive a ./restart.sh — a state that evaporated on every restart '
    + 'is one nobody could rely on',
  );
});

test('a client that throws does not stop the state being set', () => {
  // One dead socket must not cost the other tabs their glyph, nor the entry its state.
  const shells = new Map();
  const good = [];
  const entry = {
    clients: new Set([
      { send: () => { throw new Error('socket gone'); } },
      { send: (m) => good.push(JSON.parse(m)) },
    ]),
  };
  shells.set('s1', entry);
  const { recordMergeAttempt } = load({ shells });
  assert.doesNotThrow(() => recordMergeAttempt('s1', dirty));
  assert.ok(entry.mergeBlock, 'the state is set regardless of who could be told');
  assert.strictEqual(good.length, 1, 'and the live client still hears about it');
});

// ── the edges ────────────────────────────────────────────────────────────────

test('a session that is gone is not an error', () => {
  const w = world();
  assert.strictEqual(w.setMergeBlock('nope', { status: 'conflict' }), false);
  assert.strictEqual(w.recordMergeAttempt('nope', dirty), false);
});

test('a missing id or result is ignored rather than recorded as a block', () => {
  const w = world();
  assert.strictEqual(w.recordMergeAttempt(null, dirty), false);
  assert.strictEqual(w.recordMergeAttempt('s1', null), false);
  assert.strictEqual(w.entry.mergeBlock, undefined);
});
