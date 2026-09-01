// Headless unit tests for the tab right-click menu's session-lifecycle items:
// Autopilot (#643) and Merge (#688).
//
// Autopilot's whole point is that it is a SERVER-side value: the menu is one of the
// two switches that writes it, and it must show the session's real state (which the
// server re-sends on every reconnect) rather than a browser-local guess. What this
// file pins is the part that lives in the browser — when the item is offered at all,
// which state the tick reflects, and that clicking it asks for the OPPOSITE value.
// Merge, added below, is the other half of taking the model out of that path: with
// Autopilot the session merges itself, and with this item a human merges it directly.
//
// No browser, no jsdom: same approach as tab-title.test.js and tab-arrows.test.js —
// stub the globals tab-manager.js touches (it registers document listeners at module
// scope) BEFORE importing it, then drive the exported API the way app.js does. Each
// test re-imports with a unique ?query so module-level state starts fresh.
//
// Run: node --test test/unit/tab-autopilot-menu.test.js

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

// One element shape for everything the menu builder and the tab need. Listeners are
// captured by type so a test can fire `contextmenu` the way a right-click does.
function fakeElement() {
  const children = [];
  const listeners = {};
  const stubs = {
    '.tab-label': { textContent: '', classList: fakeClassList() },
    '.tab-icon': { textContent: '', classList: fakeClassList() },
    '.close': { addEventListener: () => {} },
    '.tab-history': { addEventListener: () => {} },   // #672
  };
  const el = {
    children,
    listeners,
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    classList: fakeClassList(),
    onclick: null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: () => {},
    appendChild: (c) => { children.push(c); return c; },
    remove: () => {},
    querySelector: (sel) => stubs[sel] ?? null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  };
  return el;
}

const bodyChildren = [];

globalThis.window = { innerWidth: 1200, innerHeight: 800 };
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: (id) => (id === 'tabs-list' ? { appendChild: () => {} } : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeElement(),
  body: { appendChild: (el) => { bodyChildren.push(el); return el; } },
};

let importCount = 0;

async function setup(callbacks) {
  bodyChildren.length = 0;
  const url = new URL('../../public/js/tab-manager.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  const { TabManager } = await import(url.href);
  const tab = TabManager.createTab('s1', 'Session', callbacks);
  return { tab };
}

/** Right-click a tab and hand back the menu items showContextMenu() built. */
function openMenuOn(tab) {
  tab.listeners.contextmenu({ preventDefault: () => {}, clientX: 10, clientY: 10 });
  const menu = bodyChildren.at(-1);
  return menu.children.filter((c) => c.className === 'context-menu-item');
}

const labelOf = (item) => (item.innerHTML || item.textContent || '');
const findAutopilot = (items) => items.find((i) => labelOf(i).includes('Autopilot')) || null;
const findMerge = (items) => items.find((i) => labelOf(i).includes('Merge')) || null;

// ---------------------------------------------------------------- tests

test('no Autopilot item when the callback says it does not apply', async () => {
  // `null` is what a plain terminal, a mod tab, a display tab and a project mod all
  // return. The item is omitted rather than disabled: there is nothing the user
  // could do to those tabs to make it apply.
  const { tab } = await setup({ getAutopilot: () => null });
  const items = openMenuOn(tab);
  assert.equal(findAutopilot(items), null);
  // The rest of the menu is untouched.
  assert.ok(items.some((i) => labelOf(i) === 'Rename'));
  assert.ok(items.some((i) => labelOf(i) === 'Close tab'));
});

test('no Autopilot item when a tab kind supplies no callback at all', async () => {
  const { tab } = await setup({});
  assert.equal(findAutopilot(openMenuOn(tab)), null);
});

test('an autopilot-off worktree session gets an unticked item', async () => {
  const { tab } = await setup({ getAutopilot: () => false });
  const item = findAutopilot(openMenuOn(tab));
  assert.ok(item, 'the item must be offered on a worktree session');
  assert.ok(!labelOf(item).includes('&#10003;'), 'off must not be ticked');
  // The unchecked state keeps the label's indent, so the two states don't jitter.
  assert.match(labelOf(item), /^&nbsp;&nbsp; Autopilot$/);
});

test('an autopilot-on session gets a ticked item', async () => {
  const { tab } = await setup({ getAutopilot: () => true });
  const item = findAutopilot(openMenuOn(tab));
  assert.match(labelOf(item), /^&#10003; Autopilot$/);
});

test('clicking asks for the opposite value, both ways', async () => {
  // The click carries the value it wants rather than "toggle", so the server is
  // told what to store and two windows can never disagree about the direction.
  for (const current of [false, true]) {
    const calls = [];
    const { tab } = await setup({
      getAutopilot: () => current,
      onToggleAutopilot: (id, next) => calls.push([id, next]),
    });
    findAutopilot(openMenuOn(tab)).onclick();
    assert.deepEqual(calls, [['s1', !current]], `clicking a ${current} item must request ${!current}`);
  }
});

test('the item sits in its own group, between Send to Window and Fork tab', async () => {
  // Placement is load-bearing: Autopilot changes what the session does on its own,
  // which is a different kind of act from Fork/Close, and grouping says so.
  // History (#672) sits with Fork rather than with Autopilot — both are things you
  // do TO a session's conversation, and neither changes how it runs.
  const { tab } = await setup({ getAutopilot: () => false });
  const menu = (tab.listeners.contextmenu({ preventDefault: () => {}, clientX: 1, clientY: 1 }), bodyChildren.at(-1));
  const labels = menu.children.map((c) => (c.className === 'context-menu-separator' ? '---' : labelOf(c)));
  assert.deepEqual(labels, [
    'Rename',
    'Send to Window',
    '---',
    '&nbsp;&nbsp; Autopilot',
    '---',
    'Fork tab',
    'History…',
    'Close tab',
  ]);
});

// ── Merge (#688) ─────────────────────────────────────────────────────────────
//
// Same menu, same harness — which is why these live here rather than in a file of their
// own that would need its own copy of the fake DOM above.
//
// The point of the item is that merging a finished worktree needs no model: before it,
// the only route was to type `/deepsteve:merge` at the session and pay ~10 turns of
// replayed context for work the daemon can do alone.

test('no Merge item when the tab is not a worktree session', async () => {
  const { tab } = await setup({ getWorktree: () => null });
  assert.equal(findMerge(openMenuOn(tab)), null);
});

test('no Merge item when a tab kind supplies no callback at all', async () => {
  // The three iframe-backed tab kinds. Omitted, not disabled — the Autopilot rule.
  const { tab } = await setup({});
  assert.equal(findMerge(openMenuOn(tab)), null);
});

test('a worktree session gets a Merge item', async () => {
  const { tab } = await setup({ getWorktree: () => 'github-issue-688' });
  const item = findMerge(openMenuOn(tab));
  assert.ok(item, 'the item must be offered on a worktree session');
  // The ellipsis is a promise: unlike Autopilot beside it, this one asks first.
  assert.match(labelOf(item), /^&nbsp;&nbsp; Merge…$/);
});

test('clicking Merge hands the session id to the callback', async () => {
  const calls = [];
  const { tab } = await setup({
    getWorktree: () => 'github-issue-688',
    onMerge: (id) => calls.push(id),
  });
  findMerge(openMenuOn(tab)).onclick();
  assert.deepEqual(calls, ['s1']);
});

test('Merge does not depend on Autopilot being applicable, or vice versa', async () => {
  // They are offered on the same tabs today. Deriving one's visibility from the other's
  // would make that a coincidence the next change has to preserve, so each has its own
  // callback and each is tested without the other.
  const onlyMerge = await setup({ getWorktree: () => 'w' });
  const a = openMenuOn(onlyMerge.tab);
  assert.ok(findMerge(a), 'Merge is offered with no getAutopilot at all');
  assert.equal(findAutopilot(a), null);

  const onlyAutopilot = await setup({ getAutopilot: () => false });
  const b = openMenuOn(onlyAutopilot.tab);
  assert.ok(findAutopilot(b));
  assert.equal(findMerge(b), null);
});

test('on a worktree tab both items share one group, Merge below Autopilot', async () => {
  // One separator, not two: they are the same kind of act — what happens to this
  // session's work — and Merge reads as the thing Autopilot would have done for you.
  const { tab } = await setup({ getAutopilot: () => true, getWorktree: () => 'w' });
  const menu = (tab.listeners.contextmenu({ preventDefault: () => {}, clientX: 1, clientY: 1 }), bodyChildren.at(-1));
  const labels = menu.children.map((c) => (c.className === 'context-menu-separator' ? '---' : labelOf(c)));
  assert.deepEqual(labels, [
    'Rename',
    'Send to Window',
    '---',
    '&#10003; Autopilot',
    '&nbsp;&nbsp; Merge…',
    '---',
    'Fork tab',
    'History…',
    'Close tab',
  ]);
});
