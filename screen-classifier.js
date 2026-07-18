/**
 * Screen-state idle detector (#568) — replaces the BEL-gated silence classifier.
 *
 * #558 proved the old "waiting" classifier was inadequate: it keyed on `\x07`
 * bytes that turned out to be OSC *title-string terminators*, not bells, and a
 * single un-submitted keystroke could disarm it permanently (two real tabs sat
 * stuck at waitingForInput=false for ~2.4h each). The replacement reads what is
 * actually on the rendered screen.
 *
 * The one robust signal, chosen after inspecting real captures:
 *
 *   Claude's working spinner repaints on EVERY animation frame (sub-second) for
 *   the whole turn, including during long tool calls. So "working" is decided by
 *   the *recency* of a spinner-bearing chunk — tracked by the caller as
 *   `lastSpinnerTime` (only chunks that match the spinner regex refresh it) —
 *   NOT by its mere presence in the tail.
 *
 *   What identifies a spinner frame has to survive TUI drift. The original
 *   marker was the `esc to interrupt` hint, which older Claude Code re-emitted
 *   on the spinner line every frame — but mid-2026 builds moved that hint off
 *   the spinner line (into the ⏵⏵ mode footer) and the status line became
 *   "✳ Hatching… (6m 53s · ↓ 18.3k tokens · …)". With no chunk ever matching,
 *   lastSpinnerTime stayed stale, every classify fell through to 'unknown'
 *   (= leave flag as-is), and each session's waitingForInput froze at whatever
 *   it last was — in practice True, since sessions pass through the idle prompt
 *   between turns. The durable per-frame signal is the spinner GLYPH itself:
 *   every animation frame rewrites one of ✢✳✶✻✽ (cursor-addressed diffs like
 *   "✻ge" still carry it). The regex now matches glyph OR hint, covering both
 *   generations. A glyph in a completed-turn line ("✻ Sautéed for 42s") or in
 *   pasted text refreshes at most once — a one-off ≤2.5s phantom 'working',
 *   self-healing, and the safe direction of error.
 *
 * Why recency and not position: the server has no terminal emulator, so the
 * ANSI-stripped scrollback tail is a concatenation of many overlapping partial
 * frames (cursor-addressed repaints are not resolved). A stale `esc to interrupt`
 * from an earlier turn lingers in that tail forever, and last-index math over it
 * is fragile. Timestamping only spinner-bearing chunks sidesteps the whole mess:
 *   - a keystroke echo carries no spinner marker, so it never refreshes
 *     lastSpinnerTime — a composed-but-unsent message stays "waiting" (the #558
 *     "one keystroke disarms it" requirement, satisfied structurally); and
 *   - overlapping/stale frames in the tail cannot fake "working".
 *
 * The tri-state result matters. `unknown` means "the screen doesn't decisively
 * say either" — the caller must LEAVE the waiting flag untouched, never force it
 * false. That is what keeps a half-typed prompt in normal mode (where the empty-
 * input `? for shortcuts` hint has disappeared) from flipping out of "waiting",
 * and keeps a full-screen TUI (`/help`, an editor) from being misread.
 *
 * Pure and dependency-free so it can be unit-tested against fixtures of real
 * captured tails (test/unit/screen-classifier.test.js). Root-level *.js is
 * auto-deployed by restart.sh and embedded by release.sh, so this ships with no
 * packaging change (same pattern as git-root.js / logging.js).
 */

// A live spinner emits a frame within this window; beyond it we treat the spinner
// as stale and fall through to the screen markers. Also the working→waiting
// latency after a turn ends. Claude's spinner "(Ns)" counter ticks ~1/s, so this
// sits comfortably above a normal inter-frame gap. Tunable — validate against the
// waiting-audit `msSinceSpinner` distribution (#558 instrumentation).
const SPINNER_MAX_QUIET_MS = 2500;

// Marker sets for the `claude` agent family. Kept as data so tuning (and adding
// another agent later) is a one-place edit. Matched against the ANSI-stripped,
// whitespace-collapsed screen tail.
const CLAUDE_SCREEN_MARKERS = {
  // A spinner animation frame. Two alternates spanning TUI generations: the
  // glyph set ✢✳✶✻✽ is rewritten on every frame by current Claude Code (even
  // cursor-addressed frame diffs carry it), and `esc to interrupt` is the
  // per-frame spinner-line hint of older builds. Deliberately NOT `·` (footer
  // separator, far too common). Used by the caller to refresh lastSpinnerTime
  // per chunk; a one-off match (completed-turn line, pasted glyph) costs at
  // most one SPINNER_MAX_QUIET_MS window of phantom 'working'.
  spinner: /esc to interrupt|[✢✳✶✻✽]/i,

  // Permission / selection dialogs — the agent is blocked on the user's choice.
  // Kept broad on purpose; these are only consulted once the spinner is stale, so
  // a phrase appearing mid-turn cannot cause a false "waiting".
  permission: [
    /Do you want to\b/i, // "Do you want to proceed?" / "…make this edit?" / "…create …?"
    /Esc to cancel\b/i, // "Esc to cancel · Tab to amend"
    /Enter to select\b/i,
    /Tab to switch questions\b/i,
  ],

  // Idle composer footer — the agent is sitting at its input prompt. These are the
  // hint/mode strings Claude draws around the input box while idle, transcribed
  // from real captures. The set is deliberately GENEROUS: it is consulted only
  // once the spinner is stale (step 1 already returned "working" otherwise), and a
  // stale-spinner Claude session is almost always at its prompt — so leaning
  // "waiting" here is the safe direction. Its only real job is to exclude the
  // startup/loading banner and full-screen TUIs (none of which carry these
  // strings), which fall through to "unknown" → leave-the-flag-as-is. The footer
  // varies with mode, context size, and whether agents are available, so no single
  // string is universal; the union covers them. (A half-typed prompt in normal
  // mode may match none of these — that is fine, it relies on the unknown→keep
  // rule, not on matching here.)
  atPrompt: [
    /⏵⏵/, // "⏵⏵ auto mode on (shift+tab to cycle)" / "⏵⏵ auto-accept edits on"
    /plan mode on\b/i,
    /\? for shortcuts/i,
    /← for agents/, // composer agent hint (normal mode)
    /\/clear to save/i, // large-context idle hint ("new task? /clear to save 160.6k tokens")
  ],
};

function matchesAny(patterns, tail) {
  for (const re of patterns) {
    if (re.test(tail)) return true;
  }
  return false;
}

/**
 * Classify a session's rendered state from its screen tail and spinner recency.
 *
 * @param {object} o
 * @param {string} o.tail            ANSI-stripped, whitespace-collapsed screen tail.
 * @param {number} o.now             Current time (ms). Injected for testability.
 * @param {number} [o.lastSpinnerTime]  ms of the last chunk that carried the spinner marker.
 * @param {object} [o.markers]       Per-agent marker set; absent → this agent isn't classified.
 * @returns {'working'|'waiting'|'unknown'}
 */
function classifyScreenTail({ tail, now, lastSpinnerTime, markers }) {
  if (!markers) return 'unknown'; // agent has no defined screen signals (terminal/pi/…)

  // 1) A recently-emitted spinner frame is the strongest signal there is: the
  //    agent is mid-turn. This short-circuits before any marker scan, so neither
  //    the overlapping-frame tail nor a long silent tool call (#500) can produce
  //    a false "waiting". The window also spans the turn-end gap between the last
  //    spinner frame and the idle footer being painted, so no "unknown" flicker
  //    appears there.
  if (lastSpinnerTime && now - lastSpinnerTime < SPINNER_MAX_QUIET_MS) return 'working';

  const t = tail || '';

  // 2) A blocking dialog beats the idle footer (a permission prompt is drawn over
  //    the composer, so both can appear in the tail).
  if (matchesAny(markers.permission, t)) return 'waiting';

  // 3) Idle at the input prompt.
  if (matchesAny(markers.atPrompt, t)) return 'waiting';

  // 4) Nothing decisive on screen (no fresh spinner, no recognizable footer/
  //    dialog). This is genuinely ambiguous — a startup banner, a TUI, or an idle
  //    prompt whose footer we can't read because the user has typed into it and
  //    the "? for shortcuts" hint is gone. Return 'unknown' so the caller leaves
  //    the flag AS-IS: crucially, a half-typed message does not get cleared out of
  //    "waiting" (the #558 keystroke-disarm requirement), and a keystroke echo —
  //    which never carries the spinner marker — can never fake "working".
  return 'unknown';
}

module.exports = { classifyScreenTail, CLAUDE_SCREEN_MARKERS, SPINNER_MAX_QUIET_MS };
