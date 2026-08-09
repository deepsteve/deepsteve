// test/helpers/tmux-socket.js — the guard that keeps a test suite off the
// developer's real tmux server.
//
// This exists because the absence of it destroyed every live agent session on the
// developer's machine three times in one morning. The mechanism: tmux treats
// TMUX_TMPDIR as a hint and SILENTLY falls back to /tmp/tmux-<uid>/default when it
// cannot use the directory, so a suite whose `after()` runs `kill-server` reaps the
// real server instead of its own. The window was two lines wide — a tmpdir path
// assigned on one line and mkdir'd on a later one, with `after()` running even when
// something threw in between.
//
// EVERY TEST HERE EXERCISES THE FAILURE PATH, because that is the only path the bug
// lives on. A green run of the happy path proves nothing. And none of them need a
// real tmux: a fake binary records its argv, so the assertion "we always pass -S,
// pointing inside our own tmpRoot" is checked without any server existing at all.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIsolatedTmux, assertIsolated, runTmux, reapTmuxServer } =
  require('../../test/helpers/tmux-socket');

/** A tmux that records its argv instead of doing anything. */
function fakeTmux(dir) {
  const log = path.join(dir, 'argv.log');
  const bin = path.join(dir, 'faketmux');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxiso-'));
  process.on('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
  return d;
}

test('createIsolatedTmux names and creates the socket dir in ONE call', () => {
  // The bug was a window between naming and creating. There is no longer an API
  // shape that can open one.
  const root = tmp();
  const iso = createIsolatedTmux(root);
  assert.ok(iso.socket.startsWith(root + path.sep), 'socket must live under tmpRoot');
  assert.ok(fs.existsSync(path.dirname(iso.socket)), 'the dir must already exist on return');
  // tmux refuses a group/world-accessible socket dir — and refusing means falling
  // back to the real one, so the mode is part of the isolation, not hygiene.
  assert.strictEqual(fs.statSync(path.dirname(iso.socket)).mode & 0o077, 0);
  // Must agree with what tmux itself derives from TMUX_TMPDIR, or the suite and its
  // daemon would be looking at two different servers.
  assert.strictEqual(iso.socket, path.join(iso.tmuxTmp, `tmux-${process.getuid()}`, 'default'));
});

test('every invocation carries -S, so the environment is not load-bearing', () => {
  // This is the actual fix. `-S` has no fallback path: tmux uses that socket or
  // fails. With it, no amount of TMUX_TMPDIR breakage can redirect us.
  const root = tmp();
  const iso = createIsolatedTmux(root);
  const t = fakeTmux(root);
  runTmux(t.bin, iso, ['list-sessions', '-F', '#{session_name}']);
  const [call] = t.calls();
  assert.ok(call.startsWith(`-S ${iso.socket} `), `expected -S first, got: ${call}`);
  assert.ok(call.includes('list-sessions'));
});

test('REGRESSION: a missing socket dir refuses to run instead of falling back', () => {
  // THE BUG, exactly: path assigned, directory absent. tmux would silently use
  // /tmp/tmux-<uid>/default here. The old guard passed because it only checked that
  // the string sat under tmpRoot.
  const root = tmp();
  const iso = createIsolatedTmux(root);
  fs.rmSync(path.dirname(iso.socket), { recursive: true, force: true });
  const t = fakeTmux(root);
  assert.throws(() => runTmux(t.bin, iso, ['kill-server']), /does not exist/);
  assert.deepStrictEqual(t.calls(), [], 'nothing may be executed');
});

test('REGRESSION: before() dying after naming but before creating cannot reap anything', () => {
  // The precise incident: before() sets the path, throws, after() still runs. Model
  // it as the handle existing with no directory behind it.
  const root = tmp();
  const iso = { tmpRoot: root, tmuxTmp: path.join(root, 'tmux-tmp'),
    socket: path.join(root, 'tmux-tmp', `tmux-${process.getuid()}`, 'default') };
  const t = fakeTmux(root);
  assert.strictEqual(reapTmuxServer(t.bin, iso), false, 'must not claim it killed anything');
  assert.deepStrictEqual(t.calls(), [], 'kill-server must never have been executed');
});

test('REGRESSION: a suite that skipped (no handle at all) cannot reap anything', () => {
  // after() used to run unguarded on a skipped suite, where every variable is
  // undefined — and Node DROPS an undefined env value rather than passing it, so
  // TMUX_TMPDIR vanished entirely and tmux used the real socket.
  const root = tmp();
  const t = fakeTmux(root);
  for (const handle of [undefined, null, {}, { socket: undefined, tmpRoot: undefined }]) {
    assert.strictEqual(reapTmuxServer(t.bin, handle), false);
  }
  assert.throws(() => assertIsolated(undefined), /without an isolation handle/);
  assert.deepStrictEqual(t.calls(), [], 'nothing may be executed');
});

test('REGRESSION: a socket outside tmpRoot is refused even if it exists', () => {
  // Belt to the -S braces: if a handle is ever built by hand, it still cannot name
  // somebody else's socket.
  const root = tmp();
  const other = tmp();
  const sock = path.join(other, 'default');
  fs.writeFileSync(sock, '');
  const t = fakeTmux(root);
  assert.throws(() => runTmux(t.bin, { tmpRoot: root, socket: sock }, ['kill-server']), /outside/);
  assert.strictEqual(reapTmuxServer(t.bin, { tmpRoot: root, socket: sock }), false);
  assert.deepStrictEqual(t.calls(), [], 'nothing may be executed');
});

test('no socket file means no server of ours — reap does nothing, quietly', () => {
  const root = tmp();
  const iso = createIsolatedTmux(root); // dir exists, socket does not
  const t = fakeTmux(root);
  assert.strictEqual(reapTmuxServer(t.bin, iso), false);
  assert.deepStrictEqual(t.calls(), [], 'kill-server must not run without a socket to kill');
});

test('with a real socket present, reap targets OUR path and reports it killed', () => {
  const root = tmp();
  const iso = createIsolatedTmux(root);
  fs.writeFileSync(iso.socket, ''); // stand in for a live server's socket
  const t = fakeTmux(root);
  assert.strictEqual(reapTmuxServer(t.bin, iso), true);
  const [call] = t.calls();
  assert.strictEqual(call, `-S ${iso.socket} kill-server`);
  assert.ok(call.includes(root), 'the killed socket must be inside the suite tmpRoot');
});

test('reapTmuxServer never throws — a cleanup throw would mask the real failure', () => {
  assert.strictEqual(reapTmuxServer(null, null), false);
  assert.strictEqual(reapTmuxServer('/nonexistent/tmux', { tmpRoot: '/x', socket: '/x/y' }), false);
});
