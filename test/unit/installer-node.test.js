// The installer's bundled Node (#745): pinned to a release no advisory lists, and upgraded on
// reinstall when the copy in ~/.deepsteve/node is older than the pin — while a Node the user
// installed is never touched.
//
// Runs the real text between release.sh's `bundled node` markers (it sits in the quoted PREAMBLE
// heredoc, so that text is byte-for-byte what install.sh executes) under bash, in a scratch HOME,
// with a PATH holding only the tools the block needs plus a stub `curl` that serves a fake Node
// tarball. Nothing is downloaded and no real node is involved, so this runs in the bare unit job.
//
// Run: node --test test/unit/installer-node.test.js

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { affectingAdvisories } = require('../../node-advisories');

const ROOT = path.join(__dirname, '..', '..');
const RELEASE = fs.readFileSync(path.join(ROOT, 'release.sh'), 'utf8');
const BEGIN = '# --- bundled node: begin ---';
const END = '# --- bundled node: end ---';
const PINNED = (/^NODE_VERSION="(\d+\.\d+\.\d+)"$/m.exec(RELEASE) || [])[1];
const OLD = '22.14.0';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-installer-node-'));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function nodeBlock() {
  const preamble = RELEASE.indexOf(`cat >> "$OUT" << 'PREAMBLE'\n`);
  const preambleEnd = RELEASE.indexOf('\nPREAMBLE\n', preamble);
  const b = RELEASE.indexOf(BEGIN);
  const e = RELEASE.indexOf(END);
  assert.ok(preamble >= 0 && preambleEnd > preamble, 'release.sh has a quoted PREAMBLE heredoc');
  assert.ok(b > preamble && e > b && e < preambleEnd,
    'the bundled-node markers must sit inside the PREAMBLE heredoc, or this test is not running what install.sh runs');
  return RELEASE.slice(b, e + END.length);
}

function which(tool) {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// Only these, so no real node or brew on this machine can leak into the scenario.
const TOOLS = path.join(SCRATCH, 'tools');
fs.mkdirSync(TOOLS);
for (const tool of ['uname', 'mkdir', 'dirname', 'mktemp', 'awk', 'rm', 'mv', 'cp', 'tar', 'gzip', 'shasum', 'sha256sum']) {
  const real = which(tool);
  if (real) fs.symlinkSync(real, path.join(TOOLS, tool));
}
const BASH = which('bash');

// A stub that writes the fake tarball to the -o target and logs the URL it was asked for.
fs.writeFileSync(path.join(TOOLS, 'curl'), [
  '#!/bin/sh',
  'out=""; url=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac',
  'done',
  'echo "$url" >> "$CURL_LOG"',
  'cp "$FAKE_TGZ" "$out"',
  '',
].join('\n'), { mode: 0o755 });

// A "node" is a shell script that answers `node -p process.versions.node` with its version.
function writeNode(dir, version, marker) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  if (marker) fs.writeFileSync(path.join(dir, marker), marker);
}

// The fake download: node-v<PINNED>-<os>-<arch>/bin/node, the shape nodejs.org ships.
const PKG = path.join(SCRATCH, 'pkg');
writeNode(path.join(PKG, `node-v${PINNED}-fake`), PINNED, 'FROM_DOWNLOAD');
const FAKE_TGZ = path.join(SCRATCH, 'node.tgz');
execFileSync('tar', ['czf', FAKE_TGZ, '-C', PKG, `node-v${PINNED}-fake`], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const FAKE_SHA = crypto.createHash('sha256').update(fs.readFileSync(FAKE_TGZ)).digest('hex');

let n = 0;
function run({ managed, userNode, managedOnPath = false, sha = FAKE_SHA } = {}) {
  const dir = path.join(SCRATCH, `case-${++n}`);
  const home = path.join(dir, 'home');
  const managedDir = path.join(home, '.deepsteve', 'node');
  fs.mkdirSync(home, { recursive: true });
  if (managed) writeNode(managedDir, managed, 'FROM_BEFORE');
  const pathDirs = [];
  if (managed && managedOnPath) pathDirs.push(path.join(managedDir, 'bin')); // as the auto-update runs it
  if (userNode) {
    writeNode(path.join(dir, 'user-node'), userNode);
    pathDirs.push(path.join(dir, 'user-node', 'bin'));
  }
  pathDirs.push(TOOLS);
  const curlLog = path.join(dir, 'curl.log');
  const script = path.join(dir, 'install-node.sh');
  fs.writeFileSync(script, [
    'set -e',
    `NODE_VERSION="${PINNED}"`,
    ...['ARM64', 'X64', 'LINUX_ARM64', 'LINUX_X64'].map(k => `NODE_SHA256_${k}="${sha}"`),
    nodeBlock(),
    'echo "RESOLVED=$(command -v node || true)"',
    '',
  ].join('\n'));
  const r = spawnSync(BASH, [script], {
    encoding: 'utf8',
    env: { HOME: home, PATH: pathDirs.join(':'), TMPDIR: dir, CURL_LOG: curlLog, FAKE_TGZ },
  });
  const curls = fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n') : [];
  const version = (p) => fs.existsSync(p) ? execFileSync(p, { encoding: 'utf8' }).trim() : null;
  return {
    r, curls, home, managedDir,
    managedVersion: version(path.join(managedDir, 'bin', 'node')),
    userVersion: userNode ? version(path.join(dir, 'user-node', 'bin', 'node')) : null,
    resolved: (/^RESOLVED=(.*)$/m.exec(r.stdout) || [])[1],
    leftovers: fs.existsSync(path.dirname(managedDir))
      ? fs.readdirSync(path.dirname(managedDir)).filter(f => f !== 'node') : [],
  };
}

const ok = (res) => assert.strictEqual(res.r.status, 0, `block failed:\n${res.r.stdout}\n${res.r.stderr}`);

test('the pin is a release no advisory lists, with four distinct SHA256s', () => {
  assert.ok(PINNED, 'release.sh pins NODE_VERSION');
  assert.deepStrictEqual(affectingAdvisories(PINNED).map(a => a.id), [],
    `release.sh pins Node ${PINNED}, which node-advisories.js lists as affected`);
  const shas = ['ARM64', 'X64', 'LINUX_ARM64', 'LINUX_X64']
    .map(k => (new RegExp(`^NODE_SHA256_${k}="([0-9a-f]{64})"$`, 'm').exec(RELEASE) || [])[1]);
  assert.ok(shas.every(Boolean), 'each platform has a 64-hex SHA256');
  assert.strictEqual(new Set(shas).size, 4, 'no SHA256 is copied between platforms');
});

test('the tools the block needs exist here', () => {
  assert.ok(BASH, 'bash');
  for (const tool of ['uname', 'mkdir', 'dirname', 'mktemp', 'awk', 'rm', 'mv', 'tar']) {
    assert.ok(fs.existsSync(path.join(TOOLS, tool)), tool);
  }
  assert.ok(fs.existsSync(path.join(TOOLS, 'shasum')) || fs.existsSync(path.join(TOOLS, 'sha256sum')), 'a sha256 tool');
});

test('a bundled Node older than the pin is replaced in place on reinstall', () => {
  const res = run({ managed: OLD, managedOnPath: true });
  ok(res);
  assert.strictEqual(res.managedVersion, PINNED);
  assert.ok(fs.existsSync(path.join(res.managedDir, 'FROM_DOWNLOAD')), 'the new tree is in place');
  assert.ok(!fs.existsSync(path.join(res.managedDir, 'FROM_BEFORE')), 'the old tree is gone, not merged into');
  assert.deepStrictEqual(res.leftovers, [], 'no node.new / node.old left behind');
  assert.strictEqual(res.curls.length, 1);
  assert.match(res.curls[0], new RegExp(`/dist/v${PINNED.replace(/\./g, '\\.')}/node-v${PINNED.replace(/\./g, '\\.')}-`));
  // Same path, so the node recorded in the plist/unit still points at it.
  assert.strictEqual(res.resolved, path.join(res.managedDir, 'bin', 'node'));
});

test('it is upgraded even when it is not on PATH, and not downloaded twice', () => {
  const res = run({ managed: OLD });
  ok(res);
  assert.strictEqual(res.managedVersion, PINNED);
  assert.strictEqual(res.curls.length, 1);
  assert.strictEqual(res.resolved, path.join(res.managedDir, 'bin', 'node'), 'and it is the node the rest of install.sh uses');
});

test('a bundled Node already at the pin is left alone', () => {
  const res = run({ managed: PINNED, managedOnPath: true });
  ok(res);
  assert.deepStrictEqual(res.curls, []);
  assert.ok(fs.existsSync(path.join(res.managedDir, 'FROM_BEFORE')));
});

test('a Node the user installed is never touched, however old', () => {
  const res = run({ userNode: OLD });
  ok(res);
  assert.deepStrictEqual(res.curls, [], 'nothing downloaded');
  assert.strictEqual(res.userVersion, OLD);
  assert.ok(!fs.existsSync(res.managedDir), 'no ~/.deepsteve/node created');
  assert.match(res.resolved, /user-node\/bin\/node$/);
});

test('a checksum mismatch aborts and leaves the old bundled Node exactly as it was', () => {
  const res = run({ managed: OLD, managedOnPath: true, sha: '0'.repeat(64) });
  assert.notStrictEqual(res.r.status, 0, 'the installer must stop');
  assert.match(res.r.stderr, /checksum verification failed/);
  assert.strictEqual(res.managedVersion, OLD);
  assert.ok(fs.existsSync(path.join(res.managedDir, 'FROM_BEFORE')));
  assert.deepStrictEqual(res.leftovers, [], 'a failed upgrade stages nothing beside it');
});

test('a machine with no node at all still gets the pinned one', () => {
  const res = run({});
  ok(res);
  assert.strictEqual(res.managedVersion, PINNED);
  assert.strictEqual(res.curls.length, 1);
  assert.strictEqual(res.resolved, path.join(res.managedDir, 'bin', 'node'));
});
