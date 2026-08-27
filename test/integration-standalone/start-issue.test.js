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
 * It also covers autopilot (#643) end to end: the flag reaching a real session entry
 * from all three start paths, the live flip changing what the issue_complete MCP tool
 * answers, and the value surviving a daemon restart.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/start-issue.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
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

// The `[issue] #N:` start line for one session (#653), off the daemon's own stdout.
// Matched on `id=` rather than the issue number: several tests below deliberately
// reuse #642, and the picker path logs from a different place in the file.
const issueLogFor = (id) => waitFor(
  () => daemonLog.split('\n').find(l => l.includes('[issue] #') && l.includes(`id=${id},`)),
  `the [issue] start line for ${id}`);

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
  awaitWhere(pred, what, timeoutMs = 20000) {
    return waitFor(() => this.messages.find(pred), `reload message ${what}`, timeoutMs);
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

// Only the last test restarts; the helper is the one from session-restore.test.js.
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

async function setAutopilot(id, autopilot) {
  const r = await fetch(`${BASE}/api/shells/${id}/autopilot`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ autopilot }),
  });
  return { status: r.status, json: await r.json() };
}

async function setIssueAutopilotDefault(issueAutopilot) {
  const r = await fetch(`${BASE}/api/settings`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueAutopilot }),
  });
  assert.equal(r.status, 200, 'POST /api/settings must accept issueAutopilot');
  assert.equal((await r.json()).issueAutopilot, issueAutopilot, 'the setting must echo back as posted');
}

const issueComplete = async (sessionId) =>
  parseTool(await mcp.callTool({ name: 'issue_complete', arguments: { session_id: sessionId } }));

// The fields that identify HOW a session was started. Deliberately excludes the
// volatile ones (id, claudeSessionId, timestamps) and the window it landed in.
const SHAPE = ['cwd', 'agentType', 'worktree', 'name', 'planMode', 'engineType', 'configDir', 'autopilot'];
const shapeOf = (rec) => Object.fromEntries(SHAPE.map(k => [k, rec[k] ?? null]));

const win = new ReloadWindow('win-1');
const opened = [];

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-642-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  // A real repo with a real commit, because every test below opens an issue session
  // with `worktree: github-issue-<n>` and since #656 a worktree is only granted to a
  // checkout that can actually host one. A bare mkdir is not a project any issue
  // could be opened against — the session would (correctly) come back with no
  // worktree, and the assertions here would fail for a reason unrelated to their
  // subject. -c rather than `git config` because this HOME has no global identity.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# proj\n');
  execFileSync('git', ['add', '.'], { cwd: projDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T',
    'commit', '-qm', 'first'], { cwd: projDir, stdio: 'ignore' });
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

  // #653: the line has to name the surface and the Autopilot value it resolved,
  // or "why did this session come up with Autopilot off?" is unanswerable later.
  const line = await issueLogFor(res.json.id);
  assert.match(line, /\[issue\] #642: /);
  assert.match(line, /source=http,/, 'the HTTP path must name itself (#653)');
  assert.match(line, /autopilot=off\(setting\)/, 'no argument + setting off reads as off(setting)');
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

  // Same session shape as the HTTP start above, but the log must still tell them
  // apart — #642 unified the implementations and left one indistinguishable line.
  assert.match(await issueLogFor(started.id), /source=mcp,/, 'the MCP path must name itself (#653)');
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

  // The picker never calls startIssueSession, so before #653 it was the one surface
  // with no `[issue]` line at all — its session only ever showed up as `[WS] Creating
  // NEW shell`, which says nothing about the issue or Autopilot.
  assert.match(await issueLogFor(tab.session.id), /source=ws-issue,/,
    'the picker path must log a start line of its own (#653)');
  tab.close();
});

test('a missing cwd is refused with 400 and a code, not a 500', async () => {
  const res = await startIssueHttp({ number: 1, title: 'gone', cwd: path.join(tmpRoot, 'no-such-dir') });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'cwd-missing');
});

// --- autopilot (#643) ------------------------------------------------------

test('the issue prompt carries the issue_complete instruction, autopilot or not', async () => {
  // The flag changes what the TOOL answers, never whether the instruction was
  // delivered — so it is in the prompt of a plain, autopilot-off session too.
  const res = await startIssueHttp({
    number: 6430, title: 'prompt carries the instruction', body: 'NO-AUTOPILOT-6430',
    cwd: projDir, windowId: 'win-1',
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  opened.push(res.json.id);
  assert.equal(readState()[res.json.id].autopilot, false, 'autopilot is off unless asked for');

  const client = new SessionClient();
  await client.connect({ id: res.json.id, cwd: projDir });
  await waitFor(() => client.screen().includes('issue_complete'),
    'the completion instruction to reach the PTY', 30000, 250);
  client.close();
});

test('the flag round-trips through POST /api/start-issue and MCP start_issue', async () => {
  const http = await startIssueHttp({
    number: 6431, title: 'autopilot over http', body: 'AUTOPILOT-HTTP-6431',
    cwd: projDir, windowId: 'win-1', autopilot: true,
  });
  assert.equal(http.status, 200, `expected 200, got ${http.status}: ${JSON.stringify(http.json)}`);
  opened.push(http.json.id);
  await waitFor(() => readState()[http.json.id] || null, 'the session to reach state.json');
  assert.equal(readState()[http.json.id].autopilot, true, 'HTTP must persist autopilot on the entry');

  const caller = new SessionClient();
  await caller.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude' });
  const started = parseTool(await mcp.callTool({
    name: 'start_issue',
    arguments: {
      session_id: caller.session.id, number: 6431, title: 'autopilot over mcp',
      body: 'AUTOPILOT-MCP-6431', autopilot: true,
    },
  }));
  opened.push(started.id);
  assert.equal(started.autopilot, true, 'the MCP result echoes the flag back');
  assert.equal(readState()[started.id].autopilot, true, 'MCP must persist autopilot on the entry');

  // Explicit true while issueAutopilot is off: the log spells out the disagreement,
  // because that is a caller redefining the user's remembered choice (#653).
  for (const id of [http.json.id, started.id]) {
    assert.match(await issueLogFor(id), /autopilot=on\(explicit, setting=off\)/,
      `an explicit flag that contradicts the setting must say so (${id})`);
  }
  caller.close();
});

test("the wand picker's issue message carries the checkbox", async () => {
  // The picker creates its own tab over the WS and never calls startIssueSession,
  // so the flag rides the {type:'issue'} message rather than the create query.
  const tab = new SessionClient();
  await tab.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude', worktree: 'github-issue-6432' });
  opened.push(tab.session.id);
  assert.equal(tab.session.autopilot, false, 'the session message reports the flag to the browser');
  tab.ws.send(JSON.stringify({
    type: 'issue', loading: true, autopilot: true,
    issue: { number: 6432, title: 'picker autopilot', body: 'PICKER-AUTOPILOT-6432' },
  }));
  await waitFor(() => readState()[tab.session.id]?.autopilot === true,
    'the picker flag to land on the entry and be persisted', 20000, 250);
  tab.close();
});

test('flipping the flag on a live session changes what issue_complete answers', async () => {
  // The acceptance criterion for "off fully cancels autopilot": nothing is delivered
  // to the session in either direction, and the answer follows the current value.
  const res = await startIssueHttp({
    number: 6433, title: 'live flip', body: 'FLIP-6433',
    cwd: projDir, windowId: 'win-1', autopilot: true,
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  const id = res.json.id;
  opened.push(id);

  assert.deepEqual(
    { autopilot: true, next: 'merge' },
    (({ autopilot, next }) => ({ autopilot, next }))(await issueComplete(id)),
    'autopilot on: the tool tells the session to merge itself');

  const off = await setAutopilot(id, false);
  assert.equal(off.status, 200);
  assert.equal(off.json.autopilot, false);
  const stopped = await issueComplete(id);
  assert.equal(stopped.autopilot, false);
  assert.equal(stopped.next, 'stop', 'flipping off before the call must change the answer');

  await setAutopilot(id, true);
  assert.equal((await issueComplete(id)).next, 'merge', 'and back on again');

  const missing = await setAutopilot('nosuchid', true);
  assert.equal(missing.status, 404, 'an unknown session is a 404, not a silent write');
});

test('the server announces the value rather than letting each window guess', async () => {
  // Two reasons this is a broadcast and not a local write. The picker's
  // {type:'issue'} reaches the server AFTER the {type:'session'} message that
  // reports the session's fields, so that message always says false on a picker
  // start; and a flip made in one window has to reach the tab strip in the others.
  const tab = new SessionClient();
  await tab.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude', worktree: 'github-issue-6435' });
  const id = tab.session.id;
  opened.push(id);
  assert.equal(tab.session.autopilot, false, 'the session message can only report what is known at connect time');

  tab.ws.send(JSON.stringify({
    type: 'issue', loading: true, autopilot: true,
    issue: { number: 6435, title: 'broadcast on picker start', body: 'BROADCAST-6435' },
  }));
  const announced = await win.awaitWhere(m => m.type === 'autopilot' && m.id === id, `autopilot for ${id}`);
  assert.equal(announced.autopilot, true, 'the picker start must be announced back');

  await setAutopilot(id, false);
  const off = await win.awaitWhere(m => m.type === 'autopilot' && m.id === id && m.autopilot === false,
    `autopilot off for ${id}`);
  assert.equal(off.autopilot, false, 'a live flip must be announced to every window');
  tab.close();
});

// --- the remembered preference (#651) ---------------------------------------
// Autopilot used to be remembered only in the browser's localStorage, so it seeded
// exactly one of the four spawn paths. These four assert the other three now read
// the same server-owned value — and that an explicit argument still overrides it.

test('an omitted autopilot seeds from the issueAutopilot setting, on every path', async () => {
  await setIssueAutopilotDefault(true);
  try {
    // MCP start_issue, no `autopilot` argument at all — the path a skill or an
    // autonomous agent takes, and the one that used to always come up off.
    const caller = new SessionClient();
    await caller.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude' });
    const started = parseTool(await mcp.callTool({
      name: 'start_issue',
      arguments: {
        session_id: caller.session.id, number: 6510, title: 'mcp inherits the preference',
        body: 'PREF-MCP-6510',
      },
    }));
    opened.push(started.id);
    assert.equal(started.autopilot, true, 'the MCP result must echo the inherited value');
    assert.equal(readState()[started.id].autopilot, true, 'MCP must persist the inherited value');
    caller.close();

    // POST /api/start-issue with no autopilot field.
    const http = await startIssueHttp({
      number: 6511, title: 'http inherits the preference', body: 'PREF-HTTP-6511',
      cwd: projDir, windowId: 'win-1',
    });
    assert.equal(http.status, 200, `expected 200, got ${http.status}: ${JSON.stringify(http.json)}`);
    opened.push(http.json.id);
    await waitFor(() => readState()[http.json.id] || null, 'the session to reach state.json');
    assert.equal(readState()[http.json.id].autopilot, true, 'HTTP must persist the inherited value');

    // #653: seeded, not chosen — the log has to say which, since "on because the
    // setting says so" and "on because the caller asked" are different facts.
    for (const id of [started.id, http.json.id]) {
      assert.match(await issueLogFor(id), /autopilot=on\(setting\)/,
        `an omitted autopilot must log as seeded from the setting (${id})`);
    }
  } finally {
    await setIssueAutopilotDefault(false);
  }
});

test('an explicit autopilot still wins over the setting', async () => {
  await setIssueAutopilotDefault(true);
  try {
    // The regression a naive `settings.issueAutopilot || autopilot` would introduce:
    // a caller that means "off for this one" can no longer say so.
    const res = await startIssueHttp({
      number: 6512, title: 'explicit off beats the preference', body: 'PREF-EXPLICIT-6512',
      cwd: projDir, windowId: 'win-1', autopilot: false,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
    opened.push(res.json.id);
    await waitFor(() => readState()[res.json.id] || null, 'the session to reach state.json');
    assert.equal(readState()[res.json.id].autopilot, false, 'an explicit false must not be overridden');

    const caller = new SessionClient();
    await caller.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude' });
    const started = parseTool(await mcp.callTool({
      name: 'start_issue',
      arguments: {
        session_id: caller.session.id, number: 6513, title: 'mcp explicit off',
        body: 'PREF-EXPLICIT-MCP-6513', autopilot: false,
      },
    }));
    opened.push(started.id);
    assert.equal(started.autopilot, false, 'MCP: an explicit false must not be overridden');
    assert.equal(readState()[started.id].autopilot, false, 'MCP: the entry must record the explicit false');

    // The case #653 exists for: a caller — an agent, over MCP — turned Autopilot off
    // for a user whose remembered preference is on. The behaviour is deliberate and
    // unchanged; what was missing is any record that it happened.
    for (const id of [res.json.id, started.id]) {
      assert.match(await issueLogFor(id), /autopilot=off\(explicit, setting=on\)/,
        `an explicit off against a setting of on must be visible in the log (${id})`);
    }
    caller.close();
  } finally {
    await setIssueAutopilotDefault(false);
  }
});

test('an explicit autopilot that AGREES with the setting stays terse in the log (#653)', async () => {
  // The `setting=` clause exists to flag a caller overriding the user, so it must not
  // appear when there is nothing to flag — otherwise the noisy form loses its meaning.
  await setIssueAutopilotDefault(true);
  try {
    const res = await startIssueHttp({
      number: 6530, title: 'explicit agrees with the setting', body: 'AGREE-6530',
      cwd: projDir, windowId: 'win-1', autopilot: true,
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
    opened.push(res.json.id);
    const line = await issueLogFor(res.json.id);
    assert.match(line, /autopilot=on\(explicit\)/, 'an explicit value matching the setting reads as plain explicit');
    assert.doesNotMatch(line, /setting=/, 'no contradiction, so no setting= clause');
  } finally {
    await setIssueAutopilotDefault(false);
  }
});

test("the picker's issue message inherits the preference when it omits the key", async () => {
  // The picker itself always sends an explicit boolean; this covers any other client
  // of the {type:'issue'} message, and keeps that path on the same rule as the rest.
  await setIssueAutopilotDefault(true);
  try {
    const tab = new SessionClient();
    await tab.connect({ new: '1', cwd: projDir, windowId: 'win-1', agentType: 'claude', worktree: 'github-issue-6514' });
    opened.push(tab.session.id);
    tab.ws.send(JSON.stringify({
      type: 'issue', loading: true,
      issue: { number: 6514, title: 'picker inherits', body: 'PREF-PICKER-6514' },
    }));
    await waitFor(() => readState()[tab.session.id]?.autopilot === true,
      'the inherited flag to land on the entry and be persisted', 20000, 250);
    tab.close();
  } finally {
    await setIssueAutopilotDefault(false);
  }
});

test('with the setting off, an omitted autopilot is still off', async () => {
  // The default has to stay fail-closed: nothing merges itself unless asked.
  const res = await startIssueHttp({
    number: 6515, title: 'default stays off', body: 'PREF-DEFAULT-OFF-6515',
    cwd: projDir, windowId: 'win-1',
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  opened.push(res.json.id);
  await waitFor(() => readState()[res.json.id] || null, 'the session to reach state.json');
  assert.equal(readState()[res.json.id].autopilot, false, 'the preference defaults to off');
});

// LAST in the file: the restart leaves this suite's MCP client and reload window
// dead, so nothing after it could use them.
test('autopilot survives a daemon restart', async () => {
  const res = await startIssueHttp({
    number: 6434, title: 'survives restart', body: 'RESTART-6434',
    cwd: projDir, windowId: 'win-1', autopilot: true,
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);
  const id = res.json.id;
  opened.push(id);
  await waitFor(() => readState()[id]?.autopilot === true, 'the flag to reach state.json');

  await restartDaemon();

  // Whether the pane was reattached (tmux) or is waiting to be restored (node-pty),
  // the value came back through serializeShellEntry either way.
  const rec = await waitFor(() => readState()[id] || null, 'the record after restart');
  assert.equal(rec.autopilot, true, 'autopilot must survive a restart (serializeShellEntry)');
});
