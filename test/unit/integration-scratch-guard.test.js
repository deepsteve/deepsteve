// The build guard for #637: nothing under test/integration/** may invent a filesystem
// path for the daemon — not out of os.tmpdir(), and not out of a hardcoded /tmp subpath,
// which is the same defect in different clothes. It goes through test/helpers/server-dir.js.
//
// Why this needs a guard rather than a comment. `test/integration/**` talks to a daemon
// over DEEPSTEVE_URL, and that daemon is NOT necessarily on this filesystem — in CI it is
// a second container. For most of this project's life the mistake was invisible: tmux
// silently relocated a pane whose cwd did not exist to $HOME, so handing the server a
// path it had never heard of still produced a working session. #632 closed that hole by
// refusing the spawn, which was correct — and instantly turned a latent wrong assumption
// in #632's OWN new test into two days of red CI that the author could not reproduce,
// because `npm test` run locally provisions a daemon on this machine, where os.tmpdir()
// really is shared. Local green, CI red, same commit.
//
// Same idiom as tmux-sandbox-guard.test.js (#625), ws-client-guard.test.js (#562) and
// compose-projects.test.js (#616): comments are stripped before matching so files can
// still explain themselves at length, the tree is globbed rather than listed so a new
// suite is covered the moment it lands, and the first assertions prove the scan is not
// vacuous — a broken walk would otherwise turn every ban below into a silent no-op.
//
// Pure fs reads, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/integration-scratch-guard.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(TEST_DIR, '..');
const INTEGRATION_DIR = path.join(TEST_DIR, 'integration');
const HELPER_REL = 'test/helpers/server-dir.js';

// --- the scan -----------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(path.relative(REPO_ROOT, p));
  }
  return out;
}

/** Strip // and /* comments so a file may name a banned call while explaining it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

const FILES = walk(INTEGRATION_DIR);

test('the scan is not vacuous', () => {
  assert.ok(FILES.length >= 3, `expected several integration suites, found ${FILES.length}`);
  assert.ok(FILES.includes('test/integration/session-lifecycle.test.js'),
    'the suite this guard was written for must be in the scan');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, HELPER_REL)), `${HELPER_REL} must exist`);
});

test('stripComments does not eat code, and does eat comments', () => {
  assert.match(stripComments('const u = "http://x";\n'), /http:\/\/x/);
  assert.doesNotMatch(stripComments('// os.tmpdir() is banned here\n'), /tmpdir/);
  assert.doesNotMatch(stripComments('/* os.tmpdir() */\n'), /tmpdir/);
  // A URL survives the // eater, and the /tmp ban must not fire on one.
  assert.match(stripComments("const u = 'http://server:3000';\n"), /server:3000/);
  assert.doesNotMatch(stripComments("const u = 'http://server:3000';\n"), /(['"`])\/tmp\//);
});

// The ban above is only worth anything if its patterns actually separate the legal
// spelling from the illegal one. Asserting that here means a future loosening shows up
// as a failure in THIS file, rather than as a guard that silently stops catching things.
test('the /tmp patterns reject subpaths and spare a bare /tmp cwd', () => {
  const subpath = /(['"`])\/tmp\//;
  const joined = /path\s*\.\s*(?:join|resolve)\s*\(\s*['"`]\/tmp/;

  assert.match("fs.mkdirSync('/tmp/ds-probe')", subpath);
  assert.match('fs.mkdirSync(`/tmp/${name}`)', subpath);
  assert.match("path.join('/tmp', 'ds-probe')", joined);
  assert.match("path.resolve( '/tmp', x)", joined);

  assert.doesNotMatch("client.connect({ cwd: '/tmp' })", subpath);
  assert.doesNotMatch("output.includes('/tmp')", subpath);
  assert.doesNotMatch('await client.waitForOutput(/\\/tmp/, 10000)', subpath);
  assert.doesNotMatch("client.connect({ cwd: '/tmp' })", joined);
});

test('no integration suite invents a path the daemon cannot see', () => {
  const offenders = [];
  for (const rel of FILES) {
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    if (/\bos\s*\.\s*tmpdir\s*\(/.test(src)) offenders.push(`${rel}: os.tmpdir()`);
    if (/\bmkdtemp(Sync)?\s*\(/.test(src)) offenders.push(`${rel}: mkdtemp`);
    if (/\bprocess\s*\.\s*env\s*\.\s*TMPDIR\b/.test(src)) offenders.push(`${rel}: process.env.TMPDIR`);
    // The same defect spelled without os.tmpdir(). A bare '/tmp' is fine and stays legal —
    // it exists in both containers and ~30 spawns use it as a cwd. A SUBPATH is not: it
    // exists only once someone creates it, and the someone is this process.
    if (/(['"`])\/tmp\//.test(src)) offenders.push(`${rel}: a hardcoded /tmp subpath`);
    if (/path\s*\.\s*(?:join|resolve)\s*\(\s*['"`]\/tmp/.test(src)) offenders.push(`${rel}: path.join('/tmp', …)`);
  }
  assert.deepStrictEqual(offenders, [],
    'A path this process makes under /tmp exists for the TEST process, not necessarily for the '
    + 'daemon under test — in CI they are separate containers, and since #632 the server refuses '
    + `a cwd it cannot see. Use makeServerDir()/reserveMissingServerPath() from ${HELPER_REL}. `
    + "(Passing a bare '/tmp' as a cwd is still fine: it exists on both sides because neither "
    + 'side had to create it.) '
    + `Offenders:\n  ${offenders.join('\n  ')}`);
});

// --- the other half: the mount the helper depends on --------------------------
//
// The helper is only correct because compose puts the same volume in BOTH services and
// points the test container at it. Drop either half and server-dir.js stops working:
// silently falling back to os.tmpdir() where the daemon looks local, throwing where it
// doesn't.
//
// #637 added that mount to docker-compose.yml, and this file asserted it there BY NAME.
// Three sibling composes run the identical suite against a daemon in an identical second
// container, and got neither the mount nor the assertion — so the fix was half a fix and
// nothing could say so. The public suite went red on the next release; install and npm
// would have thrown `DEEPSTEVE_TEST_SCRATCH is unset` the moment anyone ran them.
//
// So the check is per-suite and glob-driven now, and it resolves `extends:` — a suite may
// inherit the mount from test/docker-compose.base.yml rather than restate it, and the
// point is that it must end up with it either way.

const COMPOSE_FILES = fs.readdirSync(TEST_DIR)
  .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
  .sort();

/** Full-line AND trailing comments: these files explain themselves at length, and a
 *  sentence naming the mount must not stand in for the mount. */
const uncommented = (text) => text
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/\s+#.*$/, ''))
  .join('\n');

const composeText = (file) => uncommented(fs.readFileSync(path.join(TEST_DIR, file), 'utf8'));

/**
 * The `services:` block, split by service name.
 *
 * Hand-rolled rather than parsed: this runs in the bare `unit` CI job, which installs no
 * YAML parser, and these files are small, uniform and themselves machine-checked.
 */
function serviceBlocks(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  const blocks = new Map();
  if (start === -1) return blocks;
  let name = null;
  let buf = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;              // back to column 0 — the services block ended
    const m = line.match(/^ {2}(\S+):\s*$/);
    if (m) {
      if (name) blocks.set(name, buf.join('\n'));
      name = m[1];
      buf = [];
    } else if (name) buf.push(line);
  }
  if (name) blocks.set(name, buf.join('\n'));
  return blocks;
}

/** A service's own definition plus whatever it `extends`, so one string carries the truth. */
function effectiveService(file, service, depth = 0) {
  assert.ok(depth < 4, `${file}: extends chain for \`${service}\` is too deep — a cycle?`);
  const block = serviceBlocks(composeText(file)).get(service);
  assert.ok(block !== undefined, `test/${file} has no \`${service}\` service`);
  const m = block.match(/extends:\s*\n\s*file:\s*(\S+)\s*\n\s*service:\s*(\S+)/);
  return m ? `${block}\n${effectiveService(m[1], m[2], depth + 1)}` : block;
}

/** Files that exist to be extended are not suites; nothing runs them. */
const EXTENDED = new Set(
  COMPOSE_FILES.flatMap((f) => [...composeText(f).matchAll(/extends:\s*\n\s*file:\s*(\S+)/g)]
    .map((m) => m[1])));

/**
 * A suite = something that runs test/integration/** against a daemon in another container.
 *
 * Discovery runs at module scope, so it must not throw: a compose with no `test` service
 * is simply not a suite, and saying so here beats an unhandled error before any test runs.
 */
const SUITE_FILES = COMPOSE_FILES.filter((f) => {
  if (EXTENDED.has(f)) return false;
  if (!serviceBlocks(composeText(f)).has('test')) return false;
  return /run-integration\.sh/.test(effectiveService(f, 'test'));
});

test('the compose scan finds every suite (#637)', () => {
  for (const expected of ['docker-compose.yml', 'docker-compose.install.yml',
    'docker-compose.npm.yml', 'docker-compose.public.yml']) {
    assert.ok(SUITE_FILES.includes(expected),
      `expected test/${expected} in the scan; found [${SUITE_FILES.join(', ')}]. If it was `
      + 'renamed, update this list — the assertion below is vacuous when the glob misses, and '
      + 'a suite missing from it is precisely how #637 shipped half-fixed.');
  }
});

test('the block splitter and the extends walk actually resolve something', () => {
  const blocks = serviceBlocks('services:\n  a:\n    x: 1\n  b:\n    y: 2\nvolumes:\n  v:\n');
  assert.deepStrictEqual([...blocks.keys()], ['a', 'b']);
  assert.match(blocks.get('a'), /x: 1/);
  assert.doesNotMatch(blocks.get('a'), /y: 2/, 'a service block must stop at the next service');
  assert.doesNotMatch(
    serviceBlocks(uncommented('services:\n  a:\n    # ds_scratch:/scratch\n    v: x  # ds_scratch:/scratch\n')).get('a'),
    /ds_scratch/, 'comments are stripped before any of this is matched — a sentence naming '
    + 'the mount must not stand in for the mount');

  // And the walk must genuinely cross a file boundary for at least one real suite, or the
  // inheritance the assertion below permits is itself untested.
  const inheriting = SUITE_FILES.filter((f) => /extends:/.test(composeText(f)));
  assert.ok(inheriting.length >= 1,
    'no suite extends a base file; the extends resolution below is never exercised');
  const own = serviceBlocks(composeText(inheriting[0])).get('server');
  assert.doesNotMatch(own, /ds_scratch:\/scratch/,
    `test/${inheriting[0]} states the mount itself, so it cannot prove the walk found one`);
  assert.match(effectiveService(inheriting[0], 'server'), /ds_scratch:\/scratch/,
    'the extends walk did not pull the base file in');
});

test('every suite gives its two containers a scratch dir they share (#637)', () => {
  for (const file of SUITE_FILES) {
    const where = `test/${file}`;
    assert.match(effectiveService(file, 'server'), /ds_scratch:\/scratch/,
      `${where}: the \`server\` service must mount ds_scratch:/scratch, or every cwd the test `
      + 'container creates is one the daemon refuses to spawn into (#632/#637).');
    const tests = effectiveService(file, 'test');
    assert.match(tests, /ds_scratch:\/scratch/,
      `${where}: the \`test\` service must mount the SAME ds_scratch:/scratch — one side alone `
      + 'is not a shared directory.');
    assert.match(tests, /DEEPSTEVE_TEST_SCRATCH=\/scratch/,
      `${where}: the \`test\` service must point server-dir.js at the shared mount. Without it `
      + 'the helper throws (remote daemon) or silently uses os.tmpdir() (local one).');
    // `extends` copies no top-level keys, so an inherited mount still needs its volume
    // declared in the suite's own file. Compose fails the whole project without it.
    assert.match(composeText(file), /^volumes:\n(?:.*\n)*?\s{2}ds_scratch:\s*$/m,
      `${where}: ds_scratch must be declared in this file's top-level volumes: block — `
      + 'extends does not copy it from the base.');
  }
});
