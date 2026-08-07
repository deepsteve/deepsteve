// service.sh — the one interface over launchd and systemd (#621).
//
// Two halves:
//   1. Contract assertions on the FILE, because "this is a library, never an entry
//      point" is a security property (see the CLAUDE.md restart rule) and needs to be
//      mechanically true rather than merely intended.
//   2. Executable tests that actually source it under `sh` with recording
//      launchctl/systemctl stubs on PATH. Those are far stronger than grepping, and
//      they work in the bare ubuntu CI job — DEEPSTEVE_PLATFORM lets one runner
//      exercise BOTH arms, which is the whole reason that override exists.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO, 'service.sh');
const STATUS_SH = path.join(REPO, 'status.sh');

// These files explain in prose why they do NOT call launchctl directly, so a naive
// grep would trip on the explanation. Strip comments first (the compose-projects
// lesson: prose must neither satisfy nor trip an assertion).
function uncommented(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

const serviceSrc = fs.readFileSync(SERVICE_SH, 'utf8');
const serviceCode = uncommented(serviceSrc);

// --- 1. the library contract ---------------------------------------------

test('service.sh and status.sh exist — otherwise every assertion here is vacuous', () => {
  assert.ok(fs.existsSync(SERVICE_SH), 'service.sh missing');
  assert.ok(fs.existsSync(STATUS_SH), 'status.sh missing');
});

test('service.sh has NO exec bit — that is what makes `./service.sh restart` impossible', () => {
  // Load-bearing, not stylistic. CLAUDE.md's guarantee is that a restart can never
  // happen unilaterally because the only trigger is ./restart.sh, which stays behind
  // Claude Code's permission prompt. An executable service.sh with a dispatcher would
  // be a second, unguarded path to exactly that.
  const mode = fs.statSync(SERVICE_SH).mode;
  assert.strictEqual(mode & 0o111, 0, 'service.sh must not be executable');
});

test('service.sh has no argument dispatcher and no top-level invocation', () => {
  assert.ok(!/case\s+"\$1"/.test(serviceCode), 'no `case "$1"` — that is a CLI, not a library');
  assert.ok(!/^\s*"\$@"/m.test(serviceCode), 'no top-level "$@"');
  // A mutator CALLED at column 0. Definitions (`ds_service_write() {`) are fine and are
  // the whole point of the file, so the negative lookahead for `(` is load-bearing.
  assert.ok(!/^ds_service_(start|stop|write|uninstall)(?!\()/m.test(serviceCode),
    'no mutator may run merely because the file was sourced');
});

test('service.sh never sets -e — it is sourced into callers that deliberately do not', () => {
  // install.sh runs under `set -e`; restart.sh and uninstall.sh do not. A `set -e`
  // here would silently change the calling shell's options.
  assert.ok(!/^\s*set\s+-[a-z]*e/m.test(serviceCode));
});

test('service.sh stays POSIX — the CI unit job sources it with dash', () => {
  // `[[ ` with a space, not a bare `[[`: POSIX character classes like [[:space:]] are
  // legitimate and appear in the launchctl grep.
  assert.ok(!/\[\[\s/.test(serviceCode), 'no [[ ]] — bash/zsh only');
  assert.ok(!/\]\]/.test(serviceCode.replace(/\[\[:[a-z]+:\]\]/g, '')), 'no [[ ]] — bash/zsh only');
  assert.ok(!/^\s*\w+=\(/m.test(serviceCode), 'no arrays — bash/zsh only');
  // Belt and braces: actually parse it with the strictest shell available.
  execFileSync('sh', ['-n', SERVICE_SH]);
});

test('the exported ds_* surface is exactly this list', () => {
  // Anti-drift in BOTH directions: a new verb has to be added here deliberately, and
  // a deleted one cannot silently vanish out from under restart.sh/uninstall.sh.
  const defined = [...serviceSrc.matchAll(/^(ds_[a-z_]+)\(\)/gm)].map((m) => m[1]).sort();
  assert.deepStrictEqual(defined, [
    'ds_daemon_reload',
    'ds_install_dir',
    'ds_is_enabled',
    'ds_is_responding',
    'ds_is_running',
    'ds_linger_enabled',
    'ds_linger_note',
    'ds_log_dir',
    'ds_manager_available',
    'ds_maybe_enable_linger',
    'ds_node_path',
    'ds_platform',
    'ds_port',
    'ds_port_in_use',
    'ds_service_path',
    'ds_service_start',
    'ds_service_status',
    'ds_service_stop',
    'ds_service_uninstall',
    'ds_service_write',
    'ds_start_hint',
    'ds_url',
    'ds_wait_responding',
    'ds_wait_stopped',
  ]);
});

test('status.sh is executable and calls no mutating verb', () => {
  assert.ok(fs.statSync(STATUS_SH).mode & 0o111, 'status.sh must be executable');
  const code = uncommented(fs.readFileSync(STATUS_SH, 'utf8'));
  assert.ok(!/ds_service_(start|stop|write|uninstall)\b/.test(code),
    'status.sh must never mutate — it is the allowlist-safe entry point');
  assert.ok(!/ds_daemon_reload\b/.test(code));
  assert.ok(!/\b(launchctl|systemctl)\s+(load|start|enable|stop|unload)/.test(code),
    'status.sh must not drive the service manager directly either');
});

// --- 2. executable tests --------------------------------------------------

/** A scratch $HOME plus recording launchctl/systemctl/loginctl stubs on PATH. */
function sandbox({ platform = 'linux', stubRc = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-servicelib-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');

  for (const name of ['launchctl', 'systemctl', 'loginctl']) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${stubRc}\n`);
    fs.chmodSync(p, 0o755);
  }

  // The real node's directory is on PATH: ds_port_in_use runs a node TCP probe (it
  // replaced lsof, which minimal Linux images lack) and ds_node_path falls back to
  // `command -v node`. A sandbox without node would make both silently no-op — and
  // ds_port_in_use fails OPEN by design, so the port test would pass vacuously.
  const nodeDir = path.dirname(process.execPath);

  /** Source service.sh and evaluate `expr`; returns trimmed stdout. */
  function run(expr, extraEnv = {}) {
    return String(execFileSync('sh', ['-c', `. "${SERVICE_SH}"; ${expr}`], {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: `${bin}:${nodeDir}:/usr/bin:/bin`,
        DEEPSTEVE_PLATFORM: platform,
        ...extraEnv,
      },
    })).trim();
  }
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { dir, home, bin, run, calls, resetCalls: () => fs.writeFileSync(log, '') };
}

test('ds_platform honors DEEPSTEVE_PLATFORM (the both-arms-on-one-runner affordance)', () => {
  assert.strictEqual(sandbox({ platform: 'linux' }).run('ds_platform'), 'linux');
  assert.strictEqual(sandbox({ platform: 'darwin' }).run('ds_platform'), 'darwin');
});

test('paths differ per platform, and match what the installer used to compute', () => {
  const lin = sandbox({ platform: 'linux' });
  assert.strictEqual(lin.run('ds_service_path'), `${lin.home}/.config/systemd/user/deepsteve.service`);
  assert.strictEqual(lin.run('ds_log_dir'), `${lin.home}/.local/share/deepsteve/logs`);

  const mac = sandbox({ platform: 'darwin' });
  assert.strictEqual(mac.run('ds_service_path'), `${mac.home}/Library/LaunchAgents/com.deepsteve.plist`);
  assert.strictEqual(mac.run('ds_log_dir'), `${mac.home}/Library/Logs`);
});

test('the install dir is the same on both platforms, and DEEPSTEVE_HOME overrides it', () => {
  const s = sandbox({ platform: 'linux' });
  assert.strictEqual(s.run('ds_install_dir'), `${s.home}/.deepsteve`);
  assert.strictEqual(s.run('ds_install_dir', { DEEPSTEVE_HOME: '/scratch/ds' }), '/scratch/ds');
});

test('DEEPSTEVE_LOG_DIR overrides on both platforms', () => {
  for (const platform of ['darwin', 'linux']) {
    const s = sandbox({ platform });
    assert.strictEqual(s.run('ds_log_dir', { DEEPSTEVE_LOG_DIR: '/var/log/ds' }), '/var/log/ds');
  }
});

test('ds_port defaults to 3000, then reads back what ds_service_write wrote', () => {
  for (const platform of ['darwin', 'linux']) {
    const s = sandbox({ platform });
    assert.strictEqual(s.run('ds_port'), '3000', `${platform}: default before anything is written`);

    s.run('ds_node_path() { echo /usr/local/bin/node; }; ds_service_write');
    const sp = s.run('ds_service_path');
    assert.ok(fs.existsSync(sp), `${platform}: definition should exist`);
    // Round-trip against real generated output rather than a hand-written sample.
    assert.strictEqual(s.run('ds_port'), '3000', `${platform}: parsed back from the definition`);

    fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace(/3000/, '3999'));
    assert.strictEqual(s.run('ds_port'), '3999', `${platform}: an edited port is picked up`);
  }
});

test('ds_port ignores a garbage value rather than emitting one', () => {
  const s = sandbox({ platform: 'linux' });
  s.run('ds_node_path() { echo /usr/local/bin/node; }; ds_service_write');
  const sp = s.run('ds_service_path');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace('PORT=3000', 'PORT=notanumber'));
  assert.strictEqual(s.run('ds_port'), '3000');
});

test('$PORT in the environment is deliberately NOT consulted', () => {
  // A developer with PORT exported would otherwise silently mis-target every control
  // curl restart.sh makes.
  const s = sandbox({ platform: 'linux' });
  assert.strictEqual(s.run('ds_port', { PORT: '9999' }), '3000');
  assert.strictEqual(s.run('ds_port', { DEEPSTEVE_PORT: '4321' }), '4321');
});

test('ds_node_path prefers the recorded node, guarding the nvm trap', () => {
  // The live plist on a dev machine points into ~/.nvm. Re-deriving it from whatever
  // node happens to be on PATH would silently re-point the daemon at a version the
  // user may later `nvm uninstall`, bricking it with no diagnosable message.
  for (const platform of ['darwin', 'linux']) {
    const s = sandbox({ platform });
    const fakeNode = path.join(s.bin, 'recorded-node');
    fs.writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeNode, 0o755);
    s.run(`ds_node_path() { echo ${fakeNode}; }; ds_service_write`);
    assert.strictEqual(s.run('ds_node_path'), fakeNode, `${platform}: must read it back out`);
  }
});

test('ds_node_path falls back when the recorded node no longer exists', () => {
  const s = sandbox({ platform: 'linux' });
  s.run('ds_node_path() { echo /nonexistent/node; }; ds_service_write');
  const got = s.run('ds_node_path');
  assert.notStrictEqual(got, '/nonexistent/node', 'a dead recorded path must not be returned');
});

test('ds_url is plain localhost, never deepsteve.localhost', () => {
  // Non-browser, bearer-authed traffic must not depend on *.localhost resolving (#545).
  const s = sandbox({ platform: 'linux' });
  assert.strictEqual(s.run('ds_url'), 'http://localhost:3000');
});

test('stop/start issue the right commands on the linux arm', () => {
  const s = sandbox({ platform: 'linux' });
  s.run('ds_service_stop; ds_service_start');
  const calls = s.calls();
  assert.ok(calls.includes('systemctl --user stop deepsteve'), calls.join(' | '));
  assert.ok(calls.includes('systemctl --user enable --now deepsteve'), calls.join(' | '));
  // reset-failed before start: without it, a unit that latched `failed` during a crash
  // loop refuses every subsequent start, which reads as "restart.sh did nothing".
  assert.ok(calls.indexOf('systemctl --user reset-failed deepsteve') <
            calls.indexOf('systemctl --user enable --now deepsteve'),
  'reset-failed must precede start');
});

test('stop/start issue the right commands on the darwin arm', () => {
  const s = sandbox({ platform: 'darwin' });
  s.run('ds_service_stop; ds_service_start');
  const calls = s.calls().join('\n');
  assert.match(calls, /launchctl unload .*com\.deepsteve\.plist/);
  assert.match(calls, /launchctl load .*com\.deepsteve\.plist/);
  assert.ok(!/systemctl/.test(calls), 'darwin must never touch systemctl');
});

test('ds_service_stop returns 0 even when the manager fails — the `set -e` contract', () => {
  // install.sh runs under set -e. `systemctl --user stop` on a unit that does not exist
  // yet exits nonzero, which would have aborted every fresh Linux install at the last
  // step. "Already stopped" is success.
  for (const platform of ['darwin', 'linux']) {
    const s = sandbox({ platform, stubRc: 1 });
    assert.strictEqual(s.run('ds_service_stop && echo ok'), 'ok', `${platform}`);
  }
});

test('ds_service_start does NOT swallow failure', () => {
  for (const platform of ['darwin', 'linux']) {
    const s = sandbox({ platform, stubRc: 1 });
    assert.strictEqual(s.run('ds_service_start >/dev/null 2>&1 || echo failed'), 'failed', `${platform}`);
  }
});

test('ds_service_uninstall stops, disables and removes the definition', () => {
  const s = sandbox({ platform: 'linux' });
  s.run('ds_node_path() { echo /usr/local/bin/node; }; ds_service_write');
  const sp = s.run('ds_service_path');
  assert.ok(fs.existsSync(sp));
  s.run('ds_service_uninstall');
  assert.ok(!fs.existsSync(sp), 'the definition must be gone');
  assert.ok(s.calls().includes('systemctl --user disable deepsteve'));
});

test('ds_is_running maps the manager exit code on both arms', () => {
  const linUp = sandbox({ platform: 'linux', stubRc: 0 });
  assert.strictEqual(linUp.run('ds_is_running && echo yes || echo no'), 'yes');
  const linDown = sandbox({ platform: 'linux', stubRc: 1 });
  assert.strictEqual(linDown.run('ds_is_running && echo yes || echo no'), 'no');
});

test('ds_port_in_use answers truthfully against a real listener', () => {
  // Hermetic: a real ephemeral server, no daemon involved. This is the replacement for
  // `lsof -i :3000`, which is simply absent on minimal Linux images.
  const net = require('net');
  const srv = net.createServer(() => {});
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', () => {
      try {
        const port = srv.address().port;
        const s = sandbox({ platform: 'linux' });
        assert.strictEqual(s.run(`ds_port_in_use ${port} && echo busy || echo free`), 'busy');
        srv.close(() => {
          try {
            assert.strictEqual(s.run(`ds_port_in_use ${port} && echo busy || echo free`), 'free');
            resolve();
          } catch (e) { reject(e); }
        });
      } catch (e) { srv.close(); reject(e); }
    });
  });
});

test('ds_wait_stopped returns promptly when the manager reports stopped', async () => {
  const s = sandbox({ platform: 'linux', stubRc: 1 }); // is-active fails => not running
  // Pin a port nothing is on. Without this the sandbox falls back to ds_port's 3000
  // default, and on a developer's machine that is their own live daemon — the
  // port-free loop would then burn its full 5s and this test would time itself out
  // against unrelated local state.
  const freePort = await new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const started = Date.now();
  assert.strictEqual(s.run('ds_wait_stopped 5 && echo stopped', { DEEPSTEVE_PORT: String(freePort) }), 'stopped');
  assert.ok(Date.now() - started < 4000, `must not sit through the whole timeout (took ${Date.now() - started}ms)`);
});

test('ds_linger_note prints the exact fix command when lingering is off', () => {
  const s = sandbox({ platform: 'linux' });
  const out = s.run('ds_linger_note');
  assert.match(out, /loginctl enable-linger/);
  assert.match(out, /does not start at boot/);
});

test('lingering is never auto-enabled without the explicit opt-in', () => {
  // enable-linger writes outside $HOME and its polkit action typically prompts for a
  // remote session — a curl|bash installer must not hang on a password prompt.
  const s = sandbox({ platform: 'linux' });
  s.run('ds_maybe_enable_linger >/dev/null');
  assert.ok(!s.calls().some((c) => c.includes('enable-linger')), 'must only advise by default');

  const optIn = sandbox({ platform: 'linux' });
  optIn.run('ds_maybe_enable_linger >/dev/null', { DEEPSTEVE_ENABLE_LINGER: '1' });
  assert.ok(optIn.calls().some((c) => c.includes('loginctl enable-linger')), 'opt-in must act');
});

test('ds_linger_note is a no-op on darwin (launchd needs no lingering)', () => {
  const s = sandbox({ platform: 'darwin' });
  assert.strictEqual(s.run('ds_linger_note'), '');
});

test('ds_service_status reports both arms without touching the daemon', () => {
  for (const platform of ['darwin', 'linux']) {
    const s = sandbox({ platform, stubRc: 1 });
    const out = s.run('ds_service_status');
    assert.match(out, /^deepsteve/m);
    assert.match(out, platform === 'darwin' ? /launchd/ : /systemd --user/);
    assert.match(out, /MISSING — run install\.sh/, 'a missing definition must be named');
    assert.match(out, /ssh -L 3000:localhost:3000/, 'the loopback-bind escape hatch belongs here');
  }
});
