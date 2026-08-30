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
 */

const fs = require('fs');
const path = require('path');
const { statePath } = require('../../paths');

const FILE_VERSION = 1;

// Keep this many non-open items. Open items are exempt (see retain) — an open item
// is a live obligation, and silently dropping one discards an agent's question.
const RETENTION_CAP = 200;

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
const MAX_OPTIONS = 9;        // the inbox binds keys 1-9
const MAX_LABEL = 400;
const MAX_DETAIL = 1000;

const URGENCIES = ['fyi', 'normal', 'blocking'];
const URGENCY_RANK = { blocking: 0, normal: 1, fyi: 2 };

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

/**
 * A ticket as an agent might repeat it back: 12, '12', '#12', 'w12' all mean w12.
 * The model-facing text says "#12", so all three spellings will be tried.
 */
function normalizeTicket(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^[#w]+/i, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
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
    return out;
  }).filter((o) => o.label);
}

/**
 * Build one item. Pure: `seq` and `now` are supplied by the caller, so a test can
 * assert exact ids without reaching into module state. add() is the impure wrapper.
 */
function makeItem(fields = {}, { seq, now = Date.now() } = {}) {
  const kind = fields.kind === 'briefing' ? 'briefing' : 'question';
  const urgency = URGENCIES.includes(fields.urgency)
    ? fields.urgency
    : (kind === 'briefing' ? 'fyi' : 'normal');

  return {
    id: 'w' + seq,
    seq,
    kind,
    status: 'open',
    sessionId: fields.sessionId || null,
    sessionName: fields.sessionName || null,
    project: fields.project || '',
    projectName: fields.projectName || '',
    worktree: fields.worktree || null,
    urgency,
    headline: clampText(fields.headline, MAX_HEADLINE).trim(),
    context: clampText(fields.context, MAX_CONTEXT),
    options: kind === 'briefing' ? [] : normalizeOptions(fields.options),
    recommendation: clampText(fields.recommendation, MAX_LABEL).trim(),
    tag: clampText(fields.tag, 120).trim(),
    createdAt: now,
    answeredAt: null,
    answer: null,
    deliveredVia: null,
    dismissedReason: null,
    missingSince: null,
  };
}

/**
 * Record a human's answer on an item. Returns a status string rather than throwing,
 * so the REST layer can map it to a code and the caller can say something useful.
 *
 * 'not-open' is the two-browsers race: first writer wins, mirroring
 * /api/meta-controls-consent's { stale: true }.
 */
function applyAnswer(item, { text, optionIndex } = {}, now = Date.now()) {
  if (!item) return 'not-found';
  if (item.kind === 'briefing') return 'not-answerable';
  if (item.status !== 'open') return 'not-open';

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
 */
function retain(items, cap = RETENTION_CAP) {
  if (!Array.isArray(items)) return [];
  const open = items.filter((i) => i && i.status === 'open');
  const closed = items.filter((i) => i && i.status !== 'open');
  closed.sort((a, b) => (b.answeredAt || b.createdAt || 0) - (a.answeredAt || a.createdAt || 0));
  const kept = closed.slice(0, Math.max(0, cap));
  return [...open, ...kept].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
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
 */
function sweepDeadSessions(items, isAlive, now = Date.now(), graceMs = EXPIRY_GRACE_MS) {
  if (!Array.isArray(items)) return 0;
  let changed = 0;
  for (const item of items) {
    if (!item || item.status !== 'open' || !item.sessionId) continue;
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
let nextSeq = 1;
let loaded = false;

function load() {
  items = [];
  nextSeq = 1;
  loaded = true;
  try {
    const file = inboxFile();
    if (!fs.existsSync(file)) return items;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && Array.isArray(data.items)) items = data.items.filter(Boolean);
    const seqs = items.map((i) => Number(i.seq) || 0);
    const fromFile = Number(data && data.nextSeq) || 0;
    // max() of both: a hand-edited file that lost nextSeq must still never reissue
    // an id that is already on an item.
    nextSeq = Math.max(1, fromFile, ...seqs.map((s) => s + 1));
  } catch {
    // A corrupt file is an empty inbox, never a throw: this module is required at
    // daemon boot, and a throw here drops the whole mod (mcp-server.js catches
    // per-mod and logs one line).
    items = [];
    nextSeq = 1;
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
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, nextSeq, items }, null, 2));
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

/** Mint and store one item. The impure wrapper around makeItem. */
function add(fields, now = Date.now()) {
  ensureLoaded();
  const item = makeItem(fields, { seq: nextSeq++, now });
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
  normalizeTicket,
  normalizeOptions,
  makeItem,
  applyAnswer,
  applyDismiss,
  retain,
  sweepDeadSessions,
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
  MAX_OPEN,
  EXPIRY_GRACE_MS,
  MAX_OPTIONS,
  MAX_HEADLINE,
  MAX_CONTEXT,
  URGENCY_RANK,
};
