const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const CHAT_FILE = path.join(os.homedir(), '.deepsteve', 'agent-chat.json');

let data = { channels: {}, nextId: 1 };

// Load existing data
try {
  if (fs.existsSync(CHAT_FILE)) {
    data = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  }
} catch {}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
    fs.writeFileSync(CHAT_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function ensureChannel(name) {
  if (!data.channels[name]) {
    data.channels[name] = { messages: [] };
  }
  return data.channels[name];
}

/**
 * Initialize MCP tools. Returns tool definitions keyed by name.
 */
function init(context) {
  const { broadcast } = context;

  function broadcastChat() {
    broadcast({ type: 'agent-chat', channels: data.channels });
  }

  return {
    send_message: {
      description: 'Send a message to a chat channel for other agents or the human to read',
      schema: {
        channel: z.string().optional().describe('Channel name (defaults to "general")'),
        sender: z.string().describe('Your name/identifier as the sender'),
        text: z.string().describe('The message content'),
      },
      handler: async ({ channel, sender, text }) => {
        const channelName = channel || 'general';
        const ch = ensureChannel(channelName);
        const msg = {
          id: data.nextId++,
          sender,
          text,
          timestamp: Date.now(),
        };
        ch.messages.push(msg);
        saveData();
        broadcastChat();
        return { content: [{ type: 'text', text: `Message #${msg.id} sent to #${channelName}` }] };
      },
    },

    read_messages: {
      description: 'Read messages from a chat channel. Use after_id to poll for new messages only.',
      schema: {
        channel: z.string().optional().describe('Channel name (defaults to "general")'),
        after_id: z.number().optional().describe('Only return messages with ID greater than this (for polling)'),
        limit: z.number().optional().describe('Max messages to return (default 50, from most recent)'),
      },
      handler: async ({ channel, after_id, limit }) => {
        const channelName = channel || 'general';
        const ch = data.channels[channelName];
        if (!ch) {
          return { content: [{ type: 'text', text: `Channel #${channelName} does not exist yet. No messages.` }] };
        }

        let messages = ch.messages;
        if (after_id !== undefined) {
          messages = messages.filter(m => m.id > after_id);
        }

        const maxMessages = limit || 50;
        if (messages.length > maxMessages) {
          messages = messages.slice(-maxMessages);
        }

        if (messages.length === 0) {
          return { content: [{ type: 'text', text: `No ${after_id !== undefined ? 'new ' : ''}messages in #${channelName}.` }] };
        }

        const formatted = messages.map(m => {
          const time = new Date(m.timestamp).toLocaleTimeString();
          return `[#${m.id} ${time}] ${m.sender}: ${m.text}`;
        }).join('\n');

        return { content: [{ type: 'text', text: formatted }] };
      },
    },

    list_channels: {
      description: 'List available chat channels with message counts and latest activity',
      schema: {},
      handler: async () => {
        const channelNames = Object.keys(data.channels);
        if (channelNames.length === 0) {
          return { content: [{ type: 'text', text: 'No channels yet. Use send_message to create one.' }] };
        }

        const lines = channelNames.map(name => {
          const ch = data.channels[name];
          const count = ch.messages.length;
          const last = ch.messages[ch.messages.length - 1];
          const lastTime = last ? new Date(last.timestamp).toLocaleTimeString() : 'n/a';
          const lastSender = last ? last.sender : '';
          return `#${name} — ${count} message${count !== 1 ? 's' : ''}, last: ${lastSender} at ${lastTime}`;
        });

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      },
    },
  };
}

/**
 * Register REST endpoints for the browser panel.
 */
function registerRoutes(app, context) {
  const { broadcast } = context;

  function broadcastChat() {
    broadcast({ type: 'agent-chat', channels: data.channels });
  }

  // Get all channels + messages
  app.get('/api/agent-chat', (req, res) => {
    res.json({ channels: data.channels });
  });

  // Get messages for one channel
  app.get('/api/agent-chat/:channel', (req, res) => {
    const ch = data.channels[req.params.channel];
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    res.json({ messages: ch.messages });
  });

  // Human sends a message
  app.post('/api/agent-chat/:channel/messages', (req, res) => {
    const { sender, text } = req.body;
    if (!sender || !text) {
      return res.status(400).json({ error: 'sender and text are required' });
    }
    const channelName = req.params.channel;
    const ch = ensureChannel(channelName);
    const msg = {
      id: data.nextId++,
      sender,
      text,
      timestamp: Date.now(),
    };
    ch.messages.push(msg);
    saveData();
    broadcastChat();
    res.json({ message: msg });
  });

  // Clear a channel
  app.delete('/api/agent-chat/:channel', (req, res) => {
    const channelName = req.params.channel;
    if (!data.channels[channelName]) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    delete data.channels[channelName];
    saveData();
    broadcastChat();
    res.json({ deleted: channelName });
  });
}

module.exports = { init, registerRoutes };
