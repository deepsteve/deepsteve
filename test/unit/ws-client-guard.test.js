/**
 * #562 safety-guard tests for test/helpers/ws-client.js.
 *
 * The helper must be impossible to point at a production daemon by accident:
 *  - importing it without DEEPSTEVE_URL throws (no localhost:3000 fallback), and
 *  - destructive helpers refuse any target whose GET /api/version does not report
 *    testMode:true — BEFORE sending the destructive request.
 *
 * Each case runs the helper in a child node process (the URL check happens at
 * module load, and the child must not inherit this process's DEEPSTEVE_* env or
 * real HOME — a scratch HOME guarantees the dev's real auth token is never read).
 * The "server" is an in-test http stub that records every request it receives;
 * "the stub saw no POST" is the load-bearing assertion.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HELPER = path.join(REPO_ROOT, 'test', 'helpers', 'ws-client.js');

// Child env: inherit PATH etc., but drop all DEEPSTEVE_* and point HOME at a
// scratch dir so readAuthToken() can never pick up the developer's real token.
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-guard-'));
  return { ...env, ...extra };
}

// cwd must be the repo root so the helper's require('ws') resolves.
function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Minimal target stub: answers GET /api/version with the given body, everything
// else with {ok:true}, and records every request.
function startStub(versionBody) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.method === 'GET' && req.url === '/api/version' ? versionBody : { ok: true }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// Exits 0 if the destructive call went through, 42 if the helper refused it.
const KILLALL_SCRIPT = `
  const h = require(${JSON.stringify(HELPER)});
  h.httpPost('/api/shells/killall', {}).then(
    () => process.exit(0),
    (e) => { console.error(e.message); process.exit(42); }
  );
`;

test('importing the helper without DEEPSTEVE_URL throws with guidance (no fallback)', async () => {
  const { code, stderr } = await runNode(`require(${JSON.stringify(HELPER)});`, childEnv());
  assert.notStrictEqual(code, 0, 'import must fail without DEEPSTEVE_URL');
  assert.match(stderr, /DEEPSTEVE_URL/, 'error must name the missing variable');
  assert.match(stderr, /npm test|run-integration/, 'error must point at the provisioning path');
});

test('refuses a target whose /api/version has no testMode field (pre-#562 / unknown server) — nothing sent', async () => {
  const stub = await startStub({ current: '9.9.9' });
  try {
    const { code, stderr } = await runNode(KILLALL_SCRIPT, childEnv({ DEEPSTEVE_URL: stub.url }));
    assert.strictEqual(code, 42, `expected refusal exit, got ${code}: ${stderr}`);
    assert.match(stderr, /REFUSING/, 'refusal must be loud and explain itself');
    assert.strictEqual(stub.requests.filter(r => r.method === 'POST').length, 0,
      'the destructive POST must never reach the wire');
  } finally {
    await stub.close();
  }
});

test('refuses a target reporting testMode:false (a live daemon) — nothing sent', async () => {
  const stub = await startStub({ current: '9.9.9', testMode: false });
  try {
    const { code, stderr } = await runNode(KILLALL_SCRIPT, childEnv({ DEEPSTEVE_URL: stub.url }));
    assert.strictEqual(code, 42, `expected refusal exit, got ${code}: ${stderr}`);
    assert.match(stderr, /REFUSING/);
    assert.strictEqual(stub.requests.filter(r => r.method === 'POST').length, 0,
      'the destructive POST must never reach the wire');
  } finally {
    await stub.close();
  }
});

test('allows a target reporting testMode:true (verifies once, then sends)', async () => {
  const stub = await startStub({ current: '9.9.9', testMode: true });
  try {
    const { code, stderr } = await runNode(KILLALL_SCRIPT, childEnv({ DEEPSTEVE_URL: stub.url }));
    assert.strictEqual(code, 0, `expected success, got ${code}: ${stderr}`);
    assert.deepStrictEqual(
      stub.requests.map(r => `${r.method} ${r.url}`),
      ['GET /api/version', 'POST /api/shells/killall'],
      'exactly one verification GET, then the POST'
    );
  } finally {
    await stub.close();
  }
});
