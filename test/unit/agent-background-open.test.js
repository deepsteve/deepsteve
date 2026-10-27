// Unit tests for #741: a tab an agent opens lands in the background.
//
// The browser already knows how to open a tab without focusing it (#600's `background`
// flag on `open-session`); what #741 changes is which opens carry it. The server decides,
// from `agentTabsOpenInBackground`, read live at each open — so these tests flip the
// setting on the same ctx object between calls, exactly as a Settings save does.
//
// Covered here: open_terminal (plain shell, agent, fork), start_issue (which hands the
// decision to startIssueSession), and create_display_tab. The server-side helpers and the
// browser half are exercised end to end, not here — server.js cannot be required.
//
// The fake ctx is the terminal-run-tool.test.js shape: tools.js destructures whatever it
// is given, so an omitted helper is just undefined.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-bg-'));
process.env.HOME = SCRATCH_HOME;
delete process.env.DEEPSTEVE_HOME;

const core = require('../../mods/deepsteve-core/tools.js');
const displayTab = require('../../mods/display-tab/tools.js');
const { createPendingOpens } = require('../../pending-opens.js');

// Since #632 a spawn into a missing cwd is refused before it reaches spawnSession.
const CALLER_CWD = SCRATCH_HOME;
const callerExtra = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });

function makeCore(settings) {
  const shells = new Map([['caller', { cwd: CALLER_CWD, windowId: 'w1', configDir: null, agentType: 'claude', claudeSessionId: 'parent-session' }]]);
  const opened = [];
  const issueStarts = [];
  const tools = core.init({
    shells,
    settings,
    log: () => {},
    getDefaultEngine: () => ({ constructor: { name: 'NodePtyEngine' }, write: () => {}, onExit: () => {} }),
    spawnSession: () => {},
    sessionEnv: (id, meta) => ({ ...meta }),
    getSpawnArgs: () => [],
    mcpConfigArgs: () => [],
    getAgentConfig: () => ({ supportsWorktree: true, supportsSessionWatch: false }),
    validateWorktree: (n) => n,
    resolveForkParentSession: () => 'parent-session',
    maybeInheritRemoteControl: () => {},
    deliverPromptWhenReady: () => {},
    wireShellOutput: () => {},
    emitSessionOpen: () => {},
    saveState: () => {},
    handleShellGone: () => {},
    deliverToWindow: (msg) => { opened.push(msg); return 'window'; },
    noteSpawnDelivery: () => {},
    startIssueSession: (args) => {
      issueStarts.push(args);
      return { id: 'issue1', name: 'n', cwd: CALLER_CWD, worktree: null, tabDelivery: 'window' };
    },
    isShuttingDown: () => false,
  });
  return { tools, opened, issueStarts };
}

const OPEN_TERMINAL_KINDS = [
  ['a plain shell', {}],
  ['an agent', { agent_type: 'claude' }],
  ['a fork', { fork: true }],
];

for (const [kind, args] of OPEN_TERMINAL_KINDS) {
  test(`open_terminal opens ${kind} in the background by default, and in front when the setting is off`, async () => {
    const settings = {}; // absent = the schema default, on
    const c = makeCore(settings);

    await c.tools.open_terminal.handler(args, callerExtra('caller'));
    assert.strictEqual(c.opened.length, 1);
    assert.strictEqual(c.opened[0].type, 'open-session');
    assert.strictEqual(c.opened[0].background, true, 'absent setting → background');

    settings.agentTabsOpenInBackground = false; // live, no re-init — as a Settings save is
    await c.tools.open_terminal.handler(args, callerExtra('caller'));
    assert.strictEqual(c.opened.length, 2);
    assert.ok(!c.opened[1].background, 'setting off → the old focus-on-open');

    settings.agentTabsOpenInBackground = true;
    await c.tools.open_terminal.handler(args, callerExtra('caller'));
    assert.strictEqual(c.opened[2].background, true);
  });
}

test('open_terminal still files the tab under its opener\'s views alongside the background flag', async () => {
  // The flag is merged into the open, not substituted for #726's fields.
  const c = makeCore({});
  await c.tools.open_terminal.handler({}, callerExtra('caller'));
  assert.strictEqual(c.opened[0].openerId, 'caller');
  assert.strictEqual(c.opened[0].background, true);
});

test('start_issue asks startIssueSession for a background open, following the setting', async () => {
  const settings = {};
  const c = makeCore(settings);

  await c.tools.start_issue.handler({ number: 741, title: 'Background opens', body: 'b' }, callerExtra('caller'));
  assert.strictEqual(c.issueStarts.length, 1);
  assert.strictEqual(c.issueStarts[0].background, true);
  assert.strictEqual(c.issueStarts[0].source, 'mcp');

  settings.agentTabsOpenInBackground = false;
  await c.tools.start_issue.handler({ number: 741, title: 'Background opens', body: 'b' }, callerExtra('caller'));
  assert.strictEqual(c.issueStarts[1].background, false);
});

function makeDisplayTab(settings) {
  const sent = [];
  const displayTabs = new Map();
  const tools = displayTab.init({
    shells: new Map(),
    // One connected window, so the open is sent rather than queued.
    reloadClients: new Set([{ readyState: 1, windowId: 'w1', send: (m) => sent.push(JSON.parse(m)) }]),
    pendingOpens: createPendingOpens(),
    settings,
    log: () => {},
    displayTabs,
    setDisplayTab: (id, html) => displayTabs.set(id, html),
    deleteDisplayTab: (id) => displayTabs.delete(id),
    sessionPaths: (e) => ({ cwd: e.cwd }),
    isDisplayTabLocked: () => false,
    setDisplayTabLocked: () => null,
  });
  return { tools, sent };
}

test('create_display_tab opens in the background by default, and in front when the setting is off', async () => {
  const settings = {};
  const d = makeDisplayTab(settings);

  const first = await d.tools.create_display_tab.handler({ session_id: 'nope', html: '<p>one</p>' });
  assert.ok(!first.isError, first.content[0].text);
  const opens = () => d.sent.filter(m => m.type === 'open-display-tab');
  assert.strictEqual(opens().length, 1);
  assert.strictEqual(opens()[0].background, true);

  settings.agentTabsOpenInBackground = false;
  await d.tools.create_display_tab.handler({ session_id: 'nope', html: '<p>two</p>' });
  assert.strictEqual(opens().length, 2);
  assert.ok(!opens()[1].background);
});
