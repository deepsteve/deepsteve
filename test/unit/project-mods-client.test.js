// Headless unit test for public/js/project-mods.js — the client half of Project Mods
// (#618): which mods are visible from where, and the three registration surfaces.
//
// No browser, no Docker: stub the handful of globals the module touches
// (window/document/sessionStorage/fetch) BEFORE importing it, then drive the exported
// API the way app.js and context-views.js do. window.parent = window keeps
// storage-namespace.js at depth 0 (tab-manager.js pulls it in). Each test re-imports
// the module with a unique ?query so its module-level state starts fresh.
//
// Run: node --test test/unit/project-mods-client.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};
globalThis.localStorage = globalThis.sessionStorage;

function fakeElement(tag = 'div') {
  const classes = new Set();
  const children = [];
  let text = '';
  const el = {
    tag, id: '', className: '', title: '',
    style: {}, dataset: {}, children,
    listeners: {},
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
    append: (...kids) => children.push(...kids),
    appendChild: (child) => { children.push(child); return child; },
    insertBefore: (child, ref) => {
      const i = children.indexOf(ref);
      children.splice(i === -1 ? children.length : i, 0, child);
      child.parent = el;
      return child;
    },
    setAttribute: (k, v) => { el[k] = v; },
    getBoundingClientRect: () => ({ width: 100, height: 60, right: 100, bottom: 60, left: 0, top: 0 }),
    remove: () => {
      const p = el.parent;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
    },
    contains: () => false,
  };
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); children.length = 0; },
  });
  return el;
}

const byId = new Map();
const bodyChildren = [];

globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => fakeElement(tag),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild: (el) => { bodyChildren.push(el); el.parent = { children: bodyChildren }; } },
  activeElement: null,
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, dispatchEvent: () => {} };
globalThis.window.parent = globalThis.window;

// --------------------------------------------------------------------- harness

const REPO_A = '/repo/alpha';
const REPO_B = '/repo/beta';

const CTX_A = { id: 'ctxa', name: 'Alpha', dirs: [REPO_A] };
const CTX_B = { id: 'ctxb', name: 'Beta', dirs: [REPO_B] };
// A project whose dirs is a PARENT of several repos — the folder-prefix rule has to
// pull a mod registered to a nested repo root into it.
const CTX_PARENT = { id: 'ctxp', name: 'All repos', dirs: ['/repo'] };

const modA = { id: 'ma', project: REPO_A, name: 'A Dash', icon: '📊', surfaces: ['rail', 'button', 'tab'], enabled: true, updatedAt: 1 };
const modB = { id: 'mb', project: REPO_B, name: 'B Dash', icon: '', surfaces: ['rail'], enabled: true, updatedAt: 1 };

let importCount = 0;

/**
 * Fresh module + the app.js-side wiring, with a controllable /api/project-mods response.
 * Returns the module plus a `state` object recording every callback the module made.
 */
async function setup({ mods = [modA, modB], enabled = true, activeContext = null, activeTabCwd = null } = {}) {
  byId.clear();
  bodyChildren.length = 0;

  const tabs = fakeElement();
  const anchor = fakeElement();
  tabs.appendChild(anchor);
  anchor.parent = tabs;
  byId.set('tabs', tabs);
  byId.set('tabs-list-wrapper', anchor);

  const state = {
    view: { activeContext, activeTabCwd },
    ensured: [],    // [{ modId, background }]
    reloaded: [],
    renamed: [],
    closed: [],
    railRenders: 0,
    fetches: [],
  };

  globalThis.fetch = (url, opts) => {
    state.fetches.push({ url, opts });
    if (url === '/api/project-mods') return Promise.resolve({ json: () => Promise.resolve({ mods, enabled }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };

  const url = new URL('../../public/js/project-mods.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);

  mod.init({
    getActiveContext: () => state.view.activeContext,
    getActiveTabCwd: () => state.view.activeTabCwd,
    ensureModTab: (m, opts) => state.ensured.push({ modId: m.id, background: !!opts?.background }),
    reloadModTab: (m) => state.reloaded.push(m.id),
    renameModTab: (m) => state.renamed.push(m.id),
    closeModTabs: (id) => state.closed.push(id),
    renderRail: () => { state.railRenders++; },
  });
  await flush();
  return { mod, state, tabs, anchor };
}

// init() → refresh() is async (fetch + two .then hops); drain the microtask queue.
const flush = () => new Promise(r => setImmediate(r));

const stripButtonIds = (tabs) => tabs.children.filter(c => c.className?.includes('project-mod-btn')).map(c => c.dataset.projectModId);

// -------------------------------------------------------------------- pathInside

test('pathInside matches a dir itself and anything nested, ignoring trailing slashes', async () => {
  const { mod } = await setup();
  assert.strictEqual(mod.pathInside('/repo/a', '/repo/a'), true);
  assert.strictEqual(mod.pathInside('/repo/a/src', '/repo/a'), true);
  assert.strictEqual(mod.pathInside('/repo/a/src', '/repo/a/'), true);
  assert.strictEqual(mod.pathInside('/repo/a/.claude/worktrees/x', '/repo/a'), true, 'worktree sessions belong to their repo');
  assert.strictEqual(mod.pathInside('/repo/ab', '/repo/a'), false, 'a sibling with a shared prefix is NOT inside');
  assert.strictEqual(mod.pathInside('/repo/a', '/repo/a/src'), false, 'the relation is one-way');
  assert.strictEqual(mod.pathInside('', '/repo/a'), false);
  assert.strictEqual(mod.pathInside('/repo/a', ''), false);
});

// -------------------------------------------------------- derived tab identity

test('the tab id is derived from the mod id, so a mod can only ever have one tab', async () => {
  const { mod } = await setup();
  assert.strictEqual(mod.tabIdFor('ma'), 'pm-ma');
  // The prefix is what keeps it out of the shell-id namespace: both a shell id and a
  // mod id are 8-char randomUUID slices, so a bare mod id could collide with a session.
  assert.ok(mod.tabIdFor('ma').startsWith('pm-'));
  assert.notStrictEqual(mod.tabIdFor('ma'), mod.tabIdFor('mb'));
});

test('the tab label carries the mod icon, and is idempotent for the restore stub', async () => {
  const { mod } = await setup();
  // tabIcon() reads the chip off the LABEL, so the emoji has to live in the name or the
  // vertical rail — where the chip is the whole tab — falls back to a monogram.
  assert.strictEqual(mod.tabNameFor(modA), '📊 A Dash');
  assert.strictEqual(mod.tabNameFor(modB), 'B Dash', 'no icon, no prefix');
  // restoreSessions passes a stub with the persisted (already-prefixed) name and no
  // icon; re-deriving must not produce "📊 📊 A Dash".
  assert.strictEqual(mod.tabNameFor({ name: '📊 A Dash' }), '📊 A Dash');
});

// ---------------------------------------------------------------- scoping rules

test('with a project selected, only that project\'s mods are visible', async () => {
  const { mod, state } = await setup({ activeContext: CTX_A });
  assert.deepStrictEqual(mod.visibleMods().map(m => m.id), ['ma']);

  state.view.activeContext = CTX_B;
  assert.deepStrictEqual(mod.visibleMods().map(m => m.id), ['mb']);
});

test('a project whose folder is a PARENT of the mod\'s repo still contains it', async () => {
  const { mod } = await setup({ activeContext: CTX_PARENT });
  assert.deepStrictEqual(mod.visibleMods().map(m => m.id).sort(), ['ma', 'mb']);
});

test('in the All view the ACTIVE TAB\'s cwd decides, not the project list', async () => {
  // The relation inverts here: with no project selected there is no container, so the
  // mod's own repo root is the container and the tab's cwd is the thing inside it.
  const { mod, state } = await setup({ activeContext: null, activeTabCwd: `${REPO_A}/src/deep` });
  assert.deepStrictEqual(mod.visibleMods().map(m => m.id), ['ma']);

  state.view.activeTabCwd = REPO_B;
  assert.deepStrictEqual(mod.visibleMods().map(m => m.id), ['mb']);

  // A tab with no cwd (a mod tab, a saved-layout tab) selects nothing rather than
  // everything — the chrome would otherwise fill with another project's tooling.
  state.view.activeTabCwd = null;
  assert.deepStrictEqual(mod.visibleMods(), []);
});

test('a disabled mod is visible from nowhere', async () => {
  const { mod } = await setup({ mods: [{ ...modA, enabled: false }], activeContext: CTX_A });
  assert.deepStrictEqual(mod.visibleMods(), []);
  assert.deepStrictEqual(mod.railModsFor(CTX_A), []);
});

test('projectModsEnabled:false empties every surface', async () => {
  const { mod, tabs } = await setup({ enabled: false, activeContext: CTX_A });
  assert.deepStrictEqual(mod.visibleMods(), []);
  assert.deepStrictEqual(mod.railModsFor(CTX_A), []);
  assert.deepStrictEqual(stripButtonIds(tabs), []);
});

// ------------------------------------------------------------ surface 1: rail

test('railModsFor returns a project\'s rail-surface mods, and skips the others', async () => {
  const buttonOnly = { ...modA, id: 'mc', name: 'C', surfaces: ['button'] };
  const { mod } = await setup({ mods: [modA, buttonOnly, modB] });
  assert.deepStrictEqual(mod.railModsFor(CTX_A).map(m => m.id), ['ma'], 'a button-only mod has no rail row');
  assert.deepStrictEqual(mod.railModsFor(CTX_B).map(m => m.id), ['mb']);
  assert.deepStrictEqual(mod.railModsFor(null), []);
  assert.deepStrictEqual(mod.railModsFor({ id: 'x', name: 'x' }), [], 'a context with no dirs contains nothing');
});

test('a rail row is shaped like a context row, so the collapsed icon rail styles it for free', async () => {
  const { mod } = await setup();
  const row = mod.makeRailRow(modA);
  assert.ok(row.className.includes('context-row'), 'reuses .context-row rather than a parallel shape');
  assert.ok(row.className.includes('project-mod-row'));
  assert.strictEqual(row.dataset.projectModId, 'ma');
  const [icon, label] = row.children;
  assert.strictEqual(icon.className, 'context-row-icon is-emoji');
  assert.strictEqual(icon.textContent, '📊');
  assert.strictEqual(label.className, 'context-row-label');
  assert.strictEqual(label.textContent, 'A Dash');
});

test('has-icon follows the project-row rule: chosen icons show in the expanded rail, monograms do not', async () => {
  const { mod } = await setup();
  // .context-row.has-icon .context-row-icon is the CSS gate (#569). Without the class
  // the chip is display:none in the expanded rail — the mod's emoji simply vanished.
  assert.ok(mod.makeRailRow(modA).className.includes('has-icon'), 'a chosen icon shows');
  assert.ok(!mod.makeRailRow(modB).className.includes('has-icon'), 'a derived monogram does not');
});

test('a mod with no icon falls back to the same derivation tabs use', async () => {
  const { mod } = await setup();
  const { glyph, isEmoji } = mod.modIcon(modB);   // name 'B Dash', no icon
  assert.strictEqual(isEmoji, false);
  assert.ok(glyph && glyph.length <= 2, `expected a monogram, got ${JSON.stringify(glyph)}`);
});

test('clicking a rail row opens the mod', async () => {
  const { mod, state } = await setup({ activeContext: CTX_A });
  mod.makeRailRow(modA).onclick();
  assert.deepStrictEqual(state.ensured.at(-1), { modId: 'ma', background: false },
    'a click is a deliberate open — it takes focus');
});

// ---------------------------------------------------------- surface 2: button

test('button-surface mods get a square nav-btn in #tabs, before the tab list', async () => {
  const { tabs, anchor } = await setup({ activeContext: CTX_A });
  const btns = tabs.children.filter(c => c.className?.includes('project-mod-btn'));
  assert.strictEqual(btns.length, 1);
  const [btn] = btns;
  // .nav-btn is what supplies the chrome shape and the collapsed-rail treatment;
  // .is-glyph is what drops the label in the horizontal strip, making it square.
  assert.strictEqual(btn.className, 'project-mod-btn nav-btn is-glyph');
  assert.strictEqual(btn.dataset.projectModId, 'ma');
  assert.strictEqual(tabs.children.indexOf(btn) < tabs.children.indexOf(anchor), true,
    'sits before #tabs-list-wrapper — the top of the vertical strip / the left of the horizontal one');
  const [icon, label] = btn.children;
  assert.strictEqual(icon.textContent, '📊');
  assert.strictEqual(label.textContent, 'A Dash');
});

test('buttons are rebuilt on every render, so switching project swaps them', async () => {
  const buttonB = { ...modB, surfaces: ['rail', 'button'] };
  const { mod, state, tabs } = await setup({ mods: [modA, buttonB], activeContext: CTX_A });
  assert.deepStrictEqual(stripButtonIds(tabs), ['ma']);

  state.view.activeContext = CTX_B;
  mod.render();
  assert.deepStrictEqual(stripButtonIds(tabs), ['mb'], 'the old project\'s button is gone, not stacked');

  state.view.activeContext = CTX_PARENT;
  mod.render();
  assert.deepStrictEqual(stripButtonIds(tabs), ['ma', 'mb'], 'registry order, not insertion order');
});

test('clicking a strip button opens the mod focused', async () => {
  const { state, tabs } = await setup({ activeContext: CTX_A });
  const [btn] = tabs.children.filter(c => c.className?.includes('project-mod-btn'));
  btn.listeners.click();
  assert.deepStrictEqual(state.ensured.at(-1), { modId: 'ma', background: false });
});

// ------------------------------------------------------------- surface 3: tab

test('a tab-surface mod auto-opens in the BACKGROUND when its project is in view', async () => {
  const { state } = await setup({ activeContext: CTX_A });
  assert.deepStrictEqual(state.ensured, [{ modId: 'ma', background: true }],
    'unattended opens must not steal focus (#600)');
});

test('a tab-surface mod does not open while a different project is in view', async () => {
  const { mod, state } = await setup({ activeContext: CTX_B });
  assert.deepStrictEqual(state.ensured, []);
  state.view.activeContext = CTX_A;
  mod.render();
  assert.deepStrictEqual(state.ensured, [{ modId: 'ma', background: true }]);
});

// ------------------------------------------------------------- tab reconciliation

test('a page rewrite reloads open tabs; an unchanged updatedAt does not', async () => {
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });
  assert.deepStrictEqual(state.reloaded, [], 'the first sight of a mod is not a change');

  mod.render();
  assert.deepStrictEqual(state.reloaded, [], 'a re-render with the same updatedAt is not a change');

  // Simulate the next broadcast carrying a bumped updatedAt.
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ mods: [{ ...modA, updatedAt: 2 }], enabled: true }) });
  await mod.refresh();
  assert.deepStrictEqual(state.reloaded, ['ma']);
});

test('a deleted or disabled mod closes its open tabs', async () => {
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });

  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ mods: [{ ...modA, enabled: false }], enabled: true }) });
  await mod.refresh();
  assert.deepStrictEqual(state.closed, ['ma'], 'disabled closes the tab');

  state.closed.length = 0;
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ mods: [], enabled: true }) });
  await mod.refresh();
  assert.deepStrictEqual(state.closed, ['ma'], 'deleted closes it too');
});

// ------------------------------------------------------------------ re-entrancy

test('render() never calls back into the rail — only refresh() does', async () => {
  // renderRail runs applyFilter, whose onContextViewApplied hook calls render(). If
  // render() also called renderRail, that loop would not terminate.
  const { mod, state } = await setup({ activeContext: CTX_A });
  const afterInit = state.railRenders;
  assert.strictEqual(afterInit, 1, 'init → refresh → one rail render');

  mod.render();
  mod.render();
  assert.strictEqual(state.railRenders, afterInit, 'render() is surfaces-only');

  await mod.refresh();
  assert.strictEqual(state.railRenders, afterInit + 1);
});
