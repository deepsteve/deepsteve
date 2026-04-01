const { describe, it, afterEach, before } = require('node:test');
const assert = require('node:assert');
const { WsClient, httpGet, httpPost, cleanupSessions } = require('../helpers/ws-client');

describe('WebSocket Protocol', () => {
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

  it('reconnect to existing session receives scrollback', async () => {
    const client1 = createClient();
    const session = await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Wait for shell prompt to appear
    await client1.waitForOutput(/[#$%>]/, 10000);
    client1.rawOutput = '';

    // Send command and wait for output
    client1.sendInput('echo SCROLLBACK_MARKER_42\r');
    await client1.waitForOutput(/SCROLLBACK_MARKER_42/, 10000);

    // Connect a second client to the same session
    const client2 = createClient();
    const session2 = await client2.connect({ id: session.id });
    assert.strictEqual(session2.id, session.id, 'should connect to same session');
    assert.strictEqual(session2.scrollback, true, 'should indicate scrollback available');

    // Wait for scrollback replay
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(client2.rawOutput.includes('SCROLLBACK_MARKER_42'), 'scrollback should contain previous output');
  });

  it('resize message does not cause errors', async () => {
    const client = createClient();
    await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Wait for shell to be ready
    await client.waitForOutput(/[#$%>]/, 10000);

    // Send resize — should not error or crash the session
    client.send({ type: 'resize', cols: 80, rows: 24 });

    // Verify the session still works by running a command
    client.rawOutput = '';
    client.sendInput('echo RESIZE_OK\r');
    await client.waitForOutput(/RESIZE_OK/, 10000);
  });

  it('rename message updates session name', async () => {
    const client = createClient();
    const session = await client.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    // Wait for shell to be fully ready before renaming
    await client.waitForOutput(/[#$%>]/, 10000);

    client.send({ type: 'rename', name: 'test-tab-name' });
    await new Promise(r => setTimeout(r, 500));

    const data = await httpGet('/api/shells');
    const found = data.shells.find(s => s.id === session.id && s.status === 'active');
    assert.ok(found, `session ${session.id} should be active`);
    assert.strictEqual(found.name, 'test-tab-name');
  });

  it('connecting with non-existent ID returns gone', async () => {
    const client = createClient();
    const msg = await client.connect({ id: 'nonexist' });
    assert.strictEqual(msg.type, 'gone', 'should receive gone message');
  });

  it('multiple clients receive output from same session', async () => {
    const client1 = createClient();
    const session = await client1.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const client2 = createClient();
    await client2.connect({ id: session.id });

    // Wait for both to be connected and shell ready
    await client1.waitForOutput(/[#$%>]/, 10000);
    client1.rawOutput = '';
    client2.rawOutput = '';

    // Send input from client1
    client1.sendInput('echo MULTI_CLIENT_TEST\r');

    // Both clients should receive the output
    await client1.waitForOutput(/MULTI_CLIENT_TEST/, 10000);
    await client2.waitForOutput(/MULTI_CLIENT_TEST/, 10000);
  });
});
