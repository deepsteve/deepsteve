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
// and until #664 that stopped collectOptions dead: option 4 was taken, the rule ended
// the run before option 1 was reached, and parseDialog returned null. Every
// multi-option AskUserQuestion has this divider, so the whole feature degraded to a
// raw preview on the majority of what the inbox exists to show.
//
// The #664 regression fixture: four options in order, cursor on the first.
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

// The divider one row higher: it groups BOTH escape hatches, so the row directly above
// it is option 2's DESCRIPTION rather than an option. Pins that the walk does not demand
// an option row adjacent to the rule — a guard shaped that way reads the capture above
// and refuses this, and Claude Code draws the divider under a description just as readily.
const RULED_ESCAPE_GROUP = [
  'Who gets the quiet-mode toggle?',
  '❯ 1. Apps only (`app: true`)',
  '     Keeps one flag meaning one thing.',
  '  2. Every fullscreen mod view',
  '     Broader payoff now.',
  RULE,
  '  3. Type something.',
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

// A box border AND an escape-hatch divider on one screen. `rules` (borders crossed
// before the run starts) and `crossings` (dividers crossed inside it) are separate
// budgets; spending one on the other loses the dialog.
const BOXED_RULED_DIALOG = [
  '╭' + '─'.repeat(40) + '╮',
  '│ Do you want to proceed?',
  '│ ❯ 1. Yes',
  '│   2. Type something.',
  '├' + '─'.repeat(40) + '┤',
  '│   3. Chat about this',
  '╰' + '─'.repeat(40) + '╯',
  'Esc to cancel · Tab to amend',
];

// The far side of the rule is `2.` when the run needs `3.`, so this rule is the end of
// the run, not a divider. Pins the load-bearing half of #664: stepping over a rule must
// not RESCUE a run that contiguity would otherwise have killed.
const RULE_BREAKS_RUN = [
  'Pick a target',
  '❯ 1. Alpha',
  '  2. Beta',
  RULE,
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

// The hole the divider tolerance widens by exactly one rule: a numbered list in the
// TRANSCRIPT ending on the number the run wants. It chains on and the labels are junk —
// but no transcript row carries a cursor glyph, so cursorIndex is null and the row is
// never answerable. Contiguity is already the only guard here when there is no rule.
const TRANSCRIPT_LIST_ACROSS_RULE = [
  '⏺ I considered:',
  '1. Alpha',
  '2. Beta',
  '3. Gamma',
  RULE,
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

// The side-by-side layout: Claude Code draws a detail panel to the RIGHT of the
// options, so the options and the panel share ROWS. Transcribed from session b6cc95de.
// Head-on this is unreadable — the fifteen rows of box art between `3.` and the footer
// blow both the blank and the continuation budget — so it is the stripSidePanel retry's
// regression fixture. Note the escape hatch here is UNNUMBERED, unlike the
// single-question variant's `5. Chat about this`.
const SIDE_PANEL_DIALOG = [
  '⏺ The tutorial\'s copy teaches "Drag" — worth knowing.',
  '',
  RULE,
  '←  ☐ Focus flow  ☐ Kill switch  ☐ Landing hints  ✔ Submit  →',
  '',
  'Which direction should tap focus work in?',
  '',
  '❯ 1. Both ends (Recommended)      ┌──────────────────────────────────────────────────┐',
  '  2. Source-first only            │ SOURCE-FIRST (mirrors drag)                      │',
  '  3. Slot-first only              │   tap rack E      -> E lifts, legal slots hint   │',
  '                                  │   tap slot 3      -> E lands. done.              │',
  '                                  │                                                  │',
  '                                  │   tap placed A    -> A lifts                     │',
  '                                  │   tap placed E    -> A and E trade places        │',
  '                                  │   tap the rack    -> A comes off the board       │',
  '                                  │                                                  │',
  '                                  │ DESTINATION-FIRST (the issue\'s headline)         │',
  '                                  │   tap empty slot  -> slot is aimed               │',
  '                                  │   tap rack E      -> E lands there. done.        │',
  '                                  │                                                  │',
  '                                  │ EITHER tap on the selected thing again -> cancel │',
  '                                  └──────────────────────────────────────────────────┘',
  '',
  '                                  Notes: press n to add notes',
  '',
  RULE,
  '  Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel',
];

// The plan-approval gate, transcribed from session 1c26c177. Its footer names neither
// Esc nor Enter, and its question is "Would you like to proceed?" rather than "Do you
// want to" — so before the ctrl+g alternative it was invisible to detectDialog AND to
// screen-classifier.js, which is why the session read as state 'unknown'. The
// shift+tab row under option 3 is a key hint, not option 3's wrapped label.
const PLAN_APPROVAL = [
  '   - No surface in the app renders the default no-builder path. All three',
  '     NextWrdCountdown(...) call sites in lib/ pass a builder.',
  '  ' + RULE,
  '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
  '',
  '   ❯ 1. Yes, and use auto mode',
  '     2. Yes, manually approve edits',
  '     3. Tell Claude what to change',
  '        shift+tab to approve with this feedback',
  '',
  '   ctrl+g to edit in VS Code · ~/.claude/plans/i-need-you-to-humming-lobster.md',
];

// A plan path in PROSE, which is what an agent writes every time it saves one. The
// ctrl+g alternative must need both halves, or every session that mentions its own
// plan file reads as a live dialog.
const PLAN_PATH_IN_PROSE = [
  '⏺ I have written the plan.',
  '',
  '  Saved to ~/.claude/plans/i-need-you-to-humming-lobster.md — 1. read it, 2. run it.',
  '',
  '❯ ',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt',
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
  RULED_ESCAPE_GROUP,
  BOXED_RULED_DIALOG,
  RULE_BREAKS_RUN,
  TRANSCRIPT_LIST_ACROSS_RULE,
  SIDE_PANEL_DIALOG,
  PLAN_APPROVAL,
  PLAN_PATH_IN_PROSE,
};
