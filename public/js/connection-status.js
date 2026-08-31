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
 *  - setTabBlocked(tabId, on): the same slot in its "we are being refused"
 *    colour (#677). #676 made an auth failure visible page-wide; this says WHICH
 *    tabs it took down. A socket the gate declined to even emit — the server is
 *    up and has said over HTTP that it will reject our cookie — never closes,
 *    because it never opened, so noteReconnecting() below cannot describe it.
 *    Waiting will not fix it either, which is what separates the two states.
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
  setTabBlocked = () => {},
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
    // A blocked handle is excluded: its story is the auth banner's (#676), and counting it
    // here would put "reconnecting…" on screen for a connection that is not going to
    // reconnect. app.js suppresses the banner outright while auth is lost; this keeps the
    // count honest for the window before that suppression settles.
    const count = [...handles].filter(h => h.reconnecting && h.bannerEligible && !h.blocked).length;
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
      blocked: false,

      // Server assigned (or changed) the session id: move any live indicator
      // and end the isNew banner deferral — from here the connection is a
      // normal session and its outages belong to the reconnect banner.
      setSessionId(id) {
        if (handle.reconnecting && handle.tabId && handle.tabId !== id) {
          setTabIndicator(handle.tabId, false);
          setTabBlocked(handle.tabId, false);
        }
        const moved = handle.tabId !== id;
        handle.tabId = id;
        handle.bannerEligible = true;
        if (handle.reconnecting && moved) {
          if (handle.blocked) setTabBlocked(id, true);
          else setTabIndicator(id, true);
        }
        updateBanner();
      },

      noteReconnecting() {
        if (!handles.has(handle)) return; // socket of a closed tab can still fire
        handle.reconnecting = true;
        // A handshake actually went out this time, so whatever refused us before is no
        // longer the story — hand the tab slot back to the ordinary reconnecting paint.
        handle.blocked = false;
        if (handle.tabId) {
          setTabBlocked(handle.tabId, false);
          setTabIndicator(handle.tabId, true);
        }
        updateBanner();
      },

      noteReconnected() {
        if (!handles.has(handle)) return;
        handle.reconnecting = false;
        handle.blocked = false;
        if (handle.tabId) {
          setTabIndicator(handle.tabId, false);
          setTabBlocked(handle.tabId, false);
        }
        updateBanner();
      },

      // The gate refused to emit a handshake for this connection (#677). Also marks it
      // reconnecting, so a blocked connection still owns its tab slot and still clears
      // through the one path — but the blocked flag keeps it out of the banner count and
      // paints the slot in the refused colour instead.
      noteBlocked() {
        if (!handles.has(handle)) return;
        handle.blocked = true;
        handle.reconnecting = true;
        if (handle.tabId) {
          setTabIndicator(handle.tabId, false);
          setTabBlocked(handle.tabId, true);
        }
        updateBanner();
      },

      // Required on every deliberate teardown (close, send-to-window, gone,
      // cancel): wrapper.close() stops the retry loop without ever firing
      // onreconnected, so an untracked-less close mid-outage would pin the
      // banner forever.
      untrack() {
        if (!handles.delete(handle)) return;
        if (handle.reconnecting && handle.tabId) {
          setTabIndicator(handle.tabId, false);
          setTabBlocked(handle.tabId, false);
        }
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
