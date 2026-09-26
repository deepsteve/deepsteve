/**
 * The parts of the Backlog section that break invisibly (#671).
 *
 * Same contract as inbox-view.js: a browser ES module with zero imports, no DOM and no
 * globals, so node:test can drive it with `await import()`. Nothing here polls, fetches
 * or holds React state.
 *
 * Two behaviours, and the reason each is here rather than left to review:
 *
 *   compareIssues — must be a TOTAL order. The list is refetched under a live cursor,
 *   and two issues touched in the same minute carry the same `updatedAt` from GitHub
 *   often enough to matter. Without the number tiebreak they swap places on a refresh
 *   and the cursor appears to jump on its own.
 *
 *   formatUpdated — deliberately NOT inbox-view's formatAge. That one measures how long
 *   an agent has been WAITING and colours 30s amber, 60s red. A backlog row's clock
 *   measures when a human last touched the issue, where a day is unremarkable; reusing
 *   the urgency scale would paint every row red the moment it was written.
 */

/**
 * Freshest first, then highest number.
 *
 * The number tiebreak is what makes the order total — see the header. Descending on
 * both, because "what changed most recently" is the question you are asking when you
 * open a backlog, and a higher number is the newer issue when nothing else separates
 * them.
 */
export function compareIssues(a, b) {
  const ua = (a && a.updatedAt) || 0;
  const ub = (b && b.updatedAt) || 0;
  if (ua !== ub) return ub - ua;
  return ((b && b.number) || 0) - ((a && a.number) || 0);
}

export function sortIssues(issues) {
  return (Array.isArray(issues) ? issues : []).filter(Boolean).slice().sort(compareIssues);
}

/**
 * What the Backlog renders, and its slice of the keyboard `order`.
 *
 * A collapsed section contributes NO ids. That is the whole mechanism behind collapse:
 * the section keeps rendering its header, but ↑/↓ cannot walk into rows nobody can see,
 * and `nextSelection` moves the cursor out of the section on its own when the ids it was
 * sitting on disappear.
 */
export function visibleBacklog(issues, { collapsed = false } = {}) {
  const list = sortIssues(issues);
  return { list, order: collapsed ? [] : list.map((i) => i.id) };
}

/**
 * 'just now' '4m' '3h' '2d' '5w' — how long since anyone touched the issue.
 *
 * Coarse on purpose. A backlog row's age is context, not a countdown, and a seconds
 * display on a list that refreshes every two minutes would be wrong most of the time it
 * was on screen.
 */
export function formatUpdated(updatedAt, now = Date.now()) {
  const t = Number(updatedAt);
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/**
 * The one-line note under a row: which tab is already on this, if any.
 *
 * `null` — not an empty string — when nothing matches, because "no tab yet" is the state
 * the whole view exists to make visible and it is shown by the ABSENCE of this line, not
 * by a line saying so. A row that spells out "no tab" for every unstarted issue turns the
 * useful default into visual noise.
 */
export function matchNote(issue) {
  const matched = (issue && issue.matched) || [];
  if (!matched.length) return null;
  const first = matched[0];
  const name = first.sessionName || first.sessionId || 'a session';
  const extra = matched.length > 1 ? ` +${matched.length - 1}` : '';
  return { text: `${name}${extra}`, exact: first.matchedBy === 'worktree' };
}
