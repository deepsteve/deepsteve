// Headless unit test for public/js/overview-mode.js — per-context overview state
// and the size-restore contract (#590).
//
// No browser, no Docker: stub the globals the module touches (document /
// sessionStorage / localStorage / MutationObserver / requestAnimationFrame)
// BEFORE importing it, then drive the exported API the way app.js does.
// window.parent = window keeps storage-namespace.js at depth 0 so keys get no
// ds1- prefix. requestAnimationFrame runs its callback synchronously so the
// fit / restore calls are observable right after the action that queued them.
//
// The two bugs this pins:
//   1. an overview opened in context A stayed on screen after switching to B
//   2. terminals shrunk into the grid never got their size back, because
//      FitAddon silently no-ops on a display:none container
//
// Run: node --test test/unit/overview-mode.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const sessionMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
  setItem: (k, v) => sessionMap.set(k, String(v)),
  removeItem: (k) => sessionMap.delete(k),
};

const localMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
  setItem: (k, v) => localMap.set(k, String(v)),
  removeItem: (k) => localMap.delete(k),
};

// Callbacks run inline: every assertion in this file is about state the module
// settles on, not about frame timing.
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };

// The module only uses the observer to notice containers appearing/disappearing
// under #terminals. Capture it so a test can fire it by hand.
let observerCb = null;
globalThis.MutationObserver = class {
  constructor(cb) { observerCb = cb; }
  observe() {}
  disconnect() { observerCb = null; }
};

function fakeElement(className = '') {
  const classes = new Set(className.split(' ').filter(Boolean));
  const children = [];
  const el = {
    id: '',
    style: {
      display: '',
      setProperty: (k, v) => { el.style[k] = v; },
      removeProperty: (k) => { delete el.style[k]; },
    },
    children,
    textContent: '',
    title: '',
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    // Selector support is deliberately minimal: the module only ever queries by
    // a chain of class names.
    matches: (sel) => sel.split('.').filter(Boolean).every(c => classes.has(c)),
    querySelector: (sel) => children.find(c => c.matches(sel)) || null,
    querySelectorAll: (sel) => children.filter(c => c.matches(sel)),
    appendChild: (child) => {
      const at = children.indexOf(child);
      if (at !== -1) children.splice(at, 1);   // appendChild MOVES an existing node
      children.push(child);
      child.parentNode = el;
      return child;
    },
    remove: () => {
      const p = el.parentNode;
      if (!p) return;
      const at = p.children.indexOf(el);
      if (at !== -1) p.children.splice(at, 1);
      el.parentNode = null;
    },
    addEventListener: () => {},
  };
  return el;
}

// #terminals needs a recursive querySelectorAll — it looks for
// '.terminal-container...' among its container children.
function fakeTerminalsEl() {
  const el = fakeElement();
  const own = el.querySelectorAll;
  el.querySelectorAll = (sel) => own(sel);
  return el;
}

const byId = new Map();
globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: () => fakeElement(),
  addEventListener: () => {},
  removeEventListener: () => {},
};

globalThis.window = { dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window; // depth 0 → unprefixed storage keys

// ------------------------------------------------------------------- harness

let importCount = 0;

// Two contexts, each with its own tabs. getOrderedTabIds returns only the ACTIVE
// context's tabs, mirroring app.js's getVisibleTabIds (which drops
// .context-hidden tabs).
async function setup({ freshStorage = true } = {}) {
  if (freshStorage) sessionMap.clear();
  localMap.clear();
  byId.clear();
  observerCb = null;

  const terminals = fakeTerminalsEl();
  byId.set('terminals', terminals);
  byId.set('tabs-list', fakeElement());
  byId.set('overview-layout-btn', fakeElement());
  byId.set('overview-exit-btn', fakeElement());

  const state = {
    activeContextId: null,
    activeTabId: null,
    tabsByContext: {},        // contextKey → [id]
    sessions: new Map(),      // id → {container, term, waitingForInput}
    fitCalls: [],             // each fitTerminals(ids) invocation
    restoreCalls: [],         // each restoreTerminals(dims) invocation, as arrays
    activateCalls: [],
    switchCalls: [],
  };

  const addTab = (contextKey, id, cols, rows) => {
    const container = fakeElement('terminal-container');
    container.id = `term-${id}`;
    byId.set(container.id, container);
    terminals.appendChild(container);
    (state.tabsByContext[contextKey] ||= []).push(id);
    state.sessions.set(id, { container, term: { cols, rows }, waitingForInput: false });
  };

  const url = new URL('../../public/js/overview-mode.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);

  mod.init({
    getOrderedTabIds: () => state.tabsByContext[state.activeContextId || '__all__'] || [],
    getActiveTabId: () => state.activeTabId,
    getActiveContextId: () => state.activeContextId,
    getSession: (id) => state.sessions.get(id),
    getTabName: (id) => id,
    switchToTab: (id) => { state.switchCalls.push(id); state.activeTabId = id; },
    activateTab: (id) => { state.activateCalls.push(id); state.activeTabId = id; },
    fitTerminals: (ids) => {
      state.fitCalls.push([...ids]);
      // Fitting is what shrinks a tile — model it so a restore has something to undo.
      for (const id of ids) {
        const s = state.sessions.get(id);
        if (s) { s.term.cols = 40; s.term.rows = 12; }
      }
    },
    restoreTerminals: (dims) => { state.restoreCalls.push([...dims.entries()]); },
  });

  // Switch context the way app.js does: flip the id, then let applyFilter's
  // onContextViewApplied hook reconcile the grid.
  const switchContext = (id) => {
    state.activeContextId = id;
    state.activeTabId = (state.tabsByContext[id || '__all__'] || [])[0] || null;
    mod.syncToContext();
  };

  return { mod, state, terminals, addTab, switchContext };
}

const isTile = (state, id) => state.sessions.get(id).container.classList.contains('overview-visible');

// --------------------------------------------------------------------- tests

test('toggle tiles the active context and fits only its tabs', async () => {
  const { mod, state, terminals, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxa', 'a2', 200, 50);
  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');

  mod.toggle();

  assert.strictEqual(mod.isOverviewActive(), true);
  assert.strictEqual(terminals.classList.contains('overview-mode'), true);
  assert.strictEqual(isTile(state, 'a1'), true);
  assert.strictEqual(isTile(state, 'a2'), true);
  // The out-of-context terminal is neither tiled nor resized — that collateral
  // fit is what stranded other contexts' tabs at tile size.
  assert.strictEqual(isTile(state, 'b1'), false);
  assert.deepStrictEqual(state.fitCalls, [['a1', 'a2']]);
  assert.strictEqual(state.sessions.get('b1').term.cols, 200);
});

test('switching context hides the grid and restores the tiles pre-overview size', async () => {
  const { mod, state, terminals, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxa', 'a2', 180, 44);
  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');
  mod.toggle();

  switchContext('ctxb');

  // Bug 1: the grid is gone, not sitting over context B's tabs.
  assert.strictEqual(mod.isOverviewActive(), false);
  assert.strictEqual(terminals.classList.contains('overview-mode'), false);
  assert.strictEqual(isTile(state, 'a1'), false);
  assert.strictEqual(isTile(state, 'a2'), false);
  assert.strictEqual(state.sessions.get('a1').container.querySelector('.overview-label'), null);

  // Bug 2: every tile is handed back the exact grid it had before the overview,
  // including the ones that are display:none by now and so cannot be fitted.
  assert.deepStrictEqual(state.restoreCalls, [[
    ['a1', { cols: 200, rows: 50 }],
    ['a2', { cols: 180, rows: 44 }],
  ]]);

  // A container is left active so the terminal area isn't blank, and it went
  // through the non-revealing path — focusTab would have bounced back to ctxa.
  assert.deepStrictEqual(state.activateCalls, ['b1']);
  assert.deepStrictEqual(state.switchCalls, []);
});

test('switching back re-shows that context grid', async () => {
  const { mod, state, terminals, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');
  mod.toggle();
  switchContext('ctxb');

  switchContext('ctxa');

  assert.strictEqual(mod.isOverviewActive(), true);
  assert.strictEqual(terminals.classList.contains('overview-mode'), true);
  assert.strictEqual(isTile(state, 'a1'), true);
  assert.strictEqual(isTile(state, 'b1'), false);
});

test('a context without overview stays in normal view when switched to', async () => {
  const { mod, state, terminals, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');
  mod.toggle();

  switchContext('ctxb');

  assert.strictEqual(mod.isOverviewActive(), false);
  assert.strictEqual(isTile(state, 'b1'), false);
  assert.strictEqual(terminals.classList.contains('overview-mode'), false);
  // ctxb's terminal was never fitted into a grid, so nothing to restore for it.
  assert.deepStrictEqual(state.fitCalls, [['a1']]);
});

test('exit clears the context flag — switching back does NOT re-show', async () => {
  const { mod, addTab, switchContext, state } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');
  mod.toggle();

  mod.toggle();                       // Cmd+O again = exit
  assert.strictEqual(mod.isOverviewActive(), false);
  assert.deepStrictEqual(state.switchCalls, ['a1']);  // revealing path, unlike a context switch

  switchContext('ctxb');
  switchContext('ctxa');
  assert.strictEqual(mod.isOverviewActive(), false);
});

test('per-context state persists across a reload', async () => {
  const first = await setup();
  first.addTab('ctxa', 'a1', 200, 50);
  first.switchContext('ctxa');
  first.mod.toggle();
  assert.strictEqual(first.mod.isOverviewActive(), true);

  // Reload: fresh module + fresh DOM, same sessionStorage.
  const { mod, state, addTab, switchContext } = await setup({ freshStorage: false });
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxb', 'b1', 200, 50);
  assert.strictEqual(mod.isOverviewActive(), false);   // nothing rendered until the sync

  switchContext('ctxa');
  assert.strictEqual(mod.isOverviewActive(), true);
  assert.strictEqual(isTile(state, 'a1'), true);

  switchContext('ctxb');
  assert.strictEqual(mod.isOverviewActive(), false);
});

test('a tab created into the shown grid is tiled and its size remembered', async () => {
  const { mod, state, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  switchContext('ctxa');
  mod.toggle();

  addTab('ctxa', 'a2', 180, 44);
  observerCb();                      // #terminals childList mutation

  assert.strictEqual(isTile(state, 'a2'), true);
  assert.deepStrictEqual(state.fitCalls, [['a1'], ['a2']]);

  switchContext('ctxb');
  // a2's ORIGINAL size is restored, not the tile size it was fitted to.
  assert.deepStrictEqual(state.restoreCalls, [[
    ['a1', { cols: 200, rows: 50 }],
    ['a2', { cols: 180, rows: 44 }],
  ]]);
});

test('disabling the feature clears every context grid', async () => {
  const { mod, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');
  mod.toggle();
  switchContext('ctxb');
  mod.toggle();
  assert.strictEqual(mod.isOverviewActive(), true);

  mod.setEnabled(false);
  assert.strictEqual(mod.isOverviewActive(), false);

  mod.setEnabled(true);
  switchContext('ctxa');
  assert.strictEqual(mod.isOverviewActive(), false);   // not resurrected
});

test('toggle in an empty context does not arm a phantom grid', async () => {
  const { mod, addTab, switchContext } = await setup();
  addTab('ctxa', 'a1', 200, 50);
  switchContext('ctxb');            // no tabs

  mod.toggle();
  assert.strictEqual(mod.isOverviewActive(), false);

  addTab('ctxb', 'b1', 200, 50);
  switchContext('ctxa');
  switchContext('ctxb');
  assert.strictEqual(mod.isOverviewActive(), false);
});
