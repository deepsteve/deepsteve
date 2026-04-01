const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { WsClient, httpGet, httpPost, httpDelete, cleanupSessions } = require('../helpers/ws-client');

describe('Tmux Engine', () => {
  const clients = [];
  function createClient() {
    const c = new WsClient();
    clients.push(c);
    return c;
  }

  before(async () => {
    // Ensure no active sessions before switching engine
    await httpPost('/api/shells/killall').catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    const result = await httpPost('/api/settings', {
      engine: 'tmux',
      engineSwitchConfirm: true,
    });
    assert.strictEqual(result.engine, 'tmux', 'engine should be tmux after switch');
  });

  after(async () => {
    await cleanupSessions(clients);
    clients.length = 0;

    // Switch back to node-pty so subsequent test files are unaffected
    await httpPost('/api/shells/killall').catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    await httpPost('/api/settings', {
      engine: 'node-pty',
      engineSwitchConfirm: true,
    });
  });

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

    await client.waitForOutput(/[#$%>]/, 15000);
    client.rawOutput = '';

    client.sendInput('echo hello_tmux_123\r');
    const output = await client.waitForOutput(/hello_tmux_123/, 10000);
    assert.ok(output.includes('hello_tmux_123'));
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

  it('session exits naturally when shell exits', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await client.waitForOutput(/[#$%>]/, 15000);

    client.sendInput('exit\r');

    const msg = await client.waitForMessage('close-tab', 10000);
    assert.ok(msg, 'should receive close-tab message');

    await new Promise(r => setTimeout(r, 500));
    const data = await httpGet('/api/shells');
    const active = data.shells.filter(s => s.id === session.id && s.status === 'active');
    assert.strictEqual(active.length, 0, 'session should be gone after exit');
  });

  it('reconnect to existing session receives scrollback', async () => {
    const client1 = createClient();
    const session = await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await client1.waitForOutput(/[#$%>]/, 15000);
    client1.rawOutput = '';

    client1.sendInput('echo TMUX_SCROLLBACK_42\r');
    await client1.waitForOutput(/TMUX_SCROLLBACK_42/, 10000);

    const client2 = createClient();
    const session2 = await client2.connect({ id: session.id });
    assert.strictEqual(session2.id, session.id, 'should connect to same session');
    assert.strictEqual(session2.scrollback, true, 'should indicate scrollback available');

    await new Promise(r => setTimeout(r, 2000));
    assert.ok(client2.rawOutput.includes('TMUX_SCROLLBACK_42'), 'scrollback should contain previous output');
  });

  it('resize works under tmux', async () => {
    const client = createClient();
    await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await client.waitForOutput(/[#$%>]/, 15000);

    client.send({ type: 'resize', cols: 80, rows: 24 });

    client.rawOutput = '';
    client.sendInput('echo TMUX_RESIZE_OK\r');
    await client.waitForOutput(/TMUX_RESIZE_OK/, 10000);
  });

  it('can verify working directory', async () => {
    const client = createClient();
    await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    await client.waitForOutput(/[#$%>]/, 15000);
    client.rawOutput = '';

    client.sendInput('pwd\r');
    const output = await client.waitForOutput(/\/tmp/, 10000);
    assert.ok(output.includes('/tmp'), 'shell should start in /tmp');
  });

  it('POST /api/shells/killall removes all tmux sessions', async () => {
    const client1 = createClient();
    const client2 = createClient();
    await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });
    await client2.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const before = await httpGet('/api/shells');
    const activeBefore = before.shells.filter(s => s.status === 'active');
    assert.ok(activeBefore.length >= 2, 'should have at least 2 active sessions');

    await httpPost('/api/shells/killall');

    await new Promise(r => setTimeout(r, 500));
    const afterData = await httpGet('/api/shells');
    const activeAfter = afterData.shells.filter(s => s.status === 'active');
    assert.strictEqual(activeAfter.length, 0, 'no active sessions after killall');
  });
});
