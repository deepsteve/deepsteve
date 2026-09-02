// The Mods modal groups by kind (#673), and this is the file that keeps the taxonomy honest.
//
// Two halves. The first exercises `modKind()` against every manifest actually on disk, so a
// new mod that lands somewhere unexpected — or a game that quietly stops being one — is a
// failing test rather than an entry nobody can find in the UI. The second is a source-text
// guard, in the shape mod-tools-source.test.js established for #644: it pins that the server
// stamps `kind` after the manifest spread and that the client never re-derives it.
//
// Run: node --test test/unit/mod-kind.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { modKind, MOD_KINDS } = require('../../mod-kind');

const ROOT = path.join(__dirname, '..', '..');
const MODS_DIR = path.join(ROOT, 'mods');

function readManifests() {
  const out = [];
  for (const dir of fs.readdirSync(MODS_DIR)) {
    const file = path.join(MODS_DIR, dir, 'mod.json');
    if (!fs.existsSync(file)) continue;
    out.push({ id: dir, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
  return out;
}

test('every shipped manifest lands in exactly one section', () => {
  const manifests = readManifests();
  // Same vacuous-pass guard mod-tools-source.test.js opens with: an empty read would make
  // every assertion below trivially true.
  assert.ok(manifests.length >= 15, `expected the real mods dir, saw ${manifests.length}`);

  const buckets = {};
  for (const { id, manifest } of manifests) {
    const kind = modKind(manifest);
    assert.ok(MOD_KINDS.includes(kind), `${id} produced an unlisted kind: ${kind}`);
    (buckets[kind] = buckets[kind] || []).push(id);
  }

  const total = Object.values(buckets).reduce((n, ids) => n + ids.length, 0);
  assert.strictEqual(total, manifests.length, 'a manifest was counted twice or not at all');

  // Exact membership where it is small enough to be worth naming. If one of these fails the
  // question is not "loosen the test" — it is which section the new mod should appear under.
  assert.deepStrictEqual((buckets.app || []).sort(), ['simeon', 'timecard', 'workshop'],
    'Apps are the mods declaring `app: true` — a place you work from, not a way to draw');
  assert.deepStrictEqual(buckets.fullscreen, ['tower'],
    'Fullscreen holds only the non-game fullscreen mods — a game belongs under Games');
  assert.deepStrictEqual((buckets.tab || []).sort(), ['baby-browser', 'steveonardo']);
  assert.deepStrictEqual((buckets.background || []).sort(),
    ['deepsteve-core', 'display-tab', 'project-mods', 'session-lifecycle'],
    'Background is the tools-only mods: no entry, so no UI to put anywhere else');
  assert.strictEqual(buckets.panel.length, 9);
  assert.strictEqual(buckets.game.length, 6);
  assert.ok(!buckets.skill, 'skills do not live in mods/ — the server stamps their kind');
});

test('the ladder resolves the overlaps in a fixed order', () => {
  // Nothing to render beats everything: a tools-only mod tagged `games` is not a game.
  assert.strictEqual(modKind({}), 'background');
  assert.strictEqual(modKind({ tags: ['games'] }), 'background');
  // A place you work from is an app even though it is also fullscreen (#661)…
  assert.strictEqual(modKind({ entry: 'x', app: true }), 'app');
  // …and even though it also declares a display mode.
  assert.strictEqual(modKind({ entry: 'x', app: true, display: 'panel' }), 'app');
  // Games is a kind, so a panel-shaped game files under Games rather than swelling Panels.
  assert.strictEqual(modKind({ entry: 'x', tags: ['games'], display: 'panel' }), 'game');
  assert.strictEqual(modKind({ entry: 'x', display: 'panel' }), 'panel');
  assert.strictEqual(modKind({ entry: 'x', display: 'tab' }), 'tab');
  assert.strictEqual(modKind({ entry: 'x' }), 'fullscreen');
  // Total for either input shape — a wire row as well as a manifest.
  assert.strictEqual(modKind({ type: 'skill' }), 'skill');
  assert.strictEqual(modKind(null), 'fullscreen');
  // A malformed `tags` must not throw; it simply is not a game.
  assert.strictEqual(modKind({ entry: 'x', tags: 'games' }), 'fullscreen');
});

test('GET /api/mods stamps kind after the manifest spread (#673)', () => {
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  assert.match(serverSource, /\{[^}]*\bmodKind\b[^}]*\} = require\('\.\/mod-kind'\)/,
    'server.js must import modKind from ./mod-kind');

  const push = serverSource.match(/^\s*mods\.push\(\{ id: entry\.name.*$/m);
  assert.ok(push, 'the GET /api/mods push line was not found — has the handler been rewritten?');
  assert.match(push[0], /\.\.\.manifest,\s*tools: getModTools\(entry\.name\),\s*kind: modKind\(manifest\)/,
    'kind must come AFTER the manifest spread, for the same later-key-wins reason as tools: ' +
    'a third-party mod arrives as a tarball (POST /api/mods/install) whose mod.json we do ' +
    'not control, and it must not be able to file itself under Apps.');

  assert.match(serverSource, /type: 'skill',\s*(?:\/\/[^\n]*\n\s*)*kind: 'skill',/,
    "a skill's kind is hardcoded, never derived — a skill is never a place you work from");
});

test('the client renders the taxonomy but never re-derives it', () => {
  const groupsSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mod-groups.js'), 'utf8');
  // Strip comments: the header explains the rule it is forbidden to implement.
  const code = groupsSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of ['.display', '.entry', "'games'", '.app']) {
    assert.ok(!code.includes(forbidden),
      `mod-groups.js must group by mod.kind alone — found ${forbidden}, which is the ` +
      'server\'s rule being copied into the browser. That is the drift #644 deleted.');
  }
  assert.match(code, /mod\.kind/, 'it does have to read the field it groups by');
});

test('validate-mods rejects a manifest that declares kind, or malformed tags (#673)', () => {
  const { validateManifest } = require('../../validate-mods');
  const base = { name: 'X', version: '1.0.0', description: 'x' };

  assert.deepStrictEqual(validateManifest('x', base), [], 'the baseline manifest must be clean');

  // `kind` is derived and stamped after the manifest spread, so a declared one is silently
  // ignored. Say so at build time rather than letting an author think it took effect.
  assert.match(validateManifest('x', { ...base, kind: 'app' })[0] || '', /must not declare "kind"/);

  // `tags: "games"` is the shape that used to be harmless and now silently misses the Games
  // section — visible as wrong placement, with nothing saying why.
  assert.match(validateManifest('x', { ...base, tags: 'games' })[0] || '', /"tags" must be an array/);
  assert.match(validateManifest('x', { ...base, tags: [1] })[0] || '', /"tags" must be an array/);
  assert.deepStrictEqual(validateManifest('x', { ...base, tags: ['games'] }), []);
  assert.deepStrictEqual(validateManifest('x', { ...base, tags: [] }), []);
});

test('one row selector, three consumers', () => {
  const managerSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mod-manager.js'), 'utf8');

  // _refreshCardToggles, the cross-tab `storage` listener and handleSkillsChanged all reach
  // a row through the same import. A rename that misses one of them is silent.
  assert.ok(!/\.mod-card\[data-mod-id/.test(managerSource),
    'a card-era row selector survived the rename — one of the three refresh paths is now ' +
    'looking for an element that no longer exists');
  assert.match(managerSource, /MOD_ROW_SELECTOR/,
    'rows must be found through the shared constant, not a literal repeated per call site');

  const groupsSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mod-groups.js'), 'utf8');
  assert.match(groupsSource, /MOD_ROW_SELECTOR = '\.mod-row\[data-mod-id\]'/,
    'the selector literal lives in exactly one place');
});
