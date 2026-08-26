// #656 — the transcript oracle. Did the agent record what we wrote?
//
// The two production incidents this module exists for both lost a contiguous run of
// ~2030 characters off the HEAD of a ~2.4KB prompt and kept a sub-1KB tail, and both
// were logged as clean deliveries because every screen-side check compares only the
// first 40 characters. The fixtures below are shaped from those exact incidents.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readRecentUserMessages, readLastUserMessage, compareDelivered, MAX_CANDIDATES,
} = require('../../prompt-delivery-check');

// A prompt shaped like a real issue prompt: distinctive head, distinctive tail.
const PROMPT = [
  'I need you to work on GitHub issue #656: "Injected issue prompt arrives truncated"',
  'Labels: none',
  '',
  'Issue description:',
  'x'.repeat(2000),
  '',
  'When the work is done, call the `mcp__deepsteve__issue_complete` tool.',
].join('\n');

// What shell 4389fe27's agent actually received: the tail, starting mid-word.
const TAIL_ONLY = PROMPT.slice(-416);

function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
function userRec(text, extra = {}) {
  return { type: 'user', message: { role: 'user', content: text }, ...extra };
}
function withTranscript(records, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-delivery-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl(records));
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- compareDelivered -------------------------------------------------------

test('a whole delivery compares clean', () => {
  const v = compareDelivered(PROMPT, [PROMPT]);
  assert.deepStrictEqual(
    { ok: v.ok, known: v.known, missingHead: v.missingHead, missingTail: v.missingTail },
    { ok: true, known: true, missingHead: false, missingTail: false });
  assert.strictEqual(v.got, v.expected);
});

test('a lost HEAD is caught — the production signature', () => {
  const v = compareDelivered(PROMPT, [TAIL_ONLY]);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.known, true, 'a matching tail is enough to know this is our message');
  assert.strictEqual(v.missingHead, true);
  assert.strictEqual(v.missingTail, false);
  assert.ok(v.got < v.expected / 2, `expected a fragment, got ${v.got}/${v.expected}`);
});

test('a lost TAIL is caught too', () => {
  const v = compareDelivered(PROMPT, [PROMPT.slice(0, 500)]);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.missingHead, false);
  assert.strictEqual(v.missingTail, true);
});

test('an unrelated message is "don\'t know", never a truncation report', () => {
  // The #607 rule: silence and ambiguity must never be reported as failure. A stale
  // record from an earlier turn is exactly that.
  const v = compareDelivered(PROMPT, ['what does this function do?', 'thanks']);
  assert.strictEqual(v.known, false);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.missingHead, false, 'no claim is made about an unrelated record');
});

test('nothing recorded yet is "don\'t know", not a failure', () => {
  assert.strictEqual(compareDelivered(PROMPT, []).known, false);
  assert.strictEqual(compareDelivered(PROMPT, null).known, false);
});

test('the newest matching record wins, older ones are skipped', () => {
  // Newest-first, and the first entry is an unrelated later turn.
  const v = compareDelivered(PROMPT, ['a follow-up question', PROMPT]);
  assert.strictEqual(v.ok, true);
});

test('whitespace re-wrapping does not read as truncation', () => {
  // A composer hard-wraps; Claude may normalise. The comparison is on collapsed
  // whitespace precisely so a re-wrap is not mistaken for lost characters.
  const rewrapped = PROMPT.replace(/\n/g, '\n  ');
  assert.strictEqual(compareDelivered(PROMPT, [rewrapped]).ok, true);
});

// --- readRecentUserMessages -------------------------------------------------

test('tool_result records carry no text and are skipped', () => {
  withTranscript([
    userRec(PROMPT),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ], (file) => {
    assert.strictEqual(readLastUserMessage(file), PROMPT);
  });
});

test('slash-command and bash plumbing records are skipped', () => {
  // 149 of 274 text-bearing user records on a real machine were one of these. If any
  // counted as "what the agent received", every session that had ever run a slash
  // command would report a false truncation.
  withTranscript([
    userRec(PROMPT),
    userRec('<command-name>/rc</command-name>'),
    userRec('<local-command-stdout>Remote Control enabled</local-command-stdout>'),
    userRec('<bash-input>npm test</bash-input>'),
    userRec('[Request interrupted by user for tool use]'),
  ], (file) => {
    assert.strictEqual(readLastUserMessage(file), PROMPT);
    assert.strictEqual(compareDelivered(PROMPT, readRecentUserMessages(file)).ok, true);
  });
});

test('isMeta and isSidechain records are skipped', () => {
  withTranscript([
    userRec(PROMPT),
    userRec('a skill body injected as meta', { isMeta: true }),
    userRec('a subagent turn', { isSidechain: true }),
  ], (file) => {
    assert.strictEqual(readLastUserMessage(file), PROMPT);
  });
});

test('a truncated arrival on disk is reported as missing the head', () => {
  withTranscript([userRec(TAIL_ONLY)], (file) => {
    const v = compareDelivered(PROMPT, readRecentUserMessages(file));
    assert.strictEqual(v.known, true);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.missingHead, true);
  });
});

test('a missing or empty transcript yields no candidates, never a throw', () => {
  assert.deepStrictEqual(readRecentUserMessages('/nope/does/not/exist.jsonl'), []);
  assert.strictEqual(readLastUserMessage('/nope/does/not/exist.jsonl'), null);
  withTranscript([], (file) => {
    fs.writeFileSync(file, '');
    assert.deepStrictEqual(readRecentUserMessages(file), []);
  });
});

test('a corrupt line does not abort the scan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-delivery-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, jsonl([userRec(PROMPT)]) + '{not json\n');
    assert.strictEqual(readLastUserMessage(file), PROMPT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the candidate walk is bounded', () => {
  withTranscript(
    Array.from({ length: MAX_CANDIDATES + 20 }, (_, i) => userRec(`msg ${i}`)),
    (file) => {
      assert.strictEqual(readRecentUserMessages(file).length, MAX_CANDIDATES);
    });
});
