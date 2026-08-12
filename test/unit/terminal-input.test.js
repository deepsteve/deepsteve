// Unit tests for the keystroke/report classifier (#635).
//
// The bug this guards against is silent in both directions, which is why the drift guard
// at the bottom exists: a report the classifier stops recognizing puts back the leak
// (every run_in_terminal tab claimed by a keystroke nobody pressed), and a keystroke it
// starts recognizing closes a tab someone was working in.
const { test } = require('node:test');
const assert = require('node:assert');

const { isTerminalReport } = require('../../terminal-input');

// The replies @xterm/headless 6.0.0 actually produces, plus the two the browser build
// can produce that headless cannot (it has no theme service and no window services).
const REPORTS = {
  'DA1 device attributes':        '\x1b[?1;2c',
  'DA2 secondary attributes':     '\x1b[>0;276;0c',
  'DSR device status':            '\x1b[0n',
  'CPR cursor position':          '\x1b[1;1R',
  'DECXCPR extended position':    '\x1b[?1;1R',
  'DECRPM mode report':           '\x1b[?2004;2$y',
  'DECRQSS reply (DCS)':          '\x1bP1$r0m\x1b\\',
  'XTVERSION reply (DCS)':        '\x1bP>|xterm.js(6.0.0)\x1b\\',
  'OSC 11 background color':      '\x1b]11;rgb:1e1e/1e1e/1e1e\x07',
  'XTWINOPS window report':       '\x1b[8;40;120t',
  'two reports in one payload':   '\x1b[?1;2c\x1b[0n',
};

// Everything a person can actually cause. `\x1b[13;2u` is deepsteve's own Shift+Enter
// (public/js/terminal.js), and the path list is what file-drop.js sends on a drop.
const INPUT = {
  'a typed command':              'ls -l\r',
  'a bare Enter':                 '\r',
  'one character':                'x',
  'Ctrl+C':                       '\x03',
  'up arrow':                     '\x1b[A',
  'Shift+Enter (CSI u)':          '\x1b[13;2u',
  'F1 (SS3)':                     '\x1bOP',
  'F3 (SS3)':                     '\x1bOR',
  'SGR mouse press':              '\x1b[<0;12;5M',
  'dropped file paths':           ' /tmp/a /tmp/b',
  'a lone ESC':                   '\x1b',
  'nothing at all':               '',
  'a report with a stray byte':   '\x1b[?1;2cq',
  'an unterminated DCS':          '\x1bP1$r0m',
  'an unterminated OSC':          '\x1b]11;?',
  'a report after typing':        'q\x1b[?1;2c',
};

test('the terminal answering a program is not a person typing', () => {
  for (const [what, bytes] of Object.entries(REPORTS)) {
    assert.strictEqual(isTerminalReport(bytes), true, `${what}: ${JSON.stringify(bytes)}`);
  }
});

test('anything a person can cause counts as input', () => {
  for (const [what, bytes] of Object.entries(INPUT)) {
    assert.strictEqual(isTerminalReport(bytes), false, `${what}: ${JSON.stringify(bytes)}`);
  }
});

test('the default is input — an unrecognized escape sequence keeps the tab', () => {
  // The direction matters and is the whole safety argument: getting this wrong toward
  // "report" closes a tab someone was working in, toward "input" only leaves one open.
  assert.strictEqual(isTerminalReport('\x1b[?1;2h'), false, 'a mode SET is not a report');
  assert.strictEqual(isTerminalReport('\x1b_ds\x1b\\'), false, 'APC is not on the list');
  assert.strictEqual(isTerminalReport(undefined), false);
  assert.strictEqual(isTerminalReport(null), false);
  assert.strictEqual(isTerminalReport(123), false);
});

test('a modified F3 is the one accepted collision', () => {
  // xterm sends Shift/Ctrl/Alt+F3 as CSI 1;<mod> R, which is byte-identical to a cursor
  // position report — there is nothing left to tell them apart by. Documented in
  // terminal-input.js; the cost is a run_in_terminal tab closing 20s later than wanted.
  assert.strictEqual(isTerminalReport('\x1b[1;2R'), true);
  assert.strictEqual(isTerminalReport('\x1bOR'), false, 'unmodified F3 is SS3 and unaffected');
});

// --- drift guard ------------------------------------------------------------------
//
// Pinning the list above to a hand-written table would go stale the first time xterm
// grows a reply. So drive xterm itself: `@xterm/headless` is the SAME version
// public/index.html loads (6.0.0), it is a plain-JS dependency that survives the CI
// unit job's --ignore-scripts, and terminal-screen.js already depends on it.

// The probes a terminal is actually asked. tmux fires several of these at every client
// that attaches, which is the path that produced #635 in the first place.
const PROBES = [
  '\x1b[c', '\x1b[0c', '\x1b[>c',        // device attributes
  '\x1b[5n', '\x1b[6n', '\x1b[?6n',      // status and cursor position
  '\x1b[?2004$p', '\x1b[?1049$p', '\x1b[?1$p', // mode queries
  '\x1bP$qm\x1b\\', '\x1bP$q"p\x1b\\',   // DECRQSS
  '\x1b[>q', '\x1b[18t', '\x1b[14t',     // version, window size
  '\x1b]10;?\x07', '\x1b]11;?\x07',      // foreground / background color
];

test('every reply xterm 6 emits is recognized as a report', async () => {
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const replies = [];
  term.onData((d) => replies.push(d));

  for (const probe of PROBES) {
    await new Promise((resolve) => term.write(probe, resolve));
  }
  // The parser answers from a write callback, so give the queue a tick to drain.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(replies.length > 0, 'xterm answered nothing at all — the probes are stale, not the classifier');
  for (const reply of replies) {
    assert.strictEqual(isTerminalReport(reply), true,
      `xterm 6 replies ${JSON.stringify(reply)} and the classifier would call it a keystroke — ` +
      'every run_in_terminal tab leaks again until this reply is added to REPORT_PATTERNS');
  }
});
