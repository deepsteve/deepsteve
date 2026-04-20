const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// Pending requests awaiting browser response: requestId → { resolve, timer, outPath, selector }
const pendingRequests = new Map();

const TIMEOUT_MS = 30000; // 30s — screenshots can be slow

let modContext = null; // stashed for registerRoutes to use

/**
 * Initialize screenshot MCP tools.
 */
function init(context) {
  modContext = context;
  const { broadcast, broadcastToWindow, shells, screenshots, deleteScreenshot, getScreenshotPath } = context;

  // Resolve session_id to a windowId, returning the send function
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }) };
      }
    }
    return { send: broadcast };
  }

  return {
    screenshot_capture: {
      description: 'Capture a screenshot of a DOM element in the deepsteve management UI browser tab and save it as a PNG file on disk. Returns the file path as text. To view the screenshot, use the Read tool on the returned path — do NOT try to base64-decode, re-save, or otherwise "read back" the image; the bytes are already on disk and the returned path is the canonical way to access them. IMPORTANT: This only captures elements from the deepsteve web interface itself — it cannot screenshot external websites, your project\'s frontend, or any other browser tab. Use CSS selectors to target deepsteve UI elements (e.g. "#app-container", "#tabs", "#content-row"). Make sure the Screenshots mod is enabled in deepsteve.',
      schema: {
        selector: z.string().describe('CSS selector for the element to capture (e.g. "#app-container", ".terminal-container.active")'),
        filename: z.string().optional().describe('Output filename (without extension). Defaults to "screenshot-<timestamp>".'),
        output_dir: z.string().optional().describe('Directory to save the PNG. Defaults to ~/Desktop.'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ selector, filename, output_dir, session_id }) => {
        const requestId = randomUUID();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fname = (filename || `deepsteve-${ts}`) + '.png';
        const dir = output_dir || path.join(require('os').homedir(), 'Desktop');
        const outPath = path.join(dir, fname);
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Screenshots mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer, outPath, selector });

          send({
            type: 'screenshot-capture-request',
            requestId,
            selector,
          });
        });
      },
    },

    list_screenshots: {
      description: 'List screenshots currently stored in the deepsteve persisted collection (~/.deepsteve/screenshots/). Returns an array of { id, timestamp, source, selector?, savedTo? } sorted newest first. Use get_screenshot_path to read any entry by id.',
      schema: {},
      handler: async () => {
        const list = [...screenshots.values()].sort((a, b) => b.timestamp - a.timestamp);
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
      },
    },

    get_screenshot_path: {
      description: 'Return the absolute PNG file path for a persisted screenshot id from the deepsteve collection. Use the Read tool on the returned path to view the image — do NOT try to base64-decode or re-save; the bytes are already on disk.',
      schema: {
        id: z.string().describe('Screenshot id from list_screenshots'),
      },
      handler: async ({ id }) => {
        if (!screenshots.has(id)) {
          return { content: [{ type: 'text', text: `Error: no screenshot with id "${id}"` }] };
        }
        return { content: [{ type: 'text', text: getScreenshotPath(id) }] };
      },
    },

    delete_screenshot: {
      description: 'Delete a screenshot from the deepsteve persisted collection (removes the PNG and metadata sidecar from ~/.deepsteve/screenshots/ and notifies open browser windows).',
      schema: {
        id: z.string().describe('Screenshot id to delete'),
      },
      handler: async ({ id }) => {
        if (!screenshots.has(id)) {
          return { content: [{ type: 'text', text: `Error: no screenshot with id "${id}"` }] };
        }
        deleteScreenshot(id);
        broadcast({ type: 'screenshot-deleted', id });
        return { content: [{ type: 'text', text: JSON.stringify({ id, deleted: true }) }] };
      },
    },
  };
}

/**
 * Register REST routes for receiving screenshot results.
 */
function registerRoutes(app, context) {
  // Increase body size limit for base64 image data
  const express = require('express');
  app.post('/api/screenshots/result', express.json({ limit: '50mb' }), (req, res) => {
    const { requestId, dataUrl, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return res.json({ accepted: false });
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else {
      // Validate data URL before writing to disk
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        pending.resolve({
          content: [{ type: 'text', text: 'Error: Invalid or missing dataUrl — expected a data:image/png;base64,… string' }],
        });
        return res.status(400).json({ error: 'Invalid dataUrl' });
      }
      try {
        const base64 = dataUrl.slice('data:image/png;base64,'.length);
        const buf = Buffer.from(base64, 'base64');
        if (buf.length === 0) {
          pending.resolve({
            content: [{ type: 'text', text: 'Error: Screenshot data decoded to an empty buffer' }],
          });
          return res.status(400).json({ error: 'Empty image data' });
        }
        fs.mkdirSync(path.dirname(pending.outPath), { recursive: true });
        fs.writeFileSync(pending.outPath, buf);

        // Also persist into the browsable collection so MCP captures appear in the
        // screenshots panel and survive restarts.
        const { setScreenshot, broadcast } = modContext;
        const id = randomUUID().slice(0, 8);
        const meta = {
          id,
          timestamp: Date.now(),
          source: 'mcp',
          ...(pending.selector ? { selector: pending.selector } : {}),
          savedTo: pending.outPath,
        };
        try {
          setScreenshot(meta, buf);
          broadcast({ type: 'screenshot-added', meta });
        } catch {}

        pending.resolve({
          content: [{ type: 'text', text: `Screenshot saved to ${pending.outPath}` }],
        });
      } catch (e) {
        pending.resolve({
          content: [{ type: 'text', text: `Error saving screenshot: ${e.message}` }],
        });
      }
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
