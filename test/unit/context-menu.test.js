// Unit tests for public/js/context-menu.js (#723): the submenu row every right-click menu can use,
// and keyboard navigation for a whole menu.
//
// No browser, no jsdom. The fake DOM below keeps real parent links, because the module's whole
// behavior turns on them: a flyout lives inside its trigger, a row's level is its parent, and a
// timer that outlives its menu must find the trigger disconnected. Timers are node:test's mocks.
//
// Run: node --test test/unit/context-menu.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------- fake DOM

function fakeClassList() {
  const classes = new Set();
  return {
    add: (...c) => c.forEach((x) => classes.add(x)),
    remove: (...c) => c.forEach((x) => classes.delete(x)),
    contains: (c) => classes.has(c),
  };
}

let viewport = { w: 1200, h: 800 };

function el(className = '') {
  const node = {
    parentElement: null,
    children: [],
    listeners: {},
    attrs: {},
    style: {},
    classList: fakeClassList(),
    onclick: null,
    rect: { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 },
    clicks: 0,
    scrolled: 0,
    get className() { return this._className; },
    set className(v) { this._className = v; v.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); },
    get isConnected() {
      let n = this;
      while (n.parentElement) n = n.parentElement;
      return n === body;
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    fire(type, e = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, ...e }); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) {
      c.parentElement?.children.splice(c.parentElement.children.indexOf(c), 1);
      c.parentElement = this;
      this.children.push(c);
      return c;
    },
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    },
    contains(n) { for (; n; n = n.parentElement) if (n === this) return true; return false; },
    closest(sel) {
      const cls = sel.replace(/^\./, '');
      for (let n = this; n; n = n.parentElement) if (n.classList.contains(cls)) return n;
      return null;
    },
    getBoundingClientRect() { return this.rect; },
    // Real HTMLElement.click() dispatches a click; here, the onclick property is all there is.
    click() { this.clicks++; this.onclick?.({ target: this, stopPropagation() {} }); },
    scrollIntoView() { this.scrolled++; },
  };
  node.className = className;
  return node;
}

const body = el();
const docKeydown = [];

globalThis.window = {
  get innerWidth() { return viewport.w; },
  get innerHeight() { return viewport.h; },
};
globalThis.document = {
  body,
  createElement: () => el(),
  addEventListener: (type, fn, capture) => { if (type === 'keydown') docKeydown.push({ fn, capture }); },
  removeEventListener: (type, fn) => {
    const i = docKeydown.findIndex((l) => l.fn === fn);
    if (i >= 0) docKeydown.splice(i, 1);
  },
};

let importCount = 0;
async function load() {
  const url = new URL('../../public/js/context-menu.js', `file://${__filename}`);
  url.search = `?t=${++importCount}`;
  return import(url.href);
}

/** A menu in the page with plain rows; `spec` entries are labels, `!label` for a disabled one. */
function buildMenu(spec) {
  body.children.length = 0;
  docKeydown.length = 0;
  viewport = { w: 1200, h: 800 };
  const menu = body.appendChild(el('context-menu'));
  const rows = {};
  spec.forEach((label, i) => {
    const disabled = label.startsWith('!');
    const name = disabled ? label.slice(1) : label;
    const row = menu.appendChild(el('context-menu-item'));
    if (disabled) row.classList.add('disabled');
    row.label = name;
    row.rect = { left: 100, top: 100 + i * 30, right: 260, bottom: 130 + i * 30, width: 160, height: 30 };
    rows[name] = row;
  });
  return { menu, rows };
}

const fillWith = (...labels) => (flyout) => {
  flyout.rect = { left: 0, top: 0, right: 180, bottom: labels.length * 30, width: 180, height: labels.length * 30 };
  for (const label of labels) {
    const r = flyout.appendChild(el('context-menu-item'));
    r.label = label;
  }
};

const flyoutOf = (trigger) => trigger.children.find((c) => c.classList.contains('context-flyout')) || null;

function press(key, mods = {}) {
  let prevented = false;
  let stopped = false;
  const e = { key, ...mods, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } };
  for (const { fn } of [...docKeydown]) fn(e);
  return { prevented, stopped };
}

const activeIn = (root) => {
  const found = [];
  (function walk(n) { if (n.classList.contains('active')) found.push(n); n.children.forEach(walk); })(root);
  return found.map((n) => n.label);
};

// ---------------------------------------------------------------- attachSubmenu

test('a submenu row gets an arrow and the aria a submenu needs, and starts closed', async () => {
  const { attachSubmenu } = await load();
  const { menu, rows } = buildMenu(['More']);
  const sub = attachSubmenu(menu, rows.More, fillWith('x'));
  assert.ok(rows.More.classList.contains('context-menu-has-submenu'));
  assert.ok(rows.More.children.some((c) => c.className === 'context-menu-arrow'));
  assert.equal(rows.More.attrs['aria-haspopup'], 'menu');
  assert.equal(rows.More.attrs['aria-expanded'], 'false');
  assert.equal(sub.isOpen(), false);
});

test('hover opens the flyout only after the open delay, rebuilt fresh each time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { attachSubmenu, SUBMENU_OPEN_DELAY_MS } = await load();
  const { menu, rows } = buildMenu(['More']);
  let builds = 0;
  const sub = attachSubmenu(menu, rows.More, (f) => { builds++; fillWith('a', 'b')(f); });

  rows.More.fire('mouseenter');
  t.mock.timers.tick(SUBMENU_OPEN_DELAY_MS - 1);
  assert.equal(sub.isOpen(), false, 'a pointer sweeping past does not open it');
  t.mock.timers.tick(1);
  assert.equal(sub.isOpen(), true);
  assert.equal(rows.More.attrs['aria-expanded'], 'true');
  assert.deepEqual(flyoutOf(rows.More).children.map((r) => r.label), ['a', 'b']);

  sub.close();
  assert.equal(flyoutOf(rows.More), null, 'closing removes it');
  assert.equal(rows.More.attrs['aria-expanded'], 'false');
  sub.open();
  assert.equal(builds, 2);
});

test('leaving the trigger closes it after a grace that re-entering cancels', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { attachSubmenu, SUBMENU_CLOSE_DELAY_MS } = await load();
  const { menu, rows } = buildMenu(['More', 'Below']);
  const sub = attachSubmenu(menu, rows.More, fillWith('a'));
  sub.open();

  // The pointer crosses the gap (or the row beneath) on its way into the flyout. The flyout is a
  // child of the trigger, so arriving in it is a mouseenter on the trigger.
  rows.More.fire('mouseleave');
  t.mock.timers.tick(SUBMENU_CLOSE_DELAY_MS - 1);
  rows.More.fire('mouseenter');
  t.mock.timers.tick(SUBMENU_CLOSE_DELAY_MS * 2);
  assert.equal(sub.isOpen(), true, 'it did not snap shut on the way across');

  rows.More.fire('mouseleave');
  t.mock.timers.tick(SUBMENU_CLOSE_DELAY_MS);
  assert.equal(sub.isOpen(), false);
});

test('a timer outliving its menu does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { attachSubmenu } = await load();
  const { menu, rows } = buildMenu(['More']);
  const sub = attachSubmenu(menu, rows.More, fillWith('a'));
  rows.More.fire('mouseenter');
  menu.remove(); // the menu was dismissed during the open delay
  t.mock.timers.tick(10_000);
  assert.equal(sub.isOpen(), false);

  const again = buildMenu(['More']);
  const sub2 = attachSubmenu(again.menu, again.rows.More, fillWith('a'));
  again.rows.More.fire('mouseenter');
  sub2.close(); // and close() clears a pending open
  t.mock.timers.tick(10_000);
  assert.equal(sub2.isOpen(), false);
});

test('one flyout open per menu: opening a second closes the first', async () => {
  const { attachSubmenu } = await load();
  const { menu, rows } = buildMenu(['One', 'Two']);
  const one = attachSubmenu(menu, rows.One, fillWith('a'));
  const two = attachSubmenu(menu, rows.Two, fillWith('b'));
  one.open();
  two.open();
  assert.equal(one.isOpen(), false);
  assert.equal(two.isOpen(), true);
});

test('the flyout sits to the right, flips left at the right edge, and stays inside the viewport', async () => {
  const { attachSubmenu } = await load();
  const { menu, rows } = buildMenu(['More']);
  const sub = attachSubmenu(menu, rows.More, fillWith('a', 'b', 'c'));
  sub.open();
  assert.equal(sub.flyout.style.left, '262px', 'right of the trigger, past the gap');
  assert.equal(sub.flyout.style.top, '100px', 'level with the trigger');
  sub.close();

  rows.More.rect = { left: 1000, top: 100, right: 1160, bottom: 130, width: 160, height: 30 };
  sub.open();
  assert.equal(sub.flyout.style.left, '818px', 'flipped: 1000 - 180 - 2');
  sub.close();

  // Low on the screen, and on a viewport too narrow for either side: clamped, never off-screen.
  viewport = { w: 300, h: 160 };
  rows.More.rect = { left: 4, top: 140, right: 290, bottom: 170, width: 286, height: 30 };
  sub.open();
  assert.equal(sub.flyout.style.left, '8px');
  assert.equal(sub.flyout.style.top, '62px', '160 - 90 - 8');
});

test('the trigger click runs its own action when it has one, and opens the flyout when not', async () => {
  const { attachSubmenu } = await load();
  const { menu, rows } = buildMenu(['Act', 'Open']);
  let acted = 0;
  const act = attachSubmenu(menu, rows.Act, fillWith('a'), { onClick: () => { acted++; } });
  const open = attachSubmenu(menu, rows.Open, fillWith('b'));

  rows.Act.onclick();
  assert.equal(acted, 1);
  assert.equal(act.isOpen(), false);
  assert.equal(act.opensOnClick, false);

  let stopped = false;
  rows.Open.onclick({ target: rows.Open, stopPropagation: () => { stopped = true; } });
  assert.equal(open.isOpen(), true);
  assert.ok(stopped, "the document's click listener must not close the menu it just opened into");
  assert.equal(open.opensOnClick, true);
});

test('a click inside the flyout stops there, so the trigger never acts on it too', async () => {
  const { attachSubmenu } = await load();
  const { menu, rows } = buildMenu(['Reopen']);
  const sub = attachSubmenu(menu, rows.Reopen, fillWith('a'), { onClick: () => {} });
  sub.open();
  let stopped = false;
  sub.flyout.fire('click', { target: sub.flyout.children[0], stopPropagation: () => { stopped = true; } });
  assert.ok(stopped);
});

// ---------------------------------------------------------------- enableMenuKeyboard

test('↓/↑ walk the enabled rows, skipping disabled ones, and wrap', async () => {
  const { enableMenuKeyboard } = await load();
  const { menu } = buildMenu(['A', '!B', 'C']);
  enableMenuKeyboard(menu);
  assert.ok(menu.classList.contains('context-menu-kbd'));
  press('ArrowDown');
  assert.deepEqual(activeIn(menu), ['A']);
  press('ArrowDown');
  assert.deepEqual(activeIn(menu), ['C'], 'B is disabled');
  press('ArrowDown');
  assert.deepEqual(activeIn(menu), ['A'], 'wraps');
  press('ArrowUp');
  assert.deepEqual(activeIn(menu), ['C']);
});

test('↑ with nothing highlighted starts from the bottom', async () => {
  const { enableMenuKeyboard } = await load();
  const { menu } = buildMenu(['A', 'B']);
  enableMenuKeyboard(menu);
  press('ArrowUp');
  assert.deepEqual(activeIn(menu), ['B']);
});

test('→ steps into a submenu, ← and Esc step back out to its row', async () => {
  const { attachSubmenu, enableMenuKeyboard } = await load();
  const { menu, rows } = buildMenu(['More', 'Plain']);
  const sub = attachSubmenu(menu, rows.More, fillWith('x', 'y'));
  let closed = 0;
  enableMenuKeyboard(menu, { onClose: () => { closed++; } });

  press('ArrowDown');
  press('ArrowRight');
  assert.equal(sub.isOpen(), true);
  assert.deepEqual(activeIn(menu), ['x']);
  press('ArrowDown');
  assert.deepEqual(activeIn(menu), ['y'], 'the flyout is its own level');
  press('ArrowDown');
  assert.deepEqual(activeIn(menu), ['x'], 'and wraps inside it');

  press('ArrowLeft');
  assert.equal(sub.isOpen(), false);
  assert.deepEqual(activeIn(menu), ['More']);

  press('ArrowRight');
  press('Escape');
  assert.equal(sub.isOpen(), false);
  assert.deepEqual(activeIn(menu), ['More']);
  assert.equal(closed, 0, 'Esc in a flyout only leaves the flyout');
  press('Escape');
  assert.equal(closed, 1, 'Esc at the top closes the menu');
});

test('→ on a plain row does nothing; moving off an open submenu row closes its flyout', async () => {
  const { attachSubmenu, enableMenuKeyboard } = await load();
  const { menu, rows } = buildMenu(['More', 'Plain']);
  const sub = attachSubmenu(menu, rows.More, fillWith('x'));
  enableMenuKeyboard(menu);
  press('ArrowDown');
  press('ArrowDown');
  press('ArrowRight');
  assert.deepEqual(activeIn(menu), ['Plain']);
  press('ArrowUp');
  sub.open(); // the pointer opened it while the keys sat on its row
  press('ArrowDown');
  assert.equal(sub.isOpen(), false);
  assert.deepEqual(activeIn(menu), ['Plain']);
});

test('Enter clicks the highlighted row; on a submenu row with no action of its own it steps in', async () => {
  const { attachSubmenu, enableMenuKeyboard } = await load();
  const { menu, rows } = buildMenu(['Act', 'More', 'Plain']);
  let acted = 0;
  attachSubmenu(menu, rows.Act, fillWith('a'), { onClick: () => { acted++; } });
  const more = attachSubmenu(menu, rows.More, fillWith('m'));
  enableMenuKeyboard(menu);

  press('ArrowDown');
  press('Enter');
  assert.equal(acted, 1, '"Reopen closed tab" reopens the newest from the keyboard too');

  press('ArrowDown');
  press('Enter');
  assert.equal(more.isOpen(), true);
  assert.deepEqual(activeIn(menu), ['m']);
  press(' ');
  assert.equal(more.flyout.children[0].clicks, 1, 'Space is Enter');

  press('ArrowLeft');
  press('ArrowDown');
  press('Enter');
  assert.equal(rows.Plain.clicks, 1);
});

test('handled keys are swallowed, anything else and any chord passes through', async () => {
  const { enableMenuKeyboard } = await load();
  const { menu } = buildMenu(['A']);
  enableMenuKeyboard(menu);
  assert.deepEqual(press('ArrowDown'), { prevented: true, stopped: true });
  assert.deepEqual(press('Enter'), { prevented: true, stopped: true }, 'never a newline in the PTY');
  assert.deepEqual(press('a'), { prevented: false, stopped: false });
  assert.deepEqual(press('ArrowDown', { metaKey: true }), { prevented: false, stopped: false });
  assert.deepEqual(press('k', { ctrlKey: true }), { prevented: false, stopped: false });
});

test('the listener is capture-phase on the document, and dispose removes it', async () => {
  const { enableMenuKeyboard } = await load();
  const { menu } = buildMenu(['A']);
  const keys = enableMenuKeyboard(menu);
  assert.equal(docKeydown.length, 1);
  assert.equal(docKeydown[0].capture, true);
  keys.dispose();
  assert.equal(docKeydown.length, 0);
  assert.deepEqual(press('ArrowDown'), { prevented: false, stopped: false });
});

test('the mouse moves the same single highlight, and a disabled row or leaving clears it', async () => {
  const { enableMenuKeyboard } = await load();
  const { menu, rows } = buildMenu(['A', '!B', 'C']);
  enableMenuKeyboard(menu);
  menu.fire('mousemove', { target: rows.C });
  assert.deepEqual(activeIn(menu), ['C']);
  press('ArrowUp');
  assert.deepEqual(activeIn(menu), ['A'], 'the keys carry on from where the pointer was');
  menu.fire('mousemove', { target: rows.B });
  assert.deepEqual(activeIn(menu), []);
  menu.fire('mousemove', { target: rows.A });
  menu.fire('mouseleave');
  assert.deepEqual(activeIn(menu), []);
});

test('keys scroll the highlighted row into view; the mouse does not', async () => {
  const { enableMenuKeyboard } = await load();
  const { menu, rows } = buildMenu(['A', 'B']);
  enableMenuKeyboard(menu);
  menu.fire('mousemove', { target: rows.B });
  assert.equal(rows.B.scrolled, 0);
  press('ArrowUp');
  assert.equal(rows.A.scrolled, 1);
});
