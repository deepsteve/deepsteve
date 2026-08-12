// The build guard for #637: nothing under test/integration/** may invent a filesystem
// path for the daemon out of os.tmpdir(). It goes through test/helpers/server-dir.js.
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
});

test('no integration suite reaches for os.tmpdir() or mkdtemp', () => {
  const offenders = [];
  for (const rel of FILES) {
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    if (/\bos\s*\.\s*tmpdir\s*\(/.test(src)) offenders.push(`${rel}: os.tmpdir()`);
    if (/\bmkdtemp(Sync)?\s*\(/.test(src)) offenders.push(`${rel}: mkdtemp`);
    if (/\bprocess\s*\.\s*env\s*\.\s*TMPDIR\b/.test(src)) offenders.push(`${rel}: process.env.TMPDIR`);
  }
  assert.deepStrictEqual(offenders, [],
    'A path made from os.tmpdir() exists for the TEST process, not necessarily for the daemon '
    + `under test — in CI they are separate containers, and since #632 the server refuses a cwd `
    + `it cannot see. Use makeServerDir()/reserveMissingServerPath() from ${HELPER_REL}. `
    + `Offenders:\n  ${offenders.join('\n  ')}`);
});

// --- the other half: the mount the helper depends on --------------------------
//
// The helper is only correct in CI because compose puts the same volume in BOTH
// services and points the test container at it. Delete either and the helper silently
// falls back to os.tmpdir() — exactly the bug, with the fix's name on it.

test('docker-compose.yml mounts a shared scratch volume into both services', () => {
  const compose = fs.readFileSync(path.join(TEST_DIR, 'docker-compose.yml'), 'utf8');
  const mounts = compose.match(/ds_scratch:\/scratch/g) || [];
  assert.strictEqual(mounts.length, 2,
    'both `server` and `test` must mount ds_scratch:/scratch — one alone means the test '
    + `container makes directories the server cannot see (#637). Found ${mounts.length}.`);
  assert.match(compose, /DEEPSTEVE_TEST_SCRATCH=\/scratch/,
    'the test service must point server-dir.js at the shared mount, or it falls back to os.tmpdir()');
  assert.match(compose, /^volumes:\n(?:.*\n)*?\s+ds_scratch:/m,
    'ds_scratch must be declared in the top-level volumes: block');
});
