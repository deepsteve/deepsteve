// Headless unit test for public/js/decision-mode.js — Decision Tab mode (#716).
//
// No browser: stub `document` with just the elements the module touches, then drive it the
// way app.js does — setDecisionTabs() for the server's list, sync() after every tab change.
// A tiny fake strip stands in for #tabs-list; activateTab/switchToTab move `active` and
// re-sync, as switchTo()'s scheduled sync would.
//
// What this pins:
//   - the button shows only while a decision tab is open in this window (or the mode is on)
//   - entering hides every other tab and lands on a decision; the pager steps through them
//   - answering the last one shows the empty inbox instead of dropping out of the mode
//   - focus moving to a tab that is not a decision leaves the mode, so it is never hidden
//
// Run: node --test test/unit/decision-mode.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

function fakeElement(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id,
    style: { display: '' },
    textContent: '',
    title: '',
    disabled: false,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { listeners.click?.(); },
    blur() {},
  };
}

const els = new Map();
function el(id) {
  if (!els.has(id)) els.set(id, fakeElement(id));
  return els.get(id);
}
globalThis.document = { getElementById: (id) => el(id) };

let DM;
let strip;       // ordered tab ids in this window
let active;      // active tab id
let modeChanges;

function switchTo(id) {
  active = id;
  DM.sync();
}

beforeEach(async () => {
  els.clear();
  // A fresh module per test: it holds the mode and the list at module scope.
  DM = await import(`../../public/js/decision-mode.js?t=${Date.now()}-${Math.random()}`);
  strip = ['term1', 'dec1', 'term2', 'dec2'];
  active = 'term1';
  modeChanges = 0;
  DM.init({
    getAllTabIds: () => strip.slice(),
    getActiveTabId: () => active,
    switchToTab: switchTo,
    activateTab: switchTo,
    onModeChanged: () => { modeChanges++; DM.sync(); },
  });
});

const btn = () => el('decision-mode-btn');
const hidden = (id) => el('tab-' + id).classList.contains('decision-hidden');

test('the button shows only while this window has a decision tab open', () => {
  assert.strictEqual(btn().style.display, 'none');
  // A decision tab open in ANOTHER window is not one this window can show.
  DM.setDecisionTabs([{ id: 'elsewhere' }]);
  assert.strictEqual(btn().style.display, 'none');
  DM.setDecisionTabs([{ id: 'dec1' }, { id: 'dec2' }]);
  assert.strictEqual(btn().style.display, '');
  assert.strictEqual(el('decision-mode-count').textContent, '2');
  assert.ok(el('tab-dec1').classList.contains('decision-tab'));
  DM.setDecisionTabs([]);
  assert.strictEqual(btn().style.display, 'none');
});

test('entering hides every other tab and lands on the first decision; the pager steps', () => {
  DM.setDecisionTabs([{ id: 'dec1' }, { id: 'dec2' }]);
  btn().click();
  assert.strictEqual(DM.isDecisionModeActive(), true);
  assert.strictEqual(active, 'dec1');
  assert.deepStrictEqual(strip.filter(hidden), ['term1', 'term2']);
  assert.strictEqual(el('decision-pager').style.display, '');
  assert.strictEqual(el('decision-pos').textContent, '1/2');
  assert.strictEqual(el('decision-prev').disabled, true);

  el('decision-next').click();
  assert.strictEqual(active, 'dec2');
  assert.strictEqual(el('decision-pos').textContent, '2/2');
  assert.strictEqual(el('decision-next').disabled, true);
  el('decision-prev').click();
  assert.strictEqual(active, 'dec1');

  btn().click();
  assert.strictEqual(DM.isDecisionModeActive(), false);
  assert.deepStrictEqual(strip.filter(hidden), []);
  assert.strictEqual(el('decision-pager').style.display, 'none');
});

test('entering with no decision tab open does nothing', () => {
  DM.enter();
  assert.strictEqual(DM.isDecisionModeActive(), false);
  assert.strictEqual(modeChanges, 0);
});

test('an answered tab that closes moves on to the next decision', () => {
  DM.setDecisionTabs([{ id: 'dec1' }, { id: 'dec2' }]);
  DM.enter();
  // Server closes dec1: killSession removes it and falls back to the raw DOM neighbour.
  strip = strip.filter(id => id !== 'dec1');
  active = 'term2';
  DM.sync();
  assert.strictEqual(DM.isDecisionModeActive(), true);
  assert.strictEqual(active, 'dec2');
});

test('the last answer shows the empty inbox and keeps the mode (and its button) on', () => {
  DM.setDecisionTabs([{ id: 'dec1' }]);
  DM.enter();
  strip = strip.filter(id => id !== 'dec1');
  active = 'term1';
  DM.setDecisionTabs([]);
  assert.strictEqual(DM.isDecisionModeActive(), true);
  assert.strictEqual(el('decision-inbox-empty').classList.contains('hidden'), false);
  assert.strictEqual(btn().style.display, '', 'still there, to leave by');
  assert.strictEqual(el('decision-pager').style.display, 'none');
  // Staying put on later syncs, not flapping out of the mode.
  DM.sync();
  assert.strictEqual(DM.isDecisionModeActive(), true);

  // A new decision arrives while the inbox is empty: it shows up and gets landed on.
  strip.push('dec3');
  DM.setDecisionTabs([{ id: 'dec3' }]);
  assert.strictEqual(active, 'dec3');
  assert.strictEqual(el('decision-inbox-empty').classList.contains('hidden'), true);

  el('decision-inbox-exit').click();
  assert.strictEqual(DM.isDecisionModeActive(), false);
});

test('a decision answered in place (tab kept open) leaves the list and the mode moves on', () => {
  DM.setDecisionTabs([{ id: 'dec1' }, { id: 'dec2' }]);
  DM.enter();
  assert.strictEqual(active, 'dec1');
  DM.setDecisionTabs([{ id: 'dec2' }]);
  assert.strictEqual(active, 'dec2');
  assert.ok(hidden('dec1'));
});

test('focus moving to a tab that is not a decision leaves the mode rather than hide it', () => {
  DM.setDecisionTabs([{ id: 'dec1' }]);
  DM.enter();
  assert.strictEqual(active, 'dec1');
  // The user opens a new terminal from inside the mode.
  strip.push('term3');
  switchTo('term3');
  assert.strictEqual(DM.isDecisionModeActive(), false);
  assert.strictEqual(active, 'term3');
  assert.deepStrictEqual(strip.filter(hidden), []);
});
