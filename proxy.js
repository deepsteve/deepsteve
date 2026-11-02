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
 * Since that bridge, the PAGE picks the next URL the daemon fetches: it can post a `navigate`
 * with any URL, in a loop. So the fetch itself is bounded too (#746):
 *
 *   4. Destination policy, keyed on who chose the URL. A bare `/api/proxy?url=…` reaches public
 *      addresses only. `&by=user` says the user or an agent chose it (Baby Browser's address
 *      bar, baby_browser_navigate, a display tab's own code), and may reach anything they could
 *      already reach. Baby Browser never adds it for a page's `navigate`, except a same-origin
 *      link on a local host the user opened (mods/baby-browser/nav-trust.js). Independent of
 *      who started it, a redirect chain that has connected to a public address never steps back
 *      to a non-public one. proxy-address.js does the classifying.
 *   5. The check is on the address actually connected to: it runs inside the socket's own DNS
 *      lookup, so the vetted answer is the one dialed and rebinding has no window. IP literals
 *      skip lookup, so they are vetted before the request. Redirects are followed here, one hop
 *      at a time, each hop vetted. No connection pooling, or a socket opened by a `by=user` fetch
 *      could be reused by a page's.
 *   6. A deadline over the whole chain (DNS, connect, headers, body) and a cap on decoded body
 *      bytes, so one URL that streams forever cannot grow the daemon until it dies. Both answer
 *      502 naming the limit. The upstream is also dropped when the browser goes away.
 *
 * This is also the one route that feeds arbitrary internet bytes to Node itself, including its
 * gzip and Brotli decoders (readCapped below). While the running Node has a hole those bytes can
 * reach (an advisory marked `blocksProxy` in node-advisories.js), every request is refused with a
 * 503 before anything is fetched (#745).
 */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { jsonForScript, escapeHtml } = require('./links');
const { NODE_ADVISORIES, affectingAdvisories, describeAdvisory } = require('./node-advisories');
const { classifyAddress } = require('./proxy-address');

const PROXY_TIMEOUT_MS = 30_000;
const PROXY_MAX_BYTES = 20 * 1024 * 1024;
const PROXY_MAX_REDIRECTS = 10;

// The Fetch standard's "bad port" list. The proxy used fetch() until #746, which refused these;
// http.request does not, so the list moved here to keep cross-protocol requests (SMTP, IRC, X11…)
// out of reach of a page.
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
    const value = upstreamHeaders[name];
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

// An answer we chose to give, as opposed to an upstream failure: carries its own status and
// any extra JSON fields (`limit`, `refused`).
class ProxyError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const isHttp = (u) => u.protocol === 'http:' || u.protocol === 'https:';
const mib = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;

function refusal(url, address, cls, afterPublic) {
  const why = afterPublic
    ? 'it is a redirect from a public address, and a redirect may not step back into a local network'
    : 'neither you nor an agent chose this URL (it came from a page, or from /api/proxy without by=user), so it may only reach public addresses';
  return new ProxyError(403,
    `Refused ${url.href}: ${address} is not a public address (${cls}), and ${why}. To open it yourself, enter the URL in Baby Browser's address bar.`,
    { refused: { url: url.href, address, class: cls } });
}

// Decoders for a Content-Encoding list, applied last-first. null for one we cannot decode, which
// cannot happen unless a server ignores our Accept-Encoding. Lenient flushing, as fetch() was:
// a truncated body still yields what arrived.
function decodersFor(header) {
  const codings = String(header || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'identity');
  const out = [];
  for (const c of codings.reverse()) {
    if (c === 'gzip' || c === 'x-gzip' || c === 'deflate') {
      out.push(zlib.createUnzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }));
    } else if (c === 'br') {
      out.push(zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
      }));
    } else {
      return null;
    }
  }
  return out;
}

// Reads the decoded body, refusing past maxBytes instead of buffering it. Counting the DECODED
// bytes is what makes a gzip bomb hit the cap too. Any error tears down the upstream socket.
async function readCapped(up, { maxBytes, signal }) {
  const tooBig = () => new ProxyError(502, `Upstream response exceeded the ${mib(maxBytes)} limit`, { limit: 'size' });
  const decoders = decodersFor(up.headers['content-encoding']);
  if (!decoders) {
    up.destroy();
    throw new ProxyError(502, `Unsupported Content-Encoding: ${up.headers['content-encoding']}`);
  }
  if (!decoders.length && Number(up.headers['content-length']) > maxBytes) {
    up.destroy();
    throw tooBig();
  }
  const chunks = [];
  let total = 0;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(tooBig());
      chunks.push(chunk);
      cb();
    },
  });
  await pipeline(up, ...decoders, sink, { signal });
  return Buffer.concat(chunks);
}

// One hop. Resolves with the upstream response and the address its socket connected to.
function requestOnce(url, { mayReachLocal, afterPublic, classify, lookup, signal, userAgent }) {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (BAD_PORTS.has(port)) {
    return Promise.reject(new ProxyError(403, `Refused ${url.href}: port ${port} is blocked, as it is in browsers`));
  }
  const vet = (address) => {
    const cls = classify(address);
    return cls === 'public' || mayReachLocal ? null : refusal(url, address, cls, afterPublic);
  };
  // An IP literal never reaches the lookup below, so it is vetted here; the request then dials
  // exactly this string.
  if (net.isIP(host)) {
    const refused = vet(host);
    if (refused) return Promise.reject(refused);
  }
  // Everything else is vetted inside the socket's own lookup: what passes is what connects.
  function vettedLookup(hostname, options, cb) {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      if (!addresses.length) return cb(new ProxyError(502, `No address found for ${hostname}`));
      const allowed = addresses.filter((a) => !vet(a.address));
      if (!allowed.length) return cb(vet(addresses[0].address));
      if (options.all) return cb(null, allowed);
      return cb(null, allowed[0].address, allowed[0].family);
    });
  }
  const https_ = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (https_ ? https : http).request({
      hostname: host,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      agent: false,
      signal,
      lookup: vettedLookup,
      ...(https_ && !net.isIP(host) ? { servername: host } : {}),
      headers: {
        host: url.host,
        'user-agent': userAgent,
        accept: '*/*',
        'accept-language': '*',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (up) => {
      const address = up.socket && up.socket.remoteAddress;
      // Cannot fail after the vetting above; if it ever does, the body is not read.
      if (vet(address || '')) {
        up.destroy();
        return reject(new ProxyError(502, `Connected to ${address || 'an unknown address'}, which is not the address that was vetted`));
      }
      resolve({ up, address });
    });
    req.on('error', reject);
    req.end();
  });
}

// Follows redirects one hop at a time, vetting each. `byUser` may reach a non-public address
// only until the chain has connected to a public one: a public site's 302 never leads inward.
async function fetchChain(start, { byUser, maxRedirects, classify, ...hop }) {
  let url = start;
  let touchedPublic = false;
  for (let n = 0; ; n++) {
    const { up, address } = await requestOnce(url, {
      ...hop, classify, mayReachLocal: byUser && !touchedPublic, afterPublic: touchedPublic,
    });
    const connected = classify(address || '');
    if (connected === 'public' || connected === 'not-an-ip') touchedPublic = true;
    const location = up.headers.location;
    if (!REDIRECT_STATUSES.has(up.statusCode) || !location) return { up, url };
    up.destroy();
    if (n >= maxRedirects) throw new ProxyError(502, `Stopped after ${maxRedirects} redirects`, { limit: 'redirects' });
    let next;
    try {
      next = new URL(location, url);
    } catch {
      throw new ProxyError(502, `Upstream redirected to an invalid URL: ${location}`);
    }
    if (!isHttp(next)) throw new ProxyError(502, `Upstream redirected to a ${next.protocol} URL, which the proxy does not follow`);
    url = next;
  }
}

function createProxy({
  log = () => {},
  classify = classifyAddress,
  lookup = dns.lookup,
  timeoutMs = PROXY_TIMEOUT_MS,
  maxBytes = PROXY_MAX_BYTES,
  maxRedirects = PROXY_MAX_REDIRECTS,
  nodeVersion = process.versions.node,
  advisories = NODE_ADVISORIES,
} = {}) {
  // Read once: the runtime cannot change under a running daemon. Both inputs are injectable so a
  // test can exercise every verdict without running an old Node.
  const blocking = affectingAdvisories(nodeVersion, advisories).filter(a => a.blocksProxy);
  return async function handleProxy(req, res) {
    // First, before any early return: an error page is a document too.
    res.setHeader('Content-Security-Policy', PROXY_CSP);
    const url = req.query.url;
    const byUser = req.query.by === 'user';
    log(`[proxy] url=${url}${byUser ? ' by=user' : ''}${blocking.length ? ' (refused: Node.js needs a security upgrade)' : ''}`);
    // Before anything else, so no code path below can reach the decoder.
    if (blocking.length) return refuse(req, res, blocking, url);
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });
    let parsed;
    try {
      if (typeof url !== 'string') throw new TypeError();
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (!isHttp(parsed)) return res.status(400).json({ error: 'Only http and https URLs can be proxied' });

    // One deadline for the whole chain. The browser leaving (Baby Browser navigating again, a
    // tab closing) also aborts it, so a page's rapid navigates do not pile up upstream fetches.
    const controller = new AbortController();
    let timedOut = false;
    let clientGone = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    res.on('close', () => {
      clientGone = !res.writableFinished;
      controller.abort();
    });
    try {
      const { up, url: finalUrl } = await fetchChain(parsed, {
        byUser, maxRedirects, classify, lookup,
        signal: controller.signal,
        userAgent: req.headers['user-agent'] || 'Mozilla/5.0',
      });
      let body = await readCapped(up, { maxBytes, signal: controller.signal });
      clearTimeout(timer);
      res.status(up.statusCode);
      const isHtml = String(up.headers['content-type'] || '').includes('text/html');
      for (const [name, value] of forwardedHeaders(up.headers, { rewritten: isHtml })) res.setHeader(name, value);
      if (isHtml) body = Buffer.from(injectIntoHtml(body.toString('utf-8'), finalUrl.href), 'utf-8');
      res.send(body);
    } catch (err) {
      clearTimeout(timer);
      if (clientGone || res.headersSent) return;
      if (timedOut) {
        log(`[proxy] timed out after ${timeoutMs}ms: ${parsed.href}`);
        return res.status(502).json({ error: `Upstream did not finish within ${timeoutMs / 1000}s`, limit: 'time' });
      }
      if (err instanceof ProxyError) {
        log(`[proxy] ${err.status}: ${err.message}`);
        return res.status(err.status).json({ error: err.message, ...err.extra });
      }
      res.status(502).json({ error: err.message });
    }
  };
}

module.exports = {
  PROXY_CSP,
  FORWARDED_HEADERS,
  BRIDGE_TAG,
  PROXY_TIMEOUT_MS,
  PROXY_MAX_BYTES,
  PROXY_MAX_REDIRECTS,
  BAD_PORTS,
  forwardedHeaders,
  bridgeScript,
  injectIntoHtml,
  createProxy,
};
