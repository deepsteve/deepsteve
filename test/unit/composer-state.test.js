// #607 — the composer reader that decides whether a prompt is still sitting unsent.
//
// This is the piece the verify-and-retry safety net rests on, and the one place a
// mistake turns into a DOUBLE SUBMIT on every prompt (a naive substring test over
// the whole screen matches the transcript echo of a perfectly successful submit).
const { test } = require('node:test');
const assert = require('node:assert');

const { readComposerDraft, isPromptStaged } = require('../../composer-state');
const F = require('./fixtures/composer-screens');

const ISSUE_PROMPT = [
  'Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs',
  '',
  '## Summary',
  'When a lot of tabs are open the prompt does not always get submitted.',
].join('\n');

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
