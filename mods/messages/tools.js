const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { z } = require('zod');

const execFileAsync = promisify(execFile);
const CONFIG_FILE = path.join(os.homedir(), '.deepsteve', 'messages.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return { contacts: '', allowlistEnabled: true };
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function parseContacts(contactsStr) {
  const contacts = {};
  (contactsStr || '').split(',').map(e => e.trim()).filter(Boolean).forEach(entry => {
    const i = entry.indexOf(':');
    if (i > 0) {
      const name = entry.substring(0, i).trim().toLowerCase();
      const number = entry.substring(i + 1).trim();
      if (name && number) contacts[name] = number;
    }
  });
  return contacts;
}

function resolvePhoneNumber(nameOrNumber, contacts, allowlistEnabled) {
  const normalized = nameOrNumber.trim().toLowerCase();

  // Check contacts by name
  if (contacts[normalized]) return contacts[normalized];

  // Check if it's a phone number
  if (nameOrNumber.startsWith('+')) {
    if (!allowlistEnabled) return nameOrNumber;
    // When allowlist enabled, number must be in contacts
    const allowed = new Set(Object.values(contacts));
    if (allowed.has(nameOrNumber)) return nameOrNumber;
  }

  // If allowlist disabled, allow raw numbers even without +
  if (!allowlistEnabled && /^\+?\d{10,}$/.test(nameOrNumber.trim())) {
    const num = nameOrNumber.trim();
    return num.startsWith('+') ? num : `+${num}`;
  }

  return null;
}

async function sendMessage(phoneNumber, message) {
  const escapedMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${phoneNumber}" of targetService
      send "${escapedMessage}" to targetBuddy
    end tell
  `;
  try {
    await execFileAsync('osascript', ['-e', script]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Unknown error' };
  }
}

function init(context) {
  return {
    send_imessage: {
      get description() {
        const config = loadConfig();
        const contacts = parseContacts(config.contacts);
        const names = Object.keys(contacts);
        if (names.length === 0) {
          return 'Send an iMessage/SMS via the macOS Messages app. No contacts configured.';
        }
        const suffix = config.allowlistEnabled ? '' : ' (allowlist disabled — any number accepted)';
        return `Send an iMessage/SMS via the macOS Messages app. Available contacts: ${names.join(', ')}${suffix}`;
      },
      schema: {
        recipient: z.string().describe('Contact name (e.g. "mom") or phone number in E.164 format (e.g. +15551234567)'),
        message: z.string().describe('The message content to send'),
      },
      handler: async ({ recipient, message }) => {
        const config = loadConfig();
        const contacts = parseContacts(config.contacts);

        if (config.allowlistEnabled && Object.keys(contacts).length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: No contacts configured. Add contacts in the Messages panel settings.' }],
            isError: true,
          };
        }

        const resolved = resolvePhoneNumber(recipient, contacts, config.allowlistEnabled);
        if (!resolved) {
          const available = Object.entries(contacts).map(([n, num]) => `${n} (${num})`).join(', ');
          return {
            content: [{ type: 'text', text: `Error: "${recipient}" is not a valid contact. Available contacts: ${available}` }],
            isError: true,
          };
        }

        const result = await sendMessage(resolved, message);
        if (result.success) {
          const contactName = Object.entries(contacts).find(([, num]) => num === resolved)?.[0];
          const display = contactName ? `${contactName} (${resolved})` : resolved;
          return { content: [{ type: 'text', text: `Message sent successfully to ${display}` }] };
        }
        return {
          content: [{ type: 'text', text: `Failed to send message: ${result.error}` }],
          isError: true,
        };
      },
    },
  };
}

function registerRoutes(app) {
  app.get('/api/messages/config', (req, res) => {
    res.json(loadConfig());
  });

  app.post('/api/messages/config', (req, res) => {
    const config = loadConfig();
    if (req.body.contacts !== undefined) config.contacts = req.body.contacts;
    if (req.body.allowlistEnabled !== undefined) config.allowlistEnabled = !!req.body.allowlistEnabled;
    saveConfig(config);
    res.json(config);
  });
}

module.exports = { init, registerRoutes };
