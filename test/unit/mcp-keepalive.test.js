// The MCP server pings every session's client on a timer (#716).
//
// Claude Code gives the GET notification stream a read timeout (358s on 2.1.283), and when it
// fires it declares every tool call still running on that server lost 90s later — which killed
// acquire_lock waits in live sessions, and would kill every await_decision hold. The server
// keeps the stream busy with pings. This boots initMCP() with no mods on a real port, connects
// the SDK's own client, and counts the pings that reach it; mcpKeepaliveMs shortens the timer.
//
// Run: node --test test/unit/mcp-keepalive.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { initMCP } = require('../../mcp-server.js');

test('each MCP session is pinged on a timer, and a deleted session is not', async (t) => {
  const modsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-mcp-keepalive-'));
  const app = express();
  app.use(express.json());
  const logs = [];
  await initMCP({ app, log: (...a) => logs.push(a.join(' ')), MODS_DIR: modsDir, mcpKeepaliveMs: 100 });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { PingRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const client = new Client({ name: 'keepalive-test', version: '1.0.0' });
  let pings = 0;
  client.setRequestHandler(PingRequestSchema, () => { pings++; return {}; });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`));
  await client.connect(transport);

  const deadline = Date.now() + 5000;
  while (pings < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(pings >= 3, `expected the client to answer at least 3 pings, got ${pings}`);

  // DELETE /mcp ends the session, and with it the timer.
  await transport.terminateSession();
  await client.close();
  const after = pings;
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(pings, after, 'no pings after the session is deleted');
  assert.ok(!logs.some((l) => /missed \d+ keepalive pings/.test(l)), logs.join('\n'));
});
