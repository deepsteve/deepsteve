/**
 * Standalone unattended-scheduled-run tests (#596).
 *
 * The bug: a scheduled task that fires while NO browser is connected is supposed
 * to be fully supported — its tab queues in `pendingOpens` and surfaces when a
 * browser next connects. But the queue had no liveness check, so a run that fired,
 * completed and auto-closed before anyone opened a browser still handed its (now
 * tombstoned) session id to the next window, which reconnected with it and made the
 * server resurrect it via `claude --resume` into a worktree the run's own cleanup
 * had already deleted. Every unattended fire left one of these behind.
 *
 * This suite spawns its OWN throwaway daemon (scratch $HOME, stub `claude`, random
 * port) and — crucially — never connects a reload client until the assertion step,
 * so "zero browsers" is the natural starting state rather than something simulated.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/scheduled-unattended.test.js
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
const { TmuxSandbox } = require('../helpers/tmux-sandbox');
const { writeLoginProfile } = require('../helpers/login-profile');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The restart test below is about tmux durability specifically — under node-pty a
// session dies with the daemon by design, so there would be nothing to assert.
const NO_TMUX = TmuxSandbox.skipReason();

// Stub `claude`: logs argv, fails a --resume with no transcript, otherwise acts
// like a live REPL (blocks on stdin, exits on /exit).
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

let tmpRoot, HOME, PORT, BASE, projDir;
let daemon = null;
// null until before() has validated one. `after()` uses `sandbox?.cleanup()`, so a
// before() that throws leaves a no-op rather than an unaimed tmux command (#625).
let sandbox = null;
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

const authToken = () => {
  try { return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim(); }
  catch { return ''; }
};
const authHeaders = () => {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

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

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // no browser auto-open
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  // The daemon derives its tmux socket from $HOME/.deepsteve/tmux.sock and passes it
  // as `-S` (#625), so a scratch HOME IS a scratch tmux server — there is no
  // TMUX_TMPDIR to set, and setting one would isolate nothing while reading like it
  // did. The sandbox anchors on that same HOME so this suite and the daemon are
  // provably on ONE socket, and so `after()` can reap the tmux server that outlives
  // the daemon (shutdown detaches rather than kills).
  sandbox = TmuxSandbox.forHome(HOME);

  daemon = spawn('node', ['server.js', '--test-mode'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', d => { daemonLog += d.toString(); });
  daemon.stderr.on('data', d => { daemonLog += d.toString(); });

  await waitFor(async () => {
    if (!authToken()) return false;
    const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
    return r.ok;
  }, 'daemon to become ready');
  // Mod routes are registered by the async initMCP, which finishes after
  // /api/version starts answering — without this the first POST lands on the SPA
  // catch-all and comes back as HTML.
  await waitFor(async () => {
    const r = await fetch(`${BASE}/api/scheduled-tasks`, { headers: authHeaders() });
    return r.ok && (r.headers.get('content-type') || '').includes('json');
  }, 'the scheduled-tasks routes to register');
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

const readState = () => JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));

// Via the sandbox, which binds `-S <this HOME's socket>` into every argv (#625), so
// there is no state of the world in which this reads the developer's tmux server.
function tmuxHasSession(name) {
  return sandbox.hasSession(name);
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function api(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// Connect as a browser's control socket and collect everything it is handed
// (including the pendingOpens flush, which happens right after connect).
function collectReloadMessages(windowId, ms = 2500) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ action: 'reload', windowId });
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
    const msgs = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(msgs); }, ms);
    ws.on('message', (data) => {
      try { msgs.push(JSON.parse(data.toString())); } catch {}
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// Minimal terminal-WS client: resolves on the first `session` or `gone` message.
function connectSession(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params);
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('WS session message timed out')); }, 15000);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg && (msg.type === 'session' || msg.type === 'gone')) {
        clearTimeout(timer);
        resolve({ msg, ws });
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// /api/shells returns live shells AND savedState tombstones; only 'active' rows
// are a running session.
const activeShells = async () => (await api('GET', '/api/shells')).shells.filter(s => s.status === 'active');

// Fire a task now and wait for its session to be live.
async function fireAndWait(taskId) {
  const res = await api('POST', `/api/scheduled-tasks/${taskId}/run`);
  assert.strictEqual(res.started, true, 'the run should start');
  const shellId = res.sessionId;
  assert.ok(shellId, 'the run reports its session id');
  await waitFor(async () => (await activeShells()).some(s => s.id === shellId),
    `the scheduled run's session to be live`);
  return shellId;
}

async function makeTask(title, extra = {}) {
  const res = await api('POST', '/api/scheduled-tasks', {
    title, prompt: 'say hello', cron: '0 3 * * *', project: projDir, isolateWorktree: false, ...extra,
  });
  assert.ok(res.task && res.task.id, `task created: ${JSON.stringify(res)}`);
  return res.task.id;
}

const taskById = async (id) => ((await api('GET', '/api/scheduled-tasks')).tasks || []).find(t => t.id === id);

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sched-unattended-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  await stopDaemon().catch(() => {});
  // A SIGTERMed daemon DETACHES its tmux sessions, so the scratch tmux server
  // outlives it and the rm below would only unlink its socket — leaving a running
  // server nothing can ever reach again. Reap it by name (#625).
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a finished unattended run is never offered to the next browser', async () => {
  const taskId = await makeTask('unattended-finished');
  const shellId = await fireAndWait(taskId);

  // Auto-close goes through the same closeSession the scheduled_task_finished MCP
  // tool calls; the agent isn't real here, so drive it directly.
  const closed = await api('POST', `/api/shells/${shellId}/close`);
  assert.strictEqual(closed.closed, shellId);

  // #561 must not regress: the tombstone is still on disk and restorable.
  const entry = readState()[shellId];
  assert.ok(entry, 'state.json keeps the closed session');
  assert.strictEqual(entry.closed, true);

  // Now a browser finally shows up.
  const logBefore = daemonLog.length;
  const msgs = await collectReloadMessages('w-first');
  const zombie = msgs.find(m => m.type === 'open-session' && m.id === shellId);
  assert.strictEqual(zombie, undefined, 'a finished run must not open a tab');
  assert.strictEqual(msgs.find(m => m.type === 'prompt-submitted' && m.id === shellId), undefined,
    'and its paired prompt-submitted goes with it');

  assert.strictEqual((await activeShells()).find(s => s.id === shellId), undefined, 'nothing was resurrected');
  assert.ok(!daemonLog.slice(logBefore).includes(`Restoring session ${shellId}`),
    'the server never re-spawned the closed run');
  assert.strictEqual(readState()[shellId].closed, true, 'the tombstone is left intact for the restore modal');
});

test('a still-live unattended run DOES surface when a browser connects', async () => {
  const taskId = await makeTask('unattended-live');
  const shellId = await fireAndWait(taskId);

  const msgs = await collectReloadMessages('w-second');
  const open = msgs.find(m => m.type === 'open-session' && m.id === shellId);
  assert.ok(open, 'the documented pendingOpens behavior must survive the fix');
  // This fire came from the panel's Run-now route, which is deliberately the one
  // path that opens in the foreground (#600) — the user just asked to see it.
  // Background-by-default for schedule/catch-up fires is pinned in the unit tests.
  assert.strictEqual(open.background, false);

  await api('POST', `/api/shells/${shellId}/close`);
});

test('noRestore refuses a tombstone, a plain reconnect still restores it', async () => {
  const taskId = await makeTask('unattended-norestore');
  const shellId = await fireAndWait(taskId);
  const claudeSessionId = readState()[shellId]?.claudeSessionId
    || (await api('GET', `/api/shells/${shellId}/info`)).claudeSessionId;
  assert.ok(claudeSessionId, 'the run has a claude session id');

  // Give it a transcript so a --resume would actually be viable.
  const enc = projDir.replace(/[^a-zA-Z0-9-]/g, '-');
  const tp = path.join(HOME, '.claude', 'projects', enc, `${claudeSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, '{"type":"user"}\n');

  await api('POST', `/api/shells/${shellId}/close`);

  const refused = await connectSession({ id: shellId, cwd: projDir, noRestore: '1' });
  assert.strictEqual(refused.msg.type, 'gone', 'a server-pushed open never resurrects a tombstone');
  try { refused.ws.close(); } catch {}
  assert.strictEqual(readState()[shellId].closed, true, 'and the tombstone is preserved');

  // The restore modal / orphan claim path is untouched: no noRestore, so it resumes.
  const restored = await connectSession({ id: shellId, cwd: projDir });
  assert.strictEqual(restored.msg.type, 'session', 'an explicit restore still works');
  try { restored.ws.close(); } catch {}
  await waitFor(
    () => fs.readFileSync(path.join(HOME, 'claude-invocations.log'), 'utf8').includes(`--resume ${claudeSessionId}`),
    `--resume ${claudeSessionId} in the stub log`
  );

  await api('POST', `/api/shells/${shellId}/close`);
});

test('a RUNNING scheduled task is not killed by a daemon restart, with no browser attached',
  { skip: NO_TMUX }, async () => {
    // #626's hard requirement, stated as an assertion. No browser has ever
    // connected to this run — that is the whole point, and it is the case #596
    // spent an issue making robust. What used to make this ambiguous is that
    // startup's reattach threw `Cannot access 'wss' before initialization` for
    // every session on every boot, so nothing in any log distinguished "the
    // reattach worked" from "a browser happened to reconnect and rescued it".
    const taskId = await makeTask('unattended-survives-restart', { keepOpen: true });
    const shellId = await fireAndWait(taskId);

    const before = (await api('GET', '/api/shells')).shells.find(s => s.id === shellId);
    assert.ok(before && before.pid, 'the run reports a pane pid');
    assert.strictEqual(before.engineType, 'tmux', 'the run must be tmux-backed or there is nothing to survive');
    assert.ok(tmuxHasSession(`ds-${shellId}`), 'its tmux session exists');
    assert.ok(pidAlive(before.pid), 'the agent process is running');

    const logBefore = daemonLog.length;
    await stopDaemon();            // the full graceful shutdown path
    await new Promise(r => setTimeout(r, 500));

    // The daemon is gone. The agent must not be.
    assert.ok(tmuxHasSession(`ds-${shellId}`), 'shutdown detached rather than killed');
    assert.ok(pidAlive(before.pid), 'the scheduled run kept working through the restart');

    await startDaemon();

    const after = await waitFor(
      async () => (await api('GET', '/api/shells')).shells.find(s => s.id === shellId && s.status === 'active'),
      "the scheduled run's session to be reattached");
    assert.strictEqual(after.pid, before.pid, 'reattached to the SAME pane — not respawned, not resumed');
    assert.strictEqual(after.connectedClients, 0, 'and it came back with no browser involved');
    assert.ok(!readState()[shellId].closed, 'it is live, not a tombstone');

    // Reattach, not a lucky WS reconnect. This is the assertion that fails against
    // the pre-#626 daemon.
    const fresh = daemonLog.slice(logBefore);
    assert.match(fresh, new RegExp(`tmux: reattached session ${shellId}\\b`),
      'startup must log the reattach it performed');
    assert.doesNotMatch(fresh, /error reattaching session|FAILED to reattach session/,
      'and no session may fail to reattach');

    // The run row is the ONLY record of the run↔session link (findRunByShell
    // matches run.sessionId), so losing it across a restart orphans the live agent:
    // its self-report is refused, it never auto-closes, and the overlap guard
    // blocks every future fire of the task.
    const task = await taskById(taskId);
    const run = (task.runs || []).find(r => r.sessionId === shellId);
    assert.ok(run, 'the run is still linked to its session');
    // ACTIVE_STATUSES in the mod. The stub agent has no MCP, so it never calls
    // scheduled_task_started and the row legitimately stays 'queued' — what matters
    // is that it is still in a NON-TERMINAL state, because that is what the overlap
    // guard, enforceRunTimeouts and sweepLeakedWorktrees all key off.
    assert.ok(['queued', 'running', 'started'].includes(run.status),
      `the run is still in flight, got ${run.status}`);

    await api('POST', `/api/shells/${shellId}/close`);
  });

test('a browser echoing close-session cannot rewrite a server-set closeReason', async () => {
  // Auto-close sends the tab a `close-tab`; the browser tears the tab down and
  // sends `close-session` back. That echo used to re-tombstone the entry as
  // 'user-closed', overwriting the true reason — which is how a scheduled run that
  // completed and auto-closed came to look, in state.json, like something a person
  // had closed. Forensics that lie are worse than none.
  const taskId = await makeTask('unattended-close-reason');
  const shellId = await fireAndWait(taskId);

  const client = await connectSession({ id: shellId, cwd: projDir });
  assert.strictEqual(client.msg.type, 'session');

  await api('POST', `/api/shells/${shellId}/close`);
  await waitFor(async () => readState()[shellId]?.closed, 'the tombstone to be written');
  const reason = readState()[shellId].closeReason;
  assert.ok(reason && reason !== 'user-closed', `server-set reason, got ${reason}`);

  client.ws.send(JSON.stringify({ type: 'close-session' }));
  await new Promise(r => setTimeout(r, 1000));

  assert.strictEqual(readState()[shellId].closeReason, reason,
    'the echo must not overwrite why the session actually ended');
  try { client.ws.close(); } catch {}
});
