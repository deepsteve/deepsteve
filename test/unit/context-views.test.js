// Headless unit test for public/js/context-views.js — revealTabContext (#547),
// new-tab context guards (#581), the closed-rail indicator + icon chip (#585),
// archive/unarchive (#601), and the project-mod compact toggle on the row menu (#646).
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
const localMap = new Map();
const mkStore = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
});
globalThis.sessionStorage = mkStore(storeMap);
// Both stores, because the rail's *appearance* is a browser-wide preference and its
// *place* is per-window — the two halves live in different areas on purpose.
globalThis.localStorage = mkStore(localMap);

function fakeElement() {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    id: '', className: '', title: '',
    style: {},
    dataset: {},
    children,
    inserted: [],  // insertAdjacentElement targets (init() lands #context-indicator here)
    listeners: {}, // last handler per event type (toggleSidebar lives at listeners.click)
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
    insertAdjacentElement: (pos, child) => { el.inserted.push(child); },
    appendChild: (child) => { children.push(child); },
    setAttribute: () => {},
    getBoundingClientRect: () => ({ width: 0, left: 0, top: 0 }),
    remove: () => {},
  };
  // DOM fidelity renderRail() depends on: `innerHTML = ''` empties the element, so a
  // re-render replaces its rows instead of appending a second copy (#601 tests read
  // the rail's children back).
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); if (!html) children.length = 0; },
  });
  // DOM fidelity the indicator chip depends on: setting textContent drops the
  // element's children (applyContextIcon clears a previous <img> exactly this way).
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); children.length = 0; },
  });
  return el;
}

// Registry of fake tab elements, keyed by tab id (getElementById('tab-<id>')).
const tabEls = new Map();
// Non-tab elements resolvable by id, seeded per setup(). 'context-toggle' lives
// here so init() builds the indicator; 'app-container'/'app-main' deliberately
// stay unresolved (their init paths are guarded and irrelevant to these tests).
const byId = new Map();

// Document-level listeners the module installs in init() (keydown/keyup), keyed by
// type — so tests can dispatch a fake key event (⌘↑/↓ cycling, #601).
const docListeners = new Map();
// Every element the module creates, in order — the rail (#context-rail) is mounted
// into an #app-container this harness doesn't stub, so this is how tests reach it.
const createdEls = [];

globalThis.document = {
  getElementById: (id) => (id.startsWith('tab-') ? tabEls.get(id.slice(4)) || null : byId.get(id) || null),
  createElement: () => { const el = fakeElement(); createdEls.push(el); return el; },
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => { docListeners.set(ev, [...(docListeners.get(ev) || []), fn]); },
  removeEventListener: () => {},
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
async function setup({ contexts = [CTX_A, CTX_B], tabs = {}, session = {}, local = {}, extraCb = {} } = {}) {
  storeMap.clear();
  localMap.clear();
  for (const [k, v] of Object.entries(session)) storeMap.set(k, String(v));
  for (const [k, v] of Object.entries(local)) localMap.set(k, String(v));
  tabEls.clear();
  byId.clear();
  docListeners.clear();
  createdEls.length = 0;
  const toggle = fakeElement();  // #context-toggle — init() hangs the indicator off it
  byId.set('context-toggle', toggle);

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
    // Project views (#726) and anything else a test wants to wire in.
    ...extraCb,
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

  // #585 indicator handles: init() inserted the indicator after the toggle, with
  // [icon chip, label] children.
  const indicator = toggle.inserted[0] || null;
  const rail = createdEls.find(el => el.id === 'context-rail') || null;
  // Dispatch a keydown at the document listeners the module installed (⌘↑/↓, #601).
  const pressKey = (init) => {
    const e = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null,
      preventDefault: () => {}, stopPropagation: () => {}, ...init };
    for (const fn of docListeners.get('keydown') || []) fn(e);
  };
  return {
    mod, state, addTab, openNewTab, jumpToTab, toggle, indicator, rail, pressKey,
    indicatorIcon: indicator?.children[0] || null,
    indicatorLabel: indicator?.children[1] || null,
  };
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

// #598: resolveContextRepo — the pure descriptor requestNewTabInContext (above)
// and the GitHub issue picker in app.js now BOTH resolve through, so the issue
// picker can't fall back to a globally last-selected tab from a foreign context.
// The tests above are the regression net for the refactor; these pin the shape
// the issue picker reads.

const MULTI_CTX = { id: 'multi', name: 'Multi', dirs: ['/repo/a', '/repo/b'] };

test('resolveContextRepo: feature disabled → inherit with the active tab cwd (#598)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: { tab1: '/repo/a' } });
  state.activeTabId = 'tab1';
  mod.setActiveContext('ctxa');
  mod.setEnabled(false);

  assert.deepStrictEqual(mod.resolveContextRepo(), { kind: 'inherit', cwd: '/repo/a' });
});

test('resolveContextRepo: All view → inherit with the active tab cwd (#598)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: { tab1: '/repo/a' } });
  state.activeTabId = 'tab1';                      // no setActiveContext → All

  assert.deepStrictEqual(mod.resolveContextRepo(), { kind: 'inherit', cwd: '/repo/a' });
});

test('resolveContextRepo: active tab already in-context → inherit (#598)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: { tab1: '/repo/a/sub' } });
  state.activeTabId = 'tab1';
  mod.setActiveContext('ctxa');

  const d = mod.resolveContextRepo();
  assert.strictEqual(d.kind, 'inherit');
  assert.strictEqual(d.cwd, '/repo/a/sub');
});

test('resolveContextRepo: empty context + hidden foreign active tab → ask, never the foreign cwd (#598)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A, EMPTY_CTX], tabs: { tab1: '/repo/a' } });
  state.activeTabId = 'tab1';                      // the leak the issue reports
  mod.setActiveContext('empty');

  const d = mod.resolveContextRepo();
  assert.strictEqual(d.kind, 'ask');               // nothing inferable → caller must prompt
  assert.strictEqual(d.contextName, 'Empty');
  assert.strictEqual(JSON.stringify(d).includes('/repo/a'), false);
});

test('resolveContextRepo: single-repo context, empty of tabs → that repo (#598)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A, CTX_B], tabs: { tab1: '/repo/b' } });
  state.activeTabId = 'tab1';                      // active tab is in ctxb
  mod.setActiveContext('ctxa');

  const d = mod.resolveContextRepo();
  assert.strictEqual(d.kind, 'dirs');
  assert.deepStrictEqual(d.dirs, ['/repo/a']);     // NOT /repo/b
});

test('resolveContextRepo: multi-repo context → all dirs in stored order (#598)', async () => {
  const { mod } = await setup({ contexts: [MULTI_CTX], tabs: {} });
  mod.setActiveContext('multi');

  const d = mod.resolveContextRepo();
  assert.strictEqual(d.kind, 'dirs');
  assert.deepStrictEqual(d.dirs, ['/repo/a', '/repo/b']);
  assert.strictEqual(d.contextName, 'Multi');
});

test('resolveContextRepo: no-cwd active tab (mod/display) in a context → not inherit (#598)', async () => {
  const { mod, state } = await setup({ contexts: [CTX_A], tabs: { tab1: null } });
  state.activeTabId = 'tab1';                      // global tab: visible everywhere, no repo
  mod.setActiveContext('ctxa');

  // Inheriting a null cwd would leave the picker with nothing; the context's own
  // repo is the answer.
  const d = mod.resolveContextRepo();
  assert.strictEqual(d.kind, 'dirs');
  assert.deepStrictEqual(d.dirs, ['/repo/a']);
});

test('resolveContextRepo: dirs is a copy, not the live context array (#598)', async () => {
  const { mod } = await setup({ contexts: [MULTI_CTX], tabs: {} });
  mod.setActiveContext('multi');

  mod.resolveContextRepo().dirs.push('/repo/hacked');

  assert.deepStrictEqual(mod.resolveContextRepo().dirs, ['/repo/a', '/repo/b']);
  assert.deepStrictEqual(mod.getActiveContextInfo().dirs, ['/repo/a', '/repo/b']);
});

test('multi-repo context, empty of tabs → chooser owns it; no synchronous create (#598)', async () => {
  const { mod, state } = await setup({ contexts: [MULTI_CTX], tabs: {} });
  mod.setActiveContext('multi');

  const handled = mod.requestNewTabInContext();

  assert.strictEqual(handled, true);                  // owned — never falls through to inherit
  assert.deepStrictEqual(state.createInDirCalls, []); // the chooser decides, not this call
  assert.strictEqual(state.promptDirCalls, 0);        // a dir picker would be the wrong prompt
});

// #585: the closed-rail readout (#context-indicator) now carries two children —
// a text label (every layout) and an icon chip (revealed by CSS only in the
// collapsed vertical icon rail). updateIndicator() must fill both, follow the
// image→emoji→monogram chain (applyContextIcon, shared with the rail rows), and
// keep the whole readout hidden in the All view / while the rail is open.

test('active context → indicator shows monogram chip + name (#585)', async () => {
  const { mod, indicator, indicatorIcon, indicatorLabel } = await setup();
  mod.setActiveContext('ctxa');

  assert.strictEqual(indicator.classList.contains('hidden'), false);
  assert.strictEqual(indicatorLabel.textContent, 'Alpha');
  assert.strictEqual(indicatorIcon.textContent, 'A'); // tabIcon-derived monogram
  assert.strictEqual(indicatorIcon.classList.contains('is-emoji'), false);
  assert.strictEqual(indicatorIcon.classList.contains('is-image'), false);
  assert.ok(indicator.title.includes('Alpha'));
});

test('chosen emoji icon → chip is the emoji with is-emoji (#585)', async () => {
  const { mod, indicatorIcon } = await setup({ contexts: [{ ...CTX_A, icon: '🦊' }] });
  mod.setActiveContext('ctxa');

  assert.strictEqual(indicatorIcon.textContent, '🦊');
  assert.strictEqual(indicatorIcon.classList.contains('is-emoji'), true);
});

test('iconImage → <img> chip; onerror falls back to the derived monogram (#585)', async () => {
  const { mod, indicatorIcon } = await setup({ contexts: [{ ...CTX_A, iconImage: 'icon.svg' }] });
  mod.setActiveContext('ctxa');

  assert.strictEqual(indicatorIcon.classList.contains('is-image'), true);
  const img = indicatorIcon.children[0];
  assert.strictEqual(img.src, '/api/contexts/ctxa/icon');

  img.onerror(); // broken upload → derived glyph, chip styling restored
  assert.strictEqual(indicatorIcon.classList.contains('is-image'), false);
  assert.strictEqual(indicatorIcon.textContent, 'A');
  assert.strictEqual(indicatorIcon.children.length, 0); // textContent set dropped the <img>
});

test('All view → indicator hidden and chip cleared (#585)', async () => {
  const { mod, indicator, indicatorIcon } = await setup();
  assert.strictEqual(indicator.classList.contains('hidden'), true); // hidden from init

  mod.setActiveContext('ctxa');
  assert.strictEqual(indicator.classList.contains('hidden'), false);

  mod.setActiveContext(null);
  assert.strictEqual(indicator.classList.contains('hidden'), true);
  assert.strictEqual(indicatorIcon.textContent, '');
});

test('rail open → hidden; closing rebuilds a fresh chip after an icon edit (#585)', async () => {
  const { mod, toggle, indicator, indicatorIcon } = await setup();
  mod.setActiveContext('ctxa');
  assert.strictEqual(indicatorIcon.textContent, 'A');

  toggle.listeners.click(); // toggleSidebar → open (also exercises renderRail/makeRow)
  assert.strictEqual(indicator.classList.contains('hidden'), true);

  // Icon edited while the rail is open (server broadcast path).
  mod.setContexts([{ ...CTX_A, icon: '🦊' }, CTX_B]);

  toggle.listeners.click(); // close → updateIndicator rebuilds the chip
  assert.strictEqual(indicator.classList.contains('hidden'), false);
  assert.strictEqual(indicatorIcon.textContent, '🦊'); // fresh, not the stale monogram
  assert.strictEqual(indicatorIcon.classList.contains('is-emoji'), true);
});

// ---------------------------------------------------- archived contexts (#601)

const ARCHIVED_B = { ...CTX_B, archived: true };

// Rail children by class, most recent render (innerHTML='' empties the fake element).
const railChildren = (rail, cls) => rail.children.filter(c => c.className.split(' ').includes(cls));

test('archived context is dropped from the rail list into the Archived section (#601)', async () => {
  const { mod, toggle, rail } = await setup({ contexts: [CTX_A, ARCHIVED_B] });
  toggle.listeners.click(); // open the rail → renderRail

  const lists = railChildren(rail, 'context-list');
  const mainRows = lists[0].children.map(r => r.children[1]?.textContent);
  assert.deepStrictEqual(mainRows, ['All', 'Alpha']); // Beta archived → not listed

  const [toggleRow] = railChildren(rail, 'context-archived-toggle');
  assert.strictEqual(toggleRow.textContent, '▸ Archived (1)');
  assert.strictEqual(lists.length, 1); // collapsed → no archived list rendered

  toggleRow.onclick();
  const after = railChildren(rail, 'context-archived-toggle')[0];
  assert.strictEqual(after.textContent, '▾ Archived (1)');
  const archivedList = railChildren(rail, 'context-archived-list')[0];
  assert.deepStrictEqual(archivedList.children.map(r => r.children[1]?.textContent), ['Beta']);
});

test('no archived contexts → no Archived section (#601)', async () => {
  const { toggle, rail } = await setup();
  toggle.listeners.click();
  assert.deepStrictEqual(railChildren(rail, 'context-archived-toggle'), []);
});

// The collapsed icon rail hides the "+ New project" label (font-size:0 + a ::before glyph),
// so the title attribute is the only thing left explaining the button (#602).
test('+ New project carries a tooltip for the collapsed rail (#602)', async () => {
  const { toggle, rail } = await setup();
  toggle.listeners.click(); // open the rail → renderRail
  const [add] = railChildren(rail, 'context-add');
  assert.strictEqual(add.title, 'New project');
});

test('⌘↑/↓ cycling skips archived contexts (#601)', async () => {
  const { mod, pressKey } = await setup({ contexts: [CTX_A, ARCHIVED_B] });
  assert.strictEqual(mod.getActiveContextId(), null);        // All

  pressKey({ metaKey: true, code: 'ArrowDown' });
  assert.strictEqual(mod.getActiveContextId(), 'ctxa');

  pressKey({ metaKey: true, code: 'ArrowDown' });            // ctxb archived → wraps to All
  assert.strictEqual(mod.getActiveContextId(), null);
});

test('every context archived → ⌘↑/↓ leaves the key native (#601)', async () => {
  const { mod, pressKey } = await setup({ contexts: [{ ...CTX_A, archived: true }] });
  pressKey({ metaKey: true, code: 'ArrowDown' });
  assert.strictEqual(mod.getActiveContextId(), null);
});

test('new tab whose only matching context is archived → reveals All (#601)', async () => {
  const { mod, openNewTab } = await setup({ contexts: [CTX_A, ARCHIVED_B], tabs: { tab1: '/repo/a' } });
  mod.setActiveContext('ctxa');

  openNewTab('tab2', '/repo/b/sub'); // ctxb matches but is archived

  assert.strictEqual(mod.getActiveContextId(), null);
  assert.strictEqual(isHidden('tab2'), false);
});

test('archiving the active context → POSTs and falls back to All (#601)', async () => {
  const { mod, toggle, rail } = await setup();
  mod.setActiveContext('ctxb');
  toggle.listeners.click(); // open the rail so the rows exist

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return realFetch(); };
  try {
    // Right-click menu on the Beta row → Archive (menu items are appended to a fake
    // document.body, so drive the module's exported path via the row listener).
    const betaRow = railChildren(rail, 'context-list')[0].children[2];
    betaRow.listeners.contextmenu({ preventDefault: () => {}, clientX: 0, clientY: 0 });
    const menu = createdEls.filter(el => el.className.includes('context-row-menu')).pop();
    const archive = menu.children.find(i => i.textContent === 'Archive');
    assert.ok(archive, 'Archive item present in the row menu');
    archive.onclick();
  } finally {
    globalThis.fetch = realFetch;
  }

  const post = calls.find(c => String(c.url).includes('/archive'));
  assert.ok(post, 'archive endpoint called');
  assert.strictEqual(post.url, '/api/contexts/ctxb/archive');
  assert.strictEqual(post.opts.method, 'POST');
  assert.deepStrictEqual(JSON.parse(post.opts.body), { archived: true });
  assert.strictEqual(mod.getActiveContextId(), null); // active context archived → All
});

// ------------------------------------------------- project-mod compact toggle (#646)
// These go LAST and reset the mod registry when they're done. context-views.js imports
// './project-mods.js' with no ?query, so every re-imported context-views shares ONE
// project-mods instance — seeded mods would otherwise leak forward and shift the row
// indices the tests above count on.

// Drive the shared project-mods module the way app.js does: init() + a stubbed
// /api/project-mods. Returns a reset function.
async function seedProjectMods(mods) {
  const pm = await import(new URL('../../public/js/project-mods.js', `file://${__filename}`).href);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => (url === '/api/project-mods'
    ? Promise.resolve({ json: () => Promise.resolve({ mods, enabled: true }) })
    : Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  pm.init({ renderRail: () => {} });
  await new Promise(r => setImmediate(r));   // init → refresh is fetch + two .then hops
  globalThis.fetch = realFetch;
  return async () => { await seedProjectMods([]); };
}

const MOD_A = { id: 'ma', project: '/repo/a', name: 'A Dash', icon: '📊',
  surfaces: ['rail'], openMode: 'tab', enabled: true, updatedAt: 1 };

test('the row menu offers "Compact view" only for a project that has rail mods (#646)', async () => {
  const reset = await seedProjectMods([MOD_A]);
  try {
    // Literals, not the shared CTX_A/CTX_B: archiveContext() mutates the context object
    // it is handed, so by this point in the file CTX_B carries archived:true and would
    // never render a row (spreading it copies the mutation too).
    const { mod, rail, toggle } = await setup({ contexts: [
      { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] },
      { id: 'ctxb', name: 'Beta', dirs: ['/repo/b'] },
    ] });
    mod.setActiveContext('ctxa');
    toggle.listeners.click();   // open the rail so the rows exist

    // [All, Alpha, <Alpha's mod row>, Beta] — Beta owns no mods at all, which is what
    // makes it the row with nothing to compact. (Since #647 a mod row can also appear
    // under a NON-active project; what it can never do is appear under the wrong one.)
    const rows = railChildren(rail, 'context-list')[0].children;
    const labelOf = (row) => row.children.find(c => c.className === 'context-row-label')?.textContent;
    const alpha = rows.find(r => labelOf(r) === 'Alpha');
    const beta = rows.find(r => labelOf(r) === 'Beta');

    const menuFor = (row) => {
      row.listeners.contextmenu({ preventDefault: () => {}, clientX: 0, clientY: 0 });
      return createdEls.filter(el => el.className.includes('context-row-menu')).pop();
    };
    const item = menuFor(alpha).children.find(i => i.textContent?.includes('Compact view'));
    assert.ok(item, 'Alpha has a rail mod, so it gets the toggle');
    assert.ok(item.textContent.includes('(all project mods)'), 'says it is not scoped to this project');
    assert.ok(!item.textContent.startsWith('✓'), 'unticked while compact is off');

    assert.ok(!menuFor(beta).children.some(i => i.textContent?.includes('Compact view')),
      'Beta has no rail mods — nothing to compact, so no item');
  } finally {
    await reset();
  }
});

// ------------------------------------- project mods in the project menu (#647)
// Right-clicking a project lists that project's mods as items you press to open one,
// above the Edit/Archive/Delete it already had. Same shared-registry caution as the
// #646 tests above, so these reuse seedProjectMods and reset when they are done.

const MOD_TAB_ONLY = { id: 'mc', project: '/repo/a', name: 'C Pinned', icon: '',
  surfaces: ['tab'], openMode: 'tab', enabled: true, updatedAt: 1 };
const MOD_B = { id: 'mb', project: '/repo/b', name: 'B Dash', icon: '🔧',
  surfaces: ['rail'], openMode: 'tab', enabled: true, updatedAt: 1 };

// Literals, not the shared CTX_A/CTX_B — archiveContext() mutated CTX_B in place above.
const menuContexts = () => [
  { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] },
  { id: 'ctxb', name: 'Beta', dirs: ['/repo/b'] },
];

// Right-click the rail row carrying this label; hand back the menu it appended.
function rowMenuFor(rail, label) {
  const row = railChildren(rail, 'context-list')[0].children
    .find(r => r.children.find(c => c.className === 'context-row-label')?.textContent === label);
  assert.ok(row, `rail row "${label}" present`);
  row.listeners.contextmenu({ preventDefault: () => {}, clientX: 0, clientY: 0 });
  return createdEls.filter(el => el.className.includes('context-row-menu')).pop();
}

test('a project\'s menu lists its mods above Edit, whatever their surfaces (#647)', async () => {
  const reset = await seedProjectMods([MOD_A, MOD_TAB_ONLY, MOD_B]);
  try {
    const { rail, toggle } = await setup({ contexts: menuContexts() });
    toggle.listeners.click();   // open the rail so the rows exist

    const menu = rowMenuFor(rail, 'Alpha');   // Alpha owns /repo/a
    const labels = menu.children.map(i => i.textContent);
    assert.deepStrictEqual(labels.slice(0, 2), ['📊  A Dash', 'C  C Pinned'],
      'both of Alpha\'s mods, including the tab-only one the rail never draws');
    assert.strictEqual(menu.children[2].className, 'context-menu-separator');
    assert.strictEqual(labels[3], 'Edit', 'the existing items still follow');
    assert.ok(labels.includes('Archive') && labels.includes('Delete'));
    assert.ok(!labels.includes('🔧  B Dash'), 'another project\'s mod stays out');
  } finally {
    await reset();
  }
});

test('a project menu is unchanged when the project owns no mods (#647)', async () => {
  const reset = await seedProjectMods([MOD_A]);
  try {
    const { rail, toggle } = await setup({ contexts: menuContexts() });
    toggle.listeners.click();

    const menu = rowMenuFor(rail, 'Beta');   // /repo/b — owns no mods
    assert.strictEqual(menu.children[0].textContent, 'Edit', 'no leading items');
    assert.ok(!menu.children.some(i => i.className === 'context-menu-separator'), 'and no separator');
  } finally {
    await reset();
  }
});

test('pressing a mod selects its project, so the mod is actually shown (#647)', async () => {
  const reset = await seedProjectMods([MOD_A]);
  try {
    const pm = await import(new URL('../../public/js/project-mods.js', `file://${__filename}`).href);
    const opened = [];
    // Re-init for the one callback this test reads back. init() re-fetches, but the
    // harness fetch rejects by now, so the seeded registry survives.
    pm.init({ renderRail: () => {}, ensureModTab: (m) => opened.push(m.id) });

    const { mod, rail, toggle } = await setup({ contexts: menuContexts() });
    mod.setActiveContext('ctxb');   // looking at Beta
    toggle.listeners.click();

    rowMenuFor(rail, 'Alpha').children[0].onclick();   // "📊  A Dash"

    assert.strictEqual(mod.getActiveContextId(), 'ctxa',
      'a project-mod tab carries cwd = its repo, so it stays filtered out until its project is selected');
    assert.deepStrictEqual(opened, ['ma']);
  } finally {
    await reset();
  }
});

// ------------------------------------------ always show a project's mods (#647)
// The rail rows are the ONE project-mod surface that can be drawn for a project you
// are not in. Per-project, persisted server-side, and ON unless the project says
// otherwise — so every project written before the flag existed shows its mods.

// Labels of the rows in the rail's main list, mod rows included, in DOM order.
const railRowLabels = (rail) => railChildren(rail, 'context-list')[0].children
  .map(r => r.children.find(c => c.className === 'context-row-label')?.textContent);

test('an always-show project draws its mod rows while another project is selected (#647)', async () => {
  const reset = await seedProjectMods([MOD_A, MOD_B]);
  try {
    const { mod, rail, toggle } = await setup({ contexts: menuContexts() });
    mod.setActiveContext('ctxb');   // looking at Beta
    toggle.listeners.click();

    // Both projects' mods, each under its own row — this is the whole feature: Alpha's
    // dashboard is on screen without Alpha being the project you are in.
    assert.deepStrictEqual(railRowLabels(rail), ['All', 'Alpha', 'A Dash', 'Beta', 'B Dash']);
  } finally {
    await reset();
  }
});

test('alwaysShowMods:false falls back to the active-project-only rule (#647)', async () => {
  const reset = await seedProjectMods([MOD_A, MOD_B]);
  try {
    const contexts = menuContexts();
    contexts[0].alwaysShowMods = false;             // Alpha opts out
    const { mod, rail, toggle } = await setup({ contexts });
    mod.setActiveContext('ctxb');
    toggle.listeners.click();

    assert.deepStrictEqual(railRowLabels(rail), ['All', 'Alpha', 'Beta', 'B Dash'],
      'Alpha keeps its mods to itself');
  } finally {
    await reset();
  }
});

test('an opted-out project still shows its mods when it IS the active one (#647)', async () => {
  const reset = await seedProjectMods([MOD_A]);
  try {
    const contexts = menuContexts();
    contexts[0].alwaysShowMods = false;
    const { mod, rail, toggle } = await setup({ contexts });
    mod.setActiveContext('ctxa');
    toggle.listeners.click();

    assert.deepStrictEqual(railRowLabels(rail), ['All', 'Alpha', 'A Dash', 'Beta'],
      'the flag only governs the OTHER-project case; it can never hide a project\'s own tooling');
  } finally {
    await reset();
  }
});

test('the menu toggle flips the flag, redraws, and persists it per project (#647)', async () => {
  const reset = await seedProjectMods([MOD_A]);
  try {
    const posts = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      posts.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    };
    try {
      const { mod, rail, toggle } = await setup({ contexts: menuContexts() });
      mod.setActiveContext('ctxb');
      toggle.listeners.click();

      const itemFor = (label) => rowMenuFor(rail, 'Alpha').children
        .find(i => i.textContent?.includes(label));
      const on = itemFor('Always show');
      assert.ok(on.textContent.startsWith('✓'), 'ticked by default');

      on.onclick();
      assert.deepStrictEqual(posts.at(-1), {
        url: '/api/contexts/ctxa/always-show-mods',
        body: { alwaysShowMods: false },
      }, 'its own route, so a name/dirs edit can never flip it');
      assert.ok(!railRowLabels(rail).includes('A Dash'), 'the rail responds to the press');
      assert.ok(!itemFor('Always show').textContent.startsWith('✓'), 'and the tick follows');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await reset();
  }
});

test('the always-show toggle is offered only where there are rail mods to show (#647)', async () => {
  const reset = await seedProjectMods([MOD_A, MOD_TAB_ONLY]);
  try {
    const { rail, toggle } = await setup({ contexts: menuContexts() });
    toggle.listeners.click();
    const has = (name) => rowMenuFor(rail, name).children.some(i => i.textContent?.includes('Always show'));
    assert.ok(has('Alpha'), 'Alpha has a rail mod');
    // Beta owns nothing, and Alpha's tab-only mod is not a rail row either — the item
    // gates on the same railModsFor() the rows themselves come from.
    assert.ok(!has('Beta'));
  } finally {
    await reset();
  }
});

test('pressing an always-shown rail row selects its project, then opens (#647)', async () => {
  const reset = await seedProjectMods([MOD_A]);
  try {
    const pm = await import(new URL('../../public/js/project-mods.js', `file://${__filename}`).href);
    const opened = [];
    const { mod, rail, toggle } = await setup({ contexts: menuContexts() });
    // Re-init with the two callbacks this test reads back, including the selectProject
    // app.js injects — the row is drawn under Alpha while Beta is what we are in.
    pm.init({
      renderRail: () => {},
      ensureModTab: (m) => opened.push(m.id),
      getActiveContext: () => mod.getActiveContextInfo(),
      selectProject: (id) => mod.setActiveContext(id),
    });
    mod.setActiveContext('ctxb');
    toggle.listeners.click();

    const row = railChildren(rail, 'context-list')[0].children
      .find(r => r.dataset.projectModId === 'ma');
    assert.ok(row, 'Alpha\'s mod row is on screen from Beta');
    row.onclick();

    assert.strictEqual(mod.getActiveContextId(), 'ctxa');
    assert.deepStrictEqual(opened, ['ma']);
  } finally {
    await reset();
  }
});

// ------------------------------------------- rail appearance is a browser preference

// The rail's open state, width and Archived disclosure used to sit in sessionStorage,
// which dies with the window. The daemon opens a *brand-new* browser tab at login, so
// after a machine restart the rail always came back closed however you had left it.
// They are preferences now — localStorage — while the active project and its last tab
// stay per-window, exactly the split docs/frontend.md describes.

test('a brand-new window opens the rail from the stored preference', async () => {
  const { rail, toggle } = await setup({
    local: { 'deepsteve-context-sidebar': '1', 'deepsteve-context-width': '260' },
  });
  // Nothing in sessionStorage at all — this is the login tab, freshly minted.
  assert.strictEqual(rail.style.display, 'flex');
  assert.strictEqual(rail.style.width, '260px', 'and at the width it was dragged to');
  assert.strictEqual(toggle.title, 'Hide projects (⌘P)');
});

test('toggling writes the preference browser-wide, not per-window', async () => {
  const { toggle } = await setup();
  toggle.listeners.click();

  assert.strictEqual(localMap.get('deepsteve-context-sidebar'), '1');
  assert.strictEqual(storeMap.has('deepsteve-context-sidebar'), false,
    'the per-window copy is what a restart throws away');
});

test('a tab still holding the old per-window value keeps it, then migrates', async () => {
  // The upgrade case: a tab that was open before this change reloads with its state
  // in the old home. It must not lose the rail, and the next write must move it.
  const { rail, toggle } = await setup({
    session: { 'deepsteve-context-sidebar': '1', 'deepsteve-context-width': '240' },
  });
  assert.strictEqual(rail.style.display, 'flex');
  assert.strictEqual(rail.style.width, '240px');

  toggle.listeners.click(); // close
  assert.strictEqual(localMap.get('deepsteve-context-sidebar'), '0');
  assert.strictEqual(storeMap.has('deepsteve-context-sidebar'), false);

  toggle.listeners.click(); // and open again
  assert.strictEqual(localMap.get('deepsteve-context-sidebar'), '1');
});

test('which project you are in stays per-window', async () => {
  // The other half of the split: a second window must not inherit the first window's
  // place. Only the chrome is shared.
  const { mod } = await setup({ local: { 'deepsteve-context-active': 'ctxb' } });
  assert.strictEqual(mod.getActiveContextId(), null);

  mod.setActiveContext('ctxa');
  assert.strictEqual(storeMap.get('deepsteve-context-active'), 'ctxa');
  assert.strictEqual(localMap.get('deepsteve-context-active'), 'ctxb',
    'the seeded browser-wide value is neither read nor written — it is not a preference');
});

// ------------------------------------------- the built-in Deep Steve project (#696)
// A server-seeded project the rail treats slightly differently: it archives with the same
// Archive/Unarchive wording as any project (#709) but has no Delete, the section header and
// the "All" row both offer "Archive <name>", and opening it for the first time asks the
// server for a welcome tab.
//
// Every context here is a literal rather than the shared CTX_A/CTX_B: archiveContext()
// mutates the object it is handed, and by this point in the file CTX_B carries
// archived:true (spreading it would copy the mutation).

const BUILTIN = { id: 'deepsteve', name: 'Deep Steve', dirs: ['/src/deepsteve'],
  builtin: true, welcomedAt: 0 };
const builtinContexts = (over = {}) => [
  { ...BUILTIN, ...over },
  { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] },
];

// The rail's "Projects" header, and the menu its right-click appends.
const headerMenuFor = (rail) => {
  const [header] = railChildren(rail, 'context-rail-header');
  assert.ok(header, 'the Projects header is rendered');
  header.listeners.contextmenu({ preventDefault: () => {}, clientX: 0, clientY: 0 });
  return createdEls.filter(el => el.className.includes('context-row-menu')).pop();
};

// Record every fetch a body makes, with the module's rejecting stub still underneath so
// nothing resolves and clobbers the contexts the test set.
async function captureFetches(fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return realFetch(); };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return calls;
}

test('the built-in project says Archive like any other, and offers no Delete (#696, #709)', async () => {
  const { rail, toggle } = await setup({ contexts: builtinContexts() });
  toggle.listeners.click(); // open the rail so the rows exist

  const labels = rowMenuFor(rail, 'Deep Steve').children.map(i => i.textContent);
  assert.ok(labels.includes('Archive'),
    `expected an Archive item, got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('Hide Deep Steve'), 'no wording of its own (#709)');
  assert.ok(!labels.includes('Delete'),
    'the built-in is re-seeded at load, so a delete would come back and read as a bug');
});

test('an ordinary project keeps Archive and Delete (#696)', async () => {
  const { rail, toggle } = await setup({ contexts: builtinContexts() });
  toggle.listeners.click();

  const labels = rowMenuFor(rail, 'Alpha').children.map(i => i.textContent);
  assert.ok(labels.includes('Archive'));
  assert.ok(labels.includes('Delete'));
});

test('an archived built-in offers Unarchive, from its row in the Archived section (#696, #709)', async () => {
  const { rail, toggle } = await setup({ contexts: builtinContexts({ archived: true }) });
  toggle.listeners.click();

  // Archived rows only exist once the disclosure is open.
  railChildren(rail, 'context-archived-toggle')[0].onclick();
  const archived = railChildren(rail, 'context-archived-list')[0];
  const row = archived.children
    .find(r => r.children.find(c => c.className === 'context-row-label')?.textContent === 'Deep Steve');
  assert.ok(row, 'the archived built-in is listed under Archived');

  row.listeners.contextmenu({ preventDefault: () => {}, clientX: 0, clientY: 0 });
  const menu = createdEls.filter(el => el.className.includes('context-row-menu')).pop();
  assert.ok(menu.children.some(i => i.textContent === 'Unarchive'));
});

test('renaming the built-in keeps it built-in (#696)', async () => {
  // `builtin` is the flag, never the name or the id — the name is editable, and renaming
  // it must not demote the project back to an ordinary one. The header menu is where the
  // name appears in a label; the row still offers no Delete.
  const { rail, toggle } = await setup({ contexts: builtinContexts({ name: 'DS trunk' }) });
  toggle.listeners.click();

  assert.ok(headerMenuFor(rail).children.map(i => i.textContent).includes('Archive DS trunk'));
  assert.ok(!rowMenuFor(rail, 'DS trunk').children.map(i => i.textContent).includes('Delete'));
});

test('the Projects header right-click offers New project and Archive (#696, #709)', async () => {
  const { rail, toggle } = await setup({ contexts: builtinContexts() });
  toggle.listeners.click();

  const labels = headerMenuFor(rail).children.map(i => i.textContent);
  assert.ok(labels.includes('New project'));
  assert.ok(labels.includes('Archive Deep Steve'));
});

test('the header reads Unarchive once the built-in is archived (#696, #709)', async () => {
  // The affordance that matters: with the built-in archived and the Archived disclosure
  // collapsed, the header is the one place its row can be brought back from.
  const { rail, toggle } = await setup({ contexts: builtinContexts({ archived: true }) });
  toggle.listeners.click();

  const labels = headerMenuFor(rail).children.map(i => i.textContent);
  assert.ok(labels.includes('Unarchive Deep Steve'));
  assert.ok(!labels.includes('Archive Deep Steve'));
});

test('the header and the All row carry the same items (#696)', async () => {
  const { rail, toggle } = await setup({ contexts: builtinContexts() });
  toggle.listeners.click();

  assert.deepStrictEqual(
    rowMenuFor(rail, 'All').children.map(i => i.textContent),
    headerMenuFor(rail).children.map(i => i.textContent));
});

test('with no built-in project, neither menu invents one (#696)', async () => {
  const { rail, toggle } = await setup({ contexts: [{ id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] }] });
  toggle.listeners.click();

  assert.deepStrictEqual(headerMenuFor(rail).children.map(i => i.textContent), ['New project']);
});

test('the header menu archives the built-in through the shared archive route (#696)', async () => {
  const { rail, toggle } = await setup({ contexts: builtinContexts() });
  toggle.listeners.click();

  const calls = await captureFetches(async () => {
    const archive = headerMenuFor(rail).children.find(i => i.textContent === 'Archive Deep Steve');
    archive.onclick();
  });

  const post = calls.find(c => String(c.url).includes('/archive'));
  assert.ok(post, 'one archive route — no second mechanism');
  assert.strictEqual(post.url, '/api/contexts/deepsteve/archive');
  assert.deepStrictEqual(JSON.parse(post.opts.body), { archived: true });
});

test('first open of the built-in asks the server for the welcome tab (#696)', async () => {
  const { mod } = await setup({ contexts: builtinContexts() });

  const calls = await captureFetches(async () => { mod.setActiveContext('deepsteve'); });

  const post = calls.find(c => String(c.url).includes('/welcome'));
  assert.ok(post, 'the welcome endpoint is called');
  assert.strictEqual(post.url, '/api/contexts/deepsteve/welcome');
  assert.strictEqual(post.opts.method, 'POST');
  // windowId targets the tab at the window that opened the project. The harness supplies
  // no getWindowId callback, so the optional chain yields null — which is the "any window"
  // case deliverToWindow already handles.
  assert.deepStrictEqual(JSON.parse(post.opts.body), { windowId: null });
});

test('an already-welcomed built-in asks for nothing (#696)', async () => {
  const { mod } = await setup({ contexts: builtinContexts({ welcomedAt: 1757000000000 }) });

  const calls = await captureFetches(async () => { mod.setActiveContext('deepsteve'); });

  assert.deepStrictEqual(calls.filter(c => String(c.url).includes('/welcome')), []);
});

test('opening the built-in twice asks once (#696)', async () => {
  // The server is the authority, but a burst of selections (⌘↑/↓ held down) must not be a
  // burst of POSTs.
  const { mod } = await setup({ contexts: builtinContexts() });

  const calls = await captureFetches(async () => {
    mod.setActiveContext('deepsteve');
    mod.setActiveContext('ctxa');
    mod.setActiveContext('deepsteve');
  });

  assert.strictEqual(calls.filter(c => String(c.url).includes('/welcome')).length, 1);
});

test('opening an ordinary project asks for no welcome (#696)', async () => {
  const { mod } = await setup({ contexts: builtinContexts() });

  const calls = await captureFetches(async () => { mod.setActiveContext('ctxa'); });

  assert.deepStrictEqual(calls.filter(c => String(c.url).includes('/welcome')), []);
});

test('restoring the active project at load opens no welcome tab (#696)', async () => {
  // setup() seeds sessionStorage and imports the module, so this covers the whole boot
  // path. A tab that comes back to the project it was left in must not be handed a page
  // it has already read — and on a genuine first run there is nothing stored at all.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return realFetch(); };
  try {
    const { mod } = await setup({
      contexts: builtinContexts(),
      session: { 'deepsteve-context-active': 'deepsteve' },
    });
    assert.strictEqual(mod.getActiveContextId(), 'deepsteve', 'the project is restored');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepStrictEqual(calls.filter(c => String(c.url).includes('/welcome')), []);
});

// ------------------------------------------------------------ project views (#726)

// A stand-in for project-views.js, wired the way app.js wires it: a selected view per
// project, and the tabs in each view. `log` records the order reveal and select happen in.
function viewModel({ sel = {}, members = {} } = {}) {
  const log = [];
  const inView = (id, ctx) => { const s = sel[ctx.id]; return !s || !!members[s]?.has(id); };
  return {
    sel, members, log,
    cb: {
      tabInView: inView,
      viewKey: (ctx) => sel[ctx.id] || '',
      revealTabView: (id, ctx) => {
        log.push(`reveal:${id}@${ctx.id}`);
        if (inView(id, ctx)) return null;
        const next = Object.keys(members).find(s => members[s].has(id));
        if (next) sel[ctx.id] = next; else delete sel[ctx.id];
        return next ? `View ${next}` : 'All';
      },
      onActiveContextChanged: (id) => log.push(`select:${id}`),
    },
  };
}

test('a selected view narrows the project\'s tabs, through the same .context-hidden (#726)', async () => {
  const vm = viewModel({ sel: { ctxa: 'mkt' }, members: { mkt: new Set(['t1']) } });
  const { mod } = await setup({ tabs: { t1: '/repo/a', t2: '/repo/a', t3: '/repo/b' }, extraCb: vm.cb });
  mod.setActiveContext('ctxa');
  assert.strictEqual(isHidden('t1'), false);
  assert.strictEqual(isHidden('t2'), true, 'in the project, not in the view');
  assert.strictEqual(isHidden('t3'), true, 'not in the project');
  delete vm.sel.ctxa;
  mod.applyFilter();
  assert.strictEqual(isHidden('t2'), false, 'All shows the whole project');
});

test('rail "All" applies no view filter (#726)', async () => {
  const vm = viewModel({ sel: { ctxa: 'mkt' }, members: { mkt: new Set() } });
  const { mod } = await setup({ tabs: { t1: '/repo/a' }, extraCb: vm.cb });
  mod.applyFilter();
  assert.strictEqual(isHidden('t1'), false);
});

test('last-tab memory is per project AND view, so All keeps its own (#726)', async () => {
  const vm = viewModel({ members: { mkt: new Set(['t2']) } });
  const { mod, state } = await setup({ tabs: { t1: '/repo/a', t2: '/repo/a' }, extraCb: vm.cb });
  mod.setActiveContext('ctxa');
  state.activeTabId = 't1';
  mod.noteActiveTab('t1');
  vm.sel.ctxa = 'mkt';
  mod.applyFilter();   // t1 is hidden by the view → snaps to the view's first tab
  assert.strictEqual(state.activeTabId, 't2');
  mod.noteActiveTab('t2');
  const memo = JSON.parse(storeMap.get('deepsteve-context-last-tab'));
  assert.strictEqual(memo.ctxa, 't1', 'All\'s memory is the bare project id, untouched');
  assert.strictEqual(memo['ctxa#mkt'], 't2');
  mod.noteActiveTab('t1');
  assert.strictEqual(JSON.parse(storeMap.get('deepsteve-context-last-tab'))['ctxa#mkt'], 't2', 'a tab outside the view is not recorded for it');
});

test('an empty view is an empty project: the welcome screen covers it (#726)', async () => {
  const vm = viewModel({ sel: { ctxa: 'mkt' }, members: { mkt: new Set() } });
  const { mod } = await setup({ tabs: { t1: '/repo/a' }, extraCb: vm.cb });
  mod.setActiveContext('ctxa');
  assert.strictEqual(mod.activeContextIsEmpty(), true);
  vm.members.mkt.add('t1');
  assert.strictEqual(mod.activeContextIsEmpty(), false);
});

test('focusing a tab the selected view hides moves the VIEW, not away from the tab (#726)', async () => {
  const vm = viewModel({ sel: { ctxa: 'mkt' }, members: { mkt: new Set(['t1']), ops: new Set(['t2']) } });
  const { mod, state, jumpToTab } = await setup({ tabs: { t1: '/repo/a', t2: '/repo/a' }, extraCb: vm.cb });
  mod.setActiveContext('ctxa');
  jumpToTab('t2');
  assert.strictEqual(vm.sel.ctxa, 'ops');
  assert.strictEqual(isHidden('t2'), false);
  assert.deepStrictEqual(state.switchCalls, [], 'no snap-back');
  assert.strictEqual(mod.getActiveContextId(), 'ctxa', 'same project');
});

test('a cross-project reveal settles the destination\'s view BEFORE selecting it (#726)', async () => {
  // Beta remembers a view that does not hold t2. Selected first, the filter would snap away.
  const vm = viewModel({ sel: { ctxb: 'mkt' }, members: { mkt: new Set(['t3']) } });
  // Fresh copies: an earlier test's archive toggles `archived` on the shared fixture object.
  const { mod, state, jumpToTab } = await setup({
    contexts: [{ ...CTX_A, archived: false }, { ...CTX_B, archived: false }],
    tabs: { t1: '/repo/a', t2: '/repo/b', t3: '/repo/b' }, extraCb: vm.cb,
  });
  mod.setActiveContext('ctxa');
  vm.log.length = 0;
  jumpToTab('t2');
  assert.deepStrictEqual(vm.log.slice(0, 2), ['reveal:t2@ctxb', 'select:ctxb']);
  assert.strictEqual(vm.sel.ctxb, undefined, 'Beta is back on All');
  assert.strictEqual(isHidden('t2'), false);
  assert.deepStrictEqual(state.switchCalls, []);
});

test('contextsForCwd lists every project holding a path, as copies (#726)', async () => {
  const both = { id: 'ctxab', name: 'Both', dirs: ['/repo'] };
  const { mod } = await setup({ contexts: [CTX_A, CTX_B, both] });
  assert.deepStrictEqual(mod.contextsForCwd('/repo/a/src').map(c => c.id), ['ctxa', 'ctxab']);
  assert.deepStrictEqual(mod.contextsForCwd(null), [], 'no cwd is not "every project"');
  mod.contextsForCwd('/repo/a')[0].dirs.push('/mutated');
  assert.deepStrictEqual(CTX_A.dirs, ['/repo/a']);
});
