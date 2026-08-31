/**
 * Standalone tests for the History endpoint (#672).
 *
 * Spawns its OWN throwaway daemon with a scratch $HOME, which is the whole point:
 * this process then owns the directory Claude Code would write transcripts into,
 * so it can plant a REAL one at exactly the path the daemon derives and read it
 * back over HTTP. test/integration/transcript-api.test.js covers the envelope;
 * everything here needs a transcript on disk. Harness mirrors
 * fork-lineage.test.js.
 *
 * What it proves, all of which was measured on real transcripts first:
 *   - Paging backwards over a large transcript terminates, returns every record
 *     exactly once, and stays fast enough not to stall a PTY.
 *   - A 1 MB base64 screenshot never reaches the wire. This is the difference
 *     between a 200 KB page and a 1.4 MB one, and the longest line measured on
 *     the development machine is 1,365,762 bytes of exactly this.
 *   - A CLOSED session still serves its transcript — the case the feature exists
 *     for, since a live agent's history is one arrow key away inside its own TUI
 *     and a closed one's is reachable no other way.
 *   - A live append shows up through `?after=`, and an idle poll costs nothing.
 *
 * Run directly (not picked up by test/run-integration.sh):
 *   node --test --test-timeout=180000 test/integration-standalone/transcript-history.test.js
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
const { TmuxSandbox } = require('../helpers/tmux-sandbox');
const { writeLoginProfile } = require('../helpers/login-profile');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Same stub the other standalone suites use: blocks on stdin like a REPL, fails a
// --resume with no transcript on disk, exits on /exit.
const CLAUDE_STUB = `#!/bin/bash
echo "$*" >> "$HOME/claude-invocations.log"
resume=""
prev=""
for a in "$@"; do
  [ "$prev" = "--resume" ] && resume="$a"
  prev="$a"
done
if [ -n "$resume" ]; then
  if ! ls "$HOME"/.claude/projects/*/"$resume".jsonl >/dev/null 2>&1; then
    echo "No conversation found with session ID: $resume"
    exit 1
  fi
fi
while IFS= read -r line; do
  case "$line" in *"/exit"*) exit 0 ;; esac
done
exit 0
`;

let tmpRoot, HOME, PORT, BASE, projDir;
let daemon = null;
let daemonLog = '';
let sandbox = null;
const TURNS = 400;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function authToken() {
  try { return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim(); } catch { return ''; }
}
function authHeaders() {
  const t = authToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function get(pathname) {
  const started = Date.now();
  const res = await fetch(`${BASE}${pathname}`, { headers: authHeaders() });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* an HTML error page */ }
  return { status: res.status, body, bytes: text.length, raw: text, ms: Date.now() - started };
}

async function waitFor(check, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok; try { ok = await check(); } catch { ok = null; }
    if (ok) return ok;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  // A scratch HOME IS a scratch tmux server: the daemon derives its socket from
  // $HOME/.deepsteve/tmux.sock and passes it as -S (#625). The sandbox anchors on
  // the same HOME so after() can reap the server, which outlives a SIGTERM.
  sandbox = TmuxSandbox.forHome(HOME);
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // no browser auto-open
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

  daemon = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
  daemon.stdout.on('data', (d) => { daemonLog += d.toString(); });
  daemon.stderr.on('data', (d) => { daemonLog += d.toString(); });
  await waitFor(async () => {
    if (!authToken()) return false;
    return (await fetch(`${BASE}/api/version`, { headers: authHeaders() })).ok;
  }, 'daemon to become ready');
}

function stopDaemon() {
  if (!daemon) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = daemon; daemon = null;
    const timer = setTimeout(() => reject(new Error('daemon did not exit within 30s of SIGTERM')), 30000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
}

/** Claude Code's project-dir encoding — mirrors claudeProjectDir in server.js. */
function projectDirFor(cwd) {
  return path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
}

/**
 * A transcript shaped like a real one: bookkeeping records that must be dropped,
 * a slash-command record that must be flagged rather than dropped, a 1 MB base64
 * screenshot, and one 200 KB tool result.
 */
function writeTranscript(cwd, sessionId) {
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  const push = (o) => out.push(JSON.stringify(o));
  // One record per statement, and every content block built as a named value:
  // these literals nest four deep, and a misplaced brace in a fixture is a bug
  // that looks like a bug in the code under test.
  const asst = (uuid, block) => push({
    type: 'assistant', uuid, sessionId,
    message: { id: `msg${uuid.replace(/\D/g, '')}`, role: 'assistant', model: 'claude-opus-5', content: [block] },
  });
  const user = (uuid, content, extra = {}) => push({ type: 'user', uuid, sessionId, ...extra, message: { role: 'user', content } });

  for (let i = 0; i < TURNS; i++) {
    push({ type: 'attachment', sessionId, attachment: { type: 'total_tokens_reminder', text: 'x'.repeat(120) } });
    push({ type: 'mode', sessionId, mode: 'default' });

    user(`u${i}`, `question number ${i}`, { timestamp: new Date(1786000000000 + i * 1000).toISOString() });
    asst(`k${i}`, { type: 'thinking', thinking: 'weighing it up '.repeat(30), signature: 'sig' });
    asst(`b${i}`, { type: 'tool_use', id: `tool${i}`, name: 'Bash', input: { command: `echo ${i}` } });

    if (i === 11) {
      // The hazard: a screenshot. ~1.3 MB on one line, which is the shape of the
      // longest line measured on the development machine.
      user(`img${i}`, [{
        type: 'tool_result', tool_use_id: `tool${i}`,
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64_MARKER.repeat(60000) } },
        ],
      }]);
    } else {
      user(`r${i}`, [{
        type: 'tool_result', tool_use_id: `tool${i}`,
        content: i === 17 ? 'y'.repeat(200000) : `output ${i}`,
      }]);
    }

    asst(`a${i}`, { type: 'text', text: `answer number ${i}` });
    if (i % 50 === 7) user(`m${i}`, '<command-name>/deepsteve:merge</command-name>');
  }
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), out.join('\n') + '\n');
  return path.join(dir, `${sessionId}.jsonl`);
}

const BASE64_MARKER = 'QkFTRTY0U0NSRUVOU0hPVA';

class Client {
  constructor() { this.ws = null; this.session = null; }
  connect(params) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params);
      this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?${qs}`, { headers: authHeaders() });
      const timer = setTimeout(() => reject(new Error('WS session message timed out')), 15000);
      this.ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg && msg.type === 'session' && !this.session) {
          this.session = msg; clearTimeout(timer); resolve(msg);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}

let clients = [];
const track = (c) => { clients.push(c); return c; };

let shellId, claudeId, transcriptFile;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-hist-'));
  HOME = path.join(tmpRoot, 'home');
  projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'claude'), CLAUDE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'),
    '#!/bin/bash\necho "$*" >> "$HOME/open-invocations.log"\nexit 0\n', { mode: 0o755 });
  writeLoginProfile(HOME, 'export PATH="$HOME/bin:$PATH"');
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();

  const c = track(new Client());
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  shellId = s.id; claudeId = s.claudeSessionId;
  assert.ok(shellId && claudeId, 'session has a shell id and a claude session id');
  transcriptFile = writeTranscript(projDir, claudeId);
});

after(async () => {
  for (const c of clients) c.close();
  clients = [];
  await stopDaemon().catch(() => {});
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('the tail page arrives fast, oldest-first, with the newest turn last', async () => {
  const { status, body, ms } = await get(`/api/shells/${shellId}/transcript`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.supported, true);
  assert.strictEqual(body.exists, true);
  assert.strictEqual(body.live, true);
  assert.ok(body.entries.length > 0, 'tail page has entries');
  assert.strictEqual(body.file.size, fs.statSync(transcriptFile).size);

  const answers = body.entries.filter((e) => e.kind === 'text' && /^answer number/.test(e.text || ''));
  assert.strictEqual(answers[answers.length - 1].text, `answer number ${TURNS - 1}`,
    'the newest turn must be the last entry — "latest" is where a reader starts');

  const stamped = body.entries.map((e) => e.ts).filter(Boolean);
  assert.deepStrictEqual(stamped, [...stamped].sort(), 'entries must be oldest-first');

  // The 448ms readSync stall on /api/recoverable-sessions is the precedent: this
  // endpoint shares an event loop with every live PTY.
  assert.ok(ms < 250, `tail page took ${ms}ms`);
});

test('paging back to the start terminates and returns every record exactly once', async () => {
  let page = (await get(`/api/shells/${shellId}/transcript`)).body;
  const seen = new Set();
  // Pages arrive newest-first but each is internally oldest-first, so they are
  // PREPENDED — exactly what the pane does. Appending here would rebuild the
  // transcript inside out and the order assertion below would be meaningless.
  const chunks = [];
  let pages = 1, slowest = 0;
  const collect = (p) => {
    for (const e of p.entries) {
      const key = `${e.offset}:${e.seq}`;
      assert.ok(!seen.has(key), `entry ${key} was returned twice`);
      seen.add(key);
    }
    chunks.unshift(p.entries);
  };
  collect(page);
  let cursor = page.cursor.before;
  while (page.cursor.hasMore) {
    assert.ok(pages < 300, 'paging did not terminate');
    const res = await get(`/api/shells/${shellId}/transcript?before=${cursor}`);
    assert.strictEqual(res.status, 200);
    slowest = Math.max(slowest, res.ms);
    page = res.body;
    assert.ok(page.cursor.before < cursor, `cursor must advance (was ${cursor}, now ${page.cursor.before})`);
    collect(page);
    cursor = page.cursor.before;
    pages++;
  }
  assert.ok(slowest < 250, `slowest page took ${slowest}ms`);

  // Every turn is present, in order — a pager that silently drops a window would
  // still look fine on any single page.
  const all = chunks.flat();
  const questions = all.filter((e) => e.kind === 'text' && /^question number/.test(e.text || ''));
  const answers = all.filter((e) => e.kind === 'text' && /^answer number/.test(e.text || ''));
  assert.strictEqual(questions.length, TURNS);
  assert.strictEqual(answers.length, TURNS);
  assert.deepStrictEqual(questions.map((e) => e.text), questions.map((_, i) => `question number ${i}`));
});

test('a base64 screenshot never reaches the wire, on any page', async () => {
  let page = (await get(`/api/shells/${shellId}/transcript`)).body;
  let cursor = page.cursor.before;
  let images = 0, biggest = 0;
  for (let i = 0; i < 300; i++) {
    biggest = Math.max(biggest, JSON.stringify(page).length);
    images += page.entries.filter((e) => e.kind === 'image').length;
    assert.ok(!JSON.stringify(page).includes(BASE64_MARKER), 'base64 payload leaked into a page');
    if (!page.cursor.hasMore) break;
    const res = await get(`/api/shells/${shellId}/transcript?before=${cursor}`);
    page = res.body; cursor = page.cursor.before;
  }
  assert.strictEqual(images, 1, 'the screenshot should appear exactly once, as a placeholder');
  assert.ok(biggest < 2 * 1024 * 1024, `largest page was ${biggest} bytes`);
});

test('a huge tool result is clipped but says how much is missing', async () => {
  let page = (await get(`/api/shells/${shellId}/transcript`)).body;
  let cursor = page.cursor.before;
  let clipped = null;
  for (let i = 0; i < 300 && !clipped; i++) {
    clipped = page.entries.find((e) => e.kind === 'tool_result' && e.truncated && e.fullBytes >= 200000);
    if (clipped || !page.cursor.hasMore) break;
    page = (await get(`/api/shells/${shellId}/transcript?before=${cursor}`)).body;
    cursor = page.cursor.before;
  }
  assert.ok(clipped, 'the 200KB tool result was never found');
  assert.ok(clipped.output.length < 20000, 'it should be clipped, not shipped whole');
  assert.strictEqual(clipped.fullBytes, 200000, 'the reader must be told what is missing');
});

test('slash-command machinery is kept and flagged, bookkeeping is dropped', async () => {
  let page = (await get(`/api/shells/${shellId}/transcript`)).body;
  let cursor = page.cursor.before;
  let machinery = 0;
  const totals = { dropped: 0 };
  for (let i = 0; i < 300; i++) {
    machinery += page.entries.filter((e) => e.metaReason === 'machinery').length;
    totals.dropped += page.stats.dropped;
    // attachment/mode records must never become entries.
    assert.ok(!page.entries.some((e) => e.kind === 'attachment'));
    if (!page.cursor.hasMore) break;
    page = (await get(`/api/shells/${shellId}/transcript?before=${cursor}`)).body;
    cursor = page.cursor.before;
  }
  assert.strictEqual(machinery, 8, 'every /deepsteve:merge record should survive, flagged');
  assert.ok(totals.dropped >= TURNS * 2, 'the attachment/mode bookkeeping should be dropped');
});

test('jumping to the beginning is one request, not a walk', async () => {
  // The point of a byte cursor: the first record of a large transcript is as
  // cheap to reach as the last.
  const { status, body, ms } = await get(`/api/shells/${shellId}/transcript?after=0`);
  assert.strictEqual(status, 200);
  assert.ok(ms < 250, `jump to start took ${ms}ms`);
  const first = body.entries.find((e) => e.kind === 'text');
  assert.strictEqual(first.text, 'question number 0');
});

test('tailing picks up an append, and costs nothing when idle', async () => {
  const before = (await get(`/api/shells/${shellId}/transcript`)).body;
  const size = before.file.size;

  const idle = await get(`/api/shells/${shellId}/transcript?after=${size}`);
  assert.deepStrictEqual(idle.body.entries, []);
  assert.strictEqual(idle.body.cursor.after, size);
  assert.ok(idle.ms < 100, `an idle tail poll took ${idle.ms}ms — it should be one stat`);

  fs.appendFileSync(transcriptFile, JSON.stringify({
    type: 'assistant', uuid: 'later', sessionId: claudeId,
    message: { id: 'msg-later', role: 'assistant', content: [{ type: 'text', text: 'one more thing' }] },
  }) + '\n');

  const after = await get(`/api/shells/${shellId}/transcript?after=${size}`);
  assert.strictEqual(after.body.entries.length, 1);
  assert.strictEqual(after.body.entries[0].text, 'one more thing');
  assert.ok(after.body.cursor.after > size, 'the tail cursor must advance past the new record');
});

test('a cursor into bytes that no longer exist is refused, not silently answered', async () => {
  const size = fs.statSync(transcriptFile).size;
  const { status, body } = await get(`/api/shells/${shellId}/transcript?before=${size + 5000}`);
  assert.strictEqual(status, 409);
  assert.strictEqual(body.error, 'transcript-rewound');
});

test('a CLOSED session still serves its transcript', async () => {
  // The case the feature exists for. A live agent's history is one arrow key away
  // inside its own TUI; a closed one's is reachable no other way. Tombstoning
  // never deletes the .jsonl — that file belongs to Claude Code, not to us.
  const res = await fetch(`${BASE}/api/shells/${shellId}/close`, { method: 'POST', headers: authHeaders() });
  assert.ok(res.ok, 'close should succeed');
  await waitFor(async () => {
    const r = await get(`/api/shells/${shellId}/transcript`);
    return r.body && r.body.closed === true;
  }, 'the session to be tombstoned');

  const { status, body } = await get(`/api/shells/${shellId}/transcript`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.closed, true);
  assert.strictEqual(body.live, false, 'a closed session must not be tail-polled');
  assert.ok(body.entries.length > 0, 'a tombstoned session still has its history');
  const answers = body.entries.filter((e) => e.kind === 'text' && /^answer number/.test(e.text || ''));
  assert.ok(answers.length > 0, 'the conversation is still readable after the tab closed');
});
