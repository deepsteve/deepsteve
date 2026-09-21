// The link bounce (#705).
//
// A /v1/<type>/<id> link is meant to be clicked in an email. A click in webmail is a CROSS-SITE
// navigation, so the browser withholds our SameSite=Strict cookie and authGate rejects a user who
// is signed in. authGate answers exactly that case with a page that reloads itself once — the
// reload is same-site, and setAuthCookie has already put the token on the response.
//
// What is pinned here is the SCOPE, because the bounce changes a rejection body that other code
// reads: api-fetch.js and auth-heal.js are written against the text/plain 401, so every request
// that is not a browser navigation to a link path must still get exactly that. And the bounce
// never authenticates anything — next() is never called.
//
// Run: node --test test/unit/security-link-bounce.test.js

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// stateDir() places the auth-token file at module load — set DEEPSTEVE_HOME first or the test
// writes into the real ~/.deepsteve.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-link-bounce-'));
const prevHome = process.env.DEEPSTEVE_HOME;
process.env.DEEPSTEVE_HOME = scratch;
const { createSecurity } = require('../../security.js');

// A fresh instance per test: the failure limiter is per-instance and holds a lockout once tripped.
function fresh() {
  return createSecurity({
    port: 3000,
    httpsPort: 3443,
    httpsEnabled: false,
    getLanAddresses: () => ['localhost', '127.0.0.1'],
    log: () => {},
  });
}

function call(security, {
  method = 'GET', url = '/v1/decision/w1', host = 'deepsteve.localhost:3000',
  accept = 'text/html,application/xhtml+xml', cookie, authorization,
} = {}) {
  const headers = { host };
  if (accept) headers.accept = accept;
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  const out = { status: null, type: null, body: null, headers: {}, nexted: false };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    status: (c) => { out.status = c; return res; },
    type: (t) => { out.type = t; return res; },
    send: (b) => { out.body = b; return res; },
  };
  security.authGate({ method, url, originalUrl: url, headers }, res, () => { out.nexted = true; });
  return out;
}

describe('authGate link bounce', () => {
  after(() => {
    if (prevHome === undefined) delete process.env.DEEPSTEVE_HOME;
    else process.env.DEEPSTEVE_HOME = prevHome;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('a cookieless navigation to a link gets the self-reloading page, still as a 401', () => {
    const out = call(fresh());
    assert.strictEqual(out.status, 401, 'the bounce is a rejection body, never a pass');
    assert.strictEqual(out.type, 'html');
    assert.strictEqual(out.nexted, false);
    assert.match(out.body, /location\.replace\(location\.href\)/);
    assert.match(out.body, /isn’t signed in to Deep Steve/, 'a browser that refuses the cookie gets words, not a loop');
    assert.strictEqual(out.headers['cache-control'], 'no-store');
  });

  it('the page script is exactly the one its CSP hash allows', () => {
    const out = call(fresh());
    const script = /<script>([\s\S]*?)<\/script>/.exec(out.body);
    assert.ok(script, 'expected one inline script');
    const hash = crypto.createHash('sha256').update(script[1]).digest('base64');
    assert.ok(out.headers['content-security-policy'].includes(`'sha256-${hash}'`),
      `CSP ${out.headers['content-security-policy']} does not allow the script it serves`);
    assert.ok(!/unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/.test(out.headers['content-security-policy']));
  });

  it('a project-mod link bounces like a decision link (#711)', () => {
    const out = call(fresh(), { url: '/v1/project-mod/015dd1f5' });
    assert.strictEqual(out.status, 401);
    assert.strictEqual(out.type, 'html');
    assert.match(out.body, /location\.replace\(location\.href\)/);
  });

  it('a stale cookie bounces too — the reload carries the fresh one', () => {
    const security = fresh();
    const out = call(security, { cookie: `${security.cookieName}=deadbeef` });
    assert.strictEqual(out.status, 401);
    assert.strictEqual(out.type, 'html');
  });

  it('a valid cookie is not bounced, it is let through', () => {
    const security = fresh();
    const out = call(security, { cookie: `${security.cookieName}=${security.token}` });
    assert.strictEqual(out.nexted, true);
    assert.strictEqual(out.status, null);
  });

  it('everything that is not a browser navigation to a link keeps the text/plain 401', () => {
    const cases = [
      { what: 'an API path', url: '/api/version' },
      { what: 'the gated display-tab page', url: '/api/display-tab/abc' },
      // #711 chose this on purpose: an email links to /v1/project-mod/<id>, and the raw page
      // keeps the plain 401 that its own iframe loads get.
      { what: 'the raw project-mod page', url: '/api/project-mods/015dd1f5/page' },
      { what: 'a fetch (Accept */*)', accept: '*/*' },
      { what: 'no Accept at all', accept: null },
      { what: 'a POST', method: 'POST' },
      { what: 'a bad bearer token', authorization: 'Bearer nope' },
      { what: 'a non-loopback host', host: '192.168.1.20:3000' },
      { what: 'a path that only starts like a version', url: '/v1decision/w1' },
    ];
    for (const c of cases) {
      const out = call(fresh(), c);
      assert.strictEqual(out.status, 401, c.what);
      assert.strictEqual(out.type, 'text/plain', `${c.what} must keep the plain 401`);
      assert.strictEqual(out.body, 'Unauthorized', c.what);
    }
  });

  it('a lockout still answers 429 in plain text, bounce or not', () => {
    const security = fresh();
    let out;
    for (let i = 0; i < 80; i++) out = call(security);
    assert.strictEqual(out.status, 429);
    assert.strictEqual(out.type, 'text/plain');
  });
});
