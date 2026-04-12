/**
 * Drag-and-drop file support for terminal sessions.
 *
 * Drops a file into /tmp/deepsteve-drops/ via the server, then types the full
 * path into the terminal — like dropping a file into iTerm.
 */

import { isOverviewActive } from './overview-mode.js';

let getActiveSession = null;
let getSessionByContainerId = null;
let dragDepth = 0;
let dropZone = null;
let dragTimer = null;
let hoveredContainer = null;

function hasFiles(e) {
  return e.dataTransfer && e.dataTransfer.types.includes('Files');
}

function getTargetContainer(e) {
  if (isOverviewActive() && e) {
    const container = e.target.closest('.terminal-container');
    if (container) return container;
  }
  const session = getActiveSession();
  return session ? session.container : null;
}

function showDropZone(container) {
  if (!container) return;

  if (!dropZone) {
    dropZone = document.createElement('div');
    dropZone.className = 'file-drop-zone';
    dropZone.innerHTML = '<div class="file-drop-zone-content">Drop files here</div>';
  }

  container.appendChild(dropZone);
  dropZone.offsetHeight; // force reflow for transition
  dropZone.classList.add('visible');
}

function hideDropZone() {
  if (dropZone) dropZone.classList.remove('visible');
}

/** Shell-escape a path (wrap in single quotes, escape internal quotes). */
function shellEscape(s) {
  if (/^[a-zA-Z0-9/._\-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Upload a file to /tmp/deepsteve-drops/. Returns the full path on success,
 * null on failure.
 */
function uploadFile(file) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).path);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };
    xhr.onerror = () => resolve(null);
    xhr.open('PUT', `/api/upload/${encodeURIComponent(file.name)}`);
    xhr.send(file);
  });
}

export function initFileDrop({ getActiveSession: getter, getSessionByContainerId: containerGetter }) {
  getActiveSession = getter;
  getSessionByContainerId = containerGetter;
  const terminals = document.getElementById('terminals');

  // Prevent browser from navigating to dropped files anywhere on the page
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

  terminals.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) {
      hoveredContainer = getTargetContainer(e);
      showDropZone(hoveredContainer);
    }
  });

  terminals.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // Reset safety timer — dragover fires continuously while drag is active.
    // If it stops (cancel, Escape, left window), the timeout hides the overlay.
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => { dragDepth = 0; hideDropZone(); hoveredContainer = null; }, 500);

    // In overview mode, move the drop zone to whichever tile the cursor is over
    if (isOverviewActive()) {
      const container = e.target.closest('.terminal-container');
      if (container && container !== hoveredContainer) {
        hideDropZone();
        hoveredContainer = container;
        showDropZone(hoveredContainer);
      }
    }
  });

  terminals.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth--;
    if (dragDepth === 0) {
      hideDropZone();
      hoveredContainer = null;
    }
  });

  terminals.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    clearTimeout(dragTimer);
    dragDepth = 0;
    hideDropZone();

    let session = null;
    if (isOverviewActive()) {
      const container = hoveredContainer || e.target.closest('.terminal-container');
      if (container) {
        const id = container.id.replace(/^term-/, '');
        session = getSessionByContainerId(id);
      }
    }
    if (!session) session = getActiveSession();
    hoveredContainer = null;
    if (!session) return;

    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;

    // Upload all files, collect paths
    const paths = [];
    for (const file of files) {
      const p = await uploadFile(file);
      if (p) paths.push(p);
    }

    // Type the paths into the terminal, space-separated
    if (paths.length > 0) {
      session.ws.send(paths.map(shellEscape).join(' '));
    }
  });
}
