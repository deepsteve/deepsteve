/**
 * Standalone window→session map tests (#551).
 *
 * Like session-restore.test.js, this spawns its OWN throwaway daemon — scratch
 * $HOME, stub `claude` on PATH, random port — so it can restart the server and
 * wait out the 30s disconnect grace without touching a real install.
 *
 * What it proves:
 *   - The window→session map is derivable server-side: windowId is already
 *     persisted per session, so grouping needs no separate store.
 *   - The root cause of #551: ws.on('close') hand-rolled its savedState entry and
 *     dropped windowId (plus engineType/createdAt). Closing a browser window and
 *     waiting out the grace period erased that window's grouping from disk — no
 *     origin change required. saveState() merges {...savedState, ...liveShells},
 *     so once the shell is deleted the stripped entry is what reaches state.json.
 *   - GET /api/windows separates grouping from existence: `windows` answers "who
 *     owns what" (and must skip windowId-less sessions), `knownSessionIds` answers
 *     "does this still exist" (and must not).
 *   - Claiming a window needs no API call: reconnecting a session with a new
 *     windowId reassigns ownership server-side.
 *
 * Run: sh test/run-standalone.sh
 *   or: node --test --test-timeout=180000 test/integration-standalone/window-restore.test.js
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
// This suite never exercises resume failure modes, so it needs no control knobs.
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
// every cold start, and `open` is NOT sandboxed by our scratch HOME — it hits the
// developer's real browser, once per daemon start. Two independent guards, because a
// test suite must never be able to hijack the screen of whoever runs it:
//   1. plant the .restarting marker the server already honors to skip auto-open
//      (the server unlinks it during startup, so re-plant before EVERY spawn), and
//   2. put a no-op `open` first on the daemon's PATH, so even if that check ever
//      regresses the exec is inert. openLog() asserts it stayed unused.
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
  // exec() runs via /bin/sh, which resolves `open` from this PATH (not .zprofile).
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  // Isolate tmux's socket: its default socket is per-UID, NOT per-HOME (see CLAUDE.md),
  // so a scratch-HOME daemon otherwise shares the real user's tmux socket, sees the real
  // daemon's ds-* sessions, and destroys them as "orphans" on startup (#570). Explicitly
  // override any TMUX_TMPDIR inherited via {...process.env}.
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

function readState() {
  return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));
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

// A live-reload socket is what makes a window look "live" to the server.
function reloadClient(windowId) {
  const ws = new WebSocket(
    `${BASE.replace(/^http/, 'ws')}/?action=reload&windowId=${encodeURIComponent(windowId)}`,
    { headers: authHeaders() }
  );
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

let clients = [];
function track(c) { clients.push(c); return c; }
function closeClients() { for (const c of clients) c.close(); clients = []; }

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-windows-'));
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
  closeClients();
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('sessions are grouped by the windowId they connected with', async () => {
  const a = track(new Client());
  const b = track(new Client());
  const c = track(new Client());
  const sa = await a.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-one' });
  const sb = await b.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-one' });
  const sc = await c.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-two' });

  const payload = await getWindows();
  const one = findWindow(payload, 'win-one');
  const two = findWindow(payload, 'win-two');

  assert.ok(one, 'win-one is derived from its sessions alone — no window store');
  assert.deepStrictEqual(one.sessions.map(s => s.id).sort(), [sa.id, sb.id].sort());
  assert.deepStrictEqual(two.sessions.map(s => s.id), [sc.id]);
  assert.ok(one.sessions.every(s => s.status === 'active'));

  for (const id of [sa.id, sb.id, sc.id]) {
    assert.ok(payload.knownSessionIds.includes(id), `knownSessionIds lists ${id}`);
  }
});

test('live reflects whether a reload client holds that windowId', async () => {
  let payload = await getWindows();
  assert.strictEqual(findWindow(payload, 'win-one').live, false, 'no reload client yet');

  const rc = await reloadClient('win-one');
  payload = await waitFor(async () => {
    const p = await getWindows();
    return findWindow(p, 'win-one').live ? p : null;
  }, 'win-one to be seen as live');
  assert.strictEqual(findWindow(payload, 'win-one').live, true);
  assert.strictEqual(findWindow(payload, 'win-two').live, false, 'other windows unaffected');

  rc.close();
  await waitFor(async () => {
    const p = await getWindows();
    return findWindow(p, 'win-one').live === false;
  }, 'win-one to go back to not-live');
});

test('origin change: a client with no localStorage still sees the whole window', async () => {
  // Nothing about this request carries client state — which is the point. A browser
  // on a brand-new origin, with an empty jar, gets the full grouping back.
  const payload = await getWindows();
  const one = findWindow(payload, 'win-one');
  assert.strictEqual(one.sessions.length, 2, 'both tabs offered as one window');
  assert.strictEqual(one.live, false, 'and it is claimable');
});

test('closing a tab keeps windowId on disk but drops it from restore candidates', async () => {
  const victim = track(new Client());
  const s = await victim.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-closed' });
  assert.ok(findWindow(await getWindows(), 'win-closed'), 'present while open');

  victim.close();
  const r = await fetch(`${BASE}/api/shells/${s.id}?force=1`, { method: 'DELETE', headers: authHeaders() });
  assert.ok(r.ok, `DELETE -> ${r.status}`);

  // The serializer fix means a closed entry KEEPS its windowId (it no longer
  // hand-rolls a stripped entry)...
  await waitFor(() => readState()[s.id]?.closed === true, 'the close to reach state.json');
  const entry = readState()[s.id];
  assert.strictEqual(entry.windowId, 'win-closed', 'closed entry retains windowId');
  assert.ok('engineType' in entry, 'closed entry retains engineType');

  // ...but closing a tab is deliberate, so it must not be offered for restore.
  const payload = await getWindows();
  assert.strictEqual(findWindow(payload, 'win-closed'), null, 'closed window not offered');
  assert.ok(!payload.knownSessionIds.includes(s.id), 'and not a known session');
});

test('reconnecting under a new windowId reassigns ownership — claim needs no API call', async () => {
  const mover = track(new Client());
  const s = await mover.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-from' });
  assert.ok(findWindow(await getWindows(), 'win-from'), 'starts in win-from');

  // Exactly what restoreSessions does after claimWindow: reconnect with OUR windowId.
  mover.close();
  const claimed = track(new Client());
  await claimed.connect({ cwd: projDir, id: s.id, windowId: 'win-to' });

  const info = await (await fetch(`${BASE}/api/shells/${s.id}/info`, { headers: authHeaders() })).json();
  assert.strictEqual(info.windowId, 'win-to', 'server reassigned windowId on connect');

  const payload = await getWindows();
  assert.ok(findWindow(payload, 'win-to').sessions.some(x => x.id === s.id), 'moved to win-to');
  assert.strictEqual(findWindow(payload, 'win-from'), null, 'emptied window drops out on its own');
});

test('a disconnected session keeps its window grouping across the 30s grace (#551 root cause)', async () => {
  // THE regression test. Pre-fix, ws.on('close') wrote a hand-rolled savedState
  // entry with no windowId; once the grace timer deleted the shell, saveState()'s
  // {...savedState, ...liveShells} merge had only the stripped entry left, so the
  // window's grouping was erased from disk. This is the ordinary "user closed the
  // browser window" path — no origin change needed to lose everything.
  //
  // Deliberately slow: the 30s grace is hardcoded (server.js, ws.on('close')) with
  // no env knob, and this is the one path that proves the fix.
  const a = track(new Client());
  const b = track(new Client());
  const sa = await a.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-grace' });
  const sb = await b.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-grace' });

  // Close the window: drop both session sockets without a close-session message.
  a.close();
  b.close();

  // Wait for the grace timer to actually fire. The signal has to be the shell
  // leaving `shells` (status flips active → saved), NOT the mere presence of an
  // entry in state.json: the spawn-time saveState() already wrote one, so keying
  // on that passes instantly and tests nothing.
  await waitFor(async () => {
    const { shells } = await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json();
    const rows = [sa.id, sb.id].map(id => shells.find(s => s.id === id));
    return rows.every(r => r && r.status === 'saved');
  }, 'the 30s disconnect grace to elapse', 60000, 500);

  for (const id of [sa.id, sb.id]) {
    const entry = readState()[id];
    assert.strictEqual(entry.windowId, 'win-grace', `${id} kept windowId through the grace path`);
    assert.ok('engineType' in entry, `${id} kept engineType (else tmux restores as node-pty)`);
    assert.ok('createdAt' in entry, `${id} kept createdAt (tab ordering)`);
    assert.ok(!('closed' in entry), `${id} is a disconnect, not a user close — stays restorable`);
  }

  // And the window is still offerable, now as saved rather than active.
  const win = findWindow(await getWindows(), 'win-grace');
  assert.ok(win, 'the window survives a browser-window close');
  assert.deepStrictEqual(win.sessions.map(s => s.id).sort(), [sa.id, sb.id].sort());
  assert.ok(win.sessions.every(s => s.status === 'saved'), 'reported as saved');
  assert.strictEqual(win.live, false);
});

test('the grouping survives a daemon restart', async () => {
  closeClients();
  await stopDaemon();
  await startDaemon();

  const win = findWindow(await getWindows(), 'win-grace');
  assert.ok(win, 'win-grace still derivable from state.json after restart');
  assert.strictEqual(win.sessions.length, 2);
});

test('the suite never opens a real browser', async () => {
  // server.js auto-opens the default browser 5s after a cold start with no client
  // attached — which is every daemon this suite spawns. A scratch HOME does not
  // sandbox `open`, so an unguarded run pops a tab on the machine of whoever runs
  // the tests, once per start. Wait past the 5s timer of the most recent start,
  // then prove the guards held.
  await new Promise(r => setTimeout(r, 6000));
  assert.strictEqual(openLog(), '', 'no `open` was invoked across any daemon start');
});
