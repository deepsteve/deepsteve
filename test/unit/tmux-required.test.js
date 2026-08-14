// tmux is a declared dependency off macOS (#620/#621).
//
// The trade differs by platform. On macOS node-pty is a supported fallback: the daemon
// restarts when the user asks it to, and losing sessions is an annoyance. On Linux the
// service manager restarts the daemon on every crash and every unattended upgrade, so
// "sessions die with the daemon" means they die at moments nobody chose — on the very
// box whose purpose is staying up.
//
// server.js cannot be imported here (engines/node-pty.js's top-level require('node-pty')
// has no binding under the unit job's --ignore-scripts), so the settings thunk is
// extracted and evaluated in a vm — the same technique codex-lifecycle.test.js uses.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

/** Evaluate the `engine` setting's `values` thunk with tmuxEngine/TMUX_REQUIRED injected. */
function engineValues({ tmuxEngine, TMUX_REQUIRED }) {
  const start = serverSource.indexOf('    values: () => {');
  assert.ok(start >= 0, 'could not find the engine values thunk — did its shape change?');
  const end = serverSource.indexOf('\n    } },', start);
  assert.ok(end > start, 'could not find the end of the engine values thunk');
  const body = serverSource.slice(start + '    values: '.length, end + '\n    }'.length);
  const ctx = { tmuxEngine, TMUX_REQUIRED, result: null };
  vm.runInNewContext(`result = (${body})()`, ctx);
  // Back into this realm: an array built inside the vm has a different Array prototype,
  // so deepStrictEqual would reject it as "same structure, not reference-equal".
  return JSON.parse(JSON.stringify(ctx.result));
}

test('macOS keeps node-pty as a supported choice', () => {
  assert.deepStrictEqual(
    engineValues({ tmuxEngine: {}, TMUX_REQUIRED: false }),
    ['node-pty', 'tmux'],
  );
});

test('where tmux is required, node-pty is not offered once tmux exists', () => {
  assert.deepStrictEqual(
    engineValues({ tmuxEngine: {}, TMUX_REQUIRED: true }),
    ['tmux'],
  );
});

test('with no tmux at all, the enum still describes reality', () => {
  // The daemon really did fall back to node-pty, so the enum has to be able to say so —
  // otherwise the settings dropdown shows a value the server would reject.
  for (const TMUX_REQUIRED of [true, false]) {
    assert.deepStrictEqual(
      engineValues({ tmuxEngine: null, TMUX_REQUIRED }),
      ['node-pty'],
      `TMUX_REQUIRED=${TMUX_REQUIRED}`,
    );
  }
});

test('a saved engine value is never validated against the thunk at load time', () => {
  // This is what makes the narrowed Linux enum safe: settings load is a plain spread,
  // so an existing install whose settings.json says "node-pty" keeps working even where
  // the thunk no longer offers it. The thunk gates POSTs and the dropdown, nothing else.
  // If loading ever started coercing enums, a Linux upgrade would silently rewrite the
  // engine out from under a running install.
  const at = serverSource.indexOf('// Load settings');
  assert.ok(at >= 0, 'could not locate the settings load');
  const loadRegion = serverSource.slice(at, serverSource.indexOf('function saveSettings', at));
  assert.ok(loadRegion.length > 0, 'could not locate the settings load region');
  assert.match(loadRegion, /\{ \.\.\.settings, \.\.\.JSON\.parse\(fs\.readFileSync\(SETTINGS_FILE/,
    'expected the plain {...defaults, ...fromDisk} spread');
  assert.ok(!/coerceSetting|applySettingsFromBody/.test(loadRegion),
    'settings load must not validate against the schema — see the comment on the engine thunk');
});

test('TMUX_REQUIRED is platform-derived, and macOS is the only exemption', () => {
  assert.match(serverSource, /const TMUX_REQUIRED = process\.platform !== 'darwin';/);
});

test('the daemon still BOOTS when a required tmux is missing', () => {
  // Deliberate: refusing to start on a headless box means the UI that would explain why
  // never comes up, and Restart=always/RestartSec=5 turns it into an invisible crash
  // loop. install.sh does the refusing, where a human is watching a terminal.
  const region = serverSource.slice(
    serverSource.indexOf('const TMUX_REQUIRED'),
    serverSource.indexOf('Session lifecycle event bus'),
  );
  assert.ok(region.length > 0, 'could not locate the engine-init block');
  assert.ok(!/process\.exit/.test(region), 'the daemon must not exit when tmux is missing');
  assert.match(region, /tmux is REQUIRED on this platform/, 'it must say so loudly instead');
  assert.match(region, /apt\/dnf\/pacman/, 'and say how to fix it');
});

test('/api/engines tells the client whether tmux is required', () => {
  // The browser has no idea what OS the daemon runs on, so this must be a fact sent from
  // the server rather than something sniffed client-side.
  assert.match(serverSource, /tmuxRequired: TMUX_REQUIRED,/);
  const app = fs.readFileSync(path.join(REPO, 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /enginesData\.tmuxRequired/, 'the settings warning must escalate on it');
});

test('install.sh refuses to install on Linux without tmux', () => {
  // The other half: enforce where enforcement is free and visible.
  const release = fs.readFileSync(path.join(REPO, 'release.sh'), 'utf8');
  const gate = release.slice(release.indexOf('if [ "$OS" != "Darwin" ] && ! command -v tmux'));
  assert.ok(gate.length > 0, 'release.sh must emit a tmux gate into install.sh');
  assert.match(gate.slice(0, 900), /exit 1/, 'the gate must be fatal');
  assert.match(gate.slice(0, 900), /apt-get install -y tmux/, 'and name the fix');
});

test('the local-install docker image satisfies the dependency it now declares', () => {
  // Otherwise `npm run test:install` goes red at image build: install.sh would refuse.
  const df = fs.readFileSync(path.join(REPO, 'test', 'Dockerfile.install'), 'utf8');
  assert.match(df, /apt-get install[^\n]*\btmux\b/, 'Dockerfile.install must install tmux');
});

test('the PUBLIC install image satisfies the dependency the released install.sh declares', () => {
  // This assertion is the INVERSE of the one #621 shipped, and the flip is the lesson.
  //
  // #621 deliberately left this image alone, and was right at the time: the public suite
  // installs the LAST RELEASED install.sh, which then was v0.21.0 — no tmux gate — so
  // adding tmux would have been testing a requirement that build never had. But that
  // rationale was true only until a release CONTAINED the gate. v0.22.0 published it, and
  // `curl deepsteve.com/install.sh | bash` in a tmux-less image now exits 1: the suite
  // died at `docker build`, before a single test ran.
  //
  // The trap is structural, so it is worth naming rather than just fixing: #588 has this
  // job check out the release TAG, so the image lives at the tag too — a fix on main
  // cannot reach the cron until a release carries it. Whenever install.sh changes what it
  // REQUIRES, this image has to change in the same release, not the one after.
  const df = fs.readFileSync(path.join(REPO, 'test', 'Dockerfile.public'), 'utf8');
  assert.match(df, /apt-get install[^\n]*\btmux\b/,
    'the released install.sh refuses on Linux without tmux — without it the image cannot build');
});

test('no suite can skip a test file at all', () => {
  // The successor to the two `!/run-integration\.sh\s+tmux-engine/` greps that used to sit in
  // the tests above, one per compose file. `tmux-engine` was the one legitimate permanent
  // skip — neither install image had tmux — and #621/v0.22.0 removed its justification from
  // both. What was left was a parameter whose only remaining use was hiding a failure, and a
  // pair of per-file greps that would have gone quietly vacuous the moment the command moved
  // (it since has: docker-compose.base.yml holds it for all three installed suites).
  //
  // So assert the property at its source instead. The runner takes no argument, and no caller
  // passes one — which makes "never skip a test the server under test predates" (#588: the
  // public suite runs each release's OWN tests, so version skew cannot arise) an impossibility
  // rather than a rule someone has to remember.
  const runner = fs.readFileSync(path.join(REPO, 'test', 'run-integration.sh'), 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // Deliberately not a bare /\$1/: the env-stripping loop runs `awk '{print $1}'`, which is
  // awk's field, not the shell's argument. These are the spellings a parameter actually takes.
  assert.ok(!/\$\{1|"\$1"|\$@|\$\*/.test(runner),
    'test/run-integration.sh reads a positional argument again. It runs every file in '
    + 'test/integration/, unconditionally; a skip parameter has no remaining legitimate use.');
  assert.ok(!/\bskip\b/.test(runner),
    'test/run-integration.sh has skip logic again — see the comment above.');

  const composeDir = path.join(REPO, 'test');
  const composes = fs.readdirSync(composeDir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
  assert.ok(composes.length >= 4, `expected the compose suites, found [${composes.join(', ')}]`);
  for (const f of composes) {
    const text = fs.readFileSync(path.join(composeDir, f), 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/run-integration\.sh\s+\S/.test(text),
      `test/${f} passes an argument to run-integration.sh; the runner takes none.`);
  }
});
