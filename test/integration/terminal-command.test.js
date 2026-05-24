const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { WsClient, cleanupSessions, BASE_URL } = require('../helpers/ws-client');
const { deriveTabName } = require('../../mods/deepsteve-core/tools');

/**
 * Call the `open_terminal` MCP tool over Streamable HTTP and return the parsed
 * result JSON ({ id, name, cwd, worktree, command }).
 *
 * The `command` feature lives in the MCP handler (not the WS connect path), so
 * exercising it end-to-end requires an actual MCP tools/call. We use the SDK
 * client to handle the initialize handshake and SSE framing.
 */
async function openTerminal(args) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
  const client = new Client({ name: 'terminal-command-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'open_terminal', arguments: args });
    return JSON.parse(res.content[0].text);
  } finally {
    await client.close();
  }
}

describe('open_terminal command parameter', () => {
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

  it('auto-runs the command and stays open at the shell prompt', async () => {
    // A caller session must exist for open_terminal to inherit context from.
    const caller = createClient();
    await caller.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const marker = 'cmd_ran_marker_123';
    const result = await openTerminal({
      session_id: caller.sessionId,
      command: `echo ${marker}`,
      cwd: '/tmp',
    });

    assert.ok(result.id, 'result should include the new tab id');
    assert.strictEqual(result.command, `echo ${marker}`, 'result echoes the command');
    assert.strictEqual(result.name, deriveTabName(`echo ${marker}`), 'tab auto-named from command');

    // Reattach to the new tab to capture its output (scrollback replays).
    const tab = createClient();
    await tab.connect({ id: result.id });
    const output = await tab.waitForOutput(new RegExp(marker), 15000);
    assert.ok(output.includes(marker), 'command output should appear in the tab');
  });

  it('lets an explicit name override the command-derived name', async () => {
    const caller = createClient();
    await caller.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const result = await openTerminal({
      session_id: caller.sessionId,
      command: 'echo hi',
      name: 'my-custom-tab',
      cwd: '/tmp',
    });
    assert.strictEqual(result.name, 'my-custom-tab');
  });

  it('treats an empty/whitespace command as a no-op (bare shell, no derived name)', async () => {
    const caller = createClient();
    await caller.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const result = await openTerminal({
      session_id: caller.sessionId,
      command: '   ',
      cwd: '/tmp',
    });
    assert.strictEqual(result.command, null, 'no command recorded');
    // With no name and no command, the result name falls back to the id.
    assert.strictEqual(result.name, result.id, 'no name derived from a blank command');
  });
});

describe('deriveTabName', () => {
  it('returns short commands unchanged', () => {
    assert.strictEqual(deriveTabName('npm run dev'), 'npm run dev');
  });

  it('collapses internal whitespace', () => {
    assert.strictEqual(deriveTabName('echo   a\n  b'), 'echo a b');
  });

  it('truncates long commands to 24 chars with an ellipsis', () => {
    const out = deriveTabName('a'.repeat(50));
    assert.strictEqual(out.length, 24);
    assert.ok(out.endsWith('…'));
  });
});
