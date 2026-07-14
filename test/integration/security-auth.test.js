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
 * Uses action=reload sockets (live-reload registration) so no PTY is spawned.
 * Keep unauthenticated requests to a handful — each one calls recordFailure()
 * on the shared rate limiter (50 failures / 10s trips a 30s lockout).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { BASE_URL, AUTH_TOKEN } = require('../helpers/ws-client');

const WS_URL = BASE_URL.replace(/^http/, 'ws');
// A browser-style upgrade must present an allowlisted Origin or it is rejected
// for the Origin (403) before the cookie check we want to exercise. localhost
// with the server's own port is always allowlisted, unlike the docker host.
const ORIGIN = 'http://localhost:' + (new URL(BASE_URL).port || '3000');

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

  it('GET / with Accept: text/html sets the ds_auth cookie', async () => {
    const res = await fetch(`${BASE_URL}/`, { headers: { Accept: 'text/html' } });
    assert.strictEqual(res.status, 200);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some(c => c.startsWith('ds_auth=')),
      `expected a ds_auth Set-Cookie, got: ${JSON.stringify(cookies)}`);
  });

  it('unauthenticated GET /api/version returns 401/429 (the self-heal probe contract)', async () => {
    const res = await fetch(`${BASE_URL}/api/version`, { cache: 'no-store' });
    assert.ok([401, 429].includes(res.status),
      `expected 401 (or 429 mid-lockout), got ${res.status}`);
  });
});
