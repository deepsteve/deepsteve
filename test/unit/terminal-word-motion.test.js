// Headless unit test for macOS ⌥←/⌥→ word motion in a terminal tab (#652).
//
// @xterm/xterm@5.5.0 rewrote Alt+Arrow on macOS — its `case 37` turned ESC[1;3D into
// ESC b, and ESC[1;3C into ESC f. 6.0.0, the build public/index.html loads, deleted that
// remap, so ⌥← started putting the bare CSI form on the wire. The Claude composer parses
// ESC[1;3D as meta+left, but zsh has no binding for it, so the key went dead at a shell
// prompt. terminal.js restores the ESC b / ESC f translation on macOS only.
//
// Run: node --test test/unit/terminal-word-motion.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeTerm } = require('../helpers/fake-xterm.js');

const load = () => import('../../public/js/terminal.js');

const key = (props) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...props });

// setupTerminalIO reads the platform off the global `navigator` at keypress time, and Node
// supplies a real one ('MacIntel' on a mac host, 'Linux x86_64' on the CI runner). Pin it,
// or every wiring assertion below would silently depend on which machine ran the suite.
function usePlatform(platform) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true });
  return () => Object.defineProperty(globalThis, 'navigator', original);
}

// A terminal wired the way app.js wires it, with the wire and the interceptor observable.
// `t` is the test context, so the platform stub is torn down even if an assertion throws.
async function wire(t, { beforeSend, platform = 'MacIntel' } = {}) {
  const { setupTerminalIO } = await load();
  t.after(usePlatform(platform));
  const sent = [];
  const term = fakeTerm(['$ ']);
  let userInput = 0;
  setupTerminalIO(term, { send: (d) => sent.push(d) }, {
    onUserInput: () => { userInput++; },
    beforeSend,
  });
  return { term, sent, userInput: () => userInput };
}

// ------------------------------------------------------- the mapping itself

test('⌥← and ⌥→ map to the meta word-motion sequences on macOS', async () => {
  const { optionArrowSequence } = await load();
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'ArrowLeft' }), true), '\x1bb');
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'ArrowRight' }), true), '\x1bf');
});

test('off macOS nothing is remapped — xterm 6 keeps emitting its CSI form', async () => {
  const { optionArrowSequence } = await load();
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'ArrowLeft' }), false), null);
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'ArrowRight' }), false), null);
});

test('modifier matching is strict, so ⌥ combos other than the bare one pass through', async () => {
  // Same rule as shortcuts.js's modsMatch: an extra modifier means a different key, not
  // a sloppier match. ⌥⇧← must stay ESC[1;4D rather than collapsing into plain word motion.
  const { optionArrowSequence } = await load();
  for (const extra of ['ctrlKey', 'metaKey', 'shiftKey']) {
    const ev = key({ altKey: true, key: 'ArrowLeft', [extra]: true });
    assert.strictEqual(optionArrowSequence(ev, true), null, `⌥+${extra} should pass through`);
  }
});

test('only the horizontal arrows are remapped, and only with ⌥ held', async () => {
  const { optionArrowSequence } = await load();
  // xterm 5 never remapped ⌥↑/⌥↓ on macOS either.
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'ArrowUp' }), true), null);
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'ArrowDown' }), true), null);
  assert.strictEqual(optionArrowSequence(key({ altKey: true, key: 'b' }), true), null);
  assert.strictEqual(optionArrowSequence(key({ key: 'ArrowLeft' }), true), null);
});

test('isMacPlatform prefers userAgentData and falls back to the deprecated platform', async () => {
  const { isMacPlatform } = await load();
  assert.strictEqual(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: '' }), true);
  assert.strictEqual(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.strictEqual(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; ...)' }), true);
  assert.strictEqual(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
  assert.strictEqual(isMacPlatform({ platform: 'Linux x86_64', userAgent: 'X11; Linux' }), false);
  assert.strictEqual(isMacPlatform(null), false);
});

// ------------------------------------------------------ the wiring in setupTerminalIO

test('a ⌥← keydown puts ESC b on the wire and is blocked from xterm', async (t) => {
  const { term, sent, userInput } = await wire(t);
  const handled = term.keyEvent({ ...key({ altKey: true, key: 'ArrowLeft' }), type: 'keydown' });
  assert.deepStrictEqual(sent, ['\x1bb']);
  // false = xterm's own encoder never runs, so no ESC[1;3D follows it.
  assert.strictEqual(handled, false);
  assert.strictEqual(userInput(), 1, 'a word jump is user input — it must cancel auto-close');
});

test('the browser default is cancelled, since returning false skips xterm’s own cancel', async (t) => {
  const { term } = await wire(t);
  term.keyEvent({ ...key({ altKey: true, key: 'ArrowRight' }), type: 'keydown' });
  assert.strictEqual(term.calls.preventDefault, 1);
});

test('the sequence is sent once per press, not again on keyup', async (t) => {
  const { term, sent } = await wire(t);
  const ev = { ...key({ altKey: true, key: 'ArrowLeft' }) };
  assert.strictEqual(term.keyEvent({ ...ev, type: 'keydown' }), false);
  assert.strictEqual(term.keyEvent({ ...ev, type: 'keyup' }), false, 'still blocked from xterm');
  assert.deepStrictEqual(sent, ['\x1bb']);
});

test('nothing leaks back through onData — an arrow produces no textarea input event', async (t) => {
  // Shift+Enter needs a suppressNextEnter flag because a blocked Enter still reaches the
  // hidden textarea and returns as an `input` event. Arrows do not, so a plain arrow that
  // xterm did encode must still reach the wire untouched right after a blocked ⌥←.
  const { term, sent } = await wire(t);
  term.keyEvent({ ...key({ altKey: true, key: 'ArrowLeft' }), type: 'keydown' });
  term.emitData('\x1b[D');
  assert.deepStrictEqual(sent, ['\x1bb', '\x1b[D']);
});

test('an interceptor can consume the word jump, so the # palette does not leak it', async (t) => {
  const seen = [];
  const { term, sent, userInput } = await wire(t, { beforeSend: (d) => { seen.push(d); return true; } });
  term.keyEvent({ ...key({ altKey: true, key: 'ArrowLeft' }), type: 'keydown' });
  assert.deepStrictEqual(seen, ['\x1bb'], 'beforeSend gets the same look as at a real keystroke');
  assert.deepStrictEqual(sent, [], 'consumed — never reaches the PTY');
  assert.strictEqual(userInput(), 0);
});

test('off macOS the handler declines, so xterm keeps encoding Alt+Arrow itself', async (t) => {
  const { term, sent } = await wire(t, { platform: 'Linux x86_64' });
  const handled = term.keyEvent({ ...key({ altKey: true, key: 'ArrowLeft' }), type: 'keydown' });
  assert.strictEqual(handled, true, 'true = xterm handles it — the CSI form still goes out');
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(term.calls.preventDefault, 0);
});

test('Shift+Enter still sends its CSI u sequence and suppresses the leaked \\r', async (t) => {
  // The new branch sits after this one; make sure it did not disturb it.
  const { term, sent } = await wire(t);
  assert.strictEqual(term.keyEvent({ ...key({ shiftKey: true, key: 'Enter' }), type: 'keydown' }), false);
  term.emitData('\r');
  assert.deepStrictEqual(sent, ['\x1b[13;2u']);
});
