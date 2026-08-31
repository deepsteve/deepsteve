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

// #669 fixtures: a screenshot store the fake ctx points at, an image inside the
// project, and one outside it that share_result must refuse to attach.
const SHOTS_DIR = path.join(SCRATCH, 'shots');
const OUTSIDE_DIR = path.join(SCRATCH, 'outside');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
fs.writeFileSync(path.join(PROJECT_DIR, 'shot.png'), TINY_PNG);
fs.writeFileSync(path.join(OUTSIDE_DIR, 'secret.png'), TINY_PNG);

const workshop = require('../../mods/workshop/tools.js');
const inbox = require('../../mods/workshop/inbox.js');
const fx = require('./fixtures/workshop-dialogs.js');

// ── fakes ────────────────────────────────────────────────────────────────────

const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const ENTER = '\r';

/**
 * A permission dialog that actually responds to arrow keys, one key per write.
 * `swapOnFirstKey` re-labels the options the moment we touch it, standing in for the
 * dialog being replaced between the poll that drew the card and the click.
 *
 * `divider` draws the rule a real AskUserQuestion puts above its escape hatches (#664).
 * It is decoration, not a row: the cursor arithmetic below stays over the flat `labels`
 * array, which is exactly how the real TUI treats it. Opt-in, so no existing test moves.
 */
class FakeDialog {
  constructor(labels, { cursor = 0, swapOnFirstKey = null, frozen = false, divider = false } = {}) {
    this.labels = labels;
    this.cursor = cursor;
    this.swapOnFirstKey = swapOnFirstKey;
    this.frozen = frozen;       // ignores arrow keys — the cursor-did-not-land case
    this.divider = divider;
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
    const rows = [];
    this.labels.forEach((l, i) => {
      if (this.divider && i === this.labels.length - 1) rows.push('─'.repeat(60));
      rows.push(`${i === this.cursor ? '❯' : ' '} ${i + 1}. ${l}`);
    });
    return [
      'deepsteve - read_session_screen (MCP)',
      'Do you want to proceed?',
      ...rows,
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
      // The images route (#669) ends with sendFile or a bare end(), never json().
      end() { done(); return res; },
      sendFile(f) { payload = { sentFile: f }; done(); return res; },
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
    sessionPaths: (e) => ({ cwd: e.cwd, repoRoot: e.cwd, worktree: e.worktree }),
    // Per-entry since #682, because the idle row's membership gate reads it: a plain
    // shell has no screenMarkers and classifies 'unknown', which is the ONLY thing
    // keeping a bash prompt — idle by nature, forever — off the bench. A ctx that
    // always says 'idle' would let that regress without a red test.
    sessionInputState: (e) => (e && e.inputState) || 'idle',
    getDefaultEngine: () => null,
    closeSession: (id) => {
      if (!shells.has(id)) return false;
      ctxClosed.push(id);
      shells.delete(id);
      return true;
    },
    deliverPromptWhenReady: (id, prompt, opts) => {
      ctxDeliveries.push({ id, prompt, opts });
    },
    // #669. saveState is what persists the review-gate stamps across a restart, so the
    // tests assert it was actually called rather than only that the field was set.
    saveState: () => { ctxSaveStates++; },
    // Verbatim from server.js — a stricter copy here would prove nothing about
    // production. Notably it does NO canonicalization; images.js realpaths first.
    pathInside: (p2, dir) => {
      if (!p2 || !dir) return false;
      const base = String(dir).replace(/\/+$/, '');
      return p2 === base || p2.startsWith(base + '/');
    },
    screenshots: new Map(),
    getScreenshotPath: (id) => path.join(SHOTS_DIR, `${id}.png`),
  };
}

let ctxDeliveries = [];
let ctxSaveStates = 0;
let ctxClosed = [];

/** Fresh world per test: new shells map, new app, and the tool handlers rebound. */
function world() {
  ctxDeliveries = [];
  ctxSaveStates = 0;
  ctxClosed = [];
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

// ── derived idle items (#682) ────────────────────────────────────────────────
//
// Workshop's actionable population used to be gated entirely on detectDialog, and the
// test that stood here asserted the consequence: an agent that finished its turn was
// not an inbox row. That was the arithmetic that made the panel informational — on a
// machine with nothing showing a dialog, which is the normal case, the bench was empty
// and the page was the issue list below it.
//
// So the gate is now two gates, and everything below is about the second one being
// tight enough to be worth having. `idleAfter=0` throughout: the grace window is real
// but it is a clock, and a unit test that waits on a clock is a flaky test.

/** A session sitting at its own composer, with `said` as the last thing it printed. */
function idleEntry(id, said = 'Done — the migration is applied.', over = {}) {
  const entry = makeEntry(id, null, over);
  const render = () => ['⏺ ' + said, '─'.repeat(60), '❯', '─'.repeat(60), '? for shortcuts'];
  entry.terminalScreen = { linesSync: (n) => render().slice(-n), lines: async (n) => render().slice(-n) };
  return entry;
}

const NOW_IDLE = { query: { idleAfter: '0' } };

test('a session that finished its turn is on the bench, headlined with what it said', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));

  const { body } = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  const row = body.items.find((i) => i.id === 'idle:' + id);
  assert.ok(row, 'an agent waiting on you is the state Workshop exists to show');
  assert.strictEqual(row.kind, 'idle');
  assert.strictEqual(
    row.urgency, 'normal',
    'not blocking: a finished session must never outrank an agent stuck on a dialog',
  );
  assert.strictEqual(
    row.headline, 'Done — the migration is applied.',
    'a bench of rows all saying "Waiting for you" is a list of session names, which is '
    + 'the informational surface this replaced',
  );
  assert.strictEqual(row.answerable, true);
  assert.strictEqual(row.pendingPath, 'prompt');
  assert.strictEqual(row.canClose, true);
  assert.strictEqual(row.canMerge, false, 'nothing to merge outside a worktree');
  assert.strictEqual(row.sessionName, 'fix-660');
  assert.strictEqual(row.projectName, 'deepsteve');
});

test('a worktree session offers the merge its row is for', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id, 'Committed. Ready to merge.', { worktree: 'github-issue-682' }));

  const { body } = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  const row = body.items.find((i) => i.id === 'idle:' + id);
  assert.strictEqual(row.canMerge, true);
  assert.strictEqual(row.worktree, 'github-issue-682');
});

test('an idle row waits out the grace window before it appears', async () => {
  // The between-turns case. Without this the bench flickers a row for every session
  // that pauses to think, which is the fastest way to teach someone to ignore it.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));

  const early = await app.call('GET', '/api/workshop/inbox', { query: { idleAfter: '900' } });
  assert.deepStrictEqual(early.body.items, []);

  const now = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.strictEqual(now.body.items.length, 1, 'the same session, past its grace window');
});

test('a plain shell at a bash prompt is never on the bench', async () => {
  // Idle by nature, forever. sessionInputState says 'unknown' for an agent type with
  // no screenMarkers, and that is the whole guard — without it the bench fills with
  // terminals nobody is waiting on and stops meaning anything.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id, 'ready', { agentType: 'terminal', inputState: 'unknown' }));

  const { body } = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.deepStrictEqual(body.items, []);
});

test('a session with a prompt already on its way is not waiting on you', async () => {
  const { shells, app } = world();
  const queued = sid();
  shells.set(queued, idleEntry(queued, 'ok', { promptQueue: [{ prompt: 'next' }] }));
  const inflight = sid();
  shells.set(inflight, idleEntry(inflight, 'ok', { pendingDelivery: { len: 4 } }));

  const { body } = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.deepStrictEqual(
    body.items, [],
    'a queued prompt is an answer that has already been given — showing it as an '
    + 'outstanding one is how a bench accumulates rows nobody needs to act on',
  );
});

test('a session showing a dialog is blocked, not idle — never both', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes', 'No'])));

  const { body } = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.deepStrictEqual(body.items.map((i) => i.id), ['blocked:' + id]);
});

test('answering an idle row delivers a prompt through the FIFO, never a raw write', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));

  const { status, body } = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'idle:' + id }, body: { text: '  now run the tests  ' },
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.deliveredVia, 'prompt');
  assert.deepStrictEqual(
    ctxDeliveries.map((d) => [d.id, d.prompt]), [[id, 'now run the tests']],
    'deliverPromptWhenReady owns the per-shell FIFO and the echo-gated submit; a raw '
    + 'engine.write here is the #656 truncation from a new caller',
  );
});

test('an empty prompt is refused rather than delivered as a bare Enter', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));

  const { status, body } = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'idle:' + id }, body: { text: '   ' },
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(body.error, 'empty');
  assert.deepStrictEqual(ctxDeliveries, []);
});

test('snoozing an idle row hides it, and the session moving on brings it back', async () => {
  const { shells, app } = world();
  const id = sid();
  const entry = idleEntry(id, 'first thing');
  shells.set(id, entry);

  const before = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  const fp = before.body.items[0].fingerprint;

  const snooze = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'idle:' + id }, body: { expect: fp },
  });
  assert.strictEqual(snooze.status, 200);
  assert.strictEqual(snooze.body.snoozed, true);

  const quiet = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.deepStrictEqual(quiet.body.items, [], 'snoozed');

  // The session says something else. That is a NEW wait, and a snooze is only ever a
  // promise about the one you looked at.
  const render = () => ['⏺ second thing', '─'.repeat(60), '❯', '─'.repeat(60), '? for shortcuts'];
  entry.terminalScreen = { linesSync: (n) => render().slice(-n), lines: async (n) => render().slice(-n) };
  entry.outputSeq++;

  const back = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.strictEqual(back.body.items.length, 1);
  assert.strictEqual(back.body.items[0].headline, 'second thing');
});

test('a snooze aimed at a wait that has already moved on is refused', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));
  await app.call('GET', '/api/workshop/inbox', NOW_IDLE);

  const { status, body } = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'idle:' + id }, body: { expect: 'a fingerprint from some other screen' },
  });
  assert.strictEqual(status, 409);
  assert.strictEqual(body.error, 'session-moved-on');
});

test('the idle clock survives a repaint that changed nothing', async () => {
  // outputSeq bumps on a resize or a status-line tick. Resetting the wait clock there
  // would make an agent that has been waiting forty minutes report forty seconds — and
  // with a grace window in play, would keep the row from ever appearing at all.
  const { shells, app } = world();
  const id = sid();
  const entry = idleEntry(id);
  shells.set(id, entry);

  const first = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  const createdAt = first.body.items[0].createdAt;

  entry.outputSeq++;   // same screen, new sequence number
  const again = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.strictEqual(again.body.items[0].createdAt, createdAt);
});

test('closing a session from the bench goes through the host, and the row goes with it', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));

  const { status, body } = await app.call('POST', '/api/workshop/sessions/:id/close', {
    params: { id },
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.deepStrictEqual(
    ctxClosed, [id],
    'ctx.closeSession is the host path that writes a closed:true tombstone — Workshop '
    + 'must never grow a second way to end a session',
  );

  const after = await app.call('GET', '/api/workshop/inbox', NOW_IDLE);
  assert.deepStrictEqual(after.body.items, []);
});

test('closing a session that is already gone is a 404, not a crash', async () => {
  const { app } = world();
  const { status, body } = await app.call('POST', '/api/workshop/sessions/:id/close', {
    params: { id: 'never-existed' },
  });
  assert.strictEqual(status, 404);
  assert.strictEqual(body.error, 'no-session');
  assert.deepStrictEqual(ctxClosed, []);
});

test('merge refuses a session that is not in a worktree', async () => {
  // Re-checked server-side even though the panel only offers the button on a worktree
  // row: the panel's copy of the session is up to a poll old, and "merge into whatever
  // the main checkout has checked out" from the main checkout is a surprise at best.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, idleEntry(id));

  const { status, body } = await app.call('POST', '/api/workshop/sessions/:id/merge', {
    params: { id },
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(body.error, 'not-a-worktree');
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

// A real AskUserQuestion: two answers, then the escape hatches below a rule.
const RULED = ['Uniform', 'Minimal', 'Type something.', 'Chat about this'];

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

test('a ruled AskUserQuestion is answerable, and lands on the intended row (#664)', async () => {
  // Every multi-option AskUserQuestion has a rule above its escape hatches. Before #664
  // these rows carried no options at all and could only be opened in their tab.
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(RULED, { divider: true });
  shells.set(id, makeEntry(id, dialog));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const row = body.items.find((i) => i.id === 'blocked:' + id);
  assert.ok(row, 'a ruled dialog is still a row');
  assert.strictEqual(row.answerable, true, 'and now it can be answered from here');
  assert.strictEqual(row.cursorIndex, 0);
  assert.deepStrictEqual(row.options.map((o) => o.label), RULED);

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 2 },
  });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.steps, 2);
  assert.deepStrictEqual(dialog.writes, [KEY_DOWN, KEY_DOWN, ENTER]);
  assert.strictEqual(dialog.selected, 2);
  assert.strictEqual(r.body.optionLabel, 'Type something.');
});

test('the option BELOW the divider is reachable, and it is the one pressed', async () => {
  // The assertion an off-by-one across the divider fails. `Chat about this` is the last
  // row of the menu but the first below the rule, so a run that mis-counts the divider
  // as a row commits the wrong option here.
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(RULED, { divider: true });
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 3 },
  });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.steps, 3, 'three rows to travel, not four — the rule is not a row');
  assert.deepStrictEqual(dialog.writes, [KEY_DOWN, KEY_DOWN, KEY_DOWN, ENTER]);
  assert.strictEqual(dialog.selected, 3);
  assert.strictEqual(r.body.optionLabel, 'Chat about this');
});

test('walking UP across the divider lands on the right row too', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(RULED, { divider: true, cursor: 3 });
  shells.set(id, makeEntry(id, dialog));

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: 'blocked:' + id }, body: { optionIndex: 0 },
  });
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.direction, 'Up');
  assert.deepStrictEqual(dialog.writes, [KEY_UP, KEY_UP, KEY_UP, ENTER]);
  assert.strictEqual(dialog.selected, 0);
  assert.strictEqual(r.body.optionLabel, 'Uniform');
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

// ── dismissing a live dialog: the mute (#663) ────────────────────────────────
//
// The one rule worth stating: a mute belongs to the QUESTION, not the tab. Every test
// below is some version of "and it comes back when the tab asks something else",
// because the failure this must never have is a blocked agent going quiet forever.

/** A screen that never changes — a dialog nobody is touching. */
const staticScreen = (lines) => ({
  linesSync: (n) => lines.slice(-n),
  lines: async (n) => lines.slice(-n),
});

const inboxIds = async (app) => {
  const { body } = await app.call('GET', '/api/workshop/inbox');
  return body.items.map((i) => i.id);
};

test('dismissing a live dialog drops the row and types nothing into it', async () => {
  const { shells, app } = world();
  const id = sid();
  const dialog = new FakeDialog(['Yes', 'No']);
  shells.set(id, makeEntry(id, dialog));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const row = body.items.find((i) => i.id === 'blocked:' + id);
  assert.ok(row, 'the row must be there first');

  const r = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'blocked:' + id }, body: { expect: row.fingerprint },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.muted, true);

  assert.ok(!(await inboxIds(app)).includes('blocked:' + id), 'the row must be gone');
  assert.deepStrictEqual(dialog.writes, [], 'a mute must never touch the session');
  assert.strictEqual(dialog.selected, null, 'the dialog itself is left standing');
});

test('a muted row stays gone across polls, and through a repaint of the same dialog', async () => {
  const { shells, app } = world();
  const id = sid();
  const entry = makeEntry(id, new FakeDialog(['Yes', 'No']));
  shells.set(id, entry);

  await app.call('POST', '/api/workshop/items/:id/dismiss', { params: { id: 'blocked:' + id } });
  assert.ok(!(await inboxIds(app)).includes('blocked:' + id));

  // A status-line tick bumps outputSeq without changing the question. Muting on the
  // parsed question alone would survive this; muting on a raw screen hash would not.
  entry.outputSeq++;
  assert.ok(!(await inboxIds(app)).includes('blocked:' + id), 'a repaint is not a new question');
});

test('a muted tab that asks something else comes straight back', async () => {
  const { shells, app } = world();
  const id = sid();
  const entry = makeEntry(id, new FakeDialog(['Yes', 'No']));
  shells.set(id, entry);

  await app.call('POST', '/api/workshop/items/:id/dismiss', { params: { id: 'blocked:' + id } });
  assert.ok(!(await inboxIds(app)).includes('blocked:' + id));

  entry._dialog = new FakeDialog(['Merge it', 'Leave it alone']);
  entry.terminalScreen = new FakeScreen(entry._dialog);
  entry.outputSeq++;

  assert.ok(
    (await inboxIds(app)).includes('blocked:' + id),
    'the mute expires with the dialog that earned it — a new question is a new row',
  );
});

test('the same question asked again after the dialog cleared is a new row', async () => {
  const { shells, app } = world();
  const id = sid();
  const entry = makeEntry(id, new FakeDialog(['Yes', 'No']));
  shells.set(id, entry);

  await app.call('POST', '/api/workshop/items/:id/dismiss', { params: { id: 'blocked:' + id } });

  // The dialog resolves on its own: Claude Code repaints a composer, the row goes,
  // and with it the mute. Asking the identical question afterwards must be audible.
  entry._dialog.selected = 0;
  entry.outputSeq++;
  assert.ok(!(await inboxIds(app)).includes('blocked:' + id), 'no dialog, no row');

  entry._dialog = new FakeDialog(['Yes', 'No']);
  entry.terminalScreen = new FakeScreen(entry._dialog);
  entry.outputSeq++;
  assert.ok(
    (await inboxIds(app)).includes('blocked:' + id),
    'a mute must not outlive the dialog and swallow an identical re-ask',
  );
});

test('a dialog Workshop cannot parse is still dismissible', async () => {
  const { shells, app } = world();
  const id = sid();
  // Only one option is on screen, so detectDialog says "blocked" while parseDialog says
  // "unreadable": the row renders as a raw preview and cannot be answered from here.
  // Before #663 it could not be got rid of either. (This used to be RULED_OPTION_RUN,
  // which #664 taught the parser to read.)
  const entry = makeEntry(id, null, { terminalScreen: staticScreen(fx.SINGLE_OPTION) });
  shells.set(id, entry);

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const row = body.items.find((i) => i.id === 'blocked:' + id);
  assert.ok(row, 'an unparseable dialog is still a row');
  assert.strictEqual(row.answerable, false);

  const r = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'blocked:' + id },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(!(await inboxIds(app)).includes('blocked:' + id));
});

test('two unparseable dialogs do not share one mute', async () => {
  const { shells, app } = world();
  // Genuinely unreadable: a lone option, so parseDialog gives up while detectDialog
  // still sees a dialog. It used to be the ruled shape, which #664 made parseable — the
  // test would then still have PASSED on a premise that was silently false.
  const footer = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
  const screenOf = (q) => [q, '❯ 1. One', footer];

  const a = sid();
  const b = sid();
  shells.set(a, makeEntry(a, null, { terminalScreen: staticScreen(screenOf('Ship it?')) }));
  shells.set(b, makeEntry(b, null, { terminalScreen: staticScreen(screenOf('Delete it?')) }));

  await app.call('POST', '/api/workshop/items/:id/dismiss', { params: { id: 'blocked:' + a } });

  const ids = await inboxIds(app);
  assert.ok(!ids.includes('blocked:' + a));
  assert.ok(ids.includes('blocked:' + b), 'muting one unreadable dialog must not silence the rest');
});

test('dismissing a dialog that already resolved says so instead of muting blind', async () => {
  const { shells, app } = world();
  const id = sid();
  const entry = makeEntry(id, new FakeDialog(['Yes', 'No']));
  shells.set(id, entry);
  await app.call('GET', '/api/workshop/inbox');

  entry._dialog.selected = 0;      // answered in the tab between the poll and the click
  entry.outputSeq++;

  const r = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'blocked:' + id },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'no-dialog');
  assert.match(r.body.hint, /already gone/i);
});

test('dismissing a row whose dialog was swapped underneath it refuses', async () => {
  const { shells, app } = world();
  const id = sid();
  const entry = makeEntry(id, new FakeDialog(['Yes', 'No']));
  shells.set(id, entry);

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const drawn = body.items.find((i) => i.id === 'blocked:' + id).fingerprint;
  assert.ok(drawn, 'a blocked row must carry the fingerprint it was drawn with');

  // The agent replaced the dialog between the poll and the click. Muting whatever is
  // on screen now would silence a question the human has never seen.
  entry._dialog = new FakeDialog(['Delete everything', 'Cancel']);
  entry.terminalScreen = new FakeScreen(entry._dialog);
  entry.outputSeq++;

  const r = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'blocked:' + id }, body: { expect: drawn },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'dialog-changed');
  assert.ok((await inboxIds(app)).includes('blocked:' + id), 'the new question stays audible');
});

test('dismissing a session that is already gone is a 404', async () => {
  const { app } = world();
  const r = await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: 'blocked:vanished' },
  });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.error, 'session-gone');
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

// ── the backlog routes (#671) ────────────────────────────────────────────────
//
// What these prove is PLUMBING: the routes are registered, they resolve a project the
// way project-scope.js does, and they never 500 whatever the environment does. The
// rules themselves — parsing, matching, caching — are proved against backlog.js with an
// injected fetcher in test/unit/workshop-backlog.test.js, because doing it here would
// need a real GitHub CLI and a real repo.
//
// PROJECT_DIR is a real directory that is deliberately NOT a repo, so the one `gh` call
// these can trigger fails in milliseconds with no network. On the CI runner there is no
// `gh` at all and the same paths return the other error. Both are asserted as a set,
// which is what keeps this suite environment-independent.

const GH_ERRORS = ['gh-unavailable', 'gh-failed'];

// A distinct label per test: the caches are module state, and two tests sharing a key
// would have the second silently assert against the first one's cached answer.
let nextLabel = 0;
const label = () => 'ds-test-label-' + (++nextLabel);

test('with no session and no shells, the backlog says so instead of guessing', async () => {
  const { app } = world();
  const r = await app.call('GET', '/api/workshop/backlog', { query: { label: 'bug' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.error, 'no-project');
  assert.deepStrictEqual(r.body.issues, []);
  assert.strictEqual(r.body.project, '');
});

test('the backlog follows the session the caller names', async () => {
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  const r = await app.call('GET', '/api/workshop/backlog', {
    query: { label: label(), session: id },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.projectName, 'deepsteve');
  assert.ok(Array.isArray(r.body.issues));
  assert.ok(GH_ERRORS.includes(r.body.error), `unexpected error ${r.body.error}`);
});

test('a stale session id falls back to the most recently active shell', async () => {
  // Ordinary rather than exotic: the panel sends whatever getActiveSessionId() last
  // reported, and that tab may have been closed since. Falling through to '' here would
  // blank the backlog every time you closed the tab you had been looking at.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  const r = await app.call('GET', '/api/workshop/backlog', {
    query: { label: label(), session: 'sess-that-never-existed' },
  });
  assert.strictEqual(r.body.projectName, 'deepsteve');
});

test('an explicit project pins the backlog regardless of the session', async () => {
  const { app } = world();
  const r = await app.call('GET', '/api/workshop/backlog', {
    query: { label: label(), project: PROJECT_DIR },
  });
  assert.strictEqual(r.body.project, PROJECT_DIR);
});

test('an unusable label is refused before a subprocess is spawned', async () => {
  // Not a hypothetical: the label is a string kept in the browser's own settings, so the
  // route's input is whatever localStorage holds. Refusing it here is what keeps a junk
  // value from costing a 15s `gh` timeout on every refresh, forever.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  for (const bad of ['x'.repeat(61), 'two\nlines', 'nul\0byte']) {
    const r = await app.call('GET', '/api/workshop/backlog', { query: { label: bad, session: id } });
    assert.strictEqual(r.status, 200, 'still never a 500');
    assert.strictEqual(r.body.error, 'bad-label', `accepted ${JSON.stringify(bad)} as a label`);
    assert.deepStrictEqual(r.body.issues, []);
  }
});

test('no label means every open issue, not an error (#679)', async () => {
  // The whole point of #679: absent and malformed used to be the same `''`, so there was
  // no way to say "no filter". Now only the malformed case is refused — an absent label
  // goes through to `gh` exactly like a real one, which on this machine means it comes
  // back with a gh error rather than a `no-label` short-circuit.
  //
  // Unlike the tests above this one cannot use label(): the unfiltered cache key is the
  // fixed `${project}\0`, so a second case would be served the first one's answer. One
  // pass, and `cached` is left unasserted for the same reason.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  for (const absent of [undefined, '', '   ']) {
    const r = await app.call('GET', '/api/workshop/backlog', { query: { label: absent, session: id } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.label, '');
    assert.notStrictEqual(r.body.error, 'bad-label', `${JSON.stringify(absent)} was read as junk`);
    assert.ok(GH_ERRORS.includes(r.body.error), `unexpected error ${r.body.error}`);
  }
});

test('the backlog route never 500s, whatever the environment does', async () => {
  // The contract the panel depends on. Its inbox error strip paints a red bar across the
  // top of the app; a project that simply is not hosted must not be able to trigger it,
  // because that is a fact about the project rather than a failure.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  const r = await app.call('GET', '/api/workshop/backlog', { query: { label: label(), session: id } });
  assert.strictEqual(r.status, 200);
});

test('the label route mirrors the backlog route, including never failing loudly', async () => {
  const { shells, app } = world();

  // Before any shell exists: nothing to fall back to, so it must SAY nothing rather
  // than resolve some other project's labels. Asserted first on purpose — once a shell
  // is in the map the fallback correctly kicks in and this case is unreachable.
  const none = await app.call('GET', '/api/workshop/labels');
  assert.strictEqual(none.status, 200);
  assert.strictEqual(none.body.error, 'no-project');
  assert.deepStrictEqual(none.body.labels, []);

  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  const r = await app.call('GET', '/api/workshop/labels', { query: { session: id } });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.labels));
  assert.ok(GH_ERRORS.includes(r.body.error), `unexpected error ${r.body.error}`);
});

test('a second call for the same project and label is served from the cache', async () => {
  // Proved through the response rather than a spy, because the fetcher is built inside
  // the route: a cached answer carries cached:true and a fresh one cannot.
  const { shells, app } = world();
  const id = sid();
  shells.set(id, makeEntry(id, new FakeDialog(['Yes'])));
  const l = label();
  const first = await app.call('GET', '/api/workshop/backlog', { query: { label: l, session: id } });
  const second = await app.call('GET', '/api/workshop/backlog', { query: { label: l, session: id } });
  assert.strictEqual(first.body.cached, false);
  assert.strictEqual(second.body.cached, true, 'a repeat inside the TTL must not re-spawn the subprocess');
});

// ── share_result and the review gate (#669) ──────────────────────────────────
//
// The stamps are the security surface. `resultItemId` is written by the AGENT's own
// tool call and by itself REFUSES a merge; `resultApprovedAt` is what permits one, and
// is written on exactly one line reachable only from the answer endpoint. These tests
// exist to keep that asymmetry from quietly collapsing — an agent that could set
// resultApprovedAt could approve its own work, which is precisely the thing #519 guards.

function liveSession(shells, id) {
  const entry = makeEntry(id, null, { waitingForInput: false, terminalScreen: null });
  shells.set(id, entry);
  return entry;
}

test('share_result posts a result and parks the agent without approving anything', async () => {
  const { shells, tools } = world();
  const id = sid();
  const entry = liveSession(shells, id);

  const res = await tools.share_result.handler(
    { summary: 'Dropped the alt-buffer branch.\nSecond line ignored for the subject.' },
    extraFor(id),
  );
  const said = res.content[0].text;

  assert.match(said, /awaiting review/i);
  assert.match(said, /End your turn/i);
  assert.match(said, /Do not call issue_complete/i,
    'the return text is the only thing standing between the agent and an immediate merge attempt');

  assert.ok(entry.resultItemId, 'the caller is stamped with the item it shared');
  assert.strictEqual(
    entry.resultApprovedAt, null,
    'SHARING MUST NOT APPROVE. If this ever becomes truthy, an agent approves its own work.',
  );
  assert.ok(ctxSaveStates > 0, 'the stamp is persisted, or a restart loses the park');
});

test('the shared item is a result, with the summary as body and its first line as subject', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);

  await tools.share_result.handler({
    summary: 'Wheel events no longer walk history.\n\nThe alt-buffer branch is gone.',
    before: 'ESC[A / ESC[B on every wheel tick',
    after: 'inert; tmux owns the scroll',
    caveats: 'untested against xterm 5',
  }, extraFor(id));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const item = body.items.find((i) => i.id === entry.resultItemId);
  assert.ok(item, 'the result shows up in the inbox');
  assert.strictEqual(item.kind, 'result');
  assert.strictEqual(item.headline, 'Wheel events no longer walk history.',
    'the first line becomes the list subject, so itemSubject() needs no knowledge of results');
  assert.match(item.context, /The alt-buffer branch is gone/, 'the whole summary is kept');
  assert.strictEqual(item.before, 'ESC[A / ESC[B on every wheel tick');
  assert.strictEqual(item.after, 'inert; tmux owns the scroll');
  assert.strictEqual(item.caveats, 'untested against xterm 5');
  assert.deepStrictEqual(item.options.map((o) => o.label), ['Approve', 'Request changes']);
  assert.strictEqual(item.sessionId, id, 'the agent never identifies itself');
});

test('images are attached by reference and reported when refused', async () => {
  const { shells, ctx, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  ctx.screenshots.set('a1b2c3d4', { id: 'a1b2c3d4' });
  fs.writeFileSync(path.join(SHOTS_DIR, 'a1b2c3d4.png'), TINY_PNG);

  const res = await tools.share_result.handler({
    summary: 'A UI change reviewed from prose is not reviewed.',
    images: ['a1b2c3d4', './shot.png', path.join(OUTSIDE_DIR, 'secret.png')],
  }, extraFor(id));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const item = body.items.find((i) => i.id === entry.resultItemId);
  assert.strictEqual(item.images.length, 2, 'the two legitimate refs landed');
  assert.ok(item.images.every((i) => /^w\d+-\d+\.png$/.test(i.file)), 'stored as filenames');

  const wire = JSON.stringify(body);
  assert.ok(!/base64|data:image/i.test(wire),
    'the inbox JSON is re-fetched every 2s — an inlined PNG in there is fatal to the poll');

  assert.match(res.content[0].text, /Not attached/,
    'a silently dropped image means the agent writes its next result exactly the same way');
  assert.match(res.content[0].text, /outside-project/);
});

test('the images route serves the store and nothing else', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  await tools.share_result.handler({ summary: 'with evidence', images: ['./shot.png'] }, extraFor(id));

  const { body } = await app.call('GET', '/api/workshop/inbox');
  const file = body.items.find((i) => i.id === entry.resultItemId).images[0].file;

  const ok = await app.call('GET', '/api/workshop/images/:file', { params: { file } });
  assert.strictEqual(ok.status, 200);
  assert.match(ok.body.sentFile, new RegExp(`${file}$`));

  for (const bad of ['../../etc/passwd', '/etc/passwd', 'workshop.json', 'w9999-0.png']) {
    const r = await app.call('GET', '/api/workshop/images/:file', { params: { file: bad } });
    assert.strictEqual(r.status, 404, `the route must refuse ${bad}`);
  }
});

test('Approve stamps the gate and tells the agent to complete', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  await tools.share_result.handler({ summary: 'done' }, extraFor(id));
  const itemId = entry.resultItemId;

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: itemId }, body: { optionIndex: 0 },
  });

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.deliveredVia, 'prompt');
  assert.ok(entry.resultApprovedAt, 'this is the field that unlocks the merge');
  assert.strictEqual(entry.resultItemId, itemId, 'and the item it belongs to is kept');

  const delivered = ctxDeliveries.at(-1);
  assert.strictEqual(delivered.id, id);
  assert.match(delivered.prompt, /approved/i);
  assert.match(delivered.prompt, /issue_complete/,
    'Approve means "call issue_complete now" — the agent should not have to infer that');
  assert.strictEqual(delivered.opts.source, 'workshop',
    'the FIFO, never submitToShell and never e.pendingDelivery directly');
});

test('Request changes clears BOTH stamps, so the agent is back to sharing', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  await tools.share_result.handler({ summary: 'done' }, extraFor(id));

  await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: entry.resultItemId },
    body: { optionIndex: 1, text: 'does not handle the empty case' },
  });

  assert.strictEqual(entry.resultItemId, null);
  assert.strictEqual(entry.resultApprovedAt, null);
  const delivered = ctxDeliveries.at(-1);
  assert.match(delivered.prompt, /Changes requested/i);
  assert.match(delivered.prompt, /does not handle the empty case/, 'the reviewer own words');
  assert.match(delivered.prompt, /share_result again/);
});

test('free text with no option picked is NOT an approval', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  await tools.share_result.handler({ summary: 'done' }, extraFor(id));

  await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: entry.resultItemId }, body: { text: 'why did you do it this way?' },
  });

  assert.strictEqual(
    entry.resultApprovedAt, null,
    'the ambiguous case must never be the one that unlocks a merge',
  );
  assert.strictEqual(entry.resultItemId, null);
});

test('a result whose session is gone records the decision and types nowhere', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  liveSession(shells, id);
  await tools.share_result.handler({ summary: 'done' }, extraFor(id));
  const { body: before } = await app.call('GET', '/api/workshop/inbox');
  const item = before.items.find((i) => i.kind === 'result');

  shells.delete(id);                       // the daemon restarted, or the tab was closed
  const deliveriesBefore = ctxDeliveries.length;

  const r = await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: item.id }, body: { optionIndex: 0 },
  });

  assert.strictEqual(r.status, 200, 'the decision is still recorded — that is the point of a record');
  assert.strictEqual(r.body.deliveredVia, 'undelivered');
  assert.match(r.body.note, /session is gone/i, 'and it says so honestly rather than pretending');
  assert.strictEqual(ctxDeliveries.length, deliveriesBefore,
    'NOTHING may be written toward a dead session');
});

test('an open result survives the dead-session sweep the inbox listing runs', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  liveSession(shells, id);
  await tools.share_result.handler({ summary: 'outlives its tab' }, extraFor(id));
  shells.delete(id);
  // Another live session, so the listing's boot-grace guard lets the sweep run at all.
  liveSession(shells, sid());

  await app.call('GET', '/api/workshop/inbox');
  await app.call('GET', '/api/workshop/inbox');
  const { body } = await app.call('GET', '/api/workshop/inbox');

  const item = body.items.find((i) => i.kind === 'result' && i.headline === 'outlives its tab');
  assert.ok(item, 'a result is exempt — it is read AFTER the agent has finished');
  assert.strictEqual(item.status, 'open');
  assert.strictEqual(item.pendingPath, 'gone',
    'and the panel is told before the click, not by a note afterwards');
});

test('archiving an open result un-parks its agent', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  await tools.share_result.handler({ summary: 'done' }, extraFor(id));

  await app.call('POST', '/api/workshop/items/:id/dismiss', {
    params: { id: entry.resultItemId }, body: { reason: 'archived' },
  });

  assert.strictEqual(
    entry.resultItemId, null,
    'otherwise the session sits on "awaiting review" for a review that was thrown away — '
    + 'the one state issue_complete has no way out of',
  );
  assert.strictEqual(entry.resultApprovedAt, null, 'and archiving is certainly not an approval');
});

test('workshop_check reports a result decision in a result vocabulary', async () => {
  const { shells, tools, app } = world();
  const id = sid();
  const entry = liveSession(shells, id);
  await tools.share_result.handler({ summary: 'done' }, extraFor(id));
  const itemId = entry.resultItemId;
  const seq = itemId.slice(1);

  const open = await tools.workshop_check.handler({ ticket: seq });
  assert.match(open.content[0].text, /awaiting review/i);

  await app.call('POST', '/api/workshop/items/:id/answer', {
    params: { id: itemId }, body: { optionIndex: 0 },
  });
  const done = await tools.workshop_check.handler({ ticket: seq });
  assert.match(done.content[0].text, /APPROVED/);
  assert.match(done.content[0].text, /issue_complete/);
});

test('share_result declares no options of its own — the two are minted server-side', () => {
  const { tools } = world();
  assert.deepStrictEqual(
    Object.keys(tools.share_result.schema).sort(),
    ['after', 'before', 'caveats', 'images', 'summary'],
    'an `options` argument here would let an agent write the button it needs clicked',
  );
});
