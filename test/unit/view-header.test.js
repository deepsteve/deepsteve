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

// ------------------------------------------------------------ public/js/view-header.js

function fakeEl() {
  const classes = new Set();
  let children = [];
  let text = '';
  const el = {
    attrs: {}, listeners: {}, title: '', type: '',
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); },
      add: (c) => classes.add(c),
    },
    get children() { return children; },
    appendChild: (k) => { children.push(k); return k; },
    append: (...ks) => { children.push(...ks); },
    replaceChildren: () => { children = []; },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    addEventListener: (type, fn) => { el.listeners[type] = fn; },
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

const answer = (id, prompt, supported = true, title = null) => ({ prompts: { [id]: { prompt, title, supported } } });

async function setupHeader({ headerFor = () => ({ slug: 'prompt', name: 'Prompt', fields: ['prompt'] }), data, mode = null } = {}) {
  const byId = new Map([['view-header', fakeEl()], ['terminals', fakeEl()]]);
  byId.get('view-header').classList.add('hidden');
  globalThis.document = { getElementById: (id) => byId.get(id) || null, createElement: () => fakeEl() };
  globalThis.localStorage = fakeStorage();
  if (mode) globalThis.localStorage.setItem('deepsteve-view-header-mode', mode);
  const state = { fetches: [], active: 't1', slotUp: false, headerFor, hidden: new Set(), data };
  globalThis.fetch = async (url) => {
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
  return { mod, state, el: byId.get('view-header'), terminals: byId.get('terminals') };
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
  assert.deepStrictEqual(labelsOf(el).map(l => l.textContent), ['Summary', 'First line', 'First prompt'],
    'every label is drawn, so the button keeps one width');
});

test('the toggle steps Summary → First line → First prompt → Summary, and the choice is kept', async () => {
  const { el, mod, terminals } = await setupHeader({ data: answer('t1', 'Fix the footer', true, 'Footer fix') });
  await flush(); await flush();
  assert.strictEqual(mod.chosenMode(), 'summary');
  let prevented = false;
  toggleOf(el).listeners.mousedown({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'a click leaves the keyboard in the terminal');
  assert.strictEqual(toggleOf(el).title, 'Show the first line of the first prompt', 'says what a click does next');

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
  assert.strictEqual(toggleOf(el).title, 'Show the first line of the first prompt');
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
