// Telling a keystroke from the terminal answering a question (#635).
//
// The browser forwards everything xterm.js's `onData` emits straight down the session
// WebSocket (public/js/terminal.js), and the daemon treats every such payload as the
// user typing: it stamps `lastInputTime` and cancels any pending auto-close. But
// `onData` also fires for the terminal's own REPLIES. Under tmux the PTY the daemon
// owns is an attach client, and tmux probes the terminal's capabilities the moment a
// client attaches; xterm answers, the answer travels back over the same socket, and the
// daemon records a keystroke nobody pressed.
//
// That is why every `run_in_terminal` tab leaked. `finalize()` asks "did anyone type in
// this tab?" before closing it, and the answer was yes within ~200ms of the tab opening,
// every single time. The same false positive silently disarms the merge auto-close
// (#627), which server.js:6630 predicted in as many words: "if some future TUI turns on
// a reporting mode (focus tracking, say) that would otherwise disarm every pending close
// invisibly."
//
// The reply set is closed and small. These are the answers @xterm/headless 6.0.0 — the
// same version public/index.html loads in the browser — actually produces:
//
//   ESC[c   ESC[0c  (DA1)      -> ESC[?1;2c
//   ESC[>c          (DA2)      -> ESC[>0;276;0c
//   ESC[5n          (DSR)      -> ESC[0n
//   ESC[6n          (CPR)      -> ESC[1;1R
//   ESC[?6n         (DECXCPR)  -> ESC[?1;1R
//   ESC[?2004$p     (DECRQM)   -> ESC[?2004;2$y
//   ESC P$qm ESC\   (DECRQSS)  -> ESC P1$r0m ESC\
//
// test/unit/terminal-input.test.js drives xterm itself with those probes and asserts
// this module accepts everything it emits, so a future xterm that grows a new reply
// fails a test instead of quietly re-leaking tabs.
//
// The default is USER INPUT. Anything unrecognized — any printable byte, any escape
// sequence not on the list, any leftover byte after the recognized ones are consumed —
// is a keystroke. That is the safe direction: mistaking a report for input leaves a tab
// open (today's bug), while mistaking input for a report closes a tab someone was
// working in.
//
// Dependency-free, and at the repo root, for the same reasons as terminal-run.js:
// restart.sh's `cp *.js` and release.sh's root-js loop ship root modules automatically,
// and the bare CI `unit` job runs with --ignore-scripts and so has no node-pty binding.

// Sticky, so each is tried at one exact offset rather than allowed to skip ahead —
// a report that matched *later* in the payload would mean unrecognized bytes came first,
// which is precisely the case that must read as input.
//
// The OSC/DCS bodies deliberately exclude ESC and BEL rather than using a lazy `.*?`:
// an unterminated sequence must fail to match instead of swallowing the rest of a
// payload that happens to contain a terminator further along.
const REPORT_PATTERNS = [
  /\x1b\[[?>]?[0-9;]*c/y,        // DA1 / DA2 device attributes
  /\x1b\[\??[0-9;]*[nR]/y,       // DSR status, CPR, DECXCPR cursor position
  /\x1b\[\?[0-9;]*\$y/y,         // DECRPM mode report
  /\x1b\[[0-9;]*t/y,             // XTWINOPS window report
  /\x1bP[^\x1b\x07]*(?:\x1b\\|\x07)/y, // DCS reply (DECRQSS, XTVERSION)
  /\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/y, // OSC reply (10/11/12 colors, 52 clipboard)
];

/**
 * Is this WebSocket payload made up ENTIRELY of terminal report sequences — i.e. the
 * terminal answering a program, rather than a person typing?
 *
 * One known collision, accepted: xterm sends a MODIFIED F3 as `CSI 1;<mod> R`, which is
 * byte-identical to a cursor position report. So Shift/Ctrl/Alt+F3 does not count as
 * user input. Plain F3 is `ESC O R` (SS3) and is unaffected, and the cost of the
 * collision is a `run_in_terminal` tab closing 20s later than someone wanted.
 */
function isTerminalReport(data) {
  const s = typeof data === 'string' ? data : '';
  // Cheapest possible rejection, and it covers the overwhelmingly common case: real
  // typing does not begin with ESC. An empty payload is not a report either.
  if (!s || s.charCodeAt(0) !== 0x1b) return false;

  let i = 0;
  while (i < s.length) {
    let width = 0;
    for (const re of REPORT_PATTERNS) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) { width = m[0].length; break; }
    }
    if (!width) return false;   // an unrecognized byte anywhere means input
    i += width;
  }
  return true;
}

module.exports = { isTerminalReport };
