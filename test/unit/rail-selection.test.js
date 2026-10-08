// Headless unit test for the rail's ONE selection (#727).
//
// The projects rail draws two kinds of row: Apps (mod-manager's) and Projects (context-views').
// Before #727 each painted `.active` off its own state — app rows off the view slot's OCCUPANT,
// project rows off the active project — and nothing kept the two apart, so clicking a project
// while an app was up left both lit, and often left the app on screen too.
//
// Now both derive from one fact, whether the slot is up: an app row is selected only while its
// app is on screen, a project row only while the slot is down. And every user project pick
// leaves the slot through ModManager.leaveForProject(). The invariant this file pins — after
// every step of every path — is that the rail never shows an app and a project selected at
// the same time.
//
// This drives context-views.js AND the real mod-manager.js it imports, because the bug lived
// in the seam between them; a mocked ModManager would assert nothing.
//
// Run: node --test test/unit/rail-selection.test.js

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

// className and classList are ONE set here, unlike context-views.test.js's fake: makeRow()
// writes the first and the paint sweeps write the second, and this file reads both back.
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
    scrollIntoView: () => {},   // TabManager.setActive() scrolls the selected tab into view
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

// A real remove, unlike the other fakes: a project row's click is mousedown on the row and
// mouseup on the DOCUMENT, and a mouseup listener that outlived its click would re-select
// that row on every later one.
const docListeners = new Map();

globalThis.document = {
  getElementById: (id) => byId.get(id) || createdEls.find(e => e.id === id) || null,
  createElement: (tag) => fakeElement(tag),
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => { docListeners.set(ev, [...(docListeners.get(ev) || []), fn]); },
  removeEventListener: (ev, fn) => { docListeners.set(ev, (docListeners.get(ev) || []).filter(f => f !== fn)); },
  body: { style: {}, appendChild: () => {} },
  activeElement: null,
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
// Synchronous, so anything loadAvailableMods() defers is done by the time it resolves.
globalThis.requestAnimationFrame = (fn) => fn();

const MODS = [
  { id: 'inbox', name: 'Inbox', entry: 'index.html', app: true },
  { id: 'tower', name: 'Tower', entry: 'index.html' },          // fullscreen, NOT an app
];
globalThis.fetch = (url) => {
  if (String(url).includes('/api/mods')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ mods: MODS, deepsteveVersion: '9.9.9' }) });
  }
  return Promise.reject(new Error('no server in unit test'));
};

// --------------------------------------------------------------------- harness

let importCount = 0;
let prevMM = null;

const CTX_A = { id: 'ctxa', name: 'Alpha', dirs: ['/repo/a'] };
const CTX_B = { id: 'ctxb', name: 'Beta', dirs: ['/repo/b'] };
const CTX_C = { id: 'ctxc', name: 'Gamma', dirs: ['/repo/c'] };   // no tabs: the empty state
const TAB_CWDS = { a: '/repo/a', b: '/repo/b' };

/**
 * context-views + mod-manager, wired the way app.js wires the pair.
 *
 * Only context-views gets a `?t=` cache-buster; mod-manager is shared and reset, for the reason
 * excursion-keys.test.js gives — a relative import inside `context-views.js?t=3` resolves to the
 * bare `./mod-manager.js`, so a suffixed import here would be a second instance nobody drives.
 */
async function setup({ collapsed = false } = {}) {
  if (prevMM?.getActiveViewId()) prevMM.hideView(prevMM.getActiveViewId());
  prevMM?.endExcursion({ goHome: false });

  sessionMap.clear();
  localMap.clear();
  byId.clear();
  docListeners.clear();
  createdEls.length = 0;

  localMap.set('deepsteve-enabled-mods', JSON.stringify(['inbox', 'tower']));
  localMap.set('deepsteve-context-sidebar', '1');                 // the rail is open
  // Under the 48px floor, which is what puts the rail into its collapsed icon form.
  if (collapsed) localMap.set('deepsteve-context-width', '40');

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
  const modsBtn = fakeElement('button');
  modsBtn.id = 'mods-btn';
  tabs.appendChild(modsBtn);
  byId.set('mods-btn', modsBtn);
  const appContainer = fakeElement();
  appContainer.id = 'app-container';
  byId.set('app-container', appContainer);
  // The strip's tabs, which applyFilter() marks .context-hidden and snap-switches away from.
  for (const id of Object.keys(TAB_CWDS)) {
    const tab = fakeElement();
    tab.id = `tab-${id}`;
    byId.set(tab.id, tab);
  }

  const { ModManager } = await import(new URL('../../public/js/mod-manager.js', `file://${__filename}`).href);
  prevMM = ModManager;
  const cvUrl = new URL('../../public/js/context-views.js', `file://${__filename}`);
  cvUrl.search = `?t=${++importCount}`;
  const cv = await import(cvUrl.href);

  const state = { activeTabId: 'a', emptyStateCalls: 0 };

  // app.js's switchTo(): with the slot up, a tab switch backgrounds the view first.
  const switchTo = (id) => {
    if (ModManager.isModViewVisible()) { ModManager.showTerminalForSession(id); return; }
    state.activeTabId = id;
    cv.noteActiveTab(id);
  };

  ModManager.init({
    getSessions: () => [],
    getActiveSessionId: () => state.activeTabId,
    // app.js's userJumpTo(): push a drill frame, then focusTab = switchTo + reveal.
    focusSession: (id) => {
      ModManager.noteExcursionDrill(id);
      switchTo(id);
      cv.revealTabContext(id);
    },
    hasSession: (id) => id in TAB_CWDS,
    getBreadcrumb: () => ({}),
    getWindowId: () => 'w1',
    onViewChanged: () => {},
    onAppsChanged: () => cv.applyFilter(),
    onExcursionChanged: (ex) => cv.setRailSuppressed(ex.depth > 0 && ex.chrome?.rail !== 'keep'),
    onQuietChanged: (on) => cv.setRailQuiet(on),
    onViewVisibilityChanged: () => cv.paintProjectRows(),
    getActiveContextId: () => cv.getActiveContextId(),
    setActiveContext: (id) => cv.setActiveContext(id),
  });

  cv.init({
    getOrderedTabIds: () => Object.keys(TAB_CWDS),
    getTabCwd: (id) => TAB_CWDS[id] ?? null,
    getActiveTabId: () => state.activeTabId,
    switchToTab: switchTo,
    updateEmptyState: () => { state.emptyStateCalls++; },
    onActiveContextChanged: () => {},
  });
  cv.setContexts([CTX_A, CTX_B, CTX_C]);
  cv.setActiveContext('ctxa');
  await ModManager.loadAvailableMods();

  const rail = createdEls.find(el => el.id === 'context-rail');
  // The bridge an app's iframe would receive, without an iframe.
  const api = {};
  ModManager.injectBridgeAPI({ contentWindow: api }, 'inbox', null);

  const pressKey = (code) => {
    const e = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: null, code,
      key: code, preventDefault() {}, stopPropagation() {} };
    for (const fn of docListeners.get('keydown') || []) fn(e);
  };

  return { cv, ModManager, state, rail, ds: api.deepsteve, pressKey };
}

// ------------------------------------------------------------------ rail readback

// Re-read on every call: renderRail() rebuilds the rows, so a row held across a step is stale.
const listOf = (rail, cls) => rail.children.find(c => c.classList.contains(cls));
const appRow = (rail, id) => (listOf(rail, 'app-list')?.children || []).find(r => r.dataset.appId === id);
const projectRows = (rail) => ['projects-list', 'context-archived-list']
  .flatMap(cls => listOf(rail, cls)?.children || [])
  .filter(r => r.classList.contains('context-row') && !r.classList.contains('project-mod-row'));
const projectRow = (rail, id) => projectRows(rail).find(r => (r.dataset.contextId || null) === id);

/** Every lit row in the rail, as 'app:<id>' / 'project:<id|All>'. */
function selection(rail) {
  const apps = (listOf(rail, 'app-list')?.children || [])
    .filter(r => r.classList.contains('active')).map(r => `app:${r.dataset.appId}`);
  const projects = projectRows(rail)
    .filter(r => r.classList.contains('active')).map(r => `project:${r.dataset.contextId || 'All'}`);
  return [...apps, ...projects];
}

/** THE invariant: never an app row and a project row lit together. */
function assertOneSelection(rail, where) {
  const lit = selection(rail);
  const app = lit.some(s => s.startsWith('app:'));
  const project = lit.some(s => s.startsWith('project:'));
  assert.ok(!(app && project), `${where}: the rail shows ${lit.join(' + ')} selected at once`);
  assert.ok(lit.length <= 1, `${where}: more than one row selected (${lit.join(', ')})`);
}

/** A project row's click: mousedown on the row, mouseup on the document (wireRowDrag). */
function clickProjectRow(rail, id) {
  const row = projectRow(rail, id);
  if (id === null) { row.onclick(); return; }    // "All" is a plain click, not draggable
  row.listeners.mousedown({ button: 0, clientX: 0, clientY: 0 });
  for (const fn of [...(docListeners.get('mouseup') || [])]) fn({});
}

// ------------------------------------------------------------------------ tests

test('opening an app selects its row and nothing else', async () => {
  const { ModManager, rail } = await setup();
  assert.deepStrictEqual(selection(rail), ['project:ctxa'], 'home: the project is the selection');

  appRow(rail, 'inbox').onclick();
  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.deepStrictEqual(selection(rail), ['app:inbox'],
    'the project you were in is not what you are looking at any more');
});

test('app → project row: the app goes down and the project is the only selection', async () => {
  const { cv, ModManager, rail, state } = await setup();
  appRow(rail, 'inbox').onclick();

  // Beta holds tab b, so the filter snap-switches — the path that USED to background the app
  // while leaving its row lit.
  clickProjectRow(rail, 'ctxb');
  assertOneSelection(rail, 'after the click');
  assert.strictEqual(ModManager.isModViewVisible(), false, 'the app went down');
  assert.strictEqual(ModManager.getActiveViewId(), 'inbox', 'backgrounded, not destroyed');
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);
  assert.strictEqual(state.activeTabId, 'b', "the project's tab is on screen");
  assert.strictEqual(cv.getActiveContextId(), 'ctxb');
});

test('app → a project that needs no tab switch still leaves the app', async () => {
  // The other half of the bug: the active tab is already in "All", so applyFilter() has nothing
  // to snap to — and the app used to just stay fullscreen with two rows lit.
  const { ModManager, rail, state } = await setup();
  appRow(rail, 'inbox').onclick();

  clickProjectRow(rail, null);
  assertOneSelection(rail, 'after clicking All');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:All']);
  assert.strictEqual(state.activeTabId, 'a', 'the tab you were on, back on screen');

  // Clicking the project you are ALREADY in is still a pick.
  appRow(rail, 'inbox').onclick();
  assert.deepStrictEqual(selection(rail), ['app:inbox']);
  clickProjectRow(rail, null);
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:All']);
});

test('app → an empty project shows its empty state, not the app', async () => {
  const { cv, ModManager, rail, state } = await setup();
  appRow(rail, 'inbox').onclick();
  const before = state.emptyStateCalls;

  clickProjectRow(rail, 'ctxc');
  assertOneSelection(rail, 'after clicking Gamma');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:ctxc']);
  assert.strictEqual(cv.activeContextIsEmpty(), true);
  assert.ok(state.emptyStateCalls > before, 'app.js was asked to put the empty state up');
});

test('⌘↓ / ⌘↑ cycling leaves the app the same way', async () => {
  const { cv, ModManager, rail, pressKey } = await setup();
  appRow(rail, 'inbox').onclick();

  pressKey('ArrowDown');
  assertOneSelection(rail, 'after ⌘↓');
  assert.strictEqual(cv.getActiveContextId(), 'ctxb');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);

  appRow(rail, 'inbox').onclick();
  pressKey('ArrowUp');
  assertOneSelection(rail, 'after ⌘↑');
  assert.strictEqual(cv.getActiveContextId(), 'ctxa');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:ctxa']);
});

test('setActiveContext — a project mod row pressed from another project, the panel, the bridge', async () => {
  // project-mods' openMod() selects the row's project through cb.selectProject, which app.js
  // wires to setActiveContext; the Scheduled panel and deepsteve.setActiveContext() land there too.
  const { cv, ModManager, rail, ds } = await setup();
  appRow(rail, 'inbox').onclick();

  cv.setActiveContext('ctxb');
  assertOneSelection(rail, 'after setActiveContext');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);

  appRow(rail, 'inbox').onclick();
  ds.setActiveContext('ctxc');
  assertOneSelection(rail, 'after the bridge call');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:ctxc']);
});

test('setActiveContext for the project already active is still a no-op', async () => {
  // Its guard is what absorbs the Scheduled panel echoing the rail's own choice back; an echo
  // must not throw you out of the app you just opened.
  const { cv, ModManager, rail } = await setup();
  appRow(rail, 'inbox').onclick();
  cv.setActiveContext('ctxa');
  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.deepStrictEqual(selection(rail), ['app:inbox']);
});

test('the app row raises a backgrounded app, with the iframe it left behind', async () => {
  const { ModManager, rail } = await setup();
  appRow(rail, 'inbox').onclick();
  clickProjectRow(rail, 'ctxb');
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);

  appRow(rail, 'inbox').onclick();
  assertOneSelection(rail, 'after raising');
  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.strictEqual(ModManager.getActiveViewId(), 'inbox');
  assert.deepStrictEqual(selection(rail), ['app:inbox'], 'and the project row goes dark again');
});

test('leaving for a tab moves the selection to the project too', async () => {
  // Not a project pick at all — a tab click — but the same one fact decides both rows.
  const { ModManager, rail } = await setup();
  appRow(rail, 'inbox').onclick();
  ModManager.showTerminalForSession('a');
  assertOneSelection(rail, 'after a tab click');
  assert.deepStrictEqual(selection(rail), ['project:ctxa']);
});

test('the collapsed icon rail is the same rows, so the same rule', async () => {
  const { ModManager, rail } = await setup({ collapsed: true });
  assert.strictEqual(rail.classList.contains('collapsed'), true, 'the rail really is collapsed');

  appRow(rail, 'inbox').onclick();
  assert.deepStrictEqual(selection(rail), ['app:inbox']);
  clickProjectRow(rail, 'ctxb');
  assertOneSelection(rail, 'collapsed, after the click');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);
});

test('any view in the slot deselects the projects, not only an app', async () => {
  // The rule #639 gave the tab strip, one level up: with a view on screen no project's tabs are
  // what you are looking at. Tower has no rail row, so the rail shows nothing selected — and a
  // project pick backgrounds it behind its ← like a tab click does.
  const { ModManager, rail } = await setup();
  ModManager.showView({ id: 'tower', name: 'Tower', src: '/mods/tower/index.html' });
  assert.deepStrictEqual(selection(rail), []);

  clickProjectRow(rail, 'ctxb');
  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.strictEqual(ModManager.getActiveViewId(), 'tower', 'backgrounded, so its ← still works');
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);
});

test('a dismissOnLeave view is torn down by a project pick, as by a tab click', async () => {
  const { ModManager, rail } = await setup();
  ModManager.showView({ id: 'project-mod:dash', name: 'Dash', src: '/x', dismissOnLeave: true, persist: false });

  clickProjectRow(rail, 'ctxb');
  assert.strictEqual(ModManager.getActiveViewId(), null);
  assert.deepStrictEqual(selection(rail), ['project:ctxb']);
});

test('picking a project ends an excursion — without going home', async () => {
  const { cv, ModManager, rail, ds, pressKey } = await setup();
  appRow(rail, 'inbox').onclick();
  ds.visitSession('a');
  assert.strictEqual(ModManager.isExcursionActive(), true);

  // The rail is hidden for the excursion, so the pick that can happen is ⌘↓ falling through
  // when the app registered no cycle handler.
  pressKey('ArrowDown');
  assert.strictEqual(ModManager.isExcursionActive(), false, 'an explicit navigation away');
  assert.strictEqual(ModManager.isModViewVisible(), false, 'and not back into the app');
  assert.strictEqual(ModManager.getActiveViewId(), 'inbox', 'which is still there to raise');
  assert.strictEqual(cv.getActiveContextId(), 'ctxb');
  assertOneSelection(rail, 'after the excursion ended');
});

test('following a tab into its project does NOT end the excursion', async () => {
  // The regression guard for the split: an excursion lands you in a session through focusTab,
  // whose revealTabContext() moves the project under you. That is the screen being followed,
  // not a pick — routing it through selectContext() would end every excursion on its first hop.
  const { cv, ModManager, rail, ds } = await setup();
  appRow(rail, 'inbox').onclick();

  ds.visitSession('b');                         // tab b lives in Beta; we are in Alpha
  assert.strictEqual(cv.getActiveContextId(), 'ctxb', 'the reveal moved the project');
  assert.strictEqual(ModManager.isExcursionActive(), true, 'and the excursion survived it');
  assert.strictEqual(ModManager.getExcursion().depth, 1);
  assertOneSelection(rail, 'out on the excursion');
});

test('no sequence of navigations ever lights an app and a project together', async () => {
  // Every path above, interleaved in a fixed pseudo-random order, with the invariant checked
  // after each step — so a new path that bypasses the one fact fails here.
  const { cv, ModManager, rail, ds, pressKey } = await setup();
  const ids = [null, 'ctxa', 'ctxb', 'ctxc'];
  const steps = [
    ['app row', () => appRow(rail, 'inbox').onclick()],
    ['project row', (r) => clickProjectRow(rail, ids[r % ids.length])],
    ['⌘↓', () => pressKey('ArrowDown')],
    ['⌘↑', () => pressKey('ArrowUp')],
    ['setActiveContext', (r) => cv.setActiveContext(ids[r % ids.length])],
    ['tab click', (r) => ModManager.showTerminalForSession(r % 2 ? 'a' : 'b')],
    ['visitSession', (r) => ds.visitSession(r % 2 ? 'a' : 'b')],
    ['⌘←', () => ModManager.popExcursion()],
    ['palette', () => ModManager.openApp('inbox')],
  ];
  let seed = 727;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 400; i++) {
    const [name, run] = steps[rand() % steps.length];
    run(rand());
    assertOneSelection(rail, `step ${i} (${name})`);
    // And the selection is never empty with only an app (or nothing) in the slot: something is
    // always on screen, and its row says so.
    assert.strictEqual(selection(rail).length, 1, `step ${i} (${name}): nothing selected`);
  }
});
