/**
 * Integration tests for meta_type / read_session_screen (#519), driven through
 * the real /mcp endpoint with the MCP SDK client against a plain terminal
 * session — the same path an agent takes.
 *
 * Covers: the no-browser consent outcome when Meta Controls is off, truthful
 * landed/screen_tail readback once enabled, control keys (C-c interrupting a
 * running command), read_session_screen, and the state/metaControls fields on
 * GET /api/shells/:id/info.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { WsClient, httpGet, httpPost, cleanupSessions, BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

describe('meta_type via MCP (#519)', () => {
  const term = new WsClient();
  let mcp = null;
  let originalMetaControls = false;

  function parseTool(result) {
    return JSON.parse(result.content[0].text);
  }

  before(async () => {
    originalMetaControls = !!(await httpGet('/api/settings')).metaControlsEnabled;
    await term.connect({ new: '1', agentType: 'terminal', cwd: '/tmp' });
    await term.waitForOutput(/\$|%|#/, 15000); // shell prompt is up

    // MCP SDK is ESM-only — dynamic import from CJS test.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    });
    mcp = new Client({ name: 'meta-type-test', version: '1.0.0' });
    await mcp.connect(transport);
  });

  after(async () => {
    try { if (mcp) await mcp.close(); } catch {}
    await httpPost('/api/settings', { metaControlsEnabled: originalMetaControls });
    await cleanupSessions([term]);
  });

  it('reports no-browser when Meta Controls is off and nobody can approve', async () => {
    await httpPost('/api/settings', { metaControlsEnabled: false });
    const result = await mcp.callTool({
      name: 'meta_type',
      arguments: { session_id: term.sessionId, text: 'echo should-not-run' },
    });
    const text = result.content[0].text;
    assert.match(text, /Meta Controls is disabled/);
    assert.match(text, /No browser window is connected/);
    // The gate stayed off and nothing was typed.
    const settings = await httpGet('/api/settings');
    assert.strictEqual(settings.metaControlsEnabled, false);
    assert.ok(!/should-not-run/.test(term.rawOutput), 'text must not reach the PTY without consent');
  });

  it('types truthfully once Meta Controls is enabled', async () => {
    await httpPost('/api/settings', { metaControlsEnabled: true });
    const result = await mcp.callTool({
      name: 'meta_type',
      arguments: { session_id: term.sessionId, text: 'echo meta-marker-519' },
    });
    const out = parseTool(result);
    assert.strictEqual(out.session_id, term.sessionId);
    assert.strictEqual(out.state_before, 'unknown'); // terminals have no BEL classifier
    assert.strictEqual(out.submitted, true);
    assert.strictEqual(out.landed, true);
    assert.ok(Array.isArray(out.screen_tail) && out.screen_tail.length > 0);
    await term.waitForOutput(/meta-marker-519/, 10000); // command actually ran
  });

  it('read_session_screen shows the session tail and state', async () => {
    const result = await mcp.callTool({
      name: 'read_session_screen',
      arguments: { session_id: term.sessionId, lines: 50 },
    });
    const out = parseTool(result);
    assert.strictEqual(out.state, 'unknown');
    assert.strictEqual(typeof out.seconds_since_output, 'number');
    assert.ok(out.lines.some(l => l.includes('meta-marker-519')), `tail should show the marker, got: ${JSON.stringify(out.lines.slice(-10))}`);
  });

  it('control keys work: C-c interrupts a running command', async () => {
    await mcp.callTool({
      name: 'meta_type',
      arguments: { session_id: term.sessionId, text: 'sleep 300' },
    });
    const interrupt = parseTool(await mcp.callTool({
      name: 'meta_type',
      arguments: { session_id: term.sessionId, keys: ['C-c'] },
    }));
    assert.deepStrictEqual(interrupt.keys_sent, ['C-c']);
    // If the interrupt landed, the shell is back at its prompt and runs commands.
    const after = parseTool(await mcp.callTool({
      name: 'meta_type',
      arguments: { session_id: term.sessionId, text: 'echo after-interrupt-519' },
    }));
    assert.strictEqual(after.landed, true);
    await term.waitForOutput(/after-interrupt-519/, 10000);
  });

  it('rejects unknown key names', async () => {
    const result = await mcp.callTool({
      name: 'meta_type',
      arguments: { session_id: term.sessionId, keys: ['NotAKey'] },
    });
    assert.match(result.content[0].text, /Unknown key "NotAKey"/);
  });

  it('GET /api/shells/:id/info reports state and metaControls', async () => {
    const info = await httpGet(`/api/shells/${term.sessionId}/info`);
    assert.strictEqual(info.state, 'unknown');
    assert.strictEqual(info.metaControls, true);
  });
});
