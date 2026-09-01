// Unit tests for the issue_complete MCP tool (#643, #669, #688).
//
// Autopilot is a server-side session variable read at COMPLETION time, not a prompt
// injected when the switch is flipped. That is the whole design: nothing is queued, so
// nothing has to be cancelled, and turning autopilot off stays a real cancel right up
// until the agent calls this tool.
//
// Since #688 the tool no longer answers with instructions for a merge the agent then
// spends ten turns performing — it PERFORMS the merge and reports what happened. So this
// file is in two halves:
//
//   * the cases that must never merge (autopilot off, and every gated state) get a ctx
//     with NO `sessionPaths`. That is deliberate and load-bearing: the merge path would
//     throw on the first line if it were reached, so those tests passing is positive
//     evidence that the gate and the off-switch short-circuit above it, not merely that
//     the answer text looks right.
//   * the cases that do merge get a real temp repo, the merge-auto-close.test.js recipe.
//     mods/deepsteve-core/tools.js hard-wires its own runGit (execFileSync), so a real
//     repo is the only way to drive it — and it works in the bare `unit` CI job, which
//     has git but no zsh and no node-pty.
//
// Every branch here uses `feature`, not a github-issue-<n> name, so `gh` is never
// consulted and these stay hermetic. The issue-title and issue-close behaviour is
// covered in test/unit/session-merge.test.js, where `gh` is injected.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { init } = require('../../mods/deepsteve-core/tools.js');

// In production the caller is auto-detected from ?shellId= on the MCP request URL.
const callerExtra = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });
const parse = (res) => JSON.parse(res.content[0].text);

// ── repos ────────────────────────────────────────────────────────────────────

const tmpDirs = [];
after(() => { for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * A repo with `main` checked out and a committed `feature` worktree — the state an issue
 * session is in when it calls this tool.
 *
 * `conflict: true` also changes the same line on main, so the merge really conflicts.
 * `dirtyTarget: true` leaves the main checkout with uncommitted work, which is what the
 * merge refuses on.
 */
function repoFor({ conflict = false, dirtyTarget = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-issue-complete-'));
  tmpDirs.push(tmp);
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  // Real Claude-worktree repos ignore .claude/, else the worktree dir shows as untracked
  // in the main checkout and the dirty-target guard refuses every merge.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);

  const wt = path.join(repo, '.claude', 'worktrees', 'feature');
  git(['worktree', 'add', '-q', '-b', 'feature', wt], repo);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'from the worktree\n');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'feature work'], wt);

  if (conflict) {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from main\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'divergent'], repo);
  }
  if (dirtyTarget) fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted WIP\n');

  return { repo, wt };
}

// ── contexts ─────────────────────────────────────────────────────────────────

/**
 * The no-repo ctx. Anything that reaches the merge throws here, which is the point.
 */
function makeTools() {
  const shells = new Map([
    ['on', { autopilot: true, agentType: 'claude', worktree: 'github-issue-643' }],
    ['off', { autopilot: false, agentType: 'claude', worktree: 'github-issue-643' }],
    ['never-set', { agentType: 'claude', worktree: 'github-issue-643' }],
  ]);
  const logs = [];
  const tools = init({ shells, settings: {}, log: (m) => logs.push(m) });
  return { tools, shells, logs };
}

/**
 * A ctx with one autopilot-on session wired to a real repo. `sessionPaths` reads the
 * paths off the entry so one implementation serves however many sessions a test makes.
 */
function mergeTools({ conflict = false, dirtyTarget = false, worktree = 'feature', armResult = { closeAt: Date.now() + 120000 } } = {}) {
  const { repo, wt } = repoFor({ conflict, dirtyTarget });
  const armCalls = [];
  const logs = [];
  const shells = new Map([
    // worktree: null models a main-checkout session — skills/merge.md's in_worktree=false.
    ['s', { autopilot: true, agentType: 'claude', worktree, _cwd: worktree ? wt : repo, _root: repo }],
  ]);
  const tools = init({
    shells,
    settings: {},
    log: (m) => logs.push(m),
    sessionPaths: (e) => ({ cwd: e._cwd, repoRoot: e._root }),
    armSessionAutoClose: (id, opts) => { armCalls.push([id, opts]); return armResult; },
  });
  return { tools, shells, logs, armCalls, repo, wt };
}

// ── autopilot off ────────────────────────────────────────────────────────────

test('autopilot off: the answer is to stop and leave the tab, and nothing is merged', async () => {
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('off')));
  assert.equal(p.autopilot, false);
  assert.equal(p.next, 'stop');
  // It says "do NOT merge", so the check is that it names no way to do one.
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge|\$deepsteve-merge|merge_worktree|merge_session/,
    'the off answer must not hand the agent a merge to run');
  assert.doesNotMatch(p.instruction, /close_session/,
    'the off answer must not close the tab it is telling the user to review');
  assert.match(p.instruction, /leave this tab open/);
  // And it carries no merge result at all — this ctx has no sessionPaths, so reaching
  // the merge would have thrown rather than produced these fields.
  assert.equal(p.status, undefined);
  assert.equal(p.branch, undefined);
});

test('a session that was never given the flag reads as off', async () => {
  // Every session that predates #643 — and every non-issue session — has no
  // `autopilot` key at all. Absent must mean off, not undefined behaviour.
  const { tools } = makeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('never-set')));
  assert.equal(p.autopilot, false);
  assert.equal(p.next, 'stop');
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

// ── autopilot on: the merge happens here (#688) ───────────────────────────────

test('autopilot on: the tool MERGES, and the answer reports it', async () => {
  // The whole of #688. This used to answer `next: "merge"` with instructions to run
  // /deepsteve:merge, which was the start of about ten more assistant turns.
  const { tools, armCalls, repo } = mergeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));

  assert.equal(p.autopilot, true);
  assert.equal(p.next, 'merged');
  assert.equal(p.status, 'merged');
  assert.equal(p.branch, 'feature');
  assert.equal(p.target, 'main');
  assert.match(p.instruction, /Merged into main/);
  // The work really is in the target, not merely reported as such.
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from the worktree\n');
  // And the tab is armed to close, the same #627 arming merge_worktree does.
  assert.deepStrictEqual(armCalls, [['s', { reason: 'merged' }]]);
  assert.ok(p.autoCloseAt > Date.now());
});

test('the answer tells the agent to write its summary and stop, not to merge again', async () => {
  const { tools } = mergeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.match(p.instruction, /Write your summary/i);
  assert.match(p.instruction, /do not merge again/i,
    'the one failure mode of merging inside this call is an agent that then merges again');
});

test('uncommitted work in the worktree is committed before the merge', async () => {
  const { tools, wt, repo } = mergeTools();
  fs.writeFileSync(path.join(wt, 'new.txt'), 'late work\n');

  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));

  assert.equal(p.next, 'merged');
  assert.equal(p.committed, true);
  assert.equal(p.subject, 'Merge feature into main', 'no issue number on this branch, so the fallback form');
  assert.ok(fs.existsSync(path.join(repo, 'new.txt')), 'the late work reached the target');
});

test('a clean worktree is merged without a commit being written', async () => {
  const { tools, wt } = mergeTools();
  const before = git(['rev-list', '--count', 'HEAD'], wt).trim();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'merged');
  assert.equal(p.committed, false);
  assert.equal(git(['rev-list', '--count', 'feature'], wt).trim(), before);
});

test('an agent-supplied subject is used for the commit', async () => {
  const { tools, wt } = mergeTools();
  fs.writeFileSync(path.join(wt, 'new.txt'), 'late work\n');
  const p = parse(await tools.issue_complete.handler(
    { subject: 'A better sentence', body: 'And why.' }, callerExtra('s')));
  assert.equal(p.subject, 'A better sentence');
  assert.match(git(['log', '-1', '--pretty=%B', 'feature'], wt), /A better sentence\n\nAnd why\./);
});

test('a conflict is handed back to the agent, and closes nothing', async () => {
  // The one place a model is still wanted: the working agent has the code in context.
  const { tools, armCalls, repo } = mergeTools({ conflict: true });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));

  assert.equal(p.next, 'resolve-conflict');
  assert.equal(p.status, 'conflict');
  assert.match(p.instruction, /git rebase main/);
  assert.match(p.instruction, /merge_worktree/, 'the retry goes through the primitive');
  assert.match(p.instruction, /Do NOT close this session/);
  assert.deepStrictEqual(armCalls, [], 'an unfinished session must not be armed to close');
  // The merge was aborted, so the target is untouched.
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from main\n');
});

test('a dirty target is refused, and closes nothing', async () => {
  const { tools, armCalls, repo } = mergeTools({ dirtyTarget: true });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));

  assert.equal(p.next, 'stop');
  assert.equal(p.status, 'target-dirty');
  assert.equal(p.mergeDir, repo);
  assert.match(p.instruction, /did not run/);
  assert.match(p.instruction, /do NOT close this session/i);
  assert.match(p.instruction, /Never push|push origin/,
    'the workaround an agent improvises here moves the remote — say so');
  assert.deepStrictEqual(armCalls, []);
});

test('a non-worktree session commits and pushes, and is neither merged nor closed', async () => {
  // No remote in the fixture, so the push fails — which is the honest shape for a scratch
  // repo, and exercises the branch that has to report a failure rather than swallow it.
  const { tools, armCalls, repo } = mergeTools({ worktree: null });
  fs.writeFileSync(path.join(repo, 'late.txt'), 'x\n');

  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));

  assert.equal(p.next, 'stop');
  assert.equal(p.status, 'push-failed');
  assert.equal(p.committed, true, 'the commit happened even though the push could not');
  assert.match(p.instruction, /not a worktree session/i);
  assert.match(p.instruction, /Do NOT close the session/);
  assert.deepStrictEqual(armCalls, [], 'nothing is armed on the non-worktree path');
});

test('a main-checkout session is never armed to close, even on a clean run', async () => {
  // merge_worktree's rule, preserved: this tool must not end a long-lived tab nobody
  // asked to end just because it happens to be an issue session in the main checkout.
  const { tools, armCalls } = mergeTools({ worktree: null });
  await tools.issue_complete.handler({}, callerExtra('s'));
  assert.deepStrictEqual(armCalls, []);
});

test('the flag is read at call time, so flipping it changes the answer', async () => {
  // The acceptance criterion for "off fully cancels autopilot": the same session, the
  // same tool, a different answer, with nothing delivered at toggle time.
  const { tools, shells } = mergeTools();
  shells.get('s').autopilot = false;
  assert.equal(parse(await tools.issue_complete.handler({}, callerExtra('s'))).next, 'stop');
  shells.get('s').autopilot = true;
  assert.equal(parse(await tools.issue_complete.handler({}, callerExtra('s'))).next, 'merged');
});

test('the merge does not depend on the "merge" skill being enabled', async () => {
  // Before #688 the answer NAMED /deepsteve:merge, so it had to know whether that command
  // existed. A server-side merge names nothing, and this pins that the coupling is gone —
  // note the ctx settings have no enabledSkills at all.
  const { tools } = mergeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'merged');
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge|\$deepsteve-merge/,
    'no slash command is named, for Claude or for Codex');
});

test('every call is logged, and a merge says which one it did', async () => {
  // The feature rests on the agent actually calling this. It fails closed when it
  // doesn't — you simply get today's behaviour — and this line is the only evidence of
  // how often that happens, which is what a daemon-side backstop would need.
  const { tools, logs } = mergeTools();
  await tools.issue_complete.handler({}, callerExtra('s'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /issue_complete: s autopilot=on -> merged \(feature -> main = merged\)/);

  const off = makeTools();
  await off.tools.issue_complete.handler({}, callerExtra('off'));
  assert.match(off.logs[0], /issue_complete: off autopilot=off -> stop/);
});

// ── The review gate (#669) ───────────────────────────────────────────────────
//
// Two fields on the shell entry, stamped by Workshop the way the picker stamps
// `autopilot` and read here for the same reason: the value RIGHT NOW is the whole
// answer. The important property is that the gate fails OPEN — every install that has
// never turned `issueStagesEnabled` on must get byte-identical answers to before it
// existed — so half these tests are about the feature being absent.
//
// Since #688 the gate guards something much sharper than a sentence: below it, this tool
// merges. `gateTools` therefore deliberately supplies NO sessionPaths, so a gate that
// stopped short-circuiting would throw rather than quietly merge — and the standing
// invariant (only a human writes resultApprovedAt) cannot be routed around here.

function gateTools({ stages = true } = {}) {
  const shells = new Map([
    // The three gate states, on an autopilot-on session so the merge is what would
    // otherwise happen.
    ['nothing-shared', { autopilot: true, agentType: 'claude', worktree: 'w' }],
    ['shared', { autopilot: true, agentType: 'claude', worktree: 'w', resultItemId: 'w42' }],
    ['approved', {
      autopilot: true, agentType: 'claude', worktree: 'w',
      resultItemId: 'w42', resultApprovedAt: 1_700_000_000_000,
    }],
    // Autopilot off, but approved: the gate must hand back to the ORIGINAL logic rather
    // than answering for it.
    ['approved-no-autopilot', {
      autopilot: false, agentType: 'claude', worktree: 'w',
      resultItemId: 'w42', resultApprovedAt: 1_700_000_000_000,
    }],
    // The state Workshop leaves behind when a human requests changes: it clears BOTH.
    ['rejected', { autopilot: true, agentType: 'claude', worktree: 'w', resultItemId: null, resultApprovedAt: null }],
  ]);
  const logs = [];
  const tools = init({ shells, settings: { issueStagesEnabled: stages }, log: (m) => logs.push(m) });
  return { tools, shells, logs };
}

test('stages on, nothing shared: share a result first, and nothing is merged', async () => {
  const { tools } = gateTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('nothing-shared')));
  assert.equal(p.next, 'share_result');
  assert.match(p.instruction, /share_result/);
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge|\$deepsteve-merge|merge_worktree|merge_session/,
    'a refused gate must not also hand the agent the merge it is being refused');
  assert.match(p.instruction, /Do NOT merge/);
  assert.equal(p.status, undefined, 'no merge was attempted — this ctx could not have run one');
});

test('stages on, shared but not approved: end your turn, and do not poll', async () => {
  const { tools } = gateTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('shared')));
  assert.equal(p.next, 'await_review');
  assert.equal(p.result, 'w42');
  assert.equal(p.approved, false);
  assert.match(p.instruction, /w42/, 'name the item, so the agent can say which one it is waiting on');
  assert.match(p.instruction, /End your turn/i);
  assert.match(p.instruction, /arrive as a new message/i,
    'the whole async shape depends on the agent believing this rather than polling');
  assert.doesNotMatch(p.instruction, /merge_worktree|merge_session|\/deepsteve:merge/);
  assert.equal(p.status, undefined);
});

test('with stages on and no approval, NO path merges anything', async () => {
  // The #688 acceptance criterion, stated as one assertion. gateTools supplies no
  // sessionPaths, so a merge attempted from either ungated state would reject here.
  const { tools } = gateTools();
  for (const id of ['nothing-shared', 'shared', 'rejected']) {
    const p = parse(await tools.issue_complete.handler({}, callerExtra(id)));
    assert.ok(p.next === 'share_result' || p.next === 'await_review', `${id} -> ${p.next}`);
    assert.equal(p.status, undefined, `${id} must not carry a merge result`);
  }
});

test('stages on and approved: the merge runs, because a human let it', async () => {
  const { repo, wt } = repoFor();
  const shells = new Map([['approved', {
    autopilot: true, agentType: 'claude', worktree: 'feature',
    resultItemId: 'w42', resultApprovedAt: 1_700_000_000_000, _cwd: wt, _root: repo,
  }]]);
  const tools = init({
    shells,
    settings: { issueStagesEnabled: true },
    log: () => {},
    sessionPaths: (e) => ({ cwd: e._cwd, repoRoot: e._root }),
    armSessionAutoClose: () => ({ closeAt: Date.now() + 1000 }),
  });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('approved')));
  assert.equal(p.next, 'merged');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from the worktree\n');
});

test('approval does not override Autopilot — the gate is a second lock, not a key', async () => {
  const { tools } = gateTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('approved-no-autopilot')));
  assert.equal(p.next, 'stop');
  assert.equal(p.autopilot, false);
  assert.match(p.instruction, /leave this tab open/,
    'a human approving the WRITEUP has not thereby turned Autopilot on');
});

test('a rejected result is back to "share a result first"', async () => {
  const { tools } = gateTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('rejected')));
  assert.equal(p.next, 'share_result',
    'Workshop clears both stamps on Request changes, so the last result no longer stands');
});

test('stages OFF: neither field is consulted, in any combination', async () => {
  // Each id gets its own repo: a shared one would have the first merge change the answer
  // for the rest, which would test sequencing rather than the gate.
  for (const state of [
    {},
    { resultItemId: 'w42' },
    { resultItemId: 'w42', resultApprovedAt: 1_700_000_000_000 },
    { resultItemId: null, resultApprovedAt: null },
  ]) {
    const { repo, wt } = repoFor();
    const shells = new Map([['s', { autopilot: true, agentType: 'claude', worktree: 'feature', _cwd: wt, _root: repo, ...state }]]);
    const tools = init({
      shells,
      settings: { issueStagesEnabled: false },
      log: () => {},
      sessionPaths: (e) => ({ cwd: e._cwd, repoRoot: e._root }),
      armSessionAutoClose: () => ({ closeAt: Date.now() + 1000 }),
    });
    const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
    assert.equal(p.next, 'merged', `${JSON.stringify(state)} must answer exactly as it did before #669`);
  }
});

test('an install that has never heard of issueStagesEnabled is not gated', async () => {
  // The realistic shape: `settings` predates the schema entry entirely.
  const { repo, wt } = repoFor();
  const shells = new Map([['s', { autopilot: true, agentType: 'claude', worktree: 'feature', _cwd: wt, _root: repo }]]);
  const tools = init({
    shells,
    settings: {},
    log: () => {},
    sessionPaths: (e) => ({ cwd: e._cwd, repoRoot: e._root }),
    armSessionAutoClose: () => ({ closeAt: Date.now() + 1000 }),
  });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'merged', 'undefined must read as off, not as undefined behaviour');
});

test('a gated call is logged, with which gate it hit', async () => {
  const { tools, logs } = gateTools();
  await tools.issue_complete.handler({}, callerExtra('shared'));
  const line = logs.at(-1);
  assert.match(line, /issue_complete/);
  assert.match(line, /stages=on/);
  assert.match(line, /result=w42/);
  assert.match(line, /await_review/,
    'the call rate AND the refusal rate are what would justify a daemon-side backstop');
});

test('the tool description warns about the gate, and says it merges', () => {
  const { tools } = gateTools({ stages: false });
  assert.match(tools.issue_complete.description, /share_result/,
    'the description is static, so it has to be true whether or not stages are on');
  assert.match(tools.issue_complete.description, /merge/i,
    'an agent must know from the description alone that this call is not read-only');
  assert.match(tools.issue_complete.description, /do not run a merge command afterwards/i,
    'the description is the only place a caller learns it need not do anything else');
});

// --- resumed worktrees (#689) -----------------------------------------------
//
// The constraint: a session that RESUMED an existing worktree must not read the prior
// commits as its own work. Since #688 the merge happens inside this call, so the note is
// no longer a warning to act on — it is about attribution, which is what is still in the
// agent's hands when it writes the summary and the comment on the issue it just closed.
//
// The merging cases use the same real-repo recipe the #688 cases do; the gated and
// autopilot-off cases deliberately keep the no-sessionPaths ctx, so reaching a merge
// would throw.

const RESUMED = { branch: 'feature', base: 'main', headBefore: 'a4b9061', commitsBefore: 3, dirtyBefore: 12, at: 1 };

function resumedMergeTools(stamp = RESUMED, opts = {}) {
  const t = mergeTools(opts);
  t.shells.get('s').resumedWorktree = stamp;
  return t;
}

// No sessionPaths, so anything that reached a merge would throw — which is what makes
// these tests evidence that the gate and the off-switch short-circuit above it.
function makeResumedTools({ stamp = RESUMED, stages = false } = {}) {
  const shells = new Map([
    ['off', { autopilot: false, agentType: 'claude', worktree: 'github-issue-689', resumedWorktree: stamp }],
    ['on', { autopilot: true, agentType: 'claude', worktree: 'github-issue-689', resumedWorktree: stamp }],
  ]);
  const logs = [];
  const tools = init({ shells, settings: { issueStagesEnabled: stages }, log: (m) => logs.push(m) });
  return { tools, logs };
}

test('a merged resumed session is told which commits are not its own', async () => {
  // The branch tip at spawn is the whole point: it turns a vague "there was prior work"
  // into one rev-range the agent can actually run.
  const { tools } = resumedMergeTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'merged', p.instruction);
  assert.deepEqual(p.resumed, {
    branch: 'feature', commitsBefore: 3, dirtyBefore: 12, headBefore: 'a4b9061',
  });
  assert.match(p.instruction, /RESUMED an existing worktree/);
  assert.ok(p.instruction.includes('a4b9061..HEAD'), p.instruction);
  assert.match(p.instruction, /went into this merge too/);
  assert.match(p.instruction, /do not describe the earlier work as yours/);
});

test('the resumed note on the stop path names no merge and no close', async () => {
  // Same rule the off answer has always had: this is the branch that means "a human
  // takes it from here", so it must not hand the agent a way to finish by itself.
  const { tools } = makeResumedTools();
  const p = parse(await tools.issue_complete.handler({}, callerExtra('off')));
  assert.equal(p.next, 'stop');
  assert.match(p.instruction, /RESUMED an existing worktree/);
  assert.doesNotMatch(p.instruction, /\/deepsteve:merge|\$deepsteve-merge|merge_worktree|merge_session/);
  assert.doesNotMatch(p.instruction, /close_session/);
  assert.doesNotMatch(p.instruction, /went into this merge/, 'nothing was merged on this path');
});

test('an empty resumed worktree gets the block but no caution', async () => {
  // A merged issue leaves its worktree behind, so resuming an empty one is common and
  // carries no risk of claiming anyone's work. The facts still ride along.
  const { tools } = resumedMergeTools({ ...RESUMED, commitsBefore: 0, dirtyBefore: 0 });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'merged', p.instruction);
  assert.equal(p.resumed.commitsBefore, 0);
  assert.doesNotMatch(p.instruction, /RESUMED an existing worktree/,
    'nothing was inherited, so there is nothing to attribute');
});

test('a session that did not resume says nothing about resuming (#689)', async () => {
  // Nearly every session. The new field must be entirely invisible on that path.
  const { tools } = resumedMergeTools(null);
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'merged', p.instruction);
  assert.equal('resumed' in p, false);
  assert.doesNotMatch(p.instruction, /RESUMED/);

  const { tools: offTools } = makeTools();
  const off = parse(await offTools.issue_complete.handler({}, callerExtra('off')));
  assert.equal('resumed' in off, false);
  assert.doesNotMatch(off.instruction, /RESUMED/);
});

test('the resumed facts ride the review gate answers too', async () => {
  // share_result is where an agent writes up what it did, which is exactly where
  // inherited commits get described as its own work. This ctx has no sessionPaths, so
  // the gate short-circuiting above the merge is what makes the call succeed at all.
  const { tools } = makeResumedTools({ stages: true });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('on')));
  assert.equal(p.next, 'share_result');
  assert.equal(p.resumed.headBefore, 'a4b9061');
});

test('a resumed conflict still says whose work is being rebased', async () => {
  // A rebase is no less somebody else's work for not having merged yet.
  const { tools } = resumedMergeTools(RESUMED, { conflict: true });
  const p = parse(await tools.issue_complete.handler({}, callerExtra('s')));
  assert.equal(p.next, 'resolve-conflict', p.instruction);
  assert.match(p.instruction, /RESUMED an existing worktree/);
  assert.doesNotMatch(p.instruction, /went into this merge/, 'the merge was aborted');
});

test('the resume is logged, since the call is the only evidence it happened', async () => {
  const { tools, logs } = resumedMergeTools();
  await tools.issue_complete.handler({}, callerExtra('s'));
  assert.ok(logs.some(l => l.includes('resumed=3c/12d')), logs.join('\n'));
});
