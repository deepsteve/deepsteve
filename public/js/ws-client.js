/**
 * WebSocket client wrapper with auto-reconnect.
 *
 * Every connect — including the first — goes through openGatedSocket() in ws-open.js,
 * which is the only place in the client that constructs a WebSocket (#553, #674). Read
 * that module's header for why: a handshake we don't expect to succeed arms a
 * browser-global FailDelay entry that silences every other socket in the browser for up to
 * a minute, and no backoff schedule can undo it. The old loop here was a flat 1Hz
 * setInterval firing `new WebSocket(url)` blindly, per socket, per tab, per nesting level.
 *
 * What stays this module's own job is the *shape* of one socket's life: minting an id so a
 * create retry is idempotent, rewriting the URL once the server assigns a session, the
 * wake probe, and deciding whether a close deserves a retry at all.
 */

import { noteAuthOk } from './auth-heal.js';
import { onWake } from './wake-watch.js';
import { sleep } from './server-probe.js';
import { openGatedSocket, backoffDelay, WS_STABLE_MS } from './ws-open.js';

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
  // #596: this connect is acting on a server-pushed open-session, not a restore
  // request. Tells the server not to resurrect a #561 closed tombstone if the
  // session died between the pendingOpens flush and this connect.
  if (options.noRestore) params.set('noRestore', '1');

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
      // #603: this is the URL every *passive* reconnect re-dials. A session that was
      // cleared while we were disconnected is a closed tombstone server-side, and
      // reconnecting with its id would resurrect it and respawn the agent. Ask the
      // server to answer `gone` instead. Deliberately NOT set on createWebSocket()'s
      // initial URL — dropdown clicks, the session-restore modal (#560) and page-reload
      // restores are explicit user intent and must still be able to resume a tombstone.
      p.set('noRestore', '1');
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
  // kickWait. (The gate's own waits live inside waitForServer, which since #665 subscribes
  // to the same wake signal and kicks itself — so both halves of the loop wake together.)
  function wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); kickWait = null; resolve(); }
      kickWait = done;
    });
  }

  /**
   * One socket, start to finish. Takes the socket the gate handed us and resolves when it
   * closes — so a single loop iteration below spans the socket's whole life and the
   * initial connect is not a special case.
   *
   * Deliberately never aborts a CONNECTING socket: a stall means either the server's event
   * loop is briefly blocked (the handshake is about to succeed) or Firefox has us queued
   * behind another tab, and aborting would discard a nearly-live connection and re-enter
   * the admission queue at the back. At most one socket in flight, never stacked.
   */
  function attemptConnect(sock) {
    return new Promise((resolve) => {
      let openedAt = 0;
      ws = sock;

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

      // The gate. No WebSocket exists until the server has answered /healthz AND told us
      // over HTTP that it will accept our cookie, so a restart or an outage costs zero
      // failed handshakes and never arms the browser-global delay.
      const { socket, reason } = await openGatedSocket(url, {
        shouldStop: () => closed || !!window.__deepsteveReloadPending,
        label: options.action || 'session',
      });
      if (closed) {
        // close() can land inside the gate's awaits. Nothing else owns this socket, so
        // leaving it open would hold a server-side session client forever — and for an
        // isNew wrapper, spawn a shell for a create the caller just cancelled.
        try { socket?.close(); } catch {}
        return;
      }
      if (!socket) {
        // 'unauthed' means the server is up and we KNOW the upgrade would be rejected.
        // Retrying it immediately is the hot loop that pins FailDelay at its cap, so pace
        // it — the heal reload usually resolves this within a couple of seconds anyway.
        // 'stopped' needs no delay: the top of the loop parks on the reload flag.
        if (reason === 'unauthed') await wait(backoffDelay(wsFailures++));
        continue;
      }

      const { openMs, wasClean } = await attemptConnect(socket);
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
        await wait(backoffDelay(wsFailures++));
      }
    }
  }

  liveWrappers.add(wrapper);
  // The loop spans the wrapper's whole life (while connected it's awaiting the socket's
  // close), so its completion — clean close or close() — is the retirement point.
  run().finally(() => liveWrappers.delete(wrapper));

  return wrapper;
}
