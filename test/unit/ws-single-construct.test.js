// Source-shape guard: the client constructs a WebSocket in exactly one place (#674).
//
// Why a source guard rather than a behavioural one. Firefox keys its RFC 6455 FailDelay
// entry on {address, path, port, originSuffix}, and `path` comes from GetFilePath(), which
// EXCLUDES the query string. Every DeepSteve socket is ws://host/?params, so all of them
// share ONE browser-global entry — across tabs, windows and nested Baby Browser instances.
// Each failed handshake ramps it x1.5 to a 60s cap, a delayed socket is parked in
// CONNECTING_DELAYED with no traffic and no error event, and the entry outlives any usable
// retry interval. One socket anywhere poisons all of them and no backoff can undo it.
//
// That is a whole-tree property, and it kept getting broken one call site at a time. #553
// gave ws-client.js a /healthz gate and left live-reload.js's first connect() ungated.
// #674 then found that same module re-entering connect() with no delay at all, so a
// cookie the server was rejecting produced a fresh doomed handshake every fetch round
// trip. Both were written by people who knew the rule. A behavioural test on the modules
// that exist today would not have caught either, because the bug is always in the module
// nobody thought to test — so this asserts the shape of the tree instead.
//
// Pure file reads — no server, no browser, no shell. Runs in the bare `unit` CI job.
//
// Run: node --test test/unit/ws-single-construct.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OWNER = 'ws-open.js';

// Deliberately not scanning mods/. A mod runs in a nested realm that shares the same
// FailDelay entry, so the rule applies to it too — but mods are agent- and user-authored
// and a guard here would fail on somebody else's file. None construct a socket today
// (browser-console.jsx wraps the constructor as `new OrigWebSocket(...)`, which the
// pattern below deliberately does not match); docs/frontend.md carries the rule for them.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

// The prose in ws-client.js's header quotes `new WebSocket(url)` when describing the loop
// it replaced, and would otherwise fail this guard against the very file it blesses. A
// reworded comment must never be able to flip the result either way.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const CONSTRUCT = /\bnew\s+WebSocket\s*\(/;

function offenders() {
  return walk(PUBLIC_DIR)
    .filter(f => CONSTRUCT.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map(f => path.relative(ROOT, f))
    .sort();
}

test('the WebSocket constructor appears in exactly one file under public/', () => {
  const found = offenders();

  // Non-vacuity first: a zero here means the pattern stopped matching and every assertion
  // in this file silently became a no-op.
  assert.ok(found.length >= 1,
    'found no `new WebSocket(` anywhere under public/ — the pattern has drifted and this guard is now asserting nothing');

  assert.deepStrictEqual(found, [path.join('public', 'js', OWNER)],
    `every WebSocket must be constructed by openGatedSocket() in public/js/${OWNER}.\n` +
    `Extra construction sites found: ${found.join(', ')}\n\n` +
    'A handshake emitted without the gate arms a FailDelay entry shared by EVERY socket in ' +
    'the browser, parking them all in CONNECTING for up to 60s with no error event, and no ' +
    'retry schedule can dig them out (#553, #674). Route the new socket through ' +
    'openGatedSocket(url, { shouldStop, label }) instead.');
});

test('the gate runs before the construction, not beside it', () => {
  const src = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, 'js', OWNER), 'utf8'));
  const construct = src.search(CONSTRUCT);
  const healthz = src.indexOf('await waitForServer(');
  const auth = src.indexOf('await maybeHealAuth(');

  assert.ok(healthz >= 0 && auth >= 0,
    `public/js/${OWNER} must await BOTH halves of the gate: waitForServer() for "is the server up" ` +
    'and maybeHealAuth() for "will it accept our cookie". /healthz is unauthenticated, so it ' +
    'says nothing about whether verifyWsClient will 401 the upgrade — and the browser reports ' +
    'that 401 as close code 1006, indistinguishable from "server down".');

  assert.ok(healthz < construct && auth < construct,
    `public/js/${OWNER} constructs its socket before awaiting the gate. Keeping the one ` +
    'construction site while dropping the gate in front of it would pass the first test in ' +
    'this file and restore the whole bug (#674).');
});

test('both socket owners route through the choke point', () => {
  for (const f of ['ws-client.js', 'live-reload.js']) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, 'js', f), 'utf8');
    assert.match(src, /from\s+['"]\.\/ws-open\.js['"]/,
      `public/js/${f} no longer imports ws-open.js. If it stopped opening sockets that is ` +
      'fine — delete this line. If it grew its own, that is the regression this file exists for.');
  }
});
