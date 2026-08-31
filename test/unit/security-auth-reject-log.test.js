// Repeated auth rejections must collapse into one line plus a count.
//
// The first version of this throttle spent a single global budget of 5 lines per 10s window. That
// shape assumes a burst. #675 was a *poller*: a workshop iframe re-fetching every 2s with a stale
// cookie emits roughly five rejections per window, so the budget was never spent and every single
// poll got its own line — 541 identical `GET /api/workshop/inbox` rejections in half an hour, which
// buried everything else in the daemon log. These tests pin the collapse-by-cause behavior that
// replaced it, and the two things the old code got wrong: no key (so unrelated endpoints shared one
// budget) and no timer (so a storm that stopped never printed its tail).

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// stateDir() is read at module load to place the auth-token file — set DEEPSTEVE_HOME first or the
// test writes into the real ~/.deepsteve.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-reject-log-'));
const prevHome = process.env.DEEPSTEVE_HOME;
process.env.DEEPSTEVE_HOME = scratch;
const { createSecurity } = require('../../security.js');

// A fresh instance per test. The failure rate limiter is per-instance and holds a 30s lockout once
// tripped, so a shared one would let a test that sends 300 rejections change what the next test
// sees. Each `it` gets its own limiter, its own reject-log window, and its own captured lines.
function fresh() {
  const lines = [];
  const security = createSecurity({
    port: 3000,
    httpsPort: 3443,
    httpsEnabled: false,
    getLanAddresses: () => ['localhost', '127.0.0.1'],
    log: (msg) => lines.push(msg),
  });
  const COOKIE = `${security.cookieName}=deadbeef`;

  // Drive authGate with credentials that will never validate. `cookie: null` means "send none",
  // which is a different rejection reason (no credentials) than a wrong one.
  function reject(method, url, cookie = COOKIE) {
    const req = { method, url, headers: cookie === null ? {} : { cookie } };
    const res = { status: () => res, type: () => res, send: () => {} };
    security.authGate(req, res, () => { throw new Error('must not authenticate'); });
  }

  // Only the rejection lines. The rate limiter emits a "throttling auth failures" line of its own
  // once it trips, which is a different signal and must not be counted as a rejection.
  const rejections = () => lines.filter(l => l.startsWith('Auth: rejected'));
  const rollups = () => lines.filter(l => / ×\d+ in \d+s$/.test(l) || /more rejections across/.test(l));

  return { security, reject, lines, rejections, rollups };
}

describe('auth rejection logging collapses repeats', () => {
  after(() => {
    if (prevHome === undefined) delete process.env.DEEPSTEVE_HOME;
    else process.env.DEEPSTEVE_HOME = prevHome;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('logs the first rejection of a cause immediately', () => {
    const t = fresh();
    t.reject('GET', '/api/workshop/inbox');
    assert.strictEqual(t.rejections().length, 1, 'the first sighting must not be delayed');
    assert.match(t.rejections()[0], /Auth: rejected GET \/api\/workshop\/inbox — invalid auth cookie \(401\)/);
  });

  it('a poller produces one line plus one rollup, not one line per poll', () => {
    const t = fresh();
    for (let i = 0; i < 300; i++) t.reject('GET', '/api/workshop/inbox');
    assert.strictEqual(t.rejections().length, 1,
      `300 identical polls logged ${t.rejections().length} rejection lines`);
    t.security._rejectLog.flush();
    assert.strictEqual(t.rollups().length, 1);
    assert.match(t.rollups()[0], /Auth: rejected GET \/api\/workshop\/inbox — invalid auth cookie ×300 in 60s/);
  });

  it('keys distinct endpoints separately', () => {
    const t = fresh();
    t.reject('GET', '/api/workshop/inbox');
    t.reject('GET', '/api/scheduled-tasks');
    t.reject('POST', '/api/workshop/inbox');
    assert.strictEqual(t.rejections().length, 3, 'method and path both belong in the key');
  });

  it('distinguishes the reason', () => {
    const t = fresh();
    t.reject('GET', '/api/version');            // wrong cookie
    t.reject('GET', '/api/version', null);      // none at all
    assert.strictEqual(t.rejections().length, 2,
      'a stale cookie and a missing one point at different failures and must not collapse together');
    assert.match(t.rejections()[0], /invalid auth cookie/);
    assert.match(t.rejections()[1], /no credentials/);
  });

  it('collapses one poller across its query strings', () => {
    // /api/git-root?cwd=A and ?cwd=B are one caller and one bug. Keying on the full URL would mint
    // a fresh line per distinct cwd and defeat the whole point.
    const t = fresh();
    t.reject('GET', '/api/git-root?cwd=%2Fone');
    t.reject('GET', '/api/git-root?cwd=%2Ftwo');
    t.reject('GET', '/api/git-root?cwd=%2Fthree');
    assert.strictEqual(t.rejections().length, 1, 'query strings must not create new keys');
    // The line that IS logged keeps the full URL — the first sighting is where the detail belongs.
    assert.match(t.rejections()[0], /\/api\/git-root\?cwd=%2Fone/);
  });

  it('collapses id-bearing path segments', () => {
    // The incident's second-loudest line was /api/workshop/items/blocked%3A<sessionId>/screen — 48
    // of them. Keying on the raw path mints one key per session, and once past the key cap every
    // later session falls into the anonymous overflow bucket instead of being named once.
    const t = fresh();
    t.reject('GET', '/api/workshop/items/blocked%3A31b72d2a/screen');
    t.reject('GET', '/api/workshop/items/blocked%3Aaa839f69/screen');
    t.reject('GET', '/api/workshop/items/blocked%3A90f893a0/screen');
    assert.strictEqual(t.rejections().length, 1, 'one poller, one line');
    t.security._rejectLog.flush();
    assert.match(t.rollups()[0], /\/api\/workshop\/items\/:id\/screen — invalid auth cookie ×3/);
  });

  it('does not collapse ordinary path segments', () => {
    // The normalization has to stop at things that actually look like ids, or every endpoint
    // collapses into one key and the log stops naming what is broken.
    const t = fresh();
    t.reject('GET', '/api/workshop/inbox');
    t.reject('GET', '/api/workshop/items');
    t.reject('GET', '/api/scheduled-tasks');
    assert.strictEqual(t.rejections().length, 3);
  });

  it('bounds the key map so unique URLs cannot grow it without limit', () => {
    const t = fresh();
    for (let i = 0; i < 200; i++) t.reject('GET', `/api/does-not-exist-${i}`);
    assert.ok(t.rejections().length <= 50,
      `expected the key cap to hold, got ${t.rejections().length} lines`);
    t.security._rejectLog.flush();
    assert.ok(t.lines.some(l => /more rejections across other endpoints/.test(l)),
      'rejections past the key cap must still be counted, not dropped silently');
  });

  it('WS upgrade rejections share the prefix and the throttle', () => {
    // They used to read `Rejected WS upgrade: …`, so a grep for `Auth: rejected` found every HTTP
    // rejection and no WS one — which is how #675 concluded from the log that zero upgrades had
    // ever been rejected, when in fact one is what finally ended the storm.
    const t = fresh();
    const info = {
      req: {
        headers: {
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
          cookie: `${t.security.cookieName}=nope`,
        },
      },
    };
    for (let i = 0; i < 5; i++) t.security.verifyWsClient(info, () => {});
    assert.strictEqual(t.rejections().length, 1, 'repeated upgrade rejections must collapse too');
    assert.match(t.rejections()[0], /^Auth: rejected WS upgrade — invalid auth cookie$/);
    t.security._rejectLog.flush();
    assert.match(t.rollups()[0], /×5 in 60s/);
  });

  it('does not emit a rollup for a cause that never repeated', () => {
    const t = fresh();
    t.reject('GET', '/api/version');
    t.security._rejectLog.flush();
    assert.strictEqual(t.rollups().length, 0, 'a single rejection needs no "×1" follow-up');
  });

  it('the origin gate for unauthenticated routes is throttled the same way', () => {
    const t = fresh();
    const res = { status: () => res, type: () => res, send: () => {} };
    for (let i = 0; i < 10; i++) {
      t.security.requireAllowedOrigin(
        { method: 'POST', url: '/api/client-log', headers: { origin: 'https://evil.example' } },
        res, () => { throw new Error('must not pass'); });
    }
    assert.strictEqual(t.rejections().length, 1,
      'a page hammering the beacon from a foreign origin must not get a line per attempt');
  });
});
