// The fresh-window reset, exercised against a *cloned* sessionStorage (#597).
//
// window.open() from a same-origin page copies the opener's sessionStorage into the new
// window, so a new deepsteve window boots holding its parent's deepsteve-window-id and
// deepsteve-tab-sessions. init() undoes that when ?fresh=1 is present. This test seeds
// exactly that clone and asserts the three reset calls leave the window with its own
// identity — and, just as importantly, leave the inherited view preferences alone.
//
// No browser, no Docker: stub sessionStorage / localStorage / window before importing.
// window.parent = window keeps storage-namespace.js at depth 0 so keys are unprefixed.
//
// Run: node --test test/unit/fresh-window-reset.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const sMap = new Map();
const lMap = new Map();

globalThis.sessionStorage = {
  getItem: (k) => (sMap.has(k) ? sMap.get(k) : null),
  setItem: (k, v) => sMap.set(k, String(v)),
  removeItem: (k) => sMap.delete(k),
};
globalThis.localStorage = {
  getItem: (k) => (lMap.has(k) ? lMap.get(k) : null),
  setItem: (k, v) => lMap.set(k, String(v)),
  removeItem: (k) => lMap.delete(k),
};
globalThis.window = {};
globalThis.window.parent = globalThis.window; // depth 0 → unprefixed storage keys

// The state window.open() handed us: everything the parent window had.
function seedClonedSessionStorage() {
  sMap.clear();
  lMap.clear();
  sMap.set('deepsteve-window-id', 'win-parent');
  sMap.set('deepsteve-tab-sessions', JSON.stringify([{ id: 'aaa', cwd: '/p' }, { id: 'bbb', cwd: '/q' }]));
  sMap.set('deepsteve-active-tab', 'aaa');
  // View preferences — deliberately NOT part of session identity.
  sMap.set('deepsteve-context-width', '260');
  sMap.set('deepsteve-context-active', 'ctx-1');
}

let mods;
async function load() {
  if (!mods) {
    const [wm, ss] = await Promise.all([
      import('../../public/js/window-manager.js?fresh'),
      import('../../public/js/session-stores.js?fresh'),
    ]);
    mods = { WindowManager: wm.WindowManager, ...ss };
  }
  return mods;
}

test('the clone alone would make the new window impersonate its parent', async () => {
  seedClonedSessionStorage();
  const { WindowManager, getTabSessions } = await load();
  // Without the reset this is what init() sees — hence the "existing tab with sessions"
  // branch, and two windows restoring the same PTYs.
  assert.strictEqual(WindowManager.hasExistingWindowId(), true);
  assert.strictEqual(WindowManager.getWindowId(), 'win-parent');
  assert.strictEqual(getTabSessions().length, 2);
});

test('the reset gives the fresh window its own identity', async () => {
  seedClonedSessionStorage();
  const { WindowManager, SessionStores, getTabSessions } = await load();

  WindowManager.resetWindowId();
  SessionStores.clearTabSessions();
  sessionStorage.removeItem('deepsteve-active-tab'); // what ActiveTab.clear() does

  assert.strictEqual(WindowManager.hasExistingWindowId(), false,
    'the inherited id is gone, so init() takes the genuine new-window branch');
  const minted = WindowManager.getWindowId();
  assert.notStrictEqual(minted, 'win-parent', 'a fresh window gets its own id');
  assert.match(minted, /^win-/);

  assert.deepStrictEqual(getTabSessions(), [],
    "the new window must not try to restore its parent's tabs");
  assert.strictEqual(sessionStorage.getItem('deepsteve-active-tab'), null);
});

test('the reset leaves inherited view preferences alone', async () => {
  // Pins the deliberate scope. sessionStorage.clear() is the tempting shortcut, but at
  // recursionDepth > 0 (Baby Browser) the storage area is shared with the top-level
  // instance — clearing it would wipe the parent's real state. It would also drop the
  // context a window was opened from, which is exactly what a user expects to keep.
  seedClonedSessionStorage();
  const { WindowManager, SessionStores } = await load();

  WindowManager.resetWindowId();
  SessionStores.clearTabSessions();
  sessionStorage.removeItem('deepsteve-active-tab');

  assert.strictEqual(sessionStorage.getItem('deepsteve-context-width'), '260');
  assert.strictEqual(sessionStorage.getItem('deepsteve-context-active'), 'ctx-1');
});
