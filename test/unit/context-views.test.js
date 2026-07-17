// Headless unit test for public/js/context-views.js — revealTabContext (#547).
//
// No browser, no Docker: stub the handful of globals the module touches
// (window/document/sessionStorage/fetch) BEFORE importing it, then drive the
// exported API the way app.js does. window.parent = window keeps
// storage-namespace.js at depth 0 so keys get no ds1- prefix. Each test
// re-imports the module with a unique ?query so its module-level state
// (contexts, activeContextId, cb) starts fresh.
//
// Run: node --test test/unit/context-views.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};

function fakeElement() {
  const classes = new Set();
  return {
    id: '', className: '', textContent: '', title: '', innerHTML: '',
    style: {},
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
    addEventListener: () => {},
    insertAdjacentElement: () => {},
    appendChild: () => {},
    remove: () => {},
  };
}

// Registry of fake tab elements, keyed by tab id (getElementById('tab-<id>')).
const tabEls = new Map();

globalThis.document = {
  getElementById: (id) => (id.startsWith('tab-') ? tabEls.get(id.slice(4)) || null : null),
  createElement: () => fakeElement(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: { appendChild: () => {} },
  activeElement: null,
};

globalThis.window = { dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window; // depth 0 → unprefixed storage keys

// Reject so fetchContexts()'s .catch swallows it and never clobbers the
// contexts a test sets via setContexts() (a resolving stub would setContexts([])
// on a later microtask).
globalThis.fetch = () => Promise.reject(new Error('no server in unit test'));

// ------------------------------------------------------------------- harness

const CTX_A = { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] };
const CTX_B = { id: 'ctxb', name: 'Beta', dirs: ['/repo/b'] };

let importCount = 0;

// Fresh module + fake app.js wiring. Mirrors the app.js side of the contract:
// tabs registry, active tab id, and the initContextViews callbacks.
async function setup({ contexts = [CTX_A, CTX_B], tabs = {} } = {}) {
  storeMap.clear();
  tabEls.clear();

  const state = {
    tabCwds: {},        // id → cwd (null = global tab)
    activeTabId: null,
    switchCalls: [],    // switchToTab invocations from context-views (snap-back)
    createInDirCalls: [], // createSessionInDir(cwd) invocations (#581)
    promptDirCalls: 0,  // promptNewTabDir() invocations (#581)
  };

  const url = new URL('../../public/js/context-views.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);

  mod.init({
    getOrderedTabIds: () => Object.keys(state.tabCwds),
    getTabCwd: (id) => state.tabCwds[id] ?? null,
    getActiveTabId: () => state.activeTabId,
    switchToTab: (id) => { state.switchCalls.push(id); state.activeTabId = id; },
    updateEmptyState: () => {},
    onActiveContextChanged: () => {},
    createSessionInDir: (cwd) => { state.createInDirCalls.push(cwd); },
    promptNewTabDir: () => { state.promptDirCalls++; },
  });
  mod.setContexts(contexts);

  const addTab = (id, cwd) => { state.tabCwds[id] = cwd; tabEls.set(id, fakeElement()); };
  // What app.js does when a non-restore creation lands: add the tab, switch to
  // it (switchTo also notes it as the context's last tab), then reveal (#547).
  // switchCalls is reset here so assertions see only snap-backs caused by the
  // creation+reveal itself (selecting a context earlier in the test may have
  // legitimately snap-switched to that context's first tab).
  const openNewTab = (id, cwd) => {
    state.switchCalls.length = 0;
    addTab(id, cwd);
    state.activeTabId = id;
    mod.noteActiveTab(id);
    mod.revealTabContext(id);
  };
  // What app.js's focusTab(id) does when jumping to an EXISTING tab (#559):
  // activate it (noteActiveTab records it) then reveal its context. Same sequence
  // as openNewTab minus the addTab — the tab already exists (and may be
  // context-hidden). switchCalls is reset so assertions see only snap-backs
  // caused by the jump itself.
  const jumpToTab = (id) => {
    state.switchCalls.length = 0;
    state.activeTabId = id;
    mod.noteActiveTab(id);
    mod.revealTabContext(id);
  };

  for (const [id, cwd] of Object.entries(tabs)) addTab(id, cwd);
  return { mod, state, addTab, openNewTab, jumpToTab };
}

const isHidden = (id) => tabEls.get(id).classList.contains('context-hidden');

// --------------------------------------------------------------------- tests

test('new tab in another context → switches to that context', async () => {
  const { mod, state, openNewTab } = await setup({ tabs: { tab1: '/repo/a' } });
  mod.setActiveContext('ctxa');

  openNewTab('tab2', '/repo/b/sub');

  assert.strictEqual(mod.getActiveContextId(), 'ctxb');
  assert.strictEqual(isHidden('tab2'), false);
  assert.strictEqual(isHidden('tab1'), true); // old context's tab filtered out
  // No #541 snap-back: the new tab stayed active through the switch.
  assert.deepStrictEqual(state.switchCalls, []);
  assert.strictEqual(state.activeTabId, 'tab2');
  // Recorded as the destination context's last-viewed tab (#541).
  const lastTabs = JSON.parse(storeMap.get('deepsteve-context-last-tab'));
  assert.strictEqual(lastTabs.ctxb, 'tab2');
});

test('new tab matching no context → switches to All', async () => {
  const { mod, state, openNewTab } = await setup({ tabs: { tab1: '/repo/a' } });
  mod.setActiveContext('ctxa');

  openNewTab('tab2', '/elsewhere/repo');

  assert.strictEqual(mod.getActiveContextId(), null);
  assert.strictEqual(isHidden('tab2'), false);
  assert.strictEqual(isHidden('tab1'), false); // All shows everything
  assert.deepStrictEqual(state.switchCalls, []);
});

test('new tab inside the active context → no switch', async () => {
  const { mod, state, openNewTab } = await setup({ tabs: { tab1: '/repo/a' } });
  mod.setActiveContext('ctxa');

  openNewTab('tab2', '/repo/a/nested');

  assert.strictEqual(mod.getActiveContextId(), 'ctxa');
  assert.strictEqual(isHidden('tab2'), false);
  assert.deepStrictEqual(state.switchCalls, []);
});

test('global tab (no cwd) → no switch', async () => {
  const { mod, openNewTab } = await setup({ tabs: { tab1: '/repo/a' } });
  mod.setActiveContext('ctxa');

  openNewTab('tab2', null);

  assert.strictEqual(mod.getActiveContextId(), 'ctxa');
  assert.strictEqual(isHidden('tab2'), false); // no-cwd tabs are global
});

test('All view active → no-op regardless of cwd', async () => {
  const { mod, openNewTab } = await setup({ tabs: { tab1: '/repo/a' } });

  openNewTab('tab2', '/repo/b');

  assert.strictEqual(mod.getActiveContextId(), null);
  assert.strictEqual(isHidden('tab2'), false);
});

test('feature disabled → no-op', async () => {
  const { mod, addTab, state } = await setup({ tabs: { tab1: '/repo/a' } });
  mod.setActiveContext('ctxa');
  mod.setEnabled(false);

  addTab('tab2', '/repo/b');
  state.activeTabId = 'tab2';
  mod.revealTabContext('tab2');

  assert.strictEqual(mod.getActiveContextId(), 'ctxa');
});

test('two matching contexts → first in rail order wins', async () => {
  const ctxB2 = { id: 'ctxb2', name: 'Beta Two', dirs: ['/repo/b'] };
  const { mod, openNewTab } = await setup({
    contexts: [CTX_A, CTX_B, ctxB2],
    tabs: { tab1: '/repo/a' },
  });
  mod.setActiveContext('ctxa');

  openNewTab('tab2', '/repo/b/x');

  assert.strictEqual(mod.getActiveContextId(), 'ctxb');
});

test('contexts not yet loaded (empty list) → fails open, no switch', async () => {
  const { mod, openNewTab } = await setup({ contexts: [], tabs: { tab1: '/repo/a' } });

  openNewTab('tab2', '/repo/b');

  assert.strictEqual(mod.getActiveContextId(), null); // was already All; unchanged
  assert.strictEqual(isHidden('tab2'), false);
});

// #559: focusTab() routes every "jump to an existing tab" affordance (Action
// Required, cross-window focus, restore, …) through revealTabContext, so the
// context rail follows the jump — not just new-tab creation (#547).

test('jump to an existing tab in another context → reveals that context (#559)', async () => {
  const { mod, state, jumpToTab } = await setup({ tabs: { tab1: '/repo/a', tab2: '/repo/b' } });
  mod.setActiveContext('ctxa');
  assert.strictEqual(isHidden('tab2'), true); // precondition: out-of-context tab hidden

  jumpToTab('tab2');

  assert.strictEqual(mod.getActiveContextId(), 'ctxb');
  assert.strictEqual(isHidden('tab2'), false);
  assert.strictEqual(isHidden('tab1'), true);  // old context's tab filtered out
  assert.deepStrictEqual(state.switchCalls, []); // no snap-back thrash after the reveal
  assert.strictEqual(state.activeTabId, 'tab2');
  // Recorded as the destination context's last-viewed tab (#541).
  const lastTabs = JSON.parse(storeMap.get('deepsteve-context-last-tab'));
  assert.strictEqual(lastTabs.ctxb, 'tab2');
});

test('jump to an existing tab already in the active context → no switch (#559)', async () => {
  const { mod, state, jumpToTab } = await setup({ tabs: { tab1: '/repo/a', tab1b: '/repo/a/sub' } });
  mod.setActiveContext('ctxa');

  jumpToTab('tab1b');

  assert.strictEqual(mod.getActiveContextId(), 'ctxa'); // unchanged
  assert.strictEqual(isHidden('tab1b'), false);
  assert.strictEqual(isHidden('tab1'), false);
  assert.deepStrictEqual(state.switchCalls, []);
  assert.strictEqual(state.activeTabId, 'tab1b');
});

// #573: orderRecentDirsByContext — the pure ordering helper the new-tab menu and
// dir picker use to list the active context's repos first, then the rest of the
// recents. No DOM / module state involved; just import the module for the export.

test('orderRecentDirsByContext: no context → passthrough, same order (#573)', async () => {
  const { mod } = await setup();
  const recents = [{ path: '/repo/b', lastUsed: 2 }, { path: '/repo/c', lastUsed: 1 }];
  const { contextGroup, rest } = mod.orderRecentDirsByContext([], recents);
  assert.deepStrictEqual(contextGroup, []);
  assert.deepStrictEqual(rest, recents); // rest preserves input order verbatim
});

test('orderRecentDirsByContext: context repos first in stored order, incl. ones absent from recents (#573)', async () => {
  const { mod } = await setup();
  const recents = [{ path: '/repo/b', lastUsed: 2 }];
  const { contextGroup, rest } = mod.orderRecentDirsByContext(['/repo/a', '/repo/c'], recents);
  assert.deepStrictEqual(contextGroup, [{ path: '/repo/a' }, { path: '/repo/c' }]);
  assert.deepStrictEqual(rest, [{ path: '/repo/b', lastUsed: 2 }]);
});

test('orderRecentDirsByContext: exact-path match is deduped out of rest (#573)', async () => {
  const { mod } = await setup();
  const recents = [{ path: '/repo/a', lastUsed: 3 }, { path: '/repo/b', lastUsed: 2 }];
  const { contextGroup, rest } = mod.orderRecentDirsByContext(['/repo/a'], recents);
  assert.deepStrictEqual(contextGroup, [{ path: '/repo/a' }]);
  assert.deepStrictEqual(rest, [{ path: '/repo/b', lastUsed: 2 }]); // /repo/a shown once, up top
});

test('orderRecentDirsByContext: trailing-slash-insensitive dedup (#573)', async () => {
  const { mod } = await setup();
  const recents = [{ path: '/repo/a', lastUsed: 1 }];
  const { contextGroup, rest } = mod.orderRecentDirsByContext(['/repo/a/'], recents);
  assert.deepStrictEqual(contextGroup, [{ path: '/repo/a/' }]);
  assert.deepStrictEqual(rest, []); // '/repo/a' matches '/repo/a/'
});

test('orderRecentDirsByContext: a recent SUBDIR of a context repo stays in rest (#573)', async () => {
  const { mod } = await setup();
  const recents = [{ path: '/repo/a/sub', lastUsed: 1 }];
  const { contextGroup, rest } = mod.orderRecentDirsByContext(['/repo/a'], recents);
  assert.deepStrictEqual(contextGroup, [{ path: '/repo/a' }]);
  assert.deepStrictEqual(rest, [{ path: '/repo/a/sub', lastUsed: 1 }]); // not filtered — distinct quick-pick
});

// #573: getActiveContextInfo — the getter the new-tab menu + dir picker read to
// decide whether to show a context group. Must return null in exactly the cases
// where both surfaces should render "as today": All view and feature-disabled.

test('getActiveContextInfo: active context → {name, dirs} snapshot (#573)', async () => {
  const { mod } = await setup(); // CTX_A = { name:'Alpha', dirs:['/repo/a'] }
  mod.setActiveContext('ctxa');
  assert.deepStrictEqual(mod.getActiveContextInfo(), { name: 'Alpha', dirs: ['/repo/a'] });
});

test('getActiveContextInfo: All view → null (#573)', async () => {
  const { mod } = await setup();
  assert.strictEqual(mod.getActiveContextInfo(), null);
});

test('getActiveContextInfo: feature disabled → null even with an active context (#573)', async () => {
  const { mod } = await setup();
  mod.setActiveContext('ctxa');
  mod.setEnabled(false);
  assert.strictEqual(mod.getActiveContextInfo(), null);
});

test('getActiveContextInfo: returned dirs is a copy, not the live array (#573)', async () => {
  const multi = { id: 'ctxm', name: 'Multi', dirs: ['/repo/a', '/repo/b'] };
  const { mod } = await setup({ contexts: [multi] });
  mod.setActiveContext('ctxm');
  const info = mod.getActiveContextInfo();
  info.dirs.push('/repo/c');                       // mutate the snapshot
  assert.deepStrictEqual(mod.getActiveContextInfo().dirs, ['/repo/a', '/repo/b']); // source intact
});

// #581: requestNewTabInContext — the guard quickNewSession() calls before it
// would inherit the active tab's cwd. It must OWN every case where inheriting
// would leak into a foreign context, and only return false when inheriting is
// safe (All view, or an active tab already inside the active context). The
// crux: an empty context with NO dirs must prompt a directory picker, not fall
// through to inherit a hidden foreign tab's cwd.

const EMPTY_CTX = { id: 'empty', name: 'Empty', dirs: [] };

test('empty (no-dirs) context, nothing open → prompts dir picker, no inherit (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A, EMPTY_CTX], tabs: {} });
  mod.setActiveContext('empty');

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, true);              // owned — quickNewSession must not fall through
  assert.strictEqual(state.promptDirCalls, 1);    // prompted for a directory
  assert.deepStrictEqual(state.createInDirCalls, []);
});

test('empty (no-dirs) context with a hidden foreign active tab → prompts, never inherits its cwd (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A, EMPTY_CTX], tabs: { tab1: '/repo/a' } });
  state.activeTabId = 'tab1';                      // the leak source: active tab lives in ctxa
  mod.setActiveContext('empty');                  // switching here can't move off tab1 (no visible tab)

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, true);
  assert.strictEqual(state.promptDirCalls, 1);
  assert.deepStrictEqual(state.createInDirCalls, []); // did NOT open in /repo/a
  assert.strictEqual(mod.getActiveContextId(), 'empty'); // stayed in the chosen context
});

test('context with one repo, empty of tabs → opens in that repo (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: {} });
  mod.setActiveContext('ctxa');

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, true);
  assert.deepStrictEqual(state.createInDirCalls, ['/repo/a']); // context's single repo
  assert.strictEqual(state.promptDirCalls, 0);
});

test('context with one repo + hidden foreign active tab → opens in the repo, not the foreign cwd (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A, CTX_B], tabs: { tab1: '/repo/b' } });
  state.activeTabId = 'tab1';                      // active tab is in ctxb
  mod.setActiveContext('ctxa');

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, true);
  assert.deepStrictEqual(state.createInDirCalls, ['/repo/a']);
  assert.strictEqual(state.promptDirCalls, 0);
});

test('active tab already inside the active context → default inherit path (returns false) (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: { tab1: '/repo/a/sub' } });
  state.activeTabId = 'tab1';
  mod.setActiveContext('ctxa');

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, false);             // quickNewSession inherits /repo/a/sub — stays in-context
  assert.strictEqual(state.promptDirCalls, 0);
  assert.deepStrictEqual(state.createInDirCalls, []);
});

test('All view → default inherit path (returns false) (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: { tab1: '/repo/a' } });
  state.activeTabId = 'tab1';                      // no setActiveContext → All

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, false);
  assert.strictEqual(state.promptDirCalls, 0);
  assert.deepStrictEqual(state.createInDirCalls, []);
});

test('feature disabled → default inherit path (returns false) (#581)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A, EMPTY_CTX], tabs: {} });
  mod.setActiveContext('empty');
  mod.setEnabled(false);

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, false);
  assert.strictEqual(state.promptDirCalls, 0);
});
