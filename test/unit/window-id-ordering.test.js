// Guards the ordering invariant that whole-window restore depends on (#551).
//
// WindowManager.getWindowId() MINTS and persists the window id on first call. So
// hasExistingWindowId() only distinguishes a fresh tab from a reloaded one if it is
// read before ANY caller of getWindowId(). app.js's init() must therefore capture
// isExistingTab as its very first statement.
//
// That invariant silently broke once already: initLiveReload({ windowId: getWindowId() })
// was added partway up init(), above the check. isExistingTab became permanently true,
// the "new tab" branch went unreachable, and whole-window restore stopped running
// entirely — the sessions were fine, the modal just never rendered. The old comment
// ("Check if this is an existing tab BEFORE starting heartbeat") guarded the wrong
// call, and nothing failed, so it went unnoticed. This test fails loudly instead.
//
// Run: node --test test/unit/window-id-ordering.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = path.resolve(__dirname, '..', '..', 'public', 'js', 'app.js');

test('getWindowId() mints on first call — so read order is load-bearing', async () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  globalThis.localStorage = globalThis.sessionStorage;
  globalThis.window = globalThis;
  globalThis.window.parent = globalThis.window;

  const { WindowManager } = await import('../../public/js/window-manager.js?ordering');

  assert.strictEqual(WindowManager.hasExistingWindowId(), false, 'a fresh tab has no window id');
  WindowManager.getWindowId(); // any caller at all — e.g. initLiveReload
  assert.strictEqual(WindowManager.hasExistingWindowId(), true,
    'getWindowId() persisted the id, so the check can never report "new tab" again');
});

test('init() captures isExistingTab before anything can mint the window id', () => {
  // Blank out comments so prose mentioning getWindowId() (including this file's own
  // rationale, and the comment in init()) can't be mistaken for a call site.
  const src = fs.readFileSync(APP_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .split('\n')
    .map(line => (/^\s*\/\//.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

  const initAt = src.indexOf('async function init()');
  assert.ok(initAt !== -1, 'found init()');

  const captureAt = src.indexOf('const isExistingTab = WindowManager.hasExistingWindowId();', initAt);
  assert.ok(captureAt !== -1, 'init() captures isExistingTab');

  // The first real getWindowId() call inside init() must come AFTER the capture.
  const firstMintAt = src.indexOf('getWindowId()', initAt);
  assert.ok(firstMintAt !== -1, 'init() does call getWindowId() somewhere');

  assert.ok(
    captureAt < firstMintAt,
    'isExistingTab must be captured before the first getWindowId() call in init(), or the ' +
    'new-tab branch becomes unreachable and whole-window restore silently dies (#551)'
  );
});
