/**
 * Per-socket handshake tracing (#674).
 *
 * The failure this exists for: after a restart, every socket in the page sat in
 * `readyState CONNECTING` for 30-60s — no traffic, no error event, nothing — and then all
 * thirteen opened within 50ms of each other. From the daemon's side that gap is simply an
 * absence of connections: there is no upgrade to log, no rejection to log, nothing at all
 * between "[startup] HTTP listening" and the burst. Only the page can see it.
 *
 * So the page says so, over the client-log channel that already lands in the daemon log
 * beside the [startup] marks. Three beacons, each answering a different question:
 *
 *   ws-failed     A socket closed having never opened. THIS IS THE ARMING EVENT. Every one
 *                 of these ramps the browser-global FailDelay entry (see server-probe.js)
 *                 that then silences every later socket in the browser. A slow restart
 *                 preceded by these has its cause named; one preceded by none does not.
 *   ws-slow-open  A socket that did open, but seconds after we asked — with no error in
 *                 between. That is parking, not slowness: the gate had already watched
 *                 /healthz answer, so the server was up and the handshake simply never
 *                 left the browser.
 *   ws-abandoned  A socket still CONNECTING when the page went away. Aborting a handshake
 *                 counts as a failure to FailDelay accounting, so a page that navigates
 *                 with sockets in flight arms the entry for the page it becomes.
 *
 * Import-inert, the same contract wake-watch.js and client-log.js keep: nothing here
 * touches window or document until initWsTrace() runs, so unit tests can import the module
 * chain in bare Node without stubbing a browser.
 */

import { clientLog, flushClientLog } from './client-log.js';

// Above any plausible localhost handshake by two orders of magnitude, and far below the
// 30-60s parks this is hunting. A busy daemon answers an upgrade in single-digit ms; the
// point of the beacon is to separate "the server was slow" from "we never reached it".
const SLOW_OPEN_MS = 3_000;

// Sockets asked for but not yet open. The pagehide sweep reads it; open and close remove
// from it, so a page that never navigates never accumulates.
const pending = new Set();

/**
 * Arm the navigation sweep. Call once at boot, next to initClientLog().
 */
export function initWsTrace() {
  window.addEventListener('pagehide', () => {
    for (const t of pending) {
      clientLog('ws-abandoned', `${t.label} still CONNECTING after ${Date.now() - t.startedAt}ms when the page went away`);
    }
    // The queue flushes on a 3s interval, which a navigation does not wait for.
    flushClientLog();
  });
}

/**
 * Watch one socket from construction to its first terminal event.
 *
 * Uses addEventListener, never the on* properties: both call sites assign onopen/onclose
 * immediately after this returns, and a property assignment would silently delete the
 * trace. The typeof guard is not for browsers — it is so that a test double, or a realm
 * whose WebSocket has been wrapped by a mod, can never make tracing the reason a socket
 * fails to open.
 */
export function traceSocket(ws, label = 'socket') {
  if (!ws || typeof ws.addEventListener !== 'function') return;

  const entry = { label, startedAt: Date.now() };
  pending.add(entry);

  ws.addEventListener('open', () => {
    if (!pending.delete(entry)) return;
    const ms = Date.now() - entry.startedAt;
    if (ms >= SLOW_OPEN_MS) {
      clientLog('ws-slow-open',
        `${label} opened after ${ms}ms — /healthz had already answered, so this was a parked handshake, not a slow server`);
    }
  });

  ws.addEventListener('close', (e) => {
    // Already open when it closed: an ordinary drop, which the reconnect loop handles and
    // which does NOT arm the delay. Only a handshake that never completed does.
    if (!pending.delete(entry)) return;
    clientLog('ws-failed',
      `${label} never opened — gave up after ${Date.now() - entry.startedAt}ms, code ${e && e.code}, clean=${e && e.wasClean}`);
  });
}

// Test seam — the pending set is module state and would leak across cases.
export function _reset() { pending.clear(); }
