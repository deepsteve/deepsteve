/**
 * Client-side error beacon.
 *
 * The failure mode this exists for (2026-07-15 incident): the page's WebSockets
 * stay healthy while every fetch() fails — dead cookie, rate-limit, or a
 * half-broken page — so features silently degrade (empty command palette,
 * misleading alerts) and NOTHING reaches the server log. Hours of 401s left
 * zero trace anywhere.
 *
 * Entries therefore travel over the live-reload socket — the channel that
 * demonstrably survives that state — never over fetch. The server writes them
 * to the daemon log as `[client <windowId>] kind: msg` lines.
 *
 * Captures:
 *  - window JS errors ('error' events)
 *  - unhandled promise rejections
 *  - any same-origin /api/* or /mcp fetch that throws or returns >= 400
 */

const MAX_QUEUE = 100;   // ring cap — beyond this, count drops instead of growing
const MAX_BATCH = 20;    // entries per WS message
const FLUSH_MS = 3000;
const MAX_MSG = 300;

const queue = [];
let dropped = 0;
let getSocket = null;

function record(kind, msg) {
  if (queue.length >= MAX_QUEUE) { dropped++; return; }
  queue.push({ kind, msg: String(msg).slice(0, MAX_MSG) });
}

/** Explicit breadcrumb for modules that want to report a failure directly. */
export function clientLog(kind, msg) { record(kind, msg); }

function flush() {
  if (!getSocket || queue.length === 0) return;
  const ws = getSocket();
  if (!ws || ws.readyState !== 1) return; // keep queued until the socket is back
  const entries = queue.splice(0, MAX_BATCH);
  if (dropped > 0) { entries.push({ kind: 'beacon', msg: `${dropped} entries dropped` }); dropped = 0; }
  try { ws.send(JSON.stringify({ type: 'client-log', entries })); } catch {}
}

/**
 * Give the beacon its transport. Call once from live-reload; the getter must
 * return the CURRENT socket (live-reload reassigns it on every reconnect).
 */
export function attachClientLogSender(socketGetter) {
  getSocket = socketGetter;
}

export function initClientLog() {
  window.addEventListener('error', (e) => {
    record('js-error', `${e.message} (${e.filename || '?'}:${e.lineno || '?'})`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    record('unhandled-rejection',
      r && r.stack ? String(r.stack).split('\n').slice(0, 2).join(' | ') : String(r));
  });

  // Report failing API calls: same-origin /api/* and /mcp only — never request
  // bodies, never successes. The beacon itself doesn't use fetch, so there is
  // no recursion.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
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
    if (!apiPath) return p;
    const method = (init && init.method) || 'GET';
    return p.then((res) => {
      if (res.status >= 400) record(`fetch-${res.status}`, `${method} ${apiPath}`);
      return res;
    }, (err) => {
      record('fetch-network', `${method} ${apiPath} — ${err && err.message ? err.message : err}`);
      throw err;
    });
  };

  setInterval(flush, FLUSH_MS);
}
