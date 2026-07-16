// Headless unit test for createWebSocket() in public/js/ws-client.js (#553).
//
// No browser, no Docker: stub the handful of globals the module chain touches and drive
// the wrapper directly. Two properties matter and both were real bugs:
//
//   1. The /healthz gate — no WebSocket may be constructed while the server is down.
//      Every failed handshake ramps Firefox's FailDelay (x1.5, cap 60s), and that entry
//      is shared by every DeepSteve socket in the browser and outlives any usable retry
//      interval. So "don't emit doomed handshakes" is THE fix, not a nicety.
//   2. close() must not resurrect the loop. Closing a CONNECTING socket fires onclose
//      with wasClean=false, which used to pass the reconnect guard and arm a NEW 1Hz
//      interval nothing held a handle to — and with no `id` in the URL (setSessionId
//      hadn't run), every tick asked the server to spawn a brand-new shell.
//
// window.parent = window keeps storage-namespace.js (via auth-heal.js) at depth 0;
// without it every storage key silently gains a ds1- prefix.
//
// Run: node --test test/unit/ws-client.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// --------------------------------------------------------------- globals

globalThis.window = globalThis;
globalThis.window.parent = globalThis.window;
globalThis.location = { protocol: 'http:', host: 'deepsteve.localhost:3000', pathname: '/' };

const store = new Map();
globalThis.sessionStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

// Every socket the module constructs, in order. The gate's whole job is to keep this
// array empty while the server is down, so its length IS the assertion.
let sockets = [];
let fetchImpl = async () => ({ ok: true, status: 200 });
globalThis.fetch = (...a) => fetchImpl(...a);

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    sockets.push(this);
  }
  // --- test drivers ---
  _open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  _die({ wasClean = false, code = 1006 } = {}) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ wasClean, code });
  }
  // --- the real API surface ---
  send() {}
  close() {
    // Matches the WHATWG behaviour that caused the bug: closing a CONNECTING socket
    // "fails the connection" → onclose with wasClean=false, NOT a clean close.
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ wasClean: !wasConnecting, code: wasConnecting ? 1006 : 1000 });
  }
}
globalThis.WebSocket = FakeWebSocket;

const tick = (n = 25) => new Promise(r => setTimeout(r, n));

async function load() {
  // Fresh module instances per test: server-probe.js and auth-heal.js both hold
  // module-level dedupe state that would otherwise leak across tests.
  const q = '?t=' + Math.random();
  const probe = await import('../../public/js/server-probe.js' + q);
  const mod = await import('../../public/js/ws-client.js' + q);
  return { createWebSocket: mod.createWebSocket, probe };
}

function reset() {
  sockets = [];
  store.clear();
  fetchImpl = async () => ({ ok: true, status: 200 });
  delete globalThis.window.__deepsteveReloadPending;
}

// --------------------------------------------------------------- the gate

test('opens no WebSocket until /healthz answers', async () => {
  reset();
  let up = false;
  fetchImpl = async () => { if (!up) throw new Error('ECONNREFUSED'); return { ok: true, status: 200 }; };

  const { createWebSocket } = await load();
  createWebSocket({ cwd: '/tmp' });

  await tick(150);
  assert.strictEqual(sockets.length, 0, 'server down → must not construct a WebSocket');

  up = true;
  await tick(700); // first retry lands ~250ms +/- jitter
  assert.strictEqual(sockets.length, 1, 'server up → exactly one socket');
});

test('a restart costs zero failed handshakes', async () => {
  reset();
  const { createWebSocket } = await load();
  createWebSocket({ cwd: '/tmp' });
  await tick(60);
  assert.strictEqual(sockets.length, 1);
  sockets[0]._open();

  // Daemon goes away: the live socket drops uncleanly and /healthz stops answering.
  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  sockets[0]._die({ wasClean: false });

  await tick(900);
  assert.strictEqual(sockets.length, 1, 'no new sockets while the server is down');

  fetchImpl = async () => ({ ok: true, status: 200 });
  await tick(900);
  assert.strictEqual(sockets.length, 2, 'reconnects once the server answers again');
});

// --------------------------------------------------------------- close()

test('close() during CONNECTING does not arm a reconnect loop', async () => {
  reset();
  const { createWebSocket } = await load();
  const ws = createWebSocket({ cwd: '/tmp' });
  await tick(60);
  assert.strictEqual(sockets.length, 1);
  assert.strictEqual(sockets[0].readyState, FakeWebSocket.CONNECTING);

  ws.close(); // fires onclose with wasClean=false — the old guard re-armed here

  await tick(1500);
  assert.strictEqual(sockets.length, 1, 'close() must not spawn further sockets');
});

test('close() during CONNECTING never re-requests session creation', async () => {
  reset();
  const { createWebSocket } = await load();
  // The dangerous shape: a brand-new session closed before the server confirmed it. Any
  // reconnect here re-asks the server to create, so this is a data bug, not just latency.
  const ws = createWebSocket({ cwd: '/tmp', isNew: true });
  await tick(60);
  ws.close();
  await tick(1500);

  const spawning = sockets.filter(s => s.url.includes('new=1'));
  assert.strictEqual(spawning.length, 1, 'must not repeatedly ask the server to spawn shells');
  // #554: and even that one create is idempotent — it carries a client-minted 8-hex id.
  assert.match(spawning[0].url, /id=[0-9a-f]{8}/, 'new-session URL carries a minted id');
});

test('close() while OPEN stops the loop', async () => {
  reset();
  const { createWebSocket } = await load();
  const ws = createWebSocket({ cwd: '/tmp' });
  await tick(60);
  sockets[0]._open();
  ws.close();
  await tick(900);
  assert.strictEqual(sockets.length, 1);
});

// --------------------------------------------------------------- reconnect semantics

test('a clean close is honoured, not fought', async () => {
  reset();
  const { createWebSocket } = await load();
  createWebSocket({ cwd: '/tmp' });
  await tick(60);
  sockets[0]._open();
  sockets[0]._die({ wasClean: true, code: 1000 }); // server said goodbye
  await tick(900);
  assert.strictEqual(sockets.length, 1, 'clean close must not reconnect');
});

test('fires onreconnecting once, then onreconnected on success', async () => {
  reset();
  const { createWebSocket } = await load();
  const ws = createWebSocket({ cwd: '/tmp' });
  let reconnecting = 0, reconnected = 0;
  ws.onreconnecting = () => reconnecting++;
  ws.onreconnected = () => reconnected++;

  await tick(60);
  sockets[0]._open();
  sockets[0]._die({ wasClean: false });
  await tick(400);

  assert.strictEqual(reconnecting, 1, 'onreconnecting fires on the drop');
  // The socket died within WS_STABLE_MS of opening, so the retry is paced (~1s backoff)
  // — a short-lived connection counts as a failure, not a stable drop.
  await tick(1300);
  assert.strictEqual(sockets.length, 2);
  sockets[1]._open();
  assert.strictEqual(reconnected, 1, 'onreconnected fires when the new socket opens');
});

test('backs off when the server is up but the upgrade keeps failing', async () => {
  reset();
  const { createWebSocket } = await load();
  createWebSocket({ cwd: '/tmp' });
  await tick(60);
  assert.strictEqual(sockets.length, 1);

  // healthz OK but every upgrade rejected (the auth-rejection race). Without a backoff
  // this is a hot loop that ramps FailDelay harder than the 1Hz code it replaced.
  sockets[0]._die({ wasClean: false });
  await tick(300);
  assert.strictEqual(sockets.length, 1, 'first retry waits ~1s, not immediately');

  await tick(1200);
  assert.strictEqual(sockets.length, 2, 'retried after the backoff');
});

test('pauses while a heal reload is pending, and resumes if it is cancelled', async () => {
  reset();
  const { createWebSocket } = await load();
  createWebSocket({ cwd: '/tmp' });
  await tick(60);
  sockets[0]._open();

  globalThis.window.__deepsteveReloadPending = true;
  sockets[0]._die({ wasClean: false });
  await tick(900);
  assert.strictEqual(sockets.length, 1, 'no churn while the page is navigating away');

  // auth-heal's watchdog clears the flag when the meta-refresh fails to navigate.
  globalThis.window.__deepsteveReloadPending = false;
  await tick(900);
  assert.strictEqual(sockets.length, 2, 'must resume rather than wedge forever');
});

// --------------------------------------------------------------- probe dedupe

test('concurrent connects share one /healthz probe', async () => {
  reset();
  let probes = 0;
  fetchImpl = async () => { probes++; return { ok: true, status: 200 }; };

  const { createWebSocket } = await load();
  // restoreSessions() opens every session via Promise.all — the burst must not become a
  // burst of probes.
  for (let i = 0; i < 20; i++) createWebSocket({ id: 'sess' + i });
  await tick(120);

  assert.strictEqual(sockets.length, 20, 'all sessions connect');
  assert.ok(probes <= 2, `20 concurrent connects should share a probe, got ${probes}`);
});
