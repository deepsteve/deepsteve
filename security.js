// security.js — cross-origin / DNS-rebinding / auth hardening for the localhost server (#536).
//
// DeepSteve serves PTY-backed shells and an MCP endpoint on loopback with the user's full
// permissions. Browsers do NOT apply the same-origin policy to WebSocket connections, so absent
// server-side checks any web page the user visits could open a WS to our port and drive a session;
// DNS rebinding defeats the loopback bind by pointing an attacker domain at 127.0.0.1. This module
// is the single source of truth for the four defenses that close that hole:
//   1. Host-header allowlist  — stops DNS rebinding (the rebind domain shows up in the Host header).
//   2. Origin allowlist       — stops cross-site WS hijack + CSRF (checked on the WS upgrade and on
//                               any cookie-authed HTTP request that carries an Origin).
//   3. Per-install token      — required on every surface. The browser gets it as an HttpOnly
//                               cookie set on the page we serve; non-browser/MCP/CLI clients send it
//                               as `Authorization: Bearer <token>`.
//   4. Failure rate limiting  — throttles auth *failures* only; valid credentials never throttle.
//
// Token transport is cookie (browser) or bearer (everything else). We deliberately do NOT accept a
// `?token=` query param anywhere, so the secret never lands in server logs or `ps` output.
//
// The canonical browser origin is http://deepsteve.localhost:PORT (#544/#545). Plain `localhost`
// shares one cookie jar with every other local dev app (cookies key on host, not port), and
// Firefox's per-host cookie cap evicts our cookie when that shared jar fills. `*.localhost`
// resolves to loopback (RFC 6761), so deepsteve.localhost is still localhost-only but gets its own
// jar — and makes other localhost apps cross-site, so SameSite=Strict actively excludes them.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const AUTH_TOKEN_FILE = path.join(os.homedir(), '.deepsteve', 'auth-token');
const COOKIE_NAME = 'ds_auth';
// Canonical UI host (#545): loopback per RFC 6761, but its own cookie "site" — isolated from the
// shared `localhost` jar whose per-host cap is what evicted ds_auth (#544).
const UI_HOST = 'deepsteve.localhost';
// Rolling window: setAuthCookie re-issues the cookie on every HTML page load, so this is the
// maximum *idle* lifetime, not a hard logout. Persistent (vs the old session cookie) both to
// survive browser restarts and because session cookies are browsers' preferred purge target.
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Read the per-install secret, creating it (0600) on first run. The server is the sole
// authoritative creator and calls this before app.listen, so the token exists before any request,
// session spawn, or MCP config is built.
function loadOrCreateToken(log) {
  try {
    const existing = fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
    if (existing) {
      try { fs.chmodSync(AUTH_TOKEN_FILE, 0o600); } catch {}
      return existing;
    }
  } catch { /* not present yet — create below */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(AUTH_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(AUTH_TOKEN_FILE, token, { mode: 0o600 });
  try { fs.chmodSync(AUTH_TOKEN_FILE, 0o600); } catch {}
  if (log) log('Auth: generated new per-install token at ~/.deepsteve/auth-token');
  return token;
}

// Reduce a Host header to a bare, comparable hostname: lowercase, strip the :port, strip the
// [] around an IPv6 literal, drop a trailing FQDN dot and any IPv6 zone id. Returns '' if missing.
function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');     // [::1]:3000 -> ::1
    if (end === -1) return '';
    h = h.slice(1, end);
  } else {
    const colon = h.indexOf(':');   // host:port -> host
    if (colon !== -1) h = h.slice(0, colon);
  }
  h = h.replace(/\.$/, '');          // trailing-dot FQDN (localhost.)
  h = h.replace(/%.*$/, '');         // IPv6 zone id (fe80::1%en0)
  return h;
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Build the security layer. `cfg`:
 *   port, httpsPort           — listen ports (numbers)
 *   httpsEnabled              — whether the HTTPS/LAN listener is on
 *   getLanAddresses           — () => string[] of localhost + LAN IPv4s (from server.js)
 *   allowOrigins, allowHosts  — operator escape-hatch widening lists (--allow-origin/--allow-host)
 *   canonicalRedirect         — bounce browser page loads on localhost to UI_HOST (default true;
 *                               --no-canonical-redirect turns it off)
 *   log                       — logger
 */
function createSecurity(cfg) {
  const {
    port, httpsPort, httpsEnabled,
    getLanAddresses, allowOrigins = [], allowHosts = [],
    canonicalRedirect = true, log = () => {},
  } = cfg;

  const token = loadOrCreateToken(log);
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  // --- Allowlists (computed once at boot, like the HTTPS cert SANs) ---
  const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', UI_HOST];
  // LAN IPs are only trusted when HTTPS/LAN mode is on (they only make sense there, and the certs
  // are minted for exactly these addresses). Plain HTTP stays loopback-only.
  const lanHosts = httpsEnabled
    ? getLanAddresses().filter(a => a !== 'localhost' && a !== '127.0.0.1')
    : [];

  // Operator escape-hatch hosts (--allow-host / DEEPSTEVE_ALLOW_HOST), normalized ONCE and shared by
  // both the port-stripped HTTP/WS allowlist (`allowedHosts`) and the port-qualified MCP allowlist
  // (`mcpAllowedHosts`) below. Deriving both from one source keeps them from diverging — a divergence
  // is exactly what broke the docker integration tests: the test container reaches us as `server:3000`,
  // which was allowed for HTTP/WS but still rejected by the MCP SDK's DNS-rebinding guard.
  const normalizedAllowHosts = allowHosts.map(h => hostnameOf(h) || String(h).trim().toLowerCase()).filter(Boolean);

  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...lanHosts.map(h => h.toLowerCase()),
    ...normalizedAllowHosts,
  ]);

  // One host-base list feeds the Origin allowlist and the MCP host allowlist below, so the two
  // can't drift apart. ([::1] is bracketed here because origins/Host headers carry the brackets.)
  const originHostBases = ['localhost', '127.0.0.1', '[::1]', UI_HOST];
  const httpOrigins = originHostBases.map(h => `http://${h}:${port}`);
  const httpsOrigins = httpsEnabled
    ? [...originHostBases, ...lanHosts].map(h => `https://${h}:${httpsPort}`)
    : [];
  const allowedOrigins = new Set([
    ...httpOrigins,
    ...httpsOrigins,
    ...allowOrigins.map(normalizeOrigin).filter(Boolean),
  ]);

  // The MCP SDK's DNS-rebinding guard does an exact includes() on the FULL Host header (host:port),
  // so this list is port-qualified — distinct from `allowedHosts`, which is port-stripped. It folds
  // in the same operator allowHosts (via normalizedAllowHosts) so an allowlisted host is honored on
  // the MCP surface too, not just HTTP/WS.
  const mcpHostBases = [...originHostBases, ...lanHosts, ...normalizedAllowHosts];
  const mcpAllowedHosts = [
    ...mcpHostBases.map(h => `${h}:${port}`),
    ...(httpsEnabled ? mcpHostBases.map(h => `${h}:${httpsPort}`) : []),
  ];

  function isAllowedHost(hostHeader) {
    const h = hostnameOf(hostHeader);
    return h !== '' && allowedHosts.has(h);
  }
  function isAllowedOrigin(origin) {
    if (!origin) return false;
    return allowedOrigins.has(normalizeOrigin(origin));
  }

  // Constant-time compare via fixed-length SHA-256 digests (timingSafeEqual throws on length
  // mismatch, so never feed it the raw user string).
  function validToken(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    const cand = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(cand, tokenHash);
  }

  function bearerOf(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
    return m ? m[1].trim() : null;
  }
  function cookieTokenOf(req) {
    return parseCookies(req.headers['cookie'])[COOKIE_NAME] || null;
  }

  // --- Failure rate limiter (ClawJacked did no localhost throttling). Valid creds bypass this
  //     entirely, so the real UI is never affected; only failing/guessing clients get throttled. ---
  const RL_WINDOW_MS = 10_000;
  const RL_MAX_FAILURES = 50;
  const RL_COOLDOWN_MS = 30_000;
  let failures = [];
  let lockedUntil = 0;
  function lockedOut() { return Date.now() < lockedUntil; }
  function recordFailure() {
    const t = Date.now();
    failures.push(t);
    failures = failures.filter(ts => t - ts <= RL_WINDOW_MS);
    if (failures.length >= RL_MAX_FAILURES && !lockedOut()) {
      lockedUntil = t + RL_COOLDOWN_MS;
      log(`Auth: ${failures.length} failed attempts in ${RL_WINDOW_MS / 1000}s — throttling auth failures for ${RL_COOLDOWN_MS / 1000}s`);
    }
  }

  // === Express middleware ===

  // 1. Host allowlist — first in the chain, applies to every request (static, /api, /mcp).
  function hostGuard(req, res, next) {
    if (!isAllowedHost(req.headers.host)) {
      log(`Rejected: disallowed Host "${req.headers.host || ''}" (${req.method} ${req.url})`);
      return res.status(403).type('text/plain').send('Forbidden: Host not allowed');
    }
    next();
  }

  // 2. Bounce browser page loads on the shared loopback names to the canonical UI origin
  //    (#544/#545): the localhost jar fills with other apps' cookies and Firefox's per-host cap
  //    evicts ds_auth; deepsteve.localhost is its own site and jar. Navigations only (GET +
  //    Accept: text/html) — curl/agents/docker healthchecks send Accept: */* and bearer clients
  //    are skipped outright, so nothing non-browser ever bounces. Never redirects --allow-host /
  //    LAN hosts (deliberate operator choices) or UI_HOST itself (no loop). Always 302 — a cached
  //    permanent redirect would outlive the --no-canonical-redirect escape hatch.
  const REDIRECT_SOURCE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  function canonicalHostRedirect(req, res, next) {
    if (!canonicalRedirect) return next();
    if (req.method !== 'GET') return next();
    if (!String(req.headers.accept || '').includes('text/html')) return next();
    if (req.headers.authorization) return next();
    if (!REDIRECT_SOURCE_HOSTS.has(hostnameOf(req.headers.host))) return next();
    // Keep the ORIGINAL port, not our listen port — an SSH tunnel can map us to any local port,
    // and *.localhost resolves on the browser's machine, so the tunnel keeps working.
    const host = String(req.headers.host || '');
    const m = host.startsWith('[') ? /\]:(\d+)$/.exec(host) : /:(\d+)$/.exec(host);
    const portSuffix = m ? `:${m[1]}` : '';
    return res.redirect(302, `${req.secure ? 'https' : 'http'}://${UI_HOST}${portSuffix}${req.originalUrl}`);
  }

  // 3. Set the auth cookie on page loads. Keyed off the REQUEST (GET + Accept: text/html) because
  //    this runs before express.static streams the body. Runs after hostGuard, so only allowlisted
  //    hosts ever receive the cookie (a rebinding victim gets a 403 first) — and after
  //    canonicalHostRedirect, so a bounced navigation never deposits a cookie into the localhost
  //    jar (that jar's pollution is the bug this fixes).
  function setAuthCookie(req, res, next) {
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true, sameSite: 'strict', path: '/', secure: !!req.secure,
        maxAge: COOKIE_MAX_AGE_MS,
      });
    }
    next();
  }

  // 4. Token gate — registered as a POSITIONAL middleware before the body-parser and every route
  //    (and before the async-mounted /mcp + mod routes), giving default-deny coverage of current
  //    and future endpoints. Static files are served ahead of this and never reach it.
  function authGate(req, res, next) {
    const bearer = bearerOf(req);
    if (bearer && validToken(bearer)) return next();   // non-browser / agent / MCP path — no Origin needed

    const cookieTok = cookieTokenOf(req);
    if (cookieTok && validToken(cookieTok)) {
      // SameSite=Strict is port-blind: a page on another localhost:PORT is "same-site" and its
      // request carries our cookie. So on the cookie path, if an Origin is present it must be
      // allowlisted (all methods). Legit same-origin GET/subresource loads omit Origin; a
      // cross-origin fetch()/XHR always sends it, so this blocks the drive-by without breaking us.
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin)) {
        log(`Rejected: cookie auth with disallowed Origin "${origin}" (${req.method} ${req.url})`);
        return res.status(403).type('text/plain').send('Forbidden: Origin not allowed');
      }
      return next();
    }

    recordFailure();
    if (lockedOut()) return res.status(429).type('text/plain').send('Too Many Requests');
    return res.status(401).type('text/plain').send('Unauthorized');
  }

  // === WebSocket upgrade guard (ws `verifyClient`) ===
  // Runs during the HTTP upgrade, BEFORE the handshake completes — so a rejected page never gets a
  // live socket. Requires an allowlisted Host, a present+allowlisted Origin (browsers always send
  // it; missing Origin is rejected), and a valid auth cookie (the only WS clients are browsers).
  function verifyWsClient(info, cb) {
    const req = info.req;
    if (!isAllowedHost(req.headers.host)) {
      log(`Rejected WS upgrade: disallowed Host "${req.headers.host || ''}"`);
      return cb(false, 403, 'Forbidden');
    }
    // Non-browser clients (integration tests, remote-control tools) authenticate with a bearer token
    // and are not required to send an Origin — mirrors the HTTP authGate bearer path. Browsers can't
    // set WS request headers, so they fall through to the Origin + cookie checks below.
    const bearer = bearerOf(req);
    if (bearer && validToken(bearer)) return cb(true);
    const origin = info.origin || req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      log(`Rejected WS upgrade: disallowed/missing Origin "${origin || ''}"`);
      return cb(false, 403, 'Forbidden');
    }
    const cookieTok = cookieTokenOf(req);
    if (!cookieTok || !validToken(cookieTok)) {
      recordFailure();
      log('Rejected WS upgrade: missing/invalid auth cookie');
      return cb(false, lockedOut() ? 429 : 401, 'Unauthorized');
    }
    cb(true);
  }

  return {
    token,
    cookieName: COOKIE_NAME,
    allowedHosts, allowedOrigins, mcpAllowedHosts,
    isAllowedHost, isAllowedOrigin, validToken,
    hostGuard, canonicalHostRedirect, setAuthCookie, authGate, verifyWsClient,
    _rateLimit: { lockedOut, recordFailure }, // exposed for tests
  };
}

module.exports = { createSecurity, AUTH_TOKEN_FILE, COOKIE_NAME, UI_HOST };
