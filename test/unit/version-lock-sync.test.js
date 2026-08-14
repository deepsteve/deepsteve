// Drift guard: package-lock.json's version must track package.json's.
//
// A version bump is the one edit in this repo that has to touch two files. `npm version`
// writes both; hand-editing `package.json` writes one, and nothing at the point of the
// mistake complains — `npm install` and `npm ci` both tolerate the mismatch, and the
// daemon runs fine. The failure surfaces two steps later: `release.sh` hard-fails on the
// drift, and `check-installer.yml` runs `release.sh` on every push to main, so the bump
// commit lands red. That has now happened more than once, always the same way, because
// the only guard lived in a script nobody runs before pushing.
//
// So the check moves to where a bump is actually made: `npm run test:unit` is the fast,
// no-daemon, no-shell suite, and this fails there in milliseconds with the exact fix
// command. release.sh keeps its copy of the guard — it is the last line of defense for a
// release cut without running the tests — but this one fires first.
//
// Pure file reads, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/version-lock-sync.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));

const FIX = (v) => `Run: npm version ${v} --no-git-tag-version --allow-same-version`;

test('package-lock.json top-level version matches package.json', () => {
  assert.strictEqual(
    lock.version,
    pkg.version,
    `package-lock.json version (${lock.version}) does not match package.json (${pkg.version}). ${FIX(pkg.version)}`,
  );
});

// `npm version` writes the version twice into the lock: once at the top level and once in
// the root package entry. Hand-repairing only the visible one at the top of the file still
// fails release.sh, which checks both.
test('package-lock.json root package entry matches package.json', () => {
  const root = (lock.packages || {})[''];
  assert.ok(root, 'package-lock.json has no root ("") package entry');
  assert.strictEqual(
    root.version,
    pkg.version,
    `package-lock.json packages[""].version (${root.version}) does not match package.json (${pkg.version}). ${FIX(pkg.version)}`,
  );
});

// The lock is for this package; a rename that misses it would make `npm ci` install
// under the wrong name.
test('package-lock.json names the same package', () => {
  assert.strictEqual(lock.name, pkg.name);
});
