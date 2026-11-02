// Who chose a Baby Browser navigation, which decides what /api/proxy lets it reach (#746).
//
// 'user' means the user or an agent picked the URL: the address bar, Go, baby_browser_navigate.
// It is sent as `&by=user` and may reach any address, local dev servers included. 'page' means
// the framed page picked it, with a link, a form, or a `navigate` message it wrote itself. That
// is sent bare and reaches public addresses only.
//
// One exception keeps a local dev server's own links working: a page navigation that stays on
// the origin of a 'user' page inherits 'user', when that origin's host is one whose address a
// remote DNS server cannot change. A public hostname the user typed does not pass its trust on,
// because that is DNS rebinding: evil.example answers with a public address for the page, then
// 127.0.0.1 for the page's own same-origin link.
//
// A classic script, not a module: index.html loads it with <script src>, and
// test/unit/baby-browser-nav-trust.test.js requires it.
(function (root) {
  'use strict';

  // Names public DNS does not answer for: RFC 6761/6762/8375 special-use names, and the TLD
  // ICANN reserved for private use.
  const LOCAL_SUFFIXES = ['.localhost', '.local', '.test', '.internal', '.home.arpa'];

  function hostCannotRebind(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return false;
    if (h.startsWith('[')) return true; // an IPv6 literal is its own address
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // so is IPv4; the URL parser canonicalized it
    if (!h.includes('.')) return true; // localhost, or a single label: /etc/hosts or the LAN's resolver
    return LOCAL_SUFFIXES.some((s) => h.endsWith(s));
  }

  // `current` is the history entry the page is showing ({ url, by }); `nextUrl` is what it asked for.
  function pageNavigationBy(current, nextUrl) {
    if (!current || current.by !== 'user') return 'page';
    let from, to;
    try {
      from = new URL(current.url);
      to = new URL(nextUrl);
    } catch {
      return 'page';
    }
    return from.origin === to.origin && hostCannotRebind(from.hostname) ? 'user' : 'page';
  }

  const api = { hostCannotRebind, pageNavigationBy };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BabyBrowserNavTrust = api;
})(typeof window !== 'undefined' ? window : globalThis);
