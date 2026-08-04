// Anti-drift test for the Public Install suite's version pin (#588).
//
// test/Dockerfile.public installs the LAST PUBLISHED RELEASE (deepsteve.com/install.sh 302s to
// releases/latest/download/install.sh). The daily workflow therefore has to run THAT release's
// tests: main is always ahead of the last release, so running main's suite against it reddens
// the job on every post-release feature test until the next release ships. The pin is one line
// — `ref:` on the checkout — which makes it very easy to delete by accident while "simplifying"
// the workflow, and the resulting breakage only shows up days later on a cron run.
//
// So this asserts the shape of the workflow file itself: resolve a release tag → check out THAT
// tag → assert the running server really is it → only then run the suite. Pure file read, no
// daemon and no shell, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/public-suite-pin.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'install-integration-tests.yml');
const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');

const firstLine = (pred, what) => {
  const i = lines.findIndex(pred);
  assert.ok(i !== -1, `${WORKFLOW}: expected a line ${what}`);
  return i;
};

test('the suite is pinned to a release tag, never to main (#588)', () => {
  const checkouts = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /uses:\s*actions\/checkout@/.test(l));

  assert.strictEqual(checkouts.length, 1,
    'expected exactly one actions/checkout step; if you add another, make sure none of them ' +
    'checks out the default branch — the suite must be built from the release under test (#588)');

  // The `ref:` must live in the checkout's own `with:` block, i.e. the next few lines.
  const after = lines.slice(checkouts[0].i + 1, checkouts[0].i + 6).join('\n');
  assert.match(after, /ref:\s*\$\{\{\s*steps\.\w+\.outputs\.tag\s*\}\}/,
    'the checkout must pass `ref: ${{ steps.<id>.outputs.tag }}` — without it the job builds ' +
    'the test container from main and runs unreleased tests against the released server (#588)');
});

test('the tag comes from the published release, not a hardcoded value (#588)', () => {
  firstLine((l) => l.includes('releases/latest'),
    'resolving the tag from the releases API (that is what deepsteve.com/install.sh serves)');
  firstLine((l) => /echo\s+"tag=/.test(l),
    'writing the resolved tag to $GITHUB_OUTPUT for the checkout to consume');
});

test('the job proves the running server is the checked-out release (#588)', () => {
  firstLine((l) => l.includes('/root/.deepsteve/package.json'),
    "reading the installed build's version out of the server container");
  firstLine((l) => l.includes('::error::') && l.includes('checked out'),
    'failing loudly when install.sh served a different release than the tag we checked out');
});

test('nothing runs the suite before the release is checked out (#588)', () => {
  const checkout = firstLine((l) => /uses:\s*actions\/checkout@/.test(l), 'checking out the repo');
  const suite = firstLine(
    (l) => l.includes('docker-compose.public.yml') && / up( |$)/.test(l),
    'bringing the public compose up');
  assert.ok(suite > checkout,
    `the suite is started at line ${suite + 1}, before the release checkout at line ${checkout + 1}; ` +
    'the containers must be built from the release under test (#588)');
});
