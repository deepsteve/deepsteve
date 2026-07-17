/**
 * Standalone fork-lineage tests (#503, regression guard for #497).
 *
 * Spawns its OWN throwaway daemon (scratch $HOME, stub `claude` on PATH, random
 * port) so it can restart the server and exercise the persisted-lineage path
 * end-to-end. Mirrors the harness in session-restore.test.js.
 *
 * What it proves:
 *   - A fork tab (`--resume <parent> --fork-session --session-id <child>`) records
 *     the parent lineage (`forkParent`) on the child, persisted to state.json.
 *   - The parent's fs.watch fork detector REFUSES to adopt the child's .jsonl even
 *     though that file embeds the parent's id — the #497 steal — via the authoritative
 *     `adoptClaudeSession` mutator. This holds while the child is live (oracle branch a)
 *     AND after a restart while the child is only persisted, not yet reconnected
 *     (oracle branch b — the tmux-orphan durability path).
 *   - A genuine self-fork (/clear, plan approval): a new .jsonl embedding the parent's
 *     id but owned by nobody IS adopted, and plan mode is reset.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/fork-lineage.test.js
 * or: sh test/run-standalone.sh
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Stub `claude`: logs argv, fails a --resume with no transcript on disk (so a fork
// off a never-prompted parent would exit fast), otherwise blocks on stdin like a
// live REPL and exits on /exit. Same behavior session-restore.test.js relies on.
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
let PORT;
let BASE;
let projDir;      // project dir for the fork pair (tests 1-2)
let projDir2;     // separate project dir for the self-fork test (isolates watchers)
let daemon = null;
let daemonLog = '';
let stubLogPath;

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
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // tmux's default socket is per-UID (not per-HOME), so a scratch-HOME daemon would
  // otherwise see the REAL daemon's ds-* sessions and — finding them absent from its
  // own state.json — kill them as orphans (server.js startup reattach). A scratch
  // TMUX_TMPDIR isolates the socket. Mandatory for any isolated daemon (see CLAUDE.md).
  env.TMUX_TMPDIR = path.join(HOME, 'tmux-tmp');
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

async function restartDaemon() {
  await stopDaemon();
  await startDaemon();
}

function readState() {
  return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));
}

function daemonSince(offset) { return daemonLog.slice(offset); }

// Claude Code's project-dir encoding (mirrors claudeProjectDir in server.js).
function projectDirFor(cwd) {
  return path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
}
function writeTranscript(cwd, sessionId, embedsId) {
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  // The server only does head.includes(<parentId>); embedsId is what makes the file
  // look like a fork of that session. A self-transcript passes embedsId === sessionId.
  const line = JSON.stringify({ type: 'summary', sessionId, parentSessionId: embedsId || sessionId }) + '\n';
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), line);
}

// Minimal WS client: resolve on the first `session` message.
class Client {
  constructor() { this.ws = null; this.session = null; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (typeof msg !== 'object' || msg === null) return;
        if (msg.type === 'session' && !this.session) {
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

let clients = [];
function track(c) { clients.push(c); return c; }
function closeClients() { for (const c of clients) c.close(); clients = []; }

let idP, claudeP;   // parent
let idC, claudeC;   // fork child

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fork-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  projDir2 = path.join(tmpRoot, 'proj2');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'tmux-tmp'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(projDir2, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(
    path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n',
    { mode: 0o755 }
  );
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

test('fork records forkParent lineage and its distinct child id (#503)', async () => {
  const parent = track(new Client());
  const sp = await parent.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  idP = sp.id; claudeP = sp.claudeSessionId;
  assert.ok(idP && claudeP, 'parent has a shell id + claude session id');

  // The fork spawns `claude --resume <claudeP> ...`; give the parent a transcript so
  // that --resume succeeds and the child stays alive (rather than exiting fast).
  writeTranscript(projDir, claudeP);

  const child = track(new Client());
  const sc = await child.connect({ cwd: projDir, new: '1', fork: idP, agentType: 'claude' });
  idC = sc.id; claudeC = sc.claudeSessionId;

  assert.ok(idC && idC !== idP, 'child has its own shell id');
  assert.ok(claudeC && claudeC !== claudeP, 'child has a distinct claude session id');

  // Lineage is recorded on the child and persisted (Part B + D). The fork path calls
  // saveState() right after shells.set, so state.json already reflects it.
  const state = await waitFor(() => {
    const s = readState();
    return (s[idC] && s[idC].forkParent) ? s : null;
  }, 'child forkParent persisted to state.json');
  assert.strictEqual(state[idC].forkParent, claudeP, 'child.forkParent === parent claude id');
  assert.strictEqual(state[idP].forkParent, null, 'parent (non-fork) has null forkParent');

  // Confirm the child stub actually spawned as a fork (didn't fast-exit). The stub
  // echoes its argv only once `zsh -l -c 'claude …'` execs it — after shells.set /
  // saveState above — so poll rather than read once.
  // The fork must --resume the parent's CURRENT session id (claudeP). With no rotation on
  // disk the resolver returns it unchanged, so this pins the fork-time resolution wiring
  // (server.js resolveForkParentSession) in the common case — a regression to a stale id
  // would surface here as a wrong --resume argument.
  await waitFor(() => {
    let stubLog = '';
    try { stubLog = fs.readFileSync(stubLogPath, 'utf8'); } catch { return false; }
    return stubLog.split('\n').some(l =>
      l.includes(`--resume ${claudeP}`) && l.includes('--fork-session') && l.includes(claudeC));
  }, 'child stub to spawn with --resume <parent> --fork-session --session-id <child>');
});

test('#497: parent watcher refuses the live child fork file (oracle branch a)', async () => {
  const off = daemonLog.length;
  // Simulate Claude writing the child's fork .jsonl — it embeds the PARENT's id, so
  // the parent's fs.watch fires. The child is a LIVE shell owning claudeC.
  writeTranscript(projDir, claudeC, /* embeds */ claudeP);

  await waitFor(
    () => daemonSince(off).includes(`Session ${idP} ignoring ${claudeC} — owned by another tab / fork child (fs-watch)`),
    'parent to REFUSE the child fork id (live)'
  );
  // Never stolen: no "claude session updated" for the parent toward the child id.
  assert.ok(
    !daemonSince(off).includes(`Session ${idP} claude session updated (fs-watch): ${claudeP} → ${claudeC}`),
    'parent did not adopt the child id'
  );
  const state = readState();
  assert.strictEqual(state[idP].claudeSessionId, claudeP, 'parent keeps its own claude session id');
});

test('#497 durability: after restart, parent refuses a NOT-yet-restored child (oracle branch b)', async () => {
  closeClients();
  await restartDaemon();

  // Lineage survived the restart via serializeShellEntry.
  const afterRestart = readState();
  assert.strictEqual(afterRestart[idC].forkParent, claudeP, 'forkParent persisted across restart');

  // Reconnect ONLY the parent. The child stays in savedState (with forkParent), NOT
  // live — the exact shape of an orphaned tmux fork that outlived the daemon.
  const parent = track(new Client());
  const sp = await parent.connect({ cwd: projDir, id: idP });
  assert.strictEqual(sp.id, idP);
  assert.strictEqual(sp.claudeSessionId, claudeP, 'parent resumed its own session');

  const off = daemonLog.length;
  // Fire the parent's watcher again with the child's fork file. Branch (a) can't help
  // now (child not live); only the persisted-forkParent branch (b) prevents the steal.
  writeTranscript(projDir, claudeC, /* embeds */ claudeP);

  await waitFor(
    () => daemonSince(off).includes(`Session ${idP} ignoring ${claudeC} — owned by another tab / fork child (fs-watch)`),
    'parent to REFUSE the child fork id (persisted-only)'
  );
  const state = readState();
  assert.strictEqual(state[idP].claudeSessionId, claudeP, 'parent still keeps its own id post-restart');
});

test('self-fork (/clear, plan approval) is still adopted, and plan mode resets', async () => {
  const p2 = track(new Client());
  // Start in plan mode so we can assert it flips off on the self-fork.
  const sp = await p2.connect({ cwd: projDir2, new: '1', agentType: 'claude', planMode: '1' });
  const idP2 = sp.id;
  const claudeP2 = sp.claudeSessionId;
  assert.strictEqual(readState()[idP2].planMode, true, 'parent started in plan mode');

  const off = daemonLog.length;
  // A genuine self-fork: a brand-new id, owned by nobody, whose file embeds the
  // current session id. This is exactly what /clear or plan-approval produces.
  const claudeNew = randomUUID();
  writeTranscript(projDir2, claudeNew, /* embeds */ claudeP2);

  await waitFor(
    () => daemonSince(off).includes(`Session ${idP2} claude session updated (fs-watch): ${claudeP2} → ${claudeNew}`),
    'parent to ADOPT the self-fork id'
  );
  const state = readState();
  assert.strictEqual(state[idP2].claudeSessionId, claudeNew, 'parent adopted the new self-fork id');
  assert.strictEqual(state[idP2].planMode, false, 'plan mode reset after the self-fork');
});

// NOTE on #455 coverage: the resolver's UNIQUE value over the existing fs.watch detector
// is (a) synchronous evaluation at the fork instant and (b) multi-hop A→B→C chaining. A
// live daemon can't isolate either deterministically — Node's fs.watch on macOS even
// REPLAYS pre-existing files as `rename` events when a watcher arms, so the watcher heals
// any resolvable rotation and races the resolver. The chaining + reference + mtime +
// ownership decision logic is therefore unit-tested in isolation in
// test/unit/fork-resolve.test.js (resolveForkTip). Test 1 above additionally asserts the
// integration wiring passes the resolved id straight through in the common no-rotation case.
