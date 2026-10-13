// Unit tests for DeepSteve-wide views and view footers.
//
// Three layers, no daemon and no network:
//   - mods/project-mods/view-footer.js: what a tab's repo and issue are, the excerpt, and the
//     cached git/gh lookups behind the footer route (exec is injected).
//   - mods/project-mods/tools.js: views read from the install's own ~/.deepsteve/views/ —
//     global, in every project, never written through the tools or REST — plus the `worktree`
//     rule field, `footer` round-tripping, and GET /api/project-views/footer/:sessionId.
//   - public/js/view-footer.js: the row under the monitor, against a fake DOM.
//
// Run: node --test test/unit/view-footer.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before tools.js loads: globalViewsDir() is stateDir()-relative, and stateDir() is $HOME's.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-view-footer-home-'));
process.env.HOME = HOME;
delete process.env.DEEPSTEVE_HOME;

const footer = require('../../mods/project-mods/view-footer.js');
const views = require('../../mods/project-mods/tools.js');

// ------------------------------------------------------------ view-footer.js

test('parseGitHubRepo reads every remote and URL form, and nothing else', () => {
  const { parseGitHubRepo } = footer;
  assert.strictEqual(parseGitHubRepo('git@github.com:octo/deepsteve.git'), 'octo/deepsteve');
  assert.strictEqual(parseGitHubRepo('git@github.com:octo/deepsteve.git\n'), 'octo/deepsteve', 'git prints a newline');
  assert.strictEqual(parseGitHubRepo('ssh://git@github.com/octo/deepsteve.git'), 'octo/deepsteve');
  assert.strictEqual(parseGitHubRepo('https://github.com/octo/deepsteve'), 'octo/deepsteve');
  assert.strictEqual(parseGitHubRepo('https://x-token:abc@github.com/octo/deepsteve.git'), 'octo/deepsteve');
  assert.strictEqual(parseGitHubRepo('https://github.com/octo/deepsteve/issues/726'), 'octo/deepsteve');
  assert.strictEqual(parseGitHubRepo('https://github.com/octo/my.repo'), 'octo/my.repo', 'a dot inside a name is kept');
  assert.strictEqual(parseGitHubRepo('https://gitlab.com/octo/deepsteve.git'), null);
  assert.strictEqual(parseGitHubRepo('https://notgithub.com/octo/deepsteve'), null);
  assert.strictEqual(parseGitHubRepo(''), null);
  assert.strictEqual(parseGitHubRepo(undefined), null);
});

test('worktreeOf and issueNumberOf: the stamp, then the worktree name, then a worktree cwd', () => {
  const { worktreeOf, issueNumberOf } = footer;
  assert.strictEqual(worktreeOf({ cwd: '/r', worktree: 'github-issue-9' }), 'github-issue-9');
  assert.strictEqual(worktreeOf({ cwd: '/r/.claude/worktrees/feature-x/src' }), 'feature-x', 'a terminal opened inside one');
  assert.strictEqual(worktreeOf({ cwd: '/r/.claude/worktrees/feature-x' }), 'feature-x');
  assert.strictEqual(worktreeOf({ cwd: '/r/src' }), null);

  assert.strictEqual(issueNumberOf({ issue: { number: 726 }, worktree: 'github-issue-9' }), 726, 'the stamp wins');
  assert.strictEqual(issueNumberOf({ worktree: 'github-issue-9' }), 9);
  assert.strictEqual(issueNumberOf({ cwd: '/r/.claude/worktrees/github-issue-12' }), 12);
  assert.strictEqual(issueNumberOf({ worktree: 'feature-x' }), null);
  assert.strictEqual(issueNumberOf({ worktree: 'github-issue-9x' }), null, 'only the exact issueWorktreeName shape');
  assert.strictEqual(issueNumberOf({ issue: { number: 0 } }), null);
});

test('excerptOf: plain prose, title + excerpt within the word cap, an ellipsis only when cut', () => {
  const { excerptOf, plainText } = footer;
  assert.strictEqual(
    plainText('## Why\n\n<!-- hidden -->Use `x` and **bold** [the docs](https://e.x).\n```js\ncode()\n```\n- one\n- two snake_case'),
    'Use x and bold the docs. one two snake_case', 'a heading is dropped, not read as a word');

  const body = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
  const out = excerptOf('three word title', body, 10);
  assert.strictEqual(out, 'w0 w1 w2 w3 w4 w5 w6…', '10 words in all, title included');
  assert.strictEqual(excerptOf('t', 'short body', 10), 'short body', 'no ellipsis when it fits');
  assert.strictEqual(excerptOf('a b c', 'more', 3), '', 'a title at the cap leaves no room');
  assert.strictEqual(excerptOf('t', null, 10), '');
  assert.strictEqual(footer.EXCERPT_WORDS, 100);
});

function fakeExec(answers) {
  const calls = [];
  const exec = async (bin, args, cwd) => {
    calls.push({ bin, args, cwd });
    const key = `${bin} ${args.slice(0, 2).join(' ')}`;
    const a = answers[key];
    if (a === undefined) return { ok: false, error: `unexpected ${key}` };
    return typeof a === 'function' ? a(args) : a;
  };
  return { exec, calls };
}

const ISSUE_JSON = JSON.stringify({
  title: 'Footer for worktree tabs', body: 'A row under the monitor.', createdAt: '2026-10-09T12:00:00Z',
  url: 'https://github.com/octo/deepsteve/issues/9',
});

test('footerFor: repo from the remote, issue from the worktree name, details from gh', async () => {
  const { exec, calls } = fakeExec({
    'git remote get-url': { ok: true, stdout: 'git@github.com:octo/deepsteve.git\n' },
    'gh issue view': { ok: true, stdout: ISSUE_JSON },
  });
  const src = footer.createFooterSource({ exec });
  const entry = { cwd: '/r', worktree: 'github-issue-9' };
  const out = await src.footerFor(entry, { cwd: '/r/.claude/worktrees/github-issue-9', repoRoot: '/r' });
  assert.deepStrictEqual(out, {
    repo: { name: 'octo/deepsteve', url: 'https://github.com/octo/deepsteve' },
    issue: {
      number: 9, url: 'https://github.com/octo/deepsteve/issues/9', title: 'Footer for worktree tabs',
      excerpt: 'A row under the monitor.', createdAt: '2026-10-09T12:00:00Z',
    },
    worktree: 'github-issue-9',
  });
  assert.strictEqual(calls[0].cwd, '/r/.claude/worktrees/github-issue-9', 'git runs where the agent works');
  assert.deepStrictEqual(calls[1].args, ['issue', 'view', '9', '--repo', 'octo/deepsteve', '--json', 'title,body,createdAt,url']);

  // A second look costs nothing: the remote and the issue are both cached.
  await src.footerFor(entry, { cwd: '/r/.claude/worktrees/github-issue-9', repoRoot: '/r' });
  assert.strictEqual(calls.length, 2);
});

test('footerFor: a stamped issue URL names the repo without asking git', async () => {
  const { exec, calls } = fakeExec({ 'gh issue view': { ok: true, stdout: ISSUE_JSON } });
  const src = footer.createFooterSource({ exec });
  const out = await src.footerFor(
    { cwd: '/r', worktree: 'github-issue-9', issue: { number: 9, url: 'https://github.com/octo/deepsteve/issues/9' } },
    { cwd: '/r', repoRoot: '/r' });
  assert.strictEqual(out.repo.name, 'octo/deepsteve');
  assert.deepStrictEqual(calls.map(c => c.bin), ['gh']);
});

test('footerFor: concurrent lookups share one gh call; a failure is retried only after its TTL', async () => {
  let t = 1000;
  let fail = true;
  const { exec, calls } = fakeExec({
    'git remote get-url': { ok: true, stdout: 'https://github.com/octo/deepsteve.git' },
    'gh issue view': () => (fail ? { ok: false, error: 'gh not found on PATH' } : { ok: true, stdout: ISSUE_JSON }),
  });
  const logs = [];
  const src = footer.createFooterSource({ exec, now: () => t, log: (m) => logs.push(m) });
  const entry = { cwd: '/r', worktree: 'github-issue-9' };
  const [a, b] = await Promise.all([src.footerFor(entry, { cwd: '/r' }), src.footerFor(entry, { cwd: '/r' })]);
  assert.strictEqual(calls.filter(c => c.bin === 'gh').length, 1, 'one gh call for the burst');
  assert.deepStrictEqual(a.issue, { number: 9, url: 'https://github.com/octo/deepsteve/issues/9' }, 'number and link still known');
  assert.deepStrictEqual(b, a);
  assert.match(logs[0], /gh issue view octo\/deepsteve#9 failed: gh not found/);

  fail = false;
  t += 30 * 1000;
  await src.footerFor(entry, { cwd: '/r' });
  assert.strictEqual(calls.filter(c => c.bin === 'gh').length, 1, 'inside the failure TTL: not retried');
  t += 31 * 1000;
  const later = await src.footerFor(entry, { cwd: '/r' });
  assert.strictEqual(calls.filter(c => c.bin === 'gh').length, 2, 'past it: retried');
  assert.strictEqual(later.issue.title, 'Footer for worktree tabs');
});

test('footerFor: a non-GitHub checkout shows its folder name, and asks gh nothing', async () => {
  const { exec, calls } = fakeExec({ 'git remote get-url': { ok: true, stdout: 'git@gitlab.com:octo/x.git' } });
  const src = footer.createFooterSource({ exec });
  const out = await src.footerFor({ cwd: '/src/thing', worktree: 'github-issue-3' }, { cwd: '/src/thing', repoRoot: '/src/thing' });
  assert.deepStrictEqual(out.repo, { name: 'thing', url: null });
  assert.deepStrictEqual(out.issue, { number: 3, url: null });
  assert.deepStrictEqual(calls.map(c => c.bin), ['git']);
});

// ------------------------------------------------------------ tools.js

function makeRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ds-footer-repo-${name}-`));
  fs.mkdirSync(path.join(root, '.git'));
  return fs.realpathSync(root);
}
const REPO_A = makeRepo('a');
const GLOBAL_DIR = path.join(HOME, '.deepsteve', 'views');
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };

const shells = new Map([
  ['sess-wt', { cwd: REPO_A, worktree: 'github-issue-9' }],
]);
const ctx = {
  shells,
  settings: { projectModsEnabled: true },
  reloadClients: new Set(),
  log: () => {},
  broadcast: () => {},
  getContexts: () => [{ id: 'ctx-a', name: 'Alpha', dirs: [REPO_A] }],
  sessionPaths: (e) => ({ cwd: `${e.cwd}/.claude/worktrees/${e.worktree}`, repoRoot: e.cwd }),
};
const tools = views.init(ctx);
const payload = (res) => JSON.parse(res.content[0].text);

const routes = new Map();
views.registerRoutes({
  get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h),
  put: (p, h) => routes.set(`PUT ${p}`, h), delete: (p, h) => routes.set(`DELETE ${p}`, h),
}, ctx);
async function call(key, { params = {}, body = {} } = {}) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (v) => { res.body = v; return res; };
  await routes.get(key)({ params, body }, res);
  return res;
}

test('a view in ~/.deepsteve/views/ is DeepSteve-wide: no project, no paths rules, footer kept', async () => {
  writeJson(path.join(GLOBAL_DIR, 'github.json'), {
    name: 'GitHub',
    match: [{ worktree: true }, { paths: ['src'] }, { names: ['pr'], worktree: 'yes' }],
    footer: ['repo', 'issue', 'nonsense', 'date', 'repo', 'title'],
  });
  views.scan();
  const res = await call('GET /api/project-views');
  const gh = res.body.views.find(v => v.slug === 'github');
  assert.ok(gh, 'listed');
  assert.strictEqual(gh.global, true);
  assert.strictEqual(gh.project, null);
  assert.deepStrictEqual(gh.match, [{ worktree: true }],
    'a paths rule has no repo to resolve against, and a non-boolean worktree drops its rule whole');
  assert.deepStrictEqual(gh.footer, ['repo', 'issue', 'date', 'title'], 'known fields, each once, in file order');
  assert.notStrictEqual(gh.id, views.viewId(REPO_A, 'github'));
});

test('a DeepSteve-wide view is in every project\'s listing, and nothing writes it', async () => {
  views.scan();
  const listed = payload(await tools.list_project_views.handler({ project: REPO_A }, {}));
  const gh = listed.views.find(v => v.slug === 'github');
  assert.ok(gh, 'in the project scope');
  assert.strictEqual(gh.path, path.join(GLOBAL_DIR, 'github.json'), 'absolute: it belongs to no repo');

  const upd = await tools.update_project_view.handler({ view: 'github', name: 'Hub', project: REPO_A }, {});
  assert.ok(upd.isError, 'the tools edit repo views only');
  const put = await call('PUT /api/project-views/:id', { params: { id: gh.id }, body: { name: 'Hub' } });
  assert.strictEqual(put.statusCode, 409);
  assert.match(put.body.error, /DeepSteve-wide view, defined in .*github\.json/);
  const del = await call('DELETE /api/project-views/:id', { params: { id: gh.id } });
  assert.strictEqual(del.statusCode, 409);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(GLOBAL_DIR, 'github.json'), 'utf8')).name, 'GitHub', 'untouched');
});

test('additive: only a literal true, and it round-trips', () => {
  const on = views.normalizeView({ name: 'GitHub', additive: true }, null, 'github', { global: true });
  assert.strictEqual(on.additive, true);
  assert.strictEqual(views.serializeView(on).additive, true);
  assert.strictEqual(views.viewManifestOf(on).additive, true);
  const off = views.normalizeView({ name: 'X', additive: 'yes' }, REPO_A, 'x');
  assert.strictEqual(off.additive, false, 'not a literal true: an ordinary view');
  assert.ok(!('additive' in views.viewManifestOf(off)), 'and the file does not grow a false');
});

test('a repo view keeps its footer and worktree rule through update_project_view', async () => {
  writeJson(path.join(REPO_A, '.deepsteve', 'views', 'issues.json'), {
    name: 'Issues', match: [{ worktree: true, kinds: ['agent'] }], footer: ['issue', 'title'],
  });
  views.scan();
  const res = await tools.update_project_view.handler({ view: 'issues', name: 'Issue work', project: REPO_A }, {});
  assert.ok(!res.isError, JSON.stringify(res));
  const disk = JSON.parse(fs.readFileSync(path.join(REPO_A, '.deepsteve', 'views', 'issues.json'), 'utf8'));
  assert.deepStrictEqual(disk, { name: 'Issue work', match: [{ kinds: ['agent'], worktree: true }], footer: ['issue', 'title'] });

  const made = await tools.create_project_view.handler({ name: 'Plain', match: [{ worktree: false }], project: REPO_A }, {});
  const plain = payload(made);
  assert.deepStrictEqual(plain.match, [{ worktree: false }]);
  assert.deepStrictEqual(plain.footer, [], 'no footer unless the file names one');
  assert.ok(!('footer' in JSON.parse(fs.readFileSync(path.join(REPO_A, '.deepsteve', 'views', 'plain.json'), 'utf8'))));
});

test('GET /api/project-views/footer/:sessionId answers from the session and its paths', async () => {
  const seen = [];
  views.setFooterSource({ footerFor: async (entry, paths) => { seen.push({ entry, paths }); return { repo: { name: 'octo/x', url: null }, issue: null, worktree: entry.worktree }; } });
  const ok = await call('GET /api/project-views/footer/:sessionId', { params: { sessionId: 'sess-wt' } });
  assert.strictEqual(ok.statusCode, 200);
  assert.deepStrictEqual(ok.body, { repo: { name: 'octo/x', url: null }, issue: null, worktree: 'github-issue-9' });
  assert.deepStrictEqual(seen[0].paths, { cwd: `${REPO_A}/.claude/worktrees/github-issue-9`, repoRoot: REPO_A }, 'sessionPaths, not the bare cwd');

  const missing = await call('GET /api/project-views/footer/:sessionId', { params: { sessionId: 'nope' } });
  assert.strictEqual(missing.statusCode, 404);

  views.setFooterSource({ footerFor: async () => { throw new Error('boom'); } });
  const broken = await call('GET /api/project-views/footer/:sessionId', { params: { sessionId: 'sess-wt' } });
  assert.strictEqual(broken.statusCode, 500);
  views.setFooterSource(null);
});

// ------------------------------------------------------------ public/js/view-footer.js

function fakeEl() {
  const classes = new Set();
  let children = [];
  let text = '';
  const el = {
    attrs: {}, title: '',
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); },
      add: (c) => classes.add(c),
    },
    get children() { return children; },
    appendChild: (k) => { children.push(k); return k; },
    replaceChildren: () => { children = []; },
  };
  Object.defineProperty(el, 'className', { get: () => [...classes].join(' '), set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); } });
  Object.defineProperty(el, 'textContent', {
    get: () => text + children.map(c => c.textContent).join(''),
    set: (v) => { text = String(v); children = []; },
  });
  return el;
}

const flush = () => new Promise(r => setTimeout(r, 0));
let imports = 0;

async function setupFooter({ footerFor, slotUp = false, data }) {
  const byId = new Map([['view-footer', fakeEl()], ['app-main', fakeEl()]]);
  byId.get('view-footer').classList.add('hidden');
  globalThis.document = { getElementById: (id) => byId.get(id) || null, createElement: () => fakeEl() };
  const state = { fetches: [], active: 't1', slotUp, footerFor };
  globalThis.fetch = async (url) => { state.fetches.push(url); return { ok: true, json: async () => data }; };
  const mod = await import(`../../public/js/view-footer.js?t=${++imports}`);
  mod.init({
    getActiveTabId: () => state.active,
    footerFor: (id) => state.footerFor(id),
    isViewSlotUp: () => state.slotUp,
  });
  return { mod, state, el: byId.get('view-footer'), appMain: byId.get('app-main') };
}

const DATA = {
  repo: { name: 'octo/deepsteve', url: 'https://github.com/octo/deepsteve' },
  issue: { number: 9, url: 'https://github.com/octo/deepsteve/issues/9', title: 'Footer', excerpt: 'A row.', createdAt: '2026-10-09T12:00:00Z' },
  worktree: 'github-issue-9',
};

test('the footer row: placeholder, then the fields the view asked for, in its order', async () => {
  const { el, state, appMain } = await setupFooter({ footerFor: () => ({ slug: 'github', fields: ['repo', 'issue', 'date', 'title'] }), data: DATA });
  assert.ok(!el.classList.contains('hidden'), 'shown at once, before the facts arrive');
  assert.ok(appMain.classList.contains('view-footer-open'));
  assert.strictEqual(el.children.length, 1);
  assert.strictEqual(el.children[0].textContent, '…');
  assert.deepStrictEqual(state.fetches, ['/api/project-views/footer/t1']);

  await flush(); await flush();
  const cells = el.children;
  assert.deepStrictEqual(cells.map(c => c.className), ['vf-cell vf-repo', 'vf-cell vf-issue', 'vf-cell vf-date', 'vf-cell vf-title']);
  assert.strictEqual(cells[0].href, 'https://github.com/octo/deepsteve');
  assert.strictEqual(cells[0].target, '_blank');
  assert.strictEqual(cells[1].textContent, '#9');
  assert.strictEqual(cells[1].href, 'https://github.com/octo/deepsteve/issues/9');
  assert.match(cells[2].textContent, /^Opened .*2026/);
  assert.strictEqual(cells[3].textContent, 'Footer — A row.');
});

test('the footer row: a field order of the file\'s choosing, and a missing fact leaves its cell out', async () => {
  const data = { ...DATA, issue: null };
  const { el } = await setupFooter({ footerFor: () => ({ slug: 'g', fields: ['title', 'repo', 'issue'] }), data });
  await flush(); await flush();
  assert.deepStrictEqual(el.children.map(c => c.className), ['vf-cell vf-repo'], 'no issue: only the repo');
});

test('the footer row hides for a tab in no footer view, and while the view slot is up', async () => {
  const { el, state, mod, appMain } = await setupFooter({ footerFor: () => null, data: DATA });
  assert.ok(el.classList.contains('hidden'));
  assert.ok(!appMain.classList.contains('view-footer-open'));
  assert.deepStrictEqual(state.fetches, [], 'nothing to show, nothing fetched');

  state.footerFor = () => ({ slug: 'github', fields: ['repo'] });
  mod.render();
  await flush(); await flush();
  assert.ok(!el.classList.contains('hidden'));
  state.slotUp = true;
  mod.render();
  assert.ok(el.classList.contains('hidden'), 'a fullscreen view is up: no tab is on screen');
  state.slotUp = false;
  mod.render();
  assert.ok(!el.classList.contains('hidden'));
  assert.strictEqual(state.fetches.length, 1, 'switching back repaints from memory');
});

test('the footer row: a lookup that comes back empty (a tab that is no session) leaves no row', async () => {
  const { el, state, mod } = await setupFooter({ footerFor: () => ({ slug: 'github', fields: ['repo'] }), data: null });
  assert.ok(!el.classList.contains('hidden'), 'held open while asking');
  await flush(); await flush();
  assert.ok(el.classList.contains('hidden'), 'nothing came back: no row');
  mod.render();
  assert.ok(el.classList.contains('hidden'));
  assert.strictEqual(state.fetches.length, 1, 'and it is not asked again on every pass');
});

test('view-footer.js and project-views.js stay out of each other and out of app.js', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../../public/js', f), 'utf8');
  assert.ok(!/from '\.\/app\.js'/.test(read('view-footer.js')));
  assert.ok(!/from '\.\/project-views\.js'/.test(read('view-footer.js')), 'app.js injects footerFor');
  // switchTo() renders the footer BEFORE it fits the incoming terminal, or the fit sees the
  // wrong height and the row's arrival resizes the terminal a second time.
  const app = read('app.js');
  const sw = app.slice(app.indexOf('function switchTo(id)'));
  assert.ok(sw.indexOf('ViewFooter.render()') !== -1 && sw.indexOf('ViewFooter.render()') < sw.indexOf('fitTerminal('));
});
