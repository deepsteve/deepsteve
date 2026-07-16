// Headless unit test for createTerminal() dimension threading (#566).
//
// On page refresh the terminal container is still display:none, so FitAddon
// can't size the xterm before the server replays scrollback into it. Leaving it
// at xterm's 80×24 default garbles Ink's cursor-addressed frames. createTerminal
// now takes the already-measured {cols, rows} and passes them to the Terminal
// constructor so the replay lands in the correct grid.
//
// The module reads getComputedStyle(document.documentElement) and constructs a
// global `Terminal` + `FitAddon.FitAddon`, so those are stubbed as recorders.
// The import also pulls in shortcuts.js (registerInfo at module scope), which is
// pure (pushes to an array) and needs no DOM.
//
// Run: node --test test/unit/terminal-dims.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let lastTerminalOpts = null;

globalThis.Terminal = class {
  constructor(opts) {
    lastTerminalOpts = opts;
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
  }
  loadAddon() {}
  open() {}
};
globalThis.FitAddon = { FitAddon: class { fit() {} } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.document = { documentElement: {} };

const stubContainer = () => ({ addEventListener: () => {} });
const load = () => import('../../public/js/terminal.js');

test('createTerminal passes measured cols/rows to the Terminal constructor', async () => {
  const { createTerminal } = await load();
  lastTerminalOpts = null;
  createTerminal(stubContainer(), { cols: 217, rows: 57 });
  assert.strictEqual(lastTerminalOpts.cols, 217);
  assert.strictEqual(lastTerminalOpts.rows, 57);
});

test('createTerminal omits cols/rows when no dims given — xterm keeps its 80×24 default', async () => {
  const { createTerminal } = await load();
  lastTerminalOpts = null;
  createTerminal(stubContainer());
  assert.strictEqual('cols' in lastTerminalOpts, false);
  assert.strictEqual('rows' in lastTerminalOpts, false);
});

test('createTerminal ignores invalid dims (0, NaN, undefined, negative)', async () => {
  const { createTerminal } = await load();
  for (const dims of [{ cols: 0, rows: 24 }, { cols: 80, rows: 0 }, { cols: NaN, rows: 24 }, { cols: 80, rows: undefined }, { cols: -5, rows: 24 }]) {
    lastTerminalOpts = null;
    createTerminal(stubContainer(), dims);
    assert.strictEqual('cols' in lastTerminalOpts, false, `cols leaked for ${JSON.stringify(dims)}`);
    assert.strictEqual('rows' in lastTerminalOpts, false, `rows leaked for ${JSON.stringify(dims)}`);
  }
});
