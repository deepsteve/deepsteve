// Unit tests for project views (#726) — the server half, in mods/project-mods/tools.js.
//
// A project view is a named view of a project's tabs, defined in the project's repo at
// `<root>/.deepsteve/views/<slug>.json` and found by the same scan of the registered
// projects' repos that finds project mods. No browser, no daemon: stub the initMCP context,
// call the MCP handlers and REST routes directly, and assert against both what they return
// and what actually landed on disk.
//
// Run: node --test test/unit/project-views.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-project-views-home-'));
process.env.HOME = HOME;

const mod = require('../../mods/project-mods/tools.js');
const {
  init, registerRoutes, scan, cleanViewSlug, slugifyView, cleanMatch, cleanViewPath, normalizeView,
  cleanSpawnView, serializeView, viewManifestOf, RESERVED_VIEW,
} = mod;

// ------------------------------------------------------------------- fixtures

function makeRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ds-views-repo-${name}-`));
  fs.mkdirSync(path.join(root, '.git'));
  return fs.realpathSync(root);
}

const REPO_A = makeRepo('a');
const REPO_B = makeRepo('b');
const REPO_UNREGISTERED = makeRepo('unregistered');

const viewsDirOf = (root) => path.join(root, '.deepsteve', 'views');
const fileOf = (root, slug) => path.join(viewsDirOf(root), `${slug}.json`);
const readFile = (root, slug) => JSON.parse(fs.readFileSync(fileOf(root, slug), 'utf8'));

const broadcasts = [];
const settings = { projectModsEnabled: true };
const shells = new Map([
  ['sess-a', { cwd: REPO_A }],
  ['sess-a-wt', { cwd: REPO_A, worktree: 'github-issue-9' }],
  ['sess-x', { cwd: REPO_UNREGISTERED }],
]);
const contexts = [
  { id: 'ctx-1', name: 'Alpha', dirs: [REPO_A] },
  { id: 'ctx-2', name: 'Two repos', dirs: [REPO_B, REPO_A] },
];
const ctx = {
  shells,
  settings,
  reloadClients: new Set(),
  log: () => {},
  broadcast: (m) => broadcasts.push(m),
  getContexts: () => contexts,
  sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd }),
};

const tools = init(ctx);
const payload = (res) => JSON.parse(res.content[0].text);

function makeApp() {
  const routes = new Map();
  const record = (method) => (p, h) => routes.set(`${method} ${p}`, h);
  return {
    get: record('GET'), put: record('PUT'), delete: record('DELETE'), post: record('POST'),
    call(key, { params = {}, body = {} } = {}) {
      const handler = routes.get(key);
      assert.ok(handler, `no route for ${key}`);
      const res = { statusCode: 200, body: null };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (v) => { res.body = v; return res; };
      res.send = (v) => { res.body = v; return res; };
      handler({ params, body }, res);
      return res;
    },
    keys: () => [...routes.keys()],
  };
}
const app = makeApp();
registerRoutes(app, ctx);

async function createView(args) {
  const res = await tools.create_project_view.handler(args, {});
  assert.ok(!res.isError, `create failed: ${res.content[0].text}`);
  return payload(res);
}

async function deleteAll() {
  const listed = payload(await tools.list_project_views.handler({ scope: 'all' }, {}));
  for (const v of listed.views) await tools.delete_project_view.handler({ view: v.slug, project: v.project }, {});
}

// ------------------------------------------------------------------ validation

test('slugs: lowercase, filename-safe, and never the reserved "all"', () => {
  assert.strictEqual(cleanViewSlug('marketing'), 'marketing');
  assert.strictEqual(cleanViewSlug(' Marketing '), 'marketing');
  assert.strictEqual(cleanViewSlug('all'), '');
  assert.strictEqual(cleanViewSlug('ALL'), '');
  assert.strictEqual(cleanViewSlug('../etc'), '');
  assert.strictEqual(cleanViewSlug('-lead'), '');
  assert.strictEqual(cleanViewSlug('a'.repeat(41)), '');
  assert.strictEqual(slugifyView('Growth & Ads!'), 'growth-ads');
  assert.strictEqual(slugifyView('All'), '', 'derived "all" is still reserved');
  assert.strictEqual(slugifyView('📣'), '', 'nothing to derive from');
  assert.strictEqual(RESERVED_VIEW, 'all');
});

test('paths stay inside the repo; "." is the whole repo', () => {
  assert.strictEqual(cleanViewPath('site'), 'site');
  assert.strictEqual(cleanViewPath('./site/'), 'site');
  assert.strictEqual(cleanViewPath('.'), '');
  assert.strictEqual(cleanViewPath('docs\\blog'), 'docs/blog', 'backslashes normalized first');
  assert.strictEqual(cleanViewPath('/abs'), null);
  assert.strictEqual(cleanViewPath('../sibling'), null);
  assert.strictEqual(cleanViewPath('a/../../b'), null);
  assert.strictEqual(cleanViewPath('..\\x'), null);
  assert.strictEqual(cleanViewPath(''), null);
});

test('cleanMatch: rules OR\'d, fields kept per rule, and a rule that loses a stated field is dropped whole', () => {
  assert.deepStrictEqual(cleanMatch({ names: ['SEO'] }), [{ names: ['seo'] }], 'a bare object is one rule');
  assert.deepStrictEqual(cleanMatch([{ names: ['A', 'a', ' '] }, { kinds: ['display-tab', 'bogus'] }]),
    [{ names: ['a'] }, { kinds: ['display-tab'] }], 'deduped, lowercased, unknown kinds dropped');
  // The narrowing case: the path is invalid, so the rule must NOT widen into "every display tab".
  assert.deepStrictEqual(cleanMatch([{ kinds: ['display-tab'], paths: ['../elsewhere'] }]), []);
  assert.deepStrictEqual(cleanMatch([{}, null, 'x', [1]]), [], 'nothing usable');
  assert.deepStrictEqual(cleanMatch(undefined), [], 'no rules is legal: a manual view');
  assert.strictEqual(cleanMatch(Array.from({ length: 40 }, (_, i) => ({ names: [`n${i}`] }))).length, 16, 'rule cap');
  assert.strictEqual(cleanMatch([{ names: Array.from({ length: 50 }, (_, i) => `n${i}`) }])[0].names.length, 32, 'item cap');
});

test('normalizeView defaults, and the file shape leaves empty icon / zero order out', () => {
  const v = normalizeView({ match: [{ names: ['x'] }] }, REPO_A, 'mkt');
  assert.strictEqual(v.name, 'mkt', 'name falls back to the slug');
  assert.strictEqual(v.order, 0);
  assert.strictEqual(v.file, fileOf(REPO_A, 'mkt'));
  assert.deepStrictEqual(viewManifestOf(v), { name: 'mkt', match: [{ names: ['x'] }] });
  assert.strictEqual(normalizeView({}, REPO_A, 'all'), null);
  assert.strictEqual(normalizeView([], REPO_A, 'ok'), null);
  assert.strictEqual(normalizeView({ order: 9e9 }, REPO_A, 'ok').order, 1e6, 'order clamped');
  assert.deepStrictEqual(Object.keys(serializeView(v)).sort(), ['icon', 'id', 'match', 'name', 'order', 'project', 'slug'], 'no root/file on the wire');
});

test('cleanSpawnView: undefined = inherit, "all" = none, otherwise a slug or an error', () => {
  assert.deepStrictEqual(cleanSpawnView(undefined), { view: undefined });
  assert.deepStrictEqual(cleanSpawnView(''), { view: undefined });
  assert.deepStrictEqual(cleanSpawnView('ALL'), { view: 'all' });
  assert.deepStrictEqual(cleanSpawnView(' Marketing '), { view: 'marketing' });
  assert.ok(cleanSpawnView('Bad Slug').error);
  assert.ok(cleanSpawnView(3).error);
});

// ----------------------------------------------------------------------- tools

test('create_project_view writes one JSON file in the caller\'s repo, pings, and reminds to commit', async () => {
  await deleteAll();
  broadcasts.length = 0;
  const out = await createView({ session_id: 'sess-a', name: 'Marketing', icon: '📣', match: [{ names: ['SEO', 'marketing'] }] });
  assert.strictEqual(out.slug, 'marketing');
  assert.strictEqual(out.project, REPO_A);
  assert.strictEqual(out.path, path.join('.deepsteve', 'views', 'marketing.json'));
  assert.match(out.commitReminder, /Commit \.deepsteve\/views\/marketing\.json/);
  assert.strictEqual(out.worktreeNote, undefined);
  assert.deepStrictEqual(readFile(REPO_A, 'marketing'), { name: 'Marketing', icon: '📣', match: [{ names: ['seo', 'marketing'] }] });
  assert.ok(fs.readFileSync(fileOf(REPO_A, 'marketing'), 'utf8').endsWith('}\n'), 'trailing newline, like a hand-written file');
  assert.deepStrictEqual(broadcasts.at(-1), { type: 'project-mods' }, 'the shared ping');
  assert.ok(!fs.existsSync(path.join(HOME, '.deepsteve', 'views')), 'nothing under HOME');
});

test('create refuses a duplicate, the reserved name, an unregistered repo, and no project at all', async () => {
  await deleteAll();
  await createView({ project: REPO_A, name: 'Analytics' });
  const dup = await tools.create_project_view.handler({ project: REPO_A, name: 'analytics' }, {});
  assert.ok(dup.isError);
  assert.match(dup.content[0].text, /already exists.*update_project_view/);
  const all = await tools.create_project_view.handler({ project: REPO_A, name: 'All' }, {});
  assert.ok(all.isError);
  assert.match(all.content[0].text, /built-in/);
  const unreg = await tools.create_project_view.handler({ session_id: 'sess-x', name: 'X' }, {});
  assert.ok(unreg.isError);
  assert.match(unreg.content[0].text, /not part of any registered project/);
  assert.ok(!fs.existsSync(viewsDirOf(REPO_UNREGISTERED)));
  const none = await tools.create_project_view.handler({ name: 'X' }, {});
  assert.ok(none.isError);
});

test('a worktree caller is told the file landed in the main checkout', async () => {
  await deleteAll();
  const out = await createView({ session_id: 'sess-a-wt', name: 'Launch' });
  assert.strictEqual(out.project, REPO_A);
  assert.match(out.worktreeNote, /worktree.*main checkout.*commit/s);
});

test('update replaces only what it is given; the slug never changes', async () => {
  await deleteAll();
  await createView({ project: REPO_A, name: 'Marketing', match: [{ names: ['seo'] }] });
  const res = await tools.update_project_view.handler({ project: REPO_A, view: 'marketing', name: 'Growth', order: 3 }, {});
  assert.ok(!res.isError, res.content[0].text);
  assert.deepStrictEqual(readFile(REPO_A, 'marketing'), { name: 'Growth', order: 3, match: [{ names: ['seo'] }] });
  await tools.update_project_view.handler({ project: REPO_A, view: 'marketing', match: [] }, {});
  assert.deepStrictEqual(readFile(REPO_A, 'marketing').match, [], 'match replaces the whole list');
  const missing = await tools.update_project_view.handler({ project: REPO_A, view: 'nope' }, {});
  assert.ok(missing.isError);
  assert.match(missing.content[0].text, /Views here: marketing/);
});

test('delete removes the file and prunes empty dirs, but never a sibling .deepsteve/mods', async () => {
  await deleteAll();
  await createView({ project: REPO_B, name: 'Ops' });
  const res = await tools.delete_project_view.handler({ project: REPO_B, view: 'ops' }, {});
  assert.ok(!res.isError);
  assert.ok(!fs.existsSync(path.join(REPO_B, '.deepsteve')), 'empty .deepsteve pruned');

  fs.mkdirSync(path.join(REPO_A, '.deepsteve', 'mods', 'keep'), { recursive: true });
  await createView({ project: REPO_A, name: 'Temp' });
  await tools.delete_project_view.handler({ project: REPO_A, view: 'temp' }, {});
  assert.ok(fs.existsSync(path.join(REPO_A, '.deepsteve', 'mods', 'keep')), 'the mods dir survives');
  assert.ok(!fs.existsSync(viewsDirOf(REPO_A)));
  fs.rmSync(path.join(REPO_A, '.deepsteve'), { recursive: true, force: true });
});

test('views are not gated by projectModsEnabled — they are data, not agent HTML', async () => {
  await deleteAll();
  settings.projectModsEnabled = false;
  try {
    const out = await createView({ project: REPO_A, name: 'Still works' });
    assert.strictEqual(out.slug, 'still-works');
  } finally {
    settings.projectModsEnabled = true;
  }
});

// ---------------------------------------------------------------- scan / list

test('the scan takes only valid <slug>.json files and skips everything else', async () => {
  await deleteAll();
  const dir = viewsDirOf(REPO_A);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ name: 'Good' }));
  fs.writeFileSync(path.join(dir, 'Upper.json'), JSON.stringify({ name: 'Upper' }));
  fs.writeFileSync(path.join(dir, 'all.json'), JSON.stringify({ name: 'All' }));
  fs.writeFileSync(path.join(dir, 'half.json.tmp'), '{');
  fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'huge.json'), JSON.stringify({ name: 'x'.repeat(70 * 1024) }));
  fs.mkdirSync(path.join(dir, 'adir.json'));
  scan();
  const listed = payload(await tools.list_project_views.handler({ project: REPO_A }, {}));
  assert.deepStrictEqual(listed.views.map(v => v.slug), ['good']);
  fs.rmSync(path.join(REPO_A, '.deepsteve'), { recursive: true, force: true });
  scan();
});

test('the same slug in two repos lists twice (the client merges per project); sorted by order then name', async () => {
  await deleteAll();
  await createView({ project: REPO_A, name: 'Marketing', order: 1 });
  await createView({ project: REPO_B, name: 'Marketing', order: 1 });
  await createView({ project: REPO_A, name: 'Analytics', order: 0 });
  const res = app.call('GET /api/project-views');
  assert.deepStrictEqual(res.body.views.map(v => `${v.slug}@${v.project === REPO_A ? 'A' : 'B'}`), ['analytics@A', 'marketing@A', 'marketing@B']);
  assert.ok(res.body.views.every(v => !('file' in v) && !('root' in v)));
});

test('a view written by hand appears after refresh_project_mods, which also lists it', async () => {
  await deleteAll();
  fs.mkdirSync(viewsDirOf(REPO_A), { recursive: true });
  fs.writeFileSync(fileOf(REPO_A, 'by-hand'), JSON.stringify({ name: 'By hand', match: [{ kinds: ['agent'] }] }));
  broadcasts.length = 0;
  const out = payload(await tools.refresh_project_mods.handler({ project: REPO_A }, {}));
  assert.deepStrictEqual(out.views.map(v => v.slug), ['by-hand']);
  assert.strictEqual(out.views[0].path, path.join('.deepsteve', 'views', 'by-hand.json'));
  assert.deepStrictEqual(broadcasts.at(-1), { type: 'project-mods' });
});

// ------------------------------------------------------------------------- REST

test('POST /api/project-views makes a rule-less view in the project\'s repo holding the cwd', async () => {
  await deleteAll();
  const res = app.call('POST /api/project-views', { body: { contextId: 'ctx-2', name: 'Launch', cwd: path.join(REPO_A, 'src') } });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.view.project, REPO_A, 'the repo the tab is in, not the project\'s first folder');
  assert.deepStrictEqual(readFile(REPO_A, 'launch'), { name: 'Launch', match: [] });

  const first = app.call('POST /api/project-views', { body: { contextId: 'ctx-2', name: 'Ops' } });
  assert.strictEqual(first.body.view.project, REPO_B, 'no cwd: the first folder');

  assert.strictEqual(app.call('POST /api/project-views', { body: { contextId: 'ctx-2', name: 'Launch', cwd: REPO_A } }).statusCode, 409);
  assert.strictEqual(app.call('POST /api/project-views', { body: { contextId: 'nope', name: 'X' } }).statusCode, 404);
  assert.strictEqual(app.call('POST /api/project-views', { body: { contextId: 'ctx-1', name: '' } }).statusCode, 400);
});

test('PUT renames (never the slug) and DELETE removes, by id', async () => {
  await deleteAll();
  const made = app.call('POST /api/project-views', { body: { contextId: 'ctx-1', name: 'Launch' } }).body.view;
  const put = app.call('PUT /api/project-views/:id', { params: { id: made.id }, body: { name: 'Big launch', icon: '🚀' } });
  assert.strictEqual(put.body.view.name, 'Big launch');
  assert.deepStrictEqual(readFile(REPO_A, 'launch'), { name: 'Big launch', icon: '🚀', match: [] });
  assert.strictEqual(app.call('PUT /api/project-views/:id', { params: { id: made.id }, body: { name: '  ' } }).statusCode, 400);
  const del = app.call('DELETE /api/project-views/:id', { params: { id: made.id } });
  assert.strictEqual(del.body.deleted, true);
  assert.ok(!fs.existsSync(fileOf(REPO_A, 'launch')));
  assert.strictEqual(app.call('DELETE /api/project-views/:id', { params: { id: made.id } }).statusCode, 404);
});
