// Display tabs on disk (#715): each open tab's HTML, which tabs are locked, and the stack of
// recently closed tabs that "Reopen closed tab" pops — the newest, or any one by id (#723).
//
// Before #715 a close unlinked <dir>/<id>.html, which is why closing asked "are you sure?".
// Now a close moves the file into <dir>/closed/ and pushes an entry, and a reopen moves it back
// under the SAME id, so an agent's tab_id works again. A lock is a plain boolean anyone can
// toggle — the user from the tab's right-click menu, an agent through `locked` — and a locked tab
// refuses every close and is exempt from the staleness sweep below.
//
//   <dir>/<id>.html         open tabs (the only files the pre-#715 loader knew about)
//   <dir>/closed/<id>.html  closed tabs
//   <dir>/index.json        { tabs: {id: {name, cwd, locked}}, closed: [{id, name, cwd, closedAt}] }
//
// The stack is newest first, capped at `maxClosed`, and an entry older than `maxAgeMs` is gone —
// the same 7 days an untouched open tab has always had. Dependency-free and fully injectable so
// unit tests can drive it with a temp dir and a fake clock.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_CLOSED = 20;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME = 200;

const str = (v) => (typeof v === 'string' ? v : null);

function createDisplayTabRegistry({
  dir,
  now = Date.now,
  log = () => {},
  maxClosed = DEFAULT_MAX_CLOSED,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
}) {
  const tabs = new Map(); // id → HTML string: what server.js hands out as `displayTabs`
  let meta = {};          // id → { name, cwd, locked } for open tabs
  let closed = [];        // [{ id, name, cwd, closedAt }], newest first

  const closedDir = path.join(dir, 'closed');
  const indexFile = path.join(dir, 'index.json');
  const openPath = (id) => path.join(dir, `${id}.html`);
  const closedPath = (id) => path.join(closedDir, `${id}.html`);
  const isExpired = (e) => now() - e.closedAt > maxAgeMs;

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = indexFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tabs: meta, closed }, null, 2));
      fs.renameSync(tmp, indexFile);
    } catch (e) { log(`[display-tab] Failed to save ${indexFile}: ${e.message}`); }
  }

  // A missing or corrupt index is "no locks, nothing to reopen", never a throw.
  function readIndex() {
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return {
        tabs: data && data.tabs && typeof data.tabs === 'object' ? data.tabs : {},
        closed: data && Array.isArray(data.closed) ? data.closed : [],
      };
    } catch {
      return { tabs: {}, closed: [] };
    }
  }

  // Drop expired entries and anything past the cap, with their files. Returns whether it dropped any.
  function trimClosed() {
    const keep = [];
    for (const e of closed) {
      if (keep.length < maxClosed && !isExpired(e)) { keep.push(e); continue; }
      try { fs.unlinkSync(closedPath(e.id)); } catch {}
    }
    const changed = keep.length !== closed.length;
    closed = keep;
    return changed;
  }

  // Move a file, falling back to writing `content` when the rename can't happen (the source
  // never got written, or a cross-device dir). Returns whether the destination now exists.
  function move(from, to, content) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return true;
    } catch {}
    try {
      fs.writeFileSync(to, content);
      try { fs.unlinkSync(from); } catch {}
      return true;
    } catch (e) {
      log(`[display-tab] Failed to move ${path.basename(from)}: ${e.message}`);
      return false;
    }
  }

  /** Read every open tab and the stack from disk, sweeping what is stale or orphaned. */
  function load() {
    tabs.clear();
    meta = {};
    closed = [];
    if (!fs.existsSync(dir)) return 0;
    const idx = readIndex();

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.html')) continue;
      const id = file.slice(0, -'.html'.length);
      const m = idx.tabs[id] || {}; // a tab from before #715 has no entry: unlocked, unnamed
      const filePath = path.join(dir, file);
      try {
        // The pre-#715 staleness rule, except that a lock is exactly "keep this".
        if (!m.locked && now() - fs.statSync(filePath).mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          log(`[display-tab] Cleaned up stale file: ${file}`);
          continue;
        }
        tabs.set(id, fs.readFileSync(filePath, 'utf8'));
        meta[id] = { name: str(m.name), cwd: str(m.cwd), locked: !!m.locked };
      } catch (e) {
        log(`[display-tab] Failed to load ${file}: ${e.message}`);
      }
    }

    const seen = new Set();
    for (const e of idx.closed) {
      if (!e || typeof e.id !== 'string' || seen.has(e.id) || tabs.has(e.id)) continue;
      if (!fs.existsSync(closedPath(e.id))) continue;
      seen.add(e.id);
      closed.push({ id: e.id, name: str(e.name), cwd: str(e.cwd), closedAt: Number(e.closedAt) || 0 });
    }
    trimClosed();

    // A closed file the index does not list — a crash between the move and the index write, or
    // an index that was lost — can never be reopened, so it would otherwise sit there forever.
    const listed = new Set(closed.map(e => e.id));
    let closedFiles = [];
    try { closedFiles = fs.readdirSync(closedDir); } catch {}
    for (const file of closedFiles) {
      if (file.endsWith('.html') && listed.has(file.slice(0, -'.html'.length))) continue;
      try { fs.unlinkSync(path.join(closedDir, file)); } catch {}
    }

    save();
    return tabs.size;
  }

  /**
   * Store a tab's HTML. `info` ({name, cwd}) is what a reopen restores the tab with; pass it when
   * the tab is opened. The frequent content-only updates leave the index file alone.
   */
  function set(id, html, info) {
    tabs.set(id, html);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(openPath(id), html);
    } catch (e) { log(`[display-tab] Failed to persist ${id}: ${e.message}`); }

    const prev = meta[id] || { name: null, cwd: null, locked: false };
    meta[id] = prev;
    let dirty = false;
    if (info) {
      meta[id] = {
        ...prev,
        name: str(info.name) ?? prev.name,
        cwd: str(info.cwd) ?? prev.cwd,
      };
      dirty = true;
    }
    const i = closed.findIndex(e => e.id === id);
    if (i >= 0) {
      closed.splice(i, 1);
      try { fs.unlinkSync(closedPath(id)); } catch {}
      dirty = true;
    }
    if (dirty) save();
  }

  function isLocked(id) {
    return tabs.has(id) && !!(meta[id] && meta[id].locked);
  }

  function lockedIds() {
    return [...tabs.keys()].filter(isLocked);
  }

  /** Returns the tab's lock state after the call, or null when there is no such open tab. */
  function setLocked(id, locked) {
    if (!tabs.has(id)) return null;
    const m = meta[id] || (meta[id] = { name: null, cwd: null, locked: false });
    if (m.locked !== !!locked) {
      m.locked = !!locked;
      save();
    }
    return m.locked;
  }

  /**
   * Close a tab onto the stack. `info.name` is the name the user last saw — a tab renamed in the
   * browser should come back under that name, not the one its agent gave it.
   * Returns 'missing' (no such open tab), 'locked' (refused, nothing changed) or 'closed'.
   */
  function close(id, info = {}) {
    if (!tabs.has(id)) return 'missing';
    const m = meta[id] || { name: null, cwd: null, locked: false };
    if (m.locked) return 'locked';
    const given = str(info && info.name);
    const name = given && given.trim() ? given.slice(0, MAX_NAME) : m.name;
    const html = tabs.get(id);
    tabs.delete(id);
    delete meta[id];
    if (move(openPath(id), closedPath(id), html)) {
      closed = closed.filter(e => e.id !== id);
      closed.unshift({ id, name, cwd: m.cwd, closedAt: now() });
      trimClosed();
    } else {
      try { fs.unlinkSync(openPath(id)); } catch {}
    }
    save();
    return 'closed';
  }

  // Move one entry's page back open. The entry is already off the stack; null when it can't come
  // back, which drops it for good.
  function restore(e) {
    if (tabs.has(e.id)) { try { fs.unlinkSync(closedPath(e.id)); } catch {} return null; }
    let html;
    try { html = fs.readFileSync(closedPath(e.id), 'utf8'); } catch { return null; }
    if (!move(closedPath(e.id), openPath(e.id), html)) return null;
    // Reopening is someone asking for the page, so its staleness clock starts again.
    try { const t = new Date(now()); fs.utimesSync(openPath(e.id), t, t); } catch {}
    tabs.set(e.id, html);
    meta[e.id] = { name: e.name, cwd: e.cwd, locked: false };
    return { id: e.id, name: e.name, cwd: e.cwd };
  }

  /**
   * Reopen a closed tab: the one with `id` (#723), or the most recent when there is no id.
   * Returns {id, name, cwd}, or null when there is none — an id that was never closed, was
   * already reopened (by another window, say) or has expired is null too. Only an id found on
   * the stack ever becomes a path.
   */
  function reopen(id) {
    let changed = trimClosed();
    let out = null;
    if (id === undefined || id === null) {
      while (closed.length && !out) {
        out = restore(closed.shift());
        changed = true;
      }
    } else {
      const i = closed.findIndex(e => e.id === id);
      if (i >= 0) {
        out = restore(closed.splice(i, 1)[0]);
        changed = true;
      }
    }
    if (changed) save();
    return out;
  }

  function closedCount() {
    return closed.filter(e => !isExpired(e)).length;
  }

  /** The stack, newest first (copies). What the browser's "Reopen closed tab" submenu lists (#723). */
  function closedList() {
    return closed.filter(e => !isExpired(e)).map(e => ({ ...e }));
  }

  return { tabs, load, set, isLocked, lockedIds, setLocked, close, reopen, closedCount, closedList };
}

module.exports = { createDisplayTabRegistry, DEFAULT_MAX_CLOSED, DEFAULT_MAX_AGE_MS };
