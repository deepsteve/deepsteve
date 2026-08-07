// Unit tests for tmux-path.js (#619): resolving the tmux binary without zsh.
//
// The engine used to find tmux with `zsh -l -c 'which tmux'`, which made it
// silently conditional on zsh — fine on macOS, fatal on a Linux box that has tmux
// and no zsh, where it surfaced as "tmux not available".
//
// This file requires tmux-path.js and NEVER engines/tmux.js: that pulls in node-pty,
// and the CI unit job installs deps with --ignore-scripts, so the native binding
// isn't built there. The same job is why these tests are the missing coverage the
// issue describes — it runs bare on ubuntu-latest with **no zsh**, so a fake tmux on
// disk makes it literally "tmux present, zsh absent".
//
// Run: node --test test/unit/tmux-path.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { probeTmux, resolveTmuxPath, isExecutableFile, FALLBACK_DIRS } = require('../../tmux-path.js');

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmux-path-'));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

/** An executable stand-in for tmux that prints `line` for any argv (e.g. `-V`). */
function fakeTmux(dir, line, { name = 'tmux', exitCode = 0 } = {}) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${line}"\nexit ${exitCode}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** Records every spawn so a test can prove what did (and didn't) get executed. */
function spyExec(stdout = 'tmux 3.4') {
  const calls = [];
  const exec = (file, args) => { calls.push({ file, args }); return stdout; };
  return { exec, calls };
}

// 1. The whole point of the issue: tmux on PATH, resolved and version-probed with no
//    shell anywhere in the chain. On the CI unit runner zsh genuinely isn't installed.
test('resolves tmux from PATH and reads its version (no shell involved)', () => {
  const dir = tmp();
  const bin = fakeTmux(dir, 'tmux 3.4');

  const r = probeTmux({ env: { PATH: dir }, extraDirs: [] });

  assert.strictEqual(r.path, bin);
  assert.strictEqual(r.version, '3.4');
  assert.strictEqual(r.error, null);
});

// 2. Proves the negative directly rather than relying on the host lacking zsh: the
//    only thing spawned is tmux itself, by absolute path.
test('never spawns a shell — the only exec is tmux by absolute path', () => {
  const dir = tmp();
  const bin = fakeTmux(dir, 'tmux 3.4');
  const { exec, calls } = spyExec();

  probeTmux({ env: { PATH: dir }, extraDirs: [], exec });

  assert.strictEqual(calls.length, 1, 'exactly one subprocess (was two login shells)');
  assert.strictEqual(calls[0].file, bin);
  assert.deepStrictEqual(calls[0].args, ['-V']);
  for (const c of calls) {
    assert.ok(!/(^|\/)(z|ba|k|)sh$/.test(c.file), `spawned a shell: ${c.file}`);
    assert.ok(!c.args.includes('-l'), 'passed a login-shell flag');
  }
});

// 3. The macOS LaunchAgent case. The plist PATH (release.sh) is
//    …:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin — no /opt/homebrew/bin — so PATH
//    alone finds nothing on Apple Silicon. This is what zsh -l was compensating for.
test('falls back to well-known prefixes when $PATH misses tmux (launchd case)', () => {
  const pathDir = tmp();     // stands in for the plist PATH: no tmux in it
  const brewDir = tmp();     // stands in for /opt/homebrew/bin
  const bin = fakeTmux(brewDir, 'tmux 3.5a');

  const r = probeTmux({ env: { PATH: pathDir }, extraDirs: [brewDir] });

  assert.strictEqual(r.path, bin);
  assert.strictEqual(r.version, '3.5', 'letter suffix is dropped');
});

// 4. Guards the fact point 3 depends on. If /opt/homebrew/bin ever leaves this list
//    while the plist PATH still omits it, every Apple Silicon install loses tmux.
test('FALLBACK_DIRS covers the prefixes the plist PATH omits', () => {
  assert.ok(FALLBACK_DIRS.includes('/opt/homebrew/bin'), 'Homebrew on Apple Silicon');
  assert.ok(FALLBACK_DIRS.includes('/usr/local/bin'), 'Homebrew on Intel');
  assert.ok(FALLBACK_DIRS.includes('/usr/bin'), 'apt/dnf');
});

// 5. $PATH wins over the fallbacks, so a user who puts tmux ahead of the system one
//    gets theirs — same as `which tmux` did.
test('$PATH takes precedence over the fallback dirs', () => {
  const pathDir = tmp();
  const brewDir = tmp();
  const preferred = fakeTmux(pathDir, 'tmux 3.4');
  fakeTmux(brewDir, 'tmux 2.8');

  assert.strictEqual(resolveTmuxPath({ env: { PATH: pathDir }, extraDirs: [brewDir] }), preferred);
});

// 6. The tmuxBinary setting: the escape hatch for a tmux only a login shell's PATH
//    used to reveal (nix, asdf, custom --prefix).
test('tmuxBinary override: an explicit path wins over PATH and the fallbacks', () => {
  const pathDir = tmp();
  const oddDir = tmp();
  fakeTmux(pathDir, 'tmux 3.4');
  const chosen = fakeTmux(oddDir, 'tmux 3.6');

  const r = probeTmux({ env: { PATH: pathDir }, extraDirs: [], binary: chosen });

  assert.strictEqual(r.path, chosen);
  assert.strictEqual(r.version, '3.6');
});

test('tmuxBinary override: a bare alternate name is searched for by name', () => {
  const dir = tmp();
  fakeTmux(dir, 'tmux 3.4');
  const next = fakeTmux(dir, 'tmux next-3.6', { name: 'tmux-next' });

  const r = probeTmux({ env: { PATH: dir }, extraDirs: [], binary: 'tmux-next' });

  assert.strictEqual(r.path, next);
  assert.strictEqual(r.version, '3.6');
});

test('tmuxBinary override: a path that is not executable resolves to nothing', () => {
  const dir = tmp();
  fakeTmux(dir, 'tmux 3.4');  // a real tmux on PATH must NOT be silently substituted

  const r = probeTmux({ env: { PATH: dir }, extraDirs: [], binary: path.join(dir, 'nope') });

  assert.strictEqual(r.path, null);
  assert.strictEqual(r.version, null);
});

// 7. A directory named `tmux` (or a non-executable file) must not shadow a real one.
test('skips a directory or non-executable file named tmux', () => {
  const decoyDir = tmp();
  fs.mkdirSync(path.join(decoyDir, 'tmux'));            // a DIRECTORY named tmux
  const decoy2 = tmp();
  fs.writeFileSync(path.join(decoy2, 'tmux'), 'nope');  // present but mode 0644
  fs.chmodSync(path.join(decoy2, 'tmux'), 0o644);
  const realDir = tmp();
  const bin = fakeTmux(realDir, 'tmux 3.4');

  const env = { PATH: [decoyDir, decoy2, realDir].join(path.delimiter) };
  assert.strictEqual(resolveTmuxPath({ env, extraDirs: [] }), bin);
  assert.strictEqual(isExecutableFile(path.join(decoyDir, 'tmux')), false);
  assert.strictEqual(isExecutableFile(path.join(decoy2, 'tmux')), false);
});

// 8. Not found is a value, not a throw — and it reports where it looked, which is
//    what turns "tmux not available" into a diagnosable log line.
test('reports not-found with the dirs it searched', () => {
  const empty = tmp();

  const r = probeTmux({ env: { PATH: empty }, extraDirs: ['/nonexistent-prefix/bin'] });

  assert.strictEqual(r.path, null);
  assert.strictEqual(r.version, null);
  assert.deepStrictEqual(r.searched, [empty, '/nonexistent-prefix/bin']);
});

// 9. TmuxEngine probes from its constructor, which runs unconditionally at daemon
//    startup — a tmux that exists but won't run must not crash the daemon.
test('a tmux that fails -V is unavailable, not an exception', () => {
  const dir = tmp();
  fakeTmux(dir, 'boom', { exitCode: 1 });

  const r = probeTmux({ env: { PATH: dir }, extraDirs: [] });

  assert.strictEqual(r.path, null);
  assert.strictEqual(r.version, null);
  assert.ok(r.error, 'carries the failure for the log line');
});

test('an exec that throws is caught', () => {
  const dir = tmp();
  fakeTmux(dir, 'tmux 3.4');
  const exec = () => { throw new Error('ETIMEDOUT'); };

  const r = probeTmux({ env: { PATH: dir }, extraDirs: [], exec });

  assert.strictEqual(r.version, null);
  assert.match(r.error, /ETIMEDOUT/);
});

// 10. Version parsing feeds TmuxEngine._supportsEnvFlag (>= 3.2 → `-e KEY=VAL`), so
//     these strings decide how session env is passed. Behavior preserved from the
//     original `out.match(/(\d+\.\d+)/)`.
test('version parsing matches what _supportsEnvFlag expects', () => {
  const cases = [
    ['tmux 3.4', '3.4'],
    ['tmux 3.5a', '3.5'],
    ['tmux next-3.6', '3.6'],
    ['tmux 2.8', '2.8'],
    ['tmux openbsd-7.4', '7.4'],
    ['tmux master', 'tmux master'],   // unparseable → raw line, as before
  ];
  for (const [out, want] of cases) {
    const dir = tmp();
    const bin = fakeTmux(dir, out);
    const r = probeTmux({ env: { PATH: dir }, extraDirs: [] });
    assert.strictEqual(r.version, want, `${out} → ${want}`);
    assert.strictEqual(r.path, bin);
  }
});

test('empty -V output is unavailable, not version ""', () => {
  const dir = tmp();
  const { exec } = spyExec('   \n');
  fakeTmux(dir, 'tmux 3.4');

  const r = probeTmux({ env: { PATH: dir }, extraDirs: [], exec });

  assert.strictEqual(r.version, null, 'availability is version !== null — "" would read as available');
  assert.strictEqual(r.path, null);
});

// 11. A missing/empty PATH must not throw (a LaunchAgent env is minimal, and a
//     systemd unit could omit it entirely).
test('an absent PATH falls through to the fallback dirs', () => {
  const brewDir = tmp();
  const bin = fakeTmux(brewDir, 'tmux 3.4');

  assert.strictEqual(resolveTmuxPath({ env: {}, extraDirs: [brewDir] }), bin);
  assert.strictEqual(resolveTmuxPath({ env: { PATH: '' }, extraDirs: [brewDir] }), bin);
});

test('duplicate dirs across PATH and the fallbacks are searched once', () => {
  const dir = tmp();
  fakeTmux(dir, 'tmux 3.4');

  const r = probeTmux({ env: { PATH: [dir, dir].join(path.delimiter) }, extraDirs: [dir] });

  assert.deepStrictEqual(r.searched, [dir]);
});
