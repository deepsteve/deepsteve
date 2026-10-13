// Headless unit test for public/js/tab-slot.js — the reserved place at the head of a project's
// tab strip for the tab holding its orchestrator. Which project has a slot and which tab holds
// it are app.js's and project-views.js's answers, injected here as callbacks; this pins what the
// module draws from them, the pin it asks for, and the open request its right-click menu sends.
//
// No browser: stub the globals the module touches before importing it, and re-import with a
// unique ?query per test so module-level state starts fresh.
//
// Run: node --test test/unit/tab-slot.test.js

const { test } = require('node:test');
const assert = require('node:assert');

function fakeElement(tag = 'div') {
  const classes = new Set();
  let children = [];
  let text = '';
  const el = {
    tag, id: '', title: '', style: {}, dataset: {}, attrs: {}, listeners: {},
    get children() { return children; },
    get isConnected() { return !!el.parent; },
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
    append: (...kids) => { for (const k of kids) el.appendChild(k); },
    appendChild: (child) => { child.parent = el; children.push(child); return child; },
    insertBefore: (child, ref) => {
      const i = ref ? children.indexOf(ref) : -1;
      children.splice(i === -1 ? children.length : i, 0, child);
      child.parent = el;
      return child;
    },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    getBoundingClientRect: () => ({ width: 100, height: 30, right: 100, bottom: 30 }),
    remove: () => {
      const p = el.parent;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      el.parent = null;
    },
    contains: () => false,
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
  });
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); children = []; },
  });
  return el;
}

const byId = new Map();
const body = fakeElement('body');
body.parent = {};   // connected
globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => fakeElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
  body,
};
globalThis.window = { innerWidth: 1400, innerHeight: 900 };

const CTX = { id: 'ctx1', name: 'Alpha', dirs: ['/repo/alpha'] };
const flush = () => new Promise(r => setTimeout(r, 0));
let importCount = 0;

/**
 * Fresh module + DOM. `state` is what the callbacks read and record: the active project, its
 * slot role, the holder's tab id, the tab elements, and every pin / focus / toast / POST.
 */
async function setup({ ctx = CTX, role = 'orchestrator', holder = null, reply = null } = {}) {
  byId.clear();
  body.children.length = 0;
  const wrapper = fakeElement();
  wrapper.parent = body;
  const toggle = fakeElement('button');
  toggle.id = 'views-toggle';
  const list = fakeElement();
  wrapper.append(toggle, list);
  byId.set('tabs-list-wrapper', wrapper);
  byId.set('tabs-list', list);

  const tabs = new Map();
  for (const id of ['orch', 'zsh', 'next']) tabs.set(id, fakeElement());
  const state = { ctx, role, holder, tabs, pins: [], focused: [], toasts: [], posts: [], reply, windowId: 'win-a', have: new Set(['orch', 'zsh']) };

  globalThis.fetch = async (url, opts = {}) => {
    state.posts.push({ url, body: JSON.parse(opts.body) });
    const r = state.reply || { status: 201, body: { id: 'new1', existing: false } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };

  const mod = await import(`../../public/js/tab-slot.js?t=${++importCount}`);
  mod.init({
    getActiveContext: () => state.ctx,
    slotFor: () => state.role,
    holderFor: () => state.holder,
    getTabEl: (id) => state.tabs.get(id) || null,
    pinFirst: (id) => state.pins.push(id),
    hasTab: (id) => state.have.has(id),
    focusTab: (id) => state.focused.push(id),
    getWindowId: () => state.windowId,
    showToast: (t) => state.toasts.push(t),
  });
  const slot = byId.get('tab-slot') || wrapper.children.find(c => c.id === 'tab-slot');
  return { mod, state, wrapper, list, slot };
}

function rightClick(slot) {
  slot.listeners.contextmenu({ preventDefault() {}, clientX: 10, clientY: 10 });
  return body.children.find(c => c.classList.contains('tab-slot-menu'));
}

test('an empty slot is a dashed outline between the views toggle and the first tab', async () => {
  const { wrapper, list, slot } = await setup();
  assert.deepStrictEqual(wrapper.children.map(c => c.id || 'list'), ['views-toggle', 'tab-slot', 'list'], 'immediately before #tabs-list');
  assert.strictEqual(wrapper.children[2], list);
  assert.ok(!slot.classList.contains('hidden'), 'shown: the slot is on and nothing holds it');
  assert.strictEqual(slot.dataset.role, 'orchestrator');
  assert.strictEqual(slot.children[1].textContent, 'Orchestrator');
  assert.match(slot.title, /right-click/i);
});

test('no slot — no project, or the slot switched off — draws nothing', async () => {
  const { slot, mod, state } = await setup({ ctx: null });
  assert.ok(slot.classList.contains('hidden'));
  state.ctx = CTX;
  state.role = null;
  mod.render();
  assert.ok(slot.classList.contains('hidden'));
  assert.strictEqual(slot.dataset.role, '');
  state.role = 'orchestrator';
  mod.render();
  assert.ok(!slot.classList.contains('hidden'));
});

test('a holder fills the slot: its own tab is pinned first and marked, and the outline goes', async () => {
  const { slot, mod, state } = await setup({ holder: 'orch' });
  assert.ok(slot.classList.contains('hidden'));
  assert.deepStrictEqual(state.pins, ['orch']);
  assert.ok(state.tabs.get('orch').classList.contains('slot-tab'));

  // The slot switched off: the holder is an ordinary tab again.
  state.role = null;
  state.holder = null;
  mod.render();
  assert.ok(!state.tabs.get('orch').classList.contains('slot-tab'), 'the mark is taken back');
  assert.deepStrictEqual(state.pins, ['orch'], 'and nothing is pinned');

  // A different holder (the old one closed, a new one opened) moves the mark.
  state.role = 'orchestrator';
  state.holder = 'orch';
  mod.render();
  state.holder = 'next';
  mod.render();
  assert.ok(!state.tabs.get('orch').classList.contains('slot-tab'));
  assert.ok(state.tabs.get('next').classList.contains('slot-tab'));
});

test('right-click → Open orchestrator asks the server for the project\'s holder', async () => {
  const { slot, state } = await setup();
  const menu = rightClick(slot);
  assert.deepStrictEqual(menu.children.map(i => i.textContent), ['Open orchestrator']);
  menu.children[0].onclick();
  await flush();
  assert.deepStrictEqual(state.posts, [{ url: '/api/project-views/slot', body: { contextId: 'ctx1', slot: 'orchestrator', windowId: 'win-a' } }]);
  assert.ok(!body.children.includes(menu), 'the menu closes');
  assert.deepStrictEqual(state.focused, [], 'a new holder arrives as an open-session; nothing to focus yet');
  assert.deepStrictEqual(state.toasts, []);
});

test('an orchestrator that already runs is focused here, or named as open elsewhere', async () => {
  const { mod, state } = await setup({ reply: { status: 200, body: { id: 'orch', existing: true, windowId: 'win-a' } } });
  await mod.openHolder('orchestrator');
  assert.deepStrictEqual(state.focused, ['orch']);

  state.reply = { status: 200, body: { id: 'far', existing: true, windowId: 'win-b' } };
  await mod.openHolder('orchestrator');
  assert.deepStrictEqual(state.focused, ['orch']);
  assert.deepStrictEqual(state.toasts, ['This project\'s orchestrator is open in another window']);

  // Already starting in this window: its tab is on the way, so say nothing.
  state.reply = { status: 200, body: { id: 'soon', existing: true, windowId: 'win-a' } };
  await mod.openHolder('orchestrator');
  assert.strictEqual(state.toasts.length, 1);
});

test('a refused open is a toast, and a second right-click while one is in flight sends nothing', async () => {
  const { mod, state } = await setup({ reply: { status: 400, body: { error: 'gone' } } });
  await mod.openHolder('orchestrator');
  assert.deepStrictEqual(state.toasts, ['Could not open the orchestrator: gone']);

  state.reply = null;
  const first = mod.openHolder('orchestrator');
  const second = mod.openHolder('orchestrator');
  await Promise.all([first, second]);
  assert.strictEqual(state.posts.length, 2, 'one for the refusal, one for the pair');
});
