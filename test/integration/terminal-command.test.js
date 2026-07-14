const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { WsClient, cleanupSessions, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');
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
  // Bearer auth (#536): agents reach /mcp with the token in a header; mirror that here.
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  const client = new Client({ name: 'terminal-command-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'open_terminal', arguments: args });
    const text = res.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      // open_terminal returns a plain-text message (not JSON) on failure, e.g.
      // `Session "<id>" not found.` Surface it directly instead of as a cryptic
      // "Unexpected token" JSON parse error.
      throw new Error(`open_terminal did not return JSON: ${text}`);
    }
  } finally {
    await client.close();
  }
}

describe('open_terminal command parameter', () => {
  const clients = [];
  // Tabs open_terminal spawns get no WsClient, so they aren't covered by
  // `clients`. Record their ids here so afterEach's per-session cleanup deletes
  // them instead of leaking them onto the shared server.
  const spawnedIds = [];
  function createClient() {
    const c = new WsClient();
    clients.push(c);
    return c;
  }
  // Wrapper around openTerminal that records the spawned tab id for cleanup.
  async function spawnTerminal(args) {
    const result = await openTerminal(args);
    if (result && result.id) spawnedIds.push(result.id);
    return result;
  }

  afterEach(async () => {
    await cleanupSessions(clients, spawnedIds);
    clients.length = 0;
    spawnedIds.length = 0;
  });

  it('auto-runs the command and stays open at the shell prompt', async () => {
    // A caller session must exist for open_terminal to inherit context from.
    const caller = createClient();
    await caller.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });

    const marker = 'cmd_ran_marker_123';
    const result = await spawnTerminal({
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

    const result = await spawnTerminal({
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

    const result = await spawnTerminal({
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
