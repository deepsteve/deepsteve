// Unit test for mods/workshop/images.js — the store behind share_result (#669).
//
// Why this file exists at all: this is the one place in Workshop where a string an
// AGENT chose becomes a filesystem read. `share_result({ images: [...] })` is called by
// the same model that wrote the code under review, and the refusals below are what stand
// between "attach a screenshot" and "serve me ~/.ssh/id_rsa over HTTP".
//
// The trap the tests are shaped around: ctx.pathInside (server.js) is a pure STRING
// PREFIX test with no canonicalization at all, so `<repo>/../../../etc/passwd` starts
// with the repo path and passes it happily. images.js realpaths first for exactly that
// reason, and the traversal/symlink cases here are what would catch a future refactor
// that reorders those two steps back.
//
// The second reason: results are the durable record, and screenshots self-delete after
// seven days. So the bytes are COPIED at share time rather than referenced, and
// sweepOrphans is what keeps that from growing without bound. Both are pinned.
//
// images.js requires only node:fs, node:path and paths.js — no ctx, no daemon, no PTY —
// so this runs in the bare `unit` CI job. HOME is repointed before the require, as in
// workshop-inbox.test.js, because the store resolves under stateDir().
//
// Run: node --test test/unit/workshop-images.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workshop-images-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

const images = require('../../mods/workshop/images.js');

// Real directories, because every check here is a real filesystem check. On macOS
// os.tmpdir() sits under a symlinked /var, which is precisely the case that breaks a
// naive prefix comparison — so the fixture exercises it rather than avoiding it.
const REPO = path.join(SCRATCH, 'project');
const OUTSIDE = path.join(SCRATCH, 'elsewhere');
const SHOTS = path.join(SCRATCH, 'shots');
for (const d of [REPO, path.join(REPO, 'docs'), OUTSIDE, SHOTS]) fs.mkdirSync(d, { recursive: true });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
fs.writeFileSync(path.join(REPO, 'shot.png'), PNG);
fs.writeFileSync(path.join(REPO, 'docs', 'nested.png'), PNG);
fs.writeFileSync(path.join(REPO, 'notes.txt'), 'not an image');
fs.writeFileSync(path.join(REPO, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
fs.writeFileSync(path.join(OUTSIDE, 'secret.png'), PNG);
fs.writeFileSync(path.join(SHOTS, 'a1b2c3d4.png'), PNG);

// A symlink INSIDE the repo pointing OUT of it. This is the case a prefix test cannot
// see and a realpath can, and it is not exotic — node_modules is full of them.
try {
  fs.symlinkSync(path.join(OUTSIDE, 'secret.png'), path.join(REPO, 'linked.png'));
} catch { /* a platform without symlinks skips that one assertion, not the file */ }

// The pathInside from server.js, verbatim: this suite is worthless if it tests a
// stricter copy than production actually uses.
function pathInside(p, dir) {
  if (!p || !dir) return false;
  const base = String(dir).replace(/\/+$/, '');
  return p === base || p.startsWith(base + '/');
}

const ENTRY = { cwd: REPO };
const ctx = {
  pathInside,
  sessionPaths: () => ({ cwd: REPO, repoRoot: REPO }),
  screenshots: new Map([['a1b2c3d4', { id: 'a1b2c3d4' }]]),
  getScreenshotPath: (id) => path.join(SHOTS, `${id}.png`),
};
const opts = { entry: ENTRY, ctx };

test('the scratch HOME really took — this suite must not touch a real image store', () => {
  assert.ok(
    images.imagesDir().startsWith(SCRATCH),
    `image store resolved to ${images.imagesDir()}, outside the scratch HOME ${SCRATCH}`,
  );
});

// ── resolveRef: what is accepted ─────────────────────────────────────────────

test('a live screenshot id resolves to its PNG', () => {
  const r = images.resolveRef('a1b2c3d4', opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, path.join(SHOTS, 'a1b2c3d4.png'));
  assert.strictEqual(r.ext, '.png');
});

test('a path inside the project resolves, absolute or relative', () => {
  assert.strictEqual(images.resolveRef(path.join(REPO, 'shot.png'), opts).ok, true);
  assert.strictEqual(images.resolveRef('./shot.png', opts).ok, true);
  assert.strictEqual(images.resolveRef('docs/nested.png', opts).ok, true,
    'a relative ref resolves against the session cwd, which is how an agent names files');
});

// ── resolveRef: what is refused, and why each one matters ────────────────────

test('a path outside the project is refused', () => {
  const r = images.resolveRef(path.join(OUTSIDE, 'secret.png'), opts);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside-project');
});

test('a `..` traversal is refused — the reason realpath comes BEFORE pathInside', () => {
  // Built by concatenation, NOT path.join, which would normalize the `..` away and make
  // the fixture prove nothing. Unnormalized, this string starts with REPO, so
  // ctx.pathInside says yes to it — only realpath turns it into the
  // /elsewhere/secret.png it actually names.
  const traversal = `${REPO}/../elsewhere/secret.png`;
  assert.ok(pathInside(traversal, REPO),
    'the fixture is vacuous unless the raw string really does fool pathInside');
  const r = images.resolveRef(traversal, opts);
  assert.strictEqual(r.ok, false, 'a traversal that satisfies the prefix test must still be refused');
  assert.strictEqual(r.reason, 'outside-project');

  // The relative spelling of the same attack, resolved against the session cwd.
  assert.strictEqual(images.resolveRef('../elsewhere/secret.png', opts).reason, 'outside-project');
});

test('a symlink inside the project pointing out of it is refused', (t) => {
  if (!fs.existsSync(path.join(REPO, 'linked.png'))) return t.skip('no symlink support here');
  const r = images.resolveRef(path.join(REPO, 'linked.png'), opts);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'outside-project',
    'the containment test must apply to where the link POINTS, not where it sits');
});

test('a non-image, and an SVG in particular, is refused', () => {
  assert.strictEqual(images.resolveRef(path.join(REPO, 'notes.txt'), opts).reason, 'unsupported-type');
  assert.strictEqual(
    images.resolveRef(path.join(REPO, 'vector.svg'), opts).reason, 'unsupported-type',
    'an SVG is a script-bearing document, and these render in a same-origin iframe',
  );
});

test('an oversized file is refused rather than copied into the state dir', () => {
  const big = path.join(REPO, 'huge.png');
  fs.writeFileSync(big, Buffer.alloc(images.MAX_BYTES + 1));
  assert.strictEqual(images.resolveRef(big, opts).reason, 'too-large');
  fs.unlinkSync(big);
});

test('a bare token that is not a live screenshot id says so, rather than "not found"', () => {
  const r = images.resolveRef('deadbeef', opts);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown-screenshot-id',
    'a stale or invented id is far likelier than a relative filename with no slash, and '
    + 'the agent can only act on the difference if we name it');
});

test('an empty or missing ref is a clean refusal, never a throw', () => {
  assert.strictEqual(images.resolveRef('', opts).reason, 'empty');
  assert.strictEqual(images.resolveRef(null, opts).reason, 'empty');
  assert.strictEqual(images.resolveRef(path.join(REPO, 'nope.png'), opts).reason, 'not-found');
});

test('a session with no directory at all cannot reach any path', () => {
  const homeless = { entry: {}, ctx: { ...ctx, sessionPaths: () => ({}) } };
  assert.strictEqual(images.resolveRef(path.join(REPO, 'shot.png'), homeless).reason, 'no-session-directory');
  // …but a screenshot id still works, because it never touches a session directory.
  assert.strictEqual(images.resolveRef('a1b2c3d4', homeless).ok, true);
});

// ── ingest ───────────────────────────────────────────────────────────────────

test('ingest copies the bytes and returns filenames, never paths or base64', () => {
  const item = { id: 'w1' };
  const { imagesList, skipped } = (() => {
    const r = images.ingest(item, ['a1b2c3d4', './shot.png'], opts);
    return { imagesList: r.images, skipped: r.skipped };
  })();
  assert.deepStrictEqual(skipped, []);
  assert.deepStrictEqual(imagesList.map((i) => i.file), ['w1-0.png', 'w1-1.png']);
  for (const img of imagesList) {
    const copied = path.join(images.imagesDir(), img.file);
    assert.ok(fs.existsSync(copied), `${img.file} should have been copied`);
    assert.deepStrictEqual(fs.readFileSync(copied), PNG, 'the bytes, not a link');
  }
  const serialized = JSON.stringify(imagesList);
  assert.ok(!/base64|data:/i.test(serialized),
    'workshop.json is read WHOLE on every 2s inbox poll — an inlined image there is fatal');
});

test('a copy that survives its source is the whole point of copying', () => {
  const item = { id: 'w2' };
  const { images: got } = images.ingest(item, ['a1b2c3d4'], opts);
  // The screenshots subsystem deletes anything older than 7 days. Simulate that.
  fs.unlinkSync(path.join(SHOTS, 'a1b2c3d4.png'));
  assert.ok(
    fs.existsSync(path.join(images.imagesDir(), got[0].file)),
    'a result must still show its evidence after the screenshot it came from is swept',
  );
  fs.writeFileSync(path.join(SHOTS, 'a1b2c3d4.png'), PNG);   // restore for later tests
});

test('good refs still land when a bad one is mixed in, and the bad one is named', () => {
  const item = { id: 'w3' };
  const r = images.ingest(item, [path.join(OUTSIDE, 'secret.png'), './shot.png'], opts);
  assert.deepStrictEqual(r.images.map((i) => i.file), ['w3-0.png'],
    'numbering follows what LANDED, so an item owns a dense run');
  assert.deepStrictEqual(r.skipped, [{ ref: path.join(OUTSIDE, 'secret.png'), reason: 'outside-project' }]);
});

test('ingest is capped, so one call cannot fill the store', () => {
  const item = { id: 'w4' };
  const many = new Array(images.MAX_IMAGES + 5).fill('./shot.png');
  const r = images.ingest(item, many, opts);
  assert.strictEqual(r.images.length + r.skipped.length, images.MAX_IMAGES);
});

test('no images is not an error', () => {
  assert.deepStrictEqual(images.ingest({ id: 'w5' }, undefined, opts), { images: [], skipped: [] });
  assert.deepStrictEqual(images.ingest({ id: 'w5' }, [], opts), { images: [], skipped: [] });
});

// ── sweepOrphans ─────────────────────────────────────────────────────────────

test('sweepOrphans deletes what no live item names, and nothing else', () => {
  const keep = { id: 'w9', images: [] };
  keep.images = images.ingest(keep, ['./shot.png'], opts).images;
  const evicted = { id: 'w8', images: [] };
  evicted.images = images.ingest(evicted, ['./shot.png'], opts).images;

  const keptFile = path.join(images.imagesDir(), keep.images[0].file);
  const goneFile = path.join(images.imagesDir(), evicted.images[0].file);

  // `evicted` is what retain() dropped from workshop.json: it is simply not in the list.
  images.sweepOrphans([keep]);

  assert.ok(fs.existsSync(keptFile), 'a live result keeps its evidence');
  assert.ok(!fs.existsSync(goneFile),
    'an evicted result must not leave its PNGs behind — this sweep is what bounds the store');
});

test('sweepOrphans on a missing store is a no-op, not a throw', () => {
  const saved = process.env.HOME;
  process.env.HOME = path.join(SCRATCH, 'nonexistent-home');
  try {
    assert.strictEqual(images.sweepOrphans([]), 0);
  } finally {
    process.env.HOME = saved;
  }
});

// ── servePath ────────────────────────────────────────────────────────────────

test('servePath accepts only names this module produces', () => {
  const item = { id: 'w20' };
  const { images: got } = images.ingest(item, ['./shot.png'], opts);
  const full = images.servePath(got[0].file);
  assert.ok(full && full.endsWith(got[0].file));
  assert.ok(fs.existsSync(full));
});

test('servePath refuses traversal, absolute paths and anything not <itemId>-<n>.<ext>', () => {
  for (const bad of [
    '../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '/etc/passwd',
    'w1-0.png/../../../etc/passwd',
    'workshop.json',
    'w1-0.svg',
    'w1.png',
    'shot.png',
    '',
    null,
    undefined,
  ]) {
    assert.strictEqual(images.servePath(bad), null, `servePath must refuse ${JSON.stringify(bad)}`);
  }
});

test('servePath returns null for a well-formed name with no file behind it', () => {
  assert.strictEqual(images.servePath('w9999-0.png'), null,
    'the route turns this into a 404 rather than a sendFile of nothing');
});
