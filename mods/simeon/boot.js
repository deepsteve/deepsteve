/**
 * Simeon's front end: the SSE cursor, the arrival queue, and the chat console.
 *
 * Rows now arrive genuinely one at a time: the server reads the model's token stream and
 * pushes each row the instant its newline lands, so the pacing you see IS the model writing.
 * The arrival queue is therefore off by default (`rowIntervalMs: 0`) and exists only to
 * smooth a burst — a timer here can no longer be the thing that makes it look live, and if
 * it were set faster than the model it would just add latency.
 *
 * The initial replay is still applied instantly regardless: rows that arrive before the
 * server's `ready` event are a canvas that already exists, and reloading the page should
 * show it, not perform it.
 */

import { parseRow } from './rows.js';
import { createStore } from './store.js';
import { createRenderer } from './render.js';

const $ = (id) => document.getElementById(id);
const canvas = $('sim-canvas');

let settings = { rowIntervalMs: 0, showRawRows: true, model: '' };

// ── store + renderer ────────────────────────────────────────────────────────────────

const renderer = createRenderer(canvas, { onAct: act });
const store = createStore(renderer.handlers);
renderer.setStore(store);

function refreshEmpty() {
  $('sim-empty').hidden = renderer.size > 0;
  $('sim-count').textContent = `${renderer.size} node${renderer.size === 1 ? '' : 's'}`;
}

// ── the arrival queue ───────────────────────────────────────────────────────────────

const queue = [];
let draining = false;

function enqueue(row, { instant } = {}) {
  if (instant || !settings.rowIntervalMs) { applyRow(row); return; }
  queue.push(row);
  if (!draining) drain();
}

function drain() {
  draining = true;
  const next = queue.shift();
  if (next === undefined) { draining = false; return; }
  applyRow(next);
  setTimeout(drain, settings.rowIntervalMs);
}

function applyRow(row) {
  const op = parseRow(row);
  if (op) store.apply(op);
  if (settings.showRawRows) echoRow(row);
  if (op?.op === 'clear') $('sim-rows').textContent = '';
  // Derived from the renderer on every row rather than bookkept, so no path can apply a
  // row and leave the placeholder and the count disagreeing with what is on screen.
  refreshEmpty();
}

function echoRow(row) {
  const rail = $('sim-rows');
  const line = document.createElement('div');
  line.className = 'sim-rowline';
  line.dataset.kind = row.trim()[0] || '';
  line.textContent = row;
  rail.appendChild(line);
  while (rail.childElementCount > 300) rail.firstElementChild.remove();
  rail.parentElement.scrollTop = rail.parentElement.scrollHeight;
}

// ── console ─────────────────────────────────────────────────────────────────────────

function addMessage(role, text) {
  const log = $('sim-log');
  const el = document.createElement('div');
  el.className = 'sim-msg';
  el.dataset.role = role;
  el.textContent = text;
  log.appendChild(el);
  while (log.childElementCount > 200) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function setState(state, label) {
  $('sim-dot').dataset.state = state;
  $('sim-state').textContent = label;
}

async function send() {
  const input = $('sim-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  $('sim-send').disabled = true;
  setState('thinking', 'drawing');
  try {
    const res = await fetch('/api/simeon/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model: settings.model || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addMessage('system', body.error || `Send failed (${res.status})`);
    }
  } catch (e) {
    addMessage('system', `Send failed: ${e.message}`);
  } finally {
    $('sim-send').disabled = false;
  }
}

/** A button on the canvas was pressed. */
async function act(sendText, label) {
  if (!sendText) return;
  try {
    const res = await fetch('/api/simeon/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ send: sendText, label, model: settings.model || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      addMessage('system', body.error || `Action failed (${res.status})`);
    }
  } catch (e) {
    addMessage('system', `Action failed: ${e.message}`);
  }
}

// ── the feed ────────────────────────────────────────────────────────────────────────

let cursor = 0;
let ready = false;   // false while the initial replay is landing — apply those instantly
let source = null;

function connect() {
  if (source) { try { source.close(); } catch {} }
  ready = false;
  source = new EventSource(`/api/simeon/stream?since=${cursor}`);

  source.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    // Seq dedupe, so a reconnect that replays more than we asked for is harmless.
    if (ev.seq && ev.seq <= cursor) return;
    if (ev.seq) cursor = ev.seq;

    switch (ev.kind) {
      case 'row':   enqueue(ev.row, { instant: !ready }); break;
      case 'chat':  addMessage(ev.role, ev.text); break;
      case 'agent':
        if (ev.state === 'thinking') setState('thinking', 'drawing');
        else if (ev.state === 'ready') setState('live', 'ready');
        break;
      case 'reset':
        // The server's ring dropped rows we never saw; what we hold is not reconstructable.
        store.apply({ op: 'clear' });
        $('sim-rows').textContent = '';
        break;
      case 'ready':
        ready = true;
        refreshEmpty();
        break;
      default: break;
    }
  };

  // EventSource retries on its own, but always to the URL it was opened with — which would
  // replay from the original cursor. Reopen with the current one instead.
  source.onerror = () => {
    try { source.close(); } catch {}
    source = null;
    setTimeout(connect, 1500);
  };
}

async function pollStatus() {
  try {
    const s = await (await fetch('/api/simeon/status')).json();
    // There is no agent to be absent any more — a run is either in flight or it is not.
    if (s.running) setState('thinking', 'drawing');
    else setState('live', 'ready');
  } catch {}
}

// ── wiring ──────────────────────────────────────────────────────────────────────────

$('sim-send').addEventListener('click', send);

$('sim-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('sim-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
});

$('sim-reset').addEventListener('click', () => {
  fetch('/api/simeon/reset', { method: 'POST' }).catch(() => {});
});

$('sim-stop').addEventListener('click', () => {
  fetch('/api/simeon/stop', { method: 'POST' }).catch(() => {});
});

// The model selector is the biggest remaining speed lever, so it lives in the bar rather
// than in mod settings — which support only booleans and numbers, not a choice of strings.
const modelSel = $('sim-model');
modelSel.value = localStorage.getItem('simeon-model') || '';
settings.model = modelSel.value;
modelSel.addEventListener('change', () => {
  settings.model = modelSel.value;
  localStorage.setItem('simeon-model', modelSel.value);
});

$('sim-toggle-rail').addEventListener('click', () => {
  const rail = $('sim-rail');
  rail.hidden = !rail.hidden;
});

// ⌘\ must be bound HERE as well as in the host: a host listener sits on the top document
// and never sees a keystroke made inside this iframe, which is exactly when you want the
// chrome gone.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    window.deepsteve?.toggleQuiet?.();
  }
});

// The bridge is injected after load, so it may not be there on the first tick.
function withBridge(fn, tries = 20) {
  if (window.deepsteve) return fn(window.deepsteve);
  if (tries > 0) setTimeout(() => withBridge(fn, tries - 1), 50);
}
withBridge((bridge) => {
  bridge.onSettingsChanged?.((s) => {
    settings = { ...settings, ...s, model: settings.model };
    $('sim-rail').hidden = !settings.showRawRows;
  });
});

connect();
pollStatus();
setInterval(pollStatus, 2500);
refreshEmpty();
$('sim-input').focus();
