// Unit tests for connection-status.js (#556) — the per-connection reconnect
// tracker behind the tab-strip dot and the "Connection lost" banner.
//
// Tier 1 drives the tracker directly with spy callbacks and a short grace.
// Tier 2 replays the exact bug from the issue against a real socket: a
// brand-new tab whose FIRST connect never succeeds (no session, no tab, no
// container) must still surface the banner, and recovery must clear it.
//
// Run: node --test test/unit/connection-status.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const WS = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GRACE = 25;
const AFTER_GRACE = 80;

function makeTracker(overrides = {}) {
  const indicatorCalls = []; // [tabId, on]
  const bannerCalls = [];    // count per render
  const { createConnectionTracker } = overrides.mod;
  const tracker = createConnectionTracker({
    setTabIndicator: (tabId, on) => indicatorCalls.push([tabId, on]),
    renderBanner: (count) => bannerCalls.push(count),
    graceMs: GRACE,
    isReloadPending: overrides.isReloadPending || (() => false),
  });
  return { tracker, indicatorCalls, bannerCalls };
}

test('connection-status tracker', async (t) => {
  const mod = await import('../../public/js/connection-status.js');

  await t.test('indicator is immediate, banner only after grace', async () => {
    const { tracker, indicatorCalls, bannerCalls } = makeTracker({ mod });
    const h = tracker.track({ tabId: 'abc' });
    h.noteReconnecting();
    assert.deepStrictEqual(indicatorCalls, [['abc', true]], 'dot shown immediately');
    assert.deepStrictEqual(bannerCalls, [], 'banner waits out the grace period');
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [1], 'banner rendered after grace');
    h.noteReconnected();
    assert.deepStrictEqual(indicatorCalls, [['abc', true], ['abc', false]]);
    assert.deepStrictEqual(bannerCalls, [1, 0], 'banner hidden immediately on recovery');
  });

  await t.test('a blip shorter than the grace never shows the banner', async () => {
    const { tracker, indicatorCalls, bannerCalls } = makeTracker({ mod });
    const h = tracker.track({ tabId: 'abc' });
    h.noteReconnecting();
    h.noteReconnected();
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [], 'no banner for a sub-grace blip');
    assert.deepStrictEqual(indicatorCalls, [['abc', true], ['abc', false]]);
  });

  await t.test('isNew handle: silent until setSessionId, then fully live', async () => {
    const { tracker, indicatorCalls, bannerCalls } = makeTracker({ mod });
    const h = tracker.track({ tabId: null, bannerEligible: false });
    h.noteReconnecting();
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(indicatorCalls, [], 'no tab yet, no dot');
    assert.deepStrictEqual(bannerCalls, [], 'pending-create banner owns the pre-session outage');
    h.setSessionId('s1');
    assert.deepStrictEqual(indicatorCalls, [['s1', true]], 'dot lands on the new tab id');
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [1], 'now banner-eligible');
  });

  await t.test('banner counts multiple down connections and tracks recovery', async () => {
    const { tracker, bannerCalls } = makeTracker({ mod });
    const a = tracker.track({ tabId: 'a' });
    const b = tracker.track({ tabId: 'b' });
    a.noteReconnecting();
    b.noteReconnecting();
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [2]);
    assert.strictEqual(tracker.reconnectingCount(), 2);
    a.noteReconnected();
    assert.deepStrictEqual(bannerCalls, [2, 1]);
    b.noteReconnected();
    assert.deepStrictEqual(bannerCalls, [2, 1, 0]);
  });

  await t.test('suppression hides the banner but the grace clock keeps running', async () => {
    const { tracker, bannerCalls } = makeTracker({ mod });
    tracker.setSuppressed(true);
    const h = tracker.track({ tabId: 'a' });
    h.noteReconnecting();
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [], 'suppressed while pending-create banner shows');
    tracker.setSuppressed(false);
    assert.deepStrictEqual(bannerCalls, [1], 'appears immediately — grace already elapsed');
  });

  await t.test('untrack mid-outage clears the dot and the banner', async () => {
    const { tracker, indicatorCalls, bannerCalls } = makeTracker({ mod });
    const h = tracker.track({ tabId: 'a' });
    h.noteReconnecting();
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [1]);
    h.untrack();
    assert.deepStrictEqual(indicatorCalls, [['a', true], ['a', false]]);
    assert.deepStrictEqual(bannerCalls, [1, 0], 'closing the tab must not pin the banner');
    h.noteReconnecting(); // socket may still fire after teardown
    assert.strictEqual(tracker.reconnectingCount(), 0, 'untracked handle is inert');
  });

  await t.test('no banner while an auth-heal reload is pending', async () => {
    const { bannerCalls, tracker } = makeTracker({ mod, isReloadPending: () => true });
    const h = tracker.track({ tabId: 'a' });
    h.noteReconnecting();
    await sleep(AFTER_GRACE);
    assert.deepStrictEqual(bannerCalls, [], 'heal-reload is about to navigate; stay quiet');
  });

  await t.test('setSessionId moves a live indicator to the new id', async () => {
    const { tracker, indicatorCalls } = makeTracker({ mod });
    const h = tracker.track({ tabId: 'requested' });
    h.noteReconnecting();
    h.setSessionId('assigned');
    assert.deepStrictEqual(indicatorCalls,
      [['requested', true], ['requested', false], ['assigned', true]]);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — the issue's headline case against a real socket: a restore tab
// whose first connect never completes a session handshake (no sessions entry,
// no container — only a placeholder tab). Harness matches
// ws-client-probe.test.js: Node's native WebSocket global as the client, the
// `ws` package as the server, fake browser globals for ws-client's imports.
//
// Browsers fire close(wasClean=false) even for a TCP-refused first connect,
// which is what enters ws-client's reconnect loop. Node's undici never fires
// close for a failed connection *establishment* (error only, readyState stuck
// at CONNECTING), so the "server down" here is an accept-then-terminate — the
// same app-level state (first connect dies before any {type:'session'}
// message) through a close event undici actually delivers.
// ---------------------------------------------------------------------------
globalThis.window = globalThis;
window.parent = window; // storage-namespace: depth 0, no ds1- prefix
const storeMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};
globalThis.document = { addEventListener: () => {}, hidden: false };
globalThis.addEventListener = () => {};
globalThis.fetch = async () => ({ status: 200 }); // auth-heal probe: always "auth fine"

test('first connect that never lands a session still raises dot + banner (#556)', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  const { createConnectionTracker } = await import('../../public/js/connection-status.js');

  let serverMode = 'dead'; // 'dead' kills every connection before any message
  const server = new WS.WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => server.on('listening', r));
  server.on('connection', (sock) => { if (serverMode === 'dead') sock.terminate(); });
  globalThis.location = { protocol: 'http:', host: `127.0.0.1:${server.address().port}` };

  const indicatorCalls = [];
  const bannerCalls = [];
  const tracker = createConnectionTracker({
    setTabIndicator: (tabId, on) => indicatorCalls.push([tabId, on]),
    renderBanner: (count) => bannerCalls.push(count),
    graceMs: GRACE,
    isReloadPending: () => false,
  });

  // Wire exactly as app.js does for a restore: track with the requested id
  // (the placeholder tab's id) before any session exists.
  const wrapper = createWebSocket({ id: 'restore1', cwd: '/tmp' });
  const handle = tracker.track({ tabId: 'restore1' });
  wrapper.onreconnecting = () => handle.noteReconnecting();
  wrapper.onreconnected = () => { handle.noteReconnected(); wrapper._testReconnected?.(); };

  // While 'dead', each ~1s retry may briefly open before being terminated, so
  // assert on the settled state rather than exact call sequences.
  await sleep(500);
  assert.strictEqual(tracker.reconnectingCount(), 1,
    'a connection that never landed a session is tracked as reconnecting');
  assert.deepStrictEqual(indicatorCalls.at(-1), ['restore1', true],
    'dot shown on the placeholder tab');
  assert.strictEqual(bannerCalls.at(-1), 1, 'banner raised after grace');

  // Server comes back; the retry loop recovers within ~1s.
  serverMode = 'alive';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never reconnected')), 5000);
    wrapper._testReconnected = () => { clearTimeout(timer); resolve(); };
  });
  assert.strictEqual(tracker.reconnectingCount(), 0);
  assert.deepStrictEqual(indicatorCalls.at(-1), ['restore1', false], 'dot cleared on recovery');
  assert.strictEqual(bannerCalls.at(-1), 0, 'banner hidden on recovery');

  // Drain the close handshake so the process can exit (see ws-client-probe).
  const closed = new Promise(r => { wrapper.onclose = r; });
  wrapper.close();
  await closed;
  server.close();
  for (const c of server.clients) { try { c.terminate(); } catch {} }
});
