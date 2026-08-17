// Drift guards for the npm package surface (#636).
//
// The npm channel has a failure mode the curl channel does not: npm versions are
// IMMUTABLE. A tarball that is missing a module, or that ships the test suite, or
// that republishes the maintainer-only release skill, burns a version number
// permanently — `npm install -g deepsteve` keeps serving it until a later version
// supersedes it, and it can never be corrected in place.
//
// So the `files` allowlist gets the same treatment release.sh's embed list has: it is
// checked against the tree rather than trusted. The four things asserted here are the
// four ways it has a silent failure:
//
//   1. A new root module (a new require() in server.js) not covered -> MODULE_NOT_FOUND
//      on every fresh install, with the package looking perfectly fine on npmjs.com.
//   2. A new root *.sh shipping, or restart.sh/release.sh shipping, by accident.
//   3. test/ or docs/ creeping back in — the state at v0.23.0 was 324 files, 123 of
//      them tests.
//   4. A `maintainer: true` skill reaching users, which release.sh withholds from
//      install.sh but an allowlist that names `skills/` would happily republish.
//
// Pure file reads — no npm, no daemon, no shell — so this runs in the bare `unit` CI
// job. The one thing it cannot check is npm's own glob semantics; that is what
// `npm pack --dry-run` in test/Dockerfile.npm is for.
//
// Run: node --test test/unit/npm-package.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const files = pkg.files || [];

/** The allowlist entries that add files, without the `!` exclusions. */
const included = files.filter((f) => !f.startsWith('!'));
/** The `!` exclusions, normalized to a plain path. */
const excluded = files.filter((f) => f.startsWith('!')).map((f) => f.slice(1));

/**
 * Does the allowlist cover this repo-relative path?
 *
 * Deliberately a coarse reading of npm's gitignore-style matching — a rooted `/*.js`
 * for root modules, a `dir/` prefix for directories, or an exact name. It is not a
 * reimplementation of npm-packlist: it only has to be strict enough that a file the
 * daemon needs cannot be silently absent, and the container suite verifies the real
 * pack output.
 */
function covered(rel) {
  if (excluded.includes(rel)) return false;
  return included.some((pattern) => {
    if (pattern === rel) return true;
    if (pattern.endsWith('/')) return rel.startsWith(pattern);
    if (pattern === '/*.js' || pattern === '*.js') return !rel.includes('/') && rel.endsWith('.js');
    return false;
  });
}

test('package.json declares a files allowlist and a bin entrypoint', () => {
  // Without these the rest of this file is vacuous.
  assert.ok(files.length > 0, 'package.json has no "files" allowlist — the whole tree would ship');
  assert.ok(pkg.bin && pkg.bin.deepsteve,
    'package.json has no bin.deepsteve — `npm install -g deepsteve` would provide no command');
});

test('the package page has somewhere to send people (#518)', () => {
  // npmjs.com renders `homepage` and `bugs` as the only two links out of the package page
  // besides the repo. #518's complaint is that deepsteve is undiscoverable — a listing that
  // dead-ends is the same problem one hop further in.
  assert.strictEqual(pkg.homepage, 'https://deepsteve.com',
    'package.json has no homepage — the npm page would not link to the site');
  assert.ok(pkg.bugs && pkg.bugs.url,
    'package.json has no bugs.url — the npm page would not link to the issue tracker');
  assert.ok(pkg.description && pkg.description.length > 20,
    'the npm listing shows `description` under the package name; it must say what this is');
});

test('"private": true is still the publish guard', () => {
  // Removing it is the LAST step of publishing, done deliberately by a maintainer
  // following RELEASING.md — not something that should drift in unnoticed, because
  // the version it burns cannot be reused.
  assert.strictEqual(pkg.private, true,
    'package.json is no longer private. That is the only thing preventing an accidental\n' +
    '  publish of a broken tarball, and npm versions are immutable. If this is a real\n' +
    '  release, see RELEASING.md — the guard is removed and restored around one publish.');
});

test('every root *.js module is in the allowlist', () => {
  // Same rule as release.sh's embed list ("every root module, not a hand-maintained
  // list"): a module reachable from server.js that does not ship crash-loops the
  // daemon on a fresh install with MODULE_NOT_FOUND. Mods also require back into the
  // root (`../../paths`, `../../html-source.js`), so "not required by server.js" is
  // not a reason to leave one out.
  const rootJs = fs.readdirSync(REPO).filter((f) => f.endsWith('.js')).sort();
  assert.ok(rootJs.length > 10, 'suspiciously few root modules — is REPO pointing at the right dir?');
  for (const f of rootJs) {
    assert.ok(covered(f), `${f} is not covered by package.json "files"`);
  }
});

test('every runtime directory is in the allowlist', () => {
  // public/ and mods/ are served, mods/ and skills/ are read AND written by the
  // daemon, engines/ is required at load, themes/ is copied into the state dir.
  for (const dir of ['engines/', 'public/', 'mods/', 'skills/', 'themes/', 'bin/']) {
    assert.ok(included.includes(dir), `"${dir}" is missing from package.json "files"`);
  }
});

test('the shipped root *.sh set is exactly service.sh, status.sh, uninstall.sh', () => {
  // The same ship list restart.sh and release.sh agree on (test/unit/shell-deploy.test.js).
  // restart.sh must never reach a deploy target — a copy of it inside ~/.deepsteve is a
  // second restart entry point — and release.sh is a maintainer tool. install.sh is
  // generated and gitignored, so it is only present on a machine that has cut a release.
  const GENERATED = new Set(['install.sh']);
  const TOOLING = new Set(['restart.sh', 'release.sh']);
  const rootSh = fs.readdirSync(REPO).filter((f) => f.endsWith('.sh')).sort();
  const expected = rootSh.filter((f) => !TOOLING.has(f) && !GENERATED.has(f));
  assert.deepStrictEqual(expected, ['service.sh', 'status.sh', 'uninstall.sh'],
    'a new root *.sh appeared — decide deliberately whether it ships, then update this list');

  for (const f of expected) {
    assert.ok(covered(f), `${f} is not covered by package.json "files"`);
  }
  for (const f of [...TOOLING, ...GENERATED]) {
    assert.ok(!covered(f), `${f} must NOT ship in the npm tarball`);
  }
});

test('no dev-only directory is in the allowlist', () => {
  // v0.23.0 packed 324 files, 123 of them tests. screenshots/ is 828K of README
  // images; docs/ and mod-tutorials/ are read by no code path at all.
  for (const dir of ['test', 'docs', 'screenshots', 'mod-tutorials', '.github', '.opencode']) {
    for (const pattern of included) {
      assert.ok(!pattern.replace(/^\//, '').startsWith(dir),
        `"${pattern}" would ship ${dir}/ — it is not read at runtime`);
    }
  }
});

test('bin/deepsteve.js is executable and runnable as a CLI', () => {
  const binRel = pkg.bin.deepsteve;
  const binPath = path.join(REPO, binRel);
  assert.ok(fs.existsSync(binPath), `bin.deepsteve points at ${binRel}, which does not exist`);

  const body = fs.readFileSync(binPath, 'utf8');
  assert.match(body.split('\n')[0], /^#!\/usr\/bin\/env node$/,
    'the bin entrypoint needs a `#!/usr/bin/env node` shebang');

  // npm sets the mode on install, but a non-executable file in git means anyone
  // running it out of a checkout gets EACCES.
  assert.ok(fs.statSync(binPath).mode & 0o111, `${binRel} is not executable`);
});

test('the CLI never restarts the daemon without a confirmation', () => {
  // CLAUDE.md's rule: a restart can never happen unilaterally. ./restart.sh keeps that
  // guarantee by staying behind a permission prompt, and the CLI keeps it by going
  // through the SAME two gates the server owns — the in-browser confirm, or the
  // two-step --force/--prompt echo that re-validates the live session count.
  //
  // The failure this catches is a later edit that "simplifies" restart into a bare
  // stop+start, which would work perfectly and silently remove the gate.
  const cli = fs.readFileSync(path.join(REPO, pkg.bin.deepsteve), 'utf8');
  assert.ok(cli.includes('/api/request-restart'),
    'the CLI must ask the browser to confirm a restart, as ./restart.sh does');
  assert.ok(cli.includes('/api/restart-prompt'),
    'the --force path must read the server-owned prompt text so the session count is real');
  assert.ok(cli.includes('Restart cancelled.'),
    'a declined or unanswered confirmation must abort the restart');
});

test('the CLI runs the deployed entry points through their own shebang', () => {
  // status.sh and uninstall.sh are `#!/bin/bash`, and uninstall.sh uses `&>` — which
  // dash parses as "background, then redirect", so `if command -v claude &>/dev/null`
  // silently takes the wrong branch. On Linux `sh` IS dash, so invoking them as
  // `sh <script>` is quietly wrong in the code path that removes things.
  //
  // service.sh is the opposite case: it is POSIX-only by design (service-lib.test.js
  // pins that, and the CI unit job sources it with dash), and it is a library with no
  // exec bit, so `sh -c '. service.sh; ...'` is the correct way to reach it.
  const cli = fs.readFileSync(path.join(REPO, pkg.bin.deepsteve), 'utf8');
  for (const script of ['status.sh', 'uninstall.sh']) {
    assert.ok(!new RegExp(`'sh',\\s*\\[[^\\]]*${script.replace('.', '\\.')}`).test(cli),
      `the CLI runs ${script} through sh — it is a bash script, and sh is dash on Linux`);
  }
  assert.match(cli, /spawnSync\(script, \[\]/,
    'the deployed entry points must be executed directly so their shebang is honored');
});

test('the CLI does not reimplement the launchd plist or the systemd unit', () => {
  // service.sh is the single definition of both, diffed against golden fixtures by
  // test/unit/service-definition.test.js. A second copy in JS is exactly the drift
  // #621 removed, and it would not be covered by those fixtures.
  const cli = fs.readFileSync(path.join(REPO, pkg.bin.deepsteve), 'utf8');
  for (const marker of ['ProgramArguments', 'KillMode', 'ExecStart', 'RunAtLoad']) {
    assert.ok(!cli.includes(marker),
      `bin/deepsteve.js names ${marker} — the service definition belongs to service.sh alone`);
  }
  assert.ok(!/\blaunchctl\b/.test(cli) && !/\bsystemctl\b/.test(cli),
    'the CLI must drive the service manager through service.sh verbs, never directly');
});
