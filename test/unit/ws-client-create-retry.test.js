// Headless test of ws-client.js's create-retry URL behavior (#554), run against
// a REAL WebSocket server (`ws` package) — same harness as ws-client-probe.test.js.
//
// The bug: for a new tab the reconnect URL carried new=1 with NO id, so every
// 1s retry after a pre-`session`-message drop asked the server to spawn a fresh
// shell. The fix mints the shell id client-side, making the create idempotent:
// every retry re-requests the SAME shell.
//
// What it proves:
//  - a new-session URL carries new=1 AND a client-minted 8-hex id
//  - a retry after an unclean drop re-sends the SAME id (still new=1)
//  - after setSessionId() the reconnect URL has the id only, no new=1
//  - attach wrappers (id given, no isNew) are untouched: no new=1, id preserved
//
// Run: node --test test/unit/ws-client-create-retry.test.js

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
globalThis.fetch = async () => ({ ok: true, status: 200 }); // /healthz gate: "server up"; auth-heal probe: "auth fine"
// client side: Node's native WebSocket global (browser-compatible)

let server;
let connectionUrls = []; // req.url of every connection, in order
let serverMode = 'accept'; // 'accept' keeps sockets open; 'drop' terminates them on arrival

before(async () => {
  server = new WS.WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => server.on('listening', r));
  server.on('connection', (sock, req) => {
    connectionUrls.push(req.url);
    if (serverMode === 'drop') sock.terminate(); // unclean close → retry loop
  });
  globalThis.location = { protocol: 'http:', host: `127.0.0.1:${server.address().port}` };
});

after(() => {
  server.close();
  for (const c of server.clients) { try { c.terminate(); } catch {} }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Close AND wait for the close handshake to finish (see ws-client-probe.test.js).
// A wrapper mid-retry sits on an already-CLOSED socket — close() then fires no
// onclose event, so waiting for one would hang the test.
function closeAndWait(wrapper) {
  if (wrapper.readyState === WebSocket.CLOSED) { wrapper.close(); return Promise.resolve(); }
  const closed = new Promise(r => { wrapper.onclose = r; });
  wrapper.close();
  return closed;
}

// Settle any in-flight connection attempt from the previous test before
// resetting connectionUrls, so a stale URL can't land in the fresh array.
async function freshUrls() {
  await sleep(100);
  connectionUrls = [];
}

function paramsOf(url) {
  return new URL(url, 'http://x').searchParams;
}

test('new session mints an 8-hex id and retries re-send the SAME id', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  serverMode = 'drop';
  await freshUrls();

  const wrapper = createWebSocket({ isNew: true, cwd: '/tmp' });

  // First connect + at least one 1s retry.
  await sleep(2500);
  assert.ok(connectionUrls.length >= 2, `expected a retry, got ${connectionUrls.length} connection(s)`);

  const first = paramsOf(connectionUrls[0]);
  assert.strictEqual(first.get('new'), '1', 'first connect carries new=1');
  const id = first.get('id');
  assert.match(id, /^[0-9a-f]{8}$/, 'client-minted id is 8 hex chars');

  for (const url of connectionUrls.slice(1)) {
    const p = paramsOf(url);
    assert.strictEqual(p.get('id'), id, 'retry re-sends the SAME id (#554: idempotent create)');
    assert.strictEqual(p.get('new'), '1', 'retry still asks to create-if-missing');
  }

  await closeAndWait(wrapper);
});

test('after setSessionId the reconnect URL has id only, no new=1', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  serverMode = 'accept';
  await freshUrls();

  const wrapper = createWebSocket({ isNew: true, cwd: '/tmp' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 5000);
    wrapper.onopen = () => { clearTimeout(timer); resolve(); };
  });

  const id = paramsOf(connectionUrls[0]).get('id');
  wrapper.setSessionId(id); // what app.js does when the session message arrives

  // Drop the live socket server-side → unclean close → reconnect with new url.
  serverMode = 'drop';
  for (const c of server.clients) c.terminate();
  await sleep(2500);

  assert.ok(connectionUrls.length >= 2, 'reconnected after the drop');
  const p = paramsOf(connectionUrls[connectionUrls.length - 1]);
  assert.strictEqual(p.get('id'), id, 'reconnect requests the confirmed session');
  assert.strictEqual(p.get('new'), null, 'a confirmed session can never create again');

  await closeAndWait(wrapper);
});

test('attach wrapper (no isNew) is untouched: id preserved, no new=1', async () => {
  const { createWebSocket } = await import('../../public/js/ws-client.js');
  serverMode = 'accept';
  await freshUrls();

  const wrapper = createWebSocket({ id: 'abcd1234' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 5000);
    wrapper.onopen = () => { clearTimeout(timer); resolve(); };
  });

  const p = paramsOf(connectionUrls[0]);
  assert.strictEqual(p.get('id'), 'abcd1234');
  assert.strictEqual(p.get('new'), null);

  await closeAndWait(wrapper);
});
