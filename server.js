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
const { createSecurity, UI_HOST } = require('./security');
const { createSleepWatch } = require('./sleep-watch');
const { createPowerAssertion } = require('./power-assertion');
const NodePtyEngine = require('./engines/node-pty');
const TmuxEngine = require('./engines/tmux');

const PORT = process.env.PORT || 3000;
// Canonical browser URL (#545): deepsteve.localhost is loopback (RFC 6761) but has its own cookie
// jar, so ds_auth can't be evicted by other localhost apps filling the shared jar (#544). Agent/CLI
// loopback traffic (DEEPSTEVE_API_URL, MCP config, restart.sh curls) deliberately stays on plain
// localhost — it authenticates by bearer, carries no cookies, and must not depend on *.localhost
// resolving for non-browser resolvers.
const UI_URL = `http://${UI_HOST}:${PORT}`;

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

// Test mode (#562): marks this daemon as a disposable test instance. Surfaced as
// /api/version.testMode so the integration-test helpers can refuse to run destructive
// calls against anything else; also the only mode that honors POST /api/shells/killall,
// and disables the browser auto-open + auto-update check (side effects a test run must
// not have). A production daemon never sets this — there is no reason to.
const TEST_MODE = parseCLIFlag('test-mode') || process.env.DEEPSTEVE_TEST_MODE === '1';

// Like parseCLIValue but collects ALL occurrences of a repeatable flag (--allow-origin,
// --allow-host). Used for the auth escape-hatch that widens the Origin/Host allowlists (#536).
function parseCLIValues(name) {
  const args = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name && args[i + 1]) out.push(args[i + 1]);
    else if (args[i].startsWith('--' + name + '=')) out.push(args[i].slice(name.length + 3));
  }
  return out;
}
function envList(name) {
  return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}
// Operator escape hatches (widen the trust boundary; auth itself is always on and has no off switch).
const ALLOW_ORIGINS = [...parseCLIValues('allow-origin'), ...envList('DEEPSTEVE_ALLOW_ORIGIN')];
const ALLOW_HOSTS = [...parseCLIValues('allow-host'), ...envList('DEEPSTEVE_ALLOW_HOST')];
// Escape hatch for the localhost → deepsteve.localhost browser redirect (#545), for the rare
// setup where *.localhost doesn't resolve (minimal Linux without systemd-resolved).
const CANONICAL_REDIRECT = !(parseCLIFlag('no-canonical-redirect') || process.env.DEEPSTEVE_NO_CANONICAL_REDIRECT === '1');
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
const SCROLLBACK_DEFAULT_KB = 100; // default scrollback buffer size in KB
const RELOAD_FLAG = path.join(os.homedir(), '.deepsteve', '.reload');
const reloadClients = new Set(); // WebSocket connections for live-reload
const pendingOpens = []; // open-session messages waiting for a browser to connect
let restartState = null; // { resolve: fn, timeout: timer } — first browser response wins

// Deliver a message to a specific browser window, falling back to first available client.
// If no clients are connected, queues the message for flush on next connection.
function deliverToWindow(msg, targetWindowId, { openBrowser } = {}) {
  const msgObj = typeof msg === 'string' ? JSON.parse(msg) : { ...msg };
  const readyClients = [...reloadClients].filter(c => c.readyState === 1);
  let delivered = false;

  if (targetWindowId) {
    for (const client of readyClients) {
      if (client.windowId === targetWindowId && client.readyState === 1) {
        client.send(JSON.stringify(msgObj));
        delivered = true;
        break;
      }
    }
  }

  if (!delivered && readyClients.length > 0) {
    if (targetWindowId) {
      // WindowId didn't match any client — broadcast to all with windowId preserved (client-side guard will filter)
      log(`[deliverToWindow] windowId=${targetWindowId} not found among reload clients [${readyClients.map(c => c.windowId).join(',')}], broadcasting`);
      const msgStr = JSON.stringify(msgObj);
      for (const client of readyClients) {
        if (client.readyState === 1) client.send(msgStr);
      }
    } else {
      // No windowId provided — send to first available client (backward compat)
      readyClients[0].send(JSON.stringify(msgObj));
    }
    delivered = true;
  }

  if (!delivered) {
    // Keep windowId for flush routing
    pendingOpens.push(JSON.stringify(msgObj));
    if (openBrowser) {
      exec(`open "${UI_URL}"`);
    }
  }
}

function log(...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}

// Session-lifecycle tracing for debugging session-ID / planMode divergence (issue #491).
// Emits one JSON line per event into the daemon log, greppable via [session-trace].
// `ts` (epoch ms) lets analysis order events across restarts independent of the log
// prefix. Correlate a tab's whole lifecycle by its `shell`, `name`, and `worktree`.
function traceSession(event, fields) {
  log('[session-trace]', JSON.stringify({ event, ts: Date.now(), ...fields }));
}
const STATE_FILE = path.join(os.homedir(), '.deepsteve', 'state.json');
const DISPLAY_TABS_DIR = path.join(os.homedir(), '.deepsteve', 'display-tabs');
const SCREENSHOTS_DIR = path.join(os.homedir(), '.deepsteve', 'screenshots');
const SETTINGS_FILE = path.join(os.homedir(), '.deepsteve', 'settings.json');
const CONTEXTS_FILE = path.join(os.homedir(), '.deepsteve', 'contexts.json');
// Ring buffer of the last N session configs, for cross-browser restore (#533).
const RECENT_SESSIONS_FILE = path.join(os.homedir(), '.deepsteve', 'recent-sessions.json');
// Legacy scheduled-tasks "project groups" file (#521). Superseded by contexts.json
// (#526); read once on first load to migrate, then left in place untouched.
const LEGACY_GROUPS_FILE = path.join(os.homedir(), '.deepsteve', 'project-groups.json');
const RESTARTING_FLAG = path.join(os.homedir(), '.deepsteve', '.restarting');
const app = express();

// Security layer (#536): Host allowlist, Origin allowlist, per-install token auth, and failure
// rate limiting — the single source of truth shared by the HTTP, WebSocket, and MCP surfaces.
// Created before app.listen so the token exists before any request / session spawn / MCP config.
const security = createSecurity({
  port: PORT,
  httpsPort: HTTPS_PORT,
  httpsEnabled: HTTPS_ENABLED,
  getLanAddresses,
  allowOrigins: ALLOW_ORIGINS,
  allowHosts: ALLOW_HOSTS,
  canonicalRedirect: CANONICAL_REDIRECT,
  log,
});
const AUTH_TOKEN = security.token;

// 1. Host-header guard first — blocks DNS rebinding (the rebind domain shows up in Host) on every
//    request, static included.
app.use(security.hostGuard);
// 2. Bounce browser navigations on localhost to the canonical deepsteve.localhost origin (#545).
//    After hostGuard (a rebinding victim still 403s), before setAuthCookie (a bounced page load
//    must not deposit a cookie into the shared localhost jar — that jar's eviction is bug #544).
app.use(security.canonicalHostRedirect);
// 3. Hand the auth cookie to page loads (keyed off the request; runs before static streams).
app.use(security.setAuthCookie);
// Static assets are served ahead of the token gate: they carry no secrets and must load to
// bootstrap the UI (the cookie is HttpOnly; cross-origin pages can't read our responses under SOP).
app.use(express.static('public', {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/mods', express.static('mods'));
// Public, unauthenticated readiness probe — lets live-reload detect "server back up" on a deploy
// that turns auth on, before the reloaded page has re-acquired its cookie. Must stay above the gate.
app.get('/healthz', (req, res) => res.json({ ok: true }));
// 4. Token gate — POSITIONAL, not a trailing catch-all: registered here it precedes every inline
//    /api route and the async-mounted /mcp + mod routes, so it default-denies all of them (and any
//    future control endpoint). The static handlers above short-circuit real files before this runs.
app.use(security.authGate);
app.use((req, res, next) => {
  if (req.path === '/mcp') return next(); // MCP SDK parses its own body
  // Screenshot routes carry base64 PNGs (often >> 100KB) and declare their own
  // express.json({ limit: '50mb' }). Skip the default-100KB global parser here, or
  // it runs first and rejects them with PayloadTooLargeError before they reach the route.
  if (req.path.startsWith('/api/screenshots')) return next();
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

// --- Settings schema (single source of truth) ---
// Adding a new setting = one entry in SETTINGS_SCHEMA below. Defaults,
// POST /api/settings validation, and broadcastSettings() all flow from here.
// See CLAUDE.md "Adding a New Setting" for the contract.

const WAND_DEFAULT_TEMPLATE = `I need you to work on GitHub issue #{{number}}: "{{title}}"
Labels: {{labels}}
URL: {{url}}

Issue description:
{{body}}

Please read the issue carefully, understand the codebase context, and implement the changes needed.`;

const AGENT_TYPES = ['claude', 'hermes', 'opencode', 'pi'];

const SETTINGS_SCHEMA = [
  { name: 'shellProfile',               type: 'string',  default: '~/.zshrc' },
  { name: 'maxIssueTitleLength',        type: 'number',  default: 25, clamp: [10, 200] },
  { name: 'wandPlanMode',               type: 'boolean', default: true, broadcast: false },
  { name: 'wandPromptTemplate',         type: 'string',  default: WAND_DEFAULT_TEMPLATE, broadcast: false,
    logValue: v => `(${v.length} chars)` },
  { name: 'cmdTabSwitch',               type: 'boolean', default: false },
  { name: 'cmdTabSwitchHoldMs',         type: 'number',  default: 1000, clamp: [0, Infinity], fallback: 0 },
  { name: 'commandPaletteEnabled',      type: 'boolean', default: true },
  { name: 'hashCommandsEnabled',        type: 'boolean', default: true },
  { name: 'contextViewsEnabled',        type: 'boolean', default: true },
  { name: 'commandPaletteShortcut',     type: 'string',  default: 'Meta+k' },
  { name: 'overviewModeEnabled',        type: 'boolean', default: true },
  { name: 'overviewModeShortcut',       type: 'string',  default: 'Meta+o' },
  { name: 'shortcutsHelpEnabled',       type: 'boolean', default: true },
  // Two defaults (#549): macOS gives ⌘⇧/ to the browser's Help menu, which eats the
  // keydown before the page sees it. ⌘/ is the fallback so the overlay is always
  // reachable. custom (not string) because the value is a list; sanitize also accepts
  // a bare string, which is what the Settings rebind button posts.
  { name: 'shortcutsHelpShortcut',      type: 'custom',  default: ['Meta+Shift+?', 'Meta+/'],
    sanitize: (raw) => {
      const arr = [].concat(raw).map(s => String(s || '').trim()).filter(Boolean);
      return arr.length ? arr : null; // reject empty — never strand the user with no key
    },
    logValue: v => v.join(' or ') },
  { name: 'overviewDefaultLayout',      type: 'enum',    default: 'tall', values: ['tall', 'tiled'] },
  { name: 'metaControlsEnabled',        type: 'boolean', default: false },
  { name: 'inheritRemoteControl',       type: 'boolean', default: true },
  { name: 'inheritRemoteControlOnFork', type: 'boolean', default: true },
  { name: 'enabledAgents',              type: 'array',   default: ['claude', 'hermes', 'opencode', 'pi'],
    itemEnum: AGENT_TYPES, nonEmpty: true, broadcast: false,
    sideEffect: (val, s) => { s.defaultAgent = val[0]; },
    logValue: v => v.join(',') },
  { name: 'defaultAgent',               type: 'enum',    default: 'claude', values: AGENT_TYPES, broadcast: false },
  { name: 'hermesBinary',               type: 'string',  default: 'hermes',   fallbackOnEmpty: true, broadcast: false },
  { name: 'opencodeBinary',             type: 'string',  default: 'opencode', fallbackOnEmpty: true, broadcast: false },
  { name: 'piBinary',                   type: 'string',  default: 'pi',       fallbackOnEmpty: true, broadcast: false },
  { name: 'symlinkWorktreeSettings',    type: 'boolean', default: false },
  { name: 'recentSessionsLimit',        type: 'number',  default: 8, clamp: [0, 50], round: true,
    sideEffect: (val, s) => { trimRecentSessions(); } },
  { name: 'scrollbackKB',               type: 'number',  default: SCROLLBACK_DEFAULT_KB, clamp: [1, 10000], round: true },
  { name: 'engine',                     type: 'enum',    default: 'node-pty',
    values: () => tmuxEngine ? ['node-pty', 'tmux'] : ['node-pty'] },
  { name: 'autoUpdateCheckEnabled',     type: 'boolean', default: true },
  { name: 'autoUpdateCheckIntervalHours', type: 'number', default: 6, clamp: [1, 168] },
  { name: 'autoUpdateApply',            type: 'boolean', default: true },
  { name: 'sessionLogEnabled',          type: 'boolean', default: false },
  // Hold a caffeinate -i power assertion while any session is open (#563).
  // Server-side behavior only, so broadcast:false; macOS only (no-op elsewhere).
  { name: 'preventSleepWhileActive',    type: 'boolean', default: true, broadcast: false },
  { name: 'displayTabAudioIndicator',   type: 'boolean', default: true, broadcast: false },
  { name: 'scheduledTasksEnabled',      type: 'boolean', default: true },
  // How long closed-session tombstones survive in state.json before the retention
  // sweep prunes them (#561). Server-internal — no client UI reads it.
  { name: 'closedSessionRetentionDays', type: 'number',  default: 30, clamp: [1, 365], round: true, broadcast: false },
  // Custom Claude Code config profiles (#537): each row = { id, name, configDir }.
  // A profile is agentType:'claude' + a CLAUDE_CONFIG_DIR — NOT a new agent type.
  // broadcast:false — the browser reads profiles via GET /api/agents (like enabledAgents).
  { name: 'customAgentConfigs',         type: 'custom',  default: [], broadcast: false,
    sanitize: (raw) => {
      if (!Array.isArray(raw)) return null;
      return raw.map(r => ({
        id: (r && r.id) || genContextId(),
        name: String((r && r.name) || '').trim(),
        configDir: String((r && r.configDir) || '').trim(),
      })).filter(r => r.name && r.configDir);
    },
    logValue: v => v.map(r => r.name).join(',') || '(none)' },
];

// Settings whose default must exist in `settings` but that flow through
// dedicated endpoints, not POST /api/settings or broadcastSettings:
//   activeTheme   → POST /api/themes/active + broadcastTheme()   (ships CSS, not just the name)
//   enabledSkills → POST /api/skills/{enable,disable} + broadcastSkills() (performs file I/O)
const NON_SCHEMA_DEFAULTS = {
  activeTheme: 'retro-monitor',
  enabledSkills: [],
};

// Fields whose updates trigger restartUpdateTimer() (defined much later in the file).
const AUTO_UPDATE_TIMER_FIELDS = new Set(['autoUpdateCheckEnabled', 'autoUpdateCheckIntervalHours']);

function buildDefaults() {
  const d = { ...NON_SCHEMA_DEFAULTS };
  for (const entry of SETTINGS_SCHEMA) d[entry.name] = entry.default;
  return d;
}

// Validate + coerce one POSTed setting value. Returns { ok, value }.
// ok:false means the write is silently rejected (matches prior hand-rolled behavior).
function coerceSetting(entry, raw) {
  switch (entry.type) {
    case 'string': {
      const s = String(raw);
      if (entry.fallbackOnEmpty && !s) return { ok: true, value: entry.default };
      return { ok: true, value: s };
    }
    case 'boolean':
      return { ok: true, value: !!raw };
    case 'number': {
      let n = Number(raw);
      if (entry.round) n = Math.round(n);
      if (!n) n = entry.fallback !== undefined ? entry.fallback : entry.default;
      if (entry.clamp) {
        const [lo, hi] = entry.clamp;
        n = Math.max(lo, Math.min(hi, n));
      }
      return { ok: true, value: n };
    }
    case 'enum': {
      const values = typeof entry.values === 'function' ? entry.values() : entry.values;
      const v = String(raw);
      if (!values.includes(v)) return { ok: false };
      return { ok: true, value: v };
    }
    case 'array': {
      if (!Array.isArray(raw)) return { ok: false };
      let arr = raw;
      if (entry.itemEnum) arr = arr.filter(x => entry.itemEnum.includes(x));
      if (entry.nonEmpty && arr.length === 0) return { ok: false };
      return { ok: true, value: arr };
    }
    case 'custom': {
      const v = entry.sanitize(raw);
      if (v === null || v === undefined) return { ok: false };
      return { ok: true, value: v };
    }
  }
  return { ok: false };
}

function applySettingsFromBody(body, s) {
  for (const entry of SETTINGS_SCHEMA) {
    if (!(entry.name in body)) continue;
    const result = coerceSetting(entry, body[entry.name]);
    if (!result.ok) continue;
    s[entry.name] = result.value;
    if (entry.sideEffect) entry.sideEffect(result.value, s);
    const display = entry.logValue ? entry.logValue(result.value) : result.value;
    log(`Settings updated: ${entry.name}=${display}`);
  }
}

// Load settings
let settings = buildDefaults();
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    log(`Loaded settings: shellProfile=${settings.shellProfile}`);
  }
} catch (e) {
  console.error('Failed to load settings:', e.message);
}

// Migrate renamed themes
if (settings.activeTheme === 'windows-95') {
  settings.activeTheme = 'win-95';
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
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
// Both engines coexist: node-pty is always enabled, tmux is enabled if installed.
// settings.engine controls the default for new sessions, not a global mode switch.
const ptyEngine = new NodePtyEngine();
log('Engine: node-pty (always enabled)');

let tmuxEngine = null;
{
  const tmuxCheck = new TmuxEngine();
  if (tmuxCheck.available) {
    tmuxEngine = tmuxCheck;
    log(`Engine: tmux v${tmuxEngine.version} (available)`);
  } else {
    log('Engine: tmux not available');
    if (settings.engine === 'tmux') {
      settings.engine = 'node-pty';
      saveSettings();
    }
  }
}

// --- Session lifecycle event bus (issue #485) ---
// Core emits 'open'/'close' events here; the session-lifecycle mod subscribes and
// records them to a JSONL log when settings.sessionLogEnabled is on. Kept generic
// (no log-specific logic) so other mods could observe lifecycle too.
const sessionLog = new (require('events'))();
const liveSnapshots = new Map(); // id → metadata snapshot, kept until the close event fires
const closeReasons = new Map();  // id → why it closed (set before the pty exits)

// Emit an 'open' event for a genuinely new session. Snapshots metadata so the
// later 'close' event still has it after the shell entry is deleted. Not called
// for restores/reconnects (those re-attach an existing session, not a new tab).
function emitSessionOpen(id) {
  const e = shells.get(id);
  if (!e || e.agentType === 'tmux-attach') return; // tmux-attach is ephemeral
  const snap = {
    session_id: id,
    name: e.name || null,
    cwd: e.cwd || null,
    agentType: e.agentType || 'claude',
    configDir: e.configDir || null,
    worktree: e.worktree || null,
    windowId: e.windowId || null,
    claudeSessionId: e.claudeSessionId || null,
    planMode: !!e.planMode,
    createdAt: e.createdAt || Date.now(),
  };
  liveSnapshots.set(id, snap);
  sessionLog.emit('event', { type: 'open', ts: Date.now(), ...snap });
}

// Emit a 'close' event. Driven by the universal engine 'exit' funnel below, so it
// fires once per session regardless of how it ended. Reason comes from closeReasons
// (set by killShell callers) or defaults to 'exited' for natural process exits.
function recordSessionClose(id) {
  const snap = liveSnapshots.get(id);
  if (!snap) return; // never tracked, or already recorded
  const ts = Date.now();
  sessionLog.emit('event', {
    type: 'close',
    ts,
    session_id: id,
    name: snap.name,
    cwd: snap.cwd,
    agentType: snap.agentType,
    worktree: snap.worktree,
    reason: closeReasons.get(id) || 'exited',
    durationMs: snap.createdAt ? ts - snap.createdAt : null,
  });
  liveSnapshots.delete(id);
  closeReasons.delete(id);
}

// Universal close funnel: every engine emits 'exit' for any session that ends,
// regardless of which spawn path created it — so one listener per engine catches
// all closes without touching the ~8 inline onExit() handlers.
for (const eng of [ptyEngine, tmuxEngine].filter(Boolean)) {
  eng.on('exit', (id) => recordSessionClose(id));
}

function getDefaultEngine() {
  if (settings.engine === 'tmux' && tmuxEngine) return tmuxEngine;
  return ptyEngine;
}

function getEngineByType(type) {
  if (type === 'tmux' && tmuxEngine) return tmuxEngine;
  return ptyEngine;
}

function getEngine(id) {
  const entry = shells.get(id);
  return entry?.engine || getDefaultEngine();
}

function getShellProfilePath() {
  let p = settings.shellProfile || '~/.zshrc';
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

// Resolve a custom-config-profile id (#537) to its absolute config dir, or null.
// Tilde-expanded here (once) so the concrete path is what gets persisted/injected —
// the durable per-session identity is the resolved dir, not the profile id, so a
// renamed/deleted profile never breaks a running or restored session.
function resolveConfigDir(profileId) {
  if (!profileId) return null;
  const list = Array.isArray(settings.customAgentConfigs) ? settings.customAgentConfigs : [];
  const p = list.find(x => x.id === profileId);
  if (!p || !p.configDir) return null;
  let dir = p.configDir;
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  return dir;
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

// Cert SANs = LAN addresses + the canonical UI host (#545). Kept out of getLanAddresses() itself,
// which also feeds security.js's lanHosts filtering and the Quest LAN log line. Must be used by
// BOTH certsMatchCurrentIPs and ensureCerts, or the SAN comparison never matches and certs
// regenerate on every boot.
function certSans() {
  return [...getLanAddresses(), UI_HOST];
}

function certsMatchCurrentIPs() {
  const metaFile = path.join(CERTS_DIR, 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const currentIPs = certSans().sort().join(',');
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
  const sans = certSans();
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
  const payload = { type: 'settings' };
  for (const entry of SETTINGS_SCHEMA) {
    if (entry.broadcast === false) continue;
    payload[entry.name] = settings[entry.name];
  }
  const msg = JSON.stringify(payload);
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
 * Spawn a session using the specified engine.
 * @param {Engine} eng - Engine instance to use
 * @param {string} id - Session ID
 * @param {string} agentType - 'claude', 'hermes', 'opencode', or 'pi'
 * @param {string[]} args - Agent CLI arguments
 * @param {string} cwd - Working directory
 * @param {{ cols?: number, rows?: number, env?: object }} opts
 */
function sessionEnv(id, { name, worktree, windowId, cwd, agentType, configDir } = {}) {
  // DEEPSTEVE_CWD is the agent's actual working directory. For agents with native
  // --worktree support (Claude), the PTY is spawned in the main repo but the agent
  // operates in .claude/worktrees/<name>, so resolve to that subdir. The worktree dir
  // may not exist yet at spawn time, but the path is deterministic and the agent
  // creates it immediately. For other agents the spawn cwd is already the worktree.
  let agentCwd = cwd || '';
  if (worktree && agentCwd && getAgentConfig(agentType).supportsWorktree) {
    agentCwd = getWorktreePath(agentCwd, worktree);
  }
  return {
    DEEPSTEVE_SESSION_ID: id,
    DEEPSTEVE_TAB_NAME: name || '',
    DEEPSTEVE_WORKTREE: worktree || '',
    DEEPSTEVE_CWD: agentCwd,
    DEEPSTEVE_WINDOW_ID: windowId || '',
    DEEPSTEVE_API_URL: `http://localhost:${PORT}`,
    // Bearer token for authenticating REST calls to $DEEPSTEVE_API_URL (#536). Delivered only to
    // agent PTYs via this env (never in the daemon's own process.env, so childBaseEnv can't leak it).
    DEEPSTEVE_API_TOKEN: AUTH_TOKEN,
    // Custom Claude config profile (#537): point Claude at an alternate config dir.
    // Emitted only for profile sessions, so plain sessions stay byte-for-byte identical.
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
}

// Daemon-internal env vars from the launchd plist (release.sh) that must NOT leak
// into agent PTYs / command shells. Leaking PORT lets an agent's port-cleanup kill
// the daemon (#517); NODE_ENV=production silently alters agent tooling.
const DAEMON_INTERNAL_ENV_KEYS = ['PORT', 'NODE_ENV', 'DEEPSTEVE_BIND', 'DEEPSTEVE_HTTPS', 'DEEPSTEVE_HTTPS_PORT'];

// Base env for any process we spawn on the agent's behalf: a fresh copy of the
// daemon's env with the daemon-internal keys stripped, then `extraEnv` layered on
// top. Strip from the copy *first* so an explicit extraEnv value is never deleted,
// and never return process.env by reference (the caller would mutate the daemon).
function childBaseEnv(extraEnv) {
  const env = { ...process.env };
  for (const k of DAEMON_INTERNAL_ENV_KEYS) delete env[k];
  return extraEnv ? { ...env, ...extraEnv } : env;
}

function spawnSession(eng, id, agentType, args, cwd, { cols = 120, rows = 40, env: extraEnv } = {}) {
  const env = childBaseEnv(extraEnv);
  if (agentType === 'terminal') {
    eng.spawn(id, 'zsh', ['-l'], cwd, { cols, rows, env, stripEnv: DAEMON_INTERNAL_ENV_KEYS });
    return;
  }
  const bin = agentType === 'claude' ? 'claude'
    : agentType === 'hermes' ? (settings.hermesBinary || 'hermes')
    : agentType === 'opencode' ? (settings.opencodeBinary || 'opencode')
    : agentType === 'pi' ? (settings.piBinary || 'pi')
    : 'claude';
  const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  eng.spawn(id, 'zsh', ['-l', '-c', `${bin} ${quoted}`], cwd, { cols, rows, env, stripEnv: DAEMON_INTERNAL_ENV_KEYS });
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
  hermes: {
    supportsWorktree: false, // Hermes --worktree is a boolean flag (no name arg), so we create worktrees manually
    supportsSessionId: false, // Managed internally
    supportsSessionWatch: false,
    emitsBel: false,
    exitMethod: 'ctrl-c',
    initialPromptDelay: 3000,
    resumeFlag: '--resume',
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
  pi: {
    supportsWorktree: false,
    supportsSessionId: false,    // pi generates its own UUIDs; we isolate storage via --session-dir instead
    supportsSessionWatch: false,
    emitsBel: false,             // OSC 133 bytes are framing, not idle — 2s silence timer handles idle
    exitMethod: 'sigterm',       // Ctrl+C cancels the current turn, not pi itself; SIGTERM is its graceful signal
    initialPromptDelay: 3000,
    resumeFlag: '-c',
    resumeDefault: '-c'
  },
  terminal: {
    supportsWorktree: false,
    supportsSessionId: false,
    supportsSessionWatch: false,
    emitsBel: false,
    exitMethod: 'sighup', // interactive login zsh ignores SIGINT (trapped by ZLE) and often SIGTERM; SIGHUP = tty hung up → runs .zlogout and exits
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

function mcpConfigArgs(agentType, shellId) {
  if (agentType !== 'claude' || !shellId) return [];
  // The MCP config carries the auth bearer token (#536). Write it to a per-shell 0600 file and pass
  // the PATH (claude's --mcp-config accepts file paths) — never inline JSON in argv, which `ps`
  // exposes to every other local user.
  const dir = path.join(os.homedir(), '.deepsteve', 'mcp-configs');
  const file = path.join(dir, `${shellId}.json`);
  const config = {
    mcpServers: {
      deepsteve: {
        type: 'http',
        url: `http://localhost:${PORT}/mcp?shellId=${shellId}`,
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      },
    },
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (e) {
    log(`mcpConfigArgs: failed to write ${file}: ${e.message}`);
    return [];
  }
  return ['--mcp-config', file];
}

// Per-shell session dir for pi. Isolates each tab's session JSONL so `-c`
// (continue newest) always finds the right one without UUID tracking.
function piSessionDirArgs(agentType, shellId) {
  if (agentType !== 'pi' || !shellId) return [];
  const dir = path.join(os.homedir(), '.deepsteve', 'pi-sessions', shellId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return ['--session-dir', dir];
}

function getSpawnArgs(agentType, { sessionId, planMode, worktree, shellId }) {
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

  args.push(...mcpConfigArgs(agentType, shellId));
  args.push(...piSessionDirArgs(agentType, shellId));

  return args;
}

function getResumeArgs(agentType, { sessionId, planMode, worktree, shellId }) {
  const config = getAgentConfig(agentType);
  const args = [];

  if (sessionId) {
    args.push(config.resumeFlag, sessionId);
    if (agentType === 'opencode') args.push('--continue');
  } else {
    // resumeDefault is cwd-scoped ("continue most recent"), which can adopt a
    // sibling tab's conversation (#542). For claude this branch only fires on
    // legacy state entries with no saved session id (no longer written); other
    // agents have no per-session resume, so cwd-scoped continue is their best.
    args.push(config.resumeDefault);
  }

  // Re-apply permission mode on resume: Claude's --resume does not persist
  // --permission-mode, so a mid-plan session restored without this flag would
  // come back with full write permissions — a silent safety regression.
  if (planMode && config.planModeFlag) {
    args.push(config.planModeFlag, config.planModeValue);
  }

  if (worktree && config.supportsWorktree) {
    args.push('--worktree', worktree);
  }

  args.push(...mcpConfigArgs(agentType, shellId));
  args.push(...piSessionDirArgs(agentType, shellId));

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

// Resolve a session's actual working directory and its owning repo checkout.
// Claude (supportsWorktree) is spawned in the main repo and operates in the
// .claude/worktrees/<name> subdir, so entry.cwd is the repo root and the real cwd
// is the worktree subdir. Other agents are spawned directly in the worktree, so
// entry.cwd is already the worktree path. Returns { cwd, repoRoot }.
function sessionPaths(entry) {
  const base = entry?.cwd || '';
  const worktree = entry?.worktree;
  if (!worktree) return { cwd: base, repoRoot: base };
  if (getAgentConfig(entry.agentType).supportsWorktree) {
    const wt = getWorktreePath(base, worktree);
    return { cwd: fs.existsSync(wt) ? wt : base, repoRoot: base };
  }
  // Native-unsupported agent: entry.cwd is the worktree path; strip the suffix to
  // recover the repo root (falls back to base if ensureWorktree returned the root).
  const suffix = path.join('.claude', 'worktrees', worktree);
  const repoRoot = base.endsWith(suffix)
    ? base.slice(0, base.length - suffix.length - 1)
    : base;
  return { cwd: base, repoRoot };
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

function claudeProjectDir(cwd, worktree, configDir) {
  // Claude Code stores sessions in a directory named after the resolved cwd.
  // For worktree sessions, the cwd is <repo>/.claude/worktrees/<name>.
  let resolvedCwd = cwd;
  if (worktree) {
    resolvedCwd = path.join(cwd, '.claude', 'worktrees', worktree);
  }
  // Claude Code encodes cwds by replacing all non-alphanumeric/non-dash chars with dashes
  const dirName = resolvedCwd.replace(/[^a-zA-Z0-9-]/g, '-');
  // CLAUDE_CONFIG_DIR (#537) relocates Claude's entire config root — including session
  // transcripts — to <configDir>/projects, so a profile session's .jsonl files live
  // there, not under ~/.claude/projects. Watching the right dir keeps fork detection
  // and resumable-session-id tracking working for profile sessions.
  const base = configDir ? path.join(configDir, 'projects') : CLAUDE_PROJECTS_DIR;
  return path.join(base, dirName);
}

// --- Transcript-derived session labels (#560) ---
// A restore list of "claude, claude, claude…" is useless (8 of 12 sessions in the
// 2026-07-15 wipe had name: null), so unnamed sessions get a label pulled from
// their conversation transcript: the ai-title line Claude Code writes once it
// names the conversation, else the first real user message. Both land near the
// head of the file, so only the first 256KB is read — a 100MB transcript costs
// the same as a small one.
const LABEL_READ_BYTES = 256 * 1024;
const labelCache = new Map(); // claudeSessionId → { mtimeMs, label }

// `entry` is anything carrying { claudeSessionId, cwd, worktree, configDir } —
// a live shell, a savedState record, or a recent-sessions ring-buffer row.
function deriveSessionLabel(entry) {
  if (!entry || !entry.claudeSessionId || !entry.cwd) return null;
  try {
    const file = path.join(claudeProjectDir(entry.cwd, entry.worktree, entry.configDir), `${entry.claudeSessionId}.jsonl`);
    const stat = fs.statSync(file);
    const cached = labelCache.get(entry.claudeSessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.label;
    const buf = Buffer.alloc(Math.min(stat.size, LABEL_READ_BYTES));
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const label = parseTranscriptLabel(buf.toString('utf8'));
    labelCache.set(entry.claudeSessionId, { mtimeMs: stat.mtimeMs, label });
    return label;
  } catch {
    return null; // no transcript (never prompted), unreadable, whatever — no label
  }
}

function parseTranscriptLabel(head) {
  let title = null;
  let firstUser = null;
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // window may cut the last line mid-JSON
    if (obj.type === 'ai-title' && obj.aiTitle) {
      title = obj.aiTitle; // rewritten as the conversation evolves — last one wins
    } else if (!firstUser && obj.type === 'user' && !obj.isSidechain) {
      const c = obj.message && obj.message.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? ((c.find(b => b && b.type === 'text') || {}).text || '') : '';
      if (text.trim()) firstUser = text.trim();
    }
  }
  const raw = title || firstUser;
  if (!raw) return null;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
}

// True if this claude session id belongs to a shell OTHER than exceptShellId —
// i.e. deepsteve deliberately spawned it (e.g. a fork tab via `--fork-session
// --session-id <new>`), so it must never be adopted as exceptShellId's self-fork.
// Fork files embed the PARENT's id, so without this the parent's watcher would
// mistake a child fork's .jsonl for its own fork and steal the child's id (#497).
//
// (a) another LIVE shell backs this id — covers the just-forked child and, for the
//     node-pty engine, every case (its children die with the server).
// (b) a PERSISTED fork child (state.json / tombstone) whose id deepsteve minted.
//     Load-bearing for the tmux engine: an orphaned tmux fork process survives a
//     server restart and appends to its .jsonl before its tab is restored, so (a)
//     can't see it yet — without this the #497 steal returns across restarts. The
//     explicit `forkParent` lineage (#503) is what makes this authoritative rather
//     than inferred; pre-#503 entries (no forkParent) simply never match here.
function claudeSessionOwnedElsewhere(sessionId, exceptShellId) {
  for (const [sid, e] of shells) {
    if (sid !== exceptShellId && e.claudeSessionId === sessionId) return true;
  }
  for (const [sid, e] of Object.entries(savedState)) {
    if (sid !== exceptShellId && e && e.forkParent && e.claudeSessionId === sessionId) return true;
  }
  return false;
}

// Single authoritative writer for a shell's Claude session id (#503). Every lineage
// detector — the fs.watch fork detector and the PTY `--resume` matcher — funnels
// through here, so the ownership invariant and the side effects (trace, planMode
// reset, persistence) live in ONE place and a new detector can't reintroduce the
// #497 steal. Returns true iff the id was adopted.
function adoptClaudeSession(shellId, newId, source) {
  const e = shells.get(shellId);
  if (!e || !newId || newId === e.claudeSessionId) return false;
  // Refuse an id deepsteve deliberately minted for another shell (a fork child):
  // adopting it would point both tabs at the same session (#497). A genuine
  // self-fork (/clear, plan approval) mints a brand-new id nobody owns, so it
  // passes this guard and is adopted correctly.
  if (claudeSessionOwnedElsewhere(newId, shellId)) {
    log(`Session ${shellId} ignoring ${newId} — owned by another tab / fork child (${source})`);
    return false;
  }
  traceSession('SESSIONID-CHANGE', { source, shell: shellId, name: e.name || null, worktree: e.worktree || null, cwd: e.cwd, claudeOld: e.claudeSessionId, claude: newId, planModeBefore: !!e.planMode, planModeAfter: false, shuttingDown: !!shuttingDown });
  log(`Session ${shellId} claude session updated (${source}): ${e.claudeSessionId} → ${newId}`);
  e.claudeSessionId = newId;
  // Any fork (self or observed) means the user has left plan mode — don't re-apply
  // --permission-mode plan on the next restart.
  e.planMode = false;
  saveState();
  recordRecentSession(shellId);  // keep the ring-buffer entry's claudeSessionId current
  // saveState() is frozen during shutdown and the process may be SIGKILLed before the
  // final snapshot runs; patch state.json directly so the new id survives a mid-shutdown
  // kill (the PTY `--resume` line is printed on /exit, i.e. during shutdown).
  if (shuttingDown) {
    try {
      const current = loadStateFile();
      if (current[shellId]) {
        current[shellId].claudeSessionId = newId;
        current[shellId].planMode = false;
        writeStateFile(current);
        log(`Session ${shellId} patched state.json during shutdown`);
      }
    } catch (err) {
      console.error('Failed to patch state.json during shutdown:', err.message);
    }
  }
  return true;
}

function watchClaudeSessionDir(shellId) {
  const entry = shells.get(shellId);
  if (!entry) return;

  const projectDir = claudeProjectDir(entry.cwd, entry.worktree, entry.configDir);

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

      // Verify the new file references our current session (forks embed the parent
      // sessionId) — this substring match is the self-fork DETECTION signal. The
      // ownership guard (a fork tab's .jsonl also references us) and every side
      // effect live in adoptClaudeSession() (#503), so this handler just detects.
      try {
        const newFile = path.join(projectDir, filename);
        const head = fs.readFileSync(newFile, 'utf8').slice(0, 32768);
        if (!head.includes(e.claudeSessionId)) return;
        adoptClaudeSession(shellId, sessionId, 'fs-watch');
      } catch (err) {
        log(`Session ${shellId} fork check failed for ${filename}: ${err.message}, retrying in 200ms`);
        setTimeout(() => {
          try {
            const e2 = shells.get(shellId);
            if (!e2 || sessionId === e2.claudeSessionId) return;
            const head = fs.readFileSync(path.join(projectDir, filename), 'utf8').slice(0, 32768);
            if (!head.includes(e2.claudeSessionId)) return;
            adoptClaudeSession(shellId, sessionId, 'fs-watch-retry');
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
  // Mark this as a submission so the idle classifier doesn't treat the agent's
  // resulting work as "waiting for input" until its next completion BEL. Covers
  // auto-submitted initialPrompts and meta_type as well as graceful /exit.
  const e = shells.get(id);
  if (e) e.lastInputTime = Date.now();
  const engine = eng || getEngine(id);
  engine.write(id, text);
  // Returns a Promise that resolves once the deferred Enter has been written, so
  // callers (deliverPromptWhenReady) can re-enable input exactly when the submit
  // completes (#512). Existing callers ignore the return value (backward compatible).
  // The \r write is wrapped because the PTY may have died during the 1s window.
  return new Promise((resolve) => {
    setTimeout(() => {
      try { engine.write(id, '\r'); } catch {}
      resolve();
    }, 1000);
  });
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
 * Deliver a prompt to a shell, handling the race between async fetch and idle readiness.
 * If the shell is already waiting for input, submit immediately.
 * If the agent uses initialPromptDelay (non-BEL), use that delay.
 * Otherwise, install a single-shot onIdleOnce callback that the idle timer
 * will invoke on the next idle transition.
 */
function deliverPromptWhenReady(id, prompt) {
  const e = shells.get(id);
  if (!e) return;
  const config = getAgentConfig(e.agentType);
  log(`[deliverPrompt] id=${id} waitingForInput=${e.waitingForInput} initialPromptDelay=${config.initialPromptDelay} promptLen=${prompt.length}`);

  // Block user keystrokes while we auto-populate this tab, so the user can't
  // interleave input with the injected prompt and corrupt the submission (#512).
  // Scoped to loading/prefill flows only, so input is never silently dropped
  // without a visible cue (the loading banner / prefill progress bar, which carry
  // an "Enable input" override button). Cleared when the deferred Enter lands
  // (submitAndNotify below), the user clicks override, or a 60s safety timer
  // (matches the client banner auto-dismiss) fires in case the agent never goes
  // idle and submitAndNotify never runs.
  if (e.loading || e.prefill) {
    e.inputBlocked = true;
    clearTimeout(e.inputBlockTimer);
    e.inputBlockTimer = setTimeout(() => {
      const ent = shells.get(id);
      if (ent) { ent.inputBlocked = false; ent.inputBlockTimer = null; }
      log(`[deliverPrompt] id=${id} inputBlock safety timeout fired — re-enabling input`);
    }, 60000);
  }

  function submitAndNotify() {
    // Re-enable input only after the deferred Enter has actually been written, so
    // the banner dismiss, the unblock, and a truthful "prompt-submitted" event all
    // coincide with the submission landing (#512).
    submitToShell(id, prompt).then(() => {
      const entry = shells.get(id);
      if (!entry) return;
      entry.inputBlocked = false;
      clearTimeout(entry.inputBlockTimer);
      entry.inputBlockTimer = null;
      if (entry.loading || entry.prefill) {
        const wasPrefill = !!entry.prefill;
        entry.loading = false;
        entry.prefill = false;
        deliverToWindow({ type: 'prompt-submitted', id, windowId: entry.windowId || null, prefill: wasPrefill }, entry.windowId || null);
      }
    });
  }

  if (e.waitingForInput) {
    e.waitingForInput = false;
    log(`[deliverPrompt] id=${id} submitting immediately (was waiting)`);
    setTimeout(submitAndNotify, 500);
  } else if (config.initialPromptDelay > 0) {
    log(`[deliverPrompt] id=${id} using delay ${config.initialPromptDelay}ms`);
    setTimeout(submitAndNotify, config.initialPromptDelay);
  } else if (e.lastBelTime && (Date.now() - e.lastBelTime) < 2000) {
    // BEL fired recently — agent is likely at prompt even though idle timer
    // hasn't fired yet. Submit immediately.
    log(`[deliverPrompt] id=${id} BEL fired ${Date.now() - e.lastBelTime}ms ago, submitting immediately`);
    e.waitingForInput = false;
    setTimeout(submitAndNotify, 500);
  } else {
    log(`[deliverPrompt] id=${id} installing onIdleOnce for next idle transition`);
    e.onIdleOnce = () => {
      log(`[deliverPrompt] id=${id} idle detected, submitting queued prompt (len=${prompt.length})`);
      setTimeout(submitAndNotify, 500);
    };
  }
}

/**
 * True if the session's recent terminal output shows Claude Code's "/rc active"
 * footer — i.e. Remote Control is currently on. Claude redraws this footer on
 * every frame, so the latest state lives in the tail of the scrollback. We scan
 * only the last few KB (ANSI-stripped) so this is a single cheap substring test,
 * run once at child-tab creation (never on the PTY data path).
 */
function sessionHasRemoteControl(id) {
  const e = shells.get(id);
  if (!e || !e.scrollback || !e.scrollback.length) return false;
  const tail = e.scrollback.join('').slice(-8192);
  return stripEscapeSequences(tail).includes('/rc active');
}

/**
 * When a new tab/fork is opened from a parent session that has Remote Control on,
 * re-issue `/rc` in the child so it inherits remote control. Gated per-path by the
 * inheritRemoteControl / inheritRemoteControlOnFork settings. Reuses the existing
 * prepopulate-and-send path (deliverPromptWhenReady) — no new infrastructure.
 */
function maybeInheritRemoteControl({ newId, agentType, isFork, parentId }) {
  if (agentType !== 'claude') return;  // /rc is a Claude Code feature
  const enabled = isFork ? settings.inheritRemoteControlOnFork : settings.inheritRemoteControl;
  if (!enabled) return;
  if (!parentId || parentId === newId || !shells.has(parentId)) return;
  if (!sessionHasRemoteControl(parentId)) return;
  log(`[rc-inherit] parent ${parentId} has /rc active -> enabling /rc in new ${isFork ? 'fork' : 'tab'} ${newId}`);
  deliverPromptWhenReady(newId, '/rc');
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
 * Wire up a shell's onData handler: broadcast output to WebSocket clients,
 * detect idle state (2s silence), and auto-submit queued prompts.
 */
function wireShellOutput(id) {
  const entry = shells.get(id);
  if (!entry) return;
  if (!entry.scrollback) entry.scrollback = [];
  if (!entry.scrollbackSize) entry.scrollbackSize = 0;

  const dataHandler = (data) => {
    const e = shells.get(id);
    if (!e) return;
    e.lastActivity = Date.now();
    // Append to scrollback buffer
    e.scrollback.push(data);
    e.scrollbackSize += data.length;
    // Trim scrollback if it exceeds the limit
    while (e.scrollbackSize > (settings.scrollbackKB * 1024) && e.scrollback.length > 1) {
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
        // adoptClaudeSession() owns the ownership guard, planMode reset, persistence,
        // and the mid-shutdown state.json patch (this line is printed on /exit, i.e.
        // during shutdown) — #503.
        adoptClaudeSession(id, resumeMatch[1], 'pty-output');
      }
      // Track lastBelTime for deliverPromptWhenReady fallback
      if (data.includes('\x07')) {
        e.lastBelTime = Date.now();
        // A BEL is the agent's readiness signal — it has reached its input prompt.
        // If a prompt was queued before the first BEL (the WS create path queues it
        // ~11ms in, well before Claude's first bell at ~400ms), fire the queued
        // callback now instead of waiting for the 2s idle timer below. Claude's
        // streaming startup output keeps resetting that timer, delaying submission
        // by ~12s (#492). Single-shot: onIdleOnce is nulled here so the idle timer
        // won't double-fire it.
        if (e.onIdleOnce) {
          const cb = e.onIdleOnce;
          e.onIdleOnce = null;
          try { cb(); } catch (err) { log(`[bel] onIdleOnce threw: ${err.message}`); }
        }
      }

      // Silence-based idle detection: if no PTY output for 2s, mark as waiting.
      // Any output resets the timer and clears waiting state.
      if (e.waitingForInput) {
        e.waitingForInput = false;
        const stateMsg = JSON.stringify({ type: 'state', waiting: false });
        e.clients.forEach((c) => c.send(stateMsg));
      }
      clearTimeout(e.idleTimer);
      e.idleTimer = setTimeout(() => {
        // Fire any queued prompt regardless of the waiting decision below
        // (single-shot — nulled so the BEL path above can't double-fire it).
        const fireOnce = () => {
          if (e.onIdleOnce) {
            const cb = e.onIdleOnce;
            e.onIdleOnce = null;
            try { cb(); } catch (err) { log(`[idle] onIdleOnce threw: ${err.message}`); }
          }
        };
        if (e.waitingForInput) { fireOnce(); return; }

        // BEL-gated classifier (#500). Silence alone is ambiguous: a long, quiet
        // tool call (bash, slow network) looks identical to sitting at the prompt.
        // The agent emits a BEL when it actually reaches its input prompt, so only
        // flip to "waiting" when a BEL has fired since the user last submitted.
        // Fallback: a session that has never emitted a BEL (terminal bell disabled)
        // keeps the legacy silence-only heuristic so detection still works there.
        const bellEver = !!e.lastBelTime;
        const bellSinceInput = e.lastBelTime && e.lastBelTime >= (e.lastInputTime || 0);
        if (bellSinceInput || !bellEver) {
          e.waitingForInput = true;
          const stateMsg = JSON.stringify({ type: 'state', waiting: true });
          e.clients.forEach((c) => c.send(stateMsg));
        }
        fireOnce();
      }, 2000);
    }
    e.clients.forEach((c) => c.send(data));
  };

  (entry.engine || ptyEngine).onData(id, dataHandler);
  // Store reference for cleanup
  entry._engineDataHandler = dataHandler;
}

// Gracefully kill a shell
function killShell(entry, id, reason = 'closed') {
  if (entry.killed) return;
  entry.killed = true;
  // Record why this session is closing; the engine 'exit' funnel reads it when the
  // pty actually exits (closeReasons survives the shells.delete that happens first).
  closeReasons.set(id, reason);
  const eng = entry.engine || ptyEngine;

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
  traceSession('CLOSE', { shell: id, name: entry.name || null, worktree: entry.worktree || null, cwd: entry.cwd, claude: entry.claudeSessionId, planMode: !!entry.planMode, pid, agent: entry.agentType || 'claude', waitingForInput: !!entry.waitingForInput, shuttingDown: !!shuttingDown });

  // Clean up idle timer and engine data listener
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.inputBlockTimer);
  if (entry._engineDataHandler) {
    eng.removeListener('data', entry._engineDataHandler);
    entry._engineDataHandler = null;
  }

  if (config.exitMethod === 'ctrl-c') {
    // Agent just needs Ctrl+C (Hermes, OpenCode)
    try { eng.write(id, '\x03'); } catch {}
  } else if (config.exitMethod === 'sigterm') {
    // pi: SIGTERM triggers its graceful shutdown handler. Ctrl+C is "cancel turn," not quit.
    try { eng.kill(id, 'SIGTERM'); } catch {}
  } else if (config.exitMethod === 'sighup') {
    // Plain terminal: SIGHUP is the "tty hung up" signal an interactive login
    // shell exits on. SIGINT (Ctrl+C) is trapped by ZLE; SIGTERM is often ignored.
    // The +8s/+10s SIGTERM/SIGKILL escalation below stays as the net.
    try { eng.kill(id, 'SIGHUP'); } catch {}
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

// All state.json writes funnel through here: rotate the current (last-known-good)
// file to state.json.bak, then atomic tmp+rename — so a clobbered or corrupt state
// file is always one write behind a recoverable copy (#561). No stateFrozen check
// here by design: the freeze belongs to saveState(); the shutdown-final snapshot
// and mid-shutdown patch must still be able to write.
function writeStateFile(obj) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  try {
    if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak');
  } catch (e) {
    console.error('Failed to rotate state backup:', e.message);
  }
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

// Falls back to the .bak when state.json is missing or corrupt. Deliberately
// resetting an install therefore requires removing BOTH files.
function loadStateFile() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error(`state.json unreadable (${e.message}) — trying state.json.bak`);
  }
  try {
    if (fs.existsSync(STATE_FILE + '.bak')) {
      const bak = JSON.parse(fs.readFileSync(STATE_FILE + '.bak', 'utf8'));
      console.error(`RECOVERED ${Object.keys(bak).length} sessions from state.json.bak`);
      return bak;
    }
  } catch (bakErr) {
    console.error('state.json.bak also unreadable:', bakErr.message);
  }
  return {};
}

// Load saved state from previous run (shells that can be resumed)
let savedState = loadStateFile();
if (Object.keys(savedState).length > 0) {
  log(`Loaded ${Object.keys(savedState).length} saved sessions: ${Object.entries(savedState).map(([id, e]) => `${id}→${(e.claudeSessionId || '?').slice(0, 8)}`).join(', ')}`);
}

const displayTabs = new Map(); // id → HTML string (disk-backed in ~/.deepsteve/display-tabs/)

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

const screenshots = new Map(); // id → { id, timestamp, source, selector?, savedTo? } (disk-backed in ~/.deepsteve/screenshots/)

// Load persisted screenshots from disk and clean up stale files (>7 days)
try {
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    const now = Date.now();
    const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(SCREENSHOTS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      const metaPath = path.join(SCREENSHOTS_DIR, file);
      const pngPath = path.join(SCREENSHOTS_DIR, `${id}.png`);
      try {
        const stat = fs.statSync(metaPath);
        if (now - stat.mtimeMs > MAX_AGE) {
          fs.unlinkSync(metaPath);
          try { fs.unlinkSync(pngPath); } catch {}
          log(`[screenshots] Cleaned up stale file: ${id}`);
          continue;
        }
        if (!fs.existsSync(pngPath)) {
          fs.unlinkSync(metaPath);
          log(`[screenshots] Removed orphan sidecar (no png): ${id}`);
          continue;
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        screenshots.set(id, meta);
      } catch (e) {
        log(`[screenshots] Skipping ${id}: ${e.message}`);
      }
    }
    if (screenshots.size > 0) log(`Loaded ${screenshots.size} screenshots from disk`);
  }
} catch (e) {
  console.error('Failed to load screenshots:', e.message);
}

// --- Contexts (#526) -------------------------------------------------------
// A context = { id, name, dirs: [absolute folder paths] }. It is the single,
// server-owned grouping shared by the Context View (filters the tab strip) and
// the Scheduled Tasks panel (its "project group" scoping). Membership is by
// folder prefix: a tab belongs if its cwd is inside a dir; a task belongs if its
// repo root is inside/equals a dir (see pathInside). The scheduled-tasks mod
// reads these via ctx.getContexts(); the Context View reads them over /api/contexts.
let contexts = [];

function genContextId() { return randomUUID().slice(0, 8); }

// True when path `p` is `dir` itself or nested inside it (trailing slashes ignored).
// Shared with the scheduled-tasks mod (via the initMCP ctx) so folder-prefix
// membership means the same thing on both sides.
function pathInside(p, dir) {
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

function saveContexts() {
  try {
    fs.mkdirSync(path.dirname(CONTEXTS_FILE), { recursive: true });
    const tmp = CONTEXTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(contexts, null, 2));
    fs.renameSync(tmp, CONTEXTS_FILE);
  } catch (e) {
    console.error('Failed to save contexts:', e.message);
  }
}

// Load contexts from disk; on first run, migrate legacy project-groups.json
// ({name, projects} → {id, name, dirs}) so existing scheduled-tasks groups carry over.
function loadContexts() {
  try {
    if (fs.existsSync(CONTEXTS_FILE)) {
      const v = JSON.parse(fs.readFileSync(CONTEXTS_FILE, 'utf8'));
      contexts = (Array.isArray(v) ? v : [])
        .filter(c => c && typeof c.name === 'string')
        .map(c => ({ id: c.id || genContextId(), name: c.name, dirs: Array.isArray(c.dirs) ? c.dirs.filter(Boolean) : [] }));
      return;
    }
  } catch (e) {
    console.error('Failed to load contexts:', e.message);
  }
  // No contexts.json yet — migrate from legacy project-groups.json if present.
  try {
    if (fs.existsSync(LEGACY_GROUPS_FILE)) {
      const groups = JSON.parse(fs.readFileSync(LEGACY_GROUPS_FILE, 'utf8'));
      if (Array.isArray(groups) && groups.length) {
        contexts = groups
          .filter(g => g && typeof g.name === 'string')
          .map(g => ({ id: genContextId(), name: g.name, dirs: Array.isArray(g.projects) ? g.projects.filter(Boolean) : [] }));
        saveContexts();
        log(`Migrated ${contexts.length} project group(s) from project-groups.json into contexts.json`);
      }
    }
  } catch (e) {
    console.error('Failed to migrate project groups:', e.message);
  }
}
loadContexts();

function broadcastContexts() {
  const msg = JSON.stringify({ type: 'contexts', contexts });
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

// --- Recent sessions ring buffer (issue #533) ---
// A durable, most-recent-first list of the last N session configs. Populated from
// the PTY spawn paths (new/resume/fork), so it captures every real agent session —
// closed or live, this browser or another. Restore pre-seeds savedState[newId] and
// lets the normal reconnect branch resume via `claude --resume` (with its existing
// 5s resume-fail → fork fallback). Excludes plain terminals (nothing to resume) and
// display/mod tabs (they never reach these paths). Separate from the debug-only
// session-lifecycle log (mods/session-lifecycle), which is gated off by default.
let recentSessions = [];

function saveRecentSessions() {
  try {
    fs.mkdirSync(path.dirname(RECENT_SESSIONS_FILE), { recursive: true });
    const tmp = RECENT_SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(recentSessions, null, 2));
    fs.renameSync(tmp, RECENT_SESSIONS_FILE);
  } catch (e) {
    console.error('Failed to save recent sessions:', e.message);
  }
}

function loadRecentSessions() {
  try {
    if (fs.existsSync(RECENT_SESSIONS_FILE)) {
      const v = JSON.parse(fs.readFileSync(RECENT_SESSIONS_FILE, 'utf8'));
      recentSessions = (Array.isArray(v) ? v : []).filter(r => r && r.key);
    }
  } catch (e) {
    console.error('Failed to load recent sessions:', e.message);
  }
}
loadRecentSessions();

function broadcastRecentSessions() {
  const N = settings.recentSessionsLimit || 0;
  const msg = JSON.stringify({ type: 'recent-sessions', sessions: recentSessions.slice(0, N) });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  if (httpsWss) {
    for (const client of httpsWss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  // reloadClients is the always-connected live-reload channel — reaches the empty
  // state (which has no session WebSocket) so the recent list stays live there too.
  for (const client of reloadClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// Truncate the buffer to the current limit (called when the setting is lowered).
function trimRecentSessions() {
  const N = settings.recentSessionsLimit || 0;
  const before = recentSessions.length;
  if (before > N) recentSessions.length = N;
  if (recentSessions.length !== before) { saveRecentSessions(); broadcastRecentSessions(); }
}

// Upsert a session's current config into the ring buffer. Reads the live shell entry
// so name/cwd/claudeSessionId are always fresh. Dual-key dedup keeps one entry per
// lineage across both cross-browser resume (new shellId, same claudeSessionId) and
// Claude fork (same shellId, new claudeSessionId).
function recordRecentSession(id) {
  const N = settings.recentSessionsLimit || 0;
  if (!N) {
    if (recentSessions.length) { recentSessions = []; saveRecentSessions(); broadcastRecentSessions(); }
    return;
  }
  const e = shells.get(id);
  if (!e || e.agentType === 'terminal' || e.agentType === 'tmux-attach') return;
  const entry = {
    key: e.claudeSessionId || id,
    shellId: id,
    claudeSessionId: e.claudeSessionId || null,
    cwd: e.cwd || null,
    agentType: e.agentType || 'claude',
    configDir: e.configDir || null,
    worktree: e.worktree || null,
    name: e.name || null,
    planMode: !!e.planMode,
    forkParent: e.forkParent || null,  // carry lineage through tombstone→prune→recents→restore (#503)
    engineType: e.engineType || 'node-pty',
    createdAt: e.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  recentSessions = recentSessions.filter(r =>
    r.shellId !== id && !(entry.claudeSessionId && r.claudeSessionId === entry.claudeSessionId));
  recentSessions.unshift(entry);
  if (recentSessions.length > N) recentSessions.length = N;
  saveRecentSessions();
  broadcastRecentSessions();
}

// Save state on shutdown
let stateFrozen = false;  // Set during shutdown to prevent onExit handlers from overwriting

// Single serializer for state.json entries. saveState() and the shutdown-final
// snapshot must write the same shape: the final snapshot wins in the merge, so any
// field it omits is silently wiped for every live shell on a graceful restart
// (configDir was lost this way, breaking #537 profile resumes — #542).
function serializeShellEntry(entry) {
  return { cwd: entry.cwd, claudeSessionId: entry.claudeSessionId, agentType: entry.agentType || 'claude', configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', worktree: entry.worktree || null, name: entry.name || null, planMode: !!entry.planMode, forkParent: entry.forkParent || null, lastActivity: entry.lastActivity || null, createdAt: entry.createdAt || null, windowId: entry.windowId || null };
}

// #561: a session record is never hard-deleted by any runtime path. Every close
// funnels through here and leaves a restorable tombstone (keeping claudeSessionId,
// cwd, worktree, name, windowId, timestamps) so the restore/recents UI can always
// resurrect it via --resume. Permanent removal happens only via an explicit
// DELETE ?forget=1 (deliberate user action) or pruneClosedSessions() (retention).
function tombstoneSession(id, entry, reason) {
  if (entry.agentType === 'tmux-attach') return; // ephemeral — never persisted
  savedState[id] = {
    ...serializeShellEntry(entry),
    closed: true,
    closedAt: Date.now(),
    closeReason: reason || closeReasons.get(id) || 'exited',
  };
}

// Shared epilogue for every engine onExit handler: tombstone → notify tabs →
// drop from the live map → persist. No-op during shutdown (the final snapshot
// owns persistence, and a session being resumed after restart must stay
// non-closed) and when an explicit close path already removed the shell (that
// path wrote savedState itself — e.g. the ws-close grace path writes a
// NON-closed entry that must not be overwritten with closed:true).
function handleShellGone(id) {
  if (shuttingDown) return;
  const entry = shells.get(id);
  if (!entry) return;
  tombstoneSession(id, entry);
  notifyClientsShellExited(id);
  shells.delete(id);
  saveState();
}

function saveState() {
  if (stateFrozen) {
    log(`[saveState] BLOCKED — state frozen during shutdown`);
    return;
  }
  const state = {};
  for (const [id, entry] of shells) {
    if (entry.agentType === 'tmux-attach') continue; // ephemeral — don't persist
    state[id] = serializeShellEntry(entry);
  }
  // Merge with any saved state that wasn't reconnected yet
  const merged = { ...savedState, ...state };
  try {
    writeStateFile(merged);
    log(`Saved ${Object.keys(merged).length} sessions to state file: ${Object.entries(merged).map(([id, e]) => `${id}→${(e.claudeSessionId || '?').slice(0, 8)}`).join(', ')}`);
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// Periodic state save to survive crashes (saveState() is normally only triggered on SIGTERM)
setInterval(() => saveState(), 30000);

// Retention sweep: the ONLY sanctioned hard-delete besides an explicit user
// forget (DELETE ?forget=1) — #561. Non-closed entries are never pruned
// regardless of age: they are restore candidates. Legacy tombstones with no
// timestamp get stamped now so they receive a full retention window instead
// of dying at first boot.
function pruneClosedSessions() {
  if (shuttingDown) return;
  const days = settings.closedSessionRetentionDays || 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, e] of Object.entries(savedState)) {
    if (!e || !e.closed) continue;
    const ts = e.closedAt || e.lastActivity || e.createdAt;
    if (!ts) { e.closedAt = Date.now(); continue; }
    if (ts < cutoff) { delete savedState[id]; pruned++; }
  }
  if (pruned > 0) {
    log(`[retention] pruned ${pruned} closed sessions older than ${days}d`);
    saveState();
  }
}
// Boot sweep runs deferred, not at module top level: saveState() iterates the
// `shells` Map, which is declared (const, TDZ) much further down this file.
setTimeout(pruneClosedSessions, 10000);
setInterval(pruneClosedSessions, 6 * 60 * 60 * 1000);

async function shutdown(signal) {
  log(`Received ${signal}, saving state...`);
  saveState();
  powerAssertion.dispose(); // release the sleep assertion (caffeinate) up front

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
      killShell(entry, id, 'shutdown');
    } catch {}
  }

  // Phase 2: Wait up to 8s for shells to exit naturally (1s for \r delay + time to save)
  const alive = new Set(entries.map(([id]) => id));
  for (const [id, entry] of entries) {
    (entry.engine || ptyEngine).onExit(id, () => alive.delete(id));
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
      state[sid] = serializeShellEntry(sentry);
      traceSession('PERSIST', { phase: 'shutdown-final', shell: sid, name: sentry.name || null, worktree: sentry.worktree || null, claude: sentry.claudeSessionId, planMode: !!sentry.planMode });
    }
    const merged = { ...savedState, ...state };
    try {
      writeStateFile(merged);
      log(`Final state save: ${Object.keys(merged).length} sessions: ${Object.entries(merged).map(([id, e]) => `${id}→${(e.claudeSessionId || '?').slice(0, 8)}`).join(', ')}`);
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
    try { getEngine(id).kill(id, 'SIGTERM'); } catch {}
  }

  // Phase 4: Wait 2s more, then force kill
  await new Promise(r => setTimeout(r, 2000));
  for (const id of alive) {
    try { getEngine(id).kill(id, 'SIGKILL'); } catch {}
  }

  log('Shutdown complete');
  process.exit(0);
}

let shuttingDown = false;
process.on('SIGTERM', () => { if (!shuttingDown) { shuttingDown = true; shutdown('SIGTERM'); } });
process.on('SIGINT', () => { if (!shuttingDown) { shuttingDown = true; shutdown('SIGINT'); } });

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// --- Auto-update system ---
// `versionStatus` caches the latest GitHub release check so /api/version is
// non-blocking. `checkForUpdates()` runs at startup and on an interval driven
// by settings.autoUpdateCheckIntervalHours. Broadcasts to reload clients when
// the status changes so the UI can show a badge + toast without polling.

const INSTALL_SOURCE_FILE = path.join(os.homedir(), '.deepsteve', '.install-source.json');

let versionStatus = {
  current: pkg.version,
  latest: null,
  updateAvailable: false,
  releaseNotes: null,
  releaseUrl: null,
  releaseTag: null,
  installSh: null,
  checkedAt: null,
  checkError: null,
  installSource: { type: 'unknown' },
  gitTreeClean: null,
};

let updateTimer = null;
let updateInProgress = false;
let pendingAutoApply = null; // { tag, deadline, timer }

function loadInstallSource() {
  try {
    if (fs.existsSync(INSTALL_SOURCE_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSTALL_SOURCE_FILE, 'utf8'));
      if (data && (data.type === 'git' || data.type === 'curl')) {
        versionStatus.installSource = data;
        return;
      }
    }
  } catch (e) {
    log(`Failed to load install source: ${e.message}`);
  }
  versionStatus.installSource = { type: 'unknown' };
}

function refreshGitTreeClean() {
  if (versionStatus.installSource?.type !== 'git') {
    versionStatus.gitTreeClean = null;
    return;
  }
  const sourcePath = versionStatus.installSource.sourcePath;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    versionStatus.gitTreeClean = null;
    return;
  }
  try {
    const out = execFileSync('zsh', ['-l', '-c', `git -C "${sourcePath.replace(/"/g, '\\"')}" status --porcelain`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    versionStatus.gitTreeClean = out.trim() === '';
  } catch (e) {
    log(`git status failed in ${sourcePath}: ${e.message}`);
    versionStatus.gitTreeClean = null;
  }
}

function truncateNotes(body) {
  if (!body) return null;
  const MAX = 2000;
  if (body.length <= MAX) return body;
  return body.slice(0, MAX) + '\n\n… (truncated)';
}

async function checkForUpdates() {
  loadInstallSource();
  refreshGitTreeClean();
  const wasAvailable = versionStatus.updateAvailable;
  const prevTag = versionStatus.releaseTag;
  try {
    const resp = await fetch('https://api.github.com/repos/deepsteve/deepsteve/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const release = await resp.json();
    const latest = (release.tag_name || '').replace(/^v/, '');
    const updateAvailable = latest ? compareSemver(pkg.version, latest) < 0 : false;
    let installShUrl = null;
    if (Array.isArray(release.assets)) {
      const asset = release.assets.find(a => a.name === 'install.sh');
      if (asset?.browser_download_url) installShUrl = asset.browser_download_url;
    }
    if (!installShUrl && release.tag_name) {
      installShUrl = `https://github.com/deepsteve/deepsteve/releases/download/${release.tag_name}/install.sh`;
    }
    versionStatus.latest = latest || null;
    versionStatus.updateAvailable = updateAvailable;
    versionStatus.releaseNotes = truncateNotes(release.body);
    versionStatus.releaseUrl = release.html_url || null;
    versionStatus.releaseTag = release.tag_name || null;
    versionStatus.installSh = installShUrl;
    versionStatus.checkedAt = new Date().toISOString();
    versionStatus.checkError = null;
    log(`Version check: current=${pkg.version} latest=${latest} updateAvailable=${updateAvailable}`);
  } catch (e) {
    versionStatus.checkError = e.message;
    versionStatus.checkedAt = new Date().toISOString();
    log(`Version check failed: ${e.message}`);
  }

  broadcastVersionStatus();

  // Auto-apply logic: only for curl installs, only when the update is freshly
  // discovered in this check, only when user has enabled it.
  const justDiscovered = versionStatus.updateAvailable && (!wasAvailable || prevTag !== versionStatus.releaseTag);
  if (justDiscovered &&
      settings.autoUpdateApply &&
      versionStatus.installSource?.type === 'curl' &&
      !updateInProgress &&
      !pendingAutoApply) {
    scheduleAutoApply();
  }
}

function broadcastVersionStatus() {
  const msg = JSON.stringify({ type: 'version-status', status: versionStatus });
  for (const client of reloadClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function scheduleAutoApply() {
  const GRACE_MS = 60 * 1000;
  const deadline = Date.now() + GRACE_MS;
  log(`[auto-update] scheduling auto-apply in ${GRACE_MS / 1000}s for ${versionStatus.releaseTag}`);
  const timer = setTimeout(() => {
    log(`[auto-update] grace expired, triggering reinstall`);
    pendingAutoApply = null;
    applyCurlReinstall().catch(e => log(`[auto-update] auto-apply failed: ${e.message}`));
  }, GRACE_MS);
  pendingAutoApply = { tag: versionStatus.releaseTag, deadline, timer };
  const msg = JSON.stringify({
    type: 'version-auto-applying',
    tag: versionStatus.releaseTag,
    deadline,
  });
  for (const client of reloadClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function cancelAutoApply() {
  if (!pendingAutoApply) return false;
  clearTimeout(pendingAutoApply.timer);
  pendingAutoApply = null;
  const msg = JSON.stringify({ type: 'version-auto-apply-cancelled' });
  for (const client of reloadClients) {
    if (client.readyState === 1) client.send(msg);
  }
  log('[auto-update] auto-apply cancelled');
  return true;
}

function restartUpdateTimer() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (!settings.autoUpdateCheckEnabled) {
    log('[auto-update] background check disabled');
    return;
  }
  const hours = Math.max(1, Math.min(168, settings.autoUpdateCheckIntervalHours || 6));
  const intervalMs = hours * 60 * 60 * 1000;
  updateTimer = setInterval(() => {
    checkForUpdates().catch(e => log(`[auto-update] interval check failed: ${e.message}`));
  }, intervalMs);
  log(`[auto-update] background check every ${hours}h`);
}

async function applyGitPull() {
  if (updateInProgress) throw new Error('An update is already in progress');
  if (versionStatus.installSource?.type !== 'git') throw new Error('Not a git-checkout install');
  const sourcePath = versionStatus.installSource.sourcePath;
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`Source path missing: ${sourcePath}`);
  refreshGitTreeClean();
  if (versionStatus.gitTreeClean !== true) throw new Error('Working tree has uncommitted changes');

  updateInProgress = true;
  try {
    execFileSync('zsh', ['-l', '-c', `git -C "${sourcePath.replace(/"/g, '\\"')}" pull --ff-only`], {
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    log(`[auto-update] git pull succeeded in ${sourcePath}`);
    // Spawn restart.sh detached — it will POST /api/request-restart and take over.
    const { spawn } = require('child_process');
    const child = spawn('bash', [path.join(sourcePath, 'restart.sh'), '--refresh'], {
      detached: true,
      stdio: 'ignore',
      cwd: sourcePath,
    });
    child.unref();
    log(`[auto-update] spawned restart.sh`);
  } catch (e) {
    updateInProgress = false;
    throw e;
  }
  // leave updateInProgress true — restart will tear this process down
}

async function applyCurlReinstall() {
  if (updateInProgress) throw new Error('An update is already in progress');
  if (versionStatus.installSource?.type !== 'curl') throw new Error('Not a curl-pipe install');
  const installShUrl = versionStatus.installSh;
  if (!installShUrl) throw new Error('install.sh download URL not known — check for updates first');

  updateInProgress = true;
  try {
    const updateDir = path.join(os.homedir(), '.deepsteve', '.update');
    fs.mkdirSync(updateDir, { recursive: true });
    const tmpPath = path.join(updateDir, 'install.sh.tmp');
    const finalPath = path.join(updateDir, 'install.sh');
    log(`[auto-update] downloading ${installShUrl}`);
    const resp = await fetch(installShUrl, { signal: AbortSignal.timeout(60 * 1000) });
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) throw new Error(`Download too small (${buf.length} bytes)`);
    fs.writeFileSync(tmpPath, buf);
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, finalPath);
    log(`[auto-update] wrote ${finalPath} (${buf.length} bytes)`);

    const applyingMsg = JSON.stringify({ type: 'version-applying', tag: versionStatus.releaseTag });
    for (const client of reloadClients) {
      if (client.readyState === 1) client.send(applyingMsg);
    }

    const { spawn } = require('child_process');
    const child = spawn('bash', [finalPath], {
      detached: true,
      stdio: 'ignore',
      cwd: updateDir,
    });
    child.unref();
    log(`[auto-update] spawned install.sh`);
  } catch (e) {
    updateInProgress = false;
    throw e;
  }
}

app.get('/api/version', (req, res) => {
  // Non-blocking: return cached status. Client can POST /api/version/check
  // to force a fresh fetch.
  res.json({
    current: versionStatus.current,
    latest: versionStatus.latest,
    updateAvailable: versionStatus.updateAvailable,
    status: versionStatus,
    // Always present as a boolean (#562): test helpers require `testMode === true`,
    // which uniformly refuses both a live daemon (false) and a pre-#562 build (absent).
    testMode: TEST_MODE,
  });
});

app.post('/api/version/check', async (req, res) => {
  try {
    await checkForUpdates();
    res.json({ ok: true, status: versionStatus });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/update/git-pull', async (req, res) => {
  try {
    await applyGitPull();
    res.json({ ok: true, action: 'restarting' });
  } catch (e) {
    log(`[auto-update] git-pull failed: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/update/curl-reinstall', async (req, res) => {
  try {
    if (pendingAutoApply) cancelAutoApply();
    await applyCurlReinstall();
    res.json({ ok: true, action: 'reinstalling' });
  } catch (e) {
    log(`[auto-update] curl-reinstall failed: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/update/pending', (req, res) => {
  const cancelled = cancelAutoApply();
  res.json({ ok: true, cancelled });
});

app.get('/api/home', (req, res) => res.json({ home: os.homedir() }));

app.get('/api/agents', (req, res) => {
  const enabledAgents = settings.enabledAgents || ['claude'];
  const defaultAgent = settings.defaultAgent || 'claude';
  const agents = [
    { id: 'claude', name: 'Claude Code', shortName: 'CC', available: true, enabled: enabledAgents.includes('claude'), isDefault: defaultAgent === 'claude' }
  ];
  // Check if hermes is installed
  let hermesAvailable = false;
  try {
    const hBin = settings.hermesBinary || 'hermes';
    execSync(`zsh -l -c 'which ${hBin}'`, { timeout: 5000, stdio: 'pipe' });
    hermesAvailable = true;
  } catch {}
  agents.push({ id: 'hermes', name: 'Hermes', shortName: 'H', available: hermesAvailable, enabled: hermesAvailable, isDefault: defaultAgent === 'hermes' });
  // Check if opencode is installed (use login shell for full PATH)
  let opencodeAvailable = false;
  try {
    const bin = settings.opencodeBinary || 'opencode';
    execSync(`zsh -l -c 'which ${bin}'`, { timeout: 5000, stdio: 'pipe' });
    opencodeAvailable = true;
  } catch {}
  // Auto-enable available agents
  agents.push({ id: 'opencode', name: 'OpenCode (experimental)', shortName: 'OC', available: opencodeAvailable, enabled: opencodeAvailable, isDefault: defaultAgent === 'opencode' });
  // Check if pi is installed
  let piAvailable = false;
  try {
    const bin = settings.piBinary || 'pi';
    execSync(`zsh -l -c 'which ${bin}'`, { timeout: 5000, stdio: 'pipe' });
    piAvailable = true;
  } catch {}
  agents.push({ id: 'pi', name: 'Pi (experimental)', shortName: 'Pi', available: piAvailable, enabled: piAvailable, isDefault: defaultAgent === 'pi' });
  // Custom Claude config profiles (#537): appended at the END so they render last in
  // every picker. id is 'config:<pid>' so the client distinguishes them; the runtime
  // agentType stays 'claude' (resolved to a CLAUDE_CONFIG_DIR at spawn). configDir is
  // tilde-expanded here for display + the client's configDir→name badge lookup.
  const profiles = Array.isArray(settings.customAgentConfigs) ? settings.customAgentConfigs : [];
  for (const p of profiles) {
    agents.push({
      id: 'config:' + p.id,
      name: p.name,
      shortName: (p.name || '').trim().slice(0, 2).toUpperCase() || 'CC',
      available: true,
      enabled: true,
      isDefault: false,
      custom: true,
      profileId: p.id,
      configDir: resolveConfigDir(p.id),
    });
  }
  res.json({ agents, defaultAgent });
});

app.get('/api/settings', (req, res) => {
  const themeCSS = getActiveThemeCSS();
  res.json({ ...settings, themeCSS });
});

app.get('/api/settings/defaults', (req, res) => res.json(buildDefaults()));

app.get('/api/engines', (req, res) => {
  res.json({
    engines: [
      { id: 'node-pty', name: 'node-pty (built-in)', available: true },
      { id: 'tmux', name: 'tmux', available: !!tmuxEngine, version: tmuxEngine?.version || null },
    ],
    current: settings.engine || 'node-pty',
    tmuxAvailable: !!tmuxEngine,
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
  applySettingsFromBody(req.body, settings);
  saveSettings();
  broadcastSettings();
  // Side effect: restart the update-check interval if its fields changed.
  const needsTimerRestart = Object.keys(req.body).some(k => AUTO_UPDATE_TIMER_FIELDS.has(k));
  if (needsTimerRestart) restartUpdateTimer();
  // Side effect: apply a power-assertion toggle immediately instead of waiting
  // for the next 5s reconcile tick (#563).
  if ('preventSleepWhileActive' in req.body) powerAssertion.sync();
  res.json(settings);
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
  { id: 'overview-mode', type: 'builtin', name: 'Overview Mode', description: 'Show all terminals at once' },
  { id: 'shortcuts-help', type: 'builtin', name: 'Keyboard Shortcuts', description: 'Show all keyboard shortcuts' },
  { id: 'restore-sessions', type: 'builtin', name: 'Restore Sessions', description: 'Recover sessions from closed windows and tombstones' },
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
    ...sessionEnv(sessionId || '', { name: shell?.name, worktree: shell?.worktree, windowId: shell?.windowId, cwd: shell?.cwd, agentType: shell?.agentType, configDir: shell?.configDir }),
    // Run the command in the agent's real working dir (the worktree for worktree
    // sessions); sessionPaths returns an existing dir suitable for execSync's cwd.
    DEEPSTEVE_CWD: (shell ? sessionPaths(shell).cwd : '') || process.cwd(),
  };

  try {
    const output = execSync(`zsh -l -c '${filePath.replace(/'/g, "'\\''")}'`, {
      env: childBaseEnv(env),
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
          automations.push({ id, name: meta.name || id, icon: meta.icon || '⚡', description: meta.description || '', repo: meta.repo || '' });
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
  const { id, name, icon, description, repo, body } = req.body;
  if (!id || !AUTOMATION_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid automation ID' });
  const filePath = path.join(AUTOMATIONS_DIR, `${id}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(AUTOMATIONS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid automation ID' });
  }
  try {
    fs.mkdirSync(AUTOMATIONS_DIR, { recursive: true });
    const repoLine = repo ? `\nrepo: ${repo}` : '';
    const content = `---\nname: ${name || id}\nicon: ${icon || '⚡'}\ndescription: ${description || name || id}${repoLine}\n---\n\n${body || ''}`;
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
    res.json({ id, name: meta.name || id, icon: meta.icon || '⚡', description: meta.description || '', repo: meta.repo || '', body });
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

// --- Run an automation (spawn session with automation body as prompt) ---
app.post('/api/start-automation', (req, res) => {
  const { automationId, windowId: rawWindowId, sessionId } = req.body;
  if (!automationId || !AUTOMATION_ID_RE.test(automationId)) {
    return res.status(400).json({ error: 'Invalid automation ID' });
  }

  // Read automation file
  const filePath = path.join(AUTOMATIONS_DIR, `${automationId}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(AUTOMATIONS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid automation ID' });
  }
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return res.status(404).json({ error: 'Automation not found' });
  }
  const meta = parseSkillFrontmatter(content);
  const prompt = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  if (!prompt.trim()) {
    return res.status(400).json({ error: 'Automation has no instructions' });
  }

  // Resolve windowId and agentType from caller's session
  let windowId = rawWindowId;
  let agentType = 'claude';
  let configDir = null;  // inherit the caller's custom config profile, if any (#537)
  let cwd = process.env.HOME;
  if (sessionId) {
    const callerEntry = shells.get(sessionId);
    if (callerEntry) {
      if (!windowId && callerEntry.windowId) windowId = callerEntry.windowId;
      if (callerEntry.agentType) agentType = callerEntry.agentType;
      if (callerEntry.configDir) configDir = callerEntry.configDir;
      if (callerEntry.cwd) cwd = callerEntry.cwd;
    }
  }

  // Automation's configured repo overrides caller CWD
  if (meta.repo && fs.existsSync(meta.repo)) {
    cwd = meta.repo;
  }

  const id = randomUUID().slice(0, 8);
  const claudeSessionId = randomUUID();
  const agentConfig = getAgentConfig(agentType);
  const icon = meta.icon || '⚡';
  const autoName = meta.name || automationId;
  const name = `${icon} ${autoName}`;

  const spawnArgs = getSpawnArgs(agentType, { sessionId: claudeSessionId, shellId: id });
  const sessionEngine = getDefaultEngine();
  const engineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';

  log(`[API] start-automation "${automationId}": id=${id}, agent=${agentType}, engine=${engineType}, cwd=${cwd}`);
  spawnSession(sessionEngine, id, agentType, spawnArgs, cwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, windowId: windowId || null, cwd, agentType, configDir }) });
  shells.set(id, { clients: new Set(), cwd, claudeSessionId, agentType, configDir: configDir || null, engine: sessionEngine, engineType, worktree: null, windowId: windowId || null, name, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), prefill: true });
  wireShellOutput(id);
  emitSessionOpen(id);
  recordRecentSession(id);
  if (prompt) deliverPromptWhenReady(id, prompt);
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  sessionEngine.onExit(id, () => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    handleShellGone(id);
  });
  saveState();

  deliverToWindow({ type: 'open-session', id, cwd, name, windowId, prefill: true }, windowId);
  res.json({ id, name });
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

// Injected into display-tab HTML so the tab can signal when it is emitting audio.
// Runs first in the document (before content scripts) so it can patch AudioNode.connect
// to non-invasively tap each AudioContext's output, plus watch <audio>/<video> elements.
// Reports an "emitting" boolean to the parent window via postMessage; app.js toggles a
// speaker icon on the matching tab.
function audioDetectorScript(tabId) {
  return `<script>(function(){
var TAB_ID=${JSON.stringify(String(tabId))};
var emitting=false;
function report(v){if(v===emitting)return;emitting=v;try{parent.postMessage({type:'ds-audio-state',tabId:TAB_ID,emitting:v},'*');}catch(e){}}
var analysers=[];
var AC=window.AudioContext||window.webkitAudioContext;
if(AC){var origConnect=AudioNode.prototype.connect;
AudioNode.prototype.connect=function(dest){try{
var ctx=dest&&dest.context;
var isOffline=window.OfflineAudioContext&&ctx instanceof window.OfflineAudioContext;
if(ctx&&!isOffline&&dest===ctx.destination){
if(!ctx.__dsAnalyser){var a=ctx.createAnalyser();a.fftSize=256;ctx.__dsAnalyser=a;analysers.push(a);}
origConnect.call(this,ctx.__dsAnalyser);}
}catch(e){}return origConnect.apply(this,arguments);};}
function webAudioAudible(){for(var i=0;i<analysers.length;i++){var a=analysers[i],buf=new Uint8Array(a.fftSize);a.getByteTimeDomainData(buf);for(var j=0;j<buf.length;j++){if(Math.abs(buf[j]-128)>2)return true;}}return false;}
function mediaAudible(){var els=document.querySelectorAll('audio,video');for(var i=0;i<els.length;i++){var m=els[i];if(!m.paused&&!m.ended&&!m.muted&&m.volume>0&&m.currentTime>0)return true;}return false;}
setInterval(function(){report(webAudioAudible()||mediaAudible());},400);
window.addEventListener('pagehide',function(){report(false);});
})();</scr`+`ipt>`;
}

// Insert the detector script so it runs before any content script. Prefer just after the
// opening <head>; fall back to after <html>, then <body>, then prepend. Avoid emitting
// content before <!DOCTYPE> (would trigger quirks mode for existing display tabs).
function injectAudioDetector(html, tabId) {
  const tag = audioDetectorScript(tabId);
  let m = html.match(/<head[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  m = html.match(/<html[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  m = html.match(/<body[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  return tag + html;
}

app.get('/api/display-tab/:id', (req, res) => {
  let html = displayTabs.get(req.params.id);
  if (!html) return res.status(404).send('Not found');
  if (req.method === 'HEAD') return res.type('html').end();
  if (settings.displayTabAudioIndicator) html = injectAudioDetector(html, req.params.id);
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

app.get('/api/screenshots', (req, res) => {
  const list = [...screenshots.values()].sort((a, b) => b.timestamp - a.timestamp);
  res.json({ screenshots: list });
});

app.get('/api/screenshots/:id.png', (req, res) => {
  const { id } = req.params;
  if (!screenshots.has(id)) return res.status(404).end();
  res.type('png').sendFile(getScreenshotPath(id));
});

app.post('/api/screenshots', express.json({ limit: '50mb' }), (req, res) => {
  const { dataUrl, source, selector } = req.body || {};
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Invalid dataUrl' });
  }
  const base64 = dataUrl.slice('data:image/png;base64,'.length);
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'Empty image data' });
  const id = randomUUID().slice(0, 8);
  const meta = {
    id,
    timestamp: Date.now(),
    source: source === 'mcp' ? 'mcp' : 'manual',
    ...(selector ? { selector } : {}),
  };
  setScreenshot(meta, buf);
  broadcast({ type: 'screenshot-added', meta });
  res.json(meta);
});

app.delete('/api/screenshots/:id', (req, res) => {
  const { id } = req.params;
  const existed = screenshots.has(id);
  deleteScreenshot(id);
  if (existed) broadcast({ type: 'screenshot-deleted', id });
  res.json({ deleted: existed });
});

app.get('/api/shells', (req, res) => {
  const active = [...shells.entries()].map(([id, entry]) => ({ id, pid: (entry.engine || ptyEngine).getPid(id), cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', status: 'active', lastActivity: entry.lastActivity || null, connectedClients: entry.clients.size }));
  const saved = Object.entries(savedState).map(([id, entry]) => ({ id, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', status: entry.closed ? 'closed' : 'saved', lastActivity: entry.lastActivity || null, closedAt: entry.closedAt || null, closeReason: entry.closeReason || null, connectedClients: 0 }));
  res.json({ shells: [...active, ...saved] });
});

// The window→session map, derived from the sessions themselves (#551).
//
// windowId is already persisted per session by serializeShellEntry, so there is no
// separate window store to drift from state.json or to prune — a dead session is
// simply absent here. localStorage is a cache of this, not the source of truth, so
// a client that lost its jar (origin change, cleared site data, a new browser) can
// still be offered whole windows back.
//
// `windows` and `knownSessionIds` answer different questions and must stay separate:
// `windows` says which window owns what — it necessarily skips sessions with no
// windowId; `knownSessionIds` says whether a session still exists at all, including
// those. A client using the grouping as an existence oracle would discard localStorage
// windows whose sessions are alive but ungrouped (e.g. entries written by a pre-#551
// server, or start-issue sessions whose window never resolved).
function buildWindowsView({ collectUngrouped = false } = {}) {
  // Every browser window holds a live-reload socket carrying its windowId, so this
  // is the server's view of liveness. It only sees windows that are connected right
  // now — the client unions it with its own BroadcastChannel roll-call.
  const liveWindowIds = new Set(
    [...reloadClients].filter(c => c.readyState === 1 && c.windowId).map(c => c.windowId)
  );

  const byWindow = new Map();
  const knownSessionIds = [];
  const ungrouped = [];
  const add = (id, entry, status) => {
    // tmux-attach is ephemeral. saveState() skips it for live shells, but
    // DELETE /api/shells/:id writes one into savedState, so filter here too.
    if (entry.agentType === 'tmux-attach') return;
    knownSessionIds.push(id);
    const session = {
      id,
      name: entry.name || null,
      cwd: entry.cwd || null,
      agentType: entry.agentType || 'claude',
      status,
      createdAt: entry.createdAt || null,
      lastActivity: entry.lastActivity || null,
    };
    if (!entry.windowId) {
      // Exists, but belongs to no window. For the recover view (#560) these are
      // offerable — except a live session a browser is showing right now
      // (clients > 0): that one isn't lost, it's open.
      if (collectUngrouped && !(status === 'active' && entry.clients && entry.clients.size > 0)) {
        ungrouped.push(session);
      }
      return;
    }
    if (!byWindow.has(entry.windowId)) byWindow.set(entry.windowId, []);
    byWindow.get(entry.windowId).push(session);
  };

  for (const [id, entry] of shells) add(id, entry, 'active');
  for (const [id, entry] of Object.entries(savedState)) {
    if (entry.closed) continue;   // closing a tab is deliberate — the closed bucket covers it
    if (shells.has(id)) continue; // live entry already counted; would otherwise restore twice
    add(id, entry, 'saved');
  }

  const windows = [...byWindow].map(([windowId, sessions]) => {
    sessions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return {
      windowId,
      live: liveWindowIds.has(windowId),
      lastActive: Math.max(...sessions.map(s => s.lastActivity || s.createdAt || 0)),
      sessions,
    };
  }).sort((a, b) => b.lastActive - a.lastActive);

  return { windows, knownSessionIds, ungrouped };
}

app.get('/api/windows', (req, res) => {
  const { windows, knownSessionIds } = buildWindowsView();
  res.json({ windows, knownSessionIds });
});

// #560: the recover-everything view — a superset of /api/windows. Window groups
// (same shape, sessions gain `worktree` + a transcript-derived `label`), plus the
// buckets /api/windows deliberately omits: ungrouped sessions (no windowId),
// closed tombstones (#561), and recent-session lineages state.json no longer
// knows (hard-deleted pre-#561, or forgotten). Label derivation reads transcript
// files, so it lives here and NOT in /api/windows, which is on the hot startup
// path of every browser window.
app.get('/api/recoverable-sessions', (req, res) => {
  const { windows, knownSessionIds, ungrouped } = buildWindowsView({ collectUngrouped: true });

  // Enrich a session row with worktree + derived label from its state entry.
  const enrich = (session) => {
    const entry = shells.get(session.id) || savedState[session.id];
    return {
      ...session,
      worktree: (entry && entry.worktree) || null,
      label: session.name ? null : deriveSessionLabel(entry),
    };
  };

  const closed = Object.entries(savedState)
    .filter(([, e]) => e && e.closed && e.agentType !== 'tmux-attach')
    .map(([id, e]) => ({
      id,
      name: e.name || null,
      label: e.name ? null : deriveSessionLabel(e),
      cwd: e.cwd || null,
      worktree: e.worktree || null,
      agentType: e.agentType || 'claude',
      status: 'closed',
      createdAt: e.createdAt || null,
      lastActivity: e.lastActivity || null,
      closedAt: e.closedAt || null,
      closeReason: e.closeReason || null,
    }))
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

  // Ring-buffer lineages with no state.json record under any id — restorable
  // only by minting a fresh id (POST /api/recent-sessions/:key/restore).
  // savedState wins the dedupe: if the lineage is still in state.json (open,
  // saved, or tombstoned), the row above already covers it.
  const knownClaudeIds = new Set();
  for (const [, e] of shells) if (e.claudeSessionId) knownClaudeIds.add(e.claudeSessionId);
  for (const e of Object.values(savedState)) if (e && e.claudeSessionId) knownClaudeIds.add(e.claudeSessionId);
  const recents = recentSessions
    .filter(r => !(r.claudeSessionId && knownClaudeIds.has(r.claudeSessionId))
              && !shells.has(r.shellId) && !savedState[r.shellId])
    .map(r => ({
      key: r.key,
      name: r.name || null,
      label: r.name ? null : deriveSessionLabel(r),
      cwd: r.cwd || null,
      worktree: r.worktree || null,
      agentType: r.agentType || 'claude',
      updatedAt: r.updatedAt || null,
    }));

  res.json({
    windows: windows.map(w => ({ ...w, sessions: w.sessions.map(enrich) })),
    knownSessionIds,
    ungrouped: ungrouped.map(enrich),
    closed,
    recents,
  });
});

app.post('/api/shells/killall', (req, res) => {
  // #562: killall destroys EVERY session on this server. Its only callers are the
  // integration tests; a stray test run against a live daemon once wiped all of a
  // developer's sessions. Only a DEEPSTEVE_TEST_MODE=1 instance will honor it.
  if (!TEST_MODE) {
    return res.status(403).json({
      error: 'Refused: /api/shells/killall is test-only (destroys every session on this server). ' +
             'It is enabled only when the server runs with DEEPSTEVE_TEST_MODE=1. See #562.',
    });
  }
  const killed = [];
  for (const [id, entry] of shells) {
    killed.push({ id, pid: (entry.engine || ptyEngine).getPid(id) });
    tombstoneSession(id, entry, 'killed');
    notifyClientsShellExited(id);
    killShell(entry, id, 'killed');
    shells.delete(id);
  }
  if (killed.length > 0) saveState();
  res.json({ killed });
});

// Permanent removal requires an explicit ?forget=1 — without it, DELETE is
// idempotent on a closed session (the tombstone stays), so an automated caller
// that retries a DELETE can never destroy a session record (#561).
app.delete('/api/shells/:id', (req, res) => {
  const id = req.params.id;
  const forget = req.query.forget === '1';

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
    if (forget) {
      delete savedState[id];
    } else {
      tombstoneSession(id, entry, 'closed');
    }
    killShell(entry, id, 'closed');
    shells.delete(id);
    log(`Killed active shell ${id}, ${forget ? 'forgotten' : 'preserved as closed'}`);
    saveState();
    return res.json({ killed: id, status: 'active' });
  }

  // Check saved state
  if (savedState[id]) {
    if (forget) {
      delete savedState[id];
      log(`Permanently removed session ${id} (explicit forget)`);
      saveState();
      return res.json({ killed: id, status: 'forgotten' });
    }
    if (savedState[id].closed) {
      // Already a tombstone — idempotent no-op
      return res.json({ killed: id, status: 'closed', tombstone: true });
    }
    // Non-closed saved session: mark as closed instead of deleting
    savedState[id].closed = true;
    savedState[id].closedAt = Date.now();
    savedState[id].closeReason = 'closed';
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

function closeSession(id, reason = 'closed') {
  const entry = shells.get(id);
  if (!entry) return false;

  log(`[closeSession] session ${id} closing (${reason})`);

  // Notify connected browser clients to close this tab
  const closeMsg = JSON.stringify({ type: 'close-tab' });
  entry.clients.forEach((c) => { try { c.send(closeMsg); } catch {} });

  if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null; }

  unwatchClaudeSessionDir(id);
  tombstoneSession(id, entry, reason);
  killShell(entry, id, reason);
  shells.delete(id);
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

// Best-effort: the command running in a plain-terminal session right now, or
// null when the shell is idle at its prompt. macOS-only (ps), computed on demand.
function getForegroundCommand(id) {
  try {
    const entry = shells.get(id);
    if (!entry) return null;
    const pid = (entry.engine || ptyEngine).getPid(id);
    if (!pid) return null;
    // The tty's foreground process group. If it's the shell itself, we're idle.
    const tpgid = parseInt(execFileSync('/bin/ps', ['-o', 'tpgid=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000 }).trim(), 10);
    if (!tpgid || tpgid === pid) return null;
    const out = execFileSync('/bin/ps', ['-o', 'command=', '-g', String(tpgid)],
      { encoding: 'utf8', timeout: 2000 }).trim();
    return out ? out.split('\n').map(s => s.trim()).filter(Boolean).join(' | ') : null;
  } catch { return null; }
}

app.get('/api/shells/:id/info', (req, res) => {
  const id = req.params.id;
  const entry = shells.get(id);
  if (!entry) return res.status(404).json({ error: 'Session not found' });
  const fallbackName = entry.cwd ? path.basename(entry.cwd) : 'shell';
  const { cwd, repoRoot } = sessionPaths(entry);
  res.json({
    id,
    name: entry.name || fallbackName || 'root',
    cwd,
    repoRoot,
    worktree: entry.worktree || null,
    windowId: entry.windowId || null,
    agentType: entry.agentType || 'claude',
    configDir: entry.configDir || null,
    runningCommand: entry.agentType === 'terminal' ? getForegroundCommand(id) : null,
    createdAt: entry.createdAt || null,
    elapsedMs: entry.createdAt ? Date.now() - entry.createdAt : null,
  });
});

// "Clear disconnected" marks sessions closed — it never hard-deletes (#561).
// Tombstones age out via pruneClosedSessions() or an explicit per-session forget.
app.post('/api/shells/clear-disconnected', (req, res) => {
  const cleared = [];

  // Mark saved sessions (no running PTY) as closed
  for (const [id, entry] of Object.entries(savedState)) {
    if (entry.closed) continue; // already a tombstone
    cleared.push(id);
    entry.closed = true;
    entry.closedAt = Date.now();
    entry.closeReason = 'disconnected';
  }

  // Kill active shells with no connected clients
  for (const [id, entry] of shells) {
    if (entry.clients.size === 0) {
      cleared.push(id);
      tombstoneSession(id, entry, 'disconnected');
      killShell(entry, id, 'disconnected');
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

// --- Contexts (#526): the unified grouping shared by the Context View and the
// Scheduled Tasks panel. Upsert is keyed by `id` (client-generated on create so
// the creating window can focus it immediately). ---
app.get('/api/contexts', (req, res) => res.json({ contexts }));

app.post('/api/contexts', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Context name required' });
  const dirs = Array.isArray(b.dirs) ? b.dirs.filter(Boolean) : [];
  const id = (b.id && String(b.id)) || genContextId();
  const existing = contexts.find(c => c.id === id);
  if (existing) { existing.name = name; existing.dirs = dirs; }
  else contexts.push({ id, name, dirs });
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
});

app.delete('/api/contexts/:id', (req, res) => {
  const idx = contexts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Context not found' });
  contexts.splice(idx, 1);
  saveContexts();
  broadcastContexts();
  res.json({ deleted: req.params.id });
});

// Reorder contexts (#532): the client sends the full id order after a rail
// drag-to-reorder. Rebuild the array to match, then persist + broadcast so every
// window reflects it. Ids the client didn't list are appended defensively so a
// stale client can never drop a context.
app.post('/api/contexts/reorder', (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : null;
  if (!order) return res.status(400).json({ error: 'order array required' });
  const byId = new Map(contexts.map(c => [c.id, c]));
  const next = [];
  for (const id of order) { const c = byId.get(id); if (c) { next.push(c); byId.delete(id); } }
  for (const c of byId.values()) next.push(c);
  contexts = next;
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
});

// --- Recent sessions (issue #533) ---

app.get('/api/recent-sessions', (req, res) => {
  const N = settings.recentSessionsLimit || 0;
  res.json({ sessions: recentSessions.slice(0, N) });
});

// Restore a recent session: mint a fresh shell id, pre-seed savedState[newId] with
// the stored config, and return the id. The client then connects to it, hitting the
// normal reconnect branch which resumes via `claude --resume` (and its 5s fork
// fallback if the conversation is gone). This reuses the resume path with zero
// duplication and works from any browser.
app.post('/api/recent-sessions/:key/restore', (req, res) => {
  const r = recentSessions.find(s => s.key === req.params.key);
  if (!r) return res.status(404).json({ error: 'Recent session not found' });
  const newId = randomUUID().slice(0, 8);
  savedState[newId] = {
    cwd: r.cwd,
    claudeSessionId: r.claudeSessionId,
    agentType: r.agentType,
    configDir: r.configDir || null,
    engineType: r.engineType,
    worktree: r.worktree,
    name: r.name,
    planMode: r.planMode,
    forkParent: r.forkParent || null,  // preserve fork lineage across a recents restore (#503)
    createdAt: r.createdAt,
    windowId: null,
  };
  saveState();
  res.json({ id: newId, cwd: r.cwd, name: r.name, agentType: r.agentType });
});

app.delete('/api/recent-sessions/:key', (req, res) => {
  const before = recentSessions.length;
  recentSessions = recentSessions.filter(s => s.key !== req.params.key);
  if (recentSessions.length !== before) { saveRecentSessions(); broadcastRecentSessions(); }
  res.json({ ok: true });
});

const issueCache = new Map(); // key: `${cwd}:${limit}` → { data, ts }
const ISSUE_CACHE_TTL = 10000; // 10 seconds

app.get('/api/issues', (req, res) => {
  let cwd = req.query.cwd || process.env.HOME;
  if (cwd.startsWith('~')) cwd = path.join(os.homedir(), cwd.slice(1));
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 5;
  const limit = perPage * page;
  const cacheKey = `${cwd}:${limit}`;
  const cached = issueCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ISSUE_CACHE_TTL) {
    const pageIssues = cached.data.slice((page - 1) * perPage);
    return res.json({ issues: pageIssues, hasMore: pageIssues.length === perPage });
  }
  exec(`zsh -l -c 'gh issue list --json number,title,body,labels,url --limit ${limit}'`,
    { cwd, encoding: 'utf8', timeout: 15000 },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        const all = JSON.parse(stdout);
        issueCache.set(cacheKey, { data: all, ts: Date.now() });
        const pageIssues = all.slice((page - 1) * perPage);
        res.json({ issues: pageIssues, hasMore: pageIssues.length === perPage });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
});

app.post('/api/start-issue', (req, res) => {
  const { number, title, body, labels, url, cwd: rawCwd, windowId: rawWindowId, sessionId, agentType: rawAgentType } = req.body;
  if (!number || !title) return res.status(400).json({ error: 'number and title are required' });

  // Resolve windowId, agentType, and cwd: explicit value, or look up from caller's session
  let windowId = rawWindowId;
  let agentType = rawAgentType;
  let configDir = null;  // custom config profile (#537)
  let cwd = rawCwd;
  // A profile selected as the default agent arrives as agentType='config:<pid>' (or an
  // explicit configProfile field). Resolve it to a concrete dir; the runtime agentType
  // stays 'claude'. Resolve BEFORE caller inheritance so it takes precedence.
  let configProfile = req.body.configProfile || null;
  if (agentType && agentType.startsWith('config:')) { configProfile = agentType.slice('config:'.length); agentType = 'claude'; }
  if (configProfile) configDir = resolveConfigDir(configProfile);
  if (sessionId) {
    const callerEntry = shells.get(sessionId);
    if (callerEntry) {
      if (!windowId && callerEntry.windowId) windowId = callerEntry.windowId;
      if (!agentType && callerEntry.agentType) agentType = callerEntry.agentType;
      if (!configDir && callerEntry.configDir) configDir = callerEntry.configDir;
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
    worktree,
    shellId: id
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

  const sessionEngine = getDefaultEngine();
  const engineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';
  log(`[API] start-issue #${number}: id=${id}, agent=${agentType}, engine=${engineType}, worktree=${worktree || 'none'}, cwd=${worktreeCwd}`);
  spawnSession(sessionEngine, id, agentType, spawnArgs, worktreeCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, worktree, windowId: windowId || null, cwd: worktreeCwd, agentType, configDir }) });
  shells.set(id, { clients: new Set(), cwd: worktreeCwd, claudeSessionId: claudeSessionId, agentType, configDir: configDir || null, engine: sessionEngine, engineType, worktree: worktree || null, windowId: windowId || null, name, planMode: !!settings.wandPlanMode, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), loading: true });
  wireShellOutput(id);
  emitSessionOpen(id);
  recordRecentSession(id);
  // Route any synchronous prompt through deliverPromptWhenReady so agents
  // get a one-shot onIdleOnce callback or their configured delay.
  if (prompt) deliverPromptWhenReady(id, prompt);
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  sessionEngine.onExit(id, () => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    handleShellGone(id);
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
  deliverToWindow({ type: 'open-session', id, cwd, name, windowId, loading: true }, windowId, { openBrowser: true });
  res.json({ id, name, url: UI_URL });
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

// Confirmation text for the `./restart.sh --force` path (#504). The server owns
// the wording so restart.sh can echo it back into Claude Code's permission
// prompt — the human-visible acceptance gate that replaces the in-app modal —
// and re-validate it before restarting. Returned as plain text because the
// value IS the display string. `shells.size` is the active-PTY count (the
// blast radius); saved/closed sessions live in `savedState` and aren't
// interrupted by a restart.
app.get('/api/restart-prompt', (req, res) => {
  const n = shells.size;
  res.type('text/plain').send(
    `Restarting - ${n} active session${n === 1 ? '' : 's'} will be interrupted`
  );
});

reconcileSkills();

const server = app.listen(PORT, BIND, () => {
  log(`HTTP server listening on ${BIND}:${PORT} — UI at ${UI_URL}`);
  if (TEST_MODE) {
    log('*** DEEPSTEVE_TEST_MODE: disposable test instance — killall enabled, browser auto-open and auto-update check disabled ***');
  }
  // Auto-open browser if no clients connect within 5s of startup.
  // Skipped on restart: restart.sh writes .restarting before unloading the
  // old daemon, so existing browsers get a chance to silently reconnect
  // without a phantom new tab racing in. Cold starts (no marker) keep the
  // original behavior. Also skipped in test mode — a throwaway test daemon
  // must never pop a tab in (or expose itself to) the developer's browser.
  let skipAutoOpen = TEST_MODE;
  try {
    if (fs.existsSync(RESTARTING_FLAG)) {
      fs.unlinkSync(RESTARTING_FLAG);
      skipAutoOpen = true;
      log('Restart detected (.restarting flag present), skipping auto-open');
    }
  } catch (e) {
    log(`Failed to check/clear .restarting flag: ${e.message}`);
  }
  if (!skipAutoOpen) {
    setTimeout(() => {
      const connected = [...reloadClients].filter(c => c.readyState === 1);
      if (connected.length === 0) {
        log('No browser connected after startup, opening default browser');
        exec(`open "${UI_URL}"`);
      }
    }, 5000);
  }

  // Auto-update: load install source and kick off the first check after the
  // server is listening (so the GitHub fetch doesn't block boot).
  loadInstallSource();
  refreshGitTreeClean();
  if (settings.autoUpdateCheckEnabled && !TEST_MODE) {
    setTimeout(() => {
      checkForUpdates().catch(e => log(`[auto-update] startup check failed: ${e.message}`));
    }, 5000);
    restartUpdateTimer();
  } else {
    log(`[auto-update] background check disabled by ${TEST_MODE ? 'test mode' : 'settings'}`);
  }
});
const shells = new Map();

// --- Sleep/wake awareness (#563) ---
// System sleep freezes the daemon and suspends the browser at different times
// (DarkWake runs the daemon for ~45s while pages stay frozen), so client silence
// right after a wake is the sleep's fault, not evidence the client is gone. The
// detach reaper and the live-reload heartbeat consult sleepWatch before treating
// silence as absence. Env overrides exist so integration tests can run fast.
const DETACH_GRACE_MS = parseInt(process.env.DEEPSTEVE_DETACH_GRACE_MS, 10) || 30000;
const DETACH_HOLDOFF_MS = parseInt(process.env.DEEPSTEVE_DETACH_HOLDOFF_MS, 10) || 120000;
const sleepWatch = createSleepWatch({ log });
sleepWatch.start();

// While any session is open, hold a macOS power assertion so the machine doesn't
// idle-sleep out from under it (#563). caffeinate -i does not block clamshell
// sleep — that's deliberate. -w makes caffeinate exit on its own if we die.
const powerAssertion = createPowerAssertion({
  isWanted: () => !!settings.preventSleepWhileActive && shells.size > 0,
  log,
});
// A 5s reconcile tick instead of hooks at every shells.set/delete site: there are
// six spawn sites plus mod context helpers, and ≤5s of acquire/release latency is
// irrelevant on sleep timescales.
setInterval(() => powerAssertion.sync(), 5000).unref();

// Grace timer for a session whose last client socket closed. Fires only after
// DETACH_GRACE_MS of daemon-awake, client-absent time: if the daemon recently woke
// from sleep (sleepWatch), or this very timer fired far later than it was armed
// for (the daemon was frozen before sleepWatch's own overdue tick could run —
// overdue timers run in due-time order, so the reaper can beat the detector),
// re-arm instead of reaping so a post-wake reconnect always wins the race.
function armDetachReap(entry, reap, delayMs = DETACH_GRACE_MS) {
  const armedAt = Date.now();
  entry.killTimer = setTimeout(() => {
    if (entry.clients.size > 0) return;
    const lateMs = Date.now() - armedAt - delayMs;
    let deferMs = sleepWatch.holdoffRemaining(DETACH_HOLDOFF_MS);
    if (lateMs > 10000) deferMs = Math.max(deferMs, DETACH_HOLDOFF_MS);
    if (deferMs > 0) {
      log(`[sleep-watch] detach reap deferred ${Math.ceil(deferMs / 1000)}s (recent wake)`);
      armDetachReap(entry, reap, Math.max(deferMs, 1000));
      return;
    }
    reap();
  }, delayMs);
}

// --- tmux session reattach on startup ---
// If tmux is available, check for surviving tmux sessions and reattach them
// regardless of the default engine setting.
if (tmuxEngine) {
  const tmuxSessions = tmuxEngine.listSessions();
  if (tmuxSessions.length > 0) {
    log(`tmux: found ${tmuxSessions.length} surviving session(s): ${tmuxSessions.join(', ')}`);
    for (const id of tmuxSessions) {
      const meta = savedState[id];
      if (!meta) {
        log(`tmux: session ${id} has no metadata in state.json, killing orphan`);
        tmuxEngine.destroy(id);
        continue;
      }
      if (tmuxEngine.reattach(id, 120, 40)) {
        const agentConfig = getAgentConfig(meta.agentType || 'claude');
        shells.set(id, {
          clients: new Set(),
          cwd: meta.cwd,
          claudeSessionId: meta.claudeSessionId,
          agentType: meta.agentType || 'claude',
          configDir: meta.configDir || null,
          engine: tmuxEngine,
          engineType: 'tmux',
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
        tmuxEngine.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          handleShellGone(id);
        });
        delete savedState[id]; // saved → live promotion, not a close
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

function setScreenshot(meta, pngBuffer) {
  screenshots.set(meta.id, meta);
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, `${meta.id}.png`), pngBuffer);
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, `${meta.id}.json`), JSON.stringify(meta));
  } catch (e) { log(`[screenshots] Failed to persist ${meta.id}: ${e.message}`); }
}

function deleteScreenshot(id) {
  screenshots.delete(id);
  try { fs.unlinkSync(path.join(SCREENSHOTS_DIR, `${id}.png`)); } catch {}
  try { fs.unlinkSync(path.join(SCREENSHOTS_DIR, `${id}.json`)); } catch {}
}

function getScreenshotPath(id) {
  return path.join(SCREENSHOTS_DIR, `${id}.png`);
}
// verifyClient runs during the HTTP upgrade, before the handshake completes, so a page failing the
// Host/Origin/token checks never gets a live socket (#536).
const wss = new WebSocketServer({ server, verifyClient: security.verifyWsClient });

// HTTPS server (created async if enabled)
let httpsServer = null;
let httpsWss = null;

if (HTTPS_ENABLED) {
  (async () => {
    try {
      const certs = await ensureCerts();
      httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
      httpsWss = new WebSocketServer({ server: httpsServer, verifyClient: security.verifyWsClient });
      httpsWss.on('connection', handleWsConnection);
      httpsServer.listen(HTTPS_PORT, BIND, () => {
        const addrs = getLanAddresses().filter(a => a !== 'localhost' && a !== '127.0.0.1');
        log(`HTTPS server listening on ${BIND}:${HTTPS_PORT}`);
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
    let lastBeat = Date.now();
    const pingInterval = setInterval(() => {
      const beatGap = Date.now() - lastBeat;
      lastBeat = Date.now();
      if (!ws.isAlive) {
        // A missing pong right after a sleep is the sleep's fault, not the
        // client's: the browser was frozen when the ping went out (#563). Give
        // it one fresh round-trip instead of terminating. beatGap catches the
        // case where this overdue interval runs before sleepWatch's own tick.
        if (beatGap > 40000 || sleepWatch.holdoffRemaining(45000) > 0) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
          return;
        }
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
    const tmuxBin = tmuxEngine?.tmuxPath || 'tmux';
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
      engine: ptyEngine, // tmux-attach uses raw node-pty for the attach PTY
      engineType: 'node-pty',
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
      while (e.scrollbackSize > (settings.scrollbackKB * 1024) && e.scrollback.length > 1) {
        e.scrollbackSize -= e.scrollback.shift().length;
      }
      e.clients.forEach((c) => c.send(data));
    });

    attachPty.onExit(() => {
      if (!shuttingDown) { shells.delete(id); }
    });

    log(`[WS] tmux-attach: id=${id}, session=${tmuxSession}`);

    entry.clients.add(ws);
    ws.send(JSON.stringify({ type: 'session', id, restored: false, cwd: null, name: tabName, agentType: 'tmux-attach', engineType: 'node-pty', scrollback: false, existingClients: 0, pingPong: true }));

    ws.on('message', (msg) => {
      const str = msg.toString();
      try {
        const parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'resize') {
          attachPty.resize(parsed.cols, parsed.rows);
          return;
        }
        if (parsed.type === 'redraw') { attachPty.write('\x0c'); return; }
        // Liveness probe (#563) — must return before the attachPty.write below,
        // or the raw JSON would be typed into the tmux session.
        if (parsed.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch {} return; }
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
        }
      } catch {}
      entry.lastActivity = Date.now();
      attachPty.write(str);
    });

    ws.on('close', () => {
      if (!shells.has(id)) return;
      entry.clients.delete(ws);
      if (entry.clients.size === 0) {
        // Detach after grace period (sleep-aware — #563)
        armDetachReap(entry, () => {
          log(`[WS] tmux-attach: detaching from ${tmuxSession} (grace period expired)`);
          try { attachPty.kill(); } catch {}
          shells.delete(id);
        });
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
  let agentType = url.searchParams.get('agentType') || 'claude';
  const forkFrom = url.searchParams.get('fork');
  const requestedEngine = url.searchParams.get('engine'); // optional per-session engine override
  // Custom Claude config profile (#537): the client sends configProfile=<pid> with
  // agentType=claude. Resolve to a concrete dir now — the resolved dir is the durable
  // per-session identity (persisted below), so a later profile rename/delete can't break
  // this session. Tolerate a stale client that packs the id into agentType as 'config:<pid>'.
  let configProfile = url.searchParams.get('configProfile') || null;
  if (agentType.startsWith('config:')) { configProfile = agentType.slice('config:'.length); agentType = 'claude'; }
  let configDir = resolveConfigDir(configProfile);

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
      const savedPlanMode = !!restored.planMode;
      const agentConfig = getAgentConfig(savedAgentType);

      const savedEngineType = restored.engineType || 'node-pty';
      const sessionEngine = getEngineByType(savedEngineType);
      const restoredEngineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';

      // Claude only writes <sessionId>.jsonl once the first message is sent, so a
      // tab that was opened but never prompted has no transcript and `--resume` is
      // guaranteed to fail. Falling back to `-c` then continues the most recent
      // conversation for this cwd — a SIBLING tab's — which is how N same-project
      // tabs collapsed onto one conversation after a restart (#542). Spawn fresh
      // instead, reusing the same session id: it was never used, so nothing is
      // lost, and state.json/TabSessions stay stable.
      let spawnFresh = false;
      if (agentConfig.supportsSessionWatch && claudeSessionId) {
        const transcript = path.join(claudeProjectDir(cwd, savedWorktree, restored.configDir), `${claudeSessionId}.jsonl`);
        spawnFresh = !fs.existsSync(transcript);
        if (spawnFresh) log(`Session ${id} has no transcript at ${transcript} — spawning fresh instead of --resume`);
      }

      log(`Restoring session ${id} in ${cwd} (agent: ${savedAgentType}, engine: ${restoredEngineType}, session: ${claudeSessionId}, worktree: ${savedWorktree || 'none'}, planMode: ${savedPlanMode})`);
      const restoredName = name || restored.name || null;
      traceSession('SPAWN', { path: spawnFresh ? 'fresh' : 'resume', shell: id, name: restoredName, worktree: savedWorktree || null, cwd, claude: claudeSessionId, planMode: savedPlanMode, agent: savedAgentType, engine: restoredEngineType });
      const ptySize = { cols: initialCols, rows: initialRows };

      const argOpts = { sessionId: claudeSessionId, planMode: savedPlanMode, worktree: savedWorktree, shellId: id };
      const startArgs = spawnFresh ? getSpawnArgs(savedAgentType, argOpts) : getResumeArgs(savedAgentType, argOpts);

      // The connecting client's windowId wins over the saved one: restoring a window
      // into a new browser window (or claiming an orphan) reconnects with a different
      // windowId, and env is fixed at spawn — so passing the stale saved value would
      // hand the agent a DEEPSTEVE_WINDOW_ID whose window no longer exists, and any
      // deliverToWindow() it triggered would land nowhere (#551).
      const restoredWindowId = windowId || restored.windowId || null;
      spawnSession(sessionEngine, id, savedAgentType, startArgs, cwd, { ...ptySize, env: sessionEnv(id, { name: restoredName, worktree: savedWorktree, windowId: restoredWindowId, cwd, agentType: savedAgentType, configDir: restored.configDir }) });
      shells.set(id, { clients: new Set(), cwd, claudeSessionId, agentType: savedAgentType, configDir: restored.configDir || null, engine: sessionEngine, engineType: restoredEngineType, worktree: savedWorktree, name: restoredName, planMode: savedPlanMode, forkParent: restored.forkParent || null, restored: true, waitingForInput: false, lastActivity: Date.now(), createdAt: restored.createdAt || Date.now(), windowId: restoredWindowId });
      wireShellOutput(id);
      recordRecentSession(id);  // bump recency on same-browser reconnect + cross-browser restore
      if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);

      // Bounded respawn chain for fast-failing restores. Never fall back to
      // `claude -c` here: -c is cwd-scoped, so it would adopt another tab's
      // conversation (#542). A restored tab may only resume its OWN session or
      // start empty.
      //   attempt 0 (resume)         → fast exit → retry the same --resume once
      //                                (covers transient spawn failures with a good transcript)
      //   attempt 1 (retry or fresh) → fast exit → fresh session under a NEW id
      //                                (transcript unusable, or the reused --session-id collided)
      //   attempt 2                  → fast exit → plain cleanup, no further respawns
      let restoreAttempt = spawnFresh ? 1 : 0;
      const armRestoreExit = () => {
        const attemptStart = Date.now();
        sessionEngine.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (shuttingDown) return;  // Don't overwrite state file during shutdown
          const elapsed = Date.now() - attemptStart;
          const entry = shells.get(id);
          if (elapsed >= 5000 || !claudeSessionId || !agentConfig.supportsSessionWatch || !entry || restoreAttempt >= 2) {
            handleShellGone(id);
            return;
          }
          restoreAttempt++;
          let tracePath;
          let respawnArgs;
          let newClaudeSessionId = null;
          if (restoreAttempt === 1) {
            // --resume died fast despite a transcript on disk — transient spawn
            // failure (observed during rapid double-restarts). Same args, one retry.
            tracePath = 'resume-retry';
            respawnArgs = getResumeArgs(savedAgentType, { sessionId: entry.claudeSessionId, planMode: entry.planMode, worktree: entry.worktree, shellId: id });
          } else {
            // The retry also died fast (unusable transcript), or the fresh spawn's
            // reused --session-id collided. Start over under a new id — last attempt.
            tracePath = 'fresh-fallback';
            newClaudeSessionId = randomUUID();
            respawnArgs = getSpawnArgs(savedAgentType, { sessionId: newClaudeSessionId, planMode: entry.planMode, worktree: entry.worktree, shellId: id });
          }
          log(`Session ${id} exited after ${elapsed}ms — respawning (${tracePath})`);
          traceSession('SPAWN', { path: tracePath, shell: id, name: entry.name || null, worktree: entry.worktree || null, cwd, claudeOld: entry.claudeSessionId, claude: newClaudeSessionId || entry.claudeSessionId, planMode: !!entry.planMode, elapsedMs: elapsed });
          sessionEngine.destroy(id);
          spawnSession(sessionEngine, id, savedAgentType, respawnArgs, cwd, { ...ptySize, env: sessionEnv(id, { name: entry.name, worktree: entry.worktree, windowId: entry.windowId, cwd, agentType: savedAgentType, configDir: entry.configDir }) });
          if (newClaudeSessionId) {
            entry.claudeSessionId = newClaudeSessionId;
            entry.forkParent = null;  // fresh id starts an unrelated conversation — drop stale lineage (#503)
          }
          entry.killed = false;
          entry.scrollback = [];
          entry.scrollbackSize = 0;
          wireShellOutput(id);
          recordRecentSession(id);
          watchClaudeSessionDir(id);
          armRestoreExit();
          saveState();
        });
      };
      armRestoreExit();
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

    // forkFrom bypasses getSpawnArgs and does not pass --permission-mode plan,
    // so record planMode=false for forked sessions even if the URL param was set.
    let spawnArgs;
    let spawnedPlanMode;
    let spawnPath = 'new';
    let parentShell = null, parentClaude = null, parentWorktree = null;
    if (forkFrom && shells.has(forkFrom)) {
      const parent = shells.get(forkFrom);
      spawnArgs = ['--resume', parent.claudeSessionId, '--fork-session', '--session-id', sessionId];
      if (worktree) spawnArgs.push('--worktree', worktree);
      else if (parent.worktree) spawnArgs.push('--worktree', parent.worktree);
      spawnArgs.push(...mcpConfigArgs(agentType, id));
      configDir = parent.configDir || configDir;  // fork inherits the parent's config profile (#537)
      spawnedPlanMode = false;
      spawnPath = 'fork';
      parentShell = forkFrom;
      parentClaude = parent.claudeSessionId;
      parentWorktree = parent.worktree || null;
      log(`[WS] Forking from shell ${forkFrom} (parent claude session: ${parent.claudeSessionId})`);
    } else {
      spawnArgs = getSpawnArgs(agentType, {
        sessionId,
        planMode,
        worktree,
        shellId: id
      });
      spawnedPlanMode = !!planMode;
    }

    const sessionEngine = getEngineByType(requestedEngine || settings.engine);
    const engineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';
    log(`[WS] Creating NEW shell: oldId=${oldId}, newId=${id}, agent=${agentType}, engine=${engineType}, session=${sessionId}, worktree=${worktree || 'none'}, cwd=${worktreeCwd}, planMode=${spawnedPlanMode}`);
    traceSession('SPAWN', { path: spawnPath, shell: id, oldId: oldId || null, name: name || null, worktree: worktree || null, cwd: worktreeCwd, claude: sessionId, planMode: spawnedPlanMode, agent: agentType, engine: engineType, parentShell, parentClaude, parentWorktree });
    // windowId is applied on every connect below, but it has to be set HERE too:
    // saveState() runs at the end of this block, so without it a new session
    // persists windowId:null and its window grouping is missing from state.json
    // until the next periodic save (#551). It also gives the agent a correct
    // DEEPSTEVE_WINDOW_ID, which sessionEnv otherwise reported as ''.
    spawnSession(sessionEngine, id, agentType, spawnArgs, worktreeCwd, { cols: initialCols, rows: initialRows, env: sessionEnv(id, { name, worktree, windowId, cwd: worktreeCwd, agentType, configDir }) });
    shells.set(id, { clients: new Set(), cwd: worktreeCwd, claudeSessionId: sessionId, agentType, configDir: configDir || null, engine: sessionEngine, engineType, worktree: worktree || null, windowId, name: name || null, planMode: spawnedPlanMode, forkParent: parentClaude, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
    wireShellOutput(id);
    emitSessionOpen(id);
    recordRecentSession(id);
    // Inherit Claude's Remote Control (/rc) from the parent tab/fork if it had it on.
    maybeInheritRemoteControl({
      newId: id,
      agentType,
      isFork: spawnPath === 'fork',
      parentId: spawnPath === 'fork' ? forkFrom : url.searchParams.get('rcParent'),
    });
    if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
    sessionEngine.onExit(id, () => { if (!shuttingDown && agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id); handleShellGone(id); });
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
  // pingPong: capability flag (#563) — clients only send {type:'ping'} probes when
  // the server advertises it, because an older server would type the raw JSON into
  // the PTY (unknown control messages fall through to the input write).
  ws.send(JSON.stringify({ type: 'session', id, restored: entry.restored || false, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', claudeSessionId: entry.claudeSessionId || null, scrollback: hasScrollback, existingClients, waitingForInput: entry.waitingForInput || false, pingPong: true }));

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
      // Only treat input as a control message if it's a JSON object. Raw user input
      // that happens to parse as a JSON primitive (e.g. typing "1" in a plain terminal
      // parses as the number 1) must fall through to the PTY write below. See #373.
      if (parsed && typeof parsed === 'object') {
      if (parsed.type === 'resize') { getEngine(id).resize(id, parsed.cols, parsed.rows); return; }
      if (parsed.type === 'redraw') { return; } // no-op: Ink echoes \x0c as ^L garbage; scrollback replay handles reconnect
      // Liveness probe from a just-woken client (#563). Must return before the
      // PTY write below, and must not touch lastActivity/waitingForInput — a
      // probe is not user input.
      if (parsed.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch {} return; }
      if (parsed.type === 'initialPrompt') {
        // Client-initiated issue-start (magic wand) marks the prompt as `loading` so
        // we block input and emit prompt-submitted to dismiss the banner, matching the
        // server-initiated /api/start-issue path (#495, #512).
        if (parsed.loading) entry.loading = true;
        deliverPromptWhenReady(id, parsed.text);
        return;
      }
      if (parsed.type === 'rename') { entry.name = parsed.name || null; return; }
      if (parsed.type === 'unblock-input') {
        // Manual override from the loading banner's "Enable input" button (#512).
        entry.inputBlocked = false;
        clearTimeout(entry.inputBlockTimer);
        entry.inputBlockTimer = null;
        return;
      }
      if (parsed.type === 'close-session') {
        entry.clients.delete(ws);
        ws.close();
        if (entry.clients.size === 0) {
          log(`[WS] close-session: last client detached from ${id}, killing shell`);
          tombstoneSession(id, entry, 'user-closed');
          killShell(entry, id, 'user-closed');
          shells.delete(id);
          saveState();
        } else {
          log(`[WS] close-session: client detached from ${id}, ${entry.clients.size} client(s) remain`);
        }
        return;
      }
      }
    } catch {}
    // Drop user keystrokes while an auto-injected prompt is being submitted, so
    // typing can't interleave with the injected text (#512). Control messages
    // (resize/rename/unblock-input/close-session) already returned above, so they
    // still work as escape hatches.
    if (entry.inputBlocked) return;
    // User sent input - update activity and clear waiting/idle state
    entry.lastActivity = Date.now();
    entry.lastInputTime = Date.now();
    clearTimeout(entry.idleTimer);
    if (entry.waitingForInput) {
      entry.waitingForInput = false;
      const stateMsg = JSON.stringify({ type: 'state', waiting: false });
      entry.clients.forEach((c) => c.send(stateMsg));
    }
    getEngine(id).write(id, str);
  });

  ws.on('close', () => {
    if (!shells.has(id)) return; // already killed by close-session
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      // Grace period to allow reconnect on refresh (sleep-aware — #563)
      armDetachReap(entry, () => {
        // Preserve session info so it can be restored on next connect. Must go
        // through serializeShellEntry: hand-rolling this dropped windowId (so a
        // closed browser window lost its tab grouping — #551) and engineType (so
        // a disconnected tmux session came back as node-pty). No `closed` flag —
        // a disconnect is not a user close, and stays a restore candidate.
        savedState[id] = serializeShellEntry(entry);
        killShell(entry, id, 'disconnected');
        shells.delete(id);
        saveState();
      });
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
initMCP({ app, security, shells, wss, broadcast, broadcastToWindow, log, MODS_DIR, closeSession, tombstoneSession, handleShellGone, spawnSession, sessionEnv, getSpawnArgs, mcpConfigArgs, getAgentConfig, wireShellOutput, watchClaudeSessionDir, unwatchClaudeSessionDir, saveState, validateWorktree, ensureWorktree, sessionPaths, submitToShell, fetchIssueFromGitHub, deliverPromptWhenReady, reloadClients, deliverToWindow, settings, isShuttingDown: () => shuttingDown, displayTabs, setDisplayTab, deleteDisplayTab, screenshots, setScreenshot, deleteScreenshot, getScreenshotPath, getDefaultEngine, getForegroundCommand, sessionLog, emitSessionOpen, getContexts: () => contexts, pathInside }).catch(e => log('MCP init failed:', e.message));

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
