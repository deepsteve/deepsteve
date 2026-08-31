/**
 * Workshop (#660, #669) — one inbox for every agent that needs you.
 *
 * Five MCP tools let an agent post a question, a briefing, a result or a chat reply; nine
 * REST routes let the panel read the inbox, answer from it, fetch a result's images, read
 * the project's backlog, and hold a conversation with a session. Blocked sessions — the
 * ones sitting on a real Claude Code permission / AskUserQuestion dialog — are DERIVED per
 * request from ctx.shells and never stored, so they exist exactly as long as the dialog does.
 *
 * The panel POLLS its own routes rather than receiving a broadcast. That is not an
 * oversight: a new push feed would need a notifyX/onXChanged pair in
 * public/js/mod-manager.js plus a dispatch line in public/js/app.js.
 *
 * Workshop shipped (#660) with no host edit at all. It now has exactly one: ctx.transcriptPath,
 * put in the mod context for the chat pane (#670). The function itself is server.js's and is
 * shared with #672 — locating a session's conversation means knowing both how Claude Code
 * encodes a project directory and which transcript id the session has rotated onto, and
 * neither belongs in a mod.
 *
 * ── The Backlog (#671) ──
 *
 * The two backlog routes shell out to `gh` on a cadence of minutes, not the inbox's
 * two seconds, and every rule they apply — parsing, matching an issue to a live tab,
 * the TTL cache — lives in ./backlog.js, which never sees this ctx. That split is what
 * lets test/unit drive the matching with no `gh` on PATH; the bare unit CI job has none.
 *
 * Both routes degrade quietly and NEVER 500. A missing `gh`, an unauthenticated one, a
 * repo with no GitHub remote and a label the repo has never defined all produce an
 * empty list with an `error` string the panel renders as one grey line. The backlog is
 * an accessory to the inbox; it must not be able to make the inbox look broken.
 *
 * ── The host edits, which this file used to claim did not exist ──
 *
 * #660 shipped with none, and said so here. The merge gate (#669) has three, because a
 * decision made server-side at completion time cannot live in a mod's own settings:
 *
 *   1. issue_complete (mods/deepsteve-core/tools.js) reads `caller.resultItemId` and
 *      `caller.resultApprovedAt`, which share_result and the answer path below stamp,
 *      gated on the `issueStagesEnabled` setting #668 already added.
 *   2+3. serializeShellEntry() and the restore path in server.js carry those two fields,
 *      so an approval survives a ./restart.sh between Approve and issue_complete.
 *
 * The chat pane (#670) adds a fourth: `transcriptPath` in the initMCP ctx. The function is
 * server.js's own and is shared with #672 — locating a session's conversation means knowing
 * both how Claude Code encodes a project directory and which transcript id the session has
 * rotated onto, and neither belongs in a mod.
 *
 * ── The chat pane (#670) ──
 *
 * Approve and Request changes are a transaction; the reaction to a piece of work is usually
 * a question. So a result — or any item with a session behind it — opens a conversation in
 * a third column. It reads from whichever of two places the conversation actually lives:
 * the agent's own transcript when it keeps one, else the workshop_say store in
 * ./chat-store.js. Both render identically. The parsing rules are in ./transcript.js and
 * the markdown in ./markdown.js, and neither sees this ctx — same split, same reason.
 *
 * ── Why Workshop deliberately does NOT go through requestMetaControlsConsent ──
 *
 * The meta-controls gate prices one specific risk: an AGENT typing into another
 * agent's session without the human knowing (#519). Every PTY write in this file
 * originates from a human pressing a key in the Workshop panel, in the host UI, on
 * this machine, behind the same auth cookie that already authorizes closing the
 * session outright. Routing it through the consent modal would ask the user to
 * approve their own click — and a DECLINE there starts a 60s cooldown that would then
 * block the next unrelated meta_type.
 *
 * The five MCP tools below write nothing to any PTY; they only append to a store. The only
 * PTY writes live in the answer paths and in POST /api/workshop/chat/:sessionId, all
 * reachable exclusively from the panel and none of them called by any MCP tool. If that
 * ever stops being true — if an agent gains any way to answer another agent's item, or to
 * put text into another agent's session through here — this decision must be revisited,
 * because at that point Workshop becomes exactly the thing #519 guards.
 *
 * That still holds with the merge gate in place, and it is worth being explicit about
 * why, because "an agent can now unlock its own merge" is the shape of the thing #519
 * guards. It cannot: share_result only appends an item and stamps the caller's own
 * `resultItemId`, which by itself REFUSES the merge. The stamp that permits one —
 * `resultApprovedAt` — is written on exactly one line, in answerStored, reached only
 * from the human pressing a key in the panel. Approving is answering a question.
 *
 * workshop_say (#670) is the newest tool and the other one that looks like it moves the
 * line. It does not either: it takes no session parameter, writes only the CALLER's own
 * thread via callerFields, and reaches no PTY. An agent can put text on the human's screen,
 * which workshop_ask and workshop_brief already could; it cannot put text in another
 * agent's session, which is the thing being guarded.
 */

const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { z } = require('zod');
// The one cross-mod require in this file (#682). merge-worktree.js is a pure library —
// it takes a `git` runner and returns a status — with no ctx, no shells and no MCP, and
// it encodes the merge semantics the bench must not have a second opinion about: refuse
// on a dirty target, abort on conflict, leave the target untouched unless it says
// `merged`. Reimplementing that here to avoid reaching across a mod boundary would be
// the trade made backwards.
const { mergeWorktree } = require('../deepsteve-core/merge-worktree');
const projectScope = require('../../project-scope');
const { resolveBinary } = require('../../bin-path');
const inbox = require('./inbox');
const chatStore = require('./chat-store');
const transcript = require('./transcript');
const dialogParse = require('./dialog-parse');
const backlog = require('./backlog');
const images = require('./images');

// Stashed by init() and shared with registerRoutes(), the mods/scheduled-tasks and
// mods/project-mods pattern: mcp-server.js always calls init() first, and both halves
// need the same context object.
let ctx = null;

// Raw key bytes, from mods/deepsteve-core/tools.js's KEY_MAP.
const KEYS = { Up: '\x1b[A', Down: '\x1b[B', Enter: '\r' };

// meta_type's TIMINGS.keyGapMs. Ink only recognizes control bytes that arrive as
// SEPARATE stdin reads, so each byte is its own engine.write with this gap; sending
// "\x1b[B\x1b[B\r" in one write is not Down/Down/Enter, it is nothing at all.
const KEY_GAP_MS = 250;
const SETTLE_MS = 400;        // let the repaint reach the emulator before reading back
const MAX_STEPS = 12;         // refuse an implausible cursor journey rather than flail
const VERIFY_TRIES = 3;
const SCRAPE_ROWS = 30;
const WIDE_ROWS = 60;         // one retry when a 30-row read truncates the option run
const PREVIEW_ROWS = 15;
const READ_FRESH_TIMEOUT_MS = 1000;

// ── idle-awaiting-you (#682) ──
//
// How long a session must sit unchanged at its own prompt before the bench calls it
// "waiting on you" rather than "between turns". The panel sends its own value from a
// setting because the right number is a property of how the human works, not of the
// software: 15s is right if you are watching, and maddening if you are not.
//
// The clamp is the contract. 0 is legal and means "the moment it stops" — a real
// choice, and the one the unit tests use so they never have to wait.
const IDLE_AFTER_DEFAULT_MS = 15_000;
const IDLE_AFTER_MAX_MS = 6 * 60 * 60 * 1000;

// How long "I'll deal with it later" lasts when the panel does not say. Long enough
// to clear the bench and finish what you were doing, short enough that a session you
// snoozed and forgot comes back the same afternoon.
const SNOOZE_DEFAULT_MS = 30 * 60 * 1000;

// ── chat pane (#670) ──
// How much of a transcript's TAIL to read for the chat pane. Four times
// prompt-delivery-check.js's TAIL_READ_BYTES on purpose: that module wants the last user
// message and finds it immediately, this one wants a CONVERSATION. Measured over the real
// transcripts on this machine — a tool-heavy session is ~20KB of tool_result and thinking
// per rendered message, so a 256KB window yielded as few as ONE readable message on a
// 52MB file, and 1MB yielded 18-52. The read itself costs 2.6ms on a 139MB transcript,
// which is why there is no cache here: see the comment on chatMessages().
const CHAT_TAIL_BYTES = 1024 * 1024;

// One message. A pasted file in a reply would otherwise be the entire response body.
const MAX_MESSAGE_CHARS = 20000;

// workshop_say, per session. An agent in a loop narrating itself into the human's chat
// pane is the same failure MAX_OPEN prices for workshop_ask, and needs the same answer.
const SAY_WINDOW_MS = 60000;
const SAY_MAX_PER_WINDOW = 20;

// The MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC is 60000
// (node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js). 50s leaves
// 10s of slack for transport and for our own bookkeeping either side of the hold.
// Raising this is not a free knob — past ~55s the request dies before the hold does
// and the agent sees an error instead of the fallback message.
const MAX_WAIT_SEC = 50;

// ctx.shells is EMPTY for a moment during the daemon's own boot, before sessions are
// restored. Don't run the dead-session sweep against that.
const BOOT_GRACE_MS = 60_000;
const BOOTED_AT = Date.now();

// Whether a digit key selects an option directly. Both false until measured against a
// real dialog on an isolated daemon: an unsupported digit lands in a text field, which
// is the worst failure this feature can have. The arrow path below is the fallback and
// stays regardless.
const DIGIT_SELECT = { permission: false, question: false };

// sessionId -> { seq, lines, detected, parsed, questionFp, blockedSince }
const scrapeCache = new Map();
// `${cwd}\0${worktree}` -> { project, projectName }
const projectCache = new Map();
const PROJECT_CACHE_MAX = 200;
// sessionId -> the dialog fingerprint a human dismissed from the panel.
//
// A derived row has no store and no tombstone by design, so "I have dealt with this"
// cannot be a status on an item. It is a MUTE, and it is keyed on the DIALOG rather
// than the session: the row stays gone while that question is the one on screen and
// comes straight back the moment the tab asks something else. That is the whole
// moved-on rule in one map — a tab that moves on either paints a different dialog or
// none, and both stop the mute applying.
//
// In memory and dies with the daemon, for the reason the waits registry gives: losing
// one costs a row you already read coming back once, and persisting one costs a second
// store to reconcile against sessions that no longer exist.
//
// Written only from POST /api/workshop/items/blocked:<id>/dismiss, which no MCP tool
// calls — see the header. An agent must never be able to silence a human's inbox.
const mutedDialogs = new Map();

// sessionId -> { until, idleSince } — an idle row the human has snoozed (#682).
//
// The same shape of promise mutedDialogs makes, keyed on the same kind of evidence.
// A dialog mute is keyed on the QUESTION, so it ends when the tab asks something
// else; a snooze is keyed on `idleSince`, so it ends when the session does something
// and comes back to its prompt with a fresh wait. Both mean "I have dealt with the
// thing I was looking at", and neither can outlive the thing it was about.
//
// In memory, and written only from the panel's dismiss route — no MCP tool reaches
// it. An agent must never be able to silence a human's bench.
const snoozedSessions = new Map();

// Sessions with a key dance in flight. A second concurrent answer would interleave
// two key streams into one dialog.
const inFlightChoices = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ content: [{ type: 'text', text: t }] });

// ── screen reading ───────────────────────────────────────────────────────────

/**
 * The listing read. linesSync, never ctx.readTerminalScreen, and all three reasons
 * bite at poll cadence:
 *
 *   1. readTerminalScreen lazily builds a fresh TerminalScreen and replays the ENTIRE
 *      scrollback when entry.terminalScreen is null — and would install an emulator on
 *      sessions that deliberately have none;
 *   2. it awaits idlePromise, which a session producing sustained output can defer
 *      indefinitely, stalling the whole /inbox response on one chatty tab;
 *   3. it is async, so a listing fans out one await per session.
 *
 * linesSync returns [] on a disposed screen and is a bounded backward scan. The cost
 * is that a chunk still in xterm's parse queue is not reflected — at most one poll of
 * staleness in a LISTING. The answer path uses readFresh instead.
 */
function screenLines(entry, n) {
  const scr = entry && entry.terminalScreen;
  if (!scr || typeof scr.linesSync !== 'function') return [];
  try {
    return scr.linesSync(n) || [];
  } catch {
    return [];
  }
}

/**
 * The answer-path read, where being one frame stale means pressing the wrong button.
 * Awaits the emulator's parse queue but races a timeout, so sustained output cannot
 * hang the request. Still never resurrects a disposed emulator.
 */
async function readFresh(entry, n) {
  const scr = entry && entry.terminalScreen;
  if (!scr) return [];
  const sync = () => screenLines(entry, n);
  if (typeof scr.lines !== 'function') return sync();
  try {
    return await Promise.race([
      scr.lines(n),
      new Promise((r) => setTimeout(() => r(sync()), READ_FRESH_TIMEOUT_MS)),
    ]);
  } catch {
    return sync();
  }
}

// ── project resolution ───────────────────────────────────────────────────────

/**
 * Cached because canonicalRoot runs findGitRoot (an fs walk) plus a statSync, and the
 * listing would otherwise redo that for every session at poll cadence for an answer
 * that essentially never changes.
 */
function projectFor(entry) {
  const key = (entry.cwd || '') + '\0' + (entry.worktree || '');
  let hit = projectCache.get(key);
  if (!hit) {
    let project = '';
    try {
      const { repoRoot } = ctx.sessionPaths(entry);
      project = projectScope.canonicalRoot(repoRoot || entry.cwd || '') || '';
    } catch {
      project = '';
    }
    hit = { project, projectName: projectScope.displayName(project) };
    if (projectCache.size >= PROJECT_CACHE_MAX) projectCache.clear();
    projectCache.set(key, hit);
  }
  return hit;
}

/**
 * Who is asking, and about what. The agent never supplies any of this — sessionId
 * comes off the shellId query param already on every MCP request, and the project is
 * derived from the session, so the inbox groups by project for free.
 */
function callerFields(extra) {
  const shellId = projectScope.callerShellId(extra);
  const entry = shellId ? ctx.shells.get(shellId) : null;
  // The shared #659 helper rather than projectFor(): this runs once per tool call,
  // not per session per poll, so the cache is not worth the divergence.
  const project = projectScope.resolveProject(null, shellId, ctx);
  return {
    sessionId: shellId,
    sessionName: (entry && entry.name) || null,
    worktree: (entry && entry.worktree) || null,
    project,
    projectName: projectScope.displayName(project),
  };
}

// ── backlog: the project's open issues (#671) ────────────────────────────────

const issueCache = backlog.createCache({ ttlMs: backlog.BACKLOG_TTL_MS });
const labelCache = backlog.createCache({ ttlMs: backlog.LABEL_TTL_MS });

// The panel's own cadence may not out-run the cache, or a user who sets the refresh to
// 30s gets a `gh` spawn every 30s forever. Clamped both ways: below, a client asking for
// fresher-than-30s data is told no; above, a stale-beyond-15min list stops being useful.
const MIN_MAX_AGE_MS = 30_000;
const MAX_MAX_AGE_MS = 900_000;

/**
 * `gh`, exactly the shape of server.js's fetchIssueFromGitHub: an absolute path from
 * resolveBinary (the LaunchAgent PATH has no /opt/homebrew/bin), argv and NEVER a shell,
 * a 15s ceiling, and every failure — missing binary, non-zero exit, timeout — resolving
 * to a reason rather than rejecting.
 */
function runGh(argv, cwd) {
  return new Promise((resolve) => {
    const gh = resolveBinary('gh');
    if (!gh) return resolve({ error: 'gh-unavailable' });
    execFile(gh, argv, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // One line, not one per poll: the negative cache is what keeps this rare.
          ctx.log(`[workshop] gh ${argv[0]} ${argv[1] || ''} failed in ${cwd}: ${err.message.split('\n')[0]}`);
          return resolve({ error: 'gh-failed' });
        }
        resolve({ stdout });
      });
  });
}

/**
 * Which repo the backlog is about.
 *
 * An explicit `?project=` pins it; otherwise it follows the browser's active session,
 * which is the whole design — the backlog shows the project you are looking at rather
 * than owning a notion of "current repo" of its own. resolveProject goes through
 * ctx.sessionPaths, so a `github-issue-671` worktree tab resolves to its PARENT repo and
 * asks about deepsteve, not about the worktree.
 *
 * The last resort is the most recently active live session. A browser that has just
 * opened Workshop with no session focused still gets the project the machine is
 * evidently working on, which beats an empty panel that looks broken.
 */
function backlogProject(query) {
  const explicit = String((query && query.project) || '').trim();
  if (explicit) return projectScope.canonicalRoot(explicit) || '';

  const sessionId = String((query && query.session) || '').trim();
  if (sessionId && ctx.shells.has(sessionId)) {
    const p = projectScope.resolveProject(null, sessionId, ctx);
    if (p) return p;
  }

  let best = null;
  for (const [, entry] of ctx.shells) {
    if (!entry || entry.agentType === 'tmux-attach') continue;
    if (!best || (entry.lastActivity || 0) > (best.lastActivity || 0)) best = entry;
  }
  return best ? projectFor(best).project : '';
}

/** Live sessions as backlog.js wants them: no ctx, no engines, no terminal screens. */
function sessionsForMatch() {
  const out = [];
  for (const [id, entry] of ctx.shells) {
    // Same two exclusions derivedItems makes: a killed session is not working on
    // anything, and a tmux-attach is an ephemeral view of a pane rather than a tab.
    if (!entry || entry.killed || entry.agentType === 'tmux-attach') continue;
    out.push({
      id,
      name: entry.name || null,
      worktree: entry.worktree || null,
      project: projectFor(entry).project,
    });
  }
  return out;
}

/**
 * A label is a command-line argument, and argv means no quoting to get wrong — but it is
 * still worth refusing something that cannot be a GitHub label, so a junk localStorage
 * value produces an empty list rather than a 15s `gh` timeout per refresh.
 *
 * Three outcomes, not two (#679). Absent and malformed used to collapse to the same `''`,
 * which is why "no filter" had nowhere to live: `''` now means *list everything* and a
 * present-but-unusable value returns `null` so the route can still refuse it before
 * spawning anything.
 */
function cleanLabel(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (s.length > 60 || /[\n\r\0]/.test(s)) return null;
  return s;
}

// ── derived blocked items ────────────────────────────────────────────────────

/**
 * Which of the three answer paths WOULD fire for a stored item, computed now. The
 * panel's send bar names it before you press Enter, because the three behave
 * completely differently and "resolves the agent's pending call" and "types into a
 * live dialog" should not look identical.
 */
function pendingPathFor(item) {
  if (inbox.hasWait(item.id)) return 'held';
  if (item.sessionId && ctx.shells.has(item.sessionId)) return 'prompt';
  // A result outlives its session by design (it is exempt from the dead-session sweep),
  // so an open one with nowhere to deliver is a NORMAL end state, not a broken row — and
  // the panel has to say so before the human clicks Approve rather than after. Scoped to
  // results: for a question this state resolves itself when the sweep dismisses the row.
  if (item.kind === 'result' && item.status === 'open') return 'gone';
  return null;
}

function serializeStored(item) {
  const entry = item.sessionId ? ctx.shells.get(item.sessionId) : null;
  return {
    ...item,
    pendingPath: pendingPathFor(item),
    sessionAlive: !!entry,
    answerable: item.kind !== 'briefing' && item.status === 'open',
    // The session verbs (#682), on every row that has a live session behind it — not
    // just the derived idle ones. A question from an agent that has since finished its
    // work is exactly as closable as any other, and the panel cannot work either of
    // these out for itself: getSessions() reports THIS window's tabs, not the server's
    // sessions, so a row for an agent in another window would look unreachable.
    canClose: !!entry,
    canMerge: !!(entry && entry.worktree),
  };
}

function scrapeFor(id, entry, now) {
  const seq = entry.outputSeq != null ? entry.outputSeq : (entry.lastActivity || 0);
  const prev = scrapeCache.get(id);
  if (prev && prev.seq === seq) return prev;

  let lines = screenLines(entry, SCRAPE_ROWS);
  let detected = dialogParse.detectDialog(lines);
  let parsed = detected ? dialogParse.parseDialog(lines) : null;

  // A dialog we can see but not read may simply have been cut off by the 30-row
  // window — nine options with wrapped labels overflow it. Widen once before giving
  // up and falling back to a raw preview.
  if (detected && !parsed) {
    const wide = screenLines(entry, WIDE_ROWS);
    if (wide.length > lines.length) {
      const wideDetected = dialogParse.detectDialog(wide);
      const wideParsed = wideDetected ? dialogParse.parseDialog(wide) : null;
      if (wideParsed) {
        lines = wide;
        detected = wideDetected;
        parsed = wideParsed;
      }
    }
  }

  // The whole dialog block, not the parsed question: parseDialog returns null on a
  // dialog whose option run it cannot walk, and those all shared one empty
  // fingerprint — every unreadable dialog on the machine inheriting one age, and
  // (since the mute below is keyed on this) one dismissal.
  const questionFp = dialogParse.dialogFingerprint(lines);
  // Carry the clock forward across a repaint: a status-line tick or a resize bumps
  // outputSeq without changing the question, and resetting the age there would make
  // the wait colouring meaningless.
  const blockedSince = (prev && prev.blockedSince && prev.questionFp === questionFp)
    ? prev.blockedSince
    : now;

  // The idle clock (#682), on the same principle and a wider fingerprint. questionFp
  // is '' on every screen with no dialog — which is every idle screen — so it cannot
  // carry this one; screenFingerprint hashes the whole tail instead. A repaint that
  // changed nothing keeps the clock running, and any change to what is on screen is
  // the agent doing something, which restarts it.
  const screenFp = dialogParse.screenFingerprint(lines);
  const idleSince = (prev && prev.idleSince && prev.screenFp === screenFp)
    ? prev.idleSince
    : now;

  const fresh = { seq, lines, detected, parsed, questionFp, blockedSince, screenFp, idleSince };
  scrapeCache.set(id, fresh);
  return fresh;
}

/**
 * "This agent finished and is waiting on YOU" — the second derived kind (#682).
 *
 * Workshop's actionable population used to be gated entirely on detectDialog, and the
 * arithmetic of that gate is what made the panel informational: on a normal machine
 * nothing is showing a dialog most of the time, so the bench was empty and the page
 * was whatever sat below it. The state a human actually has to act on far more often
 * is this one — the turn ended, nothing is queued, and nobody has said what next.
 *
 * Every clause below exists to keep this from becoming the noise the old gate was
 * avoiding, so none of them is optional:
 *
 *   sessionInputState === 'idle'  the agent is at a prompt we can positively read.
 *                                 A plain shell has no screenMarkers and classifies
 *                                 'unknown', which is what keeps a bash prompt — idle
 *                                 by nature, forever — out of the bench.
 *   nothing queued                a prompt already on its way is not a wait on you.
 *   idle >= idleAfterMs           between-turns flicker is not a wait either.
 *   not snoozed                   you already looked at this one.
 *
 * Returns null rather than a row, so the caller's loop stays a flat scan.
 */
function idleRowFor(id, entry, scrape, now, idleAfterMs) {
  if (ctx.sessionInputState(entry) !== 'idle') return null;
  if (entry.pendingDelivery) return null;
  if (entry.promptQueue && entry.promptQueue.length > 0) return null;
  if (now - scrape.idleSince < idleAfterMs) return null;

  const snooze = snoozedSessions.get(id);
  if (snooze) {
    // Ends on either count: the clock ran out, or the session moved on, which makes
    // this a different wait from the one that was snoozed.
    //
    // Keyed on the screen fingerprint and NOT on idleSince. Two timestamps taken in
    // the same millisecond are equal, so a timestamp key silently reads "the session
    // has not moved on" for any change that lands inside one tick of the clock — and
    // a fast agent's next message is exactly that. The fingerprint is what identifies
    // a wait; the same rule, and the same reason, as the dialog mute above.
    if (snooze.screenFp === scrape.screenFp && now < snooze.until) return null;
    snoozedSessions.delete(id);
  }

  const { project, projectName } = projectFor(entry);
  const said = dialogParse.lastAgentLine(scrape.lines);
  return {
    id: inbox.idleId(id),
    kind: 'idle',
    status: 'open',
    // Deliberately NOT 'blocking'. A blocked agent cannot proceed without you; this
    // one has simply run out of instructions. Ranking them together would put every
    // finished session above a real dialog, which is how a bench stops being read.
    urgency: 'normal',
    sessionId: id,
    sessionName: entry.name || null,
    project,
    projectName,
    worktree: entry.worktree || null,
    // Opaque to the panel, echoed back to /dismiss so a snooze cannot land on a wait
    // that started after the row was drawn.
    fingerprint: scrape.screenFp,
    headline: said || 'Finished — waiting for you',
    question: '',
    context: '',
    options: [],
    recommendation: '',
    cursorIndex: null,
    multi: null,
    // There is always something to do with an idle session: say the next thing.
    answerable: true,
    preview: scrape.lines.slice(-PREVIEW_ROWS),
    createdAt: scrape.idleSince,
    answeredAt: null,
    answer: null,
    deliveredVia: null,
    dismissedReason: null,
    pendingPath: 'prompt',
    sessionAlive: true,
    // What the bench may offer beyond a prompt. Computed here because the panel has
    // no way to know either: it sees this window's tabs, not the server's sessions.
    canClose: true,
    canMerge: !!entry.worktree,
    inFlight: false,
  };
}

function derivedItems(now, { idleAfterMs = IDLE_AFTER_DEFAULT_MS } = {}) {
  const out = [];
  const live = new Set();

  for (const [id, entry] of ctx.shells) {
    live.add(id);
    if (!entry || entry.killed) continue;
    // A tmux-attach entry is somebody else's terminal; we do not drive it.
    if (entry.agentType === 'tmux-attach') continue;
    // A cheap pre-filter, NOT the truth: sessionInputState maps 'waiting' to 'idle',
    // and 'idle' covers a session sitting at an empty composer just as much as one
    // showing a dialog. detectDialog below is the real membership gate.
    if (!entry.waitingForInput) continue;
    // Cost control: never make readTerminalScreen build an emulator from scrollback.
    if (!entry.terminalScreen) continue;

    const scrape = scrapeFor(id, entry, now);
    if (!scrape.detected) {
      const row = idleRowFor(id, entry, scrape, now, idleAfterMs);
      if (row) out.push(row);
      continue;
    }

    // Dismissed, and still the same question — stay quiet. A different fingerprint
    // means the tab moved on, so the mute expires with the dialog that earned it.
    const muted = mutedDialogs.get(id);
    if (muted !== undefined) {
      if (muted === scrape.questionFp) continue;
      mutedDialogs.delete(id);
    }

    const { project, projectName } = projectFor(entry);
    const parsed = scrape.parsed;
    out.push({
      id: inbox.blockedId(id),
      kind: 'blocked',
      status: 'open',
      urgency: 'blocking',
      sessionId: id,
      sessionName: entry.name || null,
      project,
      projectName,
      worktree: entry.worktree || null,
      dialogKind: scrape.detected.kind,
      // Opaque to the panel — it only ever echoes it back to /dismiss, so that muting
      // a row can refuse when the tab has started asking something else since the poll.
      fingerprint: scrape.questionFp,
      headline: parsed ? parsed.headline : 'Waiting on a dialog',
      question: parsed ? parsed.question : '',
      context: parsed ? parsed.context.join('\n') : '',
      options: parsed
        ? parsed.options.map((o) => ({ label: o.label, selected: o.selected }))
        : [],
      recommendation: '',
      cursorIndex: parsed ? parsed.cursorIndex : null,
      multi: parsed ? parsed.multi : null,
      // Unparseable, or parsed with no locatable cursor, means we cannot move
      // relative to anything — the card falls back to a raw preview and "open the tab".
      answerable: !!(parsed && parsed.cursorIndex !== null),
      preview: parsed ? null : scrape.lines.slice(-PREVIEW_ROWS),
      createdAt: scrape.blockedSince,
      answeredAt: null,
      answer: null,
      deliveredVia: null,
      dismissedReason: null,
      pendingPath: 'dialog',
      sessionAlive: true,
      canClose: true,
      canMerge: !!entry.worktree,
      inFlight: inFlightChoices.has(id),
    });
  }

  for (const id of [...scrapeCache.keys()]) {
    if (!live.has(id)) scrapeCache.delete(id);
  }
  // A mute outlives its dialog for no one's benefit. Keyed off the CACHED scrape
  // rather than this pass's filters on purpose: waitingForInput flickering false
  // during a repaint skips the re-scrape, and dropping the mute there would flash a
  // dismissed row back for one poll.
  for (const id of [...mutedDialogs.keys()]) {
    const scrape = scrapeCache.get(id);
    if (!live.has(id) || !scrape || !scrape.detected) mutedDialogs.delete(id);
  }
  // The same sweep for snoozes. Only the dead-session half — the "moved on" half is
  // idleRowFor's, because it needs the row's own idleSince to compare against and a
  // snoozed session is one we deliberately did not build a row for.
  for (const id of [...snoozedSessions.keys()]) {
    if (!live.has(id)) snoozedSessions.delete(id);
  }
  return out;
}

// ── path 3: answering a live dialog ──────────────────────────────────────────

function engineFor(entry) {
  return entry.engine || (ctx.getDefaultEngine && ctx.getDefaultEngine()) || null;
}

/**
 * Move the cursor RELATIVE to where it already is, confirm it landed, and only then
 * commit. #607's "confirmed, not assumed" lesson applied to a menu.
 *
 * Deliberately not submitToShell: its confirmEcho waits for the composer to echo the
 * text, and a modal has no composer, so every answer would burn the full cap waiting
 * for an echo that can never arrive.
 *
 * `expectFp` is the fingerprint of the label the human actually clicked. Between the
 * poll that drew the card and the click, the dialog can be replaced by a DIFFERENT
 * dialog with the same number of options, and a bare index comparison would happily
 * press the wrong button. Checked before the first key and again before Enter.
 */
async function sendChoice(sessionId, targetIndex, expectFp) {
  const entry = ctx.shells.get(sessionId);
  if (!entry) return { ok: false, reason: 'session-gone' };

  const before = dialogParse.parseDialog(await readFresh(entry, SCRAPE_ROWS));
  if (!before) return { ok: false, reason: 'no-dialog' };
  if (before.cursorIndex === null) return { ok: false, reason: 'no-cursor' };
  if (targetIndex >= before.options.length) return { ok: false, reason: 'bad-option' };
  if (expectFp && dialogParse.fingerprint(before.options[targetIndex].label) !== expectFp) {
    return { ok: false, reason: 'dialog-changed' };
  }

  const delta = targetIndex - before.cursorIndex;
  if (Math.abs(delta) > MAX_STEPS) return { ok: false, reason: 'too-far' };
  const key = delta > 0 ? KEYS.Down : KEYS.Up;

  for (let i = 0; i < Math.abs(delta); i++) {
    // Re-checked INSIDE the loop: at 250ms per key this can outlive the session.
    const live = ctx.shells.get(sessionId);
    if (!live || live.killed) return { ok: false, reason: 'session-gone' };
    const engine = engineFor(live);
    if (!engine) return { ok: false, reason: 'no-engine' };
    engine.write(sessionId, key);
    await sleep(KEY_GAP_MS);
  }

  await sleep(SETTLE_MS);

  let landed = null;
  let swapped = false;
  for (let attempt = 0; attempt < VERIFY_TRIES; attempt++) {
    const live = ctx.shells.get(sessionId);
    if (!live || live.killed) return { ok: false, reason: 'session-gone' };
    const after = dialogParse.parseDialog(await readFresh(live, SCRAPE_ROWS));
    if (after && after.cursorIndex === targetIndex) {
      const label = (after.options[targetIndex] || {}).label;
      if (!expectFp || dialogParse.fingerprint(label) === expectFp) { landed = after; break; }
      // The cursor went where we asked, but the row under it is no longer the row the
      // human clicked — the dialog was replaced mid-dance. A distinct reason, because
      // "retry" is right for a cursor that lagged and wrong for a swapped dialog.
      swapped = true;
    }
    await sleep(KEY_GAP_MS);
  }

  // THE point of the whole dance. An unverified Enter commits an unknown option in
  // someone's live session. Leaving the cursor moved but uncommitted is a real but
  // small side effect and strictly the better failure. We deliberately do NOT send
  // Escape to "restore": Escape cancels the dialog, which is a decision the human
  // did not make.
  if (!landed) {
    return {
      ok: false,
      reason: swapped ? 'dialog-changed' : 'cursor-did-not-land',
      steps: Math.abs(delta),
    };
  }

  const live = ctx.shells.get(sessionId);
  if (!live || live.killed) return { ok: false, reason: 'session-gone' };
  const engine = engineFor(live);
  if (!engine) return { ok: false, reason: 'no-engine' };
  engine.write(sessionId, KEYS.Enter);

  return {
    ok: true,
    steps: Math.abs(delta),
    direction: delta > 0 ? 'Down' : delta < 0 ? 'Up' : 'none',
    optionLabel: landed.options[targetIndex].label,
  };
}

// ── prompt text for path 2 ───────────────────────────────────────────────────

function answerSubject(item) {
  const raw = (item.headline || item.question || '').split('\n')[0].trim();
  return raw ? raw.slice(0, 200) : `question #${item.seq}`;
}

function formatAnswer(answer) {
  if (!answer) return '(no answer)';
  const parts = [];
  if (answer.optionLabel) parts.push(answer.optionLabel);
  if (answer.text) parts.push(answer.text);
  return parts.join('\n\n') || '(no answer)';
}

function answerPrompt(item) {
  return `[Workshop] Re: ${answerSubject(item)}\n\n${formatAnswer(item.answer)}`;
}

// ── results (#669) ───────────────────────────────────────────────────────────

/**
 * True only for the Approve option, by INDEX.
 *
 * By index and never by label, because the index is what inbox.js mints and what
 * applyAnswer validates against the minted list. Matching on the label would put a
 * string an agent could influence between "the human clicked the first button" and
 * "the merge is unlocked".
 *
 * Text with no option picked is therefore NOT an approval. A human who types a reaction
 * and hits Enter has said something about the work, which is a request for changes at
 * worst and ambiguous at best — and the ambiguous case must never be the one that
 * unlocks a merge.
 */
function isApproval(item) {
  return !!(item && item.answer && item.answer.optionIndex === inbox.APPROVE_INDEX);
}

/**
 * The prompt a decision delivers into the session.
 *
 * Distinct from answerPrompt() because a result's answer is an instruction, not a reply:
 * the agent's next move differs completely between the two, and "Approve" on its own
 * line does not say which.
 */
function resultPrompt(item) {
  const note = (item.answer && item.answer.text) || '';
  if (isApproval(item)) {
    return `[Workshop] Result #${item.seq} approved.${note ? `\n\n${note}` : ''}\n\n`
      + 'Call mcp__deepsteve__issue_complete now to find out whether to merge.';
  }
  return `[Workshop] Changes requested on result #${item.seq}.${note ? `\n\n${note}` : ''}\n\n`
    + 'Address this, then call share_result again with what changed. issue_complete will '
    + 'refuse until a result is approved.';
}

/**
 * Record a decision on the caller's live shell entry, the way the issue picker stamps
 * `autopilot` (server.js) — issue_complete reads both at completion time.
 *
 * Only ever called with a decision the human made. `resultApprovedAt` is the single
 * field that unlocks a merge, and this is the only function that sets it.
 *
 * A rejection clears BOTH, so the agent is back to "share a result first": the result it
 * shared no longer stands, and leaving `resultItemId` set would park it on a decision
 * that has already been made.
 */
function stampResultDecision(sessionId, approved) {
  const entry = sessionId ? ctx.shells.get(sessionId) : null;
  if (!entry) return false;
  if (approved) {
    entry.resultApprovedAt = Date.now();
  } else {
    entry.resultItemId = null;
    entry.resultApprovedAt = null;
  }
  if (ctx.saveState) ctx.saveState();
  return true;
}

/**
 * The list row's one-line subject. A result has no `headline` argument of its own — the
 * schema is prose — so the first non-empty line of the summary becomes one, and
 * itemSubject() in the panel keeps working with no knowledge of results at all.
 */
function resultHeadline(summary) {
  const lines = String(summary || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[0].slice(0, 200) : 'Result';
}

// ── MCP tools ────────────────────────────────────────────────────────────────

function init(context) {
  ctx = context;

  return {
    workshop_ask: {
      description:
        'Ask the human a question and put it on the Workshop inbox — the one surface they watch '
        + 'for everything that needs them. Returns IMMEDIATELY by default: the answer arrives '
        + 'later as a new message in this session, so end your turn instead of polling. Use it '
        + 'for a decision you genuinely cannot make alone, not for progress updates (use '
        + 'workshop_brief for those). Supply `options` whenever the decision is a choice — a '
        + 'human answers a menu far faster than a paragraph — and say which one you would pick '
        + 'in `recommendation`. Set `wait_seconds` only when you truly cannot proceed and a '
        + 'quick yes unblocks you. You never identify yourself: session, project and worktree '
        + 'are attached automatically.',
      schema: {
        question: z.string().describe('The decision you need, in one sentence, phrased so it can be answered without opening your tab.'),
        context: z.string().optional().describe('What the human needs in order to answer: what you tried, what is at stake, the file or command involved. Markdown is fine.'),
        options: z.array(z.object({
          label: z.string().describe('Short and pickable — a button caption, not a sentence.'),
          detail: z.string().optional().describe('One line on what choosing this means.'),
        })).max(9).optional().describe('The choices, in the order to show them. Max 9 — the inbox binds keys 1-9.'),
        recommendation: z.string().optional().describe('Which option you would pick and why, in one line.'),
        urgency: z.enum(['fyi', 'normal', 'blocking']).optional().describe('"blocking" means you are stopped until this is answered; it sorts to the top of the inbox. Default "normal".'),
        wait_seconds: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Hold this call open up to N seconds waiting for an answer (1-${MAX_WAIT_SEC}). Omit unless you cannot continue — the MCP request itself dies at 60s.`),
      },
      handler: async (args, extra) => {
        if (inbox.openCount() >= inbox.MAX_OPEN) {
          return text(
            `The Workshop inbox already has ${inbox.MAX_OPEN} unanswered items, so this question `
            + 'was not added. Something is posting questions nobody is answering — stop and tell '
            + 'the user rather than retrying.',
          );
        }

        const item = inbox.add({
          kind: 'question',
          ...callerFields(extra),
          urgency: args.urgency,
          headline: args.question,
          context: args.context,
          options: args.options,
          recommendation: args.recommendation,
        });
        inbox.save();
        ctx.log(
          `[workshop] ask ${item.id} session=${item.sessionId || '?'} urgency=${item.urgency} `
          + `options=${item.options.length} wait=${args.wait_seconds || 0}`,
        );

        // Re-clamped even though the schema bounds it: `schema` is a raw Zod shape and
        // a non-validating client can hand the handler anything.
        const seconds = Number(args.wait_seconds) || 0;
        if (seconds > 0) {
          const ms = Math.min(MAX_WAIT_SEC, Math.max(1, Math.floor(seconds))) * 1000;
          const answer = await inbox.holdForAnswer(item, ms);
          if (answer) return text(`Answer to #${item.seq}: ${formatAnswer(answer)}`);
        }

        return text(
          `Question #${item.seq} is on the Workshop inbox. The answer will arrive as a new `
          + 'message — end your turn now rather than polling.',
        );
      },
    },

    workshop_brief: {
      description:
        'Post a short briefing to the Workshop inbox — something the human should see but does '
        + 'not have to answer. A milestone reached, a judgement call worth knowing about, '
        + 'something surprising you found. It needs no reply and archives with one key. Do not '
        + 'use it to ask a question (use workshop_ask), and do not narrate routine progress: a '
        + 'briefing that says nothing trains the human to stop reading them.',
      schema: {
        headline: z.string().describe('One line carrying the whole point, useful with nothing else read.'),
        detail: z.string().optional().describe('Supporting detail. Markdown is fine.'),
        tag: z.string().optional().describe('A short label grouping related briefings, e.g. "release" or "issue-660".'),
      },
      handler: async (args, extra) => {
        const item = inbox.add({
          kind: 'briefing',
          ...callerFields(extra),
          headline: args.headline,
          context: args.detail,
          tag: args.tag,
        });
        inbox.save();
        ctx.log(`[workshop] brief ${item.id} session=${item.sessionId || '?'} tag=${item.tag || '-'}`);
        return text(`Briefing #${item.seq} is on the Workshop inbox. No reply is needed.`);
      },
    },

    share_result: {
      description:
        'Post the writeup that justifies the work you just did, and park until a human has '
        + 'read it. This is an APPROVAL GATE, not a status update: when workflow stages are '
        + 'enabled, issue_complete will refuse to tell you to merge until a result you shared '
        + 'has been approved. Returns IMMEDIATELY — end your turn; the decision arrives as a '
        + 'new message in this session. Approve means "call issue_complete now"; a request for '
        + 'changes brings the reviewer\'s words back to you, and you fix them and share again. '
        + 'Write `summary` for a person who has not read your diff and will not open your tab: '
        + 'what changed and WHY THIS SHAPE, not a changelog. Attach `images` whenever a picture '
        + 'is the evidence — a UI change reviewed from prose is not reviewed. You never identify '
        + 'yourself: session, project and worktree are attached automatically.',
      schema: {
        summary: z.string().describe('What you changed and why this shape, in prose. The justification, not a changelog. The first line becomes the inbox subject, so lead with the point.'),
        before: z.string().optional().describe('The observable behaviour before your change — what the reviewer would have seen. Text, or the reference of an image you also pass in `images`.'),
        after: z.string().optional().describe('The same thing after it. The pair is what makes the change judgeable without running it.'),
        images: z.array(z.string()).max(images.MAX_IMAGES).optional().describe(
          `Evidence, by reference: a screenshot id from screenshot_capture / list_screenshots, or a path to an image file inside this session's project. Max ${images.MAX_IMAGES}. Never a data URL or base64 — pass the id or the path and the file is copied into the record for you.`,
        ),
        caveats: z.string().optional().describe('What this does NOT cover: what you left out, what you could not test, what should be watched after it ships. Say "none" rather than omitting it if you genuinely believe there are none.'),
      },
      handler: async (args, extra) => {
        if (inbox.openCount() >= inbox.MAX_OPEN) {
          return text(
            `The Workshop inbox already has ${inbox.MAX_OPEN} unanswered items, so this result `
            + 'was not added. Something is posting items nobody is answering — stop and tell '
            + 'the user rather than retrying.',
          );
        }

        const fields = callerFields(extra);
        const item = inbox.add({
          kind: 'result',
          ...fields,
          headline: resultHeadline(args.summary),
          context: args.summary,
          before: args.before,
          after: args.after,
          caveats: args.caveats,
        });

        // After add(), because the files are named for the item. sweepOrphans then runs
        // against the post-retention list, which is what collects the images of any
        // result this insert just evicted.
        const entry = item.sessionId ? ctx.shells.get(item.sessionId) : null;
        const ingested = images.ingest(item, args.images, { entry, ctx });
        item.images = ingested.images;
        images.sweepOrphans(inbox.all());
        inbox.save();

        // The stamp that makes issue_complete say "you shared one, it is awaiting review".
        // On its own it REFUSES the merge — only the human's Approve adds resultApprovedAt.
        if (entry) {
          entry.resultItemId = item.id;
          entry.resultApprovedAt = null;
          if (ctx.saveState) ctx.saveState();
        }

        ctx.log(
          `[workshop] result ${item.id} session=${item.sessionId || '?'} `
          + `images=${item.images.length} skipped=${ingested.skipped.length}`,
        );

        // Named, never swallowed: an agent that believes it attached a screenshot and
        // silently did not will write its next result exactly the same way.
        const skipNote = ingested.skipped.length
          ? '\n\nNot attached: '
            + ingested.skipped.map((s) => `${s.ref} (${s.reason})`).join('; ')
            + '.'
          : '';

        return text(
          `Result #${item.seq} is on the Workshop inbox awaiting review. End your turn now — `
          + 'the decision will arrive as a new message. Do not call issue_complete until this '
          + `is approved, and do not merge or close this session.${skipNote}`,
        );
      },
    },

    workshop_say: {
      description:
        'Reply into the Workshop chat pane — the panel where the human is reading your work '
        + 'and asking about it. Use this when a question arrives in this session that came '
        + 'from that pane, and for nothing else: it is a reply channel, not a progress log. '
        + 'You only need it if you were told to; agents whose conversation the panel can '
        + 'already read are never asked to call it. Markdown renders, including fenced code.',
      schema: {
        text: z.string().describe('Your reply, as you would say it to the person reading. Markdown is fine.'),
      },
      // No session parameter, deliberately, and this is the property that keeps the
      // security note at the top of this file true: callerFields pins the thread to the
      // CALLER's own session, so there is no spelling of this tool that writes into
      // another agent's conversation.
      handler: async (args, extra) => {
        const { sessionId } = callerFields(extra);
        if (!sessionId) {
          return text(
            'This session could not be identified, so there is no chat thread to reply into. '
            + 'Answer in your own transcript instead.',
          );
        }
        if (!sayAllowed(sessionId, Date.now())) {
          return text(
            `That is more than ${SAY_MAX_PER_WINDOW} replies in a minute. Stop calling this and `
            + 'tell the user what is going on in your own words instead — the pane is a '
            + 'conversation, not a log.',
          );
        }
        const message = chatStore.append(sessionId, { role: 'agent', text: args.text });
        if (!message) return text('There was nothing to say — the text was empty.');
        ctx.log(`[workshop] say ${message.id} session=${sessionId} ${message.text.length}ch`);
        return text('Delivered to the Workshop chat pane.');
      },
    },

    workshop_check: {
      description:
        'Check whether a Workshop question or result has been decided yet, by the ticket '
        + 'number workshop_ask or share_result returned. Only needed if you chose to keep '
        + 'working instead of ending your turn; the normal path is to end your turn and let '
        + 'the answer arrive as a new message. Returns the answer if one is in, otherwise says '
        + 'it is still open.',
      schema: {
        ticket: z.string().describe('The ticket workshop_ask or share_result returned, e.g. "12" or "#12".'),
      },
      handler: async ({ ticket }) => {
        const id = inbox.normalizeTicket(ticket);
        if (!id) {
          return text(`"${ticket}" is not a ticket number. Use the number workshop_ask returned, e.g. "12".`);
        }
        const item = inbox.byId(id);
        if (!item) return text(`There is no Workshop item ${id}.`);
        const isResult = item.kind === 'result';

        if (item.status === 'dismissed') {
          const why = item.dismissedReason ? ` (${item.dismissedReason})` : '';
          return text(isResult
            ? `Result #${item.seq} was archived without a decision${why}, so it does not count `
              + 'as approved. Share a fresh result if you still need to complete.'
            : `#${item.seq} was archived without an answer${why}. Do not wait on it.`);
        }
        if (item.status !== 'answered') {
          return text(isResult
            ? `Result #${item.seq} is still awaiting review. Rather than checking again, end your `
              + 'turn — the decision will arrive as a new message when the human gets to it.'
            : `#${item.seq} is still open. Rather than checking again, end your turn — the answer `
              + 'will arrive as a new message in this session when the human gets to it.');
        }
        if (isResult) {
          const note = (item.answer && item.answer.text) ? `\n\n${item.answer.text}` : '';
          return text(isApproval(item)
            ? `Result #${item.seq} was APPROVED.${note}\n\nCall issue_complete now.`
            : `Result #${item.seq} was returned for CHANGES.${note}\n\nAddress it and call `
              + 'share_result again.');
        }
        return text(`Answer to #${item.seq}: ${formatAnswer(item.answer)}`);
      },
    },
  };
}

// ── chat (#670) ──────────────────────────────────────────────────────────────

/** Does this agent keep a transcript we can read, and where? Null when it does not.
 *
 * Two questions, deliberately asked together, because the chat pane treats the answer as
 * one thing: null means "use the workshop_say store instead". supportsSessionWatch is the
 * daemon's own predicate for "transcript-backed", so no agent id is named here — a new
 * agent that keeps a readable transcript gets the transcript path for free.
 *
 * ctx.transcriptPath alone is not enough: it is shared with #672 and answers only "where
 * WOULD it be", which for a non-transcript agent is a path that never exists. Reading it
 * as the agent-type switch would work today only because those agents happen to carry no
 * claudeSessionId, which is a coincidence, not a rule.
 */
function transcriptFor(entry) {
  if (!entry) return null;
  if (!ctx.getAgentConfig(entry.agentType).supportsSessionWatch) return null;
  return ctx.transcriptPath(entry);
}

/**
 * The entry behind a session id, live or closed.
 *
 * getSavedSession is what makes "a closed session has a readable history" true: a
 * tombstoned record still carries cwd, worktree, configDir and claudeSessionId, which is
 * everything transcriptPath needs. The session is gone; the conversation is not.
 */
function chatEntry(sessionId) {
  if (!sessionId) return null;
  return ctx.shells.get(sessionId) || ctx.getSavedSession(sessionId) || null;
}

/** Read the tail of a transcript. Returns '' for a file that is not there yet. */
function readTail(file, bytes) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.size) return '';
    const len = Math.min(stat.size, bytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, stat.size - len);
    return buf.toString('utf8');
  } catch {
    // ENOENT is the #542 case and the common one: a session spawned with --session-id
    // writes no .jsonl until its FIRST message, so a tab that has never been prompted
    // has no file. That is "nothing yet", not an error, and the caller renders it as
    // an empty thread.
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * One session's conversation, from whichever of the two sources it actually has.
 *
 * The source is chosen by transcriptFor returning null, which is the daemon's own
 * supportsSessionWatch predicate — so nothing here names an agent. Both branches return
 * the SAME message shape, which is what makes "the pane must not look like two different
 * features" structurally true rather than a thing to remember.
 *
 * Deliberately NOT cached. The path has to be re-derived every call anyway, because
 * adoptClaudeSession rewrites entry.claudeSessionId on a fork, a /clear and a plan-mode
 * exit and emits no event — so the path IS the cache key and every rotation is a full
 * rebuild regardless. Measured, a full parse of a 1MB tail costs 2.6ms even when the file
 * behind it is 139MB. A delta reader would buy that back at the price of assuming the
 * file is strictly append-only, which we cannot prove, and a wrong assumption there
 * corrupts a thread silently. The bound that matters is on the WIRE (`since`), not here.
 */
function chatMessages(entry, sessionId) {
  const file = transcriptFor(entry);
  if (file) {
    const { messages, truncated } = transcript.parseTranscript(readTail(file, CHAT_TAIL_BYTES));
    return { source: 'transcript', messages: messages.map(clampMessage), truncated };
  }
  return {
    source: 'store',
    messages: chatStore.thread(sessionId).map(clampMessage),
    truncated: false,
  };
}

/** Cap one message's body, and normalise `at` to epoch ms across both sources. */
function clampMessage(m) {
  const over = m.text.length > MAX_MESSAGE_CHARS;
  return {
    id: m.id || m.uuid || null,
    role: m.role,
    text: over ? m.text.slice(0, MAX_MESSAGE_CHARS) : m.text,
    at: typeof m.at === 'number' ? m.at : null,
    ...(over ? { truncated: true } : {}),
  };
}

/**
 * Everything after `since`, or everything if `since` is unknown.
 *
 * An unknown cursor is the normal case twice over — first load, and the poll after a fork
 * rotates the transcript onto a file whose ids the client has never seen — so it must mean
 * "send it all", not "send nothing".
 */
function sliceSince(messages, since) {
  if (!since) return messages;
  const at = messages.findIndex((m) => m.id === since);
  return at === -1 ? messages : messages.slice(at + 1);
}

/**
 * The text actually delivered into the session.
 *
 * No `[Workshop] Re:` prefix, unlike answerPrompt: an answer arrives cold and has to name
 * what it is answering, whereas a chat message is a chat message and should read as one in
 * the terminal. Attribution rides on options.source, which is what the submit log consumes.
 *
 * The one addition is the reply instruction, and it is chosen HERE — at delivery time, by
 * agent type — rather than living in the issue prompt. That is what lets the workflow
 * stages stay agent-agnostic while the agents that need the tool still hear about it.
 */
function chatPrompt(body, entry) {
  if (transcriptFor(entry)) return body;
  return `${body}\n\n${SAY_INSTRUCTION}`;
}

const SAY_INSTRUCTION =
  '(Reply with the workshop_say tool — that is what reaches the human’s Workshop chat '
  + 'pane. Text printed in this terminal does not.)';

// sessionId -> [timestamps], the workshop_say rate limiter's sliding window.
const sayCalls = new Map();

function sayAllowed(sessionId, now) {
  const recent = (sayCalls.get(sessionId) || []).filter((t) => now - t < SAY_WINDOW_MS);
  if (recent.length >= SAY_MAX_PER_WINDOW) {
    sayCalls.set(sessionId, recent);
    return false;
  }
  recent.push(now);
  sayCalls.set(sessionId, recent);
  return true;
}

// ── REST ─────────────────────────────────────────────────────────────────────

function registerRoutes(app, context) {
  ctx = ctx || context;

  app.get('/api/workshop/inbox', (req, res) => {
    const now = Date.now();
    const stored = inbox.all();

    // Skip the sweep entirely while ctx.shells might still be filling up after boot,
    // or every restart dismisses the whole inbox.
    if (ctx.shells.size > 0 || now - BOOTED_AT > BOOT_GRACE_MS) {
      const changed = inbox.sweepDeadSessions(stored, (sid) => ctx.shells.has(sid), now);
      if (changed) inbox.save();
    }

    const includeClosed = req.query.all === '1';
    const items = inbox.sortForInbox([
      ...stored.filter((i) => includeClosed || i.status === 'open').map(serializeStored),
      ...derivedItems(now, { idleAfterMs: idleAfterFrom(req.query) }),
    ]);
    res.json({ items, generatedAt: now });
  });

  app.post('/api/workshop/items/:id/answer', async (req, res) => {
    const body = req.body || {};
    const blockedSession = inbox.parseBlockedId(req.params.id);
    if (blockedSession) return answerBlocked(res, blockedSession, body);
    const idleSession = inbox.parseIdleId(req.params.id);
    if (idleSession) return answerIdle(res, idleSession, body);
    return answerStored(res, req.params.id, body);
  });

  app.post('/api/workshop/items/:id/dismiss', (req, res) => {
    const blockedSession = inbox.parseBlockedId(req.params.id);
    if (blockedSession) return dismissBlocked(res, blockedSession, req.body || {});
    const idleSession = inbox.parseIdleId(req.params.id);
    if (idleSession) return snoozeIdle(res, idleSession, req.body || {});
    const item = inbox.byId(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found' });
    const wasOpenResult = item.kind === 'result' && item.status === 'open';
    const status = inbox.applyDismiss(item, (req.body && req.body.reason) || 'archived');
    if (status !== 'ok') {
      return res.status(409).json({ error: status, item: serializeStored(item) });
    }
    // Archiving an open result un-parks its agent. Without this the session sits at
    // "you shared #N and it is awaiting review" for a review that has been thrown away —
    // the one state issue_complete has no way out of. Not an approval: stampResultDecision
    // with `false` clears both fields, so the agent is back to "share a result first".
    if (wasOpenResult) stampResultDecision(item.sessionId, false);
    inbox.save();
    ctx.log(`[workshop] dismiss ${item.id} reason=${item.dismissedReason}`
      + (wasOpenResult ? ' unparked=yes' : ''));
    res.json({ item: serializeStored(item) });
  });

  // ── managing the session itself (#682) ──
  //
  // A bench you can only answer FROM is still a place you leave to do the work. These
  // two are the verbs an idle row actually needs: the session is finished, so either
  // its work goes home or the tab does.
  //
  // Both are addressed by SESSION id, not item id. A row is a view of a session and is
  // rebuilt every poll; "close the session behind the row I am looking at" is the
  // durable statement, and it is still true if the row has moved.

  app.post('/api/workshop/sessions/:id/close', (req, res) => {
    const id = req.params.id;
    if (!ctx.shells.has(id)) return res.status(404).json({ error: 'no-session' });
    // ctx.closeSession is server.js's own, which writes a `closed: true` tombstone
    // rather than deleting the record — the same path the tab's own close button
    // takes. Workshop must never grow a second, tombstone-free way to end a session.
    if (!ctx.closeSession(id)) return res.status(409).json({ error: 'close-failed' });
    snoozedSessions.delete(id);
    scrapeCache.delete(id);
    ctx.log(`[workshop] close session=${id} from=bench`);
    res.json({ ok: true, sessionId: id });
  });

  app.post('/api/workshop/sessions/:id/merge', (req, res) => {
    const id = req.params.id;
    const entry = ctx.shells.get(id);
    if (!entry) return res.status(404).json({ error: 'no-session' });
    // Offered only on a worktree row, and re-checked here: the panel's copy of the
    // session is up to a poll old, and merging "into whatever the main checkout has
    // checked out" from a session that is ALREADY the main checkout is a merge of a
    // branch into itself at best and a surprise at worst.
    if (!entry.worktree) return res.status(400).json({ error: 'not-a-worktree' });

    let cwd = '';
    let repoRoot = '';
    try { ({ cwd, repoRoot } = ctx.sessionPaths(entry)); } catch { /* reported below */ }
    if (!cwd || !repoRoot) return res.status(400).json({ error: 'no-repo' });

    const target = typeof req.body?.target === 'string' && req.body.target.trim()
      ? req.body.target.trim()
      : undefined;
    const result = mergeWorktree({ git: runGit, worktreeCwd: cwd, repoRoot, target });
    ctx.log(`[workshop] merge session=${id} ${result.branch || '?'} -> ${result.target || '?'}`
      + ` = ${result.status}`);
    // No auto-close on success, unlike the merge_worktree MCP tool. That one arms one
    // because the AGENT has to be told to stop and reliably isn't; here a human is
    // looking at the row, with Close one key away. Closing a session somebody did not
    // ask to close is not a thing to do on their behalf.
    // Every status other than `merged` left the target checkout untouched, and the
    // panel says which one it was. Not a 500: "the target is dirty" is an answer.
    res.json(result);
  });

  // ── backlog (#671) ──
  //
  // Registered before the /items/:id routes for the same reason mods/scheduled-tasks
  // puts /history first: a literal path must not be shadowed by a parameterised one.

  app.get('/api/workshop/backlog', async (req, res) => {
    const project = backlogProject(req.query);
    const label = cleanLabel(req.query && req.query.label);
    const now = Date.now();

    if (!project) {
      return res.json({ project: '', projectName: '', label, issues: [], generatedAt: now, error: 'no-project' });
    }
    // An ABSENT label is not an error — it is the unfiltered backlog, every open issue in
    // the project (#679). Only a malformed one is refused, and it is refused here so that
    // a junk stored value never reaches `gh`.
    if (label === null) {
      return res.json({
        project, projectName: projectScope.displayName(project),
        label: '', issues: [], generatedAt: now, error: 'bad-label',
      });
    }

    const maxAgeMs = Math.max(MIN_MAX_AGE_MS,
      Math.min(MAX_MAX_AGE_MS, Number(req.query && req.query.maxAgeMs) || backlog.BACKLOG_TTL_MS));

    const result = await issueCache.get(`${project}\0${label}`, async () => {
      const r = await runGh(backlog.issueListArgs(label), project);
      if (r.error) return { error: r.error, issues: [] };
      const issues = backlog.parseIssues(r.stdout);
      return { issues, truncated: issues.length >= backlog.MAX_ISSUES };
    }, { now, maxAgeMs });

    res.json({
      project,
      projectName: projectScope.displayName(project),
      label,
      // Matched on the way OUT, never cached: the issue list is minutes-stale by design
      // but "which tab is on it" must be current, or a tab opened thirty seconds ago
      // stays invisible for two minutes.
      issues: backlog.matchSessions(result.issues || [], sessionsForMatch(), project),
      truncated: !!result.truncated,
      error: result.error || null,
      cached: !!result.cached,
      ageMs: result.ageMs || 0,
      generatedAt: now,
    });
  });

  app.get('/api/workshop/labels', async (req, res) => {
    const project = backlogProject(req.query);
    const now = Date.now();
    if (!project) return res.json({ project: '', labels: [], error: 'no-project' });

    const result = await labelCache.get(project, async () => {
      const r = await runGh(['label', 'list', '--json', 'name,color', '--limit', '100'], project);
      if (r.error) return { error: r.error, labels: [] };
      return { labels: backlog.parseLabels(r.stdout) };
    }, { now });

    res.json({ project, labels: result.labels || [], error: result.error || null });
  });

  // A result's evidence (#669). Serves ONLY out of the Workshop image store, and only
  // names that store itself produced — every question about where the bytes came from
  // was settled at ingest time in images.js. Behind security.authGate like every mod
  // route.
  app.get('/api/workshop/images/:file', (req, res) => {
    const full = images.servePath(req.params.file);
    if (!full) return res.status(404).end();
    res.sendFile(full);
  });

  // ── chat (#670) ──
  // Addressed by DEEPSTEVE SESSION ID and nothing else. The route never accepts a path, a
  // cwd, a configDir or a claudeSessionId, so there is no spelling of it that reads an
  // arbitrary file: the only way to name a transcript is to be a session the daemon
  // already knows about, and the entry lookup is what does the naming.
  app.get('/api/workshop/chat/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const entry = chatEntry(sessionId);
    if (!entry) return res.status(404).json({ error: 'session-unknown' });

    const { source, messages, truncated } = chatMessages(entry, sessionId);
    const alive = ctx.shells.has(sessionId);
    const blocked = alive ? !!scrapeFor(sessionId, entry, Date.now()).detected : false;
    const slice = sliceSince(messages, req.query.since);

    res.json({
      sessionId,
      source,
      // The client resets its `since` cursor whenever this changes. A fork copies the
      // history into a NEW file with new uuids, so every id the client holds is stale at
      // that moment and the whole thread has to re-render — visually identical, but from
      // ids that exist. Cheap, and it is the entire handling of a rotation.
      threadKey: source === 'transcript' ? (entry.claudeSessionId || null) : 'store',
      alive,
      blocked,
      // A session with no transcript yet has said nothing yet — that is #542, and it is
      // not an error at any layer.
      empty: messages.length === 0 ? (source === 'transcript' ? 'never-prompted' : 'no-replies') : null,
      truncated,
      messages: slice,
      head: messages.length ? messages[messages.length - 1].id : null,
      total: messages.length,
    });
  });

  app.post('/api/workshop/chat/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const body = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
    if (!body) return res.status(400).json({ error: 'empty' });

    // 1. Gone. Not defensive: deliverPromptWhenReady is a SILENT no-op on a missing shell,
    //    so without this the human watches a message sit queued forever.
    const entry = ctx.shells.get(sessionId);
    if (!entry) {
      return res.status(409).json({
        error: 'session-gone',
        hint: 'This session has closed. Its history stays readable, but there is nobody to answer.',
      });
    }

    // 2. Showing a dialog. This one prevents a real misfire rather than a confusing one:
    //    a permission prompt classifies as 'waiting' (screen-classifier.js), so
    //    drainPromptQueue would take the screen for idle and submit half a second later —
    //    typing a paragraph of prose into a modal whose Enter answers a question the human
    //    never read. Same refusal answerBlocked makes, for the same reason, reusing the
    //    same detector rather than adding a second one.
    if (scrapeFor(sessionId, entry, Date.now()).detected) {
      return res.status(409).json({
        error: 'session-blocked',
        hint: 'This session is waiting on a dialog — answer that from the inbox first, or press o to open the tab.',
      });
    }

    // 3. Mid key-dance. A chat message interleaved with sendChoice's arrow keys would
    //    corrupt both.
    if (inFlightChoices.has(sessionId)) return res.status(409).json({ error: 'busy' });

    // On the store path the human's own message has nowhere else to be recorded, so it
    // goes in before delivery. On the transcript path it must NOT: Claude will write it
    // itself, and a copy here would show every question twice.
    const onStorePath = !transcriptFor(entry);
    const stored = onStorePath ? chatStore.append(sessionId, { role: 'human', text: body }) : null;

    // The FIFO, never submitToShell and never e.pendingDelivery — the queue is what
    // sequences this behind whatever the agent is already mid-way through, which is the
    // whole difference between asking a question and interrupting one.
    ctx.deliverPromptWhenReady(sessionId, chatPrompt(body, entry), {
      source: 'workshop-chat',
      skipIf: (sid) => !ctx.shells.has(sid),
      skipReason: 'session gone before the Workshop chat message could be delivered',
      onDeliver: (sid) => ctx.log(`[workshop] chat -> ${sid} ${body.length}ch`),
    });
    // Length, never content — the same rule the answer log follows.
    ctx.log(`[workshop] chat queued session=${sessionId} ${body.length}ch path=${onStorePath ? 'store' : 'transcript'}`);
    res.json({ queued: true, message: stored });
  });

  app.get('/api/workshop/items/:id/screen', async (req, res) => {
    const stored = inbox.byId(req.params.id);
    const sessionId = inbox.parseBlockedId(req.params.id)
      || inbox.parseIdleId(req.params.id)
      || (stored && stored.sessionId);
    if (!sessionId) return res.status(404).json({ error: 'not-found' });
    const entry = ctx.shells.get(sessionId);
    if (!entry) return res.status(404).json({ error: 'session-gone' });
    const n = Math.max(1, Math.min(WIDE_ROWS, Number(req.query.lines) || PREVIEW_ROWS));
    res.json({ lines: screenLines(entry, n), state: ctx.sessionInputState(entry) });
  });
}

function answerStored(res, id, body) {
  const item = inbox.byId(id);
  if (!item) return res.status(404).json({ error: 'not-found' });

  const status = inbox.applyAnswer(item, { text: body.text, optionIndex: body.optionIndex });
  if (status !== 'ok') {
    // 409 for the two-browsers race, 400 for a malformed answer.
    return res.status(status === 'not-open' ? 409 : 400)
      .json({ error: status, item: serializeStored(item) });
  }

  const isResult = item.kind === 'result';
  // The ONE line in this file that can unlock a merge, and it is downstream of a human
  // pressing a key in the panel. Stamped before delivery so an agent that is somehow
  // already mid-turn cannot read a stale entry after the prompt lands.
  const stamped = isResult ? stampResultDecision(item.sessionId, isApproval(item)) : false;

  // Path 1 BEFORE path 2, and only after applyAnswer, so a concurrent workshop_check
  // can never observe "answered, but no answer".
  let via;
  if (inbox.releaseWait(item.id, item.answer)) {
    via = 'inline';
  } else if (item.sessionId && ctx.shells.has(item.sessionId)) {
    // The FIFO, never submitToShell and never e.pendingDelivery directly — the queue
    // is what sequences this behind anything already staged for the session.
    ctx.deliverPromptWhenReady(item.sessionId, isResult ? resultPrompt(item) : answerPrompt(item), {
      source: 'workshop',
      skipIf: (sid) => !ctx.shells.has(sid),
      skipReason: 'session gone before the Workshop answer could be delivered',
      onDeliver: (sid) => ctx.log(`[workshop] delivered ${item.id} -> ${sid}`),
    });
    via = 'prompt';
  } else {
    // Say so rather than swallowing it. An inbox that silently drops an answer is
    // worse than one that admits it went nowhere.
    via = 'undelivered';
  }

  item.deliveredVia = via;
  inbox.save();
  const opt = item.answer.optionIndex === null ? '-' : String(item.answer.optionIndex + 1);
  // Length, never content.
  ctx.log(
    `[workshop] answer ${item.id} via=${via} option=${opt} `
    + `${item.answer.optionLabel ? JSON.stringify(item.answer.optionLabel) : ''} `
    + `text=${item.answer.text.length}ch`
    + (isResult ? ` decision=${isApproval(item) ? 'approved' : 'changes'} stamped=${stamped ? 'yes' : 'no'}` : ''),
  );

  // A result whose session has gone is a decision worth RECORDING and impossible to
  // deliver — the record is the whole point of the kind, so it is written either way and
  // the panel is told plainly that the agent was never informed. Nothing was written to
  // any PTY on this path; `via` already says undelivered.
  const note = (isResult && !stamped)
    ? 'Recorded. That session is gone, so the agent was not told — nothing was typed anywhere.'
    : undefined;
  res.json({ item: serializeStored(item), deliveredVia: via, ...(note ? { note } : {}) });
}

async function answerBlocked(res, sessionId, body) {
  const hasIndex = body.optionIndex !== undefined && body.optionIndex !== null && body.optionIndex !== '';
  if (!hasIndex) {
    // Free text into a modal is refused by design. A permission prompt has no text
    // field at all, and Escape-then-type would cancel the very tool call the agent
    // was asking about — a decision the human did not make.
    return res.status(400).json({
      error: 'text-not-answerable',
      hint: 'This session is showing a dialog — pick one of its options, or press o to open the tab and answer it there.',
    });
  }

  const idx = Number(body.optionIndex);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'bad-option' });

  const entry = ctx.shells.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session-gone' });
  if (inFlightChoices.has(sessionId)) return res.status(409).json({ error: 'busy' });

  inFlightChoices.add(sessionId);
  try {
    const result = await sendChoice(sessionId, idx, body.expect || '');
    // Whatever happened, the cached screen is stale now.
    scrapeCache.delete(sessionId);

    if (!result.ok) {
      ctx.log(`[workshop] answer blocked:${sessionId} REFUSED reason=${result.reason}`
        + `${result.steps ? ` steps=${result.steps}` : ''} — no Enter sent`);
      return res.status(409).json(result);
    }

    // logRcWrite only logs text matching /(^|\s)\/rc(\s|$)/ — deliberately not a
    // keylogger — and arrow keys plus \r can never match it, so it is a genuine
    // no-op on this path. THIS line is the only record that a human moved a cursor
    // and pressed Enter in someone else's session. Do not delete it as redundant.
    ctx.log(
      `[workshop] answer blocked:${sessionId} via=keys steps=${result.steps} `
      + `dir=${result.direction} option=${idx + 1} ${JSON.stringify(result.optionLabel)} verified=yes`,
    );
    res.json({ ok: true, ...result });
  } finally {
    inFlightChoices.delete(sessionId);
  }
}

/**
 * Dismissing a live dialog (#663).
 *
 * The original design refused this outright — Escape IS a decision, and a snooze
 * would need exactly the per-row state deriving blocked items removes. What that
 * missed is the row nobody will ever act on: a worktree whose issue shipped from
 * somewhere else, an abandoned tab, a dialog Workshop cannot even parse well enough
 * to answer. Those pin a permanent BLOCKING row nothing in the system can clear,
 * because every other removal path here waits on a human answering or on the session
 * disappearing altogether.
 *
 * So this is a mute, not a dismissal: nothing is written, no tombstone is minted, and
 * the dialog is left exactly as it was. It says "not this question", and the row
 * returns unprompted the moment the tab asks a different one.
 *
 * `expect` is the fingerprint the row carried when it was drawn, echoed back — the
 * same confirmed-not-assumed check sendChoice makes before it presses a button, and
 * for the same reason. A dialog can be replaced between the poll and the click, and
 * muting whatever happens to be on screen NOW would silence a question the human has
 * never seen. That is the one failure a mute must not have, so a mismatch refuses.
 */
function dismissBlocked(res, sessionId, body) {
  const entry = ctx.shells.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session-gone' });

  const scrape = scrapeFor(sessionId, entry, Date.now());
  if (!scrape.detected) {
    return res.status(409).json({
      error: 'no-dialog',
      hint: 'That dialog is already gone — the row drops on the next refresh.',
    });
  }
  if (body.expect && body.expect !== scrape.questionFp) {
    return res.status(409).json({
      error: 'dialog-changed',
      hint: 'That tab is asking something else now — the row will redraw with the new question.',
    });
  }

  mutedDialogs.set(sessionId, scrape.questionFp);
  ctx.log(`[workshop] mute blocked:${sessionId} fp=${scrape.questionFp}`);
  res.json({ ok: true, muted: true, sessionId, fingerprint: scrape.questionFp });
}

// ── path 4: an idle session (#682) ───────────────────────────────────────────

/**
 * How long a session must have been idle, from the panel's own setting.
 *
 * Clamped rather than validated: a missing, absurd or hostile value becomes a usable
 * number instead of a 400, because this is a listing route the panel polls every two
 * seconds and there is nothing a failed poll can tell the human that a sane default
 * cannot. 0 survives the clamp on purpose — see IDLE_AFTER_DEFAULT_MS.
 */
function idleAfterFrom(query) {
  const raw = Number(query && query.idleAfter);
  if (!Number.isFinite(raw) || raw < 0) return IDLE_AFTER_DEFAULT_MS;
  return Math.min(Math.round(raw * 1000), IDLE_AFTER_MAX_MS);
}

/**
 * Answering an idle row means saying the next thing — there is no dialog to drive and
 * no stored item to stamp, so this is the ONE answer path that is purely a delivery.
 *
 * deliverPromptWhenReady, never a raw engine.write: it is the per-shell FIFO that
 * sequences this behind anything already queued, and it owns the echo-gated submit
 * that makes Ink see the Enter as its own stdin read. Writing the text here directly
 * would be the #656 truncation again, from a new caller.
 */
function answerIdle(res, sessionId, body) {
  const entry = ctx.shells.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session-gone' });

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return res.status(400).json({
      error: 'empty',
      hint: 'An idle session needs something to do — type the next instruction.',
    });
  }

  ctx.deliverPromptWhenReady(sessionId, text, { source: 'workshop-bench' });
  // The row is about to stop being true, and the panel should not have to wait a poll
  // to find that out: a delivered prompt makes the session busy, which is the one
  // state idleRowFor refuses. Dropping the snooze keeps a stale one from suppressing
  // the NEXT wait, which is the one this prompt is about to create.
  snoozedSessions.delete(sessionId);
  ctx.log(`[workshop] prompt session=${sessionId} len=${text.length} from=bench`);
  res.json({ ok: true, sessionId, deliveredVia: 'prompt' });
}

/**
 * Snooze an idle row. The counterpart of dismissBlocked, and the same bargain: the
 * row goes away while the thing it was about is unchanged, and comes back by itself
 * when it isn't.
 */
function snoozeIdle(res, sessionId, body) {
  const entry = ctx.shells.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'session-gone' });

  const now = Date.now();
  const scrape = scrapeFor(sessionId, entry, now);
  if (body.expect && body.expect !== scrape.screenFp) {
    return res.status(409).json({
      error: 'session-moved-on',
      hint: 'That session has done something since — the row will redraw with what it says now.',
    });
  }

  const mins = Number(body.minutes);
  const forMs = Number.isFinite(mins) && mins > 0
    ? Math.min(Math.round(mins * 60_000), IDLE_AFTER_MAX_MS)
    : SNOOZE_DEFAULT_MS;
  const until = now + forMs;
  snoozedSessions.set(sessionId, { until, screenFp: scrape.screenFp });
  ctx.log(`[workshop] snooze idle:${sessionId} for=${Math.round(forMs / 1000)}s`);
  res.json({ ok: true, snoozed: true, sessionId, until });
}

/**
 * git for the merge route. A copy of mods/deepsteve-core/tools.js's, deliberately:
 * execFileSync on a bare argv with no shell, no `zsh -l` (git is /usr/bin/git and the
 * bare CI unit runner has no zsh at all), and it never throws — a failed merge is a
 * value here, not an exception, because reporting which way it failed is the job.
 */
function runGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message || '' };
  }
}

module.exports = { init, registerRoutes };
