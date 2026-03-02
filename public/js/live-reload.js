/**
 * Live reload on server restart.
 *
 * Opens a dedicated WebSocket to ?action=reload. The server sends
 * { type: 'reload' } during shutdown only when restart.sh --refresh is used.
 * On normal restart, the WS drops and we silently reconnect without refreshing.
 *
 * When a reload message arrives, we show a browser confirmation modal via
 * onShowReloadConfirm (returns Promise<boolean>). The actual reload is deferred
 * until the user confirms. Session WebSockets reconnect normally while the
 * user decides — __deepsteveReloadPending is only set after confirmation.
 */

export function initLiveReload({ onMessage, onShowReloadConfirm, windowId } = {}) {
  let ws;
  let intentionallyClosed = false;
  let userDecisionPromise = null;

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    ws = new WebSocket(wsProto + location.host + '?' + params);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'reload') {
          // If a decision is already pending, ignore duplicate reload messages
          if (userDecisionPromise) return;
          // Show confirmation modal — don't set __deepsteveReloadPending yet
          // so session WebSockets reconnect normally while user decides
          if (onShowReloadConfirm) {
            userDecisionPromise = onShowReloadConfirm();
          } else {
            // No confirm callback — auto-confirm (backwards compat)
            userDecisionPromise = Promise.resolve(true);
          }
        } else if (onMessage) {
          onMessage(msg);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (intentionallyClosed) return;
      if (userDecisionPromise) {
        // User is deciding — wait for their choice
        userDecisionPromise.then(confirmed => {
          userDecisionPromise = null;
          if (confirmed) {
            console.log('[live-reload] user confirmed refresh, waiting for restart...');
            window.__deepsteveReloadPending = true;
            pollUntilReady();
          } else {
            console.log('[live-reload] user skipped refresh, reconnecting silently...');
            reconnectSilently();
          }
        });
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
