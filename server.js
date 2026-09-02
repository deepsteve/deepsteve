const express = require('express');
const https = require('https');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { execSync, execFileSync, exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { initMCP, getModTools, isMcpReady } = require('./mcp-server');
const { createSecurity, UI_HOST } = require('./security');
const { createSleepWatch } = require('./sleep-watch');
const { createPowerAssertion } = require('./power-assertion');
const { resolveForkTip } = require('./fork-resolve');
const { formatLogTimestamp, createLogRotator, defaultLogPaths } = require('./logging');
const { findGitRoot } = require('./git-root');
const { modKind } = require('./mod-kind');
const { usableWorktree } = require('./worktree-support');
const { worktreePath, worktreeExists, worktreeStatus, worktreeStatuses, freshWorktreeName } = require('./worktree-status');
const { stateDir, agentHomeDir, expandTilde, spawnCwdProblem, assertSpawnCwd, tmuxSocketPath, defaultTmuxSocketPath } = require('./paths');
const { resolveBinary, runBinary, resolveUrlOpener, resolveLoginShell } = require('./bin-path');
const { createPendingOpens } = require('./pending-opens');
const { findOrphanSessions } = require('./orphan-sweep');
const { reattachSurvivingTmuxSessions } = require('./tmux-reattach');
const { createSessionAutoClose } = require('./session-auto-close');
const { classifyScreenTail, CLAUDE_SCREEN_MARKERS } = require('./screen-classifier');
const { TerminalScreen } = require('./terminal-screen');
const { terminalEnv } = require('./terminal-env');
const { readComposerDraft, isPromptStaged, isPromptOnScreen, promptDraftVerdict } = require('./composer-state');
const { wrapRunCommand } = require('./terminal-run');
const { isTerminalReport } = require('./terminal-input');
const { renderIssuePrompt, issueWorktreeName, issueTabName, resumePromptText, WORKFLOW_STAGES } = require('./issue-prompt');
const { readRecentUserMessages, compareDelivered } = require('./prompt-delivery-check');
const { enrichTabs, summarizeRun } = require('./timelapse-snapshot');
// History view (#672): bytes → lines, then lines → renderable entries. Namespaced
// rather than destructured so the two constants keep their module's name at the
// use site, where they are read as tuning knobs.
const TRANSCRIPT_WINDOW = require('./transcript-window');
const { normalizeLines } = require('./transcript-view');
const { disposableDaemon } = require('./disposable');
const { createIdleWatchdog } = require('./idle-watchdog');
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

// Is this the canonical install, or a throwaway (#678)? TEST_MODE is one input among
// several: the daemon an agent starts by hand to verify a change sets no flag at all,
// which is exactly why the answer is DERIVED rather than declared — see disposable.js.
// A disposable daemon logs its URL instead of opening a browser, and arms an idle
// watchdog that shuts it down. Neither can happen on the installed daemon.
//
// Assigned, not const-initialized here, because the predicate consults the install-source
// marker and versionStatus is declared far below; classifyDaemon() runs at the bottom of
// module load, before anything can call openBrowserUrl(). DISPOSABLE_REASONS feeds the
// boot log so an unexpected "no browser opened" names its own cause.
let DISPOSABLE = false;
let DISPOSABLE_REASONS = [];
function classifyDaemon() {
  const verdict = disposableDaemon({
    testMode: TEST_MODE,
    port: PORT,
    dirname: __dirname,
    stateDir: DS_DIR,
    installSource: versionStatus.installSource,
    env: process.env,
    homedir: os.homedir(),
    userHomedir: (() => { try { return os.userInfo().homedir; } catch { return null; } })(),
  });
  DISPOSABLE = verdict.disposable;
  DISPOSABLE_REASONS = verdict.reasons;
  return verdict;
}
// How long a disposable daemon may sit with nobody attached and no session activity
// before it tears itself down. 0 disables. Deliberately an env var and NOT a
// SETTINGS_SCHEMA entry: a scratch-HOME daemon boots on default settings anyway, and a
// knob that can end the daemon has no business in the settings modal of a real install.
const IDLE_SHUTDOWN_MS = process.env.DEEPSTEVE_IDLE_SHUTDOWN_MS !== undefined
  ? (parseInt(process.env.DEEPSTEVE_IDLE_SHUTDOWN_MS, 10) || 0)
  : 30 * 60 * 1000;

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
// The state + install dir (#621). Resolved once: stateDir() reads os.homedir(), which is
// constant for the process lifetime, so every path built from it below is exactly the
// string the inline path.join(DS_DIR, …) used to produce.
const DS_DIR = stateDir();
// A Unix socket's sun_path, minus the NUL. The tmux socket lives under DS_DIR since
// #625, so this is what bounds how deep a $HOME (or a test's mkdtemp) can be before
// tmux stops working. Reported at boot; the `tmuxSocket` setting is the way out.
const SUN_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;
const CERTS_DIR = path.join(DS_DIR, 'certs');
const AUTOMATIONS_DIR = path.join(DS_DIR, 'automations');

if (!net.isIP(BIND)) {
  console.error(`Error: '${BIND}' is not a valid IP address. Use --bind <address> with a valid IPv4 or IPv6 address.`);
  process.exit(1);
}

if (BIND !== '127.0.0.1' && BIND !== '::1') {
  // This used to read "There is NO authentication", which stopped being true when auth landed
  // (#536) and had to go. What replaced it states the tradeoff that actually applies now:
  // setAuthCookie issues the token on LOOPBACK page loads only, so widening the bind no longer
  // hands the token to the network — but it does mean a LAN browser can't just open the UI, and
  // the token remains one shared per-install secret rather than a per-user login.
  const W = 62;
  const lines = [
    `WARNING: Binding to ${BIND}`,
    '',
    'deepsteve will be reachable from other machines on your',
    'network. Auth is required, and the per-install token is',
    'never handed to a non-loopback client - so a browser on',
    'the LAN cannot simply load the UI. Such a client must',
    'send the token itself:',
    '  Authorization: Bearer <~/.deepsteve/auth-token>',
    '',
    'That token is one shared per-install secret, not a',
    'per-user login: anyone who obtains it has full control',
    'of your agent sessions.',
    '',
    'Prefer the default loopback bind, plus a tunnel:',
    '  ssh -L 3000:localhost:3000 <host>',
  ];
  console.error('');
  console.error('  ╔' + '═'.repeat(W) + '╗');
  for (const line of lines) console.error('  ║  ' + line.padEnd(W - 2) + '║');
  console.error('  ╚' + '═'.repeat(W) + '╝');
  console.error('');
}
const SCROLLBACK_DEFAULT_KB = 100; // default scrollback buffer size in KB
const RELOAD_FLAG = path.join(DS_DIR, '.reload');
const reloadClients = new Set(); // WebSocket connections for live-reload
// open-session messages waiting for a browser to connect. Self-cleaning (#596):
// entries are dropped when their session/display tab closes, filtered for liveness
// at flush time, and bounded by a TTL + cap — see pending-opens.js.
const pendingOpens = createPendingOpens({ log: (...a) => log(...a) });
let restartState = null; // { resolve: fn, timeout: timer } — first browser response wins
let metaConsentState = null; // { promise, resolve: fn, timeout: timer } — pending Meta Controls consent (#519)
let metaConsentDeclinedAt = 0; // cooldown start so a retrying agent can't nag the user with modals

// Open the UI in the user's browser. `open` is macOS-only; Linux wants xdg-open and a
// headless box has neither (#621) — which is not an error, so say so once and move on
// rather than failing invisibly the way the old bare `exec('open …')` did (it passed no
// callback, so any failure was discarded).
function openBrowserUrl(url = UI_URL) {
  // A throwaway daemon never opens a tab in the user's daily browser (#678). The guard
  // lives HERE rather than at the call sites because there are two of them — the startup
  // timer and deliverToWindow's `openBrowser` — and a third would inherit the bug. Say the
  // URL instead: the reason a second instance is running is that someone wants to look at it.
  if (DISPOSABLE) {
    log(`Disposable daemon (${DISPOSABLE_REASONS.join(', ')}) — not opening a browser. Open ${url} yourself`);
    return;
  }
  const opener = resolveUrlOpener();
  if (!opener) {
    log(`No URL opener found (open/xdg-open) — open ${url} yourself`);
    return;
  }
  execFile(opener, [url], (e) => { if (e) log(`Failed to open browser: ${e.message}`); });
}

// Deliver a message to a specific browser window, falling back to first available client.
// If no clients are connected, queues the message for flush on next connection.
//
// Returns HOW it went out (#680): 'window' (the named window took it), 'broadcast' (some
// other window did, with the windowId preserved for the client-side guard), or 'queued'
// (nobody was connected, so pendingOpens holds it for the next one). This used to be a
// local that was computed and thrown away, which is how MCP start_issue could report a
// tab as open when no browser had ever heard of it.
function deliverToWindow(msg, targetWindowId, { openBrowser } = {}) {
  const msgObj = typeof msg === 'string' ? JSON.parse(msg) : { ...msg };
  const readyClients = [...reloadClients].filter(c => c.readyState === 1);
  let delivered = false;
  let outcome = 'queued';

  if (targetWindowId) {
    for (const client of readyClients) {
      if (client.windowId === targetWindowId && client.readyState === 1) {
        client.send(JSON.stringify(msgObj));
        delivered = true;
        outcome = 'window';
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
    outcome = 'broadcast';
  }

  if (!delivered) {
    // Keep windowId for flush routing
    pendingOpens.push(JSON.stringify(msgObj));
    if (openBrowser) {
      openBrowserUrl();
    }
  }
  return outcome;
}

// How long a freshly spawned session gets to acquire a browser client before we say so
// (#680). Generous: it has to cover the page reload that auth-heal.js performs when a
// stale cookie gets a WS upgrade rejected — which is precisely the window in which the
// original orphan was created.
const ATTACH_DEADLINE_MS = 8000;

/**
 * Say out loud when a session nobody asked for in a browser turns out to have no
 * browser (#680). MCP start_issue / open_terminal return the instant the PTY spawns —
 * that is the right latency, but it means their success shape is a claim about the
 * spawn, never about the tab. This is the deferred half of that claim.
 *
 * Reporting only. The repair is the orphan sweep, which will find the same session a
 * few seconds later and re-emit its open-session; this line is what makes the failure
 * legible when someone goes back through the log asking what happened.
 */
function noteSpawnDelivery(id, { tabDelivery, windowId, source }) {
  setTimeout(() => {
    const entry = shells.get(id);
    if (!entry || entry.clients.size > 0) return;
    log(`[spawn] ${id}: no browser client attached ${ATTACH_DEADLINE_MS / 1000}s after ${source} `
      + `(tabDelivery=${tabDelivery}, windowId=${windowId || 'none'}) — the session is running but may have no tab`);
  }, ATTACH_DEADLINE_MS).unref();
}

// A queued message is only worth delivering if the thing it points at still exists
// (#596). An unattended scheduled run that fired, finished and auto-closed before
// any browser connected must NOT hand its tombstoned id to the next window — the
// WS restore path would resurrect it as a zombie `--resume` tab in a worktree its
// own cleanup already removed. Unknown (mod-defined) types are never dropped for
// liveness; the queue's TTL/cap is their only bound.
function isPendingOpenLive(parsed) {
  switch (parsed.type) {
    case 'open-session':
    case 'prompt-submitted':
    case 'deliver-prompt':
      return shells.has(parsed.id);
    case 'open-display-tab':
      return displayTabs.has(parsed.id);
    default:
      return true;
  }
}

function log(...args) {
  console.log(`[${formatLogTimestamp()}]`, ...args);
}

// Error beacon from public/js/client-log.js — page JS errors and failed fetches. Shared by the two
// transports (the live-reload WS message handler and POST /api/client-log), so the caps and the
// line format can't drift between an authenticated and an unauthenticated caller.
//
// Everything here is attacker-controlled text on the unauthenticated path, so: bounded entry count,
// bounded field lengths, and control characters stripped — a raw \r or an ANSI escape in the daemon
// log corrupts the file for `grep` and can repaint a terminal that is tailing it.
const CLIENT_LOG_MAX_ENTRIES = 25;
function appendClientLogEntries(windowId, entries) {
  if (!Array.isArray(entries)) return;
  const win = sanitizeClientLogField(windowId, 40) || '?';
  for (const e of entries.slice(0, CLIENT_LOG_MAX_ENTRIES)) {
    const kind = sanitizeClientLogField(e && e.kind, 40) || 'event';
    const msg = sanitizeClientLogField(e && e.msg, 400);
    // The realm (shell, mod:workshop, display-tab:…) is what #675 lacked: 660 rejections and no way
    // to tell which of the page's same-origin realms was making them.
    const realm = sanitizeClientLogField(e && e.realm, 40);
    log(`[client ${win}${realm ? ` ${realm}` : ''}] ${kind}: ${msg}`);
  }
}
function sanitizeClientLogField(v, max) {
  if (v === undefined || v === null) return '';
  // Character-wise rather than a regex: a control-character class has to be written with literal
  // escapes, and those have a habit of landing in the source as the raw bytes themselves.
  let out = '';
  for (const ch of String(v).slice(0, max)) {
    const code = ch.codePointAt(0);
    out += (code < 0x20 || code === 0x7f) ? ' ' : ch;   // C0 controls + DEL
  }
  return out;
}

// Session-lifecycle tracing for debugging session-ID / planMode divergence (issue #491).
// Emits one JSON line per event into the daemon log, greppable via [session-trace].
// `ts` (epoch ms) lets analysis order events across restarts independent of the log
// prefix. Correlate a tab's whole lifecycle by its `shell`, `name`, and `worktree`.
function traceSession(event, fields) {
  log('[session-trace]', JSON.stringify({ event, ts: Date.now(), ...fields }));
}

// Log rotation (#557): launchd/systemd hold our stdout/stderr open on the log
// files with O_APPEND, so the daemon rotates them itself (copy → ftruncate on
// its own fd). The inode guard inside makes this a no-op for foreground/dev
// runs whose stdout isn't actually one of these files.
const logRotator = createLogRotator({ targets: defaultLogPaths() });
logRotator.start();

// --- Cold-start timing (#665) ---
// Three marks — first log line, port open, first browser window — so a slow boot can be
// attributed without re-deriving it from `ps -o lstart` afterwards.
//
// process.uptime() is measured from node's own start, which is what makes the first mark
// worth having: the entire require graph is ~30ms warm, so a large number there means the
// time went to cold page cache inside this process, while a small one means it was spent
// before main() (exec + dyld) and only `ps` can see it. On a post-reboot cold start that
// gap has been ~17s — far larger than everything deepsteve itself does at startup.
let browserMarked = false;
function bootMark(what) {
  log(`[startup] ${what} at +${process.uptime().toFixed(1)}s since node start`);
}
bootMark('first log line');

// --- Waiting-classifier audit (#558 research instrumentation) ---
// Records every waitingForInput decision, BEL classification, and a periodic sample
// of all shells as JSONL, so the flag can be compared offline against what was
// actually on screen. Gated by the default-off `waitingAuditEnabled` setting, read
// live at every call site. Best-effort: a logging failure must never affect the
// data path.
const WAITING_AUDIT_FILE = path.join(DS_DIR, 'waiting-audit.jsonl');
const WAITING_AUDIT_MAX_BYTES = 64 * 1024 * 1024; // runaway guard if left enabled
let waitingAuditBytes = -1; // -1 = not yet initialized from the existing file
let waitingAuditCapped = false;
function auditWaiting(event, id, e, extra = {}) {
  if (!settings.waitingAuditEnabled || waitingAuditCapped) return;
  try {
    if (waitingAuditBytes < 0) {
      try { waitingAuditBytes = fs.statSync(WAITING_AUDIT_FILE).size; } catch { waitingAuditBytes = 0; }
    }
    const now = Date.now();
    const line = JSON.stringify({
      ts: now, event, shell: id,
      agent: e.agentType || 'claude',
      name: e.name || null,
      waiting: !!e.waitingForInput,
      msSinceBel: e.lastBelTime ? now - e.lastBelTime : null,
      msSinceInput: e.lastInputTime ? now - e.lastInputTime : null,
      msSinceActivity: e.lastActivity ? now - e.lastActivity : null,
      msSinceSpinner: e.lastSpinnerTime ? now - e.lastSpinnerTime : null,
      ...extra,
    }) + '\n';
    fs.appendFileSync(WAITING_AUDIT_FILE, line);
    waitingAuditBytes += line.length;
    if (waitingAuditBytes > WAITING_AUDIT_MAX_BYTES) {
      waitingAuditCapped = true;
      log('[waiting-audit] byte cap reached — dropping further events');
    }
  } catch { /* best-effort */ }
}
// Human-readable tail of what's on the session's screen right now (ANSI-stripped,
// space runs collapsed, newlines kept — JSON.stringify escapes them).
function auditScreenTail(e, n) {
  try {
    return stripEscapeSequences((e.scrollback || []).join('').slice(-8192))
      .replace(/[ \t]+/g, ' ')
      .slice(-n);
  } catch { return null; }
}
// Classify each BEL in a chunk as bare (a real terminal bell) or an OSC string
// terminator (e.g. a title update `\x1b]0;…\x07`). The production classifier at
// the lastBelTime site counts BOTH as bells — this taxonomy exists to measure how
// often that conflation happens. OSC-open state carries across chunk boundaries
// via e._auditOscOpen (ESC \ = ST also closes it). Returns counts plus the raw
// bytes preceding the last bare BEL for forensics.
function auditClassifyBels(e, data) {
  let bare = 0, osc = 0, ctx = null;
  let oscOpen = !!e._auditOscOpen;
  const re = /\x1b\]|\x1b\\|\x07/g;
  let m;
  while ((m = re.exec(data)) !== null) {
    if (m[0] === '\x1b]') oscOpen = true;
    else if (m[0] === '\x1b\\') oscOpen = false;
    else if (oscOpen) { osc++; oscOpen = false; }
    else { bare++; ctx = data.slice(Math.max(0, m.index - 48), m.index); }
  }
  e._auditOscOpen = oscOpen;
  return { bare, osc, ctx };
}
const STATE_FILE = path.join(DS_DIR, 'state.json');
const DISPLAY_TABS_DIR = path.join(DS_DIR, 'display-tabs');
const SCREENSHOTS_DIR = path.join(DS_DIR, 'screenshots');
// One directory per timelapse run (#667): ~/.deepsteve/timelapse/<runId>/NNNN.{png,json}.
// Deliberately not swept on a timer the way SCREENSHOTS_DIR is — a run is a record
// somebody chose to make, and one silently ageing out would destroy the thing it exists
// to be. DELETE /api/timelapse/runs/:runId is the disposal path.
const TIMELAPSE_DIR = path.join(DS_DIR, 'timelapse');
const SETTINGS_FILE = path.join(DS_DIR, 'settings.json');
const CONTEXTS_FILE = path.join(DS_DIR, 'contexts.json');
// Per-context uploaded icon images (#579): <contextId>.png / .svg. Emoji icons still
// ride contexts.json (the `icon` string); an uploaded image sets `iconImage` (the ext).
const ICONS_DIR = path.join(DS_DIR, 'icons');
// Ring buffer of the last N session configs, for cross-browser restore (#533).
const RECENT_SESSIONS_FILE = path.join(DS_DIR, 'recent-sessions.json');
// Legacy scheduled-tasks "project groups" file (#521). Superseded by contexts.json
// (#526); read once on first load to migrate, then left in place untouched.
const LEGACY_GROUPS_FILE = path.join(DS_DIR, 'project-groups.json');
const RESTARTING_FLAG = path.join(DS_DIR, '.restarting');
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
// Client error beacon, HTTP fallback (#675). Also above the gate, and for the same reason: it
// exists to report the state where our cookie is broken, so it cannot require the cookie. The
// beacon's primary transport is the live-reload WebSocket, but a page can be in exactly the state
// worth reporting — every fetch 401ing — with no socket at all (a mod iframe holds none), and then
// the failure leaves no client-side trace whatsoever. Its guards are Host (already applied above)
// plus a MANDATORY allowlisted Origin, the body caps in appendClientLogEntries, and its own
// limiter, so an unauthenticated caller can neither reach it from another origin nor flood the log.
//
// It must stay an app.post (an app.use would exempt every method, not just POST), the Origin check
// must stay ahead of the body parser, and the handler must never call next(): its route-local
// express.json marks req._body, and the global parser below skips a request already flagged, so a
// fall-through would leave a later route parsing under this route's 8kb limit instead of its own.
// test/unit/auth-exempt-routes.test.js pins all three.
const BEACON_WINDOW_MS = 10_000;
const BEACON_MAX_REQUESTS = 20;
let beaconWindowStart = 0, beaconRequests = 0, beaconDropped = 0;
app.post('/api/client-log', security.requireAllowedOrigin, express.json({ limit: '8kb' }), (req, res) => {
  const now = Date.now();
  if (now - beaconWindowStart > BEACON_WINDOW_MS) {
    if (beaconDropped > 0) log(`[client] ${beaconDropped} beacon request(s) dropped — rate limit`);
    beaconWindowStart = now; beaconRequests = 0; beaconDropped = 0;
  }
  // Always 204: a beacon that learns it was throttled has nothing useful to do about it, and a
  // page retrying a rejected beacon is the flood we are trying to avoid.
  if (++beaconRequests > BEACON_MAX_REQUESTS) { beaconDropped++; return res.status(204).end(); }
  const body = req.body || {};
  appendClientLogEntries(body.windowId, body.entries);
  res.status(204).end();
}, (err, req, res, _next) => {
  // Route-local error handler. express.json calls next(err) on an oversized or malformed body, and
  // this app registers no error middleware — so it would reach finalhandler, which serves the stack
  // trace outside NODE_ENV=production. The installed service sets that; a daemon started as plain
  // `node server.js` does not, which is every dev and agent run.
  res.status(err && err.type === 'entity.too.large' ? 413 : 400).type('text/plain').send('Bad beacon');
});
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
  // Same reason for timelapse frames (#667) — each one carries a base64 PNG.
  if (req.path.startsWith('/api/timelapse')) return next();
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

// `type: () => true`, not the '*/*' it reads like: '*/*' is matched by type-is
// against the Content-Type *header*, and a drop of a file macOS has no MIME type
// for (extensionless, .jsonl, .tsx, …) gives File.type === '', so the browser
// sends the PUT with no Content-Type at all. type-is then answers no, body-parser
// skips the request, req.body stays the `{}` express seeded it with, and the
// write dies on "The \"data\" argument must be ... Buffer". A function type opts
// out of header sniffing entirely, which is what a raw byte sink wants.
app.put('/api/upload/:filename', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
  const { filename } = req.params;

  const safe = path.basename(filename);
  if (safe !== filename) return res.status(400).json({ error: 'Invalid filename' });
  if (safe.length > 255) return res.status(400).json({ error: 'Filename too long' });
  if (/[\x00-\x1f]/.test(safe)) return res.status(400).json({ error: 'Invalid characters in filename' });
  // A bodyless PUT still reaches here (body-parser leaves `{}`); say so plainly
  // rather than letting fs.writeFileSync raise a 500 about argument types.
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Missing request body' });

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

// The agent integrations deepsteve ships, and how far each one actually goes (#622).
// `tier` is the support promise, and it is DATA — not an "(experimental)" suffix baked
// into `name`. That suffix used to be hardcoded here AND again in the Settings HTML,
// which is exactly how Hermes ended up called experimental in the README and nowhere
// else. Clients render the suffix from `tier` (see agentLabel() in public/js/app.js):
//   supported    — deepsteve MCP + skills, real readiness signal, covered by tests;
//                  a gap is a bug
//   experimental — spawns and resumes, but no MCP, no skills, no readiness signal, and
//                  only negative test coverage; a gap is the documented state
// docs/agents.md is the per-agent breakdown and test/unit/agents-doc.test.js fails the
// build when this table and that doc disagree — so a new agent can't ship undocumented.
// `binarySetting` names the settings key holding an overridable binary path; agents
// without one are probed by their literal id (claude is never probed — see /api/agents).
const AGENT_CATALOG = [
  { id: 'claude',   name: 'Claude Code', shortName: 'CC', tier: 'supported' },
  { id: 'codex',    name: 'Codex',       shortName: 'CX', tier: 'supported' },
  { id: 'hermes',   name: 'Hermes',      shortName: 'H',  tier: 'experimental', binarySetting: 'hermesBinary' },
  { id: 'opencode', name: 'OpenCode',    shortName: 'OC', tier: 'experimental', binarySetting: 'opencodeBinary' },
  { id: 'pi',       name: 'Pi',          shortName: 'Pi', tier: 'experimental', binarySetting: 'piBinary' },
];

const AGENT_TYPES = AGENT_CATALOG.map(a => a.id);

const SETTINGS_SCHEMA = [
  { name: 'shellProfile',               type: 'string',  default: '~/.zshrc' },
  { name: 'maxIssueTitleLength',        type: 'number',  default: 25, clamp: [10, 200] },
  { name: 'wandPlanMode',               type: 'boolean', default: true, broadcast: false },
  // The remembered Autopilot choice for new issue sessions (#651). It used to be a
  // per-browser localStorage flag that only the picker checkbox read, so every other
  // spawn path — MCP start_issue, /api/start-issue, /deepsteve:github-issue, an
  // autonomous agent — started with Autopilot off no matter what the user last chose.
  // Read inside startIssueSession() whenever the caller omits `autopilot`; an explicit
  // argument still wins. Unlike wandPlanMode this IS broadcast: the picker paints its
  // checkbox synchronously, before its own /api/settings fetch resolves, and a change
  // made in one window has to reach the picker in the others.
  { name: 'issueAutopilot',             type: 'boolean', default: false },
  // #668: the workflow stages appended to every issue prompt — orient, ask rather than
  // guess, flag surprises, justify before merging — so a finished issue can be judged
  // from the Workshop inbox instead of by opening its tab. A mod's own enable/disable is
  // per-browser localStorage and never reaches the server, and this decision is made
  // server-side at spawn time, so it needs a real setting (same reason projectModsEnabled
  // and scheduledTasksEnabled exist). Read live inside issueStagesText(), so a Settings
  // change applies with no restart — same rule as issueAutopilot above. Default OFF: it
  // changes what every issue session is asked to do, and stage 4 names `share_result`,
  // which #669 builds.
  { name: 'issueStagesEnabled',         type: 'boolean', default: false },
  { name: 'wandPromptTemplate',         type: 'string',  default: WAND_DEFAULT_TEMPLATE, broadcast: false,
    logValue: v => `(${v.length} chars)` },
  { name: 'cmdTabSwitch',               type: 'boolean', default: false },
  { name: 'cmdTabSwitchHoldMs',         type: 'number',  default: 1000, clamp: [0, Infinity], fallback: 0 },
  { name: 'commandPaletteEnabled',      type: 'boolean', default: true },
  { name: 'hashCommandsEnabled',        type: 'boolean', default: true },
  { name: 'contextViewsEnabled',        type: 'boolean', default: true },
  // Server-authoritative kill switch for Project Mods (#618). A mod's own enable/disable
  // is client-side localStorage and never reaches the server, so the agent-facing write
  // path needs a real setting to fail closed against — same reason scheduledTasksEnabled
  // exists. Read live by mods/project-mods/tools.js off the mutated-in-place settings
  // object, so toggling it takes effect with no restart.
  { name: 'projectModsEnabled',         type: 'boolean', default: true },
  // Timelapse (#667). Server-authoritative because a mod's own toggle is per-browser
  // localStorage and never reaches the daemon — the same reason projectModsEnabled and
  // scheduledTasksEnabled exist. Read live at each route, so it takes effect with no
  // restart; broadcast because the browser owns both the recording circle and the timer,
  // and a change made in one window has to reach the others.
  { name: 'timelapseEnabled',           type: 'boolean', default: true },
  { name: 'timelapseIntervalMinutes',   type: 'number',  default: 5, clamp: [1, 60], round: true },
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
  { name: 'enabledAgents',              type: 'array',   default: [...AGENT_TYPES],
    itemEnum: AGENT_TYPES, nonEmpty: true, broadcast: false,
    sideEffect: (val, s) => { s.defaultAgent = val[0]; },
    logValue: v => v.join(',') },
  { name: 'defaultAgent',               type: 'enum',    default: 'claude', values: AGENT_TYPES, broadcast: false },
  { name: 'hermesBinary',               type: 'string',  default: 'hermes',   fallbackOnEmpty: true, broadcast: false },
  { name: 'opencodeBinary',             type: 'string',  default: 'opencode', fallbackOnEmpty: true, broadcast: false },
  { name: 'piBinary',                   type: 'string',  default: 'pi',       fallbackOnEmpty: true, broadcast: false },
  // Escape hatch for a tmux the pure-fs resolver can't see (#619) — a nix profile,
  // asdf shim or custom --prefix that only a login shell's PATH used to reveal.
  // A bare name is searched for in $PATH + tmux-path.js's FALLBACK_DIRS; a value
  // with a '/' is used verbatim. Applies on daemon restart: the engine probes once,
  // at construction.
  { name: 'tmuxBinary',                 type: 'string',  default: 'tmux',     fallbackOnEmpty: true, broadcast: false },
  // Escape hatch for a socket path the state dir can't host (#625). Two real cases:
  // a $HOME long enough to blow the ~104-byte sun_path limit, and an NFS/SMB home
  // where bind() is unsupported — the latter being a NEW failure mode, since before
  // #625 the socket always lived under /tmp and was therefore always local. Empty
  // means derive it: paths.js's tmuxSocketPath(), i.e. ~/.deepsteve/tmux.sock.
  // Tilde-expanded. Applies on daemon restart: the socket is fixed at engine
  // construction, like tmuxBinary above.
  { name: 'tmuxSocket',                 type: 'string',  default: '',         broadcast: false },
  { name: 'symlinkWorktreeSettings',    type: 'boolean', default: false },
  { name: 'recentSessionsLimit',        type: 'number',  default: 8, clamp: [0, 50], round: true,
    sideEffect: (val, s) => { trimRecentSessions(); } },
  { name: 'scrollbackKB',               type: 'number',  default: SCROLLBACK_DEFAULT_KB, clamp: [1, 10000], round: true },
  // tmux is the default (#620): a node-pty session is a child of server.js and dies
  // with it, so a crash or a restart takes every running agent with it. This one word
  // covers all three cases correctly, because the block right after engine init
  // already downgrades-and-persists when tmux is missing:
  //   fresh install + tmux    → nothing in settings.json overrides it → tmux
  //   fresh install, no tmux  → downgraded to node-pty and saved
  //   existing install        → its explicit saved value wins, until the one-time
  //                             migration offer below flips it
  // The default can't itself consult tmuxEngine — buildDefaults() runs ~180 lines
  // before the engine is constructed. Only the `values` thunk is lazy enough.
  { name: 'engine',                     type: 'enum',    default: 'tmux',
    // Where tmux is REQUIRED (#621, everything but macOS), node-pty is not offered once
    // tmux exists — choosing it there is choosing an unsupported configuration. It stays
    // in the list when tmux is MISSING, because that is what the daemon actually fell
    // back to and the enum has to be able to describe reality.
    //
    // This cannot strand an existing install: settings load is
    // `{...defaults, ...JSON.parse(file)}` with no enum validation, so a saved value
    // absent from this list survives untouched. The thunk only gates POSTs and the
    // Settings dropdown — which on Linux is exactly right: POSTing 'tmux' succeeds,
    // POSTing 'node-pty' is refused.
    values: () => {
      if (!tmuxEngine) return ['node-pty'];
      return TMUX_REQUIRED ? ['tmux'] : ['node-pty', 'tmux'];
    } },
  // One-shot latch for the "you have tmux but you're on node-pty" offer (#620).
  // Broadcast so a second window dismisses its own copy of the modal when the
  // first one answers.
  { name: 'engineMigrationOffered',     type: 'boolean', default: false },
  { name: 'autoUpdateCheckEnabled',     type: 'boolean', default: true },
  { name: 'autoUpdateCheckIntervalHours', type: 'number', default: 6, clamp: [1, 168] },
  { name: 'autoUpdateApply',            type: 'boolean', default: true },
  { name: 'sessionLogEnabled',          type: 'boolean', default: false },
  // Timecard (#666): sample whether a human is working in Deep Steve and append it to
  // ~/.deepsteve/timecard.jsonl. On by default — the issue's framing is "start storing
  // timecard data", the file never leaves this machine, and a timecard that stays empty
  // until you find a checkbox never has anything to show. A mod's own enable/disable is
  // per-browser localStorage and never reaches the server, so the sampler needs a real
  // setting to fail closed against; same reason scheduledTasksEnabled exists. Read live
  // by mods/timecard/tools.js off the mutated-in-place settings object, so toggling it
  // stops and starts sampling with no restart. Broadcast because the browser's presence
  // beacon (public/js/timecard-presence.js) is armed from it.
  { name: 'timecardEnabled',            type: 'boolean', default: true },
  // How often that sample is taken. `custom` rather than `enum` because coerceSetting's
  // enum branch does String(raw) and would store "5" — every reader would then have to
  // remember to Number() it. Rejecting an out-of-set value surfaces it in the POST
  // response's `warnings` instead of silently reinstating the default, the same reason
  // #631 chose custom for terminalRunLingerSeconds. The tick runs at a fixed 1-minute
  // cadence and reads this live, so there is no timer to restart on change.
  { name: 'timecardSampleMinutes',      type: 'custom',  default: 5,
    sanitize: (raw) => {
      const n = Math.round(Number(raw));
      return [1, 5, 15].includes(n) ? n : null;
    } },
  // Waiting-classifier audit (#558 research): logs every waitingForInput decision +
  // periodic samples to ~/.deepsteve/waiting-audit.jsonl. Server-side research
  // instrumentation, default off; read live at each call site (no restart to toggle).
  { name: 'waitingAuditEnabled',        type: 'boolean', default: false, broadcast: false },
  // #607: confirm prompt submission instead of assuming it — wait for the composer
  // to echo the text before sending Enter, then verify and re-send Enter (never the
  // text) if the prompt is still staged. Changes which bytes reach the PTY and when,
  // so it gets an escape hatch. Server-internal, no UI, read live at each call site
  // (same shape as waitingAuditEnabled) so it toggles with no restart. The
  // level-triggered readiness half of #607 is deliberately NOT gated by this —
  // turning that off would restore the deadlock it exists to remove.
  { name: 'promptSubmitVerify',         type: 'boolean', default: true,  broadcast: false },
  // Hold a caffeinate -i power assertion while any session is open (#563).
  // Server-side behavior only, so broadcast:false; macOS only (no-op elsewhere).
  { name: 'preventSleepWhileActive',    type: 'boolean', default: true, broadcast: false },
  { name: 'displayTabAudioIndicator',   type: 'boolean', default: true, broadcast: false },
  { name: 'scheduledTasksEnabled',      type: 'boolean', default: true },
  // Scheduled runs are unattended, so their tab opens without stealing focus (#600).
  // Turn off to get the old behavior (the new tab becomes active as it opens).
  { name: 'scheduledTasksOpenInBackground', type: 'boolean', default: true },
  // #604: system-level fallback model / thinking level for scheduled runs that don't
  // pin their own (#592). '' = inherit Claude Code's own default, i.e. pre-#604
  // behavior. Sanitized here through the same validators the argv boundary uses, so
  // an invalid value is rejected at POST time instead of silently no-op'ing at fire
  // time. `values` must be the thunk form — EFFORT_LEVELS is declared below this
  // array, so an eager `values: [...]` would hit the TDZ at module load.
  // The sideEffect re-pushes the scheduled-tasks payload so an open automations panel
  // relabels its "Default" options (which name the resolved default) right away.
  { name: 'scheduledDefaultModel',      type: 'custom',  default: '',
    sanitize: (raw) => {
      if (typeof raw !== 'string') return null;
      const v = raw.trim();
      return v ? validateModel(v) : '';
    },
    sideEffect: () => broadcast({ type: 'scheduled-tasks' }) },
  { name: 'scheduledDefaultEffort',     type: 'enum',    default: '', values: () => ['', ...EFFORT_LEVELS],
    sideEffect: () => broadcast({ type: 'scheduled-tasks' }) },
  // How long closed-session tombstones survive in state.json before the retention
  // sweep prunes them (#561). Server-internal — no client UI reads it.
  { name: 'closedSessionRetentionDays', type: 'number',  default: 30, clamp: [1, 365], round: true, broadcast: false },
  // #627: minutes to wait after a successful merge_worktree before the daemon closes
  // the calling worktree session itself, so a finished merge stops depending on the
  // agent remembering its last step — it forgot 30/30 times in #609, and again after
  // the prompt had been hardened as far as prose goes. 0 turns it off entirely.
  //
  // `custom` rather than `number` because 0 has to be representable: coerceSetting's
  // number branch does `if (!n) n = fallback ?? default`, so a POSTed 0 is falsy and
  // silently becomes the default — and worse, a garbage value would silently DISABLE
  // the safety net. Rejecting at POST time surfaces it in the response `warnings`
  // instead, which is the same reason #604 chose `custom` for scheduledDefaultModel.
  // Server-internal (no client UI reads it) and read live at arm time, so a change
  // applies with no restart.
  { name: 'mergeAutoCloseMinutes',      type: 'custom',  default: 2, broadcast: false,
    sanitize: (raw) => {
      const n = Math.round(Number(raw));
      return Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
    } },
  // #631: seconds a finished `run_in_terminal` tab lingers before the daemon closes it.
  // The linger is the window in which a user watching the run can claim the tab —
  // typing in it cancels the close, exactly as it does after a merge. 0 = close the
  // moment the command finishes. `custom` for the same reason as the entry above: a
  // POSTed 0 must mean 0, and a garbage value must be rejected rather than silently
  // reinstating the leak this feature exists to close.
  { name: 'terminalRunLingerSeconds',   type: 'custom',  default: 20, broadcast: false,
    sanitize: (raw) => {
      const n = Math.round(Number(raw));
      return Number.isFinite(n) && n >= 0 && n <= 600 ? n : null;
    } },
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
    logValue: v => v.map(r => r.name).join(',') || '(none)',
    sideEffect: (val) => provisionAllProfileSkills(val) }, // #543: link skills into new profiles immediately
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
      let warning;
      if (entry.itemEnum) {
        const dropped = raw.filter(x => !entry.itemEnum.includes(x));
        arr = raw.filter(x => entry.itemEnum.includes(x));
        // A stale settings.json (or an external read-modify-write POST) can carry
        // items no longer in the enum; they're pruned, but silently losing them
        // hid real config from the caller (#519) — report what was dropped.
        if (dropped.length) warning = `${entry.name}: dropped unknown item(s): ${dropped.join(', ')}`;
      }
      if (entry.nonEmpty && arr.length === 0) return { ok: false };
      return { ok: true, value: arr, warning };
    }
    case 'custom': {
      const v = entry.sanitize(raw);
      if (v === null || v === undefined) return { ok: false };
      return { ok: true, value: v };
    }
  }
  return { ok: false };
}

// Returns an array of human-readable warnings for fields that were rejected or
// had items pruned, so a POST caller can see what didn't apply as sent (#519).
function applySettingsFromBody(body, s) {
  const warnings = [];
  for (const entry of SETTINGS_SCHEMA) {
    if (!(entry.name in body)) continue;
    const result = coerceSetting(entry, body[entry.name]);
    if (!result.ok) {
      warnings.push(`${entry.name}: rejected invalid value`);
      continue;
    }
    if (result.warning) warnings.push(result.warning);
    s[entry.name] = result.value;
    if (entry.sideEffect) entry.sideEffect(result.value, s);
    const display = entry.logValue ? entry.logValue(result.value) : result.value;
    log(`Settings updated: ${entry.name}=${display}`);
  }
  for (const w of warnings) log(`Settings warning: ${w}`);
  return warnings;
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
// The shell every session runs under (#621). Resolved ONCE at module scope: it is fs
// work, and a stable value is what lets the log line, the spawn and the tmux unwrap
// all be talking about the same shell. $SHELL first, then the passwd entry, then
// zsh/bash/sh — see resolveLoginShell. On macOS a LaunchAgent's environment carries
// SHELL=/bin/zsh, so this is the same shell as before, just named absolutely.
const LOGIN_SHELL = resolveLoginShell();

const ptyEngine = new NodePtyEngine();
ptyEngine.onWrite = tapPtyWrite;
log('Engine: node-pty (always enabled)');
log(`Shell: sessions run under ${LOGIN_SHELL.path}${LOGIN_SHELL.loginFlag ? ` ${LOGIN_SHELL.loginFlag}` : ''}`);

let tmuxEngine = null;
let tmuxUnavailableReason = null;

// tmux is a DECLARED DEPENDENCY off macOS (#620/#621), not merely the default.
//
// The trade differs by platform. On macOS node-pty is a supported fallback: the daemon
// is restarted when the user chooses to, and losing sessions is an annoyance. On a
// Linux box — which is the whole point of running deepsteve somewhere that isn't the
// laptop — systemd restarts the daemon on every crash and every unattended upgrade, so
// "sessions die with the daemon" means they die at times nobody chose.
//
// install.sh therefore REFUSES to install on Linux without tmux, where a human is
// definitely watching a terminal. The daemon, by contrast, still boots: refusing to
// start on a headless machine means the UI that would explain why never comes up, and
// with Restart=always/RestartSec=5 the failure is an invisible crash loop that needs
// journalctl to even see. Boot, degrade, and say so loudly instead.
const TMUX_REQUIRED = process.platform !== 'darwin';

// deepsteve's OWN tmux server (#625). Everything the engine runs carries
// `-S TMUX_SOCKET`, so a daemon with an isolated HOME has an isolated tmux — which is
// what finally makes "a test can never reach the developer's sessions" a property of
// the architecture rather than of a convention every suite has to re-implement.
//
// The mkdir is required and cannot be assumed: with -S tmux only bind()s (it creates a
// directory only for its own default socket), and ~/.deepsteve is otherwise created
// lazily by saveSettings()/writeStateFile(), neither of which is guaranteed to have run
// by the time the engine is constructed on a first boot.
const TMUX_SOCKET = expandTilde(settings.tmuxSocket) || tmuxSocketPath();
try { fs.mkdirSync(path.dirname(TMUX_SOCKET), { recursive: true }); } catch {}

// The user's OWN tmux — tmux's default per-UID socket. Reached by exactly two
// features, both of which are about sessions deepsteve did NOT create: the "Attach
// tmux session" submenu (GET /api/tmux-sessions) and the tmux-attach tab it opens.
// A separate, named engine instance rather than a flag on those calls, so that access
// is opt-in and greppable instead of ambient — which is the whole shape of #625.
// Lazy + memoized: a daemon that never opens that menu never probes tmux twice.
let _userTmux;
function userTmux() {
  if (_userTmux === undefined) {
    _userTmux = tmuxEngine ? new TmuxEngine({ binary: settings.tmuxBinary, socket: null }) : null;
  }
  return _userTmux;
}

{
  const tmuxCheck = new TmuxEngine({ binary: settings.tmuxBinary, socket: TMUX_SOCKET });
  if (tmuxCheck.available) {
    tmuxEngine = tmuxCheck;
    log(`Engine: tmux v${tmuxEngine.version} (available) at ${tmuxEngine.tmuxPath}`);
    // Name the socket and its size at boot. The one failure this pre-empts —
    // "tmux is installed and completely unusable" from a socket path over sun_path —
    // used to be diagnosable only by reading spawnSession's fallback message after a
    // session had already degraded. ~104 bytes on macOS, 108 on Linux; warn early.
    const sockBytes = Buffer.byteLength(TMUX_SOCKET);
    log(`Engine: tmux socket ${TMUX_SOCKET} (${sockBytes} bytes; sun_path limit ~${SUN_PATH_LIMIT})`);
    if (sockBytes > SUN_PATH_LIMIT - 12) {
      log(`Engine: WARNING — that socket path is close to the ${SUN_PATH_LIMIT}-byte limit. ` +
          'If tmux cannot create sessions, set `tmuxSocket` in ~/.deepsteve/settings.json ' +
          'to a shorter path and restart.');
    }
    // Our attach PTY died but tmux still had the session, so the engine rebuilt the
    // pipe instead of reporting a death that didn't happen (#626). Rare and always
    // worth knowing about: it is the difference between a lost agent and a hiccup.
    tmuxEngine.on('reattach', (id, attempt) =>
      log(`tmux: attach PTY for ${id} died but its tmux session is alive — re-attached (attempt ${attempt})`));
    tmuxEngine.on('reattach-failed', (id, attempt, e) =>
      log(`tmux: attach PTY for ${id} died and re-attach ${attempt} failed (${e.message}) — reporting the session as exited`));
    tmuxEngine.onWrite = tapPtyWrite;
  } else {
    // Say WHERE we looked (#619). A bare "tmux not available" is the failure shape
    // that hid the zsh dependency for as long as it did, and tmux is on its way to
    // being required — an unavailable engine has to be diagnosable from the log.
    tmuxUnavailableReason = tmuxCheck.unavailableReason;
    log(`Engine: tmux not available — ${tmuxUnavailableReason}`);
    if (TMUX_REQUIRED) {
      log('Engine: tmux is REQUIRED on this platform. Install it (apt/dnf/pacman install tmux) ' +
          'and restart the daemon. Until then every session dies whenever the daemon does — ' +
          'and systemd restarts the daemon on every crash and every upgrade.');
    }
    // Also the fresh-install path since #620 made tmux the schema default: with no
    // tmux there is nothing to default to, so persist the downgrade. The UI says so
    // out loud rather than leaving this log line as the only trace — a node-pty
    // install is a perishable install, and the user should know they're on it.
    if (settings.engine === 'tmux') {
      settings.engine = 'node-pty';
      saveSettings();
      log('Engine: falling back to node-pty — sessions will NOT survive a restart');
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
  return expandTilde(settings.shellProfile || '~/.zshrc');
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
  return expandTilde(p.configDir);
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
const THEMES_DIR = path.join(DS_DIR, 'themes');
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
 * @param {string} agentType - 'claude', 'codex', 'hermes', 'opencode', or 'pi'
 * @param {string[]} args - Agent CLI arguments
 * @param {string} cwd - Working directory
 * @param {{ cols?: number, rows?: number, env?: object }} opts
 */
const CODEX_SHARED_HOME = path.join(os.homedir(), '.codex');
const CODEX_SESSION_ROOT = path.join(DS_DIR, 'codex-sessions');
const CODEX_SHARED_ENTRIES = [
  'auth.json',
  'config.toml',
  'requirements.toml',
  'AGENTS.md',
  'agents',
  'prompts',
  'rules',
  'skills',
  'plugins',
  'marketplaces',
  'packages',
  'hooks',
  'memories',
  'themes',
  'pets',
];

// Codex generates its own session UUID and only supports deterministic recovery
// after startup via `codex resume <id>` or `codex resume --last`. Give every
// DeepSteve tab an isolated CODEX_HOME so --last can never adopt a sibling tab's
// conversation, even when several Codex tabs share the same cwd. Configuration,
// authentication, skills, and plugins remain linked to the user's normal Codex
// home; runtime state (sessions/history/sqlite/logs) stays private to the tab.
function ensureCodexSessionHome(homeId) {
  const key = String(homeId || '');
  if (!/^[0-9a-f]{8}$/.test(key)) return null;
  const sessionHome = path.join(CODEX_SESSION_ROOT, key);
  try {
    fs.mkdirSync(sessionHome, { recursive: true, mode: 0o700 });
    for (const name of CODEX_SHARED_ENTRIES) {
      const source = path.join(CODEX_SHARED_HOME, name);
      const target = path.join(sessionHome, name);
      if (!fs.existsSync(source)) continue;
      try {
        fs.lstatSync(target);
        continue;
      } catch (err) {
        if (err.code !== 'ENOENT') continue;
      }
      fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? 'dir' : 'file');
    }
  } catch (err) {
    log(`Failed to provision Codex session home ${sessionHome}: ${err.message}`);
    return null;
  }
  return sessionHome;
}

function codexSessionHomeHasTranscript(homeId) {
  const key = String(homeId || '');
  if (!/^[0-9a-f]{8}$/.test(key)) return false;
  const pending = [path.join(CODEX_SESSION_ROOT, key, 'sessions')];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return true;
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
    }
  }
  return false;
}

function sessionEnv(id, { name, worktree, windowId, cwd, agentType, configDir, codexHomeId } = {}) {
  // Ensure this profile's config dir sees deepsteve skills (#543). Cheap + idempotent
  // (an lstat that early-returns when already correct); self-heals a profile whose config
  // dir didn't exist when it was added. Guarded so plain sessions do nothing.
  if (configDir) provisionProfileSkills(configDir);
  // DEEPSTEVE_CWD is the agent's actual working directory. For agents with native
  // --worktree support (Claude), the PTY is spawned in the main repo but the agent
  // operates in .claude/worktrees/<name>, so resolve to that subdir. The worktree dir
  // may not exist yet at spawn time, but the path is deterministic and the agent
  // creates it immediately. For other agents the spawn cwd is already the worktree.
  let agentCwd = cwd || '';
  if (worktree && agentCwd && getAgentConfig(agentType).supportsWorktree) {
    agentCwd = getWorktreePath(agentCwd, worktree);
  }
  const codexHome = agentType === 'codex' ? ensureCodexSessionHome(codexHomeId || id) : null;
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
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
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
  // A service-managed daemon has no locale at all — neither the launchd plist nor
  // the systemd unit declares one — so every agent ran under C/POSIX. Fill that in
  // here, at the one place both engines pass through, rather than in either engine:
  // the two must hand the agent the same environment or a tmux session stops being
  // a faithful replica of a node-pty one, which is the whole of #624. terminalEnv()
  // yields nothing when the user already set a locale, and extraEnv still wins.
  Object.assign(env, terminalEnv({ env }));
  return extraEnv ? { ...env, ...extraEnv } : env;
}

// Why tmux couldn't create a session at runtime, or null. Distinct from
// tmuxUnavailableReason, which is about the binary not being *found*.
let tmuxRuntimeFailure = null;

/**
 * Spawn a session, degrading from tmux to node-pty rather than failing outright.
 *
 * `tmux -V` succeeding at probe time does not prove `new-session` will work. The
 * one that bit us is a socket path over the ~104-byte `sun_path` limit ("File
 * name too long") from a long $TMPDIR; the tmux server refusing to start and
 * resource limits get here too. That used to be nearly unreachable because almost
 * nobody ran tmux — now it is the default, so the same throw comes out of the raw
 * WS 'connection' handler as an **uncaught exception and kills the daemon**,
 * taking every other session with it.
 *
 * Two rules, then: one session's spawn failure must never end the process, and a
 * working perishable tab beats a dead app. The failure is recorded so the UI shows
 * the same "you are on the fallback" warning it shows when tmux is missing —
 * degrading *silently* is the exact thing this issue exists to stop.
 *
 * Returns the engine that actually spawned, so callers can record the truth
 * instead of the engine they asked for.
 */
function spawnSession(eng, id, agentType, args, cwd, { cols = 120, rows = 40, env: extraEnv, runCommand, runNonce } = {}) {
  // #632: refuse a cwd that no longer exists, rather than letting tmux relocate the
  // pane to $HOME and say nothing. Deliberately ABOVE the try/catch below — that
  // catch degrades tmux → node-pty, and a missing directory must never degrade:
  // node-pty's pty.spawn() would return successfully and its child would _exit(1),
  // which is the silent-vanish half of the same bug.
  //
  // It validates the SPAWN cwd — the value handed to eng.spawn — and nothing else.
  // Not DEEPSTEVE_CWD, not getWorktreePath(): a Claude session with --worktree is
  // spawned in the repo root and creates .claude/worktrees/<name> itself, so the
  // agent's own cwd legitimately does not exist yet at this point (see sessionEnv).
  assertSpawnCwd(cwd);
  const env = childBaseEnv(extraEnv);
  const opts = { cols, rows, env, stripEnv: DAEMON_INTERNAL_ENV_KEYS };

  // A session IS the user's interactive shell, so this is one of only two places a
  // login shell is load-bearing rather than a PATH workaround (#621). LOGIN_SHELL is
  // /bin/zsh on macOS — the same shell as before, now as an absolute path.
  const loginArgs = LOGIN_SHELL.loginFlag ? [LOGIN_SHELL.loginFlag] : [];

  let shellArgs;
  if (agentType === 'terminal') {
    if (runCommand) {
      // A one-shot run (#631): the pane runs exactly this command, prints a marker
      // carrying its exit status, then execs a login shell so the tab stays claimable.
      //
      // Deliberately NO opts.shellCommand, for the same #630 reason spelled out in the
      // agent branch below: the engine execs [cmd, ...args] verbatim, so the `-l` above
      // reaches the pane. That matters more here than anywhere — a run only replaces a
      // hand-opened terminal tab if it has the same PATH one does, and "`gh` works in a
      // terminal tab but not in my session" is half of why agents open those tabs.
      shellArgs = [...loginArgs, '-c', wrapRunCommand(runCommand, {
        nonce: runNonce, shellPath: LOGIN_SHELL.path, loginFlag: LOGIN_SHELL.loginFlag,
      })];
    } else {
      shellArgs = loginArgs;
      // The one thing we still have to state to the engine: run no command, so tmux
      // forks `default-shell` as a LOGIN shell of its own — which is what node-pty
      // gets from the bare `-l` above. NodePtyEngine destructures only
      // {cols, rows, env} and ignores the option. Contract: engines/tmux.js.
      opts.shellCommand = null;
    }
  } else {
    const bin = agentType === 'claude' ? 'claude'
      : agentType === 'codex' ? 'codex'
      : agentType === 'hermes' ? (settings.hermesBinary || 'hermes')
      : agentType === 'opencode' ? (settings.opencodeBinary || 'opencode')
      : agentType === 'pi' ? (settings.piBinary || 'pi')
      : 'claude';
    const quoted = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    shellArgs = [...loginArgs, '-c', `${bin} ${quoted}`];
    // Deliberately NO opts.shellCommand (#630): the tmux engine now execs
    // [cmd, ...args] verbatim, so the login flag above reaches the pane. Handing it
    // the inner command instead — #621's way of stopping a shell nesting inside a
    // shell — dropped the `-l`, and with it ~/.zprofile, and with that
    // /opt/homebrew/bin, so `gh` was not on any agent's PATH under the default engine.
  }

  try {
    eng.spawn(id, LOGIN_SHELL.path, shellArgs, cwd, opts);
    return eng;
  } catch (e) {
    if (eng !== tmuxEngine || !tmuxEngine) throw e; // node-pty failing has no fallback
    tmuxRuntimeFailure = e.message;
    log(`Engine: tmux could not create a session for ${id}: ${e.message}`);
    log('Engine: falling back to node-pty for this session — it will NOT survive a restart');
    ptyEngine.spawn(id, LOGIN_SHELL.path, shellArgs, cwd, opts);
    return ptyEngine;
  }
}

// Agent capabilities and argument mapping
const AGENT_CONFIGS = {
  claude: {
    supportsWorktree: true,
    supportsSessionId: true,
    supportsSessionWatch: true,
    // #656: a multi-kilobyte prompt may be delivered as a PASTE rather than as
    // keystrokes. Asserts that this agent's TUI handles a pasted block whole —
    // Claude Code collapses one to `[Pasted text #N +M lines]` and never reads an
    // interior newline as Enter. Deliberately its own flag rather than reusing
    // screenMarkers, which happens to be claude-only today but means something else.
    supportsPaste: true,
    emitsBel: true,              // still used by killShell's BEL exit-watch + the #558 audit
    screenMarkers: CLAUDE_SCREEN_MARKERS, // #568: drives the screen-state waiting detector
    exitMethod: 'exit-cmd', // uses /exit
    initialPromptDelay: 0,
    sessionIdFlag: '--session-id',
    planModeFlag: '--permission-mode',
    planModeValue: 'plan',
    modelFlag: '--model',        // #592: alias ('opus'/'sonnet'/…) or full id ('claude-fable-5')
    effortFlag: '--effort',      // #592: low | medium | high | xhigh | max
    allowedToolsFlag: '--allowedTools',  // #612: additive permission allowlist, comma-separated
    resumeFlag: '--resume',
    resumeDefault: '-c'
  },
  codex: {
    supportsWorktree: false,
    supportsSessionId: false,    // Codex generates its UUID; per-tab CODEX_HOME isolates --last
    supportsSessionWatch: false,
    emitsBel: false,
    exitMethod: 'sigterm',       // Codex persists turns continuously; SIGTERM is safe during shutdown
    initialPromptDelay: 0,       // readiness comes from Codex's rendered MCP lifecycle, never a timer
    codexReadiness: true,
    resumeFlag: 'resume',
    resumeDefault: '--last'
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

function mcpConfigArgs(agentType, shellId) {
  if (!shellId) return [];
  if (agentType === 'codex') {
    const url = `http://localhost:${PORT}/mcp?shellId=${shellId}`;
    return [
      '-c', `mcp_servers.deepsteve.url=${JSON.stringify(url)}`,
      '-c', 'mcp_servers.deepsteve.bearer_token_env_var="DEEPSTEVE_API_TOKEN"',
    ];
  }
  if (agentType !== 'claude') return [];
  // The MCP config carries the auth bearer token (#536). Write it to a per-shell 0600 file and pass
  // the PATH (claude's --mcp-config accepts file paths) — never inline JSON in argv, which `ps`
  // exposes to every other local user.
  const dir = path.join(DS_DIR, 'mcp-configs');
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
  const dir = path.join(DS_DIR, 'pi-sessions', shellId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return ['--session-dir', dir];
}

// #592: model / effort selection. Both are free-form strings on the wire (Claude
// gains model aliases and ids over time, so an enum here would rot), sanitized to
// a conservative charset before they reach argv. Anything unrecognized becomes
// null = "inherit Claude Code's own default", which is the pre-#592 behavior.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function validateModel(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v)) return null;
  return v;
}

function validateEffort(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return EFFORT_LEVELS.includes(v) ? v : null;
}

const MAX_ALLOWED_TOOLS = 8;  // #612: ceiling on one session's --allowedTools list

// A single tool name for --allowedTools. Covers MCP ids (mcp__deepsteve__foo) and
// plain built-ins (Bash, Edit). Deliberately NOT the `Bash(git *)` specifier form —
// nothing here needs it, and parens/spaces/globs are exactly what we don't want
// reaching argv from a persisted file.
function validateToolName(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) return null;
  return v;
}

function getSpawnArgs(agentType, { sessionId, planMode, worktree, shellId, model, effort, allowedTools }) {
  const config = getAgentConfig(agentType);
  const args = [];

  if (config.supportsSessionId && sessionId) {
    args.push(config.sessionIdFlag, sessionId);
  }

  if (planMode && config.planModeFlag) {
    args.push(config.planModeFlag, config.planModeValue);
  }

  args.push(...modelArgs(config, model, effort));
  args.push(...allowedToolsArgs(config, allowedTools));

  if (worktree && config.supportsWorktree) {
    args.push('--worktree', worktree);
  }

  args.push(...mcpConfigArgs(agentType, shellId));
  args.push(...piSessionDirArgs(agentType, shellId));

  return args;
}

// #592: model/effort flags for agents whose config declares them (claude only today).
// Values are re-sanitized here rather than trusted from the caller, so a hand-edited
// state.json or scheduled-tasks.json can never inject argv.
function modelArgs(config, model, effort) {
  const args = [];
  const m = config.modelFlag ? validateModel(model) : null;
  if (m) args.push(config.modelFlag, m);
  const e = config.effortFlag ? validateEffort(effort) : null;
  if (e) args.push(config.effortFlag, e);
  return args;
}

// #612: pre-permit specific tools for this session. Same rule as modelArgs — the
// caller is not trusted, every name is re-validated here at the argv boundary, and
// the list is capped so a hand-edited state.json can't blow up the command line.
// claude's --allowedTools is variadic ("<tools...>"), so we emit ONE comma-joined
// value rather than N argv items: a variadic parser must not be able to swallow the
// --worktree / --mcp-config that follow.
function allowedToolsArgs(config, tools) {
  if (!config.allowedToolsFlag || !Array.isArray(tools)) return [];
  const clean = [...new Set(tools.map(validateToolName).filter(Boolean))].slice(0, MAX_ALLOWED_TOOLS);
  return clean.length ? [config.allowedToolsFlag, clean.join(',')] : [];
}

function getResumeArgs(agentType, { sessionId, planMode, worktree, shellId, model, effort, allowedTools }) {
  const config = getAgentConfig(agentType);
  const args = [];

  if (agentType === 'codex') {
    args.push('resume');
    if (sessionId) args.push(sessionId);
    else args.push('--last');
    args.push(...mcpConfigArgs(agentType, shellId));
    return args;
  }

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

  // Same reason for --model/--effort (#592): a scheduled run pinned to a cheap
  // model must not silently revert to the default after a daemon restart.
  args.push(...modelArgs(config, model, effort));
  // And for --allowedTools (#612): a restart-resumed scheduled run that lost its
  // pre-permitted self-report tools would wedge on a permission prompt with nobody
  // there to answer — the exact failure the flag exists to prevent.
  args.push(...allowedToolsArgs(config, allowedTools));

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
  // Use the same structure as Claude Code. Delegated to worktree-status.js (#689) so
  // the convention has ONE definition: that module answers "what is already in this
  // worktree", which is worthless if its idea of where a worktree lives can drift
  // from the code that creates one.
  return worktreePath(cwd, name);
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
  // The local is `wtPath`, not `worktreePath`: since #689 that name belongs to the
  // worktree-status.js helper getWorktreePath delegates to, and shadowing it here
  // would make the line below read as a call to itself.
  const wtPath = getWorktreePath(cwd, name);
  if (fs.existsSync(wtPath)) {
    symlinkWorktreeClaudeSettings(cwd, wtPath);
    return wtPath;
  }
  try {
    log(`Creating git worktree: ${name} in ${cwd}`);
    // argv, no shell (#621): a worktree path containing a quote or a $ used to be
    // re-interpreted by zsh on its way through the command string.
    runBinary('git', ['worktree', 'add', wtPath], { cwd, encoding: 'utf8', timeout: 30000 });
    symlinkWorktreeClaudeSettings(cwd, wtPath);
    return wtPath;
  } catch (e) {
    log(`Failed to create worktree ${wtPath}: ${e.message}`);
    // If it fails, maybe the branch already exists or it's not a git repo.
    // We attempt to return the path anyway if it was created, or fallback.
    const result = fs.existsSync(wtPath) ? wtPath : cwd;
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
// How much of a transcript head to scan for a parent-session reference. Both the
// fs.watch fork detector and the fork-time tip resolver (#455) use this. Larger
// than the original 32KB because on a long conversation the parent id can sit past
// byte 32768 (a forked file embeds the parent id in an early file-history-snapshot
// blob, but its exact offset grows with the copied history).
const FORK_HEAD_READ_BYTES = 128 * 1024;

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

/**
 * A session's Claude Code transcript, or null when it cannot have one.
 *
 * The ONE derivation of this path (#672). `entry` is anything carrying
 * { claudeSessionId, cwd, worktree, configDir } — a live shell, a savedState
 * record, or a recent-sessions row.
 *
 * Pass `entry.cwd` VERBATIM. claudeProjectDir() does its own worktree join
 * (above), so handing it sessionPaths(entry).cwd — which for a native-worktree
 * agent is already the worktree path — produces
 * `<repo>/.claude/worktrees/x/.claude/worktrees/x` and silently finds nothing.
 * That is easy to write by accident because /api/shells/:id/info, the obvious
 * template for a per-session route, destructures sessionPaths() on its first line.
 */
function transcriptPath(entry) {
  if (!entry || !entry.claudeSessionId || !entry.cwd) return null;
  return path.join(
    claudeProjectDir(entry.cwd, entry.worktree, entry.configDir),
    `${entry.claudeSessionId}.jsonl`);
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
    const file = transcriptPath(entry);
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
        const head = fs.readFileSync(newFile, 'utf8').slice(0, FORK_HEAD_READ_BYTES);
        if (!head.includes(e.claudeSessionId)) return;
        adoptClaudeSession(shellId, sessionId, 'fs-watch');
      } catch (err) {
        log(`Session ${shellId} fork check failed for ${filename}: ${err.message}, retrying in 200ms`);
        setTimeout(() => {
          try {
            const e2 = shells.get(shellId);
            if (!e2 || sessionId === e2.claudeSessionId) return;
            const head = fs.readFileSync(path.join(projectDir, filename), 'utf8').slice(0, FORK_HEAD_READ_BYTES);
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

// Resolve a fork parent's LIVE transcript tip before forking (#455). The in-memory
// `claudeSessionId` is only advanced mid-conversation by the fs.watch detector, which
// silently misses rotations (dropped/coalesced macOS events, an A→B→C chain break, a
// parent ref past the head window, or an event not yet processed at the fork instant).
// `claude --resume <stale> --fork-session` then forks an earlier checkpoint. This does the
// filesystem I/O (readdir/stat/head-read) and delegates the chaining decision to the pure,
// unit-tested resolveForkTip() in ./fork-resolve, then funnels any advance through
// adoptClaudeSession (so the in-memory value + state.json are corrected and the #497
// ownership invariant is preserved). NEVER throws — on any error, a missing transcript, no
// claudeSessionId, or a non-claude agent it returns the input id, i.e. exactly today's
// behavior. Only meaningful for claude (transcript-backed) sessions.
function resolveForkParentSession(parentShellId) {
  const e = shells.get(parentShellId);
  if (!e || !e.claudeSessionId) return e ? e.claudeSessionId : null;
  if (!getAgentConfig(e.agentType).supportsSessionWatch) return e.claudeSessionId;
  const original = e.claudeSessionId;
  try {
    const dir = claudeProjectDir(e.cwd, e.worktree, e.configDir); // same call the watcher uses
    const files = new Map(); // id -> absolute path
    const mtimeOf = new Map(); // id -> mtimeMs
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (!UUID_RE.test(id)) continue;
      const file = path.join(dir, f);
      try { mtimeOf.set(id, fs.statSync(file).mtimeMs); files.set(id, file); } catch {}
    }
    const headCache = new Map(); // id -> head string (each file read at most once)
    const readHead = (id) => {
      if (headCache.has(id)) return headCache.get(id);
      let head = '';
      try {
        const buf = Buffer.alloc(FORK_HEAD_READ_BYTES);
        const fd = fs.openSync(files.get(id), 'r');
        try { head = buf.slice(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8'); }
        finally { fs.closeSync(fd); }
      } catch {}
      headCache.set(id, head);
      return head;
    };
    const tip = resolveForkTip({
      startId: original,
      ids: [...files.keys()], // array (not a one-shot iterator — resolveForkTip re-scans per hop)
      mtimeOf,
      readHead,
      ownedElsewhere: (id) => claudeSessionOwnedElsewhere(id, parentShellId),
    });
    if (tip !== original) adoptClaudeSession(parentShellId, tip, 'fork-resolve');
    return tip;
  } catch {
    return original; // any failure → unchanged, current behavior preserved
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
const CODEX_SUBMIT_RETRY_MS = 1500
const CODEX_SUBMIT_MAX_RETRIES = 2

// Codex's paste-burst detector can occasionally consume a programmatic Enter as
// part of the paste, leaving the complete prompt staged in the composer. This is
// only enabled for unattended scheduled runs. Retry Enter while the PTY is
// completely silent; any output after an attempt proves Codex handled the key and
// cancels the retry before it can disturb a turn that has already started.
function writeCodexEnterWithRetry(id, engine) {
  const entry = shells.get(id)
  if (!entry || entry.codexSubmitRetry) return
  const pending = { retries: CODEX_SUBMIT_MAX_RETRIES, timer: null }
  entry.codexSubmitRetry = pending

  const writeEnter = () => {
    const current = shells.get(id)
    if (current !== entry || entry.codexSubmitRetry !== pending) return
    try { engine.write(id, '\r') } catch {
      entry.codexSubmitRetry = null
      return
    }
    // PTY output may arrive synchronously in test/fake engines. Do not arm a
    // retry after that output has already acknowledged this Enter.
    if (entry.codexSubmitRetry !== pending) return
    if (pending.retries === 0) {
      entry.codexSubmitRetry = null
      return
    }
    pending.timer = setTimeout(() => {
      if (shells.get(id) !== entry || entry.codexSubmitRetry !== pending) return
      pending.retries--
      log(`[codex-submit] id=${id} no output after Enter; retrying (${CODEX_SUBMIT_MAX_RETRIES - pending.retries}/${CODEX_SUBMIT_MAX_RETRIES})`)
      writeEnter()
    }, CODEX_SUBMIT_RETRY_MS)
  }

  writeEnter()
}

function acknowledgeCodexSubmitOutput(entry, id) {
  const pending = entry.codexSubmitRetry
  if (!pending) return
  clearTimeout(pending.timer)
  entry.codexSubmitRetry = null
  log(`[codex-submit] id=${id} Enter acknowledged by PTY output`)
}

// Any time deepsteve itself puts `/rc` into a PTY, say so — whichever path did it.
// Without this the only rc-shaped evidence was [rc-check], which covers the
// inheritance DECISION and nothing else: a meta_type or a browser-delivered `/rc`
// reached the agent logged as an anonymous `len=3`. That made "deepsteve did not send
// it" an inference from the absence of a line, which is not the same thing as knowing.
// Matches the command as a token so an ordinary prompt merely containing the letters
// does not cry wolf.
const RC_COMMAND_RE = /(^|\s)\/rc(\s|$)/;
// The PTY boundary tap. logRcWrite says WHO asked; this says what actually went out,
// observed inside the engine rather than inferred from the caller. Only rc-shaped
// payloads are logged: taking every write would be a firehose and a keylogger. A user
// TYPING /rc arrives as three separate one-character writes and matches none of them,
// so what this catches is programmatic writes — which is exactly the question.
function tapPtyWrite(id, data) {
  if (typeof data !== 'string' || !RC_COMMAND_RE.test(data)) return;
  log(`[rc-pty] id=${id} bytes=${JSON.stringify(data.slice(0, 60))}`);
}

function logRcWrite(id, text, source) {
  if (typeof text !== 'string' || !RC_COMMAND_RE.test(text)) return;
  log(`[rc-write] id=${id} source=${source} text=${JSON.stringify(text.slice(0, 40))}`);
}

function submitToShell(id, text, eng, options = {}) {
  logRcWrite(id, text, options.source || 'unattributed');
  // Mark this as a submission so the idle classifier doesn't treat the agent's
  // resulting work as "waiting for input" until its next completion BEL. Covers
  // auto-submitted initialPrompts and meta_type as well as graceful /exit.
  const e = shells.get(id);
  if (e) {
    e.lastInputTime = Date.now();
    // #627: someone is deliberately driving this session (meta_type, a delivered
    // prompt, an inherited /rc), so it isn't finished — release any pending
    // auto-close. killShell's own /exit also lands here, harmlessly: that path has
    // already cancelled. Keeps the rule statable as "any input, from any source".
    sessionAutoClose.cancel(id, 'prompt submitted');
    auditWaiting('submit', id, e, { len: text.length });
  }
  const engine = eng || getEngine(id);
  // #607: opt-in confirmed Enter — wait for the composer to actually echo the text
  // before sending \r, instead of guessing with a fixed delay. Opt-IN rather than
  // agent sniffing so the policy lives in one place (drainPromptQueue) and so
  // killShell's /exit keeps the timed path: it disposes entry.terminalScreen and
  // removes the data handler BEFORE submitting, so an echo could never arrive and
  // every shutdown would burn the full cap against killShell's 8s SIGTERM escalation.
  if (options.confirmEcho && e && !e.killed) return submitWithConfirmedEnter(id, e, engine, text, options);
  engine.write(id, text);
  // Returns a Promise that resolves once the deferred Enter has been written, so
  // callers (deliverPromptWhenReady) can re-enable input exactly when the submit
  // completes (#512). Existing callers ignore the return value (backward compatible).
  // The \r write is wrapped because the PTY may have died during the 1s window.
  return new Promise((resolve) => {
    setTimeout(() => {
      if (options.retryCodexEnter) writeCodexEnterWithRetry(id, engine)
      else try { engine.write(id, '\r') } catch {}
      resolve();
    }, 1000);
  });
}

// --- #607: confirmed submission, not assumed submission ---------------------
//
// The fixed 1s gap above is a proxy for "Ink has consumed the text". Under load
// (many tabs, a cold Claude Code start, a busy machine) the child can go longer
// than that without reading stdin: both writes sit in the tty buffer, a single
// read() returns them together, Ink classifies the trailing \r as pasted text
// rather than Enter, and the fully-typed prompt stays STAGED in the composer
// forever while the session sits idle. That is #607.
//
// Two signals replace the guess. entry.outputSeq moving proves the child produced
// output after our write, i.e. it read our write — the same principle
// acknowledgeCodexSubmitOutput already uses. A non-empty composer read off the
// interpreted screen corroborates it, and survives line wrapping and Claude Code's
// large-paste collapsing in a way substring matching does not.
//
// Timing budget: these caps are sized together with PROMPT_READY_DEADLINE_MS so the
// worst case (30s readiness + 8s echo + 12s verify = 50s) still fits inside the 60s
// inputBlockTimer and the client's 60s loading banner. Raising one means re-checking
// the others. #656 bought the echo phase 3 more seconds for its one re-type by
// taking them off verifyGraceMs (4000 -> 3000; the verify worst case is
// verifyGraceMs * (verifyRetries + 2)).
const envMs = (name, fallback) => parseInt(process.env[name], 10) || fallback;
const SUBMIT_TIMINGS = {
  // Floor before Enter may be sent. Keeps a false-positive echo from producing a
  // gap SHORTER than the legacy 1s and therefore more coalesce-prone, not less.
  echoMinGapMs: envMs('DEEPSTEVE_SUBMIT_ECHO_MIN_MS', 300),
  echoPollMs: envMs('DEEPSTEVE_SUBMIT_ECHO_POLL_MS', 150),
  // Covers the whole echo phase INCLUDING the one #656 re-type, which is why it is
  // 8s and not 5s. verifyGraceMs came down to 3000 to pay for it; see the budget.
  echoMaxWaitMs: envMs('DEEPSTEVE_SUBMIT_ECHO_MAX_MS', 8000),
  echoSettleMs: envMs('DEEPSTEVE_SUBMIT_ECHO_SETTLE_MS', 150),
  // #656: how long the composer may sit showing our HEAD but not our TAIL before we
  // stop waiting and re-type. Long enough that a slow repaint isn't mistaken for a
  // lost write, short enough to leave the rest of echoMaxWaitMs for the retry.
  echoStallMs: envMs('DEEPSTEVE_SUBMIT_ECHO_STALL_MS', 2000),
  screenLines: 40,        // one viewport is all the composer needs
  // TerminalScreen.lines() awaits an idle promise that sustained output can defer
  // indefinitely, so every read is bounded.
  screenReadMs: envMs('DEEPSTEVE_SUBMIT_SCREEN_READ_MS', 400),
  verifyGraceMs: envMs('DEEPSTEVE_SUBMIT_VERIFY_MS', 3000),
  verifyPollMs: envMs('DEEPSTEVE_SUBMIT_VERIFY_POLL_MS', 500),
  verifyRetries: envMs('DEEPSTEVE_SUBMIT_VERIFY_RETRIES', 2),
  // #656 delivery check. Detached from the submission promise, so these are NOT
  // part of the 60s inputBlockTimer budget above — nothing waits on them.
  deliveredPollMs: envMs('DEEPSTEVE_DELIVERED_POLL_MS', 1000),
  deliveredMaxMs: envMs('DEEPSTEVE_DELIVERED_MAX_MS', 15000),
};

const promptSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One viewport of interpreted screen for the submission poller, best-effort.
 *
 * Deliberately NOT readTerminalScreen: that resurrects a disposed emulator by
 * replaying the whole scrollback, which is exactly wrong on the killShell path.
 * The race guards against TerminalScreen.lines() awaiting an idle promise that
 * sustained output can defer indefinitely.
 */
async function promptScreenView(entry) {
  if (!entry || !entry.terminalScreen) return null;
  try {
    return await Promise.race([
      entry.terminalScreen.lines(SUBMIT_TIMINGS.screenLines),
      promptSleep(SUBMIT_TIMINGS.screenReadMs).then(() => null),
    ]);
  } catch { return null; }
}

// Layers 2+3 apply to screen-classified agents only (claude today). Codex has no
// screenMarkers — classifyScreenState could never confirm anything for it — and
// already has its own output-acknowledged Enter retry; hermes/opencode/pi/terminal
// have no screen signal at all and keep the fixed 1s gap. settings is read live, so
// the kill-switch takes effect with no restart.
function promptSubmitConfirmEnabled(entry) {
  return settings.promptSubmitVerify !== false
    && !!entry && !entry.killed
    && !!getAgentConfig(entry.agentType).screenMarkers;
}

// Below this, today's single write() is already one kernel queue-full or less, so
// there is nothing for a flush to take a bite out of and no reason to change the
// route. MAX_INPUT is 1024 on macOS and the pty accepts 1022 of it.
const PROMPT_PASTE_MIN_BYTES = envMs('DEEPSTEVE_PROMPT_PASTE_MIN_BYTES', 1024);

/**
 * Put `text` in front of the agent — as a paste when it is big enough to be worth
 * routing around the attach client's tty, as a plain write otherwise (#656).
 *
 * Byte length, not character length: the queue that loses our text counts bytes, and
 * a prompt of 900 multi-byte characters is well over the limit.
 */
function deliverPromptText(engine, id, entry, text) {
  const big = Buffer.byteLength(text) >= PROMPT_PASTE_MIN_BYTES;
  if (big && getAgentConfig(entry.agentType).supportsPaste && typeof engine.pasteText === 'function') {
    engine.pasteText(id, text);
    return;
  }
  engine.write(id, text);
}

/**
 * Write `text`, wait for the composer to show it, then send Enter as its own write.
 * Falls back to a timed Enter at the cap — confirmPromptSubmitted is the net for
 * that case. Resolves once Enter has been written, same contract as submitToShell.
 *
 * #656 changed what "show it" means. The gate used to be `readComposerDraft(view)`
 * truthy — a PRESENCE check. One echoed character satisfied it, so every delivery
 * fired Enter at the earliest possible instant (a 4.2KB prompt and a 2.4KB prompt
 * both confirmed at ~455ms) whether or not the write had finished arriving. It now
 * waits for `promptDraftVerdict` to see the END of our text, and when the composer
 * positively shows our head without our tail it re-types once rather than submitting
 * the fragment. See composer-state.js for why "the draft equals what we wrote" is
 * NOT a question the 40-row screen read can answer.
 */
async function submitWithConfirmedEnter(id, entry, engine, text, options) {
  const startedAt = Date.now();
  const deadline = startedAt + SUBMIT_TIMINGS.echoMaxWaitMs;
  let baseSeq = entry.outputSeq || 0;
  let floor = startedAt + SUBMIT_TIMINGS.echoMinGapMs;
  let why = 'timeout';
  // Non-null once the composer has positively shown our head without our tail.
  let stalledSince = null;
  let retyped = false;
  // The "draft stopped growing" fallback, used ONLY while the verdict is 'unknown'
  // — a screen we cannot classify must not cost every delivery the full cap.
  let prevDraft = null;

  deliverPromptText(engine, id, entry, text);

  while (Date.now() < deadline) {
    await promptSleep(SUBMIT_TIMINGS.echoPollMs);
    if (shells.get(id) !== entry || entry.killed) return;   // tab closed mid-submit
    if (Date.now() < floor) continue;
    if ((entry.outputSeq || 0) === baseSeq) continue;       // free gate: child hasn't read us
    const view = await promptScreenView(entry);
    if (view === null) { why = 'output'; break; }           // no emulator / read timed out

    const verdict = promptDraftVerdict(view, text);
    if (verdict === 'complete') { why = 'echo'; break; }

    if (verdict === 'incomplete') {
      prevDraft = null;                                     // the draft IS still growing
      if (stalledSince === null) stalledSince = Date.now();
      if (!retyped && Date.now() - stalledSince >= SUBMIT_TIMINGS.echoStallMs) {
        // Nothing has been submitted yet, so this is recoverable: clear the composer
        // and write the text again. If the read was wrong and the draft was whole,
        // the cost is a re-type, not a duplicate prompt — Esc empties the box first.
        retyped = true;
        log(`[submit] id=${id} composer shows a PARTIAL prompt — clearing and re-typing (len=${text.length})`);
        try { engine.write(id, '\x1b'); } catch { return; }
        await promptSleep(SUBMIT_TIMINGS.echoPollMs);
        if (shells.get(id) !== entry || entry.killed) return;
        try { deliverPromptText(engine, id, entry, text); } catch { return; }
        baseSeq = entry.outputSeq || 0;
        floor = Date.now() + SUBMIT_TIMINGS.echoMinGapMs;
        stalledSince = null;
      }
      continue;
    }

    // 'unknown' — no composer, an empty one, or a draft we can't attribute. Fall back
    // to the weaker "it stopped changing" signal. Safe precisely because it can never
    // override 'incomplete': a still-arriving write reports that instead.
    stalledSince = null;
    const draft = readComposerDraft(view);
    if (!draft) { prevDraft = null; continue; }
    if (prevDraft !== null && draft === prevDraft) { why = 'settled'; break; }
    prevDraft = draft;
  }
  if (shells.get(id) !== entry || entry.killed) return;
  if (why !== 'timeout') await promptSleep(SUBMIT_TIMINGS.echoSettleMs);
  log(`[submit] id=${id} Enter after ${why} (+${Date.now() - startedAt}ms, len=${text.length})`);
  // Never silently: a fragment reaching the agent is the whole of #656, and the
  // transcript check that follows is the only other place it can surface.
  if (why === 'timeout' && stalledSince !== null) {
    log(`[submit] id=${id} Enter on a composer that still shows only PART of the prompt (len=${text.length})`);
  }
  if (options.retryCodexEnter) writeCodexEnterWithRetry(id, engine);
  else try { engine.write(id, '\r'); } catch {}
}

/**
 * Did the agent RECEIVE what we wrote? (#656)
 *
 * Every other layer here reads the screen, and the screen cannot answer this. Both
 * `isPromptStaged` and `isPromptOnScreen` compare only the first COMPOSER_MATCH_CHARS,
 * so a delivery that lost its head reads as "not staged" (and is never retried) and a
 * submitted fragment whose head did land reads as "submitted". Two real deliveries lost
 * ~2030 contiguous head characters and were logged as clean.
 *
 * Claude Code writes the message it accepted into its session transcript, so that file
 * is an exact oracle. This runs DETACHED — never awaited, never joined to the delivery
 * promise, never holding `promptDelivering` or `inputBlocked` — because it is
 * instrumentation, not a gate. Its budget sits deliberately outside the 60s
 * inputBlockTimer arithmetic for the same reason.
 *
 * Fails silent in every uncertain direction: no transcript yet, an agent whose
 * transcripts we do not understand, a session id that moved under us. "Don't know" is
 * never reported as truncation.
 */
async function checkDeliveredPrompt(id, entry, text) {
  try {
    if (!entry || !entry.cwd || !entry.claudeSessionId || !text) return;
    // Claude Code's transcript format. Codex et al. have nothing comparable.
    if (!getAgentConfig(entry.agentType).supportsSessionWatch) return;
    // A slash command is not a user message. Some leave a <command-name> record,
    // some (an inherited /rc, which is a UI toggle) leave none at all, so there is
    // nothing to compare against and every one of them would report 'unconfirmed'.
    if (text.trimStart().startsWith('/')) return;
    const deadline = Date.now() + SUBMIT_TIMINGS.deliveredMaxMs;
    while (Date.now() < deadline) {
      await promptSleep(SUBMIT_TIMINGS.deliveredPollMs);
      // A fork or a close swaps the entry, and the answer would then be about a
      // different conversation — stop rather than report it against this one.
      if (shells.get(id) !== entry || entry.killed) return;
      const file = transcriptPath(entry);
      const verdict = compareDelivered(text, readRecentUserMessages(file));
      if (!verdict.known) continue;              // record not written yet
      if (verdict.ok) {
        log(`[submit] id=${id} delivered=${verdict.got}/${verdict.expected} chars`);
        return;
      }
      // The alarm has to live in the plain log: auditWaiting is gated behind the
      // default-off waitingAuditEnabled setting.
      // Three shapes, and the third is not rare: a flush partway through the write
      // leaves BOTH ends intact and takes a run out of the middle, so the length is
      // the only thing that gives it away. (Losing both ends surfaces as the
      // 'unconfirmed' line below — compareDelivered cannot attribute that record.)
      const missing = verdict.missingHead ? 'the HEAD'
        : verdict.missingTail ? 'the TAIL' : 'characters from the middle';
      log(`[submit] id=${id} TRUNCATED DELIVERY — agent recorded ${verdict.got}/${verdict.expected} chars, missing ${missing}`);
      auditWaiting('submit-truncated', id, entry, {
        expected: verdict.expected, got: verdict.got,
        missingHead: verdict.missingHead, missingTail: verdict.missingTail,
      });
      return;
    }
    // Nothing in the transcript ever looked like what we wrote. Under #607's rule
    // silence is not failure, so this is worded as the uncertainty it is — but a
    // delivery that lost BOTH ends can only ever surface here.
    if (shells.get(id) === entry && !entry.killed) {
      log(`[submit] id=${id} delivery unconfirmed after ${SUBMIT_TIMINGS.deliveredMaxMs}ms (len=${text.length}) — no matching message in the transcript`);
    }
  } catch { /* instrumentation must never affect the data path */ }
}

/**
 * After Enter: did the prompt actually go? (#607)
 *
 * The failure signature is precise — the agent is idle AND our prompt is still
 * sitting in the composer — so both halves are required before retrying. Anything
 * less would misread the transcript echo of a successful submit as a failure and
 * double-submit every prompt.
 *
 * Retries re-send \r ONLY, never the text: if the first Enter merely landed late,
 * re-typing would duplicate the prompt. An Enter on an empty composer is a no-op.
 *
 * @returns {'skipped'|'submitted'|'aborted'|'unverified'|'stuck'}
 */
async function confirmPromptSubmitted(id, text, options = {}) {
  const entry = shells.get(id);
  // #656: detached, and deliberately BEFORE the verify gate — a truncated delivery
  // takes the state === 'working' shortcut below, and is invisible to every check
  // after it. Never awaited.
  checkDeliveredPrompt(id, entry, text);
  if (!options.verify) return 'skipped';
  if (!entry) return 'aborted';
  const engine = entry.engine || getEngine(id);
  // Any write to this PTY that isn't ours invalidates the verdict: the user may
  // have taken over via the banner's "Enable input", or meta_type may have typed.
  // The retry \r deliberately does not bump lastInputTime — it is a key, not input,
  // and bumping it would blind this guard.
  const inputStamp = entry.lastInputTime;
  // A frozen child produces no output at all, and its last painted frame still shows
  // the composer as it was BEFORE we typed. Reading that stale frame would say
  // "not staged" and declare success — which is precisely the load case #607 is
  // about. So silence does not count against the window; it extends it, bounded.
  let sinceSeq = entry.outputSeq || 0;
  const hardDeadline = Date.now() + SUBMIT_TIMINGS.verifyGraceMs * (SUBMIT_TIMINGS.verifyRetries + 2);

  for (let attempt = 0; ; attempt++) {
    let until = Date.now() + SUBMIT_TIMINGS.verifyGraceMs;
    // Only a POSITIVE "our prompt is still in the composer, and the agent is idle"
    // reading justifies another Enter. An ambiguous screen for the whole window
    // means we don't know, and the fail-closed answer is to leave it alone.
    let sawStaged = false;
    while (Date.now() < until) {
      await promptSleep(SUBMIT_TIMINGS.verifyPollMs);
      if (shells.get(id) !== entry || entry.killed) return 'aborted';
      if (entry.lastInputTime !== inputStamp) return 'aborted';
      const state = classifyScreenState(entry);
      // Cheapest check, and no emulator read: a running turn means the prompt went
      // through, whatever the composer happens to be showing.
      if (state === 'working') return 'submitted';
      if (state !== 'waiting') continue;
      const view = await promptScreenView(entry);
      if (view === null) continue;
      if (isPromptStaged(view, text)) { sawStaged = true; continue; }
      // Not staged — but that alone does not prove the submit took. A child that has
      // not yet read its stdin shows exactly the same empty composer as one that
      // submitted and moved on, and under load that is the likelier reading. Require
      // positive evidence: the prompt echoed into the transcript. Anything else is
      // indeterminate, and an indeterminate window ends in 'unverified', not a retry.
      if (isPromptOnScreen(view, text)) return 'submitted';
      // Indeterminate. If the child has produced NO output since our Enter, the frame
      // we just read predates our typing — it is stale, not evidence, and letting it
      // run out the clock is exactly how a stuck prompt gets declared fine under
      // load. Extend instead, bounded by hardDeadline. (A staged composer is judged
      // above and deliberately does NOT wait for output: an Enter swallowed silently
      // produces no output at all, and that case must still be recoverable.)
      if ((entry.outputSeq || 0) === sinceSeq && Date.now() < hardDeadline) {
        until = Date.now() + SUBMIT_TIMINGS.verifyGraceMs;
      }
    }
    if (!sawStaged) {
      log(`[submit] id=${id} could not read the composer — not retrying Enter`);
      return 'unverified';
    }
    if (attempt >= SUBMIT_TIMINGS.verifyRetries) break;
    log(`[submit] id=${id} prompt still staged after ${SUBMIT_TIMINGS.verifyGraceMs}ms — re-sending Enter (${attempt + 1}/${SUBMIT_TIMINGS.verifyRetries})`);
    // Re-baseline first: the next window must also wait for the child to react to
    // THIS Enter rather than judging it against frames it painted before.
    sinceSeq = entry.outputSeq || 0;
    try { engine.write(id, '\r'); } catch { return 'aborted'; }
  }
  log(`[submit] id=${id} prompt may STILL be staged after ${SUBMIT_TIMINGS.verifyRetries} Enter retries — giving up`);
  auditWaiting('submit-stuck', id, entry, { len: text.length, screen: auditScreenTail(entry, 500) });
  return 'stuck';
}

/**
 * Async wrapper around `gh issue view` — returns { body, labels, url } or null.
 * Uses exec (not execSync) so it doesn't block the event loop.
 */
function fetchIssueFromGitHub(number, cwd) {
  return new Promise((resolve) => {
    const gh = resolveBinary('gh');
    if (!gh) { log(`[gh] Failed to fetch issue #${number}: gh not found on PATH`); resolve(null); return; }
    execFile(gh, ['issue', 'view', String(Number(number)), '--json', 'body,labels,url'],
      { cwd, encoding: 'utf8', timeout: 15000 },
      (err, stdout) => {
        if (err) { log(`[gh] Failed to fetch issue #${number}: ${err.message}`); resolve(null); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}

// Codex renders its composer before MCP initialization has settled, and Enter
// pressed during that startup task can be ignored while leaving the draft in the
// composer. Track the TUI's own lifecycle instead of guessing how long startup
// will take. Ratatui renders an MCP status row, then clears that row with
// cursor-position + erase-to-end when every server is ready/failed/cancelled.
// If startup is fast enough that no status row is rendered, a fully loaded
// welcome frame that remains stable for one render beat is the ready signal.
const CODEX_MCP_STATUS_RE = /(?:Starting MCP servers(?: \([^)]*\))?|Booting MCP server:)/;
const CODEX_READY_SETTLE_MS = 250;

function codexCursorRowBefore(data, offset) {
  const prefix = data.slice(0, offset);
  const cursorRe = /\x1b\[(\d+);(\d+)H/g;
  let row = null;
  let match;
  while ((match = cursorRe.exec(prefix))) row = Number(match[1]);
  return row;
}

function codexLoadedPromptRendered(data) {
  const plain = stripEscapeSequences(data);
  const card = plain.slice(plain.lastIndexOf('OpenAI Codex'));
  return card.includes('OpenAI Codex') &&
    /model:\s+(?!loading\b)\S+/.test(card) &&
    card.includes('›');
}

function markCodexReady(entry, id, via) {
  if (entry.codexReady) return;
  entry.codexReady = true;
  clearTimeout(entry.codexReadyTimer);
  entry.codexReadyTimer = null;
  log(`[codex-ready] id=${id} via=${via}`);
  if (entry.onCodexReadyOnce) {
    const callback = entry.onCodexReadyOnce;
    entry.onCodexReadyOnce = null;
    try { callback(); } catch (err) { log(`[codex-ready] callback threw: ${err.message}`); }
  }
}

function observeCodexReadiness(entry, id, data) {
  if (!entry.codexReadinessState) {
    entry.codexReadinessState = { tail: '', sawMcpStartup: false, mcpStatusRow: null, clearTail: '' };
  }
  const state = entry.codexReadinessState;
  const combined = (state.tail + data).slice(-16384);
  const plain = stripEscapeSequences(combined);

  if (!state.sawMcpStartup) {
    const marker = plain.match(CODEX_MCP_STATUS_RE);
    if (marker) {
      const rawMarkerOffset = combined.indexOf(marker[0]);
      state.sawMcpStartup = true;
      state.mcpStatusRow = codexCursorRowBefore(combined, rawMarkerOffset);
      state.clearTail = '';
      entry.codexReady = false;
      clearTimeout(entry.codexReadyTimer);
      entry.codexReadyTimer = null;
      log(`[codex-ready] id=${id} MCP startup row=${state.mcpStatusRow || 'unknown'}`);
    }
  } else if (!CODEX_MCP_STATUS_RE.test(stripEscapeSequences(data))) {
    const clearData = (state.clearTail || '') + data;
    const clearRe = /\x1b\[(\d+);1H\x1b\[J/g;
    let clear;
    while ((clear = clearRe.exec(clearData))) {
      if (!state.mcpStatusRow || Number(clear[1]) <= state.mcpStatusRow) {
        markCodexReady(entry, id, 'mcp-status-cleared');
        break;
      }
    }
    state.clearTail = clearData.slice(-32);
  }

  if (!state.sawMcpStartup && !entry.codexReady && codexLoadedPromptRendered(combined)) {
    clearTimeout(entry.codexReadyTimer);
    entry.codexReadyTimer = setTimeout(() => {
      const current = shells.get(id);
      if (current === entry && !state.sawMcpStartup) markCodexReady(entry, id, 'loaded-prompt');
    }, CODEX_READY_SETTLE_MS);
  }
  state.tail = combined;
}

/**
 * Deliver a prompt to a shell, handling the race between async fetch and idle readiness.
 * Prompts are queued per shell and submitted one at a time, each waiting for its
 * own readiness signal — so two pending prompts (e.g. an inherited `/rc` followed
 * by a start_issue prompt, #519) can't clobber each other's readiness slot.
 * For each queue head: Codex waits for its rendered MCP lifecycle to settle; if
 * another agent's screen shows it idle right now, submit immediately; if it uses
 * a fixed initialPromptDelay because its screen can't be classified, use that
 * delay; otherwise arm a level-triggered pending delivery that
 * servePendingDelivery serves as soon as the screen reads idle, with a deadline
 * so an unreadable screen can't park the prompt forever (#607).
 */
function deliverPromptWhenReady(id, prompt, options = {}) {
  const e = shells.get(id);
  if (!e) return;
  if (!e.promptQueue) e.promptQueue = [];
  e.promptQueue.push({ prompt, options })
  if (e.promptDelivering) {
    log(`[deliverPrompt] id=${id} queued prompt behind in-flight delivery (len=${prompt.length}, queue=${e.promptQueue.length})`);
    return; // the in-flight drain picks it up after the current submit lands
  }
  drainPromptQueue(id);
}

function drainPromptQueue(id) {
  const e = shells.get(id);
  if (!e || !e.promptQueue || e.promptQueue.length === 0) {
    if (e) e.promptDelivering = false;
    return;
  }
  e.promptDelivering = true;
  const queued = e.promptQueue.shift()
  const prompt = typeof queued === 'string' ? queued : queued.prompt
  const options = typeof queued === 'string' ? {} : queued.options
  const config = getAgentConfig(e.agentType);
  log(`[deliverPrompt] id=${id} waitingForInput=${e.waitingForInput} initialPromptDelay=${config.initialPromptDelay} promptLen=${prompt.length} queued=${e.promptQueue.length}`);

  // Block user keystrokes while we auto-populate this tab, so the user can't
  // interleave input with the injected prompt and corrupt the submission (#512).
  // Scoped to loading/prefill flows only, so input is never silently dropped
  // without a visible cue (the loading banner / prefill progress bar, which carry
  // an "Enable input" override button). Cleared when the deferred Enter of the
  // LAST queued prompt lands (submitAndNotify below), the user clicks override,
  // or a 60s safety timer (matches the client banner auto-dismiss, re-armed per
  // prompt) fires in case the agent never goes idle and submitAndNotify never runs.
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
    // Re-fetch: with the level-triggered readiness deadline this can fire tens of
    // seconds after the drain that scheduled it (#607).
    const live = shells.get(id);
    if (!live) return;
    // Evaluated here rather than at queue time because the answer depends on what the
    // agent has drawn, and at queue time it had drawn nothing.
    if (options.skipIf && options.skipIf(id)) {
      log(`[deliverPrompt] id=${id} dropping queued prompt: ${options.skipReason || 'skipIf'}`);
      finishDelivery();
      return;
    }
    if (options.onDeliver) options.onDeliver(id);
    const confirm = promptSubmitConfirmEnabled(live);
    // Re-enable input only after the submission has actually been VERIFIED, so the
    // banner dismiss, the unblock, and a truthful "prompt-submitted" event all
    // coincide with the prompt landing (#512, tightened by #607 — the event used to
    // mean "we wrote \r", which is exactly the lie #607 is about). Keeping input
    // blocked through verification is also what makes the retry Enter safe.
    submitToShell(id, prompt, null, { ...options, confirmEcho: confirm }).then(
      () => confirmPromptSubmitted(id, prompt, { verify: confirm })
    ).then(finishDelivery);
  }

  // Epilogue for a delivery that is OVER — submitted or skipped. A skip has to release
  // the queue and the input block exactly like a submit, or the tab is left with
  // keystrokes blocked and the next queued prompt never drains.
  function finishDelivery() {
    const entry = shells.get(id);
    if (!entry) return;
    if (entry.promptQueue && entry.promptQueue.length > 0) {
      // More prompts pending — keep input blocked and the banner up; the next
      // drain waits for the agent's next idle/BEL before submitting.
      drainPromptQueue(id);
      return;
    }
    entry.promptDelivering = false;
    entry.inputBlocked = false;
    clearTimeout(entry.inputBlockTimer);
    entry.inputBlockTimer = null;
    if (entry.loading || entry.prefill) {
      const wasPrefill = !!entry.prefill;
      entry.loading = false;
      entry.prefill = false;
      deliverToWindow({ type: 'prompt-submitted', id, windowId: entry.windowId || null, prefill: wasPrefill }, entry.windowId || null);
    }
  }

  // Codex's composer is visible while MCP servers are still starting, so its
  // screen-looking-ready state is not actionable. Wait for observeCodexReadiness
  // to see the MCP status row clear (or a stable fully-loaded no-status frame).
  // This is per-shell state, so same-cwd tabs cannot wake each other's prompts.
  if (config.codexReadiness) {
    if (e.codexReady) {
      log(`[deliverPrompt] id=${id} Codex already ready, submitting queued prompt`);
      setTimeout(submitAndNotify, 50);
    } else {
      log(`[deliverPrompt] id=${id} waiting for Codex MCP readiness`);
      e.onCodexReadyOnce = () => setTimeout(submitAndNotify, 50);
    }
    return;
  }
  // If the screen shows the agent is idle at its prompt right now, submit
  // immediately. Otherwise, unclassified agents with a fixed initialPromptDelay
  // use that delay; everything else installs a single-shot onIdleOnce that fires
  // on the next idle transition (#568 — replaces the old BEL-recency heuristic).
  if (computeWaiting(e)) {
    setWaiting(e, id, false, 'deliver-immediate');
    log(`[deliverPrompt] id=${id} submitting immediately (screen idle)`);
    setTimeout(submitAndNotify, 500);
  } else if (config.initialPromptDelay > 0) {
    log(`[deliverPrompt] id=${id} using delay ${config.initialPromptDelay}ms`);
    setTimeout(submitAndNotify, config.initialPromptDelay);
  } else {
    // #607: arm a LEVEL-triggered delivery instead of the old one-shot
    // e.onIdleOnce, which setWaiting fired only on the false->true edge. If the
    // screen classified 'unknown' at this instant while e.waitingForInput was
    // ALREADY true, that edge had already passed — reclassifyWaiting no-ops on
    // 'unknown' and setWaiting early-returns on a no-change — so the callback
    // could never fire and the prompt was never even typed. Reachable for the
    // 2nd queued prompt (inherited /rc, then the issue prompt) and for the async
    // fetchIssueFromGitHub path, which arms delivery seconds after the tab has
    // already gone idle.
    log(`[deliverPrompt] id=${id} arming pending delivery (deadline ${PROMPT_READY_DEADLINE_MS}ms)`);
    e.pendingDelivery = { submit: submitAndNotify, deadline: Date.now() + PROMPT_READY_DEADLINE_MS, len: prompt.length };
  }
}

// How long an armed delivery may sit in an AMBIGUOUS screen state before we give
// up on readiness and submit anyway. A prompt delivered into an unclassifiable
// screen is strictly better than one that is never delivered at all. Budgeted
// against the 60s inputBlockTimer above together with the echo/verify caps in
// submitToShell: 30s + 5s + 16s = 51s < 60s, so the whole delivery still lands while
// input is blocked and the client's loading banner is up. Raise one of the three
// and you must re-check the others.
const PROMPT_READY_DEADLINE_MS = parseInt(process.env.DEEPSTEVE_PROMPT_READY_DEADLINE_MS, 10) || 30000;

/**
 * Serve an armed pending delivery (#607). Called from reclassifyWaiting, which
 * already runs on every PTY chunk AND on the 1s waiting sweep — so this is
 * level-triggered with no new timer: a screen that is idle RIGHT NOW submits,
 * whether or not a false->true transition ever occurred.
 */
function servePendingDelivery(e, id, state) {
  const pending = e.pendingDelivery;
  if (!pending) return;
  if (state === 'waiting') {
    e.pendingDelivery = null;
    setWaiting(e, id, false, 'deliver-level');
    log(`[deliverPrompt] id=${id} screen idle — submitting pending prompt (len=${pending.len})`);
    setTimeout(pending.submit, 500);
    return;
  }
  // A decisively-working screen is not the hang condition — a turn has to end
  // eventually — so only AMBIGUOUS time counts against the deadline. This also
  // stops a legitimately long turn from getting a queued prompt shoved into it.
  if (state === 'working') { pending.deadline = Date.now() + PROMPT_READY_DEADLINE_MS; return; }
  if (Date.now() < pending.deadline) return;
  e.pendingDelivery = null;
  log(`[deliverPrompt] id=${id} readiness deadline reached (state=${state}) — submitting anyway (len=${pending.len})`);
  auditWaiting('deliver-deadline', id, e, { len: pending.len, screen: auditScreenTail(e, 500) });
  setTimeout(pending.submit, 0);
}

const RC_FOOTER_ROWS = 8;

// The pill reads "/rc active" only until Claude Code has shown it five times; from
// the sixth session on it collapses to a bare "/rc" (`rc-active-badge` /
// seenNotifications, threshold 5, in the 2.1.x bundle). BOTH mean active: the pill's
// other states spell themselves out ("/rc connecting…", "/rc reconnecting",
// "/rc failed"), so a bare "/rc" is never one of them. Matching only the verbose form
// is what silently switched this detector off mid-August 2026 on a machine whose
// counter had run out — it read every parent as Remote-Control-off and inheritance
// stopped firing, invisibly, because Claude Code turns Remote Control on by itself.
const RC_MARKER_VERBOSE = '/rc active';
// The collapsed pill is right-aligned on the footer line, so it is matched at
// end-of-line AND only on a line carrying a footer segment. A "/rc" the *user* typed
// sits in the composer box, which carries none — without that conjunction the
// composer would read as a live pill.
const RC_FOOTER_SEGMENT = /⏵⏵|for agents|to cycle|to manage/;
const RC_MARKER_COLLAPSED = /(^|\s)\/rc$/;

/**
 * The Remote Control marker on the session's CURRENT screen, or null if it shows none
 * — i.e. the string that says Remote Control is on right now. Returned rather than a
 * boolean so the caller can log WHICH form matched: these markers are a TUI-version
 * contract, and the last time one drifted there was no way to tell a parent that was
 * genuinely off from a marker we had stopped recognizing.
 *
 * Reads the interpreted screen, never the raw scrollback tail. That tail is a
 * concatenation of overlapping repaint frames — the same property that makes
 * classifyScreenTail key on spinner *recency* rather than presence — so a footer
 * drawn before the user toggled /rc off survived in it until 8KB of fresh output
 * pushed it out, and a tab sitting idle at its prompt emits none. "On" was
 * therefore sticky for as long as the tab sat there, and every child opened from
 * it inherited a /rc the parent no longer had. A tmux reattach made it permanent:
 * it replays the pane's history into a session that resumed with Remote Control
 * off, since /rc does not survive --resume.
 *
 * Only the bottom rows are scanned, because that is where Claude Code draws the
 * footer and reaching further up is precisely the history lookback this replaced.
 * A footer that soft-wraps in a very narrow tab can split the marker across two
 * rows and read as off — the safe direction for a toggle we re-issue on the
 * user's behalf. Still O(rows) and still run once at child-tab creation, never on
 * the PTY data path.
 */
function rcMarkerOnScreen(id) {
  const e = shells.get(id);
  if (!e || !e.terminalScreen) return null;
  for (const line of e.terminalScreen.linesSync(RC_FOOTER_ROWS)) {
    if (line.includes(RC_MARKER_VERBOSE)) return RC_MARKER_VERBOSE;
    if (RC_FOOTER_SEGMENT.test(line) && RC_MARKER_COLLAPSED.test(line)) return '/rc';
  }
  return null;
}

function sessionHasRemoteControl(id) {
  return rcMarkerOnScreen(id) !== null;
}

// The footer line as the detector saw it, for the [rc-check] log. Truncated: this
// runs once per spawn, and a full 120-column row per line would bury the decision.
function rcFooterSample(id) {
  const e = shells.get(id);
  if (!e || !e.terminalScreen) return 'no-screen';
  const lines = e.terminalScreen.linesSync(RC_FOOTER_ROWS).filter(Boolean);
  const footer = lines.reverse().find(l => RC_FOOTER_SEGMENT.test(l)) || lines[0] || '';
  return JSON.stringify(footer.slice(-90));
}

// Any Remote Control pill, in any state. This answers a DIFFERENT question from
// rcMarkerOnScreen: not "is Remote Control on?" but "is Claude Code already running
// Remote Control in this session?". `/rc` is a TOGGLE, so a session that is merely
// CONNECTING must not be typed at either — the keystroke would land as an off switch a
// second later. Claude Code turns Remote Control on by itself at startup, so for a
// freshly spawned child the answer is normally yes and there is nothing to inherit.
const RC_PILL_ANY = /\/rc (active|connecting|reconnecting|failed)/;
function sessionShowsRcPill(id) {
  const e = shells.get(id);
  if (!e || !e.terminalScreen) return false;
  for (const line of e.terminalScreen.linesSync(RC_FOOTER_ROWS)) {
    if (RC_PILL_ANY.test(line)) return true;
    if (RC_FOOTER_SEGMENT.test(line) && RC_MARKER_COLLAPSED.test(line)) return true;
  }
  return false;
}

/**
 * When a new tab/fork is opened from a parent session that has Remote Control on,
 * re-issue `/rc` in the child so it inherits remote control. Gated per-path by the
 * inheritRemoteControl / inheritRemoteControlOnFork settings. Reuses the existing
 * prepopulate-and-send path (deliverPromptWhenReady) — no new infrastructure.
 *
 * Logs its decision on EVERY spawn, including the no-op ones. Deep Steve types `/rc`
 * and passes no launch flag, so this line is the only evidence of whether a session's
 * Remote Control came from here or from Claude Code turning it on by itself — and
 * without the skip reasons, a detector that had stopped matching was indistinguishable
 * from a parent that simply had it off.
 */
function maybeInheritRemoteControl({ newId, agentType, isFork, parentId }) {
  const kind = isFork ? 'fork' : 'tab';
  const skip = (reason) => log(`[rc-check] new=${newId} ${kind} parent=${parentId || 'none'} -> skip: ${reason}`);
  if (agentType !== 'claude') return skip(`agent=${agentType} has no /rc`);  // /rc is a Claude Code feature
  const enabled = isFork ? settings.inheritRemoteControlOnFork : settings.inheritRemoteControl;
  if (!enabled) return skip(`inheritRemoteControl${isFork ? 'OnFork' : ''}=false`);
  if (!parentId || parentId === newId || !shells.has(parentId)) return skip('no live parent session');
  // The feature seeded its own future parents. A session we typed `/rc` into shows the
  // pill, which qualified it as a parent, so every tab opened from it was typed at too
  // — and every tab opened from THOSE. One hand-enabled session propagated Remote
  // Control outward through the whole tree and could not be switched off, because each
  // new tab was seeded from some other tab that still had it. Inheritance means "from
  // the session YOU turned it on in", so a session that got it from us is a dead end.
  if (shells.get(parentId).rcInherited) {
    return skip('parent got its own /rc from us — inheritance does not chain');
  }
  const marker = rcMarkerOnScreen(parentId);
  if (!marker) return skip(`parent shows no /rc marker; footer=${rcFooterSample(parentId)}`);
  log(`[rc-check] new=${newId} ${kind} parent=${parentId} -> queue /rc: parent shows "${marker}"`);
  // Decided at DELIVERY time, not here: the child has not drawn a screen yet. By the
  // time its composer is ready Claude Code has drawn its own pill if it is doing
  // Remote Control itself, and then this prompt is dropped instead of toggling it off.
  deliverPromptWhenReady(newId, '/rc', {
    skipIf: () => sessionShowsRcPill(newId),
    skipReason: 'the new session already has its own Remote Control pill',
    source: 'rc-inherit',
    // [rc-inherit] marks the keystroke, not the intention. Before this gate it was
    // logged at queue time and therefore claimed an inheritance that the child did
    // not need and should not have received.
    onDeliver: () => {
      // Mark the provenance at the moment the keystroke goes out, not when it was
      // queued: a queued prompt that gets dropped never made this session ours.
      const child = shells.get(newId);
      if (child) child.rcInherited = true;
      log(`[rc-inherit] ${newId} has no Remote Control of its own -> typing /rc (parent ${parentId})`);
    },
  });
}

/**
 * Coarse input-state of a session for external callers (meta_type,
 * read_session_screen, get_session_info). Shares the #568 screen-state detector:
 * 'idle' = the screen shows the agent at its input prompt (or a permission
 * dialog), 'busy' = a turn is running, 'unknown' = the screen isn't decisive or
 * the agent type has no defined screen signals (plain terminals, pi, …).
 */
function sessionInputState(entry) {
  const s = classifyScreenState(entry);
  return s === 'working' ? 'busy' : s === 'waiting' ? 'idle' : 'unknown';
}

/**
 * Strip all known ANSI escape sequences, preserving printable text and whitespace.
 * Used for UUID matching in resume detection.
 */
function stripEscapeSequences(data) {
  return data
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, '')  // OSC
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')       // CSI (parameter, intermediate, and final bytes)
    .replace(/\x1b[()][A-Z0-9]/g, '')                // SCS (character set selection)
    .replace(/\x1b[78DMHNOcn=><]/g, '');              // Single-char escapes
}

// --- Screen-state waiting detector (#568) ---
// Replaces the BEL-gated silence classifier. The last few KB of the scrollback,
// ANSI-stripped and whitespace-collapsed, is the "screen tail" the classifier
// reads (same shape as sessionHasRemoteControl / auditScreenTail). 8KB covers the
// live UI region even across a few overlapping repaint frames.
const SCREEN_TAIL_BYTES = 8192;
function screenTail(entry) {
  return stripEscapeSequences((entry.scrollback || []).join('').slice(-SCREEN_TAIL_BYTES))
    .replace(/[ \t]+/g, ' ');
}

// Tri-state: 'working' | 'waiting' | 'unknown'. 'unknown' means the screen isn't
// decisive — callers that update the flag must leave it AS-IS on 'unknown', never
// force it false (that is what keeps a half-typed prompt from disarming, #558).
function classifyScreenState(entry) {
  if (!entry) return 'unknown';
  const markers = getAgentConfig(entry.agentType).screenMarkers;
  return classifyScreenTail({
    tail: markers ? screenTail(entry) : '',
    now: Date.now(),
    lastSpinnerTime: entry.lastSpinnerTime,
    markers,
  });
}

// Definite-waiting only (used by prompt delivery, which must wait for a real idle
// signal rather than fire on an ambiguous screen).
function computeWaiting(entry) {
  return classifyScreenState(entry) === 'waiting';
}

// The single place that flips entry.waitingForInput. Broadcasts {type:'state'} to
// the session's clients only on a real change. Queued-prompt delivery used to hang
// off this transition via a one-shot e.onIdleOnce; #607 replaced that with the
// level-triggered servePendingDelivery below, because an edge that has already
// passed can never fire again.
function setWaiting(e, id, waiting, via, extra = {}) {
  if (waiting === !!e.waitingForInput) return;
  e.waitingForInput = waiting;
  auditWaiting('transition', id, e, { to: waiting, via, screen: auditScreenTail(e, waiting ? 1500 : 300), ...extra });
  const stateMsg = JSON.stringify({ type: 'state', waiting });
  e.clients.forEach((c) => c.send(stateMsg));
}

// Re-derive the waiting flag from the screen and apply it, then serve any armed
// prompt delivery. 'unknown' leaves the flag as-is — only a decisive
// 'working'/'waiting' moves it. Called on every output chunk and on the periodic
// sweep, so a stuck state self-corrects.
//
// #607: an unclassified agent yields state 'unknown' rather than returning early,
// so its pending delivery still gets its deadline served. Before this, a
// terminal-type session routed through deliverPromptWhenReady installed an
// onIdleOnce that nothing in the codebase could ever fire.
function reclassifyWaiting(e, id, via) {
  const state = getAgentConfig(e.agentType).screenMarkers ? classifyScreenState(e) : 'unknown';
  if (state !== 'unknown') setWaiting(e, id, state === 'waiting', via);
  servePendingDelivery(e, id, state);
}

/**
 * Wire up a shell's onData handler: broadcast output to WebSocket clients,
 * re-derive the screen-state waiting flag (#568), and auto-submit queued prompts.
 */
function wireShellOutput(id, cols = 120, rows = 40) {
  const entry = shells.get(id);
  if (!entry) return;
  disposeTerminalScreen(entry);
  entry.terminalScreen = new TerminalScreen({ cols, rows });
  if (getAgentConfig(entry.agentType).codexReadiness) {
    clearTimeout(entry.codexReadyTimer);
    entry.codexReadyTimer = null;
    entry.codexReady = false;
    entry.codexReadinessState = { tail: '', sawMcpStartup: false, mcpStatusRow: null, clearTail: '' };
    entry.onCodexReadyOnce = null;
  }
  if (!entry.scrollback) entry.scrollback = [];
  if (!entry.scrollbackSize) entry.scrollbackSize = 0;
  for (const chunk of entry.scrollback) entry.terminalScreen.write(chunk);

  const dataHandler = (data) => {
    const e = shells.get(id);
    if (!e) return;
    e.lastActivity = Date.now();
    // Monotonic PTY-chunk counter (#607). "The child produced output since our
    // write" is direct evidence it read that write, which is what lets the
    // prompt submitter know its text was consumed before it sends Enter. A
    // counter, not a timestamp: lastActivity is in ms (a chunk arriving in the
    // same millisecond as our write is invisible) and is also bumped by the
    // tmux-attach paths.
    e.outputSeq = (e.outputSeq || 0) + 1;
    acknowledgeCodexSubmitOutput(e, id)
    // Append to scrollback buffer
    e.scrollback.push(data);
    e.scrollbackSize += data.length;
    e.terminalScreen.write(data);
    // Trim scrollback if it exceeds the limit
    while (e.scrollbackSize > (settings.scrollbackKB * 1024) && e.scrollback.length > 1) {
      e.scrollbackSize -= e.scrollback.shift().length;
    }
    const config = getAgentConfig(e.agentType);
    // Strip ANSI once and share it: resume-UUID matching and the spinner heartbeat
    // both want the plain text. Skip entirely for agents that need neither
    // (plain terminals) so their hot path stays a pure passthrough.
    const plain = (config.emitsBel || config.screenMarkers || config.codexReadiness) ? stripEscapeSequences(data) : null;

    if (config.emitsBel) {
      // Detect claude --resume <UUID> in PTY output to track the actual session ID.
      // Claude prints this line when a session exits (including /exit, /clear, shutdown).
      const resumeMatch = plain.match(/claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (resumeMatch) {
        // adoptClaudeSession() owns the ownership guard, planMode reset, persistence,
        // and the mid-shutdown state.json patch (this line is printed on /exit, i.e.
        // during shutdown) — #503.
        adoptClaudeSession(id, resumeMatch[1], 'pty-output');
      }
      // #558 audit: classify this chunk's BELs (bare vs OSC-terminator). Kept for
      // the audit taxonomy and to keep the cross-chunk OSC-open carry flag correct.
      if (settings.waitingAuditEnabled) {
        const bels = auditClassifyBels(e, data);
        if (bels.bare + bels.osc > 0) auditWaiting('bels', id, e, bels);
      }
      // lastBelTime no longer gates the waiting classifier (#568) — it now only
      // feeds killShell's "wait for the prompt bell before /exit" path and the
      // audit's msSinceBel. The BEL is not a reliable readiness signal (#558).
      if (data.includes('\x07')) e.lastBelTime = Date.now();
    } else if (settings.waitingAuditEnabled) {
      // #558 audit: emitsBel=false sessions (terminal/pi/hermes/opencode) are never
      // classified — record their bells to measure what that exclusion hides.
      const bels = auditClassifyBels(e, data);
      if (bels.bare + bels.osc > 0) auditWaiting('bel-nonclaude', id, e, bels);
    }

    // #568 screen-state waiting detector. Any chunk carrying the spinner marker is
    // a live-turn heartbeat → refresh lastSpinnerTime. Then re-derive the waiting
    // flag from the screen (reclassifyWaiting broadcasts state on a real
    // transition and serves any armed prompt delivery; 'unknown' leaves the flag
    // untouched, but still counts against the delivery deadline). Runs on every
    // chunk; the periodic sweep handles the transition-to-idle when output stops.
    if (config.screenMarkers) {
      if (config.screenMarkers.spinner.test(plain)) e.lastSpinnerTime = Date.now();
      reclassifyWaiting(e, id, 'output');
    }
    if (config.codexReadiness) {
      observeCodexReadiness(e, id, data);
    }
    e.clients.forEach((c) => c.send(data));
  };

  (entry.engine || ptyEngine).onData(id, dataHandler);
  // Store reference for cleanup
  entry._engineDataHandler = dataHandler;
}

async function readTerminalScreen(entry, lines) {
  if (!entry.terminalScreen) {
    entry.terminalScreen = new TerminalScreen();
    for (const chunk of entry.scrollback || []) entry.terminalScreen.write(chunk);
  }
  return entry.terminalScreen.lines(lines);
}

function disposeTerminalScreen(entry) {
  if (!entry.terminalScreen) return;
  entry.terminalScreen.dispose();
  entry.terminalScreen = null;
}

// Gracefully kill a shell
function killShell(entry, id, reason = 'closed') {
  if (entry.killed) return;
  entry.killed = true;
  disposeTerminalScreen(entry);
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

  // Clean up timers and engine data listener. The auto-close cancel is here as well
  // as in tombstoneSession because the detach reaper (armDetachReap) tears a session
  // down WITHOUT tombstoning it — it deliberately writes a non-closed savedState entry.
  clearTimeout(entry.inputBlockTimer);
  sessionAutoClose.cancel(id, 'session killed');
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

// Delete a context's uploaded icon file(s) (#579). Both extensions are removed so a
// png→svg replace (or a delete) never leaves a stale file behind. Missing files and
// errors are ignored — this is best-effort cleanup, not a correctness gate.
function removeIconFiles(id) {
  for (const ext of ['png', 'svg']) {
    try { fs.unlinkSync(path.join(ICONS_DIR, `${id}.${ext}`)); } catch {}
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
        .map(c => ({ id: c.id || genContextId(), name: c.name, dirs: Array.isArray(c.dirs) ? c.dirs.filter(Boolean) : [], icon: typeof c.icon === 'string' ? c.icon : '', iconImage: (c.iconImage === 'png' || c.iconImage === 'svg') ? c.iconImage : '', archived: c.archived === true, alwaysShowMods: c.alwaysShowMods !== false }));
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
          .map(g => ({ id: genContextId(), name: g.name, dirs: Array.isArray(g.projects) ? g.projects.filter(Boolean) : [], alwaysShowMods: true }));
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

// Tell every window a session's autopilot value changed (#643). The server owns the
// value, so it announces it rather than letting each switch guess: the wand picker's
// `{type:'issue'}` arrives AFTER the `{type:'session'}` message that reports the
// session's fields, so that message always says false on a picker start — and a flip
// from one window has to reach the tab strip in the others.
function broadcastAutopilot(id) {
  const entry = shells.get(id);
  if (!entry) return;
  const msg = JSON.stringify({ type: 'autopilot', id, autopilot: !!entry.autopilot });
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
    codexHomeId: e.codexHomeId || null,
    configDir: e.configDir || null,
    worktree: e.worktree || null,
    name: e.name || null,
    planMode: !!e.planMode,
    model: e.model || null,
    effort: e.effort || null,
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
// `resultItemId` / `resultApprovedAt` are Workshop's review-gate stamps (#669), carried
// for the same reason `autopilot` is: they are read at completion time, and a
// ./restart.sh landing between a human pressing Approve and the agent calling
// issue_complete would otherwise silently send it back to "share a result first".
// `resumedWorktree` (#689) is here on exactly that argument: it records which commits
// were already on the branch when this session started, it cannot be recomputed later
// (by then they look like everyone else's), and issue_complete reads it at the end.
function serializeShellEntry(entry) {
  return { cwd: entry.cwd, claudeSessionId: entry.claudeSessionId, agentType: entry.agentType || 'claude', codexHomeId: entry.codexHomeId || null, configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', worktree: entry.worktree || null, name: entry.name || null, planMode: !!entry.planMode, model: entry.model || null, effort: entry.effort || null, allowedTools: Array.isArray(entry.allowedTools) && entry.allowedTools.length ? entry.allowedTools : null, forkParent: entry.forkParent || null, lastActivity: entry.lastActivity || null, createdAt: entry.createdAt || null, windowId: entry.windowId || null, scheduled: !!entry.scheduled, autopilot: !!entry.autopilot, resumedWorktree: entry.resumedWorktree || null, resultItemId: entry.resultItemId || null, resultApprovedAt: entry.resultApprovedAt || null };
}

// #561: a session record is never hard-deleted by any runtime path. Every close
// funnels through here and leaves a restorable tombstone (keeping claudeSessionId,
// cwd, worktree, name, windowId, timestamps) so the restore/recents UI can always
// resurrect it via --resume. Permanent removal happens only via an explicit
// DELETE ?forget=1 (deliberate user action) or pruneClosedSessions() (retention).
function tombstoneSession(id, entry, reason) {
  // Every close path funnels through here, which makes it the one place that can
  // guarantee a queued open-session for a session nobody ever saw is retracted
  // instead of being handed to the next browser as a zombie tab (#596). Runs
  // before the tmux-attach return so ephemeral sessions are retracted too.
  const dropped = pendingOpens.drop(id);
  if (dropped) log(`[pendingOpens] dropped ${dropped} queued message(s) for closed session ${id}`);
  // Same argument as the drop above: this is the one place every close path passes
  // through, so it is where a pending #627 auto-close is released. (The auto-closer
  // re-checks the entry identity at fire time and would drop a stale timer anyway —
  // this just frees it now rather than at its deadline.)
  sessionAutoClose.cancel(id, 'session closed');
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
//
// It LOGS (#625). This function is the funnel every unexpected session death flows
// through, and it used to be silent: three mass closures left no trace in the daemon
// log beyond the periodic `Saved N sessions` lines, and the trigger was only found by
// monkey-patching WebSocket.prototype.send in the browser to capture a stack. One line
// per close — not a roster, which is the #557 lesson.
//
// `reason` is optional: killShell already records why in closeReasons (it survives the
// shells.delete that happens first), so almost every caller can stay `handleShellGone(id)`
// and still produce a truthful line. Pass one only where the caller knows something
// closeReasons does not.
//
// Both early returns log too. "handleShellGone did nothing" and "handleShellGone was
// never called" are different diagnoses that used to look identical from the log, and
// both of these are legitimate outcomes rather than errors.
function handleShellGone(id, reason) {
  if (shuttingDown) {
    log(`[shell-gone] ${id} ignored — shutting down (the final snapshot owns persistence)`);
    return;
  }
  const entry = shells.get(id);
  if (!entry) {
    log(`[shell-gone] ${id} already removed — an explicit close path handled it`);
    return;
  }
  const why = reason || closeReasons.get(id) || 'exited';
  const upSec = entry.createdAt ? Math.round((Date.now() - entry.createdAt) / 1000) : '?';
  log(`[shell-gone] ${id} reason=${why} engine=${entry.engineType || 'node-pty'} ` +
      `agent=${entry.agentType || 'claude'} clients=${entry.clients ? entry.clients.size : 0} ` +
      `up=${upSec}s name=${entry.name || '-'} cwd=${entry.cwd || '-'}`);
  tombstoneSession(id, entry, why);
  notifyClientsShellExited(id);
  disposeTerminalScreen(entry);
  shells.delete(id);
  saveState();
}

// The periodic save used to log the full session roster every 30s — at 30+
// sessions that one line was essentially the entire 201MB log (#557). Log a
// count summary instead, and only when it changed since the last save; the
// roster itself is always readable in state.json.
let lastSaveStateSummary = '';
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
    const ids = Object.keys(merged);
    const closed = ids.reduce((n, id) => n + (merged[id].closed ? 1 : 0), 0);
    const summary = `Saved ${ids.length} sessions (${ids.length - closed} active, ${closed} closed)`;
    if (summary !== lastSaveStateSummary) {
      lastSaveStateSummary = summary;
      log(summary);
    }
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
  // Not cosmetic: shutdown DETACHES tmux sessions so they survive the restart (#620),
  // and a #627 auto-close firing inside that ~12s window would really close one —
  // destroying exactly what the detach preserves. (The auto-closer also checks
  // isShuttingDown at fire time; this releases the timers outright.)
  sessionAutoClose.clearAll();

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

  const allEntries = [...shells.entries()];
  if (allEntries.length === 0) {
    log('No active shells, exiting');
    process.exit(0);
  }

  // Phase 0: a restart must not take the agents with it (#620). A tmux-backed
  // session's process belongs to the tmux server, not to us, so we release our
  // attach PTY and leave it running; startup's reattach block picks it back up.
  // Only the *shutdown* path detaches — an explicit close (close_session, the ✕,
  // DELETE /api/shells/:id, killall) still goes through killShell and really ends
  // the session. `tmux-attach` tabs are excluded: they're a separate pseudo-engine
  // that manages its own PTY and is never persisted.
  const entries = [];
  const detached = [];
  for (const [id, entry] of allEntries) {
    const eng = entry.engine || ptyEngine;
    if (entry.agentType !== 'tmux-attach' && eng.canDetach) {
      try {
        if (eng.detach(id)) { detached.push(id); continue; }
      } catch (e) { log(`Failed to detach ${id}, will kill instead: ${e.message}`); }
    }
    entries.push([id, entry]);
  }
  if (detached.length) {
    log(`Detached ${detached.length} tmux session(s) — still running: ${detached.join(', ')}`);
  }

  // Phase 1: Gracefully exit the remaining shells so Claude persists sessions.
  if (entries.length) log(`Gracefully exiting ${entries.length} shells...`);
  for (const [id, entry] of entries) {
    try {
      killShell(entry, id, 'shutdown');
    } catch {}
  }

  // Phase 2: Wait up to 8s for shells to exit naturally (1s for \r delay + time to save).
  // Detached sessions are deliberately absent from `alive` — nothing is going to
  // exit, so a restart where every tab is tmux-backed skips this wait entirely.
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
    log(entries.length ? 'All shells exited gracefully' : 'Nothing to exit — every session was detached');
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

const INSTALL_SOURCE_FILE = path.join(DS_DIR, '.install-source.json');

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

// The three channels that can produce an install, and the only values the marker may
// carry. `npm` (#636) is stamped by bin/deepsteve.js and is deliberately NOT an
// auto-updatable type: applyGitPull and applyCurlReinstall each refuse a mismatched
// type, so naming npm here is what stops an in-app "Update now" from overwriting an
// npm-managed install with a curl payload. Anything else collapses to `unknown`.
const INSTALL_SOURCE_TYPES = ['git', 'curl', 'npm'];

function loadInstallSource() {
  try {
    if (fs.existsSync(INSTALL_SOURCE_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSTALL_SOURCE_FILE, 'utf8'));
      if (data && INSTALL_SOURCE_TYPES.includes(data.type)) {
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
    const out = runBinary('git', ['-C', sourcePath, 'status', '--porcelain'], {
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

// Things that make an unattended restart a bad idea right now (#596). A mod
// registers a predicate returning null (fine) or { reason } (hold off). This
// exists because /api/request-restart auto-confirms when no browser is connected —
// which is exactly the situation an unattended scheduled run is fired in, so the
// auto-updater used to restart straight through a run mid-work, leaving its status
// stuck 'running' forever and its worktree leaked (the sweep skips ACTIVE runs).
// Only the auto-update path consults these: an explicit ./restart.sh is a direct
// user instruction and is still honored immediately.
const restartBlockers = [];
function registerRestartBlocker(fn) {
  if (typeof fn === 'function') restartBlockers.push(fn);
}
function restartBlockedBy() {
  for (const fn of restartBlockers) {
    try {
      const res = fn();
      if (res && res.reason) return res.reason;
    } catch (e) { log(`[auto-update] restart blocker threw: ${e.message}`); }
  }
  return null;
}

const AUTO_APPLY_GRACE_MS = 60 * 1000;
const AUTO_APPLY_DEFER_MS = 10 * 60 * 1000;
const AUTO_APPLY_MAX_DEFERS = 6; // ~1h of waiting, then update anyway rather than starve

function scheduleAutoApply(deferrals = 0) {
  const delayMs = deferrals === 0 ? AUTO_APPLY_GRACE_MS : AUTO_APPLY_DEFER_MS;
  const deadline = Date.now() + delayMs;
  log(`[auto-update] scheduling auto-apply in ${delayMs / 1000}s for ${versionStatus.releaseTag}${deferrals ? ` (deferral ${deferrals}/${AUTO_APPLY_MAX_DEFERS})` : ''}`);
  const timer = setTimeout(() => {
    pendingAutoApply = null;
    const blocked = restartBlockedBy();
    if (blocked && deferrals < AUTO_APPLY_MAX_DEFERS) {
      log(`[auto-update] deferring reinstall — ${blocked}`);
      scheduleAutoApply(deferrals + 1);
      return;
    }
    if (blocked) log(`[auto-update] applying despite "${blocked}" — deferral limit reached`);
    log(`[auto-update] grace expired, triggering reinstall`);
    applyCurlReinstall().catch(e => log(`[auto-update] auto-apply failed: ${e.message}`));
  }, delayMs);
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
    runBinary('git', ['-C', sourcePath, 'pull', '--ff-only'], {
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
    const updateDir = path.join(DS_DIR, '.update');
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

// Is an agent binary on the user's PATH?
//
// This was `zsh -l -c 'which <bin>'` — a subprocess, and a LOGIN shell at that, to
// answer a question that is literally a PATH lookup. It sourced ~/.zprofile/~/.zshrc
// every call (~50ms), and /api/agents probes three binaries synchronously on the
// event loop the WS upgrade handshake shares (#553), so a burst of windows stalled
// every pending upgrade for ~140ms each. That cost is what the 60s cache existed to
// hide; resolveBinary is a statSync/accessSync walk over ~10 dirs, so the cache had
// nothing left to buy and removing it makes /api/agents strictly more correct —
// installing an agent now shows up immediately instead of up to a minute later (#621).
function binaryAvailable(bin) {
  return resolveBinary(bin) !== null;
}

app.get('/api/agents', (req, res) => {
  const enabledAgents = settings.enabledAgents || ['claude'];
  const defaultAgent = settings.defaultAgent || 'claude';
  // One pass over AGENT_CATALOG, so adding an agent means adding a catalog row and
  // nothing else. `enabled` gates on enabledAgents for EVERY agent (#622): hermes,
  // opencode and pi used to be auto-enabled on binary presence alone, so their Settings
  // checkboxes did nothing — unchecking one left it in the picker. Claude is the only
  // agent never probed: it's the default agent and the fallback in getAgentConfig(),
  // so reporting it unavailable would leave the picker empty on a slow `which`.
  // binarySetting/binary are echoed back so the Settings UI can render the binary-path
  // row generically instead of carrying its own id→settings-key map.
  const agents = AGENT_CATALOG.map(a => {
    const binary = a.binarySetting ? (settings[a.binarySetting] || a.id) : a.id;
    const available = a.id === 'claude' || binaryAvailable(binary);
    return {
      id: a.id,
      name: a.name,
      shortName: a.shortName,
      tier: a.tier,
      available,
      enabled: available && enabledAgents.includes(a.id),
      isDefault: defaultAgent === a.id,
      binarySetting: a.binarySetting || null,
      binary,
    };
  });
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
      tier: 'supported', // a profile IS a claude session, just pinned to another CLAUDE_CONFIG_DIR
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

// True when this install has tmux but is still on the perishable engine, and has
// never been asked about it (#620). Existing installs all have an explicit
// "engine": "node-pty" on disk — saveSettings() writes the whole object — so the
// schema default alone would never move them; they get asked instead of migrated
// behind their back.
function shouldOfferEngineMigration() {
  return !!tmuxEngine && settings.engine === 'node-pty' && !settings.engineMigrationOffered;
}

app.get('/api/engines', (req, res) => {
  res.json({
    engines: [
      { id: 'node-pty', name: 'node-pty (built-in)', available: true },
      { id: 'tmux', name: 'tmux', available: !!tmuxEngine, version: tmuxEngine?.version || null,
        reason: tmuxUnavailableReason },
    ],
    current: settings.engine || 'node-pty',
    tmuxAvailable: !!tmuxEngine,
    // The binary exists but can't actually create sessions here (see
    // spawnSession's fallback). Kept separate from tmuxAvailable so the settings
    // dropdown doesn't label an installed tmux "not installed" — but it drives the
    // same warning, because the user is on the perishable engine either way.
    tmuxRuntimeFailure,
    // The socket we actually bound and how big it is (#625), so the fallback panel can
    // NAME the offending path instead of saying "tmux failed". A path over the limit is
    // the one runtime failure with a self-evident fix, and the user cannot see the
    // number from the browser any other way.
    tmuxSocket: TMUX_SOCKET,
    tmuxSocketBytes: Buffer.byteLength(TMUX_SOCKET),
    sunPathLimit: SUN_PATH_LIMIT,
    // Off macOS the fallback is materially worse (systemd restarts the daemon on every
    // crash and upgrade), so the client escalates its warning rather than showing the
    // same "perishable engine" badge. Sent as a fact rather than sniffed client-side —
    // the browser has no idea what the daemon is running on.
    tmuxRequired: TMUX_REQUIRED,
    migrationOffer: shouldOfferEngineMigration(),
  });
});

// The browser's answer to that offer. Deliberately not the WS consent machinery
// used by meta-controls: this is an offer, not a security gate, so a plain
// endpoint plus the startup fetch is enough — and it handles "no browser was
// connected when the daemon booted" for free, since the offer simply waits for
// one to show up.
app.post('/api/engine-migration', (req, res) => {
  const decision = req.body && req.body.decision;
  if (decision !== 'migrate' && decision !== 'keep') {
    return res.status(400).json({ error: 'decision must be "migrate" or "keep"' });
  }
  // Latch either way — asking twice is nagging.
  settings.engineMigrationOffered = true;
  if (decision === 'migrate') {
    if (!tmuxEngine) return res.status(409).json({ error: `tmux not available — ${tmuxUnavailableReason}` });
    settings.engine = 'tmux';
  }
  saveSettings();
  broadcastSettings();
  log(`[engine-migration] user chose "${decision}" — engine=${settings.engine}`);
  res.json({ engine: settings.engine, engineMigrationOffered: true });
});

app.get('/api/tmux-sessions', (req, res) => {
  // Goes through the engine so there is one place that knows how to invoke tmux
  // (#619) — this used to run its own `zsh -l -c 'tmux list-sessions …'`.
  //
  // userTmux(), not tmuxEngine (#625): this menu is about the user's OWN tmux, on
  // tmux's default per-UID socket. Our own ds-* sessions have moved to
  // ~/.deepsteve/tmux.sock and no longer appear here — which is a small improvement,
  // since offering a raw second attach to a pane that already has a tab was never
  // useful. Reaching the shared socket is deliberate and named; it is not the default.
  if (!tmuxEngine) return res.json({ sessions: [] });
  const sessions = userTmux().listAllSessions().map(s => ({
    ...s,
    // Is any deepsteve shell already attached to this session?
    attached: [...shells.values()].some(e => e.tmuxSession === s.name),
  }));
  res.json({ sessions });
});

app.post('/api/settings', (req, res) => {
  const warnings = applySettingsFromBody(req.body, settings);
  saveSettings();
  broadcastSettings();
  // Side effect: restart the update-check interval if its fields changed.
  const needsTimerRestart = Object.keys(req.body).some(k => AUTO_UPDATE_TIMER_FIELDS.has(k));
  if (needsTimerRestart) restartUpdateTimer();
  // Side effect: apply a power-assertion toggle immediately instead of waiting
  // for the next 5s reconcile tick (#563).
  if ('preventSleepWhileActive' in req.body) powerAssertion.sync();
  // `warnings` rides along only when something was pruned/rejected; a later
  // read-modify-write POST echoing it back is harmless (not in the schema).
  res.json(warnings.length ? { ...settings, warnings } : settings);
});

// --- Command Palette: Custom Commands ---

const COMMANDS_DIR = path.join(DS_DIR, 'commands');
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
  { id: 'history', type: 'builtin', name: 'History', description: "Scroll this tab's transcript" },
  // #688. Meaningful only on a worktree tab, and the client filters it out on any other
  // rather than the server doing it: this list is fetched once when the palette opens and
  // is not per-session, while which tab is active changes under it.
  { id: 'merge-session', type: 'builtin', name: 'Merge Worktree', description: "Commit this tab's worktree, merge it, and close its GitHub issue" },
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
    ...sessionEnv(sessionId || '', { name: shell?.name, worktree: shell?.worktree, windowId: shell?.windowId, cwd: shell?.cwd, agentType: shell?.agentType, configDir: shell?.configDir, codexHomeId: shell?.codexHomeId }),
    // Run the command in the agent's real working dir (the worktree for worktree
    // sessions); sessionPaths returns an existing dir suitable for execSync's cwd.
    DEEPSTEVE_CWD: (shell ? sessionPaths(shell).cwd : '') || process.cwd(),
  };

  try {
    // The other place a login shell is genuinely wanted (#621): a script the user
    // wrote in ~/.deepsteve/commands expects their own environment. execFileSync
    // rather than execSync also removes a whole shell layer — the old form built a
    // command STRING, so /bin/sh expanded any `$` or backtick in the filename before
    // zsh ever saw it.
    const output = execFileSync(LOGIN_SHELL.path, [...(LOGIN_SHELL.loginFlag ? [LOGIN_SHELL.loginFlag] : []), '-c', filePath], {
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
// The two agent-config dirs hang off agentHomeDir(), NOT os.homedir() (#641). They are
// the only dirs the daemon writes outside DS_DIR, and while they used os.homedir() a
// second instance isolated with DEEPSTEVE_HOME deleted the real user's installed skills:
// scratch settings meant nothing was enabled, and the boot reconcile pruned a home it
// did not own. With no override agentHomeDir() *is* os.homedir(), so this is a no-op for
// a real install. test/unit/paths.test.js keeps it that way.
const SKILLS_DIR = path.join(__dirname, 'skills');
const AGENT_HOME = agentHomeDir();
const CLAUDE_COMMANDS_DIR = path.join(AGENT_HOME, '.claude', 'commands');
const CODEX_SKILLS_DIR = path.join(AGENT_HOME, '.agents', 'skills');
const CODEX_SKILL_STORE_DIR = path.join(DS_DIR, 'codex-skills');
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Install a skill file: copy source .md to ~/.claude/commands/deepsteve/{id}.md
// The deepsteve subdirectory namespaces the Claude command as /deepsteve:{id}.
// Returns true when the copy actually changed on disk, so a reconcile that finds
// everything already in place stays silent instead of logging eight no-ops.
function installSkillFile(id) {
  const src = path.join(SKILLS_DIR, `${id}.md`);
  fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
  return writeFileIfChanged(skillDestPath(id), fs.readFileSync(src, 'utf8'));
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
// Claude invokes them as /deepsteve:{id}; custom profiles link this directory.
const SKILL_DEST_DIR = path.join(CLAUDE_COMMANDS_DIR, 'deepsteve');
function skillDestPath(id) {
  return path.join(SKILL_DEST_DIR, `${id}.md`);
}

function codexSkillName(id) {
  return `deepsteve-${id}`;
}

function codexSkillStorePath(id) {
  return path.join(CODEX_SKILL_STORE_DIR, codexSkillName(id));
}

function codexSkillLinkPath(id) {
  return path.join(CODEX_SKILLS_DIR, codexSkillName(id));
}

function pathStat(filePath) {
  try { return fs.lstatSync(filePath); } catch { return null; }
}

// Codex does not expand Claude's literal $ARGUMENTS placeholder. Keep skills/*.md
// canonical and generate a Codex-facing SKILL.md that describes where arguments live.
function renderCodexSkill(id) {
  const skillName = codexSkillName(id);
  const src = fs.readFileSync(path.join(SKILLS_DIR, `${id}.md`), 'utf8');
  const argumentText = `the user's invocation arguments (the text following the $${skillName} mention in their message)`;
  let content = src.replace(/^---\n([\s\S]*?)\n---/, (match, frontmatter) => {
    const updated = frontmatter
      .replace(/^name:\s*.*$/m, `name: ${skillName}`)
      .replace(/^argument-hint:.*\n?/m, '');
    return `---\n${updated}\n---`;
  });
  content = content.replace(/\$ARGUMENTS/g, argumentText);
  content = content.replace(/\/deepsteve:([a-zA-Z0-9][a-zA-Z0-9._-]*)/g, '$deepsteve-$1');
  return content;
}

function writeFileIfChanged(filePath, content) {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return false;
  } catch {}
  fs.writeFileSync(filePath, content);
  return true;
}

// Codex discovers $HOME/.agents/skills/<name>/SKILL.md and follows symlinked
// skill folders. The generated content lives under ~/.deepsteve; only the
// DeepSteve-prefixed discovery link is managed in the user's skills directory.
function installCodexSkill(id) {
  const store = codexSkillStorePath(id);
  const dest = codexSkillLinkPath(id);
  fs.mkdirSync(store, { recursive: true });
  const wrote = writeFileIfChanged(path.join(store, 'SKILL.md'), renderCodexSkill(id));
  fs.mkdirSync(CODEX_SKILLS_DIR, { recursive: true });

  const st = pathStat(dest);
  if (st) {
    if (!st.isSymbolicLink()) {
      log(`Codex skill: ${dest} exists and is not ours — leaving it alone`);
      return wrote;
    }
    if (fs.readlinkSync(dest) === store) return wrote;
    fs.unlinkSync(dest);
  }
  fs.symlinkSync(store, dest);
  log(`Codex skill: linked ${dest} -> ${store}`);
  return true;
}

// The remove* pair returns the paths it actually deleted, so removeSkill() can name
// them in one log line and say nothing when there was nothing to delete (#641).
function removeCodexSkill(id) {
  const removed = [];
  const dest = codexSkillLinkPath(id);
  const st = pathStat(dest);
  if (st) {
    if (!st.isSymbolicLink()) {
      log(`Codex skill: ${dest} exists and is not ours — leaving it alone`);
    } else {
      fs.unlinkSync(dest);
      removed.push(dest);
    }
  }

  // Remove only the files DeepSteve creates. If anything else is present in the
  // backing directory, rmdirSync leaves it intact rather than clobbering it.
  const store = codexSkillStorePath(id);
  const skillFile = path.join(store, 'SKILL.md');
  if (pathStat(skillFile)?.isFile()) {
    fs.unlinkSync(skillFile);
    removed.push(skillFile);
  }
  try { fs.rmdirSync(store); } catch {}
  return removed;
}

function removeClaudeSkill(id) {
  const dest = skillDestPath(id);
  if (!pathStat(dest)) return [];
  fs.unlinkSync(dest);
  return [dest];
}

// `reason` is required by convention, not by the signature: an unexplained skill
// artifact appearing or vanishing is the thing that made #641 take a day to trace.
function installSkill(id, reason = 'enabled') {
  const fileChanged = installSkillFile(id);
  const codexChanged = installCodexSkill(id);
  const changed = fileChanged || codexChanged;
  if (changed) log(`Skill installed: ${id} (${reason})`);
  return changed;
}

function removeSkill(id, reason = 'unknown') {
  const removed = [...removeClaudeSkill(id), ...removeCodexSkill(id)];
  if (removed.length) log(`Skill removed: ${id} (${reason}) — ${removed.join(', ')}`);
  return removed.length > 0;
}

// Reconcile enabled skills on startup across both agent formats. Enabled skills
// are installed, disabled known skills are absent, and invalid/missing entries
// are removed from settings.
//
// It always logs a one-line summary naming the home it managed. That line is cheap
// and it is the line whose absence made #641 invisible: a second instance pruned the
// developer's real ~/.claude and nothing anywhere recorded that it had happened.
function reconcileSkills() {
  try {
    if (AGENT_HOME !== os.homedir()) {
      log(`Skills: managing ${AGENT_HOME}, not ${os.homedir()} (DEEPSTEVE_HOME is set)`);
    }
    const requestedSkills = Array.isArray(settings.enabledSkills) ? settings.enabledSkills : [];
    const validSkills = [];
    const enabledSet = new Set();
    for (const id of requestedSkills) {
      if (!SKILL_ID_RE.test(id)) continue;
      const src = path.join(SKILLS_DIR, `${id}.md`);
      if (!fs.existsSync(src) || enabledSet.has(id)) continue;
      validSkills.push(id);
      enabledSet.add(id);
    }

    const knownSkills = fs.existsSync(SKILLS_DIR)
      ? fs.readdirSync(SKILLS_DIR)
        .filter(file => file.endsWith('.md') && SKILL_ID_RE.test(file.slice(0, -3)))
        .map(file => file.slice(0, -3))
      : [];
    let installed = 0;
    let removed = 0;
    for (const id of knownSkills) {
      if (enabledSet.has(id)) installed += installSkill(id, 'enabled in settings') ? 1 : 0;
      else removed += removeSkill(id, 'not in enabledSkills') ? 1 : 0;
    }
    // Also clean valid settings entries whose canonical source disappeared.
    for (const id of requestedSkills) {
      if (SKILL_ID_RE.test(id) && !enabledSet.has(id)) {
        removed += removeSkill(id, 'source skills/*.md is gone') ? 1 : 0;
      }
    }
    if (validSkills.length !== requestedSkills.length) {
      settings.enabledSkills = validSkills;
      saveSettings();
    }
    log(`Skills reconciled: ${validSkills.length} enabled, ${installed} installed, ${removed} removed (home: ${AGENT_HOME})`);
  } catch (e) {
    log('Skills reconciliation failed:', e.message);
  }
}

// Provision a custom profile's config dir (#537/#543) so it sees the same deepsteve
// skills as ~/.claude: <configDir>/commands/deepsteve -> SKILL_DEST_DIR.
// A symlink, not a copy — enable/disable/reconcile keep a single write target.
function provisionProfileSkills(configDir) {
  try {
    if (!configDir || !fs.existsSync(configDir)) return; // profile not initialized yet
    const dest = path.join(configDir, 'commands', 'deepsteve');
    let st = null;
    try { st = fs.lstatSync(dest); } catch {}
    if (st) {
      if (!st.isSymbolicLink()) {
        log(`Profile skills: ${dest} exists and is not ours — leaving it alone`);
        return;
      }
      if (fs.readlinkSync(dest) === SKILL_DEST_DIR) return; // already correct
      fs.unlinkSync(dest); // stale link → repoint
    }
    fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });   // avoid a dangling link
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(SKILL_DEST_DIR, dest);
    log(`Profile skills: linked ${dest} -> ${SKILL_DEST_DIR}`);
  } catch (e) {
    log('Profile skills provisioning failed:', e.message);
  }
}

// Provision every custom config profile (#543). Accepts an explicit list (the settings
// sideEffect passes the incoming value, since settings.customAgentConfigs may not be
// assigned yet); defaults to the live settings list (startup).
function provisionAllProfileSkills(profiles) {
  const list = Array.isArray(profiles) ? profiles
    : (Array.isArray(settings.customAgentConfigs) ? settings.customAgentConfigs : []);
  for (const p of list) provisionProfileSkills(expandTilde(p && p.configDir));
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
    if (!fs.existsSync(MODS_DIR)) return res.json({ mods: [], deepsteveVersion: pkg.version, mcpReady: isMcpReady() });
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
        // `tools` is DERIVED from the mod's tools.js at MCP init and is never read from
        // the manifest (#644). It sits after the spread deliberately — later key wins, so
        // a third-party mod installed via POST /api/mods/install, whose manifest we do not
        // control and which may still ship a stale tools array, cannot override the real
        // answer. A mod with no tools.js reports [].
        // `kind` (#673) is derived the same way and sits after the spread for the same
        // reason: it decides which section of the Mods modal the thing appears under, and a
        // manifest we did not write must not be able to file itself under `app`.
        mods.push({ id: entry.name, source, compatible, ...manifest, tools: getModTools(entry.name), kind: modKind(manifest) });
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
              // Hardcoded, not derived: a skill is never a place you work from, so a skill
              // file cannot talk its way into the Apps section — the same rule
              // test/unit/apps-rail.test.js already pins for getApps().
              kind: 'skill',
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
    // mcpReady is false for the brief window after boot in which initMCP is still awaiting
    // the ESM SDK import and the tool index is empty — it lets a consumer tell "this mod
    // registers no tools" apart from "nothing has been scanned yet" (#644).
    res.json({ mods, deepsteveVersion: pkg.version, mcpReady: isMcpReady() });
  } catch (e) {
    res.json({ mods: [], deepsteveVersion: pkg.version, mcpReady: isMcpReady() });
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
    installSkill(id, 'enabled via API');
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
  const claudeDest = skillDestPath(id);
  const codexDest = codexSkillLinkPath(id);
  // Validate managed destinations remain inside their DeepSteve-owned parents.
  if (!path.resolve(claudeDest).startsWith(path.resolve(SKILL_DEST_DIR) + path.sep)
      || !path.resolve(codexDest).startsWith(path.resolve(CODEX_SKILLS_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid skill ID' });
  }
  try {
    removeSkill(id, 'disabled via API');
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

  // Automation's configured repo overrides caller CWD.
  //
  // #632: this used to be `if (meta.repo && fs.existsSync(meta.repo))`, which on a
  // repo that had been deleted or renamed silently DECLINED the override and left cwd
  // at the caller's — or, with no caller, at $HOME. So the automation ran in the home
  // directory under its own name, which is this issue's symptom by another route. A
  // configured repo IS the intended cwd: honor it, and let the check below refuse it
  // if it is gone. expandTilde because a `~/…` repo previously failed that existsSync
  // and took the same silent fallback.
  if (meta.repo) cwd = expandTilde(meta.repo);

  // Covers both inputs: the configured repo above, and the caller's own cwd, which is
  // the one that goes stale on its own (a worktree merged away under the session that
  // triggered this).
  const cwdProblem = spawnCwdProblem(cwd);
  if (cwdProblem) {
    log(`[API] start-automation ${automationId} refused: ${cwdProblem.message}`);
    return res.status(400).json({ error: cwdProblem.message, code: cwdProblem.code, cwd: cwdProblem.cwd });
  }

  const id = randomUUID().slice(0, 8);
  const claudeSessionId = agentType === 'codex' ? null : randomUUID();
  const agentConfig = getAgentConfig(agentType);
  const icon = meta.icon || '⚡';
  const autoName = meta.name || automationId;
  const name = `${icon} ${autoName}`;

  const spawnArgs = getSpawnArgs(agentType, { sessionId: claudeSessionId, shellId: id });
  // spawnSession returns the engine that actually spawned — it can fall back from
  // tmux to node-pty (#620), and engineType must record what happened.
  const sessionEngine = spawnSession(getDefaultEngine(), id, agentType, spawnArgs, cwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, windowId: windowId || null, cwd, agentType, configDir }) });
  const engineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';
  log(`[API] start-automation "${automationId}": id=${id}, agent=${agentType}, engine=${engineType}, cwd=${cwd}`);
  shells.set(id, { clients: new Set(), cwd, claudeSessionId, agentType, codexHomeId: agentType === 'codex' ? id : null, configDir: configDir || null, engine: sessionEngine, engineType, worktree: null, windowId: windowId || null, name, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), prefill: true });
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

// ─────────────────────────────────────────────────────────────── Timelapse (#667)
//
// A run is a directory of NNNN.png + NNNN.json pairs plus a run.json manifest. The
// browser drives the cadence (capture needs a live browser, so it has to), and sends the
// picture together with the half of the snapshot only it knows — tab strip order, titles,
// which tab is active, whether the window had focus. The daemon joins on the half only IT
// knows (agent type, worktree, cwd, busy/idle) and writes the pair. See
// timelapse-snapshot.js for why the join lives server-side.

/**
 * runId is a path segment supplied by a client, so it is validated twice: a charset that
 * cannot express `/` or `..` at all, and then a containment check with the same helper
 * every other path-taking route uses. Returns the absolute dir, or null to refuse.
 */
function timelapseRunDir(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(runId)) return null;
  const dir = path.resolve(TIMELAPSE_DIR, runId);
  return pathInside(dir, path.resolve(TIMELAPSE_DIR)) && dir !== path.resolve(TIMELAPSE_DIR)
    ? dir : null;
}

/** Read a run's sidecars, oldest first. Skips anything unparseable rather than throwing. */
function readTimelapseFrames(dir) {
  const frames = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return frames; }
  for (const n of names.filter(n => /^\d+\.json$/.test(n)).sort()) {
    try { frames.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch {}
  }
  return frames;
}

/** Next NNNN for a run. Server-owned, so a browser that lost its state cannot overwrite. */
function nextFrameSeq(dir) {
  let max = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      const m = /^(\d+)\.png$/.exec(n);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {}
  return max + 1;
}

app.post('/api/timelapse/frame', express.json({ limit: '50mb' }), (req, res) => {
  if (!settings.timelapseEnabled) return res.status(403).json({ error: 'Timelapse is disabled' });
  const { runId, dataUrl, startedAt, intervalMs, capturedAt, expectedAt, window: win, tabs } = req.body || {};

  const dir = timelapseRunDir(runId);
  if (!dir) return res.status(400).json({ error: 'Invalid runId' });
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Invalid dataUrl' });
  }
  const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (buf.length === 0) return res.status(400).json({ error: 'Empty image data' });

  try {
    fs.mkdirSync(dir, { recursive: true });
    const seq = nextFrameSeq(dir);
    const name = String(seq).padStart(4, '0');
    const sidecar = {
      runId,
      seq,
      // The time it ACTUALLY happened next to the time it was aiming for. A browser can be
      // a minute late out of a throttled background tab, and the gap between these two is
      // the only honest record of that.
      capturedAt: Number(capturedAt) || Date.now(),
      expectedAt: Number(expectedAt) || null,
      window: win && typeof win === 'object' ? win : {},
      tabs: enrichTabs(tabs, { shells, savedState, sessionInputState, sessionPaths }),
    };
    fs.writeFileSync(path.join(dir, `${name}.png`), buf);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(sidecar, null, 2));

    const manifest = path.join(dir, 'run.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch {}
    fs.writeFileSync(manifest, JSON.stringify({
      runId,
      startedAt: existing.startedAt || Number(startedAt) || sidecar.capturedAt,
      windowId: (sidecar.window && sidecar.window.windowId) || existing.windowId || null,
      intervalMs: Number(intervalMs) || existing.intervalMs || null,
      deepsteveVersion: pkg.version,
      lastFrameAt: sidecar.capturedAt,
      frames: seq,
    }, null, 2));

    res.json({ runId, seq, name });
  } catch (e) {
    log(`[timelapse] Failed to write frame for ${runId}: ${e.message}`);
    res.status(500).json({ error: 'Write failed: ' + e.message });
  }
});

app.get('/api/timelapse/runs', (req, res) => {
  if (!settings.timelapseEnabled) return res.status(403).json({ error: 'Timelapse is disabled' });
  const runs = [];
  let names = [];
  try { names = fs.readdirSync(TIMELAPSE_DIR); } catch { return res.json({ runs }); }
  for (const runId of names) {
    const dir = timelapseRunDir(runId);
    if (!dir) continue;
    let stat = null;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch {}
    let frames = 0, bytes = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^\d+\.png$/.test(f)) frames++;
        try { bytes += fs.statSync(path.join(dir, f)).size; } catch {}
      }
    } catch {}
    runs.push({
      runId,
      windowId: manifest.windowId || null,
      startedAt: manifest.startedAt || null,
      lastFrameAt: manifest.lastFrameAt || null,
      intervalMs: manifest.intervalMs || null,
      frames,
      bytes,
    });
  }
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || a.runId.localeCompare(b.runId));
  res.json({ runs });
});

app.get('/api/timelapse/runs/:runId/summary', (req, res) => {
  if (!settings.timelapseEnabled) return res.status(403).json({ error: 'Timelapse is disabled' });
  const dir = timelapseRunDir(req.params.runId);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'No such run' });
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch {}
  res.json({
    runId: req.params.runId,
    windowId: manifest.windowId || null,
    ...summarizeRun(readTimelapseFrames(dir), manifest.intervalMs),
  });
});

app.delete('/api/timelapse/runs/:runId', (req, res) => {
  const dir = timelapseRunDir(req.params.runId);
  if (!dir) return res.status(400).json({ error: 'Invalid runId' });
  const existed = fs.existsSync(dir);
  // Not gated on timelapseEnabled: turning the feature off must never strand a run's
  // disk usage behind a setting the user just flipped.
  try {
    if (existed) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
  res.json({ deleted: existed });
});

app.get('/api/shells', (req, res) => {
  const active = [...shells.entries()].map(([id, entry]) => ({ id, pid: (entry.engine || ptyEngine).getPid(id), cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', status: 'active', lastActivity: entry.lastActivity || null, connectedClients: entry.clients.size, waitingForInput: !!entry.waitingForInput, lastBelTime: entry.lastBelTime || null, lastInputTime: entry.lastInputTime || null }));
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
// A scheduled run's tab was never owned by a browser, so it is never a "lost
// session" — not while it's in flight (the ungrouped check below) and not after
// it auto-closes (the closed bucket in /api/recoverable-sessions). #597 flagged
// live entries with `scheduled: true`, but tombstones written before that flag
// existed have no such field, and there are hundreds of them; the worktree /
// name shapes minted by mods/scheduled-tasks (`scheduled-<shellId>` worktree,
// `⏰ ` name prefix) are the fallback that catches those.
function isScheduledRun(entry) {
  if (!entry) return false;
  if (entry.scheduled) return true;
  if (/^scheduled-/.test(entry.worktree || '')) return true;
  return /^⏰/.test(entry.name || '');
}

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
      // How many browsers are showing this session right now (#680). Carried on the
      // shared view rather than derived by a second pass over `shells`, so the orphan
      // sweep, /api/windows and /api/recoverable-sessions answer from one builder and
      // cannot drift about what is on screen. Always 0 for a `saved` row — those have
      // no live shell to attach to.
      attached: entry.clients ? entry.clients.size : 0,
    };
    if (!entry.windowId) {
      // Exists, but belongs to no window. For the recover view (#560) these are
      // offerable — except a live session a browser is showing right now
      // (clients > 0): that one isn't lost, it's open.
      //
      // Scheduled runs (#597) are never offerable while unattached. They are
      // spawned with windowId: null and queue their tab via pendingOpens, so
      // between fire and browser attach they look exactly like an orphan — but
      // no browser ever owned the tab, so it can't have been lost. Offering it
      // popped the restore modal on every startup that had a scheduled run in
      // flight. Once a window attaches, entry.windowId is set and the session
      // groups normally, so a crash of THAT window still offers it back.
      if (collectUngrouped && !isScheduledRun(entry) && !(status === 'active' && entry.clients && entry.clients.size > 0)) {
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
//
// #658: the closed + recents buckets are now opt-in via ?include=closed, and the
// default answer omits them. Two reasons, and the second is the load-bearing one:
//
//   1. The restore modal is a WINDOW picker. It offers "you had a tab open with 7
//      sessions in it" — an abstraction that lives entirely in `windows` and
//      `ungrouped`. It never draws the per-session archive, so fetching it is waste.
//   2. Cost. `closed` is every tombstone inside the retention window — 1100 rows on a
//      real install — and each unnamed one costs a `deriveSessionLabel` transcript
//      read. Measured cold: ~448ms of SYNCHRONOUS fs.readSync on the event loop, which
//      stalls every live PTY on the daemon for that window. Paying it for rows nobody
//      renders is the bug; paying it only when someone deliberately opens the archive
//      is the fix.
//
// `closedCount` is always returned because it is free (no file I/O) and it is how the
// client knows whether the archive fallback has anything in it worth asking for.
app.get('/api/recoverable-sessions', (req, res) => {
  const includeClosed = String(req.query.include || '').split(',').includes('closed');
  const { windows, knownSessionIds, ungrouped } = buildWindowsView({ collectUngrouped: true });

  // The archive's membership test, shared by the count and (when asked) the rows
  // themselves, so the number can never disagree with the list.
  const isArchived = (e) => !!e && e.closed && e.agentType !== 'tmux-attach' && !isScheduledRun(e);
  const closedCount = Object.values(savedState).filter(isArchived).length;

  // #632: does restoring this row still have somewhere to go? Restore spawns in the
  // recorded `cwd` verbatim, so stat exactly that — NOT sessionPaths(e).cwd. One rule
  // covers both worktree shapes: Claude records the repo root (and recreates its own
  // worktree), other agents record the worktree path itself.
  //
  // Memoized per request because the closed bucket routinely runs to hundreds of rows
  // over the retention window sharing a handful of directories. Cost is then one stat
  // per distinct path — noise next to deriveSessionLabel, which reads transcript tails
  // for every row on this same endpoint.
  const cwdSeen = new Map();
  const cwdMissing = (cwd) => {
    if (!cwd) return false;
    if (!cwdSeen.has(cwd)) cwdSeen.set(cwd, !!spawnCwdProblem(cwd));
    return cwdSeen.get(cwd);
  };

  // Enrich a session row with worktree + derived label from its state entry.
  const enrich = (session) => {
    const entry = shells.get(session.id) || savedState[session.id];
    return {
      ...session,
      worktree: (entry && entry.worktree) || null,
      label: session.name ? null : deriveSessionLabel(entry),
      cwdMissing: cwdMissing(session.cwd),
    };
  };

  const closed = !includeClosed ? [] : Object.entries(savedState)
    .filter(([, e]) => isArchived(e))
    .map(([id, e]) => ({
      id,
      name: e.name || null,
      label: e.name ? null : deriveSessionLabel(e),
      cwd: e.cwd || null,
      cwdMissing: cwdMissing(e.cwd),
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
  if (includeClosed) {
    for (const [, e] of shells) if (e.claudeSessionId) knownClaudeIds.add(e.claudeSessionId);
    for (const e of Object.values(savedState)) if (e && e.claudeSessionId) knownClaudeIds.add(e.claudeSessionId);
  }
  const recents = !includeClosed ? [] : recentSessions
    .filter(r => !(r.claudeSessionId && knownClaudeIds.has(r.claudeSessionId))
              && !shells.has(r.shellId) && !savedState[r.shellId])
    .map(r => ({
      key: r.key,
      name: r.name || null,
      label: r.name ? null : deriveSessionLabel(r),
      cwd: r.cwd || null,
      cwdMissing: cwdMissing(r.cwd),
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
    closedCount,
  });
});

// Close every session this daemon owns. Tombstones rather than deletes (#561), so a
// conversation stays resurrectable via --resume. Two callers, both of which are only ever
// reachable on a daemon that is by construction not the user's: the test-only killall
// route below, and the idle self-shutdown (#678).
function killAllSessions(reason) {
  const killed = [];
  for (const [id, entry] of shells) {
    killed.push({ id, pid: (entry.engine || ptyEngine).getPid(id) });
    tombstoneSession(id, entry, reason);
    notifyClientsShellExited(id);
    killShell(entry, id, reason);
    shells.delete(id);
  }
  if (killed.length > 0) saveState();
  return killed;
}

// ── The orphan sweep (#680) ───────────────────────────────────────────────────────
//
// The invariant: a live, non-closed session is reachable from at least one UI surface,
// always. Before this, the server's session list and a window's own tab list could
// silently disagree and nothing ever noticed — #680's session ran mid-turn, invisible
// from every surface, until someone tailed this log.
//
// This is the assertion that the invariant holds, and it is deliberately NOT quiet:
// every offender gets a log line naming it. It runs against buildWindowsView() — the
// same builder /api/windows and /api/recoverable-sessions answer from — so the check
// and the surfaces cannot drift about what exists.
//
// It also repairs. Re-emitting open-session to the owning window heals it in place,
// without waiting for that window to be reloaded; the client's own startup
// reconciliation is then a backstop rather than the only cure. The re-emit carries
// `repair: true` so the client can ignore it when the tab is already there.
//
// Capped per session because a client that cannot open the tab (a broken page, an
// extension eating the message) must not be pushed at forever. After the cap we keep
// logging and stop acting — losing the repair is recoverable, a log loop is not.
const MAX_ORPHAN_REPAIRS = 3;
const ORPHAN_SWEEP_MS = 30000;
let orphanSeenSince = new Map();
const orphanRepairs = new Map(); // id → repairs already attempted

function sweepOrphanSessions() {
  const { windows } = buildWindowsView();
  const { orphans, seenSince } = findOrphanSessions({ windows, seenSince: orphanSeenSince, now: Date.now() });
  orphanSeenSince = seenSince;
  for (const id of [...orphanRepairs.keys()]) {
    if (!seenSince.has(id)) orphanRepairs.delete(id); // recovered — a later offence starts fresh
  }

  for (const o of orphans) {
    const done = orphanRepairs.get(o.id) || 0;
    const secs = Math.round(o.forMs / 1000);
    const label = o.name ? ` (${JSON.stringify(o.name)})` : '';
    if (done >= MAX_ORPHAN_REPAIRS) {
      log(`[orphan] ${o.id}${label} still unreachable from window ${o.windowId} after ${secs}s `
        + `and ${done} repair attempt(s) — the session is alive; not re-emitting again`);
      continue;
    }
    orphanRepairs.set(o.id, done + 1);
    log(`[orphan] ${o.id}${label} grouped under live window ${o.windowId} with 0 attached clients `
      + `for ${secs}s — re-emitting open-session (repair ${done + 1}/${MAX_ORPHAN_REPAIRS})`);
    deliverToWindow({ type: 'open-session', id: o.id, cwd: o.cwd, name: o.name, windowId: o.windowId, repair: true }, o.windowId);
  }
}

setInterval(sweepOrphanSessions, ORPHAN_SWEEP_MS).unref();

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
  res.json({ killed: killAllSessions('killed') });
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

// Autopilot (#643): flip a live session's variable. The tab context menu is the
// only caller today. It is a plain server-side write with no delivery of any kind —
// turning it off cancels autopilot at any point before the agent calls
// issue_complete, and turning it on arms nothing until that call either.
app.post('/api/shells/:id/autopilot', (req, res) => {
  const entry = shells.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Shell not found' });
  entry.autopilot = !!req.body?.autopilot;
  saveState();
  broadcastAutopilot(req.params.id);
  log(`[API] autopilot ${entry.autopilot ? 'on' : 'off'} for ${req.params.id}`);
  res.json({ id: req.params.id, autopilot: entry.autopilot });
});

app.get('/api/shells/:id/state', (req, res) => {
  const id = req.params.id;
  const entry = shells.get(id);
  if (!entry) return res.status(404).json({ error: 'Shell not found' });
  res.json({
    waitingForInput: entry.waitingForInput || false,
    lastBelTime: entry.lastBelTime || null,
    lastInputTime: entry.lastInputTime || null,
    lastActivity: entry.lastActivity || null,
    agentType: entry.agentType || 'claude',
  });
});

// Best-effort: the command running in a plain-terminal session right now, or
// null when the shell is idle at its prompt. Computed on demand.
//
// macOS-only, and deliberately gated rather than ported (#621). This is not a path
// difference that a resolveBinary() would fix: procps' `-g` selects by SESSION, so on
// Linux the second call below would return the wrong set of processes while looking
// like it worked. The correct Linux implementation is a /proc walk (tpgid from
// /proc/<pid>/stat field 8, match pgrp field 5 across /proc/*/stat, read cmdline) —
// a different mechanism that deserves its own tests. Returning null degrades one
// optional, cosmetic field of /api/shells/:id/info; nothing asserts it.
function getForegroundCommand(id) {
  if (process.platform !== 'darwin') return null;
  try {
    const entry = shells.get(id);
    if (!entry) return null;
    const pid = (entry.engine || ptyEngine).getPid(id);
    if (!pid) return null;
    const ps = resolveBinary('ps') || '/bin/ps';
    // The tty's foreground process group. If it's the shell itself, we're idle.
    const tpgid = parseInt(execFileSync(ps, ['-o', 'tpgid=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000 }).trim(), 10);
    if (!tpgid || tpgid === pid) return null;
    const out = execFileSync(ps, ['-o', 'command=', '-g', String(tpgid)],
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
    // Kept in lockstep with the get_session_info MCP tool (#519).
    state: sessionInputState(entry),
    metaControls: !!settings.metaControlsEnabled,
  });
});

// --- History: a session's Claude Code transcript, paged (#672) ---
//
// An agent tab cannot have a scrollbar — Claude Code repaints inside its own
// alternate screen, so tmux history and xterm scrollback are both 0 rows and
// there is nothing outside the process for one to attach to. Its transcript is,
// and this is the only way to read it. The pane is public/js/session-history.js.
//
// Paging runs BACKWARDS from the end, because "latest" is where a reader starts,
// and the cursor is a byte offset because Claude Code appends only: an offset,
// unlike a line index, never moves under a growing file. The heavy lifting is in
// two dependency-free modules — transcript-window.js (bytes → lines) and
// transcript-view.js (lines → entries) — so the parts worth testing need no
// daemon. This handler owns only the path, the capability gate and the envelope.

const TRANSCRIPT_LIMIT_DEFAULT = 200;
const TRANSCRIPT_LIMIT_MAX = 500;
const TRANSCRIPT_WINDOW_MIN = 64 * 1024;

/**
 * A bounded non-negative integer from a query string, or `fallback` when absent.
 * Returns null for anything that is not a plain digit string, which the caller
 * turns into a 400 rather than coercing.
 *
 * The split matters. A SIZE (`limit`, `window`) is a hint about how much work to
 * do, so a nonsensical one has a sensible nearest value and clamping keeps the
 * request meaningful — and the clamp is load-bearing, because `?window=1e9`
 * without it is a one-line OOM that any same-origin page can fire (display tabs
 * are trusted, so the auth gate is not a wall here). A CURSOR (`before`, `after`)
 * is a position, and a wrong position is not a smaller position: `?before=-1`
 * clamped to 0 would silently mean "start at the tail", so the pane would page
 * back to the beginning, be handed the tail again, and scroll forever.
 */
function intParam(raw, { fallback = null, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return Math.max(min, Math.min(max, n));
}

app.get('/api/shells/:id/transcript', async (req, res) => {
  const id = req.params.id;
  // A tombstoned session is the case this feature exists for: a live agent's
  // history is one ↑ away inside its own TUI, a closed one's is reachable only
  // here. Tombstoning never deletes the .jsonl (that file is Claude Code's, not
  // ours) and serializeShellEntry persists exactly the fields the path needs.
  // Deliberately NOT falling back to the recentSessions ring buffer: those rows
  // may lack configDir/worktree, and a wrong path silently reads someone else's
  // conversation rather than failing.
  const live = shells.get(id);
  const entry = live || savedState[id];
  if (!entry) return res.status(404).json({ error: 'Session not found' });

  // Validate BEFORE the capability and existence short-circuits below. A
  // malformed cursor is malformed whatever the tab is, and gating validation on
  // agentType made `?before=abc` a 400 on a Claude tab and a 200 on a terminal
  // one — the kind of inconsistency a client only discovers in production.
  const before = intParam(req.query.before, {});
  const after = intParam(req.query.after, {});
  const limit = intParam(req.query.limit, { fallback: TRANSCRIPT_LIMIT_DEFAULT, min: 1, max: TRANSCRIPT_LIMIT_MAX });
  const window = intParam(req.query.window, {
    fallback: TRANSCRIPT_WINDOW.DEFAULT_WINDOW, min: TRANSCRIPT_WINDOW_MIN, max: TRANSCRIPT_WINDOW.MAX_LINE });
  if (before === null && req.query.before !== undefined) return res.status(400).json({ error: 'before must be a non-negative integer' });
  if (after === null && req.query.after !== undefined) return res.status(400).json({ error: 'after must be a non-negative integer' });
  if (limit === null) return res.status(400).json({ error: 'limit must be a positive integer' });
  if (window === null) return res.status(400).json({ error: 'window must be a positive integer' });
  if (req.query.before !== undefined && req.query.after !== undefined) {
    return res.status(400).json({ error: 'pass before or after, not both' });
  }

  const agentType = entry.agentType || 'claude';
  const envelope = {
    supported: true,
    exists: false,
    closed: !live,
    live: !!live,
    agentType,
    claudeSessionId: entry.claudeSessionId || null,
    file: null,
    entries: [],
    cursor: { before: null, after: null, hasMore: false },
    stats: null,
  };

  // Not an error: "this agent keeps no transcript" is a property of a perfectly
  // valid session, and the pane has to render it. Routing every legitimate empty
  // state through the error path would make each one look like a failure.
  if (!getAgentConfig(agentType).supportsSessionWatch) {
    return res.json({ ...envelope, supported: false, reason: 'unsupported-agent' });
  }

  const file = transcriptPath(entry);
  if (!file) return res.json({ ...envelope, reason: 'never-prompted' });

  try {
    if (req.query.after !== undefined) {
      // Tail. When nothing was appended this is one stat and ZERO reads, which is
      // why the pane needs no separate "has it changed?" endpoint.
      const page = await TRANSCRIPT_WINDOW.readForwardWindow(file, { after, window });
      const { entries, stats } = normalizeLines({ lines: page.lines });
      return res.json({
        ...envelope, exists: true,
        file: { size: page.size, mtimeMs: page.mtimeMs },
        entries, stats,
        cursor: { before: null, after: page.nextAfter, hasMore: false },
      });
    }

    // Backwards. Keep reading windows until we have `limit` entries or run out of
    // file: a 512 KB window can be entirely `attachment` bookkeeping and yield
    // ZERO entries while history remains, so entry count cannot drive the loop.
    // MAX_PAGE_WINDOWS bounds the work when a stretch of transcript is all noise.
    const MAX_PAGE_WINDOWS = 8;
    let cursor = before;
    let atStart = false;
    let collected = [];
    const total = { lines: 0, entries: 0, dropped: 0, unparsed: 0, oversize: 0, truncatedEntries: 0 };
    let size = 0, mtimeMs = 0;

    for (let i = 0; i < MAX_PAGE_WINDOWS; i++) {
      const page = await TRANSCRIPT_WINDOW.readBackwardWindow(file, { before: cursor, window });
      size = page.size; mtimeMs = page.mtimeMs;
      const { entries, stats } = normalizeLines({ lines: page.lines });
      for (const k of Object.keys(total)) total[k] += stats[k];
      collected = entries.concat(collected);   // oldest-first on the wire
      cursor = page.start;
      atStart = page.atStart || page.start === 0;
      if (atStart || collected.length >= limit) break;
    }

    res.json({
      ...envelope, exists: true,
      file: { size, mtimeMs },
      entries: collected,
      stats: total,
      // `after` seeds the tail poll from this response, so the client needs no
      // extra round trip to start following a live session.
      cursor: { before: cursor, after: size, hasMore: !atStart },
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Claude only writes the file on the first message, so a tab that has never
      // been prompted has no transcript at all. Normal, not broken.
      return res.json({ ...envelope, reason: 'never-prompted' });
    }
    if (e && e.code === 'REWOUND') {
      // The file shrank or was replaced: the cursor was valid when it was issued,
      // but the bytes it named are gone. 409, not 400 — the request was fine.
      return res.status(409).json({ error: 'transcript-rewound', size: e.size });
    }
    log(`Transcript read failed for ${id}: ${e.message}`);
    res.status(500).json({ error: 'Could not read transcript' });
  }
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

  if (cleared.length > 0) {
    saveState();
    // Tell every browser window to drop these rows (#603). Must go over the
    // live-reload channel, not broadcast()/entry.clients: a cleared session has
    // zero session clients by construction, and the window that still holds the
    // tab (e.g. its socket is mid-reconnect after a sleep) is only reachable here.
    const msg = JSON.stringify({ type: 'sessions-cleared', ids: cleared });
    for (const client of reloadClients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  log(`Cleared ${cleared.length} disconnected sessions: ${cleared.join(', ')}`);
  res.json({ cleared });
});

app.post('/api/mkdir', require('express').json(), (req, res) => {
  let dir = req.body.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  dir = expandTilde(dir);
  dir = path.resolve(dir);
  try { fs.mkdirSync(dir, { recursive: true }); res.json({ created: dir }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dirs', (req, res) => {
  let input = req.query.path || '~';
  input = expandTilde(input);
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
  const root = findGitRoot(req.query.cwd || process.env.HOME);
  if (!root) return res.status(400).json({ error: 'Not a git repository' });
  res.json({ root });
});

app.post('/api/git-roots', express.json(), (req, res) => {
  const paths = req.body?.paths;
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be an array' });
  const rootSet = new Map();
  for (const p of paths) {
    // findGitRoot is a pure-fs walk (#553). This loop used to run `zsh -l -c 'git
    // rev-parse'` per path — synchronously, on the same event loop the WS upgrade
    // handshake runs on — so a user with N tabs stalled every pending WS upgrade for
    // ~52ms x N. That was the "upgrades hang under scale" half of #544.
    const root = findGitRoot(p);
    if (root && !rootSet.has(root)) rootSet.set(root, path.basename(root));
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
  if (!name) return res.status(400).json({ error: 'Project name required' });
  const dirs = Array.isArray(b.dirs) ? b.dirs.filter(Boolean) : [];
  const id = (b.id && String(b.id)) || genContextId();
  const existing = contexts.find(c => c.id === id);
  // Preserve the icon when the client omits it (e.g. a name/dirs edit from the
  // editor modal sends no icon) — otherwise editing a context would clear its icon.
  const icon = typeof b.icon === 'string' ? b.icon : (existing ? existing.icon : '');
  // Emoji and uploaded image are mutually exclusive (#579): setting a non-empty emoji
  // drops any stored image (and deletes its file). An omitted or empty `icon` leaves the
  // existing iconImage untouched, so a name/dirs edit can't wipe an image, and clearing
  // is done via DELETE /api/contexts/:id/icon.
  let iconImage = existing ? existing.iconImage || '' : '';
  if (icon) { if (iconImage) removeIconFiles(id); iconImage = ''; }
  // `archived` (#601) is owned solely by POST /api/contexts/:id/archive — a name/dirs
  // edit from the editor modal must never resurrect an archived context (same reason
  // the icon is preserved above).
  // `alwaysShowMods` (#647) is owned solely by POST /api/contexts/:id/always-show-mods,
  // for the same reason `archived` is: a name/dirs edit must not reset a display choice.
  // New projects start with it ON — a project mod is a dashboard, and the whole point of
  // the option is that you don't have to navigate to one to see it.
  if (existing) { existing.name = name; existing.dirs = dirs; existing.icon = icon; existing.iconImage = iconImage; }
  else contexts.push({ id, name, dirs, icon, iconImage, archived: false, alwaysShowMods: true });
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
});

app.delete('/api/contexts/:id', (req, res) => {
  const idx = contexts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  contexts.splice(idx, 1);
  removeIconFiles(req.params.id); // clean up any uploaded icon file (#579)
  saveContexts();
  broadcastContexts();
  res.json({ deleted: req.params.id });
});

// --- Per-context uploaded icon images (#579) ---
// PNG/SVG chosen via the rail right-click → Set icon… → Choose image… flow. Stored under
// ~/.deepsteve/icons/<id>.<ext> and served back (authed) to the UI, which renders them via
// <img> only (never inlined) so a crafted SVG can't script in our origin.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Best-effort "is this really the format it claims?" check on the raw bytes, so an
// arbitrary file renamed .png/.svg isn't stored and later served with an image type.
function iconBytesLookValid(ext, buf) {
  if (!buf || !buf.length) return false;
  if (ext === 'png') return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
  if (ext === 'svg') return /<svg[\s>]/i.test(buf.subarray(0, 1024).toString('utf8'));
  return false;
}

// Upload/replace a context's icon image. Raw binary body (mirrors the drops PUT); the
// global express.json() parser is a no-op for non-JSON content types, so no skip-list
// entry is needed. Sets iconImage (the ext) and drops any emoji (mutual exclusivity).
app.put('/api/contexts/:id/icon', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const ext = String(req.query.ext || '').toLowerCase();
  if (ext !== 'png' && ext !== 'svg') return res.status(400).json({ error: 'ext must be png or svg' });
  const ctx = contexts.find(c => c.id === req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Project not found' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'Empty image data' });
  if (!iconBytesLookValid(ext, buf)) return res.status(400).json({ error: `Not a valid ${ext.toUpperCase()} image` });
  try {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ICONS_DIR, `${ctx.id}.${ext}`), buf);
    // Drop the other extension so png→svg (or svg→png) never leaves a stale file that a
    // later loader could pick up.
    const stale = ext === 'png' ? 'svg' : 'png';
    try { fs.unlinkSync(path.join(ICONS_DIR, `${ctx.id}.${stale}`)); } catch {}
  } catch (e) {
    return res.status(500).json({ error: 'Write failed: ' + e.message });
  }
  ctx.iconImage = ext;
  ctx.icon = ''; // image wins over emoji
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
});

// Serve a context's icon image (authed via the positional gate). Rendered on the client
// only through <img>; the nosniff + sandbox CSP headers are defense-in-depth for anyone
// who navigates straight to this URL.
app.get('/api/contexts/:id/icon', (req, res) => {
  const ctx = contexts.find(c => c.id === req.params.id);
  const ext = ctx && ctx.iconImage;
  if (ext !== 'png' && ext !== 'svg') return res.status(404).end();
  const file = path.join(ICONS_DIR, `${ctx.id}.${ext}`);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(ext === 'svg' ? 'image/svg+xml' : 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(file);
});

// Clear a context's icon entirely (emoji AND image) → falls back to the derived glyph.
// Backs the UI's "Clear icon" action.
app.delete('/api/contexts/:id/icon', (req, res) => {
  const ctx = contexts.find(c => c.id === req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Project not found' });
  if (ctx.iconImage) removeIconFiles(ctx.id);
  ctx.icon = '';
  ctx.iconImage = '';
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
});

// Archive / unarchive a context (#601). Archived contexts keep all of their stored
// state (dirs, icon, order) but drop out of the context rail's main list, the ⌘↑/↓
// cycle, and the new-tab auto-reveal — they're browsable from the rail's "Archived"
// section. Deliberately its own route rather than a field on the upsert, so a plain
// name/dirs edit can't flip it. Scheduled Tasks still sees archived contexts (a
// dormant project's tasks must keep firing), so nothing gates ctx.getContexts().
app.post('/api/contexts/:id/archive', (req, res) => {
  const ctx = contexts.find(c => c.id === req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Project not found' });
  ctx.archived = req.body?.archived === true;
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
});

// Always show this project's mods (#647). Off, a project's mod rows are drawn in the
// rail only while that project is the active one — the rule every other project-mod
// launcher follows. On (the default), they are drawn under its row whatever is
// selected, so a dashboard is visible at a glance instead of two clicks away.
//
// Per-project and persisted, so it rides contexts.json like `archived` — and like
// `archived` it gets its own route rather than a field on the upsert, so an edit from
// the project editor can't flip it. It is deliberately NOT a browser-local preference
// (the way compact view is): which projects are worth watching is a property of the
// projects, and should follow the user to another window and another machine.
app.post('/api/contexts/:id/always-show-mods', (req, res) => {
  const ctx = contexts.find(c => c.id === req.params.id);
  if (!ctx) return res.status(404).json({ error: 'Project not found' });
  ctx.alwaysShowMods = req.body?.alwaysShowMods !== false;
  saveContexts();
  broadcastContexts();
  res.json({ contexts });
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

function restoreShellIdForRecentSession(recent, mintId = () => randomUUID().slice(0, 8)) {
  if (recent.agentType === 'codex' && /^[0-9a-f]{8}$/.test(recent.codexHomeId || '')) {
    return recent.codexHomeId;
  }
  return mintId();
}

// Restore a recent session and pre-seed savedState with the stored config. Claude
// keeps its existing fresh-shell behavior. A Codex home is also the tab's runtime
// isolation boundary, so reuse that identity: repeated restores converge on one
// live shell instead of launching concurrent Codex processes against the same
// history/sqlite files. The client then connects through the normal resume path,
// so this works from any browser without duplicating spawn logic.
app.post('/api/recent-sessions/:key/restore', (req, res) => {
  const r = recentSessions.find(s => s.key === req.params.key);
  if (!r) return res.status(404).json({ error: 'Recent session not found' });
  const newId = restoreShellIdForRecentSession(r);
  const codexRestoreId = r.agentType === 'codex' ? newId : null;
  if (!shells.has(newId)) savedState[newId] = {
    cwd: r.cwd,
    claudeSessionId: r.claudeSessionId,
    agentType: r.agentType,
    codexHomeId: codexRestoreId || r.codexHomeId || null,
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

/**
 * Attach `worktree` to the issue rows a response is about to carry (#689).
 *
 * "This issue already has work parked in it" is on disk and nothing surfaced it, so
 * the picker gave no hint before you clicked. Three properties this has to keep:
 *
 * - **Bounded.** A response carries at most `perPage` rows, so this is at most five
 *   statSyncs plus — only if one of them hit — a single `for-each-ref`. A repo with no
 *   issue worktrees adds no subprocess at all.
 * - **Never fatal.** The issue list has to work when git doesn't; every field is
 *   simply absent on any error, and the whole thing is wrapped.
 * - **Not cached.** It decorates the response, never `issueCache`'s rows: those are
 *   the raw `gh` payload shared by every window, and writing derived state into them
 *   would serve a stale badge for the rest of the TTL.
 *
 * `dirty` is deliberately NOT here — it is a `git status` per row, five subprocesses
 * for a list. It belongs to /api/issue-worktree, which answers about one issue.
 */
function withWorktreeInfo(cwd, issues) {
  try {
    const names = issues.map(i => issueWorktreeName(i.number));
    const statuses = worktreeStatuses({ repoRoot: cwd, names });
    if (!statuses.size) return issues;
    return issues.map(i => {
      const s = statuses.get(issueWorktreeName(i.number));
      return s ? { ...i, worktree: s } : i;
    });
  } catch {
    return issues;
  }
}

app.get('/api/issues', (req, res) => {
  let cwd = req.query.cwd || process.env.HOME;
  // Deliberately NOT findGitRoot()'d: startIssueSession and ensureWorktree use the cwd
  // they are given, so the badge has to describe the directory the start path will
  // really look in. (The picker always sends a resolved git root anyway.)
  cwd = expandTilde(cwd);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 5;
  const limit = perPage * page;
  const cacheKey = `${cwd}:${limit}`;
  const cached = issueCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ISSUE_CACHE_TTL) {
    const pageIssues = cached.data.slice((page - 1) * perPage);
    return res.json({ issues: withWorktreeInfo(cwd, pageIssues), hasMore: pageIssues.length === perPage });
  }
  const gh = resolveBinary('gh');
  if (!gh) return res.status(500).json({ error: 'gh not found on PATH' });
  execFile(gh, ['issue', 'list', '--json', 'number,title,body,labels,url', '--limit', String(limit)],
    { cwd, encoding: 'utf8', timeout: 15000 },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message });
      try {
        const all = JSON.parse(stdout);
        issueCache.set(cacheKey, { data: all, ts: Date.now() });
        const pageIssues = all.slice((page - 1) * perPage);
        res.json({ issues: withWorktreeInfo(cwd, pageIssues), hasMore: pageIssues.length === perPage });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
});

/**
 * The authoritative answer for ONE issue, at the moment the user clicks (#689).
 *
 * Everything the picker's list badge cannot afford or cannot know:
 *
 * - `dirty`, the uncommitted-file count. This is the discriminator that matters — a
 *   branch can be 0 commits ahead and still hold a day of unstaged work, and without
 *   it "Resume" and "Start fresh" are a coin flip.
 * - `liveSessions`, because another tab already editing that worktree is the one fact
 *   that should flip the default answer.
 * - `freshName`, so the "Start fresh" button can name the worktree it would create.
 *   Minted here only to LABEL the button; the name that actually gets used is minted
 *   again server-side at spawn (see the WS create block), so nothing racy travels
 *   through the browser.
 *
 * Never an error: a repo we cannot read answers `worktree: null` and the picker simply
 * starts the session the way it always did.
 */
app.get('/api/issue-worktree', (req, res) => {
  const cwd = expandTilde(req.query.cwd || process.env.HOME);
  const number = parseInt(req.query.number, 10);
  if (!Number.isFinite(number)) return res.status(400).json({ error: 'number is required' });
  const name = validateWorktree(issueWorktreeName(number));
  try {
    const worktree = name && worktreeExists(cwd, name) ? worktreeStatus({ repoRoot: cwd, name }) : null;
    res.json({
      worktree,
      freshName: worktree ? freshWorktreeName(cwd, name, { reserved: reservedWorktreeNames() }) : null,
      liveSessions: worktree ? sessionsInWorktree(worktree.path) : [],
    });
  } catch (e) {
    log(`[API] issue-worktree #${number} failed: ${e.message}`);
    res.json({ worktree: null, freshName: null, liveSessions: [] });
  }
});

/**
 * Render `autopilot=<on|off>(<why>)` for a start line (#653).
 *
 * The value on its own does not answer "why did this session come up with Autopilot
 * off?" — "the caller passed false" and "the issueAutopilot setting is false" are
 * different bugs with different fixes, and the log used to distinguish neither.
 *
 * The `setting=` clause is appended only when an explicit boolean CONTRADICTS the
 * remembered preference, because that is the case that silently redefines what the
 * user asked for: MCP start_issue exposes `autopilot` as an agent-settable argument,
 * and a model that helpfully fills in `autopilot: false` is exactly what this makes
 * visible. When the two agree there is nothing to explain, so the line stays terse.
 */
function autopilotLogLabel(on, explicit) {
  const value = on ? 'on' : 'off';
  if (!explicit) return `${value}(setting)`;
  const pref = !!settings.issueAutopilot;
  return on === pref ? `${value}(explicit)` : `${value}(explicit, setting=${pref ? 'on' : 'off'})`;
}

/**
 * The one `[issue] #N:` start line, shared by every start path (#653).
 *
 * #642 unified the three implementations behind startIssueSession() and, in doing so,
 * dropped the MCP tool's own `[MCP] start_issue #N:` line — so an issue session started
 * by MCP, by POST /api/start-issue or by the wand picker became indistinguishable after
 * the fact. `source` is a parameter, never guessed from the call stack; a caller that
 * forgets it shows up as `unknown` rather than claiming a surface it isn't.
 */
function logIssueStart({ number, id, source, agentType, engineType, worktree, cwd, on, explicit, stages, resume }) {
  // `stages` reports whether this session was given the workflow stages (#668). "Started
  // with stages" and "started without" are different runs and the log has to say which.
  // An omitted argument reads `unknown` rather than `off`, for the same reason `source`
  // defaults to it: a caller that forgot must not be able to claim a state it never chose.
  // `resume` (#689) names what the session walked into. Worth a clause of its own
  // rather than a bare yes/no: "resumed a branch with 4 commits" and "resumed an empty
  // leftover directory" produce very different first turns, and after the fact this
  // line is the only place that distinguishes them.
  const resumed = resume
    ? `, resume=${resume.commits == null ? '?' : resume.commits}c/${resume.dirty == null ? '?' : resume.dirty}d@${resume.head || '?'}`
    : '';
  log(`[issue] #${number}: id=${id}, source=${source}, agent=${agentType}, engine=${engineType}, `
    + `worktree=${worktree || 'none'}, cwd=${cwd}, autopilot=${autopilotLogLabel(on, explicit)}, `
    + `stages=${stages == null ? 'unknown' : (stages ? 'on' : 'off')}${resumed}`);
}

/**
 * The workflow-stage text a starting issue session gets, or null (#668).
 *
 * The single reader of the `issueStagesEnabled` setting, for the same reason
 * renderIssuePrompt is the single reader of `wandPromptTemplate`. Callers capture the
 * result ONCE per start: startIssueSession renders the prompt twice — inline body now,
 * gh-fetch body seconds later inside a `.then()` — and logs the decision at spawn, so
 * three live reads would let a Settings flip mid-flight produce a log line describing a
 * prompt nobody got. This is also where #669 branches, when the stages have to name a
 * tool only the daemon can confirm is registered.
 */
function issueStagesText() {
  return settings.issueStagesEnabled ? WORKFLOW_STAGES : null;
}

/**
 * The sessions currently living in a given worktree directory (#689).
 *
 * `shells` already knows this and nothing asked it. Two agents editing one worktree is
 * the genuinely dangerous state a resume can walk into — far more so than stale
 * commits — and it costs an in-memory scan. sessionPaths() is what makes the two
 * spawn shapes comparable: a Claude session records the repo root as its cwd and works
 * in the subdirectory, every other agent records the subdirectory itself.
 */
/**
 * Worktree names live sessions are already holding (#689).
 *
 * `freshWorktreeName` cannot see these on disk: a Claude session creates its worktree
 * directory *itself*, after spawn, so between "Start fresh" and the agent getting there
 * neither the directory nor the branch exists — and a second fresh start in that window
 * would be handed the same name and put two agents in one checkout. Only the daemon
 * knows what it has spawned, so it is the daemon that supplies the list.
 */
function reservedWorktreeNames() {
  const out = [];
  for (const entry of shells.values()) if (entry.worktree) out.push(entry.worktree);
  return out;
}

function sessionsInWorktree(wtPath, exceptId = null) {
  if (!wtPath) return [];
  const out = [];
  for (const [id, entry] of shells) {
    // `exceptId` is load-bearing on the picker's path, where the entry already exists
    // by the time we ask: an agent without native --worktree records the worktree
    // directory as its own cwd, so without this a session would report itself as the
    // other session it must coordinate with.
    if (id === exceptId) continue;
    if (sessionPaths(entry).cwd === wtPath) out.push({ id, name: entry.name || null });
  }
  return out;
}

/**
 * The "you are resuming" block a starting issue session gets, or null (#689).
 *
 * The single composer, for the same reason issueStagesText() is the single reader of
 * `issueStagesEnabled`: `renderIssuePrompt` takes TEXT, so exactly one place decides
 * what a resumed session is told. The wording itself lives in issue-prompt.js beside
 * the other prompt text, where a unit test can call it without a daemon; this wrapper
 * is only the part that needs `shells`.
 */
function issueResumeText(status, exceptId = null) {
  return status ? resumePromptText(status, sessionsInWorktree(status.path, exceptId)) : null;
}

/**
 * What a resumed session carries on its entry, for `issue_complete` to read at the
 * very end (#689).
 *
 * Deliberately a SNAPSHOT of the moment this session started, never a live re-read.
 * The question at completion time is "which of these commits are mine", and only the
 * branch tip as it stood at spawn answers it — `headBefore` turns a vague "there was
 * prior work" into `git log <sha>..HEAD`, which is the difference between an agent
 * that can report its own work and one that claims someone else's.
 *
 * Kept small because it goes through serializeShellEntry into state.json for every
 * resumed session, and it must survive a ./restart.sh between the resume and the
 * completion — the same reason `autopilot` is persisted rather than held in memory.
 */
function resumedStamp(status) {
  if (!status) return null;
  return {
    branch: status.branch || null,
    base: status.base || null,
    headBefore: status.head || null,
    commitsBefore: status.commits == null ? null : status.commits,
    dirtyBefore: status.dirty == null ? null : status.dirty,
    at: Date.now(),
  };
}

/**
 * Start a session for a GitHub issue. THE implementation (#642) — POST
 * /api/start-issue and the MCP start_issue tool both come through here, and the
 * wand picker's WS path shares the prompt rendering with it.
 *
 * This existed three times before, and the copies had drifted in six ways: only
 * two of them inherited the caller's `/rc`, only two called recordRecentSession,
 * one recorded an `engineType` guessed from getDefaultEngine() rather than taken
 * from what spawnSession actually returned, and the two server paths disagreed
 * about which cwd to report to the browser, which cwd pre-flight to run, and
 * whether a start with no browser window open should open one.
 *
 * Returns `{ error: <spawnCwdProblem> }` for a bad cwd — the caller formats it,
 * because an HTTP 400 body and an MCP isError result are not the same shape.
 */
function startIssueSession({ number, title, body, labels, url, cwd, agentType, configDir, windowId, callerId, openBrowser = false, autopilot, source = 'unknown' }) {
  // #651: an omitted `autopilot` means "whatever the user usually wants", not "off".
  // A hard default here is what made every MCP / skill / autonomous start ignore the
  // remembered choice — and those are the paths most runs take. Read live off the
  // settings object so a Settings change applies with no restart; an explicit boolean
  // from a caller that means it still wins.
  const autopilotOn = autopilot == null ? !!settings.issueAutopilot : !!autopilot;
  // #653: which of the two branches above answered is what the log needs — see
  // autopilotLogLabel(). Kept as its own flag rather than re-derived at the log line,
  // so the two can never disagree about what "explicit" meant.
  const autopilotExplicit = autopilot != null;
  // #668: captured ONCE, here, rather than read at each use. This function renders the
  // prompt twice — inline body now, gh-fetch body seconds later inside a .then() — and
  // logs the decision at spawn; a live read at each of those three points would let a
  // Settings flip mid-flight produce a log line that describes a prompt nobody got.
  // Deliberately NOT a parameter: start_issue already exposes `autopilot` as an
  // agent-settable argument and #653's `setting=` clause exists because a model filling
  // that in silently overrode a user preference. An agent that could switch off its own
  // reporting obligation is a strictly worse version of that.
  const stages = issueStagesText();

  // Inherit whatever the caller didn't specify from the calling session.
  const caller = callerId ? shells.get(callerId) : null;
  if (caller) {
    if (!windowId && caller.windowId) windowId = caller.windowId;
    if (!agentType && caller.agentType) agentType = caller.agentType;
    if (!configDir && caller.configDir) configDir = caller.configDir;
    if (!cwd && caller.cwd) cwd = caller.cwd;
  }
  agentType = agentType || 'claude';
  // Custom config profiles are a Claude-only surface (#537): an explicit override
  // to Codex or another agent must not leak CLAUDE_CONFIG_DIR from the caller.
  if (agentType !== 'claude') configDir = null;

  cwd = expandTilde(cwd || process.env.HOME);

  // #632: refuse before ensureWorktree() and before the async issue fetch. Without
  // this the spawn throw becomes a 500 HTML body (there is no try/catch around the
  // spawn below), which tells the caller nothing about which directory is gone.
  const problem = spawnCwdProblem(cwd);
  if (problem) {
    log(`[issue] #${number} refused (${source}): ${problem.message}`);
    return { error: problem };
  }

  // Same guard as the WS path: an issue opened against a repo with no commits yet
  // must not be handed --worktree, or the tab dies before it paints (#656).
  const worktree = usableWorktree(cwd, validateWorktree(issueWorktreeName(number)), { log });

  // #689: read the worktree BEFORE ensureWorktree() below can create one, or the
  // answer is always "brand new". Captured once, like `stages`, because this function
  // renders the prompt twice — inline body now, gh-fetched body seconds later inside a
  // .then() — and by then ensureWorktree has run. Costs one statSync when there is no
  // worktree, which is every ordinary start.
  //
  // There is deliberately no confirm and no `fresh` option on this path: HTTP and MCP
  // have no human to ask, so they resume and report the facts back. Exposing a switch
  // here would also hand an agent that sees an existing worktree "in the way" a way to
  // silently fork the work onto a second branch — the same failure #653 made visible
  // for an agent-settable `autopilot`.
  const resumeStatus = worktree && worktreeExists(cwd, worktree)
    ? worktreeStatus({ repoRoot: cwd, name: worktree })
    : null;
  const resume = issueResumeText(resumeStatus);

  const id = randomUUID().slice(0, 8);
  const claudeSessionId = agentType === 'codex' ? null : randomUUID();
  const codexHomeId = agentType === 'codex' ? id : null;
  const agentConfig = getAgentConfig(agentType);

  // For agents that don't support --worktree natively: manually create worktree
  let spawnCwd = cwd;
  if (worktree && !agentConfig.supportsWorktree) {
    spawnCwd = ensureWorktree(cwd, worktree);
  }

  const spawnArgs = getSpawnArgs(agentType, {
    sessionId: claudeSessionId,
    planMode: settings.wandPlanMode,
    worktree,
    shellId: id
  });

  const name = issueTabName(number, title, settings.maxIssueTitleLength);

  // spawnSession returns the engine that actually spawned — it can fall back from
  // tmux to node-pty (#620), and engineType must record what happened.
  const sessionEngine = spawnSession(getDefaultEngine(), id, agentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, worktree, windowId: windowId || null, cwd: spawnCwd, agentType, configDir, codexHomeId }) });
  const engineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';
  logIssueStart({ number, id, source, agentType, engineType, worktree, cwd: spawnCwd, on: autopilotOn, explicit: autopilotExplicit, stages: !!stages, resume: resumeStatus });
  shells.set(id, { clients: new Set(), cwd: spawnCwd, claudeSessionId, agentType, codexHomeId, configDir: configDir || null, engine: sessionEngine, engineType, worktree: worktree || null, windowId: windowId || null, name, planMode: !!settings.wandPlanMode, autopilot: autopilotOn, resumedWorktree: resumedStamp(resumeStatus), waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(), loading: true });
  wireShellOutput(id);
  emitSessionOpen(id);
  recordRecentSession(id);
  if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
  sessionEngine.onExit(id, () => {
    if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
    handleShellGone(id);
  });
  saveState();

  // Inherit Remote Control from the caller (#519) — queued BEFORE the issue prompt
  // so `/rc` submits first; deliverPromptWhenReady sequences the two. A null
  // callerId is a no-op inside, so this is safe on every path.
  maybeInheritRemoteControl({ newId: id, agentType, isFork: false, parentId: callerId || null });

  // Route prompts through deliverPromptWhenReady so agents get a level-triggered
  // readiness wait or their configured delay. An inline body renders now; without
  // one, fetch from GitHub and render when it lands.
  if (body) {
    deliverPromptWhenReady(id, renderIssuePrompt(settings.wandPromptTemplate, { number, title, labels, url, body }, { stages, resume }));
  } else {
    fetchIssueFromGitHub(number, cwd).then(gh => {
      // `stages` and `resume` are the consts captured at the top, not fresh reads: this
      // closure runs seconds later, after the log line already reported the decision
      // (#668) and — for `resume` — after ensureWorktree may have created the very
      // worktree whose absence it recorded (#689).
      deliverPromptWhenReady(id, renderIssuePrompt(settings.wandPromptTemplate, {
        number,
        title,
        labels: labels || (gh ? gh.labels : null),
        url: url || (gh ? gh.url : null),
        body: gh ? gh.body : null,
      }, { stages, resume }));
    });
  }

  const tabDelivery = deliverToWindow({ type: 'open-session', id, cwd: spawnCwd, name, windowId, loading: true }, windowId, { openBrowser });
  noteSpawnDelivery(id, { tabDelivery, windowId, source: `start_issue #${number} (${source})` });
  // `resumed` (#689) is the facts, not a flag: the MCP path has no human to confirm
  // with, so telling the caller what it walked into is the whole of its answer.
  return { id, name, cwd: spawnCwd, worktree: worktree || null, engineType, autopilot: autopilotOn, resumed: resumeStatus, tabDelivery };
}

app.post('/api/start-issue', (req, res) => {
  const { number, title, body, labels, url, cwd, windowId: rawWindowId, sessionId, agentType: rawAgentType, autopilot } = req.body;
  if (!number || !title) return res.status(400).json({ error: 'number and title are required' });

  // A profile selected as the default agent arrives as agentType='config:<pid>' (or an
  // explicit configProfile field). Resolve it to a concrete dir; the runtime agentType
  // stays 'claude'. Resolve BEFORE caller inheritance so it takes precedence.
  let agentType = rawAgentType;
  let configProfile = req.body.configProfile || null;
  if (agentType && agentType.startsWith('config:')) { configProfile = agentType.slice('config:'.length); agentType = 'claude'; }
  const configDir = configProfile ? resolveConfigDir(configProfile) : null;

  // Pre-flight: ensure we can deliver to a browser before spawning. HTTP-only —
  // an MCP caller always has a session to inherit a windowId from.
  const windowId = rawWindowId || (sessionId && shells.get(sessionId)?.windowId) || null;
  const readyClients = [...reloadClients].filter(c => c.readyState === 1);
  if (!windowId && readyClients.length > 1) {
    log(`[API] start-issue: multiple browser windows open but no windowId resolved`);
    return res.status(400).json({ error: 'Multiple browser windows open. Pass sessionId or windowId to target one.' });
  }

  const result = startIssueSession({
    number, title, body, labels, url, cwd, agentType, configDir, windowId,
    callerId: sessionId || null,
    openBrowser: true,
    source: 'http',
    // Raw, not `!!autopilot` (#651): the coercion is what collapsed an absent field
    // to false before startIssueSession could tell "off" from "not specified".
    autopilot,
  });
  if (result.error) {
    return res.status(400).json({ error: result.error.message, code: result.error.code, cwd: result.error.cwd });
  }
  log(`[API] start-issue: windowId=${windowId}, sessionId=${result.id}, readyClients=${readyClients.length}, clientWindowIds=[${readyClients.map(c => c.windowId).join(',')}]`);
  // tabDelivery (#680): whether the tab actually reached the window that asked for it,
  // went out to the others, or is queued for the next one to connect. Spawning a session
  // and opening a tab for it are two events, and this endpoint used to report only the
  // first.
  res.json({ id: result.id, name: result.name, url: UI_URL, tabDelivery: result.tabDelivery });
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

// --- Meta Controls consent (#519) ---
// When an agent calls meta_type while metaControlsEnabled is off, the server asks
// the human in the browser (same shape as the restart confirm above) instead of
// failing with an opaque error or silently flipping a security gate. Differences
// from the restart flow are deliberate: zero connected browsers means NO consent
// (a security gate is never auto-confirmed), concurrent requests share the one
// pending prompt, and a decline starts a cooldown so a retrying agent can't nag
// the user with modals. Approval flips the persistent metaControlsEnabled setting
// (exactly what the Settings toggle does), so later calls skip the prompt.
const META_CONSENT_TIMEOUT_MS = 60000;
const META_CONSENT_DECLINE_COOLDOWN_MS = 60000;

function sessionLabel(id) {
  const e = shells.get(id);
  if (!e) return id || 'unknown';
  return e.name || (e.cwd ? path.basename(e.cwd) : id);
}

function requestMetaControlsConsent({ requesterId, targetId } = {}) {
  if (settings.metaControlsEnabled) return Promise.resolve('confirmed');
  if (Date.now() - metaConsentDeclinedAt < META_CONSENT_DECLINE_COOLDOWN_MS) return Promise.resolve('declined');
  if (metaConsentState) return metaConsentState.promise; // join the pending prompt
  const clients = [...reloadClients].filter(c => c.readyState === 1);
  if (clients.length === 0) return Promise.resolve('no-clients');

  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const finish = (result) => {
    if (!metaConsentState) return; // already resolved (endpoint vs timeout race)
    clearTimeout(metaConsentState.timeout);
    metaConsentState = null;
    if (result === 'declined') metaConsentDeclinedAt = Date.now();
    if (result === 'confirmed') {
      settings.metaControlsEnabled = true;
      saveSettings();
      broadcastSettings();
      log('[meta-consent] user approved — metaControlsEnabled turned on');
    }
    // Dismiss the modal in every window, not just the one that decided.
    for (const ws of [...reloadClients].filter(c => c.readyState === 1)) {
      try { ws.send(JSON.stringify({ type: 'confirm-meta-controls-resolved', result })); } catch {}
    }
    resolveFn(result);
  };
  const timeout = setTimeout(() => {
    log('[meta-consent] timed out with no browser response');
    finish('timeout');
  }, META_CONSENT_TIMEOUT_MS);
  metaConsentState = { promise, finish, timeout };

  const msg = JSON.stringify({
    type: 'confirm-meta-controls',
    requester: { id: requesterId || null, name: requesterId ? sessionLabel(requesterId) : null },
    target: { id: targetId || null, name: targetId ? sessionLabel(targetId) : null },
  });
  for (const ws of clients) {
    try { ws.send(msg); } catch (e) { log(`[meta-consent] send failed: ${e.message}`); }
  }
  log(`[meta-consent] asking user: requester=${requesterId || '?'} target=${targetId || '?'} (${clients.length} window(s))`);
  return promise;
}

// Browser reply for the consent modal. First response wins; later replies (other
// windows, or after the timeout) get { stale: true }.
app.post('/api/meta-controls-consent', (req, res) => {
  const decision = req.body && req.body.decision;
  if (decision !== 'confirmed' && decision !== 'declined') {
    return res.status(400).json({ error: 'decision must be "confirmed" or "declined"' });
  }
  if (!metaConsentState) return res.json({ stale: true });
  metaConsentState.finish(decision);
  res.json({ ok: true });
});

reconcileSkills();
provisionAllProfileSkills(); // #543: link deepsteve skills into every profile's config dir

// How long to hold off before popping a tab of our own (#665). The grace exists for
// exactly one case: a browser that already has a page of ours loaded is sitting in
// server-probe.js's /healthz loop and will reconnect on its own — a crash respawn under
// KeepAlive / Restart=always, since the intentional-restart case is already excluded by
// the .restarting flag below. It must therefore out-wait that loop's worst-case gap
// between probes, which is server-probe.js's MAX_DELAY_MS plus its jitter. At 5s the two
// were equal and this guard lost its own race by ~300ms; keep them in step, and note that
// test/unit/server-probe.test.js pins the relationship.
const AUTO_OPEN_GRACE_MS = parseInt(process.env.DEEPSTEVE_AUTO_OPEN_GRACE_MS, 10) || 3000;
// ...but nothing can be waiting for us right after a machine boot: no earlier daemon was
// listening, so the restored tab's navigation was refused and there is no page of ours
// running to reconnect. Waiting is then pure dead time on the slowest path we have —
// measured at 62.9s from kernel boot to a usable UI, of which this was 5.3s. A daemon
// crash inside the window costs at worst one extra tab.
const AUTO_OPEN_BOOT_WINDOW_S = parseInt(process.env.DEEPSTEVE_AUTO_OPEN_BOOT_WINDOW_S, 10) || 300;

// Decide canonical-vs-throwaway before anything can open a browser (#678). The marker read
// is what lets an npm install identify itself, so it has to happen first; the listen
// callback below no longer repeats it.
loadInstallSource();
classifyDaemon();

const server = app.listen(PORT, BIND, () => {
  log(`HTTP server listening on ${BIND}:${PORT} — UI at ${UI_URL}`);
  bootMark('HTTP listening');
  if (TEST_MODE) {
    log('*** DEEPSTEVE_TEST_MODE: disposable test instance — killall enabled, browser auto-open and auto-update check disabled ***');
  }
  if (DISPOSABLE) {
    log(`*** Disposable daemon (${DISPOSABLE_REASONS.join(', ')}) — no browser auto-open; idle shutdown ${IDLE_SHUTDOWN_MS > 0 ? `after ${Math.round(IDLE_SHUTDOWN_MS / 60000)} min idle` : 'disabled'}. Set DEEPSTEVE_DISPOSABLE=0 to opt out ***`);
  }
  // Auto-open browser if no clients connect within the grace period.
  // Skipped on restart: restart.sh writes .restarting before unloading the
  // old daemon, so existing browsers get a chance to silently reconnect
  // without a phantom new tab racing in. Cold starts (no marker) still open a
  // tab; how long they wait first is the grace above. Also skipped in test mode
  // — a throwaway test daemon must never pop a tab in (or expose itself to) the
  // developer's browser. Since #678 that reasoning covers every disposable daemon,
  // not only the ones that remembered a flag — openBrowserUrl() refuses on its own,
  // and this skips arming the timer so the "No browser connected" line below can't
  // describe a decision that was never taken.
  let skipAutoOpen = TEST_MODE || DISPOSABLE;
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
    const graceMs = os.uptime() < AUTO_OPEN_BOOT_WINDOW_S ? 0 : AUTO_OPEN_GRACE_MS;
    setTimeout(() => {
      const connected = [...reloadClients].filter(c => c.readyState === 1);
      if (connected.length === 0) {
        log(`No browser connected ${graceMs}ms after startup, opening default browser`);
        openBrowserUrl();
      }
    }, graceMs);
  }

  // Auto-update: kick off the first check after the server is listening (so the
  // GitHub fetch doesn't block boot). The install source itself was already loaded
  // before listen — classifyDaemon() needs it (#678).
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

// --- Idle self-shutdown for a throwaway daemon (#678) ---
// Armed only when DISPOSABLE, so this can never reach the installed daemon; see
// disposable.js for what "disposable" is derived from. The interesting input is
// lastActivityAt: an unattended agent still producing PTY output is NOT idle, so a
// scheduled run with no browser attached keeps the daemon alive for as long as it works.
function newestSessionActivity() {
  let newest = 0;
  for (const [, e] of shells) {
    if (e.lastActivity > newest) newest = e.lastActivity;
    if (e.lastInputTime > newest) newest = e.lastInputTime;
  }
  return newest;
}

// Unlike the normal shutdown, this DESTROYS this daemon's sessions rather than detaching
// them: the whole point is that nothing survives to hold a port, a tmux socket and a set
// of PTYs nobody remembers starting. Every id comes out of our own `shells` map, which is
// what keeps this inside "destroy only what this daemon can positively identify as its
// own" — it never enumerates the socket, and it never goes near kill-server.
function idleShutdown(idleMs) {
  if (shuttingDown) return;
  log(`[idle-watchdog] disposable daemon idle for ${Math.round(idleMs / 1000)}s — closing ${shells.size} session(s) and exiting`);
  const entries = [...shells.entries()];
  killAllSessions('idle-shutdown');
  for (const [id, entry] of entries) {
    const eng = entry.engine || ptyEngine;
    if (entry.agentType === 'tmux-attach' || !eng.canDetach) continue;
    // killShell escalates over ~10s and the tmux session only ends when its pane process
    // does; naming the session directly is what guarantees no ds-* server outlives us.
    try { eng.destroy(id); } catch (e) { log(`[idle-watchdog] destroy ${id} failed: ${e.message}`); }
  }
  // Hand off to the ordinary graceful shutdown for the state save and the exit. Its
  // phase-0 tmux DETACH loop is a no-op now that `shells` is empty — which is precisely
  // the difference between this and a restart.
  process.kill(process.pid, 'SIGTERM');
}

const idleWatchdog = createIdleWatchdog({
  idleMs: IDLE_SHUTDOWN_MS,
  clientCount: () => [...reloadClients].filter(c => c.readyState === 1).length,
  lastActivityAt: newestSessionActivity,
  // holdoffRemaining takes the window explicitly (it has no default — passing none
  // yields NaN, which compares false and silently disables the check). Reuse the
  // detach reaper's window: same question, same right answer.
  holdoffRemaining: () => sleepWatch.holdoffRemaining(DETACH_HOLDOFF_MS),
  isShuttingDown: () => shuttingDown,
  onIdle: idleShutdown,
  log,
});
if (DISPOSABLE) idleWatchdog.start();

// #558 audit sampler: transitions alone cannot reveal a STUCK state (the idle
// timer is armed only by output, so a wrong `false` persists silently). A 5s
// sample of every shell — flag, timing deltas, screen tail — makes stuck states
// visible, and covers emitsBel=false sessions the classifier never touches.
// Reads the setting each tick (same pattern as the power-assertion sync above).
setInterval(() => {
  if (!settings.waitingAuditEnabled) return;
  for (const [id, e] of shells) {
    auditWaiting('sample', id, e, { screen: auditScreenTail(e, 300) });
  }
}, 5000).unref();

// #568 waiting sweep: re-derive every classified session's waiting flag on a 1s
// tick. This is what catches the transition to idle when output STOPS (no chunk
// arrives to trigger reclassify on the data path) and lets any stuck state
// self-correct without fresh bytes — the core defect #558 documented. Cheap: a
// screen-tail slice + a few regex tests per claude session. reclassifyWaiting is
// a no-op for unclassified agents and only broadcasts on a real transition.
// One line per session the moment Remote Control appears or disappears, naming who
// caused it. Everything else is per-EVENT — [rc-check] fires at spawn, [rc-write] when
// we type — so answering "why does this session have Remote Control?" meant correlating
// events by id and reasoning about the ones that were absent. Absence is exactly what
// misleads: a detector that has quietly stopped matching produces the same empty grep
// as a daemon that did nothing, and a whole day was lost to that ambiguity. This is
// STATE, edge-logged, and it names the origin, so the answer is one line and it is
// never inferred from silence.
function checkRcState(id, e) {
  const on = sessionShowsRcPill(id);
  if (on === !!e.rcOn) return;
  e.rcOn = on;
  if (!on) return log(`[rc-state] id=${id} remote-control=off`);
  log(`[rc-state] id=${id} remote-control=on origin=${e.rcInherited ? 'deepsteve-typed-/rc' : 'not-deepsteve (the agent enabled it itself)'}`);
}

setInterval(() => {
  for (const [id, e] of shells) {
    reclassifyWaiting(e, id, 'sweep');
    if (e.agentType === 'claude') checkRcState(id, e);
  }
}, 1000).unref();

// Grace timer for a session whose last client socket closed. Fires only after
// DETACH_GRACE_MS of daemon-awake, client-absent time: if the daemon recently woke
// from sleep (sleepWatch), or this very timer fired far later than it was armed
// for (the daemon was frozen before sleepWatch's own overdue tick could run —
// overdue timers run in due-time order, so the reaper can beat the detector),
// re-arm instead of reaping so a post-wake reconnect always wins the race.
// The deferral rule itself lives on sleepWatch (#627 made this its second caller —
// see sleep-watch.js deferMsFor for why it keys on the due time, not the arm time).
const sleepDeferMs = (dueAt) => sleepWatch.deferMsFor(dueAt, { holdoffMs: DETACH_HOLDOFF_MS });

function armDetachReap(entry, reap, delayMs = DETACH_GRACE_MS) {
  const dueAt = Date.now() + delayMs;
  entry.killTimer = setTimeout(() => {
    if (entry.clients.size > 0) return;
    const deferMs = sleepDeferMs(dueAt);
    if (deferMs > 0) {
      log(`[sleep-watch] detach reap deferred ${Math.ceil(deferMs / 1000)}s (recent wake)`);
      armDetachReap(entry, reap, Math.max(deferMs, 1000));
      return;
    }
    reap();
  }, delayMs);
}

// Daemon-armed deferred session close (#627). Sits beside armDetachReap because they
// are the two timers that can end a session on their own — but they are otherwise
// unrelated: the reaper fires only when the LAST CLIENT left, while this one fires on
// a finished merge whether or not anyone is watching, and is cancelled by input rather
// than by presence. Since #620 a tmux session never arms the reaper at all, so for an
// unattended worktree merge this is the only thing that will ever close the tab.
const sessionAutoClose = createSessionAutoClose({
  closeSession: (id, reason) => closeSession(id, reason),
  getEntry: (id) => shells.get(id),
  // A session asking the user a question is not finished, whatever the idle classifier
  // says: classifyScreenTail deliberately folds permission dialogs into 'waiting'
  // (right for prompt delivery, wrong here) — so a tab blocked on step 8's `gh issue
  // close` permission prompt would otherwise read as idle and get closed mid-question.
  sessionState: (entry) => {
    const permission = getAgentConfig(entry.agentType).screenMarkers?.permission;
    if (permission?.some((re) => re.test(screenTail(entry)))) return 'busy';
    return sessionInputState(entry);
  },
  shouldDefer: sleepDeferMs,
  isShuttingDown: () => shuttingDown,
  log,
});

// Test hook: the setting is in minutes (a 2-minute suite is not a suite), so an
// integration test overrides the resolved delay in ms — same shape as
// DEEPSTEVE_DETACH_GRACE_MS above.
const MERGE_AUTOCLOSE_MS_OVERRIDE = parseInt(process.env.DEEPSTEVE_MERGE_AUTOCLOSE_MS, 10) || 0;
const TERMINAL_RUN_LINGER_MS_OVERRIDE = parseInt(process.env.DEEPSTEVE_TERMINAL_RUN_LINGER_MS, 10) || 0;

// The server owns the policy (how long, and whether at all) so a mod can't invent its
// own; the mod decides only WHETHER this session has finished. Reads the setting live.
//
// `policy` is which of those server-owned delays applies — the mod names the situation,
// never a duration (#631 added the second one). Defaulting it to 'merge' is what keeps
// merge_worktree's existing call site, and its tests, untouched.
const AUTOCLOSE_POLICIES = {
  merge: () => MERGE_AUTOCLOSE_MS_OVERRIDE || (settings.mergeAutoCloseMinutes || 0) * 60000,
  // ?? not || : 0 is a meaningful value here (close immediately, no linger), and the
  // schema entry goes out of its way to make 0 representable.
  'terminal-run': () => TERMINAL_RUN_LINGER_MS_OVERRIDE || (settings.terminalRunLingerSeconds ?? 20) * 1000,
};

function armSessionAutoClose(id, { reason = 'auto-close', policy = 'merge' } = {}) {
  const resolve = AUTOCLOSE_POLICIES[policy];
  if (!resolve) {
    log(`[auto-close] unknown policy "${policy}" for ${id} — not arming`);
    return null;
  }
  return sessionAutoClose.arm(id, { delayMs: resolve(), reason });
}

// --- one-time migration off tmux's shared per-UID socket (#625) ---
//
// Sessions created before this change live on tmux's default socket, and every one of
// them is alive right now: restart.sh stops the old daemon, whose shutdown DETACHES
// tmux sessions rather than killing them (#620). The reattach pass above looked only
// at OUR socket, so it found nothing, and their state.json records are still
// non-closed — i.e. restorable.
//
// Leaving them running is the one option that is actually unsafe. The record says
// "restorable", so the first WS reconnect spawns `claude --resume <same uuid>` in a
// fresh pane on the new socket WHILE the old pane is still working the same worktree
// and writing the same transcript. Two live agents, one conversation. So: end the old
// pane and tombstone the record. The conversation is untouched and comes back on
// reconnect exactly as any other tombstone does (#561); only an in-flight turn is lost.
//
// Deliberately NOT a sweep and deliberately NOT kill-server: this only ever names ids
// that OUR OWN state.json already claims, one `kill-session -t ds-<id>` each. And the
// whole pass is skipped unless such a record exists, so it costs a fresh install
// nothing and goes permanently quiet after the first boot that finds them.
if (tmuxEngine) {
  // One list-sessions per socket, not a has-session per record: an install with a few
  // dozen restorable entries would otherwise fork tmux a few dozen times at boot.
  let onOurs = [];
  try { onOurs = tmuxEngine.listSessions(); } catch { onOurs = []; }
  const stranded = Object.keys(savedState).filter(id => {
    const m = savedState[id];
    return m && !m.closed && m.engineType === 'tmux' && !onOurs.includes(id);
  });
  if (stranded.length > 0) {
    // NOT userTmux() (which is socket:null, i.e. "whatever tmux resolves"): this is a
    // killing path, and it must not inherit its target from ambient state. A tmux client
    // that inherited `TMUX` — as any process started from inside a pane does — ignores
    // TMUX_TMPDIR and talks to the server it is sitting in. So compute the path tmux
    // would have used for a daemon under launchd/systemd, which is where pre-#625
    // sessions actually are, and name it with -S.
    const legacySocket = defaultTmuxSocketPath();
    const legacyTmux = new TmuxEngine({ binary: settings.tmuxBinary, socket: legacySocket });
    let onShared = [];
    try { onShared = legacyTmux.listSessions(); } catch { onShared = []; }
    const migrating = stranded.filter(id => onShared.includes(id));
    for (const id of migrating) {
      const meta = savedState[id];
      log(`tmux: ds-${id} (${meta.name || meta.cwd || 'unnamed'}) predates the socket move ` +
          `(#625) and is still running on ${legacySocket} — ending its old pane. The ` +
          `conversation is intact and resumes when you reopen the tab.`);
      try { legacyTmux.destroy(id); } catch (e) {
        log(`tmux: could not end the old pane for ds-${id}: ${e.message} — reclaim it with ` +
            `\`tmux -S ${legacySocket} kill-session -t ds-${id}\``);
      }
      pendingOpens.drop(id);
      savedState[id] = { ...meta, closed: true, closedAt: Date.now(), closeReason: 'socket-migration' };
    }
    if (migrating.length) {
      log(`tmux: migrated ${migrating.length} pre-#625 session(s) off the shared socket. ` +
          `New sessions live on ${TMUX_SOCKET}.`);
      saveState();
    }
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
  pendingOpens.drop(id); // don't offer a deleted tab to the next browser (#596)
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

// --- tmux session reattach on startup ---
// Surviving tmux sessions are reattached regardless of the default engine setting:
// they exist, and they are ours.
//
// Placement is load-bearing (#626). This must run AFTER the WebSocket servers are
// constructed, because reattaching broadcasts (recentSessions) and `wss`/`httpsWss`
// are `const`/`let` — reading them earlier is a temporal dead zone ReferenceError,
// which is exactly what every session hit on every boot from #620 until #626.
// It is still safe this late: the whole module body runs to completion before the
// event loop turns, so no connection can be served before this returns, wherever in
// the body it sits.
{
  const summary = reattachSurvivingTmuxSessions({
    tmuxEngine, savedState, shells, log, getAgentConfig, wireShellOutput,
    watchClaudeSessionDir, unwatchClaudeSessionDir, handleShellGone, recordRecentSession,
    socketPath: TMUX_SOCKET,
  });
  if (summary.found.length) saveState();
}

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
    log(`[WS] Reload client connected (windowId=${ws.windowId || 'none'}), ${reloadClients.size} total`);
    if (!browserMarked) { browserMarked = true; bootMark('first browser window connected'); }
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
    ws.on('close', (code) => {
      clearInterval(pingInterval);
      reloadClients.delete(ws);
      log(`[WS] Reload client closed (windowId=${ws.windowId || 'none'}, code=${code || 0}), ${reloadClients.size} remaining`);
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
        } else if (parsed.type === 'client-log' && Array.isArray(parsed.entries)) {
          // Error beacon from public/js/client-log.js — page JS errors and failed fetches,
          // delivered over this socket precisely because it works when the page's fetch() doesn't.
          // The HTTP fallback at POST /api/client-log shares appendClientLogEntries, which carries
          // the caps that keep a hostile or broken page from flooding the log.
          appendClientLogEntries(ws.windowId, parsed.entries);
        }
      } catch {}
    });
    // Flush pending open-session messages that match this window (or have no
    // windowId). Anything whose session/display tab is gone, or that has aged out,
    // is discarded rather than delivered (#596).
    if (pendingOpens.length > 0) {
      const { send, droppedStale, droppedExpired } = pendingOpens.takeFor(ws.windowId, isPendingOpenLive);
      for (const msg of send) {
        if (ws.readyState === 1) ws.send(msg);
      }
      if (send.length || droppedStale || droppedExpired) {
        log(`[WS] Flushed ${send.length} pending open-session(s) to reload client (windowId=${ws.windowId}), `
          + `dropped ${droppedStale} stale + ${droppedExpired} expired, ${pendingOpens.length} kept for other windows`);
      }
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

    if (!tmuxEngine) {
      ws.send(JSON.stringify({ type: 'error', message: `tmux not available — ${tmuxUnavailableReason}` }));
      ws.close();
      return;
    }

    // Check tmux session exists. Via the engine (#619): the name is user-supplied
    // and now becomes one argv element instead of being interpolated into
    // `zsh -l -c 'tmux has-session -t "…"'` with only `"` escaped.
    //
    // userTmux() (#625): the name came out of GET /api/tmux-sessions, which lists the
    // user's default per-UID socket — so the existence check and the attach below must
    // ask that same server, not deepsteve's own.
    if (!userTmux().hasSession(tmuxSession)) {
      ws.send(JSON.stringify({ type: 'error', message: `tmux session "${tmuxSession}" not found` }));
      ws.close();
      return;
    }

    const pty = require('node-pty');
    const id = randomUUID().slice(0, 8);
    // The engine owns the attach recipe — resolved absolute path (a bare `tmux` is
    // ENOENT under a LaunchAgent), `-u`, `-T RGB,256` and the locale-filled env
    // (#624), plus the socket flags (#625). This used to be an independent copy of
    // that spawn and drifted from the engine's; asking for it keeps the two attach
    // paths identical by construction. The PTY itself still belongs to this handler,
    // because a tmux-attach tab is a session we don't own and must never kill.
    //
    // userTmux(), not tmuxEngine (#625): the session name came out of
    // GET /api/tmux-sessions, which lists the user's default per-UID socket, so the
    // attach must ask that same server. On a socket:null engine attachSpawnArgs emits
    // no -S at all, which makes this call site byte-for-byte its pre-#625 self.
    const { file: tmuxBin, argv: attachArgv, opts: attachOpts } =
      userTmux().attachSpawnArgs(tmuxSession, initialCols, initialRows);
    const attachPty = pty.spawn(tmuxBin, attachArgv, attachOpts);

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
      terminalScreen: new TerminalScreen({ cols: initialCols, rows: initialRows }),
    };
    shells.set(id, entry);

    attachPty.onData((data) => {
      const e = shells.get(id);
      if (!e) return;
      e.lastActivity = Date.now();
      e.scrollback.push(data);
      e.scrollbackSize += data.length;
      e.terminalScreen.write(data);
      while (e.scrollbackSize > (settings.scrollbackKB * 1024) && e.scrollback.length > 1) {
        e.scrollbackSize -= e.scrollback.shift().length;
      }
      e.clients.forEach((c) => c.send(data));
    });

    attachPty.onExit(() => {
      disposeTerminalScreen(entry);
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
          entry.terminalScreen.resize(parsed.cols, parsed.rows);
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
            disposeTerminalScreen(entry);
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
          disposeTerminalScreen(entry);
          shells.delete(id);
        });
      }
    });
    return;
  }

  let id = url.searchParams.get('id');
  let cwd = url.searchParams.get('cwd') || process.env.HOME;
  cwd = expandTilde(cwd);
  const createNew = url.searchParams.get('new') === '1';
  let worktree = validateWorktree(url.searchParams.get('worktree'));
  // "Start fresh" from the issue picker (#689): the requested worktree already has work
  // in it and the user chose to leave it alone. The NAME is minted server-side, in the
  // create block below, at the moment it is used — a name computed in the browser (or
  // handed out by an earlier request) could be taken by then, and worktree naming is
  // not something the client should know how to do.
  const freshWorktree = url.searchParams.get('fresh') === '1';
  const planMode = url.searchParams.get('planMode') === '1';
  const name = url.searchParams.get('name');
  const windowId = url.searchParams.get('windowId') || null;
  const initialCols = parseInt(url.searchParams.get('cols')) || 120;
  const initialRows = parseInt(url.searchParams.get('rows')) || 40;
  let agentType = url.searchParams.get('agentType') || 'claude';
  const forkFrom = url.searchParams.get('fork');
  const noRestore = url.searchParams.get('noRestore') === '1'; // acting on a server-pushed open-session (#596)
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
  log(`[WS] Saved state: ${Object.keys(savedState).length} entries (${Object.values(savedState).filter(e => e && e.closed).length} closed)`);

  // If client requested a specific ID that doesn't exist, check if we can restore it
  if (id && !shells.has(id) && !createNew) {
    // #596: a client acting on a server-pushed open-session is not asking to
    // restore anything. If the session closed between the pendingOpens flush and
    // this connect, do NOT resurrect its #561 tombstone — a finished scheduled run
    // would come back as a zombie --resume tab pointing at a deleted worktree.
    // Explicit restores (restore modal, TabSessions reconnect, orphan claim) never
    // send noRestore, so /api/recoverable-sessions is untouched, and the tombstone
    // is deliberately left intact for them.
    if (noRestore && savedState[id] && savedState[id].closed) {
      log(`[WS] Refusing to resurrect closed session ${id} (noRestore, closeReason=${savedState[id].closeReason})`);
      ws.send(JSON.stringify({ type: 'gone', id }));
      ws.close();
      return;
    }
    if (savedState[id]) {
      // A passive reconnect (ws-client's post-assignment URL) must never resurrect a
      // session that was closed out from under it — that's how "Clear disconnected"
      // used to undo itself, respawning the agent and eating the tombstone (#603).
      // Explicit restores omit the flag and still resume closed sessions (#560).
      if (savedState[id].closed && url.searchParams.get('noRestore') === '1') {
        log(`[WS] Refusing to resurrect closed session ${id} (noRestore)`);
        ws.send(JSON.stringify({ type: 'gone', id }));
        ws.close();
        return;
      }
      // Restore this session with --resume flag using saved agent session ID
      const restored = savedState[id];
      cwd = restored.cwd;
      // #632: a saved cwd is the likeliest one to have stopped existing — a deleted
      // repo, or a worktree that merge_worktree/prune-worktrees removed since. Refuse
      // rather than restore the conversation into $HOME.
      //
      // This `return` is ABOVE the `delete savedState[id]` further down, and that is
      // the point: the record survives the refusal, so the session stays listed in the
      // restore modal (flagged `cwdMissing`) and works again if the directory comes
      // back. Never move a purge above this — it would destroy exactly the records
      // this refusal exists to protect.
      const restoreCwdProblem = spawnCwdProblem(cwd);
      if (restoreCwdProblem) {
        log(`[WS] Refusing to restore ${id}: ${restoreCwdProblem.message} (record kept)`);
        try { ws.send(JSON.stringify({ type: 'error', code: restoreCwdProblem.code, cwd: restoreCwdProblem.cwd, message: `Failed to restore session: ${restoreCwdProblem.message}` })); } catch {}
        try { ws.close(); } catch {}
        return;
      }
      const claudeSessionId = restored.claudeSessionId;
      const savedWorktree = validateWorktree(restored.worktree);
      const savedAgentType = restored.agentType || 'claude';
      const codexHomeId = restored.codexHomeId || (savedAgentType === 'codex' ? id : null);
      const savedPlanMode = !!restored.planMode;
      const agentConfig = getAgentConfig(savedAgentType);

      const savedEngineType = restored.engineType || 'node-pty';
      // Both reassigned below if the tmux spawn fails and we degrade to node-pty.
      let sessionEngine = getEngineByType(savedEngineType);
      let restoredEngineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';

      // Claude only writes <sessionId>.jsonl once the first message is sent, so a
      // tab that was opened but never prompted has no transcript and `--resume` is
      // guaranteed to fail. Falling back to `-c` then continues the most recent
      // conversation for this cwd — a SIBLING tab's — which is how N same-project
      // tabs collapsed onto one conversation after a restart (#542). Spawn fresh
      // instead, reusing the same session id: it was never used, so nothing is
      // lost, and state.json/TabSessions stay stable.
      let spawnFresh = false;
      if (agentConfig.supportsSessionWatch && claudeSessionId) {
        const transcript = transcriptPath({ cwd, worktree: savedWorktree, configDir: restored.configDir, claudeSessionId });
        spawnFresh = !fs.existsSync(transcript);
        if (spawnFresh) log(`Session ${id} has no transcript at ${transcript} — spawning fresh instead of --resume`);
      } else if (savedAgentType === 'codex') {
        spawnFresh = !codexSessionHomeHasTranscript(codexHomeId);
        if (spawnFresh) log(`Codex session ${id} has no rollout in home ${codexHomeId} — spawning fresh instead of resume --last`);
      }

      log(`Restoring session ${id} in ${cwd} (agent: ${savedAgentType}, engine: ${restoredEngineType}, session: ${claudeSessionId}, worktree: ${savedWorktree || 'none'}, planMode: ${savedPlanMode})`);
      const restoredName = name || restored.name || null;
      traceSession('SPAWN', { path: spawnFresh ? 'fresh' : 'resume', shell: id, name: restoredName, worktree: savedWorktree || null, cwd, claude: claudeSessionId, planMode: savedPlanMode, agent: savedAgentType, engine: restoredEngineType });
      const ptySize = { cols: initialCols, rows: initialRows };

      const argOpts = { sessionId: claudeSessionId, planMode: savedPlanMode, worktree: savedWorktree, shellId: id, model: restored.model, effort: restored.effort, allowedTools: restored.allowedTools };
      const startArgs = spawnFresh ? getSpawnArgs(savedAgentType, argOpts) : getResumeArgs(savedAgentType, argOpts);

      // The connecting client's windowId wins over the saved one: restoring a window
      // into a new browser window (or claiming an orphan) reconnects with a different
      // windowId, and env is fixed at spawn — so passing the stale saved value would
      // hand the agent a DEEPSTEVE_WINDOW_ID whose window no longer exists, and any
      // deliverToWindow() it triggered would land nowhere (#551).
      const restoredWindowId = windowId || restored.windowId || null;
      // Same crash exposure as the new-session path: this runs from the raw WS
      // 'connection' event, so a throw here is uncaught and kills the daemon.
      let spawnedEngine;
      try {
        spawnedEngine = spawnSession(sessionEngine, id, savedAgentType, startArgs, cwd, { ...ptySize, env: sessionEnv(id, { name: restoredName, worktree: savedWorktree, windowId: restoredWindowId, cwd, agentType: savedAgentType, configDir: restored.configDir, codexHomeId }) });
      } catch (e) {
        log(`[WS] Failed to restore shell ${id}: ${e.message}`);
        try { ws.send(JSON.stringify({ type: 'error', code: e.code || null, cwd: e.cwd || null, message: `Failed to restore session: ${e.message}` })); } catch {}
        try { ws.close(); } catch {}
        return;
      }
      sessionEngine = spawnedEngine;
      restoredEngineType = spawnedEngine === tmuxEngine ? 'tmux' : 'node-pty';
      shells.set(id, { clients: new Set(), cwd, claudeSessionId, agentType: savedAgentType, codexHomeId, configDir: restored.configDir || null, engine: sessionEngine, engineType: restoredEngineType, worktree: savedWorktree, name: restoredName, planMode: savedPlanMode, model: restored.model || null, effort: restored.effort || null, allowedTools: restored.allowedTools || null, forkParent: restored.forkParent || null, restored: true, scheduled: !!restored.scheduled, autopilot: !!restored.autopilot, resumedWorktree: restored.resumedWorktree || null, resultItemId: restored.resultItemId || null, resultApprovedAt: restored.resultApprovedAt || null, waitingForInput: false, lastActivity: Date.now(), createdAt: restored.createdAt || Date.now(), windowId: restoredWindowId });
      wireShellOutput(id, initialCols, initialRows);
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
            handleShellGone(id, `restore-gave-up-after-attempt-${restoreAttempt}`);
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
            respawnArgs = getResumeArgs(savedAgentType, { sessionId: entry.claudeSessionId, planMode: entry.planMode, worktree: entry.worktree, shellId: id, model: entry.model, effort: entry.effort, allowedTools: entry.allowedTools });
          } else {
            // The retry also died fast (unusable transcript), or the fresh spawn's
            // reused --session-id collided. Start over under a new id — last attempt.
            tracePath = 'fresh-fallback';
            newClaudeSessionId = randomUUID();
            respawnArgs = getSpawnArgs(savedAgentType, { sessionId: newClaudeSessionId, planMode: entry.planMode, worktree: entry.worktree, shellId: id, model: entry.model, effort: entry.effort, allowedTools: entry.allowedTools });
          }
          log(`Session ${id} exited after ${elapsed}ms — respawning (${tracePath})`);
          traceSession('SPAWN', { path: tracePath, shell: id, name: entry.name || null, worktree: entry.worktree || null, cwd, claudeOld: entry.claudeSessionId, claude: newClaudeSessionId || entry.claudeSessionId, planMode: !!entry.planMode, elapsedMs: elapsed });
          sessionEngine.destroy(id);
          // A throw here would be swallowed by the engine's onExit dispatch, leaving a
          // live-but-deaf tab: destroy() has already run, the shells entry survives, and
          // nothing below re-arms wireShellOutput/armRestoreExit. #632 adds one new way
          // to reach that — the directory vanishing between the restore and this respawn
          // — so retire the session properly instead.
          try {
            spawnSession(sessionEngine, id, savedAgentType, respawnArgs, cwd, { ...ptySize, env: sessionEnv(id, { name: entry.name, worktree: entry.worktree, windowId: entry.windowId, cwd, agentType: savedAgentType, configDir: entry.configDir, codexHomeId: entry.codexHomeId }) });
          } catch (err) {
            log(`Session ${id} respawn failed: ${err.message}`);
            handleShellGone(id, 'respawn-failed');
            return;
          }
          if (newClaudeSessionId) {
            entry.claudeSessionId = newClaudeSessionId;
            entry.forkParent = null;  // fresh id starts an unrelated conversation — drop stale lineage (#503)
          }
          entry.killed = false;
          entry.scrollback = [];
          entry.scrollbackSize = 0;
          wireShellOutput(id, initialCols, initialRows);
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
    // #632: this block is the only place the URL's `cwd` reaches a spawn, so it is
    // the only place a new session can be refused for it. Deliberately the FIRST
    // statement: above `delete savedState[id]`, and above ensureWorktree(), which
    // would otherwise run `git worktree add` against a nonexistent cwd, fail, and
    // log a misleading "Failed to create worktree". Refusing here also names the
    // cwd the client asked for rather than ensureWorktree's fallback.
    //
    // Attaching to a LIVE shell never lands here, on purpose: a running session
    // whose directory was deleted underneath it must stay reachable.
    const cwdProblem = spawnCwdProblem(cwd);
    if (cwdProblem) {
      log(`[WS] Refusing new session in ${cwd}: ${cwdProblem.message}`);
      try { ws.send(JSON.stringify({ type: 'error', code: cwdProblem.code, cwd: cwdProblem.cwd, message: `Failed to start session: ${cwdProblem.message}` })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    // A worktree this checkout cannot host is dropped here rather than passed to the
    // agent, which would exit within a second and take the tab with it. Placed with
    // the cwd guard above and above ensureWorktree() for the same reason it is: this
    // is the last point where the request is still just a request. Restores are
    // deliberately not filtered — see worktree-support.js.
    worktree = usableWorktree(cwd, worktree, { log });

    // "Start fresh" (#689): mint a numbered sibling rather than reusing the occupied
    // name. Nothing is deleted, reset or force-checked-out — the prior worktree and its
    // branch are left exactly as they were, which is the point: a fresh start chosen by
    // mistake must never be the thing that loses a week of parked work. Minted HERE, at
    // the moment of use, so nothing can claim the name in between. A `fresh=1` that
    // arrives on a reconnect cannot mint a second worktree, because this whole block
    // only runs for a genuine create.
    if (freshWorktree && worktree && worktreeExists(cwd, worktree)) {
      const alt = freshWorktreeName(cwd, worktree, { reserved: reservedWorktreeNames() });
      if (alt) {
        log(`[worktree] start-fresh: "${worktree}" is in use, using "${alt}" instead`);
        worktree = alt;
      } else {
        log(`[worktree] start-fresh: no free name beside "${worktree}"; resuming it instead`);
      }
    }

    // #689: the existence test has to happen HERE, before ensureWorktree() below can
    // create the directory — and before the agent can. A Claude session creates
    // `.claude/worktrees/<name>` ITSELF, seconds after spawn, and the picker's issue
    // prompt is delivered later still (deliverPromptWhenReady waits for readiness), so
    // a stat taken at prompt time reports "resuming" for a worktree this very session
    // just made. The latch is a plain boolean read with one statSync; the expensive
    // half runs in the `issue` handler, which is a message callback rather than this
    // connection callback (the event loop #553 exists to protect).
    const worktreeExisted = !!worktree && worktreeExists(cwd, worktree);

    const oldId = id;
    // #554: a create retry re-sends new=1 with the client-minted id — honor it so
    // repeated attempts converge on one shell instead of spawning one per retry.
    // (If the shell WAS created by a prior attempt, shells.has(id) is true and we
    // skip this block entirely, attaching to it below.) Malformed/absent ids
    // (old-JS tabs) fall back to server minting, exactly the old behavior.
    id = (createNew && oldId && /^[0-9a-f]{8}$/.test(oldId)) ? oldId : randomUUID().slice(0, 8);
    // A reaped attempt-1 create under this id is superseded by the live shell we're
    // about to spawn (create/adopt path, same as the restore branch's delete — not a
    // #561 close-path delete). The reaped entry was never attached/prompted, so
    // nothing resurrectable is lost.
    delete savedState[id];
    const sessionId = agentType === 'codex' ? null : randomUUID();
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
    if (forkFrom && shells.has(forkFrom) && agentType === 'claude') {
      const parent = shells.get(forkFrom);
      // Resolve the parent's LIVE transcript tip (#455) — the in-memory claudeSessionId
      // can lag behind a mid-conversation rotation, which would fork an earlier checkpoint.
      const forkParentSession = resolveForkParentSession(forkFrom);
      spawnArgs = ['--resume', forkParentSession, '--fork-session', '--session-id', sessionId];
      if (worktree) spawnArgs.push('--worktree', worktree);
      else if (parent.worktree) spawnArgs.push('--worktree', parent.worktree);
      spawnArgs.push(...mcpConfigArgs(agentType, id));
      configDir = parent.configDir || configDir;  // fork inherits the parent's config profile (#537)
      spawnedPlanMode = false;
      spawnPath = 'fork';
      parentShell = forkFrom;
      parentClaude = forkParentSession;  // record the RESOLVED tip in lineage/trace
      parentWorktree = parent.worktree || null;
      log(`[WS] Forking from shell ${forkFrom} (parent claude session: ${forkParentSession})`);
    } else {
      spawnArgs = getSpawnArgs(agentType, {
        sessionId,
        planMode,
        worktree,
        shellId: id
      });
      spawnedPlanMode = !!planMode;
    }

    const requestedSessionEngine = getEngineByType(requestedEngine || settings.engine);
    log(`[WS] Creating NEW shell: oldId=${oldId}, newId=${id}, agent=${agentType}, engine=${requestedSessionEngine === tmuxEngine ? 'tmux' : 'node-pty'}, session=${sessionId}, worktree=${worktree || 'none'}, cwd=${worktreeCwd}, planMode=${spawnedPlanMode}`);
    // windowId is applied on every connect below, but it has to be set HERE too:
    // saveState() runs at the end of this block, so without it a new session
    // persists windowId:null and its window grouping is missing from state.json
    // until the next periodic save (#551). It also gives the agent a correct
    // DEEPSTEVE_WINDOW_ID, which sessionEnv otherwise reported as ''.
    let sessionEngine;
    try {
      sessionEngine = spawnSession(requestedSessionEngine, id, agentType, spawnArgs, worktreeCwd, { cols: initialCols, rows: initialRows, env: sessionEnv(id, { name, worktree, windowId, cwd: worktreeCwd, agentType, configDir }) });
    } catch (e) {
      // Last resort: even the fallback failed. This handler runs from the raw WS
      // 'connection' event, so letting it throw would be an uncaught exception and
      // take the daemon (and everyone else's sessions) down with it.
      log(`[WS] Failed to spawn shell ${id}: ${e.message}`);
      try { ws.send(JSON.stringify({ type: 'error', code: e.code || null, cwd: e.cwd || null, message: `Failed to start session: ${e.message}` })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    // Record the engine that actually spawned, not the one we asked for — the
    // fallback above can differ, and engineType is what restore and the shutdown
    // detach branch key off.
    const engineType = sessionEngine === tmuxEngine ? 'tmux' : 'node-pty';
    traceSession('SPAWN', { path: spawnPath, shell: id, oldId: oldId || null, name: name || null, worktree: worktree || null, cwd: worktreeCwd, claude: sessionId, planMode: spawnedPlanMode, agent: agentType, engine: engineType, parentShell, parentClaude, parentWorktree });
    // `worktreeExisted` (#689) is the latch, not the facts: a transient boolean, read
    // before anything could have created the directory, and deliberately NOT in
    // serializeShellEntry. It answers one question exactly once, for the `issue`
    // message that arrives moments later; what survives a restart is the
    // `resumedWorktree` snapshot that handler stamps.
    shells.set(id, { clients: new Set(), cwd: worktreeCwd, claudeSessionId: sessionId, agentType, codexHomeId: agentType === 'codex' ? id : null, configDir: configDir || null, engine: sessionEngine, engineType, worktree: worktree || null, worktreeExisted, windowId, name: name || null, planMode: spawnedPlanMode, forkParent: parentClaude, waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now() });
    wireShellOutput(id, initialCols, initialRows);
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
  ws.send(JSON.stringify({ type: 'session', id, restored: entry.restored || false, cwd: entry.cwd, name: entry.name || null, agentType: entry.agentType || 'claude', configDir: entry.configDir || null, engineType: entry.engineType || 'node-pty', claudeSessionId: entry.claudeSessionId || null, worktree: entry.worktree || null, autopilot: !!entry.autopilot, scrollback: hasScrollback, existingClients, waitingForInput: entry.waitingForInput || false, pingPong: true }));

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
      if (parsed.type === 'resize') { getEngine(id).resize(id, parsed.cols, parsed.rows); entry.terminalScreen.resize(parsed.cols, parsed.rows); return; }
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
      if (parsed.type === 'issue') {
        // The wand picker's own start path (#642). It used to render
        // wandPromptTemplate in the *browser*, from a copy fetched over
        // /api/settings — so a user-edited template had two readers that could
        // disagree. The picker now sends the issue fields and the server renders,
        // exactly as it does for /api/start-issue and MCP start_issue. `loading`
        // means the same thing it does for initialPrompt above.
        if (parsed.loading) entry.loading = true;
        // Autopilot (#643) rides the issue message rather than the WS create query,
        // because this path builds its entry before the picker's choice is known.
        // saveState() is what makes the flag survive a restart of a picker-started
        // session — the create path already saved an entry without it. An absent key
        // falls back to the remembered preference, same rule as startIssueSession (#651);
        // the picker itself always sends an explicit boolean, so this is for any other
        // client that skips it.
        const autopilotExplicit = parsed.autopilot != null;
        entry.autopilot = parsed.autopilot == null ? !!settings.issueAutopilot : !!parsed.autopilot;
        // #668: same rule as autopilot above — read off `settings`, so a Settings change
        // applies with no restart. Unlike autopilot there is no per-start override: the
        // picker offers none, and the WS message must not be able to introduce one.
        const stages = issueStagesText();
        // #689: the create block latched whether the worktree already existed, BEFORE
        // anything could have created it. Only now — in a message callback, where a
        // subprocess is safe — do we spend the git calls to say what is in it. Stamped
        // on the entry so issue_complete can read it at the far end of the session, and
        // caught by the saveState() below, which this handler already called for
        // autopilot.
        const resumeStatus = entry.worktreeExisted && entry.worktree
          ? worktreeStatus({ repoRoot: sessionPaths(entry).repoRoot, name: entry.worktree })
          : null;
        entry.resumedWorktree = resumedStamp(resumeStatus);
        const resume = issueResumeText(resumeStatus, id);
        saveState();
        broadcastAutopilot(id);
        // This path never calls startIssueSession, so it logs its own start line (#653) —
        // otherwise a picker start is the one surface with no `[issue] #N:` line at all.
        // It lands a moment AFTER this session's `[WS] Creating NEW shell:` line, because
        // here the tab exists before the issue is known; one grep for `[issue] #` still
        // covers every path. The picker always sends an explicit boolean (app.js), so
        // `ws-issue` reads `explicit` even though its checkbox was seeded from the setting.
        logIssueStart({
          number: parsed.issue?.number ?? '?', id, source: 'ws-issue',
          agentType: entry.agentType, engineType: entry.engineType,
          worktree: entry.worktree, cwd: entry.cwd,
          on: entry.autopilot, explicit: autopilotExplicit, stages: !!stages,
          resume: resumeStatus,
        });
        // `{ stages, resume }` is the THIRD argument. Folding either into the second —
        // the variable bag — would render as nothing (an unknown {{name}} is empty by
        // design) and the picker would be the one surface silently starting a different
        // kind of session.
        deliverPromptWhenReady(id, renderIssuePrompt(settings.wandPromptTemplate, parsed.issue || {}, { stages, resume }));
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
        // The server may have closed this session already — scheduled auto-close,
        // DELETE /api/shells/:id, killall — in which case the browser is only
        // echoing back the tab teardown we asked it to do. Mirrors the guard
        // ws.on('close') already has. Without it the echo re-tombstones the entry
        // and overwrites the real closeReason with 'user-closed' (#626), so
        // state.json blames the user for every unattended auto-close.
        if (shells.get(id) !== entry) return;
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
    // The terminal answering a program is not a person typing (#635). xterm replies to
    // the capability probes tmux fires at every attaching client, and the browser sends
    // those replies down this same socket — so without this, EVERY freshly opened tab
    // recorded a keystroke within milliseconds and `run_in_terminal` never closed one.
    // It still has to reach the PTY (tmux is waiting on the answer), and deliberately
    // ahead of the inputBlocked drop below: #512 blocks *keystrokes*, and this is not
    // one, so a prompt injection in flight must not leave tmux's probe unanswered.
    if (isTerminalReport(str)) {
      // Once per session, not per report: this is the diagnostic the old comment below
      // asked for ("the only way to diagnose it"), and reports arrive on every attach.
      if (!entry.reportSeen) {
        entry.reportSeen = true;
        log(`[WS] ${id}: terminal report ${JSON.stringify(str)} — passed to the PTY, not counted as input`);
      }
      getEngine(id).write(id, str);
      return;
    }

    // Drop user keystrokes while an auto-injected prompt is being submitted, so
    // typing can't interleave with the injected text (#512). Control messages
    // (resize/rename/unblock-input/close-session) already returned above, so they
    // still work as escape hatches.
    if (entry.inputBlocked) return;
    // User sent input — bump activity/input timers only. The #568 screen-state
    // detector decides "waiting" purely from the rendered screen, so a single
    // un-submitted keystroke must NOT clear the flag here (that was the #558
    // "one keystroke disarms it permanently" bug). The echo flows through the data
    // handler, and because it carries no spinner heartbeat, a composed-but-unsent
    // message stays "waiting".
    entry.lastActivity = Date.now();
    entry.lastInputTime = Date.now();
    // #627: a user typing in a tab after its merge keeps the tab. Only real input
    // reaches here — resize/rename/ping/close-session and the other control messages
    // all returned above, and terminal reports returned just above that (#635) — so
    // merely HAVING the tab open never cancels, and neither does a reconnect. The byte
    // count is logged because that is the only way to diagnose it if some future TUI
    // turns on a reporting mode this classifier does not yet know about.
    sessionAutoClose.cancel(id, `user input, ${str.length} byte(s)`);
    // #558 audit: keystroke-resolution ordering, debounced to 1/s per shell
    // (typing bursts collapse into a `burst` suppressed-count). clearedWaiting is
    // now always false — keystrokes no longer touch the flag.
    if (settings.waitingAuditEnabled) {
      const now = Date.now();
      if (!entry._auditLastInputLog || now - entry._auditLastInputLog >= 1000) {
        auditWaiting('input', id, entry, { len: str.length, clearedWaiting: false, burst: entry._auditInputBurst || 0 });
        entry._auditLastInputLog = now;
        entry._auditInputBurst = 0;
      } else {
        entry._auditInputBurst = (entry._auditInputBurst || 0) + 1;
      }
    }
    getEngine(id).write(id, str);
  });

  ws.on('close', () => {
    if (!shells.has(id)) return; // already killed by close-session
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      // A tmux-backed session outlives its browser (#620): the daemon is healthy,
      // the agent is mid-turn, and tmux is holding the process — reaping it would
      // destroy work nobody asked to end. Keep the entry LIVE rather than
      // detaching it, which is both simpler and strictly better: the attach PTY
      // stays open, so output produced while you're away still lands in the
      // scrollback buffer and replays when you return (deepsteve never reads
      // tmux's own history), and reconnecting uses the existing "session is still
      // live" path instead of needing a reattach-before-respawn.
      //
      // Consequence, accepted deliberately: nothing reclaims a clientless tmux
      // session any more. It runs until closed explicitly (the ✕, close_session,
      // DELETE /api/shells/:id, killall). If that growth ever bites, the fix is an
      // idle sweep alongside pruneClosedSessions(), not re-arming this reaper.
      // Note: no savedState write. The entry stays in `shells`, and saveState()
      // serializes every live shell — writing it into savedState too would file a
      // live session under "not currently live" for every reader of that map.
      // Keyed on the engine's own capability, not just the recorded engineType: a
      // spawn that fell back to node-pty can leave engineType saying 'tmux', and
      // skipping the reap for a node-pty session would leak it forever.
      if (entry.agentType !== 'tmux-attach' && (entry.engine || ptyEngine).canDetach) {
        log(`[WS] ${id}: last client left — tmux session kept running`);
        saveState();
        return;
      }
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
initMCP({ app, security, shells, wss, broadcast, broadcastToWindow, log, MODS_DIR, closeSession, tombstoneSession, handleShellGone, spawnSession, sessionEnv, getSpawnArgs, mcpConfigArgs, getAgentConfig, resolveConfigDir, validateModel, validateEffort, wireShellOutput, watchClaudeSessionDir, unwatchClaudeSessionDir, resolveForkParentSession, transcriptPath, saveState, validateWorktree, ensureWorktree, sessionPaths, submitToShell, fetchIssueFromGitHub, deliverPromptWhenReady, startIssueSession, reloadClients, deliverToWindow, noteSpawnDelivery, settings, isShuttingDown: () => shuttingDown, displayTabs, setDisplayTab, deleteDisplayTab, screenshots, setScreenshot, deleteScreenshot, getScreenshotPath, getDefaultEngine, getForegroundCommand, sessionLog, emitSessionOpen, getContexts: () => contexts, pathInside, getSavedSession: (id) => savedState[id] || null, stripEscapeSequences, readTerminalScreen, sessionInputState, maybeInheritRemoteControl, requestMetaControlsConsent, registerRestartBlocker, armSessionAutoClose, logRcWrite }).catch(e => log('MCP init failed:', e.message));
initMCP({ app, security, shells, wss, broadcast, broadcastToWindow, log, MODS_DIR, closeSession, tombstoneSession, handleShellGone, spawnSession, sessionEnv, getSpawnArgs, mcpConfigArgs, getAgentConfig, resolveConfigDir, validateModel, validateEffort, wireShellOutput, watchClaudeSessionDir, unwatchClaudeSessionDir, resolveForkParentSession, saveState, validateWorktree, ensureWorktree, sessionPaths, submitToShell, fetchIssueFromGitHub, deliverPromptWhenReady, startIssueSession, reloadClients, deliverToWindow, noteSpawnDelivery, settings, isShuttingDown: () => shuttingDown, displayTabs, setDisplayTab, deleteDisplayTab, screenshots, setScreenshot, deleteScreenshot, getScreenshotPath, getDefaultEngine, getForegroundCommand, sessionLog, emitSessionOpen, getContexts: () => contexts, pathInside, getSavedSession: (id) => savedState[id] || null, stripEscapeSequences, readTerminalScreen, sessionInputState, maybeInheritRemoteControl, requestMetaControlsConsent, registerRestartBlocker, armSessionAutoClose, logRcWrite }).catch(e => log('MCP init failed:', e.message));

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
