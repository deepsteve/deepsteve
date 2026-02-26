const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 30000; // 30s — screenshots can be slow

/**
 * Initialize screenshot MCP tools.
 */
function init(context) {
  const { broadcast } = context;

  return {
    screenshot_capture: {
      description: 'Capture a screenshot of a DOM element in the deepsteve browser tab and save it as a PNG file. Returns the file path. Use CSS selectors to target specific elements (e.g. "#app-container", "#tabs", "#content-row"). Make sure the Screenshots mod is enabled in deepsteve.',
      schema: {
        selector: z.string().describe('CSS selector for the element to capture (e.g. "#app-container", ".terminal-container.active")'),
        filename: z.string().optional().describe('Output filename (without extension). Defaults to "screenshot-<timestamp>".'),
        output_dir: z.string().optional().describe('Directory to save the PNG. Defaults to ~/Desktop.'),
      },
      handler: async ({ selector, filename, output_dir }) => {
        const requestId = randomUUID();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fname = (filename || `deepsteve-${ts}`) + '.png';
        const dir = output_dir || path.join(require('os').homedir(), 'Desktop');
        const outPath = path.join(dir, fname);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Screenshots mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer, outPath });

          broadcast({
            type: 'screenshot-capture-request',
            requestId,
            selector,
          });
        });
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
