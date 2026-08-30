// Shape guards for mods/workshop (#660) — the mistakes that are silent in a browser.
//
// Four of these fail INVISIBLY rather than loudly, which is why they are pinned here
// rather than left to review:
//
//   * adding `display: "panel"` puts a two-pane inbox in a 360px dock and nothing errors;
//   * a `var(--ds-*)` with no fallback renders transparent-on-transparent, because mod
//     iframes receive no theme variables at all;
//   * a renamed settings key silently reads `undefined` forever;
//   * a stale `src=` or relative `import` is a blank white iframe with one console line.
//
// Pure fs reads plus validate-mods.js, the claude-md-budget.test.js / agents-doc.test.js
// shape — no server boot, no shell — so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/workshop-mod-shape.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MOD_DIR = path.join(ROOT, 'mods', 'workshop');
const { validateManifest } = require('../../validate-mods.js');

const read = (rel) => fs.readFileSync(path.join(MOD_DIR, rel), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const html = read('index.html');
const jsx = read('workshop.jsx');

// Settings the panel keeps but deliberately does NOT render a control for. mod.json's
// `settings` array is what the gear icon draws; updateSetting happily stores keys that
// are not in it (mods/tasks/tasks.jsx already stores its filters this way), and a
// fullscreen iframe is DESTROYED on hide, so the host's localStorage is the only place
// a view toggle can survive.
const UNRENDERED_SETTINGS = new Set(['blockingOnly', 'seenAutoCycleNote']);

test('the manifest passes the release-time validator', () => {
  assert.deepStrictEqual(validateManifest('workshop', manifest), []);
});

test('Workshop is FULLSCREEN — no display key', () => {
  assert.ok(
    !('display' in manifest),
    'omitting `display` is what makes a mod fullscreen (mod.display || \'fullscreen\', '
    + 'public/js/mod-manager.js). Adding "panel" would dock a two-pane inbox into a '
    + '360px strip, and "tab" would consume a tab slot — both silently.',
  );
  assert.strictEqual(manifest.entry, 'index.html');
  assert.ok(manifest.toolbar && manifest.toolbar.label, 'a fullscreen mod needs a toolbar label to be reachable');
});

test('the manifest declares no tools (#644)', () => {
  assert.ok(
    !('tools' in manifest),
    'tools.js is the only source of truth; a manifest copy is read by nothing and '
    + 'drifts the moment it exists',
  );
});

test('every setting is a type the settings modal can actually render', () => {
  for (const s of manifest.settings || []) {
    assert.ok(
      s.type === 'boolean' || s.type === 'number',
      `setting "${s.key}" is type "${s.type}" — the mod settings modal renders only `
      + 'boolean (checkbox) and number (integer input). Anything else is an invisible control.',
    );
    assert.ok(s.label, `setting "${s.key}" needs a label`);
    assert.notStrictEqual(s.default, undefined, `setting "${s.key}" needs a default`);
  }
});

test('the panel and the manifest agree on every settings key', () => {
  const block = /const DEFAULTS = \{([\s\S]*?)\n\};/.exec(jsx);
  assert.ok(block, 'workshop.jsx no longer has a DEFAULTS block to compare against');
  const used = new Set([...block[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  assert.ok(used.size >= 4, `expected the panel's defaults; found ${used.size}`);

  const declared = new Set((manifest.settings || []).map((s) => s.key));
  for (const key of declared) {
    assert.ok(
      used.has(key),
      `mod.json declares "${key}" but the panel never reads it — a dead control in the `
      + 'gear menu that appears to do nothing',
    );
  }
  for (const key of used) {
    assert.ok(
      declared.has(key) || UNRENDERED_SETTINGS.has(key),
      `the panel reads setting "${key}" but mod.json does not declare it. Either add it `
      + 'to the manifest, or add it to UNRENDERED_SETTINGS here with the reason — a '
      + 'renamed key otherwise reads undefined forever and nothing errors.',
    );
  }
  for (const key of UNRENDERED_SETTINGS) {
    assert.ok(used.has(key), `UNRENDERED_SETTINGS lists "${key}", which the panel no longer uses`);
  }
});

test('every file the page references actually exists', () => {
  // The cheap guard for the relative-import risk. It cannot prove the browser resolves
  // the specifier, but it does prove the file is there and the name is not stale —
  // which is the failure mode that shows up as a blank iframe.
  const refs = [
    ...[...html.matchAll(/\bsrc="(?!https?:)([^"]+)"/g)].map((m) => m[1]),
    ...[...jsx.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]),
  ];
  assert.ok(refs.length >= 2, `expected the page's own references; found ${refs.length}`);
  for (const ref of refs) {
    assert.ok(
      fs.existsSync(path.join(MOD_DIR, ref)),
      `mods/workshop references "${ref}", which does not exist. In the browser this is a `
      + 'blank iframe and one console line, not an error anyone notices.',
    );
  }
});

test('every theme variable carries a fallback', () => {
  for (const source of [{ name: 'index.html', text: html }, { name: 'workshop.jsx', text: jsx }]) {
    const bare = [...source.text.matchAll(/var\(\s*(--ds-[a-z0-9-]+)\s*\)/gi)].map((m) => m[1]);
    assert.deepStrictEqual(
      bare, [],
      `${source.name} uses ${bare.join(', ')} with no fallback. Mod iframes receive NO `
      + 'theme variables from the host, so an unfallbacked var() renders as '
      + 'transparent-on-transparent — which reads as a broken build, not a missing colour.',
    );
  }
});

test('the inbox is sourced from the server, not from this window\'s tabs', () => {
  // Acceptance criterion: Workshop must see sessions that have no tab in THIS browser
  // window, including unattended scheduled runs. Bound to a source shape the way
  // integration-scratch-guard.test.js binds os.tmpdir().
  assert.match(jsx, /\/api\/workshop\/inbox/, 'the panel must read the server-side inbox');

  const lines = jsx.split('\n');
  const bridgeUses = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /getSessions|onSessionsChanged/.test(line) && !line.trim().startsWith('//'));
  assert.ok(bridgeUses.length >= 1, 'expected at least one bridge session call to be marked');

  for (const { line, i } of bridgeUses) {
    const nearby = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    assert.match(
      nearby, /\/\/ window-scoped:/,
      `workshop.jsx:${i + 1} uses the mod bridge's session list without the '// window-scoped:' `
      + 'note:\n' + line.trim() + '\n\n'
      + 'getSessions()/onSessionsChanged report THIS window\'s own tabs, not the server\'s '
      + 'live session set. Using them for the INBOX would silently hide every session with '
      + 'no tab here, which is the exact case Workshop exists to surface. The only correct '
      + 'use is deciding whether `o` can reach a session from this window.',
    );
  }
});

test('the panel never writes to a PTY itself', () => {
  // Every PTY write lives behind POST /api/workshop/items/:id/answer, server-side. That
  // is what keeps the "a human clicked this" claim in tools.js's header true, and it is
  // the premise for not going through the meta-controls consent gate.
  for (const forbidden of ['meta_type', 'engine.write', 'submitToShell']) {
    assert.ok(
      !jsx.includes(forbidden),
      `workshop.jsx references ${forbidden}. Answering must stay behind the REST route, `
      + 'which is where the verify-before-commit dance and the audit line live.',
    );
  }
});
