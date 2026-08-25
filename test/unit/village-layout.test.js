// Headless unit test for the Village mod's two pure modules:
//
//   mods/village/layout.js — where the town puts things
//   mods/village/data.js   — which sessions belong to which project
//
// Both are deliberately free of three.js, the DOM and any global, which is what
// lets them be driven straight from Node. Everything else in the mod is rendering,
// and is verified by looking at it.
//
// The import style is the one test/unit/session-stores.test.js:38 already uses:
// a CommonJS test `await import()`ing an ES module, which Node resolves by
// detecting module syntax.
//
// Run: node --test test/unit/village-layout.test.js

const { test } = require('node:test');
const assert = require('node:assert');

let mods;
async function load() {
  if (!mods) {
    const layout = await import('../../mods/village/layout.js');
    const data = await import('../../mods/village/data.js');
    const config = await import('../../mods/village/config.js');
    mods = { ...layout, data, LAYOUT: config.LAYOUT, HOUSE_SCHEMES: config.HOUSE_SCHEMES };
  }
  return mods;
}

// ---------------------------------------------------------------- helpers

const projects = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `ctx${from + i}`,
    name: `Project ${from + i}`,
    dirs: [`/repos/p${from + i}`],
    archived: false,
  }));

const positions = (town) => town.plots.map((p) => [round(p.position.x), round(p.position.z)]);
const round = (n) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------- layout

test('every project gets exactly one plot', async () => {
  const m = await load();
  for (const n of [1, 2, 5, 12, 30]) {
    assert.strictEqual(m.buildTown(projects(n)).plots.length, n, `${n} projects`);
  }
});

test('a project with no id is skipped rather than crashing the town', async () => {
  const m = await load();
  const town = m.buildTown([...projects(2), null, {}, { name: 'nameless' }]);
  assert.strictEqual(town.plots.length, 2);
});

test('registering a project APPENDS a house and moves none of the others', async () => {
  // The whole point of generating the layout: adding a project must not reshuffle
  // the town. A curve normalised to the project count would fail this.
  const m = await load();
  const before = m.buildTown(projects(4));
  const after = m.buildTown(projects(5));

  assert.deepStrictEqual(positions(after).slice(0, 4), positions(before));
  assert.strictEqual(after.plots.length, 5);
});

test('the same project list always builds the same town', async () => {
  const m = await load();
  const a = m.buildTown(projects(7));
  const b = m.buildTown(projects(7));
  assert.deepStrictEqual(positions(a), positions(b));
  assert.deepStrictEqual(
    a.plots.map((p) => round(p.rotation)),
    b.plots.map((p) => round(p.rotation)),
  );
  assert.deepStrictEqual(a.spawn, b.spawn);
});

test('houses do not overlap each other', async () => {
  const m = await load();
  const town = m.buildTown(projects(24));
  // Two houses touch if their centres are closer than the diagonal of one.
  const diagonal = Math.hypot(m.LAYOUT.HOUSE_WIDTH, m.LAYOUT.HOUSE_DEPTH);
  for (let i = 0; i < town.plots.length; i++) {
    for (let j = i + 1; j < town.plots.length; j++) {
      const a = town.plots[i].position;
      const b = town.plots[j].position;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      assert.ok(d > diagonal, `plots ${i} and ${j} overlap (${d.toFixed(2)} < ${diagonal.toFixed(2)})`);
    }
  }
});

test('no house is built on the road, and every door faces it', async () => {
  const m = await load();
  const town = m.buildTown(projects(16));
  const halfHouse = m.LAYOUT.HOUSE_DEPTH / 2;

  for (const plot of town.plots) {
    const toLane = m.distanceToLane(town.lane, plot.position.x, plot.position.z);
    assert.ok(toLane > halfHouse + 1, `${plot.ctxId} sits on the lane (${toLane.toFixed(2)}m)`);

    // The door is on the lane-facing wall, so it must be nearer the road than the
    // centre of the house is.
    const doorToLane = m.distanceToLane(town.lane, plot.door.x, plot.door.z);
    assert.ok(doorToLane < toLane, `${plot.ctxId}'s door faces away from the lane`);

    // And the spot you stand on to open it is nearer still.
    const standToLane = m.distanceToLane(town.lane, plot.stand.x, plot.stand.z);
    assert.ok(standToLane < doorToLane, `${plot.ctxId}'s doorstep is behind its door`);
  }
});

test('houses alternate sides of the lane', async () => {
  const m = await load();
  const town = m.buildTown(projects(8));
  const sides = town.plots.map((p) => p.side);
  for (let i = 1; i < sides.length; i++) {
    assert.notStrictEqual(sides[i], sides[i - 1], `plots ${i - 1} and ${i} are on the same side`);
  }
});

test('archived projects go to the outskirts, past every active house', async () => {
  const m = await load();
  const list = [...projects(3), { id: 'old', name: 'Old', dirs: ['/repos/old'], archived: true }];
  const town = m.buildTown(list);

  const archived = town.plots.filter((p) => p.archived);
  const active = town.plots.filter((p) => !p.archived);
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(active.length, 3);

  // Further along the lane than any active house...
  const furthestActive = Math.max(...active.map((p) => p.laneAt));
  assert.ok(archived[0].laneAt > furthestActive, 'archived lot is not past the active houses');
  // ...and set further back from it.
  assert.ok(
    m.distanceToLane(town.lane, archived[0].position.x, archived[0].position.z) >
      m.distanceToLane(town.lane, active[0].position.x, active[0].position.z),
    'archived lot is not set back from the lane',
  );
});

test('showArchived:false leaves archived projects out entirely', async () => {
  const m = await load();
  const list = [...projects(2), { id: 'old', name: 'Old', dirs: [], archived: true }];
  assert.strictEqual(m.buildTown(list, { showArchived: false }).plots.length, 2);
  assert.strictEqual(m.buildTown(list, { showArchived: true }).plots.length, 3);
  // Hiding the archived lot must not move the active houses either.
  assert.deepStrictEqual(
    positions(m.buildTown(list, { showArchived: false })),
    positions(m.buildTown(projects(2))),
  );
});

test('a town with no projects is still a place', async () => {
  // A fresh install has no projects registered. The square, the spawn point and the
  // lane all still have to exist, or the mod opens onto nothing.
  const m = await load();
  const town = m.buildTown([]);
  assert.strictEqual(town.plots.length, 0);
  assert.ok(town.square.radius > 0);
  assert.ok(Number.isFinite(town.spawn.x) && Number.isFinite(town.spawn.z));
  assert.ok(town.lane.pts.length > 2, 'no lane to stand on');
  assert.ok(Number.isFinite(town.bounds.minX) && Number.isFinite(town.bounds.maxZ));
});

test('buildTown tolerates a missing or non-array project list', async () => {
  const m = await load();
  for (const input of [undefined, null, 'nope', 42, {}]) {
    assert.strictEqual(m.buildTown(input).plots.length, 0, String(input));
  }
});

// ---------------------------------------------------------------- house identity

test("a house's look is derived from its project id and never drifts", async () => {
  const m = await load();
  const a = m.houseStyle('ctx-abc', m.HOUSE_SCHEMES.length);
  const b = m.houseStyle('ctx-abc', m.HOUSE_SCHEMES.length);
  assert.deepStrictEqual(a, b, 'same id gave two different houses');

  const other = m.houseStyle('ctx-xyz', m.HOUSE_SCHEMES.length);
  assert.notDeepStrictEqual(a, other, 'two ids gave the identical house');

  assert.ok(a.scheme >= 0 && a.scheme < m.HOUSE_SCHEMES.length, 'scheme index out of range');
});

test('house styles spread across the available schemes', async () => {
  // If the hash collapsed, every house in the town would be the same colour and the
  // "recognise a building at a glance" property would be gone.
  const m = await load();
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(m.houseStyle(`ctx${i}`, m.HOUSE_SCHEMES.length).scheme);
  assert.strictEqual(seen.size, m.HOUSE_SCHEMES.length, 'not every house scheme is reachable');
});

// ---------------------------------------------------------------- membership

test('a session belongs to a project when its cwd is inside one of its dirs', async () => {
  const { data } = await load();
  assert.ok(data.inside('/repos/app', '/repos/app'));
  assert.ok(data.inside('/repos/app/src/deep', '/repos/app'));
  // A trailing slash on the project dir must not change the answer.
  assert.ok(data.inside('/repos/app/src', '/repos/app/'));
  // And a sibling with a shared prefix must not match.
  assert.ok(!data.inside('/repos/app-two', '/repos/app'));
  assert.ok(!data.inside('/elsewhere', '/repos/app'));
  assert.ok(!data.inside('', '/repos/app'));
  assert.ok(!data.inside('/repos/app', ''));
});

test('a worktree under the repo lands in the project for free', async () => {
  // Sessions started with --worktree live at <repo>/.claude/worktrees/<name>, and
  // the prefix rule is the only reason they are grouped with their project.
  const { data } = await load();
  const ctx = { id: 'c', dirs: ['/repos/app'] };
  const sessions = [{ id: 's1', cwd: '/repos/app/.claude/worktrees/github-issue-42' }];
  assert.deepStrictEqual(data.sessionsForProject(ctx, sessions).map((s) => s.id), ['s1']);
});

test('a session with no cwd belongs to no project', async () => {
  // Mod tabs and display tabs are global — context-views.js:188 treats them the
  // same way. Putting them in a house would give every project a phantom resident.
  const { data } = await load();
  const ctx = { id: 'c', dirs: ['/repos/app'] };
  assert.deepStrictEqual(data.sessionsForProject(ctx, [{ id: 'm1', cwd: null }]), []);
  assert.deepStrictEqual(data.sessionsForProject(ctx, [{ id: 'm2' }]), []);
});

test('a project with no dirs claims nothing', async () => {
  const { data } = await load();
  assert.deepStrictEqual(data.sessionsForProject({ id: 'c', dirs: [] }, [{ id: 's', cwd: '/x' }]), []);
  assert.deepStrictEqual(data.sessionsForProject({ id: 'c' }, [{ id: 's', cwd: '/x' }]), []);
});

test('overlapping project dirs do not count one session twice', async () => {
  // `dirs` is a list of independent prefixes with no uniqueness constraint, so a
  // project registered with both a repo and a subfolder of it matches twice. Same
  // trap as docs/scheduled-tasks.md:33.
  const { data } = await load();
  const ctx = { id: 'c', dirs: ['/repos/app', '/repos/app/packages/web'] };
  const sessions = [{ id: 's1', cwd: '/repos/app/packages/web/src' }];
  assert.deepStrictEqual(data.sessionsForProject(ctx, sessions).map((s) => s.id), ['s1']);
});

test('one repo in two projects is listed under both', async () => {
  // The other direction of the same rule: dirs are independent, so this is not a
  // double count, it is two projects that genuinely share a repo.
  const { data } = await load();
  const sessions = [{ id: 's1', cwd: '/repos/shared/src' }];
  for (const id of ['a', 'b']) {
    const ctx = { id, dirs: ['/repos/shared'] };
    assert.deepStrictEqual(data.sessionsForProject(ctx, sessions).map((s) => s.id), ['s1']);
  }
});

// ---------------------------------------------------------------- town model

test('the town model lights a house from the SERVER-wide session list', async () => {
  // /api/shells is every session on the machine; deepsteve.getSessions() is only
  // this browser window's tabs. A house's lights must reflect the real population.
  const { data } = await load();
  const model = data.buildTownModel({
    contexts: [{ id: 'c1', name: 'App', dirs: ['/repos/app'] }],
    shells: [
      { id: 's1', cwd: '/repos/app', status: 'active', waitingForInput: false },
      { id: 's2', cwd: '/repos/app', status: 'closed' },
    ],
    windowSessions: [],
  });
  const entry = model.byCtx.get('c1');
  assert.strictEqual(entry.sessions.length, 1, 'a closed session still lights the house');
  assert.strictEqual(entry.local.length, 0, 'nothing is open in this window');
  assert.strictEqual(entry.elsewhere, 1, 'the running session is not reported as elsewhere');
});

test("the bridge's waiting flag beats a stale REST snapshot", async () => {
  // {type:'state'} reaches only that session's own sockets (server.js:2660), so the
  // 3s /api/shells poll can be behind. The bridge is authoritative for its own tabs.
  const { data } = await load();
  const model = data.buildTownModel({
    contexts: [{ id: 'c1', dirs: ['/repos/app'] }],
    shells: [{ id: 's1', cwd: '/repos/app', status: 'active', waitingForInput: false }],
    windowSessions: [{ id: 's1', cwd: '/repos/app', waitingForInput: true, type: 'terminal' }],
  });
  const entry = model.byCtx.get('c1');
  assert.strictEqual(entry.waiting.length, 1, 'the live waiting flag was ignored');
  assert.strictEqual(entry.local.length, 1, 'the session is open here but not marked local');
  assert.strictEqual(entry.elsewhere, 0);
  assert.deepStrictEqual(model.waiting.map((s) => s.id), ['s1']);
});

test('a tab the server list has not caught up with still appears', async () => {
  const { data } = await load();
  const model = data.buildTownModel({
    contexts: [{ id: 'c1', dirs: ['/repos/app'] }],
    shells: [],
    windowSessions: [{ id: 'fresh', cwd: '/repos/app/src', type: 'terminal' }],
  });
  assert.deepStrictEqual(model.byCtx.get('c1').sessions.map((s) => s.id), ['fresh']);
});

test('mod tabs and display tabs are not residents', async () => {
  const { data } = await load();
  const model = data.buildTownModel({
    contexts: [{ id: 'c1', dirs: ['/repos/app'] }],
    shells: [],
    windowSessions: [
      { id: 'm1', cwd: '/repos/app', type: 'mod-tab' },
      { id: 'p1', cwd: '/repos/app', type: 'project-mod' },
    ],
  });
  assert.strictEqual(model.byCtx.get('c1').sessions.length, 0);
});

test('the notice board is stable between polls', async () => {
  // The board is redrawn on every poll; if the order moved, the notices would
  // visibly shuffle three times a second.
  const { data } = await load();
  const build = (order) => data.buildTownModel({
    contexts: [{ id: 'c1', dirs: ['/repos/app'] }],
    shells: order.map((id) => ({ id, cwd: '/repos/app', status: 'active', waitingForInput: true })),
    windowSessions: [],
  }).waiting.map((s) => s.id);

  assert.deepStrictEqual(build(['s3', 's1', 's2']), build(['s1', 's2', 's3']));
});

// ---------------------------------------------------------------- mailboxes

test('unread chat raises the flag only on the project that sent it', async () => {
  const { data } = await load();
  const sessionsByCtx = new Map([
    ['c1', [{ id: 's1', name: 'builder' }]],
    ['c2', [{ id: 's2', name: 'docs' }]],
  ]);
  const channels = {
    general: {
      messages: [
        { id: 1, sender: 'builder', text: 'read already' },
        { id: 2, sender: 'builder', text: 'new' },
        { id: 3, sender: 'docs', text: 'new' },
      ],
    },
  };
  const counts = data.unreadByProject(channels, { general: 1 }, sessionsByCtx);
  assert.strictEqual(counts.get('c1'), 1);
  assert.strictEqual(counts.get('c2'), 1);
});

test('a sender matching no session raises no flag at all', async () => {
  // Agent Chat channels are global and carry no project field, so an unattributable
  // message must raise nothing rather than raising every mailbox in town.
  const { data } = await load();
  const sessionsByCtx = new Map([['c1', [{ id: 's1', name: 'builder' }]]]);
  const channels = { general: { messages: [{ id: 9, sender: 'someone-else' }] } };
  assert.strictEqual(data.unreadByProject(channels, {}, sessionsByCtx).size, 0);
});

test('read marks are the per-channel high-water mark', async () => {
  const { data } = await load();
  const channels = {
    a: { messages: [{ id: 1 }, { id: 4 }] },
    b: { messages: [] },
  };
  assert.deepStrictEqual(data.highWaterMarks(channels), { a: 4 });
  assert.deepStrictEqual(data.highWaterMarks(null), {});
});

test('unreadByProject copes with an absent channel set', async () => {
  const { data } = await load();
  assert.strictEqual(data.unreadByProject(null, {}, new Map()).size, 0);
  assert.strictEqual(data.unreadByProject({}, null, new Map()).size, 0);
});
