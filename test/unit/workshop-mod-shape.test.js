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
//
// `issueLabel` (#671) is here for a harder reason than taste: it is a STRING, and the
// settings modal renders only checkboxes and number inputs — see the type test below.
// Declaring it in mod.json would draw nothing at all, so the picker lives in the
// Backlog header, next to the list it filters. `backlogCollapsed` is a disclosure
// state, the same shape as `blockingOnly`.
//
// `chatOpen` / `chatWidth` (#670) are furniture, not preferences — set by dragging and by
// pressing `c`, and a number box in the gear menu for either would be a control nobody
// would ever reach for.
const UNRENDERED_SETTINGS = new Set([
  'blockingOnly', 'seenAutoCycleNote', 'issueLabel', 'backlogCollapsed',
  'chatOpen', 'chatWidth',
]);

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
  // Still required, but no longer for a toolbar button — "app": true suppresses that (#662).
  // `mod.toolbar?.label || mod.name` is now the label for the Apps rail row, the rail's
  // auto-width measurement and the "← Workshop" button, so a missing one is a nameless row.
  assert.ok(manifest.toolbar && manifest.toolbar.label, 'the Apps rail row is drawn from this label');
});

test('Workshop is an APP, and binds ⌘\\ through the bridge rather than owning quiet mode (#662)', () => {
  assert.strictEqual(manifest.app, true, '"app": true is what buys the rail row and the palette entry');

  // Quiet mode is the HOST's: an iframe cannot hide the tab strip that contains it, and a
  // toggle built in here would be stuck on hardcoded fallback colours besides. Workshop's
  // only share is the key, because the host's listener is on the top document and never sees
  // a keystroke made in here.
  assert.match(jsx, /window\.deepsteve\?\.toggleQuiet\?\.\(\)/,
    'the ⌘\\ branch must call through the bridge');
  for (const f of ['quiet-mode', 'app-quiet-btn']) {
    assert.ok(!jsx.includes(f), `workshop.jsx references ${f} — quiet mode's chrome is the host's`);
  }
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

test('the backlog is sourced from the server too (#671)', () => {
  // Same argument as the inbox above, plus one of its own: matching an issue to a tab
  // needs `entry.worktree`, and the bridge's session list does not carry it
  // (public/js/app.js hands mods {id, name, cwd, waitingForInput, type}). A panel-side
  // match could therefore only guess from the tab NAME — which agents rename — so the
  // authoritative half of the rule is only reachable server-side.
  assert.match(jsx, /\/api\/workshop\/backlog/, 'the panel must read the server-side backlog');
  assert.match(jsx, /\/api\/workshop\/labels/, 'the label picker must read the server-side label list');
});

test('the pop-out is a real link, not a scripted open (#671)', () => {
  // The sandbox half of this feature lives in test/unit/mod-sandbox.test.js, because it
  // is the host's iframe rather than this mod's page.
  assert.match(
    jsx, /target="_blank"\s+rel="noopener noreferrer"/,
    'the GitHub pop-out must be a real anchor — a scripted window.open loses ⌘-click, '
    + 'middle-click and "copy link address", which is most of what a link is for',
  );
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

test('the panel never turns agent text into markup (#670)', () => {
  // The chat pane renders markdown an AGENT wrote, and an agent's prose routinely carries
  // strings it read somewhere else — a README, an issue body, a dependency's error text.
  // markdown.js returns an AST and workshop.jsx maps it to ELEMENTS, so there is no point
  // at which that text could become HTML. That is a categorical property, and it survives
  // only as long as neither of these appears here.
  for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML']) {
    assert.ok(
      !jsx.includes(forbidden),
      `workshop.jsx references ${forbidden}. Mod iframes are allow-same-origin (they must `
      + 'be, for the window.deepsteve bridge), so the sandbox provides no XSS containment '
      + 'at all — the React element tree IS the containment. Render the AST from '
      + 'markdown.js instead; if a construct renders wrong, render it as literal text.',
    );
  }
});

test('the chat pane sends through the FIFO route, never a bare prompt write', () => {
  const tools = fs.readFileSync(path.join(MOD_DIR, 'tools.js'), 'utf8');
  assert.match(tools, /ctx\.deliverPromptWhenReady\(sessionId, chatPrompt\(/,
    'the chat POST must queue through deliverPromptWhenReady — the per-shell FIFO is what '
    + 'sequences a question behind whatever the agent is already doing');
  assert.ok(
    !/e\.pendingDelivery\s*=/.test(tools),
    'never arm pendingDelivery directly; deliverPromptWhenReady owns that (docs/sessions.md)',
  );
});
