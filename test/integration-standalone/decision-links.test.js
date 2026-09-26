/**
 * Decision links end to end (#705): a real daemon, a real MCP client, real PTYs.
 *
 * test/unit/links.test.js pins every branch of the /v1 scheme and
 * test/unit/inbox-decision-links.test.js drives Inbox's provider through it with a fake
 * ctx. What neither can prove is the part that only exists in a running daemon:
 *
 *   1. the routes are mounted where the auth gate covers them, and the page's script and
 *      stylesheet are really served;
 *   2. a click from webmail — no cookie — gets the bounce page carrying a fresh cookie, while
 *      every other rejection keeps its text/plain body;
 *   3. the answering POST demands our own Origin even with a valid cookie;
 *   4. with the asking session closed, an option's `then` really spawns a session in the
 *      project, and its prompt — including the instruction to close itself — really reaches
 *      that session's composer;
 *   5. inbox_answers hands the answer back to the asker's own scope, and to nobody else.
 *
 * Own daemon: scratch $HOME, random port, its own tmux server via the scratch HOME (#625), and
 * disposable (#678), so the follow-up's "open the UI" logs a URL instead of opening a browser.
 *
 * Run: TMPDIR=/tmp/ds-test node --test --test-timeout=180000 test/integration-standalone/decision-links.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { TmuxSandbox } = require('../helpers/tmux-sandbox');
const { writeLoginProfile } = require('../helpers/login-profile');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STUB_SRC = path.join(REPO_ROOT, 'test', 'helpers', 'stubs', 'fake-claude-tui.js');

const QUESTION = 'OK to open an issue proposing a new analytics event?';
const THEN = 'File the issue drafted in context, then start_issue it.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tmpRoot, HOME, PORT, BASE, projDir, LOGS, POLICY;
let daemon = null;
let daemonLog = '';
// null until before() has validated one; after() uses `sandbox?.cleanup()` so a before() that
// throws leaves a no-op rather than an unaimed tmux command (#625).
let sandbox = null;
const clients = [];
const mcps = [];

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
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}\n--- daemon log tail ---\n${daemonLog.slice(-2500)}`);
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

/**
 * A request with full control of Host, Cookie and Origin — fetch() cannot set Host, and the
 * canonical host is exactly what a link in an email names.
 */
function raw(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: urlPath,
      headers: {
        Host: `deepsteve.localhost:${PORT}`,
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const cookie = () => `ds_auth_${PORT}=${authToken()}`;
const origin = () => `http://deepsteve.localhost:${PORT}`;
const page = (urlPath) => raw('GET', urlPath, { headers: { Accept: 'text/html', Cookie: cookie() } });
const act = (id, body, headers = {}) => raw('POST', `/v1/decision/${id}`, {
  headers: { Cookie: cookie(), Origin: origin(), ...headers }, body,
});

async function mcpFor(shellId) {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp?shellId=${encodeURIComponent(shellId)}`),
    { requestInit: { headers: { ...authHeaders() } } },
  );
  const client = new McpClient({ name: 'decision-links-test', version: '1.0.0' });
  await client.connect(transport);
  mcps.push(client);
  return client;
}
const toolText = (result) => result.content[0].text;

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // suppress browser auto-open
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
  env.DS_STUB_CONFIG = POLICY;
  env.DS_STUB_LOG_DIR = LOGS;
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
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-links705-')));
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
  for (const m of mcps) { try { await m.close(); } catch {} }
  for (const c of clients) c.close();
  await stopDaemon().catch(() => {});
  if (process.env.DS_KEEP_TMP) { console.log(`[links705] kept scratch tree: ${tmpRoot}`); return; }
  // A SIGTERMed daemon DETACHES its tmux sessions, so the scratch server outlives it and an rm
  // would only unlink the socket. Reap it by name (#625).
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Shared across the ordered tests below: one question, asked once, followed to its answer.
let asker = null;
let askerMcp = null;
let decision = null;

test('the link scheme and Inbox\'s provider are live', async () => {
  await waitFor(() => /registered tool "inbox_answers" from mod "inbox"/.test(daemonLog),
    'the inbox mod to register — look for `failed to load tools from mod "inbox"` below', 20000);
  await waitFor(() => /\[links\] provider "inbox" registered/.test(daemonLog), 'the inbox link provider', 20000);
});

test('inbox_ask from a live session returns a server-minted id and a link on the canonical origin', async () => {
  const c = new Client();
  clients.push(c);
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  asker = s.id;
  await waitFor(() => events(asker).some((e) => e.event === 'boot'), 'the asking session to boot');

  askerMcp = await mcpFor(asker);
  decision = JSON.parse(toolText(await askerMcp.callTool({
    name: 'inbox_ask',
    arguments: {
      question: QUESTION,
      context: 'Drafted in the report: **Track exports**.',
      options: [{ label: 'Yes', detail: 'File it', then: THEN }, { label: 'No' }],
      recommendation: 'Yes',
      durable_days: 2,
    },
  })));
  assert.match(decision.id, UUID_RE);
  assert.strictEqual(decision.url, `http://deepsteve.localhost:${PORT}/v1/decision/${decision.id}`);
});

test('the page renders for a signed-in browser, and its assets are served', async () => {
  const ok = await page(`/v1/decision/${decision.id}`);
  assert.strictEqual(ok.status, 200, ok.text);
  assert.match(ok.headers['content-type'], /text\/html/);
  assert.match(ok.headers['content-security-policy'], /script-src 'self'/);
  assert.strictEqual(ok.headers['cache-control'], 'no-store');
  assert.match(ok.text, /id="decision-data"/);
  assert.match(ok.text, /"status":"open"/);

  for (const asset of ['/mods/inbox/decision-page.js', '/mods/inbox/markdown.js', '/mods/inbox/decision-page.css']) {
    const r = await raw('GET', asset);
    assert.strictEqual(r.status, 200, `${asset} -> ${r.status}`);
  }
  const script = await raw('GET', '/mods/inbox/decision-page.js');
  assert.match(script.headers['content-type'], /javascript/, 'a module script with the wrong MIME type never runs');
});

test('a cookieless click from webmail gets the bounce page; nothing else changes its 401', async () => {
  const bounced = await raw('GET', `/v1/decision/${decision.id}`, { headers: { Accept: 'text/html' } });
  assert.strictEqual(bounced.status, 401);
  assert.match(bounced.headers['content-type'], /text\/html/);
  assert.match(bounced.text, /location\.replace\(location\.href\)/);
  const cookies = [].concat(bounced.headers['set-cookie'] || []);
  assert.ok(cookies.some((c) => c.startsWith(`ds_auth_${PORT}=`)),
    `the bounce must carry the cookie its reload will send; got ${JSON.stringify(cookies)}`);

  const api = await raw('GET', '/api/version', { headers: { Accept: 'text/html' } });
  assert.strictEqual(api.status, 401);
  assert.strictEqual(api.text, 'Unauthorized', 'only link paths bounce');
});

test('the stored item decides the type, and every other address explains itself', async () => {
  const wrong = await page(`/v1/markdown/${decision.id}`);
  assert.strictEqual(wrong.status, 302);
  assert.strictEqual(wrong.headers.location, `/v1/decision/${decision.id}`);

  await askerMcp.callTool({ name: 'inbox_brief', arguments: { headline: 'Nightly report sent' } });
  const inbox = await (await fetch(`${BASE}/api/inbox/items?all=1`, { headers: authHeaders() })).json();
  const brief = inbox.items.find((i) => i.headline === 'Nightly report sent');
  assert.ok(brief, 'the briefing is on the inbox');
  const reserved = await page(`/v1/markdown/${brief.id}`);
  assert.strictEqual(reserved.status, 501);
  assert.match(reserved.text, /Not available yet/);

  const missing = await page('/v1/decision/3f9c2a10-5b7e-4d21-9a8b-0c1d2e3f4a5b');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.text, /cleared out since the link was sent/);
  assert.match((await page(`/v1/spreadsheet/${decision.id}`)).text, /Not a Deep Steve link/);
});

test('answering needs the page\'s own Origin, even with a valid cookie', async () => {
  const noOrigin = await raw('POST', `/v1/decision/${decision.id}`, {
    headers: { Cookie: cookie() }, body: { action: 'answer', optionIndex: 1 },
  });
  assert.strictEqual(noOrigin.status, 403);
  const foreign = await act(decision.id, { action: 'answer', optionIndex: 1 }, { Origin: 'https://mail.example.com' });
  assert.strictEqual(foreign.status, 403);
  assert.match((await page(`/v1/decision/${decision.id}`)).text, /"status":"open"/, 'neither refusal answered anything');
});

test('with the asker closed, the option\'s `then` starts a session in the project that is told to close itself', async () => {
  const del = await fetch(`${BASE}/api/shells/${asker}?force=1`, { method: 'DELETE', headers: authHeaders() });
  assert.strictEqual(del.status, 200);

  const r = await act(decision.id, { action: 'answer', optionIndex: 0, text: 'go ahead' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.deliveredVia, 'then');
  const followUp = r.json.item.followUpSessionId;
  assert.ok(followUp, 'the follow-up session id is recorded on the item');
  assert.notStrictEqual(followUp, asker);

  const spawnLine = daemonLog.split('\n').find((l) => l.includes(`[spawn] inbox then: id=${followUp} `));
  assert.ok(spawnLine, 'the spawn was logged');
  assert.ok(spawnLine.endsWith(`cwd=${projDir}`), `spawned in the project root: ${spawnLine}`);

  await waitFor(() => events(followUp).some((e) => e.event === 'boot'), 'the follow-up session to boot', 30000);
  const submitted = await waitFor(() => {
    const text = events(followUp).filter((e) => e.event === 'submit').map((e) => e.text).join('\n');
    return text.includes('mcp__deepsteve__close_session') ? text : null;
  }, 'the whole follow-up prompt to reach its composer and be submitted', 120000, 300);
  assert.ok(submitted.includes(QUESTION), 'the new session is told what was asked');
  assert.ok(submitted.includes('Their note: go ahead'), 'and what the human added');
  assert.ok(submitted.includes(THEN), 'and what to do');
  assert.ok(submitted.indexOf('mcp__deepsteve__close_session') > submitted.indexOf(THEN),
    'and, last, to close itself rather than dangle');
});

test('an item is answered once, and inbox_answers reads it back only in the asker\'s scope', async () => {
  const again = await act(decision.id, { action: 'answer', optionIndex: 1 });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.error, 'not-open');

  // The asker's session is closed, but its own id still scopes the read.
  const rows = JSON.parse(toolText(await askerMcp.callTool({ name: 'inbox_answers', arguments: {} })));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, decision.id);
  assert.deepStrictEqual(rows[0].answer, { optionLabel: 'Yes', text: 'go ahead' });
  assert.strictEqual(rows[0].deliveredVia, 'then');

  const stranger = await mcpFor('not-the-asker');
  const none = JSON.parse(toolText(await stranger.callTool({ name: 'inbox_answers', arguments: {} })));
  assert.deepStrictEqual(none, [], 'another caller cannot read the asker\'s answers');
});

test('Discuss on the closed asker asks a window to restore it', async () => {
  const r = await act(decision.id, { action: 'discuss' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.opened, 'restored');
  assert.strictEqual(r.json.sessionId, asker);
  assert.strictEqual(r.json.tabDelivery, 'queued', 'no browser is connected, so it waits for one');
});

test('a line a person submits in the asking tab supersedes its question, and the link stops offering the then (#710)', async () => {
  // The unit tests call Inbox's observer directly. This is the part only a daemon has: a
  // person's Enter arriving on the session WebSocket, server.js recognising it as a submit key
  // and handing it to the observer the mod registered, before the key reaches the PTY.
  const c = new Client();
  clients.push(c);
  const s = await c.connect({ cwd: projDir, new: '1', agentType: 'claude' });
  await waitFor(() => events(s.id).some((e) => e.event === 'boot'), 'the asking session to boot');

  const mcp = await mcpFor(s.id);
  const asked = JSON.parse(toolText(await mcp.callTool({
    name: 'inbox_ask',
    arguments: {
      question: 'Send the report as CSV?',
      options: [{ label: 'Yes', then: 'Send the CSV report.' }, { label: 'No' }],
      durable_days: 2,
    },
  })));
  const listed = async () => {
    const all = await (await fetch(`${BASE}/api/inbox/items?all=1`, { headers: authHeaders() })).json();
    return all.items.find((i) => i.id === asked.id);
  };
  assert.strictEqual((await listed()).status, 'open');

  // Typed the way xterm sends it: the characters, then Enter as its own payload.
  c.ws.send('no, send JSON instead');
  await waitFor(
    () => readJsonl(path.join(LOGS, `${s.id}.stdin.jsonl`)).some((e) => (e.text || '').includes('send JSON')),
    'the typed characters to reach the session',
  );
  c.ws.send('\r');
  await waitFor(
    () => events(s.id).some((e) => e.event === 'submit' && e.text.includes('send JSON')),
    'the reply to be submitted to the agent, like any line typed in a tab',
  );

  const item = await waitFor(async () => {
    const it = await listed();
    return it && it.status === 'dismissed' ? it : null;
  }, 'the question to be superseded by the reply in its tab');
  assert.strictEqual(item.dismissedReason, 'superseded');
  assert.strictEqual(item.supersededBy.rule, 'tab-reply');
  assert.match(item.closedNote, /replied in the asking session/);
  assert.match(daemonLog, new RegExp(`\\[inbox\\] superseded ${asked.id} rule=tab-reply`));
  // Written through serializeShellEntry, so a restart or the session closing keeps it.
  const state = JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'state.json'), 'utf8'));
  assert.strictEqual(state[s.id].lastHumanInputAt, item.supersededBy.at, 'the stamp is persisted with the session');

  const shown = await page(`/v1/decision/${asked.id}`);
  assert.match(shown.text, /"supersededBy":\{"rule":"tab-reply"/, 'the page is handed why');
  const r = await act(asked.id, { action: 'answer', optionIndex: 0 });
  assert.strictEqual(r.status, 409, r.text);
  assert.strictEqual(r.json.error, 'superseded');
  assert.ok(!daemonLog.includes(`inbox then ${asked.id}`), 'the option\'s then never ran');
});
