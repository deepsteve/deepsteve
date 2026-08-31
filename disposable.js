// Is this daemon disposable — i.e. NOT the canonical install (#678)?
//
// An agent that starts a second instance to verify a change (`PORT=3999
// HOME=/tmp/x node server.js`, the recipe paths.js itself advertises) used to pop
// a tab in the user's daily browser and then linger forever holding a port, a
// tmux socket and live PTYs. Both were opt-out: the only suppressors were
// DEEPSTEVE_TEST_MODE and the `.restarting` marker, and the failure mode was
// therefore "the agent forgot the flag" — which is not something prose can fix.
// test/run-integration.sh and every integration-standalone startDaemon() remember;
// a hand-started daemon does not, and that is the one a human is sitting in front of.
//
// So the daemon DERIVES the answer instead of being told. Anything disposable logs
// its URL rather than opening one, and arms an idle watchdog. Both are harmless
// defaults for a throwaway, and both would be destructive on a real install — which
// is what the override below exists to make impossible rather than unlikely.
//
// The reasons are deliberately a LIST, not a boolean: the boot log names them, so a
// surprising "no browser opened" explains itself instead of becoming a mystery.
//
// Dependency-free and fully injectable (same shape as paths.js and bin-path.js) so
// the bare CI unit job — which runs --ignore-scripts and has neither node-pty nor
// tmux — can assert the production answers on a machine that is not the maintainer's
// Mac, which is the bug class this predicate is most exposed to. Nothing here may
// require server.js or an engine.

const DEFAULT_PORT = 3000; // mirrors service.sh's DS_DEFAULT_PORT

// os.homedir() honors $HOME; os.userInfo().homedir reads passwd and ignores it.
// Every scratch-HOME daemon in this tree is precisely the case where the two
// disagree, and no production daemon is.
function isScratchHome(homedir, userHomedir) {
  if (!homedir || !userHomedir) return false;
  return String(homedir) !== String(userHomedir);
}

// Can we positively identify this process as the INSTALLED daemon? This is the whole
// safety story: it beats every reason below, so a user who installed on a non-default
// port (DEEPSTEVE_PORT, which service.sh bakes into the launchd plist / systemd unit)
// keeps the canonical behavior. launchd and systemd run ~/.deepsteve/server.js and
// stateDir() is ~/.deepsteve, so the two agree only for the real install; an ad-hoc
// `node server.js` from a checkout never does.
function isInstalledDaemon({ dirname, stateDir, installSource }) {
  if (!dirname) return false;
  if (stateDir && String(dirname) === String(stateDir)) return true;
  // An npm install runs the package's own server.js, so its install dir is the
  // package root rather than the state dir; bin/deepsteve.js stamps that path into
  // .install-source.json at first run.
  if (installSource && installSource.type === 'npm' && installSource.packageRoot
      && String(installSource.packageRoot) === String(dirname)) return true;
  return false;
}

/**
 * -> { disposable: boolean, reasons: string[], installed: boolean }
 *
 * `reasons` is populated even when `installed` overrides them to false, so a caller
 * can log why the question was interesting at all.
 */
function disposableDaemon({
  testMode = false,
  port = DEFAULT_PORT,
  dirname = null,
  stateDir = null,
  installSource = null,
  env = {},
  homedir = null,
  userHomedir = null,
  defaultPort = DEFAULT_PORT,
} = {}) {
  const reasons = [];
  if (testMode) reasons.push('test-mode');
  if (env.DEEPSTEVE_HOME) reasons.push('deepsteve-home');
  if (isScratchHome(homedir, userHomedir)) reasons.push('scratch-home');
  if (Number(port) !== Number(defaultPort)) reasons.push('non-default-port');

  const installed = isInstalledDaemon({ dirname, stateDir, installSource });
  let disposable = reasons.length > 0 && !installed;

  // Escape hatch, in this repo's tradition that an escape hatch only ever WIDENS an
  // allowlist: an explicit answer beats the derivation in both directions. '1' for a
  // developer whose canonical-looking instance really is throwaway, '0' for the
  // reverse. Anything else is ignored rather than guessed at.
  const override = env.DEEPSTEVE_DISPOSABLE;
  if (override === '1') {
    disposable = true;
    if (!reasons.includes('forced')) reasons.push('forced');
  } else if (override === '0') {
    disposable = false;
  }

  return { disposable, reasons, installed };
}

module.exports = { disposableDaemon, DEFAULT_PORT };
