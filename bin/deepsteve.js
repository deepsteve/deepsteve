#!/usr/bin/env node
//
// The `deepsteve` CLI — the npm channel's equivalent of `install.sh` (#636/#518).
//
// `npm install -g deepsteve` puts the whole runtime tree in npm's global
// node_modules, which is the wrong place to RUN it from, for three independent
// reasons: server.js mounts `express.static('public')` and `express.static('mods')`
// **cwd-relative**, MODS_DIR/SKILLS_DIR are `__dirname`-relative and are WRITTEN at
// runtime (mod install/uninstall), and a global prefix is frequently root-owned and
// is wiped by `npm update`. So `deepsteve start` deploys the package into
// ~/.deepsteve and starts the daemon there — the same layout install.sh produces,
// with the same `WorkingDirectory` in the service definition.
//
// Everything platform-shaped is delegated to service.sh rather than reimplemented:
// it is the single definition of the launchd plist and the systemd unit (#621), and
// two unit suites diff its output against golden fixtures. This CLI sources the
// PACKAGE's copy of it — the version being deployed — exactly as restart.sh sources
// its own checkout's.
//
// `restart` deliberately goes through the same confirmation handshake as
// ./restart.sh (POST /api/request-restart, or the two-step --force/--prompt echo).
// CLAUDE.md's rule is that a restart can never happen unilaterally; a CLI verb that
// stopped the daemon on its own would be exactly the unguarded second path that rule
// exists to prevent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { stateDir } = require(path.join(PKG_ROOT, 'paths.js'));
const { resolveBinary } = require(path.join(PKG_ROOT, 'bin-path.js'));
const { resolveTmuxPath } = require(path.join(PKG_ROOT, 'tmux-path.js'));

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const DS_DIR = stateDir();
const SERVICE_LIB = path.join(PKG_ROOT, 'service.sh');

// Things that live in the package but must NOT be deployed into ~/.deepsteve.
//
// `bin` is the load-bearing one: a copy of this CLI inside its own deploy target
// would be a second entry point that deploys ~/.deepsteve onto itself. It is the
// same reason restart.sh refuses `cp *.sh` and never lands a copy of itself there.
// The rest is packaging metadata that the daemon never reads.
const DEPLOY_SKIP = new Set(['bin', 'node_modules', 'LICENSE', 'README.md']);

function die(msg, code = 1) {
  process.stderr.write(`deepsteve: ${msg}\n`);
  process.exit(code);
}

function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}

/**
 * Call a ds_* verb from service.sh.
 *
 * `sh -c '. "$1"; shift; "$@"'` sources the library and then invokes the verb with
 * its arguments — no eval of an interpolated string, so a verb name or argument can
 * never be reinterpreted as shell.
 *
 * PATH gets the running node's directory prepended so `ds_node_path`'s
 * `command -v node` fallback resolves the interpreter this CLI is running under. It
 * is only a fallback: ds_node_path still prefers a node already recorded in an
 * existing service definition, which is what stops a redeploy from re-pointing an
 * nvm-pinned install at a version the user may later uninstall.
 */
function ds(verb, args = [], opts = {}) {
  const env = { ...process.env };
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  return execFileSync('sh', ['-c', '. "$1"; shift; "$@"', 'deepsteve', SERVICE_LIB, verb, ...args], {
    encoding: 'utf8',
    env,
    stdio: opts.stdio || ['ignore', 'pipe', 'inherit'],
  });
}

/** A ds_* predicate: exit 0 means true. Never throws. */
function dsTest(verb, args = []) {
  try {
    ds(verb, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A ds_* accessor: one line on stdout, trimmed. '' when it fails. */
function dsValue(verb, args = []) {
  try {
    return String(ds(verb, args)).trim();
  } catch {
    return '';
  }
}

/** A ds_* mutator whose output belongs on the terminal. Returns true on success. */
function dsRun(verb, args = []) {
  try {
    ds(verb, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- control plane

/**
 * The daemon's own bearer token, so our control calls authenticate (#536). The
 * daemon is its sole creator; absent (never booted) means there is no auth to
 * satisfy yet, which is harmless.
 */
function authHeaders() {
  try {
    const tok = fs.readFileSync(path.join(DS_DIR, 'auth-token'), 'utf8').trim();
    if (tok) return { Authorization: `Bearer ${tok}` };
  } catch {}
  return {};
}

/**
 * Plain `localhost`, never deepsteve.localhost: this is non-browser, bearer-authed
 * traffic and must not depend on `*.localhost` resolving (CLAUDE.md #545). The port
 * comes from the installed service definition, which is the real source of truth.
 */
function controlUrl(pathname) {
  const base = dsValue('ds_url') || 'http://localhost:3000';
  return `${base}${pathname}`;
}

async function control(pathname, { method = 'GET', timeoutMs = 10000 } = {}) {
  try {
    const resp = await fetch(controlUrl(pathname), {
      method,
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

async function waitForHealth(seconds = 15) {
  for (let i = 0; i < seconds; i++) {
    const body = await control('/healthz', { timeoutMs: 2000 });
    if (body !== null) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// --------------------------------------------------------------------- deploy

/**
 * Copy a tree, preferring a copy-on-write clone so the ~130MB node_modules costs
 * almost nothing on APFS and btrfs. Both fast paths refuse rather than degrade
 * silently, so a plain fs.cpSync is the fallback on any other filesystem.
 */
function copyTree(src, dest) {
  const clone = process.platform === 'darwin'
    ? ['-Rc', src, dest]
    : ['-a', '--reflink=auto', src, dest];
  if (!fs.existsSync(dest)) {
    const r = spawnSync('cp', clone, { stdio: 'ignore' });
    if (r.status === 0) return;
    // A partial clone would make the fallback copy ambiguous; start clean.
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/**
 * Deploy the package's runtime tree into ~/.deepsteve.
 *
 * Overwrites file by file and never wipes the directory: it also holds state.json,
 * settings.json, contexts.json, the auth token, user-added themes and mods, and
 * every session's scrollback. The prune below is what keeps an upgrade from leaving
 * a removed mod or skill behind, and mirrors restart.sh's rule — a mod carrying a
 * `.source` marker was installed by the user and is never touched.
 */
function deploy() {
  if (path.resolve(PKG_ROOT) === path.resolve(DS_DIR)) {
    die(`the package is installed AT the deploy target (${DS_DIR}); refusing to deploy it onto itself`);
  }
  fs.mkdirSync(DS_DIR, { recursive: true });

  for (const entry of fs.readdirSync(PKG_ROOT, { withFileTypes: true })) {
    if (DEPLOY_SKIP.has(entry.name)) continue;
    const src = path.join(PKG_ROOT, entry.name);
    const dest = path.join(DS_DIR, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // service.sh is a sourced library, never an entry point — that is what keeps
  // `./service.sh restart` from being a second, unguarded way to restart.
  chmodQuiet(path.join(DS_DIR, 'uninstall.sh'), 0o755);
  chmodQuiet(path.join(DS_DIR, 'status.sh'), 0o755);
  chmodQuiet(path.join(DS_DIR, 'service.sh'), 0o644);

  pruneRemoved(path.join(DS_DIR, 'mods'), path.join(PKG_ROOT, 'mods'), name =>
    fs.existsSync(path.join(DS_DIR, 'mods', name, '.source')));
  pruneRemoved(path.join(DS_DIR, 'skills'), path.join(PKG_ROOT, 'skills'), () => false);

  // The daemon creates these on demand, but restart.sh pre-creates them too and a
  // fresh install reads better with them present.
  fs.mkdirSync(path.join(DS_DIR, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(DS_DIR, 'skills'), { recursive: true });
}

function chmodQuiet(p, mode) {
  try { fs.chmodSync(p, mode); } catch {}
}

/**
 * Remove entries the package no longer ships. Without this an upgrade keeps serving
 * a mod that was deleted upstream, and a `maintainer: true` skill that an older git
 * install put in ~/.deepsteve/skills would stay listed in Mods forever — which is
 * exactly the `rm -f` install.sh emits for a withheld skill.
 */
function pruneRemoved(deployedDir, packageDir, isUserOwned) {
  if (!fs.existsSync(deployedDir)) return;
  for (const name of fs.readdirSync(deployedDir)) {
    if (fs.existsSync(path.join(packageDir, name))) continue;
    if (isUserOwned(name)) continue;
    fs.rmSync(path.join(deployedDir, name), { recursive: true, force: true });
  }
}

/**
 * Put the dependency tree next to the deployed server.
 *
 * `npm install -g` has already resolved and built everything — including node-pty,
 * which ships N-API prebuilds for darwin — so copying is strictly better than a
 * second `npm install` in ~/.deepsteve: no network, no compiler, and the deployed
 * tree is exactly the versions this package was published against.
 *
 * Short-circuited on an unchanged package.json, the same way restart.sh skips its
 * reinstall, so a redeploy of the same version costs nothing.
 */
function deployModules() {
  const src = path.join(PKG_ROOT, 'node_modules');
  const dest = path.join(DS_DIR, 'node_modules');
  const stamp = path.join(DS_DIR, 'package.json.prev');
  const current = fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8');

  let unchanged = false;
  try { unchanged = fs.readFileSync(stamp, 'utf8') === current; } catch {}
  if (unchanged && fs.existsSync(dest)) return;

  if (!fs.existsSync(src)) {
    die(`${src} is missing — reinstall with: npm install -g deepsteve`);
  }

  say('Copying dependencies...');
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(src, dest);

  // node-pty's spawn-helper must stay executable. Tolerated rather than required:
  // tmux is the default engine, so an unusable node-pty is degraded, not fatal.
  const helper = path.join(dest, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  chmodQuiet(helper, 0o755);
  chmodQuiet(path.join(dest, 'node-pty', 'build', 'Release', 'spawn-helper'), 0o755);

  fs.writeFileSync(stamp, current);
}

/**
 * Tell the daemon how it was installed, so the Updates panel offers the right thing.
 * Also protective: applyCurlReinstall() refuses to run unless the type is `curl`, so
 * stamping `npm` is what stops an in-app "Update now" from overwriting this install
 * with a curl payload and desyncing it from the npm-managed version.
 */
function stampInstallSource() {
  fs.writeFileSync(path.join(DS_DIR, '.install-source.json'), `${JSON.stringify({
    type: 'npm',
    installedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    installVersion: pkg.version,
    packageRoot: PKG_ROOT,
  }, null, 2)}\n`);
}

/**
 * tmux is a DECLARED dependency off macOS (#620/#621): sessions live inside it so
 * they survive the restarts systemd performs on every crash and upgrade. Fatal here,
 * where a human is watching a terminal, rather than at daemon startup — refusing to
 * boot on a headless box means the UI that would explain why never comes up.
 */
function requireTmux() {
  if (process.platform === 'darwin') return;
  if (resolveTmuxPath({})) return;
  const hint =
    resolveBinary('apt-get') ? 'sudo apt-get install -y tmux' :
    resolveBinary('dnf') ? 'sudo dnf install -y tmux' :
    resolveBinary('pacman') ? 'sudo pacman -S --noconfirm tmux' :
    resolveBinary('apk') ? 'sudo apk add tmux' :
    '(install tmux with your package manager)';
  process.stderr.write(
    'deepsteve: tmux is required on Linux.\n' +
    '       deepsteve runs each session inside tmux so it survives a daemon restart;\n' +
    '       node-pty is a macOS-only fallback. Install tmux and re-run `deepsteve start`:\n' +
    `         ${hint}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------------ MCP

/**
 * Register deepsteve as a global MCP server, idempotently, after the daemon is up so
 * the auth token exists (#536/#538). This is only for `claude`/`opencode` runs
 * OUTSIDE deepsteve — sessions it spawns get their own per-session config.
 */
function registerMcp() {
  const url = dsValue('ds_url') || 'http://localhost:3000';
  const tokenFile = path.join(DS_DIR, 'auth-token');

  const claude = resolveBinary('claude');
  if (claude) {
    let token = '';
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
    const args = ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'deepsteve', `${url}/mcp`];
    if (token) args.push('--header', `Authorization: Bearer ${token}`);
    spawnSync(claude, args, { stdio: 'ignore' });
  }

  const opencode = resolveBinary('opencode');
  if (opencode) {
    const dir = path.join(os.homedir(), '.config', 'opencode');
    const cfgPath = path.join(dir, 'opencode.json');
    try {
      fs.mkdirSync(dir, { recursive: true });
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
      if (!cfg || typeof cfg !== 'object') cfg = { $schema: 'https://opencode.ai/config.json' };
      if (!cfg.mcp) cfg.mcp = {};
      const entry = { type: 'remote', url: `${url}/mcp` };
      // The {file:...} reference makes opencode read the token at its own startup, so
      // the secret never lands in this (non-0600) file and rotation needs no rewrite.
      // opencode errors out at config load on a reference to a missing file.
      //
      // Written as `~/.deepsteve/...` whenever that is where the token actually is, so
      // this and restart.sh/install.sh produce a byte-identical entry and cannot
      // flip-flop the file between them. A DEEPSTEVE_HOME install gets the real path.
      if (fs.existsSync(tokenFile)) {
        const defaultDir = path.join(os.homedir(), '.deepsteve');
        const ref = path.resolve(DS_DIR) === defaultDir ? '~/.deepsteve/auth-token' : tokenFile;
        entry.headers = { Authorization: `Bearer {file:${ref}}` };
      }
      cfg.mcp.deepsteve = entry;
      fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    } catch {}
  }
}

// -------------------------------------------------------------------- commands

async function cmdStart(flags) {
  requireTmux();

  const alreadyRunning = dsTest('ds_is_running');

  deploy();
  deployModules();

  // ds_service_write only when there is nothing there yet: it emits the DEFAULT
  // port rather than reading ds_port, so rewriting an existing definition would
  // silently reset a custom port.
  const servicePath = dsValue('ds_service_path');
  if (!servicePath || !fs.existsSync(servicePath)) {
    if (!dsRun('ds_service_write')) die('could not write the service definition');
  }
  stampInstallSource();

  if (!dsTest('ds_manager_available')) {
    say(`Note: no service manager available. Start manually: node ${path.join(DS_DIR, 'server.js')}`);
    return;
  }

  // An already-running daemon means this is a restart, and a restart is never
  // unilateral — hand off to the same confirmation handshake ./restart.sh uses. The
  // files are already deployed, so a decline just leaves the new version staged.
  if (alreadyRunning) {
    say('deepsteve is already running; the new version is deployed.');
    return cmdRestart(flags);
  }

  dsRun('ds_service_stop');
  if (!dsRun('ds_service_start')) {
    process.stderr.write('deepsteve: the service manager refused to start the daemon. Try:\n');
    dsRun('ds_start_hint');
    process.exit(1);
  }
  // Prints the loginctl enable-linger advice on Linux when lingering is off; never
  // enables it silently, since it writes outside $HOME and prompts over ssh.
  dsRun('ds_maybe_enable_linger');

  const healthy = await waitForHealth(15);
  if (flags.mcp) registerMcp();

  const port = dsValue('ds_port') || '3000';
  say('');
  say(`deepsteve ${pkg.version} installed and running at http://deepsteve.localhost:${port}`);
  if (!healthy) say('(the daemon did not answer /healthz within 15s — check `deepsteve status`)');
  say('To uninstall: deepsteve uninstall');
  say('');
  say(`⚠️  Security: DeepSteve is localhost-only and token-authenticated (${path.join(DS_DIR, 'auth-token')}).`);
  say('   Binding to a network address (--bind) still exposes control to anyone who can reach it.');
}

function cmdStop() {
  if (!dsTest('ds_is_running')) {
    say('deepsteve is not running.');
    return;
  }
  dsRun('ds_service_stop');
  if (!dsRun('ds_wait_stopped', ['15'])) {
    process.stderr.write('deepsteve: the daemon is still running after 15s.\n');
    process.exit(1);
  }
  say('deepsteve stopped.');
}

/**
 * Restart, behind the same guard as ./restart.sh (#504).
 *
 * Default path: the browser is asked to confirm, and the server auto-confirms only
 * when no browser is connected at all. `--force` moves acceptance to whatever prompt
 * is in front of THIS command, in a deliberate two step: print the server-owned
 * blast radius, then re-validate the echoed text so a stale or forged message can't
 * slip through. The session count you approve is always the real one.
 */
async function cmdRestart(flags) {
  if (flags.force) {
    let prompt = await control('/api/restart-prompt');
    // Deterministic text when the daemon is unreachable, so step 1 and step 2 agree.
    if (!prompt) prompt = 'Restarting DeepSteve (daemon not running - no active sessions)';
    const refreshArg = flags.refresh ? ' --refresh' : '';

    if (flags.prompt === null) {
      say(prompt);
      say(`To confirm, run: deepsteve restart --force --prompt "${prompt}"${refreshArg}`);
      return;
    }
    if (flags.prompt !== prompt) {
      say('Confirmation text does not match the current server state.');
      say(prompt);
      say(`Re-run: deepsteve restart --force --prompt "${prompt}"${refreshArg}`);
      process.exit(1);
    }
  } else {
    const body = await control('/api/request-restart', { method: 'POST', timeoutMs: 120000 });
    const result = (body && (body.match(/"result":"([^"]*)"/) || [])[1]) || '';
    if (result !== 'confirmed') {
      // Two causes, indistinguishable from here: the user dismissed the dialog, or
      // nobody answered within the server's 60s timeout.
      say('Restart cancelled.');
      return;
    }
  }

  if (flags.refresh) {
    try { fs.writeFileSync(path.join(DS_DIR, '.reload'), ''); } catch {}
  }
  // Tells the new server this was a restart, so it skips its auto-open-browser timer
  // and doesn't race silently-reconnecting tabs into a phantom new tab.
  try { fs.writeFileSync(path.join(DS_DIR, '.restarting'), ''); } catch {}

  dsRun('ds_service_stop');
  if (!dsRun('ds_wait_stopped', ['15'])) {
    process.stderr.write('deepsteve: the old daemon is still running after 15s; starting anyway.\n');
  }
  if (!dsRun('ds_service_start')) {
    process.stderr.write('deepsteve: the service manager refused to start the daemon. Recover with:\n');
    dsRun('ds_start_hint');
    process.exit(1);
  }
  await waitForHealth(15);
  if (flags.mcp) registerMcp();
  say('deepsteve restarted.');
}

/**
 * Run a deployed entry point through its OWN shebang, never through `sh`.
 *
 * status.sh and uninstall.sh are both `#!/bin/bash` and uninstall.sh uses `&>` — which
 * dash parses as "background, then redirect", silently taking the wrong branch of
 * `if command -v claude &>/dev/null`. On Linux `sh` IS dash, so `sh uninstall.sh` would
 * be quietly wrong in exactly the place it removes things. The deploy chmods both +x,
 * so the kernel picks the right interpreter.
 */
function execDeployed(name) {
  const script = path.join(DS_DIR, name);
  if (!fs.existsSync(script)) return null;
  chmodQuiet(script, 0o755);
  return spawnSync(script, [], { stdio: 'inherit' });
}

/** The deployed status.sh — read-only, and pinned as such by a unit test. */
function cmdStatus() {
  const r = execDeployed('status.sh');
  if (!r) die('not installed yet — run `deepsteve start`');
  process.exit(r.status === null ? 1 : r.status);
}

/**
 * The deployed uninstall.sh, which owns the full teardown: the plist/unit, the log
 * files, and `tmux kill-server` on our own socket BEFORE the directory holding it
 * goes (otherwise the rm only unlinks the socket, leaving panes alive that nothing
 * can ever reach again).
 */
function cmdUninstall() {
  const r = execDeployed('uninstall.sh');
  if (!r) die(`nothing to uninstall — ${DS_DIR} has no uninstall.sh`);
  if (r.status === 0) {
    say('');
    say('The npm package is still installed. Remove it with: npm uninstall -g deepsteve');
  }
  process.exit(r.status === null ? 1 : r.status);
}

function cmdHelp() {
  say(`deepsteve ${pkg.version} — run multiple AI agent sessions in your browser

Usage: deepsteve <command> [options]

Commands:
  start              Deploy to ${DS_DIR}, register the service, and start the daemon
  stop               Stop the daemon (sessions in tmux survive)
  restart            Restart the daemon, after confirming in the browser
  status             Print service state, port, health and log locations
  uninstall          Remove the service, the install dir, and deepsteve's tmux server

Options:
  --refresh          (start/restart) force open browser tabs to reload
  --force            (restart) confirm on this terminal instead of in the browser
  --no-mcp           skip the global claude/opencode MCP registration
  -v, --version      print the version
  -h, --help         print this help

The daemon runs from ${DS_DIR}, not from the npm package: it writes there, and
serving the UI depends on that being its working directory.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = { refresh: false, force: false, prompt: null, mcp: true };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--refresh') flags.refresh = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--prompt') flags.prompt = argv[++i] ?? '';
    else if (a === '--no-mcp') flags.mcp = false;
    else if (a === '-v' || a === '--version') return say(pkg.version);
    else if (a === '-h' || a === '--help') return cmdHelp();
    else positional.push(a);
  }

  switch (positional[0]) {
    case 'start': return cmdStart(flags);
    case 'stop': return cmdStop();
    case 'restart': return cmdRestart(flags);
    case 'status': return cmdStatus();
    case 'uninstall': return cmdUninstall();
    case undefined: return cmdHelp();
    default:
      process.stderr.write(`deepsteve: unknown command "${positional[0]}"\n\n`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch(e => die(e && e.message ? e.message : String(e)));
