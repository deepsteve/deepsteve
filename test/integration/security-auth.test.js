/**
 * Pins the server-side auth contract that the client's auth self-heal (#540,
 * public/js/auth-heal.js) depends on:
 *
 *   1. A cookieless browser-style WS upgrade is rejected with 401 (or 429
 *      mid-lockout) — the condition the heal exists to escape.
 *   2. The ds_auth cookie authenticates a WS upgrade — what the heal restores.
 *   3. GET / with Accept: text/html sets the ds_auth cookie — the guarantee
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

  it('accepts a WS upgrade authenticated by the ds_auth cookie', async () => {
    const result = await tryUpgrade({ Origin: ORIGIN, Cookie: `ds_auth=${AUTH_TOKEN}` });
    assert.strictEqual(result.opened, true, 'cookie-authenticated upgrade should open');
  });

  it('GET / on the canonical host sets a persistent ds_auth cookie (30d Max-Age, #545)', async () => {
    const res = await rawGet('/', { Host: `${UI_HOST}:${PORT}`, Accept: 'text/html' });
    assert.strictEqual(res.status, 200);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const dsAuth = cookies.find(c => c.startsWith('ds_auth='));
    assert.ok(dsAuth, `expected a ds_auth Set-Cookie, got: ${JSON.stringify(cookies)}`);
    assert.match(dsAuth, /Max-Age=2592000/i,
      `expected a persistent cookie (Max-Age=2592000), got: ${dsAuth}`);
  });

  it('accepts a WS upgrade from the canonical deepsteve.localhost origin (#545)', async () => {
    const result = await tryUpgrade({
      Host: `${UI_HOST}:${PORT}`,
      Origin: `http://${UI_HOST}:${PORT}`,
      Cookie: `ds_auth=${AUTH_TOKEN}`,
    });
    assert.strictEqual(result.opened, true, 'canonical-origin upgrade should open');
  });

  it('302s a browser navigation on localhost to the canonical host, without setting a cookie (#545)', async () => {
    const res = await rawGet('/', { Host: `localhost:${PORT}`, Accept: 'text/html' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, `http://${UI_HOST}:${PORT}/`);
    assert.strictEqual(res.headers['set-cookie'], undefined,
      'a bounced navigation must not deposit ds_auth into the shared localhost jar');
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
