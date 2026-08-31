// Headless unit test for initLiveReload()'s connect loop in public/js/live-reload.js (#674).
//
// This module had no unit coverage at all, and it was the one that broke. Two defects,
// both invisible from the server side:
//
//   1. The connect() at the end of initLiveReload() fired blind — the only ungated
//      handshake in the tree. On a machine reboot the browser restores this tab before the
//      daemon is listening, so that handshake is guaranteed to fail on every page load.
//   2. Every failure re-entered through pollAndReconnect(), which awaited /healthz (~1ms
//      on localhost when the server is up) and immediately reconnected. No backoff, no
//      failure accounting. Against a server that was up but rejecting our cookie, that is
//      a fresh doomed handshake every fetch round trip.
//
// Both feed the same browser-global FailDelay entry, which is shared by EVERY DeepSteve
// socket in the browser (server-probe.js's header has the mechanism). Fourteen failures
// pin it at its 60s cap, and then all thirteen of the page's sockets sit silent in
// readyState CONNECTING and open in one burst a minute later. The loop poisons the page
// and then goes quiet, because its own handshakes stop reaching the server too — which is
// why the daemon log shows so few rejected upgrades for so much damage.
//
// So the assertion throughout is how many sockets were constructed: what matters is not
// that we reconnect, but that we emit NOTHING while we have reason to believe it would fail.
//
// window.parent = window keeps storage-namespace.js at depth 0; without it every storage
// key silently gains a ds1- prefix and the reload-trace handoff stops matching.
//
// Run: node --test test/unit/live-reload-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// --------------------------------------------------------------- globals

globalThis.window = globalThis;
globalThis.window.parent = globalThis.window;
globalThis.location = {
  protocol: 'http:',
  host: 'deepsteve.localhost:3000',
  pathname: '/',
  href: 'http://deepsteve.localhost:3000/',
  hash: '',
  replace() {},
};
globalThis.history = { replaceState() {} };
globalThis.addEventListener = () => {};

const store = new Map();
globalThis.sessionStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

// forcePageReload() appends a <meta http-equiv=refresh>; nothing here navigates, so the
// stub only has to not throw.
globalThis.document = {
  addEventListener: () => {},
  hidden: false,
  visibilityState: 'visible',
  createElement: () => ({}),
  head: { appendChild() {} },
};

globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; }
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
};

// Each case starts its own initLiveReload() loop and there is no way to stop the previous
// one — the reload socket is meant to reconnect for the life of the page, so a finished
// case leaves a loop that will open another socket, on its own backoff, in the middle of
// the next case. Every case therefore gets its own windowId, which rides the URL, and
// assertions read mine() rather than the raw array.
const sockets = [];
let winSeq = 0;
let winId = 'w0';
const mine = () => sockets.filter(s => s.url.includes('windowId=' + winId + '&') || s.url.endsWith('windowId=' + winId));
let fetchImpl = async () => ({ ok: true, status: 200 });
globalThis.fetch = (...a) => fetchImpl(...a);

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
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
  send() {}
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() {}
  close() {
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', { wasClean: !wasConnecting, code: wasConnecting ? 1006 : 1000 });
  }
}
globalThis.WebSocket = FakeWebSocket;

const tick = (n = 25) => new Promise(r => setTimeout(r, n));

async function load() {
  // Fresh live-reload per case, since initLiveReload() starts a loop that runs for the
  // life of the "page". auth-heal is imported WITHOUT the cachebust on purpose: a query
  // string does not propagate to a module's own relative imports, so this is the exact
  // instance live-reload will consult, and its verdict cache leaks between cases.
  const auth = await import('../../public/js/auth-heal.js');
  auth._reset();
  const trace = await import('../../public/js/ws-trace.js');
  trace._reset();
  const mod = await import('../../public/js/live-reload.js?t=' + Math.random());
  return mod.initLiveReload;
}

function reset() {
  winId = 'w' + (++winSeq);
  store.clear();
  fetchImpl = async () => ({ ok: true, status: 200 });
  delete globalThis.window.__deepsteveReloadPending;
}

// Every case must END with the server answering and the last socket left CONNECTING.
// Two ref'd timers would otherwise keep `node --test` alive forever: server-probe's
// backoff sleep between /healthz probes, and the 45s ping watchdog interval that
// live-reload arms in onopen and clears only on close.

// --------------------------------------------------------------- the gate

test('the first connect is gated too — a page loaded against a dead daemon emits nothing', async () => {
  reset();
  let up = false;
  fetchImpl = async () => { if (!up) throw new Error('ECONNREFUSED'); return { ok: true, status: 200 }; };

  const initLiveReload = await load();
  initLiveReload({ windowId: winId });

  // Probes land at roughly 0 / 250 / 625 / 1200ms. The old trailing connect() fired at 0.
  await tick(1200);
  assert.strictEqual(mine().length, 0,
    'initLiveReload() used to end in a bare connect() — the one blind handshake in the tree, ' +
    'fired on every page load including the reboot case where the daemon cannot be up yet (#674)');

  up = true;
  await tick(1500);
  assert.strictEqual(mine().length, 1, 'and the gate opens rather than wedging shut');
  assert.match(mine()[0].url, /action=reload/);
  assert.ok(mine()[0].url.includes('windowId=' + winId));
});

test('a healthy page load opens exactly one socket', async () => {
  reset();
  const initLiveReload = await load();
  initLiveReload({ windowId: winId });

  await tick(300);
  assert.strictEqual(mine().length, 1, 'the retry loop must not double-connect on a good server');
  mine()[0]._open();
  await tick(300);
  assert.strictEqual(mine().length, 1, 'and an open socket is not replaced');

  // Leave it closed so the 45s ping interval armed in onopen cannot outlive the test.
  mine()[0]._die({ wasClean: true, code: 1000 });
  await tick(300);
});

// --------------------------------------------------------------- the reconnect loop

test('a rejected upgrade is retried with a delay, not at fetch speed', async () => {
  reset();
  let probes = 0;
  fetchImpl = async () => { probes++; return { ok: true, status: 200 }; };

  const initLiveReload = await load();
  initLiveReload({ windowId: winId });
  await tick(200);
  assert.strictEqual(mine().length, 1);

  // The 1006 a rejected upgrade produces: the browser never shows us the 401, so this is
  // indistinguishable from "server down" — except that /healthz keeps answering.
  probes = 0;
  mine()[0]._die({ wasClean: false, code: 1006 });

  await tick(400);
  assert.strictEqual(mine().length, 1,
    'the old pollAndReconnect() reconnected the instant /healthz answered, with no backoff of ' +
    'any kind — that loop is what pinned the browser-global FailDelay entry at its 60s cap (#674)');
  assert.ok(probes <= 4,
    `and it must not spin the probe either: ${probes} /healthz probes in 400ms`);

  await tick(1400);
  assert.strictEqual(mine().length, 2, 'retries once the backoff elapses');
});

test('a pending reload parks the loop instead of racing the navigation', async () => {
  reset();
  const initLiveReload = await load();
  initLiveReload({ windowId: winId });
  await tick(200);
  assert.strictEqual(mine().length, 1);

  // A heal or restart reload is navigating this page away. A handshake started now is one
  // the navigation aborts, and an aborted handshake counts as a failure to FailDelay.
  globalThis.window.__deepsteveReloadPending = true;
  mine()[0]._die({ wasClean: false, code: 1006 });

  await tick(1500);
  assert.strictEqual(mine().length, 1, 'no churn while the page is on its way out');

  // auth-heal's watchdog clears the flag when the meta-refresh silently fails to navigate.
  // The loop must resume rather than wedge — which is why it parks instead of exiting.
  globalThis.window.__deepsteveReloadPending = false;
  await tick(2500);
  assert.strictEqual(mine().length, 2, 'and resumes if the reload never happened');
});

// --------------------------------------------------------------- the auth half of the gate

test('a cookie the server has already rejected costs zero handshakes', async () => {
  reset();
  // /healthz is unauthenticated and answers fine; /api/version reports the 401 that
  // verifyWsClient would turn into a rejected upgrade. Pre-arm auth-heal's 60s one-reload
  // guard so the heal is SUPPRESSED — the case where we know the handshake is doomed,
  // cannot fix it by reloading, and used to send it anyway.
  store.set('deepsteve-auth-healed', String(Date.now()));
  fetchImpl = async (url) => (String(url).includes('/api/version')
    ? { ok: false, status: 401 }
    : { ok: true, status: 200 });

  const initLiveReload = await load();
  initLiveReload({ windowId: winId });

  await tick(400);
  assert.strictEqual(mine().length, 0,
    'in a window with no terminal sessions this socket is the only reconnect loop there is, ' +
    'so an unauthed page here hot-loops rejected upgrades and silences the whole browser (#674)');

  fetchImpl = async () => ({ ok: true, status: 200 });
  await tick(5000);
  assert.strictEqual(mine().length, 1, 'and connects once the cookie is accepted again');
});
