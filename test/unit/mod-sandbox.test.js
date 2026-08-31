// Guard for MOD_SANDBOX — the sandbox attribute every mod iframe gets (#671).
//
// This is its own file rather than a case in workshop-mod-shape.test.js because the
// string is the HOST's, shared by the panel path and the fullscreen path and by every
// mod that will ever want to link out. Workshop is only the first caller.
//
// Every failure mode here is SILENT. A sandbox flag does not throw when it is missing;
// the affordance it gates simply stops working, with no console line in most browsers.
// A link that does nothing reads as a broken feature, and a popup that opens and then
// cannot navigate reads as a broken GitHub — neither points at this constant, which is
// why the reasons are in the assertion messages.
//
// A pure fs read plus a regex, the claude-md-budget.test.js shape, so it runs in the
// bare `unit` CI job with no daemon and no browser.
//
// Run: node --test test/unit/mod-sandbox.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'public', 'js', 'mod-manager.js');
const source = fs.readFileSync(SOURCE, 'utf8');

function sandboxFlags() {
  const m = /const MOD_SANDBOX = '([^']+)'/.exec(source);
  assert.ok(
    m,
    'MOD_SANDBOX is no longer a single-quoted literal in public/js/mod-manager.js. It is '
    + 'declared in exactly one place so the panel path and the fullscreen path cannot '
    + 'drift; if that changed, this guard needs to follow it rather than be deleted.',
  );
  return new Set(m[1].split(/\s+/).filter(Boolean));
}

test('the sandbox is still declared once, and applied from that one constant', () => {
  const uses = source.match(/setAttribute\('sandbox',/g) || [];
  assert.ok(uses.length >= 2, 'expected both the panel and the fullscreen path to set it');
  for (const line of source.split('\n')) {
    if (!line.includes("setAttribute('sandbox'")) continue;
    assert.match(
      line, /MOD_SANDBOX/,
      'a sandbox attribute set from a literal instead of MOD_SANDBOX:\n' + line.trim()
      + '\n\nThe two iframe paths drifting apart is exactly what the single constant prevents.',
    );
  }
});

test('allow-scripts and allow-same-origin are still there', () => {
  // Not new, but load-bearing enough that removing either should fail loudly here rather
  // than as "the mod page is blank" or "window.deepsteve is undefined".
  const flags = sandboxFlags();
  assert.ok(flags.has('allow-scripts'), 'a mod page cannot run at all without this');
  assert.ok(
    flags.has('allow-same-origin'),
    'the window.deepsteve bridge is injected across the iframe boundary and requires it. '
    + 'Mod iframes are same-origin and trusted BY DESIGN — this attribute is not what '
    + 'isolates them, and nothing should be written as though it were (docs/mods.md).',
  );
});

test('allow-pointer-lock is still there, or every 3D mod loses its camera', () => {
  assert.ok(
    sandboxFlags().has('allow-pointer-lock'),
    'without it requestPointerLock() throws SecurityError, document.pointerLockElement '
    + 'stays null, and every mousemove handler gated on it receives nothing — the camera '
    + 'simply never turns, with no visible error. village, space-station and monkey-code '
    + 'all depend on it.',
  );
});

test('a mod can open an external link — BOTH popup flags, or the feature is worse than absent', () => {
  const flags = sandboxFlags();

  assert.ok(
    flags.has('allow-popups'),
    'MOD_SANDBOX dropped allow-popups. Without it a mod iframe cannot open an external '
    + 'URL at all: <a target="_blank"> and window.open() are both refused, and refused '
    + 'SILENTLY — no exception, no console line, the click just does nothing. Workshop\'s '
    + 'backlog rows (#671) link to GitHub through a real anchor and need it.',
  );

  assert.ok(
    flags.has('allow-popups-to-escape-sandbox'),
    'MOD_SANDBOX dropped allow-popups-to-escape-sandbox. This is not a second '
    + 'nice-to-have: a popup INHERITS its opener\'s sandbox flags, so with allow-popups '
    + 'alone the linked page loads in a sandboxed top-level context with no '
    + 'allow-top-navigation and no allow-forms. It appears, and then every link on it '
    + 'silently does nothing — which reads as "that site is broken", not as "our iframe '
    + 'is misconfigured". Escaping grants a mod nothing extra either: the popup is a '
    + 'different origin in its own top-level browsing context.',
  );
});
