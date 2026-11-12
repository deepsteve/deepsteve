/**
 * Which conversation a running Claude Code process is on, from Claude Code's own record of it.
 *
 * Claude Code keeps one small JSON file per running interactive process, at
 * `<config dir>/sessions/<pid>.json`: `{ pid, sessionId, cwd, startedAt, tmux, status, updatedAt, … }`.
 * Its `sessionId` is the conversation the process is writing NOW, and it follows a `/resume` typed
 * inside the running process. Nothing in the transcripts does: Claude Code goes on appending to
 * the resumed conversation's own file, which never names the id the tab was started with, so the
 * fs.watch fork detector in server.js — which looks for a NEW file that references our id — cannot
 * see it, and the tab would keep pointing at an id that never got a transcript. Measured on Claude
 * Code 2.1.322: a tab spawned with `--session-id 5ec8535e…` and then /resume'd onto `f663d201…`
 * had `"sessionId": "f663d201…"` and `"tmux": "ds-9853118f:@45.%45"` in its file.
 *
 * It is Claude Code's internal state, not a documented interface, so everything here is
 * defensive: a file we cannot read or parse, or one that does not positively name our tab, is
 * ignored, and the tab keeps the id it has.
 *
 * WHICH FILE IS OURS. Under the tmux engine Claude Code records its pane as
 * `"<session>:<window>.<pane>"`, and our session is named `ds-<shellId>` (engines/tmux.js), so the
 * name is the match and no tmux call is needed to learn a pid — which matters, because the WS
 * create path that starts this watcher must not run a subprocess (#553). A node-pty tab has no
 * `tmux` field, so it matches on `pid`. A file whose process is gone is a leftover from a crash and
 * is never believed — a restored tab reuses its tmux session name — and among live ones the most
 * recently updated wins.
 *
 * Only the id comes out of here. server.js hands it to adoptClaudeSession(), the single writer of
 * a shell's Claude session id, which owns the guards (an id another tab owns is refused) and the
 * side effects (state.json, the trace line).
 */

const fs = require('fs');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_RE = /^\d+\.json$/;
// A burst of rewrites (a turn starting flips `status` and `updatedAt`) is read once.
const SETTLE_MS = 100;

/** True when a process with this pid exists. EPERM means it does, and is someone else's. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/**
 * The conversation `rec` says tab `shellId` is on, or null when the record is not positively
 * that tab's live process. `pid` is the tab's process id where it is cheap to know (node-pty),
 * else null; a tmux tab is matched by its session name alone.
 */
function conversationOf(rec, { shellId, pid = null, isAlive = processAlive } = {}) {
  if (!rec || typeof rec !== 'object' || !shellId) return null;
  const id = typeof rec.sessionId === 'string' && UUID_RE.test(rec.sessionId) ? rec.sessionId : null;
  if (!id) return null;
  if (typeof rec.tmux === 'string' && rec.tmux) {
    if (rec.tmux.split(':')[0] !== `ds-${shellId}`) return null;
  } else if (pid == null || rec.pid !== pid) {
    return null;
  }
  return isAlive(rec.pid) ? id : null;
}

const recency = (rec) => Number(rec.updatedAt) || Number(rec.startedAt) || 0;

/** Of several records, the conversation of the most recently updated one that is ours. */
function newestConversation(records, opts) {
  let best = null;
  for (const rec of records || []) {
    const id = conversationOf(rec, opts);
    if (id && (!best || recency(rec) > recency(best.rec))) best = { id, rec };
  }
  return best ? best.id : null;
}

/**
 * Watch `dir` (Claude Code's `sessions` directory) for tab `shellId`'s process record, and call
 * `onConversation(id)` whenever it names a conversation other than the one last reported —
 * once at start, from what is already there, then on every change. The directory is created if
 * it is missing, as the transcript watcher does for its own: on a machine where this is Claude
 * Code's first run, the process that will write into it starts after we do. One that cannot be
 * watched is logged once and left alone.
 *
 * @returns {{ close(): void, scan(): Promise<void> }}
 */
function watchClaudeProcess({ dir, shellId, getPid = () => null, onConversation, log = () => {}, isAlive = processAlive }) {
  let last = null;
  let closed = false;
  const pending = new Map();   // filename → settle timer

  const report = (id) => {
    if (!id || id === last || closed) return;
    last = id;
    onConversation(id);
  };
  const opts = () => ({ shellId, pid: getPid(), isAlive });

  async function readRecord(name) {
    try { return JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')); } catch { return null; }
  }

  async function scan() {
    let names;
    try { names = (await fs.promises.readdir(dir)).filter(n => RECORD_RE.test(n)); } catch { return; }
    const records = (await Promise.all(names.map(readRecord))).filter(Boolean);
    report(newestConversation(records, opts()));
  }

  let watcher = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (event, name) => {
      if (closed || !name || !RECORD_RE.test(name)) return;
      clearTimeout(pending.get(name));
      pending.set(name, setTimeout(async () => {
        pending.delete(name);
        report(conversationOf(await readRecord(name), opts()));
      }, SETTLE_MS));
    });
    watcher.on('error', () => {});
  } catch (e) {
    log(`Session ${shellId} not watching Claude process records in ${dir}: ${e.code || e.message}`);
  }
  scan();

  return {
    scan,
    close() {
      closed = true;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    },
  };
}

module.exports = { conversationOf, newestConversation, watchClaudeProcess, processAlive };
