// Project Notes' REST routes, driven through a fake Express app against a scratch
// DEEPSTEVE_HOME — no daemon, no shell.
//
// Run: node --test test/unit/project-notes-store.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'project-notes-'));
process.env.DEEPSTEVE_HOME = HOME;
const FILE = path.join(HOME, 'project-notes.json');

function freshRoutes() {
  delete require.cache[require.resolve('../../mods/project-notes/tools.js')];
  const mod = require('../../mods/project-notes/tools.js');
  const routes = {};
  const app = {};
  for (const m of ['get', 'post', 'put', 'delete']) app[m] = (p, h) => { routes[`${m.toUpperCase()} ${p}`] = h; };
  mod.registerRoutes(app, { log() {} });
  return (method, p, { params = {}, body } = {}) => {
    let status = 200;
    let payload;
    const res = {
      status(s) { status = s; return res; },
      json(o) { payload = o; return res; },
      end() { return res; },
    };
    routes[`${method} ${p}`]({ params, body }, res);
    return { status, body: payload };
  };
}

test('create, edit, list newest-edited first, move, delete — and it all survives a reload', async () => {
  fs.rmSync(FILE, { force: true });
  let call = freshRoutes();

  assert.deepStrictEqual(call('GET', '/api/project-notes').body, { notes: [] });
  assert.strictEqual(call('POST', '/api/project-notes', { body: { text: 'x' } }).status, 400, 'projectId is required');

  const a = call('POST', '/api/project-notes', { body: { projectId: 'p1', text: 'First\nbody' } }).body.note;
  await new Promise(r => setTimeout(r, 5));
  const b = call('POST', '/api/project-notes', { body: { projectId: 'p2', text: 'Second' } }).body.note;
  assert.deepStrictEqual(call('GET', '/api/project-notes').body.notes.map(n => n.id), [b.id, a.id]);

  // A no-op save must not reorder the list.
  call('PUT', '/api/project-notes/:id', { params: { id: a.id }, body: { text: 'First\nbody' } });
  assert.deepStrictEqual(call('GET', '/api/project-notes').body.notes.map(n => n.id), [b.id, a.id]);

  await new Promise(r => setTimeout(r, 5));
  const edited = call('PUT', '/api/project-notes/:id', { params: { id: a.id }, body: { text: 'First, edited', projectId: 'p3' } }).body.note;
  assert.strictEqual(edited.text, 'First, edited');
  assert.strictEqual(edited.projectId, 'p3');
  assert.deepStrictEqual(call('GET', '/api/project-notes').body.notes.map(n => n.id), [a.id, b.id]);

  assert.strictEqual(call('PUT', '/api/project-notes/:id', { params: { id: a.id }, body: { projectId: '' } }).status, 400);
  assert.strictEqual(call('PUT', '/api/project-notes/:id', { params: { id: 'nope' }, body: { text: 'x' } }).status, 404);

  // Reload from disk.
  call = freshRoutes();
  assert.deepStrictEqual(call('GET', '/api/project-notes').body.notes.map(n => [n.id, n.text]), [[a.id, 'First, edited'], [b.id, 'Second']]);

  assert.strictEqual(call('DELETE', '/api/project-notes/:id', { params: { id: b.id } }).status, 204);
  assert.strictEqual(call('DELETE', '/api/project-notes/:id', { params: { id: b.id } }).status, 404);
  call = freshRoutes();
  assert.deepStrictEqual(call('GET', '/api/project-notes').body.notes.map(n => n.id), [a.id]);
});

test('pin and trash are flags, not edits; restore unpins; empty-trash removes only the trash', async () => {
  fs.rmSync(FILE, { force: true });
  let call = freshRoutes();
  const put = (id, body) => call('PUT', '/api/project-notes/:id', { params: { id }, body });

  const a = call('POST', '/api/project-notes', { body: { projectId: 'p1', text: 'Keep' } }).body.note;
  const b = call('POST', '/api/project-notes', { body: { projectId: 'p1', text: 'Toss' } }).body.note;
  assert.strictEqual(a.pinned, false);
  assert.strictEqual(a.deletedAt, null);

  await new Promise(r => setTimeout(r, 5));
  const pinned = put(a.id, { pinned: true }).body.note;
  assert.strictEqual(pinned.pinned, true);
  assert.strictEqual(pinned.updatedAt, a.updatedAt, 'pinning is not an edit');

  const pinnedB = put(b.id, { pinned: true }).body.note;
  const trashed = put(b.id, { deleted: true }).body.note;
  assert.ok(trashed.deletedAt >= pinnedB.updatedAt);
  assert.strictEqual(trashed.pinned, false, 'trashing unpins');
  assert.strictEqual(trashed.updatedAt, b.updatedAt, 'trashing is not an edit');

  const restored = put(b.id, { deleted: false }).body.note;
  assert.strictEqual(restored.deletedAt, null);
  put(b.id, { deleted: true });

  call = freshRoutes();
  const after = Object.fromEntries(call('GET', '/api/project-notes').body.notes.map(n => [n.text, n]));
  assert.strictEqual(after.Keep.pinned, true, 'pin survives a reload');
  assert.ok(after.Toss.deletedAt, 'trash survives a reload');

  assert.deepStrictEqual(call('POST', '/api/project-notes/empty-trash').body, { removed: 1 });
  assert.deepStrictEqual(call('GET', '/api/project-notes').body.notes.map(n => n.text), ['Keep']);
  assert.deepStrictEqual(call('POST', '/api/project-notes/empty-trash').body, { removed: 0 });
});

test('notes saved before pin/trash existed load as unpinned and live', () => {
  fs.writeFileSync(FILE, JSON.stringify({ notes: [{ id: 'old', projectId: 'p1', text: 'Old', createdAt: 1, updatedAt: 1 }] }));
  const call = freshRoutes();
  const [note] = call('GET', '/api/project-notes').body.notes;
  assert.strictEqual(note.pinned, false);
  assert.strictEqual(note.deletedAt, null);
});

test('a corrupt notes file is set aside, never overwritten', () => {
  fs.writeFileSync(FILE, '{not json');
  const call = freshRoutes();
  assert.deepStrictEqual(call('GET', '/api/project-notes').body, { notes: [] });
  const aside = fs.readdirSync(HOME).filter(f => f.startsWith('project-notes.json.corrupt-'));
  assert.strictEqual(aside.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(HOME, aside[0]), 'utf8'), '{not json');
});
