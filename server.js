const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;

function log(...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}
const STATE_FILE = path.join(os.homedir(), '.deepsteve', 'state.json');
const SETTINGS_FILE = path.join(os.homedir(), '.deepsteve', 'settings.json');
const app = express();
app.use(express.static('public'));
app.use(express.json());

// Load settings
let settings = { shellProfile: '~/.zshrc' };
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    log(`Loaded settings: shellProfile=${settings.shellProfile}`);
  }
} catch (e) {
  console.error('Failed to load settings:', e.message);
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
}

function getShellProfilePath() {
  let p = settings.shellProfile || '~/.zshrc';
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

// Spawn claude with full login shell environment (like iTerm does)
function spawnClaude(args, cwd) {
  // Use login shell (-l) which properly sources /etc/zprofile, ~/.zprofile, ~/.zshrc
  const shellCmd = `claude ${args.join(' ')}`;
  return pty.spawn('zsh', ['-l', '-c', shellCmd], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: process.env
  });
}

// Load saved state from previous run (shells that can be resumed)
let savedState = {};
try {
  if (fs.existsSync(STATE_FILE)) {
    savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    log(`Loaded ${Object.keys(savedState).length} saved sessions from state file`);
  }
} catch (e) {
  console.error('Failed to load state file:', e.message);
}

// Save state on shutdown
function saveState() {
  const state = {};
  for (const [id, entry] of shells) {
    state[id] = { cwd: entry.cwd };
  }
  // Merge with any saved state that wasn't reconnected yet
  const merged = { ...savedState, ...state };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
    log(`Saved ${Object.keys(merged).length} sessions to state file`);
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

process.on('SIGTERM', () => {
  log('Received SIGTERM, saving state...');
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, saving state...');
  saveState();
  process.exit(0);
});

app.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

app.get('/api/settings', (req, res) => res.json(settings));

app.post('/api/settings', (req, res) => {
  const { shellProfile } = req.body;
  if (shellProfile !== undefined) {
    settings.shellProfile = shellProfile;
    saveSettings();
    log(`Settings updated: shellProfile=${shellProfile}`);
  }
  res.json(settings);
});

app.get('/api/shells', (req, res) => {
  const active = [...shells.entries()].map(([id, entry]) => ({ id, pid: entry.shell.pid, cwd: entry.cwd, status: 'active' }));
  const saved = Object.entries(savedState).map(([id, entry]) => ({ id, cwd: entry.cwd, status: 'saved' }));
  res.json({ shells: [...active, ...saved] });
});

app.post('/api/shells/killall', (req, res) => {
  const killed = [];
  for (const [id, entry] of shells) {
    killed.push({ id, pid: entry.shell.pid });
    entry.shell.kill();
    shells.delete(id);
  }
  res.json({ killed });
});

app.delete('/api/shells/:id', (req, res) => {
  const id = req.params.id;

  // Check active shells
  if (shells.has(id)) {
    const entry = shells.get(id);
    entry.shell.kill();
    shells.delete(id);
    log(`Killed active shell ${id}`);
    saveState();
    return res.json({ killed: id, status: 'active' });
  }

  // Check saved state
  if (savedState[id]) {
    delete savedState[id];
    log(`Removed saved session ${id}`);
    saveState();
    return res.json({ killed: id, status: 'saved' });
  }

  res.status(404).json({ error: 'Session not found' });
});

app.post('/api/mkdir', require('express').json(), (req, res) => {
  let dir = req.body.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  dir = path.resolve(dir);
  try { fs.mkdirSync(dir, { recursive: true }); res.json({ created: dir }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dirs', (req, res) => {
  let input = req.query.path || '~';
  if (input.startsWith('~')) input = path.join(os.homedir(), input.slice(1));
  const absPath = path.resolve(input);
  let dirToList = absPath, prefix = '';
  try {
    if (!fs.statSync(absPath).isDirectory()) { dirToList = path.dirname(absPath); prefix = path.basename(absPath); }
  } catch { dirToList = path.dirname(absPath); prefix = path.basename(absPath); }
  try {
    const entries = fs.readdirSync(dirToList, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).filter(e => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase())).sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map(e => path.join(dirToList, e.name)).slice(0, 20);
    res.json({ dirs });
  } catch { res.json({ dirs: [] }); }
});

const server = app.listen(PORT);
const shells = new Map();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action');
  if (action === 'list') {
    const ids = [...new Set([...shells.keys(), ...Object.keys(savedState)])];
    ws.send(JSON.stringify({ type: 'list', ids }));
    ws.close();
    return;
  }

  let id = url.searchParams.get('id');
  let cwd = url.searchParams.get('cwd') || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  const createNew = url.searchParams.get('new') === '1';

  log(`[WS] Connection: id=${id}, cwd=${cwd}, createNew=${createNew}`);
  log(`[WS] Active shells: ${[...shells.keys()].join(', ') || 'none'}`);
  log(`[WS] Saved state: ${Object.keys(savedState).join(', ') || 'none'}`);

  // If client requested a specific ID that doesn't exist, check if we can restore it
  if (id && !shells.has(id) && !createNew) {
    if (savedState[id]) {
      // Restore this session with --continue flag
      const restored = savedState[id];
      cwd = restored.cwd;
      log(`Restoring session ${id} in ${cwd}`);
      const shell = spawnClaude(['-c'], cwd);
      shells.set(id, { shell, clients: new Set(), cwd, restored: true, waitingForInput: false });
      shell.onData((data) => {
        const entry = shells.get(id);
        if (!entry) return;
        entry.clients.forEach((c) => c.send(data));
        // Detect BEL character (terminal bell) - Claude waiting for input
        if (data.includes('\x07') && !entry.waitingForInput) {
          entry.waitingForInput = true;
          const stateMsg = JSON.stringify({ type: 'state', waiting: true });
          entry.clients.forEach((c) => c.send(stateMsg));
        }
      });
      shell.onExit(() => { shells.delete(id); saveState(); });
      delete savedState[id];
      saveState();
    } else {
      ws.send(JSON.stringify({ type: 'gone', id }));
      ws.close();
      return;
    }
  }

  if (!id || !shells.has(id)) {
    const oldId = id;
    id = randomUUID().slice(0, 8);
    log(`[WS] Creating NEW shell: oldId=${oldId}, newId=${id}, cwd=${cwd}`);
    const shell = spawnClaude([], cwd);
    shells.set(id, { shell, clients: new Set(), cwd, waitingForInput: false });
    shell.onData((data) => {
      const entry = shells.get(id);
      if (!entry) return;
      entry.clients.forEach((c) => c.send(data));
      // Detect BEL character (terminal bell) - Claude waiting for input
      if (data.includes('\x07') && !entry.waitingForInput) {
        entry.waitingForInput = true;
        const stateMsg = JSON.stringify({ type: 'state', waiting: true });
        entry.clients.forEach((c) => c.send(stateMsg));
      }
    });
    shell.onExit(() => { shells.delete(id); saveState(); });
    saveState();
  }

  const entry = shells.get(id);
  const isReconnect = entry.clients.size > 0 || entry.hadClients;
  // Cancel any pending kill timer on reconnect
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
  }
  entry.clients.add(ws);
  entry.hadClients = true;
  log(`[WS] Sending session response: id=${id}, restored=${entry.restored || false}, reconnect=${isReconnect}`);
  ws.send(JSON.stringify({ type: 'session', id, restored: entry.restored || false, cwd: entry.cwd }));

  // Send Ctrl+L to redraw terminal on reconnect (after resize happens)
  if (isReconnect) {
    setTimeout(() => {
      entry.shell.write('\x0c'); // Ctrl+L - redraw
    }, 100);
  }

  ws.on('message', (msg) => {
    const str = msg.toString();
    try { const parsed = JSON.parse(str); if (parsed.type === 'resize') { entry.shell.resize(parsed.cols, parsed.rows); return; } } catch {}
    // User sent input - no longer waiting
    if (entry.waitingForInput) {
      entry.waitingForInput = false;
      const stateMsg = JSON.stringify({ type: 'state', waiting: false });
      entry.clients.forEach((c) => c.send(stateMsg));
    }
    entry.shell.write(str);
  });

  ws.on('close', () => {
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      // Grace period to allow reconnect on refresh
      entry.killTimer = setTimeout(() => {
        if (entry.clients.size === 0) {
          entry.shell.kill();
          shells.delete(id);
        }
      }, 30000);
    }
  });
});
