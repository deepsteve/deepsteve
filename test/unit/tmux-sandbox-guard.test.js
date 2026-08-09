// The build guard for #625: nothing under test/** may exec tmux except
// test/helpers/tmux-sandbox.js, and nothing may reach for TMUX_TMPDIR or kill-server.
//
// This is the "make the dangerous thing unrepresentable" half of the issue. A test
// suite destroyed every live agent on the developer's machine three times in twenty
// minutes because isolation rode on TMUX_TMPDIR — an environment variable with a
// SILENT fallback to the real per-UID socket — and the cleanup verb was `kill-server`,
// which names no target at all. That suite HAD a guard and a nine-line comment
// explaining why the guard mattered. It still happened. So the rule stops being advice
// and becomes a failing build.
//
// Same idiom as ws-client-guard.test.js (#562), compose-projects.test.js (#616) and
// service-lib.test.js: comments are stripped before every match so these files can
// still EXPLAIN the rule at length, the tree is globbed rather than listed so a new
// suite is covered the moment it lands, and the first assertions prove the scan is not
// vacuous — a broken walk or a regex that quietly stopped matching would otherwise turn
// every ban below into a silent no-op.
//
// Pure file reads plus a require() of the helper, so it runs in the bare `unit` CI job
// (ubuntu, no tmux, no zsh, --ignore-scripts and therefore no node-pty binding).
//
// Run: node --test test/unit/tmux-sandbox-guard.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(TEST_DIR, '..');
const HELPER_REL = 'test/helpers/tmux-sandbox.js';
const SELF_REL = 'test/unit/tmux-sandbox-guard.test.js';

const { TmuxSandbox } = require('../helpers/tmux-sandbox');

// --- the scan -----------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|sh)$/.test(e.name)) out.push(path.relative(REPO_ROOT, p));
  }
  return out;
}

/**
 * Strip comments so prose may explain the rule without satisfying or tripping it.
 *
 * Deliberately LINE-BASED rather than a `\/\*[\s\S]*?\*\/` sweep. That sweep is the
 * obvious implementation and it is wrong here: fork-lineage.test.js embeds the shell
 * glob `"$HOME"/.claude/projects/*\/"$resume".jsonl` inside a stub script, whose `/*`
 * opens a "comment" that runs to the next `*\/` hundreds of lines later — it silently
 * ate 10KB of real code and turned every ban below into a pass for that file. A block
 * comment only counts when it OPENS a line, which is how every doc header in this tree
 * is actually written; a well-formed one-line `/* … *\/` is stripped separately, and a
 * stray `/*` inside a string can no longer run away.
 *
 * The `(^|\s)` on the line-comment pattern is what keeps `http://…` intact.
 */
function uncomment(rel, text) {
  if (rel.endsWith('.sh')) {
    return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  }
  const out = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    if (inBlock) {
      const end = raw.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      inBlock = false;
      out.push(raw.slice(end + 2));
      continue;
    }
    // A one-line /* … */ first, so it can't be mistaken for an opener.
    let line = raw.replace(/\/\*(?:(?!\*\/)[^\n])*\*\//g, '');
    if (/^\s*\/\*/.test(line)) { inBlock = true; out.push(''); continue; }
    out.push(line.replace(/(^|\s)\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const scanned = walk(TEST_DIR).filter((rel) => rel !== HELPER_REL && rel !== SELF_REL).sort();
const sources = scanned.map((rel) => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  return { rel, raw, rawLines: raw.split('\n'), code: uncomment(rel, raw) };
});

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

/**
 * A line-level opt-out: `// tmux-guard-allow: <why>` on the offending line or the one
 * above it. Deliberately NOT a file allowlist — an allowlist grows quietly and takes
 * whole files out of the guard, while this puts the exemption and its reason at the
 * site, in the diff, next to the thing being excused.
 *
 * Matched against the RAW line, since the marker is itself a comment. The set of files
 * allowed to carry one is asserted below, so adding an exemption is a visible act that
 * fails the build until someone updates that list on purpose.
 */
const ALLOW = /tmux-guard-allow:\s*\S/;
function allowed(src, line1) {
  const cur = src.rawLines[line1 - 1] || '';
  const prev = src.rawLines[line1 - 2] || '';
  return ALLOW.test(cur) || ALLOW.test(prev);
}

/** Index (1-based) of the first offending line that is not explicitly excused. */
function firstViolation(src, re) {
  for (let i = 0; i < src.code.split('\n').length; i++) {
    const line = src.code.split('\n')[i];
    if (re.test(line) && !allowed(src, i + 1)) return i + 1;
  }
  return 0;
}

// Every child_process call whose first ~200 characters mention tmux. Reading a window
// after the open paren rather than trying to balance parens is deliberate: the argv is
// frequently a nested array or object literal, and a paren-matching regex would fail on
// exactly the call sites that matter most.
//
// `(?<![.\w])` excludes `<regex>.exec(…)`, which is all over these suites for output
// matching and which the bare word `exec` otherwise hits. The cost is that a namespaced
// `child_process.execFileSync(…)` would slip through — nothing in this tree writes that,
// and the destructured form every file does use is covered.
//
// Honest about the residual: a suite could resolve tmux into a variable named nothing
// like tmux and exec that. The TMUX_BIN ban and the "every suite anchors a sandbox"
// assertion below are what cover that shape; this tier catches the literal one.
const EXEC_CALL = /(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/g;

// Is the match inside a string literal? Quote parity on the line up to the match is a
// crude test, but it is the one that matters here: these files are full of assertion
// MESSAGES like `'spawn() must issue a new-session'`, and without this every one of
// them reads as a tmux exec in a file that (correctly) mentions tmux constantly.
function insideString(code, index) {
  const lineStart = code.lastIndexOf('\n', index - 1) + 1;
  const before = code.slice(lineStart, index);
  return ((before.match(/(?<!\\)['"`]/g) || []).length % 2) === 1;
}

function execHits(code) {
  const hits = [];
  for (const m of code.matchAll(EXEC_CALL)) {
    if (insideString(code, m.index)) continue;
    const head = code.slice(m.index, m.index + 200);
    // `\btmux` — a boundary at the START only. It matches `'tmux'`, `tmuxBin` and
    // `tmux.sock`, but not an identifier that merely CONTAINS it: `ds_tmux_socket` is a
    // shell accessor for a path, and `execFileSync('sh', ['-c', '… ds_tmux_socket'])`
    // runs sh, not tmux. A plain /tmux/ read those as violations.
    if (/\btmux/i.test(head)) hits.push({ line: lineOf(code, m.index), snippet: head.split('\n')[0].trim() });
  }
  return hits;
}

// --- anti-vacuity -------------------------------------------------------------

test('the scan actually found the files — otherwise every assertion here is vacuous', () => {
  for (const expected of [
    'test/integration-standalone/tmux-durability.test.js',
    'test/integration-standalone/fork-lineage.test.js',
    'test/run-standalone.sh',
    'test/run-integration.sh',
    'test/helpers/ws-client.js',
  ]) {
    assert.ok(scanned.includes(expected),
      `the scan missed ${expected} (found ${scanned.length} files). If it moved, update this ` +
      'list — the bans below are no-ops on files the walk never reaches.');
  }
  assert.ok(scanned.length >= 25, `only ${scanned.length} files scanned — the walk is broken`);
});

test('the choke point exists, and is the only exemption', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, HELPER_REL)),
    `${HELPER_REL} is missing — the rule below has nowhere to point callers`);
  assert.ok(!scanned.includes(HELPER_REL), 'the helper must be exempt from its own rule');
});

test('POSITIVE CONTROL: the exec detector fires on real violations', () => {
  // A grep-based guard's characteristic failure is going quietly green after a regex
  // drifts, so assert the detector against violations rather than only against a clean
  // tree — which by definition cannot exercise it.
  for (const planted of [
    "execFileSync(tmuxBin, ['kill-session', '-t', name], { encoding: 'utf8' });",
    "spawn('tmux', ['attach-session', '-t', s]);",
    "execSync(`tmux ls`);",
    "execFileSync('/usr/bin/which', ['tmux']);",
  ]) {
    assert.ok(execHits(planted).length >= 1, `detector missed: ${planted}`);
  }
  // And the helper — the one file in the tree that really does exec tmux.
  const code = uncomment(HELPER_REL, fs.readFileSync(path.join(REPO_ROOT, HELPER_REL), 'utf8'));
  assert.ok(execHits(code).length >= 1,
    'the exec-shaped-tmux detector matched nothing in the file that definitely execs tmux');
  // …but not a regex match on output, nor an assertion message that happens to name a
  // function. Both are everywhere in these suites, and both used to read as violations.
  assert.deepStrictEqual(execHits("const m = /tmux-(\\d+)/.exec(c.output);"), []);
  assert.deepStrictEqual(execHits("assert.ok(c, 'spawn() must issue a tmux new-session');"), []);
  // …nor a shell accessor whose NAME contains tmux. This runs sh, not tmux.
  assert.deepStrictEqual(
    execHits('execFileSync(\'sh\', [\'-c\', `. "${SERVICE_SH}"; ds_tmux_socket`], { encoding: \'utf8\' });'), []);
});

test('POSITIVE CONTROL: the token bans fire, and comments really are stripped', () => {
  const planted = "  env.TMUX_TMPDIR = tmp;\n  t(['kill-server']);\n";
  assert.match(uncomment('x.js', planted), /\bTMUX_TMPDIR\b/);
  assert.match(uncomment('x.js', planted), /kill-server/);
  // Stripping, so the explanatory prose a dozen suites now carry does not fail the build.
  assert.doesNotMatch(uncomment('x.js', '// mentions TMUX_TMPDIR and kill-server\n'), /TMUX_TMPDIR/);
  assert.doesNotMatch(uncomment('x.js', '/**\n * mentions TMUX_TMPDIR\n */\ncode();\n'), /TMUX_TMPDIR/);
  assert.doesNotMatch(uncomment('x.sh', '# mentions TMUX_TMPDIR\n'), /TMUX_TMPDIR/);
  // …but a mid-line `/*` inside a string must NOT open a block and swallow the rest of
  // the file. That bug made this whole guard vacuous for fork-lineage.test.js.
  const globbed = 'const s = `ls "$HOME"/.claude/projects/*/"$r".jsonl`;\nenv.TMUX_TMPDIR = x;\n';
  assert.match(uncomment('x.js', globbed), /TMUX_TMPDIR/,
    'a `/*` inside a string swallowed the code after it — the guard would pass vacuously');
});

// --- the bans -----------------------------------------------------------------

test('the exemption marker is used in exactly these files (#625)', () => {
  // The counterweight to a line-level opt-out. Same idiom as shortcuts-registry.test.js
  // asserting the exact set of registered ids: adding an exemption is fine, doing it
  // silently is not. Both entries below are places that must NAME the banned thing in
  // order to prove something about it.
  const carrying = sources.filter((s) => s.rawLines.some((l) => ALLOW.test(l))).map((s) => s.rel);
  assert.deepStrictEqual(carrying.sort(), [
    // Aims the old fallback surface at an empty decoy and asserts it stays empty — the
    // proof that nothing reaches tmux through the environment any more.
    'test/unit/tmux-sandbox-acceptance.test.js',
    // Asserts engines/tmux.js contains no kill-server. It has to write the word.
    'test/unit/tmux-spawn-args.test.js',
  ], 'a new tmux-guard-allow marker appeared — is it really necessary? If so, list it here.');
});

test('no test sets TMUX_TMPDIR (#625)', () => {
  for (const src of sources) {
    const { rel } = src;
    const at = firstViolation(src, /\bTMUX_TMPDIR\b/) - 1;
    assert.strictEqual(at, -1,
      `${rel}:${at + 1} sets TMUX_TMPDIR. Since #625 the daemon binds its own socket at ` +
      '$HOME/.deepsteve/tmux.sock and passes it as `-S`, so a scratch HOME already isolates ' +
      'tmux — and TMUX_TMPDIR has a SILENT fallback to the developer\'s real per-UID socket ' +
      'when it is unset or points at a missing directory. Isolation resting on it is what ' +
      'let a test destroy every live agent on the machine. Delete the line and anchor a ' +
      `TmuxSandbox on the same HOME instead (${HELPER_REL}).`);
  }
});

test('no test runs tmux kill-server (#625)', () => {
  for (const src of sources) {
    const { rel } = src;
    const at = firstViolation(src, /kill-server/) - 1;
    assert.strictEqual(at, -1,
      `${rel}:${at + 1} runs tmux kill-server. It is banned outright: the argv names no ` +
      'server, so a mis-aimed one is invisible right up until every live agent is gone — ' +
      'which is literally how #625 was filed. Reap with sandbox.killSession(\'ds-<id>\') or ' +
      'sandbox.cleanup(), which kills only what is on that sandbox\'s own socket.');
  }
});

test('no test resolves its own tmux binary (#625)', () => {
  for (const src of sources) {
    const { rel } = src;
    const at = firstViolation(src, /\bTMUX_BIN\b/) - 1;
    assert.strictEqual(at, -1,
      `${rel}:${at + 1} resolves a tmux binary of its own. Resolution belongs to ` +
      `${HELPER_REL} (TmuxSandbox.skipReason()), which uses the daemon's own tmux-path.js — ` +
      'the hand-rolled `which tmux` this replaces missed /opt/homebrew/bin, which is exactly ' +
      'the directory a LaunchAgent\'s PATH omits.');
  }
});

test('only the sandbox helper execs tmux (#625)', () => {
  for (const { rel, code } of sources) {
    if (rel.endsWith('.sh')) continue;              // covered by the shell test below
    const hits = execHits(code);
    assert.deepStrictEqual(hits, [],
      `${rel} executes tmux directly (${hits.map((h) => `line ${h.line}: ${h.snippet}`).join('; ')}). ` +
      `tmux may only be executed through ${HELPER_REL}, which binds -S into every argv it ` +
      'builds and refuses whole-server verbs. One choke point, one place to get it right.');
  }
});

test('no shell script under test/ invokes tmux (#625)', () => {
  // `tmux` as a command word — so a quoted path like "./test/helpers/tmux-sandbox" or a
  // `node -e 'require(".../tmux-sandbox")'` line (which is how run-integration.sh reaps)
  // does not match, while a bare `tmux kill-server` does.
  const CMD = /(^|[;&|(\s])tmux(\s|$)/;
  for (const src of sources) {
    const { rel } = src;
    if (!rel.endsWith('.sh')) continue;
    const at = firstViolation(src, CMD) - 1;
    assert.strictEqual(at, -1,
      `${rel}:${at + 1} invokes tmux. Shell out to ${HELPER_REL} instead ` +
      '(`node -e \'require("./test/helpers/tmux-sandbox").TmuxSandbox.reapHome(…)\'`), so ' +
      'there stays exactly one place under test/** that knows how to aim a tmux command.');
  }
});

// --- anti-drift: every standalone suite reaps its own tmux server ---------------

test('every standalone suite anchors a TmuxSandbox and reaps it (#625)', () => {
  // This replaces a line of CLAUDE.md prose that used to say "the others should grow the
  // same `after` hook" — advice that had been unfollowed for a release, and which named
  // the very kill-server hook that caused the incident.
  const dir = path.join(TEST_DIR, 'integration-standalone');
  const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
  assert.ok(suites.length >= 10, `only ${suites.length} standalone suites found — bad glob`);
  for (const f of suites) {
    const code = uncomment(f, fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.match(code, /require\(['"]\.\.\/helpers\/tmux-sandbox['"]\)/,
      `test/integration-standalone/${f} does not anchor a TmuxSandbox. A SIGTERMed daemon ` +
      'DETACHES its tmux sessions (#620), so this suite\'s scratch tmux server outlives it and ' +
      'rm -rf(tmpRoot) only unlinks the socket — leaving a running server nothing can ever ' +
      'reach again. A full run-standalone.sh used to leave ~10 of those behind.');
    assert.match(code, /sandbox(es)?[\s\S]{0,40}?\.cleanup\(\)/,
      `test/integration-standalone/${f} never calls cleanup() — see above.`);
  }
});

// --- behavioral: the helper's own guarantees ------------------------------------
// Stronger than grep, and they need no tmux: the constructor and argv() never probe.

test('-S <socket> is bound into every argv, unconditionally', () => {
  const s = TmuxSandbox.mint('ds-guard-');
  try {
    assert.deepStrictEqual(s.argv(['list-sessions']), ['-S', s.socketPath, 'list-sessions']);
    assert.deepStrictEqual(
      s.argv(['new-session', '-d', '-s', 'ds-x', 'sleep 1']).slice(0, 2), ['-S', s.socketPath]);
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('the socket dir is named and created in ONE call (ported from #624)', () => {
  // The two-line window — path assigned on one line, mkdir on a later one — is what
  // let a throw in between leave tmux in its silent-fallback condition. There is no
  // constructor arm that records a path without the directory being on disk.
  const s = TmuxSandbox.mint('ds-guard-');
  try {
    assert.ok(fs.statSync(path.dirname(s.socketPath)).isDirectory(),
      'the socket dir must exist the instant the sandbox does');
    assert.ok(s.socketPath.startsWith(s.home + path.sep), 'and be inside the sandbox');
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('cleanup() on a socket with no server is a quiet no-op (ported from #624)', () => {
  // "Clean up" must never become "clean up whatever tmux happens to find": with no
  // server of ours there is nothing to do, and saying so must not throw — a cleanup
  // throw in after() masks the real test failure.
  const s = TmuxSandbox.mint('ds-guard-');
  try {
    assert.strictEqual(s.cleanup(), 0);
    assert.ok(!fs.existsSync(s.socketPath), 'and it must not have created one');
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('kill-server throws before anything is spawned', () => {
  const s = TmuxSandbox.mint('ds-guard-');
  try {
    assert.throws(() => s.argv(['kill-server']), /kill-server/);
    // run() must validate first — a helper that spawned and then complained would be
    // no safer than the code it replaces.
    assert.throws(() => s.run(['kill-server']), /kill-server/);
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('caller-supplied -S / -L / -a are rejected', () => {
  const s = TmuxSandbox.mint('ds-guard-');
  try {
    assert.throws(() => s.argv(['list-sessions', '-S', '/tmp/elsewhere']), /not yours to pass/);
    assert.throws(() => s.argv(['list-sessions', '-L', 'other']), /not yours to pass/);
    assert.throws(() => s.argv(['kill-session', '-a', '-t', 'ds-x']), /not yours to pass/);
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('kill-session must name a ds-* target', () => {
  const s = TmuxSandbox.mint('ds-guard-');
  try {
    assert.throws(() => s.argv(['kill-session']), /must name -t/);
    assert.throws(() => s.argv(['kill-session', '-t', 'work']), /only ds-\* sessions are ours/);
    assert.deepStrictEqual(s.argv(['kill-session', '-t', 'ds-abc12345']).slice(2),
      ['kill-session', '-t', 'ds-abc12345']);
  } finally {
    fs.rmSync(s.home, { recursive: true, force: true });
  }
});

test('refuses the real HOME, and a HOME that does not exist', () => {
  assert.throws(() => TmuxSandbox.forHome(os.homedir()), /real HOME|LIVE daemon/);

  const gone = path.join(os.tmpdir(), `ds-guard-nonexistent-${process.pid}`);
  assert.throws(() => TmuxSandbox.forHome(gone), /does not exist/);
  assert.ok(!fs.existsSync(gone),
    'refusing must not have created it — a sandbox that mkdir -p\'s a typo\'d path would ' +
    'silently run tmux somewhere nobody meant');

  // The undefined case, which is the original bug: Node drops env keys whose value is
  // undefined, so the old helper produced an invocation with no isolation at all.
  assert.throws(() => TmuxSandbox.forHome(undefined), /absolute path/);
  assert.throws(() => TmuxSandbox.forHome(''), /absolute path/);
});
