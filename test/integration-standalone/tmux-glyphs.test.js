/**
 * Standalone tmux rendering tests (#624) — the issue's acceptance test.
 *
 * A tmux-backed session has to be a pixel-faithful replica of a node-pty one. Two
 * independent defects said otherwise, both in the attach client:
 *
 *   1. Every non-ASCII glyph became an underscore. tmux sets its client's UTF-8
 *      flag from `-u` or from the first of LC_ALL/LC_CTYPE/LANG containing "UTF-8";
 *      with neither, tty_check_codeset() takes its documented fallback and replaces
 *      each glyph with the right number of underscores. The Claude Code banner
 *      rendered as `_______`, the spinner as `_`, `⏵⏵ auto mode on` as `__ auto mode on`.
 *   2. Truecolor was quantized. The client never negotiated `RGB`, so tmux mapped
 *      every 24-bit SGR down to the 256-colour palette before it reached xterm.js.
 *
 * THE ENVIRONMENT IS THE TEST. Both defects only exist when there is no locale at
 * all — which is what a launchd/systemd daemon has (neither service definition
 * declares one) and what an interactive shell never has. Hand-testing from a
 * terminal therefore renders fine, which is exactly why this survived to becoming
 * the default engine in #620. So this suite strips LC_ALL/LC_CTYPE/LANG from the
 * daemon's env rather than inheriting the runner's; without that it would pass
 * against the bug.
 *
 * Skips itself when tmux is not installed.
 *
 * Run: TMPDIR=/tmp/ds-test node --test --test-timeout=180000 \
 *        test/integration-standalone/tmux-glyphs.test.js
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

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The reported symptom, verbatim from the issue: the Claude Code logo, the spinner
// glyph, an ellipsis and the auto-mode chevrons. `·` is in there deliberately — it
// survived the bug (tmux maps it to an ACS character), so it is the control that
// proves the assertion is about the codeset path and not about UTF-8 generally.
const GLYPHS = '▐▛███▜▌ · ✻ … ⏵⏵ ✔';

// The daemon's own resolver, not a hand-rolled `which` pair (#625) — so this suite
// skips exactly when the daemon would fall back, and finds the same binary it will.
const SKIP = TmuxSandbox.skipReason();

let tmpRoot, HOME, PORT, BASE, projDir;
let daemon = null;
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run tmux against THIS suite's own socket, by explicit `-S` path.
 *
 * Not by TMUX_TMPDIR: tmux treats that as a hint and silently falls back to the
 * developer's real per-UID socket whenever it cannot use the directory — and inside a
 * pane it ignores the variable outright and uses `$TMUX`. Either way an earlier
 * version of this file destroyed every live agent on the box, three times in one
 * morning. See test/helpers/tmux-sandbox.js for the full account.
 */
function tmux(args) {
  return sandbox.run(args);
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // The whole point of this suite: reproduce a service-managed daemon's environment,
  // which has no locale at all. Inheriting the runner's would hide both defects.
  for (const k of ['LC_ALL', 'LC_CTYPE', 'LANG', 'COLORTERM']) delete env[k];
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  // Nothing to set for the DAEMON's socket any more (#625): it derives its own from
  // $HOME/.deepsteve/tmux.sock and passes it as `-S`. `sandbox` is anchored on the
  // same HOME, so this suite and the daemon are on ONE server by construction — which
  // matters here more than most, since every assertion below reads a pane the daemon
  // created and would pass vacuously against an empty server.
  if (!sandbox) throw new Error('startDaemon called before the sandbox exists');

  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // no browser auto-open

  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', () => {});
  daemon.stderr.on('data', () => {});

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
  constructor() { this.ws = null; this.session = null; this.output = ''; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 15000);
      this.ws.on('message', (data) => {
        const raw = data.toString();
        let msg;
        try { msg = JSON.parse(raw); } catch { this.output += raw; return; }
        if (typeof msg !== 'object' || msg === null) { this.output += raw; return; }
        if (msg.type === 'session' && !this.session) {
          this.session = msg;
          clearTimeout(timer);
          resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  send(str) { this.ws.send(str); }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

let clients = [];
function track(c) { clients.push(c); return c; }

/** Open a plain terminal session and let its shell settle at a prompt. */
async function openTerminal() {
  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'terminal' });
  assert.strictEqual(s.engineType, 'tmux', 'this suite is meaningless on the node-pty fallback');
  await sleep(1500);
  return { c, id: s.id };
}

before(async () => {
  if (SKIP) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-glyph-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  // Anchored on HOME, and it names and creates its socket dir in ONE call. Naming on
  // one line and creating on a later one is the exact two-line window that let this
  // file's after() reach the developer's real tmux server: anything throwing in
  // between left the path set and the directory absent, tmux's silent-fallback
  // condition. Since #625 the daemon derives the same socket from this HOME, so there
  // is no second path to keep in step either.
  sandbox = TmuxSandbox.forHome(HOME);
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  // No SKIP guard needed for correctness any more — `sandbox?.cleanup()` is a no-op
  // without one — but mirror before()'s early return anyway so a skipped suite does
  // no work at all.
  if (SKIP) return;
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon('SIGKILL').catch(() => {});
  // Shutdown DETACHES tmux sessions rather than killing them (#620), so this suite's
  // scratch tmux server outlives its daemon and something has to reap it. cleanup()
  // kills each session on OUR socket by name; with no server there it does nothing.
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  await sleep(500);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the daemon really has no locale — otherwise this whole suite is vacuous',
  { skip: SKIP }, async () => {
    // Both defects are invisible in a locale-carrying environment. If the daemon
    // under test inherited one, every assertion below would pass with the bug intact.
    assert.ok(!/utf-?8/i.test(daemon.spawnargs.join(' ')), 'sanity: no locale smuggled in via argv');
    const r = await (await fetch(`${BASE}/api/engines`, { headers: authHeaders() })).json();
    assert.strictEqual(r.tmuxAvailable, true, 'tmux should be detected');
    assert.strictEqual(r.current, 'tmux', 'a fresh install should default to tmux');
    // spawnSession degrades to node-pty rather than throwing, so without this
    // tripwire a too-long socket path would leave the suite green against the
    // engine it is not testing. Re-run with a short TMPDIR if this fires.
    assert.strictEqual(r.tmuxRuntimeFailure, null,
      'tmux cannot create sessions here, so this suite would silently test node-pty');
  });

test('#624: non-ASCII glyphs survive the tmux engine', { skip: SKIP }, async () => {
  const { c } = await openTerminal();
  c.send(`printf 'GLYPHTEST ${GLYPHS} END\\n'\n`);
  await waitFor(() => c.output.includes('END'), 'the printf to complete');

  assert.ok(c.output.includes('▐▛███▜▌'),
    `the Claude Code logo did not survive tmux.\nGot: ${JSON.stringify(c.output.slice(-400))}`);
  for (const glyph of ['✻', '…', '⏵⏵', '✔']) {
    assert.ok(c.output.includes(glyph), `${glyph} did not survive tmux`);
  }
  // The symptom itself, stated as a symptom: tmux substitutes one underscore per
  // cell, so the 7-cell logo came through as exactly `_______`.
  assert.ok(!/_{5,}/.test(c.output),
    `a run of underscores in the output means tmux is still substituting for glyphs.\n` +
    `Got: ${JSON.stringify(c.output.slice(-400))}`);
});

test('#624: 24-bit colour reaches the browser unquantized', { skip: SKIP }, async () => {
  const { c, id } = await openTerminal();

  // tmux only advertises RGB if we asked for it — nothing probes for this, and no
  // terminal-features option is set anywhere (that would be server-global, and we
  // share the user's per-UID socket).
  const features = tmux(['list-clients', '-t', `ds-${id}`, '-F', '#{client_termfeatures}']);
  assert.match(features, /\bRGB\b/, `attach client did not negotiate RGB, got: ${features}`);

  c.send(`printf 'COLORPROBE\\033[38;2;12;34;56mX\\033[0m END\\n'\n`);
  await waitFor(() => c.output.includes('END'), 'the colour printf to complete');

  // Match the ESC byte, not the text: the shell echoes the typed command, whose
  // literal `\033[38;2;12;34;56m` characters would satisfy a substring test even
  // when tmux quantized the real SGR. Only a genuine escape sequence proves it.
  assert.match(c.output, /\x1b\[[0-9;]*38;2;12;34;56/,
    'the 24-bit SGR was rewritten — tmux is still downsampling to the 256-colour palette');
});

test('#624: the pane itself gets a UTF-8 locale, so the agent picks its glyph set',
  { skip: SKIP }, async () => {
    // The attach client's env fixes what tmux DRAWS. This is the other half: Ink and
    // most TUI toolkits gate their Unicode glyph set on LC_CTYPE, and the pane
    // inherits the tmux server's environment, not ours — so it has to be stated per
    // session with `new-session -e`.
    const { id } = await openTerminal();
    const shown = tmux(['show-environment', '-t', `ds-${id}`, 'LC_CTYPE']);
    assert.match(shown, /^LC_CTYPE=.*utf-?8/i, `pane locale is wrong: ${shown}`);
    const color = tmux(['show-environment', '-t', `ds-${id}`, 'COLORTERM']);
    assert.strictEqual(color, 'COLORTERM=truecolor');
  });
