/**
 * The ONLY thing under test/** permitted to exec tmux (#625).
 *
 * ── Why this file exists ────────────────────────────────────────────────────────
 * Test isolation used to ride on TMUX_TMPDIR, an environment variable with a
 * FALLBACK: unset it, or point it at a directory that does not exist, and tmux
 * silently uses the developer's real per-UID socket instead. Two live instances of
 * that were in the tree at once —
 *
 *   - fork-lineage.test.js set the variable and never mkdir'd the directory, so its
 *     daemon put ds-* sessions on the developer's real socket on every run; and
 *   - tmux-durability.test.js's `after()` ran `tmux kill-server` through a
 *     module-level `let` that only `before()` assigns. A `before()` that threw
 *     before that line left the variable undefined, Node DROPS env keys whose value
 *     is undefined, and the reap landed on the real socket. It destroyed every live
 *     agent on the machine three times in twenty minutes.
 *
 * That suite HAD a guard and a nine-line comment explaining why the guard mattered.
 * It still happened. That is the argument for architecture over discipline.
 *
 * Since #625 the daemon passes `-S <$HOME/.deepsteve/tmux.sock>` on EVERY tmux
 * invocation, so a scratch HOME is a scratch tmux server with no convention at all.
 * `-S` has no fallback (man tmux: "If -S is specified, the default socket directory
 * is not used"): point it at a nonexistent path and tmux starts a NEW EMPTY SERVER
 * there. It cannot silently resolve to someone else's sessions. This helper binds
 * that same `-S` into every argv it builds.
 *
 * ── The four properties ─────────────────────────────────────────────────────────
 *  1. Recording the path and creating the directory are ONE operation. The field is
 *     assigned only after a statSync confirms the directory is on disk, so there is
 *     no window in which a sandbox names a directory that does not exist.
 *  2. Construction refuses to produce a sandbox that could reach the real daemon:
 *     `home` must already exist, must not be os.homedir(), and its derived socket
 *     must differ from the socket os.homedir() derives.
 *  3. Nothing is reachable before construction. Suites hold `let sandbox = null` and
 *     `after()` does `sandbox?.cleanup()`. A `before()` that throws at ANY point
 *     leaves either null (a no-op) or a fully validated object. There is no third
 *     state — that is the structural fix for the bug above.
 *  4. `kill-server` throws. Not because killing every session on OUR socket would be
 *     wrong, but because the argv carries no evidence of which server it is aimed
 *     at, so a mis-aimed one is invisible right up until every agent is gone.
 *     `kill-session -t ds-<id>` names its victim and is strictly sufficient.
 *
 * Enforced by test/unit/tmux-sandbox-guard.test.js (a grep over test/**) and pinned
 * by test/unit/tmux-sandbox-acceptance.test.js, which throws inside a real child
 * suite and asserts the decoys survive.
 *
 * Requires nothing but fs/os/path/child_process plus ../../paths and ../../tmux-path
 * — deliberately NOT node-pty and NOT server.js — so the bare CI unit job
 * (--ignore-scripts, no tmux, no zsh) can require it and exercise everything except
 * the calls that genuinely need a tmux binary.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmuxSocketPath } = require('../../paths');
const { probeTmux } = require('../../tmux-path');

// A Unix socket's sun_path, minus the NUL. Mirrors SUN_PATH_LIMIT in server.js.
const SUN_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;

// Verbs whose blast radius is "every session on this server", regardless of aim.
const FORBIDDEN_VERBS = new Set(['kill-server']);

// Flags a caller must never pass: -S/-L would move the invocation off our socket,
// and -a widens a kill from the one session named by -t to all the others.
const FORBIDDEN_FLAGS = new Set(['-S', '-L', '-a']);

class TmuxSandbox {
  /**
   * Anchor on an EXISTING scratch HOME — the same one the suite hands its daemon.
   *
   * Anchoring on the daemon's HOME rather than on a directory of our own is
   * load-bearing: under `-S` the daemon's socket is a pure function of its HOME, so
   * deriving from the same HOME is what proves both sides are on ONE tmux server. A
   * self-minted socket would put the test on a different server, and every "the
   * session survived" assertion in the suite would go vacuously green — the same
   * failure shape as the silent node-pty downgrade #620 had to add a tripwire for.
   */
  static forHome(home) {
    return new TmuxSandbox(home);
  }

  /**
   * A SECOND socket this sandbox owns, standing in for tmux's shared per-UID socket.
   *
   * Exactly one thing needs this: the #625 migration path, which looks for pre-#625
   * panes on the socket tmux would have used by default. The daemon computes that path
   * with paths.js's `defaultTmuxSocketPath()` and passes it as `-S` (a killing path must
   * not inherit its target from `$TMUX`), and the ONLY input to that computation is
   * TMUX_TMPDIR. So the one place where that variable still carries meaning lives here,
   * inside the choke point, where it is minted together with its directory and can never
   * be undefined at the point of use.
   *
   *   const legacy = sandbox.legacy;
   *   startDaemon({ env: { ...base, ...legacy.env } });   // its "default" socket is ours
   *   legacy.newSession('ds-abc12345');                   // seed a "pre-#625" pane
   *
   * Both sides still reach it with `-S`; the variable only feeds the daemon's
   * *computation* of the path. So they agree on one server without either of them
   * trusting tmux's own resolution — which, inside a pane, would ignore the variable
   * entirely and use `$TMUX`.
   */
  get legacy() {
    if (!this._cache.legacy) {
      const dir = path.join(this.home, 'legacy-tmux');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // tmux's own layout under TMUX_TMPDIR, so the daemon's socket:null engine and our
      // -S land on the same file. With -S nothing mkdirs tmux-<uid>/ for us, hence the
      // constructor's mkdir of the socket's dirname.
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      const socketPath = path.join(dir, `tmux-${uid}`, 'default');
      this._cache.legacy = new TmuxSandbox(this.home, { socketPath, env: { TMUX_TMPDIR: dir } });
    }
    return this._cache.legacy;
  }

  /** mkdtemp a scratch HOME and anchor on it — for decoys and daemon-less suites. */
  static mint(prefix = 'ds-tmux-') {
    return new TmuxSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  }

  /**
   * `false` when tmux is usable here, else a reason string — i.e. exactly the shape
   * node:test's `{ skip }` option wants. (Not `null`: node:test treats any non-undefined
   * value as "skip", so a `null` tags every test `# SKIP` in the TAP output even while
   * running it, which is a uniquely unhelpful way for CI to report a green suite.)
   *
   * Uses the daemon's own resolver, so a suite skips exactly when the daemon would have
   * fallen back — the hand-rolled `which tmux` this replaces missed /opt/homebrew/bin
   * under a LaunchAgent and needed a login shell to find anything at all.
   */
  static skipReason() {
    const { path: p, error } = probeTmux({});
    return p ? false : `tmux is not usable here${error ? `: ${error}` : ''}`;
  }

  /**
   * forHome(home).cleanup(), swallowing "there was never a sandbox here". For the
   * shell runners, which know only a scratch dir and want its tmux server reaped.
   */
  static reapHome(home) {
    try { return TmuxSandbox.forHome(home).cleanup(); } catch { return 0; }
  }

  /**
   * @param {string} home  an EXISTING scratch HOME
   * @param {{socketPath?: string, env?: object}} [opts]  internal, for `legacy` above:
   *   an explicit socket, which must still live under `home` so every refusal below
   *   applies to it unchanged, plus the env a child needs to resolve to it.
   */
  constructor(home, opts = {}) {
    if (!home || typeof home !== 'string' || !path.isAbsolute(home)) {
      throw new Error(
        `TmuxSandbox: home must be an absolute path, got ${JSON.stringify(home)} (#625). ` +
        'An undefined here is the original bug: Node drops env keys whose value is ' +
        'undefined, so the invocation silently fell through to the real socket.');
    }
    const resolved = path.resolve(home);

    // (2) Prove we are not the real install BEFORE touching the filesystem. env:{} on
    // both sides so a stray DEEPSTEVE_HOME in the runner cannot redirect one of them.
    const realHome = path.resolve(os.homedir());
    if (resolved === realHome) {
      throw new Error(
        `TmuxSandbox: refusing to anchor on the real HOME (${realHome}). Its socket is the ` +
        'LIVE daemon\'s, and reaping it would destroy every running agent (#625).');
    }
    const socket = opts.socketPath
      ? path.resolve(opts.socketPath)
      : tmuxSocketPath({ env: {}, homedir: resolved });
    const realSocket = tmuxSocketPath({ env: {}, homedir: realHome });
    if (socket === path.resolve(realSocket)) {
      throw new Error(
        `TmuxSandbox: the derived socket ${socket} IS the live daemon's socket (#625).`);
    }
    // An explicit socket is still confined to the sandbox: `legacy` is the only caller,
    // and letting it name an arbitrary path would reopen the door this class shuts.
    if (opts.socketPath && !(socket + path.sep).startsWith(resolved + path.sep)) {
      throw new Error(
        `TmuxSandbox: explicit socket ${socket} is outside the sandbox home ${resolved} (#625).`);
    }

    // (2b) The scratch HOME must ALREADY exist. We create the state dir inside it,
    // never the home itself — forHome('/typo/path') must fail loudly rather than
    // mkdir -p a fictional tree and then happily run tmux inside it. This is the
    // assertion the old guard never made, and precisely why it passed while broken.
    let st;
    try {
      st = fs.statSync(resolved);
    } catch {
      throw new Error(
        `TmuxSandbox: scratch HOME ${resolved} does not exist — mkdir it before ` +
        'constructing the sandbox (#625).');
    }
    if (!st.isDirectory()) {
      throw new Error(`TmuxSandbox: ${resolved} is not a directory (#625).`);
    }

    // (3) sun_path tripwire. Under -S this is the EXACT path tmux binds (it appends
    // no tmux-<uid>/default), so unlike the old arithmetic this is deterministic and
    // checkable here rather than discoverable only as a silent node-pty downgrade.
    const bytes = Buffer.byteLength(socket);
    if (bytes > SUN_PATH_LIMIT) {
      throw new Error(
        `TmuxSandbox: socket path is ${bytes} bytes, over the ${SUN_PATH_LIMIT}-byte ` +
        `sun_path limit:\n  ${socket}\ntmux cannot bind it, and the daemon would ` +
        'silently fall back to node-pty — leaving this suite green while testing the ' +
        'wrong engine. Run via test/run-standalone.sh, or prefix TMPDIR=/tmp/ds-test.');
    }

    // (1) mkdir and record in one operation: the fields below are assigned only after
    // the directory is verified present.
    const dir = path.dirname(socket);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`TmuxSandbox: ${dir} is not a directory after mkdir (#625).`);
    }

    this.home = resolved;
    this.socketPath = socket;
    // What a CHILD process needs in its environment to resolve to this same socket.
    // Empty for a normal sandbox: the daemon derives its socket from HOME, so there is
    // nothing to pass. Only `legacy` populates it. Frozen with the rest.
    this.env = Object.freeze({ ...(opts.env || {}) });
    // Mutable holder assigned BEFORE the freeze: the resolved binary and the lazy
    // `legacy` view are cached here, but socketPath must not be reassignable — a
    // rebindable path is the same defect class as the module-level `let tmuxTmp`.
    // `tmuxBin`, not `bin`: test/unit/tmux-sandbox-guard.test.js flags a child_process
    // call whose argv mentions tmux, and this is the one real tmux exec in the tree —
    // so naming it for what it holds is also what keeps that guard's positive control
    // honest instead of asserting against a planted string alone.
    this._cache = { tmuxBin: null, legacy: null };
    Object.freeze(this);
  }

  /**
   * The argv AFTER the binary, plus every validation. Pure — no fs, no exec — so the
   * bare unit job can assert the `-S` binding and the verb ban with no tmux present.
   */
  argv(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('TmuxSandbox: argv requires a non-empty array (#625)');
    }
    const [verb, ...rest] = args.map(String);
    if (FORBIDDEN_VERBS.has(verb)) {
      throw new Error(
        `TmuxSandbox: \`tmux ${verb}\` is banned in tests (#625). It names no target, so a ` +
        'mis-aimed one is invisible until every live agent is gone — which is literally how ' +
        'this issue was filed. Reap with killSession(\'ds-<id>\'), or cleanup(), which kills ' +
        'only what is on this sandbox\'s own socket.');
    }
    for (const a of rest) {
      if (FORBIDDEN_FLAGS.has(a)) {
        throw new Error(
          `TmuxSandbox: \`${a}\` is not yours to pass (#625). The sandbox owns the socket ` +
          '(-S/-L), and -a widens a kill from the one session named by -t to all the others.');
      }
    }
    if (verb === 'kill-session') {
      const at = rest.indexOf('-t');
      const target = at === -1 ? null : rest[at + 1];
      if (!target) {
        throw new Error('TmuxSandbox: kill-session must name -t <session> (#625).');
      }
      if (!target.startsWith('ds-')) {
        throw new Error(
          `TmuxSandbox: refusing kill-session -t ${target} — only ds-* sessions are ours (#625).`);
      }
    }
    return ['-S', this.socketPath, ...args.map(String)];
  }

  /** Run tmux against THIS sandbox's socket. Never inherits TMUX_TMPDIR. */
  run(args, opts = {}) {
    const argv = this.argv(args);              // validation strictly before any spawn
    if (!this._cache.tmuxBin) {
      const { path: p, error } = probeTmux({});
      if (!p) throw new Error(`TmuxSandbox: no usable tmux (${error || 'not found'}) (#625)`);
      this._cache.tmuxBin = p;
    }
    const env = { ...process.env };
    // Both are inert under -S. Deleted rather than left alone so that a debugger
    // reading this child's environment can't be misled into thinking either matters.
    delete env.TMUX_TMPDIR;
    delete env.TMUX;                           // don't act "inside" a pane if run under tmux
    return String(execFileSync(this._cache.tmuxBin, argv, {
      encoding: 'utf8', timeout: 5000, stdio: 'pipe', env, ...opts,
    })).trim();
  }

  /** Names on our socket. [] when no server is running — that is not an error. */
  sessionNames() {
    try {
      return this.run(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  hasSession(name) {
    return this.sessionNames().includes(name);
  }

  /** Create a session on our socket. Names are constrained to the ds- namespace. */
  newSession(name, command = 'sleep 600') {
    if (!/^ds-[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`TmuxSandbox: session names must match ds-<id>, got ${name} (#625)`);
    }
    this.run(['new-session', '-d', '-s', name, command]);
    return name;
  }

  killSession(name) {
    this.run(['kill-session', '-t', name]);
  }

  /**
   * Reap this sandbox's tmux server WITHOUT kill-server: list what is on our socket
   * and kill-session each one by name. Everything there is ours by construction —
   * the socket was proven not to be the real daemon's before this object existed.
   *
   * This is also the fix for the ~10 orphaned tmux servers a full run-standalone.sh
   * used to leave behind, and it matters more since #620: a SIGTERMed daemon DETACHES
   * its sessions, so the tmux server outlives it and `rm -rf(tmpRoot)` merely unlinks
   * the socket — leaving a running server nothing can ever reach again.
   *
   * A non-ds-* name on our socket means we are pointed at a server we did not mint.
   * That must FAIL the suite rather than be quietly skipped, so it throws — after
   * reaping our own, so the throw doesn't also leak.
   */
  cleanup() {
    const names = this.sessionNames();
    const foreign = names.filter(n => !n.startsWith('ds-'));
    for (const n of names.filter(n => n.startsWith('ds-'))) {
      try { this.run(['kill-session', '-t', n]); } catch { /* already gone */ }
    }
    if (foreign.length) {
      throw new Error(
        `TmuxSandbox: socket ${this.socketPath} holds non-ds sessions [${foreign.join(', ')}]. ` +
        'This sandbox is pointed at a tmux server it did not create — refusing to continue ' +
        "rather than reap someone else's work (#625).");
    }
    return names.length;
  }
}

module.exports = { TmuxSandbox, SUN_PATH_LIMIT, FORBIDDEN_VERBS, FORBIDDEN_FLAGS };
