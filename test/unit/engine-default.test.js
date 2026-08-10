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
//
// `exec` is command-AWARE, which #626 made necessary: the engine now asks
// `has-session` before believing an attach-PTY exit means the agent died, so a fake
// that answered every argv with the version string would report "session alive" for
// every session that ever genuinely ended. `sessionAlive` is what a test is really
// choosing between: did tmux lose the session (a real exit), or only our pipe?
function engineWithFakePtys({ sessionAlive = false } = {}) {
  const ptys = [];
  // A controllable clock: the #626 retry budget resets only when an attach has
  // SURVIVED for a while, so a test that wants "this one was healthy" advances
  // time rather than emitting output.
  const clock = { t: 1_000_000 };
  const eng = new TmuxEngine({
    binary: '/fake/bin/tmux',
    exec: (bin, args) => {
      // `includes`, not `args[0]`: since #625 every argv is prefixed with
      // `-S <socket>`, so position 0 is the flag, not the verb.
      if (Array.isArray(args) && args.includes('has-session')) {
        if (!sessionAlive) throw new Error("can't find session");
        return '';
      }
      return 'tmux 3.6a';
    },
    spawnPty: (...args) => { const p = fakePty(); p.args = args; ptys.push(p); return p; },
    now: () => clock.t,
  });
  return { eng, ptys, clock };
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

// The startup reattach ownership rule used to be mirrored here as a local
// reattachAction() — a copy of server.js's logic that could drift from it, and did
// not exercise a single line of the real path. Since #626 that logic lives in
// tmux-reattach.js and is driven directly by test/unit/tmux-reattach.test.js.

// The attach PTY is the daemon's PIPE into the pane, not the agent. Conflating the
// two is the mirror image of #626's startup bug and strictly worse: the daemon
// declares a live agent dead, tombstones it, and the NEXT boot reads that `closed`
// record and destroys the still-running tmux session as "the kill didn't take".
// So the only question that matters on an attach-PTY exit is what tmux says.
describe('#626 an attach-PTY death is not an agent death', () => {
  test('our pipe dies but tmux still has the session → re-attach, report nothing', () => {
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });

    const exits = [];
    const reattaches = [];
    eng.on('exit', (id) => exits.push(id));
    eng.on('reattach', (id, attempt) => reattaches.push({ id, attempt }));
    eng._attach('alive1', 80, 24);
    eng.onExit('alive1', () => exits.push('per-session-callback'));

    ptys[0]._onExit({ exitCode: 1, signal: 0 }); // our attach PTY, not the agent

    assert.deepStrictEqual(exits, [], 'nothing downstream was told the session ended');
    assert.deepStrictEqual(reattaches, [{ id: 'alive1', attempt: 1 }]);
    assert.strictEqual(ptys.length, 2, 'a fresh attach PTY was opened');
    assert.strictEqual(eng.has('alive1'), true, 'and the session is still addressable');
  });

  test('the rebuilt pipe keeps the data and exit callbacks', () => {
    // onData()/onExit() push into whatever entry is current when they are called,
    // so a re-attach starting with empty arrays would leave the session silently
    // deaf and its real exit unnoticed — a subtler way to lose the same agent.
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });
    const seen = [];
    eng._attach('carry1', 80, 24);
    eng.onData('carry1', (d) => seen.push(d));

    ptys[0]._onExit({ exitCode: 1, signal: 0 });
    ptys[1]._onData('after the re-attach');

    assert.deepStrictEqual(seen, ['after the re-attach']);
  });

  test('the rebuilt pipe keeps the size, rather than snapping back to 120x40', () => {
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });
    eng._attach('size1', 203, 51);
    ptys[0]._onExit({ exitCode: 1, signal: 0 });
    assert.strictEqual(ptys[1].args[2].cols, 203);
    assert.strictEqual(ptys[1].args[2].rows, 51);
  });

  test('tmux has no such session → a real exit, reported exactly as before', () => {
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: false });
    const exits = [];
    eng.on('exit', (id, code, signal) => exits.push({ id, code, signal }));
    eng._attach('dead1', 80, 24);

    ptys[0]._onExit({ exitCode: 3, signal: 0 });

    assert.deepStrictEqual(exits, [{ id: 'dead1', code: 3, signal: 0 }]);
    assert.strictEqual(eng.has('dead1'), false);
    assert.strictEqual(ptys.length, 1, 'no pointless re-attach to a session that is gone');
  });

  test('the silent re-attach is bounded, so a refusing tmux server cannot spin', () => {
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });
    const exits = [];
    eng.on('exit', (id) => exits.push(id));
    eng._attach('flap1', 80, 24);

    // Each fresh attach PTY dies immediately, without ever producing data. Fire
    // exactly one onExit per PTY (as node-pty does) and stop when a death no
    // longer produces a replacement — that is the engine giving up.
    for (let guard = 0; guard < 10; guard++) {
      const before = ptys.length;
      ptys[ptys.length - 1]._onExit({ exitCode: 1, signal: 0 });
      if (ptys.length === before) break;
    }

    assert.strictEqual(ptys.length, 4, 'the original plus MAX_SILENT_REATTACHES (3)');
    assert.deepStrictEqual(exits, ['flap1'], 'then it gives up and reports the exit, once');
  });

  test('an attach that lived a long time before dying starts a fresh budget', () => {
    // Otherwise a session that hiccuped three times over its lifetime would be one
    // stumble away from being declared dead forever after.
    const { eng, ptys, clock } = engineWithFakePtys({ sessionAlive: true });
    const exits = [];
    eng.on('exit', (id) => exits.push(id));
    eng._attach('heal1', 80, 24);

    for (let i = 0; i < 5; i++) {
      clock.t += 10 * 60 * 1000; // this attach ran happily for ten minutes
      ptys[ptys.length - 1]._onExit({ exitCode: 1, signal: 0 });
    }
    assert.deepStrictEqual(exits, [], 'five well-separated hiccups, no exit');
    assert.strictEqual(ptys.length, 6);
  });

  test('output alone does NOT clear the budget', () => {
    // The bug this replaced: attaching to a live tmux session always makes tmux
    // repaint the pane, so every retry produced data within milliseconds. Resetting
    // on data reset the budget on every retry — the bound never engaged and the
    // daemon spawned PTYs until `posix_spawnp failed`.
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });
    const exits = [];
    eng.on('exit', (id) => exits.push(id));
    eng._attach('flood1', 80, 24);

    for (let guard = 0; guard < 20; guard++) {
      const before = ptys.length;
      ptys[ptys.length - 1]._onData('\x1b[H\x1b[2J redrawn by tmux'); // the repaint
      ptys[ptys.length - 1]._onExit({ exitCode: 1, signal: 0 });
      if (ptys.length === before) break;
    }
    assert.strictEqual(ptys.length, 4, 'still bounded at MAX_SILENT_REATTACHES');
    assert.deepStrictEqual(exits, ['flood1']);
  });

  test('detach() still never triggers a re-attach, even with tmux holding the session', () => {
    // detach()'s whole purpose is leaving the session running, so "tmux still has
    // it" is the expected state, not evidence our pipe broke.
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });
    const reattaches = [];
    eng.on('reattach', (id) => reattaches.push(id));
    eng._attach('det1', 80, 24);

    assert.strictEqual(eng.detach('det1'), true);

    assert.deepStrictEqual(reattaches, []);
    assert.strictEqual(ptys.length, 1);
    assert.strictEqual(eng.has('det1'), false);
  });

  test('destroy() still never triggers a re-attach', () => {
    // Killing the attach PTY fires its onExit BEFORE destroy()'s kill-session runs,
    // so has-session still answers "alive" — without a suppression flag we would
    // helpfully re-attach to the session we are destroying.
    const { eng, ptys } = engineWithFakePtys({ sessionAlive: true });
    const reattaches = [];
    const exits = [];
    eng.on('reattach', (id) => reattaches.push(id));
    eng.on('exit', (id) => exits.push(id));
    eng._attach('des1', 80, 24);

    eng.destroy('des1');

    assert.deepStrictEqual(reattaches, []);
    assert.deepStrictEqual(exits, []);
    assert.strictEqual(ptys.length, 1);
    assert.strictEqual(eng.has('des1'), false);
  });
});
