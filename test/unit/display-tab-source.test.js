// Unit tests for the display-tab HTML source resolution (#599): create/update
// accept EITHER inline `html` OR a `file_path` the server reads itself (so a model
// that already wrote the page to disk doesn't re-emit it as output tokens), plus an
// optional literal `replacements` map. See mods/display-tab/tools.js (resolveHtml).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { init } = require('../../mods/display-tab/tools.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-display-tab-'));

function makeTools() {
  const displayTabs = new Map();
  const ctx = {
    shells: new Map(),
    reloadClients: new Set(),
    pendingOpens: [],
    log: () => {},
    displayTabs,
    setDisplayTab: (id, html) => displayTabs.set(id, html),
    deleteDisplayTab: (id) => displayTabs.delete(id),
    sessionPaths: (e) => ({ cwd: e.cwd }),
  };
  return { tools: init(ctx), displayTabs };
}

function writeFixture(name, contents) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('create_display_tab reads html from file_path', async () => {
  const { tools, displayTabs } = makeTools();
  const file = writeFixture('page.html', '<!DOCTYPE html><h1>from disk</h1>');

  const res = await tools.create_display_tab.handler({ session_id: 'nope', file_path: file });
  assert.ok(!res.isError, 'should succeed');
  const { id } = JSON.parse(res.content[0].text);
  assert.strictEqual(displayTabs.get(id), '<!DOCTYPE html><h1>from disk</h1>');
});

test('create_display_tab expands a leading ~ in file_path', async () => {
  const { tools, displayTabs } = makeTools();
  const home = process.env.HOME;
  process.env.HOME = TMP; // os.homedir() honors $HOME on posix
  try {
    writeFixture('tilde.html', '<p>tilde</p>');
    const res = await tools.create_display_tab.handler({ session_id: 'nope', file_path: '~/tilde.html' });
    assert.ok(!res.isError, res.content[0].text);
    const { id } = JSON.parse(res.content[0].text);
    assert.strictEqual(displayTabs.get(id), '<p>tilde</p>');
  } finally {
    process.env.HOME = home;
  }
});

test('html and file_path are mutually exclusive, and one is required', async () => {
  const { tools, displayTabs } = makeTools();
  const file = writeFixture('both.html', '<p>disk</p>');

  const both = await tools.create_display_tab.handler({ session_id: 'nope', html: '<p>inline</p>', file_path: file });
  assert.ok(both.isError, 'both → error');
  assert.match(both.content[0].text, /exactly one of html or file_path/);

  const neither = await tools.create_display_tab.handler({ session_id: 'nope' });
  assert.ok(neither.isError, 'neither → error');
  assert.match(neither.content[0].text, /exactly one of html or file_path/);

  assert.strictEqual(displayTabs.size, 0, 'no tab is stored on a rejected call');
});

test('unreadable file_path values fail with a readable message', async () => {
  const { tools, displayTabs } = makeTools();

  const missing = await tools.create_display_tab.handler({ session_id: 'nope', file_path: path.join(TMP, 'nope.html') });
  assert.ok(missing.isError);
  assert.match(missing.content[0].text, /no such file/);

  const dir = await tools.create_display_tab.handler({ session_id: 'nope', file_path: TMP });
  assert.ok(dir.isError);
  assert.match(dir.content[0].text, /is a directory/);

  const relative = await tools.create_display_tab.handler({ session_id: 'nope', file_path: 'page.html' });
  assert.ok(relative.isError);
  assert.match(relative.content[0].text, /must be an absolute path/);

  assert.strictEqual(displayTabs.size, 0);
});

test('replacements are applied literally, longest key first', async () => {
  const { tools, displayTabs } = makeTools();
  const file = writeFixture('tpl.html', '<h1>%%TITLE%%</h1><p>%%TITLE%%_SUB</p><span>%%CH%%</span>');

  const res = await tools.create_display_tab.handler({
    session_id: 'nope',
    file_path: file,
    // '%%TITLE%%_SUB' must win over '%%TITLE%%' where both could match; the $& in the
    // value proves we're not going through String.replace's substitution syntax.
    replacements: { '%%TITLE%%': 'hi', '%%TITLE%%_SUB': 'sub $& done', '%%CH%%': 'slot-ab3f9c12' },
  });
  assert.ok(!res.isError, res.content[0].text);
  const { id } = JSON.parse(res.content[0].text);
  assert.strictEqual(displayTabs.get(id), '<h1>hi</h1><p>sub $& done</p><span>slot-ab3f9c12</span>');
});

test('replacements also apply to inline html, and reject an empty key', async () => {
  const { tools, displayTabs } = makeTools();

  const ok = await tools.create_display_tab.handler({
    session_id: 'nope', html: '<p>%%A%%</p>', replacements: { '%%A%%': 'x' },
  });
  const { id } = JSON.parse(ok.content[0].text);
  assert.strictEqual(displayTabs.get(id), '<p>x</p>');

  const bad = await tools.create_display_tab.handler({
    session_id: 'nope', html: '<p>a</p>', replacements: { '': 'x' },
  });
  assert.ok(bad.isError);
  assert.match(bad.content[0].text, /must not be empty/);
});

test('update_display_tab accepts file_path for an existing tab', async () => {
  const { tools, displayTabs } = makeTools();
  const created = await tools.create_display_tab.handler({ session_id: 'nope', html: '<p>v1</p>' });
  const { id } = JSON.parse(created.content[0].text);

  const file = writeFixture('v2.html', '<p>%%V%%</p>');
  const res = await tools.update_display_tab.handler({ tab_id: id, file_path: file, replacements: { '%%V%%': 'v2' } });
  assert.ok(!res.isError, res.content[0].text);
  assert.strictEqual(displayTabs.get(id), '<p>v2</p>');

  const both = await tools.update_display_tab.handler({ tab_id: id, html: '<p>v3</p>', file_path: file });
  assert.ok(both.isError);
  assert.strictEqual(displayTabs.get(id), '<p>v2</p>', 'rejected update leaves content untouched');
});
