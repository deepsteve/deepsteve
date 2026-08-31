// The error beacon has to see every realm's fetch, and a 401 has to heal.
//
// #675: a mod iframe is same-origin but a separate JS realm with its own untouched window.fetch, so
// wrapping only the shell's left the workshop panel invisible — it polled a stale cookie every 2s
// for 29 minutes, producing 660 daemon-log rejections, zero client-side lines, and no heal, because
// the heal was reachable only from the two WebSocket reconnect loops and this realm holds no socket.
// These tests pin the two halves of the fix: any realm can be wrapped, and a 401 from any of them
// triggers the shell's heal.
//
// Run: node --test test/unit/client-log-realm.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// A stand-in for one realm's global. Only what client-log.js actually touches.
function fakeRealm(responder) {
  const calls = [];
  return {
    calls,
    win: {
      fetch(input, init) {
        calls.push({ url: typeof input === 'string' ? input : input && input.url, init });
        return Promise.resolve(responder(typeof input === 'string' ? input : ''));
      },
    },
  };
}

const ok = () => ({ status: 200 });
const unauthorized = () => ({ status: 401 });

test('client-log realm coverage', async (t) => {
  // A minimal DOM/global surface. auth-heal.js is imported transitively and reads sessionStorage,
  // document and location at call time; storage-namespace.js walks window.parent at import time, so
  // window.parent must be window or every key silently gains a `ds1-` prefix.
  const healReloads = [];
  global.sessionStorage = {
    _v: {},
    getItem(k) { return this._v[k] ?? null; },
    setItem(k, v) { this._v[k] = String(v); },
    removeItem(k) { delete this._v[k]; },
  };
  global.location = { origin: 'http://deepsteve.localhost:3000', pathname: '/' };
  global.document = {
    head: { appendChild: (el) => healReloads.push(el.content) },
    createElement: () => ({ set httpEquiv(_v) {}, content: '' }),
    addEventListener() {},
  };
  global.window = { addEventListener() {}, parent: null, fetch: () => Promise.resolve(ok()) };
  global.window.parent = global.window;

  // auth-heal.js probes with a bare `fetch('/api/version')`, which resolves to the global — not to
  // window.fetch. Stub it so the probe is observable and never reaches the network. 200 means "auth
  // is fine after all", which is the branch that returns without reloading: the heal is proven to
  // have RUN without dragging a page reload (and its 3s watchdog timer) into a unit test.
  const probes = [];
  global.fetch = (url) => { probes.push(String(url)); return Promise.resolve(ok()); };

  const mod = await import('../../public/js/client-log.js');
  const { wrapRealmFetch } = mod;

  await t.test('wraps a child realm without disturbing its responses', async () => {
    const realm = fakeRealm(ok);
    const original = realm.win.fetch;
    wrapRealmFetch(realm.win, 'mod:workshop');
    assert.notStrictEqual(realm.win.fetch, original, 'the realm must actually be wrapped');
    const res = await realm.win.fetch('/api/workshop/inbox');
    assert.strictEqual(res.status, 200, 'the wrapper must pass the response straight through');
    assert.strictEqual(realm.calls.length, 1, 'and must make exactly one underlying call');
  });

  await t.test('is idempotent, so re-wrapping on every iframe load is safe', () => {
    // The `load` listeners that call this are deliberately not { once: true } — a mod iframe whose
    // src is reassigned has to be re-wrapped. That makes double-wrapping the normal case, and a
    // stacked wrapper would double-record every failure.
    const realm = fakeRealm(ok);
    wrapRealmFetch(realm.win, 'mod:workshop');
    const once = realm.win.fetch;
    wrapRealmFetch(realm.win, 'mod:workshop');
    assert.strictEqual(realm.win.fetch, once, 'a second wrap must be a no-op');
  });

  await t.test('a realm with no fetch is skipped rather than throwing', () => {
    const win = {};
    wrapRealmFetch(win, 'empty');
    assert.strictEqual(win.fetch, undefined);
  });

  await t.test('the beacon endpoint is excluded, so it cannot report itself', async () => {
    // POST /api/client-log is a /api/ path. Without the exclusion a throttled beacon answering 429
    // records an entry, which schedules another POST, which answers 429 — a self-feeding loop in
    // the one component whose job is to report loops.
    probes.length = 0;
    const realm = fakeRealm(unauthorized);
    wrapRealmFetch(realm.win, 'shell-ish');
    await realm.win.fetch('/api/client-log', { method: 'POST' });
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(realm.calls.length, 1,
      'the beacon endpoint must not feed itself more requests');
    assert.strictEqual(probes.length, 0, 'and a 401 from it must not even probe');
  });

  await t.test('a 401 in a child realm triggers the heal', async () => {
    // The whole point: the workshop iframe holds no socket, so before this nothing it did could
    // ever reach maybeHealAuth — its 401s just repeated at 2s forever.
    probes.length = 0;
    const realm = fakeRealm(unauthorized);
    wrapRealmFetch(realm.win, 'mod:workshop');
    await realm.win.fetch('/api/workshop/inbox');
    await new Promise(r => setTimeout(r, 10));
    assert.deepStrictEqual(probes, ['/api/version'],
      'a 401 from a mod iframe must reach the shell heal probe');
    assert.strictEqual(realm.calls.length, 1, 'and must not re-probe through the child realm');
  });

  await t.test('the heal is not re-triggered inside its own 2s probe cooldown', async () => {
    // The probe is itself a /api/ fetch through this wrapper, so without the in-flight and cooldown
    // guards a 401 would probe, and the probe would 401, and so on.
    probes.length = 0;
    const realm = fakeRealm(unauthorized);
    wrapRealmFetch(realm.win, 'mod:tasks');
    for (let i = 0; i < 10; i++) await realm.win.fetch('/api/workshop/inbox');
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(probes.length, 0,
      'the previous test just probed — 10 more 401s inside the cooldown must add none');
  });

  await t.test('an absolute same-origin URL is recognised as an API path', async () => {
    const realm = fakeRealm(ok);
    wrapRealmFetch(realm.win, 'shell');
    const res = await realm.win.fetch('http://deepsteve.localhost:3000/api/version');
    assert.strictEqual(res.status, 200);
  });

  await t.test('a non-API path is passed through untouched', async () => {
    const realm = fakeRealm(unauthorized);
    wrapRealmFetch(realm.win, 'shell');
    const res = await realm.win.fetch('https://example.com/whatever');
    assert.strictEqual(res.status, 401, 'a foreign 401 is not our business');
  });
});

// The beacon's transport choice. The socket is preferred and the HTTP fallback is deliberately
// patient: a daemon restart drops the socket for a few seconds and brings it back, and POSTing into
// a server that is still down would lose the entries the queue was holding for it.
test('client-log transport selection', async (t) => {
  const posts = [];
  global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.location = { origin: 'http://deepsteve.localhost:3000', pathname: '/' };
  global.document = { addEventListener() {}, head: { appendChild() {} }, createElement: () => ({}) };
  global.window = { addEventListener() {}, parent: null, fetch: () => Promise.resolve(ok()) };
  global.window.parent = global.window;
  global.fetch = () => Promise.resolve(ok());

  // A fresh module instance: the queue and the miss counter are module state.
  const mod = await import('../../public/js/client-log.js?transport');
  const { clientLog, attachClientLogSender, wrapRealmFetch, flushClientLog } = mod;

  // Give it a captured fetch (the shell wrap) and observe what the fallback sends.
  wrapRealmFetch({ fetch: (url, init) => { posts.push({ url, init }); return Promise.resolve(ok()); } }, 'shell');

  let socketState = 1;
  const sent = [];
  attachClientLogSender(() => ({ readyState: socketState, send: (m) => sent.push(m) }), 'win-1');

  await t.test('prefers the socket while it is open', () => {
    clientLog('js-error', 'boom');
    flushClientLog();
    assert.strictEqual(sent.length, 1, 'an open socket must carry the batch');
    assert.strictEqual(posts.length, 0, 'and nothing should be POSTed');
  });

  await t.test('holds the queue through a short socket outage', () => {
    socketState = 0; // CONNECTING — a restart in progress
    clientLog('js-error', 'during restart');
    flushClientLog();
    assert.strictEqual(posts.length, 0, 'must not POST into a server that is probably still down');
    socketState = 1;
    flushClientLog();
    assert.strictEqual(sent.length, 2, 'the held entry rides the socket when it comes back');
  });

  await t.test('falls back to HTTP once the socket has clearly gone for good', () => {
    socketState = 0;
    clientLog('fetch-401', 'GET /api/workshop/inbox');
    for (let i = 0; i < 6; i++) flushClientLog();
    assert.strictEqual(posts.length, 1, 'a realm that will never get a socket must still report');
    assert.strictEqual(posts[0].url, '/api/client-log');
    const body = JSON.parse(posts[0].init.body);
    assert.strictEqual(body.windowId, 'win-1', 'the HTTP path has no socket to read the id from');
    assert.strictEqual(body.entries[0].kind, 'fetch-401');
  });
});
