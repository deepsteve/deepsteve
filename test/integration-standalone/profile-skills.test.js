/**
 * Standalone profile-skills provisioning tests (#543).
 *
 * Custom Claude Code config profiles (#537, `customAgentConfigs`) run sessions with an
 * alternate CLAUDE_CONFIG_DIR, and Claude Code reads user slash commands from
 * <configDir>/commands/ — NOT ~/.claude/commands/. So the server links each profile's
 * config dir at <configDir>/commands/deepsteve -> SKILL_DEST_DIR (~/.claude/commands/deepsteve)
 * so deepsteve skills are visible in profile sessions with no manual setup.
 *
 * Like tombstone.test.js, this suite spawns its OWN throwaway daemon (scratch $HOME,
 * stub `claude` on PATH, random port) so it can restart the server and inspect the
 * filesystem directly.
 *
 * What it proves:
 *   - Adding a profile in Settings links its config dir (the schema sideEffect), even
 *     with no skills enabled yet.
 *   - An enabled skill is visible THROUGH the link (single write target — no per-profile copy).
 *   - A real (non-symlink) commands/deepsteve dir is never clobbered.
 *   - A stale link is repointed; an already-correct link is left untouched (idempotent).
 *   - Spawning a session pinned to a profile self-heals a missing link (sessionEnv hook).
 *   - Startup re-provisions a missing link on restart.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/profile-skills.test.js
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

// Stub `claude`: acts like a live REPL (blocks on stdin, exits on /exit) so a
// profile-pinned session stays alive long enough to inspect the provisioned link.
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

let tmpRoot;      // scratch root (removed in after())
let HOME;         // scratch $HOME the daemon and its PTYs see
let PORT;         // random free port
let BASE;         // http://127.0.0.1:PORT
let projDir;      // the "project" the sessions live in
let skillDest;    // $HOME/.claude/commands/deepsteve (SKILL_DEST_DIR)
let daemon = null;
let daemonLog = '';        // accumulated stdout+stderr across ALL daemon runs

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
  // Don't leak the invoking environment into the daemon (see tombstone.test.js).
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];

  // Suppress the cold-start browser auto-open across restarts.
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  // Isolate tmux's socket: its default socket is per-UID, NOT per-HOME (see CLAUDE.md),
  // so a scratch-HOME daemon otherwise shares the real user's tmux socket and destroys
  // real ds-* sessions as "orphans" on startup. Override any inherited TMUX_TMPDIR.
  const tmuxTmp = path.join(HOME, 'tmux-tmp');
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  env.TMUX_TMPDIR = tmuxTmp;

  // --test-mode disables the browser auto-open and the auto-update check. The env-var
  // form can't be used (startDaemon strips every DEEPSTEVE_* var above), so use the flag.
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

async function apiGet(p) {
  const r = await fetch(`${BASE}${p}`, { headers: authHeaders() });
  return r.json();
}

async function apiPostJson(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Set the full list of custom config profiles (POST replaces the whole array).
function setProfiles(profiles) {
  return apiPostJson('/api/settings', { customAgentConfigs: profiles });
}

// Resolve a profile's `config:<id>` agent id by its (absolute) configDir.
async function profileAgentIdForDir(dir) {
  const { agents } = await apiGet('/api/agents');
  const a = (agents || []).find(x => String(x.id).startsWith('config:') && x.configDir === dir);
  return a ? a.id : null;
}

function linkFor(configDir) {
  return path.join(configDir, 'commands', 'deepsteve');
}

// Read the link's target, or null if it isn't a symlink / doesn't exist.
function linkTarget(configDir) {
  const dest = linkFor(configDir);
  try {
    return fs.lstatSync(dest).isSymbolicLink() ? fs.readlinkSync(dest) : null;
  } catch {
    return null;
  }
}

function countLinkedLogs() {
  return (daemonLog.match(/Profile skills: linked /g) || []).length;
}

// Minimal WS client: connect with query params + bearer header, resolve on the
// first `session` message.
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
        if (typeof msg !== 'object' || msg === null) return;
        if ((msg.type === 'session' || msg.type === 'gone') && !this.session) {
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

let profA;  // an initialized profile dir (gets the link)
let profB;  // a profile dir with a pre-existing REAL commands/deepsteve (never clobbered)

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-profile-skills-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  profA = path.join(tmpRoot, 'profileA');
  profB = path.join(tmpRoot, 'profileB');
  skillDest = path.join(HOME, '.claude', 'commands', 'deepsteve');

  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(profA, { recursive: true });   // profile dir must exist to be provisioned
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
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  await stopDaemon().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('adding a profile links <configDir>/commands/deepsteve to SKILL_DEST_DIR (no skills enabled yet)', async () => {
  // No skills are enabled at this point, so this only passes if provisioning is NOT
  // gated on enabledSkills (the link must exist before the first skill is ever enabled).
  await setProfiles([{ name: 'A', configDir: profA }]);

  assert.strictEqual(linkTarget(profA), skillDest, 'profile dir linked to SKILL_DEST_DIR');
});

test('an enabled skill is visible through the profile link (single write target)', async () => {
  const res = await apiPostJson('/api/skills/enable', { id: 'chat' });
  assert.strictEqual(res.ok, true, 'skill enabled');

  assert.ok(
    fs.existsSync(path.join(linkFor(profA), 'chat.md')),
    'chat.md written to SKILL_DEST_DIR is readable through the profile link'
  );
});

test('a real (non-symlink) commands/deepsteve dir is never clobbered', async () => {
  fs.mkdirSync(path.join(profB, 'commands', 'deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(profB, 'commands', 'deepsteve', 'USER_FILE.md'), 'mine\n');

  await setProfiles([{ name: 'A', configDir: profA }, { name: 'B', configDir: profB }]);

  assert.strictEqual(linkTarget(profB), null, 'real dir not replaced by a symlink');
  assert.ok(
    fs.existsSync(path.join(profB, 'commands', 'deepsteve', 'USER_FILE.md')),
    'user file left intact'
  );
  assert.ok(daemonLog.includes('exists and is not ours'), 'logged that it left the real dir alone');
});

test('a stale profile link is repointed; an already-correct link is left untouched', async () => {
  // Corrupt profA's link, then re-provision.
  fs.unlinkSync(linkFor(profA));
  fs.symlinkSync('/tmp/some-wrong-target', linkFor(profA));
  assert.strictEqual(linkTarget(profA), '/tmp/some-wrong-target', 'precondition: stale link');

  await setProfiles([{ name: 'A', configDir: profA }, { name: 'B', configDir: profB }]);
  assert.strictEqual(linkTarget(profA), skillDest, 'stale link repointed to SKILL_DEST_DIR');

  // Idempotency: a redundant provision of the now-correct link must NOT re-link
  // (the "already correct → return" branch), so no new "linked" log line appears.
  const before = countLinkedLogs();
  await setProfiles([{ name: 'A', configDir: profA }, { name: 'B', configDir: profB }]);
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(countLinkedLogs(), before, 'already-correct link is not re-linked');
  assert.strictEqual(linkTarget(profA), skillDest, 'link still correct');
});

test('spawning a session pinned to a profile self-heals a missing link', async () => {
  fs.unlinkSync(linkFor(profA));
  assert.strictEqual(linkTarget(profA), null, 'precondition: link removed');

  const agentId = await profileAgentIdForDir(profA);
  assert.ok(agentId, 'resolved config:<id> agent for profA');

  const c = new Client();
  try {
    const s = await c.connect({ cwd: projDir, new: '1', agentType: agentId, name: 'prof-a' });
    assert.strictEqual(s.type, 'session', 'session created');
    assert.strictEqual(s.agentType, 'claude', 'profile session runs as claude');
    assert.strictEqual(linkTarget(profA), skillDest, 'sessionEnv re-linked the profile dir at spawn');
  } finally {
    c.close();
  }
});

test('startup re-provisions a missing link on restart', async () => {
  fs.unlinkSync(linkFor(profA));
  assert.strictEqual(linkTarget(profA), null, 'precondition: link removed');

  await stopDaemon();
  await startDaemon();

  assert.strictEqual(linkTarget(profA), skillDest, 'startup provisioning re-linked the profile dir');
});
