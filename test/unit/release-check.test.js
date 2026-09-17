// The release document is network input, and three sinks downstream treat it as trusted:
// applyCurlReinstall() spawns bash on a URL derived from it, broadcastVersionStatus() ships it
// to every browser, and the settings modal plus the auto-apply toast render it. This file
// pins the boundary in release-check.js, and — in the shape mod-kind.test.js established —
// guards that server.js and app.js still route through it.
//
// Run: node --test test/unit/release-check.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { isValidReleaseTag, installShUrl, safeReleaseUrl } = require('../../release-check');

const ROOT = path.join(__dirname, '..', '..');
const DOWNLOAD_PREFIX = 'https://github.com/deepsteve/deepsteve/releases/download/';

// Every shape this repo has actually cut, plus the abbreviations semver allows.
const GOOD_TAGS = ['v0.26.0', '0.26.0', 'v1.2', 'v2', 'v1.2.3-beta.1', 'v10.0.0-rc.2'];

// Each of these is a tag that would otherwise reach a URL path or an innerHTML template.
// They are inert strings — the point is that none of them get that far.
const BAD_TAGS = [
  '',
  'v',
  'latest',
  'v1.0.0 <b>hi</b>',          // markup characters
  'v1.0.0"',                    // attribute break
  'v1.0.0/../../../etc/passwd', // path traversal in the download URL
  'v1.0.0/install.sh',          // any slash at all
  'v1.0.0?ref=x',
  'v1.0.0#frag',
  'v1.0.0 ',
  'v1.0.0\nv2.0.0',
  'v' + '9'.repeat(80),         // over MAX_TAG_LENGTH
];

test('isValidReleaseTag accepts the tags we publish', () => {
  for (const tag of GOOD_TAGS) {
    assert.strictEqual(isValidReleaseTag(tag), true, `expected ${JSON.stringify(tag)} to be valid`);
  }
});

test('isValidReleaseTag rejects anything else', () => {
  for (const tag of BAD_TAGS) {
    assert.strictEqual(isValidReleaseTag(tag), false, `expected ${JSON.stringify(tag)} to be rejected`);
  }
  for (const notAString of [null, undefined, 42, {}, [], { toString: () => 'v1.0.0' }]) {
    assert.strictEqual(isValidReleaseTag(notAString), false);
  }
});

test('installShUrl always names our own release asset', () => {
  for (const tag of GOOD_TAGS) {
    const url = installShUrl(tag);
    assert.ok(url.startsWith(DOWNLOAD_PREFIX), `${url} escaped the pinned prefix`);
    assert.ok(url.endsWith('/install.sh'), `${url} is not an install.sh`);
    assert.strictEqual(new URL(url).host, 'github.com');
  }
  assert.strictEqual(installShUrl('v0.26.0'), `${DOWNLOAD_PREFIX}v0.26.0/install.sh`);
});

test('installShUrl refuses a tag it does not recognise', () => {
  for (const tag of [...BAD_TAGS, null, undefined, 42]) {
    assert.strictEqual(installShUrl(tag), null, `expected null for ${JSON.stringify(tag)}`);
  }
});

test('safeReleaseUrl keeps the GitHub release page', () => {
  const page = 'https://github.com/deepsteve/deepsteve/releases/tag/v0.26.0';
  assert.strictEqual(safeReleaseUrl(page), page);
});

test('safeReleaseUrl refuses a non-https scheme, including one that would execute', () => {
  for (const url of ['javascript:1', 'JavaScript:1', 'data:text/html,x', 'file:///etc/passwd',
                     'http://github.com/deepsteve/deepsteve']) {
    assert.strictEqual(safeReleaseUrl(url), null, `expected null for ${url}`);
  }
});

test('safeReleaseUrl refuses a host that merely looks like GitHub', () => {
  for (const url of ['https://github.com.example.test/x',
                     'https://github.com@example.test/x',
                     'https://notgithub.com/x',
                     'https://github.com:8443/x',
                     'not a url',
                     '']) {
    assert.strictEqual(safeReleaseUrl(url), null, `expected null for ${JSON.stringify(url)}`);
  }
  for (const notAString of [null, undefined, 42, {}]) {
    assert.strictEqual(safeReleaseUrl(notAString), null);
  }
});

// --- Source guards: the boundary is only worth anything if the callers use it ---

test('server.js validates the tag before anything reads it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /isValidReleaseTag\(tag\)/,
    'checkForUpdates() must reject a tag it does not recognise');
  assert.match(src, /versionStatus\.installSh = installShUrl\(tag\)/,
    'the download URL must be derived from the validated tag');
  assert.match(src, /versionStatus\.releaseUrl = safeReleaseUrl\(/,
    'the release link must be scheme- and host-checked server-side');
});

test('server.js never takes a download URL off the release document', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /browser_download_url/,
    'a field that can name any origin must not choose what applyCurlReinstall() runs');
  assert.doesNotMatch(src, /releases\/download\/\$\{/,
    'build the asset URL in release-check.js, not by interpolating here');
});

test('app.js escapes the tag it renders in the auto-apply toast', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /Updating to \$\{escapeHtml\(tag \|\| 'latest'\)\}/,
    'the toast interpolates a server-supplied tag straight into innerHTML');
  assert.match(src, /href="\$\{escapeHtml\(releaseHref\)\}"/,
    'the release link must render the scheme-checked href, not the raw field');
});
