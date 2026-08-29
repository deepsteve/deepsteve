/**
 * Standalone tmux scrollback tests — the browser terminal's scrollbar.
 *
 * tmux's attach client sends smcup (`ESC[?1049h`) when it attaches, so the browser's
 * xterm sits on its ALTERNATE buffer for the life of the tab. A terminal on the
 * alternate buffer has no scrollback, and xterm draws a scrollbar only when it has
 * scrollback to scroll — so since #620 made tmux the default engine there has been no
 * scrollbar at all. Claude Code 2.1.24x made it worse from the other end: the PANE owns
 * an alternate screen too, so tmux's own history stays at zero lines and there is no
 * scrollback ANYWHERE in the stack.
 *
 * `terminal-overrides[1] = *:smcup@:rmcup@` deletes smcup/rmcup from the CLIENT's
 * terminal description. Two halves have to hold, and this suite asserts both against a
 * real tmux:
 *
 *   1. The TMUX half. The override must actually be on the server, at its own index,
 *      leaving tmux's own default entry alone — and it must come back OFF when the
 *      setting does, because the tmux server outlives the daemon that wrote it.
 *   2. The BROWSER half. The session stream must carry no smcup, and a real xterm fed
 *      that stream must end up on its NORMAL buffer with `buffer.normal.length > rows`
 *      — which is precisely the condition xterm gates its scrollbar on.
 *
 * Skips itself when tmux is not installed.
 *
 * Run: TMPDIR=/tmp/ds-test node --test --test-timeout=180000 \
 *        test/integration-standalone/tmux-scrollback.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');
const { TmuxSandbox } = require('../helpers/tmux-sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
 * Run tmux against THIS suite's own socket, by explicit `-S` path. Never TMUX_TMPDIR —
 * see test/helpers/tmux-sandbox.js for why that variable once destroyed every live agent
 * on a developer's machine.
 */
function tmux(args) {
  return sandbox.run(args);
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-scrollback-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  // Anchored on HOME, and it names and creates its socket dir in ONE call — see the
  // account in tmux-sandbox.js. Since #625 the daemon derives the same socket from this
  // HOME, so this suite and the daemon are on ONE server by construction; without that
  // every assertion below would read an empty server and pass vacuously.
  sandbox = TmuxSandbox.forHome(HOME);
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
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
  // kills each session on OUR socket by name; with no server there it does nothing.
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  await sleep(500);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});


test('the engine under test really is tmux — otherwise this whole suite is vacuous',
  { skip: SKIP }, async () => {
    const r = await (await fetch(`${BASE}/api/engines`, { headers: authHeaders() })).json();
    assert.strictEqual(r.tmuxAvailable, true, 'tmux should be detected');
  });

test('the setting defaults ON — without that, nothing below would be reached in practice',
  { skip: SKIP }, async () => {
    const s = await (await fetch(`${BASE}/api/settings`, { headers: authHeaders() })).json();
    assert.strictEqual(s.browserScrollback, true);
  });

test('the override is on the tmux server, at its own index, beside tmux\'s default',
  { skip: SKIP }, async () => {
    await openTerminal();
    const shown = tmux(['show-options', '-s', 'terminal-overrides']);
    assert.match(shown, /terminal-overrides\[1\] ["']?\*:smcup@:rmcup@/,
      `our entry should be at index 1: ${shown}`);
    // Index 1 is chosen so tmux's own default entry at [0] survives. If a future change
    // writes the whole option instead, this is what notices.
    assert.match(shown, /terminal-overrides\[0\]/,
      `tmux's own default entry must survive: ${shown}`);
  });

test('the browser is sent NO smcup — the byte that would strand xterm on the alt buffer',
  { skip: SKIP }, async () => {
    // The acceptance test's browser half. This is the whole mechanism: what reaches the
    // tab decides which xterm buffer it lives on, and only the normal buffer has
    // scrollback for a scrollbar to represent.
    const { c } = await openTerminal();
    c.send('echo scrollback-probe\r');
    await sleep(1500);
    assert.ok(!c.output.includes('\x1b[?1049h'),
      'the attach client must not put the browser terminal on its alternate buffer');
    assert.ok(c.output.includes('scrollback-probe'), 'the session should be alive and echoing');
  });

test('a real xterm fed the session stream ends up with scrollback to scroll',
  { skip: SKIP }, async () => {
    // The strongest assertion in the suite, and the one closest to the symptom: build the
    // same terminal the browser builds, feed it the same bytes, and read the exact
    // condition xterm gates its scrollbar on — more rows in the normal buffer than fit
    // on screen. Before the override this was permanently false.
    const { c } = await openTerminal();
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    c.ws.on('message', (data) => {
      const raw = data.toString();
      try { if (typeof JSON.parse(raw) === 'object') return; } catch {}
      term.write(raw);
    });
    c.send('i=1; while [ $i -le 200 ]; do echo "L$i scrollback"; i=$((i+1)); done\r');
    await sleep(4000);

    assert.strictEqual(term.buffer.active.type, 'normal',
      'the browser terminal must be on its normal buffer');
    assert.ok(term.buffer.normal.length > term.rows,
      `xterm needs more than ${term.rows} rows of buffer to draw a scrollbar, got ${term.buffer.normal.length}`);
  });

test('turning the setting OFF unsets the override — it is not a one-way door',
  { skip: SKIP }, async () => {
    // Runs last on purpose: it flips the daemon's setting for every session after it.
    // terminal-overrides is a SERVER option on a tmux server that outlives the daemon,
    // so "stop writing it" would not be enough — an entry a previous boot left behind
    // would keep the override on forever, with no UI that could take it back off.
    const r = await fetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ browserScrollback: false }),
    });
    assert.ok(r.ok, 'the setting should be accepted');

    // Applied per attach, so it takes a new session to reach tmux.
    const { c } = await openTerminal();
    const shown = tmux(['show-options', '-s', 'terminal-overrides']);
    assert.ok(!/smcup@/.test(shown), `the override should be gone: ${shown}`);
    assert.match(shown, /terminal-overrides\[0\]/, `tmux's own default must still survive: ${shown}`);

    // And the browser half comes back: the client puts the tab on the alternate buffer.
    c.send('echo off-probe\r');
    await sleep(1500);
    assert.ok(c.output.includes('\x1b[?1049h'),
      'with the setting off, the attach client should send smcup again');
  });
