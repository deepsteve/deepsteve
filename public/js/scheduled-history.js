/**
 * Scheduled task run history (#633) — every schedule on this machine, in one grid.
 *
 * The ⏰ Scheduled panel can only ever show one repo's tasks at a time, one run
 * history at a time, in a 380px column. That answers "what does this task do";
 * it cannot answer "did all my automations run last night, and did any of them
 * quietly stop firing". This page is the second question.
 *
 * Vertical axis is the hierarchy (Project → repo → task), horizontal axis is run
 * recency, newest leftmost. Data comes whole from GET /api/scheduled-tasks/history
 * — the grouping is the server's job (it needs the filesystem to flag a repo whose
 * folder is gone, and it deliberately includes tombstoned tasks the panel hides).
 *
 * Lives in the TOP document, not an iframe: mod iframes get no theme-variable
 * injection at all, so a page built inside the Scheduled panel would be stuck on
 * hardcoded fallback colors. The cost is that the button which opens it lives on
 * the far side of an iframe boundary — see the focus note in open().
 */

let callbacks = {};
let isOpen = false;
let overlay = null;
let data = null;
let refreshTimer = null;
let inFlight = false;
// Selection is held as ids, never an index or an object: every scheduled-tasks
// broadcast replaces the whole payload, so a held reference goes stale the same
// way #613's `editing` did in the panel.
let selected = null; // { taskId, runKey } | null

// ----------------------------------------------------------------- vocabulary

// Mirrors StatusBadge in mods/scheduled-tasks/scheduled-tasks.jsx — the panel and
// this page must never disagree about what a status is called.
//
// Every cell carries a GLYPH as well as a color, because hue alone does not
// survive the shipped themes: win-95 maps --ds-accent-green-soft to blue and
// --ds-accent-blue to navy, which would collapse "succeeded" and "running" into
// two indistinguishable squares.
const STATUS_VISUALS = {
  queued: { cls: 'queued', glyph: '·', label: 'queued' },
  running: { cls: 'running', glyph: '▶', label: 'running' },
  started: { cls: 'running', glyph: '▶', label: 'running' },
  succeeded: { cls: 'ok', glyph: '✓', label: 'done' },
  completed: { cls: 'ok', glyph: '✓', label: 'done' },
  failed: { cls: 'bad', glyph: '✕', label: 'failed' },
  error: { cls: 'bad', glyph: '✕', label: 'error' },
  'timed-out': { cls: 'bad', glyph: '⏱', label: 'timed out' },
  ended: { cls: 'muted', glyph: '–', label: 'no report' },
};

/** Status → {cls, glyph, label}. Unknown statuses render, they never throw. */
export function statusVisual(status) {
  if (!status) return { cls: 'muted', glyph: '?', label: 'unknown' };
  return STATUS_VISUALS[status] || { cls: 'muted', glyph: '?', label: String(status) };
}

/**
 * How long a run took. `agentStartedAt` is when the agent engaged, which is the
 * honest start — the gap before it is session spawn + prompt delivery. Both it
 * and `endedAt` can be null on a run that never self-reported.
 */
export function formatDuration(run) {
  // Explicitly null-checked, not truthiness-checked: a timestamp is a number, and
  // "absent" is the only thing that should disqualify a run from having a duration.
  if (!run || run.endedAt == null) return null;
  const from = run.agentStartedAt != null ? run.agentStartedAt : run.startedAt;
  if (from == null) return null;
  const ms = run.endedAt - from;
  if (ms < 0) return null;
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

function relTime(ms) {
  if (!ms) return null;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'now';
  let s;
  if (mins < 60) s = `${mins}m`;
  else if (abs < 86400000) s = `${Math.round(abs / 3600000)}h`;
  else s = `${Math.round(abs / 86400000)}d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

function absTime(ms) { return ms ? new Date(ms).toLocaleString() : 'n/a'; }

// A run's identity is its sessionId; a row old enough to predate one falls back
// to its start time. Used only as a selection key, never shown.
function runKeyOf(run) { return run.sessionId || `t${run.startedAt}`; }

/**
 * A task's state when it has no runs to show — the three cases are different
 * problems and must not look alike. Only `never` is a bug signal.
 */
function idleState(task) {
  if (task.deleted) return { cls: 'muted', text: 'unscheduled' };
  if (task.once && task.firedAt) return { cls: 'muted', text: 'one-shot · done' };
  if (!task.enabled) return { cls: 'muted', text: 'paused' };
  return { cls: 'never', text: 'never run' };
}

// ------------------------------------------------------------------- fetching

async function load() {
  // Mod routes register after core's, so there is a brief post-boot window where
  // this path 404s with an HTML body — check ok before parsing, and never poll
  // (client-log.js beacons every >=400 response to the daemon log).
  const res = await fetch('/api/scheduled-tasks/history');
  if (!res.ok) throw new Error(`history unavailable (${res.status})`);
  return res.json();
}

/**
 * Re-fetch and repaint, but only while the page is open, and debounced.
 *
 * Two multipliers make that mandatory rather than tidy. broadcastTasks() fires on
 * every run-status transition, every timeout sweep and every mutating scheduler
 * tick; and app.js dispatches it from the PER-SESSION socket handler, so one
 * broadcast calls this once for every open tab. The debounce plus the in-flight
 * guard collapse all of that into a single fetch and a single rebuild.
 */
export function refresh() {
  if (!isOpen) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!isOpen || inFlight) return;
    inFlight = true;
    load()
      .then((d) => { data = d; if (isOpen) render(); })
      .catch(() => {}) // a transient failure keeps the last good grid on screen
      .finally(() => { inFlight = false; });
  }, 250);
}

// -------------------------------------------------------------------- opening

export async function open() {
  if (isOpen) return;
  isOpen = true;
  selected = null;
  build();
  try {
    data = await load();
  } catch (e) {
    data = { error: e.message };
  }
  if (isOpen) render();
}

export function close() {
  if (!isOpen) return;
  isOpen = false;
  clearTimeout(refreshTimer);
  selected = null;
  data = null;
  if (overlay) { overlay.remove(); overlay = null; }
  callbacks.focusTerminal?.();
}

export function isPageOpen() { return isOpen; }

function onKeyDown(e) {
  if (!isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    // Capture-phase stopPropagation, same as the shortcuts overlay: with a modal
    // also open, Esc closes only this page.
    e.stopPropagation();
    if (selected) { selected = null; render(); }
    else close();
  }
}

export function init(cbs) {
  callbacks = cbs || {};
  document.addEventListener('keydown', onKeyDown, true);
}

// --------------------------------------------------------------------- render

function build() {
  overlay = document.createElement('div');
  overlay.className = 'sched-hist-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const panel = document.createElement('div');
  panel.className = 'sched-hist';
  // Focusable, and focused on open: the click that opened this page happened
  // INSIDE the Scheduled panel's iframe, so without moving focus to the top
  // document our capture-phase Esc handler would never see a keydown.
  panel.tabIndex = -1;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => panel.focus());
}

function render() {
  if (!overlay) return;
  const panel = overlay.querySelector('.sched-hist');
  const prev = panel.querySelector('.sched-hist-body');
  const scroll = prev ? { top: prev.scrollTop, left: prev.scrollLeft } : null;
  panel.innerHTML = '';

  panel.appendChild(renderHeader());

  const body = document.createElement('div');
  body.className = 'sched-hist-body';
  // Clicking off an open run detail dismisses it. Cells and the popover itself
  // both stopPropagation, so this only ever fires on empty grid space.
  body.addEventListener('click', () => { if (selected) { selected = null; render(); } });
  panel.appendChild(body);

  if (data && data.error) {
    body.appendChild(note(`Could not load run history — ${data.error}`));
    return;
  }
  if (!data) {
    body.appendChild(note('Loading…'));
    return;
  }
  if (!data.enabled) {
    const warn = document.createElement('div');
    warn.className = 'sched-hist-warn';
    warn.textContent = 'Scheduler is off — nothing below will fire. Enable “Run scheduled tasks” in Settings.';
    body.appendChild(warn);
  }
  if (!data.groups.length) {
    body.appendChild(note('No scheduled tasks yet.'));
    return;
  }

  for (const group of data.groups) body.appendChild(renderGroup(group));

  // Restoring scroll AFTER the rebuild is what keeps a live status change from
  // yanking the page out from under someone reading the bottom of it.
  if (scroll) { body.scrollTop = scroll.top; body.scrollLeft = scroll.left; }
}

function note(text) {
  const el = document.createElement('div');
  el.className = 'sched-hist-note';
  el.textContent = text;
  return el;
}

function renderHeader() {
  const header = document.createElement('div');
  header.className = 'sched-hist-header';

  const titles = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'sched-hist-title';
  title.textContent = 'Scheduled task runs';
  titles.appendChild(title);

  const legend = document.createElement('div');
  legend.className = 'sched-hist-legend';
  // Two things the grid cannot show, said out loud rather than implied away:
  // columns are ordinal (one cell = one run, not a fixed span of time), and a
  // fire the overlap guard skipped is recorded nowhere at all.
  legend.textContent =
    'Newest run on the left · one cell per recorded run, not per time interval · '
    + 'skipped fires are not recorded';
  titles.appendChild(legend);
  header.appendChild(titles);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'sched-hist-close';
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.title = 'Close (Esc)';
  closeBtn.onclick = () => close();
  header.appendChild(closeBtn);

  return header;
}

function renderGroup(group) {
  const el = document.createElement('div');
  el.className = 'sched-hist-group';

  const head = document.createElement('div');
  head.className = 'sched-hist-group-head';
  const name = document.createElement('span');
  name.className = 'sched-hist-group-name';
  name.textContent = group.name;
  head.appendChild(name);
  if (group.archived) head.appendChild(tag('archived'));
  el.appendChild(head);

  for (const repo of group.repos) el.appendChild(renderRepo(repo));
  return el;
}

function renderRepo(repo) {
  const el = document.createElement('div');
  el.className = 'sched-hist-repo';

  const head = document.createElement('div');
  head.className = 'sched-hist-repo-head';
  const name = document.createElement('span');
  name.className = 'sched-hist-repo-name';
  name.textContent = repo.name;
  if (repo.root) name.title = repo.root;
  head.appendChild(name);
  // A repo whose folder is gone still owns live schedules that will fail on every
  // fire — the whole reason those tasks are shown rather than filtered out.
  if (repo.missing) head.appendChild(tag('folder missing', 'bad'));
  el.appendChild(head);

  for (const task of repo.tasks) el.appendChild(renderTask(task));
  return el;
}

function tag(text, kind) {
  const el = document.createElement('span');
  el.className = 'sched-hist-tag' + (kind ? ` ${kind}` : '');
  el.textContent = text;
  return el;
}

function renderTask(task) {
  const row = document.createElement('div');
  row.className = 'sched-hist-row' + (task.deleted || !task.enabled ? ' dim' : '');

  const label = document.createElement('div');
  label.className = 'sched-hist-label';
  const title = document.createElement('div');
  title.className = 'sched-hist-task-title';
  title.textContent = task.title;
  label.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'sched-hist-task-sub';
  const next = task.deleted ? 'unscheduled'
    : task.once && task.firedAt ? 'retired'
      : !task.enabled ? 'paused'
        : task.nextRun ? `next ${relTime(task.nextRun)}` : 'no next run';
  sub.textContent = `${task.schedule || task.cron} · ${next}`;
  sub.title = task.schedule || task.cron;
  label.appendChild(sub);
  row.appendChild(label);

  row.appendChild(renderRuns(task));
  return row;
}

function renderRuns(task) {
  const strip = document.createElement('div');
  strip.className = 'sched-hist-runs';

  // Stored order is only APPROXIMATELY newest-first: trimRuns() keeps a run whose
  // session is still live past the cap by appending it at the end, so an in-flight
  // run can sit at the far end of the array. Sort explicitly.
  const runs = [...(task.runs || [])].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  if (!runs.length) {
    const idle = idleState(task);
    const el = document.createElement('div');
    el.className = `sched-hist-idle ${idle.cls}`;
    el.textContent = idle.text;
    strip.appendChild(el);
    return strip;
  }

  for (const run of runs) strip.appendChild(renderRun(task, run));

  // The axis is rank, not wall-clock — column 3 is "3 hours ago" on an hourly
  // task and "3 months ago" on a monthly one in the row below. Anchoring both
  // ends with real times is what keeps the row from implying otherwise.
  const span = document.createElement('div');
  span.className = 'sched-hist-span';
  const newest = relTime(runs[0].startedAt);
  const oldest = runs.length > 1 ? relTime(runs[runs.length - 1].startedAt) : null;
  span.textContent = oldest ? `${newest} … ${oldest}` : (newest || '');
  strip.appendChild(span);

  return strip;
}

function renderRun(task, run) {
  const v = statusVisual(run.status);
  const wrap = document.createElement('div');
  wrap.className = 'sched-hist-cellwrap';

  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = `sched-hist-cell ${v.cls}`;
  cell.textContent = v.glyph;

  const dur = formatDuration(run);
  const lines = [absTime(run.startedAt), v.label];
  if (dur) lines.push(dur);
  if (run.summary) lines.push(run.summary);
  cell.title = lines.join(' · ');
  // A title tooltip is not an accessible name for a control.
  cell.setAttribute('aria-label', `${task.title} — ${v.label} — ${absTime(run.startedAt)}`);

  const key = runKeyOf(run);
  const isSelected = selected && selected.taskId === task.id && selected.runKey === key;
  if (isSelected) cell.classList.add('selected');
  cell.onclick = (e) => {
    e.stopPropagation();
    selected = isSelected ? null : { taskId: task.id, runKey: key };
    render();
  };
  wrap.appendChild(cell);

  if (isSelected) wrap.appendChild(renderDetail(task, run, v));
  return wrap;
}

function renderDetail(task, run, v) {
  const pop = document.createElement('div');
  pop.className = 'sched-hist-detail';
  pop.onclick = (e) => e.stopPropagation();

  const head = document.createElement('div');
  head.className = 'sched-hist-detail-head';
  head.textContent = `${task.title} — ${v.label}`;
  pop.appendChild(head);

  const rows = [
    ['Started', absTime(run.startedAt)],
    ['Agent engaged', run.agentStartedAt ? absTime(run.agentStartedAt) : '—'],
    ['Ended', run.endedAt ? absTime(run.endedAt) : '—'],
    ['Duration', formatDuration(run) || '—'],
    ['Session', run.sessionId || '—'],
    ['Model', [run.model, run.effort].filter(Boolean).join(' · ') || '—'],
  ];
  if (run.worktree) rows.push(['Worktree', run.worktree + (run.worktreeRemoved ? '' : ' (kept)')]);
  if (run.summary) rows.push(['Summary', run.summary]);

  for (const [k, val] of rows) {
    const line = document.createElement('div');
    line.className = 'sched-hist-detail-row';
    const key = document.createElement('span');
    key.className = 'sched-hist-detail-key';
    key.textContent = k;
    const value = document.createElement('span');
    value.className = 'sched-hist-detail-val';
    value.textContent = val;
    line.appendChild(key);
    line.appendChild(value);
    pop.appendChild(line);
  }

  // "Go to session" is offered ONLY when the run's session is a tab in THIS
  // window. focusSession → switchTo sets activeId unconditionally, so handing it
  // an id this window doesn't have would blank the pane and persist a dead active
  // tab. A scheduled run is unattended by construction, so "live somewhere on the
  // server" is emphatically not the same question.
  const here = run.sessionId && (callbacks.getSessions?.() || []).some(s => s.id === run.sessionId);
  const foot = document.createElement('div');
  foot.className = 'sched-hist-detail-foot';
  if (here) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'sched-hist-go';
    go.textContent = 'Go to session';
    go.onclick = () => { const id = run.sessionId; close(); callbacks.focusSession?.(id); };
    foot.appendChild(go);
  } else {
    const why = document.createElement('span');
    why.className = 'sched-hist-detail-hint';
    // There is no transcript pointer on a run row — sessionId is the only handle,
    // so say what can be done rather than offering a link that cannot exist.
    why.textContent = run.sessionId
      ? 'This run’s tab is not open in this window.'
      : 'No session recorded for this run.';
    foot.appendChild(why);
  }
  pop.appendChild(foot);

  return pop;
}
