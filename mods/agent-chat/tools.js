const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const CHAT_FILE = path.join(os.homedir(), '.deepsteve', 'agent-chat.json');

function formatTimestamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const msgDay = new Date(d);
  msgDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - msgDay) / 86400000);

  if (diffDays === 0) return time;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) {
    const weekday = d.toLocaleDateString([], { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  const month = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (d.getFullYear() !== now.getFullYear()) {
    return `${month}, ${d.getFullYear()} ${time}`;
  }
  return `${month} ${time}`;
}

let data = { channels: {}, nextId: 1 };

// In-memory lock state — ephemeral, cleared on restart (correct: crashed holders shouldn't keep locks)
const locks = new Map(); // resource → { holder, acquiredAt, timeoutMs, timer, queue: [{ requester, resolve, timeoutMs, timer }] }
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

  // Lock helpers — shared by acquire_lock and release_lock
  function postToLocks(text) {
    const ch = ensureChannel('locks');
    const msg = { id: data.nextId++, sender: 'system', text, timestamp: Date.now() };
    ch.messages.push(msg);
    saveData();
    broadcastChat();
  }

  function grantLock(resource, holder, timeoutMs) {
    const timer = setTimeout(() => {
      postToLocks(`[auto-released] ${holder}'s lock on \`${resource}\` expired after ${Math.round(timeoutMs / 1000)}s`);
      releaseLockInternal(resource);
    }, timeoutMs);
    const existingQueue = locks.has(resource) ? locks.get(resource).queue : [];
    locks.set(resource, { holder, acquiredAt: Date.now(), timeoutMs, timer, queue: existingQueue });
  }

  function releaseLockInternal(resource) {
    const lock = locks.get(resource);
    if (!lock) return;
    clearTimeout(lock.timer);
    const queue = lock.queue;
    if (queue.length > 0) {
      const next = queue.shift();
      clearTimeout(next.timer);
      grantLock(resource, next.requester, next.timeoutMs);
      postToLocks(`@${next.requester} now holds lock on \`${resource}\` (granted from queue)`);
      next.resolve({
        content: [{ type: 'text', text: `Lock on "${resource}" acquired (was queued). You now hold the lock. Release with release_lock when done.` }],
      });
    } else {
      locks.delete(resource);
    }
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
          return `[#${m.id} ${formatTimestamp(m.timestamp)}] ${m.sender}: ${m.text}`;
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
          const lastTime = last ? formatTimestamp(last.timestamp) : 'n/a';
          const lastSender = last ? last.sender : '';
          return `#${name} — ${count} message${count !== 1 ? 's' : ''}, last: ${lastSender} at ${lastTime}`;
        });

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      },
    },

    acquire_lock: {
      description: 'Acquire an exclusive lock on a shared resource. Blocks until the lock is granted or times out. Use this to coordinate access to shared resources like the Baby Browser tab.',
      schema: {
        resource: z.string().describe('Name of the resource to lock (e.g. "baby-browser")'),
        requester: z.string().describe('Your name/identifier'),
        timeout_ms: z.number().optional().describe('Auto-release timeout in ms (default 300000 = 5 min). Lock auto-releases if not explicitly released.'),
      },
      handler: ({ resource, requester, timeout_ms }) => {
        const timeoutMs = timeout_ms || DEFAULT_LOCK_TIMEOUT_MS;
        const existing = locks.get(resource);

        // Resource is free — grant immediately
        if (!existing) {
          grantLock(resource, requester, timeoutMs);
          postToLocks(`${requester} acquired lock on \`${resource}\``);
          return Promise.resolve({
            content: [{ type: 'text', text: `Lock on "${resource}" acquired. You hold the lock. Release with release_lock when done. Auto-releases in ${Math.round(timeoutMs / 1000)}s.` }],
          });
        }

        // Already held by same requester
        if (existing.holder === requester) {
          return Promise.resolve({
            content: [{ type: 'text', text: `You already hold the lock on "${resource}".` }],
          });
        }

        // Resource is held — queue up and block
        return new Promise((resolve) => {
          const queueTimer = setTimeout(() => {
            const lock = locks.get(resource);
            if (lock) {
              lock.queue = lock.queue.filter(e => e.requester !== requester);
            }
            resolve({
              content: [{ type: 'text', text: `Timed out waiting for lock on "${resource}" (held by ${existing.holder}). Try again later.` }],
            });
            postToLocks(`${requester} timed out waiting for lock on \`${resource}\``);
          }, timeoutMs);

          existing.queue.push({ requester, resolve, timeoutMs, timer: queueTimer });
          const position = existing.queue.length;
          postToLocks(`${requester} is waiting for lock on \`${resource}\` (queue position ${position})`);
        });
      },
    },

    release_lock: {
      description: 'Release a lock you hold on a shared resource. The next agent in the queue (if any) will be granted the lock automatically.',
      schema: {
        resource: z.string().describe('Name of the resource to unlock'),
        requester: z.string().describe('Your name/identifier (must match the lock holder)'),
      },
      handler: async ({ resource, requester }) => {
        const lock = locks.get(resource);
        if (!lock) {
          return { content: [{ type: 'text', text: `No lock exists on "${resource}".` }] };
        }
        if (lock.holder !== requester) {
          return { content: [{ type: 'text', text: `You don't hold the lock on "${resource}" (held by ${lock.holder}).` }] };
        }

        postToLocks(`${requester} released lock on \`${resource}\``);
        releaseLockInternal(resource);

        return { content: [{ type: 'text', text: `Lock on "${resource}" released.` }] };
      },
    },

    lock_status: {
      description: 'Check the status of resource locks. Shows current holder, queue, and time held.',
      schema: {
        resource: z.string().optional().describe('Resource name to check. Omit to see all active locks.'),
      },
      handler: async ({ resource }) => {
        function describeLock(name, lock) {
          const heldFor = Math.round((Date.now() - lock.acquiredAt) / 1000);
          const autoRelease = Math.round(lock.timeoutMs / 1000);
          let desc = `\`${name}\`: held by ${lock.holder} for ${heldFor}s (auto-releases at ${autoRelease}s)`;
          if (lock.queue.length > 0) {
            const waiters = lock.queue.map((e, i) => `  ${i + 1}. ${e.requester}`).join('\n');
            desc += `\n  Queue (${lock.queue.length}):\n${waiters}`;
          }
          return desc;
        }

        if (resource) {
          const lock = locks.get(resource);
          if (!lock) {
            return { content: [{ type: 'text', text: `No active lock on "${resource}".` }] };
          }
          return { content: [{ type: 'text', text: describeLock(resource, lock) }] };
        }

        // All locks
        if (locks.size === 0) {
          return { content: [{ type: 'text', text: 'No active locks.' }] };
        }
        const lines = [];
        for (const [name, lock] of locks) {
          lines.push(describeLock(name, lock));
        }
        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
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
