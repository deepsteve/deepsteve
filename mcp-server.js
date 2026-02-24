const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * Initialize MCP server with Streamable HTTP transport.
 * Dynamically imports the ESM-only @modelcontextprotocol/sdk,
 * scans mods for tools.js files, and mounts routes on the Express app.
 */
async function initMCP(context) {
  const { app, broadcast, log, MODS_DIR } = context;

  // Dynamic import of ESM-only SDK
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  // Collect tool definitions from mods that have a tools.js file
  const modTools = {};  // { toolName: { description, schema, handler } }

  if (fs.existsSync(MODS_DIR)) {
    const entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const toolsPath = path.join(MODS_DIR, entry.name, 'tools.js');
      if (!fs.existsSync(toolsPath)) continue;

      try {
        const mod = require(toolsPath);
        if (typeof mod.init === 'function') {
          const tools = mod.init(context);
          for (const [name, def] of Object.entries(tools)) {
            modTools[name] = def;
            log(`MCP: registered tool "${name}" from mod "${entry.name}"`);
          }
        }
        if (typeof mod.registerRoutes === 'function') {
          mod.registerRoutes(app, context);
          log(`MCP: registered REST routes from mod "${entry.name}"`);
        }
      } catch (e) {
        log(`MCP: failed to load tools from mod "${entry.name}":`, e.message);
      }
    }
  }

  if (Object.keys(modTools).length === 0) {
    log('MCP: no mod tools found, MCP endpoint will have no tools');
  }

  // Session management: one McpServer+transport per MCP session
  const sessions = new Map(); // sessionId → { server, transport }

  function createSession() {
    const server = new McpServer({
      name: 'deepsteve',
      version: '1.0.0',
    });

    // Register all mod tools on this server instance
    for (const [name, def] of Object.entries(modTools)) {
      server.tool(name, def.description, def.schema, def.handler);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    server.connect(transport);
    return { server, transport };
  }

  // POST /mcp — main MCP endpoint
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — route to its transport
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      log(`MCP: stale session ${sessionId}, creating new session`);
    }

    // No session ID or stale session — create new session
    const { server, transport } = createSession();

    // Capture the session ID after the transport generates it
    const origSetHeader = res.setHeader.bind(res);
    let capturedSessionId = null;
    res.setHeader = function(name, value) {
      if (name.toLowerCase() === 'mcp-session-id') {
        capturedSessionId = value;
      }
      return origSetHeader(name, value);
    };

    await transport.handleRequest(req, res);

    if (capturedSessionId) {
      sessions.set(capturedSessionId, { server, transport });
      log(`MCP: new session ${capturedSessionId}`);
    }
  });

  // GET /mcp — SSE stream for server→client notifications
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      // Stale or missing session — tell client to re-initialize
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — session teardown
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
      log(`MCP: session ${sessionId} deleted`);
    } else {
      // Stale session — nothing to clean up, just ack
      res.status(200).end();
    }
  });

  log(`MCP: server initialized with ${Object.keys(modTools).length} tools`);
}

module.exports = { initMCP };
