// Headless unit test for the ONE thing the CALLBACKS registry in mod-manager.js guarantees:
// a page's bridge subscriptions die with the iframe that made them.
//
// They used to be nineteen module-level arrays, and three paths dropped a mod's entries by
// naming the arrays by hand — a panel unloading, a view being replaced, and a mod whose page
// changed being re-injected. Those three lists had drifted to 17, 5 and 13 of the 19, and the
// short one was the view path: a fullscreen mod that called onTasksChanged, onScreenshotEvent
// or any of eleven others kept a live callback pointed at a destroyed realm. Nothing about
// that is visible in a browser — the notify loop's try/catch swallows whatever the dead
// callback throws — so it is pinned here rather than reviewed.
//
// The second rule pinned below is why removal REPLACES a list instead of splicing it: a
// callback that unsubscribes itself while being notified must not shorten the array the
// notify loop is walking, or it silently skips its neighbour.
//
// No browser, no Docker: stub window/document/localStorage BEFORE importing, then drive the
// slot and the bridge the way app.js and a mod's page do. loadAvailableMods() is not needed —
// showView() takes any page, and mod-ness is not what the registry keys on.
//
// Run: node --test test/unit/view-callbacks.test.js

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
// onTasksChanged fires immediately off /api/tasks and swallows the rejection; without this the
// bridge call throws on a missing global instead.
globalThis.fetch = () => Promise.reject(new Error('no server in a unit test'));

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

async function setup() {
  allElements = [];
  storeMap.clear();

  const appRoot = fakeElement();
  appRoot.id = 'app-container';
  const terminals = fakeElement();
  terminals.id = 'terminals';
  appRoot.appendChild(terminals);
  const tabs = fakeElement();
  tabs.id = 'tabs';
  const layoutToggle = fakeElement('button');
  layoutToggle.id = 'layout-toggle';
  tabs.appendChild(layoutToggle);
  appRoot.appendChild(tabs);

  const url = new URL('../../public/js/mod-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const { ModManager } = await import(url.href);
  ModManager.init({
    getSessions: () => [],
    getActiveSessionId: () => null,
    focusSession: () => {},
    getWindowId: () => 'w1',
    onViewChanged: () => {},
  });
  return ModManager;
}

/** The bridge object a page's iframe would receive, without an iframe. */
function bridgeFor(ModManager, viewId) {
  const api = {};
  ModManager.injectBridgeAPI({ contentWindow: api }, viewId, null);
  return api.deepsteve;
}

const TOWER = { id: 'tower', name: 'Tower', src: '/mods/tower/index.html' };
const VILLAGE = { id: 'village', name: 'Village', src: '/mods/village/index.html' };

/**
 * Subscribe to one kind per bridge method that a fullscreen page can plausibly use, and report
 * how many of them fired. `task` and `screenshotEvent` are the interesting two: neither was in
 * the view path's hand-written list, so both leaked. `session` is the control — it always was.
 */
function subscribeAll(bridge) {
  const fired = [];
  bridge.onSessionsChanged(() => fired.push('session'));
  bridge.onTasksChanged(() => fired.push('task'));
  bridge.onScreenshotEvent(() => fired.push('screenshotEvent'));
  bridge.onWSReconnected(() => fired.push('wsReconnected'));
  // onSessionsChanged fires immediately with the current list, by contract. Start the ledger
  // after that, so what it holds is only what a BROADCAST reached.
  fired.length = 0;
  return fired;
}

function notifyAll(ModManager) {
  ModManager.notifySessionsChanged([]);
  ModManager.notifyTasksChanged([]);
  ModManager.notifyScreenshotEvent({ type: 'screenshot-added' });
  ModManager.notifyWSReconnected();
}

// ------------------------------------------------------------------------ tests

test('every kind a view subscribed to is dropped when the slot comes down', async () => {
  const ModManager = await setup();
  ModManager.showView(TOWER);
  const fired = subscribeAll(bridgeFor(ModManager, 'tower'));

  notifyAll(ModManager);
  assert.deepStrictEqual(fired.sort(), ['screenshotEvent', 'session', 'task', 'wsReconnected'],
    'precondition: a live page hears all four');

  fired.length = 0;
  ModManager.hideView('tower');
  notifyAll(ModManager);
  assert.deepStrictEqual(fired, [], 'its iframe is destroyed — not one of them may still fire');
});

test('replacing the slot occupant drops the outgoing page, not the incoming one', async () => {
  const ModManager = await setup();
  ModManager.showView(TOWER);
  const towerFired = subscribeAll(bridgeFor(ModManager, 'tower'));

  ModManager.showView(VILLAGE);
  const villageFired = subscribeAll(bridgeFor(ModManager, 'village'));
  towerFired.length = 0;

  notifyAll(ModManager);
  assert.deepStrictEqual(towerFired, [], 'Tower took the slot away from nobody and lost it to Village');
  assert.deepStrictEqual(villageFired.sort(), ['screenshotEvent', 'session', 'task', 'wsReconnected']);
});

test('a callback that unsubscribes itself does not skip its neighbour', async () => {
  // Why removal replaces the list instead of splicing it. With an in-place splice the notify
  // loop's index slides past the next entry and a second subscriber silently stops being
  // called — a bug that needs two mods to reproduce and looks like the other one's fault.
  const ModManager = await setup();
  ModManager.showView(TOWER);
  const bridge = bridgeFor(ModManager, 'tower');

  const fired = [];
  const unsub = bridge.onScreenshotEvent(() => { fired.push('first'); unsub(); });
  bridge.onScreenshotEvent(() => fired.push('second'));

  ModManager.notifyScreenshotEvent({ type: 'screenshot-added' });
  assert.deepStrictEqual(fired, ['first', 'second'], 'both run on the pass where one leaves');

  fired.length = 0;
  ModManager.notifyScreenshotEvent({ type: 'screenshot-added' });
  assert.deepStrictEqual(fired, ['second'], 'and the one that left stays gone');
});
