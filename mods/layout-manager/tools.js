const { z } = require('zod');
const http = require('http');

function init(context) {
  const { shells } = context;

  return {
    set_layout: {
      description: 'Set the terminal layout to a split/tiled configuration. Available layouts: single, 2-col, 2-row, 3-col, 2x2, 1-2, 2-1',
      schema: {
        layout: z.enum(['single', '2-col', '2-row', '3-col', '2x2', '1-2', '2-1']).describe('Layout preset ID'),
        assignments: z.record(z.string(), z.string()).optional().describe('Optional pane assignments: object mapping pane index (as string) to session ID'),
        session_id: z.string().optional().describe('Caller session ID for resolving window (from DEEPSTEVE_SESSION_ID env var)'),
      },
      handler: async ({ layout, assignments, session_id }) => {
        let windowId;
        if (session_id) {
          const callerEntry = shells.get(session_id);
          if (callerEntry?.windowId) windowId = callerEntry.windowId;
        }

        const port = process.env.PORT || 3000;
        const body = { layout, assignments: assignments || {}, windowId };

        try {
          await httpPost(`http://127.0.0.1:${port}/api/layout`, body);
        } catch (e) {
          return { content: [{ type: 'text', text: `Failed to set layout: ${e.message}` }] };
        }

        const PRESET_NAMES = {
          'single': 'Single', '2-col': '2 Columns', '2-row': '2 Rows',
          '3-col': '3 Columns', '2x2': '2x2 Grid', '1-2': '1+2', '2-1': '2+1',
        };
        const name = PRESET_NAMES[layout] || layout;
        const assignCount = Object.keys(assignments || {}).length;
        const assignMsg = assignCount > 0 ? ` with ${assignCount} pane assignment(s)` : '';
        return { content: [{ type: 'text', text: `Layout set to "${name}"${assignMsg}.` }] };
      },
    },
  };
}

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = { init };
