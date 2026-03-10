const { z } = require('zod');
const http = require('http');

function init(context) {
  const { shells, log } = context;

  return {
    apply_window_config: {
      description: 'Launch all tabs from a saved window config by name. Creates sessions for each tab defined in the config.',
      schema: {
        config_name: z.string().describe('Name of the window config to apply'),
        window_id: z.string().optional().describe('Target window ID (optional, uses caller session window if omitted)'),
        session_id: z.string().optional().describe('Caller session ID for resolving window (from DEEPSTEVE_SESSION_ID env var)'),
      },
      handler: async ({ config_name, window_id, session_id }) => {
        let windowId = window_id;
        if (!windowId && session_id) {
          const callerEntry = shells.get(session_id);
          if (callerEntry?.windowId) windowId = callerEntry.windowId;
        }

        const port = process.env.PORT || 3000;

        // Fetch configs to find by name
        const configsBody = await httpGet(`http://127.0.0.1:${port}/api/window-configs`);
        const data = JSON.parse(configsBody);
        const config = (data.configs || []).find(c => c.name.toLowerCase() === config_name.toLowerCase());
        if (!config) {
          const available = (data.configs || []).map(c => c.name).join(', ') || 'none';
          return { content: [{ type: 'text', text: `Window config "${config_name}" not found. Available: ${available}` }] };
        }

        // Apply the config
        const applyBody = await httpPost(`http://127.0.0.1:${port}/api/window-configs/${config.id}/apply`, { windowId });
        const result = JSON.parse(applyBody);
        const sessionList = (result.sessions || []).map(s => `  - ${s.name} (${s.cwd})`).join('\n');
        return { content: [{ type: 'text', text: `Applied window config "${config.name}". Created ${result.sessions?.length || 0} sessions:\n${sessionList}` }] };
      },
    },
  };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
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
