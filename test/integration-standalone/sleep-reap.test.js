/**
 * Standalone sleep-resilience tests (#563).
 *
 * Spawns its own throwaway daemon (scratch $HOME, stub `claude`, random port)
 * with a short detach grace and post-wake holdoff, then simulates system sleep
 * by SIGSTOP/SIGCONT-ing the daemon — from the daemon's point of view that is
 * exactly what sleep looks like (all timers frozen, then everything overdue at
 * once).
 *
 * What it proves:
 *   - A detached session still reaps after the grace period on an awake system
 *     (the baseline behavior is unchanged).
 *   - A reap that would fire across/right after a sleep is deferred, so a
 *     post-wake reconnect wins the race against the reaper (the #563 fix).
 *   - When no client returns within the holdoff, the session is reaped and
 *     stays a restore candidate (no `closed` flag) — not leaked forever.
 *   - {type:'ping'} probes are answered with {type:'pong'}, advertised via the
 *     session message's pingPong flag, and never reach the agent's stdin.
 *   - (darwin only) the daemon holds a caffeinate power assertion exactly while
 *     sessions exist and the preventSleepWhileActive setting is on.
 *
 * Run: sh test/run-standalone.sh
 *  or: node --test --test-timeout=180000 test/integration-standalone/sleep-reap.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DETACH_GRACE_MS = 3000;
const DETACH_HOLDOFF_MS = 10000;
// sleep-watch's default discontinuity threshold is tickMs+gapMs = 20s; freeze
// comfortably longer than that.
const FREEZE_MS = 25000;

// Stub `claude`: acts like a live REPL (blocks on stdin, exits on /exit) and
// logs every stdin line so tests can prove control messages never reach the PTY.
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$HOME/claude-stdin.log"
  case "$line" in *"/exit"*) exit 0 ;; esac
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
  // Short grace/holdoff so the suite runs in seconds (re-added after the
  // DEEPSTEVE_* hygiene sweep above).
  env.DEEPSTEVE_DETACH_GRACE_MS = String(DETACH_GRACE_MS);
  env.DEEPSTEVE_DETACH_HOLDOFF_MS = String(DETACH_HOLDOFF_MS);

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

function readState() {
  return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));
}

async function shellIsActive(id) {
  const r = await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json();
  return r.shells.some(sh => sh.id === id && sh.status === 'active');
}

function stdinLog() {
  try { return fs.readFileSync(path.join(HOME, 'claude-stdin.log'), 'utf8'); } catch { return ''; }
}

function daemonMark() { return daemonLog.length; }
function daemonSince(mark) { return daemonLog.slice(mark); }

// Minimal WS client (same shape as session-restore.test.js).
class Client {
  constructor() {
    this.ws = null;
    this.messages = [];
    this.session = null;
  }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; } // raw PTY output
        if (typeof msg !== 'object' || msg === null) return;
        this.messages.push(msg);
        if (msg.type === 'session' && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  sendJSON(obj) { this.ws.send(JSON.stringify(obj)); }
  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

let clients = [];
function track(c) { clients.push(c); return c; }
function closeClients() {
  for (const c of clients) c.close();
  clients = [];
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sleep-'));
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
});

after(async () => {
  closeClients();
  if (daemon) { try { daemon.kill('SIGCONT'); } catch {} } // in case a test died mid-freeze
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('session message advertises pingPong; ping echoes pong without touching the PTY', async () => {
  const a = track(new Client());
  const sa = await a.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  assert.strictEqual(sa.pingPong, true, 'session message carries pingPong: true');

  a.sendJSON({ type: 'ping' });
  await waitFor(() => a.messages.some(m => m.type === 'pong'), 'pong reply');

  // The probe must never be typed into the agent: give any stray PTY write a
  // moment to land, then check the stub's stdin log.
  await sleep(1000);
  assert.ok(!stdinLog().includes('ping'), 'ping JSON did not reach the agent stdin');
  // Keep this session open for the caffeinate test at the end of the suite.
});

test('baseline: a detached session reaps after the grace period on an awake system', async () => {
  const b = new Client();
  const sb = await b.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  b.close();
  await waitFor(async () => !(await shellIsActive(sb.id)), 'detached session to reap',
    DETACH_GRACE_MS + 8000);
  const entry = readState()[sb.id];
  assert.ok(entry, 'reaped session persisted to state.json');
  assert.ok(!entry.closed, 'disconnect-reap keeps the session a restore candidate');
});

test('simulated sleep defers the reap and a post-wake reconnect wins', async () => {
  const c = new Client();
  const sc = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  const mark = daemonMark();

  c.close();
  await sleep(500); // let the server see the close and arm the grace timer
  process.kill(daemon.pid, 'SIGSTOP');
  await sleep(FREEZE_MS);
  process.kill(daemon.pid, 'SIGCONT');

  // On resume the overdue grace timer fires almost immediately; the fix must
  // notice the discontinuity (via sleep-watch or the timer's own lateness) and
  // defer instead of reaping.
  await waitFor(() => daemonSince(mark).includes('detach reap deferred'), 'reap deferral log', 10000);
  assert.ok(daemonSince(mark).includes('[sleep-watch] wake detected'), 'wake was detected');

  // Reconnect inside the holdoff — this must find the session alive.
  const c2 = track(new Client());
  const sc2 = await c2.connect({ cwd: projDir, id: sc.id });
  assert.strictEqual(sc2.id, sc.id, 'reconnected to the same session');
  assert.ok(await shellIsActive(sc.id), 'session survived the sleep');
  assert.ok(!sc2.restored, 'live reconnect, not a respawn from disk');
});

test('holdoff expiry: with no client back, the session reaps and stays restorable', async () => {
  const d = new Client();
  const sd = await d.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  const mark = daemonMark();

  d.close();
  await sleep(500);
  process.kill(daemon.pid, 'SIGSTOP');
  await sleep(FREEZE_MS);
  process.kill(daemon.pid, 'SIGCONT');

  await waitFor(() => daemonSince(mark).includes('detach reap deferred'), 'reap deferral log', 10000);
  // No reconnect this time: after the holdoff elapses the reap must proceed.
  await waitFor(async () => !(await shellIsActive(sd.id)), 'session to reap after holdoff',
    DETACH_HOLDOFF_MS + 15000);
  const entry = readState()[sd.id];
  assert.ok(entry, 'reaped session persisted to state.json');
  assert.ok(!entry.closed, 'still a restore candidate');
});

test('caffeinate power assertion tracks sessions and the setting', { skip: process.platform !== 'darwin' }, async () => {
  const caffeinatePids = () => {
    try {
      // BSD pgrep: options must precede the pattern (-P is silently ignored otherwise)
      return execSync(`pgrep -x -P ${daemon.pid} caffeinate`, { stdio: 'pipe' })
        .toString().trim().split('\n').filter(Boolean);
    } catch {
      return []; // pgrep exits 1 on no match
    }
  };

  // The suite's first session is still open → the 5s reconcile tick must have
  // acquired (or soon acquire) the assertion.
  await waitFor(() => caffeinatePids().length === 1, 'caffeinate child while sessions active', 10000, 250);

  // Toggling the setting off releases immediately (POST triggers a sync).
  let r = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ preventSleepWhileActive: false }),
  });
  assert.ok(r.ok);
  await waitFor(() => caffeinatePids().length === 0, 'caffeinate released on toggle-off', 5000, 250);

  // Toggling back on re-acquires while sessions exist.
  r = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ preventSleepWhileActive: true }),
  });
  assert.ok(r.ok);
  await waitFor(() => caffeinatePids().length === 1, 'caffeinate re-acquired on toggle-on', 10000, 250);

  // Closing the last session releases within a reconcile tick. (Other tests'
  // sessions have already been reaped; only the suite-long one remains.)
  const shellsNow = await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json();
  for (const sh of shellsNow.shells) {
    if (sh.status !== 'active') continue;
    await fetch(`${BASE}/api/shells/${sh.id}`, { method: 'DELETE', headers: authHeaders() });
  }
  closeClients();
  await waitFor(() => caffeinatePids().length === 0, 'caffeinate released when no sessions remain', 15000, 250);
});
