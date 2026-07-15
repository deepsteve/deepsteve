// Headless unit test for public/js/shortcuts.js — the shortcut registry (#549).
//
// shortcuts.js is pure (no imports, no DOM at module scope), so it needs no stubs
// at all. Each test re-imports it with a unique ?query to get a fresh `entries`
// array, since the registry is module-level state.
//
// Run: node --test test/unit/shortcuts.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let importCount = 0;
const fresh = () => import(`../../public/js/shortcuts.js?v=${++importCount}`);

// A KeyboardEvent-shaped plain object. Modifiers default false, matching a real event.
const ev = (props) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...props });

// ------------------------------------------------------------ parse / format

test('parseShortcut splits modifiers from the key', async () => {
  const { parseShortcut } = await fresh();
  assert.deepStrictEqual(parseShortcut('Meta+Shift+?'), {
    key: '?', mods: { meta: true, ctrl: false, shift: true, alt: false },
  });
  assert.deepStrictEqual(parseShortcut('Meta+k'), {
    key: 'k', mods: { meta: true, ctrl: false, shift: false, alt: false },
  });
});

test('formatShortcut renders mac glyphs', async () => {
  const { formatShortcut } = await fresh();
  assert.strictEqual(formatShortcut('Meta+Shift+?'), '⌘⇧?');
  assert.strictEqual(formatShortcut('Meta+/'), '⌘/');
  assert.strictEqual(formatShortcut('Meta+k'), '⌘K');
  assert.strictEqual(formatShortcut('Ctrl+Alt+Shift+j'), '⌃⌥⇧J');
  assert.strictEqual(formatShortcut(''), '');
});

// ------------------------------------------------------------------ matching

test('matchesShortcut requires strict equality on all four modifiers', async () => {
  const { matchesShortcut } = await fresh();
  assert.ok(matchesShortcut(ev({ key: 'f', metaKey: true }), 'Meta+f'));
  // The property that keeps Ctrl+F reaching the PTY for vim's <C-f>.
  assert.ok(!matchesShortcut(ev({ key: 'f', ctrlKey: true }), 'Meta+f'));
  // An extra modifier must not match either.
  assert.ok(!matchesShortcut(ev({ key: 'f', metaKey: true, shiftKey: true }), 'Meta+f'));
  assert.ok(!matchesShortcut(ev({ key: 'g', metaKey: true }), 'Meta+f'));
});

test('matchesShortcut is case-insensitive on the key (Caps Lock)', async () => {
  const { matchesShortcut } = await fresh();
  assert.ok(matchesShortcut(ev({ key: 'F', metaKey: true }), 'Meta+f'));
});

test('matchesShortcut tolerates an event with no key', async () => {
  const { matchesShortcut } = await fresh();
  assert.ok(!matchesShortcut(ev({}), 'Meta+f'));
});

// ---------------------------------------------------------------- alternates

test('register accepts a list of alternates and matches any of them', async () => {
  const { register } = await fresh();
  const matches = register({
    id: 'help', group: 'General', description: 'help',
    shortcut: ['Meta+Shift+?', 'Meta+/'],
  });
  assert.ok(matches(ev({ key: '?', metaKey: true, shiftKey: true })), '⌘⇧? should match');
  assert.ok(matches(ev({ key: '/', metaKey: true })), '⌘/ should match');
  assert.ok(!matches(ev({ key: 'k', metaKey: true })), '⌘K should not match');
});

test('getAll renders every alternate as its own key token', async () => {
  const { register, getAll } = await fresh();
  register({
    id: 'help', group: 'General', description: 'help',
    shortcut: ['Meta+Shift+?', 'Meta+/'],
  });
  assert.deepStrictEqual(getAll()[0].keys, ['⌘⇧?', '⌘/']);
});

// --------------------------------------------------------------- live values

test('getShortcut is resolved live by both the matcher and getAll', async () => {
  const { register, getAll } = await fresh();
  let shortcut = 'Meta+k';
  const matches = register({
    id: 'palette', group: 'General', description: 'palette',
    getShortcut: () => shortcut,
  });

  assert.ok(matches(ev({ key: 'k', metaKey: true })));
  assert.deepStrictEqual(getAll()[0].keys, ['⌘K']);

  shortcut = 'Meta+Shift+k'; // what setShortcut() does

  assert.ok(!matches(ev({ key: 'k', metaKey: true })), 'old combo must stop matching');
  assert.ok(matches(ev({ key: 'k', metaKey: true, shiftKey: true })), 'new combo must match');
  assert.deepStrictEqual(getAll()[0].keys, ['⌘⇧K'], 'overlay must show the new combo');
});

test('isEnabled is resolved live', async () => {
  const { register, getAll } = await fresh();
  let on = false;
  register({ id: 'x', group: 'General', description: 'x', shortcut: 'Meta+x', isEnabled: () => on });
  assert.strictEqual(getAll()[0].enabled, false);
  on = true;
  assert.strictEqual(getAll()[0].enabled, true);
});

test('an entry with no isEnabled defaults to enabled', async () => {
  const { register, getAll } = await fresh();
  register({ id: 'x', group: 'General', description: 'x', shortcut: 'Meta+x' });
  assert.strictEqual(getAll()[0].enabled, true);
});

// -------------------------------------------------------------- code matching

test("match:'code' pins to the physical key, ignoring the layout character", async () => {
  const { register } = await fresh();
  const matches = register({
    id: 'panel', group: 'Views', description: 'panel',
    shortcut: 'Meta+p', match: 'code',
  });
  assert.ok(matches(ev({ code: 'KeyP', key: 'p', metaKey: true })), 'QWERTY');
  // Same physical key, different layout character (e.g. Option/other layouts).
  assert.ok(matches(ev({ code: 'KeyP', key: 'π', metaKey: true })), 'non-QWERTY layout');
  // The character 'p' produced by a different physical key must NOT fire.
  assert.ok(!matches(ev({ code: 'KeyR', key: 'p', metaKey: true })), 'wrong physical key');
  assert.ok(!matches(ev({ code: 'KeyP', key: 'p' })), 'missing Meta');
  assert.ok(!matches(ev({ code: 'KeyP', key: 'p', metaKey: true, shiftKey: true })), 'extra Shift');
});

test("match:'code' maps digits too", async () => {
  const { register } = await fresh();
  const matches = register({ id: 'd', group: 'Tabs', description: 'd', shortcut: 'Meta+1', match: 'code' });
  assert.ok(matches(ev({ code: 'Digit1', key: '1', metaKey: true })));
});

// ------------------------------------------------------- registration errors

test('register throws unless exactly one of shortcut / getShortcut is given', async () => {
  const { register } = await fresh();
  const base = { id: 'x', group: 'General', description: 'x' };
  assert.throws(() => register({ ...base }), /exactly one/);
  assert.throws(() => register({ ...base, shortcut: 'Meta+x', getShortcut: () => 'Meta+y' }), /exactly one/);
});

test('register throws on missing id / group / description', async () => {
  const { register } = await fresh();
  assert.throws(() => register({ group: 'General', description: 'x', shortcut: 'Meta+x' }), /required/);
  assert.throws(() => register({ id: 'x', description: 'x', shortcut: 'Meta+x' }), /required/);
  assert.throws(() => register({ id: 'x', group: 'General', shortcut: 'Meta+x' }), /required/);
});

test("match:'code' with a configurable shortcut throws at registration", async () => {
  const { register } = await fresh();
  // The settings recorder emits e.key tokens, so a user-recorded string could never
  // drive a code matcher — better to fail loudly than ship a binding that never fires.
  assert.throws(() => register({
    id: 'x', group: 'General', description: 'x',
    getShortcut: () => 'Meta+p', match: 'code',
  }), /requires a static shortcut/);
});

test("match:'code' with an unmappable key throws at registration", async () => {
  const { register } = await fresh();
  assert.throws(() => register({
    id: 'x', group: 'Views', description: 'x',
    shortcut: 'Meta+ArrowUp', match: 'code',
  }), /no KeyboardEvent.code/);
});

test('registerInfo requires a non-empty keys array', async () => {
  const { registerInfo } = await fresh();
  const base = { id: 'x', group: 'Tabs', description: 'x' };
  assert.throws(() => registerInfo({ ...base }), /keys/);
  assert.throws(() => registerInfo({ ...base, keys: [] }), /keys/);
});

// ------------------------------------------------------------------- getAll

test('getAll sorts by GROUPS order, then registration order within a group', async () => {
  const { register, registerInfo, getAll } = await fresh();
  register({ id: 'search', group: 'Terminal', description: 't', shortcut: 'Meta+f' });
  register({ id: 'palette', group: 'General', description: 'g', shortcut: 'Meta+k' });
  register({ id: 'overview', group: 'Views', description: 'v1', shortcut: 'Meta+o' });
  registerInfo({ id: 'tabs', group: 'Tabs', description: 'tab', keys: ['⌘1'] });
  register({ id: 'panel', group: 'Views', description: 'v2', shortcut: 'Meta+p' });

  assert.deepStrictEqual(getAll().map(e => e.id),
    ['palette', 'tabs', 'overview', 'panel', 'search']);
});

test('an unknown group sorts last rather than vanishing', async () => {
  const { register, getAll } = await fresh();
  register({ id: 'weird', group: 'Zzz', description: 'w', shortcut: 'Meta+z' });
  register({ id: 'palette', group: 'General', description: 'g', shortcut: 'Meta+k' });

  const ids = getAll().map(e => e.id);
  assert.deepStrictEqual(ids, ['palette', 'weird']);
  assert.strictEqual(ids.includes('weird'), true, 'unknown group must still be listed');
});

test('registerInfo entries pass their keys and combine through', async () => {
  const { registerInfo, getAll } = await fresh();
  registerInfo({ id: 'hold', group: 'Tabs', description: 'hold', keys: ['Hold ⌘', '1–9'], combine: 'then' });
  const e = getAll()[0];
  assert.strictEqual(e.kind, 'info');
  assert.deepStrictEqual(e.keys, ['Hold ⌘', '1–9']);
  assert.strictEqual(e.combine, 'then');
});

test('combine defaults to or', async () => {
  const { register, getAll } = await fresh();
  register({ id: 'x', group: 'General', description: 'x', shortcut: 'Meta+x' });
  assert.strictEqual(getAll()[0].combine, 'or');
});

test('a duplicate id replaces in place rather than appending', async () => {
  // The headless module tests re-import a module with ?v= to reset its state, which
  // re-runs its top-level register() against this same registry. Appending would
  // duplicate overlay rows.
  const { register, getAll } = await fresh();
  register({ id: 'a', group: 'General', description: 'first', shortcut: 'Meta+a' });
  register({ id: 'b', group: 'General', description: 'second', shortcut: 'Meta+b' });
  register({ id: 'a', group: 'General', description: 'first again', shortcut: 'Meta+a' });

  assert.deepStrictEqual(getAll().map(e => e.id), ['a', 'b'], 'no duplicate, original slot kept');
  assert.strictEqual(getAll()[0].description, 'first again', 'last write wins');
});

test('getAll does not leak internals', async () => {
  const { register, getAll } = await fresh();
  register({ id: 'x', group: 'General', description: 'x', shortcut: 'Meta+x' });
  assert.deepStrictEqual(Object.keys(getAll()[0]).sort(),
    ['combine', 'description', 'enabled', 'group', 'id', 'keys', 'kind']);
});
