/**
 * Client-side error beacon.
 *
 * The failure mode this exists for (2026-07-15 incident): the page's WebSockets
 * stay healthy while every fetch() fails — dead cookie, rate-limit, or a
 * half-broken page — so features silently degrade (empty command palette,
 * misleading alerts) and NOTHING reaches the server log. Hours of 401s left
 * zero trace anywhere.
 *
 * Entries travel over the live-reload socket where one exists — the channel that
 * demonstrably survives that state — and fall back to POST /api/client-log,
 * which is mounted above the auth gate for exactly this reason. Never the
 * wrapped fetch: a beacon that failed would beacon its own failure. The server
 * writes entries to the daemon log as `[client <windowId> <realm>] kind: msg`.
 *
 * REALMS (#675). Every mod iframe, display tab and project-mod page is a
 * separate JS realm with its own `window.fetch`, so wrapping only the shell's
 * left them invisible: a workshop iframe polling a dead cookie produced 660
 * daemon-log rejections and not one client-side line. The shell therefore wraps
 * each child realm's fetch from the parent — the same same-origin reach the
 * `window.deepsteve` bridge already relies on — and tags entries with the realm
 * that made the call.
 *
 * Captures:
 *  - window JS errors ('error' events)
 *  - unhandled promise rejections
 *  - any same-origin /api/* or /mcp fetch that throws or returns >= 400
 *  - and, on 401/429, triggers the auth heal (see auth-heal.js)
 */

import { maybeHealAuth } from './auth-heal.js';

const MAX_QUEUE = 100;   // ring cap — beyond this, count drops instead of growing
const MAX_BATCH = 20;    // entries per WS message
const FLUSH_MS = 3000;
const MAX_MSG = 300;
// Consecutive flushes with no live socket before the HTTP fallback takes over — long enough to ride
// out a restart (a few seconds of downtime) without POSTing into a server that is still down.
const SOCKET_PATIENCE = 3;

const queue = [];
let dropped = 0;
let getSocket = null;
let windowId = null;
let socketMisses = 0;
// The pristine fetch, captured by the first wrapRealmFetch call (the shell's own, from
// initClientLog). The beacon's HTTP transport uses this so a failing beacon POST can never be
// recorded — and retried, and recorded — by the wrapper. Captured lazily rather than at module
// scope: this module is imported by mod-manager.js, and a unit test that stubs a bare `window`
// must be able to load it without owning a fetch.
let rawFetch = null;

function record(kind, msg, realm) {
  if (queue.length >= MAX_QUEUE) { dropped++; return; }
  queue.push({ kind, msg: String(msg).slice(0, MAX_MSG), realm });
}

/** Explicit breadcrumb for modules that want to report a failure directly. */
export function clientLog(kind, msg) { record(kind, msg, 'shell'); }

/**
 * Send whatever is queued right now, instead of waiting out the interval. For the one
 * caller that has no next interval to wait for: ws-trace.js's pagehide sweep (#674), whose
 * whole subject is a page that is about to stop existing.
 */
export function flushClientLog() { flush(); }

function flush() {
  if (queue.length === 0) return;
  const ws = getSocket && getSocket();
  const haveSocket = !!(ws && ws.readyState === 1);
  if (haveSocket) socketMisses = 0;
  else socketMisses++;

  // Hold out for the socket before falling back. A daemon restart drops it for a few seconds and
  // brings it back, and the queue riding that out is the original design — switching to HTTP the
  // instant it blinks would POST into a server that is still down and lose the entries, which is
  // worse than waiting. Only once it has stayed gone across several flushes is this the #675 shape:
  // a realm that will never have a socket, whose entries would otherwise sit in the queue forever.
  const socketIsNotComing = !getSocket || socketMisses > SOCKET_PATIENCE;
  // Decide the transport BEFORE taking entries off the queue: with neither a live socket nor a
  // usable fallback there is nowhere to put them, and splicing first would drop them on the floor.
  if (!haveSocket && !(socketIsNotComing && rawFetch)) return;

  const entries = queue.splice(0, MAX_BATCH);
  if (dropped > 0) { entries.push({ kind: 'beacon', msg: `${dropped} entries dropped`, realm: 'shell' }); dropped = 0; }

  if (haveSocket) {
    try { ws.send(JSON.stringify({ type: 'client-log', entries })); return; } catch { /* fall through */ }
  }
  if (!rawFetch) return;
  // No socket (or the send threw). POST instead — this is the path that works when the page's own
  // auth is broken, which is the state most worth reporting. Failures are swallowed: the entries
  // are already spliced off the queue, and re-queueing a batch that just failed to send is how a
  // beacon turns into the flood it was meant to report.
  try {
    rawFetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId, entries }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}

/**
 * Give the beacon its transport. Call once from live-reload; the getter must
 * return the CURRENT socket (live-reload reassigns it on every reconnect).
 * `id` names the window in the log — the HTTP fallback has no socket to read it from.
 */
export function attachClientLogSender(socketGetter, id) {
  getSocket = socketGetter;
  if (id) windowId = id;
}

/**
 * Wrap one realm's fetch so its failing /api/* and /mcp calls are beaconed, and a 401/429
 * triggers the auth heal.
 *
 * `win` may be a child iframe's contentWindow. It is deliberately the PARENT's maybeHealAuth that
 * runs for a child realm: the heal's one-shot guard is a sessionStorage key namespaced by iframe
 * depth, and its in-flight/cooldown state is module-local, so a per-iframe copy would give every
 * frame its own guard and its own idea of whether a reload is already pending. One shell-realm
 * heal means one probe, one cooldown, and one reload for the whole window.
 *
 * Idempotent: re-wrapping on every iframe `load` is the intended usage, but a second call against
 * a live realm must not stack wrappers.
 */
export function wrapRealmFetch(win, realm) {
  if (!win || win.__deepsteveFetchWrapped) return;
  // Must come off `win`, not this module's scope: a child realm's Request/AbortSignal belongs to
  // that realm's constructors, and handing it to the parent's native fetch is a different function.
  const origFetch = win.fetch;
  if (typeof origFetch !== 'function') return;
  win.__deepsteveFetchWrapped = true;
  // First one wins, and the first call is initClientLog's on the shell — so the beacon's HTTP
  // transport is the shell's own unwrapped fetch, never a child iframe's (which can be torn down
  // under it) and never the wrapper (which would report the beacon's own failures).
  if (!rawFetch) rawFetch = origFetch.bind(win);

  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let apiPath = null;
    if (url.startsWith('/api/') || url.startsWith('/mcp')) {
      apiPath = url;
    } else if (url.startsWith(location.origin)) {
      try {
        const p = new URL(url).pathname;
        if (p.startsWith('/api/') || p.startsWith('/mcp')) apiPath = p;
      } catch {}
    }
    const p = origFetch.call(this, input, init);
    // The beacon's own endpoint is a /api/ path, so without this it would report its own failures:
    // a throttled beacon POST answers 429, which records an entry, which schedules another POST.
    // flush() already uses the unwrapped fetch, so this only matters if some other caller hits it,
    // but a self-feeding error reporter is worth closing off structurally rather than by argument.
    if (!apiPath || apiPath.startsWith('/api/client-log')) return p;
    const method = (init && init.method) || 'GET';
    return p.then((res) => {
      if (res.status >= 400) record(`fetch-${res.status}`, `${method} ${apiPath}`, realm);
      // The heal used to be reachable only from the two WebSocket reconnect loops, so a realm whose
      // socket was fine — or which holds no socket at all — 401'd forever (#675). A 401/429 from
      // authGate is the same evidence a rejected upgrade is, and now gets the same response. The
      // heal re-probes /api/version through this very wrapper; its in-flight + 2s probe cooldown
      // are what stop that from recursing.
      //
      // /api/proxy is excluded because it passes the UPSTREAM status through: a remote site the
      // Baby Browser is showing can answer 401, and that says nothing about our cookie. Still worth
      // beaconing, never worth probing for.
      if ((res.status === 401 || res.status === 429) && !apiPath.startsWith('/api/proxy')) {
        maybeHealAuth();
      }
      return res;
    }, (err) => {
      record('fetch-network', `${method} ${apiPath} — ${err && err.message ? err.message : err}`, realm);
      throw err;
    });
  };
}

export function initClientLog() {
  window.addEventListener('error', (e) => {
    record('js-error', `${e.message} (${e.filename || '?'}:${e.lineno || '?'})`, 'shell');
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    record('unhandled-rejection',
      r && r.stack ? String(r.stack).split('\n').slice(0, 2).join(' | ') : String(r), 'shell');
  });

  // Report failing API calls: same-origin /api/* and /mcp only — never request
  // bodies, never successes. The beacon itself doesn't use the wrapped fetch, so
  // there is no recursion.
  wrapRealmFetch(window, 'shell');

  setInterval(flush, FLUSH_MS);
}
