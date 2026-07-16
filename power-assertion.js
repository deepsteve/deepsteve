// macOS power assertion held while sessions are active (#563).
//
// The daemon's availability must not depend on the user keeping a manual
// `caffeinate` tab alive: while any session is open we hold our own
// PreventUserIdleSystemSleep assertion by spawning `caffeinate -i -w <our pid>`.
// -i blocks idle sleep only — closing the lid still sleeps the machine, which is
// deliberate. -w ties the assertion to our pid, so caffeinate exits on its own
// if the daemon dies without cleaning up.
//
// Reconcile-style API: callers invoke sync() whenever the desired state may have
// changed (a periodic tick is fine); sync() compares isWanted() against whether
// a child is running and spawns or kills accordingly. Fully injectable for unit
// tests.

function createPowerAssertion({
  spawn = require('child_process').spawn,
  platform = process.platform,
  pid = process.pid,
  isWanted = () => false,
  log = console.log,
} = {}) {
  let child = null;
  let spawnFailed = false; // latch: don't retry-spam after ENOENT
  let wasWanted = false;
  let disposed = false;

  function acquire() {
    let c;
    try {
      c = spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
    } catch (e) {
      spawnFailed = true;
      log(`[power] failed to spawn caffeinate: ${e.message}`);
      return;
    }
    c.on('error', (e) => {
      spawnFailed = true;
      if (child === c) child = null;
      log(`[power] caffeinate error: ${e.message}`);
    });
    c.on('exit', (code, signal) => {
      if (child !== c) return; // an old child we already replaced/released
      child = null;
      // We didn't kill it and still want it → unexpected death; next sync() respawns.
      if (!disposed) log(`[power] caffeinate exited (code=${code}, signal=${signal})`);
    });
    child = c;
    log(`[power] sleep assertion acquired (caffeinate -i, pid ${c.pid})`);
  }

  function release() {
    if (!child) return;
    const c = child;
    child = null; // clear first so the exit handler knows this was deliberate
    try { c.kill('SIGTERM'); } catch {}
    log('[power] sleep assertion released');
  }

  return {
    sync() {
      if (disposed || platform !== 'darwin') return;
      const wanted = isWanted();
      // Re-arm the ENOENT latch once per false→true want transition.
      if (wanted && !wasWanted) spawnFailed = false;
      wasWanted = wanted;
      if (wanted && !child && !spawnFailed) acquire();
      else if (!wanted && child) release();
    },
    dispose() {
      disposed = true;
      release();
    },
    isHolding() { return !!child; },
  };
}

module.exports = { createPowerAssertion };
