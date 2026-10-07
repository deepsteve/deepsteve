// Headless unit test for public/js/project-views.js — the client half of project views
// (#726): which views a project has, which tabs are in one, how a tab gets filed, and the
// toggle / bar chrome.
//
// No browser: stub the globals the module touches (window/document/storage/fetch/prompt)
// BEFORE importing it, then drive the exported API the way app.js and context-views.js do.
// window.parent = window keeps storage-namespace.js at depth 0. Each test re-imports the
// module with a unique ?query so its module-level state starts fresh.
//
// Run: node --test test/unit/project-views-client.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- fake globals

// Separate maps, so a test can tell which storage a key went to.
function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
globalThis.sessionStorage = fakeStorage();
globalThis.localStorage = fakeStorage();

function fakeElement(tag = 'div') {
  const classes = new Set();
  let children = [];
  let text = '';
  const el = {
    tag, id: '', title: '', tabIndex: 0,
    style: {}, dataset: {}, attrs: {}, listeners: {},
    get children() { return children; },
    get firstChild() { return children[0] || null; },
    isConnected: true,
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
    append: (...kids) => { for (const k of kids) { k.parent = el; children.push(k); } },
    appendChild: (child) => { child.parent = el; children.push(child); return child; },
    insertBefore: (child, ref) => {
      const i = ref ? children.indexOf(ref) : -1;
      children.splice(i === -1 ? children.length : i, 0, child);
      child.parent = el;
      return child;
    },
    replaceChildren: (...kids) => { children = []; for (const k of kids) el.appendChild(k); },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    getAttribute: (k) => el.attrs[k] ?? null,
    getBoundingClientRect: () => ({ width: 100, height: 60, right: 100, bottom: 60, left: 0, top: 0 }),
    remove: () => {
      const p = el.parent;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
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
globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => fakeElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild: () => {} },
};
globalThis.window = { innerWidth: 1400, innerHeight: 900 };
globalThis.window.parent = globalThis.window;

// --------------------------------------------------------------------- harness

const REPO_A = '/repo/alpha';
const REPO_B = '/repo/beta';
const SITE = '/repo/site';

const CTX_A = { id: 'ctxa', name: 'Alpha', dirs: [REPO_A] };
// A project spanning two repos — both define `marketing`, which must merge into one view.
const CTX_AS = { id: 'ctxas', name: 'Alpha + site', dirs: [REPO_A, SITE] };

const V_MKT_A = { id: 'v1', slug: 'marketing', project: REPO_A, name: 'Marketing', icon: '📣', order: 0, match: [{ names: ['marketing', 'seo'] }] };
const V_MKT_SITE = { id: 'v2', slug: 'marketing', project: SITE, name: 'Site marketing', icon: '', order: 5, match: [{ paths: [''] }] };
const V_ANALYTICS = { id: 'v3', slug: 'analytics', project: REPO_A, name: 'Analytics', icon: '', order: 1, match: [{ kinds: ['display-tab'], paths: ['reports'] }] };
const V_MANUAL = { id: 'v4', slug: 'launch', project: REPO_A, name: 'Launch', icon: '', order: 2, match: [] };
const V_BETA = { id: 'v5', slug: 'ops', project: REPO_B, name: 'Ops', icon: '', order: 0, match: [] };

let importCount = 0;
const flush = () => new Promise(r => setTimeout(r, 0));

/**
 * Fresh module + app.js-side wiring. `tabs` is id → {cwd, name, kind, views}; the callbacks
 * record what the module asked app.js to do.
 */
async function setup({ views = [V_MKT_A, V_MKT_SITE, V_ANALYTICS, V_MANUAL, V_BETA], ctx = CTX_A, tabs = {}, suspended = false, contexts = [CTX_A, CTX_AS] } = {}) {
  byId.clear();
  sessionStorage.map.clear();
  localStorage.map.clear();

  const wrapper = fakeElement();
  const list = fakeElement();
  wrapper.appendChild(list);
  byId.set('tabs-list-wrapper', wrapper);
  byId.set('tabs-list', list);
  const bar = fakeElement();
  bar.classList.add('hidden');
  byId.set('views-bar', bar);
  const appMain = fakeElement();
  byId.set('app-main', appMain);

  const state = { ctx, tabs, suspended, filterCalls: 0, setViews: [], toasts: [], posts: [], serverViews: views };
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      state.posts.push({ url, body });
      const v = { id: 'new1', slug: body.name.toLowerCase(), project: REPO_A, name: body.name, icon: '', order: 0, match: [] };
      return { ok: true, status: 201, json: async () => ({ view: v, path: `.deepsteve/views/${v.slug}.json` }) };
    }
    return { ok: true, status: 200, json: async () => ({ views: state.serverViews }) };
  };

  const mod = await import(`../../public/js/project-views.js?t=${++importCount}`);
  mod.init({
    getActiveContext: () => state.ctx,
    contextsForCwd: (cwd) => contexts.filter(c => c.dirs.some(d => cwd === d || (cwd || '').startsWith(d + '/'))),
    getTabInfo: (id) => state.tabs[id] || null,
    setTabViews: (id, v) => { state.setViews.push([id, v]); if (state.tabs[id]) state.tabs[id].views = v; },
    getActiveTabCwd: () => REPO_A,
    applyFilter: () => { state.filterCalls++; mod.render(); },
    isSuspended: () => state.suspended,
    showToast: (t) => state.toasts.push(t),
  });
  await flush();
  return { mod, state, wrapper, list, bar, appMain };
}

// ------------------------------------------------------------- scoping / merge

test('a project sees its repos\' views, same-slug views merge, other projects\' stay out', async () => {
  const { mod } = await setup();
  assert.deepStrictEqual(mod.viewsForContext(CTX_A).map(v => v.slug), ['marketing', 'analytics', 'launch']);

  const merged = mod.viewsForContext(CTX_AS).find(v => v.slug === 'marketing');
  assert.deepStrictEqual(merged.ids, ['v1', 'v2'], 'one Marketing, both definitions');
  assert.strictEqual(merged.name, 'Marketing', 'name from the first by the server\'s sort');
  assert.strictEqual(merged.rules.length, 2, 'rules unioned');
  assert.deepStrictEqual(merged.rules.map(r => r.root), [REPO_A, SITE], 'each rule keeps the repo its paths are relative to');

  assert.deepStrictEqual(mod.viewsForContext(null), []);
});

// ------------------------------------------------------------------ membership

test('rules: fields AND within a rule, rules OR across, worktrees count as their repo', async () => {
  const { mod } = await setup();
  const analytics = mod.viewsForContext(CTX_A).find(v => v.slug === 'analytics');
  const inA = (info) => mod.memberOf(info, analytics);
  assert.ok(inA({ cwd: `${REPO_A}/reports`, name: 'x', kind: 'display-tab' }));
  assert.ok(inA({ cwd: `${REPO_A}/reports/q3`, name: 'x', kind: 'display-tab' }), 'nested folder');
  assert.ok(!inA({ cwd: `${REPO_A}/reports`, name: 'x', kind: 'agent' }), 'kind fails → rule fails');
  assert.ok(!inA({ cwd: `${REPO_A}/src`, name: 'x', kind: 'display-tab' }), 'path fails → rule fails');
  assert.ok(!inA({ cwd: `${REPO_A}/reportsX`, name: 'x', kind: 'display-tab' }), 'a prefix is not a folder');
  assert.ok(inA({ cwd: `${REPO_A}/.claude/worktrees/github-issue-9/reports`, name: 'x', kind: 'display-tab' }), 'a worktree is its repo');

  const mkt = mod.viewsForContext(CTX_AS).find(v => v.slug === 'marketing');
  assert.ok(mod.memberOf({ cwd: `${REPO_A}/src`, name: '#12 SEO audit', kind: 'agent' }, mkt), 'name rule, case-insensitive');
  assert.ok(mod.memberOf({ cwd: `${SITE}/blog`, name: 'Claude', kind: 'agent' }, mkt), '"." path rule from the other repo');
  assert.ok(!mod.memberOf({ cwd: `${REPO_A}/src`, name: 'Claude', kind: 'agent' }, mkt));
  assert.ok(!mod.memberOf({ cwd: null, name: 'Claude', kind: 'mod-tab' }, mkt), 'no cwd: a path rule cannot match');
});

test('a filing wins over the rules either way', async () => {
  const { mod } = await setup();
  const mkt = mod.viewsForContext(CTX_A).find(v => v.slug === 'marketing');
  assert.ok(mod.memberOf({ cwd: REPO_A, name: 'Claude', views: { marketing: true } }, mkt), 'filed in');
  assert.ok(!mod.memberOf({ cwd: REPO_A, name: 'marketing copy', views: { marketing: false } }, mkt), 'taken out despite the rule');
  const launch = mod.viewsForContext(CTX_A).find(v => v.slug === 'launch');
  assert.ok(!mod.memberOf({ cwd: REPO_A, name: 'Claude' }, launch), 'a rule-less view holds only what is filed');
  assert.ok(mod.memberOf({ cwd: null, name: 'Tower', kind: 'mod-tab', views: { launch: true } }, launch), 'a mod tab can be filed');
});

test('tabInView: nothing is filtered with no project, in All, for a placeholder, or while suspended', async () => {
  const { mod, state } = await setup({ tabs: { t1: { cwd: REPO_A, name: 'Claude', kind: 'agent' }, t2: { cwd: REPO_A, name: 'SEO', kind: 'agent' } } });
  assert.ok(mod.tabInView('t1', null));
  assert.ok(mod.tabInView('t1', CTX_A), 'All is the default');
  mod.selectView('marketing');
  assert.ok(!mod.tabInView('t1', CTX_A));
  assert.ok(mod.tabInView('t2', CTX_A));
  assert.ok(mod.tabInView('placeholder', CTX_A), 'no info yet → visible until it connects');
  state.suspended = true;
  assert.ok(mod.tabInView('t1', CTX_A), 'Decision Tab mode sets views aside');
});

// --------------------------------------------------------------------- storage

test('the selected view is per-window sessionStorage, per project; expanded is a localStorage preference', async () => {
  const { mod } = await setup();
  mod.selectView('analytics');
  assert.deepStrictEqual(JSON.parse(sessionStorage.getItem('deepsteve-project-view')), { ctxa: 'analytics' });
  assert.strictEqual(localStorage.getItem('deepsteve-project-view'), null);
  assert.strictEqual(mod.selectedSlug(CTX_A), 'analytics');
  assert.strictEqual(mod.viewKey(CTX_A), 'analytics');
  assert.strictEqual(mod.selectedSlug(CTX_AS), 'all', 'another project keeps its own (none)');

  assert.strictEqual(mod.isExpanded(), false, 'collapsed by default');
  mod.toggleExpanded();
  assert.strictEqual(localStorage.getItem('deepsteve-project-views-bar'), '1');
  assert.strictEqual(sessionStorage.getItem('deepsteve-project-views-bar'), null);

  mod.selectView('all');
  assert.deepStrictEqual(JSON.parse(sessionStorage.getItem('deepsteve-project-view')), {});
  assert.strictEqual(mod.viewKey(CTX_A), '', 'All keeps the bare project key');
});

test('a selection whose view disappears falls back to All, and refresh() drops it', async () => {
  const { mod, state } = await setup();
  mod.selectView('launch');
  state.serverViews = [V_MKT_A];
  await mod.refresh();
  assert.strictEqual(mod.selectedSlug(CTX_A), 'all');
  assert.deepStrictEqual(JSON.parse(sessionStorage.getItem('deepsteve-project-view')), {});
});

// ----------------------------------------------------------------------- chrome

test('the toggle is the first child of #tabs-list-wrapper, so it stays against the tabs', async () => {
  const { wrapper, list } = await setup();
  const toggle = wrapper.firstChild;
  assert.strictEqual(toggle.id, 'views-toggle');
  assert.strictEqual(wrapper.children[1], list, 'directly before the tab list');
  // project-mods.js inserts its buttons before the WRAPPER, never inside it.
  assert.ok(!toggle.classList.contains('hidden'));
});

test('the toggle shows for any selected project — even with no views yet (manual mode) — and hides otherwise', async () => {
  const empty = await setup({ views: [] });
  assert.ok(!empty.wrapper.firstChild.classList.contains('hidden'), 'the way to "+ New view" for a first view');

  const none = await setup({ ctx: null });
  assert.ok(none.wrapper.firstChild.classList.contains('hidden'), 'rail "All": no views');

  const susp = await setup({ suspended: true });
  assert.ok(susp.wrapper.firstChild.classList.contains('hidden'), 'Decision Tab mode');
});

test('expanding shows the bar: All, each view, then "+ New view"; the selected one is active', async () => {
  const { mod, bar, appMain, wrapper } = await setup();
  assert.ok(bar.classList.contains('hidden'));
  mod.toggleExpanded(true);
  assert.ok(!bar.classList.contains('hidden'));
  assert.ok(appMain.classList.contains('views-bar-open'));
  assert.deepStrictEqual(bar.children.map(b => b.dataset.view ?? '+'), ['all', 'marketing', 'analytics', 'launch', '+']);
  assert.ok(bar.children[0].classList.contains('active'));
  bar.children[2].listeners.click();
  assert.ok(bar.children[2].classList.contains('active'), 'clicking a view selects it');
  assert.strictEqual(wrapper.firstChild.children[1].textContent, 'Analytics', 'the toggle names the view');
  assert.ok(wrapper.firstChild.classList.contains('filtering'));
});

test('render() never asks for a filter pass (it is called FROM one)', async () => {
  const { mod, state } = await setup();
  const before = state.filterCalls;
  mod.render();
  mod.toggleExpanded(true);
  mod.revealTabView('nope', CTX_A);
  assert.strictEqual(state.filterCalls, before);
  mod.selectView('marketing');
  assert.strictEqual(state.filterCalls, before + 1, 'selecting a view is one pass');
});

// --------------------------------------------------------------------- filing

test('activeJoins files a browser-opened tab into the selected view; All files it nowhere', async () => {
  const { mod, state } = await setup();
  assert.strictEqual(mod.activeJoins(), undefined);
  mod.selectView('launch');
  assert.deepStrictEqual(mod.activeJoins(), { launch: true });
  state.ctx = null;
  assert.strictEqual(mod.activeJoins(), undefined, 'no project, no view');
});

test('spawnJoins: an explicit view, "all", or everything the opener is in (filed or by rule), never its exclusions', async () => {
  const { mod } = await setup({
    tabs: {
      opener: { cwd: `${REPO_A}/reports`, name: 'seo agent', kind: 'agent', views: { launch: true, analytics: false } },
      excluded: { cwd: REPO_A, name: 'marketing bot', kind: 'agent', views: { marketing: false } },
    },
  });
  assert.deepStrictEqual(mod.spawnJoins({ view: 'analytics', openerId: 'opener' }), { analytics: true });
  assert.strictEqual(mod.spawnJoins({ view: 'all', openerId: 'opener' }), undefined);
  assert.deepStrictEqual(mod.spawnJoins({ openerId: 'opener' }), { launch: true, marketing: true }, 'filed launch + name-matched marketing');
  assert.strictEqual(mod.spawnJoins({ openerId: 'excluded' }), undefined, 'a removal is not passed on');
  assert.strictEqual(mod.spawnJoins({ openerId: 'unknown' }), undefined);
});

test('setMembership writes the smallest map that says it', async () => {
  const tabs = {
    plain: { cwd: REPO_A, name: 'Claude', kind: 'agent' },
    ruled: { cwd: REPO_A, name: 'SEO pass', kind: 'agent' },
  };
  const { mod, state } = await setup({ tabs });
  mod.setMembership('plain', 'marketing', true);
  assert.deepStrictEqual(state.setViews.at(-1), ['plain', { marketing: true }]);
  mod.setMembership('plain', 'marketing', false);
  assert.deepStrictEqual(state.setViews.at(-1), ['plain', undefined], 'back to no key at all');

  mod.setMembership('ruled', 'marketing', false);
  assert.deepStrictEqual(state.setViews.at(-1), ['ruled', { marketing: false }], 'a rule-matched tab needs an exclusion');
  mod.setMembership('ruled', 'marketing', true);
  assert.deepStrictEqual(state.setViews.at(-1), ['ruled', undefined], 'and re-adding just drops it');
});

test('menuFor lists the project\'s views with this tab\'s membership; null with no project', async () => {
  const { mod, state } = await setup({ tabs: { t: { cwd: REPO_A, name: 'SEO', kind: 'agent', views: { launch: true } } } });
  assert.deepStrictEqual(mod.menuFor('t').map(v => [v.slug, v.on]), [['marketing', true], ['analytics', false], ['launch', true]]);
  state.ctx = null;
  assert.strictEqual(mod.menuFor('t'), null);
});

test('revealTabView moves the view to one holding the tab, else All — and says where', async () => {
  const tabs = {
    seo: { cwd: REPO_A, name: 'SEO', kind: 'agent' },
    loose: { cwd: REPO_A, name: 'Claude', kind: 'agent' },
  };
  const { mod } = await setup({ tabs });
  mod.selectView('launch');
  assert.strictEqual(mod.revealTabView('seo', CTX_A), 'Marketing');
  assert.strictEqual(mod.selectedSlug(CTX_A), 'marketing');
  assert.strictEqual(mod.revealTabView('seo', CTX_A), null, 'already visible: no change');
  assert.strictEqual(mod.revealTabView('loose', CTX_A), 'All');
  assert.strictEqual(mod.selectedSlug(CTX_A), 'all');
});

test('"New view…" creates a rule-less view for the selected project and files the tab into it', async () => {
  globalThis.prompt = () => 'Growth';
  const { mod, state } = await setup({ tabs: { t: { cwd: `${REPO_A}/src`, name: 'Claude', kind: 'agent' } } });
  const v = await mod.createView({ fileTabId: 't' });
  assert.strictEqual(v.slug, 'growth');
  assert.deepStrictEqual(state.posts[0], { url: '/api/project-views', body: { contextId: 'ctxa', name: 'Growth', cwd: `${REPO_A}/src` } });
  assert.deepStrictEqual(state.setViews.at(-1), ['t', { growth: true }]);
  assert.match(state.toasts.at(-1), /commit it/);

  globalThis.prompt = () => null;
  assert.strictEqual(await mod.createView(), null, 'cancelled');
  assert.strictEqual(state.posts.length, 1);
});

// --------------------------------------------------------------- source guards

test('every contexts / project-mods handler in app.js refreshes the views too', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  const mods = src.match(/ProjectMods\.refresh\(\)/g).length;
  const views = src.match(/ProjectViews\.refresh\(\)/g).length;
  // Two handlers per channel (session socket + reload channel) × (contexts, project-mods) = 4.
  // ProjectMods.refresh() also runs on the settings paths, which views don't depend on.
  assert.strictEqual(views, 4);
  assert.ok(mods >= views);
  const pings = [...src.matchAll(/msg\.type === 'project-mods'/g)];
  assert.ok(pings.length >= 2, 'both channels handle the ping');
  for (const m of pings) {
    assert.match(src.slice(m.index, m.index + 400), /ProjectViews\.refresh\(\)/, 'a project-mods ping refreshes views');
  }
});

test('project-views.js never imports context-views.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/project-views.js'), 'utf8');
  assert.ok(!/from '\.\/context-views\.js'/.test(src));
});
