// Shape guards for mods/timecard (#666) — the mistakes that are silent in a browser.
//
// Five of these fail INVISIBLY rather than loudly, which is why they are pinned here
// rather than left to review:
//
//   * a `var(--ds-*)` with no fallback renders transparent-on-transparent, because mod
//     iframes receive no theme variables at all;
//   * a token used in the CSS but missing from timecard.js's mirror list keeps its dark
//     fallback under a light theme, so the card half-follows the theme;
//   * adding `display: "panel"` docks a 560px card into a 380px strip and nothing errors;
//   * a re-render that fetches would still LOOK right — only the network tab shows the
//     round trip the issue forbids;
//   * employer framing is a one-word regression that no functional test can see.
//
// Pure fs reads plus validate-mods.js — the workshop-mod-shape.test.js shape, no server
// boot and no shell, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/timecard-mod-shape.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MOD_DIR = path.join(ROOT, 'mods', 'timecard');
const { validateManifest } = require('../../validate-mods.js');
const { SAMPLE_INTERVALS, DEFAULT_INTERVAL_MIN } = require('../../timecard-store.js');

const read = (rel) => fs.readFileSync(path.join(MOD_DIR, rel), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const html = read('index.html');
const js = read('timecard.js');
const tools = read('tools.js');

// ------------------------------------------------------------------ the manifest

test('the manifest passes the release-time validator', () => {
  assert.deepStrictEqual(validateManifest('timecard', manifest), []);
});

test('Timecard is an APP, not a panel', () => {
  assert.strictEqual(manifest.app, true, '"app": true buys the Apps rail row and the palette entry');
  assert.strictEqual(manifest.entry, 'index.html');
  assert.ok(
    !('display' in manifest),
    'omitting `display` is what makes a mod fullscreen (mod.display || \'fullscreen\', '
    + 'public/js/mod-manager.js). "panel" would dock a 560px card into a ~380px strip, '
    + 'and "tab" would consume a tab slot — both silently.',
  );
  assert.ok(manifest.toolbar && manifest.toolbar.label, 'the Apps rail row is drawn from this label');
});

test('the manifest declares no tools (#644)', () => {
  assert.ok(
    !('tools' in manifest),
    'tools.js is the only source of truth; a manifest copy is read by nothing and '
    + 'drifts the moment it exists',
  );
});

// ------------------------------------------------------------------ theming

test('every themed color carries a fallback', () => {
  // A mod iframe gets no theme variables, so an unfallbacked var() is transparent.
  const bare = [...html.matchAll(/var\((--ds-[a-z0-9-]+)\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(bare, [], `these var()s have no fallback: ${bare.join(', ')}`);
});

test('the theme mirror covers every token the CSS actually paints with', () => {
  const used = new Set([...html.matchAll(/var\((--ds-[a-z0-9-]+)/g)].map((m) => m[1]));
  const mirrored = new Set([...js.matchAll(/'(--ds-[a-z0-9-]+)'/g)].map((m) => m[1]));
  const missing = [...used].filter((t) => !mirrored.has(t));
  assert.deepStrictEqual(
    missing, [],
    `THEME_TOKENS in timecard.js is missing ${missing.join(', ')} — those stay on the `
    + 'dark fallback under a light theme, so the card half-follows the theme',
  );
});

test('the mirror reads the host document and re-reads it when the theme changes', () => {
  assert.match(js, /parent\.getComputedStyle\(parent\.document\.documentElement\)/);
  assert.match(js, /MutationObserver/, 'app.js swaps <style id="ds-theme"> text in place');
  assert.match(js, /catch/, 'a mirror that throws must fall back, not blank the page');
});

// ------------------------------------------------------------------ the geometry

test('the card keeps the exact type scale, spacing and geometry', () => {
  const pins = [
    ['max-width: 560px', 'the card is 560px wide at most'],
    ['font-size: 34px', 'headline'],
    ['font-weight: 500', 'headline weight'],
    ['letter-spacing: -0.02em', 'headline tracking'],
    ['font-size: 15px', 'the "hours" unit'],
    ['font-size: 13px', 'range label and view switcher'],
    ['font-size: 12px', 'axis labels and stat labels'],
    ['font-size: 16px', 'stat values'],
    ['height: 120px', 'chart height'],
    ['gap: 10px', 'bar and axis gaps must match'],
    ['gap: 14px', 'view switcher'],
    ['gap: 32px', 'stat row'],
    ['border-radius: 3px 3px 0 0', 'top corners only'],
    ['align-items: baseline', 'switcher shares the headline baseline'],
  ];
  for (const [needle, why] of pins) {
    assert.ok(html.includes(needle), `${why}: expected "${needle}" in index.html`);
  }
});

test('a zero renders as a 2px hairline in the border color, not a gap', () => {
  assert.match(
    html,
    /\.tc-bar\.zero\s*\{[^}]*height:\s*2px[^}]*background:\s*var\(--ds-border/,
    'the zero rule must set BOTH a 2px height and the border color',
  );
});

test('the card is flat and unwrapped — no border, background or shadow around it', () => {
  const card = html.match(/\.tc-card\s*\{[^}]*\}/)[0];
  for (const banned of ['border', 'background', 'box-shadow', 'gradient']) {
    assert.ok(!card.includes(banned), `.tc-card must not set ${banned} — whitespace is the container`);
  }
});

// ------------------------------------------------------------------ the behavior

test('Week is the default view', () => {
  assert.match(js, /let view = 'week'/);
});

test('switching views re-renders from memory and never fetches', () => {
  // The click handler is the whole no-round-trip claim. If it ever calls refresh() or
  // fetch() the behavior still LOOKS right, so pin the source.
  const handler = js.match(/el\.views\.addEventListener\('click',[\s\S]*?\n\}\);/)[0]
    .replace(/\/\/.*$/gm, ''); // the comment says "no fetch"; search the code, not the prose
  assert.match(handler, /render\(\)/, 'a view switch re-renders');
  assert.ok(!/fetch|refresh|load/.test(handler), 'and must not go to the network');
});

test('the stat row re-renders its labels as well as its values', () => {
  assert.match(js, /stat\.label/, 'labels come from the dataset, not from a fixed list');
  assert.match(js, /formatStat\(stat\)/);
  assert.match(js, /kind === 'count'/, 'counts are integers, hours are toFixed(1)');
  assert.match(js, /toFixed\(1\)/);
});

test('the bar readout hovers over the chart instead of using the native tooltip', () => {
  // `title` puts the browser's own tooltip below-right of the cursor after a delay —
  // neither over the bar nor immediate — and it is invisible to every functional test.
  assert.ok(!/\.title\s*=/.test(js), 'no bar may set a `title` attribute');
  assert.match(js, /dataset\.tip/, 'the readout text rides on the bar it describes');
  assert.match(html, /\.tc-chart\s*\{[^}]*position:\s*relative/,
    'the readout is positioned against the chart box');
  assert.match(html, /\.tc-tip\s*\{[^}]*pointer-events:\s*none/,
    'a readout that takes the pointer flickers against the bar underneath it');
  assert.match(html, /\.tc-bar::before\s*\{/,
    'a 2px zero bar is unhoverable without a full-column hit area');
  assert.match(js, /el\.chart\.replaceChildren\(el\.tip\)/,
    'the readout is a child of the chart, so it must survive the wipe that replaces the bars');
});

test('the read route is checked before parsing — mod routes 404 briefly at boot', () => {
  assert.match(js, /if \(!res\.ok\)/,
    'client-log.js beacons every >=400 into the daemon log; parse only what came back OK');
});

// ------------------------------------------------------------------ the server side

test('the sampler timer is unref\'d and every tick is caught', () => {
  assert.match(tools, /setInterval\([\s\S]{0,240}?\)\.unref\(\)/,
    'an un-unref\'d timer keeps the process alive and hangs any unit test that requires this');
  assert.match(tools, /try \{ tick\(\); \} catch/,
    'a throw from a bare timer callback takes the daemon down and every session with it');
});

test('the store path goes through paths.js, never an inline .deepsteve', () => {
  assert.match(tools, /require\('\.\.\/\.\.\/paths'\)/);
  assert.ok(!/homedir\(\)/.test(tools), 'test/unit/paths.test.js guards this for every mods/*/tools.js');
});

test('sampling reads its settings live, so a toggle needs no restart', () => {
  assert.match(tools, /ctx && ctx\.settings/);
  assert.match(tools, /timecardEnabled/);
  assert.match(tools, /timecardSampleMinutes/);
});

test('scheduled runs are excluded — the daemon working is not the user working', () => {
  assert.match(tools, /isScheduledRun/);
});

test('the interval setting offers exactly 1 / 5 / 15 minutes, defaulting to 5', () => {
  assert.deepStrictEqual(SAMPLE_INTERVALS, [1, 5, 15]);
  assert.strictEqual(DEFAULT_INTERVAL_MIN, 5);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const entry = server.match(/\{ name: 'timecardSampleMinutes',[\s\S]*?\n {4}\} \},/);
  assert.ok(entry, 'timecardSampleMinutes must be declared in SETTINGS_SCHEMA');
  assert.match(entry[0], /default: 5/);
  assert.match(entry[0], /\[1, 5, 15\]\.includes\(n\)/);
  assert.match(entry[0], /type: 'custom'/,
    "enum would String()ify it and store \"5\"; custom keeps it a number and rejects the rest");

  assert.match(server, /\{ name: 'timecardEnabled', +type: 'boolean', default: true \},/);
});

// ------------------------------------------------------------------ the framing

test('no employer framing anywhere in the UI copy', () => {
  const banned = /overtime|attainment|compliance|clock.?in|quota|productivity|shortfall|\bgoal\b|\bon track\b/i;
  for (const [name, src] of [['index.html', html], ['timecard.js', js]]) {
    const hit = src.match(banned);
    assert.strictEqual(hit, null, `${name} contains employer framing: "${hit && hit[0]}"`);
  }
  // The settings copy is user-facing too.
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const section = app.match(/<h3>Timecard<\/h3>[\s\S]*?<\/div>/);
  assert.ok(section, 'the settings modal has a Timecard section');
  assert.strictEqual(section[0].match(banned), null, 'and it stays observational too');
});

test('the card never draws a target line or a second series', () => {
  // Bars are plain ink: one color, no accent, no per-bar variation (#666).
  assert.ok(!/accent/i.test(html), 'no accent color on the chart');
  assert.match(html, /\.tc-bar\s*\{[\s\S]*?background:\s*var\(--ds-text-primary/,
    'bars are text-primary ink');
});
