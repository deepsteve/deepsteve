/**
 * Inbox (#660, #669) — what is waiting on you right now, and nothing else.
 *
 * A row exists only while something is blocked on the human, and goes the moment that stops
 * being true. Two things qualify, and inboxRows() is the one builder for both:
 *
 *   - a tab that is ASKING: showing a permission / AskUserQuestion / plan dialog. The test is
 *     the daemon's own `asking` signal (docs/sessions.md#asking), the one that puts the `?` on
 *     the tab, so the Inbox and the tab strip cannot disagree. DERIVED per request from
 *     ctx.shells and never stored, so it exists exactly as long as the dialog does.
 *   - an open question (inbox_ask) or result (share_result) whose session is still alive
 *     (inbox.isListed). An item whose session has gone stays in the store, answerable through
 *     its decision link and readable by inbox_answers, but nothing is waiting on it.
 *
 * Briefings, idle and working sessions, and merges that did not land are not on it: none of
 * them is a question. A scheduled run's report goes to its task's run history instead.
 *
 * The panel POLLS its own routes rather than receiving a broadcast. That is not an
 * oversight: a new push feed would need a notifyX/onXChanged pair in
 * public/js/mod-manager.js plus a dispatch line in public/js/app.js.
 *
 * The App bar's badge (#718) polls too, and it is the one reader that runs while the panel is
 * closed. GET /api/inbox/count is the length of the same inboxRows() the list returns. It
 * reads a screen only for a tab that is already asking, and that read is cached on the
 * session's output sequence, so a dialog sitting on screen costs one read, not one per poll.
 *
 * Inbox shipped (#660) with no host edit at all. It now has exactly one: ctx.transcriptPath,
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
 * the agent's own transcript when it keeps one, else the inbox_say store in
 * ./chat-store.js. Both render identically. The parsing rules are in ./transcript.js and
 * the markdown in ./markdown.js, and neither sees this ctx — same split, same reason.
 *
 * ── Why Inbox deliberately does NOT go through requestMetaControlsConsent ──
 *
 * The meta-controls gate prices one specific risk: an AGENT typing into another
 * agent's session without the human knowing (#519). Every PTY write in this file
 * originates from a human pressing a key in the Inbox panel, in the host UI, on
 * this machine, behind the same auth cookie that already authorizes closing the
 * session outright. Routing it through the consent modal would ask the user to
 * approve their own click — and a DECLINE there starts a 60s cooldown that would then
 * block the next unrelated meta_type.
 *
 * The five MCP tools below write nothing to any PTY; they only append to a store. The only
 * PTY writes live in the answer paths and in POST /api/inbox/chat/:sessionId, all
 * reachable exclusively from the panel and none of them called by any MCP tool. If that
 * ever stops being true — if an agent gains any way to answer another agent's item, or to
 * put text into another agent's session through here — this decision must be revisited,
 * because at that point Inbox becomes exactly the thing #519 guards.
 *
 * That still holds with the merge gate in place, and it is worth being explicit about
 * why, because "an agent can now unlock its own merge" is the shape of the thing #519
 * guards. It cannot: share_result only appends an item and stamps the caller's own
 * `resultItemId`, which by itself REFUSES the merge. The stamp that permits one —
 * `resultApprovedAt` — is written on exactly one line, in answerStored, reached only
 * from the human pressing a key in the panel. Approving is answering a question.
 *
 * inbox_say (#670) is the newest tool and the other one that looks like it moves the
 * line. It does not either: it takes no session parameter, writes only the CALLER's own
 * thread via callerFields, and reaches no PTY. An agent can put text on the human's screen,
 * which inbox_ask and inbox_brief already could; it cannot put text in another
 * agent's session, which is the thing being guarded.
 *
 * ── Decision links (#705) ──
 *
 * A question now has an address, /v1/decision/<id>, served by the core link scheme in links.js
 * with this file as its provider. The link's POST answers through answerStored() — the panel's
 * own path — behind the auth gate plus a mandatory allowlisted Origin, so the line above holds
 * unchanged: it is a human pressing a button, on a page now as well as in the panel. The one new
 * thing it can do is START a session when the asker has gone (an option's `then`, or Discuss).
 * That text was written by an agent, but it runs only on a human's click, and an agent could
 * already start a session with any prompt it liked through open_terminal.
 */

const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { z } = require('zod');
// A cross-mod require (#682, retargeted by #688). The only other one is scheduledTask()'s
// lazy read of scheduled-tasks' run history (#710). session-merge.js is
// a pure library — it takes `git` and `gh` runners and returns a status — with no ctx, no
// shells and no MCP, and it encodes the merge semantics the bench must not have a second
// opinion about: commit what is uncommitted, refuse on a dirty target, abort on conflict,
// leave the target untouched unless it says `merged`, close the issue only if it does.
// Reimplementing that here to avoid reaching across a mod boundary would be the trade
// made backwards — and it was, briefly: this route called the un-composed mergeWorktree
// and so landed only the committed half of a dirty worktree.
const { mergeSession } = require('../deepsteve-core/session-merge');
const { runGitNet } = require('../deepsteve-core/land-origin');
const projectScope = require('../../project-scope');
// #705: the /v1 link scheme's page helpers — escaping and the JSON-in-a-script encoder. The
// scheme itself is core (links.js); Inbox only registers what its ids mean.
const links = require('../../links');
const { spawnCwdProblem } = require('../../paths');
const { resolveBinary } = require('../../bin-path');
const inbox = require('./inbox');
const chatStore = require('./chat-store');
const transcript = require('./transcript');
const dialogParse = require('../../dialog-parse');
const backlog = require('./backlog');
const images = require('./images');
const contention = require('./contention');
const permissionLog = require('./permission-log');

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

// inbox_say, per session. An agent in a loop narrating itself into the human's chat
// pane is the same failure MAX_OPEN prices for inbox_ask, and needs the same answer.
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
// Written only from POST /api/inbox/items/blocked:<id>/dismiss, which no MCP tool
// calls — see the header. An agent must never be able to silence a human's inbox.
const mutedDialogs = new Map();

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
    // #705: the scheduled task this session is a run of, stamped by the scheduled-tasks mod.
    // Derived, never supplied: it is what groups a recurring job's questions and answers.
    scheduledTaskId: (entry && entry.scheduledTaskId) || null,
    project,
    projectName: projectScope.displayName(project),
  };
}

// #708: what a scheduled run is told in place of "end your turn". Nothing ever sends an
// unattended run a new message, so a run that ends its turn to wait never calls
// scheduled_task_finished: it sits in `running` and blocks every later fire of its task until
// maxRuntimeMinutes reaps it. The tool's reply is read after the prompt, so it has to agree
// with the prompt. "The way your prompt says" rather than "now", because an isolated run must
// still merge its worktree before it finishes.
const SCHEDULED_RUN_FINISH =
  'This is a scheduled run and nothing is waiting on this session, so do not end your turn to '
  + 'wait for a reply: carry on and finish the run the way your prompt says, ending with '
  + 'scheduled_task_finished.';

// ── superseded questions (#710) ──────────────────────────────────────────────
//
// A stored question stays open until something closes it. What nothing used to notice is a
// question that had stopped being the current one: you answered in the tab instead, or the
// next run of the same scheduled task already did its job. inbox.supersession() decides;
// this section gathers the facts it decides from and records its verdicts. Every fact is the
// daemon's own. None depends on the asking agent, which may be long gone by then.

/** A read-only copy of a scheduled task's run history, or null. */
function scheduledTask(taskId) {
  if (!taskId) return null;
  try {
    // Lazy, and the same module instance the mod loader already holds, so this reads the
    // live run history. Never throws: an Inbox read must not fail because of another mod.
    return require('../scheduled-tasks/tools.js').taskSnapshot(taskId);
  } catch {
    return null;
  }
}

/** When the calling scheduled run started, while its row is certainly still in the history. */
function askingRunStartedAt(caller) {
  const task = scheduledTask(caller.scheduledTaskId);
  const run = task && caller.sessionId ? task.runs.find((r) => r.sessionId === caller.sessionId) : null;
  return (run && run.startedAt) || null;
}

/** What supersession() decides from. Build one per pass, so each task is copied once. */
function supersedeFacts() {
  const tasks = new Map();
  return {
    // The live entry, else the saved record: that is how a reply made just before the session
    // closed, or just before a restart, still counts once the entry is gone.
    humanInputAt: (sid) => {
      const entry = ctx.shells.get(sid) || (ctx.getSavedSession ? ctx.getSavedSession(sid) : null);
      return (entry && entry.lastHumanInputAt) || null;
    },
    task: (taskId) => {
      if (!tasks.has(taskId)) tasks.set(taskId, scheduledTask(taskId));
      return tasks.get(taskId);
    },
  };
}

/**
 * Record every supersession the facts support, and release any agent holding in inbox_ask on
 * one of them — a `wait_seconds` hold ends the moment its question is replaced. Returns how
 * many questions it closed.
 */
function settleSuperseded(now = Date.now()) {
  const dismissed = inbox.sweepSuperseded(inbox.all(), supersedeFacts(), now);
  for (const item of dismissed) {
    inbox.releaseWait(item.id, null);
    ctx.log(`[inbox] superseded ${item.id} rule=${item.supersededBy.rule} at=${new Date(item.supersededBy.at).toISOString()}`);
  }
  if (dismissed.length) inbox.save();
  return dismissed.length;
}

/**
 * Bring the store up to date before anyone reads it, and return it. Shared by /items and
 * /count (#718) so the list and the App bar's badge are counted from the same settled store.
 */
function settleStore(now = Date.now()) {
  const stored = inbox.all();

  // #710. Not gated on boot like the sweep below, because its facts include saved session
  // records as well as live shells, so an empty ctx.shells cannot make it wrong. And it runs
  // first, so a question you replied to before its tab closed reads as superseded, not
  // session-gone.
  settleSuperseded(now);

  // Skip the sweep entirely while ctx.shells might still be filling up after boot,
  // or every restart dismisses the whole inbox.
  if (ctx.shells.size > 0 || now - BOOTED_AT > BOOT_GRACE_MS) {
    const changed = inbox.sweepDeadSessions(stored, (sid) => ctx.shells.has(sid), now);
    if (changed) inbox.save();
  }
  return stored;
}

/** Does this session have an open question asked before `at`? Only those can be superseded by it. */
function hasOpenQuestionBefore(sessionId, at) {
  return !!sessionId && inbox.all().some((i) =>
    i.kind === 'question' && i.status === 'open' && i.sessionId === sessionId && i.createdAt < at);
}

/**
 * A person sent this session something at `at`. Stamped on the session entry, where
 * serializeShellEntry carries it into state.json and onto the closed record, and settled at once.
 *
 * Only when it can matter. A stamp supersedes questions asked before it, so with none open
 * there is nothing to record, and typing in an ordinary tab costs one scan of the inbox and
 * never a state write.
 */
function recordHumanInput(sessionId, at) {
  if (!hasOpenQuestionBefore(sessionId, at)) return false;
  const entry = ctx.shells.get(sessionId);
  if (!entry) return false;
  entry.lastHumanInputAt = Math.max(entry.lastHumanInputAt || 0, at);
  settleSuperseded();
  if (ctx.saveState) ctx.saveState();
  return true;
}

/**
 * server.js calls this when a person submits a line in a session tab.
 *
 * An Enter on a permission or AskUserQuestion dialog answers the dialog, not the conversation,
 * so it is not a reply. That is read the way derived blocked rows read it, off the screen as it
 * stands before the key reaches the PTY. Inbox's own dialog answers never arrive here: they
 * are written straight to the engine, not sent over the tab's socket.
 */
function onSubmitKey(sessionId, entry) {
  const now = Date.now();
  if (!entry || !hasOpenQuestionBefore(sessionId, now)) return;
  if (scrapeFor(sessionId, entry, now).detected) return;
  recordHumanInput(sessionId, now);
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
          ctx.log(`[inbox] gh ${argv[0]} ${argv[1] || ''} failed in ${cwd}: ${err.message.split('\n')[0]}`);
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
 * opened Inbox with no session focused still gets the project the machine is
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

/**
 * Which projects the panel is currently showing.
 *
 * `?projects=` is a comma-separated list of canonical repo roots; absent or empty means
 * every project, which is both the default and the honest reading of "I have not chosen".
 * The filter is applied to ROWS rather than folded into the collection loop so that one
 * predicate serves the inbox and the permissions log — two lists that must agree about
 * what "this project" means or the picker looks broken on one of them.
 *
 * A row with no project at all (a plain shell in a non-repo directory) is kept only when
 * nothing is selected. Once you have said "these two repos", a stray shell in ~ is not
 * one of them.
 */
function projectFilter(query) {
  const raw = String((query && query.projects) || '').trim();
  if (!raw) return () => true;
  const wanted = new Set(
    raw.split(',').map((p) => projectScope.canonicalRoot(p.trim())).filter(Boolean),
  );
  if (!wanted.size) return () => true;
  return (row) => wanted.has(row && row.project);
}

/**
 * Every project this machine is evidently working in.
 *
 * Two sources unioned, because neither is the answer alone: live sessions say what is
 * happening now, and contexts.json says what the user has deliberately grouped (a repo
 * you are between sessions on must not disappear from the picker). Names go through
 * projectScope.disambiguate against THIS root set, so two repos with the same basename
 * are told apart by the list that actually renders them.
 */
function knownProjects() {
  const counts = new Map();
  const bump = (root, live) => {
    if (!root) return;
    const hit = counts.get(root) || { project: root, sessions: 0 };
    if (live) hit.sessions++;
    counts.set(root, hit);
  };

  for (const [, entry] of ctx.shells) {
    if (!entry || entry.killed || entry.agentType === 'tmux-attach') continue;
    bump(projectFor(entry).project, true);
  }
  for (const c of projectScope.getContexts(ctx)) {
    for (const dir of (Array.isArray(c && c.dirs) ? c.dirs : [])) {
      bump(projectScope.canonicalRoot(dir), false);
    }
  }

  const names = projectScope.disambiguate([...counts.keys()]);
  return [...counts.values()]
    .map((p) => ({ ...p, name: names.get(p.project) || projectScope.displayName(p.project) }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

/**
 * One project's open issues, cached, with the live tabs already matched onto them.
 *
 * Factored out so the single-project and multi-project routes cannot diverge — they read
 * the same cache under the same key, so selecting three projects and then selecting one
 * of them costs no extra `gh` at all.
 */
async function backlogFor(project, label, query, now) {
  const maxAgeMs = Math.max(MIN_MAX_AGE_MS,
    Math.min(MAX_MAX_AGE_MS, Number(query && query.maxAgeMs) || backlog.BACKLOG_TTL_MS));

  const result = await issueCache.get(`${project}\0${label}`, async () => {
    const r = await runGh(backlog.issueListArgs(label), project);
    if (r.error) return { error: r.error, issues: [] };
    const issues = backlog.parseIssues(r.stdout);
    return { issues, truncated: issues.length >= backlog.MAX_ISSUES };
  }, { now, maxAgeMs });

  return {
    ...result,
    // Matched on the way OUT, never cached: the issue list is minutes-stale by design
    // but "which tab is on it" must be current, or a tab opened thirty seconds ago
    // stays invisible for two minutes.
    issues: backlog.matchSessions(result.issues || [], sessionsForMatch(), project),
  };
}

/** Live sessions as backlog.js wants them: no ctx, no engines, no terminal screens. */
function sessionsForMatch() {
  const out = [];
  for (const [id, entry] of ctx.shells) {
    // A killed session is not working on anything, and a tmux-attach is an ephemeral
    // view of a pane rather than a tab.
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
  // A durable question (#705) outlives its session the same way, and what an answer does
  // then depends on which option is picked — so it gets its own hint rather than 'gone'.
  if (item.kind === 'question' && item.status === 'open' && item.durableUntil) return 'gone-durable';
  return null;
}

function serializeStored(item) {
  const entry = item.sessionId ? ctx.shells.get(item.sessionId) : null;
  return {
    ...item,
    pendingPath: pendingPathFor(item),
    sessionAlive: !!entry,
    answerable: item.kind !== 'briefing' && item.status === 'open',
    // #710: why a superseded question closed, for the archive (`all=1`).
    closedNote: item.supersededBy ? inbox.supersededNote(item.supersededBy) : null,
    // The session verbs (#682), on every row that has a live session behind it. A
    // question from an agent that has since finished its work is exactly as closable as
    // any other, and the panel cannot work either of
    // these out for itself: getSessions() reports THIS window's tabs, not the server's
    // sessions, so a row for an agent in another window would look unreachable.
    canClose: !!entry,
    canMerge: !!(entry && entry.worktree),
  };
}

/** The output counter a scrape is cached against: a screen that has not moved is not re-read. */
function outputSeqOf(entry) {
  return entry.outputSeq != null ? entry.outputSeq : (entry.lastActivity || 0);
}

/**
 * Read a session's dialog off its screen, cached per session on outputSeqOf(entry).
 *
 * Called only for a session that is asking, and from the answer paths that drive one, so a
 * dialog sitting on screen is read once however often the list and the badge poll.
 */
function scrapeFor(id, entry, now) {
  const seq = outputSeqOf(entry);
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

  const fresh = { seq, lines, detected, parsed, questionFp, blockedSince };
  scrapeCache.set(id, fresh);
  return fresh;
}

/**
 * The GitHub issue a session is working on, or null.
 *
 * The worktree name is the only place the daemon actually records this — startIssueSession
 * mints `github-issue-<n>` and nothing stamps a number on the entry — so the same rule
 * backlog.js matches issues to tabs with is the rule here. A tab renamed by its agent still
 * resolves, because the worktree cannot be renamed by one.
 */
function issueNumberFor(entry) {
  return backlog.worktreeIssueNumber(entry && entry.worktree);
}

/** Live sessions in the shape contention.js wants: no ctx, no engines, no screens. */
function liveSessionList() {
  const out = [];
  for (const [id, entry] of ctx.shells) {
    if (!entry || entry.killed || entry.agentType === 'tmux-attach') continue;
    let cwd = entry.cwd || '';
    try { ({ cwd } = ctx.sessionPaths(entry)); } catch { /* keep the raw cwd */ }
    out.push({ id, name: entry.name || null, cwd, worktree: entry.worktree || null });
  }
  return out;
}

/**
 * Who is holding `repoRoot` dirty, answered from the live session list.
 *
 * The merge route's answer to "who is in the way" when a merge is refused because the
 * shared checkout is dirty.
 */
function holdersFor(repoRoot, exceptId) {
  return contention.holdersOf(repoRoot, liveSessionList(), exceptId);
}

/** The fields every derived row carries, whatever kind it turns out to be. */
function rowBase(id, entry) {
  const { project, projectName } = projectFor(entry);
  return {
    sessionId: id,
    sessionName: entry.name || null,
    project,
    projectName,
    worktree: entry.worktree || null,
    issue: issueNumberFor(entry),
    agentType: entry.agentType || null,
    status: 'open',
    answeredAt: null,
    answer: null,
    deliveredVia: null,
    dismissedReason: null,
    sessionAlive: true,
    canClose: true,
    canMerge: !!entry.worktree,
  };
}

/**
 * Record a permission dialog the poll just saw.
 *
 * Called for every detected dialog, muted or not, and de-duped inside the store on
 * (session, fingerprint) — so the same dialog sitting on screen for a minute produces
 * one entry, and answering it and being asked something else produces two.
 *
 * Only `kind === 'permission'` is logged. An AskUserQuestion is the agent asking the
 * human a question about the work; a permission dialog is the agent asking to be allowed
 * to DO something, and it is the second list that is worth keeping — it is the record of
 * what the agents on this machine have wanted to run.
 */
function notePermission(id, entry, scrape, now) {
  if (!scrape.detected || scrape.detected.kind !== 'permission') return;
  const parsed = scrape.parsed;
  const { project, projectName } = projectFor(entry);
  const added = permissionLog.observe({
    sessionId: id,
    sessionName: entry.name || null,
    project,
    projectName,
    fingerprint: scrape.questionFp,
    // parsed.headline for a permission dialog is the tool line itself — "Bash(git push)",
    // "deepsteve - read_session_screen (MCP)" — which is exactly the thing worth listing.
    // An unparseable dialog still gets an entry, because "something asked and we could
    // not read it" is information too; it just carries the raw question.
    subject: parsed ? parsed.headline : 'Unreadable permission dialog',
    question: parsed ? parsed.question : '',
    options: parsed ? parsed.options.map((o) => o.label) : [],
  }, now);
  if (added) ctx.log(`[inbox] permission ${added.id} session=${id} ${added.tool}${added.target ? `(${added.target})` : ''}`);
}

/**
 * Close permission-log entries whose dialog is no longer on screen.
 *
 * Runs off the same pass that builds the rows, so it sees exactly what the poll saw. A
 * session that has no dialog up any more answered whatever it had — we cannot know WITH
 * WHAT unless the answer came through this panel, and the store is careful not to
 * pretend otherwise.
 */
function sweepPermissions(live, now) {
  for (const e of permissionLog.all()) {
    if (e.status !== 'open') continue;
    if (!live.has(e.sessionId)) { permissionLog.resolve(e.sessionId, e.fingerprint, {}, now); continue; }
    const scrape = scrapeCache.get(e.sessionId);
    const stillUp = scrape && scrape.detected && scrape.questionFp === e.fingerprint;
    if (!stillUp) permissionLog.resolve(e.sessionId, e.fingerprint, {}, now);
  }
}

/**
 * Is this session asking — showing a dialog — right now?
 *
 * The daemon's own signal, the one that puts the `?` on the tab (docs/sessions.md#asking),
 * rather than a second reading of the screen: a row the tab strip disagrees with is a row
 * nobody trusts. A tmux-attach entry is somebody else's terminal; we do not drive it.
 */
function isAsking(entry) {
  return !!(entry && !entry.killed && entry.agentType !== 'tmux-attach'
    && entry.waitingForInput && entry.asking);
}

/** The live session behind a stored item, or null. Only a live one can be waiting on an answer. */
function liveEntry(sessionId) {
  const entry = sessionId ? ctx.shells.get(sessionId) : null;
  return entry && !entry.killed ? entry : null;
}

/**
 * One row per tab that is asking. Whether a tab is asking is isAsking's call; the dialog is
 * still read off the screen, because the row renders the question and answers it.
 *
 * A muted dialog has no row. `e` on a row means "I have seen this one", and the mute is keyed
 * on the dialog, so the tab's next question brings the row straight back.
 */
function askingRows(now) {
  const out = [];
  const live = new Set();

  for (const [id, entry] of ctx.shells) {
    live.add(id);
    if (!isAsking(entry)) {
      // Forget the last read once the screen has moved: that is the dialog being answered,
      // and the permission sweep and the mute sweep below both read "no cached dialog" as
      // gone. An unchanged screen keeps it, so a waiting flag that flickers over a dialog
      // still on screen does not unmute it.
      const prev = scrapeCache.get(id);
      if (prev && prev.seq !== outputSeqOf(entry || {})) scrapeCache.delete(id);
      continue;
    }
    if (!entry.terminalScreen) continue;
    const scrape = scrapeFor(id, entry, now);
    if (!scrape.detected) continue;

    // Every permission dialog is recorded as it is seen, whether or not a row is built
    // for it — a muted dialog is still one that was asked, and the log's whole value is
    // being complete. De-duped inside on (session, fingerprint), so this runs every poll
    // and writes once per dialog.
    notePermission(id, entry, scrape, now);

    const muted = mutedDialogs.get(id);
    if (muted !== undefined) {
      if (muted === scrape.questionFp) continue;
      mutedDialogs.delete(id);
    }

    const parsed = scrape.parsed;
    out.push({
      ...rowBase(id, entry),
      id: inbox.blockedId(id),
      kind: 'blocked',
      urgency: 'blocking',
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
      pendingPath: 'dialog',
      inFlight: inFlightChoices.has(id),
    });
  }

  // Before the scrape cache is pruned: the sweep reads it to decide whether each open
  // permission entry's dialog is still on screen, and a pruned cache would read as
  // "gone" for a session that is merely absent from this pass.
  sweepPermissions(live, now);

  for (const id of [...scrapeCache.keys()]) {
    if (!live.has(id)) scrapeCache.delete(id);
  }
  // A mute outlives its dialog for no one's benefit. Keyed off the CACHED scrape, which
  // the loop above only drops once the screen has moved.
  for (const id of [...mutedDialogs.keys()]) {
    const scrape = scrapeCache.get(id);
    if (!live.has(id) || !scrape || !scrape.detected) mutedDialogs.delete(id);
  }
  return out;
}

/**
 * Everything on the Inbox right now: the tabs that are asking, and the open questions and
 * results whose session is still alive. The list and the App bar's badge both read this, so
 * the number on the rail is the number of rows in the panel.
 */
function inboxRows(now) {
  const stored = settleStore(now)
    .filter((i) => inbox.isListed(i, (sid) => !!liveEntry(sid)))
    .map(serializeStored);
  return [...stored, ...askingRows(now)];
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
  return raw ? raw.slice(0, 200) : `question ${item.id}`;
}

function formatAnswer(answer) {
  if (!answer) return '(no answer)';
  const parts = [];
  if (answer.optionLabel) parts.push(answer.optionLabel);
  if (answer.text) parts.push(answer.text);
  return parts.join('\n\n') || '(no answer)';
}

function answerPrompt(item) {
  return `[Inbox] Re: ${answerSubject(item)}\n\n${formatAnswer(item.answer)}`;
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
    return `[Inbox] Result ${item.id} approved.${note ? `\n\n${note}` : ''}\n\n`
      + 'Call mcp__deepsteve__issue_complete now to find out whether to merge.';
  }
  return `[Inbox] Changes requested on result ${item.id}.${note ? `\n\n${note}` : ''}\n\n`
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
  // #710: a line a person submits in a tab supersedes the questions that session asked. Guarded
  // like the link registry below, for a context that has no such hook.
  if (typeof ctx.registerSubmitKeyObserver === 'function') {
    ctx.registerSubmitKeyObserver('inbox', onSubmitKey);
  }
  // #705: what `/v1/<type>/w<n>` means. Guarded, so a context without the link registry (an
  // older fake ctx in a test) still loads every tool.
  if (ctx.links && typeof ctx.links.registerProvider === 'function') {
    ctx.links.registerProvider(linkProvider());
  }

  return {
    inbox_ask: {
      description:
        'Ask the human a question. It is on their Inbox while this session is open. Returns '
        + 'IMMEDIATELY by default: the answer arrives later as a new message in this session, so '
        + 'end your turn instead of polling. Use it for a decision you genuinely cannot make '
        + 'alone, not for progress updates. Supply `options` whenever the decision is a choice — a '
        + 'human answers a menu far faster than a paragraph — and say which one you would pick '
        + 'in `recommendation`. Set `wait_seconds` only when you truly cannot proceed and a '
        + 'quick yes unblocks you. You never identify yourself: session, project and worktree '
        + 'are attached automatically. The result carries a `url` that opens the question in a '
        + 'browser and answers it in one click — put it in any email or report you send about the '
        + 'decision. The question leaves the Inbox when this session closes, and from then on that '
        + 'url is the only way to it. So if this session may close before the answer arrives (a '
        + 'scheduled run that ends by emailing a report, say), send the url, set `durable_days` so '
        + 'it keeps answering, and give each option a `then` saying what a new session should do '
        + 'if it is picked after you are gone. A later run of the same scheduled task reads the '
        + 'answer with inbox_answers.',
      schema: {
        question: z.string().describe('The decision you need, in one sentence, phrased so it can be answered without opening your tab.'),
        context: z.string().optional().describe('What the human needs in order to answer: what you tried, what is at stake, the file or command involved. Markdown is fine.'),
        options: z.array(z.object({
          label: z.string().describe('Short and pickable — a button caption, not a sentence.'),
          detail: z.string().optional().describe('One line on what choosing this means.'),
          then: z.string().optional().describe('What to do if this option is picked AFTER this session has closed. A new session in this project starts with the question, the answer and this instruction; it does the work, reports the outcome, and closes itself, so write a complete action rather than the start of a conversation. Omit it and a late answer is only recorded, for inbox_answers.'),
        })).max(9).optional().describe('The choices, in the order to show them. Max 9 — the inbox binds keys 1-9.'),
        recommendation: z.string().optional().describe('Which option you would pick and why, in one line.'),
        urgency: z.enum(['fyi', 'normal', 'blocking']).optional().describe('"blocking" means you are stopped until this is answered; it sorts to the top of the inbox. Default "normal".'),
        wait_seconds: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Hold this call open up to N seconds waiting for an answer (1-${MAX_WAIT_SEC}). Omit unless you cannot continue — the MCP request itself dies at 60s.`),
        durable_days: z.number().int().min(0).max(inbox.MAX_DURABLE_DAYS).optional().describe(`Keep the question answerable through its url after this session closes, for up to N days (1-${inbox.MAX_DURABLE_DAYS}); after that it expires unanswered. It leaves the Inbox when this session closes either way. 0 or omitted: it is archived a few minutes after this session goes.`),
      },
      handler: async (args, extra) => {
        // #710: before the count, so a question something already replaced doesn't hold a slot.
        settleSuperseded();
        if (inbox.openCount() >= inbox.MAX_OPEN) {
          return text(
            `The Inbox already has ${inbox.MAX_OPEN} unanswered items, so this question `
            + 'was not added. Something is posting questions nobody is answering — stop and tell '
            + 'the user rather than retrying.',
          );
        }

        const caller = callerFields(extra);
        const item = inbox.add({
          kind: 'question',
          ...caller,
          // #710: the lower bound of "a later run of this task replaced the question".
          scheduledRunStartedAt: askingRunStartedAt(caller),
          urgency: args.urgency,
          headline: args.question,
          context: args.context,
          options: args.options,
          recommendation: args.recommendation,
          // Clamped again in inbox.js, for the reason wait_seconds is below.
          durableDays: args.durable_days,
        });
        inbox.save();
        ctx.log(
          `[inbox] ask ${item.id} session=${item.sessionId || '?'} urgency=${item.urgency} `
          + `options=${item.options.length} wait=${args.wait_seconds || 0}`
          + ` durable=${item.durableUntil ? `${inbox.clampDurableDays(args.durable_days)}d` : 'no'}`
          + (item.scheduledTaskId ? ` task=${item.scheduledTaskId}` : ''),
        );

        // Re-clamped even though the schema bounds it: `schema` is a raw Zod shape and
        // a non-validating client can hand the handler anything.
        const seconds = Number(args.wait_seconds) || 0;
        if (seconds > 0) {
          const ms = Math.min(MAX_WAIT_SEC, Math.max(1, Math.floor(seconds))) * 1000;
          const answer = await inbox.holdForAnswer(item, ms);
          if (answer) return text(`Answer to ${item.id}: ${formatAnswer(answer)}`);
        }

        // #705: the link is what an email carries. Absolute, on the canonical browser origin,
        // because it is opened from outside Deep Steve.
        const url = typeof ctx.linkUrl === 'function' ? ctx.linkUrl('decision', item.id) : null;
        // #710: the hold was released because something replaced the question while it waited —
        // a person replied in this session instead. Same keys; only what the agent is told differs.
        if (item.supersededBy) {
          const superseded = `Question ${item.id} is no longer open: ${inbox.supersededNote(item.supersededBy)} `
            + 'Do not wait on it. End your turn; whatever the person sent arrives as a new message.';
          return text(JSON.stringify({ id: item.id, url, message: superseded }, null, 2));
        }
        // #708: a scheduled run is never sent the answer as a new message — its session closes
        // when it finishes — so it is told where the answer goes instead of to wait for it.
        const message = caller.scheduledTaskId
          ? `Question ${item.id} is on the Inbox while this session is open.`
            + (item.durableUntil
              ? ` When it closes the question leaves the Inbox, and its url keeps answering it until ${new Date(item.durableUntil).toISOString()}: `
                + 'an option with a `then` starts a new session, and any other answer is kept for '
                + 'inbox_answers, which later runs of this task read.'
              : ' It has no durable_days, so it is archived a few minutes after this session closes.')
            + ` ${SCHEDULED_RUN_FINISH}`
          : `Question ${item.id} is on the Inbox. The answer will arrive as a new `
            + 'message — end your turn now rather than polling.'
            + (item.durableUntil
              ? ` If this session has closed by then, the question leaves the Inbox and its url keeps answering it until ${new Date(item.durableUntil).toISOString()}: `
                + 'an option with a `then` starts a new session, and any other answer is kept for inbox_answers.'
              : '');
        return text(JSON.stringify({ id: item.id, url, message }, null, 2));
      },
    },

    inbox_brief: {
      description:
        'Record a short briefing — a milestone reached, a judgement call worth knowing about, '
        + 'something surprising you found. It is kept for the record but NOT shown on the '
        + 'Inbox, which lists only what is waiting on the human right now: if they need to see '
        + 'it, say it in your own conversation. Do not use it to ask a question (use inbox_ask), '
        + 'and do not narrate routine progress.',
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
        ctx.log(`[inbox] brief ${item.id} session=${item.sessionId || '?'} tag=${item.tag || '-'}`);
        return text(
          `Briefing ${item.id} is recorded. The Inbox does not list briefings, so if the human `
          + 'needs to see this, say it in your own conversation.',
        );
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
            `The Inbox already has ${inbox.MAX_OPEN} unanswered items, so this result `
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
          `[inbox] result ${item.id} session=${item.sessionId || '?'} `
          + `images=${item.images.length} skipped=${ingested.skipped.length}`,
        );

        // Named, never swallowed: an agent that believes it attached a screenshot and
        // silently did not will write its next result exactly the same way.
        const skipNote = ingested.skipped.length
          ? '\n\nNot attached: '
            + ingested.skipped.map((s) => `${s.ref} (${s.reason})`).join('; ')
            + '.'
          : '';

        // #708: from a scheduled run a result is a deliverable, not a park. The stamp above is
        // still written (it only ever refuses a merge), but nobody reviews it inside this run,
        // and it leaves the Inbox when the run's session closes — so the run is pointed at the
        // place a deliverable is kept, its task's run history, and told to finish.
        if (fields.scheduledTaskId) {
          return text(
            `Result ${item.id} is on the Inbox only until this session closes. A scheduled run's `
            + 'deliverable belongs in the `report` of scheduled_task_finished, which keeps it in '
            + `this task's run history. ${SCHEDULED_RUN_FINISH}${skipNote}`,
          );
        }

        return text(
          `Result ${item.id} is on the Inbox awaiting review. End your turn now — `
          + 'the decision will arrive as a new message. Do not call issue_complete until this '
          + `is approved, and do not merge or close this session.${skipNote}`,
        );
      },
    },

    inbox_say: {
      description:
        'Reply into the Inbox chat pane — the panel where the human is reading your work '
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
        ctx.log(`[inbox] say ${message.id} session=${sessionId} ${message.text.length}ch`);
        return text('Delivered to the Inbox chat pane.');
      },
    },

    inbox_check: {
      description:
        'Check whether an Inbox question or result has been decided yet, by the id '
        + 'inbox_ask or share_result returned. Only needed if you chose to keep '
        + 'working instead of ending your turn; the normal path is to end your turn and let '
        + 'the answer arrive as a new message. Returns the answer if one is in, otherwise says '
        + 'it is still open.',
      schema: {
        id: z.string().describe('The id inbox_ask or share_result returned.'),
      },
      handler: async ({ id: rawId }) => {
        const id = inbox.normalizeId(rawId);
        if (!id) {
          return text(`"${rawId}" is not an Inbox item id. Use the id inbox_ask or share_result returned.`);
        }
        // #710: record any supersession first, so the answer below reflects it even when no panel
        // has polled.
        settleSuperseded();
        const item = inbox.byId(id);
        if (!item) return text(`There is no Inbox item ${id}.`);
        const isResult = item.kind === 'result';

        if (item.status === 'dismissed' && item.supersededBy) {
          return text(`Question ${item.id} was superseded: ${inbox.supersededNote(item.supersededBy)} `
            + 'It can no longer be answered. Do not wait on it.');
        }
        if (item.status === 'dismissed') {
          const why = item.dismissedReason ? ` (${item.dismissedReason})` : '';
          return text(isResult
            ? `Result ${item.id} was archived without a decision${why}, so it does not count `
              + 'as approved. Share a fresh result if you still need to complete.'
            : `Question ${item.id} was archived without an answer${why}. Do not wait on it.`);
        }
        if (item.status !== 'answered') {
          return text(isResult
            ? `Result ${item.id} is still awaiting review. Rather than checking again, end your `
              + 'turn — the decision will arrive as a new message when the human gets to it.'
            : `Question ${item.id} is still open. Rather than checking again, end your turn — the answer `
              + 'will arrive as a new message in this session when the human gets to it.');
        }
        if (isResult) {
          const note = (item.answer && item.answer.text) ? `\n\n${item.answer.text}` : '';
          return text(isApproval(item)
            ? `Result ${item.id} was APPROVED.${note}\n\nCall issue_complete now.`
            : `Result ${item.id} was returned for CHANGES.${note}\n\nAddress it and call `
              + 'share_result again.');
        }
        return text(`Answer to ${item.id}: ${formatAnswer(item.answer)}`);
      },
    },

    inbox_answers: {
      description:
        'Read the answers a human has given to Inbox questions — including ones answered from a '
        + 'link after the asking session had closed. From a scheduled task run it returns the answers '
        + 'to questions asked by ANY run of that same task, so a recurring job should call it at the '
        + 'start of every run (with `since` set to its previous run) and a "no" or a written reply '
        + 'reaches this run without anyone editing the job. From any other session it returns that '
        + 'session\'s own questions. Returns JSON, newest first, at most 50.',
      schema: {
        since: z.string().optional().describe('Only answers given at or after this ISO date or date-time, e.g. "2026-09-14" or "2026-09-14T08:00:00Z".'),
      },
      handler: async ({ since } = {}, extra) => {
        const LIMIT = 50;
        // #710: a superseded question was never answered, so the filter below already leaves
        // it out. Settling here only records the verdict while its facts still exist.
        settleSuperseded();
        let sinceMs = null;
        if (since != null && String(since).trim()) {
          sinceMs = Date.parse(String(since).trim());
          if (!Number.isFinite(sinceMs)) {
            return text(`"${since}" is not a date. Pass an ISO date such as "2026-09-14" or "2026-09-14T08:00:00Z".`);
          }
        }
        // Scoped by who is calling, never by a name the agent supplies: the task a scheduled run
        // belongs to, or else the calling session itself — so two jobs cannot read each other's
        // answers by happening to pick the same word.
        const caller = callerFields(extra);
        const mine = caller.scheduledTaskId
          ? (i) => i.scheduledTaskId === caller.scheduledTaskId
          : (i) => !!caller.sessionId && i.sessionId === caller.sessionId;
        const rows = inbox.all()
          .filter((i) => i.kind === 'question' && i.status === 'answered' && i.answer)
          .filter(mine)
          .filter((i) => sinceMs === null || (i.answeredAt || 0) >= sinceMs)
          .sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0))
          .slice(0, LIMIT)
          .map((i) => ({
            id: i.id,
            question: i.headline,
            answer: { optionLabel: i.answer.optionLabel || '', text: i.answer.text || '' },
            answeredAt: new Date(i.answeredAt).toISOString(),
            deliveredVia: i.deliveredVia || null,
            ...(i.followUpSessionId ? { followUpSessionId: i.followUpSessionId } : {}),
          }));
        return text(JSON.stringify(rows, null, 2));
      },
    },
  };
}

// ── chat (#670) ──────────────────────────────────────────────────────────────

/** Does this agent keep a transcript we can read, and where? Null when it does not.
 *
 * Two questions, deliberately asked together, because the chat pane treats the answer as
 * one thing: null means "use the inbox_say store instead". supportsSessionWatch is the
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
 * No `[Inbox] Re:` prefix, unlike answerPrompt: an answer arrives cold and has to name
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
  '(Reply with the inbox_say tool — that is what reaches the human’s Inbox chat '
  + 'pane. Text printed in this terminal does not.)';

// sessionId -> [timestamps], the inbox_say rate limiter's sliding window.
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

  app.get('/api/inbox/items', (req, res) => {
    const now = Date.now();
    const pick = projectFilter(req.query);
    // `all=1` is the archive: every stored item, open or closed, whatever became of its
    // session. Without it, the Inbox — what is waiting on you now.
    const rows = req.query.all === '1'
      ? [...settleStore(now).map(serializeStored), ...askingRows(now)]
      : inboxRows(now);
    res.json({ items: inbox.sortForInbox(rows.filter(pick)), generatedAt: now, projects: knownProjects() });
  });

  /**
   * The App bar's badge (#718): how many things are in the Inbox, polled by the host while
   * the panel is closed.
   *
   * The length of the list itself, through the same inboxRows() and the same project filter,
   * so the badge cannot count a row the panel would not show. Cheap enough to poll from every
   * window: the only screen it reads is an asking tab's, and that read is cached until the tab
   * draws something new.
   */
  app.get('/api/inbox/count', (req, res) => {
    const now = Date.now();
    const count = inboxRows(now).filter(projectFilter(req.query)).length;
    res.json({ count, generatedAt: now });
  });

  /**
   * The projects this machine is evidently working in — what the panel's +/- picker
   * offers.
   *
   * Three sources unioned, because no one of them is the answer on its own: live
   * sessions (what is happening now), contexts.json (what the user has deliberately
   * grouped), and recently closed sessions (what you were working on this morning and
   * will want back). Each row carries its live session count so the picker can be read
   * without opening anything.
   */
  app.get('/api/inbox/projects', (req, res) => {
    res.json({ projects: knownProjects() });
  });

  /**
   * The permissions log: what the agents here have asked to be allowed to do.
   *
   * A read-only view of a store no MCP tool can write. `?limit=` bounds the response
   * (newest first) and `?summary=1` adds the per-tool rollup, which is the form the
   * question is usually really being asked in — "what does Claude keep asking me for".
   */
  app.get('/api/inbox/permissions', (req, res) => {
    const all = permissionLog.all();
    const pick = projectFilter(req.query);
    const rows = permissionLog.sortForLog(all.filter(pick));
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    res.json({
      entries: rows.slice(0, limit),
      total: rows.length,
      summary: req.query.summary === '1' ? permissionLog.summarize(rows) : undefined,
      generatedAt: Date.now(),
    });
  });

  /**
   * Start work on an issue nobody is working on — the other half of herding.
   *
   * Inbox could show you the backlog and could show you the agents, and the only way
   * to get from one to the other was to leave. This closes that: the Issues tab lists
   * what is open, marks what already has a tab, and starts a session on what does not.
   *
   * It composes on startIssueSession exactly as POST /api/start-issue and the MCP
   * start_issue tool do — worktree creation, prompt delivery, autopilot and the
   * workflow stages are all its job, and a second implementation here would drift from
   * it the way the three pre-#642 copies did.
   */
  app.post('/api/inbox/issues/start', async (req, res) => {
    const body = req.body || {};
    const number = Number(body.number);
    if (!Number.isSafeInteger(number) || number < 1) {
      return res.status(400).json({ error: 'bad-number' });
    }
    const project = projectScope.canonicalRoot(String(body.project || '').trim());
    if (!project) return res.status(400).json({ error: 'no-project' });

    // The title is fetched rather than taken from the request: the panel's copy is up to
    // a backlog refresh old (minutes), and the title is what names the tab and, later,
    // the merge commit.
    const view = await runGh(
      ['issue', 'view', String(number), '--json', 'number,title,body,labels,url'], project,
    );
    if (view.error) return res.status(502).json({ error: view.error });
    let issue = null;
    try { issue = JSON.parse(view.stdout); } catch { /* handled below */ }
    if (!issue || !issue.title) return res.status(502).json({ error: 'bad-issue' });

    // The window the tab should open in, inherited from the session the browser has
    // focused — the same resolution POST /api/start-issue does. The mod bridge does not
    // expose a windowId of its own, and guessing wrong opens the tab in somebody else's
    // window rather than failing visibly.
    const caller = String(body.sessionId || '').trim();
    const windowId = String(body.windowId || '').trim()
      || (caller && ctx.shells.get(caller)?.windowId)
      || null;
    const result = ctx.startIssueSession({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      url: issue.url,
      cwd: project,
      windowId,
      openBrowser: true,
      source: 'inbox',
    });
    if (result.error) {
      return res.status(400).json({ error: result.error.message, code: result.error.code });
    }
    ctx.log(`[inbox] start-issue #${issue.number} in ${project} session=${result.id}`);
    res.json({
      id: result.id,
      name: result.name,
      worktree: result.worktree || null,
      resumed: result.resumed || null,
      tabDelivery: result.tabDelivery || null,
    });
  });

  app.post('/api/inbox/items/:id/answer', async (req, res) => {
    const body = req.body || {};
    const blockedSession = inbox.parseBlockedId(req.params.id);
    if (blockedSession) return answerBlocked(res, blockedSession, body);
    return answerStored(res, req.params.id, body);
  });

  app.post('/api/inbox/items/:id/dismiss', (req, res) => {
    const blockedSession = inbox.parseBlockedId(req.params.id);
    if (blockedSession) return dismissBlocked(res, blockedSession, req.body || {});
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
    ctx.log(`[inbox] dismiss ${item.id} reason=${item.dismissedReason}`
      + (wasOpenResult ? ' unparked=yes' : ''));
    res.json({ item: serializeStored(item) });
  });

  // ── managing the session itself (#682) ──
  //
  // An inbox you can only answer FROM is still a place you leave to do the work. These
  // two are the verbs a row with a live session behind it needs: either its work goes
  // home or the tab does.
  //
  // Both are addressed by SESSION id, not item id. A row is a view of a session and is
  // rebuilt every poll; "close the session behind the row I am looking at" is the
  // durable statement, and it is still true if the row has moved.

  app.post('/api/inbox/sessions/:id/close', (req, res) => {
    const id = req.params.id;
    if (!ctx.shells.has(id)) return res.status(404).json({ error: 'no-session' });
    // ctx.closeSession is server.js's own, which writes a `closed: true` tombstone
    // rather than deleting the record — the same path the tab's own close button
    // takes. Inbox must never grow a second, tombstone-free way to end a session.
    if (!ctx.closeSession(id)) return res.status(409).json({ error: 'close-failed' });
    scrapeCache.delete(id);
    ctx.log(`[inbox] close session=${id} from=bench`);
    res.json({ ok: true, sessionId: id });
  });

  app.post('/api/inbox/sessions/:id/merge', async (req, res) => {
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
    // mergeSession, not the bare mergeWorktree it used to call (#688): this route
    // merged COMMITTED work only, so a bench Merge on a worktree an agent had left dirty
    // silently landed half of it and said `merged`. The composed routine commits first
    // and closes the branch's GitHub issue afterwards — the same thing every other Merge
    // in the product now does, which is the point of there being one routine.
    const result = await mergeSession({
      git: runGit, gh: runGh, gitNet: runGitNet, cwd, repoRoot, isWorktree: true, target,
    });

    // The outcome becomes SESSION STATE, through the server's own recorder rather than a
    // field of Inbox's. A merge that did not merge used to be a red string in the
    // corner of this panel that the next poll wiped, so the single state you most need to
    // come back to — work that is finished and cannot land — was invisible everywhere the
    // moment you looked away. Now it lights the tab strip and answers get_session_info,
    // from one writer.
    if (ctx.recordMergeAttempt) ctx.recordMergeAttempt(id, result);

    // A merge that landed is also the end of whatever the agents were queuing behind the
    // shared checkout, so re-answer the contention question for the response.
    const holders = contention.describeMerge(result.status).holders
      ? holdersFor(repoRoot, id)
      : [];

    ctx.log(`[inbox] merge session=${id} ${result.branch || '?'} -> ${result.target || '?'}`
      + ` = ${result.status}${result.committed ? ' (committed)' : ''}`
      + `${holders.length ? ` held-by=${holders.map((h) => h.sessionId).join(',')}` : ''}`
      + `${result.issue && result.issue.closed ? ` closed #${result.issue.number}` : ''}`);
    // No auto-close on success, unlike the merge_session/merge_worktree MCP tools. Those
    // arm one because the AGENT has to be told to stop and reliably isn't; here a human is
    // looking at the row, with Close one key away. Closing a session somebody did not
    // ask to close is not a thing to do on their behalf.
    // Every status other than `merged` left the target checkout untouched, and the
    // panel says which one it was. Not a 500: "the target is dirty" is an answer.
    res.json({
      ...result,
      ...contention.describeMerge(result.status),
      holders,
      holderSentence: contention.describeMerge(result.status).holders
        ? contention.holderSentence(holders, projectScope.displayName(repoRoot))
        : '',
    });
  });

  // ── backlog (#671) ──
  //
  // Registered before the /items/:id routes for the same reason mods/scheduled-tasks
  // puts /history first: a literal path must not be shadowed by a parameterised one.

  app.get('/api/inbox/backlog', async (req, res) => {
    const label = cleanLabel(req.query && req.query.label);
    const now = Date.now();

    // The picker's selection, when there is one. A backlog across several repos is the
    // whole point of being able to pick them — "fire off issues in three projects, then
    // come here to herd" is one list or it is three visits.
    const chosen = String((req.query && req.query.projects) || '').trim();
    if (chosen) {
      const roots = [...new Set(
        chosen.split(',').map((p) => projectScope.canonicalRoot(p.trim())).filter(Boolean),
      )];
      if (!roots.length) {
        return res.json({ project: '', projectName: '', label, issues: [], generatedAt: now, error: 'no-project' });
      }
      if (label === null) {
        return res.json({ project: '', projectName: '', label: '', issues: [], generatedAt: now, error: 'bad-label' });
      }
      const names = projectScope.disambiguate(roots);
      const parts = await Promise.all(roots.map((root) => backlogFor(root, label, req.query, now)));
      const issues = [];
      let error = null;
      for (let i = 0; i < parts.length; i++) {
        // One repo without `gh` must not empty the whole list; it contributes nothing and
        // its reason is reported once. The backlog is an accessory and may not make the
        // rest of the panel look broken — the same rule the single-project path follows.
        if (parts[i].error) { error = error || parts[i].error; continue; }
        for (const issue of parts[i].issues) {
          issues.push({ ...issue, project: roots[i], projectName: names.get(roots[i]) || '' });
        }
      }
      return res.json({
        project: '', projectName: '', label, projects: roots,
        issues, truncated: parts.some((p) => p.truncated), error, generatedAt: now,
      });
    }

    const project = backlogProject(req.query);
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

    const result = await backlogFor(project, label, req.query, now);
    res.json({
      project,
      projectName: projectScope.displayName(project),
      label,
      issues: result.issues,
      truncated: !!result.truncated,
      error: result.error || null,
      cached: !!result.cached,
      ageMs: result.ageMs || 0,
      generatedAt: now,
    });
  });

  app.get('/api/inbox/labels', async (req, res) => {
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

  // A result's evidence (#669). Serves ONLY out of the Inbox image store, and only
  // names that store itself produced — every question about where the bytes came from
  // was settled at ingest time in images.js. Behind security.authGate like every mod
  // route.
  app.get('/api/inbox/images/:file', (req, res) => {
    const full = images.servePath(req.params.file);
    if (!full) return res.status(404).end();
    res.sendFile(full);
  });

  // ── chat (#670) ──
  // Addressed by DEEPSTEVE SESSION ID and nothing else. The route never accepts a path, a
  // cwd, a configDir or a claudeSessionId, so there is no spelling of it that reads an
  // arbitrary file: the only way to name a transcript is to be a session the daemon
  // already knows about, and the entry lookup is what does the naming.
  app.get('/api/inbox/chat/:sessionId', (req, res) => {
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

  app.post('/api/inbox/chat/:sessionId', (req, res) => {
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

    // #710: a person sending this session a message supersedes the questions it asked before
    // that moment. Stamped with when they SENT it, but only once it is delivered, so a message
    // dropped because the session went away first replaces nothing.
    const sentAt = Date.now();
    // The FIFO, never submitToShell and never e.pendingDelivery — the queue is what
    // sequences this behind whatever the agent is already mid-way through, which is the
    // whole difference between asking a question and interrupting one.
    ctx.deliverPromptWhenReady(sessionId, chatPrompt(body, entry), {
      source: 'inbox-chat',
      skipIf: (sid) => !ctx.shells.has(sid),
      skipReason: 'session gone before the Inbox chat message could be delivered',
      onDeliver: (sid) => {
        ctx.log(`[inbox] chat -> ${sid} ${body.length}ch`);
        recordHumanInput(sid, sentAt);
      },
    });
    // Length, never content — the same rule the answer log follows.
    ctx.log(`[inbox] chat queued session=${sessionId} ${body.length}ch path=${onStorePath ? 'store' : 'transcript'}`);
    res.json({ queued: true, message: stored });
  });

  app.get('/api/inbox/items/:id/screen', async (req, res) => {
    const stored = inbox.byId(req.params.id);
    const sessionId = inbox.parseBlockedId(req.params.id) || (stored && stored.sessionId);
    if (!sessionId) return res.status(404).json({ error: 'not-found' });
    const entry = ctx.shells.get(sessionId);
    if (!entry) return res.status(404).json({ error: 'session-gone' });
    const n = Math.max(1, Math.min(WIDE_ROWS, Number(req.query.lines) || PREVIEW_ROWS));
    res.json({ lines: screenLines(entry, n), state: ctx.sessionInputState(entry) });
  });
}

// ── decision links (#705) ────────────────────────────────────────────────────
//
// `/v1/decision/<id>` is owned by links.js, which knows nothing about Inbox. This section is
// Inbox's side of it: resolving an id to a link type, drawing the page, and acting on the
// page's two buttons. Everything the page does goes through the paths the panel already uses
// — an answer is answerStored(), so a link and the panel can never disagree about what an
// answer does — plus the two things only a link needs: acting when the asker has gone, and
// Discuss.
//
// Neither moves the line the header draws. A follow-up session is started from text an agent
// wrote (`then`), but only after a human clicks, and an agent could already start a session
// with any prompt it liked through open_terminal.

// The stored item decides the type, not the link: a briefing is `markdown` (reserved, so its
// link explains itself), and a result is not linkable at all — Approve on a result unlocks a
// merge, and the panel stays the only place that decision is made.
const LINK_TYPE_OF_KIND = { question: 'decision', briefing: 'markdown' };

// What the page is given. A subset on purpose: the page needs to draw the question, not to
// know the session id or the project path.
const DECISION_FIELDS = [
  'id', 'kind', 'status', 'headline', 'context', 'recommendation', 'options', 'urgency',
  'answer', 'answeredAt', 'dismissedReason', 'deliveredVia', 'sessionName', 'projectName',
  'durableUntil', 'createdAt', 'followUpSessionId',
];

function decisionView(item) {
  const out = {};
  for (const k of DECISION_FIELDS) out[k] = item[k] === undefined ? null : item[k];
  out.sessionAlive = !!(item.sessionId && ctx.shells.has(item.sessionId));
  // #710: computed, never swept, because the page is a GET. A recorded verdict wins; otherwise
  // the page works it out from the facts, so a question replaced on a machine where nothing has
  // settled it yet still refuses to show its buttons.
  out.supersededBy = item.supersededBy || inbox.supersession(item, supersedeFacts());
  out.postUrl = `/${links.LINK_VERSION}/decision/${encodeURIComponent(item.id)}`;
  return out;
}

/** GET. Writes nothing. An expired or superseded question is computed as such here, never swept. */
function renderDecisionPage(res, item) {
  const title = 'Decision';
  res.status(200).type('html').send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${links.escapeHtml(title)} · Deep Steve</title>`
    + '<link rel="stylesheet" href="/mods/inbox/decision-page.css">'
    + '</head><body><main id="decision" class="page">'
    + `<noscript><h1>${links.escapeHtml(item.headline)}</h1><p>Answering needs JavaScript.</p></noscript>`
    + '</main>'
    + `<script type="application/json" id="decision-data">${links.jsonForScript(decisionView(item))}</script>`
    + '<script type="module" src="/mods/inbox/decision-page.js"></script>'
    + '</body></html>',
  );
}

/** POST. `answer` is the panel's own path; `discuss` is the link's. */
function actOnDecision(req, res, item) {
  const body = req.body || {};
  const action = body.action || 'answer';
  if (action === 'discuss') return discussItem(res, item);
  if (action !== 'answer') return res.status(400).json({ error: 'bad-action' });
  return answerStored(res, item.id, { optionIndex: body.optionIndex, text: body.text });
}

function linkProvider() {
  return {
    name: 'inbox',
    owns: (id) => inbox.isItemId(id),
    resolve: (id) => {
      const item = inbox.byId(id);
      // A random id cannot say whether a missing item was cleared out or never existed, so
      // both resolve to null, and links.js words its not-found page to cover either.
      return item ? { type: LINK_TYPE_OF_KIND[item.kind] || null, item } : null;
    },
    render: { decision: (req, res, resolved) => renderDecisionPage(res, resolved.item) },
    act: { decision: (req, res, resolved) => actOnDecision(req, res, resolved.item) },
  };
}

/** The `then` of the option the human picked, or '' — only ever read after applyAnswer. */
function chosenThen(item) {
  const idx = item.answer ? item.answer.optionIndex : null;
  const opt = idx === null || idx === undefined ? null : item.options[idx];
  return (opt && opt.then) || '';
}

/** The question as a new session needs it: nothing in the new session saw it asked. */
function questionBrief(item) {
  const parts = [`Question: ${item.headline}`];
  if (item.context) parts.push(`Context:\n${item.context}`);
  if (item.options.length) {
    parts.push('Options:\n' + item.options
      .map((o, i) => `${i + 1}. ${o.label}${o.detail ? ` — ${o.detail}` : ''}`).join('\n'));
  }
  if (item.recommendation) parts.push(`Recommendation: ${item.recommendation}`);
  return parts.join('\n\n');
}

// A follow-up is a one-shot, not a tab someone has to find and close — the first real click
// left one doing nothing. Nothing else closes it (no merge arms an auto-close, and no
// scheduled-run contract applies), so the prompt says to, and how. A timer is deliberately not
// the backstop: the auto-close only waits while a session is BUSY, and a follow-up sitting on
// a permission prompt reads as idle, so a timer would close exactly the session still waiting
// on a human.
const FOLLOW_UP_CLOSE = [
  'When you are done:',
  '1. Post the outcome in a sentence or two with mcp__deepsteve__inbox_brief, so it outlives this session. If the instruction says to tell someone else or another session, do that too.',
  '2. Then call mcp__deepsteve__close_session with no arguments, on its own, as your very last action. It closes this session, and nothing after it is delivered.',
  // Asked in the tab, so the daemon marks it asking and it lands on the Inbox — the only list
  // that says something is waiting on the human now.
  'If you cannot finish without the human, ask them in this session (with AskUserQuestion if you have it) and leave the session open instead.',
].join('\n');

function thenPrompt(item, then) {
  const a = item.answer || {};
  const chosen = item.options[a.optionIndex] || {};
  return [
    '[Inbox] A decision was answered after the session that asked it had closed'
      + `${item.sessionName ? ` (${item.sessionName})` : ''}. You are picking up where it left off.`,
    questionBrief(item),
    `The human chose: ${chosen.label}${chosen.detail ? ` — ${chosen.detail}` : ''}`,
    ...(a.text ? [`Their note: ${a.text}`] : []),
    `What the asking session said to do on this answer:\n${then}`,
    FOLLOW_UP_CLOSE,
  ].join('\n\n');
}

function discussPrompt(item) {
  return [
    '[Inbox] The human wants to talk through a decision'
      + `${item.sessionName ? `, which ${item.sessionName} asked` : ''}. That session can't be reopened, `
      + 'so you are starting from what it left behind.',
    questionBrief(item),
    ...(item.status === 'answered' && item.answer ? [`Already answered: ${formatAnswer(item.answer)}`] : []),
    'Discuss it with them. Do not act on any option until they tell you to.',
  ].join('\n\n');
}

/**
 * Start a session in the asker's project. The project, not its worktree: the worktree was the
 * asker's, and is the thing most likely to have been merged and removed by now. The asker's
 * agent and config profile carry over from its saved record.
 */
function startFollowUp(item, { prompt, name, source }) {
  if (typeof ctx.spawnAgentSession !== 'function') return { error: 'this daemon cannot start sessions for Inbox' };
  const saved = item.sessionId && ctx.getSavedSession ? ctx.getSavedSession(item.sessionId) : null;
  const cwd = item.project || (saved && saved.cwd) || '';
  if (!cwd) return { error: 'the question has no project to start in' };
  const result = ctx.spawnAgentSession({
    cwd,
    agentType: (saved && saved.agentType) || 'claude',
    configDir: (saved && saved.configDir) || null,
    name,
    prompt,
    source,
  });
  if (!result || result.error) {
    const err = result && result.error;
    return { error: (err && (err.message || String(err))) || 'the session did not start' };
  }
  ctx.log(`[inbox] ${source} ${item.id} -> session=${result.id} cwd=${cwd}`);
  return result;
}

/** A windowId only if that window is connected now — otherwise the open would reach nobody. */
function connectedWindow(windowId) {
  if (!windowId || !ctx.reloadClients) return null;
  for (const client of ctx.reloadClients) {
    if (client.readyState === 1 && client.windowId === windowId) return windowId;
  }
  return null;
}

/**
 * Discuss: resume the asker if it is live or restorable, otherwise start a fresh session
 * seeded with the question. Changes nothing about the item.
 *
 * A live asker gets a `repair` open (a no-op for a window that already has the tab) plus
 * `focus`. A closed one gets `restore`, the single case in which the browser is asked to
 * resurrect a tombstone from a server push — see the open-session handler in app.js.
 */
function discussItem(res, item) {
  const sid = item.sessionId;
  const entry = sid ? ctx.shells.get(sid) : null;
  if (entry) {
    const target = connectedWindow(entry.windowId);
    const tabDelivery = ctx.deliverToWindow({
      type: 'open-session', id: sid, cwd: entry.cwd, name: entry.name, windowId: target, repair: true, focus: true,
    }, target, { openBrowser: true });
    ctx.log(`[inbox] discuss ${item.id} -> focus ${sid} (${tabDelivery})`);
    return res.json({ opened: 'focused', sessionId: sid, name: entry.name || sid, tabDelivery });
  }

  const saved = sid && ctx.getSavedSession ? ctx.getSavedSession(sid) : null;
  if (saved && saved.cwd && !spawnCwdProblem(saved.cwd)) {
    const tabDelivery = ctx.deliverToWindow({
      type: 'open-session', id: sid, cwd: saved.cwd, name: saved.name, windowId: null, restore: true,
    }, null, { openBrowser: true });
    ctx.log(`[inbox] discuss ${item.id} -> restore ${sid} (${tabDelivery})`);
    return res.json({ opened: 'restored', sessionId: sid, name: saved.name || sid, tabDelivery });
  }

  const spawned = startFollowUp(item, {
    prompt: discussPrompt(item), name: 'Discuss decision', source: 'inbox discuss',
  });
  if (spawned.error) return res.status(409).json({ error: 'cannot-open', message: spawned.error });
  return res.json({ opened: 'fresh', sessionId: spawned.id, name: spawned.name || spawned.id, tabDelivery: spawned.tabDelivery });
}

function answerStored(res, id, body) {
  const item = inbox.byId(id);
  if (!item) return res.status(404).json({ error: 'not-found' });

  const status = inbox.applyAnswer(
    item, { text: body.text, optionIndex: body.optionIndex }, Date.now(), supersedeFacts(),
  );
  if (status !== 'ok') {
    // #710: record the supersession this refusal is about, so the page and the panel redraw
    // from the stored verdict. A POST may write; only a link's GET may not.
    if (status === 'superseded' && item.status === 'open') settleSuperseded();
    // 409 for the two-browsers race, for a durable question whose time ran out (#705), and for
    // one something replaced (#710). All three mean "this can no longer take an answer". 400 is
    // for a malformed one.
    const refused = status === 'not-open' || status === 'expired' || status === 'superseded';
    const hint = status === 'superseded' && item.supersededBy
      ? `${inbox.supersededNote(item.supersededBy)} It can no longer be answered.`
      : null;
    return res.status(refused ? 409 : 400)
      .json({ error: status, ...(hint ? { hint } : {}), item: serializeStored(item) });
  }

  const isResult = item.kind === 'result';
  // The ONE line in this file that can unlock a merge, and it is downstream of a human
  // pressing a key in the panel. Stamped before delivery so an agent that is somehow
  // already mid-turn cannot read a stale entry after the prompt lands.
  const stamped = isResult ? stampResultDecision(item.sessionId, isApproval(item)) : false;

  // Path 1 BEFORE path 2, and only after applyAnswer, so a concurrent inbox_check
  // can never observe "answered, but no answer".
  let via;
  let note;
  if (inbox.releaseWait(item.id, item.answer)) {
    via = 'inline';
  } else if (item.sessionId && ctx.shells.has(item.sessionId)) {
    // The FIFO, never submitToShell and never e.pendingDelivery directly — the queue
    // is what sequences this behind anything already staged for the session.
    ctx.deliverPromptWhenReady(item.sessionId, isResult ? resultPrompt(item) : answerPrompt(item), {
      source: 'inbox',
      skipIf: (sid) => !ctx.shells.has(sid),
      skipReason: 'session gone before the Inbox answer could be delivered',
      onDeliver: (sid) => ctx.log(`[inbox] delivered ${item.id} -> ${sid}`),
    });
    via = 'prompt';
  } else if (!isResult) {
    // The asker has gone (#705). An option can carry `then` — what the asking session wanted
    // done on this answer — and that starts a follow-up session in its project, so a question
    // from a run that closed itself can still act on a click. Any other answer is recorded,
    // and inbox_answers is how the next run of a recurring job hears it.
    const then = chosenThen(item);
    const spawned = then
      ? startFollowUp(item, { prompt: thenPrompt(item, then), name: 'Decision follow-up', source: 'inbox then' })
      : null;
    if (spawned && !spawned.error) {
      via = 'then';
      item.followUpSessionId = spawned.id;
      note = `The asking session had closed, so its follow-up started in a new session (${spawned.name || spawned.id}).`;
    } else {
      // Say so rather than swallowing it. An inbox that silently drops an answer is
      // worse than one that admits it went nowhere.
      via = 'undelivered';
      note = spawned
        ? `Recorded, but the follow-up could not start: ${spawned.error}. A later run can still read this answer with inbox_answers.`
        : 'Recorded. The asking session is gone, so nothing was typed anywhere — a later run can read this answer with inbox_answers.';
    }
  } else {
    via = 'undelivered';
  }

  item.deliveredVia = via;
  inbox.save();
  const opt = item.answer.optionIndex === null ? '-' : String(item.answer.optionIndex + 1);
  // Length, never content.
  ctx.log(
    `[inbox] answer ${item.id} via=${via} option=${opt} `
    + `${item.answer.optionLabel ? JSON.stringify(item.answer.optionLabel) : ''} `
    + `text=${item.answer.text.length}ch`
    + (isResult ? ` decision=${isApproval(item) ? 'approved' : 'changes'} stamped=${stamped ? 'yes' : 'no'}` : '')
    + (via === 'then' ? ` followUp=${item.followUpSessionId}` : ''),
  );

  // A result whose session has gone is a decision worth RECORDING and impossible to
  // deliver — the record is the whole point of the kind, so it is written either way and
  // the panel is told plainly that the agent was never informed. Nothing was written to
  // any PTY on this path; `via` already says undelivered.
  if (isResult && !stamped) {
    note = 'Recorded. That session is gone, so the agent was not told — nothing was typed anywhere.';
  }
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
      ctx.log(`[inbox] answer blocked:${sessionId} REFUSED reason=${result.reason}`
        + `${result.steps ? ` steps=${result.steps}` : ''} — no Enter sent`);
      return res.status(409).json(result);
    }

    // logRcWrite only logs text matching /(^|\s)\/rc(\s|$)/ — deliberately not a
    // keylogger — and arrow keys plus \r can never match it, so it is a genuine
    // no-op on this path. THIS line is the only record that a human moved a cursor
    // and pressed Enter in someone else's session. Do not delete it as redundant.
    ctx.log(
      `[inbox] answer blocked:${sessionId} via=keys steps=${result.steps} `
      + `dir=${result.direction} option=${idx + 1} ${JSON.stringify(result.optionLabel)} verified=yes`,
    );
    // The one path that can honestly say what a permission dialog was answered WITH.
    // A human answering in the terminal just makes the dialog vanish, and the log is
    // deliberately silent about the choice in that case rather than guessing — so this
    // line is the difference between a list of what was asked and a list of what was
    // decided. `body.expect` is the fingerprint the panel drew the row from, which is
    // the same key the log entry was opened under.
    permissionLog.resolve(sessionId, body.expect || '', {
      answer: result.optionLabel, via: 'inbox',
    });
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
 * somewhere else, an abandoned tab, a dialog Inbox cannot even parse well enough
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
  ctx.log(`[inbox] mute blocked:${sessionId} fp=${scrape.questionFp}`);
  res.json({ ok: true, muted: true, sessionId, fingerprint: scrape.questionFp });
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
