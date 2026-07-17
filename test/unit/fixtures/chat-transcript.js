/**
 * Fixture for the #481 chat-view parser unit test. CHAT_TRANSCRIPT is a clean,
 * hand-built model of what xterm's RESOLVED buffer looks like for a Claude Code
 * session — glyphs at column 0, thinking/tool bodies indented, the composer draft
 * at the very bottom. It is modeled on the issue's example and deliberately
 * exercises every bug the first implementation got wrong:
 *
 *   - thinking body after a blank line (Bug 2b — bodies were dropped)
 *   - a multi-paragraph agent reply (Bug 2b — truncated to first paragraph)
 *   - a ⏺ Tool(...) call with ⎿ output (Bug 2a — must be a collapsible tool block)
 *   - a plain ⏺ agent reply that is NOT a tool (must stay a plain agent bubble)
 *   - a ✻ status line (past-tense, no "esc to interrupt")
 *   - a chrome block: separator, mode footer, token count, version line
 *   - a trailing bare `❯ <draft>` composer line (Bug 1 — rendered as a sent msg)
 *
 * Unlike test/unit/fixtures/screen-tails.js (the server's messy, overlapping-frame
 * screen approximation), this is the clean resolved grid the client parser reads.
 */

const CHAT_TRANSCRIPT = [
  '❯ user question one',
  '',
  '∴ Thinking…',
  '',
  '   The user wants X, so I will do Y first.',
  '',
  '   A second thinking paragraph to verify bodies survive the blank line.',
  '',
  "⏺ First, here is the primary answer to your question.",
  '',
  'It has a second paragraph that must survive the parser too.',
  '',
  '⏺ Bash(git status)',
  '  ⎿  On branch main',
  '     nothing to commit, working tree clean',
  '',
  '     (an extra output line after a blank)',
  '',
  '✻ Brewed for 13s',
  '',
  '⏺ Tracked. Which one do you prefer?',
  '',
  '❯ user question two',
  '',
  '⏺ Short answer.',
  '',
  '────────────────────────────────────────',
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  '160565 tokens',
  'current: 2.1.211 · latest: 2.1.211 Checking for updates',
  '❯ an unsent draft',
];

// The exact chrome strings embedded above — asserted to be recognised as chrome
// and to never appear inside any rendered turn/block text.
const CHROME_LINES = [
  '────────────────────────────────────────',
  '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  '160565 tokens',
  'current: 2.1.211 · latest: 2.1.211 Checking for updates',
  '? for shortcuts',
  '← for agents',
  'esc to interrupt',
  'new task? /clear to save 160.6k tokens',
];

module.exports = { CHAT_TRANSCRIPT, CHROME_LINES };
