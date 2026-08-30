// Unit test for mods/workshop/tools.js — the derived blocked items and the three
// answer paths (#660).
//
// Why this exists as a UNIT test rather than only an integration one: the riskiest
// code in Workshop is the key dance that answers a live dialog, and its failure mode
// is pressing the wrong button in someone's real session. That has to be driven
// through every branch — cursor already correct, cursor above, cursor below, dialog
// swapped underneath us, cursor refuses to move, session dies mid-dance — and an
// integration suite can only reach the happy path plus whatever it can stage.
//
// tools.js requires only zod, project-scope, inbox and dialog-parse: no node-pty, no
// server.js, no PTY. So a fake ctx is enough, and this runs in the bare `unit` CI job.
//
// The fake terminal is the interesting part. It models the ONE rule that makes this
// hard: Ink recognizes a control byte only when it arrives as its own stdin read, so
// the fake moves its cursor per write() and the test asserts the writes were separate.
//
// HOME is repointed before the require, exactly as in workshop-inbox.test.js, because
// inbox.js persists under stateDir().
//
// Run: node --test test/unit/workshop-tools.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workshop-tools-'));
process.env.HOME = SCRATCH;
delete process.env.DEEPSTEVE_HOME;

// A real directory, because project resolution is real: canonicalRoot() stats the
// path and returns '' for one that does not exist, so a made-up /repo/deepsteve would
// make every row say "No project" and quietly prove nothing about the scoping.
const PROJECT_DIR = path.join(SCRATCH, 'deepsteve');
fs.mkdirSync(PROJECT_DIR, { recursive: true });

const workshop = require('../../mods/workshop/tools.js');
const inbox = require('../../mods/workshop/inbox.js');

// ── fakes ────────────────────────────────────────────────────────────────────

const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const ENTER = '\r';

/**
 * A permission dialog that actually responds to arrow keys, one key per write.
 * `swapOnFirstKey` re-labels the options the moment we touch it, standing in for the
 * dialog being replaced between the poll that drew the card and the click.
 */
class FakeDialog {
  constructor(labels, { cursor = 0, swapOnFirstKey = null, frozen = false } = {}) {
    this.labels = labels;
    this.cursor = cursor;
    this.swapOnFirstKey = swapOnFirstKey;
    this.frozen = frozen;       // ignores arrow keys — the cursor-did-not-land case
    this.selected = null;
    this.writes = [];
  }

  key(byte) {
    this.writes.push(byte);
    if (this.swapOnFirstKey) { this.labels = this.swapOnFirstKey; this.swapOnFirstKey = null; }
    if (byte === ENTER) { this.selected = this.cursor; return; }
    if (this.frozen) return;
    if (byte === KEY_DOWN) this.cursor = Math.min(this.labels.length - 1, this.cursor + 1);
    if (byte === KEY_UP) this.cursor = Math.max(0, this.cursor - 1);
  }

  render() {
    if (this.selected !== null) {
      // Answered: Claude Code repaints a composer underneath, which is what makes the
      // row disappear from the inbox with no leftover.
      return ['⏺ Proceeding.', '─'.repeat(60), '❯', '─'.repeat(60), '? for shortcuts'];
    }
    return [
      'deepsteve - read_session_screen (MCP)',
      'Do you want to proceed?',
      ...this.labels.map((l, i) => `${i === this.cursor ? '❯' : ' '} ${i + 1}. ${l}`),
      'Esc to cancel · Tab to amend',
    ];
  }
}

class FakeScreen {
  constructor(dialog) { this.dialog = dialog; }
  linesSync(n) { const l = this.dialog.render(); return l.slice(-n); }
  async lines(n) { return this.linesSync(n); }
}

function makeEntry(id, dialog, over = {}) {
  const entry = {
    name: 'fix-660',
    cwd: PROJECT_DIR,
    worktree: null,
    agentType: 'claude',
    waitingForInput: true,
    killed: false,
    lastActivity: Date.now(),
    outputSeq: 1,
    _dialog: dialog,
    terminalScreen: dialog ? new FakeScreen(dialog) : null,
    engine: {
      write(_id, bytes) {
        // Each control byte must arrive as its own write. Anything batched would not
        // be seen as a key by Ink, and would not be seen as one here either.
        assert.ok(
          bytes === KEY_UP || bytes === KEY_DOWN || bytes === ENTER,
          `Workshop wrote ${JSON.stringify(bytes)} — only single control keys belong on `
          + 'this path; batching them into one write is exactly what Ink does not see',
        );
        entry._dialog.key(bytes);
        entry.outputSeq++;
      },
    },
    ...over,
  };
  return entry;
}

/** Collects the routes registerRoutes installs and lets the test call them. */
class FakeApp {
  constructor() { this.routes = new Map(); }
  get(p, h) { this.routes.set('GET ' + p, h); }
  post(p, h) { this.routes.set('POST ' + p, h); }
  async call(method, route, { params = {}, query = {}, body = {} } = {}) {
    const handler = this.routes.get(method + ' ' + route);
    assert.ok(handler, `no handler registered for ${method} ${route}`);
    let code = 200;
    let payload;
    let done;
    const finished = new Promise((r) => { done = r; });
    const res = {
      status(c) { code = c; return res; },
      json(p) { payload = p; done(); return res; },
    };
    await handler({ params, query, body }, res);
    await finished;
    return { status: code, body: payload };
  }
}

function makeCtx(shells) {
  return {
    shells,
    log: () => {},
    sessionPaths: (e) => ({ repoRoot: e.cwd, worktree: e.worktree }),
    sessionInputState: () => 'idle',
    getDefaultEngine: () => null,
    deliverPromptWhenReady: (id, prompt, opts) => {
      ctxDeliveries.push({ id, prompt, opts });
    },
  };
}

let ctxDeliveries = [];

/** Fresh world per test: new shells map, new app, and the tool handlers rebound. */
function world() {
  ctxDeliveries = [];
  const shells = new Map();
  const ctx = makeCtx(shells);
  const app = new FakeApp();
  const tools = workshop.init(ctx);
  workshop.registerRoutes(app, ctx);
  return { shells, ctx, app, tools };
}

// Session ids must be unique across the whole file: tools.js caches scrapes per
// session id in module scope, and reusing one would serve a stale screen.
let nextSession = 0;
const sid = () => 'sess' + (++nextSession);

const extraFor = (id) => ({
  requestInfo: { url: { searchParams: new URLSearchParams({ shellId: id }) } },
});
const said = (result) => result.content[0].text;

// findLast, not find: the inbox is module state shared by every test in this file, so
// two tests using the same headline would otherwise both operate on the first one's
// item — whose session is long gone by then.
const itemNamed = (headline) => {
  const found = inbox.all().findLast((i) => i.headline === headline);
  assert.ok(found, `no inbox item headlined ${JSON.stringify(headline)}`);
  return found;
};

// ── derived blocked items ────────────────────────────────────────────────────

test('a session on a permission dialog appears with its question and options', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes', "Yes, and don't ask again", 'No'])));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const row = body.items.find((i) => i.id === 'blocked:' + id);
  assert.ok(row, 'the blocked session must be listed');
  assert.strictEqual(row.kind, 'blocked');
  assert.strictEqual(row.urgency, 'blocking');
  assert.strictEqual(row.question, 'Do you want to proceed?');
  assert.deepStrictEqual(row.options.map((o) => o.label), ['Yes', "Yes, and don't ask again", 'No']);
  assert.strictEqual(row.cursorIndex, 0);
  assert.strictEqual(row.answerable, true);
  assert.strictEqual(row.pendingPath, 'dialog');
  assert.strictEqual(
    row.headline, 'deepsteve - read_session_screen (MCP)',
    'the row subject must be the tool banner, not the identical "Do you want to proceed?"',
  );
  assert.strictEqual(row.sessionName, 'fix-660');
  assert.strictEqual(row.projectName, 'deepsteve');
});

test('an idle session at its composer is NOT in the inbox', async () => {
  // The membership rule that matters: waitingForInput is true here too, because
  // sessionInputState calls an empty composer "idle" exactly like a dialog.
  const { shells, app } = world();
  const id = sid();
  const entry = makeEntry(id, null);
  entry.terminalScreen = {
    linesSync: () => ['⏺ Done.', '─'.repeat(60), '❯', '─'.repeat(60), '? for shortcuts'],
    lines: async () => entry.terminalScreen.linesSync(),
  };
  shells.set(id, entry);

  const { body } = await app.call('GET', '/api/workshop/inbox');
  assert.deepStrictEqual(
    body.items, [],
    'without a positive dialog gate every agent that finished its turn is an inbox row',
  );
});

test('sessions with no emulator, killed, or tmux-attach are skipped', async () => {
  const { shells, app } = world();
  const noScreen = sid(); shells.set(noScreen, makeEntry(noScreen, null));
  const dead = sid();
  shells.set(dead, makeEntry(dead, new FakeDialog(['Yes', 'No']), { killed: true }));
  const attach = sid();
  shells.set(attach, makeEntry(attach, new FakeDialog(['Yes', 'No']), { agentType: 'tmux-attach' }));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  assert.deepStrictEqual(body.items, []);
});

test('a resolved dialog leaves the inbox on the next poll, with no tombstone', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No']);
  shells.set(id, makeEntry(id, dialog));

  assert.strictEqual((await app.call('GET', '/api/workshop/inbox')).body.items.length, 1);

  // Answered in the terminal by the human, not through Workshop.
  shells.get(id).engine.write(id, ENTER);

  const { body } = await app.call('GET', '/api/workshop/inbox');
  assert.deepStrictEqual(body.items, [], 'derived rows are computed per request — nothing to reconcile');
});

test('an unparseable dialog stays listed but is not answerable', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes']);       // one option — detectable, unreadable
  shells.set(id, makeEntry(id, dialog));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const row = body.items[0];
  assert.ok(row, 'a blocked session we cannot read is still a blocked session');
  assert.strictEqual(row.answerable, false);
  assert.ok(Array.isArray(row.preview) && row.preview.length, 'the card falls back to a raw preview');
});

// ── path 3: answering a live dialog ──────────────────────────────────────────

test('answering moves the cursor the right way and commits', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', "Yes, and don't ask", 'No']);   // cursor on 0
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id },
    body: { optionIndex: 2 },
  });

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.steps, 2);
  assert.strictEqual(r.body.direction, 'Down');
  assert.strictEqual(dialog.selected, 2, 'option 3 must be the one committed');
  assert.deepStrictEqual(
    dialog.writes, [KEY_DOWN, KEY_DOWN, ENTER],
    'two Downs and an Enter, each its own write',
  );
});

test('answering upward walks the other way', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'Maybe', 'No'], { cursor: 2 });
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 0 },
  });
  assert.strictEqual(r.body.direction, 'Up');
  assert.deepStrictEqual(dialog.writes, [KEY_UP, KEY_UP, ENTER]);
  assert.strictEqual(dialog.selected, 0);
});

test('the cursor already on target sends Enter alone', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No'], { cursor: 1 });
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 1 },
  });
  assert.strictEqual(r.body.steps, 0);
  assert.deepStrictEqual(dialog.writes, [ENTER]);
});

test('a cursor that refuses to move sends NO Enter', async () => {
  // The whole point of verify-before-commit. An unverified Enter commits an unknown
  // option in a live session.
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No'], { frozen: true });
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 1 },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.reason, 'cursor-did-not-land');
  assert.strictEqual(dialog.selected, null, 'nothing may be committed');
  assert.ok(!dialog.writes.includes(ENTER), 'Enter must never be sent unverified');
  assert.ok(
    !dialog.writes.includes('\x1b'),
    'and we must not "restore" with Escape — Escape cancels the dialog, which is a '
    + 'decision the human did not make',
  );
});

test('a dialog swapped before the click is refused before any key is sent', async () => {
  const { shells, app } = world();
  const id = sid();
  // The human saw Yes/No and clicked "No". By the time the POST lands, that dialog is
  // gone and a Delete/Keep one with the same option count is up in its place.
  const dialog = new FakeDialog(['Delete', 'Keep']);
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id },
    body: { optionIndex: 1, expect: 'no' },   // the fingerprint of what was clicked
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(
    r.body.reason, 'dialog-changed',
    'an index alone would happily press "Keep" here — the fingerprint is what stops it',
  );
  assert.deepStrictEqual(dialog.writes, [], 'not one key may be sent');
});

test('a dialog swapped MID-dance is caught by the second check, before Enter', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No'], { swapOnFirstKey: ['Delete', 'Keep'] });
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 1, expect: 'no' },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(
    r.body.reason, 'dialog-changed',
    'the cursor DID land on index 1, so this is not "cursor-did-not-land" — the row '
    + 'under it is simply no longer the row the human clicked, and retrying is wrong',
  );
  assert.strictEqual(dialog.selected, null);
  assert.ok(!dialog.writes.includes(ENTER), 'Enter must not be sent into the new dialog');
});

test('the expect fingerprint passes when the dialog is unchanged', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No']);
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 1, expect: 'no' },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(dialog.selected, 1);
});

test('a session that dies mid-dance aborts with no orphaned Enter', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['a', 'b', 'c', 'd']);
  const entry = makeEntry(id, dialog);
  const realWrite = entry.engine.write;
  let keys = 0;
  entry.engine.write = (i, b) => {
    realWrite(i, b);
    if (++keys === 1) shells.delete(id);   // gone after the first key
  };
  shells.set(id, entry);

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 3 },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.reason, 'session-gone');
  assert.strictEqual(dialog.selected, null);
});

test('free text against a live dialog is refused with a way forward', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No']);
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { text: 'do the second one please' },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'text-not-answerable');
  assert.match(r.body.hint, /open the tab/i, 'the refusal must say what to do instead');
  assert.deepStrictEqual(dialog.writes, []);
});

test('a live dialog cannot be dismissed', async () => {
  const { app } = world();
  const r = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'blocked:whatever' },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'not-dismissible');
});

test('answering a session that is already gone is a 404, not a crash', async () => {
  const { app } = world();
  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:vanished' }, body: { optionIndex: 0 },
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'session-gone');
});

// ── paths 1 and 2: stored items ──────────────────────────────────────────────

test('workshop_ask returns at once and tells the agent to end its turn', async () => {
  const { shells, tools } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));

  const out = said(await tools.workshop_ask.handler({
    question: 'Which retry policy?',
    options: [{ label: 'Exponential' }, { label: 'Fixed' }],
    recommendation: 'Exponential — the API rate-limits.',
    urgency: 'blocking',
  }, extraFor(id)));

  assert.match(out, /is on the Workshop inbox/);
  assert.match(out, /end your turn now rather than polling/);
});

test('an asked question carries session, project and worktree the agent never supplied', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null, { name: 'fix-641', worktree: 'wt-641' }));
  await tools.workshop_ask.handler({ question: 'Ship it?' }, extraFor(id));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const row = body.items.find((i) => i.headline === 'Ship it?');
  assert.ok(row);
  assert.strictEqual(row.sessionId, id);
  assert.strictEqual(row.sessionName, 'fix-641');
  assert.strictEqual(row.worktree, 'wt-641');
  assert.strictEqual(row.projectName, 'deepsteve');
  assert.strictEqual(row.pendingPath, 'prompt', 'the agent is idle, so the answer arrives as a prompt');
});

test('answering an idle agent goes through the prompt FIFO, with attribution', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));
  await tools.workshop_ask.handler({
    question: 'Which retry policy?',
    options: [{ label: 'Exponential' }, { label: 'Fixed' }],
  }, extraFor(id));

  const item = itemNamed('Which retry policy?');
  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { optionIndex: 1, text: 'keep it simple' },
  });

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.deliveredVia, 'prompt');
  assert.strictEqual(ctxDeliveries.length, 1);
  const [delivery] = ctxDeliveries;
  assert.strictEqual(delivery.id, id);
  assert.match(delivery.prompt, /^\[Workshop\] Re: Which retry policy\?/);
  assert.match(delivery.prompt, /Fixed/);
  assert.match(delivery.prompt, /keep it simple/);
  assert.strictEqual(
    delivery.opts.source, 'workshop',
    'source is what gives the write an author in the rc-write log',
  );
  assert.strictEqual(typeof delivery.opts.skipIf, 'function');
  assert.strictEqual(delivery.opts.skipIf(id), false);
});

test('an agent holding inside workshop_ask is resolved with NO PTY write at all', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));

  const pending = tools.workshop_ask.handler({
    question: 'Proceed with the migration?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    wait_seconds: 30,
  }, extraFor(id));

  // Let the handler reach its hold.
  await new Promise((r) => setImmediate(r));
  const item = itemNamed('Proceed with the migration?');
  assert.ok(item, 'the item is on the inbox while the agent holds');

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { optionIndex: 0 },
  });
  assert.strictEqual(r.body.deliveredVia, 'inline');
  assert.strictEqual(ctxDeliveries.length, 0, 'nothing is written to the PTY on this path');
  assert.match(said(await pending), /^Answer to #\d+: Yes$/);
});

test('a hold that timed out degrades to the prompt path', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));

  const out = said(await tools.workshop_ask.handler({
    question: 'Quick yes?', options: [{ label: 'Yes' }], wait_seconds: 1,
  }, extraFor(id)));
  assert.match(out, /end your turn now rather than polling/, 'the fallback message, not an error');

  const item = itemNamed('Quick yes?');
  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { optionIndex: 0 },
  });
  assert.strictEqual(r.body.deliveredVia, 'prompt');
});

test('answering a question whose session is gone says so instead of swallowing it', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));
  await tools.workshop_ask.handler({ question: 'Still there?' }, extraFor(id));
  shells.delete(id);

  const item = itemNamed('Still there?');
  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { text: 'yes' },
  });
  assert.strictEqual(r.body.deliveredVia, 'undelivered');
  assert.strictEqual(ctxDeliveries.length, 0);
});

test('the second window to answer a stored item gets 409 and changes nothing', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));
  await tools.workshop_ask.handler({
    question: 'Race me', options: [{ label: 'A' }, { label: 'B' }],
  }, extraFor(id));

  const item = itemNamed('Race me');
  const first = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { optionIndex: 0 },
  });
  assert.strictEqual(first.status, 200);
  const second = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { optionIndex: 1 },
  });
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.body.error, 'not-open');
  assert.strictEqual(item.answer.optionLabel, 'A', 'the first writer wins');
});

// ── briefings and workshop_check ─────────────────────────────────────────────

test('a briefing needs no answer and archives', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));
  await tools.workshop_brief.handler({ headline: 'Deployed v0.24 to staging', tag: 'release' }, extraFor(id));

  const item = itemNamed('Deployed v0.24 to staging');
  assert.strictEqual(item.kind, 'briefing');
  assert.strictEqual(item.urgency, 'fyi');

  const bad = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { text: 'ok' },
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'not-answerable');

  const ok = await app.call('POST', '/api/workshop/items/:id/dismiss', { params: { id: item.id } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.item.status, 'dismissed');
});

test('workshop_check reports open, answered and archived, and keeps discouraging polling', async () => {
  const { shells, tools } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));
  await tools.workshop_ask.handler({
    question: 'Checkable?', options: [{ label: 'Yes' }],
  }, extraFor(id));
  const item = itemNamed('Checkable?');

  const open = said(await tools.workshop_check.handler({ ticket: String(item.seq) }));
  assert.match(open, /still open/);
  assert.match(
    open, /end your turn/,
    'workshop_check enables the poll loop workshop_ask forbids, so it must keep saying so',
  );

  inbox.applyAnswer(item, { optionIndex: 0 });
  assert.match(said(await tools.workshop_check.handler({ ticket: '#' + item.seq })), /^Answer to #\d+: Yes$/);
  assert.match(said(await tools.workshop_check.handler({ ticket: 'w' + item.seq })), /^Answer to #\d+: Yes$/);
  assert.match(said(await tools.workshop_check.handler({ ticket: 'nonsense' })), /not a ticket number/);
  assert.match(said(await tools.workshop_check.handler({ ticket: '999999' })), /no Workshop item/);
});

// ── listing hygiene ──────────────────────────────────────────────────────────

test('the inbox lists open items only, unless asked for the archive', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, null));
  await tools.workshop_ask.handler({ question: 'Archive me' }, extraFor(id));
  const item = itemNamed('Archive me');
  await app.call('POST', '/api/workshop/items/:id/dismiss', { params: { id: item.id } });

  const open = await app.call('GET', '/api/workshop/inbox');
  assert.ok(!open.body.items.some((i) => i.id === item.id));
  const all = await app.call('GET', '/api/workshop/inbox', { query: { all: '1' } });
  assert.ok(all.body.items.some((i) => i.id === item.id));
});

test('blocked rows sort ahead of a normal question', async () => {
  const { shells, tools, app } = world();
  const asked = sid();
  shells.set(asked, makeEntry(asked, null));
  await tools.workshop_ask.handler({ question: 'Not urgent' }, extraFor(asked));

  const blocked = sid();
  shells.set(blocked, makeEntry(blocked, new FakeDialog(['Yes', 'No'])));

  // Relative order of this test's own two rows: the inbox is module state, so earlier
  // tests have left open items of their own in front of both.
  const { body } = await app.call('GET', '/api/workshop/inbox');
  const ids = body.items.map((i) => i.id);
  const blockedAt = ids.indexOf('blocked:' + blocked);
  const askedAt = ids.indexOf(itemNamed('Not urgent').id);
  assert.ok(blockedAt >= 0 && askedAt >= 0, 'both rows must be listed');
  assert.ok(
    blockedAt < askedAt,
    'a derived blocked row is urgency "blocking" and must outrank a normal question',
  );
});

test('the screen endpoint returns live preview lines for a blocked session', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes', 'No'])));
  const r = await app.call('GET', '/api/workshop/items/:id/screen', {
    params: { id: 'blocked:' + id },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.lines.some((l) => l.includes('Do you want to proceed?')));
  assert.strictEqual(r.body.state, 'idle');
});
