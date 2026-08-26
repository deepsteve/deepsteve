// The exact `load-buffer` / `paste-buffer` argv TmuxEngine.pasteText() builds (#656).
//
// write() sends bytes down the attach client's stdin — a tty whose kernel input queue
// holds MAX_INPUT (1022 bytes on macOS). A multi-kilobyte prompt necessarily sits in
// it partly unread, and anything that flushes that queue takes a whole queue-full of
// our text with it, silently: two live deliveries lost 2026 and 2038 contiguous
// characters off the HEAD of ~2.4KB prompts and the agent recorded only the tail.
// pasteText routes around that hop through the tmux command socket.
//
// These are argv-level assertions rather than behavioural ones for the same reason
// tmux-spawn-args.test.js is: every one of the three flags is silently load-bearing,
// and getting one wrong still mostly "works".
//
// Runs on the bare CI runner with no tmux: TmuxEngine takes an injected `exec`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TmuxEngine = require('../../engines/tmux');

const SOCKET = '/tmp/ds-fake/tmux.sock';
const ID = 'abc123';
const BIG = 'line one\nline two\nline three\n'.repeat(200);

function makeEngine({ failOn = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tmuxpaste-'));
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  const calls = [];
  const exec = (file, argv, opts) => {
    calls.push({ argv, opts });
    if (argv[0] === '-V') return 'tmux 3.6a';
    if (failOn && argv.includes(failOn)) throw new Error(`tmux ${failOn} failed`);
    if (argv.includes('display-message')) return '12345';
    return '';
  };
  const eng = new TmuxEngine({ binary: bin, socket: SOCKET, env: { PATH: dir }, exec });

  // A session entry with a fake attach PTY, so the fallback path is observable
  // without spawning anything.
  const written = [];
  eng._sessions.set(ID, { attachPty: { write: (d) => written.push(d) } });
  return { eng, calls, written };
}

/** A command's argv with the socket prefix removed — and asserted present. */
function afterSocket(argv) {
  assert.deepStrictEqual(argv.slice(0, 2), ['-S', SOCKET],
    'every tmux invocation carries the socket flag, data path included');
  return argv.slice(2);
}
const find = (calls, verb) => calls.find((c) => c.argv.includes(verb));

test('the text reaches tmux over the command socket, not the attach PTY', () => {
  const { eng, calls, written } = makeEngine();
  eng.pasteText(ID, BIG);

  const load = find(calls, 'load-buffer');
  assert.ok(load, 'a load-buffer must be issued');
  assert.strictEqual(load.opts.input, BIG, 'the text goes in on stdin, not as an argv');
  assert.deepStrictEqual(written, [], 'nothing went down the attach client tty');
});

test('load-buffer names its own buffer and reads from stdin', () => {
  const { eng, calls } = makeEngine();
  eng.pasteText(ID, BIG);
  assert.deepStrictEqual(afterSocket(find(calls, 'load-buffer').argv),
    ['load-buffer', '-b', `ds-${ID}`, '-']);
});

test('paste-buffer passes -r, or every newline in the prompt becomes Enter', () => {
  // tmux(1): "any linefeed (LF) characters in the paste buffer are replaced with a
  // separator, by default carriage return (CR)". Our prompts are multi-line, so
  // without -r the prompt submits itself one line at a time.
  const { eng, calls } = makeEngine();
  eng.pasteText(ID, BIG);
  const argv = afterSocket(find(calls, 'paste-buffer').argv);
  assert.ok(argv.includes('-r'), `-r is mandatory, got ${argv.join(' ')}`);
});

test('paste-buffer passes -p, delegating the bracket decision to tmux', () => {
  // tmux inserts the markers only "if the application has requested bracketed paste
  // mode", which is state we cannot observe. It therefore fails safe: a pane without
  // mode 2004 gets exactly the bytes it would have got before, not a literal [200~.
  const { eng, calls } = makeEngine();
  eng.pasteText(ID, BIG);
  assert.ok(afterSocket(find(calls, 'paste-buffer').argv).includes('-p'));
});

test('paste-buffer targets this session and deletes its buffer', () => {
  // Explicitly named buffers are NOT subject to buffer-limit, so one that outlives
  // its paste is a leak.
  const { eng, calls } = makeEngine();
  eng.pasteText(ID, BIG);
  const argv = afterSocket(find(calls, 'paste-buffer').argv);
  assert.deepStrictEqual(argv, ['paste-buffer', '-b', `ds-${ID}`, '-t', `ds-${ID}`, '-p', '-r', '-d']);
});

test('a failed paste-buffer deletes the buffer and falls back to the attach PTY', () => {
  // A pane in copy-mode ignores paste-buffer, and an unreachable server must not
  // lose the prompt.
  const { eng, calls, written } = makeEngine({ failOn: 'paste-buffer' });
  eng.pasteText(ID, BIG);
  assert.ok(find(calls, 'delete-buffer'), 'the named buffer must not be left behind');
  assert.deepStrictEqual(written, [BIG], 'the prompt still reaches the pane');
});

test('a failed load-buffer falls back too, and never leaves a half-loaded buffer', () => {
  const { eng, calls, written } = makeEngine({ failOn: 'load-buffer' });
  eng.pasteText(ID, BIG);
  assert.strictEqual(find(calls, 'paste-buffer'), undefined, 'nothing to paste');
  assert.ok(find(calls, 'delete-buffer'));
  assert.deepStrictEqual(written, [BIG]);
});

test('an unknown session or empty text is a no-op', () => {
  const { eng, calls, written } = makeEngine();
  const before = calls.length;
  eng.pasteText('not-a-session', BIG);
  eng.pasteText(ID, '');
  assert.strictEqual(calls.length, before);
  assert.deepStrictEqual(written, []);
});

test('the base Engine implementation is just write(), so node-pty is unchanged', () => {
  const Engine = require('../../engines/engine');
  const seen = [];
  const e = new Engine();
  e.write = (id, data) => seen.push([id, data]);
  e.pasteText('x', 'hello');
  assert.deepStrictEqual(seen, [['x', 'hello']]);
});
