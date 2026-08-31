/**
 * Elapsed-time formatting for a wait that is still going (#681).
 *
 * Distinct from app.js's relativeTime()/formatRelativeTime(), which say "how long
 * ago" in whole minutes/hours — too coarse for a banner whose whole job is to keep
 * ticking while someone watches it.
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
