// Unit tests for the run-history page's client module (#633).
//
// Two things are worth pinning here. The pure helpers (status vocabulary,
// duration) are what the grid's legibility rests on — including the legacy
// started/completed rows that pre-date #525 and still sit in real history files.
// And the render, driven through a small tree-shaped fake DOM, because the page's
// two load-bearing behaviours are structural: runs are re-sorted (stored order is
// only approximately newest-first) and "Go to session" is offered only for a tab
// THIS window has.
//
// Run: node --test test/unit/scheduled-history-client.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals
//
// A real tree, unlike the flat stub in shortcuts-registry.test.js: this suite
// renders the page and walks the result.

function fakeElement(tag = 'div') {
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parent: null,
    _text: '',
    id: '', title: '', type: '', tabIndex: 0,
    attributes: {},
    style: { setProperty: () => {}, removeProperty: () => {} },
    scrollTop: 0, scrollLeft: 0,
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    get textContent() {
      return el.children.length ? el.children.map(c => c.textContent).join('') : el._text;
    },
    set textContent(v) { el._text = String(v); el.children = []; },
    get innerHTML() { return ''; },
    set innerHTML(v) { if (!v) el.children = []; },
    setAttribute: (k, v) => { el.attributes[k] = String(v); },
    getAttribute: (k) => (k in el.attributes ? el.attributes[k] : null),
    appendChild: (child) => { child.parent = el; el.children.push(child); return child; },
    remove: () => {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter(c => c !== el);
      el.parent = null;
    },
    focus: () => {},
    addEventListener: () => {},
    querySelector: (sel) => query(el, sel)[0] || null,
    querySelectorAll: (sel) => query(el, sel),
  };
  return el;
}

// Enough selector support for `.a-class` and nothing else — the module only ever
// queries by a single class.
function query(root, sel) {
  const want = String(sel).replace(/^\./, '');
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.classList.contains(want)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const body = fakeElement('body');
globalThis.document = {
  createElement: (t) => fakeElement(t),
  addEventListener: () => {},
  removeEventListener: () => {},
  body,
  querySelector: (sel) => query(body, sel)[0] || null,
  querySelectorAll: (sel) => query(body, sel),
};
globalThis.window = { addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;
globalThis.requestAnimationFrame = (fn) => fn();

let served = null; // whatever GET /api/scheduled-tasks/history should answer
globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(served) });

let mod;
async function load() {
  if (!mod) mod = await import('../../public/js/scheduled-history.js');
  return mod;
}

// ------------------------------------------------------------------- fixtures

const RUN = (over = {}) => ({
  startedAt: 1000, agentStartedAt: null, endedAt: null, status: 'succeeded',
  success: true, summary: null, sessionId: 's1', worktree: null,
  worktreeRemoved: false, model: null, effort: null, ...over,
});

const TASK = (over = {}) => ({
  id: 't1', title: 'Nightly digest', schedule: 'Every day at 02:00', cron: '0 2 * * *',
  agentType: 'claude', enabled: true, once: false, firedAt: null,
  nextRun: null, lastRun: null, deleted: false, runs: [], ...over,
});

const PAYLOAD = (tasks, over = {}) => ({
  enabled: true,
  generatedAt: 1,
  groups: [{
    id: 'g1', name: 'Acme', archived: false,
    repos: [{ key: 'g1 /r/acme', root: '/r/acme', name: 'acme', missing: false, tasks }],
  }],
  ...over,
});

async function openWith(payload, cbs = {}) {
  const m = await load();
  // The module is a singleton, so a test that failed before its own cleanup would
  // otherwise leave the page open and make open() a no-op for everything after it.
  reset(m);
  m.init({ getSessions: () => [], focusSession: () => {}, focusTerminal: () => {}, ...cbs });
  served = payload;
  await m.open();
  return m;
}

function reset(m) { m.close(); body.children = []; }

// --------------------------------------------------------------- pure helpers

test('statusVisual covers the whole lifecycle, including legacy rows', async () => {
  const { statusVisual } = await load();
  // Terminal outcomes must never share a class — the grid's cells are told apart
  // by class + glyph, not by hue (win-95 collapses green-soft and blue to navy).
  assert.strictEqual(statusVisual('succeeded').cls, 'ok');
  assert.strictEqual(statusVisual('failed').cls, 'bad');
  assert.strictEqual(statusVisual('timed-out').cls, 'bad');
  assert.strictEqual(statusVisual('running').cls, 'running');
  assert.strictEqual(statusVisual('queued').cls, 'queued');
  // 'ended' is a session that closed without self-reporting — not a failure.
  assert.strictEqual(statusVisual('ended').label, 'no report');
  // Pre-#525 rows still sit in real history files and must map to the same
  // vocabulary the panel's StatusBadge uses.
  assert.strictEqual(statusVisual('completed').cls, 'ok');
  assert.strictEqual(statusVisual('started').cls, 'running');
});

test('statusVisual renders an unknown or missing status instead of throwing', async () => {
  const { statusVisual } = await load();
  assert.strictEqual(statusVisual('brand-new-status').label, 'brand-new-status');
  assert.strictEqual(statusVisual(null).label, 'unknown');
  assert.ok(statusVisual(null).glyph, 'every cell needs a glyph, even an unknown one');
});

test('formatDuration measures from when the agent engaged, not from spawn', async () => {
  const { formatDuration } = await load();
  // The gap before agentStartedAt is session spawn + prompt delivery, not work.
  assert.strictEqual(formatDuration(RUN({ startedAt: 0, agentStartedAt: 60000, endedAt: 120000 })), '1m');
  assert.strictEqual(formatDuration(RUN({ startedAt: 0, agentStartedAt: null, endedAt: 5000 })), '5s');
  assert.strictEqual(formatDuration(RUN({ startedAt: 0, endedAt: 500 })), '<1s');
  assert.strictEqual(formatDuration(RUN({ startedAt: 0, endedAt: 3 * 3600000 + 600000 })), '3h 10m');
});

test('formatDuration returns null for a run that never ended', async () => {
  const { formatDuration } = await load();
  // A run still in flight, and a run whose clock went backwards, both have no
  // honest duration — the detail popover shows a dash rather than a guess.
  assert.strictEqual(formatDuration(RUN({ endedAt: null })), null);
  assert.strictEqual(formatDuration(RUN({ startedAt: 500, endedAt: 100 })), null);
  assert.strictEqual(formatDuration(null), null);
});

// --------------------------------------------------------------------- render

test('a task with no runs renders "never run", not an empty row', async () => {
  const m = await openWith(PAYLOAD([TASK({ runs: [] })]));
  const idle = document.querySelector('.sched-hist-idle');
  assert.ok(idle, 'a silently-broken schedule must show something');
  assert.strictEqual(idle.textContent, 'never run');
  assert.ok(idle.classList.contains('never'), 'only never-run is styled as a problem');
  reset(m);
});

test('paused and retired tasks are distinguished from never-run', async () => {
  const m = await openWith(PAYLOAD([
    TASK({ id: 'p', enabled: false }),
    TASK({ id: 'r', once: true, firedAt: 5 }),
    TASK({ id: 'd', deleted: true }),
  ]));
  const texts = document.querySelectorAll('.sched-hist-idle').map(e => e.textContent);
  assert.deepStrictEqual(texts, ['paused', 'one-shot · done', 'unscheduled']);
  // None of the three is a bug signal, so none wears the never-run styling.
  assert.ok(document.querySelectorAll('.sched-hist-idle').every(e => !e.classList.contains('never')));
  reset(m);
});

test('runs render newest-first even when stored order is not', async () => {
  // trimRuns() appends a still-live run PAST the cap, so the stored array can end
  // with a row that belongs at the front.
  const m = await openWith(PAYLOAD([TASK({
    runs: [
      RUN({ startedAt: 200, status: 'succeeded', sessionId: 'b' }),
      RUN({ startedAt: 100, status: 'failed', sessionId: 'c' }),
      RUN({ startedAt: 300, status: 'running', sessionId: 'a' }),
    ],
  })]));
  const cells = document.querySelectorAll('.sched-hist-cell');
  assert.strictEqual(cells.length, 3);
  assert.ok(cells[0].classList.contains('running'), 'the newest run is leftmost');
  assert.ok(cells[2].classList.contains('bad'), 'the oldest run is rightmost');
  reset(m);
});

test('a repo whose folder is gone is badged, and keeps its tasks', async () => {
  const payload = PAYLOAD([TASK()]);
  payload.groups[0].repos[0].missing = true;
  const m = await openWith(payload);
  const tags = document.querySelectorAll('.sched-hist-tag').map(e => e.textContent);
  assert.ok(tags.includes('folder missing'));
  assert.strictEqual(document.querySelectorAll('.sched-hist-row').length, 1);
  reset(m);
});

test('an archived project is labelled', async () => {
  const payload = PAYLOAD([TASK()]);
  payload.groups[0].archived = true;
  const m = await openWith(payload);
  assert.ok(document.querySelectorAll('.sched-hist-tag').map(e => e.textContent).includes('archived'));
  reset(m);
});

test('the scheduler-off banner explains why nothing will fire', async () => {
  const m = await openWith(PAYLOAD([TASK()], { enabled: false }));
  const warn = document.querySelector('.sched-hist-warn');
  assert.ok(warn && /Scheduler is off/.test(warn.textContent));
  reset(m);
});

test('the legend states both things the axis cannot show', async () => {
  const m = await openWith(PAYLOAD([TASK()]));
  const legend = document.querySelector('.sched-hist-legend').textContent;
  // Columns are ordinal, not a fixed time span; and a skipped fire is recorded
  // nowhere at all. Saying so is what keeps the grid from implying otherwise.
  assert.match(legend, /Newest run on the left/);
  assert.match(legend, /not per time interval/);
  assert.match(legend, /skipped fires are not recorded/);
  reset(m);
});

test('clicking a run opens its detail; "Go to session" needs a tab in THIS window', async () => {
  // focusSession → switchTo sets activeId unconditionally, so offering it for a
  // session this window does not have would blank the pane. A scheduled run is
  // unattended by construction, so "live on the server" is a different question.
  const m = await openWith(PAYLOAD([TASK({ runs: [RUN({ sessionId: 'gone' })] })]), {
    getSessions: () => [{ id: 'other' }],
  });
  document.querySelector('.sched-hist-cell').onclick({ stopPropagation: () => {} });
  assert.ok(document.querySelector('.sched-hist-detail'), 'the detail popover opens');
  assert.strictEqual(document.querySelector('.sched-hist-go'), null, 'no dead jump offered');
  assert.match(document.querySelector('.sched-hist-detail-hint').textContent, /not open in this window/);
  reset(m);
});

test('"Go to session" appears, and jumps, when the run is a tab here', async () => {
  const jumped = [];
  const m = await openWith(PAYLOAD([TASK({ runs: [RUN({ sessionId: 'here' })] })]), {
    getSessions: () => [{ id: 'here' }],
    focusSession: (id) => jumped.push(id),
  });
  document.querySelector('.sched-hist-cell').onclick({ stopPropagation: () => {} });
  const go = document.querySelector('.sched-hist-go');
  assert.ok(go);
  go.onclick();
  assert.deepStrictEqual(jumped, ['here'], 'the page closes first, then focuses');
  body.children = [];
});

test('a failed fetch leaves an explanation, not a blank page', async () => {
  const m = await load();
  m.init({ getSessions: () => [] });
  const prev = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 404 });
  await m.open();
  assert.match(document.querySelector('.sched-hist-note').textContent, /Could not load run history/);
  globalThis.fetch = prev;
  reset(m);
});
