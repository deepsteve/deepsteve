// Anti-drift guard for #680: no surface may be the only one that lists live sessions.
//
// The bug this exists for. DeepSteve had three answers to "which sessions exist and who
// owns them" — the tab bar (localStorage), the restore modal (/api/recoverable-sessions)
// and the tab strip's own memory — and no fourth thing ever checked them against each
// other. A session could be alive, healthy, correctly grouped server-side, and drawn by
// none of them; #680's ran mid-turn for minutes and was found by tailing the log.
//
// The fix was to add the missing assertion (the orphan sweep) and to make it read the
// SAME builder the two endpoints answer from, so "what the server thinks exists" is one
// function with one definition. This file is what stops that collapsing back: a fourth
// surface that grows its own `shells` + `savedState` walk, or a sweep that stops using
// buildWindowsView(), fails here.
//
// What it can and cannot prove. It is a pure source read — no server boot, so it runs in
// the bare `unit` CI job (which has no zsh). It proves there is exactly ONE window→session
// grouping implementation and that the three surfaces call it. It cannot prove the
// grouping is correct; that is test/integration-standalone/window-restore.test.js.
//
// Run: node --test test/unit/windows-view-single-source.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// The three surfaces that are allowed to answer "which sessions exist, grouped by
// window". Adding a fourth is fine — adding it WITHOUT buildWindowsView() is the bug.
const EXPECTED_CALLERS = ['/api/windows', '/api/recoverable-sessions', 'orphan sweep'];

test('buildWindowsView is defined exactly once', () => {
  const defs = server.match(/^function buildWindowsView\(/gm) || [];
  assert.strictEqual(defs.length, 1, 'one builder, or the surfaces can disagree');
});

test('the windowId grouping is implemented exactly once', () => {
  // `byWindow` is the grouping itself. A second one anywhere in server.js means some
  // surface re-derived "who owns what" instead of asking, which is precisely how the
  // tab bar and the server came to silently disagree.
  const groupings = server.match(/const byWindow = new Map\(\)/g) || [];
  assert.strictEqual(groupings.length, 1,
    'a second window→session grouping has appeared — route it through buildWindowsView()');
});

test('every caller of buildWindowsView is one of the three known surfaces', () => {
  // Code lines only — the name appears in prose above the builder and above the sweep,
  // and a comment is not a second source of truth.
  const calls = server.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(l => l.includes('buildWindowsView('));
  // One definition + N call sites.
  assert.strictEqual(calls.length, EXPECTED_CALLERS.length + 1,
    `expected ${EXPECTED_CALLERS.length} call sites (${EXPECTED_CALLERS.join(', ')}) plus the definition; `
    + 'a new surface must be added to EXPECTED_CALLERS here so the guard keeps counting');
});

test('the reachability check reads the shared builder, not shells directly', () => {
  // The whole point of the guard: if the sweep ever walks `shells` itself it can decide
  // a session exists that /api/windows does not report, or vice versa — and the drift
  // would be invisible again.
  const sweep = server.slice(server.indexOf('function sweepOrphanSessions('));
  assert.ok(sweep, 'sweepOrphanSessions() is gone — the invariant has no assertion left');
  const body = sweep.slice(0, sweep.indexOf('\n}\n') + 3);
  assert.match(body, /buildWindowsView\(\)/,
    'the orphan sweep must read the same view the UI surfaces do');
  assert.doesNotMatch(body, /\bfor \(const \[.*\] of shells\)/,
    'the sweep must not enumerate shells itself — that is a second source of truth');
});

test('the view carries attached-client counts, which the sweep needs', () => {
  // `attached` is what makes "no surface can reach this" computable from the shared
  // view alone. Without it the sweep would have to consult `shells`, which is the very
  // second walk this file exists to prevent.
  assert.match(server, /attached: entry\.clients \? entry\.clients\.size : 0/,
    'buildWindowsView() must report attached clients per session');
});

test('the orphan sweep is armed', () => {
  // An assertion nobody runs is a comment.
  assert.match(server, /setInterval\(sweepOrphanSessions, ORPHAN_SWEEP_MS\)/);
});
