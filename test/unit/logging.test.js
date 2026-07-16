// Unit tests for logging.js (#557): local ISO-8601 timestamp formatting and
// the copy→ftruncate log rotator, driven with a fake fs — no real files.
//
// Run: node --test test/unit/logging.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { formatLogTimestamp, defaultLogPaths, createLogRotator } = require('../../logging.js');

// ---------- formatLogTimestamp ----------

const TS_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

test('timestamp has ISO-8601 shape with date, ms, and numeric offset', () => {
  for (const epoch of [0, 1752606096123, Date.now()]) {
    const s = formatLogTimestamp(new Date(epoch));
    assert.match(s, TS_SHAPE, `bad shape for epoch ${epoch}: ${s}`);
  }
});

test('timestamp round-trips to the exact instant in any timezone', () => {
  // Date.parse of a local-time+offset string recovers the epoch iff the
  // offset arithmetic is right — proves correctness in whatever TZ CI uses.
  for (const epoch of [0, 999, 1752606096123, 1735689600000]) {
    const d = new Date(epoch);
    assert.strictEqual(Date.parse(formatLogTimestamp(d)), epoch);
  }
});

test('timestamp offsets in pinned zones (DST, half-hour, UTC)', () => {
  const origTZ = process.env.TZ;
  try {
    const cases = [
      ['America/Los_Angeles', '-07:00', '-08:00'], // PDT July / PST January
      ['Asia/Kolkata', '+05:30', '+05:30'],        // half-hour offset
      ['UTC', '+00:00', '+00:00'],
    ];
    const july = 1752606096123;   // 2025-07-15T19:01:36.123Z
    const january = 1736941296123; // 2025-01-15T11:01:36.123Z
    for (const [tz, julyOff, janOff] of cases) {
      process.env.TZ = tz;
      assert.ok(formatLogTimestamp(new Date(july)).endsWith(julyOff),
        `${tz} July: ${formatLogTimestamp(new Date(july))}`);
      assert.ok(formatLogTimestamp(new Date(january)).endsWith(janOff),
        `${tz} January: ${formatLogTimestamp(new Date(january))}`);
      // Round-trip must hold in the pinned zone too.
      assert.strictEqual(Date.parse(formatLogTimestamp(new Date(july))), july);
    }
  } finally {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  }
});

// ---------- defaultLogPaths ----------

test('defaultLogPaths: darwin → ~/Library/Logs', () => {
  const paths = defaultLogPaths({ platform: 'darwin', env: {}, homedir: '/Users/x' });
  assert.deepStrictEqual(paths, [
    { path: '/Users/x/Library/Logs/deepsteve.log', fd: 1 },
    { path: '/Users/x/Library/Logs/deepsteve.error.log', fd: 2 },
  ]);
});

test('defaultLogPaths: linux → ~/.local/share/deepsteve/logs', () => {
  const paths = defaultLogPaths({ platform: 'linux', env: {}, homedir: '/home/x' });
  assert.strictEqual(paths[0].path, '/home/x/.local/share/deepsteve/logs/deepsteve.log');
  assert.strictEqual(paths[1].path, '/home/x/.local/share/deepsteve/logs/deepsteve.error.log');
});

test('defaultLogPaths: DEEPSTEVE_LOG_DIR overrides the platform dir', () => {
  const paths = defaultLogPaths({ platform: 'darwin', env: { DEEPSTEVE_LOG_DIR: '/scratch/logs' }, homedir: '/Users/x' });
  assert.strictEqual(paths[0].path, '/scratch/logs/deepsteve.log');
  assert.strictEqual(paths[1].path, '/scratch/logs/deepsteve.error.log');
});

// ---------- createLogRotator ----------

const MAX = 1000;

// files: { [path]: { size, ino, dev } }; fds: { [fd]: { ino, dev, path } }.
// `sparse` simulates a non-O_APPEND fd: the post-truncate write lands at the
// old offset, snapping the file back to its old size.
function makeFakeFs({ files = {}, fds = {}, sparse = false } = {}) {
  const calls = [];
  const fileForFd = (fd) => {
    const f = fds[fd];
    if (!f) throw new Error('EBADF');
    return f;
  };
  return {
    constants: { COPYFILE_FICLONE: 2 },
    calls,
    files,
    statSync(p) {
      const f = files[p];
      if (!f) throw new Error(`ENOENT: ${p}`);
      return { size: f.size, ino: f.ino, dev: f.dev };
    },
    fstatSync(fd) {
      const f = fileForFd(fd);
      return { ino: f.ino, dev: f.dev };
    },
    copyFileSync(src, dest, flags) {
      calls.push(['copy', src, dest, flags]);
      files[dest] = { ...files[src] };
    },
    ftruncateSync(fd) {
      calls.push(['ftruncate', fd]);
      const file = files[fileForFd(fd).path];
      file.preTruncateSize = file.size;
      file.size = 0;
    },
    writeSync(fd, data) {
      calls.push(['write', fd, data]);
      const file = files[fileForFd(fd).path];
      file.size = sparse ? file.preTruncateSize + data.length : file.size + data.length;
    },
  };
}

function makeRotator(fakeFs, { targets, ...opts } = {}) {
  const warns = [];
  const rotator = createLogRotator({
    fs: fakeFs,
    targets: targets || [{ path: '/logs/out.log', fd: 1 }],
    maxBytes: MAX,
    warn: (m) => warns.push(m),
    ...opts,
  });
  return { rotator, warns };
}

test('rotator: missing file → no-op', () => {
  const fakeFs = makeFakeFs({ fds: { 1: { ino: 10, dev: 5, path: '/logs/out.log' } } });
  const { rotator, warns } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.deepStrictEqual(fakeFs.calls, []);
  assert.deepStrictEqual(warns, []);
});

test('rotator: bad fd → no-op', () => {
  const fakeFs = makeFakeFs({ files: { '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 } } });
  const { rotator } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.deepStrictEqual(fakeFs.calls, []);
});

test('rotator: inode mismatch (dev run, stdout is not that file) → no-op', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 } },
    fds: { 1: { ino: 99, dev: 5, path: '/logs/out.log' } },
  });
  const { rotator } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.deepStrictEqual(fakeFs.calls, []);
});

test('rotator: device mismatch → no-op', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 } },
    fds: { 1: { ino: 10, dev: 6, path: '/logs/out.log' } },
  });
  const { rotator } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.deepStrictEqual(fakeFs.calls, []);
});

test('rotator: under threshold → no-op', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX - 1, ino: 10, dev: 5 } },
    fds: { 1: { ino: 10, dev: 5, path: '/logs/out.log' } },
  });
  const { rotator } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.deepStrictEqual(fakeFs.calls, []);
});

test('rotator: over threshold → FICLONE copy to .1, ftruncate own fd, notice into rotated file', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX + 500, ino: 10, dev: 5 } },
    fds: { 1: { ino: 10, dev: 5, path: '/logs/out.log' } },
  });
  const { rotator, warns } = makeRotator(fakeFs);
  rotator.checkAndRotate();

  assert.deepStrictEqual(fakeFs.calls[0], ['copy', '/logs/out.log', '/logs/out.log.1', 2]);
  assert.deepStrictEqual(fakeFs.calls[1], ['ftruncate', 1]);
  assert.strictEqual(fakeFs.calls[2][0], 'write');
  assert.strictEqual(fakeFs.calls[2][1], 1);
  assert.match(fakeFs.calls[2][2], /^\[\d{4}-\d{2}-\d{2}T.*\] \[log-rotate\] rotated \/logs\/out\.log \(1500 bytes\) → \/logs\/out\.log\.1\n$/);
  assert.strictEqual(fakeFs.files['/logs/out.log.1'].size, MAX + 500);
  assert.deepStrictEqual(warns, []);

  // Now small again → next tick is a no-op.
  const before = fakeFs.calls.length;
  rotator.checkAndRotate();
  assert.strictEqual(fakeFs.calls.length, before);
});

test('rotator: copy failure warns and skips ftruncate', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 } },
    fds: { 1: { ino: 10, dev: 5, path: '/logs/out.log' } },
  });
  fakeFs.copyFileSync = () => { throw new Error('EACCES'); };
  const { rotator, warns } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /failed to rotate \/logs\/out\.log: EACCES/);
  assert.ok(!fakeFs.calls.some(c => c[0] === 'ftruncate'));
  // Not latched — a transient failure retries next tick.
  rotator.checkAndRotate();
  assert.strictEqual(warns.length, 2);
});

test('rotator: sparse snap-back (fd not O_APPEND) latches the target off', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 } },
    fds: { 1: { ino: 10, dev: 5, path: '/logs/out.log' } },
    sparse: true,
  });
  const { rotator, warns } = makeRotator(fakeFs);
  rotator.checkAndRotate();
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /did not shrink after truncation/);

  // Latched: no further copies or warns on later ticks.
  const before = fakeFs.calls.length;
  rotator.checkAndRotate();
  assert.strictEqual(fakeFs.calls.length, before);
  assert.strictEqual(warns.length, 1);
});

test('rotator: targets are independent', () => {
  const fakeFs = makeFakeFs({
    files: {
      '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 },
      '/logs/err.log': { size: 3, ino: 11, dev: 5 },
    },
    fds: {
      1: { ino: 10, dev: 5, path: '/logs/out.log' },
      2: { ino: 11, dev: 5, path: '/logs/err.log' },
    },
  });
  const { rotator } = makeRotator(fakeFs, {
    targets: [{ path: '/logs/out.log', fd: 1 }, { path: '/logs/err.log', fd: 2 }],
  });
  rotator.checkAndRotate();
  assert.ok(fakeFs.files['/logs/out.log.1']);
  assert.ok(!fakeFs.files['/logs/err.log.1']);
  assert.ok(!fakeFs.calls.some(c => c[0] === 'ftruncate' && c[1] === 2));
});

test('rotator: start() checks immediately, schedules an unref\'d interval; stop() clears it', () => {
  const fakeFs = makeFakeFs({
    files: { '/logs/out.log': { size: MAX + 1, ino: 10, dev: 5 } },
    fds: { 1: { ino: 10, dev: 5, path: '/logs/out.log' } },
  });
  const intervals = [];
  let cleared = null;
  const fakeTimer = { unrefs: 0, unref() { this.unrefs++; } };
  const { rotator } = makeRotator(fakeFs, {
    checkIntervalMs: 12345,
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return fakeTimer; },
    clearIntervalFn: (t) => { cleared = t; },
  });

  rotator.start();
  assert.ok(fakeFs.calls.some(c => c[0] === 'ftruncate')); // immediate check rotated
  assert.strictEqual(intervals.length, 1);
  assert.strictEqual(intervals[0].ms, 12345);
  assert.strictEqual(fakeTimer.unrefs, 1);

  rotator.start(); // idempotent while running
  assert.strictEqual(intervals.length, 1);

  rotator.stop();
  assert.strictEqual(cleared, fakeTimer);
});
