/**
 * Restore Sessions — a window picker (#560, reshaped by #658).
 *
 * Two different things in this codebase are called a "session": the browser window
 * that held seven agent tabs, and each agent inside it. When a window is lost — a
 * crash, a closed browser, a `./restart.sh` — the thing worth offering back is the
 * WINDOW. "You had a tab open with 7 sessions in it; want it back?"
 *
 * #560 offered the other one. It listed every agent session the server could name,
 * including every closed tombstone inside the 30-day retention window: 1100 rows on
 * a real install, of which 301 could not be restored at all (176 terminal tabs with
 * no conversation, 125 Claude sessions whose transcript was never written, so
 * `--resume` dies in about a second) and 379 were never closed by the user at all —
 * agents that exited, `run_in_terminal` scratch tabs the daemon tears down by design,
 * worktrees auto-closed after a merge. The handful of genuine orphans sat on top of
 * that pile, and the header called the whole thing "1100 recoverable sessions".
 *
 * So the modal offers windows, and takes a window whole. The per-session list still
 * exists, as `mode: 'archive'` — but only as the disaster-recovery surface #561 added
 * it for, reached only when a deliberate re-entry finds no windows to offer. It is
 * never drawn at startup and never drawn beside windows.
 *
 * Explicit buttons only: no outside-click or Escape dismissal (a silent decline is
 * how sessions got lost in the 2026-07-15 wipe).
 */

import { getDefaultTabName } from './tab-manager.js';
import { nsChannel } from './storage-namespace.js';

// Tab names are user- and agent-supplied, and since #551 can arrive from the server
// too. Never interpolate them into innerHTML raw.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Pure helpers (exported for unit tests) ---
// `data` is the /api/recoverable-sessions shape after client-side window merging:
// { windows: [{windowId, lastActive, sessions: [...]}], ungrouped, closed, recents }.
//
// Selection keys differ by mode, and one key space covers both:
//   'win:<windowId>'  a whole window          (window mode)
//   'ungrouped'       the no-window group     (window mode)
//   '<sessionId>'     one agent session       (archive mode)
//   'recent:<key>'    one ring-buffer lineage (archive mode)

// The sessions the server knows about but no window claims. Pre-#551 entries and
// start-issue sessions whose window never resolved land here. They are live agents,
// so hiding them would strand running work — but they are not a window either, so
// they get one row of their own rather than N.
export const UNGROUPED_KEY = 'ungrouped';

// How many project names a window row spells out before summarising the rest.
export const PROJECTS_SHOWN = 3;

export function windowRowKey(windowId) {
  return `win:${windowId}`;
}

export function recentRowKey(r) {
  return 'recent:' + r.key;
}

/**
 * Every key that could be checked, in either mode: group keys AND the individual
 * session/recent keys underneath them.
 *
 * Both halves are load-bearing. `applyClaim` prunes the checked set against this,
 * and in window mode the checked set holds group keys while a claim names session
 * ids — so a set built from session ids alone would silently unselect every window
 * the moment any sibling window restored something.
 */
export function allRowKeys(data) {
  const keys = [];
  for (const w of data.windows || []) {
    keys.push(windowRowKey(w.windowId));
    for (const s of w.sessions) keys.push(s.id);
  }
  if ((data.ungrouped || []).length) keys.push(UNGROUPED_KEY);
  for (const s of data.ungrouped || []) keys.push(s.id);
  for (const s of data.closed || []) keys.push(s.id);
  for (const r of data.recents || []) keys.push(recentRowKey(r));
  return keys;
}

function projectsOf(sessions) {
  const seen = [];
  for (const s of sessions) {
    const p = s.cwd ? getDefaultTabName(s.cwd) : null;
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * One row per offerable window, newest first, with the ungrouped pseudo-row last.
 *
 * `restorable` is the count that excludes sessions whose directory is gone (#632).
 * Restoring those spawns nothing but a refusal, so they are subtracted from the
 * count the button promises and from what buildSelection actually sends — while the
 * row still says how many were dropped, because a window that comes back two
 * sessions short must not do so silently.
 */
export function windowRows(data) {
  const rows = (data.windows || []).map((w) => {
    const sessions = w.sessions || [];
    const missing = sessions.filter(s => s.cwdMissing).length;
    return {
      key: windowRowKey(w.windowId),
      windowId: w.windowId,
      ungrouped: false,
      count: sessions.length,
      missing,
      restorable: sessions.length - missing,
      projects: projectsOf(sessions),
      lastActive: w.lastActive
        || Math.max(0, ...sessions.map(s => s.lastActivity || s.createdAt || 0)),
    };
  });

  rows.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));

  const loose = data.ungrouped || [];
  if (loose.length) {
    const missing = loose.filter(s => s.cwdMissing).length;
    rows.push({
      key: UNGROUPED_KEY,
      windowId: null,
      ungrouped: true,
      count: loose.length,
      missing,
      restorable: loose.length - missing,
      projects: projectsOf(loose),
      lastActive: Math.max(0, ...loose.map(s => s.lastActivity || s.createdAt || 0)),
    });
  }
  return rows;
}

export function windowRowTitle(row) {
  const n = row.count;
  const plural = n === 1 ? 'session' : 'sessions';
  return row.ungrouped ? `${n} ${plural} not in a window` : `${n} ${plural}`;
}

export function windowRowProjects(row) {
  const p = row.projects || [];
  if (p.length <= PROJECTS_SHOWN) return p.join(' · ');
  const rest = p.length - PROJECTS_SHOWN;
  return `${p.slice(0, PROJECTS_SHOWN).join(' · ')} · +${rest} more`;
}

export function windowRowMeta(row, now = Date.now()) {
  const bits = [];
  if (row.lastActive) bits.push(`last active ${formatTimeAgo(row.lastActive, now)}`);
  if (row.missing > 0) {
    bits.push(row.restorable === 0
      ? `⚠ can't reopen — ${row.missing === 1 ? 'its directory is' : 'their directories are'} gone`
      : `⚠ ${row.missing} can't reopen — directory gone`);
  }
  return bits.join(' · ');
}

/**
 * Everything offerable starts checked — the modal exists because you lost these.
 * A window with nothing restorable left is the one exception: checking it would
 * promise a reopen the server is going to refuse.
 */
export function defaultWindowSelection(rows) {
  return new Set(rows.filter(r => r.restorable > 0).map(r => r.key));
}

/** How many agent sessions the checked windows would actually reopen. */
export function selectedSessionCount(rows, checkedKeys) {
  return rows
    .filter(r => checkedKeys.has(r.key))
    .reduce((n, r) => n + r.restorable, 0);
}

// The archive is the whole retention window — 1100 rows on a real install — and it
// is the one list here with no upper bound. Drawing it in a single synchronous pass
// is what the old preview slice existed to avoid, so the cap survives even though
// the collapsing UI around it did not. Safe to keep simple now: archive rows have no
// group checkbox above them and nothing is pre-checked, so an undrawn row is never
// a silently-selected one.
export const ARCHIVE_PAGE = 50;

export function takeArchivePage(rows, shown) {
  const all = rows || [];
  const n = Math.min(shown, all.length);
  return { shown: all.slice(0, n), hidden: all.length - n };
}

export function primaryLabel(sessionCount) {
  if (!sessionCount) return 'Reopen';
  return `Reopen ${sessionCount} session${sessionCount === 1 ? '' : 's'}`;
}

/**
 * Window mode → the `{ windows, sessions, recents }` shape app.js already consumes.
 *
 * A single-session window must still emit a `{ windowId, sessions }` group rather
 * than being flattened into `sessions`: app.js feeds these to
 * WindowManager.claimSessions, which needs windowId to clear the donor window's
 * localStorage rows. Flattening would leave the donor pointing at tabs that now
 * live here.
 */
export function buildSelection(data, checkedKeys) {
  const live = s => !s.cwdMissing;
  return {
    windows: (data.windows || [])
      .filter(w => checkedKeys.has(windowRowKey(w.windowId)))
      .map(w => ({ ...w, sessions: (w.sessions || []).filter(live) }))
      .filter(w => w.sessions.length > 0),
    sessions: checkedKeys.has(UNGROUPED_KEY) ? (data.ungrouped || []).filter(live) : [],
    recents: [],
  };
}

/** Archive mode → the same shape, keyed per session instead of per window. */
export function buildArchiveSelection(data, checkedKeys) {
  return {
    windows: [],
    sessions: [...(data.ungrouped || []), ...(data.closed || [])].filter(s => checkedKeys.has(s.id)),
    recents: (data.recents || []).filter(r => checkedKeys.has(recentRowKey(r))),
  };
}

/**
 * Internal close reasons are wire values, not English, and several of them are
 * exits rather than closes — `tmux-pane-exited` under a heading that said "closed
 * on purpose" was simply a lie. Nothing here ever returns the raw enum.
 */
/**
 * A row's title, and whether we actually know one.
 *
 * The old fallback chain ended at the cwd basename, which the meta line already
 * shows — so a session with no name and no transcript rendered as `yarnstory` above
 * `yarnstory`, twice the pixels for one fact. The worktree name is a real
 * identifier and worth preferring; past that, say we don't know.
 */
export function sessionRowTitle(s) {
  if (s.name) return { text: s.name, known: true };
  if (s.label) return { text: s.label, known: true };
  if (s.worktree) return { text: s.worktree, known: true };
  return { text: 'Untitled session', known: false };
}

export function describeCloseReason(reason) {
  const r = String(reason || '');
  if (r === 'user-closed' || r === 'closed') return 'you closed it';
  if (r === 'disconnected') return 'cleared as disconnected';
  if (r === 'merged') return 'merged, then closed itself';
  if (r === 'terminal-run-finished' || r === 'terminal-run-ended') return 'a one-off command finished';
  if (r.startsWith('scheduled')) return 'a scheduled run ended';
  if (r === 'exited') return 'the agent exited';
  if (r === 'tmux-pane-exited') return 'its terminal pane exited';
  if (r === 'socket-migration' || r === 'killed') return 'the server ended it';
  if (r.startsWith('restore-gave-up') || r === 'respawn-failed') return 'a restore failed';
  return 'ended';
}

/**
 * Another window restored some rows (broadcast 'restore-claimed'): drop them here,
 * prune emptied groups, and keep the survivors' check state untouched.
 */
export function applyClaim(data, checkedKeys, claim) {
  const claimedSessions = new Set(claim.sessionIds || []);
  const claimedRecents = new Set(claim.recentKeys || []);
  const out = {
    windows: (data.windows || [])
      .map(w => ({ ...w, sessions: w.sessions.filter(s => !claimedSessions.has(s.id)) }))
      .filter(w => w.sessions.length > 0),
    ungrouped: (data.ungrouped || []).filter(s => !claimedSessions.has(s.id)),
    closed: (data.closed || []).filter(s => !claimedSessions.has(s.id)),
    recents: (data.recents || []).filter(r => !claimedRecents.has(r.key)),
  };
  const surviving = new Set(allRowKeys(out));
  return {
    data: out,
    checkedKeys: new Set([...checkedKeys].filter(k => surviving.has(k))),
  };
}

// --- Modal ---

export function showSessionRestoreModal(initialData, { secondaryLabel = 'Not now', mode = 'windows' } = {}) {
  return new Promise((resolve) => {
    let data = {
      windows: initialData.windows || [],
      ungrouped: initialData.ungrouped || [],
      closed: initialData.closed || [],
      recents: initialData.recents || [],
    };
    const archive = mode === 'archive';
    let archiveShown = ARCHIVE_PAGE;
    let rows = archive ? [] : windowRows(data);
    let checked = archive ? archiveDefaultSelection() : defaultWindowSelection(rows);
    let dismissed = false;

    // Namespaced: a nested Baby Browser instance shares this origin, and a bare
    // channel name would let its modal reconcile against the top-level one's claims.
    const bc = new BroadcastChannel(nsChannel('deepsteve-windows'));

    function dismiss(result) {
      if (dismissed) return;
      dismissed = true;
      bc.close();
      overlay.remove();
      resolve(result);
    }

    bc.onmessage = (event) => {
      if (event.data.type !== 'restore-claimed' || dismissed) return;
      ({ data, checkedKeys: checked } = applyClaim(data, checked, event.data));
      if (allRowKeys(data).length === 0) {
        // Everything was restored elsewhere — nothing left to offer. NOT a user
        // dismissal: reason lets the caller tell the two apart.
        dismiss({ action: 'fresh', reason: 'claimed' });
      } else {
        rows = archive ? [] : windowRows(data);
        render();
      }
    };

    const heading = archive ? 'Recover a past session' : 'Reopen your windows';
    const blurb = archive
      ? 'No windows to bring back, so these are the individual sessions still on record.'
      : 'These were open when this browser last went away.';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide restore-modal">
        <h2>${esc(heading)}</h2>
        <p class="restore-subtitle"><span id="restore-count">${esc(blurb)}</span></p>
        <div class="window-list restore-list" id="restore-list"></div>
        <p class="restore-reassure">Nothing is deleted either way — declining just leaves them where they are.</p>
        <div class="modal-buttons">
          <button class="btn-secondary" id="skip-btn">${esc(secondaryLabel)}</button>
          <button class="btn-primary" id="restore-btn">Reopen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#restore-list');
    const restoreBtn = overlay.querySelector('#restore-btn');
    const countEl = overlay.querySelector('#restore-count');

    function renderWindows() {
      listEl.innerHTML = rows.map(row => `
        <label class="window-item restore-win${row.restorable === 0 ? ' restore-win-dead' : ''}"
               data-row="${esc(row.key)}">
          <input type="checkbox" data-key="${esc(row.key)}"${row.restorable === 0 ? ' disabled' : ''}>
          <div class="restore-row-body">
            <div class="restore-row-title">${esc(windowRowTitle(row))}</div>
            ${row.projects.length ? `<div class="restore-win-projects">${esc(windowRowProjects(row))}</div>` : ''}
            <div class="window-sessions">${esc(windowRowMeta(row))}</div>
          </div>
        </label>
      `).join('');
    }

    function renderArchive() {
      const sessionRows = [
        ...data.ungrouped.map(s => archiveRow(s, false)),
        ...data.closed.map(s => archiveRow(s, true)),
        ...data.recents.map(recentArchiveRow),
      ];
      const page = takeArchivePage(sessionRows, archiveShown);
      listEl.innerHTML = page.shown.map(row => `
        <label class="window-item${row.closed ? ' session-closed' : ''}" data-row="${esc(row.key)}">
          <input type="checkbox" data-key="${esc(row.key)}">
          <div class="restore-row-body">
            <div class="restore-row-title${row.untitled ? ' restore-row-untitled' : ''}">${esc(row.title)}</div>
            ${row.meta ? `<div class="window-sessions">${esc(row.meta)}</div>` : ''}
          </div>
        </label>
      `).join('')
        + (page.hidden ? `<button type="button" class="restore-show-more" data-more>Show ${page.hidden} more</button>` : '');
    }

    function render() {
      if (archive) renderArchive();
      else renderWindows();
      syncUI();
    }

    function syncUI() {
      for (const input of listEl.querySelectorAll('input[data-key]')) {
        const on = checked.has(input.dataset.key);
        input.checked = on;
        input.closest('.window-item').classList.toggle('checked', on);
      }
      const n = archive ? checked.size : selectedSessionCount(rows, checked);
      restoreBtn.textContent = archive
        ? (n ? `Recover ${n} session${n === 1 ? '' : 's'}` : 'Recover')
        : primaryLabel(n);
      restoreBtn.disabled = n === 0;
    }

    listEl.addEventListener('click', (e) => {
      if (!e.target.closest('[data-more]')) return;
      e.preventDefault();
      archiveShown += ARCHIVE_PAGE;
      render();
    });

    listEl.addEventListener('change', (e) => {
      const key = e.target.dataset && e.target.dataset.key;
      if (!key) return;
      if (e.target.checked) checked.add(key);
      else checked.delete(key);
      syncUI();
    });

    restoreBtn.onclick = () => {
      if (checked.size === 0) return;
      const selection = archive
        ? buildArchiveSelection(data, checked)
        : buildSelection(data, checked);
      // Tell any other open modal which rows are taken so it drops them instead of
      // blanket-dismissing (the old 'restore-modal-dismissed' resolved every window
      // as "fresh" — the exact bug #560 calls out).
      bc.postMessage({
        type: 'restore-claimed',
        sessionIds: [
          ...selection.windows.flatMap(w => w.sessions.map(s => s.id)),
          ...selection.sessions.map(s => s.id),
        ],
        recentKeys: selection.recents.map(r => r.key),
      });
      dismiss({ action: 'restore', selection });
    };

    overlay.querySelector('#skip-btn').onclick = () => {
      // Declining is NOT broadcast: another window's open modal keeps its offer.
      dismiss({ action: 'fresh' });
    };

    // Deliberately no overlay-click or Escape dismissal (#560): losing the restore
    // offer must be an explicit choice.

    countEl.textContent = blurb;
    render();
  });
}

// --- Archive mode helpers (the mass-loss surface only) ---

function archiveDefaultSelection() {
  // Nothing is pre-checked down here. This list is reached only when a window
  // picker had nothing to offer, and it is a month of history rather than a set of
  // losses — choosing on the user's behalf is what made Restore All (1082) possible.
  return new Set();
}

function archiveRow(s, closed) {
  const title = sessionRowTitle(s);
  const meta = [];
  if (s.cwd) meta.push(getDefaultTabName(s.cwd));
  if (s.cwdMissing) meta.push('⚠ directory missing');
  // The worktree is already the title when it is all we had — don't say it twice.
  if (s.worktree && title.text !== s.worktree) meta.push(`⎇ ${s.worktree}`);
  if (s.agentType && s.agentType !== 'claude') meta.push(s.agentType);
  if (closed) {
    const when = s.closedAt ? formatTimeAgo(s.closedAt) : null;
    meta.push(when ? `${describeCloseReason(s.closeReason)} ${when}` : describeCloseReason(s.closeReason));
  } else if (s.lastActivity) {
    meta.push(formatTimeAgo(s.lastActivity));
  }
  return {
    key: s.id,
    title: title.text,
    untitled: !title.known,
    meta: meta.join(' · '),
    closed,
  };
}

function recentArchiveRow(r) {
  const title = sessionRowTitle(r);
  const meta = [];
  if (r.cwd) meta.push(getDefaultTabName(r.cwd));
  if (r.cwdMissing) meta.push('⚠ directory missing');
  if (r.worktree && title.text !== r.worktree) meta.push(`⎇ ${r.worktree}`);
  if (r.agentType && r.agentType !== 'claude') meta.push(r.agentType);
  if (r.updatedAt) meta.push(formatTimeAgo(r.updatedAt));
  return {
    key: recentRowKey(r),
    title: title.text,
    untitled: !title.known,
    meta: meta.join(' · '),
    closed: false,
  };
}

/**
 * `now` is injectable so this is testable without freezing the clock. Accepts a
 * timestamp or a Date.
 */
export function formatTimeAgo(when, now = Date.now()) {
  const ms = when instanceof Date ? when.getTime() : Number(when);
  const seconds = Math.floor((now - ms) / 1000);

  if (seconds < 60) return 'just now';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return plural(Math.floor(seconds / 3600), 'hour');
  return plural(Math.floor(seconds / 86400), 'day');
}
