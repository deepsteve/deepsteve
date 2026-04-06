import * as THREE from 'three';
import { ROBOT_COLORS, robotState, state, MODE_FIRST } from './config.js';
import { TERM_X, TERM_Z } from './environment.js';

// ── Terminal station state ──────────────────────────────────────────────────

let termStationMesh = null;
let termStationTexture = null;
let termStationCanvas = null;
let termStationSessionId = null;
let termMirrorTerm = null;
let termMirrorCanvas = null;
let termMirrorTexture = null;
let _mirrorUnsub = null;
let _lastMirrorRefresh = 0;

let terminalPanelEl = null;
let originalTermParent = null;
let originalTermNext = null;

// VR keyboard
const KEYBOARD_RANGE = 3.5;
let vrKeyboardActive = false;
let vrKeyboardEl = null;
let vrKeyboardPrevValue = '';

const termLog = [];

// ── Init ────────────────────────────────────────────────────────────────────

export function initTerminal(termStation) {
  termStationMesh = termStation.mesh;
  termStationTexture = termStation.texture;
  termStationCanvas = termStation.canvas;

  ensureMirrorTerminal();
  if (termMirrorCanvas) {
    termMirrorTexture = new THREE.CanvasTexture(termMirrorCanvas);
    termMirrorTexture.minFilter = THREE.LinearFilter;
  }

  initVRKeyboard();
}

// ── Terminal mirror ─────────────────────────────────────────────────────────

function ensureMirrorTerminal() {
  if (termMirrorTerm) return;
  const parentDoc = parent.document;
  const Terminal = parent.window.Terminal;
  const CanvasAddon = parent.window.CanvasAddon?.CanvasAddon;
  if (!Terminal || !CanvasAddon) return;

  let container = parentDoc.getElementById('robot-term-mirror');
  if (!container) {
    container = parentDoc.createElement('div');
    container.id = 'robot-term-mirror';
    container.style.cssText = 'position:fixed;left:0;top:0;width:1600px;height:800px;overflow:hidden;z-index:-1;pointer-events:none;opacity:0.01;';
    parentDoc.body.appendChild(container);
  }
  termMirrorTerm = new Terminal({ fontSize: 14, cols: 80, rows: 24 });
  termMirrorTerm.open(container);
  termMirrorTerm.loadAddon(new CanvasAddon());
  termMirrorCanvas = container.querySelector('canvas');
}

function _drawTermLog() {
  if (!termStationCanvas || !termStationTexture) return;
  termStationTexture.image = termStationCanvas;
  const ctx = termStationCanvas.getContext('2d');
  ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0, 0, termStationCanvas.width, termStationCanvas.height);
  ctx.textAlign = 'left';
  const pad = 12, lineHeight = 22;
  for (let i = 0; i < termLog.length; i++) {
    ctx.fillStyle = termLog[i].color;
    ctx.font = '16px monospace';
    ctx.fillText(termLog[i].msg, pad, pad + (i + 1) * lineHeight);
  }
  termStationTexture.needsUpdate = true;
}

function termLogMsg(msg, color = '#00ddff') {
  termLog.push({ msg, color, t: Date.now() });
  if (termLog.length > 20) termLog.shift();
  _drawTermLog();
}

function showTermPlaceholder(msg, color = '#00ddff') {
  termLog.length = 0;
  if (!termStationCanvas || !termStationMesh) return;
  const ctx = termStationCanvas.getContext('2d');
  ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0, 0, termStationCanvas.width, termStationCanvas.height);
  ctx.fillStyle = color; ctx.font = 'bold 24px monospace'; ctx.textAlign = 'center';
  ctx.fillText(msg, termStationCanvas.width / 2, termStationCanvas.height / 2);
  termStationMesh.material.map = termStationTexture;
  termStationTexture.needsUpdate = true;
  termStationMesh.material.needsUpdate = true;
}

export function updateTerminalStation(sessionId) {
  termLog.length = 0;
  if (_mirrorUnsub) { _mirrorUnsub(); _mirrorUnsub = null; }
  termStationSessionId = sessionId;

  if (!sessionId) { showTermPlaceholder('SPACE STATION TERMINAL'); return; }

  try {
    const bridge = parent.window.__deepsteve;
    if (!bridge || typeof bridge.getTerminal !== 'function') {
      termLogMsg('ERROR: bridge missing — refresh page', '#ff4444'); return;
    }
    const srcTerm = bridge.getTerminal(sessionId);
    if (!srcTerm) { termLogMsg('ERROR: no terminal for ' + sessionId, '#ff4444'); return; }

    ensureMirrorTerminal();
    if (!termMirrorCanvas) { termLogMsg('ERROR: mirror canvas missing', '#ff4444'); return; }

    if (termMirrorTerm.cols !== srcTerm.cols || termMirrorTerm.rows !== srcTerm.rows) {
      termMirrorTerm.resize(srcTerm.cols, srcTerm.rows);
      const newCanvas = termMirrorTerm.element?.closest('#robot-term-mirror')?.querySelector('canvas');
      if (newCanvas && newCanvas !== termMirrorCanvas) {
        termMirrorCanvas = newCanvas;
        termMirrorTexture = new THREE.CanvasTexture(termMirrorCanvas);
        termMirrorTexture.minFilter = THREE.LinearFilter;
      }
    }

    termMirrorTerm.reset();
    const buf = srcTerm.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    if (lines.length) termMirrorTerm.write(lines.join('\r\n'));
    setTimeout(() => { if (termMirrorTerm) termMirrorTerm.refresh(0, termMirrorTerm.rows - 1); }, 150);

    _mirrorUnsub = bridge.onSessionData(sessionId, (data) => termMirrorTerm.write(data));

    if (!termMirrorTexture && termMirrorCanvas) {
      termMirrorTexture = new THREE.CanvasTexture(termMirrorCanvas);
      termMirrorTexture.minFilter = THREE.LinearFilter;
    }
    if (termMirrorTexture) {
      termStationMesh.material.map = termMirrorTexture;
      termStationMesh.material.needsUpdate = true;
    }
  } catch (e) {
    termLogMsg('EXCEPTION: ' + e.message, '#ff4444');
  }
}

export function updateTerminalTick(renderer) {
  if (termMirrorTexture && termStationSessionId) termMirrorTexture.needsUpdate = true;
  if (termMirrorTerm && termStationSessionId) {
    const now = performance.now();
    if (now - _lastMirrorRefresh > 250) {
      _lastMirrorRefresh = now;
      termMirrorTerm.refresh(0, termMirrorTerm.rows - 1);
    }
  }
  updateVRKeyboard(renderer);
}

// ── Terminal panel (real xterm.js reparented) ───────────────────────────────

export function showTerminal(sessionId) {
  hideTerminal();
  const parentDoc = parent.document;
  const termContainer = parentDoc.getElementById('term-' + sessionId);
  if (!termContainer) return;

  originalTermParent = termContainer.parentNode;
  originalTermNext = termContainer.nextSibling;

  terminalPanelEl = parentDoc.createElement('div');
  terminalPanelEl.id = 'robot-terminal-panel';
  terminalPanelEl.style.cssText = 'position:fixed;bottom:30px;right:30px;width:42%;height:55%;z-index:999;perspective:800px;pointer-events:none;';

  const screen = parentDoc.createElement('div');
  screen.style.cssText = `width:100%;height:100%;transform:rotateY(-8deg) rotateX(2deg);transform-origin:right center;
    border-radius:8px;overflow:hidden;box-shadow:0 0 30px rgba(0,200,255,0.15),0 0 60px rgba(0,200,255,0.05),inset 0 0 1px rgba(255,255,255,0.1);
    border:3px solid #333;display:flex;flex-direction:column;background:#0a0a1a;pointer-events:auto;`;
  terminalPanelEl.appendChild(screen);

  // Header
  const header = parentDoc.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 10px;background:#0d1120;border-bottom:1px solid #333;font-family:"Press Start 2P",monospace;flex-shrink:0;';
  const session = state.sessions.find(s => s.id === sessionId);
  const color = robotState[sessionId] ? ROBOT_COLORS[robotState[sessionId].colorIdx % ROBOT_COLORS.length] : ROBOT_COLORS[0];

  const nameRow = parentDoc.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const dot = parentDoc.createElement('div');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color.hex};box-shadow:0 0 6px ${color.hex};`;
  nameRow.appendChild(dot);
  const nameSpan = parentDoc.createElement('span');
  nameSpan.textContent = session ? session.name : sessionId;
  nameSpan.style.cssText = 'font-size:8px;color:#aaa;';
  nameRow.appendChild(nameSpan);
  header.appendChild(nameRow);

  const fullBtn = parentDoc.createElement('button');
  fullBtn.textContent = '\u2922'; fullBtn.title = 'Open terminal fullscreen';
  fullBtn.style.cssText = 'background:transparent;border:1px solid #444;border-radius:3px;color:#8b949e;font-size:12px;padding:2px 6px;cursor:pointer;line-height:1;';
  fullBtn.addEventListener('click', () => { if (window.deepsteve) window.deepsteve.focusSession(sessionId); });
  header.appendChild(fullBtn);
  screen.appendChild(header);

  const termWrapper = parentDoc.createElement('div');
  termWrapper.style.cssText = 'flex:1;overflow:hidden;';
  screen.appendChild(termWrapper);
  termContainer.style.display = ''; termContainer.classList.add('active');
  termWrapper.appendChild(termContainer);
  parentDoc.body.appendChild(terminalPanelEl);

  requestAnimationFrame(() => { if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(sessionId); });
}

export function hideTerminal() {
  if (!terminalPanelEl) return;
  const termContainer = terminalPanelEl.querySelector('.terminal-container');
  if (termContainer && originalTermParent) {
    termContainer.classList.remove('active');
    if (originalTermNext) originalTermParent.insertBefore(termContainer, originalTermNext);
    else originalTermParent.appendChild(termContainer);
    const id = termContainer.id.replace('term-', '');
    requestAnimationFrame(() => { if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(id); });
  }
  terminalPanelEl.remove();
  terminalPanelEl = null; originalTermParent = null; originalTermNext = null;
}

export function isTerminalPanelVisible() { return !!terminalPanelEl; }

// ── VR Keyboard ─────────────────────────────────────────────────────────────

function initVRKeyboard() {
  const parentDoc = parent.document;
  const existing = parentDoc.getElementById('vr-keyboard-input-ss');
  if (existing) existing.remove();

  vrKeyboardEl = parentDoc.createElement('textarea');
  vrKeyboardEl.id = 'vr-keyboard-input-ss';
  vrKeyboardEl.autocomplete = 'off'; vrKeyboardEl.autocapitalize = 'off'; vrKeyboardEl.spellcheck = false;
  vrKeyboardEl.style.cssText = `position:fixed;bottom:10px;left:50%;transform:translateX(-50%);width:300px;height:40px;font-size:16px;z-index:9999;
    background:#0a0a1a;color:#00ddff;border:2px solid #00ddff;border-radius:6px;padding:8px;opacity:0;pointer-events:none;transition:opacity 0.3s;`;
  vrKeyboardEl.placeholder = 'Type here...';
  parentDoc.body.appendChild(vrKeyboardEl);

  vrKeyboardEl.addEventListener('input', () => {
    if (!termStationSessionId) return;
    const current = vrKeyboardEl.value;
    if (current === vrKeyboardPrevValue) return;

    if (current.startsWith(vrKeyboardPrevValue)) {
      let newChars = current.slice(vrKeyboardPrevValue.length);
      if (newChars) {
        newChars = newChars.replace(/\n/g, '\r');
        try { parent.window.__deepsteve.writeSession(termStationSessionId, newChars); } catch (e) {}
        if (current.includes('\n')) { vrKeyboardEl.value = current.replace(/\n/g, ''); vrKeyboardPrevValue = vrKeyboardEl.value; return; }
      }
    } else if (current.length < vrKeyboardPrevValue.length) {
      for (let i = 0; i < vrKeyboardPrevValue.length - current.length; i++)
        try { parent.window.__deepsteve.writeSession(termStationSessionId, '\x7f'); } catch (e) {}
    } else {
      for (let i = 0; i < vrKeyboardPrevValue.length; i++)
        try { parent.window.__deepsteve.writeSession(termStationSessionId, '\x7f'); } catch (e) {}
      if (current) try { parent.window.__deepsteve.writeSession(termStationSessionId, current.replace(/\n/g, '\r')); } catch (e) {}
    }
    vrKeyboardEl.value = current.replace(/\n/g, '');
    vrKeyboardPrevValue = vrKeyboardEl.value;
  });

  vrKeyboardEl.addEventListener('keydown', (e) => {
    if (!termStationSessionId || e.key !== 'Enter') return;
    e.preventDefault();
    try { parent.window.__deepsteve.writeSession(termStationSessionId, '\r'); } catch (e2) {}
    vrKeyboardEl.value = ''; vrKeyboardPrevValue = '';
  });
}

function updateVRKeyboard(renderer) {
  if (!renderer.xr.isPresenting || !termStationSessionId || state.viewMode !== MODE_FIRST) {
    if (vrKeyboardActive) {
      vrKeyboardEl.blur(); vrKeyboardEl.style.opacity = '0'; vrKeyboardEl.style.pointerEvents = 'none';
      vrKeyboardActive = false;
    }
    return;
  }

  const playerPos = state.followId && robotState[state.followId] ? robotState[state.followId].pos : null;
  if (!playerPos) return;

  const dx = playerPos.x - TERM_X, dz = playerPos.z - TERM_Z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist < KEYBOARD_RANGE && !vrKeyboardActive) {
    vrKeyboardEl.style.opacity = '1'; vrKeyboardEl.style.pointerEvents = 'auto';
    vrKeyboardEl.value = ''; vrKeyboardPrevValue = ''; vrKeyboardEl.focus();
    vrKeyboardActive = true;
  } else if (dist >= KEYBOARD_RANGE + 1 && vrKeyboardActive) {
    vrKeyboardEl.blur(); vrKeyboardEl.style.opacity = '0'; vrKeyboardEl.style.pointerEvents = 'none';
    vrKeyboardActive = false;
  }
}
