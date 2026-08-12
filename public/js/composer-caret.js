/**
 * Client-side input-line reader (#634) — "is the agent's input line genuinely empty?"
 *
 * The hash-command palette (`hash-commands.js`) fires on `#` typed at the start of
 * an empty input line. It used to decide that from a hand-maintained keystroke
 * mirror, which any untracked event desynchronized — a tab switch, a reconnect, a
 * `working→waiting` edge, an arrow key. The result was a `#` typed mid-message
 * opening the palette and swallowing the keystroke. The browser can just look at
 * the screen instead: xterm IS the emulator, so `term.buffer.active` is the
 * interpreted frame, cursor included.
 *
 * Two reads, each used only where it is trustworthy:
 *
 *   1. THE COMPOSER BOX (agent tabs). Claude/Ink draw a bordered input box; its
 *      contents answer the question outright, and an empty box implies the caret is
 *      at its front, so no cursor is needed. This matters: Claude renders its own
 *      inverse-video cursor (see `cursorBlink: false` in terminal.js), so the
 *      hardware cursor is parked wherever Ink's last frame write ended and is not
 *      a reliable pointer into the composer.
 *
 *   2. THE CARET ROW (shell tabs). There is no box, but readline does park the real
 *      cursor at the input position, so text between the prompt sigil and the caret
 *      — or any text to its right — means the line is not empty. This read may
 *      return 'busy' or 'unknown' but NEVER 'empty': a shell prompt is arbitrary
 *      text (`echo foo > ` ends in a sigil and would read as an empty prompt), and
 *      'empty' is what licenses clearing the keystroke mirror. Restricting it to
 *      the blocking direction means it can only ever veto an activation the mirror
 *      already permitted.
 *
 * 'unknown' is not a failure — a startup banner, a full-screen TUI, a permission
 * dialog and a plain shell prompt all land there, and the caller falls back to its
 * keystroke mirror, i.e. the pre-#634 behavior. Nothing here ever makes the palette
 * fire where it did not before.
 *
 * PROVENANCE: `readComposerDraft` and everything above it is a port of the
 * server-side `composer-state.js` (root-level CommonJS, unreachable from the
 * browser — Express serves only `public/`, and release.sh embeds the two trees in
 * separate loops). The duplication is pinned by an agreement test in
 * `test/unit/composer-caret.test.js` that runs every fixture through both copies
 * and asserts identical output. Fix a parsing bug in `composer-state.js` first,
 * then mirror it here; the test will tell you if you forget.
 */

// The composer prompt glyph. `❯` is current Claude Code; `>` and `›` cover older
// builds and other Ink apps.
const PROMPT_GLYPH_RE = /^[ \t]*(?:[│┃|][ \t]?)?([❯›>])[ \t]?(.*)$/;

// A horizontal rule — the composer box's top/bottom border, drawn either as a bare
// rule or as the top/bottom edge of a rounded box.
const BOX_CHARS = '\\s│┃|╭╮╰╯┌┐└┘├┤';
const RULE_RE = new RegExp(`^[${BOX_CHARS}]*[─━═_-]{6,}[${BOX_CHARS}]*$`);

// Selection-dialog tells. Their presence anywhere near the candidate line means
// the `❯` we found is a menu cursor, not a composer.
const MENU_MARKER_RE = /Enter to select|Do you want to\b|Esc to cancel\b|Tab to switch questions\b/i;

// A menu option body: "1. Yes", "2. Minimal".
const MENU_OPTION_RE = /^\d+\.\s/;

// The rotating placeholder Claude Code draws in an EMPTY composer.
const PLACEHOLDER_RE = /^try\s+["'“”]/i;

// How far past the candidate line to look for menu markers.
const MENU_LOOKAHEAD = 6;

// One viewport is all the composer needs — matches SUBMIT_TIMINGS.screenLines
// server-side, so both readers see the same amount of frame.
const FRAME_LINES = 40;

// The tail of a shell prompt, and whatever the user has typed after it. Greedy
// `.*` backtracks to the LAST sigil on the row, so a `>` inside a path or an
// earlier `%` can't be mistaken for the prompt. `#` is deliberately NOT a sigil
// here even though it is the root prompt: a literal `# ` the user just typed would
// otherwise read as an empty prompt, which is the exact bug this file exists to fix.
const PROMPT_TAIL_RE = /^.*[❯›>$%][ \t]*(.*)$/;

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// Strip box side-borders and surrounding whitespace from a wrapped continuation row.
function stripBorders(line) {
  return String(line == null ? '' : line).replace(/^[ \t]*[│┃|][ \t]?/, '').replace(/[ \t]*[│┃|][ \t]*$/, '');
}

/**
 * Read the draft currently staged in the agent's composer.
 *
 * @param {string[]} lines  Interpreted screen lines, oldest first.
 * @returns {string|null}   The draft ('' when the composer is empty), or null when
 *                          no composer could be located — a startup banner, a
 *                          full-screen TUI, or a selection menu. Callers must
 *                          treat null as "don't know", never as "empty".
 */
export function readComposerDraft(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PROMPT_GLYPH_RE.exec(lines[i]);
    if (!m) continue;

    const head = stripBorders(m[2]).trim();

    // A numbered body is a menu option, and so is a `❯` sitting among dialog
    // markers. Bail out entirely rather than scanning further up: a dialog is
    // drawn OVER the composer, so whatever is above it isn't current.
    if (MENU_OPTION_RE.test(head)) return null;
    for (let j = i + 1; j < lines.length && j <= i + MENU_LOOKAHEAD; j++) {
      if (MENU_MARKER_RE.test(lines[j])) return null;
    }

    // A multi-line draft may be drawn with the glyph repeated on EVERY row (rather
    // than only the first), so walk up through the contiguous run. Contiguity is
    // what keeps the transcript echo of an already-submitted prompt out of the
    // draft: a rule or any ordinary line breaks the run.
    let top = i;
    while (top > 0 && PROMPT_GLYPH_RE.test(lines[top - 1])) top--;

    // Wrapped rows below, but only when a closing rule proves where the box ends.
    // Without that boundary the lines under the glyph are footer, not draft.
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (RULE_RE.test(lines[j])) { close = j; break; }
      if (stripBorders(lines[j]).trim() === '') break;
    }

    const parts = [];
    for (let j = top; j <= i; j++) parts.push(stripBorders(PROMPT_GLYPH_RE.exec(lines[j])[2]).trim());
    for (let j = i + 1; j < close; j++) parts.push(stripBorders(lines[j]).trim());

    const draft = norm(parts.join(' '));
    return PLACEHOLDER_RE.test(draft) ? '' : draft;
  }

  return null;
}

/**
 * The live frame as interpreted screen lines — the browser twin of
 * `TerminalScreen.lines()` (terminal-screen.js), minus the write-idle await.
 *
 * Scans BACKWARD from the end rather than translating the whole buffer and
 * slicing: `buffer.length` is viewport + scrollback, so a forward walk would cost
 * thousands of translateToString calls. Trailing blank rows are dropped, then the
 * last `count` rows are returned (interior blanks included). Reads from
 * `buffer.length`, never `viewportY`, so a user scrolled up in their history still
 * gets the live frame.
 *
 * @param {object} term   An xterm Terminal.
 * @param {number} count  How many rows to return.
 * @returns {string[]}
 */
export function frameLines(term, count = FRAME_LINES) {
  const buffer = term.buffer.active;
  const read = (i) => {
    const line = buffer.getLine(i);
    return line ? line.translateToString(true).replace(/\s+$/g, '') : '';
  };
  let last = buffer.length - 1;
  while (last >= 0 && read(last) === '') last--;
  if (last < 0) return [];
  const first = count > 0 ? Math.max(0, last - Math.trunc(count) + 1) : 0;
  const lines = [];
  for (let i = first; i <= last; i++) lines.push(read(i));
  return lines;
}

/**
 * The shell-tab fallback: read the row the hardware cursor is on.
 *
 * Only speaks when it can positively identify a prompt sigil to the left of the
 * caret — otherwise the caret is parked on some rendered output row (which is where
 * Ink leaves it) and says nothing about an input line.
 *
 * @param {object} term  An xterm Terminal.
 * @returns {'busy'|'unknown'}  Never 'empty' — see the module header.
 */
export function readCaretPrompt(term) {
  const buffer = term.buffer.active;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return 'unknown';

  const before = line.translateToString(false, 0, buffer.cursorX);
  const m = PROMPT_TAIL_RE.exec(before);
  if (!m) return 'unknown';                       // caret is not on an identifiable input line
  if (m[1].trim() !== '') return 'busy';          // typed text between the prompt and the caret
  if (line.translateToString(true, buffer.cursorX).trim() !== '') return 'busy';  // caret moved back over typed text
  return 'unknown';                               // an empty prompt — let the caller's mirror decide
}

/**
 * Is the agent's input line empty, occupied, or unreadable?
 *
 * Never throws: this runs inside `term.onData`, so a disposed terminal or a shape
 * xterm changes under us must degrade to 'unknown', not break every keystroke.
 *
 * @param {object} term  An xterm Terminal, or null/undefined.
 * @returns {'empty'|'busy'|'unknown'}
 */
export function readInputState(term) {
  if (!term || !term.buffer || !term.buffer.active) return 'unknown';
  try {
    const draft = readComposerDraft(frameLines(term));
    if (draft === null) return readCaretPrompt(term);
    return draft === '' ? 'empty' : 'busy';
  } catch {
    return 'unknown';
  }
}
