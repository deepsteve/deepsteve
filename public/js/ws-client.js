/**
 * WebSocket client wrapper with auto-reconnect
 */

import { maybeHealAuth, noteAuthOk } from './auth-heal.js';
import { onWake } from './wake-watch.js';

// After a system sleep a socket can be dead-but-OPEN: the browser hasn't fired
// onclose yet, so the reconnect loop never starts (#563). On a wake signal we
// probe every open socket with {type:'ping'} and force-close it if nothing
// comes back, and kick sockets that are already reconnecting immediately
// instead of waiting out the retry interval.
const PROBE_TIMEOUT_MS = 5000;
const liveWrappers = new Set();

onWake(() => {
  if (window.__deepsteveReloadPending) return; // same contract as the retry loop
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
  let ws;
  let reconnectTimer = null;
  let isReconnecting = false;
  let probeTimer = null;
  let probeStartedAt = 0;
  let probeFailed = false;

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
    get readyState() { return ws.readyState; },

    // Set by the caller when the server's session message advertises pingPong
    // support — never send probes to a server that would type them into the PTY.
    serverSupportsPing: false,

    send(data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },

    sendJSON(obj) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    },

    close() {
      liveWrappers.delete(wrapper);
      clearInterval(reconnectTimer);
      clearProbe();
      ws.close();
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

    // Wake handling (#563): kick a pending reconnect immediately, or verify an
    // OPEN socket really survived the sleep.
    _onWake() {
      if (isReconnecting) {
        retryNow();
        return;
      }
      if (ws.readyState === WebSocket.OPEN && wrapper.serverSupportsPing && !probeStartedAt) {
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

  function retryNow() {
    if (window.__deepsteveReloadPending) return; // stop churn while a heal-reload navigates
    // The browser can't see WHY an upgrade failed (always close code 1006), so probe over
    // HTTP: no-op unless the server is up but rejecting our auth, then one guarded reload.
    maybeHealAuth();
    if (ws.readyState === WebSocket.CLOSED) {
      connect();
    }
  }

  function connect() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      noteAuthOk();
      if (isReconnecting) {
        isReconnecting = false;
        clearInterval(reconnectTimer);
        reconnectTimer = null;
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
      // Start reconnecting if not already. A dead socket we force-closed after
      // a failed probe can report wasClean=true, so probeFailed also counts.
      if (!isReconnecting && (probeFailed || !e.wasClean) && !window.__deepsteveReloadPending) {
        isReconnecting = true;
        if (wrapper.onreconnecting) wrapper.onreconnecting();

        reconnectTimer = setInterval(retryNow, 1000);
      }
      probeFailed = false;

      if (wrapper.onclose) wrapper.onclose(e);
    };
  }

  connect();
  liveWrappers.add(wrapper);

  return wrapper;
}
