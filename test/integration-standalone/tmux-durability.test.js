/**
 * Standalone tmux durability tests (#620) — the issue's acceptance test.
 *
 * Spawns its own throwaway daemon (scratch $HOME, isolated tmux socket, random
 * port) and proves the thing the whole issue is about: the agent outlives the
 * daemon.
 *
 * What it proves:
 *   - A fresh install with tmux present defaults to the tmux engine.
 *   - SIGKILL of the daemon (a crash) leaves the tmux session and its process
 *     running; the restarted daemon reattaches it under the SAME pane pid, and
 *     the session comes back as a live shell, not a tombstone.
 *   - A graceful SIGTERM restart does the same. This is the case that flipping
 *     the default alone did NOT fix: shutdown() used to killShell() every
 *     session, and since the agent is the tmux pane's command, /exit destroyed
 *     the tmux session too.
 *   - Closing the browser (last WS client gone) no longer reaps a tmux session
 *     after the detach grace period.
 *   - A ds-* tmux session this daemon has no record of is left strictly alone
 *     rather than destroyed — tmux's socket is per-UID, so that used to let any
 *     second daemon wipe the real one's sessions.
 *
 * Skips itself when tmux is not installed.
 *
 * Run: node --test --test-timeout=180000 test/integration-standalone/tmux-durability.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Short so the disconnect test doesn't sit for 30s. If the reap were still armed
// for tmux, this is what would fire.
const DETACH_GRACE_MS = 2000;
const DETACH_HOLDOFF_MS = 0;

let TMUX_BIN = null;
try {
  TMUX_BIN = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim() || null;
} catch {
  try { TMUX_BIN = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim() || null; } catch { TMUX_BIN = null; }
}
const SKIP = TMUX_BIN ? false : 'tmux is not installed';

let tmpRoot, HOME, PORT, BASE, projDir, tmuxTmp;
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
  try { return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim(); }
  catch { return ''; }
}
function authHeaders() {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function waitFor(check, what, timeoutMs = 20000, intervalMs = 100) {
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

/** Run tmux against THIS test's private socket dir, never the user's. */
function tmux(args) {
  return execFileSync(TMUX_BIN, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: 'pipe',
    env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
  }).trim();
}
function tmuxSessionNames() {
  try { return tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean); }
  catch { return []; } // no server running == no sessions
}
function tmuxHasSession(name) {
  return tmuxSessionNames().includes(name);
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  env.DEEPSTEVE_DETACH_GRACE_MS = String(DETACH_GRACE_MS);
  env.DEEPSTEVE_DETACH_HOLDOFF_MS = String(DETACH_HOLDOFF_MS);
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  // Isolate tmux's socket: it is per-UID, NOT per-HOME (see CLAUDE.md). Without
  // this a scratch-HOME daemon shares the real user's socket.
  env.TMUX_TMPDIR = tmuxTmp;

  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // no browser auto-open

  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', d => { daemonLog += d.toString(); });
  daemon.stderr.on('data', d => { daemonLog += d.toString(); });

  await waitFor(async () => {
    if (!authToken()) return false;
    const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
    return r.ok;
  }, 'daemon to become ready');
}

/** Stop the daemon with `signal` and wait for the process to actually go away. */
function stopDaemon(signal = 'SIGTERM') {
  if (!daemon) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = daemon;
    daemon = null;
    const timer = setTimeout(() => reject(new Error(`daemon did not exit within 30s of ${signal}`)), 30000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill(signal);
  });
}

async function shells() {
  const r = await fetch(`${BASE}/api/shells`, { headers: authHeaders() });
  return (await r.json()).shells || [];
}
async function shellById(id) {
  return (await shells()).find(s => s.id === id) || null;
}
function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8')); }
  catch { return {}; }
}

class Client {
  constructor() { this.ws = null; this.messages = []; this.session = null; this.output = ''; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 15000);
      this.ws.on('message', (data) => {
        const raw = data.toString();
        let msg;
        try { msg = JSON.parse(raw); } catch { this.output += raw; return; }
        if (typeof msg !== 'object' || msg === null) { this.output += raw; return; }
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
  send(str) { this.ws.send(str); }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

let clients = [];
function track(c) { clients.push(c); return c; }

before(async () => {
  if (SKIP) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxdur-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  tmuxTmp = path.join(tmpRoot, 'tmux-tmp');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\nexit 0\n',
    { mode: 0o755 }
  );
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon('SIGKILL').catch(() => {});
  // Our own socket dir, so this can't touch the developer's real sessions.
  try { tmux(['kill-server']); } catch {}
  // The daemon and the tmux server both write under HOME, and a killed process's
  // last writes can land after the signal — an immediate rm races them and throws
  // ENOTEMPTY. Settle, then retry.
  await sleep(500);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('a fresh install with tmux present defaults to the tmux engine', { skip: SKIP }, async () => {
  const r = await (await fetch(`${BASE}/api/engines`, { headers: authHeaders() })).json();
  assert.strictEqual(r.tmuxAvailable, true, 'tmux should be detected');
  assert.strictEqual(r.current, 'tmux', 'a fresh install should default to tmux');
  // Nothing to migrate — we were never on node-pty.
  assert.strictEqual(r.migrationOffer, false);
  // Guard against this whole suite quietly testing node-pty. spawnSession degrades
  // rather than throwing, so a socket path over the ~104-byte sun_path limit (an
  // easy accident on macOS, whose $TMPDIR is ~52 characters before ours) would
  // otherwise leave every assertion below passing against the wrong engine.
  assert.strictEqual(r.tmuxRuntimeFailure, null,
    `tmux cannot create sessions here, so this suite would silently test node-pty. ` +
    `Usually the socket path is too long — re-run with a short TMPDIR.`);
});

test('agent survives a daemon CRASH and is reattached under the same pid', { skip: SKIP }, async () => {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'terminal' });
  const id = s.id;
  assert.strictEqual(s.engineType, 'tmux', 'session should be tmux-backed');

  // Give the shell a moment, then start a long-running marker inside it. Its
  // survival is the actual claim: not just "a tmux session exists" but "the work
  // running in it kept running".
  await sleep(1500);
  c.send('sleep 600 & echo MARKER_$!\n');
  const markerLine = await waitFor(
    () => /MARKER_(\d+)/.exec(c.output),
    'marker pid to be echoed',
  );
  const markerPid = Number(markerLine[1]);
  assert.ok(pidAlive(markerPid), 'marker process is running');

  const before = await shellById(id);
  assert.ok(before && before.pid, 'shell reports a pane pid');
  const panePid = before.pid;

  // A crash: no shutdown handler runs at all.
  await stopDaemon('SIGKILL');
  await sleep(500);

  assert.ok(tmuxHasSession(`ds-${id}`), 'tmux session outlived the daemon');
  assert.ok(pidAlive(markerPid), 'the work inside it kept running');

  await startDaemon();
  const after = await waitFor(() => shellById(id).then(s => s && s.status === 'active' ? s : null),
    'session to be reattached');
  assert.strictEqual(after.engineType, 'tmux');
  assert.strictEqual(after.pid, panePid, 'reattached to the SAME pane, not a respawn');
  assert.ok(pidAlive(markerPid), 'work still running after reattach');
  // A reattach is a saved -> live promotion, never a close. The entry is still in
  // state.json (saveState persists every live shell) but must not be a tombstone —
  // a `closed` flag here would mean the session came back as a corpse.
  const persisted = readState()[id];
  assert.ok(persisted, 'still persisted, so another crash could recover it again');
  assert.ok(!persisted.closed, 'reattached session is not tombstoned');
  assert.strictEqual(persisted.engineType, 'tmux');

  c.close();
});

test('agent survives a GRACEFUL restart (the case the default flip alone did not fix)',
  { skip: SKIP }, async () => {
    const c = track(new Client());
    const s = await c.connect({ cwd: projDir, new: '1', agentType: 'terminal' });
    const id = s.id;

    await sleep(1500);
    c.send('sleep 600 & echo GRACEFUL_$!\n');
    const line = await waitFor(() => /GRACEFUL_(\d+)/.exec(c.output), 'marker pid');
    const markerPid = Number(line[1]);
    const panePid = (await shellById(id)).pid;

    // SIGTERM runs the full shutdown() path — which used to /exit every session.
    await stopDaemon('SIGTERM');
    await sleep(500);

    assert.ok(tmuxHasSession(`ds-${id}`), 'graceful shutdown detached rather than killed');
    assert.ok(pidAlive(markerPid), 'the work survived the restart');
    assert.match(daemonLog, /Detached \d+ tmux session\(s\)/, 'shutdown logged the detach');

    await startDaemon();
    const after = await waitFor(() => shellById(id).then(s => s && s.status === 'active' ? s : null),
      'session to be reattached after graceful restart');
    assert.strictEqual(after.pid, panePid, 'same pane pid across the restart');

    c.close();
  });

test('closing the browser no longer reaps a tmux session', { skip: SKIP }, async () => {
  const c = new Client();
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'terminal' });
  const id = s.id;
  await sleep(1000);

  c.close(); // last client gone — this is what "closed the browser window" looks like

  // Wait well past the grace period the reaper would have used.
  await sleep(DETACH_GRACE_MS + 3000);

  const still = await shellById(id);
  assert.ok(still && still.status === 'active', 'session is still live with no browser attached');
  assert.ok(tmuxHasSession(`ds-${id}`), 'its tmux session is still there');
});

test('reattach carries every persisted field, not a hand-picked subset', { skip: SKIP }, async () => {
  // The reattach path is the third writer of a shell entry (with the WS restore
  // and spawn paths) and used to name its fields by hand, so anything added to
  // serializeShellEntry() since was dropped on reattach and then wiped from
  // state.json by the next save — forkParent (the #497 fork-steal guard),
  // planMode, model/effort (#592), allowedTools (#612), scheduled (#597).
  //
  // Built by hand rather than by driving a real agent: these fields need a claude
  // binary to arrive naturally, and the thing under test is purely "does reattach
  // preserve what was persisted".
  const id = 'beef0001';
  const meta = {
    cwd: projDir,
    claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    agentType: 'terminal',
    codexHomeId: null,
    configDir: '/tmp/some-profile',
    engineType: 'tmux',
    worktree: 'wt-example',
    name: 'carried-through',
    planMode: true,
    model: 'haiku',
    effort: 'low',
    allowedTools: ['mcp__deepsteve__scheduled_task_finished'],
    forkParent: '11111111-2222-3333-4444-555555555555',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    windowId: 'win-abc',
    scheduled: true,
  };

  await stopDaemon('SIGKILL');
  // A live tmux session for it, plus the state.json record that makes it ours.
  tmux(['new-session', '-d', '-s', `ds-${id}`, 'sleep 600']);
  const statePath = path.join(HOME, '.deepsteve', 'state.json');
  const state = readState();
  state[id] = meta;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  await startDaemon();
  await waitFor(() => shellById(id).then(s => s && s.status === 'active' ? s : null),
    'seeded session to be reattached');

  const after = readState()[id];
  assert.ok(after, 'still persisted after reattach');
  for (const key of ['configDir', 'worktree', 'name', 'planMode', 'model', 'effort',
                     'forkParent', 'windowId', 'scheduled', 'claudeSessionId']) {
    assert.deepStrictEqual(after[key], meta[key], `${key} survived the reattach`);
  }
  assert.deepStrictEqual(after.allowedTools, meta.allowedTools, 'allowedTools survived the reattach');

  await fetch(`${BASE}/api/shells/${id}?forget=1`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
  try { tmux(['kill-session', '-t', `ds-${id}`]); } catch {}
});

test('a ds-* session we have no record of is left strictly alone', { skip: SKIP }, async () => {
  // Stand in for another daemon's session on the shared per-UID socket.
  const foreign = 'ds-cafe1234';
  tmux(['new-session', '-d', '-s', foreign, 'sleep 600']);
  assert.ok(tmuxHasSession(foreign), 'foreign session created');

  await stopDaemon('SIGKILL');
  await startDaemon();

  assert.ok(tmuxHasSession(foreign),
    'startup must not destroy a ds-* session missing from its own state.json');
  assert.match(daemonLog, /not in our state\.json — leaving it alone/,
    'and it says so rather than doing it silently');

  try { tmux(['kill-session', '-t', foreign]); } catch {}
});
