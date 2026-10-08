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
    contains: (other) => other === el,
    getBoundingClientRect: () => ({ right: 0, bottom: 0, width: 0, height: 0 }),
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
  { id: 'inbox', name: 'Inbox', description: 'One inbox', entry: 'index.html', app: true, toolbar: { label: 'Inbox' } },
  { id: 'tower', name: 'Tower', entry: 'index.html' },                       // fullscreen, not an app
  { id: 'tasks', name: 'Tasks', entry: 'index.html', display: 'panel' },
  { id: 'core', name: 'Core' },                                              // tools-only
  { id: 'skill:merge', name: 'merge', type: 'skill', app: true, entry: 'x' },  // a pseudo-mod, never an app
];

/** mod-manager, loaded with the mod list above and every mod enabled. */
async function setup({ enabled = ['inbox', 'tower', 'tasks', 'core'], mods = MODS, onFetch = null, keepStorage = false } = {}) {
  allElements = [];
  if (!keepStorage) storeMap.clear();
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
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ mods, deepsteveVersion: '9.9.9' }) });
    }
    if (onFetch) return Promise.resolve(onFetch(String(url)));
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
  assert.deepStrictEqual([...rowsOf(rail)].map(labelOf), ['Inbox']);
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
  assert.strictEqual(row.dataset.appId, 'inbox');
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

  const { ModManager: m2 } = await setup({ enabled: ['inbox', 'skill:merge'] });
  assert.deepStrictEqual(m2.getApps().map(m => m.id), ['inbox'],
    'GET /api/mods appends skills to the same array; they are never a place to work from');
});

test('an app has NO toolbar button — the rail and the palette are its two entries (#662)', async () => {
  // "app": true IMPLIES this. There is no second manifest field, so it holds for every future
  // app without another decision, and the palette entry stops being optional: it is the
  // keyboard route that replaces the button when the ⌘P rail is closed.
  const { tabs } = await setup();
  assert.strictEqual(tabs.children.find(c => c.dataset?.modId === 'inbox'), undefined,
    'an app is a place, and a third launcher in the strip says nothing the rail row does not');

  // The suppression is the flag's, not Inbox's: an ordinary fullscreen mod still gets one.
  const towerBtn = tabs.children.find(c => c.dataset?.modId === 'tower');
  assert.ok(towerBtn, 'a non-app fullscreen mod keeps its button');
  assert.strictEqual(towerBtn.classList.contains('mod-toolbar-btn'), true);
});

test('an app has NO ← button in the strip either, in both states (#662)', async () => {
  // The other half of #662's rule. The ← IS the launcher pointing the other way — same
  // element, same strip — so an app that is a place you reach from the Apps rail is a place
  // you RETURN to from the Apps rail. In the 48px vertical strip the button was worse than
  // redundant: "← Inbox" has no room to wrap and rendered as a clipped "← / Works".
  const { mod, ModManager, tabs } = await setup();
  const backBtn = tabs.children.find(c => c.classList.contains('mod-back-btn'));
  assert.ok(backBtn, 'init() still builds one — non-app mods are what it is for');

  const rail = fakeElement();
  mod.appendAppRows(rail);
  rowsOf(rail)[0].onclick();

  // 1. Backgrounded by a plain tab click.
  ModManager.showTerminalForSession('sess-a');
  assert.strictEqual(ModManager.isModViewVisible(), false, 'the slot came down');
  assert.strictEqual(backBtn.style.display, 'none', 'and left no ← Inbox behind');
  assert.strictEqual(rowsOf(rail)[0].classList.contains('active'), true,
    'the rail row stays lit while you are away — that is what makes it the way back');

  // 2. Out on an excursion, where the same button doubles as the trail bar.
  const api = {};
  ModManager.injectBridgeAPI({ contentWindow: api }, 'inbox', null);
  api.deepsteve.visitSession('sess-b', { label: 'needs a decision' });
  assert.strictEqual(ModManager.getExcursion().depth, 1, 'we really are out');
  assert.strictEqual(backBtn.style.display, 'none', 'no trail bar either — ⌘← is the route home');
});

test('a non-app fullscreen mod keeps its ← — it has no rail row to be the way back', async () => {
  // The suppression is the flag's, not the strip's: drop it for everything and Tower would
  // background with nothing on screen pointing at it.
  const { ModManager, tabs } = await setup();
  const backBtn = tabs.children.find(c => c.classList.contains('mod-back-btn'));

  tabs.children.find(c => c.dataset?.modId === 'tower').listeners.click();
  assert.strictEqual(ModManager.getActiveViewId(), 'tower');

  ModManager.showTerminalForSession('sess-a');
  assert.strictEqual(backBtn.style.display, '');
  assert.strictEqual(backBtn.textContent, '← Tower');
});

test('clicking the row opens the app, and marks itself active', async () => {
  const { mod, ModManager } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  rowsOf(rail)[0].onclick();

  assert.strictEqual(ModManager.getActiveViewId(), 'inbox');
  assert.strictEqual(ModManager.isModViewVisible(), true);

  // Swept live on the row that is already on screen, not only painted on the next render —
  // the same shape as the toolbar button's own .active, and deliberately not a call back into
  // context-views to re-render the rail (applyFilter can snap-switch a tab, which would
  // background the view that was just opened).
  assert.strictEqual(rowsOf(rail)[0].classList.contains('active'), true);

  const rail2 = fakeElement();
  mod.appendAppRows(rail2);
  assert.strictEqual(rowsOf(rail2)[0].classList.contains('active'), true);

  ModManager.hideView('inbox');
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
  assert.strictEqual(ModManager.getActiveViewId(), 'inbox', 'the iframe survived');
  assert.strictEqual(ModManager.isModViewVisible(), true);

  open();                                            // and now it really does close
  assert.strictEqual(ModManager.getActiveViewId(), null);
});

test('openApp is the command palette entry point', async () => {
  const { ModManager } = await setup();
  ModManager.openApp('inbox');
  assert.strictEqual(ModManager.getActiveViewId(), 'inbox');
  ModManager.openApp('tower');   // not an app: the palette never offers it
  assert.strictEqual(ModManager.getActiveViewId(), 'inbox');
});

// ------------------------------------------------------------------------- parked apps
//
// Closing an app used to destroy its page, so every open was a cold load: a blank pane for
// about a second and a half while the page compiled its JSX in the browser. The row toggles,
// so the second click a user makes when nothing seems to happen closed it again, and the
// Inbox read as broken. An app's page is parked instead, and comes back as it was.

const framesIn = () => document.getElementById('mod-container').children.filter(c => c.tag === 'iframe');

test('closing an app parks its page, and reopening shows that same page', async () => {
  const { mod, ModManager } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  const row = rowsOf(rail)[0];

  row.onclick();
  const [page] = framesIn();
  row.onclick();                                    // close
  assert.strictEqual(ModManager.getActiveViewId(), null);
  assert.strictEqual(row.classList.contains('active'), false, 'closed reads as closed');
  assert.deepStrictEqual(framesIn(), [page], 'the page is still loaded');
  assert.strictEqual(page.style.display, 'none');

  row.onclick();                                    // reopen
  assert.strictEqual(ModManager.isModViewVisible(), true);
  assert.deepStrictEqual(framesIn(), [page], 'and is shown again, not loaded a second time');
  assert.strictEqual(page.style.display, '');
});

test('another view taking the slot parks an app, but still destroys a view that is not one', async () => {
  const { ModManager } = await setup();
  ModManager.openApp('inbox');
  const [inbox] = framesIn();

  ModManager.showView({ id: 'tower', name: 'Tower', src: '/mods/tower/index.html' });
  const tower = framesIn().find(f => f !== inbox);
  assert.strictEqual(inbox.style.display, 'none');

  ModManager.openApp('inbox');
  assert.deepStrictEqual(framesIn(), [inbox], 'Tower is torn down as it always was');
  assert.strictEqual(tower.parent, null);
});

test('a parked page is dropped when its code changes, or when it stops being an app', async () => {
  const { ModManager } = await setup();
  ModManager.openApp('inbox');
  ModManager.openApp('inbox');                      // open, close: parked
  assert.strictEqual(framesIn().length, 1);

  ModManager.handleModChanged('inbox');
  assert.strictEqual(framesIn().length, 0, 'the parked copy runs the old code');

  ModManager.openApp('inbox');
  ModManager.openApp('inbox');
  assert.strictEqual(framesIn().length, 1);
  globalThis.fetch = () => Promise.resolve({
    ok: true, json: () => Promise.resolve({ mods: MODS.filter(m => m.id !== 'inbox'), deepsteveVersion: '9.9.9' }),
  });
  await ModManager.loadAvailableMods();
  assert.strictEqual(framesIn().length, 0, 'gone from the mod list, gone from the page');
});

test('a parked app keeps its own ⌘↑/⌘↓ handler, and never reads another app\'s trail', async () => {
  // Before parking there was one live app page at a time, so one cycle handler was enough. A
  // parked page does not load again, so it does not register again: the app opened second
  // used to overwrite the first's handler, and walking the first's queue fell through to
  // cycling projects.
  const mods = [...MODS, { id: 'desk', name: 'Desk', entry: 'index.html', app: true }];
  const { ModManager } = await setup({ mods, enabled: ['inbox', 'desk', 'tower', 'tasks', 'core'] });
  const bridgeFor = (id) => {
    const api = {};
    ModManager.injectBridgeAPI({ contentWindow: api }, id, null);
    return api.deepsteve;
  };
  const cycled = [];
  const deskSaw = [];

  ModManager.openApp('inbox');
  const inbox = bridgeFor('inbox');
  inbox.onExcursionCycle(({ delta }) => cycled.push(['inbox', delta]));

  ModManager.openApp('desk');                       // Inbox parked
  const desk = bridgeFor('desk');
  desk.onExcursionCycle(({ delta }) => cycled.push(['desk', delta]));
  desk.onExcursionChanged((ex) => deskSaw.push(ex.depth));

  ModManager.openApp('inbox');                      // back, without a reload
  inbox.visitSession('sess-b', { label: 'needs a decision' });
  assert.strictEqual(inbox.getExcursion().depth, 1);

  assert.strictEqual(ModManager.requestExcursionCycle(1), true);
  assert.deepStrictEqual(cycled, [['inbox', 1]]);
  assert.ok(deskSaw.length > 1, 'Desk was told when it changed');
  assert.ok(deskSaw.every(d => d === 0), 'and was never handed Inbox\'s trail as its own');
  assert.strictEqual(desk.getExcursion().depth, 0);
});

// ------------------------------------------------------------------ count badge (#718)
//
// An app that declares `badge` in its manifest gets a count on its rail row — Inbox's is how
// many things are in it — polled by the host so it moves while the app is closed.

const BADGED = [
  {
    id: 'inbox', name: 'Inbox', entry: 'index.html', app: true, toolbar: { label: 'Inbox' },
    badge: { url: '/api/inbox/count', params: { projects: 'projects', briefings: 'showBriefings' } },
    settings: [{ key: 'showBriefings', type: 'boolean', default: true }],
  },
  { id: 'tower', name: 'Tower', entry: 'index.html', app: true },   // an app with no badge
];

/**
 * The poll re-arms itself with setTimeout, and a real 5s timer would hold this process open
 * after the last test. Record instead of scheduling, and put the real ones back afterwards.
 */
function fakeTimers(t) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = [];
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  t.after(() => Object.assign(globalThis, real));
  return timers;
}

/** A fetch stub for the badge URL: answers `count()` and records every URL it was asked. */
function countServer(count, { status = 200 } = {}) {
  const urls = [];
  const onFetch = (url) => {
    urls.push(url);
    return { ok: status === 200, status, json: () => Promise.resolve({ count: count() }) };
  };
  return { urls, onFetch };
}

// The poll is fire-and-forget from loadAvailableMods(); let its fetch and json() settle.
const settle = () => new Promise((r) => setImmediate(r));

const badgeOf = (row) => row.children.find(c => c.classList.contains('context-row-icon'))
  ?.children.find(c => c.classList.contains('app-row-badge'));
const shown = (badge) => (badge.classList.contains('visible') ? badge.textContent : null);
const lastMenu = () => [...allElements].reverse().find(e => e.classList.contains('context-menu'));
const rightClick = (el) => el.listeners.contextmenu({ preventDefault() {}, clientX: 10, clientY: 10 });

test('a badged app shows its count inside the icon square, which the collapsed rail keeps', async (t) => {
  fakeTimers(t);
  const server = countServer(() => 3);
  const { mod } = await setup({ enabled: ['inbox', 'tower'], mods: BADGED, onFetch: server.onFetch });
  const rail = fakeElement();
  mod.appendAppRows(rail);
  await settle();

  const [inboxRow, towerRow] = rowsOf(rail);
  assert.strictEqual(shown(badgeOf(inboxRow)), '3', 'painted in place on the row already on screen');
  assert.strictEqual(badgeOf(towerRow), undefined, 'an app that declares no badge gets none');
  assert.deepStrictEqual(server.urls, ['/api/inbox/count?briefings=1'], 'only badged apps are polled');

  // A re-render paints from the last count rather than waiting a tick with the badge off.
  const rail2 = fakeElement();
  mod.appendAppRows(rail2);
  assert.strictEqual(shown(badgeOf(rowsOf(rail2)[0])), '3');
});

test('the badge URL carries the app\'s own settings, so it is scoped like the app\'s list', async (t) => {
  fakeTimers(t);
  storeMap.clear();
  storeMap.set('deepsteve-mod-settings-inbox', JSON.stringify({ projects: ['/r/a', '/r/b'], showBriefings: false }));
  const server = countServer(() => 1);
  await setup({ enabled: ['inbox'], mods: BADGED, onFetch: server.onFetch, keepStorage: true });
  await settle();

  const url = new URL(server.urls[0], 'http://x');
  assert.strictEqual(url.pathname, '/api/inbox/count');
  assert.strictEqual(url.searchParams.get('projects'), '/r/a,/r/b');
  assert.strictEqual(url.searchParams.get('briefings'), '0');
});

test('zero hides the badge, and a big number is capped at 99+', async (t) => {
  fakeTimers(t);
  let n = 0;
  const server = countServer(() => n);
  const { mod, ModManager } = await setup({ enabled: ['inbox'], mods: BADGED, onFetch: server.onFetch });
  const rail = fakeElement();
  mod.appendAppRows(rail);
  await settle();
  const badge = badgeOf(rowsOf(rail)[0]);
  assert.strictEqual(shown(badge), null, 'a red 0 would be a false alarm');

  n = 150;
  await ModManager.refreshAppBadges();
  assert.strictEqual(shown(badge), '99+');

  n = 0;
  await ModManager.refreshAppBadges();
  assert.strictEqual(shown(badge), null, 'and it goes away again when the inbox empties');
});

test('the poll re-arms itself while the app is closed', async (t) => {
  const timers = fakeTimers(t);
  const server = countServer(() => 2);
  await setup({ enabled: ['inbox'], mods: BADGED, onFetch: server.onFetch });
  await settle();
  assert.strictEqual(timers.filter(x => x.ms === 5000).length, 1, 'the next tick is armed');

  await timers.find(x => x.ms === 5000).fn();
  assert.strictEqual(server.urls.length, 2, 'and firing it polls again, with no view ever opened');
});

test('a refresh asked for mid-poll is not lost — it runs as soon as that poll lands', async (t) => {
  // Leaving the app kicks a refresh; if a tick is already in flight, its answer may predate
  // what you just did in there. Dropping the kick would show that stale number for 5s.
  fakeTimers(t);
  let n = 5;
  const urls = [];
  const pending = [];
  const onFetch = (url) => {
    urls.push(url);
    const v = n;
    return { ok: true, status: 200, json: () => new Promise((r) => pending.push(() => r({ count: v }))) };
  };
  const { mod, ModManager } = await setup({ enabled: ['inbox'], mods: BADGED, onFetch });
  const rail = fakeElement();
  mod.appendAppRows(rail);
  await settle();
  assert.strictEqual(urls.length, 1, 'the first poll is in flight');

  n = 1;
  ModManager.refreshAppBadges();
  assert.strictEqual(urls.length, 1, 'no second concurrent fetch');

  pending.shift()();
  await settle();
  assert.strictEqual(urls.length, 2, 'the queued refresh ran as soon as the first poll landed');
  pending.shift()();
  await settle();
  assert.strictEqual(shown(badgeOf(rowsOf(rail)[0])), '1', 'and its newer answer is what shows');
});

test('right-click hides the count, and the choice survives a reload', async (t) => {
  fakeTimers(t);
  const server = countServer(() => 4);
  const { mod, ModManager } = await setup({ enabled: ['inbox'], mods: BADGED, onFetch: server.onFetch });
  const rail = fakeElement();
  mod.appendAppRows(rail);
  await settle();
  const row = rowsOf(rail)[0];
  assert.strictEqual(shown(badgeOf(row)), '4');

  rightClick(row);
  const hide = lastMenu().children[0];
  assert.strictEqual(hide.textContent, 'Hide inbox count');
  hide.onclick();
  assert.strictEqual(shown(badgeOf(row)), null);
  assert.strictEqual(ModManager.isAppBadgeHidden('inbox'), true);
  assert.strictEqual(storeMap.get('deepsteve-app-badge-hidden'), '["inbox"]', 'per-browser, like quiet mode');

  // A reload: a fresh module over the same localStorage.
  const server2 = countServer(() => 4);
  const { mod: mod2 } = await setup({ enabled: ['inbox'], mods: BADGED, onFetch: server2.onFetch, keepStorage: true });
  const rail2 = fakeElement();
  mod2.appendAppRows(rail2);
  await settle();
  const row2 = rowsOf(rail2)[0];
  assert.strictEqual(shown(badgeOf(row2)), null, 'still hidden after the reload');
  assert.deepStrictEqual(server2.urls, [], 'and a hidden badge is not polled at all');

  rightClick(row2);
  const show = lastMenu().children[0];
  assert.strictEqual(show.textContent, 'Show inbox count');
  show.onclick();
  await settle();
  assert.strictEqual(shown(badgeOf(row2)), '4', 're-showing fetches the count at once');
  assert.strictEqual(storeMap.get('deepsteve-app-badge-hidden'), '[]');
});

test('the Apps header offers the toggle too — it is the section-level target', async (t) => {
  fakeTimers(t);
  const server = countServer(() => 1);
  const { mod } = await setup({ enabled: ['inbox', 'tower'], mods: BADGED, onFetch: server.onFetch });
  const rail = fakeElement();
  mod.appendAppRows(rail);
  rightClick(rail.children[0]);
  assert.deepStrictEqual(lastMenu().children.map(c => c.textContent), ['Hide inbox count'],
    'one entry per badged app; Tower has no count to hide');
});

test('with no badged app, nothing is polled and there is no menu', async () => {
  // MODS' Inbox declares no badge, and the default fetch stub rejects anything but /api/mods.
  const { mod } = await setup();
  const rail = fakeElement();
  mod.appendAppRows(rail);
  await settle();
  assert.strictEqual(rail.children[0].listeners.contextmenu, undefined);
  assert.strictEqual(rowsOf(rail)[0].listeners.contextmenu, undefined);
  assert.strictEqual(badgeOf(rowsOf(rail)[0]), undefined);
});

test('an auth rejection stops the poll dead (#676)', async (t) => {
  const timers = fakeTimers(t);
  const server = countServer(() => 1, { status: 401 });
  const { ModManager } = await setup({ enabled: ['inbox'], mods: BADGED, onFetch: server.onFetch });
  await settle();
  assert.strictEqual(server.urls.length, 1);
  assert.strictEqual(timers.filter(x => x.ms === 5000).length, 0, 'no next tick is armed');

  await ModManager.refreshAppBadges();
  assert.strictEqual(server.urls.length, 1, 'and nothing re-polls a cookie the server refused');
});
