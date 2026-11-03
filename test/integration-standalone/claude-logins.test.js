/**
 * Standalone Claude-logins tests (#748): several Claude accounts, one per project.
 *
 * Spawns its OWN throwaway daemon (scratch $HOME, stub `claude` on PATH, random port)
 * on the default tmux engine, so it can read a pane's tmux environment, take a pane
 * down to force a real respawn, and restart the server.
 *
 * The stub writes down the CLAUDE_CODE_OAUTH_TOKEN it was started with. That variable is
 * the whole mechanism — Claude Code signs in with it — so what the stub saw IS which
 * account the session would have been.
 *
 * What it proves:
 *   - The API stores a token and never returns it; bad input is refused.
 *   - A Claude session in a project assigned to a login starts with that login's token;
 *     one in an unassigned project, a terminal tab and a project-less cwd start with none.
 *   - The token is in neither the tmux session's environment nor the daemon log — only
 *     the token file's path is.
 *   - A project edit that omits claudeLoginId keeps the login.
 *   - Moving a project leaves a running session alone, and a session respawned after
 *     the move (a restore, via --resume) comes back under the NEW login.
 *   - Removing a login moves its projects to System and deletes its token file.
 *   - A login's plan reaches its sessions as CLAUDE_CODE_SUBSCRIPTION_TYPE, a System
 *     session gets none, and changing the plan applies at the next spawn.
 *
 * Run directly: node --test --test-timeout=180000 test/integration-standalone/claude-logins.test.js
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
const SKIP = TmuxSandbox.skipReason();

const TOKEN_WORK = 'sk-ant-oat01-WORKWORKWORKWORKWORKWORKWORKWORKwork';
const TOKEN_PERSONAL = 'sk-ant-oat01-PERSONALPERSONALPERSONALPERSONALpers';

// Stub `claude`: logs the token and plan it was started with plus its argv, then acts like a
// live REPL so the session stays up until /exit.
const CLAUDE_STUB = `#!/bin/bash
echo "token=\${CLAUDE_CODE_OAUTH_TOKEN:-<none>} sub=\${CLAUDE_CODE_SUBSCRIPTION_TYPE:-<none>} args=$*" >> "$HOME/claude-invocations.log"
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

let tmpRoot, HOME, PORT, BASE;
let projWork, projHome, elsewhere;
let daemon = null;
let sandbox = null;
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
  try { return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim(); } catch { return ''; }
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
  // Don't leak the invoking environment into the daemon (see tombstone.test.js) — and
  // above all not a real CLAUDE_CODE_OAUTH_TOKEN, which would make "<none>" unreachable.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  // A scratch HOME is a scratch tmux server: the daemon's socket is $HOME/.deepsteve/tmux.sock.
  sandbox = TmuxSandbox.forHome(HOME);
  daemon = spawn('node', ['server.js', '--test-mode'], { cwd: REPO_ROOT, env });
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

async function api(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

function stubLines() {
  try { return fs.readFileSync(stubLogPath, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
// The token the stub saw for the spawn whose argv carries `marker` (a claude session id).
async function tokenSeenFor(marker, { resume = false } = {}) {
  const line = await waitFor(() => stubLines().find(l => l.includes(marker) && (!resume || l.includes('--resume'))),
    `stub invocation carrying ${marker}${resume ? ' with --resume' : ''}`);
  return line.match(/^token=(\S+)/)[1];
}
// The plan (CLAUDE_CODE_SUBSCRIPTION_TYPE) the stub saw for that spawn.
async function planSeenFor(marker, { resume = false } = {}) {
  const line = await waitFor(() => stubLines().find(l => l.includes(marker) && (!resume || l.includes('--resume'))),
    `stub invocation carrying ${marker}${resume ? ' with --resume' : ''}`);
  return line.match(/ sub=(\S+)/)[1];
}

// Claude Code's project-dir encoding (mirrors claudeProjectDir in server.js).
function transcriptPath(cwd, sessionId) {
  return path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${sessionId}.jsonl`);
}

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
const track = (c) => { clients.push(c); return c; };
function closeClients() { for (const c of clients) c.close(); clients = []; }

let workId, personalId;           // login ids
let workSession;                  // { id, claudeSessionId } of the Work project's first tab

before(async () => {
  if (SKIP) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-logins-'));
  HOME = path.join(tmpRoot, 'home');
  projWork = path.join(tmpRoot, 'work');
  projHome = path.join(tmpRoot, 'home-proj');
  elsewhere = path.join(tmpRoot, 'elsewhere');
  for (const d of [path.join(HOME, 'bin'), projWork, projHome, elsewhere]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');
  stubLogPath = path.join(HOME, 'claude-invocations.log');
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  if (SKIP) return;
  closeClients();
  await stopDaemon().catch(() => {});
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('the API stores a token and never hands one back', { skip: SKIP }, async () => {
  assert.deepStrictEqual((await api('GET', '/api/claude-logins')).json, { logins: [] });

  const bad = await api('POST', '/api/claude-logins', { name: 'Work', token: 'two words' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /line/);
  assert.strictEqual((await api('POST', '/api/claude-logins', { name: 'System', token: TOKEN_WORK })).status, 400);

  assert.match((await api('POST', '/api/claude-logins', { name: 'Work', token: TOKEN_WORK, plan: 'team' })).json.error, /plan/);
  const w = await api('POST', '/api/claude-logins', { name: 'Work', token: TOKEN_WORK, plan: 'max' });
  assert.strictEqual(w.status, 200, w.text);
  workId = w.json.login.id;
  const p = await api('POST', '/api/claude-logins', { name: 'Personal', token: TOKEN_PERSONAL });
  personalId = p.json.login.id;
  assert.strictEqual((await api('POST', '/api/claude-logins', { name: 'work', token: TOKEN_WORK })).status, 400, 'names are unique ignoring case');

  const list = await api('GET', '/api/claude-logins');
  assert.deepStrictEqual(list.json.logins.map(l => [l.name, l.hint, l.plan, l.missing]), [['Work', '…work', 'max', false], ['Personal', '…pers', 'pro', false]]);
  for (const r of [w, p, list]) {
    assert.ok(!r.text.includes(TOKEN_WORK) && !r.text.includes(TOKEN_PERSONAL), 'no response carries a token');
  }
  const file = path.join(HOME, '.deepsteve', 'claude-logins', `${workId}.token`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), TOKEN_WORK);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual((await api('DELETE', '/api/claude-logins/ffff0000')).status, 404);
  assert.strictEqual((await api('POST', '/api/claude-logins/ffff0000', { plan: 'max' })).status, 404);
  assert.strictEqual((await api('POST', `/api/claude-logins/${personalId}`, { plan: 'enterprise' })).status, 400);
});

test('a project carries the login it is assigned; an unknown id is System', { skip: SKIP }, async () => {
  await api('POST', '/api/contexts', { id: 'workproj', name: 'Work repo', dirs: [projWork], claudeLoginId: workId });
  await api('POST', '/api/contexts', { id: 'homeproj', name: 'Home repo', dirs: [projHome] });
  await api('POST', '/api/contexts', { id: 'bogus', name: 'Bogus', dirs: [elsewhere + '-nope'], claudeLoginId: 'ffff0000' });
  const { contexts } = (await api('GET', '/api/contexts')).json;
  const byId = Object.fromEntries(contexts.map(c => [c.id, c]));
  assert.strictEqual(byId.workproj.claudeLoginId, workId);
  assert.strictEqual(byId.homeproj.claudeLoginId, null);
  assert.strictEqual(byId.bogus.claudeLoginId, null);
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'contexts.json'), 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes(TOKEN_WORK), 'contexts.json holds the id, not the token');
});

test('a Claude session signs in as its project\'s login, and only that', { skip: SKIP }, async () => {
  const w = await track(new Client()).connect({ cwd: projWork, new: '1', agentType: 'claude' });
  assert.strictEqual(w.engineType, 'tmux', 'the default engine, where env travels as tmux -e');
  workSession = { id: w.id, claudeSessionId: w.claudeSessionId };
  assert.strictEqual(await tokenSeenFor(w.claudeSessionId), TOKEN_WORK);
  assert.strictEqual(await planSeenFor(w.claudeSessionId), 'max', 'the login\'s plan, not a fixed one');

  const h = await track(new Client()).connect({ cwd: projHome, new: '1', agentType: 'claude' });
  assert.strictEqual(await tokenSeenFor(h.claudeSessionId), '<none>', 'unassigned project → System');
  assert.strictEqual(await planSeenFor(h.claudeSessionId), '<none>', 'System keeps its stored login\'s own plan');

  const e = await track(new Client()).connect({ cwd: elsewhere, new: '1', agentType: 'claude' });
  assert.strictEqual(await tokenSeenFor(e.claudeSessionId), '<none>', 'no project → System');

  // The tmux session's environment names the FILE; the token is nowhere in it.
  const env = sandbox.run(['show-environment', '-t', `ds-${w.id}`]);
  assert.ok(env.includes(`DEEPSTEVE_CLAUDE_TOKEN_FILE=${path.join(HOME, '.deepsteve', 'claude-logins', `${workId}.token`)}`), env);
  assert.ok(!env.includes(TOKEN_WORK), 'the token is not in the tmux environment');
  // An injected token has no plan, and a null plan makes Claude fetch remote managed
  // settings with it and print a 401 warning; the login's session names one.
  assert.ok(env.includes('CLAUDE_CODE_SUBSCRIPTION_TYPE=max'), env);
  const homeEnv = sandbox.run(['show-environment', '-t', `ds-${h.id}`]);
  assert.ok(!homeEnv.includes('DEEPSTEVE_CLAUDE_TOKEN_FILE'), 'a System session gets no token file at all');
  assert.ok(!homeEnv.includes('CLAUDE_CODE_SUBSCRIPTION_TYPE'), 'a System session keeps its stored login\'s own plan');
  assert.ok(!daemonLog.includes(TOKEN_WORK) && !daemonLog.includes(TOKEN_PERSONAL), 'the daemon never logs a token');
});

test('a plain terminal tab in an assigned project gets no token file', { skip: SKIP }, async () => {
  const t = await track(new Client()).connect({ cwd: projWork, new: '1', agentType: 'terminal' });
  const env = await waitFor(() => { try { return sandbox.run(['show-environment', '-t', `ds-${t.id}`]); } catch { return null; } },
    'terminal tmux session');
  assert.ok(!env.includes('DEEPSTEVE_CLAUDE_TOKEN_FILE'), env);
  assert.ok(!env.includes('CLAUDE_CODE_SUBSCRIPTION_TYPE'), env);
});

test('an edit that leaves out claudeLoginId keeps the login', { skip: SKIP }, async () => {
  await api('POST', '/api/contexts', { id: 'workproj', name: 'Work repo (renamed)', dirs: [projWork] });
  const c = (await api('GET', '/api/contexts')).json.contexts.find(x => x.id === 'workproj');
  assert.strictEqual(c.name, 'Work repo (renamed)');
  assert.strictEqual(c.claudeLoginId, workId);
});

test('moving a project: running sessions keep theirs, a respawned one comes back under the new login', { skip: SKIP }, async () => {
  await api('POST', '/api/contexts', { id: 'workproj', name: 'Work repo', dirs: [projWork], claudeLoginId: personalId });
  assert.match(daemonLog, /project "Work repo" now uses "Personal"/);
  const runningEnv = sandbox.run(['show-environment', '-t', `ds-${workSession.id}`]);
  assert.ok(runningEnv.includes(`${workId}.token`), 'the live session was not touched');
  // A plan change applies at the next spawn too: Personal was added as Pro.
  const pl = await api('POST', `/api/claude-logins/${personalId}`, { plan: 'max' });
  assert.strictEqual(pl.status, 200, pl.text);
  assert.strictEqual(pl.json.login.plan, 'max');

  // Give it a transcript so the restore takes the --resume path, then take its pane
  // down while the daemon is stopped: startup finds no pane, and the reconnect
  // respawns it through the restore branch.
  const t = transcriptPath(projWork, workSession.claudeSessionId);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, JSON.stringify({ sessionId: workSession.claudeSessionId, type: 'user' }) + '\n');
  closeClients();
  await stopDaemon();
  sandbox.killSession(`ds-${workSession.id}`);
  await startDaemon();

  const r = await track(new Client()).connect({ cwd: projWork, id: workSession.id });
  assert.strictEqual(r.id, workSession.id);
  assert.strictEqual(await tokenSeenFor(workSession.claudeSessionId, { resume: true }), TOKEN_PERSONAL);
  assert.strictEqual(await planSeenFor(workSession.claudeSessionId, { resume: true }), 'max');
});

test('removing a login moves its projects to System and deletes its token', { skip: SKIP }, async () => {
  const d = await api('DELETE', `/api/claude-logins/${personalId}`);
  assert.strictEqual(d.status, 200, d.text);
  assert.deepStrictEqual(d.json.movedToSystem, ['Work repo']);
  assert.deepStrictEqual(d.json.logins.map(l => l.name), ['Work']);
  assert.ok(!fs.existsSync(path.join(HOME, '.deepsteve', 'claude-logins', `${personalId}.token`)));
  const c = (await api('GET', '/api/contexts')).json.contexts.find(x => x.id === 'workproj');
  assert.strictEqual(c.claudeLoginId, null);

  const n = await track(new Client()).connect({ cwd: projWork, new: '1', agentType: 'claude' });
  assert.strictEqual(await tokenSeenFor(n.claudeSessionId), '<none>');
});
