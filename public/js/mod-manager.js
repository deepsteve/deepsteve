/**
 * Mod system for deepsteve — loads alternative visual views in iframes
 * while still connecting to real PTY sessions via a bridge API.
 */

const STORAGE_KEY = 'deepsteve-active-mod';

let activeMod = null;       // { id, name, description, entry }
let iframe = null;
let modContainer = null;
let backBtn = null;
let modsBtn = null;
let hooks = null;            // { getSessions, focusSession, createSession, killSession }
let sessionCallbacks = [];   // subscribers from onSessionsChanged
let modViewVisible = false;

/**
 * Initialize the mod system — creates DOM elements, checks for persisted mod.
 */
function init(appHooks) {
  hooks = appHooks;

  // Create mod container (sibling of #terminals)
  modContainer = document.createElement('div');
  modContainer.id = 'mod-container';
  const terminals = document.getElementById('terminals');
  terminals.parentNode.insertBefore(modContainer, terminals.nextSibling);

  // Create back button (in #tabs, after layout-toggle)
  backBtn = document.createElement('button');
  backBtn.className = 'mod-back-btn';
  backBtn.style.display = 'none';
  backBtn.addEventListener('click', () => showModView());
  const layoutToggle = document.getElementById('layout-toggle');
  layoutToggle.parentNode.insertBefore(backBtn, layoutToggle.nextSibling);
}

/**
 * Fetch available mods from server and create the Mods toggle button.
 * If a mod was previously active (localStorage), auto-activate it.
 */
async function loadAvailableMods() {
  let mods = [];
  try {
    const res = await fetch('/api/mods');
    const data = await res.json();
    mods = data.mods || [];
  } catch { return; }

  if (mods.length === 0) return;

  // Create Mods button (after wand button)
  modsBtn = document.createElement('button');
  modsBtn.id = 'mods-btn';
  modsBtn.textContent = 'Mods';
  modsBtn.title = 'Toggle mod view';
  const wandBtn = document.getElementById('wand-btn');
  wandBtn.parentNode.insertBefore(modsBtn, wandBtn.nextSibling);

  modsBtn.addEventListener('click', () => {
    if (activeMod) {
      deactivateMod();
    } else if (mods.length === 1) {
      activateMod(mods[0]);
    } else {
      showModPicker(mods);
    }
  });

  // Auto-activate persisted mod
  const savedId = localStorage.getItem(STORAGE_KEY);
  if (savedId) {
    const mod = mods.find(m => m.id === savedId);
    if (mod) activateMod(mod);
  }
}

/**
 * Show a picker modal when multiple mods are available.
 */
function showModPicker(mods) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width: 360px;">
      <h2>Select a Mod</h2>
      <div class="mod-list">
        ${mods.map(m => `
          <div class="mod-item" data-id="${m.id}">
            <div class="mod-name">${m.name}</div>
            <div class="mod-desc">${m.description || ''}</div>
          </div>
        `).join('')}
      </div>
      <div class="modal-buttons">
        <button class="btn-secondary" id="mod-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.mod-item').forEach(item => {
    item.addEventListener('click', () => {
      const mod = mods.find(m => m.id === item.dataset.id);
      overlay.remove();
      if (mod) activateMod(mod);
    });
  });

  overlay.querySelector('#mod-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

/**
 * Activate a mod — create iframe, inject bridge, show mod view.
 */
function activateMod(mod) {
  activeMod = mod;
  localStorage.setItem(STORAGE_KEY, mod.id);

  // Update button appearance
  if (modsBtn) {
    modsBtn.classList.add('active');
    modsBtn.textContent = mod.name;
  }

  // Create iframe
  const entry = mod.entry || 'index.html';
  iframe = document.createElement('iframe');
  iframe.src = `/mods/${mod.id}/${entry}`;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  modContainer.appendChild(iframe);

  // Wait for iframe to load, then inject bridge API
  iframe.addEventListener('load', () => {
    _injectBridgeAPI(iframe);
  });

  showModView();
}

/**
 * Deactivate the current mod — destroy iframe, return to terminal view.
 */
function deactivateMod() {
  activeMod = null;
  localStorage.removeItem(STORAGE_KEY);
  sessionCallbacks = [];

  if (iframe) {
    iframe.remove();
    iframe = null;
  }

  if (modsBtn) {
    modsBtn.classList.remove('active');
    modsBtn.textContent = 'Mods';
  }

  // Show terminals, hide mod container and back button
  document.getElementById('terminals').style.display = '';
  modContainer.style.display = 'none';
  backBtn.style.display = 'none';
  modViewVisible = false;
}

/**
 * Show the mod view (hide terminals, show mod container).
 */
function showModView() {
  if (!activeMod) return;
  document.getElementById('terminals').style.display = 'none';
  modContainer.style.display = 'flex';
  backBtn.style.display = 'none';
  modViewVisible = true;
}

/**
 * Switch from mod view to terminal view for a specific session.
 */
function showTerminalForSession(id) {
  modContainer.style.display = 'none';
  document.getElementById('terminals').style.display = '';
  modViewVisible = false;

  // Show back button with mod name
  if (activeMod) {
    backBtn.textContent = `\u2190 ${activeMod.name}`;
    backBtn.style.display = '';
  }

  hooks.focusSession(id);
}

/**
 * Notify the active mod that sessions have changed.
 */
function notifySessionsChanged(sessionList) {
  for (const cb of sessionCallbacks) {
    try { cb(sessionList); } catch (e) { console.error('Mod callback error:', e); }
  }
}

/**
 * Check if the mod view is currently visible.
 */
function isModViewVisible() {
  return modViewVisible;
}

/**
 * Check if a mod is currently active.
 */
function isModActive() {
  return activeMod !== null;
}

/**
 * Inject the deepsteve bridge API into the mod iframe.
 */
function _injectBridgeAPI(iframeEl) {
  try {
    iframeEl.contentWindow.deepsteve = {
      getSessions() {
        return hooks.getSessions();
      },
      focusSession(id) {
        showTerminalForSession(id);
      },
      onSessionsChanged(cb) {
        sessionCallbacks.push(cb);
        // Fire immediately with current state
        try { cb(hooks.getSessions()); } catch {}
        // Return unsubscribe function
        return () => {
          sessionCallbacks = sessionCallbacks.filter(fn => fn !== cb);
        };
      },
      createSession(cwd) {
        hooks.createSession(cwd);
      },
      killSession(id) {
        hooks.killSession(id);
      }
    };
  } catch (e) {
    console.error('Failed to inject bridge API:', e);
  }
}

export const ModManager = {
  init,
  loadAvailableMods,
  activateMod,
  deactivateMod,
  showModView,
  showTerminalForSession,
  notifySessionsChanged,
  isModViewVisible,
  isModActive,
};
