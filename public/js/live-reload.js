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
 * All windows show the confirmation modal. First response wins — the deciding
 * window sends restart-confirmed/declined to the server and broadcasts
 * restart-decided via BroadcastChannel to dismiss modals in other windows.
 */

import { nsChannel } from './storage-namespace.js';
import { maybeHealAuth, forcePageReload, noteAuthOk } from './auth-heal.js';
import { onWake } from './wake-watch.js';

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

  const restartChannel = new BroadcastChannel(nsChannel('deepsteve-restart'));

  // After a system sleep the last server ping may be minutes stale through no
  // fault of the server's (#563). Reset the watchdog so the just-woken server
  // gets one fresh ping period before we force-close the socket.
  onWake(() => { lastPingTime = Date.now(); });

  function setState(newState) {
    console.log(`[live-reload] ${state} → ${newState}`);
    state = newState;
  }

  function connect() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    ws = new WebSocket(wsProto + location.host + '?' + params);

    ws.onopen = () => {
      noteAuthOk();
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
          if (state === State.CONNECTED || state === State.CONFIRMED) showConfirmInAllWindows();
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
        // Public, unauthenticated readiness probe (#536): a cookieless tab (e.g. across the deploy
        // that first turns auth on) can still detect "server back up" and reload to acquire the cookie.
        const res = await fetch('/healthz', { cache: 'no-store' });
        if (res.ok) {
          reloading = true;
          console.log('[live-reload] server is back, reloading page...');
          forcePageReload(() => { reloading = false; });
        }
      } catch {}
    }, 500);
  }

  // --- Silent reconnect: poll until server is back, then reconnect WS ---

  function pollAndReconnect() {
    const interval = setInterval(async () => {
      try {
        // Public, unauthenticated readiness probe (#536): a cookieless tab (e.g. across the deploy
        // that first turns auth on) can still detect "server back up" and reload to acquire the cookie.
        const res = await fetch('/healthz', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(interval);
          console.log('[live-reload] server is back, reconnecting WS...');
          // /healthz is unauthenticated, so "server up" says nothing about our cookie. In a
          // window with zero terminal sessions this socket is the only reconnect loop, so it
          // must run the auth probe itself or a cookieless tab loops rejected upgrades forever.
          maybeHealAuth();
          connect();
        }
      } catch {}
    }, 500);
  }

  // --- Show modal in every window, first response wins ---

  function showConfirmInAllWindows() {
    setState(State.CONFIRMING);

    const modal = onShowRestartConfirm
      ? onShowRestartConfirm()
      : { promise: Promise.resolve(true), dismiss: () => {} };

    const onBroadcast = (event) => {
      if (event.data.type === 'restart-decided') {
        restartChannel.removeEventListener('message', onBroadcast);
        // Another window already responded — dismiss our modal and follow their decision
        modal.dismiss();
        if (event.data.confirmed) {
          setState(State.CONFIRMED);
          window.__deepsteveReloadPending = true;
        } else {
          setState(State.CONNECTED);
        }
      }
    };
    restartChannel.addEventListener('message', onBroadcast);

    modal.promise.then(confirmed => {
      restartChannel.removeEventListener('message', onBroadcast);
      if (state !== State.CONFIRMING) return; // another window already decided
      if (confirmed) {
        setState(State.CONFIRMED);
        window.__deepsteveReloadPending = true;
        ws.send(JSON.stringify({ type: 'restart-confirmed' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: true });
      } else {
        setState(State.CONNECTED);
        ws.send(JSON.stringify({ type: 'restart-declined' }));
        restartChannel.postMessage({ type: 'restart-decided', confirmed: false });
      }
    });
  }

  // Strip the ?_=<timestamp> cache-buster added by pollAndReload()'s meta-refresh
  // reload. It's only needed to bypass the HTTP cache during the reload; once
  // we're running, it just clutters the address bar.
  function stripCacheBuster() {
    const url = new URL(location.href);
    if (!url.searchParams.has('_')) return;
    url.searchParams.delete('_');
    const query = url.searchParams.toString();
    const clean = url.pathname + (query ? '?' + query : '') + url.hash;
    history.replaceState(null, '', clean);
  }
  stripCacheBuster();

  connect();
}
