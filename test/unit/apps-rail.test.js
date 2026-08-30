// Headless unit test for the Apps rail section (#661).
//
// An App is a mod with `"app": true` — a place you work FROM rather than a tool you visit. It
// gets a row above `Projects` in the projects rail and a command-palette entry, and since #662
// it gets NO toolbar button: the flag implies that, so one flag keeps meaning one thing. The
// palette entry is what makes dropping the button safe — it is the keyboard route to an app
// while the ⌘P rail is closed.
//
// mod-manager draws the section (it owns the manifests and the view slot) and context-views
// calls it — the same shape context-views already uses for project-mods' appendRailRows().
//
// Run: node --test test/unit/apps-rail.test.js

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
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { style: {}, appendChild: () => {} },
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener: () => {}, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;
// Synchronous, so the panel work loadAvailableMods() defers is done by the time it resolves.
globalThis.requestAnimationFrame = (fn) => fn();

// --------------------------------------------------------------------- harness

let importCount = 0;

const MODS = [
  { id: 'workshop', name: 'Workshop', description: 'One inbox', entry: 'index.html', app: true, toolbar: { label: 'Workshop' } },
  { id: 'tower', name: 'Tower', entry: 'index.html' },                       // fullscreen, not an app
  { id: 'tasks', name: 'Tasks', entry: 'index.html', display: 'panel' },
  { id: 'core', name: 'Core' },                                              // tools-only
  { id: 'skill:merge', name: 'merge', type: 'skill', app: true, entry: 'x' },  // a pseudo-mod, never an app
];

/** mod-manager, loaded with the mod list above and every mod enabled. */
async function setup({ enabled = ['workshop', 'tower', 'tasks', 'core'] } = {}) {
  allElements = [];
  storeMap.clear();
  storeMap.set('deepsteve-enabled-mods', JSON.stringify(enabled));

  const appRoot = fakeElement();
  const terminals = fakeElement();
  terminals.id = 'terminals';
  appRoot.appendChild(terminals);
  const tabs = fakeElement();
  tabs.id = 'tabs';
  const layoutToggle = fakeElement('button');
  layoutToggle.id = 'layout-toggle';
  tabs.appendChild(layoutToggle);
  const modsBtn = fakeElement('button');
  modsBtn.id = 'mods-btn';
  tabs.appendChild(modsBtn);

  globalThis.fetch = (url) => {
    if (String(url).includes('/api/mods')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ mods: MODS, deepsteveVersion: '9.9.9' }) });
    }
    return Promise.reject(new Error('unexpected fetch ' + url));
  };

  const url = new URL('../../public/js/mod-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);
  mod.ModManager.init({
    getSessions: () => [],
    getActiveSessionId: () => null,
    focusSession: () => {},
    getWindowId: () => 'w1',
    onViewChanged: () => {},
  });
  await mod.ModManager.loadAvailableMods();
  return { mod, ModManager: mod.ModManager, tabs };
}

const rowsOf = (rail) => {
  const list = rail.children.find(c => c.classList.contains('app-list'));
  return list ? list.children : [];
};
const labelOf = (row) => row.children.find(c => c.classList.contains('context-row-label'))?.textContent;

// ------------------------------------------------------------------------ tests

test('an enabled "app": true mod gets a rail row under an Apps header', async () => {
  const { mod } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);

  const header = rail.children[0];
  assert.strictEqual(header.className, 'context-rail-header',
    'reuse the projects header class, so the collapsed icon rail hides it for free');
  assert.strictEqual(header.textContent, 'Apps');
  assert.deepStrictEqual([...rowsOf(rail)].map(labelOf), ['Workshop']);
});

test('the rows are context-view rows, so hover/active/collapsed all come for free', async () => {
  const { mod } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  const [row] = rowsOf(rail);

  assert.strictEqual(row.classList.contains('context-row'), true);
  // .has-icon is what reveals .context-row-icon — the only thing left of a row once the rail
  // collapses to 48px squares.
  assert.strictEqual(row.classList.contains('has-icon'), true);
  assert.ok(row.children.find(c => c.className.includes('context-row-icon')), 'a derived glyph');
  assert.strictEqual(row.dataset.appId, 'workshop');
});

test('the list is NOT a .context-list, so the projects list keeps its identity', async () => {
  // context-views.test.js reads the rail back with railChildren(rail, 'context-list')[0]. If
  // the Apps block used that class, enabling one app would silently change what those
  // assertions point at.
  const { mod } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  assert.deepStrictEqual(rail.children.filter(c => c.classList.contains('context-list')), []);
});

test('no apps, no header — a rail without one is the rail that was there before', async () => {
  const { mod } = await setup({ enabled: ['tower', 'tasks'] });
  const rail = fakeElement();
  mod.appendAppRows(rail);
  assert.deepStrictEqual(rail.children, []);
});

test('a disabled app is not listed, and neither is a skill that claims the flag', async () => {
  const { ModManager } = await setup({ enabled: ['tower'] });
  assert.deepStrictEqual(ModManager.getApps().map(m => m.id), []);

  const { ModManager: m2 } = await setup({ enabled: ['workshop', 'skill:merge'] });
  assert.deepStrictEqual(m2.getApps().map(m => m.id), ['workshop'],
    'GET /api/mods appends skills to the same array; they are never a place to work from');
});

test('an app has NO toolbar button — the rail and the palette are its two entries (#662)', async () => {
  // "app": true IMPLIES this. There is no second manifest field, so it holds for every future
  // app without another decision, and the palette entry stops being optional: it is the
  // keyboard route that replaces the button when the ⌘P rail is closed.
  const { tabs } = await setup();
  assert.strictEqual(tabs.children.find(c => c.dataset?.modId === 'workshop'), undefined,
    'an app is a place, and a third launcher in the strip says nothing the rail row does not');

  // The suppression is the flag's, not Workshop's: an ordinary fullscreen mod still gets one.
  const towerBtn = tabs.children.find(c => c.dataset?.modId === 'tower');
  assert.ok(towerBtn, 'a non-app fullscreen mod keeps its button');
  assert.strictEqual(towerBtn.classList.contains('mod-toolbar-btn'), true);
});

test('clicking the row opens the app, and marks itself active', async () => {
  const { mod, ModManager } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  rowsOf(rail)[0].onclick();

  assert.strictEqual(ModManager.getActiveViewId(), 'workshop');
  assert.strictEqual(ModManager.isModViewVisible(), true);

  // Swept live on the row that is already on screen, not only painted on the next render —
  // the same shape as the toolbar button's own .active, and deliberately not a call back into
  // context-views to re-render the rail (applyFilter can snap-switch a tab, which would
  // background the view that was just opened).
  assert.strictEqual(rowsOf(rail)[0].classList.contains('active'), true);

  const rail2 = fakeElement();
  mod.appendAppRows(rail2);
  assert.strictEqual(rowsOf(rail2)[0].classList.contains('active'), true);

  ModManager.hideView('workshop');
  assert.strictEqual(rowsOf(rail2)[0].classList.contains('active'), false, 'and unpainted on close');
});

test('clicking a BACKGROUNDED app raises it instead of destroying it', async () => {
  // The bug this replaced: the launcher was a two-way toggle with no "is it on screen?"
  // check, so pressing it while out on an excursion tore down the iframe and threw away the
  // state you were about to come back to.
  const { mod, ModManager } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  const open = rowsOf(rail)[0].onclick;

  open();
  ModManager.showTerminalForSession('sess-a');       // background it
  assert.strictEqual(ModManager.isModViewVisible(), false);

  open();
  assert.strictEqual(ModManager.getActiveViewId(), 'workshop', 'the iframe survived');
  assert.strictEqual(ModManager.isModViewVisible(), true);

  open();                                            // and now it really does close
  assert.strictEqual(ModManager.getActiveViewId(), null);
});

test('openApp is the command palette entry point', async () => {
  const { ModManager } = await setup();
  ModManager.openApp('workshop');
  assert.strictEqual(ModManager.getActiveViewId(), 'workshop');
  ModManager.openApp('tower');   // not an app: the palette never offers it
  assert.strictEqual(ModManager.getActiveViewId(), 'workshop');
});
