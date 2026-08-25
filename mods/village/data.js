// What the town knows about your projects.
//
// The top half is PURE — no three.js, no DOM — so test/unit/village-layout.test.js
// can drive it directly. The bottom half wires it to the host.
//
// Two things about the data are worth knowing before changing anything here:
//
//   A session has no project field. Membership is derived by folder prefix, the
//   same rule the projects rail uses (public/js/context-views.js:186) and the
//   server mirrors (server.js:2996 pathInside). Deriving it rather than storing it
//   is what makes a worktree under <repo>/.claude/worktrees/… land in its project
//   for free.
//
//   There are two different session lists and they are not interchangeable.
//   deepsteve.getSessions() is the tabs open in THIS browser window; GET /api/shells
//   is every session on the server. A house's lights should reflect the real
//   population, so they come from /api/shells — but focusSession() can only reach a
//   tab this window actually has, so the door card offers those and reports the rest
//   as a count rather than as a row that would do nothing when clicked.

// ── pure ────────────────────────────────────────────────────────────────────

/** The prefix rule. A trailing slash on a project dir must not change the answer. */
export function inside(cwd, dir) {
  if (!cwd || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return cwd === base || cwd.startsWith(`${base}/`);
}

/**
 * The sessions belonging to one project.
 *
 * Deduped by id, which is not paranoia: `dirs` is a list of independent prefixes
 * with no uniqueness constraint, so a project registered with both `/repo` and
 * `/repo/packages/app` matches a session in the latter twice. The same trap is
 * recorded for scheduled tasks in docs/scheduled-tasks.md:33.
 *
 * A session with no cwd (a mod tab, a display tab) belongs to no project — it is
 * global, exactly as context-views.js:188 treats it.
 */
export function sessionsForProject(ctx, sessions) {
  const dirs = (ctx && Array.isArray(ctx.dirs)) ? ctx.dirs : [];
  if (!dirs.length) return [];
  const seen = new Set();
  const out = [];
  for (const s of sessions || []) {
    if (!s || !s.cwd || seen.has(s.id)) continue;
    if (dirs.some((d) => inside(s.cwd, d))) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/**
 * Unread agent-chat, attributed to a project.
 *
 * Agent Chat's channels are global and a message carries only {id, sender, text,
 * timestamp} — nothing ties one to a repo. So a message is attributed by matching
 * its sender against the names of that project's sessions, which is the only
 * honest link available. A sender that matches nothing raises no flag, rather than
 * raising every flag.
 */
export function unreadByProject(channels, readMarks, sessionsByCtx) {
  const counts = new Map();
  if (!channels) return counts;

  // sender (lowercased) → the projects that have a session by that name
  const owner = new Map();
  for (const [ctxId, sessions] of sessionsByCtx) {
    for (const s of sessions) {
      const key = String(s.name || '').trim().toLowerCase();
      if (!key) continue;
      if (!owner.has(key)) owner.set(key, new Set());
      owner.get(key).add(ctxId);
    }
  }

  for (const [channel, data] of Object.entries(channels)) {
    const lastRead = (readMarks && readMarks[channel]) || 0;
    for (const msg of (data && data.messages) || []) {
      if (!msg || msg.id <= lastRead) continue;
      const ctxIds = owner.get(String(msg.sender || '').trim().toLowerCase());
      if (!ctxIds) continue;
      for (const id of ctxIds) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/** The highest message id in every channel — what "mark it all read" writes. */
export function highWaterMarks(channels) {
  const marks = {};
  for (const [channel, data] of Object.entries(channels || {})) {
    const msgs = (data && data.messages) || [];
    if (msgs.length) marks[channel] = msgs[msgs.length - 1].id;
  }
  return marks;
}

/**
 * Fold everything the town needs to draw into one object.
 *
 * @param {Object} input
 *   contexts       /api/contexts rows
 *   shells         /api/shells rows (server-wide)
 *   windowSessions deepsteve.getSessions() (this window's tabs; live waiting flags)
 *   channels       deepsteve.onAgentChatChanged payload
 *   readMarks      our own per-channel high-water marks
 * @returns {{byCtx: Map, waiting: Array}}
 */
export function buildTownModel(input) {
  const contexts = input.contexts || [];
  const shells = input.shells || [];
  const windowSessions = input.windowSessions || [];

  // The bridge's view is authoritative for waitingForInput on the tabs it has,
  // because {type:'state'} reaches only that session's own sockets (server.js:2660)
  // — the REST snapshot can be up to a poll interval stale.
  const liveWaiting = new Map();
  const localIds = new Set();
  for (const s of windowSessions) {
    if (s.type && s.type !== 'terminal') continue;
    localIds.add(s.id);
    liveWaiting.set(s.id, !!s.waitingForInput);
  }

  const active = shells
    .filter((s) => s.status === 'active')
    .map((s) => ({
      id: s.id,
      name: s.name || basename(s.cwd) || s.id.slice(0, 8),
      cwd: s.cwd,
      agentType: s.agentType || 'claude',
      waitingForInput: liveWaiting.has(s.id) ? liveWaiting.get(s.id) : !!s.waitingForInput,
      local: localIds.has(s.id),
    }));

  // A session this window has open that the server list has not caught up with yet
  // (a tab created seconds ago) still belongs in the town.
  for (const s of windowSessions) {
    if (s.type && s.type !== 'terminal') continue;
    if (active.some((a) => a.id === s.id)) continue;
    active.push({
      id: s.id,
      name: s.name || basename(s.cwd) || s.id.slice(0, 8),
      cwd: s.cwd,
      agentType: 'claude',
      waitingForInput: !!s.waitingForInput,
      local: true,
    });
  }

  const byCtx = new Map();
  for (const ctx of contexts) {
    const sessions = sessionsForProject(ctx, active);
    byCtx.set(ctx.id, {
      ctx,
      sessions,
      local: sessions.filter((s) => s.local),
      elsewhere: sessions.filter((s) => !s.local).length,
      waiting: sessions.filter((s) => s.waitingForInput),
      unread: 0,
    });
  }

  const unread = unreadByProject(
    input.channels,
    input.readMarks,
    new Map([...byCtx].map(([id, e]) => [id, e.sessions])),
  );
  for (const [id, n] of unread) {
    const entry = byCtx.get(id);
    if (entry) entry.unread = n;
  }

  // Every waiting session in the town, for the notice board. Sorted by id so the
  // notices do not reshuffle themselves on every poll.
  const waiting = active
    .filter((s) => s.waitingForInput)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return { byCtx, waiting, active };
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

// ── live wiring ─────────────────────────────────────────────────────────────

const READ_KEY = 'deepsteve-village-chat-read';
const SHELLS_POLL_MS = 3000;

/**
 * Subscribes to the host and keeps a current town model.
 *
 * The bridge lands on the iframe's `load` event, which can be after this module has
 * already run — so it is polled for, the same way every other mod does it
 * (mods/go-karts/go-karts.js:615).
 */
export class TownData {
  constructor(onChange) {
    this.onChange = onChange;
    this.contexts = [];
    this.shells = [];
    this.windowSessions = [];
    this.channels = {};
    this.readMarks = loadReadMarks();
    this.settings = {};
    this.model = { byCtx: new Map(), waiting: [], active: [] };

    this._unsubs = [];
    this._timer = null;
    this._bridgePoll = null;
    this._stopped = false;
  }

  start() {
    this._pollShells();
    this._timer = setInterval(() => this._pollShells(), SHELLS_POLL_MS);

    let attempts = 0;
    this._bridgePoll = setInterval(() => {
      if (window.deepsteve) {
        clearInterval(this._bridgePoll);
        this._bridgePoll = null;
        this._wireBridge();
      } else if (++attempts > 100) {
        clearInterval(this._bridgePoll);
        this._bridgePoll = null;
      }
    }, 100);
  }

  _wireBridge() {
    const ds = window.deepsteve;
    const add = (unsub) => { if (typeof unsub === 'function') this._unsubs.push(unsub); };

    add(ds.onContextsChanged?.((list) => {
      this.contexts = list || [];
      this._recompute({ layoutChanged: true });
    }));

    add(ds.onSessionsChanged?.((list) => {
      this.windowSessions = list || [];
      this._recompute();
    }));

    add(ds.onAgentChatChanged?.((channels) => {
      this.channels = channels || {};
      this._recompute();
    }));

    add(ds.onSettingsChanged?.((settings) => {
      this.settings = settings || {};
      this._recompute({ settingsChanged: true });
    }));

    // A reconnect after sleep or a daemon restart makes the REST snapshot stale.
    add(ds.onWSReconnected?.(() => this._pollShells()));
  }

  async _pollShells() {
    if (this._stopped) return;
    try {
      const res = await fetch('/api/shells');
      if (!res.ok) return;
      const data = await res.json();
      this.shells = data.shells || [];
      this._recompute();
    } catch {
      // The daemon restarting is normal; the next tick picks it back up.
    }
  }

  _recompute(flags = {}) {
    if (this._stopped) return;
    this.model = buildTownModel({
      contexts: this.contexts,
      shells: this.shells,
      windowSessions: this.windowSessions,
      channels: this.channels,
      readMarks: this.readMarks,
    });
    this.onChange?.(this.model, flags);
  }

  /** Opening a house's mailbox marks its senders' messages read, so the flag drops. */
  markRead(ctxId) {
    const entry = this.model.byCtx.get(ctxId);
    if (!entry || !entry.unread) return;
    const names = new Set(entry.sessions.map((s) => String(s.name || '').toLowerCase()));
    let touched = false;
    for (const [channel, data] of Object.entries(this.channels || {})) {
      const msgs = (data && data.messages) || [];
      for (const msg of msgs) {
        if (!names.has(String(msg.sender || '').toLowerCase())) continue;
        if (msg.id > (this.readMarks[channel] || 0)) {
          this.readMarks[channel] = msg.id;
          touched = true;
        }
      }
    }
    if (touched) {
      saveReadMarks(this.readMarks);
      this._recompute();
    }
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    if (this._bridgePoll) clearInterval(this._bridgePoll);
    for (const unsub of this._unsubs) {
      try { unsub(); } catch { /* the iframe is going away anyway */ }
    }
    this._unsubs = [];
  }
}

function loadReadMarks() {
  try { return JSON.parse(localStorage.getItem(READ_KEY) || '{}'); }
  catch { return {}; }
}

function saveReadMarks(marks) {
  try { localStorage.setItem(READ_KEY, JSON.stringify(marks)); }
  catch { /* private mode; the flags just stay up */ }
}
