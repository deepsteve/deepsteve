// Unit test for public/js/api.js — the shared JSON-response helper and the
// client-wide auth watch (#676).
//
// The bug this pins: authGate answers with a *text/plain* body ("Unauthorized",
// "Too Many Requests", "Forbidden: Origin not allowed"), and the client parsed
// every response as JSON — so the picker rendered "JSON.parse: unexpected
// character at line 1 column 1" where the reason belonged.
//
// Pattern B from test/unit/project-mods-client.test.js: stub the globals the
// module touches BEFORE importing it, then drive the exported API. window.parent
// = window keeps storage-namespace.js (via auth-heal.js) at depth 0. Each test
// re-imports with a unique ?query so module-level state (watchInstalled, the
// auth-lost status and its subscribers) starts fresh.
//
// Run: node --test test/unit/api-fetch.test.js

const { test } = require('node:test');
const assert = require('node:assert');

globalThis.window = globalThis;
window.parent = window;
const storeMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};
globalThis.location = { origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/', replace() {} };
globalThis.document = { createElement: () => ({ appendChild() {} }), head: { appendChild() {} } };


// A Response-shaped stub. Body is read with .text() — never .json(), which is
// exactly what the module under test must also avoid.
function response(status, body, contentType = 'text/plain; charset=utf-8') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => { throw new Error('.json() must not be called by api.js'); },
  };
}

let seq = 0;
async function load() {
  storeMap.clear();
  // Fresh api.js per test (its watchInstalled flag is module-level state).
  return import(`../../public/js/api.js?t=${++seq}`);
}

// auth-heal.js is imported WITHOUT a query on purpose: api.js's own static
// import has none, and a queried specifier would hand the test a second,
// unrelated module instance whose state api.js never touches. Its state is
// reset through the public API instead.
async function loadHeal() {
  const heal = await import('../../public/js/auth-heal.js');
  heal.noteAuthStatus(200);
  // __deepsteveReloadPending is maybeHealAuth's first-line bail. Setting it puts
  // the module in the state this change is actually about — the reload has been
  // decided on, so what is left is telling the user, which is what onAuthLost
  // drives — and it keeps the heal's own /api/version probe (and its 3s
  // meta-refresh watchdog) from racing the assertions below.
  window.__deepsteveReloadPending = true;
  return heal;
}

test('a 401 text/plain body surfaces the status, not a JSON parse error', async () => {
  const { fetchJSON, HttpError } = await load();
  globalThis.fetch = async () => response(401, 'Unauthorized');
  await assert.rejects(
    () => fetchJSON('/api/settings'),
    (err) => {
      assert.ok(err instanceof HttpError, `expected HttpError, got ${err.name}`);
      assert.strictEqual(err.status, 401);
      assert.match(err.message, /Session expired/);
      assert.doesNotMatch(err.message, /JSON|parse|unexpected/i);
      return true;
    },
  );
});

test('429 and 403 get their own wording; 403 is not described as reload-fixable', async () => {
  const { fetchJSON } = await load();
  globalThis.fetch = async () => response(429, 'Too Many Requests');
  await assert.rejects(() => fetchJSON('/api/issues'), (e) => /reload the page/.test(e.message));
  globalThis.fetch = async () => response(403, 'Forbidden: Origin not allowed');
  await assert.rejects(() => fetchJSON('/api/issues'), (e) => {
    assert.strictEqual(e.status, 403);
    assert.match(e.message, /403/);
    assert.doesNotMatch(e.message, /reload/i);
    return true;
  });
});

test("a JSON error body's {error} wins over the generic status text", async () => {
  const { fetchJSON } = await load();
  globalThis.fetch = async () => response(500, JSON.stringify({ error: 'gh not installed' }), 'application/json');
  await assert.rejects(() => fetchJSON('/api/issues'), (e) => e.message === 'gh not installed');
});

test('a 200 whose body is not JSON throws an HttpError naming the type, not a SyntaxError', async () => {
  const { fetchJSON, HttpError } = await load();
  globalThis.fetch = async () => response(200, '<!doctype html>', 'text/html');
  await assert.rejects(() => fetchJSON('/api/settings'), (e) => {
    assert.ok(e instanceof HttpError);
    assert.match(e.message, /text\/html/);
    return true;
  });
});

test('a well-formed response parses', async () => {
  const { fetchJSON } = await load();
  globalThis.fetch = async () => response(200, JSON.stringify({ issues: [1, 2] }), 'application/json');
  assert.deepStrictEqual(await fetchJSON('/api/issues'), { issues: [1, 2] });
});

// The other half of #676: the verdict client-log.js's realm-fetch wrapper (#675)
// now reports, and which the page banner and the mod panels render.

test('noteAuthStatus fires onAuthLost once per transition, and clears on a success', async () => {
  const heal = await loadHeal();
  const seen = [];
  heal.onAuthLost((s) => seen.push(s));

  // A 401 storm is hundreds of responses and must be one transition, not
  // hundreds of banner renders.
  heal.noteAuthStatus(401);
  heal.noteAuthStatus(401);
  heal.noteAuthStatus(401);
  assert.deepStrictEqual(seen, [401]);
  assert.strictEqual(heal.isAuthLost(), 401);

  heal.noteAuthStatus(200);
  assert.deepStrictEqual(seen, [401, 0]);
  assert.strictEqual(heal.isAuthLost(), 0);
});

test('a 403 is recorded but never healed; a 5xx says nothing about the cookie', async () => {
  const heal = await loadHeal();
  heal.noteAuthStatus(403);
  assert.strictEqual(heal.isAuthLost(), 403);

  heal.noteAuthStatus(200);
  heal.noteAuthStatus(500);
  assert.strictEqual(heal.isAuthLost(), 0, 'a server error is not an auth verdict');
  heal.noteAuthStatus(404);
  assert.strictEqual(heal.isAuthLost(), 0);
});

test("client-log's realm wrapper reports the status, and skips /api/proxy", async () => {
  const heal = await loadHeal();
  const log = await import('../../public/js/client-log.js');
  let status = 401;
  const realm = { fetch: async () => response(status, 'Unauthorized') };
  log.wrapRealmFetch(realm, 'shell');

  // /api/proxy passes an UPSTREAM status through: a remote site the Baby Browser
  // is showing can answer 401, and that says nothing about our own cookie.
  await realm.fetch('/api/proxy?url=https://example.com');
  assert.strictEqual(heal.isAuthLost(), 0);

  await realm.fetch('/api/settings');
  assert.strictEqual(heal.isAuthLost(), 401);

  status = 200;
  await realm.fetch('/api/settings');
  assert.strictEqual(heal.isAuthLost(), 0);
});
