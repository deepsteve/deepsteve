const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { initMCP } = require('./mcp-server');

const PORT = process.env.PORT || 3000;

function parseBindAddress() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bind' && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--bind=')) return args[i].slice(7);
  }
  return null;
}

const BIND = parseBindAddress() || process.env.DEEPSTEVE_BIND || '127.0.0.1';

if (!net.isIP(BIND)) {
  console.error(`Error: '${BIND}' is not a valid IP address. Use --bind <address> with a valid IPv4 or IPv6 address.`);
  process.exit(1);
}

if (BIND !== '127.0.0.1' && BIND !== '::1') {
  console.error('');
  console.error('  ╔══════════════════════════════════════════════════════════════╗');
  console.error('  ║  WARNING: Binding to ' + BIND.padEnd(39) + '║');
  console.error('  ║                                                              ║');
  console.error('  ║  deepsteve will be accessible from other machines on your    ║');
  console.error('  ║  network. There is NO authentication — anyone who can reach  ║');
  console.error('  ║  this address can control your Claude Code sessions.         ║');
  console.error('  ╚══════════════════════════════════════════════════════════════╝');
  console.error('');
}
const SCROLLBACK_SIZE = 100 * 1024; // 100KB circular buffer per shell
const RELOAD_FLAG = path.join(os.homedir(), '.deepsteve', '.reload');
const reloadClients = new Set(); // WebSocket connections for live-reload

function log(...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}
const STATE_FILE = path.join(os.homedir(), '.deepsteve', 'state.json');
const SETTINGS_FILE = path.join(os.homedir(), '.deepsteve', 'settings.json');
const app = express();
app.use(express.static('public'));
app.use('/mods', express.static('mods'));
app.use((req, res, next) => {
  if (req.path === '/mcp') return next(); // MCP SDK parses its own body
  express.json()(req, res, next);
});

// File upload endpoint — writes to /tmp/deepsteve-drops/ and returns the full path
const DROPS_DIR = path.join(os.tmpdir(), 'deepsteve-drops');
try { fs.mkdirSync(DROPS_DIR, { recursive: true }); } catch {}

app.put('/api/upload/:filename', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const { filename } = req.params;

  const safe = path.basename(filename);
  if (safe !== filename) return res.status(400).json({ error: 'Invalid filename' });
  if (safe.length > 255) return res.status(400).json({ error: 'Filename too long' });
  if (/[\x00-\x1f]/.test(safe)) return res.status(400).json({ error: 'Invalid characters in filename' });

  // Deduplicate: screenshot.png → screenshot-1.png, screenshot-2.png, ...
  let destPath = path.join(DROPS_DIR, safe);
  if (fs.existsSync(destPath)) {
    const ext = path.extname(safe);
    const base = safe.slice(0, safe.length - ext.length);
    let i = 1;
    while (fs.existsSync(path.join(DROPS_DIR, `${base}-${i}${ext}`))) i++;
    destPath = path.join(DROPS_DIR, `${base}-${i}${ext}`);
  }

  try {
    fs.writeFileSync(destPath, req.body);
    log(`Drop: ${path.basename(destPath)} (${req.body.length} bytes) → ${destPath}`);
    res.json({ ok: true, path: destPath });
  } catch (e) {
    log(`Drop failed: ${e.message}`);
    res.status(500).json({ error: 'Write failed: ' + e.message });
  }
});

// Settings defaults (single source of truth for wand template + plan mode)
const SETTINGS_DEFAULTS = {
  wandPlanMode: true,
  wandPromptTemplate: `I need you to work on GitHub issue #{{number}}: "{{title}}"
Labels: {{labels}}
URL: {{url}}

Issue description:
{{body}}

Please read the issue carefully, understand the codebase context, and implement the changes needed.`
};

// Load settings
let settings = { shellProfile: '~/.zshrc', maxIssueTitleLength: 25, ...SETTINGS_DEFAULTS };
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

// --- Theme system ---
const THEMES_DIR = path.join(os.homedir(), '.deepsteve', 'themes');
const MAX_THEME_SIZE = 64 * 1024; // 64KB max per theme file

// Ensure themes directory exists
try { fs.mkdirSync(THEMES_DIR, { recursive: true }); } catch {}

function listThemes() {
  try {
    return fs.readdirSync(THEMES_DIR)
      .filter(f => f.endsWith('.css'))
      .map(f => f.replace(/\.css$/, ''))
      .sort();
  } catch { return []; }
}

function readThemeCSS(name) {
  if (!name) return null;
  // Path traversal guard
  const safe = path.basename(name);
  if (safe !== name) return null;
  const file = path.join(THEMES_DIR, safe + '.css');
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_THEME_SIZE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function getActiveThemeCSS() {
  const name = settings.activeTheme;
  if (!name) return null;
  return readThemeCSS(name);
}

function broadcastTheme(name, css) {
  const msg = JSON.stringify({ type: 'theme', name: name || null, css: css || '' });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  }
  // Also send to live-reload clients so tabs with no sessions still get theme updates
  for (const client of reloadClients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// Spawn claude with full login shell environment (like iTerm does)
function spawnClaude(args, cwd, { cols = 120, rows = 40 } = {}) {
  // Use login shell (-l) which properly sources /etc/zprofile, ~/.zprofile, ~/.zshrc
  const shellCmd = `claude ${args.join(' ')}`;
  return pty.spawn('zsh', ['-l', '-c', shellCmd], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env
  });
}

/**
 * Write a prompt to a Claude PTY as if a user typed it and pressed Enter.
 *
 * Ink's input-parser treats \r inside a text chunk as pasted text — it only
 * recognizes Enter when \r arrives as its own stdin read. So we write the
 * text first, then send \r in a separate write after a short delay to ensure
 * they land in different readable events.
 */
function submitToShell(shell, text) {
  shell.write(text);
  setTimeout(() => shell.write('\r'), 1000);
}

/**
 * Wire up a shell's onData handler: broadcast output to WebSocket clients,
 * detect BEL (Claude waiting for input), and auto-submit initialPrompt.
 */
function wireShellOutput(id) {
  const entry = shells.get(id);
  if (!entry) return;
  if (!entry.scrollback) entry.scrollback = [];
  if (!entry.scrollbackSize) entry.scrollbackSize = 0;
  entry.shell.onData((data) => {
    const e = shells.get(id);
    if (!e) return;
    e.lastActivity = Date.now();
    // Append to scrollback buffer
    e.scrollback.push(data);
    e.scrollbackSize += data.length;
    // Trim scrollback if it exceeds the limit
    while (e.scrollbackSize > SCROLLBACK_SIZE && e.scrollback.length > 1) {
      e.scrollbackSize -= e.scrollback.shift().length;
    }
    e.clients.forEach((c) => c.send(data));
    if (data.includes('\x07') && !e.waitingForInput) {
      e.waitingForInput = true;
      const stateMsg = JSON.stringify({ type: 'state', waiting: true });
      e.clients.forEach((c) => c.send(stateMsg));

      if (e.initialPrompt) {
        const prompt = e.initialPrompt;
        e.initialPrompt = null;
        e.waitingForInput = false;
        setTimeout(() => submitToShell(e.shell, prompt), 500);
      }
    }
  });
}

// Gracefully kill a shell - send /exit only if Claude is waiting for input,
// otherwise Ctrl+C first to interrupt, then /exit once it's ready.
function killShell(entry, id) {
  if (entry.killed) return;
  entry.killed = true;

  const pid = entry.shell.pid;
  log(`Killing shell ${id} (pid=${pid}, waitingForInput=${entry.waitingForInput})`);

  if (entry.waitingForInput) {
    // Safe to send /exit directly
    try { submitToShell(entry.shell, '/exit'); } catch {}
  } else {
    // Claude is busy — send Ctrl+C to interrupt, then /exit when it's ready
    try { entry.shell.write('\x03'); } catch {}
    // Watch for BEL (Claude back at prompt), then send /exit
    const exitHandler = (data) => {
      if (data.includes('\x07')) {
        entry.shell.removeListener('data', exitHandler);
        try { submitToShell(entry.shell, '/exit'); } catch {}
      }
    };
    entry.shell.on('data', exitHandler);
    // If BEL never comes, the SIGTERM fallback below will handle it
  }

  // After 8 seconds, escalate to SIGTERM
  setTimeout(() => {
    try {
      process.kill(pid, 0); // Check if still alive
      log(`Shell ${id} still alive after /exit, sending SIGTERM`);
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { entry.shell.kill('SIGTERM'); } catch {}
      }
    } catch { return; } // Already dead

    // After 2 more seconds, escalate to SIGKILL
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        log(`Shell ${id} still alive, sending SIGKILL`);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try { entry.shell.kill('SIGKILL'); } catch {}
        }
      } catch {}
    }, 2000);
  }, 8000);
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
let stateFrozen = false;  // Set during shutdown to prevent onExit handlers from overwriting
function saveState() {
  if (stateFrozen) {
    log(`[saveState] BLOCKED — state frozen during shutdown`);
    return;
  }
  const state = {};
  for (const [id, entry] of shells) {
    state[id] = { cwd: entry.cwd, claudeSessionId: entry.claudeSessionId, worktree: entry.worktree || null, name: entry.name || null, lastActivity: entry.lastActivity || null };
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

// Periodic state save to survive crashes (saveState() is normally only triggered on SIGTERM)
setInterval(() => saveState(), 30000);

async function shutdown(signal) {
  log(`Received ${signal}, saving state...`);
  saveState();

  // If .reload flag exists, tell all browsers to refresh after restart
  const shouldReload = fs.existsSync(RELOAD_FLAG);
  if (shouldReload) {
    log(`Reload flag found, notifying ${reloadClients.size} browser(s) to refresh`);
    try { fs.unlinkSync(RELOAD_FLAG); } catch {}
    for (const ws of reloadClients) {
      try { ws.send(JSON.stringify({ type: 'reload' })); } catch {}
    }
    // Give the reload message time to flush before tearing down connections
    await new Promise((r) => setTimeout(r, 200));
  }
  stateFrozen = true;  // Prevent onExit/onClose handlers from overwriting state file

  // Stop accepting new connections so clients can't reconnect to the dying server.
  // Without this, clients reconnect during the ~8s graceful shutdown window,
  // then get disconnected again when the process exits (causing a double reconnect).
  server.close();
  wss.close();

  // Disconnect all client WebSockets so no user input can reach PTYs during shutdown.
  // Clients will show "Reconnecting..." overlay and block all keystrokes.
  for (const [, entry] of shells) {
    entry.clients.forEach((c) => { try { c.terminate(); } catch {} });
  }

  const entries = [...shells.entries()];
  if (entries.length === 0) {
    log('No active shells, exiting');
    process.exit(0);
  }

  // Phase 1: Gracefully exit all shells so Claude persists sessions.
  // Only send /exit when Claude is at the input prompt (waitingForInput).
  // If busy, Ctrl+C first to interrupt, then /exit once it returns to prompt.
  log(`Gracefully exiting ${entries.length} shells...`);
  for (const [id, entry] of entries) {
    try {
      if (entry.waitingForInput) {
        submitToShell(entry.shell, '/exit');
      } else {
        entry.shell.write('\x03');
        const exitHandler = (data) => {
          if (data.includes('\x07')) {
            entry.shell.removeListener('data', exitHandler);
            try { submitToShell(entry.shell, '/exit'); } catch {}
          }
        };
        entry.shell.on('data', exitHandler);
      }
    } catch {}
  }

  // Phase 2: Wait up to 8s for shells to exit naturally (1s for \r delay + time to save)
  const alive = new Set(entries.map(([id]) => id));
  for (const [id, entry] of entries) {
    entry.shell.onExit(() => alive.delete(id));
  }

  const deadline = Date.now() + 8000;
  while (alive.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }

  if (alive.size === 0) {
    log('All shells exited gracefully');
    process.exit(0);
  }

  // Phase 3: SIGTERM remaining
  log(`${alive.size} shells still alive, sending SIGTERM...`);
  for (const id of alive) {
    const entry = shells.get(id);
    if (!entry) continue;
    try { process.kill(-entry.shell.pid, 'SIGTERM'); } catch {
      try { entry.shell.kill('SIGTERM'); } catch {}
    }
  }

  // Phase 4: Wait 2s more, then force kill
  await new Promise(r => setTimeout(r, 2000));
  for (const id of alive) {
    const entry = shells.get(id);
    if (!entry) continue;
    try { process.kill(-entry.shell.pid, 'SIGKILL'); } catch {
      try { entry.shell.kill('SIGKILL'); } catch {}
    }
  }

  log('Shutdown complete');
  process.exit(0);
}

let shuttingDown = false;
process.on('SIGTERM', () => { if (!shuttingDown) { shuttingDown = true; shutdown('SIGTERM'); } });
process.on('SIGINT', () => { if (!shuttingDown) { shuttingDown = true; shutdown('SIGINT'); } });

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

app.get('/api/version', async (req, res) => {
  const current = pkg.version;
  try {
    const resp = await fetch('https://deepsteve.com/versions/stable', {
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const latest = (await resp.text()).trim();
    const updateAvailable = latest !== current;
    res.json({ current, latest, updateAvailable });
  } catch (e) {
    log(`Version check failed: ${e.message}`);
    res.json({ current, latest: null, updateAvailable: false });
  }
});

app.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

app.get('/api/settings', (req, res) => {
  const themeCSS = getActiveThemeCSS();
  res.json({ ...settings, themeCSS });
});

app.get('/api/settings/defaults', (req, res) => res.json(SETTINGS_DEFAULTS));

app.post('/api/settings', (req, res) => {
  const { shellProfile, maxIssueTitleLength } = req.body;
  if (shellProfile !== undefined) {
    settings.shellProfile = shellProfile;
    log(`Settings updated: shellProfile=${shellProfile}`);
  }
  if (maxIssueTitleLength !== undefined) {
    settings.maxIssueTitleLength = Math.max(10, Math.min(200, Number(maxIssueTitleLength) || 25));
    log(`Settings updated: maxIssueTitleLength=${settings.maxIssueTitleLength}`);
  }
  if (req.body.wandPlanMode !== undefined) {
    settings.wandPlanMode = !!req.body.wandPlanMode;
    log(`Settings updated: wandPlanMode=${settings.wandPlanMode}`);
  }
  if (req.body.wandPromptTemplate !== undefined) {
    settings.wandPromptTemplate = String(req.body.wandPromptTemplate);
    log(`Settings updated: wandPromptTemplate (${settings.wandPromptTemplate.length} chars)`);
  }
  saveSettings();
  res.json(settings);
});

app.get('/api/themes', (req, res) => {
  res.json({ themes: listThemes(), active: settings.activeTheme || null });
});

app.post('/api/themes/active', (req, res) => {
  const { theme } = req.body;
  // theme=null means "Default" (no theme)
  if (theme && typeof theme === 'string') {
    const css = readThemeCSS(theme);
    if (css === null) return res.status(404).json({ error: 'Theme not found' });
    settings.activeTheme = theme;
    saveSettings();
    broadcastTheme(theme, css);
    log(`Theme set to: ${theme}`);
  } else {
    settings.activeTheme = null;
    saveSettings();
    broadcastTheme(null, '');
    log('Theme reset to default');
  }
  res.json({ active: settings.activeTheme || null });
});

// --- Mods system ---
const MODS_DIR = path.join(__dirname, 'mods');

// Compare two semver strings (major.minor.patch). Returns -1, 0, or 1.
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

app.get('/api/mods', (req, res) => {
  try {
    if (!fs.existsSync(MODS_DIR)) return res.json({ mods: [], deepsteveVersion: pkg.version });
    const entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
    const mods = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(MODS_DIR, entry.name, 'mod.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest.version) continue; // version is required
        const compatible = !manifest.minDeepsteveVersion || compareSemver(pkg.version, manifest.minDeepsteveVersion) >= 0;
        mods.push({ id: entry.name, compatible, ...manifest });
      } catch { /* skip dirs without valid mod.json */ }
    }
    res.json({ mods, deepsteveVersion: pkg.version });
  } catch (e) {
    res.json({ mods: [], deepsteveVersion: pkg.version });
  }
});

app.get('/api/shells', (req, res) => {
  const active = [...shells.entries()].map(([id, entry]) => ({ id, pid: entry.shell.pid, cwd: entry.cwd, name: entry.name || null, status: 'active', lastActivity: entry.lastActivity || null }));
  const saved = Object.entries(savedState).map(([id, entry]) => ({ id, cwd: entry.cwd, name: entry.name || null, status: 'saved', lastActivity: entry.lastActivity || null }));
  res.json({ shells: [...active, ...saved] });
});

app.post('/api/shells/killall', (req, res) => {
  const killed = [];
  for (const [id, entry] of shells) {
    killed.push({ id, pid: entry.shell.pid });
    killShell(entry, id);
    shells.delete(id);
  }
  res.json({ killed });
});

app.delete('/api/shells/:id', (req, res) => {
  const id = req.params.id;

  // Check active shells
  if (shells.has(id)) {
    const entry = shells.get(id);
    killShell(entry, id);
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

app.get('/api/git-root', (req, res) => {
  let cwd = req.query.cwd || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  try {
    const root = execSync("zsh -l -c 'git rev-parse --show-toplevel'", { cwd, encoding: 'utf8' }).trim();
    res.json({ root });
  } catch {
    res.status(400).json({ error: 'Not a git repository' });
  }
});

app.get('/api/issues', (req, res) => {
  let cwd = req.query.cwd || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  try {
    const out = execSync("zsh -l -c 'gh issue list --json number,title,body,labels,url --limit 30'", { cwd, encoding: 'utf8', timeout: 15000 });
    res.json({ issues: JSON.parse(out) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, BIND, () => {
  log(`Server listening on ${BIND}:${PORT}`);
});
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

  // Live reload: client holds this connection open.
  // On shutdown, if ~/.deepsteve/.reload flag exists, server sends { type: 'reload' }
  // telling browsers to refresh. Otherwise the WS just drops and clients silently reconnect.
  if (action === 'reload') {
    reloadClients.add(ws);
    ws.on('close', () => reloadClients.delete(ws));
    return;
  }

  let id = url.searchParams.get('id');
  let cwd = url.searchParams.get('cwd') || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  const createNew = url.searchParams.get('new') === '1';
  const worktree = url.searchParams.get('worktree');
  const planMode = url.searchParams.get('planMode') === '1';
  const name = url.searchParams.get('name');
  const initialCols = parseInt(url.searchParams.get('cols')) || 120;
  const initialRows = parseInt(url.searchParams.get('rows')) || 40;

  log(`[WS] Connection: id=${id}, cwd=${cwd}, createNew=${createNew}, worktree=${worktree}`);
  log(`[WS] Active shells: ${[...shells.keys()].join(', ') || 'none'}`);
  log(`[WS] Saved state: ${Object.keys(savedState).join(', ') || 'none'}`);

  // If client requested a specific ID that doesn't exist, check if we can restore it
  if (id && !shells.has(id) && !createNew) {
    if (savedState[id]) {
      // Restore this session with --resume flag using saved Claude session ID
      const restored = savedState[id];
      cwd = restored.cwd;
      const oldClaudeSessionId = restored.claudeSessionId;
      const newClaudeSessionId = randomUUID();
      const savedWorktree = restored.worktree || null;
      log(`Restoring session ${id} in ${cwd} (old claude session: ${oldClaudeSessionId}, new claude session: ${newClaudeSessionId}, worktree: ${savedWorktree || 'none'})`);
      const ptySize = { cols: initialCols, rows: initialRows };
      const resumeArgs = oldClaudeSessionId
        ? ['--resume', oldClaudeSessionId, '--session-id', newClaudeSessionId]
        : ['-c', '--session-id', newClaudeSessionId];
      if (savedWorktree) resumeArgs.push('--worktree', savedWorktree);
      const shell = spawnClaude(resumeArgs, cwd, ptySize);
      const startTime = Date.now();
      const restoredName = name || restored.name || null;
      shells.set(id, { shell, clients: new Set(), cwd, claudeSessionId: newClaudeSessionId, worktree: savedWorktree, name: restoredName, restored: true, waitingForInput: false, lastActivity: Date.now() });
      wireShellOutput(id);
      shell.onExit(() => {
        if (shuttingDown) return;  // Don't overwrite state file during shutdown
        const elapsed = Date.now() - startTime;
        if (elapsed < 5000 && oldClaudeSessionId) {
          // --resume failed quickly, fall back to continuing last conversation
          log(`Session ${id} exited after ${elapsed}ms, --resume likely failed. Falling back to -c`);
          const newClaudeSessionId = randomUUID();
          const entry = shells.get(id);
          const fallbackArgs = ['-c', '--fork-session', '--session-id', newClaudeSessionId];
          if (entry && entry.worktree) fallbackArgs.push('--worktree', entry.worktree);
          const fallbackShell = spawnClaude(fallbackArgs, cwd, { cols: initialCols, rows: initialRows });
          if (entry) {
            entry.shell = fallbackShell;
            entry.claudeSessionId = newClaudeSessionId;
            entry.killed = false;
            entry.scrollback = [];
            entry.scrollbackSize = 0;
            wireShellOutput(id);
            fallbackShell.onExit(() => { if (!shuttingDown) { shells.delete(id); saveState(); } });
            saveState();
          }
        } else {
          shells.delete(id);
          saveState();
        }
      });
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
    const claudeSessionId = randomUUID();  // Full UUID for Claude's --session-id
    const claudeArgs = ['--session-id', claudeSessionId];
    if (planMode) claudeArgs.push('--permission-mode', 'plan');
    if (worktree) claudeArgs.push('--worktree', worktree);
    log(`[WS] Creating NEW shell: oldId=${oldId}, newId=${id}, claudeSession=${claudeSessionId}, worktree=${worktree || 'none'}, cwd=${cwd}`);
    const shell = spawnClaude(claudeArgs, cwd, { cols: initialCols, rows: initialRows });
    shells.set(id, { shell, clients: new Set(), cwd, claudeSessionId, worktree: worktree || null, name: name || null, waitingForInput: false, lastActivity: Date.now() });
    wireShellOutput(id);
    shell.onExit(() => { if (!shuttingDown) { shells.delete(id); saveState(); } });
    saveState();
  }

  const entry = shells.get(id);
  // Cancel any pending kill timer on reconnect
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
  }
  entry.clients.add(ws);
  const hasScrollback = entry.scrollback && entry.scrollback.length > 0;
  log(`[WS] Sending session response: id=${id}, restored=${entry.restored || false}, scrollback=${hasScrollback ? entry.scrollbackSize + 'B' : 'none'}`);
  ws.send(JSON.stringify({ type: 'session', id, restored: entry.restored || false, cwd: entry.cwd, name: entry.name || null, scrollback: hasScrollback }));

  // Send buffered scrollback so the client can render the terminal immediately
  if (hasScrollback) {
    for (const chunk of entry.scrollback) {
      ws.send(chunk);
    }
  }

  ws.on('message', (msg) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize') { entry.shell.resize(parsed.cols, parsed.rows); return; }
      if (parsed.type === 'redraw') { entry.shell.write('\x0c'); return; } // Ctrl+L
      if (parsed.type === 'initialPrompt') { entry.initialPrompt = parsed.text; return; }
      if (parsed.type === 'rename') { entry.name = parsed.name || null; return; }
    } catch {}
    // User sent input - update activity and clear waiting state
    entry.lastActivity = Date.now();
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
          // Preserve session info so it can be restored on next connect
          savedState[id] = { cwd: entry.cwd, claudeSessionId: entry.claudeSessionId, worktree: entry.worktree || null, name: entry.name || null, lastActivity: entry.lastActivity || null };
          killShell(entry, id);
          shells.delete(id);
          saveState();
        }
      }, 30000);
    }
  });
});

// Broadcast a JSON message to all connected browser WebSocket clients
function broadcast(msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Initialize MCP server (async, ~100ms for dynamic import)
initMCP({ app, shells, wss, broadcast, log, MODS_DIR }).catch(e => log('MCP init failed:', e.message));

// Watch themes directory for changes and broadcast to clients
let themeWatchDebounce = null;
try {
  fs.watch(THEMES_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith('.css')) return;
    clearTimeout(themeWatchDebounce);
    themeWatchDebounce = setTimeout(() => {
      const name = filename.replace(/\.css$/, '');
      // Only broadcast if this is the active theme
      if (settings.activeTheme === name) {
        const css = readThemeCSS(name);
        if (css !== null) {
          log(`Active theme file changed: ${name}, broadcasting update`);
          broadcastTheme(name, css);
        }
      }
    }, 200);
  });
} catch (e) {
  console.error('Failed to watch themes directory:', e.message);
}

// Watch mod directories for changes and broadcast to clients
const modWatchers = new Map(); // modId → fs.FSWatcher
function watchModDirs() {
  // Clean up existing watchers
  for (const [, watcher] of modWatchers) { try { watcher.close(); } catch {} }
  modWatchers.clear();

  if (!fs.existsSync(MODS_DIR)) return;
  const entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const modId = entry.name;
    const modDir = path.join(MODS_DIR, modId);
    let debounce = null;
    try {
      const watcher = fs.watch(modDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          log(`Mod file changed: ${modId}/${filename}, broadcasting reload`);
          broadcast({ type: 'mod-changed', modId });
        }, 200);
      });
      modWatchers.set(modId, watcher);
    } catch (e) {
      console.error(`Failed to watch mod directory ${modId}:`, e.message);
    }
  }
  log(`Watching ${modWatchers.size} mod directories for changes`);
}
watchModDirs();
