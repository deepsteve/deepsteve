// Unit tests for run_in_terminal, the disposable terminal (#631).
//
// terminal-run.test.js covers the pure module; this covers the MCP handler wrapped
// around it — what reaches spawnSession, when the run is recorded, and above all WHEN
// the tab is torn down, which is the entire point of the issue (0 of 102 terminal tabs
// an agent opened were ever closed by an agent).
//
// The fake ctx is the test/unit/meta-type.test.js shape that merge-auto-close.test.js
// names as canonical: mods/deepsteve-core/tools.js destructures whatever it is given,
// so an omitted helper is just undefined. HOME is repointed BEFORE the require because
// the run log resolves its path from stateDir() — the test/unit/project-mods.test.js
// pattern.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runtool-'));
process.env.HOME = SCRATCH_HOME;
delete process.env.DEEPSTEVE_HOME;

const { init, RUN_TIMINGS } = require('../../mods/deepsteve-core/tools.js');
const { MARKER_PREFIX } = require('../../terminal-run');

RUN_TIMINGS.pollMs = 5;

// The caller's cwd has to be a directory that really exists: since #632 the handler
// refuses a spawn whose cwd is gone, so the old opaque '/repo' placeholder would now
// (correctly) be refused before ever reaching the stub spawnSession. Nothing here is
// about cwd validation — that lives in spawn-cwd.test.js.
const CALLER_CWD = SCRATCH_HOME;
const RUN_LOG = path.join(SCRATCH_HOME, '.deepsteve', 'terminal-runs.jsonl');
const readLog = () => (fs.existsSync(RUN_LOG) ? fs.readFileSync(RUN_LOG, 'utf8').trim().split('\n').map(JSON.parse) : []);
const callerExtra = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });
const parse = (res) => JSON.parse(res.content[0].text);

/**
 * A ctx whose fake screen is driven by the test.
 *
 * `screen` is the interpreted-terminal content the poller sees; a test moves the run
 * along by pushing lines onto it. `finish(code)` appends the marker the wrapper would
 * have printed — the daemon learns the exit status from that line and nowhere else.
 */
function makeContext({ linger = 20000, arm = 'wired', tabDelivery = 'window' } = {}) {
  const shells = new Map([['caller', { cwd: CALLER_CWD, windowId: 'w1', configDir: null }]]);
  const spawns = [];
  const armCalls = [];
  const closes = [];
  const opened = [];
  const screen = [];
  let nonce = null;

  const tools = init({
    shells,
    settings: {},
    log: () => {},
    getDefaultEngine: () => ({
      constructor: { name: 'NodePtyEngine' },
      write: () => {},
      onExit: (id, cb) => { spawns[spawns.length - 1].onExit = cb; },
    }),
    spawnSession: (eng, id, agentType, args, cwd, opts) => {
      nonce = opts.runNonce;
      spawns.push({ id, agentType, cwd, opts });
    },
    sessionEnv: (id, meta) => ({ ...meta }),
    wireShellOutput: () => {},
    emitSessionOpen: () => {},
    saveState: () => {},
    // Mirrors the real one since #680: it returns HOW the tab went out, and the tools
    // put that in their result. A stub returning undefined would let a regression to
    // "success no matter what happened to the tab" pass unnoticed.
    deliverToWindow: (msg) => { opened.push(msg); return tabDelivery; },
    noteSpawnDelivery: () => {},
    handleShellGone: (id, reason) => { shells.delete(id); closes.push({ id, reason, via: 'exit' }); },
    // Returns false without recording anything when the session is already gone, exactly
    // as server.js:5015 does — otherwise the belt-and-braces close on the shell_gone path
    // would look like a real second teardown.
    closeSession: (id, reason) => {
      if (!shells.has(id)) return false;
      shells.delete(id); closes.push({ id, reason, via: 'closeSession' }); return true;
    },
    // `arm: null` omits the hook entirely rather than stubbing it — tools.js destructures
    // whatever it is given, so that is exactly the shape of a ctx that never wired it.
    ...(arm === null ? {} : {
      armSessionAutoClose: (id, opts) => {
        armCalls.push({ id, opts });
        return linger > 0 ? { closeAt: Date.now() + linger } : null;
      },
    }),
    readTerminalScreen: async (entry, lines) => screen.slice(-lines),
    stripEscapeSequences: (s) => s,
    isShuttingDown: () => false,
  });

  return {
    tools, shells, spawns, armCalls, closes, opened, screen,
    get nonce() { return nonce; },
    finish(code) { screen.push(`${MARKER_PREFIX}${nonce} exited ${code}`, '', 'host% '); },
  };
}

test('a finished run returns the output and the exit code, and closes its own tab', async () => {
  const c = makeContext();
  const call = c.tools.run_in_terminal.handler({ command: 'git status --porcelain' }, callerExtra('caller'));

  // The pane's process IS the command: it reaches spawnSession as runCommand, not as
  // keystrokes typed at a prompt 600ms later.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(c.spawns.length, 1);
  assert.strictEqual(c.spawns[0].agentType, 'terminal');
  assert.strictEqual(c.spawns[0].cwd, CALLER_CWD, 'defaults to the caller cwd — the main checkout for a worktree session');
  assert.strictEqual(c.spawns[0].opts.runCommand, 'git status --porcelain');
  assert.match(c.spawns[0].opts.runNonce, /^[0-9a-f]{8}$/);

  // #600: a 200ms `git status` must not steal focus.
  assert.strictEqual(c.opened[0].type, 'open-session');
  assert.strictEqual(c.opened[0].background, true);

  c.screen.push('M  server.js');
  c.finish(0);
  const p = parse(await call);

  assert.strictEqual(p.status, 'finished');
  assert.strictEqual(p.exit_code, 0);
  assert.strictEqual(p.output, 'M  server.js', 'the marker line itself never reaches the caller');
  assert.strictEqual(p.command, 'git status --porcelain');
  assert.ok(p.log_path.endsWith('terminal-runs.jsonl'));

  assert.deepStrictEqual(c.armCalls.map((a) => a.opts), [{ reason: 'terminal-run-finished', policy: 'terminal-run' }],
    'the mod names the situation; the server owns the duration');
  assert.strictEqual(p.auto_close, 'armed');
  assert.ok(p.auto_close_in_seconds > 0);

  // #635: the outcome is persisted, not just returned. Until it was, terminal-runs.jsonl
  // could not answer "why is this tab still open" for a run that had already finished.
  const record = readLog().pop();
  assert.strictEqual(record.auto_close, 'armed');
});

test('a non-zero exit is reported as a value, not an error', async () => {
  const c = makeContext();
  const call = c.tools.run_in_terminal.handler({ command: 'false' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));
  c.finish(3);
  const res = await call;
  assert.strictEqual(res.isError, undefined, 'a command that fails is a successful tool call');
  assert.strictEqual(parse(res).exit_code, 3);
});

test('typing in the tab keeps it — the daemon does not close it', async () => {
  const c = makeContext();
  const call = c.tools.run_in_terminal.handler({ command: 'sleep 1' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));
  const id = c.spawns[0].id;
  // Only real input reaches lastInputTime. Nothing else writes to this PTY (the command
  // arrived in argv and no prompt is ever delivered here), and since #635 the terminal's
  // own replies to tmux's capability probes are filtered out server-side before they can
  // stamp it — it was those, not a person, that took this branch on every run.
  c.shells.get(id).lastInputTime = Date.now();
  c.finish(0);
  const p = parse(await call);

  assert.strictEqual(p.auto_close, 'user_typed');
  assert.strictEqual(p.auto_close_in_seconds, null);
  assert.deepStrictEqual(c.armCalls, []);
  assert.deepStrictEqual(c.closes, []);
  assert.ok(c.shells.has(id), 'the tab is the user\'s now');
});

test('a shell already gone at finalize reports it instead of leaking silently', async () => {
  // #635's acceptance criterion: this branch used to neither arm nor close and returned
  // the same bare null as every other outcome, so a genuinely leaked tab was invisible.
  const c = makeContext();
  const call = c.tools.run_in_terminal.handler({ command: 'echo hi' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));
  const id = c.spawns[0].id;

  // The command ran to completion — its marker is in the transcript — but the pane was
  // reaped before the poller could finalize, so handleShellGone has already tombstoned
  // the session and told the browser to close the tab. The tool reads the run off the
  // exit snapshot and must still report what became of the tab.
  c.shells.get(id).scrollback = [`hi\n${MARKER_PREFIX}${c.nonce} exited 0\n`];
  c.spawns[0].onExit();
  const p = parse(await call);

  assert.strictEqual(p.status, 'finished', 'the marker survived in the exit snapshot');
  assert.strictEqual(p.exit_code, 0);
  assert.strictEqual(p.auto_close, 'shell_gone');
  assert.deepStrictEqual(c.armCalls, [], 'nothing to arm — the session is gone');
  assert.deepStrictEqual(c.closes, [{ id, reason: 'terminal-run-ended', via: 'exit' }],
    'the belt-and-braces close is a no-op, not a second teardown');
  assert.strictEqual(readLog().pop().auto_close, 'shell_gone');
});

test('a run with no auto-close hook wired still closes its tab', async () => {
  // The issue named this as a candidate cause. It is not what happened, but a ctx
  // missing the hook must not be a silent leak either.
  const c = makeContext({ arm: null });
  const call = c.tools.run_in_terminal.handler({ command: 'echo hi' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));
  c.finish(0);
  const p = parse(await call);

  assert.strictEqual(p.auto_close, 'closed_immediately');
  assert.deepStrictEqual(c.closes, [{ id: c.spawns[0].id, reason: 'terminal-run-finished', via: 'closeSession' }]);
});

test('with the linger set to 0 the tab closes immediately instead of leaking', async () => {
  // arm() returns null for a delay of 0 on a session we just read as live, so the
  // handler must fall through to an outright close rather than treat it as "nothing
  // to do" — which would put back the exact leak this feature closes.
  const c = makeContext({ linger: 0 });
  const call = c.tools.run_in_terminal.handler({ command: 'echo hi' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));
  c.finish(0);
  const p = parse(await call);

  assert.strictEqual(p.auto_close_in_seconds, null);
  assert.strictEqual(p.auto_close, 'closed_immediately');
  assert.deepStrictEqual(c.closes, [{ id: c.spawns[0].id, reason: 'terminal-run-finished', via: 'closeSession' }]);
});

test('a command that exits the shell reports unknown rather than guessing a code', async () => {
  const c = makeContext();
  const call = c.tools.run_in_terminal.handler({ command: 'printf hi; exit 3' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));

  // No marker: the shell died before the printf ran. The tool's onExit hook snapshots
  // the transcript synchronously, because handleShellGone disposes the screen.
  const id = c.spawns[0].id;
  c.shells.get(id).scrollback = ['hi\n'];
  c.spawns[0].onExit();
  const p = parse(await call);

  assert.strictEqual(p.status, 'gone');
  assert.strictEqual(p.exit_code, null, 'unknown, never assumed');
  assert.strictEqual(p.output, 'hi');
  assert.deepStrictEqual(c.armCalls, [], 'the session is already gone — nothing to arm');
  assert.strictEqual(p.auto_close, 'shell_gone');
});

test('a timeout returns partial output and leaves the run cleaning up after itself', async () => {
  const c = makeContext();
  const call = c.tools.run_in_terminal.handler(
    { command: 'sleep 30', timeout_seconds: 0.05 }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));
  c.screen.push('halfway through');

  const p = parse(await call);
  assert.strictEqual(p.status, 'running');
  assert.strictEqual(p.exit_code, null);
  assert.strictEqual(p.output, 'halfway through');
  assert.match(p.note, /closes itself/, 'the caller is told not to clean up');
  assert.strictEqual(p.run_id, undefined, 'no completion record exists yet');

  // The watcher is still going: the run is recorded and the tab still torn down.
  c.finish(0);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(c.armCalls.length, 1, 'the close still happens after the tool call returned');
});

test('every run is recorded twice — once at launch, once at the end', async () => {
  const c = makeContext();
  const before = readLog().length;
  const call = c.tools.run_in_terminal.handler({ command: 'echo audit-me' }, callerExtra('caller'));
  await new Promise((r) => setImmediate(r));

  // The launch record exists before the command has finished, which is what makes the
  // audit trail survive a daemon that dies mid-run.
  const mid = readLog();
  assert.strictEqual(mid.length, before + 1);
  assert.strictEqual(mid[mid.length - 1].status, 'started');
  assert.strictEqual(mid[mid.length - 1].command, 'echo audit-me');
  assert.strictEqual(mid[mid.length - 1].caller, 'caller');

  c.screen.push('audit output');
  c.finish(0);
  await call;

  const after = readLog();
  assert.strictEqual(after.length, before + 2);
  assert.strictEqual(after[after.length - 1].status, 'finished');
  assert.strictEqual(after[after.length - 1].exit_code, 0);
  assert.strictEqual(after[after.length - 1].output, 'audit output');
  assert.strictEqual(after[after.length - 1].session_id, c.spawns[0].id);
});

test('an unknown caller and an empty command are errors, not silent tabs', async () => {
  const c = makeContext();
  const noCaller = await c.tools.run_in_terminal.handler({ command: 'echo hi' }, callerExtra('nope'));
  assert.strictEqual(noCaller.isError, true);
  const noCommand = await c.tools.run_in_terminal.handler({ command: '   ' }, callerExtra('caller'));
  assert.strictEqual(noCommand.isError, true);
  assert.strictEqual(c.spawns.length, 0, 'neither spawned anything');
});

test('open_terminal still returns its old fields, plus a cleanup reminder naming the id', async () => {
  const c = makeContext();
  const p = parse(await c.tools.open_terminal.handler({ command: 'npm run dev' }, callerExtra('caller')));

  assert.strictEqual(p.cwd, CALLER_CWD);
  assert.strictEqual(p.command, 'npm run dev');
  assert.strictEqual(p.worktree, null);
  assert.ok(p.id);
  // The point-of-use ask (#631): a doc three files away does not reach the model that
  // is holding the id.
  assert.match(p.cleanupReminder, /close_session/);
  assert.ok(p.cleanupReminder.includes(p.id), 'it names the id the agent must pass');
  assert.match(p.cleanupReminder, /run_in_terminal/);
  // #680: spawning a session and opening a tab for it are two events. The result used
  // to report only the first, so an agent could truthfully say "done" about a PTY while
  // no browser had ever heard of the tab.
  assert.strictEqual(p.tabDelivery, 'window');
  assert.strictEqual(p.note, undefined, 'a tab that went where it was asked needs no caveat');
});

test('#680: a tab nobody received comes back with a caveat, not a bare success', async () => {
  const c = makeContext({ tabDelivery: 'queued' });
  const p = parse(await c.tools.open_terminal.handler({ command: 'npm run dev' }, callerExtra('caller')));

  assert.ok(p.id, 'the session still spawned — that part did succeed');
  assert.strictEqual(p.tabDelivery, 'queued');
  assert.match(p.note, /no browser window was connected/i);
  assert.match(p.note, /do not tell the user a tab is open/i,
    'the agent is told what NOT to claim, since that is the failure this closes');
});

// --- drift guards on the prose, the merge-auto-close.test.js precedent ------------

test('the tool descriptions still point one-shot work away from open_terminal', () => {
  const c = makeContext();
  const openDesc = c.tools.open_terminal.description;
  assert.match(openDesc, /close_session/, 'open_terminal must say who closes the tab');
  assert.match(openDesc, /run_in_terminal/, 'and name the disposable alternative');
  assert.match(c.tools.open_terminal.schema.command.description, /run_in_terminal/,
    'the `command` param is where "the tab stays open afterward" used to read as fine');
  assert.match(c.tools.run_in_terminal.description, /closes itself|closes its own tab/);
});

test('skills and docs still name run_in_terminal', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  assert.match(read('skills/terminal.md'), /run_in_terminal/);
  // Ordering is load-bearing in merge.md: cleanup must precede step 9, whose own text
  // warns that anything after close_session is cut off.
  const merge = read('skills/merge.md');
  assert.match(merge, /run_in_terminal/);
  assert.ok(merge.indexOf('8b.') < merge.indexOf('9. **Report and close this session'),
    'the cleanup step must come before the self-close step');
  assert.match(read('docs/agents.md'), /run_in_terminal/);
  // mods/deepsteve-core/mod.json used to carry a second declaration of this tool with a
  // short description of its own. #644 made tools.js the only declaration, so the manifest
  // now names no tool at all — the live definition is asserted above, and GET /api/mods
  // derives the inventory from it.
  assert.ok(!('tools' in JSON.parse(read('mods/deepsteve-core/mod.json'))),
    'the manifest must not re-declare tools — tools.js is the source of truth (#644)');
});
