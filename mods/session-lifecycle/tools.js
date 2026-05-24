// Log Session Lifecycle (issue #485)
//
// Records an append-only, agent-readable log of session lifecycle events
// (tab opens and session closes) emitted by the core lifecycle bus (server.js
// `sessionLog`). The log is a bounded JSONL file so it stays small and fast to
// read — designed to be fed to an agent to recap a work session.
//
// Recording is gated by the server-side `sessionLogEnabled` setting (default
// off). The setting object is mutated in place by the settings POST handler, so
// the live value is read on every event with no restart needed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const LOG_FILE = path.join(os.homedir(), '.deepsteve', 'session-lifecycle.jsonl');
const MAX_EVENTS = 5000; // keep the file bounded; oldest events drop off

// In-memory mirror of the log. `events` is reassigned when trimming, so use let.
let events = [];
let nextId = 1;

// Load existing log on startup (bounded to the last MAX_EVENTS).
try {
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    nextId = events.reduce((max, e) => Math.max(max, e.id || 0), 0) + 1;
  }
} catch { /* start with an empty log */ }

function append(evt) {
  evt.id = nextId++;
  events.push(evt);
  let trimmed = false;
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
    trimmed = true;
  }
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (trimmed) {
      // Rewrite the whole file from the trimmed array to keep it bounded.
      fs.writeFileSync(LOG_FILE, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    } else {
      // Fast path: append one JSON line.
      fs.appendFileSync(LOG_FILE, JSON.stringify(evt) + '\n');
    }
  } catch { /* best-effort logging — never throw into the lifecycle path */ }
}

// Apply after_id / session_id / limit filters to the in-memory log.
function query({ after_id, session_id, limit }) {
  let result = events;
  if (session_id) result = result.filter(e => e.session_id === session_id);
  if (after_id !== undefined && after_id !== null && after_id !== '') {
    const n = Number(after_id);
    result = result.filter(e => e.id > n);
  }
  if (limit !== undefined && limit !== null && limit !== '') {
    const max = Number(limit);
    if (result.length > max) result = result.slice(-max);
  }
  return result;
}

function init(context) {
  const { sessionLog, settings } = context;

  // Subscribe to the core lifecycle bus. Recording only happens when enabled.
  if (sessionLog && typeof sessionLog.on === 'function') {
    sessionLog.on('event', (evt) => {
      if (!settings.sessionLogEnabled) return;
      append({ ...evt });
    });
  }

  return {
    read_session_log: {
      description: 'Read the session lifecycle event log: a chronological list of session opens and closes (with how each closed and how long it ran). Use this to summarize what happened across deepsteve sessions. Returns one JSON object per line.',
      schema: {
        after_id: z.number().optional().describe('Only return events with id greater than this (for polling for new events).'),
        limit: z.number().optional().describe('Max events to return, from most recent (default 100).'),
        session_id: z.string().optional().describe('Filter to a single deepsteve session id.'),
      },
      handler: async ({ after_id, limit, session_id }) => {
        const result = query({ after_id, session_id, limit: limit || 100 });
        if (result.length === 0) {
          return { content: [{ type: 'text', text: 'No matching session lifecycle events. (Logging is off by default — enable "Log session lifecycle" in Settings.)' }] };
        }
        return { content: [{ type: 'text', text: result.map(e => JSON.stringify(e)).join('\n') }] };
      },
    },
  };
}

// REST endpoint for display tabs / custom HTML-JS to render the log.
function registerRoutes(app) {
  app.get('/api/session-lifecycle', (req, res) => {
    const { session, after_id, limit } = req.query;
    const result = query({ session_id: session, after_id, limit });
    res.json({ events: result });
  });
}

module.exports = { init, registerRoutes };
