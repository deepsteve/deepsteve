// Unit tests for view headers: the first-prompt row on top of the terminal.
//
// Two layers, no daemon and no network:
//   - mods/project-mods/tools.js: a view's `header` is read, cleaned, listed and written back.
//   - public/js/view-header.js: the row and its toggle, against a fake DOM.
// headerFor() itself is in project-views-client.test.js, beside footerFor().
//
// Run: node --test test/unit/view-header.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before tools.js loads: its paths are stateDir()-relative, and stateDir() is $HOME's.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-view-header-home-'));
delete process.env.DEEPSTEVE_HOME;

const views = require('../../mods/project-mods/tools.js');

// ------------------------------------------------------------ tools.js

test('a view\'s header: known fields, each once; listed, and written back only when it has one', () => {
  assert.deepStrictEqual(views.HEADER_FIELDS, ['prompt']);
  assert.deepStrictEqual(views.cleanHeader(['prompt', 'nonsense', 'prompt']), ['prompt']);
  assert.deepStrictEqual(views.cleanHeader('prompt'), [], 'a list, not a string');
  assert.deepStrictEqual(views.cleanHeader(['repo']), [], 'a footer field is not a header field');

  const v = views.normalizeView({ name: 'Prompt', additive: true, match: [{ kinds: ['agent'] }], header: ['prompt'] }, null, 'prompt', { global: true });
  assert.deepStrictEqual(v.header, ['prompt']);
  assert.deepStrictEqual(v.footer, [], 'a header is not a footer');
  assert.deepStrictEqual(views.serializeView(v).header, ['prompt']);
  assert.deepStrictEqual(views.viewManifestOf(v), { name: 'Prompt', match: [{ kinds: ['agent'] }], header: ['prompt'], additive: true },
    'a rename rewrites the file through this, so the header survives it');

  const plain = views.normalizeView({ name: 'Plain' }, null, 'plain', { global: true });
  assert.deepStrictEqual(views.serializeView(plain).header, []);
  assert.ok(!('header' in views.viewManifestOf(plain)), 'the file does not grow an empty list');
});

test('a Custom Label is saved with its session and read back on restore', () => {
  // server.js keeps it on the shell entry. tmux reattach copies a saved record wholesale; the
  // WS restore hand-lists its fields, so it is the one that could drop it, and the next save
  // would then wipe it from state.json.
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const from = src.indexOf('function serializeShellEntry');
  const code = src.slice(from, src.indexOf('function tombstoneSession', from));
  const context = {};
  vm.runInNewContext(`${code}
result = JSON.stringify([serializeShellEntry({ cwd: '/r', customLabel: 'Mine' }), serializeShellEntry({ cwd: '/r' })]);`, context);
  const [labeled, plain] = JSON.parse(context.result);
  assert.strictEqual(labeled.customLabel, 'Mine');
  assert.strictEqual(plain.customLabel, null);
  assert.ok(src.includes('customLabel: restored.customLabel || null'), 'the WS restore shells.set must carry customLabel');
});

// ------------------------------------------------------------ public/js/view-header.js

function fakeEl() {
  const classes = new Set();
  let children = [];
  let text = '';
  const el = {
    attrs: {}, listeners: {}, title: '', type: '', id: '', style: {}, parent: null,
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    get children() { return children; },
    appendChild: (k) => { children.push(k); k.parent = el; return k; },
    append: (...ks) => { children.push(...ks); },
    replaceChildren: () => { children = []; },
    remove: () => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
    contains: (k) => k === el || children.some(c => c.contains && c.contains(k)),
    getBoundingClientRect: () => ({ width: 160, height: 60, left: 0, top: 0, right: 160, bottom: 60 }),
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    addEventListener: (type, fn) => { el.listeners[type] = fn; },
    removeEventListener: (type) => { delete el.listeners[type]; },
  };
  Object.defineProperty(el, 'className', { get: () => [...classes].join(' '), set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); } });
  Object.defineProperty(el, 'textContent', {
    get: () => text + children.map(c => c.textContent).join(''),
    set: (v) => { text = String(v); children = []; },
  });
  return el;
}

function fakeStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

const flush = () => new Promise(r => setTimeout(r, 0));
let imports = 0;

const answer = (id, prompt, supported = true, title = null, customLabel = null) => ({ prompts: { [id]: { prompt, title, supported, customLabel } } });

async function setupHeader({ headerFor = () => ({ slug: 'prompt', name: 'Prompt', fields: ['prompt'] }), data, mode = null } = {}) {
  const byId = new Map([['view-header', fakeEl()], ['terminals', fakeEl()]]);
  byId.get('view-header').classList.add('hidden');
  const body = fakeEl();
  const docListeners = {};
  globalThis.document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => fakeEl(),
    body,
    listeners: docListeners,
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: (type, fn) => { if (docListeners[type] === fn) delete docListeners[type]; },
  };
  globalThis.window = { innerWidth: 1200, innerHeight: 800 };
  globalThis.window.parent = globalThis.window;   // a top-level window, or nsKey prefixes ds1-
  globalThis.localStorage = fakeStorage();
  if (mode) globalThis.localStorage.setItem('deepsteve-view-header-mode', mode);
  const state = { fetches: [], puts: [], active: 't1', slotUp: false, headerFor, hidden: new Set(), data, putAnswer: null };
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'PUT') {
      const sent = JSON.parse(init.body);
      state.puts.push({ url, body: sent });
      const a = state.putAnswer || { ok: true, body: { customLabel: sent.customLabel } };
      return { ok: a.ok, status: a.ok ? 200 : 500, json: async () => a.body };
    }
    state.fetches.push(url);
    const d = typeof state.data === 'function' ? state.data(url) : state.data;
    return { ok: d !== undefined, json: async () => d };
  };
  const mod = await import(`../../public/js/view-header.js?t=${++imports}`);
  mod.init({
    getActiveTabId: () => state.active,
    headerFor: (id) => state.headerFor(id),
    isViewSlotUp: () => state.slotUp,
    isTabHidden: (id) => state.hidden.has(id),
  });
  live.push({ mod, state });
  return { mod, state, el: byId.get('view-header'), terminals: byId.get('terminals'), body };
}

// A tab with no title yet is asked again every POLL_MS for as long as it is on screen, so each
// test takes its rows down when it ends, or their timers keep the run alive.
const live = [];
afterEach(() => {
  for (const { mod, state } of live.splice(0)) { state.active = null; mod.render(); }
});

const toggleOf = (el) => el.children[0];
const textOf = (el) => el.children[1];
// The toggle draws every label and marks the one shown.
const labelsOf = (el) => toggleOf(el).children[1].children;
const labelOf = (el) => labelsOf(el).find(l => l.classList.contains('vh-current')).textContent;
const click = (el) => toggleOf(el).listeners.click();

test('the header row: placeholder at once, then the first line until Claude names the conversation', async () => {
  const { el, state, terminals } = await setupHeader({ data: answer('t1', 'Make the tasks board show live terminals') });
  assert.ok(!el.classList.contains('hidden'), 'shown before the answer, so the fit already has it');
  assert.ok(terminals.classList.contains('view-header-open'));
  assert.ok(terminals.classList.contains('view-header-collapsed'), 'one line');
  assert.strictEqual(textOf(el).textContent, '…');
  assert.deepStrictEqual(state.fetches, ['/api/project-views/cards?ids=t1']);

  await flush(); await flush();
  assert.strictEqual(toggleOf(el).className, 'vh-toggle');
  assert.strictEqual(toggleOf(el).attrs['aria-expanded'], 'false');
  assert.strictEqual(labelOf(el), 'First line', 'no title yet: the first line stands in for the summary');
  assert.strictEqual(textOf(el).className, 'vh-prompt');
  assert.strictEqual(textOf(el).textContent, 'Make the tasks board show live terminals');
});

test('Summary is the default: Claude Code\'s title, on one line', async () => {
  const { el, terminals } = await setupHeader({ data: answer('t1', 'I built a tasks view, I am not sure…', true, 'Tasks view vs app design') });
  await flush(); await flush();
  assert.ok(terminals.classList.contains('view-header-collapsed'));
  assert.strictEqual(labelOf(el), 'Summary');
  assert.strictEqual(toggleOf(el).textContent.charAt(0), '▸');
  assert.ok(textOf(el).classList.contains('vh-summary'));
  assert.strictEqual(textOf(el).textContent, 'Tasks view vs app design');
  assert.deepStrictEqual(labelsOf(el).map(l => l.textContent), ['Custom Label', 'Summary', 'First line', 'First prompt'],
    'every label is drawn, so the button keeps one width, labeled tab or not');
});

test('the toggle steps Summary → First line → First prompt → Summary, and the choice is kept', async () => {
  const { el, mod, terminals } = await setupHeader({ data: answer('t1', 'Fix the footer', true, 'Footer fix') });
  await flush(); await flush();
  assert.strictEqual(mod.chosenMode(), 'summary');
  let prevented = false;
  toggleOf(el).listeners.mousedown({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'a click leaves the keyboard in the terminal');
  assert.strictEqual(toggleOf(el).title, 'Header mode', 'names the control; the label already says which mode is on');

  click(el);
  assert.strictEqual(labelOf(el), 'First line');
  assert.ok(terminals.classList.contains('view-header-collapsed'));
  assert.ok(!textOf(el).classList.contains('vh-summary'));
  assert.strictEqual(textOf(el).textContent, 'Fix the footer');
  assert.strictEqual(localStorage.getItem('deepsteve-view-header-mode'), 'line', 'browser-wide');

  click(el);
  assert.strictEqual(labelOf(el), 'First prompt');
  assert.ok(!terminals.classList.contains('view-header-collapsed'), 'three lines');
  assert.strictEqual(toggleOf(el).attrs['aria-expanded'], 'true');
  assert.strictEqual(toggleOf(el).textContent.charAt(0), '▾');
  assert.strictEqual(textOf(el).textContent, 'Fix the footer');
  assert.strictEqual(mod.chosenMode(), 'full');

  click(el);
  assert.strictEqual(labelOf(el), 'Summary');
  assert.ok(terminals.classList.contains('view-header-collapsed'));
  assert.strictEqual(textOf(el).textContent, 'Footer fix');
  assert.strictEqual(localStorage.getItem('deepsteve-view-header-mode'), null, 'the default is stored as nothing');
});

test('with no title the toggle skips Summary', async () => {
  const { el, mod } = await setupHeader({ data: answer('t1', 'Fix the footer') });
  await flush(); await flush();
  assert.strictEqual(labelOf(el), 'First line');
  click(el);
  assert.strictEqual(labelOf(el), 'First prompt');
  assert.strictEqual(toggleOf(el).title, 'Header mode', 'the same in every mode');
  click(el);
  assert.strictEqual(labelOf(el), 'First line');
  assert.strictEqual(mod.chosenMode(), 'line');
});

test('the mode survives a reload, and an unknown stored value means Summary', async () => {
  const full = await setupHeader({ data: answer('t1', 'x', true, 'X'), mode: 'full' });
  await flush(); await flush();
  assert.ok(!full.terminals.classList.contains('view-header-collapsed'));
  assert.strictEqual(labelOf(full.el), 'First prompt');

  const junk = await setupHeader({ data: answer('t1', 'x', true, 'X'), mode: 'sideways' });
  await flush(); await flush();
  assert.strictEqual(labelOf(junk.el), 'Summary');
});

test('a session asked nothing yet says so, and is asked again while it is on screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // The fetch's promise chain needs microtask turns, which mocked timers leave alone.
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const { el, state } = await setupHeader({ data: answer('t1', null) });
  await settle();
  assert.strictEqual(textOf(el).textContent, 'No prompt yet');
  assert.ok(textOf(el).classList.contains('vh-muted'));
  assert.strictEqual(state.fetches.length, 1);

  state.data = answer('t1', 'Now it has one');
  t.mock.timers.tick(5001);
  assert.strictEqual(state.fetches.length, 2, 'asked again after POLL_MS');
  await settle();
  assert.strictEqual(textOf(el).textContent, 'Now it has one');
  assert.strictEqual(labelOf(el), 'First line');

  state.data = answer('t1', 'Now it has one', true, 'A title');
  t.mock.timers.tick(5001);
  assert.strictEqual(state.fetches.length, 3, 'still asked while the title is missing');
  await settle();
  assert.strictEqual(labelOf(el), 'Summary', 'the title replaces the first line when it arrives');
  assert.strictEqual(textOf(el).textContent, 'A title');
  t.mock.timers.tick(60000);
  assert.strictEqual(state.fetches.length, 3, 'a found prompt and title are not polled');
});

test('a row stuck on an old answer while its tab is on screen says so in the daemon log, once a minute', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const beacon = await import('../../public/js/client-log.js');
  const sent = [];
  beacon.attachClientLogSender(() => ({ readyState: 1, send: (m) => sent.push(...JSON.parse(m).entries) }), 'w');
  const lines = () => { beacon.flushClientLog(); return sent.filter(e => e.kind === 'view-header').map(e => e.msg); };
  sent.length = 0;

  const { el, mod, state } = await setupHeader({ data: (url) => answer(url.split('=')[1], null) });
  await settle();
  assert.strictEqual(textOf(el).textContent, 'No prompt yet');

  // Switching back to a tab whose answer is old is not a missed poll: it was not on screen.
  state.active = 't2';
  mod.render();
  await settle();
  t.mock.timers.setTime(Date.now() + 16000);
  state.active = 't1';
  mod.render();
  assert.deepStrictEqual(lines(), []);
  await settle();

  // On screen since its answer, and the poll never ran: the clock moves, no timer fires.
  t.mock.timers.setTime(Date.now() + 16000);
  mod.render('click');
  assert.deepStrictEqual(lines(), ['tab t1: answer 16s old, asked every 5s; this pass from click; poll armed 16s ago; '
    + 'nothing in flight; has no prompt, no title']);
  await settle();
  t.mock.timers.setTime(Date.now() + 16000);
  mod.render('click');
  assert.strictEqual(lines().length, 1, 'once a minute per tab');
});

// ------------------------------------------------------------ Custom Label

const menuOf = (body) => body.children.find(c => c.id === 'view-header-menu') || null;
const rowsOf = (menu) => menu.children.map(r => r.textContent);
const rightClick = (el) => {
  let prevented = false;
  el.listeners.contextmenu({ preventDefault: () => { prevented = true; }, clientX: 300, clientY: 20 });
  return prevented;
};
const pick = (menu, text) => menu.children.find(r => r.textContent === text).listeners.click({ stopPropagation() {} });

test('a tab with a Custom Label shows it first, and the toggle steps on through the other modes and back', async () => {
  const { el, mod, terminals } = await setupHeader({ data: answer('t1', 'Fix the footer', true, 'Footer fix', 'The footer, again') });
  await flush(); await flush();
  assert.strictEqual(labelOf(el), 'Custom Label');
  assert.ok(textOf(el).classList.contains('vh-summary'));
  assert.ok(terminals.classList.contains('view-header-collapsed'), 'one line');
  assert.strictEqual(textOf(el).textContent, 'The footer, again');

  click(el);
  assert.strictEqual(labelOf(el), 'Summary');
  assert.strictEqual(textOf(el).textContent, 'Footer fix');
  click(el);
  assert.strictEqual(labelOf(el), 'First line');
  click(el);
  assert.strictEqual(labelOf(el), 'First prompt');
  assert.strictEqual(mod.chosenMode(), 'full', 'the other modes are still the browser-wide preference');
  click(el);
  assert.strictEqual(labelOf(el), 'Custom Label', 'and round again to the Custom Label');
  assert.strictEqual(mod.chosenMode(), 'full', 'which is never the preference: it belongs to one tab');
  assert.strictEqual(localStorage.getItem('deepsteve-view-header-mode'), 'full');
});

test('leaving a tab and coming back shows its Custom Label again, whatever the preference', async () => {
  const labels = { t1: 'Mine', t2: null };
  const { el, mod, state } = await setupHeader({ data: (url) => { const id = url.split('=')[1]; return answer(id, 'p ' + id, true, 'T ' + id, labels[id]); } });
  await flush(); await flush();
  assert.strictEqual(textOf(el).textContent, 'Mine');
  click(el);   // → Summary, for this visit
  click(el);   // → First line, which is now the preference
  assert.strictEqual(labelOf(el), 'First line');

  state.active = 't2';
  mod.render();
  await flush(); await flush();
  assert.strictEqual(labelOf(el), 'First line', 'a tab with no Custom Label follows the preference');
  assert.ok(!labelsOf(el).some(l => l.classList.contains('vh-current') && l.textContent === 'Custom Label'));
  click(el);
  assert.strictEqual(labelOf(el), 'First prompt');
  click(el);
  assert.strictEqual(labelOf(el), 'Summary', 'no Custom Label: the toggle skips it');

  state.active = 't1';
  mod.render();
  assert.strictEqual(labelOf(el), 'Custom Label', 'back at the tab: its Custom Label, at once, from memory');
  assert.strictEqual(textOf(el).textContent, 'Mine');
});

test('right-clicking the row sets, edits and clears the Custom Label through the server', async () => {
  const { el, state, body } = await setupHeader({ data: answer('t1', 'Fix the footer', true, 'Footer fix') });
  await flush(); await flush();
  assert.strictEqual(labelOf(el), 'Summary');

  let mousedownPrevented = false;
  el.listeners.mousedown({ button: 2, preventDefault: () => { mousedownPrevented = true; } });
  assert.ok(mousedownPrevented, 'a right-click leaves the keyboard in the terminal');
  assert.ok(rightClick(el), 'the browser\'s own menu is suppressed');
  let menu = menuOf(body);
  assert.ok(menu, 'the menu opens');
  assert.deepStrictEqual(rowsOf(menu), ['Custom Label…'], 'nothing to clear yet');
  assert.strictEqual(menu.style.left, '300px');

  const asked = [];
  globalThis.prompt = (msg, def) => { asked.push([msg, def]); return '  Footer, take two  '; };
  pick(menu, 'Custom Label…');
  assert.strictEqual(menuOf(body), null, 'picking closes the menu');
  assert.deepStrictEqual(asked, [['Custom Label:', '']]);
  await flush(); await flush();
  assert.deepStrictEqual(state.puts, [{ url: '/api/project-views/custom-label/t1', body: { customLabel: 'Footer, take two' } }]);
  assert.strictEqual(labelOf(el), 'Custom Label', 'shown as soon as it is saved');
  assert.strictEqual(textOf(el).textContent, 'Footer, take two');

  rightClick(el);
  menu = menuOf(body);
  assert.deepStrictEqual(rowsOf(menu), ['Custom Label…', 'Clear Custom Label']);
  globalThis.prompt = (msg, def) => { asked.push([msg, def]); return null; };
  pick(menu, 'Custom Label…');
  assert.deepStrictEqual(asked[1], ['Custom Label:', 'Footer, take two'], 'editing starts from the current one');
  await flush();
  assert.strictEqual(state.puts.length, 1, 'Cancel saves nothing');

  rightClick(el);
  pick(menuOf(body), 'Clear Custom Label');
  await flush(); await flush();
  assert.deepStrictEqual(state.puts[1].body, { customLabel: null });
  assert.strictEqual(labelOf(el), 'Summary', 'back to the preference');
  delete globalThis.prompt;
});

test('a Custom Label the server refuses is not shown, and the user is told', async () => {
  const { el, state, body } = await setupHeader({ data: answer('t1', 'Fix the footer', true, 'Footer fix') });
  await flush(); await flush();
  state.putAnswer = { ok: false, body: { error: 'Session not found' } };
  const alerts = [];
  globalThis.alert = (m) => alerts.push(m);
  globalThis.prompt = () => 'Nope';
  rightClick(el);
  pick(menuOf(body), 'Custom Label…');
  await flush(); await flush();
  assert.deepStrictEqual(alerts, ['The Custom Label was not saved: Session not found']);
  assert.strictEqual(labelOf(el), 'Summary');
  delete globalThis.prompt;
  delete globalThis.alert;
});

test('the menu closes on a click outside it, and on Escape', async () => {
  const { el, body } = await setupHeader({ data: answer('t1', 'p', true, 'T') });
  await flush(); await flush();
  rightClick(el);
  const menu = menuOf(body);
  document.listeners.mousedown({ target: menu.children[0] });
  assert.ok(menuOf(body), 'a press inside the menu is the menu\'s');
  document.listeners.mousedown({ target: el });
  assert.strictEqual(menuOf(body), null);
  assert.ok(!document.listeners.mousedown, 'and stops listening');

  rightClick(el);
  document.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(menuOf(body), null);
});

test('a Custom Label set in another window reaches this one', async () => {
  const { el, mod } = await setupHeader({ data: answer('t1', 'p', true, 'T') });
  await flush(); await flush();
  click(el);   // → First line
  mod.onCustomLabel('t1', 'From the other window');
  assert.strictEqual(labelOf(el), 'Custom Label', 'a new Custom Label is shown, even mid-visit');
  assert.strictEqual(textOf(el).textContent, 'From the other window');
  mod.onCustomLabel('t1', null);
  assert.strictEqual(labelOf(el), 'First line');
  mod.onCustomLabel('elsewhere', 'x');
  assert.strictEqual(labelOf(el), 'First line', 'another tab\'s is no business of this row');
});

// ------------------------------------------------------------ the title, 10s after the first prompt

test('10s after a tab\'s first prompt the row asks again on its own timer, so a dead poll cannot hold it on the first line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const beacon = await import('../../public/js/client-log.js');
  const sent = [];
  beacon.attachClientLogSender(() => ({ readyState: 1, send: (m) => sent.push(...JSON.parse(m).entries) }), 'w');
  const lines = () => { beacon.flushClientLog(); return sent.filter(e => e.kind === 'view-header').map(e => e.msg); };
  sent.length = 0;

  const { el, mod, state } = await setupHeader({ data: answer('t1', null) });
  await settle();
  state.data = answer('t1', 'Fix the footer');
  t.mock.timers.tick(5001);
  await settle();
  assert.strictEqual(labelOf(el), 'First line');
  const asked = state.fetches.length;

  // A pass that throws before re-arming the poll — the one way the poll can stop on its own.
  const headerFor = state.headerFor;
  state.headerFor = () => { throw new Error('mid-update'); };
  assert.throws(() => mod.render());
  state.headerFor = headerFor;
  state.data = answer('t1', 'Fix the footer', true, 'Footer fix');
  t.mock.timers.tick(9000);
  assert.strictEqual(state.fetches.length, asked, 'the poll is dead');

  t.mock.timers.tick(1001);
  assert.strictEqual(state.fetches.length, asked + 1, 'the title came due, so it asked');
  await settle();
  assert.strictEqual(labelOf(el), 'Summary', 'and the summary replaced the first line without a tab switch');
  assert.strictEqual(textOf(el).textContent, 'Footer fix');
  assert.deepStrictEqual(lines(), ['tab t1: no answer in the 10s since its first prompt, asked every 5s; poll not armed; nothing in flight; asking now']);
});

test('with the poll working, the title check stays quiet and is not repeated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const beacon = await import('../../public/js/client-log.js');
  const sent = [];
  beacon.attachClientLogSender(() => ({ readyState: 1, send: (m) => sent.push(...JSON.parse(m).entries) }), 'w');
  sent.length = 0;
  const { el, state } = await setupHeader({ data: answer('t1', 'Fix the footer') });
  await settle();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(5001); await settle(); }
  beacon.flushClientLog();
  assert.deepStrictEqual(sent.filter(e => e.kind === 'view-header'), [], 'the poll brought answers, so nothing to report');
  assert.strictEqual(labelOf(el), 'First line', 'no title yet: still polling');
  state.data = answer('t1', 'Fix the footer', true, 'Footer fix');
  t.mock.timers.tick(5001);
  await settle();
  assert.strictEqual(labelOf(el), 'Summary');
});

test('no row for an agent whose transcript we cannot read, or a tab that is not a session', async () => {
  const { el, state, mod, terminals } = await setupHeader({ data: answer('t1', null, false) });
  assert.ok(!el.classList.contains('hidden'), 'held open while asking');
  await flush(); await flush();
  assert.ok(el.classList.contains('hidden'));
  assert.ok(!terminals.classList.contains('view-header-open'), 'the terminal gets the space back');
  mod.render();
  assert.strictEqual(state.fetches.length, 1, 'not asked again on every pass');

  const failed = await setupHeader({ data: undefined });
  await flush(); await flush();
  assert.ok(failed.el.classList.contains('hidden'), 'a failed request is nothing to show');
});

test('the header follows the tab: none outside a header view, while a view is up, or behind an empty project', async () => {
  const { el, state, mod, terminals } = await setupHeader({ headerFor: () => null, data: (url) => answer(url.split('=')[1], 'p') });
  assert.ok(el.classList.contains('hidden'));
  assert.deepStrictEqual(state.fetches, [], 'nothing to show, nothing fetched');

  state.headerFor = () => ({ slug: 'prompt', fields: ['prompt'] });
  mod.render();
  await flush(); await flush();
  assert.ok(!el.classList.contains('hidden'));
  state.slotUp = true;
  mod.render();
  assert.ok(el.classList.contains('hidden'), 'a fullscreen view or superview is up');
  assert.ok(!terminals.classList.contains('view-header-open'));
  state.slotUp = false;
  state.hidden.add('t1');
  mod.render();
  assert.ok(el.classList.contains('hidden'), 'the active tab is behind an empty project');
  state.hidden.delete('t1');
  mod.render();
  assert.ok(!el.classList.contains('hidden'));
  assert.strictEqual(state.fetches.length, 1, 'switching back repaints from memory');

  state.active = 't2';
  mod.render();
  await flush(); await flush();
  assert.deepStrictEqual(state.fetches, ['/api/project-views/cards?ids=t1', '/api/project-views/cards?ids=t2']);
  assert.strictEqual(textOf(el).textContent, 'p');
});

test('view-header.js stays out of app.js and project-views.js; styles.css owns the offset', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');
  const src = read('js/view-header.js');
  assert.ok(!/from '\.\/app\.js'/.test(src));
  assert.ok(!/from '\.\/project-views\.js'/.test(src), 'app.js injects headerFor');
  // Every terminal container, and the probe that sizes a new one, starts below the row.
  const css = read('css/styles.css');
  assert.match(css, /#terminals > \.terminal-container \{ top: var\(--ds-view-header-h\); \}/);
  assert.match(read('js/terminal.js'), /top:var\(--ds-view-header-h, 0px\)/);
  // Collapsed, the prompt is one line cut off with an ellipsis, not a scrolling box.
  assert.match(css, /#terminals\.view-header-collapsed > #view-header \.vh-prompt \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  // The labels share one grid cell and only the current one shows, so the button keeps its width.
  assert.match(css, /#view-header \.vh-label \{ grid-area: 1 \/ 1;/);
  assert.match(css, /#view-header \.vh-label:not\(\.vh-current\) \{ visibility: hidden; \}/);
  assert.match(read('index.html'), /<div id="terminals">\s*(<!--[\s\S]*?-->\s*)?<div id="view-header" class="hidden"/);
});
