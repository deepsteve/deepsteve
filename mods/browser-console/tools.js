const { z } = require('zod');
const { randomUUID } = require('crypto');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 10000;

/**
 * Initialize browser console MCP tools.
 */
function init(context) {
  const { broadcast, broadcastToWindow, shells } = context;

  // Resolve session_id to a windowId, returning the send function and optional targetWindowId
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }), targetWindowId: windowId };
      }
    }
    return { send: broadcast };
  }

  return {
    browser_eval: {
      description: 'Execute JavaScript code in the deepsteve browser tab and return the result. Use this to inspect DOM state, check for errors, read element properties, or run any JS in the browser context.',
      schema: {
        code: z.string().describe('JavaScript code to execute in the browser. Has full access to the DOM and page globals. Async code is supported (the return value is awaited).'),
        session_id: z.string().optional().describe('DeepSteve session ID ($DEEPSTEVE_SESSION_ID). When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ code, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Console mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'browser-eval-request',
            requestId,
            code,
          });
        });
      },
    },

    browser_console: {
      description: 'Read recent browser console entries (log, warn, error, info, debug) captured by the Console mod. Useful for debugging frontend issues without asking the user to check devtools.',
      schema: {
        level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).optional().describe('Filter by log level. Defaults to "all".'),
        limit: z.number().optional().describe('Maximum number of entries to return (most recent first). Defaults to 50.'),
        search: z.string().optional().describe('Filter entries containing this substring (case-insensitive).'),
        session_id: z.string().optional().describe('DeepSteve session ID ($DEEPSTEVE_SESSION_ID). When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ level, limit, search, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Console mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'browser-console-request',
            requestId,
            level: level || 'all',
            limit: limit || 50,
            search: search || '',
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving browser results.
 */
function registerRoutes(app, context) {
  app.post('/api/browser-console/result', (req, res) => {
    const { requestId, result, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      // Already resolved (timeout or duplicate from another tab)
      return res.json({ accepted: false });
    }

    // Accept first response, discard duplicates
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else {
      pending.resolve({
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      });
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
