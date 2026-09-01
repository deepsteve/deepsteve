// Unit tests for merge_worktree's daemon-armed auto-close (#627).
//
// test/unit/merge-worktree.test.js covers the pure merge decision tree; this covers
// the MCP handler wrapped around it — specifically WHEN it arms a deferred close of
// the calling session, which is the whole of #627. The handler hard-wires its own
// `runGit` (execFileSync), so the git side is a real temp repo, the same recipe that
// file's end-to-end test already proves works in the bare `unit` CI job.
//
// The fake ctx is the test/unit/meta-type.test.js shape: mods/deepsteve-core/tools.js
// destructures whatever it is given, so an omitted helper is just undefined.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { init } = require('../../mods/deepsteve-core/tools.js');

// A repo with `main` checked out and a committed worktree branch, i.e. the state
// /deepsteve:merge reaches step 6 in. Returns { repo, wt } and a cleanup path.
function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-autoclose-'));
  const repo = path.join(tmp, 'repo');
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  // Real Claude-worktree repos ignore .claude/, else the worktree dir shows as
  // untracked in the main checkout and the dirty-target guard refuses every merge.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);

  const wt = path.join(repo, '.claude', 'worktrees', 'feature');
  git(['worktree', 'add', '-q', '-b', 'feature', wt], repo);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
  git(['add', '-A'], wt);
  git(['commit', '-qm', 'feature work'], wt);
  return { tmp, repo, wt };
}

// worktree: null models a main-checkout caller (skills/merge.md's in_worktree=false).
function makeContext({ cwd, repoRoot, worktree = 'feature', armResult = { closeAt: Date.now() + 120000 } } = {}) {
  const armCalls = [];
  const shells = new Map([['abc', { cwd: repoRoot, worktree }]]);
  const tools = init({
    shells,
    settings: {},
    log: () => {},
    // Claude's native --worktree leaves entry.cwd at the repo root and moves itself
    // into .claude/worktrees/<name>; the real sessionPaths resolves that.
    sessionPaths: () => ({ cwd, repoRoot }),
    armSessionAutoClose: (id, opts) => { armCalls.push([id, opts]); return armResult; },
  });
  return { tools, shells, armCalls };
}

const callerExtra = (shellId) => ({ requestInfo: { url: new URL(`http://localhost:3000/mcp?shellId=${shellId}`) } });
const parse = (res) => JSON.parse(res.content[0].text);

test('a successful merge from a worktree session arms the close and reports it', async () => {
  const { tmp, repo, wt } = makeRepo();
  const closeAt = Date.now() + 120000;
  const { tools, armCalls } = makeContext({ cwd: wt, repoRoot: repo, armResult: { closeAt } });

  const res = await tools.merge_worktree.handler({}, callerExtra('abc'));
  const p = parse(res);

  assert.strictEqual(p.status, 'merged', JSON.stringify(p));
  assert.strictEqual(res.isError, undefined, 'merged is still the only success');
  // The merge result itself must be untouched — the skill branches on these.
  assert.strictEqual(p.branch, 'feature');
  assert.strictEqual(p.target, 'main');
  assert.strictEqual(p.mergeDir, repo);

  assert.strictEqual(armCalls.length, 1, 'armed exactly once');
  assert.deepStrictEqual(armCalls[0], ['abc', { reason: 'merged' }]);
  assert.strictEqual(p.autoCloseAt, closeAt);
  assert.ok(p.autoCloseInSeconds >= 118 && p.autoCloseInSeconds <= 120, `got ${p.autoCloseInSeconds}`);
  // The sentence is the point: the agent paraphrases it instead of inventing one
  // from an epoch timestamp, and it names both escape hatches.
  assert.match(p.autoCloseMessage, /2 minutes/);
  assert.match(p.autoCloseMessage, /close_session/);
  assert.match(p.autoCloseMessage, /cancels the auto-close/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a main-checkout caller is never auto-closed, even on a real merge', async () => {
  // merge_worktree is a general MCP tool, not a private skill callback: called with an
  // explicit target from the main checkout it does an ordinary, legitimate merge in a
  // long-lived tab nobody asked to end. This is skills/merge.md's in_worktree=false
  // acceptance criterion, enforced server-side rather than by the skill stopping early.
  const { tmp, repo, wt } = makeRepo();
  const { tools, armCalls } = makeContext({ cwd: wt, repoRoot: repo, worktree: null });

  const p = parse(await tools.merge_worktree.handler({}, callerExtra('abc')));
  assert.strictEqual(p.status, 'merged');
  assert.deepStrictEqual(armCalls, [], 'nothing armed');
  assert.strictEqual(p.autoCloseAt, undefined);
  assert.strictEqual(p.autoCloseMessage, undefined);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a refused merge arms nothing and still reports isError', async () => {
  const { tmp, repo, wt } = makeRepo();
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n'); // dirty target
  const { tools, armCalls } = makeContext({ cwd: wt, repoRoot: repo });

  const res = await tools.merge_worktree.handler({}, callerExtra('abc'));
  const p = parse(res);
  assert.strictEqual(p.status, 'target-dirty');
  assert.strictEqual(res.isError, true);
  assert.deepStrictEqual(armCalls, [], 'every non-merged status leaves the session open');
  assert.strictEqual(p.autoCloseAt, undefined);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('with the feature off the payload is exactly the pre-#627 result', async () => {
  // armSessionAutoClose returns null when mergeAutoCloseMinutes is 0, and the result
  // must then carry no trace of the feature — nothing for an agent to misread.
  const { tmp, repo, wt } = makeRepo();
  const { tools, armCalls } = makeContext({ cwd: wt, repoRoot: repo, armResult: null });

  const p = parse(await tools.merge_worktree.handler({}, callerExtra('abc')));
  assert.strictEqual(p.status, 'merged');
  assert.strictEqual(armCalls.length, 1, 'still asked — the server owns the policy');
  assert.deepStrictEqual(Object.keys(p).sort(), ['branch', 'mergeDir', 'output', 'status', 'target']);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an older ctx without armSessionAutoClose still merges', async () => {
  const { tmp, repo, wt } = makeRepo();
  const tools = init({
    shells: new Map([['abc', { cwd: repo, worktree: 'feature' }]]),
    settings: {}, log: () => {},
    sessionPaths: () => ({ cwd: wt, repoRoot: repo }),
  });
  const p = parse(await tools.merge_worktree.handler({}, callerExtra('abc')));
  assert.strictEqual(p.status, 'merged');
  assert.strictEqual(p.autoCloseAt, undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- merge_session arms the same close (#688) -------------------------------------
//
// merge_session composes commit + merge + issue-close on top of merge_worktree, and it
// has to end a session the same way: the reason #627 exists — an agent asked to call
// close_session after its summary reliably doesn't — is not specific to which tool did
// the merging. These mirror the merge_worktree cases above rather than re-testing the
// merge, which test/unit/session-merge.test.js covers with injected runners.
//
// `feature` carries no issue number, so `gh` is never consulted and these stay hermetic.

test('merge_session arms the close on success, worktree callers only', async () => {
  const { tmp, repo, wt } = makeRepo();
  const closeAt = Date.now() + 120000;
  const { tools, armCalls } = makeContext({ cwd: wt, repoRoot: repo, armResult: { closeAt } });

  const res = await tools.merge_session.handler({}, callerExtra('abc'));
  const p = parse(res);

  assert.strictEqual(p.status, 'merged', JSON.stringify(p));
  assert.strictEqual(res.isError, undefined);
  assert.deepStrictEqual(armCalls, [['abc', { reason: 'merged' }]]);
  assert.strictEqual(p.autoCloseAt, closeAt);
  assert.match(p.autoCloseMessage, /close_session/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('merge_session from a main-checkout session arms nothing', async () => {
  // The rule merge_worktree established, and for the same reason: this is an ordinary
  // merge — or here, a commit and push — in a long-lived tab nobody asked to end.
  const { tmp, repo } = makeRepo();
  fs.writeFileSync(path.join(repo, 'late.txt'), 'x\n');
  const { tools, armCalls } = makeContext({ cwd: repo, repoRoot: repo, worktree: null });

  const p = parse(await tools.merge_session.handler({}, callerExtra('abc')));

  // No remote in the fixture, so the push fails — the commit is what this asserts.
  assert.strictEqual(p.status, 'push-failed');
  assert.strictEqual(p.committed, true);
  assert.deepStrictEqual(armCalls, []);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('merge_session reports a refusal as isError and arms nothing', async () => {
  const { tmp, repo, wt } = makeRepo();
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted\n'); // dirty target
  const { tools, armCalls } = makeContext({ cwd: wt, repoRoot: repo });

  const res = await tools.merge_session.handler({}, callerExtra('abc'));
  const p = parse(res);
  assert.strictEqual(p.status, 'target-dirty');
  assert.strictEqual(res.isError, true);
  assert.deepStrictEqual(armCalls, []);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('merge_session commits the worktree before merging — merge_worktree does not', async () => {
  // The difference between the two tools, stated as a test. Reaching for the primitive
  // on a dirty worktree silently lands half the work; that is what the composed tool is
  // for, and what the Workshop bench merge used to get wrong.
  const bare = makeRepo();
  fs.writeFileSync(path.join(bare.wt, 'late.txt'), 'x\n');
  const a = makeContext({ cwd: bare.wt, repoRoot: bare.repo });
  assert.strictEqual(parse(await a.tools.merge_worktree.handler({}, callerExtra('abc'))).status, 'merged');
  assert.ok(!fs.existsSync(path.join(bare.repo, 'late.txt')),
    'the primitive merges committed work only');
  fs.rmSync(bare.tmp, { recursive: true, force: true });

  const composed = makeRepo();
  fs.writeFileSync(path.join(composed.wt, 'late.txt'), 'x\n');
  const b = makeContext({ cwd: composed.wt, repoRoot: composed.repo });
  const p = parse(await b.tools.merge_session.handler({}, callerExtra('abc')));
  assert.strictEqual(p.status, 'merged');
  assert.strictEqual(p.committed, true);
  assert.ok(fs.existsSync(path.join(composed.repo, 'late.txt')),
    'the composed tool commits first, so the whole worktree lands');
  fs.rmSync(composed.tmp, { recursive: true, force: true });
});

// --- Drift guards on skills/merge.md ---------------------------------------------
// #609 shipped a pure prompt change with no test, and #627 is the report that it
// silently stopped working. These are the cheap guards that were missing: they cannot
// prove an agent obeys the skill, but they can prove the skill and the tool still
// describe the same contract.
const SKILL = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'merge.md'), 'utf8');

test('skills/merge.md still asks for the explicit close', () => {
  // The daemon covering the step is not a reason to delete the ask: immediate beats
  // deferred, and #627's acceptance criteria keep the request in place.
  assert.match(SKILL, /mcp__deepsteve__close_session/,
    'skills/merge.md must still tell the agent to call close_session');
});

test('skills/merge.md and the merge_worktree result agree on the field name', () => {
  const toolsSource = fs.readFileSync(path.join(__dirname, '..', '..', 'mods', 'deepsteve-core', 'tools.js'), 'utf8');
  assert.match(toolsSource, /payload\.autoCloseAt/, 'the tool must still return autoCloseAt');
  assert.match(SKILL, /autoCloseAt/,
    'skills/merge.md names autoCloseAt — rename one and this fails instead of silently desyncing');
});
