const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { WsClient, httpGet, httpPost, httpDelete, cleanupSessions } = require('../helpers/ws-client');

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

  it('DELETE /api/shells/:id kills a session', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const result = await httpDelete(`/api/shells/${session.id}?force=1`);
    assert.strictEqual(result.killed, session.id);

    await new Promise(r => setTimeout(r, 500));
    const data = await httpGet('/api/shells');
    const active = data.shells.filter(s => s.id === session.id && s.status === 'active');
    assert.strictEqual(active.length, 0, 'session should no longer be active');
  });

  it('POST /api/shells/killall removes all active sessions', async () => {
    const client1 = createClient();
    const client2 = createClient();
    await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });
    await client2.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Verify both are active before killall
    const before = await httpGet('/api/shells');
    const activeBefore = before.shells.filter(s => s.status === 'active');
    assert.ok(activeBefore.length >= 2, 'should have at least 2 active sessions');

    await httpPost('/api/shells/killall');

    await new Promise(r => setTimeout(r, 500));
    const after = await httpGet('/api/shells');
    const activeAfter = after.shells.filter(s => s.status === 'active');
    assert.strictEqual(activeAfter.length, 0, 'no active sessions after killall');
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
});
