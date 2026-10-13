/**
 * View footers — the client half.
 *
 * #view-footer is the monitor's bottom row, the mirror of the views bar on top. It describes
 * the tab you are looking at — its repo, the issue it is working, when that issue was opened,
 * and the issue's title with the start of its body — whenever that tab is in a view whose file
 * names a `footer` (the "Project views" section of mods/project-mods/tools.js). It follows the
 * TAB, not the selection: project-views.js's footerFor() answers for any tab in any project,
 * whichever view is selected. Hidden while the fullscreen view slot is up, because then no tab
 * is what you are looking at.
 *
 * The facts come from GET /api/project-views/footer/:sessionId and are kept per tab for
 * FRESH_MS, so flicking between tabs repaints from memory (the server caches the GitHub half
 * too). The row has a fixed height whether or not they have arrived: render() runs inside
 * switchTo(), before the incoming terminal is fitted, so the fit sees the row already in place
 * and a late answer never resizes the terminal a second time.
 *
 * Like project-views.js it never imports app.js; app.js injects what it needs.
 */

const FRESH_MS = 5 * 60 * 1000;

const facts = new Map();     // tab id → { at, data }
const fetching = new Set();  // tab ids with a request in flight
let cb = {};
let lastSig = null;

export function init(callbacks) {
  cb = callbacks || {};
  render();
}

/** Show, fill or hide the row for the active tab. Cheap: a signature skips a no-op pass. */
export function render() {
  const el = document.getElementById('view-footer');
  if (!el) return;
  const id = cb.isViewSlotUp?.() ? null : cb.getActiveTabId?.() || null;
  const footer = id ? cb.footerFor?.(id) : null;
  if (!footer) {
    paint(el, null);
    return;
  }
  const hit = facts.get(id);
  if (!hit || Date.now() - hit.at > FRESH_MS) load(id);
  // Asked, and nothing came back — a tab that is not a session (a display tab), or a request
  // that failed. There is nothing to say about it, so no row.
  if (hit && !hit.data && !fetching.has(id)) {
    paint(el, null);
    return;
  }
  paint(el, { id, fields: footer.fields, data: hit ? hit.data : null });
}

function load(id) {
  if (fetching.has(id)) return;
  fetching.add(id);
  fetch('/api/project-views/footer/' + encodeURIComponent(id))
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((data) => {
      fetching.delete(id);
      // A failure is remembered as "nothing to show" for the same window, so a tab that is
      // not a session does not turn every switch to it into a request.
      facts.set(id, { at: Date.now(), data });
      render();
    });
}

const DATE_FMT = { year: 'numeric', month: 'short', day: 'numeric' };

function link(text, href, cls) {
  const a = document.createElement(href ? 'a' : 'span');
  a.className = cls;
  a.textContent = text;
  if (href) {
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = href;
  }
  return a;
}

/** One cell per field the view asked for, in its order; a field with nothing to say is left out. */
function cellFor(field, data) {
  const issue = data && data.issue;
  if (field === 'repo') {
    if (!data || !data.repo || !data.repo.name) return null;
    return link(data.repo.name, data.repo.url, 'vf-cell vf-repo');
  }
  if (field === 'issue') {
    if (!issue) return null;
    return link(`#${issue.number}`, issue.url, 'vf-cell vf-issue');
  }
  if (field === 'date') {
    const when = issue && issue.createdAt ? new Date(issue.createdAt) : null;
    if (!when || Number.isNaN(when.getTime())) return null;
    const span = document.createElement('span');
    span.className = 'vf-cell vf-date';
    span.textContent = `Opened ${when.toLocaleDateString(undefined, DATE_FMT)}`;
    span.title = when.toLocaleString();
    return span;
  }
  if (field === 'title') {
    if (!issue || !issue.title) return null;
    const span = document.createElement('span');
    span.className = 'vf-cell vf-title';
    const strong = document.createElement('strong');
    strong.textContent = issue.title;
    span.appendChild(strong);
    if (issue.excerpt) {
      const rest = document.createElement('span');
      rest.className = 'vf-excerpt';
      rest.textContent = ` — ${issue.excerpt}`;
      span.appendChild(rest);
    }
    span.title = issue.excerpt ? `${issue.title}\n\n${issue.excerpt}` : issue.title;
    return span;
  }
  return null;
}

function paint(el, state) {
  const sig = JSON.stringify(state);
  if (sig === lastSig) return;
  lastSig = sig;
  el.classList.toggle('hidden', !state);
  document.getElementById('app-main')?.classList.toggle('view-footer-open', !!state);
  el.replaceChildren();
  if (!state) return;
  if (!state.data) {
    // Not here yet: hold the row's place rather than collapse it.
    const wait = document.createElement('span');
    wait.className = 'vf-cell vf-pending';
    wait.textContent = '…';
    el.appendChild(wait);
    return;
  }
  for (const field of state.fields) {
    const cell = cellFor(field, state.data);
    if (cell) el.appendChild(cell);
  }
}
