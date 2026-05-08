import { createUndoStore } from './storage.js';
import { initSAM2 } from './sam2.js';

const imageCanvas = document.getElementById('image');
const overlayCanvas = document.getElementById('overlay');
const stage = document.getElementById('stage');
const dropHint = document.getElementById('drop-hint');
const statusEl = document.getElementById('status');
const toast = document.getElementById('toast');
const undoBtn = document.getElementById('btn-undo');
const loadBtn = document.getElementById('btn-load');
const pasteBtn = document.getElementById('btn-paste');
const copyBtn = document.getElementById('btn-copy');
const clearPtsBtn = document.getElementById('btn-clear-points');
const applyBtn = document.getElementById('btn-apply');
const modeFgBtn = document.getElementById('mode-fg');
const modeBgBtn = document.getElementById('mode-bg');
const fileInput = document.getElementById('file-input');

const imageCtx = imageCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

let undo = null;
let sam2 = null;
let sam2Ready = false;
let mode = 'fg'; // 'fg' or 'bg'
let points = [];      // [{x, y, label}]  in bitmap-space
let lastMaskCanvas = null;

function setStatus(text) { statusEl.textContent = text; }

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('visible'), 1400);
}

function setMode(next) {
  mode = next;
  modeFgBtn.classList.toggle('active', mode === 'fg');
  modeBgBtn.classList.toggle('active', mode === 'bg');
}

function hasImage() {
  return imageCanvas.width > 0 && imageCanvas.height > 0;
}

function updateButtons() {
  const ready = hasImage();
  copyBtn.disabled = !ready;
  applyBtn.disabled = !ready || !lastMaskCanvas;
  clearPtsBtn.disabled = points.length === 0;
}

function clearOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function drawPoints() {
  for (const p of points) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, Math.max(6, imageCanvas.width / 200), 0, Math.PI * 2);
    overlayCtx.fillStyle = p.label === 1 ? 'rgba(80,220,120,0.95)' : 'rgba(240,80,80,0.95)';
    overlayCtx.fill();
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeStyle = 'rgba(0,0,0,0.6)';
    overlayCtx.stroke();
  }
}

function drawMask(maskCanvas) {
  // Blue translucent overlay where mask is white.
  overlayCtx.save();
  overlayCtx.globalCompositeOperation = 'source-over';
  overlayCtx.globalAlpha = 0.45;
  overlayCtx.fillStyle = '#5aa9ff';
  overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.globalCompositeOperation = 'destination-in';
  overlayCtx.globalAlpha = 1;
  overlayCtx.drawImage(maskCanvas, 0, 0);
  overlayCtx.restore();
  drawPoints();
}

function repaintOverlay() {
  clearOverlay();
  if (lastMaskCanvas) drawMask(lastMaskCanvas);
  else drawPoints();
}

async function pushUndoSnapshot() {
  if (!hasImage() || !undo) return;
  const blob = await new Promise(resolve => imageCanvas.toBlob(resolve, 'image/png'));
  if (blob) await undo.push(blob);
}

async function loadBitmap(bitmap) {
  await pushUndoSnapshot();
  imageCanvas.width = bitmap.width;
  imageCanvas.height = bitmap.height;
  overlayCanvas.width = bitmap.width;
  overlayCanvas.height = bitmap.height;
  imageCtx.drawImage(bitmap, 0, 0);
  points = [];
  lastMaskCanvas = null;
  clearOverlay();
  dropHint.style.display = 'none';
  updateButtons();

  if (sam2Ready) {
    setStatus('Encoding image…');
    try {
      await sam2.setImage(bitmap);
      setStatus('Ready — click in the image to segment.');
    } catch (e) {
      console.error(e);
      setStatus('SAM2 encode failed: ' + e.message);
    }
  }
}

async function loadFromFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const bitmap = await createImageBitmap(file);
  await loadBitmap(bitmap);
}

async function loadFromBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  await loadBitmap(bitmap);
}

// ─── Drag and drop ─────────────────────────────────────────────────────────

['dragenter', 'dragover'].forEach(ev => {
  document.addEventListener(ev, e => {
    e.preventDefault();
    stage.classList.add('drag-over');
  });
});
['dragleave', 'drop'].forEach(ev => {
  document.addEventListener(ev, e => {
    if (ev === 'dragleave' && e.target !== document && e.target !== document.body) return;
    stage.classList.remove('drag-over');
  });
});
document.addEventListener('drop', async e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) await loadFromFile(file);
});

// ─── Paste (Ctrl+V) ────────────────────────────────────────────────────────

window.addEventListener('paste', async e => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) {
        await loadFromBlob(blob);
        return;
      }
    }
  }
});

// ─── Copy (right-click or button) ──────────────────────────────────────────

async function copyCanvasToClipboard() {
  if (!hasImage()) return;
  try {
    const blob = await new Promise(resolve => imageCanvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('Copied to clipboard');
  } catch (e) {
    console.error(e);
    showToast('Copy failed: ' + e.message);
  }
}

stage.addEventListener('contextmenu', e => {
  e.preventDefault();
  copyCanvasToClipboard();
});
copyBtn.addEventListener('click', copyCanvasToClipboard);

// ─── Undo (Ctrl+Z or button) ───────────────────────────────────────────────

async function doUndo() {
  if (!undo) return;
  const blob = await undo.pop();
  if (!blob) {
    showToast('Nothing to undo');
    return;
  }
  const bitmap = await createImageBitmap(blob);
  imageCanvas.width = bitmap.width;
  imageCanvas.height = bitmap.height;
  overlayCanvas.width = bitmap.width;
  overlayCanvas.height = bitmap.height;
  imageCtx.drawImage(bitmap, 0, 0);
  points = [];
  lastMaskCanvas = null;
  clearOverlay();
  dropHint.style.display = 'none';
  updateButtons();
  if (sam2Ready) {
    setStatus('Encoding image…');
    try {
      await sam2.setImage(bitmap);
      setStatus('Ready — click in the image to segment.');
    } catch (e) { setStatus('SAM2 encode failed: ' + e.message); }
  }
}

window.addEventListener('keydown', e => {
  // Only trap Ctrl/Cmd+Z when no input/textarea is focused.
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
  }
});
undoBtn.addEventListener('click', doUndo);

// ─── Load via file picker ──────────────────────────────────────────────────

loadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await loadFromFile(file);
  fileInput.value = '';
});

// ─── Paste button (best-effort: needs clipboard read permission) ──────────

pasteBtn.addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        await loadFromBlob(blob);
        return;
      }
    }
    showToast('No image on the clipboard');
  } catch (e) {
    showToast('Paste needs clipboard permission — try Ctrl+V instead');
  }
});

// ─── SAM2 click prompts ────────────────────────────────────────────────────

modeFgBtn.addEventListener('click', () => setMode('fg'));
modeBgBtn.addEventListener('click', () => setMode('bg'));

clearPtsBtn.addEventListener('click', () => {
  points = [];
  lastMaskCanvas = null;
  clearOverlay();
  updateButtons();
});

stage.addEventListener('click', async e => {
  if (!hasImage()) return;
  if (!sam2Ready) {
    showToast('SAM2 still loading — try again in a moment');
    return;
  }
  // Map the screen click to bitmap-space coordinates.
  const rect = imageCanvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right) return;
  if (e.clientY < rect.top || e.clientY > rect.bottom) return;
  const x = (e.clientX - rect.left) * (imageCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (imageCanvas.height / rect.height);
  points.push({ x, y, label: mode === 'fg' ? 1 : 0 });
  updateButtons();

  setStatus('Running decoder…');
  try {
    const maskCanvas = await sam2.predict(points);
    lastMaskCanvas = maskCanvas;
    repaintOverlay();
    setStatus('Mask updated. Click again to refine, or Apply to crop.');
    updateButtons();
  } catch (err) {
    console.error(err);
    setStatus('Decoder failed: ' + err.message);
  }
});

applyBtn.addEventListener('click', async () => {
  if (!lastMaskCanvas || !hasImage()) return;
  await pushUndoSnapshot();
  // Multiply the image by the mask: keep masked pixels, knock the rest to transparent.
  imageCtx.save();
  imageCtx.globalCompositeOperation = 'destination-in';
  imageCtx.drawImage(lastMaskCanvas, 0, 0);
  imageCtx.restore();
  points = [];
  lastMaskCanvas = null;
  clearOverlay();
  updateButtons();
});

// ─── Init: bridge → tabId → undo store; SAM2 in parallel ──────────────────

function getTabIdFromBridge() {
  return new Promise(resolve => {
    let tries = 0;
    function check() {
      const id = window.deepsteve?.getTabInstanceId?.();
      if (id) return resolve(id);
      if (++tries > 20) return resolve('standalone');  // bridge never appeared
      setTimeout(check, 100);
    }
    check();
  });
}

(async function init() {
  setStatus('Initializing…');
  setMode('fg');
  updateButtons();

  const tabId = await getTabIdFromBridge();
  undo = await createUndoStore(tabId);

  // Kick off SAM2 init in the background so canvas I/O is usable immediately.
  setStatus('Loading SAM2 weights (one-time download)…');
  try {
    sam2 = await initSAM2(p => {
      if (p.stage === 'encoder-fetch' || p.stage === 'decoder-fetch') {
        const which = p.stage === 'encoder-fetch' ? 'encoder' : 'decoder';
        if (p.phase === 'cached') setStatus(`SAM2 ${which}: cached`);
        else if (p.total) setStatus(`SAM2 ${which}: ${(p.loaded / 1e6).toFixed(1)} / ${(p.total / 1e6).toFixed(1)} MB`);
        else if (p.loaded) setStatus(`SAM2 ${which}: ${(p.loaded / 1e6).toFixed(1)} MB`);
      } else if (p.stage === 'encoder-init') setStatus('SAM2: initializing encoder…');
      else if (p.stage === 'decoder-init') setStatus('SAM2: initializing decoder…');
      else if (p.stage === 'ready') setStatus('SAM2 ready — drop or paste an image to begin.');
    });
    sam2Ready = true;
    if (hasImage()) {
      setStatus('Encoding image…');
      await sam2.setImage(await createImageBitmap(imageCanvas));
      setStatus('Ready — click in the image to segment.');
    } else {
      setStatus('SAM2 ready — drop or paste an image to begin.');
    }
  } catch (e) {
    console.error('[Steveonardo] SAM2 init failed:', e);
    setStatus('SAM2 unavailable: ' + describeError(e) + ' (canvas editing still works)');
  }
})();

function describeError(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.name) return e.name;
  try { return JSON.stringify(e); } catch { return String(e); }
}
