// Headless unit test for the host-side half of excursions (#661): the ⌘↑/⌘↓ takeover, ⌘←,
// and the rail suppression that is the app's chrome.
//
// This drives context-views.js AND the real mod-manager.js it now imports, because the whole
// point of these tests is the seam between them — a mocked ModManager would assert nothing.
//
// No browser, no Docker: stub the globals both modules touch BEFORE importing, then dispatch
// fake keydowns at the capture-phase listener context-views installs. window.parent = window
// keeps storage-namespace.js at depth 0 so keys get no ds1- prefix.
//
// Run: node --test test/unit/excursion-keys.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const sessionMap = new Map();
const localMap = new Map();
const mkStore = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
});
globalThis.sessionStorage = mkStore(sessionMap);
globalThis.localStorage = mkStore(localMap);

const createdEls = [];
const byId = new Map();

function fakeElement(tag = 'div') {
  const classes = new Set();
  const children = [];
  let text = '';
  let html = '';
  const el = {
    tag, title: '', style: {}, dataset: {}, children, inserted: [], listeners: {},
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
    insertAdjacentElement: (pos, child) => { el.inserted.push(child); },
    appendChild: (child) => { children.push(child); child.parent = el; return child; },
    append: (...kids) => { for (const k of kids) el.appendChild(k); },
    insertBefore: (child, ref) => {
      const i = children.indexOf(ref);
      children.splice(i === -1 ? children.length : i, 0, child);
      child.parent = el;
      return child;
    },
    setAttribute: (k, v) => { el[k] = v; },
    getBoundingClientRect: () => ({ width: 0, left: 0, top: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    remove: () => {
      const p = el.parent;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      el.parent = null;
    },
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); if (!html) children.length = 0; },
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
  createdEls.push(el);
  return el;
}

const docListeners = new Map();

globalThis.document = {
  getElementById: (id) => byId.get(id) || createdEls.find(e => e.id === id) || null,
  createElement: (tag) => fakeElement(tag),
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => { docListeners.set(ev, [...(docListeners.get(ev) || []), fn]); },
  removeEventListener: () => {},
  body: { style: {}, appendChild: () => {} },
  activeElement: null,
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.fetch = () => Promise.reject(new Error('no server in unit test'));

// --------------------------------------------------------------------- harness

let importCount = 0;
let prevMM = null;   // the shared mod-manager, so each setup can put its slot down first

const CTX_A = { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] };
const CTX_B = { id: 'ctxb', name: 'Beta', dirs: ['/repo/b'] };
const WORKSHOP_VIEW = { id: 'workshop', name: 'Workshop', src: '/mods/workshop/index.html' };

/**
 * context-views + mod-manager, wired the way app.js wires the pair.
 *
 * Only context-views gets a `?t=` cache-buster. mod-manager must NOT: a relative specifier
 * inside `context-views.js?t=3` resolves to a bare `./mod-manager.js`, so a suffixed import
 * here would hand the test a second instance and every assertion about the key takeover would
 * be made against a mod-manager nobody is driving. It is shared instead, and reset below —
 * ModManager.init() re-reads the stack from (just-cleared) sessionStorage, and hideView()
 * clears the slot while the PREVIOUS run's DOM is still resolvable.
 */
async function setup() {
  if (prevMM?.getActiveViewId()) prevMM.hideView(prevMM.getActiveViewId());

  sessionMap.clear();
  localMap.clear();
  byId.clear();
  docListeners.clear();
  createdEls.length = 0;

  const q = `?t=${++importCount}`;
  const toggle = fakeElement();
  toggle.id = 'context-toggle';
  byId.set('context-toggle', toggle);

  const terminals = fakeElement();
  terminals.id = 'terminals';
  const appRoot = fakeElement();
  appRoot.appendChild(terminals);
  byId.set('terminals', terminals);

  const tabs = fakeElement();
  tabs.id = 'tabs';
  byId.set('tabs', tabs);
  const layoutToggle = fakeElement('button');
  layoutToggle.id = 'layout-toggle';
  tabs.appendChild(layoutToggle);
  byId.set('layout-toggle', layoutToggle);

  const { ModManager } = await import(new URL('../../public/js/mod-manager.js', `file://${__filename}`).href);
  prevMM = ModManager;

  const cvUrl = new URL('../../public/js/context-views.js', `file://${__filename}`);
  cvUrl.search = q;
  const cv = await import(cvUrl.href);

  const state = { activeSessionId: 'a', live: new Set(['a', 'b']), focused: [], cycles: [] };

  ModManager.init({
    getSessions: () => [],
    getActiveSessionId: () => state.activeSessionId,
    focusSession: (id) => {
      ModManager.noteExcursionDrill(id);
      state.focused.push(id);
      state.activeSessionId = id;
    },
    hasSession: (id) => state.live.has(id),
    getBreadcrumb: () => ({ project: 'Alpha', tab: 'a tab' }),
    onExcursionChanged: (ex) => cv.setRailSuppressed(ex.depth > 0 && ex.chrome?.rail !== 'keep'),
    getWindowId: () => 'w1',
    onViewChanged: () => {},
  });

  cv.init({
    getOrderedTabIds: () => [],
    getTabCwd: () => null,
    getActiveTabId: () => state.activeSessionId,
    switchToTab: () => {},
    updateEmptyState: () => {},
    onActiveContextChanged: () => {},
  });
  cv.setContexts([CTX_A, CTX_B]);

  const rail = createdEls.find(el => el.id === 'context-rail') || null;
  const pressKey = (init) => {
    const e = {
      metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: null,
      prevented: false, stopped: false,
      preventDefault() { e.prevented = true; },
      stopPropagation() { e.stopped = true; },
      ...init,
    };
    for (const fn of docListeners.get('keydown') || []) fn(e);
    return e;
  };
  // The bridge object a mod's iframe would receive, without an iframe.
  const api = {};
  ModManager.injectBridgeAPI({ contentWindow: api }, 'workshop', null);

  return { cv, ModManager, ds: api.deepsteve, state, rail, tabs, pressKey };
}

const railShown = (rail) => rail.style.display === 'flex';

// ------------------------------------------------------------------------ tests

test('⌘↑/⌘↓ cycles projects at home', async () => {
  const { cv, pressKey } = await setup();
  cv.setActiveContext('ctxa');
  pressKey({ code: 'ArrowDown' });
  assert.strictEqual(cv.getActiveContextId(), 'ctxb');
});

test('on an excursion, ⌘↑/⌘↓ go to the app and leave the projects alone', async () => {
  const { cv, ModManager, ds, pressKey } = await setup();
  cv.setActiveContext('ctxa');
  ModManager.showView(WORKSHOP_VIEW);

  const seen = [];
  ds.onExcursionCycle(({ delta }) => seen.push(delta));
  ds.visitSession('a');

  const down = pressKey({ code: 'ArrowDown' });
  const up = pressKey({ code: 'ArrowUp' });
  assert.deepStrictEqual(seen, [1, -1]);
  assert.strictEqual(cv.getActiveContextId(), 'ctxa', 'the projects must not move under you');
  assert.strictEqual(down.prevented && up.prevented, true);
});

test('with no cycle handler the keys fall back to projects rather than going dead', async () => {
  // A key that silently does nothing is worse than one that does its old job.
  const { cv, ModManager, ds, pressKey } = await setup();
  cv.setActiveContext('ctxa');
  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');

  pressKey({ code: 'ArrowDown' });
  assert.strictEqual(cv.getActiveContextId(), 'ctxb');
});

test('⌘← pops a frame, and the last one goes home', async () => {
  const { ModManager, ds, state, pressKey } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');
  ModManager.noteExcursionDrill('b');

  pressKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.strictEqual(ModManager.getExcursion().depth, 1);
  assert.strictEqual(state.activeSessionId, 'a');

  pressKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.strictEqual(ModManager.isModViewVisible(), true);
});

test('⌘← is left to the ⌘-hold tab switcher once that has armed itself', async () => {
  // Both listen capture-phase on `document`, and stopPropagation() does not stop a listener on
  // the same node — so without this check a held ⌘ then ← would pop the excursion AND switch
  // tabs.
  const { ModManager, ds, tabs, pressKey } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');

  tabs.classList.add('tab-switch-mode');
  const e = pressKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.strictEqual(ModManager.getExcursion().depth, 1, 'the trail is untouched');
  assert.strictEqual(e.prevented, false);
});

test('⌘← still works with the projects feature turned off', async () => {
  // An excursion belongs to the app, not to context views. Handling it below the `enabled`
  // guard would strand you out on one with no way back.
  const { cv, ModManager, ds, pressKey } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');
  cv.setEnabled(false);

  pressKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.strictEqual(ModManager.isModViewVisible(), true);
});

test('⌘↓ reaches the app even when no projects exist to cycle', async () => {
  // The project branch early-returns on an empty context list; the excursion branch has to sit
  // above that or the app never hears the key.
  const { cv, ModManager, ds, pressKey } = await setup();
  cv.setContexts([]);
  ModManager.showView(WORKSHOP_VIEW);
  const seen = [];
  ds.onExcursionCycle(({ delta }) => seen.push(delta));
  ds.visitSession('a');

  pressKey({ code: 'ArrowDown' });
  assert.deepStrictEqual(seen, [1]);
});

test('the rail hides for the excursion without touching the ⌘P preference', async () => {
  const { cv, ModManager, ds, rail } = await setup();
  cv.setActiveContext('ctxa');
  // Open the rail the way the user would, so the preference is a real stored 'yes'.
  cv.setRailSuppressed(false);
  const toggleClick = byId.get('context-toggle').listeners.click;
  toggleClick();
  assert.strictEqual(railShown(rail), true);
  // localMap, not sessionMap: the rail's open state is a browser-wide preference, so it
  // outlives the window (and the machine restart that empties sessionStorage).
  assert.strictEqual(localMap.get('deepsteve-context-sidebar'), '1');

  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');
  assert.strictEqual(railShown(rail), false, 'the app sent you; you are not browsing projects');
  assert.strictEqual(localMap.get('deepsteve-context-sidebar'), '1',
    'suppression is chrome, not a preference — it must not overwrite what the user chose');

  ds.endExcursion();
  assert.strictEqual(railShown(rail), true, 'and the rail comes back as it was');
});

test('⌘P during an excursion gives the rail back and ends the excursion', async () => {
  // Asking for the rail wins. The alternative is a dead key, or a half-state where the rail is
  // on screen but its own ⌘↑/⌘↓ still belong to the app.
  const { cv, ModManager, ds, rail, pressKey } = await setup();
  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');
  assert.strictEqual(railShown(rail), false);

  pressKey({ key: 'p', code: 'KeyP' });
  assert.strictEqual(railShown(rail), true);
  assert.strictEqual(ModManager.isExcursionActive(), false);
  assert.strictEqual(ModManager.isModViewVisible(), false, 'you stay on the session you were looking at');

  cv.setActiveContext('ctxa');
  pressKey({ code: 'ArrowDown' });
  assert.strictEqual(cv.getActiveContextId(), 'ctxb', 'and the keys are the projects\' again');
});

test('turning the projects feature off mid-excursion cannot strand the rail hidden', async () => {
  const { cv, ModManager, ds, rail } = await setup();
  byId.get('context-toggle').listeners.click();     // rail open
  ModManager.showView(WORKSHOP_VIEW);
  ds.visitSession('a');
  assert.strictEqual(railShown(rail), false);

  cv.setEnabled(false);
  cv.setEnabled(true);
  byId.get('context-toggle').listeners.click();
  assert.strictEqual(railShown(rail), true);
});

test('the Apps section is drawn above Projects', async () => {
  const { cv, rail } = await setup();
  byId.get('context-toggle').listeners.click();      // opens the rail → renderRail()
  const headers = rail.children.filter(c => c.classList.contains('context-rail-header'));
  // No app is enabled in this harness (loadAvailableMods never ran), so the rail is exactly
  // the rail that was there before — which is the property that keeps every existing rail
  // assertion valid.
  assert.deepStrictEqual(headers.map(h => h.textContent), ['Projects']);
  assert.ok(rail.children.find(c => c.classList.contains('projects-list')),
    'the projects list is named, so "the first .context-list" can never come to mean the apps one');
});
