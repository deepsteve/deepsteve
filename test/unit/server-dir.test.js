// Behaviour of test/helpers/server-dir.js — the #637 helper that decides whether a path
// this process creates will also exist for the daemon under test.
//
// Its sibling test/unit/integration-scratch-guard.test.js is a static scan of the tree;
// this file is the other half, and exercises the decision itself. That decision has two
// failure modes with very different costs, which is why it is tested rather than merely
// read: a wrong "local" hands back a directory the daemon cannot see and reproduces #637
// exactly, while a wrong "remote" throws at a developer whose daemon really is on this
// machine and sends them looking for a mount problem they do not have.
//
// Both DEEPSTEVE_URL and DEEPSTEVE_TEST_SCRATCH are read at CALL time, not at require()
// time, so every case here sets them and restores them afterward.
//
// Pure Node builtins — no node-pty, no daemon — so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/server-dir.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  makeServerDir, reserveMissingServerPath, removeServerDir, scratchRoot, daemonIsLocal,
} = require('../helpers/server-dir');

/** Run fn with the two env vars forced to given values ('' means unset). */
function withEnv({ url, scratch }, fn) {
  const saved = {
    url: process.env.DEEPSTEVE_URL,
    scratch: process.env.DEEPSTEVE_TEST_SCRATCH,
  };
  try {
    if (url === undefined) delete process.env.DEEPSTEVE_URL;
    else process.env.DEEPSTEVE_URL = url;
    if (scratch === undefined) delete process.env.DEEPSTEVE_TEST_SCRATCH;
    else process.env.DEEPSTEVE_TEST_SCRATCH = scratch;
    return fn();
  } finally {
    if (saved.url === undefined) delete process.env.DEEPSTEVE_URL;
    else process.env.DEEPSTEVE_URL = saved.url;
    if (saved.scratch === undefined) delete process.env.DEEPSTEVE_TEST_SCRATCH;
    else process.env.DEEPSTEVE_TEST_SCRATCH = saved.scratch;
  }
}

// --- daemonIsLocal ------------------------------------------------------------

test('daemonIsLocal: no target yet means local', () => {
  // run-integration.sh provisions a daemon on this machine when DEEPSTEVE_URL is unset,
  // so "unset" is genuinely local rather than merely unknown.
  assert.strictEqual(withEnv({ url: undefined }, daemonIsLocal), true);
});

test('daemonIsLocal: loopback in every spelling', () => {
  for (const url of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.2:3000',   // the whole 127.0.0.0/8 block is loopback
    'http://127.1.2.3:9999',
    'http://[::1]:3000',
    'https://LOCALHOST:3000',  // hostname comparison is case-insensitive
  ]) {
    assert.strictEqual(withEnv({ url }, daemonIsLocal), true, `${url} is this machine`);
  }
});

test('daemonIsLocal: the .localhost TLD is loopback (RFC 6761)', () => {
  // deepsteve.localhost is this project's canonical browser host, so this is the spelling
  // a developer is most likely to reach for by hand.
  assert.strictEqual(withEnv({ url: 'http://deepsteve.localhost:3000' }, daemonIsLocal), true);
  assert.strictEqual(withEnv({ url: 'http://anything.deepsteve.localhost' }, daemonIsLocal), true);
});

test('daemonIsLocal: a real remote target is not local', () => {
  for (const url of [
    'http://server:3000',        // the compose hostname — the case #637 was about
    'http://192.168.1.50:3000',
    'http://10.0.0.4:3000',
    'https://example.com',
    'http://notlocalhost:3000',  // must not match on a suffix-free substring
    'http://localhost.evil.com', // .localhost has to be the TLD, not a label
  ]) {
    assert.strictEqual(withEnv({ url }, daemonIsLocal), false, `${url} is not this machine`);
  }
});

test('daemonIsLocal: an unparseable URL is treated as remote, not local', () => {
  // Fail closed. A wrong "local" is the bug this helper exists to prevent; a wrong
  // "remote" is only an explanation the reader can act on.
  assert.strictEqual(withEnv({ url: 'not a url' }, daemonIsLocal), false);
});

// --- scratchRoot --------------------------------------------------------------

test('scratchRoot: DEEPSTEVE_TEST_SCRATCH wins, even when the daemon is remote', () => {
  // This is the CI path exactly: a second container, plus a mount shared with it.
  assert.strictEqual(
    withEnv({ url: 'http://server:3000', scratch: '/scratch' }, scratchRoot),
    '/scratch');
});

test('scratchRoot: falls back to os.tmpdir() only when the daemon is this machine', () => {
  assert.strictEqual(
    withEnv({ url: 'http://127.0.0.1:3000', scratch: undefined }, scratchRoot),
    os.tmpdir());
});

test('scratchRoot: throws, rather than guessing, for a remote daemon with no shared mount', () => {
  assert.throws(
    () => withEnv({ url: 'http://server:3000', scratch: undefined }, scratchRoot),
    err => {
      // The whole point of the throw is that it names the fix. An error that merely
      // said "failed" would leave the reader where #637 left its author: an assertion
      // four lines later, with nothing pointing at the filesystem.
      assert.match(err.message, /DEEPSTEVE_TEST_SCRATCH/);
      assert.match(err.message, /http:\/\/server:3000/);
      assert.match(err.message, /docker-compose\.yml/);
      return true;
    });
});

test('scratchRoot: the throw happens at call time, not at require() time', () => {
  // Deliberate design: an unrelated suite that requires this module for removeServerDir
  // must not explode on import just because it has no shared mount configured.
  withEnv({ url: 'http://server:3000', scratch: undefined }, () => {
    const mod = require.resolve('../helpers/server-dir');
    delete require.cache[mod];
    assert.doesNotThrow(() => require('../helpers/server-dir'));
    delete require.cache[mod];
  });
});

// --- makeServerDir / reserveMissingServerPath ---------------------------------

test('makeServerDir: creates a real directory under the scratch root', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-server-dir-test-'));
  try {
    const dir = withEnv({ url: 'http://server:3000', scratch }, () => makeServerDir('ds-case-'));
    assert.ok(dir.startsWith(scratch), `${dir} must live under the configured root`);
    assert.ok(fs.statSync(dir).isDirectory(), 'and must actually exist');
    assert.match(path.basename(dir), /^ds-case-/, 'the prefix is honoured');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('makeServerDir: creates the scratch root if the mount is empty', () => {
  // The ds_scratch volume starts empty, and on a fresh CI run nothing has made
  // subdirectories in it yet.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-server-dir-test-'));
  const scratch = path.join(parent, 'not', 'yet', 'there');
  try {
    const dir = withEnv({ url: 'http://server:3000', scratch }, () => makeServerDir());
    assert.ok(fs.statSync(dir).isDirectory());
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('reserveMissingServerPath: the path is gone but its parent is writable', () => {
  // This is the property that stops "a missing cwd is refused" from passing vacuously:
  // the refusal must be about THIS path, not about the whole scratch root being absent.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-server-dir-test-'));
  try {
    const gone = withEnv({ url: 'http://server:3000', scratch },
      () => reserveMissingServerPath('ds-gone-'));
    assert.strictEqual(fs.existsSync(gone), false, 'the reserved path must not exist');
    assert.ok(fs.statSync(path.dirname(gone)).isDirectory(),
      'but its parent must, or the test proves nothing about the path itself');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('removeServerDir: cleans up, and never throws on an already-gone path', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-server-dir-test-'));
  try {
    const dir = withEnv({ url: 'http://server:3000', scratch }, () => makeServerDir());
    fs.writeFileSync(path.join(dir, 'child.txt'), 'x'); // non-empty: rm must be recursive
    removeServerDir(dir);
    assert.strictEqual(fs.existsSync(dir), false);
    // Safe in an afterEach that runs after a test already cleaned up.
    assert.doesNotThrow(() => removeServerDir(dir));
    assert.doesNotThrow(() => removeServerDir(path.join(scratch, 'never-existed')));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
