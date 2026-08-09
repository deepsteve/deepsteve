// The launchd plist and the systemd unit that service.sh writes (#621).
//
// Golden fixtures rather than scattered assertions, for two reasons. Reviewing a
// change to a service definition means reading the whole file, not a list of greps —
// and the systemd arm has literally never executed in CI (test/Dockerfile.install and
// Dockerfile.public both stub systemctl to `exit 0`), so the unit file has never been
// anything but unverified text. A fixture diff makes every future edit visible.
//
// Runs in the bare ubuntu unit job: it sources service.sh under `sh` with a scratch
// $HOME and DEEPSTEVE_PLATFORM, so one runner produces both platforms' output.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVICE_SH = path.join(REPO, 'service.sh');
const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_NODE = '/usr/local/bin/node';

/**
 * Write the definition for `platform` into a scratch home and return it with the
 * volatile bits replaced by placeholders, so the fixture is machine-independent.
 */
function renderDefinition(platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-svcdef-'));
  const home = path.join(dir, 'home');
  const dest = path.join(dir, 'definition');
  fs.mkdirSync(home, { recursive: true });

  execFileSync('sh', ['-c', `
    . "${SERVICE_SH}"
    ds_node_path() { printf '%s\\n' "${FAKE_NODE}"; }
    ds_service_path() { printf '%s\\n' "${dest}"; }
    ds_service_write
  `], { env: { HOME: home, PATH: '/usr/bin:/bin', DEEPSTEVE_PLATFORM: platform } });

  return fs.readFileSync(dest, 'utf8')
    .split(home).join('{{HOME}}')
    .split(FAKE_NODE).join('{{NODE}}')
    .split(path.dirname(FAKE_NODE)).join('{{NODEDIR}}');
}

const CASES = [
  { platform: 'darwin', fixture: 'service-darwin.plist' },
  { platform: 'linux', fixture: 'service-linux.service' },
];

test('the fixtures exist — otherwise the comparisons below are vacuous', () => {
  for (const { fixture } of CASES) {
    assert.ok(fs.existsSync(path.join(FIXTURES, fixture)), `missing fixture ${fixture}`);
  }
});

for (const { platform, fixture } of CASES) {
  test(`${platform}: the written definition matches its golden fixture`, () => {
    const got = renderDefinition(platform);
    const want = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
    assert.strictEqual(got, want,
      `${fixture} is out of date. If the change is intentional, update the fixture — ` +
      'the diff above IS the review of your service-definition change.');
  });
}

// --- cross-language agreement --------------------------------------------

test('the definition points logging.js at the log dir it actually rotates', () => {
  // logging.js:defaultLogPaths has carried a comment since #557 saying it "must mirror
  // release.sh's LOG_DIR choices" — an unenforced coupling between a shell script and a
  // JS module. Now that the shell side is ds_log_dir and the JS side is paths.logDir,
  // this test is the enforcement. A drift here means the daemon rotates a file nothing
  // writes to, and lets the real log grow forever.
  const { defaultLogPaths } = require('../../logging');
  for (const platform of ['darwin', 'linux']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-logdir-'));
    const shellAnswer = String(execFileSync('sh', ['-c', `. "${SERVICE_SH}"; ds_log_dir`], {
      encoding: 'utf8', env: { HOME: dir, PATH: '/usr/bin:/bin', DEEPSTEVE_PLATFORM: platform },
    })).trim();
    const jsAnswer = path.dirname(defaultLogPaths({ platform, env: {}, homedir: dir })[0].path);
    assert.strictEqual(shellAnswer, jsAnswer,
      `${platform}: service.sh's ds_log_dir and paths.js's logDir disagree`);
  }
});

test('the state dir agrees between service.sh and paths.js', () => {
  const { stateDir } = require('../../paths');
  for (const platform of ['darwin', 'linux']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-statedir-'));
    const shellAnswer = String(execFileSync('sh', ['-c', `. "${SERVICE_SH}"; ds_install_dir`], {
      encoding: 'utf8', env: { HOME: dir, PATH: '/usr/bin:/bin', DEEPSTEVE_PLATFORM: platform },
    })).trim();
    assert.strictEqual(shellAnswer, stateDir({ env: {}, homedir: dir }), `${platform}`);
  }
});

test('the tmux socket agrees between service.sh and paths.js (#625)', () => {
  // uninstall.sh ends deepsteve's tmux server through ds_tmux_socket before deleting
  // the directory that holds it, and status.sh reports it. If the two implementations
  // drift, the uninstall silently misses — leaving live panes on a socket whose file
  // has just been unlinked, reachable by nothing, forever.
  const { tmuxSocketPath } = require('../../paths');
  for (const platform of ['darwin', 'linux']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxsock-'));
    const shellAnswer = String(execFileSync('sh', ['-c', `. "${SERVICE_SH}"; ds_tmux_socket`], {
      encoding: 'utf8', env: { HOME: dir, PATH: '/usr/bin:/bin', DEEPSTEVE_PLATFORM: platform },
    })).trim();
    assert.strictEqual(shellAnswer, tmuxSocketPath({ env: {}, homedir: dir }), `${platform}`);
  }
});

test('DEEPSTEVE_HOME moves the socket on both sides (#625)', () => {
  // The property that makes HOME isolation *be* socket isolation: a second instance
  // relocates its socket along with the rest of its state, on both sides of the split.
  const { tmuxSocketPath } = require('../../paths');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxsock-alt-'));
  const shellAnswer = String(execFileSync('sh', ['-c', `. "${SERVICE_SH}"; ds_tmux_socket`], {
    encoding: 'utf8',
    env: { HOME: '/nonexistent', PATH: '/usr/bin:/bin', DEEPSTEVE_HOME: dir, DEEPSTEVE_PLATFORM: 'linux' },
  })).trim();
  assert.strictEqual(shellAnswer, path.join(dir, 'tmux.sock'));
  assert.strictEqual(shellAnswer, tmuxSocketPath({ env: { DEEPSTEVE_HOME: dir }, homedir: '/nonexistent' }));
});

// --- properties the fixtures encode, stated explicitly --------------------
//
// The fixture diff catches ANY change; these say which changes would be bugs, so a
// future editor sees the reason rather than just a red diff.

test('both definitions bind loopback and use the same port', () => {
  const plist = fs.readFileSync(path.join(FIXTURES, 'service-darwin.plist'), 'utf8');
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  assert.match(plist, /<key>DEEPSTEVE_BIND<\/key>\s*\n\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(unit, /^Environment=DEEPSTEVE_BIND=127\.0\.0\.1$/m);
  assert.match(plist, /<key>PORT<\/key>\s*\n\s*<string>3000<\/string>/);
  assert.match(unit, /^Environment=PORT=3000$/m);
});

test('the systemd unit sets KillMode=process — without it every restart kills every session', () => {
  // The single most important line in the unit, and the one most likely to be
  // "cleaned up" by someone who does not know why it is there.
  //
  // systemd's default is KillMode=control-group: on stop it SIGKILLs the entire
  // cgroup. cgroup membership is inherited across fork(), so the tmux server the
  // daemon spawned is in deepsteve.service's cgroup and dies with it. tmux has been
  // the default engine since #620 and surviving a restart is the whole reason to run
  // deepsteve on a remote box — so the default turns every ./restart.sh on Linux into
  // "lose all your sessions", the exact opposite of macOS, where launchctl unload
  // leaves the daemonized tmux server alone.
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  assert.match(unit, /^KillMode=process$/m,
    'KillMode=process is what keeps the tmux server alive across a daemon restart');
});

test('the systemd unit bounds shutdown above the real worst case', () => {
  // Graceful shutdown is ~12s worst case (8s /exit + 2s SIGTERM + 2s SIGKILL + drain),
  // and restart.sh waits 15s. Below ~20s systemd would start killing mid-shutdown and
  // state.json could be lost; the 90s default is unrelated to either number.
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  const m = unit.match(/^TimeoutStopSec=(\d+)$/m);
  assert.ok(m, 'TimeoutStopSec must be set explicitly');
  assert.ok(Number(m[1]) >= 20, `TimeoutStopSec=${m[1]} is below the ~12s graceful shutdown + margin`);
});

test('both definitions hand the daemon its own log dir', () => {
  // logging.js:38 already prefers env.DEEPSTEVE_LOG_DIR, so passing it here costs no JS
  // change and demotes the "must mirror release.sh" duplication to a fallback for
  // installs whose definition predates this.
  const plist = fs.readFileSync(path.join(FIXTURES, 'service-darwin.plist'), 'utf8');
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  assert.match(plist, /<key>DEEPSTEVE_LOG_DIR<\/key>\s*\n\s*<string>\{\{HOME\}\}\/Library\/Logs<\/string>/);
  assert.match(unit, /^Environment=DEEPSTEVE_LOG_DIR=\{\{HOME\}\}\/\.local\/share\/deepsteve\/logs$/m);
});

test('ExecStart is quoted — systemd splits on whitespace with no shell', () => {
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  assert.match(unit, /^ExecStart="[^"]+" "[^"]+"$/m,
    'an unquoted ExecStart breaks on a $HOME containing a space');
});

test('the unit does not order itself after network.target', () => {
  // Inert in a USER unit — network.target is a system target with no analogue in the
  // user manager — and we bind loopback, so there is nothing to wait for.
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  assert.ok(!/network\.target/.test(unit));
});

test('the systemd unit writes logs to FILES, not the journal', () => {
  // `append:` is what gives the daemon an O_APPEND fd it owns — which is the entire
  // premise of logging.js's rotate-by-ftruncate design. `journal` would hand it a
  // socket and rotation would silently no-op.
  const unit = fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8');
  assert.match(unit, /^StandardOutput=append:/m);
  assert.match(unit, /^StandardError=append:/m);
});

test('both PATHs include the bundled node dir and ~/.local/bin', () => {
  // tmux-path.js/bin-path.js exist because these PATHs omit /opt/homebrew/bin. If that
  // ever changes, FALLBACK_DIRS' rationale changes with it — so pin what IS here.
  for (const f of ['service-darwin.plist', 'service-linux.service']) {
    const src = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    assert.ok(src.includes('{{HOME}}/.deepsteve/node/bin'), `${f}: bundled node dir`);
    assert.ok(src.includes('{{HOME}}/.local/bin'), `${f}: ~/.local/bin`);
    assert.ok(src.includes('/usr/sbin:/sbin'), `${f}: sbin dirs — the two PATHs must match`);
    assert.ok(!src.includes('/opt/homebrew/bin'),
      `${f}: still omits /opt/homebrew/bin — bin-path.js's FALLBACK_DIRS covers it`);
  }
});

// --- real systemd validation ---------------------------------------------

test('launchd\'s own parser accepts the plist', (t) => {
  // The darwin counterpart to systemd-analyze below: plutil is the real plist parser,
  // so it catches malformed XML that a regex never would (an unescaped & in $HOME, a
  // <key> without its <string>, a mis-nested dict). Skipped off macOS; between the two
  // of them, CI and a dev machine cover one arm each for real.
  let plutil;
  try {
    plutil = String(execFileSync('sh', ['-c', 'command -v plutil'], { encoding: 'utf8' })).trim();
  } catch { /* not macOS */ }
  if (!plutil) return t.skip('plutil not available on this platform');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-plutil-'));
  const p = path.join(dir, 'com.deepsteve.plist');
  fs.writeFileSync(p, fs.readFileSync(path.join(FIXTURES, 'service-darwin.plist'), 'utf8')
    .split('{{NODE}}').join('/usr/bin/true')
    .split('{{NODEDIR}}').join('/usr/bin')
    .split('{{HOME}}').join(dir));
  execFileSync(plutil, ['-lint', p], { stdio: ['ignore', 'pipe', 'pipe'] });
});

test('systemd itself accepts the unit', (t) => {
  // The only check here that understands systemd. GitHub's ubuntu-latest runners are
  // full systemd VMs, so this really runs in CI — catching unknown directives, syntax
  // errors, and the `append:` requirement (systemd >= 240) that a regex never would.
  // Skipped where systemd-analyze is absent, e.g. a Mac dev machine.
  let analyze;
  try {
    analyze = String(execFileSync('sh', ['-c', 'command -v systemd-analyze'], { encoding: 'utf8' })).trim();
  } catch { /* not installed */ }
  if (!analyze) return t.skip('systemd-analyze not available on this platform');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-analyze-'));
  const unitPath = path.join(dir, 'deepsteve.service');
  // ExecStart must name a binary that exists or verify reports a false failure, so
  // substitute /bin/true for the placeholder node.
  fs.writeFileSync(unitPath, fs.readFileSync(path.join(FIXTURES, 'service-linux.service'), 'utf8')
    .split('{{NODE}}').join('/bin/true')
    .split('{{NODEDIR}}').join('/bin')
    .split('{{HOME}}').join(dir));

  const out = execFileSync(analyze, ['--user', 'verify', unitPath],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(!/Unknown (key|section)/i.test(out), `systemd-analyze objected:\n${out}`);
});
