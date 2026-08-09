// A deliberately BROKEN test suite, driven as a child process by
// test/unit/tmux-sandbox-acceptance.test.js (#625). Not a test file itself: the
// `.fixture.js` name keeps it out of `node --test test/unit/*.test.js`.
//
// It reproduces the exact shape of the incident. `before()` throws; `after()` runs
// anyway (node:test always runs root hooks); `after()` reaps tmux. Under the old
// design the reap was `tmux kill-server` aimed by TMUX_TMPDIR — a module-level `let`
// that `before()` assigned LATE — so an early throw left it undefined, Node dropped the
// env key, and the command landed on the developer's real per-UID socket.
//
//   DS_INJECT=pre   throw BEFORE the sandbox exists      → after() sees null
//   DS_INJECT=post  throw immediately AFTER it is assigned → the incident's shape
//   DS_INJECT=none  succeed, so the harness can prove the fixture is capable of
//                   creating a session at all (otherwise "nothing was destroyed" is
//                   satisfied by a fixture that never did anything)
//
// The harness runs this with HOME already pointed at a scratch directory, so the child
// is incapable of reaching the developer's install even if every check below fails —
// a test that could destroy real sessions on a regression would be the wrong test. The
// anchor is a SUBDIRECTORY of that scratch HOME, because os.homedir() reads $HOME and
// the sandbox refuses to anchor on it; a real suite is in the same shape (its own HOME
// is the developer's, and it anchors on a mkdtemp).
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { TmuxSandbox } = require('../../helpers/tmux-sandbox');

let sandbox = null;

before(() => {
  const scratch = path.join(process.env.HOME, 'scratch-home');
  fs.mkdirSync(scratch, { recursive: true });
  if (process.env.DS_INJECT === 'pre') throw new Error('injected: before the sandbox exists');
  sandbox = TmuxSandbox.forHome(scratch);
  if (process.env.DS_INJECT === 'post') throw new Error('injected: right after the path is assigned');
  sandbox.newSession('ds-victim01');
});

// The `?.` is the thing under test. There is no third state: either before() got far
// enough to produce a fully validated sandbox, or this is a no-op.
after(() => {
  sandbox?.cleanup();
});

test('the fixture ran', () => {
  if (!sandbox) throw new Error('no sandbox');
});
