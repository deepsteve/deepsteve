// Log hygiene (#557): local ISO-8601 timestamps and in-process log rotation.
//
// launchd (macOS) and systemd's `append:` (Linux) open the log files with
// O_APPEND and hand them to the daemon as fd 1/2, and the service definition
// is only written at install time — existing installs update via git-pull +
// restart and can never receive a new plist. So rotation has to happen from
// inside the daemon, against the fds it already owns: copy the file aside,
// then ftruncate our own fd. With O_APPEND every subsequent write lands at
// the new EOF. The whole rotation is synchronous — Node writes stdout/stderr
// to a file synchronously, so no log line can interleave with (and be lost
// to) the copy→truncate window.
//
// Dependency-free and fully injectable so unit tests can drive
// checkAndRotate() with a fake fs.

const path = require('path');
const os = require('os');

// Local-time ISO-8601 with milliseconds and numeric offset,
// e.g. 2026-07-15T13:01:36.123-07:00 (issue #557: the old [HH:MM:SS.mmm]
// UTC prefix had no date and read as stale/future to a local-time reader).
function formatLogTimestamp(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // getTimezoneOffset() is minutes *behind* UTC: PDT → 420, Kolkata → -330.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
         `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Where the service definition points our stdout/stderr — must mirror
// release.sh's LOG_DIR choices. DEEPSTEVE_LOG_DIR overrides for tests.
// The rotator's inode guard makes a wrong guess harmless: a path whose
// inode doesn't match our actual fd is never touched.
function defaultLogPaths({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const dir = env.DEEPSTEVE_LOG_DIR ||
    (platform === 'darwin'
      ? path.join(homedir, 'Library', 'Logs')
      : path.join(homedir, '.local', 'share', 'deepsteve', 'logs'));
  return [
    { path: path.join(dir, 'deepsteve.log'), fd: 1 },
    { path: path.join(dir, 'deepsteve.error.log'), fd: 2 },
  ];
}

function createLogRotator({
  fs = require('fs'),
  targets = [], // [{ path, fd }]
  maxBytes = 10 * 1024 * 1024,
  checkIntervalMs = 5 * 60 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  warn = console.error,
} = {}) {
  let timer = null;

  function rotateTarget(t) {
    if (t.disabled) return;
    let st, fst;
    try {
      st = fs.statSync(t.path);   // absent in dev/test runs → skip
      fst = fs.fstatSync(t.fd);
    } catch {
      return;
    }
    // Only rotate the file this process is actually writing through that fd.
    // A foreground/dev/test run (fd = tty or pipe) can never truncate a real
    // install's log, and vice versa.
    if (st.ino !== fst.ino || st.dev !== fst.dev) return;
    if (st.size < maxBytes) return;
    try {
      // FICLONE: instant CoW clone on APFS (matters for the first rotation of
      // a years-old multi-hundred-MB log); silently a real copy elsewhere.
      fs.copyFileSync(t.path, t.path + '.1', fs.constants.COPYFILE_FICLONE);
      // ftruncate on our own fd, not truncate on the path: immune to the path
      // being swapped between the stat above and here.
      fs.ftruncateSync(t.fd);
      // Notice goes to the rotated fd itself, so each log records its own
      // rotation — and doubles as the probe for the latch check below.
      fs.writeSync(t.fd, `[${formatLogTimestamp()}] [log-rotate] rotated ${t.path} (${st.size} bytes) → ${t.path}.1\n`);
    } catch (e) {
      warn(`[log-rotate] failed to rotate ${t.path}: ${e.message}`);
      return;
    }
    // If the fd somehow lacks O_APPEND, the write above landed at the old
    // offset and the file snapped back to its old size as a sparse file.
    // Detect that and latch off rather than clone a growing hole every tick.
    try {
      if (fs.statSync(t.path).size >= maxBytes) {
        t.disabled = true;
        warn(`[log-rotate] ${t.path} did not shrink after truncation (fd not O_APPEND?) — disabling rotation for this file`);
      }
    } catch {}
  }

  function checkAndRotate() {
    for (const t of targets) rotateTarget(t);
  }

  return {
    start() {
      if (timer) return;
      checkAndRotate();
      timer = setIntervalFn(checkAndRotate, checkIntervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearIntervalFn(timer); timer = null; }
    },
    checkAndRotate, // exposed for tests
  };
}

module.exports = { formatLogTimestamp, defaultLogPaths, createLogRotator };
