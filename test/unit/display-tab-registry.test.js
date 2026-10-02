// Unit tests for display-tab-registry.js (#715): display tabs on disk, their locks, and the
// stack "Reopen closed tab" pops. A temp dir per test and a fake clock — no daemon.
//
// Run: node --test test/unit/display-tab-registry.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDisplayTabRegistry } = require('../../display-tab-registry.js');

const DAY = 24 * 60 * 60 * 1000;

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-display-tab-registry-'));
  const clock = { t: Date.parse('2026-10-01T12:00:00Z') };
  const make = (more = {}) => createDisplayTabRegistry({ dir, now: () => clock.t, ...opts, ...more });
  return { dir, clock, make, reg: make() };
}

const exists = (...p) => fs.existsSync(path.join(...p));

test('close moves the page onto the stack, newest first, and reopen brings it back under the same id', () => {
  const { dir, clock, reg } = setup();
  reg.set('aa', '<p>a</p>', { name: 'A', cwd: '/proj' });
  reg.set('bb', '<p>b</p>', { name: 'B', cwd: null });

  assert.strictEqual(reg.close('aa'), 'closed');
  clock.t += 1000;
  assert.strictEqual(reg.close('bb'), 'closed');
  assert.ok(!reg.tabs.has('aa') && !reg.tabs.has('bb'));
  assert.ok(!exists(dir, 'aa.html'));
  assert.ok(exists(dir, 'closed', 'aa.html'), 'kept, not deleted');
  assert.deepStrictEqual(reg.closedList().map(e => e.id), ['bb', 'aa']);
  assert.strictEqual(reg.closedCount(), 2);

  assert.deepStrictEqual(reg.reopen(), { id: 'bb', name: 'B', cwd: null });
  assert.deepStrictEqual(reg.reopen(), { id: 'aa', name: 'A', cwd: '/proj' });
  assert.strictEqual(reg.tabs.get('aa'), '<p>a</p>', 'the content comes back, not just the name');
  assert.ok(exists(dir, 'aa.html'));
  assert.ok(!exists(dir, 'closed', 'aa.html'));
  assert.strictEqual(reg.reopen(), null, 'an empty stack');
  assert.strictEqual(reg.closedCount(), 0);
});

test('closing a missing tab is a no-op, and a second close of the same tab pushes nothing', () => {
  const { reg } = setup();
  assert.strictEqual(reg.close('nope'), 'missing');
  reg.set('aa', 'x', { name: 'A' });
  assert.strictEqual(reg.close('aa'), 'closed');
  assert.strictEqual(reg.close('aa'), 'missing', "the browser's echo after an agent's close");
  assert.strictEqual(reg.closedCount(), 1);
});

test('a locked tab refuses to close until it is unlocked', () => {
  const { dir, reg } = setup();
  reg.set('aa', 'x', { name: 'A' });
  assert.strictEqual(reg.setLocked('aa', true), true);
  assert.ok(reg.isLocked('aa'));
  assert.deepStrictEqual(reg.lockedIds(), ['aa']);
  assert.strictEqual(reg.close('aa'), 'locked');
  assert.ok(reg.tabs.has('aa'));
  assert.ok(exists(dir, 'aa.html'));
  assert.strictEqual(reg.closedCount(), 0);

  assert.strictEqual(reg.setLocked('aa', false), false);
  assert.strictEqual(reg.close('aa'), 'closed');
  assert.strictEqual(reg.setLocked('aa', true), null, 'a closed tab cannot be locked');
  assert.deepStrictEqual(reg.lockedIds(), []);
});

test('the name the browser closed it under wins over the name it was created with', () => {
  const { reg } = setup();
  reg.set('aa', 'x', { name: 'Agent name', cwd: '/p' });
  reg.close('aa', { name: 'Renamed by me' });
  assert.deepStrictEqual(reg.reopen(), { id: 'aa', name: 'Renamed by me', cwd: '/p' });
  reg.close('aa', { name: '   ' });
  assert.strictEqual(reg.reopen().name, 'Renamed by me', 'a blank name is no name');
  reg.close('aa', { name: 'y'.repeat(500) });
  assert.strictEqual(reg.reopen().name.length, 200);
});

test('the stack keeps the newest 20 and deletes the files of the rest', () => {
  const { dir, clock, reg } = setup();
  for (let i = 0; i < 22; i++) {
    reg.set(`t${i}`, `${i}`, { name: `T${i}` });
    reg.close(`t${i}`);
    clock.t += 1000;
  }
  const ids = reg.closedList().map(e => e.id);
  assert.strictEqual(ids.length, 20);
  assert.strictEqual(ids[0], 't21');
  assert.strictEqual(ids[19], 't2');
  assert.ok(!exists(dir, 'closed', 't0.html') && !exists(dir, 'closed', 't1.html'));
  assert.ok(exists(dir, 'closed', 't2.html'));
});

test('an entry older than 7 days cannot be reopened, and its file is removed', () => {
  const { dir, clock, reg } = setup();
  reg.set('old', 'o', { name: 'Old' });
  reg.close('old');
  clock.t += DAY;
  reg.set('new', 'n', { name: 'New' });
  reg.close('new');
  clock.t += 6.5 * DAY; // old is 7.5 days closed, new 6.5
  assert.deepStrictEqual(reg.closedList().map(e => e.id), ['new']);
  assert.strictEqual(reg.reopen().id, 'new');
  assert.strictEqual(reg.reopen(), null);
  assert.ok(!exists(dir, 'closed', 'old.html'));
});

test('locks and the stack survive a restart', () => {
  const { make, reg } = setup();
  reg.set('keep', 'k', { name: 'Keep', cwd: '/p' });
  reg.setLocked('keep', true);
  reg.set('gone', 'g', { name: 'Gone' });
  reg.close('gone', { name: 'Gone (renamed)' });

  const after = make();
  assert.strictEqual(after.load(), 1);
  assert.strictEqual(after.tabs.get('keep'), 'k');
  assert.ok(after.isLocked('keep'));
  assert.strictEqual(after.close('keep'), 'locked');
  assert.deepStrictEqual(after.reopen(), { id: 'gone', name: 'Gone (renamed)', cwd: null });
  assert.strictEqual(after.tabs.get('gone'), 'g');
});

test('the boot sweep removes an untouched tab after 7 days, except a locked one', () => {
  const { dir, clock, make, reg } = setup();
  reg.set('stale', 's', { name: 'S' });
  reg.set('locked', 'l', { name: 'L' });
  reg.setLocked('locked', true);
  reg.set('fresh', 'f', { name: 'F' });
  const old = new Date(clock.t - 8 * DAY);
  fs.utimesSync(path.join(dir, 'stale.html'), old, old);
  fs.utimesSync(path.join(dir, 'locked.html'), old, old);

  const after = make();
  after.load();
  assert.deepStrictEqual([...after.tabs.keys()].sort(), ['fresh', 'locked']);
  assert.ok(!exists(dir, 'stale.html'));
});

test('a reopened page starts its staleness clock again', () => {
  const { dir, clock, make, reg } = setup();
  reg.set('aa', 'x', { name: 'A' });
  const old = new Date(clock.t - 6 * DAY);
  fs.utimesSync(path.join(dir, 'aa.html'), old, old);
  reg.close('aa');
  clock.t += 2 * DAY; // the file is now 8 days old, the close 2
  assert.strictEqual(reg.reopen().id, 'aa');
  const after = make();
  after.load();
  assert.ok(after.tabs.has('aa'), 'not swept on the next boot');
});

test('a page from before #715 loads unlocked and unnamed, and closes onto the stack', () => {
  const { dir, make } = setup();
  fs.writeFileSync(path.join(dir, 'legacy.html'), '<p>old</p>');
  const reg = make();
  reg.load();
  assert.strictEqual(reg.tabs.get('legacy'), '<p>old</p>');
  assert.ok(!reg.isLocked('legacy'));
  reg.close('legacy', { name: 'Shown name' });
  assert.deepStrictEqual(reg.reopen(), { id: 'legacy', name: 'Shown name', cwd: null });
});

test('load drops closed files the index does not list, and survives a corrupt index', () => {
  const { dir, make } = setup();
  fs.mkdirSync(path.join(dir, 'closed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'closed', 'orphan.html'), 'o');
  fs.writeFileSync(path.join(dir, 'open.html'), 'x');
  fs.writeFileSync(path.join(dir, 'index.json'), '{not json');
  const reg = make();
  assert.strictEqual(reg.load(), 1);
  assert.ok(!exists(dir, 'closed', 'orphan.html'));
  assert.strictEqual(reg.reopen(), null);
  assert.ok(!reg.isLocked('open'));
});

test('a content-only set leaves the index alone; set with info writes it', () => {
  const { dir, reg } = setup();
  reg.set('aa', 'v1', { name: 'A' });
  const index = path.join(dir, 'index.json');
  const before = fs.readFileSync(index, 'utf8');
  fs.unlinkSync(index);
  reg.set('aa', 'v2');
  assert.ok(!fs.existsSync(index), 'an edit_display_tab does not rewrite the index');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'aa.html'), 'utf8'), 'v2');
  reg.set('aa', 'v3', { name: 'A' });
  assert.strictEqual(JSON.parse(fs.readFileSync(index, 'utf8')).tabs.aa.name, JSON.parse(before).tabs.aa.name);
});
