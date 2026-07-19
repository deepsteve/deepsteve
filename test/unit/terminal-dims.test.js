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

// --- resizeTerminal (#590) ---
//
// The counterpart to fitTerminal for a container with no layout box: FitAddon
// measures the parent's computed height, which is `auto` on a display:none
// element, so fit() returns having done nothing. Overview mode shrinks every tab
// in its grid and all but one are hidden by the time it exits, so those have to
// be handed their dimensions back explicitly.

const fakeTerm = (cols, rows) => ({
  cols, rows,
  resized: [],
  resize(c, r) { this.cols = c; this.rows = r; this.resized.push([c, r]); },
});
const fakeWs = () => ({ sent: [], send(s) { this.sent.push(JSON.parse(s)); } });

test('resizeTerminal restores the grid and tells the server', async () => {
  const { resizeTerminal } = await load();
  const term = fakeTerm(40, 12);
  const ws = fakeWs();
  resizeTerminal(term, ws, 200, 50);
  assert.deepStrictEqual(term.resized, [[200, 50]]);
  assert.deepStrictEqual(ws.sent, [{ type: 'resize', cols: 200, rows: 50 }]);
});

test('resizeTerminal still resizes the PTY when the xterm already matches', async () => {
  const { resizeTerminal } = await load();
  const term = fakeTerm(200, 50);
  const ws = fakeWs();
  resizeTerminal(term, ws, 200, 50);
  // No client-side resize needed, but the PTY may have been shrunk while the tab
  // was hidden — the resize message is not conditional on the xterm changing.
  assert.deepStrictEqual(term.resized, []);
  assert.deepStrictEqual(ws.sent, [{ type: 'resize', cols: 200, rows: 50 }]);
});

test('resizeTerminal ignores missing/invalid dims', async () => {
  const { resizeTerminal } = await load();
  for (const [c, r] of [[0, 50], [200, 0], [NaN, 50], [undefined, 50], [-5, 50]]) {
    const term = fakeTerm(40, 12);
    const ws = fakeWs();
    resizeTerminal(term, ws, c, r);
    assert.deepStrictEqual(term.resized, [], `resized for ${c}x${r}`);
    assert.deepStrictEqual(ws.sent, [], `sent for ${c}x${r}`);
  }
});
