/**
 * Standalone tmux mouse tests (#650) — the issue's acceptance test.
 *
 * Scrolling a terminal tab walked the agent's command history instead of the terminal.
 * The daemon set exactly one tmux option per session (`status off`), so `mouse` stayed
 * at tmux's default `off` and tmux never turned mouse reporting on for its client. With
 * no mouse protocol bound, and with the tmux client owning the outer alternate screen,
 * xterm.js took its `!buffer.hasScrollback` branch and translated every wheel notch into
 * `ESC[A` / `ESC[B` — Up and Down arrows, sent to the pane as if typed.
 *
 * Two halves have to hold, and this suite asserts both against a real tmux:
 *
 *   1. The BROWSER half. tmux must actually enable mouse reporting on the attach client,
 *      because that mode-set is the byte that makes xterm bind its mouse-report wheel
 *      path and stop reaching for arrow keys. It arrives on the session's own stream.
 *   2. The TMUX half. A wheel report arriving from the browser must reach tmux's default
 *      WheelUpPane binding, which drops a plain shell pane into `copy-mode -e` — real
 *      scrollback — rather than being ignored.
 *
 * Skips itself when tmux is not installed.
 *
 * Run: TMPDIR=/tmp/ds-test node --test --test-timeout=180000 \
 *        test/integration-standalone/tmux-mouse.test.js
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

// What xterm.js sends once a wheel-carrying mouse protocol is bound: SGR (1006) encoding,
// button 64 for wheel-up and 65 for wheel-down. These are the bytes that replace the
// `ESC[A` / `ESC[B` the bug produced, so sending them here is sending exactly what a real
// scroll gesture in the browser now puts on the session socket.
const WHEEL_UP = '\x1b[<64;10;5M';
const WHEEL_DOWN = '\x1b[<65;10;5M';

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

const paneInMode = (id) => tmux(['display-message', '-p', '-t', `ds-${id}`, '#{pane_in_mode}']);

before(async () => {
  if (SKIP) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mouse-'));
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
    assert.strictEqual(r.current, 'tmux', 'a fresh install should default to tmux');
    // spawnSession degrades to node-pty rather than throwing, so without this tripwire a
    // too-long socket path would leave the suite green against the engine it is not
    // testing. Re-run with a short TMPDIR if this fires.
    assert.strictEqual(r.tmuxRuntimeFailure, null,
      'tmux cannot create sessions here, so this suite would silently test node-pty');
  });

test('#650: a spawned session has the mouse on, and the server has the clipboard on',
  { skip: SKIP }, async () => {
    const { id } = await openTerminal();
    assert.strictEqual(tmux(['show-options', '-t', `ds-${id}`, '-v', 'mouse']), 'on',
      'without this the wheel never reaches tmux and xterm sends arrow keys instead');
    // `-s` is the only scope set-clipboard has, and it is what makes tmux emit OSC 52 for
    // its OWN copy-mode copies (the default, `external`, forwards only a program's).
    assert.strictEqual(tmux(['show-options', '-s', '-v', 'set-clipboard']), 'on');
  });

test('#650: the browser is told to report the mouse — the byte that disarms xterm\'s arrows',
  { skip: SKIP }, async () => {
    // This is the browser half of the fix, and it is assertable from here because the
    // mode-set travels down the same session stream as the pane's output. xterm.js only
    // translates a wheel into ESC[A when NO wheel-carrying mouse protocol is bound; this
    // sequence is what binds one, so its presence is what makes the bug unreachable.
    const { c } = await openTerminal();
    await waitFor(() => /\x1b\[\?100[0-6]h/.test(c.output),
      'tmux to enable mouse reporting on the attach client');
  });

test('#650: a wheel-up from the browser scrolls the pane instead of pressing Up',
  { skip: SKIP }, async () => {
    const { c, id } = await openTerminal();
    // Give the pane something to scroll back to, and a unique marker to prove the shell
    // is at a prompt and reading before the wheel arrives.
    c.send('seq 1 200; echo SEEDED\n');
    await waitFor(() => c.output.includes('SEEDED'), 'the pane to fill with scrollback');
    assert.strictEqual(paneInMode(id), '0', 'a fresh pane must not already be in a mode');

    c.send(WHEEL_UP);
    await waitFor(() => paneInMode(id) === '1',
      'the wheel to drop the pane into copy-mode (tmux is ignoring mouse input)');

    // The first notch only ENTERS the mode — tmux's root binding consumes it to run
    // `copy-mode -e`, which starts at the bottom. From here `pane_in_mode` is set, so the
    // binding forwards with `send -M` and the pane actually scrolls.
    c.send(WHEEL_UP);
    const pos = await waitFor(
      () => Number(tmux(['display-message', '-p', '-t', `ds-${id}`, '#{scroll_position}'])) || null,
      'the pane to scroll back through its history');
    assert.ok(pos > 0, `copy-mode should be scrolled back, got scroll_position=${pos}`);

    // `copy-mode -e` is the exit-at-the-bottom form, so wheeling back down leaves the mode
    // on its own — no `q` to press, which is what makes this feel like a normal terminal.
    for (let i = 0; i < 6; i++) c.send(WHEEL_DOWN);
    await waitFor(() => paneInMode(id) === '0',
      'copy-mode to exit on its own once scrolled back to the bottom');

    // And the regression itself, stated as a symptom: under the bug the wheel arrived as
    // ESC[A and the shell echoed a previous command onto its prompt line.
    assert.ok(!/\bseq 1 200; echo SEEDED\b[\s\S]*\bseq 1 200; echo SEEDED\b/.test(c.output),
      'the command came back a second time — the wheel is still being read as Up');
  });

test('#650: a pane\'s OSC 52 is forwarded to the browser, which is what makes copy work',
  { skip: SKIP }, async () => {
    // The other cost of turning the mouse on: a drag-select now belongs to tmux or to the
    // pane's program, so a copy comes back as OSC 52 instead of being a browser selection
    // the user can ⌘C. `set-clipboard on` is what makes tmux emit it — for its own
    // copy-mode copies as well as a program's — and it only leaves for a client that
    // advertises the `clipboard` feature, so both halves are asserted here. The browser
    // end of the chain is public/js/osc-clipboard.js (test/unit/osc-clipboard.test.js).
    const { c, id } = await openTerminal();
    const features = tmux(['list-clients', '-t', `ds-${id}`, '-F', '#{client_termfeatures}']);
    assert.match(features, /\bclipboard\b/,
      `the attach client cannot receive OSC 52 at all, so set-clipboard is inert: ${features}`);

    const payload = Buffer.from('héllo ✻ 650', 'utf8').toString('base64');
    c.send(`printf '\\033]52;c;${payload}\\007'\n`);
    await waitFor(() => c.output.includes(`]52;c;${payload}`),
      'the OSC 52 to reach the browser (tmux is swallowing it)');
  });
