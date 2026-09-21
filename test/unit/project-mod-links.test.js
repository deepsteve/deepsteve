// Unit test for the project-mod link type (#711): /v1/project-mod/<id>.
//
// A mod's page lives at /api/project-mods/<id>/page, which answers a plain 401 to any navigation
// that arrives without our SameSite=Strict cookie: a click from webmail, or a pasted `localhost`
// copy (Firefox drops Strict cookies after the canonical-host 302 to deepsteve.localhost). /v1
// paths get authGate's link bounce, so the link is what an email points at. links.js is tested on
// its own in links.test.js; this drives the Project Mods provider THROUGH a real link registry,
// with a fake ctx and scratch repos, the way workshop-decision-links.test.js drives Workshop's.
//
// Run: node --test test/unit/project-mod-links.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-project-mod-links-home-'));
process.env.HOME = HOME;
delete process.env.DEEPSTEVE_HOME;

const projectMods = require('../../mods/project-mods/tools.js');
const inbox = require('../../mods/workshop/inbox.js');
const { createLinks } = require('../../links.js');

// A real directory with a .git marker, so findGitRoot() canonicalizes to it. realpath because
// /var → /private/var on macOS, and findGitRoot realpaths.
const REPO = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-repo-links-'));
  fs.mkdirSync(path.join(root, '.git'));
  return fs.realpathSync(root);
})();

const registry = createLinks({ baseUrl: 'http://deepsteve.localhost:3000' });
const ctx = {
  shells: new Map(),
  settings: { projectModsEnabled: true },
  reloadClients: new Set(),
  log: () => {},
  broadcast: () => {},
  getContexts: () => [{ id: 'ctx-1', name: 'Alpha', dirs: [REPO] }],
  sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd }),
  links: registry,
  linkUrl: registry.urlFor,
};
const tools = projectMods.init(ctx);

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, location: null, contentType: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => { res.body = ''; return res; };
  res.redirect = (code, loc) => { res.statusCode = code; res.location = loc; return res; };
  return res;
}
const get = (type, id) => { const res = fakeRes(); registry.handleGet({ params: { type, id }, body: {} }, res); return res; };
const post = (type, id, body = {}) => { const res = fakeRes(); registry.handlePost({ params: { type, id }, body }, res); return res; };
const payload = (result) => JSON.parse(result.content[0].text);
const create = async (name, html = '<p>page</p>') =>
  payload(await tools.create_project_mod.handler({ name, project: REPO, html }, {}));

// The REST routes, captured off a minimal fake app, so a redirect can be followed to the page.
const routes = new Map();
projectMods.registerRoutes({
  get: (p, h) => routes.set(`GET ${p}`, h),
  put: (p, h) => routes.set(`PUT ${p}`, h),
  delete: (p, h) => routes.set(`DELETE ${p}`, h),
}, ctx);
function rest(key, params = {}) {
  const res = fakeRes();
  routes.get(key)({ params, body: {}, method: 'GET' }, res);
  return res;
}

test('Project Mods registers itself as a link provider', () => {
  assert.deepStrictEqual(registry._providers.map((p) => p.name), ['project-mods']);
});

test('create, list and refresh all hand an agent the /v1 link on the canonical origin', async () => {
  const made = await create('Link Dash');
  const want = `http://deepsteve.localhost:3000/v1/project-mod/${made.id}`;
  assert.strictEqual(made.url, want);
  assert.strictEqual(made.url, registry.urlFor('project-mod', made.id));

  const listed = payload(await tools.list_project_mods.handler({ project: REPO }, {}));
  assert.strictEqual(listed.mods.find((m) => m.id === made.id).url, want);

  const refreshed = payload(await tools.refresh_project_mods.handler({ project: REPO }, {}));
  assert.strictEqual(refreshed.mods.find((m) => m.id === made.id).url, want);
});

test('the browser list does not carry the link — its wire shape is unchanged', async () => {
  const made = await create('Wire Shape');
  const row = rest('GET /api/project-mods').body.mods.find((m) => m.id === made.id);
  assert.ok(row, 'the mod is listed');
  assert.ok(!('url' in row), 'url is agent-only');
});

test('a GET redirects to the page the rail already loads, and that page is served', async () => {
  const made = await create('Redirected', '<p id="x">REDIRECT-TARGET</p>');
  const res = get('project-mod', made.id);
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.location, `/api/project-mods/${made.id}/page`);
  assert.strictEqual(res.headers['cache-control'], 'no-store');

  const [, id] = /^\/api\/project-mods\/([^/]+)\/page$/.exec(res.location);
  const page = rest('GET /api/project-mods/:id/page', { id });
  assert.match(String(page.body), /REDIRECT-TARGET/);
});

test('a mod that no longer exists explains itself instead of a bare 404', async () => {
  const made = await create('Soon Gone');
  payload(await tools.delete_project_mod.handler({ mod_id: made.id }, {}));
  const res = get('project-mod', made.id);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.contentType, 'html');
  assert.match(res.body, /Nothing found/);
});

test('only the exact id modId() mints is owned, and it is disjoint from Workshop ids', () => {
  const provider = registry._providers.find((p) => p.name === 'project-mods');
  assert.strictEqual(provider.owns('015dd1f5'), true);
  for (const id of ['015DD1F5', '015dd1f', '015dd1f5a', 'w12', '4b0c4d1e-0000-4000-8000-000000000000']) {
    assert.strictEqual(provider.owns(id), false, id);
  }
  // Two owners of one id would make /v1 resolution depend on registration order.
  assert.strictEqual(inbox.isItemId('015dd1f5'), false);
});

test('a link naming the wrong type is redirected to the project-mod link (rule 1)', async () => {
  const made = await create('Wrong Type');
  const res = get('decision', made.id);
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.location, `/v1/project-mod/${made.id}`);
});

test('a POST is never served — the link only opens', async () => {
  const made = await create('Read Only');
  const res = post('project-mod', made.id, { action: 'answer' });
  assert.ok(res.statusCode >= 400, `expected a refusal, got ${res.statusCode}`);
  assert.ok(res.body && res.body.error, 'a JSON error, not the page');
});

test('a mod turned off still opens from its link, as its page route still serves it', async () => {
  const made = await create('Switched Off');
  payload(await tools.update_project_mod.handler({ mod_id: made.id, enabled: false }, {}));
  assert.strictEqual(get('project-mod', made.id).statusCode, 302);
});

// Last: it swaps the module's ctx for one with no link registry.
test('without a link registry the tools still load and url is null', async () => {
  const bare = projectMods.init({ ...ctx, links: undefined, linkUrl: undefined });
  const made = payload(await bare.create_project_mod.handler({ name: 'No Registry', project: REPO, html: '<p/>' }, {}));
  assert.strictEqual(made.url, null);
});
