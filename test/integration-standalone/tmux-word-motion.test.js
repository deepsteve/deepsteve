/**
 * Standalone tmux word-motion tests (#652).
 *
 * ⌥←/⌥→ did nothing in a terminal tab. The issue offered two candidate causes: the
 * receiving app not understanding what the browser sent, or the tmux layer dropping or
 * rewriting it on the way to the pane. This suite settles the second one against a real
 * tmux, because the answer decides where the fix belongs — and "tmux ate it" is the
 * expensive wrong turn (it would mean `extended-keys`, `terminal-features`, or another
 * `send-keys -H` bypass like the CSI u one in engines/tmux.js).
 *
 * It does not. tmux forwards BOTH forms byte-for-byte:
 *
 *   - `ESC[1;3D` is in tmux's key tree unconditionally (`tty_default_xterm_keys` ×
 *     `tty_default_xterm_modifiers[3]` → LEFT|META|IMPLIED_META) and comes back out of
 *     `input_key()` from the matching `input_key_defaults` entry, unprefixed because
 *     IMPLIED_META is set.
 *   - `ESC b` becomes `'b'|META|IMPLIED_META`, misses the tree, and falls through to
 *     `input_key_vt10x()`, which writes ESC and then the byte.
 *
 * So #652 is a browser-side bug — xterm 6.0.0 dropped the macOS Alt+Arrow remap xterm
 * 5.5.0 had — and public/js/terminal.js is the right and only place it is fixed. The
 * second test is the user-visible claim: a readline prompt on the far end of that pipe
 * actually moves the cursor by a word when the new sequence arrives.
 *
 * Skips itself when tmux is not installed.
 *
 * Run: TMPDIR=/tmp/ds-test node --test --test-timeout=180000 \
 *        test/integration-standalone/tmux-word-motion.test.js
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

// What public/js/terminal.js puts on the session socket for ⌥← / ⌥→ on macOS, and what
// xterm 6.0.0 emits on its own for Alt+Arrow everywhere. `cat -v` renders ESC as `^[`.
const WORD_LEFT = { send: '\x1bb', shown: '^[b' };
const WORD_RIGHT = { send: '\x1bf', shown: '^[f' };
const XTERM6_ALT_LEFT = { send: '\x1b[1;3D', shown: '^[[1;3D' };

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-word-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  // Anchored on HOME, and it names and creates its socket dir in ONE call — see the
  // account in tmux-sandbox.js. Since #625 the daemon derives the same socket from this
  // HOME, so this suite and the daemon are on ONE server by construction.
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
  // scratch tmux server outlives its daemon and something has to reap it.
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

test('#652: tmux hands the pane the word-motion bytes exactly as the browser sent them',
  { skip: SKIP }, async () => {
    const { c } = await openTerminal();
    // `cat -v` is the readout: it prints its stdin with ESC rendered as `^[`, so what
    // shows up here is literally what the pane's program received. `stty -echo` keeps the
    // tty's own echo of those same bytes out of the transcript, so a match cannot be the
    // terminal quoting us back to ourselves.
    c.send('stty -echo; cat -v\n');
    c.send('MARK-READY\n');
    await waitFor(() => c.output.includes('MARK-READY'), 'cat -v to start reading stdin');

    for (const seq of [WORD_LEFT, WORD_RIGHT, XTERM6_ALT_LEFT]) {
      const before = c.output.length;
      c.send(seq.send);
      c.send('\n'); // cat's stdin is line-buffered, so flush the line
      await waitFor(() => c.output.slice(before).includes(seq.shown),
        `tmux to deliver ${JSON.stringify(seq.send)} to the pane unchanged`);
    }

    // Stated as the conclusion, not just three passing waits: the CSI form arriving intact
    // is why the fix is in the browser. If this ever regresses, re-read input-keys.c before
    // reaching for a tmux option.
    assert.ok(c.output.includes(XTERM6_ALT_LEFT.shown),
      'tmux rewrote xterm 6\'s Alt+Arrow form — the browser-side premise of #652 no longer holds');
  });

test('#652: ESC b really moves a readline cursor back a word through the whole pipe',
  { skip: SKIP }, async () => {
    // The user-visible claim, at the far end of browser → WS → server → tmux client →
    // pane. bash's readline binds \eb to backward-word by default, so --norc proves it
    // with no config of ours in the way — the same binding zsh's `bindkey` shows for ^[b.
    const { c } = await openTerminal();
    c.send('bash --noprofile --norc -i\n');
    c.send('echo READLINE-UP\n');
    await waitFor(() => c.output.includes('READLINE-UP'), 'an inner readline shell to come up');

    const before = c.output.length;
    c.send('echo alpha bravo');
    await waitFor(() => c.output.slice(before).includes('alpha bravo'), 'the line to echo back');

    // Two words back from end-of-line lands before `alpha`; insert a marker there, so
    // where it comes out is the assertion. A cursor that never moved would print
    // `alpha bravoZZ`, and one word back `alpha ZZbravo`.
    c.send(WORD_LEFT.send);
    c.send(WORD_LEFT.send);
    await sleep(300);
    c.send('ZZ');
    c.send('\n');

    await waitFor(() => /^ZZalpha bravo$/m.test(c.output),
      'the word jump to land the marker before `alpha` (readline never saw ESC b)');
  });
