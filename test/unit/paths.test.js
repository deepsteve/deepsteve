// paths.js — the single source of truth for where deepsteve puts things (#621).
//
// Pure module + file reads, no daemon and no shell, so this runs in the bare `unit`
// CI job. That matters more here than usual: the bug class this file guards against
// is "works on the maintainer's Mac", and ubuntu is the platform it breaks on. Every
// platform assertion below injects `platform` rather than reading process.platform,
// so one runner covers both arms.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandTilde, stateDir, statePath, agentHomeDir, tmuxSocketPath, logDir, DEFAULT_STATE_DIRNAME } = require('../../paths');

const REPO = path.join(__dirname, '..', '..');
const HOME = '/home/tester';

// --- stateDir -------------------------------------------------------------

test('the state dir is ~/.deepsteve on BOTH platforms — deliberately not XDG (#621)', () => {
  // This is a decision, not an oversight, and it is the one most likely to get
  // "fixed" by someone who knows the XDG spec but not that ~/.deepsteve is also
  // the INSTALL dir (server.js lives there; mods require('../../<mod>')). An XDG
  // state dir would not remove the dotdir, it would add a second location.
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.strictEqual(
      stateDir({ env: {}, homedir: HOME, platform }),
      '/home/tester/.deepsteve',
      `${platform}: state dir must stay ~/.deepsteve — see the #621 argument in paths.js`,
    );
  }
});

test('DEEPSTEVE_HOME overrides the state dir', () => {
  assert.strictEqual(stateDir({ env: { DEEPSTEVE_HOME: '/scratch/ds' }, homedir: HOME }), '/scratch/ds');
});

test('DEEPSTEVE_HOME accepts a tilde and a relative path', () => {
  assert.strictEqual(stateDir({ env: { DEEPSTEVE_HOME: '~/alt' }, homedir: HOME }), '/home/tester/alt');
  // Relative resolves against cwd rather than being left relative — a relative
  // state dir would silently follow process.chdir() and split state in two.
  assert.strictEqual(stateDir({ env: { DEEPSTEVE_HOME: 'rel/dir' }, homedir: HOME }), path.resolve('rel/dir'));
});

test('an empty DEEPSTEVE_HOME falls back rather than resolving to cwd', () => {
  // '' is what an unset-but-exported env var looks like. Treating it as an override
  // would put the whole install in the process cwd.
  assert.strictEqual(stateDir({ env: { DEEPSTEVE_HOME: '' }, homedir: HOME }), '/home/tester/.deepsteve');
});

test('statePath joins onto the state dir', () => {
  assert.strictEqual(statePath('state.json'), path.join(stateDir(), 'state.json'));
  assert.strictEqual(statePath('a', 'b'), path.join(stateDir(), 'a', 'b'));
});

test('the default dirname is the literal every shell script also hardcodes', () => {
  assert.strictEqual(DEFAULT_STATE_DIRNAME, '.deepsteve');
});

test('tmuxSocketPath tracks the state dir, so HOME isolation is socket isolation (#625)', () => {
  // The property the whole issue rests on: the tmux socket moves with the state dir,
  // so a daemon with its own HOME (every test daemon, every second instance) gets its
  // own tmux server without doing anything. Before this it inherited tmux's per-UID
  // default and a test could — and did — kill the developer's live sessions.
  assert.strictEqual(tmuxSocketPath({ env: {}, homedir: HOME }), '/home/tester/.deepsteve/tmux.sock');
  assert.strictEqual(
    tmuxSocketPath({ env: { DEEPSTEVE_HOME: '/srv/ds' }, homedir: HOME }), '/srv/ds/tmux.sock');
  assert.strictEqual(
    path.dirname(tmuxSocketPath({ env: {}, homedir: HOME })), stateDir({ env: {}, homedir: HOME }));
  // And it is short. A Unix socket's sun_path is 104 bytes including the NUL, and the
  // old `$TMPDIR/tmux-<uid>/default` regularly came within a couple of bytes of it.
  assert.ok(Buffer.byteLength(tmuxSocketPath()) < 100, tmuxSocketPath());
});

// --- agentHomeDir ---------------------------------------------------------

test('agentHomeDir is os.homedir() when nothing is overridden (#641)', () => {
  // The property that makes the #641 fix a provable no-op for a real install and for
  // every test daemon that isolates with a scratch HOME: with no override the derived
  // home and the real one are the SAME string, so ~/.claude/commands/deepsteve and
  // ~/.agents/skills resolve exactly where they always did.
  assert.strictEqual(agentHomeDir({ env: {}, homedir: HOME }), HOME);
  assert.strictEqual(agentHomeDir(), os.homedir());
});

test('agentHomeDir tracks DEEPSTEVE_HOME, so state isolation is skill isolation (#641)', () => {
  // The bug: stateDir() honored DEEPSTEVE_HOME while the skill destinations hung off
  // os.homedir(), so a second instance started for isolated verification loaded empty
  // scratch settings, concluded nothing was enabled, and deleted every managed skill
  // out of the developer's REAL ~/.claude/commands/deepsteve and ~/.agents/skills.
  assert.strictEqual(agentHomeDir({ env: { DEEPSTEVE_HOME: '/scratch/iso/.deepsteve' }, homedir: HOME }), '/scratch/iso');
  assert.strictEqual(agentHomeDir({ env: { DEEPSTEVE_HOME: '~/alt/.deepsteve' }, homedir: HOME }), '/home/tester/alt');
  // Never the real home, whatever the override is named.
  assert.notStrictEqual(agentHomeDir({ env: { DEEPSTEVE_HOME: '/scratch/iso/.deepsteve' }, homedir: HOME }), HOME);
  // And it is always the state dir's parent, on every platform.
  for (const platform of ['darwin', 'linux']) {
    const opts = { env: { DEEPSTEVE_HOME: '/srv/ds' }, homedir: HOME, platform };
    assert.strictEqual(agentHomeDir(opts), path.dirname(stateDir(opts)));
  }
});

// --- logDir ---------------------------------------------------------------

test('the log dir IS platform-split, because launchd/systemd name it absolutely', () => {
  assert.strictEqual(logDir({ platform: 'darwin', env: {}, homedir: HOME }), '/home/tester/Library/Logs');
  assert.strictEqual(logDir({ platform: 'linux', env: {}, homedir: HOME }),
    '/home/tester/.local/share/deepsteve/logs');
});

test('DEEPSTEVE_LOG_DIR wins on both platforms', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.strictEqual(logDir({ platform, env: { DEEPSTEVE_LOG_DIR: '/var/log/ds' }, homedir: HOME }), '/var/log/ds');
  }
});

test('logging.js defaultLogPaths still forwards its options through to logDir', () => {
  // logging.js keeps its own export (its test injects {platform, env, homedir}); this
  // asserts the 4-line rewire onto paths.logDir() didn't drop the forwarding.
  const { defaultLogPaths } = require('../../logging');
  const linux = defaultLogPaths({ platform: 'linux', env: {}, homedir: HOME });
  assert.deepStrictEqual(linux.map((t) => t.path), [
    '/home/tester/.local/share/deepsteve/logs/deepsteve.log',
    '/home/tester/.local/share/deepsteve/logs/deepsteve.error.log',
  ]);
  assert.deepStrictEqual(linux.map((t) => t.fd), [1, 2]);
});

// --- expandTilde ----------------------------------------------------------

test('expandTilde handles ~, ~/x and absolute paths', () => {
  assert.strictEqual(expandTilde('~', HOME), HOME);
  assert.strictEqual(expandTilde('~/x', HOME), '/home/tester/x');
  assert.strictEqual(expandTilde('/abs', HOME), '/abs');
  assert.strictEqual(expandTilde('rel', HOME), 'rel');
});

test('expandTilde returns falsy input unchanged', () => {
  // server.js calls expandTilde(p.configDir) on profiles that may have none. The
  // git-root.js copy did String(p) and turned undefined into the string "undefined";
  // consolidating on server.js's behavior is what makes the merge a no-op there.
  assert.strictEqual(expandTilde(undefined, HOME), undefined);
  assert.strictEqual(expandTilde(null, HOME), null);
  assert.strictEqual(expandTilde('', HOME), '');
});

test('expandTilde does NOT resolve ~user (documented pre-existing quirk)', () => {
  // `~bob` becomes <our home>/bob, not bob's home. Every caller has always behaved
  // this way; pinned so the behavior can only change deliberately.
  assert.strictEqual(expandTilde('~bob/x', HOME), '/home/tester/bob/x');
});

test('git-root.js still re-exports expandTilde (tmux-path.js imports it from there)', () => {
  const fromGitRoot = require('../../git-root').expandTilde;
  assert.strictEqual(typeof fromGitRoot, 'function');
  assert.strictEqual(fromGitRoot, expandTilde, 'must be the same function, not a second copy');
});

// --- drift guard ----------------------------------------------------------
//
// Source-text, not import: server.js pulls in engines/node-pty.js, whose top-level
// require('node-pty') has no native binding in the CI unit job (deps install with
// --ignore-scripts). Same trick engine-default.test.js uses.

const GUARDED = [
  'server.js',
  'security.js',
  ...fs.readdirSync(path.join(REPO, 'mods'))
    .map((d) => path.join('mods', d, 'tools.js'))
    .filter((p) => fs.existsSync(path.join(REPO, p))),
];

test('the guard list actually resolves to files', () => {
  // Without this, a rename or a bad glob turns every assertion below into a
  // vacuous pass (the compose-projects.test.js lesson).
  assert.ok(GUARDED.length >= 10, `expected the mods glob to find files, got ${GUARDED.length}`);
  for (const rel of GUARDED) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} does not exist`);
  }
});

test('nobody builds the state dir inline any more — use paths.stateDir() (#621)', () => {
  // Shape-scoped rather than a bare '.deepsteve' match: app.js and several tool
  // descriptions legitimately PRINT "~/.deepsteve/themes" at the user, and a prose
  // mention must neither satisfy nor trip this.
  for (const rel of GUARDED) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(
      !/homedir\(\)\s*,\s*['"]\.deepsteve['"]/.test(src),
      `${rel} still builds the state dir inline — use stateDir()/statePath() from paths.js`,
    );
  }
});

test('the dirs the daemon OWNS never hang off os.homedir() — use agentHomeDir() (#641)', () => {
  // ~/.claude/commands and ~/.agents are the only dirs the daemon installs its own
  // artifacts into, and therefore the only ones it DELETES from. Built on os.homedir()
  // they ignored DEEPSTEVE_HOME, so a second instance started for isolated verification
  // loaded empty scratch settings, concluded nothing was enabled, and pruned every
  // managed skill out of a home it did not own — silently, and leaving the real
  // settings.json still saying all six were enabled.
  //
  // Deliberately NOT a blanket ban on os.homedir() + a dotdir. The daemon also READS
  // ~/.claude/projects (the fork watcher) and ~/.codex (the source of the per-session
  // symlink farm), and both are correct on os.homedir(): they must name where the
  // SPAWNED agent reads and writes, and a child inherits the daemon's real HOME
  // whatever DEEPSTEVE_HOME says. Ownership is the line, not the dotdir.
  const OWNED = [
    { label: '~/.claude/commands', re: /homedir\(\)\s*,\s*['"]\.claude['"]\s*,\s*['"]commands['"]/ },
    { label: '~/.agents', re: /homedir\(\)\s*,\s*['"]\.agents['"]/ },
  ];
  for (const rel of GUARDED) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const { label, re } of OWNED) {
      assert.ok(
        !re.test(src),
        `${rel} builds ${label} from os.homedir() — use agentHomeDir() from paths.js, or a daemon `
        + `isolated with DEEPSTEVE_HOME will install into, and delete from, the real user's home (#641)`,
      );
    }
  }
});

test('nobody re-implements tilde expansion inline — use paths.expandTilde() (#621)', () => {
  for (const rel of GUARDED) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(
      !/startsWith\(['"]~['"]\)/.test(src),
      `${rel} has an inline tilde expander — import expandTilde from paths.js`,
    );
  }
});

test('paths.js pulls in nothing but node builtins, so it can never cycle', () => {
  // git-root.js requires paths.js; if paths.js ever required git-root.js back, the
  // partially-initialised module would export undefined and expandTilde would be a
  // TypeError at require time in whichever file lost the race.
  // Only real statements — the header comment mentions require('../../<mod>') when
  // explaining why mods resolve core modules relatively, and prose must not trip this.
  //
  // The guard is against FIRST-PARTY requires, which is what the cycle argument is
  // about; a node builtin cannot cycle back into this repo. `fs` joined the list with
  // #632's spawnCwdProblem, which has to stat the directory it is judging.
  const BUILTINS = ['fs', 'os', 'path'];
  const src = fs.readFileSync(path.join(REPO, 'paths.js'), 'utf8');
  const requires = src.split('\n')
    .filter((l) => /^\s*(const|let|var)\s.*=\s*require\(/.test(l))
    .map((l) => l.match(/require\(['"]([^'"]+)['"]\)/)[1]);
  const firstParty = requires.filter((r) => !BUILTINS.includes(r));
  assert.deepStrictEqual(firstParty, [],
    `paths.js must require only node builtins (${BUILTINS.join(', ')}) — a first-party require can cycle`);
});

test('paths.js lives at the repo root so restart.sh and release.sh ship it', () => {
  // Both deploy every root-level *.js by glob; engines/ and mods/ have
  // hand-maintained embed lists. A paths.js in a subdirectory would simply not be
  // installed, and the daemon would die at require time on a fresh install.
  assert.ok(fs.existsSync(path.join(REPO, 'paths.js')));
  const restart = fs.readFileSync(path.join(REPO, 'restart.sh'), 'utf8');
  assert.match(restart, /^\s*cp \*\.js /m, 'restart.sh must still deploy root *.js by glob');
  const release = fs.readFileSync(path.join(REPO, 'release.sh'), 'utf8');
  assert.match(release, /for rootjs in \*\.js/, 'release.sh must still embed root *.js by glob');
});

// Sanity: the real, uninjected call agrees with the documented default, so the
// injectable signature can't drift from what the daemon actually uses.
test('the uninjected defaults match os.homedir()', () => {
  assert.strictEqual(stateDir(), path.join(os.homedir(), '.deepsteve'));
});
