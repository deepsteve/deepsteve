// Headless unit test for the ONE invariant #639 added to mod-manager.js's fullscreen view
// slot: the tab strip's selection describes what is ON SCREEN.
//
// A tab is styled selected because its terminal is what you are looking at. While the slot is
// up none of them is, so no tab may read as selected; when the slot comes down the active
// session's tab is again. Before #639 entering the slot touched nothing in the strip, so the
// outgoing tab kept .active and the styling lied about which view was live.
//
// The rule is deliberately NOT branched on view type — a project-mod view ('project-mod:<id>')
// and a DeepSteve Mod view (a bare mod id) occupy the same slot, so both are pinned here.
//
// No browser, no Docker: stub window/document/localStorage BEFORE importing, then drive the
// exported slot API the way app.js and project-mods.js do. ModManager.init() is synchronous and
// self-contained (DOM creation + localStorage + listeners); loadAvailableMods() is a separate
// async export app.js calls, and is not needed here — so no fetch stub either.
//
// Run: node --test test/unit/mod-view-strip-selection.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};
globalThis.sessionStorage = globalThis.localStorage;

// Every element ever created, so getElementById/querySelectorAll can be real lookups rather
// than a preseeded map — mod-manager builds #content-row/#mod-container itself and then reads
// them back by id.
let allElements = [];

function fakeElement(tag = 'div') {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tag, title: '', style: {}, dataset: {}, children,
    listeners: {},
    scrolledIntoView: 0,
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
    scrollIntoView: () => { el.scrolledIntoView++; },
    remove: () => {
      const p = el.parent;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      el.parent = null;
    },
  };
  // className and classList are one fact in a real DOM, and TabManager.setActive() reads the
  // class list off elements whose class was assigned as a string. Keep them linked or the
  // strip sweep silently matches nothing.
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
  // TabManager.setActive()'s deselect-all sweep is the only selector this code path uses.
  querySelectorAll: (sel) => (sel === '.tab' ? allElements.filter(e => e.classList.contains('tab')) : []),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { style: {}, appendChild: () => {} },
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;

// --------------------------------------------------------------------- harness

let importCount = 0;

/**
 * A fresh mod-manager wired the way app.js wires it, with two tabs in the strip and one of
 * them active — i.e. the state you are in when you click a project mod's launcher.
 *
 * The tabs are built directly rather than through TabManager.addTab(): createTab() builds its
 * innards with innerHTML and then querySelector()s them back, which needs real HTML parsing.
 * `.tab` + `id="tab-<sessionId>"` is the entire contract setActive() has with them.
 */
async function setup() {
  allElements = [];
  storeMap.clear();

  // ModManager.init() wraps #terminals and inserts after #layout-toggle, so both need a parent.
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

  const state = { activeSessionId: 'sess-a', focused: [], viewChanges: 0 };

  const url = new URL('../../public/js/mod-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const { ModManager } = await import(url.href);
  // The same tab-manager instance mod-manager just pulled in: its own relative import resolves
  // without the cache-buster, so this is the module the slot is really driving.
  const { TabManager } = await import(new URL('../../public/js/tab-manager.js', `file://${__filename}`).href);

  ModManager.init({
    getSessions: () => [],
    getActiveSessionId: () => state.activeSessionId,
    // app.js wires focusSession to focusTab, which lands in switchTo() — and with the view now
    // down, that does the real TabManager.setActive(id). Model the whole hand-off, or the half
    // of the contract that says "the slot defers to switchTo() on the way out" goes untested.
    focusSession: (id) => { state.focused.push(id); state.activeSessionId = id; TabManager.setActive(id); },
    getWindowId: () => 'w1',
    onViewChanged: () => { state.viewChanges++; },
  });

  const mkTab = (sessionId, active) => {
    const tab = fakeElement();
    tab.className = active ? 'tab active' : 'tab';
    tab.id = 'tab-' + sessionId;
    tabsList.appendChild(tab);
    return tab;
  };
  const tabA = mkTab('sess-a', true);
  const tabB = mkTab('sess-b', false);

  // The ← button mod-manager created for itself, so the back-button path can be exercised.
  const backBtn = tabs.children.find(c => c.classList.contains('mod-back-btn'));

  return { ModManager, state, tabA, tabB, backBtn };
}

/** Which tabs currently read as selected. The invariant is about this list's length. */
const selectedTabIds = () => allElements
  .filter(e => e.classList.contains('tab') && e.classList.contains('active'))
  .map(e => e.id);

const PROJECT_MOD_VIEW = {
  id: 'project-mod:ma',
  name: '📊 A Glance',
  src: '/api/project-mods/ma/page',
  sandbox: 'allow-scripts allow-forms allow-same-origin',
  persist: false,
  dismissOnLeave: true,
};

const DEEPSTEVE_MOD_VIEW = { id: 'agent-poker', name: 'Agent Poker', src: '/mods/agent-poker/index.html' };

// ----------------------------------------------------------------------- tests

test('entering the view slot clears the strip selection', async () => {
  const { ModManager, tabA } = await setup();
  assert.deepStrictEqual(selectedTabIds(), ['tab-sess-a'], 'precondition: one tab selected');

  ModManager.showView(PROJECT_MOD_VIEW);

  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.deepStrictEqual(selectedTabIds(), [], 'no tab may read as selected while the slot is up');
  assert.strictEqual(tabA.classList.contains('active'), false);
});

test('dismissing the view restores the active session\'s tab', async () => {
  const { ModManager, tabA } = await setup();
  ModManager.showView(PROJECT_MOD_VIEW);
  assert.deepStrictEqual(selectedTabIds(), []);

  // What clicking the launcher a second time does (project-mods.js openMod()'s toggle).
  ModManager.hideView(PROJECT_MOD_VIEW.id);

  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(selectedTabIds(), ['tab-sess-a'], 'the tab on screen is selected again');
  assert.strictEqual(tabA.classList.contains('active'), true);
});

test('a stale hideView for another occupant leaves the slot and the strip alone', async () => {
  const { ModManager } = await setup();
  ModManager.showView(PROJECT_MOD_VIEW);

  ModManager.hideView('project-mod:somebody-else');

  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.deepStrictEqual(selectedTabIds(), []);
});

test('leaving a dismissOnLeave view for a tab selects the tab you left for', async () => {
  const { ModManager, state } = await setup();
  ModManager.showView(PROJECT_MOD_VIEW);

  // app.js's switchTo() delegates here while a view is up.
  ModManager.showTerminalForSession('sess-b');

  assert.strictEqual(ModManager.isModViewVisible(), false);
  assert.deepStrictEqual(state.focused, ['sess-b'], 'hands off to app.js to do the real switch');
  assert.deepStrictEqual(selectedTabIds(), ['tab-sess-b']);
});

test('backgrounding a DeepSteve Mod view and returning via ← flips the strip both ways', async () => {
  const { ModManager, state, backBtn } = await setup();
  assert.ok(backBtn, 'init() created the ← button');

  ModManager.showView(DEEPSTEVE_MOD_VIEW);
  assert.deepStrictEqual(selectedTabIds(), [], 'a bare mod id gets the same rule — no branch');

  // No dismissOnLeave: the view is only backgrounded, behind the ← button.
  ModManager.showTerminalForSession('sess-b');
  assert.deepStrictEqual(state.focused, ['sess-b']);
  assert.deepStrictEqual(selectedTabIds(), ['tab-sess-b']);

  // The ← button calls showModView() bare — it never fires onViewChanged, which is why the
  // rule hangs off the modViewVisible flip rather than off that hook.
  backBtn.listeners.click();
  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.deepStrictEqual(selectedTabIds(), [], 'returning to the view deselects again');
});

test('swapping one view for another keeps the strip empty', async () => {
  const { ModManager } = await setup();
  ModManager.showView(DEEPSTEVE_MOD_VIEW);
  ModManager.showView(PROJECT_MOD_VIEW);

  assert.strictEqual(ModManager.getActiveViewId(), 'project-mod:ma');
  assert.deepStrictEqual(selectedTabIds(), []);
});
