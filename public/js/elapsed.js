/**
 * Elapsed-time formatting for a wait that is still going (#681).
 *
 * Distinct from relativeTime() below and app.js's formatRelativeTime(), which say
 * "how long ago" in whole minutes/hours — too coarse for a banner whose whole job is
 * to keep ticking while someone watches it.
 *
 * Two deliberate choices:
 *  - Math.floor throughout, so the value is monotonic and never jumps backward.
 *  - No hour tier. A wait that reads `75m 13s` is absurd, and that absurdity is the
 *    honest signal; `1h 15m` reads tidier than the situation is.
 */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * "How long ago", in the largest whole unit: `just now`, `5m ago`, `3h ago`, `2d ago`.
 * Shared by app.js's lists and the tab bar's "Reopen closed tab" submenu (#723).
 */
export function relativeTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
