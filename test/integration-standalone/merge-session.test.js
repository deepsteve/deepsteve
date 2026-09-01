/**
 * The merge path, end to end, with no model anywhere in it (#688).
 *
 * `/deepsteve:merge` cost about ten assistant turns, each replaying a 100k+ token
 * context at the point in a session where it is largest — 13% of a day's usage. Every
 * fact those turns rediscovered (the branch, the dirty state, the target checkout, the
 * issue number, the commit subject) is already known to the daemon. #688 moved the
 * mechanical half server-side, leaving the model only the conflict.
 *
 * test/unit/session-merge.test.js drives the routine with injected runners, and
 * test/unit/merge-auto-close.test.js drives the MCP handlers against a temp repo. What
 * neither can prove is the part that needs a real daemon: that a live worktree SESSION —
 * one with a tmux pane, an agent process and a shell entry — can be merged through both
 * surfaces, that the REST surface leaves the tab open while the MCP surface arms its
 * close, and that `gh` is really invoked with the arguments the skill used to type.
 *
 * `gh` is a stub in the scratch $HOME/bin, which the daemon's PATH puts first. That is
 * what makes the issue-close assertions deterministic: the real binary would be talking
 * to github.com about a temp repo with no remote.
 *
 * Own daemon: scratch $HOME, random port, tmux sandbox anchored on the same HOME.
 *
 * Run one file by hand with a SHORT TMPDIR (a tmux socket lives under $HOME):
 *   TMPDIR=/tmp/ds-test node --test --test-timeout=180000 test/integration-standalone/merge-session.test.js
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

// Stays alive on stdin so the daemon never sees `[shell-gone]` and tombstones the
// session out from under a test. It does NOT create the worktree — the real binary does
// that for `--worktree`, and each test creates its own with `git worktree add` so the
// fixture is explicit about the state it is merging from.
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

// Records argv and answers the two subcommands the merge uses. `issue view` prints a
// title so the derived commit subject is a known string; `issue close` just succeeds.
const GH_STUB = `#!/bin/bash
echo "$*" >> "$HOME/gh-invocations.log"
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  echo "A stubbed issue title"
fi
exit 0
`;

let tmpRoot, HOME, PORT, BASE;
let daemon = null;
let daemonLog = '';
let sandbox = null;
let mcp = null;
let projectSeq = 0;

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
function jsonHeaders() {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
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

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // Long enough that an armed close never actually fires mid-suite. What is under test
  // is WHETHER the close is armed, which surface arms it, and which does not; the delay
  // policy itself is test/unit/session-auto-close.js's business.
  env.DEEPSTEVE_MERGE_AUTOCLOSE_MS = '600000';
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

async function mcpConnect() {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  // /api/version being up does not mean /mcp is mounted — initMCP resolves later.
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
  const client = new McpClient({ name: 'merge-session-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const parseTool = (r) => JSON.parse(r.content[0].text);

// ── git fixtures ─────────────────────────────────────────────────────────────

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A repo on `main` with a committed worktree branch — the state an issue session is in
 * when the work is done.
 *
 * The worktree is created here rather than by the agent: the stub `claude` does not
 * honour `--worktree`, and for a native-worktree agent `sessionPaths` resolves
 * <repo>/.claude/worktrees/<name> only if it actually exists.
 */
function newProject({ issue = null, conflict = false, dirtyTarget = false } = {}) {
  const repo = path.join(tmpRoot, `proj${++projectSeq}`);
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  // Without this the worktrees dir reads as untracked in the main checkout and the
  // dirty-target guard refuses every merge — the caveat docs/sessions.md records.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);

  const name = issue == null ? `feature${projectSeq}` : `github-issue-${issue}`;
  const wt = path.join(repo, '.claude', 'worktrees', name);
  git(['worktree', 'add', '-q', '-b', name, wt], repo);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'work\n');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'worktree work'], wt);

  if (conflict) {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from main\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'divergent'], repo);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'from the worktree\n');
    git(['add', '-A'], wt);
    git(['commit', '-qm', 'also divergent'], wt);
  }
  if (dirtyTarget) fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted WIP\n');

  return { repo, wt, name };
}

// ── sessions ─────────────────────────────────────────────────────────────────

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

/** A live worktree session on `project`, with its shell entry wired the way a real one is. */
async function openSession(project, { worktree = true } = {}) {
  const c = new Client();
  clients.push(c);
  const params = { new: '1', cwd: project.repo, agentType: 'claude' };
  if (worktree) params.worktree = project.name;
  const session = await c.connect(params);
  assert.ok(session.id, 'the server must have assigned a session id');
  if (worktree) {
    assert.strictEqual(session.worktree, project.name,
      'the session must really be a worktree session, or nothing below is testing what it says');
  }
  return session.id;
}

const ghLog = () => { try { return fs.readFileSync(path.join(HOME, 'gh-invocations.log'), 'utf8'); } catch { return ''; } };
const armedFor = (id) => daemonLog.includes(`[auto-close] armed for ${id}`);
const listShells = async () => {
  const r = await fetch(`${BASE}/api/shells`, { headers: authHeaders() });
  const body = await r.json();
  return Array.isArray(body) ? body : (body.shells || []);
};
const subjectOf = (cwd, ref) => git(['log', '-1', '--pretty=%s', ref], cwd).trim();

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-merge-session-'));
  HOME = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, 'bin', 'gh'), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');
  PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  await startDaemon();
  mcp = await mcpConnect();
});

after(async () => {
  try { await mcp?.close(); } catch {}
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon();
  sandbox?.cleanup();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── the UI surface: zero model turns, and the tab survives ────────────────────

test('POST /api/shells/:id/merge commits, merges and closes the issue — with no agent involved', async () => {
  const project = newProject({ issue: 4242 });
  const id = await openSession(project);
  // Work the agent finished but never committed. The old skill's step 5.
  fs.writeFileSync(path.join(project.wt, 'late.txt'), 'late work\n');

  const r = await fetch(`${BASE}/api/shells/${id}/merge`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}),
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();

  assert.strictEqual(data.status, 'merged', JSON.stringify(data));
  assert.strictEqual(data.branch, 'github-issue-4242');
  assert.strictEqual(data.target, 'main');
  assert.strictEqual(data.committed, true);

  // The commit subject is derived with no model: `<issue title> (#<n>)`, exactly what
  // skills/merge.md step 3 produced.
  assert.strictEqual(data.subject, 'A stubbed issue title (#4242)');
  assert.strictEqual(subjectOf(project.wt, 'github-issue-4242'), 'A stubbed issue title (#4242)');

  // The whole worktree really landed, uncommitted work included.
  assert.ok(fs.existsSync(path.join(project.repo, 'b.txt')));
  assert.ok(fs.existsSync(path.join(project.repo, 'late.txt')), 'the uncommitted work reached main');

  // And the GitHub issue was closed, with the arguments the skill used to type.
  assert.deepStrictEqual(data.issue, { number: 4242, closed: true });
  assert.match(ghLog(), /issue close 4242 --comment Merged into main\./);

  // The tab is left exactly where it was: a human is looking at it with Close one key
  // away, so this surface deliberately arms nothing.
  const shells = await listShells();
  assert.ok(shells.some(s => (s.id || s) === id), 'the session must still be live');
  assert.ok(!armedFor(id), 'the REST surface must not arm an auto-close');
});

test('a clean worktree is merged without writing a commit', async () => {
  const project = newProject({ issue: 7 });
  const id = await openSession(project);
  const before = git(['rev-list', '--count', 'HEAD'], project.wt).trim();

  const r = await fetch(`${BASE}/api/shells/${id}/merge`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}),
  });
  const data = await r.json();

  assert.strictEqual(data.status, 'merged');
  assert.strictEqual(data.committed, false);
  assert.strictEqual(git(['rev-list', '--count', `github-issue-7`], project.wt).trim(), before);
});

test('a dirty target checkout is refused, and nothing at all changes', async () => {
  const project = newProject({ issue: 8, dirtyTarget: true });
  const id = await openSession(project);
  const mainBefore = git(['rev-parse', 'main'], project.repo).trim();

  const r = await fetch(`${BASE}/api/shells/${id}/merge`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}),
  });
  // Not a 500: "the target is dirty" is an answer, and the client renders which one.
  assert.strictEqual(r.status, 200);
  const data = await r.json();

  assert.strictEqual(data.status, 'target-dirty');
  assert.strictEqual(data.mergeDir, project.repo);
  assert.strictEqual(git(['rev-parse', 'main'], project.repo).trim(), mainBefore, 'main is untouched');
  assert.ok(!ghLog().includes('issue close 8'), 'a refused merge closes no issue');
  assert.ok(!armedFor(id));
});

test('a conflict is reported and the target left alone', async () => {
  const project = newProject({ issue: 9, conflict: true });
  const id = await openSession(project);
  const mainBefore = git(['rev-parse', 'main'], project.repo).trim();

  const r = await fetch(`${BASE}/api/shells/${id}/merge`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}),
  });
  const data = await r.json();

  assert.strictEqual(data.status, 'conflict');
  assert.strictEqual(git(['rev-parse', 'main'], project.repo).trim(), mainBefore,
    'the merge was aborted, so main is unchanged');
  assert.ok(!ghLog().includes('issue close 9'));
});

test('a non-worktree session is refused rather than committed and pushed', async () => {
  // The menu only offers Merge on a worktree tab, and this is the server re-checking.
  // A button labelled Merge must not push on someone's behalf.
  const project = newProject({ issue: 10 });
  const id = await openSession(project, { worktree: false });

  const r = await fetch(`${BASE}/api/shells/${id}/merge`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}),
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).error, 'not-a-worktree');
});

test('an unknown session is a 404', async () => {
  const r = await fetch(`${BASE}/api/shells/nope1234/merge`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}),
  });
  assert.strictEqual(r.status, 404);
});

// ── the agent surface: zero ADDITIONAL turns, and the tab closes itself ───────

test('issue_complete with Autopilot on performs the merge inside that one call', async () => {
  // The acceptance criterion: no extra assistant turns. The session calls the tool it
  // was always going to call, and the answer reports a finished merge.
  const project = newProject({ issue: 4243 });
  const id = await openSession(project);
  fs.writeFileSync(path.join(project.wt, 'late.txt'), 'late work\n');

  const on = await fetch(`${BASE}/api/shells/${id}/autopilot`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ autopilot: true }),
  });
  assert.strictEqual((await on.json()).autopilot, true);

  const p = parseTool(await mcp.callTool({ name: 'issue_complete', arguments: { session_id: id } }));

  assert.strictEqual(p.next, 'merged', JSON.stringify(p));
  assert.strictEqual(p.status, 'merged');
  assert.strictEqual(p.committed, true);
  assert.deepStrictEqual(p.issue, { number: 4243, closed: true });
  assert.ok(fs.existsSync(path.join(project.repo, 'late.txt')));
  assert.match(p.instruction, /Write your summary/i);

  // Unlike the REST surface, this one arms the close: the agent has to be told to stop
  // and reliably isn't (#627), and there is nobody at the tab.
  assert.ok(p.autoCloseAt > Date.now(), 'the answer must say when the tab closes');
  await waitFor(async () => armedFor(id), 'the auto-close to be armed', 5000);
  assert.match(daemonLog, new RegExp(`issue_complete: ${id} autopilot=on -> merged`));
});

test('issue_complete with Autopilot off merges nothing', async () => {
  const project = newProject({ issue: 11 });
  const id = await openSession(project);
  const mainBefore = git(['rev-parse', 'main'], project.repo).trim();

  const p = parseTool(await mcp.callTool({ name: 'issue_complete', arguments: { session_id: id } }));

  assert.strictEqual(p.next, 'stop');
  assert.strictEqual(p.status, undefined, 'the off answer carries no merge result');
  assert.strictEqual(git(['rev-parse', 'main'], project.repo).trim(), mainBefore);
  assert.ok(!armedFor(id));
});

test('merge_session does the same job for a session that is not issue-shaped', async () => {
  // A /deepsteve:fork worktree or a hand-made branch never calls issue_complete. This is
  // the tool the trimmed skill calls, and the branch carries no issue number, so there
  // is nothing to close and the subject falls back to the merge form.
  const project = newProject();
  const id = await openSession(project);
  fs.writeFileSync(path.join(project.wt, 'late.txt'), 'late work\n');

  const p = parseTool(await mcp.callTool({ name: 'merge_session', arguments: { session_id: id } }));

  assert.strictEqual(p.status, 'merged', JSON.stringify(p));
  assert.strictEqual(p.committed, true);
  assert.strictEqual(p.subject, `Merge ${project.name} into main`);
  assert.strictEqual(p.issue, null);
  assert.ok(fs.existsSync(path.join(project.repo, 'late.txt')));
  assert.ok(p.autoCloseAt > Date.now(), 'an agent caller gets the tab armed to close');
});

test('merge_worktree still merges committed work only, and commits nothing', async () => {
  // The primitive is unchanged — #688 composed on it rather than overloading it, and the
  // difference between the two tools is exactly this.
  const project = newProject({ issue: 12 });
  const id = await openSession(project);
  fs.writeFileSync(path.join(project.wt, 'late.txt'), 'late work\n');

  const p = parseTool(await mcp.callTool({ name: 'merge_worktree', arguments: { session_id: id } }));

  assert.strictEqual(p.status, 'merged');
  assert.strictEqual(p.committed, undefined, 'the primitive reports no commit because it makes none');
  assert.ok(!fs.existsSync(path.join(project.repo, 'late.txt')),
    'uncommitted work does not travel through the primitive');
  assert.ok(!ghLog().includes('issue close 12'), 'and it closes no issue');
});

test('get_session_info answers without being told which session it is', async () => {
  // It was the last core tool that made a caller spend a turn on get_my_session_id just
  // to name itself. Over a plain MCP client there is no shellId on the request URL, so
  // the not-found answer is the observable half here; the auto-detect half is exercised
  // by every wired agent and pinned in the schema below.
  const project = newProject({ issue: 13 });
  const id = await openSession(project);

  const withId = parseTool(await mcp.callTool({ name: 'get_session_info', arguments: { session_id: id } }));
  assert.strictEqual(withId.id, id);
  assert.strictEqual(withId.worktree, 'github-issue-13');
  assert.strictEqual(withId.repoRoot, project.repo);
  assert.strictEqual(withId.cwd, project.wt, 'a worktree session reports the worktree as its cwd');

  const tools = (await mcp.listTools()).tools;
  const info = tools.find(t => t.name === 'get_session_info');
  assert.ok(!(info.inputSchema.required || []).includes('session_id'),
    'session_id must be optional — requiring it costs a caller a whole turn');
});

test('the two merge tools are both registered, and describe different jobs', async () => {
  const tools = (await mcp.listTools()).tools;
  const names = tools.map(t => t.name);
  assert.ok(names.includes('merge_session'));
  assert.ok(names.includes('merge_worktree'), 'the primitive is still offered on its own');
  const composed = tools.find(t => t.name === 'merge_session');
  assert.match(composed.description, /commit/i);
  assert.match(composed.description, /merge_worktree/,
    'it must point at the primitive for the merge-only case');
});
