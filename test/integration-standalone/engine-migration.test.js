/**
 * Standalone engine default / migration-offer tests (#620).
 *
 * Cheap and session-free: each case boots a throwaway daemon against a scratch
 * $HOME with a pre-seeded settings.json, then reads /api/engines.
 *
 * What it proves:
 *   - An EXISTING install (explicit "engine": "node-pty" on disk) is offered the
 *     migration rather than flipped behind its back. This is the case the schema
 *     default cannot reach: saveSettings() writes the whole settings object, so
 *     every install that ever saved settings pins node-pty explicitly.
 *   - Either answer latches, survives a restart, and is not asked again.
 *   - "migrate" actually moves the setting; "keep" actually leaves it alone.
 *   - With no usable tmux the daemon downgrades to node-pty, persists it, reports
 *     tmuxAvailable:false with a reason naming where it looked, and does NOT offer
 *     a migration to an engine that isn't there.
 *
 * Skips itself when tmux is not installed.
 *
 * Run: node --test --test-timeout=120000 test/integration-standalone/engine-migration.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let TMUX_BIN = null;
try { TMUX_BIN = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim() || null; } catch {}
const SKIP = TMUX_BIN ? false : 'tmux is not installed';

let tmpRoot;
const running = []; // every daemon we start, so `after` can guarantee teardown

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(check, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let r; try { r = await check(); } catch { r = null; }
    if (r) return r;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/**
 * A disposable daemon on its own $HOME. `settings` is written to
 * ~/.deepsteve/settings.json before boot, which is how we stand up an "existing
 * install" that predates the default flip.
 */
function makeInstall(name, settings) {
  const HOME = path.join(tmpRoot, name);
  const tmuxTmp = path.join(HOME, 'tmux-tmp');
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(HOME, 'bin', 'open'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), ''); // no browser auto-open
  if (settings) {
    fs.writeFileSync(path.join(HOME, '.deepsteve', 'settings.json'), JSON.stringify(settings, null, 2));
  }

  const inst = {
    HOME, tmuxTmp, proc: null, port: null, base: null, log: '',
    token() {
      try { return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim(); }
      catch { return ''; }
    },
    headers() { const t = inst.token(); return t ? { Authorization: `Bearer ${t}` } : {}; },
    settingsOnDisk() {
      return JSON.parse(fs.readFileSync(path.join(HOME, '.deepsteve', 'settings.json'), 'utf8'));
    },
    async engines() {
      return (await fetch(`${inst.base}/api/engines`, { headers: inst.headers() })).json();
    },
    async decide(decision) {
      const r = await fetch(`${inst.base}/api/engine-migration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...inst.headers() },
        body: JSON.stringify({ decision }),
      });
      return { status: r.status, body: await r.json() };
    },
    async start() {
      inst.port = inst.port || await freePort();
      inst.base = `http://127.0.0.1:${inst.port}`;
      const env = { ...process.env, HOME, PORT: String(inst.port) };
      delete env.CLAUDECODE;
      for (const k of Object.keys(env)) if (k.startsWith('DEEPSTEVE_')) delete env[k];
      env.PATH = `${path.join(HOME, 'bin')}:${process.env.PATH}`;
      env.TMUX_TMPDIR = tmuxTmp; // per-UID socket — never share the developer's
      inst.proc = spawn('node', ['server.js'], { cwd: REPO_ROOT, env });
      running.push(inst);
      inst.proc.stdout.on('data', d => { inst.log += d.toString(); });
      inst.proc.stderr.on('data', d => { inst.log += d.toString(); });
      await waitFor(async () => {
        if (!inst.token()) return false;
        const r = await fetch(`${inst.base}/api/version`, { headers: inst.headers() });
        return r.ok;
      }, `daemon ${name} to become ready`);
      return inst;
    },
    stop(signal = 'SIGTERM') {
      const p = inst.proc;
      inst.proc = null;
      if (!p) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 15000);
        p.on('exit', () => { clearTimeout(timer); resolve(); });
        p.kill(signal);
      });
    },
  };
  return inst;
}

before(() => {
  if (SKIP) return;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-engmig-'));
});

after(async () => {
  for (const inst of running) { try { await inst.stop('SIGKILL'); } catch {} }
  running.length = 0;
  await sleep(300);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('an existing node-pty install is offered the migration, not flipped', { skip: SKIP }, async () => {
  const inst = await makeInstall('existing', { engine: 'node-pty', shellProfile: '~/.zshrc' }).start();
  const e = await inst.engines();

  assert.strictEqual(e.tmuxAvailable, true);
  assert.strictEqual(e.current, 'node-pty', 'the saved choice is untouched at boot');
  assert.strictEqual(e.migrationOffer, true, 'and the user is asked about it');
  await inst.stop();
});

test('"keep" latches: the engine stays put and the offer never returns', { skip: SKIP }, async () => {
  const inst = await makeInstall('keeper', { engine: 'node-pty' }).start();
  assert.strictEqual((await inst.engines()).migrationOffer, true);

  const { status, body } = await inst.decide('keep');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.engine, 'node-pty', 'keep means keep');
  assert.strictEqual(body.engineMigrationOffered, true);

  assert.strictEqual((await inst.engines()).migrationOffer, false, 'not asked twice in one boot');
  assert.strictEqual(inst.settingsOnDisk().engineMigrationOffered, true, 'latch is persisted');

  // And it survives a restart — otherwise every daemon start would re-nag.
  await inst.stop();
  await inst.start();
  const after = await inst.engines();
  assert.strictEqual(after.current, 'node-pty');
  assert.strictEqual(after.migrationOffer, false, 'not asked again after a restart');
  await inst.stop();
});

test('"migrate" moves the setting to tmux and latches', { skip: SKIP }, async () => {
  const inst = await makeInstall('migrator', { engine: 'node-pty' }).start();
  assert.strictEqual((await inst.engines()).migrationOffer, true);

  const { body } = await inst.decide('migrate');
  assert.strictEqual(body.engine, 'tmux');

  await inst.stop();
  await inst.start();
  const after = await inst.engines();
  assert.strictEqual(after.current, 'tmux', 'the migration persisted');
  assert.strictEqual(after.migrationOffer, false);
  await inst.stop();
});

test('a bad decision is rejected without latching', { skip: SKIP }, async () => {
  const inst = await makeInstall('badinput', { engine: 'node-pty' }).start();
  const { status } = await inst.decide('maybe');
  assert.strictEqual(status, 400);
  assert.strictEqual((await inst.engines()).migrationOffer, true, 'still offerable');
  await inst.stop();
});

test('no usable tmux: downgrade is persisted, reported, and not offered', { skip: SKIP }, async () => {
  // tmuxBinary pointing at nothing is the reliable way to simulate "no tmux"
  // without touching PATH — #619 made the binary an explicit setting for exactly
  // this kind of case.
  const missing = path.join(tmpRoot, 'no-such-dir', 'tmux');
  const inst = await makeInstall('notmux', { engine: 'tmux', tmuxBinary: missing }).start();

  const e = await inst.engines();
  assert.strictEqual(e.tmuxAvailable, false);
  assert.strictEqual(e.current, 'node-pty', 'downgraded, since there is nothing to default to');
  assert.strictEqual(e.migrationOffer, false, 'never offer a migration to an engine that is absent');

  const tmuxRow = e.engines.find(x => x.id === 'tmux');
  assert.strictEqual(tmuxRow.available, false);
  assert.ok(tmuxRow.reason, 'the UI is given a reason to show, not just a false flag');
  assert.ok(tmuxRow.reason.includes(missing), `reason should name the path it tried: ${tmuxRow.reason}`);

  assert.strictEqual(inst.settingsOnDisk().engine, 'node-pty', 'downgrade is persisted');
  assert.match(inst.log, /sessions will NOT survive a restart/,
    'and the log says plainly what the fallback costs');

  // Asking to migrate anyway is refused rather than silently accepted.
  const { status } = await inst.decide('migrate');
  assert.strictEqual(status, 409);
  await inst.stop();
});
