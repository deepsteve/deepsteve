/**
 * A minimal stand-in for an xterm Terminal, for unit tests that read the buffer.
 *
 * Covers what `public/js/composer-caret.js` (and therefore the # activation gate in
 * `public/js/hash-commands.js`) asks of a terminal: `buffer.active` with `baseY` /
 * `length` / `cursorX` / `cursorY` / `getLine`,
 * `IBufferLine.translateToString(trimRight, startColumn, endColumn)`, and
 * `onWriteParsed`.
 *
 * It also covers the input surface `public/js/terminal.js`'s `setupTerminalIO()` binds:
 * `onData` and `attachCustomKeyEventHandler`, plus the viewport methods its returned
 * helpers call. `emitData(str)` and `keyEvent(props)` are the test controls that drive
 * them — `keyEvent` returns what the handler returned, so a test can assert that a key
 * was blocked from reaching xterm's own encoder.
 *
 * Rows are padded to `cols` the way a real buffer is, so a translateToString whose
 * endColumn runs past the text returns the padding rather than a short string —
 * which is what makes "the caret sits two columns after the prompt glyph" behave
 * the same here as it does in a browser.
 */

/**
 * @param {string[]} rows                 The visible frame, oldest first.
 * @param {object}   [opts]
 * @param {number}   [opts.cursorX]       Column, relative to the row.
 * @param {number}   [opts.cursorY]       Row, relative to baseY (as xterm reports it).
 * @param {string[]} [opts.scrollback]    Rows above the frame; sets baseY.
 * @param {number}   [opts.trailingBlanks] Blank rows below the frame.
 * @param {number}   [opts.cols]
 * @returns {object} An xterm-shaped terminal, plus `setScreen` / `setCursor` /
 *                   `writeParsed` test controls.
 */
function fakeTerm(rows = [], { cursorX = 0, cursorY = 0, scrollback = [], trailingBlanks = 0, cols = 100 } = {}) {
  const state = { rows: [...rows], scrollback: [...scrollback], trailingBlanks, cursorX, cursorY };
  const listeners = [];
  const dataListeners = [];
  const calls = { preventDefault: 0, scrollToBottom: 0, scrollLines: [], refresh: [] };
  let keyHandler = null;
  const all = () => [...state.scrollback, ...state.rows, ...Array(state.trailingBlanks).fill('')];

  const term = {
    cols,
    buffer: {
      active: {
        get baseY() { return state.scrollback.length; },
        get length() { return all().length; },
        get cursorX() { return state.cursorX; },
        get cursorY() { return state.cursorY; },
        getLine(y) {
          const lines = all();
          if (y < 0 || y >= lines.length) return undefined;
          const text = lines[y].padEnd(cols, ' ');
          return {
            translateToString(trimRight, start = 0, end = undefined) {
              const slice = text.slice(start, end === undefined ? text.length : end);
              return trimRight ? slice.replace(/\s+$/, '') : slice;
            },
          };
        },
      },
    },
    onWriteParsed(cb) {
      listeners.push(cb);
      return { dispose() { listeners.splice(listeners.indexOf(cb), 1); } };
    },

    // ---- input surface (setupTerminalIO)
    /** xterm's viewport height, which for this stub is the frame it was given. */
    get rows() { return state.rows.length; },
    onData(cb) {
      dataListeners.push(cb);
      return { dispose() { dataListeners.splice(dataListeners.indexOf(cb), 1); } };
    },
    attachCustomKeyEventHandler(cb) { keyHandler = cb; },
    scrollToBottom() { calls.scrollToBottom++; },
    scrollLines(n) { calls.scrollLines.push(n); },
    refresh(from, to) { calls.refresh.push([from, to]); },

    // ---- test controls
    setScreen(next) { state.rows = [...next]; },
    setCursor(x, y) { state.cursorX = x; state.cursorY = y; },
    /** Simulate a repaint: what the real terminal fires after parsing a write. */
    writeParsed() { for (const cb of [...listeners]) cb(); },
    /** Simulate xterm's own encoder emitting bytes for a keystroke. */
    emitData(str) { for (const cb of [...dataListeners]) cb(str); },
    /** Feed a KeyboardEvent-shaped object to the custom key handler. */
    keyEvent(props) {
      const event = { type: 'keydown', preventDefault() { calls.preventDefault++; }, ...props };
      return keyHandler ? keyHandler(event) : undefined;
    },
    calls,
  };
  return term;
}

module.exports = { fakeTerm };
