const { z } = require('zod');
const { randomUUID } = require('crypto');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 15000;

/**
 * Initialize Baby Browser MCP tools.
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
    baby_browser_navigate: {
      description: 'Navigate Baby Browser to a URL and wait for the page to load. Baby Browser is a built-in iframe-based web browser tab in deepsteve. Use this to browse external websites.',
      schema: {
        url: z.string().describe('The URL to navigate to (e.g. "https://example.com").'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ url, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for Baby Browser response. Make sure the Baby Browser mod is enabled and a Baby Browser tab is open.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'baby-browser-request',
            requestId,
            action: 'navigate',
            url,
          });
        });
      },
    },

    baby_browser_read: {
      description: 'Read the current page content from Baby Browser as simplified text. Returns the page title and body text with scripts/styles stripped. Useful for extracting information from web pages.',
      schema: {
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for Baby Browser response. Make sure the Baby Browser mod is enabled and a Baby Browser tab is open.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'baby-browser-request',
            requestId,
            action: 'read',
          });
        });
      },
    },

    baby_browser_url: {
      description: 'Get the current URL displayed in Baby Browser.',
      schema: {
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for Baby Browser response. Make sure the Baby Browser mod is enabled and a Baby Browser tab is open.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'baby-browser-request',
            requestId,
            action: 'url',
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving Baby Browser results.
 */
function registerRoutes(app, context) {
  app.post('/api/baby-browser/result', (req, res) => {
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
