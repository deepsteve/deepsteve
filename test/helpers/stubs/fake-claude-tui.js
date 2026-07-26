#!/usr/bin/env node
/**
 * Fake Claude Code TUI for #607 — a *composer*, not a line reader.
 *
 * Every other standalone suite stubs `claude` with a bash `while IFS= read -r line`
 * loop, which is structurally unable to reproduce #607: bash `read` is line-oriented
 * AND the pane's tty is in canonical mode (ICANON|ICRNL), so `write("text")` followed
 * a second later by `write("\r")` reaches the child as ONE read returning "text\n" —
 * byte-identical to the coalesced case the bug is about. Those stubs cannot tell a
 * lost Enter from a delivered one.
 *
 * This stub puts stdin in RAW mode, so it observes the exact byte chunking the
 * daemon produced, and models Ink's actual rule: a \r counts as Enter only when it
 * arrives as its OWN read. A \r bundled with text is pasted content and stays in the
 * draft — which is precisely the "prompt staged in the composer, never sent" symptom.
 *
 * It also renders a real composer box and the idle-footer / spinner markers the
 * daemon's screen classifier and composer reader key on, so the whole delivery
 * pipeline runs for real.
 *
 * Behaviour comes from a JSON policy file ($DS_STUB_CONFIG), snapshotted at startup,
 * so one daemon can host many differently-behaving sessions: write the policy, then
 * create the session.
 *
 *   policy         'ink' (default) | 'lenient'   Enter recognition rule
 *   readAfterMs    do not service stdin at all for this long after boot, so a text
 *                  write and a later \r sit in the kernel tty buffer and COALESCE
 *                  into one read by construction — no reliance on CPU load or
 *                  scheduler luck
 *   echoDelayMs    repaint the draft only this long after receiving it (loaded TUI)
 *   swallowEnters  ignore the first N standalone Enters
 *   footer         'always' | 'never' | 'late'   whether the idle markers are drawn
 *   footerLateMs   delay for footer:'late'
 *   workMs         after a submit, emit spinner glyph frames for this long
 *   keepDraft      leave the submitted text in the composer while working
 *
 * Logs, one JSON object per line, under $DS_STUB_LOG_DIR keyed by the session id:
 *   <id>.stdin.jsonl   every stdin chunk: {t, len, hex, text}
 *   <id>.events.jsonl  {t, event, ...}
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const T0 = Date.now();
const SESSION = process.env.DEEPSTEVE_SESSION_ID || 'nosession';
const DIR = process.env.DS_STUB_LOG_DIR || path.join(process.env.HOME || '/tmp', 'stub-logs');
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
const STDIN_LOG = path.join(DIR, `${SESSION}.stdin.jsonl`);
const EVENT_LOG = path.join(DIR, `${SESSION}.events.jsonl`);

function loadPolicy() {
  let f = {};
  if (process.env.DS_STUB_CONFIG) {
    try { f = JSON.parse(fs.readFileSync(process.env.DS_STUB_CONFIG, 'utf8')); } catch {}
  }
  const num = (k, d) => (f[k] === undefined || f[k] === null ? d : Number(f[k]));
  return {
    policy: String(f.policy || 'ink'),
    footer: String(f.footer || 'always'),
    footerLateMs: num('footerLateMs', 8000),
    readAfterMs: num('readAfterMs', 0),
    echoDelayMs: num('echoDelayMs', 0),
    swallowEnters: num('swallowEnters', 0),
    workMs: num('workMs', 0),
    keepDraft: !!f.keepDraft,
  };
}
const CFG = loadPolicy();

const jsonl = (file, obj) => {
  try { fs.appendFileSync(file, JSON.stringify({ t: Date.now() - T0, ...obj }) + '\n'); } catch {}
};
const ev = (event, extra) => jsonl(EVENT_LOG, Object.assign({ event }, extra));

const SPIN = ['✢', '✳', '✶', '✻', '✽'];
const RULE = '─'.repeat(60);

let draft = '';
const transcript = [];
let working = false;
let workStart = 0;
let frame = 0;
let workTimer = null;
let footerShown = false;
let enters = 0;
let submits = 0;

// Raw mode may clear OPOST, so every line break is written explicitly.
const out = (s) => { try { process.stdout.write(s); } catch {} };

function footerLines() {
  if (CFG.footer === 'never') return ['(no footer)'];
  if (CFG.footer === 'late' && Date.now() - T0 < CFG.footerLateMs) return ['(starting…)'];
  footerShown = true;
  // The classifier's atPrompt markers (screen-classifier.js CLAUDE_SCREEN_MARKERS).
  return ['⏵⏵ auto mode on (shift+tab to cycle) · ← for agents', '? for shortcuts'];
}

function render() {
  const rows = transcript.slice(-6);
  rows.push(RULE);
  // The composer box. An empty draft still draws the glyph row, exactly like the
  // real TUI, so composer-state.js reads '' (empty) rather than null (unknown).
  for (const line of (draft === '' ? [''] : draft.split('\n'))) rows.push('❯ ' + line);
  rows.push(RULE);
  if (working) {
    const secs = Math.round((Date.now() - workStart) / 1000);
    // Spinner GLYPH per frame — the mid-2026 heartbeat the classifier keys on.
    rows.push(`${SPIN[frame % SPIN.length]} Hatching… (${secs}s · ↓ 1.2k tokens)`);
  } else {
    for (const l of footerLines()) rows.push(l);
  }
  out('\x1b[H\x1b[2J' + rows.join('\r\n') + '\r\n');
}

function startWork() {
  working = true;
  workStart = Date.now();
  frame = 0;
  ev('work-start', { ms: CFG.workMs });
  render();
  // 400ms is comfortably inside SPINNER_MAX_QUIET_MS (2500), so the daemon sees a
  // continuously running turn.
  workTimer = setInterval(() => {
    frame++;
    if (Date.now() - workStart >= CFG.workMs) {
      clearInterval(workTimer);
      workTimer = null;
      working = false;
      if (CFG.keepDraft) draft = '';
      transcript.push('⏺ work finished');
      ev('work-end', {});
    }
    render();
  }, 400);
}

function onEnter() {
  enters++;
  if (enters <= CFG.swallowEnters) { ev('enter-swallowed', { n: enters }); return; }
  // Enter on an empty composer is a NO-OP that produces no submit. That is what
  // makes a spurious retry observable rather than silent.
  if (draft.trim() === '') { ev('enter-empty', { n: enters }); render(); return; }

  const text = draft;
  if (!CFG.keepDraft) draft = '';
  submits++;
  ev('submit', { n: submits, text });
  if (text.includes('/exit')) { ev('exit', { via: '/exit' }); out('\r\n'); process.exit(0); }
  transcript.push('❯ ' + text.split('\n')[0]);
  transcript.push('GOT:' + text.replace(/\n/g, ' ⏎ '));
  if (CFG.workMs > 0) startWork(); else render();
}

function handleChunk(buf) {
  const s = buf.toString('utf8');
  jsonl(STDIN_LOG, {
    len: s.length,
    hex: Buffer.from(s).toString('hex'),
    text: s.replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
  });

  if (s === '\x03') { ev('exit', { via: 'ctrl-c' }); process.exit(0); }
  if (s === '\x1b') { draft = ''; render(); return; }   // Escape clears the composer

  if (CFG.policy === 'ink') {
    if (s === '\r' || s === '\n') { ev('enter', { own_chunk: true }); onEnter(); return; }
    // #607: a CR that arrived bundled with text is pasted content, not a key. Only
    // CR counts — the daemon writes \r for Enter, while a multi-line prompt's own
    // newlines are LF and are simply part of the draft.
    if (/\r/.test(s)) ev('enter-coalesced', { chunk: s.length });
    draft += s.replace(/\r\n?/g, '\n');
  } else {
    const submit = /[\r\n]$/.test(s);
    draft += s.replace(/[\r\n]+$/, '').replace(/\r\n?/g, '\n');
    if (submit) { ev('enter', { own_chunk: s.length === 1 }); onEnter(); return; }
  }
  if (CFG.echoDelayMs > 0) setTimeout(render, CFG.echoDelayMs);
  else render();
}

function pump() {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) handleChunk(chunk);
}

// Coalescing has to be produced at the FILE DESCRIPTOR, not in the stream buffer.
// Attaching a 'readable' listener makes libuv start read(2)ing fd 0 immediately, so
// the prompt text lands in the stream buffer the moment it is written and a later \r
// arrives as its own separate read — the well-behaved case, not the bug. Holding the
// listener off entirely leaves both writes sitting in the KERNEL tty buffer, so the
// first read(2) after the hold returns them concatenated. That is exactly what a
// loaded Ink app does when it goes seconds without servicing stdin.
//
// Raw mode is set up front (it does not start reading) so ICRNL never rewrites the
// buffered \r into \n while the hold is in effect.
function attachStdin() {
  process.stdin.on('readable', pump);
  process.stdin.on('end', () => { ev('exit', { via: 'stdin-end' }); process.exit(0); });
  pump();
}

ev('boot', { session: SESSION, cfg: CFG, argv: process.argv.slice(2) });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
if (CFG.readAfterMs > 0) {
  ev('read-hold', { ms: CFG.readAfterMs });
  setTimeout(() => { ev('read-resume', {}); attachStdin(); }, CFG.readAfterMs);
} else {
  attachStdin();
}
process.on('SIGTERM', () => { ev('exit', { via: 'sigterm' }); process.exit(0); });
// A real TUI repaints on its own schedule; this stub only repaints on input, so
// footer:'late' needs one scheduled frame or the footer would never appear.
if (CFG.footer === 'late') setTimeout(render, CFG.footerLateMs + 50).unref?.();
render();
