/**
 * Modal for restoring orphaned windows on startup
 */

import { getDefaultTabName } from './tab-manager.js';

export function showWindowRestoreModal(orphanedWindows) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const windowListHtml = orphanedWindows.map((win, index) => {
      const sessionsHtml = win.sessions.map(s =>
        `<span class="session-name">${s.name || getDefaultTabName(s.cwd)}</span>`
      ).join('');

      const lastActive = new Date(win.lastActive);
      const timeAgo = formatTimeAgo(lastActive);

      return `
        <div class="window-item" data-index="${index}">
          <div class="window-title">Window ${index + 1} (${win.sessions.length} session${win.sessions.length !== 1 ? 's' : ''})</div>
          <div class="window-sessions">${sessionsHtml}</div>
          <div class="window-sessions" style="margin-top: 4px;">Last active: ${timeAgo}</div>
        </div>
      `;
    }).join('');

    overlay.innerHTML = `
      <div class="modal">
        <h2>Restore Previous Sessions</h2>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 12px;">
          Found ${orphanedWindows.length} window${orphanedWindows.length !== 1 ? 's' : ''} from previous sessions. Select one to restore:
        </p>
        <div class="window-list">
          ${windowListHtml}
        </div>
        <div class="modal-buttons">
          <button class="btn-secondary" id="skip-btn">Start Fresh</button>
          <button class="btn-primary" id="restore-btn" disabled>Restore Selected</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let selectedIndex = null;

    overlay.querySelectorAll('.window-item').forEach(item => {
      item.onclick = () => {
        overlay.querySelectorAll('.window-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        selectedIndex = parseInt(item.dataset.index);
        overlay.querySelector('#restore-btn').disabled = false;
      };

      item.ondblclick = () => {
        selectedIndex = parseInt(item.dataset.index);
        overlay.remove();
        resolve({ action: 'restore', window: orphanedWindows[selectedIndex] });
      };
    });

    overlay.querySelector('#restore-btn').onclick = () => {
      if (selectedIndex !== null) {
        overlay.remove();
        resolve({ action: 'restore', window: orphanedWindows[selectedIndex] });
      }
    };

    overlay.querySelector('#skip-btn').onclick = () => {
      overlay.remove();
      resolve({ action: 'fresh' });
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve({ action: 'fresh' });
      }
    };
  });
}

function formatTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' minutes ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
  return Math.floor(seconds / 86400) + ' days ago';
}
