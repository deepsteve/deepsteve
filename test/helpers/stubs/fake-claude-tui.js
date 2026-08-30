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
 * #656 knobs — a prompt that arrives PARTLY, rather than late:
 *   readChunkBytes drain stdin with fs.readSync() in slices this big, on a timer,
 *                  instead of letting libuv hoover the fd into the stream buffer.
 *                  The remainder genuinely stays in the KERNEL queue, which is the
 *                  only place the observed loss could have happened.
 *   readGapMs      the timer for the above
 *   dropFirstBytes discard N bytes without echoing them. The application-level
 *                  stand-in for a tty input-queue flush, and the only deterministic
 *                  way to manufacture the production incident: a contiguous run gone,
 *                  nothing echoed for it, no fragment submitted for it.
 *   pasteMarkers   honour ESC[200~ / ESC[201~: buffer until paste-end, treat a \r
 *                  INSIDE the paste as content rather than Enter, and render the
 *                  collapsed `[Pasted text #1 +N lines]` placeholder the real TUI
 *                  draws — N being the NEWLINE count, as Claude Code counts it.
 *   dropAfterBytes offset for the above: let this many bytes through before the drop
 *                  starts (default 0, i.e. from the very front). A flush partway
 *                  through the write is what TCSAFLUSH actually looks like once the
 *                  application has already read some of it, and it costs the MIDDLE
 *                  of the prompt rather than its head.
 *   transcript     append each submitted message to the Claude Code session
 *                  transcript the daemon reads, at the path the daemon derives from
 *                  --session-id and the cwd. Without it the #656 delivery check has
 *                  no oracle to consult and can only ever say "unconfirmed".
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
    readChunkBytes: num('readChunkBytes', 0),
    readGapMs: num('readGapMs', 10),
    dropFirstBytes: num('dropFirstBytes', 0),
    dropAfterBytes: num('dropAfterBytes', 0),
    pasteMarkers: !!f.pasteMarkers,
    transcript: !!f.transcript,
    // #660 — a permission dialog that really responds to arrow keys. `menu` is
    // { banner, question, options[], footer }; `menuOnBoot` puts it up immediately,
    // otherwise a submitted prompt containing `menuTrigger` raises it.
    menu: (f.menu && typeof f.menu === 'object') ? f.menu : null,
    menuOnBoot: !!f.menuOnBoot,
    menuTrigger: String(f.menuTrigger || 'SHOW-MENU'),
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
// #656 state.
let dropRemaining = 0;          // set from CFG at boot
let dropGrace = 0;              // bytes to let through before dropping starts
let pasting = false;            // between ESC[200~ and ESC[201~
let pasteBuf = '';
let pasteCarry = Buffer.alloc(0); // bytes held back in case a marker straddles a read
let pasteNewlines = 0;          // what the collapsed placeholder advertises
let draftIsPaste = false;
// #660 menu state. `menuUp` swaps the whole frame for a permission dialog, so the
// composer is gone exactly as it is in the real TUI while a modal is open.
let menuUp = false;
let menuCursor = 0;

// Raw mode may clear OPOST, so every line break is written explicitly.
const out = (s) => { try { process.stdout.write(s); } catch {} };

function footerLines() {
  if (CFG.footer === 'never') return ['(no footer)'];
  if (CFG.footer === 'late' && Date.now() - T0 < CFG.footerLateMs) return ['(starting…)'];
  footerShown = true;
  // The classifier's atPrompt markers (screen-classifier.js CLAUDE_SCREEN_MARKERS).
  return ['⏵⏵ auto mode on (shift+tab to cycle) · ← for agents', '? for shortcuts'];
}

// The real TUI hides a pasted block behind a placeholder rather than echoing it, so
// its characters never reach the screen and the line count is the only thing a reader
// can check. Claude Code's own formatter, from the 2.1.246 binary:
//   pr = (e) => (e.match(/\r\n|\r|\n/g) || []).length
//   cr = (e, t) => t === 0 ? `[Pasted text #${e}]` : `[Pasted text #${e} +${t} lines]`
function draftRows() {
  if (draft === '') return [''];
  if (draftIsPaste) {
    return [pasteNewlines === 0 ? '[Pasted text #1]' : `[Pasted text #1 +${pasteNewlines} lines]`];
  }
  return draft.split('\n');
}

// #660 — the permission-dialog frame. Deliberately replaces the composer entirely,
// like the real modal does: that absence is why Workshop cannot answer one with
// submitToShell (its confirmEcho would wait forever for a composer echo) and has to
// move the cursor with raw keys instead.
function menuLines() {
  const m = CFG.menu || {};
  const options = Array.isArray(m.options) ? m.options : ['Yes', 'No'];
  const rows = [];
  if (m.banner) rows.push(m.banner);
  rows.push(m.question || 'Do you want to proceed?');
  options.forEach((label, i) => {
    rows.push(`${i === menuCursor ? '❯' : ' '} ${i + 1}. ${label}`);
  });
  rows.push(m.footer || 'Esc to cancel · Tab to amend');
  return rows;
}

function openMenu() {
  menuUp = true;
  menuCursor = Number(CFG.menu && CFG.menu.cursor) || 0;
  ev('menu-open', { cursor: menuCursor });
  render();
}

function render() {
  if (menuUp) {
    out('\x1b[H\x1b[2J' + menuLines().join('\r\n') + '\r\n');
    return;
  }
  const rows = transcript.slice(-6);
  rows.push(RULE);
  // The composer box. An empty draft still draws the glyph row, exactly like the
  // real TUI, so composer-state.js reads '' (empty) rather than null (unknown).
  for (const line of draftRows()) rows.push('❯ ' + line);
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

// The real Claude Code records every message it accepts in its session transcript,
// and that file is the oracle the daemon's #656 delivery check consults. Write it at
// exactly the path the daemon derives (claudeProjectDir + `${claudeSessionId}.jsonl`),
// or the check has nothing to compare and can only say "unconfirmed".
function transcriptFile() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--session-id');
  const uuid = i >= 0 ? argv[i + 1] : null;
  if (!uuid) return null;
  const home = process.env.HOME || '/tmp';
  const dirName = process.cwd().replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(home, '.claude', 'projects', dirName, `${uuid}.jsonl`);
}

function recordTranscript(text) {
  const file = transcriptFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({
      type: 'user', message: { role: 'user', content: text },
    }) + '\n');
    ev('transcript-append', { file, len: text.length });
  } catch (e) { ev('transcript-error', { message: e.message }); }
}

function onEnter() {
  enters++;
  if (enters <= CFG.swallowEnters) { ev('enter-swallowed', { n: enters }); return; }
  // Enter on an empty composer is a NO-OP that produces no submit. That is what
  // makes a spurious retry observable rather than silent.
  if (draft.trim() === '') { ev('enter-empty', { n: enters }); render(); return; }

  const text = draft;
  if (!CFG.keepDraft) { draft = ''; draftIsPaste = false; pasteNewlines = 0; }
  submits++;
  ev('submit', { n: submits, text });
  if (CFG.transcript) recordTranscript(text);
  if (text.includes('/exit')) { ev('exit', { via: '/exit' }); out('\r\n'); process.exit(0); }
  transcript.push('❯ ' + text.split('\n')[0]);
  transcript.push('GOT:' + text.replace(/\n/g, ' ⏎ '));
  // #660 — a prompt can raise the permission dialog, so a test can drive a session
  // into "blocked" the same way a real tool call does.
  if (CFG.menu && text.includes(CFG.menuTrigger)) { openMenu(); return; }
  if (CFG.workMs > 0) startWork(); else render();
}

const PASTE_START = Buffer.from('\x1b[200~');
const PASTE_END = Buffer.from('\x1b[201~');

/** Longest suffix of `buf` that is a proper prefix of `marker`. */
function partialMarkerLen(buf, marker) {
  for (let n = Math.min(marker.length - 1, buf.length); n > 0; n--) {
    if (buf.slice(buf.length - n).equals(marker.slice(0, n))) return n;
  }
  return 0;
}

function handleChunk(buf) {
  jsonl(STDIN_LOG, {
    len: buf.length,
    hex: buf.toString('hex'),
    text: buf.toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
  });

  // #656: a queue flush eats bytes before the application ever sees them, and echoes
  // nothing. Do the same, byte-wise — from the front, or after a grace run, which is
  // what a flush partway through the write looks like.
  if (dropRemaining > 0) {
    if (dropGrace > 0) {
      const pass = Math.min(dropGrace, buf.length);
      dropGrace -= pass;
      if (pass === buf.length) { handleAfterDrop(buf); return; }
      handleAfterDrop(buf.subarray(0, pass));
      buf = buf.subarray(pass);
    }
    const n = Math.min(dropRemaining, buf.length);
    dropRemaining -= n;
    ev('dropped', { n, remaining: dropRemaining });
    buf = buf.subarray(n);
    if (buf.length === 0) return;
  }
  handleAfterDrop(buf);
}

function handleAfterDrop(buf) {

  if (!CFG.pasteMarkers) { handleKeys(buf.toString('utf8')); return; }

  // Split the stream on paste markers, which a small read can straddle.
  let data = Buffer.concat([pasteCarry, buf]);
  pasteCarry = Buffer.alloc(0);
  for (;;) {
    const marker = pasting ? PASTE_END : PASTE_START;
    const idx = data.indexOf(marker);
    if (idx === -1) {
      const keep = partialMarkerLen(data, marker);
      pasteCarry = data.slice(data.length - keep);
      const usable = data.slice(0, data.length - keep);
      if (usable.length) consume(usable);
      return;
    }
    if (idx > 0) consume(data.slice(0, idx));
    data = data.slice(idx + marker.length);
    if (!pasting) {
      pasting = true;
      pasteBuf = '';
      ev('paste-start', {});
    } else {
      pasting = false;
      draft += pasteBuf;
      draftIsPaste = true;
      pasteNewlines = (draft.match(/\r\n|\r|\n/g) || []).length;
      ev('paste-end', { len: pasteBuf.length, lines: pasteNewlines });
      render();
    }
    if (data.length === 0) return;
  }
}

function consume(bytes) {
  if (pasting) {
    // Inside a paste, EVERYTHING is content — a \r here is a line break the user
    // pasted, never Enter. That is the guarantee bracketing buys.
    pasteBuf += bytes.toString('utf8').replace(/\r\n?/g, '\n');
    return;
  }
  handleKeys(bytes.toString('utf8'));
}

function handleKeys(s) {
  if (s === '\x03') { ev('exit', { via: 'ctrl-c' }); process.exit(0); }

  // #660 — while the modal is up it owns every key, and it obeys Ink's rule: an arrow
  // counts only when its escape sequence arrives as its OWN read, which is precisely
  // what Workshop's 250ms-per-byte loop produces.
  if (menuUp) {
    const options = (CFG.menu && CFG.menu.options) || ['Yes', 'No'];
    if (s === '\x1b[B') { menuCursor = Math.min(options.length - 1, menuCursor + 1); ev('menu-move', { cursor: menuCursor }); render(); return; }
    if (s === '\x1b[A') { menuCursor = Math.max(0, menuCursor - 1); ev('menu-move', { cursor: menuCursor }); render(); return; }
    if (s === '\r' || s === '\n') {
      menuUp = false;
      ev('menu-select', { index: menuCursor, label: options[menuCursor] });
      transcript.push('SELECTED:' + (menuCursor + 1));
      render();
      return;
    }
    if (s === '\x1b') { menuUp = false; ev('menu-cancel', {}); transcript.push('SELECTED:cancel'); render(); return; }
    ev('menu-ignored', { bytes: s.length });
    return;
  }

  // Escape clears the composer
  if (s === '\x1b') { draft = ''; draftIsPaste = false; pasteNewlines = 0; render(); return; }

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
  if (CFG.readChunkBytes > 0) { dripStdin(); return; }
  process.stdin.on('readable', pump);
  process.stdin.on('end', () => { ev('exit', { via: 'stdin-end' }); process.exit(0); });
  pump();
}

// #656: read(2) fd 0 directly, in small slices, on a timer. Deliberately NOT
// process.stdin.read(n) — attaching any stream listener makes libuv drain the whole
// fd into the stream buffer at once, so the bytes leave the kernel queue immediately
// and the very condition under test disappears (the same trap the comment above
// describes for the coalescing case). fs.readSync leaves the remainder where it is.
function dripStdin() {
  const buf = Buffer.alloc(CFG.readChunkBytes);
  ev('drip-start', { bytes: CFG.readChunkBytes, gapMs: CFG.readGapMs });
  const tick = () => {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, CFG.readChunkBytes, null);
    } catch (e) {
      if (e.code === 'EOF') { ev('exit', { via: 'stdin-end' }); process.exit(0); }
      if (e.code !== 'EAGAIN') { ev('read-error', { code: e.code }); }
      n = 0;
    }
    if (n > 0) handleChunk(Buffer.from(buf.subarray(0, n)));
    setTimeout(tick, CFG.readGapMs);
  };
  setTimeout(tick, CFG.readGapMs);
}

ev('boot', { session: SESSION, cfg: CFG, argv: process.argv.slice(2) });
dropRemaining = CFG.dropFirstBytes;
dropGrace = CFG.dropAfterBytes;
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
// #660 — menuOnBoot puts the session straight into "blocked" with no prompt round
// trip, which is all a Workshop inbox test needs.
if (CFG.menu && CFG.menuOnBoot) { menuUp = true; menuCursor = Number(CFG.menu.cursor) || 0; }
render();
