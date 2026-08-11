/**
 * Recover-everything restore modal (#560).
 *
 * Shows every session the server knows how to bring back — window groups,
 * ungrouped sessions, closed tombstones (#561), and recent-history lineages —
 * with per-session checkboxes and Restore All as the primary action. Explicit
 * buttons only: no outside-click or Escape dismissal (a silent "Start Fresh"
 * is how sessions got lost in the 2026-07-15 wipe).
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
// `data` is the /api/recoverable-sessions shape after client-side window
// merging: { windows: [{windowId, sessions: [...]}], ungrouped, closed, recents }.
// Selection keys: the session id for state-backed rows, 'recent:<key>' for
// ring-buffer rows (a recents key is a claudeSessionId, so it can never
// collide with an 8-char shell id — but the prefix keeps the intent explicit).

// How many closed tombstones the 'Recently closed' section draws before
// collapsing behind a "Show N more" button. See buildSections().
export const CLOSED_PREVIEW = 8;

// Tombstones accumulate for the whole retention window (30 days by default), so
// this one bucket is routinely in the hundreds while every other is a handful.
// Drawing them all buried the sessions the user came here for under a wall of
// deliberate closes. Collapsing is purely a rendering concern: the section's
// checkbox and Select all still address the full list (see `allKeys` in
// buildSections), so a hidden row is never an unselectable one.
export function splitClosed(closed, expanded) {
  const shown = expanded ? closed : (closed || []).slice(0, CLOSED_PREVIEW);
  return { shown, hidden: (closed || []).length - shown.length };
}

export function recentRowKey(r) {
  return 'recent:' + r.key;
}

export function allRowKeys(data) {
  const keys = [];
  for (const w of data.windows || []) for (const s of w.sessions) keys.push(s.id);
  for (const s of data.ungrouped || []) keys.push(s.id);
  for (const s of data.closed || []) keys.push(s.id);
  for (const r of data.recents || []) keys.push(recentRowKey(r));
  return keys;
}

// Tiered defaults: orphaned/ungrouped sessions are what the user almost
// certainly wants back, so they start checked. Closed tombstones were closed on
// purpose and start unchecked — EXCEPT when nothing else is offerable (the
// wipe case: every session is a tombstone), where Restore All must just work.
// Recents are the last-resort tier under the same rule.
export function defaultSelection(data) {
  const tier1 = [];
  for (const w of data.windows || []) for (const s of w.sessions) tier1.push(s.id);
  for (const s of data.ungrouped || []) tier1.push(s.id);
  if (tier1.length) return withoutMissingCwd(tier1, data);
  const tier2 = (data.closed || []).map(s => s.id);
  if (tier2.length) return withoutMissingCwd(tier2, data);
  return withoutMissingCwd((data.recents || []).map(recentRowKey), data);
}

// #632: a row whose directory is gone will be refused by the server, so don't
// pre-check it — a Restore All over a deleted repo would otherwise fire off N
// refusals. The rows stay visible and selectable (the volume may have just been
// remounted); we only decline to choose them on the user's behalf.
//
// Deliberately applied AFTER the tier is chosen, never as a filter on tier
// membership: a tier that is entirely missing must still win, or a window full of
// dead sessions would silently fall through and check every closed tombstone the
// user never asked for.
function withoutMissingCwd(keys, data) {
  const missing = new Set();
  for (const w of data.windows || []) for (const s of w.sessions) if (s.cwdMissing) missing.add(s.id);
  for (const s of data.ungrouped || []) if (s.cwdMissing) missing.add(s.id);
  for (const s of data.closed || []) if (s.cwdMissing) missing.add(s.id);
  for (const r of data.recents || []) if (r.cwdMissing) missing.add(recentRowKey(r));
  return new Set(keys.filter(k => !missing.has(k)));
}

export function primaryLabel(checkedCount, total) {
  if (checkedCount === 0) return 'Restore Selected';
  if (checkedCount === total) return `Restore All (${total})`;
  return `Restore Selected (${checkedCount} of ${total})`;
}

// Another window restored some rows (broadcast 'restore-claimed'): drop them
// here, prune emptied groups, and keep the survivors' check state untouched.
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

export function showSessionRestoreModal(initialData, { secondaryLabel = 'Start Fresh' } = {}) {
  return new Promise((resolve) => {
    let data = {
      windows: initialData.windows || [],
      ungrouped: initialData.ungrouped || [],
      closed: initialData.closed || [],
      recents: initialData.recents || [],
    };
    let checked = defaultSelection(data);
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
        render();
      }
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide">
        <h2>Restore Sessions</h2>
        <p class="restore-subtitle">
          <span id="restore-count"></span>
          <span class="restore-select-links">
            <a id="restore-select-all">Select all</a> · <a id="restore-select-none">none</a>
          </span>
        </p>
        <div class="window-list restore-list" id="restore-list"></div>
        <div class="modal-buttons">
          <button class="btn-secondary" id="skip-btn">${esc(secondaryLabel)}</button>
          <button class="btn-primary" id="restore-btn">Restore All</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#restore-list');
    const restoreBtn = overlay.querySelector('#restore-btn');
    const countEl = overlay.querySelector('#restore-count');

    function sessionRow(s, { closed = false } = {}) {
      const meta = [];
      if (s.cwd) meta.push(getDefaultTabName(s.cwd));
      // #632: restoring this would be refused — the row's directory is gone. Said
      // right after the directory name, since that name is now the misleading part.
      if (s.cwdMissing) meta.push('⚠ directory missing');
      if (s.worktree) meta.push(`⎇ ${s.worktree}`);
      if (s.agentType && s.agentType !== 'claude') meta.push(s.agentType);
      if (closed) {
        meta.push(`closed ${s.closedAt ? formatTimeAgo(new Date(s.closedAt)) : ''}${s.closeReason ? ` (${s.closeReason})` : ''}`.trim());
      } else if (s.lastActivity) {
        meta.push(formatTimeAgo(new Date(s.lastActivity)));
      }
      return {
        key: s.id,
        title: s.name || s.label || getDefaultTabName(s.cwd),
        derived: !s.name && !!s.label,
        meta: meta.join(' · '),
        closed,
      };
    }

    function recentRow(r) {
      const meta = [];
      if (r.cwd) meta.push(getDefaultTabName(r.cwd));
      if (r.cwdMissing) meta.push('⚠ directory missing');
      if (r.worktree) meta.push(`⎇ ${r.worktree}`);
      if (r.agentType && r.agentType !== 'claude') meta.push(r.agentType);
      if (r.updatedAt) meta.push(formatTimeAgo(new Date(r.updatedAt)));
      return {
        key: recentRowKey(r),
        title: r.name || r.label || getDefaultTabName(r.cwd),
        derived: !r.name && !!r.label,
        meta: meta.join(' · '),
        closed: false,
      };
    }

    function buildSections() {
      const sections = [];
      data.windows.forEach((w, i) => {
        sections.push({
          key: `win:${w.windowId}`,
          title: `Window ${i + 1}`,
          meta: `${w.sessions.length} session${w.sessions.length !== 1 ? 's' : ''}`
            + (w.lastActive ? ` · last active ${formatTimeAgo(new Date(w.lastActive))}` : ''),
          rows: w.sessions.map(s => sessionRow(s)),
        });
      });
      if (data.ungrouped.length) {
        sections.push({
          key: 'ungrouped', title: 'Ungrouped sessions',
          meta: 'not attached to any window',
          rows: data.ungrouped.map(s => sessionRow(s)),
        });
      }
      if (data.closed.length) {
        const { shown, hidden } = splitClosed(data.closed, closedExpanded);
        sections.push({
          key: 'closed', title: 'Recently closed',
          meta: 'closed on purpose — check to resurrect',
          rows: shown.map(s => sessionRow(s, { closed: true })),
          allKeys: data.closed.map(s => s.id),
          hidden,
        });
      }
      if (data.recents.length) {
        sections.push({
          key: 'recents', title: 'From recent history',
          meta: 'restores a fresh copy of the conversation',
          rows: data.recents.map(r => recentRow(r)),
        });
      }
      return sections;
    }

    // sectionKey → [row keys], rebuilt on every render; drives the header
    // checkboxes' toggle-all and indeterminate state. For a collapsed section
    // this is the FULL set, not just the drawn rows.
    let sectionKeys = new Map();

    let closedExpanded = false;

    function render() {
      const sections = buildSections();
      sectionKeys = new Map(sections.map(sec => [sec.key, sec.allKeys || sec.rows.map(r => r.key)]));
      listEl.innerHTML = sections.map(sec => `
        <div class="restore-section${sec.key === 'closed' ? ' restore-section-closed' : ''}">
          <label class="restore-section-header">
            <input type="checkbox" data-group="${esc(sec.key)}">
            <span class="restore-section-title">${esc(sec.title)}</span>
            <span class="restore-section-meta">${esc(sec.meta)}</span>
          </label>
          ${sec.rows.map(row => `
            <label class="window-item${row.closed ? ' session-closed' : ''}" data-row="${esc(row.key)}">
              <input type="checkbox" data-key="${esc(row.key)}">
              <div class="restore-row-body">
                <div class="restore-row-title${row.derived ? ' restore-row-derived' : ''}">${esc(row.title)}</div>
                ${row.meta ? `<div class="window-sessions">${esc(row.meta)}</div>` : ''}
              </div>
            </label>
          `).join('')}
          ${sec.hidden ? `<button type="button" class="restore-show-more" data-expand="${esc(sec.key)}">Show ${sec.hidden} more</button>` : ''}
        </div>
      `).join('');
      syncUI();
    }

    function syncUI() {
      for (const input of listEl.querySelectorAll('input[data-key]')) {
        const on = checked.has(input.dataset.key);
        input.checked = on;
        input.closest('.window-item').classList.toggle('checked', on);
      }
      for (const input of listEl.querySelectorAll('input[data-group]')) {
        const keys = sectionKeys.get(input.dataset.group) || [];
        const n = keys.filter(k => checked.has(k)).length;
        input.checked = n > 0 && n === keys.length;
        input.indeterminate = n > 0 && n < keys.length;
      }
      const total = allRowKeys(data).length;
      countEl.textContent = `${total} recoverable session${total !== 1 ? 's' : ''} — checked ones open in this window.`;
      restoreBtn.textContent = primaryLabel(checked.size, total);
      restoreBtn.disabled = checked.size === 0;
    }

    listEl.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.key) {
        if (t.checked) checked.add(t.dataset.key);
        else checked.delete(t.dataset.key);
      } else if (t.dataset.group) {
        for (const k of sectionKeys.get(t.dataset.group) || []) {
          if (t.checked) checked.add(k);
          else checked.delete(k);
        }
      }
      syncUI();
    });

    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-expand]');
      if (!btn) return;
      e.preventDefault();
      closedExpanded = true;
      render();
    });

    overlay.querySelector('#restore-select-all').onclick = () => {
      checked = new Set(allRowKeys(data));
      syncUI();
    };
    overlay.querySelector('#restore-select-none').onclick = () => {
      checked = new Set();
      syncUI();
    };

    restoreBtn.onclick = () => {
      if (checked.size === 0) return;
      const selection = {
        windows: data.windows
          .map(w => ({ ...w, sessions: w.sessions.filter(s => checked.has(s.id)) }))
          .filter(w => w.sessions.length > 0),
        sessions: [...data.ungrouped, ...data.closed].filter(s => checked.has(s.id)),
        recents: data.recents.filter(r => checked.has(recentRowKey(r))),
      };
      // Tell any other open modal which rows are taken so it drops them instead
      // of blanket-dismissing (the old 'restore-modal-dismissed' resolved every
      // window as "fresh" — the exact bug #560 calls out).
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

    // Deliberately no overlay-click or Escape dismissal (#560): losing the
    // restore offer must be an explicit choice.

    render();
  });
}

function formatTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' minutes ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
  return Math.floor(seconds / 86400) + ' days ago';
}
