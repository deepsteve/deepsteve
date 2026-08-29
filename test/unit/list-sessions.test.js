// Unit tests for the list_sessions MCP tool (#659) — mods/deepsteve-core/tools.js.
//
// The roster is project-scoped by default, which is the whole point of the issue: an
// agent working in one repo should not be handed every tab on the machine. These
// drive the handler directly through init(mockContext) — no server, no PTYs.
//
// The fixture is shaped to exercise the scoping rules that have no coverage anywhere
// else in the tree, group scope in particular:
//
//   PARENT/            ← one context's dir
//     repo-a/   .git   ← the caller's project
//       src/           ← a session opened in a subdirectory of it
//     repo-a2/  .git   ← a sibling repo: in the group, not in the project
//   REPO_B/     .git   ← a different project entirely
//   PLAIN/             ← not a repo at all
//
// Run: node --test test/unit/list-sessions.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { init } = require('../../mods/deepsteve-core/tools.js');

// ------------------------------------------------------------------- fixtures

// realpathSync because findGitRoot realpaths, and /var → /private/var on macOS.
const PARENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ls-parent-')));

function makeRepo(parent, name) {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

const REPO_A = makeRepo(PARENT, 'repo-a');
const SUBDIR_A = path.join(REPO_A, 'src');
fs.mkdirSync(SUBDIR_A);
const REPO_A2 = makeRepo(PARENT, 'repo-a2');
const REPO_B = makeRepo(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ls-other-'))), 'repo-b');
const PLAIN = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ls-plain-')));

// The worktree a worktree session lives in. Note it gets its own `.git` FILE, exactly
// as git writes one — which is why scoping must go through sessionPaths and not just
// hand the worktree path to findGitRoot (git-root.js treats a .git file as a root, so
// canonicalizing the worktree path would return the worktree, not its parent repo).
const WT_A = path.join(REPO_A, '.claude', 'worktrees', 'wt');
fs.mkdirSync(WT_A, { recursive: true });
fs.writeFileSync(path.join(WT_A, '.git'), `gitdir: ${path.join(REPO_A, '.git', 'worktrees', 'wt')}\n`);

const contexts = [
  { id: 'g1', name: 'Alpha', dirs: [PARENT] },
  { id: 'g2', name: 'Beta', dirs: [path.dirname(REPO_B)] },
];

const T0 = 1_700_000_000_000;

// cwd is the SPAWN cwd, as on a real entry: for a Claude worktree session that is the
// main repo, and Claude itself moves into .claude/worktrees/<name>.
const shells = new Map([
  ['sess-a', { cwd: REPO_A, agentType: 'claude', name: 'main', createdAt: T0, lastActivity: T0 + 300 }],
  ['sess-sub', { cwd: SUBDIR_A, agentType: 'claude', name: 'in-src', createdAt: T0, lastActivity: T0 + 200 }],
  ['sess-wt', { cwd: REPO_A, worktree: 'wt', agentType: 'claude', name: 'issue-659', createdAt: T0, lastActivity: T0 + 100 }],
  ['sess-a2', { cwd: REPO_A2, agentType: 'claude', name: 'sibling', createdAt: T0, lastActivity: T0 + 400 }],
  ['sess-b', { cwd: REPO_B, agentType: 'codex', name: 'other-project', createdAt: T0, lastActivity: T0 + 500 }],
  ['sess-plain', { cwd: PLAIN, agentType: 'terminal', createdAt: T0, lastActivity: T0 + 600 }],
  ['sess-tmux', { cwd: REPO_A, agentType: 'tmux-attach', name: 'attach', createdAt: T0, lastActivity: T0 + 700 }],
]);

// Mirrors server.js sessionPaths(): a worktree session's entry.cwd is the MAIN repo
// and its real cwd is the worktree subdir. Every agent in this fixture that has a
// worktree is a claude one, which is the supportsWorktree branch.
function sessionPaths(entry) {
  const base = entry?.cwd || '';
  if (!entry?.worktree) return { cwd: base, repoRoot: base };
  const wt = path.join(base, '.claude', 'worktrees', entry.worktree);
  return { cwd: fs.existsSync(wt) ? wt : base, repoRoot: base };
}

const tools = init({
  shells,
  settings: {},
  log: () => {},
  sessionPaths,
  getContexts: () => contexts,
  pathInside: (p, dir) => {
    if (!p || !dir) return false;
    const base = String(dir).replace(/\/+$/, '');
    return p === base || p.startsWith(base + '/');
  },
  sessionInputState: (entry) => (entry.agentType === 'claude' ? 'idle' : 'unknown'),
});

// The MCP `extra` shape: the caller's shellId comes off its own MCP request URL.
const asSession = (shellId) => ({ requestInfo: { url: { searchParams: new URLSearchParams({ shellId }) } } });

const payload = (res) => JSON.parse(res.content[0].text);
async function list(args = {}, extra = {}) {
  const res = await tools.list_sessions.handler(args, extra);
  assert.notStrictEqual(res.isError, true, res.content[0].text);
  return payload(res);
}
const idsOf = (p) => p.sessions.map((s) => s.id).sort();

// --------------------------------------------------------------------- scoping

test('the default scope is the caller\'s project, subdirectory sessions included', async () => {
  const p = await list({}, asSession('sess-a'));

  assert.strictEqual(p.scope, 'project');
  assert.strictEqual(p.project, REPO_A);
  assert.strictEqual(p.projectName, 'repo-a');
  assert.deepStrictEqual(idsOf(p), ['sess-a', 'sess-sub', 'sess-wt'],
    'a session opened in <repo>/src is in the same project — sessionPaths reports the '
    + 'subdir verbatim, so both sides have to be canonicalized for === to mean "same directory"');
  assert.strictEqual(p.count, 3);
});

test('scope:"group" adds sibling repos in the same context, and nothing else', async () => {
  const p = await list({ scope: 'group' }, asSession('sess-a'));

  assert.strictEqual(p.scope, 'group');
  assert.deepStrictEqual(idsOf(p), ['sess-a', 'sess-a2', 'sess-sub', 'sess-wt'],
    'repo-a2 shares the Alpha context dir with repo-a');
  assert.ok(!idsOf(p).includes('sess-b'), 'a repo in a different context is not in the group');
  assert.ok(!idsOf(p).includes('sess-plain'), 'a non-repo session is not in the group either');
});

test('scope:"all" lists every live session, and needs no project at all', async () => {
  const p = await list({ scope: 'all' }, {});

  assert.strictEqual(p.scope, 'all');
  assert.strictEqual(p.project, null);
  assert.deepStrictEqual(idsOf(p),
    ['sess-a', 'sess-a2', 'sess-b', 'sess-plain', 'sess-sub', 'sess-wt']);
});

test('an explicit project overrides the caller\'s own', async () => {
  const p = await list({ project: REPO_B }, asSession('sess-a'));
  assert.strictEqual(p.project, REPO_B);
  assert.deepStrictEqual(idsOf(p), ['sess-b']);

  const bySubdir = await list({ project: SUBDIR_A }, asSession('sess-b'));
  assert.strictEqual(bySubdir.project, REPO_A, 'an explicit subdirectory canonicalizes too');
});

test('session_id scopes the listing when the caller is not MCP-wired', async () => {
  const p = await list({ session_id: 'sess-b' }, {});
  assert.strictEqual(p.project, REPO_B);
  assert.deepStrictEqual(idsOf(p), ['sess-b']);
});

// ------------------------------------------------------------------ the rows

test('a worktree session is listed under its parent repo, not its worktree', async () => {
  const p = await list({}, asSession('sess-a'));
  const wt = p.sessions.find((s) => s.id === 'sess-wt');

  assert.strictEqual(wt.cwd, WT_A, 'cwd is where the agent actually works');
  assert.strictEqual(wt.repoRoot, REPO_A);
  assert.strictEqual(wt.project, REPO_A, 'and it scopes to the checkout the worktree came from');
  assert.strictEqual(wt.worktree, 'wt');
});

test('a tmux-attach entry is never a row, in any scope', async () => {
  for (const args of [{}, { scope: 'group' }, { scope: 'all' }]) {
    const p = await list(args, asSession('sess-a'));
    assert.ok(!idsOf(p).includes('sess-tmux'), `tmux-attach leaked into scope ${args.scope || 'project'}`);
  }
});

test('rows carry get_session_info\'s field names plus project and self', async () => {
  const p = await list({}, asSession('sess-a'));
  const row = p.sessions.find((s) => s.id === 'sess-a');

  assert.deepStrictEqual(Object.keys(row).sort(), [
    'agentType', 'cwd', 'createdAt', 'id', 'lastActivity', 'name',
    'project', 'repoRoot', 'self', 'state', 'windowId', 'worktree',
  ].sort());
  assert.strictEqual(row.state, 'idle', 'state comes from sessionInputState');
  assert.strictEqual(row.agentType, 'claude');
  assert.ok(!('runningCommand' in row), 'runningCommand costs a process lookup per row — omitted on purpose');
});

test('a session with no name falls back to its cwd basename', async () => {
  const p = await list({ scope: 'all' }, {});
  const plain = p.sessions.find((s) => s.id === 'sess-plain');
  assert.strictEqual(plain.name, path.basename(PLAIN));
  assert.strictEqual(plain.state, 'unknown', 'a plain terminal has no screen markers');
});

test('the caller is flagged and sorts first; the rest are most-recently-active first', async () => {
  const p = await list({ scope: 'group' }, asSession('sess-sub'));

  assert.deepStrictEqual(p.sessions.map((s) => s.id),
    ['sess-sub', 'sess-a2', 'sess-a', 'sess-wt']);
  assert.deepStrictEqual(p.sessions.filter((s) => s.self).map((s) => s.id), ['sess-sub'],
    'exactly one row is self');

  const again = await list({ scope: 'group' }, asSession('sess-sub'));
  assert.deepStrictEqual(again.sessions.map((s) => s.id), p.sessions.map((s) => s.id),
    'the order is deterministic across calls');
});

test('nothing is self when the caller cannot be identified', async () => {
  const p = await list({ scope: 'all' }, {});
  assert.deepStrictEqual(p.sessions.filter((s) => s.self), []);
});

// ------------------------------------------------------------------ edge cases

test('an unscopeable read is an empty list with a note, not an error', async () => {
  const res = await tools.list_sessions.handler({}, {});
  assert.notStrictEqual(res.isError, true, 'a read that cannot be scoped is a no-op, not a failure');

  const p = payload(res);
  assert.strictEqual(p.project, null);
  assert.deepStrictEqual(p.sessions, []);
  assert.strictEqual(p.count, 0);
  assert.match(p.note, /scope:"all"/);
});

test('an unresolvable explicit project is a note, not an error', async () => {
  const p = await list({ project: path.join(os.tmpdir(), 'ds-ls-definitely-not-here') }, asSession('sess-a'));
  assert.deepStrictEqual(p.sessions, []);
  assert.match(p.note, /No project could be determined/);
});

test('scope:"group" with no resolvable project says so instead of listing everything', async () => {
  const p = await list({ scope: 'group' }, {});
  assert.deepStrictEqual(p.sessions, []);
  assert.ok(p.note);
});

test('a caller whose own cwd is not a repo still gets its own bucket', async () => {
  const p = await list({}, asSession('sess-plain'));
  assert.strictEqual(p.project, PLAIN, 'a non-repo directory is its own project');
  assert.deepStrictEqual(idsOf(p), ['sess-plain']);
});
