// Headless unit test for the terminal pinch-zoom wheel guard (#583).
//
// macOS pinch-zoom is delivered as wheel events with ctrlKey=true, and xterm 6
// cancels every wheel it sees (its mouse-reporting path preventDefaults
// unconditionally) — blocking browser zoom over the terminal and, while
// pinch-zoomed, blocking panning. The guard is a capture-phase listener on
// #terminals that stopPropagation()s ctrl-wheels so they never reach xterm's
// bubble listeners, while never calling preventDefault (the browser's zoom
// default must proceed).
//
// Run: node --test test/unit/terminal-wheel-guard.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../../public/js/terminal.js');

function stubEvent(props) {
  const calls = { stopPropagation: 0, preventDefault: 0 };
  return {
    calls,
    event: {
      ...props,
      stopPropagation: () => { calls.stopPropagation++; },
      preventDefault: () => { calls.preventDefault++; },
    },
  };
}

test('installTerminalWheelGuard registers a capture-phase passive wheel listener', async () => {
  const { installTerminalWheelGuard, handleTerminalWheelCapture } = await load();
  const registered = [];
  installTerminalWheelGuard({ addEventListener: (...args) => registered.push(args) });
  assert.strictEqual(registered.length, 1);
  const [type, handler, opts] = registered[0];
  assert.strictEqual(type, 'wheel');
  assert.strictEqual(handler, handleTerminalWheelCapture);
  assert.deepStrictEqual(opts, { capture: true, passive: true });
});

test('ctrl-wheel (pinch gesture) is stopped, but never preventDefaulted', async () => {
  const { handleTerminalWheelCapture } = await load();
  const { event, calls } = stubEvent({ ctrlKey: true, deltaY: -10 });
  handleTerminalWheelCapture(event);
  assert.strictEqual(calls.stopPropagation, 1);
  assert.strictEqual(calls.preventDefault, 0);
});

test('plain wheel passes through untouched — xterm still scrolls the terminal', async () => {
  const { handleTerminalWheelCapture } = await load();
  const { event, calls } = stubEvent({ ctrlKey: false, deltaY: -10 });
  handleTerminalWheelCapture(event);
  assert.strictEqual(calls.stopPropagation, 0);
  assert.strictEqual(calls.preventDefault, 0);
});
