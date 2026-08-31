/**
 * Pins the server-side auth contract that the client's auth self-heal (#540,
 * public/js/auth-heal.js) depends on:
 *
 *   1. A cookieless browser-style WS upgrade is rejected with 401 (or 429
 *      mid-lockout) — the condition the heal exists to escape.
 *   2. The auth cookie authenticates a WS upgrade — what the heal restores.
 *   3. GET / with Accept: text/html sets the auth cookie — the guarantee
 *      that the heal's one page reload actually re-acquires auth.
 *   4. An unauthenticated /api request returns 401/429 — the probe the client
 *      uses to tell "server up but auth broken" (readable status) apart from
 *      "server down" (network error), since a failed WS upgrade only ever
 *      surfaces as close code 1006.
 *
 * Plus the #545 canonical-origin contract: the cookie is persistent
 * (Max-Age=30d) and issued on the deepsteve.localhost host; browser
 * navigations on plain localhost 302 to deepsteve.localhost (own cookie jar,
 * immune to the shared jar's eviction, #544) while bearer/non-HTML requests
 * never redirect. Host-sensitive requests forge the Host header over
 * node:http (undici fetch forbids setting Host), so they behave identically
 * locally and in docker, where the server's real host is `server`.
 *
 * Plus the #675 contract: the cookie's NAME carries our listen port, so a second daemon on this
 * machine cannot overwrite this install's cookie in the shared deepsteve.localhost jar; the legacy
 * unqualified name stays readable for one release; and POST /api/client-log answers without
 * credentials but only to an allowlisted Origin.
 *
 * Uses action=reload sockets (live-reload registration) so no PTY is spawned.
 * Keep unauthenticated requests to a handful — each one calls recordFailure()
 * on the shared rate limiter (50 failures / 10s trips a 30s lockout). GET /
 * never reaches the gate (static + redirect run first), so the redirect tests
 * here don't count as failures.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

const WS_URL = BASE_URL.replace(/^http/, 'ws');
const PORT = new URL(BASE_URL).port || '3000';
// A browser-style upgrade must present an allowlisted Origin or it is rejected
// for the Origin (403) before the cookie check we want to exercise. localhost
// with the server's own port is always allowlisted, unlike the docker host.
const ORIGIN = 'http://localhost:' + PORT;
const UI_HOST = 'deepsteve.localhost';
// The auth cookie carries the listen port in its NAME (#675) — see security.js. Derived from the
// URL under test rather than hardcoded, because the standalone runner picks a random port while
// the docker compose pins 3000.
const COOKIE = `ds_auth_${PORT}`;

// GET with an arbitrary (forged) Host header, without following redirects.
function rawGet(pathname, headers) {
  const base = new URL(BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: base.hostname, port: base.port || 80, path: pathname,
      method: 'GET', headers, setHost: false,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('rawGet timed out')));
    req.end();
  });
}

// Open a browser-style upgrade (Origin, optional Cookie, no bearer) and
// resolve with how the server answered it.
function tryUpgrade(headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/?action=reload`, { headers });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS upgrade attempt timed out'));
    }, 10000);
    ws.on('open', () => {
      clearTimeout(timeout);
      ws.close();
      resolve({ opened: true });
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timeout);
      res.resume();
      req.destroy();
      resolve({ opened: false, status: res.statusCode });
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('Security auth contract (#536/#540)', () => {
  it('rejects a cookieless browser WS upgrade with 401/429', async () => {
    const result = await tryUpgrade({ Origin: ORIGIN });
    assert.strictEqual(result.opened, false, 'upgrade must not complete without credentials');
    assert.ok([401, 429].includes(result.status),
      `expected 401 (or 429 mid-lockout), got ${result.status}`);
  });

  it('accepts a WS upgrade authenticated by the auth cookie', async () => {
    const result = await tryUpgrade({ Origin: ORIGIN, Cookie: `${COOKIE}=${AUTH_TOKEN}` });
    assert.strictEqual(result.opened, true, 'cookie-authenticated upgrade should open');
  });

  // The legacy unqualified name stays readable for one release so a tab open across the upgrade
  // is not logged out. Pinned so the fallback's removal is a deliberate act, not a silent one.
  it('still accepts the legacy unqualified cookie name (#675 transition)', async () => {
    const result = await tryUpgrade({ Origin: ORIGIN, Cookie: `ds_auth=${AUTH_TOKEN}` });
    assert.strictEqual(result.opened, true, 'a pre-upgrade tab must keep working');
  });

  it('GET / on the canonical host sets a persistent, port-qualified cookie (30d Max-Age, #545/#675)', async () => {
    const res = await rawGet('/', { Host: `${UI_HOST}:${PORT}`, Accept: 'text/html' });
    assert.strictEqual(res.status, 200);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    // Port-qualified (#675): cookies key on host, not port, so two daemons on this machine would
    // otherwise write the same name into the same deepsteve.localhost jar and clobber each other.
    const dsAuth = cookies.find(c => c.startsWith(`${COOKIE}=`));
    assert.ok(dsAuth, `expected a ${COOKIE} Set-Cookie, got: ${JSON.stringify(cookies)}`);
    assert.match(dsAuth, /Max-Age=2592000/i,
      `expected a persistent cookie (Max-Age=2592000), got: ${dsAuth}`);
  });

  it('accepts a WS upgrade from the canonical deepsteve.localhost origin (#545)', async () => {
    const result = await tryUpgrade({
      Host: `${UI_HOST}:${PORT}`,
      Origin: `http://${UI_HOST}:${PORT}`,
      Cookie: `${COOKIE}=${AUTH_TOKEN}`,
    });
    assert.strictEqual(result.opened, true, 'canonical-origin upgrade should open');
  });

  it('302s a browser navigation on localhost to the canonical host, without setting a cookie (#545)', async () => {
    const res = await rawGet('/', { Host: `localhost:${PORT}`, Accept: 'text/html' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, `http://${UI_HOST}:${PORT}/`);
    assert.strictEqual(res.headers['set-cookie'], undefined,
      'a bounced navigation must not deposit the auth cookie into the shared localhost jar');
  });

  it('preserves the original port in the canonical redirect (SSH tunnels)', async () => {
    const res = await rawGet('/', { Host: 'localhost:8080', Accept: 'text/html' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, `http://${UI_HOST}:8080/`);
  });

  it('never redirects bearer-authenticated requests', async () => {
    const res = await rawGet('/', {
      Host: `localhost:${PORT}`, Accept: 'text/html',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    });
    assert.strictEqual(res.status, 200);
  });

  it('never redirects non-HTML requests (curl, agents, healthchecks)', async () => {
    const res = await rawGet('/', { Host: `localhost:${PORT}`, Accept: '*/*' });
    assert.strictEqual(res.status, 200);
  });

  it('unauthenticated GET /api/version returns 401/429 (the self-heal probe contract)', async () => {
    const res = await fetch(`${BASE_URL}/api/version`, { cache: 'no-store' });
    assert.ok([401, 429].includes(res.status),
      `expected 401 (or 429 mid-lockout), got ${res.status}`);
  });
});

// POST /api/client-log is the one write endpoint mounted ABOVE the auth gate (#675). It has to be:
// it reports the state where our cookie is broken, and requiring the cookie to report a broken
// cookie is how 1,643 rejections came to leave no client-side trace at all. Its whole defense is
// therefore the Origin allowlist plus the body caps, which makes both worth pinning.
//
// Kept deliberately short: every rejected request here calls recordFailure() on the same
// process-wide limiter the tests above share.
describe('the client-log beacon is exempt from auth but not from the Origin allowlist', () => {
  function beacon(headers, body) {
    return fetch(`${BASE_URL}/api/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('accepts an unauthenticated POST from an allowlisted Origin', async () => {
    const res = await beacon({ Origin: ORIGIN }, { windowId: 'test-win', entries: [{ kind: 'fetch-401', msg: 'GET /api/probe' }] });
    assert.strictEqual(res.status, 204, 'no cookie, no bearer — this must still be accepted');
  });

  it('rejects a foreign Origin', async () => {
    // Browsers always send Origin on a POST, so this is what keeps the endpoint off the open web.
    const res = await beacon({ Origin: 'https://evil.example' }, { entries: [{ kind: 'x', msg: 'y' }] });
    assert.strictEqual(res.status, 403);
  });

  it('rejects a missing Origin', async () => {
    // Unlike authGate, whose Origin check is conditional, this one is mandatory — Origin is the
    // only thing standing between an unauthenticated write and any caller at all.
    const res = await beacon({}, { entries: [{ kind: 'x', msg: 'y' }] });
    assert.strictEqual(res.status, 403);
  });

  it('rejects an oversized body without leaking a stack trace', async () => {
    const res = await beacon({ Origin: ORIGIN }, JSON.stringify({ entries: [{ kind: 'big', msg: 'x'.repeat(20000) }] }));
    assert.ok([400, 413].includes(res.status), `expected 400/413, got ${res.status}`);
    const text = await res.text();
    assert.ok(!/ at .*\.js:\d+/.test(text), `body must not carry a stack trace: ${text.slice(0, 200)}`);
  });

  it('tolerates a malformed body', async () => {
    const res = await beacon({ Origin: ORIGIN }, 'not json');
    assert.ok([400, 413].includes(res.status), `expected 400/413, got ${res.status}`);
  });
});
