// Headless unit test for public/js/context-views.js — revealTabContext (#547),
// new-tab context guards (#581), the closed-rail indicator + icon chip (#585), and
// archive/unarchive (#601).
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
async function setup({ contexts = [CTX_A, CTX_B], tabs = {} } = {}) {
  storeMap.clear();
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

// The collapsed icon rail hides the "+ New context" label (font-size:0 + a ::before glyph),
// so the title attribute is the only thing left explaining the button (#602).
test('+ New context carries a tooltip for the collapsed rail (#602)', async () => {
  const { toggle, rail } = await setup();
  toggle.listeners.click(); // open the rail → renderRail
  const [add] = railChildren(rail, 'context-add');
  assert.strictEqual(add.title, 'New context');
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
