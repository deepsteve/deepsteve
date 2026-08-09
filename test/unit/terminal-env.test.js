// terminal-env.js — the locale/colour vars a service-managed daemon doesn't have (#624).
//
// Pure and injectable, so both platforms are asserted from one runner. That matters:
// the bug only exists in a LOCALE-FREE environment, and a test that reads the
// runner's own env passes against it. Every case here builds its env explicitly.
const { test } = require('node:test');
const assert = require('node:assert');

const { terminalEnv, hasUtf8Locale, TERMINAL_ENV_KEYS, LOCALE_VARS } = require('../../terminal-env');

// The daemon's real environment under launchd — 12 vars, no locale, no COLORTERM.
// Trimmed to what matters; the point is what is absent.
const DAEMON_ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/x', SHELL: '/bin/zsh', TMPDIR: '/tmp/' };

test('the fixture really is locale-free — otherwise every assertion below is vacuous', () => {
  for (const name of LOCALE_VARS) {
    assert.strictEqual(DAEMON_ENV[name], undefined, `${name} must be absent from the daemon fixture`);
  }
  assert.strictEqual(DAEMON_ENV.COLORTERM, undefined);
});

test('a locale-free daemon gets a UTF-8 LC_CTYPE and truecolor', () => {
  assert.deepStrictEqual(terminalEnv({ platform: 'darwin', env: DAEMON_ENV }),
    { LC_CTYPE: 'UTF-8', COLORTERM: 'truecolor' });
});

test('the locale value is platform-specific', () => {
  // macOS: BSD libc's bare codeset locale, valid on every version.
  assert.strictEqual(terminalEnv({ platform: 'darwin', env: DAEMON_ENV }).LC_CTYPE, 'UTF-8');
  // Linux: C.UTF-8, which glibc/musl actually have. NOT en_US.UTF-8 — that is
  // frequently not generated on minimal images (our own test/Dockerfile* included),
  // and naming an ungenerated locale makes setlocale() fail and tools warn.
  assert.strictEqual(terminalEnv({ platform: 'linux', env: DAEMON_ENV }).LC_CTYPE, 'C.UTF-8');
  assert.strictEqual(terminalEnv({ platform: 'freebsd', env: DAEMON_ENV }).LC_CTYPE, 'C.UTF-8');
});

test('a user who already has a UTF-8 locale is never overridden', () => {
  for (const name of LOCALE_VARS) {
    for (const val of ['en_US.UTF-8', 'en_gb.utf-8', 'C.UTF8', 'ja_JP.utf8']) {
      const env = { ...DAEMON_ENV, [name]: val };
      const out = terminalEnv({ platform: 'darwin', env });
      assert.strictEqual(out.LC_CTYPE, undefined, `${name}=${val} should have satisfied the check`);
    }
  }
});

test('a non-UTF-8 locale is filled in, not respected', () => {
  // The failure this fixes: tmux replaces every non-ASCII glyph with underscores
  // unless the locale says UTF-8, so `LANG=C` is exactly as broken as no LANG.
  for (const name of LOCALE_VARS) {
    const out = terminalEnv({ platform: 'darwin', env: { ...DAEMON_ENV, [name]: 'C' } });
    assert.strictEqual(out.LC_CTYPE, 'UTF-8', `${name}=C should not have counted as UTF-8`);
  }
});

test('an empty value counts as unset, and the next variable decides', () => {
  // Real shells export LC_ALL='' all the time; tmux skips it and moves on.
  assert.strictEqual(hasUtf8Locale({ LC_ALL: '', LANG: 'en_US.UTF-8' }), true);
  assert.strictEqual(hasUtf8Locale({ LC_ALL: '', LC_CTYPE: '', LANG: '' }), false);
});

test('only the FIRST variable that is set decides — LC_ALL=C wins over LANG=…UTF-8', () => {
  // libc precedence, and tmux's own check. Getting this backwards would leave the
  // most common "my terminal is mojibake" configuration broken.
  assert.strictEqual(hasUtf8Locale({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }), false);
  assert.strictEqual(hasUtf8Locale({ LC_CTYPE: 'C', LANG: 'en_US.UTF-8' }), false);
  assert.strictEqual(terminalEnv({ platform: 'darwin', env: { LC_ALL: 'C', LANG: 'en_US.UTF-8' } }).LC_CTYPE,
    'UTF-8');
});

test('COLORTERM is only filled in when unset', () => {
  const env = { ...DAEMON_ENV, COLORTERM: '24bit' };
  assert.strictEqual(terminalEnv({ platform: 'darwin', env }).COLORTERM, undefined);
  // An empty COLORTERM is a deliberate "no" from whoever exported it? No — an empty
  // string is how a var gets blanked, so treat it as unset and fill it.
  assert.strictEqual(terminalEnv({ platform: 'darwin', env: { ...DAEMON_ENV, COLORTERM: '' } }).COLORTERM,
    'truecolor');
});

test('a fully-configured environment yields nothing at all', () => {
  const env = { ...DAEMON_ENV, LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' };
  assert.deepStrictEqual(terminalEnv({ platform: 'darwin', env }), {});
});

test('the result is a fresh object and the input is never mutated', () => {
  const env = { ...DAEMON_ENV };
  const a = terminalEnv({ platform: 'darwin', env });
  const b = terminalEnv({ platform: 'darwin', env });
  assert.notStrictEqual(a, b);
  a.LC_CTYPE = 'clobbered';
  assert.strictEqual(terminalEnv({ platform: 'darwin', env }).LC_CTYPE, 'UTF-8');
  assert.deepStrictEqual(env, DAEMON_ENV, 'terminalEnv must not write into the env it is given');
});

test('TERMINAL_ENV_KEYS names exactly the keys terminalEnv can produce', () => {
  // engines/tmux.js forces these past its "same as the daemon, skip it" diff, using
  // the key list rather than the function. The two must not drift.
  const produced = Object.keys(terminalEnv({ platform: 'linux', env: DAEMON_ENV }));
  assert.deepStrictEqual([...TERMINAL_ENV_KEYS].sort(), produced.sort());
});
