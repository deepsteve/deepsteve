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
//
// #624 added the `attach-session` side, which is where the glyph/colour defects
// lived. Note the injected env below is DELIBERATELY locale-free: the underscore bug
// only exists in an environment with no LC_ALL/LC_CTYPE/LANG, which is what a
// launchd/systemd daemon has and an interactive test runner does not. A test that
// inherited process.env would pass against the bug.
//
// #630 INVERTED several of the assertions below, and the story is worth knowing
// before editing them. #621's unwrap was right that a login shell must not nest
// inside tmux's own — so it handed tmux the inner command as ONE string. But tmux
// runs a single `shell-command` argument through `default-shell -c`, a NON-login
// shell, so removing the nesting also removed the `-l`: ~/.zprofile was never
// sourced and /opt/homebrew/bin never reached an agent's PATH under the default
// engine. Handing tmux the argv as MULTIPLE arguments (exec'd directly, tmux 2.0+)
// gives one shell AND the login flag. So "the login shell must NOT appear in the
// tmux command" — the old assertion, and the bug in one line — is now "it must
// appear, exactly once, with its login flag, as separate argv elements".
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TmuxEngine = require('../../engines/tmux');
const { LOCALE_VARS } = require('../../terminal-env');

// Every tmux command carries `-S <socket>` since #625, so the assertions here are about
// what follows it. `socketArgv()` strips the prefix (asserting it is there first); the
// prefix itself is the subject of test/unit/tmux-socket.test.js.
const SOCKET = '/tmp/ds-fake/tmux.sock';

// A fake tmux on disk, so probeTmux() resolves and reports a version. `-V` is the
// only call the constructor makes; everything after is captured.
//
// `env` stands in for the daemon's environment — since #624 the engine reads it at
// runtime too (the spawn-time diff, and the attach client's env), not just to find
// tmux on $PATH. Tests that care about the daemon's env add keys here.
function makeEngine({ version = '3.5a', binaryName = 'tmux', env: extraEnv } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxargs-'));
  const bin = path.join(dir, binaryName);
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  const calls = [];
  const exec = (file, argv) => {
    calls.push({ file, argv });
    if (argv[0] === '-V') return `tmux ${version}`;
    if (argv.includes('display-message')) return '12345';
    return '';
  };
  const ptys = [];
  const spawnPty = (file, argv, opts) => {
    ptys.push({ file, argv, opts });
    return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 4242 };
  };

  const daemonEnv = { PATH: dir, ...extraEnv };
  const eng = new TmuxEngine({ binary: bin, socket: SOCKET, env: daemonEnv, exec, spawnPty });
  return { eng, calls, ptys, bin, daemonEnv };
}

/** A command's argv with the socket prefix removed — and asserted present. */
function afterSocket(argv) {
  assert.deepStrictEqual(argv.slice(0, 2), ['-S', SOCKET],
    'every tmux command must lead with the socket flag (#625)');
  return argv.slice(2);
}

/** The argv of the `new-session` call, which is what we actually care about. */
function newSessionArgv(calls) {
  const c = calls.find((x) => x.argv.includes('new-session'));
  assert.ok(c, 'a new-session must be issued by spawn()');
  return afterSocket(c.argv);
}

/** The `-e KEY=VAL` pairs of a new-session argv, as an object. */
function envPairs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-e') continue;
    const eq = argv[i + 1].indexOf('=');
    out[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
  }
  return out;
}

test('the fake tmux is actually resolved — otherwise every assertion below is vacuous', () => {
  const { eng } = makeEngine();
  assert.strictEqual(eng.available, true, 'engine must consider the stub usable');
  assert.strictEqual(eng.version, '3.5');
});

test('the injected daemon env is locale-free — otherwise the #624 assertions are vacuous', () => {
  const { daemonEnv } = makeEngine();
  for (const name of LOCALE_VARS) {
    assert.strictEqual(daemonEnv[name], undefined,
      `${name} must be absent, or these tests pass against the bug they exist to catch`);
  }
  assert.strictEqual(daemonEnv.COLORTERM, undefined);
});

test('an injected exec reaches _exec, not just the version probe (#621)', () => {
  // Before this, spawn() called execFileSync directly and genuinely shelled out, so
  // none of this file could exist on a runner without tmux.
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', "claude '--x'"], '/repo');
  assert.ok(calls.some((c) => c.argv.includes('new-session')), 'new-session must go through the injected exec');
});

test('#630: an agent session runs under a LOGIN shell, and exactly one shell', () => {
  // The pre-#630 shape was one string, `claude '--worktree' '…'`, which tmux runs
  // through `default-shell -c` — one shell, but the wrong one and not a login one.
  const { eng, calls } = makeEngine();
  const inner = "claude '--worktree' 'scheduled-ab12'";
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo');

  const argv = newSessionArgv(calls);
  assert.deepStrictEqual(argv.slice(-4), ['/bin/zsh', '-l', '-c', inner],
    'the pane argv must be the login shell, its login flag, -c and the inner command');
  assert.strictEqual(argv.filter((a) => a === '/bin/zsh').length, 1,
    'exactly one shell — nesting is what #621 removed and this must not bring back');
  assert.ok(!argv.some((a) => a.includes('/bin/zsh') && a.includes(' ')),
    'the pane command must be argv ELEMENTS, never one joined string: a single '
    + 'shell-command argument is what tmux runs through a non-login shell (#630)');
});

test('a terminal session passes no command at all (tmux forks default-shell, as a login shell)', () => {
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });

  const argv = newSessionArgv(calls);
  const at = argv.indexOf('-c');
  assert.strictEqual(argv[at + 1], '/repo', '-c must be followed by the cwd');
  // Since #624 every session carries -e pairs, so "no command" can no longer be
  // spelled as "nothing follows the cwd". It is instead: everything after the cwd
  // is an -e flag or its value, i.e. there is no trailing shell-command argument.
  const trailing = argv.slice(at + 2);
  assert.ok(trailing.length % 2 === 0 && trailing.every((a, i) => (i % 2 === 0 ? a === '-e' : a.includes('='))),
    `only -e pairs may follow the cwd, got ${JSON.stringify(trailing)}`);
  assert.ok(!argv.some((a) => a.includes('zsh')), 'no shell should be named');
});

test('REGRESSION (#621): nothing but the shell path depends on which shell was resolved', () => {
  // The whole point of #621. Its old unwrap matched on `cmd === 'zsh'`; on Debian,
  // where resolveLoginShell() returns /bin/bash, it fell through to the generic
  // branch and emitted "/bin/bash -l -c 'claude …'" as tmux's single command string
  // — a shell inside a shell. Since #630 the shell IS in the argv, deliberately, so
  // the two argvs legitimately differ; what must not differ is anything else.
  const inner = "claude '--foo'";
  const zsh = makeEngine();
  zsh.eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo');
  const bash = makeEngine();
  bash.eng.spawn('abc12345', '/bin/bash', ['-l', '-c', inner], '/repo');

  const zshArgv = newSessionArgv(zsh.calls);
  const bashArgv = newSessionArgv(bash.calls);
  assert.deepStrictEqual(zshArgv.slice(-4), ['/bin/zsh', '-l', '-c', inner]);
  assert.deepStrictEqual(bashArgv.slice(-4), ['/bin/bash', '-l', '-c', inner]);
  assert.deepStrictEqual(
    bashArgv.map((a) => (a === '/bin/bash' ? '<shell>' : a)),
    zshArgv.map((a) => (a === '/bin/zsh' ? '<shell>' : a)),
    'only the shell path may depend on which login shell was resolved');
});

test('REGRESSION (#621): an absolute-path shell is named once, not nested', () => {
  // Even staying on zsh, spawnSession passes '/bin/zsh' rather than 'zsh'. A
  // name-based match would have missed that too.
  const inner = "claude '--foo'";
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo');
  const argv = newSessionArgv(calls);
  assert.strictEqual(argv.filter((a) => a.includes('zsh')).length, 1);
  assert.strictEqual(argv[argv.length - 1], inner);
});

test('#630: the pane argv IS the argv node-pty is given', () => {
  // The parity claim, stated as argv. NodePtyEngine.spawn does pty.spawn(cmd, args, …)
  // (engines/node-pty.js), so proving the tmux pane argv is [cmd, ...args] proves the
  // two engines hand the agent the same process — the argv analogue of the env
  // invariant #624 established, and the one #630 found broken.
  //
  // node-pty's side is asserted against its SOURCE, not by requiring it: the bare CI
  // unit job installs --ignore-scripts, so there is no native binding and the require
  // would throw.
  const cmd = '/bin/zsh';
  const args = ['-l', '-c', "claude '--foo'"];
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', cmd, args, '/repo');
  assert.deepStrictEqual(newSessionArgv(calls).slice(-(1 + args.length)), [cmd, ...args]);

  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'engines', 'node-pty.js'), 'utf8');
  assert.match(src, /pty\.spawn\(cmd,\s*args,/,
    'node-pty stopped forwarding cmd+args verbatim — the parity assertion above is now a lie');
});

test('#630: a string shellCommand is refused, loudly', () => {
  // The mode that dropped the login flag is unrepresentable rather than merely
  // discouraged. spawnSession's catch turns this into a node-pty fallback with the
  // orange badge, so a caller that regresses degrades visibly instead of silently.
  const { eng } = makeEngine();
  assert.throws(
    () => eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', 'claude'], '/repo', { shellCommand: 'claude' }),
    /#630/);
});

test('shellCommand undefined passes cmd+args through as argv elements', () => {
  // The "no opinion" arm, for any caller that is not spawnSession. Distinguishing it
  // from null is why this is a two-way and not a truthiness check.
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', 'htop', ['-d', '5'], '/repo');
  assert.deepStrictEqual(newSessionArgv(calls).slice(-3), ['htop', '-d', '5']);
});

test('#630: ONE argv element is still an sh(1) command line — tmux\'s cliff', () => {
  // Documents the boundary rather than guarding it. tmux runs a single
  // shell-command argument through a shell; only two or more are exec'd directly.
  // spawnSession never produces one (an agent is always shell + -l + -c + inner),
  // but a generic caller with no args does, and gets the pre-#630 behaviour.
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', 'htop', [], '/repo');
  assert.strictEqual(newSessionArgv(calls).slice(-1)[0], 'htop');
});

test('shellCommand null and undefined are different things', () => {
  const withNull = makeEngine();
  withNull.eng.spawn('abc12345', 'htop', ['-d', '5'], '/repo', { shellCommand: null });
  const argv = newSessionArgv(withNull.calls);
  assert.ok(!argv.includes('htop'), 'null means "no command", not "derive one"');
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
    { env: { DEEPSTEVE_SESSION_ID: 'abc12345' } });
  const argv = newSessionArgv(calls);
  const at = argv.indexOf('-e');
  assert.ok(at > 0, 'expected an -e pair');
  assert.strictEqual(argv[at + 1], 'DEEPSTEVE_SESSION_ID=abc12345');
  assert.deepStrictEqual(argv.slice(-4), ['/bin/zsh', '-l', '-c', inner],
    'the pane argv still comes last, after every -e pair');
});

test('tmux < 3.2 wraps with `env`, and still does not nest a shell', () => {
  const { eng, calls } = makeEngine({ version: '3.0a' });
  const inner = "claude '--foo'";
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo',
    { env: { DEEPSTEVE_SESSION_ID: 'abc12345' } });
  const argv = newSessionArgv(calls);
  const at = argv.indexOf('env');
  assert.ok(at > 0, 'expected an env(1) prefix');
  assert.strictEqual(argv[at + 1], 'DEEPSTEVE_SESSION_ID=abc12345', 'the caller env comes first');
  const pairs = argv.slice(at + 1, -4);
  assert.ok(pairs.every((a) => a.includes('=')), `only KEY=VAL may sit between env and the shell, got ${JSON.stringify(pairs)}`);
  assert.ok(pairs.some((a) => /^LC_CTYPE=\S+$/.test(a)), 'the #624 locale must survive the pre-3.2 path too');
  assert.ok(pairs.includes('COLORTERM=truecolor'));
  // Since #630 the pane argv NAMES the login shell — the point of the change. What
  // must not come back is a second one, or a joined command string for env to re-parse.
  assert.deepStrictEqual(argv.slice(-4), ['/bin/zsh', '-l', '-c', inner]);
  assert.strictEqual(argv.filter((a) => a.includes('zsh')).length, 1,
    'the env wrapper must not reintroduce a shell');
});

test('the engine never invokes a shell — only the resolved tmux binary', () => {
  // "Invokes", not "names". Since #630 the pane argv for an agent session names the
  // login shell (that is the fix); what the ENGINE execs is still only tmux.
  const { eng, calls, ptys, bin } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  for (const c of calls) {
    assert.strictEqual(c.file, bin, `every exec must be tmux itself, got ${c.file}`);
  }
  // The attach PTY runs tmux too, not a shell — that is what makes the session
  // survive the daemon (#620). Since #624 the subcommand is preceded by top-level
  // flags, so it is no longer argv[0].
  for (const p of ptys) {
    assert.strictEqual(p.file, bin, `attach must spawn tmux, got ${p.file}`);
    assert.ok(p.argv.includes('attach-session'), `expected an attach, got ${JSON.stringify(p.argv)}`);
    assert.ok(!p.argv.some((a) => a.includes('sh')), 'no shell may appear in the attach argv');
  }
});

// ---------------------------------------------------------------------------
// #624 — the attach client. Every non-ASCII glyph rendered as an underscore and
// truecolor was quantized to 256 colours, because the attach invocation carried
// neither a UTF-8 signal nor a colour capability. Both are argv/env facts, so they
// are asserted here rather than behaviourally.
// ---------------------------------------------------------------------------

/** The attach PTY's spawn record. */
function attachPty(ptys) {
  assert.strictEqual(ptys.length, 1, 'expected exactly one attach PTY');
  return ptys[0];
}

test('#624: the attach client declares UTF-8 and truecolor', () => {
  const { eng, ptys, bin } = makeEngine({ version: '3.5a' });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  const p = attachPty(ptys);
  assert.strictEqual(p.file, bin);
  // Both are TOP-LEVEL tmux flags — `attach-session` accepts neither — so they must
  // precede the subcommand or tmux exits with a usage error and the tab is dead. Since
  // #625 `-S <socket>` leads them, for the same reason and with the same consequence.
  assert.deepStrictEqual(afterSocket(p.argv),
    ['-u', '-T', 'RGB,256', 'attach-session', '-t', 'ds-abc12345']);
});

test('#624: -T is gated on tmux 3.2, -u is not', () => {
  // -T did not exist before 3.2. An unknown flag makes tmux exit immediately, which
  // would kill the attach PTY — a broken session rather than a degraded one. -u has
  // been there since 1.x, so it is unconditional and no locale can defeat it.
  const { eng, ptys } = makeEngine({ version: '3.0a' });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  assert.deepStrictEqual(afterSocket(attachPty(ptys).argv), ['-u', 'attach-session', '-t', 'ds-abc12345']);
});

test('#624: the attach client gets a UTF-8 locale the daemon does not have', () => {
  const { eng, ptys } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  const { env } = attachPty(ptys).opts;
  assert.match(env.LC_CTYPE, /utf-?8/i);
  assert.strictEqual(env.COLORTERM, 'truecolor');
});

test('#624: a daemon that already has a UTF-8 locale keeps it', () => {
  const { eng, ptys } = makeEngine({ env: { LANG: 'en_GB.UTF-8' } });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  const { env } = attachPty(ptys).opts;
  assert.strictEqual(env.LANG, 'en_GB.UTF-8');
  assert.strictEqual(env.LC_CTYPE, undefined, 'a configured locale must not be overridden');
});

test('#624: passing our own env means WE strip what node-pty used to', () => {
  // node-pty's _sanitizeEnv runs only when opt.env IS process.env by identity. The
  // moment we hand it an object the duty is ours — and TMUX reaching a `tmux
  // attach-session` makes it refuse outright ("sessions should be nested with
  // care"), which is every tab dead for anyone who started the daemon from inside
  // a tmux pane.
  const dirty = { TMUX: '/tmp/tmux-501/default,1234,0', TMUX_PANE: '%3', STY: '1.pts-0', WINDOW: '2',
    WINDOWID: '7', TERMCAP: 'xx', COLUMNS: '80', LINES: '24' };
  const { eng, ptys } = makeEngine({ env: dirty });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  const { env } = attachPty(ptys).opts;
  for (const key of Object.keys(dirty)) {
    assert.strictEqual(env[key], undefined, `${key} must be stripped from the attach env`);
  }
});

test('#624: the attach env does not leak back into the daemon env', () => {
  const { eng, ptys, daemonEnv } = makeEngine({ env: { TMUX: '/tmp/x,1,0' } });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  attachPty(ptys).opts.env.CLOBBER = 'yes';
  assert.strictEqual(daemonEnv.TMUX, '/tmp/x,1,0', 'the daemon env must be copied, not mutated');
  assert.strictEqual(daemonEnv.CLOBBER, undefined);
});

test('#624: reattach after a restart gets the same treatment', () => {
  // The path every surviving session takes at startup. It renders immediately —
  // unlike the pane env, which only applies at new-session.
  const { eng, ptys } = makeEngine();
  eng.reattach('abc12345', 100, 30);
  const p = attachPty(ptys);
  assert.ok(p.argv.includes('-u'));
  assert.match(p.opts.env.LC_CTYPE, /utf-?8/i);
  assert.strictEqual(p.opts.cols, 100);
  assert.strictEqual(p.opts.rows, 30);
});

test('#624: the pane gets the locale too, so the agent picks its Unicode glyph set', () => {
  const { eng, calls } = makeEngine({ version: '3.5a' });
  const inner = "claude '--foo'";
  eng.spawn('abc12345', '/bin/zsh', ['-l', '-c', inner], '/repo',
    { env: { DEEPSTEVE_SESSION_ID: 'abc12345' } });
  const pairs = envPairs(newSessionArgv(calls));
  assert.match(pairs.LC_CTYPE, /utf-?8/i);
  assert.strictEqual(pairs.COLORTERM, 'truecolor');
});

test('#624: the pane env survives the "same as the daemon, skip it" diff', () => {
  // spawn() drops any caller value equal to the daemon's, because the pane inherits
  // it anyway. That is false for these two: a pane inherits the tmux SERVER's
  // environment, and the server belongs to whoever started it — which, even now that
  // #625 gives us our own socket, is the FIRST daemon to have started it and not
  // necessarily this one.
  const { eng, calls } = makeEngine({ version: '3.5a', env: { LC_CTYPE: 'en_US.UTF-8', COLORTERM: 'truecolor' } });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo',
    { env: { LC_CTYPE: 'en_US.UTF-8', COLORTERM: 'truecolor' }, shellCommand: null });
  const pairs = envPairs(newSessionArgv(calls));
  assert.strictEqual(pairs.LC_CTYPE, 'en_US.UTF-8', 'must be stated explicitly, not assumed inherited');
  assert.strictEqual(pairs.COLORTERM, 'truecolor');
});

test('#624: a caller-supplied locale beats the engine default', () => {
  // childBaseEnv already layers terminalEnv in, so in production the value normally
  // arrives this way; the engine default is the backstop for any other caller.
  const { eng, calls } = makeEngine({ version: '3.5a' });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo',
    { env: { LC_CTYPE: 'ja_JP.UTF-8' }, shellCommand: null });
  assert.strictEqual(envPairs(newSessionArgv(calls)).LC_CTYPE, 'ja_JP.UTF-8');
});

test('#624: a stripEnv key is never resurrected by the terminal-env pass', () => {
  // #517: daemon-internal vars are blanked so a leaked PORT can't make an agent kill
  // the daemon. The terminal-env pass runs after that and must not undo it.
  const { eng, calls } = makeEngine({ version: '3.5a', env: { PORT: '3000' } });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { stripEnv: ['PORT'], shellCommand: null });
  assert.strictEqual(envPairs(newSessionArgv(calls)).PORT, '');
});

// ---------------------------------------------------------------------------
// #625 — the socket. Every invocation must carry it, and the engine must never
// reach for a verb whose blast radius is the whole server.
// ---------------------------------------------------------------------------

test('EVERY invocation carries the socket, including the attach PTY (#625)', () => {
  // The attach PTY is a SECOND invocation point that does not go through _exec, so it
  // is the one a socket change is most likely to miss — and missing it would put the
  // daemon's own attach on tmux's shared per-UID socket while its commands went
  // elsewhere: the session would appear to vanish, which reads as a durability bug
  // rather than as a socket bug.
  const { eng, calls, ptys } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });
  eng.write('abc12345', '\x1b[13;2u');   // the send-keys path
  eng.kill('abc12345', 'SIGTERM');       // display-message, then kill-session
  eng.listSessions();
  eng.canReattach('abc12345');

  const probes = calls.filter((c) => c.argv[0] === '-V');
  assert.strictEqual(probes.length, 1, 'the version probe needs no socket and must not get one');

  for (const c of calls.filter((c) => c.argv[0] !== '-V')) {
    assert.deepStrictEqual(c.argv.slice(0, 2), ['-S', SOCKET],
      `tmux ${c.argv.join(' ')} is missing the socket flag`);
  }
  assert.ok(calls.length > 5, 'expected several commands — otherwise this asserts nothing');
  for (const p of ptys) {
    assert.deepStrictEqual(p.argv.slice(0, 2), ['-S', SOCKET],
      `the attach PTY is missing the socket flag: ${p.argv.join(' ')}`);
  }
  assert.ok(ptys.length >= 1, 'expected an attach PTY');
});

test('the engine never issues a whole-server verb (#625)', () => {
  // Nothing here emits kill-server today; pinning it makes the incident structurally
  // impossible from the daemon's side too, not only from the tests'.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'engines', 'tmux.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // tmux-guard-allow: asserting the ABSENCE of the verb requires writing it
  assert.doesNotMatch(code, /kill-server/,
    'engines/tmux.js must only ever destroy one named session at a time');
});

// ---------------------------------------------------------------------------
// #650: the session options that make the wheel scroll the terminal.
//
// With `mouse off` tmux never turns mouse reporting on for its client, so xterm.js saw
// no mouse protocol at all, fell into its "alternate buffer, no scrollback" branch, and
// translated every wheel notch into ESC[A / ESC[B — scrolling an agent tab walked its
// prompt history. These assertions are about WHERE the options are applied as much as
// what they are: the tmux server outlives the daemon, so a spawn-only call would never
// reach any session that already exists.
// ---------------------------------------------------------------------------

/** Every `set-option` argv issued, socket prefix stripped. */
function setOptions(calls) {
  return calls.filter((c) => c.argv.includes('set-option')).map((c) => afterSocket(c.argv));
}

test('#650: spawn() sets status, mouse and clipboard on the session it creates', () => {
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });

  assert.deepStrictEqual(setOptions(calls), [
    ['set-option', '-t', 'ds-abc12345', 'status', 'off'],
    ['set-option', '-t', 'ds-abc12345', 'mouse', 'on'],
    ['set-option', '-s', 'set-clipboard', 'on'],
  ]);
});

test('#650: a bare reattach() sets them too — the upgrade path for existing sessions', () => {
  // THE assertion of this section. A session created by a pre-#650 daemon is still
  // running after the upgrade, inside a tmux server that outlived the restart, and
  // spawn() will never run for it again. If the options moved back into spawn(), every
  // session anyone already had would keep scrolling its history forever.
  const { eng, calls } = makeEngine();
  assert.strictEqual(eng.reattach('abc12345', 100, 30), true);

  assert.deepStrictEqual(setOptions(calls), [
    ['set-option', '-t', 'ds-abc12345', 'status', 'off'],
    ['set-option', '-t', 'ds-abc12345', 'mouse', 'on'],
    ['set-option', '-s', 'set-clipboard', 'on'],
  ]);
});

test('#650: mouse is session-scoped and clipboard is server-scoped, never the reverse', () => {
  // `-t` is the narrowest scope `mouse` has. `set-clipboard` has NO session scope — `-s`
  // is its only one — which is safe only because #625 made this socket ours alone. A
  // `-g` on either would widen the blast radius past what that guarantee covers.
  const { eng, calls } = makeEngine();
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });

  for (const argv of setOptions(calls)) {
    assert.ok(!argv.includes('-g'), `set-option must never be global: ${argv.join(' ')}`);
  }
  const mouse = setOptions(calls).find((a) => a.includes('mouse'));
  assert.deepStrictEqual(mouse.slice(1, 3), ['-t', 'ds-abc12345']);
  const clip = setOptions(calls).find((a) => a.includes('set-clipboard'));
  assert.deepStrictEqual(clip.slice(1, 2), ['-s']);
});

test('#650: tmux < 2.1 has no `mouse` option, and loses only that', () => {
  // 2.1 collapsed mode-mouse and friends into one flag. An older tmux answers "unknown
  // option", which the try/catch swallows — so this gate buys clarity, not safety, and
  // the other two options must still land.
  const { eng, calls } = makeEngine({ version: '2.0' });
  eng.spawn('abc12345', '/bin/zsh', ['-l'], '/repo', { shellCommand: null });

  assert.deepStrictEqual(setOptions(calls), [
    ['set-option', '-t', 'ds-abc12345', 'status', 'off'],
    ['set-option', '-s', 'set-clipboard', 'on'],
  ]);
});

test('#650: a socket-less engine (userTmux) reconfigures nothing', () => {
  // `socket: null` is the deliberate "tmux's own per-UID socket" engine (#625), used by
  // server.js's tmux-attach path against sessions deepsteve did not create. set-clipboard
  // is a SERVER option, so one call there would change every tmux session on the box.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxargs-'));
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const calls = [];
  const exec = (file, argv) => {
    calls.push({ file, argv });
    return argv[0] === '-V' ? 'tmux 3.5a' : '';
  };
  const spawnPty = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 1 });
  const eng = new TmuxEngine({ binary: bin, socket: null, env: { PATH: dir }, exec, spawnPty });
  assert.strictEqual(eng.socket, null, 'otherwise this test asserts nothing');

  eng.reattach('abc12345', 100, 30);
  assert.deepStrictEqual(calls.filter((c) => c.argv.includes('set-option')), []);
});
