// Headless unit test for public/js/hash-commands.js — the # activation gate.
//
// #589: the gate used to hang off a sticky `lineHasContent` boolean that only ever
// reset on Enter or a busy→waiting transition, so clearing the input line any
// other way (backspace, Ctrl+C, Ctrl+U, Escape, word-kill) left it stuck true
// and # went dead until some later state change happened to reset it. That is
// the "# works inconsistently" report. It became a mirror of the line, `lineText`,
// gated on `lineText === ''`.
//
// #634: that mirror was the wrong authority. It was module-global (so it leaked
// across tabs), it had no concept of the caret, and setWaitingForInput(true) wiped
// it unconditionally — on every tab switch and reconnect, and on any working→waiting
// edge, even though the screen classifier reports a composed-but-unsent message as
// "waiting" by design. A # typed mid-message therefore opened the palette and
// swallowed the keystroke. The gate now ANDs the mirror (per terminal, and only a
// guard for the un-echoed window) with a live read of the xterm buffer, so most of
// what follows is driven by a fake terminal showing a real composer fixture.
//
// No browser, no Docker: hash-commands.js touches only document.createElement, so a
// tiny fake element is the whole DOM stub, and the terminal is test/helpers/fake-xterm.
// Each test re-imports the module with a unique ?query so its module-level state
// (active, buffer, lockedCommand) starts fresh.
//
// Run: node --test test/unit/hash-commands.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { fakeTerm } = require('../helpers/fake-xterm');
const SCREENS = require('./fixtures/composer-screens');

// ---------------------------------------------------------------- fake globals

// Everything hash-commands.js asks of a DOM node. classList/dataset/getElementById
// are deliberately absent — the module never reaches for them. querySelector
// returning null makes renderList()'s `if (sel)` guard skip scrollIntoView.
function fakeElement() {
  const el = {
    className: '', textContent: '', innerHTML: '',
    style: {},
    children: [],
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    addEventListener() {},
    querySelector() { return null; },
    scrollIntoView() {},
  };
  return el;
}

globalThis.document = { createElement: () => fakeElement() };

// A controllable clock for the echo grace. Offsetting the real clock rather than
// replacing it keeps Date.now monotonic for anything else that reads it.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

let importCount = 0;

/**
 * @param {object}   [opts]
 * @param {string[]} [opts.screen]  Composer fixture the fake terminal shows. Default
 *                                  is a blank buffer, which reads 'unknown' — the
 *                                  shell-tab / unreadable-TUI case, where the gate
 *                                  falls back to the keystroke mirror alone.
 */
async function setup({ screen = [] } = {}) {
  const calls = [];  // [id, arg?] per executed hash command
  clockOffset = 0;

  const url = new URL('../../public/js/hash-commands.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);

  mod.init({
    quickNewTerminal: () => calls.push(['terminal']),
    renameActiveTab: (name) => calls.push(['tab', name]),
    closeActiveTab: () => calls.push(['close']),
    openSettings: () => calls.push(['settings']),
    openMods: () => calls.push(['mods']),
    focusTerminal: () => {},  // deactivate() calls this
  });

  const container = fakeElement();
  const term = fakeTerm(screen);
  // One data chunk, exactly as terminal.js hands it over. Returns true when
  // hash-commands consumed the keystroke (so it never reaches the PTY).
  const key = (data) => mod.beforeSend(data, container, term);
  // A run of individual keystrokes.
  const type = (str) => { for (const ch of str) key(ch); };
  // Let a keystroke's echo land: a repaint, then past the grace window. Only after
  // this may a screen that reads 'empty' overrule a non-empty mirror.
  const settle = () => { term.writeParsed(); clockOffset += 1000; };

  return { mod, calls, key, type, term, settle };
}

// ------------------------------------------------------- baseline: still works

test('#terminal + Enter executes the command', async () => {
  const { calls, key, type } = await setup();
  type('#terminal');
  key('\r');
  assert.deepStrictEqual(calls, [['terminal']]);
});

test('#tab myname + Enter passes the argument through', async () => {
  const { calls, key, type } = await setup();
  type('#tab myname');
  key('\r');
  assert.deepStrictEqual(calls, [['tab', 'myname']]);
});

// ------------------------------------------- #591: the leading-space form works
//
// `# terminal` is the muscle-memory form (Claude Code's memory feature uses
// `# `). The space used to land in the buffer as a leading char, which broke
// the substring filter, the space-lock, and the batched branch alike — the
// overlay went empty and the text was silently discarded.

test('# terminal (leading space) + Enter executes the command', async () => {
  const { calls, key, type } = await setup();
  type('# terminal');
  key('\r');
  assert.deepStrictEqual(calls, [['terminal']]);
});

test('# terminal (leading space) executes on the trailing space', async () => {
  const { calls, type } = await setup();
  type('# terminal ');
  assert.deepStrictEqual(calls, [['terminal']]);
});

test('#   tab (multiple leading spaces) still locks the command', async () => {
  const { calls, key, type } = await setup();
  type('#   tab myname');
  key('\r');
  assert.deepStrictEqual(calls, [['tab', 'myname']]);
});

test('pasted "# terminal\\r" executes the command', async () => {
  const { calls, key } = await setup();
  assert.strictEqual(key('# terminal\r'), true);
  assert.deepStrictEqual(calls, [['terminal']]);
});

test('pasted "# tab myname\\r" passes the argument through', async () => {
  const { calls, key } = await setup();
  assert.strictEqual(key('# tab myname\r'), true);
  assert.deepStrictEqual(calls, [['tab', 'myname']]);
});

// --------------------------------------- the gate still guards mid-line hashes

test('# typed mid-word is NOT intercepted — forwarded to the PTY', async () => {
  const { key, type } = await setup();
  type('abc');
  assert.strictEqual(key('#'), false);
});

test('# stays blocked while the line is only partially backspaced', async () => {
  const { key, type } = await setup();
  type('ab');
  key('\x7f');                          // one backspace: 'a' remains
  assert.strictEqual(key('#'), false);
});

test('# stays blocked when word-kill leaves text behind', async () => {
  const { key, type } = await setup();
  type('foo bar');
  key('\x17');                          // Ctrl+W kills 'bar', 'foo ' remains
  assert.strictEqual(key('#'), false);
});

// ------------------------------------------ #589: the gate recovers on a clear

test('# activates after backspacing the line to empty', async () => {
  const { key, type } = await setup();
  type('x');
  key('\x7f');
  assert.strictEqual(key('#'), true);
});

test('# activates after Ctrl+C clears the line', async () => {
  const { key, type } = await setup();
  type('x');
  key('\x03');
  assert.strictEqual(key('#'), true);
});

test('# activates after Ctrl+U clears the line', async () => {
  const { key, type } = await setup();
  type('x');
  key('\x15');
  assert.strictEqual(key('#'), true);
});

test('# activates after Escape clears the composer', async () => {
  const { key, type } = await setup();
  type('x');
  key('\x1b');
  assert.strictEqual(key('#'), true);
});

test('# activates after Ctrl+W kills the only word', async () => {
  const { key, type } = await setup();
  type('hello');
  key('\x17');
  assert.strictEqual(key('#'), true);
});

test('# activates after Option+Delete kills the only word', async () => {
  const { key, type } = await setup();
  type('hello');
  key('\x1b\x7f');
  assert.strictEqual(key('#'), true);
});

test('# re-arms on a busy→waiting transition when the composer reads empty (#371, #634)', async () => {
  const { mod, key, type, settle } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  type('x');
  mod.setWaitingForInput(true);
  settle();
  assert.strictEqual(key('#'), true);
});

test('a command runs end-to-end after the line was cleared', async () => {
  const { calls, key, type } = await setup();
  type('x');
  key('\x7f');
  type('#close');
  key('\r');
  assert.deepStrictEqual(calls, [['close']]);
});

// ------------------------------------------------------- cursor keys are inert

test('arrow keys do not disturb the empty-line gate', async () => {
  const { key } = await setup();
  key('\x1b[A');
  key('\x1b[B');
  assert.strictEqual(key('#'), true);
});

// ------------------------------------------------ #634: the screen is the authority
//
// Every case below is one the keystroke mirror alone gets wrong, because the mirror
// is empty: the text was staged before this tab existed, or the wipe forgot it, or
// the caret moved with keys the mirror never tracked.

test('# is NOT intercepted when the composer holds a staged draft (#634)', async () => {
  const { key } = await setup({ screen: SCREENS.STAGED_DRAFT });
  // No keystrokes at all — exactly the case an untracked arrow key or a wiped
  // mirror produces. Only the screen read can catch it.
  assert.strictEqual(key('#'), false);
});

test('setWaitingForInput no longer forgets a staged draft (#634)', async () => {
  const { mod, key, type, settle } = await setup({ screen: SCREENS.STAGED_DRAFT });
  type('x');
  mod.setWaitingForInput(true);   // tab switch, reconnect, or a working→waiting edge
  settle();
  assert.strictEqual(key('#'), false);
});

test('# is NOT intercepted mid-draft even in a batched paste (#634)', async () => {
  const { calls, key } = await setup({ screen: SCREENS.STAGED_DRAFT });
  assert.strictEqual(key('#terminal\r'), false);
  assert.deepStrictEqual(calls, []);
});

test('# activates on an empty composer', async () => {
  const { key } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  assert.strictEqual(key('#'), true);
});

test('# activates on an empty composer showing its placeholder hint', async () => {
  const { key } = await setup({ screen: SCREENS.PLACEHOLDER_COMPOSER });
  assert.strictEqual(key('#'), true);
});

test('a submitted prompt still on screen does not block # (#634)', async () => {
  // The transcript echo below an empty composer must not read as staged text —
  // otherwise # would go dead for the rest of the session.
  const { key } = await setup({ screen: SCREENS.SUBMITTED_TRANSCRIPT_ECHO });
  assert.strictEqual(key('#'), true);
});

test('an unreadable screen falls back to the mirror', async () => {
  // A full-screen TUI or a startup banner: the read says nothing, so the mirror
  // decides — i.e. the pre-#634 behavior, which is what keeps # working in shells.
  const { key, type } = await setup({ screen: SCREENS.STARTUP_BANNER });
  assert.strictEqual(key('#'), true);
  const second = await setup({ screen: SCREENS.STARTUP_BANNER });
  second.type('abc');
  assert.strictEqual(second.key('#'), false);
});

// --------------------------------------------------- #634: the echo-race guard

test('a character typed but not yet echoed still blocks # ', async () => {
  // The composer reads empty only because the keystroke has not round-tripped.
  const { key, type } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  type('x');
  assert.strictEqual(key('#'), false);
});

test('a repaint inside the grace window is not enough to clear the mirror', async () => {
  const { key, type, term } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  type('x');
  term.writeParsed();
  clockOffset += 100;                  // still under ECHO_GRACE_MS
  assert.strictEqual(key('#'), false);
});

test('the grace window alone is not enough — a repaint is required too', async () => {
  const { key, type } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  type('x');
  clockOffset += 1000;                 // past the grace, but nothing came back
  assert.strictEqual(key('#'), false);
});

test('a stale mirror is resynced once the echo has settled', async () => {
  // Something we never saw cleared the composer (/clear, a server-injected prompt).
  // Without this resync, # would stay dead for the rest of the session.
  const { key, type, settle } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  type('x');
  settle();
  assert.strictEqual(key('#'), true);
});

test('a dead PTY still lets # through after the stale escape', async () => {
  const { key, type } = await setup({ screen: SCREENS.EMPTY_COMPOSER });
  type('x');
  clockOffset += 5000;                 // no repaint will ever come
  assert.strictEqual(key('#'), true);
});

// ------------------------------------------------ #634: the mirror is per-terminal

test('text typed in one tab does not block # in another', async () => {
  const { mod } = await setup();
  const [cA, cB] = [fakeElement(), fakeElement()];
  const [tA, tB] = [fakeTerm(), fakeTerm()];
  mod.beforeSend('x', cA, tA);
  assert.strictEqual(mod.beforeSend('#', cB, tB), true);
});

test('a tab switch does not carry one tab’s draft into another', async () => {
  const { mod } = await setup();
  const [cA, cB] = [fakeElement(), fakeElement()];
  const tA = fakeTerm(SCREENS.STAGED_DRAFT);
  const tB = fakeTerm(SCREENS.EMPTY_COMPOSER);
  assert.strictEqual(mod.beforeSend('#', cA, tA), false);   // staged in A
  assert.strictEqual(mod.beforeSend('#', cB, tB), true);    // empty in B
});

// ------------------------------------------------------------- dismiss() (#634)

test('dismiss closes an open palette', async () => {
  const { mod, key } = await setup();
  assert.strictEqual(key('#'), true);
  assert.strictEqual(key('t'), true);       // consumed while active
  mod.dismiss();
  assert.strictEqual(key('t'), false);      // no longer consumed
});

test('dismiss on a closed palette is a no-op', async () => {
  const { mod, key } = await setup();
  mod.dismiss();
  assert.strictEqual(key('#'), true);
});
