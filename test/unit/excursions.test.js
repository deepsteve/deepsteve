// Headless unit test for excursions (#661) — the navigation stack that lets an App lend you
// out to a session, let you wander, and take you back with one key.
//
// The stack lives in mod-manager.js next to the one view slot it describes, so this drives the
// real slot rather than a model of it: every interesting question here is "did the slot
// background or foreground correctly", which a stack in isolation cannot answer.
//
// No browser, no Docker: stub window/document/storage BEFORE importing, then drive the exported
// API the way app.js and a mod's bridge do. ModManager.init() is synchronous and self-contained;
// loadAvailableMods() is a separate async export this file does not need, so no fetch stub.
//
// Run: node --test test/unit/excursions.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const localMap = new Map();
const sessionMap = new Map();
const mkStore = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
});
// Two REAL stores, not one aliased pair: the split is the design (which app is up is
// browser-wide and localStorage; where you wandered is this window's and sessionStorage), and
// aliasing them would let a test pass that had put the stack in the wrong one.
globalThis.localStorage = mkStore(localMap);
globalThis.sessionStorage = mkStore(sessionMap);

let allElements = [];

function fakeElement(tag = 'div') {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tag, title: '', style: {}, dataset: {}, children, listeners: {},
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
    removeEventListener: () => {},
    appendChild: (child) => { children.push(child); child.parent = el; return child; },
    append: (...kids) => { for (const k of kids) el.appendChild(k); },
    insertBefore: (child, ref) => {
      const i = children.indexOf(ref);
      children.splice(i === -1 ? children.length : i, 0, child);
      child.parent = el;
      return child;
    },
    setAttribute: (k, v) => { el[k] = v; },
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView: () => {},
    remove: () => {
      const p = el.parent;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      el.parent = null;
    },
  };
  // className and classList are one fact in a real DOM, and TabManager.setActive() reads the
  // class list off elements whose class was assigned as a string.
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
  });
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); children.length = 0; },
  });
  Object.defineProperty(el, 'parentNode', { get: () => el.parent || null });
  Object.defineProperty(el, 'nextSibling', {
    get: () => {
      const sibs = el.parent?.children || [];
      return sibs[sibs.indexOf(el) + 1] || null;
    },
  });
  el.id = '';
  allElements.push(el);
  return el;
}

globalThis.document = {
  getElementById: (id) => allElements.find(e => e.id === id) || null,
  createElement: (tag) => fakeElement(tag),
  querySelectorAll: (sel) => (sel === '.tab' ? allElements.filter(e => e.classList.contains('tab')) : []),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { style: {}, appendChild: () => {} },
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;

// --------------------------------------------------------------------- harness

let importCount = 0;

const WORKSHOP_VIEW = { id: 'workshop', name: 'Workshop', src: '/mods/workshop/index.html' };
const TOWER_VIEW = { id: 'tower', name: 'Tower', src: '/mods/tower/index.html' };

/**
 * A fresh mod-manager wired the way app.js wires it, with three live sessions.
 *
 * `keepStorage` skips the sessionStorage reset so a test can simulate a page RELOAD: a new
 * module instance reading the stack the previous one left behind.
 */
async function setup({ keepStorage = false } = {}) {
  allElements = [];
  localMap.clear();
  if (!keepStorage) sessionMap.clear();

  const appRoot = fakeElement();
  const terminals = fakeElement();
  terminals.id = 'terminals';
  appRoot.appendChild(terminals);

  const tabs = fakeElement();
  tabs.id = 'tabs';
  const layoutToggle = fakeElement('button');
  layoutToggle.id = 'layout-toggle';
  tabs.appendChild(layoutToggle);
  const tabsList = fakeElement();
  tabsList.id = 'tabs-list';
  tabs.appendChild(tabsList);

  const state = {
    activeSessionId: 'a',
    live: new Set(['a', 'b', 'c']),
    focused: [],
    railSuppressed: false,
    excursions: [],
  };

  const url = new URL('../../public/js/mod-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);
  const { ModManager } = mod;

  ModManager.init({
    getSessions: () => [...state.live].map(id => ({ id, name: 'tab ' + id })),
    getActiveSessionId: () => state.activeSessionId,
    // The full hand-off app.js models: focusSession is userJumpTo, which notes a drill and
    // then activates. Modelling only the activation would hide the re-entrancy the replace
    // rule depends on.
    focusSession: (id) => {
      ModManager.noteExcursionDrill(id);
      state.focused.push(id);
      state.activeSessionId = id;
    },
    hasSession: (id) => state.live.has(id),
    getBreadcrumb: (id) => ({ project: 'deepsteve', tab: 'tab ' + id }),
    onExcursionChanged: (ex) => {
      state.excursions.push(ex);
      state.railSuppressed = ex.depth > 0 && ex.chrome?.rail !== 'keep';
    },
    getWindowId: () => 'w1',
    onViewChanged: () => {},
  });

  const backBtn = tabs.children.find(c => c.classList.contains('mod-back-btn'));
  return { ModManager, mod, state, backBtn };
}

/** The bridge object a mod's iframe would receive, without an iframe. */
function bridgeFor(ModManager, modId) {
  const api = {};
  const iframeEl = { contentWindow: api };
  ModManager.injectBridgeAPI(iframeEl, modId, null);
  return api.deepsteve;
}

// ------------------------------------------------------------------------ tests

test('visitSession pushes a frame and backgrounds the app', async () => {
  const { ModManager, state, backBtn } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  assert.strictEqual(ModManager.isModViewVisible(), true);

  bridgeFor(ModManager, 'workshop').visitSession('b', { label: 'needs a decision' });

  assert.strictEqual(ModManager.isModViewVisible(), false, 'the slot must come down');
  assert.strictEqual(ModManager.getExcursion().depth, 1);
  assert.strictEqual(state.focused.at(-1), 'b');
  assert.strictEqual(state.railSuppressed, true, 'the app sent you; you are not browsing projects');
  assert.match(backBtn.textContent, /^← Workshop · deepsteve \/ tab b$/);
  assert.strictEqual(backBtn.classList.contains('excursion'), true);
});

test('a queue walk replaces the top frame instead of deepening the stack', async () => {
  // THE load-bearing rule. Without it, walking a 20-item inbox builds a 20-deep stack and
  // "back" costs 20 presses — which is the whole reason the shell exists.
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  const ds = bridgeFor(ModManager, 'workshop');

  ds.visitSession('a');
  ds.visitSession('b', { replace: true });
  ds.visitSession('c', { replace: true });

  assert.strictEqual(ModManager.getExcursion().depth, 1, 'depth must not grow with the walk');
  assert.strictEqual(ModManager.getExcursion().stack[0].sessionId, 'c');
  assert.strictEqual(state.activeSessionId, 'c', 'the terminal follows the cursor');
});

test('drilling from a visited session into another pushes, so back costs two presses', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');

  // A tab click while out — app.js's onTabStripClick.
  ModManager.noteExcursionDrill('b');
  assert.strictEqual(ModManager.getExcursion().depth, 2);

  ModManager.popExcursion();
  assert.strictEqual(ModManager.getExcursion().depth, 1);
  assert.strictEqual(state.activeSessionId, 'a', 'the first press lands back on where you came from');
  assert.strictEqual(ModManager.isModViewVisible(), false, 'still out');

  ModManager.popExcursion();
  assert.strictEqual(ModManager.getExcursion().depth, 0);
  assert.strictEqual(ModManager.isModViewVisible(), true, 'an emptied stack goes home');
  assert.strictEqual(ModManager.getActiveViewId(), 'workshop', 'and the iframe was never destroyed');
});

test('re-selecting the session you are already on is not a drill', async () => {
  const { ModManager } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');
  ModManager.noteExcursionDrill('a');
  ModManager.noteExcursionDrill('a');
  assert.strictEqual(ModManager.getExcursion().depth, 1);
});

test('back skips a frame whose session is gone', async () => {
  // Nothing tells the stack when a session dies. Validating on the way OUT covers a kill, a
  // closed tab and a tab sent to another window with one loop, and none of those paths has to
  // know the stack exists.
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');
  ModManager.noteExcursionDrill('b');
  ModManager.noteExcursionDrill('c');
  assert.strictEqual(ModManager.getExcursion().depth, 3);

  state.live.delete('b');           // killed while buried
  ModManager.popExcursion();        // pops c, finds b dead, keeps unwinding to a

  assert.strictEqual(state.activeSessionId, 'a');
  assert.strictEqual(ModManager.getExcursion().depth, 1);
});

test('a stack of nothing but dead sessions lands you home, not nowhere', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');
  ModManager.noteExcursionDrill('b');

  state.live.clear();               // every session you looked at is gone
  ModManager.popExcursion();

  assert.strictEqual(ModManager.isExcursionActive(), false);
  assert.strictEqual(ModManager.isModViewVisible(), true, 'back cannot dead-end');
});

test('endExcursion comes home and clears', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  const ds = bridgeFor(ModManager, 'workshop');
  ds.visitSession('a');
  ds.endExcursion();

  assert.strictEqual(ModManager.isExcursionActive(), false);
  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.strictEqual(state.railSuppressed, false, 'the chrome comes back with you');
});

test('the stack survives a reload of the same window', async () => {
  const first = await setup();
  first.ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(first.ModManager, 'workshop').visitSession('a');
  first.ModManager.noteExcursionDrill('b');
  assert.strictEqual(first.ModManager.getExcursion().depth, 2);

  // Reload: a new module instance, same sessionStorage. showView() stands in for the restore
  // branch in loadAvailableMods(), which raises the slot fullscreen — syncExcursion() is what
  // has to put it back down, because on a real reload whether the mod list or the session
  // restore finishes first is a race nobody may depend on.
  const second = await setup({ keepStorage: true });
  second.ModManager.showView(WORKSHOP_VIEW);
  assert.strictEqual(second.ModManager.getExcursion().depth, 2, 'the trail came back');
  second.ModManager.syncExcursion();
  assert.strictEqual(second.ModManager.isModViewVisible(), false, 'and you are still out on it');
  assert.strictEqual(second.state.activeSessionId, 'b');
  // A restored stack never passes through the mutation path, so the reconciler has to
  // re-assert the chrome itself — otherwise you reload into an excursion with the rail back.
  assert.strictEqual(second.state.railSuppressed, true);
});

test('a window that restores a DIFFERENT view drops the stack instead of inheriting it', async () => {
  // ACTIVE_VIEW_KEY is localStorage and shared by every window at this recursion depth, so
  // another window opening Tower can leave us holding a stack for a view we do not have.
  const first = await setup();
  first.ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(first.ModManager, 'workshop').visitSession('a');

  const second = await setup({ keepStorage: true });
  second.ModManager.showView(TOWER_VIEW);
  second.ModManager.syncExcursion();
  assert.strictEqual(second.ModManager.isExcursionActive(), false);
  assert.strictEqual(second.ModManager.isModViewVisible(), true);
});

test('syncExcursion waits for the visited session to have a tab', async () => {
  const first = await setup();
  first.ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(first.ModManager, 'workshop').visitSession('a');

  const second = await setup({ keepStorage: true });
  second.state.live.clear();                    // tabs have not been restored yet
  second.ModManager.showView(WORKSHOP_VIEW);
  second.ModManager.syncExcursion();
  assert.strictEqual(second.ModManager.isModViewVisible(), true, 'nothing to show yet: stay put');
  assert.strictEqual(second.ModManager.isExcursionActive(), true, 'and do not throw the trail away');

  second.state.live.add('a');                   // …now they are
  second.ModManager.notifySessionsChanged([{ id: 'a' }]);
  assert.strictEqual(second.ModManager.isModViewVisible(), false);
  assert.strictEqual(second.state.activeSessionId, 'a');
});

test('a different page taking the slot ends the excursion', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');

  ModManager.showView(TOWER_VIEW);   // another app's rail row, or a project mod
  assert.strictEqual(ModManager.isExcursionActive(), false);
  assert.strictEqual(state.railSuppressed, false);
});

test('hiding the app ends the excursion — there is nothing left to go back to', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');

  ModManager.hideView('workshop');   // toolbar toggle-off, disabled elsewhere, uninstall
  assert.strictEqual(ModManager.isExcursionActive(), false);
  assert.strictEqual(state.railSuppressed, false);
  assert.strictEqual(ModManager.getActiveViewId(), null);
});

test('the queue-cycle handler is asked, and its absence is reported so ⌘↑/⌘↓ can fall back', async () => {
  const { ModManager } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  const ds = bridgeFor(ModManager, 'workshop');
  ds.visitSession('a');

  assert.strictEqual(ModManager.requestExcursionCycle(1), false,
    'no handler must report unhandled, or the key dies instead of cycling projects');

  const seen = [];
  ds.onExcursionCycle(({ delta }) => seen.push(delta));
  assert.strictEqual(ModManager.requestExcursionCycle(1), true);
  assert.strictEqual(ModManager.requestExcursionCycle(-1), true);
  assert.deepStrictEqual(seen, [1, -1]);

  // A throwing handler must also report unhandled rather than swallowing the key.
  ds.onExcursionCycle(() => { throw new Error('boom'); });
  assert.strictEqual(ModManager.requestExcursionCycle(1), false);
});

test('a torn-down view leaves no cycle handler behind', async () => {
  // Worse than a leak: a stale handler keeps requestExcursionCycle reporting "handled", so
  // ⌘↑/⌘↓ would stop falling back to cycling projects and simply do nothing, forever.
  const { ModManager } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').onExcursionCycle(() => {});
  ModManager.showView(TOWER_VIEW);
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');
  assert.strictEqual(ModManager.requestExcursionCycle(1), false);
});

test('only the page in the slot may lend you out', async () => {
  // A panel mod calling visitSession would start a trail back to a view that is not on screen.
  const { ModManager } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'action-required').visitSession('b');
  assert.strictEqual(ModManager.isExcursionActive(), false);
});

test('focusSession is untouched: it starts no excursion (#661 is strictly opt-in)', async () => {
  const { ModManager, state, backBtn } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').focusSession('b');

  assert.strictEqual(ModManager.isExcursionActive(), false, 'no existing mod changes');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.strictEqual(state.railSuppressed, false);
  assert.strictEqual(backBtn.textContent, '← Workshop', 'the plain one-hop label');
  assert.strictEqual(backBtn.classList.contains('excursion'), false);
});

test('a corrupt stored stack reads as no excursion rather than wedging the slot', async () => {
  sessionMap.set('deepsteve-excursion', '{not json');
  const a = await setup({ keepStorage: true });
  assert.strictEqual(a.ModManager.isExcursionActive(), false);

  sessionMap.set('deepsteve-excursion', JSON.stringify({ appId: 'workshop', stack: 'nope' }));
  const b = await setup({ keepStorage: true });
  assert.strictEqual(b.ModManager.isExcursionActive(), false);

  sessionMap.set('deepsteve-excursion', JSON.stringify({ appId: 'workshop', stack: [{}, { sessionId: 'a' }] }));
  const c = await setup({ keepStorage: true });
  assert.strictEqual(c.ModManager.getExcursion().depth, 1, 'frames without a session are dropped');
});

test('the trail cannot grow without bound', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  bridgeFor(ModManager, 'workshop').visitSession('a');
  for (let i = 0; i < 60; i++) {
    state.live.add('s' + i);
    ModManager.noteExcursionDrill('s' + i);
  }
  assert.strictEqual(ModManager.getExcursion().depth, 20);
});
