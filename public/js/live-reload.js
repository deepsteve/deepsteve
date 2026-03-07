/**
 * Live reload on server restart.
 *
 * Opens a dedicated WebSocket to ?action=reload. The server sends
 * { type: 'reload' } during shutdown only when restart.sh --refresh is used.
 * On normal restart, the WS drops and we silently reconnect without refreshing.
 *
 * Restart confirmation flow (restart.sh --refresh):
 * 1. Server sends { type: 'confirm-restart', totalWindows } BEFORE restarting
 * 2. Every window shows a modal. Each window confirms/declines independently.
 * 3. Each window sends { type: 'restart-confirmed' } or { type: 'restart-declined' }
 *    back to the server via its own WebSocket.
 * 4. Server tracks all responses. If all confirm → restart proceeds.
 *    If any declines → server sends { type: 'restart-cancelled' } to all.
 * 5. Server sends { type: 'restart-progress', confirmed, total } as windows confirm.
 * 6. When all confirmed, server proceeds with restart. All windows show spinner overlay
 *    while polling for the server to come back, then auto-refresh.
 */

export function initLiveReload({ onMessage, onShowRestartConfirm, onShowReloadOverlay, windowId } = {}) {
  let ws;
  let intentionallyClosed = false;
  let restartConfirmed = false;
  let currentModal = null;

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    ws = new WebSocket(wsProto + location.host + '?' + params);

    let lastPingTime = Date.now();
    let missedPingCheck;

    ws.onopen = () => {
      lastPingTime = Date.now();
      missedPingCheck = setInterval(() => {
        if (Date.now() - lastPingTime > 45000 && ws.readyState === WebSocket.OPEN) {
          console.log('[live-reload] no ping from server in 45s, reconnecting...');
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
          if (restartConfirmed) return; // Already handling
          handleRestartConfirm(msg.totalWindows);
        } else if (msg.type === 'restart-progress') {
          if (currentModal) currentModal.updateProgress(msg.confirmed, msg.total);
        } else if (msg.type === 'restart-cancelled') {
          restartConfirmed = false;
          if (currentModal) currentModal.dismiss(false);
          currentModal = null;
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
      if (missedPingCheck) clearInterval(missedPingCheck);
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

  function handleRestartConfirm(totalWindows) {
    const modal = onShowRestartConfirm
      ? onShowRestartConfirm(totalWindows)
      : { promise: Promise.resolve(true), dismiss: () => {}, updateStatus: () => {}, updateProgress: () => {} };

    currentModal = modal;

    modal.promise.then(confirmed => {
      if (confirmed) {
        restartConfirmed = true;
        ws.send(JSON.stringify({ type: 'restart-confirmed' }));
        if (totalWindows > 1) {
          modal.updateStatus('waiting');
          // Keep currentModal so progress updates can reach it
        } else {
          currentModal = null;
        }
      } else {
        currentModal = null;
        ws.send(JSON.stringify({ type: 'restart-declined' }));
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
