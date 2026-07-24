/**
 * The single definition of "open a new deepsteve window" (#597).
 *
 * The ▾ new-tab menu and the command palette had drifted: only one of them
 * appended ?fresh=1. That matters because window.open() from a same-origin page
 * COPIES the opener's sessionStorage — which is where deepsteve-window-id
 * (window-manager.js) and deepsteve-tab-sessions (session-stores.js) live. So a
 * new window opened without the flag booted holding its parent's window id AND
 * its parent's tab list, took the "existing tab with sessions" branch in init(),
 * and restored the parent's tabs into a second window. Since the server
 * reassigns entry.windowId whenever a session websocket connects, the two
 * windows then fought over the same PTYs.
 *
 * The query flag, not the browser, is the mechanism. 'noopener' happens to
 * suppress the sessionStorage copy in Chrome, but it is not specified to, and
 * Safari treats a non-empty features string as a request for a popup-shaped
 * window — that would trade a data bug for chrome-less windows. So: a plain
 * two-argument window.open plus a flag the receiving page always honors, which
 * is correct whether or not the copy happened.
 */

export const FRESH_PARAM = 'fresh';

/**
 * Note this keeps location.pathname: both old call sites used bare
 * location.origin, which silently dropped the path if deepsteve were ever
 * mounted under a prefix. It also keeps this symmetric with the
 * history.replaceState(null, '', location.pathname) cleanup init() does after
 * consuming the flag.
 */
export function newWindowUrl(loc = window.location) {
  return `${loc.origin}${loc.pathname}?${FRESH_PARAM}=1`;
}

export function openNewWindow() {
  // Deliberately two arguments — see the 'noopener' note in the file header.
  return window.open(newWindowUrl(), '_blank');
}

/** Presence, not truthiness: a bare `?fresh` must work too. */
export function isFreshRequest(search = window.location.search) {
  return new URLSearchParams(search).get(FRESH_PARAM) !== null;
}
