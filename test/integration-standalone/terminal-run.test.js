/**
 * Standalone integration tests for `run_in_terminal`, the disposable terminal (#631).
 *
 * The unit tests drive the handler against a scripted screen; this drives the real
 * thing — a real login shell in a real PTY, the wrapper's marker read back off the
 * interpreted terminal, and the actual teardown — because the two properties the issue
 * turns on are only observable end to end:
 *
 *   1. the tab really goes away, with a closeReason that says an agent's run ended it
 *      rather than a person closing it (the 102-terminals audit is a `closeReason`
 *      histogram, so an indistinguishable reason would be no fix at all);
 *   2. typing in it really keeps it.
 *
 * Own daemon (scratch $HOME, random port), spawned in before() and killed in after().
 * No agent stub is needed: the caller is itself a plain terminal, which `run_in_terminal`
 * accepts — it only needs a live session to inherit cwd/window from.
 *
 * Run one file by hand with a SHORT TMPDIR (a tmux socket lives under $HOME):
 *   TMPDIR=/tmp/ds-test node --test test/integration-standalone/terminal-run.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { TmuxSandbox } = require('../helpers/tmux-sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Short enough that a test can wait it out, long enough that the "typing keeps it"
// case has a real window rather than a scheduling race.
const LINGER_MS = 1500;

let tmpRoot, HOME, projDir, PORT, BASE;
let daemon = null;
let daemonLog = '';
let sandbox = null;

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
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function startDaemon() {
  sandbox = TmuxSandbox.forHome(HOME);
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // Set AFTER the strip loop above, which exists to keep the developer's own
  // DEEPSTEVE_* out of the scratch daemon.
  env.DEEPSTEVE_TERMINAL_RUN_LINGER_MS = String(LINGER_MS);

  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // suppress browser auto-open
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', (d) => { daemonLog += d.toString(); });
  daemon.stderr.on('data', (d) => { daemonLog += d.toString(); });

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

async function getJson(p) {
  const r = await fetch(`${BASE}${p}`, { headers: authHeaders() });
  assert.ok(r.ok, `GET ${p} -> ${r.status}`);
  return r.json();
}

const shellsById = async () => {
  const { shells } = await getJson('/api/shells');
  return new Map(shells.map((s) => [s.id, s]));
};

class Client {
  constructor() { this.ws = null; this.session = null; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 15000);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg && msg.type === 'session' && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  // A raw (non-JSON-object) frame is a keystroke — the same path a browser uses, and
  // the one that cancels a pending auto-close.
  type(text) { this.ws.send(text); }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

let mcp = null;
async function mcpConnect() {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  // /api/version answers as soon as HTTP is listening, but /mcp is not mounted until
  // every mod has loaded.
  await waitFor(async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
    return r.status !== 404;
  }, 'the /mcp endpoint to be mounted');

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { ...authHeaders() } },
  });
  mcp = new McpClient({ name: 'terminal-run-test', version: '1.0.0' });
  await mcp.connect(transport);
}

const parseTool = (result) => JSON.parse(result.content[0].text);

// The real per-session MCP config carries `?shellId=` in its URL, which is how a tool
// finds its caller; a test client connects to a bare /mcp, so it passes `session_id`
// explicitly — the same thing every other standalone suite does.
const runInTerminal = (args) =>
  mcp.callTool({ name: 'run_in_terminal', arguments: { session_id: caller.session.id, ...args } });

const caller = new Client();

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-631-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
  await mcpConnect();
  await caller.connect({ cwd: projDir, new: '1', agentType: 'terminal', windowId: 'win-a' });
});

after(async () => {
  try { if (mcp) await mcp.close(); } catch {}
  caller.close();
  await stopDaemon().catch(() => {});
  // A SIGTERMed daemon DETACHES its tmux sessions, so the scratch tmux server outlives
  // it; reap it by name (#625) before the directory holding its socket goes away.
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a run returns its output and exit code, and the marker never leaks into the output', async () => {
  const p = parseTool(await runInTerminal({ command: 'printf "hello-631\\n"; exit 3' }));

  assert.strictEqual(p.status, 'finished', JSON.stringify(p));
  assert.strictEqual(p.exit_code, 3, 'the exit status survives both engines');
  assert.match(p.output, /hello-631/);
  assert.ok(!/\[deepsteve\] run /.test(p.output), 'the completion marker is not part of the transcript');
  assert.ok(p.session_id && p.session_id.length === 8);
});

test('the run tab tears itself down, and says so in its close reason', async () => {
  const p = parseTool(await runInTerminal({ command: 'printf "closing-soon\\n"' }));
  assert.strictEqual(p.status, 'finished');
  assert.ok(p.auto_close_in_seconds !== null, 'a deferred close was armed');

  const before = await shellsById();
  assert.strictEqual(before.get(p.session_id).status, 'active', 'it lingers first — the window to claim it');

  const closed = await waitFor(async () => {
    const s = (await shellsById()).get(p.session_id);
    return s && s.status === 'closed' ? s : null;
  }, 'the run tab to close itself', 15000);

  // The whole audit in #631 is a closeReason histogram: 95 'user-closed', 0 by an
  // agent. An indistinguishable reason here would be no fix at all.
  assert.strictEqual(closed.closeReason, 'terminal-run-finished');
  assert.notStrictEqual(closed.closeReason, 'user-closed');
});

test('typing in the tab keeps it — the daemon does not close it', async () => {
  const started = Date.now();
  const COMMAND = 'sleep 3; printf "claimed\\n"';
  const call = runInTerminal({ command: COMMAND });

  // Find the run's tab while it is still running. The launch record is the reliable
  // way in: it is written before the command is waited on, precisely so a run is
  // identifiable before it finishes.
  const runId = await waitFor(async () => {
    const { runs } = await getJson('/api/terminal-runs?limit=10');
    const r = runs.find((x) => x.status === 'started' && x.command === COMMAND);
    return r ? r.session_id : null;
  }, 'the run tab to appear');

  const watcher = new Client();
  await watcher.connect({ cwd: projDir, id: runId });
  watcher.type('x');   // a real keystroke: this is what cancels the pending close

  const p = parseTool(await call);
  assert.strictEqual(p.status, 'finished');
  assert.strictEqual(p.auto_close_in_seconds, null, 'nothing was armed — the tab is the user\'s');

  // Wait past the linger it would have had, then assert it is still there.
  await new Promise((r) => setTimeout(r, LINGER_MS + 1500));
  const s = (await shellsById()).get(runId);
  assert.ok(s && s.status === 'active', `expected the claimed tab to survive, got ${JSON.stringify(s)}`);
  assert.ok(Date.now() - started > LINGER_MS);

  watcher.close();
  // Leave nothing behind for the next test: this tab is now genuinely user-owned.
  await fetch(`${BASE}/api/shells/${runId}?forget=1`, { method: 'DELETE', headers: authHeaders() });
});

test('a command calling `exit` ends the command, not the run', async () => {
  // The subshell in the wrapper exists for this. Without it the shell died before the
  // marker printed, and under tmux that lost the OUTPUT too: the pane is destroyed
  // before the attach client has painted it, and deepsteve never reads tmux's own
  // history, so all that came back was tmux's `[exited]`.
  const p = parseTool(await runInTerminal({ command: 'printf "bye-631\\n"; exit 7' }));
  assert.strictEqual(p.status, 'finished', JSON.stringify(p));
  assert.strictEqual(p.exit_code, 7);
  assert.match(p.output, /bye-631/);
});

test('a timeout hands back partial output and still cleans up on its own', async () => {
  const p = parseTool(await runInTerminal({ command: 'printf "early\\n"; sleep 4', timeout_seconds: 1 }));
  assert.strictEqual(p.status, 'running');
  assert.strictEqual(p.exit_code, null);
  assert.match(p.output, /early/, 'what it has printed so far');
  assert.match(p.note, /closes itself/);

  // The tool call returned, but the watcher did not: the tab still tears itself down.
  const closed = await waitFor(async () => {
    const s = (await shellsById()).get(p.session_id);
    return s && s.status === 'closed' ? s : null;
  }, 'the timed-out run to finish and close itself', 20000);
  assert.strictEqual(closed.closeReason, 'terminal-run-finished');
});

test('every run is in the durable log, recorded at launch and again at the end', async () => {
  const p = parseTool(await runInTerminal({ command: 'printf "audit-me-631\\n"' }));

  const { runs } = await getJson(`/api/terminal-runs?session=${p.session_id}`);
  assert.strictEqual(runs.length, 2, 'one record when it launched, one when it ended');
  const [finished, started] = runs; // newest first
  assert.strictEqual(started.status, 'started');
  assert.strictEqual(started.command, 'printf "audit-me-631\\n"');
  assert.strictEqual(started.caller, caller.session.id, 'the log names who ran it');
  assert.strictEqual(finished.status, 'finished');
  assert.strictEqual(finished.exit_code, 0);
  assert.match(finished.output, /audit-me-631/);
  assert.ok(finished.duration_ms >= 0);

  // On disk too — the point is that it survives the daemon, not just this process.
  const file = path.join(HOME, '.deepsteve', 'terminal-runs.jsonl');
  const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(onDisk.some((r) => r.session_id === p.session_id && r.status === 'finished'));
});

test('the run inherits the caller cwd and runs in a LOGIN shell', async () => {
  // The login shell is half of why agents reach for a terminal tab at all (#630): an
  // agent session under tmux gets a non-login shell with a thinner $PATH. `.zprofile`
  // and `.profile` are login-only files, so seeing the marker proves which we got.
  fs.writeFileSync(path.join(HOME, '.zprofile'), 'export DS_LOGIN_MARKER=yes\n');
  fs.writeFileSync(path.join(HOME, '.profile'), 'export DS_LOGIN_MARKER=yes\n');
  fs.writeFileSync(path.join(HOME, '.bash_profile'), 'export DS_LOGIN_MARKER=yes\n');

  const p = parseTool(await runInTerminal({ command: 'pwd; printf "marker=%s\\n" "${DS_LOGIN_MARKER:-no}"' }));
  assert.strictEqual(p.status, 'finished');
  assert.match(p.output, new RegExp(projDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'defaults to the caller cwd');
  assert.match(p.output, /marker=yes/, 'a login shell sourced the profile');
});

test('an explicit cwd overrides the caller, and a missing command is an error', async () => {
  const other = path.join(tmpRoot, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  const p = parseTool(await runInTerminal({ command: 'pwd', cwd: other }));
  assert.match(p.output, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const bad = await runInTerminal({ command: '   ' });
  assert.strictEqual(bad.isError, true);
});
