/**
 * The chat thread for an agent that has no transcript to read (#670).
 *
 * Claude writes a .jsonl the daemon can tail, so its side of a conversation costs nothing
 * to obtain. Codex and the experimental agents write nothing we can read, so they report
 * back through the `workshop_say` tool and their half of the thread lands here.
 *
 * ── Why this is a separate file from workshop.json ──
 *
 * inbox.js's store is read WHOLE on every poll of /api/workshop/inbox — every 2s, in every
 * open browser. A conversation is an order of magnitude more text than an inbox of
 * headlines, and putting it there would make every inbox poll pay for every chat message
 * ever sent. Separate file, read only by the route that needs it.
 *
 * ── Why the human's messages are in here too ──
 *
 * On this path the store is not a supplement to the conversation, it IS the conversation:
 * nothing else records that the human asked anything. Storing only the agent's replies
 * would render as a monologue of answers to invisible questions. On the Claude path this
 * module is never touched at all — the transcript already holds both sides, and a second
 * copy would have to be merged and de-duplicated against it.
 *
 * Shaped after inbox.js: pure helpers over a plain object, a thin impure store around
 * them, and it NEVER sees the initMCP ctx — which is what lets the caps be driven straight
 * from node:test with no daemon.
 */

const fs = require('fs');
const path = require('path');
const { statePath } = require('../../paths');

const FILE_VERSION = 1;

// A single message. Generous: an agent explaining a design decision is not a chat quip.
const MAX_TEXT = 16000;

// Per thread. The pane reads the tail of a review conversation, not an archive.
const MAX_PER_THREAD = 200;

// Across all sessions. Evicted by the age of each thread's NEWEST message, so a thread
// that is still being added to never falls out from under a live conversation, and a
// closed session's history survives until 200 newer conversations have happened.
const MAX_THREADS = 200;

// ── pure helpers ─────────────────────────────────────────────────────────────

function clampText(value, max = MAX_TEXT) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** The timestamp a thread is ranked by: its newest message. */
function threadTip(messages) {
  let tip = 0;
  for (const m of messages || []) if ((m && m.at) > tip) tip = m.at;
  return tip;
}

/**
 * Append one message to a thread inside `threads`, applying every cap. Pure: the caller
 * supplies `now` and `seq`, so a test asserts exact ids without reaching into module state.
 */
function appendTo(threads, sessionId, { role, text }, { seq, now = Date.now() } = {}) {
  const body = clampText(text).trim();
  if (!sessionId || !body) return null;

  const list = threads[sessionId] || (threads[sessionId] = []);
  const message = {
    id: 'c' + seq,
    role: role === 'human' ? 'human' : 'agent',
    text: body,
    at: now,
  };
  list.push(message);
  if (list.length > MAX_PER_THREAD) list.splice(0, list.length - MAX_PER_THREAD);

  const keys = Object.keys(threads);
  if (keys.length > MAX_THREADS) {
    // Oldest tip first, and never the thread we just wrote to.
    keys.sort((a, b) => threadTip(threads[a]) - threadTip(threads[b]));
    for (const k of keys.slice(0, keys.length - MAX_THREADS)) {
      if (k !== sessionId) delete threads[k];
    }
  }
  return message;
}

// ── the store ────────────────────────────────────────────────────────────────

// Resolved lazily, never at module scope: paths.js says so, and a test that repoints HOME
// before requiring this file must still land on a scratch path.
function chatFile() {
  return statePath('workshop-chat.json');
}

let threads = {};
let nextSeq = 1;
let loaded = false;

function load() {
  threads = {};
  nextSeq = 1;
  loaded = true;
  try {
    const file = chatFile();
    if (!fs.existsSync(file)) return threads;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.threads && typeof data.threads === 'object') {
      for (const [k, v] of Object.entries(data.threads)) {
        if (Array.isArray(v)) threads[k] = v.filter(Boolean);
      }
    }
    const seqs = Object.values(threads).flat().map((m) => Number(String(m.id || '').slice(1)) || 0);
    nextSeq = Math.max(1, Number(data && data.nextSeq) || 0, ...seqs.map((s) => s + 1));
  } catch {
    // A corrupt file is an empty thread set, never a throw: this module is required at
    // daemon boot and a throw drops the whole mod.
    threads = {};
    nextSeq = 1;
  }
  return threads;
}

function ensureLoaded() {
  if (!loaded) load();
  return threads;
}

function save() {
  try {
    const file = chatFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // tmp + rename, like inbox.js: a torn file would lose a conversation, and the whole
    // point of this store is that the non-Claude path has nowhere else to keep one.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, nextSeq, threads }, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

/** Every message for one session, oldest first. Never null. */
function thread(sessionId) {
  return (sessionId && ensureLoaded()[sessionId]) || [];
}

/** Append and persist. Returns the stored message, or null if there was nothing to store. */
function append(sessionId, fields, now = Date.now()) {
  const message = appendTo(ensureLoaded(), sessionId, fields, { seq: nextSeq, now });
  if (!message) return null;
  nextSeq++;
  save();
  return message;
}

// Test seam, matching inbox.js: reset in-memory state so a suite can repoint HOME.
function _reset() {
  threads = {};
  nextSeq = 1;
  loaded = false;
}

module.exports = {
  append, thread, load, save, _reset,
  appendTo, clampText, threadTip,
  MAX_TEXT, MAX_PER_THREAD, MAX_THREADS,
};
