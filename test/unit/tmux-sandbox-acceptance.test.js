// The acceptance test #625 asks for, in the issue's own words:
//
//   "No code path under test/** can reach the developer's tmux socket, demonstrated by
//    the failure path: make before() throw immediately after the sandbox path is
//    assigned, run the suite, and assert every real ds-* session survives. A passing
//    green run proves nothing here — the bug only appears when setup fails."
//
// Rendered with decoys instead of the developer's real sessions, so it needs no
// particular machine and destroys nothing if it regresses. Two decoys matter:
//
//   AMBIENT — an empty directory handed to the child as TMUX_TMPDIR, i.e. the exact
//     fallback surface the old design aimed through. If ANYTHING in that child reached
//     tmux via the environment, tmux would have created `tmux-<uid>/` inside it. The
//     directory staying empty is therefore proof of a negative that needs no tmux at
//     all, which is what lets this assertion run on the bare CI unit job.
//
//   BYSTANDER — a live session on an unrelated sandbox's socket, standing in for "every
//     real ds-* session". Only meaningful where tmux exists; asserted there.
//
// Same child-process shape as ws-client-guard.test.js (#562): the failure has to happen
// in a real `node --test` lifecycle, because what went wrong was a lifecycle property —
// after() runs even when before() throws.
//
// Run: node --test test/unit/tmux-sandbox-acceptance.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TmuxSandbox } = require('../helpers/tmux-sandbox');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'tmux-sandbox-victim.fixture.js');
const HAVE_TMUX = TmuxSandbox.skipReason() === null;

let AMBIENT = null;
let victimHome = null;
let bystander = null;

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
  delete env.CLAUDECODE;
  // node:test marks its children with this, and a `node --test` inside a `node --test`
  // refuses to run the files ("run() is being called recursively") — which would make
  // every assertion below pass against a child that did nothing at all.
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

before(() => {
  AMBIENT = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ambient-'));
  victimHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-victim-'));
  if (HAVE_TMUX) {
    // Through the choke point, so this test passes its own guard.
    bystander = TmuxSandbox.mint('ds-bystander-');
    bystander.newSession('ds-bystand1');
  }
});

after(() => {
  if (bystander) { try { bystander.cleanup(); } catch {} }
  for (const d of [AMBIENT, victimHome, bystander && bystander.home]) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('SANITY: the fixture really can create a session (otherwise the bans below are vacuous)',
  { skip: HAVE_TMUX ? false : 'tmux is not installed' }, async () => {
    // Without this, "nothing was destroyed" would also be satisfied by a fixture that
    // never touched tmux at all — the vacuous pass this whole file exists to avoid.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-victim-ok-'));
    try {
      const { code, stdout, stderr } = await run(
        ['--test', FIXTURE], childEnv({ HOME: home, DS_INJECT: 'none' }));
      assert.strictEqual(code, 0,
        `the fixture should pass when nothing is injected\n${stdout}\n${stderr}`);
      const s = TmuxSandbox.forHome(path.join(home, 'scratch-home'));
      assert.deepStrictEqual(s.sessionNames(), [],
        'and after() should have reaped its own session');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

for (const inject of ['pre', 'post']) {
  test(`before() throwing (${inject}) destroys nothing outside the child's own socket`, async () => {
    const { code, stdout, stderr } = await run(
      ['--test', FIXTURE],
      // The old fallback surface, aimed at an empty decoy so that any use of it is
      // DETECTABLE rather than fatal. This is the one place under test/** that must
      // name the variable, because naming it is how we prove nothing reads it.
      // tmux-guard-allow: the decoy IS the assertion — see the readdirSync below
      childEnv({ HOME: victimHome, DS_INJECT: inject, TMUX_TMPDIR: AMBIENT })
    );

    // 1. Vacuity guard: the injected throw really did fail the run. A fixture that
    //    quietly passed would satisfy every assertion below for the wrong reason.
    assert.notStrictEqual(code, 0,
      `the fixture was supposed to fail\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    assert.match(stdout + stderr, /injected:/, 'and to fail for the reason we injected');

    // 2. THE load-bearing assertion, and it needs neither tmux nor a live session:
    //    nothing in that child resolved a tmux socket through the environment. Before
    //    #625, after()'s kill-server with an undefined TMUX_TMPDIR went to the real
    //    per-UID socket; with the variable set, as here, it would have created
    //    tmux-<uid>/ inside AMBIENT.
    assert.deepStrictEqual(fs.readdirSync(AMBIENT), [],
      `the child reached tmux through the environment (${fs.readdirSync(AMBIENT).join(', ')}). ` +
      'Since #625 the socket comes from -S only, and that variable must be inert.');

    // 3. Where tmux exists, an unrelated live session is untouched — the literal
    //    "every real ds-* session survives" from the acceptance criteria.
    if (HAVE_TMUX) {
      assert.ok(bystander.hasSession('ds-bystand1'),
        "a live session on another sandbox's socket was destroyed by an unrelated suite's after()");
    }
  });
}

test('a sandbox can never be aimed at the real install, however it is asked', () => {
  // The other half of "unrepresentable": not just that the failure path is safe, but
  // that the safe path cannot be talked into being the dangerous one.
  const realSocket = path.join(os.homedir(), '.deepsteve', 'tmux.sock');
  assert.throws(() => TmuxSandbox.forHome(os.homedir()), /real HOME|LIVE daemon/);
  // A relative route back to it is refused by the same check, since the comparison is
  // on resolved paths rather than on the string that was passed.
  assert.throws(() => TmuxSandbox.forHome(path.join(os.homedir(), 'x', '..')), /real HOME|LIVE daemon/);

  const s = TmuxSandbox.mint('ds-accept-');
  try {
    assert.notStrictEqual(path.resolve(s.socketPath), path.resolve(realSocket));
    // Even the legacy view — the one place the old environment variable still means
    // anything — is confined to the sandbox rather than pointing at the real default
    // socket. Asserted through the env object generically, so this file does not have
    // to name the variable a third time.
    assert.ok(s.legacy.socketPath.startsWith(s.home + path.sep),
      'the legacy stand-in socket escaped the sandbox');
    const legacyEnv = Object.entries(s.legacy.env);
    assert.ok(legacyEnv.length > 0, 'the legacy view must hand a child something to resolve with');
    for (const [k, v] of legacyEnv) {
      assert.ok(v.startsWith(s.home + path.sep), `${k}=${v} points outside the sandbox`);
    }
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});
