// Headless unit test for the tab hover tooltip in public/js/tab-manager.js (#640).
//
// The regression: `tab.title` was set in createTab() and updateLabel() only. But restore
// pre-creates a PLACEHOLDER for every session (app.js restoreSessions/restoreRecentSession)
// and addTab() upgrades it in place — a branch that returns before createTab() ever runs. So
// a tab opened with Cmd+T had a tooltip and every tab after a page reload had none, forever,
// until it was renamed. All four paths now go through applyTabName(), which owns the three
// name-derived pieces of a tab together: label text, rail icon, and title.
//
// This matters more than a missing tooltip usually would: .tab-label ellipsizes on a crowded
// strip, and the collapsed vertical icon rail hides the label outright, so the tooltip is the
// only way to read a name there.
//
// No browser, no jsdom — same approach as tab-arrows.test.js: stub the globals tab-manager.js
// touches (it registers document listeners at module scope) BEFORE importing it, then drive
// the exported API the way app.js does. Each test re-imports with a unique ?query so
// module-level state starts fresh.
//
// Run: node --test test/unit/tab-title.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake DOM

function fakeClassList() {
  const classes = new Set();
  return {
    _set: classes,
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !classes.has(c) : !!force;
      on ? classes.add(c) : classes.delete(c);
      return on;
    },
  };
}

/**
 * A tab element. applyTabName() reaches for exactly two children by class ('.tab-label',
 * '.tab-icon') and _wireTabEvents() for two more ('.close', '.tab-history'), so the stub
 * children exist unconditionally rather than being parsed out of the assigned innerHTML —
 * which is kept verbatim so a test can assert on the markup itself.
 */
function fakeTabElement() {
  const children = {
    '.tab-label': { textContent: '', classList: fakeClassList() },
    '.tab-icon': { textContent: '', classList: fakeClassList() },
    '.close': { addEventListener: () => {} },
    '.tab-history': { addEventListener: () => {} },   // #672
    '.badge': { classList: fakeClassList() },
    '.speaker-icon': { classList: fakeClassList() },
  };
  const el = {
    id: '',
    className: '',
    title: undefined,       // undefined, not '' — so "never set" is distinguishable
    innerHTML: '',
    classList: fakeClassList(),
    querySelector: (sel) => children[sel] ?? null,
    addEventListener: () => {},
    scrollIntoView: () => {},
  };
  // className is what the real code sets; keep classList in sync so .contains('placeholder')
  // works the way addTab()'s upgrade branch expects.
  return new Proxy(el, {
    set(t, k, v) {
      if (k === 'className') for (const c of String(v).split(/\s+/).filter(Boolean)) t.classList.add(c);
      t[k] = v;
      return true;
    },
  });
}

const byId = new Map();

globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: (id) => byId.get(id) ?? null,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => fakeTabElement(),
};

let importCount = 0;

async function setup() {
  byId.clear();
  // addPlaceholderTab()/addTab() append here. updateTabArrows() no-ops without initTabArrows().
  byId.set('tabs-list', { appendChild: () => {} });

  const url = new URL('../../public/js/tab-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const { TabManager } = await import(url.href);

  // The real addTab() finds a placeholder via document.getElementById('tab-' + id); register
  // whatever the constructors hand back so the upgrade branch can find it.
  const track = (el) => { byId.set(el.id, el); return el; };

  return {
    createTab: (id, name) => track(TabManager.createTab(id, name, {})),
    addPlaceholder: (id, name) => track(TabManager.addPlaceholderTab(id, name)),
    addTab: (id, name) => track(TabManager.addTab(id, name, {})),
    updateLabel: (id, name) => TabManager.updateLabel(id, name),
    label: (el) => el.querySelector('.tab-label').textContent,
    icon: (el) => el.querySelector('.tab-icon').textContent,
    isEmoji: (el) => el.querySelector('.tab-icon').classList.contains('is-emoji'),
  };
}

// ---------------------------------------------------------------- tests

test('createTab titles the tab (the path that already worked)', async () => {
  const h = await setup();
  const tab = h.createTab('a', 'My Session');
  assert.equal(tab.title, 'My Session');
  assert.equal(h.label(tab), 'My Session');
});

test('a placeholder is hoverable while it waits to be upgraded', async () => {
  // Placeholders are on screen for the whole restore, which is exactly when you are most
  // likely to be scanning the strip for a tab.
  const h = await setup();
  const tab = h.addPlaceholder('a', 'My Session');
  assert.equal(tab.title, 'My Session');
});

test('#640: the placeholder upgrade path sets the title', async () => {
  // The reported bug. Restore pre-creates the placeholder, then initTerminal's addTab()
  // upgrades it in place — before the fix that branch updated the label and the icon but
  // never the title, so every tab lost its tooltip on reload.
  const h = await setup();
  const placeholder = h.addPlaceholder('a', 'Old Name');
  const upgraded = h.addTab('a', 'My Session');

  assert.equal(upgraded, placeholder, 'addTab must upgrade in place, not append a second tab');
  assert.equal(upgraded.title, 'My Session', 'upgraded tab must carry the hover tooltip (#640)');
  assert.equal(h.label(upgraded), 'My Session');
  assert.equal(upgraded.classList.contains('placeholder'), false);
});

test('#640: a renamed tab moves label, icon and title together', async () => {
  const h = await setup();
  const tab = h.addPlaceholder('a', 'Old Name');
  h.addTab('a', 'Old Name');

  h.updateLabel('a', '🚀 Deploy');
  assert.equal(tab.title, '🚀 Deploy');
  assert.equal(h.label(tab), '🚀 Deploy');
  assert.equal(h.icon(tab), '🚀', 'rail glyph must follow the rename too');
  assert.equal(h.isEmoji(tab), true);
});

test('the icon rail glyph is set on every construction path, not just createTab', async () => {
  // The rail shows nothing BUT this glyph, so a path that skips it renders a wrong tab.
  const h = await setup();
  const fresh = h.createTab('a', '#640 Tooltip');
  const placeholder = h.addPlaceholder('b', '#640 Tooltip');
  assert.equal(h.icon(fresh), '40');
  assert.equal(h.icon(placeholder), '40');
});

test('no child of a tab carries its own title, which would shadow the name', async () => {
  // The speaker icon used to declare title="Emitting audio". It is aria-hidden, so the title
  // bought nothing an assistive tech could use, and it cost the tab name on hover — in the
  // icon rail especially, which hides .tab-label and .close but keeps the speaker visible.
  const h = await setup();
  const fresh = h.createTab('a', 'My Session');
  const placeholder = h.addPlaceholder('b', 'My Session');
  for (const [what, el] of [['createTab', fresh], ['addPlaceholderTab', placeholder]]) {
    assert.ok(!/\btitle=/.test(el.innerHTML),
      `${what}: no child span may declare a title — it shadows the tab's own tooltip (#640)`);
  }
});

test('every path produces the same markup', async () => {
  // The two constructors carried byte-identical templates that drifted apart once (#640).
  // One skeleton now, with everything name-derived applied afterwards.
  const h = await setup();
  assert.equal(h.createTab('a', 'One').innerHTML, h.addPlaceholder('b', 'Two').innerHTML);
});

test('an empty name still yields a usable tab', async () => {
  const h = await setup();
  const tab = h.createTab('a', '');
  assert.equal(tab.title, '');
  assert.equal(h.icon(tab), '•', 'tabIcon() falls back to a bullet');
});
