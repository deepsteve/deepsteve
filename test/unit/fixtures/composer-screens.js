/**
 * Fixtures for the #607 composer reader. Each entry is an array of INTERPRETED
 * screen lines, i.e. what TerminalScreen.lines() returns after the emulator has
 * resolved cursor addressing — not the raw ANSI-stripped tail the waiting
 * classifier reads.
 *
 * Shapes are transcribed from the real captures already in screen-tails.js (idle
 * footer, permission dialog, AskUserQuestion menu, half-typed draft) with the
 * composer box drawn the way the emulator renders it.
 */

const RULE = '─'.repeat(60);

// Idle, nothing typed. The composer box is present but its body is bare.
const EMPTY_COMPOSER = [
  '⏺ Done — analytics/results/2026-07-16_weekly-session-summary.md, committed and pushed.',
  '✻ Sautéed for 42s',
  '                                                 160565 tokens',
  RULE,
  '❯',
  RULE,
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
];

// Idle with the rotating placeholder hint — still an EMPTY composer, even though
// the row carries text.
const PLACEHOLDER_COMPOSER = [
  '  ▘▘ ▝▝  ~/github/wrds-flutter',
  '0 tokens',
  RULE,
  '❯ Try "how does main.dart work?"',
  RULE,
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
];

// A short unsent draft (the #558 half-typed case).
const STAGED_DRAFT = [
  '⏺ Here is the answer to your question.',
  RULE,
  '❯ can you also check the other',
  RULE,
  '⏵⏵ auto mode on (shift+tab to cycle)',
];

// A long prompt hard-wrapped across two rows inside the box.
const STAGED_WRAPPED = [
  RULE,
  '❯ Work on GitHub issue #607: start_issue prompt sometimes never',
  '  submits under load / many tabs',
  RULE,
  '? for shortcuts',
];

// THE DOUBLE-SUBMIT GUARD. The prompt submitted fine, so it is still on screen —
// but as a transcript line, with an EMPTY composer below it. A whole-screen
// substring test would call this "still staged" and fire a spurious retry on every
// successful submission.
const SUBMITTED_TRANSCRIPT_ECHO = [
  '❯ Work on GitHub issue #607: start_issue prompt sometimes never submits under load',
  '⏺ I will start by exploring the codebase.',
  '✻ Sautéed for 12s',
  RULE,
  '❯',
  RULE,
  '⏵⏵ auto mode on (shift+tab to cycle)',
];

// A multi-line draft drawn with the glyph repeated on EVERY row. Reading only the
// last row here would yield "A new issue tab…", which matches no prompt we sent, so
// a staged prompt would be misread as delivered.
const STAGED_MULTILINE = [
  '⏺ ready',
  RULE,
  '❯ Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs',
  '❯',
  '❯ ## Summary',
  '❯ A new issue tab does not always send its pre-populated prompt.',
  RULE,
  '? for shortcuts',
];

// Claude Code collapses a big paste instead of echoing it.
const PASTE_COLLAPSED = [
  RULE,
  '❯ [Pasted text #1 +42 lines]',
  RULE,
  '? for shortcuts',
];

// Rounded-box variant with side borders and the `>` glyph.
const BOXED_COMPOSER = [
  '╭' + '─'.repeat(58) + '╮',
  '│ > fix issue #607 please                                  │',
  '╰' + '─'.repeat(58) + '╯',
  '  ? for shortcuts',
];

// `❯` as a permission-dialog cursor — NOT a composer.
const PERMISSION_MENU = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for deepsteve - read_session_screen commands",
  '  3. No',
  'Esc to cancel · Tab to amend',
];

// `❯` as an AskUserQuestion cursor, with no space after the glyph — NOT a composer.
const SELECTION_MENU = [
  '⏺ Agent "Validate context-switch fix design" finished · 5m 25s',
  'How wide should the shared-jump wiring be?',
  '❯1. Uniform (recommended)',
  '2. Minimal',
  '3. Type something.',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];

// Nothing recognizable yet — the answer must be "don't know", not "empty".
const STARTUP_BANNER = [
  'stub claude ready',
  'Starting…',
];

// A working turn: the composer is gone from the frame entirely.
const WORKING_NO_COMPOSER = [
  '⏺ BUILTIN_MODS is a parseable one-liner in server.js',
  '✽ Writing revendor-demo.sh… (12s · ↓ 24.9k tokens)',
];

module.exports = {
  RULE,
  EMPTY_COMPOSER,
  PLACEHOLDER_COMPOSER,
  STAGED_DRAFT,
  STAGED_WRAPPED,
  STAGED_MULTILINE,
  SUBMITTED_TRANSCRIPT_ECHO,
  PASTE_COLLAPSED,
  BOXED_COMPOSER,
  PERMISSION_MENU,
  SELECTION_MENU,
  STARTUP_BANNER,
  WORKING_NO_COMPOSER,
};
