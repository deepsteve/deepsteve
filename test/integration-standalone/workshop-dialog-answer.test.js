/**
 * Workshop's blocked-item path, end to end against a real daemon and a real PTY (#660).
 *
 * This is the only place the feature's central claim is actually proved:
 *
 *   1. a session sitting on a permission dialog appears in the inbox with its QUESTION
 *      and OPTIONS, not just its tab name;
 *   2. answering that item from the inbox selects the INTENDED option in the real
 *      session — verified by re-reading the screen before Enter is sent; and
 *   3. a dialog that resolves itself leaves the inbox with no leftover row.
 *
 * test/unit/workshop-tools.test.js drives every branch of the key dance against a fake
 * terminal, which is where the error paths belong. What it cannot prove is the part
 * that only exists in a real PTY: that arrow bytes written 250ms apart are seen as
 * ARROW KEYS at the far end. Ink recognizes a control byte only when it arrives as its
 * own stdin read, and the bash stubs the other suites use cannot tell the difference —
 * a pane's tty is in canonical mode, so `read` is line-oriented. So this suite uses
 * test/helpers/stubs/fake-claude-tui.js, which runs stdin in RAW mode and now grows a
 * `menu` policy that renders a real permission dialog and moves its cursor per read.
 *
 * Own daemon: scratch $HOME, random port, its own tmux server via the scratch HOME
 * (#625). Never touches the live install.
 *
 * Run: node --test --test-timeout=180000 test/integration-standalone/workshop-dialog-answer.test.js
 * (with a SHORT TMPDIR — a tmux socket lives under $HOME:
 *  TMPDIR=/tmp/ds-test node --test ... )
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
const STUB_SRC = path.join(REPO_ROOT, 'test', 'helpers', 'stubs', 'fake-claude-tui.js');

const BANNER = 'deepsteve - read_session_screen (MCP)';
const QUESTION = 'Do you want to proceed?';
const OPTIONS = ['Yes', "Yes, and don't ask again for read_session_screen commands", 'No'];

let tmpRoot, HOME, PORT, BASE, projDir, LOGS, POLICY;
let daemon = null;
let daemonLog = '';
// null until before() has validated one; after() uses `sandbox?.cleanup()` so a
// before() that throws leaves a no-op rather than an unaimed tmux command (#625).
let sandbox = null;
let clients = [];

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

async function waitFor(check, what, timeoutMs = 30000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let result;
    try { result = await check(); } catch { result = null; }
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}\n--- daemon log tail ---\n${daemonLog.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function policy(cfg) { fs.writeFileSync(POLICY, JSON.stringify(cfg)); }

// appendFileSync from another process can be observed mid-line; drop a partial tail.
function readJsonl(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial trailing write */ }
  }
  return out;
}
const events = (id) => readJsonl(path.join(LOGS, `${id}.events.jsonl`));

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
          this.session = msg; clearTimeout(timer); resolve(msg);
        }
      });
      this.ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

async function openBlockedSession() {
  // menuOnBoot puts the stub straight into the dialog, so the session is "blocked"
  // from its first frame with no prompt round trip to sequence.
  policy({
    menuOnBoot: true,
    menu: { banner: BANNER, question: QUESTION, options: OPTIONS, cursor: 0 },
  });
  const c = new Client();
  clients.push(c);
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  await waitFor(() => events(s.id).some((e) => e.event === 'boot'), 'the stub TUI to boot');
  return { c, id: s.id };
}

const inbox = async () => {
  const r = await fetch(`${BASE}/api/workshop/inbox`, { headers: authHeaders() });
  assert.ok(r.ok, `GET /api/workshop/inbox -> ${r.status}`);
  return (await r.json()).items;
};
const blockedRow = async (id) => (await inbox()).find((i) => i.id === `blocked:${id}`) || null;

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // suppress browser auto-open
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  env.DS_STUB_CONFIG = POLICY;
  env.DS_STUB_LOG_DIR = LOGS;
  // The daemon derives its tmux socket from $HOME/.deepsteve/tmux.sock and passes it
  // as `-S` (#625), so a scratch HOME IS a scratch tmux server. The sandbox anchors on
  // the same HOME so after() can reap the server that outlives the daemon.
  sandbox = TmuxSandbox.forHome(HOME);
  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', (d) => { daemonLog += d.toString(); });
  daemon.stderr.on('data', (d) => { daemonLog += d.toString(); });
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

before(async () => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workshop660-')));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  LOGS = path.join(tmpRoot, 'stub-logs');
  POLICY = path.join(tmpRoot, 'stub-policy.json');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  policy({});

  fs.copyFileSync(STUB_SRC, path.join(HOME, 'bin', 'claude'));
  fs.chmodSync(path.join(HOME, 'bin', 'claude'), 0o755);
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon().catch(() => {});
  if (process.env.DS_KEEP_TMP) { console.log(`[workshop660] kept scratch tree: ${tmpRoot}`); return; }
  // A SIGTERMed daemon DETACHES its tmux sessions, so the scratch server outlives it
  // and an rm would only unlink the socket. Reap it by name (#625).
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('the mod really loaded — its tools and routes are live', async () => {
  // Non-vacuity. mcp-server.js catches a mod's load failure per-mod and logs ONE line,
  // so a require-time throw in tools.js would silently make every assertion below
  // reach a 404 and this file would fail with something unhelpful instead.
  assert.match(
    daemonLog, /registered tool "workshop_ask" from mod "workshop"/,
    'the workshop mod did not load; look for `failed to load tools from mod "workshop"` '
    + `in the daemon log:\n${daemonLog.slice(-1500)}`,
  );
  const r = await fetch(`${BASE}/api/workshop/inbox`, { headers: authHeaders() });
  assert.strictEqual(r.status, 200);
});

test('a session on a permission dialog shows its question and options, not its tab name', async () => {
  const { id } = await openBlockedSession();

  const row = await waitFor(() => blockedRow(id), 'the blocked session to reach the inbox');
  assert.strictEqual(row.kind, 'blocked');
  assert.strictEqual(row.urgency, 'blocking');
  assert.strictEqual(row.question, QUESTION);
  assert.deepStrictEqual(
    row.options.map((o) => o.label), OPTIONS,
    'the point of the feature: the real options, parsed off the real screen',
  );
  assert.strictEqual(row.cursorIndex, 0, 'and where the cursor currently sits');
  assert.strictEqual(row.answerable, true);
  assert.ok(
    row.context.includes(BANNER),
    `the tool banner must come along as context — "${QUESTION}" alone is identical in `
    + 'every session and says nothing',
  );
  assert.strictEqual(row.headline, BANNER);
});

test('answering from the inbox selects the intended option in the real session', async () => {
  const { id } = await openBlockedSession();
  const row = await waitFor(() => blockedRow(id), 'the blocked row');

  // Option 3 ("No"), two Downs away from where the cursor is.
  const r = await fetch(`${BASE}/api/workshop/items/${encodeURIComponent(row.id)}/answer`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ optionIndex: 2, expect: 'no' }),
  });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `answer failed: ${JSON.stringify(body)}`);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.steps, 2);
  assert.strictEqual(body.direction, 'Down');

  // The far end's own record of what it received. This is the assertion that proves
  // arrow bytes written 250ms apart really are seen as arrow KEYS through a real PTY.
  const selected = await waitFor(
    () => events(id).find((e) => e.event === 'menu-select'),
    'the stub to record a selection',
  );
  assert.strictEqual(selected.index, 2, `the agent committed option ${selected.index + 1}, not 3`);
  assert.strictEqual(selected.label, OPTIONS[2]);

  const moves = events(id).filter((e) => e.event === 'menu-move');
  assert.deepStrictEqual(
    moves.map((m) => m.cursor), [1, 2],
    'each arrow must arrive as its OWN stdin read — batched bytes are not keys to Ink, '
    + 'and would show up here as a single move or none at all',
  );
});

test('a dialog answered from the inbox leaves it, with no leftover row', async () => {
  const { id } = await openBlockedSession();
  const row = await waitFor(() => blockedRow(id), 'the blocked row');
  const r = await fetch(`${BASE}/api/workshop/items/${encodeURIComponent(row.id)}/answer`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ optionIndex: 0 }),
  });
  assert.strictEqual(r.status, 200);

  await waitFor(
    async () => (await blockedRow(id)) === null,
    'the answered row to disappear from the inbox',
  );
  // Derived rows are computed per request, so "gone" means gone — there is no
  // tombstone to reconcile and nothing carrying the session id any more.
  const leftovers = (await inbox()).filter((i) => i.sessionId === id);
  assert.deepStrictEqual(leftovers, [], 'a derived item must leave nothing behind');
});

test('a dialog resolved in the terminal disappears on its own', async () => {
  // Acceptance criterion 7, and the reason blocked items are derived rather than
  // stored: nobody told Workshop this happened.
  const { c, id } = await openBlockedSession();
  await waitFor(() => blockedRow(id), 'the blocked row');

  c.ws.send('\r');   // the human answers in the tab, not in the inbox

  await waitFor(
    () => events(id).find((e) => e.event === 'menu-select'),
    'the stub to record the terminal-side selection',
  );
  await waitFor(async () => (await blockedRow(id)) === null, 'the row to vanish with no action');
});

test('free text against a live dialog is refused, with a way forward', async () => {
  const { id } = await openBlockedSession();
  const row = await waitFor(() => blockedRow(id), 'the blocked row');

  const r = await fetch(`${BASE}/api/workshop/items/${encodeURIComponent(row.id)}/answer`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text: 'just say no' }),
  });
  assert.strictEqual(r.status, 400);
  const body = await r.json();
  assert.strictEqual(body.error, 'text-not-answerable');
  assert.match(body.hint, /open the tab/i);

  // Nothing may have been typed at the agent.
  assert.strictEqual(
    events(id).filter((e) => e.event === 'menu-select' || e.event === 'menu-move').length, 0,
    'a refused answer must not have touched the session at all',
  );
});

test('a stale expect fingerprint is refused before a single key is sent', async () => {
  const { id } = await openBlockedSession();
  const row = await waitFor(() => blockedRow(id), 'the blocked row');

  const r = await fetch(`${BASE}/api/workshop/items/${encodeURIComponent(row.id)}/answer`, {
    method: 'POST',
    headers: jsonHeaders(),
    // What the human clicked in a dialog that is no longer the one on screen.
    body: JSON.stringify({ optionIndex: 2, expect: 'delete everything' }),
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).reason, 'dialog-changed');
  assert.strictEqual(
    events(id).filter((e) => e.event === 'menu-move').length, 0,
    'not one key may be sent when the dialog is not the one that was answered',
  );
  assert.ok(await blockedRow(id), 'and the row stays, so it can be answered properly');
});

test('dismissing a live dialog clears the row without touching the session', async () => {
  // The other half of "a row leaves the inbox" (#663). Every other exit needs the
  // human to answer or the session to die; this one is for the row nobody will ever
  // act on — and it must be provable that the agent never noticed.
  const { id } = await openBlockedSession();
  const row = await waitFor(() => blockedRow(id), 'the blocked row');
  assert.ok(row.fingerprint, 'the row must carry the fingerprint it was drawn with');

  const r = await fetch(`${BASE}/api/workshop/items/${encodeURIComponent(row.id)}/dismiss`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ reason: 'archived', expect: row.fingerprint }),
  });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `dismiss failed: ${JSON.stringify(body)}`);
  assert.strictEqual(body.muted, true);

  await waitFor(async () => (await blockedRow(id)) === null, 'the muted row to leave the inbox');

  // Nothing was typed, and the dialog is still standing in the real session: a mute is
  // not an Escape, and Escape is a decision Workshop does not get to make.
  assert.strictEqual(
    events(id).filter((e) => e.event === 'menu-select' || e.event === 'menu-move').length, 0,
    'a mute must never reach the PTY',
  );
  const screen = await fetch(
    `${BASE}/api/workshop/items/${encodeURIComponent(row.id)}/screen?lines=30`,
    { headers: authHeaders() },
  ).then((x) => x.json());
  assert.ok(
    screen.lines.some((l) => String(l).includes(QUESTION)),
    'the dialog itself must be left exactly as it was',
  );

  // And it stays gone rather than flickering back on the next poll.
  await new Promise((r2) => setTimeout(r2, 1200));
  assert.strictEqual(await blockedRow(id), null, 'a mute must survive repaints');
});
