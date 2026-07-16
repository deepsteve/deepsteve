/**
 * Deterministic repros for the BEL-gated waitingForInput classifier (#558 research).
 *
 * Spawns its own throwaway daemon (scratch $HOME, random port, stub `claude`)
 * and drives the classifier through the real WS input path — the same path a
 * typing user takes. The stub agent is command-driven over its stdin:
 *
 *   bell      -> prints output then a bare BEL (a real "turn done" readiness bell)
 *   osc       -> prints an OSC title update (BEL-terminated), then "works" silently
 *   tickbell  -> prints a bare BEL, then a burst of output every 3s (flicker)
 *   /exit     -> exits
 *
 * What each test demonstrates (findings, not fixes — this branch is research-only):
 *   0. Baseline: bell -> 2s silence -> waiting:true. The happy path works.
 *   A. Lead 1 (stuck-false): a single keystroke after the bell clears the flag
 *      and nothing can ever set it again — the half-typed tab never shows waiting.
 *   B. Lead 2 (corrected): emitsBel=false sessions (terminal) are never classified
 *      at all — a bare BEL + long silence never flips the flag.
 *   C. Lead 3 (premature-true): an OSC title terminator counts as a readiness
 *      bell, so a quiet "working" stretch right after it flags waiting.
 *   D. Lead 4 (flicker): periodic output while genuinely waiting toggles the flag
 *      repeatedly, in episodes shorter than the client's 10s notification cooldown.
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

const CLAUDE_STUB = `#!/bin/bash
printf 'stub claude ready\\n'
while IFS= read -r line; do
  case "$line" in
    *"/exit"*) exit 0 ;;
    *tickbell*) ( printf '\\a'; for i in 1 2 3 4 5; do sleep 3; printf 'tick %s\\n' "$i"; done ) & ;;
    *bell*) printf 'turn done\\n\\a' ;;
    *osc*) printf '\\033]0;stub-title\\007'; sleep 8; printf 'work finished\\n' ;;
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

// Audit JSONL written by the daemon (scratch HOME) — the same file the
// production tagalong will produce.
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

// The stub replies to a command only when the newline lands — write text and \r
// separately like a real submit (Ink-style), but a plain \n works for bash read.
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

test('baseline: bare bell + 2s silence flips waiting:true; REST and /api/shells agree', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });

  // Startup: "stub claude ready" then silence with NO bell ever -> the !bellEver
  // fallback flips waiting:true ~2s in. Wait it out so later marks are clean.
  await waitFor(() => c.statesSince(0).some(m => m.waiting === true),
    'startup silence-fallback waiting:true', 8000);

  const mark = c.mark();
  submitLine(c, 'bell');
  // Input clears the flag, then: echo + "turn done" + BEL -> 2s silence -> true.
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true after bare bell', 8000);

  const rest = await restState(s.id);
  assert.strictEqual(rest.waitingForInput, true, 'REST /state agrees');
  assert.ok(rest.lastBelTime > 0, '/state exposes lastBelTime');
  assert.ok(rest.lastInputTime > 0, '/state exposes lastInputTime');

  const shellsList = (await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json()).shells;
  const row = shellsList.find(sh => sh.id === s.id);
  assert.strictEqual(row.waitingForInput, true, '/api/shells carries waitingForInput');
  assert.ok(row.lastBelTime > 0, '/api/shells carries lastBelTime');

  // Audit recorded the bare bell as bare, not OSC.
  const bels = auditEvents().filter(e => e.event === 'bels' && e.shell === s.id);
  assert.ok(bels.some(e => e.bare >= 1), 'audit classified a bare BEL');

  submitLine(c, '/exit');
});

test('Lead 1 (stuck-false): one keystroke after the bell hides "waiting" forever', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  await waitFor(() => c.statesSince(0).some(m => m.waiting === true),
    'startup waiting:true', 8000);

  // Reach a genuine waiting state via a real bell.
  let mark = c.mark();
  submitLine(c, 'bell');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true after bell', 8000);

  // The user starts typing a reply and stops — one character, no submit.
  // The stub sits at its read loop the entire time: factually waiting for input.
  mark = c.mark();
  c.sendRaw('g');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === false),
    'keystroke clears waiting', 5000);

  // 10s window: the flag must never come back (echo re-armed the idle timer,
  // which fired with bellSinceInput=false and gave up; no new BEL will ever fire).
  await sleep(10000);
  const trues = c.statesSince(mark).filter(m => m.waiting === true);
  assert.strictEqual(trues.length, 0, `no waiting:true for 10s (got ${trues.length})`);
  const rest = await restState(s.id);
  assert.strictEqual(rest.waitingForInput, false, 'REST /state still false');

  // The audit caught the classifier declining to flip: the stuck-false smoking gun.
  const noFlips = auditEvents().filter(e =>
    e.event === 'idle-no-flip' && e.shell === s.id && e.bellSinceInput === false);
  assert.ok(noFlips.length >= 1, 'audit recorded idle-no-flip with bellSinceInput:false');

  submitLine(c, '/exit');
});

test('Lead 2 (corrected): emitsBel=false sessions are never classified at all', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'terminal' });
  assert.strictEqual(s.agentType, 'terminal');

  // Let the shell settle at its prompt, then ring a genuine bare bell.
  await sleep(2000);
  const mark = c.mark();
  submitLine(c, "printf 'ding\\a'");

  // Bare BEL + >6s of silence at the prompt: for a claude session this is the
  // strongest possible "waiting" signal. For a terminal session: nothing.
  await sleep(6500);
  const states = c.statesSince(mark);
  assert.strictEqual(states.length, 0,
    `terminal session never gets a state message (got ${JSON.stringify(states)})`);
  const rest = await restState(s.id);
  assert.strictEqual(rest.waitingForInput, false, 'REST /state permanently false');

  // The bell DID happen — the audit's non-claude channel saw it.
  const bels = auditEvents().filter(e => e.event === 'bel-nonclaude' && e.shell === s.id);
  assert.ok(bels.some(e => e.bare >= 1), 'audit recorded the unclassified bare bell');
});

test('Lead 3 (premature-true): an OSC title terminator counts as a readiness bell', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  await waitFor(() => c.statesSince(0).some(m => m.waiting === true),
    'startup waiting:true', 8000);

  // Make bellEver=true via a real bell first, so the flip below can ONLY come
  // from the bellSinceInput branch (never the !bellEver fallback) — isolating
  // the OSC terminator as the cause.
  let mark = c.mark();
  submitLine(c, 'bell');
  await waitFor(() => c.statesSince(mark).some(m => m.waiting === true),
    'waiting:true after real bell', 8000);

  // Submit "osc": the stub emits a BEL-terminated title update, then works
  // silently for 8s. The submit sets lastInputTime AFTER the last real bell, so
  // without the OSC bell the classifier would (correctly) refuse to flip.
  mark = c.mark();
  const beforeRaw = c.raw.length;
  submitLine(c, 'osc');
  const flip = await waitFor(() => c.statesSince(mark).find(m => m.waiting === true),
    'premature waiting:true during silent work', 8000);

  // The flip happened while the agent was still mid-work: "work finished" had
  // not yet been printed when the state message arrived.
  const rawAtFlip = c.raw.slice(beforeRaw, flip._rawLen);
  assert.ok(!rawAtFlip.includes('work finished'),
    'flag flipped before the work output arrived');

  // Audit attribution: the triggering chunk contained an OSC terminator and no
  // bare bell, and the flip came via bellSinceInput (not the !bellEver fallback).
  const events = auditEvents().filter(e => e.shell === s.id);
  const oscBels = events.filter(e => e.event === 'bels' && e.osc >= 1 && e.bare === 0);
  assert.ok(oscBels.length >= 1, 'audit classified the OSC terminator (osc>=1, bare=0)');
  const flips = events.filter(e =>
    e.event === 'transition' && e.to === true && e.via === 'idle-timer');
  assert.strictEqual(flips[flips.length - 1].bellSinceInput, true,
    'flip came from bellSinceInput — the OSC bell satisfied the gate');

  await waitFor(() => c.raw.includes('work finished'), 'stub finishes its work', 12000);
  submitLine(c, '/exit');
});

test('Lead 4 (flicker): periodic output while waiting toggles the flag repeatedly', async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  await waitFor(() => c.statesSince(0).some(m => m.waiting === true),
    'startup waiting:true', 8000);

  // Bell once (bellSinceInput stays true throughout), then output every 3s:
  // each burst clears the flag, each 2s gap re-flips it.
  const mark = c.mark();
  submitLine(c, 'tickbell');
  await sleep(17000);

  const states = c.statesSince(mark);
  const trues = states.filter(m => m.waiting === true).length;
  const falses = states.filter(m => m.waiting === false).length;
  assert.ok(trues >= 3, `>=3 waiting:true edges in 17s (got ${trues})`);
  assert.ok(falses >= 3, `>=3 waiting:false edges in 17s (got ${falses})`);

  submitLine(c, '/exit');
});
