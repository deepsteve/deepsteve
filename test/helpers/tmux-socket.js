/**
 * Isolated tmux for a test suite — by explicit socket path, never by environment.
 *
 * WHY THIS EXISTS. A standalone suite has to talk to tmux without touching the
 * developer's own sessions. The obvious mechanism, `TMUX_TMPDIR`, is a TRAP: tmux
 * treats it as a hint and SILENTLY falls back to `/tmp/tmux-<uid>/default` — the
 * real per-UID socket — whenever it cannot use that directory. So the failure is
 * invisible and total: `kill-server` lands on the developer's server and every live
 * agent on the box dies at once.
 *
 * That is not hypothetical. It happened three times in one morning while building
 * #624, and the hole was two lines wide: before() assigned the tmpdir path, then
 * mkdir'd it on a LATER line, and after() ran regardless. Anything throwing in
 * between — or a before() timeout — left the variable set and the directory absent,
 * which is precisely the fallback condition. A guard that only checked the path
 * *string* sailed straight through it.
 *
 * THE FIX IS THE FLAG, NOT THE CHECK. Every tmux invocation here passes
 * `-S <absolute socket>`. `-S` has no fallback path: tmux either uses that socket or
 * fails. The environment stops being load-bearing, so the whole class of "it
 * silently used a different socket" is unrepresentable rather than merely unlikely.
 * The assertions below are a second line of defence, not the first.
 *
 * `TMUX_TMPDIR` is still handed to the DAEMON under test, because the engine has no
 * -S plumbing — but `createIsolatedTmux()` creates the directory up front, in the
 * same call that names it, so the daemon has no fallback condition to hit either.
 *
 * No coupling to ws-client.js or DEEPSTEVE_URL — this is usable from any suite.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Name AND create a suite's private tmux socket directory, in one call.
 *
 * One call on purpose: the destructive bug was a window between naming and
 * creating, so the API makes that window impossible to open. Returns
 * `{ tmpRoot, tmuxTmp, socket }` — pass `tmuxTmp` to the daemon as `TMUX_TMPDIR`
 * and `socket` (via this module) to every tmux command the test runs itself. The
 * two agree by construction: `<tmuxTmp>/tmux-<uid>/default` is exactly the path
 * tmux derives from TMUX_TMPDIR, so the suite and its daemon share one server.
 */
function createIsolatedTmux(tmpRoot) {
  if (typeof tmpRoot !== 'string' || !path.isAbsolute(tmpRoot)) {
    throw new Error(`createIsolatedTmux needs an absolute tmpRoot, got ${tmpRoot}`);
  }
  const tmuxTmp = path.join(tmpRoot, 'tmux-tmp');
  const dir = path.join(tmuxTmp, `tmux-${process.getuid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // chmod after the fact because mkdir's mode is masked by umask, and tmux refuses
  // a socket directory that is group- or world-accessible (it would fall back).
  fs.chmodSync(tmuxTmp, 0o700);
  fs.chmodSync(dir, 0o700);
  return { tmpRoot, tmuxTmp, socket: path.join(dir, 'default') };
}

/**
 * Assert an isolation handle is one we may point tmux at. Throws, loudly.
 *
 * Checks the socket is inside the suite's own tmpRoot AND that its parent directory
 * exists right now — the second is what the old string-only guard was missing, and
 * it is the exact state that made tmux fall back.
 */
function assertIsolated(iso) {
  if (!iso || typeof iso.socket !== 'string' || typeof iso.tmpRoot !== 'string' || !iso.tmpRoot) {
    throw new Error(`refusing to run tmux without an isolation handle (got ${JSON.stringify(iso)})`);
  }
  if (!iso.socket.startsWith(iso.tmpRoot + path.sep)) {
    throw new Error(`refusing to run tmux: socket ${iso.socket} is outside ${iso.tmpRoot}`);
  }
  const dir = path.dirname(iso.socket);
  if (!fs.existsSync(dir)) {
    throw new Error(`refusing to run tmux: socket dir ${dir} does not exist — tmux would ` +
      `silently fall back to the real per-UID socket`);
  }
  return iso.socket;
}

/** Run tmux against the suite's own socket. Never inherits a socket from anywhere. */
function runTmux(bin, iso, args, opts = {}) {
  if (!bin) throw new Error('runTmux called with no tmux binary');
  const socket = assertIsolated(iso);
  return execFileSync(bin, ['-S', socket, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: 'pipe',
    ...opts,
  }).trim();
}

/**
 * Reap the suite's tmux server, if and only if it can prove one is ours.
 *
 * Shutdown DETACHES rather than kills (#620), so a suite's scratch tmux server
 * outlives its daemon and something has to reap it. But "clean up" must never
 * become "clean up whatever tmux happens to find": no socket FILE at our path means
 * there is no server of ours, so there is nothing to do. Returns true if it killed
 * something. Never throws — cleanup runs in `after()`, where a throw masks the real
 * test failure.
 */
function reapTmuxServer(bin, iso) {
  try {
    if (!bin) return false;
    const socket = assertIsolated(iso);
    // The last word before something destructive: the path really is ours.
    if (!socket.startsWith(iso.tmpRoot + path.sep)) {
      throw new Error(`refusing to kill-server on ${socket}`);
    }
    if (!fs.existsSync(socket)) return false; // no server of ours ever started
    runTmux(bin, iso, ['kill-server']);
    return true;
  } catch {
    return false;
  }
}

module.exports = { createIsolatedTmux, assertIsolated, runTmux, reapTmuxServer };
