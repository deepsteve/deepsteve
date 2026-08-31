// Which daemons are disposable (#678), and — far more importantly — which are not.
//
// The predicate decides whether a daemon may skip the browser auto-open and arm a
// watchdog that shuts it down. A false positive on the user's installed daemon is
// therefore a "your agents died overnight" bug, so most of this file is about the
// no-side of the question. Everything is injected, so these answers hold on the bare CI
// unit job (ubuntu, --ignore-scripts) as much as on the maintainer's Mac.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { disposableDaemon, DEFAULT_PORT } = require('../../disposable');

const HOME = '/Users/dev';
const INSTALL_DIR = path.join(HOME, '.deepsteve');

// The launchd/systemd daemon: real home, default port, running out of its install dir.
function production(over = {}) {
  return {
    testMode: false,
    port: DEFAULT_PORT,
    dirname: INSTALL_DIR,
    stateDir: INSTALL_DIR,
    installSource: { type: 'git', sourcePath: '/Users/dev/github/deepsteve' },
    env: {},
    homedir: HOME,
    userHomedir: HOME,
    ...over,
  };
}

// The thing the issue is about: `PORT=3999 HOME=/tmp/x node server.js` from a checkout.
function adHoc(over = {}) {
  return {
    testMode: false,
    port: 3999,
    dirname: '/Users/dev/github/deepsteve',
    stateDir: '/tmp/scratch/.deepsteve',
    installSource: { type: 'unknown' },
    env: {},
    homedir: '/tmp/scratch',
    userHomedir: HOME,
    ...over,
  };
}

test('the installed daemon is not disposable', () => {
  const v = disposableDaemon(production());
  assert.equal(v.disposable, false);
  assert.equal(v.installed, true);
  assert.deepEqual(v.reasons, []);
});

test('an ad-hoc daemon on a scratch HOME and a custom port is disposable', () => {
  const v = disposableDaemon(adHoc());
  assert.equal(v.disposable, true);
  assert.equal(v.installed, false);
  // Both reasons are reported — the boot log names them, so a surprising
  // "no browser opened" explains itself.
  assert.deepEqual(v.reasons, ['scratch-home', 'non-default-port']);
});

test('each reason is sufficient on its own', () => {
  const cases = [
    ['test-mode', production({ testMode: true, dirname: '/repo' })],
    ['deepsteve-home', production({ env: { DEEPSTEVE_HOME: '/tmp/dh' }, dirname: '/repo' })],
    ['scratch-home', production({ homedir: '/tmp/scratch', dirname: '/repo' })],
    ['non-default-port', production({ port: 3999, dirname: '/repo' })],
  ];
  for (const [reason, args] of cases) {
    const v = disposableDaemon(args);
    assert.equal(v.disposable, true, `${reason} should make a non-installed daemon disposable`);
    assert.ok(v.reasons.includes(reason), `expected reason ${reason}, got ${v.reasons.join(',')}`);
  }
});

test('a developer running the checkout on the default port with a real HOME is untouched', () => {
  // No reasons at all: this is somebody's daily driver started by hand, and it should
  // still open a browser. Being outside the install dir is not by itself suspicious.
  const v = disposableDaemon(production({ dirname: '/Users/dev/github/deepsteve' }));
  assert.equal(v.disposable, false);
  assert.equal(v.installed, false);
  assert.deepEqual(v.reasons, []);
});

// --- the override, which is the whole safety story ---

test('running from the install dir beats every reason', () => {
  // A user who installed on a non-default port (DEEPSTEVE_PORT, which service.sh bakes
  // into the plist / unit) has a production daemon whose port says "throwaway". The
  // install-dir identity is what stops the watchdog from ending their day.
  const v = disposableDaemon(production({ port: 8080 }));
  assert.equal(v.installed, true);
  assert.equal(v.disposable, false);
  assert.deepEqual(v.reasons, ['non-default-port'], 'the reason is still reported, just overridden');
});

test('an npm install identifies itself by packageRoot, not by the state dir', () => {
  const pkgRoot = '/usr/local/lib/node_modules/deepsteve';
  const v = disposableDaemon(production({
    port: 8080,
    dirname: pkgRoot,
    stateDir: INSTALL_DIR,
    installSource: { type: 'npm', packageRoot: pkgRoot },
  }));
  assert.equal(v.installed, true);
  assert.equal(v.disposable, false);
});

test('a non-npm install source does not get the packageRoot override', () => {
  const pkgRoot = '/usr/local/lib/node_modules/deepsteve';
  const v = disposableDaemon(production({
    port: 8080,
    dirname: pkgRoot,
    stateDir: INSTALL_DIR,
    installSource: { type: 'git', packageRoot: pkgRoot },
  }));
  assert.equal(v.installed, false);
  assert.equal(v.disposable, true);
});

test('a missing dirname never counts as installed', () => {
  const v = disposableDaemon(adHoc({ dirname: null, stateDir: null }));
  assert.equal(v.installed, false);
  assert.equal(v.disposable, true);
});

// --- DEEPSTEVE_DISPOSABLE, both directions ---

test('DEEPSTEVE_DISPOSABLE=0 restores canonical behavior on a disposable daemon', () => {
  const v = disposableDaemon(adHoc({ env: { DEEPSTEVE_DISPOSABLE: '0' } }));
  assert.equal(v.disposable, false);
});

test('DEEPSTEVE_DISPOSABLE=1 forces disposable even on the installed daemon', () => {
  const v = disposableDaemon(production({ env: { DEEPSTEVE_DISPOSABLE: '1' } }));
  assert.equal(v.disposable, true);
  assert.ok(v.reasons.includes('forced'));
});

test('an unrecognized DEEPSTEVE_DISPOSABLE value is ignored, not guessed at', () => {
  assert.equal(disposableDaemon(production({ env: { DEEPSTEVE_DISPOSABLE: 'yes' } })).disposable, false);
  assert.equal(disposableDaemon(adHoc({ env: { DEEPSTEVE_DISPOSABLE: '' } })).disposable, true);
});

// --- shape details that have bitten comparable predicates ---

test('a string port compares equal to the numeric default', () => {
  // PORT comes off process.env, so it is always a string; a === comparison here would
  // have made every single daemon in the world disposable.
  assert.deepEqual(disposableDaemon(production({ port: '3000' })).reasons, []);
  assert.ok(disposableDaemon(production({ port: '3999', dirname: '/repo' })).reasons.includes('non-default-port'));
});

test('an unknown home (userInfo threw) is not treated as a scratch home', () => {
  const v = disposableDaemon(production({ userHomedir: null, dirname: '/repo' }));
  assert.deepEqual(v.reasons, [], 'no signal must not become a positive signal');
});

test('the default port matches service.sh DS_DEFAULT_PORT', () => {
  assert.equal(DEFAULT_PORT, 3000);
});

// --- the guard on server.js itself ---

test('openBrowserUrl consults the disposable flag', () => {
  // The pop-a-tab bug is one deleted `if` away from returning, and it returns silently —
  // nothing fails, a tab just appears in someone's browser. Anchor on the declaration
  // (test/unit/source-anchor-guard.test.js bans comment anchors).
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const start = src.indexOf('function openBrowserUrl(');
  assert.ok(start > 0, 'openBrowserUrl not found in server.js');
  const body = src.slice(start, src.indexOf('function deliverToWindow(', start));
  assert.match(body, /if \(DISPOSABLE\)/, 'openBrowserUrl must refuse to open on a disposable daemon');
  assert.match(body, /return;/);
});

test('the idle watchdog is armed only when DISPOSABLE', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  assert.match(src, /if \(DISPOSABLE\) idleWatchdog\.start\(\);/);
});
