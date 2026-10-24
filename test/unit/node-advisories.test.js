// The boot-time check for a known-vulnerable Node.js runtime (node-advisories.js). Pins how a
// version is read against the table: patched lines, lines older than the patch, end-of-life
// lines that will never be fixed, and lines newer than the advisory — plus the guard that
// server.js still calls it at startup.
//
// Run: node --test test/unit/node-advisories.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { NODE_ADVISORIES, parseNodeVersion, affectingAdvisories, nodeVersionWarnings } = require('../../node-advisories');

const ROOT = path.join(__dirname, '..', '..');
const CVE = 'CVE-2026-111497';

function cveHit(version) {
  return affectingAdvisories(version).find(h => h.id === CVE);
}

test('parseNodeVersion reads process.versions.node and process.version shapes', () => {
  assert.deepStrictEqual(parseNodeVersion('22.23.4'), [22, 23, 4]);
  assert.deepStrictEqual(parseNodeVersion('v20.20.2'), [20, 20, 2]);
  assert.deepStrictEqual(parseNodeVersion('27.0.0-pre'), [27, 0, 0]);
  for (const bad of ['', 'banana', '22', '22.23', null, undefined, 22, {}]) {
    assert.strictEqual(parseNodeVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('a release before its line\'s patch is told the patch', () => {
  for (const [version, fix] of [['22.14.0', '22.23.4'], ['22.23.3', '22.23.4'],
                                ['24.0.0', '24.22.1'], ['24.22.0', '24.22.1'],
                                ['26.12.0', '26.12.1']]) {
    const hit = cveHit(version);
    assert.ok(hit, `${version} should be affected`);
    assert.strictEqual(hit.fixedIn, fix);
    assert.deepStrictEqual(hit.upgradeTo, [fix]);
  }
});

test('the patched release and anything after it on that line is clean', () => {
  for (const version of ['22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) {
    assert.strictEqual(cveHit(version), undefined, `${version} should not be affected`);
  }
});

test('an end-of-life line is told it will never be fixed, and offered only newer lines', () => {
  const cases = [
    ['18.20.8', ['22.23.4', '24.22.1', '26.12.1']],
    ['20.20.2', ['22.23.4', '24.22.1', '26.12.1']],
    ['23.11.1', ['24.22.1', '26.12.1']],
    ['25.9.0', ['26.12.1']],
  ];
  for (const [version, upgradeTo] of cases) {
    const hit = cveHit(version);
    assert.ok(hit, `${version} should be affected`);
    assert.strictEqual(hit.fixedIn, null, `${version}'s line has no fix`);
    assert.deepStrictEqual(hit.upgradeTo, upgradeTo);
  }
});

test('a line newer than every patched one is not affected', () => {
  for (const version of ['27.0.0', '27.0.0-pre', '28.1.0']) {
    assert.strictEqual(cveHit(version), undefined, `${version} should not be affected`);
  }
});

test('the warning names the CVE, the running version and what to upgrade to', () => {
  const [patchable] = nodeVersionWarnings('22.23.3');
  assert.match(patchable, /CVE-2026-111497/);
  assert.match(patchable, /Node\.js 22\.23\.3 is affected/);
  assert.match(patchable, /Upgrade to Node\.js 22\.23\.4 or later/);
  assert.doesNotMatch(patchable, /never/);

  const [eol] = nodeVersionWarnings('20.20.2');
  assert.match(eol, /CVE-2026-111497/);
  assert.match(eol, /Node\.js 20\.20\.2 is affected/);
  assert.match(eol, /Node\.js 20\.x is end-of-life and will never get a fix/);
  assert.match(eol, /22\.23\.4\+, 24\.22\.1\+, 26\.12\.1\+/);

  for (const line of [patchable, eol]) {
    assert.ok(line.includes('https://nodejs.org/en/blog/vulnerability/'), 'should link the advisory');
  }
});

test('an unreadable or clean version yields no warning and never throws', () => {
  for (const version of ['', 'banana', null, undefined, '22.23.4', '26.12.1']) {
    assert.deepStrictEqual(nodeVersionWarnings(version), [], `expected no warning for ${JSON.stringify(version)}`);
  }
});

test('every advisory entry is well-formed', () => {
  for (const adv of NODE_ADVISORIES) {
    assert.match(adv.id, /^CVE-\d{4}-\d{4,}$/);
    assert.ok(adv.title, `${adv.id} needs a title`);
    assert.ok(adv.url.startsWith('https://nodejs.org/'), `${adv.id} should cite nodejs.org`);
    const lines = Object.keys(adv.fixed);
    assert.ok(lines.length > 0, `${adv.id} lists no patched line`);
    for (const line of lines) {
      const fix = parseNodeVersion(adv.fixed[line]);
      assert.ok(fix, `${adv.id}: ${adv.fixed[line]} is not a version`);
      assert.strictEqual(String(fix[0]), line, `${adv.id}: ${adv.fixed[line]} is filed under line ${line}`);
    }
  }
});

test('server.js runs the check at boot against the live runtime', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/node-advisories'\)/);
  assert.match(src, /nodeVersionWarnings\(process\.versions\.node\)/,
    'the boot check must read the version of the node actually running the daemon');
});
