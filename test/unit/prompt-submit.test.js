// #607 — confirmed prompt submission: echo-gated Enter, then verify-and-retry.
//
// Drives the real server.js helpers by extracting their source range and running it
// in a vm with fake timers and a fake clock (the same trick codex-lifecycle.test.js
// uses, since server.js exports nothing and binds ports at module load). Nothing
// here consumes wall-clock time: every setTimeout lands in an array and `step()`
// fires the earliest one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { readComposerDraft, isPromptStaged, isPromptOnScreen } = require('../../composer-state');
const F = require('./fixtures/composer-screens');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

// Shrunk timings. screenReadMs is pushed far into the future so the bounding timer
// of a screen read never becomes the earliest pending timer and never steals a step.
const ENV = {
  DEEPSTEVE_SUBMIT_ECHO_MIN_MS: '300',
  DEEPSTEVE_SUBMIT_ECHO_POLL_MS: '100',
  DEEPSTEVE_SUBMIT_ECHO_MAX_MS: '1000',
  DEEPSTEVE_SUBMIT_ECHO_SETTLE_MS: '50',
  DEEPSTEVE_SUBMIT_SCREEN_READ_MS: '1000000',
  DEEPSTEVE_SUBMIT_VERIFY_MS: '400',
  DEEPSTEVE_SUBMIT_VERIFY_POLL_MS: '100',
  DEEPSTEVE_SUBMIT_VERIFY_RETRIES: '2',
};

const ID = 'sh0rt1d';
const PROMPT = [
  'Work on GitHub issue #607: start_issue prompt sometimes never submits under load / many tabs',
  '',
  '## Summary',
  'When a lot of tabs are open the prompt does not always get submitted.',
].join('\n');

// `autoOutput` models a child that keeps repainting: every timer tick bumps
// entry.outputSeq. The echo tests drive outputSeq by hand instead, because "no output
// yet" is precisely what they assert on.
function makeHarness({ agentType = 'claude', screen = F.EMPTY_COMPOSER, state = 'waiting', promptSubmitVerify = true, autoOutput = false } = {}) {
  const timers = [];
  const writes = [];
  const logs = [];
  const shells = new Map();
  let now = 0;

  const view = { screen, state };
  const engine = { write: (id, data) => { writes.push(data); } };
  const entry = {
    agentType,
    engine,
    outputSeq: 0,
    lastInputTime: 0,
    killed: false,
    // Only the shape promptScreenView touches.
    terminalScreen: { lines: async () => view.screen },
  };
  shells.set(ID, entry);

  const context = {
    shells,
    log: (m) => logs.push(m),
    auditWaiting: () => {},
    auditScreenTail: () => '',
    getEngine: () => engine,
    process: { env: ENV },
    settings: { promptSubmitVerify },
    getAgentConfig: (t) => ({ screenMarkers: t === 'claude' ? {} : undefined }),
    classifyScreenState: () => view.state,
    readComposerDraft,
    isPromptStaged,
    isPromptOnScreen,
    Date: { now: () => now },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, at: now + ms, cleared: false };
      timers.push(t);
      return t;
    },
  };

  const code = sourceBetween('const CODEX_SUBMIT_RETRY_MS', '/**\n * Async wrapper around `gh issue view`');
  vm.runInNewContext(`${code}
result = { submitToShell, submitWithConfirmedEnter, confirmPromptSubmitted, promptSubmitConfirmEnabled, SUBMIT_TIMINGS }`, context);

  const h = {
    ...context.result,
    shells, timers, writes, logs, entry, engine, view,
    get now() { return now; },
    // Fire the earliest live timer, then let the microtask queue drain so the async
    // helper advances to its next await.
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
      if (autoOutput) entry.outputSeq++;
      t.fn();
      await new Promise((r) => setImmediate(r));
      return true;
    },
    async drain(max = 200) {
      for (let i = 0; i < max; i++) if (!(await h.step())) return;
      throw new Error('timers did not settle');
    },
  };
  return h;
}

// --- submitToShell: the legacy path is untouched ---------------------------

test('without confirmEcho the legacy fixed 1000ms deferred Enter is unchanged', async () => {
  const h = makeHarness();
  let screenReads = 0;
  h.entry.terminalScreen = { lines: async () => { screenReads++; return F.EMPTY_COMPOSER; } };

  const submitted = h.submitToShell(ID, PROMPT, h.engine, {});
  assert.deepStrictEqual(h.writes, [PROMPT], 'text goes out first, synchronously');

  await h.step();
  await submitted;
  assert.deepStrictEqual(h.writes, [PROMPT, '\r']);
  assert.strictEqual(h.timers[0].ms, 1000, 'still the 1s gap — this is killShell\'s /exit contract');
  assert.strictEqual(screenReads, 0, 'the legacy path never reads the screen');
});

// --- Layer 2: echo-confirmed Enter -----------------------------------------

test('the text is written alone before anything else', async () => {
  const h = makeHarness();
  h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });
  assert.deepStrictEqual(h.writes, [PROMPT]);
});

test('Enter waits for the composer to echo, then goes out as its own write', async () => {
  const h = makeHarness({ screen: F.EMPTY_COMPOSER });
  const submitted = h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });

  // Two polls with no output at all: the child hasn't read us, so no Enter.
  await h.step();
  await h.step();
  assert.deepStrictEqual(h.writes, [PROMPT], 'no Enter while the composer is empty');

  // The child reads our text and repaints the composer.
  h.entry.outputSeq++;
  h.view.screen = F.STAGED_WRAPPED;

  await h.drain();
  await submitted;
  assert.deepStrictEqual(h.writes, [PROMPT, '\r']);
  assert.ok(h.logs.some((m) => m.includes('Enter after echo')), h.logs.join('\n'));
  assert.ok(h.now >= 300, `Enter must respect the min gap, sent at ${h.now}ms`);
});

test('output alone is not enough — the composer must show something', async () => {
  const h = makeHarness({ screen: F.EMPTY_COMPOSER });
  h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });
  h.entry.outputSeq++;   // the child produced output, but the composer stayed empty

  await h.step();
  await h.step();
  await h.step();
  await h.step();
  assert.deepStrictEqual(h.writes, [PROMPT], 'an empty composer is not an echo');
});

test('a composer that never echoes still gets Enter at the cap', async () => {
  const h = makeHarness({ screen: F.EMPTY_COMPOSER });
  const submitted = h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });
  await h.drain();
  await submitted;
  assert.deepStrictEqual(h.writes, [PROMPT, '\r']);
  assert.ok(h.logs.some((m) => m.includes('Enter after timeout')), h.logs.join('\n'));
  assert.ok(h.now >= 1000, `should have used the full cap, stopped at ${h.now}ms`);
});

test('a collapsed paste counts as an echo', async () => {
  const h = makeHarness({ screen: F.PASTE_COLLAPSED });
  const submitted = h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });
  h.entry.outputSeq++;
  await h.drain();
  await submitted;
  assert.deepStrictEqual(h.writes, [PROMPT, '\r']);
  assert.ok(h.logs.some((m) => m.includes('Enter after echo')));
});

test('a shell killed mid-echo-wait stops cold and still resolves', async () => {
  const h = makeHarness();
  const submitted = h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });
  h.shells.delete(ID);
  await h.drain();
  await submitted;
  assert.deepStrictEqual(h.writes, [PROMPT], 'no Enter written after the tab went away');
});

test('a shell marked killed mid-echo-wait stops cold', async () => {
  const h = makeHarness();
  const submitted = h.submitToShell(ID, PROMPT, h.engine, { confirmEcho: true });
  h.entry.killed = true;
  await h.drain();
  await submitted;
  assert.deepStrictEqual(h.writes, [PROMPT]);
});

// --- Layer 3: verify and retry ---------------------------------------------

test('a still-staged prompt at an idle agent gets Enter again — and never the text', async () => {
  const h = makeHarness({ screen: F.STAGED_WRAPPED, state: 'waiting', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'stuck');
  assert.deepStrictEqual(h.writes, ['\r', '\r'], 'exactly the retry cap, Enter only');
  assert.strictEqual(h.writes.filter((w) => w === PROMPT).length, 0, 'the text is never re-sent');
});

test('a frozen child does not get its stale pre-Enter frame read as success', async () => {
  // The composer looks empty because the child has not painted since before we typed,
  // not because it submitted. Declaring success here is the exact #607 misread.
  // The window extends while the child is silent, then judges the frame it finally
  // paints — which still holds our prompt — and re-sends Enter.
  const h = makeHarness({ screen: F.EMPTY_COMPOSER, state: 'waiting', autoOutput: false });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  for (let i = 0; i < 8; i++) await h.step();
  assert.deepStrictEqual(h.writes, [], 'no verdict and no Enter while the screen is frozen');

  h.view.screen = F.STAGED_WRAPPED;   // the child finally catches up
  h.entry.outputSeq++;
  await h.drain();
  assert.notStrictEqual(await verdict, 'submitted', 'a staged prompt was never a success');
  assert.ok(h.writes.length >= 1, 'the stuck prompt got another Enter');
  assert.ok(h.writes.every((w) => w === '\r'), 'recovery is Enter only, never the text');
});

test('a permanently dead child gives up instead of retrying forever', async () => {
  const h = makeHarness({ screen: F.EMPTY_COMPOSER, state: 'waiting', autoOutput: false });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'unverified');
  assert.deepStrictEqual(h.writes, [], 'never retried into a screen we could not read');
});

test('an empty composer with no trace of the prompt anywhere is indeterminate, not success', async () => {
  // Nothing on this screen says the agent ever saw the prompt. Both verdicts are
  // wrong to assert, so the fail-closed answer is "unverified" — and either way, no
  // Enter is sent into a screen we could not interpret.
  const h = makeHarness({ screen: F.EMPTY_COMPOSER, state: 'waiting', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'unverified');
  assert.deepStrictEqual(h.writes, []);
});

test('THE DOUBLE-SUBMIT GUARD: a transcript echo of the submitted prompt is not a retry trigger', async () => {
  const h = makeHarness({ screen: F.SUBMITTED_TRANSCRIPT_ECHO, state: 'waiting', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'submitted');
  assert.deepStrictEqual(h.writes, []);
});

test('a working agent bails out even with the draft still on screen', async () => {
  const h = makeHarness({ screen: F.STAGED_WRAPPED, state: 'working', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'submitted');
  assert.deepStrictEqual(h.writes, []);
});

test('an undecidable screen is never retried into', async () => {
  const h = makeHarness({ screen: F.STARTUP_BANNER, state: 'unknown', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'unverified');
  assert.deepStrictEqual(h.writes, []);
});

test('someone else typing aborts the verification', async () => {
  const h = makeHarness({ screen: F.STAGED_WRAPPED, state: 'waiting', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  h.entry.lastInputTime = 12345;    // the user hit "Enable input", or meta_type typed
  await h.drain();
  assert.strictEqual(await verdict, 'aborted');
  assert.deepStrictEqual(h.writes, []);
});

test('a shell killed mid-verify aborts without writing', async () => {
  const h = makeHarness({ screen: F.STAGED_WRAPPED, state: 'waiting', autoOutput: true });
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  h.shells.delete(ID);
  await h.drain();
  assert.strictEqual(await verdict, 'aborted');
  assert.deepStrictEqual(h.writes, []);
});

test('an engine that throws on the retry Enter aborts instead of rejecting', async () => {
  const h = makeHarness({ screen: F.STAGED_WRAPPED, state: 'waiting', autoOutput: true });
  h.entry.engine = { write: () => { throw new Error('EIO'); } };
  const verdict = h.confirmPromptSubmitted(ID, PROMPT, { verify: true });
  await h.drain();
  assert.strictEqual(await verdict, 'aborted');
});

test('verify:false is a no-op', async () => {
  const h = makeHarness({ screen: F.STAGED_WRAPPED, state: 'waiting', autoOutput: true });
  assert.strictEqual(await h.confirmPromptSubmitted(ID, PROMPT, { verify: false }), 'skipped');
  assert.deepStrictEqual(h.writes, []);
});

// --- gating -----------------------------------------------------------------

test('the confirmed-submit path is claude-only and honours the kill-switch', () => {
  const claude = makeHarness({ agentType: 'claude' });
  assert.strictEqual(claude.promptSubmitConfirmEnabled(claude.entry), true);

  const terminal = makeHarness({ agentType: 'terminal' });
  assert.strictEqual(terminal.promptSubmitConfirmEnabled(terminal.entry), false,
    'a plain terminal classifies unknown forever — it must never be retried into');

  const off = makeHarness({ promptSubmitVerify: false });
  assert.strictEqual(off.promptSubmitConfirmEnabled(off.entry), false);

  const dead = makeHarness();
  dead.entry.killed = true;
  assert.strictEqual(dead.promptSubmitConfirmEnabled(dead.entry), false);
  assert.strictEqual(dead.promptSubmitConfirmEnabled(null), false);
});

test('timing knobs are env-overridable and stay inside the 60s input-block budget', () => {
  const h = makeHarness();
  const t = h.SUBMIT_TIMINGS;
  assert.strictEqual(t.echoPollMs, 100, 'env override applied');
  assert.strictEqual(t.verifyRetries, 2);
  // Mirrors the budget comment in server.js: readiness deadline + echo cap +
  // verify must stay under the 60s inputBlockTimer / client banner.
  const deadline = parseInt(String(serverSource.match(/DEEPSTEVE_PROMPT_READY_DEADLINE_MS, 10\) \|\| (\d+)/)[1]), 10);
  const echoMax = parseInt(String(serverSource.match(/DEEPSTEVE_SUBMIT_ECHO_MAX_MS', (\d+)\)/)[1]), 10);
  const verifyMs = parseInt(String(serverSource.match(/DEEPSTEVE_SUBMIT_VERIFY_MS', (\d+)\)/)[1]), 10);
  const retries = parseInt(String(serverSource.match(/DEEPSTEVE_SUBMIT_VERIFY_RETRIES', (\d+)\)/)[1]), 10);
  // verifyRetries + 2 mirrors confirmPromptSubmitted's hardDeadline, which is the
  // real worst case (one extra window's worth of silence-extension).
  assert.ok(deadline + echoMax + verifyMs * (retries + 2) < 60000,
    'production defaults must fit inside the 60s inputBlockTimer');
});
