/**
 * Live reload on server restart.
 *
 * State machine:
 *   CONNECTED → (server sends confirm-restart) → CONFIRMING
 *   CONFIRMING → (user confirms) → CONFIRMED → (WS closes) → RELOADING
 *   CONFIRMING → (user declines) → CONNECTED
 *   CONNECTED → (WS closes unexpectedly) → RECONNECTING → (server back) → CONNECTED
 *   RELOADING → (server back) → page reload
 *
 * Leader election: when multiple windows exist, lowest windowId shows the modal.
 */

const State = {
  CONNECTED: 'connected',
  CONFIRMING: 'confirming',
  CONFIRMED: 'confirmed',
  RELOADING: 'reloading',
  RECONNECTING: 'reconnecting',
};

export function initLiveReload({ onMessage, onShowRestartConfirm, onShowReloadOverlay, windowId } = {}) {
  let ws;
  let state = State.DISCONNECTED;
  let pingTimer = null;
  let lastPingTime = 0;

  const restartChannel = new BroadcastChannel('deepsteve-restart');

  function setState(newState) {
    console.log(`[live-reload] ${state} → ${newState}`);
    state = newState;
  }

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    ws = new WebSocket(wsProto + location.host + '?' + params);

    ws.onopen = () => {
      setState(State.CONNECTED);
      lastPingTime = Date.now();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastPingTime > 45000 && ws.readyState === WebSocket.OPEN) {
          console.log('[live-reload] no ping in 45s, reconnecting...');
          ws.close();
        }
      }, 45000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          lastPingTime = Date.now();
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'confirm-restart') {
          if (state === State.CONNECTED) electLeaderAndConfirm();
        } else if (msg.type === 'reload') {
          // Server is about to shut down with --refresh — mark for reload
          if (state === State.CONFIRMED) {
            window.__deepsteveReloadPending = true;
          }
        } else if (onMessage) {
          onMessage(msg);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

      if (state === State.CONFIRMED || state === State.RELOADING) {
        // Restart was confirmed — wait for server and reload
        window.__deepsteveReloadPending = true;
        setState(State.RELOADING);
        if (onShowReloadOverlay) onShowReloadOverlay();
        pollAndReload();
      } else {
        // Unexpected disconnect — always reconnect
        setState(State.RECONNECTING);
        pollAndReconnect();
      }
    };
  }

  // --- Reload: poll until server is back, then force-reload the page ---

  function pollAndReload() {
    let reloading = false;
    setInterval(async () => {
      if (reloading) return;
      try {
        const res = await fetch('/api/home', { cache: 'no-store' });
        if (res.ok) {
          reloading = true;
          console.log('[live-reload] server is back, reloading page...');
          // Use <meta http-equiv="refresh"> instead of location.reload().
          // Firefox blocks location.reload() when ANY beforeunload handler is
          // registered, regardless of what the handler does. Meta refresh
          // bypasses beforeunload entirely.
          const meta = document.createElement('meta');
          meta.httpEquiv = 'refresh';
          meta.content = '0';
          document.head.appendChild(meta);
        }
      } catch {}
    }, 500);
  }

  // --- Silent reconnect: poll until server is back, then reconnect WS ---

  function pollAndReconnect() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/home', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(interval);
          console.log('[live-reload] server is back, reconnecting WS...');
          connect();
        }
      } catch {}
    }, 500);
  }

  // --- Leader election ---

  function electLeaderAndConfirm() {
    setState(State.CONFIRMING);

    const claims = new Set();
    if (windowId) claims.add(windowId);
    restartChannel.postMessage({ type: 'restart-claim', windowId });

    let electionTimer = null;
    let leaderFallbackTimer = null;
    let settled = false;

    const onMsg = (event) => {
      const data = event.data;
      if (data.type === 'restart-claim') {
        claims.add(data.windowId);
        if (electionTimer) clearTimeout(electionTimer);
        electionTimer = setTimeout(runElection, 200);
      } else if (data.type === 'restart-decided') {
        done();
        if (data.confirmed) setState(State.CONFIRMED);
        else setState(State.CONNECTED);
      } else if (data.type === 'restart-leader-gone') {
        done();
        electLeaderAndConfirm();
      }
    };

    restartChannel.addEventListener('message', onMsg);

    function done() {
      if (settled) return;
      settled = true;
      restartChannel.removeEventListener('message', onMsg);
      if (electionTimer) clearTimeout(electionTimer);
      if (leaderFallbackTimer) clearTimeout(leaderFallbackTimer);
    }

    function runElection() {
      if (settled) return;
      const sorted = [...claims].sort();
      if (sorted[0] === windowId) {
        done();
        showConfirmModal();
      } else {
        leaderFallbackTimer = setTimeout(() => {
          done();
          electLeaderAndConfirm();
        }, 5000);
      }
    }

    electionTimer = setTimeout(runElection, 200);
  }

  function showConfirmModal() {
    const modal = onShowRestartConfirm
      ? onShowRestartConfirm()
      : { promise: Promise.resolve(true), dismiss: () => {} };

    // If leader window closes during prompt, notify others to re-elect
    const onUnload = () => restartChannel.postMessage({ type: 'restart-leader-gone' });
    window.addEventListener('beforeunload', onUnload);

    modal.promise.then(confirmed => {
      window.removeEventListener('beforeunload', onUnload);
      if (confirmed) {
        setState(State.CONFIRMED);
        ws.send(JSON.stringify({ type: 'restart-confirmed' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: true });
      } else {
        setState(State.CONNECTED);
        ws.send(JSON.stringify({ type: 'restart-declined' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: false });
      }
    });
  }

  connect();
}
