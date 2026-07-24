/**
 * The new-window path, server side (#597).
 *
 * The bug: window.open() from a same-origin page COPIES the opener's sessionStorage,
 * which holds deepsteve-window-id and deepsteve-tab-sessions. The ▾ new-tab menu's
 * "New window" opened `location.origin` with no ?fresh=1, so the new window booted
 * holding its PARENT's window id and tab list. Two browser windows then shared one
 * windowId — the server reassigns entry.windowId on every session-WS connect, so they
 * fought over the same PTYs, and per-window delivery had nowhere unambiguous to route.
 *
 * Honest boundary: this suite proves the server honors distinct window ids and routes
 * per window. It cannot MINT them — that half is browser sessionStorage, covered by
 * test/unit/fresh-window-reset.test.js (the reset defeats a cloned store) and
 * test/unit/new-window.test.js (both affordances request a fresh window). Together
 * those are the end-to-end path, split at the one seam with no automation harness in
 * this repo. Deliberately no Playwright/Puppeteer: the entire browser-side surface is
 * three sessionStorage keys and a URL flag.
 *
 * Spawns its OWN throwaway daemon — scratch $HOME, stub `claude` on PATH, random port.
 *
 * Run: sh test/run-standalone.sh
 *   or: node --test --test-timeout=180000 test/integration-standalone/new-window.test.js
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
// guards, because a test suite must never hijack the screen of whoever runs it — and a
// suite about opening windows least of all: the .restarting marker the server already
// honors, and a no-op `open` first on the daemon's PATH. openLog() asserts it stayed unused.
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

async function getWindows() {
  const r = await fetch(`${BASE}/api/windows`, { headers: authHeaders() });
  assert.ok(r.ok, `GET /api/windows -> ${r.status}`);
  return r.json();
}

function findWindow(payload, windowId) {
  return payload.windows.find(w => w.windowId === windowId) || null;
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

// A live-reload socket is what a browser window IS, as far as the server is concerned:
// it carries the windowId, drives `live`, and is where deliverToWindow routes.
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

let clients = [];
let sockets = [];
function track(c) { clients.push(c); return c; }

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-newwin-'));
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

  // An automation to drive per-window delivery with. Must exist before startDaemon().
  fs.mkdirSync(path.join(HOME, '.deepsteve', 'automations'), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, '.deepsteve', 'automations', 'route-test.md'),
    `---\nname: Route Test\nrepo: ${projDir}\n---\nhello\n`
  );

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

test('two windows with distinct ids stay two windows', async () => {
  // What the ▾ menu's New Window was supposed to produce all along, and what the
  // sessionStorage clone destroyed: two independent windows, each owning its own tabs.
  const rcA = await reloadClient('win-a');
  const rcB = await reloadClient('win-b');
  sockets.push(rcA, rcB);

  const a = track(new Client());
  const b = track(new Client());
  const sa = await a.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-a' });
  const sb = await b.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-b' });

  const payload = await waitFor(async () => {
    const p = await getWindows();
    return findWindow(p, 'win-a')?.live && findWindow(p, 'win-b')?.live ? p : null;
  }, 'both windows to be seen as live');

  assert.deepStrictEqual(findWindow(payload, 'win-a').sessions.map(s => s.id), [sa.id]);
  assert.deepStrictEqual(findWindow(payload, 'win-b').sessions.map(s => s.id), [sb.id]);
  // Both live means neither is offered to the other for restore — the restore modal's
  // whole premise is that a window with no reload socket is a lost one.
  assert.strictEqual(findWindow(payload, 'win-a').live, true);
  assert.strictEqual(findWindow(payload, 'win-b').live, true);
});

test('a shared window id collapses them into one — the shape the client fix prevents', async () => {
  // The anti-case, pinned so the consequence of a cloned sessionStorage is written down
  // somewhere executable. Two browser windows connecting under one id are, to the
  // server, one window with two tabs — so each would restore the other's sessions, and
  // deliverToWindow has two equally valid sockets to pick from.
  const c = track(new Client());
  const sc = await c.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-a' });

  const one = findWindow(await getWindows(), 'win-a');
  assert.strictEqual(one.sessions.length, 2, 'indistinguishable from one window with two tabs');
  assert.ok(one.sessions.some(s => s.id === sc.id));
});

test('per-window delivery reaches the window that asked, and only that one', async () => {
  // The user-visible payoff of distinct ids: a tab opens where you asked for it.
  // deliverToWindow broadcasts to EVERY client when no reload client matches the target
  // (server.js), so a duplicated or stale id is exactly what this catches.
  const rcA = await reloadClient('win-route-a');
  const rcB = await reloadClient('win-route-b');
  sockets.push(rcA, rcB);

  const r = await fetch(`${BASE}/api/start-automation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ automationId: 'route-test', windowId: 'win-route-b' }),
  });
  assert.ok(r.ok, `POST /api/start-automation -> ${r.status}`);

  const msg = await waitFor(
    () => rcB.messages.find(m => m.type === 'open-session') || null,
    'win-route-b to receive its open-session frame'
  );
  assert.strictEqual(msg.windowId, 'win-route-b');
  assert.ok(!rcA.messages.some(m => m.type === 'open-session'),
    "win-route-a must not receive win-route-b's tab");
});

test('the suite never opens a real browser', () => {
  assert.strictEqual(openLog(), '', `open was invoked: ${openLog()}`);
});
