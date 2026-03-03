/**
 * Live reload on server restart.
 *
 * Opens a dedicated WebSocket to ?action=reload. The server sends
 * { type: 'reload' } during shutdown only when restart.sh --refresh is used.
 * On normal restart, the WS drops and we silently reconnect without refreshing.
 *
 * Restart confirmation flow (restart.sh --refresh):
 * 1. Server sends { type: 'confirm-restart' } BEFORE restarting
 * 2. Every tab shows a modal. When any tab confirms or skips, the decision is
 *    broadcast via BroadcastChannel so all tabs dismiss their modals together.
 * 3. The tab where the user clicked sends { type: 'restart-confirmed' } or
 *    { type: 'restart-declined' } back to the server.
 * 4. If confirmed, server proceeds with restart. All tabs show a spinner overlay
 *    while polling for the server to come back, then auto-refresh.
 */

export function initLiveReload({ onMessage, onShowRestartConfirm, onShowReloadOverlay, windowId } = {}) {
  let ws;
  let intentionallyClosed = false;
  let restartConfirmed = false;

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    ws = new WebSocket(wsProto + location.host + '?' + params);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'confirm-restart') {
          if (restartConfirmed) return; // Already handling
          handleRestartConfirm();
        } else if (msg.type === 'reload') {
          // Legacy reload message (during shutdown) — auto-refresh if restart was confirmed
          if (restartConfirmed) {
            window.__deepsteveReloadPending = true;
          }
        } else if (onMessage) {
          onMessage(msg);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (intentionallyClosed) return;
      if (restartConfirmed) {
        // User already confirmed restart — show overlay and poll for server
        console.log('[live-reload] restart confirmed, waiting for server to come back...');
        window.__deepsteveReloadPending = true;
        if (onShowReloadOverlay) onShowReloadOverlay();
        pollUntilReady();
      } else {
        console.log('[live-reload] server went away, reconnecting silently...');
        reconnectSilently();
      }
    };
  }

  function handleRestartConfirm() {
    const ch = new BroadcastChannel('deepsteve-ui-events');
    let remoteDecision = false;

    // Show modal in this tab
    const modal = onShowRestartConfirm
      ? onShowRestartConfirm()
      : { promise: Promise.resolve(true), dismiss: () => {} };

    // Listen for decision broadcast from another tab
    const onMsg = (e) => {
      if (e.data.type === 'reload-decision') {
        remoteDecision = true;
        ch.removeEventListener('message', onMsg);
        ch.close();
        modal.dismiss(e.data.confirmed);
      }
    };
    ch.addEventListener('message', onMsg);

    // When modal resolves (user clicked locally, or dismissed by remote broadcast)
    modal.promise.then(confirmed => {
      if (!remoteDecision) {
        // Local click — broadcast to other tabs and send response to server
        const bc = new BroadcastChannel('deepsteve-ui-events');
        bc.postMessage({ type: 'reload-decision', confirmed });
        setTimeout(() => bc.close(), 100);
        ch.removeEventListener('message', onMsg);
        ch.close();
        if (confirmed) {
          restartConfirmed = true;
          ws.send(JSON.stringify({ type: 'restart-confirmed' }));
        } else {
          ws.send(JSON.stringify({ type: 'restart-declined' }));
        }
      } else {
        // Remote decision — set flag but don't send to server (other tab already did)
        if (confirmed) restartConfirmed = true;
      }
    });
  }

  function pollUntilReady() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/home', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(interval);
          console.log('[live-reload] server is back, reloading...');
          location.reload();
        }
      } catch {
        // Server still down — keep polling
      }
    }, 500);
  }

  function reconnectSilently() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/home', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(interval);
          console.log('[live-reload] server is back, reconnecting WS...');
          connect();
        }
      } catch {
        // Server still down — keep polling
      }
    }, 500);
  }

  // Don't trigger reconnect polling when the user navigates away
  window.addEventListener('beforeunload', () => {
    intentionallyClosed = true;
    if (ws) ws.close();
  });

  connect();
}
