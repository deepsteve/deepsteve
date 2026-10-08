// Unit tests for the keystroke/report classifier (#635).
//
// The bug this guards against is silent in both directions, which is why the drift guard
// at the bottom exists: a report the classifier stops recognizing puts back the leak
// (every run_in_terminal tab claimed by a keystroke nobody pressed), and a keystroke it
// starts recognizing closes a tab someone was working in.
const { test } = require('node:test');
const assert = require('node:assert');

const { isTerminalReport, isPointerReport, hasSubmitKey } = require('../../terminal-input');

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
  'SGR mouse wheel (#650)':       '\x1b[<64;12;5M',
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

// --- isPointerReport (#724) ---------------------------------------------------------
//
// A click, a wheel notch or a focus change. A person caused it, so it is still input —
// but it must not cancel a pending auto-close, which is what scrolling up to read a
// finished agent's summary used to do. server.js only gates the cancel on this.

const POINTER = {
  'one wheel notch, as captured from the live UI (12 bytes)': '\x1b[<64;66;26M',
  'one click, as captured from the live UI (11 bytes)':       '\x1b[<0;66;26M',
  'a button release':                                         '\x1b[<0;66;26m',
  'wheel down':                                               '\x1b[<65;1;1M',
  'a modified click':                                         '\x1b[<16;200;300M',
  'several notches in one payload':                           '\x1b[<64;66;26M\x1b[<64;66;26M\x1b[<64;66;26M',
  'focus in':                                                 '\x1b[I',
  'focus out':                                                '\x1b[O',
  'focus in, then a click':                                   '\x1b[I\x1b[<0;10;5M',
};

const NOT_POINTER = {
  'a printable key':                 'a',
  'Enter':                           '\r',
  'an arrow':                        '\x1b[A',
  'a lone ESC':                      '\x1b',
  'nothing at all':                  '',
  'a click, then a keystroke':       '\x1b[<0;66;26Ma',
  'a keystroke, then a click':       'a\x1b[<0;66;26M',
  'an unterminated mouse report':    '\x1b[<64;66',
  'a mouse report with no final':    '\x1b[<64;66;26',
  'legacy X10 mouse encoding':       '\x1b[M`!!',
  'a terminal report':               '\x1b[?1;2c',
  'Shift+Tab':                       '\x1b[Z',
};

test('a click, a scroll or a focus change is a pointer report', () => {
  for (const [what, bytes] of Object.entries(POINTER)) {
    assert.strictEqual(isPointerReport(bytes), true, `${what}: ${JSON.stringify(bytes)}`);
  }
});

test('one byte of anything else makes the payload a keystroke, which still cancels', () => {
  // Same safe direction as isTerminalReport: getting this wrong toward "pointer" lets a
  // tab someone typed in close under them; toward "keystroke" only leaves one open.
  for (const [what, bytes] of Object.entries(NOT_POINTER)) {
    assert.strictEqual(isPointerReport(bytes), false, `${what}: ${JSON.stringify(bytes)}`);
  }
  assert.strictEqual(isPointerReport(undefined), false);
  assert.strictEqual(isPointerReport(null), false);
  assert.strictEqual(isPointerReport(123), false);
});

test('a pointer report is NOT a terminal report', () => {
  // The two are kept apart on purpose. A terminal report skips the #512 inputBlocked drop
  // and never stamps lastInputTime; a person's click must do neither — a wheel notch that
  // reached tmux mid-injection would put the pane in copy-mode and swallow the Enter.
  for (const [what, bytes] of Object.entries(POINTER)) {
    assert.strictEqual(isTerminalReport(bytes), false, `${what}: ${JSON.stringify(bytes)}`);
  }
});

test('every mouse report xterm 6 encodes is recognized as a pointer report', async () => {
  // The drift guard for this half, same reasoning as the one above: drive xterm's own SGR
  // encoder rather than trust a hand-written table. Headless has no DOM to click, so this
  // reaches the encoder directly — a private API, so its absence fails loudly rather
  // than passing vacuously. (Focus reports are two fixed literals in xterm's browser
  // build, and headless has no focus; they are covered by the table above.)
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const out = [];
  term.onData((d) => out.push(d));
  // What tmux asks the outer terminal for when mouse mode is on: button tracking + SGR.
  await new Promise((resolve) => term.write('\x1b[?1000h\x1b[?1006h', resolve));

  const mouse = term._core && term._core.coreMouseService;
  assert.ok(mouse && typeof mouse.triggerMouseEvent === 'function',
    'xterm no longer exposes coreMouseService.triggerMouseEvent — re-point this drift guard');
  const base = { col: 65, row: 25, x: 0, y: 0, ctrl: false, alt: false, shift: false };
  for (const ev of [
    { button: 4, action: 0 }, // wheel up
    { button: 4, action: 1 }, // wheel down
    { button: 0, action: 1 }, // left press
    { button: 0, action: 0 }, // left release
    { button: 2, action: 1, ctrl: true }, // modified right press
  ]) {
    mouse.triggerMouseEvent({ ...base, ...ev });
  }

  assert.strictEqual(out.length, 5, `xterm encoded ${out.length} of 5 mouse events: ${JSON.stringify(out)}`);
  assert.strictEqual(out[0], '\x1b[<64;66;26M', 'the wheel notch captured from the live UI');
  for (const report of out) {
    assert.strictEqual(isPointerReport(report), true,
      `xterm 6 encodes ${JSON.stringify(report)} and the classifier would call it a keystroke — ` +
      'a click in a merged tab cancels its auto-close again until POINTER_PATTERNS covers it');
  }
});

// --- hasSubmitKey (#710) ------------------------------------------------------------
//
// Whether a person SUBMITTED something. Inbox treats that as a reply that supersedes the
// session's open questions, so a newline that is not Enter must not count.

test('an Enter a person pressed is a submit key', () => {
  for (const bytes of ['\r', 'ls -l\r', '\x1b[A\r', '\x1b[200~pasted\x1b[201~\r']) {
    assert.strictEqual(hasSubmitKey(bytes), true, JSON.stringify(bytes));
  }
});

test('newlines that are not Enter, and keys that are not Enter, are not submit keys', () => {
  const NOT = {
    'a keystroke':                     'x',
    'Shift+Enter (CSI u)':             '\x1b[13;2u',
    'Alt+Enter':                       '\x1b\r',
    'Ctrl+J':                          '\n',
    'an arrow':                        '\x1b[B',
    'a bracketed paste with newlines': '\x1b[200~one\rtwo\r\x1b[201~',
    'an unterminated bracketed paste': '\x1b[200~one\rtwo\r',
    'a terminal report':               '\x1b[?1;2c',
    'nothing at all':                  '',
    'not a string':                    13,
  };
  for (const [what, bytes] of Object.entries(NOT)) {
    assert.strictEqual(hasSubmitKey(bytes), false, `${what}: ${JSON.stringify(bytes)}`);
  }
});
