/**
 * Composer reader (#607) — "is the prompt still sitting unsent in the input box?"
 *
 * The prompt-submission path needs two answers the waiting classifier can't give:
 *
 *   1. Before Enter: did the agent actually RECEIVE the text we typed? Ink only
 *      treats \r as Enter when it arrives as its own stdin read, so we must not
 *      send Enter until the text has demonstrably been consumed. A non-empty
 *      composer is that proof, and it survives line wrapping, unicode mangling
 *      and Claude Code's large-paste collapsing in a way substring matching does
 *      not.
 *   2. After Enter: did the submit take? If the composer STILL holds our prompt
 *      while the agent sits idle, the Enter was swallowed and must be re-sent.
 *
 * Why a dedicated module rather than a substring test on the screen: after a
 * SUCCESSFUL submit the prompt text is still on screen — Claude renders the user
 * message in the transcript. A naive `screen.includes(prompt)` therefore reports
 * "still staged" on every successful submission, and the retry would double-submit
 * every prompt. Only the composer box may be consulted, so locating that box
 * correctly is the whole job.
 *
 * Two traps this deliberately handles, both from real captures in
 * test/unit/fixtures/screen-tails.js:
 *
 *   - `❯` is ALSO the selection cursor of permission dialogs and AskUserQuestion
 *     menus ("❯ 1. Yes", "❯1. Uniform (recommended)"). Those are not composers.
 *   - An empty composer is not blank: it carries a rotating placeholder hint
 *     (`❯ Try "how does main.dart work?"`).
 *
 * Everything here fails CLOSED: when the screen can't be read confidently the
 * answer is null / false, which downstream means "fall back to the timed path,
 * don't retry" — i.e. the pre-#607 behavior, never something worse.
 *
 * Input is INTERPRETED screen lines (TerminalScreen.lines()), not the raw
 * ANSI-stripped scrollback tail the classifier uses — cursor-addressed repaints
 * must already be resolved or the composer can't be located at all.
 *
 * Pure and dependency-free so it can be unit-tested against fixtures. Root-level
 * *.js is auto-deployed by restart.sh and embedded by release.sh, so this ships
 * with no packaging change (same pattern as screen-classifier.js / git-root.js).
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

// The rotating placeholder Claude Code draws in an EMPTY composer. Requiring the
// quote keeps a real draft that merely begins with the word "try" from being read
// as empty (and if that ever misfires, an empty verdict just means "no echo yet"
// → the timed fallback).
const PLACEHOLDER_RE = /^try\s+["'“”]/i;

// Claude Code collapses a large paste into a placeholder instead of echoing it,
// so a long prompt may never show its own characters. Kept loose on purpose: the
// exact wording is a moving target, and a miss only costs us one of two positive
// signals.
const PASTE_PLACEHOLDER_RE = /\[?\s*pasted\s+text\b|\+\s*\d+\s+lines?\b/i;

// ...but the count in that placeholder is checkable, and it is the only completeness
// signal that works for exactly the prompts that break. Claude Code builds the label
// with (lifted verbatim from the 2.1.246 binary):
//
//   pr = (e) => (e.match(/\r\n|\r|\n/g) || []).length
//   cr = (e, t) => t === 0 ? `[Pasted text #${e}]` : `[Pasted text #${e} +${t} lines]`
//
// So N is the NEWLINE count of the pasted text, not its line count, and a paste with
// no newline in it renders with no `+N lines` clause at all. A 38-newline prompt that
// arrived without its head shows `+8 lines`, which is the tell.
const PASTE_LINE_COUNT_RE = /\+\s*(\d+)\s+lines?\b/i;

// How many leading characters of the draft and the prompt must agree. One row of
// the composer box is ~100 columns, so a needle this short can't be split by the
// hard wrap that would otherwise inject a space mid-word.
const COMPOSER_MATCH_CHARS = 40;

// How far past the candidate line to look for menu markers.
const MENU_LOOKAHEAD = 6;

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
function readComposerDraft(lines) {
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

    // Whitespace-collapsed: rows are joined with a space, so a blank row inside the
    // draft would otherwise leave a double space. Callers only ever test the draft
    // for truthiness or compare it under the same normalization.
    const draft = norm(parts.join(' '));
    return PLACEHOLDER_RE.test(draft) ? '' : draft;
  }

  return null;
}

/**
 * True when `text` appears to be sitting unsent in the composer.
 *
 * Both halves of the conjunction matter: a non-empty draft alone would fire on a
 * menu cursor or on something the user typed, and a text match alone would fire on
 * the transcript echo of a prompt that submitted perfectly well.
 *
 * @param {string[]} lines  Interpreted screen lines, oldest first.
 * @param {string} text     The prompt we tried to submit.
 */
function isPromptStaged(lines, text) {
  const draft = readComposerDraft(lines);
  if (!draft) return false;                       // null (unknown) or '' (empty) → not staged
  if (PASTE_PLACEHOLDER_RE.test(draft)) return true;

  const nd = norm(draft);
  const nt = norm(text);
  const k = Math.min(COMPOSER_MATCH_CHARS, nd.length, nt.length);
  if (k === 0 || k < Math.min(4, nt.length)) return false;
  return nd.slice(0, k) === nt.slice(0, k);
}

// Shortest edge that may be treated as evidence. Below this a match is coincidence.
const MIN_EDGE_CHARS = 8;

/** Every whitespace character removed — see promptDraftVerdict for why. */
function squash(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

/** Claude Code's own newline count — see PASTE_LINE_COUNT_RE. */
function newlineCount(s) {
  return (String(s == null ? '' : s).match(/\r\n|\r|\n/g) || []).length;
}

/**
 * Has the whole of `text` finished arriving in the composer? (#656)
 *
 * This is NOT "is the draft equal to what we wrote". It cannot be, and pretending
 * otherwise is how you get a regression: the submission poller reads one 40-row
 * viewport of a 120x40 emulator, so a multi-kilobyte draft rendered uncollapsed does
 * not fit. When it overflows, the composer scrolls to the cursor and what is legible
 * is the END of the draft — the head is simply off-screen, on a perfectly good
 * delivery. A draft whose head is missing is therefore ambiguous between "we lost the
 * head" and "the head scrolled away", and only the transcript can tell them apart
 * (prompt-delivery-check.js). Guessing here would clear and re-type healthy prompts.
 *
 * The question this CAN answer is the one the Enter gate actually needs: is the tail
 * of our text there yet? The tail is the last thing we wrote, so seeing it means the
 * write landed. Seeing our head but NOT our tail is the precise signature of Enter
 * racing a write that is still streaming in — #656's mechanism.
 *
 * @param {string[]} lines  Interpreted screen lines, oldest first.
 * @param {string} text     The prompt we are trying to submit.
 * @returns {'complete'|'incomplete'|'unknown'}
 *   'complete'   — the end of our text is in the composer; Enter is safe.
 *   'incomplete' — our head is there, our tail is not; the write is still arriving.
 *   'unknown'    — no composer, an empty one, or a draft that is not ours. Callers
 *                  must treat this as "keep waiting", never as either verdict.
 */
function promptDraftVerdict(lines, text) {
  const draft = readComposerDraft(lines);
  if (!draft) return 'unknown';                 // null (no composer) or '' (nothing echoed)
  const nt = norm(text);
  if (!nt.length) return 'unknown';

  // A collapsed paste hides its own characters, so the count is all we have — and it
  // is a better signal than the characters would be, because it covers the whole
  // draft rather than the visible part of it.
  if (PASTE_PLACEHOLDER_RE.test(draft)) {
    const m = PASTE_LINE_COUNT_RE.exec(draft);
    if (!m) return 'unknown';                   // `[Pasted text #1]` — no count to check
    const want = newlineCount(text);
    if (want === 0) return 'unknown';           // we wrote one line; nothing to compare
    const got = Number(m[1]);
    // Claude counts what it kept after its own trimming, so allow one either way.
    if (got >= want - 1) return 'complete';
    if (got * 2 < want) return 'incomplete';
    return 'unknown';
  }

  // Compare with whitespace REMOVED, not merely collapsed. readComposerDraft joins
  // the composer's rows with a space, so a soft wrap inside a long word inserts a
  // space that was never in what we wrote — norm() alone would then fail to match a
  // perfectly good draft. That is also why COMPOSER_MATCH_CHARS (40) is safe as a
  // single-row needle but a longer prefix comparison is not.
  const sd = squash(draft);
  const st = squash(text);
  if (!sd.length || !st.length) return 'unknown';

  // The END of our text is in the box, so the write landed. This is the signal Enter
  // waits for, and it holds whether or not the head is still on screen.
  const tailK = Math.min(COMPOSER_MATCH_CHARS, st.length);
  if (sd.length >= tailK && sd.endsWith(st.slice(-tailK))) return 'complete';

  // Our head is there and our tail is not: the write is still streaming in. Sending
  // Enter now submits a fragment, which is the failure this whole function exists for.
  const headK = Math.min(COMPOSER_MATCH_CHARS, st.length, Math.max(sd.length, MIN_EDGE_CHARS));
  if (headK >= Math.min(MIN_EDGE_CHARS, st.length) && sd.startsWith(st.slice(0, headK))) return 'incomplete';

  return 'unknown';                             // not our draft at all
}

/**
 * True when `text` appears anywhere on the screen — composer, transcript, wherever.
 *
 * This is the deliberately naive whole-screen match that must NEVER be used to answer
 * "is it still staged". It answers the opposite question: after a submit, Claude
 * renders the user message in the transcript, so seeing the prompt outside the
 * composer is positive evidence that the agent RECEIVED it. Without that evidence an
 * empty composer is ambiguous — a child that has not yet read its stdin looks exactly
 * like one that submitted and moved on.
 *
 * @param {string[]} lines  Interpreted screen lines, oldest first.
 * @param {string} text     The prompt we tried to submit.
 */
function isPromptOnScreen(lines, text) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  const nt = norm(text);
  if (nt.length === 0) return false;
  const needle = nt.slice(0, Math.min(COMPOSER_MATCH_CHARS, nt.length));
  return norm(lines.join(' ')).includes(needle);
}

module.exports = {
  readComposerDraft,
  isPromptStaged,
  isPromptOnScreen,
  promptDraftVerdict,
  PASTE_PLACEHOLDER_RE,
  PASTE_LINE_COUNT_RE,
  COMPOSER_MATCH_CHARS,
};
