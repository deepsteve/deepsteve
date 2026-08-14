const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// The single source of truth for "which MCP tools exist, and what does each one say".
// Populated by initMCP() as each mod's tools.js is loaded, and read back by server.js's
// GET /api/mods (#644) — which used to ship a hand-maintained second copy out of every
// mod.json. Being hand-maintained, that copy rotted: 48 names declared against 55 really
// registered, with descriptions rewritten independently on each side.
//
// Module scope rather than a closure inside initMCP: mcp-server.js is required exactly
// once (server.js:10), so this IS a singleton, and the accessor stays correct if initMCP
// is ever made re-runnable. Arrays are handed out uncopied — GET /api/mods spreads them
// straight into JSON and never mutates them.
const modToolIndex = new Map();   // modId (directory name) → [{ name, description }]
let mcpReady = false;

/**
 * The tools a mod's tools.js registered, in registration order. Total: returns [] for a
 * mod with no tools.js, for an unknown mod, and for EVERY mod until initMCP() has
 * finished — it is async (dynamic import of the ESM-only SDK), so ask isMcpReady() when
 * the difference between "no tools" and "not scanned yet" matters.
 */
function getModTools(modId) {
  return modToolIndex.get(modId) || [];
}

/** False until initMCP() has finished scanning mods and the index is complete. */
function isMcpReady() {
  return mcpReady;
}

/**
 * Initialize MCP server with Streamable HTTP transport.
 * Dynamically imports the ESM-only @modelcontextprotocol/sdk,
 * scans mods for tools.js files, and mounts routes on the Express app.
 */
async function initMCP(context) {
  const { app, security, broadcast, log, MODS_DIR } = context;

  // Dynamic import of ESM-only SDK
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  // Collect tool definitions from mods that have a tools.js file
  const modTools = {};  // { toolName: { description, schema, handler } }
  const toolOwner = new Map();  // toolName → modId, for the collision warning below

  // Cheap insurance if initMCP is ever called twice: a mod deleted since the last scan
  // must not linger in the index.
  modToolIndex.clear();
  mcpReady = false;

  if (fs.existsSync(MODS_DIR)) {
    const entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const toolsPath = path.resolve(MODS_DIR, entry.name, 'tools.js');
      if (!fs.existsSync(toolsPath)) continue;

      try {
        const mod = require(toolsPath);
        if (typeof mod.init === 'function') {
          const tools = mod.init(context);
          const declared = [];
          for (const [name, def] of Object.entries(tools)) {
            // A collision used to be invisible-but-consistent. Now that /api/mods reports
            // per-mod ownership it would list one name under two mods while only one is
            // reachable, so say so. Log, never throw: the catch below is per-mod, so a
            // throw here would silently drop the whole mod — far worse than a warning.
            if (toolOwner.has(name)) {
              log(`MCP: WARNING mod "${entry.name}" registers tool "${name}", already registered by mod "${toolOwner.get(name)}" — the later load wins, and mods load in readdir order, so which one is live is not stable`);
            }
            modTools[name] = def;
            toolOwner.set(name, entry.name);
            declared.push({ name, description: def.description || '' });
            log(`MCP: registered tool "${name}" from mod "${entry.name}"`);
          }
          // Set even when empty, so "has tools.js but exports nothing" is recorded.
          modToolIndex.set(entry.name, declared);
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

  // The index is complete here — registerRoutes adds REST routes, never tools.
  mcpReady = true;

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

    // Defense-in-depth mirroring the MCP SDK's DNS-rebinding fix (#536). allowedHosts must be
    // port-qualified — the SDK matches the FULL Host header exactly; Origin is validated only when
    // present, so Origin-less agent clients still pass. The Express Host guard + token gate that
    // already run ahead of /mcp remain the primary controls.
    const dnsProtect = security ? {
      enableDnsRebindingProtection: true,
      allowedHosts: security.mcpAllowedHosts,
      allowedOrigins: [...security.allowedOrigins],
    } : {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      ...dnsProtect,
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
      await transport.handleRequest(req, res, req.body);
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

    await transport.handleRequest(req, res, req.body);

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
    await transport.handleRequest(req, res, req.body);
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

module.exports = { initMCP, getModTools, isMcpReady };
