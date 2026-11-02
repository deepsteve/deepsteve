// /api/proxy puts remote pages in an opaque origin (#731), and bounds what it fetches (#746).
//
// Before #731 a page loaded through the proxy ran with Deep Steve's full authority: it was served
// from our origin, Baby Browser framed it with allow-same-origin, and every upstream header but
// six was forwarded. Reproduced in headless Chrome against an isolated daemon, such a page:
// fetched /api/version and initialized /mcp with the user's cookie, read window.top.document and
// localStorage, registered a service worker at scope `/`, and overwrote ds_auth_<port> with an
// upstream Set-Cookie. The same page opened top-level did all of it too.
//
// What closes it is a property of the RESPONSE (a `sandbox` CSP without allow-same-origin, and an
// allowlist of upstream headers), so that is what this pins: a real upstream, a real Express app,
// real fetch. The browser half — that the CSP really yields `Origin: null`, no Strict cookie and a
// throwing localStorage — needs a browser, and was verified with the /verify skill.
//
// #731 left the page able to pick what the daemon FETCHES: its bridge `navigate` names any URL.
// #746 adds a destination policy (a bare request reaches public addresses only, `by=user` reaches
// anything, and no redirect steps from a public address back inward), checked on the address
// actually dialed, plus a deadline and a byte cap. A "public" upstream is needed to test the
// redirect rule without the internet, so one app classifies ::1 as public and nothing else.
//
// Run: node --test test/unit/proxy.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const { PROXY_CSP, FORWARDED_HEADERS, BRIDGE_TAG, injectIntoHtml, createProxy } = require('../../proxy.js');
const { NODE_ADVISORIES } = require('../../node-advisories.js');
const { classifyAddress } = require('../../proxy-address.js');

// Every header a hostile upstream might use against our origin, each with a value we can spot.
const HOSTILE = {
  'set-cookie': 'ds_auth_3000=clobbered; Path=/; HttpOnly; SameSite=Strict',
  'clear-site-data': '"storage", "cookies"',
  'service-worker-allowed': '/',
  refresh: '0; url=https://evil.example/',
  link: '<https://evil.example/sw.js>; rel=serviceworker',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'access-control-allow-origin': '*',
  'strict-transport-security': 'max-age=31536000',
  'content-disposition': 'attachment',
  'x-upstream-marker': 'leaked',
};
const PAGE_ETAG = '"upstream-page-etag"';
const PAGE = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'">'
  + '<title>Remote</title></head><body><a href="/next">next</a><form action="/search"><input name="q"></form></body></html>';
const CAP = 1024 * 1024; // the capped app's byte cap
const DEADLINE_MS = 500; // the capped app's deadline

const PATCHED_NODE = '22.23.4';
const AFFECTED_NODE = '22.14.0';

let upstream, publicStandIn, canary, app;
let U; // upstream, 127.0.0.1
let S; // the "public" stand-in, [::1]
let C; // canary port on 127.0.0.1: any connection to it means a refusal came too late
let A; // proxy app origin
let canaryConnections = 0;
const upstreamClosed = new Map(); // path -> resolve, for streams the proxy must hang up on

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function closedWhen(urlPath) {
  return new Promise((resolve) => upstreamClosed.set(urlPath, resolve));
}

function redirector(req, res) {
  const target = new URL(req.url, 'http://x').searchParams.get('u');
  res.statusCode = 302;
  res.setHeader('location', target);
  res.end();
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    req.socket.on('close', () => upstreamClosed.get(p)?.());
    if (p === '/page') {
      for (const [k, v] of Object.entries(HOSTILE)) res.setHeader(k, v);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-language', 'en');
      res.setHeader('cache-control', 'max-age=60');
      res.setHeader('etag', PAGE_ETAG);
      res.setHeader('last-modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
      return res.end(PAGE);
    }
    if (p === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/page');
      return res.end();
    }
    if (p === '/to') return redirector(req, res);
    if (p === '/loop') {
      res.statusCode = 302;
      res.setHeader('location', '/loop');
      return res.end();
    }
    if (p === '/sw.js') {
      res.setHeader('content-type', 'application/javascript');
      res.setHeader('service-worker-allowed', '/');
      res.setHeader('set-cookie', 'ds_auth_3000=clobbered; Path=/');
      res.setHeader('etag', '"sw-etag"');
      return res.end("self.addEventListener('fetch', () => {});");
    }
    if (p === '/gzip-page') {
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-encoding', 'gzip');
      return res.end(zlib.gzipSync(PAGE));
    }
    if (p === '/br-json') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'br');
      return res.end(zlib.brotliCompressSync('{"ok":true}'));
    }
    if (p === '/forever-fast') {
      // As fast as we are read, never ending: only the byte cap stops it.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = () => { while (res.write(chunk)); };
      res.on('drain', pump);
      return pump();
    }
    if (p === '/forever-slow') {
      // A byte at a time, never ending: only the deadline stops it.
      const t = setInterval(() => res.write('.'), 20);
      return res.on('close', () => clearInterval(t));
    }
    if (p === '/big') {
      res.setHeader('content-length', String(CAP * 2));
      return res.end(Buffer.alloc(CAP * 2));
    }
    if (p === '/bomb') {
      res.setHeader('content-encoding', 'gzip');
      return res.end(zlib.gzipSync(Buffer.alloc(CAP * 8)));
    }
    res.statusCode = 404;
    res.end('nope');
  });
  U = `http://127.0.0.1:${await listen(upstream, '127.0.0.1')}`;

  publicStandIn = http.createServer((req, res) => {
    if (req.url.startsWith('/to')) return redirector(req, res);
    res.setHeader('content-type', 'text/plain');
    res.end('public stand-in');
  });
  // ::1 must exist for the redirect tests; it does on macOS and on the CI unit runner.
  S = `http://[::1]:${await listen(publicStandIn, '::1')}`;

  canary = http.createServer((req, res) => res.end('canary'));
  canary.on('connection', () => { canaryConnections++; });
  C = await listen(canary, '127.0.0.1');

  const asPublic = (address) => (address === '::1' ? 'public' : classifyAddress(address));
  const ex = express();
  // Pinned to a patched Node, so the suite behaves the same whichever Node runs it: the refusal
  // on an affected one (#745) is tested on its own below, with injected versions.
  const nodeVersion = PATCHED_NODE;
  ex.get('/api/proxy', createProxy({ nodeVersion }));
  ex.get('/capped', createProxy({ nodeVersion, timeoutMs: DEADLINE_MS, maxBytes: CAP }));
  ex.get('/as-public', createProxy({ nodeVersion, classify: asPublic }));
  // A resolver that answers whatever a hostile DNS server would: the check must follow it.
  ex.get('/hostile-dns', createProxy({
    nodeVersion,
    lookup: (hostname, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
  }));
  app = http.createServer(ex);
  A = `http://127.0.0.1:${await listen(app, '127.0.0.1')}`;
});

after(() => {
  upstream.closeAllConnections();
  upstream.close();
  publicStandIn.close();
  canary.close();
  app.closeAllConnections();
  app.close();
});

// `by=user` is what Baby Browser sends for a URL the user typed or an agent sent; the upstreams
// here are on loopback, so the #731 tests go through it.
const proxied = (url, { route = '/api/proxy', byUser = true, ...init } = {}) =>
  fetch(`${A}${route}?url=${encodeURIComponent(url)}${byUser ? '&by=user' : ''}`, init);

test('the CSP is a sandbox without allow-same-origin, and the header allowlist is exactly this', () => {
  assert.strictEqual(PROXY_CSP, 'sandbox allow-scripts allow-forms allow-popups');
  assert.ok(!PROXY_CSP.includes('allow-same-origin'));
  // Widening this list is a security decision: every entry is a header a remote site gets to set
  // on OUR origin. Never set-cookie, clear-site-data, service-worker-allowed, refresh or link.
  assert.deepStrictEqual([...FORWARDED_HEADERS], ['content-type', 'content-language', 'cache-control', 'etag', 'last-modified']);
});

test('an HTML page is sandboxed, keeps only allowlisted headers, and drops validators it no longer matches', async () => {
  const res = await proxied(`${U}/page`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-security-policy'), PROXY_CSP);
  for (const name of Object.keys(HOSTILE)) {
    if (name === 'content-security-policy') continue;
    assert.strictEqual(res.headers.get(name), null, `${name} must not be forwarded`);
  }
  assert.strictEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.strictEqual(res.headers.get('content-language'), 'en');
  assert.strictEqual(res.headers.get('cache-control'), 'max-age=60');
  // The body was rewritten, so the upstream validators describe bytes we are not sending.
  assert.notStrictEqual(res.headers.get('etag'), PAGE_ETAG);
  assert.strictEqual(res.headers.get('last-modified'), null);
  await res.arrayBuffer();
});

test('the bridge is injected first in <head>, ahead of the page\'s own CSP, and links are not rewritten', async () => {
  const html = await (await proxied(`${U}/redirect`)).text();
  const head = html.indexOf('<head>');
  const base = html.indexOf(`<base href="${U}/">`);
  const bridge = html.indexOf('<script>');
  assert.strictEqual(base, head + '<head>'.length, '<base> comes right after <head>');
  assert.ok(bridge > base && bridge < html.indexOf('<meta http-equiv'), 'bridge runs before a <meta> CSP can block it');
  assert.ok(html.includes(JSON.stringify(BRIDGE_TAG)));
  // The final URL after redirects, which the bridge uses for a form with no action.
  assert.ok(html.includes(JSON.stringify(`${U}/page`)));
  // A rewritten /api/proxy link resolved against <base> to the REMOTE origin and never reached us.
  assert.ok(!html.includes('/api/proxy'));
  assert.ok(html.includes('<a href="/next">'));
  assert.ok(html.includes('<form action="/search">'));
});

test('a non-HTML response is sandboxed, passes through untouched, and keeps its validator', async () => {
  const res = await proxied(`${U}/sw.js`);
  assert.strictEqual(res.headers.get('content-security-policy'), PROXY_CSP);
  assert.strictEqual(res.headers.get('service-worker-allowed'), null);
  assert.strictEqual(res.headers.get('set-cookie'), null);
  assert.strictEqual(res.headers.get('content-type'), 'application/javascript');
  assert.strictEqual(res.headers.get('etag'), '"sw-etag"');
  assert.strictEqual(await res.text(), "self.addEventListener('fetch', () => {});");
});

test('compressed bodies are decoded before the bridge goes in, and not re-labelled as compressed', async () => {
  const html = await (await proxied(`${U}/gzip-page`)).text();
  assert.ok(html.includes(JSON.stringify(BRIDGE_TAG)));
  assert.ok(html.includes('<title>Remote</title>'));
  const json = await proxied(`${U}/br-json`);
  assert.strictEqual(json.headers.get('content-encoding'), null);
  assert.deepStrictEqual(await json.json(), { ok: true });
});

test('error responses are sandboxed too', async () => {
  const missing = await fetch(`${A}/api/proxy`);
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.headers.get('content-security-policy'), PROXY_CSP);
  const invalid = await proxied('not a url');
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual(invalid.headers.get('content-security-policy'), PROXY_CSP);
  const closed = http.createServer();
  const closedPort = await listen(closed, '127.0.0.1');
  closed.close();
  const unreachable = await proxied(`http://127.0.0.1:${closedPort}/`);
  assert.strictEqual(unreachable.status, 502);
  assert.strictEqual(unreachable.headers.get('content-security-policy'), PROXY_CSP);
  const refused = await proxied(`${U}/page`, { byUser: false });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.headers.get('content-security-policy'), PROXY_CSP);
});

// ─── #746: who chose the URL decides where it may go ─────────────────────────────────────────

test('a URL nobody vouched for may not reach a non-public address, and no connection is made', async () => {
  const before_ = canaryConnections;
  const cases = [
    [`http://127.0.0.1:${C}/`, '127.0.0.1', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', '169.254.169.254', 'link-local'],
    [`http://[::ffff:127.0.0.1]:${C}/`, '::ffff:7f00:1', 'loopback'],
    [`http://[64:ff9b::7f00:1]:${C}/`, '64:ff9b::7f00:1', 'loopback'],
    [`http://[64:ff9b:1::808:808]:${C}/`, '64:ff9b:1::808:808', 'nat64-local'],
    [`http://0.0.0.0:${C}/`, '0.0.0.0', 'unspecified'],
    [`http://[::]:${C}/`, '::', 'unspecified'],
    ['http://10.0.0.1/', '10.0.0.1', 'private'],
    ['http://100.64.0.1/', '100.64.0.1', 'shared'],
    ['http://[fd00::1]/', 'fd00::1', 'unique-local'],
    // Spellings the URL parser canonicalizes to loopback before we ever see a hostname.
    [`http://0177.0.0.1:${C}/`, '127.0.0.1', 'loopback'],
    [`http://2130706433:${C}/`, '127.0.0.1', 'loopback'],
    [`http://0x7f.1:${C}/`, '127.0.0.1', 'loopback'],
    // Host confusion: userinfo that looks like a host, and a backslash read as a path separator.
    [`http://public.example@127.0.0.1:${C}/`, '127.0.0.1', 'loopback'],
    [`http://127.0.0.1:${C}\\@public.example/`, '127.0.0.1', 'loopback'],
    // A name: vetted on what it resolves to.
    [`http://localhost:${C}/`, null, null],
  ];
  for (const [url, address, cls] of cases) {
    const res = await proxied(url, { byUser: false });
    const body = await res.json();
    assert.strictEqual(res.status, 403, `${url}: ${JSON.stringify(body)}`);
    assert.strictEqual(res.headers.get('content-security-policy'), PROXY_CSP);
    if (address) assert.strictEqual(body.refused.address, address, url);
    if (cls) assert.strictEqual(body.refused.class, cls, url);
    assert.notStrictEqual(classifyAddress(body.refused.address), 'public', url);
    assert.match(body.error, /address bar/);
  }
  assert.strictEqual(canaryConnections, before_, 'a refused URL never opened a connection');
});

test('the check follows the address a name resolves to, not the name', async () => {
  const before_ = canaryConnections;
  const res = await proxied(`http://rebound.example:${C}/`, { route: '/hostile-dns', byUser: false });
  const body = await res.json();
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(body.refused, { url: `http://rebound.example:${C}/`, address: '127.0.0.1', class: 'loopback' });
  assert.strictEqual(canaryConnections, before_);
});

test('by=user reaches local addresses, and redirects between them (Baby Browser on a dev server)', async () => {
  for (const url of [`${U}/page`, `${U}/redirect`, `${U.replace('127.0.0.1', 'localhost')}/page`]) {
    const res = await proxied(url);
    assert.strictEqual(res.status, 200, url);
    await res.arrayBuffer();
  }
  const bare = await proxied(`${U}/page`, { byUser: false });
  assert.strictEqual(bare.status, 403);
  // Only the exact value widens: anything else, including a repeated parameter, is a bare request.
  const repeated = await fetch(`${A}/api/proxy?url=${encodeURIComponent(`${U}/page`)}&by=user&by=user`);
  assert.strictEqual(repeated.status, 403);
});

test('a public address that redirects inward is refused at that hop, whoever chose the first URL', async () => {
  // The stand-in itself is reachable without by=user: the classifier calls it public.
  const direct = await proxied(`${S}/`, { route: '/as-public', byUser: false });
  assert.strictEqual(direct.status, 200);
  assert.strictEqual(await direct.text(), 'public stand-in');

  const before_ = canaryConnections;
  const inward = [
    [`http://127.0.0.1:${C}/`, '127.0.0.1'],
    ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
    [`http://[::ffff:127.0.0.1]:${C}/`, '::ffff:7f00:1'],
    [`http://[64:ff9b::7f00:1]:${C}/`, '64:ff9b::7f00:1'],
  ];
  for (const byUser of [false, true]) {
    for (const [target, address] of inward) {
      const res = await proxied(`${S}/to?u=${encodeURIComponent(target)}`, { route: '/as-public', byUser });
      const body = await res.json();
      assert.strictEqual(res.status, 403, `by=user ${byUser}, ${target}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.refused.address, address);
      assert.match(body.error, /redirect from a public address/);
    }
  }
  assert.strictEqual(canaryConnections, before_, 'no inward hop opened a connection');

  // And once by=user has gone public, it has spent its local reach: local → public → local fails.
  const roundTrip = `${U}/to?u=${encodeURIComponent(`${S}/to?u=${encodeURIComponent(`${U}/page`)}`)}`;
  const res = await proxied(roundTrip, { route: '/as-public' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).refused.address, '127.0.0.1');
});

test('bad ports, non-http schemes and redirect loops are refused', async () => {
  const smtp = await proxied('http://127.0.0.1:25/');
  assert.strictEqual(smtp.status, 403);
  assert.match((await smtp.json()).error, /port 25 is blocked/);
  for (const url of ['data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://127.0.0.1/']) {
    const res = await proxied(url);
    assert.strictEqual(res.status, 400, url);
    await res.arrayBuffer();
  }
  const loop = await proxied(`${U}/loop`);
  assert.strictEqual(loop.status, 502);
  assert.strictEqual((await loop.json()).limit, 'redirects');
});

// ─── #746: size and time caps ────────────────────────────────────────────────────────────────

test('an upstream that streams forever hits the byte cap: a bounded 502, and we hang up', async () => {
  const hungUp = closedWhen('/forever-fast');
  const t0 = Date.now();
  const res = await proxied(`${U}/forever-fast`, { route: '/capped' });
  const body = await res.json();
  assert.strictEqual(res.status, 502);
  assert.strictEqual(body.limit, 'size');
  assert.match(body.error, /exceeded the 1 MiB limit/);
  assert.ok(Date.now() - t0 < DEADLINE_MS, 'the cap, not the deadline, ended it');
  await hungUp;
});

test('an upstream that trickles forever hits the deadline: a bounded 502, and we hang up', async () => {
  const hungUp = closedWhen('/forever-slow');
  const t0 = Date.now();
  const res = await proxied(`${U}/forever-slow`, { route: '/capped' });
  const body = await res.json();
  const elapsed = Date.now() - t0;
  assert.strictEqual(res.status, 502);
  assert.strictEqual(body.limit, 'time');
  assert.match(body.error, /did not finish within 0.5s/);
  assert.ok(elapsed >= DEADLINE_MS && elapsed < DEADLINE_MS + 1500, `${elapsed}ms`);
  await hungUp;
});

test('an oversized Content-Length and a gzip bomb are refused against the decoded size', async () => {
  for (const p of ['/big', '/bomb']) {
    const res = await proxied(`${U}${p}`, { route: '/capped' });
    assert.strictEqual(res.status, 502, p);
    assert.strictEqual((await res.json()).limit, 'size', p);
  }
});

test('the browser going away aborts the upstream fetch', async () => {
  const hungUp = closedWhen('/forever-slow');
  const ac = new AbortController();
  const pending = proxied(`${U}/forever-slow`, { signal: ac.signal }).catch(() => {});
  setTimeout(() => ac.abort(), 200);
  await pending;
  const t0 = Date.now();
  await hungUp;
  assert.ok(Date.now() - t0 < 2000, 'upstream closed promptly, long before the 30s deadline');
});

test('injectIntoHtml: <header> is not <head>, and a hostile URL cannot close the bridge script', () => {
  const noHead = injectIntoHtml('<html><body><header>x</header></body></html>', 'https://a.example/');
  assert.ok(noHead.startsWith('<html><head><base href="https://a.example/">'));
  assert.ok(noHead.includes('<header>x</header>'));
  assert.ok(injectIntoHtml('<p>bare</p>', 'https://a.example/').startsWith('<base href="https://a.example/">'));
  const evil = injectIntoHtml('<head></head>', 'https://a.example/?q=</script><script>alert(1)</script>');
  assert.strictEqual(evil.split('</script>').length - 1, 1, 'only the bridge\'s own closing tag');
});

test('Baby Browser frames the proxy without allow-same-origin and listens for the same tag', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'mods', 'baby-browser', 'index.html'), 'utf8');
  const sandbox = /<iframe id="browser" sandbox="([^"]*)"/.exec(page);
  assert.ok(sandbox, 'the browser iframe carries a sandbox attribute');
  assert.ok(!sandbox[1].includes('allow-same-origin'), sandbox[1]);
  assert.ok(sandbox[1].includes('allow-scripts'));
  assert.ok(page.includes(`const PROXY_TAG = '${BRIDGE_TAG}';`));
  // The first replay() calls registerWithServer(), which reads tabInstanceId: declared later, it
  // threw at load, so initBridge() never ran and no baby_browser_* tool could reach the tab.
  assert.ok(page.indexOf('let tabInstanceId') < page.indexOf('\n    replay();\n'));
  assert.ok(page.indexOf('\n    replay();\n') > 0);
});

// #745: while the daemon's Node has a hole that remote bytes can reach, nothing is fetched.
//
// "Fetched" is observed at the resolver: the upstream is addressed by name, so every connection
// the proxy makes starts with a lookup, and a spy there counts them. The requests carry by=user
// so the #746 destination policy, which would refuse loopback first, is not what answers.
const UPSTREAM_BY_NAME = () => U.replace('127.0.0.1', 'upstream.test');
const askProxy = (base, url, init) => fetch(`${base}?url=${encodeURIComponent(url)}&by=user`, init);

async function refusingProxy(nodeVersion, advisories) {
  const calls = [];
  const lookup = (hostname, options, cb) => { calls.push(hostname); cb(null, [{ address: '127.0.0.1', family: 4 }]); };
  const ex = express();
  ex.get('/api/proxy', createProxy({ nodeVersion, lookup, ...(advisories ? { advisories } : {}) }));
  const server = http.createServer(ex);
  const base = `http://127.0.0.1:${await listen(server, '127.0.0.1')}/api/proxy`;
  return { calls, base, close: () => server.close() };
}

test('on an affected Node the proxy refuses with 503 and never fetches', async () => {
  const p = await refusingProxy(AFFECTED_NODE);
  try {
    const target = `${UPSTREAM_BY_NAME()}/page`;
    // A display tab's fetch(): JSON naming the CVE and the upgrade target.
    const json = await askProxy(p.base, target);
    assert.strictEqual(json.status, 503);
    assert.strictEqual(json.headers.get('content-security-policy'), PROXY_CSP);
    const body = await json.json();
    assert.match(body.error, /CVE-2026-111497/);
    assert.match(body.error, /Node\.js 22\.14\.0 is affected/);
    assert.match(body.error, /Upgrade to Node\.js 22\.23\.4 or later/);
    assert.deepStrictEqual(body.advisories.map(a => a.upgradeTo), [['22.23.4']]);

    // Baby Browser's iframe navigation: a page that says why, with the bridge so
    // baby_browser_read can hand the explanation to an agent.
    const page = await askProxy(p.base, target, { headers: { accept: 'text/html,*/*' } });
    assert.strictEqual(page.status, 503);
    assert.strictEqual(page.headers.get('content-security-policy'), PROXY_CSP);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const html = await page.text();
    assert.ok(html.includes('CVE-2026-111497'));
    assert.ok(html.includes('Upgrade to Node.js 22.23.4 or later'));
    assert.ok(html.includes(JSON.stringify(BRIDGE_TAG)), 'carries the bridge');
    assert.ok(!html.includes('Remote'), 'the upstream page was not fetched');

    // No url, or a bad one, is refused the same way: no path below the check runs.
    assert.strictEqual((await fetch(p.base)).status, 503);
    assert.strictEqual((await fetch(`${p.base}?url=not%20a%20url`)).status, 503);

    assert.strictEqual(p.calls.length, 0, 'no upstream connection may start on an affected Node');
  } finally {
    p.close();
  }
});

test('an end-of-life Node is refused too, and told which lines to move to', async () => {
  const p = await refusingProxy('20.20.2');
  try {
    const body = await (await askProxy(p.base, `${UPSTREAM_BY_NAME()}/page`)).json();
    assert.match(body.error, /Node\.js 20\.x is end-of-life/);
    assert.deepStrictEqual(body.advisories[0].upgradeTo, ['22.23.4', '24.22.1', '26.12.1']);
    assert.strictEqual(p.calls.length, 0);
  } finally {
    p.close();
  }
});

test('on a patched Node the proxy fetches exactly as before', async () => {
  for (const nodeVersion of [PATCHED_NODE, '24.22.1', '26.12.1', '27.0.0']) {
    const p = await refusingProxy(nodeVersion);
    try {
      const res = await askProxy(p.base, `${UPSTREAM_BY_NAME()}/page`, { headers: { accept: 'text/html' } });
      assert.strictEqual(res.status, 200, nodeVersion);
      assert.ok((await res.text()).includes('<title>Remote</title>'), nodeVersion);
      assert.strictEqual(p.calls.length, 1, nodeVersion);
    } finally {
      p.close();
    }
  }
});

test('an advisory without blocksProxy does not switch the proxy off', async () => {
  // A future CVE the proxy cannot reach must cost the user nothing.
  const unreachable = NODE_ADVISORIES.map(({ blocksProxy, ...rest }) => rest);
  const p = await refusingProxy(AFFECTED_NODE, unreachable);
  try {
    const res = await askProxy(p.base, `${UPSTREAM_BY_NAME()}/page`);
    assert.strictEqual(res.status, 200);
    await res.arrayBuffer();
    assert.strictEqual(p.calls.length, 1);
  } finally {
    p.close();
  }
});
