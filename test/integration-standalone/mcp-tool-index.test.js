/**
 * GET /api/mods must report the tools that are actually registered (#644).
 *
 * Every mod.json used to carry a `tools` array that nothing read and nothing validated,
 * so it drifted: 48 names declared across 15 manifests against 55 really registered.
 * #644 deleted the array and made the inventory DERIVED — mcp-server.js indexes what each
 * mod's tools.js init() returns, and /api/mods reports that index.
 *
 * The unit guard (test/unit/mod-tools-source.test.js) proves no manifest declares tools
 * and that the wiring is spelled right. It cannot prove the derived list is CORRECT,
 * because that needs every mods/*\/tools.js init() to really run — and two of them have
 * side effects a unit test must not trigger (mods/scheduled-tasks starts a setInterval
 * scheduler and writes under stateDir()). So the equality is asserted here, against a
 * live daemon, by comparing GET /api/mods to the MCP server's own tools/list. This is the
 * assertion that would have caught the original 48-vs-55 gap.
 *
 * Own daemon: scratch $HOME, random port. No session is ever created, so no agent stub is
 * needed — but the tmux sandbox is still anchored on the scratch HOME, because startup
 * reattach runs tmux whenever the binary merely exists.
 *
 * Run one file by hand with a SHORT TMPDIR (a tmux socket lives under $HOME):
 *   TMPDIR=/tmp/ds-test node --test test/integration-standalone/mcp-tool-index.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { TmuxSandbox } = require('../helpers/tmux-sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let tmpRoot, HOME, PORT, BASE;
let daemon = null;
let daemonLog = '';
let sandbox = null;
let mcp = null;

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

async function startDaemon() {
  sandbox = TmuxSandbox.forHome(HOME);
  const env = { ...process.env, HOME, PORT: String(PORT) };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];

  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // suppress browser auto-open
  env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;

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

async function mcpConnect() {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  // /api/version answers as soon as HTTP is listening, but /mcp is not mounted until
  // every mod has loaded — which is the same await that leaves mcpReady false.
  await waitFor(async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
    return r.status !== 404;
  }, 'the /mcp endpoint to be mounted');

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { ...authHeaders() } },
  });
  mcp = new McpClient({ name: 'mcp-tool-index-test', version: '1.0.0' });
  await mcp.connect(transport);
}

/** The mod rows of GET /api/mods — skills ride the same array but are not mods. */
async function modRows() {
  const r = await fetch(`${BASE}/api/mods`, { headers: authHeaders() });
  assert.ok(r.ok, `GET /api/mods -> ${r.status}`);
  const body = await r.json();
  return { body, mods: body.mods.filter((m) => m.type !== 'skill') };
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-644-'));
  HOME = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  await startDaemon();
  await mcpConnect();
});

after(async () => {
  try { if (mcp) await mcp.close(); } catch {}
  await stopDaemon().catch(() => {});
  try { sandbox?.cleanup(); } catch (e) { console.error(e.message); }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('the daemon really registered tools and really listed mods', async () => {
  // Non-vacuity. Every assertion below compares two sets; two EMPTY sets are equal, so
  // without this a daemon that loaded no mods at all would pass the whole file.
  const { tools } = await mcp.listTools();
  assert.ok(tools.length >= 40,
    `expected the real tool set over MCP; got ${tools.length}. ${daemonLog.slice(-2000)}`);
  const { mods } = await modRows();
  assert.ok(mods.length >= 15, `expected the repo's mods over /api/mods; got ${mods.length}`);
});

test('mcpReady is true once the scan has finished (#644)', async () => {
  const { body } = await modRows();
  assert.strictEqual(body.mcpReady, true,
    'mcpReady tells a consumer "this mod registers no tools" apart from "nothing has ' +
    'been scanned yet" — the window while initMCP awaits the ESM-only SDK import');
});

test('every mod reports a tools array, empty when it has no tools.js (#644)', async () => {
  const { mods } = await modRows();
  for (const m of mods) {
    assert.ok(Array.isArray(m.tools),
      `mod "${m.id}" has no tools array. The field is always present and always derived ` +
      '— a ragged shape is what let the manifest copy hide missing entries (#644).');
  }
  // The seven mods with no tools.js must say [] rather than omit the key. steveonardo is
  // the pointed case: it used to DECLARE "tools": [] while shipping no tools.js at all.
  const steve = mods.find((m) => m.id === 'steveonardo');
  assert.ok(steve, 'the steveonardo mod should be present');
  assert.deepStrictEqual(steve.tools, [], 'a mod with no tools.js reports []');
});

test('the derived names are exactly the registered names (#644)', async () => {
  const { tools } = await mcp.listTools();
  const { mods } = await modRows();

  const registered = new Set(tools.map((t) => t.name));
  const derived = new Set(mods.flatMap((m) => m.tools.map((t) => t.name)));

  const missing = [...registered].filter((n) => !derived.has(n)).sort();
  const extra = [...derived].filter((n) => !registered.has(n)).sort();

  assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
    'GET /api/mods must report exactly the tools MCP registered. `missing` are tools an ' +
    'agent can call that the inventory does not mention — the 48-vs-55 gap #644 fixed; ' +
    '`extra` are tools the inventory claims that no session can reach.');
});

test('the derived descriptions are the ones the model sees, verbatim (#644)', async () => {
  const { tools } = await mcp.listTools();
  const { mods } = await modRows();

  const registered = new Map(tools.map((t) => [t.name, t.description]));
  const mismatched = [];
  for (const m of mods) {
    for (const t of m.tools) {
      if (registered.get(t.name) !== t.description) mismatched.push(`${m.id}/${t.name}`);
    }
  }
  assert.deepStrictEqual(mismatched, [],
    'a derived description must be the exact text handed to server.tool(). The manifests ' +
    'used to carry a second, independently-written wording per tool — a paraphrase that ' +
    'nothing could ever detect going stale (#644).');
});

test('a tool name belongs to exactly one mod (#644)', async () => {
  const { mods } = await modRows();
  const owner = new Map();
  const collisions = [];
  for (const m of mods) {
    for (const t of m.tools) {
      if (owner.has(t.name)) collisions.push(`${t.name}: ${owner.get(t.name)} and ${m.id}`);
      owner.set(t.name, m.id);
    }
  }
  assert.deepStrictEqual(collisions, [],
    'two mods registering one name means only the later load is reachable over MCP, and ' +
    'mods load in readdir order — so which one is live is not stable. mcp-server.js logs ' +
    'a warning; this fails the suite (#644).');
});

test('a derived entry carries name and description and nothing else (#644)', async () => {
  const { mods } = await modRows();
  const rogue = [];
  for (const m of mods) {
    for (const t of m.tools) {
      const keys = Object.keys(t).sort();
      if (keys.join(',') !== 'description,name') rogue.push(`${m.id}/${t.name}: [${keys}]`);
    }
  }
  assert.deepStrictEqual(rogue, [],
    'the /api/mods tool entry contract is {name, description}. The Zod schema and the ' +
    'handler are not serialisable and must not leak into the response (#644).');
});
