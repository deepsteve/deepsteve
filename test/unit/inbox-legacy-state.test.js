// Unit test for mods/inbox/legacy-state.js — carrying Workshop's state files across the
// rename to Inbox.
//
// What it pins: an install's existing questions, chat, permission log and images survive the
// rename, and the carry never overwrites state already written under the new name. Each store
// calls the migration from its own path function, so whichever store loads first moves them.
//
// HOME is repointed before the require, as in inbox-images.test.js, because paths.js resolves
// the state dir lazily from it.
//
// Run: node --test test/unit/inbox-legacy-state.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-inbox-legacy-'));
delete process.env.DEEPSTEVE_HOME;

let n = 0;
/** A fresh state dir per test: the migration remembers which dirs it has already done. */
function freshHome() {
  const home = path.join(ROOT, `h${++n}`);
  fs.mkdirSync(path.join(home, '.deepsteve'), { recursive: true });
  process.env.HOME = home;
  return path.join(home, '.deepsteve');
}

const { migrateLegacyState } = require('../../mods/inbox/legacy-state.js');
const inbox = require('../../mods/inbox/inbox.js');

test('every Workshop state file is moved to its Inbox name', () => {
  const dir = freshHome();
  fs.writeFileSync(path.join(dir, 'workshop.json'), '{"items":[]}');
  fs.writeFileSync(path.join(dir, 'workshop-chat.json'), '{"chat":1}');
  fs.writeFileSync(path.join(dir, 'workshop-permissions.json'), '{"perm":1}');
  fs.mkdirSync(path.join(dir, 'workshop-images'));
  fs.writeFileSync(path.join(dir, 'workshop-images', 'w1-0.png'), 'png');

  migrateLegacyState();

  assert.strictEqual(fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8'), '{"items":[]}');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'inbox-chat.json'), 'utf8'), '{"chat":1}');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'inbox-permissions.json'), 'utf8'), '{"perm":1}');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'inbox-images', 'w1-0.png'), 'utf8'), 'png');
  for (const old of ['workshop.json', 'workshop-chat.json', 'workshop-permissions.json', 'workshop-images']) {
    assert.strictEqual(fs.existsSync(path.join(dir, old)), false, `${old} is gone`);
  }
});

test('state already under the new name wins, and the old file is left untouched', () => {
  const dir = freshHome();
  fs.writeFileSync(path.join(dir, 'workshop.json'), 'OLD');
  fs.writeFileSync(path.join(dir, 'inbox.json'), 'NEW');

  migrateLegacyState();

  assert.strictEqual(fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8'), 'NEW');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'workshop.json'), 'utf8'), 'OLD');
});

test('the item store moves the file itself before its first read', () => {
  // The ordering that matters in the daemon: no caller runs the migration by hand, so the
  // store's own path function has to — or an upgraded install opens an empty inbox.
  const dir = freshHome();
  const item = { id: 'w7', kind: 'ask', question: 'Still here?', createdAt: 1, status: 'open' };
  fs.writeFileSync(path.join(dir, 'workshop.json'), JSON.stringify({ items: [item] }));

  inbox.load();

  assert.ok(fs.existsSync(path.join(dir, 'inbox.json')), 'moved by the store');
  assert.strictEqual(fs.existsSync(path.join(dir, 'workshop.json')), false);
  assert.ok(inbox.all().some(i => i.id === 'w7'), JSON.stringify(inbox.all()));
});
