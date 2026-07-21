// Focused unit coverage for Codex session lifecycle helpers embedded in server.js.
//
// These tests evaluate the actual helper declarations without requiring server.js,
// which would bind ports and start background timers at module load.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

function loadCodexHomeHelpers(home) {
  const code = sourceBetween('const CODEX_SHARED_HOME', 'function sessionEnv');
  const context = {
    fs,
    path,
    os: { homedir: () => home },
    log: () => {},
  };
  vm.runInNewContext(`${code}
result = { CODEX_SHARED_ENTRIES, ensureCodexSessionHome, codexSessionHomeHasTranscript }`, context);
  return context.result;
}

function loadArgumentHelpers(home) {
  const code = sourceBetween('const AGENT_CONFIGS', 'function validateWorktree');
  const context = {
    fs,
    path,
    os: { homedir: () => home },
    PORT: 3456,
    AUTH_TOKEN: 'unit-token',
    CLAUDE_SCREEN_MARKERS: {},
    settings: {},
    spawnSession: () => {},
    log: () => {},
  };
  vm.runInNewContext(`${code}
result = { AGENT_CONFIGS, getSpawnArgs, getResumeArgs, mcpConfigArgs }`, context);
  return context.result;
}

function loadReadinessHelpers() {
  const readiness = sourceBetween('const CODEX_MCP_STATUS_RE', '/**\n * Deliver a prompt');
  const stripping = sourceBetween('function stripEscapeSequences', '// --- Screen-state waiting detector');
  const timers = [];
  const shells = new Map();
  const context = {
    shells,
    log: () => {},
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
  };
  vm.runInNewContext(`${stripping}
${readiness}
result = { observeCodexReadiness, codexLoadedPromptRendered }`, context);
  return { ...context.result, shells, timers };
}

function loadSubmitHelpers() {
  const code = sourceBetween('const CODEX_SUBMIT_RETRY_MS', '/**\n * Async wrapper around `gh issue view`')
  const timers = []
  const shells = new Map()
  const context = {
    shells,
    log: () => {},
    auditWaiting: () => {},
    getEngine: () => null,
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
  }
  vm.runInNewContext(`${code}
result = { submitToShell, acknowledgeCodexSubmitOutput }`, context)
  return { ...context.result, shells, timers }
}

test('Codex homes isolate runtime state while sharing user configuration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-codex-home-'));
  const shared = path.join(home, '.codex');
  fs.mkdirSync(path.join(shared, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(shared, 'themes'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'auth.json'), '{}');
  fs.writeFileSync(path.join(shared, 'config.toml'), 'model = "gpt-test"\n');

  const helpers = loadCodexHomeHelpers(home);
  const first = helpers.ensureCodexSessionHome('aaaa1111');
  const second = helpers.ensureCodexSessionHome('bbbb2222');

  assert.notStrictEqual(first, second);
  assert.strictEqual(fs.realpathSync(path.join(first, 'config.toml')), path.join(shared, 'config.toml'));
  assert.strictEqual(fs.realpathSync(path.join(second, 'auth.json')), path.join(shared, 'auth.json'));
  assert.strictEqual(fs.realpathSync(path.join(first, 'agents')), path.join(shared, 'agents'));
  assert.strictEqual(fs.realpathSync(path.join(second, 'themes')), path.join(shared, 'themes'));

  fs.mkdirSync(path.join(first, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(first, 'sessions', 'first.jsonl'), '{}\n');
  assert.strictEqual(fs.existsSync(path.join(second, 'sessions')), false);
  assert.strictEqual(helpers.ensureCodexSessionHome('../escape'), null);
});

test('Codex rollout detection distinguishes resumable and never-started tab homes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-codex-resume-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const helpers = loadCodexHomeHelpers(home);
  helpers.ensureCodexSessionHome('c0de0001');
  helpers.ensureCodexSessionHome('c0de0002');

  const rolloutDir = path.join(home, '.deepsteve', 'codex-sessions', 'c0de0001', 'sessions', '2026', '07', '20');
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(path.join(rolloutDir, 'rollout-test.jsonl'), '{}\n');

  assert.strictEqual(helpers.codexSessionHomeHasTranscript('c0de0001'), true);
  assert.strictEqual(helpers.codexSessionHomeHasTranscript('c0de0002'), false);
  assert.strictEqual(helpers.codexSessionHomeHasTranscript('not-an-id'), false);
});

test('Codex fresh and resume args keep MCP identity scoped to the DeepSteve tab', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-codex-args-'));
  const { AGENT_CONFIGS, getSpawnArgs, getResumeArgs } = loadArgumentHelpers(home);

  assert.strictEqual(AGENT_CONFIGS.codex.initialPromptDelay, 0);
  assert.strictEqual(AGENT_CONFIGS.codex.codexReadiness, true);
  const freshA = Array.from(getSpawnArgs('codex', {
    sessionId: null,
    planMode: false,
    worktree: null,
    shellId: 'aaaa1111',
  }));
  const freshB = Array.from(getSpawnArgs('codex', {
    sessionId: null,
    planMode: false,
    worktree: null,
    shellId: 'bbbb2222',
  }));
  assert.deepStrictEqual(freshA, [
    '-c',
    'mcp_servers.deepsteve.url="http://localhost:3456/mcp?shellId=aaaa1111"',
    '-c',
    'mcp_servers.deepsteve.bearer_token_env_var="DEEPSTEVE_API_TOKEN"',
  ]);
  assert.match(freshB[1], /shellId=bbbb2222/);
  assert.notStrictEqual(freshA[1], freshB[1]);

  assert.deepStrictEqual(Array.from(getResumeArgs('codex', {
    sessionId: null,
    planMode: false,
    worktree: null,
    shellId: 'aaaa1111',
  })), ['resume', '--last', ...freshA]);

  assert.deepStrictEqual(Array.from(getResumeArgs('codex', {
    sessionId: '019f80f9-626d-7463-afcf-cc126f0fbefa',
    planMode: false,
    worktree: null,
    shellId: 'aaaa1111',
  })), ['resume', '019f80f9-626d-7463-afcf-cc126f0fbefa', ...freshA]);
});

test('Claude spawn argument construction is unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-claude-args-'));
  const { getSpawnArgs } = loadArgumentHelpers(home);
  const args = Array.from(getSpawnArgs('claude', {
    sessionId: 'claude-session',
    planMode: true,
    worktree: 'feature-one',
    shellId: 'abcddcba',
  }));

  assert.deepStrictEqual(args.slice(0, 6), [
    '--session-id',
    'claude-session',
    '--permission-mode',
    'plan',
    '--worktree',
    'feature-one',
  ]);
  assert.deepStrictEqual(args.slice(6), [
    '--mcp-config',
    path.join(home, '.deepsteve', 'mcp-configs', 'abcddcba.json'),
  ]);
});

test('Codex waits for the rendered MCP status row to clear before becoming ready', () => {
  const { observeCodexReadiness, shells } = loadReadinessHelpers();
  const entry = { onCodexReadyOnce: () => { entry.deliveries = (entry.deliveries || 0) + 1; } };
  shells.set('codex-a', entry);

  observeCodexReadiness(
    entry,
    'codex-a',
    '\x1b[13;1H\x1b[J\x1b[14;1H•\x1b[14;3HStarting MCP servers (1/2): codex_apps\x1b[17;1H›'
  );
  assert.strictEqual(entry.codexReady, false);
  assert.strictEqual(entry.codexReadinessState.mcpStatusRow, 14);
  assert.strictEqual(entry.deliveries, undefined);

  observeCodexReadiness(entry, 'codex-a', '\x1b[13;1H\x1b[J\x1b[15;1H›');
  assert.strictEqual(entry.codexReady, true);
  assert.strictEqual(entry.deliveries, 1);
});

test('Codex readiness and callbacks stay isolated between concurrent tabs', () => {
  const { observeCodexReadiness, shells } = loadReadinessHelpers();
  const first = { onCodexReadyOnce: () => { first.delivered = true; } };
  const second = { onCodexReadyOnce: () => { second.delivered = true; } };
  shells.set('first', first);
  shells.set('second', second);

  const starting = '\x1b[20;1H•\x1b[20;3HBooting MCP server: deepsteve';
  observeCodexReadiness(first, 'first', starting);
  observeCodexReadiness(second, 'second', starting);
  observeCodexReadiness(first, 'first', '\x1b[19;1H\x1b[J\x1b[22;1H›');

  assert.strictEqual(first.delivered, true);
  assert.strictEqual(second.delivered, undefined);
  assert.strictEqual(second.codexReady, false);
});

test('Codex uses a stable loaded prompt when MCP startup renders no status row', () => {
  const { observeCodexReadiness, shells, timers } = loadReadinessHelpers();
  const entry = { onCodexReadyOnce: () => { entry.delivered = true; } };
  shells.set('codex-fast', entry);

  observeCodexReadiness(
    entry,
    'codex-fast',
    '\x1b[5;1HOpenAI Codex (v0.144.6)\x1b[8;1Hmodel: gpt-5.6-sol\x1b[13;1H›'
  );
  const timer = timers.at(-1);
  assert.strictEqual(timer.ms, 250);
  assert.strictEqual(entry.codexReady, undefined);

  timer.fn();
  assert.strictEqual(entry.codexReady, true);
  assert.strictEqual(entry.delivered, true);
});

test('Codex recognizes an MCP status clear split across PTY chunks', () => {
  const { observeCodexReadiness, shells } = loadReadinessHelpers();
  const entry = { onCodexReadyOnce: () => { entry.delivered = true; } };
  shells.set('codex-split', entry);

  observeCodexReadiness(entry, 'codex-split', '\x1b[12;1H•\x1b[12;3HBooting MCP server: deepsteve');
  observeCodexReadiness(entry, 'codex-split', '\x1b[11;1H\x1b[');
  assert.strictEqual(entry.codexReady, false);
  observeCodexReadiness(entry, 'codex-split', 'J\x1b[14;1H›');

  assert.strictEqual(entry.codexReady, true);
  assert.strictEqual(entry.delivered, true);
});

test('headless scheduled Codex submission retries a silent Enter and stops after its cap', async () => {
  const { submitToShell, shells, timers } = loadSubmitHelpers()
  const writes = []
  const engine = { write: (id, data) => writes.push(data) }
  shells.set('scheduled', { agentType: 'codex' })

  const submitted = submitToShell('scheduled', 'do the scheduled work', engine, { retryCodexEnter: true })
  assert.deepStrictEqual(writes, ['do the scheduled work'])

  const deferredEnter = timers.shift()
  assert.strictEqual(deferredEnter.ms, 1000)
  deferredEnter.fn()
  await submitted
  assert.deepStrictEqual(writes, ['do the scheduled work', '\r'])

  const firstRetry = timers.shift()
  assert.strictEqual(firstRetry.ms, 1500)
  firstRetry.fn()
  assert.deepStrictEqual(writes, ['do the scheduled work', '\r', '\r'])

  const secondRetry = timers.shift()
  secondRetry.fn()
  secondRetry.fn()
  assert.deepStrictEqual(writes, ['do the scheduled work', '\r', '\r', '\r'])
  assert.strictEqual(shells.get('scheduled').codexSubmitRetry, null)
})

test('scheduled Codex retry is cancelled by output from a turn that already started', async () => {
  const { submitToShell, acknowledgeCodexSubmitOutput, shells, timers } = loadSubmitHelpers()
  const writes = []
  const engine = { write: (id, data) => writes.push(data) }
  const entry = { agentType: 'codex' }
  shells.set('started', entry)

  const submitted = submitToShell('started', 'begin once', engine, { retryCodexEnter: true })
  timers.shift().fn()
  await submitted
  const retry = timers.shift()

  acknowledgeCodexSubmitOutput(entry, 'started')
  retry.fn()
  acknowledgeCodexSubmitOutput(entry, 'started')
  assert.deepStrictEqual(writes, ['begin once', '\r'])
  assert.strictEqual(entry.codexSubmitRetry, null)
})

test('Codex recent restores converge on the isolated home identity', () => {
  const code = sourceBetween(
    'function restoreShellIdForRecentSession',
    '// Restore a recent session'
  );
  const context = { randomUUID: () => 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
  vm.runInNewContext(`${code}
result = restoreShellIdForRecentSession`, context);

  assert.strictEqual(context.result({
    agentType: 'codex',
    codexHomeId: 'c0de0001',
  }, () => 'new-id'), 'c0de0001');
  assert.strictEqual(context.result({
    agentType: 'claude',
    codexHomeId: 'c0de0001',
  }, () => 'new-id'), 'new-id');
  assert.strictEqual(context.result({
    agentType: 'codex',
    codexHomeId: '../escape',
  }, () => 'new-id'), 'new-id');
});

test('Codex home identity is included in the canonical persisted shell shape', () => {
  const code = sourceBetween('function serializeShellEntry', '// #561: a session record');
  const context = {};
  vm.runInNewContext(`${code}
result = serializeShellEntry({
  cwd: '/repo',
  claudeSessionId: null,
  agentType: 'codex',
  codexHomeId: 'c0de0001'
})`, context);
  assert.strictEqual(context.result.agentType, 'codex');
  assert.strictEqual(context.result.codexHomeId, 'c0de0001');
  assert.strictEqual(context.result.claudeSessionId, null);
});
