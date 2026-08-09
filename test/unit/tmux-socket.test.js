// The socket-ownership contract (#625).
//
// deepsteve used to invoke tmux with no socket flag, inheriting tmux's default
// per-UID socket. That socket is per-UID and NOT per-HOME, so the HOME isolation every
// test daemon already did correctly bought nothing, and isolation instead rode on a
// convention — set TMUX_TMPDIR, and remember to mkdir it — whose failure mode was
// silent. It failed, and a test's `kill-server` destroyed every live agent on the
// machine three times in twenty minutes.
//
// The fix is that the socket is now *data on the engine* rather than ambient state,
// with a deliberate three-way so that "not specified" and "tmux's own default, on
// purpose" are different requests. This file pins that three-way, the one path that
// still reaches the shared socket, and the sun_path budget the move bought back.
//
// No real tmux and no node-pty: the engine takes an injected exec/spawnPty, so this
// runs on the bare CI unit job (ubuntu, --ignore-scripts, no tmux, no zsh).
//
// Run: node --test test/unit/tmux-socket.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TmuxEngine = require('../../engines/tmux');
const { tmuxSocketPath, stateDir } = require('../../paths');

// A fake tmux on disk so probeTmux() resolves; every command after is captured.
function makeEngine(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxsock-'));
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  const calls = [];
  const exec = (file, argv) => {
    calls.push({ file, argv });
    if (argv[0] === '-V') return 'tmux 3.5a';
    return '';
  };
  const ptys = [];
  const spawnPty = (file, argv) => {
    ptys.push({ file, argv });
    return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  };

  const eng = new TmuxEngine({ binary: bin, env: { PATH: dir }, exec, spawnPty, ...opts });
  return { eng, calls, ptys, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Commands only — the constructor's `-V` probe is not one. */
const commands = (calls) => calls.filter((c) => c.argv[0] !== '-V');

// --- paths.js -----------------------------------------------------------------

test('tmuxSocketPath lives in the state dir and follows DEEPSTEVE_HOME', () => {
  assert.strictEqual(tmuxSocketPath({ env: {}, homedir: '/home/x' }), '/home/x/.deepsteve/tmux.sock');
  assert.strictEqual(
    tmuxSocketPath({ env: { DEEPSTEVE_HOME: '/srv/ds' }, homedir: '/home/x' }),
    '/srv/ds/tmux.sock',
    'a second instance relocates its socket with the rest of its state — which is what ' +
    'makes HOME isolation *be* socket isolation');
  assert.strictEqual(path.dirname(tmuxSocketPath({ env: {}, homedir: '/home/x' })),
    stateDir({ env: {}, homedir: '/home/x' }));
});

test('the socket path is far inside the sun_path budget', () => {
  // The whole reason run-standalone.sh exports a short TMPDIR, and the reason a tmux
  // that is installed can still be completely unusable. ~104 bytes on macOS.
  const real = tmuxSocketPath();
  assert.ok(Buffer.byteLength(real) < 100,
    `${real} is ${Buffer.byteLength(real)} bytes — too close to the sun_path limit`);
  // The old path for comparison: $TMPDIR + tmux-<uid>/default. Not asserted (it depends
  // on the machine), but this is what the move bought: an exact, short, checkable path
  // instead of one tmux extended by a directory of its own.
});

// --- the three-way ------------------------------------------------------------

test('omitted socket means deepsteve\'s own', () => {
  const { eng, cleanup } = makeEngine();
  try {
    assert.strictEqual(eng.socket, tmuxSocketPath());
  } finally { cleanup(); }
});

test('socket: null means tmux\'s own default per-UID socket, and emits no -S at all', () => {
  // This is the ONLY way to reach the shared socket, and it exists for exactly two
  // features — the "Attach tmux session" menu and the tab it opens, both of which are
  // about sessions deepsteve did not create. Asserting the argv is byte-for-byte the
  // pre-#625 shape is what makes that call site a provable no-op.
  const { eng, calls, ptys, cleanup } = makeEngine({ socket: null });
  try {
    assert.strictEqual(eng.socket, null);
    // Byte-for-byte the pre-#625 attach argv (the #624 flags aside), which is what
    // makes server.js's tmux-attach call site a provable no-op.
    assert.deepStrictEqual(eng.attachSpawnArgs('work').argv,
      ['-u', '-T', 'RGB,256', 'attach-session', '-t', 'work']);
    eng.listAllSessions();
    eng.hasSession('work');
    for (const c of commands(calls)) {
      assert.ok(!c.argv.includes('-S'), `unexpected socket flag: ${c.argv.join(' ')}`);
    }
    assert.strictEqual(ptys.length, 0);
  } finally { cleanup(); }
});

test('an explicit socket string is used verbatim (the tmuxSocket setting)', () => {
  const { eng, calls, cleanup } = makeEngine({ socket: '/var/run/ds/t.sock' });
  try {
    assert.strictEqual(eng.socket, '/var/run/ds/t.sock');
    eng.listSessions();
    assert.deepStrictEqual(commands(calls)[0].argv.slice(0, 2), ['-S', '/var/run/ds/t.sock']);
  } finally { cleanup(); }
});

test('an empty socket string is treated as the default socket, not as `-S ""`', () => {
  // `tmuxSocket` defaults to '' in SETTINGS_SCHEMA and server.js resolves it before
  // construction, but the engine must not turn a stray '' into a relative socket path
  // in the daemon's cwd — which is a real file tmux would happily create.
  const { eng, cleanup } = makeEngine({ socket: '' });
  try {
    assert.strictEqual(eng.socket, null);
    assert.ok(!eng.attachSpawnArgs('x').argv.includes('-S'));
  } finally { cleanup(); }
});

// --- attachArgv is the shared derivation --------------------------------------

test('attachSpawnArgs is what the engine itself attaches with', () => {
  // server.js's tmux-attach tab spawns its own PTY and asks for this recipe rather
  // than rebuilding the argv (#624). If the engine stopped using it internally, those
  // two would drift and only one of them would carry the socket — which is how the
  // two attach paths diverged in the first place.
  const { eng, ptys, cleanup } = makeEngine({ socket: '/s/x.sock' });
  try {
    eng.spawn('abc12345', '/bin/sh', ['-l'], '/repo', { shellCommand: null });
    assert.deepStrictEqual(ptys[0].argv, eng.attachSpawnArgs('ds-abc12345').argv);
    assert.deepStrictEqual(ptys[0].argv.slice(0, 2), ['-S', '/s/x.sock']);
  } finally { cleanup(); }
});

// --- the version probe stays socketless ---------------------------------------

test('the version probe carries no socket (it does not touch one)', () => {
  const { calls, cleanup } = makeEngine({ socket: '/s/x.sock' });
  try {
    const probe = calls.find((c) => c.argv.includes('-V'));
    assert.ok(probe, 'the constructor must probe');
    assert.deepStrictEqual(probe.argv, ['-V']);
  } finally { cleanup(); }
});
