// Headless unit test for mod ids renamed in place (mod-manager.js RENAMED_MODS).
//
// Workshop became Inbox. Every browser still holds 'workshop' in its enabled set, its settings
// key and its active view/panel, and Inbox is off by default — so without the carry-over the
// renamed app comes up disabled with its settings reset, and nothing on screen says why.
//
// Same harness as quiet-mode.test.js: fake DOM, fake storage, import mod-manager with a ?t=
// cache-bust so each test gets a fresh module.
//
// Run: node --test test/unit/renamed-mods.test.js

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
  { id: 'inbox', name: 'Inbox', entry: 'index.html', app: true, toolbar: { label: 'Inbox' },
    settings: [{ key: 'pollSeconds', type: 'number', default: 2 }] },
  { id: 'tower', name: 'Tower', entry: 'index.html' },
];

// window.parent === window → nsKey adds no prefix.
const K = {
  enabled: 'deepsteve-enabled-mods',
  known: 'deepsteve-known-mods',
  quiet: 'deepsteve-app-quiet',
  view: 'deepsteve-active-mod-view',
  panel: 'deepsteve-active-panel',
  oldSettings: 'deepsteve-mod-settings-workshop',
  newSettings: 'deepsteve-mod-settings-inbox',
};

/** Boot mod-manager over whatever the test put in storage first. */
async function boot() {
  allElements = [];
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
    onQuietChanged: () => {},
  });
  await mod.ModManager.loadAvailableMods();
  return mod.ModManager;
}

const read = (k) => JSON.parse(storeMap.get(k));

// ------------------------------------------------------------------------ tests

test('a browser that had Workshop enabled has Inbox enabled, with its settings', async () => {
  storeMap.clear();
  storeMap.set(K.enabled, JSON.stringify(['workshop', 'tower']));
  storeMap.set(K.known, JSON.stringify(['workshop', 'tower']));
  storeMap.set(K.quiet, JSON.stringify(['workshop']));
  storeMap.set(K.view, 'workshop');
  storeMap.set(K.panel, 'workshop');
  storeMap.set(K.oldSettings, JSON.stringify({ pollSeconds: 7 }));

  const ModManager = await boot();

  assert.ok(read(K.enabled).includes('inbox'), storeMap.get(K.enabled));
  assert.ok(!read(K.enabled).includes('workshop'), storeMap.get(K.enabled));
  assert.ok(ModManager.isModEnabled ? ModManager.isModEnabled('inbox') : true);
  assert.deepStrictEqual(read(K.quiet), ['inbox']);
  assert.ok(read(K.known).includes('inbox'));
  assert.strictEqual(storeMap.get(K.view), 'inbox');
  assert.strictEqual(storeMap.get(K.panel), 'inbox');
  assert.deepStrictEqual(read(K.newSettings), { pollSeconds: 7 });
  assert.strictEqual(storeMap.has(K.oldSettings), false, 'the old settings key is removed');
});

test('settings already saved under the new id win over the old ones', async () => {
  storeMap.clear();
  storeMap.set(K.enabled, JSON.stringify(['workshop', 'inbox']));
  storeMap.set(K.oldSettings, JSON.stringify({ pollSeconds: 7 }));
  storeMap.set(K.newSettings, JSON.stringify({ pollSeconds: 3 }));

  await boot();

  assert.deepStrictEqual(read(K.enabled), ['inbox'], 'no duplicate id');
  assert.deepStrictEqual(read(K.newSettings), { pollSeconds: 3 });
  assert.strictEqual(storeMap.has(K.oldSettings), false);
});

test('a browser that never had Workshop is left exactly as it was', async () => {
  storeMap.clear();
  storeMap.set(K.enabled, JSON.stringify(['tower']));
  storeMap.set(K.view, 'tower');

  await boot();

  assert.deepStrictEqual(read(K.enabled), ['tower']);
  assert.strictEqual(storeMap.get(K.view), 'tower');
  assert.strictEqual(storeMap.has(K.newSettings), false);
});
