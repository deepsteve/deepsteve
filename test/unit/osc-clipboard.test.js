// Headless unit test for the OSC 52 clipboard bridge (#650).
//
// #650 turned tmux's mouse on so the wheel scrolls the terminal instead of walking the
// agent's prompt history. The cost is that a drag over the terminal now belongs to tmux
// or to the pane's program rather than to the browser — they copy into their own buffer
// and report the copy outward as OSC 52, and xterm 6.0.0 has no handler for 52 (it
// registers 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112 and nothing else). Without
// this bridge, selecting text in a terminal would silently copy nothing.
//
// No DOM here: the parser is pure, and createOsc52Handler takes the terminal out of the
// picture by construction, which is what the factory is for.
//
// Run: node --test test/unit/osc-clipboard.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../../public/js/osc-clipboard.js');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('a normal copy decodes to its text', async () => {
  const { parseOsc52 } = await load();
  assert.deepStrictEqual(parseOsc52(`c;${b64('hello')}`), { selection: 'c', text: 'hello' });
});

test('an EMPTY selection is the common case, because that is what tmux emits', async () => {
  // screen_write_setselection(&ctx, "", …) — tmux sends no Pc at all. A parser that
  // required one would drop every copy made in copy-mode, which is the whole point.
  const { parseOsc52 } = await load();
  assert.deepStrictEqual(parseOsc52(`;${b64('hello')}`), { selection: '', text: 'hello' });
});

test('the payload is decoded as UTF-8, not as bytes', async () => {
  // atob() yields BYTES in a JS string, one char per byte. Handing that straight to the
  // clipboard mojibakes every accent, box-drawing glyph and emoji. This is the one
  // assertion that fails against the naive implementation.
  const { parseOsc52 } = await load();
  const text = '✻ café ✔ 🎉';
  assert.strictEqual(parseOsc52(`c;${b64(text)}`).text, text);
});

test('a `?` payload is a clipboard READ and is never answered', async () => {
  // Replying would let anything running in any pane exfiltrate the user's clipboard back
  // over the PTY. xterm ships its own read side disabled for the same reason.
  const { parseOsc52 } = await load();
  assert.strictEqual(parseOsc52('c;?'), null);
  assert.strictEqual(parseOsc52(';?'), null);
});

test('malformed payloads are rejected rather than thrown', async () => {
  const { parseOsc52 } = await load();
  assert.strictEqual(parseOsc52('x;aGk='), null, 'bogus selection char');
  assert.strictEqual(parseOsc52('c;!!!!'), null, 'undecodable base64');
  assert.strictEqual(parseOsc52('aGk='), null, 'no separator at all');
  assert.strictEqual(parseOsc52(''), null);
  assert.strictEqual(parseOsc52(undefined), null);
});

test('the handler always reports "handled", and never returns a thenable', async () => {
  // xterm PAUSES ITS PARSER on a thenable OSC result, so returning a promise here would
  // stall the terminal behind a browser permission prompt. And returning true for the
  // rejected cases is what keeps a `?` or a junk payload from falling through to some
  // future handler.
  const { createOsc52Handler } = await load();
  const handler = createOsc52Handler(() => true, () => {});
  for (const payload of [`c;${b64('hi')}`, 'c;?', 'c;!!!!', '', 'nope']) {
    const ret = handler(payload);
    assert.strictEqual(ret, true, `payload ${JSON.stringify(payload)}`);
    assert.notStrictEqual(typeof ret?.then, 'function');
  }
});

test('the replay guard keeps a scrollback replay from overwriting the clipboard', async () => {
  // The daemon replays a session's whole scrollback on every WebSocket connect, so every
  // OSC 52 the pane ever emitted is re-delivered on a page refresh. Writing the clipboard
  // from a page load nobody asked for would silently eat whatever the user had copied
  // elsewhere meanwhile. A real copy is always downstream of a gesture in the terminal.
  const { createOsc52Handler } = await load();
  const wrote = [];

  const cold = createOsc52Handler(() => false, (t) => wrote.push(t));
  assert.strictEqual(cold(`c;${b64('replayed')}`), true);
  assert.deepStrictEqual(wrote, [], 'an unarmed terminal must write nothing');

  const armed = createOsc52Handler(() => true, (t) => wrote.push(t));
  armed(`c;${b64('copied')}`);
  assert.deepStrictEqual(wrote, ['copied'], 'and exactly once once armed');
});

test('installClipboardOsc arms on a gesture and registers on OSC 52', async () => {
  const { installClipboardOsc } = await load();
  const listeners = [];
  const container = { addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }) };
  let registered = null;
  const term = { parser: { registerOscHandler: (id, fn) => { registered = { id, fn }; } } };

  installClipboardOsc(term, container);

  assert.strictEqual(registered.id, 52);
  assert.deepStrictEqual(listeners.map((l) => l.type).sort(), ['keydown', 'pointerdown']);
  // Both arming listeners must be non-interfering: passive for the pointer, capture for
  // the key (the terminal consumes keydown itself, so a bubble listener would miss it).
  assert.deepStrictEqual(listeners.find((l) => l.type === 'pointerdown').opts, { passive: true });
  assert.deepStrictEqual(listeners.find((l) => l.type === 'keydown').opts, { capture: true });

  // Before any gesture the handler is inert; the write path is only reachable after one.
  assert.strictEqual(registered.fn(`c;${b64('hi')}`), true);
  listeners.find((l) => l.type === 'pointerdown').fn();
  assert.strictEqual(registered.fn('c;?'), true, 'still handled, still no reply');
});

test('installClipboardOsc survives an xterm with no parser API', async () => {
  const { installClipboardOsc } = await load();
  assert.doesNotThrow(() => installClipboardOsc({}, null));
});
