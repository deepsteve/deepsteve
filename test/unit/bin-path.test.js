// bin-path.js — resolving executables and the login shell without a login shell
// (#619 generalized by #621).
//
// Everything here is driven by injected env / userInfo / extraDirs against fake
// executables in a mkdtemp, so it runs identically on the bare ubuntu CI runner (no
// zsh, no node-pty binding) and on a Mac. That is the point: the bug class is
// "works on the maintainer's Mac", and only the ubuntu job would catch it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveBinary, runBinary, resolveLoginShell, resolveUrlOpener,
  isExecutableFile, candidateDirs, FALLBACK_DIRS,
} = require('../../bin-path');

function scratchDir(prefix = 'ds-binpath-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** An executable stub named `name` inside `dir`. */
function fakeBin(dir, name, body = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

// --- resolveBinary --------------------------------------------------------

test('resolveBinary finds a binary on $PATH', () => {
  const dir = scratchDir();
  const bin = fakeBin(dir, 'widget');
  assert.strictEqual(resolveBinary('widget', { env: { PATH: dir }, extraDirs: [] }), bin);
});

test('resolveBinary falls back to the extra dirs when $PATH misses it', () => {
  // This is the whole reason FALLBACK_DIRS exists: the LaunchAgent plist PATH has no
  // /opt/homebrew/bin, so a Homebrew binary is invisible to a plain $PATH scan.
  const dir = scratchDir();
  const bin = fakeBin(dir, 'widget');
  assert.strictEqual(resolveBinary('widget', { env: { PATH: '/nonexistent' }, extraDirs: [dir] }), bin);
});

test('$PATH wins over the fallback dirs', () => {
  const first = scratchDir();
  const second = scratchDir();
  const wanted = fakeBin(first, 'widget');
  fakeBin(second, 'widget');
  assert.strictEqual(resolveBinary('widget', { env: { PATH: first }, extraDirs: [second] }), wanted);
});

test('resolveBinary returns null when nothing matches', () => {
  assert.strictEqual(resolveBinary('definitely-not-a-real-binary-621', { env: { PATH: '' }, extraDirs: [] }), null);
});

test('a name containing a separator is used verbatim, never searched', () => {
  // A user who names a path means THAT one — silently falling back to some other
  // binary of the same name would be worse than failing.
  const dir = scratchDir();
  const bin = fakeBin(dir, 'widget');
  const decoy = scratchDir();
  fakeBin(decoy, 'widget');
  assert.strictEqual(resolveBinary(bin, { env: { PATH: decoy }, extraDirs: [] }), bin);
  assert.strictEqual(resolveBinary(path.join(dir, 'absent'), { env: { PATH: decoy }, extraDirs: [] }), null);
});

test('a directory named like the binary does not match', () => {
  const dir = scratchDir();
  fs.mkdirSync(path.join(dir, 'widget'));
  assert.strictEqual(resolveBinary('widget', { env: { PATH: dir }, extraDirs: [] }), null);
});

test('a non-executable file does not match', () => {
  const dir = scratchDir();
  fs.writeFileSync(path.join(dir, 'widget'), 'not executable');
  fs.chmodSync(path.join(dir, 'widget'), 0o644);
  assert.strictEqual(resolveBinary('widget', { env: { PATH: dir }, extraDirs: [] }), null);
});

test('an empty or missing name resolves to null rather than a directory', () => {
  const dir = scratchDir();
  for (const name of ['', null, undefined]) {
    assert.strictEqual(resolveBinary(name, { env: { PATH: dir }, extraDirs: [] }), null);
  }
});

test('a missing or empty $PATH is survivable', () => {
  const dir = scratchDir();
  const bin = fakeBin(dir, 'widget');
  assert.strictEqual(resolveBinary('widget', { env: {}, extraDirs: [dir] }), bin);
  assert.strictEqual(resolveBinary('widget', { env: { PATH: '' }, extraDirs: [dir] }), bin);
});

test('candidateDirs de-duplicates and expands tildes', () => {
  const dirs = candidateDirs({ PATH: `/a${path.delimiter}/b${path.delimiter}/a` }, ['~/x', '/b']);
  assert.deepStrictEqual(dirs, ['/a', '/b', path.join(os.homedir(), 'x')]);
});

test('isExecutableFile is exported and agrees with resolveBinary', () => {
  const dir = scratchDir();
  const bin = fakeBin(dir, 'widget');
  assert.strictEqual(isExecutableFile(bin), true);
  assert.strictEqual(isExecutableFile(path.join(dir, 'nope')), false);
});

test('FALLBACK_DIRS still lists /opt/homebrew/bin, which the plist PATH omits', () => {
  // Load-bearing, not cosmetic: dropping it re-breaks Homebrew tmux/gh under launchd,
  // which is exactly the #619 failure this module exists to prevent.
  assert.ok(FALLBACK_DIRS.includes('/opt/homebrew/bin'));
  assert.ok(FALLBACK_DIRS.includes('/usr/bin'), 'the systemd unit PATH relies on /usr/bin');
});

// --- runBinary ------------------------------------------------------------

test('runBinary execs the resolved absolute path with argv, never a shell', () => {
  const dir = scratchDir();
  const bin = fakeBin(dir, 'widget');
  const seen = [];
  runBinary('widget', ['--flag', 'a b'], {
    env: { PATH: dir }, extraDirs: [],
    exec: (file, argv, opts) => { seen.push({ file, argv, opts }); return 'out'; },
  });
  assert.strictEqual(seen[0].file, bin, 'must exec the binary itself');
  assert.deepStrictEqual(seen[0].argv, ['--flag', 'a b'], 'argv passes through unquoted');
});

test('runBinary throws ENOENT naming where it looked', () => {
  // A bare ENOENT from deep inside a callback is undiagnosable; the searched dirs
  // are the difference between "gh is missing" and "gh is somewhere I do not scan".
  let err;
  try {
    runBinary('absent-621', [], { env: { PATH: '/nowhere' }, extraDirs: ['/also-nowhere'] });
  } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.strictEqual(err.code, 'ENOENT');
  assert.match(err.message, /absent-621 not found/);
  assert.match(err.message, /\/nowhere/);
  assert.match(err.message, /\/also-nowhere/);
});

test('runBinary does not leak its own options into the exec opts', () => {
  const dir = scratchDir();
  fakeBin(dir, 'widget');
  let opts;
  runBinary('widget', [], {
    env: { PATH: dir }, extraDirs: [], cwd: '/tmp', timeout: 1234,
    exec: (_f, _a, o) => { opts = o; return ''; },
  });
  assert.strictEqual(opts.cwd, '/tmp');
  assert.strictEqual(opts.timeout, 1234);
  assert.ok(!('extraDirs' in opts), 'extraDirs is ours, not execFileSync\'s');
  assert.ok(!('exec' in opts), 'exec is ours, not execFileSync\'s');
});

// --- resolveLoginShell ----------------------------------------------------

test('macOS is a provable no-op: $SHELL=/bin/zsh resolves to /bin/zsh -l', () => {
  // THE load-bearing case for #621. A real LaunchAgent daemon's environment carries
  // SHELL=/bin/zsh (verified with `ps eww` on a live install), so the session spawn
  // goes from spawn('zsh', ['-l','-c',…]) to spawn('/bin/zsh', ['-l','-c',…]) — the
  // only delta being an absolute path, which is strictly better under launchd's PATH.
  // PATH is deliberately empty to prove the separator branch, not a search, found it.
  const got = resolveLoginShell({ env: { SHELL: '/bin/zsh', PATH: '' }, userInfo: () => ({ shell: '/bin/zsh' }) });
  assert.deepStrictEqual(got, { path: '/bin/zsh', loginFlag: '-l' });
});

test('falls back to the passwd entry when $SHELL is unset', () => {
  const dir = scratchDir();
  const bash = fakeBin(dir, 'bash');
  const got = resolveLoginShell({ env: { PATH: dir }, userInfo: () => ({ shell: bash }), extraDirs: [] });
  assert.deepStrictEqual(got, { path: bash, loginFlag: '-l' });
});

test('a throwing userInfo() is survivable (docker run --user with no passwd entry)', () => {
  // uv_os_get_passwd throws ENOENT for a UID with no passwd row. If that propagated,
  // every session spawn would fail in a container that runs as a numeric user.
  const dir = scratchDir();
  const zsh = fakeBin(dir, 'zsh');
  const got = resolveLoginShell({
    env: { PATH: dir },
    userInfo: () => { throw new Error('ENOENT: no passwd entry'); },
    extraDirs: [],
  });
  assert.strictEqual(got.path, zsh);
});

test('a $SHELL that does not exist is skipped', () => {
  const dir = scratchDir();
  const bash = fakeBin(dir, 'bash');
  const got = resolveLoginShell({
    env: { SHELL: '/nonexistent/zsh', PATH: dir },
    userInfo: () => ({ shell: bash }), extraDirs: [],
  });
  assert.strictEqual(got.path, bash);
});

test('nologin is never honored', () => {
  // Honoring it would make every tab exit instantly with no output — the least
  // diagnosable failure mode available.
  const dir = scratchDir();
  const nologin = fakeBin(dir, 'nologin');
  const zsh = fakeBin(dir, 'zsh');
  const got = resolveLoginShell({
    env: { SHELL: nologin, PATH: dir }, userInfo: () => ({ shell: nologin }), extraDirs: [],
  });
  assert.strictEqual(got.path, zsh, 'must skip nologin and keep looking');
});

test('fish is rejected — it cannot parse the POSIX quoting we emit', () => {
  // spawnSession builds `-c "<bin> '<arg>' …"` with '\'' escaping. fish would
  // silently mangle every agent's argv, which is worse than not using it at all.
  // A Mac user with a fish $SHELL therefore lands on zsh: exactly today's behavior.
  const dir = scratchDir();
  const fish = fakeBin(dir, 'fish');
  const zsh = fakeBin(dir, 'zsh');
  const got = resolveLoginShell({
    env: { SHELL: fish, PATH: dir }, userInfo: () => ({ shell: fish }), extraDirs: [],
  });
  assert.strictEqual(got.path, zsh);
});

test('bash is used when it is the real login shell (the Linux container case)', () => {
  const dir = scratchDir();
  const bash = fakeBin(dir, 'bash');
  const got = resolveLoginShell({
    env: { SHELL: bash, PATH: dir }, userInfo: () => ({ shell: bash }), extraDirs: [],
  });
  assert.deepStrictEqual(got, { path: bash, loginFlag: '-l' });
});

test('sh is the floor and gets NO -l', () => {
  // Not every POSIX sh accepts -l, and a failed `sh -l -c` kills the session outright
  // rather than degrading it.
  const dir = scratchDir();
  const sh = fakeBin(dir, 'sh');
  const got = resolveLoginShell({
    env: { SHELL: sh, PATH: dir }, userInfo: () => ({ shell: sh }), extraDirs: [],
  });
  assert.deepStrictEqual(got, { path: sh, loginFlag: null });
});

test('never returns null, even with nothing available at all', () => {
  const got = resolveLoginShell({
    env: { PATH: '' }, userInfo: () => { throw new Error('nope'); }, extraDirs: [],
  });
  assert.strictEqual(got.path, '/bin/sh');
  assert.strictEqual(got.loginFlag, null);
});

test('hostile inputs never throw and always yield a usable shell', () => {
  const hostile = [
    { env: {}, userInfo: () => ({}) },
    { env: { SHELL: '' }, userInfo: () => ({ shell: '' }) },
    { env: { SHELL: '/' }, userInfo: () => ({ shell: null }) },
    { env: { SHELL: 'zsh' }, userInfo: () => ({ shell: undefined }) },
  ];
  for (const h of hostile) {
    const got = resolveLoginShell(h);
    assert.ok(got && typeof got.path === 'string' && got.path, `no shell for ${JSON.stringify(h.env)}`);
    assert.ok(got.loginFlag === '-l' || got.loginFlag === null);
  }
});

// --- resolveUrlOpener -----------------------------------------------------

test('resolveUrlOpener picks open on darwin and xdg-open elsewhere', () => {
  const dir = scratchDir();
  const open = fakeBin(dir, 'open');
  const xdg = fakeBin(dir, 'xdg-open');
  assert.strictEqual(resolveUrlOpener({ platform: 'darwin', env: { PATH: dir }, extraDirs: [] }), open);
  assert.strictEqual(resolveUrlOpener({ platform: 'linux', env: { PATH: dir }, extraDirs: [] }), xdg);
});

test('resolveUrlOpener returns null on a headless box instead of throwing', () => {
  // A server with no browser is a normal deployment, not an error — the caller logs
  // one line and carries on.
  assert.strictEqual(resolveUrlOpener({ platform: 'linux', env: { PATH: '/nowhere' }, extraDirs: [] }), null);
});

test('resolveUrlOpener scans $PATH first, so the standalone suites\' open stub still wins', () => {
  // test/integration-standalone/new-window.test.js writes $HOME/bin/open and asserts
  // it stays unused. That only keeps working because $PATH is searched before
  // FALLBACK_DIRS (where the real /usr/bin/open lives).
  const stubDir = scratchDir();
  const stub = fakeBin(stubDir, 'open');
  const realish = scratchDir();
  fakeBin(realish, 'open');
  assert.strictEqual(resolveUrlOpener({ platform: 'darwin', env: { PATH: stubDir }, extraDirs: [realish] }), stub);
});

test('linux tries several openers in order', () => {
  const dir = scratchDir();
  const gio = fakeBin(dir, 'gio');
  assert.strictEqual(resolveUrlOpener({ platform: 'linux', env: { PATH: dir }, extraDirs: [] }), gio);
});

// --- no shell anywhere ----------------------------------------------------

test('bin-path.js never spawns a shell', () => {
  // The entire point of #619/#621. execFileSync with an absolute path takes no shell;
  // exec/execSync/spawn-with-shell would quietly reintroduce the zsh dependency.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'bin-path.js'), 'utf8');
  assert.ok(!/\bexecSync\b/.test(src), 'execSync runs its argument through /bin/sh');
  assert.ok(!/shell:\s*true/.test(src));
  assert.ok(!/\bzsh -l\b/.test(src) || /allowlist|POSIX_SHELLS/.test(src));
});
