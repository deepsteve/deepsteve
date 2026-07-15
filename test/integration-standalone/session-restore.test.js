/**
 * Standalone session-restore tests (#542).
 *
 * Unlike test/integration/* (which attach to one long-lived shared server and
 * therefore can never restart it), this suite spawns its OWN throwaway daemon —
 * scratch $HOME, stub `claude` on PATH, random port — so it can SIGTERM and
 * relaunch the server to exercise the restore path end-to-end.
 *
 * What it proves (the #542 collapse and its fix):
 *   - Claude only writes <sessionId>.jsonl once the first message is sent, so a
 *     never-prompted tab's `--resume` always failed and the old `-c` fallback
 *     re-pointed the tab at the project's most recent conversation — a sibling
 *     tab's. N same-project tabs collapsed onto one conversation after restart.
 *   - Fixed behavior: no-transcript restores spawn fresh under their own session
 *     id; fast-failing resumes retry once, then fall back to a fresh session
 *     under a new id; the chain is bounded; `-c` never runs on restore.
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

// Stub `claude` binary. Mirrors the two behaviors the restore path depends on:
// a transcript-less --resume fails fast, everything else acts like a live REPL
// (blocks on stdin, exits on /exit so graceful daemon shutdown stays quick).
// Control knobs (under $HOME/stub-control/) simulate failure modes:
//   fail-resumes  file containing N — fail the next N --resume attempts
//   fail-all      exists — every invocation fails immediately
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
if [ -e "$HOME/stub-control/fail-all" ]; then
  echo "stub: forced failure"
  exit 1
fi
resume=""
prev=""
for a in "$@"; do
  [ "$prev" = "--resume" ] && resume="$a"
  prev="$a"
done
if [ -n "$resume" ]; then
  ctr="$HOME/stub-control/fail-resumes"
  if [ -f "$ctr" ] && [ "$(cat "$ctr")" -gt 0 ] 2>/dev/null; then
    echo "$(($(cat "$ctr") - 1))" > "$ctr"
    echo "stub: transient resume failure"
    exit 1
  fi
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
let projDir;      // the shared "project" both tabs live in
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
  // Don't leak the invoking environment into the daemon: CLAUDECODE marks a
  // nested Claude, and DEEPSTEVE_* would be present when this test itself runs
  // inside a deepsteve agent tab.
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];

  // server.js schedules a 5s "no browser connected → open the default browser" timer
  // on every cold start, and `open` is NOT sandboxed by our scratch HOME — it hits
  // the developer's real browser. This suite restarts the daemon five times, so
  // without the .restarting marker (which the server unlinks during startup, hence
  // re-planting it before every spawn) a full run pops five browser tabs. The inert
  // `open` stub on PATH below is the backstop if that check ever regresses.
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  // exec() runs via /bin/sh, which resolves `open` from this PATH (not .zprofile).
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

async function restartDaemon() {
  await stopDaemon();
  await startDaemon();
}

function readState() {
  return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));
}

function stubLog() {
  try { return fs.readFileSync(stubLogPath, 'utf8'); } catch { return ''; }
}

// Per-phase log scoping: capture offsets at the start of a phase, assert on the
// slice written since.
function marks() {
  return { daemon: daemonLog.length, stub: stubLog().length };
}
function since(m) {
  return { daemon: daemonLog.slice(m.daemon), stub: stubLog().slice(m.stub) };
}

function traceEvents(logSlice, tracePath) {
  const out = [];
  for (const line of logSlice.split('\n')) {
    const i = line.indexOf('[session-trace] ');
    if (i === -1) continue;
    let ev;
    try { ev = JSON.parse(line.slice(i + '[session-trace] '.length)); } catch { continue; }
    if (ev.event === 'SPAWN' && ev.path === tracePath) out.push(ev);
  }
  return out;
}

function stubInvocations(logSlice) {
  return logSlice.split('\n').filter(l => l.trim().length > 0).map(l => l.trim().split(/\s+/));
}

// Claude Code's project-dir encoding (mirrors claudeProjectDir in server.js).
function transcriptPath(cwd, sessionId) {
  const enc = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(HOME, '.claude', 'projects', enc, `${sessionId}.jsonl`);
}

// Minimal WS client: connect with query params + bearer header, resolve on the
// first `session` message, collect the rest for later assertions.
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
  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

let idA, idB;           // shell ids of the two same-project tabs
let claudeA, claudeB;   // their claude session ids
let clients = [];

function track(c) { clients.push(c); return c; }
function closeClients() {
  for (const c of clients) c.close();
  clients = [];
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-restore-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'stub-control'), { recursive: true });
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

test('two same-project tabs start with distinct claude sessions', async () => {
  const a = track(new Client());
  const b = track(new Client());
  const sa = await a.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  const sb = await b.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  idA = sa.id; claudeA = sa.claudeSessionId;
  idB = sb.id; claudeB = sb.claudeSessionId;
  assert.ok(idA && idB && idA !== idB, 'distinct shell ids');
  assert.ok(claudeA && claudeB && claudeA !== claudeB, 'distinct claude session ids');
});

test('graceful shutdown persists the full state entry shape', async () => {
  closeClients();
  await stopDaemon();
  const state = readState();
  for (const [id, claude] of [[idA, claudeA], [idB, claudeB]]) {
    const entry = state[id];
    assert.ok(entry, `state.json has ${id}`);
    assert.strictEqual(entry.claudeSessionId, claude);
    // The shutdown-final snapshot must write the same shape as saveState() —
    // it used to drop configDir (breaking #537 profile resumes) et al. (#542)
    for (const key of ['configDir', 'createdAt', 'windowId', 'engineType']) {
      assert.ok(key in entry, `state entry has ${key}`);
    }
  }
});

test('never-prompted tabs restore fresh under their own ids — no -c theft (#542)', async () => {
  const m = marks();
  await startDaemon();
  const a = track(new Client());
  const b = track(new Client());
  const sa = await a.connect({ cwd: projDir, id: idA });
  const sb = await b.connect({ cwd: projDir, id: idB });
  assert.strictEqual(sa.id, idA);
  assert.strictEqual(sb.id, idB);
  assert.strictEqual(sa.claudeSessionId, claudeA, 'tab A keeps its own claude session');
  assert.strictEqual(sb.claudeSessionId, claudeB, 'tab B keeps its own claude session');

  // The SPAWN trace is logged before zsh has even started the stub, so also
  // wait for both stub invocations to land in the argv log.
  await waitFor(() => traceEvents(since(m).daemon, 'fresh').length === 2
    && stubInvocations(since(m).stub).length === 2, 'two path:"fresh" traces + two stub spawns');
  const s = since(m);
  assert.strictEqual(traceEvents(s.daemon, 'resume').length, 0, 'no --resume attempted without a transcript');
  assert.strictEqual(traceEvents(s.daemon, 'fallback').length, 0);
  assert.strictEqual(traceEvents(s.daemon, 'fresh-fallback').length, 0);

  const invocations = stubInvocations(s.stub);
  assert.strictEqual(invocations.length, 2, 'exactly two claude spawns');
  for (const claude of [claudeA, claudeB]) {
    assert.ok(
      invocations.some(args => args.includes('--session-id') && args.includes(claude)),
      `fresh spawn reuses session id ${claude}`
    );
  }

  // Stable across restarts: the ids must not chain (the pre-fix compounding loop).
  const state = readState();
  assert.strictEqual(state[idA].claudeSessionId, claudeA);
  assert.strictEqual(state[idB].claudeSessionId, claudeB);
});

test('tabs with transcripts resume their own sessions', async () => {
  for (const claude of [claudeA, claudeB]) {
    const p = transcriptPath(projDir, claude);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sessionId: claude, type: 'user' }) + '\n');
  }
  closeClients();
  const m = marks();
  await restartDaemon();
  const a = track(new Client());
  const b = track(new Client());
  const sa = await a.connect({ cwd: projDir, id: idA });
  const sb = await b.connect({ cwd: projDir, id: idB });
  assert.strictEqual(sa.claudeSessionId, claudeA);
  assert.strictEqual(sb.claudeSessionId, claudeB);

  await waitFor(() => traceEvents(since(m).daemon, 'resume').length === 2
    && stubInvocations(since(m).stub).length === 2, 'two path:"resume" traces + two stub spawns');
  const s = since(m);
  assert.strictEqual(traceEvents(s.daemon, 'fresh').length, 0);
  assert.strictEqual(traceEvents(s.daemon, 'resume-retry').length, 0);
  for (const claude of [claudeA, claudeB]) {
    assert.ok(
      stubInvocations(s.stub).some(args => args.includes('--resume') && args.includes(claude)),
      `resumed own session ${claude}`
    );
  }
});

test('a transient resume failure retries the same session once', async () => {
  closeClients();
  fs.writeFileSync(path.join(HOME, 'stub-control', 'fail-resumes'), '1');
  const m = marks();
  await restartDaemon();
  const a = track(new Client());
  await a.connect({ cwd: projDir, id: idA });

  await waitFor(() => traceEvents(since(m).daemon, 'resume-retry').length === 1
    && stubInvocations(since(m).stub).length === 2, 'a path:"resume-retry" trace + the retry spawn');
  // The retry succeeds (counter exhausted), so the chain must stop there.
  await new Promise(r => setTimeout(r, 500));
  const s = since(m);
  assert.strictEqual(traceEvents(s.daemon, 'fresh-fallback').length, 0, 'no fallback after a successful retry');
  const resumes = stubInvocations(s.stub).filter(args => args.includes('--resume') && args.includes(claudeA));
  assert.strictEqual(resumes.length, 2, 'initial --resume plus exactly one retry');
  assert.strictEqual(readState()[idA].claudeSessionId, claudeA, 'session id unchanged by the retry');
});

test('an unusable transcript ends in a fresh session under a NEW id — never -c', async () => {
  closeClients();
  fs.writeFileSync(path.join(HOME, 'stub-control', 'fail-resumes'), '99');
  const m = marks();
  await restartDaemon();
  const a = track(new Client());
  await a.connect({ cwd: projDir, id: idA });

  await waitFor(() => traceEvents(since(m).daemon, 'fresh-fallback').length === 1, 'a path:"fresh-fallback" trace');
  const s = since(m);
  assert.strictEqual(traceEvents(s.daemon, 'resume').length, 1);
  assert.strictEqual(traceEvents(s.daemon, 'resume-retry').length, 1);
  const fallback = traceEvents(s.daemon, 'fresh-fallback')[0];
  assert.ok(fallback.claude && fallback.claude !== claudeA, 'fallback minted a new session id');
  assert.ok(
    stubInvocations(s.stub).some(args => args.includes('--session-id') && args.includes(fallback.claude)),
    'fresh fallback spawned under the new id'
  );
  claudeA = fallback.claude; // A's session id from here on
  fs.writeFileSync(path.join(HOME, 'stub-control', 'fail-resumes'), '0');

  const shellsNow = await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json();
  assert.ok(
    shellsNow.shells.some(sh => sh.id === idA && sh.status === 'active'),
    'tab survived as an active (empty) session'
  );
});

test('the respawn chain is bounded — total failure cleans up, no loop', async () => {
  closeClients();
  fs.writeFileSync(path.join(HOME, 'stub-control', 'fail-all'), '');
  const m = marks();
  await restartDaemon();
  const a = track(new Client());
  await a.connect({ cwd: projDir, id: idA });

  // claudeA now has no transcript → preemptive fresh (attempt 1) dies →
  // fresh-fallback (attempt 2) dies → cleanup. Exactly two spawns, then a
  // close-tab to the client and the shell is gone.
  await waitFor(() => a.messages.some(msg => msg.type === 'close-tab'), 'close-tab after the chain gives up');
  const s = since(m);
  assert.strictEqual(traceEvents(s.daemon, 'fresh').length, 1);
  assert.strictEqual(traceEvents(s.daemon, 'fresh-fallback').length, 1);
  assert.strictEqual(stubInvocations(s.stub).length, 2, 'exactly two spawns — chain did not loop');

  const shellsNow = await (await fetch(`${BASE}/api/shells`, { headers: authHeaders() })).json();
  assert.ok(!shellsNow.shells.some(sh => sh.id === idA && sh.status === 'active'), 'shell cleaned up');
  fs.rmSync(path.join(HOME, 'stub-control', 'fail-all'));
});

test('claude -c never ran during any restore', () => {
  // The whole point of #542: `-c` is cwd-scoped and adopts a sibling tab's
  // conversation. Across every phase above, no spawn may carry a bare -c
  // (--mcp-config etc. contain "-c" as a substring, hence exact-arg matching).
  for (const args of stubInvocations(stubLog())) {
    assert.ok(!args.includes('-c'), `stub was invoked with -c: ${args.join(' ')}`);
    assert.ok(!args.includes('--fork-session'), `stub was invoked with --fork-session: ${args.join(' ')}`);
  }
});
