/**
 * WebSocket client wrapper with auto-reconnect.
 *
 * Reconnect is gated on an HTTP /healthz probe (#553). The old loop was a flat 1Hz
 * setInterval that fired `new WebSocket(url)` blindly, per socket, per tab, per nesting
 * level. Every failed handshake ramps Firefox's RFC 6455 FailDelay (x1.5, capped at 60s)
 * — and that entry is shared by EVERY DeepSteve socket in the browser, because it's keyed
 * on a path that excludes the query string and all our URLs are ws://host/?params. Once
 * ramped, new sockets are parked in CONNECTING_DELAYED: no traffic, no error event, just
 * silence for up to a minute. That is the "upgrades hang ~4s under scale" bug.
 *
 * The entry outlives any usable retry interval (60s + delay past the last failure), so no
 * backoff schedule can dig us out — see server-probe.js. We simply never emit a handshake
 * we don't expect to succeed.
 */

import { maybeHealAuth, noteAuthOk } from './auth-heal.js';
import { onWake } from './wake-watch.js';
import { waitForServer, jitter, sleep } from './server-probe.js';

// Backoff for an attempt that got PAST the /healthz gate and still failed — i.e. the
// server is up but rejected the upgrade (auth). Without this, the gate would turn that
// case into a *tighter* ramping loop than the 1Hz one it replaced. maybeHealAuth()
// normally resolves it within a couple of seconds by reloading to re-acquire the cookie.
const WS_BACKOFF_BASE_MS = 1_000;
const WS_BACKOFF_MAX_MS = 30_000;
// A socket that stayed open at least this long was a real connection — its drop gets an
// immediate, backoff-free retry (the gate still re-checks /healthz first). One that died
// sooner is treated as a failed attempt: a server that accepts upgrades and instantly
// kills them would otherwise spin a hot connect loop the old 1Hz interval never allowed.
const WS_STABLE_MS = 2_000;

// After a system sleep a socket can be dead-but-OPEN: the browser hasn't fired
// onclose yet, so the reconnect loop never starts (#563). On a wake signal we
// probe every open socket with {type:'ping'} and force-close it if nothing
// comes back, and kick loops that are sitting in a reconnect backoff so they
// retry immediately instead of waiting out the delay.
const PROBE_TIMEOUT_MS = 5000;
const liveWrappers = new Set();

onWake(() => {
  if (window.__deepsteveReloadPending) return; // same contract as the reconnect loop
  for (const w of liveWrappers) {
    try { w._onWake(); } catch {}
  }
});

// 8 hex chars, the server's own shell-id shape (randomUUID().slice(0, 8)).
function mintShellId() {
  try { return crypto.randomUUID().slice(0, 8); }
  catch { // non-secure contexts (plain-HTTP LAN via --bind) lack randomUUID
    return [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export function createWebSocket(options = {}) {
  // #554: mint the shell id client-side for new sessions so create retries are
  // idempotent — every reconnect re-requests the SAME shell instead of spawning
  // a fresh one per retry when the socket drops before the session message lands.
  if (options.isNew && !options.id) options.id = mintShellId();

  const params = new URLSearchParams();

  if (options.action) params.set('action', options.action);
  if (options.session) params.set('session', options.session);
  if (options.id) params.set('id', options.id);
  if (options.cwd) params.set('cwd', options.cwd);
  if (options.isNew) params.set('new', '1');
  if (options.worktree) params.set('worktree', options.worktree);
  if (options.cols) params.set('cols', options.cols);
  if (options.rows) params.set('rows', options.rows);
  if (options.name) params.set('name', options.name);
  if (options.planMode) params.set('planMode', '1');
  if (options.agentType && options.agentType !== 'claude') params.set('agentType', options.agentType);
  if (options.configProfile) params.set('configProfile', options.configProfile); // custom Claude config profile (#537)
  if (options.windowId) params.set('windowId', options.windowId);
  if (options.fork) params.set('fork', options.fork);
  if (options.rcParent) params.set('rcParent', options.rcParent);

  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let url = wsProto + location.host + '?' + params;
  let ws = null;
  // Set by close(). The whole point: onclose can't otherwise tell an intentional close
  // from a dropped connection, so it used to re-arm a reconnect loop that nothing held a
  // handle to — and since setSessionId() hadn't run, its URL still lacked `id`, so every
  // tick asked the server to spawn a BRAND NEW shell. Must be set before ws.close().
  let closed = false;
  let isReconnecting = false;
  let wsFailures = 0;
  // Wake probe state (#563).
  let probeTimer = null;
  let probeStartedAt = 0;
  let probeFailed = false;
  // Resolver for the loop's current backoff wait; _onWake()/close() call it to cut the
  // wait short so a wake retries immediately instead of sitting out up to 30s.
  let kickWait = null;

  function clearProbe() {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    probeStartedAt = 0;
  }

  // Wall-clock-checked probe timeout: browsers batch throttled-tab timers, so
  // the 5s timeout callback can run in the same batch as the ping send — only
  // give up when PROBE_TIMEOUT_MS of real time has actually passed.
  function armProbeCheck() {
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (!probeStartedAt) return; // already answered
      const elapsed = Date.now() - probeStartedAt;
      if (elapsed < PROBE_TIMEOUT_MS) { armProbeCheck(); return; }
      // No traffic since the probe: the socket died during sleep. Force-close.
      // The close may complete "clean", so remember why we closed it.
      probeStartedAt = 0;
      probeFailed = true;
      try { ws.close(); } catch {}
    }, Math.max(500, PROBE_TIMEOUT_MS - (Date.now() - probeStartedAt)));
  }

  const wrapper = {
    // Null until the first attempt gets past the gate; "still connecting" is the honest
    // answer then, and it keeps send()/sendJSON() below correctly inert.
    get readyState() { return ws ? ws.readyState : WebSocket.CONNECTING; },

    // Set by the caller when the server's session message advertises pingPong
    // support — never send probes to a server that would type them into the PTY.
    serverSupportsPing: false,

    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },

    sendJSON(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    },

    close() {
      closed = true;
      clearProbe();
      if (kickWait) kickWait(); // let a sleeping loop observe `closed` now
      if (ws) ws.close();
    },

    // Called after server assigns a session ID — updates the reconnect URL
    // so future reconnections request the existing session instead of creating new ones.
    setSessionId(id) {
      const p = new URLSearchParams();
      if (options.action) p.set('action', options.action);
      if (options.session) p.set('session', options.session);
      p.set('id', id);
      if (options.cwd) p.set('cwd', options.cwd);
      if (options.cols) p.set('cols', options.cols);
      if (options.rows) p.set('rows', options.rows);
      if (options.agentType && options.agentType !== 'claude') p.set('agentType', options.agentType);
      if (options.configProfile) p.set('configProfile', options.configProfile); // custom Claude config profile (#537)
      if (options.windowId) p.set('windowId', options.windowId);
      url = wsProto + location.host + '?' + p;
    },

    // Wake handling (#563): kick a waiting reconnect loop immediately, or verify an
    // OPEN socket really survived the sleep.
    _onWake() {
      if (isReconnecting) {
        wsFailures = 0; // the network just changed under us — retry fresh
        if (kickWait) kickWait();
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN && wrapper.serverSupportsPing && !probeStartedAt) {
        probeStartedAt = Date.now();
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        armProbeCheck();
      }
    },

    // Event handlers - set by caller
    onmessage: null,
    onerror: null,
    onclose: null,
    onopen: null,
    onreconnecting: null,  // Called when reconnect starts
    onreconnected: null,   // Called when reconnect succeeds
  };

  // Interruptible sleep for the loop's backoff: _onWake()/close() resolve it early via
  // kickWait. (The gate's own waits live inside waitForServer and cap at 5s, so a wake
  // is never more than 5s from a fresh probe there.)
  function wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); kickWait = null; resolve(); }
      kickWait = done;
    });
  }

  /**
   * One socket, start to finish. Resolves when it closes — so a single loop iteration
   * below spans the socket's whole life and the initial connect is not a special case.
   * Deliberately never aborts a CONNECTING socket: a stall means either the server's event
   * loop is briefly blocked (the handshake is about to succeed) or Firefox has us queued
   * behind another tab, and aborting would discard a nearly-live connection and re-enter
   * the admission queue at the back. At most one socket in flight, never stacked.
   */
  function attemptConnect() {
    return new Promise((resolve) => {
      let openedAt = 0;
      ws = new WebSocket(url);

      ws.onopen = () => {
        openedAt = Date.now();
        noteAuthOk();
        if (isReconnecting) {
          isReconnecting = false;
          if (wrapper.onreconnected) wrapper.onreconnected();
        }
        if (wrapper.onopen) wrapper.onopen();
      };

      ws.onmessage = (e) => {
        // Any traffic proves the socket is alive — no need to parse for pong.
        if (probeStartedAt) clearProbe();
        if (wrapper.onmessage) wrapper.onmessage(e);
      };

      ws.onerror = (e) => {
        if (wrapper.onerror) wrapper.onerror(e);
      };

      ws.onclose = (e) => {
        clearProbe();
        // A dead socket we force-closed after a failed wake probe can report
        // wasClean=true (#563) — treat it as unclean so the loop reconnects.
        const wasClean = e.wasClean && !probeFailed;
        probeFailed = false;
        if (wrapper.onclose) wrapper.onclose(e);
        resolve({ openMs: openedAt ? Date.now() - openedAt : -1, wasClean });
      };
    });
  }

  async function run() {
    while (!closed) {
      // A heal/restart reload is navigating this page away. Pause rather than exit:
      // auth-heal's watchdog clears the flag if the meta-refresh silently fails, and the
      // tab must resume connecting rather than wedge forever.
      while (window.__deepsteveReloadPending && !closed) await sleep(500);
      if (closed) return;

      // The gate. No WebSocket exists until the server actually answers, so a restart or
      // an outage costs zero failed handshakes and never arms the browser-global delay.
      const up = await waitForServer(() => closed || !!window.__deepsteveReloadPending);
      if (closed) return;
      if (!up) continue; // a reload got flagged — go back and wait it out

      // /healthz is unauthenticated, so "server up" says nothing about our cookie. The
      // browser never exposes an upgrade's HTTP status (always 1006), so probe over HTTP:
      // a no-op unless the server is up but rejecting us, then one guarded reload.
      maybeHealAuth();

      const { openMs, wasClean } = await attemptConnect();
      if (closed) return;

      // A clean close is somebody's decision (server said goodbye, session is gone).
      // Reconnecting would fight it — same rule the old onclose guard used.
      if (wasClean) return;

      if (!isReconnecting) {
        isReconnecting = true;
        if (wrapper.onreconnecting) wrapper.onreconnecting();
      }

      // A stable connection dropped? Loop straight back — the gate does the waiting.
      // Failing to open (or dying right after opening) despite a healthy server needs a
      // delay of our own.
      if (openMs >= WS_STABLE_MS) {
        wsFailures = 0;
      } else {
        const delay = Math.min(WS_BACKOFF_BASE_MS * 2 ** wsFailures, WS_BACKOFF_MAX_MS);
        wsFailures++;
        await wait(jitter(delay));
      }
    }
  }

  liveWrappers.add(wrapper);
  // The loop spans the wrapper's whole life (while connected it's awaiting the socket's
  // close), so its completion — clean close or close() — is the retirement point.
  run().finally(() => liveWrappers.delete(wrapper));

  return wrapper;
}
