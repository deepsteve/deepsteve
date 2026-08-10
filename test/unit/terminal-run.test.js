// Unit tests for terminal-run.js — the pure half of #631's disposable terminal.
//
// Everything here is dependency-free by design (the module must load on the bare CI
// `unit` job, which runs with --ignore-scripts and therefore has no node-pty binding),
// so these are ordinary in-process assertions with a scratch dir for the log.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  wrapRunCommand, parseExitMarker, splitAtMarker, capOutput, createRunLog,
  posixQuote, isValidNonce, MARKER_PREFIX,
} = require('../../terminal-run');

const NONCE = 'a1b2c3d4';
const SHELL = { nonce: NONCE, shellPath: '/bin/zsh', loginFlag: '-l' };
const marker = (code, nonce = NONCE) => `${MARKER_PREFIX}${nonce} exited ${code}`;

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ds-runlog-'));

test('the wrapper runs the command, then reports its status, then execs a login shell', () => {
  const lines = wrapRunCommand('git status --porcelain', SHELL).split('\n');
  // The subshell is what makes a command calling `exit` end the COMMAND rather than the
  // run — without it the marker never prints, and under tmux the pane dies before the
  // attach client has painted it, so the output is lost outright, not just the code.
  assert.strictEqual(lines[0], '(');
  assert.strictEqual(lines[1], 'git status --porcelain', 'the command is verbatim');
  assert.strictEqual(lines[2], ')');
  assert.strictEqual(lines[3], '__ds_ec=$?', '$? on the NEXT line is the command status');
  assert.ok(lines[4].includes(`${MARKER_PREFIX}${NONCE} exited %s`), lines[4]);
  // The exec tail is what keeps the tab claimable after the command finishes — a shell
  // that simply exited would take the tab with it and leave no window to type in.
  assert.strictEqual(lines[5], "exec '/bin/zsh' -l");
});

test('a shell with no login flag (the sh floor) gets no -l', () => {
  const lines = wrapRunCommand('echo hi', { nonce: NONCE, shellPath: '/bin/sh', loginFlag: '' }).split('\n');
  assert.strictEqual(lines[5], "exec '/bin/sh'");
});

test('a trailing comment cannot swallow the subshell close or the status line', () => {
  // Newline-delimited rather than `;`-joined precisely so this works.
  const lines = wrapRunCommand('echo one   # a trailing comment', SHELL).split('\n');
  assert.strictEqual(lines[2], ')');
  assert.strictEqual(lines[3], '__ds_ec=$?');
});

test('a multi-line command keeps all of its lines and is not re-indented', () => {
  const cmd = 'echo one\necho two && echo three';
  const wrapped = wrapRunCommand(cmd, SHELL);
  assert.ok(wrapped.startsWith(`(\n${cmd}\n)\n__ds_ec=$?\n`), wrapped);
});

test('the wrapper refuses a nonce it cannot safely interpolate', () => {
  // It lands in BOTH a single-quoted shell string and a RegExp, so it may never be
  // caller-supplied text: hex-only is the invariant, checked rather than trusted.
  for (const bad of ["a'; rm -rf /; '", 'a1b2c3d', 'A1B2C3D4', '.*', undefined, 42]) {
    assert.throws(() => wrapRunCommand('echo hi', { ...SHELL, nonce: bad }), /invalid run nonce/, String(bad));
    assert.strictEqual(isValidNonce(bad), false, String(bad));
  }
  assert.strictEqual(isValidNonce(NONCE), true);
});

test('the wrapper refuses an empty command and a missing shell', () => {
  assert.throws(() => wrapRunCommand('   ', SHELL), /command is required/);
  assert.throws(() => wrapRunCommand('echo hi', { nonce: NONCE }), /shellPath is required/);
});

test('posixQuote survives an embedded single quote', () => {
  assert.strictEqual(posixQuote("it's"), "'it'\\''s'");
});

test('the exit code is read off the stream and is scoped to this run', () => {
  assert.strictEqual(parseExitMarker(`hello\n${marker(3)}\n`, NONCE), 3);
  assert.strictEqual(parseExitMarker(`hello\n${marker(0)}\n`, NONCE), 0, '0 is a real answer, not falsy-absent');
  assert.strictEqual(parseExitMarker('hello\n', NONCE), null);
  // A command that echoes another run's marker (or this source file) cannot fake it.
  assert.strictEqual(parseExitMarker(`${marker(0, 'deadbeef')}\n`, NONCE), null);
});

test('splitAtMarker drops the marker line and everything the linger shell draws after it', () => {
  const lines = ['out one', 'out two', marker(0), '', 'host% '];
  assert.deepStrictEqual(splitAtMarker(lines, NONCE), { output: 'out one\nout two', exitCode: 0, found: true });
});

test('splitAtMarker reports unknown rather than guessing when the run left no marker', () => {
  // The `exit`-called-by-the-command path: the shell died before the printf ran.
  const r = splitAtMarker(['partial output', ''], NONCE);
  assert.deepStrictEqual(r, { output: 'partial output', exitCode: null, found: false });
});

test('splitAtMarker accepts a raw string as well as lines', () => {
  assert.deepStrictEqual(splitAtMarker(`a\r\nb\r\n${marker(2)}\r\n`, NONCE),
    { output: 'a\nb', exitCode: 2, found: true });
});

test('capOutput keeps the END of an oversized run', () => {
  const big = 'x'.repeat(100) + 'THE-INTERESTING-PART';
  const { output, truncated } = capOutput(big, 30);
  assert.strictEqual(truncated, true);
  assert.ok(output.endsWith('THE-INTERESTING-PART'), 'a failure diagnosis lives in the last lines');
  assert.ok(Buffer.byteLength(output) <= 30);
  assert.deepStrictEqual(capOutput('short', 30), { output: 'short', truncated: false });
});

test('the run log appends, ids monotonically, and caps each record', () => {
  const dir = scratch();
  const file = path.join(dir, 'terminal-runs.jsonl');
  const log = createRunLog({ file, maxOutputBytes: 8 });

  const a = log.append({ ts: 1, status: 'started', session_id: 's1', command: 'echo hi', output: '' });
  const b = log.append({ ts: 2, status: 'finished', session_id: 's1', command: 'echo hi', output: '0123456789' });
  assert.strictEqual(a.id, 1);
  assert.strictEqual(b.id, 2);
  assert.strictEqual(b.truncated, true);
  assert.strictEqual(b.output, '23456789');

  const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(onDisk.length, 2, 'both the launch and the completion are recorded');
  assert.strictEqual(onDisk[0].command, 'echo hi');
});

test('the run log is bounded and rewrites itself when it trims', () => {
  const dir = scratch();
  const file = path.join(dir, 'terminal-runs.jsonl');
  const log = createRunLog({ file, maxRuns: 3 });
  for (let i = 0; i < 6; i++) log.append({ ts: i, status: 'finished', session_id: `s${i}`, command: `c${i}`, output: '' });

  assert.strictEqual(log.size, 3);
  const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(onDisk.length, 3, 'the file is rewritten, not appended past the bound');
  assert.deepStrictEqual(onDisk.map((r) => r.command), ['c3', 'c4', 'c5']);
});

test('a reopened run log continues the id sequence and survives a malformed line', () => {
  const dir = scratch();
  const file = path.join(dir, 'terminal-runs.jsonl');
  createRunLog({ file }).append({ ts: 1, status: 'finished', session_id: 's1', command: 'c1', output: '' });
  fs.appendFileSync(file, 'not json at all\n');

  const reopened = createRunLog({ file });
  assert.strictEqual(reopened.size, 1, 'the malformed line is skipped, not fatal');
  assert.strictEqual(reopened.append({ ts: 2, status: 'finished', session_id: 's2', command: 'c2', output: '' }).id, 2);
});

test('list() is newest-first and filters by session', () => {
  const dir = scratch();
  const log = createRunLog({ file: path.join(dir, 'terminal-runs.jsonl') });
  log.append({ ts: 1, status: 'finished', session_id: 'aaa', command: 'c1', output: '' });
  log.append({ ts: 2, status: 'finished', session_id: 'bbb', command: 'c2', output: '' });
  log.append({ ts: 3, status: 'finished', session_id: 'aaa', command: 'c3', output: '' });

  assert.deepStrictEqual(log.list().map((r) => r.command), ['c3', 'c2', 'c1']);
  assert.deepStrictEqual(log.list({ session: 'aaa' }).map((r) => r.command), ['c3', 'c1']);
  assert.deepStrictEqual(log.list({ limit: 1 }).map((r) => r.command), ['c3']);
});

test('a missing log file is an empty log, not a throw', () => {
  const log = createRunLog({ file: path.join(scratch(), 'nested', 'terminal-runs.jsonl') });
  assert.strictEqual(log.size, 0);
  assert.strictEqual(log.append({ ts: 1, status: 'finished', session_id: 's', command: 'c', output: '' }).id, 1);
});
