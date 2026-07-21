// Unit tests for the deepsteve-core MCP tools around meta_type (#519):
// control-key mapping, truthful state/landed reporting, wait_for_idle, the
// Meta Controls consent path, and read_session_screen. Drives the tool
// handlers directly through init(mockContext) — no server, no PTYs.
//
// Run: node --test test/unit/meta-type.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { init, TIMINGS } = require('../../mods/deepsteve-core/tools.js');
const { TerminalScreen } = require('../../terminal-screen');

// Shrink the real delays so the suite runs in milliseconds.
TIMINGS.keyGapMs = 5;
TIMINGS.settleMs = 5;
TIMINGS.waitForIdleMs = 200;
TIMINGS.idlePollMs = 10;

// Mirror of server.js stripEscapeSequences (module-local there; the tools
// receive it via the MCP context, so tests supply the same implementation).
function stripEscapeSequences(data) {
  return data
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[78DMHNOcn=><]/g, '');
}

function makeEntry({ waiting = true, agentType = 'claude', scrollback = [] } = {}) {
  const entry = {
    agentType,
    waitingForInput: waiting,
    lastActivity: Date.now(),
    scrollback: [...scrollback],
    cwd: '/tmp/proj',
    createdAt: Date.now(),
    writes: [],
  };
  entry.engine = { write: (id, data) => entry.writes.push(data) };
  return entry;
}

function makeContext({ metaControlsEnabled = true, consentOutcome = 'confirmed', echo = true } = {}) {
  const shells = new Map();
  const settings = { metaControlsEnabled };
  const consentCalls = [];
  const submitCalls = [];
  const tools = init({
    shells,
    settings,
    log: () => {},
    stripEscapeSequences,
    // Matches the server's semantics: non-BEL agent types are 'unknown'.
    readTerminalScreen: async (entry, lines) => {
      if (!entry.terminalScreen) {
        entry.terminalScreen = new TerminalScreen();
        for (const chunk of entry.scrollback || []) entry.terminalScreen.write(chunk);
      }
      return entry.terminalScreen.lines(lines);
    },
    sessionInputState: (entry) =>
      entry.agentType === 'claude' ? (entry.waitingForInput ? 'idle' : 'busy') : 'unknown',
    submitToShell: async (id, text) => {
      submitCalls.push({ id, text });
      const e = shells.get(id);
      if (e) {
        e.writes.push(text, '\r');
        if (echo) e.scrollback.push(text); // simulate the PTY echoing the input
      }
    },
    requestMetaControlsConsent: async (args) => {
      consentCalls.push(args);
      if (consentOutcome === 'confirmed') settings.metaControlsEnabled = true;
      return consentOutcome;
    },
    sessionPaths: (entry) => ({ cwd: entry.cwd, repoRoot: entry.cwd }),
    getForegroundCommand: () => null,
    maybeInheritRemoteControl: () => {},
  });
  return { tools, shells, settings, consentCalls, submitCalls };
}

function callerExtra(shellId) {
  return { requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// --- meta_type: input validation ---

test('meta_type with neither text nor keys is rejected', async () => {
  const { tools, shells } = makeContext();
  shells.set('abc', makeEntry());
  const res = await tools.meta_type.handler({}, callerExtra('abc'));
  assert.match(res.content[0].text, /provide `text` and\/or `keys`/);
});

test('meta_type rejects unknown key names without typing or prompting for consent', async () => {
  const { tools, shells, consentCalls } = makeContext({ metaControlsEnabled: false });
  const entry = makeEntry();
  shells.set('abc', entry);
  const res = await tools.meta_type.handler({ keys: ['Escape', 'Bogus'] }, callerExtra('abc'));
  assert.match(res.content[0].text, /Unknown key "Bogus"/);
  assert.deepStrictEqual(entry.writes, []);
  assert.strictEqual(consentCalls.length, 0, 'malformed calls must not show the consent dialog');
});

test('meta_type on a missing session reports not found', async () => {
  const { tools } = makeContext();
  const res = await tools.meta_type.handler({ text: 'hi' }, callerExtra('nope'));
  assert.match(res.content[0].text, /not found/);
});

// --- meta_type: key mapping and ordering ---

test('meta_type sends mapped key bytes in order, before text', async () => {
  const { tools, shells } = makeContext();
  const entry = makeEntry();
  shells.set('abc', entry);
  const res = await tools.meta_type.handler(
    { keys: ['Escape', 'C-c', 'Up', 'Enter'], text: '/rc' },
    callerExtra('abc'),
  );
  assert.deepStrictEqual(entry.writes, ['\x1b', '\x03', '\x1b[A', '\r', '/rc', '\r']);
  const out = parse(res);
  assert.deepStrictEqual(out.keys_sent, ['Escape', 'C-c', 'Up', 'Enter']);
  assert.strictEqual(out.submitted, true);
});

test('meta_type clear_first prepends a single Escape', async () => {
  const { tools, shells } = makeContext();
  const entry = makeEntry();
  shells.set('abc', entry);
  const res = await tools.meta_type.handler(
    { clear_first: true, text: 'hello', submit: false },
    callerExtra('abc'),
  );
  assert.deepStrictEqual(entry.writes, ['\x1b', 'hello']);
  const out = parse(res);
  assert.deepStrictEqual(out.keys_sent, ['Escape']);
  assert.strictEqual(out.submitted, false);
});

test('meta_type keys-only call does not submit and reports landed=null', async () => {
  const { tools, shells } = makeContext();
  const entry = makeEntry();
  shells.set('abc', entry);
  const res = await tools.meta_type.handler({ keys: ['Escape'] }, callerExtra('abc'));
  assert.deepStrictEqual(entry.writes, ['\x1b']);
  const out = parse(res);
  assert.strictEqual(out.submitted, false);
  assert.strictEqual(out.landed, null);
});

// --- meta_type: truthful state + landed ---

test('meta_type reports state_before=busy but still types without wait_for_idle', async () => {
  const { tools, shells, submitCalls } = makeContext();
  shells.set('abc', makeEntry({ waiting: false }));
  const res = await tools.meta_type.handler({ text: 'hi' }, callerExtra('abc'));
  const out = parse(res);
  assert.strictEqual(out.state_before, 'busy');
  assert.strictEqual(submitCalls.length, 1);
});

test('meta_type reports landed=true when the text echoes back in scrollback', async () => {
  const { tools, shells } = makeContext({ echo: true });
  shells.set('abc', makeEntry());
  const out = parse(await tools.meta_type.handler({ text: 'echo hi' }, callerExtra('abc')));
  assert.strictEqual(out.landed, true);
});

test('meta_type reports landed=false when the input was swallowed', async () => {
  const { tools, shells } = makeContext({ echo: false });
  shells.set('abc', makeEntry());
  const out = parse(await tools.meta_type.handler({ text: 'echo hi' }, callerExtra('abc')));
  assert.strictEqual(out.landed, false);
});

test('meta_type state is unknown for non-BEL agent types', async () => {
  const { tools, shells } = makeContext();
  shells.set('abc', makeEntry({ agentType: 'terminal', waiting: false }));
  const out = parse(await tools.meta_type.handler({ text: 'ls', wait_for_idle: true }, callerExtra('abc')));
  // unknown state skips the wait entirely
  assert.strictEqual(out.state_before, 'unknown');
  assert.strictEqual(out.submitted, true);
});

// --- meta_type: wait_for_idle ---

test('meta_type wait_for_idle types once the session goes idle', async () => {
  const { tools, shells, submitCalls } = makeContext();
  const entry = makeEntry({ waiting: false });
  shells.set('abc', entry);
  setTimeout(() => { entry.waitingForInput = true; }, 50);
  const out = parse(await tools.meta_type.handler({ text: 'hi', wait_for_idle: true }, callerExtra('abc')));
  assert.strictEqual(out.state_before, 'busy');
  assert.strictEqual(out.submitted, true);
  assert.strictEqual(submitCalls.length, 1);
});

test('meta_type wait_for_idle times out truthfully without typing', async () => {
  const { tools, shells, submitCalls } = makeContext();
  const entry = makeEntry({ waiting: false });
  shells.set('abc', entry);
  const out = parse(await tools.meta_type.handler({ text: 'hi', wait_for_idle: true }, callerExtra('abc')));
  assert.strictEqual(out.timed_out_waiting, true);
  assert.strictEqual(out.submitted, false);
  assert.strictEqual(out.landed, false);
  assert.strictEqual(submitCalls.length, 0);
  assert.deepStrictEqual(entry.writes, []);
});

// --- meta_type: Meta Controls consent ---

test('meta_type asks for consent when the gate is off and proceeds on confirm', async () => {
  const { tools, shells, consentCalls, submitCalls } = makeContext({ metaControlsEnabled: false, consentOutcome: 'confirmed' });
  shells.set('abc', makeEntry());
  shells.set('tgt', makeEntry());
  const out = parse(await tools.meta_type.handler({ text: 'hi', session_id: 'tgt' }, callerExtra('abc')));
  assert.deepStrictEqual(consentCalls, [{ requesterId: 'abc', targetId: 'tgt' }]);
  assert.strictEqual(out.submitted, true);
  assert.strictEqual(submitCalls.length, 1);
});

test('meta_type refuses without typing when consent is declined', async () => {
  const { tools, shells, submitCalls } = makeContext({ metaControlsEnabled: false, consentOutcome: 'declined' });
  const entry = makeEntry();
  shells.set('abc', entry);
  const res = await tools.meta_type.handler({ text: 'hi' }, callerExtra('abc'));
  assert.match(res.content[0].text, /Meta Controls is disabled/);
  assert.match(res.content[0].text, /declined/);
  assert.strictEqual(submitCalls.length, 0);
  assert.deepStrictEqual(entry.writes, []);
});

test('meta_type explains when no browser is connected to approve', async () => {
  const { tools, shells } = makeContext({ metaControlsEnabled: false, consentOutcome: 'no-clients' });
  shells.set('abc', makeEntry());
  const res = await tools.meta_type.handler({ text: 'hi' }, callerExtra('abc'));
  assert.match(res.content[0].text, /No browser window is connected/);
});

// --- read_session_screen ---

test('read_session_screen returns stripped tail lines with state', async () => {
  const { tools, shells } = makeContext();
  const entry = makeEntry({
    scrollback: ['\x1b[2Jline one\r\nline \x1b[1mtwo\x1b[0m\r\n', 'line three\r\n\r\n'],
  });
  shells.set('abc', entry);
  const out = parse(await tools.read_session_screen.handler({}, callerExtra('abc')));
  assert.strictEqual(out.state, 'idle');
  assert.deepStrictEqual(out.lines, ['line one', 'line two', 'line three']);
  assert.strictEqual(typeof out.seconds_since_output, 'number');
});

test('read_session_screen honors and clamps the lines param', async () => {
  const { tools, shells } = makeContext();
  const many = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\r\n');
  shells.set('abc', makeEntry({ scrollback: [many] }));
  const two = parse(await tools.read_session_screen.handler({ lines: 2 }, callerExtra('abc')));
  assert.deepStrictEqual(two.lines, ['l298', 'l299']);
  const clamped = parse(await tools.read_session_screen.handler({ lines: 9999 }, callerExtra('abc')));
  assert.strictEqual(clamped.lines.length, 200);
});

test('read_session_screen on a missing session reports not found', async () => {
  const { tools } = makeContext();
  const res = await tools.read_session_screen.handler({}, callerExtra('nope'));
  assert.match(res.content[0].text, /not found/);
});

// --- get_session_info additions ---

test('get_session_info reports state and metaControls', async () => {
  const { tools, shells } = makeContext({ metaControlsEnabled: false });
  shells.set('abc', makeEntry({ waiting: false }));
  const out = parse(await tools.get_session_info.handler({ session_id: 'abc' }));
  assert.strictEqual(out.state, 'busy');
  assert.strictEqual(out.metaControls, false);
});
