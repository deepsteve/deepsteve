// Headless unit test for the #677 signals in public/js/ws-client.js.
//
// The incident: a clobbered auth cookie meant no new WebSocket handshake could be
// accepted, and the UI said nothing for two minutes. ws-client already handled the state
// correctly — it paces the retry rather than spinning — it just did so silently. These
// tests pin the three things that now break that silence:
//
//   1. onunauthed fires when the gate refuses to emit a handshake, so the tab can paint.
//   2. onreconnecting fires when the gate STALLS, so a socket that never gets far enough
//      to close (and therefore never reaches the onclose path everything else hangs off)
//      still marks its tab.
//   3. send() reports whether the write actually went out, so a keystroke typed into a
//      dead socket can be answered instead of vanishing.
//
// Harness matches ws-client.test.js: stubbed globals, a fake WebSocket class, and a
// cache-busted re-import per case because server-probe.js and auth-heal.js both hold
// module-level dedupe state. The page-level auth banner is #676's (auth-heal's
// isAuthLost/onAuthLost); what is asserted here is the per-TAB half.
//
// Run: node --test test/unit/ws-client-unauthed.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// --------------------------------------------------------------- globals

globalThis.window = globalThis;
globalThis.window.parent = globalThis.window; // storage-namespace: depth 0, no ds1- prefix
globalThis.location = { protocol: 'http:', host: 'deepsteve.localhost:3000', pathname: '/' };

const store = new Map();
globalThis.sessionStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
// auth-heal's forcePageReload appends a <meta> and location.replace()s. Neither should
// happen in these cases (the heal cooldown is armed below where it matters), but the
// stubs keep a stray call from taking the process with it.
globalThis.document = {
  addEventListener: () => {},
  hidden: false,
  createElement: () => ({ set httpEquiv(_v) {}, set content(_v) {} }),
  head: { appendChild: () => {} },
};
globalThis.addEventListener = () => {};

let sockets = [];
let fetchImpl = async () => ({ ok: true, status: 200 });
globalThis.fetch = (...a) => fetchImpl(...a);

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this.sent = [];
    this._listeners = new Map();
    sockets.push(this);
  }
  _emit(type, ev) {
    this[`on${type}`]?.(ev);
    for (const fn of this._listeners.get(type) || []) fn(ev);
  }
  _open() { this.readyState = FakeWebSocket.OPEN; this._emit('open', {}); }
  _die({ wasClean = false, code = 1006 } = {}) {
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', { wasClean, code });
  }
  send(d) { this.sent.push(d); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (l) this._listeners.set(type, l.filter(f => f !== fn));
  }
  close() {
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', { wasClean: !wasConnecting, code: wasConnecting ? 1006 : 1000 });
  }
}
globalThis.WebSocket = FakeWebSocket;

const tick = (n = 25) => new Promise(r => setTimeout(r, n));

async function load() {
  const q = '?t=' + Math.random();
  // All three of these are deliberately un-cachebusted. A query string does not propagate
  // to a module's own relative imports, so ws-open.js — which is what actually calls
  // waitForServer() and maybeHealAuth() — always resolves the PLAIN specifier. Reset the
  // instances it will really use; cachebusting them instead resets a copy nothing reads,
  // and the shared one keeps its state. That matters most for server-probe: the stalled
  // gate below leaves a fetch that never settles pinned in its `inFlight`, which would
  // park every subsequent test's gate on one dead promise.
  const probe = await import('../../public/js/server-probe.js');
  probe._reset();
  const auth = await import('../../public/js/auth-heal.js');
  auth._reset();
  auth.noteAuthOk();      // clears the auth-lost state #676 keeps in this module
  const mod = await import('../../public/js/ws-client.js' + q);
  return { createWebSocket: mod.createWebSocket, auth };
}

function reset() {
  sockets = [];
  store.clear();
  fetchImpl = async () => ({ ok: true, status: 200 });
  delete globalThis.window.__deepsteveReloadPending;
}

/**
 * /healthz says the server is up; /api/version says our cookie is no good. That
 * combination is exactly the incident: the daemon is answering, so the reconnect banner's
 * "wait and it'll come back" is wrong, and the gate correctly refuses to emit a handshake
 * it knows will be rejected.
 */
function serveUpButUnauthed() {
  fetchImpl = async (url) => {
    if (String(url).startsWith('/healthz')) return { ok: true, status: 200 };
    return { ok: false, status: 401 };
  };
}

// --------------------------------------------------------------- unauthed

test('a refused cookie fires onunauthed and emits no handshake', async () => {
  reset();
  serveUpButUnauthed();
  // Arm the heal's one-shot guard so this case exercises the state the issue is about:
  // the reload is on cooldown, the verdict is still 'unauthed', and the ONLY thing left
  // to tell the user is what we are asserting here.
  const { createWebSocket, auth } = await load();
  store.set('deepsteve-auth-healed', String(Date.now()));

  let unauthed = 0;
  const ws = createWebSocket({ cwd: '/tmp' });
  ws.onunauthed = () => { unauthed++; };

  await tick(300);
  assert.strictEqual(sockets.length, 0, 'a doomed handshake must never be emitted');
  assert.ok(unauthed >= 1, 'the tab is told it is being refused');
  assert.ok(auth.isAuthLost(), 'and the page-level state (#676) is set too');

  ws.close();
});

test('the refusal is paced, not spun', async () => {
  reset();
  serveUpButUnauthed();
  const { createWebSocket } = await load();
  store.set('deepsteve-auth-healed', String(Date.now()));

  let unauthed = 0;
  const ws = createWebSocket({ cwd: '/tmp' });
  ws.onunauthed = () => { unauthed++; };

  await tick(400);
  // Backoff starts at ~1s, so within 400ms we expect the first refusal and not many more.
  // A bare retry loop here would run at fetch speed — hundreds of iterations — and is the
  // shape that pins Firefox's browser-global FailDelay at its cap.
  assert.ok(unauthed <= 3, `paced, got ${unauthed} refusals in 400ms`);
  assert.strictEqual(sockets.length, 0);

  ws.close();
});

test('auth coming back clears the verdict and connects', async () => {
  reset();
  serveUpButUnauthed();
  const { createWebSocket, auth } = await load();
  store.set('deepsteve-auth-healed', String(Date.now()));

  const ws = createWebSocket({ cwd: '/tmp' });
  ws.onunauthed = () => {};
  await tick(300);
  assert.ok(auth.isAuthLost());

  fetchImpl = async () => ({ ok: true, status: 200 });
  // auth-heal caches its verdict for PROBE_COOLDOWN_MS (2s) so a restore burst costs one
  // request rather than thirteen. Clearing it here stands in for that time passing —
  // without it the next gate pass re-reads 'unauthed' from cache and this asserts on the
  // cooldown rather than on the behaviour under test.
  auth._reset();
  await tick(2500); // past the first backoff
  assert.ok(sockets.length >= 1, 'the gate lets it through once the cookie works');
  sockets[0]._open();
  assert.strictEqual(auth.isAuthLost(), 0, 'an accepted upgrade clears the banner');

  ws.close();
});

// --------------------------------------------------------------- gate stall

test('a stalled gate marks the tab instead of showing nothing', async () => {
  reset();
  // The server never answers /healthz. No socket is constructed, so there is no close
  // event — which is why onreconnecting could not previously describe this state, and why
  // a tab in it rendered its last painted frame and swallowed keystrokes in silence.
  fetchImpl = () => new Promise(() => {});

  const { createWebSocket } = await load();
  let reconnecting = 0;
  const ws = createWebSocket({ cwd: '/tmp' });
  ws.onreconnecting = () => { reconnecting++; };

  await tick(600);
  assert.strictEqual(reconnecting, 0, 'a brief stall must not flash the indicator');

  await tick(1200); // past GATE_STALL_MS (1500ms total)
  assert.strictEqual(reconnecting, 1, 'a real stall says so, exactly once');
  assert.strictEqual(sockets.length, 0);

  ws.close();
});

test('a healthy connect never flashes the stall indicator', async () => {
  reset();
  const { createWebSocket } = await load();
  let reconnecting = 0;
  const ws = createWebSocket({ cwd: '/tmp' });
  ws.onreconnecting = () => { reconnecting++; };

  await tick(200);
  assert.strictEqual(sockets.length, 1);
  sockets[0]._open();
  await tick(1600); // well past the stall timer, had it not been cleared
  assert.strictEqual(reconnecting, 0, 'the gate resolved; nothing to report');

  ws.close();
});

// --------------------------------------------------------------- dropped input

test('send() reports whether the write actually went out', async () => {
  reset();
  const { createWebSocket } = await load();
  const ws = createWebSocket({ cwd: '/tmp' });

  // Pre-gate: no socket exists yet. This is the window a user types into after a restart.
  assert.strictEqual(ws.send('ls\r'), false, 'no socket → the keystroke did not land');
  assert.strictEqual(ws.sendJSON({ type: 'ping' }), false);

  await tick(200);
  sockets[0]._open();
  assert.strictEqual(ws.send('ls\r'), true, 'open → it went out');
  assert.deepStrictEqual(sockets[0].sent, ['ls\r']);

  sockets[0]._die();
  assert.strictEqual(ws.send('more\r'), false, 'dead socket → reported, not swallowed');
  assert.deepStrictEqual(sockets[0].sent, ['ls\r'], 'and nothing was written to it');

  ws.close();
});
