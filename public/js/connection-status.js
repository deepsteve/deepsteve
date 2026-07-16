/**
 * Per-connection reconnect-state tracker (#556).
 *
 * The old reconnect UI hung off the terminal container: it required a
 * `sessions` map entry (which doesn't exist until the first {type:'session'}
 * message) and a visible container (background tabs are display:none) — so it
 * showed nothing in exactly the failures that need feedback. This module
 * tracks connection state on a handle created at WebSocket-creation time,
 * before any session exists, and drives two DOM-agnostic outputs via injected
 * callbacks:
 *
 *  - setTabIndicator(tabId, on): per-tab dot, toggled immediately — works for
 *    background and placeholder tabs since it lives on the tab element.
 *  - renderBanner(count): one page-level "Connection lost" banner, shown only
 *    after graceMs of continuous outage (a ./restart.sh bounce reconnects on
 *    the first 1s retry; flashing a page banner for that trains users to
 *    ignore it) and hidden while suppressed (the pending-create banner from
 *    #563 sits in the same spot and already says "server unreachable").
 *    count 0 = hide.
 *
 * Brand-new creates are tracked with bannerEligible:false — pre-session their
 * outage belongs to the pending-create banner — and become eligible when
 * setSessionId() records the server-assigned id.
 */
export function createConnectionTracker({
  setTabIndicator,
  renderBanner,
  graceMs = 1500,
  isReloadPending = () => window.__deepsteveReloadPending,
} = {}) {
  const handles = new Set();
  let suppressed = false;
  let graceTimer = null;
  let graceElapsed = false; // latched for the whole outage episode
  let bannerCount = 0;      // last count passed to renderBanner (0 = hidden)

  function hideBanner() {
    if (bannerCount !== 0) {
      renderBanner(0);
      bannerCount = 0;
    }
  }

  function updateBanner() {
    const count = [...handles].filter(h => h.reconnecting && h.bannerEligible).length;
    if (count === 0) {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      graceElapsed = false;
      hideBanner();
      return;
    }
    // The grace timer runs from outage start even while suppressed, so when
    // the suppressing banner clears mid-outage this one appears immediately —
    // the outage is already proven non-transient.
    if (!graceElapsed && !graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        graceElapsed = true;
        updateBanner();
      }, graceMs);
    }
    if (!graceElapsed || suppressed || isReloadPending()) {
      hideBanner();
      return;
    }
    if (bannerCount !== count) {
      renderBanner(count);
      bannerCount = count;
    }
  }

  function track({ tabId = null, bannerEligible = true } = {}) {
    const handle = {
      tabId,
      bannerEligible,
      reconnecting: false,

      // Server assigned (or changed) the session id: move any live indicator
      // and end the isNew banner deferral — from here the connection is a
      // normal session and its outages belong to the reconnect banner.
      setSessionId(id) {
        if (handle.reconnecting && handle.tabId && handle.tabId !== id) {
          setTabIndicator(handle.tabId, false);
        }
        const moved = handle.tabId !== id;
        handle.tabId = id;
        handle.bannerEligible = true;
        if (handle.reconnecting && moved) setTabIndicator(id, true);
        updateBanner();
      },

      noteReconnecting() {
        if (!handles.has(handle)) return; // socket of a closed tab can still fire
        handle.reconnecting = true;
        if (handle.tabId) setTabIndicator(handle.tabId, true);
        updateBanner();
      },

      noteReconnected() {
        if (!handles.has(handle)) return;
        handle.reconnecting = false;
        if (handle.tabId) setTabIndicator(handle.tabId, false);
        updateBanner();
      },

      // Required on every deliberate teardown (close, send-to-window, gone,
      // cancel): wrapper.close() stops the retry loop without ever firing
      // onreconnected, so an untracked-less close mid-outage would pin the
      // banner forever.
      untrack() {
        if (!handles.delete(handle)) return;
        if (handle.reconnecting && handle.tabId) setTabIndicator(handle.tabId, false);
        updateBanner();
      },
    };
    handles.add(handle);
    return handle;
  }

  return {
    track,
    setSuppressed(on) {
      suppressed = !!on;
      updateBanner();
    },
    reconnectingCount() {
      return [...handles].filter(h => h.reconnecting).length;
    },
  };
}
