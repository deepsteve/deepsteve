/**
 * Fixtures for the #568 screen-state detector unit test. Each `tail` is an
 * ANSI-stripped screen tail as classifyScreenTail() would receive it. The claude
 * examples are transcribed from REAL captures taken off the live daemon via
 * read_session_screen (permission dialog, idle footer, working spinner, and the
 * stuck-idle "state:busy while seconds_since_output=980" case that motivated the
 * fix); a couple are marked SYNTHETIC where a real capture of that exact state
 * wasn't on hand — they exercise a specific marker/branch.
 *
 * `now` is a fixed clock; `lastSpinnerTime` is expressed relative to it. FRESH
 * means a spinner frame arrived within SPINNER_MAX_QUIET_MS; STALE means it did
 * not (or never).
 */
const { SPINNER_MAX_QUIET_MS } = require('../../../screen-classifier.js');

const NOW = 1_000_000;
const FRESH = NOW - 500; // a spinner frame 0.5s ago
const STALE = NOW - 10_000; // last spinner frame 10s ago (or a leftover in the tail)

// Real capture — a permission dialog (efde516d). Note the overlapping repainted
// fragments, exactly what the stripped tail looks like with no emulator.
const PERMISSION_TAIL = [
  'deepsteve - read_session_screen (MCP)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "2. Yes, and don't ask again for deepsteve - read_session_screen commands in",
  '/Users/michael/github/deepsteve-experimental/.claude/worktrees/github-issue-568',
  '3. No',
  'Esc to cancel · Tab to amend',
  '❯Yes',
  "Yes, and don't ask again for deepsteve - read_session_screen commands in",
  '3. No',
].join('\n');

// Real capture — a brand-new session idle at its prompt (d89befdc). state was
// wrongly "busy" with seconds_since_output=828 under the old classifier.
const IDLE_AUTO_MODE_TAIL = [
  '  ▘▘ ▝▝  ~/github/wrds-flutter',
  '0 tokens',
  '────────────────────────────────────────────────────────────',
  '❯ Try "how does main.dart work?"',
  '────────────────────────────────────────────────────────────',
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  'current: 2.1.211 · latest: 2.1.211 Checking for updates',
].join('\n');

// Real capture — a session that finished 16 min ago (c9118f7b) and sat there. The
// completion line "✻ Sautéed for 42s" is PAST tense with no "esc to interrupt",
// and the (full-screen) bottom still shows the idle footer.
const STUCK_IDLE_TAIL = [
  '⏺ Done — analytics/results/2026-07-16_weekly-session-summary.md, committed and pushed.',
  '✻ Sautéed for 42s',
  '160565 tokens',
  '────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────',
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
].join('\n');

// Real capture — a genuinely working session (58f2b427): animated spinner glyphs
// and a verb. The decision here is driven by lastSpinnerTime, not this text.
const WORKING_SPINNER_TAIL = [
  '✻ Ionizing… (esc to interrupt · 8s)',
  '✽',
  '✳ Ionizing…',
  '✶',
].join('\n');

// SYNTHETIC — normal mode, empty input: the "? for shortcuts" placeholder is the
// only footer marker on an otherwise bare composer.
const IDLE_SHORTCUTS_TAIL = [
  '────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────',
  '? for shortcuts',
].join('\n');

// SYNTHETIC — the KEY robustness case. A STALE "esc to interrupt" from a prior
// turn lingers in the tail (the strip can't resolve cursor motion), but the last
// painted state is the idle footer. Must NOT be fooled into "working".
const STALE_SPINNER_THEN_IDLE_TAIL = [
  '✻ Working… (esc to interrupt · 12s)',
  '⏺ Done.',
  '❯',
  '⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');

// SYNTHETIC — a half-typed, unsubmitted reply in NORMAL mode: no footer marker
// (the placeholder is gone once you type) and no spinner. Ambiguous → 'unknown',
// which the caller maps to "leave the flag as-is" (the #558 keystroke case).
const HALF_TYPED_TAIL = [
  '⏺ Here is the answer to your question.',
  '────────────────────────────────────────────────────────────',
  '❯ can you also check the other',
  '────────────────────────────────────────────────────────────',
].join('\n');

// Real capture — a large-context session idle 24 min after finishing (c9118f7b).
// state was "busy" under the old classifier. The recent tail is dominated by the
// finished turn's output; the ONLY idle-footer hint present is the large-context
// "new task? /clear to save …" line (no "⏵⏵", no "? for shortcuts").
const LARGE_CONTEXT_IDLE_TAIL = [
  '⏺ Done — analytics/results/2026-07-16_weekly-session-summary.md, committed and pushed (a9006dc).',
  '✻ Sautéed for 42s',
  '                                                 160565 tokens',
  'current: 2.1.211 · latest: 2.1.211 Checking for update',
  '                                         160565 token',
  'new task? /clear to save 160.6k tokens',
].join('\n');

// Real capture — an idle session in normal mode (75d40a96) whose footer hint is
// "← for agents"; "⏵⏵"/"? for shortcuts" are absent. state was "idle".
const AGENTS_HINT_IDLE_TAIL = [
  '⏺ Clean tree, 8 ahead of origin — matches what I reported; git push whenever you are ready.',
  '✻ Crunched for 19s',
  '821',
  '❯',
  '← for agents',
  '(use "git push" to publish your local commits)',
  'current: 2.1.211 · latest: 2.1.211 Checking for update',
].join('\n');

// Real capture — a selection prompt (62089af6): an AskUserQuestion-style menu. A ✻
// glyph sits at the top but there is no "esc to interrupt" and output stopped 10
// min ago, so the spinner is stale and the selection markers decide it.
const SELECTION_MENU_TAIL = [
  '✻',
  '⏺ Agent "Validate context-switch fix design" finished · 5m 25s',
  '←  ☐ Wiring scope  ☐ Notif click  ✔ Submit  →',
  'How wide should the shared-jump wiring be?',
  '❯1. Uniform (recommended)',
  '2. Minimal',
  '3. Type something.',
  '4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

// Real capture (2026-07-17) — a working session on a mid-2026 Claude Code build
// (e11d1f4a, mid-file-write). The status line carries NO "esc to interrupt" (the
// hint moved into the ⏵⏵ footer on these builds); only the animated glyph frames
// (including cursor-addressed diffs like "✻ ge") identify the running turn. This
// is the shape that froze every session's waiting flag while the spinner marker
// was hint-only: no chunk ever refreshed lastSpinnerTime, classify returned
// 'unknown' forever, and the flag stuck at its last decisive value (True).
const MODERN_WORKING_TAIL = [
  '⏺ BUILTIN_MODS is a parseable one-liner in server.js — the generator can extract it',
  '✽ Writing revendor-demo.sh… thinking with xhigh effort)',
  '4362',
  'thought for 31s)',
  '✢ endr-d 10s · ↓ 24.9k tokens · thought for 31s)',
  '· vd',
  '✳ v1',
  '✻ ge',
  '✽ nr',
].join('\n');

// SYNTHETIC — startup banner, nothing recognizable yet.
const STARTUP_TAIL = 'stub claude ready\nStarting…';

const fixtures = [
  { name: 'fresh spinner → working', tail: 'streaming output…', lastSpinnerTime: FRESH, expect: 'working' },
  { name: 'working spinner (real) fresh → working', tail: WORKING_SPINNER_TAIL, lastSpinnerTime: FRESH, expect: 'working' },
  { name: 'long tool call: spinner fresh, no footer → working (#500)', tail: 'running a long bash…\n✻ Working… (esc to interrupt · 30s)', lastSpinnerTime: FRESH, expect: 'working' },
  { name: 'permission dialog (real), spinner stale → waiting', tail: PERMISSION_TAIL, lastSpinnerTime: STALE, expect: 'waiting' },
  { name: 'idle auto-mode footer (real) → waiting', tail: IDLE_AUTO_MODE_TAIL, lastSpinnerTime: null, expect: 'waiting' },
  { name: 'stuck-idle with footer (real) → waiting', tail: STUCK_IDLE_TAIL, lastSpinnerTime: STALE, expect: 'waiting' },
  { name: 'large-context idle "/clear to save" (real) → waiting', tail: LARGE_CONTEXT_IDLE_TAIL, lastSpinnerTime: STALE, expect: 'waiting' },
  { name: 'normal-mode "← for agents" idle (real) → waiting', tail: AGENTS_HINT_IDLE_TAIL, lastSpinnerTime: STALE, expect: 'waiting' },
  { name: 'selection menu (real) → waiting', tail: SELECTION_MENU_TAIL, lastSpinnerTime: STALE, expect: 'waiting' },
  { name: 'normal-mode "? for shortcuts" → waiting', tail: IDLE_SHORTCUTS_TAIL, lastSpinnerTime: null, expect: 'waiting' },
  { name: 'STALE esc-to-interrupt in tail but footer last → waiting (robustness)', tail: STALE_SPINNER_THEN_IDLE_TAIL, lastSpinnerTime: STALE, expect: 'waiting' },
  { name: 'half-typed normal mode, no markers → unknown (keep-state)', tail: HALF_TYPED_TAIL, lastSpinnerTime: STALE, expect: 'unknown' },
  { name: 'modern working, no esc-hint (real 2026-07), glyph frames fresh → working', tail: MODERN_WORKING_TAIL, lastSpinnerTime: FRESH, expect: 'working' },
  { name: 'modern working, spinner stale → unknown (keep-state; heartbeat carries it live)', tail: MODERN_WORKING_TAIL, lastSpinnerTime: STALE, expect: 'unknown' },
  { name: 'startup banner → unknown', tail: STARTUP_TAIL, lastSpinnerTime: null, expect: 'unknown' },
  // Boundary: a spinner exactly at the freshness edge is stale (>= threshold);
  // referenced off the constant so the boundary tracks any retune.
  { name: 'spinner exactly at staleness edge, footer present → waiting', tail: IDLE_AUTO_MODE_TAIL, lastSpinnerTime: NOW - SPINNER_MAX_QUIET_MS, expect: 'waiting' },
  { name: 'spinner just under the edge → working', tail: IDLE_AUTO_MODE_TAIL, lastSpinnerTime: NOW - (SPINNER_MAX_QUIET_MS - 1), expect: 'working' },
];

module.exports = { NOW, FRESH, STALE, fixtures };
