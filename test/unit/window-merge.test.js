// Headless unit test for mergeWindows() in public/js/window-manager.js (#551).
//
// No browser, no Docker. The import chain is safe in plain Node: storage-namespace.js
// touches bare `window` inside a try/catch, and session-store.js only reaches
// localStorage from inside getStorage(), never at module scope — so importing
// window-manager.js does not throw and mergeWindows can be driven directly.
//
// window.parent = window keeps storage-namespace.js at depth 0. Without it the
// depth loop hits `undefined.parent`, the catch swallows it, recursionDepth becomes
// 1, and every storage key silently gains a ds1- prefix (same trap documented in
// context-views.test.js).
//
// Run: node --test test/unit/window-merge.test.js

const { test } = require('node:test');
const assert = require('node:assert');

globalThis.window = globalThis;
globalThis.window.parent = globalThis.window;

const load = () => import('../../public/js/window-manager.js');

// --------------------------------------------------------------- fixtures

// A localStorage window entry as SessionStore stores it: array order IS tab order.
function localWindow(sessions, lastActive = 1000) {
  return { sessions, lastActive };
}

// A /api/windows entry.
function serverWindow(windowId, sessions, { live = false, lastActive = 1000 } = {}) {
  return { windowId, live, lastActive, sessions };
}

function serverSession(id, { name = null, cwd = '/repo', createdAt = 0 } = {}) {
  return { id, name, cwd, agentType: 'claude', status: 'active', createdAt, lastActivity: createdAt };
}

// Build the { windows, knownSessionIds } payload shape fetchServerWindows produces.
function server(windows, extraKnownIds = []) {
  const grouped = windows.flatMap(w => w.sessions.map(s => s.id));
  return { windows, knownSessionIds: new Set([...grouped, ...extraKnownIds]) };
}

const ids = list => list.map(s => s.id);

// --------------------------------------------------------------- tests

test('server-only window is restored — the origin-change case', async () => {
  const { mergeWindows } = await load();
  // localStorage is empty: the new origin has never seen these windows.
  const out = mergeWindows({
    local: {},
    server: server([serverWindow('win-old', [
      serverSession('bbb', { createdAt: 200 }),
      serverSession('aaa', { createdAt: 100 }),
    ])]),
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.strictEqual(out.length, 1, 'the server-side window is offered');
  assert.strictEqual(out[0].windowId, 'win-old');
  assert.deepStrictEqual(ids(out[0].sessions), ['bbb', 'aaa'],
    'server order is preserved as sent (endpoint sorts by createdAt)');
});

test('merged window keeps localStorage order and client-only tabs', async () => {
  const { mergeWindows } = await load();
  const out = mergeWindows({
    local: {
      'win-a': localWindow([
        { id: 'sess1', cwd: '/repo', name: 'first' },
        { id: 'mod1', name: 'Tasks', type: 'mod-tab', modId: 'tasks' },
        { id: 'sess2', cwd: '/repo', name: 'second' },
        { id: 'disp1', name: 'Chart', type: 'display-tab', cwd: '/repo' },
      ]),
    },
    // Server groups them in a different order and knows nothing of mod/display tabs.
    server: server([serverWindow('win-a', [
      serverSession('sess2'), serverSession('sess1'),
    ])]),
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.deepStrictEqual(ids(out[0].sessions), ['sess1', 'mod1', 'sess2', 'disp1'],
    'localStorage tab order wins and client-only tabs survive');
});

test('sessions the server says are gone are dropped; ones it adds are appended', async () => {
  const { mergeWindows } = await load();
  const out = mergeWindows({
    local: {
      'win-a': localWindow([
        { id: 'alive', cwd: '/repo', name: 'alive' },
        { id: 'dead', cwd: '/repo', name: 'dead' },
      ]),
    },
    server: server([serverWindow('win-a', [
      serverSession('alive'),
      serverSession('new', { name: 'opened elsewhere' }),
    ])]),
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.deepStrictEqual(ids(out[0].sessions), ['alive', 'new'],
    'dead session pruned, server-only session appended');
});

test('THE UPGRADE CLIFF: sessions that exist but have no windowId are kept (#551)', async () => {
  const { mergeWindows } = await load();
  // A pre-#551 server wrote savedState entries with no windowId (the old
  // ws.on('close') path stripped it). Those sessions are alive and restorable, but
  // /api/windows can't group them — so `windows` is empty while knownSessionIds
  // lists them. localStorage is intact: this is an ordinary close-and-reopen, NOT
  // an origin change. Using the grouping as an existence oracle would delete this
  // user's window and hand them the very bug #551 is about.
  const out = mergeWindows({
    local: {
      'win-a': localWindow([
        { id: 'sess1', cwd: '/repo', name: 'first' },
        { id: 'sess2', cwd: '/repo', name: 'second' },
      ]),
    },
    server: server([], ['sess1', 'sess2']), // exist, but grouped under no window
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.strictEqual(out.length, 1, 'the window is NOT dropped');
  assert.deepStrictEqual(ids(out[0].sessions), ['sess1', 'sess2']);
});

test('a window holding only client-only tabs survives', async () => {
  const { mergeWindows } = await load();
  // The server has no window association for mod/display tabs at all, so this
  // window can never appear in `windows` — it must not be mistaken for a tombstone.
  const out = mergeWindows({
    local: {
      'win-a': localWindow([{ id: 'mod1', name: 'Tasks', type: 'mod-tab', modId: 'tasks' }]),
    },
    server: server([]),
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(ids(out[0].sessions), ['mod1']);
});

test('a session the server reassigned to another window is not offered here', async () => {
  const { mergeWindows } = await load();
  // Restored in a second browser: the server now groups sess1/sess2 under win-new,
  // but this browser's localStorage still claims them for win-old. Offering win-old
  // would restore zero tabs (the server rejects already-connected sessions) and leave
  // the user staring at an empty window, with the phantom re-offered every time.
  // Existence alone can't catch this — both sessions ARE in knownSessionIds.
  const out = mergeWindows({
    local: {
      'win-old': localWindow([
        { id: 'sess1', cwd: '/repo', name: 'first' },
        { id: 'sess2', cwd: '/repo', name: 'second' },
      ]),
    },
    server: server([
      serverWindow('win-new', [serverSession('sess1'), serverSession('sess2')], { live: true }),
    ]),
    myWindowId: 'win-me',
    liveIds: new Set(['win-new']),
  });

  assert.deepStrictEqual(out, [], 'win-old is a phantom — every session moved away');
});

test('reassignment only drops the sessions that actually moved', async () => {
  const { mergeWindows } = await load();
  const out = mergeWindows({
    local: {
      'win-a': localWindow([
        { id: 'stayed', cwd: '/repo', name: 'stayed' },
        { id: 'moved', cwd: '/repo', name: 'moved' },
      ]),
    },
    server: server([
      serverWindow('win-a', [serverSession('stayed')]),
      serverWindow('win-b', [serverSession('moved')], { live: true }),
    ]),
    myWindowId: 'win-me',
    liveIds: new Set(['win-b']),
  });

  assert.deepStrictEqual(ids(out[0].sessions), ['stayed'], 'only the moved session leaves');
});

test('a genuine tombstone is pruned', async () => {
  const { mergeWindows } = await load();
  // Every session gone from the server AND not client-only: this is the dead
  // window that used to accumulate forever (118 windows / 3 alive).
  const out = mergeWindows({
    local: {
      'win-dead': localWindow([
        { id: 'gone1', cwd: '/repo', name: 'gone' },
        { id: 'gone2', cwd: '/repo', name: 'gone' },
      ]),
      'win-live': localWindow([{ id: 'here', cwd: '/repo', name: 'here' }]),
    },
    server: server([serverWindow('win-live', [serverSession('here')])]),
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.deepStrictEqual(out.map(w => w.windowId), ['win-live'], 'dead window pruned');
});

test('server === null preserves the pre-#551 localStorage-only behavior', async () => {
  const { mergeWindows } = await load();
  // Older server, failed fetch, or a nested Baby Browser. With no server opinion
  // nothing may be dropped — we cannot tell a dead session from an unknown one.
  const out = mergeWindows({
    local: {
      'win-a': localWindow([
        { id: 'whatever', cwd: '/repo', name: 'whatever' },
        { id: 'unknown', cwd: '/repo', name: 'unknown' },
      ]),
    },
    server: null,
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(ids(out[0].sessions), ['whatever', 'unknown'],
    'no session dropped without a server opinion');
});

test('own window and live windows are excluded', async () => {
  const { mergeWindows } = await load();
  const out = mergeWindows({
    local: {
      'win-me': localWindow([{ id: 'mine', cwd: '/repo', name: 'mine' }]),
      'win-live': localWindow([{ id: 'theirs', cwd: '/repo', name: 'theirs' }]),
      'win-orphan': localWindow([{ id: 'orphan', cwd: '/repo', name: 'orphan' }]),
    },
    server: server([
      serverWindow('win-me', [serverSession('mine')]),
      serverWindow('win-live', [serverSession('theirs')], { live: true }),
      serverWindow('win-orphan', [serverSession('orphan')]),
    ]),
    myWindowId: 'win-me',
    liveIds: new Set(['win-live']), // as listOrphanedWindows() unions roll-call + server.live
  });

  assert.deepStrictEqual(out.map(w => w.windowId), ['win-orphan']);
});

test('windows are sorted most-recently-active first', async () => {
  const { mergeWindows } = await load();
  const out = mergeWindows({
    local: {
      'win-old': localWindow([{ id: 'a', cwd: '/repo', name: 'a' }], 100),
      'win-new': localWindow([{ id: 'b', cwd: '/repo', name: 'b' }], 900),
      'win-mid': localWindow([{ id: 'c', cwd: '/repo', name: 'c' }], 500),
    },
    server: null,
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.deepStrictEqual(out.map(w => w.windowId), ['win-new', 'win-mid', 'win-old']);
});

test('lastActive takes the newer of localStorage and server', async () => {
  const { mergeWindows } = await load();
  const out = mergeWindows({
    local: { 'win-a': localWindow([{ id: 'x', cwd: '/repo', name: 'x' }], 100) },
    server: server([serverWindow('win-a', [serverSession('x')], { lastActive: 900 })]),
    myWindowId: 'win-me',
    liveIds: new Set(),
  });

  assert.strictEqual(out[0].lastActive, 900);
});
