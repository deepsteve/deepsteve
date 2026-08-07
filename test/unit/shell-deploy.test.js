// The shell scripts all drive the daemon through service.sh, and all three deploy
// paths ship the same set of shell files (#621).
//
// Pure file reads — no daemon, no shell, no docker — so this runs in the bare `unit`
// CI job, which is the only CI that runs on the platform these bugs target.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

// These scripts EXPLAIN, in prose, why they no longer call launchctl directly — and
// uninstall.sh's "service.sh is missing" fallback deliberately PRINTS the manual
// launchctl/systemctl commands for the user to run. Neither is the script driving the
// service manager, so neither may trip the assertions below.
//
// So: drop comments, and drop the text of echo/printf lines. What survives is code
// that actually executes. (Same reasoning as compose-projects.test.js's uncommented()
// helper, which exists because those files explain why they have no `ports:` key.)
function executableLines(text) {
  return text.split('\n')
    .map((l) => {
      if (/^\s*#/.test(l)) return '';
      if (/^\s*(echo|printf)\b/.test(l)) return '';
      return l;
    })
    .join('\n');
}

const SCRIPTS = ['release.sh', 'restart.sh', 'uninstall.sh', 'status.sh', 'service.sh'];
const src = {};
for (const s of SCRIPTS) src[s] = fs.readFileSync(path.join(REPO, s), 'utf8');
const code = {};
for (const s of SCRIPTS) code[s] = executableLines(src[s]);

// release.sh is a GENERATOR: the interesting lines are the ones it writes into
// install.sh, and those live inside `echo '...'` — which executableLines() strips.
// This is the complementary view: only what release.sh emits, comments excluded.
const emittedLines = src['release.sh'].split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .filter((l) => /^\s*echo\s+'/.test(l));
const emitted = emittedLines.join('\n');

test('every script this file reasons about actually exists', () => {
  // Without this, a rename turns every assertion below into a vacuous pass.
  for (const s of SCRIPTS) {
    assert.ok(fs.existsSync(path.join(REPO, s)), `${s} is missing`);
  }
});

test('service.sh is the ONLY place that names launchctl or systemctl', () => {
  // The point of #621. Before it, release.sh and uninstall.sh each had their own
  // platform branch and restart.sh had none at all.
  for (const s of ['uninstall.sh', 'status.sh']) {
    assert.ok(!/\b(launchctl|systemctl|loginctl)\b/.test(code[s]),
      `${s} drives the service manager directly — use the ds_* verbs from service.sh`);
  }
  // release.sh generates install.sh, so it must not emit those either.
  assert.ok(!/\b(launchctl|systemctl)\b/.test(code['release.sh']),
    'release.sh still emits raw service-manager commands into install.sh');
});

test('nothing hardcodes the plist or unit path outside service.sh', () => {
  for (const s of ['release.sh', 'uninstall.sh', 'status.sh']) {
    assert.ok(!/LaunchAgents/.test(code[s]), `${s} hardcodes the LaunchAgents path`);
    assert.ok(!/\.config\/systemd/.test(code[s]), `${s} hardcodes the systemd unit path`);
  }
});

test('release.sh no longer emits the plist/unit heredocs', () => {
  // They live in ds_service_write now — one copy, one place to fix.
  assert.ok(!/PLISTEOF/.test(src['release.sh']));
  assert.ok(!/UNITEOF/.test(src['release.sh']));
});

test('release.sh embeds service.sh BEFORE the generated source line', () => {
  // Ordering, in the public-suite-pin.test.js style: install.sh writes service.sh to
  // disk and then sources it, so the embed has to come first or the install dies at
  // `. "$INSTALL_DIR/service.sh"` with no such file.
  // Comments mention ds_service_write while explaining the design, so drop them and
  // match the lines that EMIT, not the first mention.
  const lines = src['release.sh'].split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
  const embed = lines.findIndex((l) => /embed_text "service\.sh"/.test(l));
  const source = lines.findIndex((l) => /echo '\. "\$INSTALL_DIR\/service\.sh"'/.test(l));
  const write = lines.findIndex((l) => /echo 'ds_service_write/.test(l));
  assert.ok(embed >= 0, 'release.sh must embed service.sh');
  assert.ok(source > embed, 'the source line must be emitted after the embed');
  assert.ok(write > source, 'ds_service_write must be called after service.sh is sourced');
});

test('the installer chmods service.sh 644, never +x', () => {
  // The missing exec bit is what makes `./service.sh restart` impossible; an installed
  // copy with one would reintroduce the unguarded restart path on every machine.
  assert.ok(!/chmod \+x[^\n]*service\.sh/.test(emitted),
    'install.sh must not make service.sh executable');
  assert.match(emitted, /chmod 644 "\$INSTALL_DIR\/service\.sh"/);
});

test('uninstall.sh sources service.sh from both places it can run from', () => {
  // It runs as ~/.deepsteve/uninstall.sh (where install.sh and restart.sh put it) and
  // as ./uninstall.sh from a git checkout.
  assert.match(code['uninstall.sh'], /\$SCRIPT_DIR\/service\.sh/);
  assert.match(code['uninstall.sh'], /\$HOME\/\.deepsteve\/service\.sh/);
});

test('uninstall.sh does not carry a duplicate inline teardown', () => {
  // A second copy of the platform branch is exactly the drift #621 removed. When
  // service.sh is missing it must instruct, not improvise.
  assert.ok(!/rm -f .*com\.deepsteve\.plist/.test(code['uninstall.sh']),
    'the fallback must print instructions, not re-implement the teardown');
  assert.match(code['uninstall.sh'], /ds_service_uninstall/);
});

test('uninstall.sh never removes the shared ~/Library/Logs directory', () => {
  // The Linux log dir is ours and can go entirely; ~/Library/Logs belongs to every app
  // on the machine. The rmdir must stay behind the platform check.
  const rmdirLine = code['uninstall.sh'].split('\n').find((l) => /rmdir/.test(l));
  assert.ok(rmdirLine, 'expected an rmdir of the Linux log dir');
  const guard = code['uninstall.sh'].indexOf('ds_platform') !== -1
    && code['uninstall.sh'].indexOf('!= "darwin"') !== -1;
  assert.ok(guard, 'the log-dir rmdir must be guarded by a non-darwin check');
});

test('install.sh is generated, never committed', () => {
  // It is a 3.5MB build artifact; the repo tracks release.sh instead.
  const ignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  assert.match(ignore, /^install\.sh$/m);
});

test('the installer tolerates a node-pty that did not install', () => {
  // install.sh runs under `set -e`; a bare `find <missing dir>` exits nonzero and used
  // to abort the installer BEFORE the service was written, leaving a half-install with
  // no daemon and no explanation. tmux is the default engine since #620, so a missing
  // node-pty is degraded, not fatal.
  const line = code['release.sh'].split('\n').find((l) => /spawn-helper/.test(l));
  assert.ok(line, 'expected the spawn-helper chmod');
  assert.match(line, /\|\| true/, 'the find must not be able to abort the installer');
});

test('the installer tolerates a missing auth token', () => {
  // Same class: `DS_TOKEN=$(cat ...)` under set -e aborts when the daemon has not
  // booted — which is exactly the case (no systemd user bus) where the user most needs
  // to see the "start it manually" instructions the script prints afterwards.
  const line = code['release.sh'].split('\n').find((l) => /DS_TOKEN=\$\(cat/.test(l));
  assert.ok(line, 'expected the DS_TOKEN read');
  assert.match(line, /\|\| true\)/);
});
