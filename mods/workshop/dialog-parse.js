/**
 * Reads what a blocked Claude Code session is actually asking (#660).
 *
 * Pure, with ZERO requires, for the same reason screen-classifier.js is: it has to
 * run in the bare `unit` CI job, which installs with --ignore-scripts and has no
 * daemon, no PTY and no zsh.
 *
 * Input is INTERPRETED screen lines — TerminalScreen.lines()/linesSync(), where the
 * emulator has already resolved cursor addressing. NOT the ANSI-stripped scrollback
 * tail the waiting classifier reads: that is a concatenation of overlapping partial
 * frames, so the same option appears three times at three stages of repaint and any
 * positional reasoning over it is fiction.
 *
 * TWO entry points, not one, and the split is load-bearing:
 *
 *   detectDialog() answers "is a modal on screen at all?" — the MEMBERSHIP gate.
 *   parseDialog()  answers "and what exactly does it say?" — null when a dialog is
 *                  up but unreadable, which is the raw-preview fallback.
 *
 * Collapsing those into one nullable return breaks the inbox. sessionInputState()
 * maps 'waiting' -> 'idle', and 'waiting' covers BOTH a permission dialog AND a
 * session sitting at an empty composer. Without a positive dialog gate, every agent
 * that merely finished its turn becomes an inbox row and Workshop is Action Required
 * with more scrolling.
 *
 * Known limitation, deliberately not guessed around: the AskUserQuestion cursor is
 * sometimes drawn as reverse video rather than a glyph, and linesSync() returns text
 * with no attributes. When no glyph is found we report cursorIndex: null and the
 * answer path refuses rather than assuming "probably option 1" — an assumption that
 * costs a wrong button press in someone's live session.
 */

// How far up we ever look. Generous rather than tight: the real bound on "is this
// dialog current?" is FOOTER_TAIL_ROWS below, and a caller that widens its read to
// recover a truncated option run must not be re-truncated here.
const TAIL_ROWS = 60;

// The dialog's hint line must be within this many NON-EMPTY rows of the bottom.
// This is what makes a resolved dialog stop matching: Claude Code repaints the
// transcript and composer below it, pushing any remnant out of the live region.
const FOOTER_TAIL_ROWS = 4;

const BLOCK_ROWS = 24;      // how far above the footer a dialog body may extend
const CONTEXT_LINES = 4;    // rows above the question carried along as context
const MAX_BLANK_GAP = 1;    // blank rows tolerated inside the option run
const MAX_CONT_ROWS = 3;    // wrapped rows tolerated per option
const MULTI_LOOKBACK = 8;   // rows above the question scanned for a tab strip

// The side panel Claude Code draws to the RIGHT of an AskUserQuestion's options.
// MIN_PANEL_COL is what keeps a dialog's OWN frame from matching; MIN_PANEL_ROWS is
// top border + a body row + bottom border, the smallest thing that is a box at all.
const MIN_PANEL_COL = 8;
const MIN_PANEL_ROWS = 3;
const PANEL_TOP_CHARS = '┌╭┏';
const PANEL_MID_CHARS = '│┃├┤';
const PANEL_BOT_CHARS = '└╰┗';

// Section dividers stepped over INSIDE the option run. One is what a real
// AskUserQuestion draws; a second means we are walking through box borders, so the run
// stops. Contiguity is what makes stepping over the first one safe.
const MAX_RULE_CROSSINGS = 1;

// The same marker family screen-classifier.js's CLAUDE_SCREEN_MARKERS.permission
// already validates against real captures. Kept as one regex here because we need
// the INDEX of the match, not merely that one exists.
//
// The last alternative is the plan-approval gate, whose footer names neither Esc nor
// Enter — it is the ctrl+g line. BOTH halves of it are required: `.claude/plans/` on
// its own is what an agent writes any time it mentions the plan file it just saved,
// and that sentence in a transcript must not read as a live dialog.
const DIALOG_FOOTER_RE =
  /Esc to (cancel|go back)\b|Enter to select\b|Tab to (amend|switch questions)\b|Tab\/Arrow keys|ctrl\+g to edit in\b.{0,40}\.claude\/plans\//i;

const PERMISSION_Q_RE = /^Do you want to\b/i;

// A key hint drawn INSIDE the option run — Claude Code puts one under the last option
// of the plan-approval gate. It is not a wrapped label, and folding it in names the
// button "Tell Claude what to change shift+tab to approve with this feedback".
const HINT_ROW_RE = /^shift\+tab to\b/i;

// `  2. Yes, and don't ask again…` / `❯ 1. Yes` / `❯1. Uniform (recommended)`
const OPTION_RE = /^[\s│┃|]*([❯›>])?[ \t]*(\d{1,2})[.)][ \t]+(.*\S)[ \t]*$/;

// A COMPOSER glyph row, which is emphatically not a menu cursor. The negative
// lookahead is the whole trick: `❯ 1. Yes` is a dialog cursor, `❯ Try "…"` is the
// composer, and telling them apart is what stops an idle session reading as blocked.
const COMPOSER_ROW_RE = /^[\s│┃|]*[❯›>](\s|$)(?!\s*\d+[.)])/;

// The menu cursor, once borders are off. Stripped before fingerprinting so that
// moving between options is not mistaken for a different dialog.
const CURSOR_GLYPH_RE = /^[❯›>]\s*/;

const RULE_RE = /^[\s│┃|╭╮╰╯┌┐└┘├┤]*[─━═_-]{6,}[\s│┃|╭╮╰╯┌┐└┘├┤]*$/;

// `←  ☐ Wiring scope  ☐ Notif click  ✔ Submit  →` — a multi-question AskUserQuestion.
const MULTI_TAB_RE = /[☐☑✔✓]\s*\S/;
const MULTI_LABEL_RE = /[☐☑✔✓]\s*([^☐☑✔✓]+)/g;

const LEAD_BORDER_RE = /^[\s│┃|╭╮╰╯┌┐└┘├┤]+/;
const TAIL_BORDER_RE = /[\s│┃|╭╮╰╯┌┐└┘├┤]+$/;

function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

/** Drop box-drawing borders and surrounding whitespace from one rendered row. */
function stripBorders(line) {
  return str(line).replace(LEAD_BORDER_RE, '').replace(TAIL_BORDER_RE, '');
}

/**
 * The one normalization both sides of the verify step use.
 *
 * The answer path compares "the label the human clicked" against "the label under
 * the cursor right now". If the two sides normalize differently the comparison
 * silently never matches and every answer is refused, so there is exactly one
 * implementation and both import it.
 */
function fingerprint(label) {
  return str(label).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
}

/**
 * FNV-1a, inline because this file has zero requires (see the header) and the hash
 * is never a security or storage decision — only "are these the same screen rows?".
 */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function tailOf(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines.length > TAIL_ROWS ? lines.slice(-TAIL_ROWS) : lines.slice();
}

/**
 * Is a modal dialog on screen right now?
 *
 * Returns { kind, footerIndex } (the index is into the internal tail slice, not into
 * the caller's array — parseDialog is the only consumer that needs it) or null.
 */
function detectDialog(lines) {
  const tail = tailOf(lines);
  if (!tail) return null;

  let footerIndex = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (DIALOG_FOOTER_RE.test(str(tail[i]))) { footerIndex = i; break; }
  }
  if (footerIndex < 0) return null;

  // Below the footer: a composer means the dialog already resolved and Claude Code
  // has repainted underneath it; too much content means the footer is a leftover
  // that scrolled up into the transcript.
  let below = 0;
  for (let i = footerIndex + 1; i < tail.length; i++) {
    const line = str(tail[i]);
    if (COMPOSER_ROW_RE.test(line)) return null;
    if (line.trim()) below++;
  }
  if (below > FOOTER_TAIL_ROWS) return null;

  // Above the footer: at least one numbered option, or this is prose that merely
  // happens to contain a hint phrase.
  let sawOption = false;
  let kind = 'question';
  const stop = Math.max(0, footerIndex - BLOCK_ROWS);
  for (let i = footerIndex - 1; i >= stop; i--) {
    const line = str(tail[i]);
    if (COMPOSER_ROW_RE.test(line)) break;
    if (OPTION_RE.test(line)) { sawOption = true; continue; }
    if (PERMISSION_Q_RE.test(stripBorders(line))) { kind = 'permission'; break; }
  }
  if (!sawOption) return null;

  return { kind, footerIndex };
}

/**
 * Walk UP from the footer collecting the option run.
 *
 * The issue's stated algorithm — "the trailing run of lines matching the option
 * regex" — fails on the single most common dialog in this repo. The real capture in
 * test/unit/fixtures/screen-tails.js has option 2 wrapping onto a second row:
 *
 *     ❯ 1. Yes
 *       2. Yes, and don't ask again for deepsteve - read_session_screen commands in
 *          /Users/michael/github/deepsteve-experimental/.claude/worktrees/…
 *       3. No
 *
 * The trailing run there is `3. No` alone — one option, unparseable, and every
 * deepsteve MCP permission prompt falls back to a raw screen preview, which is the
 * entire value this feature exists to deliver.
 *
 * So: anchor on the CONTIGUOUS DESCENDING run down to `1.`, and fold non-numbered
 * rows in as continuations. Walking upward, a continuation is encountered BEFORE
 * the option it belongs to, so it is buffered and prepended to the next option
 * taken. Taking option 1 stops the walk immediately, which is what keeps the
 * question line above it from being swallowed as a continuation.
 *
 * A rule inside that run used to end it. But Claude Code draws one above its escape
 * hatches ("Type something.", "Chat about this"), and that is not an edge case: it is
 * every multi-option AskUserQuestion, which was the majority of what the inbox exists
 * to show (#664). So the walk steps over at most MAX_RULE_CROSSINGS of them.
 *
 * Crossing is safe because it decides nothing — CONTIGUITY still decides. Every row past
 * the divider goes through the same `n !== expected` break, the same blank and
 * continuation budgets and the same composer break as any other row, so a rule that is
 * really the end of the run dies on the next iteration instead of this one. Re-checking
 * any of that here before crossing is provably dead code: an exhaustive sweep of every
 * arrangement of rows either side of a divider finds no screen where a lookahead changes
 * the result. The two conditions below are the ones that are NOT redundant — see them.
 *
 * What none of it rules out: a numbered list in the TRANSCRIPT whose last entry happens
 * to be the number the run wants, sitting right above a rule. It chains on and the labels
 * are junk. Contiguity is already the only thing between the run and such a list when
 * there is no rule at all, so this widens an existing hole by one rule rather than opening
 * one — and it stays unpressable either way, because a transcript row carries no cursor
 * glyph, so cursorIndex comes back null and tools.js marks the row unanswerable.
 */
function collectOptions(tail, footerIndex) {
  const desc = [];          // options in descending order
  let expected = null;
  let pending = [];         // buffered continuation rows, in screen order
  let blanks = 0;
  let rules = 0;            // box borders crossed before the run starts
  let crossings = 0;        // section dividers crossed INSIDE the run
  let firstIndex = -1;      // tail index of option 1

  for (let i = footerIndex - 1; i >= 0; i--) {
    const line = str(tail[i]);
    const m = OPTION_RE.exec(line);

    if (m) {
      const n = Number(m[2]);
      if (expected === null) {
        if (n < 1) break;
        expected = n;
      } else if (n !== expected) {
        break;              // the run is not contiguous — stop, never guess
      }
      const label = [stripBorders(m[3]), ...pending].filter(Boolean).join(' ');
      desc.push({ n, label, selected: !!m[1] });
      pending = [];
      blanks = 0;
      expected = n - 1;
      if (expected === 0) { firstIndex = i; break; }
      continue;
    }

    if (RULE_RE.test(line)) {
      // Before the run starts this is normally a box's bottom border sitting between
      // the options and the footer, which is what a rounded-box dialog looks like —
      // breaking there loses the whole dialog.
      if (!desc.length) {
        if (++rules > 2) break;
        // Rows between this rule and the footer never joined an option, and a rule
        // separates: they are the dialog's trailing chrome — an UNNUMBERED "Chat about
        // this", a "Notes: press n to add notes" — not a wrapped label belonging to
        // whatever option sits above the rule. Folding them in names a button after
        // them. This is the pre-run twin of the `pending.length` break below.
        pending = [];
        continue;
      }
      // Inside the run this is the escape-hatch divider (#664). Both conditions below
      // change outcomes; neither is ceremony. A second rule means we are crossing box
      // borders rather than one divider, and a non-empty `pending` means the rule sits
      // ABOVE rows that belong to the option below it — which no dialog draws, and which
      // would otherwise fold transcript prose into a button's label.
      if (crossings >= MAX_RULE_CROSSINGS) break;
      if (pending.length) break;
      crossings++;
      // A divider separates harder than a blank row does. Without this reset a divider
      // with a blank line on EACH side spends the whole MAX_BLANK_GAP budget and the run
      // dies on the row after the one we just chose to step over.
      blanks = 0;
      continue;
    }

    if (COMPOSER_ROW_RE.test(line)) break;

    if (!line.trim()) {
      blanks++;
      if (blanks > MAX_BLANK_GAP) break;
      continue;
    }

    const cont = stripBorders(line);
    if (!cont) continue;
    if (HINT_ROW_RE.test(cont)) continue;
    if (pending.length >= MAX_CONT_ROWS) break;
    pending.unshift(cont);
    blanks = 0;
  }

  if (firstIndex < 0) return null;   // never reached option 1
  return { options: desc.reverse(), firstIndex };
}

function readQuestion(tail, firstIndex) {
  for (let i = firstIndex - 1; i >= 0; i--) {
    const raw = str(tail[i]);
    if (RULE_RE.test(raw)) continue;
    const line = stripBorders(raw);
    if (!line) continue;
    if (MULTI_TAB_RE.test(line)) continue;
    return { question: line, index: i };
  }
  return { question: '', index: firstIndex };
}

function readContext(tail, questionIndex) {
  const out = [];
  let blanks = 0;
  for (let i = questionIndex - 1; i >= 0 && out.length < CONTEXT_LINES; i--) {
    const raw = str(tail[i]);
    if (RULE_RE.test(raw)) break;
    const line = stripBorders(raw);
    if (!line) { if (++blanks >= 2) break; continue; }
    if (MULTI_TAB_RE.test(line)) continue;
    blanks = 0;
    out.unshift(line);
  }
  return out;
}

function readMulti(tail, questionIndex, footerLine) {
  const stop = Math.max(0, questionIndex - MULTI_LOOKBACK);
  for (let i = questionIndex; i >= stop; i--) {
    const line = stripBorders(tail[i]);
    if (!MULTI_TAB_RE.test(line)) continue;
    const labels = [];
    let m;
    MULTI_LABEL_RE.lastIndex = 0;
    while ((m = MULTI_LABEL_RE.exec(line)) !== null) {
      const label = m[1].replace(/[←→]/g, '').replace(/\s+/g, ' ').trim();
      if (label) labels.push(label);
    }
    if (labels.length >= 2) return { count: labels.length, labels };
  }
  // The footer can say so even when the tab strip is off-screen or undrawn. Report
  // the fact without a count rather than pretending there is only one question:
  // WHICH tab is current is conveyed by highlight, which linesSync cannot see, so
  // there is deliberately no index here at all.
  if (/Tab to switch questions\b/i.test(str(footerLine))) return { count: null, labels: [] };
  return null;
}

/**
 * Where a side panel closes, or -1 if the box at (top, col) never closes cleanly.
 * Strict on purpose: a column that is not a border on every row in between is not a
 * box, and half a box is not something to reformat a screen around.
 */
function panelClosingRow(tail, top, col) {
  for (let i = top + 1; i < tail.length; i++) {
    const ch = str(tail[i])[col];
    if (ch === undefined) return -1;
    if (PANEL_BOT_CHARS.includes(ch)) return i;
    if (!PANEL_MID_CHARS.includes(ch)) return -1;
  }
  return -1;
}

/** The topmost complete side panel, or null. */
function findSidePanel(tail) {
  for (let r = 0; r < tail.length; r++) {
    const row = str(tail[r]);
    for (let c = MIN_PANEL_COL; c < row.length; c++) {
      if (!PANEL_TOP_CHARS.includes(row[c])) continue;
      // Text to its LEFT on its opening row is what tells a side panel apart from the
      // dialog's own frame: a frame opens on a row of its own.
      if (!row.slice(0, c).trim()) continue;
      const bottom = panelClosingRow(tail, r, c);
      if (bottom >= 0 && bottom - r + 1 >= MIN_PANEL_ROWS) return { col: c, top: r, bottom };
    }
  }
  return null;
}

/**
 * The panel's bottom border, plus any rows under it that sit only in its column —
 * Claude Code hangs "Notes: press n to add notes" below the box, indented to it.
 */
function lastPanelRow(tail, { col, bottom }) {
  let last = bottom;
  for (let i = bottom + 1; i < tail.length; i++) {
    const line = str(tail[i]);
    if (!line.trim()) continue;            // a blank row decides nothing either way
    if (line.slice(0, col).trim()) break;  // content in the option column ends the panel
    last = i;
  }
  return last;
}

/**
 * A left-column-only view of a screen whose dialog has a side panel, or null.
 *
 * This exists because the side-by-side layout is unreadable head-on: the options and
 * the panel share ROWS, so `3. Slot-first only │ tap rack E -> E lifts` is one line,
 * and the fifteen rows of box art between the last option and the footer blow both
 * MAX_BLANK_GAP and MAX_CONT_ROWS long before the walk reaches an option.
 *
 * Rows inside the panel's span whose left column is empty are DROPPED, not blanked.
 * A blanked row still spends the walk's blank budget, and a fifteen-row hole spends
 * it fifteen times over — but a row that only ever held panel is not a gap in the
 * option column, it is not in that column at all.
 */
function stripSidePanel(tail) {
  const panel = findSidePanel(tail);
  if (!panel) return null;
  const last = lastPanelRow(tail, panel);
  const out = [];
  for (let i = 0; i < tail.length; i++) {
    const line = str(tail[i]);
    if (i < panel.top || i > last) { out.push(line); continue; }
    const left = line.slice(0, panel.col).replace(/\s+$/, '');
    if (!left) continue;
    out.push(left);
  }
  return out;
}

/**
 * The full read. null means "a dialog is up but its options could not be read" —
 * the caller keeps the row and renders a raw screen preview instead.
 */
function parseDialog(lines) {
  const direct = readDialog(lines);
  if (direct) return direct;
  // Only ever a RETRY. Reformatting a screen is a big hammer, and every layout that
  // reads straight must keep reading straight — including the ones whose box art the
  // panel detector would happily latch onto.
  const split = stripSidePanel(tailOf(lines) || []);
  return split ? readDialog(split) : null;
}

function readDialog(lines) {
  const detected = detectDialog(lines);
  if (!detected) return null;

  const tail = tailOf(lines);
  const collected = collectOptions(tail, detected.footerIndex);
  if (!collected) return null;

  const { options, firstIndex } = collected;
  if (options.length < 2) return null;
  for (let i = 0; i < options.length; i++) {
    if (options[i].n !== i + 1) return null;   // must be exactly 1..N
  }

  // Two cursors means we misread something. A mis-parse must never look like a
  // confident answer, so drop the flag entirely rather than pick the first.
  const marked = options.filter((o) => o.selected);
  let cursorIndex = null;
  if (marked.length === 1) {
    cursorIndex = options.findIndex((o) => o.selected);
  } else if (marked.length > 1) {
    for (const o of options) o.selected = false;
  }

  const { question, index: questionIndex } = readQuestion(tail, firstIndex);
  const context = readContext(tail, questionIndex);

  // "Do you want to proceed?" is identical across every session and every tool, so
  // it is useless as a subject. The line above it — "deepsteve - read_session_screen
  // (MCP)", "Bash(rm -rf …)" — is the actual message.
  const headline = detected.kind === 'permission'
    ? (context.length ? context[context.length - 1] : question)
    : (question || (context.length ? context[context.length - 1] : ''));

  return {
    kind: detected.kind,
    headline,
    question,
    context,
    options: options.map((o) => ({ n: o.n, label: o.label, selected: !!o.selected })),
    cursorIndex,
    multi: readMulti(tail, questionIndex, tail[detected.footerIndex]),
    footer: stripBorders(tail[detected.footerIndex]),
  };
}

/**
 * A stable identity for the dialog on screen right now — the answer to "is this the
 * SAME question I was looking at a moment ago?" Empty string when no dialog is up.
 *
 * Two callers, and both need it to survive a repaint while changing the instant the
 * question does: the age clock a blocked row carries, and the dismiss registry, which
 * silences a row only for as long as that particular question is the one being asked.
 *
 * Deliberately NOT `fingerprint(parsed.question)`. parseDialog returns null on any
 * dialog whose option run it cannot walk, so every unreadable dialog on the machine
 * would share the empty fingerprint: one dismissal would silence all of them, and
 * each would inherit the last one's age.
 *
 * The cursor glyph is stripped, so arrowing between options is not a new question.
 * The window is the same one detectDialog itself calls the dialog block, which is
 * what keeps a 30-row read and a 60-row read of one screen agreeing: both are counted
 * back from the footer, and both tails end on the same screen row.
 */
function dialogFingerprint(lines) {
  const tail = tailOf(lines);
  const detected = detectDialog(lines);
  if (!tail || !detected) return '';

  const body = [];
  const stop = Math.max(0, detected.footerIndex - BLOCK_ROWS);
  for (let i = stop; i <= detected.footerIndex; i++) {
    const row = str(tail[i]);
    // Scanning downward, so a composer row is detectDialog's upward `break` seen
    // from the other side: whatever we collected above it is transcript, not dialog.
    if (COMPOSER_ROW_RE.test(row)) { body.length = 0; continue; }
    const line = stripBorders(row).replace(CURSOR_GLYPH_RE, '').replace(/\s+/g, ' ').trim();
    if (line) body.push(line);
  }
  return detected.kind + ':' + hash32(body.join('\n'));
}

module.exports = {
  detectDialog,
  dialogFingerprint,
  parseDialog,
  fingerprint,
  stripBorders,
  TAIL_ROWS,
  FOOTER_TAIL_ROWS,
  CONTEXT_LINES,
};
