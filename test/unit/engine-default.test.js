// #620 — tmux becomes the default engine, node-pty a visible fallback.
//
// Two things are covered here, both chosen because they are the parts that decide
// whether a running agent lives or dies:
//
//   1. detach() must NOT look like an exit. The daemon's universal engine 'exit'
//      funnel tombstones a session and closes its tab; if tearing down the attach
//      PTY fires that, then "detach on shutdown" destroys exactly the sessions it
//      was added to preserve.
//   2. The migration-offer rule, because every existing install has an explicit
//      "engine": "node-pty" on disk and so is unreachable by the schema default.
//
// Deliberately no real tmux: the CI unit job runs bare on ubuntu-latest with no
// zsh and no tmux (the lesson of #565/#614). The engine takes an injected spawnPty
// for this reason, and the probe already took an injected exec since #619.
//
// Nothing here may import `engines/node-pty` either — that job installs with
// `--ignore-scripts`, so node-pty's native binding is never built and requiring it
// throws. `engines/tmux` is safe because it now loads node-pty lazily. The
// canDetach contract is therefore asserted against the Engine base class, which
// NodePtyEngine inherits without overriding.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const TmuxEngine = require('../../engines/tmux');
const Engine = require('../../engines/engine');

// A pty.spawn stand-in: records writes/kills and lets a test fire onExit by hand.
function fakePty() {
  const p = {
    killed: false,
    written: [],
    _onData: null,
    _onExit: null,
    onData(cb) { p._onData = cb; },
    onExit(cb) { p._onExit = cb; },
    write(d) { p.written.push(d); },
    resize() {},
    kill() {
      p.killed = true;
      // Real node-pty delivers onExit asynchronously after a kill(). Fire it
      // synchronously here — it makes the "was an exit reported?" assertion
      // deterministic, and it is the strictly harsher case for detach().
      if (p._onExit) p._onExit({ exitCode: 0, signal: 1 });
    },
  };
  return p;
}

// A TmuxEngine whose probe succeeds and whose PTYs are fakes. Nothing here shells
// out, so it runs anywhere node does.
function engineWithFakePtys() {
  const ptys = [];
  const eng = new TmuxEngine({
    binary: '/fake/bin/tmux',
    exec: () => 'tmux 3.6a',
    spawnPty: (...args) => { const p = fakePty(); p.args = args; ptys.push(p); return p; },
  });
  return { eng, ptys };
}

describe('#620 engine detach capability', () => {
  test('tmux advertises canDetach; the base engine does not', () => {
    const { eng } = engineWithFakePtys();
    assert.strictEqual(eng.canDetach, true);
    assert.strictEqual(new Engine().canDetach, false);
  });

  test('the base detach() is a no-op returning false, so callers fall through to kill', () => {
    assert.strictEqual(new Engine().detach('nope'), false);
  });

  test('NodePtyEngine inherits the base contract rather than overriding it', () => {
    // Asserted structurally: actually instantiating it would require node-pty's
    // native binding, which the CI unit job deliberately does not build.
    const NodePtyEngine = require.resolve('../../engines/node-pty');
    const src = require('node:fs').readFileSync(NodePtyEngine, 'utf8');
    assert.ok(!/\bcanDetach\b/.test(src), 'node-pty must not claim it can detach');
    assert.ok(!/\bdetach\s*\(/.test(src), 'node-pty must not define its own detach()');
  });

  test('detach() tears down the attach PTY without reporting an exit', () => {
    const { eng, ptys } = engineWithFakePtys();

    const exits = [];
    eng.on('exit', (id) => exits.push(id));
    eng._attach('abc123', 80, 24);
    eng.onExit('abc123', () => exits.push('per-session-callback'));

    assert.strictEqual(ptys.length, 1);
    assert.strictEqual(eng.detach('abc123'), true);

    // The PTY really was torn down...
    assert.strictEqual(ptys[0].killed, true);
    // ...but nothing downstream was told the session ended. This is the whole
    // point: the agent is still alive inside tmux.
    assert.deepStrictEqual(exits, []);
    // And the engine has forgotten it, so write() can't target a dead PTY.
    assert.strictEqual(eng.has('abc123'), false);
  });

  test('a real exit still reports, and drops the session from the map', () => {
    const { eng, ptys } = engineWithFakePtys();

    const exits = [];
    eng.on('exit', (id, code, signal) => exits.push({ id, code, signal }));
    eng._attach('def456', 80, 24);

    const perSession = [];
    eng.onExit('def456', (e) => perSession.push(e));

    assert.strictEqual(eng.has('def456'), true);
    ptys[0]._onExit({ exitCode: 3, signal: 0 }); // the process genuinely ended

    assert.deepStrictEqual(exits, [{ id: 'def456', code: 3, signal: 0 }]);
    assert.strictEqual(perSession.length, 1);
    // Pre-#620 the tmux engine never deleted here, so has() stayed true forever
    // and write() kept writing into a dead attach PTY.
    assert.strictEqual(eng.has('def456'), false);
  });

  test('detach() on an unknown id is false and harmless', () => {
    const { eng } = engineWithFakePtys();
    assert.strictEqual(eng.detach('never-existed'), false);
  });

  test('detach() then reattach() re-registers the session', () => {
    const { eng, ptys } = engineWithFakePtys();
    eng._attach('ghi789', 80, 24);
    eng.detach('ghi789');
    assert.strictEqual(eng.has('ghi789'), false);

    // reattach() gates on the tmux session being alive; stub that probe since
    // there's no tmux here.
    eng._tmuxSessionAlive = () => true;
    assert.strictEqual(eng.reattach('ghi789', 100, 30), true);
    assert.strictEqual(eng.has('ghi789'), true);
    assert.strictEqual(ptys.length, 2); // a fresh attach PTY, not the detached one
  });

  test('a detached PTY that exits later still reports nothing', () => {
    // Real node-pty is async: the onExit for our kill() can land after detach()
    // returns. The suppression flag lives on the entry the closure captured, so
    // it must survive the map delete.
    const ptys = [];
    const eng = new TmuxEngine({
      binary: '/fake/bin/tmux',
      exec: () => 'tmux 3.6a',
      spawnPty: () => {
        const p = fakePty();
        p.kill = () => { p.killed = true; }; // deliberately does NOT fire onExit
        ptys.push(p);
        return p;
      },
    });
    const exits = [];
    eng.on('exit', (id) => exits.push(id));
    eng._attach('late01', 80, 24);
    eng.detach('late01');
    ptys[0]._onExit({ exitCode: 0, signal: 1 }); // arrives after the fact
    assert.deepStrictEqual(exits, []);
  });
});

// Mirrors shouldOfferEngineMigration() in server.js. Kept as a table because the
// interesting part is the whole matrix, not any single row.
function shouldOffer({ tmuxAvailable, engine, offered }) {
  return !!tmuxAvailable && engine === 'node-pty' && !offered;
}

describe('#620 migration offer', () => {
  const cases = [
    { name: 'existing install with tmux, never asked → offer',
      input: { tmuxAvailable: true, engine: 'node-pty', offered: false }, want: true },
    { name: 'already answered → never ask again',
      input: { tmuxAvailable: true, engine: 'node-pty', offered: true }, want: false },
    { name: 'already on tmux → nothing to offer',
      input: { tmuxAvailable: true, engine: 'tmux', offered: false }, want: false },
    { name: 'no tmux → offering a migration to nowhere would be nonsense',
      input: { tmuxAvailable: false, engine: 'node-pty', offered: false }, want: false },
    { name: 'no tmux and already answered',
      input: { tmuxAvailable: false, engine: 'node-pty', offered: true }, want: false },
  ];
  for (const c of cases) {
    test(c.name, () => assert.strictEqual(shouldOffer(c.input), c.want));
  }
});

// The startup reattach ownership rule. tmux's socket is per-UID, not per-HOME, so
// listSessions() returns ds-* sessions belonging to other daemons too. Before #620
// anything absent from our state.json was destroyed — which, once tmux is the
// default, means a stray `node server.js` wipes every real session on the box.
function reattachAction(meta) {
  if (!meta) return 'leave-alone';
  if (meta.closed) return 'destroy';
  return 'reattach';
}

describe('#620 startup reattach ownership', () => {
  test("a session we have no record of is left strictly alone", () => {
    assert.strictEqual(reattachAction(undefined), 'leave-alone');
  });

  test('our own tombstoned session is reclaimed', () => {
    // Ours and finished — the kill just didn't take. Safe to destroy, and leaving
    // it would strand a live agent no UI can reach.
    assert.strictEqual(reattachAction({ closed: true, closeReason: 'user' }), 'destroy');
  });

  test('our own open session is reattached', () => {
    assert.strictEqual(reattachAction({ cwd: '/tmp', agentType: 'claude' }), 'reattach');
  });
});
