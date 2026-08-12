// Scratch directories that the DAEMON UNDER TEST can actually see.
//
// The build guard for #637. `test/integration/**` runs against a daemon reached over
// DEEPSTEVE_URL, and that daemon does not necessarily share a filesystem with this
// process. In CI it definitely does not: test/docker-compose.yml runs `server` and
// `test` as two containers whose only shared mount was ds_home:/root/.deepsteve, so a
// path from os.tmpdir() exists in the test container and nowhere else.
//
// That asymmetry was invisible until #632 taught the server to REFUSE a spawn into a
// missing cwd. Before it, tmux silently relocated the pane to $HOME and the spawn
// "worked", so a test could hand over a directory the server had never heard of and
// still pass. #632's own integration test then did exactly that — `fs.mkdtempSync`,
// hand the path over, expect a session — and it passed locally (npm test provisions a
// daemon on this machine, sharing /tmp) while failing every CI run for two days.
//
// So the rule is: an integration test never invents a path for the server out of
// os.tmpdir(). It asks here, and the answer is correct under both topologies.
//
//   DEEPSTEVE_TEST_SCRATCH set → a directory mounted into BOTH containers (compose
//                                sets it to /scratch and mounts ds_scratch there).
//   unset, daemon is local     → os.tmpdir(), which genuinely is shared.
//   unset, daemon is remote    → throw, rather than hand back a path that will fail
//                                an assertion four lines later with no hint why.
//
// Run: node --test test/unit/server-dir.test.js test/unit/integration-scratch-guard.test.js
//      (the first exercises this decision; the second is the static ban on bypassing it)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Hostnames that mean "the daemon is this machine, so os.tmpdir() is shared".
 *
 * Errs toward `false`: a wrong `true` hands back a path the daemon cannot see and we are
 * back to #637, while a wrong `false` throws an explanation the reader can act on.
 */
function daemonIsLocal() {
  const raw = process.env.DEEPSTEVE_URL;
  if (!raw) return true; // no target yet — run-integration.sh provisions one locally
  let host;
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return false; }
  // RFC 6761 §6.3 reserves the .localhost TLD to loopback, and deepsteve.localhost is this
  // project's canonical browser host — matching only the bare name told a developer who
  // used it that their daemon was "not this machine", sending them after a mount problem
  // they did not have.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // `[::1]` is what WHATWG URL.hostname returns for IPv6 loopback (brackets retained);
  // the bare form is kept for a caller that passes a hostname rather than a URL.
  return LOOPBACK_V4.test(host) || host === '[::1]' || host === '::1';
}

/**
 * The root every scratch directory is created under, or a thrown explanation.
 *
 * Deliberately a function, not a module-level constant: the throw must land in the
 * test that asked, not at require() time in an unrelated file that merely imports
 * this module for its sibling export.
 */
function scratchRoot() {
  const explicit = process.env.DEEPSTEVE_TEST_SCRATCH;
  if (explicit) return explicit;
  if (daemonIsLocal()) return os.tmpdir();
  throw new Error(
    `server-dir: DEEPSTEVE_URL is ${process.env.DEEPSTEVE_URL}, which is not this machine, `
    + 'but DEEPSTEVE_TEST_SCRATCH is unset. A directory made here would not exist for the '
    + 'daemon, and the spawn would be refused with cwd-missing (#632/#637). Set '
    + 'DEEPSTEVE_TEST_SCRATCH to a path mounted into both — see test/docker-compose.yml.');
}

/**
 * A directory that exists, for both this process and the daemon.
 * Caller owns cleanup; `removeServerDir` is the other half.
 */
function makeServerDir(prefix = 'ds-test-') {
  const root = scratchRoot();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

/**
 * A path that provably does NOT exist, for either of us.
 *
 * Made by creating and removing a real directory rather than joining a random suffix:
 * that proves the parent is writable and shared, so a test asserting "missing cwd is
 * refused" cannot pass merely because the whole scratch root was absent.
 */
function reserveMissingServerPath(prefix = 'ds-test-gone-') {
  const dir = makeServerDir(prefix);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** Best-effort cleanup; never throws, so it is safe in an afterEach. */
function removeServerDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

module.exports = { makeServerDir, reserveMissingServerPath, removeServerDir, scratchRoot, daemonIsLocal };
