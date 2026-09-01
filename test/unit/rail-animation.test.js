// Headless unit test for the projects panel's open/close motion (#691) in
// public/js/context-views.js.
//
// This is the ONLY suite that stubs window.matchMedia, and that is the point:
// railCanAnimate() gates on it, so context-views.test.js, excursion-keys.test.js,
// apps-rail.test.js and quiet-mode.test.js all keep the synchronous display flip
// they were written against, and this file is where the animated path is proved.
//
// The fake DOM is a little richer than its siblings' — style.setProperty /
// removeProperty, a settable box width, and a real listener registry so a
// transitionend can be dispatched — because the transition's endpoints and its
// settle are exactly what is under test.
//
// Run: node --test test/unit/rail-animation.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};

// Every duration the module reads back comes from here. 0s keeps the fallback
// timer at its +120ms floor so the "transitionend never fires" test stays quick.
let computedTransition = { transitionDuration: '0s', transitionDelay: '0s' };
globalThis.getComputedStyle = () => ({ ...computedTransition, getPropertyValue: () => '' });

function fakeElement() {
  const classes = new Set();
  const children = [];
  const listeners = new Map(); // type → Set(fn), so removeEventListener is real
  let text = '';
  const widthLog = [];         // every style.width write, in order — the transition's endpoints
  const style = {
    _props: new Map(),
    setProperty: (k, v) => style._props.set(k, v),
    removeProperty: (k) => style._props.delete(k),
    getPropertyValue: (k) => style._props.get(k) ?? '',
  };
  let width = '';
  Object.defineProperty(style, 'width', {
    get: () => width,
    set: (v) => { width = String(v); widthLog.push(width); },
    enumerable: true,
  });
  const el = {
    id: '', className: '', title: '',
    style, widthLog,
    dataset: {},
    children,
    inserted: [],
    listeners,
    rectWidth: 0,   // what getBoundingClientRect()/clientWidth/offsetWidth report
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    },
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener: (ev, fn) => { listeners.get(ev)?.delete(fn); },
    insertAdjacentElement: (pos, child) => { el.inserted.push(child); },
    appendChild: (child) => { children.push(child); },
    setAttribute: () => {},
    getBoundingClientRect: () => ({ width: el.rectWidth, left: 0, top: 0 }),
    remove: () => {},
  };
  Object.defineProperty(el, 'clientWidth', { get: () => el.rectWidth });
  Object.defineProperty(el, 'offsetWidth', { get: () => el.rectWidth });
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); if (!html) children.length = 0; },
  });
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); children.length = 0; },
  });
  return el;
}

/** Fire a transitionend the way the browser would when the width transition finishes. */
const endWidthTransition = (el) => {
  for (const fn of [...(el.listeners.get('transitionend') || [])]) {
    fn({ target: el, propertyName: 'width' });
  }
};

const byId = new Map();
const createdEls = [];

globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: () => { const el = fakeElement(); createdEls.push(el); return el; },
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild: () => {} },
  activeElement: null,
};

let reducedMotion = false;
globalThis.window = {
  dispatchEvent: () => {},
  addEventListener: () => {},
  innerWidth: 1400,
  innerHeight: 900,
  requestAnimationFrame: (fn) => fn(),
  matchMedia: (q) => ({ media: q, matches: q.includes('reduced-motion') && reducedMotion }),
};
globalThis.window.parent = globalThis.window; // depth 0 → unprefixed storage keys

globalThis.fetch = () => Promise.reject(new Error('no server in unit test'));

// ------------------------------------------------------------------- harness

const CTX_A = { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] };
const RAIL_WIDTH = 200; // what the rail measures once it is on screen

let importCount = 0;

/**
 * Fresh module + the app.js wiring, with the rail closed at init (the default) so the
 * first applyRailChrome() has already been spent by the time a test toggles.
 */
async function setup({ startOpen = false, reduced = false } = {}) {
  storeMap.clear();
  byId.clear();
  createdEls.length = 0;
  reducedMotion = reduced;
  computedTransition = { transitionDuration: '0s', transitionDelay: '0s' };
  if (startOpen) storeMap.set('deepsteve-context-sidebar', '1');

  const toggle = fakeElement();
  byId.set('context-toggle', toggle);

  const url = new URL('../../public/js/context-views.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);

  mod.init({
    getOrderedTabIds: () => [],
    getTabCwd: () => null,
    getActiveTabId: () => null,
    switchToTab: () => {},
    updateEmptyState: () => {},
    onActiveContextChanged: () => {},
    createSessionInDir: () => {},
    promptNewTabDir: () => {},
  });
  mod.setContexts([CTX_A]);

  const rail = createdEls.find((el) => el.id === 'context-rail');
  const resizer = createdEls.find((el) => el.id === 'context-resizer');
  rail.rectWidth = RAIL_WIDTH; // a rail with a real box, so .collapsed is derived honestly
  rail.widthLog.length = 0;
  return { mod, toggle, rail, resizer, click: () => toggle.listeners.get('click').values().next().value() };
}

const cls = (el, c) => el.classList.contains(c);

// --------------------------------------------------------------------- tests

test('reduced motion takes the instant path in both directions', async () => {
  const { rail, resizer, click } = await setup({ reduced: true });

  click();
  assert.strictEqual(rail.style.display, 'flex');
  assert.strictEqual(cls(rail, 'rail-animating'), false,
    'no transition may be armed — transitionend would never fire to undo it');
  assert.strictEqual(cls(rail, 'rail-opening'), false);

  click();
  assert.strictEqual(rail.style.display, 'none', 'the close must land in the same tick');
  assert.strictEqual(resizer.style.display, 'none');
  assert.strictEqual(cls(rail, 'rail-closing'), false);
});

test('a fake DOM with no matchMedia keeps the synchronous flip', async () => {
  const { rail, click } = await setup();
  const mm = globalThis.window.matchMedia;
  delete globalThis.window.matchMedia;
  try {
    click();
    assert.strictEqual(rail.style.display, 'flex');
    assert.strictEqual(cls(rail, 'rail-animating'), false,
      'this is what keeps the four sibling suites on their original contract');
  } finally {
    globalThis.window.matchMedia = mm;
  }
});

test('open: display flips synchronously, and the width runs 0 → target', async () => {
  const { rail, resizer, click } = await setup();

  click();

  assert.strictEqual(rail.style.display, 'flex', "applyRailChrome's synchronous contract");
  assert.strictEqual(resizer.style.display, 'block', 'the drag handle rides the whole slide');
  assert.ok(cls(rail, 'rail-animating'));
  assert.ok(cls(rail, 'rail-opening'), 'the 6px content parallax is scoped to an open');
  assert.strictEqual(cls(rail, 'rail-closing'), false);
  assert.strictEqual(cls(rail, 'rail-hidden'), false, 'removed in the same batch that starts the run');
  assert.strictEqual(rail.style.getPropertyValue('--ds-rail-anim-w'), RAIL_WIDTH + 'px',
    'children are pinned to the target content width so labels never ellipsise mid-slide');
  assert.deepStrictEqual(rail.widthLog, ['', '0px', ''],
    "applyRailWidth's default, then the zero start, then back to the theme default as the target");
});

test('open does not latch the collapsed icon rail from its zero-width start', async () => {
  const { rail, click } = await setup();

  click();

  assert.strictEqual(cls(rail, 'collapsed'), false,
    '.collapsed is derived from a synchronous measurement — it must be taken at the TARGET width');
});

test('open settles on transitionend: classes and the pin are cleared', async () => {
  const { rail, click } = await setup();
  click();

  endWidthTransition(rail);

  assert.strictEqual(cls(rail, 'rail-animating'), false);
  assert.strictEqual(cls(rail, 'rail-opening'), false);
  assert.strictEqual(rail.style.getPropertyValue('--ds-rail-anim-w'), '');
  assert.strictEqual(rail.style.display, 'flex');
  assert.strictEqual(rail.listeners.get('transitionend').size, 0, 'the settle unhooks itself');
});

test('close holds display until the settle, then hides the rail and its handle', async () => {
  const { rail, resizer, click } = await setup();
  click();
  endWidthTransition(rail);
  rail.widthLog.length = 0;

  click();

  assert.strictEqual(rail.style.display, 'flex', 'still on screen — it is mid-slide');
  assert.strictEqual(resizer.style.display, 'block');
  assert.ok(cls(rail, 'rail-closing'));
  assert.ok(cls(rail, 'rail-hidden'), 'opacity and border-width fade out with the width');
  assert.deepStrictEqual(rail.widthLog, [RAIL_WIDTH + 'px', '0px']);

  endWidthTransition(rail);

  assert.strictEqual(rail.style.display, 'none');
  assert.strictEqual(resizer.style.display, 'none');
  assert.strictEqual(rail.style.width, '', 'the next open re-applies the saved width itself');
  assert.strictEqual(cls(rail, 'rail-closing'), false);
});

test('a close whose transitionend never arrives is rescued by the fallback timer', async () => {
  const { rail, click } = await setup();
  click();
  endWidthTransition(rail);

  click();
  assert.strictEqual(rail.style.display, 'flex');

  await new Promise((r) => setTimeout(r, 200)); // 0s duration + the 120ms floor

  assert.strictEqual(rail.style.display, 'none',
    'a transition that never runs must not strand a closing rail on screen');
});

test('a reversal starts from where the eye is and supersedes the old settle', async () => {
  const { rail, click } = await setup();
  click();
  endWidthTransition(rail);

  click();                 // start closing
  rail.rectWidth = 120;    // …and interrupt it halfway
  rail.widthLog.length = 0;
  click();                 // reopen

  assert.ok(cls(rail, 'rail-opening'));
  assert.strictEqual(cls(rail, 'rail-closing'), false, 'the closing timing must not survive a reversal');
  assert.strictEqual(rail.style.display, 'flex');
  assert.ok(rail.widthLog.includes('120px'), 'the open picks up at the frozen width, not at zero');
  assert.strictEqual(rail.listeners.get('transitionend').size, 1, 'exactly one settle is pending');

  endWidthTransition(rail);
  assert.strictEqual(rail.style.display, 'flex', 'the superseded close must not hide the reopened rail');
});

test('the first apply of the page never animates a restored-open rail', async () => {
  const { rail } = await setup({ startOpen: true });

  assert.strictEqual(rail.style.display, 'flex');
  assert.strictEqual(cls(rail, 'rail-animating'), false,
    'an open rail would otherwise play a mount animation on every reload');
});

test('chrome that does not change visibility does not replay the motion', async () => {
  const { mod, rail } = await setup();   // rail closed

  mod.setRailSuppressed(true);           // still closed — nothing to animate

  assert.strictEqual(rail.style.display, 'none');
  assert.strictEqual(cls(rail, 'rail-animating'), false);
});
