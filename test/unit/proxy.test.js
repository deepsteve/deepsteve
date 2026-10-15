// /api/proxy puts remote pages in an opaque origin (#731).
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
// Run: node --test test/unit/proxy.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { PROXY_CSP, FORWARDED_HEADERS, BRIDGE_TAG, injectIntoHtml, createProxy } = require('../../proxy.js');

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

let upstream, app, U, P;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/page') {
      for (const [k, v] of Object.entries(HOSTILE)) res.setHeader(k, v);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-language', 'en');
      res.setHeader('cache-control', 'max-age=60');
      res.setHeader('etag', PAGE_ETAG);
      res.setHeader('last-modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
      return res.end(PAGE);
    }
    if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', '/page');
      return res.end();
    }
    if (req.url === '/sw.js') {
      res.setHeader('content-type', 'application/javascript');
      res.setHeader('service-worker-allowed', '/');
      res.setHeader('set-cookie', 'ds_auth_3000=clobbered; Path=/');
      res.setHeader('etag', '"sw-etag"');
      return res.end("self.addEventListener('fetch', () => {});");
    }
    res.statusCode = 404;
    res.end('nope');
  });
  U = `http://127.0.0.1:${await listen(upstream)}`;
  const ex = express();
  ex.get('/api/proxy', createProxy());
  app = http.createServer(ex);
  P = `http://127.0.0.1:${await listen(app)}/api/proxy`;
});

after(() => {
  upstream.close();
  app.close();
});

const proxied = (url) => fetch(`${P}?url=${encodeURIComponent(url)}`);

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

test('error responses are sandboxed too', async () => {
  const missing = await fetch(P);
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.headers.get('content-security-policy'), PROXY_CSP);
  const invalid = await proxied('not a url');
  assert.strictEqual(invalid.status, 400);
  assert.strictEqual(invalid.headers.get('content-security-policy'), PROXY_CSP);
  const unreachable = await proxied('http://127.0.0.1:1/');
  assert.strictEqual(unreachable.status, 502);
  assert.strictEqual(unreachable.headers.get('content-security-policy'), PROXY_CSP);
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
  // The first navigate() calls registerWithServer(), which reads tabInstanceId: declared later, it
  // threw at load, so initBridge() never ran and no baby_browser_* tool could reach the tab.
  assert.ok(page.indexOf('let tabInstanceId') < page.indexOf('\n    navigate(false);\n'));
});
