// #607 — level-triggered prompt readiness.
//
// The bug this file pins: delivery used to hang off a one-shot e.onIdleOnce that
// setWaiting fired only on the false->true edge. When the screen read 'unknown' at
// drain time while e.waitingForInput was ALREADY true, that edge had already passed
// — reclassifyWaiting no-ops on 'unknown' and setWaiting early-returns on a
// no-change — so the callback could never fire and the prompt was never even typed.
//
// Runs the REAL server.js source (deliverPromptWhenReady + the waiting detector) in
// a vm against the REAL screen classifier and REAL captured screen tails, with fake
// timers and a fake clock. No wall-clock sleeps.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { classifyScreenTail, CLAUDE_SCREEN_MARKERS } = require('../../screen-classifier');
const { fixtures } = require('./fixtures/screen-tails');
const { readComposerDraft, hasStashedDraft } = require('../../composer-state');
const { askingSummary } = require('../../dialog-parse');
const DIALOGS = require('./fixtures/inbox-dialogs');
const COMPOSER = require('./fixtures/composer-screens');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

// Real captured tails, looked up by their fixture names so the two suites can't drift.
const tailNamed = (needle) => {
  const f = fixtures.find((x) => x.name.includes(needle));
  assert.ok(f, `no screen-tail fixture matching ${needle}`);
  return f.tail;
};
const TAIL_UNKNOWN = tailNamed('half-typed normal mode');       // classifies 'unknown'
const TAIL_IDLE = tailNamed('idle auto-mode footer');           // classifies 'waiting'
const TAIL_WORKING = tailNamed('modern working, no esc-hint');  // 'working' with a fresh spinner

const ID = 'del1very';
const DEADLINE_MS = 30000;

const AGENT_CONFIGS = {
  claude: { screenMarkers: CLAUDE_SCREEN_MARKERS, initialPromptDelay: 0 },
  hermes: { initialPromptDelay: 3000 },
  codex: { initialPromptDelay: 0, codexReadiness: true },
  terminal: { initialPromptDelay: 0 },
};

function makeHarness({ agentType = 'claude', waitingForInput = true, screen = 'unknown' } = {}) {
  const timers = [];
  const submits = [];
  const windowMsgs = [];
  const broadcasts = [];
  const logs = [];
  const shells = new Map();
  let now = 1_000_000;   // non-zero so `lastSpinnerTime` arithmetic is realistic

  const entry = {
    agentType,
    clients: new Set([{ send: (m) => broadcasts.push(JSON.parse(m)) }]),
    scrollback: [],
    waitingForInput,
    lastSpinnerTime: null,
    lastInputTime: 0,
    loading: true,
    // The interpreted screen the mid-turn gate reads. Separate from `scrollback`
    // (the classifier's tail) so a test can set each half independently.
    composerLines: COMPOSER.WORKING_EMPTY_COMPOSER,
    terminalScreen: { linesSync: () => entry.composerLines },
    // Keys the delivery path writes itself (the stash), as opposed to submitted prompts.
    keys: [],
    engine: { write: (_id, data) => entry.keys.push(data) },
  };
  shells.set(ID, entry);

  const context = {
    shells,
    log: (m) => logs.push(m),
    auditWaiting: () => {},
    auditScreenTail: () => '',
    classifyScreenTail,
    askingSummary,
    envMs: (_name, fallback) => fallback,
    readComposerDraft,
    hasStashedDraft,
    SUBMIT_TIMINGS: { screenLines: 40 },
    getAgentConfig: (t) => AGENT_CONFIGS[t] || AGENT_CONFIGS.claude,
    deliverToWindow: (msg) => windowMsgs.push(msg),
    process: { env: {} },
    // Layers 2+3 have their own suite; here they are inert so the assertions are
    // purely about WHEN delivery happens.
    promptSubmitConfirmEnabled: () => false,
    confirmPromptSubmitted: async () => 'skipped',
    submitToShell: (id, text) => { submits.push({ id, text }); return Promise.resolve(); },
    Date: { now: () => now },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, at: now + ms, cleared: false };
      timers.push(t);
      return t;
    },
  };

  const delivery = sourceBetween('function deliverPromptWhenReady', 'const RC_FOOTER_ROWS = 8;');
  const detector = sourceBetween('function stripEscapeSequences', 'function wireShellOutput');
  vm.runInNewContext(`${delivery}
${detector}
result = { deliverPromptWhenReady, reclassifyWaiting, computeWaiting, PROMPT_READY_DEADLINE_MS }`, context);

  const h = {
    ...context.result,
    shells, entry, timers, submits, windowMsgs, broadcasts, logs,
    get now() { return now; },
    advance(ms) { now += ms; },
    setScreen(kind) {
      entry.scrollback = [kind === 'working' ? TAIL_WORKING : kind === 'waiting' ? TAIL_IDLE : TAIL_UNKNOWN];
      entry.lastSpinnerTime = kind === 'working' ? now : null;
    },
    // What the 1s waiting sweep does, verbatim (server.js).
    sweep() { for (const [id, e] of shells) h.reclassifyWaiting(e, id, 'sweep'); },
    async step() {
      let best = -1;
      for (let i = 0; i < timers.length; i++) {
        if (timers[i].cleared || timers[i].fired) continue;
        if (best < 0 || timers[i].at < timers[best].at) best = i;
      }
      if (best < 0) return false;
      const t = timers[best];
      t.fired = true;
      now = Math.max(now, t.at);
      t.fn();
      await new Promise((r) => setImmediate(r));
      return true;
    },
    // Fire only the timers already due, so a pending 60s inputBlockTimer doesn't
    // drag the clock forward past a deadline the test is trying to observe.
    async runDue(max = 50) {
      for (let i = 0; i < max; i++) {
        const due = timers.find((t) => !t.cleared && !t.fired && t.at <= now);
        if (!due) return;
        due.fired = true;
        due.fn();
        await new Promise((r) => setImmediate(r));
      }
      throw new Error('due timers did not settle');
    },
  };
  h.setScreen(screen);
  return h;
}

// --- the regression ---------------------------------------------------------

test('#607: a prompt armed against an ambiguous screen still lands once the screen reads idle', async () => {
  // The exact precondition: the tab already went idle (so waitingForInput is true and
  // the false->true edge is spent) and the screen is momentarily unclassifiable.
  const h = makeHarness({ waitingForInput: true, screen: 'unknown' });
  assert.strictEqual(h.computeWaiting(h.entry), false, 'screen must be non-decisive for this test');

  h.deliverPromptWhenReady(ID, 'do the issue');
  assert.ok(h.entry.pendingDelivery, 'delivery is armed, not fired');
  assert.deepStrictEqual(h.submits, []);

  h.sweep();
  h.sweep();
  assert.deepStrictEqual(h.submits, [], 'still ambiguous, still waiting');

  // The screen becomes decisively idle. Note there is NO false->true transition here
  // — waitingForInput was already true — which is precisely why the old edge-driven
  // onIdleOnce could never fire.
  h.setScreen('waiting');
  h.sweep();
  assert.strictEqual(h.entry.waitingForInput, false, 'served deliveries clear the flag, same as the immediate path');
  assert.ok(!h.broadcasts.some((b) => b.waiting === true), 'no false->true edge ever occurred');

  await h.step();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['do the issue']);
});

test('the readiness deadline delivers a prompt the screen never explains', async () => {
  const h = makeHarness({ screen: 'unknown' });
  h.deliverPromptWhenReady(ID, 'do the issue');

  h.advance(DEADLINE_MS - 1);
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits, [], 'must not fire early');

  h.advance(2);
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['do the issue']);
  assert.ok(h.logs.some((m) => m.includes('deadline reached')), h.logs.join('\n'));
});

test('a genuinely long turn keeps pushing the deadline out instead of being interrupted', async () => {
  const h = makeHarness({ screen: 'working' });
  h.deliverPromptWhenReady(ID, 'do the issue');

  // Ten minutes of a running turn: only AMBIGUOUS time counts against the deadline.
  for (let i = 0; i < 20; i++) {
    h.advance(DEADLINE_MS);
    h.setScreen('working');   // refresh the spinner heartbeat
    h.sweep();
    await h.runDue();
  }
  assert.deepStrictEqual(h.submits, [], 'never shoved into a live turn');

  h.setScreen('waiting');
  h.sweep();
  await h.step();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['do the issue']);
});

test('repeated sweeps in the same idle window deliver exactly once', async () => {
  const h = makeHarness({ screen: 'unknown' });
  h.deliverPromptWhenReady(ID, 'do the issue');
  h.setScreen('waiting');
  h.sweep();
  h.sweep();
  h.sweep();
  // pendingDelivery is nulled before its timer is armed, so the 2nd and 3rd sweeps
  // find nothing to serve.
  assert.strictEqual(h.timers.filter((t) => t.ms === 500).length, 1, 'only one submit was scheduled');

  await h.step();
  await h.step();
  await h.step();
  assert.strictEqual(h.submits.length, 1, `expected one submit, got ${h.submits.length}`);
});

test('closing the tab drops the pending prompt', async () => {
  const h = makeHarness({ screen: 'unknown' });
  h.deliverPromptWhenReady(ID, 'do the issue');
  h.shells.delete(ID);
  h.setScreen('waiting');
  h.sweep();
  h.advance(DEADLINE_MS * 2);
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits, []);
});

// --- sequencing (#519) ------------------------------------------------------

test('an inherited /rc still submits before the issue prompt', async () => {
  const h = makeHarness({ screen: 'unknown' });
  h.deliverPromptWhenReady(ID, '/rc');
  h.deliverPromptWhenReady(ID, 'do the issue');
  assert.strictEqual(h.entry.promptQueue.length, 1, 'the 2nd prompt queues behind the in-flight one');

  h.setScreen('waiting');
  h.sweep();
  await h.step();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['/rc']);

  // The 2nd prompt re-arms and waits for its own readiness signal.
  h.setScreen('unknown');
  h.sweep();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['/rc'], 'does not steal the first prompt\'s readiness');

  h.setScreen('waiting');
  h.sweep();
  // This waiting edge also arms the asking check, which settles sooner than the queued
  // submit, so step until the submit has had its turn rather than exactly once.
  while (h.submits.length < 2 && await h.step()) { /* next timer */ }
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['/rc', 'do the issue']);
  assert.ok(h.windowMsgs.some((m) => m.type === 'prompt-submitted'), 'the banner clears only after the LAST prompt');
  assert.strictEqual(h.windowMsgs.filter((m) => m.type === 'prompt-submitted').length, 1);
});

// --- other agents are unaffected -------------------------------------------

test('an agent with a fixed initialPromptDelay still uses its timer', async () => {
  const h = makeHarness({ agentType: 'hermes', screen: 'unknown' });
  h.deliverPromptWhenReady(ID, 'go');
  assert.ok(!h.entry.pendingDelivery, 'no level-triggered arming for delay-based agents');
  const delay = h.timers.find((t) => t.ms === 3000);
  assert.ok(delay, `expected a 3000ms timer, got ${h.timers.map((t) => t.ms).join(',')}`);
  await h.step();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['go']);
});

test('codex still waits on its rendered MCP readiness', () => {
  const h = makeHarness({ agentType: 'codex', screen: 'unknown' });
  h.deliverPromptWhenReady(ID, 'go');
  assert.ok(!h.entry.pendingDelivery);
  assert.strictEqual(typeof h.entry.onCodexReadyOnce, 'function');
});

test('an unclassified agent gets its deadline served instead of hanging forever', async () => {
  // Pre-#607 a terminal-type session armed an onIdleOnce that nothing could fire:
  // reclassifyWaiting returned before setWaiting for agents with no screenMarkers.
  const h = makeHarness({ agentType: 'terminal', screen: 'unknown' });
  h.deliverPromptWhenReady(ID, 'echo hi');
  assert.ok(h.entry.pendingDelivery);

  h.advance(DEADLINE_MS + 1);
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['echo hi']);
});

test('the deadline constant is the one server.js actually uses', () => {
  const h = makeHarness();
  assert.strictEqual(h.PROMPT_READY_DEADLINE_MS, DEADLINE_MS);
});

// --- midTurn: decision-tab answers (#716 follow-up) ---------------------------
//
// A click used to be held until the agent's turn ended — 26s, 69s, 4.5 minutes in the
// log. Claude Code queues a message entered mid-turn and hands it over at the next
// tool boundary, so a midTurn delivery types as soon as the COMPOSER is empty, and
// only then: a draft is a person mid-sentence, and an unreadable composer is usually
// a dialog whose cursor would take the keystrokes as its answer.

test('midTurn: a prompt into a working session is typed now, not at the end of the turn', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'working' });
  h.deliverPromptWhenReady(ID, 'decision answer', { midTurn: true });
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['decision answer']);
});

test('midTurn: a draft is stashed, not waited on, and the prompt goes into the emptied box', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'working' });
  h.entry.composerLines = COMPOSER.WORKING_USER_DRAFT;
  h.deliverPromptWhenReady(ID, 'decision answer', { midTurn: true });
  assert.deepStrictEqual(h.entry.keys, ['\x13'], 'ctrl+s, once');
  assert.strictEqual(h.submits.length, 0, 'typed on top of somebody\'s draft');
  h.sweep();                                                  // still painting the stash
  assert.deepStrictEqual(h.entry.keys, ['\x13'], 'pressed the stash key twice');
  h.entry.composerLines = COMPOSER.WORKING_STASHED_EMPTY;     // Claude Code took it
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['decision answer']);
});

test('midTurn: a draft with the stash slot already taken holds rather than overwrite it', async () => {
  const h = makeHarness({ waitingForInput: true, screen: 'waiting' });
  h.entry.composerLines = COMPOSER.IDLE_DRAFT_WITH_STASH;
  h.deliverPromptWhenReady(ID, 'decision answer', { midTurn: true });
  for (let i = 0; i < 12; i++) { h.advance(1000); h.sweep(); await h.runDue(); }
  assert.deepStrictEqual(h.entry.keys, [], 'a second stash replaces the first');
  assert.strictEqual(h.submits.length, 0);
  assert.ok(h.logs.some((l) => /held: composer holds a draft and the stash slot is taken/.test(l)));
  h.entry.composerLines = COMPOSER.IDLE_STASHED_EMPTY;        // they sent it
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['decision answer']);
});

test('midTurn: a stash key that does not empty the box is pressed once, then held', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'working' });
  h.entry.composerLines = COMPOSER.WORKING_USER_DRAFT;        // and it stays that way (rebound key)
  h.deliverPromptWhenReady(ID, 'decision answer', { midTurn: true });
  for (let i = 0; i < 12; i++) { h.advance(1000); h.sweep(); await h.runDue(); }
  assert.deepStrictEqual(h.entry.keys, ['\x13']);
  assert.strictEqual(h.submits.length, 0);
  assert.ok(h.logs.some((l) => /held: the stash did not empty the composer/.test(l)));
});

test('midTurn: a dialog holds the prompt with no deadline, idle or not', async () => {
  const h = makeHarness({ waitingForInput: true, screen: 'waiting' });
  h.entry.composerLines = COMPOSER.PERMISSION_MENU;
  h.deliverPromptWhenReady(ID, 'decision answer', { midTurn: true });
  for (let i = 0; i < 5; i++) { h.advance(60000); h.sweep(); await h.runDue(); }
  assert.strictEqual(h.submits.length, 0, 'typed into a dialog');
  h.entry.composerLines = COMPOSER.EMPTY_COMPOSER;
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['decision answer']);
});

test('midTurn: two answers in a row both go in while the turn runs', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'working' });
  h.deliverPromptWhenReady(ID, 'first', { midTurn: true });
  h.deliverPromptWhenReady(ID, 'second', { midTurn: true });
  await h.runDue();
  // After the first, Claude Code shows its queued-messages hint in an empty composer.
  h.entry.composerLines = COMPOSER.WORKING_QUEUED_MESSAGE;
  h.sweep();
  await h.runDue();
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['first', 'second']);
});

test('without midTurn a working session still holds the prompt for the turn to end', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'working' });
  h.deliverPromptWhenReady(ID, 'issue prompt');
  for (let i = 0; i < 5; i++) { h.advance(1000); h.setScreen('working'); h.sweep(); await h.runDue(); }
  assert.strictEqual(h.submits.length, 0);
});

test('midTurn: a suggested prompt in the composer is not a draft — no stash, typed at once', async () => {
  // Real emulator, real bytes: after a turn Claude Code draws its suggestion faint.
  // Read as a draft it drew a ctrl+s that moved nothing ("the stash did not empty the
  // composer") and held the answer until the person sent something themselves.
  const { TerminalScreen } = require('../../terminal-screen');
  const rule = '\x1b[38;5;244m' + '─'.repeat(60) + '\x1b[39m\r\n';
  const screen = new TerminalScreen({ cols: 80, rows: 10 });
  screen.write('⏺ Want me to run it?\r\n' + rule + '\x1b[39m❯ \x1b[2myes, run it\x1b[0m\r\n' + rule + '  ⏵⏵ auto mode on');
  await screen.lines(10);
  const h = makeHarness({ waitingForInput: true, screen: 'waiting' });
  h.entry.terminalScreen = screen;
  h.deliverPromptWhenReady(ID, 'decision answer', { midTurn: true });
  await h.runDue();
  assert.deepStrictEqual(h.entry.keys, [], 'pressed ctrl+s on a suggestion');
  assert.deepStrictEqual(h.submits.map((s) => s.text), ['decision answer']);
  screen.dispose();
});

// --- asking: a dialog on a waiting screen (docs/sessions.md#asking) ----------
//
// The waiting flag cannot say whether an agent finished or is showing a dialog. The
// daemon takes a second look at the interpreted screen one settle after the edge and
// announces both together, then speaks again only when the question changes. These run
// the real setWaiting / reclassifyWaiting / checkAsking from server.js.

const askings = (h) => h.broadcasts.filter((b) => b.type === 'asking');

test('a finished turn is announced as waiting, not asking, one settle after the edge', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = COMPOSER.EMPTY_COMPOSER;
  h.sweep();
  assert.strictEqual(h.entry.waitingForInput, true, 'the flag itself flips at once');
  assert.deepStrictEqual(h.broadcasts, [], 'the announcement waits for the screen to settle');
  assert.ok(await h.step());
  assert.deepStrictEqual(h.broadcasts, [{ type: 'state', waiting: true, asking: null }]);
});

test('a dialog is announced as asking, with its question', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = DIALOGS.MULTI_QUESTION;
  h.sweep();
  await h.step();
  assert.strictEqual(h.broadcasts.length, 1);
  const [msg] = h.broadcasts;
  assert.deepStrictEqual({ type: msg.type, waiting: msg.waiting, kind: msg.asking.kind, text: msg.asking.text },
    { type: 'state', waiting: true, kind: 'question', text: 'How wide should the shared-jump wiring be?' });
  assert.ok(h.logs.some((l) => l.startsWith(`[asking] ${ID} question: How wide`)), h.logs.join('\n'));
});

test('while still waiting, only a new question is news', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = COMPOSER.EMPTY_COMPOSER;
  h.sweep();
  await h.step();

  // Quiet sweeps cost nothing: the screen has not moved since the last look.
  const before = h.timers.length;
  h.sweep(); h.sweep();
  assert.strictEqual(h.timers.length, before, 'no output, no re-read');

  // A permission dialog appears over the idle composer.
  h.entry.composerLines = DIALOGS.PERMISSION_CURSOR_MID;
  h.entry.outputSeq = 1;
  h.sweep();
  await h.step();
  assert.deepStrictEqual(askings(h).map((m) => [m.asking.kind, m.asking.text]),
    [['permission', 'Bash(rm -rf node_modules)']]);

  // The cursor moves: the same question, so nothing is sent.
  h.entry.composerLines = DIALOGS.PERMISSION_CURSOR_LAST;
  h.entry.outputSeq = 2;
  h.sweep();
  await h.step();
  assert.strictEqual(askings(h).length, 1, 'arrowing between options is not a new question');

  // Esc: the dialog goes and the session is still at its prompt.
  h.entry.composerLines = COMPOSER.EMPTY_COMPOSER;
  h.entry.outputSeq = 3;
  h.sweep();
  await h.step();
  assert.deepStrictEqual(askings(h).at(-1), { type: 'asking', asking: null });
  assert.ok(!h.broadcasts.some((b) => b.type === 'state' && b.waiting === false), 'still waiting throughout');
});

test('leaving waiting clears asking at once, and a pending look never announces late', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = DIALOGS.MULTI_QUESTION;
  h.sweep();                       // edge on, the look is pending
  h.setScreen('working');
  h.sweep();                       // edge off before the look ran
  assert.deepStrictEqual(h.broadcasts, [{ type: 'state', waiting: false, asking: null }]);
  while (await h.step()) { /* drain */ }
  assert.ok(!h.broadcasts.some((b) => b.waiting === true || b.type === 'asking'),
    `a cancelled look must stay cancelled: ${JSON.stringify(h.broadcasts)}`);
  assert.strictEqual(h.entry.asking, null);
});

test('a session that answered its dialog is announced as no longer asking', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = DIALOGS.PERMISSION_CURSOR_MID;
  h.sweep();
  await h.step();
  assert.ok(h.entry.asking);
  h.setScreen('working');          // the answer started the turn again
  h.sweep();
  assert.deepStrictEqual(h.broadcasts.at(-1), { type: 'state', waiting: false, asking: null });
  assert.ok(h.logs.some((l) => l === `[asking] ${ID} answered (sweep)`), h.logs.join('\n'));
});

test('a dialog still being drawn is read once it is finished, and announced once', async () => {
  // A dialog arrives in several chunks, and so does the full repaint a browser reattach
  // causes. Reading mid-draw saw a half-drawn dialog — a different fingerprint — and
  // announced a second "new" question: two notifications on the first ask, one per reload.
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = DIALOGS.SINGLE_OPTION;         // detected, not yet readable
  h.sweep();                                            // the waiting edge
  for (let i = 1; i <= 4; i++) {
    h.advance(100);
    h.entry.outputSeq = i;
    h.reclassifyWaiting(h.entry, ID, 'output');          // each chunk restarts the quiet period
    await h.runDue();
  }
  assert.deepStrictEqual(h.broadcasts, [], 'nothing is announced while the screen is still moving');
  h.entry.composerLines = DIALOGS.MULTI_QUESTION;        // the last chunk completes the dialog
  h.entry.outputSeq = 5;
  h.reclassifyWaiting(h.entry, ID, 'output');
  h.advance(150);
  await h.runDue();
  assert.strictEqual(h.broadcasts.length, 1, JSON.stringify(h.broadcasts));
  assert.strictEqual(h.broadcasts[0].asking.text, 'How wide should the shared-jump wiring be?');

  // A reattach repaints the same dialog: same fingerprint once quiet, so nothing is sent.
  for (let i = 6; i <= 8; i++) {
    h.entry.composerLines = i < 8 ? DIALOGS.SINGLE_OPTION : DIALOGS.MULTI_QUESTION;
    h.entry.outputSeq = i;
    h.reclassifyWaiting(h.entry, ID, 'output');
    h.advance(60);
    await h.runDue();
  }
  h.advance(150);
  await h.runDue();
  assert.strictEqual(h.broadcasts.length, 1, `a repaint is not a new question: ${JSON.stringify(h.broadcasts)}`);
});

test('a screen that never goes quiet is still read within the cap', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = COMPOSER.EMPTY_COMPOSER;
  h.sweep();
  const edgeAt = h.now;
  let announcedAt = null;
  for (let i = 1; i <= 30 && announcedAt === null; i++) {
    h.advance(100);
    h.entry.outputSeq = i;
    h.reclassifyWaiting(h.entry, ID, 'output');
    await h.runDue();
    if (h.broadcasts.length) announcedAt = h.now;
  }
  assert.ok(announcedAt !== null, 'never announced');
  assert.ok(announcedAt - edgeAt <= 1000, `announced ${announcedAt - edgeAt}ms after the edge`);
  assert.deepStrictEqual(h.broadcasts, [{ type: 'state', waiting: true, asking: null }]);
});

test('a repaint that leaves the dialog half-drawn, or rewrapped, is not a new question', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = DIALOGS.MULTI_QUESTION;
  h.sweep();
  await h.step();
  assert.strictEqual(h.broadcasts.length, 1);

  // A reattach repaint stalls half-drawn for longer than the quiet period. The unreadable
  // read is checked once more, by which time the dialog is whole again: nothing is sent.
  h.entry.composerLines = DIALOGS.SINGLE_OPTION;
  h.entry.outputSeq = 1;
  h.sweep();
  await h.step();
  h.entry.composerLines = DIALOGS.MULTI_QUESTION;
  await h.step();
  assert.strictEqual(h.broadcasts.length, 1, `half-drawn is not news: ${JSON.stringify(h.broadcasts)}`);

  // Measured on a real reattach: the repaint can still be half-drawn on the second look.
  // A readable question is never traded for an unreadable read of the same screen.
  h.entry.composerLines = DIALOGS.SINGLE_OPTION;
  h.entry.outputSeq = 10;
  h.sweep();
  await h.step();
  await h.step();
  assert.strictEqual(h.broadcasts.length, 1, `still half-drawn is not news either: ${JSON.stringify(h.broadcasts)}`);
  assert.strictEqual(h.entry.asking.text, 'How wide should the shared-jump wiring be?');
  h.entry.composerLines = DIALOGS.MULTI_QUESTION;
  h.entry.outputSeq = 11;
  h.sweep();
  await h.step();
  assert.strictEqual(h.broadcasts.length, 1);

  // The same question at another width: a different fingerprint, the same words.
  assert.notStrictEqual(askingSummary(DIALOGS.MULTI_FOOTER_ONLY).fp, askingSummary(DIALOGS.MULTI_QUESTION).fp);
  h.entry.composerLines = DIALOGS.MULTI_FOOTER_ONLY;
  h.entry.outputSeq = 2;
  h.sweep();
  await h.step();
  assert.strictEqual(h.broadcasts.length, 1, 'a rewrap is not news');
});

test('a dialog that really is unreadable is reported, one settle later', async () => {
  const h = makeHarness({ waitingForInput: false, screen: 'waiting' });
  h.entry.composerLines = DIALOGS.SINGLE_OPTION;
  h.sweep();
  assert.ok(await h.step());
  assert.deepStrictEqual(h.broadcasts, [], 'the first unreadable read is checked again');
  assert.ok(await h.step());
  assert.strictEqual(h.broadcasts.length, 1);
  assert.deepStrictEqual([h.broadcasts[0].waiting, h.broadcasts[0].asking.kind, h.broadcasts[0].asking.text],
    [true, askingSummary(DIALOGS.SINGLE_OPTION).kind, '']);
});
