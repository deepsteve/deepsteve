/**
 * Live reload on server restart.
 *
 * Opens a dedicated WebSocket to ?action=reload. The server sends
 * { type: 'reload' } during shutdown only when restart.sh --refresh is used.
 * On normal restart, the WS drops and we silently reconnect without refreshing.
 *
 * Restart confirmation flow:
 * 1. Server sends { type: 'confirm-restart' } to all browser windows.
 * 2. Windows elect a single leader via BroadcastChannel (lowest windowId wins).
 * 3. The leader shows a modal. The user confirms or declines.
 * 4. Leader sends { type: 'restart-confirmed' } or { type: 'restart-declined' }
 *    back to the server via WebSocket. First response wins on the server side.
 * 5. Leader broadcasts the decision to other windows via BroadcastChannel.
 * 6. On WS close after confirmation, all windows show spinner overlay and poll
 *    for the server to come back, then auto-refresh.
 */

export function initLiveReload({ onMessage, onShowRestartConfirm, onShowReloadOverlay, windowId } = {}) {
  let ws;
  let intentionallyClosed = false;
  let restartConfirmed = false;
  let currentModal = null;

  // BroadcastChannel for leader election during restart confirmation
  const restartChannel = new BroadcastChannel('deepsteve-restart');

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
          electLeaderAndConfirm();
        } else if (msg.type === 'reload') {
          // Reload message during shutdown — auto-refresh if restart was confirmed
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

  /**
   * Leader election: all windows broadcast a claim with their windowId.
   * After 200ms, the lowest windowId wins and shows the modal.
   * Non-leaders wait for the leader's decision via BroadcastChannel.
   */
  function electLeaderAndConfirm() {
    if (restartConfirmed) return;

    const claims = new Set();
    if (windowId) claims.add(windowId);

    // Broadcast our claim
    restartChannel.postMessage({ type: 'restart-claim', windowId });

    // Listen for other claims and the leader's decision
    let electionTimer = null;
    let leaderFallbackTimer = null;
    let elected = false;

    const onElectionMessage = (event) => {
      const data = event.data;
      if (data.type === 'restart-claim') {
        claims.add(data.windowId);
        // Reset election timer — wait for all claims to arrive
        if (electionTimer) clearTimeout(electionTimer);
        electionTimer = setTimeout(runElection, 200);
      } else if (data.type === 'restart-decided') {
        // Leader has decided — apply the result
        cleanup();
        if (data.confirmed) {
          restartConfirmed = true;
        }
      } else if (data.type === 'restart-leader-gone') {
        // Leader closed during prompt — re-elect
        cleanup();
        electLeaderAndConfirm();
      }
    };

    restartChannel.addEventListener('message', onElectionMessage);

    function cleanup() {
      restartChannel.removeEventListener('message', onElectionMessage);
      if (electionTimer) clearTimeout(electionTimer);
      if (leaderFallbackTimer) clearTimeout(leaderFallbackTimer);
      elected = true;
    }

    function runElection() {
      if (elected) return;
      const sorted = [...claims].sort();
      const isLeader = sorted[0] === windowId;

      if (isLeader) {
        cleanup();
        handleRestartConfirm();
      } else {
        // Non-leader: wait for leader's decision with a 5s fallback
        leaderFallbackTimer = setTimeout(() => {
          // Leader didn't respond — re-elect
          restartChannel.removeEventListener('message', onElectionMessage);
          elected = true;
          electLeaderAndConfirm();
        }, 5000);
      }
    }

    // Start election timer
    electionTimer = setTimeout(runElection, 200);
  }

  function handleRestartConfirm() {
    const modal = onShowRestartConfirm
      ? onShowRestartConfirm()
      : { promise: Promise.resolve(true), dismiss: () => {} };

    currentModal = modal;

    // If leader window is closing, notify other windows to re-elect
    const onBeforeUnload = () => {
      restartChannel.postMessage({ type: 'restart-leader-gone' });
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    modal.promise.then(confirmed => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      currentModal = null;
      if (confirmed) {
        restartConfirmed = true;
        ws.send(JSON.stringify({ type: 'restart-confirmed' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: true });
      } else {
        ws.send(JSON.stringify({ type: 'restart-declined' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: false });
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
          restartConfirmed = false; // Reset so future restart prompts aren't blocked
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
