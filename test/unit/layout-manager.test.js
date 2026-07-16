// Headless unit test for public/js/layout-manager.js — setIconRail()'s tooltip
// hint (#567). In the collapsed icon rail the ▾ caret is hidden, so long-press
// and right-click on the + button are the only path to the new-tab menu; the +
// button's title/aria-label advertises that, but ONLY in the rail (where it is
// true). setIconRail is the single owner of the icon-rail class and that hint,
// so this test pins that the two never drift apart across init and toggle.
//
// No browser, no Docker: stub the globals layout-manager touches (window /
// document / localStorage / getComputedStyle / Event) BEFORE importing it.
// window.parent = window keeps storage-namespace.js at depth 0 so keys get no
// ds1- prefix. Each test re-imports with a unique ?query so the module's
// currentLayout / sidebarWidth start fresh.
//
// Run: node --test test/unit/layout-manager.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const RAIL_HINT = 'New tab — long-press or right-click for options';
const PLAIN = 'New tab';

// ---------------------------------------------------------------- fake globals

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};

// railWidth() reads --ds-rail-width via getComputedStyle; 48 matches styles.css.
globalThis.getComputedStyle = () => ({
  getPropertyValue: (p) => (p === '--ds-rail-width' ? '48' : ''),
});

globalThis.Event = class { constructor(type) { this.type = type; } };

function fakeElement(id) {
  const classes = new Set();
  return {
    id,
    title: '',
    style: {},
    _attrs: {},
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
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener: () => {},
    blur: () => {},
  };
}

// getElementById reads whichever element set the current test installed.
let currentEls = {};
globalThis.document = {
  getElementById: (id) => currentEls[id] || null,
  addEventListener: () => {},
  activeElement: null,
};

globalThis.window = { innerWidth: 1200, dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.window.parent = globalThis.window; // depth 0 → unprefixed storage keys

// ---------------------------------------------------------------- helpers

let importSeq = 0;
async function loadFresh(saved) {
  currentEls = {
    'app-container': fakeElement('app-container'),
    'tabs': fakeElement('tabs'),
    'layout-toggle': fakeElement('layout-toggle'),
    'new-btn': fakeElement('new-btn'),
    'sidebar-resizer': fakeElement('sidebar-resizer'),
  };
  storeMap.clear();
  storeMap.set('deepsteve-layout', JSON.stringify(saved));
  const mod = await import(`../../public/js/layout-manager.js?v=${importSeq++}`);
  return { LayoutManager: mod.LayoutManager, els: currentEls };
}

// ---------------------------------------------------------------- tests

test('layout-manager icon-rail tooltip hint (#567)', async (t) => {
  await t.test('collapsed vertical → + advertises the long-press/right-click menu', async () => {
    const { LayoutManager, els } = await loadFresh({ layout: 'vertical', sidebarWidth: 48 });
    LayoutManager.init();
    assert.strictEqual(els['app-container'].classList.contains('icon-rail'), true, 'icon-rail on');
    assert.strictEqual(els['new-btn'].title, RAIL_HINT, 'title advertises the gesture');
    assert.strictEqual(els['new-btn'].getAttribute('aria-label'), RAIL_HINT, 'aria-label matches');
  });

  await t.test('horizontal → plain "New tab" (▾ is the affordance there)', async () => {
    const { LayoutManager, els } = await loadFresh({ layout: 'horizontal', sidebarWidth: 200 });
    LayoutManager.init();
    assert.strictEqual(els['app-container'].classList.contains('icon-rail'), false, 'no icon-rail');
    assert.strictEqual(els['new-btn'].title, PLAIN, 'plain title');
    assert.strictEqual(els['new-btn'].getAttribute('aria-label'), PLAIN, 'plain aria-label');
  });

  await t.test('expanded vertical (wider than the rail) → plain label, not the hint', async () => {
    // Gated on the RAIL, not merely on vertical: 200 > railWidth(48) → not collapsed.
    const { LayoutManager, els } = await loadFresh({ layout: 'vertical', sidebarWidth: 200 });
    LayoutManager.init();
    assert.strictEqual(els['app-container'].classList.contains('vertical-layout'), true, 'vertical');
    assert.strictEqual(els['app-container'].classList.contains('icon-rail'), false, 'not collapsed');
    assert.strictEqual(els['new-btn'].title, PLAIN, 'expanded vertical keeps plain title');
  });

  await t.test('class and hint stay in step across a toggle round-trip', async () => {
    // Collapsed width persisted, so toggling INTO vertical lands in the rail.
    const { LayoutManager, els } = await loadFresh({ layout: 'horizontal', sidebarWidth: 48 });
    LayoutManager.init();
    assert.strictEqual(els['new-btn'].title, PLAIN, 'starts horizontal/plain');

    LayoutManager.toggle(); // → collapsed vertical
    assert.strictEqual(els['app-container'].classList.contains('icon-rail'), true, 'rail after toggle');
    assert.strictEqual(els['new-btn'].title, RAIL_HINT, 'hint follows the class on');

    LayoutManager.toggle(); // → horizontal
    assert.strictEqual(els['app-container'].classList.contains('icon-rail'), false, 'rail off after toggle back');
    assert.strictEqual(els['new-btn'].title, PLAIN, 'hint follows the class off');
  });
});
