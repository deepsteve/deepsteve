/**
 * Drag-and-drop file support for terminal sessions.
 *
 * Drops a file into /tmp/deepsteve-drops/ via the server, then types the full
 * path into the terminal — like dropping a file into iTerm.
 */

let getActiveSession = null;
let dragDepth = 0;
let dropZone = null;

function hasFiles(e) {
  return e.dataTransfer && e.dataTransfer.types.includes('Files');
}

function showDropZone() {
  const session = getActiveSession();
  if (!session) return;

  if (!dropZone) {
    dropZone = document.createElement('div');
    dropZone.className = 'file-drop-zone';
    dropZone.innerHTML = '<div class="file-drop-zone-content">Drop files here</div>';
  }

  session.container.appendChild(dropZone);
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

export function initFileDrop({ getActiveSession: getter }) {
  getActiveSession = getter;
  const terminals = document.getElementById('terminals');

  terminals.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) showDropZone();
  });

  terminals.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  terminals.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth--;
    if (dragDepth === 0) hideDropZone();
  });

  terminals.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    hideDropZone();

    const session = getActiveSession();
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
