// Guard: the two panes of the app row get their edges declared together (#690).
//
// The layout is one row, [ #context-rail | #app-main ] — the projects panel and the
// terminal side by side. A theme that frames one and not the other looks broken, and
// two separate ways of getting there both shipped:
//
//   1. A theme frames #app-main but never overrides --ds-context-*, so the rail silently
//      falls back to the base default `1px solid var(--ds-border)` while the terminal has
//      no edge at all. That was retro-monitor-dim, ascii-art and win-95.
//
//   2. A theme writes `box-shadow: inset ...` on #app-main to match the rail's inner ring.
//      That NEVER paints: an inset shadow draws below descendant backgrounds, and every
//      child of #app-main (#tabs, the xterm canvas, #panel-container) is opaque. The
//      declaration reads correct, renders nothing, and only the rail ends up with the
//      highlight. retro-monitor and hacker-monitor both carried such a rule for months.
//      The working form is --ds-main-inset, which drives an overlay in the base stylesheet.
//
// The second one is why this is a test and not a doc line: it is invisible in review — the
// CSS is right there in the file, and it is dead.
//
// Pure file reads — no server boot, no shell, no node-pty — so it runs in the bare `unit`
// CI job.
//
// Run: node --test test/unit/theme-pane-parity.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const THEMES_DIR = path.join(ROOT, 'themes');
const BASE_CSS = path.join(ROOT, 'public', 'css', 'styles.css');

/** Strip /* ... *​/ comments so a rule quoted in prose can't be read as a declaration. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Body of the LAST top-level rule whose selector list matches `selector` exactly
 * (e.g. `#app-main`). Deliberately exact: `#app-container.vertical-layout #app-main`
 * is a different, layout-scoped rule and is not what these checks are about.
 */
function ruleBody(css, selector) {
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].trim();
    if (sel === selector) bodies.push(m[2]);
  }
  return bodies.length ? bodies.join('\n') : null;
}

/** True when `prop` is declared in `body` with a value that actually draws something. */
function declaresHighlight(body, prop) {
  const m = body.match(new RegExp(`${prop}\\s*:([^;]*)`));
  return !!m && m[1].trim() !== 'none' && m[1].trim() !== '';
}

const themeFiles = fs.readdirSync(THEMES_DIR).filter(f => f.endsWith('.css')).sort();

test('themes exist to check', () => {
  assert.ok(themeFiles.length > 0, 'no theme files found in themes/');
});

test('the base stylesheet provides the overlay themes declare against', () => {
  const base = fs.readFileSync(BASE_CSS, 'utf8');
  const bare = stripComments(base);

  assert.match(bare, /--ds-main-inset:\s*none;/,
    '--ds-main-inset must keep a `none` default in :root, or every theme that omits it paints a ring');

  const overlay = ruleBody(bare, '#app-main::after');
  assert.ok(overlay, '#app-main::after is the only thing that makes --ds-main-inset render; it is gone');
  assert.match(overlay, /box-shadow:\s*var\(--ds-main-inset\)/,
    '#app-main::after must draw var(--ds-main-inset)');
  assert.match(overlay, /pointer-events:\s*none/,
    '#app-main::after covers the whole terminal; without pointer-events:none it eats every click');

  const main = ruleBody(bare, '#app-main');
  assert.ok(main, '#app-main base rule is gone');
  assert.match(main, /position:\s*relative/,
    '#app-main must stay positioned, or ::after escapes to the nearest positioned ancestor');
});

for (const file of themeFiles) {
  const raw = fs.readFileSync(path.join(THEMES_DIR, file), 'utf8');
  const css = stripComments(raw);
  const root = ruleBody(css, ':root') || '';
  const appMain = ruleBody(css, '#app-main') || '';
  const appContainer = ruleBody(css, '#app-container') || '';

  test(`${file}: no inset box-shadow on #app-main (it never paints)`, () => {
    const shadow = appMain.match(/box-shadow\s*:([^;]*)/);
    if (!shadow) return;
    assert.ok(!/\binset\b/.test(shadow[1]),
      `${file} puts an inset box-shadow on #app-main. It renders nothing — the opaque ` +
      'children paint over it. Move the value to --ds-main-inset in :root.');
  });

  test(`${file}: declares the rail's edge if it frames either pane`, () => {
    const framesAPane = /(^|[\s;])border\s*:/.test(appMain) || /(^|[\s;])border\s*:/.test(appContainer);
    if (!framesAPane) return;   // colour-only themes stay exempt, as docs/themes.md promises
    assert.match(root, /--ds-context-border\s*:/,
      `${file} sets a border on #app-main or #app-container but never declares ` +
      '--ds-context-border, so the rail keeps the base 1px default nothing else matches.');
  });

  test(`${file}: states both panes' inner highlight together`, () => {
    const hasRail = declaresHighlight(root, '--ds-context-shadow');
    const hasMain = declaresHighlight(root, '--ds-main-inset');
    assert.strictEqual(hasMain, hasRail,
      `${file} gives an inner highlight to ${hasRail ? 'the rail' : 'the terminal'} only. ` +
      '--ds-context-shadow and --ds-main-inset are one decision about one row.');
  });
}
