/**
 * Standalone tombstone tests (#561).
 *
 * Like session-restore.test.js, this suite spawns its OWN throwaway daemon —
 * scratch $HOME, stub `claude` on PATH, random port — so it can SIGTERM and
 * relaunch the server and inspect/seed state.json directly on disk.
 *
 * What it proves (the #561 invariant):
 *   - A session record is never hard-deleted by any runtime path: REST close,
 *     killall, and clear-disconnected all leave a `closed: true` tombstone
 *     (keeping claudeSessionId/cwd/name/timestamps) instead of deleting.
 *   - A tombstone is restorable: reconnecting with the shell id resurrects the
 *     conversation via `--resume <claudeSessionId>`.
 *   - The retention sweep prunes ONLY closed tombstones past the window;
 *     non-closed entries are never pruned regardless of age.
 *   - state.json.bak rotates on every write and the loader falls back to it
 *     when state.json is corrupt.
 *   - Graceful shutdown still persists live sessions WITHOUT `closed` (they
 *     are restore candidates, not closes).
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/
 * or: sh test/run-standalone.sh
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

// Stub `claude` binary: logs argv, fails a --resume with no transcript on disk,
// otherwise acts like a live REPL (blocks on stdin, exits on /exit).
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
resume=""
prev=""
for a in "$@"; do
  [ "$prev" = "--resume" ] && resume="$a"
  prev="$a"
done
if [ -n "$resume" ]; then
  if ! ls "$HOME"/.claude/projects/*/"$resume".jsonl >/dev/null 2>&1; then
    echo "No conversation found with session ID: $resume"
    exit 1
  fi
fi
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

let tmpRoot;      // scratch root (removed in after())
let HOME;         // scratch $HOME the daemon and its PTYs see
let PORT;         // random free port
let BASE;         // http://127.0.0.1:PORT
let projDir;      // the "project" the sessions live in
let daemon = null;
let daemonLog = '';        // accumulated stdout+stderr across ALL daemon runs
let stubLogPath;           // $HOME/claude-invocations.log

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

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  // Don't leak the invoking environment into the daemon (see session-restore.test.js).
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // The killall test below needs the #562 gate open: POST /api/shells/killall is
  // 403 unless the daemon runs in test mode. Set AFTER the DEEPSTEVE_* scrub.
  env.DEEPSTEVE_TEST_MODE = '1';

  // Suppress the cold-start browser auto-open across restarts (see session-restore.test.js).
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  // --test-mode: this suite POSTs /api/shells/killall, which the server refuses
  // with 403 unless started in test mode (#562). The env-var form
  // (DEEPSTEVE_TEST_MODE=1) can't be used here because startDaemon strips every
  // DEEPSTEVE_* var above, so the CLI flag is the only path in. (#571)
  daemon = spawn('node', ['server.js', '--test-mode'], { cwd: REPO_ROOT, env });
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

const statePath = () => path.join(HOME, '.deepsteve', 'state.json');

function readState() {
  return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
}

function writeState(obj) {
  fs.writeFileSync(statePath(), JSON.stringify(obj, null, 2));
}

function stubLog() {
  try { return fs.readFileSync(stubLogPath, 'utf8'); } catch { return ''; }
}

async function apiGet(p) {
  const r = await fetch(`${BASE}${p}`, { headers: authHeaders() });
  return r.json();
}

async function apiPost(p) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: authHeaders() });
  return r.json();
}

// Claude Code's project-dir encoding (mirrors claudeProjectDir in server.js).
function transcriptPath(cwd, sessionId) {
  const enc = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(HOME, '.claude', 'projects', enc, `${sessionId}.jsonl`);
}

// Minimal WS client: connect with query params + bearer header, resolve on the
// first `session` message.
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
        if ((msg.type === 'session' || msg.type === 'gone') && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
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

let idA, claudeA;   // session closed via REST, then resurrected
let idB, claudeB;   // session killed via killall

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tombstone-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  // Inert `open`: the daemon's browser auto-open must never reach the real browser.
  fs.writeFileSync(
    path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n',
    { mode: 0o755 }
  );
  // Sessions spawn through `zsh -l -c 'claude …'`, so a login shell sources this
  // and finds the stub ahead of any real claude on the system.
  fs.writeFileSync(path.join(HOME, '.zprofile'), 'export PATH="$HOME/bin:$PATH"\n');
  stubLogPath = path.join(HOME, 'claude-invocations.log');
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  closeClients();
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('REST close leaves a restorable tombstone in state.json', async () => {
  const a = track(new Client());
  const sa = await a.connect({ cwd: projDir, new: '1', agentType: 'claude', name: 'tomb-a' });
  idA = sa.id; claudeA = sa.claudeSessionId;
  assert.ok(idA && claudeA, 'session created');

  const res = await apiPost(`/api/shells/${idA}/close`);
  assert.strictEqual(res.closed, idA);

  // closeSession() saves synchronously — the tombstone must be on disk already.
  const entry = readState()[idA];
  assert.ok(entry, 'state.json keeps the closed session');
  assert.strictEqual(entry.closed, true);
  assert.strictEqual(typeof entry.closedAt, 'number');
  assert.strictEqual(entry.closeReason, 'closed');
  assert.strictEqual(entry.claudeSessionId, claudeA, 'claudeSessionId preserved');
  assert.strictEqual(entry.cwd, projDir, 'cwd preserved');
  assert.strictEqual(entry.name, 'tomb-a', 'name preserved');
  closeClients();
});

test('a closed tombstone resurrects via --resume', async () => {
  // Give the closed session a transcript so --resume is viable.
  const p = transcriptPath(projDir, claudeA);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ sessionId: claudeA, type: 'user' }) + '\n');

  const a = track(new Client());
  const sa = await a.connect({ cwd: projDir, id: idA });
  assert.strictEqual(sa.type, 'session', 'tombstone restores instead of "gone"');
  assert.strictEqual(sa.id, idA);
  assert.strictEqual(sa.claudeSessionId, claudeA, 'resurrected with its own conversation');

  await waitFor(
    () => stubLog().split('\n').some(l => l.includes('--resume') && l.includes(claudeA)),
    `--resume ${claudeA} in the stub log`
  );
});

test('killall tombstones every session instead of deleting (#561)', async () => {
  const b = track(new Client());
  const sb = await b.connect({ cwd: projDir, new: '1', agentType: 'claude', name: 'tomb-b' });
  idB = sb.id; claudeB = sb.claudeSessionId;

  const res = await apiPost('/api/shells/killall');
  assert.ok(res.killed.some(k => k.id === idA), 'A killed');
  assert.ok(res.killed.some(k => k.id === idB), 'B killed');

  const shellsNow = await apiGet('/api/shells');
  assert.strictEqual(shellsNow.shells.filter(s => s.status === 'active').length, 0, 'nothing active');
  for (const id of [idA, idB]) {
    const t = shellsNow.shells.find(s => s.id === id);
    assert.ok(t, `${id} still listed`);
    assert.strictEqual(t.status, 'closed');
  }

  // killall persists immediately — the wipe scenario must be recoverable from disk.
  const state = readState();
  for (const [id, claude] of [[idA, claudeA], [idB, claudeB]]) {
    assert.strictEqual(state[id].closed, true, `${id} tombstoned on disk`);
    assert.strictEqual(state[id].closeReason, 'killed');
    assert.strictEqual(state[id].claudeSessionId, claude, `${id} keeps its conversation mapping`);
  }
  closeClients();
});

test('clear-disconnected marks closed, never hard-deletes', async () => {
  // Seed a non-closed saved entry (what a disconnected-but-restorable tab looks
  // like) alongside the killall tombstones, then boot on that state.
  await stopDaemon();
  const state = readState();
  state['fakedisc'] = {
    cwd: projDir, claudeSessionId: '11111111-2222-3333-4444-555555555555',
    agentType: 'claude', configDir: null, engineType: 'node-pty', worktree: null,
    name: 'disc', planMode: false, lastActivity: Date.now(), createdAt: Date.now(), windowId: null,
  };
  writeState(state);
  await startDaemon();

  const res = await apiPost('/api/shells/clear-disconnected');
  assert.ok(res.cleared.includes('fakedisc'), 'non-closed saved entry cleared');
  assert.ok(!res.cleared.includes(idA), 'existing tombstones are not re-cleared');

  const after = readState();
  const disc = after['fakedisc'];
  assert.ok(disc, 'cleared session still present in state.json');
  assert.strictEqual(disc.closed, true);
  assert.strictEqual(disc.closeReason, 'disconnected');
  for (const id of [idA, idB]) {
    assert.ok(after[id] && after[id].closed, `${id} tombstone survived clear-disconnected`);
  }
});

test('retention sweep prunes only closed tombstones past the window', async () => {
  await stopDaemon();
  const DAY = 24 * 60 * 60 * 1000;
  const state = readState();
  state[idA].closedAt = Date.now() - 31 * DAY;   // past the 30d default → pruned
  state[idB].closedAt = Date.now() - 1 * DAY;    // recent → kept
  state['ancient1'] = {                          // old but NOT closed → kept forever
    cwd: projDir, claudeSessionId: '99999999-8888-7777-6666-555555555555',
    agentType: 'claude', configDir: null, engineType: 'node-pty', worktree: null,
    name: 'ancient', planMode: false, lastActivity: Date.now() - 31 * DAY,
    createdAt: Date.now() - 31 * DAY, windowId: null,
  };
  writeState(state);
  await startDaemon();

  // The boot sweep runs ~10s after startup and saves when it prunes.
  await waitFor(() => !(idA in readState()), 'boot retention sweep to prune the old tombstone', 30000, 250);
  const after = readState();
  assert.ok(!(idA in after), 'expired tombstone pruned');
  assert.ok(after[idB] && after[idB].closed, 'recent tombstone kept');
  assert.ok(after['ancient1'] && !after['ancient1'].closed, 'old non-closed entry kept — never pruned');
  assert.ok(daemonLog.includes('[retention] pruned 1'), 'sweep logged what it removed');
});

test('a corrupt state.json recovers from state.json.bak', async () => {
  await stopDaemon();  // shutdown writes state.json and rotates .bak
  const good = readState();
  assert.ok(Object.keys(good).length > 0, 'precondition: state to recover');
  assert.ok(fs.existsSync(statePath() + '.bak'), '.bak rotated on write');
  fs.writeFileSync(statePath(), '{ this is not json');
  await startDaemon();

  assert.ok(daemonLog.includes('RECOVERED'), 'loader announced the .bak recovery');
  const shellsNow = await apiGet('/api/shells');
  for (const id of Object.keys(good)) {
    assert.ok(shellsNow.shells.some(s => s.id === id), `${id} recovered from .bak`);
  }
});

test('graceful shutdown persists live sessions WITHOUT closed (restore candidates)', async () => {
  const c = track(new Client());
  const sc = await c.connect({ cwd: projDir, new: '1', agentType: 'claude', name: 'tomb-c' });
  closeClients();
  await stopDaemon();

  const entry = readState()[sc.id];
  assert.ok(entry, 'live session persisted through shutdown');
  assert.ok(!entry.closed, 'shutdown is not a close — no tombstone flag');
  assert.strictEqual(entry.claudeSessionId, sc.claudeSessionId);
  // Leave the daemon stopped; after() handles cleanup.
});
