/**
 * Standalone integration tests for #519's server flows that need a private
 * daemon + a stub `claude`:
 *
 * 1. Meta Controls consent: meta_type while the setting is off asks the
 *    "browser" (a scripted live-reload WS client here) via confirm-meta-controls,
 *    honors decline (+ cooldown), flips the setting on approve, and never
 *    auto-confirms with zero browsers connected.
 * 2. /rc inheritance on server-side spawns: start_issue from a caller whose
 *    screen shows "/rc active" delivers `/rc` to the child FIRST, then the
 *    issue prompt — sequenced by deliverPromptWhenReady's per-shell queue.
 *
 * Own daemon (scratch $HOME, stub `claude` on PATH, random port), spawned in
 * before() and killed in after() — never the developer's real install.
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

// Fake claude: shows the /rc-active footer (what sessionHasRemoteControl greps
// for) and echoes every submitted line back as GOT:<line>. It also prints the
// idle composer footer at startup and after each echo so the #568 screen-state
// detector sees "at prompt" and deliverPromptWhenReady fires (real claude always
// shows this footer when idle; the old BEL/silence path no longer exists).
const CLAUDE_STUB = `#!/bin/bash
footer() { echo "⏵⏵ auto mode on (shift+tab to cycle)"; }
echo "stub claude started args: $*"
echo "/rc active"
footer
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
  echo "GOT:$line"
  footer
done
exit 0
`;

let tmpRoot, HOME, projDir, PORT, BASE;
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
  const env = { ...process.env, HOME, PORT: String(PORT), TMUX_TMPDIR: path.join(tmpRoot, 'tmux') };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // Suppress the cold-start browser auto-open (see window-restore.test.js): plant
  // the .restarting marker; the inert `open` stub on PATH is the backstop.
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

async function getJson(p) {
  const r = await fetch(`${BASE}${p}`, { headers: authHeaders() });
  assert.ok(r.ok, `GET ${p} -> ${r.status}`);
  return r.json();
}
async function postJson(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Session WS client with raw-output accumulation (terminal data is non-JSON).
class Client {
  constructor() { this.ws = null; this.session = null; this.rawOutput = ''; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        const str = data.toString();
        let msg;
        try { msg = JSON.parse(str); } catch { this.rawOutput += str; return; }
        if (msg && msg.type === 'session' && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  waitForOutput(pattern, what, timeoutMs = 15000) {
    return waitFor(() => pattern.test(this.rawOutput), what || `output ${pattern}`, timeoutMs);
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

// A scripted "browser window": a live-reload socket that collects the JSON
// messages the server pushes (confirm-meta-controls etc.).
class ReloadWindow {
  constructor() { this.ws = null; this.messages = []; }
  connect(windowId) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${BASE.replace(/^http/, 'ws')}/?action=reload&windowId=${encodeURIComponent(windowId)}`,
        { headers: authHeaders() }
      );
      this.ws.on('message', (data) => {
        try { this.messages.push(JSON.parse(data.toString())); } catch {}
      });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
  }
  waitForMessage(type, timeoutMs = 10000) {
    return waitFor(() => this.messages.find(m => m.type === type), `reload message ${type}`, timeoutMs);
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

let mcp = null;
async function mcpConnect() {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { ...authHeaders() } },
  });
  mcp = new McpClient({ name: 'meta-consent-test', version: '1.0.0' });
  await mcp.connect(transport);
}
function parseTool(result) {
  return JSON.parse(result.content[0].text);
}

const caller = new Client();
const windowA = new ReloadWindow();

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-519-'));
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
  await mcpConnect();
  await caller.connect({ cwd: projDir, new: '1', agentType: 'claude', windowId: 'win-a' });
  await caller.waitForOutput(/\/rc active/, 'caller stub to show the /rc-active footer');
});

after(async () => {
  try { if (mcp) await mcp.close(); } catch {}
  caller.close();
  windowA.close();
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// --- Meta Controls consent flow ---
// Order matters: no-clients runs before any reload socket exists; the approve
// flow runs before the decline flow because a decline arms a 60s cooldown.

test('meta_type with the gate off and zero browsers is refused, never auto-confirmed', async () => {
  const res = await mcp.callTool({
    name: 'meta_type',
    arguments: { session_id: caller.session.id, text: 'echo no-consent' },
  });
  assert.match(res.content[0].text, /No browser window is connected/);
  assert.strictEqual((await getJson('/api/settings')).metaControlsEnabled, false);
});

// Consent dialogs accumulate in windowA.messages across tests, so every wait
// must be for a NEW dialog (count-based), not a find() that can match a stale
// one — otherwise the decision POST races the dialog's server-side creation.
const consentAsks = () => windowA.messages.filter(m => m.type === 'confirm-meta-controls');
async function callAndAwaitConsentDialog(args) {
  const before = consentAsks().length;
  const callPromise = mcp.callTool({ name: 'meta_type', arguments: args });
  await waitFor(() => consentAsks().length > before, 'a new consent dialog');
  return { callPromise, ask: consentAsks()[consentAsks().length - 1] };
}

test('approving the consent dialog enables the setting and the call proceeds', async () => {
  await windowA.connect('win-a');

  const { callPromise, ask } = await callAndAwaitConsentDialog(
    { session_id: caller.session.id, text: 'hello-after-consent' },
  );
  assert.strictEqual(ask.target.id, caller.session.id);
  assert.ok(ask.target.name, 'dialog payload carries a display name');

  const reply = await postJson('/api/meta-controls-consent', { decision: 'confirmed' });
  assert.strictEqual(reply.ok, true);
  await windowA.waitForMessage('confirm-meta-controls-resolved');

  const out = parseTool(await callPromise);
  assert.strictEqual(out.submitted, true);
  assert.strictEqual(out.landed, true, `typed text should echo back, screen: ${JSON.stringify(out.screen_tail)}`);
  assert.strictEqual((await getJson('/api/settings')).metaControlsEnabled, true);
  await caller.waitForOutput(/GOT:hello-after-consent/, 'stub to receive the submitted text');
});

test('a stale consent reply is acknowledged as stale', async () => {
  const reply = await postJson('/api/meta-controls-consent', { decision: 'confirmed' });
  assert.strictEqual(reply.stale, true);
});

test('declining the consent dialog refuses the call and arms the cooldown', async () => {
  await postJson('/api/settings', { metaControlsEnabled: false });

  const { callPromise } = await callAndAwaitConsentDialog(
    { session_id: caller.session.id, text: 'echo declined' },
  );
  await postJson('/api/meta-controls-consent', { decision: 'declined' });
  const res = await callPromise;
  assert.match(res.content[0].text, /Meta Controls is disabled/);
  assert.match(res.content[0].text, /declined/);
  assert.strictEqual((await getJson('/api/settings')).metaControlsEnabled, false);

  // Cooldown: an immediate retry is refused WITHOUT a new dialog.
  const promptsBefore = consentAsks().length;
  const retry = await mcp.callTool({
    name: 'meta_type',
    arguments: { session_id: caller.session.id, text: 'echo nag' },
  });
  assert.match(retry.content[0].text, /declined/);
  assert.strictEqual(consentAsks().length, promptsBefore, 'cooldown must not re-prompt the user');
});

// --- /rc inheritance on server-side spawns ---

test('start_issue inherits /rc from the caller and delivers it before the issue prompt', async () => {
  const started = parseTool(await mcp.callTool({
    name: 'start_issue',
    arguments: {
      session_id: caller.session.id,
      number: 519,
      title: 'rc inherit check',
      body: 'RC-MARKER-BODY-519',
    },
  }));
  assert.ok(started.id, `start_issue should return the child id, got ${JSON.stringify(started)}`);

  // The daemon logs the inherit decision at spawn time.
  await waitFor(() => daemonLog.includes('[rc-inherit]'), 'rc-inherit log line');

  // Both prompts land through the per-shell queue: /rc first, then the issue
  // prompt on the next idle. read_session_screen (also #519) is the readback.
  const lines = await waitFor(async () => {
    const screen = parseTool(await mcp.callTool({
      name: 'read_session_screen',
      arguments: { session_id: started.id, lines: 120 },
    }));
    const l = screen.lines;
    return l.some(x => x.includes('GOT:/rc')) && l.some(x => x.includes('RC-MARKER-BODY-519')) ? l : null;
  }, 'child to receive /rc and the issue prompt', 30000, 500);

  const rcIdx = lines.findIndex(x => x.includes('GOT:/rc'));
  const promptIdx = lines.findIndex(x => x.includes('GOT:') && x.includes('GitHub issue #519'));
  assert.ok(rcIdx >= 0, `child should have received /rc, screen: ${JSON.stringify(lines)}`);
  assert.ok(promptIdx >= 0, `child should have received the issue prompt, screen: ${JSON.stringify(lines)}`);
  assert.ok(rcIdx < promptIdx, `/rc (line ${rcIdx}) must land before the issue prompt (line ${promptIdx})`);
});
