// Unit tests for Project Mods (#618, #628, #638) — mods/project-mods/tools.js.
//
// No browser, no daemon: stub the initMCP context, call the MCP handlers directly, and
// assert against both the returned payload and what actually landed on disk.
//
// Since #638 a project mod is stored IN ITS REPO, at <root>/.deepsteve/mods/<dirname>/, and
// discovered by scanning the repos of REGISTERED PROJECTS. So the fixtures here are scratch
// repos plus a `getContexts` stub naming them — there is no HOME-rooted registry left to
// point at, and the tests assert nothing is ever written under HOME.
//
// Run: node --test test/unit/project-mods.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-project-mods-home-'));
process.env.HOME = HOME;

const mod = require('../../mods/project-mods/tools.js');
const {
  init, registerRoutes, normalize, cleanSurfaces, cleanIcon, cleanName, cleanEntry,
  cleanOpenMode, cleanPlacement, effectiveOpenMode, scan, modId, slugify, resolveInMod, serialize,
  PROJECT_SCOPE, MANIFEST_FILE, DEFAULT_ENTRY, FEATURE_OFF_MSG,
} = mod;

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

// ------------------------------------------------------------------- fixtures

// A real directory with a .git marker, so findGitRoot() canonicalizes to it.
function makeRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ds-repo-${name}-`));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  // findGitRoot realpaths, and /var → /private/var on macOS.
  return fs.realpathSync(root);
}

const REPO_A = makeRepo('a');
const REPO_B = makeRepo('b');
// Deliberately NOT named by any context: the repo a create must refuse.
const REPO_UNREGISTERED = makeRepo('unregistered');

const modsDirOf = (root) => path.join(root, '.deepsteve', 'mods');
const dirOf = (root, dirname) => path.join(modsDirOf(root), dirname);

const broadcasts = [];
const settings = { projectModsEnabled: true };
const shells = new Map([
  ['sess-a', { cwd: REPO_A }],
  ['sess-a-sub', { cwd: path.join(REPO_A, 'src') }],
  ['sess-b', { cwd: REPO_B }],
  ['sess-x', { cwd: REPO_UNREGISTERED }],
]);

const contexts = [
  { id: 'ctx-1', name: 'Alpha', dirs: [REPO_A] },
  { id: 'ctx-2', name: 'Beta', dirs: [REPO_B] },
];

const ctx = {
  shells,
  settings,
  reloadClients: new Set(),
  log: () => {},
  broadcast: (m) => broadcasts.push(m),
  // Discovery is bounded by the registered projects, and this is the only thing that
  // tells the mod what those are.
  getContexts: () => contexts,
  // The real sessionPaths strips a worktree suffix; for these fixtures cwd IS the root.
  sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd }),
};

const tools = init(ctx);

const payload = (res) => JSON.parse(res.content[0].text);

/** The manifest as it actually sits in the repo — the thing #638 is about. */
const manifestOf = (root, dirname) =>
  JSON.parse(fs.readFileSync(path.join(dirOf(root, dirname), MANIFEST_FILE), 'utf8'));

const pageOf = (root, dirname, entry = DEFAULT_ENTRY) =>
  fs.readFileSync(path.join(dirOf(root, dirname), entry), 'utf8');

async function create(args) {
  const res = await tools.create_project_mod.handler(args, {});
  assert.ok(!res.isError, `create failed: ${res.content[0].text}`);
  const out = payload(res);
  // `path` is repo-relative; the dirname is its last segment.
  out.dirname = path.basename(out.path);
  return out;
}

// The module caches one scan across tests, so tests clean up after themselves rather
// than assuming an empty start.
async function deleteAll() {
  const listed = payload(await tools.list_project_mods.handler({ scope: 'all' }, {}));
  for (const m of listed.mods) await tools.delete_project_mod.handler({ mod_id: m.id }, {});
}

// ------------------------------------------------------------------ validation

test('cleanSurfaces keeps only known surfaces, in canonical order, and never empties', () => {
  assert.deepStrictEqual(cleanSurfaces(['tab', 'rail']), ['rail', 'tab'], 'canonical order, not input order');
  assert.deepStrictEqual(cleanSurfaces(['button']), ['button']);
  assert.deepStrictEqual(cleanSurfaces(['bogus']), ['rail'], 'all-unknown falls back to the default');
  assert.deepStrictEqual(cleanSurfaces([]), ['rail'], 'empty falls back — a mod with no surface is unreachable');
  assert.deepStrictEqual(cleanSurfaces(undefined), ['rail']);
  assert.deepStrictEqual(cleanSurfaces('rail'), ['rail'], 'a non-array is not silently spread into characters');
});

test('cleanOpenMode defaults to "view" for anything it does not recognize', () => {
  assert.strictEqual(cleanOpenMode('view'), 'view');
  assert.strictEqual(cleanOpenMode('tab'), 'tab');
  assert.strictEqual(cleanOpenMode(undefined), 'view', 'a manifest that never stated one');
  assert.strictEqual(cleanOpenMode('bogus'), 'view');
  assert.strictEqual(cleanOpenMode(['view']), 'view', 'a non-string is not coerced');
});

test('cleanPlacement keeps openMode:"view" and the "tab" surface from both being in force', () => {
  // Nothing to resolve: tab mode keeps every surface it was given.
  assert.deepStrictEqual(cleanPlacement(['rail', 'tab'], 'tab'), { surfaces: ['rail', 'tab'], openMode: 'tab' });
  // A view cannot also be a pinned background tab — with openMode the deliberate field
  // (or both of them, which is create), the surface goes.
  assert.deepStrictEqual(cleanPlacement(['rail', 'tab'], 'view'), { surfaces: ['rail'], openMode: 'view' });
  // …and the list is still never emptied.
  assert.deepStrictEqual(cleanPlacement(['tab'], 'view'), { surfaces: ['rail'], openMode: 'view' });
  // Ticking "Open as a full view" on a pinned mod is that same deliberate write:
  assert.deepStrictEqual(
    cleanPlacement(['rail', 'tab'], 'view', 'openMode'),
    { surfaces: ['rail'], openMode: 'view' },
  );
  // A surfaces-only write is the one that does NOT resolve the pair (#645). Ticking "Pin as
  // a background tab" on a view stores both: the pin overrides the mode rather than
  // overwriting it, which is the only reason un-ticking can put the view back.
  assert.deepStrictEqual(
    cleanPlacement(['rail', 'tab'], 'view', 'surfaces'),
    { surfaces: ['rail', 'tab'], openMode: 'view' },
  );
});

test('effectiveOpenMode: the pin wins while it is set, and only while (#645)', () => {
  assert.strictEqual(effectiveOpenMode({ surfaces: ['rail', 'tab'], openMode: 'view' }), 'tab');
  assert.strictEqual(effectiveOpenMode({ surfaces: ['rail'], openMode: 'view' }), 'view',
    'un-pinning restores the stored mode with nothing to undo');
  assert.strictEqual(effectiveOpenMode({ surfaces: ['rail', 'tab'], openMode: 'tab' }), 'tab');
  assert.strictEqual(effectiveOpenMode({ surfaces: ['rail'], openMode: 'tab' }), 'tab');
});

test('normalize: scope:"project" is what makes a directory ours (#638)', () => {
  const ours = normalize({ scope: PROJECT_SCOPE, name: 'Dash' }, '/repo/alpha', 'dash');
  assert.ok(ours, 'a manifest with the marker is adopted');
  assert.strictEqual(ours.project, '/repo/alpha');
  assert.strictEqual(ours.dirname, 'dash');

  // A repo may ship a regular DeepSteve Mod in the same directory. We do not adopt it,
  // and — since every write path goes through a row we produced — we never touch it.
  assert.strictEqual(normalize({ name: 'Regular', version: '1.0.0' }, '/repo/alpha', 'regular'), null);
  assert.strictEqual(normalize({ scope: 'global', name: 'X' }, '/repo/alpha', 'x'), null);
  assert.strictEqual(normalize(null, '/repo/alpha', 'x'), null);
});

test('normalize rejects a directory name that could escape or hide', () => {
  const ok = (d) => normalize({ scope: PROJECT_SCOPE, name: 'D' }, '/repo/alpha', d);
  assert.ok(ok('build-dashboard'));
  assert.ok(ok('a.b_c-1'));
  assert.strictEqual(ok('..'), null);
  assert.strictEqual(ok('.hidden'), null, 'must start alphanumeric');
  assert.strictEqual(ok('a/b'), null);
  assert.strictEqual(ok(''), null);
});

test('a manifest with no openMode loads as "view", and a pinned one still opens as a tab', () => {
  // Every manifest is read through normalize(), so this IS what happens to a repo whose
  // mods predate the mode. There is no migration step; the default simply moved to 'view'.
  const row = normalize({ scope: PROJECT_SCOPE, name: 'Dash', surfaces: ['rail', 'tab'] }, '/repo/alpha', 'dash');
  assert.strictEqual(row.openMode, 'view', 'the default the manifest never stated');
  assert.deepStrictEqual(row.surfaces, ['rail', 'tab'], 'and the pin it already had survives');
  // The pin is what makes moving the default safe: this mod opens exactly as it always
  // did, because effectiveOpenMode lets the surface override the mode it never chose.
  assert.strictEqual(effectiveOpenMode(row), 'tab', 'so its behaviour is unchanged');

  // A rail-only mod that never stated a mode is the case the new default is FOR: it used
  // to take a tab nobody asked for, and now glances instead.
  const railOnly = normalize({ scope: PROJECT_SCOPE, name: 'Dash', surfaces: ['rail'] }, '/repo/alpha', 'dash');
  assert.strictEqual(effectiveOpenMode(railOnly), 'view');

  // A pinned view is a legal thing to find on disk since #645 — the loader must keep the
  // pair verbatim, or the very next scan would undo the override the user just set.
  const pinnedView = normalize(
    { scope: PROJECT_SCOPE, surfaces: ['rail', 'tab'], openMode: 'view' }, '/repo/alpha', 'dash');
  assert.strictEqual(pinnedView.openMode, 'view', 'the stored mode survives the scan');
  assert.deepStrictEqual(pinnedView.surfaces, ['rail', 'tab'], 'and so does the pin overriding it');
  assert.strictEqual(effectiveOpenMode(pinnedView), 'tab', 'while behaving as a tab');
  assert.strictEqual(pinnedView.name, 'dash', 'a nameless manifest falls back to its directory name');
});

test('cleanName / cleanIcon strip control characters and cap length', () => {
  assert.strictEqual(cleanName('  Build Dashboard \n'), 'Build Dashboard');
  assert.strictEqual(cleanName('a' + NUL + 'bc'), 'abc');
  assert.strictEqual(cleanName('a' + DEL + 'bc'), 'abc');
  assert.strictEqual(cleanName('x'.repeat(200)).length, 60);
  assert.strictEqual(cleanName(undefined), '');
  // Sliced by code point, so a surrogate pair is never cut in half.
  assert.strictEqual(cleanIcon('📊'), '📊');
  assert.strictEqual(cleanIcon('📊📈📉📊📈📉📊📈📉📊'), [...'📊📈📉📊📈📉📊📈'].join(''));
  assert.strictEqual(cleanIcon(''), '');
});

test('cleanEntry defaults, and refuses anything that leaves the mod directory', () => {
  assert.strictEqual(cleanEntry(undefined), DEFAULT_ENTRY);
  assert.strictEqual(cleanEntry('  '), DEFAULT_ENTRY);
  assert.strictEqual(cleanEntry('dashboard.html'), 'dashboard.html');
  assert.strictEqual(cleanEntry('pages/main.html'), 'pages/main.html', 'a subdirectory entry is fine');
  assert.strictEqual(cleanEntry('../../etc/passwd'), DEFAULT_ENTRY);
  assert.strictEqual(cleanEntry('/etc/passwd'), DEFAULT_ENTRY);
  // Backslashes are normalized BEFORE the check, so a Windows-style traversal can't
  // slip past a '/'-oriented test.
  assert.strictEqual(cleanEntry('..\\..\\etc\\passwd'), DEFAULT_ENTRY);
});

test('slugify produces a readable directory name, or a safe fallback', () => {
  assert.strictEqual(slugify('Build Dashboard'), 'build-dashboard');
  assert.strictEqual(slugify('Pulse!!'), 'pulse');
  assert.strictEqual(slugify('  ...  '), 'project-mod', 'a name with nothing usable still yields a legal dir');
  assert.strictEqual(slugify('📊'), 'project-mod');
  assert.ok(slugify('x'.repeat(200)).length <= 48);
});

// ------------------------------------------------------------------- discovery

test('a mod id is derived from its repo root and directory name, never stored', async () => {
  const a = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });

  assert.strictEqual(a.id, modId(REPO_A, a.dirname), 'derived, so it survives a restart');
  assert.notStrictEqual(modId(REPO_A, a.dirname), modId(REPO_B, a.dirname),
    'two checkouts of the same repo cannot collide on one URL');
  assert.ok(/^[a-zA-Z0-9_-]{1,32}$/.test(a.id), 'still the id shape everything downstream expects');

  // Nothing on disk carries it — that is what makes the derivation the single source.
  assert.ok(!('id' in manifestOf(REPO_A, a.dirname)));
  await deleteAll();
});

test('the scan skips a directory that is not marked scope:"project"', async () => {
  const mine = await create({ name: 'Mine', session_id: 'sess-a', html: '<p>x</p>' });

  // Somebody distributes a regular DeepSteve Mod inside their repo.
  const theirs = dirOf(REPO_A, 'somebody-elses');
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, MANIFEST_FILE), JSON.stringify({ name: 'Regular', version: '1.0.0' }));
  // …and a directory with no manifest at all.
  fs.mkdirSync(dirOf(REPO_A, 'no-manifest'), { recursive: true });
  scan();

  const listed = payload(await tools.list_project_mods.handler({ session_id: 'sess-a' }, {}));
  assert.deepStrictEqual(listed.mods.map(m => m.id), [mine.id], 'only ours is adopted');

  await deleteAll();
  assert.ok(fs.existsSync(theirs), 'and deleting every project mod leaves it strictly alone');
  fs.rmSync(theirs, { recursive: true, force: true });
  fs.rmSync(dirOf(REPO_A, 'no-manifest'), { recursive: true, force: true });
});

test('only the repos of REGISTERED projects are scanned', async () => {
  // Hand-write a perfectly valid mod into a repo no context names.
  const dir = dirOf(REPO_UNREGISTERED, 'ghost');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ scope: PROJECT_SCOPE, name: 'Ghost' }));
  fs.writeFileSync(path.join(dir, DEFAULT_ENTRY), '<p>ghost</p>');
  scan();

  const all = payload(await tools.list_project_mods.handler({ scope: 'all' }, {}));
  assert.deepStrictEqual(all.mods, [], 'the daemon does not walk the disk looking for mods');

  // Register it, and it appears with no other action.
  contexts.push({ id: 'ctx-3', name: 'Gamma', dirs: [REPO_UNREGISTERED] });
  scan();
  const now = payload(await tools.list_project_mods.handler({ scope: 'all' }, {}));
  assert.deepStrictEqual(now.mods.map(m => m.name), ['Ghost'], 'a fresh clone lights up once its project exists');

  contexts.pop();
  await deleteAll();
  fs.rmSync(path.join(REPO_UNREGISTERED, '.deepsteve'), { recursive: true, force: true });
});

test('a project registered as a SUBDIRECTORY still finds the repo root mods', async () => {
  const a = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  contexts[0].dirs = [path.join(REPO_A, 'src')];
  try {
    scan();
    const all = payload(await tools.list_project_mods.handler({ scope: 'all' }, {}));
    assert.deepStrictEqual(all.mods.map(m => m.id), [a.id], 'each dir is canonicalized to its git root');
  } finally {
    contexts[0].dirs = [REPO_A];
    scan();
  }
  await deleteAll();
});

// --------------------------------------------------------------------- create

test('create_project_mod writes into the repo and infers the project from the session', async () => {
  const { id, project, surfaces, dirname, path: rel, commitReminder } =
    await create({ name: 'Build Dashboard', session_id: 'sess-a', html: '<h1>hi</h1>' });

  assert.strictEqual(project, REPO_A);
  assert.deepStrictEqual(surfaces, ['rail'], 'defaults to the rail surface');
  assert.strictEqual(dirname, 'build-dashboard', 'the directory name is derived from the display name');
  assert.strictEqual(rel, path.join('.deepsteve', 'mods', 'build-dashboard'));
  assert.match(commitReminder, /commit/i, 'the mod is a repo file now, and the agent is told so');

  assert.strictEqual(pageOf(REPO_A, dirname), '<h1>hi</h1>');
  const manifest = manifestOf(REPO_A, dirname);
  assert.strictEqual(manifest.scope, PROJECT_SCOPE);
  assert.strictEqual(manifest.name, 'Build Dashboard');
  assert.strictEqual(manifest.enabled, true);
  assert.strictEqual(manifest.entry, DEFAULT_ENTRY);
  assert.ok(manifest.createdAt > 0);

  // The whole point of #638: nothing lands in the state dir.
  assert.strictEqual(fs.existsSync(path.join(HOME, '.deepsteve', 'project-mods')), false);
  assert.strictEqual(fs.existsSync(path.join(HOME, '.deepsteve', 'project-mods.json')), false);

  // updatedAt is derived from the files, not stored.
  const listed = payload(await tools.list_project_mods.handler({ session_id: 'sess-a' }, {}));
  assert.ok(listed.mods[0].updatedAt > 0);
  assert.ok(!('updatedAt' in manifest));
  assert.strictEqual(listed.mods[0].path, rel, 'an agent is told where to find the files');
  await deleteAll();
});

test('create_project_mod refuses a repo that is not part of a registered project', async () => {
  const res = await tools.create_project_mod.handler(
    { name: 'Ghost', session_id: 'sess-x', html: '<p>x</p>' }, {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /not part of any registered project/i);
  // A mod written there could never be discovered, so nothing is written at all.
  assert.strictEqual(fs.existsSync(path.join(REPO_UNREGISTERED, '.deepsteve')), false);
});

test('create_project_mod canonicalizes an explicit project to its git repo root', async () => {
  const { project } = await create({
    name: 'Dash', project: path.join(REPO_A, 'src'), html: '<p>x</p>',
  });
  assert.strictEqual(project, REPO_A, 'a subdirectory resolves up to the repo root');
  await deleteAll();
});

test('create_project_mod refuses when no project can be determined', async () => {
  const res = await tools.create_project_mod.handler({ name: 'Dash', html: '<p>x</p>' }, {});
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /which project/i);
  // The failure must be total — no half-written directory anywhere.
  assert.strictEqual(payload(await tools.list_project_mods.handler({ scope: 'all' }, {})).mods.length, 0);
});

test('create_project_mod requires a name, and exactly one of html / file_path', async () => {
  const noName = await tools.create_project_mod.handler({ name: '  ', session_id: 'sess-a', html: '<p>x</p>' }, {});
  assert.strictEqual(noName.isError, true);
  assert.match(noName.content[0].text, /name is required/i);

  const both = await tools.create_project_mod.handler(
    { name: 'D', session_id: 'sess-a', html: '<p>x</p>', file_path: '/tmp/x.html' }, {});
  assert.strictEqual(both.isError, true);
  assert.match(both.content[0].text, /exactly one/i);

  const neither = await tools.create_project_mod.handler({ name: 'D', session_id: 'sess-a' }, {});
  assert.strictEqual(neither.isError, true);

  assert.strictEqual(fs.existsSync(modsDirOf(REPO_A)), false, 'a refused create leaves no directory behind');
  await deleteAll();
});

test('two mods with the same name get distinct directories', async () => {
  const first = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>1</p>' });
  const second = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>2</p>' });
  assert.strictEqual(first.dirname, 'dash');
  assert.strictEqual(second.dirname, 'dash-2');
  assert.notStrictEqual(first.id, second.id);
  assert.strictEqual(pageOf(REPO_A, 'dash'), '<p>1</p>');
  assert.strictEqual(pageOf(REPO_A, 'dash-2'), '<p>2</p>');
  await deleteAll();
});

test('create_project_mod defaults to openMode:"view", and open_mode:"view" drops the tab surface', async () => {
  const plain = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  assert.strictEqual(plain.openMode, 'view', 'an agent that never considered open_mode gets a view');
  assert.strictEqual(manifestOf(REPO_A, plain.dirname).openMode, 'view');

  // Asking for the pin WITHOUT stating a mode must keep it. The default is not a
  // statement, so it must not outrank the one field the caller actually named — the
  // regression this would otherwise be is a silently unpinned mod.
  const pinned = await create({
    name: 'Pinned', session_id: 'sess-a', html: '<p>x</p>', surfaces: ['rail', 'tab'],
  });
  assert.deepStrictEqual(pinned.surfaces, ['rail', 'tab'], 'the stated surfaces win');
  assert.strictEqual(pinned.openMode, 'tab', 'and the pin overrides the defaulted view');
  assert.strictEqual(manifestOf(REPO_A, pinned.dirname).openMode, 'view',
    'the manifest keeps the standing choice, so un-pinning later reveals the view');

  const view = await create({
    name: 'Glance', session_id: 'sess-a', html: '<p>x</p>',
    surfaces: ['rail', 'button', 'tab'], open_mode: 'view',
  });
  assert.strictEqual(view.openMode, 'view');
  assert.deepStrictEqual(view.surfaces, ['rail', 'button'], 'a view cannot also be a pinned tab');
  const manifest = manifestOf(REPO_A, view.dirname);
  assert.deepStrictEqual(manifest.surfaces, ['rail', 'button']);
  assert.strictEqual(manifest.openMode, 'view');
  await deleteAll();
});

test('create_project_mod reads file_path and applies replacements', async () => {
  const file = path.join(HOME, 'template.html');
  fs.writeFileSync(file, '<h1>%%REPO%%</h1>');
  const { dirname } = await create({
    name: 'Dash', session_id: 'sess-a', file_path: file, replacements: { '%%REPO%%': 'deepsteve' },
  });
  assert.strictEqual(pageOf(REPO_A, dirname), '<h1>deepsteve</h1>');
  await deleteAll();
});

// --------------------------------------------------------------------- update

test('update_project_mod replaces the page and the metadata independently', async () => {
  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>v1</p>' });

  const metaOnly = await tools.update_project_mod.handler(
    { mod_id: id, name: 'Renamed', icon: '📊', surfaces: ['tab', 'button'] }, {});
  assert.strictEqual(payload(metaOnly).pageReplaced, false);
  let manifest = manifestOf(REPO_A, dirname);
  assert.strictEqual(manifest.name, 'Renamed');
  assert.strictEqual(manifest.icon, '📊');
  assert.deepStrictEqual(manifest.surfaces, ['button', 'tab']);
  assert.strictEqual(pageOf(REPO_A, dirname), '<p>v1</p>', 'page untouched');

  const pageOnly = await tools.update_project_mod.handler({ mod_id: id, html: '<p>v2</p>' }, {});
  assert.strictEqual(payload(pageOnly).pageReplaced, true);
  manifest = manifestOf(REPO_A, dirname);
  assert.strictEqual(manifest.name, 'Renamed', 'metadata untouched');
  assert.strictEqual(pageOf(REPO_A, dirname), '<p>v2</p>');

  await tools.update_project_mod.handler({ mod_id: id, enabled: false }, {});
  assert.strictEqual(manifestOf(REPO_A, dirname).enabled, false);

  assert.strictEqual(id, modId(REPO_A, dirname), 'a rename does not move the directory, so the id holds');
  await deleteAll();
});

test('a page edited directly on disk moves updatedAt, so an open tab reloads', async () => {
  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>v1</p>' });
  const before = payload(await tools.list_project_mods.handler({ session_id: 'sess-a' }, {})).mods[0].updatedAt;

  // The mod is a directory of ordinary files now — an agent's own Edit tool is a valid
  // way to change it, and the daemon must notice without being told.
  const file = path.join(dirOf(REPO_A, dirname), DEFAULT_ENTRY);
  fs.writeFileSync(file, '<p>edited by hand</p>');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  scan();

  const after = payload(await tools.list_project_mods.handler({ session_id: 'sess-a' }, {})).mods[0];
  assert.ok(after.updatedAt > before, `updatedAt should advance (${before} → ${after.updatedAt})`);
  assert.strictEqual(after.id, id, 'and the identity is unchanged, so the tab reloads rather than respawning');
  await deleteAll();
});

test('update_project_mod: an openMode write drops the pin, a surfaces write only overrides', async () => {
  const { id, dirname } = await create({
    name: 'Dash', session_id: 'sess-a', html: '<p>x</p>', surfaces: ['rail', 'button', 'tab'],
  });
  const manifest = () => manifestOf(REPO_A, dirname);

  // open_mode alone: the pin is what has to give.
  await tools.update_project_mod.handler({ mod_id: id, open_mode: 'view' }, {});
  assert.strictEqual(manifest().openMode, 'view');
  assert.deepStrictEqual(manifest().surfaces, ['rail', 'button']);

  // surfaces alone, re-adding the pin to a view-mode mod: the pin OVERRIDES the mode
  // instead of overwriting it (#645), so the manifest keeps both …
  await tools.update_project_mod.handler({ mod_id: id, surfaces: ['rail', 'tab'] }, {});
  assert.strictEqual(manifest().openMode, 'view', 'the stored mode is untouched');
  assert.deepStrictEqual(manifest().surfaces, ['rail', 'tab']);
  assert.strictEqual(effectiveOpenMode(manifest()), 'tab', 'and the mod behaves as a tab meanwhile');

  // … which is what makes un-ticking the pin put the view back, with no second gesture.
  await tools.update_project_mod.handler({ mod_id: id, surfaces: ['rail'] }, {});
  assert.strictEqual(effectiveOpenMode(manifest()), 'view');

  await tools.update_project_mod.handler({ mod_id: id, surfaces: ['rail', 'tab'] }, {});

  // Both at once and contradictory: open_mode is the more specific statement.
  await tools.update_project_mod.handler({ mod_id: id, surfaces: ['rail', 'tab'], open_mode: 'view' }, {});
  assert.strictEqual(manifest().openMode, 'view');
  assert.deepStrictEqual(manifest().surfaces, ['rail']);

  // Touching neither leaves the placement alone.
  await tools.update_project_mod.handler({ mod_id: id, name: 'Renamed' }, {});
  assert.strictEqual(manifest().openMode, 'view');
  assert.deepStrictEqual(manifest().surfaces, ['rail']);
  await deleteAll();
});

test('update_project_mod reports an unknown id and refuses an empty name', async () => {
  const missing = await tools.update_project_mod.handler({ mod_id: 'nope', name: 'x' }, {});
  assert.strictEqual(missing.isError, true);
  assert.match(missing.content[0].text, /not found/i);

  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  const blank = await tools.update_project_mod.handler({ mod_id: id, name: '   ' }, {});
  assert.strictEqual(blank.isError, true);
  assert.strictEqual(manifestOf(REPO_A, dirname).name, 'Dash', 'the old name survives a rejected write');
  await deleteAll();
});

// ----------------------------------------------------------------------- edit

test('edit_project_mod replaces one occurrence, and refuses an ambiguous one', async () => {
  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>a</p><p>a</p><b>z</b>' });

  const ambiguous = await tools.edit_project_mod.handler({ mod_id: id, old_string: '<p>a</p>', new_string: '<p>b</p>' }, {});
  assert.strictEqual(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /not unique \(2 matches\)/);

  const all = await tools.edit_project_mod.handler({ mod_id: id, old_string: '<p>a</p>', new_string: '<p>b</p>', replace_all: true }, {});
  assert.strictEqual(payload(all).replacements, 2);
  assert.strictEqual(pageOf(REPO_A, dirname), '<p>b</p><p>b</p><b>z</b>');

  const one = await tools.edit_project_mod.handler({ mod_id: id, old_string: '<b>z</b>', new_string: '<b>$&</b>' }, {});
  assert.strictEqual(payload(one).replacements, 1);
  assert.match(pageOf(REPO_A, dirname), /<b>\$&<\/b>/,
    '$& in the replacement stays literal (split/join, not String.replace)');

  const missing = await tools.edit_project_mod.handler({ mod_id: id, old_string: 'nowhere', new_string: 'x' }, {});
  assert.strictEqual(missing.isError, true);
  assert.match(missing.content[0].text, /not found in project mod/);
  await deleteAll();
});

// ----------------------------------------------------------------------- list

test('list_project_mods scopes to the caller project by default, and scope:"all" spans projects', async () => {
  const a = await create({ name: 'A-dash', session_id: 'sess-a', html: '<p>a</p>' });
  const b = await create({ name: 'B-dash', session_id: 'sess-b', html: '<p>b</p>' });
  assert.strictEqual(b.project, REPO_B, 'each mod is written into its own repo');

  const mine = payload(await tools.list_project_mods.handler({ session_id: 'sess-a' }, {}));
  assert.strictEqual(mine.project, REPO_A);
  assert.deepStrictEqual(mine.mods.map(m => m.id), [a.id], 'the other project is not visible');

  const all = payload(await tools.list_project_mods.handler({ scope: 'all' }, {}));
  assert.deepStrictEqual(all.mods.map(m => m.id).sort(), [a.id, b.id].sort());

  // No session, no project: an empty list with a note, NOT an error — a read that
  // can't be scoped is a no-op, not a failure.
  const nowhere = await tools.list_project_mods.handler({}, {});
  assert.ok(!nowhere.isError);
  assert.deepStrictEqual(payload(nowhere).mods, []);
  assert.match(payload(nowhere).note, /scope:"all"/);
  await deleteAll();
});

test('a session opened in a repo subdirectory still resolves to the repo (#659)', async () => {
  // The scoping helper moved to project-scope.js and is now shared with scheduled
  // tasks and list_sessions. This pins that this mod still passes the STRICT defaults:
  // canonicalizing the session branch is what lets a mod created from <repo>/src land
  // in <repo> and be found again by a session sitting at the root.
  const sub = await create({ name: 'Sub-dash', session_id: 'sess-a-sub', html: '<p>sub</p>' });
  assert.strictEqual(sub.project, REPO_A, 'the mod belongs to the repo, not the subdirectory');

  const fromRoot = payload(await tools.list_project_mods.handler({ session_id: 'sess-a' }, {}));
  assert.ok(fromRoot.mods.map(m => m.id).includes(sub.id),
    'and a session at the repo root sees it');
  await deleteAll();
});

// --------------------------------------------------------------------- delete

test('delete_project_mod removes the directory, and prunes .deepsteve when it empties', async () => {
  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  assert.ok(fs.existsSync(dirOf(REPO_A, dirname)));

  const res = await tools.delete_project_mod.handler({ mod_id: id }, {});
  assert.strictEqual(payload(res).deleted, true);
  assert.strictEqual(fs.existsSync(dirOf(REPO_A, dirname)), false, 'the whole directory goes');
  assert.strictEqual(fs.existsSync(path.join(REPO_A, '.deepsteve')), false,
    'and the now-empty .deepsteve is not left littering the repo');
  assert.ok(fs.existsSync(path.join(REPO_A, 'src')), 'nothing outside the mods directory is touched');

  const again = await tools.delete_project_mod.handler({ mod_id: id }, {});
  assert.strictEqual(again.isError, true);
});

test('delete_project_mod leaves a .deepsteve that holds anything else alone', async () => {
  const { id } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  const keep = path.join(REPO_A, '.deepsteve', 'something-else.json');
  fs.writeFileSync(keep, '{}');
  try {
    await tools.delete_project_mod.handler({ mod_id: id }, {});
    assert.ok(fs.existsSync(keep), 'rmdir fails on a non-empty directory, which is exactly the guard');
  } finally {
    fs.rmSync(path.join(REPO_A, '.deepsteve'), { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- feature gate

test('write tools fail closed when projectModsEnabled is off; reads keep working', async () => {
  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  settings.projectModsEnabled = false;
  try {
    const gated = {
      create_project_mod: { name: 'X', session_id: 'sess-a', html: '<p>y</p>' },
      update_project_mod: { mod_id: id, name: 'X' },
      edit_project_mod: { mod_id: id, old_string: '<p>x</p>', new_string: '<p>y</p>' },
      delete_project_mod: { mod_id: id },
    };
    for (const name of Object.keys(gated)) {
      const res = await tools[name].handler(gated[name], {});
      assert.strictEqual(res.isError, true, `${name} should fail closed`);
      assert.strictEqual(res.content[0].text, FEATURE_OFF_MSG);
    }
    // Nothing was written by any of the four.
    assert.strictEqual(manifestOf(REPO_A, dirname).name, 'Dash');
    assert.strictEqual(pageOf(REPO_A, dirname), '<p>x</p>');

    // Turning the feature off must not make existing mods un-inspectable.
    const listed = await tools.list_project_mods.handler({ scope: 'all' }, {});
    assert.ok(!listed.isError);
    assert.strictEqual(payload(listed).mods.length, 1);
  } finally {
    settings.projectModsEnabled = true;
  }
  await deleteAll();
});

// -------------------------------------------------------------- caller / extra

test('the caller shell id is read off the MCP URL when session_id is omitted', async () => {
  const extra = { requestInfo: { url: new URL('http://localhost:3000/mcp?shellId=sess-b') } };
  const res = await tools.create_project_mod.handler({ name: 'Dash', html: '<p>x</p>' }, extra);
  assert.ok(!res.isError, res.content[0].text);
  assert.strictEqual(payload(res).project, REPO_B);
  await deleteAll();
});

// ----------------------------------------------------------------- containment

test('resolveInMod refuses every way out of the mod directory', () => {
  const row = { dir: dirOf(REPO_A, 'dash') };
  assert.ok(resolveInMod(row, 'style.css'), 'a sibling file is fine');
  assert.ok(resolveInMod(row, 'assets/app.js'), 'and so is a subdirectory');
  assert.strictEqual(resolveInMod(row, '../other/index.html'), null);
  assert.strictEqual(resolveInMod(row, '../../../../etc/passwd'), null);
  assert.strictEqual(resolveInMod(row, 'a/../../../etc/passwd'), null,
    'resolved before comparison, so an interior .. cannot climb out');
  assert.strictEqual(resolveInMod(row, '/etc/passwd'), null);
});

// ----------------------------------------------------------------------- REST

// Minimal express stand-in: record the handlers, then invoke them with fake req/res.
function makeApp() {
  const routes = new Map();
  const record = (method) => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return {
    get: record('GET'), put: record('PUT'), delete: record('DELETE'), post: record('POST'),
    call(key, { params = {}, body = {}, method } = {}) {
      const handler = routes.get(key);
      assert.ok(handler, `no route registered for ${key}`);
      const res = { statusCode: 200, body: null, sentFile: null, type: () => res };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (v) => { res.body = v; return res; };
      res.send = (v) => { res.body = v; return res; };
      res.end = () => { res.body = ''; return res; };
      res.sendFile = (p) => { res.sentFile = p; res.body = fs.readFileSync(p, 'utf8'); return res; };
      handler({ params, body, method: method || key.split(' ')[0] }, res);
      return res;
    },
    routeKeys: () => [...routes.keys()],
  };
}

test('REST exposes the list, the page, sibling assets, a metadata PUT and a DELETE', async () => {
  const app = makeApp();
  registerRoutes(app, ctx);
  assert.deepStrictEqual(app.routeKeys().sort(), [
    'DELETE /api/project-mods/:id',
    'GET /api/project-mods',
    'GET /api/project-mods/:id/*',
    'GET /api/project-mods/:id/page',
    'PUT /api/project-mods/:id',
  ]);
  // Order matters as much as membership: the wildcard must not shadow /page.
  assert.ok(
    app.routeKeys().indexOf('GET /api/project-mods/:id/page') <
    app.routeKeys().indexOf('GET /api/project-mods/:id/*'),
    '/page must be registered before the wildcard or it can never match',
  );

  const { id, dirname } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });

  const list = app.call('GET /api/project-mods');
  assert.strictEqual(list.body.enabled, true);
  assert.deepStrictEqual(list.body.mods.map(m => m.id), [id]);
  // The wire shape must not leak where the mod lives on disk.
  assert.deepStrictEqual(Object.keys(list.body.mods[0]).sort(),
    ['createdAt', 'enabled', 'icon', 'id', 'name', 'openMode', 'project', 'storedOpenMode', 'surfaces', 'updatedAt']);

  const page = app.call('GET /api/project-mods/:id/page', { params: { id } });
  assert.strictEqual(page.body, '<p>x</p>');

  // HEAD is the client's restore probe: OK for a live mod, 404 once it's gone.
  const head = app.call('GET /api/project-mods/:id/page', { params: { id }, method: 'HEAD' });
  assert.strictEqual(head.statusCode, 200);
  assert.strictEqual(head.body, '');

  const missing = app.call('GET /api/project-mods/:id/page', { params: { id: 'nope' } });
  assert.strictEqual(missing.statusCode, 404);

  // A relative "./style.css" in the page resolves to the wildcard route.
  fs.writeFileSync(path.join(dirOf(REPO_A, dirname), 'style.css'), 'body{color:red}');
  const asset = app.call('GET /api/project-mods/:id/*', { params: { id, 0: 'style.css' } });
  assert.strictEqual(asset.statusCode, 200);
  assert.strictEqual(asset.body, 'body{color:red}');

  for (const escape of ['../../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'a/../../../etc/passwd']) {
    const out = app.call('GET /api/project-mods/:id/*', { params: { id, 0: escape } });
    assert.strictEqual(out.statusCode, 404, `${escape} must not resolve`);
    assert.strictEqual(out.sentFile, null);
  }
  // A directory is not a file, and neither is something that isn't there.
  assert.strictEqual(app.call('GET /api/project-mods/:id/*', { params: { id, 0: '' } }).statusCode, 404);
  assert.strictEqual(app.call('GET /api/project-mods/:id/*', { params: { id, 0: 'nope.css' } }).statusCode, 404);

  const put = app.call('PUT /api/project-mods/:id', { params: { id }, body: { name: 'Renamed', surfaces: ['tab'] } });
  assert.strictEqual(put.body.mod.name, 'Renamed');
  assert.deepStrictEqual(put.body.mod.surfaces, ['tab']);
  assert.strictEqual(put.body.mod.openMode, 'tab', 'the wire shape carries the open mode (#628)');
  assert.strictEqual(manifestOf(REPO_A, dirname).name, 'Renamed', 'and it reached the repo');

  // The browser's checklist sends one field at a time; the same explicit-wins rule applies.
  const toView = app.call('PUT /api/project-mods/:id', { params: { id }, body: { openMode: 'view' } });
  assert.strictEqual(toView.body.mod.openMode, 'view');
  assert.deepStrictEqual(toView.body.mod.surfaces, ['rail'], 'the pin is dropped and the list is floored');

  // Asking for the pin makes it open as a tab, but only by overriding — the wire shape
  // carries both, and the manifest still records the view (#645).
  const pinned = app.call('PUT /api/project-mods/:id', { params: { id }, body: { surfaces: ['rail', 'tab'] } });
  assert.strictEqual(pinned.body.mod.openMode, 'tab');
  assert.strictEqual(pinned.body.mod.storedOpenMode, 'view');
  assert.strictEqual(manifestOf(REPO_A, dirname).openMode, 'view');

  // …so un-ticking it is a full undo, which is the whole point of #645.
  const unpinned = app.call('PUT /api/project-mods/:id', { params: { id }, body: { surfaces: ['rail'] } });
  assert.strictEqual(unpinned.body.mod.openMode, 'view', 'un-pinning restores the view');
  assert.strictEqual(unpinned.body.mod.storedOpenMode, 'view');

  const del = app.call('DELETE /api/project-mods/:id', { params: { id } });
  assert.strictEqual(del.body.deleted, true);
  assert.strictEqual(app.call('GET /api/project-mods/:id/page', { params: { id } }).statusCode, 404);
  assert.strictEqual(fs.existsSync(dirOf(REPO_A, dirname)), false);
});

test('REST writes 403 when the feature is off, while the reads stay open', async () => {
  const app = makeApp();
  registerRoutes(app, ctx);
  const { id } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });

  settings.projectModsEnabled = false;
  try {
    const put = app.call('PUT /api/project-mods/:id', { params: { id }, body: { name: 'X' } });
    assert.strictEqual(put.statusCode, 403);
    const del = app.call('DELETE /api/project-mods/:id', { params: { id } });
    assert.strictEqual(del.statusCode, 403);

    const list = app.call('GET /api/project-mods');
    assert.strictEqual(list.statusCode, 200);
    assert.strictEqual(list.body.enabled, false, 'the client learns the gate is closed and hides every surface');
    assert.strictEqual(app.call('GET /api/project-mods/:id/page', { params: { id } }).body, '<p>x</p>');
  } finally {
    settings.projectModsEnabled = true;
  }
  await deleteAll();
});

// ---------------------------------------------------------------- broadcasting

test('every mutation pings the browser so open surfaces re-derive', async () => {
  broadcasts.length = 0;
  const { id } = await create({ name: 'Dash', session_id: 'sess-a', html: '<p>x</p>' });
  await tools.update_project_mod.handler({ mod_id: id, name: 'Renamed' }, {});
  await tools.edit_project_mod.handler({ mod_id: id, old_string: '<p>x</p>', new_string: '<p>y</p>' }, {});
  await tools.delete_project_mod.handler({ mod_id: id }, {});
  assert.strictEqual(broadcasts.length, 4);
  // Payload-less on purpose — the client refetches (the scheduled-tasks idiom).
  for (const b of broadcasts) assert.deepStrictEqual(b, { type: 'project-mods' });
});

// ------------------------------------------------------------------- teardown

test('the state dir was never used', () => {
  // The one assertion that proves the move actually happened rather than being mirrored.
  const stateDir = path.join(HOME, '.deepsteve');
  const leftovers = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter(f => f.startsWith('project-mods'))
    : [];
  assert.deepStrictEqual(leftovers, []);
  for (const root of [REPO_A, REPO_B, REPO_UNREGISTERED]) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});
