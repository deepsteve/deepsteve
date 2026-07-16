// Headless test of ws-client.js's wake-probe state machine (#563), run against
// a REAL WebSocket server (`ws` package). The client side uses Node 22's
// native WebSocket global (undici) — the same browser API the real code runs
// on. (Don't substitute the `ws` package as the client global: its sockets
// keep the node:test process alive after completion.) Wake events are injected
// via the wrapper's _onWake() hook; wake-watch itself has its own unit tests.
//
// What it proves:
//  - a probe on a healthy socket gets a pong and changes nothing
//  - a probe the server never answers force-closes the socket and starts the
//    reconnect loop even though a client-initiated close is a *clean* close
//    (the probeFailed override), and the loop then reconnects successfully
//
// Slow by design: the probe timeout is ws-client's real 5s constant.
//
// Run: node --test test/unit/ws-client-probe.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WS = require('ws');

// ---------------------------------------------------------------- fake globals
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
// client side: Node's native WebSocket global (browser-compatible)

let server;
let received = []; // JSON control messages the server got
let serverMode = 'echo'; // 'echo' answers pings; 'silent' swallows them
let connections = 0;

before(async () => {
  server = new WS.WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => server.on('listening', r));
  server.on('connection', (sock) => {
    connections++;
    sock.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      received.push(msg);
      if (msg.type === 'ping' && serverMode === 'echo') {
        sock.send(JSON.stringify({ type: 'pong' }));
      }
    });
  });
  globalThis.location = { protocol: 'http:', host: `127.0.0.1:${server.address().port}` };
});

after(() => {
  server.close();
  for (const c of server.clients) { try { c.terminate(); } catch {} }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openWrapper(createWebSocket) {
  const wrapper = createWebSocket({ id: 'test' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 5000);
    wrapper.onopen = () => { clearTimeout(timer); resolve(); };
  });
  return wrapper;
}

// Close AND wait for the close handshake to finish. Ending a test with the
// handshake still in flight leaves undici's WebSocket holding the event loop
// open forever once the server is torn down — the process never exits.
function closeAndWait(wrapper) {
  const closed = new Promise(r => { wrapper.onclose = r; });
  wrapper.close();
  return closed;
}

test('probe on a healthy socket: pong arrives, no reconnect', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  serverMode = 'echo';
  received = [];
  const wrapper = await openWrapper(createWebSocket);
  wrapper.serverSupportsPing = true;
  let reconnecting = false;
  wrapper.onreconnecting = () => { reconnecting = true; };

  wrapper._onWake();
  await sleep(300);
  assert.deepStrictEqual(received, [{ type: 'ping' }], 'exactly one probe sent');
  assert.strictEqual(wrapper.readyState, WebSocket.OPEN, 'socket still open');

  // The answered probe must not fire again later as a timeout.
  await sleep(5500);
  assert.strictEqual(wrapper.readyState, WebSocket.OPEN);
  assert.strictEqual(reconnecting, false);
  await closeAndWait(wrapper);
});

test('probe never advertised: wake sends nothing', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  serverMode = 'echo';
  received = [];
  const wrapper = await openWrapper(createWebSocket);
  // serverSupportsPing stays false (old server)
  wrapper._onWake();
  await sleep(300);
  assert.deepStrictEqual(received, [], 'no probe sent to a server that never advertised pingPong');
  await closeAndWait(wrapper);
});

test('unanswered probe force-closes and reconnects despite the clean close', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  serverMode = 'silent';
  received = [];
  const wrapper = await openWrapper(createWebSocket);
  wrapper.serverSupportsPing = true;

  const events = [];
  wrapper.onreconnecting = () => events.push('reconnecting');
  wrapper.onreconnected = () => events.push('reconnected');

  const connsBefore = connections;
  wrapper._onWake();

  // Probe timeout is 5s; the retry loop then reconnects within ~1s.
  await sleep(7500);
  assert.deepStrictEqual(events, ['reconnecting', 'reconnected'],
    'probe failure started the reconnect loop and it recovered');
  assert.strictEqual(wrapper.readyState, WebSocket.OPEN, 'wrapper ends on a fresh open socket');
  assert.ok(connections > connsBefore, 'a new connection was made');
  await closeAndWait(wrapper);
});
