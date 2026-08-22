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
  };
  shells.set(ID, entry);

  const context = {
    shells,
    log: (m) => logs.push(m),
    auditWaiting: () => {},
    auditScreenTail: () => '',
    classifyScreenTail,
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

  const delivery = sourceBetween('function deliverPromptWhenReady', "/**\n * True if the session's CURRENT screen shows");
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
  await h.step();
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
