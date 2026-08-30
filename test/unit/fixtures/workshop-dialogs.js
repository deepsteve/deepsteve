/**
 * Dialog fixtures for mods/workshop/dialog-parse.js (#660).
 *
 * Only the shapes test/unit/fixtures/composer-screens.js does NOT already carry.
 * PERMISSION_MENU and SELECTION_MENU live there and are imported by the test
 * directly — one copy, so the client and server sides share ground truth.
 *
 * Every entry is an array of INTERPRETED screen lines, i.e. what
 * TerminalScreen.lines()/linesSync() returns after the emulator has resolved cursor
 * addressing — the same convention composer-screens.js uses, and NOT the overlapping
 * ANSI-stripped tail the waiting classifier reads.
 */

const RULE = '─'.repeat(60);

// The REAL capture from test/unit/fixtures/screen-tails.js (session efde516d),
// rendered as the emulator draws it. Option 2's path wraps onto a second row, which
// is exactly what the issue's stated "trailing run of option lines" algorithm cannot
// read: the trailing run is `3. No` alone. This is the regression fixture.
const PERMISSION_WRAPPED = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for deepsteve - read_session_screen commands in",
  '     /Users/michael/github/deepsteve-experimental/.claude/worktrees/github-issue-568',
  '  3. No',
  'Esc to cancel · Tab to amend',
];

const PERMISSION_CURSOR_MID = [
  'Bash(rm -rf node_modules)',
  'Do you want to proceed?',
  '  1. Yes',
  "❯ 2. Yes, and don't ask again for rm commands in /Users/michael/x",
  '  3. No',
  'Esc to cancel · Tab to amend',
];

const PERMISSION_CURSOR_LAST = [
  'Bash(rm -rf node_modules)',
  'Do you want to proceed?',
  '  1. Yes',
  "  2. Yes, and don't ask again for rm commands in /Users/michael/x",
  '❯ 3. No',
  'Esc to cancel · Tab to amend',
];

// Reverse-video cursor: the emulator gives us text with no attributes, so no row
// carries a glyph. Options still parse; cursorIndex must be null so the answer path
// refuses rather than assuming option 1.
const PERMISSION_NO_CURSOR = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '  1. Yes',
  '  2. No',
  'Esc to cancel · Tab to amend',
];

// A half-repainted frame leaves two glyphs. A mis-parse must never look like a
// confident answer.
const PERMISSION_TWO_CURSORS = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '❯ 2. No',
  'Esc to cancel · Tab to amend',
];

// A dialog is up, but only one option is on screen. detectDialog must still say
// "blocked" (so the row appears) while parseDialog says "unreadable" (so the card
// renders a raw preview instead of buttons).
const SINGLE_OPTION = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  'Esc to cancel · Tab to amend',
];

// The acceptance criterion "a dialog that resolves itself disappears from the inbox
// on the next poll with no leftover row", as a pure fixture: the dialog rows are
// still in the scrollback, but Claude Code has repainted a composer underneath.
const RESOLVED_DIALOG = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No',
  'Esc to cancel · Tab to amend',
  '⏺ Reading the screen now.',
  RULE,
  '❯',
  RULE,
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
];

// Multi-question AskUserQuestion. WHICH tab is current is conveyed by highlight,
// which we cannot see, so `multi` deliberately carries no index.
const MULTI_QUESTION = [
  '⏺ Agent "Design the wiring" finished · 2m 11s',
  '←  ☐ Wiring scope  ☐ Notify on click  ✔ Submit  →',
  'How wide should the shared-jump wiring be?',
  '❯ 1. Uniform (recommended)',
  '  2. Minimal',
  '  3. Type something.',
  'Enter to select · Tab to switch questions · Esc to cancel',
];

// The strip is off-screen but the footer still says so.
const MULTI_FOOTER_ONLY = [
  'How wide should the shared-jump wiring be?',
  '❯ 1. Uniform',
  '  2. Minimal',
  'Enter to select · Tab to switch questions · Esc to cancel',
];

// A stray numbered line in the transcript far above a real dialog must not extend
// the run: the walk stops the moment the descending sequence breaks.
const STRAY_NUMBER_ABOVE = [
  '⏺ I considered three approaches:',
  '2. Minimal rewiring',
  '',
  '',
  'How wide should the shared-jump wiring be?',
  '❯ 1. Uniform',
  '  2. Minimal',
  '  3. Type something.',
  'Enter to select · Esc to cancel',
];

// Box-drawn variant: borders must come off the labels.
const BOXED_DIALOG = [
  '╭' + '─'.repeat(58) + '╮',
  '│ Do you want to proceed?                                  │',
  '│ ❯ 1. Yes                                                │',
  '│   2. No                                                 │',
  '╰' + '─'.repeat(58) + '╯',
  'Esc to cancel · Tab to amend',
];

// A label that contains its own "N." must not corrupt the numbering.
const LABEL_WITH_NUMBER = [
  'Which retry policy?',
  '❯ 1. Retry 3. times, then give up',
  '  2. Never retry',
  'Enter to select · Esc to cancel',
];

// Nine options, the most the inbox can bind keys for.
const NINE_OPTIONS = [
  'Pick a target',
  '❯ 1. alpha',
  '  2. bravo',
  '  3. charlie',
  '  4. delta',
  '  5. echo',
  '  6. foxtrot',
  '  7. golf',
  '  8. hotel',
  '  9. india',
  'Enter to select · Esc to cancel',
];

// A real AskUserQuestion, captured 2026-08-30 from the #662 worktree. Claude Code
// draws a rule between the last real option and the "Chat about this" escape hatch,
// which stops collectOptions dead: option 4 is taken, the rule ends the run before
// option 1 is reached, and parseDialog returns null. The row therefore renders as a
// raw preview and cannot be answered from the panel — the exact shape that made a
// dismissible blocked row necessary (#663).
const RULED_OPTION_RUN = [
  '⏺ All three reports are in. I have two genuine design forks to settle.',
  '←  ☐ Scope  ☐ ⌘P  ☐ Toggle look  ✔ Submit  →',
  '│ Who gets the quiet-mode toggle? #661 shipped `"app": true` on Workshop only.',
  '❯ 1. Apps only (`app: true`)',
  '     Keeps one flag meaning one thing. Cleanest, but ships to exactly one mod today.',
  '  2. Every fullscreen mod view',
  '     Broader payoff now, but it decouples quiet mode from the App concept.',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

module.exports = {
  RULE,
  PERMISSION_WRAPPED,
  PERMISSION_CURSOR_MID,
  PERMISSION_CURSOR_LAST,
  PERMISSION_NO_CURSOR,
  PERMISSION_TWO_CURSORS,
  SINGLE_OPTION,
  RESOLVED_DIALOG,
  MULTI_QUESTION,
  MULTI_FOOTER_ONLY,
  STRAY_NUMBER_ABOVE,
  BOXED_DIALOG,
  LABEL_WITH_NUMBER,
  NINE_OPTIONS,
  RULED_OPTION_RUN,
};
