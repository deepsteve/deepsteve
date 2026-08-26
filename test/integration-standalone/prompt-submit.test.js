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
const { TmuxSandbox } = require('../helpers/tmux-sandbox');
const { writeLoginProfile } = require('../helpers/login-profile');

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
// null until before() has validated one. `after()` uses `sandbox?.cleanup()`, so a
// before() that throws leaves a no-op rather than an unaimed tmux command (#625).
let sandbox = null;
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

  // The daemon derives its tmux socket from $HOME/.deepsteve/tmux.sock and passes it
  // as `-S` (#625), so a scratch HOME IS a scratch tmux server — there is no
  // TMUX_TMPDIR to set, and setting one would isolate nothing while reading like it
  // did. The sandbox anchors on that same HOME so this suite and the daemon are
  // provably on ONE socket, and so `after()` can reap the tmux server that outlives
  // the daemon (shutdown detaches rather than kills).
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
// `engine` pins a session to one backend via the WS ?engine= override. Default is
// whatever settings.engine says, which since #620 is tmux — the engine these tests
// should exercise. Only the coalesced-recovery case pins node-pty; see its comment.
async function openSession(cfg, { engine } = {}) {
  policy(cfg);
  const c = new Client();
  clients.push(c);
  const params = { cwd: projDir, new: '1', agentType: 'claude' };
  if (engine) params.engine = engine;
  const s = await c.connect(params);
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
  // realpath, because on macOS os.tmpdir() is /var/... while a child process's own
  // cwd resolves to /private/var/... . The #656 delivery check derives the Claude
  // transcript path from the daemon's recorded cwd, and the stub derives the same
  // path from its own — they must agree or the check can only ever say "unconfirmed".
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-submit607-')));
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
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');

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
  // A SIGTERMed daemon DETACHES its tmux sessions, so the scratch tmux server
  // outlives it and the rm below would only unlink its socket — leaving a running
  // server nothing can ever reach again. Reap it by name (#625).
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// --- the repros ------------------------------------------------------------

test('#607B: a coalesced text+Enter is detected and recovered, and submits exactly once', async () => {
  // The stub does not service stdin at all for 9s, so both the text and the Enter sit
  // in the kernel tty buffer and come back in ONE read — Ink's paste path, not its
  // Enter path. This is the #607 symptom manufactured deterministically. Pre-fix
  // nothing noticed and the prompt stayed staged forever; now the verify pass sees
  // it still in the composer and re-sends Enter.
  //
  // Pinned to node-pty (#620). The recovery it characterizes depends on reading the
  // composer back, and this case deliberately stalls the agent's stdin for 9s — so
  // at verify time nothing has been drawn. Under tmux the daemon reads the pane
  // through an attach PTY, that empty window is genuinely unreadable, and
  // confirmPromptSubmitted correctly ends `unverified` rather than guessing:
  //   [submit] <id> could not read the composer — not retrying Enter
  // That is the designed safe outcome (an indeterminate screen must not trigger a
  // re-send), and submission degrades to the pre-#607 timed path, which is what
  // shipped for years. Echo-gating itself does work under tmux — the next test
  // proves it there. Closing the gap means making the composer readable through
  // tmux's repaint during an undrawn window, which is its own piece of work.
  const { c, id } = await openSession({ policy: 'ink', readAfterMs: 9000 }, { engine: 'node-pty' });
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

// --- #656: the whole prompt, or nothing -------------------------------------
//
// #607 was about a prompt that never got SENT. #656 is about one that got sent in
// pieces: two live deliveries wrote 2442 and 2494 characters and the agent recorded
// 416 and 456, losing a contiguous ~2030 off the HEAD with no fragment submitted
// anywhere. The old echo gate could not have caught it — `readComposerDraft(view)`
// truthy fired Enter on the first echoed character, at ~455ms, whatever the size.
//
// BIG_PROMPT is deliberately over one kernel input queue (1022 bytes on macOS),
// which is both the threshold that routes it to the paste path and the amount a
// single flush can take away.
const HEAD_MARKER = 'HEAD-656';
const TAIL_MARKER = 'TAIL-656';
const BIG_PROMPT = [
  `Work on GitHub issue #656 ${HEAD_MARKER}: the injected prompt arrives truncated`,
  '',
  '## Summary',
  ...Array.from({ length: 40 }, (_, i) =>
    `Paragraph ${i}: a line of issue body long enough that forty of them comfortably exceed one kernel input queue.`),
  '',
  `That is the whole issue. ${TAIL_MARKER}`,
].join('\n');

const bigSubmits = (id) => events(id).filter((e) => e.event === 'submit');

test('#656: a multi-kilobyte prompt survives a slow, small-chunked child read', async () => {
  assert.ok(Buffer.byteLength(BIG_PROMPT) > 1022,
    'the fixture must exceed one kernel input queue or it proves nothing');

  // 200-byte reads 40ms apart: the child is draining far slower than the daemon can
  // write, so the prompt is in flight across many polls of the echo gate.
  const { id } = await openSession({ readChunkBytes: 200, readGapMs: 40, echoDelayMs: 60 });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  const subs = await waitFor(() => {
    const s = bigSubmits(id);
    return s.length ? s : null;
  }, 'the stub to receive a submit', 30000);

  assert.strictEqual(subs.length, 1, `exactly one submit, got ${subs.length}`);
  assert.strictEqual(subs[0].text, BIG_PROMPT,
    `the agent must receive the WHOLE prompt, got ${subs[0].text.length}/${BIG_PROMPT.length} chars`);
  await closeSession(id);
});

// The three loss shapes, and which layer answers each. They are different problems
// and only one of them is answerable from the screen, which is why the transcript
// oracle exists rather than a cleverer composer reader.
//
//   tail lost      the composer holds our head and not our tail. POSITIVELY
//                  identifiable while nothing has been submitted yet, so the gate
//                  clears the box and writes the prompt again.
//   head lost      the composer holds only our tail — byte-identical to a healthy
//                  long draft whose head has scrolled out of the box. Not answerable
//                  on screen; the transcript check reports it.
//   middle lost    both ends present, characters gone from between them. Invisible to
//                  any edge comparison; only the recorded length gives it away.

test('#656: a write that never delivers its tail is re-typed once, and never Entered as a fragment', async () => {
  // Everything after the first 600 bytes is discarded, for good, so the composer can
  // only ever hold our head. That is the one shape the screen can positively identify,
  // and the delivery is unrecoverable — so what matters is that a FRAGMENT is never
  // submitted and the failure is never silent.
  const { id } = await openSession({ dropAfterBytes: 600, dropFirstBytes: 1e6, transcript: true });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  await waitFor(() => daemonLog.includes(`[submit] id=${id} composer shows a PARTIAL prompt`),
    'the daemon to notice the partial draft and re-type', 40000);
  // ...and the failure surfaces rather than being logged as a clean delivery.
  await waitFor(() => daemonLog.includes(`[submit] id=${id} delivery unconfirmed`),
    'the daemon to report that nothing matching ever reached the agent', 40000);

  // Exactly once. A loop that kept clearing and re-typing would be worse than the bug.
  const retypes = daemonLog.split('\n').filter((l) => l.includes(`id=${id} composer shows a PARTIAL prompt`));
  assert.strictEqual(retypes.length, 1, retypes.join('\n'));

  // The point of the whole change: a partial prompt is not handed to the agent.
  for (const sub of bigSubmits(id)) {
    assert.strictEqual(sub.text, BIG_PROMPT,
      `a fragment reached the agent: ${sub.text.length}/${BIG_PROMPT.length} chars`);
  }
  assert.ok(!daemonLog.includes(`[submit] id=${id} delivered=`), 'and it is never called clean');
  await closeSession(id);
});

test('#656: a flush partway through the write is reported, ends intact or not', async () => {
  // What TCSAFLUSH actually costs once the child has read some of the write: a run out
  // of the MIDDLE. Both edge comparisons pass, so only the recorded length gives it
  // away — which is why compareDelivered reports counts rather than a boolean.
  const { id } = await openSession({ dropAfterBytes: 600, dropFirstBytes: 2000, transcript: true });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  await waitFor(() => daemonLog.includes(`[submit] id=${id} TRUNCATED DELIVERY`),
    'the daemon to report the holed delivery', 40000);

  const line = daemonLog.split('\n').find((l) => l.includes(`id=${id} TRUNCATED DELIVERY`));
  assert.ok(/characters from the middle|the HEAD|the TAIL/.test(line), line);
  const m = /recorded (\d+)\/(\d+) chars/.exec(line);
  assert.ok(m && Number(m[1]) < Number(m[2]), line);
  await closeSession(id);
});

test('#656: a delivery that loses its HEAD is reported, since no screen can see it', async () => {
  // The honest limit of the screen-side gate, and the reason the transcript oracle
  // exists. A draft holding only the tail of an oversized prompt is INDISTINGUISHABLE
  // on screen from a healthy long draft whose head has scrolled out of the composer —
  // the box top is off-screen either way. Treating it as truncation would clear and
  // re-type perfectly good prompts, so the gate lets it through, and the delivery
  // check catches it against what the agent actually recorded.
  const { id } = await openSession({ dropFirstBytes: 1200, transcript: true });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  await waitFor(() => daemonLog.includes(`[submit] id=${id} TRUNCATED DELIVERY`),
    'the daemon to report the truncated delivery', 40000);

  const line = daemonLog.split('\n').find((l) => l.includes(`id=${id} TRUNCATED DELIVERY`));
  assert.ok(line.includes('missing the HEAD'), line);
  assert.ok(!daemonLog.includes(`[submit] id=${id} delivered=`),
    'a truncated delivery must never also report a clean one');
  await closeSession(id);
});

test('#656: a clean delivery is confirmed against the transcript, not merely assumed', async () => {
  const { id } = await openSession({ transcript: true });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  await waitFor(() => daemonLog.includes(`[submit] id=${id} delivered=`),
    'the daemon to confirm the delivery', 40000);

  const line = daemonLog.split('\n').find((l) => l.includes(`id=${id} delivered=`));
  const m = /delivered=(\d+)\/(\d+) chars/.exec(line);
  assert.ok(m, line);
  assert.strictEqual(m[1], m[2], `every character accounted for: ${line}`);
  assert.ok(!daemonLog.includes(`id=${id} TRUNCATED DELIVERY`));
  await closeSession(id);
});

test('#656: a bracketed paste is delivered whole, and Enter follows paste-end', async () => {
  // Under tmux the daemon does not emit the markers itself — paste-buffer -p does,
  // and only when the pane has mode 2004 on. This asserts the daemon's side of the
  // contract: whatever route the text takes, Enter is a separate write that lands
  // after the paste is closed, never inside it.
  const { id } = await openSession({ pasteMarkers: true, readChunkBytes: 300, readGapMs: 20 });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  const subs = await waitFor(() => {
    const s = bigSubmits(id);
    return s.length ? s : null;
  }, 'the stub to receive a submit', 30000);

  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].text, BIG_PROMPT);

  const ev = events(id);
  const end = ev.find((e) => e.event === 'paste-end');
  if (end) {
    // The pane negotiated bracketed paste, so the ordering guarantee applies.
    const enter = ev.find((e) => e.event === 'enter' && e.t >= end.t);
    assert.ok(enter, 'Enter must arrive after paste-end, as its own read');
    assert.ok(!ev.some((e) => e.event === 'enter' && e.t < end.t),
      'no Enter may be seen while the paste is still open');
  }
  await closeSession(id);
});

test('#656: an interior newline never submits a fragment on its own', async () => {
  // paste-buffer's DEFAULT is to replace every LF with CR. Without -r this prompt
  // would arrive as 45 separate Enters, and the agent would get 45 messages.
  const { id } = await openSession({ readChunkBytes: 256, readGapMs: 25 });
  const c = clients[clients.length - 1];
  c.sendPrompt(BIG_PROMPT);

  await waitFor(() => bigSubmits(id).length > 0, 'the stub to receive a submit', 30000);
  await sleep(VERIFY_SETTLED_MS);

  const subs = bigSubmits(id);
  assert.strictEqual(subs.length, 1,
    `a multi-line prompt must submit ONCE, got ${subs.length}: ${subs.map((s) => JSON.stringify(s.text.slice(0, 30))).join(', ')}`);
  await closeSession(id);
});

// NOTE: everything below stops the daemon. New cases go ABOVE this line.
test('graceful shutdown of idle sessions is not slowed by echo confirmation', async () => {
  // killShell disposes the terminal screen and drops the data handler BEFORE sending
  // /exit, so echo confirmation could never succeed there. It must stay on the timed
  // path, or every shutdown would burn the echo cap per session against killShell's
  // 8s SIGTERM escalation. This guards the teardown of all 13 other standalone suites.
  //
  // Pinned to node-pty because /exit-on-shutdown is now a node-pty-only contract:
  // since #620 a tmux-backed session is DETACHED at shutdown, never exited, which is
  // the whole point (the agent survives the restart). The tmux side of this — that
  // shutdown is fast and the session lives — is asserted in tmux-durability.test.js.
  const opened = [];
  for (let i = 0; i < 3; i++) {
    const s = await openSession({ policy: 'ink' }, { engine: 'node-pty' });
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
