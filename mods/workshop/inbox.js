/**
 * The Workshop item store (#660): questions and briefings agents post deliberately.
 *
 * This file NEVER sees the initMCP ctx. Anything session-aware arrives as a plain
 * callback (`isAlive`), which is what lets the whole state machine — retention,
 * expiry, the answer transitions, the pending-wait registry — be driven straight
 * from node:test with no fake context object and no daemon.
 *
 * Blocked items are deliberately absent here. They are DERIVED per request from
 * ctx.shells in tools.js and never stored: they exist exactly as long as the session
 * is waiting, so there is nothing to reconcile, no tombstone question, and no stale
 * row when a dialog resolves itself.
 *
 * Item ids are random UUIDs the server mints (#705). They used to be `w<seq>` from a
 * counter kept inside workshop.json, and an id is now an address that can sit in someone's
 * email (/v1/decision/<id>): a short sequential id invites an agent to guess or assume the
 * next one, and a store that is wiped or corrupted restarts the counter and hands a new
 * question the link of an old one. A UUID has neither problem and needs no counter at all.
 * Items stored before #705 keep the `w<seq>` ids they were minted with.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { statePath } = require('../../paths');

const FILE_VERSION = 1;

// Keep this many non-open items. Open items are exempt (see retain) — an open item
// is a live obligation, and silently dropping one discards an agent's question.
const RETENTION_CAP = 200;

// Results get their OWN bucket (#669), not a slice of the one above. A result is the
// project's durable record of what it did and why; sharing one cap with briefings means
// a chatty week of workshop_brief quietly deletes the writeup for the change that broke
// production. Two caps still bound the file — this is a second bucket, not an exemption.
const RESULT_RETENTION_CAP = 200;

// Durable questions (#705) get a third bucket, for the #669 reason. A durable question
// exists to be answered after its session has gone, and its answer is read LATER — by the
// next run of a scheduled task, through workshop_answers. A busy afternoon of briefings must
// not evict yesterday's "no" before that run reads it.
const DURABLE_RETENTION_CAP = 200;

// The other direction, which retention cannot cap: an agent in a loop posting
// questions nobody answers. workshop_ask refuses past this.
const MAX_OPEN = 500;

// How long a question's session may be absent before the question is dismissed.
// Two-phase and never eager, because ctx.shells is briefly EMPTY during the
// daemon's own boot, before sessions are restored — an eager sweep would dismiss
// the entire inbox on every restart.
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

const MAX_HEADLINE = 4000;
const MAX_CONTEXT = 8000;
const MAX_SECTION = 8000;     // a result's before / after / caveats, each on its own
const MAX_OPTIONS = 9;        // the inbox binds keys 1-9
const MAX_LABEL = 400;
const MAX_DETAIL = 1000;
const MAX_THEN = 2000;        // #705: an option's instruction for a follow-up session
const MAX_TAG = 120;

// #705. How long a durable question may wait for its answer. Bounded because a durable item
// is exempt from the dead-session sweep, so this is the ONLY thing that ever closes one
// nobody answers; 30 matches closedSessionRetentionDays' default, the horizon over which a
// session can still be restored to discuss it.
const MAX_DURABLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS = ['question', 'briefing', 'result'];
const URGENCIES = ['fyi', 'normal', 'blocking'];
const URGENCY_RANK = { blocking: 0, normal: 1, fyi: 2 };

// What the server mints now, and what items stored before #705 carry.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_ID_RE = /^w[1-9]\d*$/;

/**
 * A result's options are MINTED, never supplied (#669).
 *
 * That is the whole implementation shortcut: a result is a question with a fixed
 * two-option set, so applyAnswer, the waits registry, the panel's 1-9 bindings and the
 * answer-to-PTY path in tools.js all work on it unchanged. Index 0 is the ONLY value
 * that approves — see APPROVE_INDEX, which the answer path reads rather than matching
 * on the label.
 */
const APPROVE_INDEX = 0;
const RESULT_OPTIONS = [
  { label: 'Approve', detail: 'The work stands. The agent is told to call issue_complete.' },
  { label: 'Request changes', detail: 'Say what needs changing; the agent keeps working and shares again.' },
];

// ── pure helpers ─────────────────────────────────────────────────────────────

function clampText(value, max) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** `blocked:<sessionId>` — the synthetic id a derived item carries. */
function blockedId(sessionId) {
  return 'blocked:' + sessionId;
}

/** The session id inside a derived id, or null for anything else. */
function parseBlockedId(id) {
  if (typeof id !== 'string' || !id.startsWith('blocked:')) return null;
  const rest = id.slice('blocked:'.length);
  return rest ? rest : null;
}

/** `idle:<sessionId>` — the synthetic id an idle-awaiting-you row carries (#682). */
function idleId(sessionId) {
  return 'idle:' + sessionId;
}

/** The session id inside an idle id, or null for anything else. */
function parseIdleId(id) {
  if (typeof id !== 'string' || !id.startsWith('idle:')) return null;
  const rest = id.slice('idle:'.length);
  return rest ? rest : null;
}

/**
 * `session:<sessionId>` — the row a live session gets when it is not asking anything.
 *
 * The third derived kind, and the one that changed what the panel is for. Workshop used
 * to build rows only for sessions that were waiting on a human, so an agent doing its
 * job appeared nowhere and the list read as "the agents that used the MCP tools". A
 * session working is the ordinary state of the machine and belongs on the list; it just
 * belongs at the bottom of it.
 *
 * A separate prefix from `idle:` rather than a flag on it, because the two carry
 * different verbs: dismissing an idle row SNOOZES a wait, and there is no wait here to
 * snooze.
 */
function sessionRowId(sessionId) {
  return 'session:' + sessionId;
}

/** The session id inside a session-row id, or null for anything else. */
function parseSessionRowId(id) {
  if (typeof id !== 'string' || !id.startsWith('session:')) return null;
  const rest = id.slice('session:'.length);
  return rest ? rest : null;
}

/**
 * Is this, exactly, a stored item's id? Canonical spellings only — a LINK names an item
 * exactly, and letting `/v1/decision/W7` resolve would give one item two addresses.
 */
function isItemId(id) {
  return typeof id === 'string' && (UUID_RE.test(id) || LEGACY_ID_RE.test(id));
}

/**
 * An id as an agent might repeat it back. A UUID in any case; and, for an item stored
 * before #705, the forgiving spellings of its old ticket — 12, '#12', 'w12'.
 */
function normalizeId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (UUID_RE.test(s)) return s;
  const digits = s.replace(/^[#w]+/, '');
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return 'w' + n;
}

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_OPTIONS).map((o) => {
    const opt = (o && typeof o === 'object') ? o : { label: o };
    const out = { label: clampText(opt.label, MAX_LABEL).trim() };
    const detail = clampText(opt.detail, MAX_DETAIL).trim();
    if (detail) out.detail = detail;
    // #705: what to do if this option is picked after the asker has gone. Carried on the
    // option, not the item, because "yes" and "no" rarely share a follow-up.
    const then = clampText(opt.then, MAX_THEN).trim();
    if (then) out.then = then;
    return out;
  }).filter((o) => o.label);
}

/** 0 means "not durable" (the pre-#705 behaviour); anything else is whole days, capped. */
function clampDurableDays(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DURABLE_DAYS, n);
}

/**
 * A briefing has nothing to answer, a result has exactly two answers, and a question
 * gets whatever it asked for.
 *
 * A result's options are minted from RESULT_OPTIONS and any `fields.options` is
 * DISCARDED, not merged: the gate in issue_complete reads `optionIndex === APPROVE_INDEX`
 * and nothing else, so an agent that could add a third option — or reorder these two —
 * could hand itself an approval.
 */
function resultOptionsFor(kind, fields) {
  if (kind === 'briefing') return [];
  if (kind === 'result') return RESULT_OPTIONS.map((o) => ({ ...o }));
  return normalizeOptions(fields.options);
}

/**
 * Build one item. Pure: `id` and `now` are supplied by the caller, so a test can assert
 * exact ids without reaching into module state. add() is the impure wrapper, and the only
 * place an id is minted.
 */
function makeItem(fields = {}, { id, now = Date.now() } = {}) {
  const kind = KINDS.includes(fields.kind) ? fields.kind : 'question';
  // A result is deliberately NOT 'blocking'. The agent parked on one is stopped, so the
  // temptation is real — but every finished issue pulsing red at the top of the inbox is
  // how a human learns to stop looking at the top of the inbox.
  const urgency = URGENCIES.includes(fields.urgency)
    ? fields.urgency
    : (kind === 'briefing' ? 'fyi' : 'normal');
  // Questions only: a result already outlives its session (#669) and a briefing has
  // nothing to answer.
  const durableDays = kind === 'question' ? clampDurableDays(fields.durableDays) : 0;

  return {
    id,
    kind,
    status: 'open',
    sessionId: fields.sessionId || null,
    sessionName: fields.sessionName || null,
    project: fields.project || '',
    projectName: fields.projectName || '',
    worktree: fields.worktree || null,
    // #705: the scheduled task whose run asked, derived server-side from the calling
    // session — never named by the agent. What workshop_answers groups a job's answers by.
    scheduledTaskId: fields.scheduledTaskId || null,
    // #710: when the asking run started, read off the task's run history at ask time. It is
    // the lower bound of "a later run replaced this question", and the run history only keeps
    // the last 20 runs, so it has to be captured while the asking run is still in it.
    scheduledRunStartedAt: fields.scheduledTaskId && Number.isFinite(fields.scheduledRunStartedAt)
      ? fields.scheduledRunStartedAt
      : null,
    urgency,
    headline: clampText(fields.headline, MAX_HEADLINE).trim(),
    context: clampText(fields.context, MAX_CONTEXT),
    options: resultOptionsFor(kind, fields),
    recommendation: clampText(fields.recommendation, MAX_LABEL).trim(),
    tag: clampText(fields.tag, MAX_TAG).trim(),
    // #669 — a result's evidence. Empty strings on every other kind, so the panel and
    // the store never have to branch on kind to read them.
    before: kind === 'result' ? clampText(fields.before, MAX_SECTION).trim() : '',
    after: kind === 'result' ? clampText(fields.after, MAX_SECTION).trim() : '',
    caveats: kind === 'result' ? clampText(fields.caveats, MAX_SECTION).trim() : '',
    // Filled in by tools.js after the item has an id: [{ file, ref }]. Never base64 —
    // workshop.json is read whole on every poll of /api/workshop/inbox, and an inlined
    // PNG in there is fatal to the panel's refresh interval.
    images: [],
    createdAt: now,
    // #705: past this instant an unanswered durable question is expired rather than open.
    // null for every non-durable item, which keeps the dead-session sweep's behaviour.
    durableUntil: durableDays ? now + durableDays * DAY_MS : null,
    answeredAt: null,
    answer: null,
    deliveredVia: null,
    // #705: the session an option's `then` started, when the asker had already gone.
    followUpSessionId: null,
    dismissedReason: null,
    // #710: { rule, at } — what replaced this question, once a sweep has recorded it.
    supersededBy: null,
    missingSince: null,
  };
}

/**
 * An open durable question whose time is up. Computed rather than only swept, because the
 * sweep runs on the panel's poll — Workshop is off by default, so a link can be opened on a
 * machine where nothing has swept for days, and it must still refuse the answer.
 */
function isExpired(item, now = Date.now()) {
  return !!(item && item.status === 'open' && item.durableUntil && now >= item.durableUntil);
}

/**
 * Has something replaced this question (#710)? null, or `{ rule, at }` where `at` is when.
 *
 * Computed on every read for isExpired's reason, and derived only from facts the daemon holds.
 * By the time a question stops mattering the agent that asked it may have been killed, crashed
 * or closed, so nothing here can wait for that agent to say so. The facts arrive as callbacks,
 * the way isAlive does, because this file never sees ctx:
 *
 *   humanInputAt(sessionId)  when a person last sent that session something (a line submitted
 *                            at its prompt, or a Workshop chat or idle-row prompt), or null
 *   task(taskId)             a scheduled task's { enabled, once, deleted, runs }, or null
 *
 * 'tab-reply': a person sent the asking session something after the question was asked.
 * Deliberately blunt: "wait, check X first" counts too, because whoever is in the tab talking to
 * the agent has made the inbox copy the stale one.
 *
 * 'later-run': a run of the same scheduled task that STARTED after the asking run has ENDED
 * `succeeded`. That run had its chance to read the answers and ask again. A failed, timed-out,
 * queued or running run supersedes nothing (a crashed run must not take yesterday's question
 * down with it), and neither does a one-time, disabled or deleted task, whose `then` may still
 * be wanted.
 *
 * Questions only: a result gates a merge, and a briefing has nothing to answer.
 */
function supersession(item, facts) {
  if (!item || item.kind !== 'question' || item.status !== 'open' || !facts) return null;
  const found = [];

  const replied = item.sessionId && typeof facts.humanInputAt === 'function'
    ? facts.humanInputAt(item.sessionId)
    : null;
  // Strictly after. Both clocks are the daemon's, and a line typed before the question existed
  // was not a reply to it.
  if (Number.isFinite(replied) && replied > item.createdAt) found.push({ rule: 'tab-reply', at: replied });

  const task = item.scheduledTaskId && typeof facts.task === 'function' ? facts.task(item.scheduledTaskId) : null;
  if (task && !task.deleted && task.enabled !== false && !task.once && Array.isArray(task.runs)) {
    const asking = item.sessionId ? task.runs.find((r) => r && r.sessionId === item.sessionId) : null;
    const since = item.scheduledRunStartedAt || (asking && asking.startedAt) || item.createdAt;
    let at = null;
    for (const run of task.runs) {
      if (!run || run.status !== 'succeeded' || !Number.isFinite(run.endedAt)) continue;
      if (item.sessionId && run.sessionId === item.sessionId) continue;
      if (!(run.startedAt > since)) continue;
      if (at === null || run.endedAt < at) at = run.endedAt;
    }
    if (at !== null) found.push({ rule: 'later-run', at });
  }

  if (!found.length) return null;
  return found.reduce((a, b) => (b.at < a.at ? b : a));
}

/** Why a question was superseded, as one sentence (#710). ISO time: agents and logs read it. */
function supersededNote(sup) {
  if (!sup) return '';
  const at = Number.isFinite(sup.at) ? new Date(sup.at).toISOString() : 'an unknown time';
  return sup.rule === 'later-run'
    ? `A later run of the same scheduled task finished successfully at ${at}.`
    : `A person replied in the asking session at ${at}, after this was asked.`;
}

/**
 * Record a human's answer on an item. Returns a status string rather than throwing,
 * so the REST layer can map it to a code and the caller can say something useful.
 *
 * 'not-open' is the two-browsers race: first writer wins, mirroring
 * /api/meta-controls-consent's { stale: true }. A question something replaced (#710) says
 * 'superseded' instead, whether or not a sweep has recorded it yet — `facts` is what lets
 * this see the unrecorded case, and without it only the recorded one is refused.
 */
function applyAnswer(item, { text, optionIndex } = {}, now = Date.now(), facts = null) {
  if (!item) return 'not-found';
  if (item.kind === 'briefing') return 'not-answerable';
  if (item.status !== 'open') return item.dismissedReason === 'superseded' ? 'superseded' : 'not-open';
  if (isExpired(item, now)) return 'expired';
  if (supersession(item, facts)) return 'superseded';

  const body = typeof text === 'string' ? text.trim() : '';
  const hasIndex = optionIndex !== undefined && optionIndex !== null && optionIndex !== '';
  let idx = null;

  if (hasIndex) {
    idx = Number(optionIndex);
    if (!Number.isInteger(idx)) return 'bad-option';
    if (!Array.isArray(item.options) || item.options.length === 0) return 'bad-option';
    if (idx < 0 || idx >= item.options.length) return 'bad-option';
  }

  if (idx === null && !body) return 'empty';

  item.status = 'answered';
  item.answeredAt = now;
  item.answer = {
    text: body,
    optionIndex: idx,
    optionLabel: idx === null ? '' : item.options[idx].label,
  };
  return 'ok';
}

function applyDismiss(item, reason, now = Date.now()) {
  if (!item) return 'not-found';
  if (item.status !== 'open') return 'not-open';
  item.status = 'dismissed';
  item.answeredAt = now;
  item.dismissedReason = reason || 'archived';
  return 'ok';
}

/**
 * Bound the file. Every OPEN item survives regardless of the cap — see MAX_OPEN for
 * the other half of the bound. Output is in createdAt order, the file's canonical
 * ordering.
 *
 * Closed RESULTS are counted in their own bucket (#669), and so are closed DURABLE
 * questions (#705). Sharing one cap would let a week of briefings evict the writeups —
 * or the answer a scheduled task's next run has not read yet — which is the one thing a
 * durable record must not do; separate buckets keep the file bounded without that.
 * Newest-first inside each.
 */
function retain(items, cap = RETENTION_CAP, resultCap = RESULT_RETENTION_CAP, durableCap = DURABLE_RETENTION_CAP) {
  if (!Array.isArray(items)) return [];
  const newestFirst = (a, b) =>
    (b.answeredAt || b.createdAt || 0) - (a.answeredAt || a.createdAt || 0);

  const open = items.filter((i) => i && i.status === 'open');
  const closed = items.filter((i) => i && i.status !== 'open');
  const closedResults = closed.filter((i) => i.kind === 'result');
  const closedDurable = closed.filter((i) => i.kind !== 'result' && i.durableUntil);
  const closedOther = closed.filter((i) => i.kind !== 'result' && !i.durableUntil);
  closedResults.sort(newestFirst);
  closedDurable.sort(newestFirst);
  closedOther.sort(newestFirst);

  return [
    ...open,
    ...closedResults.slice(0, Math.max(0, resultCap)),
    ...closedDurable.slice(0, Math.max(0, durableCap)),
    ...closedOther.slice(0, Math.max(0, cap)),
  ].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Dismiss open items whose asking session has been gone for longer than the grace.
 *
 * Two-phase on purpose: the first pass only STAMPS missingSince. A session that
 * comes back inside the window clears it. Without the grace, the daemon's own boot —
 * where ctx.shells is empty until sessions are restored — dismisses everything.
 *
 * Returns how many items changed, so the caller only saves and broadcasts on a
 * real change.
 *
 * RESULTS ARE EXEMPT (#669). Dismissing an item whose session is gone is right for a
 * question nobody can answer any more and exactly backwards for a result, whose entire
 * purpose is to outlive the tab that produced it — the writeup is what you read *after*
 * the agent has finished and the session has been closed. They are not even stamped
 * with `missingSince`, so a result can never age into the dismissal branch later.
 *
 * DURABLE QUESTIONS ARE EXEMPT TOO (#705), for the same reason: the agent asked for its
 * question to outlive the session. They leave by their own clock instead — dismissed as
 * 'expired' once `durableUntil` passes, whether or not the session is still around, since
 * the asker said how long the answer was worth waiting for.
 */
function sweepDeadSessions(items, isAlive, now = Date.now(), graceMs = EXPIRY_GRACE_MS) {
  if (!Array.isArray(items)) return 0;
  let changed = 0;
  for (const item of items) {
    if (!item || item.status !== 'open') continue;
    if (item.durableUntil) {
      if (now >= item.durableUntil) {
        applyDismiss(item, 'expired', now);
        changed++;
      }
      continue;
    }
    if (!item.sessionId) continue;
    if (item.kind === 'result') continue;
    if (isAlive(item.sessionId)) {
      if (item.missingSince) { item.missingSince = null; changed++; }
      continue;
    }
    if (!item.missingSince) { item.missingSince = now; changed++; continue; }
    if (now - item.missingSince >= graceMs) {
      applyDismiss(item, 'session-gone', now);
      item.deliveredVia = item.deliveredVia || 'undelivered';
      changed++;
    }
  }
  return changed;
}

/**
 * Record what supersession() computes (#710): dismiss every open question something has
 * replaced, with reason 'superseded' and the rule that fired. Returns the items it dismissed,
 * so the caller can release a hold on each and saves only on a real change.
 *
 * No reader waits for this; each one computes supersession() itself. But a recorded verdict
 * is final, and the facts behind it are not: a task keeps only its last 20 runs, and a closed
 * session's record is pruned by retention.
 */
function sweepSuperseded(items, facts, now = Date.now()) {
  if (!Array.isArray(items)) return [];
  const dismissed = [];
  for (const item of items) {
    const sup = supersession(item, facts);
    if (!sup) continue;
    applyDismiss(item, 'superseded', now);
    item.supersededBy = sup;
    dismissed.push(item);
  }
  return dismissed;
}

/**
 * Inbox order: most urgent first, then longest-waiting, then id.
 *
 * The id tiebreak is not cosmetic. Derived blocked rows are rebuilt on every request,
 * so incoming array order carries no information and sort stability buys nothing —
 * without a TOTAL order the list reshuffles under the cursor at every poll.
 *
 * Ranked on urgency rather than kind, because a workshop_ask question may legitimately
 * be 'blocking' and one rule beats two.
 */
function compareItems(a, b) {
  const ra = URGENCY_RANK[a && a.urgency] ?? 1;
  const rb = URGENCY_RANK[b && b.urgency] ?? 1;
  if (ra !== rb) return ra - rb;
  const ca = (a && a.createdAt) || 0;
  const cb = (b && b.createdAt) || 0;
  if (ca !== cb) return ca - cb;
  return String(a && a.id).localeCompare(String(b && b.id));
}

function sortForInbox(items) {
  return (Array.isArray(items) ? items.slice() : []).sort(compareItems);
}

// ── persistence ──────────────────────────────────────────────────────────────

// Resolved lazily, never at module scope: paths.js says so, and a test that repoints
// HOME before requiring this file must still land on a scratch path.
function inboxFile() {
  return statePath('workshop.json');
}

let items = [];
let loaded = false;

function load() {
  items = [];
  loaded = true;
  try {
    const file = inboxFile();
    if (!fs.existsSync(file)) return items;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A pre-#705 file also carries `nextSeq`; ids are no longer counted, so it is ignored.
    if (data && Array.isArray(data.items)) items = data.items.filter(Boolean);
  } catch {
    // A corrupt file is an empty inbox, never a throw: this module is required at
    // daemon boot, and a throw here drops the whole mod (mcp-server.js catches
    // per-mod and logs one line).
    items = [];
  }
  return items;
}

function ensureLoaded() {
  if (!loaded) load();
  return items;
}

function save() {
  try {
    const file = inboxFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // tmp + rename, not a bare writeFileSync: a torn workshop.json loses open
    // obligations, which is the one thing this store exists to not do.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, items }, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

function all() {
  return ensureLoaded();
}

function byId(id) {
  return ensureLoaded().find((i) => i.id === id) || null;
}

function openCount() {
  return ensureLoaded().filter((i) => i.status === 'open').length;
}

/** Mint and store one item. The impure wrapper around makeItem, and the only minter of ids. */
function add(fields, now = Date.now()) {
  ensureLoaded();
  const item = makeItem(fields, { id: randomUUID(), now });
  items.push(item);
  items = retain(items);
  return item;
}

// ── the pending-wait registry (workshop_ask's opt-in `wait_seconds`) ─────────
//
// Shaped after requestMetaControlsConsent (server.js:6140), which is the proven
// block-until-a-human-answers pattern in this repo:
//
//   1. resolve synchronously for every already-decided case BEFORE creating state;
//   2. one in-flight slot — here keyed per item id, so a retry of the same ask joins
//      the existing promise rather than stacking a second timer;
//   3. finish() is idempotent via the `if (!w) return false` guard, which is what
//      makes the answer-endpoint-vs-timeout race safe in EITHER order;
//   4. resolve with a value, NEVER reject — a rejection surfaces to the model as an
//      MCP error and it retries, the exact opposite of "end your turn";
//   5. (the caller broadcasts on resolve).
//
// Plus a sixth: clear the timer and drop the entry BEFORE resolving, so a synchronous
// continuation sees a clean slot.
//
// These holds are in-memory and die with the process. That is fine and designed: the
// agents holding them lose their MCP connections at the same moment, and the item is
// still on disk as `open`, so the answer simply takes the prompt path instead.

const waits = new Map();

function finishWait(id, value) {
  const w = waits.get(id);
  if (!w) return false;
  clearTimeout(w.timer);
  waits.delete(id);
  w.resolve(value);
  return true;
}

/** Resolves with the answer if one lands inside `ms`, otherwise null. Never rejects. */
function holdForAnswer(item, ms) {
  if (!item) return Promise.resolve(null);
  if (item.status !== 'open') return Promise.resolve(item.answer || null);
  const existing = waits.get(item.id);
  if (existing) return existing.promise;

  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const timer = setTimeout(() => finishWait(item.id, null), Math.max(1, ms));
  waits.set(item.id, { promise, resolve: resolveFn, timer });
  return promise;
}

/** True only when a hold was actually released — false means it had already timed out. */
function releaseWait(id, answer) {
  return finishWait(id, answer || null);
}

function pendingWaitCount() {
  return waits.size;
}

/** Is an agent holding inside workshop_ask for this item right now? */
function hasWait(id) {
  return waits.has(id);
}

module.exports = {
  // pure
  clampText,
  blockedId,
  parseBlockedId,
  idleId,
  parseIdleId,
  sessionRowId,
  parseSessionRowId,
  isItemId,
  normalizeId,
  normalizeOptions,
  clampDurableDays,
  resultOptionsFor,
  makeItem,
  isExpired,
  supersession,
  supersededNote,
  applyAnswer,
  applyDismiss,
  retain,
  sweepDeadSessions,
  sweepSuperseded,
  compareItems,
  sortForInbox,
  // store
  load,
  save,
  all,
  byId,
  add,
  openCount,
  inboxFile,
  // waits
  holdForAnswer,
  releaseWait,
  pendingWaitCount,
  hasWait,
  // constants
  RETENTION_CAP,
  RESULT_RETENTION_CAP,
  DURABLE_RETENTION_CAP,
  MAX_OPEN,
  EXPIRY_GRACE_MS,
  MAX_OPTIONS,
  MAX_HEADLINE,
  MAX_CONTEXT,
  MAX_SECTION,
  MAX_THEN,
  MAX_DURABLE_DAYS,
  DAY_MS,
  KINDS,
  URGENCY_RANK,
  APPROVE_INDEX,
  RESULT_OPTIONS,
};
