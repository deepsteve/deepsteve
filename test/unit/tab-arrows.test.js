// Headless unit test for the prev/next tab arrows in public/js/tab-manager.js (#610).
//
// The regression: the arrows used to derive their disabled state from the tab list's SCROLL
// geometry, so in the vertical sidebar (~33px tabs, total overflow often under the flat 150px
// scroll step) one press of ▼ hit the true scroll bottom and disabled the button while tabs
// below the active one were plainly on screen. They are now an index into the ordered tab list,
// so "is there a tab after the active one" is the only question asked.
//
// No browser, no jsdom: stub the handful of globals tab-manager.js touches (it registers two
// document listeners at module scope) BEFORE importing it, then drive the exported API the way
// app.js does. Each test re-imports with a unique ?query so module-level state (arrowStart,
// the three callbacks) starts fresh.
//
// Run: node --test test/unit/tab-arrows.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake DOM

function fakeElement(id = '') {
  const classes = new Set();
  const el = {
    id,
    disabled: false,
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
    scrollIntoView: () => {},
  };
  return el;
}

const byId = new Map();   // element id → fake element
const tabEls = [];        // everything matching '.tab', in strip order

globalThis.document = {
  addEventListener: () => {},
  getElementById: (id) => byId.get(id) ?? null,
  querySelectorAll: (sel) => (sel === '.tab' ? [...tabEls] : []),
};

let importCount = 0;

/**
 * Fresh module + the app.js side of the contract. `tabs` is the full strip in order;
 * `visible` (defaults to `tabs`) is what getVisibleTabIds() would return, i.e. the strip
 * minus anything the context filter hid.
 */
async function setup({ tabs = [], visible = null, active = null } = {}) {
  byId.clear();
  tabEls.length = 0;

  const arrowStart = fakeElement('tabs-arrow-start');
  const arrowEnd = fakeElement('tabs-arrow-end');
  const arrows = fakeElement('tabs-arrows');
  byId.set('tabs-arrow-start', arrowStart);
  byId.set('tabs-arrow-end', arrowEnd);
  byId.set('tabs-arrows', arrows);

  for (const id of tabs) {
    const el = fakeElement('tab-' + id);
    byId.set('tab-' + id, el);
    tabEls.push(el);
  }

  const state = { activeId: active, visible: visible ?? tabs, switchCalls: [] };

  const url = new URL('../../public/js/tab-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const mod = await import(url.href);

  mod.initTabArrows({
    getOrderedTabIds: () => state.visible,
    getActiveTabId: () => state.activeId,
    // Exactly what app.js's focusTab → switchTo does at the end: TabManager.setActive(id).
    // Nothing else recomputes the arrows, which is the whole point of the test.
    switchToTab: (id) => {
      state.switchCalls.push(id);
      state.activeId = id;
      mod.TabManager.setActive(id);
    },
  });

  return {
    mod, state, arrowStart, arrowEnd, arrows,
    // Re-run the recompute the way app.js's notifyTabsChanged() does.
    refresh: () => mod.refreshTabArrows(),
    clickNext: () => arrowEnd.listeners.click(),
    clickPrev: () => arrowStart.listeners.click(),
    nextDisabled: () => arrowEnd.disabled,
    prevDisabled: () => arrowStart.disabled,
  };
}

// ---------------------------------------------------------------- tests

test('first tab active: Back disabled, Next enabled', async () => {
  const h = await setup({ tabs: ['a', 'b', 'c'], active: 'a' });
  assert.equal(h.prevDisabled(), true);
  assert.equal(h.nextDisabled(), false);
});

test('middle tab active: both enabled', async () => {
  const h = await setup({ tabs: ['a', 'b', 'c'], active: 'b' });
  assert.equal(h.prevDisabled(), false);
  assert.equal(h.nextDisabled(), false);
});

test('last tab active: Next disabled, Back enabled', async () => {
  const h = await setup({ tabs: ['a', 'b', 'c'], active: 'c' });
  assert.equal(h.prevDisabled(), false);
  assert.equal(h.nextDisabled(), true);
});

test('#610: pressing Next leaves Next enabled while tabs remain after the active one', async () => {
  const h = await setup({ tabs: ['a', 'b', 'c', 'd'], active: 'a' });

  h.clickNext();
  assert.deepEqual(h.state.switchCalls, ['b']);
  // The reported bug: this went true after one press because the list had scrolled to its
  // bottom, even though c and d are still after b.
  assert.equal(h.nextDisabled(), false, 'Next must stay enabled — c and d follow b');

  h.clickNext();
  assert.deepEqual(h.state.switchCalls, ['b', 'c']);
  assert.equal(h.nextDisabled(), false, 'Next must stay enabled — d follows c');

  h.clickNext();
  assert.deepEqual(h.state.switchCalls, ['b', 'c', 'd']);
  assert.equal(h.nextDisabled(), true, 'now genuinely at the last tab');
});

test('#610: state is correct without a Back press to refresh it', async () => {
  // The issue's repro was Next → stuck → Back → Next works again. Walking forward and back
  // must give the same state as arriving at that tab any other way.
  const h = await setup({ tabs: ['a', 'b', 'c'], active: 'a' });
  h.clickNext();          // → b
  h.clickNext();          // → c (end)
  assert.equal(h.nextDisabled(), true);
  h.clickPrev();          // → b
  assert.equal(h.nextDisabled(), false);
  assert.equal(h.prevDisabled(), false);
  h.clickNext();          // → c again
  assert.equal(h.nextDisabled(), true);
  assert.deepEqual(h.state.switchCalls, ['b', 'c', 'b', 'c']);
});

test('Next/Back do not wrap past the ends', async () => {
  const h = await setup({ tabs: ['a', 'b'], active: 'a' });
  h.clickPrev();
  assert.deepEqual(h.state.switchCalls, [], 'Back at the first tab is a no-op');
  h.clickNext();
  h.clickNext();
  assert.deepEqual(h.state.switchCalls, ['b'], 'Next at the last tab is a no-op');
});

test('arrows hidden with a single tab, shown from two', async () => {
  const one = await setup({ tabs: ['a'], active: 'a' });
  assert.equal(one.arrows.classList.contains('visible'), false);

  const two = await setup({ tabs: ['a', 'b'], active: 'a' });
  assert.equal(two.arrows.classList.contains('visible'), true);
});

test('context-hidden tabs are excluded from the navigable set', async () => {
  // Strip holds a, b, c but the active context only shows a and c: from a, Next must go to c,
  // and from c Next must be disabled even though b sits between them in the DOM.
  const h = await setup({ tabs: ['a', 'b', 'c'], visible: ['a', 'c'], active: 'a' });
  assert.equal(h.nextDisabled(), false);
  h.clickNext();
  assert.deepEqual(h.state.switchCalls, ['c']);
  assert.equal(h.nextDisabled(), true);
});

test('active tab outside the navigable set: Back inert, Next lands on the first visible tab', async () => {
  const h = await setup({ tabs: ['a', 'b', 'c'], visible: ['b', 'c'], active: 'a' });
  assert.equal(h.prevDisabled(), true);
  assert.equal(h.nextDisabled(), false);
  h.clickNext();
  assert.deepEqual(h.state.switchCalls, ['b']);
});

test('the .disabled class tracks the disabled property (themes key off the class)', async () => {
  const h = await setup({ tabs: ['a', 'b'], active: 'a' });
  assert.equal(h.arrowStart.classList.contains('disabled'), true);
  assert.equal(h.arrowEnd.classList.contains('disabled'), false);
  h.clickNext();
  assert.equal(h.arrowStart.classList.contains('disabled'), false);
  assert.equal(h.arrowEnd.classList.contains('disabled'), true);
  assert.equal(h.arrowStart.disabled, false);
  assert.equal(h.arrowEnd.disabled, true);
});

test('refreshTabArrows picks up a tab-set change (notifyTabsChanged path)', async () => {
  const h = await setup({ tabs: ['a', 'b'], active: 'b' });
  assert.equal(h.nextDisabled(), true, 'b is last');

  // A new tab arrives after the active one — app.js funnels this through notifyTabsChanged().
  h.state.visible = ['a', 'b', 'c'];
  h.refresh();
  assert.equal(h.nextDisabled(), false, 'c now follows b');

  // ...and closing it takes us back to the end.
  h.state.visible = ['a', 'b'];
  h.refresh();
  assert.equal(h.nextDisabled(), true);
});
