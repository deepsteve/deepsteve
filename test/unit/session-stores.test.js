// Headless unit test for public/js/session-stores.js — the session-store write
// facade (#385). The facade is the ONE writer of both client stores:
// TabSessions (sessionStorage, per-tab) and SessionStore (localStorage,
// cross-window). These tests pin that every dual write (add/remove/rename/
// reorder) leaves BOTH stores consistent, and that the TabSessions-only methods
// (updateId, setClaudeSessionId, clearTabSessions, addTabOnly) touch only the
// per-tab store — the exact behavior app.js relied on before the facade existed.
//
// No browser, no Docker: stub sessionStorage / localStorage / window BEFORE
// importing the module. window.parent = window keeps storage-namespace.js at
// depth 0 so keys get no ds1- prefix (and both stores share one key space).
//
// Run: node --test test/unit/session-stores.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals
const sMap = new Map(); // sessionStorage (TabSessions)
const lMap = new Map(); // localStorage (SessionStore)

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

const WIN = 'win-test';

// ---------------------------------------------------------------- helpers
let mods;
async function load() {
  if (!mods) {
    const facade = await import('../../public/js/session-stores.js');
    const store = await import('../../public/js/session-store.js');
    mods = { ...facade, SessionStore: store.SessionStore };
  }
  return mods;
}

function reset() { sMap.clear(); lMap.clear(); }

// ids as seen by each store, for the given window
const tabIds = (m) => m.getTabSessions().map((s) => s.id);
const storeIds = (m) => m.SessionStore.getWindowSessions(WIN).map((s) => s.id);

// ---------------------------------------------------------------- tests

test('add writes both stores', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  assert.deepStrictEqual(tabIds(m), ['a']);
  assert.deepStrictEqual(storeIds(m), ['a']);
});

test('remove clears both stores', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  m.SessionStores.add(WIN, { id: 'b', cwd: '/y', name: 'B' });
  m.SessionStores.remove(WIN, 'a');
  assert.deepStrictEqual(tabIds(m), ['b']);
  assert.deepStrictEqual(storeIds(m), ['b']);
});

test('rename updates the name in both stores', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  m.SessionStores.rename(WIN, 'a', 'Renamed');
  assert.strictEqual(m.getTabSessions().find((s) => s.id === 'a').name, 'Renamed');
  assert.strictEqual(m.SessionStore.getWindowSessions(WIN).find((s) => s.id === 'a').name, 'Renamed');
});

test('reorder applies the same order to both stores', async () => {
  const m = await load(); reset();
  for (const id of ['a', 'b', 'c']) m.SessionStores.add(WIN, { id, cwd: '/x', name: id });
  m.SessionStores.reorder(WIN, ['c', 'a', 'b']);
  assert.deepStrictEqual(tabIds(m), ['c', 'a', 'b']);
  assert.deepStrictEqual(storeIds(m), ['c', 'a', 'b']);
});

test('updateId remaps the id in TabSessions only (SessionStore intentionally untouched)', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'old', cwd: '/x', name: 'A' });
  m.SessionStores.updateId('old', 'new');
  assert.deepStrictEqual(tabIds(m), ['new']);   // per-tab store remapped
  assert.deepStrictEqual(storeIds(m), ['old']); // cross-window store left as-is (matches pre-#385 behavior)
});

test('setClaudeSessionId writes TabSessions only', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  m.SessionStores.setClaudeSessionId('a', 'claude-uuid-123');
  assert.strictEqual(m.getTabSessions().find((s) => s.id === 'a').claudeSessionId, 'claude-uuid-123');
  assert.strictEqual(m.SessionStore.getWindowSessions(WIN).find((s) => s.id === 'a').claudeSessionId, undefined);
});

test('addTabOnly writes the per-tab store only (restore path)', async () => {
  const m = await load(); reset();
  m.SessionStores.addTabOnly({ id: 'a', cwd: '/x', name: 'A' });
  assert.deepStrictEqual(tabIds(m), ['a']);
  assert.deepStrictEqual(storeIds(m), []); // SessionStore was written per-bucket elsewhere, not here
});

test('clearTabSessions empties the per-tab store but leaves SessionStore', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  m.SessionStores.add(WIN, { id: 'b', cwd: '/y', name: 'B' });
  m.SessionStores.clearTabSessions();
  assert.deepStrictEqual(tabIds(m), []);
  assert.deepStrictEqual(storeIds(m), ['a', 'b']); // cross-window state (owned by other windows) survives
});

test('a mixed add/remove sequence keeps both stores membership-identical', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  m.SessionStores.add(WIN, { id: 'b', cwd: '/y', name: 'B' });
  m.SessionStores.add(WIN, { id: 'c', cwd: '/z', name: 'C' });
  m.SessionStores.remove(WIN, 'b');
  m.SessionStores.add(WIN, { id: 'd', cwd: '/w', name: 'D' });
  assert.deepStrictEqual([...tabIds(m)].sort(), [...storeIds(m)].sort());
  assert.deepStrictEqual([...tabIds(m)].sort(), ['a', 'c', 'd']);
});

test('add dedupes by id in both stores', async () => {
  const m = await load(); reset();
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  m.SessionStores.add(WIN, { id: 'a', cwd: '/x', name: 'A' });
  assert.deepStrictEqual(tabIds(m), ['a']);
  assert.deepStrictEqual(storeIds(m), ['a']);
});
