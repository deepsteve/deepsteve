// The exact `tmux new-session` argv TmuxEngine.spawn() builds (#621).
//
// This is the riskiest code path in the Linux port: spawnSession stopped passing the
// literal string 'zsh' and now passes whatever resolveLoginShell() picked, so the
// engine's old `cmd === 'zsh'` unwrap would have silently stopped matching and nested
// a login shell inside every session. It would still mostly *work*, which is what
// made it dangerous — hence an argv-level assertion rather than a behavioral one.
//
// Runs on the bare CI runner with no tmux at all: TmuxEngine takes an injected `exec`
// (which since #621 reaches _exec, not just the version probe) and an injected
// spawnPty, and node-pty is required lazily (#620).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TmuxEngine = require('../../engines/tmux');

// A fake tmux on disk, so probeTmux() resolves and reports a version. `-V` is the
// only call the constructor makes; everything after is captured.
function makeEngine({ version = '3.5a', binaryName = 'tmux' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxargs-'));
  const bin = path.join(dir, binaryName);
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  const calls = [];
  const exec = (file, argv) => {
    calls.push({ file, argv });
    if (argv[0] === '-V') return `tmux ${version}`;
    if (argv[0] === 'display-message') return '12345';
    return '';
  };
  const ptys = [];
  const spawnPty = (file, argv, opts) => {
    ptys.push({ file, argv, opts });
    return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 4242 };
  };

  const eng = new TmuxEngine({ binary: bin, env: { PATH: dir }, exec, spawnPty });
  return { eng, calls, ptys, bin };
}

/** The argv of the `new-session` call, which is what we actually care about. */
function newSessionArgv(calls) {
  const c = calls.find((x) => x.argv[0] === 'new-session');
  assert.ok(c, 'spawn() must issue a new-session');
  return c.argv;
}

test('the fake tmux is actually resolved — otherwise every assertion below is vacuous', () => {
  const { eng } = makeEngine();
  assert.strictEqual(eng.available, true, 'engine must consider the stub usable');
  assert.strictEqual(eng.version, '3.5');
});

test('an injected exec reaches _exec, not just the version probe (#621)', () => {
  // Before this, spawn() called execFileSync directly and genuinely shelled out, so
  // none of this file could exist on a runner without tmux.
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', "claude '--x'"], '/repo', { shellCommand: "claude '--x'" });
  assert.ok(calls.some((c) => c.argv[0] === 'new-session'), 'new-session must go through the injected exec');
});

test('an agent session passes the inner command through verbatim — no second shell', () => {
  const { eng, calls } = makeEngine();
  const inner = "claude '--worktree' 'scheduled-ab12'";
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo', { shellCommand: inner });

  const argv = newSessionArgv(calls);
  assert.strictEqual(argv[argv.length - 1], inner,
    'the trailing command must be exactly what spawnSession asked for');
  assert.ok(!argv.some((a) => a.includes('/bin/zsh')),
    'the login shell must NOT appear in the tmux command — tmux already runs it in $SHELL');
});

test('a terminal session passes no command at all (tmux runs its default $SHELL)', () => {
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });

  const argv = newSessionArgv(calls);
  // Last flag pair is -c <cwd>; nothing may follow it.
  assert.strictEqual(argv[argv.length - 2], '-c');
  assert.strictEqual(argv[argv.length - 1], '/repo');
  assert.ok(!argv.some((a) => a.includes('zsh')), 'no shell should be named');
});

test('REGRESSION (#621): a bash login shell produces the same argv as a zsh one', () => {
  // The whole point. The old unwrap matched on `cmd === 'zsh'`; on Debian, where
  // resolveLoginShell() returns /bin/bash, it fell through to the generic branch and
  // emitted "/bin/bash -l -c 'claude …'" as tmux's command — a shell inside a shell.
  const inner = "claude '--foo'";
  const zsh = makeEngine();
  zsh.eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo', { shellCommand: inner });
  const bash = makeEngine();
  bash.eng.spawn('abc12345', '/bin/bash', ['-l', '-c', inner], '/repo', { shellCommand: inner });

  assert.deepStrictEqual(newSessionArgv(bash.calls), newSessionArgv(zsh.calls),
    'the tmux argv must not depend on which login shell was resolved');
});

test('REGRESSION (#621): an absolute-path shell is not re-nested', () => {
  // Even staying on zsh, spawnSession now passes '/bin/zsh' rather than 'zsh'. A
  // name-based match would have missed that too.
  const inner = "claude '--foo'";
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo', { shellCommand: inner });
  const argv = newSessionArgv(calls);
  assert.strictEqual(argv.filter((a) => a.includes('zsh')).length, 0);
  assert.strictEqual(argv[argv.length - 1], inner);
});

test('shellCommand undefined still builds a quoted command from cmd+args', () => {
  // The "no opinion" arm, for any caller that is not spawnSession. Distinguishing it
  // from null is why this is a three-way and not a truthiness check.
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', 'htop', ['-d', '5'], '/repo');
  assert.strictEqual(newSessionArgv(calls).slice(-1)[0], 'htop -d 5');
});

test('shellCommand null and undefined are different things', () => {
  const withNull = makeEngine();
  withNull.eng.spawn('abc12345', 'htop', ['-d', '5'], '/repo', { shellCommand: null });
  const argv = newSessionArgv(withNull.calls);
  assert.ok(!argv.includes('htop -d 5'), 'null means "no command", not "derive one"');
});

test('session name, geometry and cwd are unchanged', () => {
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { cols: 100, rows: 30, shellCommand: null });
  const argv = newSessionArgv(calls);
  assert.deepStrictEqual(argv.slice(0, 9),
    ['new-session', '-d', '-s', 'ds-abc12345', '-x', '100', '-y', '30', '-c']);
});

test('tmux >= 3.2 forwards env with -e, before the command', () => {
  const { eng, calls } = makeEngine({ version: '3.5a' });
  const inner = "claude '--foo'";
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo',
    { env: { DEEPSTEVE_SESSION_ID: 'abc12345' }, shellCommand: inner });
  const argv = newSessionArgv(calls);
  const at = argv.indexOf('-e');
  assert.ok(at > 0, 'expected an -e pair');
  assert.strictEqual(argv[at + 1], 'DEEPSTEVE_SESSION_ID=abc12345');
  assert.strictEqual(argv[argv.length - 1], inner, 'the command still comes last');
});

test('tmux < 3.2 wraps with `env`, and still does not add a shell', () => {
  const { eng, calls } = makeEngine({ version: '3.0a' });
  const inner = "claude '--foo'";
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo',
    { env: { DEEPSTEVE_SESSION_ID: 'abc12345' }, shellCommand: inner });
  const last = newSessionArgv(calls).slice(-1)[0];
  assert.match(last, /^env DEEPSTEVE_SESSION_ID=abc12345 claude '--foo'$/);
  assert.ok(!last.includes('zsh'), 'the env wrapper must not reintroduce a shell');
});

test('the engine never invokes a shell — only the resolved tmux binary', () => {
  const { eng, calls, ptys, bin } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  for (const c of calls) {
    assert.strictEqual(c.file, bin, `every exec must be tmux itself, got ${c.file}`);
  }
  // The attach PTY runs tmux too, not a shell — that is what makes the session
  // survive the daemon (#620).
  for (const p of ptys) {
    assert.strictEqual(p.file, bin, `attach must spawn tmux, got ${p.file}`);
    assert.strictEqual(p.argv[0], 'attach-session');
  }
});
