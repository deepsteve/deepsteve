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
 *
 * Connecting is a LOOP (#674), the same shape ws-client.js has had since #553, and for the
 * same reason. What was here before: the first connect() fired blind at page load, and
 * every failure re-entered through pollAndReconnect() with no failure accounting and no
 * delay at all — so a server that was up but rejecting our cookie produced a fresh doomed
 * handshake every fetch round trip, forever. Roughly fourteen of those pin Firefox's
 * browser-global FailDelay entry at its 60s cap, which then silences every OTHER socket in
 * the browser: the loop poisons the page and then goes quiet, because its own handshakes
 * stop reaching the server too. Read ws-open.js's header for the mechanism.
 */

import { nsChannel, nsKey } from './storage-namespace.js';
import { forcePageReload, noteAuthOk } from './auth-heal.js';
import { onWake } from './wake-watch.js';
import { waitForServer, probeStats, sleep } from './server-probe.js';
import { attachClientLogSender, clientLog } from './client-log.js';
import { openGatedSocket, backoffDelay, WS_STABLE_MS } from './ws-open.js';

// Handoff for the reload-timing beacon below. sessionStorage because it has to survive
// exactly one navigation — the one we are about to cause — and nothing longer.
const RELOAD_TRACE_KEY = 'deepsteve-reload-trace';

const State = {
  DISCONNECTED: 'disconnected',
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
  let wsFailures = 0;
  // Set when the page hands itself over to pollAndReload(): a navigation is coming and
  // this loop must not open another socket in front of it.
  let stopped = false;

  // The error beacon rides this socket (it must work when fetch doesn't).
  // `ws` is reassigned on every reconnect, so hand over a getter, not the socket.
  attachClientLogSender(() => ws);

  const restartChannel = new BroadcastChannel(nsChannel('deepsteve-restart'));

  // After a system sleep the last server ping may be minutes stale through no
  // fault of the server's (#563). Reset the watchdog so the just-woken server
  // gets one fresh ping period before we force-close the socket.
  onWake(() => { lastPingTime = Date.now(); });

  function setState(newState) {
    console.log(`[live-reload] ${state} → ${newState}`);
    state = newState;
  }

  function reloadUrl() {
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const params = 'action=reload' + (windowId ? '&windowId=' + encodeURIComponent(windowId) : '');
    return wsProto + location.host + '?' + params;
  }

  // Guarded control-plane send. `ws` is undefined until the gate first opens and can be a
  // closed socket mid-reconnect; the bare ws.send() this replaces only ever worked because
  // connect() used to assign the socket synchronously.
  function sendCtl(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /**
   * Wire one socket and resolve when it closes, so a single turn of runReload() spans that
   * socket's whole life. Resolves { openMs, terminal }; `terminal` means the page has been
   * handed to pollAndReload() and the loop must not open anything in front of it.
   *
   * Every handler and the ping timer close over `sock`, never the module-scoped `ws`. That
   * matters now the loop can be re-entered across an await: an interval armed for one
   * socket would otherwise force-close a newer one.
   */
  function wireSocket(sock) {
    return new Promise((resolve) => {
      let openedAt = 0;
      // Before any handler: client-log.js's sender reads this getter on its own 3s
      // interval, which can land at any moment from here on.
      ws = sock;

      const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

      sock.onopen = () => {
        openedAt = Date.now();
        noteAuthOk();
        setState(State.CONNECTED);
        lastPingTime = Date.now();
        stopPing();
        pingTimer = setInterval(() => {
          if (Date.now() - lastPingTime > 45000 && sock.readyState === WebSocket.OPEN) {
            console.log('[live-reload] no ping in 45s, reconnecting...');
            sock.close();
          }
        }, 45000);
      };

      sock.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ping') {
            lastPingTime = Date.now();
            sock.send(JSON.stringify({ type: 'pong' }));
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

      sock.onclose = () => {
        stopPing();
        const openMs = openedAt ? Date.now() - openedAt : -1;

        if (state === State.CONFIRMED || state === State.RELOADING) {
          // Restart was confirmed — wait for server and reload
          window.__deepsteveReloadPending = true;
          setState(State.RELOADING);
          if (onShowReloadOverlay) onShowReloadOverlay();
          stopped = true;
          pollAndReload();
          resolve({ openMs, terminal: true });
          return;
        }

        setState(State.RECONNECTING);
        resolve({ openMs, terminal: false });
      };
    });
  }

  /**
   * One socket at a time, for the life of the page. This replaces the old
   * connect()/pollAndReconnect() pair, whose cycle had no delay of any kind — see the
   * module header for what that cost.
   */
  async function runReload() {
    while (!stopped) {
      // A heal/restart reload is navigating this page away. Park rather than exit:
      // auth-heal's watchdog clears the flag if the meta-refresh silently fails, and the
      // tab must resume connecting rather than wedge forever. Same contract as
      // ws-client.js's loop, which live-reload had no equivalent of.
      while (window.__deepsteveReloadPending && !stopped) await sleep(500);
      if (stopped) return;

      const { socket, reason } = await openGatedSocket(reloadUrl(), {
        shouldStop: () => stopped || !!window.__deepsteveReloadPending,
        label: 'reload',
      });
      if (stopped) { try { socket?.close(); } catch {} return; }
      if (!socket) {
        // 'unauthed': the server is up and has told us it will reject this upgrade.
        // Sending it anyway, at fetch speed, is the loop this whole rewrite exists to
        // remove. 'stopped' parks at the top of the loop and needs no delay.
        if (reason === 'unauthed') await sleep(backoffDelay(wsFailures++));
        continue;
      }
      if (state === State.RECONNECTING) console.log('[live-reload] server is back, reconnecting WS...');

      const { openMs, terminal } = await wireSocket(socket);
      if (terminal) return; // pollAndReload() owns the page from here
      if (openMs >= WS_STABLE_MS) wsFailures = 0;
      else await sleep(backoffDelay(wsFailures++));
    }
  }

  // --- Reload: wait for the server to come back, then force-reload the page ---

  // Both paths below use the shared waitForServer() probe (#553) rather than their own
  // setInterval. It still leans on /healthz being a public, unauthenticated readiness
  // probe (#536): a cookieless tab (e.g. across the deploy that first turns auth on) can
  // detect "server back up" and reload to acquire the cookie.

  async function pollAndReload() {
    const closedAt = Date.now();
    const before = probeStats();
    for (;;) {
      await waitForServer();
      console.log('[live-reload] server is back, reloading page...');
      stashReloadTrace(closedAt, before);
      // Settles only if forcePageReload's watchdog fires (the meta-refresh didn't
      // navigate). On success the page is gone and this never resolves — so looping is
      // just the old code's re-arm, without an interval left running behind it.
      await new Promise(resolve => forcePageReload(resolve));
    }
  }

  // --- Reload timing attribution ---
  //
  // On 2026-08-31 a restart had the daemon listening 0.4s after node start and the first
  // browser window back at +59.4s. server.js's [startup] marks bound that gap but cannot
  // see inside it, and the page that could was replaced by the reload it was waiting for.
  // So: the outgoing page writes down how its wait went, and the page it produces reports
  // that over the client-log beacon, where it lands in the daemon log next to the marks.
  //
  // The three numbers split the gap at its two real seams — the gate (did we notice the
  // server was back?) and the navigation (did the new page start once we did?) — which is
  // the difference between a wedged probe, a throttled timer, and a stalled page load.

  function stashReloadTrace(closedAt, before) {
    const after = probeStats();
    try {
      sessionStorage.setItem(nsKey(RELOAD_TRACE_KEY), JSON.stringify({
        gateMs: Date.now() - closedAt,
        probes: after.probes - before.probes,
        slowestProbeMs: after.slowestProbeMs,
        // A hidden tab has its timers throttled to roughly 1/min, which is an innocent
        // explanation for a ~60s gate. Recording it is what makes that distinguishable
        // from a probe that hung with the tab in the foreground.
        hidden: document.visibilityState === 'hidden',
        handoffAt: Date.now(),
      }));
    } catch {}
  }

  function reportPreviousReload() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(nsKey(RELOAD_TRACE_KEY));
      // Read once. A trace left behind would be re-reported on every later reload of this
      // tab, and a stale number is worse than no number.
      sessionStorage.removeItem(nsKey(RELOAD_TRACE_KEY));
    } catch {}
    if (!raw) return;
    try {
      const t = JSON.parse(raw);
      // timeOrigin is the new document's own start, so this is strictly the navigation:
      // meta-refresh → request → response. performance.now() is everything after it.
      const navMs = Math.max(0, Math.round(performance.timeOrigin - t.handoffAt));
      const bootMs = Math.round(performance.now());
      clientLog('reload-timing',
        `gate ${t.gateMs}ms (${t.probes} probe(s), slowest ${t.slowestProbeMs}ms` +
        `${t.hidden ? ', tab hidden' : ''}) + nav ${navMs}ms + boot ${bootMs}ms`);
    } catch {}
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
        sendCtl({ type: 'restart-confirmed' });
        restartChannel.postMessage({ type: 'restart-decided', confirmed: true });
      } else {
        setState(State.CONNECTED);
        sendCtl({ type: 'restart-declined' });
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
  // Before the loop starts: the beacon queues until the socket it rides is open anyway,
  // and this way the trace is cleared even if the socket never comes up.
  reportPreviousReload();

  // The first connect goes through the same gate as every later one. It used to be the
  // exception — one blind handshake per page load, landing in exactly the window where the
  // daemon is least likely to be listening (a machine reboot restores this tab before the
  // LaunchAgent is up), and one entry poisons every socket in the browser.
  runReload();
}
