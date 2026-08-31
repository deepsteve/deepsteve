// Headless unit test for the timelapse recorder (#667).
//
// Four behaviours here fail invisibly in a real browser — you would not find out until a
// day-long run came back wrong — so they are pinned rather than reviewed:
//
//   * a deadline driven by TICK COUNT instead of the wall clock stalls in a background
//     tab (browsers clamp setInterval there), which is most of a working day;
//   * re-anchoring a late capture to the MISSED deadline rather than to now makes a tab
//     that was hidden for an hour fire twelve identical frames back to back, papering
//     over the very gap the run exists to record;
//   * run state that lives in a module variable rather than sessionStorage silently
//     starts a NEW folder on every page reload, and a day crosses at least one;
//   * a dot that keeps recording after the server setting is turned off is a feature with
//     no off switch.
//
// Same harness shape as quiet-mode.test.js / apps-rail.test.js: fake DOM, fake storage,
// re-import with a ?t= cache-bust so each test gets a fresh module.
//
// Run: node --test test/unit/timelapse-recorder.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
const fakeStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};
globalThis.sessionStorage = fakeStorage;
globalThis.localStorage = fakeStorage;

let allElements = [];
let tabEls = [];

function fakeElement(tag = 'div') {
  const classes = new Set();
  const el = {
    tag, id: '', title: '', style: {}, type: '', listeners: {}, attrs: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    },
    addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    getAttribute: (k) => el.attrs[k],
    appendChild: (c) => c,
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
  });
  allElements.push(el);
  return el;
}

globalThis.document = {
  getElementById: (id) => allElements.find(e => e.id === id) || null,
  createElement: (tag) => fakeElement(tag),
  // The recorder derives tab-strip order from the DOM, the same way app.js does.
  querySelectorAll: (sel) => (sel === '#tabs-list .tab' ? tabEls : []),
  addEventListener: () => {},
  head: { appendChild: () => {} },
  visibilityState: 'visible',
  hidden: false,
  hasFocus: () => true,
};
globalThis.window = {
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 2,
  addEventListener: () => {},
  // dom-capture reads this; present means ensureModernScreenshot() resolves without
  // touching the network.
  modernScreenshot: { domToPng: async () => 'data:image/png;base64,AAAA' },
};
globalThis.window.parent = globalThis.window;   // nsKey adds no ds1- prefix at depth 0

// ------------------------------------------------------------------- harness

const STATE_KEY = 'deepsteve-timelapse';
let importCount = 0;
let now = 1_700_000_000_000;

/** Deterministic clock — every deadline assertion here is about wall-clock arithmetic. */
Date.now = () => now;

/** A fake tab element as it appears in #tabs-list. */
function tab(id, { hidden = false } = {}) {
  const el = fakeElement('div');
  el.id = 'tab-' + id;
  if (hidden) el.classList.add('context-hidden');
  return el;
}

async function setup({ keepStorage = false, tabs = ['s1'] } = {}) {
  allElements = [];
  if (!keepStorage) storeMap.clear();
  tabEls = tabs.map(id => tab(id));

  const appContainer = fakeElement();
  appContainer.id = 'app-container';

  const posted = [];
  globalThis.fetch = (url, opts) => {
    posted.push({ url: String(url), body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ seq: posted.length }) });
  };

  // setInterval is captured, not run: the tests drive tick() by hand so that "what
  // happens after 60 minutes hidden" is one assertion rather than a real wait.
  let ticker = null;
  globalThis.setInterval = (fn) => { ticker = fn; return 1; };
  globalThis.clearInterval = () => { ticker = null; };

  const mod = await import(`../../public/js/timelapse.js?t=${++importCount}`);

  const mounted = [];
  const visibility = [];
  mod.init({
    mountIndicator: (el) => mounted.push(el),
    onIndicatorVisibility: (on) => visibility.push(on),
    getWindowId: () => 'win-abc12345',
    getActiveTabId: () => 's1',
    getTabInfo: (id) => ({ name: 'tab-' + id, type: 'terminal', cwd: '/repo/x', waitingForInput: false }),
    getLayoutInfo: () => ({ tabLayout: 'horizontal', quiet: false }),
  });

  return { mod, posted, visibility, dot: mounted[0], tick: () => ticker && ticker() };
}

/** Let the in-flight capture promise settle — captureFrame is async. */
const settle = () => new Promise(r => setImmediate(r));

// --------------------------------------------------------------------- tests

test('start() records immediately and writes a run id naming this window', async () => {
  const { mod, posted, dot } = await setup();
  assert.strictEqual(mod.isRecording(), false);
  assert.strictEqual(dot.classList.contains('recording'), false);
  assert.strictEqual(dot.getAttribute('aria-pressed'), 'false');

  mod.start();
  await settle();

  assert.strictEqual(mod.isRecording(), true);
  assert.strictEqual(dot.classList.contains('recording'), true);
  assert.strictEqual(dot.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].url, '/api/timelapse/frame');
  // Per-window streams: the window id is IN the folder name, so two windows can never
  // merge their tab counts.
  assert.match(posted[0].body.runId, /^\d{8}-\d{6}-win-abc12345$/);
});

test('the dot click toggles recording', async () => {
  const { mod, dot } = await setup();
  dot.listeners.click();
  await settle();
  assert.strictEqual(mod.isRecording(), true);
  dot.listeners.click();
  assert.strictEqual(mod.isRecording(), false);
  assert.strictEqual(dot.classList.contains('recording'), false);
});

test('a tick before the deadline captures nothing', async () => {
  const { mod, posted, tick } = await setup();
  mod.start();
  await settle();
  assert.strictEqual(posted.length, 1);

  now += 60 * 1000;   // one minute into a five-minute interval
  tick();
  await settle();
  assert.strictEqual(posted.length, 1, 'ticking is not capturing');
});

test('a tick at the deadline captures exactly one frame', async () => {
  const { mod, posted, tick } = await setup();
  mod.start();
  await settle();

  now += 5 * 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(posted.length, 2);

  now += 5 * 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(posted.length, 3);
});

test('waking from an hour hidden captures ONE frame, not twelve', async () => {
  // The whole reason the deadline re-anchors to now instead of to the missed deadline.
  // Twelve identical catch-up frames would hide the gap they are supposed to reveal.
  const { mod, posted, tick } = await setup();
  mod.start();
  await settle();
  assert.strictEqual(posted.length, 1);

  now += 60 * 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(posted.length, 2, 'one frame for the whole hour');

  // And the next deadline is a full interval from NOW, not still in the past.
  tick();
  await settle();
  assert.strictEqual(posted.length, 2, 'no burst on the very next tick');

  now += 5 * 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(posted.length, 3);
});

test('a frame records when it ACTUALLY happened next to when it was due', async () => {
  const { mod, posted, tick } = await setup();
  mod.start();
  await settle();
  const due = posted[0].body.capturedAt + 5 * 60 * 1000;

  now += 47 * 60 * 1000;   // throttled tab, badly late
  tick();
  await settle();

  const f = posted[1].body;
  assert.strictEqual(f.expectedAt, due);
  assert.strictEqual(f.capturedAt, now);
  assert.notStrictEqual(f.capturedAt, f.expectedAt);
});

test('a run survives a page reload and continues into the SAME folder', async () => {
  const first = await setup();
  first.mod.start();
  await settle();
  const runId = first.posted[0].body.runId;
  assert.ok(storeMap.get(STATE_KEY), 'run state persisted');

  // A reload is a fresh module against the same sessionStorage.
  const second = await setup({ keepStorage: true });
  assert.strictEqual(second.mod.isRecording(), true, 'still recording after reload');
  assert.strictEqual(second.dot.classList.contains('recording'), true);

  now += 5 * 60 * 1000;
  second.tick();
  await settle();
  assert.strictEqual(second.posted[0].body.runId, runId, 'same run folder across the reload');
});

test('stop() clears the persisted run, so a reload does not resurrect it', async () => {
  const first = await setup();
  first.mod.start();
  await settle();
  first.mod.stop();
  assert.strictEqual(storeMap.get(STATE_KEY), undefined);

  const second = await setup({ keepStorage: true });
  assert.strictEqual(second.mod.isRecording(), false);
});

test('hiding the dot is announced, so the rail can hide itself too', async () => {
  // The strip hides when nothing visible is left in it. If the dot went quiet without
  // saying so, turning timelapse off with no panel mods enabled would leave a bare
  // bordered column standing next to nothing.
  const { mod, visibility } = await setup();
  assert.deepStrictEqual(visibility, [true], 'announced on mount');
  mod.setEnabled(false);
  assert.deepStrictEqual(visibility, [true, false]);
  mod.setEnabled(true);
  assert.deepStrictEqual(visibility, [true, false, true]);
});

test('the server setting is a real off switch', async () => {
  const { mod, posted, dot, tick } = await setup();
  mod.setEnabled(false);
  assert.strictEqual(dot.style.display, 'none');

  mod.start();
  await settle();
  assert.strictEqual(mod.isRecording(), false, 'start() is refused while disabled');
  assert.strictEqual(posted.length, 0);

  mod.setEnabled(true);
  assert.strictEqual(dot.style.display, '');
  mod.start();
  await settle();
  assert.strictEqual(posted.length, 1);

  // Turning it off mid-run stops the run rather than leaving an orphan recording.
  mod.setEnabled(false);
  assert.strictEqual(mod.isRecording(), false);
  now += 10 * 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(posted.length, 1);
});

test('shortening the interval re-aims a run in flight', async () => {
  // Otherwise dropping 5 min to 1 min appears to do nothing for five more minutes.
  const { mod, posted, tick } = await setup();
  mod.start();
  await settle();

  mod.setIntervalMinutes(1);
  now += 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(posted.length, 2);
});

test('the snapshot carries tab-strip order, window state and the input stamp', async () => {
  const { mod, posted } = await setup({ tabs: ['s1', 's2', 's3'] });
  mod.start();
  await settle();

  const body = posted[0].body;
  assert.deepStrictEqual(body.tabs.map(t => t.id), ['s1', 's2', 's3']);
  assert.deepStrictEqual(body.tabs.map(t => t.index), [0, 1, 2]);
  assert.strictEqual(body.tabs[0].active, true);
  assert.strictEqual(body.tabs[1].active, false);
  assert.strictEqual(body.tabs[0].title, 'tab-s1');

  assert.strictEqual(body.window.windowId, 'win-abc12345');
  assert.strictEqual(body.window.tabCount, 3);
  assert.strictEqual(body.window.hasFocus, true);
  assert.strictEqual(body.window.visibilityState, 'visible');
  assert.deepStrictEqual(body.window.viewport, { width: 1400, height: 900, devicePixelRatio: 2 });
  assert.strictEqual(body.window.layout.tabLayout, 'horizontal');
  // No keystroke has been seen, and that is reported as null rather than as "just now" —
  // a fake recent input would make an untouched window look worked in.
  assert.strictEqual(body.window.lastInputAt, null);
  assert.strictEqual(body.window.msSinceInput, null);
});

test('a failed frame is a gap, not the end of the run', async () => {
  const { mod, tick } = await setup();
  const failures = [];
  const realError = console.error;
  console.error = (...a) => failures.push(a.join(' '));
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500 });

  mod.start();
  await settle();
  assert.strictEqual(mod.isRecording(), true, 'still recording after a failed frame');
  assert.ok(failures.some(f => f.includes('[timelapse]')), 'the failure was logged');

  console.error = realError;
  now += 5 * 60 * 1000;
  tick();
  await settle();
  assert.strictEqual(mod.isRecording(), true);
});
