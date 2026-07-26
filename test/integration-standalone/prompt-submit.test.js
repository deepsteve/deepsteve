/**
 * End-to-end regression suite for #607 — "the start_issue prompt sometimes never
 * submits under load".
 *
 * Two defects, both reproduced here against a real daemon and a real PTY:
 *
 *   A. Prompt delivery hung off an EDGE (`setWaiting` firing a one-shot callback on
 *      the false->true transition). A tab that was already idle when the prompt was
 *      armed had no edge left to give, so the prompt was never even typed.
 *   B. `submitToShell` wrote the text and then \r on a fixed 1s timer. Ink only
 *      treats \r as Enter when it arrives as its own stdin read, so under load the
 *      two coalesce into one read and the prompt stays STAGED in the composer.
 *
 * Neither is observable through the bash stubs the other standalone suites use: bash
 * `read` is line-oriented and the pane is in canonical mode, so text+\r always
 * arrives as one line whether or not the daemon split the writes. This suite uses
 * test/helpers/stubs/fake-claude-tui.js — a raw-mode node TUI that models Ink's rule
 * and logs every stdin chunk — and drives its failure modes from a JSON policy file
 * so coalescing is produced BY CONSTRUCTION rather than by hoping the scheduler
 * cooperates.
 *
 * Run: node --test --test-timeout=180000 test/integration-standalone/prompt-submit.test.js
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
const STUB_SRC = path.join(REPO_ROOT, 'test', 'helpers', 'stubs', 'fake-claude-tui.js');

// Shrunk daemon timings. Kept in ratio with production: the echo cap must exceed the
// stall a test induces, and the verify window must exceed the stub's own latencies.
const TIMINGS = {
  DEEPSTEVE_SUBMIT_ECHO_MIN_MS: '300',
  DEEPSTEVE_SUBMIT_ECHO_POLL_MS: '100',
  DEEPSTEVE_SUBMIT_ECHO_MAX_MS: '4000',
  DEEPSTEVE_SUBMIT_ECHO_SETTLE_MS: '150',
  DEEPSTEVE_SUBMIT_VERIFY_MS: '1500',
  DEEPSTEVE_SUBMIT_VERIFY_POLL_MS: '250',
  DEEPSTEVE_SUBMIT_VERIFY_RETRIES: '2',
  DEEPSTEVE_PROMPT_READY_DEADLINE_MS: '8000',
};
// Longest a submission can legitimately take with the above, plus slack. Used only
// to bound the "it did NOT happen again" assertions.
const VERIFY_SETTLED_MS = 1500 * 3 + 1000;

const MARKER = 'MARKER-607';
const PROMPT = [
  `Work on GitHub issue #607 ${MARKER}: start_issue prompt sometimes never submits`,
  '',
  '## Summary',
  'A new issue tab does not always send its pre-populated prompt.',
].join('\n');

let tmpRoot, HOME, PORT, BASE, projDir, LOGS, POLICY;
let daemon = null;
let daemonLog = '';

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
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  // Must come BEFORE the timing knobs below — this loop strips every DEEPSTEVE_ key.
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  Object.assign(env, TIMINGS);

  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '');
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  env.DS_STUB_CONFIG = POLICY;
  env.DS_STUB_LOG_DIR = LOGS;

  // tmux's socket is per-UID, not per-HOME (CLAUDE.md) — a scratch-HOME daemon would
  // otherwise reap the real daemon's ds-* sessions as orphans.
  const tmuxTmp = path.join(HOME, 'tmux-tmp');
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  env.TMUX_TMPDIR = tmuxTmp;

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

// --- stub oracles ----------------------------------------------------------

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
const stdinChunks = (id) => readJsonl(path.join(LOGS, `${id}.stdin.jsonl`));
const submits = (id) => events(id).filter((e) => e.event === 'submit');
const enterChunks = (id) => stdinChunks(id).filter((c) => c.text === '\\r');
const textChunks = (id) => stdinChunks(id).filter((c) => c.text.includes(MARKER));

// --- WS client -------------------------------------------------------------

class Client {
  constructor() { this.ws = null; this.messages = []; this.raw = ''; this.session = null; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 10000);
      this.ws.on('message', (data) => {
        const text = data.toString();
        let msg;
        try { msg = JSON.parse(text); } catch { this.raw += text; return; }
        if (typeof msg !== 'object' || msg === null) { this.raw += text; return; }
        this.messages.push({ ...msg, _ts: Date.now() });
        if (msg.type === 'session' && !this.session) { this.session = msg; clearTimeout(timer); resolve(msg); }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  sendPrompt(text) { this.ws.send(JSON.stringify({ type: 'initialPrompt', text, loading: true })); }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

let clients = [];
async function openSession(cfg) {
  policy(cfg);
  const c = new Client();
  clients.push(c);
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  await waitFor(() => events(s.id).some((e) => e.event === 'boot'), 'the stub TUI to boot');
  return { c, id: s.id };
}
async function closeSession(id) {
  try { await fetch(`${BASE}/api/shells/${id}?forget=1`, { method: 'DELETE', headers: authHeaders() }); } catch {}
}
async function shellState(id) {
  const r = await fetch(`${BASE}/api/shells/${id}/state`, { headers: authHeaders() });
  return r.json();
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-submit607-'));
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
  fs.writeFileSync(
    path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(HOME, '.zprofile'), 'export PATH="$HOME/bin:$PATH"\n');

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
});

after(async () => {
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon();
  // DS_KEEP_TMP=1 preserves the scratch HOME and the stub's stdin/event logs, which
  // are the only record of what the "agent" actually received.
  if (process.env.DS_KEEP_TMP) { console.log(`[prompt-submit] kept scratch tree: ${tmpRoot}`); return; }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// --- the repros ------------------------------------------------------------

test('#607B: a coalesced text+Enter is detected and recovered, and submits exactly once', async () => {
  // The stub does not service stdin at all for 9s, so both the text and the Enter sit
  // in the kernel tty buffer and come back in ONE read — Ink's paste path, not its
  // Enter path. This is the #607 symptom manufactured deterministically. Pre-fix
  // nothing noticed and the prompt stayed staged forever; now the verify pass sees
  // it still in the composer and re-sends Enter.
  const { c, id } = await openSession({ policy: 'ink', readAfterMs: 9000 });
  c.sendPrompt(PROMPT);

  const got = await waitFor(() => (submits(id).length === 1 ? submits(id) : null), 'the prompt to submit', 40000);
  assert.ok(got[0].text.includes(MARKER), `submitted text should carry the marker: ${got[0].text.slice(0, 80)}`);
  assert.ok(events(id).some((e) => e.event === 'enter-coalesced'),
    'the test must actually have produced a coalesced read, or it proves nothing');
  assert.strictEqual(textChunks(id).length, 1, 'recovery re-sends Enter, never the prompt text');
  await sleep(VERIFY_SETTLED_MS);
  assert.strictEqual(submits(id).length, 1, 'and exactly once');
  await closeSession(id);
});

test('Enter is a separate stdin chunk, written only after the composer echoes', async () => {
  const { c, id } = await openSession({ policy: 'ink', echoDelayMs: 1200 });
  c.sendPrompt(PROMPT);
  await waitFor(() => submits(id).length === 1, 'the prompt to submit');

  const text = textChunks(id);
  const enters = enterChunks(id);
  assert.strictEqual(text.length, 1, 'the prompt text was written exactly once');
  assert.strictEqual(enters.length, 1, 'exactly one Enter');
  assert.ok(enters[0].t > text[0].t + 1200,
    `Enter must wait for the 1200ms echo: text@${text[0].t}ms, Enter@${enters[0].t}ms`);
  assert.ok(!stdinChunks(id).some((ch) => ch.text.includes(MARKER) && ch.text.includes('\\r')),
    'no single chunk carried both the text and Enter');
  await closeSession(id);
});

test('#607A: a session whose screen never classifies still gets its prompt (deadline)', async () => {
  // footer:'never' means the classifier can never say "waiting", so waitingForInput
  // stays false and no false->true edge ever occurs. Pre-fix the prompt sat in
  // e.onIdleOnce forever; the level-triggered deadline now delivers it.
  const { c, id } = await openSession({ policy: 'ink', footer: 'never' });
  c.sendPrompt(PROMPT);

  await waitFor(() => submits(id).length === 1, 'the prompt to submit via the deadline', 25000);
  const state = await shellState(id);
  assert.strictEqual(state.waitingForInput, false, 'the screen never became classifiable');
  assert.ok(daemonLog.includes('readiness deadline reached'), 'the deadline path is what delivered it');
  await closeSession(id);
});

test('the fast path still wins when the screen does become idle', async () => {
  const { c, id } = await openSession({ policy: 'ink', footer: 'late', footerLateMs: 2000 });
  const before = daemonLog.length;
  c.sendPrompt(PROMPT);
  await waitFor(() => submits(id).length === 1, 'the prompt to submit');

  const since = daemonLog.slice(before);
  assert.ok(since.includes('screen idle — submitting pending prompt'), 'delivered off the screen, not the deadline');
  assert.ok(submits(id)[0].t < 8000, `should beat the 8s deadline, submitted at ${submits(id)[0].t}ms`);
  await closeSession(id);
});

// --- verify and retry ------------------------------------------------------

test('a swallowed Enter is retried — with Enter only, never the text', async () => {
  const { c, id } = await openSession({ policy: 'ink', swallowEnters: 1 });
  c.sendPrompt(PROMPT);

  await waitFor(() => submits(id).length === 1, 'the retried Enter to land', 25000);
  assert.strictEqual(events(id).filter((e) => e.event === 'enter-swallowed').length, 1);
  assert.strictEqual(enterChunks(id).length, 2, 'the original Enter plus exactly one retry');
  assert.strictEqual(textChunks(id).length, 1, 'the prompt text is NEVER re-sent');
  await closeSession(id);
});

test('a successful submit is never retried', async () => {
  const { c, id } = await openSession({ policy: 'ink', workMs: 2500 });
  c.sendPrompt(PROMPT);
  await waitFor(() => events(id).some((e) => e.event === 'work-end'), 'the turn to finish');
  await sleep(VERIFY_SETTLED_MS);

  assert.strictEqual(submits(id).length, 1, 'exactly one submission');
  assert.strictEqual(enterChunks(id).length, 1, 'no spurious retry Enter');
  // An Enter on an empty composer is a no-op the stub records — this is what makes a
  // spurious retry visible rather than silent.
  assert.deepStrictEqual(events(id).filter((e) => e.event === 'enter-empty'), []);
  await closeSession(id);
});

test('verification bails out when the agent is working, even with the draft still on screen', async () => {
  const { c, id } = await openSession({ policy: 'ink', workMs: 4000, keepDraft: true });
  c.sendPrompt(PROMPT);
  await waitFor(() => events(id).some((e) => e.event === 'work-start'), 'the turn to start');
  await waitFor(async () => (await shellState(id)).waitingForInput === false, 'the daemon to see a running turn');
  await waitFor(() => events(id).some((e) => e.event === 'work-end'), 'the turn to finish');
  await sleep(VERIFY_SETTLED_MS);

  assert.strictEqual(enterChunks(id).length, 1, 'a running turn proves the prompt landed');
  assert.strictEqual(submits(id).length, 1);
  await closeSession(id);
});

test('two queued prompts still land in order', async () => {
  const { c, id } = await openSession({ policy: 'ink' });
  c.sendPrompt('/rc');
  c.sendPrompt(PROMPT);

  await waitFor(() => submits(id).length === 2, 'both prompts to submit', 30000);
  const texts = submits(id).map((s) => s.text);
  assert.strictEqual(texts[0], '/rc');
  assert.ok(texts[1].includes(MARKER), `second prompt should be the issue prompt, got ${texts[1].slice(0, 60)}`);
  await closeSession(id);
});

test('a tab closed mid-submission does not crash the daemon or write after death', async () => {
  const { c, id } = await openSession({ policy: 'ink', echoDelayMs: 30000 });  // echo never arrives in time
  c.sendPrompt(PROMPT);
  await waitFor(() => textChunks(id).length === 1, 'the prompt text to reach the stub');
  await closeSession(id);
  await sleep(VERIFY_SETTLED_MS);

  const r = await fetch(`${BASE}/api/version`, { headers: authHeaders() });
  assert.ok(r.ok, 'daemon still serving');
  assert.ok(!/UnhandledPromiseRejection|ERR_UNHANDLED/.test(daemonLog), 'no unhandled rejection');

  // And it can still take new work.
  const fresh = await openSession({ policy: 'ink' });
  fresh.c.sendPrompt(PROMPT);
  await waitFor(() => submits(fresh.id).length === 1, 'a fresh session to still work');
  await closeSession(fresh.id);
});

test('graceful shutdown of idle sessions is not slowed by echo confirmation', async () => {
  // killShell disposes the terminal screen and drops the data handler BEFORE sending
  // /exit, so echo confirmation could never succeed there. It must stay on the timed
  // path, or every shutdown would burn the echo cap per session against killShell's
  // 8s SIGTERM escalation. This guards the teardown of all 13 other standalone suites.
  const opened = [];
  for (let i = 0; i < 3; i++) {
    const s = await openSession({ policy: 'ink' });
    opened.push(s);
    await waitFor(async () => (await shellState(s.id)).waitingForInput === true, 'the session to read idle');
  }

  const started = Date.now();
  await stopDaemon();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `shutdown took ${elapsed}ms — killShell must not wait on echo confirmation`);
  for (const s of opened) {
    assert.ok(events(s.id).some((e) => e.event === 'exit' && e.via === '/exit'),
      `session ${s.id} should have exited via /exit`);
  }
});
