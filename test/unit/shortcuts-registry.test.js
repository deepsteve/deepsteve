// Anti-drift test for the shortcut registry (#549).
//
// The issue's core requirement is that the ⌘? overlay is sourced from where the
// bindings are actually defined, so it can't drift. shortcuts.js enforces that at
// runtime (register() returns the matcher a module must use); this file enforces the
// rest at test time by importing every registering module and asserting on the real
// registry contents.
//
// Stubs the handful of globals these modules touch before importing them, same as
// context-views.test.js. window.parent = window keeps storage-namespace.js at depth 0.
//
// Run: node --test test/unit/shortcuts-registry.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};

function fakeElement() {
  const classes = new Set();
  return {
    id: '', className: '', textContent: '', title: '', innerHTML: '', value: '',
    style: { setProperty: () => {}, removeProperty: () => {} },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    },
    addEventListener: () => {},
    insertAdjacentElement: () => {},
    appendChild: () => {},
    remove: () => {},
    focus: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// Capture-phase keydown listeners the modules install, so we can fire events at them.
const keydownHandlers = [];

globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeElement(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { if (type === 'keydown') keydownHandlers.push(fn); },
  removeEventListener: () => {},
  body: { appendChild: () => {} },
  documentElement: fakeElement(),
  activeElement: null,
};

globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.window.parent = globalThis.window; // depth 0 → unprefixed storage keys
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.fetch = () => Promise.reject(new Error('no server in unit test'));
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const ev = (props) => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault: () => {}, stopPropagation: () => {}, ...props,
});

// --------------------------------------------------------------------- imports
//
// Import every module that registers a shortcut. These run their top-level
// register()/registerInfo() calls against the shared shortcuts.js registry, exactly
// as they do in the browser when app.js imports them.

let mods;
async function loadAll() {
  if (mods) return mods;
  const registry = await import('../../public/js/shortcuts.js');
  const commandPalette = await import('../../public/js/command-palette.js');
  const overviewMode = await import('../../public/js/overview-mode.js');
  const terminalSearch = await import('../../public/js/terminal-search.js');
  const contextViews = await import('../../public/js/context-views.js');
  const cmdTabSwitch = await import('../../public/js/cmd-tab-switch.js');
  const shortcutsHelp = await import('../../public/js/shortcuts-help.js');
  await import('../../public/js/terminal.js');
  mods = { registry, commandPalette, overviewMode, terminalSearch, contextViews, cmdTabSwitch, shortcutsHelp };
  return mods;
}

const find = (all, id) => all.find(e => e.id === id);

// ----------------------------------------------------------------- the guard

test('every expected shortcut is registered, and nothing extra', async () => {
  // THE DRIFT GUARD. If you add, remove or rename a binding, update this list —
  // that is the point. A binding that isn't here is one the ⌘? overlay won't show.
  const { registry } = await loadAll();
  assert.deepStrictEqual(registry.getAll().map(e => e.id).sort(), [
    'cmd-hold-cycle',
    'cmd-hold-jump',
    'command-palette',
    'context-all',
    'context-cycle',
    'context-panel',
    'overview-mode',
    'shortcuts-help',
    'terminal-search',
    'terminal-shift-enter',
  ]);
});

test('every entry lands in a known group with keys and a description', async () => {
  const { registry } = await loadAll();
  for (const e of registry.getAll()) {
    assert.ok(registry.GROUPS.includes(e.group), `${e.id}: unknown group '${e.group}'`);
    assert.ok(e.description, `${e.id}: missing description`);
    assert.ok(e.keys.length > 0, `${e.id}: no keys to display`);
    assert.ok(e.keys.every(k => typeof k === 'string' && k), `${e.id}: bad key token`);
  }
});

test('the default shortcuts render as expected', async () => {
  const { registry } = await loadAll();
  const all = registry.getAll();
  assert.deepStrictEqual(find(all, 'command-palette').keys, ['⌘K']);
  assert.deepStrictEqual(find(all, 'overview-mode').keys, ['⌘O']);
  assert.deepStrictEqual(find(all, 'terminal-search').keys, ['⌘F']);
  assert.deepStrictEqual(find(all, 'context-panel').keys, ['⌘P']);
  assert.deepStrictEqual(find(all, 'terminal-shift-enter').keys, ['⇧↩']);
});

test('the help overlay binds both ⌘⇧? and ⌘/ by default', async () => {
  // Two combos because macOS gives ⌘⇧/ to the browser's Help menu, which would
  // otherwise leave the overlay unreachable with no way to discover the rebind.
  const { registry } = await loadAll();
  assert.deepStrictEqual(find(registry.getAll(), 'shortcuts-help').keys, ['⌘⇧?', '⌘/']);
});

// ------------------------------------------------------------- live values

test('rebinding the command palette updates what the overlay shows', async () => {
  const { registry, commandPalette } = await loadAll();
  try {
    commandPalette.setShortcut('Meta+Shift+k');
    assert.deepStrictEqual(find(registry.getAll(), 'command-palette').keys, ['⌘⇧K']);
  } finally {
    commandPalette.setShortcut('Meta+k');
  }
});

test('the help overlay accepts a single combo and drops the alternates', async () => {
  const { registry, shortcutsHelp } = await loadAll();
  try {
    shortcutsHelp.setShortcut(['Meta+/']); // what a Settings rebind posts
    assert.deepStrictEqual(find(registry.getAll(), 'shortcuts-help').keys, ['⌘/']);
    shortcutsHelp.setShortcut('Meta+h'); // a bare string works too
    assert.deepStrictEqual(find(registry.getAll(), 'shortcuts-help').keys, ['⌘H']);
  } finally {
    shortcutsHelp.setShortcut(['Meta+Shift+?', 'Meta+/']);
  }
});

// ------------------------------------------------------------ enabled flags

test('hold-⌘ tab rows stay hidden until the feature is enabled', async () => {
  const { registry, cmdTabSwitch } = await loadAll();
  assert.strictEqual(find(registry.getAll(), 'cmd-hold-jump').enabled, false,
    'cmdTabSwitch defaults off, so its rows must not be advertised');
  try {
    cmdTabSwitch.setEnabled(true);
    assert.strictEqual(find(registry.getAll(), 'cmd-hold-jump').enabled, true);
    assert.strictEqual(find(registry.getAll(), 'cmd-hold-cycle').enabled, true);
  } finally {
    cmdTabSwitch.setEnabled(false);
  }
});

test('disabling the command palette hides its row', async () => {
  const { registry, commandPalette } = await loadAll();
  try {
    commandPalette.setEnabled(false);
    assert.strictEqual(find(registry.getAll(), 'command-palette').enabled, false);
  } finally {
    commandPalette.setEnabled(true);
  }
});

// -------------------------------------------------- ⌘F vs Ctrl+F regression
//
// The highest-risk conversion in #549: terminal-search.js's hand-written
// `e.metaKey && e.key === 'f' && !e.ctrlKey && ...` became the registry matcher.
// Ctrl+F MUST still pass through to the PTY for vim's <C-f>. This pins that in a
// test rather than a comment.

test('⌘F opens terminal search but Ctrl+F is left alone for the PTY', async () => {
  const { terminalSearch } = await loadAll();
  let opened = 0;
  keydownHandlers.length = 0;
  terminalSearch.init({ getActiveSession: () => { opened++; return null; } });
  assert.ok(keydownHandlers.length > 0, 'init must install a keydown listener');
  const fire = (e) => keydownHandlers.forEach(h => h(e));

  fire(ev({ key: 'f', ctrlKey: true }));
  assert.strictEqual(opened, 0, 'Ctrl+F must NOT open search — vim needs <C-f>');

  fire(ev({ key: 'f', metaKey: true, ctrlKey: true }));
  assert.strictEqual(opened, 0, 'Ctrl+⌘F must not open search either');

  fire(ev({ key: 'f', metaKey: true }));
  assert.strictEqual(opened, 1, '⌘F must open search');
});
