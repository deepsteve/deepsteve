// #607 — the composer reader that decides whether a prompt is still sitting unsent.
//
// This is the piece the verify-and-retry safety net rests on, and the one place a
// mistake turns into a DOUBLE SUBMIT on every prompt (a naive substring test over
// the whole screen matches the transcript echo of a perfectly successful submit).
const { test } = require('node:test');
const assert = require('node:assert');

const { readComposerDraft, isPromptStaged, promptDraftVerdict } = require('../../composer-state');
const F = require('./fixtures/composer-screens');

// The text the STAGED_*/PASTE_* fixtures are renderings of. #656's completeness
// checks compare against what we wrote, so the two must not drift.
const ISSUE_PROMPT = F.DELIVERED_PROMPT;

// --- readComposerDraft -----------------------------------------------------

test('an empty composer reads as an empty draft, not as unknown', () => {
  assert.strictEqual(readComposerDraft(F.EMPTY_COMPOSER), '');
});

test('the rotating placeholder hint is not a draft', () => {
  assert.strictEqual(readComposerDraft(F.PLACEHOLDER_COMPOSER), '');
});

test('a half-typed draft is read back verbatim', () => {
  assert.strictEqual(readComposerDraft(F.STAGED_DRAFT), 'can you also check the other');
});

test('a hard-wrapped draft is joined across rows inside the box', () => {
  assert.strictEqual(
    readComposerDraft(F.STAGED_WRAPPED),
    'Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs',
  );
});

test('a multi-line draft with the glyph repeated on every row is joined from the top', () => {
  // Reading only the LAST glyph row would give the prompt's closing sentence, which
  // matches nothing we sent — a staged prompt read as delivered.
  assert.strictEqual(
    readComposerDraft(F.STAGED_MULTILINE),
    'Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs'
    + ' ## Summary A new issue tab does not always send its pre-populated prompt.',
  );
});

test('side borders and the > glyph are handled', () => {
  assert.strictEqual(readComposerDraft(F.BOXED_COMPOSER), 'fix issue #607 please');
});

test('a collapsed paste is a draft', () => {
  assert.strictEqual(readComposerDraft(F.PASTE_COLLAPSED), '[Pasted text #1 +42 lines]');
});

test('a permission-dialog cursor is not a composer', () => {
  assert.strictEqual(readComposerDraft(F.PERMISSION_MENU), null);
});

test('an AskUserQuestion cursor is not a composer', () => {
  assert.strictEqual(readComposerDraft(F.SELECTION_MENU), null);
});

test('a startup banner reads as unknown, never as empty', () => {
  assert.strictEqual(readComposerDraft(F.STARTUP_BANNER), null);
});

test('a frame with no composer at all reads as unknown', () => {
  assert.strictEqual(readComposerDraft(F.WORKING_NO_COMPOSER), null);
});

test('degenerate inputs read as unknown', () => {
  assert.strictEqual(readComposerDraft([]), null);
  assert.strictEqual(readComposerDraft(null), null);
  assert.strictEqual(readComposerDraft(undefined), null);
});

test('a bare composer row with no surrounding rules still reads as empty', () => {
  // Real capture shape (AGENTS_HINT_IDLE_TAIL): no box rules, footer directly below.
  assert.strictEqual(readComposerDraft(['⏺ Clean tree, 8 ahead of origin.', '❯', '← for agents']), '');
});

test('footer text below an unbounded composer is not swallowed into the draft', () => {
  const draft = readComposerDraft(['❯ hello there', '⏵⏵ auto mode on (shift+tab to cycle)']);
  assert.strictEqual(draft, 'hello there');
});

// --- isPromptStaged --------------------------------------------------------

test('THE DOUBLE-SUBMIT GUARD: a submitted prompt echoed in the transcript is not staged', () => {
  // The prompt text is plainly visible on this screen. Only the composer counts.
  assert.ok(F.SUBMITTED_TRANSCRIPT_ECHO.join('\n').includes('Work on GitHub issue #607'));
  assert.strictEqual(isPromptStaged(F.SUBMITTED_TRANSCRIPT_ECHO, ISSUE_PROMPT), false);
});

test('a wrapped copy of our prompt in the composer is staged', () => {
  assert.strictEqual(isPromptStaged(F.STAGED_WRAPPED, ISSUE_PROMPT), true);
});

test('a multi-line copy of our prompt in the composer is staged', () => {
  assert.strictEqual(isPromptStaged(F.STAGED_MULTILINE, ISSUE_PROMPT), true);
});

test('a collapsed paste is staged even though none of our characters echo', () => {
  assert.ok(!F.PASTE_COLLAPSED.join('\n').includes('start_issue'));
  assert.strictEqual(isPromptStaged(F.PASTE_COLLAPSED, ISSUE_PROMPT), true);
});

test("someone else's draft is not our prompt", () => {
  assert.strictEqual(isPromptStaged(F.STAGED_DRAFT, ISSUE_PROMPT), false);
});

test('an empty or unreadable composer is never staged', () => {
  for (const screen of [F.EMPTY_COMPOSER, F.PLACEHOLDER_COMPOSER, F.STARTUP_BANNER,
    F.WORKING_NO_COMPOSER, F.PERMISSION_MENU, F.SELECTION_MENU]) {
    assert.strictEqual(isPromptStaged(screen, ISSUE_PROMPT), false);
  }
});

test('a short prompt like /rc must match in full', () => {
  const rule = F.RULE;
  assert.strictEqual(isPromptStaged([rule, '❯ /rc', rule, '? for shortcuts'], '/rc'), true);
  assert.strictEqual(isPromptStaged([rule, '❯ /re', rule, '? for shortcuts'], '/rc'), false);
});

test('a one-character draft does not match a long prompt', () => {
  const rule = F.RULE;
  assert.strictEqual(isPromptStaged([rule, '❯ W', rule, '? for shortcuts'], ISSUE_PROMPT), false);
});

// --- promptDraftVerdict (#656) ---------------------------------------------
//
// "Has the whole of what we wrote finished arriving?" — NOT "is the draft equal to
// what we wrote", which the 40-row screen read cannot answer for a multi-kilobyte
// prompt. See the function's own comment for why that distinction is load-bearing.

test('the end of our text in the box means the write landed', () => {
  assert.strictEqual(promptDraftVerdict(F.STAGED_COMPLETE, ISSUE_PROMPT), 'complete');
});

test('our head without our tail is a write still arriving', () => {
  assert.strictEqual(promptDraftVerdict(F.STAGED_PARTIAL, ISSUE_PROMPT), 'incomplete');
  assert.strictEqual(promptDraftVerdict(F.STAGED_WRAPPED, ISSUE_PROMPT), 'incomplete');
});

test('a collapsed paste is judged on its line count, which Claude derives from NEWLINES', () => {
  // cr(e, t) omits the clause entirely when t === 0, and t is pr(text) — the newline
  // count — so a four-line prompt reads "+3 lines", not "+4".
  assert.strictEqual(promptDraftVerdict(F.PASTE_COLLAPSED_MATCHING, ISSUE_PROMPT), 'complete');
  assert.strictEqual(promptDraftVerdict(F.PASTE_COLLAPSED_SHORT, ISSUE_PROMPT), 'incomplete');
});

test('one line either way is tolerated — Claude counts what it kept after trimming', () => {
  const near = [F.RULE, '❯ [Pasted text #1 +2 lines]', F.RULE, '? for shortcuts'];
  assert.strictEqual(promptDraftVerdict(near, ISSUE_PROMPT), 'complete');
});

test('a paste placeholder with no count decides nothing', () => {
  assert.strictEqual(promptDraftVerdict(F.PASTE_COLLAPSED_NO_COUNT, ISSUE_PROMPT), 'unknown');
});

test('a single-line prompt cannot be judged by a line count', () => {
  // pr() would be 0 and the clause would be absent, so there is nothing to compare.
  assert.strictEqual(promptDraftVerdict(F.PASTE_COLLAPSED, 'one line, no newline'), 'unknown');
});

test('an unreadable, empty or foreign composer decides nothing', () => {
  for (const screen of [F.EMPTY_COMPOSER, F.PLACEHOLDER_COMPOSER, F.STARTUP_BANNER,
    F.WORKING_NO_COMPOSER, F.PERMISSION_MENU, F.SELECTION_MENU, F.STAGED_DRAFT]) {
    assert.strictEqual(promptDraftVerdict(screen, ISSUE_PROMPT), 'unknown');
  }
});

test('a soft wrap inserting a space mid-word is not read as truncation', () => {
  // readComposerDraft joins rows with ' ', so a hard wrap inside a long token adds a
  // character that was never in what we wrote. The comparison strips whitespace on
  // both sides precisely so that a healthy draft is not re-typed.
  const text = 'please read ' + 'A'.repeat(180) + ' and then stop';
  const wrapped = [
    F.RULE,
    '❯ please read ' + 'A'.repeat(90),
    '  ' + 'A'.repeat(90) + ' and then stop',
    F.RULE,
    '? for shortcuts',
  ];
  assert.strictEqual(promptDraftVerdict(wrapped, text), 'complete');
});

test('a long draft whose head has scrolled off screen is still complete', () => {
  // The composer scrolls to the cursor, so what is legible is the END of the draft.
  // Calling that "incomplete" would clear and re-type perfectly good prompts.
  const text = 'HEADMARKER ' + 'filler words here '.repeat(400) + 'TAILMARKER ends here';
  const visible = [
    F.RULE,
    '❯ ' + text.slice(-160, -80),
    '  ' + text.slice(-80),
    F.RULE,
    '? for shortcuts',
  ];
  assert.strictEqual(promptDraftVerdict(visible, text), 'complete');
});

test('an empty prompt decides nothing', () => {
  assert.strictEqual(promptDraftVerdict(F.STAGED_COMPLETE, ''), 'unknown');
});
