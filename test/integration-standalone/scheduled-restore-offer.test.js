/**
 * Scheduled runs must never be offered as lost sessions (#597).
 *
 * A scheduled task fires unattended: runTask() spawns with windowId: null and queues
 * its tab via deliverToWindow(..., null) → pendingOpens, which flushes to whichever
 * browser connects next. Between fire and browser attach the session is live, has no
 * windowId and has no attached clients — which is exactly buildWindowsView()'s test for
 * "orphan", so it landed in the `ungrouped` bucket of GET /api/recoverable-sessions.
 * The restore modal puts ungrouped rows in tier 1 checked-by-default and auto-shows on
 * any non-empty windows+ungrouped, so opening a browser while a scheduled run was in
 * flight popped a modal offering to "restore" a session that was about to appear as a
 * tab beside it.
 *
 * The fix is a `scheduled: true` flag on the shell entry (persisted by
 * serializeShellEntry) which buildWindowsView excludes from `ungrouped` — and ONLY
 * from `ungrouped`. Once a window attaches, entry.windowId is set and the session
 * groups normally, so a crash of that window still offers it back.
 *
 * Spawns its OWN throwaway daemon — scratch $HOME, stub `claude` on PATH, random port.
 *
 * Run: sh test/run-standalone.sh
 *   or: node --test --test-timeout=180000 test/integration-standalone/scheduled-restore-offer.test.js
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

// Minimal live-REPL stub: block on stdin, exit on /exit so shutdown stays quick.
const CLAUDE_STUB = `#!/bin/bash
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

let tmpRoot, HOME, PORT, BASE, projDir;
let daemon = null;

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

function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
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

// server.js schedules a 5s "no browser connected → open the default browser" timer on
// every cold start, and `open` is NOT sandboxed by our scratch HOME. Two independent
// guards, because a test suite must never hijack the screen of whoever runs it:
// the .restarting marker the server already honors, and a no-op `open` first on PATH.
function suppressBrowserAutoOpen() {
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
}

function openLog() {
  try { return fs.readFileSync(path.join(HOME, 'open-invocations.log'), 'utf8'); } catch { return ''; }
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  // tmux's default socket is per-UID, NOT per-HOME (see CLAUDE.md): without this a
  // scratch-HOME daemon destroys the real daemon's ds-* sessions as "orphans".
  const tmuxTmp = path.join(HOME, 'tmux-tmp');
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  env.TMUX_TMPDIR = tmuxTmp;

  suppressBrowserAutoOpen();
  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', () => {});
  daemon.stderr.on('data', () => {});

  await waitFor(async () => {
    if (!authToken()) return false;
    const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
    return r.ok;
  }, 'daemon to become ready');

  // Mod routes are registered by initMCP, which finishes AFTER /api/version starts
  // answering — so readiness has to be the scheduled-tasks route itself, or the first
  // test races it and gets a 404.
  await waitFor(async () => {
    const r = await fetch(`${BASE}/api/scheduled-tasks`, { headers: authHeaders() });
    return r.ok;
  }, 'the scheduled-tasks mod routes to register');
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

async function getRecoverable() {
  const r = await fetch(`${BASE}/api/recoverable-sessions`, { headers: authHeaders() });
  assert.ok(r.ok, `GET /api/recoverable-sessions -> ${r.status}`);
  return r.json();
}

function inUngrouped(payload, id) {
  return payload.ungrouped.some(s => s.id === id);
}

function windowFor(payload, id) {
  return payload.windows.find(w => w.sessions.some(s => s.id === id)) || null;
}

// Session WS client. Resolves on the first `session` message.
class Client {
  constructor() { this.ws = null; this.session = null; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; } // raw PTY output
        if (msg && msg.type === 'session' && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

// A live-reload socket is what makes a window look "live" to the server, and it is
// what pendingOpens flushes to. Collect its frames so delivery is assertable.
function reloadClient(windowId) {
  const ws = new WebSocket(
    `${BASE.replace(/^http/, 'ws')}/?action=reload&windowId=${encodeURIComponent(windowId)}`,
    { headers: authHeaders() }
  );
  ws.messages = [];
  ws.on('message', (d) => { try { ws.messages.push(JSON.parse(d.toString())); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function createScheduledTask(title) {
  const r = await fetch(`${BASE}/api/scheduled-tasks`, {
    method: 'POST',
    headers: jsonHeaders(),
    // A cron far in the future: this suite fires every run by hand, so the scheduler
    // tick must never surprise it with a second session.
    body: JSON.stringify({ title, prompt: 'hello', cron: '0 4 1 1 *', project: projDir, isolateWorktree: false }),
  });
  assert.ok(r.ok, `POST /api/scheduled-tasks -> ${r.status}`);
  return (await r.json()).task;
}

async function runNow(taskId) {
  const r = await fetch(`${BASE}/api/scheduled-tasks/${taskId}/run`, { method: 'POST', headers: authHeaders() });
  assert.ok(r.ok, `POST /api/scheduled-tasks/${taskId}/run -> ${r.status}`);
  const body = await r.json();
  assert.ok(body.sessionId, 'run started and returned a sessionId');
  return body.sessionId;
}

let clients = [];
let sockets = [];
function track(c) { clients.push(c); return c; }

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-offer-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  // Inert `open`: records the attempt instead of hijacking the real browser.
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
  for (const c of clients) c.close();
  for (const s of sockets) { try { s.close(); } catch {} }
  clients = []; sockets = [];
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a queued scheduled run is known, but never offered as a lost session', async () => {
  // THE regression test, in the exact state the bug was reported from: a run fires with
  // no browser connected at all, so its tab is sitting in pendingOpens.
  const task = await createScheduledTask('Queued run');
  const sessionId = await runNow(task.id);

  const payload = await getRecoverable();
  assert.ok(payload.knownSessionIds.includes(sessionId),
    'still a known session — suppression must not reach knownSessionIds, or mergeWindows ' +
    'starts pruning live sessions out of localStorage window groups');
  assert.ok(!inUngrouped(payload, sessionId), 'not offered as an orphan');
  assert.strictEqual(windowFor(payload, sessionId), null, 'and belongs to no window yet');
});

test('the flag is persisted, so it survives into savedState', async () => {
  const task = await createScheduledTask('Persisted flag');
  const sessionId = await runNow(task.id);

  const entry = await waitFor(() => readState()[sessionId] || null, 'the run to reach state.json');
  assert.strictEqual(entry.scheduled, true,
    'serializeShellEntry must carry `scheduled` — a daemon restart leaves the run ' +
    'windowId-less in savedState, where buildWindowsView reads it straight off disk');
  assert.strictEqual(entry.windowId, null, 'unattended: no window owns it');
});

test('still not offered once the tab has been handed to a browser', async () => {
  // The window in which the old bug actually bit: the daemon has delivered the tab, but
  // the browser has not yet opened its session socket, so clients.size is still 0.
  const task = await createScheduledTask('Delivered run');
  const rc = await reloadClient('win-deliver');
  sockets.push(rc);

  const sessionId = await runNow(task.id);
  await waitFor(() => rc.messages.some(m => m.type === 'open-session' && m.id === sessionId),
    'win-deliver to receive the open-session frame');

  const payload = await getRecoverable();
  assert.ok(!inUngrouped(payload, sessionId), 'delivered-but-unattached is not an orphan');
});

test('attaching a window ends the special case — it groups like any session', async () => {
  // Suppression is scoped to the unattached window. Once a browser owns the tab the
  // session must be recoverable again, or a crash of THAT window would strand it.
  const task = await createScheduledTask('Attached run');
  const sessionId = await runNow(task.id);

  const c = track(new Client());
  await c.connect({ cwd: projDir, id: sessionId, windowId: 'win-attached' });

  const payload = await waitFor(async () => {
    const p = await getRecoverable();
    return windowFor(p, sessionId) ? p : null;
  }, 'the run to join win-attached');

  assert.strictEqual(windowFor(payload, sessionId).windowId, 'win-attached');
  assert.ok(!inUngrouped(payload, sessionId), 'grouped sessions are never also ungrouped');
});

test('ordinary windowId-less sessions are still offered (guards against over-fixing)', async () => {
  // The `ungrouped` bucket exists for a reason. Only the scheduled flag suppresses.
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' }); // no windowId
  c.close();

  const payload = await waitFor(async () => {
    const p = await getRecoverable();
    return inUngrouped(p, s.id) ? p : null;
  }, 'the unattached session to be offered as ungrouped');

  assert.ok(inUngrouped(payload, s.id));
  assert.strictEqual(readState()[s.id]?.scheduled, false, 'and it carries scheduled: false');
});

test('the suite never opens a real browser', () => {
  assert.strictEqual(openLog(), '', `open was invoked: ${openLog()}`);
});
