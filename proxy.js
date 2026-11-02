/**
 * /api/proxy: fetch a page from the internet so Baby Browser can frame it (#731).
 *
 * The page is served from OUR origin, with the upstream X-Frame-Options and CSP gone — that is
 * the whole point of the proxy. It is also what made every script on it (the site's own, and
 * every ad, analytics and CDN script it pulls in) as powerful as Deep Steve's UI: same-origin
 * requests carry the SameSite=Strict cookie past authGate, `window.top` is the app, and
 * `allow-scripts allow-same-origin` lets a frame lift its own sandbox. Three rules close that:
 *
 *   1. Every response carries PROXY_CSP, a `sandbox` without `allow-same-origin`. The document
 *      lands in an opaque origin however it is loaded — Baby Browser's iframe, or top-level via
 *      open_browser_tab. Its requests to us send `Origin: null` and no Strict cookie, and it
 *      cannot reach `top`, our storage or service workers. A fetch() of a proxied JSON API from
 *      a display tab is unaffected: a CSP header governs documents, not fetch responses.
 *   2. Upstream headers pass through FORWARDED_HEADERS, an allowlist. A denylist forwarded
 *      Set-Cookie (which overwrote our auth cookie), Clear-Site-Data and Service-Worker-Allowed.
 *   3. Baby Browser cannot read an opaque frame's DOM, so HTML gets a small bridge script that
 *      answers `read` and routes link clicks and GET form submits to the parent over
 *      postMessage. The page controls that text anyway, so a forged message can only lie about
 *      the page itself.
 *
 * Links are no longer rewritten to /api/proxy server-side: the injected <base> resolves a
 * root-relative `/api/proxy?url=…` against the REMOTE origin, so a rewritten link never reached
 * us. The bridge sends the link's real URL to the parent, which navigates the frame.
 *
 * This is also the one route that feeds arbitrary internet bytes to Node itself. While the
 * running Node has a hole those bytes can reach (an advisory marked `blocksProxy` in
 * node-advisories.js), every request is refused with a 503 before anything is fetched (#745).
 */

const { jsonForScript, escapeHtml } = require('./links');
const { NODE_ADVISORIES, affectingAdvisories, describeAdvisory } = require('./node-advisories');

// No allow-same-origin, ever: that one token is the difference between an opaque origin and ours.
const PROXY_CSP = 'sandbox allow-scripts allow-forms allow-popups';

// Upstream headers that describe the body and nothing else. Never add set-cookie,
// clear-site-data, service-worker-allowed, refresh or link: each acts on OUR origin.
const FORWARDED_HEADERS = Object.freeze(['content-type', 'content-language', 'cache-control', 'etag', 'last-modified']);

// These validate the upstream bytes. Once the HTML is rewritten they describe a body we are not
// sending, so they are dropped and Express derives an ETag from what we do send.
const UPSTREAM_VALIDATORS = new Set(['etag', 'last-modified']);

// postMessage tag shared with mods/baby-browser/index.html.
const BRIDGE_TAG = 'deepsteve-proxy';

function forwardedHeaders(upstreamHeaders, { rewritten = false } = {}) {
  const out = [];
  for (const name of FORWARDED_HEADERS) {
    if (rewritten && UPSTREAM_VALIDATORS.has(name)) continue;
    const value = upstreamHeaders.get(name);
    if (value != null) out.push([name, value]);
  }
  return out;
}

// Runs inside the proxied page, first thing in <head>, so it is registered before the page's own
// scripts and before any <meta http-equiv="Content-Security-Policy"> the page carries. Its
// listeners sit on window in the bubble phase, after the page's own handlers: a click or submit
// the page already handled (preventDefault) is left alone, which keeps client-side routers working.
function bridgeScript(pageUrl) {
  return `<script>(function () {
  var TAG = ${jsonForScript(BRIDGE_TAG)};
  var PAGE_URL = ${jsonForScript(pageUrl)};
  var host = window.parent;
  if (host === window) return;
  function post(m) { m.tag = TAG; host.postMessage(m, '*'); }
  function isHttp(u) { return u.protocol === 'http:' || u.protocol === 'https:'; }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== host || !m || m.tag !== TAG || m.kind !== 'read') return;
    var text = '';
    if (document.body) {
      var clone = document.body.cloneNode(true);
      var drop = clone.querySelectorAll('script, style, noscript, svg, link, meta');
      for (var i = 0; i < drop.length; i++) drop[i].remove();
      text = clone.innerText.replace(/\\n{3,}/g, '\\n\\n').trim();
    }
    post({ kind: 'read-result', id: m.id, title: document.title || '', text: text });
  });
  window.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || typeof a.href !== 'string' || (a.target && a.target !== '_self')) return;
    var raw = a.getAttribute('href');
    if (raw.charAt(0) === '#') { e.preventDefault(); location.hash = raw; return; }
    var u;
    try { u = new URL(a.href); } catch (x) { return; }
    if (!isHttp(u)) return;
    e.preventDefault();
    post({ kind: 'navigate', url: u.href });
  });
  window.addEventListener('submit', function (e) {
    var f = e.target;
    if (e.defaultPrevented || !f || f.method !== 'get' || (f.target && f.target !== '_self')) return;
    var u;
    try { u = new URL(f.getAttribute('action') ? f.action : PAGE_URL); } catch (x) { return; }
    if (!isHttp(u)) return;
    u.search = new URLSearchParams(new FormData(f)).toString();
    e.preventDefault();
    post({ kind: 'navigate', url: u.href });
  });
})();</script>`;
}

// <base> so the page's relative CSS/JS/images load straight from the remote origin, then the
// bridge. `(?=[\s>])` keeps <header> from matching as <head>.
function injectIntoHtml(html, finalUrl) {
  const inject = `<base href="${new URL(finalUrl).origin}/">${bridgeScript(finalUrl)}`;
  if (/<head(?=[\s>])[^>]*>/i.test(html)) return html.replace(/<head(?=[\s>])([^>]*)>/i, `<head$1>${inject}`);
  if (/<html(?=[\s>])[^>]*>/i.test(html)) return html.replace(/<html(?=[\s>])([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return inject + html;
}

// The refusal while the daemon runs a Node with a hole that remote bytes can reach (#745). A
// navigation (Baby Browser's iframe, or the page opened top-level) gets a page that says why,
// carrying the bridge so baby_browser_read hands the same explanation to an agent. Anything
// else — a display tab's fetch() of a JSON API — gets JSON.
function refuse(req, res, advisories, pageUrl) {
  const messages = advisories.map(describeAdvisory);
  res.status(503);
  if (!(req.headers.accept || '').includes('text/html')) {
    return res.json({
      error: `Deep Steve's web proxy is off: ${messages.join(' ')}`,
      advisories: advisories.map(a => ({ id: a.id, url: a.url, upgradeTo: a.upgradeTo })),
    });
  }
  const items = advisories.map((a, i) =>
    `<p>${escapeHtml(messages[i])} <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">Advisory</a></p>`).join('\n');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">${bridgeScript(String(pageUrl || ''))}`
    + `<title>Proxy off: Node.js needs a security upgrade</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:40em;margin:3em auto;padding:0 1em;line-height:1.5">`
    + `<h1 style="font-size:1.3em">Deep Steve's web proxy is off</h1>`
    + `<p>The Node.js running Deep Steve has a security hole that a web page can reach, so nothing `
    + `is fetched until it is upgraded.</p>\n${items}\n`
    + `<p>Restart Deep Steve after upgrading Node.js.</p></body></html>`);
}

function createProxy({
  log = () => {}, fetch = globalThis.fetch, nodeVersion = process.versions.node, advisories = NODE_ADVISORIES,
} = {}) {
  // Read once: the runtime cannot change under a running daemon. Both inputs are injectable so a
  // test can exercise every verdict without running an old Node.
  const blocking = affectingAdvisories(nodeVersion, advisories).filter(a => a.blocksProxy);
  return async function handleProxy(req, res) {
    // First, before any early return: an error page is a document too.
    res.setHeader('Content-Security-Policy', PROXY_CSP);
    const url = req.query.url;
    log(`[proxy] url=${url}${blocking.length ? ' (refused: Node.js needs a security upgrade)' : ''}`);
    // Before anything else, so no code path below can reach the decoder.
    if (blocking.length) return refuse(req, res, blocking, url);
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    try {
      const resp = await fetch(parsed.href, {
        headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0' },
        redirect: 'follow',
      });
      res.status(resp.status);
      const isHtml = (resp.headers.get('content-type') || '').includes('text/html');
      for (const [name, value] of forwardedHeaders(resp.headers, { rewritten: isHtml })) res.setHeader(name, value);
      let body = Buffer.from(await resp.arrayBuffer());
      if (isHtml) body = Buffer.from(injectIntoHtml(body.toString('utf-8'), resp.url), 'utf-8');
      res.send(body);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  };
}

module.exports = {
  PROXY_CSP,
  FORWARDED_HEADERS,
  BRIDGE_TAG,
  forwardedHeaders,
  bridgeScript,
  injectIntoHtml,
  createProxy,
};
