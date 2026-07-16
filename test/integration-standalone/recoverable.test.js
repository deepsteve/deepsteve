/**
 * Standalone tests for GET /api/recoverable-sessions (#560).
 *
 * Like window-restore.test.js, this spawns its OWN throwaway daemon — scratch
 * $HOME, stub `claude` on PATH, random port — so nothing here can touch a real
 * install.
 *
 * What it proves:
 *   - The recover-everything view is a strict superset of /api/windows: window
 *     groups keep their shape (plus worktree/label enrichment), while the
 *     buckets /api/windows deliberately omits become offerable — ungrouped
 *     sessions (no windowId), closed tombstones (#561), and recent-session
 *     lineages that state.json no longer knows (explicit ?forget=1).
 *   - A live session a browser is actually showing (clients > 0) is never
 *     offered as "ungrouped" — it isn't lost, it's open.
 *   - Closed tombstones stay out of `windows` and `knownSessionIds` (so the
 *     client-side mergeWindows prunes them from window groups instead of
 *     offering them twice).
 *   - Unnamed sessions get a `label` derived from their transcript (the
 *     ai-title line, else the first user message, truncated); named sessions
 *     don't pay for derivation (label stays null).
 *
 * Run: sh test/run-standalone.sh
 *   or: node --test --test-timeout=180000 test/integration-standalone/recoverable.test.js
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

// See window-restore.test.js: plant the .restarting marker so the daemon never
// auto-opens the developer's real browser, and keep an inert `open` on PATH.
function suppressBrowserAutoOpen() {
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
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

async function getRecoverable() {
  const r = await fetch(`${BASE}/api/recoverable-sessions`, { headers: authHeaders() });
  assert.ok(r.ok, `GET /api/recoverable-sessions -> ${r.status}`);
  return r.json();
}

// Claude Code's cwd-flattening rule (claudeProjectDir in server.js).
function transcriptPath(claudeSessionId) {
  const dirName = projDir.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(HOME, '.claude', 'projects', dirName, `${claudeSessionId}.jsonl`);
}

function writeTranscript(claudeSessionId, lines) {
  const file = transcriptPath(claudeSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
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

let clients = [];
function track(c) { clients.push(c); return c; }
function closeClients() { for (const c of clients) c.close(); clients = []; }

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-recoverable-'));
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
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Session handles shared across tests (node:test runs a file's tests serially).
let grouped;    // stays open, in a window — the /api/windows baseline
let ungrouped;  // no windowId, client disconnects → the ungrouped bucket
let tombstoned; // DELETEd → the closed bucket
let forgotten;  // DELETE ?forget=1 → only its recents lineage survives

test('buckets: windows, ungrouped, closed, and recents each capture their case', async () => {
  const a = track(new Client());
  const b = track(new Client());
  const c = track(new Client());
  const d = track(new Client());
  grouped = await a.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-keep', name: 'Named tab' });
  ungrouped = await b.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  tombstoned = await c.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-dead' });
  forgotten = await d.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-forgot' });

  // While a client is attached, the windowId-less session must NOT be offered —
  // it's open in a browser, not lost.
  let payload = await getRecoverable();
  assert.ok(!payload.ungrouped.some(s => s.id === ungrouped.id),
    'live session with a connected client is not "recoverable"');

  // Detach the client (no close-session message — the shell stays alive with
  // zero clients, like a closed laptop lid) → now it belongs in ungrouped.
  b.close();
  payload = await waitFor(async () => {
    const p = await getRecoverable();
    return p.ungrouped.some(s => s.id === ungrouped.id) ? p : null;
  }, 'detached windowId-less session to appear in ungrouped');

  // Tombstone c (#561: DELETE without ?forget keeps a closed record). force=1
  // skips the connected-clients 409 — the WS close above races the DELETE.
  c.close();
  let r = await fetch(`${BASE}/api/shells/${tombstoned.id}?force=1`, { method: 'DELETE', headers: authHeaders() });
  assert.ok(r.ok, `DELETE -> ${r.status}`);

  // Hard-forget d — its only trace left is the recent-sessions ring buffer.
  d.close();
  r = await fetch(`${BASE}/api/shells/${forgotten.id}?forget=1&force=1`, { method: 'DELETE', headers: authHeaders() });
  assert.ok(r.ok, `DELETE ?forget=1 -> ${r.status}`);

  payload = await getRecoverable();

  // Window group survives with its named session, /api/windows-shaped.
  const winKeep = payload.windows.find(w => w.windowId === 'win-keep');
  assert.ok(winKeep, 'win-keep still grouped');
  const namedRow = winKeep.sessions.find(s => s.id === grouped.id);
  assert.strictEqual(namedRow.name, 'Named tab');
  assert.strictEqual(namedRow.label, null, 'named session pays nothing for label derivation');

  // Closed bucket: tombstone metadata, and excluded from windows/knownSessionIds.
  const closedRow = payload.closed.find(s => s.id === tombstoned.id);
  assert.ok(closedRow, 'tombstone offered in closed bucket');
  assert.strictEqual(closedRow.status, 'closed');
  assert.strictEqual(closedRow.closeReason, 'closed');
  assert.ok(closedRow.closedAt > 0, 'closedAt stamped');
  assert.ok(!payload.windows.some(w => w.sessions.some(s => s.id === tombstoned.id)),
    'tombstone not offered as a window group');
  assert.ok(!payload.knownSessionIds.includes(tombstoned.id),
    'tombstone stays out of knownSessionIds so mergeWindows prunes it from local groups');

  // Recents bucket: only the forgotten lineage, keyed by claudeSessionId.
  const forgottenClaudeId = payload.recents.length ? payload.recents[0].key : null;
  assert.strictEqual(payload.recents.length, 1, 'exactly one lineage has no state.json record');
  assert.strictEqual(payload.recents[0].cwd, projDir);
  assert.ok(forgottenClaudeId, 'recents row keyed by claudeSessionId');
  assert.ok(!payload.recents.some(rr => rr.key === readState()[tombstoned.id].claudeSessionId),
    'tombstoned lineage is deduped out of recents — savedState wins');
});

test('unnamed sessions get transcript-derived labels; ai-title wins over the first user message', async () => {
  const state = readState();
  const claudeId = state[tombstoned.id].claudeSessionId;
  assert.ok(claudeId, 'tombstone kept its claudeSessionId');

  writeTranscript(claudeId, [
    { type: 'user', message: { role: 'user', content: 'please fix the flux capacitor' } },
    { type: 'ai-title', aiTitle: 'Fix the flux capacitor', sessionId: claudeId },
  ]);

  const payload = await getRecoverable();
  const row = payload.closed.find(s => s.id === tombstoned.id);
  assert.strictEqual(row.label, 'Fix the flux capacitor', 'ai-title preferred');

  // Re-derivation is mtime-keyed: rewrite with a >80-char title, expect
  // truncation with an ellipsis.
  await new Promise(r => setTimeout(r, 10)); // ensure a distinct mtime
  const longTitle = 'x'.repeat(100);
  writeTranscript(claudeId, [{ type: 'ai-title', aiTitle: longTitle, sessionId: claudeId }]);
  const row2 = (await getRecoverable()).closed.find(s => s.id === tombstoned.id);
  assert.strictEqual(row2.label.length, 80);
  assert.ok(row2.label.endsWith('…'));
});

test('label falls back to the first non-sidechain user message', async () => {
  const forgottenKey = (await getRecoverable()).recents[0].key; // claudeSessionId
  writeTranscript(forgottenKey, [
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain noise' } },
    { type: 'user', message: { role: 'user', content: '  investigate the   flaky test\n\nplease  ' } },
  ]);

  const payload = await getRecoverable();
  const row = payload.recents.find(rr => rr.key === forgottenKey);
  assert.strictEqual(row.label, 'investigate the flaky test please', 'whitespace collapsed, sidechain skipped');
});

test('a closed tombstone still resumes via the plain WS reconnect and is consumed', async () => {
  const c2 = track(new Client());
  const restored = await c2.connect({ cwd: projDir, id: tombstoned.id, windowId: 'win-new' });
  assert.strictEqual(restored.id, tombstoned.id, 'same shell id — reconnect, not a fresh spawn');

  await waitFor(async () => {
    const p = await getRecoverable();
    return !p.closed.some(s => s.id === tombstoned.id);
  }, 'tombstone to be consumed by the restore');

  const payload = await getRecoverable();
  const winNew = payload.windows.find(w => w.windowId === 'win-new');
  assert.ok(winNew && winNew.sessions.some(s => s.id === tombstoned.id),
    'restored session regrouped under the connecting windowId');
});
