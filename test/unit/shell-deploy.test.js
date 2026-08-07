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
  // platform branch and restart.sh had none at all — which is why restart.sh, and
  // therefore the in-app git-pull auto-update that spawns it, did not work on Linux.
  for (const s of ['restart.sh', 'uninstall.sh', 'status.sh']) {
    assert.ok(!/\b(launchctl|systemctl|loginctl)\b/.test(code[s]),
      `${s} drives the service manager directly — use the ds_* verbs from service.sh`);
  }
  // release.sh generates install.sh, so it must not emit those either.
  assert.ok(!/\b(launchctl|systemctl)\b/.test(code['release.sh']),
    'release.sh still emits raw service-manager commands into install.sh');
});

test('nothing hardcodes the plist or unit path outside service.sh', () => {
  for (const s of ['release.sh', 'restart.sh', 'uninstall.sh', 'status.sh']) {
    assert.ok(!/LaunchAgents/.test(code[s]), `${s} hardcodes the LaunchAgents path`);
    assert.ok(!/\.config\/systemd/.test(code[s]), `${s} hardcodes the systemd unit path`);
  }
});

test('restart.sh no longer probes the port with lsof, or hardcodes 3000', () => {
  // lsof is absent on minimal Linux images; ds_port_in_use uses a node TCP probe, and
  // the port comes from the service definition rather than a literal.
  assert.ok(!/\blsof\b/.test(code['restart.sh']), 'restart.sh still uses lsof');
  assert.ok(!/localhost:3000/.test(code['restart.sh']),
    'restart.sh still hardcodes port 3000 — use $(ds_url) / $(ds_port)');
});

test('restart.sh sources service.sh before the confirm handshake and before any ds_ verb', () => {
  // Ordering matters: a missing or broken library must fail BEFORE the browser is asked
  // to confirm, before .restarting is touched, and before the old daemon is stopped.
  const lines = src['restart.sh'].split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
  const source = lines.findIndex((l) => /^\s*\.\s+"\$SCRIPT_DIR\/service\.sh"/.test(l));
  const guard = lines.findIndex((l) => /! -r "\$SCRIPT_DIR\/service\.sh"/.test(l));
  const firstCurl = lines.findIndex((l) => /\bcurl\b/.test(l));
  const firstVerb = lines.findIndex((l) => /\bds_[a-z_]+\b/.test(l));
  assert.ok(guard >= 0 && guard < source, 'the readability guard must precede the source');
  assert.ok(source >= 0, 'restart.sh must source service.sh');
  assert.ok(source < firstCurl, 'service.sh must be sourced before the first control curl');
  assert.ok(source < firstVerb, 'service.sh must be sourced before the first ds_ verb');
});

test('the shell ship list is the same in restart.sh and release.sh', () => {
  // Three deploy paths (install.sh, restart.sh, and a git checkout) must all leave the
  // same set of shell files in ~/.deepsteve, or uninstall.sh/status.sh end up sourcing a
  // service.sh from a different vintage than the one that wrote the service definition.
  //
  // Asserted rather than globbed because the list must NOT be `*.sh`: restart.sh must
  // never copy itself into its own deploy target, and release.sh is a maintainer tool.
  const rootShellFiles = fs.readdirSync(REPO).filter((f) => f.endsWith('.sh')).sort();
  const expected = rootShellFiles.filter((f) => f !== 'restart.sh' && f !== 'release.sh');
  assert.deepStrictEqual(expected, ['service.sh', 'status.sh', 'uninstall.sh'],
    'a new root *.sh appeared — decide deliberately whether it ships, then update this list');

  const cpLine = code['restart.sh'].split('\n').find((l) => /^\s*cp .*~\/\.deepsteve\/$/.test(l) && /\.sh/.test(l));
  assert.ok(cpLine, 'restart.sh must copy the shell files');
  for (const f of expected) {
    assert.ok(cpLine.includes(f), `restart.sh does not deploy ${f}`);
    assert.ok(new RegExp(`embed_text "${f.replace('.', '\\.')}"`).test(src['release.sh']),
      `release.sh does not embed ${f}`);
  }
  assert.ok(!/\bcp \*\.sh\b/.test(code['restart.sh']),
    'must not be a glob — restart.sh would copy itself into its own deploy target');
});

test('restart.sh deploys service.sh non-executable', () => {
  assert.match(code['restart.sh'], /chmod 644 ~\/\.deepsteve\/service\.sh/);
  assert.ok(!/chmod \+x[^\n]*\bservice\.sh/.test(code['restart.sh']));
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

test('release.sh contains no BSD-only sed, so it runs on Linux too', () => {
  // `sed -i ''` is BSD syntax; GNU sed reads the '' as the script and the real script
  // as a filename. It is why check-installer.yml is pinned to macos-latest and why a
  // Linux contributor could not run `npm run test:install` (which starts with
  // `bash release.sh`). The five calls are gone, not ported — the constants they
  // substituted are emitted directly from an unquoted heredoc instead.
  assert.ok(!/sed -i ''/.test(code['release.sh']), "release.sh still uses BSD `sed -i ''`");
  assert.ok(!/__NODE_[A-Z0-9_]*__/.test(src['release.sh']),
    'the placeholder tokens went with the sed calls');
});

test('release.sh emits the pinned node constants directly', () => {
  // The replacement for the placeholders: an unquoted heredoc that expands at
  // generation time. If this regressed to a quoted one, install.sh would ship the
  // literal variable names and every fresh install would fail its checksum check.
  assert.match(src['release.sh'], /cat > "\$OUT" << EOF\n#!\/bin\/bash/,
    'the constants heredoc must be UNQUOTED (<< EOF, not << \'EOF\')');
  assert.match(src['release.sh'], /^NODE_VERSION="\$NODE_VERSION"$/m);
});

test('base64 embedding is wrapped identically on macOS and Linux', () => {
  // macOS base64 emits one unwrapped line, GNU wraps at 76. `base64 -d` reads both, so
  // this was never a correctness bug — but it made the generated install.sh
  // byte-different depending on which OS built it, which defeats any reproducibility
  // check. Now that release.sh runs on both, normalize.
  const line = code['release.sh'].split('\n').find((l) => /^\s*base64 </.test(l));
  assert.ok(line, 'expected the base64 embed');
  assert.match(line, /tr -d '\\n' \| fold -w 76/);
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
