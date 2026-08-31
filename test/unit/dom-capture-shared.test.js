// One DOM→PNG capture path in the tree, not two (#667).
//
// `captureElementToPng` used to live inside mods/screenshots/screenshots.jsx, reachable
// only from that mod's iframe. Timelapse needs the same rasterizer from the top document,
// and the cheap thing to do would have been to paste it — which is exactly how the iframe
// guard in contentIframeOf() (hard-won: a 0×0 hidden iframe serializes to an invalid
// `data:,`) ends up fixed in one copy and broken in the other.
//
// This is a source-shape guard, in the spirit of mod-tools-source.test.js. It cannot run
// the browser code, so it asserts the thing that would silently regress: that every
// consumer imports the shared module and none of them reach for the library directly.
//
// Run: node --test test/unit/dom-capture-shared.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHARED = path.join(ROOT, 'public', 'js', 'dom-capture.js');

/** Every file that rasterizes DOM, and the specifier it must import the helper by. */
const CONSUMERS = [
  { file: 'mods/screenshots/screenshots.jsx', specifier: '/js/dom-capture.js' },
  { file: 'public/js/timelapse.js', specifier: './dom-capture.js' },
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the shared capture module exists and exports the whole surface', () => {
  assert.ok(fs.existsSync(SHARED), 'public/js/dom-capture.js is missing');
  const src = fs.readFileSync(SHARED, 'utf8');
  for (const name of ['captureElementToPng', 'contentIframeOf', 'ensureModernScreenshot']) {
    assert.match(src, new RegExp(`export (async )?function ${name}\\b`), `missing export: ${name}`);
  }
});

test('every consumer imports the shared helper rather than redefining it', () => {
  for (const { file, specifier } of CONSUMERS) {
    const src = read(file);
    assert.ok(
      src.includes(`from '${specifier}'`),
      `${file} must import captureElementToPng from '${specifier}'`
    );
    // A local redefinition is the regression this guard exists for.
    assert.doesNotMatch(
      src, /^\s*(async\s+)?function captureElementToPng\b/m,
      `${file} redefines captureElementToPng — use the shared module`
    );
    assert.doesNotMatch(
      src, /^\s*function contentIframeOf\b/m,
      `${file} redefines contentIframeOf — use the shared module`
    );
  }
});

test('only the shared module touches window.modernScreenshot', () => {
  // Reaching for the global directly is how a second capture path starts: it works, so
  // nothing complains, and the iframe/scale handling quietly diverges.
  for (const { file } of CONSUMERS) {
    assert.doesNotMatch(
      read(file), /modernScreenshot/,
      `${file} reaches for the modern-screenshot global — go through dom-capture.js`
    );
  }
});

test('the mod imports by ABSOLUTE path, because babel-standalone uses a blob URL', () => {
  // screenshots.jsx is compiled by @babel/standalone and injected as a module under a
  // blob: URL. A relative specifier would resolve against that blob and 404; an absolute
  // one resolves against the origin. This has no visible symptom until the panel is
  // opened, so it is asserted rather than remembered.
  const src = read('mods/screenshots/screenshots.jsx');
  const m = /from\s+'([^']*dom-capture\.js)'/.exec(src);
  assert.ok(m, 'screenshots.jsx does not import dom-capture.js');
  assert.ok(m[1].startsWith('/'), `must be absolute, got '${m[1]}'`);
});

test('the CDN pin carries an SRI hash, like every other CDN tag we ship', () => {
  const src = fs.readFileSync(SHARED, 'utf8');
  const pin = /MODERN_SCREENSHOT_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(src);
  assert.ok(pin, 'dom-capture.js must pin an exact modern-screenshot version');
  assert.match(src, /sha384-[A-Za-z0-9+/=]{40,}/, 'the injected script must carry integrity');

  // The version dom-capture.js injects and the version the mod's own <script> tag loads
  // have to agree, or the two documents end up with two different rasterizers — the same
  // divergence this whole suite exists to prevent, just one level down.
  const modHtml = read('mods/screenshots/index.html');
  const modPin = /modern-screenshot@(\d+\.\d+\.\d+)/.exec(modHtml);
  if (modPin) {
    assert.strictEqual(modPin[1], pin[1], 'the mod and dom-capture.js pin different versions');
  }
});
