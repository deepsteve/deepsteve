// Tasks that link to Deep Steve sessions, live or closed, and reopen them (#719).
//
// What this pins:
//   * the session that calls add_task is attached to the task, by its shell id;
//   * a session's state (live / closed / saved / gone) is read from the daemon as the list goes
//     out and is never written into tasks.json, where it would go stale the moment a tab closed;
//   * the open route pushes the SAME two messages Inbox's Discuss does — repair+focus for a live
//     session, restore for a tombstone — and pushes nothing at all when it refuses.
//
// Run: node --test test/unit/tasks-sessions.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-sessions-'));
const STATE = path.join(HOME, 'state');
process.env.DEEPSTEVE_HOME = STATE;
const TASKS_FILE = path.join(STATE, 'tasks.json');

// A task written before #719 has no `sessions` field. Seeded before the require, because the
// mod reads tasks.json once, at load.
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(TASKS_FILE, JSON.stringify([{
  id: 1, title: 'legacy', description: '', priority: 'medium', status: 'done', session_tag: 'old-tag', created: 1,
}]));

const tools = require('../../mods/tasks/tools.js');

const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));
const MISSING = path.join(HOME, 'no-such-dir');

function harness() {
  const shells = new Map();
  const saved = {};
  const deliveries = [];
  const broadcasts = [];
  const sent = [];   // what the control channel carried, from one window's socket
  const reloadClients = new Set([
    { readyState: 1, windowId: 'W-owner', send: (d) => sent.push(JSON.parse(d)) },
    { readyState: 1, windowId: 'W-click', send: () => {} },
  ]);

  shells.set('S-live', { cwd: PROJECT, name: 'Fix login', windowId: 'W-owner' });
  saved['S-closed'] = { cwd: PROJECT, name: 'Old work', closed: true, closedAt: 1000, windowId: 'W-gone' };
  saved['S-saved'] = { cwd: PROJECT, name: null };
  saved['S-nocwd'] = { cwd: MISSING, name: 'Moved', closed: true, closedAt: 2000 };

  let stateSaves = 0;
  const ctx = {
    shells,
    getSavedSession: (id) => saved[id] || null,
    saveState: () => { stateSaves++; },
    broadcast: (m) => broadcasts.push(m),
    log: () => {},
    reloadClients,
    deliverToWindow: (msg, target, opts) => {
      deliveries.push({ msg, target, opts });
      return target ? 'window' : 'broadcast';
    },
  };

  const routes = {};
  const app = {
    get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; },
    delete: (p, ...h) => { routes['DELETE ' + p] = h[h.length - 1]; },
  };
  const registered = tools.init(ctx);
  tools.registerRoutes(app, ctx);

  function call(key, { params = {}, body = {} } = {}) {
    let out = null;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(v) { out = { status: this.statusCode, body: v }; return this; },
    };
    routes[key]({ params, query: {}, body }, res);
    return out;
  }

  const caller = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });

  async function addTask(title, shellId) {
    const r = await registered.add_task.handler({ title }, shellId ? caller(shellId) : undefined);
    return Number(/Task #(\d+) created/.exec(r.content[0].text)[1]);
  }

  const wireTask = (id) => call('GET /api/tasks').body.tasks.find((t) => t.id === id);
  const storedTask = (id) => JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).find((t) => t.id === id);
  const attach = (id, sessionId) => call('POST /api/tasks/:id/sessions', { params: { id: String(id) }, body: { sessionId } });
  const detach = (id, sessionId) => call('DELETE /api/tasks/:id/sessions/:sessionId', { params: { id: String(id), sessionId } });
  const open = (id, sessionId, windowId) => call('POST /api/tasks/:id/sessions/:sessionId/open', {
    params: { id: String(id), sessionId }, body: { windowId },
  });

  const workOn = async (id, shellId) => (await registered.work_on_task.handler({ id }, shellId ? caller(shellId) : undefined)).content[0].text;
  const sessionTaskPings = () => broadcasts.filter((m) => m.type === 'session-tasks');

  return {
    shells, saved, deliveries, broadcasts, sent, reloadClients, tools: registered, call, addTask, wireTask, storedTask, attach, detach, open,
    workOn, sessionTaskPings, stateSaves: () => stateSaves,
  };
}

// ── attaching ────────────────────────────────────────────────────────────────

test('add_task attaches the calling session, by shell id, with the name it had', async () => {
  const h = harness();
  const id = await h.addTask('ship it', 'S-live');
  assert.deepStrictEqual(h.storedTask(id).sessions, [{ id: 'S-live', name: 'Fix login' }]);
});

test('add_task with no caller, or a caller the daemon has no shell for, attaches nothing', async () => {
  const h = harness();
  assert.deepStrictEqual(h.storedTask(await h.addTask('no caller')).sessions, []);
  assert.deepStrictEqual(h.storedTask(await h.addTask('ghost caller', 'S-unknown')).sessions, []);
});

test('a task written before #719 reads as having no sessions', () => {
  const h = harness();
  const legacy = h.wireTask(1);
  assert.deepStrictEqual(legacy.sessions, []);
  assert.strictEqual(legacy.session_tag, 'old-tag');
});

test('attach adds a known session once, and refuses one the daemon has no record of', async () => {
  const h = harness();
  const id = await h.addTask('attach', 'S-live');
  assert.strictEqual(h.attach(id, 'S-closed').status, 200);
  assert.strictEqual(h.attach(id, 'S-closed').status, 200);
  assert.deepStrictEqual(h.storedTask(id).sessions.map((s) => s.id), ['S-live', 'S-closed']);

  assert.strictEqual(h.attach(id, 'S-unknown').status, 404);
  assert.strictEqual(h.attach(9999, 'S-live').status, 404);
  assert.deepStrictEqual(h.storedTask(id).sessions.map((s) => s.id), ['S-live', 'S-closed']);
});

test('detach removes the session and nothing else', async () => {
  const h = harness();
  const id = await h.addTask('detach', 'S-live');
  h.attach(id, 'S-closed');
  assert.strictEqual(h.detach(id, 'S-live').status, 200);
  assert.deepStrictEqual(h.storedTask(id).sessions.map((s) => s.id), ['S-closed']);
});

// ── what the panel sees ──────────────────────────────────────────────────────

test('every session state is read from the daemon as the list goes out', async () => {
  const h = harness();
  const id = await h.addTask('states', 'S-live');
  h.attach(id, 'S-closed');
  h.attach(id, 'S-saved');

  assert.deepStrictEqual(h.wireTask(id).sessions, [
    { id: 'S-live', label: 'Fix login', state: 'live', closedAt: null, working: false },
    { id: 'S-closed', label: 'Old work', state: 'closed', closedAt: 1000, working: false },
    // No name anywhere: the folder is the label, as a tab would show it.
    { id: 'S-saved', label: path.basename(PROJECT), state: 'saved', closedAt: null, working: false },
  ]);
});

test('a purged session is "gone" and keeps the name it was attached with', async () => {
  const h = harness();
  const id = await h.addTask('purged', 'S-live');
  h.attach(id, 'S-closed');
  delete h.saved['S-closed'];   // what pruneClosedSessions() does to an old tombstone
  assert.deepStrictEqual(h.wireTask(id).sessions[1], { id: 'S-closed', label: 'Old work', state: 'gone', closedAt: null, working: false });
});

test('a live session that closes reads as closed on the next list, with no task write', async () => {
  const h = harness();
  const id = await h.addTask('closes', 'S-live');
  const before = fs.readFileSync(TASKS_FILE, 'utf8');
  h.shells.delete('S-live');
  h.saved['S-live'] = { cwd: PROJECT, name: 'Fix login', closed: true, closedAt: 5000 };
  assert.deepStrictEqual(h.wireTask(id).sessions[0], { id: 'S-live', label: 'Fix login', state: 'closed', closedAt: 5000, working: false });
  assert.strictEqual(fs.readFileSync(TASKS_FILE, 'utf8'), before);
});

test('the decoration never reaches tasks.json, and the broadcast carries it', async () => {
  const h = harness();
  const id = await h.addTask('wire only', 'S-live');
  h.attach(id, 'S-closed');
  for (const s of h.storedTask(id).sessions) {
    assert.deepStrictEqual(Object.keys(s).sort(), ['id', 'name']);
  }
  const last = h.broadcasts[h.broadcasts.length - 1];
  assert.strictEqual(last.type, 'tasks');
  assert.strictEqual(last.tasks.find((t) => t.id === id).sessions[1].state, 'closed');
});

test('list_tasks shows each attached session, so an agent can see them too', async () => {
  const h = harness();
  const id = await h.addTask('listed', 'S-live');
  h.attach(id, 'S-closed');
  const r = await h.tools.list_tasks.handler({});
  assert.match(r.content[0].text, new RegExp(`#${id}: listed[^\\n]*\\n\\s+sessions: Fix login \\(S-live, live\\), Old work \\(S-closed, closed\\)`));
});

// ── opening ──────────────────────────────────────────────────────────────────

test('a live session is focused in the window that has it', async () => {
  const h = harness();
  const id = await h.addTask('open live', 'S-live');
  const r = h.open(id, 'S-live', 'W-click');
  assert.deepStrictEqual(r, { status: 200, body: { opened: 'focused', tabDelivery: 'window' } });
  assert.strictEqual(h.deliveries.length, 1);
  const { msg, target } = h.deliveries[0];
  assert.strictEqual(target, 'W-owner');
  assert.deepStrictEqual(msg, {
    type: 'open-session', id: 'S-live', cwd: PROJECT, name: 'Fix login', windowId: 'W-owner', repair: true, focus: true,
  });
});

test('a live session whose window is not connected opens in the window that clicked', async () => {
  const h = harness();
  const id = await h.addTask('open live elsewhere', 'S-live');
  h.shells.get('S-live').windowId = 'W-closed-window';
  h.open(id, 'S-live', 'W-click');
  assert.strictEqual(h.deliveries[0].target, 'W-click');
  assert.strictEqual(h.deliveries[0].msg.repair, true);
});

test('a closed session is restored into the window that clicked', async () => {
  const h = harness();
  const id = await h.addTask('open closed', 'S-live');
  h.attach(id, 'S-closed');
  const r = h.open(id, 'S-closed', 'W-click');
  assert.deepStrictEqual(r.body, { opened: 'restored', tabDelivery: 'window' });
  assert.deepStrictEqual(h.deliveries[0].msg, {
    type: 'open-session', id: 'S-closed', cwd: PROJECT, name: 'Old work', windowId: 'W-click', restore: true,
  });
  assert.deepStrictEqual(h.deliveries[0].opts, { openBrowser: true });
});

test('a click from a window that is not connected still restores, just not to a named window', async () => {
  const h = harness();
  const id = await h.addTask('open closed nowhere', 'S-live');
  h.attach(id, 'S-closed');
  h.open(id, 'S-closed', 'W-unknown');
  assert.strictEqual(h.deliveries[0].target, null);
  assert.strictEqual(h.deliveries[0].msg.windowId, null);
});

test('refusals push nothing: gone is 410, a missing folder 409, an unattached session 404', async () => {
  const h = harness();
  const id = await h.addTask('refusals', 'S-live');
  h.attach(id, 'S-closed');
  h.attach(id, 'S-nocwd');

  delete h.saved['S-closed'];
  const gone = h.open(id, 'S-closed', 'W-click');
  assert.strictEqual(gone.status, 410);
  assert.strictEqual(gone.body.error, 'gone');

  const moved = h.open(id, 'S-nocwd', 'W-click');
  assert.strictEqual(moved.status, 409);
  assert.strictEqual(moved.body.error, 'cwd-missing');

  // S-saved exists, but this task does not reference it: the route is not a door to any session.
  assert.strictEqual(h.open(id, 'S-saved', 'W-click').status, 404);
  assert.strictEqual(h.open(9999, 'S-live', 'W-click').status, 404);

  assert.deepStrictEqual(h.deliveries, []);
});

// ── the task a session is working on ─────────────────────────────────────────

test('work_on_task keeps the task on the caller\'s own record, attaches it, and starts the task', async () => {
  const h = harness();
  const id = await h.addTask('write the notes');   // written with no session attached
  h.shells.set('S-two', { cwd: PROJECT, name: 'Notes' });

  const said = await h.workOn(id, 'S-two');
  assert.match(said, new RegExp(`working on task #${id}: "write the notes" \\(in-progress\\)`));
  assert.deepStrictEqual(h.shells.get('S-two').task, { id, title: 'write the notes' }, 'on the shell entry, which state.json carries');
  assert.ok(h.stateSaves() > 0, 'and the daemon was told to save it');
  assert.deepStrictEqual(h.storedTask(id).sessions, [{ id: 'S-two', name: 'Notes' }], 'attached, so the panel badges it');
  assert.strictEqual(h.storedTask(id).status, 'in-progress', 'a pending task is started');

  // Every window hears it, on both channels, so a tile updates without asking.
  const ping = h.sessionTaskPings().at(-1);
  assert.deepStrictEqual(ping.tasks['S-two'], { id, title: 'write the notes', status: 'in-progress' });
  assert.deepStrictEqual(h.sent.at(-1), ping);

  const wire = h.wireTask(id).sessions.find((s) => s.id === 'S-two');
  assert.strictEqual(wire.working, true, 'the task side says who is working on it');
  const listed = (await h.tools.list_tasks.handler({ scope: 'all' }, undefined)).content[0].text;
  assert.match(listed, /Notes \(S-two, live, working on it\)/);
});

test('a session\'s task is read from the task as it goes out: renamed, done, then deleted', async () => {
  const h = harness();
  const id = await h.addTask('first name', 'S-live');
  await h.workOn(id, 'S-live');
  const entry = h.shells.get('S-live');

  await h.tools.update_task.handler({ id, title: 'second name' });
  assert.deepStrictEqual(tools.sessionTask(entry), { id, title: 'second name', status: 'in-progress', description: '' });
  assert.strictEqual(h.sessionTaskPings().at(-1).tasks['S-live'].title, 'second name', 'a rename reaches the tile');
  assert.strictEqual(entry.task.title, 'first name', 'the stored title is only a fallback, and is not rewritten');

  await h.tools.complete_task.handler({ id });
  assert.strictEqual(tools.sessionTask(entry).status, 'done', 'finishing it does not take it off the session');

  h.call('DELETE /api/tasks/:id', { params: { id: String(id) } });
  assert.deepStrictEqual(tools.sessionTask(entry), { id, title: 'first name', status: 'deleted', description: '' },
    'a deleted task falls back to the title it had when the session took it');
});

test('a second call moves the session, null takes it off, and refusals change nothing', async () => {
  const h = harness();
  const a = await h.addTask('a', 'S-live');
  const b = await h.addTask('b', 'S-live');
  await h.workOn(a, 'S-live');
  await h.workOn(b, 'S-live');
  assert.strictEqual(h.shells.get('S-live').task.id, b, 'one task at a time');

  assert.match(await h.workOn(null, 'S-live'), /not working on a task/);
  assert.strictEqual(h.shells.get('S-live').task, null);
  assert.strictEqual(h.sessionTaskPings().at(-1).tasks['S-live'], null, 'the tile is told to drop it');
  assert.strictEqual(tools.sessionTask(h.shells.get('S-live')), null);

  assert.match(await h.workOn(9999, 'S-live'), /not found/);
  assert.strictEqual(h.shells.get('S-live').task, null);
  assert.match(await h.workOn(a), /Only a Deep Steve session/);
  assert.match(await h.workOn(a, 'S-unknown'), /Only a Deep Steve session/);
});
