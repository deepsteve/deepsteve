/**
 * Live reload on server restart.
 *
 * Opens a dedicated WebSocket to ?action=reload. The server sends
 * { type: 'reload' } during shutdown only when restart.sh --refresh is used.
 * On normal restart, the WS drops and we silently reconnect without refreshing.
 *
 * Restart confirmation flow (restart.sh --refresh):
 * 1. Server sends { type: 'confirm-restart' } BEFORE restarting
 * 2. Browser shows modal via onShowRestartConfirm (returns Promise<boolean>)
 * 3. Browser sends { type: 'restart-confirmed' } or { type: 'restart-declined' }
 * 4. If confirmed, server proceeds with restart. Browser auto-refreshes on reconnect.
 */

export function initLiveReload({ onMessage, onShowRestartConfirm, windowId } = {}) {
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
          // Server is asking for restart confirmation (pre-restart)
          if (onShowRestartConfirm) {
            onShowRestartConfirm().then(confirmed => {
              if (confirmed) {
                restartConfirmed = true;
                ws.send(JSON.stringify({ type: 'restart-confirmed' }));
              } else {
                ws.send(JSON.stringify({ type: 'restart-declined' }));
              }
            });
          } else {
            // No confirm callback — auto-confirm
            restartConfirmed = true;
            ws.send(JSON.stringify({ type: 'restart-confirmed' }));
          }
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
        // User already confirmed restart — go straight to polling for server
        console.log('[live-reload] restart confirmed, waiting for server to come back...');
        window.__deepsteveReloadPending = true;
        pollUntilReady();
      } else {
        console.log('[live-reload] server went away, reconnecting silently...');
        reconnectSilently();
      }
    };
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
