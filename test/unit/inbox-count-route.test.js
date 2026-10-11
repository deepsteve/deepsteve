// Unit test for GET /api/inbox/count — the App bar's badge (#718).
//
// The badge says something is waiting on you NOW, and the one way it can go wrong silently is
// by disagreeing with the Inbox itself: a red 2 on the rail and an empty list inside. So the
// core assertion here is agreement — for the same query, /count is the length of /items — on a
// fake ctx holding the cases that used to inflate it: a tab that merely finished its turn, a
// briefing, and posts whose session closed long ago.
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
const dialogParse = require('../../dialog-parse');
const projectScope = require('../../project-scope');

// Real directories, because projectFilter canonicalises the query through the filesystem.
const REPO_A = path.join(HOME, 'repo-a');
const REPO_B = path.join(HOME, 'repo-b');
fs.mkdirSync(REPO_A, { recursive: true });
fs.mkdirSync(REPO_B, { recursive: true });
const A = projectScope.canonicalRoot(REPO_A);
const B = projectScope.canonicalRoot(REPO_B);

const COMPOSER = ['⏺ Done.', '─'.repeat(60), '❯', '─'.repeat(60), '? for shortcuts'];
const DIALOG = [
  'Bash(git push)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No',
  'Esc to cancel · Tab to amend',
];

function tab(cwd, screen) {
  return {
    cwd, agentType: 'claude', scrollback: [], outputSeq: 1, waitingForInput: true,
    terminalScreen: { linesSync: (n) => screen.slice(-n) },
    // What server.js's readAsking would have set for this screen.
    asking: dialogParse.askingSummary(screen),
  };
}

function harness() {
  const shells = new Map([
    ['S-a', tab(REPO_A, COMPOSER)],     // finished its turn: not asking
    ['S-b', tab(REPO_B, COMPOSER)],
    ['S-ask', tab(REPO_A, DIALOG)],     // asking
  ]);
  const ctx = {
    shells,
    log: () => {},
    getSavedSession: () => null,
    getContexts: () => [],
    sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd }),
    sessionInputState: () => 'idle',
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

function seed() {
  for (const i of [...inbox.all()]) inbox.applyDismiss(i, 'archived');
  inbox.add({ kind: 'question', headline: 'Which retry policy?', sessionId: 'S-a', project: A });
  inbox.add({ kind: 'result', headline: 'Fixed the flake', sessionId: 'S-a', project: A });
  inbox.add({ kind: 'briefing', headline: 'Plan', sessionId: 'S-b', project: B });
  const closed = inbox.add({ kind: 'question', headline: 'Already answered', sessionId: 'S-b', project: B });
  inbox.applyAnswer(closed, { text: 'yes' });
  // Two days old, from a scheduled run whose session closed: the rows that made the badge lie.
  const gone = [
    inbox.add({ kind: 'result', headline: 'Weekly report', sessionId: 'S-gone', project: B }),
    inbox.add({ kind: 'question', headline: 'Anything to follow up?', sessionId: 'S-gone', project: B, durableDays: 7 }),
  ];
  return { goneIds: gone.map((i) => i.id) };
}

test('the scratch HOME really took — this suite must not touch a real inbox', () => {
  assert.ok(inbox.inboxFile().startsWith(HOME), `inbox file resolved to ${inbox.inboxFile()}`);
});

test('the badge is the length of the list', () => {
  seed();
  const h = harness();
  const rows = h.items({});
  assert.deepStrictEqual(
    rows.map((r) => r.headline).sort(),
    ['Bash(git push)', 'Fixed the flake', 'Which retry policy?'],
    'the asking tab, and the open question and result from a live session — nothing else',
  );
  assert.strictEqual(h.count({}), rows.length);
});

test('a post whose session has gone is not counted, but is kept', () => {
  const { goneIds } = seed();
  const h = harness();
  assert.ok(!h.items({}).some((r) => r.sessionId === 'S-gone'));
  const archive = h.items({ all: '1' });
  for (const id of goneIds) {
    const item = archive.find((r) => r.id === id);
    assert.ok(item, `${id} is still in the store`);
    assert.strictEqual(item.status, 'open', 'and still answerable through its link');
  }
});

test('a finished tab and a briefing are not counted', () => {
  seed();
  const h = harness();
  const rows = h.items({});
  assert.ok(!rows.some((r) => r.sessionId === 'S-b'), 'S-b has only a briefing and a finished turn');
  assert.ok(!rows.some((r) => r.kind === 'briefing'));
});

test('it is scoped by the same project picker the list is', () => {
  seed();
  const h = harness();
  for (const projects of [A, B, `${A},${B}`]) {
    assert.strictEqual(h.count({ projects }), h.items({ projects }).length, projects);
  }
  assert.strictEqual(h.count({ projects: A }), 3);
  assert.strictEqual(h.count({ projects: B }), 0);
});

test('an item archived from the panel leaves the badge on the next poll', () => {
  seed();
  const h = harness();
  inbox.applyDismiss(inbox.all().find((i) => i.headline === 'Which retry policy?' && i.status === 'open'), 'archived');
  assert.strictEqual(h.count({}), 2);
  assert.strictEqual(h.count({}), h.items({}).length);
});
