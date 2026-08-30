const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { WsClient, httpGet, httpPost, httpDelete, cleanupSessions } = require('../helpers/ws-client');
// Never os.tmpdir() for a path handed to the server — it is not necessarily our filesystem (#637).
const { makeServerDir, reserveMissingServerPath, removeServerDir } = require('../helpers/server-dir');

describe('Session Lifecycle', () => {
  const clients = [];
  function createClient() {
    const c = new WsClient();
    clients.push(c);
    return c;
  }

  afterEach(async () => {
    await cleanupSessions(clients);
    clients.length = 0;
  });

  it('creates a terminal session via WebSocket', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });
    assert.strictEqual(session.type, 'session');
    assert.ok(session.id, 'session should have an id');
    assert.strictEqual(session.agentType, 'terminal');
  });

  it('can send a command and receive output', async () => {
    const client = createClient();
    await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Wait for shell prompt
    await client.waitForOutput(/[#$%>]/, 10000);
    client.rawOutput = '';

    client.sendInput('echo hello_test_123\r');
    const output = await client.waitForOutput(/hello_test_123/, 10000);
    assert.ok(output.includes('hello_test_123'));
  });

  it('does not leak daemon-internal env (PORT/NODE_ENV) into spawned shells (#517)', async () => {
    const client = createClient();
    await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await client.waitForOutput(/[#$%>]/, 10000);
    client.rawOutput = '';

    // The terminal echoes the typed command too, so the literal `[$PORT]` appears
    // in the output. We only want the EXECUTED result line, where the brackets hold
    // expanded values and therefore contain no `$` — `[^$\]]*` matches that line
    // only. On a leak the brackets hold `3000`/`production`; clean, they're empty.
    client.sendInput('echo "PORTCHECK[$PORT][$NODE_ENV]KCEHCTROP"\r');
    const out = await client.waitForOutput(/PORTCHECK\[[^$\]]*\]\[[^$\]]*\]KCEHCTROP/, 10000);
    const m = out.match(/PORTCHECK\[([^$\]]*)\]\[([^$\]]*)\]KCEHCTROP/);
    assert.ok(m, `result line not found in output: ${out}`);
    assert.strictEqual(m[1], '', `daemon PORT leaked into agent shell: "${m[1]}"`);
    assert.strictEqual(m[2], '', `daemon NODE_ENV leaked into agent shell: "${m[2]}"`);
  });

  it('session appears in GET /api/shells', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const data = await httpGet('/api/shells');
    const found = data.shells.find(s => s.id === session.id);
    assert.ok(found, 'session should appear in shells list');
    assert.strictEqual(found.agentType, 'terminal');
    assert.strictEqual(found.status, 'active');
  });

  it('supports multiple concurrent sessions', async () => {
    const client1 = createClient();
    const client2 = createClient();
    const s1 = await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });
    const s2 = await client2.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    assert.notStrictEqual(s1.id, s2.id, 'sessions should have different IDs');

    const data = await httpGet('/api/shells');
    const activeIds = data.shells.filter(s => s.status === 'active').map(s => s.id);
    assert.ok(activeIds.includes(s1.id), 'first session in list');
    assert.ok(activeIds.includes(s2.id), 'second session in list');
  });

  it('DELETE /api/shells/:id kills a session but leaves a closed tombstone (#561)', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const result = await httpDelete(`/api/shells/${session.id}?force=1`);
    assert.strictEqual(result.killed, session.id);

    await new Promise(r => setTimeout(r, 500));
    const data = await httpGet('/api/shells');
    const active = data.shells.filter(s => s.id === session.id && s.status === 'active');
    assert.strictEqual(active.length, 0, 'session should no longer be active');
    const tombstone = data.shells.find(s => s.id === session.id && s.status === 'closed');
    assert.ok(tombstone, 'session should remain as a closed tombstone');
    assert.ok(tombstone.closedAt, 'tombstone should carry a closedAt timestamp');
  });

  it('DELETE on a closed session is idempotent; ?forget=1 permanently removes (#561)', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await httpDelete(`/api/shells/${session.id}?force=1`);
    await new Promise(r => setTimeout(r, 500));

    // Second DELETE without forget: no-op, tombstone survives
    const second = await httpDelete(`/api/shells/${session.id}`);
    assert.strictEqual(second.tombstone, true, 'repeat DELETE should report the tombstone');
    let data = await httpGet('/api/shells');
    assert.ok(data.shells.find(s => s.id === session.id && s.status === 'closed'),
      'tombstone should survive a repeated DELETE');

    // Explicit forget: permanently removed
    const forgotten = await httpDelete(`/api/shells/${session.id}?forget=1`);
    assert.strictEqual(forgotten.status, 'forgotten');
    data = await httpGet('/api/shells');
    assert.strictEqual(data.shells.filter(s => s.id === session.id).length, 0,
      'forgotten session should be gone entirely');
  });

  // NOTE: this is the one test that exercises the GLOBAL killall endpoint and
  // asserts the server has zero active sessions afterward. It is inherently
  // hostile to concurrency — both its action (kill everything) and its assertion
  // (nothing left) are server-wide — so it requires the suite to run serially
  // (see test/run-integration.sh). Per-session cleanup elsewhere keeps the rest
  // of the suite from cross-contaminating; this test is the deliberate exception.
  it('POST /api/shells/killall removes all active sessions', async () => {
    const client1 = createClient();
    const client2 = createClient();
    const s1 = await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });
    const s2 = await client2.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Verify both are active before killall
    const before = await httpGet('/api/shells');
    const activeBefore = before.shells.filter(s => s.status === 'active');
    assert.ok(activeBefore.length >= 2, 'should have at least 2 active sessions');

    await httpPost('/api/shells/killall');

    await new Promise(r => setTimeout(r, 500));
    const after = await httpGet('/api/shells');
    const activeAfter = after.shells.filter(s => s.status === 'active');
    assert.strictEqual(activeAfter.length, 0, 'no active sessions after killall');

    // #561: killall must tombstone, never hard-delete — each killed session
    // stays restorable as a closed entry.
    for (const id of [s1.id, s2.id]) {
      const tombstone = after.shells.find(s => s.id === id && s.status === 'closed');
      assert.ok(tombstone, `killall should leave a closed tombstone for ${id}`);
    }
  });

  it('session exits naturally when shell exits', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Wait for shell prompt
    await client.waitForOutput(/[#$%>]/, 10000);

    // Send exit command
    client.sendInput('exit\r');

    // Wait for close-tab message (server sends this when shell process exits)
    const msg = await client.waitForMessage('close-tab', 10000);
    assert.ok(msg, 'should receive close-tab message');

    await new Promise(r => setTimeout(r, 500));
    const data = await httpGet('/api/shells');
    const active = data.shells.filter(s => s.id === session.id && s.status === 'active');
    assert.strictEqual(active.length, 0, 'session should be gone after exit');
    // #561: even a natural exit leaves a restorable closed tombstone.
    assert.ok(data.shells.find(s => s.id === session.id && s.status === 'closed'),
      'natural exit should leave a closed tombstone');
  });

  it('can run a command and verify working directory', async () => {
    const client = createClient();
    await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await client.waitForOutput(/[#$%>]/, 10000);
    client.rawOutput = '';

    // Use pwd directly — more reliable than echo in PTY environments
    client.sendInput('pwd\r');
    const output = await client.waitForOutput(/\/tmp/, 10000);
    assert.ok(output.includes('/tmp'), 'shell should start in /tmp');
  });

  // --- #632: a cwd that no longer exists ---------------------------------
  //
  // Deliberately NOT engine-pinned: the refusal happens before any engine is
  // touched, so it must hold under the default (tmux) too. agentType 'terminal'
  // throughout, so no agent binary is needed.

  it('refuses a new session in a directory that does not exist (#632)', async () => {
    const gone = reserveMissingServerPath('ds-632-new-');

    const client = createClient();
    const msg = await client.connect({ new: '1', agentType: 'terminal', cwd: gone });

    assert.strictEqual(msg.type, 'error', 'a missing cwd must be refused, not relocated to $HOME');
    assert.strictEqual(msg.code, 'cwd-missing');
    assert.ok(msg.message.includes(gone), `the refusal must name the missing path, got: ${msg.message}`);

    const data = await httpGet('/api/shells');
    assert.ok(!data.shells.some(s => s.cwd === gone && s.status === 'active'),
      'nothing may be left running for a refused spawn');
  });

  it('a refused restore keeps the saved record — retryable, not destroyed (#632)', async () => {
    // Must be a directory the SERVER can see, not merely one this process can (#637) —
    // in CI those are two containers, and since #632 a cwd the server cannot see is refused.
    const dir = makeServerDir('ds-632-restore-');
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: dir });
    assert.strictEqual(session.type, 'session', 'the directory exists, so this must start normally');
    const id = session.id;

    // Tombstone it, then pull the directory out from under the record — the shape
    // this issue is really about (a merged worktree, a deleted repo).
    client.close();
    await new Promise(r => setTimeout(r, 300));
    await httpDelete(`/api/shells/${id}?force=1`);
    removeServerDir(dir);

    // An explicit restore: no noRestore, so this is the real restore path.
    const restorer = createClient();
    const msg = await restorer.connect({ id });
    assert.strictEqual(msg.type, 'error', 'restoring into a deleted directory must be refused');
    assert.strictEqual(msg.code, 'cwd-missing');
    assert.ok(msg.message.includes(dir), `the refusal must name the missing path, got: ${msg.message}`);

    // The whole point of refusing this way: the tombstone survived, so the
    // conversation is still resurrectable if the directory comes back.
    // #658: the closed bucket is opt-in — the window picker never draws it, so the
    // default answer withholds it rather than paying a transcript read per row.
    const recoverable = await httpGet('/api/recoverable-sessions?include=closed');
    const row = (recoverable.closed || []).find(s => s.id === id);
    assert.ok(row, 'a refused restore must NOT purge the saved record');
    assert.strictEqual(row.cwdMissing, true, 'and the restore surface must flag why');

    await httpDelete(`/api/shells/${id}?forget=1`);
  });
});
