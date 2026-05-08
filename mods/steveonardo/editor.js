import { createUndoStore } from './storage.js';
import { initSAM2, decodeOrtError } from './sam2.js';

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
const newBtn = document.getElementById('btn-new');
const saveBtn = document.getElementById('btn-save');
const clearPtsBtn = document.getElementById('btn-clear-points');
const applyBtn = document.getElementById('btn-apply');
const deleteBtn = document.getElementById('btn-delete');
const invertBtn = document.getElementById('btn-invert');
const copySelBtn = document.getElementById('btn-copy-sel');
const modeFgBtn = document.getElementById('mode-fg');
const modeBgBtn = document.getElementById('mode-bg');
const modeBoxBtn = document.getElementById('mode-box');
const fileInput = document.getElementById('file-input');

const imageCtx = imageCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

let undo = null;
let sam2 = null;
let sam2Ready = false;
let mode = 'fg'; // 'fg' | 'bg' | 'box'
let points = [];      // [{x, y, label}]  in bitmap-space
let box = null;       // { x1, y1, x2, y2 } in bitmap-space, or null
let dragBox = null;   // in-progress drag, same shape as `box`
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
  modeBoxBtn.classList.toggle('active', mode === 'box');
  stage.style.cursor = mode === 'box' ? 'crosshair' : '';
}

function hasImage() {
  return imageCanvas.width > 0 && imageCanvas.height > 0;
}

// Size the canvas-wrap so the bitmap object-fits inside the stage.
// Both canvases use width/height: 100% on the wrap, so as long as the wrap
// has the right pixel size everything else falls out automatically.
function fitCanvasToStage() {
  if (!hasImage()) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw === 0 || sh === 0) return;
  const ratio = Math.min(sw / imageCanvas.width, sh / imageCanvas.height);
  const w = Math.max(1, Math.floor(imageCanvas.width * ratio));
  const h = Math.max(1, Math.floor(imageCanvas.height * ratio));
  const wrap = imageCanvas.parentElement;
  wrap.style.width = w + 'px';
  wrap.style.height = h + 'px';
}

window.addEventListener('resize', fitCanvasToStage);

function updateButtons() {
  const ready = hasImage();
  const haveMask = !!lastMaskCanvas;
  copyBtn.disabled = !ready;
  saveBtn.disabled = !ready;
  newBtn.disabled = !ready;
  applyBtn.disabled = !ready || !haveMask;
  deleteBtn.disabled = !ready || !haveMask;
  invertBtn.disabled = !ready || !haveMask;
  copySelBtn.disabled = !ready || !haveMask;
  clearPtsBtn.disabled = points.length === 0 && !box;
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

function drawBox(b) {
  if (!b) return;
  const x = Math.min(b.x1, b.x2);
  const y = Math.min(b.y1, b.y2);
  const w = Math.abs(b.x2 - b.x1);
  const h = Math.abs(b.y2 - b.y1);
  overlayCtx.save();
  overlayCtx.lineWidth = Math.max(2, imageCanvas.width / 400);
  overlayCtx.strokeStyle = 'rgba(255, 200, 60, 0.95)';
  overlayCtx.setLineDash([Math.max(6, imageCanvas.width / 120), Math.max(4, imageCanvas.width / 180)]);
  overlayCtx.strokeRect(x, y, w, h);
  overlayCtx.restore();
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
  drawBox(dragBox || box);
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
  box = null;
  dragBox = null;
  lastMaskCanvas = null;
  clearOverlay();
  dropHint.style.display = 'none';
  fitCanvasToStage();
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

// If the parent page has focus, Ctrl/Cmd+V is dispatched there and never reaches
// this iframe. Reclaim focus when the pointer enters the editor so the user
// doesn't need a priming click.
document.documentElement.addEventListener('mouseenter', () => {
  if (!document.hasFocus()) window.focus();
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
  box = null;
  dragBox = null;
  lastMaskCanvas = null;
  clearOverlay();
  dropHint.style.display = 'none';
  fitCanvasToStage();
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
  // Don't intercept while typing in an input.
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
    return;
  }
  // Backspace / Delete → erase the current selection (matches Photoshop).
  if ((e.key === 'Backspace' || e.key === 'Delete') && lastMaskCanvas) {
    e.preventDefault();
    applyMaskWithOp('destination-out');
    return;
  }
  // Ctrl/Cmd+S → save as PNG.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveCanvasOrSelection();
  }
});
undoBtn.addEventListener('click', doUndo);

// ─── New (reset canvas) ───────────────────────────────────────────────────

newBtn.addEventListener('click', async () => {
  if (!hasImage()) return;
  await pushUndoSnapshot();
  // Setting width clears the bitmap; collapse the wrap to 0×0 so the
  // drop-hint reappears in the centered stage.
  imageCanvas.width = 0;
  imageCanvas.height = 0;
  overlayCanvas.width = 0;
  overlayCanvas.height = 0;
  const wrap = imageCanvas.parentElement;
  wrap.style.width = '';
  wrap.style.height = '';
  points = [];
  box = null;
  dragBox = null;
  lastMaskCanvas = null;
  if (sam2) sam2.reset();
  dropHint.style.display = '';
  setStatus('Drop or paste an image to begin.');
  updateButtons();
});

// ─── Save (PNG download — selection if active, else full canvas) ──────────

async function saveCanvasOrSelection() {
  if (!hasImage()) return;
  const out = document.createElement('canvas');
  out.width = imageCanvas.width;
  out.height = imageCanvas.height;
  const octx = out.getContext('2d');
  octx.drawImage(imageCanvas, 0, 0);
  let suffix = '';
  if (lastMaskCanvas) {
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(lastMaskCanvas, 0, 0);
    suffix = '-selection';
  }
  const blob = await new Promise(r => out.toBlob(r, 'image/png'));
  if (!blob) { showToast('Save failed'); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `steveonardo-${ts}${suffix}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast(suffix ? 'Selection saved' : 'Image saved');
}
saveBtn.addEventListener('click', saveCanvasOrSelection);

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

// ─── SAM2 click + box prompts ──────────────────────────────────────────────

modeFgBtn.addEventListener('click', () => setMode('fg'));
modeBgBtn.addEventListener('click', () => setMode('bg'));
modeBoxBtn.addEventListener('click', () => setMode('box'));

clearPtsBtn.addEventListener('click', () => {
  points = [];
  box = null;
  dragBox = null;
  lastMaskCanvas = null;
  clearOverlay();
  updateButtons();
});

// Translate a pointer event into bitmap-space coordinates on the image canvas,
// or null if the event is outside the image.
function eventToBitmap(e) {
  const rect = imageCanvas.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right) return null;
  if (e.clientY < rect.top || e.clientY > rect.bottom) return null;
  return {
    x: (e.clientX - rect.left) * (imageCanvas.width / rect.width),
    y: (e.clientY - rect.top) * (imageCanvas.height / rect.height),
  };
}

async function runDecoder() {
  if (points.length === 0 && !box) {
    lastMaskCanvas = null;
    repaintOverlay();
    updateButtons();
    return;
  }
  setStatus('Running decoder…');
  try {
    const maskCanvas = await sam2.predict(points, box);
    lastMaskCanvas = maskCanvas;
    repaintOverlay();
    setStatus('Mask updated. Refine with more clicks, or Apply to crop.');
    updateButtons();
  } catch (err) {
    console.error(err);
    setStatus('Decoder failed: ' + err.message);
  }
}

// Box mode: drag a rectangle. Other modes: single click drops a point.
let dragMode = null;  // 'box' while a box drag is in flight, else null

stage.addEventListener('mousedown', e => {
  if (!hasImage() || !sam2Ready) return;
  if (mode !== 'box') return;
  if (e.button !== 0) return;
  const p = eventToBitmap(e);
  if (!p) return;
  e.preventDefault();
  dragMode = 'box';
  dragBox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  repaintOverlay();
});

stage.addEventListener('mousemove', e => {
  if (dragMode !== 'box') return;
  const rect = imageCanvas.getBoundingClientRect();
  // Allow drag past the edges; clamp to bitmap bounds.
  const x = Math.min(Math.max((e.clientX - rect.left) * (imageCanvas.width / rect.width), 0), imageCanvas.width);
  const y = Math.min(Math.max((e.clientY - rect.top) * (imageCanvas.height / rect.height), 0), imageCanvas.height);
  dragBox.x2 = x;
  dragBox.y2 = y;
  repaintOverlay();
});

window.addEventListener('mouseup', async e => {
  if (dragMode !== 'box') return;
  dragMode = null;
  const w = Math.abs(dragBox.x2 - dragBox.x1);
  const h = Math.abs(dragBox.y2 - dragBox.y1);
  // Treat tiny drags as accidental — discard rather than confuse the model.
  if (w < 4 || h < 4) {
    dragBox = null;
    repaintOverlay();
    return;
  }
  box = {
    x1: Math.min(dragBox.x1, dragBox.x2),
    y1: Math.min(dragBox.y1, dragBox.y2),
    x2: Math.max(dragBox.x1, dragBox.x2),
    y2: Math.max(dragBox.y1, dragBox.y2),
  };
  dragBox = null;
  updateButtons();
  await runDecoder();
});

stage.addEventListener('click', async e => {
  if (!hasImage()) return;
  if (!sam2Ready) {
    showToast('SAM2 still loading — try again in a moment');
    return;
  }
  // Box mode swallows clicks via mousedown/mouseup; ignore here.
  if (mode === 'box') return;
  const p = eventToBitmap(e);
  if (!p) return;
  points.push({ x: p.x, y: p.y, label: mode === 'fg' ? 1 : 0 });
  // Repaint immediately so the dot appears the moment you click — predict
  // takes ~100ms in proxy mode and the latency was visible.
  repaintOverlay();
  updateButtons();
  await runDecoder();
});

// Compositing helper: apply the current mask to imageCanvas with the given
// composite op, snapshot for undo, then clear the selection state.
async function applyMaskWithOp(op) {
  if (!lastMaskCanvas || !hasImage()) return;
  await pushUndoSnapshot();
  imageCtx.save();
  imageCtx.globalCompositeOperation = op;
  imageCtx.drawImage(lastMaskCanvas, 0, 0);
  imageCtx.restore();
  points = [];
  box = null;
  dragBox = null;
  lastMaskCanvas = null;
  clearOverlay();
  updateButtons();
}

// Keep the selection: erase everything outside the mask.
applyBtn.addEventListener('click', () => applyMaskWithOp('destination-in'));

// Delete the selection: erase pixels inside the mask, keep the rest.
deleteBtn.addEventListener('click', () => applyMaskWithOp('destination-out'));

// Invert the mask in place — flip the alpha channel of lastMaskCanvas so
// "selected" and "not selected" swap. Re-run repaintOverlay to reflect it.
invertBtn.addEventListener('click', () => {
  if (!lastMaskCanvas) return;
  const w = lastMaskCanvas.width, h = lastMaskCanvas.height;
  const ctx = lastMaskCanvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = 255 - d[i + 3];
  ctx.putImageData(img, 0, 0);
  repaintOverlay();
});

// Copy just the selection to the clipboard: render the masked image into a
// scratch canvas at the same size, with everything outside the mask
// transparent, then write that PNG.
copySelBtn.addEventListener('click', async () => {
  if (!lastMaskCanvas || !hasImage()) return;
  try {
    const out = document.createElement('canvas');
    out.width = imageCanvas.width;
    out.height = imageCanvas.height;
    const octx = out.getContext('2d');
    octx.drawImage(imageCanvas, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(lastMaskCanvas, 0, 0);
    const blob = await new Promise(r => out.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('Selection copied');
  } catch (e) {
    console.error(e);
    showToast('Copy failed: ' + e.message);
  }
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
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  const ortMsg = decodeOrtError(e);
  if (ortMsg) return ortMsg;
  // ORT-Web throws raw heap pointers we can't decode without internal access;
  // tell the user where the real error lives so they can act on it.
  if (typeof e === 'number') return 'WASM init failed (see browser console for details)';
  if (typeof e?.message === 'number') return 'WASM init failed (see browser console for details)';
  if (e.message) return String(e.message);
  if (e.name) return e.name;
  try { return JSON.stringify(e); } catch { return String(e); }
}
