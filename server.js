const express = require('express');
const https = require('https');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { execSync, execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { initMCP } = require('./mcp-server');
const NodePtyEngine = require('./engines/node-pty');
const TmuxEngine = require('./engines/tmux');

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

// HTTPS support (opt-in)
function parseCLIFlag(name) {
  return process.argv.includes('--' + name);
}
function parseCLIValue(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--' + name + '=')) return args[i].slice(name.length + 3);
  }
  return null;
}
const HTTPS_ENABLED = parseCLIFlag('https') || process.env.DEEPSTEVE_HTTPS === '1';
const HTTPS_PORT = parseInt(parseCLIValue('https-port') || process.env.DEEPSTEVE_HTTPS_PORT) || 3443;
const CERTS_DIR = path.join(os.homedir(), '.deepsteve', 'certs');
const AUTOMATIONS_DIR = path.join(os.homedir(), '.deepsteve', 'automations');

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
const pendingOpens = []; // open-session messages waiting for a browser to connect
let restartState = null; // { resolve: fn, timeout: timer } — first browser response wins

function log(...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}
const STATE_FILE = path.join(os.homedir(), '.deepsteve', 'state.json');
const DISPLAY_TABS_DIR = path.join(os.homedir(), '.deepsteve', 'display-tabs');
const SETTINGS_FILE = path.join(os.homedir(), '.deepsteve', 'settings.json');
const app = express();
app.use(express.static('public'));
app.use('/mods', express.static('mods'));
app.use((req, res, next) => {
  if (req.path === '/mcp') return next(); // MCP SDK parses its own body
  express.json()(req, res, next);
});

// Proxy endpoint for Baby Browser — fetches URLs and strips iframe-blocking headers.
// Resources (CSS/JS/images) load directly from origin via <base> tag — only HTML
// pages need proxying to bypass X-Frame-Options.
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url;
  log(`[proxy] url=${url}`);
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  try {
    const resp = await fetch(parsed.href, {
      headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0' },
      redirect: 'follow',
    });
    res.status(resp.status);
    const skipHeaders = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'content-encoding', 'transfer-encoding', 'connection']);
    for (const [key, value] of resp.headers.entries()) {
      if (!skipHeaders.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    const contentType = resp.headers.get('content-type') || '';
    let body = Buffer.from(await resp.arrayBuffer());
    if (contentType.includes('text/html')) {
      const finalUrl = new URL(resp.url);
      const origin = finalUrl.origin;
      let html = body.toString('utf-8');
      // Rewrite only <a href> and <form action> — not <link href> (stylesheets) or other tags.
      // Resources load directly from origin via <base> tag.
      html = html.replace(/<(a\s[^>]*?)href="(\/[^"]*?)"([^>]*?>)/gi, (match, pre, pathVal, post) => {
        if (pathVal.startsWith('//')) return match;
        if (pathVal === '#' || pathVal.startsWith('/#')) return match;
        const absolute = new URL(pathVal, origin + '/').href;
        return `<${pre}href="/api/proxy?url=${encodeURIComponent(absolute)}"${post}`;
      });
      html = html.replace(/<(a\s[^>]*?)href="(https?:\/\/[^"]*?)"([^>]*?>)/gi, (match, pre, urlVal, post) => {
        try {
          const u = new URL(urlVal);
          if (u.origin === origin) {
            return `<${pre}href="/api/proxy?url=${encodeURIComponent(urlVal)}"${post}`;
          }
        } catch {}
        return match;
      });
      html = html.replace(/<(form\s[^>]*?)action="(\/[^"]*?)"([^>]*?>)/gi, (match, pre, pathVal, post) => {
        if (pathVal.startsWith('//')) return match;
        const absolute = new URL(pathVal, origin + '/').href;
        return `<${pre}action="/api/proxy?url=${encodeURIComponent(absolute)}"${post}`;
      });
      // Inject <base> so resources (CSS/JS/images) with relative src resolve to origin
      const baseTag = `<base href="${origin}/">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
      } else if (/<html[^>]*>/i.test(html)) {
        html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
      } else {
        html = baseTag + html;
      }
      body = Buffer.from(html, 'utf-8');
      res.setHeader('content-length', body.length);
    }
    res.send(body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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
  activeTheme: 'retro-monitor',
  wandPlanMode: true,
  wandPromptTemplate: `I need you to work on GitHub issue #{{number}}: "{{title}}"
Labels: {{labels}}
URL: {{url}}

Issue description:
{{body}}

Please read the issue carefully, understand the codebase context, and implement the changes needed.`,
  defaultAgent: 'claude',
  opencodeBinary: 'opencode',
  geminiBinary: 'gemini',
  enabledAgents: ['claude', 'opencode'],
  commandPaletteEnabled: true,
  commandPaletteShortcut: 'Meta+k',
  engine: 'node-pty'
};

// Load settings
let settings = { shellProfile: '~/.zshrc', maxIssueTitleLength: 25, cmdTabSwitch: false, cmdTabSwitchHoldMs: 1000, enabledSkills: [], windowConfigs: [], symlinkWorktreeSettings: false, ...SETTINGS_DEFAULTS };
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

// --- Engine initialization ---
let engine;
function initEngine() {
  if (settings.engine === 'tmux') {
    const tmux = new TmuxEngine();
    if (tmux.available) {
      engine = tmux;
      log(`Engine: tmux v${tmux.version}`);
      return;
    }
    log('Engine: tmux requested but not available, falling back to node-pty');
    settings.engine = 'node-pty';
    saveSettings();
  }
  engine = new NodePtyEngine();
  log('Engine: node-pty');
}
initEngine();

function getShellProfilePath() {
  let p = settings.shellProfile || '~/.zshrc';
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

// --- HTTPS certificate management ---

function getLanAddresses() {
  const ifaces = os.networkInterfaces();
  const addrs = new Set(['localhost', '127.0.0.1']);
  for (const [, entries] of Object.entries(ifaces)) {
    for (const entry of entries) {
      if (entry.family !== 'IPv4') continue;
      if (BIND === '0.0.0.0' || BIND === entry.address) {
        addrs.add(entry.address);
      }
    }
  }
  return [...addrs];
}

function certsMatchCurrentIPs() {
  const metaFile = path.join(CERTS_DIR, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const currentIPs = getLanAddresses().sort().join(',');
    const savedIPs = (meta.sans || []).sort().join(',');
    if (currentIPs !== savedIPs) return false;
    // Check if cert files exist
    if (!fs.existsSync(path.join(CERTS_DIR, 'key.pem'))) return false;
    if (!fs.existsSync(path.join(CERTS_DIR, 'cert.pem'))) return false;
    // Check expiry — regenerate if within 7 days
    if (meta.expires && Date.now() > meta.expires - 7 * 24 * 60 * 60 * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

async function ensureCerts() {
  if (certsMatchCurrentIPs()) {
    const meta = JSON.parse(fs.readFileSync(path.join(CERTS_DIR, 'meta.json'), 'utf8'));
    log(`HTTPS: Using existing certificates (${meta.method}, expires ${new Date(meta.expires).toISOString().slice(0, 10)})`);
    return {
      key: fs.readFileSync(path.join(CERTS_DIR, 'key.pem')),
      cert: fs.readFileSync(path.join(CERTS_DIR, 'cert.pem'))
    };
  }

  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const sans = getLanAddresses();
  log(`HTTPS: Generating certificates for: ${sans.join(', ')}`);

  // Try mkcert first (locally-trusted, no browser warnings)
  try {
    execFileSync('mkcert', [
      '-key-file', path.join(CERTS_DIR, 'key.pem'),
      '-cert-file', path.join(CERTS_DIR, 'cert.pem'),
      ...sans
    ], { stdio: 'pipe', timeout: 15000 });
    const expires = Date.now() + 365 * 24 * 60 * 60 * 1000; // mkcert default ~2y, estimate 1y
    fs.writeFileSync(path.join(CERTS_DIR, 'meta.json'), JSON.stringify({ method: 'mkcert', sans, expires, generated: Date.now() }));
    fs.chmodSync(path.join(CERTS_DIR, 'key.pem'), 0o600);
    log('HTTPS: Certificates generated with mkcert (locally-trusted, no browser warnings)');
    return {
      key: fs.readFileSync(path.join(CERTS_DIR, 'key.pem')),
      cert: fs.readFileSync(path.join(CERTS_DIR, 'cert.pem'))
    };
  } catch (e) {
    log(`HTTPS: mkcert unavailable (${e.message.split('\n')[0]}), falling back to selfsigned`);
  }

  // Fallback: selfsigned package (self-signed, browser warning on first connect)
  const selfsigned = require('selfsigned');
  const altNames = sans.map(s => {
    if (net.isIP(s)) return { type: 7, ip: s };
    return { type: 2, value: s };
  });
  const attrs = [{ name: 'commonName', value: 'deepsteve' }];
  const pems = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }]
  });
  const expires = Date.now() + 365 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(CERTS_DIR, 'key.pem'), pems.private);
  fs.writeFileSync(path.join(CERTS_DIR, 'cert.pem'), pems.cert);
  fs.writeFileSync(path.join(CERTS_DIR, 'meta.json'), JSON.stringify({ method: 'selfsigned', sans, expires, generated: Date.now() }));
  fs.chmodSync(path.join(CERTS_DIR, 'key.pem'), 0o600);
  log('HTTPS: Certificates generated with selfsigned (self-signed, browser will show warning on first connect)');
  return { key: pems.private, cert: pems.cert };
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
  if (httpsWss) {
    for (const client of httpsWss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  // Also send to live-reload clients so tabs with no sessions still get theme updates
  for (const client of reloadClients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function broadcastSettings() {
  const msg = JSON.stringify({
    type: 'settings',
    maxIssueTitleLength: settings.maxIssueTitleLength,
    cmdTabSwitch: settings.cmdTabSwitch,
    cmdTabSwitchHoldMs: settings.cmdTabSwitchHoldMs,
    commandPaletteEnabled: settings.commandPaletteEnabled,
    commandPaletteShortcut: settings.commandPaletteShortcut,
    symlinkWorktreeSettings: settings.symlinkWorktreeSettings,
    windowConfigs: settings.windowConfigs || [],
    engine: settings.engine || 'node-pty',
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  if (httpsWss) {
    for (const client of httpsWss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  for (const client of reloadClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastSkills() {
  const msg = JSON.stringify({
    type: 'skills-changed',
    enabledSkills: settings.enabledSkills || [],
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  if (httpsWss) {
    for (const client of httpsWss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  for (const client of reloadClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/**
 * Spawn a session using the active engine.
 * @param {string} id - Session ID
 * @param {string} agentType - 'claude', 'opencode', or 'gemini'
 * @param {string[]} args - Agent CLI arguments
 * @param {string} cwd - Working directory
 * @param {{ cols?: number, rows?: number, env?: object }} opts
 */
function spawnSession(id, agentType, args, cwd, { cols = 120, rows = 40, env: extraEnv } = {}) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  if (agentType === 'terminal') {
    engine.spawn(id, 'zsh', ['-l'], cwd, { cols, rows, env });
    return;
  }
  const bin = agentType === 'claude' ? 'claude'
    : agentType === 'opencode' ? (settings.opencodeBinary || 'opencode')
    : (settings.geminiBinary || 'gemini');
  const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  engine.spawn(id, 'zsh', ['-l', '-c', `${bin} ${quoted}`], cwd, { cols, rows, env });
}

// Agent capabilities and argument mapping
const AGENT_CONFIGS = {
  claude: {
    supportsWorktree: true,
    supportsSessionId: true,
    supportsSessionWatch: true,
    emitsBel: true,
    exitMethod: 'exit-cmd', // uses /exit
    initialPromptDelay: 0,
    sessionIdFlag: '--session-id',
    planModeFlag: '--permission-mode',
    planModeValue: 'plan',
    resumeFlag: '--resume',
    resumeDefault: '-c'
  },
  gemini: {
    supportsWorktree: false,
    supportsSessionId: false, // Managed internally
    supportsSessionWatch: false,
    emitsBel: false,
    exitMethod: 'ctrl-c',
    initialPromptDelay: 3000,
    planModeFlag: '--approval-mode',
    planModeValue: 'plan',
    resumeFlag: '-r',
    resumeDefault: '-c'
  },
  opencode: {
    supportsWorktree: false,
    supportsSessionId: true,
    supportsSessionWatch: false,
    emitsBel: false,
    exitMethod: 'ctrl-c',
    initialPromptDelay: 3000,
    sessionIdFlag: '--session',
    planModeFlag: '--agent',
    planModeValue: 'plan',
    resumeFlag: '--session', // uses --session ID --continue
    resumeDefault: '--continue'
  },
  terminal: {
    supportsWorktree: false,
    supportsSessionId: false,
    supportsSessionWatch: false,
    emitsBel: false,
    exitMethod: 'ctrl-c',
    initialPromptDelay: 0,
  }
};

function getAgentConfig(agentType) {
  return AGENT_CONFIGS[agentType] || AGENT_CONFIGS.claude;
}

// Kept for backward compatibility with MCP context — delegates to spawnSession
function spawnAgent(id, agentType, args, cwd, opts = {}) {
  spawnSession(id, agentType, args, cwd, opts);
}

function getSpawnArgs(agentType, { sessionId, planMode, worktree }) {
  const config = getAgentConfig(agentType);
  const args = [];

  if (config.supportsSessionId && sessionId) {
    args.push(config.sessionIdFlag, sessionId);
  }

  if (planMode && config.planModeFlag) {
    args.push(config.planModeFlag, config.planModeValue);
  }

  if (worktree && config.supportsWorktree) {
    args.push('--worktree', worktree);
  }

  return args;
}

function getResumeArgs(agentType, { sessionId, worktree }) {
  const config = getAgentConfig(agentType);
  const args = [];

  if (sessionId) {
    args.push(config.resumeFlag, sessionId);
    if (agentType === 'opencode') args.push('--continue');
  } else {
    args.push(config.resumeDefault);
  }

  if (worktree && config.supportsWorktree) {
    args.push('--worktree', worktree);
  }

  return args;
}

function validateWorktree(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 128) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) return null;
  return value;
}

function getWorktreePath(cwd, name) {
  // Use the same structure as Claude Code
  return path.join(cwd, '.claude', 'worktrees', name);
}

function ensureWorktree(cwd, name) {
  const worktreePath = getWorktreePath(cwd, name);
  if (fs.existsSync(worktreePath)) {
    symlinkWorktreeClaudeSettings(cwd, worktreePath);
    return worktreePath;
  }
  try {
    log(`Creating git worktree: ${name} in ${cwd}`);
    execSync(`zsh -l -c 'git worktree add "${worktreePath}"'`, { cwd, encoding: 'utf8', timeout: 30000 });
    symlinkWorktreeClaudeSettings(cwd, worktreePath);
    return worktreePath;
  } catch (e) {
    log(`Failed to create worktree ${worktreePath}: ${e.message}`);
    // If it fails, maybe the branch already exists or it's not a git repo.
    // We attempt to return the path anyway if it was created, or fallback.
    const result = fs.existsSync(worktreePath) ? worktreePath : cwd;
    if (result !== cwd) symlinkWorktreeClaudeSettings(cwd, result);
    return result;
  }
}

function symlinkWorktreeClaudeSettings(parentCwd, worktreePath) {
  if (!settings.symlinkWorktreeSettings) return;
  const source = path.join(parentCwd, '.claude', 'settings.local.json');
  const targetDir = path.join(worktreePath, '.claude');
  const target = path.join(targetDir, 'settings.local.json');
  if (!fs.existsSync(source)) return;
  // If target exists but isn't a symlink, replace the copy with a symlink
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return; // already symlinked
    fs.unlinkSync(target); // remove the copy
    log(`Replacing copied settings with symlink: ${target}`);
  } catch (e) {
    if (e.code !== 'ENOENT') return; // unexpected error, bail
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const relSource = path.relative(targetDir, source);
  fs.symlinkSync(relSource, target);
  log(`Symlinked worktree Claude settings: ${target} -> ${relSource}`);
}

// --- Claude session directory watcher ---
// Watches ~/.claude/projects/<project>/ for .jsonl file changes to detect
// session forks (e.g., plan mode exit creates a new session). Updates
// claudeSessionId so the next restart resumes the correct session.

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function claudeProjectDir(cwd, worktree) {
  // Claude Code stores sessions in a directory named after the resolved cwd.
  // For worktree sessions, the cwd is <repo>/.claude/worktrees/<name>.
  let resolvedCwd = cwd;
  if (worktree) {
    resolvedCwd = path.join(cwd, '.claude', 'worktrees', worktree);
  }
  // Claude Code encodes cwds by replacing all non-alphanumeric/non-dash chars with dashes
  const dirName = resolvedCwd.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(CLAUDE_PROJECTS_DIR, dirName);
}

function watchClaudeSessionDir(shellId) {
  const entry = shells.get(shellId);
  if (!entry) return;

  const projectDir = claudeProjectDir(entry.cwd, entry.worktree);

  // Ensure the directory exists before watching
  try { fs.mkdirSync(projectDir, { recursive: true }); } catch (err) {
    log(`Session ${shellId} failed to create Claude session dir ${projectDir}: ${err.message}`);
  }

  log(`Session ${shellId} watching Claude session dir: ${projectDir}`);

  let watcher;
  try {
    watcher = fs.watch(projectDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const sessionId = filename.replace('.jsonl', '');
      if (!UUID_RE.test(sessionId)) return;

      const e = shells.get(shellId);
      if (!e || sessionId === e.claudeSessionId) return;

      log(`Session ${shellId} checking potential fork file: ${filename}`);

      // Verify the new file references our current session (forks include the parent sessionId)
      try {
        const newFile = path.join(projectDir, filename);
        const head = fs.readFileSync(newFile, 'utf8').slice(0, 32768);
        if (!head.includes(e.claudeSessionId)) {
          log(`Session ${shellId} file ${filename} does not reference current session ${e.claudeSessionId}, skipping`);
          return;
        }

        log(`Session ${shellId} detected session fork via fs.watch: ${e.claudeSessionId} → ${sessionId}`);
        e.claudeSessionId = sessionId;
        saveState();
      } catch (err) {
        log(`Session ${shellId} fork check failed for ${filename}: ${err.message}, retrying in 200ms`);
        setTimeout(() => {
          try {
            const e2 = shells.get(shellId);
            if (!e2 || sessionId === e2.claudeSessionId) return;
            const head = fs.readFileSync(path.join(projectDir, filename), 'utf8').slice(0, 32768);
            if (!head.includes(e2.claudeSessionId)) return;
            log(`Session ${shellId} detected fork (retry): ${e2.claudeSessionId} → ${sessionId}`);
            e2.claudeSessionId = sessionId;
            saveState();
          } catch (retryErr) {
            log(`Session ${shellId} fork retry failed for ${filename}: ${retryErr.message}`);
          }
        }, 200);
      }
    });
  } catch (err) {
    log(`Failed to watch Claude session dir for ${shellId}: ${err.message}`);
    return;
  }

  entry.sessionDirWatcher = watcher;
}

function unwatchClaudeSessionDir(shellId) {
  const entry = shells.get(shellId);
  if (entry && entry.sessionDirWatcher) {
    entry.sessionDirWatcher.close();
    entry.sessionDirWatcher = null;
  }
}

/**
 * Write a prompt to a Claude PTY as if a user typed it and pressed Enter.
 *
 * Ink's input-parser treats \r inside a text chunk as pasted text — it only
 * recognizes Enter when \r arrives as its own stdin read. So we write the
 * text first, then send \r in a separate write after a short delay to ensure
 * they land in different readable events.
 */
function submitToShell(id, text, eng) {
  (eng || engine).write(id, text);
  setTimeout(() => (eng || engine).write(id, '\r'), 1000);
}

/**
 * Async wrapper around `gh issue view` — returns { body, labels, url } or null.
 * Uses exec (not execSync) so it doesn't block the event loop.
 */
function fetchIssueFromGitHub(number, cwd) {
  return new Promise((resolve) => {
    exec(`zsh -l -c 'gh issue view ${Number(number)} --json body,labels,url'`,
      { cwd, encoding: 'utf8', timeout: 15000 },
      (err, stdout) => {
        if (err) { log(`[gh] Failed to fetch issue #${number}: ${err.message}`); resolve(null); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}

/**
 * Deliver a prompt to a shell, handling the race between async fetch and BEL readiness.
 * If the shell is already waiting for input, submit immediately.
 * If the agent uses initialPromptDelay (non-BEL), use that delay.
 * Otherwise, set initialPrompt so the BEL handler picks it up.
 */
function deliverPromptWhenReady(id, prompt) {
  const e = shells.get(id);
  if (!e) return;
  const config = getAgentConfig(e.agentType);
  if (e.waitingForInput) {
    e.waitingForInput = false;
    setTimeout(() => submitToShell(id, prompt), 500);
  } else if (config.initialPromptDelay > 0) {
    setTimeout(() => submitToShell(id, prompt), config.initialPromptDelay);
  } else {
    e.initialPrompt = prompt;  // BEL handler will pick it up
  }
}

/**
 * Strip OSC sequences (e.g. window title updates like \x1b]0;Claude Code\x07)
 * so that the BEL terminator inside them isn't mistaken for a standalone BEL.
 */
function stripOSC(data) {
  return data.replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, '');
}

/**
 * Strip all known ANSI escape sequences, preserving printable text and whitespace.
 * Used for UUID matching in resume detection.
 */
function stripEscapeSequences(data) {
  return data
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, '')  // OSC
    .replace(/\x1b\[[0-9;?]*[a-zA-Z@`]/g, '')       // CSI (including private params like ?25h)
    .replace(/\x1b[()][A-Z0-9]/g, '')                // SCS (character set selection)
    .replace(/\x1b[78DMHNOcn=><]/g, '');              // Single-char escapes
}

/**
 * Strip all escapes AND whitespace/BEL — used to check whether PTY output
 * contains any substantive visible content.
 */
function stripAllEscapes(data) {
  return stripEscapeSequences(data).replace(/[\s\x07]/g, '');
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

  const dataHandler = (sid, data) => {
    if (sid !== id) return;
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
    // Generic: detect session ID updates and BEL for input state tracking.
    const config = getAgentConfig(e.agentType);

    if (config.emitsBel) {
      // Detect claude --resume <UUID> in PTY output to track the actual session ID.
      // Claude prints this line when a session exits (including /exit, /clear, shutdown).
      // Strip all ANSI escapes before matching so dim/bold/OSC wrappers don't interfere.
      const plain = stripEscapeSequences(data);
      const resumeMatch = plain.match(/claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (resumeMatch) {
        const newSessionId = resumeMatch[1];
        if (newSessionId !== e.claudeSessionId) {
          log(`Session ${id} claude session updated: ${e.claudeSessionId} → ${newSessionId}`);
          e.claudeSessionId = newSessionId;
          // During shutdown, saveState() is blocked by stateFrozen and the process may be
          // killed before the final save block runs. Write the updated ID to disk immediately
          // so it survives even if the process is killed mid-shutdown.
          if (shuttingDown) {
            try {
              const current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
              if (current[id]) {
                current[id].claudeSessionId = newSessionId;
                fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
                log(`Session ${id} patched state.json during shutdown`);
              }
            } catch (err) {
              console.error('Failed to patch state.json during shutdown:', err.message);
            }
          }
        }
      }
      const hasBel = data.includes('\x07');

      if (hasBel) {
        e.lastBelTime = Date.now();
        if (!e.waitingForInput) {
          e.waitingForInput = true;
          const stateMsg = JSON.stringify({ type: 'state', waiting: true });
          e.clients.forEach((c) => c.send(stateMsg));

          if (e.initialPrompt) {
            const prompt = e.initialPrompt;
            e.initialPrompt = null;
            e.waitingForInput = false;
            setTimeout(() => submitToShell(id, prompt), 500);
          }
        }
        // If already waiting, the BEL just refreshes lastBelTime (keeps it stable)
      } else if (e.waitingForInput) {
        // PTY produced non-BEL output while we thought Claude was waiting —
        // but Ink re-renders arrive 50-150ms after BEL in the same render cycle.
        // Debounce: ignore content within 150ms of the last BEL.
        if (e.lastBelTime && (Date.now() - e.lastBelTime) < 150) {
          // Same Ink render cycle — ignore this chunk
        } else {
          // Enough time has passed; check for substantive visible content
          const stripped = stripAllEscapes(data);
          if (stripped.length > 0) {
            e.waitingForInput = false;
            const stateMsg = JSON.stringify({ type: 'state', waiting: false });
            e.clients.forEach((c) => c.send(stateMsg));
          }
        }
      }
    }
    e.clients.forEach((c) => c.send(data));
  };

  engine.on('data', dataHandler);
  // Store reference for cleanup
  entry._engineDataHandler = dataHandler;
}

// Gracefully kill a shell
function killShell(entry, id) {
  if (entry.killed) return;
  entry.killed = true;
  const eng = engine;  // Capture — survives async initEngine() swaps

  // tmux-attach sessions manage their own PTY — just detach
  if (entry.agentType === 'tmux-attach') {
    if (entry._attachPty) {
      try { entry._attachPty.kill(); } catch {}
    }
    return;
  }

  const pid = eng.getPid(id);
  const config = getAgentConfig(entry.agentType);
  log(`Killing shell ${id} (pid=${pid}, agent=${entry.agentType || 'claude'}, waitingForInput=${entry.waitingForInput})`);

  // Clean up engine data listener
  if (entry._engineDataHandler) {
    eng.removeListener('data', entry._engineDataHandler);
    entry._engineDataHandler = null;
  }

  if (config.exitMethod === 'ctrl-c') {
    // Agent just needs Ctrl+C (OpenCode, Gemini)
    try { eng.write(id, '\x03'); } catch {}
  } else if (config.exitMethod === 'exit-cmd') {
    // Agent supports /exit command (Claude)
    if (entry.waitingForInput) {
      // Safe to send /exit directly
      try { submitToShell(id, '/exit', eng); } catch {}
    } else {
      // Claude is busy — send Ctrl+C to interrupt, then /exit when it's ready
      try { eng.write(id, '\x03'); } catch {}
      // Watch for BEL (Claude back at prompt), then send /exit
      const exitHandler = (sid, data) => {
        if (sid !== id) return;
        if (data.includes('\x07')) {
          eng.removeListener('data', exitHandler);
          try { submitToShell(id, '/exit', eng); } catch {}
        }
      };
      eng.on('data', exitHandler);
    }
  } else {
    // Default fallback: just kill the process group
    try { eng.kill(id, 'SIGTERM'); } catch {}
  }

  // After 8 seconds, escalate to SIGTERM
  setTimeout(() => {
    const currentPid = eng.getPid(id);
    if (!currentPid) return; // Already dead
    try {
      process.kill(currentPid, 0); // Check if still alive
      log(`Shell ${id} still alive after /exit, sending SIGTERM`);
      eng.kill(id, 'SIGTERM');
    } catch { return; } // Already dead

    // After 2 more seconds, escalate to SIGKILL
    setTimeout(() => {
      const pid2 = eng.getPid(id);
      if (!pid2) return;
      try {
        process.kill(pid2, 0);
        log(`Shell ${id} still alive, sending SIGKILL`);
        eng.kill(id, 'SIGKILL');
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

// Load persisted display tabs from disk and clean up stale files (>7 days)
try {
  if (fs.existsSync(DISPLAY_TABS_DIR)) {
    const now = Date.now();
    const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(DISPLAY_TABS_DIR)) {
      if (!file.endsWith('.html')) continue;
      const filePath = path.join(DISPLAY_TABS_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE) {
        fs.unlinkSync(filePath);
        log(`[display-tab] Cleaned up stale file: ${file}`);
        continue;
      }
      const id = file.replace(/\.html$/, '');
      displayTabs.set(id, fs.readFileSync(filePath, 'utf8'));
    }
    if (displayTabs.size > 0) log(`Loaded ${displayTabs.size} display tabs from disk`);
  }
} catch (e) {
  console.error('Failed to load display tabs:', e.message);
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
    if (entry.agentType === 'tmux-attach') continue; // ephemeral — don't persist
    state[id] = { cwd: entry.cwd, claudeSessionId: entry.claudeSessionId, agentType: entry.agentType || 'claude', worktree: entry.worktree || null, name: entry.name || null, lastActivity: entry.lastActivity || null, createdAt: entry.createdAt || null, windowId: entry.windowId || null };
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
      // Graceful close sends the buffered reload message then a close frame,
      // guaranteeing the browser receives onmessage before onclose.
      try { ws.close(); } catch {}
      // Remove from wss.clients so wss.close() won't terminate() this
      // connection (terminate() is a hard TCP drop that can discard data).
      wss.clients.delete(ws);
      if (httpsWss) httpsWss.clients.delete(ws);
    }
    reloadClients.clear();
  }
  stateFrozen = true;  // Prevent onExit/onClose handlers from overwriting state file

  // Stop accepting new connections so clients can't reconnect to the dying server.
  // Without this, clients reconnect during the ~8s graceful shutdown window,
  // then get disconnected again when the process exits (causing a double reconnect).
  server.close();
  wss.close();
  if (httpsServer) httpsServer.close();
  if (httpsWss) httpsWss.close();

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
  log(`Gracefully exiting ${entries.length} shells...`);
  for (const [id, entry] of entries) {
    try {
      killShell(entry, id);
    } catch {}
  }

  // Phase 2: Wait up to 8s for shells to exit naturally (1s for \r delay + time to save)
  const alive = new Set(entries.map(([id]) => id));
  for (const [id] of entries) {
    engine.onExit(id, () => alive.delete(id));
  }

  const deadline = Date.now() + 8000;
  while (alive.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }

  // Wait for pending PTY onData callbacks to drain — the `--resume <UUID>` line
  // arrives from /exit output after the shell process exits, so we need a tick
  // for those callbacks to update claudeSessionId before we save.
  await new Promise(r => setTimeout(r, 500));

  // Final state save: capture session IDs updated from /exit output during shutdown.
  // This bypasses stateFrozen since it's the authoritative final snapshot.
  {
    const state = {};
    for (const [sid, sentry] of shells) {
      if (sentry.agentType === 'tmux-attach') continue;
      state[sid] = { cwd: sentry.cwd, claudeSessionId: sentry.claudeSessionId, agentType: sentry.agentType || 'claude', worktree: sentry.worktree || null, name: sentry.name || null, lastActivity: sentry.lastActivity || null };
    }
    const merged = { ...savedState, ...state };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
      log(`Final state save: ${Object.keys(merged).length} sessions`);
    } catch (e) {
      console.error('Failed final state save:', e.message);
    }
  }

  if (alive.size === 0) {
    log('All shells exited gracefully');
    process.exit(0);
  }

  // Phase 3: SIGTERM remaining
  log(`${alive.size} shells still alive, sending SIGTERM...`);
  for (const id of alive) {
    try { engine.kill(id, 'SIGTERM'); } catch {}
  }

  // Phase 4: Wait 2s more, then force kill
  await new Promise(r => setTimeout(r, 2000));
  for (const id of alive) {
    try { engine.kill(id, 'SIGKILL'); } catch {}
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
    const resp = await fetch('https://api.github.com/repos/deepsteve/deepsteve/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const release = await resp.json();
    const latest = release.tag_name.replace(/^v/, '');
    const updateAvailable = compareSemver(current, latest) < 0;
    res.json({ current, latest, updateAvailable });
  } catch (e) {
    log(`Version check failed: ${e.message}`);
    res.json({ current, latest: null, updateAvailable: false });
  }
});

app.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

app.get('/api/agents', (req, res) => {
  const enabledAgents = settings.enabledAgents || ['claude'];
  const defaultAgent = settings.defaultAgent || 'claude';
  const agents = [
    { id: 'claude', name: 'Claude Code', shortName: 'CC', available: true, enabled: enabledAgents.includes('claude'), isDefault: defaultAgent === 'claude' }
  ];
  // Check if opencode is installed (use login shell for full PATH)
  let opencodeAvailable = false;
  try {
    const bin = settings.opencodeBinary || 'opencode';
    execSync(`zsh -l -c 'which ${bin}'`, { timeout: 5000, stdio: 'pipe' });
    opencodeAvailable = true;
  } catch {}
  // Auto-enable available agents
  agents.push({ id: 'opencode', name: 'OpenCode (experimental)', shortName: 'OC', available: opencodeAvailable, enabled: opencodeAvailable, isDefault: defaultAgent === 'opencode' });
  // Check if gemini is installed
  let geminiAvailable = false;
  try {
    const bin = settings.geminiBinary || 'gemini';
    execSync(`zsh -l -c 'which ${bin}'`, { timeout: 5000, stdio: 'pipe' });
    geminiAvailable = true;
  } catch {}
  // Auto-enable available agents
  agents.push({ id: 'gemini', name: 'Gemini (experimental)', shortName: 'Gem', available: geminiAvailable, enabled: geminiAvailable, isDefault: defaultAgent === 'gemini' });
  res.json({ agents, defaultAgent });
});

app.get('/api/settings', (req, res) => {
  const themeCSS = getActiveThemeCSS();
  res.json({ ...settings, themeCSS });
});

app.get('/api/settings/defaults', (req, res) => res.json(SETTINGS_DEFAULTS));

app.get('/api/engines', (req, res) => {
  let tmuxAvailable = false;
  let tmuxVersion = null;
  try {
    const out = execSync("zsh -l -c 'tmux -V'", { encoding: 'utf8', timeout: 5000 }).trim();
    const match = out.match(/(\d+\.\d+)/);
    tmuxVersion = match ? match[1] : out;
    tmuxAvailable = true;
  } catch {}
  res.json({
    engines: [
      { id: 'node-pty', name: 'node-pty (built-in)', available: true },
      { id: 'tmux', name: 'tmux', available: tmuxAvailable, version: tmuxVersion },
    ],
    current: settings.engine || 'node-pty',
  });
});

app.get('/api/tmux-sessions', (req, res) => {
  try {
    const out = execSync("zsh -l -c 'tmux list-sessions -F \"#{session_name}\t#{session_windows}\t#{session_width}\t#{session_height}\t#{session_created}\"'", {
      encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    if (!out) return res.json({ sessions: [] });
    const sessions = out.split('\n').map(line => {
      const [name, windows, width, height, created] = line.split('\t');
      // Check if any deepsteve shell is already attached to this session
      const attached = [...shells.values()].some(e => e.tmuxSession === name);
      return { name, windows: parseInt(windows) || 1, width: parseInt(width), height: parseInt(height), created: parseInt(created) || null, attached };
    });
    res.json({ sessions });
  } catch {
    res.json({ sessions: [] });
  }
});

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
  if (req.body.cmdTabSwitch !== undefined) {
    settings.cmdTabSwitch = !!req.body.cmdTabSwitch;
    log(`Settings updated: cmdTabSwitch=${settings.cmdTabSwitch}`);
  }
  if (req.body.cmdTabSwitchHoldMs !== undefined) {
    settings.cmdTabSwitchHoldMs = Math.max(0, Number(req.body.cmdTabSwitchHoldMs) || 0);
    log(`Settings updated: cmdTabSwitchHoldMs=${settings.cmdTabSwitchHoldMs}`);
  }
  if (req.body.commandPaletteEnabled !== undefined) {
    settings.commandPaletteEnabled = !!req.body.commandPaletteEnabled;
    log(`Settings updated: commandPaletteEnabled=${settings.commandPaletteEnabled}`);
  }
  if (req.body.commandPaletteShortcut !== undefined) {
    settings.commandPaletteShortcut = String(req.body.commandPaletteShortcut);
    log(`Settings updated: commandPaletteShortcut=${settings.commandPaletteShortcut}`);
  }
  if (req.body.enabledAgents !== undefined) {
    const agents = req.body.enabledAgents;
    if (Array.isArray(agents)) {
      const valid = agents.filter(a => a === 'claude' || a === 'opencode' || a === 'gemini');
      if (valid.length > 0) {
        settings.enabledAgents = valid;
        // If only one agent enabled, that's the default
        settings.defaultAgent = valid[0];
        log(`Settings updated: enabledAgents=${valid.join(',')}, defaultAgent=${settings.defaultAgent}`);
      }
    }
  }
  if (req.body.defaultAgent !== undefined) {
    const agent = String(req.body.defaultAgent);
    if (agent === 'claude' || agent === 'opencode' || agent === 'gemini') {
      settings.defaultAgent = agent;
      log(`Settings updated: defaultAgent=${agent}`);
    }
  }
  if (req.body.opencodeBinary !== undefined) {
    settings.opencodeBinary = String(req.body.opencodeBinary) || 'opencode';
    log(`Settings updated: opencodeBinary=${settings.opencodeBinary}`);
  }
  if (req.body.geminiBinary !== undefined) {
    settings.geminiBinary = String(req.body.geminiBinary) || 'gemini';
    log(`Settings updated: geminiBinary=${settings.geminiBinary}`);
  }
  if (req.body.symlinkWorktreeSettings !== undefined) {
    settings.symlinkWorktreeSettings = !!req.body.symlinkWorktreeSettings;
    log(`Settings updated: symlinkWorktreeSettings=${settings.symlinkWorktreeSettings}`);
  }
  if (req.body.windowConfigs !== undefined) {
    if (Array.isArray(req.body.windowConfigs)) {
      settings.windowConfigs = req.body.windowConfigs.filter(c =>
        c && typeof c === 'object' && typeof c.name === 'string' && Array.isArray(c.tabs)
      ).map(c => ({
        id: c.id || randomUUID().slice(0, 8),
        name: c.name,
        tabs: c.tabs.filter(t => t && typeof t === 'object' && validateConfigTab(t)).map(sanitizeConfigTab),
      }));
      log(`Settings updated: windowConfigs (${settings.windowConfigs.length} configs)`);
    }
  }
  let engineSwitched = false;
  if (req.body.engine !== undefined) {
    const requested = String(req.body.engine);
    if (requested === 'node-pty' || requested === 'tmux') {
      if (requested !== settings.engine) {
        // Validate tmux availability before switching
        if (requested === 'tmux') {
          const check = new TmuxEngine();
          if (!check.available) {
            return res.status(400).json({ error: 'tmux is not installed or not found in PATH' });
          }
        }
        // Check if there are active sessions
        if (shells.size > 0 && !req.body.engineSwitchConfirm) {
          return res.json({ ...settings, engineSwitchRequired: true, activeSessions: shells.size });
        }
        // Kill all active sessions before switching
        if (shells.size > 0) {
          for (const [sid, sentry] of shells) {
            killShell(sentry, sid);
            shells.delete(sid);
          }
          saveState();
        }
        settings.engine = requested;
        initEngine();
        engineSwitched = true;
        log(`Settings updated: engine=${settings.engine}`);
      }
    }
  }
  saveSettings();
  broadcastSettings();
  res.json({ ...settings, ...(engineSwitched ? { engineSwitched: true } : {}) });
});

// --- Command Palette: Custom Commands ---

const COMMANDS_DIR = path.join(os.homedir(), '.deepsteve', 'commands');
try { fs.mkdirSync(COMMANDS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(AUTOMATIONS_DIR, { recursive: true }); } catch {}

const BUILTIN_COMMANDS = [
  { id: 'new-tab', type: 'builtin', name: 'New Tab', description: 'Open a new agent tab' },
  { id: 'new-tab-deepsteve', type: 'builtin', name: 'New Tab in ~/.deepsteve', description: 'Open a tab for editing commands' },
  { id: 'new-terminal', type: 'builtin', name: 'New Terminal', description: 'Open a plain terminal (no agent)' },
  { id: 'new-window', type: 'builtin', name: 'New Window', description: 'Open a new browser window' },
  { id: 'close-tab', type: 'builtin', name: 'Close Tab', description: 'Close the current tab' },
  { id: 'settings', type: 'builtin', name: 'Settings', description: 'Open settings' },
  { id: 'mods', type: 'builtin', name: 'Mods', description: 'Open mods panel' },
  { id: 'next-tab', type: 'builtin', name: 'Next Tab', description: 'Switch to next tab' },
  { id: 'prev-tab', type: 'builtin', name: 'Previous Tab', description: 'Switch to previous tab' },
];

function getCustomCommands() {
  const commands = [];
  let entries;
  try { entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true }); } catch { return commands; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (ext === '.json') continue; // skip sidecar metadata files
    const id = path.basename(entry.name, ext);
    const filePath = path.join(COMMANDS_DIR, entry.name);
    // Check executable
    try { fs.accessSync(filePath, fs.constants.X_OK); } catch { continue; }
    // Check for JSON sidecar
    let name = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let description = 'Custom command';
    const sidecar = path.join(COMMANDS_DIR, id + '.json');
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      if (meta.name) name = meta.name;
      if (meta.description) description = meta.description;
    } catch {}
    commands.push({ id, type: 'custom', name, description });
  }
  return commands;
}

app.get('/api/commands', (req, res) => {
  const custom = getCustomCommands();
  res.json({ commands: [...BUILTIN_COMMANDS, ...custom] });
});

app.post('/api/commands/execute', (req, res) => {
  const { id, sessionId } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  // Built-in commands return action for client-side dispatch
  const builtin = BUILTIN_COMMANDS.find(c => c.id === id);
  if (builtin) {
    return res.json({ action: id });
  }

  // Custom command — find and execute
  let entries;
  try { entries = fs.readdirSync(COMMANDS_DIR); } catch { return res.status(500).json({ error: 'Cannot read commands directory' }); }
  const match = entries.find(f => path.basename(f, path.extname(f)) === id);
  if (!match) return res.status(404).json({ error: 'Command not found' });

  const filePath = path.join(COMMANDS_DIR, match);
  const shell = sessionId ? shells.get(sessionId) : null;
  const env = {
    DEEPSTEVE_SESSION_ID: sessionId || '',
    DEEPSTEVE_CWD: shell?.cwd || process.cwd(),
  };

  try {
    const output = execSync(`zsh -l -c '${filePath.replace(/'/g, "'\\''")}'`, {
      env: { ...process.env, ...env },
      cwd: env.DEEPSTEVE_CWD,
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.json({ ok: false, output: (err.stdout || '') + (err.stderr || ''), exitCode: err.status });
  }
});

// --- Window Config Tab Helpers ---

function validateConfigTab(t) {
  const type = t.type || 'terminal';
  if (type === 'terminal') return typeof t.cwd === 'string';
  if (type === 'display-tab') return typeof t.html === 'string';
  if (type === 'baby-browser') return typeof t.url === 'string';
  return false;
}

function sanitizeConfigTab(t) {
  const type = t.type || 'terminal';
  if (type === 'display-tab') return { type, name: t.name || '', html: t.html };
  if (type === 'baby-browser') return { type, name: t.name || '', url: t.url };
  // terminal (default)
  return { name: t.name || '', cwd: t.cwd, agentType: t.agentType || 'claude' };
}

// --- Window Configs CRUD + Apply ---

app.get('/api/window-configs', (req, res) => {
  res.json({ configs: settings.windowConfigs || [] });
});

app.post('/api/window-configs', (req, res) => {
  const { id, name, tabs } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (!Array.isArray(tabs) || tabs.length === 0) return res.status(400).json({ error: 'tabs array is required' });

  const validTabs = tabs.filter(t => t && typeof t === 'object' && validateConfigTab(t)).map(sanitizeConfigTab);
  if (validTabs.length === 0) return res.status(400).json({ error: 'at least one valid tab is required' });

  if (!settings.windowConfigs) settings.windowConfigs = [];

  if (id) {
    // Update existing
    const idx = settings.windowConfigs.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'config not found' });
    settings.windowConfigs[idx] = { id, name, tabs: validTabs };
  } else {
    // Create new
    const newId = randomUUID().slice(0, 8);
    settings.windowConfigs.push({ id: newId, name, tabs: validTabs });
  }

  saveSettings();
  broadcastSettings();
  res.json({ configs: settings.windowConfigs });
});

app.delete('/api/window-configs/:id', (req, res) => {
  if (!settings.windowConfigs) return res.status(404).json({ error: 'config not found' });
  const idx = settings.windowConfigs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'config not found' });
  settings.windowConfigs.splice(idx, 1);
  saveSettings();
  broadcastSettings();
  res.json({ configs: settings.windowConfigs });
});

app.post('/api/window-configs/:id/apply', (req, res) => {
  const config = (settings.windowConfigs || []).find(c => c.id === req.params.id);
  if (!config) return res.status(404).json({ error: 'config not found' });

  const { windowId } = req.body || {};
  const readyClients = [...reloadClients].filter(c => c.readyState === 1);
  const createdSessions = [];

  function deliverToWindow(msg) {
    const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
    let delivered = false;
    if (windowId) {
      for (const client of readyClients) {
        if (client.windowId === windowId && client.readyState === 1) {
          client.send(msgStr);
          delivered = true;
          break;
        }
      }
    }
    if (!delivered && readyClients.length > 0) {
      // Strip windowId when falling back to first available client
      const parsed = JSON.parse(msgStr);
      delete parsed.windowId;
      readyClients[0].send(JSON.stringify(parsed));
      delivered = true;
    }
    if (!delivered) {
      const parsed = JSON.parse(msgStr);
      delete parsed.windowId;
      pendingOpens.push(JSON.stringify(parsed));
    }
  }

  for (const tab of config.tabs) {
    const tabType = tab.type || 'terminal';

    if (tabType === 'display-tab') {
      const id = randomUUID().slice(0, 8);
      const name = tab.name || 'Display';
      setDisplayTab(id, tab.html);
      createdSessions.push({ id, name, type: 'display-tab' });
      deliverToWindow({ type: 'open-display-tab', id, name, windowId: windowId || undefined });
      continue;
    }

    if (tabType === 'baby-browser') {
      const name = tab.name || 'Baby Browser';
      const url = tab.url || '';
      createdSessions.push({ name, type: 'baby-browser', url });
      deliverToWindow({ type: 'open-mod-tab', modId: 'baby-browser', name, url, windowId: windowId || undefined });
      continue;
    }

    // terminal (default)
    const cwd = tab.cwd.startsWith('~') ? path.join(os.homedir(), tab.cwd.slice(1)) : tab.cwd;
    if (!fs.existsSync(cwd)) {
      log(`[API] window-configs apply: cwd not found: ${cwd}, skipping`);
      continue;
    }

    const agentType = tab.agentType || settings.defaultAgent || 'claude';
    const agentConfig = getAgentConfig(agentType);
    const id = randomUUID().slice(0, 8);
    const claudeSessionId = randomUUID();
    const spawnArgs = getSpawnArgs(agentType, { sessionId: claudeSessionId });
    const name = tab.name || path.basename(cwd);

    spawnSession(id, agentType, spawnArgs, cwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
    shells.set(id, { clients: new Set(), cwd, claudeSessionId, agentType, worktree: null, windowId: windowId || null, name, initialPrompt: null, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
    wireShellOutput(id);
    if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
    engine.onExit(id, () => {
      if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
      if (!shuttingDown) { notifyClientsShellExited(id); shells.delete(id); saveState(); }
    });

    createdSessions.push({ id, name, cwd });
    deliverToWindow({ type: 'open-session', id, cwd, name, windowId: windowId || undefined });
  }

  saveState();
  log(`[API] window-configs apply: config="${config.name}", created ${createdSessions.length} sessions`);
  res.json({ sessions: createdSessions });
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
const BUILTIN_MODS = new Set(['browser-console', 'tasks', 'screenshots', 'go-karts', 'tower', 'deepsteve-core', 'agent-dna']);

// --- Skills system ---
const SKILLS_DIR = path.join(__dirname, 'skills');
const CLAUDE_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Install a skill file: copy source .md to ~/.claude/commands/deepsteve/{id}.md
// Frontmatter `name: {id}` makes the slash command /{id}.
function installSkillFile(id) {
  const src = path.join(SKILLS_DIR, `${id}.md`);
  fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
  const dest = skillDestPath(id);
  fs.copyFileSync(src, dest);
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

// Skill files are installed to ~/.claude/commands/deepsteve/{id}.md
// Frontmatter `name: {id}` makes them available as /{id} slash commands.
const SKILL_DEST_DIR = path.join(CLAUDE_COMMANDS_DIR, 'deepsteve');
function skillDestPath(id) {
  return path.join(SKILL_DEST_DIR, `${id}.md`);
}

// Reconcile enabled skills on startup: ensure .md files exist in ~/.claude/commands/deepsteve/
function reconcileSkills() {
  if (!settings.enabledSkills || settings.enabledSkills.length === 0) return;
  try {
    fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
    const validSkills = [];
    for (const id of settings.enabledSkills) {
      if (!SKILL_ID_RE.test(id)) continue;
      const src = path.join(SKILLS_DIR, `${id}.md`);
      if (fs.existsSync(src)) {
        installSkillFile(id);
        validSkills.push(id);
        // Clean up old deepsteve-{id}.md flat files from prior naming scheme
        const oldDest = path.join(CLAUDE_COMMANDS_DIR, `deepsteve-${id}.md`);
        if (fs.existsSync(oldDest)) fs.unlinkSync(oldDest);
      }
    }
    if (validSkills.length !== settings.enabledSkills.length) {
      settings.enabledSkills = validSkills;
      saveSettings();
    }
  } catch (e) {
    log('Skills reconciliation failed:', e.message);
  }
}

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
        const source = BUILTIN_MODS.has(entry.name) ? 'built-in' : 'official';
        mods.push({ id: entry.name, source, compatible, ...manifest });
      } catch { /* skip dirs without valid mod.json */ }
    }
    // Append skills
    try {
      if (fs.existsSync(SKILLS_DIR)) {
        for (const file of fs.readdirSync(SKILLS_DIR)) {
          if (!file.endsWith('.md')) continue;
          const id = file.slice(0, -3);
          try {
            const content = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8');
            const meta = parseSkillFrontmatter(content);
            mods.push({
              id: `skill:${id}`,
              name: `/${id}`,
              description: meta.description || '',
              type: 'skill',
              source: 'built-in',
              compatible: true,
              version: pkg.version,
              enabled: (settings.enabledSkills || []).includes(id),
              slashCommand: `/${id}`,
              argumentHint: meta['argument-hint'] || null,
            });
          } catch { /* skip unreadable skill files */ }
        }
      }
    } catch { /* skip if skills dir missing */ }

    mods.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ mods, deepsteveVersion: pkg.version });
  } catch (e) {
    res.json({ mods: [], deepsteveVersion: pkg.version });
  }
});

// Skills enable/disable
app.post('/api/skills/enable', (req, res) => {
  const { id } = req.body;
  if (!id || !SKILL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid skill ID' });
  const src = path.join(SKILLS_DIR, `${id}.md`);
  if (!path.resolve(src).startsWith(path.resolve(SKILLS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid skill ID' });
  }
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Skill not found' });
  try {
    fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
    installSkillFile(id);
    // Clean up old deepsteve-{id}.md flat files from prior naming scheme
    const oldDest = path.join(CLAUDE_COMMANDS_DIR, `deepsteve-${id}.md`);
    if (fs.existsSync(oldDest)) fs.unlinkSync(oldDest);
    if (!settings.enabledSkills) settings.enabledSkills = [];
    if (!settings.enabledSkills.includes(id)) settings.enabledSkills.push(id);
    saveSettings();
    log(`Skill enabled: ${id}`);
    broadcastSkills();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/skills/disable', (req, res) => {
  const { id } = req.body;
  if (!id || !SKILL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid skill ID' });
  const dest = skillDestPath(id);
  // Validate dest is inside SKILL_DEST_DIR (deepsteve/ subdirectory)
  if (!path.resolve(dest).startsWith(path.resolve(SKILL_DEST_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid skill ID' });
  }
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    // Also clean up old deepsteve-{id}.md flat files from prior naming scheme
    const oldDest = path.join(CLAUDE_COMMANDS_DIR, `deepsteve-${id}.md`);
    if (fs.existsSync(oldDest)) fs.unlinkSync(oldDest);
    settings.enabledSkills = (settings.enabledSkills || []).filter(s => s !== id);
    saveSettings();
    log(`Skill disabled: ${id}`);
    broadcastSkills();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/skills/:id/content', (req, res) => {
  const { id } = req.params;
  if (!id || !SKILL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid skill ID' });
  const src = path.join(SKILLS_DIR, `${id}.md`);
  if (!path.resolve(src).startsWith(path.resolve(SKILLS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid skill ID' });
  }
  try {
    let content = fs.readFileSync(src, 'utf8');
    // Strip YAML frontmatter
    content = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
    res.json({ content });
  } catch (e) {
    res.status(404).json({ error: 'Skill not found' });
  }
});

// --- Automations CRUD ---
const AUTOMATION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

app.get('/api/automations', (req, res) => {
  try {
    const automations = [];
    if (fs.existsSync(AUTOMATIONS_DIR)) {
      for (const file of fs.readdirSync(AUTOMATIONS_DIR)) {
        if (!file.endsWith('.md')) continue;
        const id = file.replace(/\.md$/, '');
        if (!AUTOMATION_ID_RE.test(id)) continue;
        try {
          const content = fs.readFileSync(path.join(AUTOMATIONS_DIR, file), 'utf8');
          const meta = parseSkillFrontmatter(content);
          automations.push({ id, name: meta.name || id, icon: meta.icon || '⚡', description: meta.description || '' });
        } catch { /* skip unreadable */ }
      }
    }
    automations.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ automations });
  } catch (e) {
    res.json({ automations: [] });
  }
});

app.post('/api/automations', (req, res) => {
  const { id, name, icon, body } = req.body;
  if (!id || !AUTOMATION_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid automation ID' });
  const filePath = path.join(AUTOMATIONS_DIR, `${id}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(AUTOMATIONS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid automation ID' });
  }
  try {
    fs.mkdirSync(AUTOMATIONS_DIR, { recursive: true });
    const content = `---\nname: ${name || id}\nicon: ${icon || '⚡'}\ndescription: ${(name || id)}\n---\n\n${body || ''}`;
    fs.writeFileSync(filePath, content);
    log(`Automation saved: ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/automations/:id', (req, res) => {
  const { id } = req.params;
  if (!id || !AUTOMATION_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid automation ID' });
  const filePath = path.join(AUTOMATIONS_DIR, `${id}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(AUTOMATIONS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid automation ID' });
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseSkillFrontmatter(content);
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
    res.json({ id, name: meta.name || id, icon: meta.icon || '⚡', description: meta.description || '', body });
  } catch (e) {
    res.status(404).json({ error: 'Automation not found' });
  }
});

app.delete('/api/automations/:id', (req, res) => {
  const { id } = req.params;
  if (!id || !AUTOMATION_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid automation ID' });
  const filePath = path.join(AUTOMATIONS_DIR, `${id}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(AUTOMATIONS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid automation ID' });
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    log(`Automation deleted: ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catalog: fetch remote mod catalog with caching
let catalogCache = null;
let catalogCacheTime = 0;
const CATALOG_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/mods/catalog', async (req, res) => {
  const now = Date.now();
  if (catalogCache && (now - catalogCacheTime) < CATALOG_TTL) {
    return res.json(catalogCache);
  }
  try {
    const resp = await fetch('https://raw.githubusercontent.com/deepsteve/deepsteve-mods/main/catalog.json', {
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const catalog = await resp.json();

    // Read installed mods to annotate catalog entries
    const installedMods = new Map();
    try {
      if (fs.existsSync(MODS_DIR)) {
        for (const entry of fs.readdirSync(MODS_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          try {
            const manifest = JSON.parse(fs.readFileSync(path.join(MODS_DIR, entry.name, 'mod.json'), 'utf8'));
            if (manifest.version) installedMods.set(entry.name, manifest.version);
          } catch {}
        }
      }
    } catch {}

    const annotated = (catalog.mods || []).map(mod => {
      const installed = installedMods.has(mod.id);
      const installedVersion = installed ? installedMods.get(mod.id) : null;
      const updateAvailable = installed && mod.version ? compareSemver(mod.version, installedVersion) > 0 : false;
      const compatible = !mod.minDeepsteveVersion || compareSemver(pkg.version, mod.minDeepsteveVersion) >= 0;
      return { ...mod, installed, installedVersion, updateAvailable, compatible };
    });

    const result = { mods: annotated };
    catalogCache = result;
    catalogCacheTime = now;
    res.json(result);
  } catch (e) {
    log(`Catalog fetch failed: ${e.message}`);
    res.json({ mods: [] });
  }
});

// Install a mod from a remote tarball
app.post('/api/mods/install', async (req, res) => {
  const { id, downloadUrl } = req.body;
  if (!id || !downloadUrl) return res.status(400).json({ error: 'id and downloadUrl required' });

  // Validate mod ID is filesystem-safe
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.length > 128) {
    return res.status(400).json({ error: 'Invalid mod ID' });
  }
  if (BUILTIN_MODS.has(id)) {
    return res.status(400).json({ error: 'Cannot overwrite built-in mod' });
  }

  const modDir = path.join(MODS_DIR, id);
  const tmpFile = path.join(os.tmpdir(), `deepsteve-mod-${id}-${Date.now()}.tar.gz`);

  try {
    // Download tarball
    const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmpFile, buffer);

    // Create mod directory and extract
    fs.mkdirSync(modDir, { recursive: true });
    execSync(`tar xzf '${tmpFile}' -C '${modDir}' --strip-components=1`, { timeout: 10000 });

    // Validate mod.json exists
    const manifestPath = path.join(modDir, 'mod.json');
    if (!fs.existsSync(manifestPath)) {
      fs.rmSync(modDir, { recursive: true, force: true });
      throw new Error('Invalid mod: no mod.json found');
    }

    // Write source marker
    fs.writeFileSync(path.join(modDir, '.source'), 'official');

    // Refresh file watchers
    watchModDirs();

    log(`Installed mod: ${id}`);
    res.json({ ok: true, id });
  } catch (e) {
    log(`Mod install failed (${id}): ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// Uninstall a mod
app.post('/api/mods/uninstall', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  if (BUILTIN_MODS.has(id)) {
    return res.status(400).json({ error: 'Cannot uninstall built-in mod' });
  }

  const modDir = path.join(MODS_DIR, id);
  if (!fs.existsSync(modDir)) {
    return res.status(404).json({ error: 'Mod not found' });
  }

  // Safety: ensure modDir is inside MODS_DIR
  if (!path.resolve(modDir).startsWith(path.resolve(MODS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid mod path' });
  }

  try {
    fs.rmSync(modDir, { recursive: true, force: true });
    watchModDirs();
    log(`Uninstalled mod: ${id}`);
    res.json({ ok: true, id });
  } catch (e) {
    log(`Mod uninstall failed (${id}): ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/display-tab/:id', (req, res) => {
  const html = displayTabs.get(req.params.id);
  if (!html) return res.status(404).send('Not found');
  if (req.method === 'HEAD') return res.type('html').end();
  res.type('html').send(html);
});

app.head('/api/display-tab/:id', (req, res) => {
  if (!displayTabs.has(req.params.id)) return res.status(404).end();
  res.type('html').end();
});

app.delete('/api/display-tab/:id', (req, res) => {
  deleteDisplayTab(req.params.id);
  res.json({ deleted: true });
});

app.get('/api/shells', (req, res) => {
  const active = [...shells.entries()].map(([id, entry]) => ({ id, pid: engine.getPid(id), cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', status: 'active', lastActivity: entry.lastActivity || null, connectedClients: entry.clients.size }));
  const saved = Object.entries(savedState).map(([id, entry]) => ({ id, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', status: entry.closed ? 'closed' : 'saved', lastActivity: entry.lastActivity || null, connectedClients: 0 }));
  res.json({ shells: [...active, ...saved] });
});

app.post('/api/shells/killall', (req, res) => {
  const killed = [];
  for (const [id, entry] of shells) {
    killed.push({ id, pid: engine.getPid(id) });
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
    // Refuse to kill if other clients are connected (unless force=1)
    if (!req.query.force && entry.clients.size > 0) {
      return res.status(409).json({ error: 'Session has connected clients', clients: entry.clients.size });
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    savedState[id] = {
      cwd: entry.cwd, claudeSessionId: entry.claudeSessionId,
      agentType: entry.agentType || 'claude',
      worktree: entry.worktree || null, name: entry.name || null,
      lastActivity: entry.lastActivity || null, createdAt: entry.createdAt || null,
      closed: true
    };
    killShell(entry, id);
    shells.delete(id);
    log(`Killed active shell ${id}, preserved as closed`);
    saveState();
    return res.json({ killed: id, status: 'active' });
  }

  // Check saved state — already-closed sessions are permanently deleted
  if (savedState[id]) {
    const wasClosed = savedState[id].closed;
    if (wasClosed) {
      delete savedState[id];
      log(`Permanently removed closed session ${id}`);
      saveState();
      return res.json({ killed: id, status: 'closed' });
    }
    // Non-closed saved session: mark as closed instead of deleting
    savedState[id].closed = true;
    log(`Marked saved session ${id} as closed`);
    saveState();
    return res.json({ killed: id, status: 'saved' });
  }

  res.status(404).json({ error: 'Session not found' });
});

function notifyClientsShellExited(id) {
  const entry = shells.get(id);
  if (!entry) return;
  const msg = JSON.stringify({ type: 'close-tab' });
  entry.clients.forEach((c) => { try { c.send(msg); } catch {} });
}

function closeSession(id) {
  const entry = shells.get(id);
  if (!entry) return false;

  log(`[closeSession] session ${id} closing`);

  // Notify connected browser clients to close this tab
  const closeMsg = JSON.stringify({ type: 'close-tab' });
  entry.clients.forEach((c) => { try { c.send(closeMsg); } catch {} });

  if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null; }

  unwatchClaudeSessionDir(id);
  killShell(entry, id);
  shells.delete(id);
  delete savedState[id];
  saveState();

  return true;
}

app.post('/api/shells/:id/close', (req, res) => {
  if (!closeSession(req.params.id)) return res.status(404).json({ error: 'Shell not found' });
  res.json({ closed: req.params.id });
});

app.get('/api/shells/:id/state', (req, res) => {
  const id = req.params.id;
  const entry = shells.get(id);
  if (!entry) return res.status(404).json({ error: 'Shell not found' });
  res.json({ waitingForInput: entry.waitingForInput || false });
});

app.post('/api/shells/clear-disconnected', (req, res) => {
  const cleared = [];

  // Remove saved sessions (no running PTY)
  for (const id of Object.keys(savedState)) {
    cleared.push(id);
    delete savedState[id];
  }

  // Kill active shells with no connected clients
  for (const [id, entry] of shells) {
    if (entry.clients.size === 0) {
      cleared.push(id);
      killShell(entry, id);
      shells.delete(id);
    }
  }

  if (cleared.length > 0) saveState();
  log(`Cleared ${cleared.length} disconnected sessions: ${cleared.join(', ')}`);
  res.json({ cleared });
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
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).filter(e => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase())).sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map(e => path.join(dirToList, e.name));
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

app.post('/api/git-roots', express.json(), (req, res) => {
  const paths = req.body?.paths;
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be an array' });
  const rootSet = new Map();
  for (const p of paths) {
    try {
      let cwd = p;
      if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
      const root = execSync("zsh -l -c 'git rev-parse --show-toplevel'", { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      if (!rootSet.has(root)) rootSet.set(root, path.basename(root));
    } catch { /* skip non-git dirs */ }
  }
  // Disambiguate duplicate basenames
  const nameCounts = {};
  for (const name of rootSet.values()) nameCounts[name] = (nameCounts[name] || 0) + 1;
  const roots = [];
  for (const [root, baseName] of rootSet) {
    const name = nameCounts[baseName] > 1
      ? `${baseName} (${path.basename(path.dirname(root))})`
      : baseName;
    roots.push({ root, name });
  }
  roots.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ roots });
});

app.get('/api/issues', (req, res) => {
  let cwd = req.query.cwd || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 30;
  try {
    const limit = perPage * page;
    const out = execSync(`zsh -l -c 'gh issue list --json number,title,body,labels,url --limit ${limit}'`, { cwd, encoding: 'utf8', timeout: 15000 });
    const all = JSON.parse(out);
    const pageIssues = all.slice((page - 1) * perPage);
    res.json({ issues: pageIssues, hasMore: pageIssues.length === perPage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/start-issue', (req, res) => {
  const { number, title, body, labels, url, cwd: rawCwd, windowId: rawWindowId, sessionId, agentType: rawAgentType } = req.body;
  if (!number || !title) return res.status(400).json({ error: 'number and title are required' });

  // Resolve windowId, agentType, and cwd: explicit value, or look up from caller's session
  let windowId = rawWindowId;
  let agentType = rawAgentType;
  let cwd = rawCwd;
  if (sessionId) {
    const callerEntry = shells.get(sessionId);
    if (callerEntry) {
      if (!windowId && callerEntry.windowId) windowId = callerEntry.windowId;
      if (!agentType && callerEntry.agentType) agentType = callerEntry.agentType;
      if (!cwd && callerEntry.cwd) cwd = callerEntry.cwd;
    }
  }
  agentType = agentType || 'claude';

  cwd = cwd || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));

  // Build prompt helper (shared between sync and async paths)
  function buildPrompt(issueBody, issueLabels, issueUrl) {
    const vars = {
      number,
      title,
      labels: Array.isArray(issueLabels) ? issueLabels.map(l => typeof l === 'string' ? l : l.name).join(', ') : (issueLabels || 'none'),
      url: issueUrl || '',
      body: issueBody ? String(issueBody).slice(0, 2000) : '(no description)',
    };
    return settings.wandPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  }

  const worktree = validateWorktree('github-issue-' + number);
  const id = randomUUID().slice(0, 8);
  const claudeSessionId = randomUUID();
  const agentConfig = getAgentConfig(agentType);

  // For agents that don't support --worktree natively: manually create worktree
  let worktreeCwd = cwd;
  if (worktree && !agentConfig.supportsWorktree) {
    worktreeCwd = ensureWorktree(cwd, worktree);
  }

  const spawnArgs = getSpawnArgs(agentType, {
    sessionId: claudeSessionId,
    planMode: settings.wandPlanMode,
    worktree
  });

  const maxLen = settings.maxIssueTitleLength || 25;
  const tabTitle = `#${number} ${title}`;
  const name = tabTitle.length <= maxLen ? tabTitle : tabTitle.slice(0, maxLen) + '\u2026';

  // Pre-flight: ensure we can deliver to a browser before spawning
  const readyClients = [...reloadClients].filter(c => c.readyState === 1);
  if (!windowId && readyClients.length > 1) {
    log(`[API] start-issue: multiple browser windows open but no windowId resolved`);
    return res.status(400).json({ error: 'Multiple browser windows open. Pass sessionId or windowId to target one.' });
  }

  // When body is provided inline, build prompt synchronously
  const prompt = body ? buildPrompt(body, labels, url) : null;

  log(`[API] start-issue #${number}: id=${id}, agent=${agentType}, worktree=${worktree || 'none'}, cwd=${worktreeCwd}`);
  spawnSession(id, agentType, spawnArgs, worktreeCwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
  shells.set(id, { clients: new Set(), cwd: worktreeCwd, claudeSessionId: claudeSessionId, agentType, worktree: worktree || null, windowId: windowId || null, name, initialPrompt: prompt, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
  wireShellOutput(id);
  // For non-BEL agents with a synchronous prompt, deliver after delay
  if (prompt && agentConfig.initialPromptDelay > 0) {
    shells.get(id).initialPrompt = null; // Clear so BEL handler doesn't also fire
    setTimeout(() => submitToShell(id, prompt), agentConfig.initialPromptDelay);
  }
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  engine.onExit(id, () => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    if (!shuttingDown) { notifyClientsShellExited(id); shells.delete(id); saveState(); }
  });
  saveState();

  // When body was NOT provided, fetch async and deliver prompt when ready
  if (!body) {
    fetchIssueFromGitHub(number, cwd).then(gh => {
      const issueBody = gh ? gh.body : null;
      const issueLabels = gh ? (labels || (Array.isArray(gh.labels) ? gh.labels.map(l => typeof l === 'string' ? l : l.name).join(', ') : null)) : labels;
      const issueUrl = gh ? (url || gh.url) : url;
      const asyncPrompt = buildPrompt(issueBody, issueLabels, issueUrl);
      deliverPromptWhenReady(id, asyncPrompt);
    });
  }

  // Notify browser to open the new session
  log(`[API] start-issue: windowId=${windowId}, sessionId=${id}, readyClients=${readyClients.length}, clientWindowIds=[${readyClients.map(c => c.windowId).join(',')}]`);
  let delivered = false;
  if (windowId) {
    // Targeted: send only to the reload client whose windowId matches
    const openMsg = JSON.stringify({ type: 'open-session', id, cwd, name, windowId });
    for (const client of readyClients) {
      if (client.windowId === windowId && client.readyState === 1) {
        client.send(openMsg);
        delivered = true;
        break;
      }
    }
    if (!delivered && readyClients.length > 0) {
      // WindowId didn't match any client — broadcast without windowId so client-side filter accepts it
      log(`[API] start-issue: windowId=${windowId} not found among reload clients [${readyClients.map(c => c.windowId).join(',')}], broadcasting`);
      const broadcastMsg = JSON.stringify({ type: 'open-session', id, cwd, name });
      for (const client of readyClients) {
        if (client.readyState === 1) client.send(broadcastMsg);
      }
      delivered = true;
    }
    if (!delivered) {
      // No browser connected — queue for when the target window reconnects
      pendingOpens.push(openMsg);
      log(`[API] start-issue: no browser open, queued open-session for windowId=${windowId}`);
      delivered = true;
    }
  }
  if (!delivered && readyClients.length > 0) {
    // No windowId — send to first available window
    readyClients[0].send(JSON.stringify({ type: 'open-session', id, cwd, name }));
    delivered = true;
  }
  if (!delivered) {
    // No browser open — queue message and open one
    pendingOpens.push(JSON.stringify({ type: 'open-session', id, cwd, name }));
    log(`[API] start-issue: no browser open, queued open-session and launching browser`);
    exec(`open "http://localhost:${PORT}"`);
    delivered = true;
  }
  res.json({ id, name, url: `http://localhost:${PORT}` });
});

// restart.sh calls this before restarting. Server asks browser(s) for
// confirmation, waits for response, then replies to curl.
// Browsers elect a single leader to show the modal; first response wins.
app.post('/api/request-restart', (req, res) => {
  const clients = [...reloadClients].filter(c => c.readyState === 1);
  log(`[restart] ${clients.length} reload client(s), windowIds=[${clients.map(c => c.windowId || 'none').join(', ')}]`);
  if (clients.length === 0) {
    log(`[restart] no clients, auto-confirming`);
    return res.json({ result: 'confirmed' });
  }

  // Cancel any pending request from a prior (killed) curl
  if (restartState) {
    log(`[restart] cancelling stale pending request`);
    clearTimeout(restartState.timeout);
    restartState = null;
  }

  const timeout = setTimeout(() => {
    log(`[restart] timed out after 60s, no browser response`);
    restartState = null;
    res.json({ result: 'timeout' });
  }, 60000);

  restartState = {
    timeout,
    resolve: (result) => {
      log(`[restart] resolved: ${result}`);
      clearTimeout(timeout);
      restartState = null;
      res.json({ result });
    }
  };

  // Send confirm-restart to all connected browsers (they elect a leader)
  for (const ws of clients) {
    log(`[restart] sending confirm-restart to windowId=${ws.windowId || 'none'}, readyState=${ws.readyState}`);
    try { ws.send(JSON.stringify({ type: 'confirm-restart' })); } catch (e) {
      log(`[restart] send failed: ${e.message}`);
    }
  }
});

reconcileSkills();

const server = app.listen(PORT, BIND, () => {
  log(`HTTP server listening on ${BIND}:${PORT}`);
  // Auto-open browser if no clients connect within 3s of startup
  setTimeout(() => {
    const connected = [...reloadClients].filter(c => c.readyState === 1);
    if (connected.length === 0) {
      log('No browser connected after startup, opening default browser');
      exec(`open "http://localhost:${PORT}"`);
    }
  }, 3000);
});
const shells = new Map();
const displayTabs = new Map(); // id → HTML string (disk-backed in ~/.deepsteve/display-tabs/)

// --- tmux session reattach on startup ---
// When engine is tmux, check for surviving tmux sessions and reattach them.
if (engine instanceof TmuxEngine) {
  const tmuxSessions = engine.listSessions();
  if (tmuxSessions.length > 0) {
    log(`tmux: found ${tmuxSessions.length} surviving session(s): ${tmuxSessions.join(', ')}`);
    for (const id of tmuxSessions) {
      const meta = savedState[id];
      if (!meta) {
        log(`tmux: session ${id} has no metadata in state.json, killing orphan`);
        engine.destroy(id);
        continue;
      }
      if (engine.reattach(id, 120, 40)) {
        const agentConfig = getAgentConfig(meta.agentType || 'claude');
        shells.set(id, {
          clients: new Set(),
          cwd: meta.cwd,
          claudeSessionId: meta.claudeSessionId,
          agentType: meta.agentType || 'claude',
          worktree: meta.worktree || null,
          name: meta.name || null,
          restored: true,
          waitingForInput: false,
          lastActivity: meta.lastActivity || Date.now(),
          createdAt: meta.createdAt || Date.now(),
          windowId: meta.windowId || null,
        });
        wireShellOutput(id);
        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        engine.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!shuttingDown) { notifyClientsShellExited(id); shells.delete(id); saveState(); }
        });
        delete savedState[id];
        log(`tmux: reattached session ${id} (${meta.name || meta.cwd})`);
      } else {
        log(`tmux: failed to reattach session ${id}`);
      }
    }
    saveState();
  }
}

function setDisplayTab(id, html) {
  displayTabs.set(id, html);
  try {
    fs.mkdirSync(DISPLAY_TABS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DISPLAY_TABS_DIR, `${id}.html`), html);
  } catch (e) { log(`[display-tab] Failed to persist ${id}: ${e.message}`); }
}

function deleteDisplayTab(id) {
  displayTabs.delete(id);
  try { fs.unlinkSync(path.join(DISPLAY_TABS_DIR, `${id}.html`)); } catch {}
}
const wss = new WebSocketServer({ server });

// HTTPS server (created async if enabled)
let httpsServer = null;
let httpsWss = null;

if (HTTPS_ENABLED) {
  (async () => {
    try {
      const certs = await ensureCerts();
      httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
      httpsWss = new WebSocketServer({ server: httpsServer });
      httpsWss.on('connection', handleWsConnection);
      httpsServer.listen(HTTPS_PORT, BIND, () => {
        const addrs = getLanAddresses().filter(a => a !== 'localhost' && a !== '127.0.0.1');
        log(`HTTPS server listening on ${BIND}:${HTTPS_PORT} (WARNING: no authentication)`);
        if (addrs.length > 0) {
          log(`HTTPS: Connect from Quest/LAN at https://${addrs[0]}:${HTTPS_PORT}`);
        }
      });
    } catch (e) {
      console.error('Failed to start HTTPS server:', e.message);
    }
  })();
}

wss.on('connection', handleWsConnection);

function handleWsConnection(ws, req) {
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
    ws.windowId = url.searchParams.get('windowId') || null;
    reloadClients.add(ws);
    ws.isAlive = true;
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) {
        log(`[WS] Reload client dead (no pong), terminating (windowId=${ws.windowId})`);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
    ws.on('close', () => {
      clearInterval(pingInterval);
      reloadClients.delete(ws);
      // If restart is pending and no browsers remain, auto-confirm
      if (restartState) {
        const liveClients = [...reloadClients].filter(c => c.readyState === 1);
        if (liveClients.length === 0) {
          restartState.resolve('confirmed');
        }
      }
    });
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'pong') {
          ws.isAlive = true;
        } else if (parsed.type === 'restart-confirmed' && restartState) {
          restartState.resolve('confirmed');
        } else if (parsed.type === 'restart-declined' && restartState) {
          restartState.resolve('declined');
        }
      } catch {}
    });
    // Flush pending open-session messages that match this window (or have no windowId)
    if (pendingOpens.length > 0) {
      const keep = [];
      let flushed = 0;
      for (const msg of pendingOpens) {
        const parsed = JSON.parse(msg);
        if (!parsed.windowId || parsed.windowId === ws.windowId) {
          if (ws.readyState === 1) ws.send(msg);
          flushed++;
        } else {
          keep.push(msg);
        }
      }
      pendingOpens.length = 0;
      pendingOpens.push(...keep);
      if (flushed > 0) log(`[WS] Flushed ${flushed} pending open-session(s) to reload client (windowId=${ws.windowId}), ${keep.length} kept for other windows`);
    }
    return;
  }

  // Attach to an existing tmux session (raw terminal, no agent features)
  if (action === 'tmux-attach') {
    const tmuxSession = url.searchParams.get('session');
    const windowId = url.searchParams.get('windowId') || null;
    const initialCols = parseInt(url.searchParams.get('cols')) || 120;
    const initialRows = parseInt(url.searchParams.get('rows')) || 40;
    const tabName = url.searchParams.get('name') || tmuxSession;

    if (!tmuxSession) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing session parameter' }));
      ws.close();
      return;
    }

    // Check tmux session exists
    try {
      execSync(`zsh -l -c 'tmux has-session -t "${tmuxSession.replace(/"/g, '\\"')}"'`, { timeout: 5000, stdio: 'pipe' });
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: `tmux session "${tmuxSession}" not found` }));
      ws.close();
      return;
    }

    const pty = require('node-pty');
    const id = randomUUID().slice(0, 8);
    // Use resolved tmux path from engine (LaunchAgent PATH lacks Homebrew)
    const tmuxBin = (engine instanceof TmuxEngine && engine.tmuxPath) || 'tmux';
    const attachPty = pty.spawn(tmuxBin, ['attach-session', '-t', tmuxSession], {
      name: 'xterm-256color',
      cols: initialCols,
      rows: initialRows,
    });

    const entry = {
      clients: new Set(),
      cwd: null,
      claudeSessionId: null,
      agentType: 'tmux-attach',
      tmuxSession,
      worktree: null,
      name: tabName,
      waitingForInput: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      windowId,
      scrollback: [],
      scrollbackSize: 0,
      _attachPty: attachPty,
    };
    shells.set(id, entry);

    attachPty.onData((data) => {
      const e = shells.get(id);
      if (!e) return;
      e.lastActivity = Date.now();
      e.scrollback.push(data);
      e.scrollbackSize += data.length;
      while (e.scrollbackSize > SCROLLBACK_SIZE && e.scrollback.length > 1) {
        e.scrollbackSize -= e.scrollback.shift().length;
      }
      e.clients.forEach((c) => c.send(data));
    });

    attachPty.onExit(() => {
      if (!shuttingDown) { shells.delete(id); }
    });

    log(`[WS] tmux-attach: id=${id}, session=${tmuxSession}`);

    entry.clients.add(ws);
    ws.send(JSON.stringify({ type: 'session', id, restored: false, cwd: null, name: tabName, agentType: 'tmux-attach', scrollback: false, existingClients: 0 }));

    ws.on('message', (msg) => {
      const str = msg.toString();
      try {
        const parsed = JSON.parse(str);
        if (parsed.type === 'resize') {
          attachPty.resize(parsed.cols, parsed.rows);
          // Also resize the tmux window
          try { execSync(`zsh -l -c 'tmux resize-window -t "${tmuxSession.replace(/"/g, '\\"')}" -x ${parsed.cols} -y ${parsed.rows}'`, { timeout: 5000, stdio: 'pipe' }); } catch {}
          return;
        }
        if (parsed.type === 'redraw') { attachPty.write('\x0c'); return; }
        if (parsed.type === 'rename') { entry.name = parsed.name || null; return; }
        if (parsed.type === 'close-session') {
          // Detach only — don't kill the tmux session
          entry.clients.delete(ws);
          ws.close();
          if (entry.clients.size === 0) {
            log(`[WS] tmux-attach: detaching from ${tmuxSession} (last client)`);
            try { attachPty.kill(); } catch {}
            shells.delete(id);
          }
          return;
        }
      } catch {}
      entry.lastActivity = Date.now();
      attachPty.write(str);
    });

    ws.on('close', () => {
      if (!shells.has(id)) return;
      entry.clients.delete(ws);
      if (entry.clients.size === 0) {
        // Detach after grace period
        entry.killTimer = setTimeout(() => {
          if (entry.clients.size === 0) {
            log(`[WS] tmux-attach: detaching from ${tmuxSession} (grace period expired)`);
            try { attachPty.kill(); } catch {}
            shells.delete(id);
          }
        }, 30000);
      }
    });
    return;
  }

  let id = url.searchParams.get('id');
  let cwd = url.searchParams.get('cwd') || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  const createNew = url.searchParams.get('new') === '1';
  const worktree = validateWorktree(url.searchParams.get('worktree'));
  const planMode = url.searchParams.get('planMode') === '1';
  const name = url.searchParams.get('name');
  const windowId = url.searchParams.get('windowId') || null;
  const initialCols = parseInt(url.searchParams.get('cols')) || 120;
  const initialRows = parseInt(url.searchParams.get('rows')) || 40;
  const agentType = url.searchParams.get('agentType') || 'claude';
  const forkFrom = url.searchParams.get('fork');

  log(`[WS] Connection: id=${id}, cwd=${cwd}, createNew=${createNew}, worktree=${worktree}`);
  log(`[WS] Active shells: ${[...shells.keys()].join(', ') || 'none'}`);
  log(`[WS] Saved state: ${Object.keys(savedState).join(', ') || 'none'}`);

  // If client requested a specific ID that doesn't exist, check if we can restore it
  if (id && !shells.has(id) && !createNew) {
    if (savedState[id]) {
      // Restore this session with --resume flag using saved agent session ID
      const restored = savedState[id];
      cwd = restored.cwd;
      const claudeSessionId = restored.claudeSessionId;
      const savedWorktree = validateWorktree(restored.worktree);
      const savedAgentType = restored.agentType || 'claude';
      const agentConfig = getAgentConfig(savedAgentType);

      log(`Restoring session ${id} in ${cwd} (agent: ${savedAgentType}, session: ${claudeSessionId}, worktree: ${savedWorktree || 'none'})`);
      const ptySize = { cols: initialCols, rows: initialRows };
      
      const resumeArgs = getResumeArgs(savedAgentType, { 
        sessionId: claudeSessionId, 
        worktree: savedWorktree 
      });

      spawnSession(id, savedAgentType, resumeArgs, cwd, { ...ptySize, env: { DEEPSTEVE_SESSION_ID: id } });
      const startTime = Date.now();
      const restoredName = name || restored.name || null;
      shells.set(id, { clients: new Set(), cwd, claudeSessionId, agentType: savedAgentType, worktree: savedWorktree, name: restoredName, restored: true, waitingForInput: false, lastActivity: Date.now(), createdAt: restored.createdAt || Date.now(), windowId: restored.windowId || null });
      wireShellOutput(id);
      if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
      engine.onExit(id, () => {
        if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
        if (shuttingDown) return;  // Don't overwrite state file during shutdown
        const elapsed = Date.now() - startTime;
        if (elapsed < 5000 && claudeSessionId && agentConfig.supportsSessionWatch) {
          // --resume failed quickly, fall back to continuing last conversation
          log(`Session ${id} exited after ${elapsed}ms, --resume likely failed. Falling back to -c`);
          const newClaudeSessionId = randomUUID();
          const entry = shells.get(id);
          const fallbackArgs = ['-c', '--fork-session', '--session-id', newClaudeSessionId];
          if (entry && entry.worktree) fallbackArgs.push('--worktree', entry.worktree);
          engine.destroy(id);
          spawnSession(id, 'claude', fallbackArgs, cwd, { cols: initialCols, rows: initialRows, env: { DEEPSTEVE_SESSION_ID: id } });
          if (entry) {
            entry.claudeSessionId = newClaudeSessionId;
            entry.killed = false;
            entry.scrollback = [];
            entry.scrollbackSize = 0;
            wireShellOutput(id);
            watchClaudeSessionDir(id);
            engine.onExit(id, () => { if (!shuttingDown) { unwatchClaudeSessionDir(id); notifyClientsShellExited(id); shells.delete(id); saveState(); } });
            saveState();
          }
        } else {
          notifyClientsShellExited(id);
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
    const sessionId = randomUUID();  // Full UUID for session ID (both agents)
    const agentConfig = getAgentConfig(agentType);
    
    // For agents that don't support --worktree natively: manually create worktree
    let worktreeCwd = cwd;
    if (worktree && !agentConfig.supportsWorktree) {
      worktreeCwd = ensureWorktree(cwd, worktree);
    }

    let spawnArgs;
    if (forkFrom && shells.has(forkFrom)) {
      const parent = shells.get(forkFrom);
      spawnArgs = ['--resume', parent.claudeSessionId, '--fork-session', '--session-id', sessionId];
      if (worktree) spawnArgs.push('--worktree', worktree);
      else if (parent.worktree) spawnArgs.push('--worktree', parent.worktree);
      log(`[WS] Forking from shell ${forkFrom} (parent claude session: ${parent.claudeSessionId})`);
    } else {
      spawnArgs = getSpawnArgs(agentType, {
        sessionId,
        planMode,
        worktree
      });
    }

    log(`[WS] Creating NEW shell: oldId=${oldId}, newId=${id}, agent=${agentType}, session=${sessionId}, worktree=${worktree || 'none'}, cwd=${worktreeCwd}`);
    spawnSession(id, agentType, spawnArgs, worktreeCwd, { cols: initialCols, rows: initialRows, env: { DEEPSTEVE_SESSION_ID: id } });
    shells.set(id, { clients: new Set(), cwd: worktreeCwd, claudeSessionId: sessionId, agentType, worktree: worktree || null, name: name || null, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
    wireShellOutput(id);
    if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
    engine.onExit(id, () => { if (!shuttingDown) { if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id); notifyClientsShellExited(id); shells.delete(id); saveState(); } });
    saveState();
  }

  const entry = shells.get(id);
  // Cancel any pending kill timer on reconnect
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
  }
  const existingClients = entry.clients.size;
  entry.clients.add(ws);
  if (windowId) entry.windowId = windowId;
  const hasScrollback = entry.scrollback && entry.scrollback.length > 0;
  log(`[WS] Sending session response: id=${id}, restored=${entry.restored || false}, scrollback=${hasScrollback ? entry.scrollbackSize + 'B' : 'none'}, existingClients=${existingClients}`);
  ws.send(JSON.stringify({ type: 'session', id, restored: entry.restored || false, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', scrollback: hasScrollback, existingClients }));

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
      if (parsed.type === 'resize') { engine.resize(id, parsed.cols, parsed.rows); return; }
      if (parsed.type === 'redraw') { engine.write(id, '\x0c'); return; } // Ctrl+L
      if (parsed.type === 'initialPrompt') {
        const config = getAgentConfig(entry.agentType);
        if (config.initialPromptDelay > 0) {
          // Agent doesn't emit BEL, so submit the prompt directly after a delay
          // to give the TUI time to initialize
          const prompt = parsed.text;
          setTimeout(() => submitToShell(id, prompt), config.initialPromptDelay);
        } else {
          entry.initialPrompt = parsed.text;
        }
        return;
      }
      if (parsed.type === 'rename') { entry.name = parsed.name || null; return; }
      if (parsed.type === 'close-session') {
        entry.clients.delete(ws);
        ws.close();
        if (entry.clients.size === 0) {
          log(`[WS] close-session: last client detached from ${id}, killing shell`);
          savedState[id] = {
            cwd: entry.cwd, claudeSessionId: entry.claudeSessionId,
            agentType: entry.agentType || 'claude',
            worktree: entry.worktree || null, name: entry.name || null,
            lastActivity: entry.lastActivity || null, createdAt: entry.createdAt || null,
            closed: true
          };
          killShell(entry, id);
          shells.delete(id);
          saveState();
        } else {
          log(`[WS] close-session: client detached from ${id}, ${entry.clients.size} client(s) remain`);
        }
        return;
      }
    } catch {}
    // User sent input - update activity and clear waiting state
    entry.lastActivity = Date.now();
    if (entry.waitingForInput) {
      entry.waitingForInput = false;
      const stateMsg = JSON.stringify({ type: 'state', waiting: false });
      entry.clients.forEach((c) => c.send(stateMsg));
    }
    engine.write(id, str);
  });

  ws.on('close', () => {
    if (!shells.has(id)) return; // already killed by close-session
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      // Grace period to allow reconnect on refresh
      entry.killTimer = setTimeout(() => {
        if (entry.clients.size === 0) {
          // Preserve session info so it can be restored on next connect
          savedState[id] = { cwd: entry.cwd, claudeSessionId: entry.claudeSessionId, agentType: entry.agentType || 'claude', worktree: entry.worktree || null, name: entry.name || null, lastActivity: entry.lastActivity || null };
          killShell(entry, id);
          shells.delete(id);
          saveState();
        }
      }, 30000);
    }
  });
}

// Broadcast a JSON message to all connected browser WebSocket clients
function broadcast(msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
  if (httpsWss) {
    for (const client of httpsWss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }
}

// Broadcast a JSON message to a specific window's WebSocket connections only
function broadcastToWindow(windowId, msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const sent = new Set();
  for (const entry of shells.values()) {
    if (entry.windowId === windowId) {
      for (const client of entry.clients) {
        if (client.readyState === 1 && !sent.has(client)) {
          client.send(data);
          sent.add(client);
        }
      }
    }
  }
}

// Initialize MCP server (async, ~100ms for dynamic import)
initMCP({ app, shells, wss, broadcast, broadcastToWindow, log, MODS_DIR, closeSession, spawnSession, engine, getSpawnArgs, getAgentConfig, wireShellOutput, watchClaudeSessionDir, unwatchClaudeSessionDir, saveState, validateWorktree, ensureWorktree, submitToShell, fetchIssueFromGitHub, deliverPromptWhenReady, reloadClients, pendingOpens, settings, isShuttingDown: () => shuttingDown, displayTabs, setDisplayTab, deleteDisplayTab }).catch(e => log('MCP init failed:', e.message));

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
