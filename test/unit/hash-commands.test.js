// Headless unit test for public/js/hash-commands.js — the # activation gate (#589).
//
// The gate used to hang off a sticky `lineHasContent` boolean that only ever
// reset on Enter or a busy→waiting transition, so clearing the input line any
// other way (backspace, Ctrl+C, Ctrl+U, Escape, word-kill) left it stuck true
// and # went dead until some later state change happened to reset it. That is
// the "# works inconsistently" report. It now mirrors the line as `lineText`
// and gates on `lineText === ''`.
//
// No browser, no Docker: hash-commands.js has no imports and touches only
// document.createElement, so a tiny fake element is the whole stub. Each test
// re-imports the module with a unique ?query so its module-level state
// (lineText, active, buffer, lockedCommand) starts fresh.
//
// Run: node --test test/unit/hash-commands.test.js

const { test } = require('node:test');
const assert = require('node:assert');

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

let importCount = 0;

async function setup() {
  const calls = [];  // [id, arg?] per executed hash command

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
  // One data chunk, exactly as terminal.js hands it over. Returns true when
  // hash-commands consumed the keystroke (so it never reaches the PTY).
  const key = (data) => mod.beforeSend(data, container);
  // A run of individual keystrokes.
  const type = (str) => { for (const ch of str) key(ch); };

  return { mod, calls, key, type };
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

test('# activates after a busy→waiting transition (#371 regression)', async () => {
  const { mod, key, type } = await setup();
  type('x');
  mod.setWaitingForInput(true);
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
