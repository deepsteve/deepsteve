// A scheduled run must never be offered as a recoverable session (#597 follow-up).
//
// #597 established the rule but enforced it in exactly one place: the `ungrouped`
// bucket of buildWindowsView(), which covers a run that is IN FLIGHT and not yet
// attached to a window. The normal end of every fire — scheduled_task_finished →
// auto-close → tombstoneSession() — goes down a different path into the `closed`
// bucket of /api/recoverable-sessions, which had no such check. Result: every
// unattended run the user never saw piled into "Recently closed" (58 of 318 rows
// on a real install), inviting them to resurrect automation tabs one by one.
//
// The other half of the bug is that the `scheduled: true` flag is not enough on
// its own. It was added by #597, so every tombstone written before that deploy
// lacks the field entirely — a filter on the flag alone would fix future runs and
// leave the existing backlog on screen forever. Hence the worktree/name fallback,
// which is the part most at risk of silently rotting if mods/scheduled-tasks
// changes how it names a run: the last test here pins both shapes to their source.
//
// Run: node --test test/unit/scheduled-not-recoverable.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Lift isScheduledRun straight out of server.js (requiring server.js boots the
// daemon). Binding to the real source is the point: a future edit that drops the
// legacy fallback fails here rather than in a user's restore modal.
function extract(fnName) {
  const start = serverSource.indexOf(`function ${fnName}(`);
  assert.ok(start >= 0, `missing function ${fnName} in server.js`);
  const end = serverSource.indexOf('\n}\n', start);
  assert.ok(end > start, `could not find end of ${fnName}`);
  const src = serverSource.slice(start, end + 2);
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nmodule.exports = ${fnName};`, ctx);
  return ctx.module.exports;
}

const isScheduledRun = extract('isScheduledRun');

test('the #597 flag marks a scheduled run', () => {
  assert.strictEqual(isScheduledRun({ scheduled: true }), true);
  assert.strictEqual(isScheduledRun({ scheduled: false }), false);
});

test('pre-#597 tombstones are caught by worktree and name shape', () => {
  // These two are what a real install's state.json holds: the flag never existed
  // when they were written.
  assert.strictEqual(isScheduledRun({ worktree: 'scheduled-8ad30610' }), true);
  assert.strictEqual(isScheduledRun({ name: '⏰ Shorts analytics daily digest' }), true);
});

test('an ordinary session is never mistaken for a scheduled run', () => {
  assert.strictEqual(isScheduledRun({}), false);
  assert.strictEqual(isScheduledRun(null), false);
  assert.strictEqual(isScheduledRun(undefined), false);
  // A hand-made worktree that merely mentions scheduling, and an agent-picked tab
  // name about a scheduled feature, are both real user sessions. Only the exact
  // machine-minted shapes count: anchored `scheduled-` worktree, leading ⏰.
  assert.strictEqual(isScheduledRun({ worktree: 'worktree-github-issue-604' }), false);
  assert.strictEqual(isScheduledRun({ worktree: 'my-scheduled-experiment' }), false);
  assert.strictEqual(isScheduledRun({ name: '#604 Scheduled runs: default model' }), false);
  assert.strictEqual(isScheduledRun({ name: 'deepsteve-experimental' }), false);
});

test('both recoverable buckets filter through the same predicate', () => {
  // The bug was two buckets with two rules. Assert the closed bucket and the
  // ungrouped check both call isScheduledRun — not that one of them reimplements it.
  const closedFilter = serverSource.match(/const closed = Object\.entries\(savedState\)\s*\n\s*\.filter\(([^\n]*)\)/);
  assert.ok(closedFilter, 'could not find the closed bucket filter');
  assert.match(closedFilter[1], /isScheduledRun/);

  const ungrouped = serverSource.match(/if \(collectUngrouped &&[^\n]*\)/);
  assert.ok(ungrouped, 'could not find the ungrouped collect check');
  assert.match(ungrouped[0], /isScheduledRun/);
});

test('the fallback shapes still match what scheduled-tasks actually mints', () => {
  // The worktree name and the ⏰ tab-name prefix are a contract between the mod
  // and isScheduledRun. If the mod stops minting these, the fallback silently
  // stops matching and pre-#597 tombstones return to the restore modal.
  const modSource = fs.readFileSync(path.join(ROOT, 'mods', 'scheduled-tasks', 'tools.js'), 'utf8');
  assert.match(modSource, /`scheduled-\$\{/, 'mod no longer mints a scheduled-<id> worktree');
  assert.match(modSource, /⏰/, 'mod no longer prefixes run tab names with ⏰');
});
