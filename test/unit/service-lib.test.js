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
    'ds_install_deps',
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
    'ds_tmux_socket',
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
// A username no linger file can plausibly exist for. See the `id` stub below.
const SANDBOX_USER = 'ds-sandbox-user';

function sandbox({ platform = 'linux', stubRc = 0, lingerOn = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-servicelib-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');

  for (const name of ['launchctl', 'systemctl', 'loginctl']) {
    const p = path.join(bin, name);
    // ds_linger_enabled's second branch greps this stub's STDOUT for Linger=yes, so
    // `lingerOn` is how a test says "lingering is already on" without needing a real
    // systemd. The call log is a separate fd and stays complete either way.
    const say = lingerOn && name === 'loginctl' ? 'echo "Linger=yes"\n' : '';
    fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${say}exit ${stubRc}\n`);
    fs.chmodSync(p, 0o755);
  }

  // `id` is stubbed for exactly the reason launchctl is. ds_linger_enabled's FIRST
  // branch is `[ -e /var/lib/systemd/linger/$(id -un) ]` — a real path built from a
  // real username, neither of which the sandbox controlled. GitHub's ubuntu runner
  // enables lingering for `runner`, so that file exists there and every sandbox
  // silently answered "lingering is already on": ds_linger_note printed nothing and
  // ds_maybe_enable_linger returned before its opt-in branch. Green on a Mac, red in
  // CI. A sentinel username makes the answer the harness's to decide, and `lingerOn`
  // above is the supported way to flip it.
  const idStub = path.join(bin, 'id');
  fs.writeFileSync(idStub, `#!/bin/sh\necho "${SANDBOX_USER}"\n`);
  fs.chmodSync(idStub, 0o755);

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

test('ds_wait_stopped returns immediately when the manager reports stopped', async () => {
  const s = sandbox({ platform: 'linux', stubRc: 1 }); // is-active fails => not running
  // Pin a port nothing is on. Without this the sandbox falls back to ds_port's 3000
  // default, and on a developer's machine that is their own live daemon — so the
  // port-free loop would poll for its full 5s against unrelated local state.
  const freePort = await new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  assert.strictEqual(s.run('ds_wait_stopped 5 && echo stopped', { DEEPSTEVE_PORT: String(freePort) }), 'stopped');
  // Count the polls rather than the wall clock. A duration bound looks equivalent but
  // is a flake waiting to happen: this spawns several `sh` subprocesses, and on a
  // loaded machine that alone can cross any threshold tight enough to be meaningful.
  const polls = s.calls().filter((c) => c.includes('is-active')).length;
  assert.ok(polls <= 2, `expected the loop to exit on its first check, saw ${polls} polls`);
});

test('ds_linger_note prints the exact fix command when lingering is off', () => {
  const s = sandbox({ platform: 'linux' });
  const out = s.run('ds_linger_note');
  assert.match(out, /loginctl enable-linger/);
  assert.match(out, /does not start at boot/);
  // The command must name the user, or it is not copy-pasteable. Asserting the
  // sandbox's own username also pins that `id` is the stub — if the real one ever
  // leaks back in, this fails loudly instead of the note silently vanishing.
  assert.match(out, new RegExp(`loginctl enable-linger ${SANDBOX_USER}`));
});

test('ds_linger_note stays quiet when lingering is already on', () => {
  // The other half of the branch, and the one whose absence let #621 ship a harness
  // that could not tell "lingering is on" from "the harness leaked the real host in".
  const s = sandbox({ platform: 'linux', lingerOn: true });
  assert.strictEqual(s.run('ds_linger_note'), '');
  assert.strictEqual(s.run('ds_linger_enabled && echo yes'), 'yes');
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

// --- ds_install_deps (#744) ------------------------------------------------
//
// The one dependency install behind restart.sh and install.sh. The bug it fixes: the
// reinstall keyed on package.json alone, so a lockfile-only Dependabot patch never
// reached the daemon. The property it must keep: a failed npm leaves the previous
// node_modules usable, because the daemon is about to be started on it.

/**
 * A sandbox with an install dir and a fake `npm` on PATH. The fake records each call
 * and "installs" by copying the lockfile it was handed into node_modules/dep/from-lock,
 * so a test can read back which lockfile the tree came from. When told to fail it first
 * vandalizes node_modules — the half-finished tree a real failed reify can leave — and
 * exits 1.
 */
function depsSandbox(opts) {
  const s = sandbox(opts);
  const inst = path.join(s.dir, 'install');
  fs.mkdirSync(inst);
  const npmLog = path.join(s.dir, 'npm.log');
  const failFlag = path.join(s.dir, 'npm-fails');
  const npm = path.join(s.bin, 'npm');
  fs.writeFileSync(npm, [
    '#!/bin/sh',
    `echo "$(pwd) $*" >> "${npmLog}"`,
    `if [ -e "${failFlag}" ]; then`,
    '  rm -rf node_modules/dep; mkdir -p node_modules; echo half > node_modules/half-written',
    '  exit 1',
    'fi',
    'mkdir -p node_modules/dep',
    'cat package-lock.json > node_modules/dep/from-lock 2>/dev/null || echo none > node_modules/dep/from-lock',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(npm, 0o755);
  const p = (f) => path.join(inst, f);
  return {
    ...s,
    inst,
    write: (f, body) => fs.writeFileSync(p(f), body),
    read: (f) => fs.readFileSync(p(f), 'utf8'),
    exists: (f) => fs.existsSync(p(f)),
    /** Run ds_install_deps against the install dir; returns its exit code. */
    install: () => Number(s.run(`ds_install_deps "${inst}" 2>/dev/null; echo $?`)),
    npmCalls: () => (fs.existsSync(npmLog)
      ? fs.readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean) : []),
    failNpm: (on) => (on ? fs.writeFileSync(failFlag, '') : fs.rmSync(failFlag, { force: true })),
  };
}

test('ds_install_deps: a first install runs npm in the dir, from the lockfile, and stamps both', () => {
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  s.write('package-lock.json', 'lock-1\n');
  assert.strictEqual(s.install(), 0);
  const calls = s.npmCalls();
  assert.strictEqual(calls.length, 1, calls.join(' | '));
  assert.ok(calls[0].startsWith(`${fs.realpathSync(s.inst)} `) || calls[0].startsWith(`${s.inst} `),
    `npm must run inside the install dir: ${calls[0]}`);
  // install, never ci (ci deletes node_modules before it fetches anything); --no-save so
  // npm cannot rewrite the lockfile it was handed, which keeps the deployed copy
  // byte-identical to the source's.
  assert.match(calls[0], / install --omit=dev --no-save\b/);
  assert.strictEqual(s.read('node_modules/dep/from-lock'), 'lock-1\n');
  assert.strictEqual(s.read('package.json.prev'), '{"v":1}\n');
  assert.strictEqual(s.read('package-lock.json.prev'), 'lock-1\n');
  assert.ok(!s.exists('node_modules.prev'), 'a successful install leaves no snapshot behind');
});

test('ds_install_deps: an unchanged pair is a no-op', () => {
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  s.write('package-lock.json', 'lock-1\n');
  assert.strictEqual(s.install(), 0);
  assert.strictEqual(s.install(), 0);
  assert.strictEqual(s.npmCalls().length, 1, 'the second deploy must not reinstall');
});

test('ds_install_deps: a lockfile-only change reinstalls — the #744 bug', () => {
  // Exactly what a Dependabot transitive bump looks like: package.json byte-identical.
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  s.write('package-lock.json', 'lock-1\n');
  assert.strictEqual(s.install(), 0);
  s.write('package-lock.json', 'lock-2\n');
  assert.strictEqual(s.install(), 0);
  assert.strictEqual(s.npmCalls().length, 2, 'a lockfile-only change must trigger the reinstall');
  assert.strictEqual(s.read('node_modules/dep/from-lock'), 'lock-2\n');
  assert.strictEqual(s.read('package-lock.json.prev'), 'lock-2\n');
});

test('ds_install_deps: a package.json-only change, or a missing tree, reinstalls too', () => {
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  s.write('package-lock.json', 'lock-1\n');
  assert.strictEqual(s.install(), 0);
  s.write('package.json', '{"v":2}\n');
  assert.strictEqual(s.install(), 0);
  assert.strictEqual(s.npmCalls().length, 2);
  fs.rmSync(path.join(s.inst, 'node_modules'), { recursive: true });
  assert.strictEqual(s.install(), 0);
  assert.strictEqual(s.npmCalls().length, 3, 'current stamps are not an excuse for no node_modules');
});

test('ds_install_deps: with no lockfile on either side, it is still a stable no-op', () => {
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  assert.strictEqual(s.install(), 0);
  assert.ok(!s.exists('package-lock.json.prev'));
  assert.strictEqual(s.install(), 0);
  assert.strictEqual(s.npmCalls().length, 1, 'a missing lockfile must not reinstall on every deploy');
});

test('ds_install_deps: a failed npm restores the previous node_modules and does not stamp', () => {
  // Both arms: darwin snapshots with `cp -Rc`, linux with `cp -a --reflink=auto`, and
  // whichever one the host's cp rejects exercises the plain-copy fallback.
  for (const platform of ['darwin', 'linux']) {
    const s = depsSandbox({ platform });
    s.write('package.json', '{"v":1}\n');
    s.write('package-lock.json', 'lock-1\n');
    assert.strictEqual(s.install(), 0, platform);

    s.write('package-lock.json', 'lock-2\n');
    s.failNpm(true);
    assert.strictEqual(s.install(), 1, `${platform}: 1 means "failed, previous tree restored"`);
    assert.strictEqual(s.read('node_modules/dep/from-lock'), 'lock-1\n',
      `${platform}: the tree the daemon is about to start on must be the old, whole one`);
    assert.ok(!s.exists('node_modules/half-written'), `${platform}: the half-written tree must be gone`);
    assert.ok(!s.exists('node_modules.prev'), `${platform}: the snapshot is consumed by the restore`);
    assert.strictEqual(s.read('package-lock.json.prev'), 'lock-1\n',
      `${platform}: a failure must not stamp, or the next deploy would skip the retry`);

    s.failNpm(false);
    assert.strictEqual(s.install(), 0, platform);
    assert.strictEqual(s.npmCalls().length, 3, `${platform}: the next deploy retries`);
    assert.strictEqual(s.read('node_modules/dep/from-lock'), 'lock-2\n', platform);
  }
});

test('ds_install_deps: a failed FIRST install says so with 2 and stamps nothing', () => {
  // install.sh aborts on 2 (there is nothing to start) and carries on after 1.
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  s.write('package-lock.json', 'lock-1\n');
  s.failNpm(true);
  assert.strictEqual(s.install(), 2);
  assert.ok(!s.exists('package.json.prev') && !s.exists('package-lock.json.prev'));
});

test('ds_install_deps: a snapshot left by an interrupted install is restored before anything else', () => {
  // An install killed between the snapshot and npm finishing leaves node_modules.prev
  // (the last good tree) beside a half-written node_modules. The next run must not
  // snapshot the broken tree over the good one.
  const s = depsSandbox();
  s.write('package.json', '{"v":1}\n');
  s.write('package-lock.json', 'lock-1\n');
  assert.strictEqual(s.install(), 0);
  fs.cpSync(path.join(s.inst, 'node_modules'), path.join(s.inst, 'node_modules.prev'), { recursive: true });
  fs.rmSync(path.join(s.inst, 'node_modules', 'dep'), { recursive: true });
  s.write('node_modules/half-written', 'half\n');
  s.write('package-lock.json', 'lock-2\n');

  s.failNpm(true);
  assert.strictEqual(s.install(), 1);
  assert.strictEqual(s.read('node_modules/dep/from-lock'), 'lock-1\n', 'the good tree came back');
  assert.ok(!s.exists('node_modules/half-written'));
  assert.ok(!s.exists('node_modules.prev'));
});
