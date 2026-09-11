// Guard for PROJECT_MOD_SANDBOX — the sandbox a project mod's page gets as a tab and as a
// view. The project-mod counterpart of mod-sandbox.test.js, and for the same reason: a
// missing sandbox flag fails SILENTLY, so the reasons live in the assertion messages.
//
// A pure fs read plus a regex, so it runs in the bare `unit` CI job with no daemon and no
// browser.
//
// Run: node --test test/unit/project-mod-sandbox.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');
const source = fs.readFileSync(SOURCE, 'utf8');

function sandboxFlags() {
  const m = /const PROJECT_MOD_SANDBOX = '([^']+)'/.exec(source);
  assert.ok(
    m,
    'PROJECT_MOD_SANDBOX is no longer a single-quoted literal in public/js/app.js. It is '
    + 'declared in one place so the tab path and the view path cannot drift; if that '
    + 'changed, this guard needs to follow it rather than be deleted.',
  );
  return new Set(m[1].split(/\s+/).filter(Boolean));
}

function body(fnName) {
  const start = source.indexOf(`function ${fnName}(`);
  assert.ok(start >= 0, `${fnName}() is gone from public/js/app.js`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test('both project-mod paths take their sandbox from the one constant', () => {
  assert.match(body('createProjectModTab'), /iframe\.sandbox = PROJECT_MOD_SANDBOX;/,
    'the tab path sets its sandbox from a literal again, so it can drift from the view path');
  assert.match(body('showProjectModView'), /sandbox: PROJECT_MOD_SANDBOX,/,
    'the view path sets its sandbox from a literal again, so it can drift from the tab path');
});

test('allow-scripts and allow-same-origin are still there', () => {
  const flags = sandboxFlags();
  assert.ok(flags.has('allow-scripts'), 'a project mod page cannot run at all without this');
  assert.ok(flags.has('allow-same-origin'), 'the window.deepsteve bridge is injected across the iframe boundary and requires it');
});

test('allow-pointer-lock is still there, or a walkable project mod loses its camera', () => {
  assert.ok(
    sandboxFlags().has('allow-pointer-lock'),
    'without it requestPointerLock() is refused with no visible error, '
    + 'document.pointerLockElement stays null, and a first-person page can only look around '
    + 'while a mouse button is held. The Mausoleum and the Lantern Field in fncore both '
    + 'depend on it.',
  );
});
