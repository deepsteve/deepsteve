#!/bin/bash
set -e

if ! command -v node &>/dev/null; then
  echo "Node.js not found, installing..."
  if command -v brew &>/dev/null; then
    brew install node
  else
    ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH="x64"
    NODE_VERSION="22.14.0"
    if [ "$ARCH" = "arm64" ]; then
      NODE_SHA256="e9404633bc02a5162c5c573b1e2490f5fb44648345d64a958b17e325729a5e42"
    else
      NODE_SHA256="6698587713ab565a94a360e091df9f6d91c8fadda6d00f0cf6526e9b40bed250"
    fi
    NODE_DIR="$HOME/.deepsteve/node"
    mkdir -p "$NODE_DIR"
    NODE_TGZ=$(mktemp)
    trap 'rm -f "$NODE_TGZ"' EXIT
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz" -o "$NODE_TGZ"
    ACTUAL_SHA256=$(shasum -a 256 "$NODE_TGZ" | awk '{print $1}')
    if [ "$ACTUAL_SHA256" != "$NODE_SHA256" ]; then
      echo "ERROR: Node.js checksum verification failed!" >&2
      echo "  Expected: $NODE_SHA256" >&2
      echo "  Got:      $ACTUAL_SHA256" >&2
      rm -f "$NODE_TGZ"
      exit 1
    fi
    tar xz -C "$NODE_DIR" --strip-components=1 < "$NODE_TGZ"
    rm -f "$NODE_TGZ"
    export PATH="$NODE_DIR/bin:$PATH"
  fi
fi

INSTALL_DIR="$HOME/.deepsteve"
PLIST_PATH="$HOME/Library/LaunchAgents/com.deepsteve.plist"
NODE_PATH=$(which node)

mkdir -p "$INSTALL_DIR/public/js"
mkdir -p "$INSTALL_DIR/public/css"
mkdir -p "$INSTALL_DIR/themes"
mkdir -p "$INSTALL_DIR/skills"
mkdir -p "$HOME/Library/LaunchAgents"

mkdir -p "$INSTALL_DIR/mods/action-required"
mkdir -p "$INSTALL_DIR/mods/agent-chat"
mkdir -p "$INSTALL_DIR/mods/agent-dna"
mkdir -p "$INSTALL_DIR/mods/agent-game"
mkdir -p "$INSTALL_DIR/mods/agent-poker"
mkdir -p "$INSTALL_DIR/mods/baby-browser"
mkdir -p "$INSTALL_DIR/mods/browser-console"
mkdir -p "$INSTALL_DIR/mods/deepsteve-core"
mkdir -p "$INSTALL_DIR/mods/display-tab"
mkdir -p "$INSTALL_DIR/mods/go-karts"
mkdir -p "$INSTALL_DIR/mods/messages"
mkdir -p "$INSTALL_DIR/mods/meta-ads"
mkdir -p "$INSTALL_DIR/mods/monkey-code"
mkdir -p "$INSTALL_DIR/mods/screenshots"
mkdir -p "$INSTALL_DIR/mods/tasks"
mkdir -p "$INSTALL_DIR/mods/threejs-scene"
mkdir -p "$INSTALL_DIR/mods/tower"
mkdir -p "$INSTALL_DIR/mods/window-map"

cat > "$INSTALL_DIR/package.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "deepsteve",
  "version": "0.8.1",
  "private": true,
  "description": "Web UI for running multiple Claude Code instances in browser tabs",
  "license": "MIT",
  "author": "Fncore, Inc",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepsteve/deepsteve.git"
  },
  "main": "server.js",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^4.18.2",
    "node-pty": "^1.0.0",
    "selfsigned": "^5.0.0",
    "ws": "^8.14.2",
    "facebook-nodejs-business-sdk": "^20.0.0",
    "zod": "^3.24.0"
  }
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/server.js" << 'DEEPSTEVE_FILE_EOF'
const express = require('express');
const https = require('https');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { execSync, execFileSync, exec } = require('child_process');
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
let restartState = null; // { resolve: fn } — first browser response wins

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
  enabledAgents: ['claude', 'opencode']
};

// Load settings
let settings = { shellProfile: '~/.zshrc', maxIssueTitleLength: 25, cmdTabSwitch: false, cmdTabSwitchHoldMs: 1000, enabledSkills: [], windowConfigs: [], ...SETTINGS_DEFAULTS };
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
    windowConfigs: settings.windowConfigs || [],
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

// Spawn claude with full login shell environment (like iTerm does)
function spawnClaude(args, cwd, { cols = 120, rows = 40, env: extraEnv } = {}) {
  // Use login shell (-l) which properly sources /etc/zprofile, ~/.zprofile, ~/.zshrc
  const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  return pty.spawn('zsh', ['-l', '-c', `claude ${quoted}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  });
}

// Spawn opencode with full login shell environment
function spawnOpenCode(args, cwd, { cols = 120, rows = 40, env: extraEnv } = {}) {
  const bin = settings.opencodeBinary || 'opencode';
  const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  return pty.spawn('zsh', ['-l', '-c', `${bin} ${quoted}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  });
}

// Spawn Gemini CLI with full login shell environment
function spawnGemini(args, cwd, { cols = 120, rows = 40, env: extraEnv } = {}) {
  const bin = settings.geminiBinary || 'gemini';
  const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  return pty.spawn('zsh', ['-l', '-c', `${bin} ${quoted}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  });
}

// Agent capabilities and argument mapping
const AGENT_CONFIGS = {
  claude: {
    spawn: spawnClaude,
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
    spawn: spawnGemini,
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
    spawn: spawnOpenCode,
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
  }
};

function getAgentConfig(agentType) {
  return AGENT_CONFIGS[agentType] || AGENT_CONFIGS.claude;
}

// Dispatch to the correct spawn function based on agent type
function spawnAgent(agentType, args, cwd, opts = {}) {
  const config = getAgentConfig(agentType);
  return config.spawn(args, cwd, opts);
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
    return worktreePath;
  }
  try {
    log(`Creating git worktree: ${name} in ${cwd}`);
    execSync(`zsh -l -c 'git worktree add "${worktreePath}"'`, { cwd, encoding: 'utf8', timeout: 30000 });
    return worktreePath;
  } catch (e) {
    log(`Failed to create worktree ${worktreePath}: ${e.message}`);
    // If it fails, maybe the branch already exists or it's not a git repo.
    // We attempt to return the path anyway if it was created, or fallback.
    return fs.existsSync(worktreePath) ? worktreePath : cwd;
  }
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
function submitToShell(shell, text) {
  shell.write(text);
  setTimeout(() => shell.write('\r'), 1000);
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
    setTimeout(() => submitToShell(e.shell, prompt), 500);
  } else if (config.initialPromptDelay > 0) {
    setTimeout(() => submitToShell(e.shell, prompt), config.initialPromptDelay);
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
            setTimeout(() => submitToShell(e.shell, prompt), 500);
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
  });
}

// Gracefully kill a shell
function killShell(entry, id) {
  if (entry.killed) return;
  entry.killed = true;

  const pid = entry.shell.pid;
  const config = getAgentConfig(entry.agentType);
  log(`Killing shell ${id} (pid=${pid}, agent=${entry.agentType || 'claude'}, waitingForInput=${entry.waitingForInput})`);

  if (config.exitMethod === 'ctrl-c') {
    // Agent just needs Ctrl+C (OpenCode, Gemini)
    try { entry.shell.write('\x03'); } catch {}
  } else if (config.exitMethod === 'exit-cmd') {
    // Agent supports /exit command (Claude)
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
      entry.shell.onData(exitHandler);
    }
  } else {
    // Default fallback: just kill the process group
    try { process.kill(-pid, 'SIGTERM'); } catch {}
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
  for (const [id, entry] of entries) {
    entry.shell.onExit(() => alive.delete(id));
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
  saveSettings();
  broadcastSettings();
  res.json(settings);
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
      displayTabs.set(id, tab.html);
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

    const shell = spawnAgent(agentType, spawnArgs, cwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
    shells.set(id, { shell, clients: new Set(), cwd, claudeSessionId, agentType, worktree: null, windowId: windowId || null, name, initialPrompt: null, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
    wireShellOutput(id);
    if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
    shell.onExit(() => {
      if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
      if (!shuttingDown) { shells.delete(id); saveState(); }
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
  res.type('html').send(html);
});

app.get('/api/shells', (req, res) => {
  const active = [...shells.entries()].map(([id, entry]) => ({ id, pid: entry.shell.pid, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', status: 'active', lastActivity: entry.lastActivity || null, connectedClients: entry.clients.size }));
  const saved = Object.entries(savedState).map(([id, entry]) => ({ id, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', status: entry.closed ? 'closed' : 'saved', lastActivity: entry.lastActivity || null, connectedClients: 0 }));
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
  const shell = spawnAgent(agentType, spawnArgs, worktreeCwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
  shells.set(id, { shell, clients: new Set(), cwd: worktreeCwd, claudeSessionId: claudeSessionId, agentType, worktree: worktree || null, windowId: windowId || null, name, initialPrompt: prompt, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
  wireShellOutput(id);
  // For non-BEL agents with a synchronous prompt, deliver after delay
  if (prompt && agentConfig.initialPromptDelay > 0) {
    shells.get(id).initialPrompt = null; // Clear so BEL handler doesn't also fire
    setTimeout(() => submitToShell(shell, prompt), agentConfig.initialPromptDelay);
  }
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  shell.onExit(() => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    if (!shuttingDown) { shells.delete(id); saveState(); }
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
  if (clients.length === 0) {
    // No browsers connected — auto-confirm
    return res.json({ result: 'confirmed' });
  }

  const timeout = setTimeout(() => {
    restartState = null;
    res.json({ result: 'timeout' });
  }, 60000);

  restartState = {
    resolve: (result) => {
      clearTimeout(timeout);
      restartState = null;
      res.json({ result });
    }
  };

  // Send confirm-restart to all connected browsers (they elect a leader)
  for (const ws of clients) {
    try { ws.send(JSON.stringify({ type: 'confirm-restart' })); } catch {}
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
const displayTabs = new Map(); // id → HTML string (ephemeral, not persisted)
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

      const shell = spawnAgent(savedAgentType, resumeArgs, cwd, { ...ptySize, env: { DEEPSTEVE_SESSION_ID: id } });
      const startTime = Date.now();
      const restoredName = name || restored.name || null;
      shells.set(id, { shell, clients: new Set(), cwd, claudeSessionId, agentType: savedAgentType, worktree: savedWorktree, name: restoredName, restored: true, waitingForInput: false, lastActivity: Date.now(), createdAt: restored.createdAt || Date.now(), windowId: restored.windowId || null });
      wireShellOutput(id);
      if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
      shell.onExit(() => {
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
          const fallbackShell = spawnClaude(fallbackArgs, cwd, { cols: initialCols, rows: initialRows, env: { DEEPSTEVE_SESSION_ID: id } });
          if (entry) {
            entry.shell = fallbackShell;
            entry.claudeSessionId = newClaudeSessionId;
            entry.killed = false;
            entry.scrollback = [];
            entry.scrollbackSize = 0;
            wireShellOutput(id);
            watchClaudeSessionDir(id);
            fallbackShell.onExit(() => { if (!shuttingDown) { unwatchClaudeSessionDir(id); shells.delete(id); saveState(); } });
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
    const sessionId = randomUUID();  // Full UUID for session ID (both agents)
    const agentConfig = getAgentConfig(agentType);
    
    // For agents that don't support --worktree natively: manually create worktree
    let worktreeCwd = cwd;
    if (worktree && !agentConfig.supportsWorktree) {
      worktreeCwd = ensureWorktree(cwd, worktree);
    }

    const spawnArgs = getSpawnArgs(agentType, { 
      sessionId, 
      planMode, 
      worktree 
    });

    log(`[WS] Creating NEW shell: oldId=${oldId}, newId=${id}, agent=${agentType}, session=${sessionId}, worktree=${worktree || 'none'}, cwd=${worktreeCwd}`);
    const shell = spawnAgent(agentType, spawnArgs, worktreeCwd, { cols: initialCols, rows: initialRows, env: { DEEPSTEVE_SESSION_ID: id } });
    shells.set(id, { shell, clients: new Set(), cwd: worktreeCwd, claudeSessionId: sessionId, agentType, worktree: worktree || null, name: name || null, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
    wireShellOutput(id);
    if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
    shell.onExit(() => { if (!shuttingDown) { if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id); shells.delete(id); saveState(); } });
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
      if (parsed.type === 'resize') { entry.shell.resize(parsed.cols, parsed.rows); return; }
      if (parsed.type === 'redraw') { entry.shell.write('\x0c'); return; } // Ctrl+L
      if (parsed.type === 'initialPrompt') {
        const config = getAgentConfig(entry.agentType);
        if (config.initialPromptDelay > 0) {
          // Agent doesn't emit BEL, so submit the prompt directly after a delay
          // to give the TUI time to initialize
          const prompt = parsed.text;
          setTimeout(() => submitToShell(entry.shell, prompt), config.initialPromptDelay);
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
    entry.shell.write(str);
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
initMCP({ app, shells, wss, broadcast, broadcastToWindow, log, MODS_DIR, closeSession, spawnAgent, getSpawnArgs, getAgentConfig, wireShellOutput, watchClaudeSessionDir, unwatchClaudeSessionDir, saveState, validateWorktree, ensureWorktree, submitToShell, fetchIssueFromGitHub, deliverPromptWhenReady, reloadClients, pendingOpens, settings, isShuttingDown: () => shuttingDown, displayTabs }).catch(e => log('MCP init failed:', e.message));

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
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mcp-server.js" << 'DEEPSTEVE_FILE_EOF'
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * Initialize MCP server with Streamable HTTP transport.
 * Dynamically imports the ESM-only @modelcontextprotocol/sdk,
 * scans mods for tools.js files, and mounts routes on the Express app.
 */
async function initMCP(context) {
  const { app, broadcast, log, MODS_DIR } = context;

  // Dynamic import of ESM-only SDK
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  // Collect tool definitions from mods that have a tools.js file
  const modTools = {};  // { toolName: { description, schema, handler } }

  if (fs.existsSync(MODS_DIR)) {
    const entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const toolsPath = path.resolve(MODS_DIR, entry.name, 'tools.js');
      if (!fs.existsSync(toolsPath)) continue;

      try {
        const mod = require(toolsPath);
        if (typeof mod.init === 'function') {
          const tools = mod.init(context);
          for (const [name, def] of Object.entries(tools)) {
            modTools[name] = def;
            log(`MCP: registered tool "${name}" from mod "${entry.name}"`);
          }
        }
        if (typeof mod.registerRoutes === 'function') {
          mod.registerRoutes(app, context);
          log(`MCP: registered REST routes from mod "${entry.name}"`);
        }
      } catch (e) {
        log(`MCP: failed to load tools from mod "${entry.name}":`, e.message);
      }
    }
  }

  if (Object.keys(modTools).length === 0) {
    log('MCP: no mod tools found, MCP endpoint will have no tools');
  }

  // Session management: one McpServer+transport per MCP session
  const sessions = new Map(); // sessionId → { server, transport }

  function createSession() {
    const server = new McpServer({
      name: 'deepsteve',
      version: '1.0.0',
    });

    // Register all mod tools on this server instance
    for (const [name, def] of Object.entries(modTools)) {
      server.tool(name, def.description, def.schema, def.handler);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    server.connect(transport);
    return { server, transport };
  }

  // POST /mcp — main MCP endpoint
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — route to its transport
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      log(`MCP: stale session ${sessionId}, creating new session`);
    }

    // No session ID or stale session — create new session
    const { server, transport } = createSession();

    // Capture the session ID after the transport generates it
    const origSetHeader = res.setHeader.bind(res);
    let capturedSessionId = null;
    res.setHeader = function(name, value) {
      if (name.toLowerCase() === 'mcp-session-id') {
        capturedSessionId = value;
      }
      return origSetHeader(name, value);
    };

    await transport.handleRequest(req, res, req.body);

    if (capturedSessionId) {
      sessions.set(capturedSessionId, { server, transport });
      log(`MCP: new session ${capturedSessionId}`);
    }
  });

  // GET /mcp — SSE stream for server→client notifications
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      // Stale or missing session — tell client to re-initialize
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
  });

  // DELETE /mcp — session teardown
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
      log(`MCP: session ${sessionId} deleted`);
    } else {
      // Stale session — nothing to clean up, just ack
      res.status(200).end();
    }
  });

  log(`MCP: server initialized with ${Object.keys(modTools).length} tools`);
}

module.exports = { initMCP };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <title>deepsteve</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0d1117">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" integrity="sha384-LJcOxlx9IMbNXDqJ2axpfEQKkAYbFjJfhXexLfiRJhjDU81mzgkiQq8rkV0j6dVh" crossorigin="anonymous">
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
  <div id="app-container">
    <div id="tabs">
      <button id="layout-toggle" class="layout-btn" title="Switch to vertical tabs">▤</button>
      <div id="tabs-list-wrapper">
        <div id="tabs-list"></div>
        <div id="tabs-arrows">
          <button id="tabs-arrow-start" class="tabs-arrow" aria-label="Scroll tabs back"></button>
          <button id="tabs-arrow-end" class="tabs-arrow" aria-label="Scroll tabs forward"></button>
        </div>
      </div>
      <div id="new-btn-group">
        <button id="new-btn">+</button>
        <button id="new-btn-dropdown" title="New tab options">&#9662;</button>
      </div>
      <button id="issue-btn" title="Pick a GitHub issue">&#9889;</button>
      <div id="tabs-spacer"></div>
      <div id="engines-dropdown" class="dropdown" style="display: none;">
        <button id="engines-btn" class="dropdown-btn" title="Select AI agent/engine">Engine</button>
        <div id="engines-menu" class="dropdown-menu"></div>
      </div>
      <div id="sessions-dropdown" class="dropdown">
        <button id="sessions-btn" class="dropdown-btn" title="Manage sessions">Sessions</button>
        <div id="sessions-menu" class="dropdown-menu"></div>
      </div>
      <button id="mods-btn" class="dropdown-btn" title="Toggle mods" style="display:none;">Mods</button>
      <button id="settings-btn" class="dropdown-btn" title="Settings">⚙</button>
    </div>
    <div id="sidebar-resizer"></div>
    <div id="terminals">
      <div id="empty-state">
        <pre class="empty-state-icon">
               ▄▄▄▄▄▄▄▄▄▄▄
           ▄█▀▀██████████▀█▄
         ▄█▀▄█████████████▄██
   ▄▄▄▄▄███████████████████████▄▄
   ████▄███████████████████████▄▀█▄
   ▀███████████████████▀   ████████
    ████████████████▀▀     ▀███████▄
   ██████▀██████▀▀▀          ▀▀█████
   ▀████   ▄▄▄▄▄▄       ▄▄▄▄▄   ████▄▄
    ███   █▀    ▀█▄▄▄▄▄█▀   ▀█▄  ████▀
     ██▀▀██      ██▀▀▀█       █▀▀██
      █   █▄    ▄█▀   ▀█     █▀  ██
      █    ▀▀███▀      ▀▀███▀▀   ██
      █                         ▄█▀
      █                        ▄█▀
      █                      ▄██▀
      █                 ▄▄▄▄█▀▀
      █    ▄█▀▀▀▀▀▀▀▀▀▀▀▀▀▀
      █ ▄██▀
      ██▀</pre>
        <pre class="empty-state-title">
     _                     _
  __| | ___  ___ _ __  ___| |_ _____   _____
 / _` |/ _ \/ _ \ '_ \/ __| __/ _ \ \ / / _ \
| (_| |  __/  __/ |_) \__ \ ||  __/\ V /  __/
 \__,_|\___|\___| .__/|___/\__\___| \_/ \___|
                |_|</pre>
        <button id="empty-state-btn" class="empty-state-btn">+ New</button>
        <div id="empty-state-configs" class="empty-state-configs"></div>
      </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js" integrity="sha384-/nfmYPUzWMS6v2atn8hbljz7NE0EI1iGx34lJaNzyVjWGDzMv+ciUZUeJpKA3Glc" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js" integrity="sha384-AQLWHRKAgdTxkolJcLOELg4E9rE89CPE2xMy3tIRFn08NcGKPTsELdvKomqji+DL" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-canvas@0.5.0/lib/xterm-addon-canvas.js" crossorigin="anonymous"></script>
  <script type="module" src="/js/app.js"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/sw.js" << 'DEEPSTEVE_FILE_EOF'
// Minimal service worker for PWA support
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/manifest.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "deepsteve",
  "short_name": "deepsteve",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0d1117",
  "theme_color": "#0d1117",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/css/styles.css" << 'DEEPSTEVE_FILE_EOF'
/* Theme variables — override these in ~/.deepsteve/themes/*.css */
:root {
  --ds-bg-primary: #0d1117;
  --ds-bg-secondary: #161b22;
  --ds-bg-tertiary: #21262d;
  --ds-border: #30363d;
  --ds-text-primary: #c9d1d9;
  --ds-text-secondary: #8b949e;
  --ds-text-bright: #f0f6fc;
  --ds-accent-green: #238636;
  --ds-accent-green-hover: #2ea043;
  --ds-accent-green-active: #1a7f37;
  --ds-accent-red: #f85149;
  --ds-accent-blue: #58a6ff;
  --ds-btn-neutral: #30363d;
  --ds-btn-neutral-hover: #3d444d;
  --ds-btn-neutral-active: #272c33;
  --ds-accent-orange: #f0883e;
  --ds-accent-green-soft: #3fb950;
  --ds-selected-bg: #1f3a2e;
  --ds-overlay: rgba(0, 0, 0, 0.7);
  --ds-shadow: rgba(0, 0, 0, 0.4);
  --ds-reconnect-overlay: rgba(13, 17, 23, 0.75);
  --ds-reconnect-glow: rgba(240, 136, 62, 0.3);
}

* { margin: 0; box-sizing: border-box; }
html, body { overscroll-behavior: none; }  /* Prevent swipe back/forward gestures */
body { background: var(--ds-bg-primary); color: var(--ds-text-primary); font-family: system-ui; height: 100vh; overflow: hidden; touch-action: none; }

/* App container - flexbox for layout switching */
#app-container { display: flex; flex-direction: column; height: 100vh; }

/* Tabs - horizontal layout (default) */
#tabs { display: flex; gap: 2px; padding: 4px 8px; background: var(--ds-bg-secondary); align-items: center; flex-shrink: 0; }
#tabs-list-wrapper { display: flex; min-width: 0; align-items: center; gap: 6px; }
#tabs-list { display: flex; gap: 2px; overflow-x: auto; min-width: 0; scrollbar-width: none; }
#tabs-list::-webkit-scrollbar { display: none; }

/* Tab scroll arrows */
#tabs-arrows { display: none; align-items: center; gap: 2px; flex-shrink: 0; }
#tabs-arrows.visible { display: flex; }
.tabs-arrow { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid var(--ds-border); border-radius: 50%; cursor: pointer; background: var(--ds-bg-tertiary); color: var(--ds-text-secondary); font-size: 12px; line-height: 1; }
.tabs-arrow:hover:not(.disabled) { background: var(--ds-border); color: var(--ds-text-bright); }
.tabs-arrow.disabled { opacity: 0.3; cursor: default; }
.tabs-arrow::after { font-family: system-ui; }
#tabs-arrow-start::after { content: '\2039'; }
#tabs-arrow-end::after { content: '\203A'; }

#tabs-spacer { flex: 1; }

/* Layout toggle button */
.layout-btn { padding: 4px 8px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); color: var(--ds-text-secondary); border-radius: 4px; cursor: pointer; font-size: 14px; margin-right: 8px; line-height: 1; }
.layout-btn:hover { background: var(--ds-border); color: var(--ds-text-primary); }

/* Sidebar resizer - hidden in horizontal mode */
#sidebar-resizer { display: none; }

/* Tab styling */
.tab { padding: 6px 12px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); border-radius: 6px 6px 0 0; cursor: pointer; color: var(--ds-text-secondary); font-size: 13px; display: flex; align-items: center; gap: 6px; flex-shrink: 0; max-width: 200px; user-select: none; }
.tab.active { background: var(--ds-bg-primary); color: var(--ds-text-bright); border-bottom-color: var(--ds-bg-primary); }
.tab .close { opacity: 0.5; cursor: pointer; font-size: 11px; }
.tab .close:hover { opacity: 1; color: var(--ds-accent-red); }
.tab .badge { width: 8px; height: 8px; background: var(--ds-accent-blue); border-radius: 50%; display: none; flex-shrink: 0; }
.tab .badge.visible { display: inline-block; }
.tab .tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab.placeholder { animation: tab-connecting 1.2s ease-in-out infinite; }
@keyframes tab-connecting { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
.tab.dragging { opacity: 0.3; }
.tab-drag-ghost { opacity: 0.9; box-shadow: 0 4px 12px rgba(0,0,0,0.5); border-color: var(--ds-accent-blue) !important; }
#tabs-list.tab-drag-active { user-select: none; }
#tabs-list.tab-drag-active .tab:not(.dragging) { pointer-events: none; transition: transform 0.15s ease; }
#tabs.tab-switch-mode { outline: 2px solid var(--ds-accent-blue); outline-offset: -2px; border-radius: 4px; }

/* Vertical layout mode */
#app-container.vertical-layout { flex-direction: row; }

#app-container.vertical-layout #tabs {
  flex-direction: column;
  align-items: stretch;
  padding: 8px;
  gap: 4px;
  height: 100vh;
  flex-shrink: 0;
  border-right: 1px solid var(--ds-border);
}

#app-container.vertical-layout #tabs-list-wrapper {
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 4px;
}

#app-container.vertical-layout #tabs-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

#app-container.vertical-layout #tabs-arrows { gap: 4px; justify-content: center; }
#app-container.vertical-layout #tabs-arrow-start::after { content: '\25B2'; }
#app-container.vertical-layout #tabs-arrow-end::after { content: '\25BC'; }

#app-container.vertical-layout #tabs-spacer { display: none; }

#app-container.vertical-layout .layout-btn { margin-right: 0; margin-bottom: 8px; }

#app-container.vertical-layout .tab {
  border-radius: 4px;
  width: 100%;
  position: relative;
  padding-right: 8px;
}

#app-container.vertical-layout .tab .close {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  background: var(--ds-bg-tertiary);
  padding: 2px 4px;
  border-radius: 3px;
}

#app-container.vertical-layout .tab:hover .close {
  opacity: 0.7;
}

#app-container.vertical-layout .tab .close:hover {
  opacity: 1;
}

#app-container.vertical-layout #new-btn-group {
  width: 100%;
  margin: 8px 0 0 0;
}
#app-container.vertical-layout #new-btn { flex: 1; }
#app-container.vertical-layout #new-btn-dropdown { flex-shrink: 0; }

#app-container.vertical-layout .dropdown {
  width: 100%;
  margin-top: 4px;
}

#app-container.vertical-layout #issue-btn {
  width: 100%;
  margin-top: 4px;
}

#app-container.vertical-layout .dropdown-btn {
  width: 100%;
}

#app-container.vertical-layout #settings-btn {
  width: 100%;
  margin: 4px 0 0 0;
}

#app-container.vertical-layout .dropdown-menu {
  left: 100%;
  right: auto;
  top: 0;
  margin-top: 0;
  margin-left: 4px;
}

#app-container.vertical-layout #content-row {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

#app-container.vertical-layout #terminals {
  flex: 1;
  min-width: 0;
}

/* Sidebar resizer for vertical layout */
#app-container.vertical-layout #sidebar-resizer {
  display: block;
  width: 4px;
  background: var(--ds-border);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
}

#app-container.vertical-layout #sidebar-resizer:hover {
  background: var(--ds-accent-blue);
}

/* Issue Button */
#issue-btn { padding: 4px 8px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); color: var(--ds-text-secondary); border-radius: 4px; cursor: pointer; font-size: 15px; line-height: 1; }
#issue-btn:hover { background: var(--ds-border); color: var(--ds-text-primary); }

/* Sessions Dropdown */
.dropdown { position: relative; }
.dropdown-btn { padding: 4px 10px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); color: var(--ds-text-secondary); border-radius: 4px; cursor: pointer; font-size: 13px; }
.dropdown-btn:hover { background: var(--ds-border); color: var(--ds-text-primary); }
#engines-btn { transition: all 0.15s ease; white-space: nowrap; }
#settings-btn { font-size: 13px; }
.dropdown-menu { display: none; position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--ds-bg-secondary); border: 1px solid var(--ds-border); border-radius: 6px; min-width: 220px; z-index: 200; box-shadow: 0 8px 24px var(--ds-shadow); max-height: 300px; overflow-y: auto; }
.dropdown-menu.open { display: block; }
.dropdown-item { padding: 8px 12px; font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--ds-bg-tertiary); }
.dropdown-item:last-child { border-bottom: none; }
.dropdown-item .session-info { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
.dropdown-item .session-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-agent-badge { font-size: 10px; background: var(--ds-bg-tertiary); color: var(--ds-text-secondary); padding: 1px 6px; border-radius: 8px; margin-left: 4px; vertical-align: middle; }
.dropdown-item .session-status { font-size: 11px; color: var(--ds-text-secondary); }
.dropdown-item .session-status.active { color: var(--ds-accent-green-soft); }
.dropdown-item .session-status.other-window { color: var(--ds-accent-blue); }
.dropdown-item .session-close { opacity: 0.5; cursor: pointer; padding: 2px 6px; font-size: 11px; }
.dropdown-item .session-close:hover { opacity: 1; color: var(--ds-accent-red); }
.dropdown-item.clickable { cursor: pointer; }
.dropdown-item.clickable:hover { background: var(--ds-bg-tertiary); }
.dropdown-item.connected { background: var(--ds-bg-tertiary); }
.dropdown-item.closed { opacity: 0.6; }
.dropdown-item .session-status.closed { color: var(--ds-text-muted); }
.dropdown-empty { padding: 12px; text-align: center; color: var(--ds-text-secondary); font-size: 13px; }
.dropdown-clear-disconnected { padding: 8px 12px; font-size: 12px; color: var(--ds-accent-red); text-align: center; cursor: pointer; border-bottom: 1px solid var(--ds-border); }
.dropdown-clear-disconnected:hover { background: var(--ds-bg-tertiary); }
.dropdown-clear-disconnected.disabled { color: var(--ds-text-muted); cursor: default; opacity: 0.5; }
.dropdown-clear-disconnected.disabled:hover { background: none; }

/* Context Menu */
.context-menu { position: fixed; background: var(--ds-bg-secondary); border: 1px solid var(--ds-border); border-radius: 6px; padding: 4px 0; min-width: 140px; z-index: 200; box-shadow: 0 8px 24px var(--ds-shadow); }
.context-menu-item { padding: 8px 12px; cursor: pointer; font-size: 13px; color: var(--ds-text-primary); }
.context-menu-item:hover { background: var(--ds-bg-tertiary); }
.context-menu-item.disabled { color: var(--ds-text-secondary); opacity: 0.5; cursor: default; }
.context-menu-item.disabled:hover { background: transparent; }
.context-menu-has-submenu { position: relative; }
.context-menu-arrow { float: right; margin-left: 12px; font-size: 10px; }
.context-menu-arrow::after { content: '\25B6'; }
.context-menu.context-submenu { min-width: 160px; white-space: nowrap; }
.context-submenu .context-menu-item { padding: 8px 12px; }

/* Split button group (+ / ▾) */
#new-btn-group { display: flex; margin-left: 4px; flex-shrink: 0; }
#new-btn { padding: 4px 10px; background: var(--ds-accent-green); border: none; color: white; border-radius: 4px 0 0 4px; cursor: pointer; font-size: 13px; user-select: none; }
#new-btn:hover { background: var(--ds-accent-green-hover); }
#new-btn:active { background: var(--ds-accent-green-active); }
#new-btn-dropdown { padding: 4px 6px; background: var(--ds-accent-green); border: none; border-left: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 0 4px 4px 0; cursor: pointer; font-size: 10px; user-select: none; }
#new-btn-dropdown:hover { background: var(--ds-accent-green-hover); }
#new-btn-dropdown:active { background: var(--ds-accent-green-active); }

/* New-tab menu extras */
.context-menu-header { padding: 6px 12px 4px; font-size: 11px; color: var(--ds-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
.context-menu-separator { height: 1px; background: var(--ds-border); margin: 4px 0; }
.new-tab-menu { max-height: 70vh; overflow-y: auto; }
.context-menu-more { text-align: center; color: var(--ds-text-secondary); font-size: 12px; }

/* Issue picker */
.issue-list { background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; max-height: 360px; overflow-y: auto; margin-bottom: 16px; }
.issue-item { padding: 10px 12px; cursor: pointer; border-bottom: 1px solid var(--ds-bg-tertiary); display: flex; align-items: flex-start; gap: 10px; }
.issue-item:last-child { border-bottom: none; }
.issue-item:hover { background: var(--ds-bg-tertiary); }
.issue-item.selected { background: var(--ds-selected-bg); border-color: var(--ds-accent-green); }
.issue-number { color: var(--ds-text-secondary); font-size: 13px; font-weight: 600; flex-shrink: 0; min-width: 36px; }
.issue-info { flex: 1; min-width: 0; }
.issue-title { color: var(--ds-text-primary); font-size: 13px; }
.issue-link { color: var(--ds-text-secondary); text-decoration: none; font-size: 14px; flex-shrink: 0; padding: 0 2px; opacity: 0.5; transition: opacity 0.15s; }
.issue-link:hover { opacity: 1; color: var(--ds-accent-green); }
.issue-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.issue-label { font-size: 11px; padding: 1px 6px; border-radius: 12px; background: var(--ds-bg-tertiary); color: var(--ds-text-secondary); border: 1px solid var(--ds-border); }
.issue-empty { padding: 16px; text-align: center; color: var(--ds-text-secondary); font-size: 13px; }
.issue-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px; gap: 12px; }
.issue-loading::before { content: ''; width: 24px; height: 24px; border: 2.5px solid var(--ds-border); border-top-color: var(--ds-accent-green); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.issue-loading-text { color: var(--ds-text-secondary); font-size: 13px; }
.issue-error { padding: 24px 16px; text-align: center; color: var(--ds-text-secondary); font-size: 13px; }
.issue-error-message { color: #e06c75; margin-bottom: 12px; }
.issue-retry { padding: 6px 16px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); color: var(--ds-text-primary); border-radius: 4px; cursor: pointer; font-size: 12px; }
.issue-retry:hover { background: var(--ds-bg-secondary); }
.issue-repo-selector { margin-bottom: 12px; }
.issue-repo-select { width: 100%; padding: 8px 12px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; font-family: monospace; cursor: pointer; }
.issue-repo-select:focus { outline: none; border-color: var(--ds-accent-green); }

/* Content row — terminals + panel side by side */
#content-row { display: flex; flex: 1; min-height: 0; }

/* Terminal containers */
#terminals { flex: 1; min-height: 0; min-width: 0; position: relative; }
.terminal-container { position: absolute; inset: 0; display: none; }
.terminal-container.active { display: flex; flex-direction: column; }
.terminal-container .xterm { flex: 1; }
.terminal-container.reconnecting::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ds-reconnect-overlay);
  z-index: 10;
  pointer-events: none;
}
.terminal-container.reconnecting::after {
  content: 'Reconnecting...';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--ds-bg-secondary);
  color: var(--ds-text-bright);
  padding: 16px 32px;
  border-radius: 8px;
  border: 1px solid var(--ds-accent-orange);
  font-size: 16px;
  font-weight: 600;
  z-index: 11;
  box-shadow: 0 0 20px var(--ds-reconnect-glow);
  animation: pulse 1.5s ease-in-out infinite;
  pointer-events: none;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
/* Reload spinner */
.reload-spinner { width: 32px; height: 32px; border: 3px solid var(--ds-border); border-top-color: var(--ds-accent-blue); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Modal */
.modal-overlay { position: fixed; inset: 0; background: var(--ds-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--ds-bg-secondary); border: 1px solid var(--ds-border); border-radius: 8px; padding: 20px; width: 420px; }
.modal h2 { font-size: 16px; margin-bottom: 16px; color: var(--ds-text-bright); }
.path-wrap { display: flex; gap: 8px; margin-bottom: 8px; }
.modal input[type="text"] { flex: 1; padding: 8px 12px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; font-family: monospace; }
.modal input[type="text"]:focus { outline: none; border-color: var(--ds-accent-green); }
.path-up, .new-folder { padding: 8px 12px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); border-radius: 4px; cursor: pointer; color: var(--ds-text-secondary); }
.path-up:hover, .new-folder:hover { background: var(--ds-border); color: var(--ds-text-primary); }
.dir-tree { background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; max-height: 240px; overflow-y: auto; margin-bottom: 12px; }
.dir-item { padding: 8px 12px; cursor: pointer; font-size: 13px; font-family: monospace; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--ds-bg-tertiary); }
.dir-item:last-child { border-bottom: none; }
.dir-item:hover { background: var(--ds-bg-tertiary); }
.dir-icon { opacity: 0.6; }
.dir-empty { padding: 16px; text-align: center; color: var(--ds-text-secondary); font-size: 13px; }
.modal label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 16px; cursor: pointer; }
.modal input[type="checkbox"] { accent-color: var(--ds-accent-green); }
.modal-buttons { display: flex; gap: 8px; justify-content: flex-end; }
.modal button { padding: 6px 14px; border-radius: 4px; border: 1px solid var(--ds-border); cursor: pointer; font-size: 13px; }
.modal .btn-primary { background: var(--ds-accent-green); color: white; border-color: var(--ds-accent-green); }
.modal .btn-primary:hover { background: var(--ds-accent-green-hover); }
.modal .btn-secondary { background: var(--ds-bg-tertiary); color: var(--ds-text-primary); }
.modal .btn-secondary:hover { background: var(--ds-border); }
.modal .btn-danger { background: var(--ds-accent-red); color: white; border-color: var(--ds-accent-red); }
.modal .btn-danger:hover { background: #da3633; }

/* Settings modal */
.settings-option { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.settings-option input[type="radio"] { accent-color: var(--ds-accent-green); }
.settings-option label { font-size: 13px; color: var(--ds-text-primary); cursor: pointer; }
.settings-custom { margin-top: 8px; }
.settings-custom input { width: 100%; }

/* Window restore modal */
.window-list { background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; max-height: 300px; overflow-y: auto; margin-bottom: 16px; }
.window-item { padding: 12px; cursor: pointer; border-bottom: 1px solid var(--ds-bg-tertiary); }
.window-item:last-child { border-bottom: none; }
.window-item:hover { background: var(--ds-bg-tertiary); }
.window-item.selected { background: var(--ds-accent-green); }
.window-item .window-title { font-size: 14px; color: var(--ds-text-bright); margin-bottom: 4px; }
.window-item .window-sessions { font-size: 12px; color: var(--ds-text-secondary); }
.window-item .session-name { display: inline-block; background: var(--ds-bg-tertiary); padding: 2px 6px; border-radius: 3px; margin-right: 4px; margin-top: 4px; }

/* Theme selector in settings */
.settings-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--ds-border); }
.settings-section h3 { font-size: 14px; color: var(--ds-text-bright); margin-bottom: 8px; }
.theme-select { width: 100%; padding: 8px 12px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; cursor: pointer; }
.theme-select:focus { outline: none; border-color: var(--ds-accent-green); }

/* Version info in settings */
.version-info { font-size: 13px; color: var(--ds-text-secondary); }
.version-status { margin-top: 4px; font-size: 12px; }
.version-ok { color: var(--ds-accent-green-soft); }
.version-update { color: var(--ds-accent-blue); }
.version-failed { color: var(--ds-text-secondary); }

/* Settings modal — scrollable with pinned header/footer */
.settings-modal {
  width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.settings-header {
  padding: 20px 20px 0;
  flex-shrink: 0;
}
.settings-tabs {
  display: flex;
  gap: 0;
  margin-top: 12px;
  border-bottom: 1px solid var(--ds-border);
}
.settings-tab {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ds-text-secondary);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.settings-tab:hover {
  color: var(--ds-text-primary);
}
.settings-tab.active {
  color: var(--ds-accent-green);
  border-bottom-color: var(--ds-accent-green);
}
.settings-tab-content {
  display: none;
}
.settings-tab-content.active {
  display: block;
}
.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 20px 8px;
  min-height: 0;
}
.settings-body::-webkit-scrollbar { width: 6px; }
.settings-body::-webkit-scrollbar-track { background: transparent; }
.settings-body::-webkit-scrollbar-thumb { background: var(--ds-border); border-radius: 3px; }
.settings-body::-webkit-scrollbar-thumb:hover { background: var(--ds-text-secondary); }
.settings-modal .modal-buttons {
  padding: 12px 20px 20px;
  border-top: 1px solid var(--ds-border);
  flex-shrink: 0;
}

/* Settings section cards */
.settings-modal .settings-section {
  margin-top: 12px;
  padding: 12px;
  border-top: none;
  border: 1px solid var(--ds-border);
  border-radius: 6px;
  background: var(--ds-bg-primary);
}
.settings-modal .settings-section h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--ds-text-secondary);
  margin-bottom: 10px;
}

/* Mod system */
#mod-container { flex: 1; min-height: 0; display: none; }
#mod-container iframe { width: 100%; height: 100%; border: none; }

/* Panel container (side panel for panel-mode mods) */
#panel-container { display: none; flex-shrink: 0; width: 360px; overflow: hidden; border-left: 1px solid var(--ds-border); position: relative; }
#panel-container iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; }

/* Panel tabs (right edge vertical tab strip) */
#panel-tabs { display: none; flex-direction: column; flex-shrink: 0; background: var(--ds-bg-secondary); border-left: 1px solid var(--ds-border); }
.panel-tab { writing-mode: vertical-rl; padding: 12px 6px; background: transparent; border: none; border-left: 2px solid transparent; color: var(--ds-text-secondary); font-size: 12px; cursor: pointer; white-space: nowrap; position: relative; }
.panel-tab:hover { color: var(--ds-text-primary); background: var(--ds-bg-tertiary); }
.panel-tab.active { color: var(--ds-accent-blue); border-left-color: var(--ds-accent-blue); background: var(--ds-bg-tertiary); }
.panel-tab-badge { display: none; position: absolute; top: 6px; right: 2px; min-width: 8px; height: 8px; background: var(--ds-accent-red, #f85149); border-radius: 50%; font-size: 0; }
.panel-tab-badge.visible { display: block; }

/* Panel resizer */
#panel-resizer { display: none; width: 4px; background: var(--ds-border); cursor: col-resize; flex-shrink: 0; transition: background 0.15s; }
#panel-resizer:hover { background: var(--ds-accent-blue); }

/* Mods button (right side, near Sessions) */
.mod-toggle-item { cursor: pointer; }
.mod-toggle-item:hover { background: var(--ds-bg-tertiary); }
.mod-toggle-label { cursor: pointer; flex-shrink: 0; }
.mod-toggle-label input[type="checkbox"] { accent-color: var(--ds-accent-green); cursor: pointer; }

/* Mod toolbar buttons (left side, registered by enabled mods) */
.mod-toolbar-btn { padding: 4px 10px; background: var(--ds-btn-neutral); border: none; color: var(--ds-text-primary); border-radius: 4px; cursor: pointer; font-size: 13px; margin-left: 4px; user-select: none; }
.mod-toolbar-btn:hover { background: var(--ds-btn-neutral-hover); }
.mod-toolbar-btn:active { background: var(--ds-btn-neutral-active); }
.mod-toolbar-btn.active { background: var(--ds-accent-blue); color: #fff; }

/* Mod back button */
.mod-back-btn { padding: 4px 10px; background: var(--ds-btn-neutral); border: none; color: var(--ds-accent-blue); border-radius: 4px; cursor: pointer; font-size: 13px; user-select: none; }
.mod-back-btn:hover { background: var(--ds-btn-neutral-hover); }

/* Vertical layout mod buttons */
#app-container.vertical-layout .mod-toolbar-btn { width: 100%; margin: 4px 0 0 0; }
#app-container.vertical-layout .mod-back-btn { width: 100%; margin-bottom: 4px; }
#app-container.vertical-layout #mods-btn { width: 100%; margin-top: 4px; }

/* Mod settings button (gear icon in mods dropdown) */
.mod-settings-btn { background: transparent; border: none; color: var(--ds-text-secondary); cursor: pointer; font-size: 20px; padding: 0 2px; border-radius: 3px; line-height: 1; flex-shrink: 0; }
.mod-settings-btn:hover { background: var(--ds-bg-tertiary); color: var(--ds-text-primary); }

/* Mod versioning */
.mod-incompatible { opacity: 0.5; }
.mod-incompatible input[type="checkbox"] { pointer-events: none; }
.mod-version { color: var(--ds-text-secondary); }
.mod-warning { font-size: 11px; color: var(--ds-accent-red); margin-top: 2px; }

/* Mod settings modal */
.mod-setting-item { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--ds-border); }
.mod-setting-item:last-child { border-bottom: none; }
.mod-setting-toggle { flex-shrink: 0; margin-top: 2px; accent-color: var(--ds-accent-green); cursor: pointer; width: 16px; height: 16px; }
.mod-setting-label { font-size: 13px; color: var(--ds-text-primary); cursor: pointer; }
.mod-setting-desc { font-size: 12px; color: var(--ds-text-secondary); margin-top: 2px; }

/* Marketplace modal */
.marketplace-modal { width: 860px; max-height: 80vh; display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.marketplace-header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 0; }
.marketplace-header h2 { margin: 0; flex-shrink: 0; }
.marketplace-search { flex: 1; }
.marketplace-search input { width: 100%; padding: 7px 12px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; }
.marketplace-search input:focus { outline: none; border-color: var(--ds-accent-blue); }
.marketplace-search input::placeholder { color: var(--ds-text-secondary); }
.marketplace-filters { display: flex; gap: 6px; padding: 12px 20px 0; }
.filter-pill { padding: 4px 12px; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); border-radius: 12px; color: var(--ds-text-secondary); font-size: 12px; cursor: pointer; }
.filter-pill:hover { color: var(--ds-text-primary); border-color: var(--ds-text-secondary); }
.filter-pill.active { background: var(--ds-accent-blue); color: #fff; border-color: var(--ds-accent-blue); }
.marketplace-list { flex: 1; overflow-y: auto; padding: 12px 20px; min-height: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; align-content: start; }
.mod-card { padding: 12px; border: 1px solid var(--ds-border); border-radius: 6px; background: var(--ds-bg-primary); }
.mod-card:hover { border-color: var(--ds-text-secondary); }
.mod-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mod-card-info { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mod-card-name { font-size: 14px; font-weight: 600; color: var(--ds-text-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mod-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; font-weight: 500; }
.mod-badge.built-in { background: var(--ds-bg-tertiary); color: var(--ds-text-secondary); border: 1px solid var(--ds-border); }
.mod-badge.official { background: rgba(88, 166, 255, 0.15); color: var(--ds-accent-blue); border: 1px solid rgba(88, 166, 255, 0.3); }
.mod-badge.experimental { background: rgba(227, 179, 65, 0.15); color: #e3b341; border: 1px solid rgba(227, 179, 65, 0.3); }
.mod-badge.skill { background: rgba(163, 113, 247, 0.15); color: #a371f7; border: 1px solid rgba(163, 113, 247, 0.3); }
.mod-card-version { font-size: 11px; color: var(--ds-text-secondary); }
.mod-card-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.mod-card-toggle { position: relative; width: 36px; height: 20px; }
.mod-card-toggle input { opacity: 0; width: 0; height: 0; }
.mod-card-toggle .toggle-slider { position: absolute; inset: 0; background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); border-radius: 10px; cursor: pointer; transition: background 0.2s, border-color 0.2s; }
.mod-card-toggle .toggle-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: var(--ds-text-secondary); border-radius: 50%; transition: transform 0.2s, background 0.2s; }
.mod-card-toggle input:checked + .toggle-slider { background: var(--ds-accent-green); border-color: var(--ds-accent-green); }
.mod-card-toggle input:checked + .toggle-slider::before { transform: translateX(16px); background: #fff; }
.mod-card-toggle input:disabled + .toggle-slider { opacity: 0.4; cursor: not-allowed; }
.mod-card-description { font-size: 12px; color: var(--ds-text-secondary); margin-top: 6px; line-height: 1.4; }

/* Skill view button & content modal */
.skill-view-btn { background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); color: var(--ds-text-secondary); font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer; transition: background 0.15s, color 0.15s; }
.skill-view-btn:hover { background: var(--ds-bg-hover); color: var(--ds-text-primary); }
.skill-content-modal { max-width: 700px; width: 90vw; }
.skill-content-body { max-height: 60vh; overflow: auto; padding: 12px 16px; }
.skill-content-body pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; font-size: 12px; line-height: 1.5; color: var(--ds-text-primary); font-family: var(--ds-font-mono, monospace); }

/* Mod dependency tags */
.mod-card-deps { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; font-size: 11px; color: var(--ds-text-secondary); }
.dep-tag { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 10px; font-weight: 500; }
.dep-tag-green { background: rgba(63, 185, 80, 0.15); color: var(--ds-accent-green-soft); border: 1px solid rgba(63, 185, 80, 0.3); }
.dep-tag-orange { background: rgba(240, 136, 62, 0.15); color: var(--ds-accent-orange); border: 1px solid rgba(240, 136, 62, 0.3); }
.dep-tag-red { background: rgba(248, 81, 73, 0.15); color: var(--ds-accent-red); border: 1px solid rgba(248, 81, 73, 0.3); }

/* Mod dependency notices */
.mod-dep-notice { margin-top: 8px; padding: 6px 10px; border-radius: 4px; font-size: 11px; animation: dep-notice-fade 4s ease-out forwards; }
.mod-dep-notice-info { background: rgba(88, 166, 255, 0.1); color: var(--ds-accent-blue); border: 1px solid rgba(88, 166, 255, 0.2); }
.mod-dep-notice-error { background: rgba(248, 81, 73, 0.1); color: var(--ds-accent-red); border: 1px solid rgba(248, 81, 73, 0.2); }
@keyframes dep-notice-fade { 0%, 75% { opacity: 1; } 100% { opacity: 0; } }
.mod-card-footer { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ds-border); }
.mod-card-footer .btn-install { padding: 4px 12px; background: var(--ds-accent-green); border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; }
.mod-card-footer .btn-install:hover { background: var(--ds-accent-green-hover); }
.mod-card-footer .btn-install:disabled { opacity: 0.5; cursor: not-allowed; }
.mod-card-footer .btn-install.loading { background: var(--ds-bg-tertiary); color: var(--ds-text-secondary); border: 1px solid var(--ds-border); }
.mod-card-footer .btn-uninstall { padding: 4px 12px; background: transparent; border: 1px solid var(--ds-accent-red); color: var(--ds-accent-red); border-radius: 4px; cursor: pointer; font-size: 12px; }
.mod-card-footer .btn-uninstall:hover { background: rgba(248, 81, 73, 0.1); }
.mod-card-footer .btn-update { padding: 4px 12px; background: var(--ds-accent-blue); border: none; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; }
.mod-card-footer .btn-update:hover { opacity: 0.9; }
.mod-card-incompatible { opacity: 0.5; }
.marketplace-modal .modal-buttons { padding: 12px 20px 20px; border-top: 1px solid var(--ds-border); }
.marketplace-empty { padding: 32px 16px; text-align: center; color: var(--ds-text-secondary); font-size: 13px; }

/* Empty state (no tabs open) */
#empty-state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; user-select: none; background: #0d0d0d; animation: empty-state-fade-in 0.4s ease-out; }
#empty-state.hidden { display: none; }
#empty-state pre { margin: 0; font-family: monospace; line-height: 1.1; }
#empty-state .empty-state-icon { color: var(--ds-accent-blue); opacity: 0.7; font-size: 14px; }
#empty-state .empty-state-title { color: var(--ds-accent-blue); opacity: 0.4; font-size: 12px; margin-top: 8px; }
#empty-state .empty-state-btn { margin-top: 24px; padding: 8px 20px; font-size: 14px; font-family: inherit; color: var(--ds-text-primary); background: var(--ds-bg-tertiary); border: 1px solid var(--ds-border); border-radius: 6px; cursor: pointer; opacity: 0.7; transition: opacity 0.15s, background 0.15s; }
#empty-state .empty-state-btn:hover { opacity: 1; background: var(--ds-bg-secondary); }
#empty-state .empty-state-configs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; justify-content: center; max-width: 600px; }
#empty-state .empty-state-configs:empty { display: none; }

/* Shared config button styles (used in empty state and directory picker modal) */
.config-btn { padding: 6px 16px; font-size: 13px; font-family: inherit; color: var(--ds-text-primary); background: transparent; border: 1px solid var(--ds-border); border-radius: 6px; cursor: pointer; opacity: 0.7; transition: opacity 0.15s, background 0.15s; }
.config-btn:hover { opacity: 1; background: var(--ds-bg-tertiary); }

/* Config section in directory picker modal */
.modal .config-section { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.modal .config-separator { border-bottom: 1px solid var(--ds-border); margin-bottom: 12px; }
@keyframes empty-state-fade-in { from { opacity: 0; } to { opacity: 1; } }

/* File drop zone overlay */
.file-drop-zone {
  position: absolute;
  inset: 0;
  z-index: 50;
  border: 2px dashed var(--ds-accent-green);
  background: rgba(35, 134, 54, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.file-drop-zone.visible { opacity: 1; }
/* Scroll-to-bottom floating button */
.scroll-to-bottom {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  padding: 4px 16px;
  background: var(--ds-bg-secondary);
  border: 1px solid var(--ds-border);
  border-radius: 16px;
  color: var(--ds-text-secondary);
  font-size: 14px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
  box-shadow: 0 2px 8px var(--ds-shadow);
}
.scroll-to-bottom.visible { opacity: 1; pointer-events: auto; }
.scroll-to-bottom:hover { background: var(--ds-bg-tertiary); color: var(--ds-text-primary); border-color: var(--ds-accent-blue); }

.file-drop-zone-content {
  background: var(--ds-bg-secondary);
  color: var(--ds-text-bright);
  padding: 16px 32px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  border: 1px solid var(--ds-accent-green);
}

DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/app.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Main application entry point
 */

import { SessionStore } from './session-store.js';
import { WindowManager } from './window-manager.js';
import { TabManager, getDefaultTabName, initTabArrows } from './tab-manager.js';
import { createTerminal, setupTerminalIO, fitTerminal, observeTerminalResize, measureTerminalSize, updateTerminalTheme } from './terminal.js';
import { createWebSocket } from './ws-client.js';
import { showDirectoryPicker } from './dir-picker.js';
import { showWindowRestoreModal } from './window-restore-modal.js';
import { LayoutManager } from './layout-manager.js';
import { initLiveReload } from './live-reload.js';
import { ModManager } from './mod-manager.js';
import { initFileDrop } from './file-drop.js';
import { init as initCmdHoldMode, setEnabled as setCmdHoldModeEnabled, setHoldMs as setCmdHoldModeHoldMs } from './cmd-tab-switch.js';
import { nsKey } from './storage-namespace.js';

// Configuration
let maxIssueTitleLength = 25;

function truncateTitle(title) {
  if (title.length <= maxIssueTitleLength) return title;
  return title.slice(0, maxIssueTitleLength) + '…';
}

// Active sessions in memory
const sessions = new Map();
let activeId = null;

// Dedup set for browser-eval/console requests (each tab processes once)
const processedBrowserRequests = new Set();

/**
 * Per-tab session persistence via sessionStorage.
 * This is the authoritative source for "what sessions does THIS tab have."
 * Survives page refresh, doesn't depend on localStorage window-ID mapping.
 */
const TabSessions = {
  KEY: nsKey('deepsteve-tab-sessions'),
  get() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY)) || []; } catch { return []; }
  },
  save(sessionList) {
    sessionStorage.setItem(this.KEY, JSON.stringify(sessionList));
  },
  add(session) {
    const list = this.get();
    if (!list.find(s => s.id === session.id)) list.push(session);
    this.save(list);
  },
  remove(sessionId) {
    this.save(this.get().filter(s => s.id !== sessionId));
  },
  updateId(oldId, newId) {
    const list = this.get();
    const s = list.find(s => s.id === oldId);
    if (s) { s.id = newId; this.save(list); }
  }
};

/**
 * Persist the active tab ID in sessionStorage so it survives page refresh.
 */
const ActiveTab = {
  KEY: nsKey('deepsteve-active-tab'),
  get() { return sessionStorage.getItem(this.KEY); },
  set(id) { sessionStorage.setItem(this.KEY, id); },
  clear() { sessionStorage.removeItem(this.KEY); }
};

// Prevent accidental browser navigation (back/forward)
window.addEventListener('popstate', (e) => {
  // Push state back to prevent navigation
  history.pushState(null, '', location.href);
});
// Initialize history state
history.pushState(null, '', location.href);

// Warn before leaving page with active sessions
window.addEventListener('beforeunload', (e) => {
  if (window.__deepsteveReloadPending) return; // Skip prompt during server restart reload
  const hasActiveSessions = [...sessions.values()].some(s => s.type !== 'mod-tab' && s.type !== 'display-tab' && !s.waitingForInput);
  if (hasActiveSessions) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// Notification infrastructure
let notifPermission = 'Notification' in window ? Notification.permission : 'denied';
const notifCooldown = new Map();
const activeNotifications = new Map();
const COOLDOWN_MS = 10000;

// Request notification permission on first click
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => notifPermission = p);
  }
}, { once: true });

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

function showNotification(id, name) {
  if (notifPermission !== 'granted') return;
  if (activeId === id && document.hasFocus()) return;
  const last = notifCooldown.get(id) || 0;
  if (Date.now() - last < COOLDOWN_MS) return;

  notifCooldown.set(id, Date.now());
  const notif = new Notification('Claude needs attention', {
    body: `"${name}" is waiting for input`,
    tag: id
  });
  notif.onclose = () => activeNotifications.delete(id);
  activeNotifications.set(id, notif);
}

function clearNotification(id) {
  const notif = activeNotifications.get(id);
  if (notif) {
    notif.close();
    activeNotifications.delete(id);
  }
}

function clearAllNotifications() {
  for (const [id, notif] of activeNotifications) {
    notif.close();
  }
  activeNotifications.clear();
}

/**
 * Apply a theme by injecting/updating a <style> tag with the given CSS.
 * Pass empty string to revert to default (built-in CSS variables).
 */
function applyTheme(css) {
  let style = document.getElementById('ds-theme');
  if (!css) {
    if (style) style.remove();
  } else {
    if (!style) {
      style = document.createElement('style');
      style.id = 'ds-theme';
      document.head.appendChild(style);
    }
    style.textContent = css;
  }
  // Update all existing terminal backgrounds to match the new --ds-bg-primary
  for (const [, session] of sessions) {
    updateTerminalTheme(session.term);
  }
}

function applySettings(settings) {
  if (settings.maxIssueTitleLength !== undefined) {
    maxIssueTitleLength = settings.maxIssueTitleLength;
  }
  if (settings.cmdTabSwitch !== undefined) {
    setCmdHoldModeEnabled(settings.cmdTabSwitch);
  }
  if (settings.cmdTabSwitchHoldMs !== undefined) {
    setCmdHoldModeHoldMs(settings.cmdTabSwitchHoldMs);
  }
  if (settings.windowConfigs !== undefined) {
    windowConfigs = settings.windowConfigs;
    renderEmptyStateConfigs();
    window.dispatchEvent(new CustomEvent('deepsteve-window-configs', { detail: windowConfigs }));
  }
}

// When the browser tab regains visibility, re-sync scroll position.
// scrollToBottom() calls from onWriteParsed may have been no-ops while
// the tab was hidden (browsers skip layout for background tabs), so the
// viewport can fall behind even though the scroll state is AUTO.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeId) {
    clearNotification(activeId);
    const session = sessions.get(activeId);
    if (session?.scrollControl) {
      session.scrollControl.nudgeToBottom();
    }
  }
});
window.addEventListener('focus', () => {
  if (activeId) clearNotification(activeId);
});

function updateTitle() {
  const count = [...sessions.values()].filter(s => s.waitingForInput).length;
  document.title = count > 0 ? `(${count}) deepsteve` : 'deepsteve';
}

function updateEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.classList.toggle('hidden', sessions.size > 0);
}

let windowConfigs = [];

function renderEmptyStateConfigs() {
  const container = document.getElementById('empty-state-configs');
  if (!container) return;
  container.innerHTML = '';
  for (const config of windowConfigs) {
    const btn = document.createElement('button');
    btn.className = 'config-btn';
    btn.textContent = config.name;
    btn.title = `Open ${config.tabs.length} tab${config.tabs.length === 1 ? '' : 's'}`;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Opening...';
      try {
        await fetch(`/api/window-configs/${config.id}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowId: getWindowId() })
        });
      } catch (e) {
        console.error('Failed to apply window config:', e);
      }
    };
    container.appendChild(btn);
  }
}

async function loadWindowConfigs() {
  try {
    const resp = await fetch('/api/window-configs');
    const data = await resp.json();
    windowConfigs = data.configs || [];
    renderEmptyStateConfigs();
  } catch {}
}

// Load configs on startup
loadWindowConfigs();

/**
 * Build a session list for the mod bridge API
 */
function getSessionList() {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    name: s.name || getDefaultTabName(s.cwd),
    cwd: s.cwd,
    waitingForInput: s.waitingForInput || false,
    type: s.type || 'terminal',
  }));
}

// Expose session internals for mods that need direct terminal access (e.g. reparenting)
window.__deepsteve = {
  fitSession(id) {
    const s = sessions.get(id);
    if (s) fitTerminal(s.term, s.fit, s.ws);
  },
  getTerminalContainer(id) {
    const s = sessions.get(id);
    return s ? s.container : null;
  },
  writeSession(id, data) {
    const s = sessions.get(id);
    if (s) s.ws.send(data);
  },
  getTerminal(id) {
    const s = sessions.get(id);
    return s ? s.term : null;
  },
  // Subscribe to raw terminal output data for a session. Returns unsubscribe function.
  _dataListeners: new Map(),
  onSessionData(id, callback) {
    if (!this._dataListeners.has(id)) this._dataListeners.set(id, new Set());
    this._dataListeners.get(id).add(callback);
    return () => { this._dataListeners.get(id)?.delete(callback); };
  },
};

// Sessions dropdown
const sessionsBtn = document.getElementById('sessions-btn');
const sessionsMenu = document.getElementById('sessions-menu');

sessionsBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const isOpen = sessionsMenu.classList.toggle('open');
  if (isOpen) {
    await refreshSessionsDropdown();
  }
});

document.addEventListener('click', () => {
  sessionsMenu?.classList.remove('open');
});

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function refreshSessionsDropdown() {
  try {
    const res = await fetch('/api/shells');
    const data = await res.json();
    const allShells = data.shells || [];

    if (allShells.length === 0) {
      sessionsMenu.innerHTML = '<div class="dropdown-empty">No sessions</div>';
      return;
    }

    // Get IDs of sessions connected in THIS tab
    const connectedIds = new Set(sessions.keys());

    // Classify each session into three states
    const thisTab = s => connectedIds.has(s.id);
    const otherWindow = s => !connectedIds.has(s.id) && (s.connectedClients || 0) > 0;
    // Sort: this-tab first, then other-window, then disconnected
    const stateOrder = s => thisTab(s) ? 0 : otherWindow(s) ? 1 : 2;
    const statusOrder = { active: 0, saved: 1, closed: 2 };
    allShells.sort((a, b) => {
      const orderDiff = stateOrder(a) - stateOrder(b);
      if (orderDiff !== 0) return orderDiff;
      return (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
    });

    const showAgentBadge = window.__deepsteveAgents?.length > 1;

    sessionsMenu.innerHTML = allShells.map(shell => {
      const isThisTab = thisTab(shell);
      const isOtherWindow = otherWindow(shell);
      const isClosed = shell.status === 'closed';
      const name = sessions.get(shell.id)?.name || shell.name || getDefaultTabName(shell.cwd);
      const staleness = !isThisTab && !isOtherWindow && shell.lastActivity ? formatRelativeTime(shell.lastActivity) : '';
      const statusText = isThisTab ? 'connected' : isOtherWindow ? 'other window' : (isClosed ? (staleness ? `closed ${staleness}` : 'closed') : (staleness || (shell.status === 'saved' ? 'saved' : 'not connected')));
      const statusClass = isThisTab ? 'active' : isOtherWindow ? 'other-window' : (isClosed ? 'closed' : '');
      const canClose = !isThisTab && !isOtherWindow;
      const agentLabel = shell.agentType === 'opencode' ? 'OpenCode' : (shell.agentType ? shell.agentType.charAt(0).toUpperCase() + shell.agentType.slice(1) : '');

      return `
        <div class="dropdown-item ${isThisTab ? 'connected' : 'clickable'} ${isClosed ? 'closed' : ''}" data-id="${shell.id}" data-cwd="${shell.cwd}" data-name="${escapeHtml(name)}">
          <div class="session-info">
            <span class="session-name">${name}${showAgentBadge && agentLabel ? ` <span class="session-agent-badge">${agentLabel}</span>` : ''}</span>
            <span class="session-status ${statusClass}">${statusText}</span>
          </div>
          ${canClose ? `<span class="session-close" data-id="${shell.id}">✕</span>` : ''}
        </div>
      `;
    }).join('');

    // Add "Clear disconnected" button at the top — only count truly disconnected sessions
    const disconnectedCount = allShells.filter(s => !connectedIds.has(s.id) && (s.connectedClients || 0) === 0).length;
    const clearBtn = document.createElement('div');
    clearBtn.className = 'dropdown-clear-disconnected' + (disconnectedCount === 0 ? ' disabled' : '');
    clearBtn.textContent = disconnectedCount > 0 ? `Clear disconnected (${disconnectedCount})` : 'Clear disconnected';
    if (disconnectedCount > 0) {
      clearBtn.addEventListener('click', async () => {
        await fetch('/api/shells/clear-disconnected', { method: 'POST' });
        await refreshSessionsDropdown();
      });
    }
    sessionsMenu.prepend(clearBtn);

    // Add click handlers to attach to non-connected sessions
    sessionsMenu.querySelectorAll('.dropdown-item.clickable').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-close')) return;
        const id = item.dataset.id;
        const cwd = item.dataset.cwd;
        const name = item.dataset.name || null;
        sessionsMenu.classList.remove('open');
        createSession(cwd, id, false, { name });
      });
    });

    // Add close handlers
    sessionsMenu.querySelectorAll('.session-close').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!(await confirmCloseSession(id))) return;
        await fetch(`/api/shells/${id}`, { method: 'DELETE' });
        await refreshSessionsDropdown();
      });
    });
  } catch (err) {
    sessionsMenu.innerHTML = '<div class="dropdown-empty">Error loading sessions</div>';
  }
}

// Settings modal
const settingsBtn = document.getElementById('settings-btn');

settingsBtn?.addEventListener('click', async () => {
  const [settingsData, themesData, versionData, defaultsData] = await Promise.all([
    fetch('/api/settings').then(r => r.json()),
    fetch('/api/themes').then(r => r.json()),
    fetch('/api/version').then(r => r.json()).catch(() => ({ current: '?', latest: null, updateAvailable: false })),
    fetch('/api/settings/defaults').then(r => r.json()).catch(() => ({}))
  ]);
  const currentProfile = settingsData.shellProfile || '~/.zshrc';
  const currentMaxTitle = settingsData.maxIssueTitleLength || 25;
  const currentWandPlanMode = settingsData.wandPlanMode !== undefined ? settingsData.wandPlanMode : true;
  const currentWandTemplate = settingsData.wandPromptTemplate || defaultsData.wandPromptTemplate || '';
  const currentCmdTabSwitch = !!settingsData.cmdTabSwitch;
  const currentCmdTabSwitchHoldMs = settingsData.cmdTabSwitchHoldMs !== undefined ? settingsData.cmdTabSwitchHoldMs : 1000;
  const currentDefaultAgent = settingsData.defaultAgent || 'claude';
  const currentOpencodeBinary = settingsData.opencodeBinary || 'opencode';
  const currentGeminiBinary = settingsData.geminiBinary || 'gemini';
  const agents = window.__deepsteveAgents || [];
  const themes = themesData.themes || [];
  const activeTheme = themesData.active || '';

  const themeOptions = ['<option value="">None</option>']
    .concat(themes.map(t => `<option value="${escapeHtml(t)}" ${t === activeTheme ? 'selected' : ''}>${escapeHtml(t)}</option>`))
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="settings-header">
        <h2>Settings</h2>
        <div class="settings-tabs">
          <button class="settings-tab active" data-tab="general">General</button>
          <button class="settings-tab" data-tab="github">GitHub</button>
          <button class="settings-tab" data-tab="windows">Windows</button>
        </div>
      </div>
      <div class="settings-body">
      <div class="settings-tab-content active" data-tab="general">
      <div class="settings-section">
        <h3>Version</h3>
        <div class="version-info">
          <span>Version ${escapeHtml(versionData.current)}</span>
          <div class="version-status ${
            versionData.latest === null ? 'version-failed' :
            versionData.updateAvailable ? 'version-update' : 'version-ok'
          }">${
            versionData.latest === null ? "Couldn\u2019t check for updates" :
            versionData.updateAvailable ? `Version ${escapeHtml(versionData.latest)} available \u2014 see deepsteve.com for upgrade instructions` :
            "You\u2019re up to date"
          }</div>
        </div>
      </div>
      <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 12px;">
        Shell profile to source before running Claude:
      </p>
      <div class="settings-option">
        <input type="radio" name="profile" id="profile-zshrc" value="~/.zshrc" ${currentProfile === '~/.zshrc' ? 'checked' : ''}>
        <label for="profile-zshrc">~/.zshrc (zsh)</label>
      </div>
      <div class="settings-option">
        <input type="radio" name="profile" id="profile-bashrc" value="~/.bashrc" ${currentProfile === '~/.bashrc' ? 'checked' : ''}>
        <label for="profile-bashrc">~/.bashrc (bash)</label>
      </div>
      <div class="settings-option">
        <input type="radio" name="profile" id="profile-custom" value="custom" ${currentProfile !== '~/.zshrc' && currentProfile !== '~/.bashrc' ? 'checked' : ''}>
        <label for="profile-custom">Custom</label>
      </div>
      <div class="settings-custom">
        <input type="text" id="custom-profile" placeholder="~/.config/myprofile" value="${currentProfile !== '~/.zshrc' && currentProfile !== '~/.bashrc' ? currentProfile : ''}">
      </div>
      <div class="settings-section">
        <h3>Theme</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Place .css files in ~/.deepsteve/themes/ to add themes.
        </p>
        <select class="theme-select" id="theme-select">${themeOptions}</select>
      </div>
      <div class="settings-section">
        <h3>Keyboard</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="cmd-tab-switch" ${currentCmdTabSwitch ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Hold \u2318 to switch tabs (\u23181-9, \u2318&lt; \u2318&gt;)
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); display: flex; align-items: center; gap: 8px; margin-top: 8px;">
          Hold delay:
          <input type="number" id="cmd-tab-switch-hold-ms" value="${currentCmdTabSwitchHoldMs}" min="0" max="5000" step="100" style="width: 80px; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px;">
          ms
        </label>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Hold Command for this long to activate, then press 1-9 to jump to a tab or &lt; / &gt; to cycle. Set to 0 for instant.
        </p>
      </div>
      <div class="settings-section">
        <h3>Enabled Agents</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Select which agents are available. If multiple are enabled, you can switch between them using the Engine dropdown.
        </p>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-claude" ${agents.find(a => a.id === 'claude')?.enabled !== false ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Claude Code
        </label>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-opencode" ${agents.find(a => a.id === 'opencode')?.enabled ? 'checked' : ''} ${agents.find(a => a.id === 'opencode')?.available ? '' : 'disabled'} style="accent-color: var(--ds-accent-green);">
          OpenCode (experimental)${agents.find(a => a.id === 'opencode')?.available ? '' : ' (not installed)'}
        </label>
        <div id="opencode-binary-row" style="display: ${agents.find(a => a.id === 'opencode')?.enabled ? 'block' : 'none'}; margin-top: 8px;">
          <label style="font-size: 12px; color: var(--ds-text-secondary);">Binary path</label>
          <input type="text" id="opencode-binary" value="${escapeHtml(currentOpencodeBinary)}" placeholder="opencode" style="width: 200px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
        </div>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <input type="checkbox" id="agent-gemini" ${agents.find(a => a.id === 'gemini')?.enabled ? 'checked' : ''} ${agents.find(a => a.id === 'gemini')?.available ? '' : 'disabled'} style="accent-color: var(--ds-accent-green);">
          Gemini (experimental)${agents.find(a => a.id === 'gemini')?.available ? '' : ' (not installed)'}
        </label>
        <div id="gemini-binary-row" style="display: ${agents.find(a => a.id === 'gemini')?.enabled ? 'block' : 'none'}; margin-top: 8px;">
          <label style="font-size: 12px; color: var(--ds-text-secondary);">Binary path</label>
          <input type="text" id="gemini-binary" value="${escapeHtml(currentGeminiBinary)}" placeholder="gemini" style="width: 200px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
        </div>
      </div>
      </div>
      <div class="settings-tab-content" data-tab="github">
      <div class="settings-section">
        <h3>Issue Title Length</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Max characters to display for GitHub issue titles in tabs.
        </p>
        <input type="number" id="max-issue-title-length" min="10" max="200" value="${currentMaxTitle}" style="width: 80px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--ds-border); background: var(--ds-bg-secondary); color: var(--ds-text-primary);">
      </div>
      <div class="settings-section">
        <h3>Magic Wand</h3>
        <label style="font-size: 13px; color: var(--ds-text-primary); cursor: pointer; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
          <input type="checkbox" id="wand-plan-mode" ${currentWandPlanMode ? 'checked' : ''} style="accent-color: var(--ds-accent-green);">
          Start issues in plan mode
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="font-size: 13px; color: var(--ds-text-primary);">Prompt template</span>
          <button class="btn-secondary" id="wand-template-reset" style="padding: 2px 8px; font-size: 11px;">Reset</button>
        </div>
        <textarea id="wand-prompt-template" rows="6" style="width: 100%; box-sizing: border-box; padding: 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px; font-family: monospace; resize: vertical;">${escapeHtml(currentWandTemplate)}</textarea>
        <p style="font-size: 11px; color: var(--ds-text-secondary); margin-top: 4px;">
          Variables: <code>{{number}}</code> <code>{{title}}</code> <code>{{labels}}</code> <code>{{url}}</code> <code>{{body}}</code>
        </p>
      </div>
      </div>
      <div class="settings-tab-content" data-tab="windows">
      <div class="settings-section">
        <h3>Window Configs</h3>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 8px;">
          Saved tab layouts. Click a config in the empty state to open all its tabs at once.
        </p>
        <div id="settings-window-configs"></div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="btn-secondary" id="settings-new-config" style="font-size: 12px; padding: 4px 12px;">+ New Config</button>
          <button class="btn-secondary" id="settings-save-current" style="font-size: 12px; padding: 4px 12px;">Save Current Tabs</button>
        </div>
      </div>
      </div>
      </div>
      <div class="modal-buttons">
        <button class="btn-secondary" id="settings-cancel">Cancel</button>
        <button class="btn-primary" id="settings-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Tab switching
  overlay.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      overlay.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      overlay.querySelector(`.settings-tab-content[data-tab="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  const customInput = overlay.querySelector('#custom-profile');
  overlay.querySelectorAll('input[name="profile"]').forEach(radio => {
    radio.addEventListener('change', () => {
      customInput.disabled = radio.value !== 'custom';
    });
  });
  customInput.disabled = overlay.querySelector('#profile-custom:checked') === null;

  // Live preview: apply theme immediately on select change
  const themeSelect = overlay.querySelector('#theme-select');
  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value || null;
    await fetch('/api/themes/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    // The server will broadcast the theme CSS via WebSocket — applyTheme runs from the WS handler
  });

  // Show/hide OpenCode binary path input based on checkbox
  const agentOpencodeCheckbox = overlay.querySelector('#agent-opencode');
  const opencodeBinaryRow = overlay.querySelector('#opencode-binary-row');
  agentOpencodeCheckbox?.addEventListener('change', () => {
    opencodeBinaryRow.style.display = agentOpencodeCheckbox.checked ? 'block' : 'none';
  });

  // Show/hide Gemini binary path input based on checkbox
  const agentGeminiCheckbox = overlay.querySelector('#agent-gemini');
  const geminiBinaryRow = overlay.querySelector('#gemini-binary-row');
  agentGeminiCheckbox?.addEventListener('change', () => {
    geminiBinaryRow.style.display = agentGeminiCheckbox.checked ? 'block' : 'none';
  });

  // Wand template reset button
  overlay.querySelector('#wand-template-reset').onclick = async () => {
    if (!confirm('Reset magic wand prompt template to default?')) return;
    const templateInput = overlay.querySelector('#wand-prompt-template');
    templateInput.value = defaultsData.wandPromptTemplate || '';
  };

  // Window Configs management
  let editingConfigs = JSON.parse(JSON.stringify(windowConfigs));
  const configsContainer = overlay.querySelector('#settings-window-configs');

  function renderConfigsList() {
    configsContainer.innerHTML = '';
    if (editingConfigs.length === 0) {
      configsContainer.innerHTML = '<p style="font-size: 12px; color: var(--ds-text-secondary); opacity: 0.6;">No configs saved yet.</p>';
      return;
    }
    for (let i = 0; i < editingConfigs.length; i++) {
      const config = editingConfigs[i];
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 6px; padding: 6px 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px;';
      row.innerHTML = `
        <span style="flex: 1; font-size: 13px; color: var(--ds-text-primary);">${escapeHtml(config.name)}</span>
        <span style="font-size: 11px; color: var(--ds-text-secondary);">${config.tabs.length} tab${config.tabs.length === 1 ? '' : 's'}</span>
        <button class="btn-secondary config-edit-btn" data-idx="${i}" style="padding: 2px 8px; font-size: 11px;">Edit</button>
        <button class="btn-secondary config-delete-btn" data-idx="${i}" style="padding: 2px 8px; font-size: 11px; color: var(--ds-accent-red, #f85149);">Delete</button>
      `;
      configsContainer.appendChild(row);
    }
    configsContainer.querySelectorAll('.config-delete-btn').forEach(btn => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.idx);
        editingConfigs.splice(idx, 1);
        renderConfigsList();
      };
    });
    configsContainer.querySelectorAll('.config-edit-btn').forEach(btn => {
      btn.onclick = () => showConfigEditor(Number(btn.dataset.idx));
    });
  }

  function showConfigEditor(idx) {
    const isNew = idx === -1;
    const config = isNew ? { id: '', name: '', tabs: [{ name: '', cwd: '', agentType: 'claude' }] } : JSON.parse(JSON.stringify(editingConfigs[idx]));
    const editorOverlay = document.createElement('div');
    editorOverlay.className = 'modal-overlay';
    editorOverlay.style.zIndex = '1001';

    function renderEditor() {
      const tabRows = config.tabs.map((t, ti) => {
        const tabType = t.type || 'terminal';
        let fields = '';
        if (tabType === 'display-tab') {
          fields = `<span style="flex: 1; font-size: 12px; color: var(--ds-text-secondary); padding: 4px 6px;">(Display Tab)</span>`;
        } else if (tabType === 'baby-browser') {
          fields = `<input type="text" class="config-tab-url" data-ti="${ti}" value="${escapeHtml(t.url || '')}" placeholder="https://example.com" style="flex: 1; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">`;
        } else {
          fields = `
          <input type="text" class="config-tab-cwd" data-ti="${ti}" value="${escapeHtml(t.cwd || '')}" placeholder="/path/to/project" style="flex: 1; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
          <select class="config-tab-agent" data-ti="${ti}" style="padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
            <option value="claude" ${t.agentType === 'claude' ? 'selected' : ''}>Claude</option>
            <option value="opencode" ${t.agentType === 'opencode' ? 'selected' : ''}>OpenCode</option>
            <option value="gemini" ${t.agentType === 'gemini' ? 'selected' : ''}>Gemini</option>
          </select>`;
        }
        return `
        <div style="display: flex; gap: 6px; margin-bottom: 4px; align-items: center;">
          <input type="text" class="config-tab-name" data-ti="${ti}" value="${escapeHtml(t.name)}" placeholder="Tab name" style="width: 120px; padding: 4px 6px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 12px;">
          ${fields}
          <button class="btn-secondary config-tab-remove" data-ti="${ti}" style="padding: 2px 6px; font-size: 11px;" ${config.tabs.length <= 1 ? 'disabled' : ''}>&times;</button>
        </div>
      `;
      }).join('');

      editorOverlay.innerHTML = `
        <div class="modal" style="max-width: 600px;">
          <h3 style="margin-bottom: 12px;">${isNew ? 'New' : 'Edit'} Window Config</h3>
          <div style="margin-bottom: 12px;">
            <label style="font-size: 12px; color: var(--ds-text-secondary);">Config Name</label>
            <input type="text" id="config-editor-name" value="${escapeHtml(config.name)}" placeholder="My Config" style="width: 100%; padding: 6px 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; margin-top: 4px;">
          </div>
          <div style="margin-bottom: 8px;">
            <label style="font-size: 12px; color: var(--ds-text-secondary);">Tabs</label>
          </div>
          <div id="config-editor-tabs">${tabRows}</div>
          <button class="btn-secondary" id="config-add-tab" style="font-size: 11px; padding: 3px 10px; margin-top: 4px;">+ Add Tab</button>
          <div class="modal-buttons" style="margin-top: 16px;">
            <button class="btn-secondary" id="config-editor-cancel">Cancel</button>
            <button class="btn-primary" id="config-editor-save">Save</button>
          </div>
        </div>
      `;

      editorOverlay.querySelector('#config-editor-cancel').onclick = () => editorOverlay.remove();
      editorOverlay.querySelector('#config-add-tab').onclick = () => {
        syncTabInputs();
        config.tabs.push({ name: '', cwd: '', agentType: 'claude' });
        renderEditor();
      };
      editorOverlay.querySelectorAll('.config-tab-remove').forEach(btn => {
        btn.onclick = () => {
          syncTabInputs();
          config.tabs.splice(Number(btn.dataset.ti), 1);
          renderEditor();
        };
      });
      editorOverlay.querySelector('#config-editor-save').onclick = () => {
        syncTabInputs();
        config.name = editorOverlay.querySelector('#config-editor-name').value.trim();
        if (!config.name) return alert('Config name is required');
        const validTabs = config.tabs.filter(t => {
          const type = t.type || 'terminal';
          if (type === 'display-tab') return !!t.html;
          if (type === 'baby-browser') return true;
          return t.cwd && t.cwd.trim();
        });
        if (validTabs.length === 0) return alert('At least one valid tab is required');
        config.tabs = validTabs;
        if (isNew) {
          editingConfigs.push(config);
        } else {
          editingConfigs[idx] = config;
        }
        editorOverlay.remove();
        renderConfigsList();
      };
      editorOverlay.onclick = (e) => { if (e.target === editorOverlay) editorOverlay.remove(); };
    }

    function syncTabInputs() {
      editorOverlay.querySelectorAll('.config-tab-name').forEach(input => {
        config.tabs[Number(input.dataset.ti)].name = input.value;
      });
      editorOverlay.querySelectorAll('.config-tab-cwd').forEach(input => {
        config.tabs[Number(input.dataset.ti)].cwd = input.value;
      });
      editorOverlay.querySelectorAll('.config-tab-agent').forEach(select => {
        config.tabs[Number(select.dataset.ti)].agentType = select.value;
      });
      editorOverlay.querySelectorAll('.config-tab-url').forEach(input => {
        config.tabs[Number(input.dataset.ti)].url = input.value;
      });
    }

    renderEditor();
    document.body.appendChild(editorOverlay);
  }

  renderConfigsList();

  overlay.querySelector('#settings-new-config').onclick = () => showConfigEditor(-1);
  overlay.querySelector('#settings-save-current').onclick = async () => {
    const currentTabs = [];
    const orderedIds = [...document.querySelectorAll('#tabs-list .tab')].map(t => t.id.replace('tab-', ''));
    for (const id of orderedIds) {
      const s = sessions.get(id);
      if (!s) continue;
      if (s.type === 'display-tab') {
        try {
          const resp = await fetch(`/api/display-tab/${id}`);
          if (resp.ok) {
            currentTabs.push({ type: 'display-tab', name: s.name || 'Display', html: await resp.text() });
          }
        } catch {}
      } else if (s.type === 'mod-tab' && s.modId === 'baby-browser') {
        let url = '';
        try {
          const iframe = s.container?.querySelector('iframe');
          if (iframe?.contentWindow) {
            const urlInput = iframe.contentDocument?.getElementById('url');
            if (urlInput) url = urlInput.value || '';
          }
        } catch {}
        currentTabs.push({ type: 'baby-browser', name: s.name || 'Baby Browser', url });
      } else if (s.cwd) {
        currentTabs.push({ type: 'terminal', name: s.name || '', cwd: s.cwd, agentType: s.agentType || 'claude' });
      }
    }
    if (currentTabs.length === 0) return alert('No tabs open to save');

    const pickerOverlay = document.createElement('div');
    pickerOverlay.className = 'modal-overlay';
    pickerOverlay.style.zIndex = '1001';

    const checked = currentTabs.map(() => true);

    function renderPicker() {
      const allChecked = checked.every(Boolean);
      const tabRows = currentTabs.map((t, i) => {
        let detail = '';
        if (t.type === 'display-tab') detail = '(Display Tab)';
        else if (t.type === 'baby-browser') detail = t.url || '(no url)';
        else detail = t.cwd;
        return `
        <div style="display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--ds-border);">
          <input type="checkbox" class="save-tab-check" data-i="${i}" ${checked[i] ? 'checked' : ''} style="margin: 0;">
          <span style="min-width: 100px; font-size: 12px; color: var(--ds-text-primary);">${escapeHtml(t.name || '(unnamed)')}</span>
          <span style="flex: 1; font-size: 11px; color: var(--ds-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(detail)}</span>
        </div>
      `;
      }).join('');

      pickerOverlay.innerHTML = `
        <div class="modal" style="max-width: 550px;">
          <h3 style="margin-bottom: 12px;">Save Current Tabs</h3>
          <div style="margin-bottom: 12px;">
            <label style="font-size: 12px; color: var(--ds-text-secondary);">Config Name</label>
            <input type="text" id="save-tabs-name" placeholder="My Config" style="width: 100%; padding: 6px 8px; background: var(--ds-bg-primary); border: 1px solid var(--ds-border); border-radius: 4px; color: var(--ds-text-primary); font-size: 13px; margin-top: 4px;">
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <label style="font-size: 12px; color: var(--ds-text-secondary);">Select Tabs</label>
            <button class="btn-secondary" id="save-tabs-toggle" style="font-size: 11px; padding: 2px 8px;">${allChecked ? 'Deselect All' : 'Select All'}</button>
          </div>
          <div style="max-height: 250px; overflow-y: auto;">${tabRows}</div>
          <div class="modal-buttons" style="margin-top: 16px;">
            <button class="btn-secondary" id="save-tabs-cancel">Cancel</button>
            <button class="btn-primary" id="save-tabs-save">Save</button>
          </div>
        </div>
      `;

      pickerOverlay.querySelectorAll('.save-tab-check').forEach(cb => {
        cb.onchange = () => {
          checked[Number(cb.dataset.i)] = cb.checked;
          renderPicker();
        };
      });
      pickerOverlay.querySelector('#save-tabs-toggle').onclick = () => {
        const newVal = !checked.every(Boolean);
        checked.fill(newVal);
        renderPicker();
      };
      pickerOverlay.querySelector('#save-tabs-cancel').onclick = () => pickerOverlay.remove();
      pickerOverlay.querySelector('#save-tabs-save').onclick = () => {
        const name = pickerOverlay.querySelector('#save-tabs-name').value.trim();
        if (!name) return alert('Please enter a config name');
        const selectedTabs = currentTabs.filter((_, i) => checked[i]);
        if (selectedTabs.length === 0) return alert('Please select at least one tab');
        const existingIdx = editingConfigs.findIndex(c => c.name.trim().toLowerCase() === name.toLowerCase());
        if (existingIdx !== -1) {
          if (!confirm(`A config named "${name}" already exists. Overwrite it?`)) return;
          editingConfigs[existingIdx] = { id: editingConfigs[existingIdx].id, name, tabs: selectedTabs };
        } else {
          editingConfigs.push({ id: '', name, tabs: selectedTabs });
        }
        pickerOverlay.remove();
        renderConfigsList();
      };
    }

    renderPicker();
    document.body.appendChild(pickerOverlay);
  };

  overlay.querySelector('#settings-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#settings-save').onclick = async () => {
    const selected = overlay.querySelector('input[name="profile"]:checked').value;
    const shellProfile = selected === 'custom' ? customInput.value : selected;
    const newMaxTitle = Number(overlay.querySelector('#max-issue-title-length').value) || 25;
    const wandPlanMode = overlay.querySelector('#wand-plan-mode').checked;
    const wandPromptTemplate = overlay.querySelector('#wand-prompt-template').value;
    const cmdTabSwitch = overlay.querySelector('#cmd-tab-switch').checked;
    const cmdTabSwitchHoldMs = Math.max(0, Number(overlay.querySelector('#cmd-tab-switch-hold-ms').value) || 0);
    const enabledAgents = [];
    if (overlay.querySelector('#agent-claude').checked) enabledAgents.push('claude');
    if (overlay.querySelector('#agent-opencode').checked) enabledAgents.push('opencode');
    if (overlay.querySelector('#agent-gemini').checked) enabledAgents.push('gemini');
    const opencodeBinary = overlay.querySelector('#opencode-binary').value || 'opencode';
    const geminiBinary = overlay.querySelector('#gemini-binary').value || 'gemini';
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shellProfile, maxIssueTitleLength: newMaxTitle, wandPlanMode, wandPromptTemplate, cmdTabSwitch, cmdTabSwitchHoldMs, enabledAgents, opencodeBinary, geminiBinary, windowConfigs: editingConfigs })
    });
    maxIssueTitleLength = Math.max(10, Math.min(200, newMaxTitle));
    setCmdHoldModeEnabled(cmdTabSwitch);
    setCmdHoldModeHoldMs(cmdTabSwitchHoldMs);
    // Refresh agents data if agent settings changed
    const prevEnabled = (window.__deepsteveAgents || []).filter(a => a.enabled).map(a => a.id).sort().join(',');
    const newEnabled = enabledAgents.sort().join(',');
    if (prevEnabled !== newEnabled) {
      try {
        const agentsResp = await fetch('/api/agents');
        const agentsData = await agentsResp.json();
        window.__deepsteveAgents = agentsData.agents || [];
        window.__deepsteveDefaultAgent = agentsData.defaultAgent || 'claude';
        refreshEnginesDropdown();
      } catch {}
    }
    overlay.remove();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});

function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const count = [...sessions.values()].filter(s => s.waitingForInput).length;
  if (count > 0) navigator.setAppBadge(count);
  else navigator.clearAppBadge();
}

/**
 * Get the current window ID
 */
function getWindowId() {
  return WindowManager.getWindowId();
}

/**
 * Create a new terminal session
 */
function createSession(cwd, existingId = null, isNew = false, opts = {}) {
  const { cols, rows } = measureTerminalSize();
  const ws = createWebSocket({ id: existingId, cwd, isNew, worktree: opts.worktree, name: opts.name, planMode: opts.planMode, agentType: opts.agentType, cols, rows, windowId: getWindowId() });

  // Promise that resolves when the session is fully initialized (terminal created)
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  // Buffer terminal data that arrives before the terminal is created
  let pendingData = [];
  let hasScrollback = false;
  let assignedId = null; // session ID assigned by server

  ws.onmessage = (e) => {
    // Try to parse as JSON control message
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      // Not JSON - pass to terminal (or buffer if not yet created)
      const session = [...sessions.values()].find(s => s.ws === ws);
      if (session) {
        session.term.write(e.data);
        // Forward to data listeners (e.g. VR mirror terminal)
        if (assignedId) {
          const listeners = window.__deepsteve._dataListeners?.get(assignedId);
          if (listeners) for (const cb of listeners) try { cb(e.data); } catch {}
        }
      } else {
        pendingData.push(e.data);
      }
      return;
    }

    // Valid JSON - handle control messages (never write to terminal)
    try {
      if (msg.type === 'session') {
        assignedId = msg.id;
        // Reject unexpected duplicates: another window already has this session
        if (msg.existingClients > 0 && !opts.allowDuplicate) {
          console.log(`[createSession] Rejecting duplicate session ${msg.id} (${msg.existingClients} existing client(s))`);
          ws.close();
          resolveReady(null);
          return;
        }
        // Update reconnect URL to use the assigned session ID
        ws.setSessionId(msg.id);
        hasScrollback = msg.scrollback || false;
        // If server assigned a different ID than requested, update TabSessions
        if (existingId && msg.id !== existingId) {
          TabSessions.updateId(existingId, msg.id);
        }
        // Check if this WebSocket already has a session (reconnect case)
        const existingSession = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (!existingSession) {
          // Use client-provided name, or fall back to server-persisted name
          const sessionName = opts.name || msg.name;
          initTerminal(msg.id, ws, cwd, sessionName, { hasScrollback, pendingData, restoreActive: opts.restoreActive || opts.background });
          resolveReady(msg.id);
          if (opts.initialPrompt) {
            ws.sendJSON({ type: 'initialPrompt', text: opts.initialPrompt });
          }
        }
      } else if (msg.type === 'close-tab') {
        if (assignedId) killSession(assignedId);
      } else if (msg.type === 'gone') {
        SessionStore.removeSession(getWindowId(), msg.id);
        TabSessions.remove(msg.id);
      } else if (msg.type === 'theme') {
        applyTheme(msg.css || '');
      } else if (msg.type === 'settings') {
        applySettings(msg);
      } else if (msg.type === 'skills-changed') {
        ModManager.handleSkillsChanged(msg.enabledSkills);
      } else if (msg.type === 'mod-changed') {
        ModManager.handleModChanged(msg.modId);
      } else if (msg.type === 'state') {
        const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
        if (entry) {
          const [sid, s] = entry;
          s.waitingForInput = msg.waiting;
          s.scrollControl.syncViewport();
          TabManager.updateBadge(sid, msg.waiting && activeId !== sid);
          updateTitle();
          updateAppBadge();
          if (msg.waiting) {
            showNotification(sid, s.name || getDefaultTabName(s.cwd));
          }
          ModManager.notifySessionsChanged(getSessionList());
        }
      } else if (msg.type === 'tasks') {
        ModManager.notifyTasksChanged(msg.tasks);
      } else if (msg.type === 'agent-chat') {
        ModManager.notifyAgentChatChanged(msg.channels);
      } else if (msg.type === 'browser-eval-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBrowserEvalRequest(msg);
        }
      } else if (msg.type === 'browser-console-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBrowserConsoleRequest(msg);
        }
      } else if (msg.type === 'screenshot-capture-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifyScreenshotCaptureRequest(msg);
        }
      } else if (msg.type === 'scene-update-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifySceneUpdateRequest(msg);
        }
      } else if (msg.type === 'scene-query-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifySceneQueryRequest(msg);
        }
      } else if (msg.type === 'scene-snapshot-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 60000);
          ModManager.notifySceneSnapshotRequest(msg);
        }
      } else if (msg.type === 'baby-browser-request') {
        if (msg.targetWindowId && msg.targetWindowId !== WindowManager.getWindowId()) return;
        if (!processedBrowserRequests.has(msg.requestId)) {
          processedBrowserRequests.add(msg.requestId);
          setTimeout(() => processedBrowserRequests.delete(msg.requestId), 15000);
          ModManager.notifyBabyBrowserRequest(msg);
        }
      }
    } catch (err) {
      console.error('Error handling control message:', err);
    }
  };

  ws.onerror = () => {
    // Don't wipe session storage on WS error — the server might just be restarting.
    // Sessions will be cleaned up if the server responds with 'gone' on reconnect.
    console.log('[ws] error for session', existingId, '— keeping in storage for reconnect');
  };

  ws.onreconnecting = () => {
    // Find session by websocket and add reconnecting state
    const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
    if (entry) {
      const [, session] = entry;
      session.container.classList.add('reconnecting');
    }
  };

  ws.onreconnected = () => {
    // Remove reconnecting state and refresh terminal
    const entry = [...sessions.entries()].find(([, s]) => s.ws === ws);
    if (entry) {
      const [, session] = entry;
      session.container.classList.remove('reconnecting');
      session.scrollControl.suppressScroll();
      // ResizeObserver handles fit; just request redraw from server
      ws.send(JSON.stringify({ type: 'redraw' }));
      session.scrollControl.scrollToBottom();
    }
  };

  return ready;
}

/**
 * Initialize a terminal after WebSocket connection is established
 */
function initTerminal(id, ws, cwd, initialName, { hasScrollback = false, pendingData = [], restoreActive = false } = {}) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const { term, fit } = createTerminal(container);
  const scrollControl = setupTerminalIO(term, ws, {
    onUserInput: () => clearNotification(id),
    container
  });

  // Get saved name or generate default
  const windowId = getWindowId();
  const savedSessions = SessionStore.getWindowSessions(windowId);
  const savedSession = savedSessions.find(s => s.id === id);
  const name = initialName || savedSession?.name || getDefaultTabName(cwd);

  // Store session in memory
  sessions.set(id, { term, fit, ws, container, cwd, name, waitingForInput: false, scrollControl });

  // Suppress scroll during init to prevent onWriteParsed races with
  // buffered data flush and scrollback replay
  scrollControl.suppressScroll();

  // Flush any buffered data that arrived before the terminal was created
  for (const data of pendingData) {
    term.write(data);
    // Also notify data listeners (e.g. VR mirror terminal)
    const listeners = window.__deepsteve._dataListeners?.get(id);
    if (listeners) for (const cb of listeners) try { cb(data); } catch {}
  }
  pendingData.length = 0;

  // Add tab UI with callbacks
  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      const tabList = TabSessions.get();
      const reordered = orderedIds.map(id => tabList.find(s => s.id === id)).filter(Boolean);
      TabSessions.save(reordered);
      SessionStore.reorderSessions(getWindowId(), orderedIds);
      ModManager.notifySessionsChanged(getSessionList());
    },
    getLiveWindows: () => WindowManager.getLiveWindows(),
    onSendToWindow: (sessionId, targetWindowId) => sendToWindow(sessionId, targetWindowId),
    getModMenuItems: () => {
      return ModManager.getContextMenuItems().map(item => ({
        label: item.label,
        onClick: () => {
          if (item.action === 'focus-panel') ModManager.focusPanel(item.modId);
        },
      }));
    },
  };

  TabManager.addTab(id, name, tabCallbacks);
  updateEmptyState();

  // During restore, skip switchTo() — restoreSessions() will select the
  // correct tab after all sessions are initialized. For new sessions,
  // always switch to the new tab immediately.
  if (!restoreActive) {
    switchTo(id);
  }

  // Save to both storages — TabSessions is per-tab truth, SessionStore is for cross-tab
  TabSessions.add({ id, cwd, name });
  SessionStore.addSession(windowId, { id, cwd, name });
  SessionStore.addRecentDir(cwd);

  // ResizeObserver handles window resize, layout toggle, mod panel.
  // Tab switching is handled by switchTo() calling fitTerminal() directly.
  sessions.get(id).resizeObserver = observeTerminalResize(container, term, fit, ws);

  // One-time init after first fit (which happens in switchTo's rAF above)
  requestAnimationFrame(() => {
    if (hasScrollback) {
      scrollControl.scrollToBottom();
      // Hide the host terminal cursor — Claude Code renders its own cursor
      // via Ink. The original DECTCEM hide sequence from session start may
      // have been trimmed from the scrollback circular buffer.
      term.write('\x1b[?25l');
    } else {
      scrollControl.scrollToBottom();
      ws.send(JSON.stringify({ type: 'redraw' }));
    }
  });

  updateEmptyState();

  // Notify mods of session list change
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Create a mod tab (client-only, no PTY or WebSocket).
 */
function createModTab(modId, opts = {}) {
  const mod = ModManager.getNewTabItems().find(m => m.modId === modId);
  if (!mod) {
    // Mod disabled or removed — clean up stale storage if restoring
    if (opts.id) {
      SessionStore.removeSession(getWindowId(), opts.id);
      TabSessions.remove(opts.id);
    }
    return;
  }

  const id = opts.id || crypto.randomUUID().slice(0, 8);
  const name = opts.name || mod.label;

  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const iframe = document.createElement('iframe');
  let iframeSrc = `/mods/${modId}/${mod.entry}`;
  if (opts.url) iframeSrc += `?url=${encodeURIComponent(opts.url)}`;
  iframe.src = iframeSrc;
  iframe.style.cssText = 'width:100%;height:100%;border:none;';
  iframe.sandbox = 'allow-same-origin allow-scripts allow-forms allow-popups';
  container.appendChild(iframe);

  // Inject bridge API so tab mods can register MCP callbacks (e.g. Baby Browser tools)
  iframe.addEventListener('load', () => {
    ModManager.injectBridgeAPI(iframe, modId);
  });

  sessions.set(id, {
    term: null, fit: null, ws: null, container, cwd: null,
    name, waitingForInput: false, scrollControl: null,
    type: 'mod-tab', modId,
  });

  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      const tabList = TabSessions.get();
      const reordered = orderedIds.map(id => tabList.find(s => s.id === id)).filter(Boolean);
      TabSessions.save(reordered);
      SessionStore.reorderSessions(getWindowId(), orderedIds);
      ModManager.notifySessionsChanged(getSessionList());
    },
    getLiveWindows: () => [],
    onSendToWindow: () => {},
    getModMenuItems: () => [],
  };

  TabManager.addTab(id, name, tabCallbacks);
  updateEmptyState();

  if (!opts.restoreActive) {
    switchTo(id);
  }

  // Persist
  const windowId = getWindowId();
  TabSessions.add({ id, name, type: 'mod-tab', modId });
  SessionStore.addSession(windowId, { id, name, type: 'mod-tab', modId });

  // Forward resize events to iframe
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    iframe.contentWindow?.postMessage({ type: 'resize', width, height }, '*');
  });
  ro.observe(container);
  sessions.get(id).resizeObserver = ro;

  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Create a display tab (agent-generated HTML in a sandboxed iframe, no PTY).
 */
function createDisplayTab(id, name) {
  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'term-' + id;
  document.getElementById('terminals').appendChild(container);

  const iframe = document.createElement('iframe');
  iframe.src = `/api/display-tab/${id}`;
  iframe.style.cssText = 'width:100%;height:100%;border:none;';
  iframe.sandbox = 'allow-scripts allow-forms';
  container.appendChild(iframe);

  sessions.set(id, {
    term: null, fit: null, ws: null, container, cwd: null,
    name: name || 'Display', waitingForInput: false, scrollControl: null,
    type: 'display-tab',
  });

  const tabCallbacks = {
    onSwitch: (sessionId) => switchTo(sessionId),
    onClose: async (sessionId) => {
      if (await confirmCloseSession(sessionId)) killSession(sessionId);
    },
    onRename: (sessionId) => renameSession(sessionId),
    onReorder: (orderedIds) => {
      const tabList = TabSessions.get();
      const reordered = orderedIds.map(id => tabList.find(s => s.id === id)).filter(Boolean);
      TabSessions.save(reordered);
      SessionStore.reorderSessions(getWindowId(), orderedIds);
      ModManager.notifySessionsChanged(getSessionList());
    },
    getLiveWindows: () => [],
    onSendToWindow: () => {},
    getModMenuItems: () => [],
  };

  TabManager.addTab(id, name || 'Display', tabCallbacks);
  updateEmptyState();
  switchTo(id);

  // Forward resize events to iframe
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    iframe.contentWindow?.postMessage({ type: 'resize', width, height }, '*');
  });
  ro.observe(container);
  sessions.get(id).resizeObserver = ro;

  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Switch to a specific session tab
 */
function switchTo(id) {
  // If mod view is active, delegate to ModManager to show terminal with back button
  if (ModManager.isModViewVisible()) {
    ModManager.showTerminalForSession(id);
    return;
  }

  // Deactivate current
  if (activeId) {
    const current = sessions.get(activeId);
    if (current) {
      current.container.classList.remove('active');
    }
    TabManager.setActive(null);
  }

  // Activate new
  activeId = id;
  ActiveTab.set(id);
  ModManager.notifyActiveSessionChanged(id);
  const session = sessions.get(id);
  if (session) {
    session.container.classList.add('active');
    TabManager.setActive(id);
    // Clear badge and notification when switching to this tab
    TabManager.updateBadge(id, false);
    clearNotification(id);

    if (session.type === 'mod-tab' || session.type === 'display-tab') return;

    session.scrollControl.suppressScroll();
    requestAnimationFrame(() => {
      try {
        fitTerminal(session.term, session.fit, session.ws);
      } finally {
        session.term.focus();
        requestAnimationFrame(() => {
          session.scrollControl.scrollToBottom();
        });
      }
    });
  }
}

/**
 * Restore multiple sessions and select the previously active tab.
 * Reads ActiveTab before any sessions initialize, waits for all to finish,
 * then selects the right tab once — avoiding the race where the last session
 * to connect wins.
 */
async function restoreSessions(sessionList, opts = {}) {
  const savedActiveId = ActiveTab.get();
  const allowDuplicate = opts.allowDuplicate !== undefined ? opts.allowDuplicate : true;

  // Pre-create placeholder tab stubs in correct order for instant visual feedback
  for (const entry of sessionList) {
    if (!(entry.type === 'mod-tab' && entry.modId)) {
      const name = entry.name || getDefaultTabName(entry.cwd);
      TabManager.addPlaceholderTab(entry.id, name);
    }
  }
  updateEmptyState();

  // Connect all sessions in parallel — placeholders are upgraded by initTerminal's addTab()
  const promises = sessionList.map(entry => {
    if (entry.type === 'mod-tab' && entry.modId) {
      createModTab(entry.modId, { id: entry.id, name: entry.name, restoreActive: true });
      return Promise.resolve(entry.id);
    } else {
      return createSession(entry.cwd, entry.id, false, { name: entry.name, restoreActive: true, allowDuplicate });
    }
  });

  const results = await Promise.all(promises);

  // Clean up rejected sessions
  results.forEach((resolvedId, i) => {
    if (resolvedId === null) {
      const entry = sessionList[i];
      console.log('[restore] Session', entry.id, 'rejected (duplicate), cleaning up storage');
      SessionStore.removeSession(getWindowId(), entry.id);
      TabSessions.remove(entry.id);
      TabManager.removeTab(entry.id);
    }
  });

  const target = savedActiveId && sessions.has(savedActiveId)
    ? savedActiveId
    : sessions.keys().next().value;
  if (target) {
    if (target === savedActiveId) {
      console.log('[restore] Selecting saved active tab', target);
    } else {
      console.log('[restore] Saved active tab', savedActiveId, 'not found, falling back to', target);
    }
    switchTo(target);
  }
}

/**
 * Show confirmation dialog if agent is busy. Returns true if close should proceed.
 * For locally-connected sessions, checks in-memory state. For server-only sessions
 * (dropdown), fetches state from the server.
 */
function confirmCloseSession(id) {
  // Mod/display tabs have no PTY — always allow close
  const session = sessions.get(id);
  if (session?.type === 'mod-tab' || session?.type === 'display-tab') return Promise.resolve(true);

  // Check local session first (tab is connected in this window)
  const isIdle = session ? session.waitingForInput : null;

  if (isIdle === null) {
    // No local session — fetch from server
    return fetch(`/api/shells/${id}/state`)
      .then(r => r.ok ? r.json() : { waitingForInput: true })
      .then(data => data.waitingForInput ? true : showCloseConfirmDialog())
      .catch(() => true); // on error, allow close
  }

  if (isIdle) return Promise.resolve(true);
  return showCloseConfirmDialog();
}

function showCloseConfirmDialog() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>Close running session?</h2>
        <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:16px;">This agent is still running. Closing will terminate it immediately.</p>
        <div class="modal-buttons">
          <button class="btn-secondary" id="close-confirm-cancel">Cancel</button>
          <button class="btn-danger" id="close-confirm-ok">Close anyway</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('#close-confirm-cancel').onclick = () => cleanup(false);
    overlay.querySelector('#close-confirm-ok').onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  });
}

function showRestartConfirmDialog() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Restart DeepSteve?</h2>
      <p style="font-size:13px;color:var(--ds-text-secondary);margin-bottom:16px;">This will restart the server and reload the page. Running agents will be interrupted but sessions will be restored.</p>
      <div class="modal-buttons">
        <button class="btn-secondary" id="restart-confirm-cancel">Cancel</button>
        <button class="btn-primary" id="restart-confirm-ok">Restart</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let cleaned = false;
  const cleanup = (result) => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    resolve(result);
  };
  overlay.querySelector('#restart-confirm-cancel').onclick = () => cleanup(false);
  overlay.querySelector('#restart-confirm-ok').onclick = () => cleanup(true);
  overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
  };
  document.addEventListener('keydown', onKey);

  return { promise, dismiss: cleanup };
}

function showReloadOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cursor = 'default';
  overlay.innerHTML = `
    <div style="text-align:center;">
      <div class="reload-spinner"></div>
      <div style="color:var(--ds-text-bright);font-size:16px;font-weight:600;margin-top:16px;">Restarting...</div>
    </div>`;
  document.body.appendChild(overlay);
}

function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.type === 'mod-tab' || session.type === 'display-tab') {
    // Mod/display tabs: no PTY/WS to clean up
    if (session.resizeObserver) session.resizeObserver.disconnect();
    session.container.remove();
  } else {
    // Tell server to close this client's connection to the shell.
    // If no other clients are connected, the server kills the shell immediately.
    // If other clients remain, the shell stays alive for them.
    try { session.ws.sendJSON({ type: 'close-session' }); } catch {}

    if (session.resizeObserver) session.resizeObserver.disconnect();
    session.ws.close();
    session.term.dispose();
    session.container.remove();
  }

  TabManager.removeTab(id);
  sessions.delete(id);

  SessionStore.removeSession(getWindowId(), id);
  TabSessions.remove(id);

  // Switch to next available session
  if (activeId === id) {
    const next = sessions.keys().next().value;
    if (next) {
      switchTo(next);
    } else {
      activeId = null;
      ActiveTab.clear();
      ModManager.notifyActiveSessionChanged(null);
    }
  }

  updateEmptyState();

  // Notify mods of session list change
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Send a session to another browser window.
 * Like killSession() but does NOT send DELETE to server — the shell stays alive
 * and the target window adopts it via createSession().
 */
async function sendToWindow(id, targetWindowId) {
  const session = sessions.get(id);
  if (!session) return;

  // Send session data and wait for ack from target window
  try {
    await WindowManager.sendSessionToWindow(targetWindowId, {
      id,
      cwd: session.cwd,
      name: session.name
    });
  } catch (err) {
    // Target window didn't ack — keep the session
    console.warn(`Send to window failed: ${err.message}. Keeping session.`);
    return;
  }

  // Ack received — clean up locally (no server DELETE — shell stays alive for 30s grace period)
  if (session.resizeObserver) session.resizeObserver.disconnect();
  session.ws.close();
  session.term.dispose();
  session.container.remove();

  TabManager.removeTab(id);
  sessions.delete(id);

  SessionStore.removeSession(getWindowId(), id);
  TabSessions.remove(id);

  // Switch to next available session
  if (activeId === id) {
    const next = sessions.keys().next().value;
    if (next) {
      switchTo(next);
    } else {
      activeId = null;
      ActiveTab.clear();
      ModManager.notifyActiveSessionChanged(null);
    }
  }

  updateEmptyState();
  ModManager.notifySessionsChanged(getSessionList());
}

/**
 * Rename a session
 */
function renameSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  TabManager.promptRename(id, session.name, (newName) => {
    const name = newName || getDefaultTabName(session.cwd);
    session.name = name;
    TabManager.updateLabel(id, name);
    SessionStore.updateSession(getWindowId(), id, { name });
    // Update per-tab storage
    const tabList = TabSessions.get();
    const tabEntry = tabList.find(s => s.id === id);
    if (tabEntry) { tabEntry.name = name; TabSessions.save(tabList); }
    // Tell server so it persists across tab close/restore (skip for mod tabs — no WS)
    if (session.ws) session.ws.sendJSON({ type: 'rename', name });
    ModManager.notifySessionsChanged(getSessionList());
  });
}

/**
 * Quick new session in same repo as active session
 */
function quickNewSession() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd() || '~';
  createSession(cwd, null, true, { agentType: getDefaultAgentType() });
}

/** Get the default agent type from cached settings */
function getDefaultAgentType() {
  // Cached from /api/agents fetch at init
  return window.__deepsteveDefaultAgent || 'claude';
}

/**
 * Initialize the engines dropdown (shown when multiple agents are enabled).
 * Sets up the document-level click-to-close listener once, then builds the UI.
 */
function initEnginesDropdown() {
  document.addEventListener('click', () => {
    document.getElementById('engines-menu')?.classList.remove('open');
  });
  refreshEnginesDropdown();
}

/**
 * Rebuild the engines dropdown UI. Safe to call multiple times —
 * clone-replaces the button to clear stale event listeners.
 */
function refreshEnginesDropdown() {
  const agents = window.__deepsteveAgents || [];
  const enabledAgents = agents.filter(a => a.enabled);

  const dropdown = document.getElementById('engines-dropdown');
  const oldBtn = document.getElementById('engines-btn');
  const menu = document.getElementById('engines-menu');

  if (enabledAgents.length <= 1) {
    dropdown.style.display = 'none';
    return;
  }

  dropdown.style.display = 'flex';

  // Clone-replace button to clear old event listeners
  const btn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(btn);

  // Build menu items
  menu.innerHTML = enabledAgents.map(a => {
    const isDefault = a.id === window.__deepsteveDefaultAgent;
    return `<div class="dropdown-item ${isDefault ? 'active' : 'clickable'}" data-agent="${a.id}">${a.name}${isDefault ? ' ✓' : ''}</div>`;
  }).join('');

  // Update button text (short name by default, full name on hover)
  const currentAgent = agents.find(a => a.id === window.__deepsteveDefaultAgent);
  btn.textContent = currentAgent?.shortName || currentAgent?.name || 'Engine';
  btn.title = currentAgent?.name || 'Engine';

  btn.addEventListener('mouseenter', () => {
    const a = agents.find(a => a.id === window.__deepsteveDefaultAgent);
    btn.textContent = a?.name || 'Engine';
  });
  btn.addEventListener('mouseleave', () => {
    const a = agents.find(a => a.id === window.__deepsteveDefaultAgent);
    btn.textContent = a?.shortName || a?.name || 'Engine';
  });

  // Handle clicks on menu items
  menu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const agentId = item.dataset.agent;
      window.__deepsteveDefaultAgent = agentId;
      menu.querySelectorAll('.dropdown-item').forEach(i => {
        const a = agents.find(ag => ag.id === i.dataset.agent);
        const isSelected = i.dataset.agent === agentId;
        i.textContent = (a?.name || '') + (isSelected ? ' ✓' : '');
      });
      const newDefault = agents.find(a => a.id === agentId);
      btn.textContent = newDefault?.name || 'Engine';
      btn.title = newDefault?.name || 'Engine';
      menu.classList.remove('open');
    });
  });

  // Toggle dropdown
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
}

/**
 * Show dropdown menu for new tab options (recent repos + actions)
 */
function showNewTabMenu(e) {
  // Remove any existing menu
  document.querySelector('.new-tab-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'new-tab-menu context-menu';

  const agents = window.__deepsteveAgents || [];
  const enabledAgents = agents.filter(a => a.enabled);
  const currentAgent = getDefaultAgentType();

  // Build agent submenu item (only if multiple enabled)
  let html = '';
  if (enabledAgents.length > 1) {
    const currentAgentName = agents.find(a => a.id === currentAgent)?.name || 'Claude Code';
    html += `<div class="context-menu-item context-menu-has-submenu" id="agent-submenu-trigger">Agent: ${currentAgentName} <span class="context-menu-arrow"></span></div>`;
  }

  // Build recent dirs section
  const recentDirs = SessionStore.getRecentDirs();
  const INITIAL_SHOW = 10;
  const MORE_INCREMENT = 20;
  let recentShown = 0;
  // Disambiguate duplicate leaf names by appending parent dir
  const leafCounts = {};
  for (const d of recentDirs) {
    const leaf = d.path.split('/').pop();
    leafCounts[leaf] = (leafCounts[leaf] || 0) + 1;
  }
  if (recentDirs.length > 0) {
    html += '<div class="context-menu-header">Recent</div>';
    const initialSlice = recentDirs.slice(0, INITIAL_SHOW);
    recentShown = initialSlice.length;
    for (const d of initialSlice) {
      const parts = d.path.split('/');
      const leaf = parts.pop();
      const label = leafCounts[leaf] > 1 && parts.length > 0
        ? `${leaf} (${parts.pop()})`
        : leaf;
      html += `<div class="context-menu-item" data-action="recent" data-path="${d.path.replace(/"/g, '&quot;')}" title="${d.path.replace(/"/g, '&quot;')}">${label}</div>`;
    }
    if (recentDirs.length > INITIAL_SHOW) {
      html += `<div class="context-menu-item context-menu-more" data-action="more">More...</div>`;
    }
    html += '<div class="context-menu-separator" id="recent-dirs-separator"></div>';
  }
  html += `
    <div class="context-menu-item" data-action="worktree">New worktree...</div>
    <div class="context-menu-item" data-action="repo">New tab in repo...</div>
  `;

  // Add mod tab items
  const modTabItems = ModManager.getNewTabItems();
  if (modTabItems.length > 0) {
    html += '<div class="context-menu-separator"></div>';
    for (const item of modTabItems) {
      html += `<div class="context-menu-item" data-action="mod-tab" data-mod-id="${item.modId}">${item.label}</div>`;
    }
  }

  menu.innerHTML = html;

  // Set up agent submenu
  const agentTrigger = menu.querySelector('#agent-submenu-trigger');
  let submenu = null;
  if (agentTrigger) {
    const showSubmenu = () => {
      if (submenu) return;
      submenu = document.createElement('div');
      submenu.className = 'context-menu context-submenu';
      submenu.innerHTML = enabledAgents.map(a => {
        const isSelected = a.id === getDefaultAgentType();
        return `<div class="context-menu-item" data-agent="${a.id}">${isSelected ? '&#10003; ' : '&nbsp;&nbsp; '}${a.name}</div>`;
      }).join('');
      // Append to body (not agentTrigger) to avoid overflow clipping from .new-tab-menu
      document.body.appendChild(submenu);

      // Position next to trigger
      const triggerRect = agentTrigger.getBoundingClientRect();
      submenu.style.left = (triggerRect.right + 2) + 'px';
      submenu.style.top = triggerRect.top + 'px';
      const subRect = submenu.getBoundingClientRect();
      if (subRect.right > window.innerWidth) {
        submenu.style.left = (triggerRect.left - subRect.width - 2) + 'px';
      }
      if (subRect.bottom > window.innerHeight) {
        submenu.style.top = (window.innerHeight - subRect.height - 8) + 'px';
      }

      submenu.addEventListener('mouseleave', delayedHideSubmenu);
      submenu.addEventListener('click', (ev) => {
        const item = ev.target.closest('.context-menu-item');
        if (!item) return;
        ev.stopPropagation();
        const agentId = item.dataset.agent;
        window.__deepsteveDefaultAgent = agentId;
        const newName = agents.find(a => a.id === agentId)?.name || 'Claude Code';
        agentTrigger.innerHTML = `Agent: ${newName} <span class="context-menu-arrow"></span>`;
        initEnginesDropdown();
        hideSubmenu();
      });
    };
    const hideSubmenu = () => {
      if (submenu) { submenu.remove(); submenu = null; }
    };
    const delayedHideSubmenu = () => {
      setTimeout(() => {
        if (submenu && !submenu.matches(':hover') && !agentTrigger.matches(':hover')) {
          hideSubmenu();
        }
      }, 100);
    };
    agentTrigger.addEventListener('mouseenter', showSubmenu);
    agentTrigger.addEventListener('mouseleave', delayedHideSubmenu);
    agentTrigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      submenu ? hideSubmenu() : showSubmenu();
    });
  }

  // Position below the dropdown arrow button
  const btn = e.target.closest('#new-btn-dropdown') || e.target.closest('#new-btn-group');
  const rect = btn.getBoundingClientRect();
  const isVertical = document.getElementById('app-container').classList.contains('vertical-layout');

  if (isVertical) {
    menu.style.left = (rect.right + 4) + 'px';
    menu.style.top = rect.top + 'px';
  } else {
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
  }

  document.body.appendChild(menu);

  // Adjust if off-screen
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - menuRect.width - 8) + 'px';
  }
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - menuRect.height - 8) + 'px';
  }

  // Handle selection
  const selectItem = async (ev) => {
    const item = ev.target.closest('.context-menu-item');
    if (!item) return;
    const action = item.dataset.action;
    if (!action) return; // ignore clicks on items without actions (e.g. agent submenu trigger)
    // "More" button: append next batch of recent dirs without closing menu
    if (action === 'more') {
      ev.stopPropagation();
      const moreBtn = item;
      const nextSlice = recentDirs.slice(recentShown, recentShown + MORE_INCREMENT);
      recentShown += nextSlice.length;
      const separator = menu.querySelector('#recent-dirs-separator');
      for (const d of nextSlice) {
        const parts = d.path.split('/');
        const leaf = parts.pop();
        const label = leafCounts[leaf] > 1 && parts.length > 0
          ? `${leaf} (${parts.pop()})`
          : leaf;
        const el = document.createElement('div');
        el.className = 'context-menu-item';
        el.dataset.action = 'recent';
        el.dataset.path = d.path;
        el.title = d.path;
        el.textContent = label;
        menu.insertBefore(el, moreBtn);
      }
      if (recentShown >= recentDirs.length) {
        moreBtn.remove();
      }
      // Re-check if menu extends off-screen after adding items
      const updatedRect = menu.getBoundingClientRect();
      if (updatedRect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - updatedRect.height - 8) + 'px';
      }
      return;
    }
    menu.remove();
    if (submenu) submenu.remove();
    cleanup();
    if (action === 'recent') {
      createSession(item.dataset.path, null, true, { agentType: getDefaultAgentType() });
    } else if (action === 'worktree') {
      await promptWorktreeSession();
    } else if (action === 'repo') {
      await promptRepoSession();
    } else if (action === 'mod-tab') {
      createModTab(item.dataset.modId);
    } else if (action === 'opencode') {
      const active = activeId && sessions.get(activeId);
      const cwdPath = active?.cwd || SessionStore.getLastCwd() || '~';
      createSession(cwdPath, null, true, { agentType: 'opencode' });
    }
  };

  menu.addEventListener('click', selectItem);

  // Close on click outside
  const cleanup = () => {
    document.removeEventListener('mousedown', closeHandler);
  };
  const closeHandler = (ev) => {
    if (!menu.contains(ev.target) && !(submenu && submenu.contains(ev.target)) && ev.target !== btn) {
      menu.remove();
      if (submenu) submenu.remove();
      cleanup();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
}

/**
 * Prompt for worktree name and create session
 */
async function promptWorktreeSession() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd();
  if (!cwd) return promptRepoSession();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>New worktree</h2>
      <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 12px;">
        Creates a git worktree and opens Claude in it.
      </p>
      <input type="text" id="worktree-name" placeholder="e.g. feature-auth, bugfix-123" style="width: 100%; box-sizing: border-box;">
      <div class="modal-buttons" style="margin-top: 16px;">
        <button class="btn-secondary" id="wt-cancel">Cancel</button>
        <button class="btn-primary" id="wt-create">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#worktree-name');
  input.focus();

  return new Promise((resolve) => {
    const submit = () => {
      const name = input.value.trim();
      overlay.remove();
      if (name) {
        createSession(cwd, null, true, { worktree: name, agentType: getDefaultAgentType() });
      }
      resolve();
    };

    overlay.querySelector('#wt-cancel').onclick = () => { overlay.remove(); resolve(); };
    overlay.querySelector('#wt-create').onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
  });
}

/**
 * Prompt for directory and create session
 */
async function promptRepoSession() {
  const result = await showDirectoryPicker({ configs: windowConfigs });
  if (result === null) return;
  if (result && typeof result === 'object' && result.type === 'config') {
    try {
      await fetch(`/api/window-configs/${result.configId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: getWindowId() })
      });
    } catch (e) {
      console.error('Failed to apply window config:', e);
    }
    return;
  }
  createSession(result, null, true, { agentType: getDefaultAgentType() });
}

/**
 * Escape HTML special characters for safe rendering
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Show GitHub issue picker and create worktree session
 */
async function showIssuePicker() {
  const active = activeId && sessions.get(activeId);
  const cwd = active?.cwd || SessionStore.getLastCwd();
  if (!cwd) return promptRepoSession();

  // Check git root
  let gitRoot;
  try {
    const res = await fetch('/api/git-root?cwd=' + encodeURIComponent(cwd));
    if (!res.ok) throw new Error('Not a git repository');
    gitRoot = (await res.json()).root;
  } catch {
    alert('Current directory is not a git repository.');
    return;
  }

  // Collect candidate paths for repo selector
  const sessionCwds = [...sessions.values()].map(s => s.cwd).filter(Boolean);
  const recentCwds = SessionStore.getRecentDirs().map(d => d.path);
  const allCwds = [...new Set([cwd, ...sessionCwds, ...recentCwds])];

  // Show modal immediately with loading state
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width: 520px;">
      <h2>Pick a GitHub Issue</h2>
      <div class="issue-repo-selector" style="display:none;">
        <select class="issue-repo-select" id="issue-repo-select">
          <option value="${escapeHtml(gitRoot)}">${escapeHtml(gitRoot.split('/').pop())}</option>
        </select>
      </div>
      <div class="issue-list">
        <div class="issue-loading">
          <span class="issue-loading-text">Loading issues…</span>
        </div>
      </div>
      <div class="modal-buttons">
        <button class="btn-secondary" id="issue-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const closeIssuePicker = () => overlay.remove();
  overlay.querySelector('#issue-cancel').onclick = closeIssuePicker;
  overlay.onclick = (e) => { if (e.target === overlay) closeIssuePicker(); };
  const onEscIssuePicker = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeIssuePicker(); } };
  document.addEventListener('keydown', onEscIssuePicker);
  new MutationObserver((_, obs) => { if (!overlay.parentNode) { document.removeEventListener('keydown', onEscIssuePicker); obs.disconnect(); } }).observe(document.body, { childList: true });

  let issues, wandPlanMode, wandPromptTemplate, hasMore;
  let selectedIssue = null;
  let currentPage = 1;
  let loadingMore = false;

  function bindIssueItem(item) {
    item.addEventListener('click', () => {
      overlay.querySelectorAll('.issue-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedIssue = issues.find(i => i.number === parseInt(item.dataset.number));
      const startBtn = overlay.querySelector('#issue-start');
      if (startBtn) startBtn.disabled = false;
    });
    item.addEventListener('dblclick', () => {
      selectedIssue = issues.find(i => i.number === parseInt(item.dataset.number));
      startIssue();
    });
    const link = item.querySelector('.issue-link');
    if (link) link.addEventListener('click', e => e.stopPropagation());
  }

  function renderIssues(issuesToRender) {
    const list = overlay.querySelector('.issue-list');
    if (!list) return;
    for (const issue of issuesToRender) {
      const el = document.createElement('div');
      el.className = 'issue-item';
      el.dataset.number = issue.number;
      el.innerHTML = `
        <span class="issue-number">#${issue.number}</span>
        <div class="issue-info">
          <div class="issue-title">${escapeHtml(issue.title)}</div>
          ${issue.labels && issue.labels.length > 0 ? `
            <div class="issue-labels">${issue.labels.map(l => `<span class="issue-label">${escapeHtml(l.name)}</span>`).join('')}</div>
          ` : ''}
        </div>
        <a class="issue-link" href="${escapeHtml(issue.url)}" target="_blank" title="Open on GitHub">&#8599;</a>
      `;
      list.appendChild(el);
      bindIssueItem(el);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    currentPage++;
    try {
      const res = await fetch(`/api/issues?cwd=${encodeURIComponent(gitRoot)}&page=${currentPage}`);
      if (!res.ok) return;
      const data = await res.json();
      issues = issues.concat(data.issues);
      hasMore = data.hasMore;
      renderIssues(data.issues);
    } finally {
      loadingMore = false;
    }
  }

  function startIssue() {
    if (!selectedIssue) return;
    overlay.remove();

    const body = selectedIssue.body ? selectedIssue.body.slice(0, 2000) : '(no description)';
    const labels = selectedIssue.labels?.map(l => l.name).join(', ') || 'none';
    const vars = {
      number: selectedIssue.number,
      title: selectedIssue.title,
      labels,
      url: selectedIssue.url,
      body,
    };
    const prompt = wandPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');

    createSession(gitRoot, null, true, {
      worktree: 'github-issue-' + selectedIssue.number,
      initialPrompt: prompt,
      planMode: wandPlanMode,
      name: truncateTitle(`#${selectedIssue.number} ${selectedIssue.title}`),
      agentType: getDefaultAgentType()
    });
  }

  // Fetch issues and settings in background, update modal when done
  async function fetchAndRender() {
    try {
      const [issuesRes, settingsData] = await Promise.all([
        fetch('/api/issues?cwd=' + encodeURIComponent(gitRoot)),
        fetch('/api/settings').then(r => r.json())
      ]);
      if (!issuesRes.ok) throw new Error((await issuesRes.json()).error || 'Failed to fetch issues');
      const issuesData = await issuesRes.json();
      issues = issuesData.issues;
      hasMore = issuesData.hasMore;
      wandPlanMode = settingsData.wandPlanMode !== undefined ? settingsData.wandPlanMode : true;
      wandPromptTemplate = settingsData.wandPromptTemplate || '';
      if (settingsData.maxIssueTitleLength) maxIssueTitleLength = settingsData.maxIssueTitleLength;

      // Modal may have been dismissed while loading
      if (!overlay.parentNode) return;

      const list = overlay.querySelector('.issue-list');
      if (issues.length === 0) {
        list.outerHTML = '<div class="issue-empty">No open issues found</div>';
      } else {
        list.innerHTML = '';
        renderIssues(issues);
        list.addEventListener('scroll', () => {
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
            loadMore();
          }
        });
        const buttons = overlay.querySelector('.modal-buttons');
        const startBtn = document.createElement('button');
        startBtn.className = 'btn-primary';
        startBtn.id = 'issue-start';
        startBtn.disabled = true;
        startBtn.textContent = 'Start';
        startBtn.onclick = startIssue;
        buttons.appendChild(startBtn);
      }
    } catch (e) {
      if (!overlay.parentNode) return;
      const list = overlay.querySelector('.issue-list');
      if (list) {
        list.outerHTML = `
          <div class="issue-error">
            <div class="issue-error-message">${escapeHtml(e.message)}</div>
            <button class="issue-retry" id="issue-retry">Retry</button>
          </div>`;
        overlay.querySelector('#issue-retry').onclick = () => {
          const errorDiv = overlay.querySelector('.issue-error');
          if (errorDiv) {
            errorDiv.outerHTML = '<div class="issue-list"><div class="issue-loading"><span class="issue-loading-text">Loading issues…</span></div></div>';
          }
          fetchAndRender();
        };
      }
    }
  }

  fetchAndRender();

  // Wire repo selector change handler
  const repoSelect = overlay.querySelector('#issue-repo-select');
  repoSelect.addEventListener('change', () => {
    gitRoot = repoSelect.value;
    currentPage = 1;
    issues = null;
    selectedIssue = null;
    hasMore = false;
    // Replace issue list (or error/empty state) with fresh loading spinner
    const existing = overlay.querySelector('.issue-list') || overlay.querySelector('.issue-empty') || overlay.querySelector('.issue-error');
    if (existing) {
      const fresh = document.createElement('div');
      fresh.className = 'issue-list';
      fresh.innerHTML = '<div class="issue-loading"><span class="issue-loading-text">Loading issues…</span></div>';
      existing.replaceWith(fresh);
    }
    const startBtn = overlay.querySelector('#issue-start');
    if (startBtn) startBtn.remove();
    fetchAndRender();
  });

  // Populate repo dropdown asynchronously
  fetch('/api/git-roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: allCwds })
  }).then(r => r.json()).then(data => {
    if (!overlay.parentNode || !data.roots || data.roots.length <= 1) return;
    repoSelect.innerHTML = data.roots.map(r =>
      `<option value="${escapeHtml(r.root)}"${r.root === gitRoot ? ' selected' : ''}>${escapeHtml(r.name)}</option>`
    ).join('');
    overlay.querySelector('.issue-repo-selector').style.display = '';
  }).catch(() => {});
}

/**
 * Main initialization
 */
async function init() {
  // Cache available agents and default agent setting for new-tab menu and settings
  fetch('/api/agents').then(r => r.json()).then(data => { 
    window.__deepsteveAgents = data.agents || []; 
    window.__deepsteveDefaultAgent = data.defaultAgent || 'claude';
    initEnginesDropdown();
  }).catch(() => {});
  fetch('/api/settings').then(r => r.json()).then(s => { window.__deepsteveDefaultAgent = s.defaultAgent || 'claude'; }).catch(() => {});

  // Initialize layout manager
  LayoutManager.init();

  // Initialize tab scroll arrows
  initTabArrows();

  // Initialize mod system
  ModManager.init({
    getSessions: getSessionList,
    getActiveSessionId: () => activeId,
    focusSession: switchTo,
    createSession: (cwd, opts) => createSession(cwd, null, true, opts),
    killSession: async (id, opts) => {
      if (opts?.force || await confirmCloseSession(id)) killSession(id);
    },
    closeModTabs: (modId) => {
      for (const [id, s] of sessions) {
        if (s.type === 'mod-tab' && s.modId === modId) killSession(id);
      }
    },
  });

  // File drag-and-drop upload
  initFileDrop({
    getActiveSession: () => {
      if (!activeId) return null;
      const s = sessions.get(activeId);
      if (!s) return null;
      return { id: activeId, cwd: s.cwd, container: s.container, ws: s.ws };
    }
  });

  // Auto-reload browser when server restarts (restart.sh, node --watch, etc.)
  initLiveReload({
    windowId: getWindowId(),
    onMessage: async (msg) => {
      if (msg.type === 'theme') applyTheme(msg.css || '');
      if (msg.type === 'settings') applySettings(msg);
      if (msg.type === 'skills-changed') ModManager.handleSkillsChanged(msg.enabledSkills);
      if (msg.type === 'open-session') {
        // Server created a session (e.g. via /api/start-issue) — open a tab for it
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createSession(msg.cwd, msg.id, false, { name: msg.name, allowDuplicate: true });
      }
      if (msg.type === 'open-display-tab') {
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createDisplayTab(msg.id, msg.name);
      }
      if (msg.type === 'open-mod-tab') {
        if (msg.windowId && msg.windowId !== getWindowId()) return;
        createModTab(msg.modId, { name: msg.name, url: msg.url });
      }
      if (msg.type === 'update-display-tab') {
        const session = sessions.get(msg.id);
        if (session?.type === 'display-tab') {
          const iframe = session.container.querySelector('iframe');
          if (iframe) iframe.src = `/api/display-tab/${msg.id}?t=${Date.now()}`;
        }
      }
      if (msg.type === 'close-display-tab') {
        if (sessions.has(msg.id)) killSession(msg.id);
      }
    },
    onShowRestartConfirm: () => showRestartConfirmDialog(),
    onShowReloadOverlay: () => showReloadOverlay()
  });

  // Initialize Cmd hold mode (tab switching — capture-phase listeners, off by default)
  initCmdHoldMode({
    getOrderedTabIds: () => [...document.querySelectorAll('#tabs-list .tab')].map(t => t.id.replace('tab-', '')),
    getActiveTabId: () => activeId,
    switchToTab: switchTo,
  });

  // Load settings before creating any terminals (prevents color flash, applies title length)
  try {
    const settingsData = await fetch('/api/settings').then(r => r.json());
    if (settingsData.themeCSS) {
      applyTheme(settingsData.themeCSS);
    }
    applySettings(settingsData);
  } catch {}

  // Load available mods (creates Mods button, auto-activates persisted mod)
  // Fire-and-forget — don't block session restore on mod loading
  ModManager.loadAvailableMods();

  // Split button: + creates tab, ▾ opens dropdown menu
  document.getElementById('new-btn').addEventListener('click', () => quickNewSession());
  document.getElementById('new-btn-dropdown').addEventListener('click', (e) => showNewTabMenu(e));
  document.getElementById('issue-btn').addEventListener('click', () => showIssuePicker());
  document.getElementById('empty-state-btn')?.addEventListener('click', () => quickNewSession());

  // Check if this is an existing tab BEFORE starting heartbeat (which creates window ID)
  const isExistingTab = WindowManager.hasExistingWindowId();
  console.log('[init] isExistingTab:', isExistingTab);
  console.log('[init] sessionStorage windowId:', sessionStorage.getItem(nsKey('deepsteve-window-id')));
  console.log('[init] localStorage:', localStorage.getItem(nsKey('deepsteve')));

  // Check for legacy storage format and migrate
  const legacySessions = SessionStore.migrateFromLegacy();

  // Now get/create window ID and start heartbeat
  const windowId = WindowManager.getWindowId();

  // Register sessions provider so heartbeats include session metadata
  WindowManager.setSessionsProvider(() =>
    [...sessions.entries()].map(([id, s]) => ({ id, name: s.name || getDefaultTabName(s.cwd) }))
  );

  // Handle sessions sent from other windows
  WindowManager.onSessionReceived((session) => {
    createSession(session.cwd, session.id, false, { name: session.name, allowDuplicate: true });
  });

  WindowManager.startHeartbeat();

  // Check for ?config=<name> or ?config_id=<id> URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  const configName = urlParams.get('config');
  const configId = urlParams.get('config_id');
  if ((configName || configId) && !isExistingTab) {
    // Ensure configs are loaded (the top-level call is fire-and-forget)
    await loadWindowConfigs();
    const match = windowConfigs.find(c =>
      configId ? c.id === configId : c.name === configName
    );
    if (match) {
      // Clean URL so refresh uses TabSessions, not re-apply
      history.replaceState(null, '', window.location.pathname);
      try {
        await fetch(`/api/window-configs/${match.id}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowId: getWindowId() })
        });
      } catch (e) {
        console.error('Failed to apply window config from URL:', e);
      }
      // Sessions arrive via open-session WebSocket messages
      return;
    }
    // Config not found — fall through to normal init
  }

  // TabSessions (sessionStorage) is the authoritative per-tab source.
  // It survives page refresh and doesn't depend on localStorage window-ID mapping.
  const tabSessions = TabSessions.get();
  console.log('[init] TabSessions:', tabSessions);

  if (isExistingTab && tabSessions.length > 0) {
    // Existing tab with sessions saved in sessionStorage — restore them
    console.log('[init] Restoring from TabSessions');
    restoreSessions(tabSessions);
  } else if (isExistingTab) {
    // Existing tab but TabSessions is empty — try localStorage as fallback
    const savedSessions = SessionStore.getWindowSessions(windowId);
    console.log('[init] windowId:', windowId, 'savedSessions (fallback):', savedSessions);
    if (savedSessions.length > 0) {
      console.log('[init] Restoring from localStorage fallback');
      restoreSessions(savedSessions);
    } else {
      console.log('[init] No saved sessions, prompting for new');
      await promptRepoSession();
    }
  } else {
    // New tab - check for orphaned windows or legacy sessions
    if (legacySessions && legacySessions.length > 0) {
      // Migrate legacy sessions to this window
      for (const session of legacySessions) {
        SessionStore.addSession(windowId, session);
        TabSessions.add(session);
      }
      restoreSessions(legacySessions);
    } else {
      // Check for orphaned windows
      const orphanedWindows = await WindowManager.listOrphanedWindows();

      if (orphanedWindows.length > 0) {
        const result = await showWindowRestoreModal(orphanedWindows);

        if (result.action === 'restore') {
          // Claim the selected window's sessions
          const claimed = WindowManager.claimWindow(result.window.windowId);
          for (const sess of claimed) {
            TabSessions.add(sess);
          }
          restoreSessions(claimed, { allowDuplicate: false });
        } else {
          // Start fresh
          await promptRepoSession();
        }
      } else {
        // No orphaned windows - start fresh
        await promptRepoSession();
      }
    }
  }

  // Update window activity periodically
  setInterval(() => {
    SessionStore.touchWindow(windowId);
  }, 60000);
}

// Start the app
init();
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/cmd-tab-switch.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Command hold mode — tab switching and management.
 *
 * Hold Command for ~1 second to enter "hold mode," then press:
 *   1-9    jump to tab N
 *   , / .  previous / next tab (wrapping)
 *
 * Uses capture-phase document listeners so keys are intercepted before
 * xterm.js sees them — no changes to terminal.js needed.
 */

let enabled = false;
let holdTimer = null;
let tabSwitchModeActive = false;
let metaHeldOnBlur = false;

let getOrderedTabIds;
let getActiveTabId;
let switchToTab;

let HOLD_MS = 1000;

const TAB_KEYS = new Set([
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Comma', 'Period'
]);

function setTabSwitchMode(active) {
  tabSwitchModeActive = active;
  document.getElementById('tabs')?.classList.toggle('tab-switch-mode', active);
}

function resetState() {
  if (holdTimer || tabSwitchModeActive) {
    console.log('[cmd-tab-switch] resetState()', { hadTimer: !!holdTimer, wasActive: tabSwitchModeActive });
  }
  clearTimeout(holdTimer);
  holdTimer = null;
  setTabSwitchMode(false);
}

function onKeyDown(e) {
  if (!enabled) {
    if (e.metaKey && TAB_KEYS.has(e.code)) {
      console.log('[cmd-tab-switch] keydown blocked: enabled=false', { key: e.key, code: e.code });
    }
    return;
  }

  // Meta key pressed — start hold timer (or activate immediately if returning from blur)
  if (e.key === 'Meta' && !e.repeat) {
    if (metaHeldOnBlur) {
      // Cmd was held when we left the window — activate immediately
      metaHeldOnBlur = false;
      setTabSwitchMode(true);
      console.log('[cmd-tab-switch] Meta still held after refocus — tab switch mode ACTIVE');
      return;
    }
    console.log('[cmd-tab-switch] Meta pressed, starting hold timer (' + HOLD_MS + 'ms)');
    resetState();
    holdTimer = setTimeout(() => {
      setTabSwitchMode(true);
      console.log('[cmd-tab-switch] Hold timer fired — tab switch mode ACTIVE');
    }, HOLD_MS);
    return;
  }

  // Non-Meta key clears the blur flag
  metaHeldOnBlur = false;

  // Non-modifier key while Meta is held
  if (e.metaKey) {
    console.log('[cmd-tab-switch] key while Meta held:', { code: e.code, tabSwitchModeActive, inTabKeys: TAB_KEYS.has(e.code) });
    if (!tabSwitchModeActive) {
      // Still within hold period — normal Cmd shortcut, cancel timer
      console.log('[cmd-tab-switch] Not in tab switch mode yet — cancelling timer, passing through');
      resetState();
      return;
    }

    // Tab switch mode is active — check for tab-switch keys
    if (TAB_KEYS.has(e.code)) {
      e.preventDefault();
      e.stopPropagation();

      const tabIds = getOrderedTabIds();
      if (tabIds.length === 0) return;

      if (e.code.startsWith('Digit')) {
        // 1-9 → jump to tab N (1-indexed)
        const index = parseInt(e.code.slice(5), 10) - 1;
        if (index < tabIds.length) {
          switchToTab(tabIds[index]);
        }
      } else if (e.code === 'Comma') {
        // Previous tab (wrapping)
        const activeId = getActiveTabId();
        const idx = tabIds.indexOf(activeId);
        const prev = idx <= 0 ? tabIds.length - 1 : idx - 1;
        switchToTab(tabIds[prev]);
      } else if (e.code === 'Period') {
        // Next tab (wrapping)
        const activeId = getActiveTabId();
        const idx = tabIds.indexOf(activeId);
        const next = idx >= tabIds.length - 1 ? 0 : idx + 1;
        switchToTab(tabIds[next]);
      }
    }
  }
}

function onKeyUp(e) {
  if (!enabled) return;
  if (e.key === 'Meta') {
    metaHeldOnBlur = false;
    resetState();
  }
}

function onBlur() {
  // Remember if tab-switch mode was active (Meta held) so we can
  // re-activate immediately when the window regains focus.
  metaHeldOnBlur = tabSwitchModeActive || holdTimer !== null;
  clearTimeout(holdTimer);
  holdTimer = null;
  setTabSwitchMode(false);
}

export function init({ getOrderedTabIds: g, getActiveTabId: a, switchToTab: s }) {
  getOrderedTabIds = g;
  getActiveTabId = a;
  switchToTab = s;

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
}

export function setEnabled(val) {
  enabled = !!val;
  console.log('[cmd-tab-switch] setEnabled(' + enabled + ')');
  if (!enabled) resetState();
}

export function setHoldMs(ms) {
  HOLD_MS = Math.max(0, ms | 0);
  console.log('[cmd-tab-switch] setHoldMs(' + HOLD_MS + ')');
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/dir-picker.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Directory picker modal for selecting working directory
 */

import { SessionStore } from './session-store.js';

async function fetchDirs(path) {
  try {
    const r = await fetch('/api/dirs?path=' + encodeURIComponent(path));
    return await r.json();
  } catch {
    return { dirs: [] };
  }
}

async function fetchHome() {
  try {
    const r = await fetch('/api/home');
    return (await r.json()).home;
  } catch {
    return '/Users';
  }
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function showDirectoryPicker({ configs = [] } = {}) {
  return new Promise(async (resolve) => {
    const home = await fetchHome();
    const defaultPath = SessionStore.getLastCwd() || home;
    const alwaysUse = SessionStore.getAlwaysUse();

    const configsHtml = configs.length > 0 ? `
        <div class="config-section">
          ${configs.map(c => `<button class="config-btn" data-config-id="${esc(c.id)}" title="Open ${c.tabs.length} tab${c.tabs.length === 1 ? '' : 's'}">${esc(c.name)}</button>`).join('')}
        </div>
        <div class="config-separator"></div>
    ` : '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>Select working directory</h2>
        ${configsHtml}
        <div class="path-wrap">
          <input type="text" id="cwd-input" value="${defaultPath}">
          <button class="path-up" id="up-btn">&#8593;</button>
          <button class="new-folder" id="mkdir-btn">+</button>
        </div>
        <div class="dir-tree" id="dir-tree"></div>
        <label>
          <input type="checkbox" id="always-use" ${alwaysUse ? 'checked' : ''}>
          Always use this directory
        </label>
        <div class="modal-buttons">
          <button class="btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn-primary" id="start-btn">Start</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Config button click handlers
    overlay.querySelectorAll('.config-btn[data-config-id]').forEach(btn => {
      btn.onclick = () => {
        overlay.remove();
        resolve({ type: 'config', configId: btn.dataset.configId });
      };
    });

    const input = overlay.querySelector('#cwd-input');
    const checkbox = overlay.querySelector('#always-use');
    const tree = overlay.querySelector('#dir-tree');
    const upBtn = overlay.querySelector('#up-btn');
    const mkdirBtn = overlay.querySelector('#mkdir-btn');

    async function refreshTree() {
      const r = await fetchDirs(input.value + '/');
      if (!r.dirs.length) {
        tree.innerHTML = '<div class="dir-empty">No subdirectories</div>';
      } else {
        tree.innerHTML = r.dirs.map(d =>
          `<div class="dir-item" data-path="${d}">
            <span class="dir-icon">&#128193;</span>${d.split('/').pop()}
          </div>`
        ).join('');

        tree.querySelectorAll('.dir-item').forEach(el => {
          el.onclick = () => {
            input.value = el.dataset.path;
            refreshTree();
          };
          el.ondblclick = () => {
            input.value = el.dataset.path;
            submit();
          };
        });
      }
    }

    function goUp() {
      const parts = input.value.split('/');
      if (parts.length > 1) {
        parts.pop();
        input.value = parts.join('/') || '/';
        refreshTree();
      }
    }

    upBtn.onclick = goUp;

    mkdirBtn.onclick = async () => {
      const name = prompt('New folder name:');
      if (!name) return;
      const newPath = input.value + '/' + name;
      try {
        const res = await fetch('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: newPath })
        });
        if (res.ok) {
          input.value = newPath;
          refreshTree();
        } else {
          const err = await res.json();
          alert('Failed: ' + err.error);
        }
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    };

    let debounce;
    input.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(refreshTree, 300);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') cancel();
    };

    function submit() {
      const cwd = input.value.trim() || home;
      SessionStore.setLastCwd(cwd);
      SessionStore.setAlwaysUse(checkbox.checked);
      overlay.remove();
      resolve(cwd);
    }

    function cancel() {
      overlay.remove();
      resolve(null);
    }

    overlay.querySelector('#start-btn').onclick = submit;
    overlay.querySelector('#cancel-btn').onclick = cancel;
    overlay.onclick = (e) => { if (e.target === overlay) cancel(); };

    refreshTree();
  });
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/file-drop.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Drag-and-drop file support for terminal sessions.
 *
 * Drops a file into /tmp/deepsteve-drops/ via the server, then types the full
 * path into the terminal — like dropping a file into iTerm.
 */

let getActiveSession = null;
let dragDepth = 0;
let dropZone = null;

function hasFiles(e) {
  return e.dataTransfer && e.dataTransfer.types.includes('Files');
}

function showDropZone() {
  const session = getActiveSession();
  if (!session) return;

  if (!dropZone) {
    dropZone = document.createElement('div');
    dropZone.className = 'file-drop-zone';
    dropZone.innerHTML = '<div class="file-drop-zone-content">Drop files here</div>';
  }

  session.container.appendChild(dropZone);
  dropZone.offsetHeight; // force reflow for transition
  dropZone.classList.add('visible');
}

function hideDropZone() {
  if (dropZone) dropZone.classList.remove('visible');
}

/** Shell-escape a path (wrap in single quotes, escape internal quotes). */
function shellEscape(s) {
  if (/^[a-zA-Z0-9/._\-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Upload a file to /tmp/deepsteve-drops/. Returns the full path on success,
 * null on failure.
 */
function uploadFile(file) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).path);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };
    xhr.onerror = () => resolve(null);
    xhr.open('PUT', `/api/upload/${encodeURIComponent(file.name)}`);
    xhr.send(file);
  });
}

export function initFileDrop({ getActiveSession: getter }) {
  getActiveSession = getter;
  const terminals = document.getElementById('terminals');

  // Prevent browser from navigating to dropped files anywhere on the page
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

  terminals.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) showDropZone();
  });

  terminals.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  terminals.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth--;
    if (dragDepth === 0) hideDropZone();
  });

  terminals.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    hideDropZone();

    const session = getActiveSession();
    if (!session) return;

    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;

    // Upload all files, collect paths
    const paths = [];
    for (const file of files) {
      const p = await uploadFile(file);
      if (p) paths.push(p);
    }

    // Type the paths into the terminal, space-separated
    if (paths.length > 0) {
      session.ws.send(paths.map(shellEscape).join(' '));
    }
  });
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/layout-manager.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Layout management for horizontal/vertical tab layouts
 */

import { nsKey } from './storage-namespace.js';

const STORAGE_KEY = nsKey('deepsteve-layout');
const MIN_SIDEBAR_WIDTH = 60;
const DEFAULT_SIDEBAR_WIDTH = 200;

let currentLayout = 'horizontal';
let sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let isDragging = false;

/**
 * Get saved layout preference
 */
function getSavedLayout() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      return {
        layout: data.layout || 'horizontal',
        sidebarWidth: data.sidebarWidth || DEFAULT_SIDEBAR_WIDTH
      };
    }
  } catch (e) {
    // Ignore parse errors
  }
  return { layout: 'horizontal', sidebarWidth: DEFAULT_SIDEBAR_WIDTH };
}

/**
 * Save layout preference
 */
function saveLayout() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    layout: currentLayout,
    sidebarWidth: sidebarWidth
  }));
}

/**
 * Apply the current layout to the DOM
 */
function applyLayout() {
  const container = document.getElementById('app-container');
  const tabs = document.getElementById('tabs');
  const toggleBtn = document.getElementById('layout-toggle');

  if (currentLayout === 'vertical') {
    container.classList.add('vertical-layout');
    tabs.style.width = sidebarWidth + 'px';
    toggleBtn.textContent = '⬜'; // Icon for vertical mode (click to go horizontal)
    toggleBtn.title = 'Switch to horizontal tabs';
  } else {
    container.classList.remove('vertical-layout');
    tabs.style.width = '';
    toggleBtn.textContent = '▤'; // Icon for horizontal mode (click to go vertical)
    toggleBtn.title = 'Switch to vertical tabs';
  }
}

/**
 * Toggle between horizontal and vertical layouts
 */
function toggleLayout() {
  currentLayout = currentLayout === 'horizontal' ? 'vertical' : 'horizontal';
  applyLayout();
  saveLayout();

  // Trigger resize event so terminals refit
  window.dispatchEvent(new Event('resize'));
}

/**
 * Setup drag handling for the resizer
 */
function setupResizer() {
  const resizer = document.getElementById('sidebar-resizer');
  const tabs = document.getElementById('tabs');

  resizer.addEventListener('mousedown', (e) => {
    if (currentLayout !== 'vertical') return;

    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    let newWidth = e.clientX;

    // Enforce minimum width
    if (newWidth < MIN_SIDEBAR_WIDTH) {
      newWidth = MIN_SIDEBAR_WIDTH;
    }

    // Max width is 50% of viewport
    const maxWidth = window.innerWidth * 0.5;
    if (newWidth > maxWidth) {
      newWidth = maxWidth;
    }

    sidebarWidth = newWidth;
    tabs.style.width = sidebarWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveLayout();

      // Trigger resize so terminals refit
      window.dispatchEvent(new Event('resize'));
    }
  });
}

/**
 * Initialize layout manager
 */
export function initLayoutManager() {
  // Load saved preferences
  const saved = getSavedLayout();
  currentLayout = saved.layout;
  sidebarWidth = saved.sidebarWidth;

  // Setup toggle button
  const toggleBtn = document.getElementById('layout-toggle');
  toggleBtn.addEventListener('click', toggleLayout);

  // Setup resizer drag handling
  setupResizer();

  // Apply initial layout
  applyLayout();
}

export const LayoutManager = {
  init: initLayoutManager,
  toggle: toggleLayout,
  getLayout: () => currentLayout
};
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/live-reload.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Live reload on server restart.
 *
 * State machine:
 *   CONNECTED → (server sends confirm-restart) → CONFIRMING
 *   CONFIRMING → (user confirms) → CONFIRMED → (WS closes) → RELOADING
 *   CONFIRMING → (user declines) → CONNECTED
 *   CONNECTED → (WS closes unexpectedly) → RECONNECTING → (server back) → CONNECTED
 *   RELOADING → (server back) → page reload
 *
 * All windows show the confirmation modal. First response wins — the deciding
 * window sends restart-confirmed/declined to the server and broadcasts
 * restart-decided via BroadcastChannel to dismiss modals in other windows.
 */

import { nsChannel } from './storage-namespace.js';

const State = {
  CONNECTED: 'connected',
  CONFIRMING: 'confirming',
  CONFIRMED: 'confirmed',
  RELOADING: 'reloading',
  RECONNECTING: 'reconnecting',
};

export function initLiveReload({ onMessage, onShowRestartConfirm, onShowReloadOverlay, windowId } = {}) {
  let ws;
  let state = State.DISCONNECTED;
  let pingTimer = null;
  let lastPingTime = 0;

  const restartChannel = new BroadcastChannel(nsChannel('deepsteve-restart'));

  function setState(newState) {
    console.log(`[live-reload] ${state} → ${newState}`);
    state = newState;
  }

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    ws = new WebSocket(wsProto + location.host + '?' + params);

    ws.onopen = () => {
      setState(State.CONNECTED);
      lastPingTime = Date.now();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastPingTime > 45000 && ws.readyState === WebSocket.OPEN) {
          console.log('[live-reload] no ping in 45s, reconnecting...');
          ws.close();
        }
      }, 45000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          lastPingTime = Date.now();
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'confirm-restart') {
          if (state === State.CONNECTED) showConfirmInAllWindows();
        } else if (msg.type === 'reload') {
          // Server is about to shut down with --refresh — mark for reload
          if (state === State.CONFIRMED) {
            window.__deepsteveReloadPending = true;
          }
        } else if (onMessage) {
          onMessage(msg);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

      if (state === State.CONFIRMED || state === State.RELOADING) {
        // Restart was confirmed — wait for server and reload
        window.__deepsteveReloadPending = true;
        setState(State.RELOADING);
        if (onShowReloadOverlay) onShowReloadOverlay();
        pollAndReload();
      } else {
        // Unexpected disconnect — always reconnect
        setState(State.RECONNECTING);
        pollAndReconnect();
      }
    };
  }

  // --- Reload: poll until server is back, then force-reload the page ---

  function pollAndReload() {
    let reloading = false;
    setInterval(async () => {
      if (reloading) return;
      try {
        const res = await fetch('/api/home', { cache: 'no-store' });
        if (res.ok) {
          reloading = true;
          console.log('[live-reload] server is back, reloading page...');
          // Use <meta http-equiv="refresh"> instead of location.reload().
          // Firefox blocks location.reload() when ANY beforeunload handler is
          // registered, regardless of what the handler does. Meta refresh
          // bypasses beforeunload entirely.
          const meta = document.createElement('meta');
          meta.httpEquiv = 'refresh';
          meta.content = '0';
          document.head.appendChild(meta);
        }
      } catch {}
    }, 500);
  }

  // --- Silent reconnect: poll until server is back, then reconnect WS ---

  function pollAndReconnect() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/home', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(interval);
          console.log('[live-reload] server is back, reconnecting WS...');
          connect();
        }
      } catch {}
    }, 500);
  }

  // --- Show modal in every window, first response wins ---

  function showConfirmInAllWindows() {
    setState(State.CONFIRMING);

    const modal = onShowRestartConfirm
      ? onShowRestartConfirm()
      : { promise: Promise.resolve(true), dismiss: () => {} };

    const onBroadcast = (event) => {
      if (event.data.type === 'restart-decided') {
        restartChannel.removeEventListener('message', onBroadcast);
        // Another window already responded — dismiss our modal and follow their decision
        modal.dismiss();
        if (event.data.confirmed) setState(State.CONFIRMED);
        else setState(State.CONNECTED);
      }
    };
    restartChannel.addEventListener('message', onBroadcast);

    modal.promise.then(confirmed => {
      restartChannel.removeEventListener('message', onBroadcast);
      if (state !== State.CONFIRMING) return; // another window already decided
      if (confirmed) {
        setState(State.CONFIRMED);
        ws.send(JSON.stringify({ type: 'restart-confirmed' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: true });
      } else {
        setState(State.CONNECTED);
        ws.send(JSON.stringify({ type: 'restart-declined' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: false });
      }
    });
  }

  connect();
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/mod-manager.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Mod system for deepsteve — loads alternative visual views in iframes
 * while still connecting to real PTY sessions via a bridge API.
 *
 * Two UI concepts:
 *  1. "Mods" dropdown (right side, near Sessions) — lists available mods with enable/disable toggles
 *  2. Panel tabs (right edge) — vertical tabs for switching between enabled panel mods
 *
 * Panel mods all stay loaded (iframes alive) so MCP tools keep working.
 * Only one panel is visible at a time; clicking a different tab switches to it.
 */

import { nsKey } from './storage-namespace.js';

const STORAGE_KEY = nsKey('deepsteve-enabled-mods'); // Set of enabled mod IDs
const KNOWN_MODS_KEY = nsKey('deepsteve-known-mods'); // All mod IDs known at last save
const ACTIVE_VIEW_KEY = nsKey('deepsteve-active-mod-view'); // Which mod view is currently showing
const PANEL_VISIBLE_KEY = nsKey('deepsteve-panel-visible'); // Whether the panel is shown
const ACTIVE_PANEL_KEY = nsKey('deepsteve-active-panel'); // Which panel tab is active

let allMods = [];          // [{ id, name, description, entry, toolbar }]
let enabledMods = new Set(); // mod IDs that are enabled
let hasExplicitModPrefs = false; // true if user has saved mod prefs before
let activeViewId = null;   // mod ID currently showing in the fullscreen iframe (or null)
let iframe = null;
let modContainer = null;
let backBtn = null;
let hooks = null;
let sessionCallbacks = [];
let modViewVisible = false;
let toolbarButtons = new Map(); // modId → button element
let settingsCallbacks = [];     // [{modId, cb}] — notified on settings change

// Panel mode state — multi-panel
let panelContainer = null;
let panelResizer = null;
let panelMods = new Map();       // modId → { iframe, mod }
let visiblePanelId = null;       // which panel is currently VISIBLE (or null)
let panelTabsContainer = null;   // #panel-tabs DOM element
let panelTabs = new Map();       // modId → tab button element
let taskCallbacks = [];          // [{modId, cb}] — callbacks for task broadcasts
let agentChatCallbacks = [];     // [{modId, cb}] — callbacks for agent-chat broadcasts
let browserEvalCallbacks = [];   // [{modId, cb}] — callbacks for browser-eval-request
let browserConsoleCallbacks = []; // [{modId, cb}] — callbacks for browser-console-request
let screenshotCaptureCallbacks = []; // [{modId, cb}] — callbacks for screenshot-capture-request
let sceneUpdateCallbacks = [];       // [{modId, cb}] — callbacks for scene-update-request
let sceneQueryCallbacks = [];        // [{modId, cb}] — callbacks for scene-query-request
let sceneSnapshotCallbacks = [];     // [{modId, cb}] — callbacks for scene-snapshot-request
let babyBrowserCallbacks = [];       // [{modId, cb}] — callbacks for baby-browser-request
let activeSessionCallbacks = [];     // [{modId, cb}] — callbacks for active session changes
let getActiveSessionIdFn = null;     // set from appHooks
let deepsteveVersion = null;   // set from /api/mods response
let panelWidth = 360;
const MIN_PANEL_WIDTH = 200;
const PANEL_STORAGE_KEY = nsKey('deepsteve-panel-width');

// ─── Dependency helpers ──────────────────────────────────────────────

/**
 * Return transitive dependency list for a mod in load order (deepest first).
 * Throws on circular dependency.
 */
function _getRequiredMods(modId, visited = new Set()) {
  if (visited.has(modId)) {
    throw new Error(`Circular dependency: ${[...visited, modId].join(' → ')}`);
  }
  const mod = allMods.find(m => m.id === modId);
  if (!mod || !mod.requires || mod.requires.length === 0) return [];
  visited.add(modId);
  const result = [];
  for (const depId of mod.requires) {
    // Recurse into dep's own deps first (deepest first)
    for (const transitive of _getRequiredMods(depId, new Set(visited))) {
      if (!result.includes(transitive)) result.push(transitive);
    }
    if (!result.includes(depId)) result.push(depId);
  }
  return result;
}

/**
 * Return array of currently-enabled mod IDs that depend (directly or transitively) on the given mod.
 */
function _getDependents(modId) {
  const dependents = [];
  for (const mod of allMods) {
    if (!enabledMods.has(mod.id)) continue;
    if (mod.id === modId) continue;
    try {
      const deps = _getRequiredMods(mod.id);
      if (deps.includes(modId)) dependents.push(mod.id);
    } catch {
      // Circular dep — skip
    }
  }
  return dependents;
}

/**
 * Check whether all requirements for a mod are satisfiable.
 * Returns { satisfied, missing[], disabled[], error? }
 */
function _checkRequirements(modId) {
  let deps;
  try {
    deps = _getRequiredMods(modId);
  } catch (e) {
    return { satisfied: false, missing: [], disabled: [], error: e.message };
  }
  const missing = [];  // not installed at all
  const disabled = []; // installed but not enabled
  for (const depId of deps) {
    const installed = allMods.find(m => m.id === depId);
    if (!installed) {
      missing.push(depId);
    } else if (!enabledMods.has(depId)) {
      disabled.push(depId);
    }
  }
  return { satisfied: missing.length === 0, missing, disabled };
}

/**
 * Show a brief dependency notice on a mod card that auto-fades after 4s.
 * type: 'info' | 'error'
 */
function _showDepNotice(card, message, type) {
  // Remove any existing notice on this card
  const existing = card.querySelector('.mod-dep-notice');
  if (existing) existing.remove();

  const notice = document.createElement('div');
  notice.className = `mod-dep-notice mod-dep-notice-${type}`;
  notice.textContent = message;
  card.appendChild(notice);
  setTimeout(() => notice.remove(), 4000);
}

/**
 * Refresh all checkbox toggle states in the marketplace modal to match enabledMods.
 * Requires card.dataset.modId on each card.
 */
function _refreshCardToggles(overlay) {
  for (const card of overlay.querySelectorAll('.mod-card[data-mod-id]')) {
    const id = card.dataset.modId;
    const cb = card.querySelector('.mod-card-toggle input[type="checkbox"]');
    if (cb) cb.checked = enabledMods.has(id);
  }
}

/**
 * Initialize the mod system — creates DOM elements.
 */
function init(appHooks) {
  hooks = appHooks;
  getActiveSessionIdFn = appHooks.getActiveSessionId || null;

  // Wrap #terminals in a row container for side-by-side panel layout
  const terminals = document.getElementById('terminals');
  const contentRow = document.createElement('div');
  contentRow.id = 'content-row';
  terminals.parentNode.insertBefore(contentRow, terminals);
  contentRow.appendChild(terminals);

  // Create mod container (fullscreen mod view, sibling of content-row)
  modContainer = document.createElement('div');
  modContainer.id = 'mod-container';
  contentRow.parentNode.insertBefore(modContainer, contentRow.nextSibling);

  // Create back button (in #tabs, after layout-toggle)
  backBtn = document.createElement('button');
  backBtn.className = 'mod-back-btn';
  backBtn.style.display = 'none';
  backBtn.addEventListener('click', () => showModView());
  const layoutToggle = document.getElementById('layout-toggle');
  layoutToggle.parentNode.insertBefore(backBtn, layoutToggle.nextSibling);

  // Create panel resizer and container (inside content-row, after #terminals)
  panelResizer = document.createElement('div');
  panelResizer.id = 'panel-resizer';
  contentRow.appendChild(panelResizer);

  panelContainer = document.createElement('div');
  panelContainer.id = 'panel-container';
  contentRow.appendChild(panelContainer);

  // Create panel tabs strip (inside content-row, after panel container)
  panelTabsContainer = document.createElement('div');
  panelTabsContainer.id = 'panel-tabs';
  contentRow.appendChild(panelTabsContainer);

  // Restore saved panel width
  try {
    const saved = parseInt(localStorage.getItem(PANEL_STORAGE_KEY));
    if (saved >= MIN_PANEL_WIDTH) panelWidth = saved;
  } catch {}

  _setupPanelResizer();

  // Load enabled mods from localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      hasExplicitModPrefs = true;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) enabledMods = new Set(saved);
    }
  } catch {}

  // Cross-tab sync for regular (non-skill) mods via storage events
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || e.storageArea !== localStorage) return;
    let newSet;
    try {
      const parsed = JSON.parse(e.newValue);
      newSet = new Set(Array.isArray(parsed) ? parsed : []);
    } catch { return; }

    // Find newly enabled mods
    for (const id of newSet) {
      if (!enabledMods.has(id)) {
        enabledMods.add(id);
        const mod = allMods.find(m => m.id === id);
        if (!mod) continue;
        if (mod.display === 'panel') {
          _loadPanelMod(mod);
        } else if (mod.display !== 'tab' && mod.entry) {
          _createToolbarButton(mod);
        }
      }
    }

    // Find newly disabled mods
    for (const id of [...enabledMods]) {
      if (!newSet.has(id)) {
        enabledMods.delete(id);
        const mod = allMods.find(m => m.id === id);
        if (!mod) continue;
        if (mod.display === 'panel') {
          _unloadPanelMod(id);
        } else if (mod.display === 'tab') {
          if (hooks?.closeModTabs) hooks.closeModTabs(id);
        } else {
          _removeToolbarButton(id);
          if (activeViewId === id) _hideMod();
        }
      }
    }

    // Refresh marketplace modal toggles if open
    const overlay = document.querySelector('.modal-overlay:has(.marketplace-modal)');
    if (overlay) _refreshCardToggles(overlay);
  });
}

/**
 * Persist enabled mod IDs to localStorage.
 */
function _saveEnabledMods() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabledMods]));
  if (allMods.length > 0) {
    localStorage.setItem(KNOWN_MODS_KEY, JSON.stringify(allMods.map(m => m.id)));
  }
}

/**
 * Load mod settings, merging stored values with schema defaults.
 */
function _loadModSettings(mod) {
  const defaults = {};
  for (const s of (mod.settings || [])) {
    defaults[s.key] = s.default;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(nsKey(`deepsteve-mod-settings-${mod.id}`)));
    if (stored) return { ...defaults, ...stored };
  } catch {}
  return defaults;
}

/**
 * Save a single mod setting value.
 */
function _saveModSetting(modId, key, value) {
  const mod = allMods.find(m => m.id === modId);
  if (!mod) return;
  const current = _loadModSettings(mod);
  current[key] = value;
  localStorage.setItem(nsKey(`deepsteve-mod-settings-${modId}`), JSON.stringify(current));
  _notifySettingsChanged(modId);
}

/**
 * Notify mod iframe that settings changed.
 */
function _notifySettingsChanged(modId) {
  const mod = allMods.find(m => m.id === modId);
  if (!mod) return;
  const settings = _loadModSettings(mod);
  for (const entry of settingsCallbacks) {
    if (entry.modId === modId) {
      try { entry.cb(settings); } catch (e) { console.error('Settings callback error:', e); }
    }
  }
}

/**
 * Fetch available mods from server, show the Mods button, and create toolbar buttons.
 */
async function loadAvailableMods() {
  try {
    const res = await fetch('/api/mods');
    const data = await res.json();
    allMods = data.mods || [];
    deepsteveVersion = data.deepsteveVersion || null;
  } catch { return; }

  if (allMods.length === 0) return;

  // Show the Mods button
  const modsBtn = document.getElementById('mods-btn');
  modsBtn.style.display = '';

  // Wire up button to open marketplace modal
  modsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _showMarketplaceModal();
  });

  // Remove incompatible mods from enabledMods (in case they were enabled before)
  for (const mod of allMods) {
    if (mod.compatible === false) enabledMods.delete(mod.id);
  }

  // Create toolbar buttons for enabled non-panel, non-tab mods
  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.entry && mod.display !== 'panel' && mod.display !== 'tab' && mod.compatible !== false) {
      _createToolbarButton(mod);
    }
  }

  // Auto-enable enabledByDefault mods
  if (!hasExplicitModPrefs) {
    // First visit — enable all enabledByDefault mods
    for (const mod of allMods) {
      if (mod.enabledByDefault && mod.compatible !== false) {
        try {
          for (const depId of _getRequiredMods(mod.id)) {
            const depMod = allMods.find(m => m.id === depId);
            if (depMod && depMod.compatible !== false) enabledMods.add(depId);
          }
        } catch {} // skip on circular dep
        enabledMods.add(mod.id);
      }
    }
    _saveEnabledMods();
  } else {
    // Existing user — auto-enable any NEW enabledByDefault mods not in the known set
    let knownMods = new Set();
    try {
      const raw = localStorage.getItem(KNOWN_MODS_KEY);
      if (raw) knownMods = new Set(JSON.parse(raw));
    } catch {}
    let changed = false;
    for (const mod of allMods) {
      if (mod.enabledByDefault && mod.compatible !== false && !knownMods.has(mod.id)) {
        try {
          for (const depId of _getRequiredMods(mod.id)) {
            const depMod = allMods.find(m => m.id === depId);
            if (depMod && depMod.compatible !== false) enabledMods.add(depId);
          }
        } catch {}
        enabledMods.add(mod.id);
        changed = true;
      }
    }
    if (changed) _saveEnabledMods();
    // Always update known mods to track the current set
    if (allMods.length > 0) {
      localStorage.setItem(KNOWN_MODS_KEY, JSON.stringify(allMods.map(m => m.id)));
    }
  }

  // Auto-show the last active view if its mod is still enabled
  const savedViewId = localStorage.getItem(ACTIVE_VIEW_KEY);
  if (savedViewId && enabledMods.has(savedViewId)) {
    const mod = allMods.find(m => m.id === savedViewId);
    if (mod) _showMod(mod);
  }

  // Load ALL enabled panel mods (not just the first one)
  const panelWasVisible = localStorage.getItem(PANEL_VISIBLE_KEY) !== 'false';
  const savedActivePanelId = localStorage.getItem(ACTIVE_PANEL_KEY);
  let firstPanelId = null;

  for (const mod of allMods) {
    if (enabledMods.has(mod.id) && mod.display === 'panel' && mod.compatible !== false) {
      _loadPanelMod(mod);
      if (!firstPanelId) firstPanelId = mod.id;
    }
  }

  // Restore which panel was active, or default to first
  if (panelWasVisible && panelMods.size > 0) {
    const restoreId = (savedActivePanelId && panelMods.has(savedActivePanelId))
      ? savedActivePanelId
      : firstPanelId;
    if (restoreId) {
      _switchToPanel(restoreId);
      // If fullscreen mod is active, panel DOM won't be shown yet —
      // _hideMod() will restore it when exiting fullscreen.
      // But if no fullscreen mod, verify the DOM is actually visible.
      if (!modViewVisible) {
        requestAnimationFrame(() => {
          if (visiblePanelId && panelContainer.style.display === 'none') {
            _showPanel();
          }
        });
      }
    }
  }
}

/**
 * Show the marketplace modal with mod cards, search, and filters.
 */
async function _showMarketplaceModal() {
  // Fetch installed mods and catalog in parallel
  let catalogMods = [];
  try {
    const [modsRes, catalogRes] = await Promise.all([
      fetch('/api/mods').then(r => r.json()).catch(() => null),
      fetch('/api/mods/catalog').then(r => r.json()).catch(() => ({ mods: [] }))
    ]);
    if (modsRes) {
      allMods = modsRes.mods || [];
      deepsteveVersion = modsRes.deepsteveVersion || null;
    }
    catalogMods = catalogRes.mods || [];
  } catch {}

  // Merge: installed mods first, then catalog-only mods
  const installedIds = new Set(allMods.map(m => m.id));
  const catalogOnly = catalogMods.filter(m => !installedIds.has(m.id));

  // Build unified list — installed mods get their catalog info merged
  const unifiedMods = allMods.map(mod => {
    const catEntry = catalogMods.find(c => c.id === mod.id);
    return {
      ...mod,
      catalogVersion: catEntry?.version || null,
      downloadUrl: catEntry?.downloadUrl || null,
      updateAvailable: catEntry?.updateAvailable || false,
    };
  });
  for (const cat of catalogOnly) {
    unifiedMods.push({
      ...cat,
      source: 'official',
      catalogVersion: cat.version,
    });
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal marketplace-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'marketplace-header';
  header.innerHTML = `<h2>Mods</h2><div class="marketplace-search"><input type="text" placeholder="Search mods..."></div>`;

  // Filters
  const filters = document.createElement('div');
  filters.className = 'marketplace-filters';
  const filterNames = ['All', 'Enabled', 'Skills', 'Panel', 'Fullscreen', 'Games'];
  for (const name of filterNames) {
    const pill = document.createElement('button');
    pill.className = 'filter-pill' + (name === 'All' ? ' active' : '');
    pill.textContent = name;
    pill.dataset.filter = name.toLowerCase();
    filters.appendChild(pill);
  }

  // List
  const list = document.createElement('div');
  list.className = 'marketplace-list';

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-buttons';
  footer.innerHTML = '<button class="btn-secondary" data-close>Close</button>';

  modal.appendChild(header);
  modal.appendChild(filters);
  modal.appendChild(list);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // State
  let activeFilter = 'all';
  let searchQuery = '';
  let searchTimeout = null;

  function renderCards() {
    const q = searchQuery.toLowerCase();
    const filtered = unifiedMods.filter(mod => {
      // Search filter
      if (q) {
        const name = (mod.name || mod.id || '').toLowerCase();
        const desc = (mod.description || '').toLowerCase();
        const tags = (mod.tags || []).join(' ').toLowerCase();
        if (!name.includes(q) && !desc.includes(q) && !tags.includes(q)) return false;
      }
      // Category filter
      if (activeFilter === 'enabled') return mod.type === 'skill' ? mod.enabled : enabledMods.has(mod.id);
      if (activeFilter === 'skills') return mod.type === 'skill';
      if (activeFilter === 'panel') return mod.type !== 'skill' && mod.display === 'panel';
      if (activeFilter === 'fullscreen') return mod.type !== 'skill' && mod.display !== 'panel';
      if (activeFilter === 'games') return mod.tags && mod.tags.includes('games');
      return true;
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="marketplace-empty">No mods match your search</div>';
      return;
    }

    list.innerHTML = '';
    for (const mod of filtered) {
      list.appendChild(_createModCard(mod, overlay));
    }
  }

  // Search input
  const searchInput = header.querySelector('input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchQuery = searchInput.value;
      renderCards();
    }, 150);
  });

  // Filter pills
  filters.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      filters.querySelector('.filter-pill.active')?.classList.remove('active');
      pill.classList.add('active');
      activeFilter = pill.dataset.filter;
      renderCards();
    });
  });

  // Close
  const close = () => overlay.remove();
  footer.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Render initial cards
  renderCards();
  searchInput.focus();
}

/**
 * Create a mod card element for the marketplace.
 */
function _createSkillCard(mod, marketplaceOverlay) {
  const card = document.createElement('div');
  card.className = 'mod-card';
  card.dataset.modId = mod.id;

  // Extract skill ID from "skill:github-issue"
  const skillId = mod.id.replace('skill:', '');

  // Header
  const header = document.createElement('div');
  header.className = 'mod-card-header';

  const info = document.createElement('div');
  info.className = 'mod-card-info';
  info.innerHTML = `<span class="mod-card-name">${mod.slashCommand || mod.name}</span>` +
    `<span class="mod-badge skill">Skill</span>` +
    `<span class="mod-badge built-in">Built-in</span>`;

  const actions = document.createElement('div');
  actions.className = 'mod-card-actions';

  const toggle = document.createElement('label');
  toggle.className = 'mod-card-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!mod.enabled;
  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  toggle.appendChild(checkbox);
  toggle.appendChild(slider);

  checkbox.addEventListener('change', async () => {
    const endpoint = checkbox.checked ? '/api/skills/enable' : '/api/skills/disable';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed');
      }
      mod.enabled = checkbox.checked;
    } catch (e) {
      checkbox.checked = !checkbox.checked; // revert
      _showDepNotice(card, e.message, 'error');
    }
  });

  const viewBtn = document.createElement('button');
  viewBtn.className = 'skill-view-btn';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/content`);
      if (!res.ok) throw new Error('Failed to load skill content');
      const { content } = await res.json();
      _showSkillContentModal(mod.slashCommand || mod.name, content);
    } catch (e) {
      _showDepNotice(card, e.message, 'error');
    }
  });

  actions.appendChild(viewBtn);
  actions.appendChild(toggle);
  header.appendChild(info);
  header.appendChild(actions);
  card.appendChild(header);

  // Description
  if (mod.description) {
    const desc = document.createElement('div');
    desc.className = 'mod-card-description';
    desc.textContent = mod.description;
    card.appendChild(desc);
  }

  // Argument hint
  if (mod.argumentHint) {
    const hint = document.createElement('div');
    hint.className = 'mod-card-description';
    hint.style.color = 'var(--ds-text-secondary)';
    hint.style.fontSize = '11px';
    hint.textContent = `Usage: ${mod.slashCommand} ${mod.argumentHint}`;
    card.appendChild(hint);
  }

  return card;
}

function _showSkillContentModal(name, content) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal skill-content-modal">
      <div class="modal-header"><span>${name}</span></div>
      <div class="skill-content-body"><pre></pre></div>
      <div class="modal-footer"><button class="btn" data-close>Close</button></div>
    </div>`;
  overlay.querySelector('pre').textContent = content;
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

function _createModCard(mod, marketplaceOverlay) {
  // Skills get a simplified card
  if (mod.type === 'skill') return _createSkillCard(mod, marketplaceOverlay);

  const card = document.createElement('div');
  card.className = 'mod-card' + (mod.compatible === false ? ' mod-card-incompatible' : '');
  card.dataset.modId = mod.id;

  const isInstalled = allMods.some(m => m.id === mod.id);
  const isEnabled = enabledMods.has(mod.id);
  const isBuiltIn = mod.source === 'built-in';
  const hasSettings = mod.settings && mod.settings.length > 0;
  const badgeClass = isBuiltIn ? 'built-in' : 'official';
  const badgeText = isBuiltIn ? 'Built-in' : 'Official';

  // Header row
  const header = document.createElement('div');
  header.className = 'mod-card-header';

  const info = document.createElement('div');
  info.className = 'mod-card-info';
  info.innerHTML = `<span class="mod-card-name">${mod.name || mod.id}</span><span class="mod-badge ${badgeClass}">${badgeText}</span>` +
    (mod.experimental ? `<span class="mod-badge experimental">Experimental</span>` : '') +
    `<span class="mod-card-version">v${mod.version || '?'}</span>`;

  const actions = document.createElement('div');
  actions.className = 'mod-card-actions';

  if (hasSettings && isInstalled) {
    const gearBtn = document.createElement('button');
    gearBtn.className = 'mod-settings-btn';
    gearBtn.innerHTML = '&#9881;';
    gearBtn.title = 'Settings';
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _showSettingsModal(mod);
    });
    actions.appendChild(gearBtn);
  }

  if (isInstalled) {
    const toggle = document.createElement('label');
    toggle.className = 'mod-card-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isEnabled;
    const reqCheck = _checkRequirements(mod.id);
    checkbox.disabled = mod.compatible === false || reqCheck.missing.length > 0;
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    toggle.appendChild(checkbox);
    toggle.appendChild(slider);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        // ── Enable: check dependencies first ──
        const req = _checkRequirements(mod.id);
        if (req.error) {
          checkbox.checked = false;
          _showDepNotice(card, req.error, 'error');
          return;
        }
        if (req.missing.length > 0) {
          checkbox.checked = false;
          _showDepNotice(card, `Missing: ${req.missing.join(', ')}`, 'error');
          return;
        }
        // Auto-enable disabled dependencies
        const alsoEnabled = [];
        for (const depId of req.disabled) {
          const depMod = allMods.find(m => m.id === depId);
          if (!depMod) continue;
          enabledMods.add(depId);
          if (depMod.display === 'panel') {
            _loadPanelMod(depMod);
          } else if (depMod.display !== 'tab' && depMod.entry) {
            _createToolbarButton(depMod);
          }
          alsoEnabled.push(depMod.name || depId);
        }
        // Enable the mod itself
        enabledMods.add(mod.id);
        if (mod.display === 'panel') {
          _loadPanelMod(mod);
          _switchToPanel(mod.id);
        } else if (mod.display !== 'tab' && mod.entry) {
          _createToolbarButton(mod);
        }
        if (alsoEnabled.length > 0) {
          _showDepNotice(card, `Also enabled: ${alsoEnabled.join(', ')}`, 'info');
          _refreshCardToggles(marketplaceOverlay);
        }
      } else {
        // ── Disable: cascade-disable dependents first ──
        const dependents = _getDependents(mod.id);
        const alsoDisabled = [];
        for (const depId of dependents) {
          const depMod = allMods.find(m => m.id === depId);
          enabledMods.delete(depId);
          if (depMod?.display === 'panel') {
            _unloadPanelMod(depId);
          } else if (depMod?.display === 'tab') {
            if (hooks?.closeModTabs) hooks.closeModTabs(depId);
          } else {
            _removeToolbarButton(depId);
            if (activeViewId === depId) _hideMod();
          }
          alsoDisabled.push(depMod?.name || depId);
        }
        // Disable the mod itself
        enabledMods.delete(mod.id);
        if (mod.display === 'panel') {
          _unloadPanelMod(mod.id);
        } else if (mod.display === 'tab') {
          if (hooks?.closeModTabs) hooks.closeModTabs(mod.id);
        } else {
          _removeToolbarButton(mod.id);
          if (activeViewId === mod.id) {
            _hideMod();
          }
        }
        if (alsoDisabled.length > 0) {
          _showDepNotice(card, `Also disabled: ${alsoDisabled.join(', ')}`, 'info');
          _refreshCardToggles(marketplaceOverlay);
        }
      }
      _saveEnabledMods();
    });

    actions.appendChild(toggle);
  }

  header.appendChild(info);
  header.appendChild(actions);
  card.appendChild(header);

  // Description
  if (mod.description) {
    const desc = document.createElement('div');
    desc.className = 'mod-card-description';
    desc.textContent = mod.description;
    card.appendChild(desc);
  }

  // Dependency tags
  if (mod.requires && mod.requires.length > 0) {
    const depsRow = document.createElement('div');
    depsRow.className = 'mod-card-deps';
    depsRow.textContent = 'Requires: ';
    for (const depId of mod.requires) {
      const depMod = allMods.find(m => m.id === depId);
      const tag = document.createElement('span');
      if (!depMod) {
        tag.className = 'dep-tag dep-tag-red';
        tag.textContent = depId;
        tag.title = 'Not installed';
      } else if (!enabledMods.has(depId)) {
        tag.className = 'dep-tag dep-tag-orange';
        tag.textContent = depMod.name || depId;
        tag.title = 'Installed but disabled — will be auto-enabled';
      } else {
        tag.className = 'dep-tag dep-tag-green';
        tag.textContent = depMod.name || depId;
        tag.title = 'Enabled';
      }
      depsRow.appendChild(tag);
    }
    card.appendChild(depsRow);
  }

  // Incompatible warning
  if (mod.compatible === false) {
    const warn = document.createElement('div');
    warn.className = 'mod-card-description';
    warn.style.color = 'var(--ds-accent-red)';
    warn.textContent = `Requires deepsteve v${mod.minDeepsteveVersion}+`;
    card.appendChild(warn);
  }

  // Footer for non-built-in mods (install/uninstall/update)
  if (!isBuiltIn) {
    const footer = document.createElement('div');
    footer.className = 'mod-card-footer';

    if (isInstalled) {
      // Update button (if available)
      if (mod.updateAvailable && mod.downloadUrl) {
        const updateBtn = document.createElement('button');
        updateBtn.className = 'btn-update';
        updateBtn.textContent = `Update to v${mod.catalogVersion}`;
        updateBtn.addEventListener('click', async () => {
          updateBtn.disabled = true;
          updateBtn.textContent = 'Updating...';
          try {
            const res = await fetch('/api/mods/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: mod.id, downloadUrl: mod.downloadUrl })
            });
            if (!res.ok) throw new Error((await res.json()).error);
            // Re-open marketplace to refresh
            marketplaceOverlay.remove();
            _showMarketplaceModal();
          } catch (e) {
            updateBtn.textContent = 'Update failed';
            setTimeout(() => { updateBtn.textContent = `Update to v${mod.catalogVersion}`; updateBtn.disabled = false; }, 2000);
          }
        });
        footer.appendChild(updateBtn);
      }

      // Uninstall button
      const uninstallBtn = document.createElement('button');
      uninstallBtn.className = 'btn-uninstall';
      uninstallBtn.textContent = 'Uninstall';
      uninstallBtn.addEventListener('click', async () => {
        // Cascade-disable dependents, then disable mod itself
        if (enabledMods.has(mod.id)) {
          for (const depId of _getDependents(mod.id)) {
            const depMod = allMods.find(m => m.id === depId);
            enabledMods.delete(depId);
            if (depMod?.display === 'panel') {
              _unloadPanelMod(depId);
            } else {
              _removeToolbarButton(depId);
              if (activeViewId === depId) _hideMod();
            }
          }
          enabledMods.delete(mod.id);
          if (mod.display === 'panel') {
            _unloadPanelMod(mod.id);
          } else {
            _removeToolbarButton(mod.id);
            if (activeViewId === mod.id) _hideMod();
          }
          _saveEnabledMods();
        }
        uninstallBtn.disabled = true;
        uninstallBtn.textContent = 'Removing...';
        try {
          const res = await fetch('/api/mods/uninstall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mod.id })
          });
          if (!res.ok) throw new Error((await res.json()).error);
          marketplaceOverlay.remove();
          _showMarketplaceModal();
        } catch (e) {
          uninstallBtn.textContent = 'Failed';
          setTimeout(() => { uninstallBtn.textContent = 'Uninstall'; uninstallBtn.disabled = false; }, 2000);
        }
      });
      footer.appendChild(uninstallBtn);
    } else if (mod.downloadUrl) {
      // Install button
      const installBtn = document.createElement('button');
      installBtn.className = 'btn-install';
      installBtn.textContent = 'Install';
      if (mod.compatible === false) installBtn.disabled = true;
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.classList.add('loading');
        installBtn.textContent = 'Installing...';
        try {
          const res = await fetch('/api/mods/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mod.id, downloadUrl: mod.downloadUrl })
          });
          if (!res.ok) throw new Error((await res.json()).error);
          marketplaceOverlay.remove();
          _showMarketplaceModal();
        } catch (e) {
          installBtn.classList.remove('loading');
          installBtn.textContent = 'Install failed';
          setTimeout(() => { installBtn.textContent = 'Install'; installBtn.disabled = false; }, 2000);
        }
      });
      footer.appendChild(installBtn);
    }

    if (footer.children.length > 0) {
      card.appendChild(footer);
    }
  }

  return card;
}

/**
 * Show a settings modal for a mod.
 */
function _showSettingsModal(mod) {
  const settings = _loadModSettings(mod);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.width = '380px';

  let html = `<h2>${mod.name} Settings</h2>`;
  for (const s of mod.settings) {
    if (s.type === 'boolean') {
      html += `
        <div class="mod-setting-item">
          <input type="checkbox" class="mod-setting-toggle" data-key="${s.key}" ${settings[s.key] ? 'checked' : ''}>
          <div>
            <div class="mod-setting-label">${s.label}</div>
            ${s.description ? `<div class="mod-setting-desc">${s.description}</div>` : ''}
          </div>
        </div>
      `;
    } else if (s.type === 'number') {
      html += `
        <div class="mod-setting-item">
          <div style="flex:1">
            <div class="mod-setting-label">${s.label}</div>
            ${s.description ? `<div class="mod-setting-desc">${s.description}</div>` : ''}
            <input type="number" class="mod-setting-number" data-key="${s.key}" value="${settings[s.key] ?? s.default ?? 0}"
              style="margin-top:4px;width:100px;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;">
          </div>
        </div>
      `;
    }
  }
  html += `<div class="modal-buttons"><button class="btn-secondary" data-close>Close</button></div>`;
  modal.innerHTML = html;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Live-save on change
  modal.querySelectorAll('.mod-setting-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      _saveModSetting(mod.id, toggle.dataset.key, toggle.checked);
    });
  });
  modal.querySelectorAll('.mod-setting-number').forEach(input => {
    input.addEventListener('change', () => {
      const val = parseInt(input.value, 10);
      if (!isNaN(val)) _saveModSetting(mod.id, input.dataset.key, val);
    });
  });

  // Close modal
  const close = () => overlay.remove();
  modal.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

/**
 * Setup panel resizer drag handling.
 */
function _setupPanelResizer() {
  let isDragging = false;

  panelResizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Block ALL panel iframes from stealing mouse events during drag
    for (const [, entry] of panelMods) {
      entry.iframe.style.pointerEvents = 'none';
    }
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // Panel is on the right: width = viewport right edge - mouse X - panel tabs width
    const tabsWidth = panelTabsContainer.offsetWidth || 0;
    const newWidth = window.innerWidth - e.clientX - tabsWidth;
    panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(newWidth, window.innerWidth * 0.6));
    panelContainer.style.width = panelWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      for (const [, entry] of panelMods) {
        entry.iframe.style.pointerEvents = '';
      }
      localStorage.setItem(PANEL_STORAGE_KEY, panelWidth);
      window.dispatchEvent(new Event('resize'));
    }
  });
}

// ─── Panel tab management ────────────────────────────────────────────

/**
 * Create a panel tab button for a mod.
 */
function _createPanelTab(mod) {
  if (panelTabs.has(mod.id)) return;

  const btn = document.createElement('button');
  btn.className = 'panel-tab';
  btn.textContent = mod.toolbar?.label || mod.name;
  btn.title = mod.description || mod.name;
  btn.dataset.modId = mod.id;

  // Badge element for unread notifications
  const badge = document.createElement('span');
  badge.className = 'panel-tab-badge';
  btn.appendChild(badge);

  btn.addEventListener('click', () => {
    _togglePanelTab(mod.id);
  });

  panelTabsContainer.appendChild(btn);
  panelTabs.set(mod.id, btn);

  // Show the tabs strip if we have panel tabs
  if (panelTabs.size > 0) {
    panelTabsContainer.style.display = 'flex';
  }
}

/**
 * Remove a panel tab button.
 */
function _removePanelTab(modId) {
  const btn = panelTabs.get(modId);
  if (btn) {
    btn.remove();
    panelTabs.delete(modId);
  }

  // Hide tabs strip if no more panel tabs
  if (panelTabs.size === 0) {
    panelTabsContainer.style.display = 'none';
  }
}

/**
 * Toggle a panel tab: if it's already visible, collapse; otherwise switch to it.
 */
function _togglePanelTab(modId) {
  if (visiblePanelId === modId) {
    // Same tab clicked while visible → collapse
    _hidePanel();
  } else {
    // Different tab or panel collapsed → switch to it
    _switchToPanel(modId);
  }
}

/**
 * Switch the visible panel to a specific mod.
 */
function _switchToPanel(modId) {
  if (!panelMods.has(modId)) return;

  // Hide all panel iframes
  for (const [id, entry] of panelMods) {
    entry.iframe.style.display = id === modId ? '' : 'none';
  }

  visiblePanelId = modId;

  // Update tab active states
  for (const [id, btn] of panelTabs) {
    btn.classList.toggle('active', id === modId);
  }

  _showPanel();

  localStorage.setItem(ACTIVE_PANEL_KEY, modId);
}

// ─── Panel lifecycle ─────────────────────────────────────────────────

/**
 * Load a panel mod's iframe.
 * Called when mod is enabled. The iframe stays alive until the mod is disabled.
 */
function _loadPanelMod(mod) {
  // Already loaded
  if (panelMods.has(mod.id)) return;

  // Create panel iframe
  const entry = mod.entry || 'index.html';
  const iframeEl = document.createElement('iframe');
  iframeEl.src = `/mods/${mod.id}/${entry}`;
  iframeEl.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  if (mod.permissions?.length) {
    iframeEl.setAttribute('allow', mod.permissions.join('; '));
  }
  iframeEl.style.display = 'none'; // Hidden until switched to
  panelContainer.appendChild(iframeEl);
  iframeEl.addEventListener('load', () => {
    _injectBridgeAPI(iframeEl, mod.id);
  });

  panelMods.set(mod.id, { iframe: iframeEl, mod });

  // Create panel tab
  _createPanelTab(mod);
}

/**
 * Show the panel UI (container + resizer visible).
 */
function _showPanel() {
  if (!visiblePanelId) return;

  // Don't show panel/resizer if a fullscreen mod is active
  if (!modViewVisible) {
    panelContainer.style.display = 'block';
    panelContainer.style.width = panelWidth + 'px';
    panelResizer.style.display = 'block';
    document.getElementById('terminals').style.display = 'block';
  }

  localStorage.setItem(PANEL_VISIBLE_KEY, 'true');

  // Trigger resize so terminal refits to smaller width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Hide the panel UI but keep all iframes alive.
 */
function _hidePanel() {
  visiblePanelId = null;

  // Clear tab active states
  for (const [, btn] of panelTabs) {
    btn.classList.remove('active');
  }

  // Hide panel container + resizer
  panelContainer.style.display = 'none';
  panelResizer.style.display = 'none';

  localStorage.setItem(PANEL_VISIBLE_KEY, 'false');
  localStorage.removeItem(ACTIVE_PANEL_KEY);

  // Trigger resize so terminal refits to full width
  window.dispatchEvent(new Event('resize'));
}

/**
 * Fully unload a panel mod (destroy iframe, clear callbacks, remove tab).
 * Called when the mod is disabled.
 */
function _unloadPanelMod(modId) {
  const entry = panelMods.get(modId);
  if (!entry) return;

  // Remove iframe
  entry.iframe.remove();
  panelMods.delete(modId);

  // Remove tab
  _removePanelTab(modId);

  // Filter out callbacks for this mod
  taskCallbacks = taskCallbacks.filter(e => e.modId !== modId);
  agentChatCallbacks = agentChatCallbacks.filter(e => e.modId !== modId);
  browserEvalCallbacks = browserEvalCallbacks.filter(e => e.modId !== modId);
  browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e.modId !== modId);
  screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e.modId !== modId);
  sceneUpdateCallbacks = sceneUpdateCallbacks.filter(e => e.modId !== modId);
  sceneQueryCallbacks = sceneQueryCallbacks.filter(e => e.modId !== modId);
  sceneSnapshotCallbacks = sceneSnapshotCallbacks.filter(e => e.modId !== modId);
  babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e.modId !== modId);
  settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);

  // If it was the visible panel, switch to another or collapse
  if (visiblePanelId === modId) {
    const remaining = [...panelMods.keys()];
    if (remaining.length > 0) {
      _switchToPanel(remaining[0]);
    } else {
      visiblePanelId = null;
      panelContainer.style.display = 'none';
      panelResizer.style.display = 'none';
      localStorage.removeItem(PANEL_VISIBLE_KEY);
      localStorage.removeItem(ACTIVE_PANEL_KEY);
      window.dispatchEvent(new Event('resize'));
    }
  }
}

/**
 * Create a toolbar button for an enabled mod (left side, near wand).
 */
function _createToolbarButton(mod) {
  if (toolbarButtons.has(mod.id)) return;

  const label = mod.toolbar?.label || mod.name;
  const btn = document.createElement('button');
  btn.className = 'mod-toolbar-btn';
  btn.textContent = label;
  btn.title = mod.description || label;
  btn.dataset.modId = mod.id;

  btn.addEventListener('click', () => {
    if (activeViewId === mod.id) {
      _hideMod();
    } else {
      _showMod(mod);
    }
  });

  // Insert at top of #tabs, right after the layout toggle button
  const tabs = document.getElementById('tabs');
  const layoutToggle = document.getElementById('layout-toggle');
  tabs.insertBefore(btn, layoutToggle.nextSibling);

  // If this mod is currently the active view, mark it
  if (activeViewId === mod.id) {
    btn.classList.add('active');
  }

  toolbarButtons.set(mod.id, btn);
}

/**
 * Remove a toolbar button for a mod.
 */
function _removeToolbarButton(modId) {
  const btn = toolbarButtons.get(modId);
  if (btn) {
    btn.remove();
    toolbarButtons.delete(modId);
  }
}

/**
 * Show a mod's iframe view.
 */
function _showMod(mod) {
  // Tools-only mods have no entry point — nothing to show
  if (!mod.entry) return;

  const display = mod.display || 'fullscreen';

  // Panel mods are handled by panel tabs, not fullscreen view
  if (display === 'panel') {
    return;
  }

  // If a different mod is showing, clean up its iframe
  if (activeViewId && activeViewId !== mod.id) {
    _destroyIframe();
  }

  activeViewId = mod.id;
  localStorage.setItem(ACTIVE_VIEW_KEY, mod.id);

  // Update toolbar button states
  for (const [id, btn] of toolbarButtons) {
    btn.classList.toggle('active', id === mod.id);
  }

  // Create iframe if needed
  if (!iframe) {
    const entry = mod.entry || 'index.html';
    iframe = document.createElement('iframe');
    iframe.src = `/mods/${mod.id}/${entry}`;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    if (mod.permissions?.length) {
      iframe.setAttribute('allow', mod.permissions.join('; '));
    }
    modContainer.appendChild(iframe);
    iframe.addEventListener('load', () => {
      _injectBridgeAPI(iframe, mod.id);
    });
  }

  showModView();
}

/**
 * Hide the active mod view, return to terminals.
 */
function _hideMod() {
  const hiddenModId = activeViewId;
  activeViewId = null;
  localStorage.removeItem(ACTIVE_VIEW_KEY);
  sessionCallbacks = sessionCallbacks.filter(e => e.modId !== hiddenModId);
  activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== hiddenModId);
  if (hiddenModId) {
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== hiddenModId);
  }

  _destroyIframe();

  // Clear toolbar button states
  for (const [, btn] of toolbarButtons) {
    btn.classList.remove('active');
  }

  // Show content row, hide mod container and back button
  document.getElementById('content-row').style.display = '';
  modContainer.style.display = 'none';
  backBtn.style.display = 'none';
  modViewVisible = false;

  // Restore panel if it was logically visible while fullscreen mod was active
  if (visiblePanelId) {
    _showPanel();
  }
}

/**
 * Destroy the current iframe.
 */
function _destroyIframe() {
  if (iframe) {
    iframe.remove();
    iframe = null;
  }
}

/**
 * Show the mod view (hide terminals, show mod container).
 */
function showModView() {
  if (!activeViewId) return;
  document.getElementById('content-row').style.display = 'none';
  modContainer.style.display = 'flex';
  backBtn.style.display = 'none';
  modViewVisible = true;
}

/**
 * Switch from mod view to terminal view for a specific session.
 */
function showTerminalForSession(id) {
  modContainer.style.display = 'none';
  document.getElementById('content-row').style.display = '';
  modViewVisible = false;

  // Restore panel if it was logically visible
  if (visiblePanelId) {
    _showPanel();
  }

  // Show back button with mod name
  if (activeViewId) {
    const mod = allMods.find(m => m.id === activeViewId);
    backBtn.textContent = `\u2190 ${mod?.name || 'Back'}`;
    backBtn.style.display = '';
  }

  hooks.focusSession(id);
}

/**
 * Notify mods that the active session has changed.
 */
function notifyActiveSessionChanged(id) {
  for (const entry of activeSessionCallbacks) {
    try { entry.cb(id); } catch (e) { console.error('Active session callback error:', e); }
  }
}

/**
 * Notify mods that sessions have changed.
 */
function notifySessionsChanged(sessionList) {
  for (const entry of sessionCallbacks) {
    try { entry.cb(sessionList); } catch (e) { console.error('Mod callback error:', e); }
  }
}

/**
 * Notify panel mods that tasks have changed (called from app.js on WS broadcast).
 */
function notifyTasksChanged(tasks) {
  for (const entry of taskCallbacks) {
    try { entry.cb(tasks); } catch (e) { console.error('Task callback error:', e); }
  }
}

/**
 * Notify panel mods that agent chat has changed (called from app.js on WS broadcast).
 */
function notifyAgentChatChanged(channels) {
  for (const entry of agentChatCallbacks) {
    try { entry.cb(channels); } catch (e) { console.error('Agent chat callback error:', e); }
  }
}

/**
 * Notify panel mods of a browser-eval request (called from app.js on WS broadcast).
 */
function notifyBrowserEvalRequest(req) {
  for (const entry of browserEvalCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Browser eval callback error:', e); }
  }
}

/**
 * Notify panel mods of a browser-console request (called from app.js on WS broadcast).
 */
function notifyBrowserConsoleRequest(req) {
  for (const entry of browserConsoleCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Browser console callback error:', e); }
  }
}

/**
 * Notify panel mods of a screenshot-capture request (called from app.js on WS broadcast).
 */
function notifyScreenshotCaptureRequest(req) {
  for (const entry of screenshotCaptureCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Screenshot capture callback error:', e); }
  }
}

/**
 * Notify mods of a baby-browser request (called from app.js on WS broadcast).
 */
function notifyBabyBrowserRequest(req) {
  for (const entry of babyBrowserCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Baby browser callback error:', e); }
  }
}

/**
 * Notify panel mods of a scene-update request (called from app.js on WS broadcast).
 */
function notifySceneUpdateRequest(req) {
  for (const entry of sceneUpdateCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Scene update callback error:', e); }
  }
}

/**
 * Notify panel mods of a scene-query request (called from app.js on WS broadcast).
 */
function notifySceneQueryRequest(req) {
  for (const entry of sceneQueryCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Scene query callback error:', e); }
  }
}

/**
 * Notify panel mods of a scene-snapshot request (called from app.js on WS broadcast).
 */
function notifySceneSnapshotRequest(req) {
  for (const entry of sceneSnapshotCallbacks) {
    try { entry.cb(req); } catch (e) { console.error('Scene snapshot callback error:', e); }
  }
}

/**
 * Check if the mod view is currently visible.
 */
function isModViewVisible() {
  return modViewVisible;
}

/**
 * Check if a mod is currently active.
 */
function isModActive() {
  return activeViewId !== null;
}

/**
 * Inject the deepsteve bridge API into a mod iframe.
 * @param {HTMLIFrameElement} iframeEl - The iframe element
 * @param {string} modId - The mod ID that owns this iframe
 */
function _injectBridgeAPI(iframeEl, modId) {
  try {
    iframeEl.contentWindow.deepsteve = {
      getDeepsteveVersion() {
        return deepsteveVersion;
      },
      getSessions() {
        return hooks.getSessions();
      },
      focusSession(id) {
        showTerminalForSession(id);
      },
      onSessionsChanged(cb) {
        const entry = { modId, cb };
        sessionCallbacks.push(entry);
        try { cb(hooks.getSessions()); } catch {}
        return () => {
          sessionCallbacks = sessionCallbacks.filter(e => e !== entry);
        };
      },
      getActiveSessionId() {
        return getActiveSessionIdFn ? getActiveSessionIdFn() : null;
      },
      onActiveSessionChanged(cb) {
        const entry = { modId, cb };
        activeSessionCallbacks.push(entry);
        // Fire immediately with current value
        if (getActiveSessionIdFn) {
          try { cb(getActiveSessionIdFn()); } catch {}
        }
        return () => {
          activeSessionCallbacks = activeSessionCallbacks.filter(e => e !== entry);
        };
      },
      createSession(cwd, opts) {
        return hooks.createSession(cwd, opts);
      },
      killSession(id, opts) {
        hooks.killSession(id, opts);
      },
      getSettings() {
        const mod = allMods.find(m => m.id === modId);
        return mod ? _loadModSettings(mod) : {};
      },
      onSettingsChanged(cb) {
        const entry = { modId, cb };
        settingsCallbacks.push(entry);
        // Fire immediately with current values
        const mod = allMods.find(m => m.id === modId);
        if (mod) try { cb(_loadModSettings(mod)); } catch {}
        return () => {
          settingsCallbacks = settingsCallbacks.filter(e => e !== entry);
        };
      },
      onTasksChanged(cb) {
        const entry = { modId, cb };
        taskCallbacks.push(entry);
        // Fire immediately with current tasks from server
        fetch('/api/tasks').then(r => r.json()).then(data => {
          try { cb(data.tasks || []); } catch {}
        }).catch(() => {});
        return () => {
          taskCallbacks = taskCallbacks.filter(e => e !== entry);
        };
      },
      onAgentChatChanged(cb) {
        const entry = { modId, cb };
        agentChatCallbacks.push(entry);
        // Fire immediately with current data from server
        fetch('/api/agent-chat').then(r => r.json()).then(d => {
          try { cb(d.channels || {}); } catch {}
        }).catch(() => {});
        return () => {
          agentChatCallbacks = agentChatCallbacks.filter(e => e !== entry);
        };
      },
      onBrowserEvalRequest(cb) {
        const entry = { modId, cb };
        browserEvalCallbacks.push(entry);
        return () => {
          browserEvalCallbacks = browserEvalCallbacks.filter(e => e !== entry);
        };
      },
      onBrowserConsoleRequest(cb) {
        const entry = { modId, cb };
        browserConsoleCallbacks.push(entry);
        return () => {
          browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e !== entry);
        };
      },
      onScreenshotCaptureRequest(cb) {
        const entry = { modId, cb };
        screenshotCaptureCallbacks.push(entry);
        return () => {
          screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e !== entry);
        };
      },
      onSceneUpdateRequest(cb) {
        const entry = { modId, cb };
        sceneUpdateCallbacks.push(entry);
        return () => {
          sceneUpdateCallbacks = sceneUpdateCallbacks.filter(e => e !== entry);
        };
      },
      onSceneQueryRequest(cb) {
        const entry = { modId, cb };
        sceneQueryCallbacks.push(entry);
        return () => {
          sceneQueryCallbacks = sceneQueryCallbacks.filter(e => e !== entry);
        };
      },
      onSceneSnapshotRequest(cb) {
        const entry = { modId, cb };
        sceneSnapshotCallbacks.push(entry);
        return () => {
          sceneSnapshotCallbacks = sceneSnapshotCallbacks.filter(e => e !== entry);
        };
      },
      onBabyBrowserRequest(cb) {
        const entry = { modId, cb };
        babyBrowserCallbacks.push(entry);
        return () => {
          babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e !== entry);
        };
      },
      setPanelBadge(text) {
        const tab = panelTabs.get(modId);
        if (!tab) return;
        const badge = tab.querySelector('.panel-tab-badge');
        if (!badge) return;
        if (text) {
          badge.textContent = text;
          badge.classList.add('visible');
        } else {
          badge.textContent = '';
          badge.classList.remove('visible');
        }
      },
      updateSetting(key, value) {
        _saveModSetting(modId, key, value);
      },
    };
  } catch (e) {
    console.error('Failed to inject bridge API:', e);
  }
}

/**
 * Handle a mod-changed message from the server (file watcher detected changes).
 * Reloads the iframe if the changed mod is currently active.
 */
/**
 * Handle skills-changed broadcast from server (another tab toggled a skill).
 * Updates allMods enabled state and refreshes any open marketplace modal.
 */
function handleSkillsChanged(enabledSkills) {
  const enabledSet = new Set(enabledSkills || []);
  for (const mod of allMods) {
    if (mod.type === 'skill') {
      const skillId = mod.id.replace('skill:', '');
      mod.enabled = enabledSet.has(skillId);
    }
  }
  // Refresh skill toggles in open marketplace modal if present
  const overlay = document.querySelector('.modal-overlay:has(.marketplace-modal)');
  if (overlay) {
    for (const card of overlay.querySelectorAll('.mod-card[data-mod-id^="skill:"]')) {
      const cb = card.querySelector('.mod-card-toggle input[type="checkbox"]');
      const mod = allMods.find(m => m.id === card.dataset.modId);
      if (cb && mod) cb.checked = !!mod.enabled;
    }
  }
}

function handleModChanged(modId) {
  if (activeViewId === modId && iframe) {
    iframe.src = iframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
  const panelEntry = panelMods.get(modId);
  if (panelEntry) {
    // Clear stale callbacks for this mod before reload triggers re-injection
    taskCallbacks = taskCallbacks.filter(e => e.modId !== modId);
    agentChatCallbacks = agentChatCallbacks.filter(e => e.modId !== modId);
    browserEvalCallbacks = browserEvalCallbacks.filter(e => e.modId !== modId);
    browserConsoleCallbacks = browserConsoleCallbacks.filter(e => e.modId !== modId);
    screenshotCaptureCallbacks = screenshotCaptureCallbacks.filter(e => e.modId !== modId);
    babyBrowserCallbacks = babyBrowserCallbacks.filter(e => e.modId !== modId);
    settingsCallbacks = settingsCallbacks.filter(e => e.modId !== modId);
    sessionCallbacks = sessionCallbacks.filter(e => e.modId !== modId);
    activeSessionCallbacks = activeSessionCallbacks.filter(e => e.modId !== modId);

    panelEntry.iframe.src = panelEntry.iframe.src.replace(/(\?v=\d+)?$/, `?v=${Date.now()}`);
  }
}

/**
 * Focus a panel mod by switching to it (and showing the panel if collapsed).
 */
function focusPanel(modId) {
  _switchToPanel(modId);
}

/**
 * Get context menu items from enabled mods' manifests.
 * Returns [{ label, modId, action }] for mods that declare a contextMenu array.
 */
function getContextMenuItems() {
  const items = [];
  for (const mod of allMods) {
    if (!enabledMods.has(mod.id)) continue;
    if (!mod.contextMenu) continue;
    for (const entry of mod.contextMenu) {
      items.push({ label: entry.label, modId: mod.id, action: entry.action });
    }
  }
  return items;
}

/**
 * Get new-tab menu items from enabled tab-display mods.
 * Returns [{ modId, label, entry }].
 */
function getNewTabItems() {
  const items = [];
  for (const mod of allMods) {
    if (!enabledMods.has(mod.id)) continue;
    if (mod.display !== 'tab') continue;
    if (mod.compatible === false) continue;
    items.push({ modId: mod.id, label: mod.tabOption?.label || mod.name, entry: mod.entry });
  }
  return items;
}

export const ModManager = {
  init,
  loadAvailableMods,
  showModView,
  showTerminalForSession,
  notifySessionsChanged,
  notifyActiveSessionChanged,
  notifyTasksChanged,
  notifyAgentChatChanged,
  notifyBrowserEvalRequest,
  notifyBrowserConsoleRequest,
  notifyScreenshotCaptureRequest,
  notifySceneUpdateRequest,
  notifySceneQueryRequest,
  notifySceneSnapshotRequest,
  notifyBabyBrowserRequest,
  injectBridgeAPI: _injectBridgeAPI,
  isModViewVisible,
  isModActive,
  handleModChanged,
  handleSkillsChanged,
  focusPanel,
  getContextMenuItems,
  getNewTabItems,
};
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/session-store.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Session storage abstraction for multi-window support.
 *
 * Storage structure:
 * {
 *   windows: {
 *     "win-abc123": {
 *       sessions: [{id, cwd, name}, ...],
 *       lastActive: timestamp
 *     },
 *     ...
 *   },
 *   lastCwd: "/path/to/dir",
 *   alwaysUse: false
 * }
 */

import { nsKey } from './storage-namespace.js';

const STORAGE_KEY = nsKey('deepsteve');

function getStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function setStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const SessionStore = {
  /**
   * Get sessions for a specific window
   */
  getWindowSessions(windowId) {
    const storage = getStorage();
    return storage.windows?.[windowId]?.sessions || [];
  },

  /**
   * Add a session to a window
   */
  addSession(windowId, session) {
    const storage = getStorage();
    if (!storage.windows) storage.windows = {};
    if (!storage.windows[windowId]) {
      storage.windows[windowId] = { sessions: [], lastActive: Date.now() };
    }
    const sessions = storage.windows[windowId].sessions;
    if (!sessions.find(s => s.id === session.id)) {
      sessions.push(session);
    }
    storage.windows[windowId].lastActive = Date.now();
    setStorage(storage);
  },

  /**
   * Remove a session from a window
   */
  removeSession(windowId, sessionId) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      storage.windows[windowId].sessions = storage.windows[windowId].sessions.filter(
        s => s.id !== sessionId
      );
      // Clean up empty windows
      if (storage.windows[windowId].sessions.length === 0) {
        delete storage.windows[windowId];
      }
      setStorage(storage);
    }
  },

  /**
   * Update session data (e.g., name)
   */
  updateSession(windowId, sessionId, updates) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      const session = storage.windows[windowId].sessions.find(s => s.id === sessionId);
      if (session) {
        Object.assign(session, updates);
        setStorage(storage);
      }
    }
  },

  /**
   * Reorder sessions in a window to match the given ID order
   */
  reorderSessions(windowId, orderedIds) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      const sessions = storage.windows[windowId].sessions;
      const reordered = orderedIds.map(id => sessions.find(s => s.id === id)).filter(Boolean);
      storage.windows[windowId].sessions = reordered;
      setStorage(storage);
    }
  },

  /**
   * Move a session from one window to another
   */
  moveSession(fromWindowId, toWindowId, sessionId) {
    const storage = getStorage();
    const fromWindow = storage.windows?.[fromWindowId];
    if (!fromWindow) return;

    const sessionIndex = fromWindow.sessions.findIndex(s => s.id === sessionId);
    if (sessionIndex === -1) return;

    const [session] = fromWindow.sessions.splice(sessionIndex, 1);

    if (!storage.windows[toWindowId]) {
      storage.windows[toWindowId] = { sessions: [], lastActive: Date.now() };
    }
    storage.windows[toWindowId].sessions.push(session);
    storage.windows[toWindowId].lastActive = Date.now();

    // Clean up empty source window
    if (fromWindow.sessions.length === 0) {
      delete storage.windows[fromWindowId];
    }

    setStorage(storage);
  },

  /**
   * Get all windows
   */
  getAllWindows() {
    const storage = getStorage();
    return storage.windows || {};
  },

  /**
   * Remove a window entirely
   */
  removeWindow(windowId) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      delete storage.windows[windowId];
      setStorage(storage);
    }
  },

  /**
   * Update window's lastActive timestamp
   */
  touchWindow(windowId) {
    const storage = getStorage();
    if (storage.windows?.[windowId]) {
      storage.windows[windowId].lastActive = Date.now();
      setStorage(storage);
    }
  },

  /**
   * Get/set last used cwd
   */
  getLastCwd() {
    return getStorage().lastCwd;
  },

  setLastCwd(cwd) {
    const storage = getStorage();
    storage.lastCwd = cwd;
    setStorage(storage);
    // Also track in recentDirs
    this.addRecentDir(cwd);
  },

  /**
   * Recent directories (MRU-first, max 10)
   */
  getRecentDirs() {
    return getStorage().recentDirs || [];
  },

  addRecentDir(path) {
    if (!path || path === '~') return;
    const storage = getStorage();
    if (!storage.recentDirs) storage.recentDirs = [];
    // Remove existing entry (dedup) then prepend
    storage.recentDirs = storage.recentDirs.filter(d => d.path !== path);
    storage.recentDirs.unshift({ path, lastUsed: Date.now() });
    // Cap at 100
    if (storage.recentDirs.length > 100) storage.recentDirs.length = 100;
    setStorage(storage);
  },

  removeRecentDir(path) {
    const storage = getStorage();
    if (!storage.recentDirs) return;
    storage.recentDirs = storage.recentDirs.filter(d => d.path !== path);
    setStorage(storage);
  },

  /**
   * Get/set alwaysUse preference
   */
  getAlwaysUse() {
    return getStorage().alwaysUse || false;
  },

  setAlwaysUse(value) {
    const storage = getStorage();
    storage.alwaysUse = value;
    setStorage(storage);
  },

  /**
   * Migrate from old flat storage format to new window-based format
   */
  migrateFromLegacy() {
    const storage = getStorage();
    // Check if already migrated (has windows property)
    if (storage.windows !== undefined) return null;

    // Check for legacy sessions array
    if (storage.sessions && storage.sessions.length > 0) {
      // Return legacy sessions for migration
      const legacySessions = storage.sessions;
      // Clear old sessions array
      delete storage.sessions;
      storage.windows = {};
      setStorage(storage);
      return legacySessions;
    }

    // No legacy data, initialize empty windows
    if (!storage.windows) {
      storage.windows = {};
      setStorage(storage);
    }
    return null;
  }
};
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/storage-namespace.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Storage namespace isolation for recursive DeepSteve windows.
 *
 * When DeepSteve is opened inside its own Baby Browser proxy, the inner
 * instance shares the same origin and therefore the same sessionStorage,
 * localStorage, and BroadcastChannel namespace. We detect iframe nesting
 * depth and prefix all keys so each level gets its own isolated state.
 *
 * Depth 0 (top-level) uses no prefix — fully backward compatible.
 */

let recursionDepth = 0;
try {
  let w = window;
  while (w !== w.parent) {
    w = w.parent;
    recursionDepth++;
  }
} catch {
  // cross-origin parent — treat current depth as final
}

const prefix = recursionDepth > 0 ? `ds${recursionDepth}-` : '';

export function nsKey(key) {
  return prefix + key;
}

export function nsChannel(name) {
  return prefix + name;
}

export { recursionDepth };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/tab-manager.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Tab UI management for terminal tabs
 */

// Drag reorder state
const MOVE_THRESHOLD = 5;
let dragState = null;
let suppressNextClick = false;

let contextMenu = null;

function buildWindowLabel(win) {
  const names = win.sessions.map(s => s.name).filter(Boolean);
  if (names.length === 0) return win.windowId;
  if (names.length <= 3) return names.join(', ');
  return names.slice(0, 3).join(', ') + ` +${names.length - 3}`;
}

function showContextMenu(x, y, sessionId, callbacks) {
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'tab-context-menu';

  // Rename item
  const renameEl = document.createElement('div');
  renameEl.className = 'context-menu-item';
  renameEl.textContent = 'Rename';
  renameEl.onclick = () => {
    hideContextMenu();
    callbacks.onRename?.(sessionId);
  };
  menu.appendChild(renameEl);

  // Send to Window item with submenu
  const liveWindows = callbacks.getLiveWindows ? callbacks.getLiveWindows() : [];
  const sendEl = document.createElement('div');
  sendEl.className = 'context-menu-item';

  if (liveWindows.length === 0) {
    sendEl.classList.add('disabled');
    sendEl.textContent = 'Send to Window';
  } else {
    sendEl.classList.add('context-menu-has-submenu');
    sendEl.innerHTML = 'Send to Window <span class="context-menu-arrow"></span>';

    // Build submenu on mouseenter
    let submenu = null;
    sendEl.addEventListener('mouseenter', () => {
      if (submenu) return;
      submenu = document.createElement('div');
      submenu.className = 'context-menu context-submenu';

      for (const win of liveWindows) {
        const winEl = document.createElement('div');
        winEl.className = 'context-menu-item';
        winEl.textContent = buildWindowLabel(win);
        winEl.onclick = () => {
          hideContextMenu();
          callbacks.onSendToWindow?.(sessionId, win.windowId);
        };
        submenu.appendChild(winEl);
      }

      sendEl.appendChild(submenu);

      // Flip left if off-screen right
      const subRect = submenu.getBoundingClientRect();
      if (subRect.right > window.innerWidth) {
        submenu.style.left = 'auto';
        submenu.style.right = '100%';
        submenu.style.marginLeft = '0';
        submenu.style.marginRight = '2px';
      }
    });

    sendEl.addEventListener('mouseleave', () => {
      if (submenu) {
        submenu.remove();
        submenu = null;
      }
    });
  }
  menu.appendChild(sendEl);

  // Mod-provided context menu items
  const modItems = callbacks.getModMenuItems ? callbacks.getModMenuItems() : [];
  if (modItems.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'context-menu-separator';
    menu.appendChild(sep);
    for (const item of modItems) {
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.textContent = item.label;
      el.onclick = () => {
        hideContextMenu();
        item.onClick(sessionId);
      };
      menu.appendChild(el);
    }
  }

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  }

  contextMenu = menu;
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
  document.getElementById('tab-context-menu')?.remove();
}

// Hide context menu on click outside
document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tab')) hideContextMenu();
});

// Tab scroll arrow state
let arrowStart = null;
let arrowEnd = null;
let arrowsContainer = null;
let tabsList = null;

function isVertical() {
  return document.getElementById('app-container')?.classList.contains('vertical-layout');
}

function startDrag(tabEl, sessionId, callbacks) {
  const list = document.getElementById('tabs-list');
  const rect = tabEl.getBoundingClientRect();

  // Create floating clone that follows the cursor
  const ghost = tabEl.cloneNode(true);
  ghost.className = 'tab tab-drag-ghost';
  ghost.style.position = 'fixed';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.zIndex = '9999';
  ghost.style.pointerEvents = 'none';
  ghost.style.transition = 'none';
  document.body.appendChild(ghost);

  // Offset from cursor to tab origin
  dragState = {
    tabEl, sessionId, callbacks, ghost,
    offsetX: rect.left,
    offsetY: rect.top,
  };

  tabEl.classList.add('dragging');
  list.classList.add('tab-drag-active');
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchend', endDrag);
  document.addEventListener('visibilitychange', endDrag);
}

function onDragMove(e) {
  if (!dragState) return;
  e.preventDefault();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  // Move ghost to follow cursor
  const { ghost } = dragState;
  const vertical = isVertical();
  if (vertical) {
    ghost.style.top = (clientY - ghost.offsetHeight / 2) + 'px';
  } else {
    ghost.style.left = (clientX - ghost.offsetWidth / 2) + 'px';
  }

  // Reorder real tabs based on cursor position
  const list = document.getElementById('tabs-list');
  const tabs = [...list.children];

  for (const tab of tabs) {
    if (tab === dragState.tabEl) continue;
    const rect = tab.getBoundingClientRect();
    const mid = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    const pos = vertical ? clientY : clientX;

    if (pos < mid) {
      list.insertBefore(dragState.tabEl, tab);
      return;
    }
  }
  // Past all tabs — move to end
  list.appendChild(dragState.tabEl);
}

function endDrag() {
  if (!dragState) return;
  const { tabEl, callbacks, ghost } = dragState;

  ghost.remove();
  tabEl.classList.remove('dragging');
  const list = document.getElementById('tabs-list');
  list.classList.remove('tab-drag-active');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';

  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('touchmove', onDragMove);
  document.removeEventListener('mouseup', endDrag);
  document.removeEventListener('touchend', endDrag);
  document.removeEventListener('visibilitychange', endDrag);

  if (tabEl.parentNode) {
    const orderedIds = [...list.children].map(t => t.id.replace('tab-', ''));
    callbacks.onReorder?.(orderedIds);
  }

  suppressNextClick = true;
  setTimeout(() => { suppressNextClick = false; }, 0);
  dragState = null;
}

function updateTabArrows() {
  if (!tabsList || !arrowStart || !arrowEnd || !arrowsContainer) return;

  const vertical = isVertical();
  const scrollPos = vertical ? tabsList.scrollTop : tabsList.scrollLeft;
  const scrollSize = vertical ? tabsList.scrollHeight : tabsList.scrollWidth;
  const clientSize = vertical ? tabsList.clientHeight : tabsList.clientWidth;

  const hasOverflow = scrollSize > clientSize + 1; // 1px tolerance
  const atStart = scrollPos <= 1;
  const atEnd = scrollPos + clientSize >= scrollSize - 1;

  arrowsContainer.classList.toggle('visible', hasOverflow);
  arrowStart.classList.toggle('disabled', atStart);
  arrowEnd.classList.toggle('disabled', atEnd);
}

export function initTabArrows() {
  arrowStart = document.getElementById('tabs-arrow-start');
  arrowEnd = document.getElementById('tabs-arrow-end');
  arrowsContainer = document.getElementById('tabs-arrows');
  tabsList = document.getElementById('tabs-list');
  if (!arrowStart || !arrowEnd || !arrowsContainer || !tabsList) return;

  arrowStart.addEventListener('click', () => {
    if (arrowStart.classList.contains('disabled')) return;
    const amount = isVertical() ? { top: -150 } : { left: -150 };
    tabsList.scrollBy({ ...amount, behavior: 'smooth' });
  });

  arrowEnd.addEventListener('click', () => {
    if (arrowEnd.classList.contains('disabled')) return;
    const amount = isVertical() ? { top: 150 } : { left: 150 };
    tabsList.scrollBy({ ...amount, behavior: 'smooth' });
  });

  tabsList.addEventListener('scroll', updateTabArrows);
  window.addEventListener('resize', updateTabArrows);

  updateTabArrows();
}

export function getDefaultTabName(cwd) {
  if (!cwd) return 'shell';
  return cwd.split('/').filter(Boolean).pop() || 'root';
}

export const TabManager = {
  /**
   * Create a tab element for a session
   */
  createTab(sessionId, name, callbacks) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = 'tab-' + sessionId;
    tab.innerHTML = `
      <span class="badge"></span>
      <span class="tab-label">${name}</span>
      <span class="close">&#10005;</span>
    `;

    this._wireTabEvents(tab, sessionId, callbacks);
    return tab;
  },

  /**
   * Wire up event handlers (close, context menu, drag-to-reorder) on a tab element.
   * Used by both createTab() and addTab() (placeholder upgrade path).
   */
  _wireTabEvents(tab, sessionId, callbacks) {
    tab.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onClose?.(sessionId);
    });

    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, sessionId, callbacks);
    });

    // Drag to reorder — starts on move past threshold, click if no drag
    const onPointerDown = (e) => {
      // Ignore close button, right-click
      if (e.target.closest('.close')) return;
      if (e.button && e.button !== 0) return;

      const startX = e.touches ? e.touches[0].clientX : e.clientX;
      const startY = e.touches ? e.touches[0].clientY : e.clientY;
      let dragging = false;

      const onMove = (me) => {
        const cx = me.touches ? me.touches[0].clientX : me.clientX;
        const cy = me.touches ? me.touches[0].clientY : me.clientY;
        if (!dragging) {
          if (Math.abs(cx - startX) > MOVE_THRESHOLD || Math.abs(cy - startY) > MOVE_THRESHOLD) {
            dragging = true;
            startDrag(tab, sessionId, callbacks);
          }
        }
        // Once dragging, onDragMove handles the rest via its own listener
      };

      const onUp = () => {
        cleanup();
        if (!dragging) {
          // No drag happened — treat as click to switch
          callbacks.onSwitch?.(sessionId);
        }
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
    };

    tab.addEventListener('mousedown', onPointerDown);
    tab.addEventListener('touchstart', onPointerDown, { passive: true });
  },

  /**
   * Add a placeholder tab stub for instant visual feedback during restore.
   * Upgraded to a full tab when addTab() is called with the same sessionId.
   */
  addPlaceholderTab(sessionId, name) {
    const tab = document.createElement('div');
    tab.className = 'tab placeholder';
    tab.id = 'tab-' + sessionId;
    tab.innerHTML = `
      <span class="badge"></span>
      <span class="tab-label">${name}</span>
      <span class="close">&#10005;</span>
    `;
    document.getElementById('tabs-list').appendChild(tab);
    updateTabArrows();
    return tab;
  },

  /**
   * Add a tab to the tab bar. If a placeholder already exists for this
   * sessionId, upgrade it in-place instead of appending a new element.
   */
  addTab(sessionId, name, callbacks) {
    const existing = document.getElementById('tab-' + sessionId);
    if (existing && existing.classList.contains('placeholder')) {
      existing.classList.remove('placeholder');
      existing.querySelector('.tab-label').textContent = name;
      this._wireTabEvents(existing, sessionId, callbacks);
      existing.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateTabArrows();
      return existing;
    }
    const tab = this.createTab(sessionId, name, callbacks);
    document.getElementById('tabs-list').appendChild(tab);
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateTabArrows();
    return tab;
  },

  /**
   * Remove a tab from the tab bar
   */
  removeTab(sessionId) {
    document.getElementById('tab-' + sessionId)?.remove();
    updateTabArrows();
  },

  /**
   * Update tab label
   */
  updateLabel(sessionId, name) {
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) {
      tab.querySelector('.tab-label').textContent = name;
    }
  },

  /**
   * Set active tab
   */
  setActive(sessionId) {
    // Remove active from all tabs
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    // Add active to specified tab
    const tab = document.getElementById('tab-' + sessionId);
    if (tab) {
      tab.classList.add('active');
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  },

  /**
   * Get tab element
   */
  getTab(sessionId) {
    return document.getElementById('tab-' + sessionId);
  },

  /**
   * Update badge visibility on a tab
   */
  updateBadge(sessionId, visible) {
    const badge = document.querySelector('#tab-' + sessionId + ' .badge');
    if (badge) badge.classList.toggle('visible', visible);
  },

  /**
   * Prompt user to rename a tab
   */
  promptRename(sessionId, currentName, callback) {
    const newName = prompt('Rename tab:', currentName || '');
    if (newName !== null) {
      callback(newName.trim());
    }
  }
};
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/terminal.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Terminal setup and management using xterm.js
 */

function getTerminalBackground() {
  return getComputedStyle(document.documentElement).getPropertyValue('--ds-bg-primary').trim() || '#0d1117';
}

export function createTerminal(container) {
  const term = new Terminal({
    fontSize: 14,
    cursorBlink: false,  // Disable - Claude has its own cursor
    theme: { background: getTerminalBackground() }
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // Ensure terminal gets focus when clicked
  container.addEventListener('click', () => term.focus());

  return { term, fit };
}

/**
 * Update a terminal's background to match the current CSS variable.
 * Called after theme changes to apply the new color without recreating the terminal.
 */
export function updateTerminalTheme(term) {
  const bg = getTerminalBackground();
  term.options.theme = { ...term.options.theme, background: bg };
}

export function setupTerminalIO(term, ws, { onUserInput, container } = {}) {
  // Note: ws.onmessage is set in app.js to handle JSON control messages
  // and route terminal data here via term.write()

  // xterm.js attachCustomKeyEventHandler returns false to block Shift+Enter,
  // but onData still fires with \r. Use a flag to suppress the leaked \r.
  let suppressNextEnter = false;

  term.onData((data) => {
    if (suppressNextEnter && data === '\r') {
      suppressNextEnter = false;
      return;
    }
    suppressNextEnter = false;
    ws.send(data);
    if (onUserInput) onUserInput();
  });

  // Handle Shift+Enter for multi-line input
  term.attachCustomKeyEventHandler((event) => {
    if (event.shiftKey && event.key === 'Enter') {
      if (event.type === 'keydown') {
        // Send CSI u escape sequence for Shift+Enter (like iTerm2)
        ws.send('\x1b[13;2u');
        suppressNextEnter = true;
      }
      return false;
    }
    return true;
  });

  // Auto-scroll state machine.
  //
  // Three states:
  //   AUTO           — new output auto-scrolls to bottom
  //   USER_SCROLLED  — user scrolled up; output does NOT yank back
  //   SUPPRESSED     — transitions (tab switch, reconnect, init) ignore scroll events
  //
  // Transitions:
  //   AUTO → USER_SCROLLED  (scroll event detects gap > tolerance)
  //   USER_SCROLLED → AUTO  (scroll event detects gap ≤ tolerance, or scrollToBottom())
  //   * → SUPPRESSED        (suppressScroll())
  //   SUPPRESSED → AUTO     (scrollToBottom() or 500ms safety timeout)
  //
  // We listen on the .xterm-viewport `scroll` event instead of `wheel` + rAF.
  // The scroll event fires *after* the browser has updated scrollTop, so there
  // are no stale-position races with output or Ink re-renders.
  let state = 'AUTO';
  let suppressTimer = null;
  let prevScrollTop = 0;

  const BOTTOM_TOLERANCE = 10;
  const SNAP_TOLERANCE = 100; // ~5-6 lines — snap to bottom when user scrolls down near it

  // Floating scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-to-bottom';
  scrollBtn.textContent = '\u2193';
  scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
  if (container) container.appendChild(scrollBtn);

  function scrollToBottom() {
    state = 'AUTO';
    clearTimeout(suppressTimer);
    term.scrollToBottom();
    term.refresh(0, term.rows - 1);
    scrollBtn.classList.remove('visible');
    if (viewport) prevScrollTop = viewport.scrollTop;
    // After container visibility changes (tab switch), the viewport scroll
    // dimensions may not be recalculated yet. Force a deferred sync so the
    // scrollbar reflects the actual buffer height and the user can scroll.
    requestAnimationFrame(() => {
      term.scrollLines(0);
      if (viewport) prevScrollTop = viewport.scrollTop;
    });
  }

  function suppressScroll() {
    state = 'SUPPRESSED';
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      if (state === 'SUPPRESSED') state = 'AUTO';
    }, 500);
    if (viewport) prevScrollTop = viewport.scrollTop;
  }

  scrollBtn.addEventListener('click', () => {
    scrollToBottom();
    term.focus();
  });

  // Use the DOM viewport element for scroll position checks.
  // xterm renders .xterm-viewport as the scrollable container.
  const viewport = container?.querySelector('.xterm-viewport');

  if (viewport) {
    viewport.addEventListener('scroll', () => {
      if (state === 'SUPPRESSED') return;

      const scrollTop = viewport.scrollTop;
      const scrolledUp = scrollTop < prevScrollTop;
      prevScrollTop = scrollTop;

      const gap = viewport.scrollHeight - scrollTop - viewport.clientHeight;

      if (gap <= BOTTOM_TOLERANCE) {
        state = 'AUTO';
        scrollBtn.classList.remove('visible');
      } else if (scrolledUp) {
        state = 'USER_SCROLLED';
        scrollBtn.classList.add('visible');
      } else if (state === 'USER_SCROLLED' && gap <= SNAP_TOLERANCE) {
        scrollToBottom();
      } else if (state === 'AUTO' && gap > SNAP_TOLERANCE) {
        // User is far from bottom in AUTO state (e.g. after suppression ended
        // while scrolled up). Transition to USER_SCROLLED so button appears.
        // Uses SNAP_TOLERANCE (not BOTTOM_TOLERANCE) to avoid flicker during
        // rapid output where auto-scroll momentarily lags.
        state = 'USER_SCROLLED';
        scrollBtn.classList.add('visible');
      }
      // USER_SCROLLED + !scrolledUp + gap>SNAP → stay USER_SCROLLED (button already visible)
    }, { passive: true });
  }

  term.onWriteParsed(() => {
    if (state === 'AUTO') {
      term.scrollLines(0); // Force viewport sync — Ink repaints can desync viewport (#188)
      if (!viewport) { term.scrollToBottom(); return; }
      const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (gap > BOTTOM_TOLERANCE) {
        term.scrollToBottom();
      }
    }
  });

  return {
    scrollToBottom,
    suppressScroll,
    /** Re-sync viewport to bottom if user hasn't intentionally scrolled up. */
    nudgeToBottom() {
      if (state === 'AUTO') {
        if (!viewport) { term.scrollToBottom(); return; }
        const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (gap > BOTTOM_TOLERANCE) {
          term.scrollToBottom();
        }
      }
    },
    /** Force xterm viewport layout sync — call after Ink repaints or state transitions. */
    syncViewport() {
      term.scrollLines(0);
    }
  };
}

export function fitTerminal(term, fit, ws) {
  fit.fit();
  term.scrollLines(0); // Force viewport sync — eliminates RAF race with fit's internal viewport update
  ws.send(JSON.stringify({
    type: 'resize',
    cols: term.cols,
    rows: term.rows
  }));
}

/**
 * Create a ResizeObserver that auto-fits the terminal when its container changes size.
 * Handles window resize, layout toggle, mod panel open/close.
 * Tab switching is handled by switchTo() calling fitTerminal() directly.
 */
export function observeTerminalResize(container, term, fit, ws) {
  let debounceTimer = null;

  const observer = new ResizeObserver(() => {
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fit.fit();
      term.scrollLines(0); // Force viewport sync after resize
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }, 100);
  });

  observer.observe(container);
  return observer;
}

/**
 * Measure the cols/rows that would fit in the #terminals container
 * using a temporary hidden terminal. Returns {cols, rows} or defaults.
 */
export function measureTerminalSize() {
  const container = document.getElementById('terminals');
  if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
    return { cols: 120, rows: 40 };
  }

  // Create a temporary off-screen terminal to measure cell size
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  container.appendChild(tmp);

  const term = new Terminal({ fontSize: 14 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(tmp);

  const dims = fit.proposeDimensions();
  term.dispose();
  tmp.remove();

  if (dims && dims.cols > 0 && dims.rows > 0) {
    return { cols: dims.cols, rows: dims.rows };
  }
  return { cols: 120, rows: 40 };
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/window-manager.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Window manager for multi-browser-tab support.
 * Uses sessionStorage for tab-specific window ID and BroadcastChannel for cross-tab communication.
 */

import { SessionStore } from './session-store.js';
import { nsKey, nsChannel } from './storage-namespace.js';

const WINDOW_ID_KEY = nsKey('deepsteve-window-id');
const CHANNEL_NAME = nsChannel('deepsteve-windows');
const HEARTBEAT_INTERVAL = 5000;
const ORPHAN_DETECTION_TIMEOUT = 1500;
const LIVE_WINDOW_STALE_MS = 15000;
const SEND_SESSION_ACK_TIMEOUT = 2000;

let channel = null;
let heartbeatTimer = null;
let currentWindowId = null;
// Pending send-session acks: transferId → { resolve, reject, timer }
const pendingTransfers = new Map();
// Live window tracking — continuously updated from BroadcastChannel messages
// Key: windowId, Value: { windowId, sessions: [{id, name}], lastSeen }
const liveWindows = new Map();

// Callbacks set by app.js
let sessionsProvider = null;
let receiveSessionCallback = null;

function generateWindowId() {
  return 'win-' + Math.random().toString(36).substring(2, 10);
}

function pruneStaleWindows() {
  const now = Date.now();
  for (const [id, entry] of liveWindows) {
    if (now - entry.lastSeen > LIVE_WINDOW_STALE_MS) {
      liveWindows.delete(id);
    }
  }
}

export const WindowManager = {
  /**
   * Get or create this tab's window ID
   */
  getWindowId() {
    if (currentWindowId) return currentWindowId;

    // Check sessionStorage first (survives refresh)
    let windowId = sessionStorage.getItem(WINDOW_ID_KEY);
    if (!windowId) {
      windowId = generateWindowId();
      sessionStorage.setItem(WINDOW_ID_KEY, windowId);
    }
    currentWindowId = windowId;
    return windowId;
  },

  /**
   * Check if this tab already has a window ID (existing tab)
   */
  hasExistingWindowId() {
    return sessionStorage.getItem(WINDOW_ID_KEY) !== null;
  },

  /**
   * List windows that appear to be orphaned (no active browser tab)
   * Returns a promise that resolves after listening for heartbeats
   */
  async listOrphanedWindows() {
    const allWindows = SessionStore.getAllWindows();
    const windowIds = Object.keys(allWindows);

    if (windowIds.length === 0) return [];

    // Current window is not orphaned
    const myWindowId = this.getWindowId();

    // Collect active windows via broadcast
    const activeWindows = new Set();

    return new Promise((resolve) => {
      const tempChannel = new BroadcastChannel(CHANNEL_NAME);

      tempChannel.onmessage = (event) => {
        if (event.data.type === 'present' || event.data.type === 'heartbeat') {
          activeWindows.add(event.data.windowId);
        }
      };

      // Ask all windows to identify themselves
      tempChannel.postMessage({ type: 'roll-call' });

      // Wait for responses
      setTimeout(() => {
        tempChannel.close();

        // Filter out active windows and current window
        const orphaned = windowIds.filter(id =>
          id !== myWindowId && !activeWindows.has(id)
        );

        // Return window data with session info
        const orphanedWindows = orphaned.map(id => ({
          windowId: id,
          sessions: allWindows[id].sessions,
          lastActive: allWindows[id].lastActive
        }));

        // Sort by last active (most recent first)
        orphanedWindows.sort((a, b) => b.lastActive - a.lastActive);

        resolve(orphanedWindows);
      }, ORPHAN_DETECTION_TIMEOUT);
    });
  },

  /**
   * Claim an orphaned window's identity (take over its sessions)
   */
  claimWindow(orphanedWindowId) {
    const myWindowId = this.getWindowId();

    // Get a COPY of sessions before moving (moveSession modifies the array)
    const sessions = [...SessionStore.getWindowSessions(orphanedWindowId)];
    for (const session of sessions) {
      SessionStore.moveSession(orphanedWindowId, myWindowId, session.id);
    }

    return sessions;
  },

  /**
   * Start broadcasting presence to other tabs
   */
  startHeartbeat() {
    if (!channel) {
      channel = new BroadcastChannel(CHANNEL_NAME);

      channel.onmessage = (event) => {
        const { data } = event;
        const myId = this.getWindowId();

        if (data.type === 'roll-call') {
          // Respond to roll call with session metadata
          channel.postMessage({
            type: 'present',
            windowId: myId,
            sessions: sessionsProvider ? sessionsProvider() : []
          });
        } else if ((data.type === 'present' || data.type === 'heartbeat') && data.windowId !== myId) {
          // Track other live windows
          liveWindows.set(data.windowId, {
            windowId: data.windowId,
            sessions: data.sessions || [],
            lastSeen: Date.now()
          });
        } else if (data.type === 'closing' && data.windowId !== myId) {
          liveWindows.delete(data.windowId);
        } else if (data.type === 'send-session' && data.targetWindowId === myId) {
          // Another window is sending us a session
          if (receiveSessionCallback) {
            receiveSessionCallback(data.session);
          }
          // Ack back to sender so they know we received it
          channel.postMessage({
            type: 'send-session-ack',
            transferId: data.transferId,
            targetWindowId: data.fromWindowId
          });
        } else if (data.type === 'send-session-ack' && data.targetWindowId === myId) {
          const pending = pendingTransfers.get(data.transferId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingTransfers.delete(data.transferId);
            pending.resolve();
          }
        }
      };
    }

    const sendHeartbeat = () => {
      channel.postMessage({
        type: 'heartbeat',
        windowId: this.getWindowId(),
        sessions: sessionsProvider ? sessionsProvider() : []
      });
      pruneStaleWindows();
    };

    // Send initial heartbeat
    sendHeartbeat();

    // Schedule periodic heartbeats
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    // Handle page unload
    window.addEventListener('beforeunload', () => {
      channel.postMessage({ type: 'closing', windowId: this.getWindowId() });
    });

    // Send a roll-call to populate liveWindows immediately
    channel.postMessage({ type: 'roll-call' });
  },

  /**
   * Stop heartbeat (for testing or cleanup)
   */
  stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (channel) {
      channel.close();
      channel = null;
    }
  },

  /**
   * Release current window (mark as inactive without deleting sessions)
   */
  releaseWindow() {
    if (channel) {
      channel.postMessage({ type: 'closing', windowId: this.getWindowId() });
    }
    this.stopHeartbeat();
    currentWindowId = null;
    sessionStorage.removeItem(WINDOW_ID_KEY);
  },

  /**
   * Register a callback that returns current sessions as [{id, name}]
   */
  setSessionsProvider(fn) {
    sessionsProvider = fn;
  },

  /**
   * Get list of other live windows (excludes self, excludes stale).
   * Returns synchronously from cache.
   */
  getLiveWindows() {
    pruneStaleWindows();
    return [...liveWindows.values()];
  },

  /**
   * Send a session to another window via BroadcastChannel.
   * Returns a Promise that resolves when the target acks, or rejects on timeout.
   */
  sendSessionToWindow(targetWindowId, session) {
    if (!channel) return Promise.reject(new Error('No BroadcastChannel'));

    const transferId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTransfers.delete(transferId);
        reject(new Error('No ack from target window'));
      }, SEND_SESSION_ACK_TIMEOUT);

      pendingTransfers.set(transferId, { resolve, reject, timer });

      channel.postMessage({
        type: 'send-session',
        transferId,
        targetWindowId,
        session,
        fromWindowId: this.getWindowId()
      });
    });
  },

  /**
   * Register handler for incoming sessions from other windows
   */
  onSessionReceived(callback) {
    receiveSessionCallback = callback;
  }
};
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/window-restore-modal.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * Modal for restoring orphaned windows on startup
 */

import { getDefaultTabName } from './tab-manager.js';

export function showWindowRestoreModal(orphanedWindows) {
  return new Promise((resolve) => {
    let dismissed = false;
    const bc = new BroadcastChannel('deepsteve-windows');

    function dismiss(result) {
      if (dismissed) return;
      dismissed = true;
      bc.postMessage({ type: 'restore-modal-dismissed' });
      bc.close();
      overlay.remove();
      resolve(result);
    }

    bc.onmessage = (event) => {
      if (event.data.type === 'restore-modal-dismissed') {
        if (dismissed) return;
        dismissed = true;
        bc.close();
        overlay.remove();
        resolve({ action: 'fresh' });
      }
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const windowListHtml = orphanedWindows.map((win, index) => {
      const sessionsHtml = win.sessions.map(s =>
        `<span class="session-name">${s.name || getDefaultTabName(s.cwd)}</span>`
      ).join('');

      const lastActive = new Date(win.lastActive);
      const timeAgo = formatTimeAgo(lastActive);

      return `
        <div class="window-item" data-index="${index}">
          <div class="window-title">Window ${index + 1} (${win.sessions.length} session${win.sessions.length !== 1 ? 's' : ''})</div>
          <div class="window-sessions">${sessionsHtml}</div>
          <div class="window-sessions" style="margin-top: 4px;">Last active: ${timeAgo}</div>
        </div>
      `;
    }).join('');

    overlay.innerHTML = `
      <div class="modal">
        <h2>Restore Previous Sessions</h2>
        <p style="font-size: 13px; color: var(--ds-text-secondary); margin-bottom: 12px;">
          Found ${orphanedWindows.length} window${orphanedWindows.length !== 1 ? 's' : ''} from previous sessions. Select one to restore:
        </p>
        <div class="window-list">
          ${windowListHtml}
        </div>
        <div class="modal-buttons">
          <button class="btn-secondary" id="skip-btn">Start Fresh</button>
          <button class="btn-primary" id="restore-btn" disabled>Restore Selected</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let selectedIndex = null;

    overlay.querySelectorAll('.window-item').forEach(item => {
      item.onclick = () => {
        overlay.querySelectorAll('.window-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        selectedIndex = parseInt(item.dataset.index);
        overlay.querySelector('#restore-btn').disabled = false;
      };

      item.ondblclick = () => {
        selectedIndex = parseInt(item.dataset.index);
        dismiss({ action: 'restore', window: orphanedWindows[selectedIndex] });
      };
    });

    overlay.querySelector('#restore-btn').onclick = () => {
      if (selectedIndex !== null) {
        dismiss({ action: 'restore', window: orphanedWindows[selectedIndex] });
      }
    };

    overlay.querySelector('#skip-btn').onclick = () => {
      dismiss({ action: 'fresh' });
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        dismiss({ action: 'fresh' });
      }
    };
  });
}

function formatTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' minutes ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' hours ago';
  return Math.floor(seconds / 86400) + ' days ago';
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/public/js/ws-client.js" << 'DEEPSTEVE_FILE_EOF'
/**
 * WebSocket client wrapper with auto-reconnect
 */

export function createWebSocket(options = {}) {
  const params = new URLSearchParams();

  if (options.id) params.set('id', options.id);
  if (options.cwd) params.set('cwd', options.cwd);
  if (options.isNew) params.set('new', '1');
  if (options.worktree) params.set('worktree', options.worktree);
  if (options.cols) params.set('cols', options.cols);
  if (options.rows) params.set('rows', options.rows);
  if (options.name) params.set('name', options.name);
  if (options.planMode) params.set('planMode', '1');
  if (options.agentType && options.agentType !== 'claude') params.set('agentType', options.agentType);
  if (options.windowId) params.set('windowId', options.windowId);

  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let url = wsProto + location.host + '?' + params;
  let ws = new WebSocket(url);
  let reconnectTimer = null;
  let isReconnecting = false;

  const wrapper = {
    get readyState() { return ws.readyState; },

    send(data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },

    sendJSON(obj) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    },

    close() {
      clearInterval(reconnectTimer);
      ws.close();
    },

    // Called after server assigns a session ID — updates the reconnect URL
    // so future reconnections request the existing session instead of creating new ones.
    setSessionId(id) {
      const p = new URLSearchParams();
      p.set('id', id);
      if (options.cwd) p.set('cwd', options.cwd);
      if (options.cols) p.set('cols', options.cols);
      if (options.rows) p.set('rows', options.rows);
      if (options.agentType && options.agentType !== 'claude') p.set('agentType', options.agentType);
      if (options.windowId) p.set('windowId', options.windowId);
      url = wsProto + location.host + '?' + p;
    },

    // Event handlers - set by caller
    onmessage: null,
    onerror: null,
    onclose: null,
    onopen: null,
    onreconnecting: null,  // Called when reconnect starts
    onreconnected: null,   // Called when reconnect succeeds
  };

  function connect() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      if (isReconnecting) {
        isReconnecting = false;
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        if (wrapper.onreconnected) wrapper.onreconnected();
      }
      if (wrapper.onopen) wrapper.onopen();
    };

    ws.onmessage = (e) => {
      if (wrapper.onmessage) wrapper.onmessage(e);
    };

    ws.onerror = (e) => {
      if (wrapper.onerror) wrapper.onerror(e);
    };

    ws.onclose = (e) => {
      // Start reconnecting if not already
      if (!isReconnecting && !e.wasClean && !window.__deepsteveReloadPending) {
        isReconnecting = true;
        if (wrapper.onreconnecting) wrapper.onreconnecting();

        reconnectTimer = setInterval(() => {
          if (ws.readyState === WebSocket.CLOSED) {
            connect();
          }
        }, 1000);
      }

      if (wrapper.onclose) wrapper.onclose(e);
    };
  }

  // Initial connection setup
  ws.onopen = () => { if (wrapper.onopen) wrapper.onopen(); };
  ws.onmessage = (e) => { if (wrapper.onmessage) wrapper.onmessage(e); };
  ws.onerror = (e) => { if (wrapper.onerror) wrapper.onerror(e); };
  ws.onclose = (e) => {
    if (!isReconnecting && !e.wasClean && !window.__deepsteveReloadPending) {
      isReconnecting = true;
      if (wrapper.onreconnecting) wrapper.onreconnecting();

      reconnectTimer = setInterval(() => {
        if (ws.readyState === WebSocket.CLOSED) {
          connect();
        }
      }, 1000);
    }

    if (wrapper.onclose) wrapper.onclose(e);
  };

  return wrapper;
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/themes/retro-monitor.css" << 'DEEPSTEVE_FILE_EOF'
:root {
  --ds-bg-primary: #0a0a0a;
  --ds-bg-secondary: #2a2a2a;
  --ds-bg-tertiary: #3a3a3a;
  --ds-border: #555;
  --ds-text-primary: #d0d0d0;
  --ds-text-secondary: #999;
  --ds-text-bright: #fff;
}

/* Give tabs room to clear the rounded top corners */
#tabs {
  padding-top: 10px !important;
  padding-left: 16px !important;
  padding-right: 16px !important;
}

/* 90s CRT monitor bezel.
 *
 * Base CSS sets body to height:100vh, overflow:hidden, box-sizing:border-box.
 * Adding padding shrinks the content area. #app-container base has height:100vh
 * so we override to flex:1 to fill remaining space. All shadows must be inset
 * since body overflow:hidden clips anything outside. */
body {
  background: #c8c0b8 !important;
  display: flex !important;
  flex-direction: column !important;
  padding: 12px 25px 25px 25px;
}

#app-container {
  flex: 1 !important;
  min-height: 0 !important;
  height: auto !important;
  border-radius: 18px;
  overflow: clip;
  border: 4px solid #999;
  box-shadow:
    inset 0 0 0 2px #777,
    inset 0 0 8px rgba(0,0,0,0.3);
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/action-required/action-required.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useCallback, useRef, useMemo } = React;

// ─── Helpers ─────────────────────────────────────────────────────────

function formatWaitTime(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ─── Toggle Switch ──────────────────────────────────────────────────

function ToggleSwitch({ on, onToggle }) {
  return (
    <div
      onClick={onToggle}
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <div style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        background: on ? '#238636' : '#30363d',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
      }}>
        <div style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#f0f6fc',
          position: 'absolute',
          top: 3,
          left: on ? 23 : 3,
          transition: 'left 0.2s',
        }} />
      </div>
      <span style={{
        fontSize: 14,
        fontWeight: 600,
        color: on ? '#3fb950' : '#8b949e',
      }}>
        Auto-cycle {on ? 'ON' : 'OFF'}
      </span>
    </div>
  );
}

// ─── Queue Item ──────────────────────────────────────────────────────

function QueueItem({ session, waitingSince, isActive, onFocus }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = waitingSince ? Date.now() - waitingSince : 0;
  const urgency = elapsed > 60000 ? '#f85149' : elapsed > 30000 ? '#f0883e' : '#8b949e';

  return (
    <div
      onClick={() => onFocus(session.id)}
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        background: isActive ? 'rgba(88,166,255,0.08)' : 'transparent',
        borderLeft: isActive ? '2px solid #58a6ff' : '2px solid transparent',
      }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: '#f0883e',
        flexShrink: 0,
        animation: 'pulse 2s ease-in-out infinite',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: isActive ? 600 : 400,
          color: isActive ? '#f0f6fc' : '#c9d1d9',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {session.name}
        </div>
      </div>
      <span style={{ fontSize: 12, color: urgency, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {formatWaitTime(elapsed)}
      </span>
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────

function ActionRequiredPanel() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [settings, setSettings] = useState({ autoSwitch: true, switchDelay: 100 });

  // Refs for tracking state across callbacks
  const waitingSinceRef = useRef(new Map());    // sessionId → timestamp
  const activeIdRef = useRef(null);
  const settingsRef = useRef(settings);
  const autoSwitchTimerRef = useRef(null);
  const isAutoSwitchingRef = useRef(false);
  const pollIntervalRef = useRef(null);

  // Keep refs in sync
  useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Derive queue: sessions waiting for input, sorted by wait start time
  const queue = useMemo(() => {
    return sessions
      .filter(s => s.waitingForInput)
      .sort((a, b) => {
        const aTime = waitingSinceRef.current.get(a.id) || Infinity;
        const bTime = waitingSinceRef.current.get(b.id) || Infinity;
        return aTime - bTime;
      });
  }, [sessions]);

  // Helper: find next waiting session, excluding a given id
  function findNextWaiting(sessionList, excludeId) {
    return sessionList
      .filter(s => s.waitingForInput && s.id !== excludeId)
      .sort((a, b) => {
        const aTime = waitingSinceRef.current.get(a.id) || Infinity;
        const bTime = waitingSinceRef.current.get(b.id) || Infinity;
        return aTime - bTime;
      })[0] || null;
  }

  // Helper: schedule an auto-switch to a session
  function scheduleAutoSwitch(targetId) {
    if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
    const delay = Math.max(100, Math.min(500, settingsRef.current.switchDelay || 100));
    autoSwitchTimerRef.current = setTimeout(() => {
      autoSwitchTimerRef.current = null;
      isAutoSwitchingRef.current = true;
      window.deepsteve.focusSession(targetId);
    }, delay);
  }

  // ── Bridge: settings ──
  useEffect(() => {
    if (!window.deepsteve) return;
    return window.deepsteve.onSettingsChanged((s) => setSettings(s));
  }, []);

  // ── Bridge: active session changes ──
  useEffect(() => {
    if (!window.deepsteve) return;

    if (window.deepsteve.getActiveSessionId) {
      setActiveSessionId(window.deepsteve.getActiveSessionId());
    }

    if (window.deepsteve.onActiveSessionChanged) {
      return window.deepsteve.onActiveSessionChanged((id) => {
        // Auto-switch initiated by us — don't cancel
        if (isAutoSwitchingRef.current) {
          isAutoSwitchingRef.current = false;
          setActiveSessionId(id);
          return;
        }

        // Manual switch — cancel any pending auto-switch and turn off auto-cycle
        if (autoSwitchTimerRef.current) {
          clearTimeout(autoSwitchTimerRef.current);
          autoSwitchTimerRef.current = null;
        }

        if (settingsRef.current.autoSwitch) {
          if (window.deepsteve.updateSetting) {
            window.deepsteve.updateSetting('autoSwitch', false);
          }
        }

        setActiveSessionId(id);
      });
    }
  }, []);

  // ── Bridge: session changes (core auto-switch logic) ──
  useEffect(() => {
    if (!window.deepsteve) return;

    return window.deepsteve.onSessionsChanged((sessionList) => {
      const now = Date.now();
      const currentActiveId = activeIdRef.current;
      const currentSettings = settingsRef.current;

      // Track waitingSince timestamps
      for (const s of sessionList) {
        if (s.waitingForInput && !waitingSinceRef.current.has(s.id)) {
          waitingSinceRef.current.set(s.id, now);
        } else if (!s.waitingForInput && waitingSinceRef.current.has(s.id)) {
          waitingSinceRef.current.delete(s.id);
        }
      }

      // Clean up removed sessions
      const currentIds = new Set(sessionList.map(s => s.id));
      for (const id of waitingSinceRef.current.keys()) {
        if (!currentIds.has(id)) waitingSinceRef.current.delete(id);
      }

      // Auto-switch: if active session isn't waiting, switch to next waiting one
      if (currentSettings.autoSwitch) {
        const currActive = sessionList.find(s => s.id === currentActiveId);
        if (!currActive?.waitingForInput) {
          const next = findNextWaiting(sessionList, null);
          if (next && !autoSwitchTimerRef.current) {
            scheduleAutoSwitch(next.id);
          }
        }
      }

      setSessions(sessionList);
    });
  }, []);

  // Cancel timers on unmount
  useEffect(() => {
    return () => {
      if (autoSwitchTimerRef.current) clearTimeout(autoSwitchTimerRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Poll for waiting tabs independently of events
  useEffect(() => {
    if (settings.autoSwitch) {
      pollIntervalRef.current = setInterval(() => {
        const sessionList = window.deepsteve?.getSessions() || [];
        const currentActiveId = activeIdRef.current;
        const currActive = sessionList.find(s => s.id === currentActiveId);
        if (!currActive?.waitingForInput) {
          const next = findNextWaiting(sessionList, null);
          if (next && !autoSwitchTimerRef.current) {
            scheduleAutoSwitch(next.id);
          }
        }
      }, 10000);
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [settings.autoSwitch]);

  const handleToggle = useCallback(() => {
    const newValue = !settingsRef.current.autoSwitch;
    if (window.deepsteve?.updateSetting) {
      window.deepsteve.updateSetting('autoSwitch', newValue);
    }

    if (newValue) {
      // Toggling ON: immediately jump to first visible waiting tab
      const sessions = window.deepsteve?.getSessions() || [];
      const next = findNextWaiting(sessions, null);
      if (next) {
        isAutoSwitchingRef.current = true;
        window.deepsteve.focusSession(next.id);
      }
    } else {
      // Toggling OFF: cancel any pending auto-switch
      if (autoSwitchTimerRef.current) {
        clearTimeout(autoSwitchTimerRef.current);
        autoSwitchTimerRef.current = null;
      }
    }
  }, []);

  const handleFocus = useCallback((id) => {
    if (window.deepsteve) {
      window.deepsteve.focusSession(id);
    }
  }, []);

  // Queue depth visual intensity
  const queueDepth = queue.length;
  const borderColor = queueDepth === 0 ? 'transparent'
    : queueDepth <= 2 ? 'rgba(240,136,62,0.2)'
    : queueDepth <= 5 ? 'rgba(240,136,62,0.4)'
    : 'rgba(248,81,73,0.5)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes border-pulse {
          0%, 100% { border-color: ${borderColor}; }
          50% { border-color: transparent; }
        }
      `}</style>

      {/* Toggle */}
      <ToggleSwitch on={settings.autoSwitch} onToggle={handleToggle} />

      {/* Queue header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
          {queueDepth > 0 ? (
            <span>{queueDepth} tab{queueDepth !== 1 ? 's' : ''} waiting</span>
          ) : (
            'No tabs waiting'
          )}
        </div>
      </div>

      {/* Queue list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        borderLeft: queueDepth > 0 ? `2px solid ${borderColor}` : 'none',
        animation: queueDepth > 2 ? 'border-pulse 3s ease-in-out infinite' : 'none',
      }}>
        {queueDepth === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#484f58', fontSize: 13 }}>
            Tabs needing input will appear here
          </div>
        ) : (
          queue.map(session => (
            <QueueItem
              key={session.id}
              session={session}
              waitingSince={waitingSinceRef.current.get(session.id)}
              isActive={session.id === activeSessionId}
              onFocus={handleFocus}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Mount ───────────────────────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById('action-root'));
root.render(<ActionRequiredPanel />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/action-required/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #action-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="action-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="action-required.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/action-required/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Action Required",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Auto-cycle through tabs needing input — toggle on, keep pressing Enter",
  "enabledByDefault": true,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 320, "minWidth": 200 },
  "toolbar": { "label": "Action Required" },
  "settings": [
    { "key": "autoSwitch", "type": "boolean", "label": "Auto-cycle tabs", "description": "Automatically switch to next waiting tab after input is sent", "default": true },
    { "key": "switchDelay", "type": "number", "label": "Switch delay (ms)", "description": "Delay before auto-switching to next tab (100-500ms)", "default": 100 }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-chat/agent-chat.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useCallback, useRef } = React;

function formatTime(ts) {
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

// Deterministic color from sender name
function senderColor(name) {
  const colors = ['#58a6ff', '#f0883e', '#a5d6ff', '#7ee787', '#d2a8ff', '#f85149', '#79c0ff', '#ffa657'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function buildMentionPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@"${escaped}"|@${escaped}\\b`, 'i');
}

function renderMentions(text) {
  const parts = text.split(/(@"[^"]+"|@[\w-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@') && part.length > 1) {
      const quoted = part.startsWith('@"') && part.endsWith('"');
      const name = quoted ? part.slice(2, -1) : part.slice(1);
      const color = senderColor(name);
      return (
        <span key={i} style={{
          color,
          fontWeight: 600,
          background: `${color}18`,
          borderRadius: 3,
          padding: '0 3px',
        }}>
          @{name}
        </span>
      );
    }
    return part;
  });
}

function Message({ msg }) {
  const color = senderColor(msg.sender);
  return (
    <div style={{
      padding: '6px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color,
          padding: '1px 6px',
          borderRadius: 8,
          background: `${color}18`,
          border: `1px solid ${color}30`,
          whiteSpace: 'nowrap',
        }}>
          {msg.sender}
        </span>
        <span style={{ fontSize: 10, color: '#484f58' }}>
          {formatTime(msg.timestamp)}
        </span>
      </div>
      <div style={{
        fontSize: 13,
        color: '#c9d1d9',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.4,
      }}>
        {renderMentions(msg.text)}
      </div>
    </div>
  );
}

function notifyMention(msg, myName) {
  if (!myName || msg.sender === myName) return;
  if (!buildMentionPattern(myName).test(msg.text)) return;
  if (Notification.permission === 'granted' && document.hidden) {
    new Notification(`${msg.sender} mentioned you`, {
      body: msg.text.slice(0, 200),
      tag: `chat-mention-${msg.id}`,
    });
  }
}

// ─── TTS engine (module-level, outside React) ────────────────────────

let ttsQueue = [];
let ttsSpeaking = false;
let voiceCache = new Map();
let voicesLoaded = false;

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function senderVoice(name) {
  if (voiceCache.has(name)) return voiceCache.get(name);
  
  // Allowlist of natural-sounding macOS voices
  const allowedVoices = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Aman', 'Tara', 'Tessa', 'Reed', 'Sandy', 'Shelley'];
  const allEnglish = speechSynthesis.getVoices().filter(v => /en[-_]/i.test(v.lang));
  const voices = allEnglish.filter(v => allowedVoices.some(a => v.name.startsWith(a)));

  // Fall back to any English voice if no allowlisted voice is available
  if (voices.length === 0 && allEnglish.length === 0) return null;
  const pool = voices.length > 0 ? voices : allEnglish;
  const h = hashName(name);
  const voice = pool[h % pool.length];
  // Slightly narrower pitch range (0.9–1.2) for more natural sound
  const pitch = 0.9 + (((h >> 8) & 0xff) / 255) * 0.3;
  const rate = 0.95 + (((h >> 16) & 0xff) / 255) * 0.15; // 0.95–1.1
  const result = { voice, pitch, rate };
  voiceCache.set(name, result);
  return result;
}

function processQueue() {
  if (ttsSpeaking || ttsQueue.length === 0) return;
  ttsSpeaking = true;
  const msg = ttsQueue.shift();
  const text = msg.text.length > 500 ? msg.text.slice(0, 500) + '...' : msg.text;
  const utterance = new SpeechSynthesisUtterance(`${msg.sender} says: ${text}`);
  const voiceInfo = senderVoice(msg.sender);
  if (voiceInfo) {
    utterance.voice = voiceInfo.voice;
    utterance.pitch = voiceInfo.pitch;
    utterance.rate = voiceInfo.rate;
  }
  utterance.onend = () => { ttsSpeaking = false; processQueue(); };
  utterance.onerror = () => { ttsSpeaking = false; processQueue(); };
  speechSynthesis.speak(utterance);
}

function speakMessage(msg) {
  ttsQueue.push(msg);
  processQueue();
}

function cancelTts() {
  ttsQueue = [];
  ttsSpeaking = false;
  speechSynthesis.cancel();
}

// Load voices (async in Chrome)
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => {
    voicesLoaded = true;
    voiceCache.clear();
  };
  if (speechSynthesis.getVoices().length > 0) voicesLoaded = true;
}

// ─── STT feature detection ───────────────────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const sttSupported = !!SpeechRecognition;

// ─── SVG icons ───────────────────────────────────────────────────────

function SpeakerIcon({ active }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={active ? '#58a6ff' : '#8b949e'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {active && (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="1" width="6" height="12" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

// ─── ChatPanel ───────────────────────────────────────────────────────

function ChatPanel() {
  const [channels, setChannels] = useState({});
  const [activeChannel, setActiveChannel] = useState('general');
  const [input, setInput] = useState('');
  const [senderName, setSenderName] = useState(() => {
    try { return localStorage.getItem('deepsteve-chat-sender') || 'Human'; }
    catch { return 'Human'; }
  });
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [sttEnabled, setSttEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const messagesEndRef = useRef(null);
  const unreadMarkerRef = useRef(null);
  const prevMessageCountRef = useRef(0);
  const senderNameRef = useRef(senderName);
  const seenMessageIdsRef = useRef(new Set());
  const spokenMessageIdsRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);
  const ttsEnabledRef = useRef(false);
  const activeChannelRef = useRef(activeChannel);
  const recognitionRef = useRef(null);
  const lastReadIdRef = useRef((() => {
    try {
      const saved = localStorage.getItem('deepsteve-chat-last-read');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  })());
  const [unreadMarkers, setUnreadMarkers] = useState({});

  // Keep refs in sync
  useEffect(() => { senderNameRef.current = senderName; }, [senderName]);
  useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);

  // Persist sender name to localStorage
  useEffect(() => {
    try { localStorage.setItem('deepsteve-chat-sender', senderName); }
    catch {}
  }, [senderName]);

  // Cancel TTS when toggled off
  useEffect(() => {
    if (!ttsEnabled) cancelTts();
  }, [ttsEnabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelTts();
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
        recognitionRef.current = null;
      }
    };
  }, []);

  // Subscribe to settings changes from deepsteve bridge
  useEffect(() => {
    if (!window.deepsteve) return;
    return window.deepsteve.onSettingsChanged((s) => {
      setTtsEnabled(!!s.ttsEnabled);
      setSttEnabled(!!s.sttEnabled);
    });
  }, []);

  // Mark current channel as read + clear badge when tab regains focus
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        window.deepsteve?.setPanelBadge(null);
        markChannelRead(activeChannel);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeChannel]);

  function markChannelRead(ch) {
    const msgs = channels[ch]?.messages;
    if (!msgs || msgs.length === 0) return;
    const maxId = msgs[msgs.length - 1].id;
    if (lastReadIdRef.current[ch] === maxId) return;
    lastReadIdRef.current[ch] = maxId;
    setUnreadMarkers(prev => ({ ...prev, [ch]: undefined }));
    try { localStorage.setItem('deepsteve-chat-last-read', JSON.stringify(lastReadIdRef.current)); }
    catch {}
  }

  useEffect(() => {
    let unsub = null;

    function setup() {
      unsub = window.deepsteve.onAgentChatChanged((newChannels) => {
        // Check new messages for @mentions — fire browser notifications + panel badge
        let hasMention = false;
        for (const [chName, ch] of Object.entries(newChannels || {})) {
          const lastRead = lastReadIdRef.current[chName] || 0;
          for (const msg of (ch.messages || [])) {
            if (!seenMessageIdsRef.current.has(msg.id)) {
              seenMessageIdsRef.current.add(msg.id);
              if (msg.id > lastRead) {
                notifyMention(msg, senderNameRef.current);
                if (msg.sender !== senderNameRef.current) {
                  if (buildMentionPattern(senderNameRef.current).test(msg.text)) hasMention = true;
                }
              }
            }

            // TTS: speak new messages
            if (!spokenMessageIdsRef.current.has(msg.id)) {
              spokenMessageIdsRef.current.add(msg.id);
              if (initialLoadDoneRef.current && ttsEnabledRef.current && chName === activeChannelRef.current) {
                speakMessage(msg);
              }
            }
          }
        }

        // Mark initial load complete after first callback
        if (!initialLoadDoneRef.current) {
          initialLoadDoneRef.current = true;
        }

        if (hasMention && document.hidden) {
          window.deepsteve?.setPanelBadge('!');
        }
        // Compute unread divider positions per channel
        const newMarkers = {};
        for (const [ch, data] of Object.entries(newChannels || {})) {
          const lastRead = lastReadIdRef.current[ch] || 0;
          const msgs = data.messages || [];
          const firstUnread = msgs.find(m => m.id > lastRead);
          if (firstUnread) newMarkers[ch] = firstUnread.id;
        }
        setUnreadMarkers(newMarkers);
        setChannels(newChannels || {});
      });
    }

    if (window.deepsteve) {
      setup();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) {
          clearInterval(poll);
          setup();
        } else if (++attempts > 100) {
          clearInterval(poll);
        }
      }, 100);
    }

    return () => { if (unsub) unsub(); };
  }, []);

  // Auto-scroll when new messages arrive; mark channel read if visible
  useEffect(() => {
    const msgs = channels[activeChannel]?.messages || [];
    if (msgs.length > prevMessageCountRef.current) {
      const isInitialLoad = prevMessageCountRef.current === 0;
      if (isInitialLoad) {
        // Wait for DOM to paint before scrolling on initial load
        requestAnimationFrame(() => {
          if (unreadMarkerRef.current) {
            unreadMarkerRef.current.scrollIntoView({ behavior: 'instant' });
          } else {
            messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
          }
        });
      } else {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
      if (!document.hidden) {
        // Small delay so the divider flashes briefly before clearing
        setTimeout(() => markChannelRead(activeChannel), 1500);
      }
    }
    prevMessageCountRef.current = msgs.length;
  }, [channels, activeChannel]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    // Request notification permission on first send
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
    try {
      await fetch(`/api/agent-chat/${encodeURIComponent(activeChannel)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: senderName, text }),
      });
    } catch (e) {
      console.error('Failed to send message:', e);
    }
  }, [input, activeChannel, senderName]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const clearChannel = useCallback(async (channelName) => {
    try {
      await fetch(`/api/agent-chat/${encodeURIComponent(channelName)}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to clear channel:', e);
    }
  }, []);

  const toggleTts = useCallback(() => {
    if (window.deepsteve?.updateSetting) {
      window.deepsteve.updateSetting('ttsEnabled', !ttsEnabled);
    }
  }, [ttsEnabled]);

  // ─── STT (speech-to-text) ────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!sttSupported || recognitionRef.current) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') {
        console.error('STT error:', event.error);
      }
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  const channelNames = Object.keys(channels);
  if (channelNames.length === 0 && activeChannel === 'general') {
    // Show general even if empty
  }
  const displayChannels = channelNames.length > 0 ? channelNames : ['general'];
  const messages = channels[activeChannel]?.messages || [];

  const totalUnread = channelNames.reduce((sum, name) => {
    if (name === activeChannel) return sum;
    return sum + (channels[name]?.messages?.length || 0);
  }, 0);

  const showMicButton = sttEnabled && sttSupported;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 14,
          fontWeight: 600,
          color: '#f0f6fc',
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>
            Chat
            {messages.length > 0 && (
              <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                {messages.length} message{messages.length !== 1 ? 's' : ''}
              </span>
            )}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={toggleTts}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                display: 'flex',
                alignItems: 'center',
                opacity: ttsEnabled ? 1 : 0.5,
              }}
              onMouseEnter={e => { if (!ttsEnabled) e.currentTarget.style.opacity = 0.8; }}
              onMouseLeave={e => { if (!ttsEnabled) e.currentTarget.style.opacity = 0.5; }}
              title={ttsEnabled ? 'Disable text-to-speech' : 'Enable text-to-speech'}
            >
              <SpeakerIcon active={ttsEnabled} />
            </button>
            {messages.length > 0 && (
              <button
                onClick={() => clearChannel(activeChannel)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#8b949e',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '2px 6px',
                  opacity: 0.6,
                }}
                onMouseEnter={e => e.target.style.opacity = 1}
                onMouseLeave={e => e.target.style.opacity = 0.6}
                title={`Clear #${activeChannel}`}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Channel selector */}
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {displayChannels.map(name => {
            const count = channels[name]?.messages?.length || 0;
            const isActive = name === activeChannel;
            return (
              <button
                key={name}
                onClick={() => {
                  if (!document.hidden) markChannelRead(name);
                  setActiveChannel(name);
                }}
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: isActive ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                  color: isActive ? '#fff' : '#8b949e',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                #{name}
                {count > 0 && !isActive && (
                  <span style={{
                    fontSize: 9,
                    background: 'rgba(255,255,255,0.12)',
                    padding: '0 4px',
                    borderRadius: 6,
                  }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {messages.length === 0 ? (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            No messages in #{activeChannel} yet.
            <br />
            <span style={{ fontSize: 11 }}>Agents can send messages via the send_message MCP tool.</span>
          </div>
        ) : (
          messages.map(msg => (
            <React.Fragment key={msg.id}>
              {unreadMarkers[activeChannel] === msg.id && (
                <div ref={unreadMarkerRef} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 12px',
                }}>
                  <div style={{ flex: 1, height: 1, background: '#f85149' }} />
                  <span style={{ fontSize: 10, color: '#f85149', fontWeight: 600, whiteSpace: 'nowrap' }}>NEW</span>
                  <div style={{ flex: 1, height: 1, background: '#f85149' }} />
                </div>
              )}
              <Message msg={msg} />
            </React.Fragment>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: 8,
        borderTop: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            type="text"
            value={senderName}
            onChange={e => setSenderName(e.target.value)}
            placeholder="Your name"
            style={{
              width: 80,
              padding: '4px 8px',
              fontSize: 11,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              color: '#c9d1d9',
            }}
          />
          <span style={{ fontSize: 10, color: '#484f58', lineHeight: '24px' }}>
            in #{activeChannel}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? 'Listening...' : 'Type a message...'}
            rows={1}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 12,
              background: '#0d1117',
              border: isListening ? '1px solid #f85149' : '1px solid #30363d',
              borderRadius: 6,
              color: '#c9d1d9',
              resize: 'none',
              outline: 'none',
              fontFamily: 'system-ui',
              ...(isListening ? { animation: 'listening-pulse 1.5s ease-in-out infinite' } : {}),
            }}
          />
          {showMicButton && (
            <button
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onMouseLeave={() => { if (isListening) stopListening(); }}
              onTouchStart={(e) => { e.preventDefault(); startListening(); }}
              onTouchEnd={(e) => { e.preventDefault(); stopListening(); }}
              style={{
                padding: '6px 8px',
                fontSize: 12,
                background: isListening ? 'rgba(248, 81, 73, 0.2)' : 'rgba(255,255,255,0.06)',
                border: isListening ? '1px solid #f85149' : '1px solid #30363d',
                borderRadius: 6,
                color: isListening ? '#f85149' : '#8b949e',
                cursor: 'pointer',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
              }}
              title="Hold to speak"
            >
              <MicIcon />
            </button>
          )}
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              background: input.trim() ? '#238636' : 'rgba(255,255,255,0.06)',
              border: 'none',
              borderRadius: 6,
              color: input.trim() ? '#fff' : '#484f58',
              cursor: input.trim() ? 'pointer' : 'default',
              flexShrink: 0,
            }}
          >
            Send
          </button>
        </div>
      </div>

      {/* CSS animation for listening pulse */}
      <style>{`
        @keyframes listening-pulse {
          0%, 100% { border-color: #f85149; }
          50% { border-color: #f8514940; }
        }
      `}</style>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('chat-root'));
root.render(<ChatPanel />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-chat/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #chat-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="chat-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="agent-chat.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-chat/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Agent Chat",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Shared message bus for agent-to-agent communication",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 360, "minWidth": 200 },
  "toolbar": { "label": "Chat" },
  "tools": [
    { "name": "send_message", "description": "Send a message to a chat channel" },
    { "name": "read_messages", "description": "Read messages from a chat channel" },
    { "name": "list_channels", "description": "List available chat channels" }
  ],
  "permissions": ["microphone"],
  "settings": [
    {
      "key": "ttsEnabled",
      "type": "boolean",
      "label": "Text-to-speech",
      "description": "Read new messages aloud with distinct per-sender voices",
      "default": false
    },
    {
      "key": "sttEnabled",
      "type": "boolean",
      "label": "Speech-to-text",
      "description": "Hold mic button to dictate messages instead of typing",
      "default": false
    }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-chat/tools.js" << 'DEEPSTEVE_FILE_EOF'
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
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-dna/agent-dna.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useCallback } = React;

const APPROACH_PRESETS = ['cautious', 'bold', 'thorough', 'creative', 'methodical', 'move-fast'];
const TRAIT_PRESETS = ['questioning', 'concise', 'verbose', 'experimental', 'defensive', 'pragmatic', 'perfectionist', 'collaborative'];

function Chip({ label, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 11,
        border: '1px solid',
        borderColor: selected ? '#58a6ff' : '#30363d',
        borderRadius: 12,
        cursor: 'pointer',
        background: selected ? 'rgba(88,166,255,0.15)' : 'rgba(255,255,255,0.04)',
        color: selected ? '#58a6ff' : '#8b949e',
        transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  );
}

function AgentDnaPanel() {
  const [sessionId, setSessionId] = useState(null);
  const [sessionName, setSessionName] = useState(null);
  const [approach, setApproach] = useState('');
  const [traits, setTraits] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const fetchDna = useCallback(async (sid) => {
    if (!sid) return;
    try {
      const res = await fetch(`/api/agent-dna/${sid}`);
      const { dna } = await res.json();
      setApproach(dna.approach || '');
      setTraits(dna.traits || []);
      setDirty(false);
    } catch (e) {
      console.error('Failed to fetch DNA:', e);
    }
  }, []);

  useEffect(() => {
    let unsub = null;

    function setup() {
      unsub = window.deepsteve.onActiveSessionChanged((id) => {
        if (id) {
          setSessionId(id);
          const sessions = window.deepsteve.getSessions();
          const match = sessions.find(s => s.id === id);
          setSessionName(match?.name || id);
          fetchDna(id);
        } else {
          setSessionId(null);
          setSessionName(null);
          setApproach('');
          setTraits([]);
          setDirty(false);
        }
      });
    }

    if (window.deepsteve) {
      setup();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) {
          clearInterval(poll);
          setup();
        } else if (++attempts > 100) {
          clearInterval(poll);
        }
      }, 100);
    }

    return () => { if (unsub) unsub(); };
  }, [fetchDna]);

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    setSaving(true);
    try {
      await fetch(`/api/agent-dna/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approach: approach || undefined, traits: traits.length ? traits : undefined }),
      });
      setDirty(false);
    } catch (e) {
      console.error('Failed to save DNA:', e);
    }
    setSaving(false);
  }, [sessionId, approach, traits]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`/api/agent-dna/${sessionId}`, { method: 'DELETE' });
      setApproach('');
      setTraits([]);
      setDirty(false);
    } catch (e) {
      console.error('Failed to clear DNA:', e);
    }
  }, [sessionId]);

  const toggleTrait = useCallback((trait) => {
    setTraits(prev => {
      const next = prev.includes(trait) ? prev.filter(t => t !== trait) : [...prev, trait];
      setDirty(true);
      return next;
    });
  }, []);

  const selectApproach = useCallback((value) => {
    setApproach(prev => {
      const next = prev === value ? '' : value;
      setDirty(true);
      return next;
    });
  }, []);

  if (!sessionId) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#8b949e', fontSize: 13 }}>
        No session selected. Click a tab to configure its agent DNA.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>
          Agent DNA
        </div>
        <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
          {sessionName} <span style={{ opacity: 0.5 }}>({sessionId})</span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* Approach */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
            Approach
          </label>
          <input
            type="text"
            value={approach}
            onChange={(e) => { setApproach(e.target.value); setDirty(true); }}
            placeholder="e.g. cautious, move-fast"
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 6,
              color: '#c9d1d9',
              outline: 'none',
              marginBottom: 6,
            }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {APPROACH_PRESETS.map(a => (
              <Chip
                key={a}
                label={a}
                selected={approach === a}
                onClick={() => selectApproach(a)}
              />
            ))}
          </div>
        </div>

        {/* Traits */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
            Traits
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {TRAIT_PRESETS.map(t => (
              <Chip
                key={t}
                label={t}
                selected={traits.includes(t)}
                onClick={() => toggleTrait(t)}
              />
            ))}
          </div>
          {traits.filter(t => !TRAIT_PRESETS.includes(t)).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {traits.filter(t => !TRAIT_PRESETS.includes(t)).map(t => (
                <Chip key={t} label={t} selected={true} onClick={() => toggleTrait(t)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        gap: 8,
        flexShrink: 0,
      }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            flex: 1,
            padding: '6px 12px',
            fontSize: 12,
            border: 'none',
            borderRadius: 6,
            cursor: dirty ? 'pointer' : 'default',
            background: dirty ? '#238636' : 'rgba(255,255,255,0.06)',
            color: dirty ? '#fff' : '#8b949e',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleClear}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            border: '1px solid #30363d',
            borderRadius: 6,
            cursor: 'pointer',
            background: 'transparent',
            color: '#8b949e',
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('dna-root'));
root.render(<AgentDnaPanel />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-dna/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #dna-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="dna-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="agent-dna.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-dna/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Agent DNA",
  "version": "0.1.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Configurable personality traits for agent sessions",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 320, "minWidth": 200 },
  "toolbar": { "label": "DNA" },
  "tools": [
    { "name": "get_agent_dna", "description": "Get agent DNA personality config for a session" },
    { "name": "set_agent_dna", "description": "Set agent DNA personality config for a session" }
  ],
  "contextMenu": [
    { "label": "Agent DNA...", "action": "focus-panel" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-dna/tools.js" << 'DEEPSTEVE_FILE_EOF'
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
        session_id: z.string().describe('The deepsteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
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
        session_id: z.string().describe('The deepsteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
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
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-game/agent-game.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const NAME_BANKS = {
  easy: [
    'Penguin', 'Dolphin', 'Eagle', 'Elephant', 'Octopus', 'Fox', 'Owl', 'Tiger', 'Whale', 'Chameleon',
    'Giraffe', 'Panda', 'Koala', 'Flamingo', 'Hedgehog', 'Otter', 'Parrot', 'Jellyfish', 'Sloth', 'Raccoon',
    'Peacock', 'Seahorse', 'Armadillo', 'Platypus', 'Narwhal', 'Axolotl', 'Capybara', 'Cheetah', 'Gorilla', 'Jaguar',
    'Kangaroo', 'Lemur', 'Lynx', 'Manatee', 'Moose', 'Ostrich', 'Porcupine', 'Quokka', 'Raven', 'Salamander',
    'Tapir', 'Toucan', 'Vulture', 'Walrus', 'Wolverine', 'Yak', 'Zebra', 'Albatross', 'Bison', 'Cobra',
    'Dragonfly', 'Falcon', 'Gazelle', 'Hummingbird', 'Iguana', 'Jackrabbit', 'Kiwi', 'Lobster', 'Mantis', 'Newt',
    'Ocelot', 'Pelican', 'Quail', 'Rhinoceros', 'Stingray', 'Tarantula', 'Urchin', 'Viper', 'Wombat', 'Xerus',
    'Badger', 'Coyote', 'Dugong', 'Ermine', 'Ferret',
  ],
  medium: [
    'Sherlock Holmes', 'Gandalf', 'Darth Vader', 'Hermione Granger', 'Pikachu', 'Batman', 'Frodo', 'Yoda', 'James Bond', 'Princess Leia',
    'Harry Potter', 'Katniss Everdeen', 'Spider-Man', 'Wonder Woman', 'Captain Jack Sparrow', 'Gollum', 'The Joker', 'Elsa', 'Shrek', 'Mario',
    'Indiana Jones', 'Wolverine', 'Daenerys Targaryen', 'Luke Skywalker', 'Iron Man', 'Dumbledore', 'Rapunzel', 'The Doctor', 'Legolas', 'Catwoman',
    'Sonic the Hedgehog', 'Lara Croft', 'Optimus Prime', 'Mulan', 'Captain America', 'Aragorn', 'Simba', 'Loki', 'Merlin', 'Neo',
    'Zelda', 'Buzz Lightyear', 'Dracula', 'Robin Hood', 'Willy Wonka', 'Morpheus', 'Groot', 'Arya Stark', 'Jack Skellington', 'Megamind',
    'Zorro', 'Pocahontas', 'Thanos', 'Aladdin', 'Maleficent', 'Thor', 'Black Panther', 'Tinker Bell', 'Sauron', 'Han Solo',
    'Peter Pan', 'Cruella de Vil', 'Link', 'Deadpool', 'Mary Poppins', 'Bilbo Baggins', 'Cinderella', 'Darth Maul', 'Obi-Wan Kenobi', 'Scooby-Doo',
    'The Grinch', 'Dorothy Gale', 'Pinocchio', 'Tarzan', 'Ratatouille',
  ],
  hard: [
    'Socrates', 'Aristotle', 'Nietzsche', 'Descartes', 'Confucius', 'Kant', 'Plato', 'Simone de Beauvoir', 'Hypatia', 'Diogenes',
    'Hegel', 'Kierkegaard', 'Spinoza', 'Leibniz', 'Hume', 'Locke', 'Hobbes', 'Rousseau', 'Voltaire', 'Wittgenstein',
    'Heidegger', 'Sartre', 'Camus', 'Foucault', 'Derrida', 'Marx', 'Mill', 'Bentham', 'Epicurus', 'Seneca',
    'Marcus Aurelius', 'Zeno of Citium', 'Parmenides', 'Heraclitus', 'Democritus', 'Pythagoras', 'Empedocles', 'Anaxagoras', 'Thales', 'Anaximander',
    'Augustine', 'Aquinas', 'Machiavelli', 'Bacon', 'Montaigne', 'Pascal', 'Berkeley', 'Schopenhauer', 'Emerson', 'Thoreau',
    'William James', 'Dewey', 'Husserl', 'Arendt', 'Popper', 'Kuhn', 'Rawls', 'Nozick', 'Judith Butler', 'Slavoj Zizek',
    'Bertrand Russell', 'Frege', 'Quine', 'Rorty', 'Deleuze', 'Adorno', 'Habermas', 'Levinas', 'Merleau-Ponty', 'Gadamer',
    'Al-Farabi', 'Avicenna', 'Averroes', 'Maimonides', 'Nagarjuna',
  ],
  nightmare: [
    'Entropy', 'Grace', 'Nostalgia', 'Silence', 'Gravity', 'Time', 'Paradox', 'Symmetry', 'Irony', 'Serendipity',
    'Consciousness', 'Infinity', 'Chaos', 'Harmony', 'Melancholy', 'Ambiguity', 'Resonance', 'Ephemeral', 'Sublime', 'Absurdity',
    'Oblivion', 'Emergence', 'Duality', 'Solitude', 'Belonging', 'Transcendence', 'Whimsy', 'Dissonance', 'Luminance', 'Recursion',
    'Inertia', 'Impermanence', 'Liminal', 'Aporia', 'Dialectic', 'Simulacrum', 'Abyss', 'Void', 'Threshold', 'Reverie',
    'Vertigo', 'Metamorphosis', 'Equilibrium', 'Tension', 'Fragility', 'Opacity', 'Dissolution', 'Confluence', 'Caesura', 'Apathy',
    'Euphoria', 'Ennui', 'Zeitgeist', 'Angst', 'Wanderlust', 'Pathos', 'Ethos', 'Hubris', 'Nemesis', 'Catharsis',
    'Sonder', 'Hiraeth', 'Fernweh', 'Kenopsia', 'Jouissance', 'Dasein', 'Qualia', 'Gestalt', 'Umwelt', 'Ataraxia',
    'Saudade', 'Wabi-Sabi', 'Mono no Aware', 'Ubuntu', 'Meraki',
  ],
};

const TIERS = [
  { id: 'easy', label: 'Easy', icon: '\u{1F43E}', desc: 'Animals', multiplier: 1, color: '#7ee787', hint: 'Be obvious. Use direct physical descriptions and well-known traits.' },
  { id: 'medium', label: 'Medium', icon: '\u{1F4D6}', desc: 'Fictional Characters', multiplier: 2, color: '#58a6ff', hint: 'Give moderate hints. Use catchphrases, plot references, and personality traits.' },
  { id: 'hard', label: 'Hard', icon: '\u{1F3DB}', desc: 'Philosophers', multiplier: 3, color: '#ffa657', hint: 'Be subtle. Use philosophical references, quotes, and intellectual parallels.' },
  { id: 'nightmare', label: 'Nightmare', icon: '\u{1F300}', desc: 'Abstract Concepts', multiplier: 5, color: '#f85149', hint: 'Be extremely cryptic. Use abstract metaphors and tangential associations only.' },
  { id: 'custom', label: 'Custom', icon: '\u270F', desc: 'Your own', multiplier: 3, color: '#d2a8ff', hint: 'Custom identities chosen by you.' },
];

const SENDER_COLORS = ['#58a6ff', '#f0883e', '#a5d6ff', '#7ee787', '#d2a8ff', '#f85149', '#79c0ff', '#ffa657'];
const GOLD = '#e8b04b';
const PURPLE = '#d2a8ff';
const BG = '#0d1117';
const BG2 = '#161b22';
const BORDER = '#21262d';
const TEXT = '#c9d1d9';
const TEXT_DIM = '#8b949e';
const STORAGE_KEY = 'deepsteve-agent-game-state';
const CUSTOM_NAMES_KEY = 'deepsteve-agent-game-custom-names';
const GENERATED_NAMES_KEY_PREFIX = 'deepsteve-agent-game-generated-';
const CHANNEL = 'agent-game';
const GENERATE_CHANNEL = 'agent-game-generate';

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getGeneratedNames(tier) {
  try {
    const raw = localStorage.getItem(GENERATED_NAMES_KEY_PREFIX + tier);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveGeneratedNames(tier, names) {
  localStorage.setItem(GENERATED_NAMES_KEY_PREFIX + tier, JSON.stringify(names));
}

function getNamePool(tier) {
  const base = NAME_BANKS[tier] || [];
  const generated = getGeneratedNames(tier);
  // Deduplicate (case-insensitive)
  const seen = new Set(base.map(n => n.toLowerCase()));
  const merged = [...base];
  for (const n of generated) {
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      merged.push(n);
    }
  }
  return merged;
}

function pickNames(tier, count) {
  if (tier === 'custom') return []; // custom names handled separately
  return shuffle(getNamePool(tier)).slice(0, count);
}

function waitForBridge() {
  return new Promise(resolve => {
    if (window.deepsteve) return resolve(window.deepsteve);
    const poll = setInterval(() => {
      if (window.deepsteve) { clearInterval(poll); resolve(window.deepsteve); }
    }, 100);
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function tierInfo(id) {
  return TIERS.find(t => t.id === id);
}

function buildGeneratorPrompt(tier, existingNames) {
  const t = tierInfo(tier);
  const category = { easy: 'animals', medium: 'fictional characters from books, movies, TV, and games', hard: 'philosophers from any era or tradition', nightmare: 'abstract concepts, emotions, or philosophical terms' }[tier] || t.desc;
  return [
    `Generate exactly 10 unique ${category} for a "Who Am I?" guessing game.`,
    ``,
    `Requirements:`,
    `- Category: ${t.label} (${t.desc})`,
    `- Each name should be well-known enough to give hints about`,
    `- Do NOT repeat any of these existing names: ${existingNames.join(', ')}`,
    `- Be creative and diverse in your selections`,
    ``,
    `Send your response as a JSON array of strings using send_message with channel "${GENERATE_CHANNEL}" and sender "Generator".`,
    `Example: ["Name1", "Name2", "Name3", "Name4", "Name5", "Name6", "Name7", "Name8", "Name9", "Name10"]`,
    ``,
    `Send ONLY the JSON array in your message, nothing else. Then stop.`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Builders
// ═══════════════════════════════════════════════════════════════════════════════

function buildHinterPrompt(name, guesserName, allNames, tier) {
  const t = tierInfo(tier);
  const others = allNames.filter(n => n !== name).map(n => n === guesserName ? '???' : n);
  return [
    `You are playing "Who Am I?" in a group chat with other AI agents.`,
    ``,
    `YOUR CHARACTER: ${name}`,
    `ROLE: Hint Giver`,
    ``,
    `SETUP:`,
    `- ${allNames.length} players total`,
    `- The player "???" doesn't know their identity — they are actually "${guesserName}"`,
    `- Other players: ${others.join(', ')}`,
    ``,
    `RULES:`,
    `1. Use send_message tool with channel "${CHANNEL}" and sender "${name}"`,
    `2. Stay in character as ${name}`,
    `3. Give ??? hints about their identity through natural conversation`,
    `4. NEVER say ???'s real name directly`,
    `5. Use references, behavioral cues, quotes, thematic parallels`,
    `6. Difficulty: ${t.label} — ${t.hint}`,
    `7. Keep messages to 1-3 sentences`,
    `8. Use read_messages with channel "${CHANNEL}" to check what others said before responding`,
    ``,
    `LOOP:`,
    `Run in a continuous loop: send a message, then sleep 5 seconds, then read_messages to check for new replies, then respond. Keep looping until ??? makes their guess ("I think I am [NAME]!"). After the guess, check a few more times to say any final reactions, then stop.`,
    ``,
    `Introduce yourself and start chatting. Weave in hints about ???'s identity naturally.`,
  ].join('\n');
}

function buildGuesserPrompt(allNames, guesserName, tier) {
  const t = tierInfo(tier);
  const others = allNames.filter(n => n !== guesserName);
  return [
    `You are playing "Who Am I?" with other AI agents.`,
    ``,
    `YOUR CHARACTER: ??? (your identity is hidden!)`,
    `ROLE: Guesser`,
    ``,
    `SETUP:`,
    `- The other players know who you are, but you don't`,
    `- Other players: ${others.join(', ')}`,
    `- They'll give you hints through conversation`,
    ``,
    `RULES:`,
    `1. Use send_message tool with channel "${CHANNEL}" and sender "???"`,
    `2. Chat naturally, ask questions, pick up on hints`,
    `3. Use read_messages with channel "${CHANNEL}" to see what others are saying`,
    `4. When confident, say exactly: "I think I am [NAME]!"`,
    `5. You get ONE guess, so be sure`,
    `6. Keep messages to 1-3 sentences`,
    ``,
    `LOOP:`,
    `Run in a continuous loop: send a message, then sleep 5 seconds, then read_messages to check for new replies, then respond. Keep looping until you make your guess. After guessing, check a few more times to say any final reactions, then stop.`,
    ``,
    `Say hello and start asking for hints!`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Style Injection
// ═══════════════════════════════════════════════════════════════════════════════

function injectStyles() {
  if (document.getElementById('ag-styles')) return;
  const s = document.createElement('style');
  s.id = 'ag-styles';
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&display=swap');
    @keyframes ag-spin { to { transform: rotate(360deg); } }
    @keyframes ag-pulse { 0%,100% { opacity:.6 } 50% { opacity:1 } }
    @keyframes ag-fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
    @keyframes ag-glow { 0%,100% { box-shadow:0 0 6px ${PURPLE}40 } 50% { box-shadow:0 0 18px ${PURPLE}80 } }
    @keyframes ag-confetti { 0% { transform:translateY(0) rotate(0); opacity:1 } 100% { transform:translateY(420px) rotate(720deg); opacity:0 } }
    @keyframes ag-scaleIn { from { transform:scale(.85); opacity:0 } to { transform:scale(1); opacity:1 } }
    @keyframes ag-shimmer { 0% { background-position:-200% 0 } 100% { background-position:200% 0 } }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Custom Names Editor
// ═══════════════════════════════════════════════════════════════════════════════

function CustomNamesEditor({ customNames, setCustomNames }) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);

  const addName = () => {
    const name = inputValue.trim();
    if (!name || customNames.length >= 8) return;
    if (customNames.some(n => n.toLowerCase() === name.toLowerCase())) return;
    const updated = [...customNames, name];
    setCustomNames(updated);
    localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(updated));
    setInputValue('');
    inputRef.current?.focus();
  };

  const removeName = (idx) => {
    const updated = customNames.filter((_, i) => i !== idx);
    setCustomNames(updated);
    localStorage.setItem(CUSTOM_NAMES_KEY, JSON.stringify(updated));
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {customNames.map((name, i) => (
          <div key={`${name}-${i}`} style={{
            padding: '6px 10px', borderRadius: 20,
            background: BG2, border: `1.5px solid ${BORDER}`,
            color: TEXT, fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {name}
            <button onClick={() => removeName(i)} style={{
              background: 'none', border: 'none', color: TEXT_DIM, cursor: 'pointer',
              fontSize: 12, padding: '0 2px', lineHeight: 1,
            }}
              onMouseEnter={e => e.currentTarget.style.color = '#f85149'}
              onMouseLeave={e => e.currentTarget.style.color = TEXT_DIM}
            >
              \u00d7
            </button>
          </div>
        ))}
      </div>
      {customNames.length < 8 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }}
            placeholder="Type a name and press Enter"
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 6,
              background: BG, border: `1px solid ${BORDER}`,
              color: TEXT, fontSize: 13, outline: 'none',
            }}
          />
          <button onClick={addName} style={{
            padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
            background: PURPLE, border: 'none', color: BG,
            fontSize: 12, fontWeight: 600,
          }}>
            Add
          </button>
        </div>
      )}
      <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 6 }}>
        {customNames.length}/8 names ({customNames.length < 3 ? `need at least ${3 - customNames.length} more` : 'ready'})
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Setup Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SetupScreen({ onStart, round, totalScore, bridge }) {
  const [tier, setTier] = useState('easy');
  const [count, setCount] = useState(3);
  const [names, setNames] = useState(() => pickNames('easy', 3));
  const [guesserIdx, setGuesserIdx] = useState(() => Math.floor(Math.random() * 3));
  const [customNames, setCustomNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CUSTOM_NAMES_KEY)) || []; } catch { return []; }
  });
  const [generating, setGenerating] = useState(false);
  const generatorSessionRef = useRef(null);
  const generateTimeoutRef = useRef(null);
  const unsubRef = useRef(null);

  const isCustom = tier === 'custom';
  const effectiveNames = isCustom ? customNames : names;
  const canStart = isCustom ? customNames.length >= 3 : true;

  useEffect(() => {
    if (isCustom) return;
    const n = pickNames(tier, count);
    setNames(n);
    setGuesserIdx(Math.floor(Math.random() * count));
  }, [tier, count]);

  // Keep guesserIdx in range for custom names
  useEffect(() => {
    if (isCustom && guesserIdx >= customNames.length) {
      setGuesserIdx(Math.max(0, customNames.length - 1));
    }
  }, [isCustom, customNames.length, guesserIdx]);

  // Cleanup generator on unmount
  useEffect(() => {
    return () => {
      if (generatorSessionRef.current && bridge) {
        bridge.killSession(generatorSessionRef.current, { force: true });
      }
      if (generateTimeoutRef.current) clearTimeout(generateTimeoutRef.current);
      if (unsubRef.current) unsubRef.current();
    };
  }, [bridge]);

  const handleShuffle = () => {
    setNames(pickNames(tier, count));
    setGuesserIdx(Math.floor(Math.random() * count));
  };

  const handleGenerate = async () => {
    if (!bridge || generating || isCustom) return;
    setGenerating(true);

    try {
      // Clear generator channel
      await fetch(`/api/agent-chat/${GENERATE_CHANNEL}`, { method: 'DELETE' }).catch(() => {});

      const existing = getNamePool(tier);
      const prompt = buildGeneratorPrompt(tier, existing);
      const sessions = bridge.getSessions();
      const cwd = sessions.length > 0 ? sessions[0].cwd : '/tmp';

      const sessionId = await bridge.createSession(cwd, {
        name: 'Name Generator',
        initialPrompt: prompt,
        background: true,
      });
      generatorSessionRef.current = sessionId;

      // Monitor for response
      const unsub = bridge.onAgentChatChanged(channels => {
        const msgs = channels[GENERATE_CHANNEL]?.messages || [];
        if (msgs.length === 0) return;

        // Look for a message with a JSON array
        for (const msg of msgs) {
          try {
            // Strip markdown fences if present
            let text = msg.text.trim();
            text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(n => typeof n === 'string')) {
              // Success — merge into pool
              const existingGenerated = getGeneratedNames(tier);
              const allGenerated = [...existingGenerated, ...parsed];
              saveGeneratedNames(tier, allGenerated);

              // Cleanup
              if (unsub) unsub();
              unsubRef.current = null;
              if (generateTimeoutRef.current) { clearTimeout(generateTimeoutRef.current); generateTimeoutRef.current = null; }
              bridge.killSession(sessionId, { force: true });
              generatorSessionRef.current = null;
              fetch(`/api/agent-chat/${GENERATE_CHANNEL}`, { method: 'DELETE' }).catch(() => {});

              // Re-shuffle with new pool
              setNames(pickNames(tier, count));
              setGuesserIdx(Math.floor(Math.random() * count));
              setGenerating(false);
              return;
            }
          } catch {}
        }
      });
      unsubRef.current = unsub;

      // 60-second timeout
      generateTimeoutRef.current = setTimeout(() => {
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
        if (generatorSessionRef.current) {
          bridge.killSession(generatorSessionRef.current, { force: true });
          generatorSessionRef.current = null;
        }
        fetch(`/api/agent-chat/${GENERATE_CHANNEL}`, { method: 'DELETE' }).catch(() => {});
        setGenerating(false);
      }, 60000);

    } catch {
      setGenerating(false);
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 30%, ${GOLD}08 0%, transparent 60%), radial-gradient(ellipse at 80% 70%, ${PURPLE}06 0%, transparent 50%), ${BG}`,
    }}>
      <div style={{
        maxWidth: 580, width: '100%', padding: '40px 36px',
        animation: 'ag-fadeIn 0.4s ease-out',
      }}>
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <h1 style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 44, fontWeight: 900, letterSpacing: 6, margin: 0,
            color: TEXT,
            textShadow: `0 0 40px ${GOLD}20`,
          }}>
            WHO AM I?
          </h1>
          <div style={{
            fontSize: 12, color: TEXT_DIM, letterSpacing: 3, textTransform: 'uppercase', marginTop: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          }}>
            <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
            The Agent Identity Game
            <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
          </div>
          {round > 1 && (
            <div style={{ marginTop: 10, fontSize: 13, color: GOLD }}>
              Round {round} &middot; Total Score: {totalScore}
            </div>
          )}
        </div>

        {/* Difficulty */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10 }}>
            Difficulty
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {TIERS.map(t => {
              const active = tier === t.id;
              return (
                <button key={t.id} onClick={() => setTier(t.id)} style={{
                  flex: 1, padding: '14px 8px', borderRadius: 8, cursor: 'pointer',
                  background: active ? `${t.color}15` : BG2,
                  border: `1.5px solid ${active ? t.color : BORDER}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  transition: 'all 0.15s',
                }}>
                  <span style={{ fontSize: 22 }}>{t.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: active ? t.color : TEXT }}>{t.label}</span>
                  <span style={{ fontSize: 10, color: TEXT_DIM }}>{t.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent Count (hidden for custom tier) */}
        {!isCustom && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10 }}>
              Agents
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[3, 4, 5].map(n => (
                <button key={n} onClick={() => setCount(n)} style={{
                  width: 44, height: 36, borderRadius: 6, cursor: 'pointer',
                  background: count === n ? GOLD : 'transparent',
                  border: `1.5px solid ${count === n ? GOLD : BORDER}`,
                  color: count === n ? BG : TEXT,
                  fontSize: 14, fontWeight: 600,
                  transition: 'all 0.15s',
                }}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Name Roster / Custom Editor */}
        <div style={{ marginBottom: 28 }}>
          <div style={{
            fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{isCustom ? 'Custom Names' : 'Players \u2014 click to assign guesser'}</span>
            {!isCustom && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button onClick={handleGenerate} disabled={generating} style={{
                  background: 'none', border: 'none', color: generating ? GOLD : TEXT_DIM, cursor: generating ? 'default' : 'pointer',
                  fontSize: 11, padding: '2px 6px',
                  display: 'flex', alignItems: 'center', gap: 4,
                }} title="Generate names with AI">
                  {generating ? (
                    <>
                      <span style={{
                        display: 'inline-block', width: 10, height: 10,
                        border: `1.5px solid ${GOLD}`, borderTopColor: 'transparent',
                        borderRadius: '50%', animation: 'ag-spin 0.6s linear infinite',
                      }} />
                      Generating...
                    </>
                  ) : (
                    <>\u2728 Generate</>
                  )}
                </button>
                <button onClick={handleShuffle} style={{
                  background: 'none', border: 'none', color: TEXT_DIM, cursor: 'pointer',
                  fontSize: 11, padding: '2px 6px',
                }}>
                  Shuffle
                </button>
              </div>
            )}
          </div>

          {isCustom ? (
            <CustomNamesEditor customNames={customNames} setCustomNames={setCustomNames} />
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {names.map((name, i) => {
                const isGuesser = i === guesserIdx;
                return (
                  <button key={`${name}-${i}`} onClick={() => setGuesserIdx(i)} style={{
                    padding: '8px 16px', borderRadius: 20, cursor: 'pointer',
                    background: isGuesser ? `${PURPLE}20` : BG2,
                    border: `1.5px solid ${isGuesser ? PURPLE : BORDER}`,
                    color: isGuesser ? PURPLE : TEXT,
                    fontSize: 13, fontWeight: isGuesser ? 600 : 400,
                    display: 'flex', alignItems: 'center', gap: 6,
                    animation: isGuesser ? 'ag-glow 2s ease-in-out infinite' : 'none',
                    transition: 'all 0.15s',
                  }}>
                    {isGuesser && <span style={{ fontSize: 11, opacity: 0.8 }}>???</span>}
                    {name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Guesser assignment for custom tier */}
          {isCustom && customNames.length >= 3 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 8 }}>
                Click to assign guesser
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {customNames.map((name, i) => {
                  const isGuesser = i === guesserIdx;
                  return (
                    <button key={`${name}-${i}`} onClick={() => setGuesserIdx(i)} style={{
                      padding: '8px 16px', borderRadius: 20, cursor: 'pointer',
                      background: isGuesser ? `${PURPLE}20` : BG2,
                      border: `1.5px solid ${isGuesser ? PURPLE : BORDER}`,
                      color: isGuesser ? PURPLE : TEXT,
                      fontSize: 13, fontWeight: isGuesser ? 600 : 400,
                      display: 'flex', alignItems: 'center', gap: 6,
                      animation: isGuesser ? 'ag-glow 2s ease-in-out infinite' : 'none',
                      transition: 'all 0.15s',
                    }}>
                      {isGuesser && <span style={{ fontSize: 11, opacity: 0.8 }}>???</span>}
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Start Button */}
        <button
          onClick={() => onStart({
            tier,
            names: isCustom ? customNames : names,
            guesserIdx: isCustom ? Math.min(guesserIdx, customNames.length - 1) : guesserIdx,
          })}
          disabled={!canStart}
          style={{
            width: '100%', padding: 14, borderRadius: 8,
            background: canStart ? `linear-gradient(135deg, ${GOLD}, ${GOLD}dd)` : `${BORDER}`,
            border: 'none', cursor: canStart ? 'pointer' : 'not-allowed',
            color: canStart ? BG : TEXT_DIM, fontSize: 15, fontWeight: 700, letterSpacing: 1,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (canStart) e.currentTarget.style.filter = 'brightness(1.1)'; }}
          onMouseLeave={e => e.currentTarget.style.filter = 'none'}
        >
          {isCustom && customNames.length < 3 ? `ADD ${3 - customNames.length} MORE NAME${3 - customNames.length > 1 ? 'S' : ''}` : 'START GAME'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Spawning Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SpawningScreen({ names, guesserIdx, progress }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: BG,
    }}>
      <div style={{ textAlign: 'center', animation: 'ag-fadeIn 0.3s ease-out' }}>
        <h2 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 24, fontWeight: 700, color: TEXT, marginBottom: 28,
        }}>
          Setting up the game...
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 240 }}>
          {names.map((name, i) => {
            const done = i < progress;
            const active = i === progress;
            const isGuesser = i === guesserIdx;
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 16px', borderRadius: 8,
                background: done ? `${GOLD}10` : active ? `${BG2}` : 'transparent',
                border: `1px solid ${done ? `${GOLD}30` : active ? BORDER : 'transparent'}`,
                opacity: done || active ? 1 : 0.4,
                transition: 'all 0.3s',
              }}>
                <span style={{ width: 20, textAlign: 'center' }}>
                  {done
                    ? <span style={{ color: '#7ee787' }}>{'\u2713'}</span>
                    : active
                      ? <span style={{ display: 'inline-block', width: 14, height: 14, border: `2px solid ${GOLD}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'ag-spin 0.6s linear infinite' }} />
                      : <span style={{ color: TEXT_DIM }}>{'\u2022'}</span>
                  }
                </span>
                <span style={{ fontSize: 14, color: done ? TEXT : active ? GOLD : TEXT_DIM }}>
                  {isGuesser ? '???' : name}
                </span>
                {isGuesser && (
                  <span style={{ fontSize: 10, color: PURPLE, marginLeft: 'auto' }}>Guesser</span>
                )}
              </div>
            );
          })}
        </div>
        <div style={{
          marginTop: 20, fontSize: 12, color: TEXT_DIM,
        }}>
          {progress}/{names.length} agents spawned
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game Board
// ═══════════════════════════════════════════════════════════════════════════════

function ChatMessage({ msg }) {
  const color = hashColor(msg.sender);
  return (
    <div style={{
      padding: '6px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      animation: 'ag-fadeIn 0.2s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color,
          padding: '1px 6px', borderRadius: 8,
          background: `${color}18`, border: `1px solid ${color}30`,
          whiteSpace: 'nowrap',
        }}>
          {msg.sender}
        </span>
        <span style={{ fontSize: 10, color: '#484f58' }}>{formatTime(msg.timestamp)}</span>
      </div>
      <div style={{ fontSize: 13, color: TEXT, wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
        {msg.text}
      </div>
    </div>
  );
}

function GameBoard({ names, guesserIdx, messages, sessions, sessionIds, tier, round, totalScore, onEndRound, guessResult }) {
  const endRef = useRef(null);
  const prevCount = useRef(0);
  const t = tierInfo(tier);

  useEffect(() => {
    if (messages.length > prevCount.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCount.current = messages.length;
  }, [messages]);

  // Map session IDs to session data for status dots
  const sessionMap = useMemo(() => {
    const m = new Map();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  return (
    <div style={{
      height: '100vh', display: 'flex',
      background: BG,
      animation: 'ag-fadeIn 0.3s ease-out',
    }}>
      {/* Left: Agent Roster */}
      <div style={{
        width: 200, flexShrink: 0, padding: 16,
        borderRight: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM, marginBottom: 14 }}>
          Players
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          {names.map((name, i) => {
            const isGuesser = i === guesserIdx;
            const sid = sessionIds[i];
            const sess = sid ? sessionMap.get(sid) : null;
            const waiting = sess?.waitingForInput;
            return (
              <div key={i} style={{
                padding: '8px 10px', borderRadius: 6,
                background: isGuesser ? `${PURPLE}12` : BG2,
                border: `1px solid ${isGuesser ? `${PURPLE}30` : BORDER}`,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: sess ? (waiting ? GOLD : '#7ee787') : '#484f58',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500,
                    color: isGuesser ? PURPLE : TEXT,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {isGuesser ? '???' : name}
                  </div>
                  <div style={{ fontSize: 10, color: TEXT_DIM }}>
                    {isGuesser ? 'Guesser' : 'Hint Giver'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Center: Chat Feed */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{
          padding: '10px 14px', borderBottom: `1px solid ${BORDER}`,
          fontSize: 13, color: TEXT_DIM, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: TEXT, fontWeight: 500 }}>#agent-game</span>
          <span style={{ fontSize: 11 }}>{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
        </div>
        {guessResult && (
          <div style={{
            padding: '10px 14px', flexShrink: 0,
            background: guessResult.correct ? '#7ee78715' : '#f8514915',
            borderBottom: `1px solid ${guessResult.correct ? '#7ee78730' : '#f8514930'}`,
            display: 'flex', alignItems: 'center', gap: 8,
            animation: 'ag-fadeIn 0.3s ease-out',
          }}>
            <span style={{ fontSize: 16 }}>{guessResult.correct ? '\u2713' : '\u2717'}</span>
            <span style={{ fontSize: 13, color: guessResult.correct ? '#7ee787' : '#f85149', fontWeight: 600 }}>
              {guessResult.correct ? 'Correct guess!' : 'Wrong guess!'} Showing results soon...
            </span>
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {messages.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: TEXT_DIM, fontSize: 13 }}>
              Waiting for agents to start chatting...
              <div style={{
                marginTop: 8, width: 24, height: 24, margin: '12px auto 0',
                border: `2px solid ${BORDER}`, borderTopColor: GOLD,
                borderRadius: '50%', animation: 'ag-spin 0.8s linear infinite',
              }} />
            </div>
          ) : (
            messages.map(msg => <ChatMessage key={msg.id} msg={msg} />)
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* Right: Game Controls */}
      <div style={{
        width: 220, flexShrink: 0, padding: 16,
        borderLeft: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: TEXT_DIM }}>
          Round {round}
        </div>

        {/* Message Count */}
        <div style={{
          padding: 16, borderRadius: 8, background: BG2,
          border: `1px solid ${BORDER}`, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: TEXT, fontFamily: "'Playfair Display', Georgia, serif" }}>
            {messages.length}
          </div>
          <div style={{ fontSize: 11, color: TEXT_DIM, marginTop: 2 }}>Messages</div>
        </div>

        {/* Difficulty Badge */}
        <div style={{
          padding: '8px 12px', borderRadius: 6,
          background: `${t.color}12`, border: `1px solid ${t.color}30`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>{t.icon}</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: t.color }}>{t.label}</div>
            <div style={{ fontSize: 10, color: TEXT_DIM }}>{t.multiplier}x multiplier</div>
          </div>
        </div>

        {/* Score */}
        {totalScore > 0 && (
          <div style={{ textAlign: 'center', padding: '6px 0' }}>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Score</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: GOLD }}>{totalScore}</div>
          </div>
        )}

        {/* Secret Identity (visible to human only) */}
        <div style={{
          padding: '10px 12px', borderRadius: 6, marginTop: 'auto',
          background: `${GOLD}08`, border: `1px dashed ${GOLD}40`,
        }}>
          <div style={{ fontSize: 10, color: GOLD, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
            Secret Identity
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>
            {names[guesserIdx]}
          </div>
          <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 2 }}>
            Hidden from the guesser
          </div>
        </div>

        {/* End Round Button */}
        <button onClick={onEndRound} style={{
          padding: '10px 16px', borderRadius: 6, cursor: 'pointer',
          background: 'transparent',
          border: `1px solid ${BORDER}`,
          color: TEXT_DIM, fontSize: 12,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#f85149'; e.currentTarget.style.color = '#f85149'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = BORDER; e.currentTarget.style.color = TEXT_DIM; }}
        >
          End Round
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Reveal Screen
// ═══════════════════════════════════════════════════════════════════════════════

function Confetti() {
  const pieces = useMemo(() => {
    return Array.from({ length: 40 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 2 + Math.random() * 2,
      color: SENDER_COLORS[i % SENDER_COLORS.length],
      size: 4 + Math.random() * 8,
      rotation: Math.random() * 360,
    }));
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${p.left}%`, top: -20,
          width: p.size, height: p.size * 1.5,
          background: p.color, borderRadius: 2,
          transform: `rotate(${p.rotation}deg)`,
          animation: `ag-confetti ${p.duration}s ease-out ${p.delay}s forwards`,
        }} />
      ))}
    </div>
  );
}

function RevealScreen({ result, tier, round, totalScore, onNextRound, onEndGame }) {
  const t = tierInfo(tier);
  const correct = result.correct;
  const accentColor = correct ? '#7ee787' : '#f85149';

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 40%, ${accentColor}08 0%, transparent 60%), ${BG}`,
      position: 'relative',
    }}>
      {correct && <Confetti />}
      <div style={{
        textAlign: 'center', maxWidth: 480, padding: '40px 36px',
        animation: 'ag-scaleIn 0.4s ease-out',
        position: 'relative', zIndex: 1,
      }}>
        {/* Result Icon */}
        <div style={{
          width: 72, height: 72, borderRadius: '50%', margin: '0 auto 20px',
          background: `${accentColor}15`, border: `2px solid ${accentColor}40`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36,
        }}>
          {correct ? '\u2713' : '\u2717'}
        </div>

        {/* Result Text */}
        <h2 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 32, fontWeight: 900, margin: '0 0 8px',
          color: accentColor,
        }}>
          {correct ? 'CORRECT!' : result.guess ? 'NOT QUITE...' : "TIME'S UP"}
        </h2>

        {result.guess && (
          <div style={{ fontSize: 14, color: TEXT_DIM, marginBottom: 16 }}>
            {correct
              ? `The guesser figured it out!`
              : `Guessed "${result.guess}"`
            }
          </div>
        )}

        {/* Answer */}
        <div style={{
          padding: '16px 24px', borderRadius: 10, marginBottom: 24,
          background: `${GOLD}10`, border: `1.5px solid ${GOLD}30`,
        }}>
          <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 4 }}>
            The Identity Was
          </div>
          <div style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 28, fontWeight: 700, color: TEXT,
          }}>
            {result.answer}
          </div>
        </div>

        {/* Score */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 28,
        }}>
          <div>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Round Score</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: correct ? GOLD : TEXT_DIM }}>
              {result.score}
            </div>
          </div>
          <div style={{ width: 1, background: BORDER }} />
          <div>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Messages</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{result.messageCount}</div>
          </div>
          <div style={{ width: 1, background: BORDER }} />
          <div>
            <div style={{ fontSize: 11, color: TEXT_DIM, textTransform: 'uppercase', letterSpacing: 1 }}>Total</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: GOLD }}>{totalScore}</div>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={onNextRound} style={{
            padding: '12px 28px', borderRadius: 8, cursor: 'pointer',
            background: `linear-gradient(135deg, ${GOLD}, ${GOLD}dd)`,
            border: 'none', color: BG, fontSize: 14, fontWeight: 700,
            transition: 'all 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.1)'}
            onMouseLeave={e => e.currentTarget.style.filter = 'none'}
          >
            Next Round
          </button>
          <button onClick={onEndGame} style={{
            padding: '12px 28px', borderRadius: 8, cursor: 'pointer',
            background: 'transparent',
            border: `1px solid ${BORDER}`, color: TEXT_DIM, fontSize: 14,
            transition: 'all 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.color = TEXT}
            onMouseLeave={e => e.currentTarget.style.color = TEXT_DIM}
          >
            End Game
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Root Component
// ═══════════════════════════════════════════════════════════════════════════════

function AgentGame() {
  const [phase, setPhase] = useState('SETUP');
  const [bridge, setBridge] = useState(null);

  // Game config
  const [tier, setTier] = useState('easy');
  const [names, setNames] = useState([]);
  const [guesserIdx, setGuesserIdx] = useState(0);

  // Game state
  const [sessionIds, setSessionIds] = useState([]);
  const [spawnProgress, setSpawnProgress] = useState(0);
  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);

  // Reveal state
  const [guessResult, setGuessResult] = useState(null);

  // Scoring
  const [totalScore, setTotalScore] = useState(0);
  const [round, setRound] = useState(1);

  // Refs for stable access in effects
  const phaseRef = useRef(phase);
  const namesRef = useRef(names);
  const guesserIdxRef = useRef(guesserIdx);
  const tierRef = useRef(tier);
  const guessResultRef = useRef(guessResult);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { namesRef.current = names; }, [names]);
  useEffect(() => { guesserIdxRef.current = guesserIdx; }, [guesserIdx]);
  useEffect(() => { tierRef.current = tier; }, [tier]);
  useEffect(() => { guessResultRef.current = guessResult; }, [guessResult]);

  // Bridge init + style injection
  useEffect(() => {
    injectStyles();
    waitForBridge().then(b => {
      setBridge(b);
      // Clean up orphaned game sessions from a previous interrupted game
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const { sessionIds: orphanIds } = JSON.parse(saved);
          if (orphanIds?.length) orphanIds.forEach(id => b.killSession(id));
          localStorage.removeItem(STORAGE_KEY);
          fetch(`/api/agent-chat/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});
        }
      } catch {}
    });
  }, []);

  // Subscribe to chat changes
  useEffect(() => {
    if (!bridge) return;
    return bridge.onAgentChatChanged(channels => {
      const gameMessages = channels[CHANNEL]?.messages || [];
      setMessages(gameMessages);

      // Guess detection (skip if already detected or not playing)
      if (phaseRef.current !== 'PLAYING' || guessResultRef.current) return;
      for (let i = gameMessages.length - 1; i >= Math.max(0, gameMessages.length - 5); i--) {
        const msg = gameMessages[i];
        if (msg.sender !== '???') continue;
        const match = msg.text.match(/I think I am (.+?)!?\s*$/i);
        if (match) {
          const rawGuess = match[1].trim();
          const guess = rawGuess.replace(/^(a |an |the )/i, '');
          const answer = namesRef.current[guesserIdxRef.current];
          const correct = guess.toLowerCase() === answer.toLowerCase();
          const t = tierInfo(tierRef.current);
          const score = correct ? (100 + Math.max(0, 50 - gameMessages.length)) * t.multiplier : 0;
          const result = { guess: rawGuess, answer, correct, score, messageCount: gameMessages.length };
          setGuessResult(result);
          // Stay on game board for 10s so user can watch the conversation react
          setTimeout(() => setPhase('REVEAL'), 10000);
          break;
        }
      }
    });
  }, [bridge]);

  // Subscribe to session changes
  useEffect(() => {
    if (!bridge) return;
    return bridge.onSessionsChanged(setSessions);
  }, [bridge]);

  // Save session IDs for orphan recovery
  useEffect(() => {
    if (sessionIds.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionIds }));
    }
  }, [sessionIds]);

  // Start game
  const handleStart = useCallback(async (config) => {
    setTier(config.tier);
    setNames(config.names);
    setGuesserIdx(config.guesserIdx);
    setMessages([]);
    setGuessResult(null);
    setPhase('SPAWNING');
    setSpawnProgress(0);

    // Clear previous channel
    await fetch(`/api/agent-chat/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});

    // Determine cwd
    const existing = bridge.getSessions();
    const cwd = existing.length > 0 ? existing[0].cwd : '/tmp';

    // Spawn sessions sequentially
    const ids = [];
    for (let i = 0; i < config.names.length; i++) {
      const isGuesser = i === config.guesserIdx;
      const tabName = isGuesser ? '???' : config.names[i];
      const prompt = isGuesser
        ? buildGuesserPrompt(config.names, config.names[config.guesserIdx], config.tier)
        : buildHinterPrompt(config.names[i], config.names[config.guesserIdx], config.names, config.tier);

      const sessionId = await bridge.createSession(cwd, { name: tabName, initialPrompt: prompt, background: true });
      ids.push(sessionId);
      setSpawnProgress(i + 1);
    }

    setSessionIds(ids);
    setPhase('PLAYING');
  }, [bridge]);

  // End round (manual)
  const handleEndRound = useCallback(() => {
    const answer = names[guesserIdx];
    setGuessResult({ guess: null, answer, correct: false, score: 0, messageCount: messages.length });
    setPhase('REVEAL');
  }, [names, guesserIdx, messages]);

  // Cleanup helper
  const cleanup = useCallback(async () => {
    sessionIds.forEach(id => bridge.killSession(id, { force: true }));
    setSessionIds([]);
    localStorage.removeItem(STORAGE_KEY);
    await fetch(`/api/agent-chat/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});
  }, [bridge, sessionIds]);

  // Next round
  const handleNextRound = useCallback(async () => {
    if (guessResult?.score) setTotalScore(s => s + guessResult.score);
    await cleanup();
    setRound(r => r + 1);
    setGuessResult(null);
    setMessages([]);
    setPhase('SETUP');
  }, [cleanup, guessResult]);

  // End game
  const handleEndGame = useCallback(async () => {
    await cleanup();
    setPhase('SETUP');
    setTotalScore(0);
    setRound(1);
    setGuessResult(null);
    setMessages([]);
  }, [cleanup]);

  // Loading state
  if (!bridge) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: BG, color: TEXT_DIM, fontSize: 14,
      }}>
        <div style={{
          width: 20, height: 20, marginRight: 10,
          border: `2px solid ${BORDER}`, borderTopColor: GOLD,
          borderRadius: '50%', animation: 'ag-spin 0.6s linear infinite',
        }} />
        Connecting...
      </div>
    );
  }

  switch (phase) {
    case 'SETUP':
      return <SetupScreen onStart={handleStart} round={round} totalScore={totalScore} bridge={bridge} />;
    case 'SPAWNING':
      return <SpawningScreen names={names} guesserIdx={guesserIdx} progress={spawnProgress} />;
    case 'PLAYING':
      return <GameBoard
        names={names} guesserIdx={guesserIdx} messages={messages}
        sessions={sessions} sessionIds={sessionIds} tier={tier}
        round={round} totalScore={totalScore} onEndRound={handleEndRound}
        guessResult={guessResult}
      />;
    case 'REVEAL':
      return <RevealScreen
        result={guessResult} tier={tier} round={round}
        totalScore={totalScore + (guessResult?.score || 0)}
        onNextRound={handleNextRound} onEndGame={handleEndGame}
      />;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mount
// ═══════════════════════════════════════════════════════════════════════════════

ReactDOM.createRoot(document.getElementById('game-root')).render(<AgentGame />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-game/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: hidden;
    }
    #game-root { height: 100vh; }
  </style>
</head>
<body>
  <div id="game-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="agent-game.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-game/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Agent Game",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Who Am I? party game — agents chat while one guesses their identity",
  "enabledByDefault": false,
  "tags": ["games"],
  "entry": "index.html",
  "requires": ["agent-chat"],
  "toolbar": {
    "label": "Agent Game"
  }
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-poker/agent-poker.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const FELT = '#0b5e2f';
const FELT_DARK = '#084a25';
const FELT_BORDER = '#0a7a3a';
const GOLD = '#e8b04b';
const GOLD_DIM = '#a07830';
const BG = '#0d1117';
const BG2 = '#161b22';
const BORDER = '#21262d';
const TEXT = '#c9d1d9';
const TEXT_DIM = '#8b949e';
const RED = '#f85149';
const GREEN = '#7ee787';

const PLAYER_COLORS = ['#58a6ff', '#f0883e', '#d2a8ff', '#f85149'];
const PLAYER_PERSONALITIES = [
  { name: 'Ace', style: 'Tight-aggressive. Calculates pot odds. Rarely bluffs but devastating when does.' },
  { name: 'Maverick', style: 'Loose-aggressive. Loves to bluff and apply pressure. Reads opponents by their betting patterns.' },
  { name: 'Blaze', style: 'Unpredictable wildcard. Mixes strategies randomly. Sometimes genius, sometimes reckless.' },
  { name: 'Shadow', style: 'Tight-passive turned aggressive. Traps opponents. Patient, then strikes hard.' },
];

const CHANNEL = 'agent-poker';
const STORAGE_KEY = 'deepsteve-agent-poker';

const SUIT_COLORS = { '\u2665': '#ef4444', '\u2666': '#3b82f6', '\u2663': '#22c55e', '\u2660': '#c9d1d9' };

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function waitForBridge() {
  return new Promise(resolve => {
    if (window.deepsteve) return resolve(window.deepsteve);
    const poll = setInterval(() => {
      if (window.deepsteve) { clearInterval(poll); resolve(window.deepsteve); }
    }, 100);
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function playerColor(name) {
  const idx = PLAYER_PERSONALITIES.findIndex(p => p.name === name);
  return PLAYER_COLORS[idx >= 0 ? idx : 0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Style Injection
// ═══════════════════════════════════════════════════════════════════════════════

function injectStyles() {
  if (document.getElementById('poker-styles')) return;
  const s = document.createElement('style');
  s.id = 'poker-styles';
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&display=swap');
    @keyframes pk-spin { to { transform: rotate(360deg); } }
    @keyframes pk-fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes pk-pulse { 0%,100% { opacity:.7 } 50% { opacity:1 } }
    @keyframes pk-deal { from { opacity:0; transform:scale(.8) rotate(-10deg) } to { opacity:1; transform:scale(1) rotate(0) } }
    @keyframes pk-chipBounce { 0% { transform:translateY(-20px); opacity:0 } 60% { transform:translateY(3px) } 100% { transform:translateY(0); opacity:1 } }
    @keyframes pk-glow { 0%,100% { box-shadow:0 0 8px rgba(232,176,75,0.3) } 50% { box-shadow:0 0 20px rgba(232,176,75,0.6) } }
    @keyframes pk-think { 0%,100% { opacity:.4 } 50% { opacity:.8 } }
    .pk-card {
      display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
      width: 48px; height: 68px; border-radius: 6px;
      background: linear-gradient(145deg, #fff 0%, #f0f0f0 100%);
      box-shadow: 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.8);
      font-weight: 700; line-height: 1; position: relative;
      animation: pk-deal 0.3s ease-out;
    }
    .pk-card-back {
      background: linear-gradient(145deg, #1a3a6e 0%, #0f2347 100%);
      border: 2px solid #2a5aa0;
    }
    .pk-card-back::after {
      content: ''; position: absolute; inset: 4px; border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.1);
      background: repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px);
    }
    .pk-chip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 50%;
      border: 2.5px dashed rgba(255,255,255,0.5);
      font-size: 10px; font-weight: 700; color: #fff;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    }
  `;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildAgentPrompt(personality) {
  return [
    `You are "${personality.name}", an AI poker player at a Texas Hold'em table.`,
    ``,
    `YOUR PLAY STYLE: ${personality.style}`,
    ``,
    `TOOLS AVAILABLE:`,
    `- get_poker_state: Pass your player_name ("${personality.name}") to see your cards, the board, pot, and available actions.`,
    `- poker_action: Pass your player_name, action (fold/check/call/raise/all_in), reasoning (your strategic thinking), and optional table_talk (trash talk or comments to other players). For raise, include amount (the total bet, not the additional amount).`,
    `- send_message: Use channel "${CHANNEL}" and sender "${personality.name}" for table chat.`,
    ``,
    `HOW TO PLAY:`,
    `1. Call get_poker_state with player_name="${personality.name}" to check the game state`,
    `2. If your_turn is true, think strategically about your hand and take an action with poker_action`,
    `3. If your_turn is false, sleep 3 seconds then poll get_poker_state again`,
    `4. After each hand (phase="HAND_OVER"), sleep 5 seconds then poll for the next hand`,
    `5. If phase="GAME_OVER", stop playing`,
    `6. Keep looping until the game ends`,
    ``,
    `STRATEGY TIPS:`,
    `- Your "reasoning" in poker_action is your chain-of-thought — be detailed about why you're making each decision`,
    `- Consider pot odds, position, opponent tendencies, and your hand strength`,
    `- Use table_talk to bluff, intimidate, or build rapport`,
    `- Occasionally send_message to the "${CHANNEL}" channel for longer table banter`,
    `- Adapt your strategy based on how opponents have been playing`,
    ``,
    `Start by calling get_poker_state to see the current game. Play aggressively and make the game entertaining!`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Card Component
// ═══════════════════════════════════════════════════════════════════════════════

function Card({ card, small }) {
  if (!card) {
    return <div className="pk-card pk-card-back" style={small ? { width: 36, height: 52 } : {}} />;
  }
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  const color = SUIT_COLORS[suit] || TEXT;
  const sz = small ? { width: 36, height: 52, fontSize: 11 } : { fontSize: 14 };

  return (
    <div className="pk-card" style={sz}>
      <span style={{ color, fontSize: small ? 13 : 16 }}>{rank}</span>
      <span style={{ color, fontSize: small ? 10 : 12, marginTop: -2 }}>{suit}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Avatar Component — DeepSteve logo tinted per player
// ═══════════════════════════════════════════════════════════════════════════════

function Avatar({ name, isActive, folded, eliminated, size = 56 }) {
  const color = playerColor(name);
  const opacity = folded || eliminated ? 0.3 : 1;

  // SVG face inspired by the DeepSteve logo (glasses + face)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `${color}20`,
      border: `2.5px solid ${isActive ? GOLD : `${color}60`}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity,
      animation: isActive ? 'pk-glow 1.5s ease-in-out infinite' : 'none',
      transition: 'all 0.3s',
      position: 'relative',
    }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 40 40" fill="none">
        {/* Face circle */}
        <circle cx="20" cy="20" r="16" fill={`${color}30`} />
        {/* Glasses */}
        <circle cx="13" cy="17" r="6" stroke={color} strokeWidth="2" fill="none" />
        <circle cx="27" cy="17" r="6" stroke={color} strokeWidth="2" fill="none" />
        <line x1="19" y1="17" x2="21" y2="17" stroke={color} strokeWidth="2" />
        {/* Smile */}
        <path d="M14 26 Q20 30 26 26" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
      {eliminated && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.5)', fontSize: size * 0.4, color: RED,
        }}>
          X
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Player Seat Component
// ═══════════════════════════════════════════════════════════════════════════════

// Table positions: [bottom, left, top, right]
const SEAT_POSITIONS = [
  { bottom: 20, left: '50%', transform: 'translateX(-50%)' },          // bottom center
  { top: '50%', left: 20, transform: 'translateY(-50%)' },             // left
  { top: 20, left: '50%', transform: 'translateX(-50%)' },             // top center
  { top: '50%', right: 20, transform: 'translateY(-50%)' },            // right
];

function PlayerSeat({ player, position, latestReasoning, latestTalk }) {
  const color = playerColor(player.name);
  const pos = SEAT_POSITIONS[position];

  return (
    <div style={{
      position: 'absolute', ...pos,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      zIndex: 10,
      animation: 'pk-fadeIn 0.3s ease-out',
    }}>
      {/* Name */}
      <div style={{
        fontSize: 12, fontWeight: 700, color,
        textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        letterSpacing: 0.5,
      }}>
        {player.name}
        {player.isActive && (
          <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: GOLD, marginLeft: 6, verticalAlign: 'middle',
            animation: 'pk-pulse 1s infinite',
          }} />
        )}
      </div>

      {/* Avatar */}
      <Avatar
        name={player.name}
        isActive={player.isActive}
        folded={player.folded}
        eliminated={player.eliminated}
      />

      {/* Cards */}
      <div style={{ display: 'flex', gap: 3 }}>
        {player.hand ? (
          player.hand.map((c, i) => <Card key={i} card={c} small />)
        ) : player.folded || player.eliminated ? null : (
          <>
            <Card card={null} small />
            <Card card={null} small />
          </>
        )}
      </div>

      {/* Chips */}
      <div style={{
        fontSize: 13, fontWeight: 600,
        color: player.chips <= 0 ? RED : TEXT,
        textShadow: '0 1px 3px rgba(0,0,0,0.6)',
      }}>
        {player.eliminated ? 'OUT' : `$${player.chips}`}
      </div>

      {/* Current bet */}
      {player.bet > 0 && (
        <div style={{
          fontSize: 11, color: GOLD, fontWeight: 600,
          padding: '2px 8px', borderRadius: 10,
          background: 'rgba(0,0,0,0.4)',
          animation: 'pk-chipBounce 0.3s ease-out',
        }}>
          Bet: ${player.bet}
        </div>
      )}

      {/* Status badge */}
      {player.folded && !player.eliminated && (
        <div style={{ fontSize: 10, color: TEXT_DIM, fontStyle: 'italic' }}>Folded</div>
      )}
      {player.all_in && (
        <div style={{
          fontSize: 10, fontWeight: 700, color: RED,
          padding: '1px 6px', borderRadius: 4,
          background: `${RED}20`, border: `1px solid ${RED}40`,
        }}>
          ALL IN
        </div>
      )}

      {/* Table talk bubble */}
      {latestTalk && (
        <div style={{
          maxWidth: 180, padding: '4px 10px', borderRadius: 12,
          background: `${color}20`, border: `1px solid ${color}40`,
          fontSize: 11, color: TEXT, fontStyle: 'italic',
          animation: 'pk-fadeIn 0.3s ease-out',
          textAlign: 'center', wordBreak: 'break-word',
        }}>
          "{latestTalk.text}"
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Poker Table Component
// ═══════════════════════════════════════════════════════════════════════════════

function PokerTable({ state }) {
  if (!state || state.phase === 'IDLE') return null;

  return (
    <div style={{
      position: 'relative',
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Felt table */}
      <div style={{
        width: '70%', maxWidth: 600, height: '65%', maxHeight: 380,
        borderRadius: '50%',
        background: `radial-gradient(ellipse at 50% 40%, ${FELT} 0%, ${FELT_DARK} 100%)`,
        border: `4px solid ${GOLD_DIM}`,
        boxShadow: `0 0 40px rgba(0,0,0,0.5), inset 0 0 60px rgba(0,0,0,0.2), 0 0 0 8px ${BG2}`,
        position: 'relative',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12,
      }}>
        {/* Phase label */}
        <div style={{
          fontSize: 10, letterSpacing: 3, textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.4)',
        }}>
          {state.phase.replace('_', ' ')}
          {state.handNumber > 0 && ` \u2022 Hand #${state.handNumber}`}
        </div>

        {/* Community cards */}
        <div style={{ display: 'flex', gap: 6, minHeight: 68 }}>
          {state.communityCards.map((c, i) => (
            <Card key={i} card={c} />
          ))}
          {/* Empty slots */}
          {Array.from({ length: Math.max(0, 5 - state.communityCards.length) }, (_, i) => (
            <div key={`empty-${i}`} style={{
              width: 48, height: 68, borderRadius: 6,
              border: '1.5px dashed rgba(255,255,255,0.1)',
            }} />
          ))}
        </div>

        {/* Pot */}
        {state.pot > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 16px', borderRadius: 20,
            background: 'rgba(0,0,0,0.3)',
          }}>
            <div className="pk-chip" style={{ background: GOLD, width: 22, height: 22, fontSize: 8 }}>$</div>
            <span style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>
              ${state.pot}
            </span>
          </div>
        )}

        {/* Winners banner */}
        {state.winners && (
          <div style={{
            padding: '6px 16px', borderRadius: 8,
            background: `${GREEN}20`, border: `1px solid ${GREEN}40`,
            fontSize: 13, fontWeight: 600, color: GREEN,
            animation: 'pk-fadeIn 0.3s ease-out',
          }}>
            {state.winners.join(' & ')} wins!
          </div>
        )}
      </div>

      {/* Player seats */}
      {state.players.map((p, i) => (
        <PlayerSeat
          key={p.name}
          player={p}
          position={i}
          latestTalk={state.tableTalk?.filter(t => t.player === p.name).slice(-1)[0]}
          latestReasoning={state.reasoning?.filter(r => r.player === p.name).slice(-1)[0]}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chain of Thought Panel
// ═══════════════════════════════════════════════════════════════════════════════

function ThoughtPanel({ reasoning, tableTalk, log }) {
  const endRef = useRef(null);
  const prevCount = useRef(0);

  const combined = useMemo(() => {
    const items = [];
    for (const r of (reasoning || [])) {
      items.push({ ...r, type: 'thought' });
    }
    for (const t of (tableTalk || [])) {
      items.push({ ...t, type: 'talk' });
    }
    for (const l of (log || [])) {
      items.push({ text: l.text, timestamp: l.timestamp, type: 'action' });
    }
    items.sort((a, b) => a.timestamp - b.timestamp);
    return items.slice(-50);
  }, [reasoning, tableTalk, log]);

  useEffect(() => {
    if (combined.length > prevCount.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCount.current = combined.length;
  }, [combined]);

  return (
    <div style={{
      flex: 1, overflowY: 'auto', padding: '8px 0',
      fontSize: 12, lineHeight: 1.5,
    }}>
      {combined.map((item, i) => {
        if (item.type === 'action') {
          return (
            <div key={i} style={{
              padding: '3px 12px', color: TEXT_DIM, fontSize: 11,
              borderLeft: `2px solid ${BORDER}`, marginLeft: 12, marginBottom: 2,
            }}>
              {item.text}
            </div>
          );
        }
        if (item.type === 'talk') {
          const color = playerColor(item.player);
          return (
            <div key={i} style={{
              padding: '4px 12px', marginBottom: 2,
              animation: 'pk-fadeIn 0.2s ease-out',
            }}>
              <span style={{
                fontSize: 10, fontWeight: 600, color,
                padding: '1px 5px', borderRadius: 6,
                background: `${color}15`,
              }}>
                {item.player}
              </span>
              <span style={{ color: TEXT, marginLeft: 6, fontStyle: 'italic' }}>
                "{item.text}"
              </span>
            </div>
          );
        }
        // thought
        const color = playerColor(item.player);
        return (
          <div key={i} style={{
            padding: '5px 12px', marginBottom: 2,
            background: `${color}08`,
            borderLeft: `2px solid ${color}40`,
            animation: 'pk-fadeIn 0.2s ease-out',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
            }}>
              <span style={{ fontSize: 10, fontWeight: 600, color }}>
                {item.player}
              </span>
              <span style={{ fontSize: 9, color: TEXT_DIM }}>thinking</span>
              <span style={{ fontSize: 9, color: '#484f58', marginLeft: 'auto' }}>
                {formatTime(item.timestamp)}
              </span>
            </div>
            <div style={{ color: TEXT_DIM, fontSize: 11, wordBreak: 'break-word' }}>
              {item.text}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Setup Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SetupScreen({ onStart }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 30%, ${FELT}15 0%, transparent 60%), ${BG}`,
    }}>
      <div style={{
        maxWidth: 520, width: '100%', padding: '48px 40px',
        animation: 'pk-fadeIn 0.4s ease-out', textAlign: 'center',
      }}>
        {/* Title */}
        <h1 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 48, fontWeight: 900, letterSpacing: 4, margin: 0,
          color: TEXT,
          textShadow: `0 0 40px ${GOLD}20`,
        }}>
          AGENT POKER
        </h1>
        <div style={{
          fontSize: 12, color: TEXT_DIM, letterSpacing: 3, textTransform: 'uppercase', marginTop: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
          Texas Hold'em with Chain-of-Thought
          <span style={{ width: 30, height: 1, background: BORDER, display: 'inline-block' }} />
        </div>

        {/* Players preview */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 24, margin: '36px 0',
        }}>
          {PLAYER_PERSONALITIES.map((p, i) => (
            <div key={p.name} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}>
              <Avatar name={p.name} size={52} />
              <div style={{ fontSize: 13, fontWeight: 600, color: PLAYER_COLORS[i] }}>
                {p.name}
              </div>
              <div style={{
                fontSize: 10, color: TEXT_DIM, maxWidth: 100, textAlign: 'center', lineHeight: 1.4,
              }}>
                {p.style.split('.')[0]}
              </div>
            </div>
          ))}
        </div>

        {/* Info */}
        <div style={{
          padding: '14px 20px', borderRadius: 8,
          background: BG2, border: `1px solid ${BORDER}`,
          fontSize: 12, color: TEXT_DIM, lineHeight: 1.6,
          marginBottom: 28, textAlign: 'left',
        }}>
          Four AI agents play Texas Hold'em while you watch. Each agent has a unique
          personality and strategy. Watch their chain-of-thought reasoning, table talk,
          bluffs, and dramatic all-ins unfold in real time.
        </div>

        {/* Start button */}
        <button onClick={onStart} style={{
          width: '100%', padding: 16, borderRadius: 8,
          background: `linear-gradient(135deg, ${GOLD}, ${GOLD_DIM})`,
          border: 'none', cursor: 'pointer',
          color: BG, fontSize: 16, fontWeight: 700, letterSpacing: 2,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.filter = 'brightness(1.15)'}
          onMouseLeave={e => e.currentTarget.style.filter = 'none'}
        >
          DEAL ME IN
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Spawning Screen
// ═══════════════════════════════════════════════════════════════════════════════

function SpawningScreen({ progress }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: BG,
    }}>
      <div style={{ textAlign: 'center', animation: 'pk-fadeIn 0.3s ease-out' }}>
        <h2 style={{
          fontFamily: "'Playfair Display', Georgia, serif",
          fontSize: 24, fontWeight: 700, color: TEXT, marginBottom: 28,
        }}>
          Seating players...
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 260 }}>
          {PLAYER_PERSONALITIES.map((p, i) => {
            const done = i < progress;
            const active = i === progress;
            return (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 16px', borderRadius: 8,
                background: done ? `${PLAYER_COLORS[i]}10` : active ? BG2 : 'transparent',
                border: `1px solid ${done ? `${PLAYER_COLORS[i]}30` : active ? BORDER : 'transparent'}`,
                opacity: done || active ? 1 : 0.4,
                transition: 'all 0.3s',
              }}>
                <Avatar name={p.name} size={32} isActive={active} />
                <span style={{ fontSize: 14, fontWeight: 500, color: done ? TEXT : active ? GOLD : TEXT_DIM }}>
                  {p.name}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: TEXT_DIM }}>
                  {done ? '\u2713' : active ? (
                    <span style={{
                      display: 'inline-block', width: 14, height: 14,
                      border: `2px solid ${GOLD}`, borderTopColor: 'transparent',
                      borderRadius: '50%', animation: 'pk-spin 0.6s linear infinite',
                    }} />
                  ) : ''}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 20, fontSize: 12, color: TEXT_DIM }}>
          {progress}/{PLAYER_PERSONALITIES.length} agents ready
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game Screen
// ═══════════════════════════════════════════════════════════════════════════════

function GameScreen({ state, onDeal, onReset }) {
  const isHandOver = state.phase === 'HAND_OVER' || state.phase === 'SHOWDOWN';
  const isGameOver = state.phase === 'GAME_OVER';

  return (
    <div style={{
      height: '100vh', display: 'flex',
      background: BG,
    }}>
      {/* Main table area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          padding: '8px 16px', borderBottom: `1px solid ${BORDER}`,
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "'Playfair Display', Georgia, serif",
            fontSize: 15, fontWeight: 700, color: GOLD, letterSpacing: 1,
          }}>
            AGENT POKER
          </span>
          <span style={{ fontSize: 11, color: TEXT_DIM }}>
            Hand #{state.handNumber || 0}
          </span>
          <span style={{ fontSize: 11, color: TEXT_DIM, padding: '2px 8px', borderRadius: 4, background: BG2 }}>
            {state.phase?.replace('_', ' ')}
          </span>
          <div style={{ flex: 1 }} />

          {isHandOver && !isGameOver && (
            <button onClick={onDeal} style={{
              padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
              background: GOLD, border: 'none', color: BG,
              fontSize: 12, fontWeight: 600,
            }}>
              Deal Next Hand
            </button>
          )}
          {isGameOver && (
            <button onClick={onReset} style={{
              padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
              background: GREEN, border: 'none', color: BG,
              fontSize: 12, fontWeight: 600,
            }}>
              New Game
            </button>
          )}
          <button onClick={onReset} style={{
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            background: 'transparent', border: `1px solid ${BORDER}`,
            color: TEXT_DIM, fontSize: 11,
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = RED; e.currentTarget.style.color = RED; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = BORDER; e.currentTarget.style.color = TEXT_DIM; }}
          >
            Reset
          </button>
        </div>

        {/* Poker table */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <PokerTable state={state} />
        </div>
      </div>

      {/* Right panel — chain of thought */}
      <div style={{
        width: 320, flexShrink: 0,
        borderLeft: `1px solid ${BORDER}`,
        display: 'flex', flexDirection: 'column',
        background: BG,
      }}>
        <div style={{
          padding: '10px 12px', borderBottom: `1px solid ${BORDER}`,
          fontSize: 11, textTransform: 'uppercase', letterSpacing: 2,
          color: TEXT_DIM, flexShrink: 0,
        }}>
          Live Feed
        </div>
        <ThoughtPanel
          reasoning={state.reasoning}
          tableTalk={state.tableTalk}
          log={state.log}
        />

        {/* Chip standings */}
        <div style={{
          padding: '10px 12px', borderTop: `1px solid ${BORDER}`,
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: TEXT_DIM, marginBottom: 6 }}>
            Standings
          </div>
          {[...state.players].sort((a, b) => b.chips - a.chips).map(p => {
            const color = playerColor(p.name);
            const pct = (p.chips / (1000 * 4)) * 100;
            return (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
                opacity: p.eliminated ? 0.3 : 1,
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, color, width: 60 }}>{p.name}</span>
                <div style={{
                  flex: 1, height: 6, borderRadius: 3, background: BORDER,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 3,
                    background: color,
                    width: `${Math.max(1, pct)}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <span style={{ fontSize: 11, color: TEXT_DIM, width: 45, textAlign: 'right' }}>
                  ${p.chips}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Root Component
// ═══════════════════════════════════════════════════════════════════════════════

function AgentPoker() {
  const [phase, setPhase] = useState('SETUP');
  const [bridge, setBridge] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [spawnProgress, setSpawnProgress] = useState(0);
  const [sessionIds, setSessionIds] = useState([]);
  const sessionIdsRef = useRef([]);
  const pollRef = useRef(null);
  const autoDealRef = useRef(null);

  // Bridge init
  useEffect(() => {
    injectStyles();
    waitForBridge().then(b => {
      setBridge(b);
      // Cleanup orphaned sessions
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const { sessionIds: orphanIds } = JSON.parse(saved);
          if (orphanIds?.length) orphanIds.forEach(id => b.killSession(id, { force: true }));
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {}
    });
  }, []);

  // Poll game state from server
  useEffect(() => {
    if (phase !== 'PLAYING') return;

    const poll = async () => {
      try {
        const res = await fetch('/api/poker/state');
        const state = await res.json();
        setGameState(state);

        // Auto-deal next hand after HAND_OVER
        if (state.phase === 'HAND_OVER' && !autoDealRef.current) {
          autoDealRef.current = setTimeout(async () => {
            autoDealRef.current = null;
            try {
              await fetch('/api/poker/deal', { method: 'POST' });
            } catch {}
          }, 6000);
        }
      } catch {}
    };

    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => {
      clearInterval(pollRef.current);
      if (autoDealRef.current) { clearTimeout(autoDealRef.current); autoDealRef.current = null; }
    };
  }, [phase]);

  // Also listen for WebSocket broadcasts for instant updates
  useEffect(() => {
    if (!bridge) return;

    const handler = (e) => {
      if (e.data && typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'poker-state') {
            setGameState(msg.state);
          }
        } catch {}
      }
    };

    // The bridge doesn't expose raw WS, but we get updates via polling
    // The WebSocket broadcast is handled by the mod-manager bridge
  }, [bridge]);

  // Save session IDs for orphan recovery
  useEffect(() => {
    sessionIdsRef.current = sessionIds;
    if (sessionIds.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionIds }));
    }
  }, [sessionIds]);

  // Start game
  const handleStart = useCallback(async () => {
    if (!bridge) return;
    setPhase('SPAWNING');
    setSpawnProgress(0);

    // Create game on server
    await fetch('/api/poker/start', { method: 'POST' });

    // Determine cwd
    const existing = bridge.getSessions();
    const cwd = existing.length > 0 ? existing[0].cwd : '/tmp';

    // Spawn agent sessions sequentially
    const ids = [];
    for (let i = 0; i < PLAYER_PERSONALITIES.length; i++) {
      const p = PLAYER_PERSONALITIES[i];
      const prompt = buildAgentPrompt(p);
      const sessionId = await bridge.createSession(cwd, {
        name: `Poker: ${p.name}`,
        initialPrompt: prompt,
        background: true,
      });
      ids.push(sessionId);
      setSpawnProgress(i + 1);
    }

    setSessionIds(ids);

    // Deal first hand
    await fetch('/api/poker/deal', { method: 'POST' });
    setPhase('PLAYING');
  }, [bridge]);

  // Deal next hand
  const handleDeal = useCallback(async () => {
    await fetch('/api/poker/deal', { method: 'POST' });
  }, []);

  // Reset
  const handleReset = useCallback(async () => {
    // Kill sessions
    sessionIdsRef.current.forEach(id => bridge?.killSession(id, { force: true }));
    setSessionIds([]);
    localStorage.removeItem(STORAGE_KEY);

    await fetch('/api/poker/reset', { method: 'POST' });
    setGameState(null);
    setPhase('SETUP');
  }, [bridge]);

  // Loading
  if (!bridge) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: BG, color: TEXT_DIM, fontSize: 14,
      }}>
        <div style={{
          width: 20, height: 20, marginRight: 10,
          border: `2px solid ${BORDER}`, borderTopColor: GOLD,
          borderRadius: '50%', animation: 'pk-spin 0.6s linear infinite',
        }} />
        Connecting...
      </div>
    );
  }

  switch (phase) {
    case 'SETUP':
      return <SetupScreen onStart={handleStart} />;
    case 'SPAWNING':
      return <SpawningScreen progress={spawnProgress} />;
    case 'PLAYING':
      return gameState ? (
        <GameScreen state={gameState} onDeal={handleDeal} onReset={handleReset} />
      ) : (
        <div style={{
          height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: BG, color: TEXT_DIM,
        }}>
          <div style={{
            width: 20, height: 20, marginRight: 10,
            border: `2px solid ${BORDER}`, borderTopColor: GOLD,
            borderRadius: '50%', animation: 'pk-spin 0.6s linear infinite',
          }} />
          Loading game state...
        </div>
      );
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mount
// ═══════════════════════════════════════════════════════════════════════════════

ReactDOM.createRoot(document.getElementById('game-root')).render(<AgentPoker />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-poker/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: hidden;
    }
    #game-root { height: 100vh; }
  </style>
</head>
<body>
  <div id="game-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="agent-poker.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-poker/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Agent Poker",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Texas Hold'em where four AI agents play poker with chain-of-thought reasoning",
  "enabledByDefault": false,
  "tags": ["games"],
  "entry": "index.html",
  "requires": ["agent-chat"],
  "toolbar": {
    "label": "Poker"
  },
  "tools": [
    { "name": "get_poker_state", "description": "Get current poker game state from your perspective" },
    { "name": "poker_action", "description": "Take a poker action (fold, check, call, raise, all_in)" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/agent-poker/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');

// ═══════════════════════════════════════════════════════════════════════════════
// Card & Deck
// ═══════════════════════════════════════════════════════════════════════════════

const SUITS = ['h', 'd', 'c', 's'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J, 12=Q, 13=K, 14=A

function rankName(r) {
  if (r <= 10) return String(r);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r];
}

function suitSymbol(s) {
  return { h: '\u2665', d: '\u2666', c: '\u2663', s: '\u2660' }[s];
}

function cardStr(c) {
  return `${rankName(c.rank)}${suitSymbol(c.suit)}`;
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hand Evaluation — best 5 of 7 cards
// ═══════════════════════════════════════════════════════════════════════════════

function evaluate(cards) {
  // Generate all 5-card combos from 7 cards
  const combos = [];
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      for (let k = j + 1; k < cards.length; k++)
        for (let l = k + 1; l < cards.length; l++)
          for (let m = l + 1; m < cards.length; m++)
            combos.push([cards[i], cards[j], cards[k], cards[l], cards[m]]);

  let best = null;
  for (const hand of combos) {
    const score = scoreHand(hand);
    if (!best || compareScores(score, best) > 0) best = score;
  }
  return best;
}

function scoreHand(hand) {
  const ranks = hand.map(c => c.rank).sort((a, b) => b - a);
  const suits = hand.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Check straight (including A-low: A,2,3,4,5)
  let isStraight = false;
  let straightHigh = 0;
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) {
      isStraight = true;
      straightHigh = unique[0];
    } else if (unique[0] === 14 && unique[1] === 5) {
      // A-2-3-4-5 (wheel)
      isStraight = true;
      straightHigh = 5;
    }
  }

  // Count ranks
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isFlush && isStraight) {
    return { tier: straightHigh === 14 ? 10 : 9, kickers: [straightHigh] }; // Royal/Straight flush
  }
  if (groups[0].count === 4) {
    return { tier: 8, kickers: [groups[0].rank, groups[1].rank] }; // Four of a kind
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { tier: 7, kickers: [groups[0].rank, groups[1].rank] }; // Full house
  }
  if (isFlush) {
    return { tier: 6, kickers: ranks }; // Flush
  }
  if (isStraight) {
    return { tier: 5, kickers: [straightHigh] }; // Straight
  }
  if (groups[0].count === 3) {
    const k = ranks.filter(r => r !== groups[0].rank).sort((a, b) => b - a);
    return { tier: 4, kickers: [groups[0].rank, ...k] }; // Three of a kind
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    const k = ranks.find(r => r !== pairs[0] && r !== pairs[1]);
    return { tier: 3, kickers: [...pairs, k] }; // Two pair
  }
  if (groups[0].count === 2) {
    const k = ranks.filter(r => r !== groups[0].rank).sort((a, b) => b - a);
    return { tier: 2, kickers: [groups[0].rank, ...k] }; // Pair
  }
  return { tier: 1, kickers: ranks }; // High card
}

function compareScores(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const ak = a.kickers[i] || 0, bk = b.kickers[i] || 0;
    if (ak !== bk) return ak - bk;
  }
  return 0;
}

function handName(score) {
  return [
    '', 'High Card', 'Pair', 'Two Pair', 'Three of a Kind',
    'Straight', 'Flush', 'Full House', 'Four of a Kind',
    'Straight Flush', 'Royal Flush',
  ][score.tier];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game State
// ═══════════════════════════════════════════════════════════════════════════════

const PLAYER_NAMES = ['Ace', 'Maverick', 'Blaze', 'Shadow'];
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

let game = null;
let broadcastFn = null;
let logFn = (...args) => {};

function broadcastState() {
  if (broadcastFn) broadcastFn({ type: 'poker-state', state: getPublicState() });
}

function getPublicState() {
  if (!game) return { phase: 'IDLE' };
  return {
    phase: game.phase,
    handNumber: game.handNumber,
    communityCards: game.communityCards.map(cardStr),
    pot: game.pot,
    currentBet: game.currentBet,
    activePlayerIdx: game.activePlayerIdx,
    dealerIdx: game.dealerIdx,
    players: game.players.map((p, i) => ({
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      eliminated: p.eliminated,
      hand: game.phase === 'SHOWDOWN' && !p.folded ? p.hand.map(cardStr) : null,
      handRank: game.phase === 'SHOWDOWN' && !p.folded && game.communityCards.length === 5
        ? handName(evaluate([...p.hand, ...game.communityCards]))
        : null,
      isActive: i === game.activePlayerIdx,
    })),
    reasoning: game.reasoning, // chain-of-thought log
    tableTalk: game.tableTalk,
    winners: game.winners || null,
    log: game.actionLog.slice(-20),
  };
}

function createGame() {
  game = {
    phase: 'WAITING', // WAITING → PRE_FLOP → FLOP → TURN → RIVER → SHOWDOWN → HAND_OVER
    handNumber: 0,
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    activePlayerIdx: -1,
    dealerIdx: -1,
    players: PLAYER_NAMES.map(name => ({
      name,
      chips: STARTING_CHIPS,
      hand: [],
      bet: 0,
      folded: false,
      allIn: false,
      eliminated: false,
      hasActed: false,
    })),
    reasoning: [],   // { player, text, timestamp }
    tableTalk: [],   // { player, text, timestamp }
    actionLog: [],   // { text, timestamp }
    winners: null,
    lastActionTime: Date.now(),
  };
  return game;
}

function addLog(text) {
  if (!game) return;
  game.actionLog.push({ text, timestamp: Date.now() });
  logFn(`[poker] ${text}`);
}

function addReasoning(player, text) {
  if (!game) return;
  game.reasoning.push({ player, text, timestamp: Date.now() });
  // Keep last 30
  if (game.reasoning.length > 30) game.reasoning = game.reasoning.slice(-30);
}

function addTableTalk(player, text) {
  if (!game) return;
  game.tableTalk.push({ player, text, timestamp: Date.now() });
  if (game.tableTalk.length > 50) game.tableTalk = game.tableTalk.slice(-50);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Game Logic
// ═══════════════════════════════════════════════════════════════════════════════

function activePlayers() {
  return game.players.filter(p => !p.folded && !p.eliminated);
}

function activeNonAllIn() {
  return game.players.filter(p => !p.folded && !p.eliminated && !p.allIn);
}

function nextActiveIdx(from) {
  for (let i = 1; i <= game.players.length; i++) {
    const idx = (from + i) % game.players.length;
    const p = game.players[idx];
    if (!p.folded && !p.eliminated && !p.allIn) return idx;
  }
  return -1;
}

function dealNewHand() {
  // Check for eliminated players
  game.players.forEach(p => {
    if (p.chips <= 0 && !p.eliminated) {
      p.eliminated = true;
      addLog(`${p.name} is eliminated!`);
    }
  });

  const alive = game.players.filter(p => !p.eliminated);
  if (alive.length <= 1) {
    game.phase = 'GAME_OVER';
    game.winners = alive.map(p => p.name);
    addLog(`Game over! ${alive[0]?.name || 'Nobody'} wins!`);
    broadcastState();
    return;
  }

  game.handNumber++;
  game.deck = shuffle(makeDeck());
  game.communityCards = [];
  game.pot = 0;
  game.currentBet = 0;
  game.winners = null;

  // Reset player state
  game.players.forEach(p => {
    p.hand = [];
    p.bet = 0;
    p.folded = p.eliminated;
    p.allIn = false;
    p.hasActed = false;
  });

  // Advance dealer
  do {
    game.dealerIdx = (game.dealerIdx + 1) % game.players.length;
  } while (game.players[game.dealerIdx].eliminated);

  // Deal 2 cards to each active player
  for (let round = 0; round < 2; round++) {
    for (const p of game.players) {
      if (!p.eliminated) p.hand.push(game.deck.pop());
    }
  }

  addLog(`--- Hand #${game.handNumber} ---`);
  addLog(`${game.players[game.dealerIdx].name} is the dealer`);

  // Post blinds
  const sbIdx = nextActiveIdx(game.dealerIdx);
  const bbIdx = nextActiveIdx(sbIdx);
  postBlind(sbIdx, SMALL_BLIND, 'small blind');
  postBlind(bbIdx, BIG_BLIND, 'big blind');

  game.currentBet = BIG_BLIND;
  game.phase = 'PRE_FLOP';
  game.activePlayerIdx = nextActiveIdx(bbIdx);
  game.lastActionTime = Date.now();

  // Reset hasActed for betting round
  game.players.forEach(p => { p.hasActed = false; });
  // BB has already acted in a sense, but gets option to raise
  // SB and BB should still act
  game.players[sbIdx].hasActed = false;
  game.players[bbIdx].hasActed = false;

  broadcastState();
}

function postBlind(idx, amount, label) {
  const p = game.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet = actual;
  game.pot += actual;
  if (p.chips === 0) p.allIn = true;
  addLog(`${p.name} posts ${label}: ${actual}`);
}

function getAvailableActions(playerIdx) {
  if (game.activePlayerIdx !== playerIdx) return [];
  const p = game.players[playerIdx];
  if (p.folded || p.eliminated || p.allIn) return [];

  const actions = ['fold'];
  const toCall = game.currentBet - p.bet;

  if (toCall === 0) {
    actions.push('check');
  } else {
    actions.push('call');
  }

  if (p.chips > toCall) {
    actions.push('raise');
  }

  actions.push('all_in');
  return actions;
}

function processAction(playerIdx, action, amount) {
  const p = game.players[playerIdx];
  const toCall = game.currentBet - p.bet;

  switch (action) {
    case 'fold':
      p.folded = true;
      addLog(`${p.name} folds`);
      break;

    case 'check':
      if (toCall > 0) return 'Cannot check, must call or raise';
      addLog(`${p.name} checks`);
      break;

    case 'call': {
      const callAmt = Math.min(toCall, p.chips);
      p.chips -= callAmt;
      p.bet += callAmt;
      game.pot += callAmt;
      if (p.chips === 0) p.allIn = true;
      addLog(`${p.name} calls ${callAmt}`);
      break;
    }

    case 'raise': {
      const minRaise = game.currentBet + BIG_BLIND;
      let raiseTotal = amount || minRaise;
      if (raiseTotal < minRaise) raiseTotal = minRaise;
      const needed = raiseTotal - p.bet;
      if (needed >= p.chips) {
        // All-in
        const allInAmt = p.chips;
        game.pot += allInAmt;
        p.bet += allInAmt;
        p.chips = 0;
        p.allIn = true;
        game.currentBet = Math.max(game.currentBet, p.bet);
        addLog(`${p.name} raises all-in to ${p.bet}`);
      } else {
        p.chips -= needed;
        p.bet = raiseTotal;
        game.pot += needed;
        game.currentBet = raiseTotal;
        addLog(`${p.name} raises to ${raiseTotal}`);
      }
      // Reset hasActed for others since there's a raise
      game.players.forEach((op, i) => {
        if (i !== playerIdx && !op.folded && !op.eliminated && !op.allIn) {
          op.hasActed = false;
        }
      });
      break;
    }

    case 'all_in': {
      const allInAmt = p.chips;
      game.pot += allInAmt;
      p.bet += allInAmt;
      p.chips = 0;
      p.allIn = true;
      if (p.bet > game.currentBet) {
        game.currentBet = p.bet;
        // Reset hasActed for others
        game.players.forEach((op, i) => {
          if (i !== playerIdx && !op.folded && !op.eliminated && !op.allIn) {
            op.hasActed = false;
          }
        });
      }
      addLog(`${p.name} goes all-in for ${allInAmt}`);
      break;
    }

    default:
      return `Unknown action: ${action}`;
  }

  p.hasActed = true;
  game.lastActionTime = Date.now();

  // Check if only one player left
  const active = activePlayers();
  if (active.length === 1) {
    game.winners = [active[0].name];
    active[0].chips += game.pot;
    addLog(`${active[0].name} wins ${game.pot} (everyone else folded)`);
    game.pot = 0;
    game.phase = 'HAND_OVER';
    broadcastState();
    return null;
  }

  // Check if betting round is over
  if (isBettingRoundOver()) {
    advancePhase();
  } else {
    game.activePlayerIdx = nextActiveIdx(playerIdx);
  }

  broadcastState();
  return null;
}

function isBettingRoundOver() {
  const eligible = game.players.filter(p => !p.folded && !p.eliminated && !p.allIn);
  if (eligible.length === 0) return true;
  return eligible.every(p => p.hasActed && p.bet === game.currentBet);
}

function advancePhase() {
  // Reset for next betting round
  game.players.forEach(p => {
    p.bet = 0;
    p.hasActed = false;
  });
  game.currentBet = 0;

  const canBet = activeNonAllIn().length >= 2;

  switch (game.phase) {
    case 'PRE_FLOP':
      game.communityCards.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
      game.phase = 'FLOP';
      addLog(`Flop: ${game.communityCards.map(cardStr).join(' ')}`);
      break;
    case 'FLOP':
      game.communityCards.push(game.deck.pop());
      game.phase = 'TURN';
      addLog(`Turn: ${cardStr(game.communityCards[3])}`);
      break;
    case 'TURN':
      game.communityCards.push(game.deck.pop());
      game.phase = 'RIVER';
      addLog(`River: ${cardStr(game.communityCards[4])}`);
      break;
    case 'RIVER':
      doShowdown();
      return;
  }

  if (!canBet || activeNonAllIn().length < 2) {
    // Skip betting — run remaining cards
    advancePhase();
    return;
  }

  // Set active player to first after dealer
  game.activePlayerIdx = nextActiveIdx(game.dealerIdx);
  broadcastState();
}

function doShowdown() {
  game.phase = 'SHOWDOWN';
  const contenders = activePlayers();

  addLog('=== Showdown ===');
  let bestScore = null;
  let winners = [];

  for (const p of contenders) {
    const allCards = [...p.hand, ...game.communityCards];
    const score = evaluate(allCards);
    const name = handName(score);
    addLog(`${p.name}: ${p.hand.map(cardStr).join(' ')} — ${name}`);

    if (!bestScore || compareScores(score, bestScore) > 0) {
      bestScore = score;
      winners = [p];
    } else if (compareScores(score, bestScore) === 0) {
      winners.push(p);
    }
  }

  const share = Math.floor(game.pot / winners.length);
  const remainder = game.pot - share * winners.length;
  winners.forEach((w, i) => {
    w.chips += share + (i === 0 ? remainder : 0);
  });

  game.winners = winners.map(w => w.name);
  const winText = winners.length === 1
    ? `${winners[0].name} wins ${game.pot} with ${handName(bestScore)}!`
    : `Split pot (${share} each): ${winners.map(w => w.name).join(', ')} — ${handName(bestScore)}`;
  addLog(winText);
  game.pot = 0;
  game.phase = 'HAND_OVER';
  broadcastState();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP Tools
// ═══════════════════════════════════════════════════════════════════════════════

function init(context) {
  broadcastFn = context.broadcast;
  logFn = context.log || ((...args) => {});

  return {
    get_poker_state: {
      description: [
        'Get the current poker game state from your perspective.',
        'Returns your hole cards (private), community cards, pot, chip stacks,',
        'whose turn it is, and available actions if it\'s your turn.',
        'Call this in a loop to follow the game. If it\'s not your turn, sleep 3 seconds and poll again.',
      ].join(' '),
      schema: {
        player_name: z.string().describe('Your player name at the table (Ace, Maverick, Blaze, or Shadow)'),
      },
      handler: async ({ player_name }) => {
        if (!game || game.phase === 'IDLE') {
          return { content: [{ type: 'text', text: 'No game in progress. Waiting for game to start.' }] };
        }

        const pIdx = game.players.findIndex(p => p.name === player_name);
        if (pIdx === -1) {
          return { content: [{ type: 'text', text: `Player "${player_name}" not found. Valid names: ${PLAYER_NAMES.join(', ')}` }] };
        }

        const p = game.players[pIdx];
        const actions = getAvailableActions(pIdx);

        const state = {
          phase: game.phase,
          hand_number: game.handNumber,
          your_hand: p.hand.map(cardStr),
          community_cards: game.communityCards.map(cardStr),
          pot: game.pot,
          current_bet: game.currentBet,
          your_chips: p.chips,
          your_current_bet: p.bet,
          your_turn: game.activePlayerIdx === pIdx,
          available_actions: actions,
          to_call: Math.max(0, game.currentBet - p.bet),
          min_raise: game.currentBet + BIG_BLIND,
          players: game.players.map((op, i) => ({
            name: op.name,
            chips: op.chips,
            bet: op.bet,
            folded: op.folded,
            all_in: op.allIn,
            eliminated: op.eliminated,
            is_dealer: i === game.dealerIdx,
            is_active: i === game.activePlayerIdx,
          })),
          recent_actions: game.actionLog.slice(-8).map(l => l.text),
        };

        if (game.phase === 'HAND_OVER' || game.phase === 'SHOWDOWN') {
          state.winners = game.winners;
          state.showdown_hands = game.players
            .filter(op => !op.folded && !op.eliminated)
            .map(op => ({
              name: op.name,
              hand: op.hand.map(cardStr),
              rank: game.communityCards.length === 5 ? handName(evaluate([...op.hand, ...game.communityCards])) : null,
            }));
        }

        if (game.phase === 'GAME_OVER') {
          state.game_over = true;
          state.final_winner = game.winners;
        }

        return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
      },
    },

    poker_action: {
      description: [
        'Take a poker action when it\'s your turn.',
        'Actions: fold, check, call, raise (with amount), all_in.',
        'Include your reasoning (chain-of-thought) — the spectator can see it.',
        'Optionally include table_talk for what you say out loud to other players.',
      ].join(' '),
      schema: {
        player_name: z.string().describe('Your player name (Ace, Maverick, Blaze, or Shadow)'),
        action: z.enum(['fold', 'check', 'call', 'raise', 'all_in']).describe('The action to take'),
        amount: z.number().optional().describe('Raise amount (total bet, not additional). Required for raise.'),
        reasoning: z.string().describe('Your chain-of-thought reasoning for this action (visible to spectator)'),
        table_talk: z.string().optional().describe('What you say out loud to the table (other players can see this)'),
      },
      handler: async ({ player_name, action, amount, reasoning, table_talk }) => {
        if (!game || game.phase === 'IDLE' || game.phase === 'WAITING') {
          return { content: [{ type: 'text', text: 'No active hand. Wait for the next deal.' }] };
        }

        if (game.phase === 'HAND_OVER' || game.phase === 'SHOWDOWN' || game.phase === 'GAME_OVER') {
          return { content: [{ type: 'text', text: `Hand is over. Wait for next hand. Winners: ${(game.winners || []).join(', ')}` }] };
        }

        const pIdx = game.players.findIndex(p => p.name === player_name);
        if (pIdx === -1) {
          return { content: [{ type: 'text', text: `Player "${player_name}" not found.` }] };
        }

        if (game.activePlayerIdx !== pIdx) {
          const activePlayer = game.players[game.activePlayerIdx];
          return { content: [{ type: 'text', text: `Not your turn. Waiting for ${activePlayer?.name || 'unknown'}. Sleep 3 seconds and call get_poker_state again.` }] };
        }

        // Record reasoning and table talk
        if (reasoning) addReasoning(player_name, reasoning);
        if (table_talk) addTableTalk(player_name, table_talk);

        const error = processAction(pIdx, action, amount);
        if (error) {
          return { content: [{ type: 'text', text: `Action failed: ${error}` }] };
        }

        return { content: [{ type: 'text', text: `Action "${action}" accepted. Call get_poker_state to see the updated state.` }] };
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REST API for the browser UI
// ═══════════════════════════════════════════════════════════════════════════════

function registerRoutes(app, context) {
  broadcastFn = context.broadcast;
  logFn = context.log || ((...args) => {});

  // Get full public state
  app.get('/api/poker/state', (req, res) => {
    res.json(getPublicState());
  });

  // Start a new game
  app.post('/api/poker/start', (req, res) => {
    createGame();
    addLog('Game created. Waiting for agents...');
    broadcastState();
    res.json({ ok: true });
  });

  // Deal a new hand (called by UI after HAND_OVER)
  app.post('/api/poker/deal', (req, res) => {
    if (!game) {
      res.status(400).json({ error: 'No game. Start one first.' });
      return;
    }
    dealNewHand();
    res.json({ ok: true });
  });

  // Reset game
  app.post('/api/poker/reset', (req, res) => {
    game = null;
    broadcastState();
    res.json({ ok: true });
  });
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/baby-browser/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Baby Browser</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  body { display: flex; flex-direction: column; }

  .url-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: #16213e;
    border-bottom: 1px solid #2a2a4a;
    flex-shrink: 0;
  }
  .url-bar input {
    flex: 1;
    background: #0f0f23;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    padding: 5px 8px;
    color: #e0e0e0;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
    outline: none;
  }
  .url-bar input:focus { border-color: #4a4a8a; }
  .nav-btn {
    background: #2a2a4a;
    border: 1px solid #3a3a5a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    min-width: 28px;
    text-align: center;
  }
  .nav-btn:hover { background: #3a3a5a; }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-btn:disabled:hover { background: #2a2a4a; }
  .go-btn {
    background: #2a2a4a;
    border: 1px solid #3a3a5a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 5px 12px;
    cursor: pointer;
    font-size: 13px;
  }
  .go-btn:hover { background: #3a3a5a; }

  iframe {
    flex: 1;
    width: 100%;
    border: none;
    background: #fff;
  }
</style>
</head>
<body>
  <div class="url-bar">
    <button class="nav-btn" id="back" title="Back" disabled>&#9664;</button>
    <button class="nav-btn" id="forward" title="Forward" disabled>&#9654;</button>
    <button class="nav-btn" id="refresh" title="Refresh">&#8635;</button>
    <input type="text" id="url" value="https://example.com" spellcheck="false" autocomplete="off">
    <button class="go-btn" id="go">Go</button>
  </div>
  <iframe id="browser" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>

  <script>
    let _d=0;try{let w=window;while(w!==w.parent){w=w.parent;_d++}}catch{}
    const STORAGE_KEY = (_d > 0 ? 'ds'+_d+'-' : '') + 'baby-browser-state';
    const urlInput = document.getElementById('url');
    const goBtn = document.getElementById('go');
    const backBtn = document.getElementById('back');
    const forwardBtn = document.getElementById('forward');
    const refreshBtn = document.getElementById('refresh');
    const frame = document.getElementById('browser');

    // Restore state from sessionStorage
    let navHistory = ['https://example.com'];
    let historyIndex = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
      if (saved && saved.history?.length) {
        navHistory = saved.history;
        historyIndex = Math.min(saved.index ?? 0, saved.history.length - 1);
      }
    } catch {}

    // Support ?url= query param for window config restore
    try {
      const paramUrl = new URLSearchParams(window.location.search).get('url');
      if (paramUrl) {
        navHistory = [paramUrl];
        historyIndex = 0;
      }
    } catch {}

    function proxyUrl(url) {
      return '/api/proxy?url=' + encodeURIComponent(url);
    }

    function saveState() {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ history: navHistory, index: historyIndex }));
    }

    function updateNavButtons() {
      backBtn.disabled = historyIndex <= 0;
      forwardBtn.disabled = historyIndex >= navHistory.length - 1;
    }

    function navigate(pushHistory = true) {
      let url = urlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      urlInput.value = url;

      if (pushHistory) {
        navHistory.length = historyIndex + 1;
        navHistory.push(url);
        historyIndex = navHistory.length - 1;
      }

      frame.src = proxyUrl(url);
      updateNavButtons();
      saveState();
    }

    backBtn.addEventListener('click', () => {
      if (historyIndex <= 0) return;
      historyIndex--;
      urlInput.value = navHistory[historyIndex];
      navigate(false);
    });

    forwardBtn.addEventListener('click', () => {
      if (historyIndex >= navHistory.length - 1) return;
      historyIndex++;
      urlInput.value = navHistory[historyIndex];
      navigate(false);
    });

    refreshBtn.addEventListener('click', () => {
      navigate(false);
    });

    // Track in-iframe navigation (link clicks) and update URL bar + history
    frame.addEventListener('load', () => {
      try {
        const frameSrc = frame.contentWindow.location.href;
        const match = frameSrc.match(/[?&]url=([^&]+)/);
        if (match) {
          const realUrl = decodeURIComponent(match[1]);
          if (realUrl && realUrl !== navHistory[historyIndex]) {
            urlInput.value = realUrl;
            navHistory.length = historyIndex + 1;
            navHistory.push(realUrl);
            historyIndex = navHistory.length - 1;
            updateNavButtons();
            saveState();
          }
        }
      } catch {}
    });

    goBtn.addEventListener('click', () => navigate());
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate();
    });

    // Load current page from history
    urlInput.value = navHistory[historyIndex];
    navigate(false);

    // ─── Baby Browser MCP bridge ───────────────────────────────────────
    function initBridge() {
      if (!window.deepsteve) {
        setTimeout(initBridge, 200);
        return;
      }

      window.deepsteve.onBabyBrowserRequest(async (req) => {
        const { requestId, action } = req;
        let result, error;

        try {
          if (action === 'navigate') {
            urlInput.value = req.url;
            result = await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                frame.removeEventListener('load', onLoad);
                resolve(`Navigated to ${req.url} (load event timed out after 10s, page may still be loading)`);
              }, 10000);
              function onLoad() {
                clearTimeout(timeout);
                frame.removeEventListener('load', onLoad);
                resolve(`Navigated to ${req.url}`);
              }
              frame.addEventListener('load', onLoad);
              navigate();
            });
          } else if (action === 'read') {
            try {
              const doc = frame.contentDocument;
              if (!doc || !doc.body) {
                error = 'No page loaded in Baby Browser';
              } else {
                const clone = doc.body.cloneNode(true);
                for (const tag of clone.querySelectorAll('script, style, noscript, svg, link, meta')) {
                  tag.remove();
                }
                const title = doc.title || '';
                const bodyText = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
                result = (title ? `# ${title}\n\n` : '') + bodyText;
              }
            } catch (e) {
              error = 'Cannot read page content (cross-origin restriction): ' + e.message;
            }
          } else if (action === 'url') {
            result = navHistory[historyIndex] || '';
          } else {
            error = `Unknown action: ${action}`;
          }
        } catch (e) {
          error = e.message;
        }

        fetch('/api/baby-browser/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, result, error }),
        }).catch(e => console.error('Failed to post baby-browser result:', e));
      });
    }

    initBridge();
  </script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/baby-browser/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Baby Browser",
  "version": "0.1.0",
  "description": "Iframe-based browser tab for viewing web pages via the proxy.",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "tab",
  "tabOption": { "label": "Baby Browser" },
  "tools": [
    { "name": "baby_browser_navigate", "description": "Navigate Baby Browser to a URL" },
    { "name": "baby_browser_read", "description": "Read page content as text" },
    { "name": "baby_browser_url", "description": "Get current URL" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/baby-browser/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');
const { randomUUID } = require('crypto');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 15000;

/**
 * Initialize Baby Browser MCP tools.
 */
function init(context) {
  const { broadcast, broadcastToWindow, shells } = context;

  // Resolve session_id to a windowId, returning the send function and optional targetWindowId
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }), targetWindowId: windowId };
      }
    }
    return { send: broadcast };
  }

  return {
    baby_browser_navigate: {
      description: 'Navigate Baby Browser to a URL and wait for the page to load. Baby Browser is a built-in iframe-based web browser tab in deepsteve. Use this to browse external websites.',
      schema: {
        url: z.string().describe('The URL to navigate to (e.g. "https://example.com").'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ url, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for Baby Browser response. Make sure the Baby Browser mod is enabled and a Baby Browser tab is open.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'baby-browser-request',
            requestId,
            action: 'navigate',
            url,
          });
        });
      },
    },

    baby_browser_read: {
      description: 'Read the current page content from Baby Browser as simplified text. Returns the page title and body text with scripts/styles stripped. Useful for extracting information from web pages.',
      schema: {
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for Baby Browser response. Make sure the Baby Browser mod is enabled and a Baby Browser tab is open.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'baby-browser-request',
            requestId,
            action: 'read',
          });
        });
      },
    },

    baby_browser_url: {
      description: 'Get the current URL displayed in Baby Browser.',
      schema: {
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for Baby Browser response. Make sure the Baby Browser mod is enabled and a Baby Browser tab is open.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'baby-browser-request',
            requestId,
            action: 'url',
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving Baby Browser results.
 */
function registerRoutes(app, context) {
  app.post('/api/baby-browser/result', (req, res) => {
    const { requestId, result, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      // Already resolved (timeout or duplicate from another tab)
      return res.json({ accepted: false });
    }

    // Accept first response, discard duplicates
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else {
      pending.resolve({
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      });
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/browser-console/browser-console.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useRef, useCallback } = React;

const MAX_ENTRIES = 500;

const LEVEL_COLORS = {
  log: '#c9d1d9',
  info: '#58a6ff',
  warn: '#f0883e',
  error: '#f85149',
  debug: '#8b949e',
};

const LEVEL_BG = {
  warn: 'rgba(240,136,62,0.06)',
  error: 'rgba(248,81,73,0.06)',
};

/**
 * Safely serialize a value for transport. Handles DOM elements,
 * functions, errors, circular references, and large values.
 */
function safeSerialize(value, depth = 0) {
  if (depth > 4) return '[max depth]';
  if (value === null) return null;
  if (value === undefined) return undefined;

  const type = typeof value;
  if (type === 'string') return value.length > 2000 ? value.slice(0, 2000) + '...[truncated]' : value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (type === 'symbol') return value.toString();
  if (type === 'bigint') return value.toString() + 'n';

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  // DOM elements
  if (value instanceof parent.window.HTMLElement) {
    const tag = value.tagName.toLowerCase();
    const id = value.id ? `#${value.id}` : '';
    const cls = value.className && typeof value.className === 'string'
      ? '.' + value.className.trim().split(/\s+/).join('.')
      : '';
    return `[${tag}${id}${cls}]`;
  }

  if (value instanceof parent.window.NodeList || value instanceof parent.window.HTMLCollection) {
    return `[NodeList(${value.length})]`;
  }

  if (Array.isArray(value)) {
    if (value.length > 100) return `[Array(${value.length})]`;
    return value.map(v => safeSerialize(v, depth + 1));
  }

  if (type === 'object') {
    try {
      const keys = Object.keys(value);
      if (keys.length > 50) return `[Object(${keys.length} keys)]`;
      const result = {};
      for (const k of keys) {
        result[k] = safeSerialize(value[k], depth + 1);
      }
      return result;
    } catch {
      return '[Object]';
    }
  }

  return String(value);
}

/**
 * Format console args into a display string.
 */
function formatArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 2); }
    catch { return String(a); }
  }).join(' ');
}

function ConsoleEntry({ entry }) {
  const color = LEVEL_COLORS[entry.level] || '#c9d1d9';
  const bg = LEVEL_BG[entry.level] || 'transparent';
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div style={{
      padding: '4px 10px',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      background: bg,
      fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace',
      fontSize: 12,
      lineHeight: '18px',
      display: 'flex',
      gap: 8,
    }}>
      <span style={{ color: '#484f58', flexShrink: 0, userSelect: 'none' }}>{time}</span>
      <span style={{
        color: LEVEL_COLORS[entry.level],
        flexShrink: 0,
        width: 36,
        textAlign: 'right',
        userSelect: 'none',
        fontWeight: entry.level === 'error' ? 600 : 400,
      }}>
        {entry.level}
      </span>
      <span style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
        {entry.text}
      </span>
    </div>
  );
}

function ConsolePanel() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const entriesRef = useRef([]);
  const listRef = useRef(null);
  const autoScrollRef = useRef(true);

  // Track scroll position for auto-scroll behavior
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries]);

  useEffect(() => {
    let unsubEval = null;
    let unsubConsole = null;
    const parentWin = parent.window;
    const parentDoc = parent.document;
    const levels = ['log', 'warn', 'error', 'info', 'debug'];
    const cleanups = [];

    function addEntry(level, text) {
      const entry = { level, text, timestamp: Date.now() };
      entriesRef.current.push(entry);
      if (entriesRef.current.length > MAX_ENTRIES) {
        entriesRef.current = entriesRef.current.slice(-MAX_ENTRIES);
      }
      setEntries([...entriesRef.current]);
    }

    function setupCapture() {
      // 1. Patch console.* on parent window to capture application logs
      const origConsole = {};
      for (const level of levels) {
        origConsole[level] = parentWin.console[level];
        parentWin.console[level] = (...args) => {
          origConsole[level].apply(parentWin.console, args);
          addEntry(level, formatArgs(args.map(a => safeSerialize(a))));
        };
      }
      cleanups.push(() => {
        for (const level of levels) parentWin.console[level] = origConsole[level];
      });

      // 2. Uncaught JS errors (window.onerror fires for runtime errors)
      const onError = (event) => {
        // Resource load errors (img, script, link) — event.target is the element
        if (event.target && event.target !== parentWin) {
          const el = event.target;
          const tag = el.tagName?.toLowerCase() || '?';
          const src = el.src || el.href || '';
          if (src) addEntry('error', `Failed to load <${tag}>: ${src}`);
          return;
        }
        // JS runtime errors
        const { message, filename, lineno, colno } = event;
        const loc = filename ? ` (${filename}:${lineno}:${colno})` : '';
        addEntry('error', `${message}${loc}`);
      };
      // Use capture phase to catch resource load errors (they don't bubble)
      parentWin.addEventListener('error', onError, true);
      cleanups.push(() => parentWin.removeEventListener('error', onError, true));

      // 3. Unhandled promise rejections
      const onRejection = (event) => {
        const reason = event.reason;
        const text = reason instanceof Error
          ? `Unhandled rejection: ${reason.message}\n${reason.stack || ''}`
          : `Unhandled rejection: ${String(reason)}`;
        addEntry('error', text);
      };
      parentWin.addEventListener('unhandledrejection', onRejection);
      cleanups.push(() => parentWin.removeEventListener('unhandledrejection', onRejection));

      // 4. CSP violations
      const onCSP = (event) => {
        addEntry('error', `CSP violation: ${event.violatedDirective} — blocked ${event.blockedURI || 'inline'}`);
      };
      parentDoc.addEventListener('securitypolicyviolation', onCSP);
      cleanups.push(() => parentDoc.removeEventListener('securitypolicyviolation', onCSP));

      // 5. Wrap WebSocket to capture connection errors
      const OrigWebSocket = parentWin.WebSocket;
      parentWin.WebSocket = function(...args) {
        const ws = new OrigWebSocket(...args);
        ws.addEventListener('error', () => {
          addEntry('error', `WebSocket error: ${args[0]}`);
        });
        ws.addEventListener('close', (e) => {
          if (e.code !== 1000 && e.code !== 1005) {
            addEntry('warn', `WebSocket closed: ${args[0]} (code ${e.code}${e.reason ? ', ' + e.reason : ''})`);
          }
        });
        return ws;
      };
      parentWin.WebSocket.prototype = OrigWebSocket.prototype;
      // Preserve static properties (CONNECTING, OPEN, CLOSING, CLOSED)
      Object.keys(OrigWebSocket).forEach(k => { parentWin.WebSocket[k] = OrigWebSocket[k]; });
      cleanups.push(() => { parentWin.WebSocket = OrigWebSocket; });

      // 6. Handle browser_eval MCP requests
      unsubEval = window.deepsteve.onBrowserEvalRequest(async (req) => {
        let result, error;
        try {
          const fn = new parentWin.Function(req.code);
          result = fn();
          if (result && typeof result.then === 'function') result = await result;
          result = safeSerialize(result);
          if (result === undefined) result = 'undefined';
        } catch (e) {
          error = e.message || String(e);
        }
        try {
          await fetch('/api/browser-console/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: req.requestId, result, error }),
          });
        } catch {}
      });

      // 7. Handle browser_console MCP requests
      unsubConsole = window.deepsteve.onBrowserConsoleRequest(async (req) => {
        let filtered = entriesRef.current;
        if (req.level && req.level !== 'all') {
          filtered = filtered.filter(e => e.level === req.level);
        }
        if (req.search) {
          const s = req.search.toLowerCase();
          filtered = filtered.filter(e => e.text.toLowerCase().includes(s));
        }
        const limit = req.limit || 50;
        const sliced = filtered.slice(-limit).reverse();
        const result = sliced.map(e => {
          const time = new Date(e.timestamp).toISOString();
          return `[${time}] [${e.level}] ${e.text}`;
        }).join('\n') || '(no console entries captured)';
        try {
          await fetch('/api/browser-console/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: req.requestId, result }),
          });
        } catch {}
      });
    }

    // Bridge API is injected by the parent after iframe load event,
    // so it may not be available yet when this effect runs. Poll for it.
    if (window.deepsteve) {
      setupCapture();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) {
          clearInterval(poll);
          setupCapture();
        } else if (++attempts > 100) {
          clearInterval(poll);
        }
      }, 100);
    }

    return () => {
      for (const fn of cleanups) { try { fn(); } catch {} }
      if (unsubEval) unsubEval();
      if (unsubConsole) unsubConsole();
    };
  }, []);

  const clearEntries = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  // Apply level filter
  const filtered = filter === 'all' ? entries : entries.filter(e => e.level === filter);

  // Count errors/warnings for header
  const errorCount = entries.filter(e => e.level === 'error').length;
  const warnCount = entries.filter(e => e.level === 'warn').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc' }}>Console</span>

        {errorCount > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 8,
            background: 'rgba(248,81,73,0.15)', color: '#f85149',
            border: '1px solid rgba(248,81,73,0.3)',
          }}>
            {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>
        )}
        {warnCount > 0 && (
          <span style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 8,
            background: 'rgba(240,136,62,0.15)', color: '#f0883e',
            border: '1px solid rgba(240,136,62,0.3)',
          }}>
            {warnCount} warn{warnCount !== 1 ? 's' : ''}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Level filter buttons */}
        <div style={{ display: 'flex', gap: 2 }}>
          {['all', 'error', 'warn', 'log', 'info', 'debug'].map(level => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              style={{
                padding: '2px 6px',
                fontSize: 10,
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
                background: filter === level ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                color: filter === level ? '#fff' : '#8b949e',
              }}
            >
              {level}
            </button>
          ))}
        </div>

        <button
          onClick={clearEntries}
          title="Clear console"
          style={{
            background: 'none', border: 'none', color: '#8b949e',
            cursor: 'pointer', fontSize: 12, padding: '2px 6px',
            borderRadius: 3,
          }}
          onMouseEnter={e => e.target.style.color = '#f0f6fc'}
          onMouseLeave={e => e.target.style.color = '#8b949e'}
        >
          Clear
        </button>
      </div>

      {/* Console entries */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto' }}
      >
        {filtered.length === 0 ? (
          <div style={{
            padding: 24, textAlign: 'center', color: '#8b949e', fontSize: 13,
          }}>
            {entries.length === 0
              ? 'Console output will appear here. Claude sessions can use browser_eval and browser_console MCP tools.'
              : 'No entries match the current filter.'}
          </div>
        ) : (
          filtered.map((entry, i) => <ConsoleEntry key={i} entry={entry} />)
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('console-root'));
root.render(<ConsolePanel />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/browser-console/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #console-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="console-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="browser-console.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/browser-console/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Console",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Browser console passthrough for Agent sessions",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 400, "minWidth": 200 },
  "toolbar": { "label": "Console" },
  "tools": [
    { "name": "browser_eval", "description": "Execute JavaScript in the browser context" },
    { "name": "browser_console", "description": "Read captured browser console entries" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/browser-console/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');
const { randomUUID } = require('crypto');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 10000;

/**
 * Initialize browser console MCP tools.
 */
function init(context) {
  const { broadcast, broadcastToWindow, shells } = context;

  // Resolve session_id to a windowId, returning the send function and optional targetWindowId
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }), targetWindowId: windowId };
      }
    }
    return { send: broadcast };
  }

  return {
    browser_eval: {
      description: 'Execute JavaScript code in the deepsteve management UI browser tab and return the result. IMPORTANT: This runs in the deepsteve web interface only — it cannot access external websites, your project\'s frontend, or any other browser tab. Use this to inspect deepsteve\'s own DOM state (sessions, tabs, mods, layout), check for deepsteve UI errors, or read deepsteve element properties.',
      schema: {
        code: z.string().describe('JavaScript code to execute in the browser. Has full access to the DOM and page globals. Async code is supported (the return value is awaited).'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ code, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Console mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'browser-eval-request',
            requestId,
            code,
          });
        });
      },
    },

    browser_console: {
      description: 'Read recent browser console entries (log, warn, error, info, debug) from the deepsteve management UI tab. IMPORTANT: This only captures console output from the deepsteve web interface itself — it cannot read console logs from external websites, your project\'s frontend, or any other browser tab. Useful for debugging deepsteve UI issues without asking the user to check devtools.',
      schema: {
        level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).optional().describe('Filter by log level. Defaults to "all".'),
        limit: z.number().optional().describe('Maximum number of entries to return (most recent first). Defaults to 50.'),
        search: z.string().optional().describe('Filter entries containing this substring (case-insensitive).'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ level, limit, search, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Console mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'browser-console-request',
            requestId,
            level: level || 'all',
            limit: limit || 50,
            search: search || '',
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving browser results.
 */
function registerRoutes(app, context) {
  app.post('/api/browser-console/result', (req, res) => {
    const { requestId, result, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      // Already resolved (timeout or duplicate from another tab)
      return res.json({ accepted: false });
    }

    // Accept first response, discard duplicates
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else {
      pending.resolve({
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      });
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/deepsteve-core/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "DeepSteve Core",
  "version": "0.6.0",
  "minDeepsteveVersion": "0.4.0",
  "enabledByDefault": true,
  "description": "Session info, session close, issue spawning, terminal spawning",
  "tools": [
    { "name": "get_session_info", "description": "Get session metadata by deepsteve session ID" },
    { "name": "close_session", "description": "Close a session and its browser tab" },
    { "name": "start_issue", "description": "Open a new deepsteve session for a GitHub issue" },
    { "name": "open_terminal", "description": "Open a new terminal session with an optional prompt" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/deepsteve-core/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');
const { randomUUID } = require('crypto');
const path = require('path');

function init(context) {
  const {
    shells, closeSession, spawnAgent, getSpawnArgs, getAgentConfig, wireShellOutput,
    watchClaudeSessionDir, unwatchClaudeSessionDir, saveState,
    validateWorktree, ensureWorktree, submitToShell,
    fetchIssueFromGitHub, deliverPromptWhenReady,
    reloadClients, pendingOpens, settings, log, isShuttingDown,
  } = context;

  // Notify browser to open a new session tab, targeting the caller's window
  function notifyOpenSession(id, cwd, name, windowId) {
    const readyClients = [...reloadClients].filter(c => c.readyState === 1);
    const openMsg = JSON.stringify({ type: 'open-session', id, cwd, name, windowId });
    let delivered = false;

    if (windowId) {
      for (const client of readyClients) {
        if (client.windowId === windowId && client.readyState === 1) {
          client.send(openMsg);
          delivered = true;
          break;
        }
      }
      if (!delivered && readyClients.length > 0) {
        const broadcastMsg = JSON.stringify({ type: 'open-session', id, cwd, name });
        for (const client of readyClients) {
          if (client.readyState === 1) client.send(broadcastMsg);
        }
        delivered = true;
      }
      if (!delivered) {
        pendingOpens.push(openMsg);
        delivered = true;
      }
    }
    if (!delivered && readyClients.length > 0) {
      readyClients[0].send(JSON.stringify({ type: 'open-session', id, cwd, name }));
      delivered = true;
    }
    if (!delivered) {
      pendingOpens.push(JSON.stringify({ type: 'open-session', id, cwd, name }));
    }
  }

  return {
    get_session_info: {
      description: 'Get session metadata (tab name, cwd, worktree) for a deepsteve session. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get the session ID.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
      },
      handler: async ({ session_id }) => {
        const entry = shells.get(session_id);
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        const fallbackName = entry.cwd ? path.basename(entry.cwd) : 'shell';
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id: session_id,
            name: entry.name || fallbackName || 'root',
            cwd: entry.cwd,
            worktree: entry.worktree || null,
            windowId: entry.windowId || null,
            createdAt: entry.createdAt || null,
            elapsedMs: entry.createdAt ? Date.now() - entry.createdAt : null,
          }, null, 2) }]
        };
      },
    },
    close_session: {
      description: 'Close a deepsteve session and its browser tab. Gracefully terminates the Claude process. Call this when your work is complete and you want to clean up.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID to close. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
      },
      handler: async ({ session_id }) => {
        if (!closeSession(session_id)) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        return { content: [{ type: 'text', text: `Session "${session_id}" closed.` }] };
      },
    },
    start_issue: {
      description: 'Open a new deepsteve session for a GitHub issue. Fetches the issue body from GitHub, creates a worktree, and starts an agent with the issue prompt. Pass your DEEPSTEVE_SESSION_ID so the new tab opens in the same browser window.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to inherit context'),
        number: z.number().describe('GitHub issue number'),
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (if omitted, fetched from GitHub via gh CLI)'),
        labels: z.string().optional().describe('Comma-separated labels'),
        url: z.string().optional().describe('Issue URL'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s)'),
      },
      handler: async ({ session_id, number, title, body, labels, url, cwd, agent_type }) => {
        const caller = shells.get(session_id);
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }

        // Inherit from caller, allow overrides
        const effectiveCwd = cwd || caller.cwd;
        const effectiveAgentType = agent_type || caller.agentType || 'claude';
        const windowId = caller.windowId || null;

        // Build prompt helper
        function buildPrompt(issueBody, issueLabels, issueUrl) {
          const vars = {
            number,
            title,
            labels: issueLabels || 'none',
            url: issueUrl || '',
            body: issueBody ? String(issueBody).slice(0, 2000) : '(no description)',
          };
          return settings.wandPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
        }

        // When body is provided inline, build prompt synchronously
        const prompt = body ? buildPrompt(body, labels, url) : null;

        const worktree = validateWorktree('github-issue-' + number);
        const id = randomUUID().slice(0, 8);
        const claudeSessionId = randomUUID();
        const agentConfig = getAgentConfig(effectiveAgentType);

        // For agents that don't support --worktree natively: manually create worktree
        let spawnCwd = effectiveCwd;
        if (worktree && !agentConfig.supportsWorktree) {
          spawnCwd = ensureWorktree(effectiveCwd, worktree);
        }

        const spawnArgs = getSpawnArgs(effectiveAgentType, {
          sessionId: claudeSessionId,
          planMode: settings.wandPlanMode,
          worktree,
        });

        const maxLen = settings.maxIssueTitleLength || 25;
        const tabTitle = `#${number} ${title}`;
        const name = tabTitle.length <= maxLen ? tabTitle : tabTitle.slice(0, maxLen) + '\u2026';

        log(`[MCP] start_issue #${number}: id=${id}, agent=${effectiveAgentType}, worktree=${worktree || 'none'}, cwd=${spawnCwd}`);
        const shell = spawnAgent(effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
        shells.set(id, {
          shell, clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          worktree: worktree || null, windowId,
          name, initialPrompt: prompt,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);

        // For non-BEL agents with a synchronous prompt, deliver after delay
        if (prompt && agentConfig.initialPromptDelay > 0) {
          shells.get(id).initialPrompt = null;
          setTimeout(() => submitToShell(shell, prompt), agentConfig.initialPromptDelay);
        }

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        shell.onExit(() => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

        // When body was NOT provided, fetch async and deliver prompt when ready
        if (!body) {
          fetchIssueFromGitHub(number, effectiveCwd).then(gh => {
            const issueBody = gh ? gh.body : null;
            const issueLabels = gh ? (labels || (Array.isArray(gh.labels) ? gh.labels.map(l => typeof l === 'string' ? l : l.name).join(', ') : null)) : labels;
            const issueUrl = gh ? (url || gh.url) : url;
            const asyncPrompt = buildPrompt(issueBody, issueLabels, issueUrl);
            deliverPromptWhenReady(id, asyncPrompt);
          });
        }

        notifyOpenSession(id, spawnCwd, name, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name, cwd: spawnCwd, worktree: worktree || null }) }] };
      },
    },
    open_terminal: {
      description: 'Open a new deepsteve terminal session (new browser tab). Inherits context (cwd, worktree, windowId, agentType) from the calling session. Pass your DEEPSTEVE_SESSION_ID so the new tab opens in the same browser window.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to inherit context'),
        prompt: z.string().optional().describe('Initial prompt to send to the new session'),
        name: z.string().optional().describe('Tab name for the new session'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        worktree: z.string().optional().describe('Worktree name'),
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s)'),
        plan_mode: z.boolean().optional().describe('Start in plan mode'),
        fork: z.boolean().optional().describe('Fork the calling session\'s Claude conversation into the new tab'),
      },
      handler: async ({ session_id, prompt, name, cwd, worktree, agent_type, plan_mode, fork }) => {
        const caller = shells.get(session_id);
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }

        // Inherit from caller, allow overrides
        const effectiveCwd = cwd || caller.cwd;
        const effectiveAgentType = agent_type || caller.agentType || 'claude';
        const effectiveWorktree = worktree !== undefined ? (worktree || null) : (caller.worktree || null);
        const windowId = caller.windowId || null;
        const agentConfig = getAgentConfig(effectiveAgentType);

        // Validate and prepare worktree
        const validatedWorktree = effectiveWorktree ? validateWorktree(effectiveWorktree) : null;
        let spawnCwd = effectiveCwd;
        if (validatedWorktree && !agentConfig.supportsWorktree) {
          spawnCwd = ensureWorktree(effectiveCwd, validatedWorktree);
        }

        const id = randomUUID().slice(0, 8);
        const claudeSessionId = randomUUID();

        let spawnArgs;
        if (fork && caller.claudeSessionId) {
          // Fork: resume caller's conversation into a new forked session
          spawnArgs = ['--resume', caller.claudeSessionId, '--fork-session', '--session-id', claudeSessionId];
          if (validatedWorktree) spawnArgs.push('--worktree', validatedWorktree);
        } else {
          spawnArgs = getSpawnArgs(effectiveAgentType, {
            sessionId: claudeSessionId,
            planMode: plan_mode || false,
            worktree: validatedWorktree,
          });
        }

        const tabName = name || (validatedWorktree ? validatedWorktree : undefined);

        log(`[MCP] open_terminal: id=${id}, agent=${effectiveAgentType}, worktree=${validatedWorktree || 'none'}, cwd=${spawnCwd}, caller=${session_id}`);
        const shell = spawnAgent(effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
        shells.set(id, {
          shell, clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          worktree: validatedWorktree, windowId,
          name: tabName, initialPrompt: prompt || null,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);

        // For non-BEL agents, deliver initialPrompt after delay
        if (prompt && agentConfig.initialPromptDelay > 0) {
          shells.get(id).initialPrompt = null;
          setTimeout(() => submitToShell(shell, prompt), agentConfig.initialPromptDelay);
        }

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        shell.onExit(() => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

        notifyOpenSession(id, spawnCwd, tabName, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: spawnCwd, worktree: validatedWorktree }) }] };
      },
    },
  };
}

module.exports = { init };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/display-tab/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Display Tab",
  "version": "0.1.0",
  "enabledByDefault": true,
  "description": "MCP tools for creating, updating, and closing HTML display tabs in the browser",
  "tools": [
    { "name": "create_display_tab", "description": "Create a new browser tab displaying arbitrary HTML content" },
    { "name": "update_display_tab", "description": "Update the HTML content of an existing display tab" },
    { "name": "close_display_tab", "description": "Close a display tab" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/display-tab/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');
const { randomUUID } = require('crypto');

function init(context) {
  const { shells, reloadClients, pendingOpens, log, displayTabs } = context;

  return {
    create_display_tab: {
      description: 'Create a new browser tab displaying arbitrary HTML content (charts, dashboards, reports). The HTML is rendered in a sandboxed iframe. Pass your DEEPSTEVE_SESSION_ID so the tab opens in the same browser window.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to target the correct browser window'),
        html: z.string().describe('Full HTML content to display (can include inline CSS/JS, e.g. Chart.js visualizations)'),
        name: z.string().optional().describe('Tab name (defaults to "Display")'),
      },
      handler: async ({ session_id, html, name }) => {
        const caller = shells.get(session_id);
        const windowId = caller?.windowId || null;
        const tabName = name || 'Display';
        const id = randomUUID().slice(0, 8);

        displayTabs.set(id, html);
        log(`[MCP] create_display_tab: id=${id}, name=${tabName}, caller=${session_id}`);

        // Notify browser to open the display tab (same window-targeting as open_terminal)
        const readyClients = [...reloadClients].filter(c => c.readyState === 1);
        const openMsg = JSON.stringify({ type: 'open-display-tab', id, name: tabName, windowId });
        let delivered = false;

        if (windowId) {
          for (const client of readyClients) {
            if (client.windowId === windowId && client.readyState === 1) {
              client.send(openMsg);
              delivered = true;
              break;
            }
          }
          if (!delivered && readyClients.length > 0) {
            const broadcastMsg = JSON.stringify({ type: 'open-display-tab', id, name: tabName });
            for (const client of readyClients) {
              if (client.readyState === 1) client.send(broadcastMsg);
            }
            delivered = true;
          }
          if (!delivered) {
            pendingOpens.push(openMsg);
            delivered = true;
          }
        }
        if (!delivered && readyClients.length > 0) {
          readyClients[0].send(JSON.stringify({ type: 'open-display-tab', id, name: tabName }));
          delivered = true;
        }
        if (!delivered) {
          pendingOpens.push(JSON.stringify({ type: 'open-display-tab', id, name: tabName }));
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName }) }] };
      },
    },

    update_display_tab: {
      description: 'Update the HTML content of an existing display tab. The iframe will reload with the new content.',
      schema: {
        tab_id: z.string().describe('The display tab ID returned by create_display_tab'),
        html: z.string().describe('New HTML content to display'),
      },
      handler: async ({ tab_id, html }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }

        displayTabs.set(tab_id, html);
        log(`[MCP] update_display_tab: id=${tab_id}`);

        // Broadcast to all clients so the iframe reloads
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update-display-tab', id: tab_id }));
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, updated: true }) }] };
      },
    },

    close_display_tab: {
      description: 'Close a display tab.',
      schema: {
        tab_id: z.string().describe('The display tab ID to close'),
      },
      handler: async ({ tab_id }) => {
        if (!displayTabs.has(tab_id)) {
          return { content: [{ type: 'text', text: `Display tab "${tab_id}" not found.` }] };
        }

        displayTabs.delete(tab_id);
        log(`[MCP] close_display_tab: id=${tab_id}`);

        // Broadcast to all clients to close the tab
        for (const client of reloadClients) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'close-display-tab', id: tab_id }));
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id: tab_id, closed: true }) }] };
      },
    },
  };
}

module.exports = { init };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/go-karts/go-karts.js" << 'DEEPSTEVE_FILE_EOF'
import * as THREE from 'three';

// ── Config ──────────────────────────────────────────────────────────────────

const KART_COLORS = [
  { body: 0xe53935, accent: 0xb71c1c, hex: '#e53935' },
  { body: 0x1e88e5, accent: 0x0d47a1, hex: '#1e88e5' },
  { body: 0xffb300, accent: 0xe65100, hex: '#ffb300' },
  { body: 0x43a047, accent: 0x1b5e20, hex: '#43a047' },
  { body: 0x8e24aa, accent: 0x4a148c, hex: '#8e24aa' },
  { body: 0x00acc1, accent: 0x006064, hex: '#00acc1' },
  { body: 0xf4511e, accent: 0xbf360c, hex: '#f4511e' },
  { body: 0xec407a, accent: 0x880e4f, hex: '#ec407a' },
];

const TRACK_RX = 28;
const TRACK_RZ = 16;
const TRACK_WIDTH = 7;
const TOTAL_LAPS = 3;
const START_ANGLE = Math.PI;

const MODE_GRID = 0;   // Behind the pack, click a kart
const MODE_COCKPIT = 1; // First-person inside the kart

const RACE_IDLE = 0, RACE_COUNTDOWN = 1, RACE_RUNNING = 2, RACE_FINISHED = 3;

// ── State ───────────────────────────────────────────────────────────────────

let sessions = [];
let raceState = RACE_IDLE;
let countdown = 3;
let raceStartTime = 0;
let raceElapsed = 0;
let results = [];
let viewMode = MODE_GRID;
let followId = null;
let terminalPanelEl = null;
let originalTermParent = null;
let originalTermNext = null;

const kartState = {};

// ── Pickup items ─────────────────────────────────────────────────────────────

const ITEM_TYPES = {
  burst:      { label: 'BURST',      color: 0xff9800, css: 'burst',      duration: 2 },
  slippery:   { label: 'SLIPPERY',   color: 0x4caf50, css: 'slippery',   duration: 5 },
  projectile: { label: 'PROJECTILE', color: 0x42a5f5, css: 'projectile', duration: 2 },
};
const ITEM_TYPE_KEYS = Object.keys(ITEM_TYPES);
const PICKUP_COUNT = 8;
const PICKUP_RADIUS = 1.2;

const ITEMS_ENABLED = false; // flip to true to re-enable pickup items

let pickupItems = []; // { angle, laneOffset, type, mesh, hidden, respawnAt }
let hazards = [];     // { angle, laneOffset, mesh, expiresAt }
let effectFlashTimeout = null;

// ── WASD input state ─────────────────────────────────────────────────────────

const input = { w: false, a: false, s: false, d: false, space: false };

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = true;
  if (k === ' ') input.space = true;
  startAudio();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = false;
  if (k === ' ') input.space = false;
});

// ── Audio (procedural engine via Web Audio) ─────────────────────────────────

let audioCtx = null, oscSaw = null, oscSq = null, gainNode = null, filterNode = null;

function startAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  filterNode = audioCtx.createBiquadFilter();
  filterNode.type = 'lowpass';
  filterNode.frequency.value = 300;
  filterNode.Q.value = 2;
  filterNode.connect(audioCtx.destination);

  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;
  gainNode.connect(filterNode);

  oscSaw = audioCtx.createOscillator();
  oscSaw.type = 'sawtooth';
  oscSaw.frequency.value = 65;
  oscSaw.connect(gainNode);
  oscSaw.start();

  oscSq = audioCtx.createOscillator();
  oscSq.type = 'square';
  oscSq.frequency.value = 130;
  const sqGain = audioCtx.createGain();
  sqGain.gain.value = 0.21;
  oscSq.connect(sqGain);
  sqGain.connect(gainNode);
  oscSq.start();
}

function updateEngineAudio() {
  if (!audioCtx || !gainNode) return;
  if (viewMode !== MODE_COCKPIT || !followId || !kartState[followId] || raceState !== RACE_RUNNING || kartState[followId].finished) {
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.1);
    return;
  }
  const k = kartState[followId];
  const t = Math.min(Math.max(k.speed / (k.baseSpeed * 1.3), 0), 1); // 0..1
  const freq = 65 + t * 135; // 65-200 Hz
  oscSaw.frequency.linearRampToValueAtTime(freq, audioCtx.currentTime + 0.05);
  oscSq.frequency.linearRampToValueAtTime(freq * 2, audioCtx.currentTime + 0.05);
  filterNode.frequency.linearRampToValueAtTime(300 + t * 800, audioCtx.currentTime + 0.05);
  gainNode.gain.linearRampToValueAtTime(0.021 + t * 0.049, audioCtx.currentTime + 0.05);
}

// ── Three.js setup ──────────────────────────────────────────────────────────

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 80, 160);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(20, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
scene.add(sun);

// ── Cockpit geometry (only visible in cockpit mode) ─────────────────────────

const cockpitGroup = new THREE.Group();
cockpitGroup.visible = false;
scene.add(cockpitGroup);

// Cockpit body parts (recolored to match player's kart in enterCockpit)
const cockpitBodyParts = [];

// Hood / nose cone — visible as the kart body at bottom of screen
{
  const hoodMat = new THREE.MeshPhongMaterial({ color: 0xe53935, shininess: 60 });
  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.7), hoodMat);
  hood.position.set(0, -0.35, -1.1);
  cockpitGroup.add(hood);
  cockpitBodyParts.push(hood);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.35), hoodMat);
  nose.position.set(0, -0.34, -1.5);
  cockpitGroup.add(nose);
  cockpitBodyParts.push(nose);
}

// Side fairings — colored panels framing the view
{
  const fairingMat = new THREE.MeshPhongMaterial({ color: 0xe53935, shininess: 50 });
  const leftFairing = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.7), fairingMat);
  leftFairing.position.set(-0.5, -0.25, -0.85);
  cockpitGroup.add(leftFairing);
  cockpitBodyParts.push(leftFairing);

  const rightFairing = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.7), fairingMat);
  rightFairing.position.set(0.5, -0.25, -0.85);
  cockpitGroup.add(rightFairing);
  cockpitBodyParts.push(rightFairing);
}

// Dashboard — dark box behind the steering wheel
{
  const dashMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, shininess: 20 });
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.1, 0.25), dashMat);
  dash.position.set(0, -0.28, -0.55);
  cockpitGroup.add(dash);
}

// Steering wheel — torus tilted toward the player
{
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x222222, shininess: 40 });
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.018, 8, 24), wheelMat);
  wheelRing.rotation.x = Math.PI * 0.3;
  wheelRing.position.set(0, -0.20, -0.65);
  cockpitGroup.add(wheelRing);

  const colMat = new THREE.MeshPhongMaterial({ color: 0x333333 });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 8), colMat);
  col.rotation.x = Math.PI * 0.3;
  col.position.set(0, -0.26, -0.58);
  cockpitGroup.add(col);

  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.012), colMat);
  bar.rotation.x = Math.PI * 0.3;
  bar.position.set(0, -0.20, -0.65);
  cockpitGroup.add(bar);
}

// Floor — flat surface at the bottom
{
  const floorMat = new THREE.MeshPhongMaterial({ color: 0x333333, shininess: 10 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.02, 0.7), floorMat);
  floor.position.set(0, -0.45, -0.65);
  cockpitGroup.add(floor);
}

// ── Build environment ───────────────────────────────────────────────────────

// Ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshLambertMaterial({ color: 0x3a7a3a })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
ground.receiveShadow = true;
scene.add(ground);

// Track ring
function makeTrackRing() {
  const segs = 80;
  const shape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    const fn = i === 0 ? 'moveTo' : 'lineTo';
    shape[fn]((TRACK_RX + TRACK_WIDTH / 2) * Math.cos(t), (TRACK_RZ + TRACK_WIDTH / 2) * Math.sin(t));
  }
  const hole = new THREE.Path();
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    const fn = i === 0 ? 'moveTo' : 'lineTo';
    hole[fn]((TRACK_RX - TRACK_WIDTH / 2) * Math.cos(t), (TRACK_RZ - TRACK_WIDTH / 2) * Math.sin(t));
  }
  shape.holes.push(hole);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 80), new THREE.MeshLambertMaterial({ color: 0x444444 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  mesh.receiveShadow = true;
  return mesh;
}
scene.add(makeTrackRing());

// Inner grass
{
  const segs = 64, irx = TRACK_RX - TRACK_WIDTH / 2 - 0.5, irz = TRACK_RZ - TRACK_WIDTH / 2 - 0.5;
  const shape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    shape[i === 0 ? 'moveTo' : 'lineTo'](irx * Math.cos(t), irz * Math.sin(t));
  }
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: 0x358035 }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.02; scene.add(m);
}

// Center dashed line
{
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI * 2;
    pts.push(new THREE.Vector3(TRACK_RX * Math.cos(t), 0.03, TRACK_RZ * Math.sin(t)));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x999999, dashSize: 0.5, gapSize: 0.5 })
  );
  line.computeLineDistances();
  scene.add(line);
}

// Curbs
{
  const group = new THREE.Group();
  for (let i = 0; i < 60; i++) {
    const t = (i / 60) * Math.PI * 2;
    const r = TRACK_RX - TRACK_WIDTH / 2 + 0.3, rz = TRACK_RZ - TRACK_WIDTH / 2 + 0.3;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.08, 0.5),
      new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? 0xe53935 : 0xffffff })
    );
    m.position.set(r * Math.cos(t), 0.04, rz * Math.sin(t));
    m.rotation.y = -t;
    group.add(m);
  }
  scene.add(group);
}

// Start/finish line
{
  const inner = TRACK_RX - TRACK_WIDTH / 2, n = Math.floor(TRACK_WIDTH / 0.8);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.05, 0.8),
      new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? 0xffffff : 0x111111 })
    );
    m.position.set(-(inner + i * 0.8 + 0.4), 0.03, 0);
    scene.add(m);
  }
}

// Grandstand
{
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 3), new THREE.MeshLambertMaterial({ color: 0xa0845a }));
  base.position.set(0, 1, 0); base.castShadow = true; g.add(base);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(7, 0.3, 3.5), new THREE.MeshLambertMaterial({ color: 0xc0a060 }));
  roof.position.set(0, 2.3, 0); roof.castShadow = true; g.add(roof);
  [0xe53935, 0x1e88e5, 0xffb300, 0x43a047, 0xec407a, 0x8e24aa].forEach((c, i) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshLambertMaterial({ color: c }));
    s.position.set(-2.2 + i * 0.9, 2.1, 0.8); g.add(s);
  });
  g.position.set(-(TRACK_RX + TRACK_WIDTH / 2 + 4), 0, 0);
  scene.add(g);
}

// Trees
function addTree(x, z, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * s, 0.2 * s, 1.5 * s, 6), new THREE.MeshLambertMaterial({ color: 0x5a3a1a }));
  trunk.position.y = 0.75 * s; trunk.castShadow = true; g.add(trunk);
  const foliage = new THREE.Mesh(new THREE.ConeGeometry(1.2 * s, 2.5 * s, 6), new THREE.MeshLambertMaterial({ color: 0x2a6a2a }));
  foliage.position.y = 2.5 * s; foliage.castShadow = true; g.add(foliage);
  g.position.set(x, 0, z); scene.add(g);
}
[[-38,-8,1.2],[-35,5,0.9],[36,-10,1.1],[38,6,1],[0,-24,1.3],[5,22,0.8],
 [-15,20,1],[20,-22,0.9],[-10,-20,1.1],[15,18,1.2],[-25,-15,0.8],[30,14,1.1]].forEach(t => addTree(...t));

// ── Kart mesh builder ───────────────────────────────────────────────────────

function createKartMesh(colorIdx) {
  const group = new THREE.Group();
  const c = KART_COLORS[colorIdx % KART_COLORS.length];
  const mat = new THREE.MeshPhongMaterial({ color: c.body, shininess: 60 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 0.9), mat);
  body.position.set(0, 0.35, 0); body.castShadow = true; group.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.7), mat);
  nose.position.set(0.9, 0.3, 0); nose.castShadow = true; group.add(nose);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.8), mat);
  spoiler.position.set(-0.85, 0.6, 0); group.add(spoiler);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.9), mat);
  wing.position.set(-0.85, 0.78, 0); group.add(wing);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 80 }));
  helmet.position.set(0, 0.7, 0); group.add(helmet);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.2), new THREE.MeshPhongMaterial({ color: 0x222222 }));
  visor.position.set(0.2, 0.68, 0); group.add(visor);

  const wg = new THREE.CylinderGeometry(0.18, 0.18, 0.22, 8);
  const wm = new THREE.MeshLambertMaterial({ color: 0x222222 });
  for (const [wx, wy, wz] of [[0.55,0.18,0.55],[0.55,0.18,-0.55],[-0.55,0.18,0.55],[-0.55,0.18,-0.55]]) {
    const w = new THREE.Mesh(wg, wm); w.position.set(wx, wy, wz); w.rotation.x = Math.PI / 2; w.castShadow = true; group.add(w);
  }

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.0), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.25 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(0, 0.02, 0); group.add(shadow);

  return group;
}

// Name label sprite
function createLabel(name, colorIdx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d');
  updateLabel(ctx, name, colorIdx);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(4, 0.75, 1);
  sprite.position.y = 1.8;
  sprite._canvas = c; sprite._ctx = ctx;
  return sprite;
}

function updateLabel(ctx, name, colorIdx, lap, finished) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const display = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
  const hex = KART_COLORS[colorIdx % KART_COLORS.length].hex;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  const tw = Math.max(display.length * 18 + 30, 80), x = (c.width - tw) / 2;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.fill();
  ctx.strokeStyle = hex; ctx.lineWidth = 3;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '22px "Press Start 2P", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(display, c.width / 2, 32);
  if (lap > 0 && !finished) { ctx.fillStyle = '#ffd700'; ctx.font = '14px "Press Start 2P", monospace'; ctx.fillText(`L${lap}/${TOTAL_LAPS}`, c.width / 2, 72); }
  if (finished) { ctx.fillStyle = '#ffd700'; ctx.font = '16px "Press Start 2P", monospace'; ctx.fillText('\u{1F3C1} FINISHED', c.width / 2, 72); }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

// ── Track helpers ───────────────────────────────────────────────────────────

// Reusable scratch vectors — never return these from public API
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function trackPos3D(angle, laneOffset = 0) {
  return new THREE.Vector3(
    (TRACK_RX + laneOffset) * Math.cos(angle), 0,
    (TRACK_RZ + laneOffset) * Math.sin(angle)
  );
}

/** Write track position into `out` — zero allocations. */
function trackPos3DTo(out, angle, laneOffset = 0) {
  return out.set((TRACK_RX + laneOffset) * Math.cos(angle), 0, (TRACK_RZ + laneOffset) * Math.sin(angle));
}

function trackTangent(angle) {
  return new THREE.Vector3(TRACK_RX * Math.sin(angle), 0, -TRACK_RZ * Math.cos(angle)).normalize();
}

/** Write track tangent into `out` — zero allocations. */
function trackTangentTo(out, angle) {
  return out.set(TRACK_RX * Math.sin(angle), 0, -TRACK_RZ * Math.cos(angle)).normalize();
}

// ── Pickup items: spawn, collect, use, visuals ──────────────────────────────

function createPickupMesh(type) {
  const info = ITEM_TYPES[type];
  const mat = new THREE.MeshPhongMaterial({ color: info.color, emissive: info.color, emissiveIntensity: 0.4, shininess: 80 });
  let geo;
  if (type === 'burst') geo = new THREE.OctahedronGeometry(0.35);
  else if (type === 'slippery') geo = new THREE.SphereGeometry(0.3, 12, 12);
  else geo = new THREE.ConeGeometry(0.25, 0.5, 8);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  scene.add(mesh);
  return mesh;
}

function spawnPickups() {
  for (const p of pickupItems) scene.remove(p.mesh);
  pickupItems = [];
  for (let i = 0; i < PICKUP_COUNT; i++) {
    const angle = (i / PICKUP_COUNT) * Math.PI * 2;
    const laneOffset = (Math.random() - 0.5) * (TRACK_WIDTH - 2);
    const type = ITEM_TYPE_KEYS[i % ITEM_TYPE_KEYS.length];
    const mesh = createPickupMesh(type);
    pickupItems.push({ angle, laneOffset, type, mesh, hidden: false, respawnAt: 0 });
  }
}

function clearHazards() {
  for (const h of hazards) scene.remove(h.mesh);
  hazards = [];
}

function createHazardMesh() {
  const geo = new THREE.CircleGeometry(0.8, 16);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4caf50, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  scene.add(mesh);
  return mesh;
}

function updatePickupVisuals(now) {
  if (!ITEMS_ENABLED) return;
  for (const p of pickupItems) {
    if (p.hidden) {
      p.mesh.visible = false;
      if (p.respawnAt && now / 1000 > p.respawnAt) {
        p.hidden = false;
        p.respawnAt = 0;
      }
      continue;
    }
    p.mesh.visible = true;
    trackPos3DTo(_v1, p.angle, p.laneOffset);
    p.mesh.position.set(_v1.x, 0.5 + Math.sin(now / 400 + p.angle * 3) * 0.15, _v1.z);
    p.mesh.rotation.y += 0.02;
  }
  // Expire hazards
  for (let i = hazards.length - 1; i >= 0; i--) {
    if (raceElapsed > hazards[i].expiresAt) {
      scene.remove(hazards[i].mesh);
      hazards.splice(i, 1);
    }
  }
}

function checkPickupCollisions(now) {
  if (!ITEMS_ENABLED || raceState !== RACE_RUNNING) return;
  const kartCount = Object.keys(kartState).length;
  for (const [id, k] of Object.entries(kartState)) {
    if (k.finished) continue;
    const isPlayer = viewMode === MODE_COCKPIT && id === followId;
    const laneOffset = isPlayer && k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    trackPos3DTo(_v1, k.angle, laneOffset);

    // Collect pickups
    if (!k.heldItem) {
      for (const p of pickupItems) {
        if (p.hidden) continue;
        trackPos3DTo(_v2, p.angle, p.laneOffset);
        if (_v1.distanceTo(_v2) < PICKUP_RADIUS) {
          k.heldItem = p.type;
          p.hidden = true;
          p.respawnAt = raceElapsed + 5;
          if (isPlayer) updateHUD();
          break;
        }
      }
    }

    // Hazard collision
    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];
      trackPos3DTo(_v2, h.angle, h.laneOffset);
      if (_v1.distanceTo(_v2) < 1.0 && (!k.activeEffect || k.activeEffect.type !== 'spinout')) {
        k.activeEffect = { type: 'spinout', expiresAt: raceElapsed + 1.5 };
        scene.remove(h.mesh);
        hazards.splice(i, 1);
      }
    }

    // AI item use
    if (!isPlayer && k.heldItem && Math.random() < 0.02) {
      useItem(id, k);
    }
  }
}

function useItem(id, k) {
  if (!k.heldItem) return;
  const type = k.heldItem;
  k.heldItem = null;

  if (type === 'burst') {
    k.activeEffect = { type: 'burst', expiresAt: raceElapsed + ITEM_TYPES.burst.duration };
  } else if (type === 'slippery') {
    const kartCount = Object.keys(kartState).length;
    const isPlayer = viewMode === MODE_COCKPIT && id === followId;
    const laneOffset = isPlayer && k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    hazards.push({
      angle: k.angle,
      laneOffset,
      mesh: createHazardMesh(),
      expiresAt: raceElapsed + ITEM_TYPES.slippery.duration,
    });
    const hPos = trackPos3D(k.angle, laneOffset);
    hazards[hazards.length - 1].mesh.position.set(hPos.x, 0.03, hPos.z);
  } else if (type === 'projectile') {
    // Hit nearest kart ahead
    let bestDist = Infinity, targetId = null;
    const kartCount = Object.keys(kartState).length;
    const isPlayer = viewMode === MODE_COCKPIT && id === followId;
    const myLane = isPlayer && k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    const myPos = trackPos3D(k.angle, myLane);
    const myTan = trackTangent(k.angle);

    for (const [oid, ok] of Object.entries(kartState)) {
      if (oid === id || ok.finished) continue;
      const oLane = (viewMode === MODE_COCKPIT && oid === followId && ok.laneOffset != null) ? ok.laneOffset : (ok.lane - (kartCount - 1) / 2) * 1.2;
      const oPos = trackPos3D(ok.angle, oLane);
      const diff = oPos.clone().sub(myPos);
      const ahead = diff.dot(myTan);
      if (ahead > 0 && ahead < bestDist) {
        bestDist = ahead;
        targetId = oid;
      }
    }
    if (targetId) {
      kartState[targetId].activeEffect = { type: 'hit', expiresAt: raceElapsed + ITEM_TYPES.projectile.duration };
    }
  }

  if (viewMode === MODE_COCKPIT && id === followId) {
    showEffectFlash(ITEM_TYPES[type].label);
    updateHUD();
  }
}

function showEffectFlash(text) {
  if (effectFlashTimeout) clearTimeout(effectFlashTimeout);
  let el = document.getElementById('effect-hud');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'effect-hud';
  el.textContent = text + '!';
  document.getElementById('hud').appendChild(el);
  effectFlashTimeout = setTimeout(() => { el.remove(); effectFlashTimeout = null; }, 600);
}

// ── Deepsteve bridge ────────────────────────────────────────────────────────

function initBridge() {
  let attempts = 0;
  const poll = setInterval(() => {
    if (window.deepsteve) {
      clearInterval(poll);
      window.deepsteve.onSessionsChanged((list) => {
        sessions = list;
        syncKarts();
        updateHUD();
      });
    } else if (++attempts > 100) clearInterval(poll);
  }, 100);
}

function syncKarts() {
  const liveIds = new Set(sessions.map(s => s.id));
  for (const id of Object.keys(kartState)) {
    if (!liveIds.has(id)) {
      scene.remove(kartState[id].mesh);
      scene.remove(kartState[id].label);
      delete kartState[id];
      if (followId === id) exitCockpit();
    }
  }
  let laneIdx = Object.keys(kartState).length;
  for (const s of sessions) {
    if (!kartState[s.id]) {
      const mesh = createKartMesh(laneIdx);
      scene.add(mesh);
      const label = createLabel(s.name, laneIdx);
      scene.add(label);
      kartState[s.id] = {
        angle: START_ANGLE, speed: 0,
        baseSpeed: 8 + Math.random() * 5,
        wobble: Math.random() * 1000,
        lap: 0, prevAngle: START_ANGLE,
        finished: false, finishTime: null,
        lane: laneIdx, mesh, label, name: s.name,
        heldItem: null, activeEffect: null,
      };
      laneIdx++;
    }
    const k = kartState[s.id];
    if (k.name !== s.name) {
      k.name = s.name;
      updateLabel(k.label._ctx, s.name, k.lane, k.lap, k.finished);
      k.label.material.map.needsUpdate = true;
    }
  }
}

// ── Camera ──────────────────────────────────────────────────────────────────

const cockpitCamPos = new THREE.Vector3();
const cockpitCamLook = new THREE.Vector3();

function updateCamera() {
  if (viewMode === MODE_GRID) {
    // Behind the pack at start line
    const startPos = trackPos3D(START_ANGLE, 0);
    const behind = trackTangent(START_ANGLE).multiplyScalar(-12);
    camera.position.set(startPos.x + behind.x, 5, startPos.z + behind.z + 2);
    camera.lookAt(startPos.x, 1, startPos.z);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  } else if (viewMode === MODE_COCKPIT && followId && kartState[followId]) {
    const k = kartState[followId];
    const kartCount = Object.keys(kartState).length;
    const laneOffset = k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    const pos = trackPos3D(k.angle, laneOffset);
    const tangent = trackTangent(k.angle);

    // First-person: driver's eye position (slightly above and behind center of kart)
    const targetPos = new THREE.Vector3(
      pos.x - tangent.x * 0.1,
      0.9,
      pos.z - tangent.z * 0.1
    );

    // Look ahead along the track
    const targetLook = new THREE.Vector3(
      pos.x + tangent.x * 8,
      0.7,
      pos.z + tangent.z * 8
    );

    // Smooth follow
    cockpitCamPos.lerp(targetPos, 0.12);
    cockpitCamLook.lerp(targetLook, 0.08);
    camera.position.copy(cockpitCamPos);
    camera.lookAt(cockpitCamLook);

    // Wider FOV for cockpit immersion
    camera.fov = 75;
    camera.updateProjectionMatrix();

    // Position cockpit geometry relative to camera
    cockpitGroup.position.copy(camera.position);
    cockpitGroup.quaternion.copy(camera.quaternion);
  }
}

// ── Cockpit mode ────────────────────────────────────────────────────────────

function enterCockpit(sessionId) {
  startAudio();
  followId = sessionId;
  viewMode = MODE_COCKPIT;

  // Initialize player lane offset from current lane position
  const k = kartState[sessionId];
  if (k) {
    const kartCount = Object.keys(kartState).length;
    k.laneOffset = (k.lane - (kartCount - 1) / 2) * 1.2;
  }
  if (k) {
    const kartCount = Object.keys(kartState).length;
    const laneOffset = (k.lane - (kartCount - 1) / 2) * 1.2;
    const pos = trackPos3D(k.angle, laneOffset);
    const tangent = trackTangent(k.angle);
    cockpitCamPos.set(pos.x - tangent.x * 0.1, 0.9, pos.z - tangent.z * 0.1);
    cockpitCamLook.set(pos.x + tangent.x * 8, 0.7, pos.z + tangent.z * 8);
  }

  // Hide the followed kart's mesh (we're inside it)
  if (k) k.mesh.visible = false;

  // Recolor cockpit body to match player's kart
  if (k) {
    const bodyColor = KART_COLORS[k.lane % KART_COLORS.length].body;
    for (const part of cockpitBodyParts) part.material.color.setHex(bodyColor);
  }

  cockpitGroup.visible = true;
  showTerminal(sessionId);
  onResize();
  updateHUD();
}

function exitCockpit() {
  if (followId && kartState[followId]) {
    kartState[followId].mesh.visible = true;
    delete kartState[followId].laneOffset;
  }
  cockpitGroup.visible = false;
  hideTerminal();
  followId = null;
  viewMode = MODE_GRID;
  onResize();
  updateHUD();
}

// ── Terminal (mounted inside the cockpit) ───────────────────────────────────
// The terminal is the real xterm DOM element from the parent document,
// positioned as a fixed overlay on the right side with CSS 3D perspective
// to look like a screen mounted on the kart's dashboard.

function showTerminal(sessionId) {
  hideTerminal();

  const parentDoc = parent.document;
  const termContainer = parentDoc.getElementById('term-' + sessionId);
  if (!termContainer) return;

  originalTermParent = termContainer.parentNode;
  originalTermNext = termContainer.nextSibling;

  // Create the dashboard-mounted screen in the parent document
  terminalPanelEl = parentDoc.createElement('div');
  terminalPanelEl.id = 'gokart-terminal-panel';
  terminalPanelEl.style.cssText = `
    position: fixed;
    bottom: 30px;
    right: 30px;
    width: 42%;
    height: 55%;
    z-index: 999;
    perspective: 800px;
    pointer-events: none;
  `;

  // The screen itself with 3D tilt to look like a dashboard-mounted display
  const screen = parentDoc.createElement('div');
  screen.id = 'gokart-screen';
  screen.style.cssText = `
    width: 100%;
    height: 100%;
    transform: rotateY(-8deg) rotateX(2deg);
    transform-origin: right center;
    border-radius: 8px;
    overflow: hidden;
    box-shadow:
      0 0 30px rgba(0, 200, 100, 0.15),
      0 0 60px rgba(0, 200, 100, 0.05),
      inset 0 0 1px rgba(255,255,255,0.1);
    border: 3px solid #333;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    pointer-events: auto;
  `;
  terminalPanelEl.appendChild(screen);

  // Header bar
  const header = parentDoc.createElement('div');
  header.style.cssText = `
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 10px; background: #161b22; border-bottom: 1px solid #333;
    font-family: 'Press Start 2P', monospace; flex-shrink: 0;
  `;

  const session = sessions.find(s => s.id === sessionId);
  const color = kartState[sessionId] ? KART_COLORS[kartState[sessionId].lane % KART_COLORS.length] : KART_COLORS[0];

  const nameRow = parentDoc.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

  const dot = parentDoc.createElement('div');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color.hex};box-shadow:0 0 6px ${color.hex};`;
  nameRow.appendChild(dot);

  const nameSpan = parentDoc.createElement('span');
  nameSpan.textContent = session ? session.name : sessionId;
  nameSpan.style.cssText = 'font-size:8px;color:#aaa;';
  nameRow.appendChild(nameSpan);
  header.appendChild(nameRow);

  const btnGroup = parentDoc.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:6px;';

  // Fullscreen button
  const fullBtn = parentDoc.createElement('button');
  fullBtn.textContent = '\u2922'; // expand icon
  fullBtn.title = 'Open terminal fullscreen';
  fullBtn.style.cssText = `
    background:transparent; border:1px solid #444; border-radius:3px;
    color:#8b949e; font-size:12px; padding:2px 6px; cursor:pointer;
    line-height:1;
  `;
  fullBtn.addEventListener('click', () => {
    if (window.deepsteve) window.deepsteve.focusSession(sessionId);
  });
  btnGroup.appendChild(fullBtn);
  header.appendChild(btnGroup);
  screen.appendChild(header);

  // Terminal wrapper
  const termWrapper = parentDoc.createElement('div');
  termWrapper.style.cssText = 'flex:1;overflow:hidden;';
  screen.appendChild(termWrapper);

  // Move the real terminal in
  termContainer.style.display = '';
  termContainer.classList.add('active');
  termWrapper.appendChild(termContainer);

  parentDoc.body.appendChild(terminalPanelEl);

  // Refit
  requestAnimationFrame(() => {
    if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(sessionId);
  });
}

function hideTerminal() {
  if (!terminalPanelEl) return;

  const termContainer = terminalPanelEl.querySelector('.terminal-container');
  if (termContainer && originalTermParent) {
    termContainer.classList.remove('active');
    if (originalTermNext) originalTermParent.insertBefore(termContainer, originalTermNext);
    else originalTermParent.appendChild(termContainer);
    const id = termContainer.id.replace('term-', '');
    requestAnimationFrame(() => {
      if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(id);
    });
  }

  terminalPanelEl.remove();
  terminalPanelEl = null;
  originalTermParent = null;
  originalTermNext = null;
}

window.addEventListener('unload', hideTerminal);

// Detect when mod container gets hidden (user clicked a tab directly)
{
  const modContainer = parent.document.getElementById('mod-container');
  if (modContainer) {
    const obs = new MutationObserver(() => {
      if (modContainer.style.display === 'none' && terminalPanelEl) {
        hideTerminal();
        if (viewMode === MODE_COCKPIT) {
          if (followId && kartState[followId]) kartState[followId].mesh.visible = true;
          cockpitGroup.visible = false;
          followId = null;
          viewMode = MODE_GRID;
          updateHUD();
        }
      }
    });
    obs.observe(modContainer, { attributes: true, attributeFilter: ['style'] });
  }
}

// ── Race control ────────────────────────────────────────────────────────────

function startRace() {
  if (sessions.length === 0) return;
  sessions.forEach((s, i) => {
    const k = kartState[s.id];
    if (!k) return;
    Object.assign(k, {
      angle: START_ANGLE + i * 0.06, speed: 0,
      baseSpeed: 8 + Math.random() * 5, wobble: Math.random() * 1000,
      workingMult: 1.15 + Math.random() * 0.10,
      lap: 0, prevAngle: START_ANGLE + i * 0.06,
      finished: false, finishTime: null, lane: i,
      heldItem: null, activeEffect: null,
    });
    // Re-init lane offset if player is in this kart
    if (viewMode === MODE_COCKPIT && followId === s.id) {
      const kartCount = sessions.length;
      k.laneOffset = (i - (kartCount - 1) / 2) * 1.2;
      k.mesh.visible = false;
      // Snap camera to new position to avoid lerp drift
      const pos = trackPos3D(k.angle, k.laneOffset);
      const tangent = trackTangent(k.angle);
      cockpitCamPos.set(pos.x - tangent.x * 0.1, 0.9, pos.z - tangent.z * 0.1);
      cockpitCamLook.set(pos.x + tangent.x * 8, 0.7, pos.z + tangent.z * 8);
    }
  });
  results = []; raceElapsed = 0;
  clearHazards();
  if (ITEMS_ENABLED) spawnPickups();
  raceState = RACE_COUNTDOWN; countdown = 3;
  updateHUD();

  let c = 3;
  const iv = setInterval(() => {
    if (--c > 0) { countdown = c; updateHUD(); }
    else { clearInterval(iv); countdown = 0; raceState = RACE_RUNNING; raceStartTime = performance.now(); updateHUD(); }
  }, 1000);
}

// ── Physics ─────────────────────────────────────────────────────────────────

function updatePhysics(now, dt) {
  if (raceState !== RACE_RUNNING) return;
  raceElapsed = (now - raceStartTime) / 1000;
  let allFinished = true;
  const finishOrder = [];
  const sm = {}; for (const s of sessions) sm[s.id] = s;

  for (const [id, k] of Object.entries(kartState)) {
    if (k.finished) { finishOrder.push({ id, time: k.finishTime }); continue; }
    allFinished = false;

    const isPlayer = viewMode === MODE_COCKPIT && id === followId;

    // Player item use (spacebar, consume on press)
    if (ITEMS_ENABLED && isPlayer && input.space && k.heldItem) {
      input.space = false; // consume the press
      useItem(id, k);
    }

    // Expire active effects
    if (k.activeEffect && raceElapsed > k.activeEffect.expiresAt) {
      k.activeEffect = null;
      if (isPlayer) updateHUD();
    }

    if (isPlayer) {
      // WASD: W = gas, S = brake, A/D = steer (adjust lane offset)
      const gas = input.w ? 1 : 0;
      const brake = input.s ? 1 : 0;
      const targetSpeed = k.baseSpeed * (0.3 + gas * 0.9) * (1 - brake * 0.7);
      k.speed += (targetSpeed - k.speed) * 4 * dt;
      if (input.a) k.laneOffset = (k.laneOffset || 0) - 3.0 * dt;
      if (input.d) k.laneOffset = (k.laneOffset || 0) + 3.0 * dt;
      const maxOff = TRACK_WIDTH / 2 - 0.5;
      k.laneOffset = Math.max(-maxOff, Math.min(maxOff, k.laneOffset || 0));
    } else {
      const working = sm[id] && !sm[id].waitingForInput;
      const mult = working ? (k.workingMult || 1.2) : 0.9;
      const wobble = Math.sin(now / 600 + k.wobble) * 0.5;
      k.speed += (k.baseSpeed * mult + wobble - k.speed) * 3 * dt;
    }

    // Apply item effects to speed
    if (k.activeEffect) {
      if (k.activeEffect.type === 'burst') k.speed *= 1.8;
      else if (k.activeEffect.type === 'hit') k.speed *= 0.4;
      else if (k.activeEffect.type === 'spinout') k.speed *= 0.2;
    }

    const prev = k.angle;
    k.angle -= k.speed * dt * 0.02;
    while (k.angle < -Math.PI) k.angle += 2 * Math.PI;
    while (k.angle > Math.PI) k.angle -= 2 * Math.PI;
    if (prev < -Math.PI * 0.8 && k.angle > Math.PI * 0.8) {
      k.lap++;
      if (k.lap >= TOTAL_LAPS) { k.finished = true; k.finishTime = raceElapsed; finishOrder.push({ id, time: raceElapsed }); }
    }
  }

  checkPickupCollisions(now);

  if (allFinished || finishOrder.length === Object.keys(kartState).length) {
    finishOrder.sort((a, b) => a.time - b.time);
    results = finishOrder.map((f, i) => ({ id: f.id, name: sm[f.id]?.name || '???', time: f.time, position: i + 1 }));
    raceState = RACE_FINISHED;
    updateHUD();
  }
}

// ── Animation loop ──────────────────────────────────────────────────────────

let lastTime = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - (lastTime || now)) / 1000, 0.05);
  lastTime = now;

  updatePhysics(now, dt);

  const kartCount = Object.keys(kartState).length;
  for (const [id, k] of Object.entries(kartState)) {
    const isPlayer = viewMode === MODE_COCKPIT && id === followId;
    const laneOffset = isPlayer && k.laneOffset != null ? k.laneOffset : (k.lane - (kartCount - 1) / 2) * 1.2;
    const pos = trackPos3D(k.angle, laneOffset);
    k.mesh.position.copy(pos);
    const tan = trackTangent(k.angle);
    k.mesh.rotation.y = Math.atan2(-tan.z, tan.x);
    k.label.position.set(pos.x, 1.8, pos.z);
    updateLabel(k.label._ctx, k.name, k.lane, k.lap, k.finished);
    k.label.material.map.needsUpdate = true;
    // In cockpit mode: hide the followed kart, show all others
    k.mesh.visible = !(viewMode === MODE_COCKPIT && id === followId);
    k.label.visible = !(viewMode === MODE_COCKPIT && id === followId);
  }

  updatePickupVisuals(now);
  updateCamera();
  updateEngineAudio();

  if (raceState === RACE_RUNNING && Math.floor(now / 200) !== Math.floor((now - 16) / 200)) {
    updateHUD();
  }

  renderer.render(scene, camera);
}

// ── Raycaster ───────────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (viewMode === MODE_COCKPIT) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  for (const [id, k] of Object.entries(kartState)) {
    if (raycaster.intersectObject(k.mesh, true).length > 0) {
      enterCockpit(id);
      return;
    }
  }
});

// ── Resize ──────────────────────────────────────────────────────────────────

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// ── HUD ─────────────────────────────────────────────────────────────────────

const hud = document.getElementById('hud');

function updateHUD() {
  let html = '';

  // Header
  html += '<div id="header"><div style="display:flex;align-items:center">';
  html += '<h1>DEEPSTEVE GP</h1>';
  if (raceState === RACE_RUNNING) html += `<span class="timer">${raceElapsed.toFixed(1)}s</span>`;
  html += '</div><div style="display:flex;align-items:center;gap:10px">';
  if (viewMode === MODE_COCKPIT) html += '<button id="back-btn" class="hud-btn back">BACK</button>';
  if (sessions.length > 0 && raceState !== RACE_RUNNING && raceState !== RACE_COUNTDOWN) {
    const cls = raceState === RACE_FINISHED ? 'rematch' : 'start';
    html += `<button id="start-btn" class="hud-btn ${cls}">${raceState === RACE_FINISHED ? 'REMATCH' : 'START RACE'}</button>`;
  }
  html += `<span class="racers">${sessions.length} racer${sessions.length !== 1 ? 's' : ''}</span>`;
  html += '</div></div>';

  // Hint
  if (viewMode === MODE_GRID && sessions.length > 0 && raceState === RACE_IDLE) {
    html += '<div id="hint">Click a kart to get in!</div>';
  }

  // Countdown
  if (raceState === RACE_COUNTDOWN) {
    html += `<div id="countdown-overlay"><div class="num" style="color:${countdown <= 1 ? '#e53935' : '#ffd700'}">${countdown}</div></div>`;
  }

  // GO
  if (raceState === RACE_RUNNING && raceElapsed < 1) {
    html += `<div id="countdown-overlay" style="background:transparent;pointer-events:none"><div class="num" style="color:#43a047;opacity:${Math.max(0, 1 - raceElapsed)}">GO!</div></div>`;
  }

  // Leaderboard
  if (raceState === RACE_RUNNING || raceState === RACE_FINISHED) {
    html += '<div id="leaderboard">';
    html += `<div class="title">${raceState === RACE_FINISHED ? 'FINAL RESULTS' : `LAP ${currentMaxLap()} / ${TOTAL_LAPS}`}</div>`;
    html += buildLeaderboardHTML();
    html += '</div>';
  }

  // No sessions
  if (sessions.length === 0) html += '<div id="no-racers"><div class="big">NO RACERS</div><div class="small">Open some Claude sessions to see them on the track!</div></div>';

  // Winner
  if (raceState === RACE_FINISHED && results.length > 0) {
    const wn = results[0].name.length > 12 ? results[0].name.slice(0, 11) + '\u2026' : results[0].name;
    html += `<div id="winner-overlay"><div class="winner-name">${esc(wn)}</div><div class="wins">WINS!</div><div class="time">${results[0].time.toFixed(2)}s</div></div>`;
  }

  // Cockpit: lap display + item HUD (bottom-left)
  if (viewMode === MODE_COCKPIT && followId && kartState[followId]) {
    const k = kartState[followId];
    if (raceState === RACE_RUNNING && !k.finished) {
      html += `<div id="cockpit-hud">`;
      html += `<div class="lap-display">LAP <span style="color:#ffd700">${k.lap + 1}</span>/${TOTAL_LAPS}</div>`;
      html += `</div>`;
      if (k.heldItem) {
        const info = ITEM_TYPES[k.heldItem];
        html += `<div id="item-hud">`;
        html += `<div class="item-name ${info.css}">${info.label}</div>`;
        html += `<div class="item-hint">SPACE to use</div>`;
        html += `</div>`;
      }
    } else if (raceState === RACE_RUNNING && k.finished) {
      // Personal finish overlay — race still running for others
      const standings = getStandings();
      const pos = standings.findIndex(s => s.id === followId) + 1;
      html += `<div id="cockpit-hud">`;
      html += `<div class="lap-display" style="color:#ffd700">FINISHED ${k.finishTime.toFixed(2)}s</div>`;
      html += `</div>`;
      html += `<div id="player-finish-overlay">`;
      html += `<div class="finish-title">FINISHED!</div>`;
      html += `<div class="finish-position">P${pos}</div>`;
      html += `<div class="finish-time">${k.finishTime.toFixed(2)}s</div>`;
      html += `<div class="finish-waiting">Waiting for others...</div>`;
      html += `</div>`;
    }
  }

  hud.innerHTML = html;

  document.getElementById('start-btn')?.addEventListener('click', startRace);
  document.getElementById('back-btn')?.addEventListener('click', exitCockpit);
  document.querySelectorAll('[data-chase-id]').forEach(el => {
    el.addEventListener('click', () => enterCockpit(el.dataset.chaseId));
  });
}

function currentMaxLap() {
  let m = 0;
  for (const k of Object.values(kartState)) m = Math.max(m, k.lap + 1);
  return Math.min(m, TOTAL_LAPS);
}

function buildLeaderboardHTML() {
  const standings = getStandings();
  const medals = ['', '\u{1F947}', '\u{1F948}', '\u{1F949}'];
  let html = '';
  for (let i = 0; i < Math.min(standings.length, 8); i++) {
    const s = standings[i];
    const c = KART_COLORS[(kartState[s.id]?.lane || i) % KART_COLORS.length];
    const pos = raceState === RACE_FINISHED && i < 3 ? medals[i + 1] : `P${i + 1}`;
    const dn = s.name.length > 12 ? s.name.slice(0, 11) + '\u2026' : s.name;
    const active = s.id === followId ? 'active' : '';
    html += `<div class="row ${active}" data-chase-id="${s.id}" style="cursor:pointer">`;
    html += `<span class="pos" style="color:${i < 3 ? '#ffd700' : '#888'}">${pos}</span>`;
    html += `<div class="dot" style="background:${c.hex}"></div>`;
    html += `<span class="name">${esc(dn)}</span>`;
    html += `<span class="stat">${s.finished ? s.finishTime.toFixed(1) + 's' : 'L' + (s.lap + 1)}</span></div>`;
  }
  return html;
}

function getStandings() {
  if (raceState === RACE_FINISHED && results.length > 0) {
    return results.map(r => ({ id: r.id, name: r.name, lap: TOTAL_LAPS - 1, finished: true, finishTime: r.time }));
  }
  const sm = {}; for (const s of sessions) sm[s.id] = s;
  return Object.entries(kartState)
    .map(([id, k]) => ({ id, name: sm[id]?.name || '???', lap: k.lap, progress: k.lap + (START_ANGLE - k.angle + Math.PI) / (2 * Math.PI), finished: k.finished, finishTime: k.finishTime }))
    .sort((a, b) => { if (a.finished !== b.finished) return a.finished ? -1 : 1; if (a.finished && b.finished) return a.finishTime - b.finishTime; return b.progress - a.progress; });
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Start ───────────────────────────────────────────────────────────────────

initBridge();
onResize();
updateHUD();
requestAnimationFrame(animate);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/go-karts/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body { background: #000; height: 100vh; overflow: hidden; }
    #scene { width: 100%; height: 100%; }
    #hud {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      font-family: 'Press Start 2P', monospace;
    }
    #hud > * { pointer-events: auto; }
    #header {
      position: absolute; top: 0; left: 0; right: 0;
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 20px;
      background: linear-gradient(180deg, rgba(0,0,0,0.6) 0%, transparent 100%);
    }
    #header h1 {
      font-size: 16px; color: #fff; letter-spacing: 2px;
      text-shadow: 2px 2px 0 #000, 0 0 10px rgba(255,200,0,0.5);
    }
    #header .timer { font-size: 12px; color: #ffd700; text-shadow: 1px 1px 0 #000; margin-left: 14px; }
    #header .racers { font-size: 10px; color: #fff; text-shadow: 1px 1px 0 #000; }
    .hud-btn {
      border: 3px solid #fff; border-radius: 6px; color: #fff;
      font-family: 'Press Start 2P', monospace; font-size: 11px;
      padding: 8px 16px; cursor: pointer;
      text-shadow: 1px 1px 0 #000; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .hud-btn.start { background: #e53935; }
    .hud-btn.rematch { background: #43a047; }
    .hud-btn.back { background: #555; font-size: 9px; padding: 6px 12px; }
    #countdown-overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.3); z-index: 30;
    }
    #countdown-overlay .num {
      font-size: 120px; text-shadow: 4px 4px 0 #000, 0 0 40px rgba(255,200,0,0.6);
    }
    #leaderboard {
      position: absolute; bottom: 12px; left: 12px;
      background: rgba(0,0,0,0.75); border: 2px solid #ffd700;
      border-radius: 8px; padding: 10px 14px; min-width: 210px;
    }
    #leaderboard .title { font-size: 10px; color: #ffd700; margin-bottom: 8px; text-shadow: 1px 1px 0 #000; }
    #leaderboard .row {
      display: flex; align-items: center; gap: 8px; padding: 3px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    #leaderboard .row:last-child { border-bottom: none; }
    #leaderboard .pos { font-size: 10px; width: 22px; text-align: right; }
    #leaderboard .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    #leaderboard .name {
      font-size: 9px; color: #fff; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px;
    }
    #leaderboard .stat { font-size: 9px; color: #aaa; }
    #winner-overlay {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      text-align: center; pointer-events: none;
    }
    #winner-overlay .winner-name {
      font-size: 40px; color: #ffd700;
      text-shadow: 3px 3px 0 #000, 0 0 20px rgba(255,215,0,0.6);
      animation: winnerBounce 0.6s ease-in-out infinite alternate;
    }
    #winner-overlay .wins { font-size: 20px; color: #fff; margin-top: 8px; text-shadow: 2px 2px 0 #000; }
    #winner-overlay .time { font-size: 11px; color: #ccc; margin-top: 6px; text-shadow: 1px 1px 0 #000; }
    #no-racers {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      text-align: center; color: #fff; text-shadow: 2px 2px 0 #000;
    }
    #no-racers .big { font-size: 18px; margin-bottom: 12px; }
    #no-racers .small { font-size: 10px; color: #ccc; }
    #hint {
      position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
      font-size: 11px; color: #fff; text-shadow: 1px 1px 0 #000;
      background: rgba(0,0,0,0.5); padding: 8px 16px; border-radius: 6px;
      animation: hintPulse 2s ease-in-out infinite;
    }
    @keyframes hintPulse {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    #cockpit-hud {
      position: absolute; bottom: 20px; left: 20px;
      background: rgba(0,0,0,0.7); border: 2px solid #444;
      border-radius: 10px; padding: 10px 16px;
      text-align: center;
    }
    #cockpit-hud .lap-display {
      font-size: 10px; color: #ccc;
      text-shadow: 1px 1px 0 #000;
    }
    #leaderboard .row.active { background: rgba(255,215,0,0.15); border-radius: 4px; }
    @keyframes winnerBounce {
      0% { transform: translateY(0); }
      100% { transform: translateY(-10px); }
    }
    #item-hud {
      position: absolute; bottom: 60px; left: 20px;
      background: rgba(0,0,0,0.75); border: 2px solid #666;
      border-radius: 8px; padding: 8px 14px;
      font-size: 9px; color: #fff; text-shadow: 1px 1px 0 #000;
    }
    #item-hud .item-name { font-size: 11px; margin-bottom: 4px; }
    #item-hud .item-name.burst { color: #ff9800; }
    #item-hud .item-name.slippery { color: #4caf50; }
    #item-hud .item-name.projectile { color: #42a5f5; }
    #item-hud .item-hint { color: #aaa; font-size: 8px; }
    #effect-hud {
      position: absolute; top: 35%; left: 50%; transform: translate(-50%, -50%);
      font-size: 16px; color: #fff; text-shadow: 2px 2px 0 #000, 0 0 12px rgba(255,255,255,0.4);
      pointer-events: none; animation: effectFlash 0.5s ease-out forwards;
    }
    @keyframes effectFlash {
      0% { opacity: 1; transform: translate(-50%, -50%) scale(1.3); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
    }
    #player-finish-overlay {
      position: absolute; top: 30%; left: 50%; transform: translate(-50%, -50%);
      text-align: center; pointer-events: none;
      animation: finishFadeIn 0.5s ease-out forwards;
    }
    #player-finish-overlay .finish-title {
      font-size: 36px; color: #ffd700;
      text-shadow: 3px 3px 0 #000, 0 0 20px rgba(255,215,0,0.6);
    }
    #player-finish-overlay .finish-position {
      font-size: 20px; color: #fff; margin-top: 10px;
      text-shadow: 2px 2px 0 #000;
    }
    #player-finish-overlay .finish-time {
      font-size: 11px; color: #ccc; margin-top: 6px;
      text-shadow: 1px 1px 0 #000;
    }
    #player-finish-overlay .finish-waiting {
      font-size: 9px; color: #aaa; margin-top: 14px;
      text-shadow: 1px 1px 0 #000;
      animation: hintPulse 2s ease-in-out infinite;
    }
    @keyframes finishFadeIn {
      0% { opacity: 0; transform: translate(-50%, -60%) scale(0.8); }
      100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
  </style>
</head>
<body>
  <canvas id="scene"></canvas>
  <div id="hud"></div>

  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/"
    }
  }
  </script>
  <script type="module" src="go-karts.js"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/go-karts/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Go Karts",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "3D go-kart racing with your Claude sessions",
  "enabledByDefault": false,
  "tags": ["games"],
  "entry": "index.html",
  "toolbar": {
    "label": "Go Karts"
  }
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/messages/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      padding: 16px;
    }
    h3 { font-size: 14px; margin-bottom: 12px; font-weight: 600; }
    label {
      display: block;
      font-size: 12px;
      color: var(--ds-text-secondary, #8b949e);
      margin-bottom: 4px;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      background: var(--ds-bg-secondary, #161b22);
      color: var(--ds-text-primary, #c9d1d9);
      border: 1px solid var(--ds-border, #30363d);
      border-radius: 6px;
      padding: 8px;
      font-family: monospace;
      font-size: 12px;
      resize: vertical;
    }
    textarea:focus { outline: none; border-color: var(--ds-accent, #58a6ff); }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 0;
    }
    .toggle-row input[type="checkbox"] { accent-color: var(--ds-accent, #58a6ff); }
    .toggle-row span { font-size: 13px; }
    button {
      background: var(--ds-accent, #58a6ff);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 13px;
      cursor: pointer;
    }
    button:hover { opacity: 0.9; }
    .status {
      font-size: 12px;
      margin-top: 8px;
      color: var(--ds-text-secondary, #8b949e);
    }
    .hint {
      font-size: 11px;
      color: var(--ds-text-secondary, #8b949e);
      margin-top: 4px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <h3>Messages Settings</h3>

  <label for="contacts">Contacts (one per line: name:+1234567890)</label>
  <textarea id="contacts" placeholder="mom:+15551234567&#10;dad:+15559876543"></textarea>
  <div class="hint">Format: name:+phonenumber — one contact per line or comma-separated</div>

  <div class="toggle-row">
    <input type="checkbox" id="allowlist" checked>
    <span>Allowlist only (restrict to contacts above)</span>
  </div>

  <button id="save">Save</button>
  <div class="status" id="status"></div>

  <script>
    const contactsEl = document.getElementById('contacts');
    const allowlistEl = document.getElementById('allowlist');
    const statusEl = document.getElementById('status');

    async function load() {
      try {
        const res = await fetch('/api/messages/config');
        const config = await res.json();
        // Display contacts with newlines for readability
        contactsEl.value = (config.contacts || '').split(',').map(s => s.trim()).filter(Boolean).join('\n');
        allowlistEl.checked = config.allowlistEnabled !== false;
      } catch (e) {
        statusEl.textContent = 'Failed to load config';
      }
    }

    document.getElementById('save').addEventListener('click', async () => {
      // Normalize: newlines → commas
      const contacts = contactsEl.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean).join(',');
      try {
        const res = await fetch('/api/messages/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts, allowlistEnabled: allowlistEl.checked }),
        });
        if (res.ok) {
          statusEl.textContent = 'Saved!';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } else {
          statusEl.textContent = 'Save failed';
        }
      } catch (e) {
        statusEl.textContent = 'Save failed';
      }
    });

    load();
  </script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/messages/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Messages",
  "version": "1.0.0",
  "description": "Send texts with the Messages app on macOS - uses AppleScript",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 340, "minWidth": 200 },
  "toolbar": { "label": "Messages" },
  "tools": [
    { "name": "send_imessage", "description": "Send an iMessage/SMS to a contact" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/messages/tools.js" << 'DEEPSTEVE_FILE_EOF'
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
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/meta-ads/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      padding: 16px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    h3 { font-size: 14px; font-weight: 600; }
    .help-btn {
      background: none;
      border: 1px solid var(--ds-border, #30363d);
      color: var(--ds-text-secondary, #8b949e);
      border-radius: 50%;
      width: 22px;
      height: 22px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .help-btn:hover { color: var(--ds-text-primary, #c9d1d9); border-color: var(--ds-text-secondary, #8b949e); }
    label {
      display: block;
      font-size: 12px;
      color: var(--ds-text-secondary, #8b949e);
      margin-bottom: 4px;
      margin-top: 12px;
    }
    label:first-of-type { margin-top: 0; }
    input[type="text"] {
      width: 100%;
      background: var(--ds-bg-secondary, #161b22);
      color: var(--ds-text-primary, #c9d1d9);
      border: 1px solid var(--ds-border, #30363d);
      border-radius: 6px;
      padding: 8px;
      font-family: monospace;
      font-size: 12px;
    }
    input[type="text"]:focus { outline: none; border-color: var(--ds-accent, #58a6ff); }
    button.save {
      background: var(--ds-accent, #58a6ff);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 13px;
      cursor: pointer;
      margin-top: 16px;
    }
    button.save:hover { opacity: 0.9; }
    .status {
      font-size: 12px;
      margin-top: 8px;
      color: var(--ds-text-secondary, #8b949e);
    }
    .hint {
      font-size: 11px;
      color: var(--ds-text-secondary, #8b949e);
      margin-top: 4px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="header">
    <h3>Meta Ads Settings</h3>
    <button class="help-btn" id="help" title="Get help">?</button>
  </div>

  <label for="token">Access Token</label>
  <input type="text" id="token" placeholder="Your Meta access token">

  <label for="account">Ad Account ID</label>
  <input type="text" id="account" placeholder="act_123456789">
  <div class="hint">Find this in Meta Business Manager under Ad Account Settings</div>

  <button class="save" id="save">Save</button>
  <div class="status" id="status"></div>

  <script>
    const tokenEl = document.getElementById('token');
    const accountEl = document.getElementById('account');
    const statusEl = document.getElementById('status');

    async function load() {
      try {
        const res = await fetch('/api/meta-ads/config');
        const config = await res.json();
        tokenEl.value = config.accessTokenMasked || '';
        accountEl.value = config.adAccountId || '';
      } catch (e) {
        statusEl.textContent = 'Failed to load config';
      }
    }

    document.getElementById('save').addEventListener('click', async () => {
      const body = { adAccountId: accountEl.value.trim() };
      // Only send token if it was changed (not the masked version)
      const tokenVal = tokenEl.value.trim();
      if (tokenVal && !tokenVal.startsWith('***')) {
        body.accessToken = tokenVal;
      }
      try {
        const res = await fetch('/api/meta-ads/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const config = await res.json();
          tokenEl.value = config.accessTokenMasked || '';
          statusEl.textContent = 'Saved!';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } else {
          statusEl.textContent = 'Save failed';
        }
      } catch (e) {
        statusEl.textContent = 'Save failed';
      }
    });

    document.getElementById('help').addEventListener('click', () => {
      if (window.deepsteve && window.deepsteve.createSession) {
        window.deepsteve.createSession(undefined, {
          initialPrompt: 'I need help with the DeepSteve Meta Ads MCP Server, located at mods/meta-ads.',
        });
      }
    });

    load();
  </script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/meta-ads/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Meta Ads",
  "version": "1.0.0",
  "description": "Manage Meta (Facebook/Instagram) ad campaigns, experiments, and marketing knowledge base",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 340, "minWidth": 200 },
  "toolbar": { "label": "Meta Ads" },
  "tools": [
    { "name": "get_campaigns", "description": "List all campaigns in the ad account" },
    { "name": "get_campaign_insights", "description": "Get performance metrics for a campaign over a date range" },
    { "name": "get_ad_insights", "description": "Get performance metrics for a specific ad" },
    { "name": "get_account_summary", "description": "Get a summary of the entire ad account performance" },
    { "name": "get_ad_sets", "description": "List ad sets in a campaign" },
    { "name": "get_ads", "description": "List ads in an ad set" },
    { "name": "get_ad_set_insights", "description": "Get performance metrics for an ad set over a date range" },
    { "name": "create_campaign", "description": "Create a new campaign (defaults to PAUSED)" },
    { "name": "create_ad_set", "description": "Create a new ad set within a campaign" },
    { "name": "create_ad", "description": "Create a new ad in an ad set" },
    { "name": "pause_resume_campaign", "description": "Pause or resume a campaign" },
    { "name": "pause_resume_ad_set", "description": "Pause or resume an ad set" },
    { "name": "create_ad_creative", "description": "Create an ad creative for use with create_ad" },
    { "name": "update_budget", "description": "Update daily or lifetime budget for a campaign or ad set" },
    { "name": "update_targeting", "description": "Update targeting for an ad set" },
    { "name": "create_experiment", "description": "Create a new A/B test experiment with hypothesis and variants" },
    { "name": "update_experiment_metrics", "description": "Update performance metrics for a variant in an experiment" },
    { "name": "conclude_experiment", "description": "Mark an experiment as concluded with a winner and learnings" },
    { "name": "get_experiment", "description": "Read a single experiment by name" },
    { "name": "list_experiments", "description": "List all experiments with their status" },
    { "name": "check_significance", "description": "Run A/B significance test between two variants" },
    { "name": "add_learning", "description": "Add an entry to the marketing knowledge base" },
    { "name": "get_knowledge_base", "description": "Read the full marketing knowledge base" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/meta-ads/tools.js" << 'DEEPSTEVE_FILE_EOF'
const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const CONFIG_FILE = path.join(os.homedir(), '.deepsteve', 'meta-ads.json');
const DATA_DIR = path.join(os.homedir(), '.deepsteve', 'meta-ads');
const KB_PATH = path.join(DATA_DIR, 'knowledge-base.md');

// ── Config ──────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return { accessToken: '', adAccountId: '' };
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function maskToken(token) {
  if (!token || token.length <= 8) return '';
  return '***' + token.slice(-8);
}

// ── SDK helpers ─────────────────────────────────────────────

function initSdk() {
  const config = loadConfig();
  if (!config.accessToken || !config.adAccountId) {
    return null;
  }
  const bizSdk = require('facebook-nodejs-business-sdk');
  bizSdk.FacebookAdsApi.init(config.accessToken);
  return {
    account: new bizSdk.AdAccount(config.adAccountId),
    Campaign: bizSdk.Campaign,
    AdSet: bizSdk.AdSet,
    Ad: bizSdk.Ad,
  };
}

const CREDENTIAL_ERROR = {
  content: [{ type: 'text', text: 'Error: Meta Ads credentials not configured. Open the Meta Ads panel in the sidebar and enter your access token and ad account ID.' }],
  isError: true,
};

const INSIGHT_FIELDS = [
  'impressions', 'clicks', 'spend', 'cpc', 'cpm', 'ctr',
  'reach', 'frequency', 'actions', 'cost_per_action_type', 'action_values',
];

function errorResult(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `Error: ${msg}` }] };
}

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ── Experiment helpers ──────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveExperiment(experiment) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `experiment-${slugify(experiment.name)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(experiment, null, 2));
}

function loadExperiment(name) {
  const filePath = path.join(DATA_DIR, `experiment-${slugify(name)}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function listAllExperiments() {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('experiment-') && f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')));
}

function updateVariantMetrics(experimentName, variantKey, metrics) {
  const experiment = loadExperiment(experimentName);
  if (!experiment || !experiment.variants[variantKey]) return null;
  Object.assign(experiment.variants[variantKey], metrics);
  saveExperiment(experiment);
  return experiment;
}

function concludeExp(name, winner, learnings) {
  const experiment = loadExperiment(name);
  if (!experiment) return null;
  experiment.status = 'concluded';
  experiment.winner = winner;
  experiment.learnings = learnings;
  experiment.endDate = new Date().toISOString().split('T')[0];
  saveExperiment(experiment);
  return experiment;
}

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function calculateSignificance(a, b, metric) {
  const nA = a.sampleSize ?? a.impressions;
  const nB = b.sampleSize ?? b.impressions;
  const xA = a[metric];
  const xB = b[metric];
  if (nA === 0 || nB === 0) {
    return { zScore: 0, pValue: 1, significant: false, conversionRateA: 0, conversionRateB: 0 };
  }
  const pA = xA / nA, pB = xB / nB;
  const pPooled = (xA + xB) / (nA + nB);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / nA + 1 / nB));
  if (se === 0) {
    return { zScore: 0, pValue: 1, significant: false, conversionRateA: pA, conversionRateB: pB };
  }
  const zScore = (pA - pB) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));
  return { zScore, pValue, significant: pValue < 0.05, conversionRateA: pA, conversionRateB: pB };
}

// ── Knowledge base helpers ──────────────────────────────────

const SECTION_HEADERS = {
  works: '## What Works',
  doesnt_work: "## What Doesn't Work",
  open_question: '## Open Questions',
};

function getKnowledgeBase() {
  if (!fs.existsSync(KB_PATH)) return '';
  return fs.readFileSync(KB_PATH, 'utf-8');
}

function addLearning(category, entry) {
  ensureDataDir();
  let content = getKnowledgeBase();
  const header = SECTION_HEADERS[category];
  const idx = content.indexOf(header);
  if (idx === -1) {
    content += `\n${header}\n- ${entry}\n`;
  } else {
    const insertPos = idx + header.length;
    const nextLine = content.indexOf('\n', insertPos);
    content = content.slice(0, nextLine + 1) + `- ${entry}\n` + content.slice(nextLine + 1);
  }
  fs.writeFileSync(KB_PATH, content);
}

// ── Routes ──────────────────────────────────────────────────

function registerRoutes(app) {
  app.get('/api/meta-ads/config', (req, res) => {
    const config = loadConfig();
    res.json({
      accessTokenMasked: maskToken(config.accessToken),
      adAccountId: config.adAccountId || '',
    });
  });

  app.post('/api/meta-ads/config', (req, res) => {
    const config = loadConfig();
    if (req.body.accessToken !== undefined) config.accessToken = req.body.accessToken;
    if (req.body.adAccountId !== undefined) config.adAccountId = req.body.adAccountId;
    saveConfig(config);
    res.json({
      accessTokenMasked: maskToken(config.accessToken),
      adAccountId: config.adAccountId,
    });
  });
}

// ── Tool definitions ────────────────────────────────────────

function init(context) {
  return {
    // ── Read tools ────────────────────────────────────────
    get_campaigns: {
      description: 'List all campaigns in the ad account',
      schema: {
        status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
      },
      handler: async ({ status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const fields = ['name', 'status', 'objective', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time'];
          const params = {};
          if (status) params.effective_status = [status];
          const campaigns = await sdk.account.getCampaigns(fields, params);
          return jsonResult(campaigns);
        } catch (e) { return errorResult(e); }
      },
    },

    get_campaign_insights: {
      description: 'Get performance metrics for a campaign over a date range',
      schema: {
        campaign_id: z.string(),
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ campaign_id, date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const campaign = new sdk.Campaign(campaign_id);
          const insights = await campaign.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ad_insights: {
      description: 'Get performance metrics for a specific ad',
      schema: {
        ad_id: z.string(),
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ ad_id, date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const ad = new sdk.Ad(ad_id);
          const insights = await ad.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    get_account_summary: {
      description: 'Get a summary of the entire ad account performance',
      schema: {
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const insights = await sdk.account.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ad_sets: {
      description: 'List ad sets in a campaign',
      schema: {
        campaign_id: z.string(),
        status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
      },
      handler: async ({ campaign_id, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const campaign = new sdk.Campaign(campaign_id);
          const fields = ['name', 'status', 'daily_budget', 'lifetime_budget', 'daily_min_spend_target', 'daily_spend_cap', 'budget_remaining', 'optimization_goal', 'targeting', 'billing_event', 'start_time', 'end_time', 'effective_status', 'learning_stage_info'];
          const params = {};
          if (status) params.effective_status = [status];
          const adSets = await campaign.getAdSets(fields, params);
          return jsonResult(adSets);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ads: {
      description: 'List ads in an ad set',
      schema: {
        ad_set_id: z.string(),
        status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
      },
      handler: async ({ ad_set_id, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const fields = ['name', 'status', 'creative', 'adset_id'];
          const params = {};
          if (status) params.effective_status = [status];
          const ads = await adSet.getAds(fields, params);
          return jsonResult(ads);
        } catch (e) { return errorResult(e); }
      },
    },

    get_ad_set_insights: {
      description: 'Get performance metrics for an ad set over a date range',
      schema: {
        ad_set_id: z.string(),
        date_from: z.string().describe('YYYY-MM-DD'),
        date_to: z.string().describe('YYYY-MM-DD'),
      },
      handler: async ({ ad_set_id, date_from, date_to }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const insights = await adSet.getInsights(INSIGHT_FIELDS, {
            time_range: { since: date_from, until: date_to },
          });
          return jsonResult(insights);
        } catch (e) { return errorResult(e); }
      },
    },

    // ── Write tools ───────────────────────────────────────
    create_campaign: {
      description: 'Create a new campaign (defaults to PAUSED)',
      schema: {
        name: z.string(),
        objective: z.enum([
          'OUTCOME_APP_PROMOTION', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT',
          'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC',
        ]),
        status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
        daily_budget: z.string().optional().describe('Daily budget in cents (e.g. "1000" = $10.00)'),
        special_ad_categories: z.array(z.string()).default([]),
      },
      handler: async ({ name, objective, status, daily_budget, special_ad_categories }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = { name, objective, status, special_ad_categories };
          if (daily_budget) params.daily_budget = daily_budget;
          const result = await sdk.account.createCampaign([], params);
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    create_ad_set: {
      description: 'Create a new ad set within a campaign (defaults to PAUSED). Budgets are in cents as strings.',
      schema: {
        campaign_id: z.string(),
        name: z.string(),
        daily_budget: z.string().describe('Daily budget in cents (e.g. "1000" = $10.00)'),
        optimization_goal: z.string().describe('e.g. APP_INSTALLS, LINK_CLICKS, REACH'),
        targeting: z.object({
          geo_locations: z.object({
            countries: z.array(z.string()).optional(),
          }).optional(),
          age_min: z.number().optional(),
          age_max: z.number().optional(),
        }).passthrough(),
        billing_event: z.string().default('IMPRESSIONS'),
        status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
      },
      handler: async ({ campaign_id, name, daily_budget, optimization_goal, targeting, billing_event, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = { campaign_id, name, daily_budget, optimization_goal, targeting, billing_event, status };
          const result = await sdk.account.createAdSet([], params);
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    create_ad: {
      description: 'Create a new ad in an ad set (defaults to PAUSED)',
      schema: {
        adset_id: z.string(),
        name: z.string(),
        creative_id: z.string().describe('ID of an existing ad creative'),
        status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
      },
      handler: async ({ adset_id, name, creative_id, status }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = { adset_id, name, creative: { creative_id }, status };
          const result = await sdk.account.createAd([], params);
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    pause_resume_campaign: {
      description: 'Pause or resume a campaign',
      schema: {
        campaign_id: z.string(),
        action: z.enum(['pause', 'resume']),
      },
      handler: async ({ campaign_id, action }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const campaign = new sdk.Campaign(campaign_id);
          const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';
          const result = await campaign.update([], { status: newStatus });
          return jsonResult({ id: campaign_id, status: newStatus, result });
        } catch (e) { return errorResult(e); }
      },
    },

    pause_resume_ad_set: {
      description: 'Pause or resume an ad set',
      schema: {
        ad_set_id: z.string(),
        action: z.enum(['pause', 'resume']),
      },
      handler: async ({ ad_set_id, action }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';
          const result = await adSet.update([], { status: newStatus });
          return jsonResult({ id: ad_set_id, status: newStatus, result });
        } catch (e) { return errorResult(e); }
      },
    },

    create_ad_creative: {
      description: 'Create an ad creative for use with create_ad',
      schema: {
        name: z.string(),
        page_id: z.string().describe('Facebook Page ID'),
        image_hash: z.string().optional().describe('Image hash from uploaded image'),
        image_url: z.string().optional().describe('URL of the image'),
        video_id: z.string().optional().describe('ID of uploaded video'),
        title: z.string().optional().describe('Ad headline'),
        body: z.string().optional().describe('Ad body text'),
        link_url: z.string().optional().describe('Destination URL'),
        call_to_action_type: z.string().optional().describe('e.g. INSTALL_MOBILE_APP, LEARN_MORE, SHOP_NOW'),
      },
      handler: async ({ name, page_id, image_hash, image_url, video_id, title, body, link_url, call_to_action_type }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const object_story_spec = { page_id };
          const link_data = {};
          if (image_hash) link_data.image_hash = image_hash;
          if (image_url) link_data.picture = image_url;
          if (title) link_data.name = title;
          if (body) link_data.message = body;
          if (link_url) link_data.link = link_url;
          if (call_to_action_type) link_data.call_to_action = { type: call_to_action_type };

          if (video_id) {
            const video_data = { video_id };
            if (title) video_data.title = title;
            if (body) video_data.message = body;
            if (link_url) video_data.link_url = link_url;
            if (call_to_action_type) video_data.call_to_action = { type: call_to_action_type, value: { link: link_url } };
            object_story_spec.video_data = video_data;
          } else {
            object_story_spec.link_data = link_data;
          }

          const result = await sdk.account.createAdCreative([], { name, object_story_spec });
          return jsonResult(result);
        } catch (e) { return errorResult(e); }
      },
    },

    update_budget: {
      description: 'Update daily or lifetime budget for a campaign or ad set. Budget in cents as string.',
      schema: {
        level: z.enum(['campaign', 'ad_set']),
        id: z.string(),
        daily_budget: z.string().optional().describe('Daily budget in cents'),
        lifetime_budget: z.string().optional().describe('Lifetime budget in cents'),
      },
      handler: async ({ level, id, daily_budget, lifetime_budget }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const params = {};
          if (daily_budget) params.daily_budget = daily_budget;
          if (lifetime_budget) params.lifetime_budget = lifetime_budget;
          const entity = level === 'campaign' ? new sdk.Campaign(id) : new sdk.AdSet(id);
          const result = await entity.update([], params);
          return jsonResult({ id, level, ...params, result });
        } catch (e) { return errorResult(e); }
      },
    },

    update_targeting: {
      description: 'Update targeting for an ad set',
      schema: {
        ad_set_id: z.string(),
        targeting: z.object({
          geo_locations: z.object({
            countries: z.array(z.string()).optional(),
          }).optional(),
          age_min: z.number().optional(),
          age_max: z.number().optional(),
        }).passthrough(),
      },
      handler: async ({ ad_set_id, targeting }) => {
        const sdk = initSdk();
        if (!sdk) return CREDENTIAL_ERROR;
        try {
          const adSet = new sdk.AdSet(ad_set_id);
          const result = await adSet.update([], { targeting });
          return jsonResult({ id: ad_set_id, targeting, result });
        } catch (e) { return errorResult(e); }
      },
    },

    // ── Experiment tools ──────────────────────────────────
    create_experiment: {
      description: 'Create a new A/B test experiment with hypothesis and variants',
      schema: {
        name: z.string(),
        hypothesis: z.string(),
        variants: z.record(z.object({
          adId: z.string().default(''),
          description: z.string(),
          spend: z.number().default(0),
          impressions: z.number().default(0),
          clicks: z.number().default(0),
          conversions: z.number().default(0),
          cpa: z.number().default(0),
          roas: z.number().default(0),
        })),
        checkInDate: z.string().optional(),
        tags: z.array(z.string()).optional(),
        metrics: z.string().optional(),
        notes: z.string().optional(),
      },
      handler: async ({ name, hypothesis, variants, checkInDate, tags, metrics, notes }) => {
        const experiment = {
          name,
          hypothesis,
          variants,
          startDate: new Date().toISOString().split('T')[0],
          status: 'running',
          checkInDate: checkInDate ?? null,
          tags: tags ?? [],
          metrics,
          notes: notes ?? null,
          snapshots: [],
        };
        saveExperiment(experiment);
        return { content: [{ type: 'text', text: `Experiment "${name}" created.` }] };
      },
    },

    update_experiment_metrics: {
      description: 'Update performance metrics for a variant in an experiment',
      schema: {
        experiment_name: z.string(),
        variant_key: z.string(),
        metrics: z.object({
          spend: z.number().optional(),
          impressions: z.number().optional(),
          clicks: z.number().optional(),
          conversions: z.number().optional(),
          cpa: z.number().optional(),
          roas: z.number().optional(),
          ctr: z.number().optional(),
          costPerClick: z.number().optional(),
          sampleSize: z.number().optional(),
        }),
      },
      handler: async ({ experiment_name, variant_key, metrics }) => {
        const result = updateVariantMetrics(experiment_name, variant_key, metrics);
        if (!result) return { content: [{ type: 'text', text: 'Experiment or variant not found.' }] };
        return jsonResult(result.variants[variant_key]);
      },
    },

    conclude_experiment: {
      description: 'Mark an experiment as concluded with a winner and learnings',
      schema: {
        name: z.string(),
        winner: z.string(),
        learnings: z.string(),
      },
      handler: async ({ name, winner, learnings }) => {
        const result = concludeExp(name, winner, learnings);
        if (!result) return { content: [{ type: 'text', text: 'Experiment not found.' }] };
        return { content: [{ type: 'text', text: `Experiment "${name}" concluded. Winner: ${winner}` }] };
      },
    },

    get_experiment: {
      description: 'Read a single experiment by name',
      schema: { name: z.string() },
      handler: async ({ name }) => {
        const experiment = loadExperiment(name);
        if (!experiment) return { content: [{ type: 'text', text: 'Experiment not found.' }] };
        return jsonResult(experiment);
      },
    },

    list_experiments: {
      description: 'List all experiments with their status',
      schema: {},
      handler: async () => {
        const experiments = listAllExperiments();
        const summary = experiments.map(e => ({
          name: e.name,
          status: e.status,
          startDate: e.startDate,
          winner: e.winner ?? null,
        }));
        return jsonResult(summary);
      },
    },

    check_significance: {
      description: 'Run A/B significance test between two variants of an experiment',
      schema: {
        experiment_name: z.string(),
        variant_a: z.string(),
        variant_b: z.string(),
        metric: z.enum(['conversions', 'clicks']).default('conversions'),
      },
      handler: async ({ experiment_name, variant_a, variant_b, metric }) => {
        const experiment = loadExperiment(experiment_name);
        if (!experiment) return { content: [{ type: 'text', text: 'Experiment not found.' }] };
        const a = experiment.variants[variant_a];
        const b = experiment.variants[variant_b];
        if (!a || !b) return { content: [{ type: 'text', text: 'Variant not found.' }] };
        return jsonResult(calculateSignificance(a, b, metric));
      },
    },

    // ── Knowledge base tools ──────────────────────────────
    add_learning: {
      description: 'Add an entry to the marketing knowledge base',
      schema: {
        category: z.enum(['works', 'doesnt_work', 'open_question']),
        entry: z.string(),
      },
      handler: async ({ category, entry }) => {
        addLearning(category, entry);
        return { content: [{ type: 'text', text: `Added to "${category}": ${entry}` }] };
      },
    },

    get_knowledge_base: {
      description: 'Read the full marketing knowledge base',
      schema: {},
      handler: async () => {
        const kb = getKnowledgeBase();
        return { content: [{ type: 'text', text: kb || 'Knowledge base is empty.' }] };
      },
    },
  };
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/monkey-code/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body { background: #000; height: 100vh; overflow: hidden; }
    #scene { width: 100%; height: 100%; }
    #hud {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      font-family: 'Press Start 2P', monospace;
    }
    #hud > * { pointer-events: auto; }
    #header {
      position: absolute; top: 0; left: 0; right: 0;
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 20px;
      background: linear-gradient(180deg, rgba(0,0,0,0.6) 0%, transparent 100%);
    }
    #header h1 {
      font-size: 16px; color: #fff; letter-spacing: 2px;
      text-shadow: 2px 2px 0 #000, 0 0 10px rgba(80,255,80,0.5);
    }
    #header .monkey-count { font-size: 10px; color: #8f8; text-shadow: 1px 1px 0 #000; }
    .hud-btn {
      border: 3px solid #fff; border-radius: 6px; color: #fff;
      font-family: 'Press Start 2P', monospace; font-size: 11px;
      padding: 8px 16px; cursor: pointer;
      text-shadow: 1px 1px 0 #000; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .hud-btn.back { background: #555; font-size: 9px; padding: 6px 12px; }
    #it-flash {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      font-size: 48px; color: #ff4444;
      text-shadow: 4px 4px 0 #000, 0 0 40px rgba(255,0,0,0.6);
      animation: itFlash 0.4s ease-out forwards;
      pointer-events: none;
    }
    @keyframes itFlash {
      0% { opacity: 1; transform: translate(-50%, -50%) scale(1.5); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
    }
    #scoreboard {
      position: absolute; bottom: 12px; left: 12px;
      background: rgba(0,0,0,0.75); border: 2px solid #8f8;
      border-radius: 8px; padding: 10px 14px; min-width: 210px;
    }
    #scoreboard .title { font-size: 10px; color: #8f8; margin-bottom: 8px; text-shadow: 1px 1px 0 #000; }
    #scoreboard .row {
      display: flex; align-items: center; gap: 8px; padding: 3px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    #scoreboard .row:last-child { border-bottom: none; }
    #scoreboard .pos { font-size: 10px; width: 22px; text-align: right; }
    #scoreboard .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    #scoreboard .name {
      font-size: 9px; color: #fff; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px;
    }
    #scoreboard .stat { font-size: 9px; color: #aaa; }
    #scoreboard .it-badge {
      font-size: 7px; color: #ff4444; background: rgba(255,0,0,0.15);
      border: 1px solid #ff4444; border-radius: 3px; padding: 1px 4px;
    }
    #scoreboard .row.active { background: rgba(80,255,80,0.15); border-radius: 4px; }
    #no-monkeys {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      text-align: center; color: #fff; text-shadow: 2px 2px 0 #000;
    }
    #no-monkeys .big { font-size: 18px; margin-bottom: 12px; }
    #no-monkeys .small { font-size: 10px; color: #ccc; }
    #hint {
      position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
      font-size: 11px; color: #fff; text-shadow: 1px 1px 0 #000;
      background: rgba(0,0,0,0.5); padding: 8px 16px; border-radius: 6px;
      animation: hintPulse 2s ease-in-out infinite;
    }
    @keyframes hintPulse {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    #physics-panel {
      position: absolute; top: 60px; right: 12px;
      background: rgba(0,0,0,0.8); border: 2px solid #666;
      border-radius: 8px; padding: 0; font-size: 9px; color: #ccc;
      min-width: 200px; overflow: hidden;
    }
    #physics-panel .panel-header {
      padding: 8px 12px; cursor: pointer; user-select: none;
      background: rgba(255,255,255,0.05); border-bottom: 1px solid #444;
      display: flex; justify-content: space-between; align-items: center;
    }
    #physics-panel .panel-header:hover { background: rgba(255,255,255,0.1); }
    #physics-panel .panel-body { padding: 8px 12px; }
    #physics-panel .slider-row {
      display: flex; align-items: center; gap: 6px; margin: 4px 0;
    }
    #physics-panel .slider-row label { width: 70px; font-size: 8px; text-align: right; }
    #physics-panel .slider-row input[type="range"] { flex: 1; height: 4px; }
    #physics-panel .slider-row .val { width: 36px; font-size: 8px; text-align: left; color: #8f8; }
  </style>
</head>
<body>
  <canvas id="scene"></canvas>
  <div id="hud"></div>

  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/"
    }
  }
  </script>
  <script type="module" src="monkey-code.js"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/monkey-code/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Monkey Code",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "A monkey tagging game in WebXR. Works with a Mac running DeepSteve, connected over HTTPS. See the <a href=\"https://github.com/deepsteve/deepsteve\">README</a> for setup instructions.",
  "experimental": true,
  "enabledByDefault": false,
  "tags": ["games"],
  "entry": "index.html",
  "toolbar": {
    "label": "Monkey Code"
  }
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/monkey-code/monkey-code.js" << 'DEEPSTEVE_FILE_EOF'
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ── Config ──────────────────────────────────────────────────────────────────

const MONKEY_COLORS = [
  { body: 0x8B4513, accent: 0x654321, hex: '#8B4513' }, // brown
  { body: 0x4a4a4a, accent: 0x333333, hex: '#4a4a4a' }, // dark grey
  { body: 0xd2691e, accent: 0xa0522d, hex: '#d2691e' }, // chocolate
  { body: 0x2f4f2f, accent: 0x1a3a1a, hex: '#2f4f2f' }, // dark green
  { body: 0x800000, accent: 0x5a0000, hex: '#800000' }, // maroon
  { body: 0x556b2f, accent: 0x3b4a1f, hex: '#556b2f' }, // olive
  { body: 0xbc8f5f, accent: 0x8b6d3f, hex: '#bc8f5f' }, // tan
  { body: 0x696969, accent: 0x484848, hex: '#696969' }, // dim grey
];

const MODE_ORBIT = 0;   // Fly around, click a monkey
const MODE_FIRST = 1;   // First-person inside a monkey

const ARENA_SIZE = 40;
const ARENA_HALF = ARENA_SIZE / 2;
const WALL_HEIGHT = 6;

const TAG_COOLDOWN = 3;  // seconds before tag-back allowed

// ── Tunable physics ─────────────────────────────────────────────────────────

const PHYSICS = {
  gravity: 19.6,
  jumpMultiplier: 1.4,
  maxSpeed: 18,
  friction: 0.92,
  bounciness: 0.3,
  tagRadius: 2.5,
};

// ── State ───────────────────────────────────────────────────────────────────

let sessions = [];
let viewMode = MODE_ORBIT;
let followId = null;
let terminalPanelEl = null;
let originalTermParent = null;
let originalTermNext = null;
let itMonkeyId = null;         // who is "it"
let lastTagTime = 0;           // timestamp of last tag
let physPanelOpen = false;

// VR monkey selection panel
let vrSelectionPanel = null;     // THREE.Group holding the card grid
let vrSelectionCards = [];       // { mesh, sessionId } for raycasting
const vrSelectionRaycaster = new THREE.Raycaster();

// Terminal station (physical screen in arena)
let termStationMesh = null;       // THREE.Mesh with terminal texture
let termStationTexture = null;    // THREE.CanvasTexture
let termStationCanvas = null;     // off-screen canvas for placeholder
let termStationSessionId = null;  // currently displayed session
let termMirrorTerm = null;        // mirror xterm.js Terminal instance
let termMirrorWs = null;          // mirror WebSocket connection
let termMirrorCanvas = null;      // CanvasAddon's canvas element

const monkeyState = {};        // id → { mesh, vel, pos, onGround, score, ... }
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

// ── WASD input state ────────────────────────────────────────────────────────

const input = { w: false, a: false, s: false, d: false, space: false, click: false };

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = true;
  if (k === ' ') { input.space = true; e.preventDefault(); }
  if (k === 'escape' && viewMode === MODE_FIRST) exitFirstPerson();
  startAudio();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in input) input[k] = false;
  if (k === ' ') input.space = false;
});
window.addEventListener('mousedown', () => { input.click = true; startAudio(); });
window.addEventListener('mouseup', () => { input.click = false; });

// Mouse look (pointer lock)
let mouseYaw = 0, mousePitch = 0;
const canvas = document.getElementById('scene');
canvas.tabIndex = -1; // Make focusable so iframe receives keyboard events
canvas.style.outline = 'none'; // No focus ring

canvas.addEventListener('click', () => {
  if (viewMode === MODE_FIRST && !document.pointerLockElement) {
    canvas.requestPointerLock();
  }
  canvas.focus();
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && viewMode === MODE_FIRST) {
    // pointer lock lost — don't exit first person, just stop mouse look
  }
});

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas && viewMode === MODE_FIRST) {
    mouseYaw -= e.movementX * 0.002;
    mousePitch -= e.movementY * 0.002;
    mousePitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, mousePitch));
  }
});

// ── Audio (procedural) ──────────────────────────────────────────────────────

let audioCtx = null;

function startAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playTag() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.1);
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.15);
}

function playJump() {
  if (!audioCtx) return;
  const bufSize = audioCtx.sampleRate * 0.15;
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass'; filter.frequency.value = 800; filter.Q.value = 2;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  src.connect(filter).connect(gain).connect(audioCtx.destination);
  src.start(); src.stop(audioCtx.currentTime + 0.15);
}

function playLand() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 80;
  gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.1);
}

// Ambient jungle sounds
let ambientStarted = false;
function startAmbient() {
  if (ambientStarted || !audioCtx) return;
  ambientStarted = true;

  // Low rumble
  const noise = audioCtx.createBufferSource();
  const noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 4, audioCtx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  noise.buffer = noiseBuf; noise.loop = true;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 200;
  const ng = audioCtx.createGain(); ng.gain.value = 0.015;
  noise.connect(lp).connect(ng).connect(audioCtx.destination);
  noise.start();

  // Periodic bird chirps
  setInterval(() => {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const f = 1200 + Math.random() * 1800;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(f * 0.7, audioCtx.currentTime + 0.12);
    g.gain.setValueAtTime(0.02, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.15);
  }, 3000 + Math.random() * 5000);
}

// ── Three.js setup ──────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 60, 120);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);

// Camera rig for VR — move the rig, camera stays relative inside it
const cameraRig = new THREE.Group();
cameraRig.add(camera);
scene.add(cameraRig);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(20, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
scene.add(sun);

// ── WebXR Controllers ───────────────────────────────────────────────────────

const controllerModelFactory = new XRControllerModelFactory();

const controller0 = renderer.xr.getController(0);
cameraRig.add(controller0);
const controllerGrip0 = renderer.xr.getControllerGrip(0);
controllerGrip0.add(controllerModelFactory.createControllerModel(controllerGrip0));
cameraRig.add(controllerGrip0);

const controller1 = renderer.xr.getController(1);
cameraRig.add(controller1);
const controllerGrip1 = renderer.xr.getControllerGrip(1);
controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
cameraRig.add(controllerGrip1);

// VR velocity tracking — ring buffers for each hand
const VR_VEL_FRAMES = 6;
const vrHands = [
  { controller: controller0, posHistory: new Float32Array(VR_VEL_FRAMES * 3), idx: 0, prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), touching: false },
  { controller: controller1, posHistory: new Float32Array(VR_VEL_FRAMES * 3), idx: 0, prevPos: new THREE.Vector3(), vel: new THREE.Vector3(), touching: false },
];

// Add VR button to the page (only shows if WebXR available)
document.body.appendChild(VRButton.createButton(renderer));

// ── Build arena environment ─────────────────────────────────────────────────

// Collidable surfaces: { min: {x,y,z}, max: {x,y,z} }
const colliders = [];

function addCollider(x, y, z, w, h, d) {
  colliders.push({
    min: { x: x - w / 2, y: y - h / 2, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h / 2, z: z + d / 2 },
  });
}

// Ground
{
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshLambertMaterial({ color: 0x3a7a3a })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);
  addCollider(0, -0.5, 0, 200, 1, 200); // ground collider
}

// Arena floor (slightly darker)
{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE),
    new THREE.MeshLambertMaterial({ color: 0x358035 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  floor.receiveShadow = true;
  scene.add(floor);
}

// Walls
{
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x6b6b4b, transparent: true, opacity: 0.3 });
  const wallGeo = new THREE.BoxGeometry(ARENA_SIZE, WALL_HEIGHT, 0.5);
  const sideGeo = new THREE.BoxGeometry(0.5, WALL_HEIGHT, ARENA_SIZE);

  const walls = [
    { geo: wallGeo, pos: [0, WALL_HEIGHT / 2, -ARENA_HALF], col: [0, WALL_HEIGHT / 2, -ARENA_HALF, ARENA_SIZE, WALL_HEIGHT, 0.5] },
    { geo: wallGeo, pos: [0, WALL_HEIGHT / 2, ARENA_HALF], col: [0, WALL_HEIGHT / 2, ARENA_HALF, ARENA_SIZE, WALL_HEIGHT, 0.5] },
    { geo: sideGeo, pos: [-ARENA_HALF, WALL_HEIGHT / 2, 0], col: [-ARENA_HALF, WALL_HEIGHT / 2, 0, 0.5, WALL_HEIGHT, ARENA_SIZE] },
    { geo: sideGeo, pos: [ARENA_HALF, WALL_HEIGHT / 2, 0], col: [ARENA_HALF, WALL_HEIGHT / 2, 0, 0.5, WALL_HEIGHT, ARENA_SIZE] },
  ];

  for (const w of walls) {
    const mesh = new THREE.Mesh(w.geo, wallMat);
    mesh.position.set(...w.pos);
    mesh.receiveShadow = true;
    scene.add(mesh);
    addCollider(...w.col);
  }
}

// Platforms at various heights
const platformDefs = [
  { x: -12, y: 1.5, z: -10, w: 6, d: 6 },
  { x: 10, y: 2.5, z: -12, w: 5, d: 5 },
  { x: 0, y: 3.5, z: 0, w: 7, d: 7 },     // center tall
  { x: -8, y: 2, z: 12, w: 5, d: 4 },
  { x: 14, y: 1, z: 8, w: 6, d: 5 },
  { x: -15, y: 3, z: 2, w: 4, d: 6 },
  { x: 8, y: 4, z: -4, w: 4, d: 4 },       // highest
  { x: -5, y: 1, z: -15, w: 5, d: 4 },
  { x: 16, y: 2, z: -6, w: 4, d: 5 },
  { x: -10, y: 2.5, z: -4, w: 4, d: 4 },
];

{
  const platMat = new THREE.MeshLambertMaterial({ color: 0xa08060 });
  for (const p of platformDefs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.5, p.d), platMat);
    mesh.position.set(p.x, p.y, p.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    addCollider(p.x, p.y, p.z, p.w, 0.5, p.d);
  }
}

// Ramps connecting ground to platforms
// Each ramp: ground start (x,z) → platform edge (x,z) at platform height
// Platforms: [-12,1.5,-10], [10,2.5,-12], [0,3.5,0], [-8,2,12], [14,1,8]
{
  const rampMat = new THREE.MeshLambertMaterial({ color: 0x8b7355 });

  // Build a ramp from ground (gx,0,gz) up to (px,h,pz)
  function buildRamp(gx, gz, px, h, pz) {
    const dx = px - gx, dz = pz - gz;
    const hDist = Math.sqrt(dx * dx + dz * dz); // horizontal length
    const fullLen = Math.sqrt(hDist * hDist + h * h); // hypotenuse
    const tiltAngle = Math.atan2(h, hDist);
    const yawAngle = Math.atan2(dx, dz); // rotation around Y

    const geo = new THREE.BoxGeometry(2.5, 0.25, fullLen);
    const mesh = new THREE.Mesh(geo, rampMat);
    const cx = (gx + px) / 2, cz = (gz + pz) / 2, cy = h / 2;
    mesh.position.set(cx, cy, cz);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = yawAngle;
    mesh.rotation.x = -tiltAngle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Stair-step colliders along the ramp
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      addCollider(gx + dx * t, h * t, gz + dz * t, 2.5, 0.4, hDist / steps);
    }
  }

  // Ramp to platform at (-12, 1.5, -10) from south side
  buildRamp(-12, -5, -12, 1.5, -8);
  // Ramp to platform at (10, 2.5, -12) from south side
  buildRamp(10, -6, 10, 2.5, -10);
  // Ramp to center platform (0, 3.5, 0) from south
  buildRamp(0, 6, 0, 3.5, 2);
  // Ramp to platform at (-8, 2, 12) from north side
  buildRamp(-8, 16, -8, 2, 13);
  // Ramp to platform at (14, 1, 8) from south side
  buildRamp(14, 12, 14, 1, 9.5);
}

// Terminal station — standalone in open area (away from platforms/ramps)
const TERM_X = -5, TERM_Z = 16;
{
  const TX = TERM_X, TZ = TERM_Z;

  const termPlat = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.3, 5),
    new THREE.MeshPhongMaterial({ color: 0x00cc66, emissive: 0x00cc66, emissiveIntensity: 0.3 })
  );
  termPlat.position.set(TX, 0.15, TZ);
  scene.add(termPlat);

  // Glowing pillar (shorter to match lower screen)
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8),
    new THREE.MeshPhongMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.5 })
  );
  pillar.position.set(TX, 0.6, TZ);
  scene.add(pillar);

  // Terminal screen (standing monitor)
  {
    termStationCanvas = document.createElement('canvas');
    termStationCanvas.width = 1024;
    termStationCanvas.height = 512;
    const ctx = termStationCanvas.getContext('2d');
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MONKEY CODE TERMINAL', 512, 200);
    ctx.font = '18px monospace';
    ctx.fillText('Select a monkey to view its terminal', 512, 260);

    termStationTexture = new THREE.CanvasTexture(termStationCanvas);
    termStationTexture.minFilter = THREE.LinearFilter;

    // Screen: 2.5m wide x 1.5m tall, at eye level, rotated to face -Z (into arena)
    termStationMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 1.5),
      new THREE.MeshBasicMaterial({ map: termStationTexture, side: THREE.DoubleSide })
    );
    termStationMesh.position.set(TX, 1.5, TZ);
    termStationMesh.rotation.y = Math.PI; // face toward arena center
    scene.add(termStationMesh);

    // Green border frame
    const border = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.6),
      new THREE.MeshBasicMaterial({ color: 0x00ff44 })
    );
    border.position.set(TX, 1.5, TZ + 0.01);
    border.rotation.y = Math.PI;
    scene.add(border);

    // Dark back panel
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.6),
      new THREE.MeshBasicMaterial({ color: 0x111111 })
    );
    back.position.set(TX, 1.5, TZ + 0.02);
    back.rotation.y = Math.PI;
    scene.add(back);
  }
}

// Trees
function addTree(x, z, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15 * s, 0.2 * s, 1.5 * s, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
  );
  trunk.position.y = 0.75 * s; trunk.castShadow = true; g.add(trunk);
  const foliage = new THREE.Mesh(
    new THREE.ConeGeometry(1.2 * s, 2.5 * s, 6),
    new THREE.MeshLambertMaterial({ color: 0x2a6a2a })
  );
  foliage.position.y = 2.5 * s; foliage.castShadow = true; g.add(foliage);
  g.position.set(x, 0, z); scene.add(g);
  // Tree trunk is collidable
  addCollider(x, 0.75 * s, z, 0.4 * s, 1.5 * s, 0.4 * s);
}

// Place trees around outside arena
[[-25, -18, 1.2], [-28, 8, 0.9], [26, -16, 1.1], [28, 10, 1], [-22, 22, 1.3], [24, 18, 0.8],
 [-18, -22, 1], [22, -20, 0.9], [-24, 12, 1.1], [18, 22, 1.2], [-20, -8, 0.8], [20, 5, 1.1],
 // Some inside arena
 [12, 14, 0.7], [-14, -14, 0.8], [6, -10, 0.6], [-6, 8, 0.7]].forEach(t => addTree(...t));

// ── Box-based monkey model ──────────────────────────────────────────────────

function createMonkeyMesh(colorIdx) {
  const group = new THREE.Group();
  const c = MONKEY_COLORS[colorIdx % MONKEY_COLORS.length];
  const bodyMat = new THREE.MeshPhongMaterial({ color: c.body, shininess: 30 });
  const accentMat = new THREE.MeshPhongMaterial({ color: c.accent, shininess: 20 });
  const faceMat = new THREE.MeshPhongMaterial({ color: 0xdeb887, shininess: 20 }); // face/belly
  const eyeWhite = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 60 });
  const pupilMat = new THREE.MeshPhongMaterial({ color: 0x111111, shininess: 80 });

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.5), bodyMat);
  torso.position.y = 0.9; torso.castShadow = true; group.add(torso);

  // Belly patch
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.05), faceMat);
  belly.position.set(0, 0.85, 0.26); group.add(belly);

  // Head
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.5), bodyMat);
  head.position.set(0, 1.6, 0); head.castShadow = true; group.add(head);
  head.name = 'head';

  // Muzzle
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.25, 0.15), faceMat);
  muzzle.position.set(0, 1.5, 0.3); group.add(muzzle);

  // Eyes
  const eyeGeo = new THREE.BoxGeometry(0.12, 0.14, 0.05);
  const pupilGeo = new THREE.BoxGeometry(0.06, 0.08, 0.03);

  const leftEye = new THREE.Mesh(eyeGeo, eyeWhite);
  leftEye.position.set(-0.15, 1.65, 0.26); group.add(leftEye);
  const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
  leftPupil.position.set(-0.15, 1.65, 0.29); group.add(leftPupil);

  const rightEye = new THREE.Mesh(eyeGeo, eyeWhite);
  rightEye.position.set(0.15, 1.65, 0.26); group.add(rightEye);
  const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
  rightPupil.position.set(0.15, 1.65, 0.29); group.add(rightPupil);

  // Upper arms (gorilla-long)
  const armGeo = new THREE.BoxGeometry(0.18, 0.55, 0.18);
  const leftUpperArm = new THREE.Mesh(armGeo, bodyMat);
  leftUpperArm.position.set(-0.5, 0.95, 0); leftUpperArm.castShadow = true; group.add(leftUpperArm);
  leftUpperArm.name = 'leftUpperArm';

  const rightUpperArm = new THREE.Mesh(armGeo, bodyMat);
  rightUpperArm.position.set(0.5, 0.95, 0); rightUpperArm.castShadow = true; group.add(rightUpperArm);
  rightUpperArm.name = 'rightUpperArm';

  // Forearms
  const forearmGeo = new THREE.BoxGeometry(0.15, 0.5, 0.15);
  const leftForearm = new THREE.Mesh(forearmGeo, accentMat);
  leftForearm.position.set(-0.5, 0.45, 0); leftForearm.castShadow = true; group.add(leftForearm);
  leftForearm.name = 'leftForearm';

  const rightForearm = new THREE.Mesh(forearmGeo, accentMat);
  rightForearm.position.set(0.5, 0.45, 0); rightForearm.castShadow = true; group.add(rightForearm);
  rightForearm.name = 'rightForearm';

  // Legs
  const legGeo = new THREE.BoxGeometry(0.2, 0.4, 0.2);
  const leftLeg = new THREE.Mesh(legGeo, accentMat);
  leftLeg.position.set(-0.2, 0.3, 0); leftLeg.castShadow = true; group.add(leftLeg);
  leftLeg.name = 'leftLeg';

  const rightLeg = new THREE.Mesh(legGeo, accentMat);
  rightLeg.position.set(0.2, 0.3, 0); rightLeg.castShadow = true; group.add(rightLeg);
  rightLeg.name = 'rightLeg';

  // Tail — curving sequence of small boxes
  const tailMat = new THREE.MeshPhongMaterial({ color: c.accent, shininess: 15 });
  const tailSegs = 5;
  for (let i = 0; i < tailSegs; i++) {
    const t = i / tailSegs;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.15), tailMat);
    seg.position.set(0, 0.6 + t * 0.3, -0.3 - t * 0.25);
    seg.rotation.x = -t * 0.4;
    seg.name = 'tail' + i;
    group.add(seg);
  }

  // Ground shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 1.0),
    new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.25 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.02, 0);
  shadow.name = 'shadow';
  group.add(shadow);

  return group;
}

// ── Name label sprite ───────────────────────────────────────────────────────

function createLabel(name, colorIdx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d');
  updateLabel(ctx, name, colorIdx);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(4, 0.75, 1);
  sprite.position.y = 2.2;
  sprite._canvas = c; sprite._ctx = ctx;
  return sprite;
}

function updateLabel(ctx, name, colorIdx, isIt, score) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const display = name.length > 14 ? name.slice(0, 13) + '\u2026' : name;
  const hex = MONKEY_COLORS[colorIdx % MONKEY_COLORS.length].hex;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  const tw = Math.max(display.length * 18 + 30, 80), x = (c.width - tw) / 2;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.fill();
  ctx.strokeStyle = isIt ? '#ff4444' : hex; ctx.lineWidth = 3;
  roundRect(ctx, x, 10, tw, 44, 12); ctx.stroke();
  ctx.fillStyle = isIt ? '#ff4444' : '#fff';
  ctx.font = '22px "Press Start 2P", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(display, c.width / 2, 32);
  if (isIt) {
    ctx.fillStyle = '#ff4444'; ctx.font = '14px "Press Start 2P", monospace';
    ctx.fillText('IT!', c.width / 2, 72);
  } else if (score > 0) {
    ctx.fillStyle = '#8f8'; ctx.font = '14px "Press Start 2P", monospace';
    ctx.fillText('Tags: ' + score, c.width / 2, 72);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

// ── AABB collision ──────────────────────────────────────────────────────────

const MONKEY_RADIUS = 0.35;
const MONKEY_HEIGHT = 1.8;

function resolveCollisions(pos, vel, isPlayer) {
  // Monkey as AABB
  const mMin = { x: pos.x - MONKEY_RADIUS, y: pos.y, z: pos.z - MONKEY_RADIUS };
  const mMax = { x: pos.x + MONKEY_RADIUS, y: pos.y + MONKEY_HEIGHT, z: pos.z + MONKEY_RADIUS };

  let onGround = false;

  for (const c of colliders) {
    // Check overlap
    if (mMax.x <= c.min.x || mMin.x >= c.max.x) continue;
    if (mMax.y <= c.min.y || mMin.y >= c.max.y) continue;
    if (mMax.z <= c.min.z || mMin.z >= c.max.z) continue;

    // Compute penetration on each axis
    const overlapX = Math.min(mMax.x - c.min.x, c.max.x - mMin.x);
    const overlapY = Math.min(mMax.y - c.min.y, c.max.y - mMin.y);
    const overlapZ = Math.min(mMax.z - c.min.z, c.max.z - mMin.z);

    // Resolve on the axis of smallest overlap
    if (overlapY <= overlapX && overlapY <= overlapZ) {
      if (pos.y + MONKEY_HEIGHT / 2 < (c.min.y + c.max.y) / 2) {
        // Hit ceiling
        pos.y = c.min.y - MONKEY_HEIGHT;
        vel.y = Math.min(vel.y, 0);
      } else {
        // Land on top
        pos.y = c.max.y;
        if (vel.y < -0.5) {
          vel.y = -vel.y * PHYSICS.bounciness;
          if (Math.abs(vel.y) < 1) vel.y = 0;
        } else {
          vel.y = 0;
        }
        onGround = true;
      }
    } else if (overlapX <= overlapZ) {
      if (pos.x < (c.min.x + c.max.x) / 2) {
        pos.x = c.min.x - MONKEY_RADIUS;
      } else {
        pos.x = c.max.x + MONKEY_RADIUS;
      }
      // Player: just stop at walls (no bounce = no oscillation)
      // AI: slight bounce for liveliness
      if (isPlayer) {
        vel.x = 0;
      } else {
        vel.x *= -PHYSICS.bounciness;
      }
    } else {
      if (pos.z < (c.min.z + c.max.z) / 2) {
        pos.z = c.min.z - MONKEY_RADIUS;
      } else {
        pos.z = c.max.z + MONKEY_RADIUS;
      }
      if (isPlayer) {
        vel.z = 0;
      } else {
        vel.z *= -PHYSICS.bounciness;
      }
    }
  }

  return onGround;
}

// Check if a position is near any surface (for VR hand touch detection)
function isTouchingSurface(worldPos) {
  const margin = 0.4; // generous reach so you don't need to clip into geometry
  for (const c of colliders) {
    if (worldPos.x >= c.min.x - margin && worldPos.x <= c.max.x + margin &&
        worldPos.y >= c.min.y - margin && worldPos.y <= c.max.y + margin &&
        worldPos.z >= c.min.z - margin && worldPos.z <= c.max.z + margin) {
      return true;
    }
  }
  return false;
}

// ── AI states ───────────────────────────────────────────────────────────────

const AI_IDLE = 0, AI_WANDER = 1, AI_FLEE = 2, AI_CHASE = 3;

function pickWanderTarget(m) {
  m.aiTarget.set(
    (Math.random() - 0.5) * (ARENA_SIZE - 4),
    0,
    (Math.random() - 0.5) * (ARENA_SIZE - 4)
  );
  m.aiTimer = 3 + Math.random() * 4;
}

function updateAI(m, id, dt, now) {
  const sm = {};
  for (const s of sessions) sm[s.id] = s;
  const session = sm[id];
  const isWorking = session && !session.waitingForInput;
  const isIt = id === itMonkeyId;

  // State transitions
  if (isIt) {
    m.aiState = AI_CHASE;
  } else if (itMonkeyId && monkeyState[itMonkeyId]) {
    const itPos = monkeyState[itMonkeyId].pos;
    const dist = _v1.set(itPos.x - m.pos.x, 0, itPos.z - m.pos.z).length();
    if (dist < 8) {
      m.aiState = AI_FLEE;
    } else if (isWorking) {
      m.aiState = AI_WANDER;
    } else {
      m.aiState = AI_IDLE;
    }
  } else if (isWorking) {
    m.aiState = AI_WANDER;
  } else {
    m.aiState = AI_IDLE;
  }

  const speed = isWorking ? 5 : 2;

  switch (m.aiState) {
    case AI_IDLE:
      // Gentle sway, occasional new target
      m.aiTimer -= dt;
      if (m.aiTimer <= 0) pickWanderTarget(m);
      break;

    case AI_WANDER:
      m.aiTimer -= dt;
      if (m.aiTimer <= 0) pickWanderTarget(m);
      _v1.set(m.aiTarget.x - m.pos.x, 0, m.aiTarget.z - m.pos.z);
      if (_v1.length() > 1) {
        _v1.normalize().multiplyScalar(speed);
        m.vel.x += (_v1.x - m.vel.x) * 3 * dt;
        m.vel.z += (_v1.z - m.vel.z) * 3 * dt;
      }
      // Random jumps
      if (m.onGround && Math.random() < 0.01) {
        m.vel.y = 6 + Math.random() * 3;
      }
      break;

    case AI_FLEE: {
      if (!itMonkeyId || !monkeyState[itMonkeyId]) break;
      const itPos = monkeyState[itMonkeyId].pos;
      _v1.set(m.pos.x - itPos.x, 0, m.pos.z - itPos.z);
      if (_v1.length() > 0.1) {
        _v1.normalize().multiplyScalar(speed * 1.3);
        m.vel.x += (_v1.x - m.vel.x) * 4 * dt;
        m.vel.z += (_v1.z - m.vel.z) * 4 * dt;
      }
      // Jump to escape
      if (m.onGround && Math.random() < 0.03) {
        m.vel.y = 7 + Math.random() * 3;
      }
      break;
    }

    case AI_CHASE: {
      // Find nearest non-it monkey
      let nearest = null, bestDist = Infinity;
      for (const [oid, om] of Object.entries(monkeyState)) {
        if (oid === id || oid === itMonkeyId) continue;
        const d = _v1.set(om.pos.x - m.pos.x, 0, om.pos.z - m.pos.z).length();
        if (d < bestDist) { bestDist = d; nearest = om; }
      }
      if (nearest) {
        _v1.set(nearest.pos.x - m.pos.x, 0, nearest.pos.z - m.pos.z);
        if (_v1.length() > 0.1) {
          _v1.normalize().multiplyScalar(speed * 1.2);
          m.vel.x += (_v1.x - m.vel.x) * 4 * dt;
          m.vel.z += (_v1.z - m.vel.z) * 4 * dt;
        }
      }
      // Jump toward target
      if (m.onGround && Math.random() < 0.025) {
        m.vel.y = 6 + Math.random() * 4;
      }
      break;
    }
  }
}

// ── Monkey limb animation ───────────────────────────────────────────────────

function animateMonkey(m, now) {
  const mesh = m.mesh;
  const speed = Math.sqrt(m.vel.x * m.vel.x + m.vel.z * m.vel.z);
  const t = now * 0.003;

  // Walking limb swing
  const walkAmp = Math.min(speed / 8, 1) * 0.4;
  const walkFreq = speed * 0.5;

  for (const child of mesh.children) {
    switch (child.name) {
      case 'leftUpperArm':
        child.rotation.x = Math.sin(t * walkFreq) * walkAmp;
        child.position.y = 0.95;
        break;
      case 'rightUpperArm':
        child.rotation.x = -Math.sin(t * walkFreq) * walkAmp;
        child.position.y = 0.95;
        break;
      case 'leftForearm':
        child.rotation.x = Math.sin(t * walkFreq) * walkAmp * 0.7 - 0.2;
        child.position.y = 0.45;
        break;
      case 'rightForearm':
        child.rotation.x = -Math.sin(t * walkFreq) * walkAmp * 0.7 - 0.2;
        child.position.y = 0.45;
        break;
      case 'leftLeg':
        child.rotation.x = -Math.sin(t * walkFreq) * walkAmp * 0.5;
        break;
      case 'rightLeg':
        child.rotation.x = Math.sin(t * walkFreq) * walkAmp * 0.5;
        break;
      case 'head':
        // Slight bob
        child.position.y = 1.6 + Math.sin(t * 2) * 0.02;
        break;
      case 'shadow':
        // Shadow stays at ground level relative to monkey
        child.position.y = 0.02 - m.pos.y;
        child.material.opacity = Math.max(0.05, 0.25 - m.pos.y * 0.03);
        break;
    }

    // Tail wag
    if (child.name && child.name.startsWith('tail')) {
      const i = parseInt(child.name[4]);
      child.rotation.z = Math.sin(t * 3 + i * 0.6) * 0.15 * (i + 1) / 5;
    }
  }

  // Idle sway when not moving
  if (speed < 0.5) {
    mesh.rotation.z = Math.sin(t * 0.5) * 0.03;
  } else {
    mesh.rotation.z = 0;
  }

  // "It" monkey glows red
  if (m.id === itMonkeyId) {
    // Pulse the body emissive
    const pulse = (Math.sin(now * 0.005) + 1) * 0.5;
    mesh.children[0].material.emissive = mesh.children[0].material.emissive || new THREE.Color();
    mesh.children[0].material.emissive.setRGB(pulse * 0.3, 0, 0);
    mesh.children[0].material.emissiveIntensity = 1;
  } else {
    mesh.children[0].material.emissive = mesh.children[0].material.emissive || new THREE.Color();
    mesh.children[0].material.emissive.setRGB(0, 0, 0);
  }
}

// ── Physics update ──────────────────────────────────────────────────────────

function updatePhysics(dt, now) {
  const isVR = renderer.xr.isPresenting;
  const nowSec = now / 1000;

  for (const [id, m] of Object.entries(monkeyState)) {
    const isPlayer = viewMode === MODE_FIRST && id === followId;

    if (isPlayer) {
      if (isVR) {
        updateVRLocomotion(m, dt);
      } else {
        updateDesktopMovement(m, dt);
      }
    } else {
      updateAI(m, id, dt, now);
    }

    // Gravity
    m.vel.y -= PHYSICS.gravity * dt;

    // Apply velocity
    m.pos.x += m.vel.x * dt;
    m.pos.y += m.vel.y * dt;
    m.pos.z += m.vel.z * dt;

    // Friction (horizontal only)
    if (m.onGround) {
      m.vel.x *= PHYSICS.friction;
      m.vel.z *= PHYSICS.friction;
    } else {
      // Air friction (lighter)
      m.vel.x *= 0.99;
      m.vel.z *= 0.99;
    }

    // Speed cap
    const hSpeed = Math.sqrt(m.vel.x * m.vel.x + m.vel.z * m.vel.z);
    if (hSpeed > PHYSICS.maxSpeed) {
      const scale = PHYSICS.maxSpeed / hSpeed;
      m.vel.x *= scale;
      m.vel.z *= scale;
    }

    // Collision resolution
    const wasOnGround = m.onGround;
    m.onGround = resolveCollisions(m.pos, m.vel, isPlayer);

    // Land sound
    if (!wasOnGround && m.onGround && isPlayer) playLand();

    // Keep in arena bounds
    m.pos.x = Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, m.pos.x));
    m.pos.z = Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, m.pos.z));

    // Floor clamp
    if (m.pos.y < 0) { m.pos.y = 0; m.vel.y = 0; m.onGround = true; }

    // Update mesh position
    m.mesh.position.copy(m.pos);

    // Face direction of movement (for AI monkeys)
    if (!isPlayer && hSpeed > 0.5) {
      m.mesh.rotation.y = Math.atan2(m.vel.x, m.vel.z);
    }

    // Label follows
    m.label.position.set(m.pos.x, m.pos.y + 2.2, m.pos.z);

    // Animate limbs
    animateMonkey(m, now);
  }

  // Tag detection
  if (itMonkeyId && monkeyState[itMonkeyId] && nowSec - lastTagTime > TAG_COOLDOWN) {
    const itM = monkeyState[itMonkeyId];
    for (const [id, m] of Object.entries(monkeyState)) {
      if (id === itMonkeyId) continue;
      const dist = _v1.set(m.pos.x - itM.pos.x, m.pos.y - itM.pos.y, m.pos.z - itM.pos.z).length();
      if (dist < PHYSICS.tagRadius) {
        // Tag!
        const taggerIsPlayer = itMonkeyId === followId;
        monkeyState[itMonkeyId].score++;
        itMonkeyId = id;
        lastTagTime = nowSec;
        playTag();

        // Update labels
        for (const [lid, lm] of Object.entries(monkeyState)) {
          const sess = sessions.find(s => s.id === lid);
          updateLabel(lm.label._ctx, sess ? sess.name : lid, lm.colorIdx, lid === itMonkeyId, lm.score);
          lm.label.material.map.needsUpdate = true;
        }
        updateHUD();
        showItFlash();
        break;
      }
    }
  }

  // Desktop click-to-tag
  if (viewMode === MODE_FIRST && followId && input.click && followId === itMonkeyId) {
    input.click = false;
    const playerM = monkeyState[followId];
    if (playerM) {
      // Find closest monkey in front of player
      let bestDist = PHYSICS.tagRadius * 1.5;
      let bestId = null;
      const forward = _v2.set(0, 0, -1).applyQuaternion(_q1.setFromEuler(new THREE.Euler(0, mouseYaw, 0)));
      for (const [id, m] of Object.entries(monkeyState)) {
        if (id === followId) continue;
        _v1.set(m.pos.x - playerM.pos.x, m.pos.y - playerM.pos.y, m.pos.z - playerM.pos.z);
        const dist = _v1.length();
        if (dist < bestDist && _v1.normalize().dot(forward) > 0.5) {
          bestDist = dist; bestId = id;
        }
      }
      if (bestId && (performance.now() / 1000) - lastTagTime > TAG_COOLDOWN) {
        monkeyState[followId].score++;
        itMonkeyId = bestId;
        lastTagTime = performance.now() / 1000;
        playTag();
        for (const [lid, lm] of Object.entries(monkeyState)) {
          const sess = sessions.find(s => s.id === lid);
          updateLabel(lm.label._ctx, sess ? sess.name : lid, lm.colorIdx, lid === itMonkeyId, lm.score);
          lm.label.material.map.needsUpdate = true;
        }
        updateHUD();
        showItFlash();
      }
    }
  }
}

// ── Desktop movement ────────────────────────────────────────────────────────

function updateDesktopMovement(m, dt) {
  const forward = _v2.set(0, 0, -1).applyQuaternion(_q1.setFromEuler(new THREE.Euler(0, mouseYaw, 0)));
  const right = _v3.set(forward.z, 0, -forward.x);

  const moveSpeed = 8;
  let moveX = 0, moveZ = 0;
  if (input.w) { moveX += forward.x; moveZ += forward.z; }
  if (input.s) { moveX -= forward.x; moveZ -= forward.z; }
  if (input.a) { moveX -= right.x; moveZ -= right.z; }
  if (input.d) { moveX += right.x; moveZ += right.z; }

  const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (len > 0) {
    moveX /= len; moveZ /= len;
    m.vel.x += (moveX * moveSpeed - m.vel.x) * 5 * dt;
    m.vel.z += (moveZ * moveSpeed - m.vel.z) * 5 * dt;
  }

  // Jump
  if (input.space && m.onGround) {
    m.vel.y = 8 * PHYSICS.jumpMultiplier;
    input.space = false;
    playJump();
  }
}

// ── VR Gorilla Tag locomotion + snap turn ───────────────────────────────────

let vrSnapTurnCooldown = false;
let vrJumpedThisPush = [false, false]; // per-hand jump flag to prevent multi-frame jumps
let vrThumbstickJumpReady = true; // debounce for thumbstick jump

function updateVRLocomotion(m, dt) {
  const session = renderer.xr.getSession();

  // ── 1. Snap turn via right thumbstick ──
  if (session) {
    for (const source of session.inputSources) {
      if (!source.gamepad || source.handedness !== 'right') continue;
      const axes = source.gamepad.axes;
      if (axes.length < 4) continue;
      const stickX = axes[2];
      if (Math.abs(stickX) > 0.6 && !vrSnapTurnCooldown) {
        cameraRig.rotateY(stickX > 0 ? -Math.PI / 6 : Math.PI / 6);
        vrSnapTurnCooldown = true;
      }
      if (Math.abs(stickX) < 0.3) vrSnapTurnCooldown = false;
    }
  }

  // ── 2. Thumbstick locomotion (left stick = smooth move, A/X button = jump) ──
  let vrJumpBtnPressed = false;
  if (session) {
    for (const source of session.inputSources) {
      if (!source.gamepad) continue;
      const axes = source.gamepad.axes;
      if (axes.length < 4) continue;

      if (source.handedness === 'left') {
        const stickX = axes[2];
        const stickY = axes[3];
        const deadzone = 0.15;
        const moveSpeed = 6;

        if (Math.abs(stickX) > deadzone || Math.abs(stickY) > deadzone) {
          camera.getWorldDirection(_v1);
          _v1.y = 0;
          _v1.normalize();
          _v2.crossVectors(_v1, _v3.set(0, 1, 0)).normalize();
          const targetX = (_v1.x * -stickY + _v2.x * stickX) * moveSpeed;
          const targetZ = (_v1.z * -stickY + _v2.z * stickX) * moveSpeed;
          m.vel.x += (targetX - m.vel.x) * 5 * dt;
          m.vel.z += (targetZ - m.vel.z) * 5 * dt;
        }
      }

      // A/X button (index 4) or thumbstick press (index 3) — check both controllers
      if ((source.gamepad.buttons.length > 4 && source.gamepad.buttons[4].pressed) ||
          (source.gamepad.buttons.length > 3 && source.gamepad.buttons[3].pressed)) {
        vrJumpBtnPressed = true;
      }
    }
  }
  // Apply button jump after checking all controllers
  if (vrJumpBtnPressed && m.onGround && vrThumbstickJumpReady) {
    m.vel.y = 6 * PHYSICS.jumpMultiplier;
    playJump();
    vrThumbstickJumpReady = false;
  } else if (!vrJumpBtnPressed) {
    vrThumbstickJumpReady = true;
  }

  // ── 3. Smooth Gorilla Tag arm-swing locomotion ──
  // Both hands accumulate acceleration; applied once per frame for smooth movement.
  // Uses acceleration (+=) not assignment (=) so alternating arms blend smoothly.
  const accelRate = 14;
  let totalPushX = 0;
  let totalPushZ = 0;
  let shouldJump = false;
  let jumpStrength = 0;

  for (let hi = 0; hi < vrHands.length; hi++) {
    const hand = vrHands[hi];
    hand.controller.getWorldPosition(_v1);

    // Compute instantaneous velocity
    _v2.subVectors(_v1, hand.prevPos).divideScalar(dt || 1 / 72);

    // Store in ring buffer
    const base = hand.idx * 3;
    hand.posHistory[base] = _v2.x;
    hand.posHistory[base + 1] = _v2.y;
    hand.posHistory[base + 2] = _v2.z;
    hand.idx = (hand.idx + 1) % VR_VEL_FRAMES;

    // Average velocity from ring buffer
    hand.vel.set(0, 0, 0);
    for (let i = 0; i < VR_VEL_FRAMES; i++) {
      hand.vel.x += hand.posHistory[i * 3];
      hand.vel.y += hand.posHistory[i * 3 + 1];
      hand.vel.z += hand.posHistory[i * 3 + 2];
    }
    hand.vel.divideScalar(VR_VEL_FRAMES);

    const speed = hand.vel.length();

    // Only apply force when hand is touching/near a surface (Gorilla Tag style)
    const touching = isTouchingSurface(_v1);

    if (touching && speed > 0.8) {
      // Accumulate push: opposite of hand horizontal velocity
      totalPushX -= hand.vel.x;
      totalPushZ -= hand.vel.z;

      // Jump from strong downward hand motion — only once per push
      if (hand.vel.y < -2.0 && m.onGround && !vrJumpedThisPush[hi]) {
        shouldJump = true;
        jumpStrength = Math.max(jumpStrength, Math.min(6 * PHYSICS.jumpMultiplier, -hand.vel.y * PHYSICS.jumpMultiplier * 1.2));
        vrJumpedThisPush[hi] = true;
      }
    } else {
      // Hand left the surface — reset jump flag for next contact
      vrJumpedThisPush[hi] = false;
    }

    hand.prevPos.copy(_v1);
  }

  // Apply accumulated push as smooth acceleration (not direct velocity set)
  if (totalPushX !== 0 || totalPushZ !== 0) {
    m.vel.x += totalPushX * accelRate * dt;
    m.vel.z += totalPushZ * accelRate * dt;
  }

  // Apply jump if triggered (only once, not every frame)
  if (shouldJump) {
    m.vel.y = jumpStrength;
    playJump();
  }
}

// ── Camera ──────────────────────────────────────────────────────────────────

const orbitAngle = { theta: Math.PI / 4, phi: Math.PI / 6 };
const orbitDist = 35;

function updateCamera() {
  if (renderer.xr.isPresenting) {
    if (followId && monkeyState[followId]) {
      const m = monkeyState[followId];
      cameraRig.position.copy(m.pos);
      // Do NOT add 1.5 — the VR headset already tracks head height
    }
    return;
  }

  if (viewMode === MODE_ORBIT) {
    // Orbit camera looking at arena center
    const cx = orbitDist * Math.cos(orbitAngle.phi) * Math.sin(orbitAngle.theta);
    const cy = orbitDist * Math.sin(orbitAngle.phi) + 5;
    const cz = orbitDist * Math.cos(orbitAngle.phi) * Math.cos(orbitAngle.theta);
    camera.position.set(cx, cy, cz);
    camera.lookAt(0, 2, 0);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  } else if (viewMode === MODE_FIRST && followId && monkeyState[followId]) {
    const m = monkeyState[followId];
    // First-person from monkey head
    const eyePos = _v1.set(m.pos.x, m.pos.y + 1.6, m.pos.z);
    camera.position.copy(eyePos);
    // Apply mouse look
    camera.rotation.order = 'YXZ';
    camera.rotation.y = mouseYaw;
    camera.rotation.x = mousePitch;
    camera.fov = 75;
    camera.updateProjectionMatrix();

    // Update player monkey facing direction
    m.mesh.rotation.y = mouseYaw;

    // Hide player monkey in first person
    m.mesh.visible = false;
    m.label.visible = false;
  }
}

// ── Orbit camera drag ───────────────────────────────────────────────────────

let orbitDragging = false;
canvas.addEventListener('mousedown', (e) => {
  if (viewMode === MODE_ORBIT) { orbitDragging = true; }
});
canvas.addEventListener('mouseup', () => { orbitDragging = false; });
canvas.addEventListener('mousemove', (e) => {
  if (orbitDragging && viewMode === MODE_ORBIT) {
    orbitAngle.theta += e.movementX * 0.005;
    orbitAngle.phi = Math.max(0.05, Math.min(Math.PI / 2.5, orbitAngle.phi + e.movementY * 0.005));
  }
});

// ── VR Monkey Selection Panel ──────────────────────────────────────────────

function createVRSelectionPanel() {
  removeVRSelectionPanel();
  if (sessions.length === 0) return;

  vrSelectionPanel = new THREE.Group();
  vrSelectionCards = [];

  const cols = Math.min(sessions.length, 3);
  const rows = Math.ceil(sessions.length / cols);
  const cardW = 0.4, cardH = 0.5, gap = 0.08;
  const totalW = cols * cardW + (cols - 1) * gap;
  const totalH = rows * cardH + (rows - 1) * gap;

  // Title
  const titleCanvas = document.createElement('canvas');
  titleCanvas.width = 512; titleCanvas.height = 64;
  const tCtx = titleCanvas.getContext('2d');
  tCtx.fillStyle = 'rgba(0,0,0,0.85)';
  tCtx.fillRect(0, 0, 512, 64);
  tCtx.fillStyle = '#8f8';
  tCtx.font = '24px "Press Start 2P", monospace';
  tCtx.textAlign = 'center'; tCtx.textBaseline = 'middle';
  tCtx.fillText('CHOOSE YOUR MONKEY', 256, 32);
  const titleTex = new THREE.CanvasTexture(titleCanvas);
  const titleMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(totalW + 0.2, 0.2),
    new THREE.MeshBasicMaterial({ map: titleTex })
  );
  titleMesh.position.set(0, totalH / 2 + 0.2, 0);
  vrSelectionPanel.add(titleMesh);

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = (col - (cols - 1) / 2) * (cardW + gap);
    const y = ((rows - 1) / 2 - row) * (cardH + gap);

    const colorIdx = monkeyState[s.id] ? monkeyState[s.id].colorIdx : i;
    const color = MONKEY_COLORS[colorIdx % MONKEY_COLORS.length];

    // Card canvas
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 320;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = 'rgba(13,17,23,0.9)';
    ctx.fillRect(0, 0, 256, 320);
    ctx.strokeStyle = color.hex; ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 316);

    // Color swatch (monkey preview circle)
    ctx.fillStyle = color.hex;
    ctx.beginPath(); ctx.arc(128, 120, 50, 0, Math.PI * 2); ctx.fill();

    // Monkey face on swatch
    ctx.fillStyle = '#deb887';
    ctx.beginPath(); ctx.arc(128, 130, 25, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(115, 118, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(141, 118, 6, 0, Math.PI * 2); ctx.fill();

    // Name
    const name = s.name.length > 10 ? s.name.slice(0, 9) + '\u2026' : s.name;
    ctx.fillStyle = '#fff';
    ctx.font = '18px "Press Start 2P", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, 128, 220);

    // "SELECT" hint
    ctx.fillStyle = '#8f8';
    ctx.font = '14px "Press Start 2P", monospace';
    ctx.fillText('SELECT', 128, 280);

    const tex = new THREE.CanvasTexture(canvas);
    const cardMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(cardW, cardH),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
    );
    cardMesh.position.set(x, y, 0);
    vrSelectionPanel.add(cardMesh);
    vrSelectionCards.push({ mesh: cardMesh, sessionId: s.id });
  }

  // Position panel 2m in front of camera rig at eye level
  vrSelectionPanel.position.set(0, 1.5, -2);
  cameraRig.add(vrSelectionPanel);
}

function removeVRSelectionPanel() {
  if (vrSelectionPanel) {
    cameraRig.remove(vrSelectionPanel);
    vrSelectionPanel.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
    vrSelectionPanel = null;
    vrSelectionCards = [];
  }
}

const _selMat4 = new THREE.Matrix4();
function checkVRSelectionRaycast(controller) {
  if (!vrSelectionPanel || vrSelectionCards.length === 0) return;
  _selMat4.identity().extractRotation(controller.matrixWorld);
  vrSelectionRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  vrSelectionRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(_selMat4);

  const meshes = vrSelectionCards.map(c => c.mesh);
  const hits = vrSelectionRaycaster.intersectObjects(meshes);
  if (hits.length > 0) {
    const card = vrSelectionCards.find(c => c.mesh === hits[0].object);
    if (card) {
      removeVRSelectionPanel();
      enterFirstPerson(card.sessionId);
    }
  }
}

// Controller laser pointers for selection mode
const laserGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -5)
]);
const laserMat = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
const laser0 = new THREE.Line(laserGeo, laserMat);
const laser1 = new THREE.Line(laserGeo.clone(), laserMat);
laser0.visible = false;
laser1.visible = false;
controller0.add(laser0);
controller1.add(laser1);

function updateVRLasers() {
  const show = vrSelectionPanel !== null;
  laser0.visible = show;
  laser1.visible = show;
}

// Wire controller select events for VR panel selection
controller0.addEventListener('selectstart', () => checkVRSelectionRaycast(controller0));
controller1.addEventListener('selectstart', () => checkVRSelectionRaycast(controller1));

// Show selection panel when entering VR without a monkey selected
renderer.xr.addEventListener('sessionstart', () => {
  if (!followId) {
    setTimeout(() => createVRSelectionPanel(), 500); // slight delay for XR to settle
  }
});
renderer.xr.addEventListener('sessionend', () => {
  removeVRSelectionPanel();
});

// ── Terminal Station (physical screen in arena) ──────────────────────────

// Log lines displayed on the terminal station screen for VR debugging
const termLog = [];

function termLogMsg(msg, color = '#00ff88') {
  termLog.push({ msg, color, t: Date.now() });
  if (termLog.length > 20) termLog.shift();
  _drawTermLog();
}

function _drawTermLog() {
  if (!termStationCanvas || !termStationTexture) return;
  termStationTexture.image = termStationCanvas;
  const ctx = termStationCanvas.getContext('2d');
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, termStationCanvas.width, termStationCanvas.height);
  ctx.textAlign = 'left';
  const fontSize = 16;
  const lineHeight = fontSize + 6;
  const pad = 12;
  for (let i = 0; i < termLog.length; i++) {
    ctx.fillStyle = termLog[i].color;
    ctx.font = fontSize + 'px monospace';
    ctx.fillText(termLog[i].msg, pad, pad + (i + 1) * lineHeight);
  }
  termStationTexture.needsUpdate = true;
}

function showTermPlaceholder(msg, color = '#00ff88') {
  termLog.length = 0;
  if (!termStationCanvas || !termStationMesh) return;
  const ctx = termStationCanvas.getContext('2d');
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, termStationCanvas.width, termStationCanvas.height);
  ctx.fillStyle = color;
  ctx.font = 'bold 24px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(msg, termStationCanvas.width / 2, termStationCanvas.height / 2);
  // Swap back to placeholder texture (no dispose — safe during XR frames)
  termStationMesh.material.map = termStationTexture;
  termStationTexture.needsUpdate = true;
  termStationMesh.material.needsUpdate = true;
}

// Mirror terminal: one reusable offscreen xterm + CanvasAddon.
// Data piped from parent's onSessionData bridge (raw WS output forwarding).
let _mirrorUnsub = null; // unsubscribe function for data listener

function ensureMirrorTerminal() {
  if (termMirrorTerm) return;
  const parentDoc = parent.document;
  const Terminal = parent.window.Terminal;
  const CanvasAddon = parent.window.CanvasAddon?.CanvasAddon;
  if (!Terminal || !CanvasAddon) {
    console.warn('[MonkeyCode] Terminal or CanvasAddon not loaded yet');
    return;
  }
  let container = parentDoc.getElementById('monkey-term-mirror');
  if (!container) {
    container = parentDoc.createElement('div');
    container.id = 'monkey-term-mirror';
    // On-screen (so IntersectionObserver considers it visible and CanvasAddon renders)
    // but behind everything and non-interactive
    container.style.cssText = 'position:fixed; left:0; top:0; width:1600px; height:800px; overflow:hidden; z-index:-1; pointer-events:none; opacity:0.01;';
    parentDoc.body.appendChild(container);
  }
  termMirrorTerm = new Terminal({ fontSize: 14, cols: 80, rows: 24 });
  termMirrorTerm.open(container);
  termMirrorTerm.loadAddon(new CanvasAddon());
  termMirrorCanvas = container.querySelector('canvas');
}

// Pre-create mirror terminal at startup so it's ready before VR starts
ensureMirrorTerminal();

// Pre-create texture for the mirror canvas (avoids dispose/recreate during XR)
let termMirrorTexture = null;
if (termMirrorCanvas) {
  termMirrorTexture = new THREE.CanvasTexture(termMirrorCanvas);
  termMirrorTexture.minFilter = THREE.LinearFilter;
}

function updateTerminalStation(sessionId) {
  termLog.length = 0;

  // Unsubscribe from previous session's data
  if (_mirrorUnsub) { _mirrorUnsub(); _mirrorUnsub = null; }

  termStationSessionId = sessionId;
  if (!sessionId) {
    showTermPlaceholder('MONKEY CODE TERMINAL');
    return;
  }

  try {
    const bridge = parent.window.__deepsteve;
    if (!bridge || typeof bridge.getTerminal !== 'function') {
      termLogMsg('ERROR: bridge missing — refresh page', '#ff4444');
      return;
    }
    const srcTerm = bridge.getTerminal(sessionId);
    if (!srcTerm) {
      termLogMsg('ERROR: no terminal for ' + sessionId, '#ff4444');
      return;
    }

    ensureMirrorTerminal();
    if (!termMirrorCanvas) {
      termLogMsg('ERROR: mirror canvas missing', '#ff4444');
      return;
    }

    // Match mirror terminal dimensions to source terminal
    if (termMirrorTerm.cols !== srcTerm.cols || termMirrorTerm.rows !== srcTerm.rows) {
      termMirrorTerm.resize(srcTerm.cols, srcTerm.rows);
      // Update canvas reference after resize (CanvasAddon may recreate it)
      const newCanvas = termMirrorTerm.element?.closest('#monkey-term-mirror')?.querySelector('canvas');
      if (newCanvas && newCanvas !== termMirrorCanvas) {
        termMirrorCanvas = newCanvas;
        termMirrorTexture = new THREE.CanvasTexture(termMirrorCanvas);
        termMirrorTexture.minFilter = THREE.LinearFilter;
      }
    }

    // Seed mirror with current buffer content
    termMirrorTerm.reset();
    const buf = srcTerm.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    if (lines.length) termMirrorTerm.write(lines.join('\r\n'));

    // Force CanvasAddon to render after IntersectionObserver has fired
    setTimeout(() => {
      if (termMirrorTerm) termMirrorTerm.refresh(0, termMirrorTerm.rows - 1);
    }, 150);

    // Subscribe to raw output data — piped from parent's WS handler
    _mirrorUnsub = bridge.onSessionData(sessionId, (data) => {
      termMirrorTerm.write(data);
    });

    // Create texture lazily if startup creation missed it (e.g. globals not ready yet)
    if (!termMirrorTexture && termMirrorCanvas) {
      termMirrorTexture = new THREE.CanvasTexture(termMirrorCanvas);
      termMirrorTexture.minFilter = THREE.LinearFilter;
    }

    // Swap to mirror texture
    if (termMirrorTexture) {
      termStationMesh.material.map = termMirrorTexture;
      termStationMesh.material.needsUpdate = true;
    }
  } catch (e) {
    termLogMsg('EXCEPTION: ' + e.message, '#ff4444');
    termLogMsg('  ' + (e.stack || '').split('\n')[1]?.trim(), '#ff8800');
  }
}

let _lastMirrorRefresh = 0;

function updateTerminalStation_tick() {
  if (termMirrorTexture && termStationSessionId) {
    termMirrorTexture.needsUpdate = true;
  }
  // Throttled refresh to force CanvasAddon to render new data to canvas (~4/sec)
  if (termMirrorTerm && termStationSessionId) {
    const now = performance.now();
    if (now - _lastMirrorRefresh > 250) {
      _lastMirrorRefresh = now;
      termMirrorTerm.refresh(0, termMirrorTerm.rows - 1);
    }
  }
  updateVRKeyboard();
}

// ── VR Keyboard (Quest system keyboard via focused textarea) ────────────────

const KEYBOARD_RANGE = 3.5; // distance to terminal station to trigger keyboard
let vrKeyboardActive = false;
let vrKeyboardEl = null;
let vrKeyboardPrevValue = ''; // track previous value to diff (Quest overwrites on each key)

// Quest WebXR system keyboard: calling .focus() on a text input triggers it.
// Quirk: each keypress overwrites the entire value, so we diff against previous.
// Ref: https://developers.meta.com/horizon/documentation/web/webxr-keyboard/
// IMPORTANT: textarea must be in the TOP-LEVEL document (parent), not the iframe,
// because Quest's system keyboard only activates for inputs in the main browsing context.
{
  const parentDoc = parent.document;
  // Remove any leftover from previous mod load
  const existing = parentDoc.getElementById('vr-keyboard-input');
  if (existing) existing.remove();

  vrKeyboardEl = parentDoc.createElement('textarea');
  vrKeyboardEl.id = 'vr-keyboard-input';
  vrKeyboardEl.autocomplete = 'off';
  vrKeyboardEl.autocapitalize = 'off';
  vrKeyboardEl.spellcheck = false;
  vrKeyboardEl.style.cssText = `
    position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%);
    width: 300px; height: 40px; font-size: 16px; z-index: 9999;
    background: #0d1117; color: #00ff88; border: 2px solid #00ff44;
    border-radius: 6px; padding: 8px; opacity: 0;
    pointer-events: none; transition: opacity 0.3s;
  `;
  vrKeyboardEl.placeholder = 'Type here...';
  parentDoc.body.appendChild(vrKeyboardEl);

  // On Quest, each keypress may overwrite the value. We diff to find new chars.
  // The oninput event is the only reliable way to read keyboard input.
  vrKeyboardEl.addEventListener('input', () => {
    if (!termStationSessionId) return;
    const current = vrKeyboardEl.value;
    if (current === vrKeyboardPrevValue) return;

    // Find what changed — Quest may overwrite, so check if it's a simple append
    if (current.startsWith(vrKeyboardPrevValue)) {
      // Normal append — send the new characters
      let newChars = current.slice(vrKeyboardPrevValue.length);
      if (newChars) {
        // Translate newlines to carriage returns (Enter in textarea adds \n, PTY expects \r)
        newChars = newChars.replace(/\n/g, '\r');
        try { parent.window.__deepsteve.writeSession(termStationSessionId, newChars); } catch (e) {}
        // Strip newlines from textarea so they don't accumulate
        if (current.includes('\n')) {
          vrKeyboardEl.value = current.replace(/\n/g, '');
          vrKeyboardPrevValue = vrKeyboardEl.value;
          return;
        }
      }
    } else if (current.length < vrKeyboardPrevValue.length) {
      // Deletion — send backspace for each deleted character
      const delCount = vrKeyboardPrevValue.length - current.length;
      for (let i = 0; i < delCount; i++) {
        try { parent.window.__deepsteve.writeSession(termStationSessionId, '\x7f'); } catch (e) {}
      }
    } else {
      // Full overwrite (Quest quirk) — clear and resend
      // Send backspaces for old content then new content
      for (let i = 0; i < vrKeyboardPrevValue.length; i++) {
        try { parent.window.__deepsteve.writeSession(termStationSessionId, '\x7f'); } catch (e) {}
      }
      if (current) {
        try { parent.window.__deepsteve.writeSession(termStationSessionId, current.replace(/\n/g, '\r')); } catch (e) {}
      }
    }
    // Strip newlines from tracked value so they don't accumulate
    vrKeyboardEl.value = current.replace(/\n/g, '');
    vrKeyboardPrevValue = vrKeyboardEl.value;
  });

  // Handle Enter and Backspace via keydown (may not fire on Quest, but works on desktop)
  vrKeyboardEl.addEventListener('keydown', (e) => {
    if (!termStationSessionId) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      try { parent.window.__deepsteve.writeSession(termStationSessionId, '\r'); } catch (e2) {}
      vrKeyboardEl.value = '';
      vrKeyboardPrevValue = '';
    }
  });
}

function updateVRKeyboard() {
  if (!renderer.xr.isPresenting || !termStationSessionId || viewMode !== MODE_FIRST) {
    if (vrKeyboardActive) {
      vrKeyboardEl.blur();
      vrKeyboardEl.style.opacity = '0';
      vrKeyboardEl.style.pointerEvents = 'none';
      vrKeyboardActive = false;
    }
    return;
  }

  const playerPos = followId && monkeyState[followId] ? monkeyState[followId].pos : null;
  if (!playerPos) return;

  const dx = playerPos.x - TERM_X;
  const dz = playerPos.z - TERM_Z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist < KEYBOARD_RANGE && !vrKeyboardActive) {
    vrKeyboardEl.style.opacity = '1';
    vrKeyboardEl.style.pointerEvents = 'auto';
    vrKeyboardEl.value = '';
    vrKeyboardPrevValue = '';
    vrKeyboardEl.focus();
    vrKeyboardActive = true;
  } else if (dist >= KEYBOARD_RANGE + 1 && vrKeyboardActive) {
    vrKeyboardEl.blur();
    vrKeyboardEl.style.opacity = '0';
    vrKeyboardEl.style.pointerEvents = 'none';
    vrKeyboardActive = false;
  }
}

// ── Enter / Exit first person ───────────────────────────────────────────────

function enterFirstPerson(sessionId) {
  try {
    startAudio();
    startAmbient();
    followId = sessionId;
    viewMode = MODE_FIRST;

    // Defer terminal setup out of XR frame to avoid blocking the animation loop
    setTimeout(() => updateTerminalStation(sessionId), 0);

    const m = monkeyState[sessionId];
    if (m) {
      m.mesh.visible = false;
      m.label.visible = false;
      mouseYaw = m.mesh.rotation.y;
      mousePitch = 0;
    }

    if (!itMonkeyId) {
      const otherIds = Object.keys(monkeyState).filter(id => id !== sessionId);
      if (otherIds.length > 0) {
        itMonkeyId = otherIds[Math.floor(Math.random() * otherIds.length)];
        lastTagTime = performance.now() / 1000;
        for (const [lid, lm] of Object.entries(monkeyState)) {
          try {
            const sess = sessions.find(s => s.id === lid);
            updateLabel(lm.label._ctx, sess ? sess.name : lid, lm.colorIdx, lid === itMonkeyId, lm.score);
            lm.label.material.map.needsUpdate = true;
          } catch (e) { /* label update is non-critical */ }
        }
      }
    }

    if (!renderer.xr.isPresenting) {
      showTerminal(sessionId);
      canvas.focus(); // Ensure iframe receives keyboard events for WASD
      onResize();
    }
    updateHUD();
  } catch (e) {
    console.error('[MonkeyCode] enterFirstPerson error:', e);
  }
}

function exitFirstPerson() {
  if (document.pointerLockElement) document.exitPointerLock();
  updateTerminalStation(null);
  if (followId && monkeyState[followId]) {
    monkeyState[followId].mesh.visible = true;
    monkeyState[followId].label.visible = true;
  }
  hideTerminal();
  followId = null;
  viewMode = MODE_ORBIT;
  if (!renderer.xr.isPresenting) onResize();
  updateHUD();

  // In VR, re-show the selection panel so user can pick another monkey
  if (renderer.xr.isPresenting) {
    setTimeout(() => createVRSelectionPanel(), 300);
  }
}

// ── Terminal (real xterm.js reparented) ──────────────────────────────────────

function showTerminal(sessionId) {
  hideTerminal();

  const parentDoc = parent.document;
  const termContainer = parentDoc.getElementById('term-' + sessionId);
  if (!termContainer) return;

  originalTermParent = termContainer.parentNode;
  originalTermNext = termContainer.nextSibling;

  terminalPanelEl = parentDoc.createElement('div');
  terminalPanelEl.id = 'monkey-terminal-panel';
  terminalPanelEl.style.cssText = `
    position: fixed;
    bottom: 30px;
    right: 30px;
    width: 42%;
    height: 55%;
    z-index: 999;
    perspective: 800px;
    pointer-events: none;
  `;

  const screen = parentDoc.createElement('div');
  screen.id = 'monkey-screen';
  screen.style.cssText = `
    width: 100%;
    height: 100%;
    transform: rotateY(-8deg) rotateX(2deg);
    transform-origin: right center;
    border-radius: 8px;
    overflow: hidden;
    box-shadow:
      0 0 30px rgba(0, 200, 100, 0.15),
      0 0 60px rgba(0, 200, 100, 0.05),
      inset 0 0 1px rgba(255,255,255,0.1);
    border: 3px solid #333;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    pointer-events: auto;
  `;
  terminalPanelEl.appendChild(screen);

  // Header bar
  const header = parentDoc.createElement('div');
  header.style.cssText = `
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 10px; background: #161b22; border-bottom: 1px solid #333;
    font-family: 'Press Start 2P', monospace; flex-shrink: 0;
  `;

  const session = sessions.find(s => s.id === sessionId);
  const color = monkeyState[sessionId] ? MONKEY_COLORS[monkeyState[sessionId].colorIdx % MONKEY_COLORS.length] : MONKEY_COLORS[0];

  const nameRow = parentDoc.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

  const dot = parentDoc.createElement('div');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color.hex};box-shadow:0 0 6px ${color.hex};`;
  nameRow.appendChild(dot);

  const nameSpan = parentDoc.createElement('span');
  nameSpan.textContent = session ? session.name : sessionId;
  nameSpan.style.cssText = 'font-size:8px;color:#aaa;';
  nameRow.appendChild(nameSpan);
  header.appendChild(nameRow);

  const btnGroup = parentDoc.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:6px;';

  const fullBtn = parentDoc.createElement('button');
  fullBtn.textContent = '\u2922';
  fullBtn.title = 'Open terminal fullscreen';
  fullBtn.style.cssText = `
    background:transparent; border:1px solid #444; border-radius:3px;
    color:#8b949e; font-size:12px; padding:2px 6px; cursor:pointer;
    line-height:1;
  `;
  fullBtn.addEventListener('click', () => {
    if (window.deepsteve) window.deepsteve.focusSession(sessionId);
  });
  btnGroup.appendChild(fullBtn);
  header.appendChild(btnGroup);
  screen.appendChild(header);

  // Terminal wrapper
  const termWrapper = parentDoc.createElement('div');
  termWrapper.style.cssText = 'flex:1;overflow:hidden;';
  screen.appendChild(termWrapper);

  // Move real terminal in
  termContainer.style.display = '';
  termContainer.classList.add('active');
  termWrapper.appendChild(termContainer);

  parentDoc.body.appendChild(terminalPanelEl);

  // Refit
  requestAnimationFrame(() => {
    if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(sessionId);
  });
}

function hideTerminal() {
  if (!terminalPanelEl) return;

  const termContainer = terminalPanelEl.querySelector('.terminal-container');
  if (termContainer && originalTermParent) {
    termContainer.classList.remove('active');
    if (originalTermNext) originalTermParent.insertBefore(termContainer, originalTermNext);
    else originalTermParent.appendChild(termContainer);
    const id = termContainer.id.replace('term-', '');
    requestAnimationFrame(() => {
      if (parent.window.__deepsteve) parent.window.__deepsteve.fitSession(id);
    });
  }

  terminalPanelEl.remove();
  terminalPanelEl = null;
  originalTermParent = null;
  originalTermNext = null;
}

window.addEventListener('unload', hideTerminal);

// Detect mod container hidden (user clicked a tab)
{
  const modContainer = parent.document.getElementById('mod-container');
  if (modContainer) {
    const obs = new MutationObserver(() => {
      if (modContainer.style.display === 'none' && terminalPanelEl) {
        hideTerminal();
        if (viewMode === MODE_FIRST) {
          if (followId && monkeyState[followId]) monkeyState[followId].mesh.visible = true;
          followId = null;
          viewMode = MODE_ORBIT;
          updateHUD();
        }
      }
    });
    obs.observe(modContainer, { attributes: true, attributeFilter: ['style'] });
  }
}

// ── Raycaster (click on monkeys) ────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (viewMode !== MODE_ORBIT) return;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  for (const [id, m] of Object.entries(monkeyState)) {
    if (raycaster.intersectObject(m.mesh, true).length > 0) {
      enterFirstPerson(id);
      return;
    }
  }
});

// ── Resize ──────────────────────────────────────────────────────────────────

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// ── HUD ─────────────────────────────────────────────────────────────────────

const hud = document.getElementById('hud');
let itFlashTimeout = null;

function showItFlash() {
  if (itFlashTimeout) clearTimeout(itFlashTimeout);
  let el = document.getElementById('it-flash');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'it-flash';
  el.textContent = followId === itMonkeyId ? "YOU'RE IT!" : 'TAGGED!';
  hud.appendChild(el);
  itFlashTimeout = setTimeout(() => { el.remove(); itFlashTimeout = null; }, 500);
}

function updateHUD() {
  let html = '';

  // Header
  html += '<div id="header"><div style="display:flex;align-items:center;gap:12px">';
  html += '<h1>MONKEY CODE</h1>';
  html += `<span class="monkey-count">${Object.keys(monkeyState).length} monkey${Object.keys(monkeyState).length !== 1 ? 's' : ''}</span>`;
  html += '</div><div style="display:flex;align-items:center;gap:10px">';
  if (viewMode === MODE_FIRST) html += '<button id="back-btn" class="hud-btn back">BACK</button>';
  html += '</div></div>';

  // Hint
  if (viewMode === MODE_ORBIT && Object.keys(monkeyState).length > 0) {
    html += '<div id="hint">Click a monkey to become it!</div>';
  }

  // Scoreboard
  if (Object.keys(monkeyState).length > 0) {
    html += '<div id="scoreboard">';
    html += '<div class="title">TAG SCORES</div>';
    const sorted = Object.entries(monkeyState)
      .map(([id, m]) => {
        const sess = sessions.find(s => s.id === id);
        return { id, name: sess ? sess.name : id, score: m.score, isIt: id === itMonkeyId, colorIdx: m.colorIdx };
      })
      .sort((a, b) => b.score - a.score);

    for (let i = 0; i < Math.min(sorted.length, 8); i++) {
      const s = sorted[i];
      const c = MONKEY_COLORS[s.colorIdx % MONKEY_COLORS.length];
      const dn = s.name.length > 12 ? s.name.slice(0, 11) + '\u2026' : s.name;
      const active = s.id === followId ? 'active' : '';
      html += `<div class="row ${active}" data-monkey-id="${s.id}" style="cursor:pointer">`;
      html += `<span class="pos" style="color:${i < 3 ? '#8f8' : '#888'}">#${i + 1}</span>`;
      html += `<div class="dot" style="background:${c.hex}"></div>`;
      html += `<span class="name">${esc(dn)}</span>`;
      if (s.isIt) html += '<span class="it-badge">IT</span>';
      html += `<span class="stat">${s.score}</span></div>`;
    }
    html += '</div>';
  }

  // No sessions
  if (sessions.length === 0) {
    html += '<div id="no-monkeys"><div class="big">NO MONKEYS</div><div class="small">Open some Claude sessions to see them swing around!</div></div>';
  }

  // Controls hint in first person
  if (viewMode === MODE_FIRST) {
    const isIt = followId === itMonkeyId;
    const hint = isIt ? 'Click to tag nearby monkeys!' : 'WASD move / Space jump / ESC back';
    html += `<div id="hint">${hint}</div>`;
  }

  // Physics panel
  html += buildPhysicsPanel();

  hud.innerHTML = html;

  // Bind events
  document.getElementById('back-btn')?.addEventListener('click', exitFirstPerson);
  document.querySelectorAll('[data-monkey-id]').forEach(el => {
    el.addEventListener('click', () => enterFirstPerson(el.dataset.monkeyId));
  });

  // Physics panel toggle
  document.getElementById('phys-toggle')?.addEventListener('click', () => {
    physPanelOpen = !physPanelOpen;
    updateHUD();
  });

  // Physics sliders
  for (const key of Object.keys(PHYSICS)) {
    const slider = document.getElementById('phys-' + key);
    if (slider) {
      slider.addEventListener('input', () => {
        PHYSICS[key] = parseFloat(slider.value);
        const valEl = document.getElementById('phys-val-' + key);
        if (valEl) valEl.textContent = PHYSICS[key].toFixed(1);
      });
    }
  }
}

function buildPhysicsPanel() {
  let html = '<div id="physics-panel">';
  html += `<div class="panel-header" id="phys-toggle"><span>PHYSICS</span><span>${physPanelOpen ? '\u25B2' : '\u25BC'}</span></div>`;
  if (physPanelOpen) {
    html += '<div class="panel-body">';
    const sliders = [
      { key: 'gravity', label: 'Gravity', min: 0, max: 40, step: 0.5 },
      { key: 'jumpMultiplier', label: 'Jump Mult', min: 0.5, max: 5, step: 0.1 },
      { key: 'maxSpeed', label: 'Max Speed', min: 5, max: 40, step: 1 },
      { key: 'friction', label: 'Friction', min: 0.5, max: 1, step: 0.01 },
      { key: 'bounciness', label: 'Bounce', min: 0, max: 1, step: 0.05 },
      { key: 'tagRadius', label: 'Tag Radius', min: 1, max: 6, step: 0.5 },
    ];
    for (const s of sliders) {
      html += '<div class="slider-row">';
      html += `<label>${s.label}</label>`;
      html += `<input type="range" id="phys-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${PHYSICS[s.key]}">`;
      html += `<span class="val" id="phys-val-${s.key}">${PHYSICS[s.key].toFixed(1)}</span>`;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Deepsteve bridge ────────────────────────────────────────────────────────

function initBridge() {
  let attempts = 0;
  const poll = setInterval(() => {
    if (window.deepsteve) {
      clearInterval(poll);
      window.deepsteve.onSessionsChanged((list) => {
        sessions = list;
        syncMonkeys();
        updateHUD();
      });
      // Auto-update terminal station when active session changes
      if (window.deepsteve.onActiveSessionChanged) {
        window.deepsteve.onActiveSessionChanged((id) => {
          if (viewMode === MODE_FIRST && followId && followId !== id) return; // don't override first-person choice
          updateTerminalStation(id);
        });
      }
    } else if (++attempts > 100) clearInterval(poll);
  }, 100);
}

function syncMonkeys() {
  const liveIds = new Set(sessions.map(s => s.id));

  // Remove departed monkeys
  for (const id of Object.keys(monkeyState)) {
    if (!liveIds.has(id)) {
      scene.remove(monkeyState[id].mesh);
      scene.remove(monkeyState[id].label);
      if (itMonkeyId === id) itMonkeyId = null;
      delete monkeyState[id];
      if (followId === id) exitFirstPerson();
    }
  }

  // Add new monkeys
  let colorIdx = Object.keys(monkeyState).length;
  for (const s of sessions) {
    if (!monkeyState[s.id]) {
      const mesh = createMonkeyMesh(colorIdx);
      scene.add(mesh);
      const label = createLabel(s.name, colorIdx);
      scene.add(label);

      // Random spawn position
      const spawnX = (Math.random() - 0.5) * (ARENA_SIZE - 8);
      const spawnZ = (Math.random() - 0.5) * (ARENA_SIZE - 8);

      monkeyState[s.id] = {
        id: s.id,
        mesh, label, colorIdx,
        pos: new THREE.Vector3(spawnX, 0, spawnZ),
        vel: new THREE.Vector3(0, 0, 0),
        onGround: false,
        score: 0,
        name: s.name,
        aiState: AI_IDLE,
        aiTarget: new THREE.Vector3(spawnX, 0, spawnZ),
        aiTimer: Math.random() * 3,
      };
      mesh.position.set(spawnX, 0, spawnZ);
      colorIdx++;
    }

    // Update name if changed
    const m = monkeyState[s.id];
    if (m.name !== s.name) {
      m.name = s.name;
      updateLabel(m.label._ctx, s.name, m.colorIdx, s.id === itMonkeyId, m.score);
      m.label.material.map.needsUpdate = true;
    }
  }
}

// ── Animation loop ──────────────────────────────────────────────────────────

let prevTime = performance.now();
let hudThrottleFrame = 0;

function animate(timestamp) {
  const now = timestamp || performance.now();
  const dt = Math.min((now - prevTime) / 1000, 0.05); // cap at 50ms
  prevTime = now;

  updatePhysics(dt, now);
  updateCamera();
  updateTerminalStation_tick();
  updateVRLasers();

  // Show/hide monkeys in first person
  for (const [id, m] of Object.entries(monkeyState)) {
    if (viewMode === MODE_FIRST && id === followId) {
      m.mesh.visible = false;
      m.label.visible = false;
    } else {
      m.mesh.visible = true;
      m.label.visible = true;
    }
  }

  // Throttled HUD update (~5 times/sec)
  hudThrottleFrame++;
  if (hudThrottleFrame % 12 === 0) updateHUD();

  renderer.render(scene, camera);
}

// ── Start ───────────────────────────────────────────────────────────────────

initBridge();
onResize();
updateHUD();

// Use renderer.setAnimationLoop for WebXR compatibility
renderer.setAnimationLoop(animate);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/screenshots/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #screenshots-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="screenshots-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/modern-screenshot@4.6.8/dist/index.js"></script>
  <script type="text/babel" data-type="module" src="screenshots.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/screenshots/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Screenshots",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Capture terminal screenshots as PNG images",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 360, "minWidth": 200 },
  "toolbar": { "label": "Screenshots" },
  "tools": [
    { "name": "screenshot_capture", "description": "Capture a screenshot of a DOM element in the deepsteve browser tab and save it as a PNG file. Returns the file path. Use CSS selectors to target specific elements (e.g. \"#app-container\", \"#tabs\", \"#content-row\"). Make sure the Screenshots mod is enabled in deepsteve." }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/screenshots/screenshots.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useCallback, useRef, useEffect } = React;

function ScreenshotsPanel() {
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [status, setStatus] = useState(null);
  const statusTimer = useRef(null);

  const showStatus = useCallback((text, type) => {
    setStatus({ text, type });
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 3000);
  }, []);

  const capture = useCallback(async () => {
    setCapturing(true);
    setStatus(null);
    try {
      const xtermEl = parent.document.querySelector('.terminal-container.active .xterm');
      if (!xtermEl) {
        showStatus('No active terminal', 'error');
        setCapturing(false);
        return;
      }
      const dataUrl = await window.modernScreenshot.domToPng(xtermEl);
      setImageDataUrl(dataUrl);
      showStatus('Captured', 'success');
    } catch (e) {
      console.error('Screenshot capture failed:', e);
      showStatus('Capture failed: ' + e.message, 'error');
    }
    setCapturing(false);
  }, [showStatus]);

  const copyToClipboard = useCallback(async () => {
    if (!imageDataUrl) return;
    try {
      const res = await fetch(imageDataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showStatus('Copied to clipboard', 'success');
    } catch (e) {
      console.error('Copy failed:', e);
      showStatus('Copy failed — try downloading instead', 'error');
    }
  }, [imageDataUrl, showStatus]);

  const download = useCallback(() => {
    if (!imageDataUrl) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = imageDataUrl;
    a.download = `deepsteve-${timestamp}.png`;
    a.click();
    showStatus('Downloaded', 'success');
  }, [imageDataUrl, showStatus]);

  // Handle MCP screenshot_capture requests
  useEffect(() => {
    if (!window.deepsteve?.onScreenshotCaptureRequest) return;
    return window.deepsteve.onScreenshotCaptureRequest(async (req) => {
      const { requestId, selector } = req;
      try {
        const el = parent.document.querySelector(selector);
        if (!el) {
          await fetch('/api/screenshots/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId, error: `Element not found: ${selector}` }),
          });
          return;
        }
        const dataUrl = await window.modernScreenshot.domToPng(el);
        setImageDataUrl(dataUrl);
        await fetch('/api/screenshots/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, dataUrl }),
        });
      } catch (e) {
        await fetch('/api/screenshots/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, error: e.message }),
        });
      }
    });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc', marginBottom: 8 }}>
          Screenshots
        </div>
        <button
          onClick={capture}
          disabled={capturing}
          style={{
            width: '100%',
            padding: '8px 12px',
            fontSize: 13,
            fontWeight: 600,
            border: 'none',
            borderRadius: 6,
            cursor: capturing ? 'wait' : 'pointer',
            background: capturing ? '#1a5c2a' : '#238636',
            color: '#fff',
            opacity: capturing ? 0.7 : 1,
          }}
        >
          {capturing ? 'Capturing...' : 'Capture Terminal'}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* Status message */}
        {status && (
          <div style={{
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 4,
            marginBottom: 10,
            background: status.type === 'error' ? 'rgba(248,81,73,0.1)' : 'rgba(63,185,80,0.1)',
            color: status.type === 'error' ? '#f85149' : '#3fb950',
            border: `1px solid ${status.type === 'error' ? 'rgba(248,81,73,0.2)' : 'rgba(63,185,80,0.2)'}`,
          }}>
            {status.text}
          </div>
        )}

        {imageDataUrl ? (
          <div>
            {/* Preview */}
            <img
              src={imageDataUrl}
              style={{
                width: '100%',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.06)',
                marginBottom: 10,
              }}
              alt="Terminal screenshot"
            />

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={copyToClipboard}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  fontSize: 12,
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#c9d1d9',
                }}
              >
                Copy
              </button>
              <button
                onClick={download}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  fontSize: 12,
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#c9d1d9',
                }}
              >
                Download
              </button>
            </div>
          </div>
        ) : (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            Capture a screenshot of the active terminal viewport.
          </div>
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('screenshots-root'));
root.render(<ScreenshotsPanel />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/screenshots/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 30000; // 30s — screenshots can be slow

/**
 * Initialize screenshot MCP tools.
 */
function init(context) {
  const { broadcast, broadcastToWindow, shells } = context;

  // Resolve session_id to a windowId, returning the send function
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }) };
      }
    }
    return { send: broadcast };
  }

  return {
    screenshot_capture: {
      description: 'Capture a screenshot of a DOM element in the deepsteve management UI browser tab and save it as a PNG file. Returns the file path. IMPORTANT: This only captures elements from the deepsteve web interface itself — it cannot screenshot external websites, your project\'s frontend, or any other browser tab. Use CSS selectors to target deepsteve UI elements (e.g. "#app-container", "#tabs", "#content-row"). Make sure the Screenshots mod is enabled in deepsteve.',
      schema: {
        selector: z.string().describe('CSS selector for the element to capture (e.g. "#app-container", ".terminal-container.active")'),
        filename: z.string().optional().describe('Output filename (without extension). Defaults to "screenshot-<timestamp>".'),
        output_dir: z.string().optional().describe('Directory to save the PNG. Defaults to ~/Desktop.'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ selector, filename, output_dir, session_id }) => {
        const requestId = randomUUID();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fname = (filename || `deepsteve-${ts}`) + '.png';
        const dir = output_dir || path.join(require('os').homedir(), 'Desktop');
        const outPath = path.join(dir, fname);
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the Screenshots mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer, outPath });

          send({
            type: 'screenshot-capture-request',
            requestId,
            selector,
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving screenshot results.
 */
function registerRoutes(app, context) {
  // Increase body size limit for base64 image data
  const express = require('express');
  app.post('/api/screenshots/result', express.json({ limit: '50mb' }), (req, res) => {
    const { requestId, dataUrl, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return res.json({ accepted: false });
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else {
      // Validate data URL before writing to disk
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        pending.resolve({
          content: [{ type: 'text', text: 'Error: Invalid or missing dataUrl — expected a data:image/png;base64,… string' }],
        });
        return res.status(400).json({ error: 'Invalid dataUrl' });
      }
      try {
        const base64 = dataUrl.slice('data:image/png;base64,'.length);
        const buf = Buffer.from(base64, 'base64');
        if (buf.length === 0) {
          pending.resolve({
            content: [{ type: 'text', text: 'Error: Screenshot data decoded to an empty buffer' }],
          });
          return res.status(400).json({ error: 'Empty image data' });
        }
        fs.mkdirSync(path.dirname(pending.outPath), { recursive: true });
        fs.writeFileSync(pending.outPath, buf);
        pending.resolve({
          content: [{ type: 'text', text: `Screenshot saved to ${pending.outPath}` }],
        });
      } catch (e) {
        pending.resolve({
          content: [{ type: 'text', text: `Error saving screenshot: ${e.message}` }],
        });
      }
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tasks/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: var(--ds-bg-primary, #0d1117);
      color: var(--ds-text-primary, #c9d1d9);
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #tasks-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="tasks-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="tasks.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tasks/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Tasks",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Task list for human actions, populated by Agent sessions",
  "enabledByDefault": true,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 360, "minWidth": 200 },
  "toolbar": { "label": "Tasks" },
  "tools": [
    { "name": "add_task", "description": "Add a task for the human" },
    { "name": "update_task", "description": "Update a task" },
    { "name": "complete_task", "description": "Mark a task as done" },
    { "name": "list_tasks", "description": "List current tasks" }
  ],
  "settings": [
    { "key": "panelPosition", "type": "boolean", "label": "Panel on left", "description": "Show panel on left side instead of right", "default": false },
    { "key": "compactView", "type": "boolean", "label": "Compact view", "description": "Show only task names (hide descriptions and badges)", "default": false }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tasks/tasks.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useCallback } = React;

const PRIORITY_COLORS = {
  high: '#f85149',
  medium: '#f0883e',
  low: '#8b949e',
};

const STATUS_OPTIONS = ['all', 'pending', 'in-progress', 'done'];

function renderOlGroup(items) {
  const result = [];
  let i = 0;
  const baseIndent = items[0].indent;
  while (i < items.length) {
    const item = items[i];
    if (item.indent > baseIndent) {
      // Collect all consecutive items with indent > baseIndent as a nested group
      const nested = [];
      while (i < items.length && items[i].indent > baseIndent) {
        nested.push(items[i]);
        i++;
      }
      // Append nested <ol> inside the previous <li>
      if (result.length > 0) {
        const prev = result[result.length - 1];
        result[result.length - 1] = (
          <li key={prev.key} style={{ padding: '1px 0' }}>
            {prev.props.children}
            {renderOlGroup(nested)}
          </li>
        );
      } else {
        // Nested items with no parent — render them as a standalone nested list
        result.push(renderOlGroup(nested));
      }
    } else {
      result.push(
        <li key={item.lineIndex} style={{ padding: '1px 0' }}>{item.text}</li>
      );
      i++;
    }
  }
  return (
    <ol style={{ margin: '2px 0', paddingLeft: 20, listStyleType: 'decimal' }}>
      {result}
    </ol>
  );
}

function renderDescription(description, onCheckToggle) {
  if (!description) return null;
  const lines = description.split('\n');
  const checklistRe = /^- \[([ xX])\] (.*)$/;
  const orderedRe = /^(\s*)(\d+)\.\s+(.*)$/;

  const elements = [];
  let olBuffer = [];

  function flushOl() {
    if (olBuffer.length === 0) return;
    elements.push(
      <React.Fragment key={`ol-${olBuffer[0].lineIndex}`}>
        {renderOlGroup(olBuffer)}
      </React.Fragment>
    );
    olBuffer = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Ordered list item
    const olMatch = line.match(orderedRe);
    if (olMatch) {
      olBuffer.push({ indent: olMatch[1].length, text: olMatch[3], lineIndex: i });
      continue;
    }

    // Flush any pending OL items before rendering a non-OL line
    flushOl();

    // Checkbox line
    const checkMatch = line.match(checklistRe);
    if (checkMatch) {
      const checked = checkMatch[1] !== ' ';
      const text = checkMatch[2];
      elements.push(
        <label key={i} style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 5,
          padding: '1px 0',
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onCheckToggle(i)}
            style={{ marginTop: 2, accentColor: '#238636', cursor: 'pointer', flexShrink: 0 }}
          />
          <span style={{
            textDecoration: checked ? 'line-through' : 'none',
            opacity: checked ? 0.6 : 1,
          }}>
            {text}
          </span>
        </label>
      );
      continue;
    }

    // Plain text or empty line
    elements.push(
      line ? <div key={i}>{line}</div> : <div key={i} style={{ height: 4 }} />
    );
  }

  flushOl();

  return (
    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 3, wordBreak: 'break-word' }}>
      {elements}
    </div>
  );
}

function TaskItem({ task, compact, onToggle, onDelete, onDescriptionUpdate }) {
  const isDone = task.status === 'done';

  const handleCheckToggle = useCallback((lineIndex) => {
    const lines = task.description.split('\n');
    const checklistRe = /^- \[([ xX])\] (.*)$/;
    const m = lines[lineIndex].match(checklistRe);
    if (!m) return;
    const checked = m[1] !== ' ';
    lines[lineIndex] = `- [${checked ? ' ' : 'x'}] ${m[2]}`;
    onDescriptionUpdate(task.id, lines.join('\n'));
  }, [task.id, task.description, onDescriptionUpdate]);

  return (
    <div style={{
      padding: compact ? '5px 12px' : '10px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      opacity: isDone ? 0.5 : 1,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
    }}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(task.id, isDone ? 'pending' : 'done')}
        style={{ marginTop: 3, accentColor: '#238636', cursor: 'pointer', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          color: isDone ? '#8b949e' : '#c9d1d9',
          textDecoration: isDone ? 'line-through' : 'none',
          wordBreak: 'break-word',
        }}>
          {task.title}
        </div>
        {!compact && renderDescription(task.description, handleCheckToggle)}
        {!compact && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {task.priority && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                color: PRIORITY_COLORS[task.priority] || '#8b949e',
                border: `1px solid ${PRIORITY_COLORS[task.priority] || '#30363d'}33`,
              }}>
                {task.priority}
              </span>
            )}
            {task.session_tag && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(88,166,255,0.1)',
                color: '#58a6ff',
                border: '1px solid rgba(88,166,255,0.2)',
              }}>
                {task.session_tag}
              </span>
            )}
            {task.status === 'in-progress' && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(240,136,62,0.1)',
                color: '#f0883e',
                border: '1px solid rgba(240,136,62,0.2)',
              }}>
                in progress
              </span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={() => onDelete(task.id)}
        style={{
          background: 'none',
          border: 'none',
          color: '#8b949e',
          cursor: 'pointer',
          fontSize: 14,
          padding: '0 4px',
          opacity: 0.5,
          flexShrink: 0,
        }}
        onMouseEnter={e => e.target.style.opacity = 1}
        onMouseLeave={e => e.target.style.opacity = 0.5}
        title="Delete task"
      >
        &#10005;
      </button>
    </div>
  );
}

function TasksPanel() {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [compactView, setCompactView] = useState(false);

  useEffect(() => {
    let unsubTasks = null;
    let unsubSettings = null;

    function setup() {
      unsubTasks = window.deepsteve.onTasksChanged((newTasks) => {
        setTasks(newTasks || []);
      });

      // Restore persisted settings
      const settings = window.deepsteve.getSettings();
      if (settings.compactView != null) setCompactView(settings.compactView);
      if (settings.statusFilter != null) setFilter(settings.statusFilter);
      if (settings.tagFilter != null) setTagFilter(settings.tagFilter);

      // React to settings changes (e.g. toggled from settings panel)
      unsubSettings = window.deepsteve.onSettingsChanged((settings) => {
        if (settings.compactView != null) setCompactView(settings.compactView);
        if (settings.statusFilter != null) setFilter(settings.statusFilter);
        if (settings.tagFilter != null) setTagFilter(settings.tagFilter);
      });
    }

    // Bridge API is injected by the parent after iframe load event,
    // so it may not be available yet when this effect runs. Poll for it.
    if (window.deepsteve) {
      setup();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) {
          clearInterval(poll);
          setup();
        } else if (++attempts > 100) {
          clearInterval(poll);
        }
      }, 100);
    }

    return () => {
      if (unsubTasks) unsubTasks();
      if (unsubSettings) unsubSettings();
    };
  }, []);

  const toggleStatus = useCallback(async (id, newStatus) => {
    try {
      await fetch(`/api/tasks/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
    } catch (e) {
      console.error('Failed to update task:', e);
    }
  }, []);

  const deleteTask = useCallback(async (id) => {
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete task:', e);
    }
  }, []);

  const updateDescription = useCallback(async (id, description) => {
    try {
      await fetch(`/api/tasks/${id}/description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
    } catch (e) {
      console.error('Failed to update description:', e);
    }
  }, []);

  const handleFilterChange = useCallback((s) => {
    setFilter(s);
    if (window.deepsteve) window.deepsteve.updateSetting('statusFilter', s);
  }, []);

  const handleTagFilterChange = useCallback((t) => {
    setTagFilter(t);
    if (window.deepsteve) window.deepsteve.updateSetting('tagFilter', t);
  }, []);

  const toggleCompactView = useCallback(() => {
    setCompactView(prev => {
      const next = !prev;
      if (window.deepsteve) window.deepsteve.updateSetting('compactView', next);
      return next;
    });
  }, []);

  // Get unique session tags for filter dropdown
  const tags = [...new Set(tasks.map(t => t.session_tag).filter(Boolean))];

  // Apply filters
  let filtered = tasks;
  if (filter !== 'all') filtered = filtered.filter(t => t.status === filter);
  if (tagFilter !== 'all') filtered = filtered.filter(t => t.session_tag === tagFilter);

  // Sort: pending first, then in-progress, then done
  const statusOrder = { 'pending': 0, 'in-progress': 1, 'done': 2 };
  filtered = [...filtered].sort((a, b) => (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc', marginBottom: 8, display: 'flex', alignItems: 'center' }}>
          <span>
            Tasks
            {tasks.length > 0 && (
              <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                {tasks.filter(t => t.status !== 'done').length} pending
              </span>
            )}
          </span>
          <button
            onClick={toggleCompactView}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: compactView ? '#58a6ff' : '#8b949e',
              cursor: 'pointer',
              fontSize: 14,
              padding: '0 2px',
              lineHeight: 1,
            }}
            title={compactView ? 'Expand view' : 'Compact view'}
          >
            &#9776;
          </button>
        </div>

        {/* Status filter */}
        <div style={{ display: 'flex', gap: 2, marginBottom: tags.length > 0 ? 6 : 0 }}>
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => handleFilterChange(s)}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background: filter === s ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                color: filter === s ? '#fff' : '#8b949e',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Session tag filter */}
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={e => handleTagFilterChange(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: 11,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              color: '#c9d1d9',
              cursor: 'pointer',
            }}
          >
            <option value="all">All sessions</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {/* Task list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            {tasks.length === 0
              ? 'No tasks yet. Claude sessions can create tasks via MCP tools.'
              : 'No tasks match the current filter.'}
          </div>
        ) : (
          filtered.map(task => (
            <TaskItem
              key={task.id}
              task={task}
              compact={compactView}
              onToggle={toggleStatus}
              onDelete={deleteTask}
              onDescriptionUpdate={updateDescription}
            />
          ))
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('tasks-root'));
root.render(<TasksPanel />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tasks/tools.js" << 'DEEPSTEVE_FILE_EOF'
const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');

const TASKS_FILE = path.join(os.homedir(), '.deepsteve', 'tasks.json');
let tasks = [];
let nextId = 1;

// Load existing tasks
try {
  if (fs.existsSync(TASKS_FILE)) {
    tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (tasks.length > 0) {
      nextId = Math.max(...tasks.map(t => t.id)) + 1;
    }
  }
} catch {}

function saveTasks() {
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch {}
}

function formatTaskList(filtered) {
  if (filtered.length === 0) return 'No tasks found.';
  return filtered.map(t => {
    const status = t.status === 'done' ? '[x]' : t.status === 'in-progress' ? '[~]' : '[ ]';
    const priority = t.priority ? ` (${t.priority})` : '';
    const tag = t.session_tag ? ` [${t.session_tag}]` : '';
    const desc = t.description ? `\n    ${t.description}` : '';
    return `${status} #${t.id}: ${t.title}${priority}${tag}${desc}`;
  }).join('\n');
}

/**
 * Initialize task tools. Returns tool definitions keyed by name.
 * Each tool has: { description, schema (Zod raw shape), handler }
 */
function init(context) {
  const { broadcast } = context;

  function broadcastTasks() {
    broadcast({ type: 'tasks', tasks });
  }

  return {
    add_task: {
      description: 'Add a task for the human to do',
      schema: {
        title: z.string().describe('Short title of the task'),
        description: z.string().optional().describe('Detailed description'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority level'),
        session_tag: z.string().optional().describe('Tag to identify which session created this task'),
      },
      handler: async ({ title, description, priority, session_tag }) => {
        const task = {
          id: nextId++,
          title,
          description: description || '',
          priority: priority || 'medium',
          status: 'pending',
          session_tag: session_tag || '',
          created: Date.now(),
        };
        tasks.push(task);
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Task #${task.id} created: "${task.title}"` }] };
      },
    },

    update_task: {
      description: 'Update an existing task',
      schema: {
        id: z.number().describe('Task ID to update'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        status: z.enum(['pending', 'in-progress', 'done']).optional().describe('New status'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('New priority'),
      },
      handler: async ({ id, title, description, status, priority }) => {
        const task = tasks.find(t => t.id === id);
        if (!task) return { content: [{ type: 'text', text: `Task #${id} not found.` }] };

        if (title !== undefined) task.title = title;
        if (description !== undefined) task.description = description;
        if (status !== undefined) task.status = status;
        if (priority !== undefined) task.priority = priority;
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Task #${id} updated.` }] };
      },
    },

    complete_task: {
      description: 'Mark a task as done',
      schema: {
        id: z.number().describe('Task ID to complete'),
      },
      handler: async ({ id }) => {
        const task = tasks.find(t => t.id === id);
        if (!task) return { content: [{ type: 'text', text: `Task #${id} not found.` }] };

        task.status = 'done';
        saveTasks();
        broadcastTasks();
        return { content: [{ type: 'text', text: `Task #${id} marked as done.` }] };
      },
    },

    list_tasks: {
      description: 'List current tasks',
      schema: {
        status: z.enum(['pending', 'in-progress', 'done']).optional().describe('Filter by status'),
        session_tag: z.string().optional().describe('Filter by session tag'),
      },
      handler: async ({ status, session_tag }) => {
        let filtered = tasks;
        if (status) filtered = filtered.filter(t => t.status === status);
        if (session_tag) filtered = filtered.filter(t => t.session_tag === session_tag);
        return { content: [{ type: 'text', text: formatTaskList(filtered) }] };
      },
    },
  };
}

/**
 * Register REST endpoints for the browser panel.
 */
function registerRoutes(app, context) {
  const { broadcast } = context;

  function broadcastTasks() {
    broadcast({ type: 'tasks', tasks });
  }

  app.get('/api/tasks', (req, res) => {
    res.json({ tasks });
  });

  app.post('/api/tasks/:id/status', (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!['pending', 'in-progress', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    task.status = status;
    saveTasks();
    broadcastTasks();
    res.json({ task });
  });

  app.post('/api/tasks/:id/description', (req, res) => {
    const id = parseInt(req.params.id);
    const { description } = req.body;
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'Invalid description' });
    }
    task.description = description;
    saveTasks();
    broadcastTasks();
    res.json({ task });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    tasks.splice(idx, 1);
    saveTasks();
    broadcastTasks();
    res.json({ deleted: id });
  });
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/threejs-scene/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #1a1a2e; }
  canvas { display: block; width: 100%; height: 100%; }
  #overlay {
    position: absolute; top: 8px; left: 8px;
    font: 11px/1.4 -apple-system, sans-serif;
    color: rgba(255,255,255,0.4);
    pointer-events: none;
    user-select: none;
  }
</style>
</head>
<body>
<canvas id="scene-canvas"></canvas>
<div id="overlay">3D Scene</div>
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/"
  }
}
</script>
<script type="module" src="scene.js"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/threejs-scene/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "3D Scene",
  "version": "0.5.0",
  "description": "Programmable Three.js scene controlled via MCP tools. Your agent can show you designs while prototyping Three.js games.",
  "enabledByDefault": false,
  "entry": "index.html",
  "display": "panel",
  "panel": { "position": "right", "defaultWidth": 480, "minWidth": 300 },
  "toolbar": { "label": "3D Scene" },
  "tools": [
    { "name": "scene_update", "description": "Add, update, or remove objects in a 3D scene" },
    { "name": "scene_query", "description": "List objects and inspect scene state" },
    { "name": "scene_snapshot", "description": "Capture the current scene as a PNG" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/threejs-scene/scene.js" << 'DEEPSTEVE_FILE_EOF'
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Setup ---
const canvas = document.getElementById('scene-canvas');
const overlay = document.getElementById('overlay');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true, // needed for snapshots
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
camera.position.set(5, 4, 5);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Default lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 8, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

// Grid
const grid = new THREE.GridHelper(20, 20, 0x444466, 0x2a2a44);
scene.add(grid);

// --- Object Registry ---
// id → { object3d, type }
const registry = new Map();

// --- Frame Callbacks ---
const frameCallbacks = new Map(); // id → fn(dt, t)
function onFrame(id, fn) { frameCallbacks.set(id, fn); }
function removeFrame(id) { frameCallbacks.delete(id); }

// --- Resize ---
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// --- Animation Loop ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  // Run frame callbacks
  for (const [id, fn] of frameCallbacks) {
    try { fn(dt, t); } catch (e) {
      console.error(`Frame callback '${id}' error:`, e);
      frameCallbacks.delete(id);
    }
  }

  resize();
  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Geometry Builders ---
function buildGeometry(type, geo = {}) {
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(geo.width || 1, geo.height || 1, geo.depth || 1);
    case 'sphere':
      return new THREE.SphereGeometry(geo.radius || 0.5, geo.widthSegments || 32, geo.heightSegments || 16);
    case 'cylinder':
      return new THREE.CylinderGeometry(geo.radiusTop || 0.5, geo.radiusBottom || 0.5, geo.height || 1, geo.radialSegments || 32);
    case 'cone':
      return new THREE.ConeGeometry(geo.radius || 0.5, geo.height || 1, geo.radialSegments || 32);
    case 'torus':
      return new THREE.TorusGeometry(geo.radius || 0.5, geo.tube || 0.2, geo.radialSegments || 16, geo.tubularSegments || 48);
    case 'plane':
      return new THREE.PlaneGeometry(geo.width || 1, geo.height || 1);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function buildMaterial(mat = {}) {
  const params = {};
  if (mat.color != null) params.color = new THREE.Color(mat.color);
  if (mat.opacity != null) { params.opacity = mat.opacity; params.transparent = true; }
  if (mat.wireframe != null) params.wireframe = mat.wireframe;
  if (mat.metalness != null) params.metalness = mat.metalness;
  if (mat.roughness != null) params.roughness = mat.roughness;
  if (mat.emissive != null) params.emissive = new THREE.Color(mat.emissive);
  if (mat.side === 'double') params.side = THREE.DoubleSide;

  // Use MeshStandardMaterial if metalness/roughness specified, else MeshPhongMaterial
  if (mat.metalness != null || mat.roughness != null) {
    return new THREE.MeshStandardMaterial(params);
  }
  return new THREE.MeshPhongMaterial(params);
}

function applyTransform(obj, op) {
  if (op.position) obj.position.set(...op.position);
  if (op.rotation) obj.rotation.set(...op.rotation);
  if (op.scale) obj.scale.set(...op.scale);
  if (op.visible != null) obj.visible = op.visible;
  if (op.castShadow != null) obj.castShadow = op.castShadow;
  if (op.receiveShadow != null) obj.receiveShadow = op.receiveShadow;
}

// --- Text Sprite (canvas-based) ---
function createTextSprite(textParams = {}) {
  const content = textParams.content || 'Text';
  const fontSize = textParams.fontSize || 48;
  const color = textParams.color || '#ffffff';
  const bgColor = textParams.backgroundColor || null;

  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `${fontSize}px -apple-system, sans-serif`;
  const metrics = ctx.measureText(content);
  const w = Math.ceil(metrics.width) + 20;
  const h = fontSize + 20;
  c.width = w;
  c.height = h;

  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.font = `${fontSize}px -apple-system, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(content, 10, h / 2);

  const texture = new THREE.CanvasTexture(c);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w / h * 1, 1, 1);
  return sprite;
}

// --- Light Builders ---
function buildLight(type, params = {}) {
  const color = params.color != null ? new THREE.Color(params.color) : 0xffffff;
  const intensity = params.intensity != null ? params.intensity : 1;

  let light;
  switch (type) {
    case 'ambient_light':
      light = new THREE.AmbientLight(color, intensity);
      break;
    case 'directional_light':
      light = new THREE.DirectionalLight(color, intensity);
      if (params.castShadow) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
      }
      break;
    case 'point_light':
      light = new THREE.PointLight(color, intensity, params.distance || 0, params.decay || 2);
      if (params.castShadow) light.castShadow = true;
      break;
    case 'spot_light':
      light = new THREE.SpotLight(color, intensity, params.distance || 0, params.angle || Math.PI / 6, params.penumbra || 0.1, params.decay || 2);
      if (params.castShadow) light.castShadow = true;
      break;
    default:
      light = new THREE.PointLight(color, intensity);
  }
  return light;
}

// --- Line Builder ---
function buildLine(geo = {}, mat = {}) {
  const points = (geo.points || [[0,0,0],[1,1,1]]).map(p => new THREE.Vector3(...p));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const color = mat.color != null ? new THREE.Color(mat.color) : 0xffffff;
  const material = new THREE.LineBasicMaterial({ color });
  return new THREE.Line(geometry, material);
}

// --- Operation Handlers ---
function handleAdd(op) {
  if (!op.id) return { error: 'add requires an id' };
  if (!op.type) return { error: 'add requires a type' };
  if (registry.has(op.id)) return { error: `object '${op.id}' already exists` };

  const meshTypes = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane'];
  const lightTypes = ['ambient_light', 'directional_light', 'point_light', 'spot_light'];
  let object3d;

  if (meshTypes.includes(op.type)) {
    const geometry = buildGeometry(op.type, op.geometry);
    const material = buildMaterial(op.material);
    object3d = new THREE.Mesh(geometry, material);
  } else if (lightTypes.includes(op.type)) {
    object3d = buildLight(op.type, op.light);
  } else if (op.type === 'line') {
    object3d = buildLine(op.geometry, op.material);
  } else if (op.type === 'group') {
    object3d = new THREE.Group();
  } else if (op.type === 'text') {
    object3d = createTextSprite(op.text);
  } else if (op.type === 'camera') {
    // Camera is special — update the scene camera
    if (op.camera) {
      if (op.camera.fov != null) camera.fov = op.camera.fov;
      if (op.camera.position) camera.position.set(...op.camera.position);
      if (op.camera.lookAt) camera.lookAt(new THREE.Vector3(...op.camera.lookAt));
      camera.updateProjectionMatrix();
    }
    return { ok: true, id: op.id, type: 'camera', note: 'scene camera updated' };
  } else {
    return { error: `unknown type '${op.type}'` };
  }

  applyTransform(object3d, op);

  // Parent to group if specified
  const parent = op.parent && registry.has(op.parent) ? registry.get(op.parent).object3d : scene;
  if (op.parent && !registry.has(op.parent)) {
    return { error: `parent group '${op.parent}' not found` };
  }
  parent.add(object3d);

  registry.set(op.id, { object3d, type: op.type });

  return { ok: true, id: op.id, type: op.type };
}

function handleUpdate(op) {
  if (!op.id) return { error: 'update requires an id' };

  // Allow updating camera without registry entry
  if (op.id === '__camera__' || op.type === 'camera') {
    if (op.camera) {
      if (op.camera.fov != null) camera.fov = op.camera.fov;
      if (op.camera.position) camera.position.set(...op.camera.position);
      if (op.camera.lookAt) camera.lookAt(new THREE.Vector3(...op.camera.lookAt));
      camera.updateProjectionMatrix();
    }
    if (op.position) camera.position.set(...op.position);
    return { ok: true, id: op.id, type: 'camera' };
  }

  const entry = registry.get(op.id);
  if (!entry) return { error: `object '${op.id}' not found` };

  const obj = entry.object3d;
  applyTransform(obj, op);

  // Update material
  if (op.material && obj.material) {
    const m = op.material;
    if (m.color != null) obj.material.color.set(m.color);
    if (m.opacity != null) { obj.material.opacity = m.opacity; obj.material.transparent = true; }
    if (m.wireframe != null) obj.material.wireframe = m.wireframe;
    if (m.emissive != null && obj.material.emissive) obj.material.emissive.set(m.emissive);
  }

  // Update light properties
  if (op.light) {
    if (op.light.color != null && obj.color) obj.color.set(op.light.color);
    if (op.light.intensity != null) obj.intensity = op.light.intensity;
  }

  // Update text
  if (op.text && entry.type === 'text') {
    const parent = obj.parent;
    parent.remove(obj);
    const newSprite = createTextSprite(op.text);
    applyTransform(newSprite, op);
    parent.add(newSprite);
    entry.object3d = newSprite;
  }

  return { ok: true, id: op.id };
}

function handleRemove(op) {
  if (!op.id) return { error: 'remove requires an id' };
  const entry = registry.get(op.id);
  if (!entry) return { error: `object '${op.id}' not found` };

  entry.object3d.parent.remove(entry.object3d);

  // Dispose geometry/material
  const obj = entry.object3d;
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (obj.material.map) obj.material.map.dispose();
    obj.material.dispose();
  }

  registry.delete(op.id);
  return { ok: true, id: op.id };
}

function handleClear() {
  for (const [id, entry] of registry) {
    entry.object3d.parent.remove(entry.object3d);
    const obj = entry.object3d;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  }
  registry.clear();
  frameCallbacks.clear();
  return { ok: true, cleared: true };
}

// --- Eval ---
function handleEval(op) {
  if (!op.code) return { error: 'eval requires a code string' };
  try {
    const fn = new Function(
      'THREE', 'scene', 'camera', 'renderer', 'registry', 'clock',
      'controls', 'canvas', 'onFrame', 'removeFrame', 'frameCallbacks',
      op.code
    );
    const result = fn(
      THREE, scene, camera, renderer, registry, clock,
      controls, canvas, onFrame, removeFrame, frameCallbacks
    );
    return { ok: true, result: result !== undefined ? String(result) : undefined };
  } catch (e) {
    return { error: e.message };
  }
}

// --- Query ---
function queryScene(id) {
  if (id) {
    const entry = registry.get(id);
    if (!entry) return { error: `object '${id}' not found` };
    const obj = entry.object3d;
    return {
      id,
      type: entry.type,
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z],
      visible: obj.visible,
    };
  }

  // Return all objects
  const objects = [];
  for (const [id, entry] of registry) {
    const obj = entry.object3d;
    objects.push({
      id,
      type: entry.type,
      position: [obj.position.x, obj.position.y, obj.position.z],
    });
  }
  return {
    objectCount: objects.length,
    objects,
    camera: {
      position: [camera.position.x, camera.position.y, camera.position.z],
      fov: camera.fov,
    },
  };
}

// --- Snapshot ---
function captureSnapshot(width, height) {
  // If custom dimensions requested, resize temporarily
  const origW = canvas.width;
  const origH = canvas.height;
  let needRestore = false;

  if (width || height) {
    const w = width || canvas.clientWidth;
    const h = height || canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needRestore = true;
  }

  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL('image/png');

  if (needRestore) {
    renderer.setSize(origW / devicePixelRatio, origH / devicePixelRatio, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }

  return dataUrl;
}

// --- Update overlay ---
function updateOverlay() {
  const count = registry.size;
  overlay.textContent = count > 0 ? `3D Scene (${count} objects)` : '3D Scene';
}

// --- Bridge Callbacks ---
function sendResult(requestId, result) {
  fetch('/api/threejs-scene/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, result }),
  }).catch(err => console.error('Failed to send result:', err));
}

function sendSnapshotResult(requestId, dataUrl) {
  fetch('/api/threejs-scene/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, dataUrl }),
  }).catch(err => console.error('Failed to send snapshot:', err));
}

function sendError(requestId, error) {
  fetch('/api/threejs-scene/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, error }),
  }).catch(err => console.error('Failed to send error:', err));
}

// Wait for bridge API injection, then register callbacks
function waitForBridge() {
  if (!window.deepsteve) {
    setTimeout(waitForBridge, 100);
    return;
  }

  // scene_update
  window.deepsteve.onSceneUpdateRequest((msg) => {
    try {
      const results = [];
      for (const op of (msg.operations || [])) {
        let r;
        switch (op.op) {
          case 'add': r = handleAdd(op); break;
          case 'update': r = handleUpdate(op); break;
          case 'remove': r = handleRemove(op); break;
          case 'clear': r = handleClear(); break;
          case 'eval': r = handleEval(op); break;
          default: r = { error: `unknown op '${op.op}'` };
        }
        results.push(r);
      }
      updateOverlay();
      sendResult(msg.requestId, results);
    } catch (err) {
      sendError(msg.requestId, err.message);
    }
  });

  // scene_query
  window.deepsteve.onSceneQueryRequest((msg) => {
    try {
      const result = queryScene(msg.id);
      sendResult(msg.requestId, result);
    } catch (err) {
      sendError(msg.requestId, err.message);
    }
  });

  // scene_snapshot
  window.deepsteve.onSceneSnapshotRequest((msg) => {
    try {
      const dataUrl = captureSnapshot(msg.width, msg.height);
      sendSnapshotResult(msg.requestId, dataUrl);
    } catch (err) {
      sendError(msg.requestId, err.message);
    }
  });
}

waitForBridge();
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/threejs-scene/tools.js" << 'DEEPSTEVE_FILE_EOF'
const { z } = require('zod');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// Pending requests awaiting browser response: requestId → { resolve, timer }
const pendingRequests = new Map();

const TIMEOUT_MS = 30000; // 30s — snapshots can be slow

/**
 * Initialize Three.js scene MCP tools.
 */
function init(context) {
  const { broadcast, broadcastToWindow, shells } = context;

  // Resolve session_id to a windowId, returning the send function
  function resolveTarget(session_id) {
    if (session_id) {
      const shell = shells.get(session_id);
      if (shell && shell.windowId) {
        const windowId = shell.windowId;
        return { send: (msg) => broadcastToWindow(windowId, { ...msg, targetWindowId: windowId }) };
      }
    }
    return { send: broadcast };
  }

  return {
    scene_update: {
      description: 'Add, update, or remove objects in a 3D scene. Takes a batch of operations so you can build complex scenes in one call. Use eval to run arbitrary Three.js code (animate, create particles, etc). Make sure the 3D Scene mod is enabled in deepsteve.',
      schema: {
        operations: z.array(z.object({
          op: z.enum(['add', 'update', 'remove', 'clear', 'eval']).describe('Operation type'),
          id: z.string().optional().describe('Object ID (required for add/update/remove)'),
          type: z.enum([
            'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'line', 'group',
            'ambient_light', 'directional_light', 'point_light', 'spot_light',
            'camera', 'text',
          ]).optional().describe('Object type (required for add)'),
          geometry: z.record(z.any()).optional().describe('Geometry params: {width, height, depth} for box, {radius} for sphere, {radiusTop, radiusBottom, height} for cylinder, etc.'),
          material: z.record(z.any()).optional().describe('Material params: {color, opacity, wireframe, metalness, roughness, emissive}'),
          position: z.array(z.number()).optional().describe('[x, y, z] position'),
          rotation: z.array(z.number()).optional().describe('[x, y, z] rotation in radians'),
          scale: z.array(z.number()).optional().describe('[x, y, z] scale'),
          light: z.record(z.any()).optional().describe('Light params: {color, intensity, castShadow, distance, decay, angle, penumbra}'),
          camera: z.record(z.any()).optional().describe('Camera params: {fov, position, lookAt}'),
          text: z.record(z.any()).optional().describe('Text params: {content, fontSize, color, backgroundColor}'),
          code: z.string().optional().describe('JS code for eval op. Available context: THREE, scene, camera, renderer, registry, clock, controls, canvas, onFrame(id, fn(dt,t)), removeFrame(id), frameCallbacks'),
          visible: z.boolean().optional().describe('Whether the object is visible'),
          castShadow: z.boolean().optional().describe('Whether the object casts shadows'),
          receiveShadow: z.boolean().optional().describe('Whether the object receives shadows'),
          parent: z.string().optional().describe('Parent group ID'),
        })).describe('Array of scene operations to execute in order'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ operations, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the 3D Scene mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'scene-update-request',
            requestId,
            operations,
          });
        });
      },
    },

    scene_query: {
      description: 'List objects and inspect scene state. Returns all objects with positions/types, or one object\'s full details if id is provided. Make sure the 3D Scene mod is enabled in deepsteve.',
      schema: {
        id: z.string().optional().describe('Object ID to inspect. If omitted, returns all objects.'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ id, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the 3D Scene mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer });

          send({
            type: 'scene-query-request',
            requestId,
            id: id || null,
          });
        });
      },
    },

    scene_snapshot: {
      description: 'Capture the current 3D scene as a PNG image. Optionally saves to a file. Make sure the 3D Scene mod is enabled in deepsteve.',
      schema: {
        width: z.number().optional().describe('Snapshot width in pixels. Defaults to current canvas width.'),
        height: z.number().optional().describe('Snapshot height in pixels. Defaults to current canvas height.'),
        filename: z.string().optional().describe('Output filename (without extension). If provided, saves PNG to output_dir.'),
        output_dir: z.string().optional().describe('Directory to save the PNG. Defaults to ~/Desktop.'),
        session_id: z.string().optional().describe('DeepSteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value. When provided, the command is sent only to the browser window that owns this session.'),
      },
      handler: async ({ width, height, filename, output_dir, session_id }) => {
        const requestId = randomUUID();
        const { send } = resolveTarget(session_id);

        // Pre-compute output path if filename provided
        let outPath = null;
        if (filename) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const fname = (filename || `scene-${ts}`) + '.png';
          const dir = output_dir || path.join(require('os').homedir(), 'Desktop');
          outPath = path.join(dir, fname);
        }

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            resolve({
              content: [{ type: 'text', text: 'Error: Timed out waiting for browser response. Make sure the 3D Scene mod is enabled in the deepsteve browser tab.' }],
            });
          }, TIMEOUT_MS);

          pendingRequests.set(requestId, { resolve, timer, outPath });

          send({
            type: 'scene-snapshot-request',
            requestId,
            width: width || null,
            height: height || null,
          });
        });
      },
    },
  };
}

/**
 * Register REST routes for receiving scene results.
 */
function registerRoutes(app, context) {
  const express = require('express');

  // Scene update/query results (JSON)
  app.post('/api/threejs-scene/result', express.json({ limit: '50mb' }), (req, res) => {
    const { requestId, result, dataUrl, error } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Missing requestId' });
    }

    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return res.json({ accepted: false });
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (error) {
      pending.resolve({
        content: [{ type: 'text', text: `Error: ${error}` }],
      });
    } else if (dataUrl && pending.outPath) {
      // Snapshot with file save
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        pending.resolve({
          content: [{ type: 'text', text: 'Error: Invalid or missing dataUrl — expected a data:image/png;base64,… string' }],
        });
        return res.status(400).json({ error: 'Invalid dataUrl' });
      }
      try {
        const base64 = dataUrl.slice('data:image/png;base64,'.length);
        const buf = Buffer.from(base64, 'base64');
        if (buf.length === 0) {
          pending.resolve({
            content: [{ type: 'text', text: 'Error: Snapshot data decoded to an empty buffer' }],
          });
          return res.status(400).json({ error: 'Empty image data' });
        }
        fs.mkdirSync(path.dirname(pending.outPath), { recursive: true });
        fs.writeFileSync(pending.outPath, buf);
        pending.resolve({
          content: [{ type: 'text', text: `Scene snapshot saved to ${pending.outPath}` }],
        });
      } catch (e) {
        pending.resolve({
          content: [{ type: 'text', text: `Error saving snapshot: ${e.message}` }],
        });
      }
    } else if (dataUrl) {
      // Snapshot without file save — return base64 info
      pending.resolve({
        content: [{ type: 'text', text: `Scene snapshot captured (${Math.round(dataUrl.length / 1024)}KB base64). Use filename parameter to save to disk.` }],
      });
    } else {
      // Update/query result — return as text
      pending.resolve({
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      });
    }

    res.json({ accepted: true });
  });
}

module.exports = { init, registerRoutes };
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tower/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: linear-gradient(180deg, #0a0a1a 0%, #1a1a2e 40%, #16213e 100%);
      color: #c9d1d9;
      font-family: system-ui;
      height: 100vh;
      overflow: auto;
    }
    #tower-root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="tower-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="tower.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tower/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Tower",
  "version": "0.4.0",
  "minDeepsteveVersion": "0.4.0",
  "description": "Pixel art skyscraper view of your Agent sessions",
  "enabledByDefault": false,
  "entry": "index.html",
  "toolbar": {
    "label": "Tower"
  },
  "settings": [
    {
      "key": "allowMultiFloor",
      "type": "boolean",
      "label": "Allow multi-floor sessions",
      "description": "Allow one session to be assigned to multiple floors at once",
      "default": false
    }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/tower/tower.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useRef, useCallback } = React;

const PIXEL = 3;
const PALETTE = {
  sky: ["#1a1a2e", "#16213e", "#0f3460", "#533483"],
  building: {
    wall: "#4a4a5a",
    wallLight: "#5a5a6a",
    wallDark: "#3a3a4a",
    window: "#0a0a1a",
    windowLit: "#ffd700",
    trim: "#6a6a7a",
    floor: "#353545",
    accent: "#7c4dff",
  },
  computer: {
    body: "#2a2a3a",
    screen: "#0d1117",
    screenGlow: "#00e676",
    keyboard: "#1a1a2a",
  },
  person: ["#f4a460", "#8d6e63", "#ffcc80", "#d4a574"],
  chair: "#3a3a5a",
  stars: "#ffffff",
};

const PROJECT_COLORS = [
  { name: "green", screen: "#00e676", glow: "rgba(0,230,118,0.15)" },
  { name: "blue", screen: "#42a5f5", glow: "rgba(66,165,245,0.15)" },
  { name: "amber", screen: "#ffab00", glow: "rgba(255,171,0,0.15)" },
  { name: "pink", screen: "#f06292", glow: "rgba(240,98,146,0.15)" },
  { name: "cyan", screen: "#26c6da", glow: "rgba(38,198,218,0.15)" },
  { name: "purple", screen: "#b388ff", glow: "rgba(179,136,255,0.15)" },
];

const FLOORS_STORAGE_KEY = "tower-mod-floors";

function loadFloors() {
  try {
    const raw = localStorage.getItem(FLOORS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveFloors(floors) {
  localStorage.setItem(FLOORS_STORAGE_KEY, JSON.stringify(floors));
}

const CWD_MAP_KEY = "tower-mod-session-cwds";

function loadCwdMap() {
  try { return JSON.parse(localStorage.getItem(CWD_MAP_KEY)) || {}; } catch { return {}; }
}
function saveCwdMap(map) {
  localStorage.setItem(CWD_MAP_KEY, JSON.stringify(map));
}

// Replace stale floor session IDs with current sessions that have the same cwd
function reconcileFloors(sessions, floors) {
  const liveIds = new Set(sessions.map(s => s.id));
  const cwdMap = loadCwdMap();

  // Collect all currently-assigned IDs across all floors
  const allAssigned = new Set();
  for (const f of floors) for (const sid of (f.sessionIds || [])) allAssigned.add(sid);

  let changed = false;
  const updated = floors.map(floor => {
    const newIds = (floor.sessionIds || []).map(sid => {
      if (liveIds.has(sid)) return sid; // Still alive
      const cwd = cwdMap[sid];
      if (!cwd) return sid; // No record — keep as-is (will render as dead)
      // Find a session with same cwd that isn't already assigned to any floor
      const match = sessions.find(s => s.cwd === cwd && !allAssigned.has(s.id));
      if (match) {
        changed = true;
        allAssigned.add(match.id); // Prevent double-assigning
        return match.id;
      }
      return sid; // No match found — keep stale ID (will render as dead)
    });
    return { ...floor, sessionIds: newIds };
  });

  return changed ? updated : null;
}

function PixelText({ text, x, y, size = 12, color = "#fff", align = "left" }) {
  return (
    <text
      x={x}
      y={y}
      fill={color}
      fontSize={size}
      fontFamily={'"Press Start 2P", monospace'}
      textAnchor={align === "center" ? "middle" : align === "right" ? "end" : "start"}
      dominantBaseline="middle"
      style={{ imageRendering: "pixelated" }}
    >
      {text}
    </text>
  );
}

function Star({ x, y, twinkle }) {
  const [opacity, setOpacity] = useState(Math.random);
  useEffect(() => {
    if (!twinkle) return;
    const interval = setInterval(() => {
      setOpacity(0.3 + Math.random() * 0.7);
    }, 1000 + Math.random() * 2000);
    return () => clearInterval(interval);
  }, [twinkle]);
  return <rect x={x} y={y} width={PIXEL} height={PIXEL} fill={PALETTE.stars} opacity={opacity} />;
}

function Computer({ x, y, screenColor, sessionName, waiting, onClick }) {
  const [cursorOn, setCursorOn] = useState(true);
  const [codeLines] = useState(() => {
    const lines = [];
    for (let i = 0; i < 4; i++) lines.push(Math.floor(3 + Math.random() * 12));
    return lines;
  });

  useEffect(() => {
    const interval = setInterval(() => setCursorOn((p) => !p), 530);
    return () => clearInterval(interval);
  }, []);

  const p = PIXEL;
  const monW = 24 * p;
  const monH = 18 * p;

  return (
    <g onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      {/* Monitor */}
      <rect x={x} y={y} width={monW} height={monH} rx={p} fill={PALETTE.computer.body} />
      <rect x={x + p} y={y + p} width={monW - 2 * p} height={monH - 4 * p} fill={PALETTE.computer.screen} />

      {/* Screen glow */}
      <rect x={x + p} y={y + p} width={monW - 2 * p} height={monH - 4 * p} fill={screenColor} opacity={0.05} />

      {/* Code lines */}
      {codeLines.map((len, i) => (
        <rect
          key={i}
          x={x + 2.5 * p}
          y={y + 2.5 * p + i * 2.5 * p}
          width={Math.min(len * p, monW - 6 * p)}
          height={1.5 * p}
          fill={screenColor}
          opacity={0.6}
          rx={0.5}
        />
      ))}

      {/* Blinking cursor */}
      {cursorOn && (
        <rect
          x={x + 2.5 * p + (codeLines[3] || 5) * p}
          y={y + 2.5 * p + 3 * 2.5 * p}
          width={1.5 * p}
          height={1.5 * p}
          fill={screenColor}
        />
      )}

      {/* Monitor stand */}
      <rect x={x + monW / 2 - 2 * p} y={y + monH} width={4 * p} height={2 * p} fill={PALETTE.computer.body} />
      <rect x={x + monW / 2 - 4 * p} y={y + monH + 2 * p} width={8 * p} height={p} fill={PALETTE.computer.body} />

      {/* Keyboard */}
      <rect x={x - p} y={y + monH + 3.5 * p} width={monW + 2 * p} height={4 * p} rx={p} fill={PALETTE.computer.keyboard} />
      {[0, 1, 2].map((row) =>
        Array.from({ length: 7 - row }, (_, col) => (
          <rect
            key={`${row}-${col}`}
            x={x + p + col * 3 * p + row * p}
            y={y + monH + 4 * p + row * 1.2 * p}
            width={2 * p}
            height={p * 0.8}
            fill="#2a2a3a"
            rx={0.3}
          />
        ))
      )}

      {/* Waiting indicator (pulsing dot) */}
      {waiting && (
        <circle cx={x + monW - 2 * p} cy={y - 1.5 * p} r={3 * p} fill="#ffab00" opacity={0.9}>
          <animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}

      {/* Session name label */}
      {sessionName && (
        <PixelText
          text={sessionName.length > 10 ? sessionName.slice(0, 9) + "\u2026" : sessionName}
          x={x + monW / 2}
          y={y + monH + 9 * p}
          size={7}
          color="#8a8a9a"
          align="center"
        />
      )}
    </g>
  );
}

function DeadComputer({ x, y, sessionName, onUnassign }) {
  const p = PIXEL;
  const monW = 24 * p;
  const monH = 18 * p;

  return (
    <g style={{ cursor: "pointer" }} onClick={onUnassign}>
      {/* Monitor */}
      <rect x={x} y={y} width={monW} height={monH} rx={p} fill="#2a2a3a" opacity={0.5} />
      <rect x={x + p} y={y + p} width={monW - 2 * p} height={monH - 4 * p} fill="#1a0a0a" />

      {/* Error static lines */}
      {[0, 1, 2, 3].map(i => (
        <rect key={i} x={x + 2.5 * p} y={y + 2.5 * p + i * 2.5 * p}
          width={monW - 5 * p} height={1.5 * p} fill="#ff1744" opacity={0.15} rx={0.5} />
      ))}

      {/* Red X error icon */}
      <line x1={x + monW / 2 - 3 * p} y1={y + monH / 2 - 4 * p}
        x2={x + monW / 2 + 3 * p} y2={y + monH / 2 + 2 * p}
        stroke="#ff1744" strokeWidth={2} opacity={0.8} />
      <line x1={x + monW / 2 + 3 * p} y1={y + monH / 2 - 4 * p}
        x2={x + monW / 2 - 3 * p} y2={y + monH / 2 + 2 * p}
        stroke="#ff1744" strokeWidth={2} opacity={0.8} />

      {/* Monitor stand */}
      <rect x={x + monW / 2 - 2 * p} y={y + monH} width={4 * p} height={2 * p} fill="#2a2a3a" opacity={0.5} />
      <rect x={x + monW / 2 - 4 * p} y={y + monH + 2 * p} width={8 * p} height={p} fill="#2a2a3a" opacity={0.5} />

      {/* Keyboard (dimmed) */}
      <rect x={x - p} y={y + monH + 3.5 * p} width={monW + 2 * p} height={4 * p} rx={p} fill="#1a1a2a" opacity={0.4} />

      {/* Error indicator dot */}
      <circle cx={x + monW - 2 * p} cy={y - 1.5 * p} r={3 * p} fill="#ff1744" opacity={0.8}>
        <animate attributeName="opacity" values="0.8;0.3;0.8" dur="2s" repeatCount="indefinite" />
      </circle>

      {/* Session name label */}
      <PixelText
        text={sessionName.length > 10 ? sessionName.slice(0, 9) + "\u2026" : sessionName}
        x={x + monW / 2}
        y={y + monH + 9 * p}
        size={7}
        color="#ff1744"
        align="center"
      />
    </g>
  );
}

function Person({ x, y, colorIdx = 0, facing = "right" }) {
  const p = PIXEL;
  const skinColor = PALETTE.person[colorIdx % PALETTE.person.length];
  const shirtColors = ["#4fc3f7", "#7c4dff", "#66bb6a", "#f06292", "#ffab00", "#26c6da"];
  const shirt = shirtColors[colorIdx % shirtColors.length];
  const cx = facing === "right" ? x : x + 6 * p;

  return (
    <g transform={facing === "left" ? `translate(${2 * cx}, 0) scale(-1, 1)` : undefined}>
      {/* Chair */}
      <rect x={x - 2 * p} y={y + 2 * p} width={10 * p} height={8 * p} rx={p} fill={PALETTE.chair} />
      <rect x={x - 3 * p} y={y + 2 * p} width={2 * p} height={12 * p} fill={PALETTE.chair} rx={0.5} />

      {/* Body */}
      <rect x={x} y={y + 2 * p} width={6 * p} height={6 * p} fill={shirt} rx={p} />

      {/* Arms */}
      <rect x={x + 5 * p} y={y + 3 * p} width={4 * p} height={2 * p} fill={shirt} rx={p} />
      <rect x={x + 8 * p} y={y + 3 * p} width={2 * p} height={2 * p} fill={skinColor} rx={p} />

      {/* Head */}
      <rect x={x + p} y={y - 4 * p} width={5 * p} height={6 * p} rx={p} fill={skinColor} />
      {/* Hair */}
      <rect x={x + 0.5 * p} y={y - 5 * p} width={6 * p} height={3 * p} rx={p} fill="#2a2a3a" />
      {/* Eye */}
      <rect x={x + 4 * p} y={y - 2 * p} width={p} height={p} fill="#1a1a2a" />
    </g>
  );
}

function Floor({ floorData, sessions: floorSessions, y, width, isSelected, onClick, floorNum, onUnassignSession }) {
  const p = PIXEL;
  const floorH = 42 * p;
  const wallInset = 12 * p;
  const colorScheme = PROJECT_COLORS[floorData.color % PROJECT_COLORS.length];
  const count = Math.min(floorSessions.length, 4);
  const computerSpacing = count > 0 ? (width - 2 * wallInset - 24 * p) / Math.max(count, 1) : 0;

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      {/* Floor slab */}
      <rect x={wallInset - 2 * p} y={y + floorH - 2 * p} width={width - 2 * wallInset + 4 * p} height={3 * p} fill={PALETTE.building.trim} />

      {/* Walls */}
      <rect x={wallInset} y={y} width={width - 2 * wallInset} height={floorH - 2 * p} fill={PALETTE.building.wall} />

      {/* Wall texture */}
      {[0.25, 0.5, 0.75].map((frac) => (
        <line key={frac} x1={wallInset} y1={y + floorH * frac} x2={width - wallInset} y2={y + floorH * frac}
          stroke={PALETTE.building.wallDark} strokeWidth={0.5} opacity={0.3} />
      ))}

      {/* Selection highlight */}
      {isSelected && (
        <rect x={wallInset} y={y} width={width - 2 * wallInset} height={floorH - 2 * p}
          fill={colorScheme.glow} stroke={colorScheme.screen} strokeWidth={1.5} />
      )}

      {/* Ceiling light */}
      <rect x={wallInset + 10 * p} y={y + 2 * p} width={width - 2 * wallInset - 20 * p} height={p} fill="#8a8a9a" opacity={0.5} />

      {/* Floor label */}
      <rect x={wallInset + 2 * p} y={y + 3 * p} width={Math.max(floorData.name.length * 5.5 + 14, 60)} height={9 * p} rx={p} fill="rgba(0,0,0,0.5)" />
      <PixelText text={`F${floorNum}`} x={wallInset + 4 * p} y={y + 8 * p} size={8} color={colorScheme.screen} />
      <PixelText text={floorData.name} x={wallInset + 16 * p} y={y + 8 * p} size={8} color="#ccc" />

      {/* Computers and people */}
      {floorSessions.slice(0, 4).map((session, i) => {
        const cx = wallInset + 16 * p + i * computerSpacing;
        const cy = y + 14 * p;
        if (session.dead) {
          return (
            <g key={session.id}>
              <DeadComputer
                x={cx} y={cy}
                sessionName={session.name}
                onUnassign={(e) => {
                  e.stopPropagation();
                  if (onUnassignSession) onUnassignSession(session.id);
                }}
              />
            </g>
          );
        }
        return (
          <g key={session.id}>
            <Computer
              x={cx} y={cy}
              screenColor={colorScheme.screen}
              sessionName={session.name}
              waiting={session.waitingForInput}
              onClick={(e) => {
                e.stopPropagation();
                if (window.deepsteve) window.deepsteve.focusSession(session.id);
              }}
            />
            <Person x={cx - 8 * p} y={cy + 6 * p} colorIdx={i + floorData.color} facing="right" />
          </g>
        );
      })}

      {/* Window decorations */}
      {Array.from({ length: 2 }, (_, i) => (
        <g key={`win-${i}`}>
          <rect x={width - wallInset - 12 * p} y={y + 6 * p + i * 14 * p}
            width={8 * p} height={10 * p} fill={PALETTE.building.window} rx={p} />
          <rect x={width - wallInset - 11 * p} y={y + 7 * p + i * 14 * p}
            width={6 * p} height={8 * p} fill={i === 0 ? "#1a1a3e" : "#0f1a3e"} opacity={0.8} />
          <rect x={width - wallInset - 9 * p} y={y + 9 * p + i * 14 * p}
            width={p * 0.8} height={p * 0.8} fill="#fff" opacity={0.4} />
        </g>
      ))}
    </g>
  );
}

function Roof({ y, width }) {
  const p = PIXEL;
  const wallInset = 12 * p;
  const bw = width - 2 * wallInset;

  return (
    <g>
      <rect x={wallInset - 4 * p} y={y} width={bw + 8 * p} height={4 * p} fill={PALETTE.building.trim} />
      <rect x={wallInset + 10 * p} y={y - 16 * p} width={bw - 20 * p} height={16 * p} fill={PALETTE.building.wallDark} />
      <rect x={wallInset + 8 * p} y={y - 18 * p} width={bw - 16 * p} height={4 * p} fill={PALETTE.building.trim} />

      {/* Antenna */}
      <rect x={width / 2 - p} y={y - 40 * p} width={2 * p} height={22 * p} fill={PALETTE.building.trim} />
      <rect x={width / 2 - 4 * p} y={y - 42 * p} width={8 * p} height={3 * p} fill={PALETTE.building.trim} rx={p} />
      <circle cx={width / 2} cy={y - 44 * p} r={2 * p} fill="#ff1744" opacity={0.9}>
        <animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.5s" repeatCount="indefinite" />
      </circle>

      {/* Sign */}
      <rect x={wallInset + 14 * p} y={y - 14 * p} width={bw - 28 * p} height={10 * p} rx={p} fill="rgba(0,0,0,0.7)" />
      <PixelText text="DEEP STEVE TOWER" x={width / 2} y={y - 8.5 * p} size={10} color="#b388ff" align="center" />
    </g>
  );
}

function Lobby({ y, width, sessions: lobbySessions }) {
  const p = PIXEL;
  const wallInset = 12 * p;
  const count = lobbySessions.length;
  const lobbyH = 36 * p + (count > 0 ? 30 * p : 0);
  const computerSpacing = count > 0 ? (width - 2 * wallInset - 24 * p) / Math.max(count, 1) : 0;

  return (
    <g>
      {/* Lobby walls */}
      <rect x={wallInset} y={y} width={width - 2 * wallInset} height={lobbyH} fill="#3a3a4f" />

      {/* Glass doors */}
      <rect x={width / 2 - 14 * p} y={y + 4 * p} width={28 * p} height={28 * p} fill="#1a2a4a" rx={p} opacity={0.7} />
      <rect x={width / 2 - 12 * p} y={y + 6 * p} width={11 * p} height={24 * p} fill="#0f1f3f" rx={p} />
      <rect x={width / 2 + p} y={y + 6 * p} width={11 * p} height={24 * p} fill="#0f1f3f" rx={p} />
      <rect x={width / 2 - 2 * p} y={y + 14 * p} width={p} height={8 * p} fill="#8a8a9a" rx={0.5} />
      <rect x={width / 2 + p} y={y + 14 * p} width={p} height={8 * p} fill="#8a8a9a" rx={0.5} />

      {/* Lobby label */}
      <PixelText text={"\u25C6 LOBBY \u25C6"} x={width / 2} y={y + lobbyH - 6 * p - (count > 0 ? 30 * p : 0)} size={8} color="#8a8a9a" align="center" />

      {/* Unassigned sessions in lobby */}
      {lobbySessions.slice(0, 4).map((session, i) => {
        const cx = wallInset + 16 * p + i * computerSpacing;
        const cy = y + lobbyH - 28 * p;
        return (
          <g key={session.id}>
            <Computer
              x={cx} y={cy}
              screenColor="#00e676"
              sessionName={session.name}
              waiting={session.waitingForInput}
              onClick={(e) => {
                e.stopPropagation();
                if (window.deepsteve) window.deepsteve.focusSession(session.id);
              }}
            />
            <Person x={cx - 8 * p} y={cy + 6 * p} colorIdx={i} facing="right" />
          </g>
        );
      })}

      {/* Foundation */}
      <rect x={wallInset - 6 * p} y={y + lobbyH} width={width - 2 * wallInset + 12 * p} height={5 * p} fill={PALETTE.building.wallDark} />
    </g>
  );
}

function TowerApp() {
  const [sessions, setSessions] = useState([]);
  const [floors, setFloors] = useState(loadFloors);
  const [selectedFloor, setSelectedFloor] = useState(null);
  const [newName, setNewName] = useState("");
  const [modSettings, setModSettings] = useState({});
  const [editMode, setEditMode] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [nextId, setNextId] = useState(() => {
    const saved = loadFloors();
    return saved.length > 0 ? Math.max(...saved.map(f => f.id)) + 1 : 1;
  });

  // Connect to deepsteve bridge
  useEffect(() => {
    let unsubSessions = null;
    let unsubSettings = null;
    let attempts = 0;
    const poll = setInterval(() => {
      if (window.deepsteve) {
        clearInterval(poll);
        unsubSessions = window.deepsteve.onSessionsChanged((list) => {
          setSessions(list);

          // Update cwd map with current session data
          const cwdMap = loadCwdMap();
          const liveIds = new Set(list.map(s => s.id));
          for (const s of list) {
            if (s.cwd) cwdMap[s.id] = s.cwd;
          }
          // Prune entries for sessions no longer live and no longer in any floor assignment
          setFloors(currentFloors => {
            const allFloorIds = new Set();
            for (const f of currentFloors) for (const sid of (f.sessionIds || [])) allFloorIds.add(sid);
            for (const id of Object.keys(cwdMap)) {
              if (!liveIds.has(id) && !allFloorIds.has(id)) delete cwdMap[id];
            }
            saveCwdMap(cwdMap);

            // Run reconciliation — remap stale IDs by matching cwd
            const reconciled = reconcileFloors(list, currentFloors);
            return reconciled || currentFloors;
          });
        });
        if (window.deepsteve.onSettingsChanged) {
          unsubSettings = window.deepsteve.onSettingsChanged((settings) => {
            setModSettings(settings);
          });
        }
      } else if (++attempts > 100) {
        clearInterval(poll);
      }
    }, 100);
    return () => {
      clearInterval(poll);
      if (unsubSessions) unsubSessions();
      if (unsubSettings) unsubSettings();
    };
  }, []);

  // Persist floors
  useEffect(() => {
    saveFloors(floors);
  }, [floors]);

  // Compute which sessions are assigned to floors and which are in the lobby
  const assignedIds = new Set();
  for (const f of floors) {
    for (const sid of (f.sessionIds || [])) assignedIds.add(sid);
  }
  const lobbySessions = sessions.filter(s => !assignedIds.has(s.id));

  const getFloorSessions = useCallback((floor) => {
    const ids = floor.sessionIds || [];
    const cwdMap = loadCwdMap();
    return ids.map(id => {
      const live = sessions.find(s => s.id === id);
      if (live) return live;
      // Dead session — return a marker object
      const cwd = cwdMap[id];
      const name = cwd ? cwd.split("/").pop() : "Lost session";
      return { id, name, dead: true, cwd };
    });
  }, [sessions]);

  const p = PIXEL;
  const svgWidth = 520;
  const floorH = 42 * p;
  const roofExtra = 50 * p;
  const lobbySessionCount = lobbySessions.length;
  const lobbyH = 41 * p + (lobbySessionCount > 0 ? 30 * p : 0);
  const svgHeight = roofExtra + floors.length * floorH + lobbyH + 20 * p;

  const stars = useRef(
    Array.from({ length: 40 }, () => ({
      x: Math.random() * svgWidth,
      y: Math.random() * 200,
    }))
  );

  const addFloor = () => {
    if (!newName.trim()) return;
    const f = { id: nextId, name: newName.trim(), sessionIds: [], color: (nextId - 1) % PROJECT_COLORS.length };
    setFloors((prev) => [...prev, f]);
    setNextId((n) => n + 1);
    setNewName("");
  };

  const removeFloor = (id) => {
    setFloors((prev) => prev.filter((f) => f.id !== id));
    if (selectedFloor === id) setSelectedFloor(null);
  };

  const assignSession = (floorId, sessionId) => {
    setFloors(prev => prev.map(f => {
      // When multi-floor is off, remove from other floors first
      const ids = modSettings.allowMultiFloor
        ? [...(f.sessionIds || [])]
        : (f.sessionIds || []).filter(id => id !== sessionId);
      if (f.id === floorId && !ids.includes(sessionId)) ids.push(sessionId);
      return { ...f, sessionIds: ids };
    }));
  };

  const unassignSession = (floorId, sessionId) => {
    setFloors(prev => prev.map(f =>
      f.id === floorId ? { ...f, sessionIds: (f.sessionIds || []).filter(id => id !== sessionId) } : f
    ));
  };

  const cycleColor = (id) => {
    setFloors((prev) =>
      prev.map((f) => (f.id === id ? { ...f, color: (f.color + 1) % PROJECT_COLORS.length } : f))
    );
  };

  const moveFloor = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    setFloors(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const handleDragStart = (idx) => (e) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (idx) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };
  const handleDrop = (idx) => (e) => {
    e.preventDefault();
    if (dragIdx != null) moveFloor(dragIdx, idx);
    setDragIdx(null);
    setDragOverIdx(null);
  };
  const handleDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const selectedData = floors.find((f) => f.id === selectedFloor);

  // Sessions available to assign to the selected floor
  const selectedFloorSessionIds = new Set((selectedData?.sessionIds || []));
  const unassignedForSelected = modSettings.allowMultiFloor
    ? sessions.filter(s => !selectedFloorSessionIds.has(s.id))
    : sessions.filter(s => !selectedFloorSessionIds.has(s.id) && !assignedIds.has(s.id));

  return (
    <div style={{
      height: "100vh",
      fontFamily: '"Press Start 2P", monospace',
      color: "#e0e0e0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "20px 12px",
      overflow: "auto",
    }}>
      <h1 style={{
        fontSize: 20, color: "#b388ff",
        textShadow: "0 0 20px rgba(179,136,255,0.5)",
        letterSpacing: 2, marginBottom: 8, textAlign: "center", flexShrink: 0,
      }}>
        DEEP STEVE TOWER
      </h1>
      <p style={{ fontSize: 11, color: "#6a6a8a", marginBottom: 20, textAlign: "center", flexShrink: 0 }}>
        Each floor is a project. Each computer is a session. Click a computer to open it.
      </p>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center", width: "100%", maxWidth: 960, flex: "1 0 auto", minHeight: 0 }}>
        {/* SVG Building */}
        <div style={{
          flex: "1 1 520px", maxWidth: 540,
          overflow: "auto", border: "2px solid #2a2a4a", borderRadius: 8,
          background: "rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", alignItems: "center",
        }}>
          <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            style={{ imageRendering: "pixelated", display: "block" }}>
            <defs>
              <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0a0a1a" />
                <stop offset="60%" stopColor="#1a1a2e" />
                <stop offset="100%" stopColor="#16213e" />
              </linearGradient>
            </defs>
            <rect width={svgWidth} height={svgHeight} fill="url(#skyGrad)" />

            {stars.current.map((s, i) => (
              <Star key={i} x={s.x} y={s.y} twinkle />
            ))}

            <Roof y={roofExtra} width={svgWidth} />

            {[...floors].reverse().map((floor, idx) => (
              <Floor
                key={floor.id}
                floorData={floor}
                sessions={getFloorSessions(floor)}
                y={roofExtra + 4 * p + idx * floorH}
                width={svgWidth}
                isSelected={selectedFloor === floor.id}
                onClick={() => setSelectedFloor(selectedFloor === floor.id ? null : floor.id)}
                floorNum={floors.length - idx}
                onUnassignSession={(sessionId) => unassignSession(floor.id, sessionId)}
              />
            ))}

            <Lobby y={roofExtra + 4 * p + floors.length * floorH} width={svgWidth} sessions={lobbySessions} />
          </svg>
        </div>

        {/* Control Panel */}
        <div style={{ flex: "1 1 300px", maxWidth: 380, display: "flex", flexDirection: "column", gap: 12, overflow: "auto" }}>
          {/* Add Floor */}
          <div style={{ background: "rgba(30,30,50,0.8)", border: "2px solid #2a2a4a", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: "#b388ff", marginBottom: 10 }}>+ ADD PROJECT FLOOR</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addFloor()}
                placeholder="Project name..." maxLength={16}
                style={{
                  flex: 1, background: "#0a0a1a", border: "1px solid #3a3a5a", borderRadius: 4,
                  color: "#e0e0e0", fontFamily: '"Press Start 2P", monospace', fontSize: 11,
                  padding: "8px 10px", outline: "none",
                }}
              />
              <button onClick={addFloor} style={{
                background: "#7c4dff", border: "none", borderRadius: 4, color: "#fff",
                fontFamily: '"Press Start 2P", monospace', fontSize: 11, padding: "8px 12px", cursor: "pointer",
              }}>
                BUILD
              </button>
            </div>
          </div>

          {/* Floor List */}
          <div style={{ background: "rgba(30,30,50,0.8)", border: "2px solid #2a2a4a", borderRadius: 8, padding: 14, maxHeight: 300, overflow: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "#8a8a9a" }}>FLOORS ({floors.length})</div>
              {floors.length > 1 && (
                <button onClick={() => { setEditMode(m => !m); setDragIdx(null); setDragOverIdx(null); }} style={{
                  background: editMode ? "rgba(124,77,255,0.3)" : "transparent",
                  border: `1px solid ${editMode ? "#b388ff" : "#3a3a5a"}`,
                  borderRadius: 3, color: editMode ? "#b388ff" : "#6a6a8a",
                  fontFamily: '"Press Start 2P", monospace', fontSize: 9, padding: "4px 8px", cursor: "pointer",
                }}>
                  {editMode ? "DONE" : "EDIT"}
                </button>
              )}
            </div>
            {floors.length === 0 && (
              <div style={{ fontSize: 11, color: "#4a4a6a", textAlign: "center", padding: 20 }}>
                No floors yet. Add a project above!
              </div>
            )}
            {[...floors].reverse().map((f, revIdx) => {
              const realIdx = floors.length - 1 - revIdx;
              const col = PROJECT_COLORS[f.color % PROJECT_COLORS.length];
              const isSelected = selectedFloor === f.id;
              const floorSessionCount = getFloorSessions(f).length;
              const isDragging = dragIdx === realIdx;
              const isDragOver = dragOverIdx === realIdx && dragIdx !== realIdx;
              return (
                <div key={f.id}
                  draggable={editMode}
                  onDragStart={editMode ? handleDragStart(realIdx) : undefined}
                  onDragOver={editMode ? handleDragOver(realIdx) : undefined}
                  onDrop={editMode ? handleDrop(realIdx) : undefined}
                  onDragEnd={editMode ? handleDragEnd : undefined}
                  onClick={editMode ? undefined : () => setSelectedFloor(isSelected ? null : f.id)}
                  style={{
                    background: isDragOver ? "rgba(124,77,255,0.25)" : isSelected && !editMode ? "rgba(124,77,255,0.15)" : "rgba(0,0,0,0.3)",
                    border: `1px solid ${isDragOver ? "#b388ff" : isSelected && !editMode ? col.screen : "#2a2a4a"}`,
                    borderRadius: 6, padding: "8px 10px", marginBottom: 6,
                    cursor: editMode ? "grab" : "pointer",
                    opacity: isDragging ? 0.4 : 1,
                    transition: "background 0.15s, border-color 0.15s, opacity 0.15s",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {editMode && (
                        <span style={{ fontSize: 10, color: "#6a6a8a", cursor: "grab", userSelect: "none" }}>{"\u2630"}</span>
                      )}
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: col.screen, boxShadow: `0 0 6px ${col.screen}` }} />
                      <span style={{ fontSize: 11, color: "#e0e0e0" }}>{f.name}</span>
                    </div>
                    <span style={{ fontSize: 10, color: "#6a6a8a" }}>F{floors.length - revIdx}</span>
                  </div>
                  {!editMode && (
                    <div style={{ fontSize: 10, color: "#6a6a8a", marginTop: 4 }}>
                      {floorSessionCount} session{floorSessionCount !== 1 ? "s" : ""} assigned
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Selected Floor Controls */}
          {selectedData && (
            <div style={{
              background: "rgba(30,30,50,0.8)",
              border: `2px solid ${PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen}`,
              borderRadius: 8, padding: 14,
            }}>
              <div style={{ fontSize: 12, color: PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen, marginBottom: 10 }}>
                {"\u25B8"} {selectedData.name}
              </div>

              {/* Assigned sessions */}
              <div style={{ fontSize: 10, color: "#8a8a9a", marginBottom: 6 }}>ASSIGNED SESSIONS</div>
              {getFloorSessions(selectedData).length === 0 && (
                <div style={{ fontSize: 10, color: "#4a4a6a", marginBottom: 8, padding: "4px 0" }}>None yet</div>
              )}
              {getFloorSessions(selectedData).map(s => (
                <div key={s.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  background: s.dead ? "rgba(255,23,68,0.1)" : "rgba(0,0,0,0.3)",
                  border: s.dead ? "1px solid rgba(255,23,68,0.3)" : "1px solid transparent",
                  borderRadius: 4, padding: "6px 8px", marginBottom: 4, fontSize: 10,
                }}>
                  <span style={{ color: s.dead ? "#ff1744" : "#e0e0e0" }}>
                    {s.dead ? "\u26A0 " : ""}{s.name}
                  </span>
                  <button onClick={() => unassignSession(selectedData.id, s.id)} style={{
                    background: "transparent", border: "none", color: "#f85149", cursor: "pointer",
                    fontFamily: '"Press Start 2P", monospace', fontSize: 10,
                  }}>-</button>
                </div>
              ))}

              {/* Unassigned sessions to add */}
              {unassignedForSelected.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 10, color: "#8a8a9a", marginBottom: 6 }}>ADD SESSION</div>
                  {unassignedForSelected.map(s => (
                    <div key={s.id} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: "rgba(0,0,0,0.2)", borderRadius: 4, padding: "6px 8px", marginBottom: 4, fontSize: 10,
                    }}>
                      <span style={{ color: "#8a8a9a" }}>{s.name}</span>
                      <button onClick={() => assignSession(selectedData.id, s.id)} style={{
                        background: "transparent", border: "none", color: "#00e676", cursor: "pointer",
                        fontFamily: '"Press Start 2P", monospace', fontSize: 10,
                      }}>+</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Color cycle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0" }}>
                <span style={{ fontSize: 11, color: "#8a8a9a" }}>Theme</span>
                <button onClick={() => cycleColor(selectedData.id)} style={{
                  background: "transparent", border: `1px solid ${PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen}`,
                  borderRadius: 3, color: PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].screen,
                  fontFamily: '"Press Start 2P", monospace', fontSize: 10, padding: "6px 10px", cursor: "pointer",
                }}>
                  {PROJECT_COLORS[selectedData.color % PROJECT_COLORS.length].name.toUpperCase()}
                </button>
              </div>

              {/* Delete */}
              <button onClick={() => removeFloor(selectedData.id)} style={{
                width: "100%", background: "rgba(255,23,68,0.15)", border: "1px solid #ff1744",
                borderRadius: 4, color: "#ff1744", fontFamily: '"Press Start 2P", monospace',
                fontSize: 10, padding: "8px", cursor: "pointer",
              }}>
                DEMOLISH FLOOR
              </button>
            </div>
          )}

          {/* Stats */}
          <div style={{ background: "rgba(30,30,50,0.8)", border: "2px solid #2a2a4a", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: "#8a8a9a", marginBottom: 8 }}>TOWER STATS</div>
            <div style={{ fontSize: 11, color: "#6a6a8a", lineHeight: 2.2 }}>
              <div>Floors: <span style={{ color: "#b388ff" }}>{floors.length}</span></div>
              <div>Total Sessions: <span style={{ color: "#00e676" }}>{sessions.length}</span></div>
              <div>In Lobby: <span style={{ color: "#ffab00" }}>{lobbySessions.length}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("tower-root")).render(<TowerApp />);
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/window-map/index.html" << 'DEEPSTEVE_FILE_EOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      background: #0d0d0d;
      color: #c9d1d9;
      font-family: system-ui, -apple-system, sans-serif;
      height: 100vh;
      overflow: auto;
    }
    #map-root { min-height: 100vh; padding: 16px; }
  </style>
</head>
<body>
  <div id="map-root"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" data-type="module" src="window-map.jsx"></script>
</body>
</html>
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/window-map/mod.json" << 'DEEPSTEVE_FILE_EOF'
{
  "name": "Window Map",
  "version": "0.5.0",
  "minDeepsteveVersion": "0.5.0",
  "description": "Interactive card grid view of window configs and live sessions",
  "enabledByDefault": true,
  "entry": "index.html",
  "toolbar": {
    "label": "Map"
  },
  "tools": [
    { "name": "apply_window_config", "description": "Launch all tabs from a saved window config" }
  ]
}
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/window-map/tools.js" << 'DEEPSTEVE_FILE_EOF'
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
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/mods/window-map/window-map.jsx" << 'DEEPSTEVE_FILE_EOF'
const { useState, useEffect, useCallback } = React;

const styles = {
  container: {
    padding: '8px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '16px',
  },
  title: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#c9d1d9',
  },
  configSection: {
    marginBottom: '24px',
  },
  configName: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#8b949e',
    marginBottom: '8px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '8px',
  },
  card: {
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid #30363d',
    background: '#161b22',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    position: 'relative',
  },
  cardRunning: {
    borderColor: '#238636',
    boxShadow: '0 0 8px rgba(35,134,54,0.3)',
  },
  cardWaiting: {
    borderColor: '#d29922',
    animation: 'pulse-yellow 2s infinite',
  },
  cardIdle: {
    opacity: 0.5,
    borderColor: '#30363d',
  },
  cardName: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#c9d1d9',
    marginBottom: '4px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardCwd: {
    fontSize: '11px',
    color: '#8b949e',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    position: 'absolute',
    top: '8px',
    right: '8px',
  },
  emptyMsg: {
    fontSize: '13px',
    color: '#8b949e',
    textAlign: 'center',
    padding: '32px 16px',
    opacity: 0.6,
  },
  unmatched: {
    marginTop: '24px',
  },
};

function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/';
  const idx = p.indexOf(home);
  if (idx === 0) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) return '~' + rest.slice(slash);
    return '~';
  }
  return p;
}

function WindowMap() {
  const [configs, setConfigs] = useState([]);
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    // Fetch configs
    fetch('/api/window-configs')
      .then(r => r.json())
      .then(d => setConfigs(d.configs || []))
      .catch(() => {});

    // Subscribe to live sessions
    let unsub;
    if (window.deepsteve?.onSessionsChanged) {
      unsub = window.deepsteve.onSessionsChanged((list) => {
        setSessions(list);
      });
    }

    // Listen for config updates from parent window
    const onConfigUpdate = (e) => setConfigs(e.detail || []);
    window.parent.addEventListener('deepsteve-window-configs', onConfigUpdate);

    return () => {
      if (unsub) unsub();
      window.parent.removeEventListener('deepsteve-window-configs', onConfigUpdate);
    };
  }, []);

  const handleCardClick = useCallback((session, tab, configId) => {
    if (session) {
      // Focus existing session
      if (window.deepsteve?.focusSession) {
        window.deepsteve.focusSession(session.id);
      }
    } else if (tab && configId) {
      // Launch single tab from config
      fetch(`/api/window-configs/${configId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: window.deepsteve?.getWindowId?.() }),
      }).catch(() => {});
    }
  }, []);

  // Match sessions to config tabs
  const matchedSessionIds = new Set();

  const configSections = configs.map(config => {
    const cards = config.tabs.map((tab, ti) => {
      // Find matching live session by cwd + name
      const match = sessions.find(s =>
        !matchedSessionIds.has(s.id) &&
        s.cwd === tab.cwd &&
        (!tab.name || s.name === tab.name)
      );
      if (match) matchedSessionIds.add(match.id);
      return { tab, session: match, key: `${config.id}-${ti}` };
    });
    return { config, cards };
  });

  const unmatchedSessions = sessions.filter(s => !matchedSessionIds.has(s.id));

  if (configs.length === 0 && sessions.length === 0) {
    return React.createElement('div', { style: styles.emptyMsg },
      'No window configs or active sessions. Create a config in Settings to get started.'
    );
  }

  return React.createElement('div', { style: styles.container },
    // Config sections
    ...configSections.map(({ config, cards }) =>
      React.createElement('div', { key: config.id, style: styles.configSection },
        React.createElement('div', { style: styles.configName }, config.name),
        React.createElement('div', { style: styles.grid },
          ...cards.map(({ tab, session, key }) => {
            const isRunning = !!session;
            const isWaiting = session?.waitingForInput;
            const cardStyle = {
              ...styles.card,
              ...(isWaiting ? styles.cardWaiting : isRunning ? styles.cardRunning : styles.cardIdle),
            };
            const dotColor = isWaiting ? '#d29922' : isRunning ? '#238636' : '#484f58';
            return React.createElement('div', {
              key,
              style: cardStyle,
              onClick: () => handleCardClick(session, tab, config.id),
              title: isRunning ? 'Click to focus' : 'Click to launch all tabs in this config',
            },
              React.createElement('div', { style: { ...styles.statusDot, background: dotColor } }),
              React.createElement('div', { style: styles.cardName }, tab.name || session?.name || 'Unnamed'),
              React.createElement('div', { style: styles.cardCwd }, shortenPath(tab.cwd)),
            );
          })
        )
      )
    ),
    // Unmatched live sessions
    unmatchedSessions.length > 0 && React.createElement('div', { style: styles.unmatched },
      React.createElement('div', { style: styles.configName }, 'Other Sessions'),
      React.createElement('div', { style: styles.grid },
        ...unmatchedSessions.map(session => {
          const isWaiting = session.waitingForInput;
          const cardStyle = {
            ...styles.card,
            ...(isWaiting ? styles.cardWaiting : styles.cardRunning),
          };
          const dotColor = isWaiting ? '#d29922' : '#238636';
          return React.createElement('div', {
            key: session.id,
            style: cardStyle,
            onClick: () => handleCardClick(session),
            title: 'Click to focus',
          },
            React.createElement('div', { style: { ...styles.statusDot, background: dotColor } }),
            React.createElement('div', { style: styles.cardName }, session.name || 'Unnamed'),
            React.createElement('div', { style: styles.cardCwd }, shortenPath(session.cwd)),
          );
        })
      )
    )
  );
}

// Add pulse animation
const styleEl = document.createElement('style');
styleEl.textContent = `
  @keyframes pulse-yellow {
    0%, 100% { box-shadow: 0 0 4px rgba(210,153,34,0.3); }
    50% { box-shadow: 0 0 12px rgba(210,153,34,0.6); }
  }
`;
document.head.appendChild(styleEl);

const root = ReactDOM.createRoot(document.getElementById('map-root'));
root.render(React.createElement(WindowMap));
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/skills/autoresearch.md" << 'DEEPSTEVE_FILE_EOF'
---
name: autoresearch
description: Start an autonomous research loop for optimization/algorithm design problems
argument-hint: <research problem description>
---

The user wants to start an autonomous research loop. Their description: $ARGUMENTS

Steps:

1. **Analyze the research problem.** From the user's description, identify:
   - The core optimization or algorithm design problem
   - What the "editable file" should be (the thing being iterated on — e.g., a compression algorithm, a prompt template, a scoring function)
   - What the "evaluate harness" should be (how to measure quality — e.g., compression ratio, accuracy, latency)
   - What metrics to track in results.tsv

2. **Draft the GitHub issue.** Create a concise issue body with:
   - Summary (1-2 sentences)
   - Objectives (specific, measurable goals)
   - Constraints (anything the user mentioned)
   - Success Criteria (target metrics, baselines to beat)

   Keep it short — the research protocol details go in a file, not the issue.

3. **Create the issue.** Run `gh issue create --title "<concise research objective>" --body "<the body above>" --label "autoresearch"`. If the `autoresearch` label doesn't exist, omit the `--label` flag and create without it. Extract the issue number from the returned URL.

4. **Start the research session.** Call the `mcp__deepsteve__start_issue` MCP tool with:
   - `session_id`: your `DEEPSTEVE_SESSION_ID` (read it via `echo $DEEPSTEVE_SESSION_ID`)
   - `number`: the issue number
   - `title`: the issue title
   - `body`: the issue body, PLUS the full research protocol below appended to the end

   The `body` field is what gets delivered as the initial prompt. Include the issue body you drafted, then append the following research protocol instructions. The agent's first action will be to write this protocol to `CLAUDE.md` in the worktree so it persists across context clears.

   Append this to the body:

   ---

   ## FIRST ACTION — Write Research Protocol to CLAUDE.md

   Before doing anything else, write a `CLAUDE.md` file in the repo root containing the full research protocol below, customized for this specific problem. This file persists across context clears and ensures you never lose your instructions.

   Write this to `CLAUDE.md`:

   ```
   # Autoresearch Protocol

   ## Problem
   [1-2 sentence summary of the research problem from the issue]

   ## Three-File Structure

   ### 1. `program.md` — Research Program
   The research plan. Document your current hypothesis, what you're trying next, and why. Update this before each iteration. Read this file at the start of every iteration to re-orient.

   ### 2. `[evaluate harness file]` — Evaluation Harness
   [Describe what the harness does, adapted to this domain]
   - Must be runnable as a single command (e.g., `python evaluate.py`, `node evaluate.js`)
   - Must print a single-line TSV row to stdout with metrics
   - Must exit 0 on success, non-zero on failure

   ### 3. `[editable file]` — The Thing Being Optimized
   [Describe what this file contains, adapted to this domain]

   ### 4. `results.tsv` — Results Log
   TSV file tracking all experiments. Header: `iteration\ttimestamp\t[metric columns]\tnotes`
   Append one row per iteration. Never delete rows.

   ## Research Loop

   **NEVER STOP. NEVER ask "should I continue?" — keep iterating until interrupted.**

   Each iteration:
   1. Read `program.md` for current state and next hypothesis
   2. Update `program.md` with what you're about to try and why
   3. Modify the editable file to test your hypothesis
   4. Run the evaluate harness
   5. Append results to `results.tsv`
   6. Analyze: did it improve? Update `program.md` with findings
   7. Commit with a message summarizing the iteration and result
   8. If improvement: build on it. If regression: revert the editable file, try different approach
   9. Every 5-10 iterations, write/update `findings.md` with key discoveries
   10. Go to step 1

   ## Rules
   - Each iteration must produce a commit and a results.tsv row
   - Never skip the evaluation step — no untested changes
   - If the harness fails, fix it before continuing
   - Keep iterations small and focused — one hypothesis per iteration
   - `findings.md` is your cumulative knowledge document — update it regularly

   ## Success Criteria
   [Fill in from issue]
   ```

   Customize the template: name the harness and editable files appropriately for the domain (e.g., `evaluate.py` + `compress.py`), fill in domain-specific metrics, and adapt descriptions.

   After writing `CLAUDE.md`, create the initial three-file structure, then begin the research loop.

   ---

   Do NOT ask the user for confirmation before starting — the whole point of autoresearch is autonomous operation.

5. **Report back.** Tell the user: the issue URL, that the research session has been started, and that the agent will iterate autonomously until interrupted.
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/skills/chat.md" << 'DEEPSTEVE_FILE_EOF'
---
name: chat
description: Join and monitor an MCP chat channel
argument-hint: [#channel] [context]
---

Join a chat channel, read messages, and respond as needed.

## Parse arguments

Parse `$ARGUMENTS` for these components (all optional, any order):
- **Channel**: a word starting with `#` (strip the `#`). Default: `general`
- **Context**: any remaining text after extracting the channel — this is your task description for how to process and respond to messages.

Examples:
- `/chat` → channel=general
- `/chat #help` → channel=help
- `/chat #support answer questions about our API` → channel=support, context="answer questions about our API"

For continuous monitoring, use `/loop` to run `/chat` on an interval:
- `/loop 10s /chat #builds` → check #builds every 10 seconds
- `/loop 5m /chat #support answer questions` → monitor #support every 5 minutes

## Procedure

1. **Read messages**: Call `mcp__deepsteve__read_messages` with `channel` set to the parsed channel name.

2. **Process messages**: Review the messages. If the context/task description tells you how to respond, follow it. Otherwise, use your judgment — reply to questions or requests directed at you using `mcp__deepsteve__send_message` on the same channel. Do NOT echo or summarize messages back unprompted.

3. **Summarize**: Briefly report what you found in the channel, then stop.

## Guidelines

- When sending messages, be concise and helpful. Sign off with your session's tab name if relevant.
- If you have context/task instructions, prioritize those when deciding how to respond.
- Don't flood the channel — only send messages when you have something useful to contribute.
- If the channel is empty on first read, say so and (if polling) mention you're waiting for messages.
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/skills/fork.md" << 'DEEPSTEVE_FILE_EOF'
---
name: fork
description: Fork this conversation into a new parallel tab
argument-hint: [tab name]
---

Fork your current Claude conversation into a new deepsteve tab. Both tabs continue independently from the same conversation history.

## Procedure

1. **Get your session ID**: Read your `DEEPSTEVE_SESSION_ID` environment variable.

2. **Open a forked tab**: Call `mcp__deepsteve__open_terminal` with:
   - `session_id`: your DEEPSTEVE_SESSION_ID
   - `fork`: true
   - `name`: use `$ARGUMENTS` if provided, otherwise omit

3. **Report**: Briefly confirm the fork succeeded with the new tab's ID and name.
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/skills/github-issue.md" << 'DEEPSTEVE_FILE_EOF'
---
name: github-issue
description: Create a GitHub issue from a natural language description
argument-hint: <description of the issue>
---

The user wants to create a GitHub issue. Their description: $ARGUMENTS

Steps:
1. Draft a concise issue title (under 80 chars) and a clear markdown body from the user's description. The body should include a summary and any relevant details the user provided.
2. Create the issue using `gh issue create --title "..." --body "..."` — do not ask for confirmation. Extract the issue number from the returned URL.
3. Return the issue URL.
4. Ask the user: "Want to start working on this issue in a new deepsteve tab?" using AskUserQuestion with options "Yes" and "No".
5. If the user says yes, use the `mcp__deepsteve__start_issue` MCP tool with your `DEEPSTEVE_SESSION_ID`, the issue number, and the title. The server fetches the issue body from GitHub automatically. Tell the user the tab has been opened.
6. If the user says no, just confirm the issue was created and stop.
DEEPSTEVE_FILE_EOF

cat > "$INSTALL_DIR/skills/merge.md" << 'DEEPSTEVE_FILE_EOF'
---
name: merge
description: Merge the current worktree branch into main
---

The user wants to merge their current worktree's branch into the `main` branch.

Steps:

1. **Detect if in a worktree**: Run `git rev-parse --git-common-dir` and `git rev-parse --git-dir` and compare their resolved absolute paths. If they resolve to the same directory, you are NOT in a worktree — tell the user: "Not in a worktree — /merge only works from a worktree session." and stop.

2. **Get the current branch name**: Run `git branch --show-current`.

3. **Find the main worktree path**: Run `git worktree list --porcelain | awk '/^worktree /{path=substr($0,10)} /^branch refs\/heads\/main$/{print path}'` — this outputs exactly one line: the path of the worktree with `main` checked out. If the output is empty, tell the user no worktree has `main` checked out and stop.

4. **Commit any uncommitted changes**: Run `git status --porcelain` in the current worktree. If there are uncommitted changes, stage them with `git add -A` and commit with a message derived from the branch name (e.g. for branch `worktree-github-issue-230`, use "Fix restart prompt only shows in active window (#230)"). Use the GitHub issue title if the branch contains an issue number. Include the `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` trailer.

5. **Merge**: Run `git -C <main-worktree-path> merge <branch-name> --no-edit` to merge the worktree branch into main from the main worktree's directory. Do NOT use `git checkout main` — main is checked out in a different worktree.

6. **Handle the result**:
   - **Success**: Tell the user the branch was successfully merged into main. Show the merge output. Then continue to steps 7 and 8.
   - **Conflict**: Run `git -C <main-worktree-path> merge --abort` to leave main clean. Then rebase the worktree branch onto main (`git rebase main`), resolve any conflicts, and retry the merge from step 5. If the rebase itself fails with conflicts you cannot resolve, abort the rebase (`git rebase --abort`), tell the user, and STOP.
   - **Other failure**: Show the error output to the user. STOP here — do not proceed to steps 7 or 8.

7. **Close the GitHub issue** (success only): Extract the issue number from the branch name obtained in step 2. If the branch name matches the pattern `*github-issue-<number>*`, run `gh issue close <number> --comment "Merged into main."`. If the branch name doesn't match this pattern, skip this step silently.

8. **Add a testing task** (optional): Use the `mcp__deepsteve__add_task` tool to create a task for the human to manually test the change. The title should be short, e.g. "Test: <feature/fix summary>". The description should contain clear, actionable steps to verify the change works, written as a numbered list. Set priority to "medium" (or "high" if the change is risky or touches core functionality). Set `session_tag` to the branch name from step 2. If the user rejects this tool call, continue to step 9 anyway. Example description format:
   ```
   1. Open deepsteve and do X
   2. Verify Y happens
   3. Try edge case Z
   ```

9. **Close this terminal** (after successful merge): Run `curl -s -X POST http://localhost:3000/api/shells/$DEEPSTEVE_SESSION_ID/close`. This must always execute after a successful merge (step 5), regardless of whether step 8 was accepted or rejected. This must be the absolute last step — the session terminates after this.
DEEPSTEVE_FILE_EOF

base64 -d << 'DEEPSTEVE_B64_EOF' > "$INSTALL_DIR/public/favicon.png"
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
DEEPSTEVE_B64_EOF

base64 -d << 'DEEPSTEVE_B64_EOF' > "$INSTALL_DIR/public/icon-192.png"
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
DEEPSTEVE_B64_EOF

base64 -d << 'DEEPSTEVE_B64_EOF' > "$INSTALL_DIR/public/icon-512.png"
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vucNqgEu3ucCFNh6KArZZhuwViYuOSkY8XjykP0ZkVX7rbzrmxubP4dGxe5gQVQOJZ9ZR4amv8BrErY/nLp+q296gBpIbRch1jbDdsfhXDjUy6koYMAR7nh5WKtveYAaRV4albEiiHACY+RPCX0O+xmbpbDaJf1MhA1QHdTV3sWCEMbnp0ZhECbg8r/MwFY3tfoZFgBqrhfgy8KlIijEARjjW+G9hADgqP89t9WLM0D1Ufdg0aWX0OMzNLfDElSAOvzGl/1P3mfBFv/z5dMnpef1uC2s+6bMYDQGUSFsd1irb3aA+oIuCBO8aSCjsZZG/OHJN7FhdMovB0L/8yd9y4Q57mTy05BXILyHOEPi7utafZ8D1Ed0U6qCPTEfqLwAG4JDq26/YGX+G0YtNxtquIGFdyV5j8a+VamhWPZ96cDxn1epBgZouxeH/GLFX0R/oSKx/B/pdwcyv62mPpUkx42HOFgNAsKLsxgZtNEXvHjptvj5LRdnA9Q3VJ4BGdn9cVobxNEBgRNWHOj5ne/psP2882dodGyo+AyATykc+4uBwo/5npLSFzw6GM/ejjVfXi3AqUu2+uYWRGpkG3ptlxpyAkb8PCOYLNb9ZiabsVir12KAekk18lL7Nys41xXCFFbf8e/+eseA+C/Q/GoFh0bAZb/ufAd4moVpvLkGuP+dgdjPAkVD11vRO382bv8aj77a7BuYX8/XvPOg05++8v/uWv3+1Xfd5cl/n9Zv77J/07y8bAEOKim3tZUT1R0+QM2nJlcEdfXigd3viuZPlLABmkfp/wEGD9Y3mkFEagAAAFBlWElmTU0AKgAAAAgAAgESAAMAAAABAAEAAIdpAAQAAAABAAAAJgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAACAKADAAQAAAABAAACAAAAAAAZJZubAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAyLTIzVDE3OjQ5OjM4KzAwOjAw5v3oVAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMi0yM1QxNzo0OTozOCswMDowMJegUOgAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDItMjNUMTc6NDk6NDQrMDA6MDAN0BJaAAAAEXRFWHRleGlmOkNvbG9yU3BhY2UAMQ+bAkkAAAASdEVYdGV4aWY6RXhpZk9mZnNldAAzOK24viMAAAAYdEVYdGV4aWY6UGl4ZWxYRGltZW5zaW9uADUxMrYuuNwAAAAYdEVYdGV4aWY6UGl4ZWxZRGltZW5zaW9uADUxMishWaoAAAASdEVYdHRpZmY6T3JpZW50YXRpb24AMber/DsAAAAQdEVYdHhtcDpDb2xvclNwYWNlADEFDsjRAAAAF3RFWHR4bXA6UGl4ZWxYRGltZW5zaW9uADY5NmHTBRkAAAAXdEVYdHhtcDpQaXhlbFlEaW1lbnNpb24ANjk2/NzkbwAAAABJRU5ErkJggg==
DEEPSTEVE_B64_EOF

cat > "$INSTALL_DIR/uninstall.sh" << 'DEEPSTEVE_FILE_EOF'
#!/bin/bash
launchctl unload "$HOME/Library/LaunchAgents/com.deepsteve.plist" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.deepsteve.plist"
rm -rf "$HOME/.deepsteve"
rm -f "$HOME/Library/Logs/deepsteve.log" "$HOME/Library/Logs/deepsteve.error.log"

# Remove installed skills from Claude Code commands
rm -f "$HOME/.claude/commands/deepsteve-"*.md

# Remove Claude Code MCP registration
if command -v claude &>/dev/null; then
    claude mcp remove --scope user deepsteve 2>/dev/null || true
fi

# Remove deepsteve from OpenCode global config
OC_CONFIG="$HOME/.config/opencode/opencode.json"
if [ -f "$OC_CONFIG" ] && command -v node &>/dev/null; then
    node -e '
        const fs = require("fs");
        const p = process.argv[1];
        try {
            const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
            if (cfg.mcp && cfg.mcp.deepsteve) {
                delete cfg.mcp.deepsteve;
                if (Object.keys(cfg.mcp).length === 0) delete cfg.mcp;
                if (Object.keys(cfg).length === 0 || (Object.keys(cfg).length === 1 && cfg["$schema"])) {
                    fs.unlinkSync(p);
                } else {
                    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
                }
            }
        } catch {}
    ' "$OC_CONFIG" 2>/dev/null || true
fi

echo "deepsteve uninstalled"
DEEPSTEVE_FILE_EOF

chmod +x "$INSTALL_DIR/uninstall.sh"

cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deepsteve</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$INSTALL_DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>3000</string>
        <key>DEEPSTEVE_BIND</key>
        <string>127.0.0.1</string>
        <key>PATH</key>
        <string>$INSTALL_DIR/node/bin:$HOME/.local/bin:$(dirname $NODE_PATH):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/deepsteve.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/deepsteve.error.log</string>
</dict>
</plist>
PLISTEOF

cd "$INSTALL_DIR"
npm install

# Fix node-pty spawn-helper permissions
find "$INSTALL_DIR/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \;

if command -v claude &>/dev/null; then
    claude mcp add --scope user --transport http deepsteve http://localhost:3000/mcp 2>/dev/null || true
fi

# Configure OpenCode global MCP (merges with existing config)
if command -v opencode &>/dev/null; then
    OC_CONFIG_DIR="$HOME/.config/opencode"
    OC_CONFIG="$OC_CONFIG_DIR/opencode.json"
    mkdir -p "$OC_CONFIG_DIR"
    if [ -f "$OC_CONFIG" ]; then
        # Merge deepsteve MCP into existing config
        node -e '
            const fs = require("fs");
            const p = process.argv[1];
            let cfg = {};
            try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
            if (!cfg.mcp) cfg.mcp = {};
            cfg.mcp.deepsteve = { type: "remote", url: "http://127.0.0.1:3000/mcp" };
            fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
        ' "$OC_CONFIG" 2>/dev/null || true
    else
        cat > "$OC_CONFIG" << 'OC_EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "deepsteve": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
OC_EOF
    fi
fi

launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "deepsteve installed and running at http://localhost:3000"
echo "To uninstall: ~/.deepsteve/uninstall.sh"
echo ""
echo "⚠️  Security: DeepSteve has no authentication. It is localhost-only."
echo "   Do not expose port 3000 to a network or the public internet."
