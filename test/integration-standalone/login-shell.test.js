/**
 * The login shell reaches the agent — on BOTH engines (#630).
 *
 * `gh` was "command not found" inside every agent session under the default engine.
 * Not a `gh` problem and not a scheduled-tasks problem: `spawnSession` builds
 * `<shell> -l -c '<agent> …'` and node-pty execs exactly that, but the tmux engine
 * was handed only the inner command and tmux runs a single `shell-command` argument
 * through `default-shell -c` — a NON-login shell. So `~/.zprofile`, where
 * `brew shellenv` puts /opt/homebrew/bin, was never sourced. Plain terminal tabs were
 * fine (no command at all, so tmux forks its own login shell), which is a large part
 * of why this went unnoticed: "is gh on PATH?" tested in a terminal tab passes.
 *
 * THE DAEMON'S PATH IS THE TEST. Every other standalone suite prepends `$HOME/bin` to
 * the daemon's environment *and* seeds a login profile that does the same, so the
 * login shell is never load-bearing there and the bug is invisible from them. Here the
 * real stub lives in `$HOME/login-only/`, which the daemon's PATH deliberately does
 * NOT contain — only the login profile puts it there.
 *
 * A DECOY of the same name sits in `$HOME/bin` (which the daemon's PATH does carry),
 * so the pre-fix behaviour is a wrong-stub assertion rather than a 20s timeout, and
 * so a real `claude` on the developer's PATH can never be launched by this suite.
 *
 * Both engines are exercised: tmux (the repro) and node-pty via the `?engine=`
 * override (the control that always passed). The pair is the parity claim — #624
 * established it for the environment, #630 for the argv.
 *
 * Skips itself when tmux is missing, or when the resolved login shell has no login
 * flag (`sh` — bin-path.js deliberately gives it none, so there is nothing to test).
 * The profile is seeded by `test/helpers/login-profile.js`, which writes every file
 * the resolved shell might read; hardcoding `~/.zprofile` is what made this class of
 * fixture silently inert on Linux.
 *
 * Run: TMPDIR=/tmp/ds-test node --test --test-timeout=180000 \
 *        test/integration-standalone/login-shell.test.js
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
const { resolveLoginShell } = require('../../bin-path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The daemon's own resolver, so this suite skips exactly when the daemon has no login
// shell to run — and names the right one in its failure messages. (zsh on a Mac, bash
// on Debian; the daemon and this process share $SHELL.)
const LOGIN_SHELL = resolveLoginShell();

const SKIP = TmuxSandbox.skipReason()
  || (!LOGIN_SHELL.loginFlag && `${LOGIN_SHELL.path} takes no login flag — nothing to source`);

let tmpRoot, HOME, PORT, BASE, projDir, loginOnlyDir;
let daemon = null;
let daemonEnv = null;
let daemonLog = '';
// null until before() has validated one. `after()` uses `sandbox?.cleanup()`, so a
// before() that throws leaves a no-op rather than an unaimed tmux command (#625).
let sandbox = null;

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

async function waitFor(check, what, timeoutMs = 30000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let result;
    try { result = await check(); } catch { result = null; }
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * A stand-in agent that records which copy of itself ran, and under what PATH.
 *
 * `$0` is the resolved path the kernel handed the interpreter, so it names the
 * directory the shell searched first — which is the entire question #630 asks.
 * `/bin/sleep` by absolute path: a stub that has to find its own tail on PATH would
 * be testing the same thing twice, and confusingly.
 */
function stubAgent() {
  return '#!/bin/sh\n'
    + '{ printf \'STUB=%s\\n\' "$0"; printf \'PATH=%s\\n\' "$PATH"; } '
    + '> "$HOME/pane-$DEEPSTEVE_SESSION_ID.txt"\n'
    + 'exec /bin/sleep 300\n';
}

/**
 * What the pane recorded, as { stub, path }.
 *
 * Parsed INSIDE the poll, not after it: the file appears the moment the stub's
 * redirect creates it, so a read between its two printfs would see only the first
 * line. Requiring both is what makes "it exists" and "it is complete" one condition.
 */
async function paneReport(id) {
  const file = path.join(HOME, `pane-${id}.txt`);
  return waitFor(() => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const stub = /^STUB=(.*)$/m.exec(raw);
    const panePath = /^PATH=(.*)$/m.exec(raw);
    return stub && panePath ? { stub: stub[1], path: panePath[1] } : null;
  }, `the stub agent for ${id} to record its PATH`);
}

async function startDaemon(extra = {}) {
  const env = { ...process.env, HOME, PORT: String(PORT), ...extra };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // THE fixture. `$HOME/bin` carries the decoy (and the inert `open`); `login-only`
  // is reachable ONLY by sourcing the profile. Inheriting the runner's PATH is fine
  // and necessary — node and tmux live on it — as long as it cannot contain the
  // login-only dir, which is asserted below rather than assumed.
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  daemonEnv = env;

  if (!sandbox) throw new Error('startDaemon called before the sandbox exists');

  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // no browser auto-open

  daemonLog = '';
  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', (d) => { daemonLog += d.toString(); });
  daemon.stderr.on('data', (d) => { daemonLog += d.toString(); });

  await waitFor(async () => {
    if (!authToken()) return false;
    const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
    return r.ok;
  }, 'daemon to become ready');
}

function stopDaemon(signal = 'SIGKILL') {
  if (!daemon) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = daemon;
    daemon = null;
    const timer = setTimeout(() => reject(new Error(`daemon did not exit within 30s of ${signal}`)), 30000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill(signal);
  });
}

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

/** Open an agent session, optionally pinning the engine via the WS ?engine= override. */
async function openAgent({ engine } = {}) {
  const c = new Client();
  clients.push(c);
  const params = { cwd: projDir, new: '1', agentType: 'claude' };
  if (engine) params.engine = engine;
  const s = await c.connect(params);
  return { c, id: s.id, engineType: s.engineType };
}

before(async () => {
  if (SKIP) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-login-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  loginOnlyDir = path.join(HOME, 'login-only');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(loginOnlyDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  // Anchored on HOME, and it names and creates its socket dir in ONE call (#625).
  sandbox = TmuxSandbox.forHome(HOME);

  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The real stub — findable only after the profile has been sourced.
  fs.writeFileSync(path.join(loginOnlyDir, 'claude'), stubAgent(), { mode: 0o755 });
  // The decoy — findable from the daemon's raw PATH. It turns "the login shell was
  // skipped" into a named wrong answer instead of a timeout, and it guarantees a real
  // `claude` on the developer's PATH is never what a failing run launches.
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), stubAgent(), { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/login-only:$PATH"');

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  if (SKIP) return;
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon('SIGKILL').catch(() => {});
  // Shutdown DETACHES tmux sessions rather than killing them (#620), so this suite's
  // scratch tmux server outlives its daemon and something has to reap it. cleanup()
  // kills each session on OUR socket by name.
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  await sleep(500);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the daemon cannot see the real stub — otherwise this whole suite is vacuous',
  { skip: SKIP }, async () => {
    // If `login-only` were on the daemon's own PATH, both engines would find the stub
    // with or without a login shell and every assertion below would pass with the bug
    // intact. That is precisely the shape the other standalone suites have.
    assert.ok(!daemonEnv.PATH.split(path.delimiter).includes(loginOnlyDir),
      `the daemon's PATH must not contain ${loginOnlyDir}: ${daemonEnv.PATH}`);
    assert.ok(fs.existsSync(path.join(loginOnlyDir, 'claude')), 'the real stub must exist');
    assert.ok(fs.existsSync(path.join(HOME, 'bin', 'claude')), 'the decoy must exist');

    const r = await (await fetch(`${BASE}/api/engines`, { headers: authHeaders() })).json();
    assert.strictEqual(r.tmuxAvailable, true, 'tmux should be detected');
    assert.strictEqual(r.current, 'tmux', 'a fresh install should default to tmux');
    // spawnSession degrades to node-pty rather than throwing, so without this tripwire
    // a too-long socket path would leave the tmux case below silently testing node-pty.
    // Re-run with a short TMPDIR if this fires.
    assert.strictEqual(r.tmuxRuntimeFailure, null,
      'tmux cannot create sessions here, so the tmux case would silently test node-pty');
  });

test('#630: a tmux agent pane runs under a LOGIN shell', { skip: SKIP }, async () => {
  const { id, engineType } = await openAgent();
  assert.strictEqual(engineType, 'tmux', 'this case is meaningless on the node-pty fallback');

  const report = await paneReport(id);
  assert.strictEqual(report.stub, path.join(loginOnlyDir, 'claude'),
    `the pane ran the decoy, so ${LOGIN_SHELL.path} never sourced a login profile — tmux `
    + 'was handed a single shell-command argument and ran it through a NON-login shell (#630)');
  assert.ok(report.path.split(path.delimiter).includes(loginOnlyDir),
    `the pane's PATH is missing ${loginOnlyDir}: ${report.path}`);
});

test('#630: and node-pty already did — the two engines agree', { skip: SKIP }, async () => {
  // The control. This arm was correct before #630 and must stay correct after it:
  // the fix is that tmux now execs the same argv node-pty was always given.
  const { id, engineType } = await openAgent({ engine: 'node-pty' });
  assert.strictEqual(engineType, 'node-pty', 'the ?engine= override did not take');

  const report = await paneReport(id);
  assert.strictEqual(report.stub, path.join(loginOnlyDir, 'claude'));
  assert.ok(report.path.split(path.delimiter).includes(loginOnlyDir),
    `the pane's PATH is missing ${loginOnlyDir}: ${report.path}`);
});

// #621's property, end to end: nothing but the shell path may depend on which login
// shell was resolved. Restarting the daemon with SHELL=/bin/bash makes a Mac exercise
// the argv Linux gets — `['/bin/bash','-l','-c', inner]` through a real tmux — which
// is otherwise reachable only from CI, and CI's tmux coverage is all terminal tabs.
// It also sits on the boundary that made this fix worth double-checking: tmux must
// parse `-l` and `-c` as the pane's arguments and not as its own flags.
test('#630: the login shell reaching the pane does not depend on WHICH shell it is',
  { skip: SKIP || (!fs.existsSync('/bin/bash') && 'no /bin/bash on this box') }, async () => {
    await stopDaemon('SIGKILL');
    await startDaemon({ SHELL: '/bin/bash' });
    // Anti-vacuity: without this the case silently repeats the zsh one on a Mac.
    // The daemon prints what resolveLoginShell() picked, once, at boot.
    assert.match(daemonLog, /Shell: sessions run under \/bin\/bash -l/,
      `the daemon did not resolve bash, so this case is a duplicate of the one above:\n${daemonLog.slice(0, 600)}`);

    const { id, engineType } = await openAgent();
    assert.strictEqual(engineType, 'tmux');
    const report = await paneReport(id);
    assert.strictEqual(report.stub, path.join(loginOnlyDir, 'claude'),
      'a bash login shell did not source ~/.bash_profile — check the pane argv, not the profile');
    assert.ok(report.path.split(path.delimiter).includes(loginOnlyDir),
      `the pane's PATH is missing ${loginOnlyDir}: ${report.path}`);
  });
