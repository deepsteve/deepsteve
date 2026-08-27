/**
 * Opening a GitHub issue against a repo with no commits killed the tab (#656).
 *
 * The report was "two kills in a row from opening a github issue". The daemon logs
 * showed a clean spawn followed, one to three seconds later, by:
 *
 *     [shell-gone] a9b6be37 reason=exited engine=tmux agent=claude up=3s
 *
 * The repo was a brand-new project with no commits yet. Claude Code resolves a base
 * branch before it creates a worktree, so `--worktree github-issue-1` against an
 * unborn HEAD prints "Failed to resolve base branch" and exits immediately — before
 * it has painted anything. The daemon dutifully tombstoned the session and told the
 * browser to close the tab, so the user saw a tab appear and vanish with no
 * explanation anywhere.
 *
 * The stub below replicates that preflight rather than merely logging argv, so this
 * suite asserts the OUTCOME the user cares about (the tab is still there) and not
 * just the flag we chose. Its two probes mirror real Claude exactly, verified by hand
 * against claude 2.1.247:
 *
 *     $ claude --worktree wt --print hi     # in a repo with no commits
 *     Error creating worktree: Failed to resolve base branch "HEAD": git rev-parse failed
 *     $ claude --worktree wt --print hi     # in a plain directory
 *     Error: Can only use --worktree in a git repository, but /tmp/x is not a git repository.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/worktree-unborn-repo.test.js
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

// Faithful to the real binary's ordering: the worktree preflight runs BEFORE the
// session starts and before it checks whether the worktree already exists, which is
// why a pre-existing .claude/worktrees/<name> does not rescue an unborn repo.
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
worktree=""
prev=""
for a in "$@"; do
  [ "$prev" = "--worktree" ] && worktree="$a"
  prev="$a"
done
if [ -n "$worktree" ]; then
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "Error: Can only use --worktree in a git repository, but $PWD is not a git repository."
    exit 1
  fi
  if ! git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    echo 'Error creating worktree: Failed to resolve base branch "HEAD": git rev-parse failed'
    exit 1
  fi
fi
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

let tmpRoot, HOME, PORT, BASE;
let unbornRepo;   // git init, no commit — the repo from the report
let normalRepo;   // git init + one commit — the control
let plainDir;     // not a repo at all
let daemon = null;
let daemonLog = '';
let sandbox = null;
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
  // A scratch HOME is a scratch tmux server since #625 (the daemon passes
  // -S $HOME/.deepsteve/tmux.sock on every invocation), so there is no TMUX_TMPDIR
  // to forget here. The sandbox anchors on the same HOME so after() can reap the
  // tmux server that outlives the daemon.
  sandbox = TmuxSandbox.forHome(HOME);
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');  // suppress browser auto-open
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

function initRepo(dir, { commit } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T',
      'commit', '-qm', 'first'], { cwd: dir, stdio: 'ignore' });
  }
  return dir;
}

// Minimal WS client that also records whether the server asked the tab to close —
// `close-tab` is exactly what the browser received in the report.
class Client {
  constructor() { this.ws = null; this.session = null; this.closeTab = false; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg?.type === 'close-tab') this.closeTab = true;
        if (msg?.type === 'session' && !this.session) {
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
let unbornSessionId = null;

function readState() {
  return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));
}

function stubArgv() {
  try { return fs.readFileSync(stubLogPath, 'utf8'); } catch { return ''; }
}

// The agent is alive iff the daemon still lists it. Polled rather than asserted
// immediately: the failure mode under test takes a second or two to show up, so an
// instant check would pass even against the unfixed server.
async function stillAlive(id) {
  await new Promise(r => setTimeout(r, 4000));
  const r = await fetch(`${BASE}/api/shells`, { headers: authHeaders() });
  const body = await r.json();
  const list = Array.isArray(body) ? body : (body.shells || []);
  return list.some(s => (s.id || s) === id);
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-wt-unborn-'));
  HOME = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  unbornRepo = initRepo(path.join(tmpRoot, 'unborn'));
  normalRepo = initRepo(path.join(tmpRoot, 'normal'), { commit: true });
  plainDir = path.join(tmpRoot, 'plain');
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');
  stubLogPath = path.join(HOME, 'claude-invocations.log');
  PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  await startDaemon();
});

after(async () => {
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon();
  sandbox?.cleanup();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('a worktree session on a repo with no commits survives instead of dying on arrival', async () => {
  const before = stubArgv().length;
  const c = track(new Client());
  const session = await c.connect({
    new: '1', cwd: unbornRepo, worktree: 'github-issue-1', agentType: 'claude', planMode: '1',
  });
  unbornSessionId = session.id;

  assert.ok(await stillAlive(session.id), 'the session must outlive the spawn preflight');
  assert.strictEqual(c.closeTab, false, 'the browser must not be told to close the tab');

  const argv = stubArgv().slice(before);
  assert.ok(!argv.includes('--worktree'),
    `--worktree must not reach an unborn repo, got: ${argv.trim()}`);
  assert.match(daemonLog, /\[worktree\] dropping "github-issue-1".*no commits yet/,
    'the daemon must say why the worktree was dropped');
});

test('the persisted record does not claim a worktree the session never got', async () => {
  // Read state.json, NOT /api/shells: that endpoint's projection omits `worktree`
  // entirely, so asserting on it here would pass no matter what the server did.
  assert.ok(unbornSessionId, 'the previous test must have opened a session');
  const entry = readState()[unbornSessionId];
  assert.ok(entry, 'the session is persisted');
  assert.strictEqual(entry.cwd, unbornRepo, 'it runs in the checkout itself');
  // Recording the REQUESTED worktree would make the entry lie, and everything that
  // derives from it — sessionPaths, claudeProjectDir, and the transcript directory
  // a later --resume reads — would point at a directory that was never created.
  assert.ok(!entry.worktree, `entry must not claim a worktree it does not have: ${entry.worktree}`);
});

test('a repo with commits still gets its worktree', async () => {
  // The guard has to be narrow: if it dropped worktrees generally, issue isolation
  // would be silently gone everywhere and nothing would fail loudly.
  const before = stubArgv().length;
  const c = track(new Client());
  const session = await c.connect({
    new: '1', cwd: normalRepo, worktree: 'github-issue-2', agentType: 'claude', planMode: '1',
  });
  assert.ok(await stillAlive(session.id));
  const argv = stubArgv().slice(before);
  assert.match(argv, /--worktree github-issue-2/, 'a normal repo keeps its isolation');
});

test('a directory that is not a repo at all is handled the same way', async () => {
  const before = stubArgv().length;
  const c = track(new Client());
  const session = await c.connect({
    new: '1', cwd: plainDir, worktree: 'github-issue-3', agentType: 'claude', planMode: '1',
  });
  assert.ok(await stillAlive(session.id), 'a non-repo session must survive too');
  const argv = stubArgv().slice(before);
  assert.ok(!argv.includes('--worktree'),
    `--worktree must not reach a non-repo, got: ${argv.trim()}`);
  assert.match(daemonLog, /\[worktree\] dropping "github-issue-3".*not a git repository/);
});
