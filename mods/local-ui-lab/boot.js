/**
 * Local UI Lab: the front end. The backend picker, the chat box, the metrics strip, and
 * `window.lab`, which the benchmark harness drives over CDP.
 *
 * The page on screen is kept in localStorage, so a reload or a deploy does not lose the thing
 * you were iterating on. Undo is a plain stack of earlier pages, in memory only.
 */

import { listOllamaModels, webgpuAvailable, loadWebllm, WEBLLM_MODEL } from './backends.js';
import { runRequest, parseBackend } from './lab.js';
import { createPreview } from './preview.js';
import { runBenchmark, runTask, TASKS } from './bench.js';

const $ = (id) => document.getElementById(id);
const PAGE_KEY = 'local-ui-lab-page';
const BACKEND_KEY = 'local-ui-lab-backend';

// The empty-state card follows the frame itself, so every path that puts a page in it (the
// chat box, the benchmark, window.lab) uncovers it without having to remember to.
const preview = createPreview($('lab-preview'), {
  onMode: (mode) => { $('lab-empty').hidden = mode !== 'empty'; },
});

let page = localStorage.getItem(PAGE_KEY) || '';
const undoStack = [];
let running = null;   // the AbortController of the request or benchmark in flight

// ── page state ──────────────────────────────────────────────────────────────────────

function setPage(html, { remember = true } = {}) {
  if (remember && page && html !== page) undoStack.push(page);
  if (undoStack.length > 30) undoStack.shift();
  page = html;
  if (html) localStorage.setItem(PAGE_KEY, html);
  else localStorage.removeItem(PAGE_KEY);
  refreshControls();
}

function refreshControls() {
  $('lab-undo').disabled = !undoStack.length || !!running;
  $('lab-clear').disabled = (!page && !undoStack.length) || !!running;
  $('lab-stop').disabled = !running;
  $('lab-send').disabled = !!running;
  $('lab-bench').disabled = !!running;
}

// ── console ─────────────────────────────────────────────────────────────────────────

function addMessage(role, text) {
  const log = $('lab-log');
  const el = document.createElement('div');
  el.className = 'lab-msg';
  el.dataset.role = role;
  el.textContent = text;
  log.appendChild(el);
  while (log.childElementCount > 300) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
  return el;
}

function setState(state, label) {
  $('lab-dot').dataset.state = state;
  $('lab-state').textContent = label;
}

const rawText = $('lab-raw-text');
function clearRaw() { rawText.textContent = ''; }
function appendRaw(delta) {
  rawText.textContent += delta;
  rawText.scrollTop = rawText.scrollHeight;
}

const fmtMs = (ms) => (ms == null ? '–' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function chip(label, value, tone) {
  const el = document.createElement('span');
  el.className = 'lab-chip';
  if (tone) el.dataset.tone = tone;
  el.append(`${label} `);
  const b = document.createElement('b');
  b.textContent = value;
  el.append(b);
  return el;
}

function renderMetrics(r) {
  const box = $('lab-metrics');
  box.textContent = '';
  const m = r.metrics || {};
  box.append(
    chip('first token', fmtMs(r.ttftMs)),
    chip(r.mode === 'patch' ? 'first change' : 'first paint', fmtMs(r.firstPaintMs)),
    chip('total', fmtMs(r.totalMs)),
    chip('tok/s', m.tokPerSec ?? '–'),
    chip('tokens', `${m.promptTokens ?? '–'} in · ${m.outputTokens ?? '–'} out`),
  );
  if (m.loadMs > 50) box.append(chip('model load', fmtMs(m.loadMs)));
  if (r.patches) {
    const p = r.patches;
    box.append(chip('patches', `${p.applied}/${p.blocks} applied`, p.failed ? 'bad' : p.applied ? 'good' : null));
  }
  const errors = (r.render?.errors || []).filter((e) => !e.resource).length;
  if (errors) box.append(chip('script errors', errors, 'bad'));
  if (r.fenced) box.append(chip('added', 'code fence', 'bad'));
  if (r.prose) box.append(chip('added', 'prose', 'bad'));
  if (r.complete === false) box.append(chip('page', 'incomplete', 'bad'));
  if (r.unterminated) box.append(chip('reply', 'cut off mid-block', 'bad'));
  if (r.pass != null) box.append(chip('check', r.pass ? 'pass' : 'fail', r.pass ? 'good' : 'bad'));
}

function summaryLine(r) {
  const m = r.metrics || {};
  const parts = [r.mode, r.backend.replace(/^ollama:/, '')];
  if (r.patches) parts.push(`${r.patches.applied}/${r.patches.blocks} blocks`);
  parts.push(`first token ${fmtMs(r.ttftMs)}`, `${r.mode === 'patch' ? 'first change' : 'first paint'} ${fmtMs(r.firstPaintMs)}`,
    `total ${fmtMs(r.totalMs)}`, `${m.tokPerSec ?? '–'} tok/s`);
  if (r.aborted) parts.push('stopped');
  return parts.join(' · ');
}

// ── backends ────────────────────────────────────────────────────────────────────────

function option(value, label, disabled = false) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.disabled = disabled;
  return o;
}

let modelPoll = 0;
async function loadBackends() {
  const sel = $('lab-backend');
  const keep = sel.value || localStorage.getItem(BACKEND_KEY);
  let data;
  try {
    data = await listOllamaModels();
  } catch (e) {
    data = { ollama: 'down', models: [], error: e.message };
  }

  sel.textContent = '';
  const local = document.createElement('optgroup');
  local.label = 'Ollama, served on this machine';
  if (data.ollama !== 'up') local.append(option('', 'Ollama is not running: start it with `ollama serve`', true));
  else if (!data.models.length) local.append(option('', 'No local models: `ollama pull qwen3.5:4b`', true));
  for (const m of data.models) {
    local.append(option(`ollama:${m.name}`, [m.name, m.parameterSize, m.quantization].filter(Boolean).join(' · ')));
  }
  sel.append(local);

  const web = document.createElement('optgroup');
  web.label = 'In this browser (WebLLM on WebGPU)';
  web.append(webgpuAvailable()
    ? option('webllm', `${WEBLLM_MODEL} · one-time download`)
    : option('webllm', `${WEBLLM_MODEL}: this browser has no WebGPU`, true));
  sel.append(web);

  const usable = [...sel.options].filter((o) => o.value && !o.disabled);
  sel.value = usable.some((o) => o.value === keep) ? keep : (usable[0]?.value || '');

  // Ollama started after the page loaded should appear without a reload.
  clearTimeout(modelPoll);
  if (data.ollama !== 'up') modelPoll = setTimeout(loadBackends, 5000);
}

function currentBackend() {
  const key = $('lab-backend').value;
  return key ? parseBackend(key) : null;
}

let lastProgress = 0;
function webllmProgress(report) {
  const now = performance.now();
  if (now - lastProgress < 120 && report.progress < 1) return;
  lastProgress = now;
  const pct = typeof report.progress === 'number' ? ` ${Math.round(report.progress * 100)}%` : '';
  setState('loading', `loading model${pct}: ${String(report.text || '').slice(0, 90)}`);
}

// ── actions ─────────────────────────────────────────────────────────────────────────

function resolveMode() {
  const chosen = $('lab-mode').value;
  if (chosen === 'auto') return page ? 'patch' : 'generate';
  if (chosen !== 'generate' && !page) return 'generate';
  return chosen;
}

async function send() {
  const input = $('lab-input');
  const text = input.value.trim();
  if (!text || running) return;
  const backend = currentBackend();
  if (!backend) { addMessage('error', 'Pick a model first.'); return; }

  const mode = resolveMode();
  input.value = '';
  input.style.height = 'auto';
  addMessage('user', text);
  clearRaw();

  running = new AbortController();
  refreshControls();
  setState('busy', mode === 'patch' ? 'patching' : 'writing');

  const r = await runRequest({
    backend, mode, request: text, html: page, preview,
    signal: running.signal,
    onText: (delta) => {
      appendRaw(delta);
      if ($('lab-dot').dataset.state === 'loading') setState('busy', mode === 'patch' ? 'patching' : 'writing');
    },
    onBlock: (block, res) => {
      if (!res.ok) addMessage('error', `A SEARCH block did not match the page (${res.reason}): ${block.search.split('\n')[0].trim().slice(0, 80)}`);
    },
    onProgress: webllmProgress,
  });

  running = null;
  if (r.html && r.html !== page) setPage(r.html);
  refreshControls();
  renderMetrics(r);
  addMessage('run', summaryLine(r));
  if (r.error) {
    addMessage('error', r.error);
    setState('error', 'failed');
  } else {
    setState('ok', 'ready');
  }
  window.labLast = r;
}

async function benchmark() {
  if (running) return;
  const backend = currentBackend();
  if (!backend) { addMessage('error', 'Pick a model first.'); return; }

  running = new AbortController();
  refreshControls();
  const editCount = TASKS.filter((t) => t.kind === 'edit').length;
  addMessage('system', `Benchmark on ${backend.key}: a warm-up, ${TASKS.length - editCount} new pages, then ${editCount} edits as patch and as rewrite.`);

  try {
    const out = await runBenchmark({
      backend, preview, signal: running.signal,
      onProgress: webllmProgress,
      onText: appendRaw,
      onStart: ({ id, mode }) => { clearRaw(); setState('busy', `benchmark: ${id} (${mode})`); },
      onRun: (r) => {
        renderMetrics(r);
        addMessage('run', `${r.pass ? 'pass' : 'FAIL'} ${r.task} · ${summaryLine(r)}`);
      },
    });
    (window.labResults ||= []).push(out);
    for (const [mode, s] of Object.entries(out.summary)) {
      addMessage('system', `${mode}: ${s.pass}/${s.runs} pass · median first paint ${fmtMs(s.firstPaintMs)} · total ${fmtMs(s.totalMs)} · ${s.tokPerSec ?? '–'} tok/s`);
    }
    const el = addMessage('system', 'Results are in window.labResults.');
    const copy = document.createElement('button');
    copy.textContent = 'Copy JSON';
    copy.addEventListener('click', () => navigator.clipboard?.writeText(JSON.stringify(out, null, 2)));
    el.append(copy);
    setState('ok', 'benchmark done');
  } catch (e) {
    addMessage('error', `Benchmark stopped: ${e.message}`);
    setState('error', 'benchmark failed');
  } finally {
    running = null;
    refreshControls();
    if (page) preview.show(page); else preview.clear();
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────────────

$('lab-send').addEventListener('click', send);
$('lab-bench').addEventListener('click', benchmark);
$('lab-stop').addEventListener('click', () => running?.abort());

$('lab-undo').addEventListener('click', () => {
  if (running || !undoStack.length) return;
  setPage(undoStack.pop(), { remember: false });
  if (page) preview.show(page); else preview.clear();
});

$('lab-clear').addEventListener('click', () => {
  if (running) return;
  setPage('');
  preview.clear();
  clearRaw();
  $('lab-metrics').textContent = '';
});

$('lab-toggle-raw').addEventListener('click', () => {
  const raw = $('lab-raw');
  raw.hidden = !raw.hidden;
  localStorage.setItem('local-ui-lab-raw', raw.hidden ? '0' : '1');
});
$('lab-raw').hidden = localStorage.getItem('local-ui-lab-raw') === '0';

$('lab-backend').addEventListener('change', (e) => localStorage.setItem(BACKEND_KEY, e.target.value));

$('lab-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('lab-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
});

// ⌘\ is bound here as well as in the host: a host listener never sees a keystroke made inside
// this iframe (docs/mods.md, Apps).
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault();
    window.deepsteve?.toggleQuiet?.();
  }
});

// For the benchmark harness (notes/results.md), which drives this page over CDP.
window.lab = {
  tasks: TASKS.map(({ id, kind, request }) => ({ id, kind, request })),
  backends: () => [...$('lab-backend').options].filter((o) => o.value && !o.disabled).map((o) => o.value),
  loadWebllm: () => loadWebllm(webllmProgress),
  runTask: async (backendKey, taskId, mode = 'generate', { order } = {}) => {
    clearRaw();
    const r = await runTask({ backend: parseBackend(backendKey), preview, taskId, mode, order, onText: appendRaw, onProgress: webllmProgress });
    if (r.html) setPage(r.html, { remember: false });
    renderMetrics(r);
    addMessage('run', `${r.pass ? 'pass' : 'FAIL'} ${r.task} · ${summaryLine(r)}`);
    return r;
  },
  request: async (backendKey, mode, request, html = '', { order } = {}) => {
    clearRaw();
    const r = await runRequest({ backend: parseBackend(backendKey), mode, request, html, order, preview, onText: appendRaw, onProgress: webllmProgress });
    if (r.html) setPage(r.html, { remember: false });
    return r;
  },
  benchmark: (backendKey, { order } = {}) =>
    runBenchmark({ backend: parseBackend(backendKey), preview, order, onProgress: webllmProgress, onText: appendRaw }),
};

loadBackends();
if (page) preview.show(page); else preview.clear();
refreshControls();
$('lab-input').focus();
