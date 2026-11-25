/**
 * The conversation id in the resume hint Claude Code prints as it exits, read off a tab's output.
 *
 * As the process exits, after its UI has unmounted, Claude Code writes a dim block to stdout:
 *
 *     Resume this session with:
 *     <command>
 *
 * and the command ends with the conversation id. Claude Code 2.1.332 (`printResumeHint`, and the
 * builder it calls) produces one of these shapes. `[NAME=1 ]` is an environment prefix it adds on
 * some setups, and `[flags]` are launch flags such as `--permission-mode auto`, kept when they fit
 * the terminal width:
 *
 *     [NAME=1 ]claude [flags] --resume <id>
 *     [NAME=1 ]claude [flags] --worktree "<name>" --resume <id>
 *     [NAME=1 ]claude [flags] -w "<name>" -r <id>          (when the long form is too wide)
 *     <launcher> --resume <id>                              (CLAUDE_CODE_RESUME_HINT_COMMAND)
 *
 * Two ways the hint was read before, both wrong:
 *
 *  - Any `claude --resume <id>` anywhere in the output was believed. A tab's output is also
 *    where its agent's tool results are drawn: a `ps` listing carrying another tab's argv, or
 *    another pane's screen with that tab's command line, re-pointed the tab at that tab's
 *    conversation. So the id is taken only from a command that follows the header line.
 *  - Only that exact spelling matched, so a hint with launch flags, or either worktree form,
 *    was missed. Every shape above is read.
 *
 * The header can still reach a tab's output from somewhere other than its own exit: an agent
 * can print another tab's screen with an exit hint still on it. So this is the weakest of the
 * detectors that move a tab's conversation, and server.js consults it only for a tab that
 * Claude Code's own process record has never named (`observeResumeHint`, claude-process.js).
 *
 * The id is the hint's last token, so a hint cut across two output chunks is read once the chunk
 * with the rest of the id arrives: the scanner carries the end of the text it has seen.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The header, then whitespace (a newline, or nothing at all where a terminal multiplexer
// positioned the next line with a cursor move that stripping removed), then one line of command:
// a program token, anything up to the resume flag, and the id. The command is bounded so a long
// run of glued screen text cannot make the lazy match scan far.
const HINT_RE = new RegExp(
  `Resume this session with:\\s*(\\S[^\\r\\n]{0,512}?)\\s(?:--resume|-r) (${UUID})(?![0-9a-f-])`,
  'g',
);
// Enough to hold a whole hint (header plus the longest command the bound above admits).
const CARRY_CHARS = 1024;

/** The id in the last complete resume hint in `text`, or null. */
function resumeHintId(text) {
  let id = null;
  for (const m of String(text || '').matchAll(HINT_RE)) id = m[2];
  return id;
}

/**
 * A per-tab reader of ANSI-stripped output chunks. `push(plain)` returns the id of a hint that
 * completed in this chunk, or null. A hint is reported once: the text it was read from is
 * dropped from the carry.
 */
function createResumeHintScanner() {
  let carry = '';
  return {
    push(plain) {
      const text = carry + String(plain || '');
      let id = null;
      let end = -1;
      for (const m of text.matchAll(HINT_RE)) {
        id = m[2];
        end = m.index + m[0].length;
      }
      carry = (end >= 0 ? text.slice(end) : text).slice(-CARRY_CHARS);
      return id;
    },
  };
}

module.exports = { resumeHintId, createResumeHintScanner };
