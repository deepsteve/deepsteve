const { z } = require('zod');
const { randomUUID } = require('crypto');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

// Active baby browser tabs: tabId → { url, registeredAt }
const activeTabs = new Map();

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

  // Resolve tab_id, auto-selecting when only one tab exists
  function resolveTab(tab_id) {
    if (tab_id) {
      if (!activeTabs.has(tab_id)) {
        return { error: `Baby Browser tab "${tab_id}" not found. Use baby_browser_list to see available tabs.` };
      }
      return { targetTabId: tab_id };
    }
    const tabIds = [...activeTabs.keys()];
    if (tabIds.length === 0) {
      return {};  // No tabs registered — let the broadcast timeout naturally
    }
    if (tabIds.length === 1) {
      return { targetTabId: tabIds[0] };
    }
    // Multiple tabs — require explicit target
    const info = [...activeTabs.entries()].map(([id, i]) => `  ${id}: ${i.url || '(no url)'}`).join('\n');
    return { error: `Multiple Baby Browser tabs are open. Specify tab_id to target one:\n${info}` };
  }

  const SESSION_ID_SCHEMA = z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.');
  const TAB_ID_SCHEMA = z.string().optional().describe('Target a specific Baby Browser tab by its ID. Use baby_browser_list to see available tabs. When omitted and only one tab is open, it is auto-targeted.');

  return {
    baby_browser_navigate: {
      description: 'Navigate Baby Browser to a URL and wait for the page to load. Baby Browser is a built-in iframe-based web browser tab in deepsteve. Use this to browse external websites.',
      schema: {
        url: z.string().describe('The URL to navigate to (e.g. "https://example.com").'),
        session_id: SESSION_ID_SCHEMA,
        tab_id: TAB_ID_SCHEMA,
      },
      handler: async ({ url, session_id, tab_id }) => {
        const tab = resolveTab(tab_id);
        if (tab.error) return { content: [{ type: 'text', text: `Error: ${tab.error}` }] };

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
            targetTabId: tab.targetTabId,
            action: 'navigate',
            url,
          });
        });
      },
    },

    baby_browser_read: {
      description: 'Read the current page content from Baby Browser as simplified text. Returns the page title and body text with scripts/styles stripped. Useful for extracting information from web pages.',
      schema: {
        session_id: SESSION_ID_SCHEMA,
        tab_id: TAB_ID_SCHEMA,
      },
      handler: async ({ session_id, tab_id }) => {
        const tab = resolveTab(tab_id);
        if (tab.error) return { content: [{ type: 'text', text: `Error: ${tab.error}` }] };

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
            targetTabId: tab.targetTabId,
            action: 'read',
          });
        });
      },
    },

    baby_browser_url: {
      description: 'Get the current URL displayed in Baby Browser.',
      schema: {
        session_id: SESSION_ID_SCHEMA,
        tab_id: TAB_ID_SCHEMA,
      },
      handler: async ({ session_id, tab_id }) => {
        const tab = resolveTab(tab_id);
        if (tab.error) return { content: [{ type: 'text', text: `Error: ${tab.error}` }] };

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
            targetTabId: tab.targetTabId,
            action: 'url',
          });
        });
      },
    },

    baby_browser_list: {
      description: 'List all open Baby Browser tabs with their IDs and current URLs. Use this to find the tab_id needed for other baby_browser commands.',
      schema: {
        session_id: SESSION_ID_SCHEMA,
      },
      handler: async () => {
        const tabs = [...activeTabs.entries()].map(([id, info]) => ({
          tab_id: id, url: info.url,
        }));
        if (tabs.length === 0) {
          return { content: [{ type: 'text', text: 'No Baby Browser tabs are currently open.' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }] };
      },
    },
  };
}

/**
 * Register REST routes for receiving Baby Browser results and tab registration.
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

  app.post('/api/baby-browser/register', (req, res) => {
    const { tabId, url } = req.body;
    if (!tabId) return res.status(400).json({ error: 'Missing tabId' });
    activeTabs.set(tabId, { url: url || '', registeredAt: Date.now() });
    res.json({ ok: true });
  });

  app.post('/api/baby-browser/deregister', (req, res) => {
    const { tabId } = req.body;
    if (tabId) activeTabs.delete(tabId);
    res.json({ ok: true });
  });
}

module.exports = { init, registerRoutes };
