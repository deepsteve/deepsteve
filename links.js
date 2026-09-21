/**
 * Typed, versioned links into Deep Steve (#705): `/v1/<type>/<id>`.
 *
 * One URL shape for everything Deep Steve can show at an address, so an email a scheduled
 * agent sends can point at a decision waiting on you. The type is IN the link so a link says
 * what it points at and one type can be removed without touching the others; the version is in
 * it so the whole scheme can change later without breaking links already sent.
 *
 * The four rules, and where each one lives:
 *
 *   1. The stored item decides the type, not the link. A provider resolves the id; a mismatch
 *      is a redirect to the right link (a POST to the wrong type is refused, never redirected —
 *      see rule 4). That is decide() step 6.
 *   2. A link that has been sent is a promise: it opens, redirects or explains itself. So a type
 *      is REMOVED by moving it into REMOVED_TYPES — which answers 410 with a page saying so —
 *      and never by deleting its entry, which would turn every link in every inbox into a bare
 *      404. An id that was issued and is no longer stored is a 410 page for the same reason.
 *   3. Ids are never reused. That is the provider's promise (Workshop keeps a high-water mark
 *      outside its store); this file only relies on it.
 *   4. Answers go to the same versioned address, so a removed version or type cannot be
 *      answered. POST runs the same decide() as GET.
 *
 * This file knows NOTHING about where items are stored. A mod registers a provider — `owns(id)`,
 * `resolve(id)`, and per-type `render` (GET) / `act` (POST) handlers — and the link format stays
 * the same whatever the provider does underneath. GET only ever calls `render`: opening a link
 * must never change anything, because link previews and prefetchers open links too.
 *
 * Pure except for createLinks()'s provider list, so every branch is unit-testable with no daemon.
 */

const LINK_VERSION = 'v1';

// Every type a link may name. 'active' types serve; 'reserved' ones answer a clear "not
// available yet" page rather than a bare 404, so a link minted by a future build and opened on
// this one still explains itself.
const TYPE_STATES = Object.freeze({
  decision: 'active',
  'project-mod': 'active',
  markdown: 'reserved',
  html: 'reserved',
});

// type -> one sentence on why it went. Empty today. Removing a type means MOVING it here from
// TYPE_STATES, never deleting it: see rule 2 above.
const REMOVED_TYPES = Object.freeze({});

// Ids are short opaque tokens (Workshop's are `w<seq>`). Anything else is refused before any
// provider sees it, so no provider has to be defensive about a path segment.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Every page this module serves. `style-src 'unsafe-inline'` is for the static explanation
// pages' own <style>; nothing agent-authored is ever interpolated into markup (see escapeHtml),
// and scripts are 'self' only. img-src excludes remote hosts so an agent-written image URL
// cannot turn opening a decision into a tracking beacon.
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON safe to place inside `<script type="application/json">`. Only the characters that could
 * end the element or open a comment need escaping; JSON.parse reads the \u escapes back.
 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function setPageHeaders(res) {
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

const PAGE_STYLE = [
  'body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
  'margin:0;background:#f6f5f2;color:#1d1d1f}',
  'main{max-width:36rem;margin:14vh auto;padding:0 1.5rem}',
  '.eyebrow{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;',
  'text-transform:uppercase;color:#8a8780;margin:0 0 .75rem}',
  'h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}',
  'p{margin:0 0 .85rem}',
  'a{color:#2458c6}',
  '@media (prefers-color-scheme:dark){body{background:#131417;color:#e4e2dc}.eyebrow{color:#7d7a73}a{color:#8ab4f8}}',
].join('');

/** A static explanation page. Every string is escaped; `links` are [{ href, label }] to our own paths. */
function renderPage({ title, eyebrow = 'Deep Steve link', paragraphs = [], links = [] }) {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const anchors = links.length
    ? `<p>${links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join(' · ')}</p>`
    : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(title)} · Deep Steve</title><style>${PAGE_STYLE}</style></head>`
    + `<body><main><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1>`
    + `${body}${anchors}</main></body></html>`;
}

const HOME_LINK = { href: '/', label: 'Open Deep Steve' };

/**
 * What a request to /v1/<type>/<id> should get, as data. Pure: the caller supplies what the
 * provider said about the id. Order matters and each step's position is deliberate:
 *
 *   1. removed type  — before resolution, so a removed type can neither render nor be answered
 *   2. unknown type
 *   3. malformed id
 *   4. no provider owns the id — 503 while none has registered (mods mount asynchronously,
 *      and a failed Workshop load must read as "unavailable", not "no such decision")
 *   5. resolved: null → 404; { gone } → 410; { type: null } → exists but is not linkable
 *   6. resolved type ≠ link type → redirect (GET) / refuse (POST)
 *   7. reserved type → 501
 *   8. the owner has no handler for this type and method → 503
 */
function decide({
  method = 'GET', type, id, resolved, owned = false, providerCount = 0,
  hasHandler = false, types = TYPE_STATES, removed = REMOVED_TYPES,
}) {
  const isGet = method === 'GET' || method === 'HEAD';
  if (Object.prototype.hasOwnProperty.call(removed, type)) {
    return { kind: 'removed', status: 410, reason: removed[type] };
  }
  if (!Object.prototype.hasOwnProperty.call(types, type)) return { kind: 'unknown-type', status: 404 };
  if (typeof id !== 'string' || !ID_RE.test(id)) return { kind: 'bad-id', status: 404 };
  if (!owned) return providerCount === 0 ? { kind: 'unavailable', status: 503 } : { kind: 'not-found', status: 404 };
  if (!resolved) return { kind: 'not-found', status: 404 };
  if (resolved.gone) return { kind: 'gone', status: 410 };
  if (!resolved.type) return { kind: 'not-linkable', status: 404 };
  if (resolved.type !== type) {
    const location = `/${LINK_VERSION}/${resolved.type}/${encodeURIComponent(id)}`;
    return isGet ? { kind: 'redirect', status: 302, location } : { kind: 'wrong-type', status: 409, location };
  }
  if (types[type] === 'reserved') return { kind: 'reserved', status: 501 };
  if (!hasHandler) return { kind: 'unavailable', status: 503 };
  return { kind: 'serve', status: 200 };
}

// The page each non-serving outcome renders. Written for someone who clicked a link in an email.
function explain(decision, { type, id }) {
  switch (decision.kind) {
    case 'removed':
      return {
        title: 'This feature was removed',
        paragraphs: [
          `Deep Steve no longer has "${type}" links, so ${id} can't be opened here.`,
          ...(decision.reason ? [decision.reason] : []),
        ],
      };
    case 'unknown-type':
      return { title: 'Not a Deep Steve link', paragraphs: [`Deep Steve has no "${type}" links. The address may have been cut off or mistyped.`] };
    case 'bad-id':
    case 'not-found':
      // Deliberately covers "cleared out" as well: a provider whose ids are random UUIDs
      // cannot tell an evicted id from one it never issued, and the page must still explain.
      return { title: 'Nothing found', paragraphs: [`Deep Steve on this machine has no ${type} ${id}. It may have been cleared out since the link was sent, or the link may belong to Deep Steve on another computer.`] };
    case 'gone':
      return { title: 'No longer stored', paragraphs: [`${id} existed, but Deep Steve no longer keeps it. Older items are cleared out once enough newer ones have been answered.`] };
    case 'not-linkable':
      return { title: "This can't be opened from a link", paragraphs: [`${id} exists, but it is not something a link can open. Look for it in Workshop instead.`] };
    case 'reserved':
      return { title: 'Not available yet', paragraphs: [`"${type}" links are planned but this version of Deep Steve can't open them yet. Updating Deep Steve may help.`] };
    case 'unavailable':
    default:
      return { title: 'Not available right now', paragraphs: [`The part of Deep Steve that opens "${type}" links isn't running. If Deep Steve just started, reload in a moment; otherwise check the Deep Steve log for a mod that failed to load.`] };
  }
}

function createLinks({ log = () => {}, baseUrl = '' } = {}) {
  const providers = [];

  /** Replaces a provider of the same name, so a re-run init cannot stack duplicates. */
  function registerProvider(provider) {
    if (!provider || typeof provider.owns !== 'function' || typeof provider.resolve !== 'function') {
      throw new Error('a link provider needs owns(id) and resolve(id)');
    }
    const at = providers.findIndex((p) => p.name && p.name === provider.name);
    if (at >= 0) providers[at] = provider;
    else providers.push(provider);
    log(`[links] provider "${provider.name || 'anonymous'}" registered`);
  }

  function urlFor(type, id) {
    return `${baseUrl}/${LINK_VERSION}/${type}/${encodeURIComponent(id)}`;
  }

  function evaluate(method, req) {
    const type = String(req.params.type || '');
    const id = String(req.params.id || '');
    const owner = ID_RE.test(id) ? providers.find((p) => p.owns(id)) : null;
    let resolved = null;
    if (owner && TYPE_STATES[type] && !REMOVED_TYPES[type]) {
      try { resolved = owner.resolve(id); } catch (e) {
        log(`[links] resolve ${id} threw: ${e.message}`);
        resolved = null;
      }
    }
    const table = method === 'POST' ? owner && owner.act : owner && owner.render;
    const handler = resolved && resolved.type && table ? table[resolved.type] : null;
    const decision = decide({
      method, type, id, resolved, owned: !!owner, providerCount: providers.length,
      hasHandler: typeof handler === 'function',
    });
    return { type, id, resolved, handler, decision };
  }

  function handleGet(req, res) {
    const { type, id, resolved, handler, decision } = evaluate('GET', req);
    setPageHeaders(res);
    if (decision.kind === 'redirect') return res.redirect(302, decision.location);
    if (decision.kind === 'serve') return handler(req, res, resolved);
    const page = explain(decision, { type, id });
    return res.status(decision.status).type('html').send(renderPage({ ...page, links: [HOME_LINK] }));
  }

  function handlePost(req, res) {
    const { type, id, resolved, handler, decision } = evaluate('POST', req);
    res.setHeader('Cache-Control', 'no-store');
    if (decision.kind === 'serve') return handler(req, res, resolved);
    const page = explain(decision, { type, id });
    return res.status(decision.status).json({
      error: decision.kind,
      message: page.paragraphs.join(' '),
      ...(decision.location ? { location: decision.location } : {}),
    });
  }

  return { registerProvider, urlFor, handleGet, handlePost, _providers: providers };
}

module.exports = {
  LINK_VERSION,
  TYPE_STATES,
  REMOVED_TYPES,
  PAGE_CSP,
  escapeHtml,
  jsonForScript,
  setPageHeaders,
  renderPage,
  decide,
  explain,
  createLinks,
};
