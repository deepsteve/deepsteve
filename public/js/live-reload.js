/**
 * Live reload on server restart.
 *
 * Opens a dedicated WebSocket to ?action=reload. When the server restarts
 * (restart.sh, node --watch, etc.) the WS closes. We poll until the server
 * is back, then do a full page reload so the browser picks up new code.
 */

export function initLiveReload() {
  let ws;
  let intentionallyClosed = false;

  function connect() {
    ws = new WebSocket('ws://' + location.host + '?action=reload');

    ws.onclose = () => {
      if (intentionallyClosed) return;
      console.log('[live-reload] server went away, waiting for restart...');
      pollUntilReady();
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

  // Don't trigger reload polling when the user navigates away
  window.addEventListener('beforeunload', () => {
    intentionallyClosed = true;
    if (ws) ws.close();
  });

  connect();
}
