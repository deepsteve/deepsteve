// Unit tests for the issue_complete MCP tool (#643).
//
// Autopilot is a server-side session variable read at COMPLETION time, not a prompt
// injected when the switch is flipped. That is the whole design: nothing is queued,
// so nothing has to be cancelled, and turning autopilot off stays a real cancel right
// up until the agent calls this tool. Everything worth pinning about that lives in
// what the tool answers, which is what this file covers.
//
// The fake ctx is the test/unit/merge-auto-close.test.js shape:
// mods/deepsteve-core/tools.js destructures whatever it is given, so an omitted
// helper is just undefined and a tool that doesn't touch it never notices.
const { test } = require('node:test');
const assert = require('node:assert');
const { init } = require('../../mods/deepsteve-core/tools.js');

// In production the caller is auto-detected from ?shellId= on the MCP request URL.
const callerExtra = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });
const parse = (res) => JSON.parse(res.content[0].text);

// One session per case, so a test never depends on another's mutations.
function makeTools({ enabledSkills = ['merge'] } = {}) {
  const shells = new Map([
    ['on', { autopilot: true, agentType: 'claude', worktree: 'github-issue-643' }],
    ['off', { autopilot: false, agentType: 'claude', worktree: 'github-issue-643' }],
    ['codex', { autopilot: true, agentType: 'codex', worktree: 'github-issue-643' }],
    ['never-set', { agentType: 'claude', worktree: 'github-issue-643' }],
  ]);
  const logs = [];
  const tools = init({ shells, settings: { enabledSkills }, log: (m) => logs.push(m) });
  return { tools, shells, logs };
}

test('autopilot on: the answer is to run the merge skill', async () => {
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('on')));
  assert.equal(p.autopilot, true);
  assert.equal(p.next, 'merge');
  assert.match(p.instruction, /when you complete, run \/deepsteve:merge/);
});

test('autopilot off: the answer is to stop and leave the tab', async () => {
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('off')));
  assert.equal(p.autopilot, false);
  assert.equal(p.next, 'stop');
  // It says "do NOT merge", so the check is that it names no way to do one.
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge|\$deepsteve-merge|merge_worktree/,
    'the off answer must not hand the agent a merge to run');
  assert.doesNotMatch(p.instruction, /close_session/,
    'the off answer must not close the tab it is telling the user to review');
  assert.match(p.instruction, /leave this tab open/);
});

test('a session that was never given the flag reads as off', async () => {
  // Every session that predates #643 — and every non-issue session — has no
  // `autopilot` key at all. Absent must mean off, not undefined behaviour.
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('never-set')));
  assert.equal(p.autopilot, false);
  assert.equal(p.next, 'stop');
});

test('a Codex caller is told the Codex name for the skill', async () => {
  // The server rewrites /deepsteve:<id> to $deepsteve-<id> when it generates the
  // Codex copy of a skill, so the Claude form names a command Codex does not have.
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('codex')));
  assert.match(p.instruction, /\$deepsteve-merge/);
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge/);
});

test('with the merge skill disabled, it hands over the mechanical steps instead', async () => {
  // Skills are off until someone enables them, so a fresh install has no
  // /deepsteve:merge. Naming it anyway sends the agent after a command that does
  // not exist — and a stuck agent improvises `git push origin <branch>:main`,
  // which moves the remote and leaves the local checkout behind.
  const { tools } = makeTools({ enabledSkills: [] });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('on')));
  assert.equal(p.autopilot, true);
  assert.equal(p.next, 'merge');
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge/);
  assert.match(p.instruction, /merge_worktree/);
  assert.match(p.instruction, /close_session/);
  assert.match(p.instruction, /Never push/);
});

test('the flag is read at call time, so flipping it changes the answer', async () => {
  // The acceptance criterion for "off fully cancels autopilot": the same session,
  // the same tool, a different answer, with nothing delivered at toggle time.
  const { tools, shells } = makeTools();
  assert.equal(parse(await tools.issue_complete.handler({}, callerExtra('on'))).next, 'merge');
  shells.get('on').autopilot = false;
  assert.equal(parse(await tools.issue_complete.handler({}, callerExtra('on'))).next, 'stop');
  shells.get('on').autopilot = true;
  assert.equal(parse(await tools.issue_complete.handler({}, callerExtra('on'))).next, 'merge');
});

test('an explicit session_id wins over the request URL', async () => {
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({ session_id: 'off' }, callerExtra('on')));
  assert.equal(p.next, 'stop');
});

test('an unknown session is an error, not a silent stop', async () => {
  const { tools } = makeTools();
  const res = await tools.issue_complete.handler({ session_id: 'nope' }, callerExtra('nope'));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not found/);
});

test('every call is logged, because the call rate is the thing to measure', async () => {
  // The feature rests on the agent actually calling this. It fails closed when it
  // doesn't — you simply get today's behaviour — and this line is the only evidence
  // of how often that happens, which is what a daemon-side backstop would need.
  const { tools, logs } = makeTools();
  await tools.issue_complete.handler({}, callerExtra('on'));
  await tools.issue_complete.handler({}, callerExtra('off'));
  assert.equal(logs.length, 2);
  assert.match(logs[0], /issue_complete: on autopilot=on -> merge/);
  assert.match(logs[1], /issue_complete: off autopilot=off -> stop/);
});
