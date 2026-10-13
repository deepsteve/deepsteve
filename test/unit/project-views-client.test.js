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
  // The launcher beside the + (index.html): an icon and a label.
  const launch = fakeElement('button');
  launch.className = 'nav-btn hidden';
  launch.append(fakeElement('span'), fakeElement('span'));
  byId.set('view-launch-btn', launch);

  const state = { ctx, tabs, suspended, filterCalls: 0, setViews: [], toasts: [], posts: [], launches: [], serverViews: views };
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
    launchInView: (slug) => state.launches.push(slug),
  });
  await flush();
  return { mod, state, wrapper, list, bar, appMain, launch };
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

// ------------------------------------------------- DeepSteve-wide views, footers

// A view from ~/.deepsteve/views/: no repo, so `project` is null and `global` is set.
const V_GITHUB = { id: 'g1', slug: 'github', project: null, global: true, name: 'GitHub', icon: '', order: 0, match: [{ worktree: true }], footer: ['repo', 'issue', 'date', 'title'] };

test('a DeepSteve-wide view is in every project, merged by slug with a repo view of the same name', async () => {
  const repoGithub = { id: 'v9', slug: 'github', project: REPO_B, name: 'GitHub (beta)', icon: '', order: 5, match: [{ names: ['gh'] }], footer: [] };
  const { mod } = await setup({ views: [V_GITHUB, V_MKT_A, V_BETA, repoGithub] });
  assert.deepStrictEqual(mod.viewsForContext(CTX_A).map(v => v.slug), ['github', 'marketing']);
  const inBeta = mod.viewsForContext({ id: 'b', name: 'Beta', dirs: [REPO_B] }).find(v => v.slug === 'github');
  assert.strictEqual(inBeta.global, true);
  assert.deepStrictEqual(inBeta.ids, ['v9'], 'only the repo copy is writable');
  assert.strictEqual(inBeta.rules.length, 2, 'rules unioned');
  assert.deepStrictEqual(inBeta.footer, V_GITHUB.footer, 'the first footer by order');
  const onlyGlobal = mod.viewsForContext(CTX_A).find(v => v.slug === 'github');
  assert.deepStrictEqual(onlyGlobal.ids, []);
});

test('the worktree rule: a worktree session, or a tab whose cwd is inside one', async () => {
  const { mod } = await setup({ views: [V_GITHUB] });
  const gh = mod.viewsForContext(CTX_A)[0];
  assert.ok(mod.memberOf({ cwd: REPO_A, name: '#9 Footer', kind: 'agent', worktree: 'github-issue-9' }, gh));
  assert.ok(mod.memberOf({ cwd: `${REPO_A}/.claude/worktrees/feature-x/src`, name: 'zsh', kind: 'terminal' }, gh));
  assert.ok(!mod.memberOf({ cwd: REPO_A, name: 'Claude', kind: 'agent' }, gh));
  assert.ok(!mod.memberOf({ cwd: `${REPO_A}/.claude/worktreesX`, name: 'zsh', kind: 'terminal' }, gh), 'a prefix is not the folder');
  assert.ok(!mod.memberOf({ cwd: REPO_A, name: 'x', worktree: 'w', views: { github: false } }, gh), 'filed out');
  const notWt = { rules: [{ worktree: false, root: null }], slug: 'main-only' };
  assert.ok(mod.memberOf({ cwd: REPO_A, name: 'x' }, notWt));
  assert.ok(!mod.memberOf({ cwd: REPO_A, name: 'x', worktree: 'w' }, notWt));
});

test('footerFor follows the tab, in any project or none, whichever view is selected', async () => {
  const { mod, state } = await setup({
    views: [V_GITHUB, V_MKT_A],
    tabs: {
      wt: { cwd: REPO_A, name: '#9 Footer', kind: 'agent', worktree: 'github-issue-9' },
      loose: { cwd: '/elsewhere/.claude/worktrees/github-issue-3', name: 'zsh', kind: 'terminal' },
      plain: { cwd: REPO_A, name: 'Claude', kind: 'agent' },
      out: { cwd: REPO_A, name: 'x', kind: 'agent', worktree: 'w', views: { github: false } },
    },
  });
  mod.selectView('marketing');
  assert.deepStrictEqual(mod.footerFor('wt'), { slug: 'github', name: 'GitHub', fields: V_GITHUB.footer }, 'Marketing is selected');
  assert.deepStrictEqual(mod.footerFor('loose')?.slug, 'github', 'a tab in no registered project still gets it');
  assert.strictEqual(mod.footerFor('plain'), null);
  assert.strictEqual(mod.footerFor('out'), null, 'filed out of the view, no footer');
  assert.strictEqual(mod.footerFor('missing'), null);

  // Two footer views holding one tab: the first by the views' own order answers.
  const repoFooter = { ...V_MANUAL, match: [{ worktree: true }], footer: ['issue'] };   // order 2
  state.serverViews = [V_GITHUB, repoFooter];
  await mod.refresh();
  assert.deepStrictEqual(mod.footerFor('wt').fields, V_GITHUB.footer, 'GitHub (order 0) sorts first');
  state.serverViews = [{ ...repoFooter, order: -1 }, V_GITHUB];
  await mod.refresh();
  assert.deepStrictEqual(mod.footerFor('wt').fields, ['issue'], 'order -1 sorts first');
  assert.deepStrictEqual(mod.footerFor('loose').fields, V_GITHUB.footer, 'outside that repo, only GitHub holds it');
});

test('footerFor is null until the view list has loaded, and refresh() tells app.js it changed', async () => {
  const { mod } = await setup({ views: [V_GITHUB], tabs: { wt: { cwd: REPO_A, name: 'x', worktree: 'w' } } });
  let changed = 0;
  const mod2 = await import(`../../public/js/project-views.js?t=${++importCount}`);
  mod2.init({ getTabInfo: () => ({ cwd: REPO_A, name: 'x', worktree: 'w' }), contextsForCwd: () => [], onViewsChanged: () => changed++ });
  assert.strictEqual(mod2.footerFor('wt'), null, 'not loaded yet');
  await flush();
  assert.strictEqual(changed, 1);
  assert.strictEqual(mod2.footerFor('wt').slug, 'github');
  assert.ok(mod.footerFor('wt'));
});

test('a DeepSteve-wide view button offers no Rename or Delete, only where to edit it', async () => {
  const { mod, bar } = await setup({ views: [V_GITHUB, V_MKT_A] });
  mod.toggleExpanded(true);
  const btn = bar.children.find(b => b.dataset.view === 'github');
  let menu = null;
  const saved = document.body.appendChild;
  document.body.appendChild = (m) => { menu = m; };
  try {
    btn.listeners.contextmenu({ preventDefault() {}, clientX: 10, clientY: 10 });
  } finally {
    document.body.appendChild = saved;
  }
  assert.deepStrictEqual(menu.children.map(i => i.textContent), ['DeepSteve-wide: edit ~/.deepsteve/views/github.json']);
  assert.ok(menu.children[0].classList.contains('disabled'));
});

// An additive view: switched on, never selected, stacks with the selected view.
const V_GITHUB_ADD = { ...V_GITHUB, additive: true };

test('an additive view hides no tab, is never the selection, and a stored selection of it falls back to All', async () => {
  sessionStorage.map.clear();
  const { mod } = await setup({
    views: [V_GITHUB_ADD, V_MKT_A],
    tabs: { wt: { cwd: REPO_A, name: 'Claude', kind: 'agent', worktree: 'w' }, plain: { cwd: REPO_A, name: 'zsh', kind: 'terminal' } },
  });
  assert.deepStrictEqual(mod.selectableViews(CTX_A).map(v => v.slug), ['marketing']);
  mod.selectView('github');
  assert.strictEqual(mod.selectedSlug(CTX_A), 'all', 'selecting it is refused');
  assert.ok(mod.tabInView('plain', CTX_A) && mod.tabInView('wt', CTX_A), 'every tab stays in the strip');

  mod.selectView('marketing');
  assert.strictEqual(mod.selectedSlug(CTX_A), 'marketing');
  assert.ok(!mod.tabInView('wt', CTX_A), 'the selected view still filters');
  assert.deepStrictEqual(mod.footerFor('wt')?.slug, 'github', 'and the additive one still adds its footer on top');

  // A window that had GitHub selected before it became additive.
  const key = [...sessionStorage.map.keys()].find(k => k.endsWith('deepsteve-project-view'));
  sessionStorage.map.set(key, JSON.stringify({ [CTX_A.id]: 'github' }));
  const { mod: again } = await setup({ views: [V_GITHUB_ADD, V_MKT_A], tabs: {} });
  assert.strictEqual(again.selectedSlug(CTX_A), 'all');
});

test('an additive view is a push button: on by default, off hides its footer, the choice is kept', async () => {
  const { mod, bar } = await setup({ views: [V_GITHUB_ADD, V_MKT_A], tabs: { wt: { cwd: REPO_A, name: 'x', worktree: 'w' } } });
  mod.toggleExpanded(true);
  const labels = () => bar.children.map(b => b.className + ':' + (b.dataset.view || b.textContent));
  assert.deepStrictEqual(labels(), [
    'view-tab active:all', 'view-tab:marketing', 'view-tab view-tab-push on first:github', 'view-tab view-tab-add:+ New view',
  ], 'folder tabs, then the push button, then + New view');
  const push = () => bar.children.find(b => b.dataset.view === 'github');
  assert.strictEqual(push().attrs['aria-pressed'], 'true');
  assert.strictEqual(push().children[0].textContent, '●');
  assert.ok(mod.footerFor('wt'));

  push().listeners.click();
  assert.strictEqual(mod.isAdditiveOn('github'), false);
  assert.strictEqual(push().attrs['aria-pressed'], 'false', 'the bar redrew');
  assert.strictEqual(push().children[0].textContent, '○');
  assert.strictEqual(mod.footerFor('wt'), null, 'off: no footer');
  assert.strictEqual(mod.selectedSlug(CTX_A), 'all', 'and the selection never moved');
  const stored = [...localStorage.map.entries()].find(([k]) => k.endsWith('deepsteve-project-views-off'));
  assert.deepStrictEqual(JSON.parse(stored[1]), { github: true }, 'browser-wide, only the ones switched off');

  const { mod: reloaded } = await setup({ views: [V_GITHUB_ADD], tabs: { wt: { cwd: REPO_A, name: 'x', worktree: 'w' } } });
  // setup() clears storage, so put the choice back the way a reload would find it.
  localStorage.setItem(stored[0], stored[1]);
  const fresh = await import(`../../public/js/project-views.js?t=${++importCount}`);
  assert.strictEqual(fresh.isAdditiveOn('github'), false, 'read back on load');
  assert.strictEqual(reloaded.isAdditiveOn('github'), true, 'absent means on');
  fresh.setAdditive('github', true);
  assert.ok(!JSON.parse(localStorage.getItem(stored[0])).github);
});

test('switching an additive view tells app.js, and applies no filter', async () => {
  await setup({ views: [V_GITHUB_ADD] });   // fresh DOM and storage
  let changed = 0;
  const mod = await import(`../../public/js/project-views.js?t=${++importCount}`);
  mod.init({ getActiveContext: () => CTX_A, onViewsChanged: () => changed++, applyFilter: () => { throw new Error('no filter pass'); } });
  await flush();
  changed = 0;
  mod.setAdditive('github', false);
  assert.strictEqual(changed, 1, 'the footer redraws');
});

test('a tab an agent opens inherits its opener\'s views, but not the additive ones', async () => {
  const { mod } = await setup({
    views: [V_GITHUB_ADD, V_MKT_A],
    tabs: { opener: { cwd: REPO_A, name: 'marketing agent', kind: 'agent', worktree: 'w', views: { github: true, launch: true } } },
  });
  assert.deepStrictEqual(mod.spawnJoins({ openerId: 'opener' }), { launch: true, marketing: true });
  assert.deepStrictEqual(mod.spawnJoins({ view: 'github' }), { github: true }, 'naming it explicitly still files it');
});

// An additive view with a slot: the orchestrator's reserved place at the head of the strip.
const V_ORCH = { id: 'g2', slug: 'orchestrator', project: null, global: true, name: 'Orchestrator', icon: '', order: 0, match: [], footer: [], additive: true, slot: 'orchestrator' };
const ORCH_TAB = { cwd: REPO_A, name: 'Orchestrator', kind: 'agent', slot: { contextId: CTX_A.id, role: 'orchestrator' } };

test('a slot view gives its project a slot while it is on, and nothing to select', async () => {
  const { mod } = await setup({ views: [V_ORCH, V_MKT_A] });
  assert.strictEqual(mod.slotFor(CTX_A), 'orchestrator', 'on by default, like any additive view');
  assert.strictEqual(mod.slotFor(CTX_AS), 'orchestrator', 'a DeepSteve-wide one is in every project');
  assert.deepStrictEqual(mod.selectableViews(CTX_A).map(v => v.slug), ['marketing']);
  mod.setAdditive('orchestrator', false);
  assert.strictEqual(mod.slotFor(CTX_A), null, 'off: no slot');
  assert.strictEqual(mod.slotFor(null), null);

  const { mod: plain } = await setup({ views: [V_GITHUB_ADD] });
  assert.strictEqual(plain.slotFor(CTX_A), null, 'an additive view without a slot adds none');

  const { mod: held, state } = await setup({ views: [V_ORCH], suspended: true });
  assert.strictEqual(held.slotFor(CTX_A), null, 'Decision Tab mode sets it aside');
  state.suspended = false;
  assert.strictEqual(held.slotFor(CTX_A), 'orchestrator');
});

test('the slot\'s holder is in every view while the slot is on, and only in its own project', async () => {
  const { mod, state } = await setup({
    views: [V_ORCH, V_MKT_A],
    tabs: { orch: { ...ORCH_TAB }, other: { cwd: REPO_A, name: 'zsh', kind: 'terminal' } },
  });
  mod.selectView('marketing');
  assert.ok(mod.tabInView('orch', CTX_A), 'Marketing is selected, and the orchestrator stays');
  assert.ok(!mod.tabInView('other', CTX_A), 'while the view still filters everything else');
  assert.strictEqual(mod.revealTabView('orch', CTX_A), null, 'focusing it moves no view');
  assert.strictEqual(mod.selectedSlug(CTX_A), 'marketing');
  assert.ok(mod.holdsSlot(state.tabs.orch, CTX_A));
  assert.ok(!mod.holdsSlot(state.tabs.orch, CTX_AS), 'the marker names its project');
  assert.ok(!mod.holdsSlot(state.tabs.other, CTX_A));

  const before = state.filterCalls;
  mod.setAdditive('orchestrator', false);
  assert.strictEqual(state.filterCalls, before + 1, 'switching a slot asks for a filter pass, unlike a footer');
  assert.ok(!mod.tabInView('orch', CTX_A), 'off: it is an ordinary tab, filtered like one');
  assert.ok(!mod.holdsSlot(state.tabs.orch, CTX_A));
});

test('a repo view and a DeepSteve-wide one of the same slug merge their slot', async () => {
  const repoOrch = { id: 'v10', slug: 'orchestrator', project: REPO_A, name: 'Lead', icon: '', order: -1, match: [], footer: [], additive: true, slot: null };
  const { mod } = await setup({ views: [repoOrch, V_ORCH] });
  const v = mod.viewsForContext(CTX_A).find(x => x.slug === 'orchestrator');
  assert.strictEqual(v.name, 'Lead');
  assert.strictEqual(v.slot, 'orchestrator', 'the first one with a slot gives it');
});

// --------------------------------------------------------------- source guards

// ------------------------------------------------------- launchers and superviews

// The DeepSteve-wide Analytics view the docs describe: manual, with a launcher and cards.
const V_ANALYTICS_WIDE = { id: 'g1', slug: 'analytics', project: null, global: true, name: 'Analytics', icon: '📈', order: 0, match: [], launcher: true, cards: true };

test('a launcher and a superview belong to the selected view only', async () => {
  const { mod, state, launch } = await setup({ views: [V_ANALYTICS_WIDE, V_MANUAL], tabs: {} });
  assert.strictEqual(mod.launcherFor(CTX_A), null, 'All is selected');
  assert.strictEqual(mod.cardsFor(CTX_A), null);
  assert.ok(launch.classList.contains('hidden'));

  mod.selectView('analytics');
  assert.strictEqual(mod.launcherFor(CTX_A).slug, 'analytics');
  assert.strictEqual(mod.cardsFor(CTX_A).slug, 'analytics');
  assert.ok(!launch.classList.contains('hidden'), 'the launcher shows beside the +');
  assert.strictEqual(launch.children[0].textContent, '📈');
  assert.strictEqual(launch.children[1].textContent, 'New Analytics tab');
  assert.strictEqual(launch.dataset.view, 'analytics');

  launch.listeners.click();
  assert.deepStrictEqual(state.launches, ['analytics'], 'filed by name');

  mod.selectView('launch');
  assert.strictEqual(mod.launcherFor(CTX_A), null, 'a view without one');
  assert.strictEqual(mod.cardsFor(CTX_A), null);
  assert.ok(launch.classList.contains('hidden'));
  launch.listeners.click();
  assert.deepStrictEqual(state.launches, ['analytics'], 'a stale click launches nothing');

  mod.selectView('analytics');
  state.suspended = true;   // Decision Tab mode sets views aside
  assert.strictEqual(mod.launcherFor(CTX_A), null);
  assert.strictEqual(mod.cardsFor(CTX_A), null);
  assert.strictEqual(mod.launcherFor(null), null, 'no project, no views');
});

test('a manual view holds exactly its filed tabs, and either copy of a merged view can ask for the extras', async () => {
  const repoCopy = { id: 'r1', slug: 'analytics', project: REPO_A, name: 'Analytics', icon: '', order: 5, match: [] };
  const { mod } = await setup({
    views: [V_ANALYTICS_WIDE, repoCopy],
    tabs: {
      filed: { cwd: REPO_A, name: 'Retention', kind: 'agent', views: { analytics: true } },
      loose: { cwd: REPO_A, name: 'analytics refactor', kind: 'agent' },
    },
  });
  const view = mod.viewsForContext(CTX_A).find(v => v.slug === 'analytics');
  assert.ok(view.launcher && view.cards, 'the repo copy has neither; the DeepSteve-wide one brings both');
  assert.ok(mod.isMember('filed', view));
  assert.ok(!mod.isMember('loose', view), 'opt-in: a name alone does not put a tab in a rule-less view');
  assert.ok(!mod.isMember('nope', view));
});

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
