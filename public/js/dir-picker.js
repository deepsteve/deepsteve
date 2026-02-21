/**
 * Directory picker modal for selecting working directory
 */

import { SessionStore } from './session-store.js';

async function fetchDirs(path) {
  try {
    const r = await fetch('/api/dirs?path=' + encodeURIComponent(path));
    return await r.json();
  } catch {
    return { dirs: [] };
  }
}

async function fetchHome() {
  try {
    const r = await fetch('/api/home');
    return (await r.json()).home;
  } catch {
    return '/Users';
  }
}

export function showDirectoryPicker() {
  return new Promise(async (resolve) => {
    const home = await fetchHome();
    const defaultPath = SessionStore.getLastCwd() || home;
    const alwaysUse = SessionStore.getAlwaysUse();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>Select working directory</h2>
        <div class="path-wrap">
          <input type="text" id="cwd-input" value="${defaultPath}">
          <button class="path-up" id="up-btn">&#8593;</button>
          <button class="new-folder" id="mkdir-btn">+</button>
        </div>
        <div class="dir-tree" id="dir-tree"></div>
        <label>
          <input type="checkbox" id="always-use" ${alwaysUse ? 'checked' : ''}>
          Always use this directory
        </label>
        <div class="modal-buttons">
          <button class="btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn-primary" id="start-btn">Start</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#cwd-input');
    const checkbox = overlay.querySelector('#always-use');
    const tree = overlay.querySelector('#dir-tree');
    const upBtn = overlay.querySelector('#up-btn');
    const mkdirBtn = overlay.querySelector('#mkdir-btn');

    async function refreshTree() {
      const r = await fetchDirs(input.value + '/');
      if (!r.dirs.length) {
        tree.innerHTML = '<div class="dir-empty">No subdirectories</div>';
      } else {
        tree.innerHTML = r.dirs.map(d =>
          `<div class="dir-item" data-path="${d}">
            <span class="dir-icon">&#128193;</span>${d.split('/').pop()}
          </div>`
        ).join('');

        tree.querySelectorAll('.dir-item').forEach(el => {
          el.onclick = () => {
            input.value = el.dataset.path;
            refreshTree();
          };
          el.ondblclick = () => {
            input.value = el.dataset.path;
            submit();
          };
        });
      }
    }

    function goUp() {
      const parts = input.value.split('/');
      if (parts.length > 1) {
        parts.pop();
        input.value = parts.join('/') || '/';
        refreshTree();
      }
    }

    upBtn.onclick = goUp;

    mkdirBtn.onclick = async () => {
      const name = prompt('New folder name:');
      if (!name) return;
      const newPath = input.value + '/' + name;
      try {
        const res = await fetch('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: newPath })
        });
        if (res.ok) {
          input.value = newPath;
          refreshTree();
        } else {
          const err = await res.json();
          alert('Failed: ' + err.error);
        }
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    };

    let debounce;
    input.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(refreshTree, 300);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') cancel();
    };

    function submit() {
      const cwd = input.value.trim() || home;
      SessionStore.setLastCwd(cwd);
      SessionStore.setAlwaysUse(checkbox.checked);
      overlay.remove();
      resolve(cwd);
    }

    function cancel() {
      overlay.remove();
      resolve(null);
    }

    overlay.querySelector('#start-btn').onclick = submit;
    overlay.querySelector('#cancel-btn').onclick = cancel;
    overlay.onclick = (e) => { if (e.target === overlay) cancel(); };

    refreshTree();
  });
}
