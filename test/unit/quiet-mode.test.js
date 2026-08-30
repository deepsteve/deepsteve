// Headless unit test for quiet mode (#662).
//
// Quiet mode takes the host's chrome away and leaves an app alone on screen. It is the HOST's,
// not the app's — an iframe cannot hide the tab strip that contains it — so it is built once
// against the fullscreen view slot and every app gets it.
//
// Four things here fail invisibly in a browser and are therefore pinned rather than reviewed:
//
//   * the toggle mounted in #tabs instead of #mod-container disappears with the chrome it
//     hides, and quiet mode becomes a state with no exit;
//   * quiet chrome that is BOOKKEPT rather than derived survives into an excursion, where it
//     eats the excursion bar — the one thing telling you where you are;
//   * a preference written on the way out of the slot means "close the app" silently forgets
//     it, and "go look at an agent" does too;
//   * a per-app key that is really a global one makes opening a second app inherit a mode
//     nobody asked it for.
//
// Same harness as apps-rail.test.js: fake DOM, fake storage, import mod-manager with a ?t=
// cache-bust so each test gets a fresh module.
//
// Run: node --test test/unit/quiet-mode.test.js

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
    focus: () => {},
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
globalThis.requestAnimationFrame = (fn) => fn();

// --------------------------------------------------------------------- harness

let importCount = 0;

const MODS = [
  { id: 'workshop', name: 'Workshop', entry: 'index.html', app: true, toolbar: { label: 'Workshop' } },
  { id: 'atelier', name: 'Atelier', entry: 'index.html', app: true },   // a second app
  { id: 'tower', name: 'Tower', entry: 'index.html' },                  // fullscreen, not an app
];

const QUIET_KEY = 'deepsteve-app-quiet';   // window.parent === window → nsKey adds no prefix

/**
 * mod-manager, booted against the mod list above. `keepStorage` leaves localStorage alone, so a
 * test can re-import and assert that the preference came back off disk rather than out of a
 * variable that never died.
 */
async function setup({ keepStorage = false } = {}) {
  allElements = [];
  if (!keepStorage) storeMap.clear();
  storeMap.set('deepsteve-enabled-mods', JSON.stringify(['workshop', 'atelier', 'tower']));

  const appContainer = fakeElement();
  appContainer.id = 'app-container';
  const terminals = fakeElement();
  terminals.id = 'terminals';
  appContainer.appendChild(terminals);
  const tabs = fakeElement();
  tabs.id = 'tabs';
  const layoutToggle = fakeElement('button');
  layoutToggle.id = 'layout-toggle';
  tabs.appendChild(layoutToggle);
  const modsBtn = fakeElement('button');
  modsBtn.id = 'mods-btn';
  tabs.appendChild(modsBtn);
  appContainer.appendChild(tabs);

  globalThis.fetch = (url) => {
    if (String(url).includes('/api/mods')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ mods: MODS, deepsteveVersion: '9.9.9' }) });
    }
    return Promise.reject(new Error('unexpected fetch ' + url));
  };

  const quietCalls = [];
  const url = new URL('../../public/js/mod-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);
  mod.ModManager.init({
    getSessions: () => [],
    getActiveSessionId: () => null,
    focusSession: () => {},
    hasSession: () => true,
    getWindowId: () => 'w1',
    onViewChanged: () => {},
    onQuietChanged: (on) => quietCalls.push(on),
  });
  await mod.ModManager.loadAvailableMods();
  return { mod, ModManager: mod.ModManager, appContainer, tabs, quietCalls };
}

const quietBtnIn = (container) =>
  container.children.find(c => c.classList.contains('app-quiet-btn'));
const modContainer = () => document.getElementById('mod-container');
const isQuietClass = (appContainer) => appContainer.classList.contains('quiet-mode');

// ------------------------------------------------------------------------ tests

test('the toggle lives in the view slot, not in the strip it hides', async () => {
  // THE load-bearing placement. In #tabs it would be a sibling of the ← button — and #tabs is
  // exactly what quiet mode takes away, so entering quiet mode would remove the only exit.
  const { tabs } = await setup();
  const btn = quietBtnIn(modContainer());
  assert.ok(btn, 'the toggle must hang off #mod-container');
  assert.strictEqual(quietBtnIn(tabs), undefined, 'and must NOT be in the tab strip');
});

test('it appears for an app and stays hidden for a plain fullscreen mod', async () => {
  const { ModManager, appContainer } = await setup();
  const btn = quietBtnIn(modContainer());
  assert.strictEqual(btn.style.display, 'none', 'nothing is in the slot yet');

  ModManager.openApp('workshop');
  assert.strictEqual(btn.style.display, '', 'an app is a place you sit in — offer it');

  ModManager.hideView('workshop');
  ModManager.showView({ id: 'tower', name: 'Tower', src: '/mods/tower/index.html' });
  assert.strictEqual(btn.style.display, 'none', 'Tower is a view you visit, not a place');
  assert.strictEqual(isQuietClass(appContainer), false);
});

test('the gutter comes and goes with the button that lives in it', async () => {
  // The toggle gets a 30px column of its own rather than floating over the page: an overlay in
  // the top-left lands on whatever the app draws there (on Workshop, the word "Inbox") and
  // reads as a rendering fault. A slot with no toggle must not keep the inset.
  const { ModManager } = await setup();
  const mc = modContainer();
  assert.strictEqual(mc.classList.contains('has-quiet-btn'), false);

  ModManager.openApp('workshop');
  assert.strictEqual(mc.classList.contains('has-quiet-btn'), true);

  ModManager.hideView('workshop');
  assert.strictEqual(mc.classList.contains('has-quiet-btn'), false);

  ModManager.showView({ id: 'tower', name: 'Tower', src: '/mods/tower/index.html' });
  assert.strictEqual(mc.classList.contains('has-quiet-btn'), false, 'not an app, no gutter');
});

test('toggling hides the strip, asks for the rail, and leaves the toggle up', async () => {
  const { ModManager, appContainer, quietCalls } = await setup();
  ModManager.openApp('workshop');
  const btn = quietBtnIn(modContainer());

  btn.listeners.click();
  assert.strictEqual(isQuietClass(appContainer), true, '#tabs comes down off this class');
  assert.deepStrictEqual(quietCalls.slice(-1), [true], 'the rail is asked, not styled — its display is inline');
  assert.strictEqual(ModManager.isQuietMode(), true);
  // The exit has to survive the thing it removed.
  assert.strictEqual(btn.style.display, '', 'the toggle must stay visible while quiet');
  assert.strictEqual(btn.classList.contains('active'), true);

  btn.listeners.click();
  assert.strictEqual(isQuietClass(appContainer), false);
  assert.deepStrictEqual(quietCalls.slice(-1), [false]);
  assert.strictEqual(btn.style.display, '', 'and visible when not, so it can be found');
});

test('an excursion lifts it and coming home puts it back, with nothing written', async () => {
  // Quiet mode is what you see WHILE IN the app; excursion chrome is what you see while out.
  // The excursion bar IS the back button, and the back button is in #tabs — so the strip must
  // come back, or the one thing telling you where you are goes with it.
  const { ModManager, appContainer } = await setup();
  ModManager.openApp('workshop');
  quietBtnIn(modContainer()).listeners.click();
  const stored = storeMap.get(QUIET_KEY);

  ModManager.showTerminalForSession('sess-a');            // out
  assert.strictEqual(isQuietClass(appContainer), false, 'the strip is back, so the trail is readable');
  assert.strictEqual(ModManager.isQuietMode(), false);
  assert.strictEqual(storeMap.get(QUIET_KEY), stored, 'leaving must not rewrite the preference');

  ModManager.showModView();                               // home
  assert.strictEqual(isQuietClass(appContainer), true, 'back exactly as you left it');
  assert.strictEqual(ModManager.isQuietMode(), true);
});

test('closing the app restores the chrome but remembers the preference', async () => {
  const { ModManager, appContainer } = await setup();
  ModManager.openApp('workshop');
  quietBtnIn(modContainer()).listeners.click();

  ModManager.hideView('workshop');
  assert.strictEqual(isQuietClass(appContainer), false, 'no app, no quiet mode');
  assert.strictEqual(quietBtnIn(modContainer()).style.display, 'none');

  ModManager.openApp('workshop');
  assert.strictEqual(isQuietClass(appContainer), true, 'and it is where you left it on return');
});

test('the preference is per app, not per browser', async () => {
  const { ModManager, appContainer } = await setup();
  ModManager.openApp('workshop');
  quietBtnIn(modContainer()).listeners.click();

  ModManager.openApp('atelier');   // one slot: this replaces Workshop
  assert.strictEqual(ModManager.getActiveViewId(), 'atelier');
  assert.strictEqual(isQuietClass(appContainer), false, 'a second app inherits nothing');
  assert.deepStrictEqual(JSON.parse(storeMap.get(QUIET_KEY)), ['workshop']);
});

test('it survives a reload — localStorage, because it is a preference not a place', async () => {
  const first = await setup();
  first.ModManager.openApp('workshop');
  quietBtnIn(modContainer()).listeners.click();
  assert.deepStrictEqual(JSON.parse(storeMap.get(QUIET_KEY)), ['workshop']);

  // A fresh module and a fresh DOM against the same storage: whatever comes back can only
  // have come off disk. ACTIVE_VIEW_KEY brings Workshop back by itself, and showModView()'s
  // re-assert is what carries quiet mode in with it — no separate restore path.
  const { ModManager, appContainer } = await setup({ keepStorage: true });
  assert.strictEqual(ModManager.getActiveViewId(), 'workshop');
  assert.strictEqual(isQuietClass(appContainer), true, 'the reload lands quiet, not with a flash of chrome');
  assert.strictEqual(ModManager.isQuietMode(), true);
});

test('a window that is not showing the app is not quiet', async () => {
  // ACTIVE_VIEW_KEY is localStorage and so is this, but they are read independently: a second
  // window at the same origin that has not opened the app must show its normal chrome.
  const first = await setup();
  first.ModManager.openApp('workshop');
  quietBtnIn(modContainer()).listeners.click();

  storeMap.delete('deepsteve-active-mod-view');
  const { ModManager, appContainer } = await setup({ keepStorage: true });
  assert.strictEqual(ModManager.getActiveViewId(), null);
  assert.strictEqual(isQuietClass(appContainer), false, 'no app on screen, no quiet mode');
  ModManager.openApp('workshop');
  assert.strictEqual(isQuietClass(appContainer), true, 'and it arrives with the app');
});

test('a corrupt or absent key is not quiet mode', async () => {
  storeMap.set('deepsteve-app-quiet', 'not json');
  const { ModManager, appContainer } = await setup({ keepStorage: true });
  ModManager.openApp('workshop');
  assert.strictEqual(isQuietClass(appContainer), false);
  assert.strictEqual(ModManager.isQuietMode(), false);
});

test('isQuietAvailable gates the ⌘\\ registry entry', async () => {
  // context-views registers ⌘\ with isEnabled: () => ModManager.isQuietAvailable(), so this is
  // what keeps the ⌘? overlay from advertising a key that does nothing.
  const { ModManager } = await setup();
  assert.strictEqual(ModManager.isQuietAvailable(), false, 'nothing in the slot');

  ModManager.showView({ id: 'tower', name: 'Tower', src: '/mods/tower/index.html' });
  assert.strictEqual(ModManager.isQuietAvailable(), false, 'a view is not a place');

  ModManager.openApp('workshop');
  assert.strictEqual(ModManager.isQuietAvailable(), true);

  ModManager.showTerminalForSession('sess-a');
  assert.strictEqual(ModManager.isQuietAvailable(), false, 'backgrounded: the key belongs to the strip again');
});

test('setQuietMode with no view in the slot writes nothing', async () => {
  const { ModManager, appContainer } = await setup();
  ModManager.setQuietMode(true);
  assert.strictEqual(storeMap.has(QUIET_KEY), false, 'there is no app for the preference to be about');
  assert.strictEqual(isQuietClass(appContainer), false);
});
