// Headless unit test for the pure helpers in public/js/session-restore-modal.js (#560).
//
// No browser, no Docker. The exported helpers (defaultSelection, primaryLabel,
// applyClaim, allRowKeys) are pure and driven directly; showSessionRestoreModal
// itself needs a real DOM and is exercised by the integration/manual flows, not
// here — repo convention is pure-helper extraction over DOM stubbing (see
// window-merge.test.js).
//
// The import chain pulls in tab-manager.js, which registers document listeners
// at module scope — hence the minimal document stub. window.parent = window
// keeps storage-namespace.js at depth 0 (same trap documented in
// context-views.test.js).
//
// Run: node --test test/unit/session-restore-modal.test.js

const { test } = require('node:test');
const assert = require('node:assert');

globalThis.window = globalThis;
globalThis.window.parent = globalThis.window;
globalThis.document = {
  addEventListener: () => {},
  getElementById: () => null,
};

const load = () => import('../../public/js/session-restore-modal.js');

// --------------------------------------------------------------- fixtures

const sess = (id, extra = {}) => ({ id, cwd: '/repo', name: null, ...extra });
const win = (windowId, sessions) => ({ windowId, live: false, lastActive: 1000, sessions });
const recent = (key, extra = {}) => ({ key, cwd: '/repo', name: null, updatedAt: 1000, ...extra });

// The /api/recoverable-sessions shape after client-side merging.
function data({ windows = [], ungrouped = [], closed = [], recents = [] } = {}) {
  return { windows, ungrouped, closed, recents };
}

// --------------------------------------------------------------- defaultSelection

test('defaultSelection checks window + ungrouped sessions, leaves closed and recents unchecked', async () => {
  const { defaultSelection } = await load();
  const checked = defaultSelection(data({
    windows: [win('w1', [sess('a'), sess('b')])],
    ungrouped: [sess('c')],
    closed: [sess('d', { status: 'closed' })],
    recents: [recent('r1')],
  }));
  assert.deepStrictEqual([...checked].sort(), ['a', 'b', 'c']);
});

test('defaultSelection falls back to closed tombstones when nothing else exists — the wipe case', async () => {
  const { defaultSelection } = await load();
  const checked = defaultSelection(data({
    closed: [sess('d'), sess('e')],
    recents: [recent('r1')],
  }));
  assert.deepStrictEqual([...checked].sort(), ['d', 'e']);
});

test('defaultSelection falls back to recents as the last tier', async () => {
  const { defaultSelection } = await load();
  const checked = defaultSelection(data({ recents: [recent('r1'), recent('r2')] }));
  assert.deepStrictEqual([...checked].sort(), ['recent:r1', 'recent:r2']);
});

test('defaultSelection on empty data is empty', async () => {
  const { defaultSelection } = await load();
  assert.strictEqual(defaultSelection(data()).size, 0);
});

// --------------------------------------------------------------- primaryLabel

test('primaryLabel: Restore All when everything is checked', async () => {
  const { primaryLabel } = await load();
  assert.strictEqual(primaryLabel(3, 3), 'Restore All (3)');
  assert.strictEqual(primaryLabel(1, 1), 'Restore All (1)');
});

test('primaryLabel: partial and empty selections', async () => {
  const { primaryLabel } = await load();
  assert.strictEqual(primaryLabel(1, 3), 'Restore Selected (1 of 3)');
  assert.strictEqual(primaryLabel(0, 3), 'Restore Selected');
});

// --------------------------------------------------------------- allRowKeys

test('allRowKeys walks every bucket, prefixing recents', async () => {
  const { allRowKeys } = await load();
  const keys = allRowKeys(data({
    windows: [win('w1', [sess('a')]), win('w2', [sess('b')])],
    ungrouped: [sess('c')],
    closed: [sess('d')],
    recents: [recent('r1')],
  }));
  assert.deepStrictEqual(keys.sort(), ['a', 'b', 'c', 'd', 'recent:r1']);
});

// --------------------------------------------------------------- applyClaim

test('applyClaim removes claimed rows and prunes emptied window groups', async () => {
  const { applyClaim } = await load();
  const before = data({
    windows: [win('w1', [sess('a'), sess('b')]), win('w2', [sess('c')])],
    ungrouped: [sess('d')],
    closed: [sess('e')],
    recents: [recent('r1')],
  });
  const checked = new Set(['a', 'b', 'c', 'd']);
  const out = applyClaim(before, checked, { sessionIds: ['b', 'c', 'e'], recentKeys: ['r1'] });

  assert.deepStrictEqual(out.data.windows.map(w => w.windowId), ['w1']); // w2 emptied → pruned
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a']);
  assert.deepStrictEqual(out.data.ungrouped.map(s => s.id), ['d']);
  assert.deepStrictEqual(out.data.closed, []);
  assert.deepStrictEqual(out.data.recents, []);
});

test('applyClaim preserves the survivors\' check state exactly', async () => {
  const { applyClaim } = await load();
  const before = data({
    windows: [win('w1', [sess('a'), sess('b'), sess('c')])],
  });
  // b claimed elsewhere; a was checked, c deliberately unchecked.
  const out = applyClaim(before, new Set(['a', 'b']), { sessionIds: ['b'] });
  assert.deepStrictEqual([...out.checkedKeys], ['a']); // b gone, c still unchecked
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a', 'c']);
});

test('applyClaim with unknown ids is a no-op', async () => {
  const { applyClaim } = await load();
  const before = data({ windows: [win('w1', [sess('a')])], recents: [recent('r1')] });
  const checked = new Set(['a']);
  const out = applyClaim(before, checked, { sessionIds: ['zzz'], recentKeys: ['nope'] });
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a']);
  assert.deepStrictEqual(out.data.recents.map(r => r.key), ['r1']);
  assert.deepStrictEqual([...out.checkedKeys], ['a']);
});

test('applyClaim claiming everything leaves nothing offerable', async () => {
  const { applyClaim, allRowKeys } = await load();
  const before = data({
    windows: [win('w1', [sess('a')])],
    closed: [sess('b')],
    recents: [recent('r1')],
  });
  const out = applyClaim(before, new Set(['a']), { sessionIds: ['a', 'b'], recentKeys: ['r1'] });
  assert.strictEqual(allRowKeys(out.data).length, 0);
  assert.strictEqual(out.checkedKeys.size, 0);
});

test('applyClaim tolerates a claim message with missing fields', async () => {
  const { applyClaim } = await load();
  const before = data({ windows: [win('w1', [sess('a')])] });
  const out = applyClaim(before, new Set(['a']), {}); // no sessionIds/recentKeys
  assert.deepStrictEqual(out.data.windows[0].sessions.map(s => s.id), ['a']);
});
