/**
 * Standalone start-issue tests (#642).
 *
 * Starting a session for a GitHub issue was written three times — the wand picker
 * (in the browser), POST /api/start-issue, and the MCP start_issue tool — and none
 * of the three had a test. The copies had drifted: only two inherited the caller's
 * `/rc`, only two recorded the session as recent, one guessed engineType instead of
 * taking it from spawnSession's return value, and the two server paths reported a
 * different cwd to the browser.
 *
 * All three now go through server.js's startIssueSession (the picker via the
 * `{type:'issue'}` WS message, which shares the rendering). This suite spawns its
 * OWN throwaway daemon — scratch $HOME, stub `claude` on PATH, random port — and
 * proves the two server entry points produce the same session, and that the HTTP
 * path picked up the two behaviours it was missing.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/start-issue.test.js
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

// Echoes what it is told, so a delivered prompt is observable on the session
// socket. The footer is what the #568 screen classifier reads as "waiting", which
// is what releases the prompt queue.
const CLAUDE_STUB = `#!/bin/bash
footer() { echo "⏵⏵ auto mode on (shift+tab to cycle)"; }
echo "stub claude started args: $*"
echo "$*" >> "$HOME/claude-invocations.log"
footer
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
  echo "GOT:$line"
  # sessionHasRemoteControl() reads this literal string off the screen.
  case "$line" in *"/rc"*) echo "/rc active" ;; esac
  footer
done
exit 0
`;

let tmpRoot, HOME, PORT, BASE, projDir, daemon = null, sandbox = null, daemonLog = '', mcp = null;

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
  try { return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim(); } catch { return ''; }
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

const statePath = () => path.join(HOME, '.deepsteve', 'state.json');
const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
function readRecent() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'recent-sessions.json'), 'utf8')); } catch { return []; }
}

// A live-reload socket is what a browser window IS, as far as the server is
// concerned: it is where `open-session` is delivered.
class ReloadWindow {
  constructor(windowId) { this.windowId = windowId; this.messages = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?action=reload&windowId=${encodeURIComponent(this.windowId)}`, { headers: authHeaders() });
      this.ws.on('message', d => { try { this.messages.push(JSON.parse(d.toString())); } catch {} });
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
    });
  }
  await(type, timeoutMs = 20000) {
    return waitFor(() => this.messages.find(m => m.type === type), `reload message ${type}`, timeoutMs);
  }
  close() { try { this.ws?.close(); } catch {} }
}

// A session socket: connects to an existing shell id and collects raw PTY output.
class SessionClient {
  constructor() { this.out = ''; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      this.ws.on('message', d => {
        const s = d.toString();
        try {
          const msg = JSON.parse(s);
          if (msg && typeof msg === 'object') { if (msg.type === 'session') { this.session = msg; resolve(msg); } return; }
        } catch {}
        this.out += s;
      });
      this.ws.on('error', reject);
      setTimeout(() => reject(new Error('WS session message timed out')), 15000);
    });
  }
  screen() { return this.out; }
  close() { try { this.ws?.close(); } catch {} }
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  // The daemon derives its tmux socket from $HOME/.deepsteve/tmux.sock and passes
  // it as `-S` (#625), so a scratch HOME IS a scratch tmux server. The sandbox
  // anchors on the same HOME so after() can reap the server that outlives the
  // daemon (shutdown detaches rather than kills).
  sandbox = TmuxSandbox.forHome(HOME);
  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', d => { daemonLog += d.toString(); });
  daemon.stderr.on('data', d => { daemonLog += d.toString(); });
  await waitFor(async () => {
    if (!authToken()) return false;
    const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
    return r.ok;
  }, 'daemon to become ready');
}

async function mcpConnect() {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  // /api/version answers before /mcp is mounted — wait for the route itself.
  await waitFor(async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
    return r.status !== 404;
  }, 'the /mcp endpoint to be mounted');
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { ...authHeaders() } } });
  mcp = new McpClient({ name: 'start-issue-test', version: '1.0.0' });
  await mcp.connect(transport);
}
const parseTool = (r) => JSON.parse(r.content[0].text);

async function startIssueHttp(bodyObj) {
  const r = await fetch(`${BASE}/api/start-issue`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  return { status: r.status, json: await r.json() };
}

// The fields that identify HOW a session was started. Deliberately excludes the
// volatile ones (id, claudeSessionId, timestamps) and the window it landed in.
const SHAPE = ['cwd', 'agentType', 'worktree', 'name', 'planMode', 'engineType', 'configDir'];
const shapeOf = (rec) => Object.fromEntries(SHAPE.map(k => [k, rec[k] ?? null]));

const win = new ReloadWindow('win-1');
const opened = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-642-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  // Inert `open`: the browser auto-open on the HTTP path must never reach a real browser.
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
  await win.connect();
  await mcpConnect();
});

after(async () => {
  try { await mcp?.close(); } catch {}
  win.close();
  if (daemon) {
    await new Promise(resolve => { daemon.on('exit', resolve); daemon.kill('SIGTERM'); setTimeout(resolve, 20000); });
    daemon = null;
  }
  sandbox?.cleanup();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('POST /api/start-issue spawns the session, renders the template, and tells the window', async () => {
  const res = await startIssueHttp({
    number: 642, title: 'Unify the three start-issue implementations behind one function',
    body: 'HTTP-MARKER-642', labels: 'chore', url: 'https://example.test/642',
    cwd: projDir, windowId: 'win-1',
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  assert.ok(res.json.id, 'response carries the new session id');
  opened.push(res.json.id);

  // Tab name is clipped to maxIssueTitleLength (25 by default), with an ellipsis.
  assert.equal(res.json.name, '#642 Unify the three star…');

  const msg = await win.await('open-session');
  assert.equal(msg.id, res.json.id);
  assert.equal(msg.loading, true, 'the tab opens in the loading state (#495/#512)');
  assert.equal(msg.name, res.json.name);

  // The prompt reaches the PTY: the stub echoes every line it reads.
  const client = new SessionClient();
  await client.connect({ id: res.json.id, cwd: projDir });
  await waitFor(() => client.screen().includes('HTTP-MARKER-642'), 'the rendered issue prompt to reach the PTY', 30000, 250);
  assert.ok(client.screen().includes('GitHub issue #642'), 'the template rendered {{number}}');
  client.close();

  const rec = readState()[res.json.id];
  assert.equal(rec.worktree, 'github-issue-642');
  assert.ok(rec.engineType, 'engineType is recorded');
});

test('the HTTP path records the session as recent (it used to, the MCP path did not)', async () => {
  await waitFor(() => readRecent().some(r => r.id === opened[0] || r.key), 'a recent-sessions entry', 10000);
  assert.ok(readRecent().length > 0, 'starting an issue records a recent session');
});

test('MCP start_issue produces the same session as POST /api/start-issue', async () => {
  // A caller session for the MCP tool to inherit from — same cwd and window as
  // the HTTP call above, so anything that differs is a real divergence.
  const caller = new SessionClient();
  await caller.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude' });
  const started = parseTool(await mcp.callTool({
    name: 'start_issue',
    arguments: {
      session_id: caller.session.id,
      number: 642, title: 'Unify the three start-issue implementations behind one function',
      body: 'MCP-MARKER-642', labels: 'chore', url: 'https://example.test/642',
    },
  }));
  assert.ok(started.id, `start_issue should return the child id, got ${JSON.stringify(started)}`);
  opened.push(started.id);

  const state = readState();
  assert.deepEqual(shapeOf(state[started.id]), shapeOf(state[opened[0]]),
    'the two entry points must produce the same session record (#642)');

  // The MCP result and the HTTP result agree on the derived values too.
  assert.equal(started.name, '#642 Unify the three star…');
  assert.equal(started.worktree, 'github-issue-642');
  caller.close();
});

test('the HTTP path inherits /rc from its caller (it did not before #642)', async () => {
  // maybeInheritRemoteControl fired on the WS and MCP spawn paths but never on
  // /api/start-issue, so an issue started by `curl` from an /rc session lost it.
  const caller = new SessionClient();
  await caller.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude' });
  // Put the caller into the state sessionHasRemoteControl() recognizes.
  caller.ws.send('/rc\r');
  await waitFor(() => caller.screen().includes('/rc active'), 'the caller to enter /rc', 20000, 250);

  const before = (daemonLog.match(/\[rc-inherit\]/g) || []).length;
  const res = await startIssueHttp({
    number: 519, title: 'rc inherit over HTTP', body: 'RC-HTTP-519',
    cwd: projDir, sessionId: caller.session.id,
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  opened.push(res.json.id);
  await waitFor(() => (daemonLog.match(/\[rc-inherit\]/g) || []).length > before,
    'the HTTP path to inherit /rc', 20000, 250);
  caller.close();
});

test('the wand picker path renders server-side from the issue fields', async () => {
  // The picker creates its own tab over the WS and then sends {type:'issue'}. It
  // used to send a prompt it had rendered in the browser from its own copy of
  // wandPromptTemplate — a second reader that silently disagreed with the
  // server's whenever the user edited the template (#642).
  const tab = new SessionClient();
  await tab.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude', worktree: 'github-issue-642' });
  opened.push(tab.session.id);
  tab.ws.send(JSON.stringify({
    type: 'issue',
    loading: true,
    issue: {
      number: 642,
      title: 'picker path',
      // The array-of-objects shape `gh issue list --json labels` returns — the
      // browser no longer flattens it, so the server has to.
      labels: [{ name: 'chore' }, { name: 'ui' }],
      url: 'https://example.test/642',
      body: 'PICKER-MARKER-642',
    },
  }));
  await waitFor(() => tab.screen().includes('PICKER-MARKER-642'), 'the rendered prompt to reach the PTY', 30000, 250);
  const screen = tab.screen();
  assert.ok(screen.includes('GitHub issue #642'), 'the template rendered {{number}}');
  assert.ok(screen.includes('chore, ui'), 'the server flattened the gh labels shape');
  tab.close();
});

test('a missing cwd is refused with 400 and a code, not a 500', async () => {
  const res = await startIssueHttp({ number: 1, title: 'gone', cwd: path.join(tmpRoot, 'no-such-dir') });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'cwd-missing');
});
