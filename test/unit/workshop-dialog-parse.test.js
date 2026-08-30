// Unit test for mods/workshop/dialog-parse.js — reading what a blocked session is
// actually asking (#660).
//
// Why this file exists, and why it is the first thing built for Workshop: the whole
// value of the inbox over Action Required is showing the QUESTION rather than the tab
// name, and a parser that quietly returns null degrades to exactly Action Required
// with more scrolling. That failure is invisible — the rows still appear, they just
// say nothing useful — so it has to be pinned against real captures rather than
// noticed later.
//
// Two contracts are pinned separately, because collapsing them breaks the inbox:
//
//   detectDialog() is the MEMBERSHIP gate. sessionInputState() maps 'waiting' to
//   'idle', and 'waiting' covers both a permission dialog AND an empty composer, so
//   without a positive dialog signal every agent that finished its turn becomes a row.
//   Hence the sweep over every composer fixture below: those are all "idle", and none
//   of them may read as a dialog.
//
//   parseDialog() is the READ. null there means "a dialog is up but unreadable", which
//   is the raw-preview fallback — a different outcome from "no dialog".
//
// Fixtures are real captures. PERMISSION_MENU / SELECTION_MENU come from
// composer-screens.js (transcribed from live sessions for #607); PERMISSION_WRAPPED in
// workshop-dialogs.js is the #568 capture, and is the case the issue's own stated
// algorithm gets wrong.
//
// Pure module import — no DOM, no daemon, no PTY — so it runs in the bare `unit` CI
// job, which has no zsh and installs with --ignore-scripts.
//
// Run: node --test test/unit/workshop-dialog-parse.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const dp = require('../../mods/workshop/dialog-parse.js');
const composer = require('./fixtures/composer-screens.js');
const fx = require('./fixtures/workshop-dialogs.js');

// Every screen in composer-screens.js that is NOT a dialog. These are the exact
// shapes a healthy idle or working session shows, and every one of them is
// waitingForInput-or-thereabouts, so each is a chance to put a junk row in the inbox.
const NON_DIALOG_FIXTURES = [
  'EMPTY_COMPOSER',
  'PLACEHOLDER_COMPOSER',
  'STAGED_DRAFT',
  'STAGED_WRAPPED',
  'STAGED_MULTILINE',
  'STAGED_COMPLETE',
  'STAGED_PARTIAL',
  'SUBMITTED_TRANSCRIPT_ECHO',
  'PASTE_COLLAPSED',
  'PASTE_COLLAPSED_MATCHING',
  'PASTE_COLLAPSED_SHORT',
  'PASTE_COLLAPSED_NO_COUNT',
  'BOXED_COMPOSER',
  'STARTUP_BANNER',
  'WORKING_NO_COMPOSER',
];

test('the fixtures this file depends on are actually present', () => {
  // Without this, a rename in composer-screens.js turns the sweep below into a
  // vacuous pass over a list of undefineds (the compose-projects.test.js lesson).
  for (const name of ['PERMISSION_MENU', 'SELECTION_MENU', ...NON_DIALOG_FIXTURES]) {
    assert.ok(
      Array.isArray(composer[name]),
      `test/unit/fixtures/composer-screens.js no longer exports ${name} as an array — `
      + 'update NON_DIALOG_FIXTURES rather than letting the sweep go vacuous',
    );
  }
  assert.ok(NON_DIALOG_FIXTURES.length >= 15, 'the non-dialog sweep lost fixtures');
});

// ── The two real captures ────────────────────────────────────────────────────

test('a real permission dialog parses, and its headline is the tool line', () => {
  const p = dp.parseDialog(composer.PERMISSION_MENU);
  assert.ok(p, 'PERMISSION_MENU must parse');
  assert.strictEqual(p.kind, 'permission');
  assert.strictEqual(p.question, 'Do you want to proceed?');
  assert.strictEqual(p.options.length, 3);
  assert.strictEqual(p.options[0].label, 'Yes');
  assert.strictEqual(p.options[2].label, 'No');
  assert.strictEqual(p.cursorIndex, 0);
  // The whole point of carrying context: "Do you want to proceed?" is identical
  // across every session and every tool, so it cannot be the subject of a row.
  assert.strictEqual(
    p.headline,
    'deepsteve - read_session_screen (MCP)',
    'a permission dialog must be headlined by the tool banner above the question, '
    + 'or eight identical "Do you want to proceed?" rows is the whole inbox',
  );
});

test('a real AskUserQuestion parses, cursor glyph with no space after it', () => {
  // `❯1. Uniform` — no space. Requiring one silently drops every AskUserQuestion.
  const p = dp.parseDialog(composer.SELECTION_MENU);
  assert.ok(p, 'SELECTION_MENU must parse');
  assert.strictEqual(p.kind, 'question');
  assert.strictEqual(p.question, 'How wide should the shared-jump wiring be?');
  assert.strictEqual(p.headline, p.question);
  assert.deepStrictEqual(
    p.options.map((o) => o.label),
    ['Uniform (recommended)', 'Minimal', 'Type something.'],
  );
  assert.strictEqual(p.cursorIndex, 0);
});

// ── The case the issue's stated algorithm gets wrong ─────────────────────────

test('a wrapped option folds into its own label (#568 capture)', () => {
  const p = dp.parseDialog(fx.PERMISSION_WRAPPED);
  assert.ok(
    p,
    'the #568 capture must parse. The issue specifies "the trailing run of lines '
    + 'matching the option regex", but option 2 wraps here, so the trailing run is '
    + '`3. No` alone — one option, unparseable, and EVERY deepsteve MCP permission '
    + 'prompt falls back to a raw preview. Anchor on the contiguous descending run '
    + 'down to `1.` and fold non-numbered rows in as continuations.',
  );
  assert.strictEqual(p.options.length, 3);
  assert.match(p.options[1].label, /don't ask again/);
  assert.match(p.options[1].label, /github-issue-568$/, 'the wrapped path must be folded in');
  assert.strictEqual(p.options[2].label, 'No');
  assert.strictEqual(p.cursorIndex, 0);
});

// ── Cursor position: load-bearing for relative movement ──────────────────────

test('the cursor is located, wherever it sits', () => {
  assert.strictEqual(dp.parseDialog(fx.PERMISSION_CURSOR_MID).cursorIndex, 1);
  assert.strictEqual(dp.parseDialog(fx.PERMISSION_CURSOR_LAST).cursorIndex, 2);
});

test('no cursor glyph means null, never a guess', () => {
  const p = dp.parseDialog(fx.PERMISSION_NO_CURSOR);
  assert.ok(p, 'the options still parse');
  assert.strictEqual(p.options.length, 2);
  assert.strictEqual(
    p.cursorIndex, null,
    'the AskUserQuestion cursor is sometimes reverse video, and linesSync() returns '
    + 'text with no attributes. Assuming "probably option 1" costs a wrong button '
    + 'press in a live session — refuse instead.',
  );
});

test('two cursor glyphs means null AND no option left flagged', () => {
  const p = dp.parseDialog(fx.PERMISSION_TWO_CURSORS);
  assert.ok(p);
  assert.strictEqual(p.cursorIndex, null);
  assert.deepStrictEqual(
    p.options.map((o) => o.selected), [false, false],
    'a half-repainted frame must not leave a stale `selected` that renders as a '
    + 'confident answer',
  );
});

// ── detectDialog vs parseDialog: the two-contract split ──────────────────────

test('one option: detected as blocked, but unreadable', () => {
  assert.ok(
    dp.detectDialog(fx.SINGLE_OPTION),
    'a dialog whose options are partly off-screen is still a blocked session — '
    + 'dropping the row loses it entirely',
  );
  assert.strictEqual(
    dp.parseDialog(fx.SINGLE_OPTION), null,
    'but it must not render as buttons; null is the raw-preview fallback',
  );
});

test('a resolved dialog is not detected, even with its rows still on screen', () => {
  // Acceptance criterion: "a dialog that resolves itself in the terminal disappears
  // from the inbox on the next poll with no leftover row." A composer painted below
  // the footer is the structural proof, and it is checkable with no daemon.
  assert.strictEqual(dp.detectDialog(fx.RESOLVED_DIALOG), null);
  assert.strictEqual(dp.parseDialog(fx.RESOLVED_DIALOG), null);
});

test('every non-dialog screen is rejected by BOTH entry points', () => {
  for (const name of NON_DIALOG_FIXTURES) {
    const lines = composer[name];
    assert.strictEqual(
      dp.detectDialog(lines), null,
      `${name} read as a dialog. Every one of these is an idle-or-working session, `
      + 'and sessionInputState() calls them "idle" just like a real dialog — so a '
      + 'false positive here puts every agent that finished its turn in the inbox.\n'
      + `--- ${name} ---\n${lines.join('\n')}\n---`,
    );
    assert.strictEqual(dp.parseDialog(lines), null, `${name} parsed as a dialog`);
  }
});

// ── Robustness of the option run ─────────────────────────────────────────────

test('a stray numbered line above does not extend the run', () => {
  const p = dp.parseDialog(fx.STRAY_NUMBER_ABOVE);
  assert.ok(p);
  assert.strictEqual(p.options.length, 3, 'the transcript "2. Minimal rewiring" is not an option');
  assert.strictEqual(p.question, 'How wide should the shared-jump wiring be?');
});

test('a label containing its own "N." does not corrupt numbering', () => {
  const p = dp.parseDialog(fx.LABEL_WITH_NUMBER);
  assert.ok(p);
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2]);
  assert.strictEqual(p.options[0].label, 'Retry 3. times, then give up');
});

test('box-drawing borders come off the labels and the question', () => {
  const p = dp.parseDialog(fx.BOXED_DIALOG);
  assert.ok(p);
  assert.strictEqual(p.question, 'Do you want to proceed?');
  assert.deepStrictEqual(p.options.map((o) => o.label), ['Yes', 'No']);
  assert.strictEqual(p.cursorIndex, 0);
});

test('nine options parse in order', () => {
  const p = dp.parseDialog(fx.NINE_OPTIONS);
  assert.ok(p);
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.strictEqual(p.options[8].label, 'india');
});

// ── Multi-question AskUserQuestion ───────────────────────────────────────────

test('a multi-question tab strip is reported, without an index', () => {
  const p = dp.parseDialog(fx.MULTI_QUESTION);
  assert.ok(p);
  assert.ok(p.multi, 'the tab strip must be noticed');
  assert.strictEqual(p.multi.count, 3);
  assert.deepStrictEqual(p.multi.labels, ['Wiring scope', 'Notify on click', 'Submit']);
  assert.strictEqual(
    p.multi.current, undefined,
    'which tab is current is conveyed by HIGHLIGHT, which linesSync cannot see — '
    + 'do not invent an index',
  );
  assert.strictEqual(p.question, 'How wide should the shared-jump wiring be?');
});

test('the footer alone reports multi-question with an unknown count', () => {
  const p = dp.parseDialog(fx.MULTI_FOOTER_ONLY);
  assert.ok(p);
  assert.deepStrictEqual(p.multi, { count: null, labels: [] });
});

// ── Garbage in ───────────────────────────────────────────────────────────────

test('malformed input returns null and never throws', () => {
  for (const bad of [null, undefined, [], '', 0, {}, [''], ['', '', ''], [null, undefined]]) {
    assert.strictEqual(dp.detectDialog(bad), null, `detectDialog(${JSON.stringify(bad)})`);
    assert.strictEqual(dp.parseDialog(bad), null, `parseDialog(${JSON.stringify(bad)})`);
  }
});

test('a huge screen is bounded, not walked end to end', () => {
  const huge = new Array(5000).fill('filler line');
  assert.strictEqual(dp.parseDialog(huge), null);
  // The real dialog at the bottom still parses through 5000 rows of noise.
  const buried = [...huge, ...composer.PERMISSION_MENU];
  const p = dp.parseDialog(buried);
  assert.ok(p, 'a dialog at the bottom of a long scrollback must still be read');
  assert.strictEqual(p.options.length, 3);
});

// ── fingerprint(): one normalization, both sides of the verify step ──────────

test('fingerprint is stable across whitespace and case', () => {
  assert.strictEqual(dp.fingerprint('  Yes,   and   don\'t ask '), dp.fingerprint("Yes, and don't ask"));
  assert.strictEqual(dp.fingerprint('YES'), dp.fingerprint('yes'));
  assert.notStrictEqual(dp.fingerprint('Yes'), dp.fingerprint('No'));
  assert.strictEqual(dp.fingerprint(null), '');
  assert.strictEqual(dp.fingerprint(undefined), '');
});

test('fingerprint is bounded, so a pasted essay of a label still compares', () => {
  const long = 'x'.repeat(500);
  assert.strictEqual(dp.fingerprint(long).length, 60);
});

// ── dialogFingerprint: "is this the same question?" (#663) ───────────────────
//
// It answers two questions that both go wrong quietly. A fingerprint that churns
// restarts a blocked row's age on every repaint and un-mutes a row you dismissed a
// second ago; one that collides silences a dialog you have never seen. Neither shows
// up as an error anywhere, so both are pinned here.

test('the same dialog with the cursor somewhere else is the same question', () => {
  assert.strictEqual(
    dp.dialogFingerprint(fx.PERMISSION_CURSOR_MID),
    dp.dialogFingerprint(fx.PERMISSION_CURSOR_LAST),
    'arrowing between options is navigation, not a new question',
  );
});

test('a different dialog fingerprints differently', () => {
  assert.notStrictEqual(
    dp.dialogFingerprint(fx.PERMISSION_CURSOR_MID),
    dp.dialogFingerprint(fx.PERMISSION_WRAPPED),
  );
  assert.notStrictEqual(
    dp.dialogFingerprint(fx.NINE_OPTIONS),
    dp.dialogFingerprint(fx.SINGLE_OPTION),
  );
});

test('no dialog on screen has no fingerprint', () => {
  assert.strictEqual(dp.dialogFingerprint(fx.RESOLVED_DIALOG), '');
  assert.strictEqual(dp.dialogFingerprint([]), '');
  assert.strictEqual(dp.dialogFingerprint(null), '');
  for (const name of NON_DIALOG_FIXTURES) {
    assert.strictEqual(dp.dialogFingerprint(composer[name]), '', `${name} is not a dialog`);
  }
});

test('an unreadable dialog still fingerprints, and two of them do not collide', () => {
  // The case the whole thing exists for: parseDialog gives up, so there is no question
  // string to hash. Falling back to '' would make every unreadable dialog on the
  // machine one identity — one dismissal silencing all of them.
  assert.strictEqual(dp.parseDialog(fx.RULED_OPTION_RUN), null, 'this capture is unreadable');
  const a = dp.dialogFingerprint(fx.RULED_OPTION_RUN);
  assert.ok(a, 'an unreadable dialog is still identifiable');

  const other = fx.RULED_OPTION_RUN.map(
    (l) => (l.startsWith('❯ 1.') ? '❯ 1. Something else entirely' : l),
  );
  assert.notStrictEqual(dp.dialogFingerprint(other), a);
});

test('a 30-row read and a 60-row read of one screen agree', () => {
  // scrapeFor widens its window when a dialog is detected but not parsed. The two
  // reads must not be two different questions, or widening alone would un-mute a row.
  const padded = [...Array(40).fill('  older transcript'), ...fx.PERMISSION_WRAPPED];
  const narrow = padded.slice(-30);
  const wide = padded.slice(-60);
  assert.strictEqual(dp.dialogFingerprint(narrow), dp.dialogFingerprint(wide));
});

test('advancing a multi-question strip is a new question', () => {
  const next = fx.MULTI_QUESTION.map(
    (l) => (l.includes('☐ Wiring scope') ? l.replace('☐ Wiring scope', '✔ Wiring scope') : l),
  );
  assert.notStrictEqual(
    dp.dialogFingerprint(next),
    dp.dialogFingerprint(fx.MULTI_QUESTION),
    'answering one sub-question puts a different question on screen',
  );
});
