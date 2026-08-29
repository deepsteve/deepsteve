// Unit tests for project-scope.js (#659) — the shared "which project is this, and
// what else is in its group?" module that mods/scheduled-tasks, mods/project-mods and
// mods/deepsteve-core all now import instead of each keeping a private copy.
//
// Two things this file exists to pin:
//
// 1. The three compatibility options. mods/scheduled-tasks passes all three because
//    `task.project` is PERSISTED to scheduled-tasks.json and list_scheduled_tasks
//    scopes with `t.project === proj`. Tightening any of them would make freshly
//    written project strings stop matching rows already on disk, and existing tasks
//    would quietly vanish from their own project's listing. A future tidy-up that
//    deletes a flag has to delete this test first, which is the point.
// 2. groupScopeDirs, which had no coverage anywhere in the tree before this.
//
// Pure fs + direct calls: no daemon, no PTY, no engines/node-pty import, so it runs
// in the bare `unit` CI job.
//
// Run: node --test test/unit/project-scope.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scope = require('../../project-scope');
const {
  callerShellId, canonicalRoot, sessionRepoRoot, resolveProject,
  pathInside, groupScopeDirs, inScope, displayName, disambiguate,
} = scope;

// ------------------------------------------------------------------- fixtures

// A real directory with a .git marker, so findGitRoot() canonicalizes to it.
// realpathSync because findGitRoot realpaths, and /var → /private/var on macOS.
function makeRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ds-scope-${name}-`));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  return fs.realpathSync(root);
}

function makePlainDir(name) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ds-plain-${name}-`)));
}

const REPO = makeRepo('repo');
const SUBDIR = path.join(REPO, 'src');
const PLAIN = makePlainDir('plain');
const GONE = path.join(os.tmpdir(), 'ds-scope-definitely-not-here');

// mods/scheduled-tasks' options, spelled out here rather than imported so a change to
// the mod's constant shows up as a failure here instead of silently agreeing.
const LEGACY = { requireAbsolute: false, allowMissing: true, canonicalizeSession: false };

// The two `extra` shapes in the tree: a real URL (what the MCP SDK hands over) and the
// hand-built one the scheduled-tasks suite uses.
const asRealUrl = (shellId) => ({ requestInfo: { url: new URL(`http://x/mcp?shellId=${shellId}`) } });
const asSession = (shellId) => ({ requestInfo: { url: { searchParams: new URLSearchParams({ shellId }) } } });

// A ctx in the shape initMCP hands a mod. `sessionPaths` mirrors server.js: it strips
// a worktree suffix and otherwise reports cwd as the repo root.
function makeCtx({ shells = new Map(), contexts = [], withSessionPaths = true, withPathInside = true } = {}) {
  const ctx = { shells };
  if (withSessionPaths) {
    ctx.sessionPaths = (e) => ({ cwd: e.cwd, repoRoot: e.repoRoot || e.cwd });
  }
  ctx.getContexts = () => contexts;
  if (withPathInside) {
    ctx.pathInside = (p, dir) => {
      if (!p || !dir) return false;
      const base = String(dir).replace(/\/+$/, '');
      return p === base || p.startsWith(base + '/');
    };
  }
  return ctx;
}

// ---------------------------------------------------------------- callerShellId

test('callerShellId reads the shellId off either extra shape, and null otherwise', () => {
  assert.strictEqual(callerShellId(asRealUrl('abc123')), 'abc123');
  assert.strictEqual(callerShellId(asSession('abc123')), 'abc123');
  assert.strictEqual(callerShellId({}), null);
  assert.strictEqual(callerShellId(undefined), null);
  assert.strictEqual(callerShellId({ requestInfo: {} }), null);
});

// ---------------------------------------------------------------- canonicalRoot

test('canonicalRoot maps a path to the repo it belongs to, keeps a plain dir, drops the rest', () => {
  assert.strictEqual(canonicalRoot(REPO), REPO);
  assert.strictEqual(canonicalRoot(SUBDIR), REPO, 'a subdirectory canonicalizes to its repo root');
  assert.strictEqual(canonicalRoot(PLAIN), PLAIN, 'a non-repo directory is kept as-is');
  assert.strictEqual(canonicalRoot(GONE), '', 'a nonexistent path is not a project');
  assert.strictEqual(canonicalRoot(''), '');
  assert.strictEqual(canonicalRoot(null), '');
});

// -------------------------------------------------------------- sessionRepoRoot

test('sessionRepoRoot is defensive about every part of the ctx it needs', () => {
  const shells = new Map([['s1', { cwd: SUBDIR }]]);
  assert.strictEqual(sessionRepoRoot(makeCtx({ shells }), 's1'), SUBDIR,
    'raw: sessionPaths only strips a worktree suffix, it does not find a git root');
  assert.strictEqual(sessionRepoRoot(makeCtx({ shells }), 'nope'), '', 'unknown shellId');
  assert.strictEqual(sessionRepoRoot(makeCtx({ shells }), null), '', 'no shellId');
  assert.strictEqual(sessionRepoRoot(null, 's1'), '', 'no ctx at all');
  // The shape test/unit/scheduled-task-tombstone.test.js builds: shells, no sessionPaths.
  assert.strictEqual(sessionRepoRoot(makeCtx({ shells, withSessionPaths: false }), 's1'), '',
    'a ctx without sessionPaths returns empty rather than throwing');
});

// -------------------------------------------------------------- resolveProject

test('resolveProject: an explicit path wins over the caller session', () => {
  const ctx = makeCtx({ shells: new Map([['s1', { cwd: PLAIN }]]) });
  assert.strictEqual(resolveProject(SUBDIR, 's1', ctx), REPO);
  assert.strictEqual(resolveProject(`  ${REPO}  `, 's1', ctx), REPO, 'whitespace is trimmed');
});

test('resolveProject falls back to the caller session, canonicalized by default', () => {
  const ctx = makeCtx({ shells: new Map([['s1', { cwd: SUBDIR }]]) });
  assert.strictEqual(resolveProject('', 's1', ctx), REPO,
    'a session opened in a subdirectory belongs to its repo');
  assert.strictEqual(resolveProject(undefined, 'unknown', ctx), '');
  assert.strictEqual(resolveProject('', null, ctx), '');
});

test('resolveProject: the default (project-mods / list_sessions) semantics are strict', () => {
  const ctx = makeCtx();
  assert.strictEqual(resolveProject('relative/path', null, ctx), '', 'a relative path is not a project');
  assert.strictEqual(resolveProject(GONE, null, ctx), '', 'a nonexistent path is not a project');
});

test('resolveProject: the scheduled-tasks options keep its looser behaviour exactly', () => {
  const ctx = makeCtx({ shells: new Map([['s1', { cwd: SUBDIR }]]) });

  // allowMissing: runTask feeds task.project to spawnCwdProblem and refuses the fire
  // loudly (#632). Dropping a nonexistent path to '' would silently reroute the run
  // to the homedir instead — a good error turned into a wrong success.
  assert.strictEqual(resolveProject(GONE, null, ctx, LEGACY), GONE);
  assert.strictEqual(resolveProject('relative/path', null, ctx, LEGACY), 'relative/path');

  // canonicalizeSession: false — the stored string stays whatever sessionPaths said,
  // so it keeps matching rows already in scheduled-tasks.json.
  assert.strictEqual(resolveProject('', 's1', ctx, LEGACY), SUBDIR);

  // The branches the options do NOT change.
  assert.strictEqual(resolveProject(SUBDIR, null, ctx, LEGACY), REPO,
    'an explicit path is canonicalized either way');
  assert.strictEqual(resolveProject(PLAIN, null, ctx, LEGACY), PLAIN);
});

// ------------------------------------------------------------------ pathInside

test('pathInside prefers the ctx implementation and falls back to its own', () => {
  const ctx = makeCtx();
  assert.strictEqual(pathInside('/a/b', '/a', ctx), true);
  assert.strictEqual(pathInside('/a', '/a', ctx), true);
  assert.strictEqual(pathInside('/ab', '/a', ctx), false, 'a prefix is not a parent directory');
  assert.strictEqual(pathInside('', '/a', ctx), false);

  const bare = makeCtx({ withPathInside: false });
  assert.strictEqual(pathInside('/a/b', '/a/', bare), true, 'the fallback ignores trailing slashes');
  assert.strictEqual(pathInside('/a/b', '/c', bare), false);
  assert.strictEqual(pathInside('/a/b', '/a', null), true, 'and works with no ctx at all');
});

// -------------------------------------------------------------- groupScopeDirs

test('groupScopeDirs unions the dirs of every context containing the project', () => {
  const contexts = [
    { id: 'g1', name: 'Alpha', dirs: ['/work/alpha', '/work/alpha-extras'] },
    { id: 'g2', name: 'Beta', dirs: ['/work/beta'] },
  ];
  const ctx = makeCtx({ contexts });

  assert.deepStrictEqual(
    groupScopeDirs('/work/alpha/repo', ctx).sort(),
    ['/work/alpha', '/work/alpha-extras', '/work/alpha/repo'].sort(),
    'membership is by folder prefix, and the project itself is always in scope');

  assert.deepStrictEqual(groupScopeDirs('/elsewhere/repo', ctx), ['/elsewhere/repo'],
    'a project in no context is its own group');

  assert.deepStrictEqual(groupScopeDirs('', ctx), [],
    'no project means no group — such a row can only ever surface under scope:"all"');
});

test('groupScopeDirs handles a repo in two contexts, and a core that has none', () => {
  const contexts = [
    { id: 'g1', name: 'Alpha', dirs: ['/work'] },
    { id: 'g2', name: 'Beta', dirs: ['/work/shared', '/other'] },
  ];
  assert.deepStrictEqual(
    groupScopeDirs('/work/shared', makeCtx({ contexts })).sort(),
    ['/other', '/work', '/work/shared'].sort(),
    'both contexts contribute their dirs');

  // An older core exposes no getContexts: group scope degrades to self-only rather
  // than throwing.
  assert.deepStrictEqual(groupScopeDirs('/work/shared', { shells: new Map() }), ['/work/shared']);
  assert.deepStrictEqual(groupScopeDirs('/work/shared', null), ['/work/shared']);
});

test('groupScopeDirs survives a malformed context row', () => {
  const contexts = [{ id: 'g1', name: 'Bad' }, null, { id: 'g2', dirs: '/not-an-array' }];
  assert.deepStrictEqual(groupScopeDirs('/work/repo', makeCtx({ contexts })), ['/work/repo']);
});

// --------------------------------------------------------------------- inScope

test('inScope is the one filter all three scopes go through', () => {
  const ctx = makeCtx({ contexts: [{ id: 'g1', name: 'Alpha', dirs: ['/work'] }] });

  assert.strictEqual(inScope('/work/a', '/work/a', 'project', ctx), true);
  assert.strictEqual(inScope('/work/b', '/work/a', 'project', ctx), false);

  assert.strictEqual(inScope('/work/b', '/work/a', 'group', ctx), true, 'a sibling under the same context dir');
  assert.strictEqual(inScope('/elsewhere', '/work/a', 'group', ctx), false);

  assert.strictEqual(inScope('/elsewhere', '/work/a', 'all', ctx), true);
  assert.strictEqual(inScope('', '', 'all', ctx), true, 'even a row with no project');
  assert.strictEqual(inScope('', '/work/a', 'group', ctx), false,
    'a row with no project is never in a group');
});

// ------------------------------------------------------- displayName / disambiguate

test('displayName is the basename, or a readable stand-in', () => {
  assert.strictEqual(displayName('/a/b/deepsteve'), 'deepsteve');
  assert.strictEqual(displayName(''), 'No project');
  assert.strictEqual(displayName(null), 'No project');
});

test('disambiguate widens only the colliding basenames', () => {
  assert.deepStrictEqual([...disambiguate(['/a/solo', '', null])], [['/a/solo', 'solo']]);
  assert.deepStrictEqual(
    [...disambiguate(['/x/dash', '/y/dash', '/z/other'])].sort(),
    [['/x/dash', 'x/dash'], ['/y/dash', 'y/dash'], ['/z/other', 'other']].sort());
});
