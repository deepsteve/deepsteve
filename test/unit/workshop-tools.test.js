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
