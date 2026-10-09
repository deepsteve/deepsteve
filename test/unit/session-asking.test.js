// Unit test for askingSummary() in dialog-parse.js — the daemon's "asking" signal.
//
// The waiting flag is true for an agent that finished its turn AND for one showing a
// dialog, so a notification built on it alone could only ever say "waiting for input".
// askingSummary() is the second look that tells the two apart. What is pinned here:
//
//   - an idle composer is NOT asking, whatever else is on screen, so a finished turn can
//     never be announced as a question;
//   - a question carries the question, and a permission dialog carries the tool line
//     rather than the "Do you want to proceed?" every one of them shares;
//   - the fingerprint survives moving the cursor and changes with the question, which is
//     what lets the daemon send an update only when there is something new to say.
//
// Pure module import, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/session-asking.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { askingSummary, detectDialog } = require('../../dialog-parse.js');
const composer = require('./fixtures/composer-screens.js');
const fx = require('./fixtures/inbox-dialogs.js');

const RULE = '─'.repeat(60);

// What the shipped plan step draws: the plan as a message, then one AskUserQuestion with
// Begin / Revise. Shaped like the real single-question capture SELECTION_MENU, with the
// escape hatches current Claude Code adds below a rule.
function planQuestion(cursor = 1, question = 'Begin with this plan?') {
  const row = (n, label) => `${n === cursor ? '❯' : ' '} ${n}. ${label}`;
  return [
    '⏺ Plan: add the asking flag to the state message, then the tab mark.',
    question,
    row(1, 'Begin'),
    row(2, 'Revise'),
    row(3, 'Type something.'),
    RULE,
    row(4, 'Chat about this'),
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ];
}

test('a finished turn is not asking: every idle and working screen reads null', () => {
  const notDialogs = Object.entries(composer)
    .filter(([name, v]) => Array.isArray(v) && !/MENU/.test(name));
  assert.ok(notDialogs.length >= 10, 'the composer fixtures went missing');
  for (const [name, lines] of notDialogs) {
    assert.equal(askingSummary(lines), null, `${name} must not read as asking`);
  }
  // A dialog that has resolved, with the transcript and composer repainted under it.
  assert.equal(askingSummary(fx.RESOLVED_DIALOG), null);
  assert.equal(askingSummary([]), null);
  assert.equal(askingSummary(null), null);
});

test('the plan question reads as a question, and carries the question', () => {
  const a = askingSummary(planQuestion());
  assert.deepStrictEqual({ kind: a.kind, text: a.text }, { kind: 'question', text: 'Begin with this plan?' });
  assert.ok(a.fp.startsWith('question:'));
});

test('a permission dialog carries the tool line, not "Do you want to proceed?"', () => {
  assert.deepStrictEqual(
    (({ kind, text }) => ({ kind, text }))(askingSummary(fx.PERMISSION_CURSOR_MID)),
    { kind: 'permission', text: 'Bash(rm -rf node_modules)' },
  );
  assert.equal(askingSummary(composer.PERMISSION_MENU).text, 'deepsteve - read_session_screen (MCP)');
});

test('real AskUserQuestion captures read as questions with their question text', () => {
  assert.equal(askingSummary(composer.SELECTION_MENU).text, 'How wide should the shared-jump wiring be?');
  assert.equal(askingSummary(fx.MULTI_QUESTION).text, 'How wide should the shared-jump wiring be?');
  const ruled = askingSummary(fx.RULED_OPTION_RUN);
  assert.equal(ruled.kind, 'question');
  assert.match(ruled.text, /^Who gets the quiet-mode toggle\?/);
});

test('moving the cursor is the same question; a different question is a new one', () => {
  const first = askingSummary(planQuestion(1));
  assert.equal(askingSummary(planQuestion(2)).fp, first.fp);
  assert.notEqual(askingSummary(planQuestion(1, 'Begin with the revised plan?')).fp, first.fp);
  // Same for a permission dialog: the cursor on option 2 or option 3 is one question.
  assert.equal(askingSummary(fx.PERMISSION_CURSOR_MID).fp, askingSummary(fx.PERMISSION_CURSOR_LAST).fp);
});

test('an unreadable dialog is still asking, with empty text rather than a guess', () => {
  // Both are detected — a footer and an option — but parseDialog cannot walk their option
  // run. The tab still needs its mark: something IS waiting on a decision.
  for (const lines of [fx.SINGLE_OPTION, fx.RULE_BREAKS_RUN]) {
    assert.ok(detectDialog(lines));
    const a = askingSummary(lines);
    assert.equal(a.text, '');
    assert.ok(a.fp, 'an unreadable dialog still has an identity');
  }
});

test('the plan-approval gate counts as asking too', () => {
  assert.match(askingSummary(fx.PLAN_APPROVAL).text, /ready to execute/);
  assert.equal(askingSummary(fx.PLAN_PATH_IN_PROSE), null);
});

test('the text is bounded, one line, and says when it was cut', () => {
  const long = 'Should we ' + 'really '.repeat(60) + 'begin?';
  const a = askingSummary(planQuestion(1, long));
  assert.ok(a.text.length <= 200, `${a.text.length} characters`);
  assert.ok(a.text.endsWith('…'));
  assert.ok(!a.text.includes('\n'));
});
