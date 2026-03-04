const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const DNA_FILE = path.join(os.homedir(), '.deepsteve', 'agent-dna.json');
let dnaStore = {};

// Load existing DNA
try {
  if (fs.existsSync(DNA_FILE)) {
    dnaStore = JSON.parse(fs.readFileSync(DNA_FILE, 'utf8'));
  }
} catch {}

function saveDna() {
  try {
    fs.mkdirSync(path.dirname(DNA_FILE), { recursive: true });
    fs.writeFileSync(DNA_FILE, JSON.stringify(dnaStore, null, 2));
  } catch {}
}

/**
 * Initialize MCP tools. Returns tool definitions keyed by name.
 */
function init(context) {
  const { broadcast, shells } = context;

  function broadcastDna(sessionId) {
    broadcast({ type: 'agent-dna', sessionId, dna: dnaStore[sessionId] || null });
  }

  return {
    get_agent_dna: {
      description: 'Get agent DNA personality config for a session',
      schema: {
        session_id: z.string().describe('The deepsteve session ID (from DEEPSTEVE_SESSION_ID env var)'),
      },
      handler: async ({ session_id }) => {
        const dna = dnaStore[session_id] || {};
        const shell = shells.get(session_id);
        const name = shell ? shell.name : null;
        const result = { session_id, name, ...dna };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    },

    set_agent_dna: {
      description: 'Set agent DNA personality config for a session',
      schema: {
        session_id: z.string().describe('The deepsteve session ID (from DEEPSTEVE_SESSION_ID env var)'),
        approach: z.string().optional().describe('1-2 word engineering role hint (e.g. "cautious", "move-fast")'),
        traits: z.array(z.string()).optional().describe('Array of personality trait keywords'),
      },
      handler: async ({ session_id, approach, traits }) => {
        if (!dnaStore[session_id]) dnaStore[session_id] = {};
        if (approach !== undefined) dnaStore[session_id].approach = approach;
        if (traits !== undefined) dnaStore[session_id].traits = traits;
        saveDna();
        broadcastDna(session_id);
        return { content: [{ type: 'text', text: `Agent DNA updated for session ${session_id}.` }] };
      },
    },
  };
}

/**
 * Register REST endpoints for the browser panel.
 */
function registerRoutes(app, context) {
  const { broadcast } = context;

  function broadcastDna(sessionId) {
    broadcast({ type: 'agent-dna', sessionId, dna: dnaStore[sessionId] || null });
  }

  app.get('/api/agent-dna/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    res.json({ dna: dnaStore[sessionId] || {} });
  });

  app.put('/api/agent-dna/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { approach, traits } = req.body;
    if (!dnaStore[sessionId]) dnaStore[sessionId] = {};
    if (approach !== undefined) dnaStore[sessionId].approach = approach;
    if (traits !== undefined) dnaStore[sessionId].traits = traits;
    saveDna();
    broadcastDna(sessionId);
    res.json({ dna: dnaStore[sessionId] });
  });

  app.delete('/api/agent-dna/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    delete dnaStore[sessionId];
    saveDna();
    broadcastDna(sessionId);
    res.json({ deleted: sessionId });
  });
}

module.exports = { init, registerRoutes };
