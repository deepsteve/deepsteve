// Unit test for GET /api/inbox/count — the App bar's badge (#718).
//
// The badge exists so you can tell something is waiting in the Inbox without opening it, and
// the one way it can go wrong silently is by disagreeing with the Inbox itself: a red 2 on the
// rail and an empty list inside. So the core assertion here is agreement — for the same query,
// /count equals the stored rows /items would list — with live sessions on the fake ctx, so the
// derived rows /items also returns (one per tab) are present and provably NOT counted.
//
// Same harness shape as inbox-chat-routes.test.js: the mod's own routes on a fake express app
// and a fake ctx, no daemon, no PTY — it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/inbox-count-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-inbox-count-'));
process.env.HOME = HOME;
process.env.DEEPSTEVE_HOME = path.join(HOME, '.deepsteve');

const tools = require('../../mods/inbox/tools.js');
const inbox = require('../../mods/inbox/inbox.js');
const projectScope = require('../../project-scope');

// Real directories, because projectFilter canonicalises the query through the filesystem.
const REPO_A = path.join(HOME, 'repo-a');
const REPO_B = path.join(HOME, 'repo-b');
fs.mkdirSync(REPO_A, { recursive: true });
fs.mkdirSync(REPO_B, { recursive: true });
const A = projectScope.canonicalRoot(REPO_A);
const B = projectScope.canonicalRoot(REPO_B);

function harness() {
  const shells = new Map();
  const screen = ['> ', '? for shortcuts'];
  // Two live tabs, one per project. Each makes /items add a derived row of its own.
  for (const [id, cwd] of [['S-a', REPO_A], ['S-b', REPO_B]]) {
    shells.set(id, {
      cwd, agentType: 'claude', scrollback: [], outputSeq: 1,
      terminalScreen: { linesSync: () => screen },
    });
  }
  const ctx = {
    shells,
    log: () => {},
    getSavedSession: () => null,
    getContexts: () => [],
    sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd }),
    sessionInputState: () => 'busy',
  };

  const routes = {};
  const app = {
    get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; },
  };
  tools.init(ctx);
  tools.registerRoutes(app, ctx);

  const call = (key, query = {}) => {
    let out = null;
    routes[key]({ params: {}, query, body: {} }, {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(v) { out = { status: this.statusCode, body: v }; return this; },
    });
    return out;
  };
  return {
    items: (query) => call('GET /api/inbox/items', query).body.items,
    count: (query) => call('GET /api/inbox/count', query).body.count,
  };
}

/** The rows /items returns that came from the store — what the badge promises to count. */
const storedRows = (rows) => rows.filter((r) => inbox.isItemId(r.id));

function seed() {
  for (const i of [...inbox.all()]) inbox.applyDismiss(i, 'archived');
  inbox.add({ kind: 'question', headline: 'Which retry policy?', sessionId: 'S-a', project: A });
  inbox.add({ kind: 'result', headline: 'Fixed the flake', sessionId: 'S-a', project: A });
  inbox.add({ kind: 'briefing', headline: 'Plan', sessionId: 'S-b', project: B });
  const closed = inbox.add({ kind: 'question', headline: 'Already answered', sessionId: 'S-b', project: B });
  inbox.applyAnswer(closed, { text: 'yes' });
}

test('the scratch HOME really took — this suite must not touch a real inbox', () => {
  assert.ok(inbox.inboxFile().startsWith(HOME), `inbox file resolved to ${inbox.inboxFile()}`);
});

test('the count is the stored items only — never one per open tab', () => {
  seed();
  const h = harness();
  const rows = h.items({});
  assert.ok(rows.length > storedRows(rows).length, 'the fixture really has derived session rows');
  assert.strictEqual(h.count({}), 3);
  assert.strictEqual(h.count({}), storedRows(rows).length, 'the badge and the list agree');
});

test('it is scoped by the same project picker the list is', () => {
  seed();
  const h = harness();
  for (const projects of [A, B, `${A},${B}`]) {
    assert.strictEqual(h.count({ projects }), storedRows(h.items({ projects })).length, projects);
  }
  assert.strictEqual(h.count({ projects: A }), 2);
  assert.strictEqual(h.count({ projects: B }), 1);
});

test('briefings=0 drops briefings, for a panel with showBriefings off', () => {
  seed();
  const h = harness();
  assert.strictEqual(h.count({ briefings: '0' }), 2);
  assert.strictEqual(h.count({ briefings: '1' }), 3);
});

test('an item archived from the panel leaves the badge on the next poll', () => {
  seed();
  const h = harness();
  const open = inbox.all().filter((i) => i.status === 'open');
  inbox.applyDismiss(open[0], 'archived');
  assert.strictEqual(h.count({}), 2);
  assert.strictEqual(h.count({}), storedRows(h.items({})).length);
});
