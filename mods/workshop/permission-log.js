/**
 * The permissions log — what the agents on this machine have asked to be allowed to do.
 *
 * Workshop already reads every permission dialog on every poll: derivedItems scrapes
 * each waiting session and dialog-parse.js hands back `kind: 'permission'` and a
 * headline that is the tool line itself ("Bash(rm -rf …)", "deepsteve - read_session_screen
 * (MCP)"). Until now that reading was thrown away the moment the dialog resolved, because
 * a blocked row is DERIVED and has no store. This is the store — the same observation,
 * kept.
 *
 * It is a log, not an inbox: nothing here is answerable, nothing expires into an
 * obligation, and no MCP tool can write to it. An agent cannot add an entry, cannot edit
 * one and cannot clear the file; the only writer is the poll loop recording what it saw.
 *
 * ── Why it can be honest about "asked" and only sometimes about "answered" ──
 *
 * Observing that a dialog appeared is exact — we read it off the screen. Observing what
 * was CHOSEN is not: a human answering in the terminal just makes the dialog vanish, and
 * no repaint says which key they hit. So an entry carries a decided `answer` only when
 * the answer came through the Workshop panel, which is the one path that knows. Every
 * other resolution is recorded as `resolved` with no answer, and the panel says
 * "answered in the tab" rather than inventing a choice. A log that guessed here would be
 * worse than no log — the whole point is being able to trust the list.
 */

const fs = require('fs');
const path = require('path');
const { statePath } = require('../../paths');

const FILE_VERSION = 1;

// How many entries the file keeps. A busy day on this machine is a few dozen dialogs;
// 1000 is roughly a month of them and about 300KB, which is small enough to read whole
// on the rare occasions the panel asks for it.
const CAP = 1000;

const MAX_SUBJECT = 500;
const MAX_QUESTION = 500;
const MAX_OPTION = 200;
const MAX_OPTIONS = 12;

// Writes are debounced: a poll that observes three new dialogs at once must not write
// the file three times, and a dialog resolving is not worth an immediate fsync.
const SAVE_DEBOUNCE_MS = 3000;

// ── pure helpers ─────────────────────────────────────────────────────────────

function clamp(value, max) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The tool being asked about, extracted from the dialog's own subject line.
 *
 * Claude Code writes it two ways and both are worth splitting, because the whole reason
 * to keep this list is to be able to see the SHAPE of what is being asked:
 *
 *   "Bash(git push origin main)"            -> { tool: 'Bash',      target: 'git push origin main' }
 *   "deepsteve - read_session_screen (MCP)" -> { tool: 'deepsteve', target: 'read_session_screen' }
 *
 * Anything else keeps the whole line as the tool and no target, which is truthful and
 * still groups: an unrecognised subject is its own bucket rather than being silently
 * merged into a neighbour's.
 */
function parseSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return { tool: '', target: '' };

  // Bash(...) / Read(...) / Edit(...) — a tool name followed by a parenthesised argument
  // that runs to the END of the line, so an inner ")" does not truncate the command.
  const call = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/.exec(s);
  if (call) return { tool: call[1], target: call[2].trim() };

  // "<server> - <tool> (MCP)"
  const mcp = /^(.+?)\s+-\s+(.+?)\s*\(MCP\)$/i.exec(s);
  if (mcp) return { tool: mcp[1].trim(), target: mcp[2].trim() };

  return { tool: s, target: '' };
}

/**
 * Build one entry. Pure — `now` and `seq` come from the caller, so a test can assert
 * exact ids without reaching into module state.
 */
function makeEntry(fields = {}, { seq, now = Date.now() } = {}) {
  const subject = clamp(fields.subject, MAX_SUBJECT).trim();
  const { tool, target } = parseSubject(subject);
  return {
    id: 'p' + seq,
    seq,
    at: now,
    sessionId: fields.sessionId || null,
    sessionName: fields.sessionName || null,
    project: fields.project || '',
    projectName: fields.projectName || '',
    // The dialog fingerprint. This is the identity the recorder de-dupes on, and it is
    // what lets a resolution be matched back to the entry it resolved.
    fingerprint: fields.fingerprint || '',
    subject,
    tool,
    target,
    question: clamp(fields.question, MAX_QUESTION).trim(),
    options: (Array.isArray(fields.options) ? fields.options : [])
      .slice(0, MAX_OPTIONS)
      .map((o) => clamp(o && o.label != null ? o.label : o, MAX_OPTION).trim())
      .filter(Boolean),
    // 'open' while the dialog is on screen; 'resolved' once it is gone.
    status: 'open',
    resolvedAt: null,
    // Set ONLY when the answer came through the Workshop panel — see the header.
    answer: null,
    answeredVia: null,
  };
}

/** Newest first, which is the only order this list is ever read in. */
function sortForLog(entries) {
  return (Array.isArray(entries) ? entries.slice() : [])
    .sort((a, b) => (b.at || 0) - (a.at || 0) || String(b.id).localeCompare(String(a.id)));
}

/** Bound the file. Oldest go first; nothing here is an obligation, so nothing is exempt. */
function retain(entries, cap = CAP) {
  if (!Array.isArray(entries)) return [];
  if (entries.length <= cap) return entries;
  return sortForLog(entries).slice(0, cap).sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * Roll the log up into "what gets asked around here", which is the question the list is
 * really for. Counted by tool, newest use first within a tie on count.
 */
function summarize(entries) {
  const buckets = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.tool) continue;
    const hit = buckets.get(e.tool) || { tool: e.tool, count: 0, lastAt: 0 };
    hit.count++;
    if ((e.at || 0) > hit.lastAt) hit.lastAt = e.at || 0;
    buckets.set(e.tool, hit);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

// ── store ────────────────────────────────────────────────────────────────────

// Resolved lazily, never at module scope — paths.js says so, and a test that repoints
// HOME before requiring this file must still land on a scratch path.
function logFile() {
  return statePath('workshop-permissions.json');
}

let entries = [];
let nextSeq = 1;
let loaded = false;
let saveTimer = null;

function load() {
  entries = [];
  nextSeq = 1;
  loaded = true;
  try {
    const file = logFile();
    if (!fs.existsSync(file)) return entries;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && Array.isArray(data.entries)) entries = data.entries.filter(Boolean);
    const seqs = entries.map((e) => Number(e.seq) || 0);
    nextSeq = Math.max(1, Number(data && data.nextSeq) || 0, ...seqs.map((s) => s + 1));
  } catch {
    // A corrupt file is an empty log, never a throw: this module is required at daemon
    // boot and a throw here drops the whole mod.
    entries = [];
    nextSeq = 1;
  }
  return entries;
}

function ensureLoaded() {
  if (!loaded) load();
  return entries;
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, nextSeq, entries }, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

/** Debounced. The log is a record, not an obligation — losing the last 3s of it on a
 *  crash costs a line, and writing it on every poll costs a write every two seconds. */
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function all() {
  return ensureLoaded();
}

/** The open entry for a session, if the dialog it recorded is still the one on screen. */
function openFor(sessionId, fingerprint) {
  return ensureLoaded().find(
    (e) => e.sessionId === sessionId && e.status === 'open'
      && (!fingerprint || e.fingerprint === fingerprint),
  ) || null;
}

/**
 * How long the same dialog, in the same session, counts as the same ASK.
 *
 * The de-dupe cannot key on `status === 'open'` alone, and this is the reason: the
 * poll's own view of "is a dialog up" flickers. `waitingForInput` drops false for a
 * frame during a repaint, that frame's scrape reports no dialog, the sweep resolves the
 * entry — and the next poll, with the identical dialog still on screen, would open a
 * second one. Real repeats of the same permission are minutes apart (the agent runs the
 * command, does other work, asks again); repaint flicker is milliseconds. Two minutes
 * separates them with room to spare.
 */
const REASK_WINDOW_MS = 120_000;

/** The most recent entry for this exact dialog, open or not. */
function recentSame(sessionId, fingerprint, now) {
  if (!sessionId || !fingerprint) return null;
  let best = null;
  for (const e of ensureLoaded()) {
    if (e.sessionId !== sessionId || e.fingerprint !== fingerprint) continue;
    const seen = Math.max(e.at || 0, e.resolvedAt || 0);
    if (now - seen > REASK_WINDOW_MS) continue;
    if (!best || seen > Math.max(best.at || 0, best.resolvedAt || 0)) best = e;
  }
  return best;
}

/**
 * Record that a permission dialog is on screen. De-duped on (session, fingerprint), so
 * calling this every poll for the two seconds a dialog is up produces ONE entry.
 *
 * Returns the entry when it created one and null when it recognised one it already has,
 * which is what lets the caller log a line per new dialog rather than per poll.
 */
function observe(fields, now = Date.now()) {
  ensureLoaded();
  const sessionId = fields && fields.sessionId;
  const fp = fields && fields.fingerprint;

  const seen = recentSame(sessionId, fp, now);
  if (seen) {
    // The same dialog we already have. If the sweep closed it on a flickering frame,
    // re-open it rather than minting a duplicate — the dialog never went away.
    if (seen.status !== 'open') { seen.status = 'open'; seen.resolvedAt = null; save(); }
    return null;
  }

  // Anything else this session had open is a dialog that has been replaced without us
  // seeing it go. Close it before opening the new one, or a session that answers three
  // dialogs quickly leaves two entries open forever.
  resolveSession(sessionId, now);

  const entry = makeEntry(fields, { seq: nextSeq++, now });
  entries.push(entry);
  entries = retain(entries);
  save();
  return entry;
}

/** The dialog is gone. `answer` is supplied only by the panel's own answer path. */
function resolve(sessionId, fingerprint, { answer = null, via = null } = {}, now = Date.now()) {
  const entry = openFor(sessionId, fingerprint);
  if (!entry) return null;
  entry.status = 'resolved';
  entry.resolvedAt = now;
  if (answer) { entry.answer = clamp(answer, MAX_OPTION); entry.answeredVia = via || 'panel'; }
  save();
  return entry;
}

/** Close every open entry for a session — it answered something, or it went away. */
function resolveSession(sessionId, now = Date.now()) {
  if (!sessionId) return 0;
  let n = 0;
  for (const e of ensureLoaded()) {
    if (e.sessionId !== sessionId || e.status !== 'open') continue;
    e.status = 'resolved';
    e.resolvedAt = now;
    n++;
  }
  if (n) save();
  return n;
}

module.exports = {
  // pure
  clamp,
  parseSubject,
  makeEntry,
  sortForLog,
  retain,
  summarize,
  // store
  load,
  save,
  saveNow,
  all,
  observe,
  resolve,
  resolveSession,
  openFor,
  recentSame,
  logFile,
  // constants
  CAP,
  FILE_VERSION,
  REASK_WINDOW_MS,
};
