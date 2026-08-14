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

const modA = { id: 'ma', project: REPO_A, name: 'A Dash', icon: '📊', surfaces: ['rail', 'button', 'tab'], openMode: 'tab', enabled: true, updatedAt: 1 };
const modB = { id: 'mb', project: REPO_B, name: 'B Dash', icon: '', surfaces: ['rail'], openMode: 'tab', enabled: true, updatedAt: 1 };
// The #628 shape: launchers only, no tab. Same project as modA so one context shows both.
const viewA = { id: 'va', project: REPO_A, name: 'A Glance', icon: '🔭', surfaces: ['rail', 'button'], openMode: 'view', enabled: true, updatedAt: 1 };

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
    ensured: [],    // [{ modId, background, pinned }]
    reloaded: [],
    renamed: [],
    closed: [],
    closedPinned: [],  // the selective un-pin teardown (#645), kept apart from `closed`
    railRenders: 0,
    selected: [],   // selectProject(ctxId) — the always-show cross-project open (#647)
    fetches: [],
    // A simulated ModManager view slot (#628). Recorders alone are not enough: openMod()'s
    // toggle and syncModView()'s teardown both READ the slot back, so it has to hold state.
    // `slot` may also be set to a bare DeepSteve mod id, to assert we leave those alone.
    slot: null,
    front: false,
    shown: [],
    hidden: [],
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
    ensureModTab: (m, opts) => state.ensured.push({ modId: m.id, background: !!opts?.background, pinned: !!opts?.pinned }),
    reloadModTab: (m) => state.reloaded.push(m.id),
    renameModTab: (m) => state.renamed.push(m.id),
    closeModTabs: (id) => state.closed.push(id),
    // The hook lets a test stand in for killSession's real epilogue, which re-enters
    // render() through notifyTabsChanged → applyFilter → onContextViewApplied.
    closePinnedModTab: (id) => { state.closedPinned.push(id); state.onClosePinned?.(); },
    renderRail: () => { state.railRenders++; },
    selectProject: (id) => { state.selected.push(id); },
    showModView: (m) => {
      state.shown.push(m.id);
      state.slot = mod.viewIdFor(m.id);
      state.front = true;
    },
    hideModView: (id) => {
      state.hidden.push(id);
      if (state.slot === mod.viewIdFor(id)) { state.slot = null; state.front = false; }
    },
    getViewInfo: () => ({ id: state.slot, front: state.front }),
  });
  await flush();
  return { mod, state, tabs, anchor };
}

// init() → refresh() is async (fetch + two .then hops); drain the microtask queue.
const flush = () => new Promise(r => setImmediate(r));

const stripButtonIds = (tabs) => tabs.children.filter(c => c.className?.includes('project-mod-btn')).map(c => c.dataset.projectModId);

/** Right-click a launcher and hand back the menu items showModMenu() built. */
function openMenuOn(row) {
  row.listeners.contextmenu({ preventDefault: () => {}, clientX: 10, clientY: 10 });
  return bodyChildren.at(-1).children.filter(c => c.className === 'context-menu-item');
}

/** A fresh /api/project-mods answer, the way a 'project-mods' broadcast delivers one. */
const serveMods = (mods, enabled = true) => {
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ mods, enabled }) });
};

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

test('the view id is derived and namespaced, so it can never collide with a mod id', async () => {
  const { mod } = await setup();
  assert.strictEqual(mod.viewIdFor('ma'), 'project-mod:ma');
  assert.notStrictEqual(mod.viewIdFor('ma'), mod.viewIdFor('mb'));
  // It is also the id the bridge is injected under, which is what makes ModManager's
  // per-view callback sweeps cover a project mod without a branch in that file.
  assert.strictEqual(mod.viewIdFor('ma'), mod.VIEW_PREFIX + 'ma');
  assert.notStrictEqual(mod.viewIdFor('ma'), mod.tabIdFor('ma'));
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

test('modsForProject ignores surfaces — the project menu lists every mod (#647)', async () => {
  // The right-click menu on a project row is a FOURTH launcher, always present, so it
  // is not scoped by `surfaces` the way the rail/button/tab launchers are. A mod that
  // only asked for a background tab is still reachable from there.
  const tabOnly = { ...modA, id: 'mc', name: 'C', surfaces: ['tab'] };
  const { mod } = await setup({ mods: [modA, tabOnly, modB] });
  assert.deepStrictEqual(mod.modsForProject(CTX_A).map(m => m.id), ['ma', 'mc']);
  assert.deepStrictEqual(mod.railModsFor(CTX_A).map(m => m.id), ['ma'], 'the rail still filters on surfaces');
  assert.deepStrictEqual(mod.modsForProject(CTX_B).map(m => m.id), ['mb']);
  assert.deepStrictEqual(mod.modsForProject(null), []);
  assert.deepStrictEqual(mod.modsForProject({ id: 'x', name: 'x' }), [], 'a context with no dirs contains nothing');
});

test('modsForProject is empty for a disabled mod and when the feature is off (#647)', async () => {
  const off = await setup({ enabled: false, activeContext: CTX_A });
  assert.deepStrictEqual(off.mod.modsForProject(CTX_A), []);
  const disabled = await setup({ mods: [{ ...modA, enabled: false }] });
  assert.deepStrictEqual(disabled.mod.modsForProject(CTX_A), []);
});

test('modsForProject is not scoped to the ACTIVE project — that is the point (#647)', async () => {
  // visibleMods() answers "what am I looking at"; modsForProject answers "what does THIS
  // project own", which is what lets B's menu list B's mods while A is selected.
  const { mod } = await setup({ activeContext: CTX_A });
  assert.deepStrictEqual(mod.visibleMods().map(m => m.id), ['ma']);
  assert.deepStrictEqual(mod.modsForProject(CTX_B).map(m => m.id), ['mb']);
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
  assert.deepStrictEqual(state.ensured.at(-1), { modId: 'ma', background: false, pinned: false },
    'a click is a deliberate open — it takes focus, and it is never the pin\'s tab (#645)');
});

// An always-show project (#647) draws its rail rows while you are somewhere else, so a
// row now has to carry the project it was drawn under and select it before opening —
// a mod tab's cwd is its repo root, so it would otherwise open straight into the filter.

test('a rail row drawn under another project selects that project before opening (#647)', async () => {
  const { mod, state } = await setup({ activeContext: CTX_B });
  mod.makeRailRow(modA, 'ctxa').onclick();
  assert.deepStrictEqual(state.selected, ['ctxa'], 'the owner is selected');
  assert.deepStrictEqual(state.ensured.map(e => e.modId), ['ma'], 'and then the mod opens');
});

test('a rail row under the project already in view does not re-select it (#647)', async () => {
  const { mod, state } = await setup({ activeContext: CTX_A });
  mod.makeRailRow(modA, 'ctxa').onclick();
  assert.deepStrictEqual(state.selected, [], 'no pointless filter churn on the common path');
  assert.deepStrictEqual(state.ensured.at(-1).modId, 'ma');
});

test('a view-mode mod opened from another project is selected into view too (#647)', async () => {
  // The teardown rule is stricter for a view than for a tab: syncModView() drops any view
  // whose mod is not in visibleMods(), so without the select the view would open and be
  // reclaimed on the very next render pass.
  const { mod, state } = await setup({ mods: [viewA], activeContext: CTX_B });
  mod.makeRailRow(viewA, 'ctxa').onclick();
  assert.deepStrictEqual(state.selected, ['ctxa']);
  assert.deepStrictEqual(state.shown, ['va']);
});

test('appendRailRows hands its project id to every row it draws (#647)', async () => {
  const { mod, state } = await setup({ activeContext: CTX_B });
  const list = fakeElement();
  mod.appendRailRows(list, [modA, { ...modB, project: REPO_A }], 'ctxa');
  assert.strictEqual(list.children.length, 2);
  for (const row of list.children) row.onclick();
  assert.deepStrictEqual(state.selected, ['ctxa', 'ctxa']);
});

test('a rail row with no owner id never selects — the pre-#647 call still means "here"', async () => {
  const { mod, state } = await setup({ activeContext: CTX_B });
  mod.makeRailRow(modA).onclick();
  assert.deepStrictEqual(state.selected, []);
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
  assert.deepStrictEqual(state.ensured.at(-1), { modId: 'ma', background: false, pinned: false });
});

// ------------------------------------------------------------- surface 3: tab

test('a tab-surface mod auto-opens in the BACKGROUND when its project is in view', async () => {
  const { state } = await setup({ activeContext: CTX_A });
  assert.deepStrictEqual(state.ensured, [{ modId: 'ma', background: true, pinned: true }],
    'unattended opens must not steal focus (#600), and the tab is stamped as the pin\'s (#645)');
});

test('a tab-surface mod does not open while a different project is in view', async () => {
  const { mod, state } = await setup({ activeContext: CTX_B });
  assert.deepStrictEqual(state.ensured, []);
  state.view.activeContext = CTX_A;
  mod.render();
  assert.deepStrictEqual(state.ensured, [{ modId: 'ma', background: true, pinned: true }]);
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

// ------------------------------------------------------- un-pinning (#645)
// Ticking a placement toggle has to be undoable by un-ticking it. The pin auto-opens a
// background tab on every render, so the tab it opened must go when the pin does — while a
// tab the USER opened by clicking a tab-mode mod stays, which is why the teardown is a
// separate, weaker callback.

test('un-pinning closes the tab the pin opened, and does not use the delete/disable close', async () => {
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });
  assert.deepStrictEqual(state.ensured, [{ modId: 'ma', background: true, pinned: true }]);

  serveMods([{ ...modA, surfaces: ['rail', 'button'] }]);
  await mod.refresh();
  assert.deepStrictEqual(state.closedPinned, ['ma'], 'the pin went, so its tab goes');
  assert.deepStrictEqual(state.closed, [], 'the mod is still registered and enabled — nothing may close it outright');
});

test('a still-pinned mod is never torn down, however often we re-render', async () => {
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });
  mod.render();
  mod.render();
  assert.deepStrictEqual(state.closedPinned, [], 'the branch keys on the surface, not on the render');
});

test('a mod that never had the pin is left alone — a click-opened tab is the user\'s', async () => {
  // modB is surfaces:['rail'], openMode:'tab': clicking it opens a real tab that no pin is
  // responsible for. Every render sees "no tab surface", and every render must do nothing.
  const { mod, state } = await setup({ mods: [modB], activeContext: CTX_B });
  mod.makeRailRow(modB).onclick();
  mod.render();
  assert.deepStrictEqual(state.ensured.at(-1), { modId: 'mb', background: false, pinned: false },
    'a click never claims pin origin — which is what spares this tab');
  // The selective callback still fires (the surface IS absent); app.js is where the tab's
  // own `pinned` flag decides, and this one has none. It is never the outright close.
  assert.ok(state.closedPinned.every(id => id === 'mb'));
  assert.deepStrictEqual(state.closed, []);
});

test('un-pinning tears the tab down even while another project is in view', async () => {
  // syncOpenTabs() walks the whole registry, not visibleMods(): a pinned tab legitimately
  // outlives a project switch, so its teardown has to reach it there too.
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_B });
  assert.deepStrictEqual(state.ensured, [], 'nothing auto-opened while looking elsewhere');

  serveMods([{ ...modA, surfaces: ['rail'] }]);
  await mod.refresh();
  assert.deepStrictEqual(state.closedPinned, ['ma']);
});

test('flipping to view uses the outright close, not the un-pin one', async () => {
  // Both conditions hold at once for a view-mode mod that lost the pin; the `else if` is
  // what keeps the stronger branch from being shadowed by the weaker.
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });

  serveMods([{ ...modA, surfaces: ['rail', 'button'], openMode: 'view' }]);
  await mod.refresh();
  assert.ok(state.closed.includes('ma'), 'a view never owns a tab at all');
  assert.deepStrictEqual(state.closedPinned, [], 'so the selective close never runs');
});

test('the un-pin teardown settles when closing re-enters render()', async () => {
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });
  // killSession → notifyTabsChanged → applyFilter → onContextViewApplied → render().
  state.onClosePinned = () => mod.render();

  serveMods([{ ...modA, surfaces: ['rail'] }]);
  await mod.refresh();   // returning at all is the assertion: the guard must absorb the loop
  assert.ok(state.closedPinned.length >= 1);
  assert.ok(state.closedPinned.every(id => id === 'ma'));
});

// ------------------------------------------------------------ openMode: view (#628)

test('a view-mode mod opens as a view from every launcher, and never as a tab', async () => {
  const { mod, state, tabs } = await setup({ mods: [viewA], activeContext: CTX_A });

  const [btn] = tabs.children.filter(c => c.className?.includes('project-mod-btn'));
  btn.listeners.click();
  assert.deepStrictEqual(state.shown, ['va']);
  assert.deepStrictEqual(state.ensured, [], 'a view consumes no tab — that is the whole point');

  // The rail row and the menu's Open item route through the same openMod() choke point.
  state.slot = null; state.front = false;
  mod.makeRailRow(viewA).onclick();
  assert.deepStrictEqual(state.shown, ['va', 'va']);
  assert.deepStrictEqual(state.ensured, []);
});

test('an absent openMode still means "tab" on the client, matching the server default', async () => {
  const legacy = { ...modA, surfaces: ['rail', 'button'] };
  delete legacy.openMode;
  const { state, tabs } = await setup({ mods: [legacy], activeContext: CTX_A });
  const [btn] = tabs.children.filter(c => c.className?.includes('project-mod-btn'));
  btn.listeners.click();
  assert.deepStrictEqual(state.ensured.at(-1), { modId: 'ma', background: false, pinned: false });
  assert.deepStrictEqual(state.shown, [], 'no openMode is not "view"');
});

test('a view-mode mod is never auto-opened as a pinned tab, even if the list says so', async () => {
  // The server never sends this — it ships the EFFECTIVE mode, and a pin makes that 'tab'
  // (#645) — but a client can hold a stale list mid-flight, and auto-taking over the screen
  // would be the worst possible way to find out.
  const contradictory = { ...viewA, surfaces: ['rail', 'button', 'tab'] };
  const { state } = await setup({ mods: [contradictory], activeContext: CTX_A });
  assert.deepStrictEqual(state.ensured, []);
  assert.deepStrictEqual(state.shown, [], 'and it is not auto-SHOWN either — opening is a user act');
});

test('clicking the launcher again dismisses the view; clicking it while backgrounded re-shows it', async () => {
  const { mod, state } = await setup({ mods: [viewA], activeContext: CTX_A });

  mod.openMod('va');
  assert.deepStrictEqual(state.shown, ['va']);

  mod.openMod('va');
  assert.deepStrictEqual(state.hidden, ['va'], 'a second click on the launcher is the dismiss');
  assert.strictEqual(state.slot, null);

  // Backgrounded (someone clicked a tab, but the slot still holds it): a click must bring
  // it back rather than dismiss, or the launcher would look like it did nothing.
  state.slot = mod.viewIdFor('va');
  state.front = false;
  mod.openMod('va');
  assert.deepStrictEqual(state.hidden, ['va'], 'no second dismiss');
  assert.deepStrictEqual(state.shown, ['va', 'va']);
});

test('the launcher that owns the view slot is marked .active, and no other is', async () => {
  const { mod, state, tabs } = await setup({ mods: [modA, viewA], activeContext: CTX_A });
  const rowA = mod.makeRailRow(modA);
  const rowView = mod.makeRailRow(viewA);

  const buttonFor = (id) => tabs.children.find(c => c.dataset?.projectModId === id);
  assert.strictEqual(buttonFor('va').classList.contains('active'), false);

  mod.openMod('va');
  mod.render();
  assert.strictEqual(buttonFor('va').classList.contains('active'), true);
  assert.strictEqual(buttonFor('ma').classList.contains('active'), false, 'a tab-mode mod is never active');
  assert.strictEqual(rowView.classList.contains('active'), true, 'the rail row too, via .context-row.active');
  assert.strictEqual(rowA.classList.contains('active'), false);

  mod.openMod('va');
  mod.render();
  assert.strictEqual(buttonFor('va').classList.contains('active'), false, 'cleared on dismiss');
  assert.strictEqual(rowView.classList.contains('active'), false);
});

test('syncModView drops a view whose mod is gone, disabled, flipped to tab, or out of project', async () => {
  const cases = [
    ['deleted from the registry', (s) => { s.mods = []; }],
    ['disabled', (s) => { s.mods = [{ ...viewA, enabled: false }]; }],
    ['flipped back to openMode:tab', (s) => { s.mods = [{ ...viewA, openMode: 'tab' }]; }],
    ['the feature turned off', (s) => { s.enabled = false; }],
  ];
  for (const [why, mutate] of cases) {
    const box = { mods: [viewA], enabled: true };
    const { mod, state } = await setup({ mods: box.mods, enabled: box.enabled, activeContext: CTX_A });
    mod.openMod('va');
    assert.strictEqual(state.slot, mod.viewIdFor('va'), why);

    mutate(box);
    // A fresh /api/project-mods answer, the way a 'project-mods' broadcast delivers one.
    globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ mods: box.mods, enabled: box.enabled }) });
    await mod.refresh();
    assert.deepStrictEqual(state.hidden, ['va'], `dismissed when ${why}`);
    assert.strictEqual(state.slot, null);
  }
});

test('switching project dismisses the view — a view must not outlive the chrome that opens it', async () => {
  const { mod, state } = await setup({ mods: [viewA], activeContext: CTX_A });
  mod.openMod('va');
  assert.strictEqual(state.slot, mod.viewIdFor('va'));

  state.view.activeContext = CTX_B;
  mod.render();
  assert.deepStrictEqual(state.hidden, ['va']);
  assert.strictEqual(state.slot, null);
});

test('a DeepSteve Mod occupying the slot is never touched', async () => {
  const { mod, state } = await setup({ mods: [viewA], activeContext: CTX_A });
  state.slot = 'tower';   // a bare mod id — not our namespace
  state.front = true;

  mod.render();
  state.view.activeContext = CTX_B;
  mod.render();
  // Even our own mod vanishing entirely must not reach into someone else's view.
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ mods: [], enabled: true }) });
  await mod.refresh();

  assert.deepStrictEqual(state.hidden, [], 'we only reconcile ids under our own prefix');
  assert.strictEqual(state.slot, 'tower');
});

test('flipping a mod to view mode closes the tab it used to own', async () => {
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });
  assert.deepStrictEqual(state.closed, []);

  globalThis.fetch = () => Promise.resolve({
    json: () => Promise.resolve({ mods: [{ ...modA, surfaces: ['rail', 'button'], openMode: 'view', updatedAt: 2 }], enabled: true }),
  });
  await mod.refresh();
  assert.ok(state.closed.includes('ma'), 'a view never owns a tab, including a stale restored one');
});

// ------------------------------------------------------------------ re-entrancy

test('render() with a view open is idempotent — the onViewChanged loop must settle', async () => {
  // hideModView fires onViewChanged → render(), which the re-entrancy guard absorbs only
  // because syncModView() is idempotent: after a hide the slot is empty and it returns at
  // the first check.
  const { mod, state } = await setup({ mods: [viewA], activeContext: CTX_A });
  mod.openMod('va');

  mod.render();
  mod.render();
  assert.deepStrictEqual(state.shown, ['va'], 'render() never re-opens');
  assert.deepStrictEqual(state.hidden, [], 'and never dismisses a view that is still valid');
  assert.strictEqual(state.slot, mod.viewIdFor('va'));
});

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

// -------------------------------------------------------------- compact view (#646)
// The layout branch and the per-browser preference behind it. `storeMap` is shared
// across imports (it IS the fake localStorage), so each test seeds the key explicitly
// and clears it afterwards rather than relying on setup() — which never wipes it.

const COMPACT_KEY = 'deepsteve-project-mods-compact';   // depth 0, so nsKey adds no prefix
const seedCompact = (on) => { storeMap.set(COMPACT_KEY, on ? '1' : '0'); };
const clearCompact = () => { storeMap.delete(COMPACT_KEY); };
const flowChildren = (list) => list.children.filter(c => c.className === 'project-mod-flow');
const menuLabels = () => bodyChildren.at(-1).children.map(c => c.textContent);
const findMenuItem = (needle) => bodyChildren.at(-1).children.find(c => c.textContent?.includes(needle));

test('compact is off by default, and off means the rows go straight into the list', async () => {
  clearCompact();
  const { mod } = await setup({ mods: [modA, viewA], activeContext: CTX_A });
  assert.strictEqual(mod.isCompactRail(), false);

  const list = fakeElement();
  mod.appendRailRows(list, mod.railModsFor(CTX_A));
  assert.strictEqual(flowChildren(list).length, 0, 'no wrapper — the DOM is what it was pre-#646');
  assert.deepStrictEqual(list.children.map(c => c.dataset.projectModId), ['ma', 'va']);
});

test('compact on wraps every row in exactly one .project-mod-flow', async () => {
  seedCompact(true);
  const { mod } = await setup({ mods: [modA, viewA], activeContext: CTX_A });
  assert.strictEqual(mod.isCompactRail(), true, 'the stored preference is read at import');

  const list = fakeElement();
  mod.appendRailRows(list, mod.railModsFor(CTX_A));
  const flows = flowChildren(list);
  assert.strictEqual(flows.length, 1, 'one wrapper for the whole group, not one per row');
  assert.strictEqual(list.children.length, 1, 'and no loose rows beside it');
  assert.deepStrictEqual(flows[0].children.map(c => c.dataset.projectModId), ['ma', 'va']);
  clearCompact();
});

test('a project with no rail mods never grows an empty wrapper', async () => {
  seedCompact(true);
  const { mod } = await setup({ mods: [modA], activeContext: CTX_A });
  const list = fakeElement();
  mod.appendRailRows(list, mod.railModsFor(CTX_B));   // modA belongs to project A
  assert.strictEqual(list.children.length, 0);
  clearCompact();
});

test('setCompactRail persists the preference and redraws the rail', async () => {
  clearCompact();
  const { mod, state } = await setup({ activeContext: CTX_A });
  const before = state.railRenders;

  mod.setCompactRail(true);
  assert.strictEqual(mod.isCompactRail(), true);
  assert.strictEqual(storeMap.get(COMPACT_KEY), '1');
  assert.strictEqual(state.railRenders, before + 1, "the rail is context-views' pass — ask it to redraw");

  mod.setCompactRail(false);
  assert.strictEqual(storeMap.get(COMPACT_KEY), '0');
  assert.strictEqual(state.railRenders, before + 2);
  clearCompact();
});

test('the preference survives a reload — a fresh import reads it back', async () => {
  clearCompact();
  const first = await setup({ activeContext: CTX_A });
  first.mod.setCompactRail(true);

  const second = await setup({ activeContext: CTX_A });   // a new module instance = a reload
  assert.strictEqual(second.mod.isCompactRail(), true);
  clearCompact();
});

test('the mod menu carries the toggle, ticked to match, and flipping it redraws', async () => {
  clearCompact();
  const { mod, state } = await setup({ mods: [modA], activeContext: CTX_A });
  const row = mod.makeRailRow(modA);

  row.listeners.contextmenu({ preventDefault: () => {}, clientX: 10, clientY: 10 });
  const off = findMenuItem('Compact view');
  assert.ok(off, `the menu offers it: ${JSON.stringify(menuLabels())}`);
  assert.ok(!off.textContent.startsWith('✓'), 'unticked while off');
  assert.ok(off.textContent.includes('(all project mods)'), 'says it is not about this one mod');

  const before = state.railRenders;
  off.onclick();
  assert.strictEqual(mod.isCompactRail(), true);
  assert.strictEqual(state.railRenders, before + 1);

  row.listeners.contextmenu({ preventDefault: () => {}, clientX: 10, clientY: 10 });
  assert.ok(findMenuItem('Compact view').textContent.startsWith('✓ '), 'ticked while on');
  clearCompact();
});

// ------------------------------------------------- the right-click menu (#645)

test('the view toggle stays ticked while a pin overrides it, and one click brings it back', async () => {
  // What the server ships for a view-mode mod that has just been pinned: openMode is the
  // EFFECTIVE one, storedOpenMode the standing choice the pin is overriding.
  const pinnedView = { ...viewA, surfaces: ['rail', 'button', 'tab'], openMode: 'tab', storedOpenMode: 'view' };
  const { mod, state } = await setup({ mods: [pinnedView], activeContext: CTX_A });

  const items = openMenuOn(mod.makeRailRow(pinnedView));
  const viewItem = items.find(i => i.textContent.includes('Open as a full view'));
  assert.ok(viewItem.textContent.startsWith('✓ '), 'the standing choice is still ticked');
  assert.ok(viewItem.textContent.endsWith('— paused while pinned'), 'and says why it is not in force');

  state.fetches.length = 0;
  viewItem.onclick();
  const put = state.fetches.at(-1);
  assert.strictEqual(put.opts.method, 'PUT');
  assert.deepStrictEqual(JSON.parse(put.opts.body), { openMode: 'view' },
    'picking it while paused means "the view, now" — the explicit write that also drops the pin');
});

test('an un-pinned view toggles the other way, and a tab-mode mod is simply unticked', async () => {
  const { mod, state } = await setup({ mods: [viewA, modA], activeContext: CTX_A });

  const viewItem = openMenuOn(mod.makeRailRow(viewA)).find(i => i.textContent.includes('Open as a full view'));
  assert.strictEqual(viewItem.textContent, '✓ Open as a full view (no tab)', 'no pin, no suffix');
  state.fetches.length = 0;
  viewItem.onclick();
  assert.deepStrictEqual(JSON.parse(state.fetches.at(-1).opts.body), { openMode: 'tab' });

  const tabItem = openMenuOn(mod.makeRailRow(modA)).find(i => i.textContent.includes('Open as a full view'));
  assert.ok(!tabItem.textContent.startsWith('✓'));
  state.fetches.length = 0;
  tabItem.onclick();
  assert.deepStrictEqual(JSON.parse(state.fetches.at(-1).opts.body), { openMode: 'view' });
});

test('a surface toggle sends surfaces alone — that is what preserves the stored open mode', async () => {
  // If un-ticking the pin also wrote openMode, there would be nothing left to restore.
  const pinnedView = { ...viewA, surfaces: ['rail', 'button', 'tab'], openMode: 'tab', storedOpenMode: 'view' };
  const { mod, state } = await setup({ mods: [pinnedView], activeContext: CTX_A });

  const pin = openMenuOn(mod.makeRailRow(pinnedView)).find(i => i.textContent.includes('Pin as a background tab'));
  assert.ok(pin.textContent.startsWith('✓ '));
  state.fetches.length = 0;
  pin.onclick();
  assert.deepStrictEqual(JSON.parse(state.fetches.at(-1).opts.body), { surfaces: ['rail', 'button'] });
});
