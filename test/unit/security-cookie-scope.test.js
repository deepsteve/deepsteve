// The auth cookie must only ever be issued to a LOOPBACK host.
//
// setAuthCookie runs ahead of authGate, so it answers unauthenticated requests. That is safe on
// loopback (reaching the socket proves you are the local user) but not once --https or
// --allow-host widens the Host allowlist to a LAN address: the handout then gave the real
// per-install token to any client on the network that asked for an HTML page, which it could
// replay against the whole API. These tests pin the loopback-only scope of the handout.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// stateDir() is read at module load to place the auth-token file, so DEEPSTEVE_HOME has to be
// set before security.js is required or the test writes into the real ~/.deepsteve.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cookie-scope-'));
const prevHome = process.env.DEEPSTEVE_HOME;
process.env.DEEPSTEVE_HOME = scratch;
const { createSecurity, LEGACY_COOKIE_NAME, UI_HOST } = require('../../security.js');

const PORT = 3000;
const security = createSecurity({
  port: PORT,
  httpsPort: 3443,
  httpsEnabled: false,
  getLanAddresses: () => ['localhost', '127.0.0.1'],
  // The escape hatch that widens the Host allowlist past loopback — `server` is exactly what
  // the docker integration daemon runs with (DEEPSTEVE_ALLOW_HOST=server).
  allowHosts: ['lanbox', 'server'],
  log: () => {},
});

// Drive setAuthCookie the way express would, and report whether it set our cookie.
function pageLoadFrom(host) {
  const req = { method: 'GET', headers: { accept: 'text/html', host }, secure: false };
  let cookie = null;
  const res = { cookie: (name, value, opts) => { cookie = { name, value, opts }; } };
  let nexted = false;
  security.setAuthCookie(req, res, () => { nexted = true; });
  return { cookie, nexted };
}

describe('auth cookie is issued to loopback hosts only', () => {
  after(() => {
    if (prevHome === undefined) delete process.env.DEEPSTEVE_HOME;
    else process.env.DEEPSTEVE_HOME = prevHome;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', `${UI_HOST}:3000`]) {
    it(`issues the cookie on a page load from ${host}`, () => {
      const { cookie, nexted } = pageLoadFrom(host);
      assert.ok(cookie, `expected a cookie for loopback host ${host}`);
      assert.strictEqual(cookie.name, security.cookieName);
      assert.strictEqual(cookie.value, security.token);
      assert.strictEqual(cookie.opts.httpOnly, true);
      assert.strictEqual(cookie.opts.sameSite, 'strict');
      assert.ok(nexted, 'must always call next()');
    });
  }

  // These hosts pass hostGuard (they are allowlisted) but are reachable from the network, so a
  // handout here is a credential leak, not a convenience.
  for (const host of ['lanbox:3000', 'server:3000', '192.168.50.30:3000']) {
    it(`never issues the cookie to non-loopback host ${host}`, () => {
      const { cookie, nexted } = pageLoadFrom(host);
      assert.strictEqual(cookie, null, `token must not be handed to ${host}`);
      assert.ok(nexted, 'must still call next() so the request proceeds to authGate');
    });
  }

  it('an allowlisted non-loopback host is still allowed through hostGuard', () => {
    // Guards the test above against passing for the wrong reason (a 403 rather than the scope fix).
    assert.ok(security.isAllowedHost('server:3000'), 'server must be an allowlisted Host');
    assert.ok(security.isAllowedHost('lanbox:3000'), 'lanbox must be an allowlisted Host');
  });
});

// #675: cookies key on host, not port, and canonicalHostRedirect sends every loopback navigation to
// UI_HOST keeping the original port. So two DeepSteve daemons on one machine — the real one and an
// isolated test daemon with its own auth-token — write into the SAME deepsteve.localhost jar. With
// one shared name the second silently overwrote the first's cookie and every open tab 401'd on
// every fetch, forever, with a cookie no page load of its own would ever refresh.
describe('the auth cookie name is port-qualified so two daemons cannot clobber each other', () => {
  const other = createSecurity({
    port: 3999,
    httpsPort: 3443,
    httpsEnabled: false,
    getLanAddresses: () => ['localhost', '127.0.0.1'],
    log: () => {},
  });

  it('carries the listen port', () => {
    assert.strictEqual(security.cookieName, `${LEGACY_COOKIE_NAME}_3000`);
    assert.strictEqual(other.cookieName, `${LEGACY_COOKIE_NAME}_3999`);
  });

  it('two instances on different ports use different names', () => {
    assert.notStrictEqual(security.cookieName, other.cookieName,
      'a shared name is what let a test daemon overwrite the real install cookie');
  });

  it("does not accept the other daemon's cookie", () => {
    const req = { method: 'GET', url: '/api/version', headers: { cookie: `${other.cookieName}=${other.token}` } };
    let status = 0;
    const res = { status: (s) => { status = s; return res; }, type: () => res, send: () => {} };
    let nexted = false;
    security.authGate(req, res, () => { nexted = true; });
    assert.ok(!nexted, 'another daemon token must not authenticate');
    assert.strictEqual(status, 401);
  });

  // Transition path: a tab that was open across the upgrade still holds the unqualified cookie, and
  // has no reason to reload until something makes it. Reading the legacy name keeps it working
  // until its next page load re-mints under the new one.
  it('still accepts the legacy unqualified cookie', () => {
    const req = { method: 'GET', url: '/api/version', headers: { cookie: `${LEGACY_COOKIE_NAME}=${security.token}` } };
    const res = { status: () => res, type: () => res, send: () => {} };
    let nexted = false;
    security.authGate(req, res, () => { nexted = true; });
    assert.ok(nexted, 'a pre-upgrade tab must not be logged out by the rename');
  });

  it('prefers the port-qualified cookie when both are present', () => {
    // The legacy cookie is the one a rogue daemon can still stomp, so ours has to win.
    const req = {
      method: 'GET',
      url: '/api/version',
      headers: { cookie: `${LEGACY_COOKIE_NAME}=not-the-token; ${security.cookieName}=${security.token}` },
    };
    const res = { status: () => res, type: () => res, send: () => {} };
    let nexted = false;
    security.authGate(req, res, () => { nexted = true; });
    assert.ok(nexted, 'the port-qualified cookie must take precedence over a stale legacy one');
  });
});
