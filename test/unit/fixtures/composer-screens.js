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

// #656 — the completeness fixtures below are all renderings of THIS text, so a test
// can ask "has all of it arrived?" and mean something. It is the same four-line shape
// the #607 fixtures were transcribed from.
const DELIVERED_PROMPT = [
  'Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs',
  '',
  '## Summary',
  'When a lot of tabs are open the prompt does not always get submitted.',
].join('\n');

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

// #656 — the WHOLE of DELIVERED_PROMPT, wrapped across the box. Its last row ends
// with the prompt's last characters, which is what makes it safe to press Enter.
const STAGED_COMPLETE = [
  '⏺ ready',
  RULE,
  '❯ Work on GitHub issue #607: start_issue prompt sometimes never submits under',
  '  load / many tabs',
  '❯',
  '❯ ## Summary',
  '❯ When a lot of tabs are open the prompt does not always get',
  '  submitted.',
  RULE,
  '? for shortcuts',
];

// #656 — the same delivery caught MID-FLIGHT: the head is in the box, the tail is
// not. Pressing Enter here submits a fragment, which is the bug.
const STAGED_PARTIAL = [
  '⏺ ready',
  RULE,
  '❯ Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs',
  '❯',
  '❯ ## Sum',
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

// #656 — a collapsed paste whose `+N lines` matches DELIVERED_PROMPT. Claude Code
// counts NEWLINES, not lines (see PASTE_LINE_COUNT_RE), so a 4-line prompt reads +3.
const PASTE_COLLAPSED_MATCHING = [
  RULE,
  '❯ [Pasted text #1 +3 lines]',
  RULE,
  '? for shortcuts',
];

// #656 — the head-loss signature. The same paste arriving without most of itself
// collapses to a count far below what we wrote.
const PASTE_COLLAPSED_SHORT = [
  RULE,
  '❯ [Pasted text #1 +1 lines]',
  RULE,
  '? for shortcuts',
];

// #656 — a single-line paste carries no count at all: `cr(e, 0)` omits the clause.
const PASTE_COLLAPSED_NO_COUNT = [
  RULE,
  '❯ [Pasted text #1]',
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
  STAGED_COMPLETE,
  STAGED_PARTIAL,
  SUBMITTED_TRANSCRIPT_ECHO,
  PASTE_COLLAPSED,
  PASTE_COLLAPSED_MATCHING,
  PASTE_COLLAPSED_SHORT,
  PASTE_COLLAPSED_NO_COUNT,
  DELIVERED_PROMPT,
  BOXED_COMPOSER,
  PERMISSION_MENU,
  SELECTION_MENU,
  STARTUP_BANNER,
  WORKING_NO_COMPOSER,
};
