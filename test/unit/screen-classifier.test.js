// Unit test for the pure screen-state detector in screen-classifier.js (#568).
//
// The detector replaces the BEL-gated classifier #558 proved inadequate. Its whole
// value is deciding "working / waiting / unknown" from a rendered screen tail plus
// spinner recency, robustly against the overlapping-frame concatenation the server
// has to work with (no terminal emulator). This locks that behavior against
// fixtures of REAL captured tails, with no daemon — the fast loop for tuning the
// markers and the SPINNER_MAX_QUIET_MS threshold.
//
// Run: node --test test/unit/screen-classifier.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyScreenTail, CLAUDE_SCREEN_MARKERS, SPINNER_MAX_QUIET_MS } = require('../../screen-classifier.js');
const { NOW, fixtures } = require('./fixtures/screen-tails.js');

const classify = (o) => classifyScreenTail({ now: NOW, markers: CLAUDE_SCREEN_MARKERS, ...o });

test('classifies every captured/synthetic screen tail as expected', () => {
  for (const f of fixtures) {
    const got = classify({ tail: f.tail, lastSpinnerTime: f.lastSpinnerTime });
    assert.strictEqual(got, f.expect, `${f.name}\n--- tail ---\n${f.tail}\n---`);
  }
});

test('an agent with no marker set is always unknown', () => {
  assert.strictEqual(
    classifyScreenTail({ tail: 'Do you want to proceed? ⏵⏵ auto mode on', now: NOW, markers: undefined }),
    'unknown',
    'no markers → unknown regardless of tail content (terminal/pi/…)',
  );
});

test('spinner recency short-circuits before any marker scan', () => {
  // A permission dialog on screen but a spinner frame just arrived: the turn is
  // still running (the dialog is being drawn), so "working" wins. This is what
  // stops a long tool call (#500) from ever reading as "waiting".
  const tail = 'Do you want to proceed?\nEsc to cancel · Tab to amend';
  assert.strictEqual(classify({ tail, lastSpinnerTime: NOW - 100 }), 'working');
  assert.strictEqual(classify({ tail, lastSpinnerTime: NOW - (SPINNER_MAX_QUIET_MS + 1) }), 'waiting');
});

test('a stale esc-to-interrupt left in the tail cannot fake working', () => {
  // Presence of the spinner phrase in the tail is irrelevant — only lastSpinnerTime
  // (refreshed solely by spinner-bearing chunks) decides "working". With a stale
  // timestamp and an idle footer painted after it, the answer is "waiting".
  const tail = '✻ Working… (esc to interrupt · 9s)\n⏺ Done.\n⏵⏵ auto mode on';
  assert.strictEqual(classify({ tail, lastSpinnerTime: NOW - 30_000 }), 'waiting');
  assert.strictEqual(classify({ tail, lastSpinnerTime: undefined }), 'waiting');
});

test('permission dialog beats a bare idle footer in the same tail', () => {
  // Both a permission dialog and the mode footer can appear in the tail (the
  // dialog is drawn over the composer). Permission (blocking) is still "waiting",
  // and the classification order does not matter since both map to waiting.
  const tail = '⏵⏵ auto mode on\nDo you want to proceed?\nEsc to cancel · Tab to amend';
  assert.strictEqual(classify({ tail, lastSpinnerTime: undefined }), 'waiting');
});

test('markers cover the real permission and idle-footer phrasings', () => {
  // Guard the exact strings the detector keys on, transcribed from live captures.
  assert.match('Do you want to proceed?', CLAUDE_SCREEN_MARKERS.permission[0]);
  assert.ok(CLAUDE_SCREEN_MARKERS.permission.some((re) => re.test('Esc to cancel · Tab to amend')));
  assert.ok(CLAUDE_SCREEN_MARKERS.atPrompt.some((re) => re.test('⏵⏵ auto mode on (shift+tab to cycle)')));
  assert.ok(CLAUDE_SCREEN_MARKERS.atPrompt.some((re) => re.test('? for shortcuts')));
  assert.match('✻ Working… (esc to interrupt · 8s)', CLAUDE_SCREEN_MARKERS.spinner);
  // The completed-turn line is NOT a spinner (no interrupt hint) — this is what
  // distinguishes an active spinner from a finished one.
  assert.doesNotMatch('✻ Sautéed for 42s', CLAUDE_SCREEN_MARKERS.spinner);
});
