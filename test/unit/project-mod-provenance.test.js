// Project-mod provenance (mods/project-mods/provenance.js): what a version hash covers, and the
// approval record. A mod's code runs only in a version an agent wrote through Deep Steve's tools
// or the user approved, so the hash has to change on every change that could alter what runs,
// and on nothing else — a data file rewritten every minute must not revoke an approval.
//
// Run: node --test test/unit/project-mod-provenance.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { walk, versionOf, createVersionCache, createStore, isData, MAX_RECORDS } = require('../../mods/project-mods/provenance.js');

function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prov-')));
  const dir = path.join(root, '.deepsteve', 'mods', 'dash');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ scope: 'project', name: 'Dash' }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>dash</p>');
  return { root, dir, opts: { root, entry: 'index.html' } };
}
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test('data extensions are left out; anything that can run, or is unknown, is covered', () => {
  for (const f of ['state/world.json', 'a.png', 'notes.md', 'x.CSV', 'font.woff2', 'clip.mp4']) assert.ok(isData(f), f);
  for (const f of ['app.js', 'mod.mjs', 'page.html', 'style.css', 'icon.svg', 'x.wasm', 'build.py', 'fly.bin', 'README', 'doc.pdf']) {
    assert.ok(!isData(f), `${f} must be covered`);
  }
});

test('a code change is a new version; a data change is not', () => {
  const { dir, opts } = makeRepo();
  write(dir, 'state/world.json', '{"day":1}');
  write(dir, 'app.js', 'console.log(1)');
  const v1 = versionOf(dir, opts);
  assert.ok(v1.hash && !v1.error);
  assert.deepStrictEqual(v1.files.map(f => f.path), ['app.js', 'index.html', 'mod.json']);

  write(dir, 'state/world.json', '{"day":2}');
  write(dir, 'state/new.json', '{}');
  write(dir, 'shot.png', 'png');
  assert.strictEqual(versionOf(dir, opts).hash, v1.hash, 'data churn keeps the approval');

  write(dir, 'app.js', 'console.log(2)');
  assert.notStrictEqual(versionOf(dir, opts).hash, v1.hash, 'editing a script is a new version');
});

test('the entry page and mod.json are covered whatever their extension', () => {
  const { dir, root } = makeRepo();
  write(dir, 'page.json', '<script>1</script>');
  const opts = { root, entry: 'page.json' };   // the page route serves the entry as HTML
  const v1 = versionOf(dir, opts);
  assert.ok(v1.files.some(f => f.path === 'page.json'));
  write(dir, 'page.json', '<script>2</script>');
  assert.notStrictEqual(versionOf(dir, opts).hash, v1.hash);

  const v2 = versionOf(dir, opts);
  write(dir, 'mod.json', JSON.stringify({ scope: 'project', name: 'Dash', entry: 'other.html' }));
  assert.notStrictEqual(versionOf(dir, opts).hash, v2.hash, 'the manifest picks what runs');
});

test('new and removed code files are new versions; dotfiles are not covered', () => {
  const { dir, opts } = makeRepo();
  const v1 = versionOf(dir, opts);
  write(dir, '.DS_Store', 'finder');
  write(dir, '.swp', 'vim');
  assert.strictEqual(versionOf(dir, opts).hash, v1.hash, 'never served, so never covered');
  write(dir, 'extra.js', 'x');
  const v2 = versionOf(dir, opts);
  assert.notStrictEqual(v2.hash, v1.hash, 'a file added by a pull');
  fs.rmSync(path.join(dir, 'extra.js'));
  assert.strictEqual(versionOf(dir, opts).hash, v1.hash);
  // A dot-DIRECTORY's files are served, so they are covered.
  write(dir, '.lib/run.js', 'x');
  assert.ok(versionOf(dir, opts).files.some(f => f.path === '.lib/run.js'));
});

test('a symlink inside the repo is followed and its target is part of the version', () => {
  const { root, dir, opts } = makeRepo();
  fs.mkdirSync(path.join(root, '.arcade'));
  fs.writeFileSync(path.join(root, '.arcade', 'game.html'), '<p>game</p>');
  fs.writeFileSync(path.join(root, '.arcade', 'index.json'), '{}');
  fs.mkdirSync(path.join(root, '.arcade2'));
  fs.writeFileSync(path.join(root, '.arcade2', 'game.html'), '<p>game</p>');
  fs.symlinkSync('../../../.arcade', path.join(dir, 'cab'));
  const v1 = versionOf(dir, opts);
  assert.strictEqual(v1.error, null);
  assert.ok(v1.files.some(f => f.path === 'cab/game.html'), 'the linked page is covered');
  assert.ok(!v1.files.some(f => f.path === 'cab/index.json'), 'linked data is not');
  assert.deepStrictEqual(v1.links, [{ path: 'cab', target: '../../../.arcade' }]);

  fs.writeFileSync(path.join(root, '.arcade', 'game.html'), '<p>changed</p>');
  assert.notStrictEqual(versionOf(dir, opts).hash, v1.hash, 'changing what the link reaches is a new version');

  fs.writeFileSync(path.join(root, '.arcade', 'game.html'), '<p>game</p>');
  fs.rmSync(path.join(dir, 'cab'));
  fs.symlinkSync('../../../.arcade2', path.join(dir, 'cab'));
  assert.notStrictEqual(versionOf(dir, opts).hash, v1.hash, 'retargeting the link is a new version, even onto identical files');
});

test('a symlink that leaves the repo makes the mod unapprovable', () => {
  const { dir, opts } = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prov-outside-'));
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'secret');
  fs.symlinkSync(outside, path.join(dir, 'keys'));
  const v = versionOf(dir, opts);
  assert.strictEqual(v.hash, null);
  assert.match(v.error, /keys links outside the repository/);
});

test('a symlink loop is refused rather than walked forever', () => {
  const { dir, opts } = makeRepo();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.symlinkSync('..', path.join(dir, 'a', 'up'));
  const v = versionOf(dir, opts);
  assert.strictEqual(v.hash, null);
  assert.match(v.error, /symlink loop/);
});

test('the cache re-hashes when a covered file changes, even at the same size and mtime', () => {
  const { dir, opts } = makeRepo();
  const cache = createVersionCache();
  const v1 = cache.get(dir, opts);
  assert.strictEqual(cache.get(dir, opts), v1, 'unchanged: the cached object comes back');
  const page = path.join(dir, 'index.html');
  const { mtime } = fs.statSync(page);
  fs.writeFileSync(page, '<p>DASH</p>');          // same length
  fs.utimesSync(page, mtime, mtime);              // and the mtime put back, as an extract could
  assert.notStrictEqual(cache.get(dir, opts).hash, v1.hash, 'ctime/ino catch what mtime alone would miss');
});

test('the store records, persists, refuses junk keys and keeps a bounded ring', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prov-store-')), 'p.json');
  let t = 0;
  const store = createStore(file, { now: () => ++t, max: 3 });
  const h = (n) => String(n).repeat(64).slice(0, 64);
  assert.strictEqual(store.has(h(1)), false);
  assert.strictEqual(store.record('not-a-hash', {}), false);
  assert.strictEqual(store.record('__proto__', {}), false);
  for (const n of [1, 2, 3, 4]) store.record(h(n), { by: 'agent' });
  assert.strictEqual(store.has(h(1)), false, 'the oldest falls out past the cap');
  assert.ok(store.has(h(4)));
  assert.strictEqual(store.get(h(4)).by, 'agent');

  const reopened = createStore(file);
  assert.ok(reopened.has(h(2)) && reopened.has(h(3)) && reopened.has(h(4)), 'persisted');
  assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600);

  fs.writeFileSync(file, '{not json');
  assert.strictEqual(createStore(file).has(h(4)), false, 'a corrupt record fails closed');
  assert.ok(MAX_RECORDS >= 1000, 'the real cap holds plenty of agent edits');
});

test('walk() never reports a file outside the mod directory', () => {
  const { dir, opts } = makeRepo();
  write(dir, 'sub/deep/x.js', 'x');
  for (const f of walk(dir, opts).files) assert.ok(f.abs.startsWith(dir + path.sep), f.abs);
});
