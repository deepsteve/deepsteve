// Anti-drift test for the docker test suites' compose invariants (#616).
//
// Two properties every test/docker-compose*.yml must have, both learned the hard way:
//
//   1. Its own top-level `name:`. Compose otherwise derives the project name from the file's
//      parent directory — "test" for all of them — and the services inside are all called
//      server/test, so two suites share one project: an `up` in one recreates the other's
//      containers and a `down -v` deletes the other's volumes.
//   2. No host port publish. The test container reaches the server as server:3000 on the compose
//      network (DEEPSTEVE_URL) and the healthcheck curls localhost:3000 *inside* the server
//      container, so nothing needs a publish — but `3000:3000` collides with the developer's own
//      deepsteve daemon, which made these suites unrunnable on the machines that develop them.
//
// #588 fixed both for docker-compose.public.yml only; #616 found the other two still broken a
// release later, which is exactly the drift this file exists to catch. It globs the directory
// rather than listing the files, so a fourth compose is covered the moment it lands.
//
// Pure file read, no docker and no shell, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/compose-projects.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.join(__dirname, '..');

// Comments are stripped before every match: these files explain *why* there is no `ports:` key,
// and a prose mention must neither satisfy nor trip an assertion.
const uncommented = (text) =>
  text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const composeFiles = fs.readdirSync(TEST_DIR)
  .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
  .sort()
  .map((f) => ({ file: f, text: uncommented(fs.readFileSync(path.join(TEST_DIR, f), 'utf8')) }));

test('the glob actually finds the compose files (#616)', () => {
  // Without this, a rename or a bad pattern turns every assertion below into a no-op pass.
  const names = composeFiles.map((c) => c.file);
  for (const expected of ['docker-compose.yml', 'docker-compose.install.yml', 'docker-compose.public.yml']) {
    assert.ok(names.includes(expected),
      `expected to find test/${expected}; found [${names.join(', ')}]. If it was renamed, ` +
      'update this list — the assertions below are vacuous when the glob misses.');
  }
});

test('every test compose declares its own project name (#616)', () => {
  for (const { file, text } of composeFiles) {
    assert.match(text, /^name:\s*\S+\s*$/m,
      `test/${file} has no top-level \`name:\`. Compose would derive the project name from the ` +
      'parent directory ("test"), which every sibling compose shares — so an `up` here recreates ' +
      "their containers and a `down -v` deletes their volumes (#588, #616).");
  }
});

test('the project names are distinct (#616)', () => {
  const seen = new Map();
  for (const { file, text } of composeFiles) {
    const name = text.match(/^name:\s*(\S+)\s*$/m)?.[1];
    if (!name) continue;   // reported by the test above
    assert.ok(!seen.has(name),
      `test/${file} and test/${seen.get(name)} both use project name "${name}" — sharing a ` +
      'project is the collision these names exist to prevent (#616).');
    seen.set(name, file);
  }
});

test('no test compose publishes a host port (#616)', () => {
  for (const { file, text } of composeFiles) {
    assert.doesNotMatch(text, /^\s*ports:/m,
      `test/${file} publishes a host port. The test container talks to the server over the ` +
      'compose network (DEEPSTEVE_URL=http://server:3000) and the healthcheck runs inside the ' +
      'server container, so no publish is needed — and 3000:3000 collides with the developer\'s ' +
      'own daemon, which is what #616 removed.');
  }
});
