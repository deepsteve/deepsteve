// Who chose a Baby Browser navigation (#746): mods/baby-browser/nav-trust.js.
//
// A 'user' entry is fetched with /api/proxy's `by=user` and may reach local addresses; a 'page'
// entry reaches public ones only. A page's own `navigate` is 'page', except a same-origin link on
// a 'user' page whose host DNS cannot rebind, which is what keeps a dev server's links working.
// The server half (what by=user permits) is pinned in proxy.test.js; this is the parent's half.
//
// Run: node --test test/unit/baby-browser-nav-trust.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { hostCannotRebind, pageNavigationBy } = require('../../mods/baby-browser/nav-trust.js');

const user = (url) => ({ url, by: 'user' });
const page = (url) => ({ url, by: 'page' });

test('a dev server the user opened keeps its own links local', () => {
  for (const origin of [
    'http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'http://192.168.1.20:3000',
    'http://app.localhost:3000', 'http://printer.local', 'https://myapp.test', 'http://svc.internal',
    'http://nas.home.arpa', 'http://devbox:8000',
  ]) {
    assert.strictEqual(pageNavigationBy(user(`${origin}/`), `${origin}/about?x=1`), 'user', origin);
  }
});

test('everything else a page asks for is the page\'s choice', () => {
  const cases = [
    // A public page linking anywhere, including at the user's machine or the metadata service.
    [user('https://example.com/'), 'http://127.0.0.1:5173/'],
    [user('https://example.com/'), 'http://169.254.169.254/latest/meta-data/'],
    // A public HOSTNAME the user typed does not lend its trust even same-origin: that is DNS
    // rebinding, the name answering 127.0.0.1 for the link.
    [user('https://evil.example/'), 'https://evil.example/next'],
    [user('http://127.0.0.1.nip.io:3000/'), 'http://127.0.0.1.nip.io:3000/x'],
    // A local page linking to a different origin, even another local one.
    [user('http://localhost:5173/'), 'http://localhost:5174/'],
    [user('http://localhost:5173/'), 'https://localhost:5173/'],
    [user('http://localhost:5173/'), 'http://127.0.0.1:5173/'],
    [user('http://localhost:5173/'), 'http://192.168.1.1/'],
    // Trust is never inherited from a page entry, so a chain of page links cannot climb.
    [page('http://localhost:5173/'), 'http://localhost:5173/about'],
    [page('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/'],
    // Garbage in, the strict answer out.
    [null, 'http://localhost:5173/'],
    [user('not a url'), 'http://localhost:5173/'],
    [user('http://localhost:5173/'), 'not a url'],
    [{ url: 'http://localhost:5173/', by: 'USER' }, 'http://localhost:5173/x'],
  ];
  for (const [current, next] of cases) {
    assert.strictEqual(pageNavigationBy(current, next), 'page', `${JSON.stringify(current)} -> ${next}`);
  }
});

test('hostCannotRebind: IP literals and names public DNS does not serve', () => {
  for (const h of ['127.0.0.1', '93.184.215.14', '[::1]', '[2606:4700::1]', 'localhost', 'LOCALHOST', 'a.localhost', 'x.local', 'x.test', 'x.internal', 'x.home.arpa', 'intranet', 'local']) {
    assert.strictEqual(hostCannotRebind(h), true, h);
  }
  for (const h of ['example.com', 'localhost.example.com', 'evil.test.example.com', 'x.localhost.', 'x.lan', '', null, undefined]) {
    assert.strictEqual(hostCannotRebind(h), false, String(h));
  }
});

test('index.html sends by=user only for a user entry, and runs every page navigate through the rule and the rate limit', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'mods', 'baby-browser', 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="nav-trust.js"></script>'));
  assert.ok(html.includes("(entry.by === 'user' ? '&by=user' : '')"));
  const handler = html.slice(html.indexOf("if (m.kind === 'navigate'"), html.indexOf("} else if (m.kind === 'read-result'"));
  assert.ok(handler.includes('takePageNavToken()'), 'a page navigate is rate limited');
  assert.ok(handler.includes('BabyBrowserNavTrust.pageNavigationBy(navHistory[historyIndex], m.url)'));
  assert.ok(!/openUrl\([^)]*'user'\)/.test(handler), 'a page navigate is never tagged user directly');
  // The address bar and an agent's baby_browser_navigate are the user's choice.
  assert.ok(html.includes("openUrl(urlInput.value, 'user')"));
  assert.ok(html.includes("openUrl(req.url, 'user')"));
});
