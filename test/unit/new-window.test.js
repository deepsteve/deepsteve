// Guards the "open a new deepsteve window" contract (#597).
//
// window.open() from a same-origin page COPIES the opener's sessionStorage, which is
// where the window id and the per-tab session list live. Before #597 the ▾ new-tab menu
// opened `location.origin` with no ?fresh=1 while the command palette opened
// `location.origin + '?fresh=1'` — so the menu produced a window holding its parent's
// window id AND tab list, which then fought the parent over the same PTYs. Both now go
// through new-window.js.
//
// Run: node --test test/unit/new-window.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_JS = path.resolve(__dirname, '..', '..', 'public', 'js');

let opened = [];

function stubWindow({ origin = 'https://host:8443', pathname = '/', search = '' } = {}) {
  globalThis.window = {
    location: { origin, pathname, search },
    open: (...args) => { opened.push(args); return {}; },
  };
}

const load = () => import('../../public/js/new-window.js?nw');

test('newWindowUrl always requests a fresh window', async () => {
  opened = [];
  stubWindow();
  const { newWindowUrl } = await load();
  assert.strictEqual(newWindowUrl(), 'https://host:8443/?fresh=1');
});

test('newWindowUrl keeps the path — the old origin-only form dropped it', async () => {
  stubWindow({ pathname: '/ui/' });
  const { newWindowUrl } = await load();
  assert.strictEqual(newWindowUrl({ origin: 'https://host:8443', pathname: '/ui/' }),
    'https://host:8443/ui/?fresh=1');
});

test('openNewWindow passes exactly two arguments to window.open', async () => {
  // Pins the deliberate omission of a features string. 'noopener' is the tempting
  // change — it happens to suppress the sessionStorage copy in Chrome — but it is not
  // specified to, and Safari reads any non-empty features string as a request for a
  // popup-shaped window. The ?fresh=1 flag is the mechanism; the browser is not.
  opened = [];
  stubWindow();
  const { openNewWindow } = await load();
  openNewWindow();
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].length, 2, 'no features string');
  assert.strictEqual(opened[0][0], 'https://host:8443/?fresh=1');
  assert.strictEqual(opened[0][1], '_blank');
});

test('isFreshRequest reads presence, not truthiness', async () => {
  stubWindow();
  const { isFreshRequest } = await load();
  assert.strictEqual(isFreshRequest('?fresh=1'), true);
  assert.strictEqual(isFreshRequest('?fresh'), true, 'a bare ?fresh must work');
  assert.strictEqual(isFreshRequest('?fresh=0'), true, 'presence, matching the old if (freshParam)');
  assert.strictEqual(isFreshRequest(''), false);
  assert.strictEqual(isFreshRequest('?other=1'), false);
});

test('both New Window affordances route through new-window.js', () => {
  // The drift this file exists to prevent: two call sites, one flag, silently
  // disagreeing for however long it takes someone to notice.
  for (const file of ['app.js', 'command-palette.js']) {
    const src = fs.readFileSync(path.join(PUBLIC_JS, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
      .split('\n')
      .map(line => (/^\s*\/\//.test(line) ? ' '.repeat(line.length) : line))
      .join('\n');
    assert.ok(!src.includes('window.open(window.location.origin'),
      `${file} must call openNewWindow() rather than opening a window by hand (#597)`);
    assert.ok(src.includes("from './new-window.js'"),
      `${file} must import from new-window.js`);
    assert.ok(src.includes('openNewWindow()'),
      `${file} must use openNewWindow()`);
  }
});
