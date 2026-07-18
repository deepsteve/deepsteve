/**
 * Deterministic tests for the screen-state waitingForInput detector (#568).
 *
 * These are the #558 repros, flipped from "reproduces the bug" to "the bug is
 * gone." Spawns its own throwaway daemon (scratch $HOME, random port, stub
 * `claude`) and drives the detector through the real WS input path — the same
 * path a typing user takes. The stub agent is command-driven over its stdin and,
 * unlike the old BEL stub, emits real *screen text* (spinner / idle footer /
 * permission dialog) because the detector reads the rendered screen, not bells:
 *
 *   idle      -> prints the idle composer footer ("⏵⏵ auto mode on", "? for
 *                shortcuts"), then sits quiet at its read loop
 *   work      -> a spinner ("… esc to interrupt …") every ~0.5s for a good while
 *                (the shape of a long, output-quiet tool call — #500), then
 *                "work finished" + the idle footer
 *   perm      -> a permission dialog ("Do you want to proceed?", "Esc to cancel …")
 *   tick      -> the idle footer, then a non-spinner line every 2s (would have
 *                flickered the old 2s-silence classifier)
 *   /exit     -> exits
 *
 * What each test now asserts (the fix):
 *   0. Baseline: idle footer -> waiting:true; REST and /api/shells agree.
 *   A. #558 Lead 1 fixed: one un-submitted keystroke does NOT clear waiting; it
 *      stays true (the "one keystroke disarms it forever" trap is gone).
 *   B. Non-claude (terminal) sessions are still never classified (unchanged).
 *   C. #500 fixed: a running spinner is never mislabeled waiting, and the flag
 *      flips to true only after the turn ends and the footer appears.
 *   D. Anti-flicker: periodic non-spinner output at an idle footer produces one
 *      waiting:true edge and no spurious false edges.
 *
 * Run: node --test --test-timeout=180000 test/integration-standalone/waiting-classifier.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Emits real Claude-like screen text. print_footer draws the idle composer footer
// (the "⏵⏵ auto mode on" mode line + the "? for shortcuts" placeholder); spin
// prints a spinner frame carrying the "esc to interrupt" heartbeat every ~0.5s.
const CLAUDE_STUB = `#!/bin/bash
printf 'stub claude ready\\n'
print_footer() {
  printf '%s\\n' '⏵⏵ auto mode on (shift+tab to cycle) · for agents'
  printf '%s\\n' '? for shortcuts'
}
spin() {
  local n=$1 i=1
  while [ $i -le $n ]; do
    printf '%s Working... (esc to interrupt · %ss)\\n' '*' "$i"
    sleep 0.5
    i=$((i+1))
  done
}
# Mid-2026 Claude Code spinner: NO "esc to interrupt" anywhere — the per-frame
# signal is the animated glyph alone (the shape that froze every flag at true).
spinmodern() {
  local n=$1 i=1
  while [ $i -le $n ]; do
    printf '%s Hatching... (%ss · 1.2k tokens · thinking)\\n' '✻' "$i"
    sleep 0.5
    i=$((i+1))
  done
}
while IFS= read -r line; do
  case "$line" in
    *"/exit"*) exit 0 ;;
    *workmodern*) ( spinmodern 20; printf 'work finished\\n'; print_footer ) & ;;
    *work*) ( spin 20; printf 'work finished\\n'; print_footer ) & ;;
    *idle*) print_footer ;;
    *perm*) printf '%s\\n' 'Do you want to proceed?' '1. Yes' '2. No' 'Esc to cancel · Tab to amend' ;;
    *tick*) print_footer; ( for i in 1 2 3 4 5; do sleep 2; printf 'tick %s\\n' "$i"; done ) & ;;
  esac
done
exit 0
`;

let tmpRoot;
let HOME;
let PORT;
let BASE;
let projDir;
let daemon = null;
let daemonLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function authToken() {
  try {
    return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function authHeaders() {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function waitFor(check, what, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let result;
    try { result = await check(); } catch { result = null; }
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];

  // Suppress the cold-start browser auto-open (see session-restore.test.js).
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  // Isolate tmux's socket: it is per-UID, NOT per-HOME (see CLAUDE.md), so a
  // scratch-HOME daemon otherwise shares the real user's tmux socket, sees the
  // real daemon's ds-* sessions, and destroys them as "orphans" on startup (#570).
  const tmuxTmp = path.join(HOME, 'tmux-tmp');
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  env.TMUX_TMPDIR = tmuxTmp;

  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', d => { daemonLog += d.toString(); });
  daemon.stderr.on('data', d => { daemonLog += d.toString(); });

  await waitFor(async () => {
    if (!authToken()) return false;
    const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
    return r.ok;
  }, 'daemon to become ready');
}

function stopDaemon() {
  if (!daemon) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = daemon;
    daemon = null;
    const timer = setTimeout(() => reject(new Error('daemon did not exit within 30s of SIGTERM')), 30000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
}

async function restState(id) {
  const r = await fetch(`${BASE}/api/shells/${id}/state`, { headers: authHeaders() });
  return r.json();
}

// Audit JSONL written by the daemon (scratch HOME).
function auditEvents() {
  try {
    return fs.readFileSync(path.join(HOME, '.deepsteve', 'waiting-audit.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

// WS client that records both JSON control messages (timestamped) and raw PTY
// output, so tests can order state flips against what the "agent" printed.
class Client {
  constructor() {
    this.ws = null;
    this.messages = [];
    this.raw = '';
    this.session = null;
  }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        const text = data.toString();
        let msg;
        try { msg = JSON.parse(text); } catch { this.raw += text; return; }
        if (typeof msg !== 'object' || msg === null) { this.raw += text; return; }
        this.messages.push({ ...msg, _ts: Date.now(), _rawLen: this.raw.length });
        if (msg.type === 'session' && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  sendRaw(str) { this.ws.send(str); }
  mark() { return this.messages.length; }
  statesSince(mark) {
    return this.messages.slice(mark).filter(m => m.type === 'state');
  }
  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

let clients = [];
function track(c) { clients.push(c); return c; }

function submitLine(c, text) {
  c.sendRaw(text + '\n');
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-waitcls-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(
    path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(HOME, '.zprofile'), 'export PATH="$HOME/bin:$PATH"\n');
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();

  // Enable the #558 audit instrumentation (live toggle, no restart).
  const r = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ waitingAuditEnabled: true }),
  });
  assert.ok(r.ok, 'enabled waitingAuditEnabled on the test daemon');
});

after(async () => {
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('baseline: the idle footer flips waiting:true; REST and /api/shells agree', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });

  // Startup prints only "stub claude ready" (no footer, no spinner) -> the
  // detector stays 'unknown' and the flag stays false. Drive `idle` to paint the
  // footer, which is a decisive at-prompt signal.
  const mark = c.mark();
  submitLine(c, 'idle');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true after the idle footer', 8000);

  const rest = await restState(s.id);
  assert.strictEqual(rest.waitingForInput, true, 'REST /state agrees');
  assert.ok(rest.lastInputTime > 0, '/state exposes lastInputTime');

  const shellsList = (await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json()).shells;
  const row = shellsList.find(sh => sh.id === s.id);
  assert.strictEqual(row.waitingForInput, true, '/api/shells carries waitingForInput');

  // Audit recorded a transition to waiting driven by the screen, not a bell.
  const flips = auditEvents().filter(e =>
    e.event === 'transition' && e.shell === s.id && e.to === true);
  assert.ok(flips.length >= 1, 'audit recorded a transition to:true');

  submitLine(c, '/exit');
});

test('#558 Lead 1 fixed: one un-submitted keystroke does NOT clear waiting', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });

  // Reach a genuine waiting state.
  let mark = c.mark();
  submitLine(c, 'idle');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true at the idle footer', 8000);

  // The user starts typing a reply and stops — one character, no submit. The old
  // classifier cleared waitingForInput on ANY keystroke and could never set it
  // again; the screen-state detector must ignore the keystroke and stay waiting.
  mark = c.mark();
  c.sendRaw('g');

  // 10s window: the flag must never go false (no keystroke-disarm), and the sweep
  // must keep it true (no stuck-false).
  await sleep(10000);
  const falses = c.statesSince(mark).filter(m => m.waiting === false);
  assert.strictEqual(falses.length, 0, `no waiting:false after the keystroke (got ${falses.length})`);
  const rest = await restState(s.id);
  assert.strictEqual(rest.waitingForInput, true, 'REST /state still true');

  // The old smoking-gun event no longer fires — the trap is gone.
  const noFlips = auditEvents().filter(e => e.event === 'idle-no-flip' && e.shell === s.id);
  assert.strictEqual(noFlips.length, 0, 'no idle-no-flip events (BEL trap removed)');

  submitLine(c, '/exit');
});

test('non-claude (terminal) sessions are never classified', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'terminal' });
  assert.strictEqual(s.agentType, 'terminal');

  // Let the shell settle, then produce output at its prompt. A claude session
  // would classify; a terminal (no screenMarkers) never does.
  await sleep(2000);
  const mark = c.mark();
  submitLine(c, "printf 'ding\\a'");
  await sleep(6500);

  const states = c.statesSince(mark);
  assert.strictEqual(states.length, 0,
    `terminal session never gets a state message (got ${JSON.stringify(states)})`);
  const rest = await restState(s.id);
  assert.strictEqual(rest.waitingForInput, false, 'REST /state permanently false');

  // The bell still shows on the audit's non-claude channel (unchanged).
  const bels = auditEvents().filter(e => e.event === 'bel-nonclaude' && e.shell === s.id);
  assert.ok(bels.some(e => e.bare >= 1), 'audit recorded the unclassified bare bell');
});

test('#500 fixed: a running spinner is never "waiting"; flips only after the turn ends', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });

  // work: a spinner ("esc to interrupt") every ~0.5s for a good while (no footer
  // yet) — the shape of a long, output-quiet tool call that #500 mislabeled as
  // waiting. The spinner heartbeat keeps the detector on "working".
  const mark = c.mark();
  submitLine(c, 'work');

  // Observe several seconds of spinner and assert the flag never went true — well
  // past the spinner-staleness window, so this genuinely exercises #500.
  await sleep(8000);
  const duringWork = c.statesSince(mark).filter(m => m.waiting === true);
  assert.strictEqual(duringWork.length, 0, `no waiting:true while the spinner runs (got ${duringWork.length})`);
  const midRest = await restState(s.id);
  assert.strictEqual(midRest.waitingForInput, false, 'busy mid-spinner per REST');

  // Once the spinner stops and the footer prints, the flag flips true (poll
  // directly rather than racing the stub's exact spin duration).
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true once the turn ends and the footer appears', 30000);
  assert.ok(c.raw.includes('work finished'), 'the turn had finished before the flag flipped');

  submitLine(c, '/exit');
});

test('glyph-only spinner (mid-2026 TUI): a waiting flag flips back to working', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });

  // Reach a decisive waiting:true first — this is the state every real session
  // passes through between turns, and where the hint-only marker froze it.
  let mark = c.mark();
  submitLine(c, 'idle');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true at the idle footer', 8000);

  // workmodern: glyph frames with NO "esc to interrupt". With the hint-only
  // spinner marker nothing ever refreshed lastSpinnerTime, classify returned
  // 'unknown' forever, and the flag stayed frozen at true for the whole turn —
  // the 2026-07-17 "every tab shows Action Required" bug. The glyph heartbeat
  // must flip it to working.
  mark = c.mark();
  submitLine(c, 'workmodern');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === false),
    'waiting:false once glyph frames arrive', 8000);
  const midRest = await restState(s.id);
  assert.strictEqual(midRest.waitingForInput, false, 'busy mid-glyph-spinner per REST');

  // And back to waiting when the turn ends and the footer repaints.
  await waitFor(() => c.statesSince(mark).filter(m => m.waiting === true).length >= 1,
    'waiting:true once the modern turn ends', 30000);
  assert.ok(c.raw.includes('work finished'), 'the turn had finished before the flag flipped');

  submitLine(c, '/exit');
});

test('anti-flicker: periodic non-spinner output at an idle footer does not toggle', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });

  // tick: draw the idle footer, then print a plain line every 2s. The old 2s
  // idle-timer toggled the flag on every burst; the screen-state detector sees
  // the footer stay put and holds waiting steady.
  const mark = c.mark();
  submitLine(c, 'tick');
  await sleep(11000);

  const states = c.statesSince(mark);
  const trues = states.filter(m => m.waiting === true).length;
  const falses = states.filter(m => m.waiting === false).length;
  assert.strictEqual(trues, 1, `exactly one waiting:true edge (got ${trues})`);
  assert.strictEqual(falses, 0, `no spurious waiting:false edges (got ${falses})`);

  submitLine(c, '/exit');
});
